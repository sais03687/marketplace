"""A plan sent as a list must not kill the run.

`plan` is a `str` on AgentState and the prompt asks for a string, but the model
sometimes sends the steps as a JSON list instead — a formatting choice, not a
failure: the analysis around it is fine.

Pydantic does not validate on assignment, so `state.plan = [...]` inside
reason_and_act succeeds and looks harmless. The cost is paid one super-step
later, when LangGraph rebuilds the state from the node's update and *does*
validate: ValidationError out of `graph.ainvoke`, into the adapter's catch-all,
whole run gone. Benchmark task T03 died this way on 2026-08-13 having already
done the work.

The run is worth more than the plan — the plan is only read by the model's own
next turn — so anything unreadable falls back to the previous one rather than
taking the message down with it.
"""
import io
from pathlib import Path

import pytest
from pydantic import ValidationError

from creator.agent import AgentState, _as_plan_text

AGENT_SRC = (Path(__file__).resolve().parents[1] /
             "agents" / "data-analyst" / "agent.py")


# ── the crash itself: the shape that reaches the state schema ──────────────

def test_a_list_plan_really_does_break_the_state():
    # If this ever stops raising, the coercion below is no longer load-bearing
    # and this whole file can go. Until then it is the reason for it.
    with pytest.raises(ValidationError):
        AgentState(plan=["read the file", "compute retention"])


@pytest.mark.parametrize("shape", [
    ["read the file", "compute retention"],
    {"steps": ["read the file"]},
    None,
    12,
    [],
    [None, "  "],
])
def test_whatever_shape_arrives_the_state_still_builds(shape):
    plan = _as_plan_text(shape, "the previous plan")
    assert isinstance(plan, str)
    AgentState(plan=plan)  # must not raise


# ── and the plan still says what it said ───────────────────────────────────

def test_a_string_plan_is_passed_through_untouched():
    assert _as_plan_text("1. read the file", "fallback") == "1. read the file"


def test_a_list_of_steps_survives_as_numbered_text():
    out = _as_plan_text(["read the file", "compute retention"], "fallback")
    assert "read the file" in out and "compute retention" in out
    assert out.splitlines() == ["1. read the file", "2. compute retention"]


def test_a_missing_plan_keeps_the_one_we_had():
    # The model omitting `plan` on a turn is normal and must not wipe it: the
    # next turn is prompted with whatever is on the state.
    assert _as_plan_text(None, "step 3 of 4: build the workbook") == \
        "step 3 of 4: build the workbook"


def test_an_empty_list_keeps_the_one_we_had_too():
    # "" would be worse than the stale plan — the model loses its own thread.
    assert _as_plan_text([], "step 3 of 4") == "step 3 of 4"


def test_a_dict_plan_is_kept_rather_than_discarded():
    # Not pretty, but it is the model's own words, and readable enough to be
    # worth more to the next turn than the plan before it.
    out = _as_plan_text({"next": "compute retention"}, "fallback")
    assert "compute retention" in out


# ── the assignment site, so a refactor cannot quietly undo this ────────────

def test_the_plan_assignment_still_goes_through_the_coercion():
    src = io.open(AGENT_SRC, encoding="utf-8").read()
    assert "state.plan = _as_plan_text(" in src, (
        "state.plan is being assigned model output directly again; a list-shaped "
        "plan will kill the run at the next super-step"
    )
    assert 'state.plan = state.analysis.get("plan"' not in src
