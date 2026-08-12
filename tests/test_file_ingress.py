"""A file someone emails the agent has to be openable.

Until now it was not. An attachment small enough to read as text was inlined
into the prompt — 20 KB per file, 60 KB total — and everything else was written
to /data/attachments in the *agent* container and named. The sandbox container
has no mounts, so that path meant nothing to the only thing that can run code.
The agent could see that a workbook had arrived and had no way to open it.

Benchmark task T16 on 2026-08-12 is the whole story: an .xlsx arrived, the agent
correctly said it could not read it, and asked for the numbers to be pasted into
the email body instead. Good behaviour, real limitation, and the ceiling on
every task that starts with a real file.

Output already worked this way — the sandbox writes to /tmp/output/, the
platform holds the bytes, the model gets a handle. This is the same idea
pointing the other way, so the model passes handles in both directions and
never sees base64 in either.
"""
import base64
import asyncio
from pathlib import Path

import pytest

import adapter


RUNTIME = (Path(__file__).resolve().parents[1] /
           "apps" / "provisioning-service" / "src" / "templates" / "runtime" / "adapter.py")

XLSX = b"PK\x03\x04fake-workbook-bytes"


def _attachment(name, raw, ctype="application/octet-stream"):
    return {
        "filename": name,
        "contentType": ctype,
        "content_base64": base64.b64encode(raw).decode(),
    }


@pytest.fixture(autouse=True)
def _clean_registries():
    adapter._INBOUND_FILES.clear()
    yield
    adapter._INBOUND_FILES.clear()


def _handle_for(name):
    for handle, entry in adapter._INBOUND_FILES.items():
        if entry["name"] == name:
            return handle
    return None


# ── an unreadable attachment now arrives with a way in ──────────────────────

def test_a_binary_attachment_gets_a_handle():
    note = adapter._describe_inbound_attachments([_attachment("book.xlsx", XLSX)], "msg-1")
    handle = _handle_for("book.xlsx")
    assert handle is not None
    assert handle in note


def test_the_note_says_how_to_open_it():
    # The handle is useless if nothing says what to do with it.
    note = adapter._describe_inbound_attachments([_attachment("book.xlsx", XLSX)], "msg-1")
    assert "parse_xlsx" in note
    assert "input_files" in note
    assert "/tmp/input/" in note


def test_small_text_is_still_inlined_not_handed_over():
    # Inlining a small CSV is what makes "what is the total in the attached
    # file" answerable in one step. A handle would cost a round trip.
    note = adapter._describe_inbound_attachments(
        [_attachment("small.csv", b"a,b\n1,2\n", "text/csv")], "msg-1"
    )
    assert "--- BEGIN small.csv ---" in note
    assert _handle_for("small.csv") is None


def test_a_csv_too_big_to_inline_gets_a_handle_instead_of_being_dropped():
    # The case that used to fall off the end: textual, but over the prompt
    # ceiling, so neither inlined nor reachable.
    big = b"col_a,col_b\n" + b"1,2\n" * 20_000
    assert len(big) > adapter._ATTACHMENT_INLINE_LIMIT
    note = adapter._describe_inbound_attachments(
        [_attachment("big.csv", big, "text/csv")], "msg-1"
    )
    assert _handle_for("big.csv") is not None
    assert "--- BEGIN big.csv ---" not in note


def test_a_file_past_the_handle_ceiling_says_so():
    huge = b"x" * (adapter._ATTACHMENT_HANDLE_LIMIT + 1)
    note = adapter._describe_inbound_attachments([_attachment("huge.bin", huge)], "msg-1")
    assert _handle_for("huge.bin") is None
    assert "cannot be opened" in note


# ── the handle turns into bytes on the way to the sandbox ───────────────────

def test_parse_tools_get_real_base64():
    adapter._describe_inbound_attachments([_attachment("book.xlsx", XLSX)], "msg-1")
    handle = _handle_for("book.xlsx")

    resolved, unresolved = adapter._resolve_handles_in_arguments(
        "parse_xlsx", {"file_content_base64": handle}
    )
    assert unresolved == []
    assert base64.b64decode(resolved["file_content_base64"]) == XLSX


def test_execute_python_gets_named_files_to_stage():
    adapter._describe_inbound_attachments([_attachment("orders.csv", b"a,b\n1,2\n" * 5000)], "msg-1")
    handle = _handle_for("orders.csv")

    resolved, unresolved = adapter._resolve_handles_in_arguments(
        "execute_python", {"code": "print(1)", "input_files": [handle]}
    )
    assert unresolved == []
    staged = resolved["input_files"]
    assert len(staged) == 1
    # The name has to survive: code is written against /tmp/input/orders.csv.
    assert staged[0]["name"] == "orders.csv"
    assert base64.b64decode(staged[0]["content_base64"]).startswith(b"a,b")


def test_a_file_the_run_produced_can_be_read_back():
    # Both directions resolve through one lookup, so the agent can hand a tool
    # a file it was sent or one it just built without knowing which it holds.
    registered = adapter._register_sandbox_files(
        {"files": [{"name": "out.xlsx", "base64_content": base64.b64encode(XLSX).decode()}]}
    )
    # Read the handle back off the result rather than picking one out of the
    # registry: it is module-level and other tests leave their own files in it.
    produced = registered["files"][0]["file_id"]
    resolved, unresolved = adapter._resolve_handles_in_arguments(
        "parse_xlsx", {"file_content_base64": produced}
    )
    assert unresolved == []
    assert base64.b64decode(resolved["file_content_base64"]) == XLSX


def test_arguments_without_handles_are_untouched():
    args = {"code": "print(1)"}
    resolved, unresolved = adapter._resolve_handles_in_arguments("execute_python", args)
    assert resolved == args
    assert unresolved == []


def test_real_base64_is_not_mistaken_for_a_handle():
    # A creator's agent may pass content directly. Only the handle prefixes are
    # rewritten; anything else goes through as it was written.
    literal = base64.b64encode(XLSX).decode()
    resolved, unresolved = adapter._resolve_handles_in_arguments(
        "parse_xlsx", {"file_content_base64": literal}
    )
    assert resolved["file_content_base64"] == literal
    assert unresolved == []


# ── an invented handle is answered, not silently forwarded ──────────────────

def test_an_unknown_handle_is_reported():
    _, unresolved = adapter._resolve_handles_in_arguments(
        "parse_xlsx", {"file_content_base64": "inbound:doesnotexist"}
    )
    assert unresolved == ["inbound:doesnotexist"]


def test_the_error_lists_what_did_arrive():
    # Forwarded verbatim, the handle reaches the sandbox as a literal string
    # where base64 was expected, and the complaint is about malformed base64 —
    # which sends the agent off fixing the wrong thing.
    adapter._describe_inbound_attachments([_attachment("book.xlsx", XLSX)], "msg-1")
    err = adapter._unresolved_handle_error(["inbound:wrong"])
    assert "inbound:wrong" in err["error"]
    assert "book.xlsx" in err["error"]


def test_the_error_says_so_when_nothing_arrived():
    err = adapter._unresolved_handle_error(["inbound:wrong"])
    assert "No files arrived" in err["error"]


def test_the_wrapper_returns_the_error_instead_of_calling_the_sandbox(monkeypatch):
    called = []

    async def _never(server, tool, arguments):
        called.append(tool)
        return {}

    monkeypatch.setattr(adapter, "call_mcp_tool", _never)
    result = asyncio.run(
        adapter._resume_capturing_mcp_fn(
            "python-sandbox", "parse_xlsx", {"file_content_base64": "inbound:nope"}
        )
    )
    assert "error" in result
    assert called == [], "the sandbox was called with an unresolved handle"


# ── an inbound file is not a deliverable ────────────────────────────────────

def test_an_inbound_file_is_not_attached_to_the_reply():
    # Attaching it would post someone's own spreadsheet back to them.
    adapter.begin_run("email:ingress-test")
    adapter._describe_inbound_attachments([_attachment("book.xlsx", XLSX)], "msg-1")
    names = [a["name"] for a in adapter.run_attachments()]
    assert "book.xlsx" not in names


def test_an_inbound_file_is_not_in_the_verification_haystack():
    # Otherwise a figure could be "verified" against the input it was supposed
    # to be derived from, which checks nothing at all.
    adapter.begin_run("email:ingress-test")
    adapter._describe_inbound_attachments([_attachment("book.xlsx", XLSX)], "msg-1")
    assert all(not f.startswith("inbound:") for f in adapter.current_run_files())
