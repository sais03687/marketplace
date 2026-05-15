import { z } from "zod";
import { prisma } from "@/lib/db";
import { jsonError, jsonSuccess, requireOrg } from "@/lib/api-utils";

const reviewSchema = z.object({
  decision: z.enum(["APPROVED", "REJECTED"]),
  note: z.string().max(1000).optional(),
});

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const orgResult = await requireOrg();
  if ("error" in orgResult) return orgResult.error;
  const { company } = orgResult;

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return jsonError("Invalid JSON body", 400);
  }

  const parsed = reviewSchema.safeParse(body);
  if (!parsed.success) {
    return jsonError("decision (APPROVED or REJECTED) required", 400);
  }

  const { decision, note } = parsed.data;

  const contribution = await prisma.knowledgeContribution.findUnique({
    where: { id },
    include: { deployment: { select: { companyId: true } } },
  });

  if (!contribution) {
    return jsonError("Contribution not found", 404);
  }
  if (contribution.deployment.companyId !== company.id) {
    return jsonError("Not authorized", 403);
  }
  if (contribution.status !== "PENDING") {
    return jsonError("Contribution already reviewed", 409);
  }

  await prisma.knowledgeContribution.update({
    where: { id },
    data: {
      status: decision,
      reviewNote: note || null,
      reviewedBy: company.id,
      reviewedAt: new Date(),
    },
  });

  return jsonSuccess({ id, status: decision });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const orgResult = await requireOrg();
  if ("error" in orgResult) return orgResult.error;
  const { company } = orgResult;

  // Find the contribution and verify it belongs to this company
  const contribution = await prisma.knowledgeContribution.findUnique({
    where: { id },
    include: { deployment: { select: { companyId: true } } },
  });

  if (!contribution) {
    return jsonError("Contribution not found", 404);
  }
  if (contribution.deployment.companyId !== company.id) {
    return jsonError("Not authorized", 403);
  }

  await prisma.knowledgeContribution.delete({ where: { id } });
  return jsonSuccess({ deleted: true });
}
