/**
 * cleanup-inboxes.mjs
 *
 * Deletes stale AgentMail inboxes that are not associated with any
 * ACTIVE / ONBOARDING / PROVISIONING deployment.
 *
 * Usage:  node --env-file=.env scripts/cleanup-inboxes.mjs
 */

import { PrismaClient } from "@prisma/client";

const AGENTMAIL_API_KEY = process.env.AGENTMAIL_API_KEY;
const AGENTMAIL_API_BASE =
  process.env.AGENTMAIL_API_BASE || "https://api.agentmail.to/v0";

if (!AGENTMAIL_API_KEY) {
  console.error("ERROR: AGENTMAIL_API_KEY not set. Run with --env-file=.env");
  process.exit(1);
}

// ── 1. Query active deployment inbox IDs via Prisma ─────────────────────────

const prisma = new PrismaClient();

const activeDeployments = await prisma.deployment.findMany({
  where: {
    status: { in: ["ACTIVE", "ONBOARDING", "PROVISIONING"] },
    agentEmailInboxId: { not: null },
  },
  select: { agentEmailInboxId: true },
});

await prisma.$disconnect();

const activeInboxIds = new Set(
  activeDeployments.map((d) => d.agentEmailInboxId),
);
console.log(`Active deployment inboxes: ${activeInboxIds.size}`);

// ── 2. List all AgentMail inboxes ───────────────────────────────────────────

async function agentMailGet(path) {
  const res = await fetch(`${AGENTMAIL_API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${AGENTMAIL_API_KEY}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`AgentMail GET ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

async function agentMailDelete(path) {
  const res = await fetch(`${AGENTMAIL_API_BASE}${path}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${AGENTMAIL_API_KEY}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`AgentMail DELETE ${path} → ${res.status}: ${text}`);
  }
}

const { inboxes } = await agentMailGet("/inboxes");
console.log(`Total AgentMail inboxes: ${inboxes.length}`);

// ── 3. Delete stale inboxes ─────────────────────────────────────────────────

const stale = inboxes.filter((i) => !activeInboxIds.has(i.inbox_id));
console.log(`Stale inboxes to delete: ${stale.length}`);

let deleted = 0;
let failed = 0;

for (const inbox of stale) {
  try {
    await agentMailDelete(`/inboxes/${encodeURIComponent(inbox.inbox_id)}`);
    deleted++;
    console.log(`  deleted ${inbox.inbox_id} (${inbox.email})`);
  } catch (err) {
    failed++;
    console.error(`  FAILED ${inbox.inbox_id}: ${err.message}`);
  }
}

console.log(
  `\nDone. Deleted: ${deleted}, Failed: ${failed}, Kept: ${activeInboxIds.size}`,
);
