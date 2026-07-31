/**
 * Full buyer-org integration test.
 *
 * Simulates the REAL provisioning flow:
 *   1. Create shared mailbox in "buyer" tenant (using our own tenant)
 *   2. Provision OneDrive for that user
 *   3. Test ALL agent capabilities: email, calendar, SharePoint, OneDrive, Excel
 *   4. Clean up
 *
 * This validates the exact same code path that runs when a buyer connects via OAuth.
 *
 * Run:
 *   MICROSOFT_TENANT_ID=... MICROSOFT_CLIENT_ID=... MICROSOFT_CLIENT_SECRET=... \
 *   npx tsx src/test-buyer-org-full.ts
 */

import { config } from "./config.js";
import {
  mintTokenForTenant,
  getBuyerDomain,
  createAgentMailbox,
  deleteAgentMailbox,
  provisionOneDrive,
} from "./clients/microsoft-workspace.js";

const TENANT = config.microsoftTenantId;
const CLIENT_ID = config.microsoftClientId;
const CLIENT_SECRET = config.microsoftClientSecret;
const GRAPH = "https://graph.microsoft.com/v1.0";

let token = "";
let passed = 0;
let failed = 0;
let skipped = 0;

// Will be set after shared mailbox creation
let testUserEmail = "";
let testUserId = "";

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getToken(): Promise<string> {
  if (token) return token;
  const result = await mintTokenForTenant(TENANT);
  token = result.access_token;
  return token;
}

async function graph(
  method: string,
  path: string,
  body?: unknown,
  contentType = "application/json",
): Promise<{ status: number; data: any }> {
  const t = await getToken();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${t}`,
    "Content-Type": contentType,
  };
  const resp = await fetch(`${GRAPH}${path}`, {
    method,
    headers,
    ...(body
      ? {
          body:
            contentType === "application/json"
              ? JSON.stringify(body)
              : (body as any),
        }
      : {}),
  });
  const status = resp.status;
  let data: any = null;
  if (status !== 204 && status !== 202) {
    try {
      data = await resp.json();
    } catch {
      try { data = await resp.text(); } catch { data = null; }
    }
  }
  return { status, data };
}

function userUrl(path: string): string {
  return `/users/${encodeURIComponent(testUserEmail)}/${path}`;
}

function driveUrl(path: string): string {
  return `/sites/root/drive/${path}`;
}

async function test(
  name: string,
  fn: () => Promise<{ ok: boolean; detail?: string }>,
): Promise<boolean> {
  process.stdout.write(`  ${name}... `);
  try {
    const result = await fn();
    if (result.ok) {
      console.log(`PASS${result.detail ? ` — ${result.detail}` : ""}`);
      passed++;
      return true;
    } else {
      console.log(`FAIL${result.detail ? ` — ${result.detail}` : ""}`);
      failed++;
      return false;
    }
  } catch (err: any) {
    console.log(`FAIL — ${err.message?.slice(0, 200)}`);
    failed++;
    return false;
  }
}

function skip(name: string, reason: string): void {
  console.log(`  ${name}... SKIP — ${reason}`);
  skipped++;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

async function run() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║   Buyer-Org Full Integration Test (Simulated Cross-Tenant)  ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");
  console.log(`Tenant (simulated buyer): ${TENANT}`);

  if (!TENANT || !CLIENT_ID || !CLIENT_SECRET) {
    console.error("ERROR: Missing MICROSOFT_TENANT_ID, CLIENT_ID, or CLIENT_SECRET");
    process.exit(1);
  }

  // ── Phase 0: Provisioning (what happens when buyer clicks "Connect Microsoft") ──
  console.log("\n── Phase 0: Provisioning (OAuth → shared mailbox → OneDrive) ──\n");

  // 0a. Token
  await test("0a. Mint token for buyer tenant", async () => {
    const t = await getToken();
    return { ok: t.length > 100, detail: `token length: ${t.length}` };
  });

  // 0b. Domain discovery
  let domain = "";
  await test("0b. Discover buyer domain", async () => {
    domain = await getBuyerDomain(TENANT);
    return { ok: !!domain, detail: domain };
  });

  // 0c. Check buyer's subscription (what features are available)
  await test("0c. Check buyer subscription / licenses", async () => {
    const { status, data } = await graph("GET", "/subscribedSkus?$select=skuPartNumber,consumedUnits,prepaidUnits,servicePlans");
    if (status !== 200) return { ok: false, detail: `status ${status}` };
    const skus = data?.value || [];
    const skuNames = skus.map((s: any) => `${s.skuPartNumber}(${s.consumedUnits}/${s.prepaidUnits?.enabled})`);

    // Check for Excel Online capability
    let hasExcel = false;
    for (const sku of skus) {
      const excelPlan = sku.servicePlans?.find((p: any) =>
        p.servicePlanName?.includes("OFFICESUBSCRIPTION") ||
        p.servicePlanName?.includes("OFFICE_WEB") ||
        p.servicePlanName?.includes("OFFICEMOBILE"),
      );
      if (excelPlan && excelPlan.provisioningStatus === "Success") hasExcel = true;
    }

    return {
      ok: skus.length > 0,
      detail: `${skuNames.join(", ")} | Excel Online: ${hasExcel ? "YES" : "NO"}`,
    };
  });

  // 0d. Create shared mailbox (THE critical provisioning step)
  const alias = `test-buyer-full-${Date.now().toString(36)}`;
  console.log(`\n  Creating shared mailbox: ${alias}@${domain}...`);

  const mailboxCreated = await test("0d. Create shared mailbox (license → convert → unlicense)", async () => {
    const result = await createAgentMailbox(TENANT, "Test Buyer Full Agent", alias);
    testUserId = result.id;
    testUserEmail = result.email;
    return { ok: !!testUserId && !!testUserEmail, detail: `${testUserEmail} (id: ${testUserId.slice(0, 12)}...)` };
  });

  if (!mailboxCreated) {
    console.error("\n  FATAL: Shared mailbox creation failed. Cannot continue.\n");
    process.exit(1);
  }

  // 0e. Verify shared mailbox exists
  await test("0e. Verify shared mailbox via Graph lookup", async () => {
    const { status, data } = await graph(
      "GET",
      `/users/${encodeURIComponent(testUserEmail)}?$select=id,userPrincipalName,displayName,accountEnabled`,
    );
    return {
      ok: status === 200 && data?.userPrincipalName === testUserEmail,
      detail: `${data?.displayName} (enabled: ${data?.accountEnabled})`,
    };
  });

  // 0f. Provision OneDrive for the shared mailbox user
  await test("0f. Provision OneDrive for agent user", async () => {
    try {
      await provisionOneDrive(TENANT, [testUserId]);
      return { ok: true, detail: "provisioning request sent" };
    } catch (err: any) {
      // OneDrive provisioning can fail if user is disabled — expected for shared mailbox
      return { ok: false, detail: err.message?.slice(0, 150) };
    }
  });

  // Wait for Exchange + OneDrive propagation
  console.log("\n  Waiting 15s for Exchange + OneDrive propagation...\n");
  await sleep(15000);

  // ── Phase 1: Email ──────────────────────────────────────────────────────────
  console.log("── Phase 1: Email (Shared Mailbox) ──");

  await test("1a. List inbox messages", async () => {
    const { status, data } = await graph(
      "GET",
      userUrl("mailFolders/Inbox/messages?$top=5&$select=id,subject,from,receivedDateTime,isRead&$orderby=receivedDateTime desc"),
    );
    if (status !== 200) return { ok: false, detail: `status ${status} — ${data?.error?.message}` };
    return { ok: true, detail: `${data?.value?.length ?? 0} messages` };
  });

  let sentMessageId = "";
  await test("1b. Send email (to self)", async () => {
    const t = await getToken();
    const resp = await fetch(`${GRAPH}${userUrl("sendMail")}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          subject: `Buyer-Org Test — ${new Date().toISOString().slice(0, 16)}`,
          body: { contentType: "text", content: "Automated buyer-org integration test." },
          toRecipients: [{ emailAddress: { address: testUserEmail } }],
        },
      }),
    });
    return { ok: resp.status === 202 || resp.status === 200 || resp.status === 204, detail: `status ${resp.status}` };
  });

  // Wait for email delivery
  await sleep(5000);

  await test("1c. Search inbox for sent email", async () => {
    const { status, data } = await graph(
      "GET",
      userUrl(`messages?$search="Buyer-Org Test"&$select=id,subject&$top=5`),
    );
    if (status === 200 && data?.value?.length > 0) {
      sentMessageId = data.value[0].id;
    }
    return { ok: status === 200, detail: `${data?.value?.length ?? 0} results` };
  });

  if (sentMessageId) {
    await test("1d. Read email message", async () => {
      const { status, data } = await graph("GET", userUrl(`messages/${sentMessageId}?$select=id,subject,body,from`));
      return { ok: status === 200, detail: `subject: "${data?.subject}"` };
    });

    await test("1e. Mark email as read", async () => {
      const { status } = await graph("PATCH", userUrl(`messages/${sentMessageId}`), { isRead: true });
      return { ok: status === 200 };
    });

    await test("1f. Reply to email", async () => {
      const t = await getToken();
      const resp = await fetch(`${GRAPH}${userUrl(`messages/${sentMessageId}/reply`)}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
        body: JSON.stringify({ comment: "Automated reply from buyer-org test." }),
      });
      return { ok: resp.status === 202 || resp.status === 200 || resp.status === 204, detail: `status ${resp.status}` };
    });

    await test("1g. Forward email", async () => {
      const t = await getToken();
      const resp = await fetch(`${GRAPH}${userUrl(`messages/${sentMessageId}/forward`)}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          comment: "Forwarded from buyer-org test.",
          toRecipients: [{ emailAddress: { address: testUserEmail } }],
        }),
      });
      return { ok: resp.status === 202 || resp.status === 200 || resp.status === 204, detail: `status ${resp.status}` };
    });
  } else {
    skip("1d. Read email message", "no message found from search");
    skip("1e. Mark email as read", "no message found");
    skip("1f. Reply to email", "no message found");
    skip("1g. Forward email", "no message found");
  }

  // ── Phase 2: Calendar ───────────────────────────────────────────────────────
  console.log("\n── Phase 2: Calendar ──");

  let testEventId = "";

  await test("2a. List calendar events", async () => {
    const now = new Date().toISOString();
    const end = new Date(Date.now() + 30 * 86400000).toISOString();
    const { status, data } = await graph(
      "GET",
      userUrl(`calendarView?startDateTime=${now}&endDateTime=${end}&$top=5&$select=id,subject`),
    );
    return { ok: status === 200, detail: `${data?.value?.length ?? 0} events` };
  });

  await test("2b. Create calendar event", async () => {
    const start = new Date(Date.now() + 86400000).toISOString().slice(0, 19);
    const end = new Date(Date.now() + 86400000 + 3600000).toISOString().slice(0, 19);
    const { status, data } = await graph("POST", userUrl("events"), {
      subject: "Buyer-Org Integration Test Event",
      body: { contentType: "text", content: "Created by buyer-org test runner" },
      start: { dateTime: start, timeZone: "UTC" },
      end: { dateTime: end, timeZone: "UTC" },
    });
    testEventId = data?.id || "";
    return { ok: status === 201 && !!testEventId, detail: `id: ${testEventId?.slice(0, 20)}...` };
  });

  await test("2c. Update calendar event", async () => {
    if (!testEventId) return { ok: false, detail: "no event to update" };
    const { status } = await graph("PATCH", userUrl(`events/${testEventId}`), {
      subject: "Buyer-Org Test Event (Updated)",
    });
    return { ok: status === 200 };
  });

  await test("2d. Delete calendar event", async () => {
    if (!testEventId) return { ok: false, detail: "no event to delete" };
    const { status } = await graph("DELETE", userUrl(`events/${testEventId}`));
    return { ok: status === 204 };
  });

  // ── Phase 3: SharePoint Files ───────────────────────────────────────────────
  console.log("\n── Phase 3: SharePoint Files ──");

  let spFolderId = "";
  let spFileId = "";
  const SP_FOLDER = "test-buyer-org-agent";

  await test("3a. Create SharePoint folder (agent workspace)", async () => {
    const { status, data } = await graph("POST", driveUrl("root/children"), {
      name: SP_FOLDER,
      folder: {},
      "@microsoft.graph.conflictBehavior": "fail",
    });
    if (status === 409) {
      const { data: existing } = await graph("GET", driveUrl(`root:/${SP_FOLDER}`));
      spFolderId = existing?.id || "";
      return { ok: !!spFolderId, detail: "already exists (idempotent)" };
    }
    spFolderId = data?.id || "";
    return { ok: status === 201 && !!spFolderId, detail: `id: ${spFolderId?.slice(0, 20)}` };
  });

  await test("3b. Upload file to SharePoint", async () => {
    const content = "Buyer-org test file — " + new Date().toISOString();
    const resp = await fetch(
      `${GRAPH}${driveUrl(`root:/${SP_FOLDER}/buyer-test.txt:/content`)}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${await getToken()}`,
          "Content-Type": "text/plain",
        },
        body: content,
      },
    );
    const data = await resp.json();
    spFileId = data?.id || "";
    return { ok: resp.ok && !!spFileId, detail: `size: ${data?.size} bytes` };
  });

  await test("3c. List files in SharePoint folder", async () => {
    const { status, data } = await graph(
      "GET",
      driveUrl(`root:/${SP_FOLDER}:/children?$select=id,name,size`),
    );
    const files = data?.value || [];
    return { ok: status === 200 && files.length > 0, detail: `${files.length} file(s): ${files.map((f: any) => f.name).join(", ")}` };
  });

  await test("3d. Download file from SharePoint", async () => {
    if (!spFileId) return { ok: false, detail: "no file to download" };
    const resp = await fetch(
      `${GRAPH}${driveUrl(`items/${spFileId}/content`)}`,
      {
        headers: { Authorization: `Bearer ${await getToken()}` },
        redirect: "follow",
      },
    );
    const text = await resp.text();
    return { ok: resp.ok && text.includes("Buyer-org test"), detail: `${text.length} chars` };
  });

  await test("3e. Search SharePoint drive", async () => {
    const { status, data } = await graph(
      "GET",
      driveUrl(`root/search(q='buyer-test')?$select=id,name&$top=5`),
    );
    return { ok: status === 200, detail: `${data?.value?.length ?? 0} results` };
  });

  await test("3f. Get file metadata", async () => {
    if (!spFileId) return { ok: false, detail: "no file" };
    const { status, data } = await graph("GET", driveUrl(`items/${spFileId}`));
    return { ok: status === 200, detail: `name: ${data?.name}, size: ${data?.size}` };
  });

  await test("3g. Share file (create sharing link)", async () => {
    if (!spFileId) return { ok: false, detail: "no file" };
    const { status, data } = await graph("POST", driveUrl(`items/${spFileId}/createLink`), {
      type: "view",
      scope: "organization",
    });
    return { ok: status === 200 || status === 201, detail: data?.link?.webUrl?.slice(0, 60) || "link created" };
  });

  // ── Phase 4: OneDrive ───────────────────────────────────────────────────────
  console.log("\n── Phase 4: OneDrive (Personal Agent Drive) ──");

  let oneDriveReady = false;
  let oneDriveFileId = "";
  let oneDriveFolderId = "";

  await test("4a. Check OneDrive provisioned", async () => {
    const { status, data } = await graph("GET", userUrl("drive"));
    if (status === 404 || data?.error?.code === "ResourceNotFound") {
      return { ok: false, detail: "OneDrive NOT provisioned — shared mailbox users may not get OneDrive" };
    }
    oneDriveReady = status === 200;
    return { ok: status === 200, detail: `quota: ${data?.quota?.total ? Math.round(data.quota.total / 1e9) + "GB" : "unknown"}` };
  });

  if (oneDriveReady) {
    await test("4b. List OneDrive root", async () => {
      const { status, data } = await graph("GET", userUrl("drive/root/children?$select=id,name,size&$top=10"));
      return { ok: status === 200, detail: `${data?.value?.length ?? 0} items` };
    });

    await test("4c. Create OneDrive folder", async () => {
      const { status, data } = await graph("POST", userUrl("drive/root/children"), {
        name: "agent-workspace",
        folder: {},
        "@microsoft.graph.conflictBehavior": "fail",
      });
      if (status === 409) {
        const { data: existing } = await graph("GET", userUrl("drive/root:/agent-workspace"));
        oneDriveFolderId = existing?.id || "";
        return { ok: true, detail: "already exists" };
      }
      oneDriveFolderId = data?.id || "";
      return { ok: status === 201, detail: `id: ${data?.id?.slice(0, 20)}` };
    });

    await test("4d. Upload file to OneDrive", async () => {
      const content = "OneDrive buyer-org test — " + new Date().toISOString();
      const resp = await fetch(
        `${GRAPH}/users/${encodeURIComponent(testUserEmail)}/drive/root:/agent-workspace/test.txt:/content`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${await getToken()}`,
            "Content-Type": "text/plain",
          },
          body: content,
        },
      );
      if (!resp.ok) {
        const errData = await resp.json().catch(() => ({}));
        return { ok: false, detail: `status ${resp.status} — ${(errData as any)?.error?.message || "unknown"}` };
      }
      const data = await resp.json();
      oneDriveFileId = data?.id || "";
      return { ok: !!oneDriveFileId, detail: `size: ${data?.size} bytes` };
    });

    await test("4e. Download file from OneDrive", async () => {
      if (!oneDriveFileId) return { ok: false, detail: "no file uploaded" };
      const resp = await fetch(
        `${GRAPH}/users/${encodeURIComponent(testUserEmail)}/drive/items/${oneDriveFileId}/content`,
        {
          headers: { Authorization: `Bearer ${await getToken()}` },
          redirect: "follow",
        },
      );
      const text = await resp.text();
      return { ok: resp.ok && text.includes("buyer-org test"), detail: `${text.length} chars` };
    });

    await test("4f. Search OneDrive", async () => {
      const { status, data } = await graph(
        "GET",
        userUrl("drive/root/search(q='test')?$select=id,name&$top=5"),
      );
      return { ok: status === 200, detail: `${data?.value?.length ?? 0} results` };
    });

    await test("4g. Share OneDrive file (create link)", async () => {
      if (!oneDriveFileId) return { ok: false, detail: "no file" };
      const { status, data } = await graph("POST", userUrl(`drive/items/${oneDriveFileId}/createLink`), {
        type: "view",
        scope: "organization",
      });
      return { ok: status === 200 || status === 201, detail: data?.link?.webUrl?.slice(0, 60) || "link created" };
    });

    // Cleanup OneDrive
    if (oneDriveFileId) {
      await test("4h. Delete OneDrive test file", async () => {
        const { status } = await graph("DELETE", userUrl(`drive/items/${oneDriveFileId}`));
        return { ok: status === 204 };
      });
    }
    if (oneDriveFolderId) {
      await test("4i. Delete OneDrive test folder", async () => {
        const { status } = await graph("DELETE", userUrl(`drive/items/${oneDriveFolderId}`));
        return { ok: status === 204 };
      });
    }
  } else {
    skip("4b-4i. OneDrive tests", "OneDrive not provisioned for shared mailbox user");
  }

  // ── Phase 5: Excel (plan-dependent) ─────────────────────────────────────────
  console.log("\n── Phase 5: Excel Online ──");

  // Check if there's an existing xlsx on SharePoint to test with
  let excelFileId = "";
  await test("5a. Find existing .xlsx on SharePoint", async () => {
    const { status, data } = await graph(
      "GET",
      driveUrl(`root/search(q='.xlsx')?$select=id,name&$top=1`),
    );
    if (status === 200 && data?.value?.length > 0) {
      excelFileId = data.value[0].id;
      return { ok: true, detail: `found: ${data.value[0].name}` };
    }
    return { ok: false, detail: "no .xlsx found — Excel tests will be skipped" };
  });

  if (excelFileId) {
    await test("5b. List worksheets", async () => {
      const { status, data } = await graph("GET", driveUrl(`items/${excelFileId}/workbook/worksheets?$select=name`));
      if (status !== 200) return { ok: false, detail: `status ${status} — ${data?.error?.message || JSON.stringify(data).slice(0, 100)}` };
      const sheets = data?.value?.map((s: any) => s.name) || [];
      return { ok: sheets.length > 0, detail: `sheets: ${sheets.join(", ")}` };
    });

    await test("5c. Read Excel range", async () => {
      const { data: wsData } = await graph("GET", driveUrl(`items/${excelFileId}/workbook/worksheets?$select=name`));
      const sheetName = wsData?.value?.[0]?.name || "Sheet1";
      const { status, data } = await graph(
        "GET",
        driveUrl(`items/${excelFileId}/workbook/worksheets/${encodeURIComponent(sheetName)}/usedRange?$select=values,address,rowCount`),
      );
      if (status !== 200) return { ok: false, detail: `status ${status} — ${data?.error?.message || ""}` };
      return { ok: true, detail: `rows: ${data?.rowCount}, address: ${data?.address}` };
    });
  } else {
    skip("5b. List worksheets", "no .xlsx available");
    skip("5c. Read Excel range", "no .xlsx available");
  }

  // ── Phase 6: Batch Operations ───────────────────────────────────────────────
  console.log("\n── Phase 6: Batch API ──");

  await test("6a. Batch read (user + inbox + calendar)", async () => {
    const { status, data } = await graph("POST", "/$batch", {
      requests: [
        { id: "1", method: "GET", url: `/users/${encodeURIComponent(testUserEmail)}?$select=displayName` },
        { id: "2", method: "GET", url: `/users/${encodeURIComponent(testUserEmail)}/mailFolders/Inbox/messages?$top=1&$select=subject` },
        { id: "3", method: "GET", url: `/users/${encodeURIComponent(testUserEmail)}/events?$top=1&$select=subject` },
      ],
    });
    if (status !== 200) return { ok: false, detail: `batch status ${status}` };
    const responses = data?.responses || [];
    const statuses = responses.map((r: any) => `${r.id}:${r.status}`).join(", ");
    const allOk = responses.every((r: any) => r.status === 200);
    return { ok: allOk, detail: statuses };
  });

  // ── Phase 7: Cleanup ───────────────────────────────────────────────────────
  console.log("\n── Phase 7: Cleanup ──");

  // Clean up SharePoint test files
  if (spFileId) {
    await test("7a. Delete SharePoint test file", async () => {
      const { status } = await graph("DELETE", driveUrl(`items/${spFileId}`));
      return { ok: status === 204 || status === 200 };
    });
  }
  if (spFolderId) {
    await test("7b. Delete SharePoint test folder", async () => {
      const { status } = await graph("DELETE", driveUrl(`items/${spFolderId}`));
      return { ok: status === 204 || status === 200 };
    });
  }

  // Delete the shared mailbox user (the big cleanup)
  await test("7c. Delete shared mailbox user", async () => {
    await deleteAgentMailbox(TENANT, testUserId);
    return { ok: true, detail: `deleted ${testUserEmail}` };
  });

  // ── Summary ──────────────────────────────────────────────────────────────────
  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log(`║  PASSED: ${String(passed).padStart(2)}  |  FAILED: ${String(failed).padStart(2)}  |  SKIPPED: ${String(skipped).padStart(2)}  |  TOTAL: ${String(passed + failed + skipped).padStart(2)}     ║`);
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  if (failed > 0) {
    console.log("Failed tests may indicate:");
    console.log("  - OneDrive: Shared mailbox users don't always get OneDrive (expected)");
    console.log("  - Excel: Requires Business Standard+ license in buyer tenant");
    console.log("  - Email delivery: May take >5s to arrive (retry manually)");
    console.log("");
    process.exit(1);
  }
}

run().catch((err) => {
  console.error("\nFatal:", err);
  // Try cleanup even on fatal error
  if (testUserId) {
    console.log(`\nAttempting cleanup of ${testUserEmail}...`);
    deleteAgentMailbox(TENANT, testUserId)
      .then(() => console.log("Cleaned up."))
      .catch(() => console.log("Cleanup failed — manually delete via Azure Portal."))
      .finally(() => process.exit(1));
  } else {
    process.exit(1);
  }
});
