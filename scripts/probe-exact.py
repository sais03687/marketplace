"""Probe with EXACT text from latest email (read from file)."""
import asyncio
import json
import sys

sys.path.insert(0, "/agent")

from adapter import AGENTMIND_PROMPT, contribute_knowledge, search_knowledge
from creator import agent as creator_agent

async def fake_approve(**kw): return ""
async def fake_resolve(*a, **kw): return {"status": "APPROVED"}

with open("/tmp/latest-email-text.txt", "r", encoding="utf-8") as f:
    text = f.read()

print(f"[probe] text length: {len(text)}", flush=True)
print(f"[probe] first 300 chars: {text[:300]!r}", flush=True)

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
    "message_id": "probe-exact",
    "sender": sender,
    "subject": subject,
}

# Patch analyze_task to log raw LLM output before JSON parse
from creator.agent import llm, ANALYSIS_PROMPT, _soul_md, _agents_md, _tools_md

async def logged_analyze(state):
    ctx = state.context
    prompt = ANALYSIS_PROMPT.format(
        agent_name=ctx.get("agent_name", "Agent"),
        company_name=ctx.get("company_name", ""),
        content=state.content,
        hook_name=ctx.get("hook_name", ""),
        session_key=ctx.get("session_key", ""),
        soul_instructions=_soul_md,
        behavioral_rules=_agents_md,
        tools_guide=_tools_md,
        agentmind_prompt=ctx.get("agentmind_prompt", ""),
        knowledge_context="",
    )
    print(f"[probe] prompt length: {len(prompt)}", flush=True)
    response = await llm.ainvoke(prompt)
    raw = response.content if hasattr(response, "content") else str(response)
    print(f"[probe] RAW LLM RESPONSE (len={len(raw)}):", flush=True)
    print(raw[:3000], flush=True)
    print("[probe] --- end raw ---", flush=True)
    try:
        cleaned = raw.strip()
        if cleaned.startswith("```"):
            cleaned = cleaned.split("\n", 1)[1]
            cleaned = cleaned.rsplit("```", 1)[0]
        analysis = json.loads(cleaned)
        print(f"[probe] PARSED ok, action={analysis.get('action')}", flush=True)
    except Exception as e:
        print(f"[probe] PARSE FAILED: {e}", flush=True)
        analysis = {"action": "none", "intent": "parse-failed"}
    state.analysis = analysis
    state.task_type = analysis.get("task_type", "unknown")
    state.original_draft = analysis.get("draft", {}).get("text", "")
    return state

async def main():
    state = creator_agent.AgentState(
        content=formatted,
        context=context,
        approve_fn=fake_approve,
        resolve_fn=fake_resolve,
        contribute_fn=contribute_knowledge,
        search_fn=search_knowledge,
    )
    state = await creator_agent.search_commons(state)
    state = await logged_analyze(state)
    print(f"\n[probe] FINAL ACTION: {state.analysis.get('action')}", flush=True)
    print(f"[probe] draft.text preview: {str(state.analysis.get('draft', {}).get('text', ''))[:300]}", flush=True)

asyncio.run(main())
