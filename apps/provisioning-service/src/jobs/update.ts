import { readdirSync, readFileSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "@marketplace/db";
import { config } from "../config.js";
import { getContainerPort } from "../clients/docker.js";
import { isBlobStoragePath, downloadBlobPackage } from "../utils/blob-download.js";

function collectFiles(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  function walk(d: string, prefix: string) {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      const rel = prefix ? `${prefix}/${entry}` : entry;
      if (statSync(full).isDirectory()) {
        walk(full, rel);
      } else {
        files[rel] = readFileSync(full).toString("base64");
      }
    }
  }
  walk(dir, "");
  return files;
}

export async function updateJob(deploymentId: string): Promise<void> {
  const deployment = await prisma.deployment.findUnique({
    where: { id: deploymentId },
    include: { agent: { select: { id: true, runtime: true, slug: true } } },
  });

  if (!deployment) {
    throw new Error(`Deployment ${deploymentId} not found`);
  }
  if (deployment.status !== "ACTIVE" && deployment.status !== "ONBOARDING") {
    throw new Error(
      `Deployment ${deploymentId} is in ${deployment.status}, expected ACTIVE or ONBOARDING`,
    );
  }

  console.log(`[update] Starting update for deployment ${deploymentId} → v${deployment.agentVersion}`);

  // ── Resolve port ────────────────────────────────────────────────────────────
  const { getCustomAgentPort } = await import("./custom-runner.js");
  const port = getCustomAgentPort(deploymentId)
    ?? (deployment.containerName ? await getContainerPort(deployment.containerName) : undefined);
  if (!port) throw new Error(`No running agent found for ${deploymentId}`);

  // ── Fetch the package files for the new version ─────────────────────────────
  let files: Record<string, string> = {};
  let tmpDir: string | null = null;

  const agentVersion = await prisma.agentVersion.findFirst({
    where: {
      agentId: deployment.agent.id,
      version: deployment.agentVersion,
    },
    select: { storagePath: true },
  });

  if (agentVersion?.storagePath && isBlobStoragePath(agentVersion.storagePath)) {
    try {
      tmpDir = await downloadBlobPackage(agentVersion.storagePath);
      files = collectFiles(tmpDir);
      console.log(`[update] Loaded ${Object.keys(files).length} files from blob (v${deployment.agentVersion})`);
    } catch (err: any) {
      console.warn(`[update] Could not download package files: ${err.message} — sending empty diff`);
    }
  } else {
    console.warn(`[update] No blob storagePath for v${deployment.agentVersion} — sending empty diff`);
  }

  // ── Push files to running agent ─────────────────────────────────────────────
  const res = await fetch(`http://localhost:${port}/internal/update-skills`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-deployment-token": config.approvalWebhookToken,
    },
    body: JSON.stringify({ files, version: deployment.agentVersion }),
  });

  if (!res.ok) {
    throw new Error(`Update failed: HTTP ${res.status}`);
  }

  // ── Cleanup temp dir ────────────────────────────────────────────────────────
  if (tmpDir) {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }

  await prisma.provisioningLog.create({
    data: {
      deploymentId,
      step: "update_complete",
      status: "succeeded",
      attempt: 1,
      message: `Updated to v${deployment.agentVersion} — ${Object.keys(files).length} file(s) pushed`,
    },
  });

  console.log(`[update] Deployment ${deploymentId} updated to v${deployment.agentVersion}`);
}
