"""A reviewer should read the agent's answer, not the envelope around it.

The vetting harness truncates every HTTP body to 500 characters for the report,
which is right — nobody wants a wall of JSON in a step. But the manual test then
parsed that truncated string to pull out the reply, and a reply longer than 500
characters is no longer valid JSON. The parse failed, the code fell back to the
raw body, and the reviewer saw:

    {"ok":true,"action":"reply_email","text":"The high number of tickets …

Short replies parsed fine, so this only ever went wrong on the agents with the
most to say. Seen on 2026-10-03 reviewing the template agent.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VET = (ROOT / "apps" / "provisioning-service" / "src" / "jobs" / "vet-package.ts").read_text(encoding="utf-8")


def _run_fetch_block() -> str:
    start = VET.index("async function runFetch(")
    return VET[start : VET.index("// Built-in platform tests", start)]


def test_the_untruncated_body_is_available_to_callers():
    block = _run_fetch_block()
    assert "fullBody: raw" in block
    # And the report still gets the short one.
    assert "raw.slice(0, 500)" in block


def _manual_test_block() -> str:
    # The call site, not the comment that mentions the same path two hundred
    # lines earlier.
    start = VET.index("runFetch(`${base}/internal/run-sync`")
    return VET[start : start + 1200]


def test_the_manual_test_parses_the_untruncated_body():
    block = _manual_test_block()
    assert "JSON.parse(res.fullBody)" in block, (
        "parsing the truncated body is what printed the raw JSON envelope at the reviewer"
    )


def test_a_failed_parse_still_shows_something():
    # An agent that answers with something other than JSON should still have its
    # output shown, not swallowed.
    block = _manual_test_block()
    assert "catch { reply = res.responseBody" in block
