"""The agent is told who its manager is, rather than inferring it.

A buyer's address lives in two places that do not talk to each other: the
Manager Email field, which decides where mail is sent and who may write to the
agent, and the team list the buyer typed during onboarding, which is what the
agent actually reasons from. Changing the first leaves the second stale, and
nothing says so.

On 2026-09-20 that cost three runs. The buyer's address had been changed to a
personal one; mail reached the agent correctly, and the agent then stopped on
every task to ask why a stranger was writing to it — having correctly spotted a
mismatch the platform had manufactured.

Comparing two addresses is not a judgement call, so the platform states the
manager on the record alongside the sender and says whether they match.
"""
import json
import shutil
import subprocess
import textwrap
from pathlib import Path

import pytest

POLLER = (Path(__file__).resolve().parents[1] /
          "apps" / "provisioning-service" / "src" / "jobs" / "outlook-poller.mjs")

pytestmark = pytest.mark.skipif(shutil.which("node") is None,
                                reason="node is needed to exercise the poller")


def build(**kwargs):
    """Run the poller's own buildAgentMessage and return the text.

    `from` is a Python keyword, so the sender is passed as `sender=`.
    """
    kwargs["from"] = kwargs.pop("sender")
    harness = textwrap.dedent(f"""
        import fs from "node:fs";
        const src = fs.readFileSync({json.dumps(str(POLLER))}, "utf8").replace(/\\r\\n/g, "\\n");
        const grab = (n) => {{
          const i = src.indexOf(`function ${{n}}`);
          if (i < 0) throw new Error("missing function " + n);
          return src.slice(i, src.indexOf("\\n}}\\n", i) + 2);
        }};
        const scope = {{}};
        new Function("out", [grab("buildAgentMessage"), "out({{ buildAgentMessage }});"].join("\\n"))
          ((o) => Object.assign(scope, o));
        console.log(JSON.stringify(scope.buildAgentMessage({json.dumps(kwargs)})));
    """)
    proc = subprocess.run(["node", "--input-type=module", "-e", harness],
                          capture_output=True, text=True, timeout=60)
    assert proc.returncode == 0, proc.stderr
    return json.loads(proc.stdout)


REQ = "Total these figures."


def test_mail_from_the_manager_is_named_as_such():
    text = build(sender="Sai Suram <sai@personal.example>", subject="Totals",
                 threadId="t1", request=REQ, managerEmail="sai@personal.example")
    assert "IS your manager" in text
    assert "sai@personal.example" in text


def test_the_match_ignores_case_and_the_display_name():
    # The From header is "Name <addr>"; the record is a bare address.
    text = build(sender="Sai Suram <SAI@Personal.Example>", subject="Totals",
                 threadId="t1", request=REQ, managerEmail="sai@personal.example")
    assert "IS your manager" in text


def test_mail_from_anyone_else_is_marked_as_someone_else():
    text = build(sender="Stranger <who@elsewhere.example>", subject="Totals",
                 threadId="t1", request=REQ, managerEmail="sai@personal.example")
    assert "is someone else" in text
    assert "sai@personal.example" in text


def test_nothing_is_claimed_when_the_platform_has_no_record():
    # Saying nothing is right here: an empty record is not evidence either way,
    # and inventing a verdict from it would be worse than leaving the agent to
    # ask.
    text = build(sender="Sai Suram <sai@personal.example>", subject="Totals",
                 threadId="t1", request=REQ, managerEmail="")
    assert "manager" not in text.split("## THE REQUEST")[1].lower()


def test_the_request_itself_is_untouched():
    text = build(sender="Sai Suram <sai@personal.example>", subject="Totals",
                 threadId="t1", request=REQ, managerEmail="sai@personal.example")
    assert text.rstrip().endswith(REQ), "the actionable section must still end with the request"


def test_the_poller_passes_the_address_it_already_holds():
    src = POLLER.read_text(encoding="utf-8")
    assert "managerEmail: allowlistCache.managerEmail" in src
