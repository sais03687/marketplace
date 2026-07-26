/**
 * Re-run provisioning for an existing deployment.
 *
 * Tears down and rebuilds the agent container so it picks up container env that
 * only gets injected at provision time (EMAIL_MODE, OUTLOOK_SEND_URL, workspace
 * identity). Containers have no volumes, so anything written into /agent at
 * runtime is lost — check that the container's adapter.py matches the repo
 * template before running this, or you will silently revert a hot patch.
 *
 * Requires the provisioning service to be running: this only enqueues the job,
 * the worker does the work.
 *
 * Usage (from the repo root, on the VPS):
 *   node --env-file=.env.prod scripts/reprovision-deployment.mjs <deploymentId>
 *   node --env-file=.env.prod scripts/reprovision-deployment.mjs <deploymentId> --apply
 */
import { PrismaClient } from "@prisma/client";
import { Queue } from "bullmq";

const deploymentId = process.argv[2];
const APPLY = process.argv.includes("--apply");

if (!deploymentId || deploymentId.startsWith("--")) {
  console.error("Usage: node scripts/reprovision-deployment.mjs <deploymentId> [--apply]");
  process.exit(2);
}
if (!process.env.REDIS_URL) {
  console.error("REDIS_URL is not set — pass --env-file=.env.prod");
  process.exit(2);
}

const prisma = new PrismaClient();
const dep = await prisma.deployment.findUnique({
  where: { id: deploymentId },
  select: {
    id: true, status: true, agentEmail: true, workspaceEmail: true,
    workspaceProvider: true, containerName: true, buyerMicrosoftTenantId: true,
  },
});

if (!dep) {
  console.error(`Deployment ${deploymentId} not found.`);
  await prisma.$disconnect();
  process.exit(1);
}

console.log("Deployment to re-provision:");
for (const [k, v] of Object.entries(dep)) console.log(`  ${k}: ${v ?? "(null)"}`);
console.log(`\n  mode: ${dep.buyerMicrosoftTenantId ? "buyer-org" : "platform"}`);

// Re-provisioning is only safe once the provisioning job can (a) replace an
// existing container instead of colliding with it, and (b) scope its failure
// rollback to resources it actually created. Without both, a container-name
// conflict deletes the agent's M365 user and AgentMail inbox. This check is a
// reminder of that coupling, not a substitute for it.
console.log(
  "\nRequires: custom-runner replaces an existing container, and provision.ts"
  + "\nrollback skips pre-existing inbox/M365 user. Verify both before --apply.",
);

if (!APPLY) {
  console.log("\nDry run — nothing enqueued.");
  console.log("This will REPLACE the running container. Re-run with --apply to proceed.");
  await prisma.$disconnect();
  process.exit(0);
}

await prisma.deployment.update({
  where: { id: deploymentId },
  data: { status: "PROVISIONING" },
});
console.log("\nStatus set to PROVISIONING");

const queue = new Queue("provisioning", { connection: { url: process.env.REDIS_URL } });
const job = await queue.add("provision", { type: "provision", deploymentId });
console.log(`Enqueued provision job ${job.id}`);
console.log("Watch: pm2 logs marketplace-provisioning");

await queue.close();
await prisma.$disconnect();
