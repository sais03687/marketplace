import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentKeyStore, KEY_PREFIX, MONTHLY_ALLOWANCE, asTier } from "./agent-keys.js";
import type { KeyManagementApi, OpenRouterKeyInfo } from "./clients/openrouter-keys.js";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
};

// An in-memory OpenRouter. `usage` is set by the test to simulate spend.
function fakeOpenRouter() {
  const keys = new Map<string, OpenRouterKeyInfo & { secret: string }>();
  let n = 0;
  const calls = { create: 0, remove: 0, update: 0 };
  const api: KeyManagementApi = {
    async create({ name, limit, limitReset }) {
      calls.create++;
      const hash = `h${++n}`;
      const secret = `sk-or-v1-SECRET${n}`;
      const k = { hash, name, disabled: false, limit, limit_remaining: limit, limit_reset: limitReset, usage: 0, usage_monthly: 0, secret };
      // The key exists at OpenRouter before the response gets back to us.
      keys.set(hash, k);
      await new Promise((r) => setTimeout(r, 20));
      const { secret: _s, ...info } = k;
      return { key: secret, info };
    },
    async get(hash) {
      const k = keys.get(hash);
      if (!k) return null;
      const { secret: _s, ...info } = k;
      return info;
    },
    async update(hash, patch) {
      calls.update++;
      const k = keys.get(hash)!;
      Object.assign(k, patch);
      const { secret: _s, ...info } = k;
      return info;
    },
    async remove(hash) {
      calls.remove++;
      keys.delete(hash);
    },
    async list() {
      return [...keys.values()].map(({ secret: _s, ...info }) => info);
    },
  };
  return { api, keys, calls };
}

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agent-keys-")), "keys.json");
}

// Capture everything logged, to prove no secret is ever printed.
const logged: string[] = [];
for (const m of ["log", "warn", "error"] as const) {
  const orig = console[m].bind(console);
  console[m] = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); if (!String(a[0]).startsWith("[agent-keys]")) orig(...a); };
}

console.log("\n-- creation --");
{
  const { api, keys, calls } = fakeOpenRouter();
  const store = new AgentKeyStore(tmpFile(), api);
  const results = await Promise.all(Array.from({ length: 10 }, () => store.keyFor("dep1", "pro")));
  check("10 simultaneous first calls -> one key created", calls.create === 1, `creates=${calls.create}`);
  check("all 10 got the same key", new Set(results.map((r) => (r as any).key)).size === 1);
  const k = [...keys.values()][0];
  check("named with the platform prefix", k.name === `${KEY_PREFIX}dep1`, k.name);
  check("pro limit is $7 a month", k.limit === 7 && k.limit_reset === "monthly", `${k.limit} ${k.limit_reset}`);
  await store.keyFor("dep1", "pro");
  check("later calls reuse it", calls.create === 1);
}
{
  const { api, keys } = fakeOpenRouter();
  const store = new AgentKeyStore(tmpFile(), api);
  await store.keyFor("s", "standard"); await store.keyFor("p", "premium");
  const limits = [...keys.values()].map((k) => k.limit).sort((a, b) => a! - b!);
  check("standard $0.50 and premium $30", limits.join() === `${MONTHLY_ALLOWANCE.standard},${MONTHLY_ALLOWANCE.premium}`, limits.join());
  check("unknown tier treated as standard (lowest limit)", asTier("weird") === "standard" && asTier(undefined) === "standard");
}

console.log("\n-- the key file --");
{
  const { api } = fakeOpenRouter();
  const file = tmpFile();
  const store = new AgentKeyStore(file, api);
  const r = await store.keyFor("dep1", "standard");
  const again = new AgentKeyStore(file, api);
  const r2 = await again.keyFor("dep1", "standard");
  check("survives a restart (read back from the file)", (r as any).key === (r2 as any).key);
  if (process.platform !== "win32") {
    check("file is owner-only (0600)", (fs.statSync(file).mode & 0o777) === 0o600, (fs.statSync(file).mode & 0o777).toString(8));
  }
  fs.writeFileSync(file, "{not json");
  const corrupt = new AgentKeyStore(file, api);
  await corrupt.keyFor("dep2", "standard");
  const aside = fs.readdirSync(path.dirname(file)).filter((f) => f.includes("unreadable"));
  check("unreadable file is moved aside, not overwritten", aside.length === 1, aside.join());
}

console.log("\n-- firing and the sweep --");
{
  const { api, keys } = fakeOpenRouter();
  const store = new AgentKeyStore(tmpFile(), api);
  await store.keyFor("dep1", "pro");
  check("revoke deletes the key at OpenRouter", (await store.revoke("dep1")) && keys.size === 0);
  check("revoking again is harmless", (await store.revoke("dep1")) === false);
  const late = await store.keyFor("dep1", "pro");
  check("a late call after firing gets no new key", late.status === "stopped" && keys.size === 0, JSON.stringify(late));
}
{
  const { api, keys } = fakeOpenRouter();
  const store = new AgentKeyStore(tmpFile(), api);
  await store.keyFor("alive", "pro"); await store.keyFor("fired", "pro");
  // A key the store lost track of (lost file / crash between create and save).
  await api.create({ name: `${KEY_PREFIX}alive`, limit: 7, limitReset: "monthly" });
  // Someone else's key on the same account: never touched.
  await api.create({ name: "ai employee key", limit: 0, limitReset: "monthly" });
  const removed = await store.sweep(async (ids) => new Set(ids.filter((i) => i === "alive")));
  const names = [...keys.values()].map((k) => k.name).sort();
  check("sweep removes the fired hire's key and the stray duplicate", removed === 2, `removed=${removed}`);
  check("live hire's key and the non-platform key are kept", names.join() === `agentstore:alive,ai employee key`, names.join());
  check("store forgets the fired hire", store.describe().map((d) => d.deploymentId).join() === "alive");
}
{
  const { api, keys } = fakeOpenRouter();
  const store = new AgentKeyStore(tmpFile(), api);
  const creating = store.keyFor("new", "pro"); // in flight: exists remotely, response not back yet
  await new Promise((r) => setTimeout(r, 5));
  const visible = [...keys.values()].some((x) => x.name === `${KEY_PREFIX}new`);
  check("(setup) key visible at OpenRouter mid-creation", visible);
  await store.sweep(async (ids) => new Set(ids));
  const res = await creating;
  const k = [...keys.values()].find((x) => x.name === `${KEY_PREFIX}new`);
  check("sweep never deletes a key being created", Boolean(k) && (res as any).key === k!.secret);
}

console.log("\n-- hourly safety stop --");
{
  const { api, keys } = fakeOpenRouter();
  let now = 0;
  const store = new AgentKeyStore(tmpFile(), api, () => now);
  await store.keyFor("dep1", "pro"); // stop is $5/hour
  const k = [...keys.values()][0];
  k.usage = 1.0; await store.checkRunaway();
  now += 20 * 60e3; k.usage = 3.0; check("$2 in 20 min -> no stop", (await store.checkRunaway()).length === 0);
  now += 20 * 60e3; k.usage = 6.5; const s = await store.checkRunaway();
  check("$5.50 in 40 min -> stopped", s.length === 1 && k.disabled === true, JSON.stringify(s));
  const look = await store.keyFor("dep1", "pro");
  check("broker is told the key is stopped (no new key made)", look.status === "stopped" && keys.size === 1, JSON.stringify(look));
  check("resume lifts it", (await store.resume("dep1")) && k.disabled === false && (await store.keyFor("dep1", "pro")).status === "ok");
}
{
  const { api, keys } = fakeOpenRouter();
  let now = 0;
  const store = new AgentKeyStore(tmpFile(), api, () => now);
  await store.keyFor("dep1", "standard"); // stop is $1/hour
  const k = [...keys.values()][0];
  for (let i = 0; i < 12; i++) { k.usage += 0.3; await store.checkRunaway(); now += 10 * 60e3; }
  check("steady $0.30 per 10 min ($1.80/h) on standard -> stopped", k.disabled === true);
}
{
  const { api, keys } = fakeOpenRouter();
  let now = 0;
  const store = new AgentKeyStore(tmpFile(), api, () => now);
  await store.keyFor("dep1", "standard");
  const k = [...keys.values()][0];
  for (let i = 0; i < 12; i++) { k.usage += 0.1; await store.checkRunaway(); now += 10 * 60e3; }
  check("steady $0.60/h on standard -> not stopped", k.disabled === false);
}
{
  const { api, keys } = fakeOpenRouter();
  const store = new AgentKeyStore(tmpFile(), api);
  await store.keyFor("dep1", "pro");
  keys.clear(); // deleted by hand on the OpenRouter site
  await store.checkRunaway();
  const r = await store.keyFor("dep1", "pro");
  check("key deleted outside the platform -> a new one is made", r.status === "ok" && keys.size === 1);
}

console.log("\n-- secrets never logged --");
check("no log line contains a secret key", logged.length > 0 && !logged.some((l) => l.includes("sk-or-v1")), logged.find((l) => l.includes("sk-or-v1")) ?? "");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
