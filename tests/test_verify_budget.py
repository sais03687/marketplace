"""Measuring a gap and being able to fix it are different questions.

Email can afford a rebuild — the requester is waiting on a message either way.
A chat cannot: someone is watching the window, and two extra model turns of
silence costs more than it buys. So the budget is per-run, and a channel with
none still gets the measurement.
"""
import ast
import io
from pathlib import Path

import pytest
from creator import agent


RUNTIME = (Path(__file__).resolve().parents[1] /
           "apps" / "provisioning-service" / "src" / "templates" / "runtime" / "adapter.py")


def _call_sites():
    """Every place the platform starts or resumes the agent, with its kwargs."""
    src = io.open(RUNTIME, encoding="utf-8").read()
    tree = ast.parse(src)
    sites = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and getattr(node.func, "id", "") in ("run_agent", "resume_agent"):
            kw = {k.arg: k for k in node.keywords if k.arg}
            window = "\n".join(src.splitlines()[max(0, node.lineno - 40):node.lineno])
            sites.append({
                "line": node.lineno,
                "channel": "teams" if 'f"teams:' in window else "email",
                "verify_fn": "verify_fn" in kw,
                "attempts": (ast.unparse(kw["verify_attempts"].value)
                             if "verify_attempts" in kw else None),
            })
    return sites


def test_every_run_gets_the_deliverable_check():
    # Both Teams call sites omitted it entirely, so nothing checked whether a
    # chat reply's figures were in the file it attached.
    missing = [s for s in _call_sites() if not s["verify_fn"]]
    assert not missing, f"call sites without verify_fn: {missing}"


def test_at_least_one_call_site_per_channel_is_covered():
    channels = {s["channel"] for s in _call_sites()}
    assert channels == {"email", "teams"}


def test_chat_measures_but_never_loops():
    for site in _call_sites():
        if site["channel"] == "teams":
            assert site["attempts"] == "0", f"line {site['line']} would stall a chat"


def test_email_keeps_its_rebuild_budget():
    for site in _call_sites():
        if site["channel"] == "email":
            assert site["attempts"] is None, (
                f"line {site['line']} overrides the default; email can afford a rebuild"
            )


# ── the budget is honoured, and a zero budget still measures ────────────────

class _State:
    """Only what verify_deliverables and its router read."""
    def __init__(self, budget):
        self.content = ("Q3 by region.\nNorth 132400 -> 146050, 943 units\n"
                        "South 109950 -> 128100, 838 units")
        self.action_results = [
            '{"stdout": "[{\\"Units Sold\\":942.9881198347},{\\"Units Sold\\":838.0217192202}]"}'
        ]
        self.max_verify_attempts = budget
        self.rebuild_attempts = 0
        self.rebuilt_figures = []
        self.rebuild_unfixable = False
        self.deliverable_gaps = []
        self.deliverable_unfixable = False
        self.superlative_claims = []
        self.superlative_attempts = 0
        self.superlative_unfixable = False
        self.verify_attempts = 0
        self.iteration = 1
        self.max_iterations = 12
        self.context = {}
        self.analysis = {}



def _verify(state):
    import asyncio
    return asyncio.run(agent.verify_deliverables(state))


def test_drift_is_measured_even_with_no_budget_to_fix_it():
    state = _verify(_State(budget=0))
    assert state.rebuilt_figures, "a chat still needs to know the figure is wrong"
    assert state.rebuild_unfixable is True
    assert state.rebuild_attempts == 0, "nothing was handed back"


def test_a_zero_budget_run_is_not_sent_round_again():
    state = _verify(_State(budget=0))
    assert agent.route_after_verify(state) == "finalize"


def test_with_budget_the_agent_is_sent_back_to_fix_it():
    state = _verify(_State(budget=2))
    assert state.rebuilt_figures
    assert state.rebuild_unfixable is False
    assert state.rebuild_attempts == 1
    assert agent.route_after_verify(state) == "reason_and_act"


def test_unfixable_drift_is_flagged_to_the_reader():
    state = _verify(_State(budget=0))
    state.analysis = {"final_response": {"action": "reply_email",
                                         "text": "North sold 942.99 units."}}
    import asyncio
    asyncio.run(agent.finalize(state))
    text = state.result["text"]
    assert "942.9881198347 should be 943" in text or "should be 943" in text
    assert "check these before using them" in text
