#!/usr/bin/env node
// Build the OpenClaw agent-runner Docker image.
//
// The Dockerfile at apps/provisioning-service/src/docker/agent-runner/Dockerfile
// expects an `agent-package/` directory in its build context. We keep the
// canonical package at agents/v5-agent-package/, so this script copies it
// into the build context, runs `docker build`, then removes the copy.
//
// Tag: marketplace/agent-runner:latest (matches OPENCLAW_IMAGE default in
// apps/provisioning-service/src/config.ts).
//
// Usage:
//   node scripts/build-agent-runner.mjs
//
// After this runs, any new OpenClaw deployment will use the rebuilt image.
// Existing containers must be stopped + restarted to pick up the new image.

import { execSync } from "node:child_process";
import { cpSync, rmSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");

const SOURCE = resolve(REPO_ROOT, "agents", "v5-agent-package");
const BUILD_CTX = resolve(
  REPO_ROOT,
  "apps",
  "provisioning-service",
  "src",
  "docker",
  "agent-runner",
);
const DEST = resolve(BUILD_CTX, "agent-package");
const IMAGE_TAG = "marketplace/agent-runner:latest";

function log(msg) {
  console.log(`[build-agent-runner] ${msg}`);
}

if (!existsSync(SOURCE)) {
  console.error(`[build-agent-runner] ERROR: source not found: ${SOURCE}`);
  process.exit(1);
}

// 1. Stage the package into the build context.
if (existsSync(DEST)) {
  log(`removing stale ${DEST}`);
  rmSync(DEST, { recursive: true, force: true });
}
log(`copying ${SOURCE} -> ${DEST}`);
cpSync(SOURCE, DEST, { recursive: true });

// 2. Run docker build.
try {
  log(`docker build -t ${IMAGE_TAG} ${BUILD_CTX}`);
  execSync(`docker build -t ${IMAGE_TAG} "${BUILD_CTX}"`, {
    stdio: "inherit",
  });
  log(`built ${IMAGE_TAG}`);
} catch (err) {
  console.error(`[build-agent-runner] docker build failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  // 3. Clean up the staged copy so git doesn't see it.
  if (existsSync(DEST)) {
    log(`cleaning up ${DEST}`);
    rmSync(DEST, { recursive: true, force: true });
  }
}
