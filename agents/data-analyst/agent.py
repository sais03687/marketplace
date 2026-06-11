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
    max_iterations: int = 8

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

**Current date/time: {current_datetime}**
**Company timezone: {company_timezone}** — use this timezone for all calendar events and date/time references unless the user specifies otherwise.

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

You MUST produce a COMPLETE JSON response with ALL fields including "action". The "action" field is REQUIRED — never omit it. If you need to gather data, set action.type to the appropriate tool (drive_list, excel_read, etc.). On the FIRST iteration, your action should ALWAYS be a data-gathering step (like drive_list), NOT none.

Produce a JSON response (no markdown fences):
{{
  "reasoning": "What I know, what I need, and what I'll do next",
  "plan": "Overall plan for this task (update if needed)",
  "completed": <true if the task is fully done and the final response is ready>,
  "action": {{
    "type": "send_email | reply_email | mcp_call | sharepoint_read | sharepoint_delete | drive_search | drive_read_text | drive_list | drive_upload | drive_share | drive_create_link | excel_list_sheets | excel_read | excel_write | excel_append | calendar_create | calendar_list | calendar_delete | my_drive_list | my_drive_upload | my_drive_read | my_drive_search | my_drive_delete | my_drive_ensure_folder | my_drive_share | my_drive_create_link | inbox_list | inbox_read | inbox_search | email_send | email_reply | email_forward | request_decision | none",
    "params": {{
      // For send_email/reply_email (adapter-level, used for final responses):
      "to": "recipient email",
      "subject": "subject line",
      "text": "email body",
      "thread_id": "thread id or null",
      // For inbox_list/inbox_read/inbox_search/email_send/email_reply/email_forward (Graph-level, mid-loop):
      "message_id": "Graph message ID for inbox_read/email_reply/email_forward",
      "limit": 10,
      "unread_only": true,
      "query": "search query for inbox_search",
      "body": "email body for email_send/email_reply",
      "body_type": "html or text",
      "cc": ["optional cc addresses"],
      "comment": "optional forward comment",
      // For mcp_call:
      "server": "python-sandbox",
      "tool": "execute_python | parse_pdf | parse_docx | parse_xlsx",
      "arguments": {{}},
      // For SharePoint drive operations (org-wide shared files):
      "item_id": "file id",
      "filename": "for uploads",
      "content_base64": "for uploads",
      "subfolder": "optional subfolder path",
      // For my_drive (agent's personal OneDrive — platform mode only):
      "folder": "optional folder name",
      "folder_name": "for my_drive_ensure_folder",
      "query": "search query for my_drive_search or drive_search",
      // For sharing (drive_share, my_drive_share, drive_create_link, my_drive_create_link):
      "recipients": ["email1@example.com", "email2@example.com"],
      "role": "read or write",
      "message": "optional sharing message",
      "link_type": "view or edit",
      "scope": "anonymous or organization",
      // For excel operations:
      "item_id": "file id",
      "sheet": "sheet name",
      "range": "A1:Z100",
      "values": [["row1col1", "row1col2"]],
      // For calendar operations:
      "summary": "event title",
      "start": "ISO datetime",
      "end": "ISO datetime",
      "attendees": ["email1", "email2"],
      "event_id": "for calendar_delete",
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

### SharePoint (org-wide shared files — visible to everyone in the org)
| Action | Use when | Params |
|--------|----------|--------|
| drive_list | Browse files in your SharePoint folder. ALWAYS start here to discover what files exist. | subfolder (optional) |
| drive_search | Search all of SharePoint by name/keyword. Unreliable due to indexing delay — prefer drive_list. | query |
| drive_read_text | Read content of plain text files (.txt, .csv, .md, .json). Do NOT use for .xlsx files. | item_id |
| drive_upload | Upload a file to your SharePoint folder. | filename, content_base64, content_type |
| sharepoint_delete | Delete a file or folder from SharePoint. | item_id |

### Agent OneDrive (your personal file storage — only you can see these)
| Action | Use when | Params |
|--------|----------|--------|
| my_drive_list | Browse files in your personal OneDrive. | subfolder (optional) |
| my_drive_upload | Upload a file to your personal OneDrive. | filename, content (base64), folder (optional), content_type |
| my_drive_read | Read text content of a file from your OneDrive. | item_id |
| my_drive_search | Search your OneDrive by name/keyword. | query |
| my_drive_ensure_folder | Create a folder in your OneDrive. | folder_name |
| my_drive_delete | Delete a file or folder from your OneDrive. | item_id |
| my_drive_share | Share an OneDrive file with specific people. | item_id, recipients (email list), role (read/write), message |
| my_drive_create_link | Create a sharing link for an OneDrive file. | item_id, link_type (view/edit), scope (anonymous/organization) |
| drive_share | Share a SharePoint file with specific people. | item_id, recipients (email list), role (read/write), message |
| drive_create_link | Create a sharing link for a SharePoint file. | item_id, link_type (view/edit), scope (organization/anonymous) |

Use **SharePoint** for deliverables and shared reports (things the team should see).
Use **your OneDrive** for working drafts, temp files, and personal notes.

### Excel (works on .xlsx files in both SharePoint and OneDrive)
| Action | Use when | Params |
|--------|----------|--------|
| excel_list_sheets | List worksheet names in an .xlsx file. ALWAYS call this before excel_read — never guess sheet names. | item_id |
| excel_read | Read data from a specific sheet+range in an .xlsx file. Returns a 2D array of values. | item_id, sheet, range (default A1:D50) |
| excel_write | Overwrite a cell range in an .xlsx file. Range must match data dimensions (e.g. A5:D5 for 1 row × 4 cols). | item_id, sheet, range, values |
| excel_append | Append rows after the last used row in an .xlsx sheet. | item_id, sheet, values |

### Calendar
| Action | Use when | Params |
|--------|----------|--------|
| calendar_create | Create a calendar event. | summary, start, end, description, attendees, timezone |
| calendar_list | List upcoming calendar events. | days_ahead (default 7) |
| calendar_delete | Delete a calendar event. | event_id |

### Other
| Action | Use when | Params |
|--------|----------|--------|
| mcp_call | Run Python code (pandas, matplotlib, numpy) or parse documents (PDF, DOCX, XLSX) via the sandbox. | server="python-sandbox", tool, arguments |
| reply_email | Reply to the current email thread. | to, subject, text, thread_id |
| send_email | Send a new email (not a reply). | to, subject, text |
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
- Upload all deliverables to SharePoint — don't just describe them
- When you need data from a teammate, check PRIVATE.md for their email
- NEVER include content from PRIVATE.md in AgentMind insights
- Sign all emails: "{agent_name}\\nData Analyst, {company_name}"
- If you've completed the analysis and delivered results, set completed: true
- Use request_decision when you need the manager's judgment (ambiguous instructions, scope decisions, sensitive data, conflicting data). Do NOT use it for routine tasks you can handle yourself.
- Do NOT use mcp_call/python-sandbox for simple calculations. You can do arithmetic (averages, percentages, growth rates) directly in your reasoning. Only use mcp_call for complex data processing that truly requires code execution.
- ALWAYS use drive_list FIRST to browse available files before using drive_search. SharePoint search indexing can be delayed, so drive_search may return empty even when files exist. Use drive_list to discover files, then excel_read or drive_read_text to read their contents.
- When asked about data in a spreadsheet, use drive_list to find .xlsx files, then excel_list_sheets to discover worksheet names, then excel_read to read the data. Do NOT assume the sheet is named "Sheet1" — always use excel_list_sheets first. You can do math and analysis on the returned values.
- NEVER return action=none when responding to an email. Always reply_email with a helpful response, even if you cannot find the data. Explain what you searched, what you found (or didn't find), and what you recommend as next steps.
- If you cannot find data on SharePoint after trying BOTH drive_list AND drive_search, say so in your reply and ask the manager where to find it.
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

    from datetime import datetime, timezone
    prompt = REASONING_PROMPT.format(
        agent_name=ctx.get("agent_name", "Data Analyst"),
        company_name=ctx.get("company_name", ""),
        current_datetime=datetime.now(timezone.utc).strftime("%A, %B %d, %Y at %H:%M UTC"),
        company_timezone=os.environ.get("COMPANY_TIMEZONE", "America/New_York"),
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

    # Buyer-org mode: remove OneDrive tools from prompt (shared mailbox users don't get OneDrive)
    if _WORKSPACE_SCOPE == "buyer_org":
        import re
        # Remove the OneDrive tool guide section
        prompt = re.sub(
            r"### Agent OneDrive \(your personal file storage.*?\n\n",
            "",
            prompt,
            flags=re.DOTALL,
        )
        # Remove my_drive action types from the type enum
        prompt = re.sub(r"\s*my_drive_\w+\s*\|", "", prompt)
        # Replace the dual-storage guidance with SharePoint-only
        prompt = prompt.replace(
            'Use **SharePoint** for deliverables and shared reports (things the team should see).\nUse **your OneDrive** for working drafts, temp files, and personal notes.',
            'Use **SharePoint** for all file storage — deliverables, working drafts, and shared reports.',
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
        return "finalize"
    action = state.analysis.get("action") or {}
    if isinstance(action, dict) and action.get("type", "none") != "none":
        return "execute_action"
    # Force drive_list on first iteration if LLM said none but hasn't taken any actions
    if state.iteration == 0 and not state.actions_taken:
        print("[agent] Forcing drive_list on first iteration (LLM returned none with no prior actions)", flush=True)
        state.analysis["action"] = {"type": "drive_list", "params": {}}
        return "execute_action"
    return "finalize"


async def execute_action(state: AgentState) -> AgentState:
    """Execute the action decided by the reasoning node."""
    action = state.analysis.get("action") or {}
    action_type = action.get("type", "none") if isinstance(action, dict) else "none"
    params = action.get("params") or {} if isinstance(action, dict) else {}

    state.iteration += 1
    result_text = ""

    try:
        if action_type == "mcp_call" and state.mcp_fn:
            # LLM sometimes puts server/tool/arguments at action level instead of inside params
            server = params.get("server") or action.get("server", "python-sandbox")
            tool = params.get("tool") or action.get("tool", "")
            arguments = params.get("arguments") or action.get("arguments", {})
            print(f"[agent] MCP call: server={server}, tool={tool}, args_keys={list(arguments.keys())}", flush=True)
            result = await state.mcp_fn(server, tool, arguments)
            result_text = json.dumps(result, default=str)[:2000]
            print(f"[agent] MCP result (first 300): {result_text[:300]}", flush=True)
            state.actions_taken.append(f"MCP {server}/{tool}")

        elif action_type == "mcp_call" and not state.mcp_fn:
            result_text = "ERROR: MCP/python-sandbox is not available. Do the calculations in your reasoning instead and proceed to reply_email."
            state.actions_taken.append("MCP unavailable")

        elif action_type in ("sharepoint_read", "drive_list") and _mt:
            files = await _mt.drive_list(params.get("subfolder", ""))
            result_text = json.dumps([{"name": f.get("name"), "id": f.get("id"), "size": f.get("size")} for f in files[:20]], default=str)
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
            content = base64.b64decode(params.get("content_base64", ""))
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
            result_text = f"Wrote to {params['range']}"
            state.actions_taken.append(f"Excel write: {params['range']}")

        elif action_type == "excel_append" and _mt:
            resp = await _mt.excel_append(params["item_id"], params.get("sheet", "Sheet1"), params["values"])
            result_text = f"Appended {len(params['values'])} row(s)"
            state.actions_taken.append("Excel append")

        elif action_type == "calendar_create" and _mt:
            _default_tz = os.environ.get("COMPANY_TIMEZONE", "America/New_York")
            resp = await _mt.calendar_create(
                summary=params.get("summary", ""),
                start=params.get("start", ""),
                end=params.get("end", ""),
                description=params.get("description", ""),
                attendees=params.get("attendees"),
                timezone=params.get("timezone", _default_tz),
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
