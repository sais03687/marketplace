/**
 * Send test emails to both OPENCLAW and CUSTOM agents and monitor for replies.
 * Tests:
 * 1. Basic email reply capability
 * 2. Google Workspace integration (ask agent to create a Google Doc)
 */
import { setTimeout as sleep } from "node:timers/promises";

const AGENTMAIL_API_KEY = "am_us_418452a2d1d07f40fe418274c1ac9902d162d4036426399a4eb0ca383aea2e23";
const AGENTMAIL_API_BASE = "https://api.agentmail.to/v0";

// We'll send FROM the existing test inbox
const SENDER_EMAIL = "saiha-test@agentmail.to";
let senderInboxId: string = "saiha-test@agentmail.to";

const AGENTS = [
  {
    name: "Alex (OpenClaw)",
    runtime: "OPENCLAW",
    email: "general-ops-alex-test-company@agentmail.to",
  },
  {
    name: "LangChain Agent (Custom)",
    runtime: "CUSTOM",
    email: "test-langchain-agent-test-company@agentmail.to",
  },
];

async function agentMailFetch<T>(path: string, opts: { method?: string; body?: Record<string, unknown> } = {}): Promise<T> {
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
}

async function ensureSenderInbox() {
  // Use the pre-existing saiha-test inbox
  const list = await agentMailFetch<{ inboxes: Array<{ inbox_id: string; email: string }> }>("/inboxes");
  const existing = list.inboxes.find((i: any) => i.email === SENDER_EMAIL);
  if (!existing) throw new Error(`Cannot find sender inbox: ${SENDER_EMAIL}`);
  senderInboxId = existing.inbox_id;
  console.log(`Sender inbox: ${existing.email} (${senderInboxId})`);
}

async function sendEmail(to: string, subject: string, text: string) {
  const raw = await agentMailFetch<{ message_id: string; thread_id: string }>(
    `/inboxes/${encodeURIComponent(senderInboxId)}/messages/send`,
    { method: "POST", body: { to, subject, text } },
  );
  return raw;
}

async function checkForReplies(threadId: string, maxWaitS: number = 180): Promise<string | null> {
  const startTime = Date.now();
  const pollInterval = 10_000; // 10 seconds

  while (Date.now() - startTime < maxWaitS * 1000) {
    const messages = await agentMailFetch<{ messages: Array<{ message_id: string; from: string; text: string; subject: string }> }>(
      `/inboxes/${encodeURIComponent(senderInboxId)}/messages`,
    );

    // Look for replies in this thread (messages from the agent, not from us)
    for (const msg of messages.messages || []) {
      if (msg.from && !msg.from.includes("saiha-test@") && msg.subject?.includes("Re:")) {
        // Check if this is a reply to our thread
        const fullMsg = await agentMailFetch<any>(
          `/inboxes/${encodeURIComponent(senderInboxId)}/messages/${encodeURIComponent(msg.message_id)}`,
        );
        if (fullMsg.thread_id === threadId) {
          return fullMsg.text || fullMsg.preview || "(empty reply)";
        }
      }
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    process.stdout.write(`  Waiting for reply... ${elapsed}s / ${maxWaitS}s\r`);
    await sleep(pollInterval);
  }

  return null;
}

async function main() {
  console.log("=== Agent Email Test ===\n");

  await ensureSenderInbox();

  for (const agent of AGENTS) {
    console.log(`\n--- Testing ${agent.name} (${agent.runtime}) ---`);
    console.log(`  Sending to: ${agent.email}`);

    // Test 1: Basic reply
    const subject1 = `Test ${Date.now()}: Hello from tester`;
    const text1 = `Hi ${agent.name}!

This is a test email. Please reply with a brief greeting and confirm you can see this message. Keep your response short (1-2 sentences).

Thanks!`;

    console.log(`\n  [Test 1] Sending basic greeting...`);
    const msg1 = await sendEmail(agent.email, subject1, text1);
    console.log(`  Sent: threadId=${msg1.thread_id}`);

    const reply1 = await checkForReplies(msg1.thread_id, 120);
    if (reply1) {
      console.log(`  \n  REPLY RECEIVED:`);
      console.log(`  ${reply1.slice(0, 500)}`);
    } else {
      console.log(`  \n  NO REPLY after 120s`);
    }

    // Brief pause between tests
    await sleep(5000);

    // Test 2: Google Workspace task
    const subject2 = `Test ${Date.now()}: Google Doc task`;
    const text2 = `Hi ${agent.name},

Please create a new Google Doc titled "Test Document - ${agent.runtime} Agent" with the following content:

"This is a test document created by the ${agent.runtime} agent to verify Google Workspace integration is working correctly. Created at: ${new Date().toISOString()}"

After creating the doc, please share the link with me in your reply.

Thanks!`;

    console.log(`\n  [Test 2] Sending Google Doc creation task...`);
    const msg2 = await sendEmail(agent.email, subject2, text2);
    console.log(`  Sent: threadId=${msg2.thread_id}`);

    const reply2 = await checkForReplies(msg2.thread_id, 180);
    if (reply2) {
      console.log(`  \n  REPLY RECEIVED:`);
      console.log(`  ${reply2.slice(0, 500)}`);
    } else {
      console.log(`  \n  NO REPLY after 180s`);
    }

    console.log(`\n  --- Done testing ${agent.name} ---`);
  }

  console.log("\n=== All tests complete ===");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
