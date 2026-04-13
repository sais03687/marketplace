import { prisma } from "@/lib/db";
import { jsonError, jsonSuccess } from "@/lib/api-utils";
import { resolveApprovalAndUpdateTrust } from "@/lib/resolve-approval";
import { z } from "zod";

const resolveSchema = z.object({
  action: z.enum(["APPROVED", "EDITED", "REJECTED"]),
  editedText: z.string().optional(),
  rejectionReason: z.string().optional(),
});

export async function POST(
  request: Request,
  {
    params,
  }: { params: Promise<{ token: string; approvalId: string }> },
) {
  const { token, approvalId } = await params;

  // Authenticate via portal token
  const deployment = await prisma.deployment.findUnique({
    where: { portalToken: token },
  });

  if (!deployment) {
    return jsonError("Invalid portal link", 404);
  }

  // Check approval exists and is pending
  const approval = await prisma.approval.findFirst({
    where: { id: approvalId, deploymentId: deployment.id },
  });

  if (!approval) {
    return jsonError("Approval not found", 404);
  }

  if (approval.status !== "PENDING") {
    return jsonError("Approval already resolved", 409);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON", 400);
  }

  const parsed = resolveSchema.safeParse(body);
  if (!parsed.success) {
    return jsonError(
      `Validation failed: ${parsed.error.errors.map((e) => e.message).join(", ")}`,
      400,
    );
  }

  const { action, editedText, rejectionReason } = parsed.data;

  const result = await resolveApprovalAndUpdateTrust({
    approvalId,
    deploymentId: deployment.id,
    action,
    resolvedBy: `portal:${token.slice(0, 8)}`,
    editedText,
    rejectionReason,
  });

  return jsonSuccess(result);
}
