import Dockerode from "dockerode";
import { config } from "../config.js";

// Exported so the reconciliation sweep can enumerate and remove orphaned
// containers by name, including ones under naming schemes the targeted teardown
// helpers no longer match.
export const docker = new Dockerode();

// ─── Per-Deployment Network Isolation ───────────────────────────────────────

/**
 * Create an isolated Docker bridge network for a deployment.
 * The agent container and its MCP sidecars all attach to this network,
 * preventing lateral movement between deployments.
 */
export async function createAgentNetwork(deploymentId: string): Promise<string> {
  const name = `agent-net-${deploymentId.slice(0, 8)}`;
  try {
    await docker.createNetwork({
      Name: name,
      Driver: "bridge",
      // Internal removes the default gateway, so a container on this network has
      // no route off the host — not to an address, not by ignoring HTTP_PROXY,
      // not over a raw socket. The only way out is the egress proxy, which sits
      // on this network and on the default bridge, and forwards to an allowlist.
      //
      // This is the control. The proxy environment variables are a convenience so
      // ordinary HTTP clients find it; the absent route is what makes exfiltration
      // impossible rather than merely discouraged.
      Internal: true,
      Labels: { "marketplace.deployment": deploymentId },
    });
    console.log(`[docker] Created network ${name}`);
  } catch (err: any) {
    // Network already exists (e.g., retry after partial failure)
    if (err.statusCode === 409) {
      console.log(`[docker] Network ${name} already exists`);
    } else {
      throw err;
    }
  }
  return name;
}

/**
 * Remove the isolated network for a deployment. Safe to call if network
 * doesn't exist or still has connected containers (they must be stopped first).
 */
export async function removeAgentNetwork(deploymentId: string): Promise<void> {
  const name = `agent-net-${deploymentId.slice(0, 8)}`;
  try {
    const network = docker.getNetwork(name);
    await network.remove();
    console.log(`[docker] Removed network ${name}`);
  } catch (err: any) {
    if (err.statusCode === 404) return; // already gone
    console.warn(`[docker] Failed to remove network ${name}: ${err.message}`);
  }
}

/**
 * Remove the agent's data volume.
 *
 * This has to be explicit. `container.remove({ force: true })` removes anonymous
 * volumes only — a *named* one like `custom-data-<id>` survives its container by
 * design, which is the whole point of naming it. So every fire since the volume
 * mount was introduced has left one behind, 29 of them by 2026-08-04, holding the
 * agent's checkpoint database, pending resumes and any file it was given. The fire
 * dialog tells the buyer their files are "deleted permanently"; until this ran,
 * that was not true.
 *
 * Call only after the container is gone: Docker refuses to remove a volume that is
 * still in use, and that refusal is reported here as a warning rather than a throw,
 * so a stuck volume cannot strand the rest of the teardown (identity, licence seat).
 */
export async function removeAgentVolume(deploymentId: string): Promise<boolean> {
  const name = `custom-data-${deploymentId.slice(0, 8)}`;
  try {
    await docker.getVolume(name).remove();
    console.log(`[docker] Removed volume ${name}`);
    return true;
  } catch (err: any) {
    // Reports whether anything was actually removed rather than throwing on 404,
    // because the hourly sweep revisits every fired deployment forever — counting
    // 404s would have it claim the same 29 removals on every run for good.
    if (err.statusCode === 404) return false; // never created, or already gone
    console.warn(`[docker] Failed to remove volume ${name}: ${err.message}`);
    return false;
  }
}

/**
 * Remove agent data volumes that no container references any more.
 *
 * The per-deployment call above only reaches volumes whose deployment still has a
 * row. It does not reach most of them: on 2026-08-04 there were 30 `custom-data-*`
 * volumes and only 3 belonged to a FIRED or ERROR deployment still in the
 * database. The other 27 were from deployments deleted outright, so no row-driven
 * sweep could ever name them. They are reachable only by looking at what Docker
 * actually has.
 *
 * Two independent guards, because this deletes buyer data:
 *
 *  - `dangling=true` — Docker's own "no container references this". Verified on the
 *    VPS that a *stopped* container still protects its volume, so a paused
 *    deployment is safe, and that the live agent's volume is correctly not dangling.
 *  - `protectedIds` — short ids the caller knows are still in service. Belt and
 *    braces: even if the dangling filter ever disagreed, an active deployment's
 *    volume is not removable here.
 *
 * Returns the number actually removed.
 */
export async function removeOrphanedAgentVolumes(
  protectedIds: Set<string>,
): Promise<number> {
  let removed = 0;
  try {
    const { Volumes } = await docker.listVolumes({
      filters: { name: ["custom-data-"], dangling: ["true"] },
    });
    for (const vol of Volumes ?? []) {
      const short = vol.Name.replace(/^custom-data-/, "");
      if (protectedIds.has(short)) {
        console.log(`[docker] Keeping ${vol.Name} — deployment is still in service`);
        continue;
      }
      try {
        await docker.getVolume(vol.Name).remove();
        removed++;
        console.log(`[docker] Removed orphaned volume ${vol.Name}`);
      } catch (err: any) {
        console.warn(`[docker] Could not remove ${vol.Name}: ${err.message}`);
      }
    }
  } catch (err: any) {
    console.warn(`[docker] Could not list volumes: ${err.message}`);
  }
  return removed;
}

export interface ContainerEnv {
  DEPLOYMENT_ID: string;
  AGENT_ID: string;
  ANTHROPIC_API_KEY: string;
  AGENT_EMAIL: string;
  AGENT_NAME: string;
  COMPANY_NAME: string;
  COMPANY_DOMAIN: string;
  COMPANY_TIMEZONE?: string;
  MARKETPLACE_APPROVAL_WEBHOOK: string;
  MARKETPLACE_URL?: string;
  APPROVAL_WEBHOOK_TOKEN: string;
  MODEL: string;
  MANAGER_EMAIL?: string;
  GEMINI_API_KEY?: string;
  LLM_API_KEY?: string;
  LLM_BASE_URL?: string;
  LLM_MODEL?: string;
  // Approval policy configuration (driven by autonomyConfig + onboarding answers)
  // "always"        — every outbound email requires approval (strictest)
  // "external-only" — emails to the manager or @COMPANY_DOMAIN auto-approve; everyone else needs approval (default)
  // "risk-based"    — LLM risk score >= APPROVAL_RISK_THRESHOLD requires approval (else auto-send)
  // "never"         — auto-approve everything (most permissive; use with caution)
  APPROVAL_POLICY?: string;
  APPROVAL_RISK_THRESHOLD?: string;   // float, default "6.0"
  AUTO_APPROVE_LIST?: string;         // comma-separated emails/domains that always auto-approve
  REQUIRE_APPROVAL_LIST?: string;     // comma-separated emails/domains that always require approval
  // Fully rendered markdown section describing the policy in natural language.
  // Appended to the agent workspace so the agent's
  // LLM reads the hired-manager's configured policy at every session.
  // CUSTOM runtime ignores this — adapter.py enforces policy deterministically.
  APPROVAL_POLICY_SECTION?: string;
  // Portal token — lets the agent resolve approvals via email reply and sync
  // the resolution back to the marketplace portal so the platform stays in sync.
  PORTAL_TOKEN?: string;
  // Heartbeat: interval in hours. Omit to disable.
  HEARTBEAT_INTERVAL_HOURS?: string;
  // Heartbeat: interval in minutes — overrides HOURS, used for dev/testing.
  HEARTBEAT_INTERVAL_MINUTES?: string;
  // Legacy Google Workspace service account (Drive/Sheets/Docs) — kept for backward
  // compat with existing deployments using the old per-deployment SA model.
  GOOGLE_SERVICE_ACCOUNT_EMAIL?: string;
  GOOGLE_SERVICE_ACCOUNT_KEY?: string;
  // New workspace identity — platform-owned Google Workspace or Microsoft 365 user.
  // Set when the buyer selects a workspace provider during hire. The agent gets
  // its own calendar, Drive/OneDrive, and file access under this identity.
  WORKSPACE_PROVIDER?: string;      // "GOOGLE" | "MICROSOFT" | "NONE"
  WORKSPACE_EMAIL?: string;         // e.g., alex@agents.[platform-domain].com
  GOOGLE_WORKSPACE_SA_KEY?: string; // Platform SA JSON with DWD (same for all Google deployments)
  // Microsoft credentials are deliberately NOT part of a container's environment.
  // A container once held the platform's own Azure client secret — the whole
  // tenant, not one deployment — where creator code could read it. Containers
  // reach Graph through the provisioning service instead, authenticating with
  // AGENT_TOKEN below. Removed from this type rather than merely left unset, so
  // that putting them back fails to compile.
  // Buyer-org Microsoft: agent fetches tokens via proxy instead of direct credentials
  WORKSPACE_SCOPE?: string;           // "buyer_org" | "platform"
  TOKEN_ENDPOINT_URL?: string;        // e.g., http://host.docker.internal:3003/internal/microsoft-token
  // Per-deployment credential the container presents when calling back into the
  // provisioning service. Derived from the platform secret and this deployment's
  // id, so it authenticates as exactly one deployment and cannot be replayed
  // against another company's.
  AGENT_TOKEN?: string;
  /** Inbound credential the poller must present to this container's /hooks/* routes. */
  AGENT_HOOKS_TOKEN?: string;
  SHAREPOINT_FOLDER?: string;         // agent slug used as SharePoint folder name
  // Email mode: "outlook" uses Graph API via proxy, "agentmail" (default) uses AgentMail
  EMAIL_MODE?: string;
  OUTLOOK_SEND_URL?: string;          // e.g., http://host.docker.internal:3003/internal/outlook-send
}

function envToArray(env: ContainerEnv): string[] {
  return Object.entries(env).map(([k, v]) => `${k}=${v}`);
}

export async function getContainerPort(containerName: string): Promise<number> {
  const container = docker.getContainer(containerName);
  const info = await container.inspect();
  const portBindings = info.NetworkSettings.Ports["4000/tcp"];
  if (!portBindings || portBindings.length === 0) {
    throw new Error(`No port binding found for container ${containerName}`);
  }
  return parseInt(portBindings[0].HostPort, 10);
}

export async function stopContainer(containerName: string): Promise<void> {
  const container = docker.getContainer(containerName);
  try {
    await container.stop({ t: 10 });
  } catch (err: any) {
    if (err.statusCode !== 304) throw err; // 304 = already stopped
  }
  await container.remove({ force: true });
}

export async function startContainer(containerName: string): Promise<void> {
  const container = docker.getContainer(containerName);
  try {
    await container.start();
  } catch (err: any) {
    if (err.statusCode !== 304) throw err; // 304 = already running
  }
}

export async function inspectContainer(
  containerName: string,
): Promise<{ running: boolean; status: string }> {
  const container = docker.getContainer(containerName);
  const info = await container.inspect();
  return {
    running: info.State.Running,
    status: info.State.Status,
  };
}
