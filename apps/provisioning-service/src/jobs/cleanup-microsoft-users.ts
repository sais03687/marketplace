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
import { docker } from "../clients/docker.js";

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

  if (stale.length === 0) {
    console.log("[cleanup] Nothing to reconcile");
    return;
  }

  let identitiesRemoved = 0;
  let containersRemoved = 0;

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
    if (containers.length === 0) continue;
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

  if (identitiesRemoved || containersRemoved) {
    console.log(
      `[cleanup] Reconciled ${identitiesRemoved} Microsoft identity(ies) and ${containersRemoved} container(s)`,
    );
  } else {
    console.log(`[cleanup] Checked ${stale.length} fired/errored deployment(s); nothing outstanding`);
  }
}
