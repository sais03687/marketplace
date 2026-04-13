import { PrismaClient } from "@prisma/client";

const p = new PrismaClient();

async function main() {
  // Check provisioning logs for the CUSTOM deployment
  const logs = await p.provisioningLog.findMany({
    where: {
      deploymentId: "cmnvzw3wz000ars9ce4qrujqz",
    },
    orderBy: { createdAt: "asc" },
  });

  console.log("--- CUSTOM deployment provisioning logs ---");
  for (const log of logs) {
    console.log(`${log.step} | ${log.status} | attempt=${log.attempt} | ${log.durationMs || 0}ms | ${log.message || ""}`);
  }

  // Also check OPENCLAW
  const oclogs = await p.provisioningLog.findMany({
    where: {
      deploymentId: "cmnvzw3wj0004rs9c139nsjpn",
    },
    orderBy: { createdAt: "asc" },
  });

  console.log("\n--- OPENCLAW deployment provisioning logs ---");
  for (const log of oclogs) {
    console.log(`${log.step} | ${log.status} | attempt=${log.attempt} | ${log.durationMs || 0}ms | ${log.message || ""}`);
  }

  await p.$disconnect();
}

main().catch(console.error);
