/**
 * Lift a hire's safety stop, after finding out why it tripped.
 *
 *   cd /opt/marketplace/apps/provisioning-service && npx tsx scripts/lift-safety-stop.mts <deploymentId>
 *
 * Goes through the running service, so its in-memory state and the key file
 * stay in step. Switches the hire's OpenRouter key back on.
 */
import "../src/load-env.js";

const id = process.argv[2];
if (!id) {
  console.error("usage: lift-safety-stop.mts <deploymentId>");
  process.exit(2);
}
const res = await fetch("http://localhost:3003/internal/agent-key/resume", {
  method: "POST",
  headers: { Authorization: `Bearer ${process.env.PROVISIONING_SECRET ?? ""}`, "Content-Type": "application/json" },
  body: JSON.stringify({ deploymentId: id }),
});
const body = await res.json().catch(() => ({}));
if (res.ok && body.lifted) console.log(`Safety stop lifted for ${id}. Its key is switched back on.`);
else if (res.status === 404) console.log(`${id} has no safety stop to lift.`);
else console.log(`Could not lift it: HTTP ${res.status} ${JSON.stringify(body)}`);
