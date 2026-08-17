/**
 * Which models an agent may run on, and what each one costs the buyer.
 *
 * Before this file, `modelTier` was decorative. A creator declared
 * "haiku" | "sonnet" | "opus" in their manifest; it set the price floor
 * (agent-pricing.ts) and the runtime rate limits (adapter.py `_TIER_LIMITS`),
 * and it chose no model at all. Every agent on the platform ran whatever a
 * single platform-wide `LLM_MODEL` env var happened to say — in production,
 * `google/gemini-2.5-flash`, including for agents whose creators had declared
 * opus and whose buyers were paying the $149 floor for it.
 *
 * It was open in the other direction too. The creator's own code constructs the
 * LLM client, so nothing stopped it pinning the priciest model on the platform's
 * key while declaring haiku and charging $29. Vetting scans for dangerous
 * imports and embedded secrets; it never looked at which model was being built.
 *
 * So: the creator picks a model by id, and the tier is *derived* from that pick.
 * The two can no longer disagree, because only one of them is declared. The
 * platform keeps everything else — the key, the base URL, the account the bill
 * lands on — and injects it at provision time.
 *
 * Every id here was confirmed to resolve against the live provider on
 * 2026-08-12. An id that does not resolve fails at hire time, in front of a
 * buyer, which is the worst possible moment to discover a typo.
 */

/**
 * What a tier is called, and what it used to be called.
 *
 * The tiers were named haiku / sonnet / opus, after one vendor's model line,
 * while the catalogue below has always held Google and OpenAI models too — so a
 * creator picking Gemini 2.5 Pro declared "sonnet", and a buyer reading the
 * listing saw a competitor's product name attached to it. Renamed on
 * 2026-08-17 to say what the tier actually is: a price band.
 *
 * The old names are still accepted. They are written into every manifest
 * published before today, and a rename that rejects existing packages is a
 * rename that breaks the one promise a marketplace makes to the people building
 * on it. They map to the new names on the way in and are never shown again.
 */
export type ModelTierName = "standard" | "pro" | "premium";

export const MODEL_TIERS: readonly ModelTierName[] = ["standard", "pro", "premium"] as const;

/** Retired names, kept working. Not shown in docs or in validation errors. */
export const TIER_ALIASES: Readonly<Record<string, ModelTierName>> = {
  haiku: "standard",
  sonnet: "pro",
  opus: "premium",
};

/** The canonical name for whatever a manifest declared, or null if it is not a tier. */
export function canonicalTier(value: unknown): ModelTierName | null {
  const raw = String(value ?? "").trim().toLowerCase();
  if ((MODEL_TIERS as readonly string[]).includes(raw)) return raw as ModelTierName;
  return TIER_ALIASES[raw] ?? null;
}

/**
 * Who serves the model. Today every entry routes through OpenRouter, which is
 * an aggregator: one account, one key, many vendors — hence the `vendor/model`
 * ids below. The indirection exists so that pointing a model at a direct vendor
 * key later is a change to PROVIDER_CREDENTIALS and nothing else.
 */
export type ModelProvider = "openrouter";

export interface ModelCatalogueEntry {
  /** What the creator writes in the manifest, and what LLM_MODEL becomes. */
  id: string;
  /** Derived from the pick — drives the price floor and the runtime budgets. */
  tier: ModelTierName;
  provider: ModelProvider;
  /** Shown to creators when their pick is rejected. */
  label: string;
}

/**
 * Which env var carries the credential for a provider, and where its API lives.
 * The platform sets these; creator code never sees a key, only the model id.
 */
export const PROVIDER_CREDENTIALS: Record<
  ModelProvider,
  { keyEnv: string; baseUrl: string }
> = {
  openrouter: {
    keyEnv: "LLM_API_KEY",
    baseUrl: "https://openrouter.ai/api/v1",
  },
};

export const MODEL_CATALOGUE: readonly ModelCatalogueEntry[] = [
  // ── standard: the cheap band, $29/mo floor ───────────────────────────────
  {
    id: "google/gemini-2.5-flash",
    tier: "standard",
    provider: "openrouter",
    label: "Gemini 2.5 Flash",
  },
  {
    id: "anthropic/claude-haiku-4.5",
    tier: "standard",
    provider: "openrouter",
    label: "Claude Haiku 4.5",
  },
  {
    id: "openai/gpt-4.1-mini",
    tier: "standard",
    provider: "openrouter",
    label: "GPT-4.1 mini",
  },
  {
    // Cheapest on the platform by an order of magnitude — $0.03/$0.17 per M
    // against Flash's $0.30/$2.50 — and on 2026-08-17 it read subtotal rows
    // correctly on a budget-variance task that Flash double-counted 3 times out
    // of 3. Added because the production Data Analyst was already running it
    // while the catalogue refused to let anyone publish on it.
    //
    // Slow, though, and a creator picking it should know: measured the same day
    // over a prompt the size these agents send, one reasoning call took 28-38s
    // against Flash's 1-2s. A ten-step task is minutes rather than seconds, and
    // the default LLM_TIMEOUT_S was raised to 120 to suit it.
    id: "openai/gpt-oss-120b",
    tier: "standard",
    provider: "openrouter",
    label: "GPT-OSS 120B",
  },

  // ── pro: the working default for analysis, $59/mo floor ──────────────────
  {
    id: "anthropic/claude-sonnet-5",
    tier: "pro",
    provider: "openrouter",
    label: "Claude Sonnet 5",
  },
  {
    id: "openai/gpt-4.1",
    tier: "pro",
    provider: "openrouter",
    label: "GPT-4.1",
  },
  {
    id: "google/gemini-2.5-pro",
    tier: "pro",
    provider: "openrouter",
    label: "Gemini 2.5 Pro",
  },

  // ── premium: top of the catalogue, $149/mo floor ─────────────────────────
  {
    id: "anthropic/claude-opus-5",
    tier: "premium",
    provider: "openrouter",
    label: "Claude Opus 5",
  },
] as const;

/**
 * Any model the provider serves, priced into a tier.
 *
 * The catalogue above is eight models. OpenRouter serves 414, and a creator who
 * wants one of the other 406 had no way to ask — so the list is now a set of
 * known-good defaults rather than the whole of what is allowed.
 *
 * What the list was really protecting was the price floor. The platform pays
 * the model bill on its own key, and the tier a creator declares sets what the
 * buyer is charged; with an open list and no derivation, an agent could run a
 * $75/M model and charge the $29 floor. So the tier comes from what the model
 * costs, which is a fact the provider publishes, rather than from a hand-kept
 * list of ids.
 *
 * Input-weighted because these prompts are lopsided: system rules, tool
 * listings, memory and prior results go up on every call, and what comes back
 * is a short JSON object. Weighting by output alone would price a cheap-input,
 * dear-output model into a band its real cost does not justify.
 *
 * Calibrated on 2026-08-17 so that all eight catalogue models keep the tier
 * they already had — gpt-oss-120b at 0.07 and Haiku 4.5 at 2.00 in standard,
 * Gemini 2.5 Pro at 3.44 through Sonnet 5 at 4.00 in pro, Opus 5 at 10.00 in
 * premium.
 */
export const TIER_COST_CEILINGS: Readonly<Record<"standard" | "pro", number>> = {
  standard: 2.5,
  pro: 6.0,
};

/** Blended cost per million tokens, weighted toward input. */
export function blendedCostPerM(promptPerM: number, completionPerM: number): number {
  return 0.75 * promptPerM + 0.25 * completionPerM;
}

/** The tier a price implies. Anything above the `pro` ceiling is premium. */
export function tierForPricing(promptPerM: number, completionPerM: number): ModelTierName {
  const cost = blendedCostPerM(promptPerM, completionPerM);
  if (cost <= TIER_COST_CEILINGS.standard) return "standard";
  if (cost <= TIER_COST_CEILINGS.pro) return "pro";
  return "premium";
}

export const VALID_MODEL_IDS: ReadonlySet<string> = new Set(
  MODEL_CATALOGUE.map((m) => m.id),
);

export function findModel(id: string | null | undefined): ModelCatalogueEntry | null {
  if (!id) return null;
  return MODEL_CATALOGUE.find((m) => m.id === id) ?? null;
}

/**
 * The tier a model pick implies. Returns null for an unknown id rather than
 * guessing a tier: guessing would land on a price floor, and a wrong floor is
 * either a creator overcharged or a buyer undercharged.
 */
export function tierForModel(id: string | null | undefined): ModelTierName | null {
  return findModel(id)?.tier ?? null;
}

/** Models grouped by tier, for the "pick one of these" error message. */
export function modelIdsForTier(tier: ModelTierName): string[] {
  return MODEL_CATALOGUE.filter((m) => m.tier === tier).map((m) => m.id);
}
