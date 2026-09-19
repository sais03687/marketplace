"""A response the parser cannot read must not end the run, or be reported as work.

Two failures that compound. First, a reasoning response that was not the JSON
object the format requires was read as "completed, no action" - so a model that
answered in prose, however sound the plan in it, ended the run before anything
ran. Second, the closing pass then wrote from the plan it remembered, and told
the requester a workbook had been "built and uploaded" when nothing had been
calculated at all (2026-09-19).

The first is fixed by asking again, within a budget. The second by stating the
absence outright when the run's own log shows no code ran and nothing was
written: the log is something the model cannot get wrong.
"""
import asyncio
from types import SimpleNamespace

import pytest

from creator import agent
from creator.agent import AgentState


class _Model:
    """Answers each call with the next canned response."""

    def __init__(self, *responses):
        self.responses = list(responses)
        self.prompts = []

    async def ainvoke(self, prompt):
        self.prompts.append(prompt)
        return SimpleNamespace(content=self.responses.pop(0))


PROSE = [
    "**Reasoning:** the data is in the message. **Plan:** 1) compute in the sandbox 2) reply",
    "Looking at this request, I'll compute it precisely. Let me do that now.",
    "Sure - here is how I would approach it: sum the column, then group by region.",
    "",
]


def _reason(monkeypatch, *responses, **state):
    model = _Model(*responses)
    monkeypatch.setattr(agent, "llm", model)
    s = AgentState(content="Please total the attached figures.", **state)
    s = asyncio.run(agent.reason_and_act(s))
    return s, model


@pytest.mark.parametrize("text", PROSE)
def test_an_unreadable_response_is_asked_again_not_finished(monkeypatch, text):
    s, _ = _reason(monkeypatch, text)
    assert s.analysis.get("completed") is not True
    assert s.context.get("_retry_after_bad_format") is True
    assert agent.route_after_reasoning(s) == "reason_and_act"


def test_the_retry_tells_the_model_why_and_that_nothing_ran(monkeypatch):
    s, _ = _reason(monkeypatch, PROSE[0])
    s, model = _reason(monkeypatch, '{"completed": false, "action": {"type": "none"}}',
                       context=s.context, format_retries=s.format_retries)
    assert "could not be read" in model.prompts[0]
    assert "Nothing in it was carried out" in model.prompts[0]
    assert "_retry_after_bad_format" not in s.context, "a flag that outlives its retry loops forever"


def test_a_readable_response_is_not_retried(monkeypatch):
    s, _ = _reason(monkeypatch, '{"completed": false, "action": {"type": "drive_list", "params": {}}}')
    assert "_retry_after_bad_format" not in s.context
    assert s.format_retries == 0


def test_the_budget_ends_the_retries(monkeypatch):
    s, _ = _reason(monkeypatch, PROSE[1], format_retries=agent._MAX_FORMAT_RETRIES)
    assert "_retry_after_bad_format" not in s.context
    assert s.analysis.get("completed") is True


def test_the_closing_pass_is_not_retried_for_format(monkeypatch):
    # The wrap-up turn may legitimately be prose; re-asking it would loop.
    s, _ = _reason(monkeypatch, PROSE[2], context={"_wrapping_up": True})
    assert "_retry_after_bad_format" not in s.context


# ── the closing pass is told when nothing was produced ─────────────────────

@pytest.mark.parametrize("actions", [
    [],
    ["SharePoint list: root"],
    ["SharePoint search: fees", "Read file: 01ABCDEF"],
    ["MCP python-sandbox/execute_python FAILED (exit 1)"],
    ["MCP python-sandbox/parse_xlsx"],
])
def test_a_run_that_computed_and_delivered_nothing_is_told_so(actions):
    note = agent._produced_nothing_note(actions)
    assert "No code ran" in note
    assert "Do not say that a workbook or file was built" in note


@pytest.mark.parametrize("actions", [
    ["MCP python-sandbox/execute_python"],
    ["SharePoint list: root", "Upload: summary.xlsx"],
    ["OneDrive upload: q3.xlsx"],
    ["Excel write: A1:D10 ✓"],
    ["Excel append"],
])
def test_a_run_that_did_work_gets_no_such_note(actions):
    assert agent._produced_nothing_note(actions) == ""


def test_the_note_reaches_the_closing_prompt(monkeypatch):
    model = _Model('{"subject": null, "text": "Could not finish."}')
    monkeypatch.setattr(agent, "llm", model)
    s = AgentState(content="Work out the fees.", actions_taken=["SharePoint list: root"])
    asyncio.run(agent._write_reply(s))
    assert "No code ran and no file was created" in model.prompts[0]


@pytest.mark.parametrize("obj", [
    '{"heading": "# Plan", "plan": "sum the column"}',
    '{"answer": 465.5}',
    '{}',
])
def test_valid_json_without_our_fields_is_asked_again(monkeypatch, obj):
    # JSON mode guarantees an object, not the fields the loop needs.
    s, _ = _reason(monkeypatch, obj)
    assert s.context.get("_retry_after_bad_format") is True


def test_a_json_mode_rejection_falls_back_to_the_plain_client(monkeypatch):
    import asyncio as _a

    class Rejected(Exception):
        status_code = 400

    class Model:
        calls = []
        def bind(self, **kw):
            outer = self
            class Bound:
                async def ainvoke(self, prompt):
                    outer.calls.append(("json", kw))
                    raise Rejected("response_format not supported")
            return Bound()
        async def ainvoke(self, prompt):
            self.calls.append(("plain", None))
            return SimpleNamespace(content="{}")

    m = Model()
    monkeypatch.setattr(agent, "llm", m)
    monkeypatch.setattr(agent, "_json_mode", True)
    _a.run(agent._ainvoke_json("hi", timeout=5))
    assert [c[0] for c in m.calls] == ["json", "plain"]
    assert m.calls[0][1]["response_format"] == {"type": "json_object"}
    assert agent._json_mode is False, "a model that rejected JSON mode is not asked again"


def test_a_response_cut_off_for_length_is_retried_not_a_crash(monkeypatch):
    class LengthFinishReasonError(Exception):
        pass

    class Model:
        def bind(self, **kw):
            class Bound:
                async def ainvoke(self, prompt):
                    raise LengthFinishReasonError("length limit was reached")
            return Bound()

    monkeypatch.setattr(agent, "llm", Model())
    monkeypatch.setattr(agent, "_json_mode", True)
    s = AgentState(content="Build the retention triangle.")
    s = asyncio.run(agent.reason_and_act(s))
    assert s.context.get("_retry_after_bad_format") is True
