/**
 * Fix Azure AD permissions for buyer-org shared mailbox support.
 *
 * 1. Grant Exchange.ManageAsApp app role to our service principal
 * 2. Assign Exchange Administrator directory role to our service principal
 *
 * Run: MICROSOFT_TENANT_ID=... MICROSOFT_CLIENT_ID=... MICROSOFT_CLIENT_SECRET=... node src/fix-azure-permissions.mjs
 */

const TENANT = process.env.MICROSOFT_TENANT_ID;
const CLIENT_ID = process.env.MICROSOFT_CLIENT_ID;
const CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET;
const GRAPH = "https://graph.microsoft.com/v1.0";

async function getToken() {
  const resp = await fetch(
    `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        scope: "https://graph.microsoft.com/.default",
      }).toString(),
    },
  );
  const data = await resp.json();
  if (!resp.ok) throw new Error(`Token failed: ${JSON.stringify(data)}`);
  return data.access_token;
}

async function graph(token, method, path, body) {
  const resp = await fetch(`${GRAPH}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const status = resp.status;
  let data = null;
  if (status !== 204) {
    try { data = await resp.json(); } catch { data = await resp.text(); }
  }
  return { status, data };
}

async function run() {
  console.log("=== Fix Azure AD Permissions ===\n");

  const token = await getToken();

  // ─── Step 1: Find our app's service principal ───────────────────────────
  console.log("1. Finding our app's service principal...");
  const { data: spData } = await graph(
    token, "GET",
    `/servicePrincipals?$filter=appId eq '${CLIENT_ID}'&$select=id,displayName,appId`,
  );
  const ourSP = spData?.value?.[0];
  if (!ourSP) throw new Error("Service principal not found for our app");
  console.log(`   Found: ${ourSP.displayName} (SP id: ${ourSP.id})\n`);

  // ─── Step 2: Find the Office 365 Exchange Online service principal ──────
  console.log("2. Finding Office 365 Exchange Online service principal...");
  // The well-known appId for Office 365 Exchange Online is: 00000002-0000-0ff1-ce00-000000000000
  const EXCHANGE_APP_ID = "00000002-0000-0ff1-ce00-000000000000";
  const { data: exSPData } = await graph(
    token, "GET",
    `/servicePrincipals?$filter=appId eq '${EXCHANGE_APP_ID}'&$select=id,displayName,appRoles`,
  );
  const exchangeSP = exSPData?.value?.[0];
  if (!exchangeSP) {
    console.log("   NOT FOUND — Exchange Online SP doesn't exist in this tenant.");
    console.log("   This usually means Exchange Online isn't provisioned. Skipping app role grant.\n");
  } else {
    console.log(`   Found: ${exchangeSP.displayName} (SP id: ${exchangeSP.id})`);

    // Find the Exchange.ManageAsApp role
    const manageRole = exchangeSP.appRoles?.find(
      (r) => r.value === "Exchange.ManageAsApp",
    );
    if (!manageRole) {
      console.log("   WARNING: Exchange.ManageAsApp role not found in app roles.");
      console.log("   Available roles:", exchangeSP.appRoles?.map((r) => r.value).join(", "));
    } else {
      console.log(`   Exchange.ManageAsApp role id: ${manageRole.id}`);

      // ─── Step 3: Grant the app role ──────────────────────────────────────
      console.log("\n3. Granting Exchange.ManageAsApp to our service principal...");

      // Check if already granted
      const { data: existingGrants } = await graph(
        token, "GET",
        `/servicePrincipals/${ourSP.id}/appRoleAssignments?$filter=appRoleId eq ${manageRole.id}`,
      );
      const alreadyGranted = existingGrants?.value?.some(
        (g) => g.resourceId === exchangeSP.id,
      );

      if (alreadyGranted) {
        console.log("   Already granted. Skipping.\n");
      } else {
        const { status, data: grantResult } = await graph(
          token, "POST",
          `/servicePrincipals/${ourSP.id}/appRoleAssignments`,
          {
            principalId: ourSP.id,
            resourceId: exchangeSP.id,
            appRoleId: manageRole.id,
          },
        );
        if (status === 201 || status === 200) {
          console.log(`   GRANTED (id: ${grantResult?.id})\n`);
        } else {
          console.log(`   FAILED (${status}): ${JSON.stringify(grantResult?.error?.message || grantResult).slice(0, 300)}`);
          console.log("   You may need to grant this via Azure Portal → App registrations → API permissions.\n");
        }
      }
    }
  }

  // ─── Step 4: Assign Exchange Administrator directory role ───────────────
  console.log("4. Assigning Exchange Administrator role to our service principal...");

  // Find the Exchange Administrator role template
  const { data: rolesData } = await graph(
    token, "GET",
    "/directoryRoles",
  );
  let exchangeAdminRole = rolesData?.value?.find(
    (r) => r.displayName === "Exchange Administrator",
  );

  if (!exchangeAdminRole) {
    // Role might not be activated yet — activate it from the template
    console.log("   Exchange Administrator role not activated. Activating from template...");
    const { data: templates } = await graph(
      token, "GET",
      "/directoryRoleTemplates",
    );
    const exchangeTemplate = templates?.value?.find(
      (t) => t.displayName === "Exchange Administrator",
    );
    if (!exchangeTemplate) {
      console.log("   ERROR: Exchange Administrator template not found. Skipping.\n");
    } else {
      console.log(`   Template id: ${exchangeTemplate.id}`);
      const { status, data: activated } = await graph(
        token, "POST",
        "/directoryRoles",
        { roleTemplateId: exchangeTemplate.id },
      );
      if (status === 201 || status === 200) {
        exchangeAdminRole = activated;
        console.log(`   Activated: ${activated.id}`);
      } else {
        console.log(`   Activation failed (${status}): ${JSON.stringify(activated?.error?.message || activated).slice(0, 200)}`);
      }
    }
  }

  if (exchangeAdminRole) {
    // Check if already a member
    const { data: members } = await graph(
      token, "GET",
      `/directoryRoles/${exchangeAdminRole.id}/members?$select=id`,
    );
    const alreadyMember = members?.value?.some((m) => m.id === ourSP.id);

    if (alreadyMember) {
      console.log("   Already assigned. Skipping.\n");
    } else {
      const { status, data: assignResult } = await graph(
        token, "POST",
        `/directoryRoles/${exchangeAdminRole.id}/members/$ref`,
        {
          "@odata.id": `${GRAPH}/directoryObjects/${ourSP.id}`,
        },
      );
      if (status === 204 || status === 201 || status === 200) {
        console.log("   ASSIGNED\n");
      } else {
        console.log(`   FAILED (${status}): ${JSON.stringify(assignResult?.error?.message || assignResult).slice(0, 300)}`);
        console.log("   You may need to assign this via Azure Portal → Roles and administrators.\n");
      }
    }
  }

  // ─── Step 5: Check current license SKU ─────────────────────────────────
  console.log("5. Checking tenant license (for Excel Online)...");
  const { data: skus } = await graph(token, "GET", "/subscribedSkus");
  for (const sku of skus?.value || []) {
    const used = sku.consumedUnits;
    const total = sku.prepaidUnits?.enabled;
    console.log(`   ${sku.skuPartNumber}: ${used}/${total} licenses used`);

    // Check if any service plan includes Excel Online
    const excelPlan = sku.servicePlans?.find(
      (p) => p.servicePlanName?.includes("EXCEL") || p.servicePlanName?.includes("OFFICEMOBILE") || p.servicePlanName?.includes("OFFICE_WEB"),
    );
    if (excelPlan) {
      console.log(`   ↳ Has Excel Online: ${excelPlan.servicePlanName} (${excelPlan.provisioningStatus})`);
    }
  }

  // List service plans for the current SKU
  const currentSku = skus?.value?.[0];
  if (currentSku) {
    console.log(`\n   Service plans in ${currentSku.skuPartNumber}:`);
    for (const plan of currentSku.servicePlans || []) {
      console.log(`     - ${plan.servicePlanName} (${plan.provisioningStatus})`);
    }
  }

  console.log("\n=== Done ===");
}

run().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
