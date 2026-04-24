/**
 * Focused test: per-deployment Google Service Account creation & deletion.
 * Uses the new GCP_IAM_KEY (marketplace-provisioner SA) directly.
 *
 * Run: node --env-file=.env test-sa-creation.mjs
 */

import { createRequire } from "module";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { readFileSync, existsSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Load .env manually (--env-file flag handles it, but be safe)
const envPath = join(__dirname, ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim();
    if (!process.env[k]) process.env[k] = v;
  }
}

const GCP_IAM_KEY    = process.env.GCP_IAM_KEY;
const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID;
const AGENT_SA_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;

let passed = 0, failed = 0;
const ok   = (l) => { console.log(`  ✓ ${l}`); passed++; };
const fail = (l, d = "") => { console.log(`  ✗ FAIL: ${l}${d ? " — " + d : ""}`); failed++; };

// ── Load the compiled google-iam module ──────────────────────────────────────

let createDeploymentServiceAccount, deleteDeploymentServiceAccount;
try {
  const mod = await import("./apps/provisioning-service/dist/clients/google-iam.js");
  createDeploymentServiceAccount = mod.createDeploymentServiceAccount;
  deleteDeploymentServiceAccount = mod.deleteDeploymentServiceAccount;
} catch (e) {
  console.error("Could not load google-iam module:", e.message);
  console.error("Make sure you've compiled: cd apps/provisioning-service && npx tsc -p tsconfig.json");
  process.exit(1);
}

// ── Pre-flight checks ────────────────────────────────────────────────────────

console.log("\n╔══════════════════════════════════════════════╗");
console.log("║  Service Account Creation Test               ║");
console.log("╚══════════════════════════════════════════════╝\n");

console.log("── Pre-flight ──────────────────────────────────");
if (GCP_IAM_KEY)    ok(`GCP_IAM_KEY set (${GCP_IAM_KEY.length} chars)`);
else                { fail("GCP_IAM_KEY not set in .env"); process.exit(1); }

if (GCP_PROJECT_ID) ok(`GCP_PROJECT_ID: ${GCP_PROJECT_ID}`);
else                { fail("GCP_PROJECT_ID not set in .env"); process.exit(1); }

if (AGENT_SA_EMAIL) ok(`Platform agent SA (for comparison): ${AGENT_SA_EMAIL}`);

// Decode the IAM key and print the SA email it belongs to
let iamKeyObj;
try {
  try { iamKeyObj = JSON.parse(GCP_IAM_KEY); }
  catch { iamKeyObj = JSON.parse(Buffer.from(GCP_IAM_KEY, "base64").toString("utf-8")); }
  ok(`IAM key belongs to: ${iamKeyObj.client_email}`);
  if (iamKeyObj.client_email === AGENT_SA_EMAIL) {
    fail("IAM key is the same as the agent identity SA — should be separate");
  } else {
    ok("IAM key is correctly a different SA from the agent identity");
  }
} catch (e) {
  fail("Could not parse GCP_IAM_KEY as JSON", e.message);
  process.exit(1);
}

// ── Test 1: Create a service account ────────────────────────────────────────

console.log("\n── Test 1: Create per-deployment service account ──");

const fakeDeploymentId = `test${Date.now().toString(36)}`;
const agentSlug        = "general-ops-alex";

let createdSA;
try {
  console.log(`  Creating SA for deployment: ${fakeDeploymentId}`);
  createdSA = await createDeploymentServiceAccount(
    fakeDeploymentId,
    agentSlug,
    GCP_PROJECT_ID,
    GCP_IAM_KEY,
  );

  ok(`SA created: ${createdSA.email}`);

  if (createdSA.email !== AGENT_SA_EMAIL) {
    ok("SA email is unique (different from platform agent SA)");
  } else {
    fail("SA email matches the platform SA — something went wrong");
  }

  if (createdSA.email.includes("iam.gserviceaccount.com")) {
    ok("SA email has correct GCP format");
  } else {
    fail("SA email format unexpected", createdSA.email);
  }

  if (createdSA.email.includes(`sa-`) && createdSA.email.includes(fakeDeploymentId.slice(0, 8))) {
    ok("SA name contains agent slug + deployment ID prefix");
  }

  if (createdSA.privateKeyJson && createdSA.privateKeyJson.length > 100) {
    ok(`Private key JSON returned (${createdSA.privateKeyJson.length} chars)`);
    // Verify it's valid JSON with expected fields
    const keyObj = JSON.parse(createdSA.privateKeyJson);
    if (keyObj.type === "service_account" && keyObj.client_email === createdSA.email) {
      ok("Private key JSON is valid and matches SA email");
    } else {
      fail("Private key JSON fields mismatch");
    }
  } else {
    fail("Private key JSON missing or too short");
  }

  if (createdSA.clientId && /^\d+$/.test(createdSA.clientId)) {
    ok(`Client ID returned: ${createdSA.clientId} (used for DWD setup)`);
  } else {
    fail("Client ID missing or invalid", createdSA.clientId);
  }

  // Confirm it's NOT the provisioner SA itself
  if (createdSA.email !== iamKeyObj.client_email) {
    ok("Created SA is different from the provisioner SA (correct — provisioner creates, not self-replicates)");
  }

} catch (e) {
  fail("SA creation", e.message);
  console.log("\n  Common causes:");
  console.log("  - marketplace-provisioner SA missing roles/iam.serviceAccountCreator");
  console.log("  - marketplace-provisioner SA missing roles/iam.serviceAccountKeyAdmin");
  console.log("  - IAM API not enabled on the project");
  console.log(`\n  Full error: ${e.stack}`);
}

// ── Test 2: Delete the service account ──────────────────────────────────────

console.log("\n── Test 2: Delete service account (cleanup) ──");

if (createdSA?.email) {
  try {
    await deleteDeploymentServiceAccount(createdSA.email, GCP_PROJECT_ID, GCP_IAM_KEY);
    ok(`SA deleted: ${createdSA.email}`);
  } catch (e) {
    fail("SA deletion", e.message);
    console.log("  The SA was created but not cleaned up — delete manually:");
    console.log(`  SA email: ${createdSA.email}`);
  }
} else {
  console.log("  Skipped (no SA was created)");
}

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(48)}`);
console.log(`  ✓ Passed: ${passed}   ✗ Failed: ${failed}`);
console.log(`${"─".repeat(48)}\n`);

process.exit(failed > 0 ? 1 : 0);
