import { getProvisioningQueue } from "@/lib/provisioning-queue";

/**
 * How many packages one creator may upload in a day.
 *
 * Every upload builds the package and runs it through the vetting sandbox,
 * which answers with a real model on the platform's account and holds one of
 * the provisioning worker's two slots — the same slots hires use. Nothing
 * limited it, so one creator iterating by upload could spend the model balance
 * and stall everyone else's uploads and hires behind them.
 *
 * Counted in Redis rather than from AgentVersion rows, because republishing a
 * version still in review updates its row instead of adding one: a row count
 * would let the same version be re-uploaded, and re-vetted, without end. The
 * window is the UTC day. A dry run stores and vets nothing, so it is not
 * counted, and an upload refused here does not use up a slot.
 *
 * UPLOAD_LIMIT_PER_DAY sets the number (default 10); 0 turns the limit off.
 * If Redis cannot be reached the upload is allowed — losing the counter should
 * not stop creators publishing — and the failure is logged.
 */
export const DEFAULT_UPLOAD_LIMIT = 10;

export function uploadLimit(): number {
  const raw = process.env.UPLOAD_LIMIT_PER_DAY;
  if (raw === undefined || raw.trim() === "") return DEFAULT_UPLOAD_LIMIT;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_UPLOAD_LIMIT;
}

export type UploadSlot = { allowed: true; used: number; limit: number } | { allowed: false; limit: number };

type Counter = {
  incr(key: string): Promise<number>;
  decr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
};

export async function claimUploadSlot(
  creatorId: string,
  now: Date = new Date(),
  counter?: Counter,
): Promise<UploadSlot> {
  const limit = uploadLimit();
  if (limit === 0) return { allowed: true, used: 0, limit };

  const key = `upload-count:${creatorId}:${now.toISOString().slice(0, 10)}`;
  try {
    const redis: Counter = counter ?? (await getProvisioningQueue().client);
    const used = await redis.incr(key);
    if (used === 1) await redis.expire(key, 2 * 24 * 60 * 60);
    if (used > limit) {
      // Give the slot back: a refused upload should not count against tomorrow's
      // retry, and the counter should say how many uploads actually happened.
      await redis.decr(key);
      return { allowed: false, limit };
    }
    return { allowed: true, used, limit };
  } catch (e) {
    console.error("[upload] could not check the daily upload limit, allowing:", e);
    return { allowed: true, used: 0, limit };
  }
}
