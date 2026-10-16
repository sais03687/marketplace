import { statfs } from "node:fs/promises";

/**
 * Public health check, for an outside uptime monitor.
 *
 * /health sits behind the service secret and answers "ok" without looking at
 * anything, so it can tell a monitor only that the process is up. This one
 * checks the things whose failure a buyer would otherwise discover first: the
 * database, the job queue, free disk (every hire adds an image and fired ones
 * are not pruned), agents that have stopped checking in, and active agents
 * with no mail reader.
 *
 * It is unauthenticated, so the answer is deliberately thin: "ok", or "down"
 * with the *names* of the failing checks. No counts, ids, hostnames or error
 * text — those go to the server log, where only the operator reads them.
 * Results are cached so a flood of requests costs one database query per
 * CACHE_MS, not one each.
 */

export type CheckName = "database" | "queue" | "disk" | "agents" | "mail";

export interface HealthProbes {
  database: () => Promise<void>;
  queue: () => Promise<void>;
  /** Fraction of the disk in use, 0..1. */
  diskUsed: () => Promise<number>;
  /** How many ACTIVE agents have not checked in within the stale window. */
  staleAgents: () => Promise<number>;
  /** How many ACTIVE agents with a mailbox have no running mail reader. */
  agentsWithoutPoller: () => Promise<number>;
}

export interface HealthResult {
  status: "ok" | "down";
  failing: CheckName[];
}

export const DISK_LIMIT = 0.85;
const CHECK_TIMEOUT_MS = 3_000;
const CACHE_MS = 15_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export async function runHealthChecks(probes: HealthProbes, timeoutMs = CHECK_TIMEOUT_MS): Promise<HealthResult> {
  const checks: Record<CheckName, () => Promise<string | null>> = {
    // Each returns null when healthy, or the operator-facing reason.
    database: async () => (await probes.database(), null),
    queue: async () => (await probes.queue(), null),
    disk: async () => {
      const used = await probes.diskUsed();
      return used >= DISK_LIMIT ? `disk ${Math.round(used * 100)}% used` : null;
    },
    agents: async () => {
      const n = await probes.staleAgents();
      return n > 0 ? `${n} active agent(s) have stopped checking in` : null;
    },
    mail: async () => {
      const n = await probes.agentsWithoutPoller();
      return n > 0 ? `${n} active agent(s) have no mail reader running` : null;
    },
  };

  const names = Object.keys(checks) as CheckName[];
  const outcomes = await Promise.all(
    names.map(async (name) => {
      try {
        return await withTimeout(checks[name](), timeoutMs);
      } catch (err: any) {
        return `${name} check failed: ${err?.message ?? err}`;
      }
    }),
  );

  const failing: CheckName[] = [];
  outcomes.forEach((reason, i) => {
    if (reason !== null) {
      failing.push(names[i]);
      console.warn(`[healthz] ${names[i]}: ${reason}`);
    }
  });
  return { status: failing.length ? "down" : "ok", failing };
}

/** One check at a time, and a recent answer reused. */
export function cachedHealth(probes: HealthProbes, cacheMs = CACHE_MS): () => Promise<HealthResult> {
  let last: { at: number; result: HealthResult } | null = null;
  let inFlight: Promise<HealthResult> | null = null;
  return async () => {
    if (last && Date.now() - last.at < cacheMs) return last.result;
    if (!inFlight) {
      inFlight = runHealthChecks(probes)
        .then((result) => {
          last = { at: Date.now(), result };
          return result;
        })
        .finally(() => {
          inFlight = null;
        });
    }
    return inFlight;
  };
}

/**
 * Whether a request is for the public health check.
 *
 * HEAD as well as GET: UptimeRobot checks with HEAD, and anything this did not
 * match fell through to the secret check and came back 401 — "down" to the
 * monitor while a browser saw "ok". The query string is ignored because some
 * monitors append one to defeat caches.
 */
export function isHealthzRequest(method: string | undefined, url: string | undefined): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  return (url ?? "").split("?")[0] === "/healthz";
}

export async function diskUsedFraction(path = "/"): Promise<number> {
  const s = await statfs(path);
  // bavail, not bfree: blocks reserved for root are not space we can use.
  const total = s.blocks;
  const free = s.bavail;
  return total > 0 ? 1 - free / total : 0;
}
