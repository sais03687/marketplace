import { Queue } from "bullmq";
import { config } from "./config.js";

export const provisioningQueue = new Queue("provisioning", {
  connection: { url: config.redisUrl },
});

export type ProvisionJobData = {
  type: "provision" | "deprovision" | "update";
  deploymentId: string;
};

export async function enqueueProvision(deploymentId: string): Promise<string> {
  const job = await provisioningQueue.add("provision", {
    type: "provision",
    deploymentId,
  } satisfies ProvisionJobData);
  return job.id!;
}

export async function enqueueDeprovision(deploymentId: string): Promise<string> {
  const job = await provisioningQueue.add("deprovision", {
    type: "deprovision",
    deploymentId,
  } satisfies ProvisionJobData);
  return job.id!;
}

export async function enqueueUpdate(deploymentId: string): Promise<string> {
  const job = await provisioningQueue.add("update", {
    type: "update",
    deploymentId,
  } satisfies ProvisionJobData);
  return job.id!;
}
