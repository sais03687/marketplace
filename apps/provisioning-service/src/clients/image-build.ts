import { docker } from "./docker.js";

/**
 * Build an agent image — the one way both vetting and provisioning do it.
 *
 * A build runs code nobody has reviewed: pip's setup.py for every dependency,
 * and the creator's optional build.sh. The provisioning worker runs two jobs at
 * a time and hires share those slots, so a build that hangs or balloons stalls
 * every hire and every other creator's upload behind it. Each build is therefore
 * capped in memory, CPU and time, and cancelled — by closing the connection,
 * which is what stops a build in progress — when it runs over.
 *
 * Provisioning used to build without any of this, and treated a build error as
 * success: the error was logged, the promise resolved, and the failure surfaced
 * later as a missing image. An error event now fails the build here.
 */
// 1.5 GB by default. The host has about 2.3 GB free beside the running agents and
// the worker can run two builds at once, so a larger default could starve the
// agents themselves. Raise AGENT_BUILD_MEMORY_MB with the host, not before it.
export function buildMemoryBytes(): number {
  const mb = Number(process.env.AGENT_BUILD_MEMORY_MB);
  return (Number.isFinite(mb) && mb >= 256 ? mb : 1536) * 1024 * 1024;
}

export function buildTimeoutMs(): number {
  // Twenty minutes by default: build.sh may compile a C++ library and its
  // dependencies, which the old ten-minute pip-only limit was not sized for.
  const n = Number(process.env.AGENT_BUILD_TIMEOUT_MS ?? process.env.VET_BUILD_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 20 * 60_000;
}

export class BuildError extends Error {}

export async function buildAgentImage(
  buildDir: string,
  imageName: string,
  onLog: (line: string) => void = () => {},
): Promise<void> {
  const timeoutMs = buildTimeoutMs();
  const memory = buildMemoryBytes();
  const stream = await docker.buildImage(
    { context: buildDir, src: ["."] },
    {
      t: imageName,
      dockerfile: "Dockerfile",
      memory,
      memswap: memory,
      cpuperiod: 100_000,
      cpuquota: 200_000, // two CPUs
      rm: true,
      forcerm: true, // remove intermediate containers even when a step fails
    },
  );

  let failure: string | null = null;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      failure =
        `build took longer than ${Math.round(timeoutMs / 60_000)} minutes and was stopped — ` +
        `check requirements.txt and build.sh for something very large or that will not finish`;
      onLog(`ERROR: ${failure}`);
      (stream as any).destroy?.();
      reject(new BuildError(failure));
    }, timeoutMs);
    docker.modem.followProgress(
      stream,
      (err: Error | null) => {
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      },
      (event: { stream?: string; error?: string }) => {
        if (event.stream) onLog(event.stream.replace(/\n$/, ""));
        if (event.error) {
          failure = event.error;
          onLog(`ERROR: ${event.error}`);
        }
      },
    );
  });
  if (failure) throw new BuildError(failure);
}
