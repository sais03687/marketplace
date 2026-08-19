import { readdirSync, readFileSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "@marketplace/db";
import { config } from "../config.js";
import { getContainerPort, restartContainer } from "../clients/docker.js";
import { probeAgent, waitUntilIdle, waitUntilHealthy } from "./update-helpers.js";
import { customAgentContainerName } from "./custom-runner.js";
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
  //
  // The fallback used to read Deployment.containerName, which holds a URL -
  // "http://127.0.0.1:32797" on the live deployment. Dockerode builds a request
  // path out of whatever it is given, and that one re-parsed into a DNS lookup
  // for a host called "containers", which threw EAI_AGAIN and took the whole
  // provisioning service down with it, pollers included. Reached whenever the
  // in-memory registry is empty, which it is after every service restart.
  const { getCustomAgentPort } = await import("./custom-runner.js");
  const containerName = customAgentContainerName(deploymentId);
  const port = getCustomAgentPort(deploymentId) ?? (await getContainerPort(containerName));
  if (!port) throw new Error(`No running agent found for ${deploymentId}`);

  // ── What is running right now, before anything replaces it ──────────────────
  //
  // Not deployment.agentVersion: vet-decision sets that to the new version
  // before queueing this job, so by now the row describes an intention rather
  // than a fact. Only the agent knows what is on its disk, and a rollback has
  // to go back to that.
  const previousVersion = (await probeAgent(port)).ok
    ? await (async () => {
        try {
          const res = await fetch(`http://localhost:${port}/internal/health`);
          const body: any = await res.json();
          return typeof body.version === "string" ? body.version : null;
        } catch {
          return null;
        }
      })()
    : null;

  if (!previousVersion) {
    // Not fatal — a deployment provisioned before the agent recorded its
    // version has nothing to report yet. Worth saying, because it is the
    // difference between a recoverable bad release and an unrecoverable one.
    console.warn(`[update] ${deploymentId} does not report a running version — a failed update cannot be rolled back`);
  }

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

  // ── Restart, so the process imports what was just written ───────────────────
  //
  // Writing agent.py to disk changes nothing on its own: the module was
  // imported when the container started and the running process goes on using
  // the old code. Every update before this one was silent for exactly that
  // reason — files landed, the job logged success, and the agent carried on as
  // it was.
  // Nothing to load means nothing to restart for. An empty diff happens
  // whenever a version has no package in blob storage — the job logs it and
  // carries on — and restarting the agent to apply no change is pure cost to
  // the buyer, including a cancelled run.
  if (Object.keys(files).length === 0) {
    console.warn(`[update] No files for v${deployment.agentVersion} — skipping the restart`);
    await prisma.provisioningLog.create({
      data: {
        deploymentId,
        step: "update_complete",
        status: "succeeded",
        attempt: 1,
        message: `v${deployment.agentVersion}: no package files to apply, agent left running`,
      },
    });
    return;
  }

  // Wait for a moment when nobody is owed anything. A restart cancels whatever
  // is running; since 2026-08-18 the buyer is told their request was
  // interrupted rather than left waiting, so this is not a silent loss — but it
  // is still a request they have to send again, and it is usually avoidable by
  // waiting a minute.
  //
  // Bounded, and it proceeds anyway when the wait runs out: an agent that is
  // always busy would postpone its own update forever, and a stuck run would
  // postpone it permanently. Interrupting is a known cost; never updating is an
  // unbounded one.
  const quiet = await waitUntilIdle(port);
  console.log(
    quiet
      ? `[update] Agent idle — restarting ${containerName} for v${deployment.agentVersion}`
      : `[update] Agent still busy after waiting — restarting anyway for v${deployment.agentVersion}`,
  );

  await restartContainer(containerName);

  // ── Confirm it came back, and put the old version back if it did not ────────
  //
  // A restart that does not come up leaves the buyer with a dead agent under a
  // database claiming an updated one. Failing the job loudly is better than
  // that, but not as good as undoing it: the buyer's agent was working a minute
  // ago and there is no reason for them to carry the cost of a bad release.
  if (await waitUntilHealthy(port)) {
    await prisma.provisioningLog.create({
      data: {
        deploymentId,
        step: "update_complete",
        status: "succeeded",
        attempt: 1,
        message:
          `Updated to v${deployment.agentVersion} — ${Object.keys(files).length} file(s) pushed` +
          (quiet ? "" : " (restarted while busy)"),
      },
    });
    console.log(`[update] Deployment ${deploymentId} updated to v${deployment.agentVersion}`);
    return;
  }

  console.error(
    `[update] v${deployment.agentVersion} did not come up for ${deploymentId} — rolling back to v${previousVersion ?? "unknown"}`,
  );

  const rolledBack = previousVersion
    ? await pushVersion(deploymentId, deployment.agent.id, previousVersion, port, containerName)
    : false;

  await prisma.provisioningLog.create({
    data: {
      deploymentId,
      step: "update_rollback",
      status: rolledBack ? "succeeded" : "failed",
      attempt: 1,
      message: rolledBack
        ? `v${deployment.agentVersion} did not become healthy; restored v${previousVersion}`
        : `v${deployment.agentVersion} did not become healthy and could not be rolled back` +
          (previousVersion ? ` to v${previousVersion}` : " — the running version was unknown"),
    },
  });

  // The database was moved to the new version before this job ran. Put it back,
  // or it will claim a version the agent has never successfully run.
  if (rolledBack && previousVersion) {
    await prisma.deployment.update({
      where: { id: deploymentId },
      data: { agentVersion: previousVersion },
    });
  }

  throw new Error(
    `Agent did not come back after updating to v${deployment.agentVersion}` +
      (rolledBack ? ` — rolled back to v${previousVersion}` : " — ROLLBACK FAILED, agent is down"),
  );
}

/**
 * Put a specific version's files on a running agent and restart it.
 *
 * Used for rollback. Returns whether the agent came back healthy, rather than
 * throwing: the caller is already handling one failure and needs to record
 * what happened to the recovery, not be interrupted by it.
 */
async function pushVersion(
  deploymentId: string,
  agentId: string,
  version: string,
  port: number,
  containerName: string,
): Promise<boolean> {
  const target = await prisma.agentVersion.findFirst({
    where: { agentId, version },
    select: { storagePath: true },
  });
  if (!target?.storagePath || !isBlobStoragePath(target.storagePath)) {
    console.error(`[update] No package stored for v${version} — cannot roll back`);
    return false;
  }

  let dir: string | null = null;
  try {
    dir = await downloadBlobPackage(target.storagePath);
    const res = await fetch(`http://localhost:${port}/internal/update-skills`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-deployment-token": config.approvalWebhookToken,
      },
      body: JSON.stringify({ files: collectFiles(dir), version }),
    });
    if (!res.ok) {
      console.error(`[update] Rollback push failed: HTTP ${res.status}`);
      return false;
    }
  } catch (err: any) {
    console.error(`[update] Rollback push failed: ${err.message}`);
    return false;
  } finally {
    if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
  }

  await restartContainer(containerName);
  return waitUntilHealthy(port);
}
