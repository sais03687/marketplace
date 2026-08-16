"""A request must never vanish.

Two of sixteen benchmark tasks on 2026-08-12 produced no reply at all — not a
wrong answer, not an apology, nothing. For a product whose promise is that
every document contains what was asked for, that is the worst failure mode
there is: a wrong answer gets argued with, but silence is never chased, because
nobody knows there is anything to chase.

Both had done the work. T03 built its retention workbook, was gated for
approval, was approved, resumed, and wrote a 489-character reply — which was
then thrown away by a NameError three lines from the send. `resolution` was
read as a free variable in _deliver_email_result, where it has never been in
scope, so *every* post-resume action=none raised. It ran in a fire-and-forget
task, so the only evidence was "Task exception was never retrieved" in the
container log. T08 died on an IndexError further up, in the same swallowing
`except Exception` at the bottom of _handle_message.

So there are two things to hold: the specific bug, and the reason nobody found
out about it for a day. The tests below cover both — the missing parameter, and
the guarantee that whatever else breaks, the sender is told.
"""
import ast
import io
import asyncio
import inspect
from pathlib import Path

import pytest

import adapter


RUNTIME = (Path(__file__).resolve().parents[1] /
           "apps" / "provisioning-service" / "src" / "templates" / "runtime" / "adapter.py")

CTX = {
    "sender": "Sai Suram <sai@acme.com>",
    "subject": "Monthly cohort retention",
    "message_id": "msg-t03",
    "thread_id": "thread-t03",
}


@pytest.fixture
def sent(monkeypatch):
    """Capture outbound mail instead of sending it."""
    box = []

    async def _reply_email(**kwargs):
        box.append(("reply", kwargs))

    async def _send_email(**kwargs):
        box.append(("send", kwargs))

    monkeypatch.setattr(adapter, "reply_email", _reply_email)
    monkeypatch.setattr(adapter, "send_email", _send_email)
    monkeypatch.setattr(adapter, "_check_and_increment", lambda counter: True)
    return box


# ── the specific bug: resolution was never in scope ─────────────────────────

def test_deliver_email_result_takes_the_resolution_it_reads():
    # The body reads `resolution` to decide the manager's headline. Reading it
    # as a free variable is what raised NameError on every action=none resume.
    params = inspect.signature(adapter._deliver_email_result).parameters
    assert "resolution" in params


def test_the_resume_path_actually_passes_the_resolution():
    # A default of None would make the signature test pass while the caller
    # still told the manager nothing about what they decided. Read the call.
    tree = ast.parse(RUNTIME.read_text(encoding="utf-8"))
    calls = [
        node for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == "_deliver_email_result"
    ]
    assert calls, "no call to _deliver_email_result found"
    for call in calls:
        passed = [a.id for a in call.args if isinstance(a, ast.Name)]
        passed += [k.arg for k in call.keywords]
        assert "resolution" in passed


@pytest.mark.parametrize(
    "status, expected",
    [
        ("REJECTED", "rejected"),
        ("EXPIRED", "expired"),
        ("APPROVED", "completed"),
    ],
)
def test_action_none_notifies_the_manager_of_the_real_decision(
    sent, monkeypatch, status, expected
):
    monkeypatch.setattr(adapter, "_manager_email", lambda: "manager@acme.com")

    asyncio.run(adapter._deliver_email_result(
        "Retention triangle attached.",
        {"action": "none"},
        CTX,
        {"status": status},
    ))

    # Two messages now, and the order is the point: the person who asked hears
    # first, the manager gets the audit copy of their own decision. This branch
    # used to write to the manager alone, so a requester whose request was
    # approved or rejected on their behalf heard nothing at all.
    kinds = [k for k, _ in sent]
    assert "reply" in kinds, "the requester was told nothing"
    assert "send" in kinds, "the manager was told nothing"

    to_requester = next(kw for k, kw in sent if k == "reply")
    assert to_requester["fallback_to"] == "sai@acme.com"
    assert "Retention triangle attached." in to_requester["text"]

    to_manager = next(kw for k, kw in sent if k == "send")
    assert to_manager["to"] == "manager@acme.com"
    assert expected in to_manager["subject"].lower()


def test_a_missing_resolution_still_delivers(sent, monkeypatch):
    # Nothing here should be load-bearing enough to lose the message over.
    monkeypatch.setattr(adapter, "_manager_email", lambda: "manager@acme.com")
    asyncio.run(adapter._deliver_email_result("done", {"action": "none"}, CTX, None))
    assert [k for k, _ in sent] == ["reply", "send"], (
        "requester then manager, even with no resolution to report"
    )


def test_the_requester_is_not_written_to_twice_when_they_are_the_manager(sent, monkeypatch):
    # A one-person tenant: the same address should get the answer, not the
    # answer and an audit copy of their own decision.
    monkeypatch.setattr(adapter, "_manager_email", lambda: "sai@acme.com")
    asyncio.run(adapter._deliver_email_result("done", {"action": "none"}, CTX, None))
    assert [k for k, _ in sent] == ["reply"]


def test_nothing_composed_means_nothing_claimed(sent, monkeypatch):
    # An empty reply is not an answer. Say nothing to the requester rather than
    # send them a blank message, but still leave the manager their record.
    monkeypatch.setattr(adapter, "_manager_email", lambda: "manager@acme.com")
    asyncio.run(adapter._deliver_email_result("   ", {"action": "none"}, CTX, {"status": "REJECTED"}))
    assert [k for k, _ in sent] == ["send"]


# ── the reason it went unnoticed: a crash meant silence ─────────────────────

def test_the_sender_is_told_when_the_request_fails(sent):
    asyncio.run(adapter._notify_send_failed(CTX, RuntimeError("boom")))

    assert len(sent) == 1
    kind, kwargs = sent[0]
    assert kind == "reply"
    assert kwargs["fallback_to"] == "sai@acme.com"


def test_the_failure_notice_carries_no_model_output(sent):
    # It runs after an unknown crash, so it must be a constant. Anything
    # interpolated from the run could be half-built or wrong.
    asyncio.run(adapter._notify_send_failed(CTX, RuntimeError("SECRET-INTERNAL-DETAIL")))

    _, kwargs = sent[0]
    assert "SECRET-INTERNAL-DETAIL" not in kwargs["text"]
    assert "went wrong" in kwargs["text"].lower()


def test_the_notice_says_nothing_was_sent_on_the_senders_behalf(sent):
    # The crash can land after an upload or before it. The one thing the
    # sender needs to know is whether anything went out in their name.
    asyncio.run(adapter._notify_send_failed(CTX, RuntimeError("boom")))
    text = sent[0][1]["text"].lower()
    assert "nothing was sent" in text


def test_no_sender_means_no_send_and_no_raise(sent):
    # Called from an except block. Raising here would replace one swallowed
    # error with another.
    asyncio.run(adapter._notify_send_failed({"subject": "orphan"}, RuntimeError("boom")))
    assert sent == []


def test_a_failing_notice_does_not_propagate(monkeypatch, capsys):
    async def _explode(**kwargs):
        raise RuntimeError("graph is down too")

    monkeypatch.setattr(adapter, "reply_email", _explode)
    monkeypatch.setattr(adapter, "_check_and_increment", lambda counter: True)

    asyncio.run(adapter._notify_send_failed(CTX, RuntimeError("original")))

    # This is the one case where a request really does disappear. It has to be
    # loud in the log, because nothing else will ever surface it.
    out = capsys.readouterr().out
    assert "FAILURE NOTICE ALSO FAILED" in out
    assert "original" in out


def test_the_handler_of_last_resort_is_wired_to_the_catch_all():
    # The bug was not that _handle_message crashed; it was that the bottom
    # `except Exception` printed one line and returned, leaving the sender
    # waiting forever. Assert the notice is reached from there.
    tree = ast.parse(RUNTIME.read_text(encoding="utf-8"))
    handler = next(
        node for node in ast.walk(tree)
        if isinstance(node, ast.AsyncFunctionDef) and node.name == "_handle_message"
    )
    catch_alls = [
        h for node in ast.walk(handler) if isinstance(node, ast.Try)
        for h in node.handlers
        if isinstance(h.type, ast.Name) and h.type.id == "Exception"
    ]
    notified = [
        h for h in catch_alls
        if any(
            isinstance(n, ast.Call) and isinstance(n.func, ast.Name)
            and n.func.id == "_notify_send_failed"
            for n in ast.walk(h)
        )
    ]
    assert notified, "no catch-all in _handle_message tells the sender anything"


# ── the same loss on the chat path ─────────────────────────────────────────

def test_the_chat_reply_is_the_composed_text_not_the_last_tool_result():
    """Degraded rather than silent, which is why it outlived the email version.

    `_resume_and_deliver` took `result["text"]` only when the action said
    send_email or reply_email. A run that wrote its answer and labelled it
    action=none fell through to the last action result — a raw tool envelope
    with a tick in front of it — while the reply sat unused in the same dict.

    Asserted against the source because the composition sits inside a 140-line
    resume path that needs an approval, a checkpoint and a live graph to reach;
    the condition is the whole of the fix and it is one line.
    """
    src = io.open(RUNTIME, encoding="utf-8").read()
    i = src.index("Composed text is the reply, whatever the action field says")
    block = src[i:i + 700]
    assert "if not reply_text:" in block, (
        "composed text is gated on the action again; a reply labelled "
        "action=none will be replaced by a tool envelope"
    )
    # The old gate must not be what decides whether the text is used.
    first = block.index("reply_text = result.get")
    gate = block[:first]
    assert 'action in ("send_email", "reply_email")' not in gate
