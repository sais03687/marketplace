"""The billing page has to say when the buyer is next charged.

"Next Billing" was a column of em-dashes. The API read current_period_end off
the subscription, and Stripe moved that field onto the subscription *item* in
its 2025 API versions, so it was undefined on every row — a buyer could not tell
when their next charge was, and after the trial change could not tell that they
had not been charged at all yet.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
API = (ROOT / "apps" / "web" / "app" / "api" / "company" / "billing" / "route.ts").read_text(encoding="utf-8")
PAGE = (ROOT / "apps" / "web" / "app" / "(auth)" / "dashboard" / "billing" / "page.tsx").read_text(encoding="utf-8")


def test_the_period_end_is_read_from_the_item_first():
    assert "(item as any)?.current_period_end" in API, (
        "Stripe's 2025 API versions carry current_period_end on the subscription item"
    )
    # Older API versions still answer on the subscription, so keep the fallback.
    assert "(sub as any).current_period_end" in API


def test_the_trial_end_is_returned():
    assert "trial_end" in API
    # Every branch returns the same shape, or the column breaks on the fallback.
    assert API.count("trialEnd") >= 3


def test_a_trialing_subscription_says_it_is_free_so_far():
    assert "Free until" in PAGE
    assert "sub.trialEnd" in PAGE
    # And a trial that has already ended falls back to the real billing date.
    assert "new Date(sub.trialEnd) > new Date()" in PAGE
