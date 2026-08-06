import { jsonError, jsonSuccess, requireOrg, requireDeploymentAccess } from "@/lib/api-utils";
import { getProvisioningQueue } from "@/lib/provisioning-queue";
import { setDeploymentPaused } from "@marketplace/db";


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

  // Optimistically update DB status so the UI reflects the intent immediately.
  // This also opens or closes the PausePeriod that the buyer's credit and the
  // creator's payout are both computed from, which is why it goes through the
  // shared helper rather than writing `status` directly.
  await setDeploymentPaused(id, !isPaused);

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
    await setDeploymentPaused(id, isPaused, { status: deployment.status });
    return jsonError(
      isPaused
        ? "Could not reach the agent to resume it. Nothing has changed — please try again."
        : "Could not reach the agent to pause it. It is still running, so nothing has changed — please try again.",
      503,
    );
  }

  // No Stripe call here, deliberately.
  //
  // Until 2026-08-06 this applied a 50%-off coupon on pause and removed it on
  // resume. That answered the wrong question. A coupon is evaluated once, when
  // the invoice generates, so it asked "is this agent paused right now?" rather
  // than "how much of the month was it paused?" — a three-week pause ending
  // before renewal earned the buyer nothing, and pausing across the renewal date
  // bought a whole month at half price for an agent that ran all but two days.
  //
  // Paused time is now credited in arrears at renewal, from the PausePeriod row
  // opened above. Pausing itself costs nothing and charges nothing; see
  // lib/pause-credit.ts and the invoice.created handler.

  return jsonSuccess({
    message: isPaused ? "Agent resuming" : "Agent pausing",
    status: newStatus,
    deploymentId: id,
  });
}
