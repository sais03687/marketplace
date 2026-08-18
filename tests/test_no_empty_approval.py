"""Nobody can approve an empty message.

Task F1 on 2026-08-18 queued one. A zero-length reply, with no subject either,
sat in the buyer's approval queue looking like a decision they could make:
approving it would have sent an empty email, and rejecting it says nothing about
what went wrong. The run had lost its state and arrived at the queue with
nothing to say.

The upstream cause and this guard are separate concerns. `finalize` composes a
partial-progress reply out of whatever a run holds — findings, the figures read
back from a workbook, what broke — so arriving here empty means the run never
got that far. Whatever emptied it, an empty approval is the wrong thing to put
in front of a person, and the honest move is to say the run produced nothing.
"""
import io
from pathlib import Path

import adapter

SRC = io.open(Path(adapter.__file__), encoding="utf-8").read()
GUARD = SRC[SRC.index("draft_text = result.get"):][:4200]


def test_an_empty_draft_is_never_queued():
    assert "if not draft_text.strip():" in GUARD, (
        "an empty reply reached the approval queue as though it were a decision"
    )


def test_the_guard_runs_before_the_queue_call():
    assert GUARD.index("if not draft_text.strip():") < GUARD.index("queue_for_approval("), (
        "queueing first and checking afterwards still puts a blank in the queue"
    )


def test_it_returns_rather_than_falling_through():
    guard = GUARD[GUARD.index("if not draft_text.strip():"):GUARD.index("queue_for_approval(")]
    assert "return" in guard


def test_the_requester_is_told_the_run_produced_nothing():
    # Silence is the other way to get this wrong: the buyer sent an email and
    # would otherwise hear nothing at all.
    assert "did not complete" in GUARD
    assert "nothing to" in GUARD


def test_the_notice_promises_no_results_and_no_attachment():
    # It carries no findings and no file, so it must not imply either — that is
    # the whole difference between this and a partial-progress reply.
    lowered = GUARD.lower()
    for overclaim in ("attached", "workbook", "results are", "please find"):
        assert overclaim not in lowered.split("did not complete")[1][:600], overclaim


def test_it_says_what_to_do_next():
    assert "again" in GUARD and "smaller pieces" in GUARD


def test_the_notice_is_rate_limited_like_any_other_send():
    assert "_check_and_increment" in GUARD, (
        "a run that fails in a loop would mail the buyer once per failure"
    )
