"""An update has to arrive as the file it was, and then actually be loaded.

`/internal/update-skills` wrote what it was handed straight to disk with
`write_text`, while `update.ts` sends `readFileSync(f).toString("base64")`.
Every file it touched would have been replaced by its own base64 — `agent.py`
included — so the first deployment to auto-update would have been destroyed by
the update meant to improve it.

It never fired only because vetting could not pass until 2026-08-18: no version
was ever approved, so `vet-decision` never reached the branch that queues the
job. `autoUpdate` defaults to true, and the next approval would have gone out to
every active deployment.

The second half is quieter and just as complete a failure. Writing `agent.py` to
disk changes nothing by itself: the module was imported when the container
started, and the process goes on running the old code. Every update before this
one was silent — files landed, the job logged success, and the agent carried on
exactly as it was.
"""
import base64
import io
from pathlib import Path

import pytest

import adapter

UPDATE_TS = (
    Path(__file__).resolve().parents[1]
    / "apps" / "provisioning-service" / "src" / "jobs" / "update.ts"
)
DOCKER_TS = (
    Path(__file__).resolve().parents[1]
    / "apps" / "provisioning-service" / "src" / "clients" / "docker.ts"
)


def call(files, tmp_path, monkeypatch):
    """Drive the endpoint's body, with auth and the workspace stubbed out."""
    import asyncio

    monkeypatch.setattr(adapter, "WORKSPACE_DIR", tmp_path)
    monkeypatch.setattr(adapter, "_require_internal_auth", lambda r: None)
    payload = adapter.UpdateSkillsPayload(files=files)
    return asyncio.run(adapter.update_skills(payload, request=None))


def b64(text: str) -> str:
    return base64.b64encode(text.encode()).decode()


# ── the bytes arrive as themselves ─────────────────────────────────────────

def test_a_source_file_is_written_as_source_not_as_its_base64(tmp_path, monkeypatch):
    source = "def analyse(rows):\n    return sum(rows)\n"
    call({"creator/agent.py": b64(source)}, tmp_path, monkeypatch)
    assert (tmp_path / "creator" / "agent.py").read_text(encoding="utf-8") == source


def test_the_file_is_not_the_base64_string(tmp_path, monkeypatch):
    # The failure stated plainly: the old code passed every other test here by
    # writing something, and what it wrote was gibberish.
    source = "print('hello')\n"
    call({"a.py": b64(source)}, tmp_path, monkeypatch)
    written = (tmp_path / "a.py").read_text(encoding="utf-8")
    assert written != b64(source)
    assert written == source


def test_binary_survives(tmp_path, monkeypatch):
    # Base64 is the transport precisely because a package carries images and
    # wheels as readily as source; utf-8 text would not have carried them.
    raw = bytes(range(256))
    call({"onboarding/logo.png": base64.b64encode(raw).decode()}, tmp_path, monkeypatch)
    assert (tmp_path / "onboarding" / "logo.png").read_bytes() == raw


def test_nested_directories_are_created(tmp_path, monkeypatch):
    call({"skills/finance/summary.md": b64("# Summary\n")}, tmp_path, monkeypatch)
    assert (tmp_path / "skills" / "finance" / "summary.md").exists()


def test_the_response_names_what_it_wrote(tmp_path, monkeypatch):
    out = call({"a.py": b64("x"), "b.py": b64("y")}, tmp_path, monkeypatch)
    assert out["ok"] is True
    assert sorted(out["written"]) == ["a.py", "b.py"]


# ── and a bad package is refused whole ─────────────────────────────────────

def test_a_path_climbing_out_of_the_workspace_is_refused(tmp_path, monkeypatch):
    from fastapi import HTTPException
    with pytest.raises(HTTPException):
        call({"../../etc/passwd": b64("root")}, tmp_path, monkeypatch)


def test_a_traversal_does_not_take_the_rest_of_the_package_with_it(tmp_path, monkeypatch):
    """Skipping the bad path and applying the rest is worse than refusing.

    That is what it did before: the offending file was skipped, everything else
    was written, and `{"ok": true}` came back — leaving the agent running a
    mixture of two versions with nothing recorded to say so.
    """
    from fastapi import HTTPException
    with pytest.raises(HTTPException):
        call({"good.py": b64("kept?"), "../escape.py": b64("no")}, tmp_path, monkeypatch)
    assert not (tmp_path / "good.py").exists(), "the package was applied in part"


def test_content_that_is_not_base64_is_refused(tmp_path, monkeypatch):
    from fastapi import HTTPException
    with pytest.raises(HTTPException):
        call({"a.py": "this is not base64 !!!"}, tmp_path, monkeypatch)


def test_one_bad_file_leaves_none_of_the_package_written(tmp_path, monkeypatch):
    from fastapi import HTTPException
    with pytest.raises(HTTPException):
        call({"a.py": b64("fine"), "b.py": "!!! not base64 !!!"}, tmp_path, monkeypatch)
    assert not (tmp_path / "a.py").exists()


def test_an_empty_update_is_harmless(tmp_path, monkeypatch):
    assert call({}, tmp_path, monkeypatch)["written"] == []


# ── the half that makes it take effect ─────────────────────────────────────

def test_the_job_restarts_the_container_after_pushing():
    src = io.open(UPDATE_TS, encoding="utf-8").read()
    assert "restartContainer(deployment.containerName)" in src, (
        "files written to disk are not imported by a process that already "
        "started; without a restart every update is silent"
    )
    assert src.index("update-skills") < src.index("restartContainer("), (
        "restarting before the files land would load the old code again"
    )


def test_the_job_checks_the_agent_came_back():
    src = io.open(UPDATE_TS, encoding="utf-8").read()
    assert "/internal/health" in src
    assert src.index("restartContainer(") < src.index("/internal/health")
    assert "did not become healthy" in src, (
        "a restart that never comes up leaves a dead agent and a database "
        "claiming an updated one"
    )


def test_the_restart_keeps_the_same_container():
    """`stopContainer` removes the container; this must not use it.

    A recreated agent loses the published port the netgate holds and any file
    copied in since the image was built.
    """
    src = io.open(UPDATE_TS, encoding="utf-8").read()
    assert "stopContainer" not in src
    docker = io.open(DOCKER_TS, encoding="utf-8").read()
    body = docker[docker.index("export async function restartContainer"):][:400]
    assert "container.restart(" in body
    assert "remove(" not in body


# ── what the buyer accumulated is not the creator's to replace ─────────────
#
# An update replaces the creator's package. It must not replace what the buyer
# built up while using it. MEMORY.md is everything the agent has learned about
# this company; PRIVATE.md is their roster and internal details. Both sit in
# WORKSPACE_DIR beside agent.py, so a package containing either would overwrite
# months of context with a blank template, silently, and be discovered later as
# an agent that had forgotten its own company.
#
# No package ships them today. That is luck rather than a guarantee, which is
# what these are for.

def test_memory_is_not_overwritten_by_an_update(tmp_path, monkeypatch):
    (tmp_path / "MEMORY.md").write_text("Acme's Q3 close is the 5th.\n", encoding="utf-8")
    out = call({"MEMORY.md": b64("# Memory\n(template)\n")}, tmp_path, monkeypatch)
    assert (tmp_path / "MEMORY.md").read_text(encoding="utf-8") == "Acme's Q3 close is the 5th.\n"
    assert out["declined"] == ["MEMORY.md"]


def test_private_notes_are_not_overwritten(tmp_path, monkeypatch):
    (tmp_path / "PRIVATE.md").write_text("Priya - finance\n", encoding="utf-8")
    call({"PRIVATE.md": b64("# Private\n")}, tmp_path, monkeypatch)
    assert (tmp_path / "PRIVATE.md").read_text(encoding="utf-8") == "Priya - finance\n"


def test_the_memory_directory_is_protected_too(tmp_path, monkeypatch):
    # /internal/memory reads MEMORY.md *and* every memory/*.md beside it.
    (tmp_path / "memory").mkdir()
    (tmp_path / "memory" / "clients.md").write_text("Fabrikam pays late.\n", encoding="utf-8")
    out = call({"memory/clients.md": b64("")}, tmp_path, monkeypatch)
    assert (tmp_path / "memory" / "clients.md").read_text(encoding="utf-8") == "Fabrikam pays late.\n"
    assert out["declined"] == ["memory/clients.md"]


def test_declining_one_file_does_not_stop_the_update(tmp_path, monkeypatch):
    """A creator shipping a MEMORY.md template is doing something ordinary.

    Their release must not fail for it — that file is simply not theirs to
    write. This is the opposite call from a traversal or a corrupt file, where
    the package is malformed and the whole update is rejected.
    """
    (tmp_path / "MEMORY.md").write_text("kept\n", encoding="utf-8")
    out = call(
        {"MEMORY.md": b64("template"), "agent.py": b64("print('new code')\n")},
        tmp_path, monkeypatch,
    )
    assert out["ok"] is True
    assert out["written"] == ["agent.py"]
    assert (tmp_path / "agent.py").read_text(encoding="utf-8") == "print('new code')\n"
    assert (tmp_path / "MEMORY.md").read_text(encoding="utf-8") == "kept\n"


def test_the_creator_s_own_files_are_still_replaced(tmp_path, monkeypatch):
    # The guard must not grow into "nothing may be updated". These are the
    # creator's, and updating them is the entire point.
    for name in ("agent.py", "SOUL.md", "TOOLS.md", "AGENTS.md", "requirements.txt"):
        (tmp_path / name).write_text("old\n", encoding="utf-8")
    call({n: b64("new\n") for n in
          ("agent.py", "SOUL.md", "TOOLS.md", "AGENTS.md", "requirements.txt")},
         tmp_path, monkeypatch)
    for name in ("agent.py", "SOUL.md", "TOOLS.md", "AGENTS.md", "requirements.txt"):
        assert (tmp_path / name).read_text(encoding="utf-8") == "new\n", name


def test_a_file_merely_named_like_memory_is_not_protected(tmp_path, monkeypatch):
    # "MEMORY.md" exactly, not anything containing the word — otherwise a
    # creator's own memory-handling module becomes unupdatable.
    call({"memory_tools.py": b64("new\n"), "skills/MEMORY_FORMAT.md": b64("new\n")},
         tmp_path, monkeypatch)
    assert (tmp_path / "memory_tools.py").read_text(encoding="utf-8") == "new\n"
    assert (tmp_path / "skills" / "MEMORY_FORMAT.md").read_text(encoding="utf-8") == "new\n"


def test_the_guard_covers_everything_the_memory_endpoint_calls_memory():
    """Tied to the definition rather than to a list somebody remembered.

    /internal/memory is what the platform means by "the buyer's memory": it
    returns MEMORY.md and every memory/*.md beside it. If that endpoint grows a
    third location, the guard has to grow with it, and this fails until it does
    rather than letting an update quietly reach the new one.
    """
    src = io.open(Path(adapter.__file__), encoding="utf-8").read()
    body = src[src.index("Return MEMORY.md + all memory/*.md"):]
    body = body[:body.index("return {\"memory\": files}")]
    assert 'WORKSPACE_DIR / "MEMORY.md"' in body
    assert 'WORKSPACE_DIR / "memory"' in body
    assert adapter._BUYER_OWNED == {"MEMORY.md", "PRIVATE.md"}
    assert adapter._BUYER_OWNED_DIRS == {"memory"}


def test_private_notes_are_protected_even_though_that_endpoint_omits_them():
    # PRIVATE.md is deliberately not returned by /internal/memory — it holds the
    # roster and is kept out of AgentMind contributions — but it is just as much
    # the buyer's, and an update must not overwrite it either.
    src = io.open(Path(adapter.__file__), encoding="utf-8").read()
    assert "PRIVATE.md" in src
    assert "PRIVATE.md" in adapter._BUYER_OWNED
