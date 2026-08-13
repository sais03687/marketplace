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


# ── the model's own account is vaguer than the evidence ────────────────────

# What T03 actually sent on 2026-08-13, once the reply stopped being discarded.
# True, useless, and the run had the exact answer in hand.
T03_REPLY = (
    "Hi Sai, I encountered some technical issues while trying to generate the "
    "retention triangle and identify the best-performing cohort. The data "
    "processing script failed to execute correctly, preventing me from "
    "completing the analysis. I'll need to investigate the root cause of these "
    "errors before I can provide the requested report and chart."
)


def test_a_vague_failure_reply_is_given_the_error_that_caused_it():
    result = _finalize(_State(
        final={"action": "reply_email", "text": T03_REPLY},
        actions=["MCP python-sandbox/execute_python"] * 3,
        results=[STEP_FAILED] * 3,
    ))
    assert T03_REPLY in result["text"], "the model's own words still lead"
    assert "Expected 5 fields in line 5, saw 6" in result["text"]
    assert result["text"].index("technical issues") < result["text"].index("---")


def test_the_error_is_not_appended_twice_if_the_reply_already_names_it():
    said_it = f"I could not parse the table: pandas.errors.ParserError: Expected 5 fields in line 5, saw 6"
    result = _finalize(_State(
        final={"action": "reply_email", "text": said_it},
        actions=["MCP python-sandbox/execute_python"],
        results=[STEP_FAILED],
    ))
    assert result["text"].count("Expected 5 fields in line 5, saw 6") == 1
    assert "---" not in result["text"]


# What T03 sent in the 18:53Z benchmark run, with the error it never quoted
# sitting in a step that exited 0 because the model caught it in a try/except.
# The first version of the guard asked "did the run produce readable output",
# which this satisfies, so the caveat was withheld from the one reply needing it.
T03_CAUGHT_IN_CODE = (
    '{"stdout": "Error reading CSV: Error tokenizing data. C error: Expected 5 '
    'fields in line 6, saw 6\\n", "stderr": "", "returncode": 0, "files": []}'
)
T03_VAGUE_REPLY = (
    "Hi Sai, I encountered an issue with the data format when trying to generate "
    "the retention triangle. I was unable to produce the requested triangle or "
    "identify the best-performing cohort at this time."
)


def test_a_printed_error_does_not_count_as_having_produced_findings():
    result = _finalize(_State(
        final={"action": "reply_email", "text": T03_VAGUE_REPLY},
        actions=["MCP python-sandbox/execute_python"] * 3,
        results=[STEP_FAILED, STEP_FAILED, T03_CAUGHT_IN_CODE],
    ))
    assert "Expected 5 fields in line 5, saw 6" in result["text"], (
        "the caveat is withheld again from a reply that reports failure"
    )


def test_a_killed_step_is_named_rather_than_read_aloud():
    # T15 asked for 40 million rows and was killed eight times. The reply said
    # "returning an exit status of -9, which indicates a technical problem with
    # the execution environment" — the exit code, read aloud.
    killed = ("STEP FAILED — the code exited with status -9 and did not finish.\n\n"
              "Fix the code and run it again. Nothing was produced.")
    detail = agent._failure_detail([killed])
    assert "memory" in detail
    assert "-9" not in detail


@pytest.mark.parametrize("status", [-9, 137])
def test_the_kill_is_not_blamed_on_the_sender_s_data(status):
    # The sandbox is capped at 256 MB and shared. In the 2026-08-13 run T16's
    # 4,925-byte spreadsheet was killed by the memory the Monte Carlo beside it
    # was holding, so "your file is too large" would have been a false
    # accusation about a file that fits in a mail attachment.
    detail = agent._failure_detail([
        f"STEP FAILED — the code exited with status {status} and did not finish."
    ])
    assert detail
    for blame in ("your data", "your file", "too large", "too big"):
        assert blame not in detail.lower()


def test_the_appended_caveat_carries_the_matching_advice_too():
    # Both renderings have to pick the same advice, or the caveat tells a
    # memory-killed run to check its commas.
    killed = "STEP FAILED — the code exited with status -9 and did not finish."
    result = _finalize(_State(
        final={"action": "reply_email",
               "text": "Hi Sai, the simulation repeatedly failed to complete."},
        actions=["MCP python-sandbox/execute_python"] * 3,
        results=[killed] * 3,
    ))
    assert "smaller slice" in result["text"]
    assert "ragged row" not in result["text"]


def test_a_killed_step_still_reads_as_a_sentence_in_the_standalone_note():
    note = agent._failure_note([
        "STEP FAILED — the code exited with status -9 and did not finish."
    ])
    assert "The error was" not in note, "a killed step has no error to quote"
    assert "memory" in note


def test_the_advice_matches_the_failure():
    # Asking about ragged rows after a memory kill is advice about the wrong
    # problem: the code was fine and the size was not.
    killed = "STEP FAILED — the code exited with status -9 and did not finish."
    assert "smaller slice" in agent._failure_advice([killed])
    assert "ragged row" not in agent._failure_advice([killed])
    assert "ragged row" in agent._failure_advice([STEP_FAILED])
    assert "smaller slice" not in agent._failure_advice([STEP_FAILED])


def test_a_delivered_file_means_the_work_landed():
    # Something was produced and sent. Whatever failed on the way is history.
    result = _finalize(_State(
        final={"action": "reply_email",
               "text": "I could not chart the second series, but the totals are attached."},
        actions=["MCP python-sandbox/execute_python", "drive_upload"],
        results=[STEP_FAILED,
                 "Uploaded q3.xlsx to SharePoint: https://example.sharepoint.com/q3.xlsx"],
    ))
    assert "---" not in result["text"]


def test_a_step_that_failed_and_was_then_got_right_is_not_a_caveat():
    # Recovery is how the work went, not a warning about it. The findings are
    # the answer, and a post-mortem under them would undermine a correct reply.
    result = _finalize(_State(
        final={"action": "reply_email", "text": "Revenue was 45000 in Q3."},
        actions=["MCP python-sandbox/execute_python"] * 2,
        results=[STEP_FAILED, '{"returncode": 0, "stdout": "Total revenue: 45000"}'],
    ))
    assert "---" not in result["text"]
    assert "Expected 5 fields" not in result["text"]


def test_a_healthy_run_is_never_given_a_failure_caveat():
    result = _finalize(_State(
        final={"action": "reply_email", "text": "Revenue was 45000 in Q3."},
        actions=["MCP python-sandbox/execute_python"],
        results=['{"returncode": 0, "stdout": "Total revenue: 45000"}'],
    ))
    assert result["text"].strip() == "Revenue was 45000 in Q3."


# ── the exception has to survive the cut ───────────────────────────────────

# A pandas traceback of the shape T03 produced: fifteen frames through
# site-packages, 1,405 characters, exception on the last line. `stderr[:1200]`
# keeps the frames and drops the only line that says what went wrong.
DEEP_TRACEBACK = (
    "Traceback (most recent call last):\n"
    '  File "<string>", line 16, in <module>\n'
    + "".join(
        f'  File "/usr/local/lib/python3.12/site-packages/pandas/io/parsers/readers.py", '
        f"line {800 + i}, in _read\n    return parser.read(nrows)\n"
        "           ^^^^^^^^^^^^^^^^^^\n"
        for i in range(12)
    )
    + "pandas.errors.ParserError: Error tokenizing data. C error: "
      "Expected 5 fields in line 6, saw 6"
)


def test_the_exception_survives_a_traceback_too_long_to_keep():
    assert len(DEEP_TRACEBACK) > 1200, "fixture is not long enough to be cut"
    trimmed = agent._trim_traceback(DEEP_TRACEBACK)
    assert len(trimmed) <= 1300
    assert "Expected 5 fields in line 6, saw 6" in trimmed


def test_the_line_of_the_model_s_own_code_survives_too():
    # `File "<string>", line 16` is where the model's own code raised, and it is
    # at the head. Keeping only the tail would cost it that.
    assert '"<string>", line 16' in agent._trim_traceback(DEEP_TRACEBACK)


def test_a_short_traceback_is_left_exactly_as_it_is():
    short = 'Traceback (most recent call last):\n  File "<string>", line 2\nKeyError: "Month"'
    assert agent._trim_traceback(short) == short


def test_the_cut_is_marked_so_nobody_reads_it_as_the_whole_stack():
    assert "frames omitted" in agent._trim_traceback(DEEP_TRACEBACK)


def test_the_failure_detail_reads_a_trimmed_traceback_end_to_end():
    # The whole path: a real-shaped traceback, trimmed the way execute_action
    # trims it, then read back by the caveat. This is what failed silently on
    # three consecutive T03 runs.
    entry = ("STEP FAILED — the code exited with status 1 and did not finish.\n\n"
             f"Error:\n{agent._trim_traceback(DEEP_TRACEBACK)}\n\n"
             "Fix the code and run it again. Nothing was produced.")
    assert agent._failure_detail([entry]) == (
        "pandas.errors.ParserError: Error tokenizing data. C error: "
        "Expected 5 fields in line 6, saw 6"
    )


def test_execute_action_trims_rather_than_truncates():
    src = io.open(AGENT_SRC, encoding="utf-8").read()
    assert "_trim_traceback(_stderr)" in src, (
        "stderr is being head-truncated again; the exception is at the end and "
        "neither the model nor the failure caveat will ever see it"
    )
    assert "_stderr[:1200]" not in src


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
