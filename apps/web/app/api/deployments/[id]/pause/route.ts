import { prisma } from "@/lib/db";
import { jsonError, jsonSuccess, requireOrg, requireDeploymentAccess } from "@/lib/api-utils";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const orgResult = await requireOrg();
  if ("error" in orgResult) return orgResult.error;
  const { company } = orgResult;

  const depResult = await requireDeploymentAccess(id, company.id);
  if ("error" in depResult) return depResult.error;
  const { deployment } = depResult;

  if (deployment.status === "FIRED") {
    return jsonError("Cannot pause a fired agent", 409);
  }

  const newStatus = deployment.status === "PAUSED" ? "ACTIVE" : "PAUSED";

  const updated = await prisma.deployment.update({
    where: { id },
    data: {
      status: newStatus,
      pausedAt: newStatus === "PAUSED" ? new Date() : null,
    },
  });

  return jsonSuccess(updated);
}
