/**
 * Repoint Deployment.agentEmail at the Microsoft 365 mailbox.
 *
 * Every agent was provisioned with two mailboxes — an AgentMail address in
 * agentEmail and an M365 address in workspaceEmail — and the codebase treats
 * agentEmail as "the agent's address". Now that Microsoft is the only mail
 * channel, that column points at the wrong one.
 *
 * Repointing it rather than migrating every call site means:
 *   - index.ts passes the M365 address to startPoller, so POLLER_INBOX stops
 *     carrying a stale AgentMail address into Outlook mode;
 *   - the onboarding email (apps/web/lib/email.ts) tells the manager the
 *     address people should actually write to.
 *
 * agentEmailInboxId and agentEmailApiKey are deliberately left alone —
 * deprovision.ts still needs the inbox id to delete the AgentMail inbox.
 *
 * Usage (from the repo root, on a host that can reach the database):
 *   node --env-file=.env.prod scripts/migrate-agent-email-to-m365.mjs           # dry run
 *   node --env-file=.env.prod scripts/migrate-agent-email-to-m365.mjs --apply   # write
 *
 * Idempotent: rows already pointing at workspaceEmail are skipped, so it is
 * safe to re-run. --apply writes a backup of the previous values first.
 */
import { PrismaClient } from "@prisma/client";
import { writeFileSync } from "node:fs";

const APPLY = process.argv.includes("--apply");
const prisma = new PrismaClient();

const rows = await prisma.deployment.findMany({
  where: { workspaceProvider: "MICROSOFT", workspaceEmail: { not: null } },
  select: { id: true, agentEmail: true, workspaceEmail: true, agentEmailInboxId: true },
  orderBy: { createdAt: "asc" },
});

const pending = rows.filter((r) => r.agentEmail !== r.workspaceEmail);
const alreadyDone = rows.length - pending.length;

console.log(`Microsoft deployments with a workspace mailbox: ${rows.length}`);
console.log(`  already pointing at M365: ${alreadyDone}`);
console.log(`  to change:                ${pending.length}\n`);

if (pending.length === 0) {
  console.log("Nothing to do.");
  await prisma.$disconnect();
  process.exit(0);
}

for (const r of pending) {
  console.log(`  ${r.id}`);
  console.log(`    from: ${r.agentEmail ?? "(null)"}`);
  console.log(`    to:   ${r.workspaceEmail}`);
}

if (!APPLY) {
  console.log(`\nDry run — nothing written. Re-run with --apply to make these ${pending.length} change(s).`);
  await prisma.$disconnect();
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupPath = process.env.MIGRATION_BACKUP_PATH || `agent-email-backup-${stamp}.json`;
writeFileSync(
  backupPath,
  JSON.stringify(
    pending.map((r) => ({
      id: r.id,
      previousAgentEmail: r.agentEmail,
      newAgentEmail: r.workspaceEmail,
      agentEmailInboxId: r.agentEmailInboxId,
    })),
    null,
    2,
  ),
);
console.log(`\nBackup of previous values written to ${backupPath}`);

let changed = 0;
for (const r of pending) {
  await prisma.deployment.update({
    where: { id: r.id },
    data: { agentEmail: r.workspaceEmail },
  });
  changed++;
}

console.log(`Updated ${changed} deployment(s).`);
console.log("Restart the provisioning service so recovered pollers pick up the new address.");
await prisma.$disconnect();
