"""
Hiring Coordinator Agent
========================
Manages the full hiring pipeline for a small business:
  - Screens incoming applications against job requirements
  - Drafts move-forward or rejection emails (queued for owner approval)
  - Coordinates interview scheduling over email
  - Follows up with unresponsive candidates (3-day cadence)
  - Conducts reference checks
  - Maintains a live candidate tracker spreadsheet
  - Sends weekly pipeline digest to the owner

Graph flow:
  fetch_workspace_context → search_commons → analyze_task
      → (conditional) → handle_approval | format_response
                                ↓
                        execute_workspace_ops → maybe_contribute → END
"""

import os
import json
import asyncio
from typing import Any
from pathlib import Path

from langchain_openai import ChatOpenAI
from langgraph.graph import StateGraph, END
from pydantic import BaseModel, Field

# ─── Workspace tools (Google or Microsoft) ───────────────────────────────────

try:
    from . import google_tools as _gt  # type: ignore
    _GOOGLE_AVAILABLE = _gt.AVAILABLE
except (ImportError, ValueError):
    try:
        import google_tools as _gt  # type: ignore
        _GOOGLE_AVAILABLE = _gt.AVAILABLE
    except ImportError:
        _gt = None  # type: ignore
        _GOOGLE_AVAILABLE = False

try:
    from . import microsoft_tools as _mt  # type: ignore
    _MICROSOFT_AVAILABLE = _mt.AVAILABLE
except (ImportError, ValueError):
    try:
        import microsoft_tools as _mt  # type: ignore
        _MICROSOFT_AVAILABLE = _mt.AVAILABLE
    except ImportError:
        _mt = None  # type: ignore
        _MICROSOFT_AVAILABLE = False

_WORKSPACE_PROVIDER = os.environ.get("WORKSPACE_PROVIDER", "NONE")

# ─── LLM Config ──────────────────────────────────────────────────────────────

_llm_api_key = os.environ.get("LLM_API_KEY", "")
if not _llm_api_key:
    raise RuntimeError("LLM_API_KEY environment variable is required.")

_llm_model = os.environ.get("LLM_MODEL")
if not _llm_model:
    raise RuntimeError("LLM_MODEL environment variable is required.")

_llm_base_url = os.environ.get("LLM_BASE_URL")

llm = ChatOpenAI(
    model=_llm_model,
    api_key=_llm_api_key,
    base_url=_llm_base_url,
    max_tokens=2048,
)

# ─── Load behavioral docs ─────────────────────────────────────────────────────

_here = Path(__file__).parent
_tools_md = (_here / "TOOLS.md").read_text() if (_here / "TOOLS.md").exists() else ""
_agents_md = (_here / "AGENTS.md").read_text() if (_here / "AGENTS.md").exists() else ""
_soul_md = (_here / "SOUL.md").read_text() if (_here / "SOUL.md").exists() else ""

# ─── State ───────────────────────────────────────────────────────────────────


class AgentState(BaseModel):
    content: str = ""
    context: dict = Field(default_factory=dict)
    analysis: dict = Field(default_factory=dict)
    approval_id: str | None = None
    resolution: dict = Field(default_factory=dict)
    result: dict = Field(default_factory=dict)
    approve_fn: Any = None
    resolve_fn: Any = None
    contribute_fn: Any = None
    search_fn: Any = None
    use_fn: Any = None
    knowledge_hits: list = Field(default_factory=list)
    original_draft: str = ""
    task_type: str = ""
    enriched_content: str = ""


# ─── Nodes ───────────────────────────────────────────────────────────────────


async def fetch_workspace_context(state: AgentState) -> AgentState:
    """Auto-enrich the message with tracker data if a spreadsheet URL is detected."""
    workspace_module = None
    if _WORKSPACE_PROVIDER == "MICROSOFT" and _MICROSOFT_AVAILABLE and _mt:
        workspace_module = _mt
    elif _GOOGLE_AVAILABLE and _gt:
        workspace_module = _gt

    if not workspace_module:
        state.enriched_content = state.content
        return state

    try:
        # google_tools.enrich_message handles URL detection and fetching
        if hasattr(workspace_module, "enrich_message"):
            state.enriched_content = await workspace_module.enrich_message(state.content)
        else:
            state.enriched_content = state.content
    except Exception as exc:
        print(f"[workspace] enrich_message failed (non-fatal): {exc}", flush=True)
        state.enriched_content = state.content
    return state


async def search_commons(state: AgentState) -> AgentState:
    """Search AgentMind for relevant hiring patterns before responding."""
    if not state.search_fn:
        return state
    try:
        query = state.content[:200].strip()
        if not query:
            return state
        hits = await state.search_fn(query=query, limit=3)
        if hits:
            state.knowledge_hits = hits
    except Exception as e:
        print(f"[agentmind] Search failed (non-fatal): {e}", flush=True)
    return state


ANALYSIS_PROMPT = """You are {agent_name}, the Hiring Coordinator at {company_name}.

{soul_instructions}

{behavioral_rules}

{tools_guide}

{agentmind_prompt}

{knowledge_context}

---

## Current Message

{content}

**Hook:** {hook_name}
**Session:** {session_key}

---

## Instructions

First, identify which workflow this message triggers:

1. **new_application** — an email with a resume/application for a job opening
2. **scheduling_reply** — a candidate replying to an interview invitation with their preferred time
3. **owner_decision** — the owner giving you feedback or a hiring decision about a candidate
4. **reference_response** — a reference responding to your questions
5. **followup_check** — a heartbeat trigger (check who needs follow-up, send weekly digest)
6. **candidate_question** — a candidate asking a question about the role or process
7. **other** — something else (route to owner if needed)

Then produce a JSON response (no markdown fences):
{{
  "workflow": "<workflow type from above>",
  "intent": "what this message is asking or doing",
  "task_type": "short label (e.g. screen-application, confirm-interview, send-rejection, weekly-digest)",
  "candidate": {{
    "name": "candidate full name or null",
    "email": "candidate email or null",
    "stage": "applied | screening | interview_scheduled | interviewed | reference_check | offer_extended | hired | rejected | withdrawn | null",
    "notes": "brief screening notes or null — NEVER include full resume text, just a 1-2 sentence summary",
    "interview_datetime": "ISO datetime if scheduling confirmed, else null"
  }},
  "risk_assessment": {{
    "stakes": <1-10>,
    "ambiguity": <1-10>,
    "reversibility": <1-10>,
    "combined": <float average>
  }},
  "needs_approval": <true if combined >= 4.0 OR email goes to external recipient>,
  "action": "send_email | reply_email | none",
  "draft": {{
    "to": "recipient email or null",
    "subject": "subject line or null",
    "text": "full email body — professional, warm, specific to this candidate and role",
    "thread_id": "thread id or null"
  }},
  "owner_notification": {{
    "send": <true if owner should be notified>,
    "text": "brief internal message to owner (e.g. 'Interview with Jane Smith confirmed for Tuesday 3pm') or null"
  }},
  "google_read_requests": [],
  "google_writes": [
    // tracker update — always include when candidate stage changes
    // {{"type": "sheets_append", "file_id": "<from memory>", "range": "Sheet1", "values": [["Name","email","date","stage","role","interview_dt","notes","last_action"]]}}
    // {{"type": "sheets_write", "file_id": "<from memory>", "range": "B5:H5", "values": [["updated","values","here"]]}}
  ],
  "reasoning": "why you chose this action and how you scored the candidate",
  "insight_worthy": <true if you learned something new worth contributing to AgentMind>,
  "insight": {{
    "type": "CORRECTION | PATTERN | RESPONSE_TEMPLATE | TASK_RECIPE | null",
    "title": "short insight title or null",
    "content": "what you learned — generalized, no PII or company names",
    "tags": ["hiring", "screening", "follow-up"]
  }}
}}

## Critical rules

- ALL emails to candidates or references go through approval (needs_approval: true)
- Owner notifications are internal — set needs_approval: false for those
- For new_application: always read the full message before scoring. Missing info = ask the owner, not the candidate.
- For scheduling_reply: extract the exact time the candidate chose and include it in the confirmation email
- For weekly_digest / followup_check: read the tracker first via google_read_requests, then compose
- Tracker file ID comes from your memory (context). If not yet set, note that in reasoning.
- Never include candidate PII in insight contributions
- Sign all emails: "{agent_name}\\nHiring Coordinator, {company_name}"
"""


async def analyze_task(state: AgentState) -> AgentState:
    """Analyze the message and decide on a hiring workflow action."""
    ctx = state.context

    # Build AgentMind knowledge context
    knowledge_context = ""
    if state.knowledge_hits:
        lines = []
        used_ids = []
        for hit in state.knowledge_hits[:3]:
            lines.append(
                f"- [{hit.get('type', '')}] {hit.get('title', '')}: "
                f"{hit.get('content', '')[:300]}"
            )
            if hit.get("id"):
                used_ids.append(hit["id"])
        knowledge_context = (
            "## Relevant insights from other hiring coordinator deployments:\n"
            + "\n".join(lines)
            + "\n\nApply these if relevant."
        )
        if used_ids and state.use_fn:
            try:
                await state.use_fn(used_ids)
            except Exception as e:
                print(f"[agentmind] Report usage failed (non-fatal): {e}", flush=True)

    message_content = state.enriched_content or state.content

    prompt = ANALYSIS_PROMPT.format(
        agent_name=ctx.get("agent_name", "Hiring Coordinator"),
        company_name=ctx.get("company_name", ""),
        content=message_content,
        hook_name=ctx.get("hook_name", ""),
        session_key=ctx.get("session_key", ""),
        soul_instructions=_soul_md,
        behavioral_rules=_agents_md,
        tools_guide=_tools_md,
        agentmind_prompt=ctx.get("agentmind_prompt", ""),
        knowledge_context=knowledge_context,
    )

    try:
        response = await asyncio.wait_for(llm.ainvoke(prompt), timeout=45)
    except asyncio.TimeoutError:
        state.analysis = {
            "intent": "unknown",
            "workflow": "other",
            "task_type": "timeout",
            "needs_approval": True,
            "action": "none",
            "draft": {"to": None, "subject": None, "text": "I need more time to process this — please check back shortly.", "thread_id": None},
            "risk_assessment": {"stakes": 5, "ambiguity": 8, "reversibility": 5, "combined": 6.0},
            "reasoning": "LLM timed out — defaulting to safe no-op",
            "google_writes": [],
            "google_read_requests": [],
        }
        return state

    text = response.content if hasattr(response, "content") else str(response)

    try:
        cleaned = text.strip()
        if cleaned.startswith("```"):
            cleaned = cleaned.split("\n", 1)[1].rsplit("```", 1)[0]
        state.analysis = json.loads(cleaned)
    except (json.JSONDecodeError, ValueError):
        # Extract best-effort JSON
        import re
        match = re.search(r"\{.*\}", text, re.DOTALL)
        if match:
            try:
                state.analysis = json.loads(match.group())
            except Exception:
                state.analysis = {"action": "none", "needs_approval": False, "reasoning": text, "google_writes": []}
        else:
            state.analysis = {"action": "none", "needs_approval": False, "reasoning": text, "google_writes": []}

    state.task_type = state.analysis.get("task_type", "")
    state.original_draft = (state.analysis.get("draft") or {}).get("text", "")

    # Second pass: fetch tracker data if requested
    google_read_requests = state.analysis.get("google_read_requests") or []
    workspace_module = None
    workspace_label = "workspace"
    if _WORKSPACE_PROVIDER == "MICROSOFT" and _MICROSOFT_AVAILABLE and _mt:
        workspace_module = _mt
        workspace_label = "microsoft"
    elif _GOOGLE_AVAILABLE and _gt:
        workspace_module = _gt
        workspace_label = "google"

    if google_read_requests and workspace_module:
        try:
            read_data = await workspace_module.execute_reads(google_read_requests)
            if read_data:
                print(f"[{workspace_label}] Second pass: fetched tracker data", flush=True)
                enriched2 = message_content + f"\n\n[Tracker Data]\n{json.dumps(read_data, indent=2)}"
                prompt2 = ANALYSIS_PROMPT.format(
                    agent_name=ctx.get("agent_name", "Hiring Coordinator"),
                    company_name=ctx.get("company_name", ""),
                    content=enriched2,
                    hook_name=ctx.get("hook_name", ""),
                    session_key=ctx.get("session_key", ""),
                    soul_instructions=_soul_md,
                    behavioral_rules=_agents_md,
                    tools_guide=_tools_md,
                    agentmind_prompt=ctx.get("agentmind_prompt", ""),
                    knowledge_context=knowledge_context,
                )
                response2 = await asyncio.wait_for(llm.ainvoke(prompt2), timeout=45)
                text2 = response2.content if hasattr(response2, "content") else str(response2)
                try:
                    cleaned2 = text2.strip()
                    if cleaned2.startswith("```"):
                        cleaned2 = cleaned2.split("\n", 1)[1].rsplit("```", 1)[0]
                    state.analysis = json.loads(cleaned2)
                    state.task_type = state.analysis.get("task_type", "")
                    state.original_draft = (state.analysis.get("draft") or {}).get("text", "")
                except Exception:
                    pass  # Keep first-pass analysis
        except Exception as exc:
            print(f"[{workspace_label}] Tracker read failed (non-fatal): {exc}", flush=True)

    return state


def should_approve(state: AgentState) -> str:
    """Route to approval queue or direct response based on analysis."""
    if state.analysis.get("needs_approval") and state.analysis.get("action") in ("send_email", "reply_email"):
        return "handle_approval"
    return "format_response"


async def handle_approval(state: AgentState) -> AgentState:
    """Queue the draft email for owner approval and wait for resolution."""
    analysis = state.analysis
    risk = analysis.get("risk_assessment", {})
    draft = analysis.get("draft") or {}

    if not state.approve_fn or not state.resolve_fn:
        state.result = {"action": "none", "reason": "no approval functions available"}
        return state

    approval_id = await state.approve_fn(
        task_type=state.task_type,
        channel="email",
        draft=draft.get("text", ""),
        reasoning=analysis.get("reasoning", ""),
        stakes=risk.get("stakes", 7),
        ambiguity=risk.get("ambiguity", 4),
        reversibility=risk.get("reversibility", 6),
        thread_id=draft.get("thread_id"),
        original_request=state.content,
    )

    state.approval_id = approval_id
    resolution = await state.resolve_fn(approval_id)
    state.resolution = resolution

    if resolution.get("status") == "APPROVED":
        state.result = {
            "action": analysis.get("action", "none"),
            "to": draft.get("to"),
            "subject": draft.get("subject"),
            "text": draft.get("text", ""),
            "thread_id": draft.get("thread_id"),
            "task_type": state.task_type,
            "original_draft": state.original_draft,
            "approval_resolution": resolution,
            "google_writes": analysis.get("google_writes", []),
        }
    elif resolution.get("status") == "EDITED":
        state.result = {
            "action": analysis.get("action", "none"),
            "to": draft.get("to"),
            "subject": draft.get("subject"),
            "text": resolution.get("resolutionAction", draft.get("text", "")),
            "thread_id": draft.get("thread_id"),
            "task_type": state.task_type,
            "original_draft": state.original_draft,
            "approval_resolution": resolution,
            "google_writes": analysis.get("google_writes", []),
        }
    else:
        state.result = {
            "action": "none",
            "reason": f"Rejected: {resolution.get('rejectionReason', '')}",
            "task_type": state.task_type,
            "original_draft": state.original_draft,
            "approval_resolution": resolution,
        }

    return state


async def format_response(state: AgentState) -> AgentState:
    """Format the final response for auto-approved actions (internal messages)."""
    analysis = state.analysis
    draft = analysis.get("draft") or {}

    state.result = {
        "action": analysis.get("action", "none"),
        "to": draft.get("to"),
        "subject": draft.get("subject"),
        "text": draft.get("text", ""),
        "thread_id": draft.get("thread_id"),
        "task_type": state.task_type,
        "google_writes": analysis.get("google_writes", []),
    }
    return state


async def execute_workspace_ops(state: AgentState) -> AgentState:
    """Execute tracker writes and owner notifications after email is handled."""
    # 1. Tracker updates (google_writes)
    writes = state.analysis.get("google_writes") or []
    if writes:
        workspace_module = None
        workspace_label = "workspace"
        if _WORKSPACE_PROVIDER == "MICROSOFT" and _MICROSOFT_AVAILABLE and _mt:
            workspace_module = _mt
            workspace_label = "microsoft"
        elif _GOOGLE_AVAILABLE and _gt:
            workspace_module = _gt
            workspace_label = "google"

        if workspace_module:
            try:
                results = await workspace_module.execute_writes(writes)
                print(f"[{workspace_label}] Tracker updated: {len(writes)} write(s)", flush=True)
            except Exception as exc:
                print(f"[{workspace_label}] Tracker write failed (non-fatal): {exc}", flush=True)

    # 2. Owner notification (internal, auto-approve)
    owner_notif = state.analysis.get("owner_notification") or {}
    if owner_notif.get("send") and owner_notif.get("text") and state.approve_fn:
        # Internal message — send directly without queuing
        ctx = state.context
        manager_email = ctx.get("manager_email") or ctx.get("weekly_digest_email")
        if manager_email:
            try:
                # Use resolve_fn to send immediately (bypasses approval for internal)
                if state.resolve_fn:
                    await state.resolve_fn(
                        action_type="internal_notify",
                        payload={
                            "to": manager_email,
                            "subject": f"[Hiring Update] {state.task_type}",
                            "body": owner_notif["text"],
                        },
                    )
            except Exception as exc:
                print(f"[notify] Owner notification failed (non-fatal): {exc}", flush=True)

    return state


async def maybe_contribute(state: AgentState) -> AgentState:
    """Contribute a hiring insight to AgentMind if warranted."""
    if not state.contribute_fn:
        return state
    if not state.analysis.get("insight_worthy"):
        return state

    insight = state.analysis.get("insight") or {}
    if not insight.get("type") or not insight.get("title") or not insight.get("content"):
        return state

    try:
        await state.contribute_fn(
            contribution_type=insight["type"],
            title=insight["title"],
            content=insight["content"],
            tags=insight.get("tags", ["hiring"]),
            context=state.task_type,
        )
        print(f"[agentmind] Contributed: {insight['title']}", flush=True)
    except Exception as e:
        print(f"[agentmind] Contribution failed (non-fatal): {e}", flush=True)

    return state


# ─── Graph ───────────────────────────────────────────────────────────────────


def build_graph() -> StateGraph:
    graph = StateGraph(AgentState)

    graph.add_node("fetch_workspace_context", fetch_workspace_context)
    graph.add_node("search_commons", search_commons)
    graph.add_node("analyze_task", analyze_task)
    graph.add_node("handle_approval", handle_approval)
    graph.add_node("format_response", format_response)
    graph.add_node("execute_workspace_ops", execute_workspace_ops)
    graph.add_node("maybe_contribute", maybe_contribute)

    graph.set_entry_point("fetch_workspace_context")
    graph.add_edge("fetch_workspace_context", "search_commons")
    graph.add_edge("search_commons", "analyze_task")
    graph.add_conditional_edges("analyze_task", should_approve)
    graph.add_edge("handle_approval", "execute_workspace_ops")
    graph.add_edge("format_response", "execute_workspace_ops")
    graph.add_edge("execute_workspace_ops", "maybe_contribute")
    graph.add_edge("maybe_contribute", END)

    return graph


_compiled_graph = build_graph().compile()

# ─── Public API ──────────────────────────────────────────────────────────────


async def run_agent(
    content: str,
    context: dict,
    approve_fn=None,
    resolve_fn=None,
    contribute_fn=None,
    search_fn=None,
    use_fn=None,
) -> dict:
    """Entry point called by the platform adapter for every incoming message.

    Args:
        content: The message text to process.
        context: Dict with agent_name, agent_email, company_name, hook_name, etc.
        approve_fn: Async fn to queue an action for human approval.
        resolve_fn: Async fn to wait for approval resolution.
        contribute_fn: Async fn to submit a learning to AgentMind.
        search_fn: Async fn to search AgentMind for relevant knowledge.
        use_fn: Async fn to report which contributions were used.

    Returns:
        Dict with at minimum an "action" key. See return-contract.json.
    """
    initial_state = AgentState(
        content=content,
        context=context,
        approve_fn=approve_fn,
        resolve_fn=resolve_fn,
        contribute_fn=contribute_fn,
        search_fn=search_fn,
        use_fn=use_fn,
    )

    final_state = await _compiled_graph.ainvoke(initial_state)

    if isinstance(final_state, dict):
        if "result" in final_state and isinstance(final_state["result"], dict):
            return final_state["result"]
        for v in final_state.values():
            if isinstance(v, AgentState):
                return v.result
        return final_state
    if isinstance(final_state, AgentState):
        return final_state.result
    return {"action": "none"}
