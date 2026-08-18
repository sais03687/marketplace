/**
 * The parts of an update that have to be right, kept where they can be tested.
 *
 * An update restarts the agent, and a restart is not free: it cancels whatever
 * the agent is doing and, if the new version does not come up, leaves the buyer
 * with nothing at all. Both of those are avoidable, and neither is avoided by
 * being careful — they need code.
 */

export interface Probe {
  /** Runs begun and not finished. Zero means nobody is waiting on the agent. */
  busy: number;
  ok: boolean;
}

/**
 * Ask the agent what it is in the middle of.
 *
 * An unreachable agent counts as busy, never as idle: "I could not tell" and
 * "nobody is waiting" are different answers, and treating the first as the
 * second restarts on top of live work.
 */
export async function probeAgent(port: number, fetchImpl = fetch): Promise<Probe> {
  try {
    const res = await fetchImpl(`http://localhost:${port}/internal/health`);
    if (!res.ok) return { ok: false, busy: 1 };
    const body: any = await res.json();
    return { ok: true, busy: typeof body.busy === "number" ? body.busy : 0 };
  } catch {
    return { ok: false, busy: 1 };
  }
}

/**
 * Wait until the agent is not in the middle of anything.
 *
 * Bounded, because an agent that is always busy would postpone its own update
 * forever and a stuck run would postpone it permanently. When the wait runs out
 * the update goes ahead: the interrupted run tells the buyer what happened, so
 * proceeding is a known cost, while never updating is an unbounded one.
 *
 * Returns whether it found a quiet moment, so the caller can say which it was.
 */
export async function waitUntilIdle(
  port: number,
  opts: { timeoutMs?: number; pollMs?: number; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const pollMs = opts.pollMs ?? 3_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const probe = await probeAgent(port, opts.fetchImpl);
    if (probe.ok && probe.busy === 0) return true;
    if (Date.now() >= deadline) return false;
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }
}

/**
 * Wait for the agent to answer after a restart.
 *
 * Only asks whether it is up. Whether it is *correct* is not decidable from
 * here, and pretending otherwise would turn a health check into a quality
 * claim it cannot support.
 */
export async function waitUntilHealthy(
  port: number,
  opts: { timeoutMs?: number; pollMs?: number; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const pollMs = opts.pollMs ?? 2_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if ((await probeAgent(port, opts.fetchImpl)).ok) return true;
    if (Date.now() >= deadline) return false;
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }
}
