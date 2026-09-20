/**
 * Outbound mail through Resend.
 *
 * Graph is still here and still works; this sits in front of it when
 * RESEND_API_KEY is set. Two things make it worth the swap:
 *
 *   1. Deliverability. On 2026-09-20 Gmail began rejecting this domain outright
 *      (550 5.7.1, "likely unsolicited mail") after two days of test traffic.
 *      Authentication was correct throughout — SPF -all, both DKIM selectors
 *      published, DMARC inherited — so the verdict was about the sender, not the
 *      records. Exchange Online's shared outbound IPs are not a transactional
 *      sender and have no reputation to lend a young domain.
 *
 *   2. Honesty. Graph's sendMail returns 202 when it accepts a message for
 *      queueing, which is not delivery and reads exactly like it. Resend reports
 *      hard failures, and the id it returns can be traced afterwards.
 *
 * Sending only. The agent keeps its Microsoft mailbox and the poller keeps
 * reading it; the From address does not change, so replies still land where the
 * MX record points.
 */
/**
 * Read straight from the environment rather than through config.ts, so this
 * module can be imported and exercised on its own. Read per call, not once at
 * import, for the same reason.
 */
function apiKey(): string {
  return process.env.RESEND_API_KEY || "";
}

export interface OutboundAttachment {
  name: string;
  contentType: string;
  content_base64: string;
}

export interface OutboundMail {
  /** The mailbox this is sent as. Must be on a domain verified with Resend. */
  from: string;
  /** Display name, so the agent still appears under its own name. */
  fromName?: string;
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  bodyType?: "text" | "html";
  attachments?: OutboundAttachment[];
  /**
   * The Message-ID of the message being answered, angle brackets included. Graph
   * threaded replies for us through /messages/{id}/reply; sending directly means
   * threading is ours to do, and a reply that does not carry these headers starts
   * a new conversation in the recipient's client — which, for an agent whose work
   * arrives as a reply, loses the request it was answering.
   */
  inReplyTo?: string;
  /** The References chain of the message being answered, if it had one. */
  references?: string;
}

export interface SendResult {
  ok: boolean;
  /** Resend's id for the message, for tracing a delivery afterwards. */
  id?: string;
  status?: number;
  error?: string;
}

export function resendConfigured(): boolean {
  return Boolean(apiKey());
}

/**
 * RFC 5322 display names are quoted-strings: a bare quote or backslash inside
 * one ends it early, which would let an agent name chosen by a buyer rewrite the
 * header. Everything else stays as typed.
 */
function formatFrom(address: string, name?: string): string {
  const clean = (name || "").replace(/[\\"]/g, "").replace(/[\r\n]/g, " ").trim();
  return clean ? `${JSON.stringify(clean)} <${address}>` : address;
}

export async function sendViaResend(mail: OutboundMail): Promise<SendResult> {
  const key = apiKey();
  if (!key) return { ok: false, error: "RESEND_API_KEY not set" };

  const isHtml = (mail.bodyType ?? "html") === "html";

  // In-Reply-To and References are what make a reply a reply. Only set when we
  // actually know the id — a fabricated one threads the message nowhere.
  const headers: Record<string, string> = {};
  if (mail.inReplyTo) {
    headers["In-Reply-To"] = mail.inReplyTo;
    headers["References"] = mail.references
      ? `${mail.references} ${mail.inReplyTo}`
      : mail.inReplyTo;
  }

  const payload: Record<string, unknown> = {
    from: formatFrom(mail.from, mail.fromName),
    to: mail.to,
    subject: mail.subject,
    [isHtml ? "html" : "text"]: mail.body,
  };
  if (mail.cc?.length) payload.cc = mail.cc;
  if (Object.keys(headers).length > 0) payload.headers = headers;
  if (mail.attachments?.length) {
    payload.attachments = mail.attachments.map((a) => ({
      filename: a.name,
      content: a.content_base64,
      content_type: a.contentType,
    }));
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
    });

    const text = await res.text();
    if (!res.ok) {
      // Logged in full here because the caller turns this into one line. A send
      // that fails for a fixable reason — an unverified domain, a rejected
      // attachment — should say which.
      console.error(`[resend] ${res.status}: ${text.slice(0, 400)}`);
      return { ok: false, status: res.status, error: text.slice(0, 200) };
    }

    let id: string | undefined;
    try {
      id = (JSON.parse(text) as { id?: string }).id;
    } catch {
      // A 2xx whose body does not parse still sent the message.
    }
    return { ok: true, id };
  } catch (err: any) {
    console.error(`[resend] request failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
}
