"""Creators see how buyers respond to their agents — without seeing buyer data.

The creator analytics surface turns a raw approval count into an outcome
breakdown (approved / edited / rejected / expired) plus which task types get
rejected most. That is genuine quality feedback. But approvals belong to the
buyer's tenant: the draft, the reasoning, and the rejection reason are all
buyer-authored. A creator learning "buyers rejected drive_upload 4x" is fair
feedback; a creator reading the buyer's words is a cross-tenant leak. These pin
that the aggregation stays counts-only.
"""
from pathlib import Path

ROUTE = (
    Path(__file__).resolve().parents[1]
    / "apps" / "web" / "app" / "api" / "creator" / "analytics" / "route.ts"
).read_text(encoding="utf-8")


def test_outcomes_are_computed_and_returned():
    assert "outcomes: overall" in ROUTE
    for bucket in ("approved", "edited", "rejected", "expired"):
        assert bucket in ROUTE


def test_only_safe_columns_are_selected_from_approvals():
    # The one findMany over approvals must select exactly the non-sensitive fields.
    idx = ROUTE.index("prisma.approval.findMany")
    block = ROUTE[idx: idx + 400]
    assert "select:" in block
    assert "deploymentId: true" in block
    assert "status: true" in block
    assert "taskType: true" in block


def test_no_buyer_authored_text_is_ever_selected():
    # Buyer-tenant free text must never be selected or read. Check the actual
    # findMany select block and any property access, not prose in comments (the
    # comment deliberately names these fields to explain why they are excluded).
    idx = ROUTE.index("prisma.approval.findMany")
    select_block = ROUTE[idx: idx + 400]
    for leaky in ("rejectionReason", "draft", "reasoning", "originalRequest", "editDiff"):
        assert f"{leaky}: true" not in select_block, f"must not select {leaky}"
        assert f"r.{leaky}" not in ROUTE, f"must not read r.{leaky}"


def test_rejections_are_attributed_per_task_type_not_per_buyer():
    # We expose WHICH action type is rejected (creator-defined), not who rejected it.
    assert "topRejectedTasks" in ROUTE
    assert "resolvedBy" not in ROUTE
