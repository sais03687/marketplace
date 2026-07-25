#!/usr/bin/env node
/**
 * Marketplace AgentMail Poller + Drive File Watcher
 *
 * Polls a specific AgentMail inbox and forwards new messages
 * to the deployment's OpenClaw gateway webhook endpoint.
 *
 * Also watches Google Drive (via service account) for newly shared files
 * and sends synthetic notifications to the agent.
 *
 * Env vars (required):
 *   AGENTMAIL_API_KEY    - AgentMail API key
 *   POLLER_INBOX         - Inbox email address to poll
 *   POLLER_GATEWAY_URL   - Gateway base URL (e.g. http://127.0.0.1:18800)
 *   OPENCLAW_HOOKS_TOKEN - Bearer token for gateway hooks
 *
 * Env vars (optional — enables Drive watcher):
 *   GOOGLE_SERVICE_ACCOUNT_KEY   - Base64-encoded service account JSON key
 *   GOOGLE_SERVICE_ACCOUNT_EMAIL - Service account email
 *
 * Env vars (optional — enables AgentMind + approval sync):
 *   MARKETPLACE_URL   - Marketplace web app URL (default http://localhost:3002)
 *   DEPLOYMENT_ID     - Deployment ID for this agent
 *   AGENT_ID          - Agent ID for AgentMind search
 */

import { createSign } from "node:crypto";

const AGENTMAIL_API_KEY = process.env.AGENTMAIL_API_KEY;
const HOOKS_TOKEN = process.env.OPENCLAW_HOOKS_TOKEN;
const INBOX = process.env.POLLER_INBOX;
// POLLER_INBOX_ID is the inbox email address used as path parameter in AgentMail API calls.
// The @ must NOT be percent-encoded — AgentMail's API accepts the raw email as a path segment.
const INBOX_ID = process.env.POLLER_INBOX_ID || INBOX;
// Encode INBOX_ID for use in URL paths: encode everything except alphanumerics, @, ., -, _
const INBOX_ID_ENC = (INBOX_ID || "").replace(/[^A-Za-z0-9._@\-]/g, c => encodeURIComponent(c));
const GATEWAY_URL = process.env.POLLER_GATEWAY_URL || "http://127.0.0.1:18789";
const MARKETPLACE_URL = process.env.MARKETPLACE_URL || "http://localhost:3002";
const DEPLOYMENT_ID = process.env.DEPLOYMENT_ID || "";
const AGENT_ID = process.env.AGENT_ID || "";
const POLL_INTERVAL_S = 5;
const DRIVE_POLL_INTERVAL_S = 30;

if (!AGENTMAIL_API_KEY) {
  console.error("[poller] Error: AGENTMAIL_API_KEY not set");
  process.exit(1);
}
if (!INBOX) {
  console.error("[poller] Error: POLLER_INBOX not set");
  process.exit(1);
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
  // Throttle so the poll loop (or a burst of mail) can't hammer the API, and so
  // a slow/failing marketplace is retried at a sane rate.
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

// ─── Email Polling ──────────────────────────────────────────────────────────

const processedIds = new Set();

async function listMessages() {
  const res = await fetch(
    `https://api.agentmail.to/v0/inboxes/${INBOX_ID_ENC}/messages`,
    { headers: { Authorization: `Bearer ${AGENTMAIL_API_KEY}` } },
  );
  if (!res.ok) {
    console.error(`  [error] list messages: ${res.status}`);
    return [];
  }
  const data = await res.json();
  return data.messages || [];
}

async function getMessage(messageId) {
  const res = await fetch(
    `https://api.agentmail.to/v0/inboxes/${INBOX_ID_ENC}/messages/${encodeURIComponent(messageId)}`,
    { headers: { Authorization: `Bearer ${AGENTMAIL_API_KEY}` } },
  );
  if (!res.ok) return null;
  return res.json();
}

async function forwardToGateway(msg) {
  let messageText = msg.text || msg.preview || "";

  // Enrich message with AgentMind knowledge and pending approval context (parallel, non-fatal)
  const [agentMindResult, approvalContext] = await Promise.all([
    searchAgentMind(msg.subject || messageText),
    getPendingApprovals(msg.thread_id),
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
    event_id: msg.message_id,
    message: {
      message_id: msg.message_id,
      inbox_id: msg.inbox_id,
      thread_id: msg.thread_id,
      from: msg.from,
      to: msg.to,
      subject: msg.subject,
      text: messageText,
      html: msg.html || "",
    },
    thread: {
      thread_id: msg.thread_id,
      subject: msg.subject,
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
  // This auto-upvotes the contributions the agent was exposed to (best-effort, non-blocking).
  if (status >= 200 && status < 300 && agentMindResult.ids.length > 0) {
    markAgentMindUsed(agentMindResult.ids).catch(() => {});
    console.log(`  [agentmind] Marked ${agentMindResult.ids.length} contribution(s) as used`);
  }

  return { status, body };
}

let _pollRunning = false;

async function poll() {
  // Prevent overlapping poll cycles: if a previous poll() is still awaiting
  // async I/O (getMessage, forwardToGateway), skip this interval tick.
  if (_pollRunning) return;
  _pollRunning = true;
  try {
    const messages = await listMessages();

    // Only touch the allowlist API when there is *undecided* mail. Messages we
    // are already holding back are excluded, otherwise they would keep this
    // condition true forever and turn the TTL back into a constant heartbeat —
    // they are handled by the slower DENIED_RECHECK_MS path below instead.
    if (
      messages.some((m) => !processedIds.has(m.message_id) && !deniedVersions.has(m.message_id))
    ) {
      await ensureAllowlist();
    }
    // While denied mail is waiting, re-check on a slow cadence so a sender added
    // to the allowlist later still gets delivered.
    if (deniedVersions.size > 0 && Date.now() - lastDeniedRecheck > DENIED_RECHECK_MS) {
      lastDeniedRecheck = Date.now();
      await ensureAllowlist({ force: true });
    }

    for (const msg of messages) {
      if (processedIds.has(msg.message_id)) continue;

      // Mark processed immediately (before any async work) so that a
      // concurrent or subsequent poll() call cannot pick up the same message.
      processedIds.add(msg.message_id);

      // Skip agent's own sent messages
      if (msg.labels?.includes("sent") && msg.from?.includes(INBOX)) {
        continue;
      }

      // Skip already-read messages
      if (!msg.labels?.includes("unread")) {
        continue;
      }

      // Allowlist check — hold back if sender is not permitted
      if (!isSenderAllowed(msg.from)) {
        // Never deny on a stale allowlist: confirm against fresh data before
        // holding mail back, but only once per set of rules so a denied message
        // sitting in the inbox doesn't re-query on every poll cycle.
        if (deniedVersions.get(msg.message_id) !== allowlistVersion) {
          await ensureAllowlist({ force: true });
        }
        if (!isSenderAllowed(msg.from)) {
          // Forget we saw it (it stays unread) so that if the sender is added to
          // the allowlist later, the message is still delivered rather than
          // dropped for the lifetime of this process.
          processedIds.delete(msg.message_id);
          if (deniedVersions.get(msg.message_id) !== allowlistVersion) {
            deniedVersions.set(msg.message_id, allowlistVersion);
            console.log(`  [blocked] From: ${msg.from} | not in allowlist — left unread`);
          }
          continue;
        }
      }
      deniedVersions.delete(msg.message_id);

      const fullMsg = await getMessage(msg.message_id);
      if (!fullMsg) continue;

      console.log(`  [new] From: ${msg.from} | Subject: ${msg.subject}`);
      const result = await forwardToGateway(fullMsg);
      console.log(`  [fwd] Gateway: ${result.status}`);
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

console.log(`=== Marketplace AgentMail Poller ===`);
console.log(`Inbox:    ${INBOX}`);
console.log(`Gateway:  ${GATEWAY_URL}/hooks/agentmail`);
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

// Fetch allowlist at startup; thereafter it refreshes lazily when mail arrives
// (see ensureAllowlist) rather than on a timer that would keep Postgres awake.
await ensureAllowlist({ force: true });
const managerLabel = allowlistCache.managerEmail ? ` (manager: ${allowlistCache.managerEmail})` : "";
console.log(`[allowlist] ${allowlistCache.allowedEmails.length} additional entries${managerLabel}`);

// Initial email poll — mark existing as seen without forwarding
const existing = await listMessages();
for (const msg of existing) {
  processedIds.add(msg.message_id);
}
console.log(
  `[ready] Watching for new emails... (${existing.length} existing messages skipped)\n`,
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
