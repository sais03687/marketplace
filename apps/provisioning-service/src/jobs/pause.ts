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

import { prisma } from "@marketplace/db";
import { config } from "../config.js";
import { stopPoller } from "./poller-manager.js";

export async function pauseJob(deploymentId: string): Promise<void> {
  const deployment = await prisma.deployment.findUnique({
    where: { id: deploymentId },
    include: { agent: { select: { runtime: true, slug: true } } },
  });

  if (!deployment) throw new Error(`Deployment ${deploymentId} not found`);
  if (deployment.status === "FIRED") throw new Error("Cannot pause a fired deployment");
  if (deployment.status === "PAUSED") {
    console.log(`[pause] ${deploymentId.slice(0, 8)} already paused`);
    return;
  }

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

  await prisma.deployment.update({
    where: { id: deploymentId },
    data: { status: "PAUSED", pausedAt: new Date() },
  });

  console.log(`[pause] Deployment ${deploymentId.slice(0, 8)} paused`);
}

export async function resumeJob(deploymentId: string): Promise<void> {
  const deployment = await prisma.deployment.findUnique({
    where: { id: deploymentId },
    include: { agent: { select: { runtime: true, slug: true } } },
  });

  if (!deployment) throw new Error(`Deployment ${deploymentId} not found`);
  if (deployment.status === "FIRED") throw new Error("Cannot resume a fired deployment");
  if (deployment.status !== "PAUSED") {
    console.log(`[resume] ${deploymentId.slice(0, 8)} is not paused (status: ${deployment.status})`);
    return;
  }

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

  await prisma.deployment.update({
    where: { id: deploymentId },
    data: { status: "ACTIVE", pausedAt: null },
  });

  console.log(`[resume] Deployment ${deploymentId.slice(0, 8)} resumed`);
}
