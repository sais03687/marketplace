import { PrismaClient } from "@prisma/client";

const p = new PrismaClient();

async function main() {
  const deps = await p.deployment.findMany({
    where: { id: { in: ["cmnvzw3wj0004rs9c139nsjpn", "cmnvzw3wz000ars9ce4qrujqz"] } },
    select: { id: true, agentName: true, agentEmail: true, containerName: true, agent: { select: { runtime: true } } },
  });

  for (const d of deps) {
    const baseUrl = d.containerName?.startsWith("http")
      ? d.containerName
      : `http://localhost:4000`;
    console.log(`\n${d.agent.runtime} (${d.agentName}): ${d.containerName}`);
    try {
      const res = await fetch(`${baseUrl}/internal/health`, { signal: AbortSignal.timeout(5000) });
      const body = await res.json();
      console.log(`  Health: ${JSON.stringify(body)}`);
    } catch (e: any) {
      console.log(`  Health check FAILED: ${e.message}`);
    }
  }

  await p.$disconnect();
}

main().catch(console.error);
