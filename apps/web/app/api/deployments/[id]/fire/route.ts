import { prisma } from "@/lib/db";
import { jsonError, jsonSuccess, requireOrg, requireDeploymentAccess } from "@/lib/api-utils";
import { Queue } from "bullmq";
import { getStripe } from "@/lib/stripe";

// The provisioning worker listens on the "provisioning" queue for ALL job types
// (provision, deprovision, pause, resume, update). The old "deprovision" queue
// was never consumed — fixed here.
let provisioningQueue: Queue | null = null;
function getProvisioningQueue() {
  if (!provisioningQueue) {
    provisioningQueue = new Queue("provisioning", {
      connection: {
        host: new URL(process.env.REDIS_URL || "redis://localhost:6379").hostname,
        port: parseInt(
          new URL(process.env.REDIS_URL || "redis://localhost:6379").port || "6379",
          10,
        ),
      },
    });
  }
  return provisioningQueue;
}

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

  if (!cleanupQueued) {
    console.error(
      `[fire] Could not enqueue deprovision for ${id} after 3 attempts: ${lastError}. ` +
        `The nightly cleanup job will delete the Microsoft 365 user and release its seat.`,
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
      : "Cleanup could not be started immediately and will run automatically within 24 hours. " +
        "The Microsoft 365 account and its licence seat are released then.",
  });
}
