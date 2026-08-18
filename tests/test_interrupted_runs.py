"""A run killed mid-work must not vanish silently.

`PENDING_RESUMES_DIR` covers a run suspended at an approval: the approval comes
back later and drives it onward. A run killed while it was actually working had
no pointer anywhere, so nothing knew it had ever started.

benchmark/chaos.sh found this on its first unattended run, on 2026-08-18. F3
built its workbook at 14:43:38, the container restarted at 14:44:03, and the
task ceased — files restored, graph checkpointed, nothing to drive it. The buyer
got nothing at all, and would have gone on waiting. Every deploy does this to
whatever is mid-flight.

The chosen fix is to tell them, not to retry: re-driving a run risks a second
upload and a second email, and silence is the part worth removing first.

Session keys here are the ones that really arrive — `hook:agentmail:<id>` with
its colons and trailing `=` — because a fixture that survives `_safe_handle`
unchanged cannot test a path that stores one. See test_lossy_keys.py.
"""
import asyncio
import json
import time

import pytest

import adapter

REAL_KEY = "hook:agentmail:AAQkADI1N2Y5MTE3LTE1MDctNGY0Yy1iYzQ5="

CONTEXT = {
    "session_key": REAL_KEY,
    "message_id": "AAMkAGI2_msg_991",
    "thread_id": "email:" + REAL_KEY,
    "sender": "Sai Suram <sai@agents.agentstore.it.com>",
    "subject": "Consultant utilisation for the month",
}


@pytest.fixture
def flight(tmp_path, monkeypatch):
    monkeypatch.setattr(adapter, "IN_FLIGHT_DIR", tmp_path)
    return tmp_path


@pytest.fixture
def sent(monkeypatch):
    """Capture what would be emailed, and let the budget through."""
    out = []

    async def fake_reply(**kw):
        out.append(kw)

    monkeypatch.setattr(adapter, "reply_email", fake_reply)
    monkeypatch.setattr(adapter, "_check_and_increment", lambda *a, **k: True)
    return out


def test_the_key_used_here_is_one_that_gets_rewritten():
    # The guard the other tests rest on.
    assert adapter._safe_handle(REAL_KEY) != REAL_KEY


# ── the journal ────────────────────────────────────────────────────────────

def test_a_run_that_begins_is_recorded(flight):
    adapter._note_in_flight(CONTEXT)
    written, = flight.glob("*.json")
    info = json.loads(written.read_text(encoding="utf-8"))
    assert info["session_key"] == REAL_KEY
    assert info["subject"] == "Consultant utilisation for the month"
    assert info["message_id"] == "AAMkAGI2_msg_991"


def test_a_run_that_ends_is_cleared(flight):
    adapter._note_in_flight(CONTEXT)
    adapter._clear_in_flight(REAL_KEY)
    assert not list(flight.glob("*.json")), (
        "cleared with the sanitised key rather than the real one leaves the "
        "entry behind, and the buyer is told a finished run was interrupted"
    )


def test_clearing_is_keyed_on_what_was_written(flight):
    # The failure this pins: write under _file_stem(key), delete under
    # _safe_handle(key). Both "work", and nothing is ever removed.
    adapter._note_in_flight(CONTEXT)
    stale = flight / (adapter._safe_handle(REAL_KEY) + ".json")
    assert not stale.exists() or stale != next(flight.glob("*.json"))
    adapter._clear_in_flight(CONTEXT["session_key"])
    assert not list(flight.glob("*.json"))


def test_a_context_with_no_session_key_is_ignored(flight):
    adapter._note_in_flight({"subject": "no key"})
    adapter._clear_in_flight("")
    assert not list(flight.glob("*.json"))


# ── the notice ─────────────────────────────────────────────────────────────

def test_the_sender_is_told(flight, sent):
    adapter._note_in_flight(CONTEXT)
    asyncio.run(adapter._report_interrupted_runs())
    assert len(sent) == 1
    assert sent[0]["fallback_to"] == "sai@agents.agentstore.it.com"
    assert "Consultant utilisation for the month" in sent[0]["text"]
    assert sent[0]["message_id"] == "AAMkAGI2_msg_991", "the notice must thread"


def test_the_notice_does_not_claim_more_than_it_knows(flight, sent):
    # An earlier draft said "no files were shared". A run can die after it has
    # already uploaded, so that sentence would sometimes be a lie.
    adapter._note_in_flight(CONTEXT)
    asyncio.run(adapter._report_interrupted_runs())
    text = sent[0]["text"].lower()
    assert "no files were shared" not in text
    assert "have not sent you a result" in text


def test_nothing_is_reported_twice(flight, sent):
    adapter._note_in_flight(CONTEXT)
    asyncio.run(adapter._report_interrupted_runs())
    asyncio.run(adapter._report_interrupted_runs())
    assert len(sent) == 1


def test_the_entry_goes_before_the_send_not_after(flight, monkeypatch):
    """A notice that crashes must not be retried forever.

    This runs on startup. An entry that outlived a failed attempt would be
    retried at the next start, fail again, and never clear — a restart loop on
    the code path whose entire job is recovering from restarts.
    """
    async def explode(**kw):
        raise RuntimeError("Graph is down")

    monkeypatch.setattr(adapter, "reply_email", explode)
    monkeypatch.setattr(adapter, "_check_and_increment", lambda *a, **k: True)
    adapter._note_in_flight(CONTEXT)
    asyncio.run(adapter._report_interrupted_runs())
    assert not list(flight.glob("*.json"))


def test_a_stale_entry_is_dropped_rather_than_sent(flight, sent, monkeypatch):
    monkeypatch.setattr(adapter, "_IN_FLIGHT_MAX_AGE_S", 3600)
    adapter._note_in_flight(CONTEXT)
    entry, = flight.glob("*.json")
    info = json.loads(entry.read_text(encoding="utf-8"))
    info["started_at"] = time.time() - 90000  # a day and a half ago
    entry.write_text(json.dumps(info), encoding="utf-8")

    asyncio.run(adapter._report_interrupted_runs())
    assert sent == [], "a notice about a request from two days ago is noise"
    assert not list(flight.glob("*.json"))


def test_an_entry_with_no_sender_is_not_sent_anywhere(flight, sent):
    adapter._note_in_flight({**CONTEXT, "sender": ""})
    asyncio.run(adapter._report_interrupted_runs())
    assert sent == []


def test_a_corrupt_entry_does_not_stop_the_others(flight, sent):
    adapter._note_in_flight(CONTEXT)
    (flight / "half-written.json").write_text('{"session_key": ', encoding="utf-8")
    asyncio.run(adapter._report_interrupted_runs())
    assert len(sent) == 1
    assert not list(flight.glob("*.json"))


def test_an_empty_directory_sends_nothing(flight, sent):
    asyncio.run(adapter._report_interrupted_runs())
    assert sent == []


# ── the wiring, which is where this would rot ──────────────────────────────

def test_the_handler_notes_and_clears():
    import io
    from pathlib import Path
    src = io.open(Path(adapter.__file__), encoding="utf-8").read()
    body = src[src.index("async def _handle_message"):src.index("async def _notify_send_failed")]
    assert "_note_in_flight(context)" in body
    assert "finally:" in body and "_clear_in_flight(" in body, (
        "cleared anywhere but a finally, an early return leaves the entry and "
        "the buyer is told a completed run was interrupted"
    )
    assert body.index("_note_in_flight") < body.index("try:"), (
        "noted inside the try, a failure before that point is invisible"
    )


def test_startup_reports_and_cannot_be_stopped_by_it():
    import io
    from pathlib import Path
    src = io.open(Path(adapter.__file__), encoding="utf-8").read()
    startup = src[src.index("async def _startup"):][:900]
    assert "_report_interrupted_runs()" in startup
    assert "except Exception" in startup, (
        "an agent that will not start is worse than a missed notice"
    )


# ── cancellation, which is what a restart actually looks like ──────────────
#
# Every test above drives the helpers directly, and all fifteen passed while the
# feature did not work: `docker restart` sends SIGTERM, uvicorn cancels the tasks
# still in flight, and `CancelledError` - a BaseException, so invisible to
# `except Exception` - went straight to the `finally`, which cleared the record.
# The journal erased itself on the one path it exists for.
#
# Nothing short of cancelling a real task could have shown that, which is the
# same lesson as test_lossy_keys.py in a different costume: the tests agreed with
# each other and never crossed the boundary the bug lived on.

def test_cancelling_a_run_keeps_the_record(flight, monkeypatch):
    async def never_returns(*a, **k):
        await asyncio.sleep(3600)

    async def nothing(*a, **k):
        return None

    monkeypatch.setattr(adapter, "_load_allowlist", nothing)
    monkeypatch.setattr(adapter, "_check_and_increment", lambda *a, **k: True)
    monkeypatch.setattr(adapter, "run_agent", never_returns)

    async def drive():
        task = asyncio.create_task(adapter._handle_message("do the thing", dict(CONTEXT)))
        for _ in range(200):                     # let it reach the hang
            await asyncio.sleep(0.01)
            if list(flight.glob("*.json")):
                break
        assert list(flight.glob("*.json")), "the run never recorded itself"
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(drive())
    assert list(flight.glob("*.json")), (
        "cancellation cleared the record, so the buyer will never be told"
    )


def test_a_run_that_finishes_normally_still_clears(flight, monkeypatch):
    """The other half. A guard that never clears is as broken as one that always
    does — it would tell every buyer their completed work was interrupted."""
    async def nothing(*a, **k):
        return None

    monkeypatch.setattr(adapter, "_load_allowlist", nothing)
    monkeypatch.setattr(adapter, "_check_and_increment", lambda *a, **k: False)  # early return

    asyncio.run(adapter._handle_message("do the thing", dict(CONTEXT)))
    assert not list(flight.glob("*.json"))
