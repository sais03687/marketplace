import { PrismaClient } from "@prisma/client";
import { Queue } from "bullmq";

const p = new PrismaClient();

async function main() {
  // Reset CUSTOM deployment to PROVISIONING
  await p.deployment.update({
    where: { id: "cmnvzw3wz000ars9ce4qrujqz" },
    data: { status: "PROVISIONING", containerName: null, agentEmail: null, agentEmailInboxId: null },
  });
  console.log("CUSTOM deployment reset to PROVISIONING");

  const queue = new Queue("provisioning", {
    connection: { url: process.env.REDIS_URL || "redis://localhost:6379" },
  });

  const job = await queue.add("provision", {
    type: "provision",
    deploymentId: "cmnvzw3wz000ars9ce4qrujqz",
  });
  console.log(`Enqueued CUSTOM job: ${job.id}`);

  await queue.close();
  await p.$disconnect();
}

main().catch(console.error);
