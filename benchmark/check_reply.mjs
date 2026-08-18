// Decide whether a delivered reply is self-consistent.
//
//   node check_reply.mjs <reply.json> <filesAfter> <filesBefore>
//
// Every rule below is a failure that has actually reached a buyer, so the
// harness makes the judgement rather than printing the reply and trusting
// whoever reads it. That is how the missing attachment on the restart run
// survived a first review: every figure was right, and "attachments: NONE" sat
// one line above them.
//
// These check the delivery against itself. Whether the numbers are *correct*
// needs the workbook, and this deliberately does not pretend to know.
import fs from "node:fs";

const [file, after, before] = process.argv.slice(2);
const r = JSON.parse(fs.readFileSync(file, "utf8"));
const produced = Number(after) > Number(before);
const body = r.body || "";
const fails = [];

// Claimed an attachment and sent none.
if (/\b(attached|enclosed|attachment)\b/i.test(body) && !r.attachments.length) {
  fails.push("the reply says a file is attached and none is");
}

// Produced a file and gave no pointer to it at all — neither attachment nor
// link. This is what the thread-key bug looked like from outside: every figure
// right, the workbook nowhere.
if (produced && !r.attachments.length && !/https?:\/\//.test(body)) {
  fails.push("a file was produced but the reply neither attaches nor links it");
}

// An internal diagnostic reaching the buyer.
const leak = body.match(/[A-Z][A-Z -]{3,} CHECK\b|sandbox:|Traceback|\/tmp\//);
if (leak) fails.push("internal text reached the buyer: " + leak[0]);

// A status note delivered as though it were the answer.
if (/^\s*Not finished yet/i.test(body)) {
  fails.push("a status note was delivered as the reply");
}

console.log();
console.log("attachments :", r.attachments.join(", ") || "NONE");
console.log("files       :", before, "->", after);
console.log();
console.log(body);
console.log();
if (fails.length) {
  console.log("FAIL");
  for (const f of fails) console.log("  - " + f);
  process.exit(1);
}
console.log("PASS — the delivery is self-consistent.");
console.log("The figures still need checking against the workbook; not decidable here.");
