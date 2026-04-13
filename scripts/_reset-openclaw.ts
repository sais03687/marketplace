import { PrismaClient } from "@prisma/client";
import { Queue } from "bullmq";

const p = new PrismaClient();

async function main() {
  // Delete old inbox for openclaw if it exists
  const apiKey = process.env.AGENTMAIL_API_KEY!;
  try {
    const dep = await p.deployment.findUnique({
      where: { id: "cmnvzw3wj0004rs9c139nsjpn" },
      select: { agentEmailInboxId: true },
    });
    if (dep?.agentEmailInboxId) {
      await fetch(`https://api.agentmail.to/v0/inboxes/${dep.agentEmailInboxId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      console.log("Deleted old inbox");
    }
  } catch {}

  // Reset OPENCLAW deployment
  await p.deployment.update({
    where: { id: "cmnvzw3wj0004rs9c139nsjpn" },
    data: { status: "PROVISIONING", containerName: null, agentEmail: null, agentEmailInboxId: null },
  });
  console.log("OPENCLAW deployment reset to PROVISIONING");

  const queue = new Queue("provisioning", {
    connection: { url: process.env.REDIS_URL || "redis://localhost:6379" },
  });
  const job = await queue.add("provision", {
    type: "provision",
    deploymentId: "cmnvzw3wj0004rs9c139nsjpn",
  });
  console.log(`Enqueued OPENCLAW job: ${job.id}`);

  await queue.close();
  await p.$disconnect();
}

main().catch(console.error);
