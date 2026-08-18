// The two decisions an update makes on the buyer's behalf.
//
// Run by tests/test_update_safety.py, which is how the rest of the suite reaches
// the TypeScript side — the same arrangement as tests/test_inbound_message.py,
// so these run the real functions rather than a Python retelling of them.
//
// An update restarts the agent. That cancels whatever it was doing, and if the
// new version does not come up it leaves the buyer with nothing. Neither is
// avoided by being careful; both need code, and code needs checking.
import assert from "node:assert/strict";
import { probeAgent, waitUntilIdle, waitUntilHealthy } from "../apps/provisioning-service/src/jobs/update-helpers.ts";

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push(`ok   ${name}`);
  } catch (e) {
    results.push(`FAIL ${name}: ${e.message}`);
  }
}

const noSleep = async () => {};
const reply = (body, ok = true) => async () => ({ ok, json: async () => body });

// ── reading what the agent is doing ────────────────────────────────────────

await test("an idle agent reports nobody waiting", async () => {
  assert.deepEqual(await probeAgent(4000, reply({ ok: true, busy: 0 })), { ok: true, busy: 0 });
});

await test("a busy agent reports its work", async () => {
  const p = await probeAgent(4000, reply({ ok: true, busy: 2 }));
  assert.equal(p.busy, 2);
});

await test("an unreachable agent counts as busy, never as idle", async () => {
  // "I could not tell" and "nobody is waiting" are different answers, and
  // treating the first as the second restarts on top of live work.
  const p = await probeAgent(4000, async () => { throw new Error("ECONNREFUSED"); });
  assert.equal(p.ok, false);
  assert.equal(p.busy, 1);
});

await test("a non-200 also counts as busy", async () => {
  assert.equal((await probeAgent(4000, reply({}, false))).busy, 1);
});

await test("an agent too old to report busy is treated as idle", async () => {
  // A deployment running a version from before /internal/health grew the field
  // returns nothing for it. Blocking its update forever would be worse than
  // restarting it, and its runs are recorded either way.
  assert.deepEqual(await probeAgent(4000, reply({ ok: true })), { ok: true, busy: 0 });
});

// ── waiting for a quiet moment ─────────────────────────────────────────────

await test("it returns as soon as the agent is idle", async () => {
  let calls = 0;
  const f = async () => { calls++; return { ok: true, json: async () => ({ busy: 0 }) }; };
  assert.equal(await waitUntilIdle(4000, { fetchImpl: f, sleep: noSleep }), true);
  assert.equal(calls, 1, "it should not poll again once the agent is free");
});

await test("it waits while work is in flight, then proceeds", async () => {
  let calls = 0;
  const f = async () => {
    calls++;
    return { ok: true, json: async () => ({ busy: calls < 3 ? 1 : 0 }) };
  };
  assert.equal(await waitUntilIdle(4000, { fetchImpl: f, sleep: noSleep }), true);
  assert.equal(calls, 3);
});

await test("a permanently busy agent does not postpone its update forever", async () => {
  // It proceeds and says so. Interrupting a run is a known cost — the buyer is
  // told — while never updating is unbounded, and a stuck run would make it
  // permanent.
  const f = reply({ busy: 1 });
  assert.equal(await waitUntilIdle(4000, { fetchImpl: f, sleep: noSleep, timeoutMs: 0 }), false);
});

await test("a dead agent does not block the update either", async () => {
  const f = async () => { throw new Error("down"); };
  assert.equal(await waitUntilIdle(4000, { fetchImpl: f, sleep: noSleep, timeoutMs: 0 }), false);
});

// ── waiting for it to come back ────────────────────────────────────────────

await test("healthy as soon as it answers", async () => {
  assert.equal(await waitUntilHealthy(4000, { fetchImpl: reply({}), sleep: noSleep }), true);
});

await test("it keeps trying while the container is still starting", async () => {
  let calls = 0;
  const f = async () => {
    calls++;
    if (calls < 4) throw new Error("not up");
    return { ok: true, json: async () => ({}) };
  };
  assert.equal(await waitUntilHealthy(4000, { fetchImpl: f, sleep: noSleep }), true);
  assert.equal(calls, 4);
});

await test("it gives up rather than hanging the queue", async () => {
  const f = async () => { throw new Error("never"); };
  assert.equal(await waitUntilHealthy(4000, { fetchImpl: f, sleep: noSleep, timeoutMs: 0 }), false);
});

await test("busy does not mean unhealthy", async () => {
  // The two questions are separate: an agent hard at work is perfectly healthy,
  // and a health check that waited for idleness would time out on a busy one.
  assert.equal(await waitUntilHealthy(4000, { fetchImpl: reply({ busy: 5 }), sleep: noSleep }), true);
});

console.log(results.join("\n"));
process.exit(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
