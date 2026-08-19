// Naming a deployment is not the same as being one.
//
// /api/agentmind/contribute took a deploymentId in the request body and checked
// only that it existed and was ACTIVE. Nothing proved the caller was that
// deployment. Verified from outside the network on 2026-08-18: an
// unauthenticated POST reached the handler and came back with a field list.
//
// Contributions auto-approve by default and search serves APPROVED lessons to
// every deployment of an agent across every company — the route's own comment
// says "a lesson written by one buyer reaches all of them" — so that was a way
// to put chosen text into other companies' agents from the public internet.
import assert from "node:assert/strict";
import { tokensMatch } from "../apps/web/lib/constant-time.ts";

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push(`ok   ${name}`);
  } catch (e) {
    results.push(`FAIL ${name}: ${e.message}`);
  }
}

const REAL = "vet-noop-3f9a2c8e1b7d4a6f";

test("the right token matches", () => {
  assert.equal(tokensMatch(REAL, REAL), true);
});

test("a different token of the same length does not", () => {
  assert.equal(tokensMatch("vet-noop-0000000000000000", REAL), false);
});

test("a prefix of the right token does not", () => {
  // The shape a timing attack builds up to. Length differs, so it is refused
  // before the compare — and refused, not thrown.
  assert.equal(tokensMatch(REAL.slice(0, 8), REAL), false);
});

test("the empty string does not", () => {
  assert.equal(tokensMatch("", REAL), false);
});

test("a deployment with no token set matches nothing", () => {
  // Otherwise a null column would authenticate an empty header.
  assert.equal(tokensMatch("", null), false);
  assert.equal(tokensMatch("anything", null), false);
});

test("a longer string does not throw", () => {
  // timingSafeEqual throws on a length mismatch; the guard has to come first or
  // an attacker crashes the route instead of being refused by it.
  assert.equal(tokensMatch(REAL + "extra", REAL), false);
});

console.log(results.join("\n"));
process.exit(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
