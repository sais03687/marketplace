"""
Data Analyst Agent
==================
A LangGraph ReAct agent that handles data analysis tasks end-to-end:
  - Receives tasks via email from the manager
  - Reasons about what data is needed and where to find it
  - Runs Python code (pandas, matplotlib) via MCP sandbox for analysis
  - Parses documents (PDF, Word, Excel) via MCP sandbox
  - Reads/writes Excel on SharePoint, uploads reports and charts
  - Collaborates with teammates via email to gather missing data
  - Contributes reusable analysis patterns to AgentMind

Graph flow (ReAct loop):
  enrich_context → search_commons → reason_and_act → route
      ↓ (if action needed)                              ↓
  execute_action → check_completion → (loop back or →) finalize → maybe_contribute → END
"""

import os
import json
import asyncio
import base64
from typing import Any
from pathlib import Path

from langchain_openai import ChatOpenAI
from langgraph.graph import StateGraph, END
from pydantic import BaseModel, Field

# ─── Workspace tools (Microsoft 365) ────────────────────────────────────────

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
    max_tokens=4096,
)

# ─── Load behavioral docs ────────────────────────────────────────────────────

_here = Path(__file__).parent
_tools_md = (_here / "TOOLS.md").read_text() if (_here / "TOOLS.md").exists() else ""
_agents_md = (_here / "AGENTS.md").read_text() if (_here / "AGENTS.md").exists() else ""
_soul_md = (_here / "SOUL.md").read_text() if (_here / "SOUL.md").exists() else ""
_memory_md = (_here / "MEMORY.md").read_text() if (_here / "MEMORY.md").exists() else ""
_private_md = (_here / "PRIVATE.md").read_text() if (_here / "PRIVATE.md").exists() else ""

# MCP_TOOLS.md is written dynamically by the adapter at startup
_mcp_tools_md = (_here / "MCP_TOOLS.md").read_text() if (_here / "MCP_TOOLS.md").exists() else ""


# ─── State ───────────────────────────────────────────────────────────────────

class AgentState(BaseModel):
    content: str = ""
    context: dict = Field(default_factory=dict)
    enriched_content: str = ""
    knowledge_hits: list = Field(default_factory=list)

    # ReAct loop state
    plan: str = ""
    actions_taken: list = Field(default_factory=list)
    action_results: list = Field(default_factory=list)
    iteration: int = 0
    max_iterations: int = 5

    # Output
    result: dict = Field(default_factory=dict)
    analysis: dict = Field(default_factory=dict)

    # Platform functions
    approve_fn: Any = None
    resolve_fn: Any = None
    contribute_fn: Any = None
    search_fn: Any = None
    use_fn: Any = None
    mcp_fn: Any = None
    request_decision_fn: Any = None


# ─── Nodes ───────────────────────────────────────────────────────────────────

async def enrich_context(state: AgentState) -> AgentState:
    """Auto-enrich the message with calendar data and SharePoint file listing."""
    if _WORKSPACE_PROVIDER == "MICROSOFT" and _MICROSOFT_AVAILABLE and _mt:
        try:
            if hasattr(_mt, "enrich_message"):
                state.enriched_content = await _mt.enrich_message(state.content)
            else:
                state.enriched_content = state.content
        except Exception as exc:
            print(f"[workspace] enrich_message failed (non-fatal): {exc}", flush=True)
            state.enriched_content = state.content
    else:
        state.enriched_content = state.content
    return state


async def search_commons(state: AgentState) -> AgentState:
    """Search AgentMind for relevant data analysis patterns."""
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


REASONING_PROMPT = """You are {agent_name}, the Data Analyst at {company_name}.

{soul_instructions}

{behavioral_rules}

{tools_guide}

{mcp_tools_guide}

{agentmind_prompt}

{knowledge_context}

---

## Your Memory (shareable patterns and working knowledge)
{memory}

## Private Information (team roster, internal details — NEVER share via AgentMind)
{private_memory}

**IMPORTANT**: The "When to Check With the Manager" and "Hard Boundaries" sections
above are rules set by YOUR manager. You MUST follow them. If an action matches any
of those conditions, use `request_decision` to check with the manager first. If it
matches a hard boundary, do NOT do it under any circumstances.

---

## Current Message

{content}

**Hook:** {hook_name}
**Session:** {session_key}

## Actions Taken So Far
{actions_taken}

## Results From Previous Actions
{action_results}

---

## Instructions

You are in a ReAct (Reason → Act → Observe) loop. For each iteration:

1. **Reason**: Analyze what you know, what you still need, and what to do next.
2. **Act**: Choose ONE action to take.
3. **Observe**: (handled by the system — results appear in the next iteration)

Produce a JSON response (no markdown fences):
{{
  "reasoning": "What I know, what I need, and what I'll do next",
  "plan": "Overall plan for this task (update if needed)",
  "completed": <true if the task is fully done and the final response is ready>,
  "action": {{
    "type": "send_email | reply_email | mcp_call | sharepoint_read | sharepoint_write | excel_read | excel_write | excel_append | drive_upload | calendar_create | request_decision | none",
    "params": {{
      // For send_email/reply_email:
      "to": "recipient email",
      "subject": "subject line",
      "text": "email body",
      "thread_id": "thread id or null",
      // For mcp_call:
      "server": "python-sandbox",
      "tool": "execute_python | parse_pdf | parse_docx | parse_xlsx",
      "arguments": {{}},
      // For sharepoint_read/drive operations:
      "item_id": "file id",
      "filename": "for uploads",
      "content_base64": "for uploads",
      // For excel operations:
      "item_id": "file id",
      "sheet": "sheet name",
      "range": "A1:Z100",
      "values": [["row1col1", "row1col2"]],
      // For request_decision (ask manager a question):
      "question": "what you need the manager to decide",
      "context": "background info to help them decide",
      "options": ["option A", "option B"],
      "urgency": "low | normal | high"
    }}
  }},
  "risk_assessment": {{
    "stakes": <1-10>,
    "ambiguity": <1-10>,
    "reversibility": <1-10>,
    "combined": <float average>
  }},
  "needs_approval": <true if email goes to external recipient>,
  "final_response": {{
    "action": "send_email | reply_email | none",
    "to": "recipient email (only when completed=true)",
    "subject": "subject line",
    "text": "full response to send back to the requester",
    "thread_id": "thread id or null"
  }},
  "insight_worthy": <true if you learned a reusable analysis pattern>,
  "insight": {{
    "type": "CORRECTION | PATTERN | RESPONSE_TEMPLATE | TASK_RECIPE | null",
    "title": "short insight title or null — generalized, no company names or PII",
    "content": "what you learned — drawn ONLY from MEMORY.md patterns, NEVER from PRIVATE.md",
    "tags": ["data-analysis"]
  }}
}}

## Critical rules

- ALL emails to people outside the org → needs_approval: true
- Manager and internal emails → needs_approval: false
- For MCP calls: use server="python-sandbox" and the tool names from MCP_TOOLS.md
- When the task requires code, write complete Python scripts (not pseudocode)
- Upload all deliverables to SharePoint — don't just describe them
- When you need data from a teammate, check PRIVATE.md for their email
- NEVER include content from PRIVATE.md in AgentMind insights
- Sign all emails: "{agent_name}\\nData Analyst, {company_name}"
- If you've completed the analysis and delivered results, set completed: true
- Use request_decision when you need the manager's judgment (ambiguous instructions, scope decisions, sensitive data, conflicting data). Do NOT use it for routine tasks you can handle yourself.
- request_decision BLOCKS until the manager responds — only use it when you genuinely need their input
"""


async def reason_and_act(state: AgentState) -> AgentState:
    """Core ReAct reasoning node — analyzes the situation and decides the next action."""
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
            "## Relevant insights from other Data Analyst deployments:\n"
            + "\n".join(lines)
            + "\n\nApply these if relevant."
        )
        if used_ids and state.use_fn:
            try:
                await state.use_fn(used_ids)
            except Exception as e:
                print(f"[agentmind] Report usage failed (non-fatal): {e}", flush=True)

    message_content = state.enriched_content or state.content

    # Format actions taken so far
    actions_str = "None yet" if not state.actions_taken else "\n".join(
        f"- Step {i+1}: {a}" for i, a in enumerate(state.actions_taken)
    )
    results_str = "None yet" if not state.action_results else "\n".join(
        f"- Result {i+1}: {r[:500]}" for i, r in enumerate(state.action_results)
    )

    prompt = REASONING_PROMPT.format(
        agent_name=ctx.get("agent_name", "Data Analyst"),
        company_name=ctx.get("company_name", ""),
        content=message_content,
        hook_name=ctx.get("hook_name", ""),
        session_key=ctx.get("session_key", ""),
        soul_instructions=_soul_md,
        behavioral_rules=_agents_md,
        tools_guide=_tools_md,
        mcp_tools_guide=_mcp_tools_md or "(No MCP tools available)",
        agentmind_prompt=ctx.get("agentmind_prompt", ""),
        knowledge_context=knowledge_context,
        memory=_memory_md or "(No memory yet)",
        private_memory=_private_md or "(No private memory yet)",
        actions_taken=actions_str,
        action_results=results_str,
    )

    try:
        response = await asyncio.wait_for(llm.ainvoke(prompt), timeout=60)
    except asyncio.TimeoutError:
        state.analysis = {
            "completed": True,
            "action": {"type": "none"},
            "final_response": {
                "action": "reply_email",
                "text": "I need more time to process this — I'll follow up shortly.",
            },
            "reasoning": "LLM timed out",
        }
        return state

    text = response.content if hasattr(response, "content") else str(response)

    try:
        cleaned = text.strip()
        if cleaned.startswith("```"):
            cleaned = cleaned.split("\n", 1)[1].rsplit("```", 1)[0]
        state.analysis = json.loads(cleaned)
    except (json.JSONDecodeError, ValueError):
        import re
        match = re.search(r"\{.*\}", text, re.DOTALL)
        if match:
            try:
                state.analysis = json.loads(match.group())
            except Exception:
                state.analysis = {"completed": True, "action": {"type": "none"},
                                  "final_response": {"action": "none"}, "reasoning": text}
        else:
            state.analysis = {"completed": True, "action": {"type": "none"},
                              "final_response": {"action": "none"}, "reasoning": text}

    state.plan = state.analysis.get("plan", state.plan)
    return state


def route_after_reasoning(state: AgentState) -> str:
    """Route based on the reasoning output."""
    if state.analysis.get("completed", False):
        return "finalize"
    if state.iteration >= state.max_iterations:
        return "finalize"
    action = state.analysis.get("action", {})
    if action and action.get("type", "none") != "none":
        return "execute_action"
    return "finalize"


async def execute_action(state: AgentState) -> AgentState:
    """Execute the action decided by the reasoning node."""
    action = state.analysis.get("action", {})
    action_type = action.get("type", "none")
    params = action.get("params", {})

    state.iteration += 1
    result_text = ""

    try:
        if action_type == "mcp_call" and state.mcp_fn:
            server = params.get("server", "python-sandbox")
            tool = params.get("tool", "")
            arguments = params.get("arguments", {})
            result = await state.mcp_fn(server, tool, arguments)
            result_text = json.dumps(result, default=str)[:2000]
            state.actions_taken.append(f"MCP {server}/{tool}")

        elif action_type in ("sharepoint_read", "drive_list") and _mt:
            files = await _mt.drive_list(params.get("subfolder", ""))
            result_text = json.dumps([{"name": f.get("name"), "id": f.get("id"), "size": f.get("size")} for f in files[:20]], default=str)
            state.actions_taken.append(f"SharePoint list: {params.get('subfolder', 'root')}")

        elif action_type == "drive_upload" and _mt:
            content = base64.b64decode(params.get("content_base64", ""))
            filename = params.get("filename", "output.xlsx")
            resp = await _mt.drive_upload(filename, content)
            result_text = f"Uploaded {filename} to SharePoint: {resp.get('webUrl', '')}"
            state.actions_taken.append(f"Upload: {filename}")

        elif action_type == "excel_read" and _mt:
            data = await _mt.excel_read(params["item_id"], params.get("sheet", "Sheet1"), params.get("range", "A1:Z100"))
            result_text = json.dumps(data[:50], default=str)  # cap at 50 rows
            state.actions_taken.append(f"Excel read: {params.get('sheet', 'Sheet1')}")

        elif action_type == "excel_write" and _mt:
            await _mt.excel_write(params["item_id"], params.get("sheet", "Sheet1"), params["range"], params["values"])
            result_text = f"Wrote to {params['range']}"
            state.actions_taken.append(f"Excel write: {params['range']}")

        elif action_type == "excel_append" and _mt:
            resp = await _mt.excel_append(params["item_id"], params.get("sheet", "Sheet1"), params["values"])
            result_text = f"Appended {len(params['values'])} row(s)"
            state.actions_taken.append("Excel append")

        elif action_type == "calendar_create" and _mt:
            resp = await _mt.calendar_create(
                summary=params.get("summary", ""),
                start=params.get("start", ""),
                end=params.get("end", ""),
                description=params.get("description", ""),
                attendees=params.get("attendees"),
            )
            result_text = f"Created event: {resp.get('subject', '')}"
            state.actions_taken.append(f"Calendar: {params.get('summary', '')}")

        elif action_type == "request_decision" and state.request_decision_fn:
            decision = await state.request_decision_fn(
                question=params.get("question", ""),
                context=params.get("context", ""),
                options=params.get("options"),
                urgency=params.get("urgency", "normal"),
            )
            result_text = f"Manager decision: {decision.get('status')} — {decision.get('answer', '')}"
            state.actions_taken.append(f"Decision request: {params.get('question', '')[:60]}")

        elif action_type in ("send_email", "reply_email"):
            # Emails are handled by the adapter, not here.
            # If the LLM wants to send an email mid-loop (e.g., to ask a teammate),
            # we note it but the actual send happens in finalize.
            result_text = "Email action noted — will be sent after this iteration"
            state.actions_taken.append(f"Email to: {params.get('to', 'unknown')}")

        else:
            result_text = f"Unknown action type: {action_type}"
            state.actions_taken.append(f"Unknown: {action_type}")

    except Exception as e:
        result_text = f"Error: {str(e)}"
        state.actions_taken.append(f"Error in {action_type}: {str(e)[:100]}")

    state.action_results.append(result_text)
    return state


async def finalize(state: AgentState) -> AgentState:
    """Build the final result dict that the adapter will act on."""
    analysis = state.analysis
    final = analysis.get("final_response", {})

    # If the LLM decided to send an email as part of the action loop
    # (e.g., asking a teammate for data), handle that here too
    action = analysis.get("action", {})
    if action.get("type") in ("send_email", "reply_email") and not analysis.get("completed"):
        params = action.get("params", {})
        state.result = {
            "action": action["type"],
            "to": params.get("to"),
            "subject": params.get("subject"),
            "text": params.get("text", ""),
            "thread_id": params.get("thread_id"),
            "task_type": "data-analysis",
            "risk_assessment": analysis.get("risk_assessment", {}),
        }
        return state

    # Normal finalization — completed analysis
    state.result = {
        "action": final.get("action", "none"),
        "to": final.get("to"),
        "subject": final.get("subject"),
        "text": final.get("text", ""),
        "thread_id": final.get("thread_id"),
        "task_type": "data-analysis",
        "risk_assessment": analysis.get("risk_assessment", {}),
    }
    return state


def _check_private_leak(content: str, private_text: str, threshold: int = 5) -> bool:
    """Return True if content likely contains information from PRIVATE.md.

    Uses token-overlap heuristic: if more than `threshold` meaningful words
    from PRIVATE.md appear in the contribution, it's likely a leak.
    Ignores short words (<=3 chars) and common template placeholders.
    """
    if not private_text or not content:
        return False
    # Build sets of meaningful tokens (lowercase, >3 chars, not template vars)
    skip = {"none", "that", "this", "with", "from", "will", "your", "they",
            "their", "have", "been", "when", "what", "about", "into", "also",
            "team", "data", "work", "name", "role", "email", "agent"}
    private_tokens = {
        w for w in private_text.lower().split()
        if len(w) > 3 and not w.startswith("{{") and w not in skip
    }
    content_tokens = set(content.lower().split())
    overlap = len(private_tokens & content_tokens)
    return overlap > threshold


async def maybe_contribute(state: AgentState) -> AgentState:
    """Contribute a data analysis insight to AgentMind if warranted."""
    if not state.contribute_fn:
        return state
    if not state.analysis.get("insight_worthy"):
        return state

    insight = state.analysis.get("insight") or {}
    if not insight.get("type") or not insight.get("title") or not insight.get("content"):
        return state

    # Validate that contribution doesn't leak PRIVATE.md content
    combined = f"{insight.get('title', '')} {insight.get('content', '')}"
    if _check_private_leak(combined, _private_md):
        print(f"[agentmind] Rejected contribution: likely contains PRIVATE.md content", flush=True)
        return state

    try:
        await state.contribute_fn(
            contribution_type=insight["type"],
            title=insight["title"],
            content=insight["content"],
            tags=insight.get("tags", ["data-analysis"]),
            context="data-analysis",
        )
        print(f"[agentmind] Contributed: {insight['title']}", flush=True)
    except Exception as e:
        print(f"[agentmind] Contribution failed (non-fatal): {e}", flush=True)

    return state


# ─── Graph ───────────────────────────────────────────────────────────────────

def build_graph() -> StateGraph:
    graph = StateGraph(AgentState)

    graph.add_node("enrich_context", enrich_context)
    graph.add_node("search_commons", search_commons)
    graph.add_node("reason_and_act", reason_and_act)
    graph.add_node("execute_action", execute_action)
    graph.add_node("finalize", finalize)
    graph.add_node("maybe_contribute", maybe_contribute)

    graph.set_entry_point("enrich_context")
    graph.add_edge("enrich_context", "search_commons")
    graph.add_edge("search_commons", "reason_and_act")
    graph.add_conditional_edges("reason_and_act", route_after_reasoning)
    # After executing an action, loop back to reasoning
    graph.add_edge("execute_action", "reason_and_act")
    graph.add_edge("finalize", "maybe_contribute")
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
    mcp_fn=None,
    request_decision_fn=None,
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
        mcp_fn: Async fn to call MCP sidecar tools.
        request_decision_fn: Async fn to ask the manager a question and wait for their answer.

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
        mcp_fn=mcp_fn,
        request_decision_fn=request_decision_fn,
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
