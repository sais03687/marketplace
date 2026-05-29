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
 * Set up Gmail auto-forwarding from the workspace address to the Agentmail address.
 *
 * Flow:
 *   1. Create forwarding address → Gmail sends verification email to Agentmail inbox
 *   2. Poll Agentmail API to read the verification email
 *   3. Extract confirmation URL and follow it (GET request)
 *   4. Enable auto-forwarding with disposition=trash (delete forwarded copies)
 */
export async function setupGmailForwarding(
  workspaceEmail: string,
  agentmailAddress: string,
  agentmailInboxId: string,
): Promise<void> {
  const auth = makeJwtClient(workspaceEmail, [
    "https://www.googleapis.com/auth/gmail.settings.basic",
    "https://www.googleapis.com/auth/gmail.settings.sharing",
  ]);

  const gmail = google.gmail({ version: "v1", auth });

  // Step 1: Register forwarding address — Gmail sends a verification email to Agentmail
  await gmail.users.settings.forwardingAddresses.create({
    userId: "me",
    requestBody: { forwardingEmail: agentmailAddress },
  });

  // Step 2: Poll Agentmail inbox for verification email (max 30s)
  const confirmUrl = await pollForGmailVerificationUrl(agentmailInboxId, 30_000);

  // Step 3: Follow the confirmation URL to complete verification
  const token = await auth.getAccessToken();
  await fetch(confirmUrl, {
    headers: { Authorization: `Bearer ${token.token}` },
    redirect: "follow",
  });

  // Step 4: Enable auto-forwarding
  await gmail.users.settings.updateAutoForwarding({
    userId: "me",
    requestBody: {
      enabled: true,
      emailAddress: agentmailAddress,
      disposition: "trash", // delete local copies; Agentmail is the source of truth
    },
  });
}

/**
 * Poll the Agentmail inbox for a Gmail verification email and return the confirmation URL.
 * Gmail sends from mail-noreply@google.com with subject "Gmail Forwarding Confirmation".
 */
async function pollForGmailVerificationUrl(
  inboxId: string,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  const agentmailBase = config.agentMailApiBase;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));

    const resp = await fetch(
      `${agentmailBase}/inboxes/${inboxId}/messages?limit=10`,
      { headers: { Authorization: `Bearer ${config.agentMailApiKey}` } },
    );

    if (!resp.ok) continue;

    const data = await resp.json() as { messages?: Array<{ from?: string; text?: string; html?: string }> };
    const messages = data.messages ?? [];

    for (const msg of messages) {
      if (!msg.from?.includes("mail-noreply@google.com")) continue;
      const body = msg.text ?? msg.html ?? "";
      // Extract the confirmation URL from the email body
      const match = body.match(/https:\/\/mail-settings\.google\.com\/[^\s"<>]+/);
      if (match) return match[0];
    }
  }

  throw new Error("Timed out waiting for Gmail forwarding verification email in Agentmail inbox");
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
