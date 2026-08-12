"""A script that crashed is not a source of findings.

The exit status sat in the sandbox envelope and nothing read it. On 2026-08-11 a
step exited 1 with a NameError, having printed one line first, and that line was
carried forward and reported as a finding: "Fastest Growing Region: West
(14.05%)". The figure was real; the run that produced it had fallen over
halfway, and nothing said so.
"""
import json

import pytest
from creator import agent


# The real envelope, captured from the container.
CRASHED = {
    "stdout": "Fastest Growing Region: West (14.05%)\n",
    "stderr": ("Traceback (most recent call last):\n"
               '  File "<string>", line 24, in <module>\n'
               "NameError: name 'sl_growth_region' is not defined\n"),
    "returncode": 1,
    "files": [],
}
SUCCEEDED = {
    "stdout": '[{"Region":"North","Revenue per unit":154.88}]\n',
    "stderr": "",
    "returncode": 0,
    "files": [{"name": "q3.xlsx", "file_id": "sandbox:abc", "size_bytes": 5478}],
}


class _State:
    def __init__(self, results):
        self.action_results = results


# ── the buyer never sees a crashed step's output ────────────────────────────

def test_partial_output_from_a_crash_is_not_rendered():
    assert agent._render_result(json.dumps(CRASHED)) == ""


def test_the_figure_it_managed_to_print_is_not_reported():
    out = agent._buyer_readable([json.dumps(CRASHED)])
    assert "14.05" not in out
    assert "West" not in out


def test_a_traceback_is_never_shown_to_the_buyer():
    out = agent._buyer_readable([json.dumps(CRASHED)])
    assert "NameError" not in out
    assert "Traceback" not in out


def test_a_successful_step_is_still_rendered():
    out = agent._buyer_readable([json.dumps(SUCCEEDED)])
    assert "| Region |" in out
    assert "154.88" in out


def test_a_crash_does_not_suppress_the_good_step_beside_it():
    out = agent._buyer_readable([json.dumps(CRASHED), json.dumps(SUCCEEDED)])
    assert "154.88" in out
    assert "14.05" not in out


def test_the_failure_notice_itself_is_for_the_model_not_the_buyer():
    notice = ("STEP FAILED — the code exited with status 1 and did not finish.\n\n"
              "Error:\nNameError: name 'x' is not defined")
    assert agent._render_result(notice) == ""


# ── and a run that only crashed has nothing to compose from ─────────────────

def test_a_run_that_only_crashed_composes_nothing():
    # Better to fall through to finalize, which says so honestly, than to invent
    # a reply out of a traceback.
    assert agent._compose_reply(_State([json.dumps(CRASHED)])) == ""


@pytest.mark.parametrize("rc", [1, 2, 137, -9])
def test_any_non_zero_exit_counts_as_failed(rc):
    envelope = dict(CRASHED, returncode=rc)
    assert agent._render_result(json.dumps(envelope)) == ""


def test_a_missing_exit_status_is_not_assumed_to_be_a_failure():
    # parse_pdf and friends return no returncode at all.
    envelope = {"stdout": '[{"Region":"North","Revenue per unit":154.88}]\n'}
    assert "154.88" in agent._render_result(json.dumps(envelope))


# ── two failures in a row means the assumption is wrong, not the code ───────
#
# On 2026-08-11 a header of "Month, North" parsed as the column " North", and
# KeyError names the key you asked for and never the ones that exist. The same
# assumption was retried three times until the loop guard stopped the run, and
# the buyer got nothing. A second consecutive failure is the moment to look at
# the data rather than reason about it.

CRASHED_NAME_ERROR = {
    "stdout": "",
    "stderr": "KeyError: 'North'",
    "returncode": 1,
    "files": [],
}


def _step(state, envelope):
    """Run one mcp_call through execute_action with a stubbed sandbox."""
    import asyncio

    async def _mcp(server, tool, arguments):
        return envelope

    agent._thread_fns["test-thread"] = {"mcp_fn": _mcp}
    state.context["_thread_id"] = "test-thread"
    state.analysis = {
        "action": {
            "type": "mcp_call",
            "params": {
                "server": "python-sandbox",
                "tool": "execute_python",
                "arguments": {"code": "df['North']"},
            },
        }
    }
    asyncio.run(agent.execute_action(state))
    return state.action_results[-1]


def _fresh_state():
    return agent.AgentState(content="analyse this", context={"_thread_id": "test-thread"})


def test_the_first_failure_just_asks_for_a_fix():
    first = _step(_fresh_state(), CRASHED_NAME_ERROR)
    assert "Fix the code and run it again" in first
    assert "Stop guessing" not in first


def test_the_second_consecutive_failure_asks_for_the_actual_shape():
    state = _fresh_state()
    _step(state, CRASHED_NAME_ERROR)
    second = _step(state, CRASHED_NAME_ERROR)
    assert "second failure in a row" in second
    assert "print it" in second
    assert "names what you asked for, not what exists" in second


def test_the_nudge_is_for_the_model_and_never_reaches_the_buyer():
    state = _fresh_state()
    _step(state, CRASHED_NAME_ERROR)
    second = _step(state, CRASHED_NAME_ERROR)
    assert agent._render_result(second) == ""


def test_a_failure_after_a_success_is_not_treated_as_a_repeat():
    # The streak is what matters. A crash following a good step is a new
    # problem, not a failed second attempt at the same one.
    state = _fresh_state()
    _step(state, SUCCEEDED)
    after = _step(state, CRASHED_NAME_ERROR)
    assert "second failure in a row" not in after
    assert "Fix the code and run it again" in after


def test_a_successful_step_after_failures_still_returns_its_result():
    state = _fresh_state()
    _step(state, CRASHED_NAME_ERROR)
    _step(state, CRASHED_NAME_ERROR)
    good = _step(state, SUCCEEDED)
    assert "154.88" in good
    assert "STEP FAILED" not in good
