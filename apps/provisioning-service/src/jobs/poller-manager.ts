/**
 * Centralized mail poller process manager.
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

export interface PollerOpts {
  deploymentId: string;
  /** The agent's mailbox — its Microsoft 365 address. */
  agentEmail: string;
  agentId: string;
  /** Full base URL for the agent gateway, e.g. "http://127.0.0.1:18800" */
  gatewayUrl: string;
  /** Bearer token for OpenClaw hooks auth. Pass "" for custom runtimes. */
  hooksToken: string;
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
    OPENCLAW_HOOKS_TOKEN: opts.hooksToken,
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
    pollers.delete(opts.deploymentId);
  });

  pollers.set(opts.deploymentId, child);
  console.log(`[${label}] Started → ${opts.gatewayUrl} (mailbox: ${pollAddress})`);
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
