/**
 * Google Workspace client for platform-owned org management.
 *
 * The platform owns a single Google Workspace org (e.g. agents.[platform-domain].com).
 * One platform service account with Domain-Wide Delegation is set up once and covers
 * all users created in this org — no per-deployment SA creation or buyer DWD setup needed.
 *
 * Env vars (stored in Hetzner .env.prod as platform infrastructure secrets):
 *   GOOGLE_WORKSPACE_DOMAIN       — e.g. "agents.example.com"
 *   GOOGLE_WORKSPACE_ADMIN_EMAIL  — super-admin email for directory operations
 *   GOOGLE_WORKSPACE_SA_KEY       — base64 or raw JSON of platform SA with DWD
 */

import { google } from "googleapis";
import { config } from "../config.js";

function parseKey(keyJson: string): Record<string, unknown> {
  try {
    return JSON.parse(keyJson);
  } catch {
    return JSON.parse(Buffer.from(keyJson, "base64").toString("utf-8"));
  }
}

function makeJwtClient(subject: string, scopes: string[]) {
  const credentials = parseKey(config.googleWorkspaceSaKey);
  return new google.auth.JWT({
    email: credentials.client_email as string,
    key: credentials.private_key as string,
    scopes,
    subject, // DWD impersonation — must be a user in the platform Workspace org
  });
}

function generatePassword(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%";
  return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

/**
 * Create a user in the platform-owned Google Workspace org.
 * Returns the user's primary email and directory userId (immutable ID).
 */
export async function createGoogleWorkspaceUser(
  username: string,
  displayName: string,
): Promise<{ email: string; id: string }> {
  const auth = makeJwtClient(config.googleWorkspaceAdminEmail, [
    "https://www.googleapis.com/auth/admin.directory.user",
  ]);

  const admin = google.admin({ version: "directory_v1", auth });
  const primaryEmail = `${username}@${config.googleWorkspaceDomain}`;

  const resp = await admin.users.insert({
    requestBody: {
      primaryEmail,
      name: { fullName: displayName, givenName: displayName, familyName: "" },
      password: generatePassword(),
      changePasswordAtNextLogin: false,
    },
  });

  if (!resp.data.primaryEmail || !resp.data.id) {
    throw new Error(`Workspace user creation missing fields: ${JSON.stringify(resp.data)}`);
  }

  return { email: resp.data.primaryEmail, id: resp.data.id };
}



/**
 * Delete a user from the platform-owned Google Workspace org.
 * Called during deprovisioning. Non-fatal if the user doesn't exist.
 */
export async function deleteGoogleWorkspaceUser(userId: string): Promise<void> {
  const auth = makeJwtClient(config.googleWorkspaceAdminEmail, [
    "https://www.googleapis.com/auth/admin.directory.user",
  ]);

  const admin = google.admin({ version: "directory_v1", auth });

  try {
    await admin.users.delete({ userKey: userId });
  } catch (err: any) {
    if (err.code === 404 || err.message?.includes("Resource Not Found")) return;
    throw err;
  }
}
