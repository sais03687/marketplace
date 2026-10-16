/**
 * Send a clearly-marked TEST safety-stop email to the platform mailbox, to
 * check the email path. Stops nothing.
 *
 *   cd /opt/marketplace/apps/provisioning-service && npx tsx scripts/send-test-stop-email.mts <deploymentId>
 */
import "../src/load-env.js";
import { tellOperator } from "../src/jobs/agent-key-monitor.js";

const id = process.argv[2];
if (!id) { console.error("usage: send-test-stop-email.mts <deploymentId>"); process.exit(2); }
await tellOperator({ deploymentId: id, tier: "pro", spentLastHour: 0, stop: 5 }, { test: true });
console.log("Test email sent to the platform mailbox.");
process.exit(0);
