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
import AdmZip from "adm-zip";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

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

// ─── Buyer-Org Agent Mailbox ───────────────────────────────────────────────

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
 * Raised when the buyer's own tenant cannot host the agent — no Exchange licence
 * with a free seat, or Exchange never built the mailbox.
 *
 * Provisioning must NOT quietly fall back to a platform-tenant mailbox for these.
 * The buyer owns the agent's identity and pays for its licence; absorbing that cost
 * onto the platform is a leak that grows with every customer who has not bought
 * seats. Failing the hire tells the buyer exactly what to fix.
 */
export class BuyerTenantProvisioningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BuyerTenantProvisioningError";
  }
}

/**
 * Service plans that actually provision an Exchange Online mailbox.
 *
 * EXCHANGE_S_FOUNDATION is deliberately absent. It is a directory-only plan that
 * ships with free SKUs such as FLOW_FREE, and assigning it succeeds — the user
 * looks licensed, but Exchange never builds a mailbox and every Graph mail call
 * returns 404 MailboxNotEnabledForRESTAPI forever. Selecting a licence on spare
 * seats alone is therefore not safe; it has to be selected on this capability.
 */
const MAILBOX_SERVICE_PLANS = new Set([
  "EXCHANGE_S_STANDARD",
  "EXCHANGE_S_ENTERPRISE",
  "EXCHANGE_S_DESKLESS",
  "EXCHANGE_S_STANDARD_MIDMARKET",
  "EXCHANGE_S_ARCHIVE_ADDON",
]);

/** A licence is only usable for an agent mailbox if it grants Exchange and has a free seat. */
type TenantSku = {
  skuId: string;
  skuPartNumber: string;
  consumedUnits: number;
  capabilityStatus?: string;
  prepaidUnits: { enabled: number };
  servicePlans?: Array<{
    servicePlanName: string;
    provisioningStatus?: string;
    appliesTo?: string;
  }>;
};

/**
 * Three independent signals have to agree before we trust a licence to yield a mailbox.
 * The original bug came from trusting a single proxy (spare seats), so a name allowlist
 * alone would repeat the mistake in a slower way — Microsoft adds SKUs, and the list goes
 * stale. `appliesTo` is the structural tell: a real mailbox plan applies to a User, while
 * EXCHANGE_S_FOUNDATION applies to the Company, which is exactly how FLOW_FREE slipped
 * through. An unknown new SKU now fails closed with a clear error rather than silently
 * producing an agent that can never receive mail.
 */
function grantsMailbox(sku: TenantSku): boolean {
  if (sku.capabilityStatus && sku.capabilityStatus !== "Enabled") return false;
  return (sku.servicePlans ?? []).some(
    (p) =>
      MAILBOX_SERVICE_PLANS.has(p.servicePlanName) &&
      p.appliesTo === "User" &&
      p.provisioningStatus === "Success",
  );
}

function hasFreeSeat(sku: TenantSku): boolean {
  return sku.consumedUnits < sku.prepaidUnits.enabled;
}

/**
 * Preference order, cheapest-adequate first, so a tenant holding both an SMB and an
 * enterprise licence spends the cheaper seat. Enterprise SKUs are listed because real
 * buyers are far likelier to hold E1/E3/E5 than Business Basic, which caps at 300 seats.
 * Anything else carrying a User-scoped Exchange plan still works via the fallback.
 */
const PREFERRED_SKUS = [
  "EXCHANGESTANDARD",           // Exchange Online Plan 1 — mailbox only, cheapest
  "EXCHANGEENTERPRISE",         // Exchange Online Plan 2
  "O365_BUSINESS_ESSENTIALS",   // Microsoft 365 Business Basic
  "SMB_BUSINESS_ESSENTIALS",
  "O365_BUSINESS_PREMIUM",      // Business Standard
  "SPB",                        // Business Premium
  "STANDARDPACK",               // Office 365 E1
  "ENTERPRISEPACK",             // Office 365 E3
  "ENTERPRISEPREMIUM",          // Office 365 E5
  "SPE_E3",                     // Microsoft 365 E3
  "SPE_E5",                     // Microsoft 365 E5
];

/** Friendly names — skuPartNumber is not something a buyer should have to decode. */
const SKU_DISPLAY_NAMES: Record<string, string> = {
  EXCHANGESTANDARD: "Exchange Online (Plan 1)",
  EXCHANGEENTERPRISE: "Exchange Online (Plan 2)",
  O365_BUSINESS_ESSENTIALS: "Microsoft 365 Business Basic",
  SMB_BUSINESS_ESSENTIALS: "Microsoft 365 Business Basic",
  O365_BUSINESS_PREMIUM: "Microsoft 365 Business Standard",
  SPB: "Microsoft 365 Business Premium",
  STANDARDPACK: "Office 365 E1",
  ENTERPRISEPACK: "Office 365 E3",
  ENTERPRISEPREMIUM: "Office 365 E5",
  SPE_E3: "Microsoft 365 E3",
  SPE_E5: "Microsoft 365 E5",
  FLOW_FREE: "Power Automate Free",
};

export function skuDisplayName(partNumber: string): string {
  return SKU_DISPLAY_NAMES[partNumber] ?? partNumber;
}

/** Service plans behind the optional capabilities, keyed by what the buyer would call them. */
const ONEDRIVE_PLANS = ["SHAREPOINTSTANDARD", "SHAREPOINTENTERPRISE", "SHAREPOINTWAC"];
const TEAMS_PLANS = ["TEAMS1", "TEAMS_ENTERPRISE", "MCOSTANDARD"];

function hasAnyPlan(sku: TenantSku, names: string[]): boolean {
  return (sku.servicePlans ?? []).some((p) => names.includes(p.servicePlanName));
}

export type AgentCapabilities = {
  /** Read its inbox, reply, send, forward. Requires the Exchange plan. */
  email: boolean;
  /** List/create/update/delete events. Part of Exchange. */
  calendar: boolean;
  /** Shared SharePoint site files. Granted by the platform app, not the buyer's licence. */
  sharepoint: boolean;
  /** The agent's own OneDrive — needs a SharePoint plan on its licence. */
  onedrive: boolean;
  /** Direct messages in Teams — needs a Teams plan on its licence. */
  teams: boolean;
};

export type TenantLicensing = {
  all: TenantSku[];
  /** Mailbox-capable with a spare seat, in preference order. */
  usable: Array<{ skuId: string; skuPartNumber: string; displayName: string; seatsFree: number }>;
  /** Mailbox-capable but full — surfaced so the buyer knows which one to add seats to. */
  exhausted: Array<{ skuPartNumber: string; displayName: string; seatsUsed: number; seatsTotal: number }>;
  selected: { skuId: string; skuPartNumber: string; displayName: string; seatsFree: number } | null;
  capabilities: AgentCapabilities;
};

/**
 * Inspect a buyer tenant and report which licence an agent would consume and what it
 * would then be able to do.
 *
 * Provisioning and the hire-time preview both call this, deliberately. If the UI derived
 * its own answer the two would drift, and the buyer would be shown a licence or a
 * capability set that provisioning does not actually produce.
 */
export async function describeTenantLicensing(tenantId: string): Promise<TenantLicensing> {
  const skus = (await graphRequestForTenant(tenantId, "GET", "/subscribedSkus")) as { value: TenantSku[] };
  const all = skus.value ?? [];

  const mailboxCapable = all.filter(grantsMailbox);
  const withSeats = mailboxCapable.filter(hasFreeSeat);

  const rank = (s: TenantSku) => {
    const i = PREFERRED_SKUS.indexOf(s.skuPartNumber);
    return i === -1 ? PREFERRED_SKUS.length : i;
  };
  const ordered = [...withSeats].sort((a, b) => rank(a) - rank(b));

  const toUsable = (s: TenantSku) => ({
    skuId: s.skuId,
    skuPartNumber: s.skuPartNumber,
    displayName: skuDisplayName(s.skuPartNumber),
    seatsFree: s.prepaidUnits.enabled - s.consumedUnits,
  });

  const chosen = ordered[0] ?? null;

  return {
    all,
    usable: ordered.map(toUsable),
    exhausted: mailboxCapable
      .filter((s) => !hasFreeSeat(s))
      .map((s) => ({
        skuPartNumber: s.skuPartNumber,
        displayName: skuDisplayName(s.skuPartNumber),
        seatsUsed: s.consumedUnits,
        seatsTotal: s.prepaidUnits.enabled,
      })),
    selected: chosen ? toUsable(chosen) : null,
    capabilities: {
      // Email and calendar both come from the Exchange plan that made it selectable.
      email: !!chosen,
      calendar: !!chosen,
      // Shared SharePoint runs on the platform's application permissions, so it works
      // for every buyer regardless of what they bought.
      sharepoint: true,
      onedrive: !!chosen && hasAnyPlan(chosen, ONEDRIVE_PLANS),
      teams: !!chosen && hasAnyPlan(chosen, TEAMS_PLANS),
    },
  };
}

/**
 * Best-effort cleanup used only on the failure paths below. Both swallow their errors:
 * the caller is already throwing a more useful message, and a failed tidy-up should not
 * replace the real reason the hire failed.
 */
async function releaseLicenceQuietly(tenantId: string, userId: string, skuId: string | null) {
  if (!skuId) return;
  try {
    await graphRequestForTenant(tenantId, "POST", `/users/${userId}/assignLicense`, {
      addLicenses: [],
      removeLicenses: [skuId],
    });
    console.log(`[microsoft] Released licence seat back after failed provision`);
  } catch (err: any) {
    console.warn(`[microsoft] Could not release licence seat: ${err.message}`);
  }
}

async function deleteUserQuietly(tenantId: string, userId: string) {
  try {
    await graphRequestForTenant(tenantId, "DELETE", `/users/${userId}`);
    console.log(`[microsoft] Removed partially provisioned user after failed provision`);
  } catch (err: any) {
    console.warn(`[microsoft] Could not remove partially provisioned user: ${err.message}`);
  }
}

/**
 * Create the agent's mailbox in the buyer's Microsoft 365 tenant.
 *
 * The agent is a normal licensed user on one of the buyer's own seats, and it stays
 * that way. An earlier design converted it to a free shared mailbox and handed the
 * seat back, which is cheaper but wrong for this product:
 *
 *   - Capability. An unlicensed shared mailbox has no OneDrive, no Teams, and no
 *     licensed calendar. `describeTenantLicensing()` reports those capabilities to the
 *     buyer during hiring based on the licence the agent will consume, so releasing the
 *     seat would make that promise false the moment provisioning succeeded.
 *   - Control. The hiring organisation owns the seat, so their admins can audit, apply
 *     policy to, and revoke the agent like any other account in their directory.
 *
 * The seat is the buyer's cost, not the platform's, so there is nothing for us to save
 * here — only functionality to lose. If no mailbox-capable seat is free we fail the hire
 * outright rather than provisioning a degraded agent.
 *
 * Returns the mailbox email address and user object ID.
 */
export async function createAgentMailbox(
  tenantId: string,
  displayName: string,
  emailAlias: string,
): Promise<{ email: string; id: string }> {
  const domain = await getBuyerDomain(tenantId);
  const userPrincipalName = `${emailAlias}@${domain}`;

  let user: { id: string; userPrincipalName: string };

  try {
    // Step 1: Create an enabled user. The licence assigned in step 2 is what makes
    // Exchange build a mailbox, and the agent keeps both for its lifetime.
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
      console.log(`[microsoft] Agent mailbox user ${userPrincipalName} already exists, reusing`);
      const existing = await graphRequestForTenant(
        tenantId, "GET",
        `/users/${encodeURIComponent(userPrincipalName)}?$select=id,userPrincipalName`,
      ) as { id: string; userPrincipalName: string };
      return { email: existing.userPrincipalName, id: existing.id };
    }
    throw err;
  }

  // Step 2: Assign a license so Exchange Online provisions a mailbox.
  let skuId: string | null = null;
  let allSkus: TenantSku[] = [];
  try {
    const licensing = await describeTenantLicensing(tenantId);
    allSkus = licensing.all;
    skuId = licensing.selected?.skuId ?? null;
  } catch (err: any) {
    throw new Error(
      `[microsoft] Could not read licences from buyer tenant ${tenantId}, so no mailbox can be provisioned: ${err.message}`,
    );
  }

  if (!skuId) {
    // Fail here rather than continuing. Proceeding without a mailbox-bearing licence
    // produces a deployment that reaches ACTIVE but can never send or receive mail,
    // which is worse than a visible provisioning failure.
    const mailboxCapable = allSkus.filter(grantsMailbox);
    const detail = mailboxCapable.length
      ? mailboxCapable
          .map((s) => `${skuDisplayName(s.skuPartNumber)} (${s.consumedUnits}/${s.prepaidUnits.enabled} seats used)`)
          .join(", ")
      : "none";
    await deleteUserQuietly(tenantId, user.id);
    throw new BuyerTenantProvisioningError(
      `No Microsoft 365 licence with a free seat is available in your tenant, so the agent ` +
        `cannot be given a mailbox. Mailbox-capable licences found: ${detail}. Add a seat to ` +
        `one of them (Microsoft 365 Business Basic is the cheapest) and hire again. Note that ` +
        `free licences such as FLOW_FREE carry EXCHANGE_S_FOUNDATION only and never provision ` +
        `a mailbox, so they cannot be used.`,
    );
  }

  try {
    await graphRequestForTenant(tenantId, "POST", `/users/${user.id}/assignLicense`, {
      addLicenses: [{ skuId }],
      removeLicenses: [],
    });
    const chosen = allSkus.find((s) => s.skuId === skuId);
    console.log(`[microsoft] Assigned license ${chosen?.skuPartNumber ?? skuId} to ${userPrincipalName}`);
  } catch (err: any) {
    throw new Error(`[microsoft] License assignment failed for ${userPrincipalName}: ${err.message}`);
  }

  // Step 3: Wait until Exchange has actually built the mailbox. A missing mailbox is
  // fatal — the agent could never send or receive, so we clean up and fail the hire
  // rather than let it reach ACTIVE in a state that can never work.
  //
  // Exchange routinely takes well over ten minutes to provision after a licence is
  // assigned. The previous budget was five attempts totalling ~2m10s, which gave up
  // long before Exchange was finished and then reported success anyway.
  const MAILBOX_WAIT_MS = 20 * 60_000;
  const POLL_INTERVAL_MS = 30_000;
  const deadline = Date.now() + MAILBOX_WAIT_MS;
  let mailboxReady = false;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    try {
      await graphRequestForTenant(tenantId, "GET", `/users/${user.id}/mailFolders/inbox`);
      mailboxReady = true;
      break;
    } catch (err: any) {
      const remaining = Math.round((deadline - Date.now()) / 60_000);
      console.log(`[microsoft] Mailbox for ${userPrincipalName} not ready yet (${remaining}m budget left)`);
    }
  }

  if (!mailboxReady) {
    // Release the seat and remove the half-built user before giving up, so a retry
    // starts from the same licence position rather than one seat worse off.
    await releaseLicenceQuietly(tenantId, user.id, skuId);
    await deleteUserQuietly(tenantId, user.id);
    throw new BuyerTenantProvisioningError(
      `Microsoft 365 did not finish creating the agent's mailbox within ` +
        `${MAILBOX_WAIT_MS / 60_000} minutes. The licence was assigned successfully, so this ` +
        `is usually Exchange being slow rather than anything misconfigured. The partially ` +
        `created account has been cleaned up — try hiring again.`,
    );
  }
  console.log(`[microsoft] Mailbox ready for ${userPrincipalName}`);

  return { email: user.userPrincipalName, id: user.id };
}

/**
 * Check if the agent's mailbox already exists in the buyer's tenant.
 * Returns the user/mailbox object if found, null otherwise.
 */
export async function getAgentMailbox(
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
 * Delete the agent's identity and genuinely give the licence seat back.
 *
 * Deleting a user is NOT enough on its own. Graph soft-deletes it into a 30-day
 * recycle bin where it keeps consuming its licence, so a naive DELETE leaves the
 * buyer paying for a fired agent for a month. Confirmed against a live tenant on
 * 2026-07-31: four deletes moved Business Basic 3/1 → 3/1, and only purging the
 * recycle bin moved it to 2/1.
 *
 * So the order matters, and each step is independently useful:
 *   1. strip the licences   — frees the seat immediately, even if a later step fails
 *   2. delete the user      — revokes sign-in and stops mail delivery
 *   3. purge the recycle bin— stops the deleted object holding anything
 *
 * `tenantId` is the buyer's tenant. Pass null only for legacy deployments whose
 * identity lives in the platform tenant.
 */
export async function deleteAgentIdentity(
  tenantId: string | null,
  userId: string,
): Promise<void> {
  const req = (method: string, path: string, body?: unknown) =>
    tenantId
      ? graphRequestForTenant(tenantId, method, path, body)
      : graphRequest(method, path, body);
  const where = tenantId ? `tenant ${tenantId}` : "platform tenant";
  const gone = (err: any) =>
    err?.message?.includes("404") || err?.message?.includes("Request_ResourceNotFound");

  // 1. Release the seat.
  try {
    const user = await req("GET", `/users/${userId}?$select=assignedLicenses`) as
      { assignedLicenses?: { skuId: string }[] };
    const skuIds = (user.assignedLicenses ?? []).map((l) => l.skuId).filter(Boolean);
    if (skuIds.length) {
      await req("POST", `/users/${userId}/assignLicense`, { addLicenses: [], removeLicenses: skuIds });
      console.log(`[microsoft] Released ${skuIds.length} licence seat(s) from ${userId}`);
    }
  } catch (err: any) {
    if (!gone(err)) console.warn(`[microsoft] Could not release licences from ${userId}: ${err.message}`);
  }

  // 2. Delete the user.
  try {
    await req("DELETE", `/users/${userId}`);
    console.log(`[microsoft] Deleted agent user ${userId} from ${where}`);
  } catch (err: any) {
    if (!gone(err)) throw err;
  }

  // 3. Purge the soft-deleted object so nothing lingers for 30 days.
  try {
    await req("DELETE", `/directory/deletedItems/${userId}`);
    console.log(`[microsoft] Purged ${userId} from the recycle bin`);
  } catch (err: any) {
    if (!gone(err)) {
      console.warn(
        `[microsoft] Could not purge ${userId} from the recycle bin: ${err.message}. ` +
          `The licence was already released in step 1, so the seat is free either way.`,
      );
    }
  }
}

// ─── User Lookup ────────────────────────────────────────────────────────

/**
 * Look up a user by email address in a Microsoft 365 tenant.
 * Returns the user's Azure AD object ID (which doubles as their Teams user ID),
 * display name, and mail address.
 *
 * @param email       The user's email / UPN to look up
 * @param tenantId    Target tenant (defaults to the platform tenant)
 */
export async function getUserByEmail(
  email: string,
  tenantId?: string,
): Promise<{ id: string; displayName: string; mail: string }> {
  const tid = tenantId ?? config.microsoftTenantId;
  const { access_token } = await mintTokenForTenant(tid);

  const resp = await fetch(`${GRAPH}/users/${encodeURIComponent(email)}?$select=id,displayName,mail`, {
    headers: {
      Authorization: `Bearer ${access_token}`,
    },
  });

  if (!resp.ok) {
    throw new Error(`getUserByEmail failed for ${email} (tenant ${tid}): ${resp.status} ${await resp.text()}`);
  }

  const data = await resp.json() as { id: string; displayName: string; mail: string };
  return { id: data.id, displayName: data.displayName, mail: data.mail };
}

// ─── Teams App Auto-Install ──────────────────────────────────────────────

/**
 * Build the Teams app zip package in memory from the teams-app/ directory.
 * Returns a Buffer containing the zip file.
 */
function buildTeamsAppZip(): Buffer {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const teamsAppDir = path.resolve(__dirname, "../../teams-app");

  const zip = new AdmZip();
  zip.addLocalFile(path.join(teamsAppDir, "manifest.json"));
  zip.addLocalFile(path.join(teamsAppDir, "icon-color.png"));
  zip.addLocalFile(path.join(teamsAppDir, "icon-outline.png"));

  return zip.toBuffer();
}

/**
 * Upload and install the Teams app into a buyer's organization app catalog.
 *
 * Uses Graph API to:
 * 1. Upload the Teams app zip to the org's app catalog
 * 2. The app becomes available to all users in that tenant
 *
 * Requires: AppCatalog.ReadWrite.All permission (granted via admin consent).
 *
 * If the app is already installed (same externalId/manifest ID), it updates it instead.
 *
 * Returns the teamsAppId from the catalog.
 */
export async function installTeamsAppForTenant(
  tenantId: string,
): Promise<{ teamsAppId: string }> {
  const { access_token } = await mintTokenForTenant(tenantId);
  const zipBuffer = buildTeamsAppZip();

  // First, check if the app is already in the catalog (by externalId = manifest id)
  const manifestId = "76bfdef8-89ff-465c-ab4c-099a05a45e8c";
  let existingAppId: string | null = null;

  try {
    const existing = await graphRequestForTenant(
      tenantId, "GET",
      `/appCatalogs/teamsApps?$filter=externalId eq '${manifestId}'&$select=id,externalId`,
    ) as { value: Array<{ id: string; externalId: string }> };
    if (existing.value?.length > 0) {
      existingAppId = existing.value[0]!.id;
      console.log(`[teams-install] App already in catalog for tenant ${tenantId} (id=${existingAppId}), updating...`);
    }
  } catch (err: any) {
    console.log(`[teams-install] Could not check existing app: ${err.message}`);
  }

  if (existingAppId) {
    // Update existing app
    const resp = await fetch(
      `https://graph.microsoft.com/v1.0/appCatalogs/teamsApps/${existingAppId}/appDefinitions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${access_token}`,
          "Content-Type": "application/zip",
        },
        body: new Uint8Array(zipBuffer),
      },
    );
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`[teams-install] Failed to update Teams app in catalog (tenant ${tenantId}): ${resp.status} ${errText}`);
    }
    console.log(`[teams-install] Updated Teams app in catalog for tenant ${tenantId}`);
    return { teamsAppId: existingAppId };
  }

  // Upload new app to org catalog
  const resp = await fetch(
    "https://graph.microsoft.com/v1.0/appCatalogs/teamsApps?requiresReview=false",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${access_token}`,
        "Content-Type": "application/zip",
      },
      body: new Uint8Array(zipBuffer),
    },
  );

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`[teams-install] Failed to upload Teams app to catalog (tenant ${tenantId}): ${resp.status} ${errText}`);
  }

  const data = await resp.json() as { id: string };
  console.log(`[teams-install] Teams app uploaded to catalog for tenant ${tenantId} (id=${data.id})`);

  return { teamsAppId: data.id };
}
