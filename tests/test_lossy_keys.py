"""A fixture that survives a transform unchanged cannot test the transform.

On 2026-08-18 the file-persistence fix shipped green and did not work. The
per-run index was written to `_safe_handle(thread_id) + ".json"` and restored
from `idx.stem`, so every lookup for the real key missed:

    written to   email_hook_agentmail_AAQ...t8_.json
    asked for    email:hook:agentmail:AAQ...t8=

Six tests covered that code and all passed, because the fixture was
`thread_one` — which `_safe_handle` returns unchanged. The test round-tripped
through the same helper, both sides agreed on a key that was never rewritten,
and the lossiness had nothing to bite on. The sandbox handle escaped the same
bug only because `sandbox:abc` visibly becomes `sandbox_abc` and that was
noticed by eye.

So these tests do two things the earlier ones did not: they use keys that the
sanitiser actually changes, and they assert on the *original* key rather than
the derived one.
"""
import json

import pytest

import adapter

# Keys as they really arrive. Every one of these is rewritten by `_safe_handle`;
# a fixture that is not would prove nothing.
REAL_KEYS = [
    "email:hook:agentmail:AAQkADI1N2Y5MTE3LTE1MDctNGY0Yy1iYzQ5=",
    "sandbox:475da27ccff1",
    "teams:19:meeting_NzQ4OA@thread.v2",
    "email:hook:agentmail:a+b/c=d",
]


@pytest.mark.parametrize("key", REAL_KEYS)
def test_the_fixture_is_not_a_fixed_point(key):
    """The guard on every test below: if this fails, the others prove nothing."""
    assert adapter._safe_handle(key) != key, (
        f"{key!r} survives sanitisation unchanged, so it cannot exercise it"
    )


@pytest.mark.parametrize("key", REAL_KEYS)
def test_a_run_index_round_trips_on_the_key_it_was_written_with(key, tmp_path, monkeypatch):
    monkeypatch.setattr(adapter, "SANDBOX_FILES_DIR", tmp_path)
    runs = tmp_path / "runs"; runs.mkdir()
    monkeypatch.setattr(adapter, "RUN_FILES_DIR", runs)
    monkeypatch.setattr(adapter, "_SANDBOX_FILES", {})
    monkeypatch.setattr(adapter, "_RUN_FILES", {key: ["sandbox:h1"]})
    adapter._persist_sandbox_file("sandbox:h1", "out.xlsx", b"PK")
    adapter._persist_run_files(key)

    monkeypatch.setattr(adapter, "_SANDBOX_FILES", {})
    monkeypatch.setattr(adapter, "_RUN_FILES", {})
    adapter._restore_files_from_disk()

    # The original key, not `_safe_handle(key)`. Asserting on the derived form is
    # how the earlier suite agreed with itself.
    assert key in adapter._RUN_FILES
    assert adapter._RUN_FILES[key] == ["sandbox:h1"]


@pytest.mark.parametrize("handle", ["sandbox:475da27ccff1", "sandbox:a+b/c="])
def test_a_file_round_trips_on_the_handle_it_was_written_with(handle, tmp_path, monkeypatch):
    monkeypatch.setattr(adapter, "SANDBOX_FILES_DIR", tmp_path)
    monkeypatch.setattr(adapter, "RUN_FILES_DIR", tmp_path / "runs")
    (tmp_path / "runs").mkdir()
    monkeypatch.setattr(adapter, "_SANDBOX_FILES", {})
    adapter._persist_sandbox_file(handle, "report.xlsx", b"PK\x03\x04")

    monkeypatch.setattr(adapter, "_SANDBOX_FILES", {})
    adapter._restore_files_from_disk()
    assert handle in adapter._SANDBOX_FILES
    assert adapter._SANDBOX_FILES[handle]["bytes"] == b"PK\x03\x04"


def test_two_keys_that_sanitise_alike_do_not_collide(tmp_path, monkeypatch):
    """`a:b` and `a/b` both sanitise to `a_b`, and one overwrote the other.

    The first version of this test allowed either outcome — both files, or one —
    and passed on the branch where `first.xlsx` was silently gone. An assertion
    broad enough to accept the bug is the same fault as a fixture too clean to
    expose one, so it is narrowed here to the only acceptable result.
    """
    monkeypatch.setattr(adapter, "SANDBOX_FILES_DIR", tmp_path)
    monkeypatch.setattr(adapter, "RUN_FILES_DIR", tmp_path / "runs")
    (tmp_path / "runs").mkdir()
    monkeypatch.setattr(adapter, "_SANDBOX_FILES", {})
    adapter._persist_sandbox_file("sandbox:a:b", "first.xlsx", b"one")
    adapter._persist_sandbox_file("sandbox:a/b", "second.xlsx", b"two")

    monkeypatch.setattr(adapter, "_SANDBOX_FILES", {})
    adapter._restore_files_from_disk()
    assert {e["name"] for e in adapter._SANDBOX_FILES.values()} == {"first.xlsx", "second.xlsx"}
    assert adapter._SANDBOX_FILES["sandbox:a:b"]["bytes"] == b"one"


def test_eviction_still_finds_a_file_written_under_the_old_name(tmp_path, monkeypatch):
    """The volume already holds files named the old way.

    Changing where a file is written without changing where it is deleted leaves
    evicted files on disk, and the next restart restores what was forgotten.
    """
    monkeypatch.setattr(adapter, "SANDBOX_FILES_DIR", tmp_path)
    monkeypatch.setattr(adapter, "RUN_FILES_DIR", tmp_path / "runs")
    (tmp_path / "runs").mkdir()
    legacy = tmp_path / adapter._safe_handle("sandbox:old")
    legacy.with_suffix(".bin").write_bytes(b"stale")
    legacy.with_suffix(".json").write_text('{"handle": "sandbox:old", "name": "stale.xlsx"}')

    adapter._forget_sandbox_file("sandbox:old")

    monkeypatch.setattr(adapter, "_SANDBOX_FILES", {})
    adapter._restore_files_from_disk()
    assert "sandbox:old" not in adapter._SANDBOX_FILES


def test_no_restore_path_reads_its_key_from_a_filename():
    """The structural version: the key must come from the payload.

    A filename is derived through a lossy transform. Reading a key back out of
    one is the bug this whole file exists for, and it is greppable.
    """
    import io
    from pathlib import Path
    src = io.open(Path(adapter.__file__), encoding="utf-8").read()
    body = src[src.index("def _restore_files_from_disk"):]
    body = body[:body.index("\ndef ", 10)]
    for derived in (".stem", ".name"):
        assert f"_SANDBOX_FILES[{derived}" not in body
        assert f"_RUN_FILES[{derived}" not in body
    assert 'info.get("thread")' in body and 'info.get("handle")' in body, (
        "both keys must be read from what was written, not from the file's name"
    )
