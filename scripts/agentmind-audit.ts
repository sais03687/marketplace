/**
 * Audit the AgentMind corpus: clusters, unfounded claims, review dates.
 *
 * Read-only unless you pass --apply, which backfills `reviewDueAt` on approved
 * rows that predate it. Nothing here ever deletes: the point is to show a human
 * what has accumulated, and silently dropping a buyer's knowledge is worse than
 * a stale entry somebody can see.
 *
 *   tsx scripts/agentmind-audit.ts            # report only
 *   tsx scripts/agentmind-audit.ts --apply    # also backfill reviewDueAt
 *
 * Written after seven near-identical "do not attempt" lessons accumulated
 * unnoticed and taught the agent to refuse emailing its own manager. Detection
 * now runs at contribute time, but existing corpora were never checked.
 */
import { prisma } from "@marketplace/db";
import {
  cosineSimilarity,
  reviewDueDate,
  isFounded,
  CLUSTER_THRESHOLD,
} from "../apps/web/lib/agentmind-embedding";

const APPLY = process.argv.includes("--apply");

async function main() {
  const rows = await prisma.knowledgeContribution.findMany({
    where: { status: { in: ["APPROVED", "PENDING"] } },
    select: {
      id: true, agentId: true, title: true, type: true, status: true,
      context: true, embedding: true, usageCount: true, injectedCount: true,
      noActionCount: true, reviewDueAt: true, flagReason: true, createdAt: true,
    },
  });

  console.log(`${rows.length} contribution(s) in APPROVED or PENDING\n`);

  // ── Clusters ───────────────────────────────────────────────────────────────
  // Grouped per agent, since the commons is scoped to an agent type.
  const byAgent = new Map<string, typeof rows>();
  for (const r of rows) {
    if (!byAgent.has(r.agentId)) byAgent.set(r.agentId, []);
    byAgent.get(r.agentId)!.push(r);
  }

  console.log(`── Clusters (cosine >= ${CLUSTER_THRESHOLD}) ──`);
  let clustered = 0;
  for (const [agentId, group] of byAgent) {
    for (const row of group) {
      if (!row.embedding?.length) continue;
      const near = group
        .filter((o) => o.id !== row.id && o.embedding?.length)
        .map((o) => ({ title: o.title, score: cosineSimilarity(row.embedding, o.embedding) }))
        .filter((o) => o.score >= CLUSTER_THRESHOLD)
        .sort((a, b) => b.score - a.score);
      if (near.length >= 2) {
        clustered++;
        console.log(`  ${agentId.slice(0, 8)}  "${row.title}"  ${near.length} neighbours`);
        for (const n of near.slice(0, 3)) {
          console.log(`      ${n.score.toFixed(3)}  ${n.title}`);
        }
      }
    }
  }
  if (!clustered) console.log("  none");

  // ── Unfounded ──────────────────────────────────────────────────────────────
  // Rows whose provenance shows no action was attempted. Older rows recorded
  // only the task type as context and cannot be judged — reported separately
  // rather than lumped in, since "unknown" is not "unfounded".
  console.log(`\n── Unfounded (no "Triggered by:" in provenance) ──`);
  const unknown: string[] = [];
  let unfounded = 0;
  for (const r of rows) {
    const ctx = r.context ?? "";
    if (!ctx || !ctx.includes("Request:")) { unknown.push(r.title); continue; }
    if (!isFounded(ctx)) {
      unfounded++;
      console.log(`  ${r.status.padEnd(9)} ${r.title}`);
    }
  }
  if (!unfounded) console.log("  none");
  if (unknown.length) {
    console.log(`\n  ${unknown.length} row(s) predate provenance and cannot be judged:`);
    for (const t of unknown.slice(0, 10)) console.log(`      ${t}`);
  }

  // ── Suppression by outcome ─────────────────────────────────────────────────
  console.log(`\n── Injected but followed by no action ──`);
  const suspects = rows
    .filter((r) => r.injectedCount >= 3 && r.noActionCount / r.injectedCount >= 0.5)
    .sort((a, b) => b.noActionCount - a.noActionCount);
  if (!suspects.length) {
    console.log("  none (needs injectedCount >= 3 before a ratio means anything)");
  }
  for (const r of suspects) {
    const pct = ((r.noActionCount / r.injectedCount) * 100).toFixed(0);
    console.log(`  ${r.noActionCount}/${r.injectedCount} (${pct}%)  ${r.title}`);
  }

  // ── Review dates ───────────────────────────────────────────────────────────
  const now = new Date();
  const missing = rows.filter((r) => r.status === "APPROVED" && !r.reviewDueAt);
  const overdue = rows.filter((r) => r.reviewDueAt && r.reviewDueAt < now);
  console.log(`\n── Review dates ──`);
  console.log(`  ${missing.length} approved row(s) with no reviewDueAt`);
  console.log(`  ${overdue.length} row(s) past due`);
  for (const r of overdue.slice(0, 10)) {
    console.log(`      due ${r.reviewDueAt!.toISOString().slice(0, 10)}  ${r.title}`);
  }

  if (APPLY && missing.length) {
    for (const r of missing) {
      await prisma.knowledgeContribution.update({
        where: { id: r.id },
        // Dated from creation, not from now, so a lesson written months ago is
        // due immediately rather than getting a fresh lease it has not earned.
        data: { reviewDueAt: reviewDueDate(r.type, r.createdAt) },
      });
    }
    console.log(`\n  backfilled reviewDueAt on ${missing.length} row(s)`);
  } else if (missing.length) {
    console.log(`  (re-run with --apply to backfill)`);
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
