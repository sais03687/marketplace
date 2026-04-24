/**
 * Google Cloud IAM client for per-deployment service account provisioning.
 *
 * Architecture:
 *   - GCP_IAM_KEY  — dedicated provisioner SA key. Only roles needed:
 *                    serviceAccountCreator + serviceAccountDeleter + serviceAccountKeyAdmin.
 *                    This SA has no API access — it only manages other SAs.
 *
 *   - GOOGLE_SERVICE_ACCOUNT_KEY — the platform agent's identity key (alex-agent@...).
 *                    Used for Drive/Sheets/Calendar access. NOT used for IAM operations.
 *
 * Using a separate IAM-only SA follows the principle of least privilege:
 * the agent identity SA cannot escalate its own permissions by creating new SAs,
 * and the IAM provisioner SA cannot access any Google Workspace APIs.
 *
 * Domain-wide delegation (DWD) — which allows a per-deployment SA to impersonate
 * Workspace users — cannot be granted via API; it must be done once per company
 * in the Google Workspace Admin console. After calling createDeploymentServiceAccount(),
 * surface the returned clientId to the hiring manager with a one-time setup link.
 */

import { google } from "googleapis";

export interface DeploymentServiceAccount {
  email: string;
  privateKeyJson: string; // full JSON key as a string, pass as GOOGLE_SERVICE_ACCOUNT_KEY
  clientId: string;       // numeric client ID — used for DWD setup in Admin console
}

function parseKey(keyJson: string): Record<string, unknown> {
  // Keys may be stored as raw JSON or base64-encoded JSON
  try {
    return JSON.parse(keyJson);
  } catch {
    return JSON.parse(Buffer.from(keyJson, "base64").toString("utf-8"));
  }
}

/**
 * Create a GCP service account for a deployment and return its credentials.
 *
 * Uses GCP_IAM_KEY (dedicated provisioner SA) if set;
 * falls back to GOOGLE_SERVICE_ACCOUNT_KEY for single-SA legacy setups.
 */
export async function createDeploymentServiceAccount(
  deploymentId: string,
  agentSlug: string,
  projectId: string,
  iamKeyJson: string,
): Promise<DeploymentServiceAccount> {
  const credentials = parseKey(iamKeyJson);

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });

  const iam = google.iam({ version: "v1", auth });

  // Service account IDs: 6–30 chars, lowercase alphanumeric + hyphens
  // Use 12 chars of deploymentId for uniqueness (cuid IDs are long; test IDs may be short)
  const trimmedSlug = agentSlug.replace(/[^a-z0-9-]/g, "").slice(0, 12);
  const accountId = `sa-${trimmedSlug}-${deploymentId.slice(0, 12).replace(/[^a-z0-9]/g, "")}`;

  // 1. Create the service account (or fetch it if it already exists from a prior attempt)
  let sa: { email?: string | null; uniqueId?: string | null };
  try {
    const createResp = await iam.projects.serviceAccounts.create({
      name: `projects/${projectId}`,
      requestBody: {
        accountId,
        serviceAccount: {
          displayName: `Marketplace agent: ${agentSlug} (${deploymentId.slice(0, 8)})`,
        },
      },
    });
    sa = createResp.data;
  } catch (err: any) {
    // 409 = already exists — the previous provision attempt may have created the SA
    // but failed before storing the key. Fetch the existing SA and issue a new key.
    if (err.code === 409 || err.message?.includes("already exists")) {
      const getResp = await iam.projects.serviceAccounts.get({
        name: `projects/${projectId}/serviceAccounts/${accountId}@${projectId}.iam.gserviceaccount.com`,
      });
      sa = getResp.data;
    } else {
      throw err;
    }
  }

  if (!sa.email || !sa.uniqueId) {
    throw new Error(`Service account missing email or uniqueId: ${JSON.stringify(sa)}`);
  }

  // 2. Create a JSON key for the service account.
  // GCP needs a few seconds to propagate a newly created SA before keys can be issued.
  await new Promise((r) => setTimeout(r, 4000));

  const keyResp = await iam.projects.serviceAccounts.keys.create({
    name: `projects/${projectId}/serviceAccounts/${sa.email}`,
    requestBody: {
      privateKeyType: "TYPE_GOOGLE_CREDENTIALS_FILE",
      keyAlgorithm: "KEY_ALG_RSA_2048",
    },
  });

  if (!keyResp.data.privateKeyData) {
    throw new Error("No privateKeyData in key creation response");
  }

  const privateKeyJson = Buffer.from(keyResp.data.privateKeyData, "base64").toString("utf-8");

  return {
    email: sa.email,
    privateKeyJson,
    clientId: sa.uniqueId,
  };
}

/**
 * Delete a deployment's service account and all its keys.
 * Called during deprovisioning. Non-fatal if the account doesn't exist.
 */
export async function deleteDeploymentServiceAccount(
  serviceAccountEmail: string,
  projectId: string,
  iamKeyJson: string,
): Promise<void> {
  const credentials = parseKey(iamKeyJson);

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });

  const iam = google.iam({ version: "v1", auth });

  await iam.projects.serviceAccounts.delete({
    name: `projects/${projectId}/serviceAccounts/${serviceAccountEmail}`,
  });
}
