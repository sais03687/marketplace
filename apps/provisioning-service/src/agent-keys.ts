import fs from "node:fs";
import path from "node:path";
import type { KeyManagementApi } from "./clients/openrouter-keys.js";

/**
 * One OpenRouter key per hire, so each agent's model spend is visible on its
 * own and capped by OpenRouter itself rather than only by our code.
 *
 * - Created the first time a hire calls the model, which also moves hires that
 *   existed before this onto their own key without a restart.
 * - Monthly limit by tier, reset by OpenRouter on the 1st: the allowance agreed
 *   in docs/monitoring-plan.md (A1). Top-ups (B2) raise it.
 * - Deleted when the hire is fired; a sweep removes any key whose hire is gone.
 * - Safety stop: a key that spends more than its tier's hourly limit is
 *   disabled and the operator told. Buying more never re-enables it; the
 *   operator does, after looking.
 *
 * Secrets are kept in a root-only file on this server, not in the database:
 * the broker that uses them runs here, and a database leak then leaks no keys.
 * Losing the file costs nothing but recreation; the sweep removes the old keys.
 * Nothing in this module logs a key's secret value.
 */

export type Tier = "standard" | "pro" | "premium";

export const MONTHLY_ALLOWANCE: Record<Tier, number> = { standard: 0.5, pro: 7, premium: 30 };
export const HOURLY_STOP: Record<Tier, number> = { standard: 1, pro: 5, premium: 15 };
export const KEY_PREFIX = "agentstore:";

const HOUR_MS = 60 * 60 * 1000;

interface StoredKey {
  hash: string;
  key: string;
  tier: Tier;
  createdAt: string;
  stoppedAt?: string;
  stopReason?: string;
}

interface StoreFile {
  version: 1;
  keys: Record<string, StoredKey>;
}

export type KeyLookup =
  | { status: "ok"; key: string }
  | { status: "stopped"; reason: string };

export interface RunawayAlert {
  deploymentId: string;
  tier: Tier;
  spentLastHour: number;
  stop: number;
}

export function asTier(value: unknown): Tier {
  return value === "pro" || value === "premium" ? value : "standard";
}

export class AgentKeyStore {
  private data: StoreFile | null = null;
  private creating = new Map<string, Promise<KeyLookup>>();
  /** Lifetime usage readings per deployment, for the hourly window. In memory: a restart just restarts the window. */
  private samples = new Map<string, { t: number; usage: number }[]>();
  /** Hires revoked since this process started: a late model call must not mint them a new key. */
  private revokedIds = new Set<string>();

  constructor(
    private readonly file: string,
    private readonly api: KeyManagementApi,
    private readonly now: () => number = () => Date.now(),
    /** Overridable only so a live test can trip the stop with a cent of real spend. */
    private readonly stops: Record<Tier, number> = HOURLY_STOP,
  ) {}

  private load(): StoreFile {
    if (this.data) return this.data;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (parsed?.version === 1 && parsed.keys && typeof parsed.keys === "object") {
        this.data = parsed as StoreFile;
        return this.data;
      }
      throw new Error("unrecognised shape");
    } catch (err: any) {
      if (err?.code !== "ENOENT") {
        // Keep the unreadable file for inspection rather than overwrite it; the
        // keys it held become orphans the sweep removes.
        const aside = `${this.file}.unreadable-${this.now()}`;
        try {
          fs.renameSync(this.file, aside);
        } catch {
          /* nothing to move */
        }
        console.error(`[agent-keys] key store unreadable (${err?.message}); moved aside, starting empty`);
      }
      this.data = { version: 1, keys: {} };
      return this.data;
    }
  }

  private save(): void {
    const data = this.load();
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    try {
      fs.chmodSync(this.file, 0o600);
    } catch {
      /* best effort on platforms without modes */
    }
  }

  /** The hire's own key, creating it on first use. Concurrent first calls share one creation. */
  async keyFor(deploymentId: string, tier: Tier): Promise<KeyLookup> {
    if (this.revokedIds.has(deploymentId)) return { status: "stopped", reason: "fired" };
    const existing = this.load().keys[deploymentId];
    if (existing) {
      return existing.stoppedAt
        ? { status: "stopped", reason: existing.stopReason || "safety stop" }
        : { status: "ok", key: existing.key };
    }
    const pending = this.creating.get(deploymentId);
    if (pending) return pending;

    const creation = (async (): Promise<KeyLookup> => {
      const { key, info } = await this.api.create({
        name: `${KEY_PREFIX}${deploymentId}`,
        limit: MONTHLY_ALLOWANCE[tier],
        limitReset: "monthly",
      });
      this.load().keys[deploymentId] = { hash: info.hash, key, tier, createdAt: new Date(this.now()).toISOString() };
      this.save();
      console.log(`[agent-keys] created key for ${deploymentId} (${tier}, $${MONTHLY_ALLOWANCE[tier]}/month)`);
      return { status: "ok", key };
    })();
    this.creating.set(deploymentId, creation);
    try {
      return await creation;
    } finally {
      this.creating.delete(deploymentId);
    }
  }

  /** Delete the hire's key at OpenRouter and forget it. Safe to call when there is none. */
  async revoke(deploymentId: string): Promise<boolean> {
    this.revokedIds.add(deploymentId);
    const entry = this.load().keys[deploymentId];
    if (!entry) return false;
    await this.api.remove(entry.hash);
    delete this.load().keys[deploymentId];
    this.samples.delete(deploymentId);
    this.save();
    console.log(`[agent-keys] deleted key for ${deploymentId}`);
    return true;
  }

  /** Lift a safety stop. Operator action only. */
  async resume(deploymentId: string): Promise<boolean> {
    const entry = this.load().keys[deploymentId];
    if (!entry?.stoppedAt) return false;
    await this.api.update(entry.hash, { disabled: false });
    delete entry.stoppedAt;
    delete entry.stopReason;
    this.samples.delete(deploymentId);
    this.save();
    console.log(`[agent-keys] safety stop lifted for ${deploymentId}`);
    return true;
  }

  /**
   * Remove keys whose hire no longer exists or is fired: entries in the store,
   * and keys at OpenRouter carrying our prefix that the store has lost track of.
   * `live` returns which of the given ids are still hires that may run.
   */
  async sweep(live: (ids: string[]) => Promise<Set<string>>): Promise<number> {
    const remote = (await this.api.list()).filter((k) => k.name.startsWith(KEY_PREFIX));
    const ids = new Set([...Object.keys(this.load().keys), ...remote.map((k) => k.name.slice(KEY_PREFIX.length))]);
    if (ids.size === 0) return 0;
    const alive = await live([...ids]);
    let removed = 0;
    for (const k of remote) {
      const id = k.name.slice(KEY_PREFIX.length);
      // Mid-creation: the key exists at OpenRouter but is not saved yet.
      if (this.creating.has(id)) continue;
      const stored = this.load().keys[id];
      // Dead hire, or a duplicate the store does not point at (a lost file, a
      // crash between create and save): either way nothing will ever use it.
      if (!alive.has(id) || !stored || stored.hash !== k.hash) {
        await this.api.remove(k.hash);
        removed++;
      }
    }
    for (const id of Object.keys(this.load().keys)) {
      if (!alive.has(id)) {
        delete this.load().keys[id];
        this.samples.delete(id);
      }
    }
    if (removed) console.log(`[agent-keys] sweep removed ${removed} key(s)`);
    this.save();
    return removed;
  }

  /** Disable any key that spent more than its hourly stop. Returns what was stopped. */
  async checkRunaway(): Promise<RunawayAlert[]> {
    const stopped: RunawayAlert[] = [];
    const t = this.now();
    for (const [deploymentId, entry] of Object.entries(this.load().keys)) {
      if (entry.stoppedAt) continue;
      let info;
      try {
        info = await this.api.get(entry.hash);
      } catch (err: any) {
        console.warn(`[agent-keys] usage check failed for ${deploymentId}: ${err.message}`);
        continue;
      }
      if (!info) {
        // Deleted outside the platform. Forget it; the next call makes a new one.
        delete this.load().keys[deploymentId];
        this.samples.delete(deploymentId);
        this.save();
        continue;
      }
      const series = (this.samples.get(deploymentId) ?? []).filter((s) => t - s.t <= HOUR_MS);
      series.push({ t, usage: info.usage });
      this.samples.set(deploymentId, series);
      const spentLastHour = info.usage - series[0].usage;
      const stop = this.stops[entry.tier];
      if (spentLastHour > stop) {
        await this.api.update(entry.hash, { disabled: true });
        entry.stoppedAt = new Date(t).toISOString();
        entry.stopReason = `spent $${spentLastHour.toFixed(2)} in under an hour (stop is $${stop})`;
        this.save();
        console.warn(`[agent-keys] SAFETY STOP ${deploymentId}: ${entry.stopReason}`);
        stopped.push({ deploymentId, tier: entry.tier, spentLastHour, stop });
      }
    }
    return stopped;
  }

  /** For tests and the operator: what is held, without secrets. */
  describe(): { deploymentId: string; hash: string; tier: Tier; stopped: boolean }[] {
    return Object.entries(this.load().keys).map(([deploymentId, e]) => ({
      deploymentId,
      hash: e.hash,
      tier: e.tier,
      stopped: Boolean(e.stoppedAt),
    }));
  }
}
