import { prisma } from "@/lib/db";
import { jsonError, jsonSuccess, requireOrg } from "@/lib/api-utils";

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
