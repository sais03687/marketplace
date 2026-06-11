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
 *
 * Required SharePoint application permissions (for OneDrive personal site provisioning):
 *   SharePoint → User.ReadWrite.All
 */

import { config } from "../config.js";

const GRAPH = "https://graph.microsoft.com/v1.0";
const TOKEN_URL = `https://login.microsoftonline.com/${config.microsoftTenantId}/oauth2/v2.0/token`;

// Per-tenant token cache — client credentials tokens are long-lived (3600s)
const _tokenCache = new Map<string, { value: string; expiresAt: number }>();

async function getMicrosoftToken(): Promise<string> {
  const result = await mintTokenForTenant(config.microsoftTenantId);
  return result.access_token;
}

/**
 * Mint a Graph API access token for any tenant using client_credentials.
 * Works for both the platform's own tenant and buyer tenants that have
 * granted admin consent to the platform's multi-tenant app.
 */
export async function mintTokenForTenant(tenantId: string): Promise<{ access_token: string; expires_in: number }> {
  const cached = _tokenCache.get(tenantId);
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return { access_token: cached.value, expires_in: Math.floor((cached.expiresAt - Date.now()) / 1000) };
  }

  const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: config.microsoftClientId,
    client_secret: config.microsoftClientSecret,
    scope: "https://graph.microsoft.com/.default",
  });

  const resp = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!resp.ok) {
    throw new Error(`Microsoft token request failed for tenant ${tenantId}: ${resp.status} ${await resp.text()}`);
  }

  const data = await resp.json() as { access_token: string; expires_in: number };
  _tokenCache.set(tenantId, {
    value: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  });
  return { access_token: data.access_token, expires_in: data.expires_in };
}

/**
 * Trigger OneDrive personal site provisioning via ROPC (Resource Owner Password
 * Credential) flow. SharePoint requires a user's first interactive-style sign-in
 * to provision their personal site. The programmatic CSOM/PnP APIs for this
 * (CreatePersonalSiteEnqueueBulk, Request-PnPPersonalSite) require legacy ACS
 * auth which Microsoft has retired.
 *
 * Approach: reset the user's password to a known value, obtain a delegated token
 * via ROPC, then access /me/drive which triggers M365 auto-provisioning.
 * The password is immediately re-randomised after the provisioning call.
 *
 * Requires: User.ReadWrite.All (Graph) + User Administrator Azure AD role on
 * the app's service principal (for password reset).
 *
 * Best-effort / fire-and-forget — SharePoint shared storage works regardless.
 */
export async function provisionOneDrive(
  tenantId: string,
  emails: string[],
): Promise<void> {
  for (const email of emails) {
    try {
      // 1. Check if OneDrive is already provisioned (app-only token)
      const { access_token: appToken } = await mintTokenForTenant(tenantId);
      const checkResp = await fetch(`${GRAPH}/users/${encodeURIComponent(email)}/drive`, {
        headers: { Authorization: `Bearer ${appToken}` },
      });
      if (checkResp.ok) {
        console.log(`[microsoft] OneDrive already provisioned for ${email}`);
        continue;
      }

      // 2. Reset password to a known temporary value
      const tempPassword = generatePassword();
      const resetResp = await fetch(`${GRAPH}/users/${encodeURIComponent(email)}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${appToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          passwordProfile: { forceChangePasswordNextSignIn: false, password: tempPassword },
        }),
      });
      if (!resetResp.ok) {
        console.warn(`[microsoft] OneDrive provisioning: password reset failed for ${email} (${resetResp.status})`);
        continue;
      }

      // 3. ROPC sign-in to get a delegated token
      const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
      const ropcResp = await fetch(tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "password",
          client_id: config.microsoftClientId,
          client_secret: config.microsoftClientSecret,
          scope: "https://graph.microsoft.com/.default",
          username: email,
          password: tempPassword,
        }).toString(),
      });
      if (!ropcResp.ok) {
        console.warn(`[microsoft] OneDrive provisioning: ROPC sign-in failed for ${email} (${ropcResp.status})`);
        continue;
      }
      const { access_token: userToken } = await ropcResp.json() as { access_token: string };

      // 4. Access /me/drive to trigger OneDrive provisioning
      await fetch(`${GRAPH}/me/drive`, {
        headers: { Authorization: `Bearer ${userToken}` },
      });
      console.log(`[microsoft] OneDrive provisioning triggered for ${email} (may take 1-5 min)`);

      // 5. Re-randomise the password so the temp value isn't left active
      await fetch(`${GRAPH}/users/${encodeURIComponent(email)}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${appToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          passwordProfile: { forceChangePasswordNextSignIn: false, password: generatePassword() },
        }),
      });
    } catch (err: any) {
      console.warn(`[microsoft] OneDrive provisioning error for ${email}: ${err.message}`);
    }
  }
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

  let user: { id: string; userPrincipalName: string };

  try {
    user = await graphRequest("POST", "/users", {
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
  } catch (err: any) {
    // User already exists (e.g. from a prior failed provisioning attempt) — reuse it
    if (err.message?.includes("ObjectConflict") || err.message?.includes("already exists")) {
      console.log(`[microsoft] User ${userPrincipalName} already exists, reusing`);
      const existing = await graphRequest("GET", `/users/${userPrincipalName}?$select=id,userPrincipalName`) as { id: string; userPrincipalName: string };
      return { email: existing.userPrincipalName, id: existing.id };
    }
    throw err;
  }

  // Assign M365 Business Basic license so the user gets an Exchange Online mailbox.
  // Without this the user is unlicensed and Graph inbox webhooks will fail.
  // SKU: O365_BUSINESS_ESSENTIALS (3b555118-da6a-4418-894f-7df1e2096870)
  await graphRequest("POST", `/users/${user.id}/assignLicense`, {
    addLicenses: [{ skuId: "3b555118-da6a-4418-894f-7df1e2096870" }],
    removeLicenses: [],
  });

  // Queue OneDrive personal site provisioning (async, takes 1–5 min).
  // Non-fatal — SharePoint shared storage still works without it.
  await provisionOneDrive(config.microsoftTenantId, [user.userPrincipalName]);

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

// ─── Buyer-Org Shared Mailbox ──────────────────────────────────────────────

/**
 * Graph request scoped to a specific tenant (buyer's tenant).
 * Uses mintTokenForTenant instead of the platform-only getMicrosoftToken.
 */
async function graphRequestForTenant(
  tenantId: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const { access_token } = await mintTokenForTenant(tenantId);
  const resp = await fetch(`${GRAPH}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${access_token}`,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (!resp.ok && resp.status !== 204) {
    throw new Error(`Graph ${method} ${path} failed (tenant ${tenantId}): ${resp.status} ${await resp.text()}`);
  }

  if (resp.status === 204) return null;
  return resp.json();
}

/**
 * Discover the buyer's primary (default) domain from their Microsoft 365 org.
 * E.g., "acme.com" from their Azure AD verified domains.
 */
export async function getBuyerDomain(tenantId: string): Promise<string> {
  const data = await graphRequestForTenant(tenantId, "GET", "/organization") as {
    value: Array<{ verifiedDomains: Array<{ name: string; isDefault: boolean }> }>;
  };
  const org = data.value?.[0];
  const defaultDomain = org?.verifiedDomains?.find((d) => d.isDefault)?.name;
  if (!defaultDomain) throw new Error(`Could not determine default domain for tenant ${tenantId}`);
  return defaultDomain;
}

/**
 * Create a shared mailbox in the buyer's Microsoft 365 tenant.
 *
 * Shared mailboxes are free (no license required) and appear as regular mailboxes
 * in Graph API. They're created as disabled user accounts with a shared mailbox type
 * set via Exchange Online.
 *
 * The approach: create a user via Graph with accountEnabled=false (shared mailbox pattern),
 * then convert to shared mailbox type via Exchange Admin REST API.
 *
 * Returns the mailbox email address and user object ID.
 */
export async function createSharedMailbox(
  tenantId: string,
  displayName: string,
  emailAlias: string,
): Promise<{ email: string; id: string }> {
  const domain = await getBuyerDomain(tenantId);
  const userPrincipalName = `${emailAlias}@${domain}`;

  let user: { id: string; userPrincipalName: string };

  try {
    // Step 1: Create an enabled user with a license so Exchange provisions a mailbox.
    // We'll convert it to a shared mailbox (free) and remove the license afterward.
    user = await graphRequestForTenant(tenantId, "POST", "/users", {
      accountEnabled: true,
      displayName,
      mailNickname: emailAlias,
      userPrincipalName,
      passwordProfile: {
        forceChangePasswordNextSignIn: false,
        password: generatePassword(),
      },
      usageLocation: "US",
    }) as { id: string; userPrincipalName: string };
    console.log(`[microsoft] Created user ${userPrincipalName} in buyer tenant ${tenantId}`);
  } catch (err: any) {
    if (err.message?.includes("ObjectConflict") || err.message?.includes("already exists")) {
      console.log(`[microsoft] Shared mailbox user ${userPrincipalName} already exists, reusing`);
      const existing = await graphRequestForTenant(
        tenantId, "GET",
        `/users/${encodeURIComponent(userPrincipalName)}?$select=id,userPrincipalName`,
      ) as { id: string; userPrincipalName: string };
      return { email: existing.userPrincipalName, id: existing.id };
    }
    throw err;
  }

  // Step 2: Assign a license so Exchange Online provisions a mailbox.
  // Discover available SKU from the buyer's tenant.
  let skuId: string | null = null;
  try {
    const skus = await graphRequestForTenant(tenantId, "GET", "/subscribedSkus") as {
      value: Array<{ skuId: string; skuPartNumber: string; consumedUnits: number; prepaidUnits: { enabled: number } }>;
    };
    // Prefer Business Basic (cheapest with Exchange), fall back to any SKU with available licenses
    const preferred = ["O365_BUSINESS_ESSENTIALS", "SMB_BUSINESS_ESSENTIALS", "EXCHANGESTANDARD", "STANDARDPACK", "ENTERPRISEPACK"];
    for (const pref of preferred) {
      const sku = skus.value?.find((s) => s.skuPartNumber === pref && s.consumedUnits < s.prepaidUnits.enabled);
      if (sku) { skuId = sku.skuId; break; }
    }
    if (!skuId) {
      const anySku = skus.value?.find((s) => s.consumedUnits < s.prepaidUnits.enabled);
      if (anySku) skuId = anySku.skuId;
    }
  } catch (err: any) {
    console.warn(`[microsoft] Could not discover tenant SKUs: ${err.message}`);
  }

  if (skuId) {
    try {
      await graphRequestForTenant(tenantId, "POST", `/users/${user.id}/assignLicense`, {
        addLicenses: [{ skuId }],
        removeLicenses: [],
      });
      console.log(`[microsoft] Assigned license (${skuId}) to ${userPrincipalName}`);
    } catch (err: any) {
      console.warn(`[microsoft] License assignment failed: ${err.message}`);
    }
  } else {
    console.warn(`[microsoft] No available license SKU found in buyer tenant — Exchange mailbox may not provision`);
  }

  // Step 3: Wait for Exchange to provision the mailbox, then convert to shared.
  // Exchange needs the licensed user to propagate (30-90s typically).
  const MAX_RETRIES = 5;
  const RETRY_DELAYS = [30_000, 20_000, 20_000, 30_000, 30_000];
  let converted = false;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const delay = RETRY_DELAYS[attempt]!;
    console.log(`[microsoft] Waiting ${delay / 1000}s for Exchange mailbox provisioning${attempt > 0 ? ` (attempt ${attempt + 1}/${MAX_RETRIES})` : ""}...`);
    await new Promise((r) => setTimeout(r, delay));

    try {
      const exchangeToken = await mintExchangeTokenForTenant(tenantId);
      const exchangeResp = await fetch(
        `https://outlook.office365.com/adminapi/beta/${tenantId}/Mailbox('${user.id}')`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${exchangeToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ Type: "Shared" }),
        },
      );
      if (exchangeResp.ok) {
        console.log(`[microsoft] Converted ${userPrincipalName} to shared mailbox`);
        converted = true;
        break;
      }
      const errText = await exchangeResp.text();
      const isNotFound = errText.includes("NotFound") || errText.includes("couldn't be found");
      if (isNotFound && attempt < MAX_RETRIES - 1) {
        console.log(`[microsoft] Exchange mailbox not yet available, will retry...`);
        continue;
      }
      console.warn(`[microsoft] Exchange shared mailbox conversion failed (${exchangeResp.status}): ${errText}`);
    } catch (err: any) {
      console.warn(`[microsoft] Exchange API call failed: ${err.message}`);
      if (attempt < MAX_RETRIES - 1) continue;
    }
  }

  // Step 4: Remove the license — shared mailboxes don't need one.
  // Also disable the account (shared mailboxes shouldn't be sign-in-able).
  if (converted && skuId) {
    try {
      await graphRequestForTenant(tenantId, "POST", `/users/${user.id}/assignLicense`, {
        addLicenses: [],
        removeLicenses: [skuId],
      });
      console.log(`[microsoft] Removed license from shared mailbox ${userPrincipalName}`);
    } catch (err: any) {
      console.warn(`[microsoft] License removal failed (non-fatal): ${err.message}`);
    }
    try {
      await graphRequestForTenant(tenantId, "PATCH", `/users/${user.id}`, {
        accountEnabled: false,
      });
    } catch { /* non-fatal */ }
  }

  if (!converted) {
    console.warn(`[microsoft] Shared mailbox conversion did not succeed — user created but mailbox may not be shared. Can be converted manually.`);
  }

  return { email: user.userPrincipalName, id: user.id };
}

/**
 * Mint an Exchange Online Admin API token for a specific tenant.
 * Exchange Admin API uses a different scope than Graph API.
 */
async function mintExchangeTokenForTenant(tenantId: string): Promise<string> {
  const cacheKey = `exchange:${tenantId}`;
  const cached = _tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.value;
  }

  const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: config.microsoftClientId,
    client_secret: config.microsoftClientSecret,
    scope: "https://outlook.office365.com/.default",
  });

  const resp = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!resp.ok) {
    throw new Error(`Exchange token request failed for tenant ${tenantId}: ${resp.status} ${await resp.text()}`);
  }

  const data = await resp.json() as { access_token: string; expires_in: number };
  _tokenCache.set(cacheKey, {
    value: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  });
  return data.access_token;
}

/**
 * Check if a shared mailbox already exists in the buyer's tenant.
 * Returns the user/mailbox object if found, null otherwise.
 */
export async function getSharedMailbox(
  tenantId: string,
  emailAddress: string,
): Promise<{ id: string; userPrincipalName: string } | null> {
  try {
    const user = await graphRequestForTenant(
      tenantId, "GET",
      `/users/${encodeURIComponent(emailAddress)}?$select=id,userPrincipalName,accountEnabled`,
    ) as { id: string; userPrincipalName: string; accountEnabled: boolean };
    return user;
  } catch (err: any) {
    if (err.message?.includes("404") || err.message?.includes("Request_ResourceNotFound")) return null;
    throw err;
  }
}

/**
 * Delete a shared mailbox from the buyer's tenant.
 * Used during deprovisioning or disconnect cleanup.
 */
export async function deleteSharedMailbox(
  tenantId: string,
  userId: string,
): Promise<void> {
  try {
    await graphRequestForTenant(tenantId, "DELETE", `/users/${userId}`);
    console.log(`[microsoft] Deleted shared mailbox user ${userId} from tenant ${tenantId}`);
  } catch (err: any) {
    if (err.message?.includes("404") || err.message?.includes("Request_ResourceNotFound")) return;
    throw err;
  }
}
