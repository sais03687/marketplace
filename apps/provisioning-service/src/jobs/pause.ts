/**
 * Pause / Resume jobs for the provisioning worker.
 *
 * PAUSE: stops the gateway process/container and its poller, sets DB status to PAUSED.
 * RESUME: restarts the gateway (using the same recovery logic as service restart),
 *         restarts the poller, sets DB status back to ACTIVE.
 *
 * This gives real isolation — a paused agent cannot process emails and does not
 * consume LLM quota. Useful for payment failures, manual suspension, etc.
 */

import { prisma, setDeploymentPaused } from "@marketplace/db";
import { config } from "../config.js";
import { stopPoller } from "./poller-manager.js";

export async function pauseJob(deploymentId: string): Promise<void> {
  const deployment = await prisma.deployment.findUnique({
    where: { id: deploymentId },
    include: { agent: { select: { runtime: true, slug: true } } },
  });

  if (!deployment) throw new Error(`Deployment ${deploymentId} not found`);
  if (deployment.status === "FIRED") throw new Error("Cannot pause a fired deployment");

  // Deliberately no early return on status === "PAUSED".
  //
  // The route marks the deployment PAUSED before this job runs, so the status is
  // always already PAUSED by the time we get here — which meant this guard fired
  // every single time and returned before stopping anything. The row said paused
  // and the container went on answering mail.
  //
  // Idempotency has to come from the work instead, and it does: stopping a
  // container that is already stopped is a no-op. Status is a record of intent,
  // not evidence that the intent was carried out.

  // Stop the agent container (stopCustomAgent also kills its poller)
  if (deployment.containerName) {
    try {
      const { stopCustomAgent } = await import("./custom-runner.js");
      await stopCustomAgent(deploymentId);
      console.log(`[pause] Container stopped for ${deploymentId.slice(0, 8)}`);
    } catch (err: any) {
      // Log but don't abort — still mark as PAUSED so billing stops
      console.warn(`[pause] Failed to stop gateway: ${err.message}`);
    }
  }

  await setDeploymentPaused(deploymentId, true);

  console.log(`[pause] Deployment ${deploymentId.slice(0, 8)} paused`);
}

export async function resumeJob(deploymentId: string): Promise<void> {
  const deployment = await prisma.deployment.findUnique({
    where: { id: deploymentId },
    include: { agent: { select: { runtime: true, slug: true } } },
  });

  if (!deployment) throw new Error(`Deployment ${deploymentId} not found`);
  if (deployment.status === "FIRED") throw new Error("Cannot resume a fired deployment");

  // The mirror of the guard removed from pauseJob, and broken the same way: the
  // route sets the deployment ACTIVE before enqueuing this, so the status is never
  // PAUSED by the time the job reads it. The job would log "is not paused" and
  // return, leaving a deployment marked ACTIVE with nothing running.
  //
  // Re-provisioning an already-running deployment is safe — it reconciles rather
  // than duplicating — so there is nothing to guard against here.

  if (!deployment.containerName) {
    throw new Error(`Deployment ${deploymentId} has no containerName — cannot resume`);
  }

  // Agent containers hold no volumes, so resuming means a full re-provision
  // rather than restarting a stopped container. provisionJob requires
  // PROVISIONING as its entry condition and is told what the status was before.
  const statusBefore = deployment.status;
  await prisma.deployment.update({
    where: { id: deploymentId },
    data: { status: "PROVISIONING" },
  });
  const { provisionJob } = await import("./provision.js");
  await provisionJob(deploymentId, statusBefore);

  await setDeploymentPaused(deploymentId, false);

  console.log(`[resume] Deployment ${deploymentId.slice(0, 8)} resumed`);
}
