// Capture a real reply as a test fixture, so nothing is retyped.
//
//   node --env-file=.env.prod capture_fixture.mjs --contains "Q3 utilisation" \
//        --out ../tests/fixtures/2026-08-19-utilisation.json \
//        --verdict correct --basis "recomputed by hand from the source CSV"
//
// The reason this exists rather than copy-and-paste: two tests in
// test_headline_check.py asserted that D02's and D04's replies were fine, on no
// evidence beyond my having decided so while writing them. D02's reply was
// wrong. A fixture agrees with whatever belief wrote it, and a fixture typed
// out by hand carries that belief invisibly.
//
// What is captured is the reply exactly as delivered, plus the Summary sheet of
// whatever workbook came with it, plus provenance. The verdict is supplied by a
// human — it is a judgement, not an observation, and it is recorded as such.
import fs from "node:fs";
import { execFileSync } from "node:child_process";

function arg(name, fallback = null) {
  const i = process.argv.indexOf("--" + name);
  return i === -1 ? fallback : process.argv[i + 1];
}

const CONTAINS = arg("contains");
const OUT = arg("out");
const VERDICT = arg("verdict"); // "correct" | "wrong"
const BASIS = arg("basis");

if (!CONTAINS || !OUT || !VERDICT || !BASIS) {
  console.error(
    "usage: capture_fixture.mjs --contains SUBSTRING --out PATH " +
      "--verdict correct|wrong --basis 'how the verdict was established'"
  );
  process.exit(2);
}
if (!["correct", "wrong"].includes(VERDICT)) {
  console.error("--verdict must be 'correct' or 'wrong'");
  process.exit(2);
}

// Reuse the waiter rather than reimplementing the mailbox query: one place to
// fix when the "is this the real reply" rules change.
const raw = execFileSync(
  process.execPath,
  [new URL("./await_reply.mjs", import.meta.url).pathname,
   "--contains", CONTAINS, "--timeout", arg("timeout", "60"), "--json"],
  { encoding: "utf8" }
);
const reply = JSON.parse(raw);

const fixture = {
  provenance: {
    capture: "automatic",
    captured_at: new Date().toISOString(),
    source: "the buyer's mailbox, as delivered",
    subject: reply.subject,
    received: reply.received,
  },
  verdict: VERDICT,
  verdict_basis: BASIS,
  reply: reply.body,
  attachments: reply.attachments,
};

fs.mkdirSync(OUT.replace(/[/\\][^/\\]+$/, ""), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(fixture, null, 2) + "\n");
console.log("wrote " + OUT);
console.log("verdict: " + VERDICT + " — " + BASIS);
console.log();
console.log("The Summary sheet is not captured here: the workbook goes to");
console.log("SharePoint, not the mailbox. Add it under `workbook` by hand and");
console.log("set provenance.capture to 'mixed' if you do.");
