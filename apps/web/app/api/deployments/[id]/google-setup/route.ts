/**
 * Returns the one-time Google Workspace Domain-Wide Delegation setup info for
 * a deployment's dedicated service account.
 *
 * DWD cannot be granted via API — the company's Google Workspace Super Admin
 * must do it once in the Admin console. This endpoint surfaces the client ID
 * and required scopes so the UI can show them a direct setup link.
 */
import { prisma } from "@/lib/db";
import { jsonError, jsonSuccess, requireOrg, requireDeploymentAccess } from "@/lib/api-utils";

// OAuth scopes the agent needs for Google Workspace access
const REQUIRED_SCOPES = [
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/gmail.send",
].join(",");

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

  const saEmail = (deployment as any).deploymentServiceAccountEmail as string | null;

  if (!saEmail) {
    return jsonSuccess({
      configured: false,
      message: "No dedicated service account — this deployment uses the platform-level shared account.",
    });
  }

  // Parse the client ID from the stored key JSON (avoids a GCP API round-trip)
  let clientId: string | null = null;
  const saKey = (deployment as any).deploymentServiceAccountKey as string | null;
  if (saKey) {
    try {
      const parsed = JSON.parse(saKey);
      clientId = parsed.client_id ?? null;
    } catch {
      // key may be malformed — surface what we have
    }
  }

  const dwdSetupUrl = clientId
    ? `https://admin.google.com/ac/owl/domainwidedelegation?clientScopeToAdd=${REQUIRED_SCOPES}&clientIdToAdd=${clientId}&overwriteClientId=true`
    : null;

  return jsonSuccess({
    configured: (deployment as any).deploymentServiceAccountSetup ?? false,
    serviceAccountEmail: saEmail,
    clientId,
    requiredScopes: REQUIRED_SCOPES.split(","),
    dwdSetupUrl,
    instructions: dwdSetupUrl
      ? [
          "1. Click the setup link below (requires Google Workspace Super Admin).",
          "2. Review the requested scopes and click Authorise.",
          "3. Return here and click 'Mark as configured' to enable Google Workspace features.",
        ]
      : ["Service account client ID not available yet. Try again in a few minutes."],
  });
}

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

  await prisma.deployment.update({
    where: { id },
    data: { deploymentServiceAccountSetup: true },
  });

  return jsonSuccess({ message: "Google Workspace delegation marked as configured." });
}
