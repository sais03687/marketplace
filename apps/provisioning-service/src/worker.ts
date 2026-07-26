import { Worker, Queue, type Job } from "bullmq";
import { config } from "./config.js";
import type { ProvisionJobData } from "./queue.js";
import { provisionJob } from "./jobs/provision.js";
import { deprovisionJob } from "./jobs/deprovision.js";
import { updateJob } from "./jobs/update.js";
import { pauseJob, resumeJob } from "./jobs/pause.js";
import { renewMicrosoftWebhooksJob } from "./jobs/renew-microsoft-webhooks.js";
import { cleanupMicrosoftUsersJob } from "./jobs/cleanup-microsoft-users.js";

async function processJob(job: Job<ProvisionJobData>): Promise<void> {
  console.log(`[worker] Processing ${job.data.type} job`);

  switch (job.data.type) {
    case "provision":
      // statusBefore lets a re-provision restore the status the deployment had
      // before the caller moved it to PROVISIONING, which this job requires.
      await provisionJob(job.data.deploymentId, (job.data as any).statusBefore);
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
    case "renew_ms_webhooks":
      await renewMicrosoftWebhooksJob();
      break;
    case "cleanup_ms_users":
      await cleanupMicrosoftUsersJob();
      break;
    default:
      throw new Error(`Unknown job type: ${(job.data as any).type}`);
  }
}

export function startWorker(): Worker<ProvisionJobData> {
  const worker = new Worker<ProvisionJobData>("provisioning", processJob, {
    connection: { url: config.redisUrl },
    concurrency: 2,
    // Poll every 5s when queue is empty — prevents hammering Upstash free tier.
    // Jobs are still picked up within ~5s of being enqueued, which is fine.
    drainDelay: 10000,
  });

  worker.on("completed", (job) => {
    console.log(`[worker] Job ${job.id} (${job.data.type}) completed`);
  });

  worker.on("failed", (job, err) => {
    console.error(`[worker] Job ${job?.id} (${job?.data.type}) failed:`, err.message);
  });

  // Schedule Microsoft webhook renewal — runs every 24h to keep Graph subscriptions alive
  const queue = new Queue<ProvisionJobData>("provisioning", {
    connection: { url: config.redisUrl },
  });
  queue.add(
    "renew_ms_webhooks",
    { type: "renew_ms_webhooks" },
    { repeat: { every: 24 * 60 * 60 * 1000 }, jobId: "renew_ms_webhooks_repeatable" },
  ).catch((err) => {
    console.warn("[worker] Failed to schedule renew_ms_webhooks repeatable job:", err.message);
  });

  // Schedule Microsoft orphan cleanup — runs daily to delete M365 users from failed/fired deployments
  queue.add(
    "cleanup_ms_users",
    { type: "cleanup_ms_users" },
    { repeat: { every: 24 * 60 * 60 * 1000 }, jobId: "cleanup_ms_users_repeatable" },
  ).catch((err) => {
    console.warn("[worker] Failed to schedule cleanup_ms_users repeatable job:", err.message);
  });

  console.log("[worker] Provisioning worker started");
  return worker;
}
