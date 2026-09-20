"""Outbound mail moves to Resend; the mailbox it is sent from does not.

Gmail began refusing this domain's mail outright on 2026-09-20 — 550 5.7.1,
"likely unsolicited mail" — after two days of test traffic. Authentication was
correct the whole time, so the verdict was about the sender: Exchange Online's
shared outbound IPs are not a transactional sender and lend a young domain no
reputation. Sending moves to a service built for it.

The behaviour is tested in test_resend_send.mjs so it runs the shipped module;
this file runs it under pytest (which is what CI runs) and checks the two send
paths go through it, keep Graph as a fallback, and preserve the two things Graph
was quietly doing for us: threading and the sender's display name.
"""
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SERVER = ROOT / "apps" / "provisioning-service" / "src" / "server.ts"
CLIENT = ROOT / "apps" / "provisioning-service" / "src" / "clients" / "resend.ts"
SCRIPT = Path(__file__).resolve().parent / "test_resend_send.mjs"


@pytest.mark.skipif(shutil.which("node") is None, reason="node is needed")
def test_the_sending_behaves():
    r = subprocess.run(
        ["node", "--experimental-strip-types", str(SCRIPT)],
        capture_output=True, text=True, cwd=SCRIPT.parent.parent,
    )
    print(r.stdout or r.stderr)
    assert r.returncode == 0, r.stdout + r.stderr
    assert r.stdout.count("ok   ") >= 12, r.stdout


@pytest.mark.parametrize("endpoint", ["platform-send", "outlook-send"])
def test_both_send_paths_try_resend_first(endpoint):
    src = SERVER.read_text(encoding="utf-8")
    start = src.index(f'req.url === "/internal/{endpoint}"')
    handler = src[start:start + 6000]
    assert "resendConfigured()" in handler, f"{endpoint} never tries Resend"
    assert "sendViaResend" in handler


@pytest.mark.parametrize("endpoint", ["platform-send", "outlook-send"])
def test_a_resend_failure_falls_back_to_graph(endpoint):
    # A missing or rejected key must not be the reason a buyer never hears from
    # their agent. Graph stays wired up underneath.
    src = SERVER.read_text(encoding="utf-8")
    start = src.index(f'req.url === "/internal/{endpoint}"')
    handler = src[start:start + 6000]
    assert "falling back to Graph" in handler
    graph_at = handler.index("graph.microsoft.com")
    resend_at = handler.index("sendViaResend")
    assert resend_at < graph_at, "Graph should be the fallback, not the first choice"


def test_a_reply_keeps_its_thread():
    # Graph's /messages/{id}/reply threaded replies for us. Sending directly does
    # not, and an agent whose answer arrives as a new conversation has lost the
    # request it was answering.
    src = SERVER.read_text(encoding="utf-8")
    assert "threadHeadersFor" in src
    assert "internetMessageId" in src
    start = src.index('req.url === "/internal/outlook-send"')
    handler = src[start:start + 6000]
    assert "replyToMessageId" in handler and "threadHeadersFor" in handler


def test_the_agent_still_writes_under_its_own_name():
    # Graph put the mailbox's display name on the envelope. Losing it would have
    # every agent suddenly writing to its buyer as a raw address.
    src = SERVER.read_text(encoding="utf-8")
    assert "mailboxDisplayName" in src
    for endpoint in ("platform-send", "outlook-send"):
        start = src.index(f'req.url === "/internal/{endpoint}"')
        assert "mailboxDisplayName" in src[start:start + 6000], endpoint


def test_neither_lookup_can_fail_a_send():
    # Both are conveniences read from Graph. Neither is worth losing a message
    # over, so both swallow their errors and return nothing.
    src = SERVER.read_text(encoding="utf-8")
    for fn in ("mailboxDisplayName", "threadHeadersFor"):
        start = src.index(f"async function {fn}")
        body = src[start:src.index("\n}\n", start)]
        assert "try {" in body and "catch" in body, f"{fn} can throw into a send"


def test_the_client_stands_alone():
    # Imported directly by its test, so it must not drag the service config in.
    src = CLIENT.read_text(encoding="utf-8")
    assert 'from "../config.js"' not in src
    assert "process.env.RESEND_API_KEY" in src


def test_a_reply_is_titled_after_what_it_answers():
    # Graph's reply endpoint built "Re: <subject>" for us, and the adapter sends
    # no subject at all on a reply. Falling back to a bare "Re:" shipped on
    # 2026-09-20 and the reply opened its own conversation in Gmail, which groups
    # on the subject as well as the References chain.
    src = SERVER.read_text(encoding="utf-8")
    assert "function replySubjectFor" in src
    start = src.index('req.url === "/internal/outlook-send"')
    handler = src[start:start + 6000]
    assert "replySubjectFor(thread.subject)" in handler
    assert '|| "Re:";' not in handler, "a reply must not fall back to a bare Re:"


def test_the_subject_of_the_answered_message_is_fetched():
    src = SERVER.read_text(encoding="utf-8")
    start = src.index("async function threadHeadersFor")
    body = src[start:src.index("\n}\n", start)]
    assert "subject" in body, "the subject must come back with the threading headers"


def test_re_is_not_stacked():
    # "Re: Re: Re:" is what happens when a reply to a reply re-prefixes blindly.
    src = SERVER.read_text(encoding="utf-8")
    start = src.index("function replySubjectFor")
    body = src[start:src.index("\n}\n", start)]
    assert "/^re:/i" in body


def test_a_reply_that_cannot_thread_says_so():
    # Silence here is what made this cost a whole test run to find: the send
    # succeeded, the mail arrived, and only the threading was wrong.
    src = SERVER.read_text(encoding="utf-8")
    assert "this will start a new thread" in src
