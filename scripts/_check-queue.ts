import { Queue } from "bullmq";

async function main() {
  const queue = new Queue("provisioning", {
    connection: { url: process.env.REDIS_URL || "redis://localhost:6379" },
  });

  const waiting = await queue.getWaiting();
  const active = await queue.getActive();
  const completed = await queue.getCompleted();
  const failed = await queue.getFailed();

  console.log(`Queue status:`);
  console.log(`  Waiting: ${waiting.length}`);
  console.log(`  Active:  ${active.length}`);
  console.log(`  Completed: ${completed.length}`);
  console.log(`  Failed:    ${failed.length}`);

  if (failed.length > 0) {
    console.log("\n--- Failed jobs ---");
    for (const job of failed.slice(-3)) {
      console.log(`  Job ${job.id}: ${job.failedReason}`);
    }
  }

  if (active.length > 0) {
    console.log("\n--- Active jobs ---");
    for (const job of active) {
      console.log(`  Job ${job.id}: ${JSON.stringify(job.data)}`);
    }
  }

  if (waiting.length > 0) {
    console.log("\n--- Waiting jobs ---");
    for (const job of waiting) {
      console.log(`  Job ${job.id}: ${JSON.stringify(job.data)}`);
    }
  }

  await queue.close();
}

main().catch(console.error);
