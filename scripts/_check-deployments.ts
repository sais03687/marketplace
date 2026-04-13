import { PrismaClient } from "@prisma/client";

const p = new PrismaClient();

async function main() {
  const deps = await p.deployment.findMany({
    select: {
      id: true,
      status: true,
      agentName: true,
      agentEmail: true,
      containerName: true,
      agent: { select: { slug: true, runtime: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 10,
  });
  console.log(JSON.stringify(deps, null, 2));

  const agents = await p.agent.findMany({
    select: { id: true, slug: true, runtime: true, currentVersion: true, status: true },
  });
  console.log("\n--- Agents ---");
  console.log(JSON.stringify(agents, null, 2));

  const versions = await p.agentVersion.findMany({
    select: { id: true, agentId: true, version: true, vetStatus: true, storagePath: true },
    orderBy: { createdAt: "desc" },
    take: 10,
  });
  console.log("\n--- Agent Versions ---");
  console.log(JSON.stringify(versions, null, 2));

  await p.$disconnect();
}

main().catch(console.error);
