import { prisma } from "@marketplace/db";
import { startWorker } from "./worker.js";
import { config } from "./config.js";
import { getContainerPort } from "./clients/docker.js";
import { startPoller } from "./jobs/poller-manager.js";
import { startProxyServer } from "./server.js";
import Dockerode from "dockerode";

const docker = new Dockerode();

console.log("[provisioning-service] Starting...");

/**
 * On startup, re-spawn mail pollers for any agent containers that survived the
 * service restart. Containers are named "custom-agent-*".
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
    });
  } catch (err: any) {
    console.warn(`[recovery] DB query failed, skipping poller recovery: ${err.message}`);
    return;
  }

  // containerName is either "custom-agent-<id>" (older rows) or
  // "http://localhost:<port>". Anything else predates the current runner.
  const dockerDeployments = deployments.filter((dep) => {
    const name = dep.containerName ?? "";
    return name.startsWith("custom-agent-") || name.startsWith("http://");
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
