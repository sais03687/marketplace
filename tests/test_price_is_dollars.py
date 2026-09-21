"""Everything a person types about price is dollars.

The same upload route accepted both units. Its form field parsed a dollar figure
and multiplied by 100; the manifest on the same request was read as cents. So 29
and 2900 both meant $29, depending which door a creator came through — and the
docs said "USD cents" one clause before quoting the minimums as "$29".

Dollars now, converted once on the way in. Cents survive only past that line,
because Stripe charges in them and the tier floors are written in them.

The guard matters as much as the change: a creator with the old habit types 2900,
and without a check that is a hundredfold overcharge that nothing notices until a
buyer is billed.
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VALIDATE = ROOT / "packages" / "agent-package-schema" / "src" / "validate.ts"
UPLOAD = ROOT / "apps" / "web" / "app" / "api" / "packages" / "upload" / "route.ts"
VERSIONS = ROOT / "apps" / "web" / "app" / "api" / "agents" / "[slug]" / "versions" / "route.ts"
DOCS = ROOT / "apps" / "web" / "app" / "(public)" / "docs" / "creators" / "page.tsx"
PUBLISH = ROOT / "apps" / "web" / "app" / "(auth)" / "creator" / "publish" / "page.tsx"
MANIFEST = ROOT / "agents" / "data-analyst" / "marketplace.json"


def test_the_manifest_is_converted_on_the_way_in():
    src = UPLOAD.read_text(encoding="utf-8")
    assert "(manifest.pricePerMonth as number) * 100" in src


def test_both_doors_of_the_upload_now_agree():
    # The form always multiplied; the manifest did not. Same route, same price,
    # two answers.
    src = UPLOAD.read_text(encoding="utf-8")
    assert src.count("* 100") >= 2


def test_publishing_a_version_converts_too():
    src = VERSIONS.read_text(encoding="utf-8")
    assert "versionPriceDollars * 100" in src


def test_a_cents_figure_is_refused_with_the_dollar_amount_spelled_out():
    src = VALIDATE.read_text(encoding="utf-8")
    assert "manifest.pricePerMonth > 2000" in src
    assert "in whole dollars" in src
    # And it says what they probably meant, rather than only that they are wrong.
    assert "If you meant" in src


def test_fractional_dollars_are_refused():
    # Whole dollars keeps the conversion exact and matches every tier floor.
    src = VALIDATE.read_text(encoding="utf-8")
    assert "Number.isInteger(manifest.pricePerMonth)" in src


def test_the_docs_no_longer_say_cents():
    docs = DOCS.read_text(encoding="utf-8")
    assert "USD cents" not in docs
    assert "write 29, not 2900" in docs


def test_the_shipped_manifest_was_converted():
    # Left at 5900 it would have published at $5,900/month.
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    assert manifest["pricePerMonth"] == 59


def test_the_publish_form_stops_dividing_a_dollar_figure():
    src = PUBLISH.read_text(encoding="utf-8")
    assert "pricePerMonth / 100" not in src, \
        "the manifest is dollars now; dividing shows $0.59 for a $59 agent"


def test_the_floors_stay_in_cents_where_stripe_needs_them():
    # Not everything becomes dollars. The internal figures Stripe is charged in
    # are deliberately untouched, and this records that it was a decision.
    pricing = (ROOT / "apps" / "web" / "lib" / "agent-pricing.ts").read_text(encoding="utf-8")
    assert "MIN_PRICE_CENTS" in pricing
    assert re.search(r"STANDARD:\s*2900", pricing)
