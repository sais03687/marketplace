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
from langgraph.types import interrupt, Command
from langgraph.checkpoint.memory import MemorySaver
from langgraph.errors import GraphInterrupt
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
_WORKSPACE_SCOPE = os.environ.get("WORKSPACE_SCOPE", "platform")

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

# ─── Actions that require manager approval before execution ──────────────────

BLOCKED_ACTIONS = {
    # Writes — irreversible changes to the buyer's data.
    "excel_write",
    "excel_append",
    "drive_upload",
    # Same act as drive_upload, on the agent's own OneDrive rather than the shared
    # site. It was dispatched but ungated, and unreachable only because nothing
    # advertised it — which is not a control, just an accident.
    "my_drive_upload",
    "calendar_delete",
    # Sharing — grants another person access to a file. These matter at least as
    # much as the writes above, and were ungated until 2026-08-01.
    #
    # The agent authenticates with *application* Graph permissions, so Graph
    # enforces the app's rights and never the asker's. There is no per-user
    # document isolation underneath: anyone the allowlist admits can ask for any
    # file in the tenant. The allowlist governs who may talk to the agent, not
    # what they may be given. Sharing is therefore the one action that can move
    # data out of the tenant, and it is the action approvals exist for.
    #
    # The agent also cannot read existing permissions on a file, so it grants
    # access blind — it has no way to know whether a recipient already had it.
    # Until it can, a human has to be the check.
    "drive_share",
    "drive_create_link",
    "my_drive_share",
    "my_drive_create_link",
}

# ─── Thread-local function registry ─────────────────────────────────────────
# Functions can't be serialized by the checkpointer (msgpack), so we store
# them in a module-level dict keyed by thread_id. Nodes look them up at
# runtime instead of reading them from the state.
_thread_fns: dict[str, dict[str, Any]] = {}


def _get_fn(state: "AgentState", name: str):
    """Look up a function registered for the current thread."""
    thread_id = state.context.get("_thread_id", "default")
    fns = _thread_fns.get(thread_id, {})
    return fns.get(name)


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
    # A real multi-step task spends five steps before it can even answer:
    # drive_list, excel_list_sheets, excel_read, mcp_call, reply. At eight, one
    # wrong turn or a retried tool call left nothing for the reply — the chart
    # request on 2026-08-03 used nine and finished with none.
    max_iterations: int = 12

    # Output
    result: dict = Field(default_factory=dict)
    analysis: dict = Field(default_factory=dict)


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
    search_fn = _get_fn(state, "search_fn")
    if not search_fn:
        return state
    try:
        query = state.content[:200].strip()
        if not query:
            return state
        hits = await search_fn(query=query, limit=3)
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

You MUST produce a COMPLETE JSON response with ALL fields including "action". The "action" field is REQUIRED — never omit it. If you need to gather data, set action.type to the appropriate tool (drive_list, excel_read, etc.). On the FIRST iteration, your action should ALWAYS be a data-gathering step (like drive_list), NOT none. NEVER set action.type to "none" unless the task is fully completed and you are ready to finalize. If you still have steps in your plan, pick the NEXT action to execute.

Produce a JSON response (no markdown fences):
{{
  "reasoning": "What I know, what I need, and what I'll do next",
  "plan": "Overall plan for this task (update if needed)",
  "completed": <true if the task is fully done and the final response is ready>,
  "action": {{
    "type": "send_email | reply_email | inbox_list | inbox_read | inbox_search | mcp_call | sharepoint_read | drive_search | drive_read_text | drive_list | drive_upload | drive_share | drive_create_link | my_drive_list | my_drive_read | my_drive_search | my_drive_upload | my_drive_share | my_drive_create_link | excel_list_sheets | excel_read | excel_write | excel_append | calendar_list | calendar_create | request_decision | none",
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

## Tool Guide — when to use each action type

| Action | Use when | Params |
|--------|----------|--------|
| drive_list | Browse files in your SharePoint folder. ALWAYS start here to discover what files exist. | subfolder (optional) |
| drive_search | Search all of SharePoint by name/keyword. Unreliable due to indexing delay — prefer drive_list. | query |
| drive_read_text | Read content of plain text files (.txt, .csv, .md, .json). Do NOT use for .xlsx files. | item_id |
| drive_upload | Upload a file to your SharePoint folder. | filename, content_base64, content_type |
| drive_share | Give named people access to a SharePoint file. Every recipient must be someone the requester named — never invent addresses. | item_id, recipients (list of emails), role ("read" or "write", default read), message (optional) |
| drive_create_link | Create a shareable link to a SharePoint file. Prefer scope="organization"; "anonymous" makes a link anyone in the world can open. | item_id, link_type ("view" or "edit", default view), scope ("organization" or "anonymous", default organization) |
| my_drive_share | Same as drive_share, but for a file in your own OneDrive. | item_id, recipients (list of emails), role, message (optional) |
| my_drive_create_link | Same as drive_create_link, but for your own OneDrive. Defaults to anonymous, so pass scope="organization" unless a public link was actually asked for. | item_id, link_type, scope |
| excel_list_sheets | List worksheet names in an .xlsx file. ALWAYS call this before excel_read — never guess sheet names. | item_id |
| excel_read | Read data from a specific sheet+range in an .xlsx file. Returns a 2D array of values. | item_id, sheet, range (default A1:D50) |
| excel_write | Overwrite a cell range in an .xlsx file. Range must match data dimensions (e.g. A5:D5 for 1 row × 4 cols). | item_id, sheet, range, values |
| excel_append | Append rows after the last used row in an .xlsx sheet. | item_id, sheet, values |
| my_drive_list | List files in your own OneDrive (separate from the shared SharePoint folder). | subfolder (optional) |
| my_drive_read | Read a text file from your OneDrive. | item_id |
| my_drive_search | Search your OneDrive by name/keyword. | query |
| my_drive_upload | Upload a file to your OneDrive. | filename, content_base64, content_type |
| inbox_list | List messages in your mailbox. | limit (default 10), unread_only (default true) |
| inbox_read | Read one message in full. | message_id |
| inbox_search | Search your mailbox. | query, limit (default 10) |
| calendar_list | List upcoming calendar events. | days_ahead (default 7) |
| calendar_create | Create a calendar event. | summary, start, end |
| sharepoint_read | Read a SharePoint file by path. | path |
| mcp_call | Run Python code (pandas, matplotlib, numpy) or parse documents (PDF, DOCX, XLSX) via the sandbox. | server="python-sandbox", tool, arguments |
| reply_email | Reply to the current email thread. Always allowed, including to people outside the organisation. | to, subject, text, thread_id |
| send_email | Start a new email (not a reply). Recipients must be inside the organisation. | to, subject, text |
| request_decision | Ask your manager a question and wait for their answer. Blocks until they reply. | question, context, options (optional), urgency |
| request_decision | Ask the manager a question and BLOCK until they answer. Only for genuine ambiguity. | question, context, options, urgency |

**Workflow for analyzing an .xlsx file:**
1. `drive_list` → find the .xlsx file and get its item_id
2. `excel_list_sheets` → get the actual sheet name (never assume "Sheet1")
3. `excel_read` with the correct sheet name → get the data as a 2D array
4. Do math/analysis in your reasoning OR use `mcp_call` with `execute_python` for complex analysis
5. `reply_email` with the results

## Critical rules

- ALL emails to people outside the org → needs_approval: true
- Manager and internal emails → needs_approval: false
- For MCP calls: use server="python-sandbox" and the tool names from MCP_TOOLS.md
- When the task requires code, write complete Python scripts (not pseudocode)
- IMPORTANT: In pandas, freq="M" is deprecated. Always use freq="ME" (month-end) or freq="MS" (month-start) for date ranges.
- For matplotlib charts, always use plt.savefig("/tmp/output/chart.png", dpi=150, bbox_inches="tight") and plt.close()
- Upload all deliverables to SharePoint — don't just describe them
- When you need data from a teammate, check PRIVATE.md for their email
- NEVER include content from PRIVATE.md in AgentMind insights
- Sign all emails: "{agent_name}\\nData Analyst, {company_name}"
- If you've completed the analysis and delivered results, set completed: true
- Use request_decision when you need the manager's judgment (ambiguous instructions, scope decisions, sensitive data, conflicting data). Do NOT use it for routine tasks you can handle yourself.
- Do NOT use mcp_call/python-sandbox for simple calculations. You can do arithmetic (averages, percentages, growth rates) directly in your reasoning. Only use mcp_call for complex data processing that truly requires code execution.
- The python-sandbox has its own private filesystem that nobody else can see, and it is thrown away when the run ends. Writing a file there does not put it on SharePoint and does not deliver it to anyone. If you were asked to create or update a file, you must finish with drive_upload, excel_write or excel_append — otherwise the work does not exist as far as the person who asked is concerned, and saying you have done it would be false.
- ALWAYS use drive_list FIRST to browse available files before using drive_search. SharePoint search indexing can be delayed, so drive_search may return empty even when files exist. Use drive_list to discover files, then excel_read or drive_read_text to read their contents.
- When asked about data in a spreadsheet, use drive_list to find .xlsx files, then excel_list_sheets to discover worksheet names, then excel_read to read the data. Do NOT assume the sheet is named "Sheet1" — always use excel_list_sheets first. You can do math and analysis on the returned values.
- NEVER return action=none when responding to an email. Always reply_email with a helpful response, even if you cannot find the data. Explain what you searched, what you found (or didn't find), and what you recommend as next steps.
- If you cannot find data on SharePoint after trying BOTH drive_list AND drive_search, say so in your reply and ask the manager where to find it.
- request_decision BLOCKS until the manager responds — only use it when you genuinely need their input
- When the user explicitly asks you to perform an action (write, upload, append, delete), DO IT DIRECTLY. Do not email the user back to ask for the file, do not use request_decision to clarify, and do not take detours. Execute the requested action using the tools available to you. If the action is blocked, the approval system will handle it automatically.
- "type" MUST be one of the action types listed above, exactly as spelled. Never invent one, and never wrap a real action inside another. There is no approval wrapper action: to share a file you emit drive_share itself, with its own params. Asking for permission is not something you do — emit the action you want, and if it needs a human the platform pauses it, asks them, and resumes you automatically. An invented type does nothing at all, so the person waiting on you gets silence.
- If an action fails (e.g., email bounce, API error), do NOT spiral into retries or request_decision loops. Report the error in your reply and move on.
- You can only START a conversation with, or share a file with, people inside this organisation: the company domain, your manager, or addresses on the buyer's allowlist. If you are asked to email or share with someone outside it, do not attempt the action and do not look for a way around it. Reply to the person who asked, tell them plainly that you cannot reach that address and why, and suggest they send it themselves. Replying to anyone who emails you first is always allowed.
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
        use_fn = _get_fn(state, "use_fn")
        if used_ids and use_fn:
            try:
                await use_fn(used_ids)
            except Exception as e:
                print(f"[agentmind] Report usage failed (non-fatal): {e}", flush=True)

    message_content = state.enriched_content or state.content

    # The wrap-up pass. Reached only when the step budget ran out mid-task, so the
    # one thing still needed is the reply itself — said plainly, because a model
    # that has been told for several turns to pick the next action will otherwise
    # pick another one.
    if state.context.get("_wrapping_up"):
        message_content += (
            "\n\n[SYSTEM] You have no steps left. Do NOT choose another action — "
            "set \"completed\": true and \"action\": {\"type\": \"none\"}, and write "
            "final_response now.\n"
            "Answer from the results you already have. Say what you found, and if "
            "some part of the request is unfinished say which part and why, so the "
            "person knows where things stand. Do not claim to have done anything "
            "that is not in the results above. A partial answer is useful; silence "
            "is not."
        )

    # Format actions taken so far
    actions_str = "None yet" if not state.actions_taken else "\n".join(
        f"- Step {i+1}: {a}" for i, a in enumerate(state.actions_taken)
    )
    results_str = "None yet" if not state.action_results else "\n".join(
        f"- Result {i+1}: {_fmt_result(r)}" for i, r in enumerate(state.action_results)
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
    print(f"[agent] LLM response (first 500 chars): {text[:500]}", flush=True)

    try:
        cleaned = text.strip()
        if cleaned.startswith("```"):
            cleaned = cleaned.split("\n", 1)[1].rsplit("```", 1)[0]
        parsed = json.loads(cleaned)
        state.analysis = parsed if isinstance(parsed, dict) else None
    except (json.JSONDecodeError, ValueError):
        state.analysis = None

    if not isinstance(state.analysis, dict):
        import re
        match = re.search(r"\{.*\}", text, re.DOTALL)
        if match:
            try:
                parsed = json.loads(match.group())
                if isinstance(parsed, dict):
                    state.analysis = parsed
            except Exception:
                pass
        if not isinstance(state.analysis, dict):
            state.analysis = {"completed": True, "action": {"type": "none"},
                              "final_response": {"action": "none"}, "reasoning": text}

    state.plan = state.analysis.get("plan", state.plan)

    # Debug: log the parsed action
    action = state.analysis.get("action") if isinstance(state.analysis, dict) else None
    print(f"[agent] Parsed action: {json.dumps(action, default=str)[:200] if action else 'None/missing'}", flush=True)

    return state


def route_after_reasoning(state: AgentState) -> str:
    """Route based on the reasoning output."""
    if not isinstance(state.analysis, dict):
        return "finalize"
    if state.analysis.get("completed", False):
        return "finalize"
    if state.iteration >= state.max_iterations:
        # Out of steps, but not out of things to say. Going straight to finalize
        # hands it whatever final_response exists, and mid-task there is none — so
        # the result was action=none with empty text and the person who asked got
        # "I wasn't sure how to respond" after the agent had read their data and
        # built their chart. One more pass, for the reply only.
        if state.actions_taken and not state.context.get("_wrapping_up"):
            state.context["_wrapping_up"] = True
            print(
                f"[agent] Out of iterations after {len(state.actions_taken)} action(s) "
                f"— one final pass to write the reply",
                flush=True,
            )
            return "reason_and_act"
        return "finalize"
    action = state.analysis.get("action") or {}
    if isinstance(action, dict) and action.get("type", "none") != "none":
        return "execute_action"
    # Force drive_list on first iteration if LLM said none but hasn't taken any actions
    if state.iteration == 0 and not state.actions_taken:
        print("[agent] Forcing drive_list on first iteration (LLM returned none with no prior actions)", flush=True)
        state.analysis["action"] = {"type": "drive_list", "params": {}}
        return "execute_action"
    # If the LLM returned none but the task isn't complete and we have room to iterate,
    # loop back to reasoning — the LLM likely just failed to emit the action type properly.
    if not state.analysis.get("completed", False) and state.iteration < state.max_iterations - 1 and state.actions_taken:
        print(f"[agent] LLM returned action=none but task not complete (iter={state.iteration}) — re-reasoning", flush=True)
        state.iteration += 1  # count this as an iteration to prevent infinite loops
        return "reason_and_act"
    return "finalize"


async def execute_action(state: AgentState) -> AgentState:
    """Execute the action decided by the reasoning node."""
    action = state.analysis.get("action") or {}
    action_type = action.get("type", "none") if isinstance(action, dict) else "none"
    params = action.get("params") or {} if isinstance(action, dict) else {}

    state.iteration += 1
    result_text = ""

    try:
        # ── Interrupt for blocked actions (requires manager approval) ────────
        if action_type in BLOCKED_ACTIONS:
            print(f"[agent] BLOCKED action '{action_type}' — interrupting for approval", flush=True)
            resolution = interrupt({
                "action": action_type,
                "params": params,
                "reasoning": state.plan or state.analysis.get("reasoning", ""),
                "risk_assessment": state.analysis.get("risk_assessment", {}),
            })
            # Graph resumes here after Command(resume=resolution_dict)
            res_status = resolution.get("status", "REJECTED") if isinstance(resolution, dict) else "REJECTED"
            if res_status not in ("APPROVED", "EDITED"):
                rejection = resolution.get("rejectionReason", "Rejected by manager") if isinstance(resolution, dict) else "Rejected"
                result_text = f"Action '{action_type}' was rejected by the manager: {rejection}"
                state.actions_taken.append(f"{action_type} REJECTED")
                state.action_results.append(result_text)
                return state
            # Manager approved — if edited, update params
            if res_status == "EDITED" and isinstance(resolution, dict) and resolution.get("resolutionAction"):
                print(f"[agent] Manager edited action — applying edits", flush=True)
                params = {**params, "text": resolution["resolutionAction"]}
            print(f"[agent] Action '{action_type}' APPROVED — executing", flush=True)
            # Flag that this was a resumed blocked action — after execution,
            # the task should finalize (compose reply) rather than re-reasoning.
            state.context["_approved_action_executing"] = True

        # ── Interrupt for request_decision (ask manager a question) ──────────
        if action_type == "request_decision":
            print(f"[agent] request_decision — interrupting for manager input", flush=True)
            resolution = interrupt({
                "action": "request_decision",
                "question": params.get("question", ""),
                "context": params.get("context", ""),
                "options": params.get("options"),
                "urgency": params.get("urgency", "normal"),
            })
            # Graph resumes here with the manager's answer
            res_status = resolution.get("status", "EXPIRED") if isinstance(resolution, dict) else "EXPIRED"
            if res_status in ("APPROVED", "EDITED"):
                answer = resolution.get("resolutionAction") or resolution.get("answer") or "Approved — proceed as planned."
                result_text = f"Manager decision: APPROVED — {answer}"
            elif res_status == "REJECTED":
                result_text = f"Manager decision: REJECTED — {resolution.get('rejectionReason', 'Request declined.')}"
            else:
                result_text = "Manager decision: EXPIRED — No response received."
            state.actions_taken.append(f"Decision request: {params.get('question', '')[:60]}")
            state.action_results.append(result_text)
            return state

        # ── Normal action execution ──────────────────────────────────────────
        mcp_fn = _get_fn(state, "mcp_fn")
        if action_type == "mcp_call" and mcp_fn:
            # LLM sometimes puts server/tool/arguments at action level instead of inside params
            server = params.get("server") or action.get("server", "python-sandbox")
            tool = params.get("tool") or action.get("tool", "")
            arguments = params.get("arguments") or action.get("arguments", {})
            print(f"[agent] MCP call: server={server}, tool={tool}, args_keys={list(arguments.keys())}", flush=True)
            result = await mcp_fn(server, tool, arguments)
            result_text = json.dumps(result, default=str)[:2000]
            print(f"[agent] MCP result (first 300): {result_text[:300]}", flush=True)
            state.actions_taken.append(f"MCP {server}/{tool}")

        elif action_type == "mcp_call" and not mcp_fn:
            result_text = "ERROR: MCP/python-sandbox is not available. Do the calculations in your reasoning instead and proceed to reply_email."
            state.actions_taken.append("MCP unavailable")

        elif action_type in ("sharepoint_read", "drive_list") and _mt:
            files = await _mt.drive_list(params.get("subfolder", ""))
            # total_files is stated separately and first, so a question like "how
            # many files are there" is answered from a number rather than from
            # however much of the list survives formatting. The agent previously
            # reported six for a folder of ten, having counted the entries it could
            # see in a truncated payload.
            result_text = json.dumps(
                {
                    "total_files": len(files),
                    "showing": min(len(files), 20),
                    "files": [
                        {"name": f.get("name"), "id": f.get("id"), "size": f.get("size")}
                        for f in files[:20]
                    ],
                },
                default=str,
            )
            state.actions_taken.append(f"SharePoint list: {params.get('subfolder', 'root')}")

        elif action_type == "drive_search" and _mt:
            query = params.get("query", params.get("q", ""))
            results = await _mt.drive_search(query)
            result_text = json.dumps([{"name": f.get("name"), "id": f.get("id"), "webUrl": f.get("webUrl")} for f in results[:10]], default=str)
            state.actions_taken.append(f"SharePoint search: {query[:50]}")

        elif action_type == "drive_read_text" and _mt:
            item_id = params.get("item_id", params.get("id", ""))
            content = await _mt.drive_read_text(item_id)
            result_text = content[:2000] if content else "(empty file)"
            state.actions_taken.append(f"Read file: {item_id[:20]}")

        elif action_type == "drive_upload" and _mt:
            b64 = params.get("content_base64", ""); b64 += "=" * (-len(b64) % 4); content = base64.b64decode(b64)
            filename = params.get("filename", "output.xlsx")
            resp = await _mt.drive_upload(filename, content)
            result_text = f"Uploaded {filename} to SharePoint: {resp.get('webUrl', '')}"
            state.actions_taken.append(f"Upload: {filename}")

        elif action_type == "excel_list_sheets" and _mt:
            sheets = await _mt.excel_list_sheets(params["item_id"])
            result_text = json.dumps(sheets)
            state.actions_taken.append(f"Listed sheets: {sheets}")

        elif action_type == "excel_read" and _mt:
            data = await _mt.excel_read(params["item_id"], params.get("sheet", "Sheet1"), params.get("range", "A1:Z100"))
            result_text = json.dumps(data[:50], default=str)  # cap at 50 rows
            state.actions_taken.append(f"Excel read: {params.get('sheet', 'Sheet1')}")

        elif action_type == "excel_write" and _mt:
            await _mt.excel_write(params["item_id"], params.get("sheet", "Sheet1"), params["range"], params["values"])
            # Read back the written data and get file URL for confirmation
            readback_str = json.dumps(params["values"], default=str)
            file_url = ""
            try:
                readback = await _mt.excel_read(params["item_id"], params.get("sheet", "Sheet1"), params["range"])
                readback_str = json.dumps(readback, default=str)
            except Exception:
                pass
            try:
                file_meta = await _mt.drive_get_file(params["item_id"])
                file_url = file_meta.get("webUrl", "")
            except Exception:
                pass
            result_text = f"SUCCESS: Wrote to sheet '{params.get('sheet', 'Sheet1')}' range {params['range']}. Written data: {readback_str}"
            if file_url:
                result_text += f"\nDocument: {file_url}"
            state.actions_taken.append(f"Excel write: {params['range']} ✓")

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

        elif action_type == "sharepoint_delete" and _mt:
            await _mt.drive_delete(params["item_id"])
            result_text = f"Deleted item {params['item_id'][:20]} from SharePoint"
            state.actions_taken.append(f"SharePoint delete: {params['item_id'][:20]}")

        elif action_type == "calendar_list" and _mt:
            events = await _mt.calendar_list(params.get("days_ahead", 7))
            result_text = json.dumps([{"id": e.get("id"), "subject": e.get("subject"), "start": e.get("start", {}).get("dateTime"), "end": e.get("end", {}).get("dateTime")} for e in events[:20]], default=str)
            state.actions_taken.append(f"Calendar list: {len(events)} events")

        elif action_type == "calendar_delete" and _mt:
            await _mt.calendar_delete(params["event_id"])
            result_text = f"Deleted calendar event {params['event_id'][:20]}"
            state.actions_taken.append("Calendar delete")

        elif action_type.startswith("my_drive_") and _WORKSPACE_SCOPE == "buyer_org":
            result_text = "OneDrive is not available in buyer-org mode. Use SharePoint (drive_list, drive_upload, etc.) for file storage instead."
            state.actions_taken.append(f"OneDrive unavailable: {action_type}")

        elif action_type == "my_drive_list" and _mt:
            files = await _mt.my_drive_list(params.get("subfolder", ""))
            result_text = json.dumps([{"name": f.get("name"), "id": f.get("id"), "size": f.get("size")} for f in files[:20]], default=str)
            state.actions_taken.append(f"OneDrive list: {params.get('subfolder', 'root')}")

        elif action_type == "my_drive_upload" and _mt:
            content = base64.b64decode(params.get("content_base64", params.get("content", "")))
            filename = params.get("filename", "file.txt")
            folder = params.get("folder", "")
            resp = await _mt.my_drive_upload(filename, content, folder)
            result_text = f"Uploaded {filename} to OneDrive: {resp.get('webUrl', '')}"
            state.actions_taken.append(f"OneDrive upload: {filename}")

        elif action_type == "my_drive_read" and _mt:
            item_id = params.get("item_id", params.get("id", ""))
            content = await _mt.my_drive_read_text(item_id)
            result_text = content[:2000] if content else "(empty file)"
            state.actions_taken.append(f"OneDrive read: {item_id[:20]}")

        elif action_type == "my_drive_search" and _mt:
            query = params.get("query", "")
            results = await _mt.my_drive_search(query)
            result_text = json.dumps([{"name": f.get("name"), "id": f.get("id"), "webUrl": f.get("webUrl")} for f in results[:10]], default=str)
            state.actions_taken.append(f"OneDrive search: {query[:50]}")

        elif action_type == "my_drive_ensure_folder" and _mt:
            folder_name = params.get("folder_name", params.get("name", ""))
            resp = await _mt.my_drive_ensure_folder(folder_name)
            result_text = f"Folder '{folder_name}' ready: {resp.get('webUrl', '')}"
            state.actions_taken.append(f"OneDrive folder: {folder_name}")

        elif action_type == "my_drive_delete" and _mt:
            await _mt.my_drive_delete(params["item_id"])
            result_text = f"Deleted item {params['item_id'][:20]} from OneDrive"
            state.actions_taken.append(f"OneDrive delete: {params['item_id'][:20]}")

        elif action_type == "drive_share" and _mt:
            resp = await _mt.drive_share(params["item_id"], params["recipients"], params.get("role", "read"), params.get("message", ""))
            result_text = json.dumps(resp, default=str)
            state.actions_taken.append(f"SharePoint share: {params['item_id'][:20]} → {params['recipients']}")

        elif action_type == "drive_create_link" and _mt:
            resp = await _mt.drive_create_link(params["item_id"], params.get("link_type", "view"), params.get("scope", "organization"))
            result_text = json.dumps(resp, default=str)
            state.actions_taken.append(f"SharePoint link: {resp.get('link', '')[:50]}")

        elif action_type == "my_drive_share" and _mt:
            resp = await _mt.my_drive_share(params["item_id"], params["recipients"], params.get("role", "read"), params.get("message", ""))
            result_text = json.dumps(resp, default=str)
            state.actions_taken.append(f"OneDrive share: {params['item_id'][:20]} → {params['recipients']}")

        elif action_type == "my_drive_create_link" and _mt:
            resp = await _mt.my_drive_create_link(params["item_id"], params.get("link_type", "view"), params.get("scope", "anonymous"))
            result_text = json.dumps(resp, default=str)
            state.actions_taken.append(f"OneDrive link: {resp.get('link', '')[:50]}")

        # ── Outlook email tools (Graph API, mid-loop) ──
        elif action_type == "inbox_list" and _mt and _mt.EMAIL_AVAILABLE:
            msgs = await _mt.inbox_list(
                limit=params.get("limit", 10),
                unread_only=params.get("unread_only", True),
            )
            result_text = json.dumps(msgs, default=str)
            state.actions_taken.append(f"inbox_list: {len(msgs)} messages")

        elif action_type == "inbox_read" and _mt and _mt.EMAIL_AVAILABLE:
            msg = await _mt.inbox_read(params["message_id"])
            result_text = json.dumps(msg, default=str)
            state.actions_taken.append(f"inbox_read: {params['message_id'][:20]}")

        elif action_type == "inbox_search" and _mt and _mt.EMAIL_AVAILABLE:
            msgs = await _mt.inbox_search(
                query=params["query"],
                limit=params.get("limit", 10),
            )
            result_text = json.dumps(msgs, default=str)
            state.actions_taken.append(f"inbox_search '{params['query'][:30]}': {len(msgs)} results")

        elif action_type == "email_send" and _mt and _mt.EMAIL_AVAILABLE:
            r = await _mt.email_send(
                to=params["to"],
                subject=params["subject"],
                body=params["body"],
                cc=params.get("cc"),
                body_type=params.get("body_type", "html"),
            )
            result_text = json.dumps(r, default=str)
            state.actions_taken.append(f"email_send to {params['to']}")

        elif action_type == "email_reply" and _mt and _mt.EMAIL_AVAILABLE:
            r = await _mt.email_reply(
                message_id=params["message_id"],
                body=params["body"],
                body_type=params.get("body_type", "html"),
            )
            result_text = json.dumps(r, default=str)
            state.actions_taken.append(f"email_reply to {params['message_id'][:20]}")

        elif action_type == "email_forward" and _mt and _mt.EMAIL_AVAILABLE:
            r = await _mt.email_forward(
                message_id=params["message_id"],
                to=params["to"],
                comment=params.get("comment", ""),
            )
            result_text = json.dumps(r, default=str)
            state.actions_taken.append(f"email_forward {params['message_id'][:20]} to {params['to']}")

        elif action_type in ("send_email", "reply_email"):
            # Emails are handled by the adapter, not here.
            # If the LLM wants to send an email mid-loop (e.g., to ask a teammate),
            # we note it but the actual send happens in finalize.
            result_text = "Email action noted — will be sent after this iteration"
            state.actions_taken.append(f"Email to: {params.get('to', 'unknown')}")

        else:
            result_text = f"Unknown action type: {action_type}"
            state.actions_taken.append(f"Unknown: {action_type}")

    except GraphInterrupt:
        raise  # Let interrupt propagate — suspends the graph for approval
    except Exception as e:
        result_text = f"Error: {str(e)}"
        state.actions_taken.append(f"Error in {action_type}: {str(e)[:100]}")

    state.action_results.append(result_text)
    return state


def route_after_execution(state: AgentState) -> str:
    """After executing an action, decide whether to continue reasoning or finalize."""
    # If a blocked action was just approved and executed, go straight to finalize
    # to compose the reply — don't re-reason (which causes repeated writes).
    if state.context.get("_approved_action_executing"):
        state.context.pop("_approved_action_executing", None)
        print(f"[agent] Approved action executed — going to finalize", flush=True)
        return "finalize"
    return "reason_and_act"


async def finalize(state: AgentState) -> AgentState:
    """Build the final result dict that the adapter will act on."""
    analysis = state.analysis if isinstance(state.analysis, dict) else {}
    final = analysis.get("final_response") or {}
    if not isinstance(final, dict):
        final = {}

    # If the LLM decided to send an email as part of the action loop
    # (e.g., asking a teammate for data), handle that here too
    action = analysis.get("action") or {}
    if not isinstance(action, dict):
        action = {}
    if action.get("type") in ("send_email", "reply_email") and not analysis.get("completed"):
        params = action.get("params") or {}
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
    result_action = final.get("action", "none")
    result_text = final.get("text", "")

    # Last line of defence against silence. If the agent did real work and still
    # produced no reply — the wrap-up pass above should prevent it, but a model can
    # always ignore an instruction — say so rather than returning nothing. Someone
    # is waiting on an answer, and "I got partway" beats no answer at all.
    if not result_text.strip() and state.actions_taken:
        steps = "\n".join(f"- {a}" for a in state.actions_taken[-6:])
        result_text = (
            "I worked on this but ran out of steps before I could finish, so I do "
            "not have a complete answer yet.\n\nWhat I did get through:\n"
            f"{steps}\n\nAsk me again and I'll pick it up from here — narrowing the "
            "request to one part will usually get it done in a single go."
        )
        result_action = "reply_email"
        print("[agent] No final text after real work — sending a partial-progress reply", flush=True)

    state.result = {
        "action": result_action,
        "to": final.get("to"),
        "subject": final.get("subject"),
        "text": result_text,
        "thread_id": final.get("thread_id"),
        "task_type": "data-analysis",
        "risk_assessment": analysis.get("risk_assessment", {}),
        "action_results": state.action_results,
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
    contribute_fn = _get_fn(state, "contribute_fn")
    if not contribute_fn:
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

    # What this lesson was actually learned from.
    #
    # This used to send the literal string "data-analysis" — the task type, which
    # every contribution shares and which tells a reviewer nothing. Whether a
    # lesson is durable depends entirely on what produced it: "the platform
    # refuses external shares" is permanent, while "Excel returns 501" was one
    # corrupt file that has since been replaced. Both read identically without
    # their origin, and the second sat approved for a day teaching the agent to
    # avoid spreadsheets.
    request_snippet = (state.content or "").strip().replace("\n", " ")[:200]
    last_result = ""
    if state.action_results:
        last_result = str(state.action_results[-1]).strip().replace("\n", " ")[:300]
    provenance = f"Request: {request_snippet or '(none)'}"
    if last_result:
        provenance += f"\nTriggered by: {last_result}"

    try:
        await contribute_fn(
            contribution_type=insight["type"],
            title=insight["title"],
            content=insight["content"],
            tags=insight.get("tags", ["data-analysis"]),
            context=provenance,
        )
        print(f"[agentmind] Contributed: {insight['title']}", flush=True)
    except Exception as e:
        print(f"[agentmind] Contribution failed (non-fatal): {e}", flush=True)

    return state


# ─── Graph ───────────────────────────────────────────────────────────────────

# Where the graph's suspended state lives between an interrupt and the manager's
# answer. /data is a Docker volume that outlives the container, so an approval
# raised before a restart is still resumable after one; MemorySaver kept it in
# process memory, where every restart silently discarded whatever the agent had
# been part-way through and the resolution had nothing left to resume.
CHECKPOINT_DB = os.environ.get(
    "CHECKPOINT_DB",
    f"/data/{os.environ.get('DEPLOYMENT_ID', 'agent')}/checkpoints.sqlite",
)

_compiled_graph = None
_checkpointer_cm = None
_graph_init_lock = asyncio.Lock()


async def _open_checkpointer():
    """Open the persistent checkpointer, falling back to in-memory.

    A failure here must not take the agent down with it. If sqlite cannot be
    opened — missing package, unwritable volume — the agent keeps working exactly
    as it did before, losing only the ability to resume across a restart.
    """
    global _checkpointer_cm
    try:
        from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

        Path(CHECKPOINT_DB).parent.mkdir(parents=True, exist_ok=True)
        # from_conn_string is an async context manager, and the graph outlives any
        # single request, so the context is entered once and deliberately left open
        # for the process lifetime rather than wrapped around a call.
        _checkpointer_cm = AsyncSqliteSaver.from_conn_string(CHECKPOINT_DB)
        saver = await _checkpointer_cm.__aenter__()
        print(f"[agent] Checkpointing to {CHECKPOINT_DB}", flush=True)
        return saver
    except Exception as e:
        print(
            f"[agent] Persistent checkpointer unavailable ({e}) — falling back to "
            f"MemorySaver. Approvals will not survive a restart.",
            flush=True,
        )
        return MemorySaver()


async def get_graph():
    """The compiled graph, built on first use.

    Lazy because the persistent checkpointer has to be opened from async code,
    and the graph is only ever reached from async entry points anyway.
    """
    global _compiled_graph
    if _compiled_graph is not None:
        return _compiled_graph
    async with _graph_init_lock:
        # Re-check: another coroutine may have built it while we waited.
        if _compiled_graph is None:
            _compiled_graph = build_graph().compile(checkpointer=await _open_checkpointer())
    return _compiled_graph


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
    # After executing an action, either finalize (if it was an approved blocked action)
    # or loop back to reasoning for the next step.
    graph.add_conditional_edges("execute_action", route_after_execution)
    graph.add_edge("finalize", "maybe_contribute")
    graph.add_edge("maybe_contribute", END)

    return graph


# ─── Public API ──────────────────────────────────────────────────────────────

# ─── Tool result formatting ──────────────────────────────────────────────────

# How much of a tool result the model is shown. Results accumulate across
# iterations, so this is a real budget rather than an arbitrary number: a handful
# of steps at this size stays well within the context window.
RESULT_CHAR_LIMIT = 4000


def _fmt_result(result: str) -> str:
    """Render a tool result for the prompt, saying so when it has been cut.

    The cut used to be a bare r[:500] with nothing to mark it. Data arrived
    chopped mid-token and the model had no way to know, so it answered from the
    fragment as though it were the whole: asked how many files were in a folder
    of ten, it read a payload truncated after six and replied "there are 6
    files", with no hedge. Wrong, confident, and invisible.

    Truncating is still necessary. Being silent about it is not.
    """
    text = result if isinstance(result, str) else str(result)
    if len(text) <= RESULT_CHAR_LIMIT:
        return text
    shown = text[:RESULT_CHAR_LIMIT]
    notice = (
        f"[TRUNCATED — you are seeing the first {RESULT_CHAR_LIMIT} of {len(text)} "
        f"characters. This data is INCOMPLETE. Do not state totals, counts or "
        f"conclusions drawn from it as if they were complete; either narrow the "
        f"request (a specific file, sheet or range) or tell the user the result "
        f"was too large to read in full.]"
    )
    return shown + "\n" + notice


async def run_agent(
    content: str,
    context: dict,
    contribute_fn=None,
    search_fn=None,
    use_fn=None,
    mcp_fn=None,
    graph_fn=None,
    thread_id: str = "",
) -> dict:
    """Entry point called by the platform adapter for every incoming message.

    Args:
        content: The message text to process.
        context: Dict with agent_name, agent_email, company_name, hook_name, etc.
        contribute_fn: Async fn to submit a learning to AgentMind.
        search_fn: Async fn to search AgentMind for relevant knowledge.
        use_fn: Async fn to report which contributions were used.
        mcp_fn: Async fn to call MCP sidecar tools.
        graph_fn: Async fn provided by the platform for all Microsoft Graph calls.
            This agent has no Graph credential of its own — the platform holds it
            and applies the buyer's approval policy before anything is written or
            shared. Absent it, the Microsoft tools raise rather than falling back
            to direct access.
        thread_id: Unique thread ID for checkpointing (enables interrupt/resume).

    Returns:
        Dict with at minimum an "action" key, or {"status": "__interrupted__", ...}
        if the graph was interrupted waiting for approval.
    """
    tid = thread_id or "default"

    # Hand the platform's Graph transport to the tool module. Done per call rather
    # than at import because the adapter owns the credential and decides when to
    # provide it.
    if graph_fn is not None and _mt is not None:
        _mt.set_graph_fn(graph_fn)

    # Store functions in module-level registry (not in state — can't be serialized)
    _thread_fns[tid] = {
        "contribute_fn": contribute_fn,
        "search_fn": search_fn,
        "use_fn": use_fn,
        "mcp_fn": mcp_fn,
    }

    initial_state = AgentState(
        content=content,
        context={**context, "_thread_id": tid},
    )

    config = {"configurable": {"thread_id": tid}}

    graph = await get_graph()
    final_state = await graph.ainvoke(initial_state, config=config)

    # Check for interrupt — graph was suspended waiting for approval
    graph_state = await graph.aget_state(config)
    if graph_state.next:  # Non-empty next tuple means graph is interrupted
        # Extract interrupt payloads
        interrupts = []
        if hasattr(graph_state, "tasks"):
            for task in graph_state.tasks:
                if hasattr(task, "interrupts"):
                    for intr in task.interrupts:
                        interrupts.append(intr.value if hasattr(intr, "value") else intr)
        print(f"[agent] Graph interrupted at {graph_state.next}, interrupts={interrupts}", flush=True)
        return {
            "status": "__interrupted__",
            "interrupts": interrupts,
            "thread_id": thread_id,
        }

    if isinstance(final_state, dict):
        if "result" in final_state and isinstance(final_state["result"], dict):
            print(f"[agent] run_agent returning (dict.result): action={final_state['result'].get('action')}", flush=True)
            return final_state["result"]
        for v in final_state.values():
            if isinstance(v, AgentState):
                print(f"[agent] run_agent returning (AgentState in dict): action={v.result.get('action')}", flush=True)
                return v.result
        print(f"[agent] run_agent returning raw dict: {list(final_state.keys())}", flush=True)
        return final_state
    if isinstance(final_state, AgentState):
        print(f"[agent] run_agent returning (AgentState): action={final_state.result.get('action')}", flush=True)
        return final_state.result
    print(f"[agent] run_agent returning fallback none", flush=True)
    return {"action": "none"}


async def resume_agent(
    thread_id: str,
    resolution: dict,
    contribute_fn=None,
    search_fn=None,
    use_fn=None,
    mcp_fn=None,
    graph_fn=None,
) -> dict:
    """Resume a previously interrupted graph with the manager's resolution.

    The tool functions have to be supplied again. They cannot be checkpointed —
    msgpack will not serialise a function — so run_agent keeps them in a
    module-level registry, and that registry is empty in a process that has
    restarted since the interrupt. The graph itself resumes correctly from its
    checkpoint and then finds it has no way to reach Microsoft, which surfaced as
    an approved upload reporting "the platform did not provide a Graph transport"
    while creating no file.

    Args:
        thread_id: The thread_id used in the original run_agent call.
        resolution: Dict with status, resolutionAction, rejectionReason, etc.

    Returns:
        The final result dict from the completed graph run.
    """
    config = {"configurable": {"thread_id": thread_id}}

    # Re-arm the tool transport and registry before resuming. Harmless when the
    # process never restarted — it rewrites the same values run_agent set.
    if graph_fn is not None and _mt is not None:
        _mt.set_graph_fn(graph_fn)
    if any(f is not None for f in (contribute_fn, search_fn, use_fn, mcp_fn)):
        _thread_fns[thread_id] = {
            "contribute_fn": contribute_fn,
            "search_fn": search_fn,
            "use_fn": use_fn,
            "mcp_fn": mcp_fn,
        }

    # Check that the graph is actually interrupted for this thread
    graph = await get_graph()
    graph_state = await graph.aget_state(config)
    if not graph_state.next:
        print(f"[agent] resume_agent: no interrupted state for thread={thread_id}", flush=True)
        return {"status": "error", "error": "No interrupted graph state found for this thread"}

    print(f"[agent] Resuming graph for thread={thread_id} with resolution status={resolution.get('status')}", flush=True)

    # Resume the graph — Command(resume=value) passes the value back to interrupt()
    final_state = await graph.ainvoke(
        Command(resume=resolution),
        config=config,
    )

    # Check if graph hit ANOTHER interrupt (e.g., multiple blocked actions)
    graph_state = await graph.aget_state(config)
    if graph_state.next:
        interrupts = []
        if hasattr(graph_state, "tasks"):
            for task in graph_state.tasks:
                if hasattr(task, "interrupts"):
                    for intr in task.interrupts:
                        interrupts.append(intr.value if hasattr(intr, "value") else intr)
        print(f"[agent] Graph interrupted AGAIN at {graph_state.next}", flush=True)
        return {
            "status": "__interrupted__",
            "interrupts": interrupts,
            "thread_id": thread_id,
        }

    if isinstance(final_state, dict):
        if "result" in final_state and isinstance(final_state["result"], dict):
            print(f"[agent] resume_agent returning: action={final_state['result'].get('action')}", flush=True)
            return final_state["result"]
        for v in final_state.values():
            if isinstance(v, AgentState):
                return v.result
        return final_state
    if isinstance(final_state, AgentState):
        return final_state.result
    return {"action": "none"}
