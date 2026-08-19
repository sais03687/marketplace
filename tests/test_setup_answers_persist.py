"""What the buyer says during setup has to survive the conversation.

The hire wizard asks who the team are, what data they work with, who receives
reports, and what the agent must never do. Those answers went into the database
and were relayed to the agent as one message ending "Store the key information
in your memory for future reference."

The agent has no memory-write action. There is no `remember`, no `memory_write`,
nothing in the action list that writes a file it reads at import. So the
instruction could not be followed, and on 2026-08-19 a fresh hire reported

    I have completed the onboarding process, including updating my memory with
    the manager's responses.

having taken five inbox_list calls and one send_email. MEMORY.md was still the
creator's template, byte for byte, and would have stayed that way forever.

Pulled rather than pushed, because the marketplace runs on Vercel and cannot
reach a container — which is also why the relay never arrived. Outbound works,
so the agent fetches its own answers, the same direction approvals already sync.
"""
import io
from pathlib import Path

import pytest

import adapter

ANSWERS = {
    "Who are the team members you work with?": "Priya Raman, priya@acme.com, Finance.",
    "What data sources does your team work with most often?": "Excel on SharePoint.",
    "Is there anything I should never do?": "Never email clients directly.",
}


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    monkeypatch.setattr(adapter, "WORKSPACE_DIR", tmp_path)
    (tmp_path / "MEMORY.md").write_text(
        "# Agent — Memory\n\n## Working Knowledge\n\n_(nothing yet)_\n", encoding="utf-8"
    )
    return tmp_path


def memory(ws):
    return (ws / "MEMORY.md").read_text(encoding="utf-8")


# ── the answers land ───────────────────────────────────────────────────────

def test_the_answers_are_written_into_memory(workspace):
    assert adapter._write_setup_answers(ANSWERS) is True
    text = memory(workspace)
    assert "Priya Raman" in text
    assert "Never email clients directly." in text


def test_the_questions_are_kept_with_their_answers(workspace):
    # An answer without its question is a sentence with no subject: "Excel on
    # SharePoint" tells the agent nothing about what it was asked.
    adapter._write_setup_answers(ANSWERS)
    text = memory(workspace)
    assert "What data sources does your team work with most often?" in text


def test_what_was_already_there_survives(workspace):
    adapter._write_setup_answers(ANSWERS)
    assert "## Working Knowledge" in memory(workspace)


# ── and they stay correct when they change ─────────────────────────────────

def test_editing_an_answer_replaces_it_rather_than_appending(workspace):
    adapter._write_setup_answers(ANSWERS)
    edited = {**ANSWERS, "Who are the team members you work with?": "Priya has left. Marco Vitale now."}
    adapter._write_setup_answers(edited)
    text = memory(workspace)
    assert "Marco Vitale" in text
    assert "Priya Raman" not in text, (
        "a superseded answer left in memory is worse than none: the agent would "
        "still email someone who has gone"
    )


def test_the_block_appears_exactly_once_however_often_it_is_written(workspace):
    for _ in range(4):
        adapter._write_setup_answers(ANSWERS)
    text = memory(workspace)
    assert text.count(adapter.SETUP_BLOCK_START) == 1
    assert text.count(adapter.SETUP_BLOCK_END) == 1


def test_rewriting_the_same_answers_changes_nothing(workspace):
    adapter._write_setup_answers(ANSWERS)
    before = memory(workspace)
    assert adapter._write_setup_answers(ANSWERS) is False, "no change should mean no write"
    assert memory(workspace) == before


def test_an_answer_that_was_cleared_disappears(workspace):
    adapter._write_setup_answers(ANSWERS)
    adapter._write_setup_answers({**ANSWERS, "Is there anything I should never do?": ""})
    assert "Never email clients directly." not in memory(workspace)


def test_text_outside_the_block_is_never_touched(workspace):
    adapter._write_setup_answers(ANSWERS)
    path = workspace / "MEMORY.md"
    path.write_text(memory(workspace) + "\n## Learned later\n\nFabrikam pays late.\n", encoding="utf-8")
    adapter._write_setup_answers({**ANSWERS, "Who are the team members you work with?": "Marco only."})
    text = memory(workspace)
    assert "Fabrikam pays late." in text, "an update to setup answers ate something else"
    assert "Marco only." in text


def test_no_answers_at_all_is_harmless(workspace):
    before = memory(workspace)
    adapter._write_setup_answers({})
    assert "## Working Knowledge" in memory(workspace)


# ── the direction it has to travel ─────────────────────────────────────────

def test_the_agent_pulls_rather_than_being_pushed_to():
    """Vercel cannot reach a container; the container can reach Vercel.

    The old relay POSTed to the container from the marketplace and failed into a
    silent catch every time, with the answers "saved in DB" as consolation.
    """
    src = io.open(Path(adapter.__file__), encoding="utf-8").read()
    fn = src[src.index("async def _sync_setup_answers"):][:1400]
    assert "client.get(" in fn
    assert "/onboarding" in fn
    assert "Bearer" in fn, "the agent identifies itself with its deployment token"


def test_it_runs_at_startup_and_on_a_timer():
    # Startup alone would mean an edited answer waits for a restart.
    src = io.open(Path(adapter.__file__), encoding="utf-8").read()
    startup = src[src.index("async def _startup"):][:1800]
    assert "_sync_setup_answers()" in startup
    assert "asyncio.sleep(_SETUP_SYNC_INTERVAL_S)" in startup


def test_the_interval_is_configurable():
    src = io.open(Path(adapter.__file__), encoding="utf-8").read()
    assert 'os.environ.get("SETUP_SYNC_INTERVAL_S"' in src
