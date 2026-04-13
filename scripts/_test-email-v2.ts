/**
 * Send test emails to both agents — focused test with retry on DNS failures.
 */
import { setTimeout as sleep } from "node:timers/promises";

const AGENTMAIL_API_KEY = "am_us_418452a2d1d07f40fe418274c1ac9902d162d4036426399a4eb0ca383aea2e23";
const AGENTMAIL_API_BASE = "https://api.agentmail.to/v0";
const SENDER_INBOX = "saiha-test@agentmail.to";

async function agentMailFetch<T>(path: string, opts: { method?: string; body?: Record<string, unknown> } = {}, retries = 3): Promise<T> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${AGENTMAIL_API_BASE}${path}`, {
        method: opts.method ?? "GET",
        headers: {
          Authorization: `Bearer ${AGENTMAIL_API_KEY}`,
          "Content-Type": "application/json",
        },
        ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`AgentMail API error ${res.status}: ${text}`);
      }
      return res.json() as Promise<T>;
    } catch (err: any) {
      if (attempt < retries && (err.cause?.code === "ENOTFOUND" || err.message?.includes("fetch failed"))) {
        console.log(`  [DNS retry] attempt ${attempt}/${retries}, waiting 5s...`);
        await sleep(5000);
        continue;
      }
      throw err;
    }
  }
  throw new Error("unreachable");
}

async function sendEmail(to: string, subject: string, text: string) {
  return agentMailFetch<{ message_id: string; thread_id: string }>(
    `/inboxes/${encodeURIComponent(SENDER_INBOX)}/messages/send`,
    { method: "POST", body: { to, subject, text } },
  );
}

const seenReplyIds = new Set<string>();

async function checkForReplies(threadId: string, maxWaitS: number = 180): Promise<string | null> {
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitS * 1000) {
    try {
      const messages = await agentMailFetch<{ messages: Array<any> }>(
        `/inboxes/${encodeURIComponent(SENDER_INBOX)}/messages`,
      );

      for (const msg of messages.messages || []) {
        if (seenReplyIds.has(msg.message_id)) continue;
        if (msg.from && !msg.from.includes("saiha-test@")) {
          const fullMsg = await agentMailFetch<any>(
            `/inboxes/${encodeURIComponent(SENDER_INBOX)}/messages/${encodeURIComponent(msg.message_id)}`,
          );
          if (fullMsg.thread_id === threadId) {
            seenReplyIds.add(msg.message_id);
            return fullMsg.text || fullMsg.preview || "(empty reply)";
          }
        }
      }
    } catch (err: any) {
      console.log(`  [poll error] ${err.message}, retrying...`);
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    process.stdout.write(`  Waiting for reply... ${elapsed}s / ${maxWaitS}s\r`);
    await sleep(10_000);
  }

  return null;
}

async function main() {
  console.log("=== Agent Email Test v2 ===\n");

  // ─── Test 1: CUSTOM agent basic reply ─────────────────────────────
  {
    const agent = "LangChain Agent (Custom)";
    const email = "test-langchain-agent-test-company@agentmail.to";

    console.log(`\n[1] Testing ${agent} — basic reply`);
    const msg = await sendEmail(email, `Test ${Date.now()}: Hello`,
      `Hi! This is a test. Please reply with a brief greeting. Keep it to 1-2 sentences.`);
    console.log(`  Sent: thread=${msg.thread_id}`);

    const reply = await checkForReplies(msg.thread_id, 120);
    console.log(reply
      ? `\n  REPLY: ${reply.slice(0, 500)}`
      : `\n  NO REPLY after 120s`);
  }

  await sleep(3000);

  // ─── Test 2: OPENCLAW agent Google Doc task ──────────────────────
  {
    const agent = "Alex (OpenClaw)";
    const email = "general-ops-alex-test-company@agentmail.to";

    console.log(`\n[2] Testing ${agent} — Google Doc creation`);
    const msg = await sendEmail(email, `Test ${Date.now()}: Create a Google Doc`,
      `Hi Alex, please create a new Google Doc titled "Agent Test Doc" with the content: "Hello from the OpenClaw agent test, created at ${new Date().toISOString()}". Reply with the doc link.`);
    console.log(`  Sent: thread=${msg.thread_id}`);

    const reply = await checkForReplies(msg.thread_id, 180);
    console.log(reply
      ? `\n  REPLY: ${reply.slice(0, 500)}`
      : `\n  NO REPLY after 180s`);
  }

  await sleep(3000);

  // ─── Test 3: CUSTOM agent Google Sheets task ─────────────────────
  {
    const agent = "LangChain Agent (Custom)";
    const email = "test-langchain-agent-test-company@agentmail.to";

    console.log(`\n[3] Testing ${agent} — Google Sheets task`);
    const msg = await sendEmail(email, `Test ${Date.now()}: Google Sheets task`,
      `Hi! I've shared a Google Sheet with you at the service account email (alex-agent@ai-employee-490819.iam.gserviceaccount.com). Can you check what files are shared with you on Google Drive and list them? Just list the file names you can see.`);
    console.log(`  Sent: thread=${msg.thread_id}`);

    const reply = await checkForReplies(msg.thread_id, 180);
    console.log(reply
      ? `\n  REPLY: ${reply.slice(0, 500)}`
      : `\n  NO REPLY after 180s`);
  }

  console.log("\n\n=== All tests complete ===");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
