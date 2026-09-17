"""A question the agent stops to ask must actually be asked.

Benchmark task T12 on 2026-09-16 — "Who are my top performers?" over a table
where revenue, growth and margin each name a different rep. Turn 1 read the
request correctly:

    "the request does not specify which metric defines 'top performer' ... This
     ambiguity requires clarification before I can create the workbook"

and emitted a `reply_email` asking which was meant. The buyer never received it.
Turn 2's reasoning carried no memory of the question and picked revenue on its
own — the silent assumption the question existed to prevent, caused by losing
the question rather than by failing to ask it.

`execute_action` does not send. It records "the platform will send it after this
iteration", and only `finalize` packages a mid-run email into `state.result`.
But `route_after_execution` returned `reason_and_act` for everything except an
approved action, so finalize never ran on that iteration, the next turn
overwrote `state.analysis`, and the message went with it. The branch in finalize
that handles this case had never executed.

The model is told not to re-emit the action ("emitting this action again will
not produce one"), so it cannot recover from this on its own.

Same family as `test_composed_reply_survives`: the work was done, the words were
written, and something a few lines from the send threw them away.
"""
import io
from pathlib import Path

import pytest

from creator import agent

AGENT_SRC = io.open(
    Path(__file__).resolve().parents[1] / "agents" / "data-analyst" / "agent.py",
    encoding="utf-8",
).read()


def _state(analysis: dict, context: dict | None = None) -> "agent.AgentState":
    return agent.AgentState(analysis=analysis, context=context or {})


@pytest.mark.parametrize("action_type", ["reply_email", "send_email"])
def test_midrun_email_routes_to_finalize(action_type):
    """The node that sends is the only node that must not be skipped."""
    state = _state(
        {
            "completed": False,
            "action": {"type": action_type, "params": {"to": "sai@example.com"}},
        }
    )
    assert agent.route_after_execution(state) == "finalize", (
        "a mid-run email routed anywhere but finalize is never sent, and the "
        "model is told not to emit it again"
    )


def test_the_t12_question_would_now_be_sent():
    """The exact shape that was lost, as the model emitted it."""
    state = _state(
        {
            "completed": False,
            "action": {
                "type": "reply_email",
                "params": {
                    "to": "sai@agents.agentstore.it.com",
                    "subject": "[Re: T12] Clarification on Top Performer Metric",
                    "text": "Which metric defines a top performer?",
                },
            },
        }
    )
    assert agent.route_after_execution(state) == "finalize"


def test_ordinary_action_still_continues_the_loop():
    """Nothing else changes: a tool call goes back to reasoning as before."""
    state = _state(
        {"completed": False, "action": {"type": "mcp_call", "params": {}}}
    )
    assert agent.route_after_execution(state) == "reason_and_act"


def test_approved_action_still_wraps_up_first():
    """The post-approval path predates this and must keep winning."""
    state = _state(
        {"completed": False, "action": {"type": "reply_email", "params": {}}},
        {"_approved_action_executing": True},
    )
    assert agent.route_after_execution(state) == "wrap_up", (
        "an approved write needs the composing pass; finalize packages no reply"
    )


def test_completed_email_is_not_diverted():
    """completed=true is finalize's normal business, not the mid-run branch."""
    state = _state(
        {"completed": True, "action": {"type": "reply_email", "params": {}}}
    )
    assert agent.route_after_execution(state) != "finalize"


def test_finalize_still_packages_the_midrun_email():
    """The receiving half. Dead code until this fix; it must stay."""
    assert (
        'if action.get("type") in ("send_email", "reply_email") and not analysis.get("completed"):'
        in AGENT_SRC
    ), "finalize's mid-run email branch is what routing to finalize relies on"
