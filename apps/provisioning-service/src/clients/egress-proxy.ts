import path from "node:path";
import { fileURLToPath } from "node:url";
import { docker } from "./docker.js";
import { config } from "../config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const EGRESS_IMAGE = "marketplace/netgate:latest";
export const EGRESS_PORT = 8888;

/**
 * Hosts every agent needs regardless of what its creator declared.
 *
 * Deliberately short. Each entry is somewhere the platform itself requires the
 * container to reach, and anything a creator wants beyond this has to be
 * declared in their manifest and read by a human at vetting — which is the point
 * of the exercise: turning "trust code nobody can fully read" into "trust a
 * short list of destinations anyone can read".
 */
export function baselineAllowedDomains(): string[] {
  const hosts = new Set<string>([
    "graph.microsoft.com",
    // The provisioning service, for Graph tokens and outbound mail. Reached as
    // host.docker.internal because Internal networks have no host route either.
    "host.docker.internal",
  ]);

  for (const url of [config.approvalWebhookUrl, config.llmBaseUrl, config.publicUrl]) {
    if (!url) continue;
    try {
      hosts.add(new URL(url).hostname);
    } catch {
      /* not a URL — nothing to allow */
    }
  }
  return [...hosts].filter(Boolean);
}

export function netgateName(deploymentId: string): string {
  return `netgate-${deploymentId.slice(0, 8)}`;
}

/** The value agent containers get as HTTP_PROXY / HTTPS_PROXY. */
export function egressProxyUrl(deploymentId: string): string {
  return `http://${netgateName(deploymentId)}:${EGRESS_PORT}`;
}

async function imageExists(): Promise<boolean> {
  try {
    await docker.getImage(EGRESS_IMAGE).inspect();
    return true;
  } catch {
    return false;
  }
}

/** Build the proxy image if it isn't on the host yet. Cheap after the first time. */
export async function ensureEgressImage(): Promise<void> {
  if (await imageExists()) return;
  const context = path.resolve(__dirname, "../docker/egress-proxy");
  console.log(`[egress] Building ${EGRESS_IMAGE} from ${context}`);
  const stream = await docker.buildImage(
    { context, src: ["Dockerfile", "entrypoint.sh"] },
    { t: EGRESS_IMAGE },
  );
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(stream, (err: Error | null) => (err ? reject(err) : resolve()));
  });
  console.log(`[egress] Built ${EGRESS_IMAGE}`);
}

/**
 * Start (or restart) the egress proxy for a deployment on its isolated network.
 *
 * Returns the proxy URL. Throws rather than continuing without a proxy: the
 * agent network has no route out, so a missing proxy means an agent that cannot
 * reach Microsoft — which should surface as a failed provision, not as an agent
 * that looks healthy and silently answers nothing.
 */
export async function startNetgate(
  deploymentId: string,
  networkName: string,
  agentHost: string,
  extraDomains: string[] = [],
): Promise<{ proxyUrl: string; hostPort: number }> {
  await ensureEgressImage();
  const name = netgateName(deploymentId);

  await stopEgressProxy(deploymentId);

  const allowed = [...new Set([...baselineAllowedDomains(), ...extraDomains])];
  console.log(`[netgate] ${name} allows: ${allowed.join(", ")}`);

  const container = await docker.createContainer({
    Image: EGRESS_IMAGE,
    name,
    Env: [`ALLOWED_DOMAINS=${allowed.join(",")}`, `AGENT_HOST=${agentHost}`],
    ExposedPorts: { "4000/tcp": {} },
    HostConfig: {
      // The agent's gateway is published here rather than on the agent itself:
      // Docker will not publish a port for a container on an Internal network,
      // and this is the only member of that network reachable from the host.
      // HostIp pinned to loopback. Omitting it makes Docker publish on 0.0.0.0,
      // which put every agent's gateway on a public interface — and the host runs
      // no firewall (ufw inactive, DOCKER-USER empty), so the only thing between
      // the internet and these ports was an upstream cloud firewall rule that
      // lives nowhere in this repo. The poller runs on this host, so loopback is
      // all that was ever needed.
      PortBindings: { "4000/tcp": [{ HostIp: "127.0.0.1", HostPort: "0" }] },
      RestartPolicy: { Name: "unless-stopped" },
      Memory: 64 * 1024 * 1024,
      MemorySwap: 64 * 1024 * 1024,
      NanoCpus: 250_000_000,
      PidsLimit: 64,
      SecurityOpt: ["no-new-privileges"],
      // This container keeps the host route the agent no longer has.
      ExtraHosts: ["host.docker.internal:host-gateway"],
      // Primary network is the default bridge, deliberately. Docker configures
      // port publishing against the primary network at creation time, so making
      // the Internal network primary produces no mapping at all — verified: the
      // host simply cannot connect, with no error anywhere to explain it.
    },
    Labels: { "marketplace.deployment": deploymentId, "marketplace.role": "netgate" },
  });

  // The agent's network is attached second. This container is then the only
  // member of it with a way off the host — in either direction.
  try {
    await docker.getNetwork(networkName).connect({ Container: container.id });
  } catch (err: any) {
    throw new Error(`[netgate] Could not attach ${name} to ${networkName}: ${err.message}`);
  }

  await container.start();

  const info = await container.inspect();
  const binding = info.NetworkSettings.Ports["4000/tcp"];
  if (!binding?.length) {
    throw new Error(`[netgate] ${name} did not publish a gateway port`);
  }
  const hostPort = parseInt(binding[0].HostPort, 10);
  console.log(`[netgate] Started ${name} on ${networkName} — gateway on host port ${hostPort}`);
  return { proxyUrl: egressProxyUrl(deploymentId), hostPort };
}

/**
 * Hosts this deployment's agent tried to reach and was refused.
 *
 * tinyproxy runs with FilterDefaultDeny and logs every refusal, so the netgate's
 * own log is the record of what the package reached for. Used by vetting to tell
 * a creator "you tried to reach api.openai.com" instead of "the container did not
 * become healthy", which is the same sentence for an OOM, a crash on import, and
 * a hang on a blocked call.
 *
 * Best-effort: a missing netgate or unreadable log yields an empty list, because
 * a diagnostic that throws would replace the real failure with its own.
 */
export async function blockedEgressHosts(deploymentId: string): Promise<string[]> {
  try {
    const logs = await docker
      .getContainer(netgateName(deploymentId))
      .logs({ stdout: true, stderr: true, tail: 1000 });
    const text = Buffer.isBuffer(logs) ? logs.toString("utf8") : String(logs);
    const hosts = new Set<string>();
    for (const m of text.matchAll(/filtered domain\s+"?([^"\s]+)"?/gi)) {
      const host = (m[1] ?? "").trim();
      if (host) hosts.add(host);
    }
    return [...hosts];
  } catch {
    return [];
  }
}

export async function stopEgressProxy(deploymentId: string): Promise<void> {
  const name = netgateName(deploymentId);
  try {
    const c = docker.getContainer(name);
    await c.stop({ t: 5 }).catch(() => {});
    await c.remove({ force: true });
    console.log(`[egress] Removed ${name}`);
  } catch (err: any) {
    if (err.statusCode !== 404) {
      console.warn(`[egress] Could not remove ${name}: ${err.message}`);
    }
  }
}
