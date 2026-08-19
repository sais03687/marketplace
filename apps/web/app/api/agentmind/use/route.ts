import { prisma } from "@/lib/db";
import { requireDeploymentToken } from "@/lib/deployment-token";
import { jsonError, jsonSuccess } from "@/lib/api-utils";
import { z } from "zod";

const bodySchema = z.object({
  deploymentId: z.string().min(1),
  contributionIds: z.array(z.string().min(1)).min(1).max(10),
  // What the run that received this knowledge went on to do. Absent from the
  // poller's call, which fires at forward time before any outcome exists; sent
  // by the adapter once the run finishes.
  outcome: z.enum(["acted", "no_action"]).optional(),
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

  const { deploymentId, contributionIds, outcome } = parsed.data;

  // Validate deployment exists
  // Authenticated as the deployment it claims to be, not merely naming
  // one. This checked existence only, so an unauthenticated caller could
  // act as any active deployment - and what AgentMind does with that is
  // hand it to every other company's agent.
  const authed = await requireDeploymentToken(request, deploymentId);
  if ("error" in authed) return authed.error;
  const { deployment } = authed;

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

    // Two callers, two different events, deliberately not merged.
    //
    // The poller calls this with no outcome when it forwards knowledge — that is
    // the injection, and it is all usageCount has ever measured, despite the name
    // suggesting the agent found it useful. The adapter calls back afterwards
    // with the outcome, and that call must not re-count the injection.
    if (outcome) {
      // A lesson repeatedly followed by the agent doing nothing is suppressing
      // work rather than helping. That is the fingerprint of the seven "do not
      // attempt" lessons which made the agent refuse to email its own manager:
      // each was injected, each produced a reply and no action, and nothing
      // anywhere noticed until a human read the reasoning by hand.
      if (outcome === "no_action") {
        await prisma.knowledgeContribution.update({
          where: { id: contributionId },
          data: { noActionCount: { increment: 1 } },
        });
      }
      results.push({ id: contributionId, voted: false });
      continue;
    }

    await prisma.knowledgeContribution.update({
      where: { id: contributionId },
      data: {
        usageCount: { increment: 1 },
        injectedCount: { increment: 1 },
        lastUsedAt: new Date(),
      },
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
