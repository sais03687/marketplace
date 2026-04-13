/**
 * Test round 3: Simple tasks both agents can do.
 * Focus on email reply + drive reading (not doc creation).
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
        throw new Error(`AgentMail ${res.status}: ${text}`);
      }
      return res.json() as Promise<T>;
    } catch (err: any) {
      if (attempt < retries && (err.cause?.code === "ENOTFOUND" || err.message?.includes("fetch failed"))) {
        console.log(`  [retry ${attempt}/${retries}] DNS error, waiting 5s...`);
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

async function checkForReplies(threadId: string, maxWaitS: number): Promise<string | null> {
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
      console.log(`  [poll error: ${err.message}]`);
    }
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    process.stdout.write(`  Waiting... ${elapsed}s/${maxWaitS}s\r`);
    await sleep(10_000);
  }
  return null;
}

async function test(label: string, to: string, subject: string, text: string, maxWaitS = 120) {
  console.log(`\n[${label}] → ${to}`);
  const msg = await sendEmail(to, subject, text);
  console.log(`  Sent: thread=${msg.thread_id}`);
  const reply = await checkForReplies(msg.thread_id, maxWaitS);
  if (reply) {
    console.log(`\n  REPLY:`);
    console.log(`  ${reply.slice(0, 600).replace(/\n/g, '\n  ')}`);
    return true;
  }
  console.log(`\n  NO REPLY after ${maxWaitS}s`);
  return false;
}

async function main() {
  console.log("=== Agent Email Test v3 ===");
  const ts = Date.now();
  const results: Record<string, boolean> = {};

  // 1. CUSTOM — basic reply (should work now with "never" approval)
  results["CUSTOM-reply"] = await test(
    "CUSTOM basic reply",
    "test-langchain-agent-test-company@agentmail.to",
    `Test ${ts}: Quick hello`,
    "Hi! Just confirming you're online. Reply with a brief greeting (1 sentence max).",
    90,
  );

  // 2. OPENCLAW — basic reply
  results["OPENCLAW-reply"] = await test(
    "OPENCLAW basic reply",
    "general-ops-alex-test-company@agentmail.to",
    `Test ${ts}: Quick hello`,
    "Hi Alex! Just confirming you're online. Reply with a brief greeting (1 sentence max).",
    90,
  );

  // 3. CUSTOM — list Drive files
  results["CUSTOM-drive"] = await test(
    "CUSTOM Drive listing",
    "test-langchain-agent-test-company@agentmail.to",
    `Test ${ts}: List Drive files`,
    "Can you check what Google Drive files are shared with your service account and list their names? Use the drive tools available to you.",
    120,
  );

  // 4. OPENCLAW — list Drive files
  results["OPENCLAW-drive"] = await test(
    "OPENCLAW Drive listing",
    "general-ops-alex-test-company@agentmail.to",
    `Test ${ts}: List Drive files`,
    "Alex, please list all Google Drive files that have been shared with you. Just the file names and types.",
    120,
  );

  console.log("\n\n=== Results ===");
  for (const [k, v] of Object.entries(results)) {
    console.log(`  ${v ? "PASS" : "FAIL"} — ${k}`);
  }
  const passed = Object.values(results).filter(Boolean).length;
  console.log(`\n  ${passed}/${Object.keys(results).length} passed`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
