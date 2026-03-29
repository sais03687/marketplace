import { Worker, type Job } from "bullmq";
import { config } from "./config.js";
import type { ProvisionJobData } from "./queue.js";
import { provisionJob } from "./jobs/provision.js";
import { deprovisionJob } from "./jobs/deprovision.js";
import { updateJob } from "./jobs/update.js";

async function processJob(job: Job<ProvisionJobData>): Promise<void> {
  const { type, deploymentId } = job.data;
  console.log(`[worker] Processing ${type} job for deployment ${deploymentId}`);

  switch (type) {
    case "provision":
      await provisionJob(deploymentId);
      break;
    case "deprovision":
      await deprovisionJob(deploymentId);
      break;
    case "update":
      await updateJob(deploymentId);
      break;
    default:
      throw new Error(`Unknown job type: ${type}`);
  }
}

export function startWorker(): Worker<ProvisionJobData> {
  const worker = new Worker<ProvisionJobData>("provisioning", processJob, {
    connection: { url: config.redisUrl },
    concurrency: 2,
  });

  worker.on("completed", (job) => {
    console.log(`[worker] Job ${job.id} (${job.data.type}) completed`);
  });

  worker.on("failed", (job, err) => {
    console.error(`[worker] Job ${job?.id} (${job?.data.type}) failed:`, err.message);
  });

  console.log("[worker] Provisioning worker started");
  return worker;
}
