#!/usr/bin/env node
/**
 * Marketplace Outlook Inbox Poller + Drive File Watcher
 *
 * Polls a Microsoft 365 mailbox via Microsoft Graph API and forwards new messages
 * to the deployment's OpenClaw gateway webhook endpoint.
 * Replaces AgentMail poller for Microsoft workspace deployments.
 *
 * Also watches Google Drive (via service account) for newly shared files
 * and sends synthetic notifications to the agent.
 *
 * Env vars (required):
 *   OUTLOOK_AGENT_EMAIL  - Agent's M365 email (e.g. data-analyst@agents.agentstore.it.com)
 *   OUTLOOK_TOKEN_URL    - URL to fetch Graph tokens (e.g. http://host.docker.internal:3003/internal/microsoft-token)
 *   DEPLOYMENT_ID        - Deployment ID for token proxy
 *   POLLER_GATEWAY_URL   - Gateway base URL (e.g. http://127.0.0.1:32790)
 *   OPENCLAW_HOOKS_TOKEN - Bearer token for gateway hooks (empty string for custom runtime)
 *
 * Env vars (optional):
 *   MARKETPLACE_URL              - Marketplace web app URL (default http://localhost:3002)
 *   AGENT_ID                     - Agent ID for AgentMind search
 *   POLLER_INBOX                 - Agent's inbox email (for compatibility)
 *
 * Env vars (optional — enables Drive watcher):
 *   GOOGLE_SERVICE_ACCOUNT_KEY   - Base64-encoded service account JSON key
 *   GOOGLE_SERVICE_ACCOUNT_EMAIL - Service account email
 */

import { createSign } from "node:crypto";

const OUTLOOK_AGENT_EMAIL = process.env.OUTLOOK_AGENT_EMAIL;
const OUTLOOK_TOKEN_URL = process.env.OUTLOOK_TOKEN_URL;
const DEPLOYMENT_ID = process.env.DEPLOYMENT_ID || "";
const HOOKS_TOKEN = process.env.OPENCLAW_HOOKS_TOKEN;
// Separate from HOOKS_TOKEN on purpose: that one admits inbound mail, this one
// releases an action a human was asked to approve. Inherited from the
// provisioning service's own environment, which already holds it.
const APPROVAL_TOKEN = process.env.APPROVAL_WEBHOOK_TOKEN || "";
const INBOX = process.env.POLLER_INBOX || OUTLOOK_AGENT_EMAIL;
const GATEWAY_URL = process.env.POLLER_GATEWAY_URL || "http://127.0.0.1:18789";
const MARKETPLACE_URL = process.env.MARKETPLACE_URL || "http://localhost:3002";
const PROVISIONING_SECRET = process.env.PROVISIONING_SECRET || "";
const AGENT_ID = process.env.AGENT_ID || "";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const POLL_INTERVAL_S = 5;
const DRIVE_POLL_INTERVAL_S = 30;

if (!OUTLOOK_AGENT_EMAIL) {
  console.error("[outlook-poller] Error: OUTLOOK_AGENT_EMAIL not set");
  process.exit(1);
}
if (!OUTLOOK_TOKEN_URL) {
  console.error("[outlook-poller] Error: OUTLOOK_TOKEN_URL not set");
  process.exit(1);
}
if (!DEPLOYMENT_ID) {
  console.error("[outlook-poller] Error: DEPLOYMENT_ID not set");
  process.exit(1);
}

// ─── Microsoft Graph Token Management ──────────────────────────────────────

let graphToken = null;
let graphTokenExpiry = 0;

async function getGraphToken() {
  if (graphToken && Date.now() < graphTokenExpiry) return graphToken;

  // The token endpoint authenticates callers since 2026-08-01. The poller runs
  // on the host as a child of the provisioning service, so it presents the
  // platform secret it already inherits.
  const res = await fetch(OUTLOOK_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(PROVISIONING_SECRET ? { Authorization: `Bearer ${PROVISIONING_SECRET}` } : {}),
    },
    body: JSON.stringify({ deploymentId: DEPLOYMENT_ID }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`[outlook-poller] Token fetch failed: ${res.status} ${text}`);
    return null;
  }

  const data = await res.json();
  if (!data.access_token) {
    console.error("[outlook-poller] Token response missing access_token:", JSON.stringify(data));
    return null;
  }

  graphToken = data.access_token;
  // Refresh 60s before expiry
  const expiresIn = data.expires_in || 3600;
  graphTokenExpiry = Date.now() + (expiresIn - 60) * 1000;
  console.log(`[outlook-poller] Graph token refreshed (expires in ${expiresIn}s)`);
  return graphToken;
}

// ─── Service Account Setup (optional) ───────────────────────────────────────

const SA_KEY_B64 = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
const SA_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
let saKey = null;
let driveEnabled = false;

if (SA_KEY_B64) {
  try {
    saKey = JSON.parse(Buffer.from(SA_KEY_B64, "base64").toString("utf-8"));
    driveEnabled = true;
  } catch (err) {
    console.error("[drive-watcher] Failed to parse service account key:", err.message);
  }
}

// Cached SA access token
let saToken = null;
let saTokenExpiry = 0;

async function getSAToken() {
  if (saToken && Date.now() < saTokenExpiry - 30_000) return saToken;

  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: saKey.client_email,
    scope: "https://www.googleapis.com/auth/drive.readonly",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  })).toString("base64url");

  const sig = createSign("RSA-SHA256")
    .update(header + "." + payload)
    .sign(saKey.private_key, "base64url");

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: header + "." + payload + "." + sig,
    }),
  });

  const data = await res.json();
  if (!data.access_token) {
    console.error("[drive-watcher] SA token exchange failed:", JSON.stringify(data));
    return null;
  }

  saToken = data.access_token;
  saTokenExpiry = Date.now() + (data.expires_in || 3600) * 1000;
  return saToken;
}

// ─── AgentMind + Approval Context ───────────────────────────────────────────

/**
 * Search AgentMind for relevant knowledge based on message content.
 * Returns { text, ids } — text is the formatted context string (or ""),
 * ids is the list of contribution IDs that were found (for use tracking).
 */
async function searchAgentMind(query) {
  if (!AGENT_ID || !DEPLOYMENT_ID || !query) return { text: "", ids: [] };
  try {
    const q = encodeURIComponent(query.slice(0, 200));
    const url = `${MARKETPLACE_URL}/api/agentmind/search?agentId=${AGENT_ID}&deploymentId=${DEPLOYMENT_ID}&q=${q}&limit=5`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { text: "", ids: [] };
    const data = await res.json();
    const entries = data.contributions || data.data || (Array.isArray(data) ? data : []);
    if (!Array.isArray(entries) || entries.length === 0) return { text: "", ids: [] };

    const ids = entries.map((e) => e.id).filter(Boolean);
    const lines = entries.map(
      (e) => `- [${e.type}] ${e.content}`,
    );
    const text = [
      "",
      "---",
      "[AgentMind — insights from other deployments]",
      ...lines,
    ].join("\n");
    return { text, ids };
  } catch {
    return { text: "", ids: [] };
  }
}

/**
 * Notify AgentMind that specific contributions were used in a response.
 * This auto-upvotes each contribution (idempotent per deployment).
 */
async function markAgentMindUsed(contributionIds) {
  if (!DEPLOYMENT_ID || !contributionIds.length) return;
  try {
    await fetch(`${MARKETPLACE_URL}/api/agentmind/use`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deploymentId: DEPLOYMENT_ID, contributionIds }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // Non-fatal — usage tracking is best-effort
  }
}

/**
 * Check for pending approvals on this thread.
 * Returns formatted context string or empty string.
 */
async function getPendingApprovals(threadId) {
  if (!DEPLOYMENT_ID || !threadId) return "";
  try {
    const url = `${MARKETPLACE_URL}/api/deployments/${DEPLOYMENT_ID}/approvals?status=PENDING&threadId=${encodeURIComponent(threadId)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return "";
    const data = await res.json();
    const approvals = data.data || data || [];
    if (!Array.isArray(approvals) || approvals.length === 0) return "";

    const now = Date.now();
    const lines = approvals.map((a) => {
      const ago = Math.round((now - new Date(a.createdAt).getTime()) / (60 * 60 * 1000));
      const draftPreview = (a.draft || "").slice(0, 80);
      return `- ID: ${a.id} | Task: ${a.taskType} | Draft: "${draftPreview}${a.draft?.length > 80 ? "..." : ""}" (queued ${ago}h ago)`;
    });

    return [
      "[SYSTEM: There are pending approvals in this thread that need syncing.",
      "If the sender's message is responding to an approval request (approving,",
      "editing, or rejecting a proposed action), you MUST call resolve_approval",
      "with the approval ID and appropriate action before responding.",
      "Pending approvals:",
      ...lines,
      "]",
      "",
    ].join("\n");
  } catch {
    return "";
  }
}

// ─── LLM Approval Classification ────────────────────────────────────────────

/**
 * Classify a reply email as approve / reject / unclear using Gemini Flash.
 * @param {string} replyText — the user's reply text (before quoted content)
 * @returns {{ decision: "approve"|"reject"|"unclear", note: string }}
 */
async function classifyApprovalReply(replyText) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;

  const systemPrompt = `You classify email replies to approval requests. The user was asked to approve or reject a proposed action by their AI agent. Respond with EXACTLY one JSON object: {"decision":"approve","note":"..."} or {"decision":"reject","note":"..."} or {"decision":"unclear","note":"..."}. The "note" field should be a brief summary of what the user said. Examples of approvals: "yes", "go ahead", "approved", "sounds good", "please do", "that works", "ok", "fine by me", "lgtm". Examples of rejections: "no", "reject", "don't do that", "hold off", "cancel", "not now", "stop". If the reply doesn't clearly indicate approval or rejection, use "unclear". Output ONLY the JSON object, nothing else.`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ parts: [{ text: replyText }] }],
      generationConfig: { maxOutputTokens: 100, responseMimeType: "application/json" },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const text = (data.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();

  try {
    const parsed = JSON.parse(text);
    if (["approve", "reject", "unclear"].includes(parsed.decision)) {
      return parsed;
    }
  } catch {
    const lower = text.toLowerCase();
    if (lower.includes('"approve"')) return { decision: "approve", note: replyText.slice(0, 80) };
    if (lower.includes('"reject"')) return { decision: "reject", note: replyText.slice(0, 80) };
  }

  return { decision: "unclear", note: "Could not classify reply" };
}

// ─── Email Allowlist ─────────────────────────────────────────────────────────

/** { allowedEmails: string[], companyDomains: string[], companyDomain: string, managerEmail: string|null } */
let allowlistCache = { allowedEmails: [], companyDomains: [], companyDomain: "", managerEmail: null };

// The allowlist is fetched lazily — only when there is actually mail to decide
// about — rather than on a fixed heartbeat. A timer-based refresh queried the
// marketplace API (and therefore Postgres) around the clock even on nights with
// zero mail, which kept the database from ever scaling to zero. Fetching on
// demand also means the list is fresh at the moment of the decision instead of
// up to one refresh interval stale.
const ALLOWLIST_TTL_MS = 60 * 1000; // treat a successful fetch as fresh this long
const ALLOWLIST_MIN_GAP_MS = 5 * 1000; // floor between attempts, incl. forced ones
const DENIED_RECHECK_MS = 15 * 60 * 1000; // re-check allowlist while denied mail waits

let allowlistFetchedAt = 0; // last successful fetch
let allowlistAttemptedAt = 0; // last attempt, success or not
let allowlistVersion = ""; // changes only when the effective rules change
let lastDeniedRecheck = 0;
let allowlistUnreachable = false; // so the warning is logged once per failure streak

/** Messages held back by the allowlist → the version they were denied under. */
const deniedVersions = new Map();

async function ensureAllowlist({ force = false } = {}) {
  if (!DEPLOYMENT_ID) return;
  const now = Date.now();
  // Throttle so the 5s poll loop (or a burst of mail) can't hammer the API,
  // and so a slow/failing marketplace is retried at a sane rate.
  if (now - allowlistAttemptedAt < ALLOWLIST_MIN_GAP_MS) return;
  if (!force && now - allowlistFetchedAt < ALLOWLIST_TTL_MS) return;
  allowlistAttemptedAt = now;
  try {
    const res = await fetch(`${MARKETPLACE_URL}/api/deployments/${DEPLOYMENT_ID}/allowlist`, {
      headers: PROVISIONING_SECRET ? { Authorization: `Bearer ${PROVISIONING_SECRET}` } : {},
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      allowlistCache = await res.json();
      allowlistFetchedAt = Date.now();
      allowlistVersion = JSON.stringify([
        allowlistCache.managerEmail || "",
        [...(allowlistCache.allowedEmails || [])].sort(),
      ]);
      allowlistUnreachable = false;
    }
  } catch (err) {
    // Non-fatal — keep the previous cache. But say so out loud: an unreachable
    // allowlist leaves allowedEmails empty, which isSenderAllowed() treats as
    // "allow everyone". Swallowing this silently is how a misconfigured
    // MARKETPLACE_URL hid a non-functioning allowlist indefinitely.
    if (!allowlistUnreachable) {
      allowlistUnreachable = true;
      console.error(
        `[allowlist] fetch failed (${MARKETPLACE_URL}) — senders are NOT being restricted: ${err.message}`,
      );
    }
  }
}

/**
 * Extract the bare email address from a "Name <email>" or plain "email" string.
 */
function extractEmail(from) {
  if (!from) return "";
  const match = from.match(/<([^>]+)>/);
  return (match ? match[1] : from).toLowerCase().trim();
}

/**
 * Returns true if the sender is permitted to email this agent.
 *
 * Rules (in order):
 *  1. Manager email is always allowed (set at hire time)
 *  2. If allowedEmails is empty → allow everyone (no restriction)
 *  3. Exact email match in allowedEmails list
 *  4. Domain wildcard match (@domain.com) in allowedEmails list
 *  5. If none of the above match → deny
 */
/**
 * The agent's own domain, taken from its mailbox address.
 *
 * This is the floor the sender rules rest on, and it deliberately comes from the
 * agent's own address rather than the allowlist API. Agents are provisioned as
 * users inside the buyer's tenant, so the domain of their mailbox *is* the
 * company domain — no network call, and nothing that can fail.
 */
function agentOwnDomain() {
  const at = (OUTLOOK_AGENT_EMAIL || "").lastIndexOf("@");
  return at === -1 ? "" : OUTLOOK_AGENT_EMAIL.slice(at + 1).toLowerCase();
}

/**
 * May this sender reach the agent?
 *
 * An empty allowlist used to mean "allow everyone", which made the default
 * posture the weakest one: a buyer who configured nothing had an agent that would
 * hold a conversation with anyone who found its address and answer using their
 * SharePoint data. It now means "my organisation only" — the same reading applied
 * to share recipients, for the same reason.
 *
 * The company domain is honoured, which it previously was not: isSenderAllowed
 * consulted only managerEmail and explicit entries, so configuring an allowlist
 * at all would have started blocking the buyer's own colleagues.
 *
 * Nothing here depends on the allowlist API having answered. If it never does,
 * colleagues and the manager still get through and strangers still do not, rather
 * than the outage deciding the policy in either direction.
 */
function isSenderAllowed(fromHeader) {
  const { allowedEmails, companyDomain, managerEmail } = allowlistCache;

  const email = extractEmail(fromHeader);
  if (!email) return false;

  if (managerEmail && email === managerEmail.toLowerCase()) return true;

  // companyDomains is Microsoft's verifiedDomains for the buyer's tenant.
  // companyDomain is kept only for an older platform that has not redeployed;
  // the API now sources it from the same verified list.
  const domains = [
    agentOwnDomain(),
    ...(allowlistCache.companyDomains || []),
    companyDomain || "",
  ];
  for (const d of domains) {
    const domain = (d || "").toLowerCase();
    if (domain && email.endsWith("@" + domain)) return true;
  }

  for (const entry of allowedEmails || []) {
    if (entry.startsWith("@")) {
      // Domain wildcard: @partner.com
      if (email.endsWith(entry)) return true;
    } else {
      if (email === entry) return true;
    }
  }

  return false;
}

// ─── Outlook Email Polling ─────────────────────────────────────────────────

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const processedIds = new Set();

/**
 * Strip HTML tags to produce plain text (simple regex approach).
 */
function htmlToPlainText(html) {
  if (!html) return "";
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Format a Graph emailAddress object as "Name <email>" string.
 */
function formatEmailAddress(addr) {
  if (!addr || !addr.emailAddress) return "";
  const name = addr.emailAddress.name || "";
  const email = addr.emailAddress.address || "";
  if (name && name !== email) return `${name} <${email}>`;
  return email;
}

/**
 * List unread messages from the agent's inbox via Microsoft Graph.
 */
async function listUnreadMessages(token) {
  const userEnc = encodeURIComponent(OUTLOOK_AGENT_EMAIL);
  const filter = encodeURIComponent("isRead eq false");
  const orderby = encodeURIComponent("receivedDateTime asc");
  // internetMessageHeaders is requested for bounce detection: Graph omits it unless
  // explicitly selected, so without it the header checks in isBounceMessage() would
  // read undefined and never fire — coverage that looks present and is not.
  // uniqueBody is the new content of a reply with the quoted history excluded.
  // Graph omits it unless it is asked for, and it is the only way to tell a real
  // request from a reply that says nothing at all — see isEmptyMessage().
  const select = "id,subject,body,uniqueBody,from,toRecipients,ccRecipients,conversationId,receivedDateTime,hasAttachments,internetMessageId,internetMessageHeaders";
  const url = `${GRAPH_BASE}/users/${userEnc}/mailFolders/Inbox/messages?$filter=${filter}&$orderby=${orderby}&$top=10&$select=${select}`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    console.error(`  [error] list messages: ${res.status} ${await res.text()}`);
    return [];
  }

  const data = await res.json();
  return data.value || [];
}

/**
 * Fetch attachments for a specific message.
 */
async function fetchAttachments(token, messageId) {
  const userEnc = encodeURIComponent(OUTLOOK_AGENT_EMAIL);
  const msgEnc = encodeURIComponent(messageId);
  const url = `${GRAPH_BASE}/users/${userEnc}/messages/${msgEnc}/attachments`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    console.error(`  [error] fetch attachments: ${res.status}`);
    return [];
  }

  const data = await res.json();
  return (data.value || [])
    .filter((att) => att["@odata.type"] === "#microsoft.graph.fileAttachment")
    .map((att) => ({
      filename: att.name,
      content_base64: att.contentBytes,
      contentType: att.contentType,
    }));
}

/**
 * Mark a message as read via PATCH.
 */
/**
 * Is this a delivery-failure notification rather than a message from a person?
 *
 * Checked on three independent signals because no single one is reliable across
 * providers: the envelope sender, the subject, and the MIME report type. Exchange
 * uses "Undeliverable:", most others use a postmaster or MAILER-DAEMON sender, and
 * RFC 3464 reports carry multipart/report; report-type=delivery-status.
 *
 * Deliberately conservative — it only has to catch machine-generated failures, and
 * a false positive would silently drop a real person's mail.
 */
function isBounceMessage(msg, fromAddr) {
  const from = String(fromAddr || "").toLowerCase();
  // postmaster and mailer-daemon are unambiguous. Exchange does not use either —
  // its NDRs come from a per-tenant system mailbox like
  // MicrosoftExchange329e71ec88ae4615bbc36ab6ce41109e@<domain>, which is the shape
  // seen in production. no-reply@ is deliberately NOT here: it means "do not answer
  // me", not "delivery failed", and a buyer may forward system alerts from one.
  if (/^(postmaster|mailer-daemon)@/.test(from)) return true;
  if (/^microsoftexchange[0-9a-f]{16,}@/.test(from)) return true;

  const subject = String(msg?.subject || "").toLowerCase();
  if (
    subject.startsWith("undeliverable:") ||
    subject.startsWith("delivery status notification") ||
    subject.startsWith("returned mail") ||
    subject.startsWith("mail delivery failed") ||
    subject.startsWith("delivery has failed")
  ) {
    return true;
  }

  const headers = msg?.internetMessageHeaders || [];
  for (const h of headers) {
    const name = String(h?.name || "").toLowerCase();
    const value = String(h?.value || "").toLowerCase();
    if (name === "content-type" && value.includes("report-type=delivery-status")) return true;
    // Set by Exchange and others on system-generated mail; a human reply never has it.
    if (name === "auto-submitted" && value.includes("auto-replied")) return true;
  }
  return false;
}

/**
 * Is this a reply to an approval notification?
 *
 * Matches the subject buildApprovalNotificationEmail produces
 * ("Action needed: <agent> needs approval for <task>") once a mail client has
 * prefixed it with Re:/RE:/Fwd: and so on. The original notification is sent by
 * the agent and never arrives in its own inbox, so a match here is always
 * somebody's reply.
 *
 * Kept in step with the subject built in apps/web/lib/email.ts.
 */
function isApprovalNotificationReply(msg) {
  const subject = (msg?.subject || "").trim();
  if (!subject) return false;
  // Strip any number of reply/forward prefixes: "RE: FW: Action needed: ..."
  const stripped = subject.replace(/^((re|fw|fwd|aw|sv|vs)\s*(\[\d+\])?\s*:\s*)+/i, "");
  return stripped.toLowerCase().startsWith("action needed:");
}

/** Reply in-thread with a fixed message. No model involved. */
/**
 * Did this message actually say anything?
 *
 * A reply carries the whole conversation quoted underneath it, so a message with
 * nothing typed in it still arrives with plenty of text — the last thing the
 * agent said. Handed that, the agent reads its own previous answer and sends it
 * back as though it were new work. Seen on 2026-08-11: an empty reply produced a
 * confident "I have already provided the revenue per unit for APAC as 222.00",
 * which was true, unasked for, and looked like the agent ignoring the request.
 *
 * People send empty replies. They hit send before typing, they reply from a
 * phone and the text lands in the wrong place, they mean to attach something and
 * forget. The agent should notice rather than answer the quote.
 *
 * uniqueBody is Graph's answer to this: the new part only. It is trusted just
 * when Graph returned it — absent means unknown, and unknown must not be treated
 * as empty, or every message gets refused the day that field stops arriving.
 */
function isEmptyMessage(message) {
  const unique = message?.uniqueBody?.content;
  if (unique === undefined || unique === null) return false; // not available — do not guess
  if (message?.hasAttachments) return false;                 // a file is content
  return htmlToPlainText(unique).replace(/\s+/g, " ").trim().length === 0;
}

/**
 * Would replying to this start a loop?
 *
 * Auto-responders answer, and an out-of-office is frequently empty once its
 * quoted history is removed. Answering one with "your message was empty" invites
 * it to answer back. Bounces are already handled earlier; this covers the rest.
 */
function isAutoSubmitted(message) {
  for (const h of message?.internetMessageHeaders || []) {
    const name = String(h?.name || "").toLowerCase();
    const value = String(h?.value || "").toLowerCase();
    if (name === "auto-submitted" && value && value !== "no") return true;
    if (name === "x-autoreply" || name === "x-autorespond") return true;
    if (name === "precedence" && ["bulk", "auto_reply", "junk"].includes(value)) return true;
  }
  return false;
}

async function sendCannedReply(token, messageId, text) {
  const userEnc = encodeURIComponent(OUTLOOK_AGENT_EMAIL);
  const msgEnc = encodeURIComponent(messageId);
  try {
    const res = await fetch(`${GRAPH_BASE}/users/${userEnc}/messages/${msgEnc}/reply`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ comment: text }),
    });
    if (!res.ok) {
      console.error(`  [error] canned reply: ${res.status} ${await res.text()}`);
    }
  } catch (err) {
    console.error(`  [error] canned reply: ${err.message}`);
  }
}

async function markAsRead(token, messageId) {
  const userEnc = encodeURIComponent(OUTLOOK_AGENT_EMAIL);
  const msgEnc = encodeURIComponent(messageId);
  const url = `${GRAPH_BASE}/users/${userEnc}/messages/${msgEnc}`;

  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ isRead: true }),
  });

  if (!res.ok) {
    console.error(`  [error] mark as read: ${res.status}`);
  }
}

/**
 * Forward a single Outlook message to the gateway webhook.
 */
async function forwardToGateway(message, attachments) {
  const fromFormatted = formatEmailAddress(message.from);
  const ccAddresses = (message.ccRecipients || [])
    .map((r) => r.emailAddress?.address)
    .filter(Boolean)
    .join(", ");

  const isHtml = message.body?.contentType === "html";
  const htmlContent = isHtml ? message.body.content : "";
  const plainText = isHtml ? htmlToPlainText(message.body.content) : (message.body?.content || "");

  let messageText = plainText;

  // Enrich message with AgentMind knowledge and pending approval context (parallel, non-fatal)
  // Subject plus a slice of the body. A subject alone is thin signal — "Quarterly
  // figures" says almost nothing about what is being asked — and the search is now
  // semantic, so it has more to work with the more of the actual request it sees.
  const agentMindQuery = [message.subject || "", plainText.slice(0, 300)]
    .filter(Boolean)
    .join(" ")
    .trim();

  const [agentMindResult, approvalContext] = await Promise.all([
    searchAgentMind(agentMindQuery),
    getPendingApprovals(message.conversationId),
  ]);

  if (approvalContext) {
    messageText = approvalContext + messageText;
  }
  if (agentMindResult.text) {
    messageText = messageText + agentMindResult.text;
  }

  const payload = {
    type: "webhook",
    event_type: "message.received",
    event_id: message.internetMessageId || message.id,
    message: {
      message_id: message.id,
      inbox_id: OUTLOOK_AGENT_EMAIL,
      thread_id: message.conversationId,
      from: fromFormatted,
      to: OUTLOOK_AGENT_EMAIL,
      subject: message.subject,
      text: messageText,
      html: htmlContent,
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(ccAddresses ? { cc: ccAddresses } : {}),
      // Which lessons were injected into the text above. The container needs
      // them so it can report back what the run actually did — without this the
      // only record is "injected", which is why a lesson that suppressed work
      // and one that helped were indistinguishable in the data.
      ...(agentMindResult.ids.length > 0 ? { agentmind_ids: agentMindResult.ids } : {}),
    },
    thread: {
      thread_id: message.conversationId,
      subject: message.subject,
    },
  };

  const headers = { "Content-Type": "application/json" };
  if (HOOKS_TOKEN) {
    headers["Authorization"] = `Bearer ${HOOKS_TOKEN}`;
  }

  const res = await fetch(`${GATEWAY_URL}/hooks/agentmail`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  const status = res.status;
  const body = await res.text();

  // If the gateway accepted the message and we had AgentMind hits, mark them as used.
  if (status >= 200 && status < 300 && agentMindResult.ids.length > 0) {
    markAgentMindUsed(agentMindResult.ids).catch(() => {});
    console.log(`  [agentmind] Marked ${agentMindResult.ids.length} contribution(s) as used`);
  }

  return { status, body };
}

let _pollRunning = false;

async function poll() {
  // Prevent overlapping poll cycles
  if (_pollRunning) return;
  _pollRunning = true;
  try {
    const token = await getGraphToken();
    if (!token) return;

    const messages = await listUnreadMessages(token);

    // Only touch the allowlist API when there is *undecided* mail. Messages we
    // are already holding back are excluded, otherwise they would keep this
    // condition true forever and turn the TTL back into a constant heartbeat —
    // they are handled by the slower DENIED_RECHECK_MS path below instead.
    if (messages.some((m) => !processedIds.has(m.id) && !deniedVersions.has(m.id))) {
      await ensureAllowlist();
    }
    // While denied mail is waiting, re-check on a slow cadence so a sender added
    // to the allowlist later still gets delivered.
    if (deniedVersions.size > 0 && Date.now() - lastDeniedRecheck > DENIED_RECHECK_MS) {
      lastDeniedRecheck = Date.now();
      await ensureAllowlist({ force: true });
    }

    for (const msg of messages) {
      const msgId = msg.id;
      if (processedIds.has(msgId)) continue;

      // Mark processed immediately to prevent duplicate processing
      processedIds.add(msgId);

      // Skip agent's own sent messages
      const fromEmail = msg.from?.emailAddress?.address?.toLowerCase() || "";
      if (fromEmail === OUTLOOK_AGENT_EMAIL.toLowerCase()) {
        continue;
      }

      // Allowlist check — hold back if sender is not permitted
      const fromFormatted = formatEmailAddress(msg.from);
      if (!isSenderAllowed(fromFormatted)) {
        // Never deny on a stale allowlist: confirm against fresh data before
        // holding mail back, but only once per set of rules so a denied message
        // sitting in the mailbox doesn't re-query on every 5s cycle.
        if (deniedVersions.get(msgId) !== allowlistVersion) {
          await ensureAllowlist({ force: true });
        }
        if (!isSenderAllowed(fromFormatted)) {
          // Leave it unread and forget we saw it, so that if the sender is added
          // to the allowlist later the message is still delivered. Previously it
          // was marked read and retained here, which dropped it permanently and
          // hid it from the mailbox owner too.
          processedIds.delete(msgId);
          if (deniedVersions.get(msgId) !== allowlistVersion) {
            deniedVersions.set(msgId, allowlistVersion);
            console.log(`  [blocked] From: ${fromFormatted} | not in allowlist — left unread`);
          }
          continue;
        }
      }
      deniedVersions.delete(msgId);

      // ── Approval-reply detection ──────────────────────────────────────
      // If the email body (including quoted content) contains an approval ID
      // pattern from a prior approval notification, classify the reply with
      // an LLM to determine if it's an approval, rejection, or unrelated.
      const fullBody = (msg.body?.content || "") + " " + (msg.bodyPreview || "");
      const approvalMatch = fullBody.match(/\/approve\/([a-z0-9]+)/i);
      if (approvalMatch && GEMINI_API_KEY) {
        const approvalId = approvalMatch[1];
        // Extract the reply text (before the quoted content)
        const replyText = (msg.bodyPreview || "").split(/(?:From:|On .* wrote:|_{3,}|-{3,})/)[0].trim();

        if (replyText.length > 0) {
          try {
            const classification = await classifyApprovalReply(replyText);
            if (classification.decision !== "unclear") {
              const status = classification.decision === "reject" ? "REJECTED" : "APPROVED";
              const resolveResp = await fetch(`${GATEWAY_URL}/internal/approvals/${approvalId}/resolve`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "x-deployment-token": APPROVAL_TOKEN,
                },
                body: JSON.stringify({
                  status,
                  resolutionAction: status === "APPROVED" ? (classification.note || "Approved via email reply") : null,
                  rejectionReason: status === "REJECTED" ? (classification.note || "Rejected via email reply") : null,
                }),
              });
              console.log(`  [approval] ${status} via email reply (${approvalId}) → ${resolveResp.status} | "${replyText.slice(0, 60)}"`);
              await markAsRead(token, msgId);
              continue;
            }
            // "unclear" — fall through and forward to agent as a normal message
          } catch (err) {
            console.warn(`  [approval] Classification failed for ${approvalId}: ${err.message}`);
            // Fall through to normal processing
          }
        }
      }

      // Fetch attachments if present
      let attachments = [];
      if (msg.hasAttachments) {
        attachments = await fetchAttachments(token, msgId);
      }

      // Bounces are not tasks. A delivery failure handed to the agent reads as an
      // ordinary email, so it drafts a reply to the postmaster — which is useless,
      // burns a run, and raises an approval a human then has to dismiss. It can
      // also loop: replying to a bounce can bounce.
      //
      // Observed 2026-08-02, when Gmail rejected the agent's introduction email and
      // the resulting "Undeliverable:" notice became a pending approval addressed
      // to a mail daemon.
      if (isBounceMessage(msg, fromEmail)) {
        console.log(
          `  [bounce] From: ${fromFormatted} | Subject: ${msg.subject} — delivery failure, not forwarded`,
        );
        // Marked read so it is not re-examined every poll. It stays in the mailbox,
        // where the owner can still see that a message did not get through.
        await markAsRead(token, msgId);
        continue;
      }

      // Someone replied to an approval notification instead of using its buttons.
      //
      // Answer it here rather than handing it to the agent. The decision travels
      // by button precisely so that nothing has to interpret prose, and passing
      // "yes go ahead" to a model that cannot resolve approvals would either do
      // nothing or do the wrong thing. Silence is not an option either: the sender
      // believes they have approved, the request sits until it expires 48h later,
      // and the work quietly dies.
      //
      // Structural check on the subject, not the body — it cannot misread intent
      // because it never looks at intent.
      if (isApprovalNotificationReply(msg)) {
        console.log(
          `  [approval-reply] From: ${fromFormatted} | Subject: ${msg.subject} — answered, not forwarded`,
        );
        await sendCannedReply(
          token,
          msgId,
          "Replying to this message doesn't approve anything — I can't act on email replies.\n\n" +
            "Open the approval email again and use the Approve or Reject button in it. " +
            "You can also decide from the Approvals page in your dashboard.",
        );
        await markAsRead(token, msgId);
        continue;
      }

      // Nothing was typed — only the quoted thread came through. Answer here
      // rather than handing it to the agent, which would read the quoted history
      // as the request and reply with whatever it last said.
      if (isEmptyMessage(msg)) {
        if (isAutoSubmitted(msg)) {
          console.log(
            `  [empty] From: ${fromFormatted} | Subject: ${msg.subject} — auto-reply, ignored`,
          );
        } else {
          console.log(
            `  [empty] From: ${fromFormatted} | Subject: ${msg.subject} — no new content, asked what they need`,
          );
          await sendCannedReply(
            token,
            msgId,
            "I got your reply, but there was no message in it — only the earlier " +
              "conversation quoted underneath.\n\n" +
              "Send it again with what you'd like me to do and I'll pick it straight up.",
          );
        }
        await markAsRead(token, msgId);
        continue;
      }

      console.log(`  [new] From: ${fromFormatted} | Subject: ${msg.subject}`);
      const result = await forwardToGateway(msg, attachments);
      console.log(`  [fwd] Gateway: ${result.status}`);

      // Mark as read after successful processing
      await markAsRead(token, msgId);
    }
  } finally {
    _pollRunning = false;
  }
}

// ─── Drive File Watcher ─────────────────────────────────────────────────────

const knownFileIds = new Set();
let driveInitialized = false;

/** Friendly MIME type labels */
function mimeLabel(mimeType) {
  const map = {
    "application/vnd.google-apps.spreadsheet": "Google Sheets",
    "application/vnd.google-apps.document": "Google Docs",
    "application/vnd.google-apps.presentation": "Google Slides",
    "application/vnd.google-apps.folder": "Folder",
    "application/vnd.google-apps.form": "Google Forms",
    "application/pdf": "PDF",
  };
  return map[mimeType] || mimeType;
}

/** Get comments on a file (the sharing message workaround) */
async function getFileComments(token, fileId) {
  try {
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}/comments?fields=comments(content,author/displayName,createdTime)&pageSize=5`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) return [];
    const data = await res.json();
    return data.comments || [];
  } catch {
    return [];
  }
}

/** Send a synthetic "file shared" notification to the agent */
async function notifyAgentOfNewFile(file, comments) {
  const commentText = comments.length > 0
    ? `\n\nComments on the file:\n${comments.map(c => `  - ${c.author?.displayName || "Someone"}: "${c.content}"`).join("\n")}`
    : "";

  const sharerName = file.sharingUser?.displayName || "Someone";
  const sharerEmail = file.sharingUser?.emailAddress || null;
  const sharingUser = sharerEmail ? `${sharerName} (${sharerEmail})` : sharerName;

  // Build a smart link based on file type
  const linkMap = {
    "application/vnd.google-apps.spreadsheet": `https://docs.google.com/spreadsheets/d/${file.id}`,
    "application/vnd.google-apps.document": `https://docs.google.com/document/d/${file.id}`,
    "application/vnd.google-apps.presentation": `https://docs.google.com/presentation/d/${file.id}`,
  };
  const fileLink = linkMap[file.mimeType] || `https://drive.google.com/file/d/${file.id}`;

  const text = [
    `[Google Drive Notification] A new file was shared with you.`,
    ``,
    `File: ${file.name}`,
    `Type: ${mimeLabel(file.mimeType)}`,
    `Shared by: ${sharingUser}`,
    `Sharer's email: ${sharerEmail || "unknown"}`,
    `Shared at: ${file.sharedWithMeTime || "unknown"}`,
    `File ID: ${file.id}`,
    `Link: ${fileLink}`,
    commentText,
    ``,
    `INSTRUCTIONS:`,
    `1. Read the file using the appropriate tool:`,
    `   - Spreadsheet → sheets_read(spreadsheet_id="${file.id}", range="Sheet1")`,
    `   - Document → docs_read(document_id="${file.id}")`,
    `   - Other → drive_get_file(file_id="${file.id}")`,
    `2. If you received a separate email about this file, coordinate with that email thread.`,
    `3. When done, notify the person who shared it:`,
    sharerEmail
      ? `   → Use email_send(to="${sharerEmail}", subject="Re: ${file.name}", text="...") to update them.`
      : `   → Reply in the relevant email thread if one exists.`,
  ].join("\n");

  const syntheticId = `drive-share-${file.id}`;
  const payload = {
    type: "webhook",
    event_type: "message.received",
    event_id: syntheticId,
    message: {
      inbox_id: INBOX,
      thread_id: `drive-share-${file.id}`,
      from: sharingUser,
      to: INBOX,
      subject: `File shared with you: "${file.name}" (${mimeLabel(file.mimeType)})`,
      text,
      html: "",
    },
    thread: {
      thread_id: `drive-share-${file.id}`,
      subject: `File shared with you: "${file.name}"`,
    },
  };

  const headers = { "Content-Type": "application/json" };
  if (HOOKS_TOKEN) {
    headers["Authorization"] = `Bearer ${HOOKS_TOKEN}`;
  }

  const res = await fetch(`${GATEWAY_URL}/hooks/agentmail`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  return { status: res.status };
}

async function pollDrive() {
  const token = await getSAToken();
  if (!token) return;

  // List files shared with the service account (not owned by it)
  const fields = "files(id,name,mimeType,sharingUser,sharedWithMeTime,owners)";
  const q = encodeURIComponent("sharedWithMe=true");
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=${fields}&orderBy=sharedWithMeTime desc&pageSize=20`,
    { headers: { Authorization: `Bearer ${token}` } },
  );

  if (!res.ok) {
    console.error(`  [drive-watcher] list files failed: ${res.status}`);
    return;
  }

  const data = await res.json();
  const files = data.files || [];

  if (!driveInitialized) {
    // First run: seed known files without notifying
    for (const f of files) {
      knownFileIds.add(f.id);
    }
    driveInitialized = true;
    console.log(`[drive-watcher] Initialized with ${files.length} existing shared files`);
    return;
  }

  // Check for new files
  for (const file of files) {
    if (knownFileIds.has(file.id)) continue;
    knownFileIds.add(file.id);

    const sharingUser = file.sharingUser?.displayName || file.sharingUser?.emailAddress || "Someone";
    console.log(`  [drive-new] "${file.name}" (${mimeLabel(file.mimeType)}) shared by ${sharingUser}`);

    // Check for comments (users can add comments as a workaround for sharing messages)
    const comments = await getFileComments(token, file.id);

    const result = await notifyAgentOfNewFile(file, comments);
    console.log(`  [drive-fwd] Gateway: ${result.status}`);
  }
}

// ─── Startup ────────────────────────────────────────────────────────────────

console.log(`=== Marketplace Outlook Poller ===`);
console.log(`Email:    ${OUTLOOK_AGENT_EMAIL}`);
console.log(`Gateway:  ${GATEWAY_URL}/hooks/agentmail`);
console.log(`Token:    ${OUTLOOK_TOKEN_URL}`);
console.log(`Interval: ${POLL_INTERVAL_S}s`);

if (AGENT_ID && DEPLOYMENT_ID) {
  console.log(`[agentmind] Enabled (agent: ${AGENT_ID}, deployment: ${DEPLOYMENT_ID.slice(0, 8)}...)`);
  console.log(`[approval-sync] Enabled (marketplace: ${MARKETPLACE_URL})`);
} else {
  console.log(`[agentmind] Disabled (no AGENT_ID/DEPLOYMENT_ID)`);
}

if (driveEnabled) {
  console.log(`[drive-watcher] Enabled (SA: ${SA_EMAIL || saKey?.client_email})`);
  console.log(`[drive-watcher] Poll interval: ${DRIVE_POLL_INTERVAL_S}s`);
} else {
  console.log(`[drive-watcher] Disabled (no GOOGLE_SERVICE_ACCOUNT_KEY)`);
}

// Fetch initial Graph token
const initialToken = await getGraphToken();
if (!initialToken) {
  console.error("[outlook-poller] Failed to fetch initial Graph token — exiting");
  process.exit(1);
}

// Fetch allowlist at startup; thereafter it refreshes lazily when mail arrives
// (see ensureAllowlist) rather than on a timer that would keep Postgres awake.
await ensureAllowlist({ force: true });
const managerLabel = allowlistCache.managerEmail ? ` (manager: ${allowlistCache.managerEmail})` : "";
console.log(`[allowlist] ${allowlistCache.allowedEmails.length} additional entries${managerLabel}`);

// Initial email poll — mark existing unread messages as seen without forwarding
const existingMessages = await listUnreadMessages(initialToken);
for (const msg of existingMessages) {
  processedIds.add(msg.id);
}
console.log(
  `[ready] Watching for new emails... (${existingMessages.length} existing messages skipped)\n`,
);

// Email polling loop
setInterval(async () => {
  try {
    await poll();
  } catch (err) {
    console.error(`[error] Poll failed: ${err.message}`);
  }
}, POLL_INTERVAL_S * 1000);

// Drive polling loop (if enabled)
if (driveEnabled) {
  // Initial Drive poll (seed known files)
  try {
    await pollDrive();
  } catch (err) {
    console.error(`[drive-watcher] Init failed: ${err.message}`);
  }

  setInterval(async () => {
    try {
      await pollDrive();
    } catch (err) {
      console.error(`[drive-watcher] Poll failed: ${err.message}`);
    }
  }, DRIVE_POLL_INTERVAL_S * 1000);
}
