/**
 * Live test of per-hire keys against the real OpenRouter account.
 *
 * Creates a throwaway key named agentstore:livetest-<time>, makes real (cheap)
 * model calls with it, trips the safety stop with a one-cent threshold, lifts
 * it, revokes the key, and checks every step at OpenRouter. Costs well under
 * a cent. Always cleans up its key, even on failure.
 *
 *   cd apps/provisioning-service && npx tsx scripts/live-test-agent-keys.mts
 */
import "../src/load-env.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentKeyStore, KEY_PREFIX } from "../src/agent-keys.js";
import { openRouterKeys } from "../src/clients/openrouter-keys.js";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function chat(key: string): Promise<number> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "openai/gpt-oss-120b", messages: [{ role: "user", content: "Reply with the word ok." }], max_tokens: 20 }),
  });
  await res.text();
  return res.status;
}

const id = `livetest-${Date.now()}`;
const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "live-keys-")), "keys.json");
const store = new AgentKeyStore(file, openRouterKeys, () => Date.now(), { standard: 0.000001, pro: 0.000001, premium: 0.000001 });

try {
  const look = await store.keyFor(id, "standard");
  check("key created", look.status === "ok");
  const key = (look as any).key as string;
  const hash = store.describe()[0].hash;
  const remote = await openRouterKeys.get(hash);
  check("visible at OpenRouter with the platform name", remote?.name === `${KEY_PREFIX}${id}`, remote?.name);
  check("standard limit $0.50, monthly reset", remote?.limit === 0.5 && remote?.limit_reset === "monthly", `${remote?.limit} ${remote?.limit_reset}`);
  check("found by list()", (await openRouterKeys.list()).some((k) => k.hash === hash));

  await store.checkRunaway(); // baseline reading
  check("model call works on the new key", (await chat(key)) === 200);

  let usage = 0;
  for (let i = 0; i < 24 && usage === 0; i++) { await sleep(5000); usage = (await openRouterKeys.get(hash))?.usage ?? 0; }
  check("spend lands on this key", usage > 0, `usage=${usage}`);

  const stopped = await store.checkRunaway();
  check("safety stop trips", stopped.length === 1, JSON.stringify(stopped));
  check("key disabled at OpenRouter", (await openRouterKeys.get(hash))?.disabled === true);
  const refused = await chat(key);
  check("model call refused while stopped", refused !== 200, `status=${refused}`);
  check("store reports it stopped", (await store.keyFor(id, "standard")).status === "stopped");

  await store.resume(id);
  check("resume re-enables at OpenRouter", (await openRouterKeys.get(hash))?.disabled === false);
  let again = 0;
  for (let i = 0; i < 6 && again !== 200; i++) { again = await chat(key); if (again !== 200) await sleep(5000); }
  check("model call works again after resume", again === 200, `status=${again}`);

  await store.revoke(id);
  check("revoke deletes it at OpenRouter", (await openRouterKeys.get(hash)) === null);
  let gone = 200;
  for (let i = 0; i < 6 && gone === 200; i++) { gone = await chat(key); if (gone === 200) await sleep(5000); }
  check("deleted key can no longer call the model", gone !== 200, `status=${gone}`);
} finally {
  // Whatever happened above, leave no test key behind.
  for (const k of await openRouterKeys.list()) {
    if (k.name.startsWith(`${KEY_PREFIX}livetest-`)) await openRouterKeys.remove(k.hash);
  }
  const left = (await openRouterKeys.list()).filter((k) => k.name.startsWith(`${KEY_PREFIX}livetest-`));
  check("no test keys left behind", left.length === 0, left.map((k) => k.name).join());
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
