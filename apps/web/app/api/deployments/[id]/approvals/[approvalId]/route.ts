import { prisma } from "@/lib/db";
import { jsonError, jsonSuccess, requireOrg, requireDeploymentAccess } from "@/lib/api-utils";
import { agentTokenMatches } from "@/lib/agent-token";
import { resolveApprovalAndUpdateTrust } from "@/lib/resolve-approval";

/**
 * PATCH handler for agent-originated approval resolution.
 * Called by the agentmail-tools plugin's resolve_approval tool.
 *
 * "Internal agent-to-marketplace call" used to mean no check at all, which made
 * this the one place the human-in-the-loop guarantee could be bypassed: approving
 * an action needed only a deployment id and an approval id, both of which travel
 * in the notification emails this system sends. An unauthenticated PATCH from a
 * shell reached the database lookup and returned "Approval not found" — proof the
 * handler ran, and that a *valid* id would have resolved the approval.
 *
 * Now it takes the same two-caller shape as the allowlist route: the platform and
 * its containers present the derived token, and a human is authorised through
 * their org like every other deployment route.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; approvalId: string }> },
) {
  const { id: deploymentId, approvalId } = await params;

  const presented = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const secret = process.env.PROVISIONING_SECRET ?? "";
  const isPlatformCaller =
    (!!secret && presented === secret) || agentTokenMatches(presented, deploymentId, secret);

  if (!isPlatformCaller) {
    const orgResult = await requireOrg();
    if ("error" in orgResult) return orgResult.error;
    const access = await requireDeploymentAccess(deploymentId, orgResult.company.id);
    if ("error" in access) return access.error;
  }

  const approval = await prisma.approval.findFirst({
    where: { id: approvalId, deploymentId },
  });

  if (!approval) {
    return jsonError("Approval not found", 404);
  }

  if (approval.status !== "PENDING") {
    return jsonError("Approval already resolved", 409);
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return jsonError("Invalid JSON body", 400);
  }

  const { status, note } = body as Record<string, unknown>;
  const statusStr = String(status || "").toUpperCase();

  const actionMap: Record<string, "APPROVED" | "EDITED" | "REJECTED"> = {
    APPROVED: "APPROVED",
    REJECTED: "REJECTED",
    EDITED: "EDITED",
  };
  const mappedAction = actionMap[statusStr];
  if (!mappedAction) {
    return jsonError("status must be approved, rejected, or edited", 400);
  }

  const result = await resolveApprovalAndUpdateTrust({
    approvalId,
    deploymentId,
    action: mappedAction,
    resolvedBy: "agent",
    editedText: mappedAction === "EDITED" ? String(note || "") : undefined,
    rejectionReason:
      mappedAction === "REJECTED" ? String(note || "") : undefined,
  });

  return jsonSuccess(result);
}
