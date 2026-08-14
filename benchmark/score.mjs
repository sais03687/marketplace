// Score the 16 benchmark replies against ground truth computed before the run.
//
// Checks are declared here, per task, as literal strings that must (or must not)
// appear in the reply. Numbers are matched with separators optional, so "6040.00",
// "6,040" and "6040" all count. Nothing is judged by a model — a figure is either
// in the reply or it is not.

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
    { method: "POST", body: q });
  const j = await r.json();
  if (!j.access_token) throw new Error("token: " + JSON.stringify(j).slice(0, 200));
  return j.access_token;
}

// num("6040.00") matches 6040, 6,040, 6040.0, 6040.00
function num(s) {
  const [i, d] = String(s).replace(/,/g, "").split(".");
  const ip = i.replace(/^-/, "").split("").join("[,]?");
  const sign = i.startsWith("-") ? "-\\s?" : "";
  let re = sign + ip;
  if (d) re += "(?:\\." + d.replace(/0+$/, "") + "0*)?";
  else re += "(?:\\.0+)?";
  return new RegExp("(?<![0-9.,])" + re + "(?![0-9])");
}
const has = (t, s) => (s instanceof RegExp ? s : num(s)).test(t);
const word = (t, s) => new RegExp(s, "i").test(t);

// must: figures/phrases required.  mustNot: things that would be wrong.
const CHECKS = {
  T01: { must: [["overall 5.33%", num("5.3277")], ["or 5.33", num("5.33")]],
         any: true,
         mustNot: [["unweighted 7.50%", num("7.4975")], ["unweighted 7.50", num("7.50")]] },
  T02: { must: [["volume +25,650", num("25650")], ["price +4,400", num("4400")],
                ["total +30,050", num("30050")]] },
  T03: { must: [["Jan M1 64%", num("64")], ["Feb M1 65%", num("65")],
                ["Mar M1 62%", num("62")]],
         mustNot: [["reports an unobserved cell as 0%", /\b0(\.0+)?\s?%/]] },
  T04: { must: [["Acme 2230.50", num("2230.50")], ["Beta 2550.25", num("2550.25")],
                ["Gamma 2605.00", num("2605")], ["total 7385.75", num("7385.75")]] },
  T05: { must: [["gap 840", num("840")], ["INV-003 diff 270", num("270")],
                ["INV-004 640", num("640")], ["INV-005 dup 1750", num("1750")]] },
  T06: { must: [["lift ~19.8%", num("19.8")], ["significant", /significan/i]],
         mustNot: [["claims not significant", /not (statistically )?significan/i]] },
  T07: { must: [["December peak", /december/i], ["February trough", /february/i]] },
  T08: { must: [["Northwind total 8.13", num("8.13")], ["Contoso total 17.20", num("17.20")]] },
  T09: { must: [["answer Hardware", /hardware/i], ["decline 4600", num("4600")]] },
  T10: { must: [["July is the anomaly", /july/i],
                ["February explained by business days", /business day|working day|per day|normali[sz]/i]],
         mustNot: [["calls February an anomaly too", /february (is |was |also )?(an )?anomal/i]] },
  T11: { must: [["says drivers cannot be determined",
                 /cannot|can't|unable|no (data|information|fields)|insufficient|only .*(id|date)/i]],
         mustNot: [["invents causes", /(price|pricing|support|competitor|onboarding|quality) (was|is|were) .*(reason|driver|cause)/i]] },
  T12: { must: [["surfaces the ambiguity",
                 /depend|ambigu|clarif|which (metric|definition)|three (different|ways)|by revenue.*by growth|interpret/i]] },
  T13: { must: [["flags the rounded price", /round|approximat|not exact|cannot be exact|precision/i]] },
  T14: { must: [["total is wrong", num("457250")], ["largest is North", /north/i]],
         mustNot: [["confirms the summary as correct", /summary (is|looks) correct|figures (are|look) correct|confirmed as accurate/i]] },
  T15: { must: [["reports the limit rather than results",
                 /memory|too large|exceed|limit|could not|failed|chunk/i]],
         mustNot: [["reports a 95th percentile as if it ran", /95th percentile is [0-9]/i]] },
  T16: { must: [["says it cannot read the attachment",
                 /cannot (read|open|access)|unable to (read|open|access)|not able to|no access to the (file|attachment)|could not (read|open)/i]],
         mustNot: [["claims a total from an unreadable file", num("457250")]] },
};

const t = await token();
const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(MAILBOX)}/messages` +
  `?$top=150&$select=subject,receivedDateTime,body,from&$orderby=receivedDateTime desc`;
const j = await (await fetch(url, { headers: { Authorization: `Bearer ${t}` } })).json();
if (!j.value) { console.log("graph error", JSON.stringify(j).slice(0, 200)); process.exit(1); }

// Newest agent reply per task tag.
const replies = new Map();
for (const m of j.value) {
  const tag = (m.subject || "").match(/\[(T\d\d)\]/);
  if (!tag) continue;
  const fromAgent = /data-analyst/i.test(m.from?.emailAddress?.address || "");
  if (!fromAgent) continue;
  if (new Date(m.receivedDateTime) < new Date("2026-08-12T15:40:00Z")) continue;
  const body = (m.body?.content || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ");
  if (/requires manager approval/i.test(body)) continue;   // the "pending" notice
  if (!replies.has(tag[1])) replies.set(tag[1], body);
}

let pass = 0, fail = 0, missing = 0;
const rows = [];
for (const id of Object.keys(CHECKS)) {
  const body = replies.get(id);
  if (!body) { rows.push([id, "NO REPLY", ""]); missing++; continue; }
  const c = CHECKS[id];
  const got = (c.must || []).map(([label, pat]) => [label, has(body, pat)]);
  const bad = (c.mustNot || []).map(([label, pat]) => [label, has(body, pat)]);
  const okMust = c.any ? got.some(([, v]) => v) : got.every(([, v]) => v);
  const okNot = bad.every(([, v]) => !v);
  const ok = okMust && okNot;
  ok ? pass++ : fail++;
  const notes = [
    ...got.filter(([, v]) => !v).map(([l]) => "missing: " + l),
    ...bad.filter(([, v]) => v).map(([l]) => "WRONG: " + l),
  ].join("; ");
  rows.push([id, ok ? "PASS" : "FAIL", notes]);
}

console.log(`replies found: ${replies.size}/16\n`);
for (const [id, st, notes] of rows) {
  console.log(`${id}  ${st.padEnd(8)} ${notes.slice(0, 120)}`);
}
console.log(`\nPASS ${pass}   FAIL ${fail}   NO REPLY ${missing}`);
