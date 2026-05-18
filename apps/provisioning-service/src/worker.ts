import { Worker, type Job } from "bullmq";
import { config } from "./config.js";
import type { ProvisionJobData } from "./queue.js";
import { provisionJob } from "./jobs/provision.js";
import { deprovisionJob } from "./jobs/deprovision.js";
import { updateJob } from "./jobs/update.js";
import { pauseJob, resumeJob } from "./jobs/pause.js";

async function processJob(job: Job<ProvisionJobData>): Promise<void> {
  console.log(`[worker] Processing ${job.data.type} job`);

  switch (job.data.type) {
    case "provision":
      await provisionJob(job.data.deploymentId);
      break;
    case "deprovision":
      await deprovisionJob(job.data.deploymentId);
      break;
    case "update":
      await updateJob(job.data.deploymentId);
      break;
    case "pause":
      await pauseJob(job.data.deploymentId);
      break;
    case "resume":
      await resumeJob(job.data.deploymentId);
      break;
    case "vet_package": {
      const { vetPackageJob } = await import("./jobs/vet-package.js");
      await vetPackageJob(job.data.versionId, {
        customTests: job.data.customTests,
        skipDefaultTests: job.data.skipDefaultTests,
      });
      break;
    }
    default:
      throw new Error(`Unknown job type: ${(job.data as any).type}`);
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
