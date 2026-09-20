"""The Data Analyst's side of the platform contract.

It hands the platform `check` (the choices it made) and `deliverables` (the
files that are the answer), and answers a revision request from the platform's
review by rewriting the reply from its saved run, not by redoing the task.
"""
import asyncio
from types import SimpleNamespace

from creator import agent
from creator.agent import AgentState


class _Model:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.prompts = []

    async def ainvoke(self, prompt):
        self.prompts.append(prompt)
        return SimpleNamespace(content=self.responses.pop(0))


FEEDBACK = {
    "round": 1,
    "problems": ["17.19545 appears in my summary but not in the file."],
    "previous_reply": "Contoso owes $17.19545.",
    "instructions": "Fix the reply so it agrees with the files.",
}


def _saved_run(result):
    return AgentState(
        content="Work out the fees.",
        actions_taken=["MCP python-sandbox/execute_python", "Upload: fees.xlsx"],
        action_results=["stdout: contoso 17.20 northwind 8.13"],
        result=result,
    )


def _fake_graph(monkeypatch, state):
    class Graph:
        async def aget_state(self, config):
            return SimpleNamespace(values=state.model_dump() if state else {})

    async def get_graph():
        return Graph()

    monkeypatch.setattr(agent, "get_graph", get_graph)


def test_the_feedback_reaches_the_model_with_the_previous_reply():
    block = agent._feedback_block(FEEDBACK)
    assert "17.19545 appears in my summary but not in the file." in block
    assert "Contoso owes $17.19545." in block
    assert "change only what the problems above show to be wrong" in block


def test_a_revision_rewrites_the_reply_without_redoing_the_task(monkeypatch):
    prev = {"action": "reply_email", "text": "Contoso owes $17.19545.", "deliverables": ["fees.xlsx"]}
    _fake_graph(monkeypatch, _saved_run(prev))
    model = _Model('{"subject": null, "text": "Contoso owes $17.20.", "check": ["I rounded to cents."]}')
    monkeypatch.setattr(agent, "llm", model)

    out = asyncio.run(agent.run_agent("Work out the fees.", {"platform_feedback": FEEDBACK}, thread_id="t-fees"))

    assert out["text"] == "Contoso owes $17.20."
    assert out["check"] == ["I rounded to cents."]
    assert out["deliverables"] == ["fees.xlsx"], "the files from the run are kept"
    assert len(model.prompts) == 1, "one model call, not a re-run"
    assert "17.19545 appears in my summary" in model.prompts[0]


def test_with_no_saved_run_the_revision_falls_through(monkeypatch):
    _fake_graph(monkeypatch, None)
    assert asyncio.run(agent._revise_from_feedback("t-none", FEEDBACK)) is None


def test_the_uploaded_files_are_the_deliverables():
    names = agent._uploaded_names(["SharePoint list: root", "Upload: q3.xlsx", "OneDrive upload: chart.png", "Upload: q3.xlsx"])
    assert names == ["q3.xlsx", "chart.png"]


def test_no_uploads_means_no_deliverables_claimed():
    assert agent._uploaded_names(["MCP python-sandbox/execute_python"]) == []


def test_the_forced_first_listing_is_skipped_where_drive_tools_are_withheld(monkeypatch):
    # The email tier has no workspace to list; forcing one spends a step on a
    # tool the agent is not offered.
    model = _Model('{"reasoning": "thinking", "completed": false, "action": {"type": "none"}}')
    monkeypatch.setattr(agent, "llm", model)
    monkeypatch.setattr(agent, "_EMAIL_ONLY", True)
    s = asyncio.run(agent.reason_and_act(AgentState(content="Total these figures.")))
    assert (s.analysis.get("action") or {}).get("type") != "drive_list"


def test_the_forced_first_listing_still_happens_on_a_connected_workspace(monkeypatch):
    model = _Model('{"reasoning": "thinking", "completed": false, "action": {"type": "none"}}')
    monkeypatch.setattr(agent, "llm", model)
    monkeypatch.setattr(agent, "_EMAIL_ONLY", False)
    s = asyncio.run(agent.reason_and_act(AgentState(content="Total the figures in the usual file.")))
    assert (s.analysis.get("action") or {}).get("type") == "drive_list"


def _first_turn(monkeypatch, email_only, *responses):
    model = _Model(*responses)
    monkeypatch.setattr(agent, "llm", model)
    monkeypatch.setattr(agent, "_EMAIL_ONLY", email_only)
    s = asyncio.run(agent.reason_and_act(AgentState(content="Total the attached figures.")))
    return s, model


NO_ACTION = '{"reasoning": "I will summarise", "completed": false, "action": {"type": "none"}}'


def test_a_first_turn_with_no_action_is_asked_again_where_there_is_no_drive(monkeypatch):
    # Forcing a listing used to keep such a run from replying with nothing done;
    # the email tier has no listing to force, so it is asked again instead.
    s, _ = _first_turn(monkeypatch, True, NO_ACTION)
    assert s.context.get("_retry_after_no_action") is True
    assert agent.route_after_reasoning(s) == "reason_and_act"


def test_the_second_ask_points_at_the_data(monkeypatch):
    s, _ = _first_turn(monkeypatch, True, NO_ACTION)
    s2, model = _first_turn(monkeypatch, True, NO_ACTION)
    s2.context.update(s.context)
    s2.no_action_nudges = 1
    model2 = _Model('{"reasoning": "ok", "completed": false, "action": {"type": "mcp_call", "params": {}}}')
    monkeypatch.setattr(agent, "llm", model2)
    asyncio.run(agent.reason_and_act(s2))
    assert "/tmp/input/" in model2.prompts[0]
    assert "nothing has run yet" in model2.prompts[0]


def test_it_nudges_once_not_forever(monkeypatch):
    model = _Model(NO_ACTION)
    monkeypatch.setattr(agent, "llm", model)
    monkeypatch.setattr(agent, "_EMAIL_ONLY", True)
    s = AgentState(content="Total the attached figures.", no_action_nudges=1)
    s = asyncio.run(agent.reason_and_act(s))
    assert "_retry_after_no_action" not in s.context


def test_a_first_turn_that_acts_is_left_alone(monkeypatch):
    s, _ = _first_turn(monkeypatch, True, '{"completed": false, "action": {"type": "mcp_call", "params": {"server": "python-sandbox"}}}')
    assert "_retry_after_no_action" not in s.context
