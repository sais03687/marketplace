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
  return res.json() as Promise<T>;
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

export async function setInboxWebhook(
  inboxId: string,
  webhookUrl: string,
): Promise<void> {
  await agentMailFetch(`/inboxes/${encodeURIComponent(inboxId)}`, {
    method: "PATCH",
    body: { webhook_url: webhookUrl },
  });
}

export async function deleteInbox(inboxId: string): Promise<void> {
  await agentMailFetch(`/inboxes/${encodeURIComponent(inboxId)}`, {
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
    `/inboxes/${encodeURIComponent(inboxId)}/messages/send`,
    {
      method: "POST",
      body: { to, subject, text },
    },
  );
  return { messageId: raw.message_id, threadId: raw.thread_id };
}
