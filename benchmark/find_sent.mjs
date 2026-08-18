// Recover a task from the buyer's Sent Items, as it was actually sent.
//
//   node --env-file=.env.prod find_sent.mjs "need to reorder" [--json]
//
// The E-round tasks were sent by scripts that no longer exist, so their text
// survived only in the mailbox. Reconstructing one from the reply it produced
// would be inventing the question from the answer, which is how a fixture comes
// to agree with whatever belief wrote it.
const MAILBOX = "sai@agents.agentstore.it.com";
const NEEDLE = (process.argv[2] || "").toLowerCase();
const AS_JSON = process.argv.includes("--json");

if (!NEEDLE) {
  console.error('usage: find_sent.mjs "part of the subject" [--json]');
  process.exit(2);
}

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

const H = { Authorization: "Bearer " + (await token()) };
const u =
  `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(MAILBOX)}` +
  `/mailFolders/sentitems/messages` +
  `?$top=100&$select=id,subject,sentDateTime,body,hasAttachments&$orderby=sentDateTime desc`;

const j = await (await fetch(u, { headers: H })).json();
const hits = (j.value || []).filter((m) => (m.subject || "").toLowerCase().includes(NEEDLE));

if (!hits.length) {
  console.error(`nothing sent with "${NEEDLE}" in the subject`);
  process.exit(1);
}

// Oldest first: the original, not a re-send.
hits.sort((a, b) => new Date(a.sentDateTime) - new Date(b.sentDateTime));
const m = hits[0];

const att = m.hasAttachments
  ? await (
      await fetch(
        `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(MAILBOX)}` +
          `/messages/${m.id}/attachments`,
        { headers: H }
      )
    ).json()
  : { value: [] };

const text = (m.body?.content || "")
  .replace(/<br\s*\/?>/gi, "\n")
  .replace(/<\/p>/gi, "\n")
  .replace(/<[^>]+>/g, "")
  .replace(/&nbsp;/g, " ")
  .replace(/&quot;/g, String.fromCharCode(34))
  .replace(/&#39;/g, "'")
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">")
  .replace(/&amp;/g, "&")
  .trim();

if (AS_JSON) {
  console.log(
    JSON.stringify(
      {
        subject: m.subject,
        body: text,
        attachments: (att.value || []).map((a) => ({
          name: a.name,
          ctype: a.contentType,
          b64: a.contentBytes,
        })),
      },
      null,
      2
    )
  );
} else {
  console.log("sent    :", m.sentDateTime);
  console.log("subject :", m.subject);
  console.log("files   :", (att.value || []).map((a) => a.name).join(", ") || "none");
  console.log();
  console.log(text);
}
