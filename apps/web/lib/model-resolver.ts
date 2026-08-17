/**
 * Resolve a model id against the provider, so a creator is not limited to a list.
 *
 * `MODEL_CATALOGUE` holds eight models. OpenRouter serves over four hundred, and
 * the eight were never the point — the price floor was. The tier a creator
 * declares decides what the buyer pays, the platform pays the model bill on its
 * own key, and without a derivation an agent could run the dearest model on the
 * provider and charge the cheapest floor.
 *
 * So the id is checked against what the provider actually serves, and the tier
 * comes from what the provider actually charges. A typo still fails here, at
 * publish time, rather than at hire time in front of a buyer — which was the
 * original reason the list existed.
 *
 * The catalogue is still consulted first. It needs no network, it carries the
 * labels shown in the UI, and it means a provider outage cannot stop someone
 * publishing on a model the platform already knows.
 */
import { findModel, tierForPricing, type ModelTierName } from "@marketplace/agent-package-schema";

const MODELS_URL = "https://openrouter.ai/api/v1/models";

/** Long enough that a publish burst costs one fetch; short enough to pick up new models. */
const CACHE_TTL_MS = 30 * 60 * 1000;

export interface ResolvedModel {
  id: string;
  tier: ModelTierName;
  label: string;
  /** Blended $/M the tier was derived from. Null when it came from the catalogue. */
  costPerM: number | null;
}

interface ProviderModel {
  id: string;
  name?: string;
  pricing?: { prompt?: string; completion?: string };
}

let cache: { at: number; models: Map<string, ProviderModel> } | null = null;

async function providerModels(): Promise<Map<string, ProviderModel>> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.models;

  const res = await fetch(MODELS_URL, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`provider model list unavailable (${res.status})`);
  const body = (await res.json()) as { data?: ProviderModel[] };

  const models = new Map<string, ProviderModel>();
  for (const m of body.data ?? []) if (m?.id) models.set(m.id, m);
  if (models.size === 0) throw new Error("provider returned no models");

  cache = { at: Date.now(), models };
  return models;
}

/**
 * The tier and label for a model id, or an error string explaining the refusal.
 *
 * Returns a message rather than throwing because the caller is a route handler
 * whose job is to hand the creator something they can act on.
 */
export async function resolveModel(
  id: string,
): Promise<{ model: ResolvedModel } | { error: string }> {
  const trimmed = (id || "").trim();
  if (!trimmed) return { error: "model is required" };

  // Known-good first: no network, and a provider outage should not block a
  // publish on a model the platform already ships.
  const known = findModel(trimmed);
  if (known) {
    return { model: { id: known.id, tier: known.tier, label: known.label, costPerM: null } };
  }

  let models: Map<string, ProviderModel>;
  try {
    models = await providerModels();
  } catch (e) {
    return {
      error:
        `Could not reach the model provider to check "${trimmed}", so it cannot be ` +
        `published yet. Try again shortly, or pick one of the built-in models.`,
    };
  }

  const found = models.get(trimmed);
  if (!found) {
    return {
      error:
        `"${trimmed}" is not a model the provider serves. Check the id against ` +
        `openrouter.ai/models — it must be the full "vendor/model" form.`,
    };
  }

  const prompt = Number(found.pricing?.prompt) * 1e6;
  const completion = Number(found.pricing?.completion) * 1e6;
  if (!Number.isFinite(prompt) || !Number.isFinite(completion)) {
    return {
      error:
        `"${trimmed}" has no published price, so the platform cannot work out ` +
        `which tier it belongs in. Pick a model with public pricing.`,
    };
  }

  return {
    model: {
      id: trimmed,
      tier: tierForPricing(prompt, completion),
      label: found.name || trimmed,
      costPerM: Number((0.75 * prompt + 0.25 * completion).toFixed(4)),
    },
  };
}
