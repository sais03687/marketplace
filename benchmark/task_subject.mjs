// Print a task's subject verbatim, so the harness never retypes it.
// Matching is done as a plain substring downstream, which is why nothing is
// escaped here: a subject with "(" in it is not a regex, and treating it as one
// is a bug waiting for the first task whose title has a bracket.
import fs from "node:fs";

const id = process.argv[2];
const all = JSON.parse(fs.readFileSync("/root/bench/emails.json", "utf8"));
const e = all.find((x) => x.id === id);
if (!e) {
  console.error("no such task: " + id);
  process.exit(1);
}
process.stdout.write(e.subject);
