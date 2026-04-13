import { Queue } from "bullmq";

async function main() {
  const queue = new Queue("provisioning", {
    connection: { url: process.env.REDIS_URL || "redis://localhost:6379" },
  });

  const failed = await queue.getFailed();
  console.log(`\n--- Last 6 failed jobs ---`);
  for (const job of failed.slice(-6)) {
    console.log(`\nJob ${job.id} (${JSON.stringify(job.data)}):`);
    console.log(`  Reason: ${job.failedReason}`);
    console.log(`  Attempts: ${job.attemptsMade}`);
    console.log(`  Failed at: ${new Date(job.finishedOn || 0).toISOString()}`);
  }

  const completed = await queue.getCompleted();
  console.log(`\n--- Last 3 completed jobs ---`);
  for (const job of completed.slice(-3)) {
    console.log(`\nJob ${job.id} (${JSON.stringify(job.data)})`);
    console.log(`  Completed at: ${new Date(job.finishedOn || 0).toISOString()}`);
  }

  await queue.close();
}

main().catch(console.error);
