"""Replay the latest hanging/none message through the graph and print full analysis."""
import asyncio
import json
import sys

sys.path.insert(0, "/agent")

from adapter import AGENTMIND_PROMPT, contribute_knowledge, search_knowledge
from creator.agent import run_agent

async def fake_approve(**kw): return ""
async def fake_resolve(*a, **kw): return {"status": "APPROVED"}

# Exact text from the latest real email
text = """Gotchu, what other tools are recommended for startups in tech and
healthcare?

On Fri, Apr 10, 2026, 11:34 PM Test LangChain Agent <
test-langchain-agent-my-company@agentmail.to> wrote:

> Hi Sai,
>
> Here are three project-management tools that many startups find valuable:
>
> 1. Trello – A visual board-based system
> 2. Asana – Offers robust task tracking
> 3. ClickUp – Highly customizable
>
> Let me know if you'd like a deeper comparison.
"""

sender = "Sai Suram <sai.suram07@gmail.com>"
subject = "Re: test"
thread_id = "d5871630-40d2-4ba0-8dd6-27ea390772a7"

formatted = (
    f"New email from {sender}\n"
    f"Subject: {subject}\n"
    f"Thread ID: {thread_id}\n\n"
    f"{text}"
)

context = {
    "agent_name": "Test LangChain Agent",
    "agent_email": "test-langchain-agent-my-company@agentmail.to",
    "company_name": "My Company",
    "company_domain": "mycompany.com",
    "hook_name": "AgentMail",
    "session_key": f"hook:agentmail:{thread_id}",
    "agentmind_prompt": AGENTMIND_PROMPT,
    "thread_id": thread_id,
    "message_id": "probe-latest",
    "sender": sender,
    "subject": subject,
}

# Monkeypatch to capture the state after analyze_task
from creator import agent as creator_agent
_orig_analyze = creator_agent.analyze_task

async def _logged_analyze(state):
    result = await _orig_analyze(state)
    print("\n[probe] ANALYSIS OUTPUT:", flush=True)
    print(json.dumps(result.analysis, indent=2)[:2000], flush=True)
    return result

creator_agent.analyze_task = _logged_analyze

# Rebuild compiled graph with patched node
from langgraph.graph import StateGraph, END

g = StateGraph(creator_agent.AgentState)
g.add_node("search_commons", creator_agent.search_commons)
g.add_node("analyze_task", _logged_analyze)
g.add_node("handle_approval", creator_agent.handle_approval)
g.add_node("format_response", creator_agent.format_response)
g.add_node("maybe_contribute", creator_agent.maybe_contribute)
g.set_entry_point("search_commons")
g.add_edge("search_commons", "analyze_task")
g.add_conditional_edges(
    "analyze_task",
    lambda s: "handle_approval" if s.analysis.get("needs_approval") else "format_response",
    {"handle_approval": "handle_approval", "format_response": "format_response"},
)
g.add_edge("handle_approval", "maybe_contribute")
g.add_edge("format_response", "maybe_contribute")
g.add_edge("maybe_contribute", END)

compiled = g.compile()

async def main():
    state = creator_agent.AgentState(
        content=formatted,
        context=context,
        approve_fn=fake_approve,
        resolve_fn=fake_resolve,
        contribute_fn=contribute_knowledge,
        search_fn=search_knowledge,
    )
    final = await compiled.ainvoke(state)
    print("\n[probe] FINAL RESULT:", flush=True)
    print(json.dumps(final.get("result", {}), indent=2)[:1500], flush=True)

asyncio.run(main())
