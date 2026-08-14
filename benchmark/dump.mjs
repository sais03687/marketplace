// Dump each benchmark reply and its attachments, so scoring can read the
// workbook and not just the email body. Panko's error-rate baseline is about
// what is IN the spreadsheet; scoring the prose alone cannot speak to it.
import fs from "node:fs";

const MAILBOX = "sai@agents.agentstore.it.com";
const OUT = "/root/bench/dump";

async function token() {
  const q = new URLSearchParams({
    client_id: process.env.MICROSOFT_CLIENT_ID,
    client_secret: process.env.MICROSOFT_CLIENT_SECRET,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });
  const r = await fetch(
    `https://login.microsoftonline.com/${process.env.MICROSOFT_TENANT_ID}/oauth2/v2.0/token`,
    { method: "POST", body: q });
  const j = await r.json();
  if (!j.access_token) throw new Error("token: " + JSON.stringify(j).slice(0, 200));
  return j.access_token;
}

const t = await token();
const H = { Authorization: `Bearer ${t}` };
fs.mkdirSync(OUT, { recursive: true });

const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(MAILBOX)}/messages` +
  `?$top=150&$select=id,subject,receivedDateTime,body,from,hasAttachments&$orderby=receivedDateTime desc`;
const j = await (await fetch(url, { headers: H })).json();
if (!j.value) { console.log("graph error", JSON.stringify(j).slice(0, 200)); process.exit(1); }

const seen = new Set();
for (const m of j.value) {
  const tag = (m.subject || "").match(/\[(T\d\d)\]/);
  if (!tag) continue;
  const id = tag[1];
  if (seen.has(id)) continue;
  if (!/data-analyst/i.test(m.from?.emailAddress?.address || "")) continue;
  if (new Date(m.receivedDateTime) < new Date("2026-08-12T15:40:00Z")) continue;
  const body = (m.body?.content || "").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&quot;/g, '"').replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ");
  if (/requires manager approval/i.test(body)) continue;   // the pending notice
  seen.add(id);

  fs.writeFileSync(`${OUT}/${id}.body.txt`, body);
  let names = [];
  if (m.hasAttachments) {
    const a = await (await fetch(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(MAILBOX)}/messages/${m.id}/attachments`,
      { headers: H })).json();
    for (const att of a.value || []) {
      if (!att.contentBytes) continue;
      const safe = String(att.name).replace(/[^A-Za-z0-9._-]/g, "_");
      fs.writeFileSync(`${OUT}/${id}__${safe}`, Buffer.from(att.contentBytes, "base64"));
      names.push(att.name);
    }
  }
  console.log(`${id}  body ${String(body.length).padStart(5)}b  attachments: ${names.join(", ") || "none"}`);
}
console.log(`\ndumped ${seen.size} replies`);
