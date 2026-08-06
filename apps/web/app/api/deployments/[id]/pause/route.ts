import { prisma } from "@/lib/db";
import { jsonError, jsonSuccess, requireOrg, requireDeploymentAccess } from "@/lib/api-utils";
import { getProvisioningQueue } from "@/lib/provisioning-queue";
import { getStripe, getOrCreatePauseCoupon } from "@/lib/stripe";


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
    return jsonError("Cannot pause/resume a fired agent", 409);
  }
  if (deployment.status === "PROVISIONING") {
    return jsonError("Cannot pause/resume while provisioning is in progress", 409);
  }

  const isPaused = deployment.status === "PAUSED";
  const jobType = isPaused ? "resume" : "pause";
  const newStatus = isPaused ? "ACTIVE" : "PAUSED";

  // Optimistically update DB status so the UI reflects the intent immediately
  await prisma.deployment.update({
    where: { id },
    data: {
      status: newStatus,
      pausedAt: newStatus === "PAUSED" ? new Date() : null,
    },
  });

  // Do the real work: stop or start the container and its poller.
  //
  // This used to enqueue inside a try/catch that swallowed failures and returned
  // success anyway, on the theory that "the gateway will be cleaned up on next
  // service restart". It is not — startup recovery re-spawns pollers for surviving
  // containers, it does not stop paused ones. So a dropped enqueue produced a
  // deployment the dashboard called PAUSED whose agent kept reading mail,
  // answering it, and holding its Microsoft licence. Confirmed in production on
  // 2026-08-04: paused, then emailed the agent, and it replied.
  //
  // The queue genuinely is unreliable from here — the fire route has carried a
  // retry and an HTTP fallback since Upstash was seen dropping connections. Pause
  // gets the same, and reports honestly when both fail.
  let stopQueued = false;
  try {
    await getProvisioningQueue().add(jobType, { type: jobType, deploymentId: id });
    stopQueued = true;
  } catch (err: any) {
    console.error(`[pause-route] Failed to enqueue ${jobType} for ${id}: ${err.message}`);
  }

  if (!stopQueued) {
    const base =
      process.env.PROVISIONING_SERVICE_URL ||
      process.env.PROVISIONING_URL ||
      "https://api.agentstore.it.com";
    const secret = process.env.PROVISIONING_SECRET;
    if (secret) {
      try {
        const resp = await fetch(`${base.replace(/\/$/, "")}/internal/${jobType}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
          body: JSON.stringify({ deploymentId: id }),
          signal: AbortSignal.timeout(30_000),
        });
        stopQueued = resp.ok;
        if (!resp.ok) {
          console.error(`[pause-route] HTTP ${jobType} fallback returned ${resp.status} for ${id}`);
        }
      } catch (err: any) {
        console.error(`[pause-route] HTTP ${jobType} fallback failed for ${id}: ${err.message}`);
      }
    }
  }

  if (!stopQueued) {
    // Put the status back. Claiming an agent is paused while it is still running
    // is the one outcome worse than refusing the request — a buyer pausing a
    // misbehaving agent would believe they had stopped it.
    await prisma.deployment.update({
      where: { id },
      data: { status: deployment.status, pausedAt: isPaused ? new Date() : null },
    });
    return jsonError(
      isPaused
        ? "Could not reach the agent to resume it. Nothing has changed — please try again."
        : "Could not reach the agent to pause it. It is still running, so nothing has changed — please try again.",
      503,
    );
  }

  // Now the money. The agent is already stopped or restarted at this point, which
  // is what the buyer actually asked for, so a Stripe failure here must not undo
  // that — but it must be loud, because the failure mode is silent overcharging.
  //
  // Until 2026-08-06 this step did not exist at all. Pause touched no Stripe API,
  // so a paused agent kept billing at the full rate while /dashboard/billing told
  // the buyer "Paused agents are charged at 50% of the monthly rate" and the
  // creator payout cron computed the creator's share on that same halved figure.
  // Three places, three different answers, and the gap quietly kept.
  //
  // Granularity is per-invoice, not per-day: the discount covers whichever
  // invoices fall while the agent is paused, rather than the exact hours. That
  // errs toward the buyer on a short pause, which is the right direction to be
  // wrong in, and matches how the page describes it.
  if (deployment.stripeSubscriptionId) {
    const stripe = getStripe();
    if (stripe) {
      try {
        if (newStatus === "PAUSED") {
          const coupon = await getOrCreatePauseCoupon(stripe);
          await stripe.subscriptions.update(deployment.stripeSubscriptionId, {
            discounts: [{ coupon }],
          });
          console.log(`[pause-route] Applied half-rate discount to ${deployment.stripeSubscriptionId}`);
        } else {
          await stripe.subscriptions.update(deployment.stripeSubscriptionId, {
            discounts: [],
          });
          console.log(`[pause-route] Removed half-rate discount from ${deployment.stripeSubscriptionId}`);
        }
      } catch (err: any) {
        console.error(
          `[pause-route] Agent ${id} is now ${newStatus} but its subscription ` +
            `${deployment.stripeSubscriptionId} was NOT adjusted: ${err.message}. ` +
            `The buyer is being billed at the wrong rate until this is corrected.`,
        );
      }
    }
  }

  return jsonSuccess({
    message: isPaused ? "Agent resuming" : "Agent pausing",
    status: newStatus,
    deploymentId: id,
  });
}
