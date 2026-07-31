import { NextRequest } from "next/server";
import { requireOrg, jsonSuccess, jsonError } from "@/lib/api-utils";

/**
 * Which Microsoft 365 licence an agent would consume in the caller's tenant, and what
 * the agent could do with it.
 *
 * This proxies the provisioning service rather than querying Graph itself. The licence
 * rules live next to the code that actually assigns the licence, so the preview shown
 * during hiring cannot drift away from what provisioning really does.
 */
export async function GET(req: NextRequest) {
  const orgResult = await requireOrg();
  if ("error" in orgResult) return orgResult.error;

  const tenantId = req.nextUrl.searchParams.get("tenantId");
  if (!tenantId) return jsonError("Connect your Microsoft 365 organization first.", 400);

  const provisioningUrl = process.env.PROVISIONING_SERVICE_URL || "https://api.agentstore.it.com";
  const provisioningSecret = process.env.PROVISIONING_SECRET;

  try {
    const res = await fetch(
      `${provisioningUrl}/internal/tenant-licensing?tenantId=${encodeURIComponent(tenantId)}`,
      {
        headers: provisioningSecret ? { Authorization: `Bearer ${provisioningSecret}` } : {},
        cache: "no-store",
      },
    );
    if (!res.ok) {
      return jsonError("We couldn't read the licences in your Microsoft 365 organization.", 502);
    }
    return jsonSuccess(await res.json());
  } catch {
    return jsonError("We couldn't reach Microsoft 365 to check your licences.", 502);
  }
}
