// One-shot: forward the newest unread email from the user through the adapter
// webhook to verify the reply_email fix end-to-end.
const key = process.env.AGENTMAIL_API_KEY;
const inbox = "test-langchain-agent-my-company@agentmail.to";

const r = await fetch(
  `https://api.agentmail.to/v0/inboxes/${inbox}/messages?limit=10`,
  { headers: { Authorization: `Bearer ${key}` } },
);
const data = await r.json();
const all = data.messages || data.data || data;

// Find the newest message from the user (not a sent message)
const incoming = all.filter(
  (m) => !(m.labels?.includes("sent") && m.from?.includes(inbox)),
);
if (incoming.length === 0) {
  console.log("No incoming messages found");
  process.exit(0);
}
const msg = incoming[0]; // newest

const full = await (
  await fetch(
    `https://api.agentmail.to/v0/inboxes/${inbox}/messages/${encodeURIComponent(msg.message_id)}`,
    { headers: { Authorization: `Bearer ${key}` } },
  )
).json();

console.log("Forwarding newest incoming message");
console.log("  message_id:", full.message_id);
console.log("  from:      ", full.from);
console.log("  subject:   ", full.subject);
console.log("  preview:   ", (full.text || full.preview || "").slice(0, 200));
console.log();

const payload = {
  type: "webhook",
  event_type: "message.received",
  event_id: full.message_id,
  message: {
    message_id: full.message_id,
    inbox_id: full.inbox_id,
    thread_id: full.thread_id,
    from: full.from,
    to: full.to,
    subject: full.subject,
    text: full.text || full.preview || "",
    html: full.html || "",
  },
  thread: { thread_id: full.thread_id, subject: full.subject },
};

const res = await fetch("http://127.0.0.1:4100/hooks/agentmail", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});
console.log("Webhook status:", res.status, await res.text());
