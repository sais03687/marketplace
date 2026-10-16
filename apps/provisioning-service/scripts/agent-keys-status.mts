/**
 * Every hire's model spend: what the broker metered next to what OpenRouter
 * reports for the hire's key. Never prints a key's secret.
 *
 *   cd /opt/marketplace/apps/provisioning-service && npx tsx scripts/agent-keys-status.mts
 *
 * Reading it:
 *   - "metered" is what enforces the allowance and the safety stop. It moves
 *     the moment a call returns.
 *   - "openrouter" lags (measured: no change ten minutes after paid calls), so
 *     a gap between the two right after use is expected.
 *   - "stopped" means the safety stop tripped; lift it with
 *     POST /internal/agent-key/resume after finding out why.
 */
import "../src/load-env.js";
import fs from "node:fs";
import path from "node:path";
import { prisma } from "@marketplace/db";
import { openRouterKeys } from "../src/clients/openrouter-keys.js";
import { KEY_PREFIX, MONTHLY_ALLOWANCE, asTier } from "../src/agent-keys.js";

const file = process.env.AGENT_KEYS_PATH || path.resolve(process.cwd(), ".agent-llm-keys.json");
let store: any = { keys: {}, ledger: {} };
try {
  store = JSON.parse(fs.readFileSync(file, "utf8"));
} catch {
  console.log(`(no key file yet at ${file} — no hire has called the model through the broker)`);
}
const remote = (await openRouterKeys.list()).filter((k) => k.name.startsWith(KEY_PREFIX));
const ids = new Set([...Object.keys(store.keys ?? {}), ...Object.keys(store.ledger ?? {}), ...remote.map((k) => k.name.slice(KEY_PREFIX.length))]);
const deps = await prisma.deployment.findMany({
  where: { id: { in: [...ids] } },
  select: { id: true, agentName: true, status: true, agent: { select: { modelTier: true } } },
});
const byId = new Map(deps.map((d) => [d.id, d]));
const usd = (n: number | null | undefined) => (typeof n === "number" ? `$${n.toFixed(4)}` : "-");

if (ids.size === 0) console.log("No per-hire keys or metered spend yet.");
for (const id of ids) {
  const d = byId.get(id);
  const tier = asTier(d?.agent?.modelTier);
  const l = store.ledger?.[id];
  const k = remote.find((r) => r.name === `${KEY_PREFIX}${id}`);
  const ours = store.keys?.[id];
  console.log(`\n${d?.agentName ?? "(no such hire)"}  ${id}  [${d?.status ?? "missing"}, ${tier}]`);
  console.log(`  metered this month (${l?.month ?? "-"}): ${usd(l?.spent)} of ${usd((l?.allowanceOverride ?? MONTHLY_ALLOWANCE[tier]) + (l?.extra ?? 0))}${l?.allowanceOverride !== undefined ? " (operator-set allowance)" : ""}${l?.extra ? ` (incl. ${usd(l.extra)} bought)` : ""}`);
  console.log(`  safety stop: ${l?.stoppedAt ? `STOPPED ${l.stoppedAt} — ${l.stopReason}` : "not tripped"}`);
  console.log(`  openrouter key: ${k ? `usage ${usd(k.usage)}, limit ${usd(k.limit)}, ${k.disabled ? "SWITCHED OFF" : "on"}` : "none"}`);
  if (ours && k && ours.hash !== k.hash) console.log("  WARNING: the key file and OpenRouter disagree on which key this hire uses (the hourly sweep fixes this)");
  if (ours && !k) console.log("  WARNING: key in the file but not at OpenRouter (it will be recreated on the next call)");
}
await prisma.$disconnect();
