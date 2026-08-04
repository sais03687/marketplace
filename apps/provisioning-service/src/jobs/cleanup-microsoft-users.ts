/**
 * Reconciliation sweep for agents that were fired but never cleaned up.
 *
 * Firing is meant to be handled immediately: the web app hands a deprovision job
 * to the queue, and falls back to POST /internal/deprovision over HTTPS if Redis
 * is unreachable. This job is the third line of defence, for when both of those
 * fail — it re-reads deployments that are FIRED or errored and finishes whatever
 * teardown is still outstanding.
 *
 * It is not decorative. Before 2026-08-01 nothing reaped containers here, only
 * M365 users, and the asymmetry was expensive: 15 agents fired in May and June
 * kept running for seven weeks — their licence seats had been reclaimed, but
 * their containers were still up, and `deprovision_complete` had never once been
 * logged for any of them.
 *
 * Cadence is hourly, deliberately not faster. Neon scales to zero after 5 minutes
 * idle and bills by wake-up rather than by query, so each poll costs ~5 minutes of
 * compute whatever it does. Hourly is ~60 compute-hours a month; every 15 minutes
 * would be ~240 and would blow the quota, which is exactly what exhausted it on
 * 2026-07-24. See commit 1e4bf9f.
 */

import { prisma } from "@marketplace/db";
import { deleteAgentIdentity } from "../clients/microsoft-workspace.js";
import { stopCustomAgent } from "./custom-runner.js";
import { docker, removeAgentVolume, removeOrphanedAgentVolumes } from "../clients/docker.js";

/** Containers belonging to a deployment, under both the current and legacy naming. */
async function orphanContainersFor(deploymentId: string): Promise<string[]> {
  const short = deploymentId.slice(0, 8);
  try {
    const all = await docker.listContainers({ all: true });
    return all
      .map((c) => (c.Names?.[0] || "").replace(/^\//, ""))
      // Current scheme is `custom-agent-<id>` / `mcp-<integration>-<id>`, but older
      // sidecars used `mcp-<id>-<integration>`, which the suffix match in
      // stopMcpSidecars never caught. Match the id anywhere in the name so the
      // legacy ones are reaped too.
      .filter((name) => name.includes(short) && /^(custom-agent-|mcp-|netgate-)/.test(name));
  } catch (err: any) {
    console.warn(`[cleanup] Could not list containers: ${err.message}`);
    return [];
  }
}

export async function cleanupMicrosoftUsersJob(): Promise<void> {
  const stale = await prisma.deployment.findMany({
    where: { status: { in: ["ERROR", "FIRED"] } },
    select: {
      id: true,
      workspaceUserId: true,
      workspaceEmail: true,
      workspaceProvider: true,
      buyerMicrosoftTenantId: true,
    },
  });

  // No early return on an empty list. Step 4 below is not driven by these rows, and
  // "no fired deployments in the table" is exactly the state that leaves orphaned
  // volumes behind — the row is gone, the data on disk is not.
  if (stale.length === 0) {
    console.log("[cleanup] No fired/errored deployments; checking for orphaned volumes");
  }

  let identitiesRemoved = 0;
  let containersRemoved = 0;
  let volumesRemoved = 0;

  for (const deployment of stale) {
    // 1. Microsoft identity — still holding a licence seat until this runs.
    if (deployment.workspaceProvider === "MICROSOFT" && deployment.workspaceUserId) {
      try {
        await deleteAgentIdentity(deployment.buyerMicrosoftTenantId ?? null, deployment.workspaceUserId);
        await prisma.deployment.update({
          where: { id: deployment.id },
          data: { workspaceUserId: null, workspaceEmail: null },
        });
        identitiesRemoved++;
        console.log(
          `[cleanup] Deleted orphaned M365 user ${deployment.workspaceEmail} and released its seat (deployment ${deployment.id})`,
        );
      } catch (err: any) {
        console.warn(`[cleanup] Failed to delete M365 user for deployment ${deployment.id}: ${err.message}`);
      }
    }

    // 2. Containers — a fired agent still running can read mail and act.
    const containers = await orphanContainersFor(deployment.id);
    if (containers.length > 0) {
      try {
        // Reuse the normal teardown so pollers, sidecars and the network go too.
        await stopCustomAgent(deployment.id);
        // Then sweep anything the deterministic names missed, e.g. legacy sidecars.
        for (const name of await orphanContainersFor(deployment.id)) {
          try {
            await docker.getContainer(name).remove({ force: true });
            console.log(`[cleanup] Removed leftover container ${name}`);
          } catch (err: any) {
            console.warn(`[cleanup] Could not remove ${name}: ${err.message}`);
          }
        }
        await prisma.deployment.update({
          where: { id: deployment.id },
          data: { containerName: null },
        });
        containersRemoved += containers.length;
        console.log(`[cleanup] Stopped orphaned containers for fired deployment ${deployment.id}`);
      } catch (err: any) {
        console.warn(`[cleanup] Failed to stop containers for ${deployment.id}: ${err.message}`);
      }
    }

    // 3. Data volume — outlives the container, so it is still here even for the
    // deployments whose containers a previous sweep already removed. That is the
    // whole backlog: 29 `custom-data-*` volumes on 2026-08-04, one per agent ever
    // fired, each holding that agent's checkpoints and files. This runs whether or
    // not there were containers above, which is why it is not inside that branch.
    try {
      if (await removeAgentVolume(deployment.id)) volumesRemoved++;
    } catch (err: any) {
      console.warn(`[cleanup] Volume cleanup failed for ${deployment.id}: ${err.message}`);
    }
  }

  // 4. Volumes belonging to deployments that no longer have a row at all. The loop
  // above is driven by the deployment table, so it cannot see these — and they are
  // the overwhelming majority. Protect anything not fired or errored, by short id,
  // as a second guard alongside Docker's own "no container references this".
  const inService = await prisma.deployment.findMany({
    where: { status: { notIn: ["ERROR", "FIRED"] } },
    select: { id: true },
  });
  volumesRemoved += await removeOrphanedAgentVolumes(
    new Set(inService.map((d) => d.id.slice(0, 8))),
  );

  if (identitiesRemoved || containersRemoved || volumesRemoved) {
    console.log(
      `[cleanup] Reconciled ${identitiesRemoved} Microsoft identity(ies), ` +
        `${containersRemoved} container(s) and ${volumesRemoved} volume(s)`,
    );
  } else {
    console.log(`[cleanup] Checked ${stale.length} fired/errored deployment(s) and all agent volumes; nothing outstanding`);
  }
}
