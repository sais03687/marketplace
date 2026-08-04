import { prisma } from "@/lib/db";
import { jsonError, jsonSuccess, requireOrg, requireDeploymentAccess } from "@/lib/api-utils";
import { getStripe } from "@/lib/stripe";
import { getProvisioningQueue } from "@/lib/provisioning-queue";

// The provisioning worker listens on the "provisioning" queue for ALL job types
// (provision, deprovision, pause, resume, update). The old "deprovision" queue
// was never consumed — fixed here.

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const orgResult = await requireOrg();
  if ("error" in orgResult) return orgResult.error;
  const { company } = orgResult;

  const depResult = await requireDeploymentAccess(id, company.id);
  if ("error" in depResult) return depResult.error;
  const { deployment } = depResult;

  if (deployment.status === "FIRED") {
    return jsonError("Agent already fired", 409);
  }

  // Mark as FIRED immediately so no new emails are forwarded
  await prisma.deployment.update({
    where: { id },
    data: { status: "FIRED", firedAt: new Date() },
  });

  // Close out anything still awaiting a decision. A pending approval on a fired
  // agent is not just clutter — deprovisioning deletes the mailbox it would send
  // from, so approving one afterwards could only fail. EXPIRED is the existing
  // terminal state for "was never acted on", which is exactly what happened.
  const { count: expiredApprovals } = await prisma.approval.updateMany({
    where: { deploymentId: id, status: "PENDING" },
    data: { status: "EXPIRED" },
  });
  if (expiredApprovals > 0) {
    console.log(`[fire] Expired ${expiredApprovals} pending approval(s) for ${id}`);
  }

  // Cancel Stripe subscription at period end (buyer keeps access until then)
  if (deployment.stripeSubscriptionId) {
    const stripe = getStripe();
    if (stripe) {
      try {
        await stripe.subscriptions.update(deployment.stripeSubscriptionId, {
          cancel_at_period_end: true,
        });
      } catch (err: any) {
        console.error(`[fire] Failed to cancel Stripe subscription ${deployment.stripeSubscriptionId}: ${err.message}`);
      }
    }
  }

  // Enqueue cleanup: stops the container, deletes the AgentMail inbox, and deletes
  // the Microsoft 365 identity while releasing its licence seat.
  //
  // This enqueue really does fail sometimes — a `read ECONNRESET` from Upstash was
  // observed in production on 2026-07-31, which silently skipped cleanup while the
  // UI reported the agent fired. Retry briefly, then tell the truth about the
  // outcome instead of reporting unqualified success.
  let cleanupQueued = false;
  let lastError = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await getProvisioningQueue().add("deprovision", { type: "deprovision", deploymentId: id });
      cleanupQueued = true;
      break;
    } catch (err: any) {
      lastError = err.message;
      console.error(`[fire] Enqueue attempt ${attempt}/3 failed for ${id}: ${err.message}`);
      if (attempt < 3) await new Promise((r) => setTimeout(r, 300 * attempt));
    }
  }

  // Redis is only one way to reach the provisioning service. When it is down, ask
  // the service directly over HTTPS — a separate transport, so a single outage no
  // longer defers cleanup to the reconciliation sweep.
  if (!cleanupQueued) {
    console.error(`[fire] Could not enqueue deprovision for ${id} after 3 attempts: ${lastError}`);
    // Both names are in use: the licensing route reads PROVISIONING_SERVICE_URL,
    // while PROVISIONING_URL is what is actually set in the Vercel project. Accept
    // either, and fall back to the public host so this never silently no-ops.
    const base =
      process.env.PROVISIONING_SERVICE_URL ||
      process.env.PROVISIONING_URL ||
      "https://api.agentstore.it.com";
    const secret = process.env.PROVISIONING_SECRET;
    if (base && secret) {
      try {
        const resp = await fetch(`${base.replace(/\/$/, "")}/internal/deprovision`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
          body: JSON.stringify({ deploymentId: id }),
          signal: AbortSignal.timeout(15_000),
        });
        if (resp.ok) {
          cleanupQueued = true;
          console.log(`[fire] Deprovision accepted over HTTP fallback for ${id}`);
        } else {
          console.error(`[fire] HTTP deprovision fallback returned ${resp.status} for ${id}`);
        }
      } catch (err: any) {
        console.error(`[fire] HTTP deprovision fallback failed for ${id}: ${err.message}`);
      }
    }
  }

  if (!cleanupQueued) {
    console.error(
      `[fire] Both the queue and the HTTP fallback failed for ${id}. The reconciliation ` +
        `sweep will delete the Microsoft 365 user, release its seat, and remove the container.`,
    );
  }

  // The deployment IS fired either way — the row is already updated and the agent
  // stops receiving mail. What is uncertain is only the timing of the cleanup, so
  // say so rather than letting the UI imply the seat came back immediately.
  return jsonSuccess({
    message: "Agent fired",
    deploymentId: id,
    cleanupQueued,
    cleanupNote: cleanupQueued
      ? "Cleanup is running now."
      : "Cleanup could not be started immediately and will run automatically within the hour. " +
        "The Microsoft 365 account and its licence seat are released then.",
  });
}
