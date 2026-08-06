/**
 * Centralized mail poller process manager.
 *
 * Agent containers register their pollers here so that:
 *   - deprovision can reliably kill the right poller
 *   - startup recovery can re-spawn pollers for Docker containers that survived a
 *     service restart
 */

import { spawn, type ChildProcess } from "node:child_process";
import { hooksTokenFor } from "../utils/agent-token.js";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Deployment ID → poller child process
const pollers = new Map<string, ChildProcess>();

function resolvePollerScript(name: string = "outlook-poller.mjs"): string {
  const localPath = join(__dirname, name);
  if (existsSync(localPath)) return localPath;
  const srcPath = join(__dirname, "..", "..", "src", "jobs", name);
  if (existsSync(srcPath)) return srcPath;
  throw new Error(
    `Cannot find ${name} (checked ${localPath} and ${srcPath})`,
  );
}

interface PollerProcess {
  pid: number;
  deploymentId: string;
  /** Milliseconds since the process started, from the /proc entry's mtime. */
  ageMs: number;
}

/** Every poller process on this host, whichever deployment it serves. */
function scanPollerProcesses(): PollerProcess[] {
  if (!existsSync("/proc")) return [];

  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return [];
  }

  const now = Date.now();
  const found: PollerProcess[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;
    try {
      // cmdline first: it is the cheap check and rules out almost everything.
      if (!readFileSync(`/proc/${entry}/cmdline`, "utf8").includes("outlook-poller.mjs")) {
        continue;
      }
      const environ = readFileSync(`/proc/${entry}/environ`, "utf8").split("\0");
      const idEntry = environ.find((e) => e.startsWith("DEPLOYMENT_ID="));
      if (!idEntry) continue;
      found.push({
        pid,
        deploymentId: idEntry.slice("DEPLOYMENT_ID=".length),
        ageMs: now - statSync(`/proc/${entry}`).mtimeMs,
      });
    } catch {
      // Process exited between readdir and read, or isn't ours to inspect.
    }
  }
  return found;
}

/**
 * Every live poller process for a deployment, found by asking the OS rather than
 * by consulting `pollers`.
 *
 * The in-memory map is not a reliable inventory. A poller that outlives the map
 * entry pointing at it — see the identity check in the `exit` handler below for
 * how that used to happen — becomes untracked, and an untracked poller cannot be
 * stopped, only discovered. It keeps polling the mailbox forever alongside its
 * replacement, and because each poller keeps its own in-memory set of handled
 * message ids, both forward the same unread mail to the agent. That is what
 * produced 18 approvals, and 18 buyer notification emails, from a handful of
 * messages on 2026-08-03.
 *
 * Linux-only, by design: it reads /proc. On a developer machine there is no /proc
 * and this returns nothing, which is correct — pollers only run on the VPS.
 */
function findPollerPids(deploymentId: string): number[] {
  // Exact match on the id, so deployment "abc" cannot match a poller for "abcdef".
  return scanPollerProcesses()
    .filter((p) => p.deploymentId === deploymentId)
    .map((p) => p.pid);
}

/** Grace period before a poller is eligible to be swept, covering the gap
 *  between spawn() and the registration that follows it. */
const SWEEP_GRACE_MS = 60_000;

/**
 * Kill poller processes this service does not own.
 *
 * The reaper in stopPoller only runs when a deployment is provisioned or paused,
 * so a stray appearing at any other moment survives until the next such event —
 * possibly never. One appeared on 2026-08-04 eight minutes after the service
 * started, so startup recovery had already been and gone, and it sat there
 * duplicating every delivery: two pollers on one mailbox each keep their own set
 * of handled message ids, so the buyer gets two approvals and two notifications
 * per email. That is the failure this exists to prevent.
 *
 * Authority is the in-memory registry: a process is legitimate only if it is the
 * exact child currently registered for its deployment. Anything else is an orphan
 * from a restart or a one-off script, and nothing else will ever clean it up.
 */
export function sweepStrayPollers(): void {
  const strays = scanPollerProcesses().filter((p) => {
    if (p.ageMs < SWEEP_GRACE_MS) return false; // too young to judge
    return pollers.get(p.deploymentId)?.pid !== p.pid;
  });

  for (const stray of strays) {
    try {
      process.kill(stray.pid, "SIGKILL");
      console.log(
        `[poller-manager] Swept stray poller pid ${stray.pid} for ` +
          `${stray.deploymentId.slice(0, 8)} (age ${Math.round(stray.ageMs / 1000)}s)`,
      );
    } catch {
      // Already gone.
    }
  }
}

let sweepTimer: NodeJS.Timeout | null = null;

/** Start the periodic sweep. Idempotent. */
export function startStrayPollerSweep(intervalMs = 120_000): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    try {
      sweepStrayPollers();
    } catch (err: any) {
      console.warn(`[poller-manager] Sweep failed: ${err.message}`);
    }
  }, intervalMs);
  sweepTimer.unref?.();
  console.log(`[poller-manager] Stray poller sweep every ${Math.round(intervalMs / 1000)}s`);
}

export interface PollerOpts {
  deploymentId: string;
  /** The agent's mailbox — its Microsoft 365 address. */
  agentEmail: string;
  agentId: string;
  /** Full base URL for the agent gateway, e.g. "http://127.0.0.1:18800" */
  gatewayUrl: string;
  /**
   * Bearer token the poller presents to the agent gateway. Optional: when unset
   * it is derived from the deployment id, so a caller cannot accidentally spawn
   * a poller that fails to authenticate. Overridable only for tests.
   */
  hooksToken?: string;
  marketplaceUrl: string;
  /**
   * Microsoft 365 address to poll, if it differs from agentEmail. Both now hold
   * the same value for a Microsoft deployment; kept so callers that read
   * workspaceEmail directly stay explicit about which address they mean.
   */
  outlookEmail?: string;
}

/**
 * Spawn the Outlook mail poller for a deployment.
 * If a poller is already registered for this deployment it is killed first.
 *
 * Mail is Microsoft-only. There was previously an AgentMail poller selected by
 * an emailMode flag, which gave every agent a second address on a second system
 * that had to be kept in sync — and because the flag lived only in transient
 * container env, a restart silently reverted deployments onto it.
 */
export function startPoller(opts: PollerOpts): ChildProcess {
  stopPoller(opts.deploymentId); // idempotent — no-op if nothing is running

  const script = resolvePollerScript("outlook-poller.mjs");

  const pollAddress = opts.outlookEmail || opts.agentEmail;
  const baseEnv: Record<string, string> = {
    ...process.env as Record<string, string>,
    OPENCLAW_HOOKS_TOKEN:
      opts.hooksToken ?? hooksTokenFor(opts.deploymentId, process.env.PROVISIONING_SECRET || ""),
    POLLER_GATEWAY_URL: opts.gatewayUrl,
    MARKETPLACE_URL: opts.marketplaceUrl,
    DEPLOYMENT_ID: opts.deploymentId,
    AGENT_ID: opts.agentId,
    OUTLOOK_AGENT_EMAIL: pollAddress,
    OUTLOOK_TOKEN_URL: `http://127.0.0.1:${process.env.PROVISIONING_PORT || "3003"}/internal/microsoft-token`,
    // The mailbox being polled. Previously this was set to the AgentMail address
    // even in Outlook mode, contradicting the comment above it.
    POLLER_INBOX: pollAddress,
  };

  const child = spawn(process.execPath, [script], {
    env: baseEnv,
    stdio: "pipe",
    detached: false,
  });

  const label = `outlook-${opts.deploymentId.slice(0, 8)}`;
  child.stdout?.on("data", (d: Buffer) => process.stdout.write(`[${label}] ${d}`));
  child.stderr?.on("data", (d: Buffer) => process.stderr.write(`[${label}] ${d}`));
  child.on("exit", (code) => {
    console.log(`[${label}] Exited (code ${code})`);
    // Only clear the slot if it still points at *this* child. A SIGTERMed poller
    // can take long enough to die that its replacement is already spawned and
    // registered by the time this fires; deleting by key alone then evicted the
    // healthy replacement from the map, leaving it running but untracked — and so
    // never stopped by the next startPoller, which happily spawned a third.
    if (pollers.get(opts.deploymentId) === child) {
      pollers.delete(opts.deploymentId);
    }
  });

  pollers.set(opts.deploymentId, child);
  console.log(`[${label}] Started → ${opts.gatewayUrl} (mailbox: ${pollAddress})`);
  return child;
}

/**
 * Kill every poller for a deployment — the registered one and any stray.
 *
 * This must leave nothing polling the mailbox by the time it returns, because
 * startPoller spawns immediately afterwards and two live pollers means every
 * email is delivered to the agent twice. So the tracked child is asked to stop,
 * and then anything still alive for this deployment is killed outright.
 *
 * SIGKILL is safe here: the poller installs no signal handlers and holds no
 * unflushed state — its "have I handled this message" record is the isRead flag
 * in the mailbox, which Graph already has.
 */
export function stopPoller(deploymentId: string): void {
  const short = deploymentId.slice(0, 8);
  const child = pollers.get(deploymentId);
  if (child) {
    child.kill("SIGTERM");
    pollers.delete(deploymentId);
    console.log(`[poller-manager] Stopped poller for ${short}`);
  }

  // Includes the child just signalled, which will not have exited yet. Killing it
  // again is the point: it guarantees the mailbox is unattended before we respawn.
  for (const pid of findPollerPids(deploymentId)) {
    try {
      process.kill(pid, "SIGKILL");
      console.log(`[poller-manager] Killed stray poller pid ${pid} for ${short}`);
    } catch {
      // Already gone.
    }
  }
}

export function getPollerCount(): number {
  return pollers.size;
}
