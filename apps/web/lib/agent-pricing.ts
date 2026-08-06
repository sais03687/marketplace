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
  HAIKU: 2900, // $29/mo
  SONNET: 5900, // $59/mo
  OPUS: 14900, // $149/mo
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
export function priceRejection(
  price: number | undefined,
  modelTier: string | null | undefined,
): string | null {
  if (price === undefined) return null; // caller has no opinion; not our business
  if (price === 0) return null; // free agent
  const min = minPriceFor(modelTier);
  if (price < min) {
    const tier = (modelTier || "this").toLowerCase();
    return `Minimum price for ${tier} tier is $${(min / 100).toFixed(0)}/month`;
  }
  return null;
}
