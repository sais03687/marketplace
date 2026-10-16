import fs from "node:fs";
import path from "node:path";
import type { KeyManagementApi } from "./clients/openrouter-keys.js";

/**
 * One OpenRouter key per hire, and the broker's own meter of what each hire
 * spends.
 *
 * Keys: created the first time a hire calls the model (which also moves hires
 * that predate this onto their own key), deleted when it is fired, and swept
 * if the hire is gone. They make each agent's spend visible in OpenRouter and
 * carry a monthly limit there as a backstop.
 *
 * Only a backstop: measured on 2026-10-16, OpenRouter's per-key usage still
 * read $0 ten minutes after paid calls, and a key limited to $0.01 completed
 * $0.02 of calls without a refusal. Its counters lag, so they cannot stop a
 * runaway. Every response does state that call's exact cost at once, so the
 * broker meters spend itself and enforces, before each call:
 *   - the monthly allowance by tier (A1 in docs/monitoring-plan.md), plus any
 *     usage the buyer has bought (B2) — refused with "allowance reached";
 *   - the hourly safety stop — the key is disabled and the operator told, and
 *     only the operator lifts it.
 *
 * Secrets and spend live in a root-only file on this server, not the database.
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
}

interface Ledger {
  /** UTC month the totals below belong to, "YYYY-MM". */
  month: string;
  spent: number;
  /** Usage the buyer bought on top of the allowance this month (B2). */
  extra: number;
  /** Operator override of the tier's monthly allowance for this hire (tests, special deals). */
  allowanceOverride?: number;
  /** Whether the account holder has been told this month: 80% used, all used. */
  told80?: boolean;
  told100?: boolean;
  stoppedAt?: string;
  stopReason?: string;
}

interface StoreFile {
  version: 2;
  keys: Record<string, StoredKey>;
  ledger: Record<string, Ledger>;
}

export type Admission =
  | { status: "ok"; key: string | null }
  | { status: "allowance_reached"; spent: number; allowance: number }
  | { status: "stopped"; reason: string };

/** What the account holder should be told after a call: once per month for each. */
export type BuyerNotice = "allowance_80" | "allowance_reached";

export interface SpendResult {
  stop: StopAlert | null;
  notice: BuyerNotice | null;
}

export interface StopAlert {
  deploymentId: string;
  tier: Tier;
  spentLastHour: number;
  stop: number;
}

/** The database stores tiers as STANDARD / PRO / PREMIUM; anything unrecognised is the cheapest. */
export function asTier(value: unknown): Tier {
  const v = typeof value === "string" ? value.toLowerCase() : "";
  return v === "pro" || v === "premium" ? v : "standard";
}

function monthOf(t: number): string {
  return new Date(t).toISOString().slice(0, 7);
}

/**
 * The cost OpenRouter reports for one call, from the tail of its response.
 * Non-streamed: a JSON body with usage.cost. Streamed: server-sent events whose
 * last data line carries usage.cost. Null when the response does not say.
 */
export function extractCost(bodyTail: string): number | null {
  const tryJson = (text: string): number | null => {
    try {
      const cost = JSON.parse(text)?.usage?.cost;
      return typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : null;
    } catch {
      return null;
    }
  };
  const whole = tryJson(bodyTail.trim());
  if (whole !== null) return whole;
  const lines = bodyTail.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith("data:")) continue;
    const cost = tryJson(line.slice(5).trim());
    if (cost !== null) return cost;
  }
  return null;
}

export class AgentKeyStore {
  private data: StoreFile | null = null;
  private creating = new Map<string, Promise<string>>();
  /** Each call's cost in the last hour, per hire. In memory: a restart restarts the hour. */
  private recent = new Map<string, { t: number; cost: number }[]>();
  /** Hires revoked since this process started: a late model call must not mint them a new key. */
  private revokedIds = new Set<string>();

  constructor(
    private readonly file: string,
    private readonly api: KeyManagementApi,
    private readonly now: () => number = () => Date.now(),
    /** Overridable only so a live test can trip the stop with a cent of real spend. */
    private readonly stops: Record<Tier, number> = HOURLY_STOP,
    private readonly allowances: Record<Tier, number> = MONTHLY_ALLOWANCE,
  ) {}

  private load(): StoreFile {
    if (this.data) return this.data;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if ((parsed?.version === 1 || parsed?.version === 2) && parsed.keys && typeof parsed.keys === "object") {
        this.data = { version: 2, keys: parsed.keys, ledger: parsed.ledger ?? {} };
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
      this.data = { version: 2, keys: {}, ledger: {} };
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

  /** This month's ledger, rolled over on a new UTC month. */
  private ledger(deploymentId: string): Ledger {
    const month = monthOf(this.now());
    const all = this.load().ledger;
    const cur = all[deploymentId];
    if (!cur) return (all[deploymentId] = { month, spent: 0, extra: 0 });
    if (cur.month !== month) {
      // A safety stop is not lifted by the calendar.
      all[deploymentId] = {
        month,
        spent: 0,
        extra: 0,
        allowanceOverride: cur.allowanceOverride,
        stoppedAt: cur.stoppedAt,
        stopReason: cur.stopReason,
      };
    }
    return all[deploymentId];
  }

  /**
   * May this hire make a model call now, and with which key?
   * `key` is null when the hire's own key could not be made; the caller then
   * uses the shared key — the spend is still metered and capped here.
   */
  private allowanceOf(l: Ledger, tier: Tier): number {
    return (l.allowanceOverride ?? this.allowances[tier]) + (l.extra || 0);
  }

  /** Whether the hire may run, without creating a key. For the agent to ask before starting a task. */
  peek(deploymentId: string, tier: Tier): { status: "ok" | "allowance_reached" | "stopped"; spent: number; allowance: number } {
    const l = this.ledger(deploymentId);
    const allowance = this.allowanceOf(l, tier);
    if (this.revokedIds.has(deploymentId) || l.stoppedAt) return { status: "stopped", spent: l.spent, allowance };
    return { status: l.spent >= allowance ? "allowance_reached" : "ok", spent: l.spent, allowance };
  }

  /** Operator: set this hire's monthly allowance, or clear the override with null. */
  setAllowanceOverride(deploymentId: string, amount: number | null): void {
    const l = this.ledger(deploymentId);
    if (amount === null) delete l.allowanceOverride;
    else l.allowanceOverride = amount;
    this.save();
  }

  async admit(deploymentId: string, tier: Tier): Promise<Admission> {
    if (this.revokedIds.has(deploymentId)) return { status: "stopped", reason: "fired" };
    const l = this.ledger(deploymentId);
    if (l.stoppedAt) return { status: "stopped", reason: l.stopReason || "safety stop" };
    const allowance = this.allowanceOf(l, tier);
    if (l.spent >= allowance) return { status: "allowance_reached", spent: l.spent, allowance };
    try {
      return { status: "ok", key: await this.keyFor(deploymentId, tier) };
    } catch (err: any) {
      console.warn(`[agent-keys] own key unavailable for ${deploymentId}: ${err.message}`);
      return { status: "ok", key: null };
    }
  }

  /** The hire's own key, creating it on first use. Concurrent first calls share one creation. */
  private async keyFor(deploymentId: string, tier: Tier): Promise<string> {
    const existing = this.load().keys[deploymentId];
    if (existing) {
      if (existing.tier !== tier) {
        // Made under another tier (or misread): bring OpenRouter's backstop
        // limit in line. Best effort — the meter is what enforces.
        try {
          await this.api.update(existing.hash, { limit: this.allowances[tier] });
          existing.tier = tier;
          this.save();
          console.log(`[agent-keys] ${deploymentId} key limit set to ${tier} ($${this.allowances[tier]}/month)`);
        } catch (err: any) {
          console.warn(`[agent-keys] could not update key limit for ${deploymentId}: ${err.message}`);
        }
      }
      return existing.key;
    }
    const pending = this.creating.get(deploymentId);
    if (pending) return pending;

    const creation = (async () => {
      const { key, info } = await this.api.create({
        name: `${KEY_PREFIX}${deploymentId}`,
        limit: this.allowances[tier],
        limitReset: "monthly",
      });
      this.load().keys[deploymentId] = { hash: info.hash, key, tier, createdAt: new Date(this.now()).toISOString() };
      this.save();
      console.log(`[agent-keys] created key for ${deploymentId} (${tier}, $${this.allowances[tier]}/month)`);
      return key;
    })();
    this.creating.set(deploymentId, creation);
    try {
      return await creation;
    } finally {
      this.creating.delete(deploymentId);
    }
  }

  /**
   * Add one call's cost. Trips the safety stop if the last hour now exceeds it:
   * the hire is refused from its next call, its key is switched off at
   * OpenRouter, and the alert is returned for the operator.
   */
  async recordSpend(deploymentId: string, tier: Tier, cost: number): Promise<SpendResult> {
    if (!(cost > 0)) return { stop: null, notice: null };
    const t = this.now();
    const l = this.ledger(deploymentId);
    l.spent += cost;
    const series = (this.recent.get(deploymentId) ?? []).filter((s) => t - s.t < HOUR_MS);
    series.push({ t, cost });
    this.recent.set(deploymentId, series);
    const spentLastHour = series.reduce((a, s) => a + s.cost, 0);
    const stop = this.stops[tier];
    let alert: StopAlert | null = null;
    if (!l.stoppedAt && spentLastHour > stop) {
      l.stoppedAt = new Date(t).toISOString();
      l.stopReason = `spent $${spentLastHour.toFixed(2)} in under an hour (stop is $${stop})`;
      console.warn(`[agent-keys] SAFETY STOP ${deploymentId}: ${l.stopReason}`);
      alert = { deploymentId, tier, spentLastHour, stop };
    }
    // Tell the account holder once a month at 80% and once when it is all
    // used. A top-up (extra) raises the allowance, so the 80% mark moves with it.
    const allowance = this.allowanceOf(l, tier);
    let notice: BuyerNotice | null = null;
    if (l.spent >= allowance && !l.told100) {
      l.told100 = true;
      l.told80 = true;
      notice = "allowance_reached";
    } else if (l.spent >= 0.8 * allowance && !l.told80) {
      l.told80 = true;
      notice = "allowance_80";
    }
    this.save();
    if (alert) {
      const key = this.load().keys[deploymentId];
      if (key) {
        await this.api.update(key.hash, { disabled: true }).catch((err) => {
          console.error(`[agent-keys] could not switch off key for ${deploymentId}: ${err.message}`);
        });
      }
    }
    return { stop: alert, notice };
  }

  /** Lift a safety stop. Operator action only. */
  async resume(deploymentId: string): Promise<boolean> {
    const l = this.load().ledger[deploymentId];
    if (!l?.stoppedAt) return false;
    const key = this.load().keys[deploymentId];
    if (key) await this.api.update(key.hash, { disabled: false });
    delete l.stoppedAt;
    delete l.stopReason;
    this.recent.delete(deploymentId);
    this.save();
    console.log(`[agent-keys] safety stop lifted for ${deploymentId}`);
    return true;
  }

  /** Usage the buyer bought (B2): raises this month's allowance. */
  addExtra(deploymentId: string, amount: number): void {
    const l = this.ledger(deploymentId);
    l.extra = (l.extra || 0) + amount;
    // More to spend: the 80% and used-up notices apply afresh to the new total.
    l.told80 = false;
    l.told100 = false;
    this.save();
  }

  /** Delete the hire's key at OpenRouter and forget it. Safe to call when there is none. */
  async revoke(deploymentId: string): Promise<boolean> {
    this.revokedIds.add(deploymentId);
    const entry = this.load().keys[deploymentId];
    if (!entry) return false;
    await this.api.remove(entry.hash);
    delete this.load().keys[deploymentId];
    this.recent.delete(deploymentId);
    this.save();
    console.log(`[agent-keys] deleted key for ${deploymentId}`);
    return true;
  }

  /**
   * Remove keys whose hire no longer exists or is fired: entries in the store,
   * and keys at OpenRouter carrying our prefix that the store has lost track of.
   * `live` returns which of the given ids are still hires that may run.
   */
  async sweep(live: (ids: string[]) => Promise<Set<string>>): Promise<number> {
    const remote = (await this.api.list()).filter((k) => k.name.startsWith(KEY_PREFIX));
    const ids = new Set([
      ...Object.keys(this.load().keys),
      ...Object.keys(this.load().ledger),
      ...remote.map((k) => k.name.slice(KEY_PREFIX.length)),
    ]);
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
    for (const id of ids) {
      if (!alive.has(id) && !this.creating.has(id)) {
        delete this.load().keys[id];
        delete this.load().ledger[id];
        this.recent.delete(id);
      }
    }
    if (removed) console.log(`[agent-keys] sweep removed ${removed} key(s)`);
    this.save();
    return removed;
  }

  /** What is held, without secrets: for tests, the operator, and the usage bar (B1). */
  describe(): { deploymentId: string; hash: string | null; month: string | null; spent: number; extra: number; stopped: boolean }[] {
    const { keys, ledger } = this.load();
    const ids = new Set([...Object.keys(keys), ...Object.keys(ledger)]);
    return [...ids].map((deploymentId) => ({
      deploymentId,
      hash: keys[deploymentId]?.hash ?? null,
      month: ledger[deploymentId]?.month ?? null,
      spent: ledger[deploymentId]?.spent ?? 0,
      extra: ledger[deploymentId]?.extra ?? 0,
      stopped: Boolean(ledger[deploymentId]?.stoppedAt),
    }));
  }
}
