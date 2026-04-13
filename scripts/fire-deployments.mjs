/**
 * One-off script: fire 2 stale deployments and delete their AgentMail inboxes.
 * Usage: node --env-file=.env scripts/fire-deployments.mjs
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
  if (res.ok || res.status === 404) return; // 404 = already gone
  const text = await res.text().catch(() => "");
  throw new Error(`AgentMail DELETE ${res.status}: ${text}`);
}

const targets = [
  "cmnnaprv60004rs2wd0e7lpb5", // langchain-ops-my-company (ACTIVE, Apr 6)
  "cmnkfnmob0003rs8o478438bi", // general-ops-alex-test-company (ONBOARDING, Apr 4)
];

for (const id of targets) {
  const dep = await prisma.deployment.findUnique({
    where: { id },
    select: {
      agentEmailInboxId: true,
      agent: { select: { name: true } },
    },
  });
  if (!dep) {
    console.log(`Not found: ${id}`);
    continue;
  }

  // Delete AgentMail inbox
  if (dep.agentEmailInboxId) {
    try {
      await deleteInbox(dep.agentEmailInboxId);
      console.log(
        `Deleted inbox: ${dep.agentEmailInboxId} (${dep.agent.name})`,
      );
    } catch (e) {
      console.error(
        `Failed to delete inbox ${dep.agentEmailInboxId}: ${e.message}`,
      );
    }
  }

  // Mark as FIRED
  await prisma.deployment.update({
    where: { id },
    data: { status: "FIRED", firedAt: new Date() },
  });
  console.log(`Fired deployment: ${id} (${dep.agent.name})`);
}

await prisma.$disconnect();
console.log("\nDone. 2 inbox slots freed.");
