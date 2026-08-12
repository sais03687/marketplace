"""A reply that carries the work must carry the files the work produced.

On 2026-08-11 a run built a workbook and a chart, was gated for approval,
was approved, and delivered prose and nothing else. The first pass held its
captured files in a function-local closure; the resume had no closure to
inherit and passed no attachments at all. The chart was rendered in the
sandbox and discarded, because the reply was its only route out — and the
notebook, which is the whole record of the method, went with it.

The registry those files were already registered in survived the interrupt
perfectly well. The deliverable check read it post-resume and compared the
summary against the file. Delivery, three lines away, read nothing.
"""
import ast
import base64
import io
from pathlib import Path

import pytest

import adapter


RUNTIME = (Path(__file__).resolve().parents[1] /
           "apps" / "provisioning-service" / "src" / "templates" / "runtime" / "adapter.py")


def _sandbox_result(name: str, content: bytes):
    """An MCP envelope carrying one file, shaped as the sandbox returns it."""
    return {
        "stdout": "",
        "returncode": 0,
        "files": [{"name": name, "base64_content": base64.b64encode(content).decode()}],
    }


@pytest.fixture(autouse=True)
def _clean_run():
    adapter.begin_run("email:test-thread")
    yield
    adapter.begin_run("email:test-thread")


def _decoded(attachment):
    return base64.b64decode(attachment["content_base64"])


# ── what the run built travels with the reply ───────────────────────────────

def test_a_file_registered_before_the_gate_is_still_attached_after_it():
    # The interrupt happens between these two lines in a real run; the registry
    # is what carries the file across it.
    adapter._register_sandbox_files(_sandbox_result("book.xlsx", b"WORKBOOK"))
    attached = adapter.run_attachments()
    assert [a["name"] for a in attached] == ["book.xlsx"]
    assert _decoded(attached[0]) == b"WORKBOOK"


def test_the_chart_is_attached_too_not_just_the_workbook():
    # The chart had no other route out: it is not in the workbook and it was
    # never uploaded. If it is not attached, the buyer never receives it.
    adapter._register_sandbox_files(_sandbox_result("book.xlsx", b"WORKBOOK"))
    adapter._register_sandbox_files(_sandbox_result("chart.png", b"PNG"))
    assert {a["name"] for a in adapter.run_attachments()} == {"book.xlsx", "chart.png"}


def test_content_types_are_set_from_the_extension():
    adapter._register_sandbox_files(_sandbox_result("book.xlsx", b"X"))
    adapter._register_sandbox_files(_sandbox_result("chart.png", b"P"))
    by_name = {a["name"]: a["contentType"] for a in adapter.run_attachments()}
    assert by_name["book.xlsx"].endswith("spreadsheetml.sheet")
    assert by_name["chart.png"] == "image/png"


def test_a_run_that_built_nothing_attaches_nothing():
    assert adapter.run_attachments() == []


# ── a rebuild must not send both attempts ──────────────────────────────────

def test_a_rewritten_file_is_sent_once_and_it_is_the_corrected_one():
    # The verify loop hands back and the agent rewrites the same filename. The
    # buyer should get the fix, not the fix and the mistake side by side.
    adapter._register_sandbox_files(_sandbox_result("book.xlsx", b"FIRST-ATTEMPT"))
    adapter._register_sandbox_files(_sandbox_result("book.xlsx", b"CORRECTED"))
    attached = adapter.run_attachments()
    assert len(attached) == 1
    assert _decoded(attached[0]) == b"CORRECTED"


def test_distinct_files_are_all_kept_when_one_of_them_repeats():
    adapter._register_sandbox_files(_sandbox_result("book.xlsx", b"V1"))
    adapter._register_sandbox_files(_sandbox_result("chart.png", b"PNG"))
    adapter._register_sandbox_files(_sandbox_result("book.xlsx", b"V2"))
    attached = {a["name"]: _decoded(a) for a in adapter.run_attachments()}
    assert attached == {"book.xlsx": b"V2", "chart.png": b"PNG"}


# ── the notebook rides along, and comes last ───────────────────────────────

def test_the_notebook_is_included_when_there_are_steps_to_show():
    adapter.record_sandbox_step(
        "execute_python",
        {"code": "print('hi')"},
        {"stdout": "hi\n", "returncode": 0},
    )
    names = [a["name"] for a in adapter.run_attachments(request="do a thing")]
    assert "working.ipynb" in names


def test_the_notebook_comes_after_the_deliverables():
    # The workbook is the answer; the method is for whoever wants to check it.
    adapter._register_sandbox_files(_sandbox_result("book.xlsx", b"X"))
    adapter.record_sandbox_step("execute_python", {"code": "x=1"}, {"stdout": "", "returncode": 0})
    assert [a["name"] for a in adapter.run_attachments()][-1] == "working.ipynb"


def test_no_steps_means_no_empty_notebook():
    adapter._register_sandbox_files(_sandbox_result("book.xlsx", b"X"))
    assert [a["name"] for a in adapter.run_attachments()] == ["book.xlsx"]


# ── runs do not leak files into each other ─────────────────────────────────

def test_another_thread_does_not_inherit_this_run_s_files():
    adapter._register_sandbox_files(_sandbox_result("mine.xlsx", b"MINE"))
    adapter.begin_run("email:someone-else")
    assert adapter.run_attachments() == []


def test_returning_to_a_run_still_finds_its_files():
    # Which is exactly what a resume does: attach_run, then deliver.
    adapter._register_sandbox_files(_sandbox_result("book.xlsx", b"WORKBOOK"))
    adapter.begin_run("email:other")
    adapter.attach_run("email:test-thread")
    assert [a["name"] for a in adapter.run_attachments()] == ["book.xlsx"]


# ── every path that delivers the agent's answer must attach ────────────────
#
# The structural guard. The bug was not a wrong value, it was a call site that
# quietly omitted an argument, on a path nobody re-read after writing it. A
# fourth delivery path added later fails this test until it is classified.

def _delivery_call_sites():
    src = io.open(RUNTIME, encoding="utf-8").read()
    lines = src.splitlines()
    tree = ast.parse(src)
    sites = []
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Call) and getattr(node.func, "id", "") in ("send_email", "reply_email")):
            continue
        # The wrapper functions call each other; only look at call sites, and
        # skip the one inside reply_email's own fallback to send_email.
        kwargs = {k.arg for k in node.keywords if k.arg}
        preceding = "\n".join(lines[max(0, node.lineno - 4):node.lineno])
        sites.append({
            "line": node.lineno,
            "attaches": "attachments" in kwargs,
            "is_notice": "# notice:" in preceding,
        })
    return sites


def test_every_delivery_of_the_agents_answer_carries_its_files():
    unclassified = [
        s for s in _delivery_call_sites()
        if not s["attaches"] and not s["is_notice"]
    ]
    assert not unclassified, (
        "these send/reply sites neither attach files nor are marked '# notice:' — "
        f"a run's workbook would be dropped here: {unclassified}"
    )


def test_notices_are_not_quietly_attaching_deliverables():
    # A "waiting on approval" mail with the workbook stapled to it would be
    # delivering the result while claiming it has not happened yet.
    both = [s for s in _delivery_call_sites() if s["attaches"] and s["is_notice"]]
    assert not both, f"marked as a notice but attaching files: {both}"


def test_the_resume_path_attaches():
    # The specific regression. Named separately so the failure says so.
    src = io.open(RUNTIME, encoding="utf-8").read()
    tree = ast.parse(src)
    for fn in ast.walk(tree):
        if isinstance(fn, ast.AsyncFunctionDef) and fn.name == "_deliver_email_result":
            attaching = [
                n for n in ast.walk(fn)
                if isinstance(n, ast.Call)
                and getattr(n.func, "id", "") in ("send_email", "reply_email")
                and any(k.arg == "attachments" for k in n.keywords)
            ]
            assert len(attaching) >= 2, "the approved-run delivery path lost its files again"
            return
    pytest.fail("_deliver_email_result not found")
