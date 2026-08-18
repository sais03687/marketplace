"""Do not ask permission for something the platform is going to ask about anyway.

E4 on 2026-08-18 made the manager approve one decision twice: the agent raised
`request_decision` asking "may I share reorder_list.xlsx with an external
recipient?", and then the platform blocked `drive_upload` and asked the same
question itself. Two emails, two clicks, one decision.

The agent was obeying. The prompt said, in its most emphatic paragraph, that an
action matching a "check with the manager" condition must go through
`request_decision` first — and "sharing externally needs approval" is exactly
such a condition. Two other rules told it the opposite ("asking for permission
is not something you do"), so the instructions contradicted each other and the
loudest one won.

The paragraph now splits on what the manager's answer would change: what you do,
or only whether you are allowed. Only the first is a question.

These tests do not prove the model obeys — no test of a prompt can. They pin the
distinction against being edited back out, and they guard the part that must not
soften: a hard boundary is still absolute, and no platform gate has moved.
"""
import io
from pathlib import Path

import pytest

AGENT = Path(__file__).resolve().parents[1] / "agents" / "data-analyst" / "agent.py"
SRC = io.open(AGENT, encoding="utf-8").read()
ADAPTER = (
    Path(__file__).resolve().parents[1]
    / "apps" / "provisioning-service" / "src" / "templates" / "runtime" / "adapter.py"
)


def test_the_prompt_no_longer_orders_a_permission_question():
    assert "use `request_decision` to check with the manager first" not in SRC, (
        "this is the line that produced the double gate; it told the agent to ask "
        "for permission the platform was about to ask for itself"
    )


def test_the_distinction_is_stated():
    assert "what the manager's answer would change" in SRC
    assert "whether you are allowed" in SRC
    assert "do not ask" in SRC


def test_the_agent_is_told_the_platform_will_ask_on_its_behalf():
    # Without this the new rule reads as "share freely", which is not the point.
    assert "pauses you, asks the manager, and resumes you automatically" in SRC


# ── what must not have softened ────────────────────────────────────────────

def test_a_hard_boundary_is_still_absolute():
    assert "hard boundary, do NOT do it under any circumstances" in SRC


def test_the_manager_rules_are_still_binding():
    assert "rules set by YOUR manager. You MUST follow them." in SRC


def test_request_decision_still_exists_for_real_questions():
    # The change narrows when to ask, and must not remove the ability to.
    assert "request_decision" in SRC
    assert "genuine ambiguity" in SRC or "need the manager's judgment" in SRC


def test_no_platform_gate_was_removed():
    """The safety property must not depend on the agent having asked first.

    That is the whole reason this was fixed in the prompt rather than by
    collapsing the gate: the platform stops these actions whatever the agent
    does, and it still must.
    """
    adapter = io.open(ADAPTER, encoding="utf-8").read()
    assert "verify_fn=verify_deliverables" in adapter
    gate = SRC[SRC.index("def _needs_manager_approval"):][:4000]
    for gated in ("drive_upload", "drive_create_link"):
        assert gated in gate, f"{gated} is no longer gated by the agent's own check"


def test_the_external_sharing_boundary_is_untouched():
    assert "You can only START a conversation with, or share a file with, people" in SRC


@pytest.mark.parametrize(
    "rule",
    [
        # The two rules that were arguing with the paragraph that changed. They
        # now agree with it, and all three saying the same thing is the point.
        "If the action is blocked, the approval system will handle it automatically.",
        "Asking for permission is not something you do",
    ],
)
def test_the_rules_that_already_said_this_are_still_there(rule):
    assert rule in SRC
