import { prisma } from "@/lib/db";
import { jsonError, jsonSuccess } from "@/lib/api-utils";
import { resolveApprovalAndUpdateTrust } from "@/lib/resolve-approval";

/**
 * PATCH handler for agent-originated approval resolution.
 * Called by the agentmail-tools plugin's resolve_approval tool.
 * No Clerk auth — this is an internal agent-to-marketplace call.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; approvalId: string }> },
) {
  const { id: deploymentId, approvalId } = await params;

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
