"""A message to the manager is never held for the manager's approval.

On 2026-10-08 a buyer on policy=always emailed the agent a follow-up question
and had to click Approve before the answer reached them. The manager is the
person who approves, so holding mail addressed to them only asks them to approve
reading it. Every other recipient still follows the buyer's policy.
"""
import pytest

import adapter

MANAGER = "sai@agents.agentstore.it.com"


@pytest.fixture
def policy(monkeypatch):
    def set_policy(name, auto=(), require=()):
        monkeypatch.setattr(adapter, "_manager_email", lambda: MANAGER)
        monkeypatch.setattr(
            adapter,
            "_load_policy",
            lambda: {
                "policy": name,
                "riskThreshold": 6.0,
                "autoApprove": list(auto),
                "requireApproval": list(require),
            },
        )
        monkeypatch.setattr(adapter, "COMPANY_DOMAIN", "acme.com")

    return set_policy


@pytest.mark.parametrize("name", ["always", "external-only", "risk-based", "never"])
def test_the_manager_is_never_asked_to_approve_their_own_reply(policy, name):
    policy(name)
    needs, reason = adapter._should_require_approval(MANAGER, {"combined": 9.0})
    assert needs is False
    assert "manager" in reason


def test_the_manager_is_matched_from_a_display_name_header(policy):
    policy("always")
    needs, _ = adapter._should_require_approval(f"Sai Suram <{MANAGER.upper()}>")
    assert needs is False


def test_a_colleague_still_waits_under_always(policy):
    policy("always")
    needs, reason = adapter._should_require_approval("colleague@acme.com")
    assert needs is True
    assert reason == "policy=always"


def test_an_outsider_still_waits_under_external_only(policy):
    policy("external-only")
    needs, _ = adapter._should_require_approval("someone@gmail.com")
    assert needs is True


def test_a_colleague_is_still_auto_approved_under_external_only(policy):
    policy("external-only")
    needs, _ = adapter._should_require_approval("colleague@acme.com")
    assert needs is False


def test_an_address_that_only_contains_the_managers_is_not_the_manager(policy):
    policy("always")
    needs, _ = adapter._should_require_approval("x" + MANAGER)
    assert needs is True


def test_an_empty_recipient_still_fails_safe(policy):
    policy("never")
    needs, _ = adapter._should_require_approval("")
    assert needs is True
