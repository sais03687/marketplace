import { Queue } from "bullmq";
import { config } from "./config.js";

export const provisioningQueue = new Queue("provisioning", {
  connection: { url: config.redisUrl },
});

export interface CustomTest {
  name: string;
  endpoint: string;
  method?: string;
  body?: unknown;
  expectStatus?: number;
  headers?: Record<string, string>;
}

export type ProvisionJobData =
  | { type: "provision" | "deprovision" | "update" | "pause" | "resume"; deploymentId: string }
  | { type: "vet_package"; versionId: string; customTests?: CustomTest[]; skipDefaultTests?: boolean }
  | { type: "renew_ms_webhooks" };

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

export async function enqueuePause(deploymentId: string): Promise<string> {
  const job = await provisioningQueue.add("pause", {
    type: "pause",
    deploymentId,
  } satisfies ProvisionJobData);
  return job.id!;
}

export async function enqueueResume(deploymentId: string): Promise<string> {
  const job = await provisioningQueue.add("resume", {
    type: "resume",
    deploymentId,
  } satisfies ProvisionJobData);
  return job.id!;
}

export async function enqueueVetPackage(versionId: string): Promise<string> {
  const job = await provisioningQueue.add("vet_package", {
    type: "vet_package",
    versionId,
  } satisfies ProvisionJobData);
  return job.id!;
}
