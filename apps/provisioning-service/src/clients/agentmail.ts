import { config } from "../config.js";

interface CreateInboxResult {
  id: string;
  email_address: string;
}

async function agentMailFetch<T>(
  path: string,
  opts: { method?: string; body?: Record<string, unknown> } = {},
): Promise<T> {
  const res = await fetch(`${config.agentMailApiBase}${path}`, {
    method: opts.method ?? "GET",
    headers: {
      Authorization: `Bearer ${config.agentMailApiKey}`,
      "Content-Type": "application/json",
    },
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`AgentMail API error ${res.status}: ${text}`);
  }
  // Some endpoints (DELETE) return 204 or empty body
  if (res.status === 204 || res.headers.get("content-length") === "0") {
    return undefined as T;
  }
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

export async function createInbox(
  username: string,
  domain: string,
  webhookUrl?: string,
): Promise<CreateInboxResult> {
  const body: Record<string, unknown> = { username, domain };
  if (webhookUrl) {
    body.webhook_url = webhookUrl;
  }
  try {
    const raw = await agentMailFetch<{ inbox_id: string; email: string }>("/inboxes", {
      method: "POST",
      body,
    });
    return { id: raw.inbox_id, email_address: raw.email };
  } catch (err: any) {
    // If inbox already exists or we've hit the limit, try to find an existing matching inbox
    if (err.message?.includes("AlreadyExistsError") || err.message?.includes("LimitExceededError")) {
      const email = `${username}@${domain}`;
      const list = await agentMailFetch<{ inboxes: Array<{ inbox_id: string; email: string }> }>("/inboxes");
      const existing = list.inboxes.find((i) => i.email === email);
      if (existing) return { id: existing.inbox_id, email_address: existing.email };
    }
    throw err;
  }
}

// AgentMail uses the email address as the inbox path param.
// encodeURIComponent turns '@' into '%40' which the API doesn't resolve, so
// we encode only the characters that are not valid in a URL path segment,
// leaving '@' and '.' unencoded.
function encodeInboxId(id: string): string {
  return id.replace(/[^A-Za-z0-9._@\-]/g, (c) => encodeURIComponent(c));
}

export async function setInboxWebhook(
  inboxId: string,
  webhookUrl: string,
  displayName?: string,
): Promise<void> {
  await agentMailFetch(`/inboxes/${encodeInboxId(inboxId)}`, {
    method: "PATCH",
    body: { webhook_url: webhookUrl, display_name: displayName || "Agent" },
  });
}

export async function deleteInbox(inboxId: string): Promise<void> {
  await agentMailFetch(`/inboxes/${encodeInboxId(inboxId)}`, {
    method: "DELETE",
  });
}

export async function sendEmail(
  inboxId: string,
  to: string,
  subject: string,
  text: string,
): Promise<{ messageId: string; threadId: string }> {
  const raw = await agentMailFetch<{ message_id: string; thread_id: string }>(
    `/inboxes/${encodeInboxId(inboxId)}/messages/send`,
    {
      method: "POST",
      body: { to, subject, text },
    },
  );
  return { messageId: raw.message_id, threadId: raw.thread_id };
}
