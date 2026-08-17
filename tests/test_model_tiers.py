"""Tiers are price bands, and any model the provider serves can be published.

Two changes on 2026-08-17, and this file guards the arithmetic under both.

The tiers were named haiku / sonnet / opus, after one vendor's model line, while
the catalogue held Google and OpenAI models too — a creator picking Gemini 2.5
Pro declared "sonnet". They are now standard / pro / premium, which is what they
have always meant: a price floor of $29, $59 or $149.

And the catalogue was a closed list of eight against the four hundred the
provider serves. What that list was really protecting was the floor: the
platform pays the model bill on its own key, so an agent running a $75/M model
while charging $29 costs the platform the difference. The list is now a set of
known-good defaults, and the tier is derived from what the provider charges —
which keeps the floor honest without limiting the choice.

The thresholds were calibrated so that no catalogue model moved tier. That is
the property worth pinning: change a ceiling and an existing agent silently
changes price band.
"""
import io
import re
from pathlib import Path

import pytest

MODELS_TS = Path(__file__).resolve().parents[1] / "packages" / "agent-package-schema" / "src" / "models.ts"
SRC = io.open(MODELS_TS, encoding="utf-8").read()

# Published rates per million tokens, read off the provider on 2026-08-17.
# (prompt, completion, tier it must land in)
PRICED = {
    "openai/gpt-oss-120b":        (0.03,  0.17, "standard"),
    "openai/gpt-4.1-mini":        (0.40,  1.60, "standard"),
    "google/gemini-2.5-flash":    (0.30,  2.50, "standard"),
    "anthropic/claude-haiku-4.5": (1.00,  5.00, "standard"),
    "google/gemini-2.5-pro":      (1.25, 10.00, "pro"),
    "openai/gpt-4.1":             (2.00,  8.00, "pro"),
    "anthropic/claude-sonnet-5":  (2.00, 10.00, "pro"),
    "anthropic/claude-opus-5":    (5.00, 25.00, "premium"),
}


def _number(name: str) -> float:
    m = re.search(rf"{name}:\s*([0-9.]+)", SRC)
    assert m, f"{name} not found in models.ts"
    return float(m.group(1))


def _ceilings():
    block = SRC[SRC.index("TIER_COST_CEILINGS"):SRC.index("blendedCostPerM")]
    return (
        float(re.search(r"standard:\s*([0-9.]+)", block).group(1)),
        float(re.search(r"pro:\s*([0-9.]+)", block).group(1)),
    )


def _weights():
    m = re.search(r"return\s+([0-9.]+)\s*\*\s*promptPerM\s*\+\s*([0-9.]+)\s*\*\s*completionPerM", SRC)
    assert m, "the blended-cost formula changed shape"
    return float(m.group(1)), float(m.group(2))


def _tier_for(prompt: float, completion: float) -> str:
    w_in, w_out = _weights()
    std, pro = _ceilings()
    cost = w_in * prompt + w_out * completion
    if cost <= std:
        return "standard"
    if cost <= pro:
        return "pro"
    return "premium"


# ── the calibration ────────────────────────────────────────────────────────

@pytest.mark.parametrize("model", sorted(PRICED))
def test_no_catalogue_model_changes_tier(model):
    prompt, completion, expected = PRICED[model]
    assert _tier_for(prompt, completion) == expected, (
        f"{model} moved tier — a buyer's price floor moves with it"
    )


def test_the_weighting_favours_input():
    # These prompts are lopsided: rules, tools, memory and prior results go up
    # on every call and a short JSON object comes back. Weighting by output
    # would band a cheap-input, dear-output model above its real cost.
    w_in, w_out = _weights()
    assert w_in > w_out
    assert abs((w_in + w_out) - 1.0) < 1e-9, "the weights must be a blend, not a scale"


def test_the_bands_are_ordered_and_the_gaps_are_real():
    std, pro = _ceilings()
    assert 0 < std < pro


def test_the_cheapest_and_dearest_are_not_in_the_same_band():
    cheap = _tier_for(*PRICED["openai/gpt-oss-120b"][:2])
    dear = _tier_for(*PRICED["anthropic/claude-opus-5"][:2])
    assert cheap == "standard" and dear == "premium"


# ── the rename ─────────────────────────────────────────────────────────────

def test_the_tier_names_are_price_bands_not_model_names():
    assert '"standard" | "pro" | "premium"' in SRC


def test_the_retired_names_still_resolve():
    # Every manifest published before the rename declares one of these, and a
    # marketplace that rejects packages it previously accepted has broken the
    # one promise it makes to the people building on it.
    for old, new in (("haiku", "standard"), ("sonnet", "pro"), ("opus", "premium")):
        assert re.search(rf"{old}:\s*\"{new}\"", SRC), f"{old} no longer maps to {new}"


def test_no_catalogue_entry_still_carries_a_vendor_tier_name():
    for retired in ('tier: "haiku"', 'tier: "sonnet"', 'tier: "opus"'):
        assert retired not in SRC


def test_the_db_enum_matches_the_tier_names():
    schema = io.open(
        Path(__file__).resolve().parents[1] / "packages" / "db" / "prisma" / "schema.prisma",
        encoding="utf-8",
    ).read()
    enum = schema[schema.index("enum ModelTier"):].split("}")[0]
    for name in ("STANDARD", "PRO", "PREMIUM"):
        assert name in enum
    for retired in ("HAIKU", "SONNET", "OPUS"):
        assert retired not in enum


def test_the_migration_renames_rather_than_recreates():
    # RENAME VALUE keeps every row in place. Dropping and recreating the type
    # would need a backfill, and a missed row would hold a value the type no
    # longer has.
    migrations = (Path(__file__).resolve().parents[1] / "packages" / "db" / "prisma" / "migrations")
    sql = "\n".join(
        io.open(p, encoding="utf-8").read()
        for p in migrations.glob("*tier_names*/migration.sql")
    )
    assert "RENAME VALUE" in sql
    assert "DROP TYPE" not in sql.upper()


# ── the open catalogue ─────────────────────────────────────────────────────

def test_an_unlisted_model_is_no_longer_rejected_out_of_hand():
    validate = io.open(
        MODELS_TS.parent / "validate.ts", encoding="utf-8"
    ).read()
    assert "MODEL_ID_RE" in validate, "the manifest check should be shape-only now"
    assert "VALID_MODEL_IDS.has(manifest.model)" not in validate, (
        "a closed list here limits creators to eight of four hundred models"
    )


def test_the_resolver_refuses_a_model_with_no_published_price():
    # No price means no tier, and no tier means no floor — which is the hole the
    # closed list was covering.
    resolver = io.open(
        Path(__file__).resolve().parents[1] / "apps" / "web" / "lib" / "model-resolver.ts",
        encoding="utf-8",
    ).read()
    assert "no published price" in resolver
    assert "Number.isFinite" in resolver
