import { prisma } from "@/lib/db";
import { jsonError, jsonSuccess } from "@/lib/api-utils";
import { runGuardrails, contributionInputSchema } from "@/lib/agentmind/guardrails";
import { z } from "zod";

const bodySchema = z.object({
  deploymentId: z.string().min(1),
  type: z.enum(["CORRECTION", "PATTERN", "RESPONSE_TEMPLATE", "TASK_RECIPE"]),
  title: z.string().min(1).max(200),
  content: z.string().min(1).max(10000),
  context: z.string().max(5000).optional(),
  tags: z.array(z.string().min(1).max(50)).min(1).max(10),
});

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return jsonError("Invalid JSON body", 400);
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    const details = parsed.error.errors
      .map((e) => `${e.path.join(".")}: ${e.message}`)
      .join("; ");
    return jsonError(`Validation failed: ${details}`, 400);
  }

  const { deploymentId, type, title, content, context, tags } = parsed.data;

  // Validate deployment exists and is active
  const deployment = await prisma.deployment.findUnique({
    where: { id: deploymentId },
  });
  if (!deployment) {
    return jsonError("Deployment not found", 404);
  }

  // Memory tier gate: only ACTIVE deployments with at least one resolved approval
  if (deployment.status !== "ACTIVE") {
    return jsonError("Only active deployments can contribute knowledge", 403);
  }

  const resolvedApproval = await prisma.approval.findFirst({
    where: {
      deploymentId,
      status: { in: ["APPROVED", "EDITED"] },
    },
  });
  if (!resolvedApproval) {
    return jsonError(
      "Deployment must have at least one resolved approval before contributing",
      403,
    );
  }

  // Duplicate detection: same agentId + type + title (case-insensitive)
  const existing = await prisma.knowledgeContribution.findFirst({
    where: {
      agentId: deployment.agentId,
      type,
      title: { equals: title, mode: "insensitive" },
    },
  });
  if (existing) {
    return jsonSuccess({ id: existing.id, status: existing.status, duplicate: true });
  }

  // Run guardrails
  const guardrailResult = runGuardrails({ title, content, type, tags, context });
  if (!guardrailResult.passed) {
    return jsonError(
      guardrailResult.rejectionReason || "Content rejected by guardrails",
      422,
    );
  }

  const contribution = await prisma.knowledgeContribution.create({
    data: {
      agentId: deployment.agentId,
      deploymentId,
      type,
      title,
      content: guardrailResult.sanitizedContent,
      rawContent: content,
      context: context || null,
      tags,
      sanitizationLog: guardrailResult.log,
    },
  });

  return jsonSuccess({ id: contribution.id, status: contribution.status }, 201);
}
