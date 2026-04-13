"""Probe the creator agent: run it directly with instrumentation."""
import asyncio
import time
import sys

sys.path.insert(0, "/agent")
from creator.agent import run_agent

async def fake_approve(**kw): print("[probe] approve called"); return "fake-id"
async def fake_resolve(approval_id, **kw): print("[probe] resolve called"); return {"status": "APPROVED"}
async def fake_contribute(**kw): print("[probe] contribute called"); return {"ok": True}
async def fake_search(**kw):
    print(f"[probe] search called with {kw}")
    t = time.time()
    # Simulate a fast search
    await asyncio.sleep(0.01)
    print(f"[probe] search returned in {time.time()-t:.2f}s")
    return []

context = {
    "agent_name": "Test LangChain Agent",
    "agent_email": "test-langchain-agent-my-company@agentmail.to",
    "company_name": "My Company",
    "company_domain": "mycompany.com",
    "hook_name": "AgentMail",
    "session_key": "probe:test",
    "agentmind_prompt": "## AgentMind — use it or don't.",
    "thread_id": "probe-thread",
    "message_id": "probe-msg",
    "sender": "sai.suram07@gmail.com",
    "subject": "Re: Test",
}

content = "Yep this works\n\nOn Fri, Apr 10, 2026, 8:15 PM Test LangChain Agent wrote:\n> Hotpatch smoke test"

print("[probe] Calling run_agent...", flush=True)
t0 = time.time()
result = asyncio.run(run_agent(
    content=content,
    context=context,
    approve_fn=fake_approve,
    resolve_fn=fake_resolve,
    contribute_fn=fake_contribute,
    search_fn=fake_search,
))
print(f"[probe] run_agent returned in {time.time()-t0:.1f}s")
print(f"[probe] result keys: {list(result.keys())}")
print(f"[probe] action: {result.get('action')}")
print(f"[probe] to: {result.get('to')}")
print(f"[probe] text preview: {str(result.get('text', ''))[:300]}")
