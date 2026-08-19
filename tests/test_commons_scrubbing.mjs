// What goes into the commons is read by every company running the agent.
//
// runGuardrails took `title`, `content` and `context`, and scrubbed only
// `content`. `context` is where the run's own preamble lands:
//
//   Request: New email from Sai Suram <sai@agents.agentstore.it.com>
//   Subject: What do we need to reorder?
//   Thread ID: AAQkADI1N2Y5MTE3LTE1MDctNGY0Yy1iYzQ5...
//
// On 2026-08-19, 22 of the 23 approved contributions carried a real manager's
// address, their internal subject lines and their Microsoft thread ids — served
// to every other tenant running this agent. The scrubber always knew how to
// catch an email; nothing pointed it at the field that had one.
//
// The thread id matters twice over: until the same morning, a thread id plus a
// deployment id was enough to read that thread's pending drafts without
// authenticating.
import assert from "node:assert/strict";
import { runGuardrails, scrubPii } from "../apps/web/lib/agentmind/guardrails.ts";

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push(`ok   ${name}`);
  } catch (e) {
    results.push(`FAIL ${name}: ${e.message}`);
  }
}

const REAL_CONTEXT =
  "Request: New email from Sai Suram <sai@agents.agentstore.it.com> " +
  "Subject: What do we need to reorder? " +
  "Thread ID: AAQkADI1N2Y5MTE3LTE1MDctNGY0Yy1iYzQ5LWEzNmE5NzAyYzk4NQAQAL4d1vtoNIpGoMhB3ku32_E=";

const base = { title: "A lesson", content: "Something learned.", type: "PATTERN", tags: ["x"] };

test("the address in the context is redacted", () => {
  const r = runGuardrails({ ...base, context: REAL_CONTEXT });
  assert.ok(r.passed);
  assert.ok(!r.sanitizedContext.includes("sai@agents.agentstore.it.com"));
  assert.ok(r.sanitizedContext.includes("[EMAIL]"));
});

test("the thread id is redacted", () => {
  const r = runGuardrails({ ...base, context: REAL_CONTEXT });
  assert.ok(!r.sanitizedContext.includes("AAQkADI1N2Y5MTE3"));
});

test("the lesson itself survives scrubbing", () => {
  // A scrubber that removes everything protects nobody, because the feature
  // stops being used.
  const r = runGuardrails({ ...base, context: "Excel files live in the Finance folder." });
  assert.equal(r.sanitizedContext, "Excel files live in the Finance folder.");
});

test("content is still scrubbed as it always was", () => {
  const r = runGuardrails({ ...base, content: "Ask priya@acme.com for the file." });
  assert.ok(!r.sanitizedContent.includes("priya@acme.com"));
});

test("no context at all is fine", () => {
  const r = runGuardrails({ ...base });
  assert.ok(r.passed);
  assert.equal(r.sanitizedContext, undefined);
});

test("the scrubber catches an address wherever it appears", () => {
  // The bug was never in scrubPii. Guarding it so a future refactor that drops
  // the email rule fails here rather than in a commons.
  assert.ok(!scrubPii("write to a.b-c%d@sub.example.co.uk now").sanitized.includes("@sub.example"));
});

test("several addresses in one context all go", () => {
  const r = runGuardrails({
    ...base,
    context: "From sai@acme.com cc priya@acme.com and marco@vendor.io",
  });
  for (const a of ["sai@acme.com", "priya@acme.com", "marco@vendor.io"]) {
    assert.ok(!r.sanitizedContext.includes(a), a);
  }
});

console.log(results.join("\n"));
process.exit(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
