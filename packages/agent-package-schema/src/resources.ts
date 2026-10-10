/**
 * Compute an agent asks for, declared in its manifest as `resources`.
 *
 * "standard" is what every agent has always had. "large" is for simulation,
 * optimisation and data work that does not fit in 512 MB on one core; it costs
 * more to run, so it carries a higher price floor (see the web app's
 * agent-pricing.ts), and the host checks it has room before starting one.
 *
 * The sizes here are defaults. The provisioning service may raise them with
 * RESOURCE_LARGE_MEMORY_MB / RESOURCE_LARGE_CPUS once the host is bigger, without
 * a manifest changing.
 */
export const RESOURCE_TIERS = {
  standard: { memoryMb: 512, cpus: 1 },
  large: { memoryMb: 2048, cpus: 2 },
} as const;

export type ResourceTier = keyof typeof RESOURCE_TIERS;

export const RESOURCE_TIER_NAMES = Object.keys(RESOURCE_TIERS) as ResourceTier[];

/** The tier a manifest asks for; "standard" when it names none or one that does not exist. */
export function resourceTierOf(manifest: unknown): ResourceTier {
  const value = manifest && typeof manifest === "object" ? (manifest as Record<string, unknown>).resources : undefined;
  return typeof value === "string" && value in RESOURCE_TIERS ? (value as ResourceTier) : "standard";
}
