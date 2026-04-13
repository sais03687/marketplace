import { prisma } from "@marketplace/db";
import { config } from "../config.js";
import { deleteInbox } from "../clients/agentmail.js";
import { stopContainer } from "../clients/docker.js";
import { stopLocalAgent } from "./local-runner.js";

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
      } else {
        await stopLocalAgent(deploymentId);
      }
      console.log(`[deprovision] Container/process stopped: ${deployment.containerName}`);
    } catch (err: any) {
      console.warn(`[deprovision] Failed to stop container: ${err.message}`);
    }
  }

  // 2. Delete AgentMail inbox
  if (deployment.agentEmailInboxId) {
    try {
      await deleteInbox(deployment.agentEmailInboxId);
      console.log(`[deprovision] Deleted inbox ${deployment.agentEmailInboxId} (${deployment.agentEmail})`);
    } catch (err: any) {
      console.warn(`[deprovision] Failed to delete inbox: ${err.message}`);
    }
  }

  // 3. Update deployment status
  await prisma.deployment.update({
    where: { id: deploymentId },
    data: { status: "FIRED", firedAt: new Date() },
  });

  // 4. Log
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
