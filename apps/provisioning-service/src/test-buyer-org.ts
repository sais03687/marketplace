/**
 * Quick integration test for buyer-org shared mailbox functions.
 * Uses the platform's own tenant as a simulated buyer tenant.
 *
 * Run: npx tsx src/test-buyer-org.ts
 */

import { config } from "./config.js";
import {
  mintTokenForTenant,
  getBuyerDomain,
  createAgentMailbox,
  getAgentMailbox,
  deleteAgentMailbox,
} from "./clients/microsoft-workspace.js";

const TENANT_ID = config.microsoftTenantId;

async function run() {
  console.log("=== Buyer-Org Integration Tests ===\n");
  console.log(`Using tenant: ${TENANT_ID}\n`);

  // Test 1: mintTokenForTenant
  console.log("1. mintTokenForTenant...");
  try {
    const token = await mintTokenForTenant(TENANT_ID);
    console.log(`   PASS — got token (expires in ${token.expires_in}s)\n`);
  } catch (err: any) {
    console.log(`   FAIL — ${err.message}\n`);
  }

  // Test 2: getBuyerDomain
  console.log("2. getBuyerDomain...");
  let domain = "";
  try {
    domain = await getBuyerDomain(TENANT_ID);
    console.log(`   PASS — domain: ${domain}\n`);
  } catch (err: any) {
    console.log(`   FAIL — ${err.message}\n`);
  }

  // Test 3: createAgentMailbox
  const testAlias = `test-buyer-org-${Date.now().toString(36)}`;
  console.log(`3. createAgentMailbox (alias: ${testAlias})...`);
  let mailboxId = "";
  let mailboxEmail = "";
  try {
    const result = await createAgentMailbox(TENANT_ID, "Test Buyer Org Agent", testAlias);
    mailboxId = result.id;
    mailboxEmail = result.email;
    console.log(`   PASS — created: ${result.email} (id: ${result.id})`);
    console.log(`   Note: Exchange conversion may have failed (needs Exchange.ManageAsApp)\n`);
  } catch (err: any) {
    console.log(`   FAIL — ${err.message}\n`);
  }

  // Test 4: getAgentMailbox
  if (mailboxEmail) {
    console.log(`4. getAgentMailbox (${mailboxEmail})...`);
    try {
      const result = await getAgentMailbox(TENANT_ID, mailboxEmail);
      if (result) {
        console.log(`   PASS — found: ${result.userPrincipalName} (id: ${result.id})\n`);
      } else {
        console.log(`   FAIL — returned null\n`);
      }
    } catch (err: any) {
      console.log(`   FAIL — ${err.message}\n`);
    }
  }

  // Test 5: deleteAgentMailbox (cleanup)
  if (mailboxId) {
    console.log(`5. deleteAgentMailbox (${mailboxId})...`);
    try {
      await deleteAgentMailbox(TENANT_ID, mailboxId);
      console.log(`   PASS — deleted\n`);
    } catch (err: any) {
      console.log(`   FAIL — ${err.message}\n`);
    }

    // Verify deletion
    console.log(`6. Verify deletion...`);
    try {
      const result = await getAgentMailbox(TENANT_ID, mailboxEmail);
      if (result === null) {
        console.log(`   PASS — confirmed deleted\n`);
      } else {
        console.log(`   FAIL — still exists\n`);
      }
    } catch (err: any) {
      console.log(`   PASS — ${err.message} (expected 404)\n`);
    }
  }

  console.log("=== Done ===");
}

run().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
