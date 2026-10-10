/**
 * What an agent may cost, in one place.
 *
 * These numbers lived in three routes with three different behaviours: the
 * publish wizard enforced the floor and exempted zero, the versions route
 * enforced it and did not, and the edit endpoint enforced nothing at all —
 * `pricePerMonth: z.number().int().min(0)` and no tier check. So the same price
 * could be accepted or rejected depending on which door it came through, and an
 * edit could set a price no upload would have allowed.
 */

/** Floor per model tier, in cents. Growth-phase figures; revisit deliberately. */
export const MIN_PRICE_CENTS: Record<string, number> = {
  STANDARD: 2900, // $29/mo
  PRO: 5900, // $59/mo
  PREMIUM: 14900, // $149/mo
  // The names these replaced on 2026-08-17. Kept because rows written before
  // then still hold them, and a floor that silently falls back to the cheapest
  // band would under-charge for an agent running the priciest model.
  HAIKU: 2900,
  SONNET: 5900,
  OPUS: 14900,
};

/** Fallback for a tier we do not recognise — the cheapest floor, never free. */
export const DEFAULT_MIN_PRICE_CENTS = 2900;

export function minPriceFor(modelTier: string | null | undefined): number {
  return MIN_PRICE_CENTS[(modelTier || "").toUpperCase()] ?? DEFAULT_MIN_PRICE_CENTS;
}

/**
 * Reject a price, or return null if it is allowed.
 *
 * Zero is exempt on purpose. It is not a cheap price, it is a free agent, and
 * the platform supports those deliberately — the hire flow guards on
 * `pricePerMonth > 0` and provisions without payment when it is zero. Applying
 * a tier floor to it meant a free agent could never publish a version at all,
 * because zero is below every minimum.
 */
/**
 * Extra floor for a larger compute tier, in cents. A "large" agent reserves
 * four times the memory and twice the CPU of a standard one on hardware the
 * platform pays for, so it cannot sell at the standard floor.
 * LARGE_COMPUTE_SURCHARGE_USD changes it.
 */
export function computeSurchargeCents(resources: string | null | undefined): number {
  if ((resources || "standard").toLowerCase() !== "large") return 0;
  const usd = Number(process.env.LARGE_COMPUTE_SURCHARGE_USD);
  return (Number.isFinite(usd) && usd >= 0 ? usd : 40) * 100;
}

/**
 * Reject a price, or return null if it is allowed.
 *
 * Zero is exempt on purpose. It is not a cheap price, it is a free agent, and
 * the platform supports those deliberately — the hire flow guards on
 * `pricePerMonth > 0` and provisions without payment when it is zero. Applying
 * a tier floor to it meant a free agent could never publish a version at all,
 * because zero is below every minimum.
 *
 * Except on a larger compute tier: the hardware it reserves is a real cost
 * to the platform whatever the creator charges, so a large agent cannot be free.
 */
export function priceRejection(
  price: number | undefined,
  modelTier: string | null | undefined,
  resources?: string | null,
): string | null {
  if (price === undefined) return null; // caller has no opinion; not our business
  const surcharge = computeSurchargeCents(resources);
  if (price === 0 && surcharge === 0) return null; // free agent
  const min = minPriceFor(modelTier) + surcharge;
  if (price < min) {
    const tier = (modelTier || "this").toLowerCase();
    return surcharge
      ? `Minimum price for a ${tier}-tier agent on large compute is $${(min / 100).toFixed(0)}/month`
      : `Minimum price for ${tier} tier is $${(min / 100).toFixed(0)}/month`;
  }
  return null;
}
