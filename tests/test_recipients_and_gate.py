"""Who a reply goes to, and what needs a human first."""
import pytest
import adapter
from creator import agent


MANAGER = "manager@acme.com"

# /hooks/agent carries no message: no sender, no message_id, no subject, no
# thread. Onboarding, crons and scheduled work all arrive this way.
HOOK_CTX = {"hook_name": "onboarding", "session_key": "hook:onboarding"}
MAIL_CTX = {"hook_name": "AgentMail", "sender": "Sai Suram <sai@acme.com>",
            "message_id": "AAQk123", "subject": "Q3", "thread_id": "t1"}


# ── the reply that went nowhere ─────────────────────────────────────────────

def test_a_hook_run_with_no_recipient_reaches_the_owner():
    # Previously raised "no message_id and no fallback recipient available",
    # after the work was done. The buyer got nothing at all.
    assert adapter._reply_recipient({"to": None}, HOOK_CTX, "reply_email") == MANAGER


def test_a_fabricated_address_on_a_hook_reply_is_overridden():
    # A run addressed its confirmation to manager@acmecorp.com — an address that
    # exists nowhere, which the outbound boundary then refuses.
    got = adapter._reply_recipient({"to": "manager@acmecorp.com"}, HOOK_CTX, "reply_email")
    assert got == MANAGER


def test_a_placeholder_string_is_not_an_address():
    # Seen live: the model returned the literal "current_sender".
    assert adapter._reply_recipient({"to": "current_sender"}, HOOK_CTX, "reply_email") == MANAGER


def test_an_inbound_reply_answers_its_sender():
    assert adapter._reply_recipient({"to": None}, MAIL_CTX, "reply_email") == "sai@acme.com"


def test_an_inbound_reply_honours_an_explicit_recipient():
    # Redirecting a reply is legitimate, and the approval policy still shows it
    # to a human before it goes.
    got = adapter._reply_recipient({"to": "other@acme.com"}, MAIL_CTX, "reply_email")
    assert got == "other@acme.com"


def test_send_email_keeps_its_deliberate_recipient():
    # A cron mailing the team means that address; the boundary judges it.
    got = adapter._reply_recipient({"to": "colleague@acme.com"}, HOOK_CTX, "send_email")
    assert got == "colleague@acme.com"


@pytest.mark.parametrize("good", ["a@b.com", "x.y+z@sub.domain.co.uk"])
def test_deliverable_addresses_are_accepted(good):
    assert adapter._looks_deliverable(good) is True


@pytest.mark.parametrize("bad", ["", "not-an-address", "no at sign", "a@b",
                                 "a@@b.com", "@b.com", "a@.com", "a@b.", "a b@c.com"])
def test_undeliverable_candidates_fall_through(bad):
    assert adapter._looks_deliverable(bad) is False


# ── what needs a human ──────────────────────────────────────────────────────

ALWAYS = {"policy": "always"}
NEVER = {"policy": "never"}
EXTERNAL = {"policy": "external-only"}
RISK = {"policy": "risk-based", "riskThreshold": 6}

WRITES = ["drive_upload", "excel_write", "excel_append", "my_drive_upload", "calendar_delete"]


@pytest.mark.parametrize("action", WRITES)
def test_writes_are_gated_when_the_buyer_asked_to_be_asked(action):
    assert agent._needs_manager_approval(action, {}, ALWAYS) is True


@pytest.mark.parametrize("action", WRITES)
def test_never_actually_means_never(action):
    # A buyer on "fully autonomous" was still stopped on every upload, because
    # this gate was hardcoded and ran before the policy was ever consulted.
    assert agent._needs_manager_approval(action, {}, NEVER) is False


def test_external_only_still_reviews_writes():
    # It speaks about recipients, and a write has none.
    assert agent._needs_manager_approval("drive_upload", {}, EXTERNAL) is True


@pytest.mark.parametrize("score,expected", [(8, True), (6, True), (3, False)])
def test_risk_based_compares_against_the_threshold(score, expected):
    assert agent._needs_manager_approval("drive_upload", {"_risk_combined": score}, RISK) is expected


@pytest.mark.parametrize("params", [{}, {"_risk_combined": "n/a"}])
def test_an_unscored_action_fails_toward_the_human(params):
    # Absent data is not evidence of low risk.
    assert agent._needs_manager_approval("drive_upload", params, RISK) is True


def test_an_anonymous_link_is_gated_even_under_never():
    # "Stop interrupting me" is not consent to publish a file anyone can open.
    assert agent._needs_manager_approval("drive_create_link", {"scope": "anonymous"}, NEVER) is True


def test_an_organisation_link_proceeds_even_under_always():
    # Opening it requires a sign-in the buyer's own directory issued.
    assert agent._needs_manager_approval("drive_create_link", {"scope": "organization"}, ALWAYS) is False


def test_a_link_with_no_scope_keeps_the_gate():
    # my_drive_create_link defaults to anonymous; silence cannot open it.
    assert agent._needs_manager_approval("my_drive_create_link", {}, NEVER) is True


@pytest.mark.parametrize("action", ["drive_share", "my_drive_share"])
def test_sharing_with_named_people_is_always_reviewed(action):
    assert agent._needs_manager_approval(action, {"recipients": ["a@b.com"]}, NEVER) is True


@pytest.mark.parametrize("policy", [None, {}, {"policy": "banana"}])
def test_an_unreadable_policy_fails_toward_the_human(policy):
    assert agent._needs_manager_approval("drive_upload", {}, policy) is True


def test_reading_is_never_gated():
    assert agent._needs_manager_approval("drive_list", {}, ALWAYS) is False
