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
import { stopLocalAgent, restartLocalAgent } from "./local-runner.js";

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

  const runtime = deployment.agent.runtime ?? "OPENCLAW";

  // Stop the gateway / container
  if (deployment.containerName) {
    try {
      if (runtime === "CUSTOM") {
        const { stopCustomAgent } = await import("./custom-runner.js");
        await stopCustomAgent(deploymentId);
      } else if (config.runnerMode === "docker") {
        const { stopContainer } = await import("../clients/docker.js");
        await stopContainer(deployment.containerName);
        stopPoller(deploymentId);
      } else {
        // Local mode: kill the gateway child process + poller
        await stopLocalAgent(deploymentId);
      }
      console.log(`[pause] Gateway stopped for ${deploymentId.slice(0, 8)}`);
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

  const runtime = deployment.agent.runtime ?? "OPENCLAW";

  if (!deployment.containerName) {
    throw new Error(`Deployment ${deploymentId} has no containerName — cannot resume`);
  }

  const port = parseInt(new URL(deployment.containerName).port, 10);
  if (!port) throw new Error(`Could not parse port from containerName: ${deployment.containerName}`);

  if (runtime === "CUSTOM") {
    // Custom runtime: full re-provision needed (Docker containers are stateless by design)
    // Queue a full provision job instead — this sets status back to PROVISIONING
    await prisma.deployment.update({
      where: { id: deploymentId },
      data: { status: "PROVISIONING" },
    });
    const { provisionJob } = await import("./provision.js");
    await provisionJob(deploymentId);
  } else if (config.runnerMode === "docker") {
    // Docker-OpenClaw: restart the container (it persists workspace on volume)
    const { startContainer } = await import("../clients/docker.js");
    const containerName = deployment.containerName.startsWith("http")
      ? `agent-${deployment.agent.slug}-${deploymentId.slice(0, 8)}`
      : deployment.containerName;
    await startContainer(containerName);

    // Restart poller
    const { startPoller } = await import("./poller-manager.js");
    startPoller({
      deploymentId,
      agentEmail: deployment.agentEmail!,
      inboxId: deployment.agentEmailInboxId ?? undefined,
      agentId: deployment.agentId,
      gatewayUrl: `http://127.0.0.1:${port}`,
      hooksToken: config.openclawHooksToken,
      marketplaceUrl: config.approvalWebhookUrl,
    });
  } else {
    // Local-mode OpenClaw: re-spawn the gateway using recovery logic
    await restartLocalAgent({
      deploymentId,
      port,
      agentEmail: deployment.agentEmail!,
      agentId: deployment.agentId,
      inboxId: deployment.agentEmailInboxId ?? undefined,
      approvalWebhookToken: deployment.approvalWebhookToken ?? undefined,
    });
  }

  await prisma.deployment.update({
    where: { id: deploymentId },
    data: { status: "ACTIVE", pausedAt: null },
  });

  console.log(`[resume] Deployment ${deploymentId.slice(0, 8)} resumed`);
}
