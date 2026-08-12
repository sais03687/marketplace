/**
 * Invariants for the model catalogue.
 *
 * The catalogue is the single place where a creator's model pick turns into a
 * price floor, a set of runtime budgets, and a provider credential. Each of
 * those is a promise to somebody — the buyer pays the floor, the platform pays
 * the bill — so the mapping has to hold in both directions.
 *
 * Run: node scripts/check-model-catalogue.mjs
 */
import {
  MODEL_CATALOGUE,
  VALID_MODEL_IDS,
  PROVIDER_CREDENTIALS,
  findModel,
  tierForModel,
  modelIdsForTier,
  validateManifest,
} from "../packages/agent-package-schema/dist/index.js";
import { minPriceFor, MIN_PRICE_CENTS } from "../apps/web/lib/agent-pricing.ts";

let failures = 0;
function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const TIERS = ["haiku", "sonnet", "opus"];

console.log("catalogue shape");
check("catalogue is not empty", MODEL_CATALOGUE.length > 0);
check(
  "every id is unique",
  new Set(MODEL_CATALOGUE.map((m) => m.id)).size === MODEL_CATALOGUE.length,
);
check(
  "every tier is one the DB enum knows",
  MODEL_CATALOGUE.every((m) => TIERS.includes(m.tier)),
  MODEL_CATALOGUE.filter((m) => !TIERS.includes(m.tier)).map((m) => m.id).join(", "),
);
check(
  "every provider has a credential",
  MODEL_CATALOGUE.every((m) => PROVIDER_CREDENTIALS[m.provider]),
);
check(
  "every id uses the vendor/model form the aggregator needs",
  MODEL_CATALOGUE.every((m) => /^[\w.-]+\/[\w.:-]+$/.test(m.id)),
);

console.log("\nevery tier is buyable");
for (const tier of TIERS) {
  // A tier with no model is a price floor nobody can reach: the publish wizard
  // would offer it and every pick would be rejected.
  check(`${tier} offers at least one model`, modelIdsForTier(tier).length > 0);
  check(`${tier} has a price floor`, typeof MIN_PRICE_CENTS[tier.toUpperCase()] === "number");
}

console.log("\nlookups agree with each other");
for (const entry of MODEL_CATALOGUE) {
  check(`${entry.id} → ${entry.tier}`, tierForModel(entry.id) === entry.tier);
  check(`${entry.id} is in VALID_MODEL_IDS`, VALID_MODEL_IDS.has(entry.id));
  check(`${entry.id} round-trips through findModel`, findModel(entry.id)?.id === entry.id);
  check(
    `${entry.id} floor is its tier's floor`,
    minPriceFor(entry.tier) === MIN_PRICE_CENTS[entry.tier.toUpperCase()],
  );
}

console.log("\nunknown picks do not get defaulted");
// Guessing a tier here would land on a price floor, and a wrong floor is either
// a creator overcharged or a buyer undercharged.
check("unknown id has no tier", tierForModel("acme/does-not-exist") === null);
check("null id has no tier", tierForModel(null) === null);
check("unknown id is not in the set", !VALID_MODEL_IDS.has("acme/does-not-exist"));

console.log("\nmanifest validation");
const base = {
  name: "Test", slug: "test-agent", tagline: "t", description: "d",
  category: "FINANCE_OPS", version: "1.0.0", pricePerMonth: 5900,
  modelTier: "sonnet",
  capabilities: [{ name: "c", description: "d" }],
  requiredTools: [], requiredIntegrations: [], onboardingDurationDays: 1,
  autonomyDefaults: {},
};
const errsFor = (m) => validateManifest(m).filter((e) => e.field === "model");

check("a manifest with no model still validates", errsFor(base).length === 0);
check(
  "a catalogue model validates",
  errsFor({ ...base, model: MODEL_CATALOGUE[0].id }).length === 0,
);
check(
  "an unknown model is rejected",
  errsFor({ ...base, model: "acme/does-not-exist" }).length === 1,
);
check(
  "a non-string model is rejected",
  errsFor({ ...base, model: 42 }).length === 1,
);

console.log(
  failures === 0
    ? `\nAll checks passed (${MODEL_CATALOGUE.length} models).`
    : `\n${failures} check(s) FAILED.`,
);
process.exit(failures === 0 ? 0 : 1);
