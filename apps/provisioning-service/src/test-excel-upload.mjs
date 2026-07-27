// Upload a real openpyxl-generated xlsx and test the Excel API
const TENANT = process.env.MICROSOFT_TENANT_ID;
const CLIENT_ID = process.env.MICROSOFT_CLIENT_ID;
const CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET;
const GRAPH = "https://graph.microsoft.com/v1.0";

async function run() {
  const tokenResp = await fetch(
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
  const { access_token } = await tokenResp.json();

  // Delete old file if exists
  let r = await fetch(`${GRAPH}/sites/root/drive/root:/test-workbook.xlsx`, {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  if (r.ok) {
    const item = await r.json();
    await fetch(`${GRAPH}/sites/root/drive/items/${item.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${access_token}` },
    });
    console.log("Deleted old file");
    await new Promise((r) => setTimeout(r, 2000));
  }

  // openpyxl-generated xlsx (base64)
  const XLSX_B64 = "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";

  const xlsx = Buffer.from(XLSX_B64, "base64");
  console.log("xlsx size:", xlsx.length, "bytes");

  const upResp = await fetch(
    `${GRAPH}/sites/root/drive/root:/test-workbook.xlsx:/content`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${access_token}`,
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
      body: xlsx,
    },
  );
  const upData = await upResp.json();
  console.log("Upload:", upResp.status, upData.name, upData.size, "bytes");

  console.log("Waiting 10s for SharePoint processing...");
  await new Promise((r) => setTimeout(r, 10000));

  // Test workbook API on SharePoint
  const wsRespSP = await fetch(
    `${GRAPH}/sites/root/drive/items/${upData.id}/workbook/worksheets?$select=name`,
    { headers: { Authorization: `Bearer ${access_token}` } },
  );
  console.log("SharePoint worksheets status:", wsRespSP.status);
  if (!wsRespSP.ok) {
    const errSP = await wsRespSP.json();
    console.log("SharePoint Excel error:", errSP.error?.message);
  }

  // Try on user's OneDrive instead
  const USER = "data-analyst-acme-corp-1z3ujst4@agents.agentstore.it.com";
  console.log("\nTrying OneDrive instead...");
  const upOD = await fetch(
    `${GRAPH}/users/${encodeURIComponent(USER)}/drive/root:/test-excel-api.xlsx:/content`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${access_token}`,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
      body: xlsx,
    },
  );
  const odData = await upOD.json();
  console.log("OneDrive upload:", upOD.status, odData.id);

  console.log("Waiting 10s...");
  await new Promise((r) => setTimeout(r, 10000));

  const wsResp = await fetch(
    `${GRAPH}/users/${encodeURIComponent(USER)}/drive/items/${odData.id}/workbook/worksheets?$select=name`,
    { headers: { Authorization: `Bearer ${access_token}` } },
  );
  console.log("OneDrive worksheets status:", wsResp.status);
  if (wsResp.ok) {
    const wsData = await wsResp.json();
    const sheetName = wsData.value[0]?.name;
    console.log("Sheets:", wsData.value.map((s) => s.name));

    // Test write
    const writeResp = await fetch(
      `${GRAPH}/sites/root/drive/items/${upData.id}/workbook/worksheets/${encodeURIComponent(sheetName)}/range(address='A1:B2')`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          values: [
            ["Name", "Value"],
            ["Test", 42],
          ],
        }),
      },
    );
    console.log("Write:", writeResp.status);

    // Test read
    const readResp = await fetch(
      `${GRAPH}/sites/root/drive/items/${upData.id}/workbook/worksheets/${encodeURIComponent(sheetName)}/usedRange?$select=values,address,rowCount`,
      { headers: { Authorization: `Bearer ${access_token}` } },
    );
    console.log("Read:", readResp.status);
    if (readResp.ok) {
      const readData = await readResp.json();
      console.log("Data:", JSON.stringify(readData.values));
      console.log("Rows:", readData.rowCount, "Address:", readData.address);
    } else {
      const err = await readResp.json();
      console.log("Read error:", err.error?.message);
    }
  } else {
    const err = await wsResp.json();
    console.log("Error:", err.error?.message);
  }
}
run().catch(console.error);
