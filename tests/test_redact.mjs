// A deployment record must reach the browser without its credentials.
//
// The deployment routes returned the whole row, so every buyer's dashboard
// received approvalWebhookToken and portalToken (what the agent container uses
// to talk to the platform) and, through the included agent, the creator's
// packageUrl. Found in the browser on 2026-09-19; no page read any of them.
import assert from "node:assert/strict";
import { redactSecrets, isSecretField } from "../apps/web/lib/redact.ts";

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push(`ok   ${name}`);
  } catch (e) {
    results.push(`FAIL ${name}: ${e.message}`);
  }
}

const row = {
  id: "dep1",
  agentName: "Data Analyst Two",
  workspaceEmail: "agent@example.com",
  autonomyConfig: { approvalPolicy: "always", agentMindEnabled: false },
  approvalWebhookToken: "x".repeat(64),
  portalToken: "p".repeat(25),
  agentEmailApiKey: "k",
  slackBotToken: null,
  deploymentServiceAccountKey: "{...}",
  createdAt: new Date("2026-09-19T00:00:00Z"),
  agent: { name: "Data Analyst", runtime: "CUSTOM", packageUrl: "https://blob/pkg.zip", capabilities: [{ name: "x" }] },
};

test("credentials are withheld from a single record", () => {
  const out = redactSecrets(row);
  for (const k of ["approvalWebhookToken", "portalToken", "agentEmailApiKey", "slackBotToken", "deploymentServiceAccountKey"]) {
    assert.equal(k in out, false, k);
  }
});

test("the creator's package link is withheld from the nested agent", () => {
  assert.equal("packageUrl" in redactSecrets(row).agent, false);
});

test("everything the dashboard reads survives, dates included", () => {
  const out = redactSecrets(row);
  assert.equal(out.agentName, "Data Analyst Two");
  assert.equal(out.workspaceEmail, "agent@example.com");
  assert.deepEqual(out.autonomyConfig, row.autonomyConfig);
  assert.equal(out.agent.runtime, "CUSTOM");
  assert.ok(out.createdAt instanceof Date);
});

test("a list of records is redacted item by item", () => {
  const out = redactSecrets([row, row]);
  assert.equal(out.length, 2);
  assert.equal("portalToken" in out[1], false);
});

test("a secret column added later is withheld without being listed", () => {
  assert.equal(isSecretField("stripeClientSecret"), true);
  assert.equal(isSecretField("githubAccessToken"), true);
  assert.equal(isSecretField("managerEmail"), false);
  assert.equal(isSecretField("tokensUsed"), false);
});

console.log(results.join("\n"));
if (results.some((r) => r.startsWith("FAIL"))) process.exit(1);
