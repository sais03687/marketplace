/**
 * Centralized AgentMail poller process manager.
 *
 * All runtime modes (local OpenClaw, Docker OpenClaw, Custom Docker) register
 * their pollers here so that:
 *   - deprovision can reliably kill the right poller
 *   - startup recovery can re-spawn pollers for Docker containers that survived a
 *     service restart
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Deployment ID → poller child process
const pollers = new Map<string, ChildProcess>();

function resolvePollerScript(): string {
  const localPath = join(__dirname, "agentmail-poller.mjs");
  if (existsSync(localPath)) return localPath;
  const srcPath = join(__dirname, "..", "..", "src", "jobs", "agentmail-poller.mjs");
  if (existsSync(srcPath)) return srcPath;
  throw new Error(
    `Cannot find agentmail-poller.mjs (checked ${localPath} and ${srcPath})`,
  );
}

export interface PollerOpts {
  deploymentId: string;
  agentEmail: string;
  /** AgentMail inbox UUID — used as path param in API calls. Falls back to agentEmail if omitted. */
  inboxId?: string;
  agentId: string;
  /** Full base URL for the agent gateway, e.g. "http://127.0.0.1:18800" */
  gatewayUrl: string;
  /** Bearer token for OpenClaw hooks auth. Pass "" for custom runtimes. */
  hooksToken: string;
  marketplaceUrl: string;
}

/**
 * Spawn an AgentMail poller for a deployment.
 * If a poller is already registered for this deployment it is killed first.
 */
export function startPoller(opts: PollerOpts): ChildProcess {
  stopPoller(opts.deploymentId); // idempotent — no-op if nothing is running

  const script = resolvePollerScript();
  const child = spawn(process.execPath, [script], {
    env: {
      ...process.env,
      AGENTMAIL_API_KEY: config.agentMailApiKey,
      OPENCLAW_HOOKS_TOKEN: opts.hooksToken,
      POLLER_INBOX: opts.agentEmail,
      // Inbox ID (UUID) is what the AgentMail API path params actually need.
      // Falls back to email address for backwards compatibility.
      POLLER_INBOX_ID: opts.inboxId || opts.agentEmail,
      POLLER_GATEWAY_URL: opts.gatewayUrl,
      MARKETPLACE_URL: opts.marketplaceUrl,
      DEPLOYMENT_ID: opts.deploymentId,
      AGENT_ID: opts.agentId,
    },
    stdio: "pipe",
    detached: false,
  });

  const label = `poller-${opts.deploymentId.slice(0, 8)}`;
  child.stdout?.on("data", (d: Buffer) => process.stdout.write(`[${label}] ${d}`));
  child.stderr?.on("data", (d: Buffer) => process.stderr.write(`[${label}] ${d}`));
  child.on("exit", (code) => {
    console.log(`[${label}] Exited (code ${code})`);
    pollers.delete(opts.deploymentId);
  });

  pollers.set(opts.deploymentId, child);
  console.log(`[${label}] Started → ${opts.gatewayUrl} (inbox: ${opts.agentEmail})`);
  return child;
}

/** Kill the poller for a deployment. No-op if none is registered. */
export function stopPoller(deploymentId: string): void {
  const child = pollers.get(deploymentId);
  if (!child) return;
  child.kill("SIGTERM");
  pollers.delete(deploymentId);
  console.log(`[poller-manager] Stopped poller for ${deploymentId.slice(0, 8)}`);
}

export function getPollerCount(): number {
  return pollers.size;
}
