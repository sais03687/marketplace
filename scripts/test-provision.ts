import { PrismaClient } from "@prisma/client";
import { Queue } from "bullmq";

const prisma = new PrismaClient();

async function main() {
  const company = await prisma.company.upsert({
    where: { clerkOrgId: "test-org-001" },
    update: {},
    create: {
      clerkOrgId: "test-org-001",
      name: "Test Company",
      domain: "test.example.com",
    },
  });
  console.log("Company:", company.id, company.name);

  const agent = await prisma.agent.findUnique({ where: { slug: "general-ops-alex" } });
  if (!agent) { console.log("Agent not found!"); return; }
  console.log("Agent:", agent.id, agent.name);

  const deployment = await prisma.deployment.create({
    data: {
      agentId: agent.id,
      companyId: company.id,
      agentVersion: agent.currentVersion,
      agentName: "Alex",
      status: "PROVISIONING",
      weeklyDigestEmail: "saiha@test.example.com",
      autonomyConfig: {
        email_triage: "always_queue",
        meeting_prep: "always_queue",
        follow_up: "always_queue",
        task_planning: "always_queue",
        research: "always_queue",
        weekly_digest: "auto_execute",
      },
    },
  });
  console.log("Deployment:", deployment.id, "status:", deployment.status);

  const queue = new Queue("provisioning", {
    connection: { url: process.env.REDIS_URL || "redis://localhost:6379" },
  });

  const job = await queue.add("provision", { type: "provision", deploymentId: deployment.id });
  console.log("Job enqueued:", job.id, "for deployment:", deployment.id);
  console.log("\nWatch the provisioning-service terminal for the agent to start...");

  await queue.close();
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
