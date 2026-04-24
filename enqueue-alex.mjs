// Script to properly enqueue an Alex provision job using BullMQ
import { Queue } from "bullmq";

const REDIS_URL = "redis://localhost:6379";
const DEPLOYMENT_ID = "calex17765247590t01";

const queue = new Queue("provisioning", {
  connection: { url: REDIS_URL },
});

const job = await queue.add("provision", {
  type: "provision",
  deploymentId: DEPLOYMENT_ID,
}, {
  attempts: 3,
  backoff: { type: "exponential", delay: 5000 },
});

console.log(`Enqueued provision job: ${job.id}`);
console.log(`Job data: ${JSON.stringify(job.data)}`);

await queue.close();
process.exit(0);
