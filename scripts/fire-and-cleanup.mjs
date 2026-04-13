/**
 * Fire the broken test-langchain-agent deployment and delete its inbox.
 * Usage: node --env-file=.env scripts/fire-and-cleanup.mjs
 */
import { PrismaClient } from "@prisma/client";

const AGENTMAIL_API_KEY = process.env.AGENTMAIL_API_KEY;
const AGENTMAIL_API_BASE =
  process.env.AGENTMAIL_API_BASE || "https://api.agentmail.to/v0";
const prisma = new PrismaClient();

async function deleteInbox(inboxId) {
  const res = await fetch(
    `${AGENTMAIL_API_BASE}/inboxes/${encodeURIComponent(inboxId)}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${AGENTMAIL_API_KEY}`,
        "Content-Type": "application/json",
      },
    },
  );
  if (res.ok || res.status === 404) return;
  const text = await res.text().catch(() => "");
  throw new Error(`AgentMail DELETE ${res.status}: ${text}`);
}

// Fire the latest test-langchain-agent deployment
const dep = await prisma.deployment.findFirst({
  where: { agent: { slug: "test-langchain-agent" }, status: "ACTIVE" },
  orderBy: { createdAt: "desc" },
  select: { id: true, agentEmailInboxId: true, agentName: true },
});

if (!dep) {
  console.log("No active test-langchain-agent deployment found.");
} else {
  if (dep.agentEmailInboxId) {
    await deleteInbox(dep.agentEmailInboxId);
    console.log(`Deleted inbox: ${dep.agentEmailInboxId}`);
  }
  await prisma.deployment.update({
    where: { id: dep.id },
    data: { status: "FIRED", firedAt: new Date() },
  });
  console.log(`Fired deployment: ${dep.id} (${dep.agentName})`);
}

// Also clean up ERROR deployments for this agent (no inboxes to delete)
const errorDeps = await prisma.deployment.findMany({
  where: { agent: { slug: "test-langchain-agent" }, status: "ERROR" },
  select: { id: true },
});
if (errorDeps.length > 0) {
  await prisma.deployment.updateMany({
    where: { id: { in: errorDeps.map((d) => d.id) } },
    data: { status: "FIRED", firedAt: new Date() },
  });
  console.log(`Cleaned up ${errorDeps.length} ERROR deployments`);
}

await prisma.$disconnect();
console.log("Done. You can now re-hire the agent from /browse.");
