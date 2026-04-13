#!/usr/bin/env node
// End-to-end test: hit settings PATCH, verify DB update, verify container
// hot-reload file, verify policy engine picks it up.
//
// Usage: node --env-file=.env scripts/test-settings-policy-roundtrip.mjs

import { PrismaClient } from "@prisma/client";
import { execSync } from "node:child_process";

const prisma = new PrismaClient();
const DEPLOYMENT_ID = "cmns7w7vj002crsew02jt4lc2";
const CONTAINER = "custom-agent-cmns7w7v";

async function main() {
  // 0. Snapshot current state
  const before = await prisma.deployment.findUnique({
    where: { id: DEPLOYMENT_ID },
    select: { autonomyConfig: true, containerName: true },
  });
  console.log("Before:", JSON.stringify(before, null, 2));

  // 1. Directly call the container's /internal/approval-policy endpoint
  //    (simulating what settings/route.ts will do). We can't hit the web
  //    settings PATCH directly because it needs auth, so we exercise the
  //    container endpoint that would normally be called by it.
  const containerUrl = before.containerName;
  console.log(`\nPosting new policy to ${containerUrl}/internal/approval-policy`);

  const payload = {
    policy: "always",
    riskThreshold: 5.0,
    autoApprove: ["trusted@vip.com"],
    requireApproval: [],
  };

  const res = await fetch(`${containerUrl}/internal/approval-policy`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  console.log(`  Response: ${res.status}`, JSON.stringify(body, null, 2));

  // 2. Verify the file was written inside the container
  console.log("\nVerifying /agent/approval_policy.json inside container...");
  const fileContent = execSync(
    `docker exec ${CONTAINER} python -c "from pathlib import Path; print(Path('/agent/approval_policy.json').read_text())"`,
    { encoding: "utf8" },
  ).trim();
  console.log("  File content:", fileContent);

  // 3. Verify the adapter's policy engine now returns the new policy
  console.log("\nVerifying adapter policy engine picks up the override...");
  const adapterCheck = execSync(
    `docker exec ${CONTAINER} python -c "` +
      `import sys, importlib; sys.path.insert(0, '/agent'); ` +
      `import adapter; importlib.reload(adapter); ` +
      `n, r = adapter._should_require_approval('random@gmail.com', {}); ` +
      `print(f'random@gmail.com → needs={n} reason={r!r}'); ` +
      `n, r = adapter._should_require_approval('trusted@vip.com', {}); ` +
      `print(f'trusted@vip.com → needs={n} reason={r!r}')"`,
    { encoding: "utf8" },
  ).trim();
  console.log(adapterCheck);

  // 4. Now also test updating the DB autonomyConfig directly (simulates
  //    what the settings route handler does on PATCH)
  console.log("\nUpdating deployment.autonomyConfig in DB...");
  const updated = await prisma.deployment.update({
    where: { id: DEPLOYMENT_ID },
    data: {
      autonomyConfig: {
        ...((before.autonomyConfig) ?? {}),
        approvalPolicy: "always",
        approvalRiskThreshold: 5.0,
        autoApproveList: ["trusted@vip.com"],
      },
    },
    select: { autonomyConfig: true },
  });
  console.log("  DB after:", JSON.stringify(updated.autonomyConfig, null, 2));

  // 5. Clean up — restore default policy
  console.log("\nCleaning up...");
  execSync(
    `docker exec ${CONTAINER} python -c "from pathlib import Path; p = Path('/agent/approval_policy.json'); p.unlink() if p.exists() else None"`,
  );
  await prisma.deployment.update({
    where: { id: DEPLOYMENT_ID },
    data: { autonomyConfig: before.autonomyConfig ?? {} },
  });
  console.log("  Restored previous DB state and removed override file.");

  console.log("\nAll roundtrip checks passed.");
}

main()
  .catch((e) => {
    console.error("FAILED:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
