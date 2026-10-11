"""A hook sent with deliver=false is a brief for the agent, not a message to answer.

Provisioning sends every new agent its onboarding brief this way, and the setup
answers follow the same way. A creator's agent reads the brief as a request and
replies to it; the adapter routed that reply to the manager. On 2026-10-10 a
buyer's first email from a newly hired Currency Desk, minutes before its
introduction, was "I couldn't find a conversion or rate to look up in that
message."
"""
import asyncio

import adapter

BRIEF = {
    "hook_name": "Onboarding",
    "session_key": "hook:onboarding",
    "deliver": False,
}

EMAILED = {
    "hook_name": "AgentMail",
    "session_key": "hook:agentmail:AAQkADI1N2Y5MTE3=",
    "message_id": "AAMkAGI2_msg_1",
    "thread_id": "email:hook:agentmail:AAQkADI1N2Y5MTE3=",
    "sender": "Manager <manager@acme.com>",
    "subject": "Invoice conversion",
}


def _drive(monkeypatch, tmp_path, context):
    sent = []

    async def record(*a, **kw):
        sent.append(kw or a)
        return True

    async def nothing(*a, **k):
        return None

    async def replies(content, context, **kw):
        return {"action": "reply_email", "text": "I couldn't find a conversion in that message."}

    monkeypatch.setattr(adapter, "IN_FLIGHT_DIR", tmp_path)
    monkeypatch.setattr(adapter, "_load_allowlist", nothing)
    monkeypatch.setattr(adapter, "_check_and_increment", lambda *a, **k: True)
    monkeypatch.setattr(adapter, "run_agent", replies)
    monkeypatch.setattr(adapter, "reply_email", record)
    monkeypatch.setattr(adapter, "send_email", record)
    asyncio.run(adapter._handle_message("You are Currency Desk, an AI employee at Acme.", dict(context)))
    return sent


def test_a_reply_to_the_onboarding_brief_is_not_sent(monkeypatch, tmp_path):
    assert _drive(monkeypatch, tmp_path, BRIEF) == []


def test_a_reply_to_an_emailed_request_still_goes_out(monkeypatch, tmp_path):
    assert _drive(monkeypatch, tmp_path, EMAILED), "the person who emailed got nothing"
