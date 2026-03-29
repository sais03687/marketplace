import { prisma } from "@/lib/db";
import { jsonError, jsonSuccess, requireOrg, requireDeploymentAccess } from "@/lib/api-utils";

export async function GET(
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

  if (!deployment.containerName) {
    return jsonSuccess({ memory: null, message: "Container not running" });
  }

  try {
    const containerUrl = deployment.containerName.startsWith("http")
      ? deployment.containerName
      : `http://${deployment.containerName}:4100`;
    const res = await fetch(`${containerUrl}/internal/memory`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      return jsonSuccess({ memory: null, message: "Memory not available" });
    }
    const memory = await res.json();
    return jsonSuccess(memory);
  } catch {
    return jsonSuccess({ memory: null, message: "Container unreachable" });
  }
}
