import { prisma } from "@/lib/db";
import { requireDeploymentToken } from "@/lib/deployment-token";
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

  // Auth: the deployment's own token, compared in constant time.
  //
  // This did the same check with `!==`, which leaks a secret's prefix through
  // timing one byte at a time — while approval-link.ts next door has always
  // used timingSafeEqual for exactly that reason. Shared with the AgentMind
  // routes now, so there is one comparison to get right.
  const authed = await requireDeploymentToken(request, deploymentId);
  if ("error" in authed) return authed.error;
  const { deployment } = authed;

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
