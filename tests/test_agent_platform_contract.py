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
