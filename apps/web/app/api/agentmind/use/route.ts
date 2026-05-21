import { prisma } from "@/lib/db";
import { jsonError, jsonSuccess } from "@/lib/api-utils";
import { z } from "zod";

const bodySchema = z.object({
  deploymentId: z.string().min(1),
  contributionIds: z.array(z.string().min(1)).min(1).max(10),
});

/**
 * POST /api/agentmind/use
 *
 * Called by agents after they incorporate AgentMind knowledge into a response.
 * For each contribution the agent actually used:
 *   1. Increments usageCount (tracks real usage, not just search impressions)
 *   2. Auto-upvotes (one vote per deployment per contribution, idempotent)
 *
 * This separates "searched" from "used" — search returns many results,
 * but only the ones the agent actually incorporated get the value signal.
 */
export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return jsonError("Invalid JSON body", 400);
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return jsonError(
      "Invalid request: deploymentId and contributionIds[] required",
      400,
    );
  }

  const { deploymentId, contributionIds } = parsed.data;

  // Validate deployment exists
  const deployment = await prisma.deployment.findUnique({
    where: { id: deploymentId },
  });
  if (!deployment) {
    return jsonError("Deployment not found", 404);
  }

  const ac = (deployment.autonomyConfig ?? {}) as Record<string, unknown>;
  if (ac.agentMindEnabled === false) {
    return jsonError("AgentMind is disabled for this deployment", 403);
  }

  // Process each contribution: increment usage + auto-upvote
  const results: { id: string; voted: boolean }[] = [];

  for (const contributionId of contributionIds) {
    const contribution = await prisma.knowledgeContribution.findUnique({
      where: { id: contributionId },
    });
    if (!contribution || contribution.status !== "APPROVED") {
      continue; // Skip missing or non-approved contributions silently
    }

    // Increment usage count
    await prisma.knowledgeContribution.update({
      where: { id: contributionId },
      data: { usageCount: { increment: 1 } },
    });

    // Auto-upvote (idempotent — won't double-vote if already upvoted)
    const existing = await prisma.knowledgeVote.findUnique({
      where: {
        contributionId_deploymentId: { contributionId, deploymentId },
      },
    });

    if (!existing) {
      // First interaction — create upvote
      await prisma.$transaction([
        prisma.knowledgeVote.create({
          data: { contributionId, deploymentId, vote: 1 },
        }),
        prisma.knowledgeContribution.update({
          where: { id: contributionId },
          data: { upvotes: { increment: 1 } },
        }),
      ]);
      results.push({ id: contributionId, voted: true });
    } else if (existing.vote === -1) {
      // Previously downvoted — flip to upvote
      await prisma.$transaction([
        prisma.knowledgeVote.update({
          where: { id: existing.id },
          data: { vote: 1 },
        }),
        prisma.knowledgeContribution.update({
          where: { id: contributionId },
          data: { upvotes: { increment: 1 }, downvotes: { increment: -1 } },
        }),
      ]);
      results.push({ id: contributionId, voted: true });
    } else {
      // Already upvoted — idempotent
      results.push({ id: contributionId, voted: false });
    }
  }

  return jsonSuccess({ used: results.length, results });
}
