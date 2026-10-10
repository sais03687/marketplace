"""Long runs: a time limit every run has, and a way to say "still working".

Runs had no limit, so a stuck run held its container and the buyer's reply
forever; and a long job had no way to tell the buyer anything was happening.
"""
import asyncio

import pytest

import adapter

MANAGER = "manager@acme.com"


def test_the_time_limit_defaults_to_an_hour(monkeypatch):
    monkeypatch.delenv("MAX_RUN_MINUTES", raising=False)
    monkeypatch.setattr(adapter, "_CREATOR_MANIFEST", {})
    assert adapter._max_run_seconds() == 3600


@pytest.mark.parametrize("declared,expected_minutes", [(15, 15), (0, 1), (1000, 240), ("x", 60)])
def test_the_manifest_sets_the_limit_within_bounds(monkeypatch, declared, expected_minutes):
    monkeypatch.delenv("MAX_RUN_MINUTES", raising=False)
    monkeypatch.setattr(adapter, "_CREATOR_MANIFEST", {"maxRunMinutes": declared})
    assert adapter._max_run_seconds() == expected_minutes * 60


def test_only_an_agent_that_names_progress_fn_is_given_it():
    async def wants(content, context, progress_fn):
        ...

    async def does_not(content, context):
        ...

    fn = object()
    assert adapter._creator_tool_kwargs(wants, progress_fn=fn)["progress_fn"] is fn
    assert "progress_fn" not in adapter._creator_tool_kwargs(does_not, progress_fn=fn)


@pytest.fixture
def sent(monkeypatch):
    calls = []

    async def fake_reply(message_id, text, **kw):
        calls.append({"message_id": message_id, "text": text, **kw})
        return {"ok": True}

    monkeypatch.setattr(adapter, "reply_email", fake_reply)
    monkeypatch.setattr(adapter, "_manager_email", lambda: MANAGER)
    monkeypatch.setattr(adapter, "_load_policy", lambda: {
        "policy": "always", "riskThreshold": 6.0, "autoApprove": [], "requireApproval": []})
    return calls


def _ctx(sender=MANAGER):
    return {"sender": f"Pat <{sender}>", "message_id": "m1", "subject": "Big job"}


def test_a_progress_note_reaches_the_manager_in_the_same_thread(sent):
    progress = adapter._make_progress_fn(_ctx())
    assert asyncio.run(progress("Started — about 20 minutes.")) is True
    assert sent == [{"message_id": "m1", "text": "Started — about 20 minutes.",
                     "fallback_to": MANAGER, "fallback_subject": "Big job"}]


def test_progress_notes_are_capped_and_spaced(sent, monkeypatch):
    clock = {"t": 1000.0}
    monkeypatch.setattr(adapter.time, "monotonic", lambda: clock["t"])
    progress = adapter._make_progress_fn(_ctx())
    assert asyncio.run(progress("one")) is True
    assert asyncio.run(progress("too soon")) is False
    for _ in range(5):
        clock["t"] += adapter.PROGRESS_MIN_INTERVAL_S + 1
        asyncio.run(progress("later"))
    assert len(sent) == adapter.MAX_PROGRESS_EMAILS


def test_a_note_that_would_need_approval_is_not_sent(sent):
    progress = adapter._make_progress_fn(_ctx(sender="someone@outside.org"))
    assert asyncio.run(progress("Working on it")) is False
    assert sent == []


def test_an_empty_note_or_a_message_with_no_thread_sends_nothing(sent):
    assert asyncio.run(adapter._make_progress_fn(_ctx())("   ")) is False
    assert asyncio.run(adapter._make_progress_fn({"sender": MANAGER})("hello")) is False
    assert sent == []
