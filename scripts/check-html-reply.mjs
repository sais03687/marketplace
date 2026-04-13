const key = process.env.AGENTMAIL_API_KEY;
const inbox = "test-langchain-agent-my-company@agentmail.to";
const r = await fetch(
  `https://api.agentmail.to/v0/inboxes/${inbox}/messages?limit=2`,
  { headers: { Authorization: `Bearer ${key}` } },
);
const msgs = (await r.json()).messages;
const full = await (
  await fetch(
    `https://api.agentmail.to/v0/inboxes/${inbox}/messages/${encodeURIComponent(msgs[0].message_id)}`,
    { headers: { Authorization: `Bearer ${key}` } },
  )
).json();
console.log("timestamp:", full.timestamp);
console.log("subject:", full.subject);
console.log("has html?", !!full.html, "len:", (full.html || "").length);
console.log("has text?", !!full.text, "len:", (full.text || "").length);
console.log("\nHTML preview (first 1800 chars):");
console.log((full.html || "").slice(0, 1800));
console.log("\nTEXT preview (first 500 chars):");
console.log((full.text || "").slice(0, 500));
