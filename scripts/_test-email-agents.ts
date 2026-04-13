/**
 * Send test emails to both OPENCLAW and CUSTOM agents, then poll for replies.
 *
 * Usage: npx tsx --env-file=.env scripts/_test-email-agents.ts
 */

const AGENTMAIL_API = "https://api.agentmail.to/v0";
const API_KEY = process.env.AGENTMAIL_API_KEY!;

async function sendEmail(from: string, to: string, subject: string, text: string) {
  // First, ensure sender inbox exists
  try {
    await fetch(`${AGENTMAIL_API}/inboxes`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ username: from.split("@")[0], domain: "agentmail.to" }),
    });
  } catch {}

  const res = await fetch(`${AGENTMAIL_API}/inboxes/${from}/messages/send`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ to, subject, text }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Send failed (${res.status}): ${err}`);
  }
  const data = await res.json();
  console.log(`  Sent! Message ID: ${data.id || data.message?.id || "unknown"}`);
  return data;
}

async function checkInbox(inbox: string) {
  const res = await fetch(`${AGENTMAIL_API}/inboxes/${inbox}/messages?limit=5`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data.messages || [];
}

async function main() {
  const senderEmail = "saiha-test@agentmail.to";
  const openclawEmail = "general-ops-alex-test-company@agentmail.to";
  const customEmail = "test-langchain-agent-test-company@agentmail.to";

  console.log("=== Sending test emails to both agents ===\n");

  // Send to OpenClaw agent
  console.log(`1. Sending to OPENCLAW (${openclawEmail})...`);
  await sendEmail(
    senderEmail,
    openclawEmail,
    "Quick question about our Q2 plan",
    "Hi Alex,\n\nCan you help me draft a summary of our Q2 priorities? We need to share it with the team by Friday.\n\nAlso, could you look up when our next board meeting is scheduled?\n\nThanks,\nSaiha",
  );

  // Send to Custom agent
  console.log(`\n2. Sending to CUSTOM (${customEmail})...`);
  await sendEmail(
    senderEmail,
    customEmail,
    "Research request: competitor analysis",
    "Hi,\n\nI need you to research our top 3 competitors in the AI agent marketplace space. For each, please provide:\n- Their main product\n- Pricing model\n- Key differentiators\n\nPlease compile this into a structured summary.\n\nBest,\nSaiha",
  );

  console.log("\n=== Emails sent! Waiting 60s for agents to process... ===\n");

  // Wait and poll for responses
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 10000));
    console.log(`\n--- Checking inbox at ${(i + 1) * 10}s ---`);

    const messages = await checkInbox(senderEmail);
    const newReplies = messages.filter(
      (m: any) =>
        m.from &&
        (m.from.includes("general-ops-alex") || m.from.includes("test-langchain-agent")),
    );

    if (newReplies.length > 0) {
      console.log(`  Found ${newReplies.length} reply(s):`);
      for (const msg of newReplies) {
        console.log(`\n  From: ${msg.from}`);
        console.log(`  Subject: ${msg.subject}`);
        console.log(`  Text preview: ${(msg.text || "").substring(0, 300)}...`);
      }
    } else {
      console.log("  No replies yet...");
    }

    // Also check the approval queues
    try {
      const ocDep = "cmnvzw3wj0004rs9c139nsjpn";
      const cusDep = "cmnvzw3wz000ars9ce4qrujqz";

      const ocApprovals = await fetch(
        `http://localhost:3002/api/deployments/${ocDep}/approvals`,
      ).then((r) => r.json()).catch(() => ({ approvals: [] }));
      const cusApprovals = await fetch(
        `http://localhost:3002/api/deployments/${cusDep}/approvals`,
      ).then((r) => r.json()).catch(() => ({ approvals: [] }));

      const ocPending = (ocApprovals.approvals || []).filter((a: any) => a.status === "PENDING");
      const cusPending = (cusApprovals.approvals || []).filter((a: any) => a.status === "PENDING");

      if (ocPending.length > 0) {
        console.log(`  OPENCLAW has ${ocPending.length} pending approval(s)`);
        for (const a of ocPending) {
          console.log(`    - [${a.taskType}] ${(a.draft || "").substring(0, 150)}...`);
        }
      }
      if (cusPending.length > 0) {
        console.log(`  CUSTOM has ${cusPending.length} pending approval(s)`);
        for (const a of cusPending) {
          console.log(`    - [${a.taskType}] ${(a.draft || "").substring(0, 150)}...`);
        }
      }
    } catch {}

    if (newReplies.length >= 2) {
      console.log("\n=== Both agents replied! Test complete. ===");
      break;
    }
  }
}

main().catch(console.error);
