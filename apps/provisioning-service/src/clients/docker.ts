import Dockerode from "dockerode";
import { config } from "../config.js";

const docker = new Dockerode();

export interface ContainerEnv {
  DEPLOYMENT_ID: string;
  AGENT_ID: string;
  ANTHROPIC_API_KEY: string;
  AGENTMAIL_API_KEY: string;
  AGENT_EMAIL: string;
  AGENT_NAME: string;
  COMPANY_NAME: string;
  COMPANY_DOMAIN: string;
  MARKETPLACE_APPROVAL_WEBHOOK: string;
  MARKETPLACE_URL?: string;
  APPROVAL_WEBHOOK_TOKEN: string;
  MODEL: string;
  WEEKLY_DIGEST_EMAIL?: string;
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
  // Appended to /agent/workspace/AGENTS.md by startup.sh so the OpenClaw agent's
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
  // Google Workspace service account (Drive/Sheets/Docs). Both agents share the
  // same SA; files must be shared with this email address for the agent to access them.
  GOOGLE_SERVICE_ACCOUNT_EMAIL?: string;
  GOOGLE_SERVICE_ACCOUNT_KEY?: string;
}

function envToArray(env: ContainerEnv): string[] {
  return Object.entries(env).map(([k, v]) => `${k}=${v}`);
}

export async function createAndStartContainer(
  name: string,
  env: ContainerEnv,
  volumeBinds?: string[],  // optional extra bind mounts (e.g. creator package)
): Promise<{ containerId: string; containerName: string }> {
  const container = await docker.createContainer({
    Image: config.openclawImage,
    name,
    Env: envToArray(env),
    ExposedPorts: { "4000/tcp": {} },
    HostConfig: {
      PortBindings: {
        "4000/tcp": [{ HostPort: "0" }], // random available port
      },
      RestartPolicy: { Name: "unless-stopped" },
      ...(volumeBinds && volumeBinds.length > 0 ? { Binds: volumeBinds } : {}),
      // Security: resource limits
      Memory: 512 * 1024 * 1024,        // 512 MB hard limit
      MemorySwap: 512 * 1024 * 1024,    // no swap (same as memory = swap disabled)
      NanoCpus: 1_000_000_000,           // 1 CPU core
      PidsLimit: 256,                    // max 256 processes (prevents fork bombs)
      SecurityOpt: ["no-new-privileges"],
    },
  });

  await container.start();

  const info = await container.inspect();
  return {
    containerId: info.Id,
    containerName: info.Name.replace(/^\//, ""),
  };
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
