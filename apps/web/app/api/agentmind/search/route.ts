import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { jsonSuccess, jsonError, parseSearchParams } from "@/lib/api-utils";
import {
  embedTexts,
  cosineSimilarity,
  tokenise,
  keywordScore,
  SIMILARITY_THRESHOLD,
} from "@/lib/agentmind-embedding";

const SELECT_FIELDS = {
  id: true,
  type: true,
  title: true,
  content: true,
  tags: true,
  usageCount: true,
  upvotes: true,
  downvotes: true,
  createdAt: true,
} as const;

const searchSchema = z.object({
  agentId: z.string().min(1),
  deploymentId: z.string().min(1),
  q: z.string().optional(),
  type: z
    .enum(["CORRECTION", "PATTERN", "RESPONSE_TEMPLATE", "TASK_RECIPE"])
    .optional(),
  limit: z.string().optional(),
});

export async function GET(request: NextRequest) {
  const parsed = parseSearchParams(request.url, searchSchema);
  if ("error" in parsed) return parsed.error;
  const { data: params } = parsed;

  // Validate deployment exists
  const deployment = await prisma.deployment.findUnique({
    where: { id: params.deploymentId },
  });
  if (!deployment) {
    return jsonError("Deployment not found", 404);
  }

  // Reciprocity: only contributing deployments can search
  const ac = (deployment.autonomyConfig ?? {}) as Record<string, unknown>;
  if (ac.agentMindEnabled === false) {
    return jsonSuccess({ contributions: [] });
  }

  const limit = Math.min(50, Math.max(1, parseInt(params.limit ?? "10", 10)));

  const where: Record<string, unknown> = {
    agentId: params.agentId,
    status: "APPROVED",
    // Lessons this buyer has silenced for their own agent. AgentMind is shared
    // across every deployment of an agent, so a lesson written by one buyer
    // reaches all of them; deleting is rightly company-scoped, which left a
    // buyer harmed by somebody else's lesson with no remedy but switching the
    // whole commons off. Muting is that remedy, and it stops here.
    mutes: { none: { deploymentId: params.deploymentId } },
  };

  if (params.type) {
    where.type = params.type;
  }

  const query = (params.q ?? "").trim();

  // No query: browse the most-used, as before.
  if (!query) {
    const browsed = await prisma.knowledgeContribution.findMany({
      where,
      select: SELECT_FIELDS,
      orderBy: { usageCount: "desc" },
      take: limit,
    });
    return jsonSuccess({ contributions: browsed });
  }

  // Rank the agent's approved lessons against the query.
  //
  // This used to be a single Prisma `contains` on the whole query string, so the
  // entire email subject had to appear verbatim inside a lesson. It never did:
  // retrieval had never once fired in production, and every usageCount was zero.
  // The pairs that matter share meaning rather than words — "Can you share a file
  // with an outside partner?" and "External file sharing policy" have no word in
  // common — so this is a semantic comparison, with keyword matching kept only as
  // the degraded path.
  const candidates = await prisma.knowledgeContribution.findMany({
    where,
    select: { ...SELECT_FIELDS, embedding: true },
    // Deliberately not ordered by usageCount. That number counts injections, so
    // ordering by it made a lesson that fires often rank higher, get injected
    // more, and count higher still — a ratchet that promoted the most harmful
    // lesson in the corpus to eleven uses. Semantic score decides the ranking
    // below; usage only breaks ties.
    orderBy: { createdAt: "desc" },
    // The corpus is small and scoped to one agent; take enough to rank well
    // without unbounded reads if it ever grows.
    take: 500,
  });

  if (candidates.length === 0) return jsonSuccess({ contributions: [] });

  const [queryVector] = (await embedTexts([query])) ?? [];
  const scored: { row: (typeof candidates)[number]; score: number }[] = [];

  if (queryVector?.length) {
    for (const row of candidates) {
      const score = cosineSimilarity(queryVector, row.embedding ?? []);
      if (score >= SIMILARITY_THRESHOLD) scored.push({ row, score });
    }
  } else {
    // Embeddings unavailable, or nothing has been embedded yet. Fall back to
    // terms, requiring two or more so one common word cannot pull in everything.
    const tokens = tokenise(query);
    for (const row of candidates) {
      const hits = keywordScore(tokens, row);
      if (hits >= 2) scored.push({ row, score: hits });
    }
  }

  const contributions = scored
    .sort((a, b) => b.score - a.score || b.row.usageCount - a.row.usageCount)
    .slice(0, limit)
    .map(({ row }) => {
      const { embedding: _embedding, ...rest } = row as Record<string, unknown>;
      return rest;
    });

  // NOTE: usageCount is NOT incremented here — search is just browsing.
  // Agents call POST /api/agentmind/use with the IDs they actually
  // incorporated into a response, which increments usageCount + auto-upvotes.

  return jsonSuccess({ contributions });
}
