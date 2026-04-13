"""Probe creator agent with REAL search_knowledge + contribute_knowledge."""
import asyncio
import time
import sys

sys.path.insert(0, "/agent")

# Import the real adapter helpers
from adapter import search_knowledge, contribute_knowledge
from creator.agent import run_agent

async def fake_approve(**kw): return "fake-id"
async def fake_resolve(approval_id, **kw): return {"status": "APPROVED"}

async def timed_search(**kw):
    t = time.time()
    print(f"[probe] search_knowledge START: {kw}", flush=True)
    try:
        r = await search_knowledge(**kw)
        print(f"[probe] search_knowledge OK in {time.time()-t:.1f}s, {len(r)} hits", flush=True)
        return r
    except Exception as e:
        print(f"[probe] search_knowledge FAILED in {time.time()-t:.1f}s: {e}", flush=True)
        return []

async def timed_contribute(**kw):
    t = time.time()
    print(f"[probe] contribute_knowledge START", flush=True)
    try:
        r = await contribute_knowledge(**kw)
        print(f"[probe] contribute_knowledge OK in {time.time()-t:.1f}s", flush=True)
        return r
    except Exception as e:
        print(f"[probe] contribute_knowledge FAILED in {time.time()-t:.1f}s: {e}", flush=True)
        return {}

context = {
    "agent_name": "Test LangChain Agent",
    "agent_email": "test-langchain-agent-my-company@agentmail.to",
    "company_name": "My Company",
    "company_domain": "mycompany.com",
    "hook_name": "AgentMail",
    "session_key": "probe:test",
    "agentmind_prompt": "## AgentMind",
    "thread_id": "probe-thread",
    "message_id": "probe-msg",
    "sender": "sai.suram07@gmail.com",
    "subject": "Re: Test",
}

content = "Yep this works"

print("[probe] Calling run_agent with REAL search/contribute...", flush=True)
t0 = time.time()
result = asyncio.run(run_agent(
    content=content,
    context=context,
    approve_fn=fake_approve,
    resolve_fn=fake_resolve,
    contribute_fn=timed_contribute,
    search_fn=timed_search,
))
print(f"[probe] run_agent TOTAL: {time.time()-t0:.1f}s", flush=True)
print(f"[probe] action: {result.get('action')}")
