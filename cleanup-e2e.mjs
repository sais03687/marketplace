import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();

const companies = await p.company.findMany({
  where: { clerkOrgId: { in: ["e2e-acme-001","e2e-beta-001","e2e-gamma-001"] } },
  include: { deployments: true }
});

for (const c of companies) {
  const depIds = c.deployments.map(d => d.id);
  console.log("Company:", c.name, "deployments:", depIds.length);
  if (depIds.length === 0) continue;
  
  for (const depId of depIds) {
    // Delete knowledge votes then contributions
    const contribs = await p.knowledgeContribution.findMany({ where: { deploymentId: depId }, select: { id: true } });
    const contribIds = contribs.map(c => c.id);
    if (contribIds.length > 0) {
      await p.knowledgeVote.deleteMany({ where: { contributionId: { in: contribIds } } });
      await p.knowledgeContribution.deleteMany({ where: { id: { in: contribIds } } });
    }
    await p.approval.deleteMany({ where: { deploymentId: depId } });
    await p.provisioningLog.deleteMany({ where: { deploymentId: depId } });
  }
  await p.deployment.deleteMany({ where: { id: { in: depIds } } });
  console.log("  Cleaned", depIds.length, "deployments");
}

await p.$disconnect();
console.log("Done");
