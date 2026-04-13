/**
 * Drain stale waiting jobs and re-enqueue the two provisioning jobs.
 */

import { Queue } from "bullmq";

async function main() {
  const queue = new Queue("provisioning", {
    connection: { url: process.env.REDIS_URL || "redis://localhost:6379" },
  });

  // Drain stale waiting jobs
  const waiting = await queue.getWaiting();
  console.log(`Draining ${waiting.length} stale waiting jobs...`);
  await queue.drain();

  // Re-enqueue the two deployments
  const job1 = await queue.add("provision", {
    type: "provision",
    deploymentId: "cmnvzw3wj0004rs9c139nsjpn",
  });
  console.log(`Re-enqueued OpenClaw: job ${job1.id}`);

  const job2 = await queue.add("provision", {
    type: "provision",
    deploymentId: "cmnvzw3wz000ars9ce4qrujqz",
  });
  console.log(`Re-enqueued Custom: job ${job2.id}`);

  await queue.close();
}

main().catch(console.error);
