import { prisma } from "@marketplace/db";
import { startWorker } from "./worker.js";
import { config } from "./config.js";
import { getContainerPort } from "./clients/docker.js";
import { startPoller } from "./jobs/poller-manager.js";
import { restartLocalAgent } from "./jobs/local-runner.js";
import { startProxyServer } from "./server.js";
import Dockerode from "dockerode";

const docker = new Dockerode();

console.log("[provisioning-service] Starting...");

/**
 * On startup, re-spawn OpenClaw gateways and pollers for any local-mode
 * deployments that went offline when the provisioning service restarted.
 * Conversation history and agent state are preserved on disk — this just
 * brings the gateway process back up so the agent can respond again.
 */
async function recoverLocalAgents(): Promise<void> {
  let deployments;
  try {
    deployments = await prisma.deployment.findMany({
      where: {
        status: { in: ["ACTIVE", "ONBOARDING"] },
        containerName: { startsWith: "http://localhost:" },
        agentEmail: { not: null },
      },
      include: { agent: { select: { runtime: true } } },
    });
  } catch (err: any) {
    console.warn(`[recovery] DB query failed, skipping local agent recovery: ${err.message}`);
    return;
  }

  // Only recover OPENCLAW local-mode deployments (CUSTOM runtime uses Docker)
  const localDeployments = deployments.filter(
    (dep) => (dep.agent.runtime ?? "OPENCLAW") !== "CUSTOM",
  );

  if (localDeployments.length === 0) {
    console.log("[recovery] No local agents to recover.");
    return;
  }

  console.log(`[recovery] Recovering ${localDeployments.length} local agent(s)...`);

  for (const dep of localDeployments) {
    try {
      const port = parseInt(new URL(dep.containerName!).port, 10);
      if (!port) throw new Error(`Could not parse port from containerName: ${dep.containerName}`);

      await restartLocalAgent({
        deploymentId: dep.id,
        port,
        agentEmail: dep.agentEmail!,
        agentId: dep.agentId,
        approvalWebhookToken: dep.approvalWebhookToken ?? undefined,
      });

      console.log(`[recovery] Local agent recovered: ${dep.id.slice(0, 8)} on port ${port} (${dep.agentEmail})`);
    } catch (err: any) {
      console.warn(`[recovery] Failed to recover ${dep.id.slice(0, 8)}: ${err.message}`);
    }
  }
}

/**
 * On startup, re-spawn AgentMail pollers for any Docker-based deployments that
 * survived the service restart.
 *
 * - Docker-OpenClaw containers: named "agent-*"
 * - Custom Docker containers: named "custom-agent-*"
 */
async function recoverDockerPollers(): Promise<void> {
  let deployments;
  try {
    deployments = await prisma.deployment.findMany({
      where: {
        status: { in: ["ACTIVE", "ONBOARDING"] },
        containerName: { not: null },
        agentEmail: { not: null },
      },
      include: { agent: { select: { runtime: true } } },
    });
  } catch (err: any) {
    console.warn(`[recovery] DB query failed, skipping poller recovery: ${err.message}`);
    return;
  }

  // Filter to Docker containers only. containerName formats:
  //   - "agent-<slug>-<id>" / "custom-agent-<id>" — old Docker format
  //   - "http://localhost:<port>" — new format for BOTH Docker and local-mode
  // In local runner mode, http:// OPENCLAW deployments are handled by
  // recoverLocalAgents instead. CUSTOM runtime is always Docker.
  const dockerDeployments = deployments.filter((dep) => {
    const name = dep.containerName ?? "";
    const runtime = dep.agent.runtime ?? "OPENCLAW";
    if (name.startsWith("agent-") || name.startsWith("custom-agent-")) return true;
    if (name.startsWith("http://")) {
      // CUSTOM is always Docker; OPENCLAW http:// is Docker only when not in local mode
      return runtime === "CUSTOM" || config.runnerMode === "docker";
    }
    return false;
  });

  if (dockerDeployments.length === 0) {
    console.log("[recovery] No Docker deployments to recover.");
    return;
  }

  console.log(
    `[recovery] Recovering pollers for ${dockerDeployments.length} Docker deployment(s)...`,
  );

  for (const dep of dockerDeployments) {
    try {
      let port: number;
      const containerName = dep.containerName!;
      const runtime = dep.agent.runtime ?? "OPENCLAW";

      if (containerName.startsWith("http://")) {
        // New format: extract port from URL
        port = parseInt(new URL(containerName).port, 10);
        if (!port) throw new Error(`Could not parse port from containerName: ${containerName}`);
      } else {
        // Old format: ask Docker for the mapped port
        port = await getContainerPort(containerName);
      }

      // Verify the container is actually running before spawning a poller.
      // If it was manually removed or crashed, skip it and mark the deployment FIRED
      // so it doesn't come back on the next restart.
      const resolvedName = containerName.startsWith("http://")
        ? `custom-agent-${dep.id.slice(0, 8)}`
        : containerName;
      try {
        const info = await docker.getContainer(resolvedName).inspect();
        if (!info.State.Running) throw new Error(`container not running (state: ${info.State.Status})`);
      } catch (containerErr: any) {
        console.warn(`[recovery] Container for ${dep.id.slice(0, 8)} is gone — marking FIRED: ${containerErr.message}`);
        await prisma.deployment.update({ where: { id: dep.id }, data: { status: "FIRED", firedAt: new Date() } });
        continue;
      }

      startPoller({
        deploymentId: dep.id,
        agentEmail: dep.agentEmail!,
        agentId: dep.agentId,
        gatewayUrl: `http://127.0.0.1:${port}`,
        // Custom runtime containers don't use OpenClaw hooks auth
        hooksToken: runtime === "CUSTOM" ? "" : config.openclawHooksToken,
        marketplaceUrl: config.approvalWebhookUrl,
        // Prefer the workspace mailbox explicitly: agentEmail should already hold
        // it, but the fallback keeps recovery working for any row not yet migrated.
        outlookEmail: dep.workspaceEmail ?? dep.agentEmail!,
      });
      console.log(
        `[recovery] Poller restored for ${dep.id.slice(0, 8)} (${dep.workspaceEmail ?? dep.agentEmail})`,
      );
    } catch (err: any) {
      // Container may have stopped or been removed — skip gracefully
      console.warn(`[recovery] Skipping ${dep.id.slice(0, 8)}: ${err.message}`);
    }
  }
}

const worker = startWorker();
startProxyServer();

// Recover local OpenClaw agents (gateways + pollers) that went offline with this process
recoverLocalAgents().catch((err) => {
  console.warn("[recovery] Unexpected error during local agent recovery:", err.message);
});

// Recover pollers for any Docker deployments that survived the last restart
recoverDockerPollers().catch((err) => {
  console.warn("[recovery] Unexpected error during poller recovery:", err.message);
});

// Graceful shutdown
async function shutdown(signal: string) {
  console.log(`[provisioning-service] Received ${signal}, shutting down...`);
  await worker.close();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
