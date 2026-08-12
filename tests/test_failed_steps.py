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
