"""Only what the sender just wrote is the request; the quoted thread is history.

On 2026-10-17 a buyer replied in Gmail "Do you have the routes and sumo
animations?". Exchange's uniqueBody counted the whole quoted thread as new, the
poller trusted it, and the Route Planner re-planned from the stop list quoted
underneath - answering a question with a worse plan.
"""
import io
import json
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
POLLER = io.open(ROOT / "apps" / "provisioning-service" / "src" / "jobs" / "outlook-poller.mjs", encoding="utf-8").read()


def _split(text: str) -> dict:
    if not shutil.which("node"):
        pytest.skip("node not installed")
    start = POLLER.index("const QUOTE_MARKERS = [")
    end = POLLER.index("// A reply chain is ordered newest-first")
    code = POLLER[start:end] + f";console.log(JSON.stringify(splitQuotedHistory({json.dumps(text)})))"
    out = subprocess.run(["node", "-e", code], capture_output=True, text=True, timeout=30)
    assert out.returncode == 0, out.stderr
    return json.loads(out.stdout)


GMAIL_WRAPPED = (
    "Do you have the routes and sumo animations?\n\n"
    "On Sat, Oct 17, 2026 at 3:59 PM Route Planner Demo <route-planner-acme-corp-z55zardr@\n"
    "agents.agentstore.it.com> wrote:\n\n"
    "> 8 stops, 2 van(s), capacity 40 each\n"
    "> 1. Fountain Square Pantry, 39.7517, -86.1301, 12 crates\n"
)


def test_a_wrapped_gmail_marker_still_splits():
    out = _split(GMAIL_WRAPPED)
    assert out["head"].strip() == "Do you have the routes and sumo animations?"
    assert "Fountain Square" in out["quoted"]


def test_quoted_lines_alone_are_history():
    out = _split("Thanks!\n\n> 1. Fountain Square Pantry, 39.75, -86.13\n> 2. Garfield Park, 39.73, -86.14\n")
    assert out["head"].strip() == "Thanks!"


def test_a_plain_request_is_untouched():
    text = "Plan these:\n- A: 39.75, -86.13 - 5 crates\n- B: 39.73, -86.14 - 6 crates"
    assert _split(text)["head"] == text


def test_uniquebody_is_split_too():
    assert "splitQuotedHistory(uniquePlain).head" in POLLER
