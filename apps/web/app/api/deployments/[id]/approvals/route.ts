import { prisma } from "@/lib/db";
import { jsonSuccess, jsonError, requireOrg, requireDeploymentAccess } from "@/lib/api-utils";
import { sendNotificationEmail, buildApprovalNotificationEmail } from "@/lib/email";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const url = new URL(request.url);
  const threadId = url.searchParams.get("threadId");
  const statusFilter = url.searchParams.get("status");

  // Internal poller path: no auth, only returns PENDING approvals for a specific threadId
  if (threadId && statusFilter === "PENDING") {
    const deployment = await prisma.deployment.findUnique({
      where: { id },
    });
    if (!deployment) {
      return jsonError("Deployment not found", 404);
    }

    const approvals = await prisma.approval.findMany({
      where: {
        deploymentId: id,
        status: "PENDING",
        threadId,
      },
      select: {
        id: true,
        taskType: true,
        draft: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    });

    return jsonSuccess(approvals);
  }

  // Authenticated dashboard path: returns all approvals
  const orgResult = await requireOrg();
  if ("error" in orgResult) return orgResult.error;
  const { company } = orgResult;

  const depResult = await requireDeploymentAccess(id, company.id);
  if ("error" in depResult) return depResult.error;

  const approvals = await prisma.approval.findMany({
    where: { deploymentId: id },
    orderBy: { createdAt: "desc" },
  });

  return jsonSuccess(approvals);
}

/**
 * POST handler for agent-originated approval requests.
 * Called by the agentmail-tools plugin's queue_approval tool.
 * No Clerk auth — this is an internal agent-to-marketplace call.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: deploymentId } = await params;

  // Verify deployment exists
  const deployment = await prisma.deployment.findUnique({
    where: { id: deploymentId },
    select: {
      id: true,
      status: true,
      agentName: true,
      agentEmailInboxId: true,
      weeklyDigestEmail: true,
      portalToken: true,
    },
  });
  if (!deployment) {
    return jsonError("Deployment not found", 404);
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return jsonError("Invalid JSON body", 400);
  }

  const {
    taskType,
    draft,
    reasoning,
    threadId,
    fromEmail,
    subject,
    originalRequest,
    // Preferred: adapter sends all four scores explicitly
    stakesScore,
    ambiguityScore,
    reversibilityScore,
    combinedScore,
    // Legacy fallback: older callers only sent a single riskScore
    riskScore,
  } = body as Record<string, unknown>;

  const stakes = Number(stakesScore ?? riskScore ?? 0) || 0;
  const ambiguity = Number(ambiguityScore ?? 0) || 0;
  const reversibility = Number(reversibilityScore ?? 0) || 0;
  const combined =
    Number(combinedScore ?? 0) ||
    (stakes + ambiguity + reversibility) / 3 ||
    0;

  const approval = await prisma.approval.create({
    data: {
      deploymentId,
      taskType: String(taskType || "unknown"),
      channel: "email",
      draft: String(draft || ""),
      reasoning: String(reasoning || ""),
      originalRequest: originalRequest
        ? String(originalRequest)
        : subject
          ? `From: ${fromEmail || "agent"} — ${subject}`
          : String(fromEmail || ""),
      stakesScore: stakes,
      ambiguityScore: ambiguity,
      reversibilityScore: reversibility,
      combinedScore: combined,
      threadId: threadId ? String(threadId) : null,
      expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000), // 48h
    },
  });

  // Send email notification (fire-and-forget)
  if (deployment.weeklyDigestEmail) {
    const portalUrl = deployment.portalToken
      ? `${request.headers.get("origin") || ""}/approve/${deployment.portalToken}`
      : null;
    const { subject, html } = buildApprovalNotificationEmail({
      agentName: deployment.agentName,
      taskType: String(taskType || "unknown"),
      draftPreview: String(draft || ""),
      portalUrl,
    });
    sendNotificationEmail({
      inboxId: deployment.agentEmailInboxId,
      to: deployment.weeklyDigestEmail,
      subject,
      html,
    });
  }

  return jsonSuccess({ approval: { id: approval.id, status: approval.status } }, 201);
}
