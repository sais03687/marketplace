/**
 * Set approval policy to "never" for both deployments during testing.
 * This lets agents reply directly without approval queue.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const deployments = ["cmnvzw3wj0004rs9c139nsjpn", "cmnvzw3wz000ars9ce4qrujqz"];

  for (const id of deployments) {
    const dep = await prisma.deployment.update({
      where: { id },
      data: {
        autonomyConfig: {
          approvalPolicy: "never",
          approvalRiskThreshold: 10,
          autoApproveList: "",
          requireApprovalList: "",
        },
      },
      select: { id: true, agent: { select: { name: true } }, autonomyConfig: true },
    });
    console.log(`Updated ${dep.agent.name} (${id}):`);
    console.log(`  autonomyConfig:`, JSON.stringify(dep.autonomyConfig));
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
