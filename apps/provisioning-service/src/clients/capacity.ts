import { RESOURCE_TIERS, type ResourceTier } from "@marketplace/agent-package-schema";
import { docker } from "./docker.js";

/**
 * Container limits for a compute tier, and whether the host has room for one.
 *
 * Standard agents keep the limits they have always had and are not checked:
 * the host already runs them, and adding a check now would start refusing hires
 * that work today. A larger tier is checked before it starts, because one agent
 * reserving gigabytes on a host this size could starve every other agent of
 * memory — the kernel would kill them, not it.
 */
export function limitsFor(tier: ResourceTier): { memoryBytes: number; nanoCpus: number } {
  const base = RESOURCE_TIERS[tier] ?? RESOURCE_TIERS.standard;
  let memoryMb: number = base.memoryMb;
  let cpus: number = base.cpus;
  if (tier === "large") {
    const m = Number(process.env.RESOURCE_LARGE_MEMORY_MB);
    const c = Number(process.env.RESOURCE_LARGE_CPUS);
    if (Number.isFinite(m) && m >= 512) memoryMb = m;
    if (Number.isFinite(c) && c >= 1) cpus = c;
  }
  return { memoryBytes: memoryMb * 1024 * 1024, nanoCpus: Math.round(cpus * 1e9) };
}

export class CapacityError extends Error {}

/**
 * Throw unless the host can reserve `memoryBytes` more for a container.
 *
 * Counts what running containers have reserved (their memory limits), not
 * what they happen to be using this second: a limit is a promise the host has
 * to be able to keep. HOST_RESERVED_MB is kept back for the system, the
 * platform services and builds.
 */
export async function assertCapacity(memoryBytes: number, label: string): Promise<void> {
  const info = await docker.info();
  const total: number = info.MemTotal ?? 0;
  const reservedForHost = (Number(process.env.HOST_RESERVED_MB) || 1536) * 1024 * 1024;

  let committed = 0;
  for (const c of await docker.listContainers()) {
    try {
      const detail = await docker.getContainer(c.Id).inspect();
      committed += detail.HostConfig?.Memory || 0;
    } catch {
      /* a container that vanished mid-count holds nothing */
    }
  }

  const available = total - reservedForHost - committed;
  if (memoryBytes > available) {
    const gb = (n: number) => (n / 1024 ** 3).toFixed(1);
    throw new CapacityError(
      `Not enough capacity to start ${label}: it needs ${gb(memoryBytes)} GB and ` +
        `${gb(Math.max(available, 0))} GB is free on the host. It can start once the host is larger ` +
        `or other agents stop.`,
    );
  }
}
