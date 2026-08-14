/**
 * MCP Sidecar Manager — spawns and stops MCP server containers alongside agent containers.
 *
 * Each agent deployment can declare `requiredIntegrations` in its manifest.
 * For each integration, this module spawns a Docker sidecar container on the
 * same isolated network as the agent. The agent connects to sidecars via
 * internal Docker DNS (e.g., http://mcp-python-abc12345:8080).
 *
 * Supported integrations:
 *   - "python-sandbox" → mcp-python-sandbox image (code exec + doc parsing)
 */

import Dockerode from "dockerode";
import { config } from "../config.js";

const docker = new Dockerode();

/** Map of integration type → Docker image name */
const INTEGRATION_IMAGES: Record<string, string> = {
  "python-sandbox": "mcp-python-sandbox:latest",
};

/** Map of integration type → container port */
const INTEGRATION_PORTS: Record<string, number> = {
  "python-sandbox": 8080,
};

/** Resource limits per sidecar type */
const SIDECAR_LIMITS: Record<string, { memory: number; cpus: number; pids: number }> = {
  // 768 MB, raised from 256 on 2026-08-13. A 20 MB CSV measured at 82 MB as a
  // DataFrame and 105 MB peak RSS, so a 23.58 MB file fits in 256 MB for a read
  // and a groupby and nothing beyond it — DABstep joins that file against others.
  // Host has ~2.5 GB free; the agent container next to this one has 512 MB.
  "python-sandbox": { memory: 768 * 1024 * 1024, cpus: 1_000_000_000, pids: 128 },
};

const DEFAULT_LIMITS = { memory: 256 * 1024 * 1024, cpus: 1_000_000_000, pids: 128 };

export interface McpSidecarInfo {
  type: string;
  containerName: string;
  internalUrl: string;
}

/**
 * Spawn MCP sidecar containers for the given integrations.
 *
 * @param deploymentId - The deployment ID (used for naming)
 * @param networkName - Docker network to attach sidecars to
 * @param integrations - List of integration types (e.g., ["python-sandbox"])
 * @returns Map of integration type → internal URL
 */
export async function spawnMcpSidecars(
  deploymentId: string,
  networkName: string,
  integrations: string[],
): Promise<Map<string, McpSidecarInfo>> {
  const results = new Map<string, McpSidecarInfo>();
  const depShort = deploymentId.slice(0, 8);

  for (const integration of integrations) {
    const image = INTEGRATION_IMAGES[integration];
    if (!image) {
      console.warn(`[mcp-sidecar] Unknown integration type: ${integration} — skipping`);
      continue;
    }

    const containerName = `mcp-${integration.replace(/[^a-z0-9-]/g, "")}-${depShort}`;
    const port = INTEGRATION_PORTS[integration] || 8080;
    const limits = SIDECAR_LIMITS[integration] || DEFAULT_LIMITS;

    // Reconcile whatever is already there before creating.
    //
    // Container names are fixed per deployment, so a re-provision always collides
    // with the previous run. Docker answered 409, and the catch below then removed
    // the *existing, working* sidecar without recreating it — so re-provisioning an
    // agent destroyed the capability it was re-provisioning. That is how this
    // deployment lost its python-sandbox: started once, and taken away by the
    // second provision that was supposed to restore it.
    let adopted = false;
    try {
      const existing = docker.getContainer(containerName);
      const info = await existing.inspect();
      const onRightNetwork = Boolean(
        info.NetworkSettings?.Networks && networkName in info.NetworkSettings.Networks,
      );
      if (info.State?.Running && onRightNetwork) {
        console.log(`[mcp-sidecar] Reusing running ${containerName} on ${networkName}`);
        results.set(integration, {
          type: integration,
          containerName,
          internalUrl: `http://${containerName}:${port}`,
        });
        adopted = true;
      } else {
        console.log(
          `[mcp-sidecar] Replacing ${containerName} ` +
            `(running=${Boolean(info.State?.Running)}, onNetwork=${onRightNetwork})`,
        );
        await existing.remove({ force: true });
      }
    } catch {
      // No container by that name — the ordinary first-provision case.
    }
    if (adopted) continue;

    let created = false;
    try {
      const container = await docker.createContainer({
        Image: image,
        name: containerName,
        ExposedPorts: { [`${port}/tcp`]: {} },
        HostConfig: {
          Memory: limits.memory,
          MemorySwap: limits.memory, // no swap
          NanoCpus: limits.cpus,
          PidsLimit: limits.pids,
          SecurityOpt: ["no-new-privileges"],
          CapDrop: ["ALL"],
          ReadonlyRootfs: false, // python sandbox needs writable /tmp
          Tmpfs: {
            // 128 MB, raised from 64. This is where inbound files are staged and
            // outputs written, and it is a tmpfs — every byte here is RAM out of
            // the limit above, which is why it is not larger.
            "/tmp": "rw,noexec,nosuid,size=128m",
          },
          // No port bindings — only reachable via internal Docker network
          NetworkMode: networkName,
        },
      });

      created = true;
      await container.start();

      // Wait briefly for the sidecar to start
      await new Promise((r) => setTimeout(r, 2000));

      // Verify health
      try {
        const healthUrl = `http://${containerName}:${port}/health`;
        // Health check will be done by the agent adapter at startup
        console.log(`[mcp-sidecar] Started ${containerName} (${integration}) on ${networkName}`);
      } catch {
        // Non-fatal: adapter will retry
      }

      const info: McpSidecarInfo = {
        type: integration,
        containerName,
        internalUrl: `http://${containerName}:${port}`,
      };
      results.set(integration, info);
    } catch (err: any) {
      console.error(`[mcp-sidecar] Failed to spawn ${containerName}: ${err.message}`);
      // Only tidy up what this attempt made. Removing by name regardless is what
      // turned a name collision into the loss of a working sidecar.
      if (created) {
        try {
          const partial = docker.getContainer(containerName);
          await partial.stop({ t: 5 }).catch(() => {});
          await partial.remove({ force: true }).catch(() => {});
        } catch {
          // ignore
        }
      }
    }
  }

  return results;
}

/**
 * Stop and remove all MCP sidecar containers for a deployment.
 */
export async function stopMcpSidecars(deploymentId: string): Promise<void> {
  const depShort = deploymentId.slice(0, 8);
  const prefix = `mcp-`;
  const suffix = `-${depShort}`;

  try {
    const containers = await docker.listContainers({ all: true });
    for (const info of containers) {
      const name = (info.Names?.[0] || "").replace(/^\//, "");
      if (name.startsWith(prefix) && name.endsWith(suffix)) {
        try {
          const container = docker.getContainer(name);
          await container.stop({ t: 5 }).catch(() => {});
          await container.remove({ force: true });
          console.log(`[mcp-sidecar] Removed ${name}`);
        } catch (err: any) {
          console.warn(`[mcp-sidecar] Failed to remove ${name}: ${err.message}`);
        }
      }
    }
  } catch (err: any) {
    console.warn(`[mcp-sidecar] Error listing containers for cleanup: ${err.message}`);
  }
}
