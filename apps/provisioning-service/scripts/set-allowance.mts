/**
 * Set one hire's monthly AI allowance, or put it back to its tier's.
 *
 *   npx tsx scripts/set-allowance.mts <deploymentId> <dollars>    e.g. 0.02 for a test hire
 *   npx tsx scripts/set-allowance.mts <deploymentId> reset
 *
 * Goes through the running service so its state and the key file stay in step.
 */
import "../src/load-env.js";

const [id, value] = process.argv.slice(2);
if (!id || !value) {
  console.error("usage: set-allowance.mts <deploymentId> <dollars|reset>");
  process.exit(2);
}
const amount = value === "reset" ? null : Number(value);
if (amount !== null && !(amount >= 0)) {
  console.error("dollars must be a number >= 0");
  process.exit(2);
}
const res = await fetch("http://localhost:3003/internal/agent-key/allowance", {
  method: "POST",
  headers: { Authorization: `Bearer ${process.env.PROVISIONING_SECRET ?? ""}`, "Content-Type": "application/json" },
  body: JSON.stringify({ deploymentId: id, amount }),
});
console.log(res.ok ? `Allowance for ${id}: ${amount === null ? "back to its tier" : `$${amount} a month`}` : `Failed: HTTP ${res.status} ${await res.text()}`);
