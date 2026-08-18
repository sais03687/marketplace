// Wait for the agent's reply to land in the buyer's mailbox, and print it.
//
// Replaces the dump_daily / dump_e1 / dump_eval / dump_f3 / dump_fresh family:
// each test round grew its own copy with the subject hard-coded, so a fix to one
// never reached the others and nothing accumulated between rounds. The subject
// is an argument here.
//
//   node --env-file=.env.prod await_reply.mjs --contains "Q3 utilisation"
//        [--since ISO] [--timeout 900] [--json]
//
// Exits 0 when a real reply arrives, 1 on timeout. A status note ("Not finished
// yet"), the approval card, and anything the buyer sent themselves are skipped
// rather than mistaken for the answer.
const MAILBOX = "sai@agents.agentstore.it.com";

function arg(name, fallback = null) {
  const i = process.argv.indexOf("--" + name);
  return i === -1 ? fallback : process.argv[i + 1];
}

// Substring, not regex: subjects contain brackets and question marks, and a
// subject is data rather than a pattern.
const CONTAINS = (arg("contains", "") || "").toLowerCase();
const SINCE = new Date(arg("since", new Date(Date.now() - 3600e3).toISOString()));
const TIMEOUT = Number(arg("timeout", 900)) * 1000;
const AS_JSON = process.argv.includes("--json");

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

const chr34 = String.fromCharCode(34);

const strip = (html) =>
  (html || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, chr34)
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    // Last, or an entity spelled &amp;quot; would be decoded twice.
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .trim();

async function look(H) {
  const u =
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(MAILBOX)}/messages` +
    `?$top=25&$select=id,subject,receivedDateTime,body,from,hasAttachments` +
    `&$orderby=receivedDateTime desc`;
  const j = await (await fetch(u, { headers: H })).json();
  for (const m of j.value || []) {
    const subject = m.subject || "";
    if (new Date(m.receivedDateTime) < SINCE) continue;
    if (!/data-analyst/i.test(m.from?.emailAddress?.address || "")) continue;
    if (CONTAINS && !subject.toLowerCase().includes(CONTAINS)) continue;
    if (/^Action needed:/i.test(subject)) continue; // the approval card
    const body = strip(m.body?.content);
    if (/Not finished yet/i.test(body.slice(0, 200))) continue; // a status note
    const att = m.hasAttachments
      ? await (
          await fetch(
            `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(MAILBOX)}` +
              `/messages/${m.id}/attachments`,
            { headers: H }
          )
        ).json()
      : { value: [] };
    return {
      received: m.receivedDateTime,
      subject,
      attachments: (att.value || []).map((x) => x.name),
      body,
    };
  }
  return null;
}

const H = { Authorization: "Bearer " + (await token()) };
const deadline = Date.now() + TIMEOUT;
for (;;) {
  const hit = await look(H);
  if (hit) {
    if (AS_JSON) {
      console.log(JSON.stringify(hit, null, 2));
    } else {
      console.log("received    :", hit.received);
      console.log("subject     :", hit.subject);
      console.log("attachments :", hit.attachments.join(", ") || "NONE");
      console.log();
      console.log(hit.body);
    }
    process.exit(0);
  }
  if (Date.now() > deadline) {
    console.error(`no reply containing "${CONTAINS}" within ${TIMEOUT / 1000}s`);
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 15000));
}
