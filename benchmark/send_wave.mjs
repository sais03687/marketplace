// Send a wave of benchmark tasks as real mail from the buyer to the agent.
// Transport only — the agent's inbox sees an ordinary message either way.
import fs from "node:fs";

const FROM = "sai@agents.agentstore.it.com";
const TO = "data-analyst-acme-corp-az3d9btj@agents.agentstore.it.com";

const ids = process.argv.slice(2);
if (!ids.length) {
  console.error("usage: node send_wave.mjs T01 T02 ...");
  process.exit(1);
}

const all = JSON.parse(fs.readFileSync("/root/bench/emails.json", "utf8"));

async function token() {
  const q = new URLSearchParams({
    client_id: process.env.MICROSOFT_CLIENT_ID,
    client_secret: process.env.MICROSOFT_CLIENT_SECRET,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });
  const r = await fetch(
    `https://login.microsoftonline.com/${process.env.MICROSOFT_TENANT_ID}/oauth2/v2.0/token`,
    { method: "POST", body: q }
  );
  const j = await r.json();
  if (!j.access_token) throw new Error("token: " + JSON.stringify(j).slice(0, 200));
  return j.access_token;
}

const t = await token();

for (const id of ids) {
  const e = all.find((x) => x.id === id);
  if (!e) { console.log(`${id}: NOT FOUND`); continue; }

  const message = {
    subject: e.subject,
    body: { contentType: "Text", content: e.body },
    toRecipients: [{ emailAddress: { address: TO } }],
  };
  if (e.attachment) {
    message.attachments = [{
      "@odata.type": "#microsoft.graph.fileAttachment",
      name: e.attachment.name,
      contentType: e.attachment.ctype,
      contentBytes: e.attachment.b64,
    }];
  }

  const r = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(FROM)}/sendMail`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
      body: JSON.stringify({ message, saveToSentItems: true }),
    }
  );
  console.log(`${id}: ${r.status === 202 ? "sent" : "FAILED " + r.status + " " + (await r.text()).slice(0, 160)}`);
  await new Promise((s) => setTimeout(s, 1500));
}
