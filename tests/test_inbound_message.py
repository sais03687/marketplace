"""How an inbound email is taken apart before the agent sees it.

Everything that went wrong on 2026-08-11 had one shape: the agent received a
concatenation — approval block, the request, the quoted thread, shared lessons —
and had to guess which part was the job. It guessed wrong four separate ways.

The poller is JavaScript, so these drive the real functions out of the file
rather than reimplementing them. Reimplementing would test the copy.
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


def run_in_poller(body: str):
    """Execute `body` with the poller's own helpers in scope; return its JSON."""
    harness = textwrap.dedent(f"""
        import fs from "node:fs";
        const src = fs.readFileSync({json.dumps(str(POLLER))}, "utf8").replace(/\\r\\n/g, "\\n");
        const grab = (n) => {{
          const i = src.indexOf(`function ${{n}}`);
          if (i < 0) throw new Error("missing function " + n);
          return src.slice(i, src.indexOf("\\n}}\\n", i) + 2);
        }};
        const grabConst = (n) => {{
          const i = src.indexOf(`const ${{n}} =`);
          if (i < 0) throw new Error("missing const " + n);
          return src.slice(i, src.indexOf("\\n];\\n", i) + 4);
        }};
        const scope = {{}};
        new Function("out", [
          grabConst("QUOTE_MARKERS"),
          grab("htmlToPlainText"), grab("splitQuotedHistory"),
          grab("trimHistory"), grab("buildAgentMessage"),
          grab("isEmptyMessage"), grab("isAutoSubmitted"),
          "out({{ htmlToPlainText, splitQuotedHistory, trimHistory, buildAgentMessage, isEmptyMessage, isAutoSubmitted }});",
        ].join("\\n"))((o) => Object.assign(scope, o));
        const {{ htmlToPlainText, splitQuotedHistory, trimHistory, buildAgentMessage,
                 isEmptyMessage, isAutoSubmitted }} = scope;
        {body}
    """)
    proc = subprocess.run(["node", "--input-type=module", "-e", harness],
                          capture_output=True, text=True, timeout=60)
    assert proc.returncode == 0, proc.stderr
    return json.loads(proc.stdout)


REQUEST = "Build a spreadsheet for the WEST region. WEST revenue 748000, units 3400."
QUOTED = ("From: Data Analyst Two (Agent) <agent@x.com>\\n"
          "Sent: Tuesday, August 11, 2026 11:16 AM\\n\\n"
          "Hi Sai,\\nThe revenue per unit for APAC is 222.00.")


def test_the_request_is_separated_from_the_quoted_thread():
    got = run_in_poller(f"""
        const r = splitQuotedHistory({json.dumps(REQUEST + chr(10) + chr(10))} + "{QUOTED}");
        console.log(JSON.stringify({{ head: r.head.trim(), quoted: r.quoted }}));
    """)
    assert got["head"] == REQUEST
    assert "222.00" in got["quoted"]
    assert "748000" not in got["quoted"]


def test_a_message_with_no_quoting_is_all_request():
    got = run_in_poller(f"""
        const r = splitQuotedHistory({json.dumps(REQUEST)});
        console.log(JSON.stringify({{ head: r.head.trim(), quoted: r.quoted }}));
    """)
    assert got["head"] == REQUEST
    assert got["quoted"] == ""


def test_history_is_trimmed_from_the_newest_end_and_says_so():
    # A reply chain is ordered newest-first, so a tail cut would keep the
    # archaeology and discard what was just said.
    got = run_in_poller("""
        const long = Array.from({length: 40}, (_, i) =>
          `From: Someone\\nSent: day ${i}\\n\\nturn ${i} ` + "x".repeat(120)).join("\\n\\n");
        const t = trimHistory(long, 4000);
        console.log(JSON.stringify({ len: t.length, first: t.includes("turn 0"),
                                     last: t.includes("turn 39"), marked: /omitted/i.test(t) }));
    """)
    assert got["len"] <= 4300
    assert got["first"] is True
    assert got["last"] is False
    assert got["marked"] is True


def test_the_request_is_the_last_thing_the_model_reads():
    # Proximity is what the closing-pass failure showed actually carries weight.
    got = run_in_poller(f"""
        const out = buildAgentMessage({{
          from: "Sai <s@x.com>", subject: "Q3", threadId: "t1",
          request: {json.dumps(REQUEST)},
          conversation: "{QUOTED}",
          awaitingDecision: "Awaiting: ID abc123 drive_upload",
          knowledge: "[AgentMind] Pivot tables get faster approval.",
        }});
        console.log(JSON.stringify({{
          endsWithRequest: out.trimEnd().endsWith({json.dumps(REQUEST)}),
          reqAfterHistory: out.indexOf({json.dumps(REQUEST)}) > out.indexOf("222.00"),
          reqAfterApprovals: out.indexOf({json.dumps(REQUEST)}) > out.indexOf("abc123"),
          reqAfterKnowledge: out.indexOf({json.dumps(REQUEST)}) > out.indexOf("Pivot tables"),
          labelled: ["THE REQUEST", "Earlier in this thread", "Awaiting a manager",
                     "other agents"].every((s) => out.includes(s)),
          saysReferenceOnly: /never a new instruction/.test(out),
        }}));
    """)
    assert all(got.values()), got


def test_absent_sections_leave_no_empty_headings():
    got = run_in_poller(f"""
        const out = buildAgentMessage({{
          from: "Sai <s@x.com>", subject: "Q3", threadId: "t1",
          request: {json.dumps(REQUEST)}, conversation: "", awaitingDecision: "", knowledge: "",
        }});
        console.log(JSON.stringify({{
          history: out.includes("Earlier in this thread"),
          approvals: out.includes("Awaiting a manager"),
          knowledge: out.includes("other agents"),
          hasRequest: out.includes({json.dumps(REQUEST)}),
          length: out.length,
        }}));
    """)
    assert got["history"] is False and got["approvals"] is False and got["knowledge"] is False
    assert got["hasRequest"] is True
    assert got["length"] < len(REQUEST) + 400


def test_a_reply_with_nothing_typed_is_recognised():
    # An empty reply still arrives full of text — the quoted thread. Handed that,
    # the agent read its own previous answer and sent it back as new work.
    got = run_in_poller("""
        const quoted = "<div>From: Agent<br>The revenue per unit for APAC is 222.00.</div>";
        console.log(JSON.stringify({
          empty:      isEmptyMessage({uniqueBody:{content:"<div><br></div>"}, body:{content:quoted}}),
          whitespace: isEmptyMessage({uniqueBody:{content:"<p>&nbsp;</p><br>"}, body:{content:quoted}}),
          real:       isEmptyMessage({uniqueBody:{content:"<div>Do the thing</div>"}, body:{content:quoted}}),
          attachment: isEmptyMessage({uniqueBody:{content:""}, hasAttachments:true, body:{content:quoted}}),
          unknown:    isEmptyMessage({body:{content:quoted}}),
        }));
    """)
    assert got["empty"] is True
    assert got["whitespace"] is True
    assert got["real"] is False
    assert got["attachment"] is False, "a file is content"
    assert got["unknown"] is False, "absent uniqueBody means unknown, not empty"


def test_auto_replies_are_not_answered():
    got = run_in_poller("""
        console.log(JSON.stringify({
          auto:  isAutoSubmitted({internetMessageHeaders:[{name:"Auto-Submitted",value:"auto-replied"}]}),
          no:    isAutoSubmitted({internetMessageHeaders:[{name:"Auto-Submitted",value:"no"}]}),
          human: isAutoSubmitted({internetMessageHeaders:[{name:"Subject",value:"hi"}]}),
        }));
    """)
    assert got["auto"] is True
    assert got["no"] is False
    assert got["human"] is False
