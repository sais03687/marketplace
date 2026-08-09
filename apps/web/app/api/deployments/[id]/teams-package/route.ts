import { jsonError, requireOrg, requireDeploymentAccess } from "@/lib/api-utils";

/**
 * Download the Teams app package for this deployment, to sideload.
 *
 * Provisioning used to upload this to the buyer's tenant app catalog itself.
 * Microsoft answers that with 403 "User not authorized to perform this
 * operation" in every tenant, and it is not a consent anyone can grant —
 * app-only publishing to a tenant catalog is not supported by that API. So the
 * install failed on every hire while the wizard sold Teams as a capability.
 *
 * The package was never the problem; only the upload was refused. This hands it
 * to the buyer, who can sideload it in Teams admin — the one route that works
 * today without a Teams Store listing and a multi-tenant bot.
 *
 * Org-scoped on purpose. The package is not secret, but the deployment id is in
 * the path, and every other deployment route refuses to confirm the existence of
 * an id the caller does not own.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const orgResult = await requireOrg();
  if ("error" in orgResult) return orgResult.error;

  const access = await requireDeploymentAccess(id, orgResult.company.id);
  if ("error" in access) return access.error;

  const base =
    process.env.PROVISIONING_SERVICE_URL ||
    process.env.PROVISIONING_URL ||
    "https://api.agentstore.it.com";
  const secret = process.env.PROVISIONING_SECRET;
  if (!secret) {
    return jsonError("Provisioning service is not configured", 503);
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${base.replace(/\/$/, "")}/internal/teams-app-package`, {
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err: any) {
    console.error(`[teams-package] Could not reach the provisioning service: ${err.message}`);
    return jsonError("Could not build the Teams package just now. Please try again.", 502);
  }

  if (!upstream.ok) {
    console.error(`[teams-package] Provisioning service returned ${upstream.status}`);
    return jsonError("Could not build the Teams package just now. Please try again.", 502);
  }

  return new Response(await upstream.arrayBuffer(), {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": 'attachment; filename="agentstore-teams-app.zip"',
      "Cache-Control": "no-store",
    },
  });
}
