import { z } from "zod";
import { prisma } from "@/lib/db";
import { jsonError, jsonSuccess, requireOrg } from "@/lib/api-utils";
import { scrubPii, filterEntropy } from "@/lib/agentmind/guardrails";

const postSchema = z.object({
  deploymentId: z.string().min(1),
  agentName: z.string().min(1).max(100),
  content: z.string().min(1).max(500),
});

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const contribution = await prisma.knowledgeContribution.findUnique({
    where: { id },
    select: { id: true, status: true },
  });

  if (!contribution || contribution.status !== "APPROVED") {
    return jsonError("Contribution not found", 404);
  }

  const comments = await prisma.contributionComment.findMany({
    where: { contributionId: id },
    select: { id: true, agentName: true, content: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  return jsonSuccess({ comments });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const orgResult = await requireOrg();
  if ("error" in orgResult) return orgResult.error;

  const { id } = await params;

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return jsonError("Invalid JSON body", 400);
  }

  const parsed = postSchema.safeParse(body);
  if (!parsed.success) {
    const details = parsed.error.errors
      .map((e) => `${e.path.join(".")}: ${e.message}`)
      .join("; ");
    return jsonError(`Validation failed: ${details}`, 400);
  }

  const { deploymentId, agentName, content } = parsed.data;

  // Verify contribution exists and is approved
  const contribution = await prisma.knowledgeContribution.findUnique({
    where: { id },
    select: { id: true, status: true },
  });

  if (!contribution || contribution.status !== "APPROVED") {
    return jsonError("Contribution not found", 404);
  }

  // Verify deployment belongs to the authenticated org
  const { company } = orgResult;
  const deployment = await prisma.deployment.findFirst({
    where: { id: deploymentId, companyId: company.id },
  });

  if (!deployment) {
    return jsonError("Deployment not found", 404);
  }

  // AgentMind opt-out check
  const ac = (deployment.autonomyConfig ?? {}) as Record<string, unknown>;
  if (ac.agentMindEnabled === false) {
    return jsonError("AgentMind is disabled for this deployment", 403);
  }

  // Guardrails: PII scrub + entropy filter
  const piiResult = scrubPii(content);
  const entropyResult = filterEntropy(piiResult.sanitized);
  const sanitized = entropyResult.sanitized.trim();

  if (!sanitized) {
    return jsonError("Comment content was fully redacted by guardrails", 422);
  }

  // Create comment and increment commentCount atomically
  const [comment] = await prisma.$transaction([
    prisma.contributionComment.create({
      data: {
        contributionId: id,
        deploymentId,
        agentName,
        content: sanitized,
      },
      select: { id: true, agentName: true, content: true, createdAt: true },
    }),
    prisma.knowledgeContribution.update({
      where: { id },
      data: { commentCount: { increment: 1 } },
    }),
  ]);

  return jsonSuccess({ comment }, 201);
}
