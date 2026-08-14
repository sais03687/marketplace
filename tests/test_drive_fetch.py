"""A file already in the workspace has to reach the sandbox too.

`a82b9c4` gave an emailed attachment a handle that resolves to bytes on the way
to the sandbox. The more common case was left open: the data is in the shared
folder, not in the mail. `drive_read_text` returns the content as a string into
the model's context, where RESULT_CHAR_LIMIT cuts it at 2000 characters — fine
for a note, useless for a dataset, and impossible for an .xlsx, which is binary.

So a workspace file big enough to be worth analysing could not be analysed at
all: too big to read, and with no way to reach the only thing that can open it.
Measured on 2026-08-13 while sizing DABstep, whose payments.csv is 23.58 MB —
about 12,000 times what the model is allowed to see of it.
"""
import io
from pathlib import Path

import pytest

import adapter
from creator import agent

AGENT_SRC = (Path(__file__).resolve().parents[1] /
             "agents" / "data-analyst" / "agent.py")
RUNTIME = (Path(__file__).resolve().parents[1] /
           "apps" / "provisioning-service" / "src" / "templates" / "runtime" / "adapter.py")
SIDECAR = (Path(__file__).resolve().parents[1] /
           "apps" / "provisioning-service" / "src" / "mcp" / "sidecar-manager.ts")

CSV = b"psp_reference,merchant,eur_amount\n" + b"1,Crossfit_Hanna,12.50\n" * 5000


@pytest.fixture
def workspace(monkeypatch):
    """A drive holding one file, and the platform's real handle registry."""
    class _MT:
        calls = []

        @staticmethod
        async def drive_download(item_id):
            _MT.calls.append(item_id)
            return "payments.csv", CSV

    monkeypatch.setattr(agent, "_mt", _MT)
    agent.set_file_registrar(adapter._register_inbound_file)
    yield _MT
    agent.set_file_registrar(None)


# ── the file gets a handle, and the model never sees the bytes ─────────────

def test_the_content_never_reaches_the_model(workspace):
    handle = adapter._register_inbound_file("payments.csv", CSV)
    resolved = adapter.resolve_file_handle(handle)
    assert resolved["bytes"] == CSV
    assert handle.startswith("inbound:")
    # The handle is a short token, not a payload: that is the whole mechanism.
    assert len(handle) < 40


def test_the_registrar_refuses_what_it_cannot_hold():
    too_big = b"x" * (adapter._ATTACHMENT_HANDLE_LIMIT + 1)
    assert adapter._register_inbound_file("huge.csv", too_big) is None


def test_a_workspace_file_and_an_emailed_one_resolve_the_same_way():
    # Same registry, so the sandbox tools need no idea which kind they hold.
    a = adapter._register_inbound_file("from_mail.csv", CSV)
    b = adapter._register_inbound_file("from_drive.csv", CSV)
    assert adapter.resolve_file_handle(a)["bytes"] == adapter.resolve_file_handle(b)["bytes"]


# ── the action itself ──────────────────────────────────────────────────────

def test_the_action_reports_the_handle_and_the_size_and_not_the_data(workspace):
    src = io.open(AGENT_SRC, encoding="utf-8").read()
    i = src.index('action_type == "drive_fetch"')
    block = src[i:src.index('elif action_type ==', i + 10)]
    assert "_file_registrar(name, raw)" in block
    assert "len(raw)" in block, "the size is the useful part for the model"
    # The one thing that must never appear: the content itself.
    for leak in ("result_text = content", "raw.decode", "base64"):
        assert leak not in block, f"drive_fetch is putting file content in the reply: {leak}"


def test_the_action_says_what_to_do_with_the_handle(workspace):
    src = io.open(AGENT_SRC, encoding="utf-8").read()
    i = src.index('action_type == "drive_fetch"')
    block = src[i:src.index('elif action_type ==', i + 10)]
    # A handle with no instructions is how the model ends up pasting it as data.
    # Names rather than handles now: the sandbox accepts them, and the name is
    # what the model will already have written into its code.
    assert "input_files" in block and "/tmp/input/" in block


def test_a_file_too_large_to_hold_says_so_rather_than_failing_silently(workspace):
    src = io.open(AGENT_SRC, encoding="utf-8").read()
    i = src.index('action_type == "drive_fetch"')
    block = src[i:src.index('elif action_type ==', i + 10)]
    assert "Could not fetch" in block
    assert "past the size the platform holds" in block


# ── wired everywhere, like the resolver it mirrors ─────────────────────────

def test_every_call_site_passes_the_registrar():
    src = io.open(RUNTIME, encoding="utf-8").read()
    resolvers = src.count("file_resolver_fn=resolve_sandbox_file")
    registrars = src.count("file_registrar_fn=_register_inbound_file")
    assert registrars == resolvers, (
        f"{resolvers} call sites resolve handles but only {registrars} can make one"
    )


def test_a_truncated_read_says_it_was_truncated():
    # The cut was silent: the model asked for a 531 KB fee table on 2026-08-14,
    # got its first 2000 characters with nothing marking the end, and answered
    # from the fragment. Same shape as reading the front of a traceback — the
    # information is missing and nothing says so.
    src = io.open(AGENT_SRC, encoding="utf-8").read()
    i = src.index('action_type == "drive_read_text"')
    block = src[i:src.index('elif action_type ==', i + 10)]
    assert "content[:2000]" in block
    assert "TRUNCATED" in block, "a silent cut lets the model answer from a fragment"
    assert "len(content)" in block, "say how much was withheld, not just that some was"
    assert "drive_fetch" in block, "name the tool that would have worked"


def test_the_truncation_notice_only_fires_when_something_was_cut():
    src = io.open(AGENT_SRC, encoding="utf-8").read()
    i = src.index('action_type == "drive_read_text"')
    block = src[i:src.index('elif action_type ==', i + 10)]
    assert "elif len(content) > 2000:" in block


def test_the_model_is_told_which_tool_to_use_for_data():
    src = io.open(AGENT_SRC, encoding="utf-8").read()
    assert "| drive_fetch | Hand workspace files" in src, (
        "the action is not in the table the model reads")
    i = src.index("| drive_fetch | Hand workspace files")
    row = src[i:src.index("\n", i)]
    assert "2000 characters" in row, (
        "the row must say why drive_read_text is the wrong tool for a dataset, "
        "or the model will keep reaching for the one it already knows"
    )


# ── the sandbox has to be able to hold what we now hand it ─────────────────

def test_the_sandbox_can_hold_a_dabstep_sized_file():
    # Measured 2026-08-13: a 20 MB CSV is 82 MB as a DataFrame with 105 MB peak
    # RSS. payments.csv is 23.58 MB, and DABstep joins it against other files.
    src = io.open(SIDECAR, encoding="utf-8").read()
    i = src.index('"python-sandbox": { memory')
    assert "768 * 1024 * 1024" in src[i:i + 200], "the sandbox is back under 768 MB"


def test_the_staging_area_can_hold_it_too():
    # /tmp is where inbound files land and outputs are written, and it is a
    # tmpfs — 23.58 MB of a 64 MB budget left almost nothing for the output.
    src = io.open(SIDECAR, encoding="utf-8").read()
    assert 'size=128m' in src
    assert 'size=64m' not in src
