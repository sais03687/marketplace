"""Mail that never arrived has to leave a mark the buyer can see.

Sending looks like one step and is two. Graph accepts the message, the platform
logs "Sent", and delivery happens afterwards — so when it fails, the only record
is a bounce that lands back in the agent's own mailbox. The poller drops bounces
on purpose (handed to the agent, a delivery failure reads as an ordinary email
and it writes back to a mail daemon), and that was the end of it.

Found on 2026-09-20: Gmail began rejecting this domain outright, and an approval
request, a task reply and a creator notice all vanished. Everything on the
platform said the mail was sent. The agent looked like it had gone quiet.

The bounce is now recorded against the deployment and shown until dismissed.
The poller is JavaScript, so the parsing tests drive the real function out of
the file rather than reimplementing it.
"""
import json
import shutil
import subprocess
import textwrap
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
POLLER = ROOT / "apps" / "provisioning-service" / "src" / "jobs" / "outlook-poller.mjs"
ROUTE = (ROOT / "apps" / "web" / "app" / "api" / "deployments" / "[id]"
         / "delivery-failure" / "route.ts")
PAGE = (ROOT / "apps" / "web" / "app" / "(auth)" / "dashboard" / "agents"
        / "[deploymentId]" / "page.tsx")
SCHEMA = ROOT / "packages" / "db" / "prisma" / "schema.prisma"

needs_node = pytest.mark.skipif(shutil.which("node") is None,
                                reason="node is needed to exercise the poller")


def describe(body_html: str):
    """Run the poller's own describeBounce over an NDR body; return its result."""
    harness = textwrap.dedent(f"""
        import fs from "node:fs";
        const src = fs.readFileSync({json.dumps(str(POLLER))}, "utf8").replace(/\\r\\n/g, "\\n");
        const grab = (n) => {{
          const i = src.indexOf(`function ${{n}}`);
          if (i < 0) throw new Error("missing function " + n);
          return src.slice(i, src.indexOf("\\n}}\\n", i) + 2);
        }};
        const scope = {{}};
        new Function("out", [
          grab("htmlToPlainText"), grab("describeBounce"),
          "out({{ describeBounce }});",
        ].join("\\n"))((o) => Object.assign(scope, o));
        const msg = {{ body: {{ content: {json.dumps(body_html)} }} }};
        console.log(JSON.stringify(scope.describeBounce(msg)));
    """)
    proc = subprocess.run(["node", "--input-type=module", "-e", harness],
                          capture_output=True, text=True, timeout=60)
    assert proc.returncode == 0, proc.stderr
    return json.loads(proc.stdout)


# Exchange's own notice, of the shape seen in production.
EXCHANGE_NDR = """<html><body>
<p>Your message to someone@example.com couldn't be delivered.</p>
<p>Original Message Details</p>
<p>Sender Address: agent@agents.example.net<br>
Recipient Address: someone@example.com<br>
Subject: Action needed: your agent needs approval</p>
<p>Error Details</p>
<p>Error: 550 5.7.350 Remote server returned message detected as spam -&gt;
550 5.7.1 the receiving server rejected this message</p>
<p>Message rejected by: mx.example.com</p>
<p>Message Hops</p>
</body></html>"""

# The standard machine-readable form, which other mailers send instead.
RFC3464_NDR = """<html><body><pre>
Reporting-MTA: dns; mail.example.net
Final-Recipient: rfc822; someone@example.com
Action: failed
Status: 5.1.1
Diagnostic-Code: smtp; 550 5.1.1 The email account that you tried to reach does not exist
</pre></body></html>"""


@needs_node
def test_the_recipient_is_read_from_an_exchange_notice():
    got = describe(EXCHANGE_NDR)
    assert got["to"] == "someone@example.com"
    assert "550 5.7.350" in got["reason"]


@needs_node
def test_the_recipient_is_read_from_a_standard_delivery_report():
    # A second provider's layout, so the parsing is not one vendor's shape.
    got = describe(RFC3464_NDR)
    assert got["to"] == "someone@example.com"
    assert "does not exist" in got["reason"]


@needs_node
def test_the_reason_stops_before_the_diagnostic_boilerplate():
    # The buyer needs to know mail is not arriving and roughly why, not to read
    # a routing transcript.
    got = describe(EXCHANGE_NDR)
    assert "Message Hops" not in got["reason"]
    assert "Sender Address" not in got["reason"]
    assert len(got["reason"]) <= 500


@needs_node
def test_an_unreadable_notice_still_reports_the_failure():
    # A bounce nobody can parse is still a bounce. Returning nothing at all would
    # restore the silence this exists to end.
    got = describe("<html><body><p>Delivery to the recipient failed.</p></body></html>")
    assert got["to"] == ""
    assert isinstance(got["reason"], str)


def test_the_bounce_is_reported_not_only_logged():
    src = POLLER.read_text(encoding="utf-8")
    assert "reportDeliveryFailure" in src
    # Still dropped rather than handed to the agent — reporting it must not have
    # turned a mail daemon back into a correspondent.
    assert "delivery failure, not forwarded" in src
    assert "/delivery-failure" in src


def test_recording_a_failure_cannot_break_the_poll():
    src = POLLER.read_text(encoding="utf-8")
    start = src.index("async function reportDeliveryFailure")
    body = src[start:src.index("\n}\n", start)]
    assert "try {" in body and "catch" in body, "a failed report must not cost the mail behind it"


def test_the_failure_is_stored_on_the_deployment():
    schema = SCHEMA.read_text(encoding="utf-8")
    for field in ("lastDeliveryFailureAt", "lastDeliveryFailureTo", "lastDeliveryFailureReason"):
        assert field in schema


def test_only_the_agent_may_record_and_only_the_buyer_may_clear():
    route = ROUTE.read_text(encoding="utf-8")
    # Written by the deployment with its own token, like the heartbeat.
    assert "requireDeploymentToken" in route
    # Cleared by the person who can look in their own inbox. Nothing on the
    # platform honestly knows delivery has recovered.
    assert "export async function DELETE" in route
    assert "requireOrg" in route and "requireDeploymentAccess" in route


def test_the_buyer_is_told_what_it_means_for_them():
    page = PAGE.read_text(encoding="utf-8")
    assert "could not be delivered" in page
    # Not just "an email failed" — which email, and what they should do.
    assert "did not reach you" in page
    assert "spam" in page.lower()
    assert "dismissDeliveryFailure" in page
