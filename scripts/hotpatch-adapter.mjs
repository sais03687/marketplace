/**
 * hotpatch-adapter.mjs
 *
 * Copies the latest templates/runtime/adapter.py into every live deployment's
 * container and restarts it. Use this after fixing a bug in adapter.py that
 * would otherwise require a full redeploy (and burn an AgentMail inbox).
 *
 * Usage:  node --env-file=.env scripts/hotpatch-adapter.mjs
 *
 * Behaviour:
 *   1. Query DB for all deployments with status in (ACTIVE, ONBOARDING)
 *      that have a containerName set.
 *   2. For each, `docker cp` the new adapter.py to /agent/adapter.py inside
 *      the container, then `docker restart` it.
 *   3. Hit /internal/health via the host-mapped port to confirm the container
 *      came back up cleanly.
 *   4. Print a summary: patched / failed / skipped.
 *
 * The container's entrypoint runs `python adapter.py`, and the path inside
 * the container is /agent/adapter.py (see apps/provisioning-service/src/templates/runtime/Dockerfile).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

const execFileP = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADAPTER_PATH = resolve(
  __dirname,
  "..",
  "apps",
  "provisioning-service",
  "src",
  "templates",
  "runtime",
  "adapter.py",
);

if (!existsSync(ADAPTER_PATH)) {
  console.error(`ERROR: adapter template not found at ${ADAPTER_PATH}`);
  process.exit(1);
}

// ── 1. Query running deployments ───────────────────────────────────────────

const prisma = new PrismaClient();

const deployments = await prisma.deployment.findMany({
  where: {
    status: { in: ["ACTIVE", "ONBOARDING"] },
    containerName: { not: null },
  },
  select: {
    id: true,
    containerName: true,
    agentId: true,
  },
});

await prisma.$disconnect();

console.log(`Found ${deployments.length} live deployments to patch\n`);

// ── 2. Helpers ─────────────────────────────────────────────────────────────

/** Extract the local docker container name from a containerName field.
 *  Some records store just the name, others store "http://localhost:PORT".
 *  Return null if we can't find a running container for it.
 */
async function resolveContainerName(deploymentId, containerName) {
  // Case A: field is already a container name
  if (!containerName.includes("://")) {
    return containerName;
  }
  // Case B: field is a URL — find the container that owns the host port.
  const url = new URL(containerName);
  const port = url.port;
  if (!port) return null;

  try {
    const { stdout } = await execFileP("docker", [
      "ps",
      "--filter",
      `publish=${port}`,
      "--format",
      "{{.Names}}",
    ]);
    const name = stdout.trim().split("\n")[0];
    return name || null;
  } catch (err) {
    console.error(`  [${deploymentId}] docker ps failed: ${err.message}`);
    return null;
  }
}

/** Determine the host-mapped port for the container's internal 4000/tcp. */
async function getHostPort(name) {
  try {
    const { stdout } = await execFileP("docker", ["port", name, "4000/tcp"]);
    const line = stdout.split("\n").find((l) => l.includes("0.0.0.0:"));
    if (!line) return null;
    return line.split(":").pop().trim();
  } catch {
    return null;
  }
}

async function healthCheck(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/internal/health`, {
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ── 3. Patch each container ────────────────────────────────────────────────

let patched = 0;
let failed = 0;
let skipped = 0;

for (const dep of deployments) {
  const label = dep.id.slice(0, 8);
  const name = await resolveContainerName(dep.id, dep.containerName);
  if (!name) {
    console.log(`  [${label}] skipped — no running container`);
    skipped++;
    continue;
  }

  try {
    // docker cp local_path container:/agent/adapter.py
    await execFileP("docker", ["cp", ADAPTER_PATH, `${name}:/agent/adapter.py`]);
    await execFileP("docker", ["restart", name]);

    const port = await getHostPort(name);
    if (!port) {
      console.log(`  [${label}] patched but host port not found`);
      patched++;
      continue;
    }

    // Wait up to 10s for the server to come back up
    let ok = false;
    for (let i = 0; i < 20; i++) {
      if (await healthCheck(port)) {
        ok = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    if (ok) {
      console.log(`  [${label}] patched ${name} (port ${port})`);
      patched++;
    } else {
      console.error(`  [${label}] patched ${name} but health check failed`);
      failed++;
    }
  } catch (err) {
    console.error(`  [${label}] FAILED: ${err.message}`);
    failed++;
  }
}

console.log(
  `\nDone. Patched: ${patched}, Failed: ${failed}, Skipped: ${skipped}`,
);
