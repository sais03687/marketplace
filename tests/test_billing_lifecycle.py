"""A routine renewal must not un-pause an agent the buyer chose to pause.

Pausing an agent does not pause its Stripe subscription — the buyer is credited
for the paused time, but invoices still create and pay every cycle. So
invoice.paid fires for a paused agent routinely, and if it resumed on status
alone it would silently undo a buyer's deliberate pause. It must resume only a
pause THIS system applied for non-payment, distinguished by the billing-reason
marker.
"""
from pathlib import Path

HOOK = (
    Path(__file__).resolve().parents[1]
    / "apps" / "web" / "app" / "api" / "webhooks" / "stripe" / "route.ts"
).read_text(encoding="utf-8")


def test_billing_pause_reason_is_a_shared_constant():
    # One definition, used by both the write and the check, so they cannot drift.
    assert "const BILLING_PAUSE_REASON" in HOOK
    assert HOOK.count("Payment failed — please update your billing details") == 1


def test_payment_failed_pauses_with_the_marker():
    block = HOOK[HOOK.index('case "invoice.payment_failed"'):]
    block = block[: block.index('case "customer.subscription.deleted"')]
    assert "reason: BILLING_PAUSE_REASON" in block


def test_invoice_paid_only_resumes_a_billing_pause():
    block = HOOK[HOOK.index("case \"invoice.paid\""):]
    block = block[: block.index("case \"customer.subscription.deleted\"")]
    # The guard must require the billing marker, not merely PAUSED status.
    assert 'deployment.pauseReason === BILLING_PAUSE_REASON' in block
    assert 'deployment.status === "PAUSED"' in block


def test_duplicate_checkout_delivery_does_not_reprovision():
    # Regression guard for the documented at-least-once delivery incident.
    block = HOOK[HOOK.index("checkout.session.completed"):]
    assert 'status: "PENDING_PAYMENT"' in block
    assert "count === 0" in block
