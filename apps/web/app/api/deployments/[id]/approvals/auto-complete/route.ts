import { prisma } from "@/lib/db";
import { jsonError, jsonSuccess } from "@/lib/api-utils";
import { z } from "zod";

/**
 * POST /api/deployments/[id]/approvals/auto-complete
 *
 * Internal-only endpoint called by the adapter when it auto-approves an action
 * (policy=external-only and recipient is the manager, or policy=never).
 *
 * Creates an Approval record already in APPROVED status so that:
 *   1. There is a proper audit trail for every email the agent sends.
 *   2. The AgentMind "must have at least one resolved approval" gate is satisfied
 *      after the very first successful task — even if the user never went through
 *      the manual approval UI.
 *
 * Auth: Bearer <deployment.approvalWebhookToken>  (same token used by adapter)
 * No Clerk auth required — this is an internal adapter → marketplace call.
 */

const bodySchema = z.object({
  taskType: z.string().min(1),
  draft: z.string().min(1),
  originalRequest: z.string().default(""),
  reasoning: z.string().default("Auto-approved by platform policy"),
  threadId: z.string().optional(),
  stakesScore: z.number().min(0).max(10).default(2),
  ambiguityScore: z.number().min(0).max(10).default(2),
  reversibilityScore: z.number().min(0).max(10).default(2),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: deploymentId } = await params;

  // Auth: validate approvalWebhookToken
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return jsonError("Missing authorization", 401);
  }
  const token = authHeader.slice(7);

  const deployment = await prisma.deployment.findUnique({
    where: { id: deploymentId },
    select: { id: true, approvalWebhookToken: true, status: true },
  });

  if (!deployment) {
    return jsonError("Deployment not found", 404);
  }

  if (deployment.approvalWebhookToken !== token) {
    return jsonError("Invalid token", 403);
  }

  if (deployment.status === "FIRED" || deployment.status === "PAUSED") {
    return jsonError("Deployment is not active", 409);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON", 400);
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return jsonError(
      `Validation failed: ${parsed.error.errors.map((e) => e.message).join(", ")}`,
      400,
    );
  }

  const d = parsed.data;
  const combinedScore =
    d.stakesScore * 0.5 + d.ambiguityScore * 0.3 + d.reversibilityScore * 0.2;
  const now = new Date();

  const approval = await prisma.approval.create({
    data: {
      deploymentId,
      taskType: d.taskType,
      channel: "email",
      draft: d.draft,
      reasoning: d.reasoning,
      originalRequest: d.originalRequest,
      stakesScore: d.stakesScore,
      ambiguityScore: d.ambiguityScore,
      reversibilityScore: d.reversibilityScore,
      combinedScore,
      threadId: d.threadId ?? null,
      status: "APPROVED",
      resolvedBy: "auto-policy",
      resolvedAt: now,
      // expiresAt is required by schema — set to now since it's already resolved
      expiresAt: now,
    },
  });

  return jsonSuccess({ approval: { id: approval.id, status: approval.status } }, 201);
}
