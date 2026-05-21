import { jsonSuccess, requireOrg, requireDeploymentAccess } from "@/lib/api-utils";

const PROVISIONING_URL = process.env.PROVISIONING_URL || "";
const PROVISIONING_SECRET = process.env.PROVISIONING_SECRET || "";

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
    return jsonSuccess({ skills: [], message: "Container not running" });
  }

  if (!PROVISIONING_URL) {
    return jsonSuccess({ skills: [], message: "Provisioning service not configured" });
  }

  try {
    const res = await fetch(`${PROVISIONING_URL}/proxy/${id}/skills`, {
      headers: PROVISIONING_SECRET ? { Authorization: `Bearer ${PROVISIONING_SECRET}` } : {},
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json();
    return jsonSuccess(data);
  } catch {
    return jsonSuccess({ skills: [], message: "Container unreachable" });
  }
}
