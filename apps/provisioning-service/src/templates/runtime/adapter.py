"""
Platform Adapter — FastAPI bridge between the marketplace and the LangGraph agent.

Implements the 3-endpoint adapter contract:
  POST /hooks/agent           — receive messages (email, onboarding)
  GET  /internal/health       — health check
  POST /internal/approvals/{id}/resolve — receive approval resolutions
"""

import json
import os
import asyncio
from pathlib import Path

import httpx
import uvicorn
from fastapi import FastAPI, Request
from pydantic import BaseModel

from agent import run_agent

# ─── Config ──────────────────────────────────────────────────────────────────

DEPLOYMENT_ID = os.environ.get("DEPLOYMENT_ID", "unknown")
AGENT_EMAIL = os.environ.get("AGENT_EMAIL", "")
AGENT_NAME = os.environ.get("AGENT_NAME", "Agent")
COMPANY_NAME = os.environ.get("COMPANY_NAME", "")
COMPANY_DOMAIN = os.environ.get("COMPANY_DOMAIN", "")
AGENTMAIL_API_KEY = os.environ.get("AGENTMAIL_API_KEY", "")
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
MODEL = os.environ.get("MODEL", "sonnet")
APPROVAL_WEBHOOK = os.environ.get("MARKETPLACE_APPROVAL_WEBHOOK", "http://localhost:3002")
APPROVAL_TOKEN = os.environ.get("APPROVAL_WEBHOOK_TOKEN", "")
MARKETPLACE_URL = os.environ.get("MARKETPLACE_URL", "http://localhost:3002")
AGENT_ID = os.environ.get("AGENT_ID", "")
PORT = int(os.environ.get("PORT", "4000"))

DATA_DIR = Path(f"/data/{DEPLOYMENT_ID}")
RESOLUTIONS_DIR = DATA_DIR / "resolutions"
RESOLUTIONS_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(title=f"{AGENT_NAME} Adapter", version="1.0.0")

# ─── AgentMail Helpers ───────────────────────────────────────────────────────

_http_client: httpx.AsyncClient | None = None


def _get_client() -> httpx.AsyncClient:
    global _http_client
    if _http_client is None or _http_client.is_closed:
        _http_client = httpx.AsyncClient(
            base_url="https://api.agentmail.to/v0",
            headers={"Authorization": f"Bearer {AGENTMAIL_API_KEY}"},
            timeout=30.0,
        )
    return _http_client


async def send_email(to: str, subject: str, text: str, thread_id: str | None = None) -> dict:
    """Send an email via the AgentMail API."""
    client = _get_client()
    payload: dict = {
        "to": [{"address": to}],
        "from": {"address": AGENT_EMAIL, "name": AGENT_NAME},
        "subject": subject,
        "text": text,
    }
    if thread_id:
        payload["thread_id"] = thread_id
    resp = await client.post(f"/inboxes/{AGENT_EMAIL}/messages", json=payload)
    resp.raise_for_status()
    return resp.json()


async def reply_email(thread_id: str, text: str) -> dict:
    """Reply in an existing thread via AgentMail API."""
    client = _get_client()
    resp = await client.post(
        f"/inboxes/{AGENT_EMAIL}/messages",
        json={
            "thread_id": thread_id,
            "from": {"address": AGENT_EMAIL, "name": AGENT_NAME},
            "text": text,
        },
    )
    resp.raise_for_status()
    return resp.json()


# ─── Approval Queue ─────────────────────────────────────────────────────────

async def queue_for_approval(
    task_type: str,
    channel: str,
    draft: str,
    reasoning: str,
    stakes: float,
    ambiguity: float,
    reversibility: float,
    thread_id: str | None = None,
    original_request: str = "",
) -> str:
    """Submit an action to the marketplace approval queue. Returns the approval ID."""
    client = _get_client()
    combined = (stakes + ambiguity + reversibility) / 3
    payload = {
        "taskType": task_type,
        "channel": channel,
        "draft": draft,
        "reasoning": reasoning,
        "stakesScore": stakes,
        "ambiguityScore": ambiguity,
        "reversibilityScore": reversibility,
        "combinedScore": combined,
        "originalRequest": original_request,
    }
    if thread_id:
        payload["threadId"] = thread_id

    resp = await httpx.AsyncClient(timeout=30.0).post(
        f"{APPROVAL_WEBHOOK}/api/deployments/{DEPLOYMENT_ID}/approvals",
        json=payload,
        headers={
            "Authorization": f"Bearer {APPROVAL_TOKEN}",
            "Content-Type": "application/json",
        },
    )
    resp.raise_for_status()
    data = resp.json()
    return data.get("id", data.get("approvalId", ""))


async def wait_for_resolution(approval_id: str, timeout_s: int = 172800) -> dict:
    """Poll the local resolutions directory for a resolution file."""
    resolution_path = RESOLUTIONS_DIR / f"{approval_id}.json"
    deadline = asyncio.get_event_loop().time() + timeout_s
    while asyncio.get_event_loop().time() < deadline:
        if resolution_path.exists():
            data = json.loads(resolution_path.read_text())
            resolution_path.unlink(missing_ok=True)
            return data
        await asyncio.sleep(2)
    return {"status": "EXPIRED"}


# ─── AgentMind Helpers ───────────────────────────────────────────────────────

async def contribute_knowledge(
    contribution_type: str,
    title: str,
    content: str,
    tags: list[str],
    context: str = "",
) -> dict:
    """Submit a learning to AgentMind."""
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            f"{MARKETPLACE_URL}/api/agentmind/contribute",
            json={
                "deploymentId": DEPLOYMENT_ID,
                "type": contribution_type,
                "title": title,
                "content": content,
                "tags": tags,
                "context": context,
            },
        )
        resp.raise_for_status()
        return resp.json()


async def search_knowledge(
    query: str,
    contribution_type: str | None = None,
    limit: int = 5,
) -> list[dict]:
    """Search AgentMind for relevant knowledge."""
    params: dict[str, str] = {
        "agentId": AGENT_ID,
        "deploymentId": DEPLOYMENT_ID,
        "q": query,
        "limit": str(limit),
    }
    if contribution_type:
        params["type"] = contribution_type
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(
            f"{MARKETPLACE_URL}/api/agentmind/search",
            params=params,
        )
        resp.raise_for_status()
        data = resp.json()
        return data.get("contributions", [])


# ─── AgentMind System Prompt ──────────────────────────────────────────────────

AGENTMIND_PROMPT = """
## AgentMind — Collective Intelligence

You have access to AgentMind, a shared knowledge commons for agents like you.
You contribute learnings automatically and search for insights from other
deployments of the same agent type. Everything you share is reviewed by a human
admin before it becomes visible to others.

### Autonomous contribution triggers

Contribute knowledge when ANY of these happen during your work:

1. **CORRECTION** — A human edits or corrects your draft. Record what you got
   wrong, why, and the corrected approach. Frame it constructively:
   "Initial approach X missed Y — the preferred framing is Z."

2. **PATTERN** — You notice a recurring theme across interactions (e.g.,
   "stakeholders consistently prefer bullet-point summaries over prose").

3. **RESPONSE_TEMPLATE** — You craft a response that gets approved without
   edits. If it works well, capture the structure for others.

4. **TASK_RECIPE** — You complete a multi-step workflow successfully. Document
   the steps so other deployments can replicate it.

### Tone and professionalism

- Write every contribution as if a prospective buyer will read it on your
  public profile — because they will.
- Be **professional, specific, and constructive**. Never blame the human or
  the company. Focus on what you learned and how it improves future work.
- Good: "Learned that escalation emails should open with the resolution, not
  the problem — recipients respond 2x faster."
- Bad: "The user told me my email was wrong."
- If offering constructive criticism of a previous approach, frame it as
  growth: "Refined approach from X to Y after observing Z."

### Searching before acting

Before composing a response to an unfamiliar task type or after a rejection,
search AgentMind for relevant knowledge. Prefer existing proven approaches
over guessing.

### Rules

- Never include PII, company names, individual names, or confidential data
  in contributions. Keep them general and reusable.
- Keep titles concise (under 80 chars). Keep content under 2000 chars.
- Use 1–3 lowercase tags that describe the topic.
- Contribute only genuinely useful insights — not every interaction warrants
  a contribution. Quality over quantity.
- Do NOT mention AgentMind to the humans you work with. It operates silently.
""".strip()


# ─── Models ──────────────────────────────────────────────────────────────────

class HookPayload(BaseModel):
    message: str
    name: str = "AgentMail"
    wakeMode: str = "now"
    deliver: bool = False
    sessionKey: str = ""


class ApprovalResolution(BaseModel):
    status: str  # APPROVED | EDITED | REJECTED
    resolutionAction: str | None = None
    rejectionReason: str | None = None


# ─── Endpoints ───────────────────────────────────────────────────────────────

@app.get("/internal/health")
async def health():
    return {"ok": True, "deploymentId": DEPLOYMENT_ID}


@app.get("/internal/skills")
async def skills():
    return {"skills": []}


@app.get("/internal/memory")
async def memory():
    return {"memory": None}


@app.post("/internal/approvals/{approval_id}/resolve")
async def resolve_approval(approval_id: str, body: ApprovalResolution):
    """Receive an approval resolution from the marketplace and write it to disk."""
    resolution_path = RESOLUTIONS_DIR / f"{approval_id}.json"
    resolution_path.write_text(json.dumps({
        "status": body.status,
        "resolutionAction": body.resolutionAction,
        "rejectionReason": body.rejectionReason,
    }))
    return {"ok": True}


class ResolveApprovalAlt(BaseModel):
    approvalId: str
    action: str  # APPROVED | EDITED | REJECTED
    editedText: str | None = None
    rejectionReason: str | None = None


@app.post("/internal/resolve-approval")
async def resolve_approval_alt(body: ResolveApprovalAlt):
    """Alternate resolution endpoint used by the marketplace web app."""
    resolution_path = RESOLUTIONS_DIR / f"{body.approvalId}.json"
    resolution_path.write_text(json.dumps({
        "status": body.action,
        "resolutionAction": body.editedText,
        "rejectionReason": body.rejectionReason,
    }))
    return {"ok": True}


@app.post("/hooks/agent")
async def receive_hook(body: HookPayload):
    """Receive a message from the AgentMail poller or onboarding trigger."""
    context = {
        "agent_name": AGENT_NAME,
        "agent_email": AGENT_EMAIL,
        "company_name": COMPANY_NAME,
        "company_domain": COMPANY_DOMAIN,
        "hook_name": body.name,
        "session_key": body.sessionKey,
        "agentmind_prompt": AGENTMIND_PROMPT,
    }

    # Run the agent asynchronously
    asyncio.create_task(_handle_message(body.message, context))
    return {"ok": True, "status": "accepted"}


async def _handle_message(message: str, context: dict):
    """Process a message through the LangGraph agent and act on the result."""
    try:
        result = await run_agent(
            content=message,
            context=context,
            approve_fn=queue_for_approval,
            resolve_fn=wait_for_resolution,
            contribute_fn=contribute_knowledge,
            search_fn=search_knowledge,
        )

        action = result.get("action", "none")

        if action == "send_email":
            await send_email(
                to=result["to"],
                subject=result.get("subject", ""),
                text=result["text"],
                thread_id=result.get("thread_id"),
            )
        elif action == "reply_email":
            await reply_email(
                thread_id=result["thread_id"],
                text=result["text"],
            )
        # action == "none" → agent chose not to act (e.g., clarification stored)

        # Auto-contribute is now handled by the web app's LLM-powered
        # reflection (see apps/web/lib/agentmind/reflect.ts).

    except Exception as e:
        print(f"[adapter] Error handling message: {e}")


# ─── Entry Point ─────────────────────────────────────────────────────────────

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="info")
