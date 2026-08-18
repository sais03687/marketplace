// Approve a pending request the way a buyer does — through the link in the
// notification email.
//
// Without this the harness cannot run a task end to end: anything that queues
// for approval waits for a human, so chaos.sh would hang and the restart test
// would stay a thing done by hand. The approval is found in the mailbox rather
// than in the database on purpose. If the email carries a broken link, a
// harness that reaches around it into Postgres would never notice, and the
// buyer's only route to approving is the one thing left untested.
//
//   node --env-file=.env.prod approve.mjs --contains "Q3 utilisation" \
//        [--decision approve|reject] [--timeout 600]
//
// Exits 0 once an approval is resolved, 1 if none arrives in time.
const MAILBOX = "sai@agents.agentstore.it.com";

function arg(name, fallback = null) {
  const i = process.argv.indexOf("--" + name);
  return i === -1 ? fallback : process.argv[i + 1];
}

const CONTAINS = (arg("contains", "") || "").toLowerCase();
const DECISION = arg("decision", "approve");
const TIMEOUT = Number(arg("timeout", 600)) * 1000;
const SINCE = new Date(arg("since", new Date(Date.now() - 3600e3).toISOString()));

if (!["approve", "reject"].includes(DECISION)) {
  console.error("--decision must be approve or reject");
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

// The button points at a confirmation page; the mutation is the POST behind it.
// Both carry the same one-approval token, so this is the buyer's own credential
// and not a back door.
const LINK = /https?:\/\/[^\s"'<>]*\/approve\/action\/([A-Za-z0-9_-]+)\/(approve|reject)\?t=([a-f0-9]+)/;

async function findApproval(H) {
  const u =
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(MAILBOX)}/messages` +
    `?$top=25&$select=id,subject,receivedDateTime,body,from` +
    `&$orderby=receivedDateTime desc`;
  const j = await (await fetch(u, { headers: H })).json();
  for (const m of j.value || []) {
    if (new Date(m.receivedDateTime) < SINCE) continue;
    if (!/^Action needed:/i.test(m.subject || "")) continue;
    // The approval email's subject is a fixed shape - "Action needed: <agent>
    // needs approval for decision_request" - and never carries the task's own
    // subject, so matching on subject alone found nothing and every run that
    // raised a question sat unapproved until the harness gave up. The task is
    // named in the body instead, in the draft and the context.
    const hay = ((m.subject || "") + " " + (m.body?.content || "")).toLowerCase();
    if (CONTAINS && !hay.includes(CONTAINS)) continue;
    const hit = LINK.exec(m.body?.content || "");
    if (hit) return { subject: m.subject, id: hit[1], base: hit[0].split("/approve/action/")[0], t: hit[3] };
  }
  return null;
}

const H = { Authorization: "Bearer " + (await token()) };
const deadline = Date.now() + TIMEOUT;
for (;;) {
  const a = await findApproval(H);
  if (a) {
    const url = `${a.base}/api/approve-link/${a.id}/${DECISION}?t=${a.t}`;
    const r = await fetch(url, { method: "POST" });
    const body = await r.text();
    const ok = r.status === 200 && !/isn't valid|no longer|expired/i.test(body);
    console.log(`${DECISION}: ${a.subject}`);
    console.log(`  ${r.status} ${ok ? "resolved" : "REFUSED"}`);
    if (!ok) console.log("  " + body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 220));
    process.exit(ok ? 0 : 1);
  }
  if (Date.now() > deadline) {
    console.error(`no approval request containing "${CONTAINS}" within ${TIMEOUT / 1000}s`);
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 10000));
}
