"""One broken hire must not become two charges — or even one.

Before 2026-09-24 the money moved first and nothing checked the outcome:

  * checkout charged immediately ("buyer pays before provisioning starts"),
  * provisioning could fail and still leave the deployment looking fine,
  * firing only set cancel_at_period_end, so the month already paid stayed paid,
  * and the provision job guards on status === PROVISIONING, which nothing ever
    set back — so the only way forward was to hire again, on a second
    subscription.

A real hire went through that exact sequence: $29 taken for an agent whose
mailbox was never built.

Now: checkout opens a one-day trial, a failed hire marks the subscription to
lapse inside that trial, and a retry resumes the same subscription instead of
starting another.
"""
import io
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "apps" / "web"
HIRE = (WEB / "app" / "api" / "deployments" / "route.ts").read_text(encoding="utf-8")
FAILED = (WEB / "app" / "api" / "deployments" / "[id]" / "provisioning-failed" / "route.ts").read_text(encoding="utf-8")
RETRY = (WEB / "app" / "api" / "deployments" / "[id]" / "retry" / "route.ts").read_text(encoding="utf-8")
WORKER = (ROOT / "apps" / "provisioning-service" / "src" / "worker.ts").read_text(encoding="utf-8")
PANEL = (WEB / "components" / "dashboard" / "setup-failed-panel.tsx").read_text(encoding="utf-8")


def test_checkout_does_not_charge_before_the_agent_exists():
    assert "trial_period_days: 1" in HIRE
    # Still a subscription, so billing starts by itself once the trial ends.
    assert 'mode: "subscription"' in HIRE


def test_a_failed_hire_stops_the_subscription():
    assert "cancel_at_period_end: true" in FAILED
    # Cancelling outright would force a second subscription on retry, which is
    # the thing being prevented.
    assert "subscriptions.cancel(" not in FAILED


def test_the_failure_endpoint_is_authenticated():
    assert "PROVISIONING_SECRET" in FAILED
    assert "tokensMatch(presented, secret)" in FAILED
    assert 'jsonError("Unauthorized", 401)' in FAILED


def test_the_reason_is_recorded_where_the_dashboard_reads_it():
    assert "provisioningLog.create" in FAILED
    assert '"failed"' in FAILED


def test_provisioning_reports_its_failures_to_the_marketplace():
    assert "reportProvisioningFailure" in WORKER
    assert "provisioning-failed" in WORKER
    # Only once BullMQ has stopped retrying, or a run that later succeeds would
    # have told the buyer it failed.
    assert "isFinalAttempt" in WORKER
    # A broken notification must not replace the error it reports.
    block = WORKER[WORKER.index("async function reportProvisioningFailure"):]
    block = block[: block.index("\n}\n")]
    assert "catch" in block


def test_retry_reuses_the_subscription_rather_than_making_one():
    assert "cancel_at_period_end: false" in RETRY
    assert "checkout.sessions.create" not in RETRY, "a retry must never open a new checkout"
    assert "does not charge you again" in PANEL


def test_retry_only_applies_to_a_failed_hire():
    for status in ('"FIRED"', '"PROVISIONING"', '"ERROR"'):
        assert status in RETRY
    assert "Only a failed setup can be retried" in RETRY


def test_retry_puts_the_status_back_if_it_cannot_enqueue():
    block = RETRY[RETRY.index("getProvisioningQueue()"):]
    assert 'data: { status: "ERROR" }' in block, (
        "a failed enqueue would strand the deployment in PROVISIONING, where the "
        "retry button refuses to run"
    )


def test_the_buyer_is_told_setup_failed():
    assert "Setup did not finish" in PANEL
    assert "cannot receive or send email" in PANEL
    assert "have not been charged" in PANEL
