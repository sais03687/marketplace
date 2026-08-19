import { prisma } from "@/lib/db";
import { requireDeploymentToken } from "@/lib/deployment-token";
import { jsonError, jsonSuccess } from "@/lib/api-utils";
import { z } from "zod";

const bodySchema = z.object({
  deploymentId: z.string().min(1),
  contributionId: z.string().min(1),
  vote: z.union([z.literal(1), z.literal(-1)]),
});

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return jsonError("Invalid JSON body", 400);
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return jsonError("Invalid request: deploymentId, contributionId, and vote (1 or -1) required", 400);
  }

  const { deploymentId, contributionId, vote } = parsed.data;

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

  // Validate contribution exists and is approved
  const contribution = await prisma.knowledgeContribution.findUnique({
    where: { id: contributionId },
  });
  if (!contribution || contribution.status !== "APPROVED") {
    return jsonError("Contribution not found or not approved", 404);
  }

  // Upsert vote (one vote per deployment per contribution)
  const existing = await prisma.knowledgeVote.findUnique({
    where: {
      contributionId_deploymentId: { contributionId, deploymentId },
    },
  });

  if (existing) {
    if (existing.vote === vote) {
      return jsonSuccess({ message: "Vote unchanged" });
    }
    // Update vote and adjust counts
    await prisma.$transaction([
      prisma.knowledgeVote.update({
        where: { id: existing.id },
        data: { vote },
      }),
      prisma.knowledgeContribution.update({
        where: { id: contributionId },
        data: {
          upvotes: { increment: vote === 1 ? 1 : -1 },
          downvotes: { increment: vote === -1 ? 1 : -1 },
        },
      }),
    ]);
  } else {
    await prisma.$transaction([
      prisma.knowledgeVote.create({
        data: { contributionId, deploymentId, vote },
      }),
      prisma.knowledgeContribution.update({
        where: { id: contributionId },
        data: {
          upvotes: { increment: vote === 1 ? 1 : 0 },
          downvotes: { increment: vote === -1 ? 1 : 0 },
        },
      }),
    ]);
  }

  return jsonSuccess({ message: "Vote recorded" });
}
