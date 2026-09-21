/**
 * Docker's framed log stream, demuxed.
 *
 * Runs the shipped module rather than a copy of it. `node --experimental-strip-types`
 * executes the .ts directly; the module has no imports precisely so this works.
 */
import assert from "node:assert";
import { demuxDockerLogs } from "../apps/provisioning-service/src/jobs/docker-logs.ts";

let passed = 0;
function check(name, fn) {
  fn();
  console.log(`ok   ${name}`);
  passed++;
}

/** Build one Docker log frame the way the daemon does. */
function frame(stream, text) {
  const body = Buffer.from(text, "utf8");
  const header = Buffer.alloc(8);
  header[0] = stream; // 1 = stdout, 2 = stderr
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

check("a single frame comes back as its text", () => {
  assert.strictEqual(demuxDockerLogs(frame(1, "hello\n")), "hello\n");
});

check("consecutive frames are joined in order", () => {
  const raw = Buffer.concat([frame(1, "one\n"), frame(2, "two\n"), frame(1, "three\n")]);
  assert.strictEqual(demuxDockerLogs(raw), "one\ntwo\nthree\n");
});

check("a length byte that is printable does not leak into the text", () => {
  // This is the bug. A 35-byte frame writes 0x23 — "#" — into its header, and
  // deleting control characters leaves that "#" at the head of the line.
  const line = "x".repeat(34) + "\n"; // 35 bytes
  assert.strictEqual(line.length, 35);
  const out = demuxDockerLogs(frame(2, line));
  assert.strictEqual(out, line);
  assert.ok(!out.includes("#"), `length byte leaked: ${JSON.stringify(out)}`);
});

check("the other printable lengths do not leak either", () => {
  for (const [len, char] of [[50, "2"], [61, "="], [93, "]"]]) {
    const line = "y".repeat(len - 1) + "\n";
    const out = demuxDockerLogs(frame(1, line));
    assert.ok(!out.includes(char), `length ${len} leaked ${char}`);
  }
});

check("a real traceback survives intact", () => {
  const tb = [
    'Traceback (most recent call last):',
    '  File "/agent/creator/agent.py", line 17, in <module>',
    "    llm = StructuredLLM(",
    "TypeError: expected str, got ChatOpenAI",
  ].join("\n");
  const raw = Buffer.concat(tb.split("\n").map((l) => frame(2, l + "\n")));
  const out = demuxDockerLogs(raw);
  for (const line of tb.split("\n")) {
    assert.ok(out.includes(line.trim()), `lost: ${line}`);
  }
});

check("unframed output is passed through", () => {
  // Some Docker setups hand back plain text. Returning nothing there would trade
  // one blind report for another.
  assert.strictEqual(demuxDockerLogs(Buffer.from("plain text\n")), "plain text\n");
  assert.strictEqual(demuxDockerLogs("already a string\n"), "already a string\n");
});

check("a frame cut short by tail still yields what it has", () => {
  const raw = Buffer.concat([frame(1, "complete\n"), frame(1, "truncated").subarray(0, 12)]);
  const out = demuxDockerLogs(raw);
  assert.ok(out.startsWith("complete\n"), out);
  assert.ok(out.includes("trun"), `dropped the partial frame: ${JSON.stringify(out)}`);
});

check("empty output is empty, not a crash", () => {
  assert.strictEqual(demuxDockerLogs(Buffer.alloc(0)), "");
});

console.log(`\n${passed} checks passed`);
