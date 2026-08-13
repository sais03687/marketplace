"""A reply the agent wrote must reach the person waiting for it.

Benchmark task T03 on 2026-08-13 ended with the requester reading "I received it
but wasn't sure how to respond." The agent had written 496 characters. The
platform dropped them, re-ran the whole task, got 349 more, dropped those too,
and sent the fixed acknowledgement.

`_set_reply` was the source:

    final["action"] = final.get("action") or "reply_email"

"none" is a truthy string, so `or` never replaced it — and the fallback for an
unparseable model response sets exactly `{"action": "none"}`. wrap_up runs
*because* a reply is needed, composed one, and left it labelled as no action at
all. The adapter sends on send_email and reply_email only.

Same family as `dae1d02` and `f49263f`: the work finished, the words were
written, and something three lines from the send threw them away. So the tests
below cover the field, the node, and the platform boundary — and the case where
there genuinely is nothing to send, which must say what broke rather than
pretend the work got done.
"""
import ast
import asyncio
import io
import re
from pathlib import Path

import pytest

import adapter
from creator import agent

AGENT_SRC = (Path(__file__).resolve().parents[1] /
             "agents" / "data-analyst" / "agent.py")
RUNTIME = (Path(__file__).resolve().parents[1] /
           "apps" / "provisioning-service" / "src" / "templates" / "runtime" / "adapter.py")

STEP_FAILED = """STEP FAILED — the code exited with status 1 and did not finish.

Error:
Traceback (most recent call last):
  File "<string>", line 15, in <module>
  File "/usr/local/lib/python3.12/site-packages/pandas/io/parsers/readers.py", line 873, in read_csv
    return _read(filepath_or_buffer, kwds)
pandas.errors.ParserError: Expected 5 fields in line 5, saw 6

It printed this before it stopped. This is partial, and not a result — do not report any of these figures:
loading data...

Fix the code and run it again. Nothing was produced."""


class _State:
    """Only what finalize reads."""
    def __init__(self, *, final, actions=(), results=(), iteration=3):
        self.content = "cohort retention please"
        self.actions_taken = list(actions)
        self.action_results = list(results)
        self.analysis = {"final_response": dict(final), "completed": True}
        self.context = {}
        self.deliverable_gaps = []
        self.deliverable_unfixable = False
        self.rebuilt_figures = []
        self.rebuild_unfixable = False
        self.rebuild_attempts = 0
        self.superlative_claims = []
        self.superlative_attempts = 0
        self.superlative_unfixable = False
        self.verify_attempts = 0
        self.max_verify_attempts = 2
        self.iteration = iteration
        self.max_iterations = 12
        self.result = None


def _finalize(state):
    asyncio.run(agent.finalize(state))
    return state.result


# ── the field that discarded it ────────────────────────────────────────────

def test_a_none_action_does_not_survive_the_reply_being_written():
    state = _State(final={"action": "none"})
    agent._set_reply(state, "Here is the retention triangle.")
    assert state.analysis["final_response"]["action"] == "reply_email"
    assert state.analysis["final_response"]["text"] == "Here is the retention triangle."


def test_a_real_send_action_is_left_alone():
    state = _State(final={"action": "send_email", "to": "sai@acme.com"})
    agent._set_reply(state, "Here it is.")
    assert state.analysis["final_response"]["action"] == "send_email"
    assert state.analysis["final_response"]["to"] == "sai@acme.com"


@pytest.mark.parametrize("junk", [{}, {"action": ""}, {"action": None},
                                  {"action": "mcp_call"}, {"action": "drive_upload"}])
def test_anything_that_is_not_a_way_of_sending_becomes_one(junk):
    state = _State(final=junk)
    agent._set_reply(state, "Written words.")
    assert state.analysis["final_response"]["action"] == "reply_email"


# ── and the node, for a model that skips wrap_up entirely ──────────────────

def test_finalize_sends_text_that_arrived_labelled_as_no_action():
    # The T03 regression, through the real node: 496 characters of reply under
    # action=none is a reply, not a non-event.
    result = _finalize(_State(
        final={"action": "none", "text": "2026-02 is holding up best at 65.00%."},
        actions=["MCP python-sandbox/execute_python"],
    ))
    assert result["action"] == "reply_email"
    assert "65.00%" in result["text"]


def test_finalize_does_not_turn_another_real_action_into_an_email():
    # resolve_approval is a real action in the platform's vocabulary and carries
    # text of its own. Rescuing anything that is merely "not a send" would turn a
    # manager's decision into a reply.
    result = _finalize(_State(
        final={"action": "resolve_approval", "text": "APPROVED — proceed."},
        actions=["MCP python-sandbox/execute_python"],
    ))
    assert result["action"] == "resolve_approval"


def test_finalize_leaves_a_genuine_no_action_alone():
    # Nothing written and nothing done — there is no reply to rescue, and
    # inventing an action here would send an empty email.
    result = _finalize(_State(final={"action": "none", "text": ""}))
    assert result["action"] == "none"
    assert not result["text"].strip()


# ── the platform boundary: any creator's agent can do this ─────────────────

def test_the_adapter_rescues_a_composed_reply_before_dispatching():
    src = io.open(RUNTIME, encoding="utf-8").read()
    # The inbound-email dispatch specifically. Three functions read an action off
    # a result, and the other two are the chat paths.
    start = src.index('print(f"[adapter] Agent returned action={action} to=')
    try:
        rescue = src.index('action = result["action"] = "reply_email"', start)
    except ValueError:
        pytest.fail("the adapter no longer rescues action=none with composed text; "
                    "a creator agent that mislabels its reply loses it silently")
    dispatch = src.index('if action in ("send_email", "reply_email"):', start)

    # Before the dispatch, and not a send of its own, so the rescued reply still
    # goes through recipient resolution, the approval policy and attachments.
    # (Between here and the dispatch sits the approval-resolution branch, which
    # has a reply_email call of its own — hence bounding the search at it.)
    assert rescue < dispatch
    rescue_block = src[rescue:src.index("# ── Email-reply approval resolution", rescue)]
    assert "reply_email(" not in rescue_block


def test_the_rescue_is_limited_to_someone_waiting_on_a_reply():
    src = io.open(RUNTIME, encoding="utf-8").read()
    i = src.index('action = result["action"] = "reply_email"')
    guard = src[max(0, i - 700):i]
    assert 'context.get("hook_name") == "AgentMail"' in guard
    assert 'result.get("text")' in guard


# ── when there is genuinely nothing to send ────────────────────────────────

def test_the_failure_note_names_the_error_and_not_the_frames():
    note = agent._failure_note([STEP_FAILED])
    assert "Expected 5 fields in line 5, saw 6" in note
    assert "site-packages" not in note
    assert "Traceback" not in note
    assert "<string>" not in note


def test_a_traceback_cut_short_quotes_nothing_rather_than_a_frame():
    # stderr is stored cut at 1200 characters, so a long traceback can end
    # mid-frame with no exception line in it. "I tried and it failed" is honest;
    # `return _read(filepath_or_buffer, kwds)` is noise to whoever asked about
    # cohort retention, and the File line above it is a container path.
    truncated = ("STEP FAILED — the code exited with status 1 and did not finish.\n\n"
                 "Error:\nTraceback (most recent call last):\n"
                 '  File "/usr/local/lib/python3.12/site-packages/pandas/io/parsers.py", line 873, in read_csv\n'
                 "    return _read(filepath_or_buffer, kwds)")
    note = agent._failure_note([truncated])
    assert note, "a failed run must still be reported"
    assert "The error was" not in note
    assert "_read" not in note and "site-packages" not in note


def test_the_failure_note_counts_the_attempts():
    assert "3 times" in agent._failure_note([STEP_FAILED] * 3)
    assert "3 times" not in agent._failure_note([STEP_FAILED])


def test_the_failure_note_narrates_no_sandbox_path():
    # The buyer has no /tmp, and the directory ceases to exist with the run.
    note = agent._failure_note([
        "STEP FAILED — x\n\nError:\nFileNotFoundError: /tmp/output/q3.xlsx\n\nFix the code"
    ])
    assert "/tmp/" not in note


def test_the_failure_note_promises_nothing_it_did_not_deliver():
    note = agent._failure_note([STEP_FAILED])
    assert "no figures" in note and "no file" in note


def test_a_healthy_run_has_no_failure_note():
    assert agent._failure_note(['{"stdout": "[{\\"Region\\":\\"North\\"}]"}']) == ""
    assert agent._failure_note([]) == ""


def test_a_run_whose_every_step_failed_does_not_claim_it_completed_the_work():
    # The branch this replaces said "I completed the work below, but did not
    # manage to write up the results" over three steps that all raised.
    result = _finalize(_State(
        final={"action": "none", "text": ""},
        actions=["MCP python-sandbox/execute_python"] * 3,
        results=[STEP_FAILED] * 3,
    ))
    assert result["action"] == "reply_email"
    assert "completed the work" not in result["text"]
    assert "ran out of steps" not in result["text"]
    assert "Expected 5 fields in line 5, saw 6" in result["text"]


def test_findings_still_lead_when_there_are_any():
    # A run that failed twice and then succeeded owes the buyer its results, not
    # a post-mortem.
    result = _finalize(_State(
        final={"action": "none", "text": ""},
        actions=["MCP python-sandbox/execute_python"],
        results=[STEP_FAILED, '{"returncode": 0, "stdout": "Total revenue: 45000"}'],
    ))
    assert "45000" in result["text"]
    assert "Expected 5 fields" not in result["text"]


# ── no hand-back may reach the buyer ───────────────────────────────────────

def test_every_platform_hand_back_is_filtered_from_buyer_facing_text():
    # SUPERLATIVE CHECK and ROUNDED-INPUT CHECK both rendered straight through
    # to the requester until 2026-08-13 — the same mistake as the 2026-08-10
    # reply that carried "Deliverable check: 2 figure(s) missing from the file".
    # Discovered by reading, so this test finds the next one by itself: any
    # literal in agent.py that opens a hand-back must be filtered.
    src = io.open(AGENT_SRC, encoding="utf-8").read()
    headers = set(re.findall(r'"([A-Z][A-Z \-]+CHECK) —', src))
    assert headers, "no hand-back headers found — has the convention changed?"
    for header in sorted(headers):
        assert agent._render_result(f"{header} — the platform measured something") == "", (
            f"{header} reaches the buyer; add it to _INTERNAL_PREFIXES"
        )
