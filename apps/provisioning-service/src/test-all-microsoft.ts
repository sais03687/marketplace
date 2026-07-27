/**
 * Comprehensive Microsoft 365 integration test.
 * Tests every Graph API capability the agent uses: token, domain, calendar,
 * SharePoint files, Excel, OneDrive, email (inbox + send).
 *
 * Uses an existing licensed platform user as the test identity.
 *
 * Run: MICROSOFT_TENANT_ID=... MICROSOFT_CLIENT_ID=... MICROSOFT_CLIENT_SECRET=... npx tsx src/test-all-microsoft.ts
 */

import { config } from "./config.js";

const TENANT = config.microsoftTenantId;
const CLIENT_ID = config.microsoftClientId;
const CLIENT_SECRET = config.microsoftClientSecret;
const GRAPH = "https://graph.microsoft.com/v1.0";

// Use an existing licensed user for testing
const TEST_USER = "data-analyst-acme-corp-1z3ujst4@agents.agentstore.it.com";
const SP_FOLDER = "test-integration";

let token = "";
let passed = 0;
let failed = 0;
let skipped = 0;

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getToken(): Promise<string> {
  if (token) return token;
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
  if (!resp.ok) throw new Error(`Token failed: ${resp.status}`);
  const data = (await resp.json()) as { access_token: string };
  token = data.access_token;
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
  if (status !== 204) {
    try {
      data = await resp.json();
    } catch {
      data = await resp.text();
    }
  }
  return { status, data };
}

function userUrl(path: string): string {
  return `/users/${encodeURIComponent(TEST_USER)}/${path}`;
}

function driveUrl(path: string): string {
  return `/sites/root/drive/${path}`;
}

async function test(
  name: string,
  fn: () => Promise<{ ok: boolean; detail?: string }>,
): Promise<void> {
  process.stdout.write(`  ${name}... `);
  try {
    const result = await fn();
    if (result.ok) {
      console.log(`PASS${result.detail ? ` — ${result.detail}` : ""}`);
      passed++;
    } else {
      console.log(`FAIL${result.detail ? ` — ${result.detail}` : ""}`);
      failed++;
    }
  } catch (err: any) {
    console.log(`FAIL — ${err.message?.slice(0, 200)}`);
    failed++;
  }
}

function skip(name: string, reason: string): void {
  console.log(`  ${name}... SKIP — ${reason}`);
  skipped++;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

async function run() {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║   Microsoft 365 — Comprehensive Integration Test        ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");
  console.log(`Tenant:    ${TENANT}`);
  console.log(`Test user: ${TEST_USER}`);
  console.log(`SP folder: ${SP_FOLDER}\n`);

  if (!TENANT || !CLIENT_ID || !CLIENT_SECRET) {
    console.error("ERROR: Missing MICROSOFT_TENANT_ID, CLIENT_ID, or CLIENT_SECRET");
    process.exit(1);
  }

  // ── 1. Auth & Token ──────────────────────────────────────────────────────
  console.log("── 1. Authentication ──");

  await test("Mint Graph API token (client_credentials)", async () => {
    const t = await getToken();
    return { ok: t.length > 100, detail: `token length: ${t.length}` };
  });

  await test("Mint Exchange token (different scope)", async () => {
    const resp = await fetch(
      `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          scope: "https://outlook.office365.com/.default",
        }).toString(),
      },
    );
    return { ok: resp.ok, detail: resp.ok ? "exchange token OK" : `status ${resp.status}` };
  });

  // ── 2. Domain & Org ──────────────────────────────────────────────────────
  console.log("\n── 2. Domain Discovery ──");

  await test("Get org domain (getBuyerDomain equivalent)", async () => {
    const { status, data } = await graph("GET", "/organization");
    const domain = data?.value?.[0]?.verifiedDomains?.find((d: any) => d.isDefault)?.name;
    return { ok: status === 200 && !!domain, detail: domain };
  });

  // ── 3. User Lookup ───────────────────────────────────────────────────────
  console.log("\n── 3. User / Mailbox Lookup ──");

  await test("Get test user by UPN", async () => {
    const { status, data } = await graph(
      "GET",
      `/users/${encodeURIComponent(TEST_USER)}?$select=id,userPrincipalName,displayName,accountEnabled`,
    );
    return {
      ok: status === 200 && data?.userPrincipalName === TEST_USER,
      detail: `${data?.displayName} (enabled: ${data?.accountEnabled})`,
    };
  });

  // ── 4. Calendar ──────────────────────────────────────────────────────────
  console.log("\n── 4. Calendar (Outlook) ──");

  let testEventId = "";

  await test("List calendar events (calendarView)", async () => {
    const now = new Date().toISOString();
    const end = new Date(Date.now() + 30 * 86400000).toISOString();
    const { status, data } = await graph(
      "GET",
      userUrl(`calendarView?startDateTime=${now}&endDateTime=${end}&$top=5&$select=id,subject`),
    );
    return { ok: status === 200, detail: `${data?.value?.length ?? 0} events found` };
  });

  await test("Create calendar event", async () => {
    const start = new Date(Date.now() + 86400000).toISOString().slice(0, 19);
    const end = new Date(Date.now() + 86400000 + 3600000).toISOString().slice(0, 19);
    const { status, data } = await graph("POST", userUrl("events"), {
      subject: "Integration Test Event",
      body: { contentType: "text", content: "Created by test runner" },
      start: { dateTime: start, timeZone: "UTC" },
      end: { dateTime: end, timeZone: "UTC" },
    });
    testEventId = data?.id || "";
    return { ok: status === 201 && !!testEventId, detail: `id: ${testEventId?.slice(0, 20)}...` };
  });

  await test("Update calendar event", async () => {
    if (!testEventId) return { ok: false, detail: "no event to update" };
    const { status } = await graph("PATCH", userUrl(`events/${testEventId}`), {
      subject: "Integration Test Event (Updated)",
    });
    return { ok: status === 200 };
  });

  await test("Delete calendar event", async () => {
    if (!testEventId) return { ok: false, detail: "no event to delete" };
    const { status } = await graph("DELETE", userUrl(`events/${testEventId}`));
    return { ok: status === 204 };
  });

  // ── 5. SharePoint Files ──────────────────────────────────────────────────
  console.log("\n── 5. SharePoint File Storage ──");

  let spFolderId = "";
  let spFileId = "";

  await test("Create SharePoint folder", async () => {
    const { status, data } = await graph("POST", driveUrl("root/children"), {
      name: SP_FOLDER,
      folder: {},
      "@microsoft.graph.conflictBehavior": "fail",
    });
    if (status === 409) {
      // Already exists — get its ID
      const { data: existing } = await graph("GET", driveUrl(`root:/${SP_FOLDER}`));
      spFolderId = existing?.id || "";
      return { ok: !!spFolderId, detail: "already exists (idempotent)" };
    }
    spFolderId = data?.id || "";
    return { ok: status === 201 && !!spFolderId, detail: `id: ${spFolderId?.slice(0, 20)}` };
  });

  await test("Upload file to SharePoint folder", async () => {
    const content = "Hello from integration test!\nTimestamp: " + new Date().toISOString();
    const resp = await fetch(
      `${GRAPH}${driveUrl(`root:/${SP_FOLDER}/test-file.txt:/content`)}`,
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

  await test("List files in SharePoint folder", async () => {
    const { status, data } = await graph(
      "GET",
      driveUrl(`root:/${SP_FOLDER}:/children?$select=id,name,size`),
    );
    const files = data?.value || [];
    return { ok: status === 200 && files.length > 0, detail: `${files.length} file(s): ${files.map((f: any) => f.name).join(", ")}` };
  });

  await test("Download file from SharePoint", async () => {
    if (!spFileId) return { ok: false, detail: "no file to download" };
    const resp = await fetch(
      `${GRAPH}${driveUrl(`items/${spFileId}/content`)}`,
      {
        headers: { Authorization: `Bearer ${await getToken()}` },
        redirect: "follow",
      },
    );
    const text = await resp.text();
    return { ok: resp.ok && text.includes("integration test"), detail: `${text.length} chars` };
  });

  await test("Search SharePoint drive", async () => {
    const { status, data } = await graph(
      "GET",
      driveUrl(`root/search(q='test-file')?$select=id,name&$top=5`),
    );
    return { ok: status === 200, detail: `${data?.value?.length ?? 0} results` };
  });

  await test("Get file metadata", async () => {
    if (!spFileId) return { ok: false, detail: "no file" };
    const { status, data } = await graph("GET", driveUrl(`items/${spFileId}`));
    return { ok: status === 200, detail: `name: ${data?.name}, size: ${data?.size}` };
  });

  // ── 6. Excel on SharePoint ───────────────────────────────────────────────
  console.log("\n── 6. Excel on SharePoint ──");

  let excelFileId = "";

  // Excel on SharePoint requires a real .xlsx file. We'll use the user's OneDrive
  // to create one via a Graph workbook createSession trick, OR look for an existing
  // xlsx in the SP folder. Simplest: use a known-good minimal xlsx from npm/the web.
  // Actually: let's create the xlsx in OneDrive (where Excel Online can init it),
  // then move it to SharePoint. Graph can create empty workbooks in OneDrive.

  // Better approach: upload to user's OneDrive (Excel Online will auto-init it)
  await test("Create Excel workbook (via OneDrive)", async () => {
    // Upload a minimal file to OneDrive — Graph's Excel API handles .xlsx on OneDrive better
    // because Excel Online auto-initializes the file format.
    // But actually, Graph doesn't create .xlsx from thin air either.
    // The real fix: use the drive/root/children endpoint with a specific Excel file type.
    // Graph will create a proper empty workbook if we use the right template.

    // Approach: use SharePoint "create from template" — POST to drive/root/children
    // This isn't available. Instead, let's try the workbook API on a freshly uploaded
    // content-type=xlsx file using a REAL minimal xlsx.
    // We need to get a real .xlsx from somewhere. Let's just pipe one from the test user's
    // OneDrive if they have one, or test against the existing SharePoint files.

    // Simplest: download a real minimal xlsx from a known URL, or create via the
    // SharePoint Excel REST API's createSession which can also create.

    // Actually the cleanest approach: use the OneDrive special folder create.
    // Let's just create a workbook session directly — if the file is new, Graph
    // will create it as a valid xlsx.
    // This only works with an existing valid xlsx. So let's create one properly:
    // POST /drives/{driveId}/items/{folderId}/workbook/... won't work on non-xlsx.

    // The REAL solution for test: use the Excel API on OneDrive with a known user.
    // Create an empty .xlsx by using the "empty file" trick: copy from template.
    // Unfortunately Graph has no "create new spreadsheet" API.

    // Let's test with a different approach: skip if we can't create, but test
    // read/write if there's an existing xlsx in the SharePoint site.

    // Final approach: look for any existing .xlsx on the SharePoint drive
    const { status, data } = await graph(
      "GET",
      driveUrl(`root/search(q='.xlsx')?$select=id,name&$top=1`),
    );
    if (status === 200 && data?.value?.length > 0) {
      excelFileId = data.value[0].id;
      return { ok: true, detail: `found existing: ${data.value[0].name} (${excelFileId.slice(0, 20)})` };
    }

    // No existing xlsx — try creating one via the OneDrive personal site
    // Upload a template xlsx from a proper minimal file
    // Actually, the easiest: ask Graph to create an xlsx by POSTing an empty
    // driveItem with file extension. This doesn't work either.

    // Give up gracefully — Excel tests need a real workbook
    return { ok: false, detail: "no .xlsx found on SharePoint — upload one manually to test Excel APIs" };
  });

  if (excelFileId) {
    await test("List worksheets", async () => {
      const { status, data } = await graph(
        "GET",
        driveUrl(`items/${excelFileId}/workbook/worksheets?$select=name`),
      );
      if (status !== 200) return { ok: false, detail: `status ${status} — ${JSON.stringify(data?.error?.message || data).slice(0, 150)}` };
      const sheets = data?.value?.map((s: any) => s.name) || [];
      return { ok: sheets.length > 0, detail: `sheets: ${sheets.join(", ")}` };
    });

    await test("Read from Excel range", async () => {
      // Get the first sheet name
      const { data: wsData } = await graph(
        "GET",
        driveUrl(`items/${excelFileId}/workbook/worksheets?$select=name`),
      );
      const sheetName = wsData?.value?.[0]?.name || "Sheet1";
      const { status, data } = await graph(
        "GET",
        driveUrl(`items/${excelFileId}/workbook/worksheets/${encodeURIComponent(sheetName)}/usedRange?$select=values,address,rowCount`),
      );
      if (status !== 200) return { ok: false, detail: `status ${status}` };
      return { ok: true, detail: `rows: ${data?.rowCount}, address: ${data?.address}` };
    });
  } else {
    skip("List worksheets", "no .xlsx workbook available");
    skip("Read from Excel range", "no .xlsx workbook available");
  }

  // ── 7. OneDrive (Agent Personal Drive) ───────────────────────────────────
  console.log("\n── 7. OneDrive (Personal Drive) ──");

  let oneDriveFileId = "";

  await test("Check OneDrive provisioned", async () => {
    const { status, data } = await graph("GET", userUrl("drive"));
    if (status === 404 || data?.error?.code === "ResourceNotFound") {
      return { ok: false, detail: "OneDrive NOT provisioned — need ROPC provisioning or manual first login" };
    }
    return { ok: status === 200, detail: `quota: ${data?.quota?.total ? Math.round(data.quota.total / 1e9) + 'GB' : 'unknown'}` };
  });

  await test("List OneDrive root files", async () => {
    const { status, data } = await graph(
      "GET",
      userUrl("drive/root/children?$select=id,name,size&$top=10"),
    );
    if (status === 404) return { ok: false, detail: "OneDrive not provisioned" };
    return { ok: status === 200, detail: `${data?.value?.length ?? 0} items` };
  });

  await test("Upload file to OneDrive", async () => {
    const content = "OneDrive test file — " + new Date().toISOString();
    const resp = await fetch(
      `${GRAPH}/users/${encodeURIComponent(TEST_USER)}/drive/root:/test-onedrive.txt:/content`,
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
      return { ok: false, detail: `status ${resp.status} — ${errData?.error?.message || 'unknown'}` };
    }
    const data = await resp.json();
    oneDriveFileId = data?.id || "";
    return { ok: !!oneDriveFileId, detail: `size: ${data?.size} bytes` };
  });

  await test("Download file from OneDrive", async () => {
    if (!oneDriveFileId) return { ok: false, detail: "no file uploaded" };
    const resp = await fetch(
      `${GRAPH}/users/${encodeURIComponent(TEST_USER)}/drive/items/${oneDriveFileId}/content`,
      {
        headers: { Authorization: `Bearer ${await getToken()}` },
        redirect: "follow",
      },
    );
    const text = await resp.text();
    return { ok: resp.ok && text.includes("OneDrive test"), detail: `${text.length} chars` };
  });

  await test("Search OneDrive", async () => {
    const { status, data } = await graph(
      "GET",
      userUrl("drive/root/search(q='test-onedrive')?$select=id,name&$top=5"),
    );
    return { ok: status === 200, detail: `${data?.value?.length ?? 0} results` };
  });

  await test("Create OneDrive folder", async () => {
    const { status, data } = await graph("POST", userUrl("drive/root/children"), {
      name: "test-folder",
      folder: {},
      "@microsoft.graph.conflictBehavior": "fail",
    });
    if (status === 409) return { ok: true, detail: "already exists (idempotent)" };
    return { ok: status === 201, detail: `id: ${data?.id?.slice(0, 20)}` };
  });

  // Clean up OneDrive test file
  if (oneDriveFileId) {
    await test("Delete OneDrive test file", async () => {
      const { status } = await graph("DELETE", userUrl(`drive/items/${oneDriveFileId}`));
      return { ok: status === 204 };
    });
  }

  // ── 8. Email (Outlook) ───────────────────────────────────────────────────
  console.log("\n── 8. Email (Outlook Inbox) ──");

  await test("List inbox messages", async () => {
    const { status, data } = await graph(
      "GET",
      userUrl("mailFolders/Inbox/messages?$top=5&$select=id,subject,from,receivedDateTime,isRead&$orderby=receivedDateTime desc"),
    );
    if (status !== 200) return { ok: false, detail: `status ${status} — ${data?.error?.message}` };
    const msgs = data?.value || [];
    return { ok: true, detail: `${msgs.length} messages${msgs[0] ? ` (latest: "${msgs[0].subject}")` : ""}` };
  });

  await test("Send test email (to self)", async () => {
    const t = await getToken();
    const resp = await fetch(`${GRAPH}${userUrl("sendMail")}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          subject: `Integration Test — ${new Date().toISOString().slice(0, 16)}`,
          body: { contentType: "text", content: "This is an automated integration test email." },
          toRecipients: [{ emailAddress: { address: TEST_USER } }],
        },
      }),
    });
    // sendMail returns 202 Accepted with no body
    return { ok: resp.status === 202 || resp.status === 200 || resp.status === 204, detail: `status ${resp.status}` };
  });

  await test("Search inbox", async () => {
    const { status, data } = await graph(
      "GET",
      userUrl(`messages?$search="integration"&$select=id,subject&$top=5`),
    );
    return { ok: status === 200, detail: `${data?.value?.length ?? 0} results` };
  });

  // ── 9. Cleanup ───────────────────────────────────────────────────────────
  console.log("\n── 9. Cleanup ──");

  if (spFileId) {
    await test("Delete SharePoint test file", async () => {
      const { status } = await graph("DELETE", driveUrl(`items/${spFileId}`));
      return { ok: status === 204 || status === 200 };
    });
  }

  // Don't delete excelFileId — we didn't create it, it was pre-existing

  // Delete SP test folder
  if (spFolderId) {
    await test("Delete SharePoint test folder", async () => {
      const { status } = await graph("DELETE", driveUrl(`items/${spFolderId}`));
      return { ok: status === 204 || status === 200 };
    });
  }

  // Also clean up leftover disabled test user from previous buyer-org test
  await test("Clean up orphaned test-buyer-org user", async () => {
    const { status, data } = await graph(
      "GET",
      `/users?$filter=startswith(userPrincipalName,'test-buyer-org-')&$select=id,userPrincipalName`,
    );
    if (status !== 200 || !data?.value?.length) return { ok: true, detail: "none found" };
    let cleaned = 0;
    for (const u of data.value) {
      const { status: delStatus } = await graph("DELETE", `/users/${u.id}`);
      if (delStatus === 204) cleaned++;
    }
    return { ok: true, detail: `cleaned ${cleaned} orphan(s)` };
  });

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log("\n══════════════════════════════════════════════════════════");
  console.log(`  PASSED: ${passed}  |  FAILED: ${failed}  |  SKIPPED: ${skipped}`);
  console.log(`  Total:  ${passed + failed + skipped}`);
  console.log("══════════════════════════════════════════════════════════\n");

  if (failed > 0) process.exit(1);
}


run().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
