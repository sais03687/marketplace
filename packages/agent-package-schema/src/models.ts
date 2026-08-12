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

/** Tiers already exist in the DB enum and in the pricing floors; keep them. */
export type ModelTierName = "haiku" | "sonnet" | "opus";

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
  // ── haiku: cheap and fast, $29/mo floor ──────────────────────────────────
  {
    id: "google/gemini-2.5-flash",
    tier: "haiku",
    provider: "openrouter",
    label: "Gemini 2.5 Flash",
  },
  {
    id: "anthropic/claude-haiku-4.5",
    tier: "haiku",
    provider: "openrouter",
    label: "Claude Haiku 4.5",
  },
  {
    id: "openai/gpt-4.1-mini",
    tier: "haiku",
    provider: "openrouter",
    label: "GPT-4.1 mini",
  },

  // ── sonnet: the working default for analysis, $59/mo floor ───────────────
  {
    id: "anthropic/claude-sonnet-5",
    tier: "sonnet",
    provider: "openrouter",
    label: "Claude Sonnet 5",
  },
  {
    id: "openai/gpt-4.1",
    tier: "sonnet",
    provider: "openrouter",
    label: "GPT-4.1",
  },
  {
    id: "google/gemini-2.5-pro",
    tier: "sonnet",
    provider: "openrouter",
    label: "Gemini 2.5 Pro",
  },

  // ── opus: top tier, $149/mo floor ────────────────────────────────────────
  {
    id: "anthropic/claude-opus-5",
    tier: "opus",
    provider: "openrouter",
    label: "Claude Opus 5",
  },
] as const;

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
