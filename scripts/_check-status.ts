import { PrismaClient } from "@prisma/client";

const p = new PrismaClient();

async function main() {
  const deps = await p.deployment.findMany({
    where: {
      id: {
        in: [
          "cmnvzw3wj0004rs9c139nsjpn",
          "cmnvzw3wz000ars9ce4qrujqz",
        ],
      },
    },
    select: {
      id: true,
      status: true,
      agentName: true,
      agentEmail: true,
      containerName: true,
      agent: { select: { slug: true, runtime: true } },
    },
  });

  for (const d of deps) {
    console.log(
      `${d.agent.runtime.padEnd(8)} | ${d.status.padEnd(14)} | ${d.agentEmail || "no email"} | container=${d.containerName || "none"}`,
    );
  }

  await p.$disconnect();
}

main().catch(console.error);
