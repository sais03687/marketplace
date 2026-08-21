"""The agent can write what it learns into its own memory.

Until now MEMORY.md was read once at import and never written back, so the agent
could not record anything it discovered while working. Memory was frozen at the
template plus the setup answers, and "learns your company over time" was not
happening. The `remember` action gives it a durable, deduplicated, capped Learned
section, kept apart from the setup answers so the two never clobber each other,
and refreshes the in-process copy so the fact is usable immediately.
"""
import io
from pathlib import Path

import pytest

from creator import agent

NL = chr(10)


@pytest.fixture
def memory(tmp_path, monkeypatch):
    monkeypatch.setattr(agent, "_here", tmp_path)
    (tmp_path / "MEMORY.md").write_text(
        "# Agent — Memory" + NL + NL + "## Working Knowledge" + NL + NL + "_(nothing yet)_" + NL,
        encoding="utf-8",
    )
    monkeypatch.setattr(agent, "_memory_md", (tmp_path / "MEMORY.md").read_text(encoding="utf-8"))
    return tmp_path


def read(mem):
    return (mem / "MEMORY.md").read_text(encoding="utf-8")


# ── it writes, and the write is usable at once ─────────────────────────────

def test_a_fact_is_written_to_memory(memory):
    assert agent._remember("Acme's fiscal year ends in March.") is True
    text = read(memory)
    assert "Acme's fiscal year ends in March." in text
    assert "## Learned while working" in text


def test_the_in_process_copy_is_refreshed(memory):
    # The whole reason a write matters: the prompt reads _memory_md, and if the
    # write did not update it the fact would be invisible until a restart.
    agent._remember("The CFO wants charts, not tables.")
    assert "The CFO wants charts, not tables." in agent._memory_md


def test_what_was_already_in_memory_survives(memory):
    agent._remember("We count revenue net of refunds.")
    assert "## Working Knowledge" in read(memory)


# ── it does not fill with noise ────────────────────────────────────────────

def test_a_duplicate_is_not_stored_twice(memory):
    assert agent._remember("Fabrikam pays late.") is True
    assert agent._remember("Fabrikam pays late.") is False
    assert agent._remember("  fabrikam PAYS late.  ") is False  # case + whitespace
    assert read(memory).count("abrikam") == 1


def test_empty_or_whitespace_is_ignored(memory):
    assert agent._remember("") is False
    assert agent._remember("   ") is False


def test_the_learned_section_is_capped(memory):
    for i in range(agent._MAX_LEARNED + 15):
        agent._remember(f"Fact number {i}.")
    entries = read(memory).count(NL + "- ")
    assert entries <= agent._MAX_LEARNED
    # And it keeps the most recent, not the oldest.
    assert f"Fact number {agent._MAX_LEARNED + 14}." in read(memory)
    assert "Fact number 0." not in read(memory)


# ── it never collides with the setup-answers block ─────────────────────────

def test_it_leaves_the_setup_answers_block_untouched(memory):
    # The setup-answers sync writes its own marked block. remember must use a
    # different section, or one would overwrite the other.
    path = memory / "MEMORY.md"
    path.write_text(
        read(memory)
        + NL + "<!-- setup-answers:start -->" + NL + "roster: Priya" + NL + "<!-- setup-answers:end -->" + NL,
        encoding="utf-8",
    )
    agent._memory_md = path.read_text(encoding="utf-8")
    agent._remember("Their quarter-end close takes five days.")
    text = read(memory)
    assert "roster: Priya" in text, "remember clobbered the setup answers"
    assert "Their quarter-end close takes five days." in text
    assert "<!-- setup-answers:start -->" in text
    assert "<!-- learned:start -->" in text


def test_rewriting_over_an_existing_learned_block_does_not_duplicate_it(memory):
    agent._remember("A.")
    agent._remember("B.")
    text = read(memory)
    assert text.count("<!-- learned:start -->") == 1
    assert text.count("<!-- learned:end -->") == 1


# ── the action is wired, and safe ──────────────────────────────────────────

def test_remember_is_a_declared_action():
    src = io.open(Path(agent.__file__), encoding="utf-8").read()
    assert "| remember | none" in src


def test_remember_runs_without_an_approval_gate():
    """It is a local write with no external effect; it must not block on a human.

    The handler returns before the blocked-action gate, so it never interrupts.
    """
    src = io.open(Path(agent.__file__), encoding="utf-8").read()
    handler = src.index('if action_type == "remember":')
    gate = src.index("if action_type not in BLOCKED_ACTIONS", handler) if "BLOCKED_ACTIONS" in src[handler:] else None
    # The remember handler returns state before any interrupt path.
    ret = src.index("return state", handler)
    interrupt = src.index("interrupt(", handler)
    assert ret < interrupt, "remember must return before it can reach an interrupt"
