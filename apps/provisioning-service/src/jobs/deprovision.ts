import { prisma } from "@marketplace/db";
import { config } from "../config.js";
import { deleteInbox } from "../clients/agentmail.js";
import { stopContainer } from "../clients/docker.js";
import { stopLocalAgent } from "./local-runner.js";
import { deleteDeploymentServiceAccount } from "../clients/google-iam.js";

export async function deprovisionJob(deploymentId: string): Promise<void> {
  const deployment = await prisma.deployment.findUnique({
    where: { id: deploymentId },
    include: { agent: true },
  });

  if (!deployment) {
    throw new Error(`Deployment ${deploymentId} not found`);
  }

  console.log(`[deprovision] Starting deprovision for ${deploymentId}`);

  const runtime = deployment.agent.runtime || "OPENCLAW";

  // 1. Stop the container or local process
  if (deployment.containerName) {
    try {
      if (runtime === "CUSTOM") {
        const { stopCustomAgent } = await import("./custom-runner.js");
        await stopCustomAgent(deploymentId);
      } else if (config.runnerMode === "docker") {
        await stopContainer(deployment.containerName);
        // Kill the poller that was spawned alongside this Docker container
        const { stopPoller } = await import("./poller-manager.js");
        stopPoller(deploymentId);
      } else {
        await stopLocalAgent(deploymentId);
      }
      console.log(`[deprovision] Container/process stopped: ${deployment.containerName}`);
    } catch (err: any) {
      console.warn(`[deprovision] Failed to stop container: ${err.message}`);
    }
  }

  // 2. Delete AgentMail inbox — only if no other active deployment shares it.
  // Two deployments can end up with the same inbox if the same agent is hired twice
  // by the same company (e.g. after a re-hire). Deleting a shared inbox would break
  // the surviving deployment.
  if (deployment.agentEmailInboxId) {
    const sharedCount = await prisma.deployment.count({
      where: {
        agentEmailInboxId: deployment.agentEmailInboxId,
        id: { not: deploymentId },
        status: { notIn: ["FIRED"] },
      },
    });

    if (sharedCount > 0) {
      console.log(`[deprovision] Inbox ${deployment.agentEmailInboxId} is shared with ${sharedCount} other deployment(s) — skipping delete`);
    } else {
      try {
        await deleteInbox(deployment.agentEmailInboxId);
        console.log(`[deprovision] Deleted inbox ${deployment.agentEmailInboxId} (${deployment.agentEmail})`);
      } catch (err: any) {
        console.warn(`[deprovision] Failed to delete inbox: ${err.message}`);
      }
    }
  }

  // 3. Delete per-deployment Google service account (best-effort)
  const iamKey = config.gcpIamKey || config.googleServiceAccountKey;
  if ((deployment as any).deploymentServiceAccountEmail && config.gcpProjectId && iamKey) {
    try {
      await deleteDeploymentServiceAccount(
        (deployment as any).deploymentServiceAccountEmail,
        config.gcpProjectId,
        iamKey,
      );
      console.log(`[deprovision] Deleted service account: ${(deployment as any).deploymentServiceAccountEmail}`);
    } catch (err: any) {
      console.warn(`[deprovision] Failed to delete service account: ${err.message}`);
    }
  }

  // 4. Update deployment status
  await prisma.deployment.update({
    where: { id: deploymentId },
    data: { status: "FIRED", firedAt: new Date() },
  });

  // 5. Log
  await prisma.provisioningLog.create({
    data: {
      deploymentId,
      step: "deprovision_complete",
      status: "succeeded",
      attempt: 1,
    },
  });

  console.log(`[deprovision] Deployment ${deploymentId} deprovisioned`);
}
