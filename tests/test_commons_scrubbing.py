"""What goes into the commons is read by every company running the agent.

`runGuardrails` took `title`, `content` and `context`, and scrubbed only
`content`. `context` is where the run's own preamble lands — the requester's
address, their subject line, their Microsoft thread id — and AgentMind serves
approved contributions to every deployment of an agent, in every company.

On 2026-08-19, 22 of the 23 approved contributions carried a real manager's
address, their internal subject lines and their thread ids. The scrubber always
knew how to catch an email; nothing pointed it at the field that had one.

The behaviour is checked in test_commons_scrubbing.mjs, against the shipped
function. The wiring is checked here, because the hole was never in the scrubber.
"""
import io
import shutil
import subprocess
from pathlib import Path

import pytest

WEB = Path(__file__).resolve().parents[1] / "apps" / "web"
SCRIPT = Path(__file__).resolve().parent / "test_commons_scrubbing.mjs"


@pytest.mark.skipif(shutil.which("node") is None, reason="node is needed")
def test_the_scrubbing_behaves():
    r = subprocess.run(
        ["node", "--experimental-strip-types", str(SCRIPT)],
        capture_output=True, text=True, cwd=SCRIPT.parent.parent,
    )
    print(r.stdout or r.stderr)
    assert r.returncode == 0, r.stdout + r.stderr
    assert r.stdout.count("ok   ") >= 7, r.stdout


def test_the_route_stores_the_scrubbed_context():
    """Scrubbing it and then storing the original would fool every test above."""
    src = io.open(WEB / "app" / "api" / "agentmind" / "contribute" / "route.ts", encoding="utf-8").read()
    assert "context: safeContext || null," in src
    assert "context: context || null," not in src, "the raw context is still being stored"


def test_the_guardrails_return_the_scrubbed_context():
    src = io.open(WEB / "lib" / "agentmind" / "guardrails.ts", encoding="utf-8").read()
    assert "sanitizedContext" in src
    body = src[src.index("export function runGuardrails"):]
    assert "scrubPii(input.context)" in body, "context never reaches the scrubber"


def test_a_thread_id_is_treated_as_something_to_remove():
    # It identifies somebody else's conversation and teaches nothing — and until
    # this morning, a thread id plus a deployment id read that thread's pending
    # drafts without authenticating.
    src = io.open(WEB / "lib" / "agentmind" / "guardrails.ts", encoding="utf-8").read()
    assert 'name: "thread_id"' in src
