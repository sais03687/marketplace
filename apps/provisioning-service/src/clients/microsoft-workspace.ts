/**
 * Microsoft 365 client for platform-owned tenant management.
 *
 * The platform owns a single Microsoft 365 tenant (e.g. agents.[platform-domain].com).
 * One Azure AD app registration with application permissions covers all users created
 * in this tenant — no per-deployment credentials or buyer Azure setup needed.
 *
 * Env vars (stored in Hetzner .env.prod as platform infrastructure secrets):
 *   MICROSOFT_TENANT_ID      — platform Azure AD tenant ID
 *   MICROSOFT_CLIENT_ID      — platform Azure AD app client ID
 *   MICROSOFT_CLIENT_SECRET  — platform Azure AD app client secret
 *
 * Required application permissions (granted once via admin consent):
 *   User.ReadWrite.All, Mail.ReadWrite, Calendars.ReadWrite,
 *   Files.ReadWrite.All, Sites.ReadWrite.All
 */

import { config } from "../config.js";

const GRAPH = "https://graph.microsoft.com/v1.0";
const TOKEN_URL = `https://login.microsoftonline.com/${config.microsoftTenantId}/oauth2/v2.0/token`;

// Simple token cache — client credentials tokens are long-lived (3600s)
let _cachedToken: { value: string; expiresAt: number } | null = null;

async function getMicrosoftToken(): Promise<string> {
  if (_cachedToken && _cachedToken.expiresAt > Date.now() + 60_000) {
    return _cachedToken.value;
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: config.microsoftClientId,
    client_secret: config.microsoftClientSecret,
    scope: "https://graph.microsoft.com/.default",
  });

  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!resp.ok) {
    throw new Error(`Microsoft token request failed: ${resp.status} ${await resp.text()}`);
  }

  const data = await resp.json() as { access_token: string; expires_in: number };
  _cachedToken = {
    value: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return _cachedToken.value;
}

async function graphRequest(
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const token = await getMicrosoftToken();
  const resp = await fetch(`${GRAPH}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (!resp.ok && resp.status !== 204) {
    throw new Error(`Graph ${method} ${path} failed: ${resp.status} ${await resp.text()}`);
  }

  if (resp.status === 204) return null;
  return resp.json();
}

function generatePassword(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%";
  return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

/**
 * Derive the platform tenant domain from MICROSOFT_TENANT_ID by reading it
 * from the tenant's verified domain list via Graph API.
 */
async function getPlatformDomain(): Promise<string> {
  const data = await graphRequest("GET", "/organization") as { value: Array<{ verifiedDomains: Array<{ name: string; isDefault: boolean }> }> };
  const org = data.value?.[0];
  const defaultDomain = org?.verifiedDomains?.find((d) => d.isDefault)?.name;
  if (!defaultDomain) throw new Error("Could not determine platform M365 domain");
  return defaultDomain;
}

/**
 * Create a user in the platform-owned Microsoft 365 tenant.
 * Returns the user's UPN (email) and object ID.
 */
export async function createMicrosoftUser(
  username: string,
  displayName: string,
): Promise<{ email: string; id: string }> {
  const domain = await getPlatformDomain();
  const userPrincipalName = `${username}@${domain}`;

  const user = await graphRequest("POST", "/users", {
    accountEnabled: true,
    displayName,
    mailNickname: username,
    userPrincipalName,
    passwordProfile: {
      forceChangePasswordNextSignIn: false,
      password: generatePassword(),
    },
    usageLocation: "US",
  }) as { id: string; userPrincipalName: string };

  // Assign M365 Business Basic license so the user gets an Exchange Online mailbox.
  // Without this the user is unlicensed and Graph inbox webhooks will fail.
  // SKU: O365_BUSINESS_ESSENTIALS (3b555118-da6a-4418-894f-7df1e2096870)
  await graphRequest("POST", `/users/${user.id}/assignLicense`, {
    addLicenses: [{ skuId: "3b555118-da6a-4418-894f-7df1e2096870" }],
    removeLicenses: [],
  });

  return { email: user.userPrincipalName, id: user.id };
}

/**
 * Subscribe to inbox change notifications (webhook) for the agent's M365 mailbox.
 * When an email arrives at the workspace address, Graph POSTs to webhookUrl
 * with clientState=deploymentId for routing.
 *
 * Subscriptions expire after ~3 days (Graph max for mail). Renewed by cron job.
 */
export async function setupMicrosoftInboxWebhook(
  userId: string,
  deploymentId: string,
  webhookUrl: string,
): Promise<{ subscriptionId: string; expiresAt: Date }> {
  // Graph max for mail subscriptions is 4230 minutes (~2.9 days)
  const expiresAt = new Date(Date.now() + 4230 * 60 * 1000);

  const sub = await graphRequest("POST", "/subscriptions", {
    changeType: "created",
    notificationUrl: webhookUrl,
    resource: `users/${userId}/mailFolders('Inbox')/messages`,
    expirationDateTime: expiresAt.toISOString(),
    clientState: deploymentId,
  }) as { id: string; expirationDateTime: string };

  return {
    subscriptionId: sub.id,
    expiresAt: new Date(sub.expirationDateTime),
  };
}

/**
 * Renew a Microsoft Graph subscription before it expires.
 * Called by the daily renewal job for all active Microsoft deployments.
 */
export async function renewMicrosoftWebhook(subscriptionId: string): Promise<Date> {
  const expiresAt = new Date(Date.now() + 4230 * 60 * 1000);

  const sub = await graphRequest("PATCH", `/subscriptions/${subscriptionId}`, {
    expirationDateTime: expiresAt.toISOString(),
  }) as { expirationDateTime: string };

  return new Date(sub.expirationDateTime);
}

/**
 * Create a folder on the SharePoint root site drive for agent file isolation.
 * Each agent gets its own subfolder (named by slug). Idempotent — ignores 409.
 */
export async function createSharePointFolder(folderName: string): Promise<void> {
  try {
    await graphRequest("POST", "/sites/root/drive/root/children", {
      name: folderName,
      folder: {},
      "@microsoft.graph.conflictBehavior": "fail",
    });
    console.log(`[microsoft] SharePoint folder created: ${folderName}`);
  } catch (err: any) {
    // 409 = folder already exists, that's fine
    if (err.message?.includes("409")) return;
    throw err;
  }
}

/**
 * Delete a user from the platform-owned Microsoft 365 tenant.
 * Called during deprovisioning. Non-fatal if the user doesn't exist.
 */
export async function deleteMicrosoftUser(userId: string): Promise<void> {
  try {
    await graphRequest("DELETE", `/users/${userId}`);
  } catch (err: any) {
    if (err.message?.includes("404") || err.message?.includes("Request_ResourceNotFound")) return;
    throw err;
  }
}
