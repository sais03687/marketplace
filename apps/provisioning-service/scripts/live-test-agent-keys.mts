/**
 * Live test of per-hire keys and the broker's spend meter, against the real
 * OpenRouter account and the running broker. Costs about a cent.
 *
 *   cd apps/provisioning-service && npx tsx scripts/live-test-agent-keys.mts <liveHireId> <firedHireId>
 *
 * Part 1 drives the real broker on localhost as a hire would: one plain and
 * one streamed call, then checks the answers arrived intact, the hire's key
 * exists at OpenRouter, and the meter moved by exactly the cost OpenRouter
 * reported. A fired hire must be refused.
 *
 * Part 2 uses a throwaway key with one-cent thresholds to trip the allowance
 * and the safety stop for real, and checks OpenRouter switched the key off.
 * It always deletes its throwaway key.
 */
import "../src/load-env.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentKeyStore, KEY_PREFIX, MONTHLY_ALLOWANCE, asTier, extractCost } from "../src/agent-keys.js";
import { prisma } from "@marketplace/db";
import { openRouterKeys } from "../src/clients/openrouter-keys.js";
import { agentTokenFor } from "../src/utils/agent-token.js";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const [liveHire, firedHire] = process.argv.slice(2);
if (!liveHire || !firedHire) { console.error("usage: live-test-agent-keys.mts <liveHireId> <firedHireId>"); process.exit(2); }

const SECRET = process.env.PROVISIONING_SECRET || "";
const BROKER = "http://localhost:3003/internal/llm/chat/completions";
const KEY_FILE = process.env.AGENT_KEYS_PATH || path.resolve(process.cwd(), ".agent-llm-keys.json");
const ledgerSpent = (id: string): number => {
  try { return JSON.parse(fs.readFileSync(KEY_FILE, "utf8")).ledger?.[id]?.spent ?? 0; } catch { return 0; }
};
const keyHashFor = (id: string): string | null => {
  try { return JSON.parse(fs.readFileSync(KEY_FILE, "utf8")).keys?.[id]?.hash ?? null; } catch { return null; }
};
const asHire = (id: string) => ({ Authorization: `Bearer ${id}.${agentTokenFor(id, SECRET)}`, "Content-Type": "application/json" });
const ask = (stream: boolean) => JSON.stringify({ model: "ignored-broker-forces-it", stream, max_tokens: 40, messages: [{ role: "user", content: "Reply with the single word: ok" }] });

console.log("\n-- part 1: through the real broker --");
{
  const before = ledgerSpent(liveHire);
  const r1 = await fetch(BROKER, { method: "POST", headers: asHire(liveHire), body: ask(false) });
  const t1 = await r1.text();
  const c1 = extractCost(t1);
  check("plain call answered", r1.status === 200 && /"content"/.test(t1), `status=${r1.status}`);
  const r2 = await fetch(BROKER, { method: "POST", headers: asHire(liveHire), body: ask(true) });
  const t2 = await r2.text();
  const c2 = extractCost(t2);
  check("streamed call answered, stream complete", r2.status === 200 && t2.includes("data: [DONE]"), `status=${r2.status}`);
  check("OpenRouter reported a cost on both", c1 !== null && c2 !== null, `${c1} ${c2}`);
  await sleep(500);
  const delta = ledgerSpent(liveHire) - before;
  check("meter moved by exactly the reported costs", Math.abs(delta - ((c1 ?? 0) + (c2 ?? 0))) < 1e-9, `delta=${delta} reported=${(c1 ?? 0) + (c2 ?? 0)}`);
  const hash = keyHashFor(liveHire);
  const remote = hash ? await openRouterKeys.get(hash) : null;
  check("hire's own key exists at OpenRouter, platform-named", remote?.name === `${KEY_PREFIX}${liveHire}`, remote?.name ?? "none");
  const dbTier = (await prisma.deployment.findUnique({ where: { id: liveHire }, select: { agent: { select: { modelTier: true } } } }))?.agent?.modelTier;
  const want = MONTHLY_ALLOWANCE[asTier(dbTier)];
  check(`backstop limit matches the hire's tier (${dbTier} -> $${want})`, remote?.limit === want, `limit=${remote?.limit}`);
  // Proof the broker really calls with this key, not the shared one: with the
  // key switched off at OpenRouter, a call through the broker must fail.
  await openRouterKeys.update(hash!, { disabled: true });
  let off = 200;
  for (let i = 0; i < 6 && off === 200; i++) {
    off = (await fetch(BROKER, { method: "POST", headers: asHire(liveHire), body: ask(false) }).then(async (r) => { await r.text(); return r.status; }));
    if (off === 200) await sleep(5000);
  }
  await openRouterKeys.update(hash!, { disabled: false });
  check("broker uses the hire's own key (refused while it is switched off)", off !== 200, `status=${off}`);
  let on = 0;
  for (let i = 0; i < 6 && on !== 200; i++) {
    on = (await fetch(BROKER, { method: "POST", headers: asHire(liveHire), body: ask(false) }).then(async (r) => { await r.text(); return r.status; }));
    if (on !== 200) await sleep(5000);
  }
  check("...and works again once switched back on", on === 200, `status=${on}`);
  const r3 = await fetch(BROKER, { method: "POST", headers: asHire(firedHire), body: ask(false) });
  const t3 = await r3.text();
  check("fired hire refused (403 agent_fired)", r3.status === 403 && t3.includes("agent_fired"), `${r3.status} ${t3.slice(0, 80)}`);
  check("no key made for the fired hire", keyHashFor(firedHire) === null);
  const r4 = await fetch(BROKER, { method: "POST", headers: { ...asHire(liveHire), Authorization: `Bearer ${liveHire}.wrongtoken` }, body: ask(false) });
  check("wrong token refused", r4.status === 401, `status=${r4.status}`);
}

console.log("\n-- part 2: allowance and safety stop, for real --");
async function chat(key: string): Promise<{ status: number; cost: number | null }> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "openai/gpt-oss-120b", messages: [{ role: "user", content: "Reply with the word ok." }], max_tokens: 20 }),
  });
  const text = await res.text();
  return { status: res.status, cost: extractCost(text) };
}
const id = `livetest-${Date.now()}`;
const tiny = { standard: 0.00003, pro: 0.00003, premium: 0.00003 };
const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "live-keys-")), "keys.json");
try {
  // Allowance: a tiny monthly allowance, generous stop.
  const allowStore = new AgentKeyStore(file, openRouterKeys, () => Date.now(), { standard: 1, pro: 1, premium: 1 }, tiny);
  let a = await allowStore.admit(id, "standard");
  let calls = 0;
  while (a.status === "ok" && calls < 10) {
    const r = await chat((a as any).key);
    if (r.status === 200 && r.cost) await allowStore.recordSpend(id, "standard", r.cost);
    calls++;
    a = await allowStore.admit(id, "standard");
  }
  check("allowance refused after real spend passed it", a.status === "allowance_reached", `${a.status} after ${calls} calls`);
  allowStore.addExtra(id, 1);
  check("buying more re-admits", (await allowStore.admit(id, "standard")).status === "ok");

  // Safety stop: a tiny hourly stop on the same hire.
  const stopStore = new AgentKeyStore(file, openRouterKeys, () => Date.now(), tiny, { standard: 10, pro: 10, premium: 10 });
  const s = await stopStore.admit(id, "standard");
  const key = (s as any).key as string;
  let alert = null;
  for (let i = 0; i < 10 && !alert; i++) {
    const r = await chat(key);
    if (r.status === 200 && r.cost) alert = await stopStore.recordSpend(id, "standard", r.cost);
  }
  check("safety stop trips on real spend, at once", alert !== null);
  const hash = stopStore.describe().find((d) => d.deploymentId === id)?.hash!;
  check("key switched off at OpenRouter", (await openRouterKeys.get(hash))?.disabled === true);
  let refused = 200;
  for (let i = 0; i < 6 && refused === 200; i++) { refused = (await chat(key)).status; if (refused === 200) await sleep(5000); }
  check("OpenRouter refuses the switched-off key", refused !== 200, `status=${refused}`);
  check("store refuses it too", (await stopStore.admit(id, "standard")).status === "stopped");
  await stopStore.resume(id);
  let back = 0;
  for (let i = 0; i < 6 && back !== 200; i++) { back = (await chat(key)).status; if (back !== 200) await sleep(5000); }
  check("resume: works again", back === 200, `status=${back}`);
  await stopStore.revoke(id);
  check("revoke deletes it at OpenRouter", (await openRouterKeys.get(hash)) === null);
} finally {
  for (const k of await openRouterKeys.list()) {
    if (k.name.startsWith(`${KEY_PREFIX}livetest-`)) await openRouterKeys.remove(k.hash);
  }
  const left = (await openRouterKeys.list()).filter((k) => k.name.startsWith(`${KEY_PREFIX}livetest-`));
  check("no throwaway keys left behind", left.length === 0, left.map((k) => k.name).join());
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
