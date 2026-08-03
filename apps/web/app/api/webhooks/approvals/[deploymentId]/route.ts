import { prisma } from "@/lib/db";
import { jsonError, jsonSuccess } from "@/lib/api-utils";
import { sendNotificationEmail, buildApprovalNotificationEmail } from "@/lib/email";
import { z } from "zod";

const approvalWebhookSchema = z.object({
  taskType: z.string().min(1),
  channel: z.string().min(1),
  draft: z.string().min(1),
  reasoning: z.string().min(1),
  originalRequest: z.string().min(1),
  stakesScore: z.number().min(0).max(10),
  ambiguityScore: z.number().min(0).max(10),
  reversibilityScore: z.number().min(0).max(10),
  threadId: z.string().optional(),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ deploymentId: string }> },
) {
  const { deploymentId } = await params;

  // Validate webhook token
  const authHeader = request.headers.get("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return jsonError("Missing authorization", 401);
  }
  const token = authHeader.slice(7);

  const deployment = await prisma.deployment.findUnique({
    where: { id: deploymentId },
    select: {
      id: true,
      approvalWebhookToken: true,
      status: true,
      agentName: true,
      agentEmailInboxId: true,
      // Needed to send the notification from the agent's own mailbox.
      workspaceEmail: true,
      managerEmail: true,
      portalToken: true,
    },
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

  const parsed = approvalWebhookSchema.safeParse(body);
  if (!parsed.success) {
    return jsonError(
      `Validation failed: ${parsed.error.errors.map((e) => e.message).join(", ")}`,
      400,
    );
  }

  const data = parsed.data;
  const combinedScore =
    data.stakesScore * 0.5 +
    data.ambiguityScore * 0.3 +
    data.reversibilityScore * 0.2;

  const approval = await prisma.approval.create({
    data: {
      deploymentId,
      taskType: data.taskType,
      channel: data.channel,
      draft: data.draft,
      reasoning: data.reasoning,
      originalRequest: data.originalRequest,
      stakesScore: data.stakesScore,
      ambiguityScore: data.ambiguityScore,
      reversibilityScore: data.reversibilityScore,
      combinedScore,
      threadId: data.threadId,
      expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
    },
  });

  // Send email notification (fire-and-forget)
  if (deployment.managerEmail) {
    const portalUrl = deployment.portalToken
      ? `${request.headers.get("origin") || ""}/approve/${deployment.portalToken}`
      : null;
    const { subject, html } = buildApprovalNotificationEmail({
      agentName: deployment.agentName,
      taskType: data.taskType,
      draftPreview: data.draft,
      portalUrl,
    });
    // Awaited: on Vercel an unawaited send is killed when the handler returns,
    // so the buyer's only warning that their agent is waiting would arrive or
    // not depending on a race. See the same fix in the approvals route.
    await sendNotificationEmail({
      deploymentId: deployment.id,
      agentEmail: (deployment as any).workspaceEmail,
      inboxId: deployment.agentEmailInboxId,
      to: deployment.managerEmail,
      subject,
      html,
    });
  }

  return jsonSuccess(approval, 201);
}
