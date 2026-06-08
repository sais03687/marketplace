import { requireOrg, jsonSuccess, jsonError } from "@/lib/api-utils";
import { prisma } from "@/lib/db";

export async function POST(request: Request) {
  const orgResult = await requireOrg();
  if ("error" in orgResult) return orgResult.error;
  const { company } = orgResult;

  const body = await request.json().catch(() => ({})) as { deploymentId?: string };

  if (!body.deploymentId) {
    return jsonError("deploymentId required", 400);
  }

  const deployment = await prisma.deployment.findFirst({
    where: { id: body.deploymentId, companyId: company.id },
  });

  if (!deployment) {
    return jsonError("Deployment not found", 404);
  }

  await prisma.deployment.update({
    where: { id: body.deploymentId },
    data: { buyerMicrosoftTenantId: null, workspaceScope: "platform" },
  });

  return jsonSuccess({ disconnected: true });
}
