// Send one or more benchmark tasks as real mail from the buyer to the agent.
// Transport only — the agent's inbox sees an ordinary message either way.
//
// Replaces send_wave.mjs and send_daily.mjs / send_e1.mjs / send_f1.mjs /
// send_f3.mjs, which were the same file five times over with a different
// hard-coded task list and, between two of them, a different idea of whether a
// task carries one attachment or several.
//
//   node --env-file=.env.prod send_task.mjs F3
//   node --env-file=.env.prod send_task.mjs T01 T02 T03
import { findTask, attachmentsOf, allTasks } from "./tasks.mjs";

const FROM = "sai@agents.agentstore.it.com";
const TO = "data-analyst-acme-corp-az3d9btj@agents.agentstore.it.com";

const ids = process.argv.slice(2);
if (!ids.length) {
  console.error("usage: send_task.mjs T01 [T02 ...]");
  console.error("known: " + [...new Set(allTasks().map((t) => t.id))].sort().join(" "));
  process.exit(1);
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

const t = await token();
let failed = 0;

for (const id of ids) {
  let e;
  try {
    e = findTask(id);
  } catch (err) {
    console.error(err.message);
    failed++;
    continue;
  }

  const message = {
    subject: e.subject,
    body: { contentType: "Text", content: e.body },
    toRecipients: [{ emailAddress: { address: TO } }],
  };
  const att = attachmentsOf(e);
  if (att.length) {
    message.attachments = att.map((a) => ({
      "@odata.type": "#microsoft.graph.fileAttachment",
      name: a.name,
      contentType: a.ctype,
      contentBytes: a.b64,
    }));
  }

  const r = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(FROM)}/sendMail`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
      body: JSON.stringify({ message, saveToSentItems: true }),
    }
  );
  if (r.status === 202) {
    console.log(`${id}: sent (${att.length} attachment${att.length === 1 ? "" : "s"}) [${e._file}]`);
  } else {
    console.log(`${id}: FAILED ${r.status} ${(await r.text()).slice(0, 200)}`);
    failed++;
  }
  await new Promise((s) => setTimeout(s, 2000));
}

process.exit(failed ? 1 : 0);
