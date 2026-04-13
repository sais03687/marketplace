import { z } from "zod";
import { prisma } from "@/lib/db";
import {
  jsonError,
  jsonSuccess,
  parseBody,
  requireOrg,
  requireDeploymentAccess,
} from "@/lib/api-utils";
import { resolveApprovalAndUpdateTrust } from "@/lib/resolve-approval";

const resolveSchema = z.object({
  action: z.enum(["APPROVED", "EDITED", "REJECTED"]),
  editedText: z.string().optional(),
  rejectionReason: z.string().optional(),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; approvalId: string }> },
) {
  const { id, approvalId } = await params;

  const orgResult = await requireOrg();
  if ("error" in orgResult) return orgResult.error;
  const { userId, company } = orgResult;

  const depResult = await requireDeploymentAccess(id, company.id);
  if ("error" in depResult) return depResult.error;

  const parsed = await parseBody(request, resolveSchema);
  if ("error" in parsed) return parsed.error;
  const { data } = parsed;

  const approval = await prisma.approval.findFirst({
    where: { id: approvalId, deploymentId: id },
  });

  if (!approval) {
    return jsonError("Approval not found", 404);
  }

  if (approval.status !== "PENDING") {
    return jsonError("Approval already resolved", 409);
  }

  const origin =
    request.headers.get("origin") ||
    request.headers.get("referer")?.replace(/\/[^/]*$/, "") ||
    "";
  const baseUrl = origin || `http://localhost:${process.env.PORT || 3002}`;

  const result = await resolveApprovalAndUpdateTrust({
    approvalId,
    deploymentId: id,
    action: data.action,
    resolvedBy: userId,
    editedText: data.editedText,
    rejectionReason: data.rejectionReason,
    baseUrl,
  });

  return jsonSuccess(result);
}
