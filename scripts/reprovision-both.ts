/**
 * Fire all active deployments, then provision one OPENCLAW and one CUSTOM agent fresh.
 * Usage: npx tsx --env-file=.env scripts/reprovision-both.ts
 */

import { PrismaClient } from "@prisma/client";
import { Queue } from "bullmq";

const prisma = new PrismaClient();

async function main() {
  // 1. Fire all active deployments
  const active = await prisma.deployment.findMany({
    where: { status: { in: ["ACTIVE", "ONBOARDING", "PROVISIONING"] } },
    select: { id: true, agentName: true, agentEmail: true, status: true },
  });

  if (active.length > 0) {
    console.log(`\n--- Firing ${active.length} active deployment(s) ---`);
    for (const dep of active) {
      console.log(`  Firing: ${dep.agentName} (${dep.id}) [${dep.status}]`);
      await prisma.deployment.update({
        where: { id: dep.id },
        data: { status: "FIRED" },
      });
    }
  } else {
    console.log("No active deployments to fire.");
  }

  // 2. Ensure test company exists
  const company = await prisma.company.upsert({
    where: { clerkOrgId: "test-org-001" },
    update: {},
    create: {
      clerkOrgId: "test-org-001",
      name: "My Company",
      domain: "mycompany.com",
    },
  });
  console.log(`\nCompany: ${company.id} "${company.name}" (${company.domain})`);

  // 3. Find both agents
  const openclawAgent = await prisma.agent.findUnique({ where: { slug: "general-ops-alex" } });
  const customAgent = await prisma.agent.findUnique({ where: { slug: "test-langchain-agent" } });
  // Fallback to langchain-ops if test-langchain-agent doesn't exist
  const customFallback = customAgent || await prisma.agent.findUnique({ where: { slug: "langchain-ops" } });

  if (!openclawAgent) {
    console.error("ERROR: general-ops-alex agent not found. Run pnpm seed first.");
    return;
  }
  if (!customFallback) {
    console.error("ERROR: No CUSTOM agent found (test-langchain-agent or langchain-ops). Run pnpm seed first.");
    return;
  }

  console.log(`\nOpenClaw agent: ${openclawAgent.slug} (${openclawAgent.id})`);
  console.log(`Custom agent:   ${customFallback.slug} (${customFallback.id})`);

  // 4. Create deployments
  const openclawDep = await prisma.deployment.create({
    data: {
      agentId: openclawAgent.id,
      companyId: company.id,
      agentVersion: openclawAgent.currentVersion,
      agentName: "Alex",
      status: "PROVISIONING",
      managerEmail: "saiha@mycompany.com",
      autonomyConfig: {
        approvalPolicy: "external-only",
        approvalRiskThreshold: 6.0,
      },
    },
  });
  console.log(`\nOpenClaw deployment: ${openclawDep.id} (PROVISIONING)`);

  const customDep = await prisma.deployment.create({
    data: {
      agentId: customFallback.id,
      companyId: company.id,
      agentVersion: customFallback.currentVersion,
      agentName: "LangChain Agent",
      status: "PROVISIONING",
      managerEmail: "saiha@mycompany.com",
      autonomyConfig: {
        approvalPolicy: "external-only",
        approvalRiskThreshold: 6.0,
      },
    },
  });
  console.log(`Custom deployment:   ${customDep.id} (PROVISIONING)`);

  // 5. Enqueue provisioning jobs
  const queue = new Queue("provisioning", {
    connection: { url: process.env.REDIS_URL || "redis://localhost:6379" },
  });

  const job1 = await queue.add("provision", { type: "provision", deploymentId: openclawDep.id });
  console.log(`\nEnqueued OpenClaw job: ${job1.id}`);

  const job2 = await queue.add("provision", { type: "provision", deploymentId: customDep.id });
  console.log(`Enqueued Custom job:   ${job2.id}`);

  console.log("\n=== Watch the provisioning-service terminal for both agents to start ===");
  console.log("Once both are ACTIVE, send emails to their @agentmail.to addresses.\n");

  await queue.close();
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
