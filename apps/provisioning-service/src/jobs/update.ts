import { prisma } from "@marketplace/db";
import { config } from "../config.js";
import { getContainerPort } from "../clients/docker.js";
import { getLocalAgentPort } from "./local-runner.js";

export async function updateJob(deploymentId: string): Promise<void> {
  const deployment = await prisma.deployment.findUnique({
    where: { id: deploymentId },
    include: { agent: true },
  });

  if (!deployment) {
    throw new Error(`Deployment ${deploymentId} not found`);
  }
  if (deployment.status !== "ACTIVE" && deployment.status !== "ONBOARDING") {
    throw new Error(
      `Deployment ${deploymentId} is in ${deployment.status}, expected ACTIVE or ONBOARDING`,
    );
  }

  console.log(`[update] Starting update for deployment ${deploymentId}`);

  const runtime = deployment.agent.runtime || "OPENCLAW";

  // Determine the port to talk to
  let port: number;
  if (runtime === "CUSTOM") {
    const { getCustomAgentPort } = await import("./custom-runner.js");
    const customPort = getCustomAgentPort(deploymentId);
    if (!customPort) throw new Error(`No custom agent found for ${deploymentId}`);
    port = customPort;
  } else if (config.runnerMode === "docker" && deployment.containerName) {
    port = await getContainerPort(deployment.containerName);
  } else {
    const localPort = getLocalAgentPort(deploymentId);
    if (!localPort) throw new Error(`No local agent found for ${deploymentId}`);
    port = localPort;
  }

  // For now: signal the agent to update skills
  // In production, this would diff the new package and send changed files
  const res = await fetch(`http://localhost:${port}/internal/update-skills`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-deployment-token": config.approvalWebhookToken,
    },
    body: JSON.stringify({ files: {} }), // Placeholder — would contain actual file diffs
  });

  if (!res.ok) {
    throw new Error(`Update failed: ${res.status}`);
  }

  await prisma.provisioningLog.create({
    data: {
      deploymentId,
      step: "update_complete",
      status: "succeeded",
      attempt: 1,
    },
  });

  console.log(`[update] Deployment ${deploymentId} updated`);
}
