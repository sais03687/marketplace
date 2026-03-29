import { prisma } from "@/lib/db";
import { jsonError, jsonSuccess, requireOrg } from "@/lib/api-utils";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const orgResult = await requireOrg();
  if ("error" in orgResult) return orgResult.error;
  const { company } = orgResult;

  const deployment = await prisma.deployment.findFirst({
    where: { id, companyId: company.id },
    include: {
      agent: {
        include: { capabilities: true },
      },
      _count: {
        select: {
          approvals: { where: { status: "PENDING" } },
        },
      },
    },
  });

  if (!deployment) {
    return jsonError("Deployment not found", 404);
  }

  return jsonSuccess(deployment);
}
