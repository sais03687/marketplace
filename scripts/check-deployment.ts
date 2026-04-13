import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();
async function main() {
  const d = await p.deployment.findUnique({
    where: { id: "cmnnaprv60004rs2wd0e7lpb5" },
    include: { agent: { select: { name: true, slug: true, runtime: true } } },
  });
  if (!d) { console.log("Deployment not found"); return; }
  console.log("Status:", d.status);
  console.log("Onboarding:", d.onboardingState);
  console.log("Agent:", d.agent.name, `(${d.agent.runtime})`);
  console.log("Container:", d.containerName || "none");
  console.log("Email:", d.agentEmail || "none");
  console.log("Inbox:", d.agentEmailInboxId || "none");
  console.log("Portal token:", d.portalToken || "none");
  console.log("Created:", d.createdAt);
}
main().finally(() => p.$disconnect());
