"""Reproduce the exact adapter webhook code path with the real hanging message."""
import asyncio
import time
import sys
import os

sys.path.insert(0, "/agent")

# Exact mirror of what adapter.py builds for the webhook
AGENT_NAME = os.environ.get("AGENT_NAME", "Test LangChain Agent")
AGENT_EMAIL = os.environ.get("AGENT_EMAIL", "test-langchain-agent-my-company@agentmail.to")
COMPANY_NAME = os.environ.get("COMPANY_NAME", "My Company")
COMPANY_DOMAIN = os.environ.get("COMPANY_DOMAIN", "mycompany.com")

# Same AGENTMIND_PROMPT string the adapter uses (trimmed for brevity inside probe)
AGENTMIND_PROMPT = """
## AgentMind — Collective Intelligence

You have access to AgentMind, a shared knowledge commons for agents like you.
Contribute learnings automatically and search for insights from other
deployments. Everything is reviewed by a human admin before becoming visible.

### Autonomous contribution triggers
1. CORRECTION, 2. PATTERN, 3. RESPONSE_TEMPLATE, 4. TASK_RECIPE.

### Tone
Professional, specific, constructive. Never blame. Keep contributions general.
""".strip()

# Real adapter helpers (scrubbed env forces us to set AGENTMAIL key if needed)
from adapter import contribute_knowledge, search_knowledge

async def fake_approve(**kw):
    print(f"[probe] approve called: {list(kw.keys())}", flush=True)
    return "fake-id"

async def fake_resolve(approval_id, **kw):
    print(f"[probe] resolve called for {approval_id}", flush=True)
    return {"status": "APPROVED"}

async def timed_search(**kw):
    t = time.time()
    print(f"[probe] search_knowledge START: {kw.get('query', '')[:60]}", flush=True)
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

# Exact replication of what the adapter builds in /hooks/agentmail
sender = "Sai Suram <sai.suram07@gmail.com>"
subject = "Re: test"
thread_id = "d5871630-40d2-4ba0-8dd6-27ea390772a7"
message_id = "probe-real-msg"
# Real email text includes quoted reply
text = (
    "Yep this works\n\n"
    "On Fri, Apr 10, 2026, 8:15 PM Test LangChain Agent "
    "<test-langchain-agent-my-company@agentmail.to> wrote:\n"
    "> Hotpatch smoke test — this confirms the new reply endpoint works.\n"
    "> Please reply if you got this."
)

formatted = (
    f"New email from {sender}\n"
    f"Subject: {subject}\n"
    f"Thread ID: {thread_id}\n\n"
    f"{text}"
)

context = {
    "agent_name": AGENT_NAME,
    "agent_email": AGENT_EMAIL,
    "company_name": COMPANY_NAME,
    "company_domain": COMPANY_DOMAIN,
    "hook_name": "AgentMail",
    "session_key": f"hook:agentmail:{thread_id}",
    "agentmind_prompt": AGENTMIND_PROMPT,
    "thread_id": thread_id,
    "message_id": message_id,
    "sender": sender,
    "subject": subject,
}

from creator.agent import run_agent

print(f"[probe] Calling run_agent with REAL paths, content len={len(formatted)}", flush=True)
t0 = time.time()
try:
    result = asyncio.run(asyncio.wait_for(run_agent(
        content=formatted,
        context=context,
        approve_fn=fake_approve,
        resolve_fn=fake_resolve,
        contribute_fn=timed_contribute,
        search_fn=timed_search,
    ), timeout=60))
    print(f"[probe] run_agent TOTAL: {time.time()-t0:.1f}s", flush=True)
    print(f"[probe] action: {result.get('action')}", flush=True)
    print(f"[probe] to: {result.get('to')}", flush=True)
    print(f"[probe] text preview: {str(result.get('text', ''))[:200]}", flush=True)
except asyncio.TimeoutError:
    print(f"[probe] TIMEOUT after {time.time()-t0:.1f}s — the real webhook path is HANGING here", flush=True)
except Exception as e:
    print(f"[probe] ERROR after {time.time()-t0:.1f}s: {type(e).__name__}: {e}", flush=True)
