/**
 * One-off: give existing AgentMind contributions their search vectors.
 *
 * Contributions written before semantic search have no embedding, so they only
 * reachable through the keyword fallback. This embeds them in place.
 *
 * Idempotent — only touches rows with no vector, so it is safe to re-run after
 * adding more, and safe to run against a database someone else is writing to.
 *
 * Usage (from the provisioning host, which holds both DATABASE_URL and the
 * embedding service):
 *   set -a; . /opt/marketplace/.env.prod; set +a
 *   npx tsx scripts/backfill-agentmind-embeddings.ts
 */
import { prisma } from "@marketplace/db";
import { embedTexts } from "../apps/provisioning-service/src/embedding.js";

async function main() {
  const pending = await prisma.knowledgeContribution.findMany({
    where: { embeddedAt: null },
    select: { id: true, title: true, content: true },
  });

  if (pending.length === 0) {
    console.log("Nothing to backfill — every contribution already has a vector.");
    return;
  }

  console.log(`Embedding ${pending.length} contribution(s)…`);
  const vectors = await embedTexts(pending.map((c) => `${c.title}\n${c.content}`));

  let done = 0;
  for (let i = 0; i < pending.length; i++) {
    const vector = vectors[i];
    if (!vector?.length) {
      console.warn(`  skipped ${pending[i].id} — empty vector`);
      continue;
    }
    await prisma.knowledgeContribution.update({
      where: { id: pending[i].id },
      data: { embedding: vector, embeddedAt: new Date() },
    });
    done++;
    console.log(`  ${pending[i].title.slice(0, 56)}  (${vector.length}d)`);
  }

  console.log(`Done: ${done}/${pending.length} embedded.`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
