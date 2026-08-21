"""A buyer should see what their agent did — including where it failed.

The deployment page shows the pending approval queue and a liveness chip, but a
resolved action just vanished: a rejected or expired one left no trace, so a
buyer watching the queue never saw the agent's failures. This surfaces the recent
resolved outcomes, with rejected and expired called out as the failures they are.
It reads the buyer's OWN deployment approvals, so full detail is in-tenant and
safe.
"""
from pathlib import Path

PAGE = (
    Path(__file__).resolve().parents[1]
    / "apps" / "web" / "app" / "(auth)" / "dashboard" / "agents"
    / "[deploymentId]" / "page.tsx"
).read_text(encoding="utf-8")


def test_resolved_activity_is_surfaced_not_just_pending():
    assert "recentActivity" in PAGE
    # Built from the non-pending approvals, which were previously discarded.
    assert 'a.status !== "PENDING"' in PAGE
    assert "Recent activity" in PAGE


def test_failures_are_labelled_as_failures():
    # Expired and rejected are failures the buyer must be able to see and read as such.
    assert "EXPIRED" in PAGE and "no response in time" in PAGE
    assert "REJECTED" in PAGE and "Rejected" in PAGE


def test_activity_is_newest_first():
    # Sorted by when it resolved, falling back to when it was raised.
    assert "resolvedAt || " in PAGE
