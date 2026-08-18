"""A restart must not cost a run its files, or make it lie about them.

Task F3 on 2026-08-18 built its workbook at 02:53. The container was redeployed
at 03:10. The reply it composed at 03:15 told the buyer "the Excel workbook is
attached" and "the working is attached as working.ipynb", and the message
carried neither. Five uploads in the same window were refused with "not a file
id the platform is holding".

Two separate faults, and both are here.

The handles lived only in `_SANDBOX_FILES`, a dict in the process, while the
graph that produced them was checkpointed to disk and survived. The same
half-persisted shape the pending-resume directory was written to fix: the paused
work was recoverable and the files it had made were not.

And the sentence about the notebook was added by the agent on the strength of
having called the sandbox at some point. That is a proxy for the fact. After the
restart the proxy was still true and the attachment list was empty, so the two
came apart. It is added by the platform now, from the list actually going out.
"""
import json

import adapter


def test_a_produced_file_is_written_to_disk(tmp_path, monkeypatch):
    monkeypatch.setattr(adapter, "SANDBOX_FILES_DIR", tmp_path)
    adapter._persist_sandbox_file("sandbox:abc123", "report.xlsx", b"PK\x03\x04data")
    assert (tmp_path / "sandbox_abc123.bin").read_bytes() == b"PK\x03\x04data"
    assert json.loads((tmp_path / "sandbox_abc123.json").read_text())["name"] == "report.xlsx"


def test_the_handle_is_stored_rather_than_derived_from_the_filename(tmp_path, monkeypatch):
    # `_safe_handle` is lossy: rebuilding "sandbox:abc" from "sandbox_abc" holds
    # only while nothing else in a handle is replaced.
    monkeypatch.setattr(adapter, "SANDBOX_FILES_DIR", tmp_path)
    adapter._persist_sandbox_file("sandbox:abc123", "report.xlsx", b"x")
    assert json.loads((tmp_path / "sandbox_abc123.json").read_text())["handle"] == "sandbox:abc123"


def test_a_restart_gets_the_files_back(tmp_path, monkeypatch):
    monkeypatch.setattr(adapter, "SANDBOX_FILES_DIR", tmp_path)
    monkeypatch.setattr(adapter, "RUN_FILES_DIR", tmp_path / "runs")
    (tmp_path / "runs").mkdir()
    adapter._persist_sandbox_file("sandbox:f3", "utilisation.xlsx", b"PK\x03\x04")

    # Wipe memory, as a restart does.
    monkeypatch.setattr(adapter, "_SANDBOX_FILES", {})
    monkeypatch.setattr(adapter, "_RUN_FILES", {})
    adapter._restore_files_from_disk()

    assert adapter._SANDBOX_FILES["sandbox:f3"]["name"] == "utilisation.xlsx"
    assert adapter._SANDBOX_FILES["sandbox:f3"]["bytes"] == b"PK\x03\x04"


def test_a_run_gets_its_own_files_back_not_everyone_elses(tmp_path, monkeypatch):
    monkeypatch.setattr(adapter, "SANDBOX_FILES_DIR", tmp_path)
    runs = tmp_path / "runs"; runs.mkdir()
    monkeypatch.setattr(adapter, "RUN_FILES_DIR", runs)
    adapter._persist_sandbox_file("sandbox:mine", "a.xlsx", b"a")
    adapter._persist_sandbox_file("sandbox:theirs", "b.xlsx", b"b")
    (runs / "thread_one.json").write_text(json.dumps(["sandbox:mine"]))

    monkeypatch.setattr(adapter, "_SANDBOX_FILES", {})
    monkeypatch.setattr(adapter, "_RUN_FILES", {})
    adapter._restore_files_from_disk()
    assert adapter._RUN_FILES["thread_one"] == ["sandbox:mine"]


def test_bytes_with_no_index_entry_are_ignored(tmp_path, monkeypatch):
    # A crash between the two writes leaves bytes with no name. Ignoring them is
    # the safe half; the reverse would be an entry pointing at nothing.
    monkeypatch.setattr(adapter, "SANDBOX_FILES_DIR", tmp_path)
    monkeypatch.setattr(adapter, "RUN_FILES_DIR", tmp_path / "runs")
    (tmp_path / "runs").mkdir()
    (tmp_path / "sandbox_orphan.bin").write_bytes(b"nameless")
    monkeypatch.setattr(adapter, "_SANDBOX_FILES", {})
    adapter._restore_files_from_disk()
    assert adapter._SANDBOX_FILES == {}


def test_a_restore_never_raises_on_junk(tmp_path, monkeypatch):
    monkeypatch.setattr(adapter, "SANDBOX_FILES_DIR", tmp_path)
    monkeypatch.setattr(adapter, "RUN_FILES_DIR", tmp_path / "runs")
    (tmp_path / "runs").mkdir()
    (tmp_path / "sandbox_bad.json").write_text("{not json")
    (tmp_path / "sandbox_bad.bin").write_bytes(b"x")
    monkeypatch.setattr(adapter, "_SANDBOX_FILES", {})
    adapter._restore_files_from_disk()


def test_eviction_removes_the_copy_on_disk_too(tmp_path, monkeypatch):
    # Otherwise the directory grows without bound, and a restore resurrects a
    # file the ceilings had already rejected.
    monkeypatch.setattr(adapter, "SANDBOX_FILES_DIR", tmp_path)
    reg = {}
    for i in range(4):
        h = f"sandbox:e{i}"
        reg[h] = {"name": f"f{i}.xlsx", "bytes": b"x" * 10}
        adapter._persist_sandbox_file(h, f"f{i}.xlsx", b"x" * 10)
    adapter._evict_to_fit(reg, 2, 10_000)
    assert len(reg) == 2
    assert not (tmp_path / "sandbox_e0.bin").exists()


# ── and the claim follows the attachment, not a proxy ──────────────────────

def test_the_notebook_is_mentioned_when_it_is_actually_going():
    out = adapter.note_the_notebook(
        "Team utilisation is 82.50%.",
        [{"name": "utilisation.xlsx"}, {"name": "working.ipynb"}],
    )
    assert "working.ipynb" in out


def test_it_is_not_mentioned_when_nothing_is_attached():
    # F3 exactly: a correct reply that claimed a notebook the message did not
    # carry, because the registry had been wiped by a redeploy.
    out = adapter.note_the_notebook("Team utilisation is 82.50%.", [])
    assert "ipynb" not in out
    assert out == "Team utilisation is 82.50%."


def test_it_is_not_mentioned_when_only_a_workbook_goes():
    out = adapter.note_the_notebook("Total overcharge: 97.00", [{"name": "freight.xlsx"}])
    assert "ipynb" not in out


def test_a_reply_that_already_mentions_it_is_left_alone():
    text = "Here it is. See working.ipynb for the steps."
    assert adapter.note_the_notebook(text, [{"name": "working.ipynb"}]) == text


def test_an_empty_reply_is_not_given_a_note_to_carry():
    assert adapter.note_the_notebook("", [{"name": "working.ipynb"}]) == ""


def test_the_agent_no_longer_claims_it_from_a_proxy():
    import io
    from pathlib import Path
    src = io.open(
        Path(__file__).resolve().parents[1] / "agents" / "data-analyst" / "agent.py",
        encoding="utf-8",
    ).read()
    code = "\n".join(l for l in src.splitlines() if not l.lstrip().startswith("#"))
    assert "The working is attached as working.ipynb" not in code, (
        "the agent asserted an attachment from 'did this run use the sandbox'"
    )
