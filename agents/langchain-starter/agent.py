"""
LangGraph Agent with AgentMind Integration

Graph flow:
  search_commons → analyze_task → (conditional) → handle_approval OR format_response
                                                          ↓
                                                  maybe_contribute → END

Agents autonomously search AgentMind before acting and contribute learnings
after corrections, patterns, or successful task completions.
"""

import os
import json
import asyncio
from typing import Any
from pathlib import Path

from langchain_openai import ChatOpenAI
from langgraph.graph import StateGraph, END
from pydantic import BaseModel, Field

try:
    # Relative import works when loaded as `creator.agent` (the normal case in the container).
    # Falls back to bare import if run as a standalone script (e.g. local testing).
    from . import google_tools as _gt  # type: ignore
    _GOOGLE_AVAILABLE = _gt.AVAILABLE
except (ImportError, ValueError):
    try:
        import google_tools as _gt  # type: ignore
        _GOOGLE_AVAILABLE = _gt.AVAILABLE
    except ImportError:
        _gt = None  # type: ignore
        _GOOGLE_AVAILABLE = False

# ─── Config ──────────────────────────────────────────────────────────────────

# Platform sets these env vars at provision time — no hardcoded defaults
_llm_api_key = os.environ.get("LLM_API_KEY", "")
if not _llm_api_key:
    raise RuntimeError(
        "LLM_API_KEY environment variable is required. "
        "Set it in your deployment configuration."
    )

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

# Load TOOLS.md for the system prompt (includes AgentMind guidelines)
_tools_md_path = Path(__file__).parent / "TOOLS.md"
_tools_md = _tools_md_path.read_text() if _tools_md_path.exists() else ""

_agents_md_path = Path(__file__).parent / "AGENTS.md"
_agents_md = _agents_md_path.read_text() if _agents_md_path.exists() else ""

_soul_md_path = Path(__file__).parent / "SOUL.md"
_soul_md = _soul_md_path.read_text() if _soul_md_path.exists() else ""

# ─── State ───────────────────────────────────────────────────────────────────


class AgentState(BaseModel):
    """State passed between graph nodes."""
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
    # AgentMind state
    knowledge_hits: list = Field(default_factory=list)
    original_draft: str = ""
    task_type: str = ""
    # Google enrichment
    enriched_content: str = ""   # message after auto-fetching Google URLs


# ─── Nodes ───────────────────────────────────────────────────────────────────

async def fetch_google_context(state: AgentState) -> AgentState:
    """Auto-enrich the message with Google file content for any detected URLs."""
    if not _GOOGLE_AVAILABLE or not _gt:
        state.enriched_content = state.content
        return state
    try:
        state.enriched_content = await _gt.enrich_message(state.content)
    except Exception as exc:
        print(f"[google] enrich_message failed (non-fatal): {exc}", flush=True)
        state.enriched_content = state.content
    return state


async def search_commons(state: AgentState) -> AgentState:
    """Search AgentMind for relevant knowledge before composing a response."""
    if not state.search_fn:
        return state

    try:
        # Extract a short search query from the incoming message
        query = state.content[:200].strip()
        if not query:
            return state

        hits = await state.search_fn(query=query, limit=3)
        if hits:
            state.knowledge_hits = hits
    except Exception as e:
        print(f"[agentmind] Search failed (non-fatal): {e}")

    return state


ANALYSIS_PROMPT = """You are {agent_name}, an AI employee at {company_name}.

{soul_instructions}

{behavioral_rules}

{tools_guide}

{agentmind_prompt}

{knowledge_context}

Analyze this incoming message and decide what to do.

Message:
{content}

Context:
- Hook: {hook_name}
- Session: {session_key}

Respond with a JSON object (no markdown fences):
{{
  "intent": "what the sender wants",
  "task_type": "a short category label (e.g. email-reply, scheduling, research, escalation)",
  "risk_assessment": {{
    "stakes": <1-10>,
    "ambiguity": <1-10>,
    "reversibility": <1-10>,
    "combined": <float>
  }},
  "needs_approval": <true if combined >= 6.0>,
  "action": "send_email | reply_email | none",
  "draft": {{
    "to": "recipient email or null",
    "subject": "subject line or null",
    "text": "response text",
    "thread_id": "thread id or null"
  }},
  "reasoning": "why you chose this action",
  "google_read_requests": [
    // optional — include if you need more Google data before responding
    // {{"type": "drive_search", "query": "...", "limit": 5}}
    // {{"type": "drive_get_file", "file_id": "..."}}
    // {{"type": "sheets_read", "file_id": "...", "range": "A1:Z50"}}
    // {{"type": "docs_read", "file_id": "..."}}
    // {{"type": "calendar_list", "time_min": "2026-05-16T00:00:00Z", "time_max": "2026-05-23T23:59:59Z"}}
  ],
  "google_writes": [
    // optional — executed after email is sent
    // {{"type": "sheets_write", "file_id": "...", "range": "B2", "values": [["v1","v2"]]}}
    // {{"type": "sheets_append", "file_id": "...", "range": "Sheet1", "values": [["new","row"]]}}
    // {{"type": "docs_append", "file_id": "...", "text": "appended text"}}
    // {{"type": "calendar_create", "summary": "...", "start": "...", "end": "...", "attendees": ["x@y.com"], "timezone": "UTC"}}
    // {{"type": "calendar_update", "event_id": "...", "summary": "new title"}}
    // {{"type": "calendar_delete", "event_id": "..."}}
  ],
  "insight_worthy": <true if you learned something new or want to contribute to AgentMind>,
  "insight": {{
    "type": "CORRECTION | PATTERN | RESPONSE_TEMPLATE | TASK_RECIPE | null",
    "title": "short insight title or null",
    "content": "what you learned or null",
    "tags": ["tag1", "tag2"]
  }}
}}
"""


async def analyze_task(state: AgentState) -> AgentState:
    """Ask the LLM to analyze the message and decide on an action."""
    ctx = state.context

    # Build knowledge context from AgentMind search results
    knowledge_context = ""
    if state.knowledge_hits:
        knowledge_lines = []
        used_ids = []
        for hit in state.knowledge_hits[:3]:
            knowledge_lines.append(
                f"- [{hit.get('type', '')}] {hit.get('title', '')}: "
                f"{hit.get('content', '')[:300]}"
            )
            if hit.get("id"):
                used_ids.append(hit["id"])
        knowledge_context = (
            "## Relevant insights from other deployments:\n"
            + "\n".join(knowledge_lines)
            + "\n\nUse these insights to inform your response if relevant."
        )
        # Report usage — auto-upvotes contributions we actually incorporated
        if used_ids and state.use_fn:
            try:
                await state.use_fn(used_ids)
            except Exception as e:
                print(f"[agentmind] Report usage failed (non-fatal): {e}")

    # Use enriched content (with Google file data) if available
    message_content = state.enriched_content or state.content

    prompt = ANALYSIS_PROMPT.format(
        agent_name=ctx.get("agent_name", "Agent"),
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
        # Conservative fallback — treat as high-risk
        state.analysis = {
            "intent": "unknown",
            "complexity": "high",
            "risk_assessment": {"stakes": 8, "ambiguity": 8, "reversibility": 8, "combined": 8.0},
            "needs_approval": True,
            "draft_response": "I need a moment to process this request. Let me get back to you shortly.",
            "action": "none",
            "draft": {"to": None, "subject": None, "text": "I need a moment to process this request. Let me get back to you shortly.", "thread_id": None},
            "reasoning": "LLM request timed out after 45s; defaulting to safe behavior.",
            "insight_worthy": False,
            "insight": None,
        }
        state.task_type = "unknown"
        return state

    text = response.content if hasattr(response, "content") else str(response)

    # Parse JSON from LLM response
    try:
        cleaned = text.strip()
        if cleaned.startswith("```"):
            cleaned = cleaned.split("\n", 1)[1]
            cleaned = cleaned.rsplit("```", 1)[0]
        analysis = json.loads(cleaned)
    except (json.JSONDecodeError, IndexError):
        analysis = {
            "intent": "unclear",
            "task_type": "unknown",
            "risk_assessment": {"stakes": 5, "ambiguity": 8, "reversibility": 5, "combined": 6.0},
            "needs_approval": True,
            "action": "none",
            "draft": {"to": None, "subject": None, "text": text, "thread_id": None},
            "reasoning": "Failed to parse LLM response as JSON; defaulting to safe behavior.",
            "insight_worthy": False,
            "insight": None,
        }

    # Clamp risk scores to valid range [1, 10]
    def _clamp(v, lo=1.0, hi=10.0):
        try:
            return max(lo, min(hi, float(v)))
        except (TypeError, ValueError):
            return hi  # default to high risk if unparseable

    risk = analysis.get("risk_assessment", {})
    analysis["risk_assessment"] = {
        "stakes": _clamp(risk.get("stakes", 8)),
        "ambiguity": _clamp(risk.get("ambiguity", 8)),
        "reversibility": _clamp(risk.get("reversibility", 8)),
        "combined": _clamp(risk.get("combined", 8.0)),
    }

    # ── Google read-request second pass ──────────────────────────────────────
    # If the LLM wants more data (drive_search, calendar_list, etc.), fetch it
    # and re-invoke once so it can give an informed response.
    google_read_requests = analysis.get("google_read_requests") or []
    if google_read_requests and _GOOGLE_AVAILABLE and _gt:
        try:
            read_data = await _gt.execute_reads(google_read_requests)
            if read_data:
                print(f"[google] Second pass: fetched {len(google_read_requests)} read request(s)", flush=True)
                enriched2 = message_content + f"\n\n[Google Data]\n{read_data}"
                prompt2 = ANALYSIS_PROMPT.format(
                    agent_name=ctx.get("agent_name", "Agent"),
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
                    analysis = json.loads(cleaned2)
                    # Re-clamp risk scores
                    risk2 = analysis.get("risk_assessment", {})
                    analysis["risk_assessment"] = {
                        "stakes": _clamp(risk2.get("stakes", 8)),
                        "ambiguity": _clamp(risk2.get("ambiguity", 8)),
                        "reversibility": _clamp(risk2.get("reversibility", 8)),
                        "combined": _clamp(risk2.get("combined", 8.0)),
                    }
                except (json.JSONDecodeError, IndexError):
                    pass  # keep original analysis if second pass parse fails
        except Exception as exc:
            print(f"[google] Read-request second pass failed (non-fatal): {exc}", flush=True)

    state.analysis = analysis
    state.task_type = analysis.get("task_type", "unknown")
    state.original_draft = analysis.get("draft", {}).get("text", "")
    return state


async def handle_approval(state: AgentState) -> AgentState:
    """Queue the action for approval and wait for resolution."""
    analysis = state.analysis
    risk = analysis.get("risk_assessment", {})
    draft = analysis.get("draft", {})

    if not state.approve_fn or not state.resolve_fn:
        state.result = {"action": "none", "reason": "no approval functions available"}
        return state

    approval_id = await state.approve_fn(
        task_type=state.task_type,
        channel="email",
        draft=draft.get("text", ""),
        reasoning=analysis.get("reasoning", ""),
        stakes=risk.get("stakes", 5),
        ambiguity=risk.get("ambiguity", 5),
        reversibility=risk.get("reversibility", 5),
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
    """Format the final response for auto-executed actions."""
    analysis = state.analysis
    draft = analysis.get("draft", {})

    state.result = {
        "action": analysis.get("action", "none"),
        "to": draft.get("to"),
        "subject": draft.get("subject"),
        "text": draft.get("text", ""),
        "thread_id": draft.get("thread_id"),
        "task_type": state.task_type,
    }
    return state


async def execute_google_ops(state: AgentState) -> AgentState:
    """Execute any google_writes the LLM included in its response.

    Runs after the email is prepared (before maybe_contribute).
    Non-fatal: write errors are logged but don't abort the response.
    """
    writes = state.analysis.get("google_writes") or []
    if not writes or not _GOOGLE_AVAILABLE or not _gt:
        return state
    try:
        results = await _gt.execute_writes(writes)
        print(f"[google] Executed {len(writes)} write(s): {results}", flush=True)
    except Exception as exc:
        print(f"[google] execute_writes failed (non-fatal): {exc}", flush=True)
    return state


async def maybe_contribute(state: AgentState) -> AgentState:
    """Autonomously contribute an insight to AgentMind if the LLM flagged one."""
    if not state.contribute_fn:
        return state

    analysis = state.analysis
    if not analysis.get("insight_worthy"):
        return state

    insight = analysis.get("insight")
    if not insight or not insight.get("type") or not insight.get("title"):
        return state

    try:
        await state.contribute_fn(
            contribution_type=insight["type"],
            title=insight["title"][:200],
            content=(insight.get("content") or "")[:2000],
            tags=insight.get("tags", [])[:5] or ["general"],
            context=state.content[:500],
        )
    except Exception as e:
        # Never let AgentMind errors disrupt the main agent flow
        print(f"[agentmind] Contribute failed (non-fatal): {e}")

    return state


# ─── Graph ───────────────────────────────────────────────────────────────────

def should_approve(state: AgentState) -> str:
    """Conditional edge: route to approval or direct response."""
    if state.analysis.get("needs_approval", False):
        return "handle_approval"
    return "format_response"


def build_graph() -> StateGraph:
    graph = StateGraph(AgentState)

    graph.add_node("fetch_google_context", fetch_google_context)
    graph.add_node("search_commons", search_commons)
    graph.add_node("analyze_task", analyze_task)
    graph.add_node("handle_approval", handle_approval)
    graph.add_node("format_response", format_response)
    graph.add_node("execute_google_ops", execute_google_ops)
    graph.add_node("maybe_contribute", maybe_contribute)

    graph.set_entry_point("fetch_google_context")
    graph.add_edge("fetch_google_context", "search_commons")
    graph.add_edge("search_commons", "analyze_task")
    graph.add_conditional_edges("analyze_task", should_approve)
    graph.add_edge("handle_approval", "execute_google_ops")
    graph.add_edge("format_response", "execute_google_ops")
    graph.add_edge("execute_google_ops", "maybe_contribute")
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
    """Run the agent graph and return the result dict.

    Args:
        content: The message text to process.
        context: Dict with agent_name, agent_email, company_name, agentmind_prompt, etc.
        approve_fn: Async function to queue an action for approval.
        resolve_fn: Async function to wait for an approval resolution.
        contribute_fn: Async function to submit a learning to AgentMind.
        search_fn: Async function to search AgentMind for relevant knowledge.
        use_fn: Async function to report which contributions were used (auto-upvotes).

    Returns:
        Dict with keys: action, to, subject, text, thread_id, task_type,
        original_draft, approval_resolution (any may be None).
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

    # LangGraph returns state as a dict of field values; extract the result field
    if isinstance(final_state, dict):
        # LangGraph with Pydantic state returns a flat dict of field values
        if "result" in final_state and isinstance(final_state["result"], dict):
            return final_state["result"]
        result_state = final_state.get("__end__", final_state)
        if isinstance(result_state, AgentState):
            return result_state.result
        for v in final_state.values():
            if isinstance(v, AgentState):
                return v.result
        return final_state
    if isinstance(final_state, AgentState):
        return final_state.result
    return {"action": "none"}
