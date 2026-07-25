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
 *   AGENTMAIL_API_KEY            - AgentMail API key (unused, for compat)
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
const INBOX = process.env.POLLER_INBOX || OUTLOOK_AGENT_EMAIL;
const GATEWAY_URL = process.env.POLLER_GATEWAY_URL || "http://127.0.0.1:18789";
const MARKETPLACE_URL = process.env.MARKETPLACE_URL || "http://localhost:3002";
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

  const res = await fetch(OUTLOOK_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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

/** { allowedEmails: string[], companyDomain: string, managerEmail: string|null } */
let allowlistCache = { allowedEmails: [], companyDomain: "", managerEmail: null };

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
function isSenderAllowed(fromHeader) {
  const { allowedEmails, managerEmail } = allowlistCache;

  const email = extractEmail(fromHeader);
  if (!email) return false;

  // Manager email is always allowed
  if (managerEmail && email === managerEmail.toLowerCase()) return true;

  // Empty allowlist = allow everyone (no restriction configured)
  if (!allowedEmails || allowedEmails.length === 0) return true;

  // Check explicit allowlist entries
  for (const entry of allowedEmails) {
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
  const select = "id,subject,body,from,toRecipients,ccRecipients,conversationId,receivedDateTime,hasAttachments,internetMessageId";
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
  const [agentMindResult, approvalContext] = await Promise.all([
    searchAgentMind(message.subject || messageText),
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
                headers: { "Content-Type": "application/json" },
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
