import { prisma } from "@/lib/db";
import { requireDeploymentToken } from "@/lib/deployment-token";
import { jsonSuccess, jsonError, requireOrg, requireDeploymentAccess } from "@/lib/api-utils";
import { sendNotificationEmail, buildApprovalNotificationEmail } from "@/lib/email";
import { approvalActionUrl } from "@/lib/approval-link";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const url = new URL(request.url);
  const threadId = url.searchParams.get("threadId");
  const statusFilter = url.searchParams.get("status");

  // Internal poller path: the deployment's own token, not a person's session.
  //
  // This branch had no auth at all, on the reasoning that it returns only
  // PENDING approvals for one thread. But an approval carries the draft, which
  // is the text the agent is about to send, and neither identifier gating it is
  // a secret: a deployment id appears in dashboard URLs and a thread id in every
  // email header on the thread. Read from outside the network on 2026-08-18, it
  // returned a workbook's name, what was in it, and who it was for.
  if (threadId && statusFilter === "PENDING") {
    const authed = await requireDeploymentToken(request, id);
    if ("error" in authed) return authed.error;

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
      workspaceEmail: true,
      managerEmail: true,
      portalToken: true,
      buyerMicrosoftTenantId: true,
      teamsServiceUrl: true,
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

  // Awaited, for the same reason the Teams card below is: this runs on Vercel,
  // where work still in flight when the handler returns is killed with the
  // function. Left unawaited, whether the buyer heard about an approval came
  // down to whether the send happened to win a race against the response — it
  // delivered sometimes and silently vanished other times. sendNotificationEmail
  // never throws, so waiting on it cannot fail the approval itself.
  if (deployment.managerEmail) {
    // Approvals are created by a server-to-server POST from the agent container,
    // which sends no Origin header — so this fell back to "" and produced a
    // relative href that no mail client can follow. The configured app URL is the
    // only reliable base here.
    const baseUrl = (
      request.headers.get("origin") || process.env.NEXT_PUBLIC_APP_URL || ""
    ).replace(/\/$/, "");
    const portalUrl =
      baseUrl && deployment.portalToken
        ? `${baseUrl}/approve/${deployment.portalToken}`
        : null;
    const { subject, html } = buildApprovalNotificationEmail({
      approveUrl: baseUrl ? approvalActionUrl(baseUrl, approval.id, "approve") : null,
      rejectUrl: baseUrl ? approvalActionUrl(baseUrl, approval.id, "reject") : null,
      agentName: deployment.agentName,
      taskType: String(taskType || "unknown"),
      draftPreview: String(draft || ""),
      portalUrl,
    });
    await sendNotificationEmail({
      // Sent from the agent's own mailbox, so a reply lands somewhere the poller
      // is watching. The decision itself is made by the buttons above; the poller
      // only needs to see the reply in order to answer it.
      deploymentId: deployment.id,
      agentEmail: deployment.workspaceEmail,
      inboxId: deployment.agentEmailInboxId,
      to: deployment.managerEmail,
      subject,
      html,
    });
  }

  // Send Teams approval card to manager (awaited so Vercel doesn't kill the function early)
  if (deployment.buyerMicrosoftTenantId && deployment.teamsServiceUrl && deployment.managerEmail) {
    const provisioningUrl = process.env.PROVISIONING_SERVICE_URL || "https://api.agentstore.it.com";
    const provisioningSecret = process.env.PROVISIONING_SECRET;
    console.log(`[approvals] Teams notify check: tenantId=${deployment.buyerMicrosoftTenantId}, serviceUrl=${!!deployment.teamsServiceUrl}, managerEmail=${deployment.managerEmail}, provisioningUrl=${provisioningUrl}, hasSecret=${!!provisioningSecret}`);
    if (provisioningSecret) {
      try {
        const notifyResp = await fetch(`${provisioningUrl}/internal/teams-approval-notify`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${provisioningSecret}`,
          },
          body: JSON.stringify({
            managerEmail: deployment.managerEmail,
            tenantId: deployment.buyerMicrosoftTenantId,
            serviceUrl: deployment.teamsServiceUrl,
            agentName: deployment.agentName,
            taskType: String(taskType || "unknown"),
            draftPreview: String(draft || "").slice(0, 1000),
            approvalId: approval.id,
            portalToken: deployment.portalToken,
          }),
        });
        if (notifyResp.ok) {
          console.log(`[approvals] Teams approval card sent for ${approval.id}`);
        } else {
          const t = await notifyResp.text();
          console.warn(`[approvals] Teams approval notify failed: ${notifyResp.status} ${t}`);
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[approvals] Teams approval notify request failed: ${message}`);
      }
    }
  }

  return jsonSuccess({ approval: { id: approval.id, status: approval.status } }, 201);
}
