"""Data Analyst v6: every figure traces to a source, and stated limits get an answer.

Built from replies the agent actually sent on 2026-10-17. The bad ones must be
caught; the good ones must pass untouched, because a check that flags correct
answers teaches readers to ignore it.
"""
import asyncio
import json

from creator import agent

SALES = """## THE REQUEST — this is the only thing to act on

Which region grew fastest from Q1 to Q4, and what was total annual revenue?

region, q1, q2, q3, q4
North, 120000, 131000, 128000, 150000
South, 98000, 97000, 105000, 101000
East, 143000, 150000, 162000, 171000
West, 87000, 99000, 118000, 124000"""

SANDBOX = [{"stdout": "West 42.5287 North 25.0 East 19.5804 South 3.0612\ntotal 1984000\n"
                      "abs growth West 37000 North 30000 East 28000 South 3000", "returncode": 0}]


def _state(content, results):
    return agent.AgentState(content=content, action_results=results)


def _finalize(content, results, text, check):
    state = _state(content, results)
    state.analysis = {"completed": True, "action": {"type": "none"},
                      "final_response": {"action": "reply_email", "to": "boss@x.com", "text": text, "check": check}}
    return asyncio.run(agent.finalize(state)).result


def test_the_wrong_caveat_is_dropped_and_the_right_answer_kept():
    # The D1 caveat claimed North led on dollar growth at +$30,000 with "+$29,500"
    # style arithmetic the run never did; here, a figure no step produced.
    out = _finalize(SALES, SANDBOX,
                    "West grew fastest (+42.5%). Total annual revenue was $1,984,000.",
                    ["Ranked by dollar growth, North leads with +$31,500 instead."])
    assert out["text"].startswith("West grew fastest")
    assert not any("31,500" in c for c in out["check"]), out["check"]


def test_a_computed_alternative_survives():
    out = _finalize(SALES, SANDBOX,
                    "West grew fastest (+42.5%). Total annual revenue was $1,984,000.",
                    ["Ranked by dollar growth instead, West still leads with +$37,000; North is second at +$30,000."])
    assert any("37,000" in c for c in out["check"])
    assert not any("couldn't trace" in c for c in out["check"])


def test_an_untraced_figure_in_the_answer_is_named_not_deleted():
    out = _finalize(SALES, SANDBOX, "West grew fastest (+42.5%). Revenue was $2,050,000.", [])
    assert "$2,050,000" in out["text"], "the answer itself is never edited"
    assert any("2,050,000" in c and "unverified" in c for c in out["check"])


def test_rounding_and_separators_still_trace():
    out = _finalize(SALES, SANDBOX, "West: +42.53%, East +19.6%, total 1984000 ($1,984,000).", [])
    assert not any("couldn't trace" in c for c in out["check"]), out["check"]


ROUTE = """## THE REQUEST — this is the only thing to act on

Average this log and ask the Route Planner to plan it with two vans of 40 crates. If any van takes more than
60 minutes, keep asking until both are under 60 minutes."""
PLAN = [{"stdout": "Van 1: 31.6 km, about 82 min, load 39\nVan 2: 25.9 km, about 75 min, load 39", "returncode": 0}]


def test_a_limit_the_reply_ignores_is_raised():
    out = _finalize(ROUTE, PLAN, "Here is the plan: Van 1 takes about 82 min, Van 2 about 75 min.", [])
    assert any("under 60 minutes" in c or "more than 60 minutes" in c for c in out["check"]), out["check"]


def test_a_limit_the_reply_answers_is_left_alone():
    out = _finalize(ROUTE, PLAN, "Not met: both vans take over 60 minutes (82 and 75 min). A third van would help.", [])
    assert not any("doesn't confirm" in c for c in out["check"]), out["check"]


def test_ordinary_wording_is_not_a_limit():
    req = "## THE REQUEST — this is the only thing to act on\n\nHere is our log for the last four Saturdays, over 4 weeks."
    assert agent._unanswered_conditions(req, "Fountain Square grew most.") == []


def test_small_numbers_years_and_dates_are_exempt():
    assert agent._untraced_figures("Use 2 vans in 2026, van 3 is idle.", set()) == []
