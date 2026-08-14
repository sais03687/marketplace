"""When the summary and the file disagree, say so without taking a side.

The check knows one thing: a figure is in the reply and not in the file. It
cannot tell which is wrong. It used to announce that it could — "the figures
above are right, but the attached file is missing…" — and on 2026-08-11 that
sentence went out over a summary whose three slopes were all wrong and a
workbook whose three slopes were all right. It vouched for the bad numbers,
cast doubt on the good ones, and referred to an attachment that was not there.

The hand-back had the same bias built in: it told the agent to rebuild the
file, so the agent rebuilt an already-correct workbook twice and never
re-read its own sentence.
"""
import asyncio

import pytest
from creator import agent


class _State:
    def __init__(self, gaps=(), text="North grew 6,108.57 per month."):
        self.content = "trend please"
        self.action_results = []
        self.actions_taken = []
        self.analysis = {"final_response": {"action": "reply_email", "text": text}}
        self.context = {}
        self.deliverable_gaps = list(gaps)
        self.deliverable_unfixable = bool(gaps)
        self.rebuilt_figures = []
        self.rebuild_unfixable = False
        self.rebuild_attempts = 0
        self.verify_attempts = 0
        self.max_verify_attempts = 2
        self.iteration = 3
        self.max_iterations = 12
        self.result = None


def _finalize(state):
    asyncio.run(agent.finalize(state))
    return state.result["text"]


# ── the note claims only what was measured ─────────────────────────────────

def test_the_note_does_not_vouch_for_the_summary():
    text = _finalize(_State(gaps=["6,108.57", "0.98"]))
    assert "figures above are right" not in text
    assert "are right" not in text


def test_the_note_names_the_file_as_the_tiebreaker():
    text = _finalize(_State(gaps=["6,108.57"]))
    assert "go with the file" in text
    assert "what the code actually computed" in text


def test_the_note_does_not_promise_an_attachment():
    # It said "the attached file" while the only copy was on SharePoint, so the
    # reader was pointed at something the mail did not contain.
    text = _finalize(_State(gaps=["6,108.57"]))
    assert "attached file" not in text


def test_the_missing_figures_are_named():
    text = _finalize(_State(gaps=["6,108.57", "-2,457.14"]))
    assert "6,108.57" in text
    assert "-2,457.14" in text


def test_one_figure_reads_as_one_figure():
    assert "appears in my summary" in _finalize(_State(gaps=["6,108.57"]))


def test_several_figures_read_as_several():
    assert "appear in my summary" in _finalize(_State(gaps=["6,108.57", "0.98"]))


def test_the_note_comes_after_the_answer_not_before_it():
    # A caveat that leads buries the thing that was asked for.
    text = _finalize(_State(gaps=["6,108.57"]))
    assert text.index("North grew") < text.index("Worth checking")


def test_no_gaps_means_no_note():
    text = _finalize(_State(gaps=[]))
    assert "Worth checking" not in text
    assert "go with the file" not in text


# ── the hand-back asks which side is wrong ─────────────────────────────────

def _handback(monkeypatch, missing):
    async def _verifier(_text):
        return list(missing)

    monkeypatch.setattr(agent, "_deliverable_verifier", _verifier, raising=False)
    state = _State()
    state.deliverable_gaps = []
    state.deliverable_unfixable = False
    asyncio.run(agent.verify_deliverables(state))
    handbacks = [r for r in state.action_results if "DELIVERABLE CHECK" in r]
    assert handbacks, "the check did not hand back at all"
    return handbacks[-1]


def test_the_handback_offers_the_reply_being_wrong_first(monkeypatch):
    msg = _handback(monkeypatch, ["6,108.57"])
    assert "The reply is wrong" in msg
    assert msg.index("The reply is wrong") < msg.index("The file really is missing")


def test_the_handback_says_the_file_is_the_trustworthy_side(monkeypatch):
    msg = _handback(monkeypatch, ["6,108.57"])
    assert "the one to trust" in msg


def test_the_handback_forbids_rebuilding_a_correct_file(monkeypatch):
    # The specific waste: two attempts spent regenerating a workbook that was
    # right both times, while the wrong sentence went out unchanged.
    msg = _handback(monkeypatch, ["6,108.57"])
    assert "Do not rebuild a file that is already right" in msg


def test_the_handback_still_allows_the_file_being_incomplete(monkeypatch):
    msg = _handback(monkeypatch, ["6,108.57"])
    assert "upload the new file_id" in msg


def test_the_handback_no_longer_assumes_the_reply_is_right(monkeypatch):
    msg = _handback(monkeypatch, ["6,108.57"])
    assert "has to carry everything the reply claims" not in msg


def test_the_handback_names_the_figures(monkeypatch):
    msg = _handback(monkeypatch, ["6,108.57", "-2,457.14"])
    assert "6,108.57" in msg and "-2,457.14" in msg


def test_the_handback_is_internal_and_never_rendered_to_the_buyer(monkeypatch):
    msg = _handback(monkeypatch, ["6,108.57"])
    assert agent._render_result(msg) == ""
