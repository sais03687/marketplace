import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentKeyStore, KEY_PREFIX, MONTHLY_ALLOWANCE, asTier, extractCost } from "./agent-keys.js";
import type { KeyManagementApi, OpenRouterKeyInfo } from "./clients/openrouter-keys.js";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
};

// An in-memory OpenRouter that behaves as measured on 2026-10-16: keys exist
// remotely before create returns, and usage/limit counters never move in time,
// so nothing here may depend on them.
function fakeOpenRouter(opts: { failCreate?: boolean } = {}) {
  const keys = new Map<string, OpenRouterKeyInfo & { secret: string }>();
  let n = 0;
  const calls = { create: 0, remove: 0, update: 0 };
  const strip = ({ secret: _s, ...info }: OpenRouterKeyInfo & { secret: string }) => info;
  const api: KeyManagementApi = {
    async create({ name, limit, limitReset }) {
      calls.create++;
      if (opts.failCreate) throw new Error("OpenRouter POST /keys failed: 503");
      const hash = `h${++n}`;
      const secret = `sk-or-v1-SECRET${n}`;
      keys.set(hash, { hash, name, disabled: false, limit, limit_remaining: limit, limit_reset: limitReset, usage: 0, usage_monthly: 0, secret });
      await new Promise((r) => setTimeout(r, 20));
      return { key: secret, info: strip(keys.get(hash)!) };
    },
    async get(hash) { const k = keys.get(hash); return k ? strip(k) : null; },
    async update(hash, patch) { calls.update++; const k = keys.get(hash)!; Object.assign(k, patch); return strip(k); },
    async remove(hash) { calls.remove++; keys.delete(hash); },
    async list() { return [...keys.values()].map(strip); },
  };
  return { api, keys, calls };
}

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agent-keys-")), "keys.json");
const OCT = Date.UTC(2026, 9, 16, 12);
const NOV = Date.UTC(2026, 10, 1, 0, 30);

const logged: string[] = [];
for (const m of ["log", "warn", "error"] as const) {
  const orig = console[m].bind(console);
  console[m] = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); if (!String(a[0]).startsWith("[agent-keys]")) orig(...a); };
}

console.log("\n-- reading the cost from real OpenRouter responses --");
{
  const json = '{"id":"gen-1","choices":[{"message":{"content":"ok"}}],"usage":{"prompt_tokens":20,"completion_tokens":5,"cost":0.00251064,"is_byok":false}}';
  check("non-streamed JSON body", extractCost(json) === 0.00251064);
  const sse = [
    'data: {"id":"gen-2","choices":[{"delta":{"content":"hi"}}]}',
    "",
    'data: {"id":"gen-2","choices":[{"delta":{}}],"usage":{"prompt_tokens":69,"completion_tokens":30,"total_tokens":99,"cost":0.0000099,"is_byok":false}}',
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  check("streamed: cost from the last usage line, after [DONE]", extractCost(sse) === 0.0000099);
  check("response without a cost -> null", extractCost('{"choices":[]}') === null);
  check("error body -> null", extractCost('{"error":{"message":"rate limited"}}') === null);
  check("garbage -> null", extractCost("<html>502</html>") === null);
  check("negative cost rejected", extractCost('{"usage":{"cost":-1}}') === null);
}

console.log("\n-- keys --");
{
  const { api, keys, calls } = fakeOpenRouter();
  const store = new AgentKeyStore(tmpFile(), api, () => OCT);
  const results = await Promise.all(Array.from({ length: 10 }, () => store.admit("dep1", "pro")));
  check("10 simultaneous first calls -> one key", calls.create === 1, `creates=${calls.create}`);
  check("all got the same key", new Set(results.map((r) => (r as any).key)).size === 1);
  const k = [...keys.values()][0];
  check("named with the platform prefix, pro backstop limit $7 monthly", k.name === `${KEY_PREFIX}dep1` && k.limit === 7 && k.limit_reset === "monthly", `${k.name} ${k.limit}`);
  check("tiers: standard $0.50, premium $30", MONTHLY_ALLOWANCE.standard === 0.5 && MONTHLY_ALLOWANCE.premium === 30);
  check("unknown tier treated as standard", asTier("weird") === "standard" && asTier(undefined) === "standard");
}
{
  const { api } = fakeOpenRouter({ failCreate: true });
  const store = new AgentKeyStore(tmpFile(), api, () => OCT);
  const r = await store.admit("dep1", "standard");
  check("OpenRouter down -> admitted with no own key (shared key used)", r.status === "ok" && (r as any).key === null, JSON.stringify(r));
  await store.recordSpend("dep1", "standard", 0.6);
  check("...and still capped by the meter", (await store.admit("dep1", "standard")).status === "allowance_reached");
}

console.log("\n-- monthly allowance (metered here, not by OpenRouter) --");
{
  const { api, keys } = fakeOpenRouter();
  let now = OCT;
  const file = tmpFile();
  const store = new AgentKeyStore(file, api, () => now);
  await store.admit("dep1", "standard");
  await store.recordSpend("dep1", "standard", 0.49);
  check("$0.49 of $0.50 -> still admitted", (await store.admit("dep1", "standard")).status === "ok");
  await store.recordSpend("dep1", "standard", 0.02);
  const r = await store.admit("dep1", "standard");
  check("$0.51 -> refused, allowance reached", r.status === "allowance_reached" && (r as any).allowance === 0.5, JSON.stringify(r));
  check("OpenRouter's own counter still says $0 (the lag we measured)", [...keys.values()][0].usage === 0);
  const reread = new AgentKeyStore(file, api, () => now);
  check("spend survives a restart", (await reread.admit("dep1", "standard")).status === "allowance_reached");
  store.addExtra("dep1", 10);
  check("buying $10 more -> admitted again", (await store.admit("dep1", "standard")).status === "ok");
  now = NOV;
  const fresh = new AgentKeyStore(tmpFile(), api, () => now);
  await fresh.recordSpend("x", "standard", 0.6);
  check("over in one month...", (await fresh.admit("x", "standard")).status === "allowance_reached");
  now = NOV + 31 * 24 * 3600e3;
  check("...admitted again the next month", (await fresh.admit("x", "standard")).status === "ok");
}

console.log("\n-- hourly safety stop --");
{
  const { api, keys } = fakeOpenRouter();
  let now = OCT;
  const store = new AgentKeyStore(tmpFile(), api, () => now, undefined, { standard: 100, pro: 100, premium: 100 });
  await store.admit("dep1", "pro"); // stop is $5/hour
  check("$4.90 in an hour -> no stop", (await store.recordSpend("dep1", "pro", 4.9)) === null);
  now += 10 * 60e3;
  const alert = await store.recordSpend("dep1", "pro", 0.2);
  check("$5.10 within the hour -> stopped at once", alert !== null && alert.stop === 5, JSON.stringify(alert));
  check("key switched off at OpenRouter", [...keys.values()][0].disabled === true);
  const r = await store.admit("dep1", "pro");
  check("next call refused as stopped", r.status === "stopped", JSON.stringify(r));
  check("a second spend does not alert twice", (await store.recordSpend("dep1", "pro", 1)) === null);
  store.addExtra("dep1", 100);
  check("buying more does not lift a stop", (await store.admit("dep1", "pro")).status === "stopped");
  now = Date.UTC(2026, 10, 2);
  check("a new month does not lift a stop", (await store.admit("dep1", "pro")).status === "stopped");
  check("operator resume lifts it", (await store.resume("dep1")) && [...keys.values()][0].disabled === false && (await store.admit("dep1", "pro")).status === "ok");
}
{
  const { api } = fakeOpenRouter();
  let now = OCT;
  const store = new AgentKeyStore(tmpFile(), api, () => now, undefined, { standard: 100, pro: 100, premium: 100 });
  for (let i = 0; i < 14; i++) { await store.recordSpend("dep1", "pro", 0.4); now += 10 * 60e3; }
  check("$0.40 every 10 min ($2.40/h) for 2+ hours on pro -> never stopped", (await store.admit("dep1", "pro")).status === "ok");
}

console.log("\n-- firing and the sweep --");
{
  const { api, keys } = fakeOpenRouter();
  const store = new AgentKeyStore(tmpFile(), api, () => OCT);
  await store.admit("dep1", "pro");
  check("revoke deletes the key at OpenRouter", (await store.revoke("dep1")) && keys.size === 0);
  check("revoking again is harmless", (await store.revoke("dep1")) === false);
  const late = await store.admit("dep1", "pro");
  check("a late call after firing is refused, no new key", late.status === "stopped" && keys.size === 0, JSON.stringify(late));
}
{
  const { api, keys } = fakeOpenRouter();
  const store = new AgentKeyStore(tmpFile(), api, () => OCT);
  await store.admit("alive", "pro"); await store.admit("fired", "pro");
  await store.recordSpend("fired", "pro", 1);
  await api.create({ name: `${KEY_PREFIX}alive`, limit: 7, limitReset: "monthly" }); // stray duplicate
  await api.create({ name: "ai employee key", limit: 0, limitReset: "monthly" }); // not ours
  const removed = await store.sweep(async (ids) => new Set(ids.filter((i) => i === "alive")));
  const names = [...keys.values()].map((k) => k.name).sort();
  check("sweep removes the fired hire's key and the stray", removed === 2, `removed=${removed}`);
  check("keeps the live hire's key and never touches others", names.join() === "agentstore:alive,ai employee key", names.join());
  check("store forgets the fired hire's key and spend", store.describe().map((d) => d.deploymentId).join() === "alive");
}
{
  const { api, keys } = fakeOpenRouter();
  const store = new AgentKeyStore(tmpFile(), api, () => OCT);
  const creating = store.admit("new", "pro");
  await new Promise((r) => setTimeout(r, 5));
  check("(setup) key visible at OpenRouter mid-creation", [...keys.values()].some((x) => x.name === `${KEY_PREFIX}new`));
  await store.sweep(async (ids) => new Set(ids));
  const res = await creating;
  const k = [...keys.values()].find((x) => x.name === `${KEY_PREFIX}new`);
  check("sweep never deletes a key being created", Boolean(k) && (res as any).key === k!.secret);
}

console.log("\n-- the file --");
{
  const { api } = fakeOpenRouter();
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ version: 1, keys: { old: { hash: "h0", key: "sk-or-v1-OLD", tier: "pro", createdAt: "x" } } }));
  const store = new AgentKeyStore(file, api, () => OCT);
  const r = await store.admit("old", "pro");
  check("a version-1 file is read (existing key kept)", r.status === "ok" && (r as any).key === "sk-or-v1-OLD");
  await store.recordSpend("old", "pro", 0.01); // a write
  if (process.platform !== "win32") check("file is owner-only (0600) once the store writes it", (fs.statSync(file).mode & 0o777) === 0o600, (fs.statSync(file).mode & 0o777).toString(8));
  fs.writeFileSync(file, "{not json");
  await new AgentKeyStore(file, api, () => OCT).admit("dep2", "standard");
  check("unreadable file is moved aside, not overwritten", fs.readdirSync(path.dirname(file)).some((f) => f.includes("unreadable")));
}

console.log("\n-- secrets never logged --");
check("no log line contains a secret key", logged.length > 0 && !logged.some((l) => l.includes("sk-or-v1")), logged.find((l) => l.includes("sk-or-v1")) ?? "");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
