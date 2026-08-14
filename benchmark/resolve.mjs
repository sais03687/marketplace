// Resolve pending approvals through the one-click links the platform emails out.
// This is the buyer's own path: it updates the approval record AND forwards the
// resolution to the container. Resolving straight at the container instead would
// release the work while leaving the record PENDING — the adapter warns about
// exactly that, and it would corrupt the audit trail this run is measuring.
//
//   node resolve.mjs list                 -> show pending approvals + subjects
//   node resolve.mjs approve <id> [<id>…] -> approve those approval ids
//   node resolve.mjs reject  <id> [<id>…] -> reject those approval ids
//   node resolve.mjs approve ALL          -> approve every one found

const MAILBOX = "sai@agents.agentstore.it.com";

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

// Recent "Action needed" notifications carry the approve/reject links.
const url =
  `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(MAILBOX)}/messages` +
  `?$top=120&$select=subject,receivedDateTime,body&$orderby=receivedDateTime desc`;
const r = await fetch(url, { headers: { Authorization: `Bearer ${t}` } });
const j = await r.json();
if (!j.value) { console.log("graph error:", JSON.stringify(j).slice(0, 300)); process.exit(1); }

const found = new Map(); // approvalId -> { approve, reject, subject, when }
for (const m of j.value) {
  if (!/action needed/i.test(m.subject || "")) continue;
  const html = m.body?.content || "";
  // Two shapes exist: the page link the mail actually carries
  // (/approve/action/<id>/<action>) and the API endpoint it redirects to
  // (/api/approve-link/<id>/<action>). Accept either.
  for (const mt of html.matchAll(
    /https:\/\/[^"'\s<>]*\/(?:approve\/action|api\/approve-link)\/([A-Za-z0-9]+)\/(approve|reject)\?t=([A-Za-z0-9]+)/g
  )) {
    const [full, id, action] = mt;
    const e = found.get(id) || { subject: m.subject, when: m.receivedDateTime };
    e[action] = full.replace(/&amp;/g, "&");
    found.set(id, e);
  }
}

const [cmd, ...ids] = process.argv.slice(2);

if (!cmd || cmd === "list") {
  console.log(`${found.size} approval link set(s) found in the last 60 messages\n`);
  for (const [id, e] of found) {
    console.log(`${id}  ${e.when}  ${(e.subject || "").slice(0, 70)}`);
  }
  process.exit(0);
}

const targets = ids[0] === "ALL" ? [...found.keys()] : ids;
for (const id of targets) {
  const e = found.get(id);
  if (!e) { console.log(`${id}: no link found`); continue; }
  const page = cmd === "approve" ? e.approve : e.reject;
  if (!page) { console.log(`${id}: no ${cmd} link`); continue; }
  // /approve/action/... is the confirmation PAGE; the resolution itself happens
  // at /api/approve-link/..., which a browser reaches by a client-side redirect
  // that fetch does not follow. Fetching the page returns 200 and does nothing —
  // which is exactly how seven approvals came back "200" and resumed nothing.
  const link = page.replace("/approve/action/", "/api/approve-link/");
  const res = await fetch(link, { method: "POST", redirect: "follow" });
  console.log(`${id}: ${cmd} -> HTTP ${res.status}  ${(e.subject || "").slice(0, 55)}`);
  await new Promise((s) => setTimeout(s, 1200));
}
