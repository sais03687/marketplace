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
import re
import json
import asyncio
import base64
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
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


# Resolver for sandbox file handles, injected by the platform adapter.
#
# Files the sandbox produces are held by the platform and referenced by an id
# like "sandbox:ab12cd34" rather than passed through this process as base64. The
# model used to have to copy the whole base64 string into the upload action,
# which it cannot do reliably — a real run produced 1877 characters, not a valid
# base64 length, and the upload failed. The `b64 += "=" * (-len(b64) % 4)` that
# used to live in drive_upload repaired missing padding and could do nothing
# about truncation.
_file_resolver = None


def set_file_resolver(fn) -> None:
    """Called by the adapter with a fn mapping a sandbox handle to bytes."""
    global _file_resolver
    _file_resolver = fn


# The same idea pointing the other way, for a file that already exists in the
# workspace. `drive_read_text` returns a file's content as a string, which the
# model then holds in its context and which RESULT_CHAR_LIMIT cuts at 2000
# characters — fine for a note, useless for a dataset. So a workspace file large
# enough to be worth analysing could not be analysed at all: too big to read,
# and with no way to reach the sandbox, which is the only thing that can open it.
#
# The gap `a82b9c4` closed for an emailed attachment, still open for the more
# common case — "the data is in the shared folder". The platform downloads the
# bytes, holds them, and gives the model a handle, exactly as it does for an
# attachment; the model never sees the content and passes the handle to the
# sandbox instead.
_file_registrar = None


def set_file_registrar(fn) -> None:
    """Called by the adapter with a fn(name, bytes) -> handle."""
    global _file_registrar
    _file_registrar = fn


# What is in the file, handed over with the handle so the first line of code is
# written against an observed shape rather than an assumed one. Platform-side
# because it needs the bytes, and because it must not depend on the model
# remembering to look.
_file_describer = None


def set_file_describer(fn) -> None:
    """Called by the adapter with a fn(name, bytes) -> str description."""
    global _file_describer
    _file_describer = fn


# Checks the summary about to be sent against the files actually produced, and
# returns the figures asserted in one but absent from the other. Platform-side
# for the same reason as the resolver above: it needs the real bytes, and asking
# the model whether its own file is complete re-asks the question that produced
# the file.
_deliverable_verifier = None


def set_deliverable_verifier(fn) -> None:
    """Called by the adapter with an async fn(summary_text) -> list[str]."""
    global _deliverable_verifier
    _deliverable_verifier = fn


# Reads the superlative claims in the summary — "best", "highest", "worst" —
# against the columns of the file delivered with them. Same reason as above for
# living platform-side: it needs the file's real structure, not the model's
# account of it.
_ranking_verifier = None


def set_ranking_verifier(fn) -> None:
    """Called by the adapter with an async fn(summary_text) -> list[dict]."""
    global _ranking_verifier
    _ranking_verifier = fn


# The top-line figure in the reply, against the sheet the workbook itself calls
# its summary. Separate from the two above because it is the only one that can
# catch a reply which is wrong about *which* number answers the question — every
# figure it quotes may be real and correctly computed, as D01's were.
_headline_verifier = None


def set_headline_verifier(fn) -> None:
    """Called by the adapter with an async fn(summary_text) -> list[dict]."""
    global _headline_verifier
    _headline_verifier = fn


# Leading bytes that identify the formats this agent uploads. Used to refuse
# content that decoded successfully but is plainly not the file it claims to be.
_FILE_SIGNATURES = {
    ".xlsx": b"PK\x03\x04",
    ".docx": b"PK\x03\x04",
    ".zip": b"PK\x03\x04",
    ".pdf": b"%PDF",
    ".png": b"\x89PNG",
}


def _resolve_upload_content(ref: str, filename: str = "") -> bytes:
    """Bytes for an upload, from either a platform handle or inline base64.

    Handles are what the sandbox returns and are the normal path. Inline base64
    is still accepted for something the agent built itself.

    The validation below exists because a permissive fallback is worse than a
    failure here. On 2026-08-10 the model invented an id —
    "01HBC6OG2ER5CGZHDAARELS5LRVXTARXSZ" — for a file it had never written; its
    Python had only printed to stdout, so no handle existed. That string happens
    to be valid base64, so it decoded to about 25 bytes of noise and was uploaded
    to SharePoint as an .xlsx. No error was raised anywhere. A corrupt file
    delivered silently is worse than an upload that refuses and says why.
    """
    ref = (ref or "").strip()
    if not ref:
        raise ValueError("no content supplied for upload")

    if _file_resolver is not None:
        resolved = _file_resolver(ref)
        if resolved is not None:
            return resolved

        # A handle is the only accepted form when the platform is holding files.
        #
        # Inline base64 used to be allowed here as a fallback for content the
        # agent built itself. That is a narrow case, and it was bought at the
        # price of an entire class of bug: anything base64-shaped was treated as
        # a file. The validation below catches a short or wrongly-signed blob,
        # but only for extensions someone thought to list — a fabricated string
        # named report.csv would still have gone through.
        #
        # Refusing outright turns that from "we check the shapes we anticipated"
        # into "the model cannot supply file content at all". If the agent has
        # bytes, it writes them in the sandbox and uploads the id it gets back.
        raise ValueError(
            f"{ref[:40]!r} is not a file id the platform is holding. Uploads take a "
            "file_id, not file content: write the file to /tmp/output/ in the "
            "python-sandbox and pass the file_id returned with it. Do not paste "
            "base64 and do not invent an id."
        )

    # No resolver injected. That means this is not running under the platform
    # adapter — a test harness, or a call site that forgot to pass one. Accept
    # validated inline content so those keep working, and say so, because
    # silently taking model-supplied bytes is the thing being removed above.
    print(
        "[agent] WARNING: no file resolver injected; falling back to inline base64. "
        "On the platform this path should be unreachable.",
        flush=True,
    )

    try:
        content = base64.b64decode(ref + "=" * (-len(ref) % 4))
    except Exception as exc:
        raise ValueError(
            f"content_base64 is neither a file id nor valid base64 ({exc}). "
            "Write the file to /tmp/output/ in the sandbox and pass the file_id it returns."
        ) from exc

    # An identifier mistaken for content. Real files are not 25 bytes.
    if len(content) < 64:
        raise ValueError(
            f"content_base64 decoded to only {len(content)} bytes, which is not a file. "
            "If you meant to upload something the sandbox produced, write it to "
            "/tmp/output/ and pass the file_id returned with it — do not invent an id."
        )

    suffix = ("." + filename.rsplit(".", 1)[-1].lower()) if "." in filename else ""
    expected = _FILE_SIGNATURES.get(suffix)
    if expected and not content.startswith(expected):
        raise ValueError(
            f"the content does not look like a {suffix} file. "
            "Generate it in the sandbox and upload the file_id it returns."
        )

    return content


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

# The exception to the set above, and the only one.
#
# Everything blocked for sharing is blocked because it can move data out of the
# tenant. An organisation-scoped link cannot: opening it requires a sign-in the
# buyer's own directory issued, so it reaches exactly the people who could
# already be granted the file, and no one else. The reasoning that put sharing
# on the list — the agent grants access blind, and cannot see who already has
# it — does not apply where the audience is "the organisation" either.
#
# Being on the list anyway cost every file request a third approval prompt, on
# top of the upload and the reply, for the scope TOOLS.md tells the agent to
# prefer. And the prompt could not be answered usefully: the platform refused
# the call after approval regardless, because an org-scoped link has no
# recipient list for the recipient check to read. Approving it changed nothing.
#
# Anonymous stays blocked, and stays refused. That one really is a link anyone
# who ever receives it can open.
# Writes to the buyer's own data. No counterparty, so inside/outside does not
# apply — the only question is whether this buyer wants writes reviewed. Mirrors
# MUTATING_ACTIONS in the adapter, which is what decides the same question for
# anything reaching Microsoft.
_WRITE_ACTIONS = {
    "excel_write",
    "excel_append",
    "drive_upload",
    "my_drive_upload",
    "calendar_delete",
}


def _needs_manager_approval(
    action_type: str, params: dict, policy: dict | None = None
) -> bool:
    """Does this specific call need a human, given what it is actually doing?

    The buyer's approval policy is consulted, which it previously was not. This
    gate was a hardcoded set, and it runs *before* the platform's policy-aware
    check — the agent interrupts, so nothing downstream ever gets asked. A buyer
    who chose "Never ask — fully autonomous" was still stopped on every single
    upload. Confirmed on 2026-08-11: the container was on never, the reply went
    out unprompted as it should, and drive_upload interrupted anyway.

    It failed safe, which is why it went unnoticed. It was still the setting not
    doing what it says.

    Sharing is deliberately not policy-dependent, matching the adapter: "never"
    is a buyer asking to stop being interrupted about ordinary work, and reading
    it as permission to publish a file anyone can open is not a consequence
    anyone picks a notification preference to get.
    """
    if action_type not in BLOCKED_ACTIONS:
        return False

    if action_type in ("drive_create_link", "my_drive_create_link"):
        # Absent scope is not org scope. my_drive_create_link defaults to
        # anonymous, so silence here has to keep the gate rather than open it.
        return str((params or {}).get("scope", "")).lower() != "organization"

    if action_type in ("drive_share", "my_drive_share"):
        return True  # named recipients — the platform checks who they are

    if action_type in _WRITE_ACTIONS:
        setting = str((policy or {}).get("policy", "") or "").lower()
        if setting == "never":
            return False
        if setting == "risk-based":
            # No score means it could not be assessed, not that it scored zero.
            # Treating absent data as low risk is how an allowlist that failed to
            # load once came to mean "allow everyone" — fail toward the human.
            raw = (policy or {}).get("riskThreshold")
            combined = (params or {}).get("_risk_combined")
            try:
                return float(combined) >= float(raw if raw is not None else 5)
            except (TypeError, ValueError):
                return True
        # always, external-only, or unset. external-only speaks about
        # recipients and these have none, so it has no opinion — writes stay
        # reviewed, which is what every buyer has had until now.
        return True

    return True

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
    # Consecutive turns the model has returned action=none while claiming the
    # task is unfinished. Lives on the state so it survives a super-step; the
    # equivalent counter used to be incremented inside the router, where the
    # assignment was discarded and the guard it fed never fired.
    none_streak: int = 0
    # The last action emitted, as type plus arguments, and how many times it has
    # been emitted unchanged in a row. Distinct from none_streak: that counts a
    # model refusing to act, this counts one acting to no effect.
    last_action_sig: str = ""
    repeat_streak: int = 0
    # A real multi-step task spends five steps before it can even answer:
    # drive_list, excel_list_sheets, excel_read, mcp_call, reply. At eight, one
    # wrong turn or a retried tool call left nothing for the reply — the chart
    # request on 2026-08-03 used nine and finished with none.
    max_iterations: int = 12

    # Figures the composed reply asserts that the delivered file does not
    # contain, and how many times we have handed them back. Two attempts, because
    # a model that has failed to act on the same concrete list twice is not going
    # to on the third, and the buyer is waiting.
    deliverable_gaps: list = Field(default_factory=list)
    verify_attempts: int = 0
    max_verify_attempts: int = 2
    # Figures the run rebuilt by inverting an already-rounded value, and how many
    # times that has been handed back. Separate from the gaps above: that check
    # asks whether the file backs the reply, this one asks whether the arithmetic
    # was sound in the first place, and a wrong number agrees with itself.
    rebuilt_figures: list = Field(default_factory=list)
    rebuild_attempts: int = 0
    # Ranking claims — "best", "highest", "worst" — that the delivered file
    # argues against on its own figures, and how many times they have been handed
    # back. A third question again: not whether the file backs the reply, nor
    # whether the arithmetic drifted, but whether a claim about a number survives
    # the column that number came from.
    ranking_conflicts: list = Field(default_factory=list)
    ranking_attempts: int = 0
    # Headline figures the attached workbook's own summary sheet does not hold.
    # A fourth question, and the one the others structurally cannot ask: every
    # figure in the reply may be present in the file and correctly computed, and
    # the reply still lead with the wrong one.
    headline_conflicts: list = Field(default_factory=list)
    headline_attempts: int = 0
    # Set once the drift is measured and there is no budget to send the agent
    # back for it. The reply goes out with a note rather than looping.
    rebuild_unfixable: bool = False
    # Set once the last attempt has been spent and the gap survived it.
    deliverable_unfixable: bool = False
    ranking_unfixable: bool = False
    headline_unfixable: bool = False

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


# The closing pass has its own prompt, and the reason is that the reasoning one
# argues against it. That prompt is a ReAct loop: "Act: Choose ONE action to
# take", "You MUST produce a COMPLETE JSON response with ALL fields including
# action", "The action field is REQUIRED — never omit it", "If you still have
# steps in your plan, pick the NEXT action to execute". The instruction to stop
# and write the reply was appended to the *message*, several thousand tokens
# away from all of that and far less emphatic.
#
# The model followed the louder half, which is the unsurprising outcome. On
# 2026-08-10 a closing pass answered with excel_read — still working — and the
# retry after it returned action=none with an empty final_response.text. Two of
# four runs that day ended with the platform composing the reply from results
# because the model never wrote one.
#
# Telling it more firmly was tried twice and failed twice. So the closing pass
# no longer sees a schema it can put an action in: there is no action field to
# fill, and nothing to choose. The only thing it can produce is the reply.
WRAP_UP_PROMPT = """You are {agent_name}, the Data Analyst at {company_name}.

{soul_instructions}

The work is finished. Your only job now is to write the reply that goes to the
person who asked. You cannot run tools on this turn — there is nothing to decide
and nothing left to do.

## What they asked for

{request}

## What you did

{actions_taken}

## What the work produced

{action_results}

---

Write the reply.

- Answer the question they actually asked. If they asked which region performed
  best, name it and say by how much. A table is not an answer to a question.
- Lead with the figures. They can open the file; what they cannot see is the
  conclusion you drew from it.
- If the workbook has a Summary sheet, the reply leads from that sheet. You put
  those numbers there because they answer the question; the detail sheets hold
  the workings. A figure from a detail sheet can support the answer, but it is
  not the answer. A reconciliation whose Summary says the gap is 3,850 does not
  open by calling one 450 line the main difference — that line is one of four,
  and the largest of them was a deal that was never invoiced at all.
- Use the numbers above and only those. Never state a figure the results do not
  support, and never re-derive a figure that appears in their request — use
  theirs.
- Round money and percentages to two decimals.
- Say in one line how you got the headline figure, and name any assumption you
  had to make. "Summed eur_amount by merchant over the whole file" or "counted
  each cohort's M1 only, since that is the month every cohort has reached". They
  cannot check a number they cannot see the derivation of, and a wrong number
  that says how it was made can be corrected in seconds — one that arrives bare
  has to be taken on trust or thrown away.
- If the data cannot answer what they asked, say so and stop. A table of churn
  dates cannot tell you *why* anyone churned; a list of transactions cannot tell
  you what a customer intended. Name the field you would need. Do not offer a
  plausible-sounding cause you inferred rather than measured — that is the one
  answer they cannot check and the one most likely to be acted on.
- If the question has more than one defensible answer, give one and say it is a
  choice. "Top performer" over revenue, growth and margin is three different
  people; pick the one you think they mean, name the metric in the sentence, and
  say the answer changes under the others. Do not silently choose and present it
  as the answer.
- If a file was produced, mention it in one line at the end. Do not make the
  message about it, and do not list the tools you called.
- If part of the request is genuinely unfinished, say which part and why.
- If a result says an action was rejected by the manager, that is a decision,
  not a fault. Say plainly that it was not approved and so was not done. Do not
  call it an error, do not say you are investigating, and do not promise to
  retry or to follow up — nothing further will happen unless they ask again.
- Write as yourself, to a colleague. No preamble about being an AI.
- Sign off as "{agent_name}", and never with a placeholder. There is no
  "[Your Name]" to fill in later — this text is sent exactly as you write it.

Produce a JSON object and nothing else (no markdown fences):
{{
  "subject": "subject line for the reply, or null to keep the existing one",
  "text": "the reply itself, as plain text with line breaks"
}}"""


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
    "type": "send_email | reply_email | inbox_list | inbox_read | inbox_search | mcp_call | sharepoint_read | drive_search | drive_read_text | drive_fetch | drive_list | drive_upload | drive_share | drive_create_link | my_drive_list | my_drive_read | my_drive_search | my_drive_upload | my_drive_share | my_drive_create_link | excel_list_sheets | excel_read | excel_write | excel_append | calendar_list | calendar_create | request_decision | none",
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
| drive_read_text | Read a SMALL text file you need to quote — a note, a README. It is cut at 2000 characters, so it is the wrong tool for data: a fee table or a dataset read this way arrives truncated and every figure taken from it is unsafe. For anything you mean to compute with, use drive_fetch. Never for .xlsx. | item_id |
| drive_fetch | Hand workspace files to the sandbox without reading them here. Use for ANY file you mean to analyse rather than quote — a dataset, a spreadsheet, anything over a few hundred rows. **Ask for every file you need in one call**, by name: `files: ["orders.csv", "price_list.xlsx"]`. Names are looked up for you, so you do not need drive_list first. Then open them in the sandbox as /tmp/input/<name>. drive_read_text puts the content in this conversation and is cut at 2000 characters, so it is for reading a note, not for analysing data. | files (list of names or ids), subfolder (optional) |
| drive_upload | Upload a file to your SharePoint folder. `content_base64` takes the `file_id` the sandbox returned — never file content. To upload anything, write it to `/tmp/output/` in the python-sandbox first and pass the id you get back. | filename, content_base64, content_type |
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
| my_drive_upload | Upload a file to your OneDrive. Same `file_id` rule as drive_upload. | filename, content_base64, content_type |
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
- Give every workbook a sheet named "Summary" as its first sheet, holding the
  few figures that answer the question as label/value rows — the total, the gap,
  the winner, whatever was actually asked. The detail sheets hold the workings.
  This is what your reply leads from, and the platform compares your opening
  line against it, so a Summary that disagrees with your email will come back.
- When you need data from a teammate, check PRIVATE.md for their email
- NEVER include content from PRIVATE.md in AgentMind insights
- Sign all emails: "{agent_name}\\nData Analyst, {company_name}"
- If you've completed the analysis and delivered results, set completed: true
- Use request_decision when you need the manager's judgment (ambiguous instructions, scope decisions, sensitive data, conflicting data). Do NOT use it for routine tasks you can handle yourself.
- Do NOT use mcp_call/python-sandbox for simple calculations. You can do arithmetic (averages, percentages, growth rates) directly in your reasoning. Only use mcp_call for complex data processing that truly requires code execution.
- The python-sandbox has its own private filesystem that nobody else can see, and it is thrown away when the run ends. Writing a file there does not put it on SharePoint and does not deliver it to anyone. If you were asked to create or update a file, you must finish with drive_upload, excel_write or excel_append — otherwise the work does not exist as far as the person who asked is concerned, and saying you have done it would be false.
- The file you produce is the deliverable, not a sketch of it. It must stand on its own and cover everything the request asked for — someone opening it will not have your reply next to them. If your reply states a figure, a breakdown or a comparison, the file has to contain it too; a summary that is richer than the file it points at means the file is unfinished. The platform reads your file and checks this, and will hand back anything you left out.
- ALWAYS use drive_list FIRST to browse available files before using drive_search. SharePoint search indexing can be delayed, so drive_search may return empty even when files exist. Use drive_list to discover files, then excel_read or drive_read_text to read their contents.
- When asked about data in a spreadsheet, use drive_list to find .xlsx files, then excel_list_sheets to discover worksheet names, then excel_read to read the data. Do NOT assume the sheet is named "Sheet1" — always use excel_list_sheets first. You can do math and analysis on the returned values.
- NEVER return action=none when responding to an email. Always reply_email with a helpful response, even if you cannot find the data. Explain what you searched, what you found (or didn't find), and what you recommend as next steps.
- When you give a figure, say in one line how you got it and what you assumed. A number nobody can check has to be taken on trust; a number with its derivation beside it can be corrected in seconds.
- If the data cannot answer the question, say so and name the field you would need. Churn dates cannot explain *why* anyone churned. Do not supply a plausible cause you inferred rather than measured — that is the answer they cannot check and the one most likely to be acted on.
- If the question has more than one defensible answer — "top performer" over revenue, growth and margin is three different people — give one, name the metric you used in the sentence, and say the answer changes under the others. Never choose silently and present it as the answer.
- If you cannot find data on SharePoint after trying BOTH drive_list AND drive_search, say so in your reply and ask the manager where to find it.
- request_decision BLOCKS until the manager responds — only use it when you genuinely need their input
- When the user explicitly asks you to perform an action (write, upload, append, delete), DO IT DIRECTLY. Do not email the user back to ask for the file, do not use request_decision to clarify, and do not take detours. Execute the requested action using the tools available to you. If the action is blocked, the approval system will handle it automatically.
- "type" MUST be one of the action types listed above, exactly as spelled. Never invent one, and never wrap a real action inside another. There is no approval wrapper action: to share a file you emit drive_share itself, with its own params. Asking for permission is not something you do — emit the action you want, and if it needs a human the platform pauses it, asks them, and resumes you automatically. An invented type does nothing at all, so the person waiting on you gets silence.
- If an action fails (e.g., email bounce, API error), do NOT spiral into retries or request_decision loops. Report the error in your reply and move on.
- You can only START a conversation with, or share a file with, people inside this organisation: the company domain, your manager, or addresses on the buyer's allowlist. If you are asked to email or share with someone outside it, do not attempt the action and do not look for a way around it. Reply to the person who asked, tell them plainly that you cannot reach that address and why, and suggest they send it themselves. Replying to anyone who emails you first is always allowed.
"""


# One action's worth. A request naming more files than this is either confused
# or about to exhaust the container's memory, and the cap is high enough that no
# honest request has met it.
_MAX_FETCH_PER_ACTION = 8

# SharePoint item ids: long, upper-case, no dots. A filename has an extension and
# a drive id does not, which is enough to tell them apart without asking.
_DRIVE_ID_RE = re.compile(r"^[A-Z0-9]{20,}$")


def _looks_like_drive_id(ref: str) -> bool:
    return bool(_DRIVE_ID_RE.match((ref or "").strip()))


def _requested_files(params: dict) -> list[str]:
    """Everything the model asked for, however it phrased the request.

    Singular and plural, ids and names, a list or one string. The same lesson as
    the sandbox boundary: the shapes a model reaches for are all reasonable, and
    refusing them costs a step to teach it a rule it will not remember.
    """
    out: list[str] = []
    for key in ("item_ids", "items", "files", "filenames", "names",
                "item_id", "id", "filename", "name", "file"):
        val = params.get(key)
        if isinstance(val, str):
            val = [val]
        if isinstance(val, (list, tuple)):
            for v in val:
                if isinstance(v, dict):
                    v = v.get("id") or v.get("item_id") or v.get("name") or v.get("filename")
                if isinstance(v, str) and v.strip() and v.strip() not in out:
                    out.append(v.strip())
    return out


async def _folder_index(subfolder: str = "") -> dict[str, str]:
    """Filename → item id for the agent's folder, and one level of subfolders.

    Listing is what the model was spending a whole step on before it could fetch
    anything, so the fetch does it here instead. One level down because that is
    where a request that says "in dabstep/" means, and no deeper because a full
    walk of someone's SharePoint is not something to do on every fetch.
    """
    index: dict[str, str] = {}
    try:
        entries = await _mt.drive_list(subfolder or "")
    except Exception as exc:
        print(f"[agent] drive_fetch: could not list '{subfolder}': {exc}", flush=True)
        return index

    subfolders = []
    for e in entries or []:
        name = (e.get("name") or "").strip()
        if not name:
            continue
        # `"folder" in e`, not `e.get("folder")`. Graph marks a directory by the
        # presence of the facet, and an empty one — {"folder": {}} — is falsy,
        # so a truthiness test files directories away as documents and never
        # looks inside them.
        if "folder" in e:
            subfolders.append(name)
        elif e.get("id"):
            index.setdefault(name.lower(), e["id"])

    if subfolder:
        return index

    for sub in subfolders[:6]:
        try:
            for e in await _mt.drive_list(sub) or []:
                name = (e.get("name") or "").strip()
                if name and e.get("id") and "folder" not in e:
                    index.setdefault(name.lower(), e["id"])
        except Exception:
            continue
    return index


def _trim_traceback(stderr: str, limit: int = 1200) -> str:
    """A traceback cut to `limit`, keeping the end — where the exception is.

    This used to be `stderr[:1200]`, which for a pandas traceback is 1200
    characters of frames through site-packages and no exception at all. The
    line that says what actually went wrong is the last one, and it was the
    one being dropped.

    Benchmark task T03 failed the same way on three consecutive runs on
    2026-08-13, each time with `ParserError: Expected 5 fields in line 6, saw
    6` cut off the end of what the model was shown — so the model was left
    guessing at an error it was never told, and the platform's own failure
    caveat had nothing to quote either. Both halves of that were reading the
    wrong end of the same string.

    The head is kept too, in a smaller share: it holds `File "<string>", line
    16`, which is the line of the model's own code that raised.
    """
    stderr = (stderr or "").strip()
    if len(stderr) <= limit:
        return stderr
    head, tail = limit // 4, limit - limit // 4
    return f"{stderr[:head].rstrip()}\n... [frames omitted] ...\n{stderr[-tail:].lstrip()}"


def _as_plan_text(value: Any, fallback: str) -> str:
    """Whatever shape the model sent the plan in, as a string.

    A list of steps is the common variant and reads perfectly well numbered.
    Anything else falls back rather than being coerced into something
    meaningless — the plan is for the model's own next turn, so a wrong-shaped
    plan is worth losing, and the run is not.
    """
    if value is None:
        return fallback
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        steps = [str(s).strip() for s in value if str(s).strip()]
        return "\n".join(f"{i}. {s}" for i, s in enumerate(steps, 1)) or fallback
    if isinstance(value, dict):
        return json.dumps(value, default=str)
    return fallback


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
        # Two callers, and they are not the same situation. Saying "you have no
        # steps left" to a run that has ten of twelve remaining is simply false,
        # and it was the only thing this pass said about why it was happening.
        # The run that exposed it reasoned "now I need to consolidate the results
        # and reply", returned action none, wrote no final_response, and the
        # requester got a list of steps instead of their answer.
        if state.context.get("_approved_action_executing"):
            why = (
                "The action you asked for has been approved and carried out. "
                "Everything the request needed is now done."
            )
        elif state.iteration >= state.max_iterations:
            why = "You have no steps left."
        else:
            # Reached from route_after_reasoning: the model called the task
            # complete and left final_response.text empty.
            why = (
                "You marked this task complete but did not write the reply, so "
                "the requester has not been told anything yet."
            )

        message_content += (
            f"\n\n[SYSTEM] {why} This turn produces the reply and nothing else.\n"
            "\n"
            "Set \"completed\": true and \"action\": {\"type\": \"none\"}, and put the "
            "reply itself in final_response.text. That field is what gets sent. If "
            "you leave it empty the requester receives nothing of use, however good "
            "your reasoning was.\n"
            "\n"
            "Answer the question they actually asked, using the numbers in the "
            "results above. Lead with the figures — totals, comparisons, whichever "
            "was requested — not with a description of the steps you took. They can "
            "see the file; what they cannot see is the answer.\n"
            "\n"
            "If you produced a file, mention it in one line at the end. Do not make "
            "the message about it, and do not list the tools you called. If some "
            "part of the request is genuinely unfinished, say which part and why. "
            "Never claim anything the results above do not support."
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
            # [-1] rather than [1]: a response of a bare "```" with nothing after
            # it has no second element, and the IndexError that raised was not in
            # the except below — so it escaped past the regex salvage on the next
            # line, which would have recovered the reply, and killed the whole
            # message with "Error handling message: list index out of range". The
            # requester got no answer at all. Seen on 2026-08-12 on the
            # action=none retry, where a short degenerate response is likeliest.
            cleaned = cleaned.split("\n", 1)[-1].rsplit("```", 1)[0]
        parsed = json.loads(cleaned)
        state.analysis = parsed if isinstance(parsed, dict) else None
    except (json.JSONDecodeError, ValueError, IndexError, TypeError, AttributeError):
        # Anything at all here means "could not parse", and the salvage below is
        # the point. Never let a parse failure become an unhandled exception.
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

    # The prompt asks for a string and the model sometimes sends the steps as a
    # list instead. Assigning that straight to a `str` field raises a Pydantic
    # ValidationError out of graph.ainvoke, which lands in the adapter's
    # catch-all — so a formatting choice in one field killed the entire run.
    # Benchmark task T03 died exactly this way on 2026-08-13, on a run whose
    # analysis was otherwise fine.
    state.plan = _as_plan_text(state.analysis.get("plan"), state.plan)

    # Debug: log the parsed action
    action = state.analysis.get("action") if isinstance(state.analysis, dict) else None
    print(f"[agent] Parsed action: {json.dumps(action, default=str)[:200] if action else 'None/missing'}", flush=True)

    # Decisions that change state belong here, in a node, never in the router.
    #
    # A conditional edge contributes only the name of the next node — anything it
    # assigns to state is discarded. Three separate decisions were being made in
    # route_after_reasoning by mutating state, and none of them took effect. Two
    # were meant to stop the graph looping, including one whose comment reads
    # "count this as an iteration to prevent infinite loops".
    action_type = action.get("type", "none") if isinstance(action, dict) else "none"

    # Nothing gathered yet and the model opened with "none": give it a first look
    # at the folder rather than finalising on an empty hand.
    if action_type == "none" and state.iteration == 0 and not state.actions_taken:
        print("[agent] Forcing drive_list on first iteration (model returned none with no prior actions)", flush=True)
        state.analysis["action"] = {"type": "drive_list", "params": {}}
        action_type = "drive_list"

    # How many turns in a row the model has declined to act while claiming the task
    # is unfinished. Re-reasoning once or twice recovers a malformed action; beyond
    # that it is not going to, and each further turn is another paid call for
    # nothing. Counted here so the value survives into the next super-step.
    if action_type == "none" and not state.analysis.get("completed", False) and state.actions_taken:
        state.none_streak += 1
    else:
        state.none_streak = 0

    # The same action, with the same arguments, over and over.
    #
    # none_streak above only catches a model that declines to act. A model that
    # acts identically forever looks busy and is not: on 2026-08-10 an onboarding
    # run emitted inbox_list ten times in a row against an empty mailbox, spent
    # ten of its twelve iterations, and finished with nothing to say. Waiting for
    # a reply is not work, and the eleventh call cannot return what the tenth
    # did not.
    #
    # Counted here, in a node, for the same reason none_streak is: a router
    # cannot keep a counter.
    signature = json.dumps(
        {"type": action_type, "params": (action.get("params") if isinstance(action, dict) else {}) or {}},
        default=str, sort_keys=True,
    )
    if action_type != "none" and signature == state.last_action_sig:
        state.repeat_streak += 1
    else:
        state.repeat_streak = 0
    state.last_action_sig = signature

    return state


async def _write_reply(state: AgentState) -> str:
    """Ask the model for the closing reply, and for nothing else.

    A separate call rather than another turn of the ReAct loop, because the loop
    is what was producing actions instead of prose. Returns "" if the model
    still declines, leaving the deterministic composer to take over.
    """
    results_str = "None" if not state.action_results else "\n".join(
        f"- Result {i + 1}: {_fmt_result(r)}"
        for i, r in enumerate(state.action_results[-6:])
    )
    actions_str = "None" if not state.actions_taken else "\n".join(
        f"- {a}" for a in state.actions_taken[-8:]
    )

    prompt = WRAP_UP_PROMPT.format(
        agent_name=state.context.get("agent_name", "Data Analyst"),
        company_name=state.context.get("company_name", ""),
        soul_instructions=_soul_md,
        request=(state.content or "(no request text available)")[:4000],
        actions_taken=actions_str,
        action_results=results_str,
    )

    try:
        response = await asyncio.wait_for(llm.ainvoke(prompt), timeout=60)
    except Exception as e:
        # Timeout, rate limit, provider error — all the same from here, and all
        # recoverable: the caller tries once more and then composes from the
        # results it already has.
        print(
            f"[agent] Closing-reply call failed ({type(e).__name__}: {e}) — retrying or composing",
            flush=True,
        )
        return ""

    raw = response.content if hasattr(response, "content") else str(response)
    cleaned = raw.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.split("\n", 1)[-1].rsplit("```", 1)[0]

    parsed = None
    try:
        parsed = json.loads(cleaned)
    except (json.JSONDecodeError, ValueError):
        match = re.search(r"\{.*\}", cleaned, re.DOTALL)
        if match:
            try:
                parsed = json.loads(match.group())
            except (json.JSONDecodeError, ValueError):
                parsed = None

    # A reply cut off at the token limit is still a reply. Observed on
    # 2026-08-11: the model returned {"subject": null, "text": "Hi Sai,\n\nI…
    # and stopped, so json.loads failed and the brace-matching fallback above
    # found no closing brace either. The whole answer was discarded over its
    # punctuation, and only the retry saved it.
    #
    # Same treatment the sandbox envelope gets: lift the field out by hand and
    # unescape what survived.
    if not isinstance(parsed, dict) or not str(parsed.get("text") or "").strip():
        salvaged = re.search(r'"text"\s*:\s*"((?:[^"\\]|\\.)*)', cleaned)
        if salvaged:
            body = salvaged.group(1)
            try:
                body = json.loads(f'"{body}"')
            except ValueError:
                for esc, real in (("\\n", "\n"), ("\\t", "\t"), ("\\r", "\r"),
                                  ('\\"', '"'), ("\\/", "/"), ("\\\\", "\\")):
                    body = body.rstrip("\\").replace(esc, real)
            if body.strip():
                print(
                    f"[agent] Closing reply arrived truncated — salvaged {len(body)} chars",
                    flush=True,
                )
                return body.strip()

    if isinstance(parsed, dict) and str(parsed.get("text") or "").strip():
        subject = parsed.get("subject")
        if isinstance(subject, str) and subject.strip():
            state.context["_wrap_up_subject"] = subject.strip()
        return str(parsed["text"]).strip()

    # Prose without the wrapper still answers the question, and a reply is not
    # worth discarding over its packaging. Only accept it when it is clearly not
    # a half-parsed object.
    if cleaned and not cleaned.lstrip().startswith("{"):
        return cleaned

    # Distinguish the two silences in the log. An empty completion is the model
    # declining and is usually transient; unparseable output means the prompt or
    # the schema has drifted, and that is a real regression worth seeing.
    print(
        "[agent] Closing reply unusable: "
        + ("model returned nothing" if not cleaned else f"could not parse {cleaned[:160]!r}"),
        flush=True,
    )
    return ""


def _set_reply(state: AgentState, text: str) -> None:
    """Install `text` as the run's final reply and close the analysis out.

    Only the text and, if the model supplied one, the subject. to and thread_id
    keep whatever the run already had — addressing is not this pass's business,
    and the platform resolves it afterwards anyway.
    """
    analysis = state.analysis if isinstance(state.analysis, dict) else {}
    final = analysis.get("final_response")
    final = dict(final) if isinstance(final, dict) else {}
    # Anything that is not a way of sending counts as no action at all. This
    # used to read `final.get("action") or "reply_email"`, and "none" is a
    # truthy string, so `or` never replaced it — while the fallback for an
    # unparseable response sets exactly {"action": "none"} by construction.
    #
    # wrap_up runs precisely because a reply is needed. It composed one, this
    # left the action reading "none", and the adapter sends on send_email and
    # reply_email only: benchmark task T03 on 2026-08-13 wrote 496 characters,
    # had them thrown away, was retried, wrote 349 more, had those thrown away
    # too, and the requester was sent "I wasn't sure how to respond".
    existing = final.get("action")
    final["action"] = existing if existing in ("send_email", "reply_email") else "reply_email"
    final["text"] = text
    subject = state.context.pop("_wrap_up_subject", "")
    if subject and not final.get("subject"):
        final["subject"] = subject
    analysis["final_response"] = final
    # The run is over either way — say so, so nothing downstream reads this as a
    # turn still holding an unexecuted action.
    analysis["completed"] = True
    analysis["action"] = {"type": "none"}
    state.analysis = analysis


async def wrap_up(state: AgentState) -> AgentState:
    """Final pass once the step budget is spent: write the reply, take no action.

    A node rather than a jump back into reason_and_act. The first version of this
    set a flag inside the router to stop it re-entering, and because router
    mutations are discarded the flag was never there on the next visit — the graph
    bounced between reason_and_act and the router indefinitely, one model call per
    turn, executing nothing. That is what burned roughly twenty calls a minute on a
    freshly hired agent until it was paused.

    With a fixed edge to finalize, re-entry is impossible by construction rather
    than by a flag that has to survive.
    """
    state.context["_wrapping_up"] = True
    # Two callers now: the step budget running out, and an approved action having
    # just executed. Say which, so the log does not claim exhaustion for a run
    # that used two of twelve iterations.
    why = (
        "approved action done"
        if state.context.get("_approved_action_executing")
        else "out of steps"
    )
    print(
        f"[agent] {why} after {len(state.actions_taken)} action(s) — final pass for the reply",
        flush=True,
    )
    # A dedicated call, not another turn of the ReAct loop.
    #
    # This used to run reason_and_act, whose prompt spends most of its length
    # insisting that an action is mandatory and that "none" is only for a
    # finished task. The instruction to stop and write the reply was appended to
    # the message, thousands of tokens away and far quieter. The model followed
    # the louder half: on 2026-08-10 the closing pass answered with excel_read,
    # still working, and a second attempt returned action=none with no text.
    #
    # Sampling again was the previous fix and it did not help, because the
    # problem was never randomness — the prompt was asking for the wrong thing,
    # consistently. WRAP_UP_PROMPT has no action field to fill, so there is
    # nothing to choose and the only output available is the reply.
    text = await _write_reply(state)

    if text:
        _set_reply(state, text)
        print(f"[agent] wrap_up wrote the reply ({len(text)} chars)", flush=True)
        return state

    print("[agent] wrap_up produced no reply text — one more attempt", flush=True)
    text = await _write_reply(state)
    if text:
        _set_reply(state, text)
        print(f"[agent] wrap_up wrote the reply on the second attempt ({len(text)} chars)", flush=True)
        return state

    # Two passes at a prompt that can only produce a reply, and still nothing.
    # A third would be the same bet again, and the results are already in hand:
    # composing from them needs no model at all, and the printed records are a
    # better source for a table than a model retyping them would be.
    #
    # This path is the floor, not the plan. Reaching it means the buyer gets
    # figures without an answer, so it is worth watching in the logs.
    composed = _compose_reply(state)
    if not composed:
        # Nothing renderable — a run that genuinely produced no findings. Leave
        # it to finalize, which says so honestly.
        print("[agent] wrap_up silent and no results to compose from", flush=True)
        return state

    _set_reply(state, composed)
    print(
        f"[agent] wrap_up composed the reply from results ({len(composed)} chars) "
        "— the model would not write one",
        flush=True,
    )
    return state


def _reply_text_of(state: AgentState) -> str:
    """The reply the model has written so far, if any."""
    analysis = state.analysis if isinstance(state.analysis, dict) else {}
    final = analysis.get("final_response") or {}
    return (final.get("text") or "").strip() if isinstance(final, dict) else ""


def route_after_reasoning(state: AgentState) -> str:
    """Route based on the reasoning output.

    Reads state, never writes it. A conditional edge only contributes the name of
    the next node, so anything assigned here is thrown away — which is how two
    guards meant to prevent infinite loops came to do nothing at all. Every
    decision that needs to persist is made in reason_and_act or wrap_up.
    """
    if not isinstance(state.analysis, dict):
        return "verify_deliverables"

    if state.analysis.get("completed", False):
        # Completed, but did it actually write the answer?
        #
        # finalize only packages final_response; it composes nothing. So a model
        # that sets completed: true and leaves final_response.text empty ends the
        # run silently, and the empty-text fallback sends a list of steps instead
        # of the result. Observed repeatedly on 2026-08-10: the analysis was
        # correct, the workbook was attached to the mail, and the requester was
        # told "I did not manage to write up the results".
        #
        # wrap_up is the pass that composes. Send the run there once — it sets
        # _wrapping_up and has a fixed edge to finalize, so this cannot recur on
        # the second visit even if the model leaves it empty again.
        final = state.analysis.get("final_response") or {}
        text = (final.get("text") or "").strip() if isinstance(final, dict) else ""

        # completed=true used to be honoured on the spot, which threw away any
        # action the model had asked for in the same breath. On 2026-08-10 a run
        # built the workbook, returned completed=true with action=drive_upload and
        # no reply text, and the upload was discarded: the file never reached
        # SharePoint, nothing was attached, and the requester got the
        # partial-progress fallback listing "execute_python" as the work.
        #
        # A model claiming to be finished while still asking for an action, and
        # having written no reply, is contradicting itself — and the action is the
        # more reliable half, because it is the deliverable. So run it.
        #
        # Gated on empty text so a genuine completion that carries a summary is
        # never hijacked by a stale action, and on the step budget so this cannot
        # push a run past its ceiling.
        pending = state.analysis.get("action") or {}
        pending_type = pending.get("type", "none") if isinstance(pending, dict) else "none"
        if not text and pending_type != "none" and state.iteration < state.max_iterations:
            print(
                f"[agent] completed=true but '{pending_type}' has not run and no reply "
                "was written — executing it rather than calling the task done",
                flush=True,
            )
            return "execute_action"

        if not text and state.actions_taken and not state.context.get("_wrapping_up"):
            print(
                "[agent] completed=true but no reply text — one pass to write it",
                flush=True,
            )
            return "wrap_up"
        return "verify_deliverables"

    # Already written the closing reply — nothing follows it.
    if state.context.get("_wrapping_up"):
        return "verify_deliverables"

    # Out of steps, but not out of things to say. Going straight to finalize hands
    # it whatever final_response exists, and mid-task there is none — the requester
    # got "I wasn't sure how to respond" after the agent had read their data and
    # built their chart. One more pass, for the reply only, then finalize.
    if state.iteration >= state.max_iterations:
        return "wrap_up" if state.actions_taken else "finalize"

    # The same call, unchanged, for the third time. Executing it again cannot
    # tell the agent anything the last two did not, and the steps it burns are
    # the ones the reply needed. Two identical repeats are tolerated — a retry
    # after a transient failure is legitimate — and the third ends the loop.
    if state.repeat_streak >= 2:
        print(
            f"[agent] same action {state.repeat_streak + 1} times running "
            f"({(state.analysis.get('action') or {}).get('type', '?')}) — "
            "stopping the loop and writing the reply",
            flush=True,
        )
        return "wrap_up" if state.actions_taken else "verify_deliverables"

    action = state.analysis.get("action") or {}
    if isinstance(action, dict) and action.get("type", "none") != "none":
        return "execute_action"

    # The model declined to act while saying the task is unfinished. Give it a
    # couple of turns to recover from a malformed action, then stop: past that it
    # is looping, and every turn is another paid call producing nothing.
    if state.none_streak <= 2 and state.iteration < state.max_iterations - 1 and state.actions_taken:
        print(
            f"[agent] action=none but task not complete "
            f"(streak={state.none_streak}, iter={state.iteration}) — re-reasoning",
            flush=True,
        )
        return "reason_and_act"

    if state.none_streak > 2:
        print(f"[agent] action=none {state.none_streak} turns running — finalizing", flush=True)
    return "verify_deliverables"


async def execute_action(state: AgentState) -> AgentState:
    """Execute the action decided by the reasoning node."""
    action = state.analysis.get("action") or {}
    action_type = action.get("type", "none") if isinstance(action, dict) else "none"
    params = action.get("params") or {} if isinstance(action, dict) else {}

    state.iteration += 1
    result_text = ""

    try:
        # ── Interrupt for blocked actions (requires manager approval) ────────
        # The buyer's policy comes from the platform, which owns it; the risk
        # score comes from this turn's own reasoning, which is where it is
        # produced. Passed together so the gate can answer the same question the
        # adapter would, rather than a hardcoded approximation of it.
        # ── Refuse before asking, not after ─────────────────────────────────
        # On 2026-08-16 task D05 emitted a drive_upload whose content_base64 was
        # the repr of a bytes object — "b'PK\x03\x04\x14\x00...". That is not a
        # handle and never resolves, so `_resolve_upload_content` was always
        # going to raise. It raised *after* the approval, so a person was shown
        # 30 KB of escaped binary in the portal, approved it, and the upload then
        # failed anyway; the workbook was lost and the reply had to admit it.
        #
        # The platform knows the payload is bad before it knows whether anyone
        # would have allowed it. Checking first turns a wasted human round trip
        # into a hand-back the model can act on, which is the one thing that has
        # reliably changed its behaviour: an error at the moment of the error.
        if action_type in ("drive_upload", "my_drive_upload"):
            try:
                _resolve_upload_content(
                    params.get("content_base64", ""), params.get("filename", "")
                )
            except ValueError as bad_upload:
                print(
                    f"[agent] {action_type} payload rejected before approval: {bad_upload}",
                    flush=True,
                )
                state.action_results.append(
                    f"STEP FAILED — {action_type} was not sent for approval, because "
                    f"the file it carries is not one the platform holds: {bad_upload}"
                )
                state.actions_taken.append(f"{action_type} not attempted")
                return state

        _risk = state.analysis.get("risk_assessment") or {}
        _gate_params = {**params, "_risk_combined": _risk.get("combined")}
        if _needs_manager_approval(
            action_type, _gate_params, state.context.get("approval_policy")
        ):
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

            # A script that crashed is not a source of findings.
            #
            # The exit status was in the envelope all along and nothing read it,
            # here or anywhere else — returncode appears in this file only on the
            # list of things to keep out of the reply. So on 2026-08-11 a step
            # exited 1 with
            #
            #   NameError: name 'sl_growth_region' is not defined
            #
            # having printed one line before it died, and that line was carried
            # forward and reported as "Fastest Growing Region: West (14.05%)".
            # The figure was real; the run that produced it had fallen over
            # halfway through, and nothing said so.
            #
            # Buried in a JSON envelope, "returncode": 1 is easy to read past.
            # Said first, in words, it is not — and the partial output is handed
            # over labelled as partial rather than as a result.
            _rc = result.get("returncode") if isinstance(result, dict) else None
            if _rc not in (0, None):
                _stderr = str((result or {}).get("stderr") or "").strip()
                _stdout = str((result or {}).get("stdout") or "").strip()
                # Twice in a row means the last fix was aimed at the wrong thing,
                # and repeating the guess a third time is what burns the run. On
                # 2026-08-11 a header of "Month, North" parsed as the column
                # " North", and KeyError names the key you asked for and never
                # the ones that exist — so the same assumption was retried three
                # times until the loop guard stopped it. The way out of that is
                # to look at the actual state rather than reason about it.
                _repeat = any(
                    isinstance(r, str) and r.startswith("STEP FAILED")
                    for r in state.action_results[-1:]
                )
                result_text = (
                    f"STEP FAILED — the code exited with status {_rc} and did not "
                    "finish.\n\n"
                    + (f"Error:\n{_trim_traceback(_stderr)}\n\n" if _stderr else "")
                    + (
                        "It printed this before it stopped. This is partial, and "
                        "not a result — do not report any of these figures:\n"
                        f"{_stdout[:800]}\n\n" if _stdout else ""
                    )
                    + (
                        "This is the second failure in a row, so the assumption "
                        "behind the last fix is probably the wrong one. Stop "
                        "guessing at the shape of the data and print it: the "
                        "columns, the dtypes, the first few rows, whatever this "
                        "error is about. Look at what is actually there, then "
                        "write the real code. An error names what you asked for, "
                        "not what exists."
                        if _repeat else
                        "Fix the code and run it again. Nothing was produced."
                    )
                )
                state.actions_taken.append(f"MCP {server}/{tool} FAILED (exit {_rc})")
                print(
                    f"[agent] MCP {server}/{tool} exited {_rc} — treating as a failed "
                    f"step, not a result",
                    flush=True,
                )
            else:
                result_text = json.dumps(result, default=str)[:2000]
                state.actions_taken.append(f"MCP {server}/{tool}")
            print(f"[agent] MCP result (first 300): {result_text[:300]}", flush=True)

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
            # Truncated, and said so. The cut used to be silent: the model asked
            # for a 531 KB fee table on 2026-08-14, was handed its first 2000
            # characters with nothing to mark the end, and answered from the
            # fragment as though it were the file. The same failure as reading
            # the front of a traceback — the information is missing and nothing
            # says it is missing.
            if not content:
                result_text = "(empty file)"
            elif len(content) > 2000:
                result_text = (
                    content[:2000]
                    + f"\n\n[TRUNCATED — this is the first 2000 of {len(content):,} "
                    "characters. You have NOT seen this file. Do not answer from "
                    "it, and do not assume the part you cannot see resembles the "
                    "part you can. Use drive_fetch on this item_id instead: it "
                    "hands the whole file to the sandbox, where you can open it "
                    "properly.]"
                )
            else:
                result_text = content
            state.actions_taken.append(f"Read file: {item_id[:20]}")

        elif action_type == "drive_fetch" and _mt:
            # Several files, by name or by id, in one step.
            #
            # One file per action cost DB1753 four of its twelve steps before any
            # analysis began — a drive_list to learn the ids, then a fetch each
            # for payments.csv, fees.json and merchant_data.json — and it ran out
            # mid-analysis. Every one of those steps was bookkeeping the platform
            # could do itself: a request that says "the data is in dabstep/" has
            # already told us where to look.
            wanted = _requested_files(params)
            fetched, failed = [], []
            listing: dict[str, str] | None = None
            for ref in wanted[:_MAX_FETCH_PER_ACTION]:
                item_id = ref
                if not _looks_like_drive_id(ref):
                    # A name. Resolve it against the folder, listing once and
                    # reusing that for the rest — this is what drive_list was
                    # being spent as a whole step on.
                    if listing is None:
                        listing = await _folder_index(params.get("subfolder", ""))
                    # Not in the folder is not proof it is not an id: the shape
                    # test is a hint, and an id from a tenant whose ids look
                    # unusual would fail here for no reason. Try it as one and
                    # let the download be the judge.
                    item_id = listing.get(ref.strip().lower(), "") or ref
                try:
                    name, raw = await _mt.drive_download(item_id)
                except Exception as exc:
                    failed.append(
                        f"{ref} (no such file in the folder)"
                        if item_id == ref and not _looks_like_drive_id(ref)
                        else f"{ref} ({type(exc).__name__})"
                    )
                    continue
                handle = _file_registrar(name, raw) if _file_registrar else None
                print(
                    f"[agent] drive_fetch: {name} ({len(raw):,} bytes) → "
                    + (handle if handle else
                       "NOT REGISTERED" + ("" if _file_registrar else " (no registrar wired)")),
                    flush=True,
                )
                if handle:
                    # The shape travels with the handle, so the first line of
                    # code is written against an observed file rather than an
                    # assumed one.
                    shape = _file_describer(name, raw) if _file_describer else ""
                    fetched.append((name, len(raw), handle, shape))
                else:
                    failed.append(
                        f"{name} ({len(raw):,} bytes — past the size the platform holds)"
                    )

            if fetched:
                lines = "\n\n".join(
                    f"- {n} ({size:,} bytes) → {h}" + (f"\n{shape}" if shape else "")
                    for n, size, h, shape in fetched
                )
                # Names, because the sandbox now takes those too, and a name is
                # the thing the model will already have written into its code.
                result_text = (
                    f"Fetched {len(fetched)} file(s):\n{lines}\n\n"
                    "Open them in the sandbox by name — read "
                    f"/tmp/input/{fetched[0][0]} in your code and pass the same "
                    "names in input_files. Do not try to read them here."
                )
            else:
                result_text = "Fetched nothing."
            if failed:
                result_text += "\n\nCould not fetch: " + "; ".join(failed)
            state.actions_taken.append(
                "Fetched " + ", ".join(n for n, _, _, _ in fetched) if fetched
                else "Fetched no files"
            )

        elif action_type == "drive_upload" and _mt:
            filename = params.get("filename", "output.xlsx")
            content = _resolve_upload_content(params.get("content_base64", ""), filename)
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
            # Emails are handled by the adapter, not here — the actual send (or
            # refusal) happens once this iteration finalises.
            #
            # The wording matters. This used to read "Email action noted — will be
            # sent after this iteration", which is success-shaped and says nothing
            # about stopping. Seeing it, the model concluded the send was under way,
            # noticed the task was still incomplete, and emitted the same action
            # again. Observed on 2026-08-07 asking for mail to an address outside
            # the organisation: five identical send_email emissions, no verdict
            # after any of them, and the run ending in "I worked on this but ran
            # out of steps before I could finish."
            #
            # The loop is the bug, not the boundary. The platform decides whether
            # this recipient is permitted, and it cannot decide until the iteration
            # ends — so the honest observation is that the outcome is not known yet
            # and repeating the action cannot make it known.
            result_text = (
                "Email action recorded. The platform will send it after this "
                "iteration, or refuse it if the recipient is outside the "
                "organisation, and will tell the requester either way. The outcome "
                "is not available to you now and emitting this action again will "
                "not produce one — finish the task instead."
            )
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
    """After executing an action, decide whether to continue reasoning or finalize.

    Reads only, like route_after_reasoning. The flag is cleared in finalize, which
    is a node and therefore actually persists the change — clearing it here looked
    right and did nothing, since a conditional edge contributes only its return
    value.
    """
    # A blocked action was approved and has now executed. Compose the reply, then
    # stop — going back to reason_and_act would re-execute the write.
    #
    # This used to route to finalize, with a comment saying finalize would compose
    # the reply. It does not: finalize only packages analysis["final_response"],
    # and the analysis still in state is the pre-interrupt one that decided the
    # write, which carries no reply text. So the run ended silent, and the
    # empty-text fallback fired and told the requester the agent had run out of
    # steps. Measured on 2026-08-10: 2 of 12 iterations used, the workbook
    # correctly uploaded, and the buyer told it had not finished.
    #
    # wrap_up is the node that actually composes — one reasoning pass with
    # _wrapping_up set, then a fixed edge to finalize, so it cannot loop back into
    # the write.
    if state.context.get("_approved_action_executing"):
        print("[agent] Approved action executed — composing the reply", flush=True)
        return "wrap_up"
    return "reason_and_act"


def _render_headline_conflicts(conflicts: list, limit: int = 3) -> str:
    """What the reply led with, and what the summary sheet holds instead."""
    parts = []
    for c in conflicts[:limit]:
        holds = ", ".join(c.get("summary_holds", [])) or "nothing readable"
        parts.append(
            f"you call {c.get('claimed')} the {c.get('word')}, and the summary "
            f"sheet holds {holds}"
        )
    more = len(conflicts) - limit
    return "; ".join(parts) + (f" (and {more} more)" if more > 0 else "")


def _render_ranking_conflicts(conflicts: list, limit: int = 4) -> str:
    """The disagreement in one sentence, however many columns it spans.

    A claim that names a row rather than a figure is checked against every
    column the row loses in, because nothing in the file says which column the
    claim was about. Rendering those one per clause repeats "you call 2026-03
    the best" three times; the subject is said once and the columns listed after
    it, which is also the shape of the answer being asked for.
    """
    subject = conflicts[0].get("subject") if conflicts else None
    if subject and all(c.get("subject") == subject for c in conflicts):
        beats = ", ".join(
            f"{c.get('beaten_by')} in {c.get('column') or 'another column'}"
            + (f" ({c.get('row')})" if c.get("row") else "")
            for c in conflicts[:limit]
        )
        mine = ", ".join(str(c.get("value")) for c in conflicts[:limit])
        return (
            f"you call {subject} the {conflicts[0].get('word')}, and the file has "
            f"{beats} — against its own {mine}"
        )
    return "; ".join(
        f"you call {c.get('value')} the {c.get('word')}, but "
        f"{c.get('column') or 'the same column'} also holds {c.get('beaten_by')}"
        + (f" ({c.get('row')})" if c.get("row") else "")
        for c in conflicts[:limit]
    )


async def verify_deliverables(state: AgentState) -> AgentState:
    """Compare the reply about to be sent against the files it describes.

    The failure this exists for is not the agent running out of room — it is the
    agent believing it has finished. On 2026-08-10 a run wrote a summary quoting
    seven figures, uploaded a workbook containing three, and stopped, having used
    2 of 12 iterations. Nothing was hard about finishing; it never looked.

    So the platform looks, and hands back the specific figures rather than a
    verdict. "Your file is missing 152.94 and 16.50%" is actionable in one step;
    "your file is incomplete" invites the model to disagree.
    """
    # Both cleared on entry. They are answers about the run as it stands now,
    # and a stale list here is a router that keeps sending the agent back to fix
    # something it has already fixed.
    state.deliverable_gaps = []
    state.rebuilt_figures = []
    state.rebuild_unfixable = False
    state.ranking_conflicts = []
    state.ranking_unfixable = False
    state.headline_conflicts = []
    state.headline_unfixable = False

    # Checked before the file check, and against the results rather than the
    # reply, because this is an error in the work itself and not in the write-up.
    # The rounded figure it was rebuilt from is usually only in the sandbox
    # output and the workbook, so by the time it reaches a summary it has often
    # been rounded again and looks perfectly ordinary.
    # Detection is not gated on the hand-back budget. Whether the arithmetic
    # drifted and whether there is room to send the agent back are different
    # questions, and a channel that cannot afford a rebuild — a chat, where
    # someone is watching — still needs to be told the figure is wrong.
    if state.content:
        produced = "\n".join(
            r for r in state.action_results[-4:]
            if isinstance(r, str) and not r.startswith(_INTERNAL_PREFIXES)
        )
        rebuilt = _rebuilt_figures(produced, state.content)
        if rebuilt and state.rebuild_attempts >= state.max_verify_attempts:
            state.rebuilt_figures = list(rebuilt)
            state.rebuild_unfixable = True
            print(
                f"[agent] Rebuilt-figure check: {len(rebuilt)} figure(s) derived "
                "from rounded values, and no attempts left — delivering with a note",
                flush=True,
            )
        elif rebuilt:
            state.rebuilt_figures = list(rebuilt)
            state.rebuild_attempts += 1
            pairs = "; ".join(f"{got} should be {want}" for got, want in rebuilt[:6])
            print(
                f"[agent] Rebuilt-figure check: {len(rebuilt)} figure(s) derived from "
                f"rounded values ({pairs}) — handing back "
                f"(attempt {state.rebuild_attempts}/{state.max_verify_attempts})",
                flush=True,
            )
            state.context.pop("_wrapping_up", None)
            state.action_results.append(
                "ROUNDED-INPUT CHECK — the platform compared the figures you "
                f"produced against the ones in the request. These do not match: {pairs}.\n"
                "You recovered a value by dividing by a figure that had already "
                "been rounded, which cannot return the number it came from. The "
                "exact values are in the request itself — use those, recompute "
                "from them, and write the corrected file. This is measured "
                "arithmetic drift, not a style note."
            )
            return state

    analysis = state.analysis if isinstance(state.analysis, dict) else {}
    final = analysis.get("final_response") or {}
    text = (final.get("text") or "").strip() if isinstance(final, dict) else ""
    if not text:
        return state  # nothing asserted yet; finalize's own fallback covers this

    # First of the three, because it is the one that changes what the reply is
    # *about*. A missing figure is a gap and a wrong ranking is a wrong sentence;
    # a headline the summary sheet contradicts means the reader is being handed
    # the wrong answer, with the right one sitting in the attachment.
    if _headline_verifier is not None:
        try:
            conflicts = await _headline_verifier(text)
        except Exception as e:
            print(f"[agent] Headline check failed to run ({e}) — sending as-is", flush=True)
            conflicts = []
        if conflicts:
            state.headline_conflicts = list(conflicts)
            if state.headline_attempts >= state.max_verify_attempts:
                state.headline_unfixable = True
                print(
                    f"[agent] Headline check: {len(conflicts)} claim(s) the summary "
                    "sheet disagrees with, and no attempts left — delivering with a note",
                    flush=True,
                )
            else:
                state.headline_attempts += 1
                pairs = _render_headline_conflicts(conflicts)
                print(
                    f"[agent] Headline check: handing back {len(conflicts)} claim(s) "
                    f"(attempt {state.headline_attempts}/{state.max_verify_attempts})",
                    flush=True,
                )
                state.context.pop("_wrapping_up", None)
                state.action_results.append(
                    "HEADLINE CHECK — the workbook you are about to attach has a "
                    f"summary sheet, and your reply leads with a figure it does not "
                    f"hold: {pairs}.\n"
                    "You wrote that summary sheet. It is where you put the numbers "
                    "that answer the question, so the reply should lead from it:\n"
                    "1. If the summary sheet is right, lead with its figure and say "
                    "what it means. The number you led with may still belong in the "
                    "reply as supporting detail — it is the billing, not the fact.\n"
                    "2. If the summary sheet is wrong, fix the sheet before sending, "
                    "because that is the file the reader will open.\n"
                    "3. Check you have not dropped a row the summary accounts for. A "
                    "headline that is too small usually means one.\n"
                    "This is your own file disagreeing with your own opening line."
                )
                return state

    # Between the two: a wrong claim is worse than a missing figure and better
    # than wrong arithmetic. Checked before the gap check because it can send the
    # agent back to rewrite the sentence, and the gap check is about that same
    # sentence.
    if _ranking_verifier is not None:
        try:
            conflicts = await _ranking_verifier(text)
        except Exception as e:
            print(f"[agent] Ranking check failed to run ({e}) — sending as-is", flush=True)
            conflicts = []
        if conflicts:
            state.ranking_conflicts = list(conflicts)
            if state.ranking_attempts >= state.max_verify_attempts:
                state.ranking_unfixable = True
                print(
                    f"[agent] Ranking check: {len(conflicts)} claim(s) the file "
                    "disagrees with, and no attempts left — delivering with a note",
                    flush=True,
                )
            else:
                state.ranking_attempts += 1
                pairs = _render_ranking_conflicts(conflicts)
                print(
                    f"[agent] Ranking check: handing back {len(conflicts)} claim(s) "
                    f"(attempt {state.ranking_attempts}/{state.max_verify_attempts})",
                    flush=True,
                )
                state.context.pop("_wrapping_up", None)
                state.action_results.append(
                    "RANKING CHECK — the platform read the file you are about to "
                    f"send and compared it against the claim in your reply: {pairs}.\n"
                    "One of these is true, and you need to know which before this "
                    "goes out:\n"
                    "1. The claim is wrong. Say what the figures say instead.\n"
                    "2. You meant a narrower comparison than the column you are "
                    "quoting — a different metric, or a subset of the rows. Then say "
                    "which, in the sentence itself, so the reader can see what is "
                    "being ranked.\n"
                    "3. The comparison itself is not like-for-like — an average over "
                    "different numbers of periods ranks the youngest highest whatever "
                    "the data says. If that is what happened, rank on something every "
                    "row has.\n"
                    "This is the file's own figures disagreeing with your sentence, "
                    "not a style note."
                )
                return state

    if _deliverable_verifier is None:
        return state

    try:
        missing = await _deliverable_verifier(text)
    except Exception as e:
        # A broken check must never hold up a correct answer.
        print(f"[agent] Deliverable check failed to run ({e}) — sending as-is", flush=True)
        return state

    if not missing:
        return state

    state.deliverable_gaps = list(missing)

    if state.verify_attempts >= state.max_verify_attempts:
        print(
            f"[agent] Deliverable check: still missing {missing} after "
            f"{state.verify_attempts} attempts — sending with a note",
            flush=True,
        )
        state.deliverable_unfixable = True
        return state

    state.verify_attempts += 1

    # wrap_up sets this so route_after_reasoning knows the closing reply is
    # written and nothing follows it. Handing back without clearing it sends the
    # agent to reason_and_act, which reads the flag and returns here immediately
    # — a loop that burns both attempts without the file ever being touched.
    # Clearing it is what makes the hand-back an acting pass rather than a
    # formality, and it matters most here: the approved-upload path is exactly
    # where a summary and a file diverge.
    state.context.pop("_wrapping_up", None)

    figures = ", ".join(missing[:8])
    # Deliberately NOT appended to actions_taken. finalize's fallback prints that
    # list to the requester, and on 2026-08-10 a buyer was emailed
    # "- Deliverable check: 2 figure(s) missing from the file" — an internal
    # diagnostic, in the reply, describing a gap they had no way to act on.
    # action_results is the model-facing channel; actions_taken is buyer-facing.
    # This used to say the file had to carry everything the reply claimed, and to
    # rebuild it. That presumes the reply is right, which is the assumption worth
    # doubting: the file is what the code computed, the reply is those numbers
    # typed out a second time. On 2026-08-11 a run reported three slopes that
    # were all wrong over a workbook whose three slopes were all right, and spent
    # both attempts rebuilding the correct file while never re-reading its own
    # sentence. So the disagreement is now put neutrally, with the diagnosis
    # asked for first and the file named as the more trustworthy side.
    state.action_results.append(
        "DELIVERABLE CHECK — the platform read the file you produced and compared "
        f"it against the reply you wrote. These figures appear in your reply but "
        f"not in the file: {figures}.\n"
        "Work out which of these is true before you do anything else:\n"
        "1. The reply is wrong. You wrote the numbers out from memory instead of "
        "from what the code printed, and they drifted. The file is what the code "
        "actually computed, so it is the one to trust — re-read the run's output "
        "and correct the reply to match it. Do not rebuild a file that is "
        "already right.\n"
        "2. The file really is missing something it should contain. Then rebuild "
        "it — write it to /tmp/output/ again and upload the new file_id.\n"
        "Check the numbers before choosing. This is a real gap the platform "
        "measured, not a suggestion."
    )
    print(
        f"[agent] Deliverable check: handing back {len(missing)} missing figure(s) "
        f"(attempt {state.verify_attempts}/{state.max_verify_attempts})",
        flush=True,
    )
    return state


def route_after_verify(state: AgentState) -> str:
    """Send the agent back to fix its file, if it has anything left to fix it with.

    `deliverable_unfixable` rather than a count comparison: the node leaves
    verify_attempts at the maximum both when it has just spent the last attempt
    (go back and use it) and when that attempt has already failed (give up), so
    the count alone cannot separate them.
    """
    # Arithmetic drift takes priority over a missing figure: a number that is
    # wrong is worse than a number that is absent, and correcting it changes the
    # file the other check is about to read.
    if (
        state.rebuilt_figures
        and not state.rebuild_unfixable
        and state.iteration < state.max_iterations
    ):
        return "reason_and_act"

    # Then a claim the file contradicts, for the same reason in a different
    # register: a reader acts on "2026-03 is holding up best" without ever
    # opening the workbook, so a wrong ranking travels further than a wrong cell.
    if (
        state.ranking_conflicts
        and not state.ranking_unfixable
        and state.iteration < state.max_iterations
    ):
        return "reason_and_act"

    if not state.deliverable_gaps or state.deliverable_unfixable:
        return "finalize"
    if state.iteration >= state.max_iterations:
        # Out of steps. Deliver the work and say it ran out — no reserve budget,
        # because "how many extra steps" has no principled answer.
        print("[agent] Deliverable gap found but out of steps — delivering as-is", flush=True)
        return "finalize"
    return "reason_and_act"


async def finalize(state: AgentState) -> AgentState:
    """Build the final result dict that the adapter will act on."""
    # Cleared here rather than in the router that reads it, because this is a node
    # and its writes survive.
    state.context.pop("_approved_action_executing", None)

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

    # Text with nowhere to go. _set_reply is the usual way this happens and is
    # fixed at the source, but a model can put {"action": "none", "text": "…"}
    # in final_response without wrap_up ever running, and the platform sends on
    # send_email and reply_email only — so the reply would be silently dropped.
    # Written words are never worth less than the field that describes them.
    #
    # Only "none" and an absent action, rather than everything that is not a
    # send. resolve_approval is a real action in the platform's vocabulary and
    # carries text of its own; rescuing it would turn a decision into an email.
    # _set_reply can be broader because it runs inside the closing pass, where
    # by construction there is no action left to take.
    if result_action in ("none", "", None) and result_text.strip():
        print(
            f"[agent] final_response held {len(result_text)} characters of reply "
            f"under action={result_action!r} — sending it as a reply",
            flush=True,
        )
        result_action = "reply_email"

    # Last line of defence against silence. If the agent did real work and still
    # produced no reply — the wrap-up pass above should prevent it, but a model can
    # always ignore an instruction — say so rather than returning nothing. Someone
    # is waiting on an answer, and "I got partway" beats no answer at all.
    if not result_text.strip() and state.actions_taken:
        # This used to list actions_taken — the *names* of the steps ("MCP
        # python-sandbox/execute_python"), which tell the requester nothing about
        # their question. What they asked for is in action_results: the computed
        # output. So lead with the findings and keep the step names out of it.
        #
        # Internal observations are filtered: a hand-back from the deliverable
        # check is a message to the model, not to the buyer.
        # Rendered, not pasted. These entries are sandbox envelopes — stdout,
        # stderr, returncode and a files array of handles — and sending one to a
        # buyer tells them nothing and exposes internals besides.
        findings = _buyer_readable(state.action_results)
        failure = _failure_note(state.action_results)
        steps = "\n".join(f"- {a}" for a in state.actions_taken[-6:])
        # Say what is actually known, which is only that no summary was written.
        #
        # This used to assert the agent had "run out of steps" and advise
        # narrowing the request. It never checked the step count: the condition
        # is an empty reply after real work, and the run that prompted this had
        # used two of twelve iterations and completed everything asked of it. The
        # buyer was told the work was unfinished, and advised to make a request
        # smaller that had not been too large.
        out_of_steps = state.iteration >= state.max_iterations
        if findings:
            # Findings lead, whether or not the steps ran out. This used to test
            # out_of_steps first, so a run that computed the whole answer and
            # then exhausted its budget sent the step names and threw the answer
            # away — the one case where the requester most needed what was
            # already in hand. Running out is a caveat on the results, not a
            # replacement for them.
            link = _delivered_file_line(state.action_results)
            result_text = (
                "Here are the results of the work you asked for.\n\n"
                f"{findings}"
            )
            if link:
                result_text += f"\n\n{link}"
            if out_of_steps:
                result_text += (
                    "\n\nI ran out of steps before I could write this up properly, "
                    "so it may be incomplete. Ask me again and I'll pick it up from "
                    "here."
                )
            else:
                result_text += (
                    "\n\nTell me if you'd like this summarised differently or in "
                    "another format."
                )
        elif failure:
            # Nothing to show and something to explain. Both branches below are
            # false here in a way that matters: "I ran out of steps" names the
            # budget when the budget was never the problem, and "I completed the
            # work below" is simply untrue over steps that all failed. The one
            # thing the requester can act on is what broke, and it is knowable.
            result_text = failure
        elif out_of_steps:
            result_text = (
                "I ran out of steps before I could finish, so this is partial.\n\n"
                f"What I completed:\n{steps}\n\nAsk me again and I'll pick it up from "
                "here — narrowing the request to one part will usually get it done in "
                "a single go."
            )
        else:
            # No findings to quote. Where the file went is still worth saying —
            # it is the deliverable, and the requester can open it now rather
            # than waiting for a summary they have to ask for.
            link = _delivered_file_line(state.action_results)
            result_text = (
                "I completed the work below, but did not manage to write up the "
                f"results.\n\nWhat I completed:\n{steps}"
            )
            if link:
                result_text += f"\n\n{link}"
            result_text += (
                "\n\nAsk me for the summary and I'll send it — the work itself is "
                "done, so this should be quick."
            )
        result_action = "reply_email"
        print(
            f"[agent] No final text after real work (out_of_steps={out_of_steps}) "
            "— sending a partial-progress reply",
            flush=True,
        )

    # A gap the agent could not close. Say so, at the end and after the work —
    # the requester wanted an answer, not a status report, and a caveat that
    # leads is the shape of the reply that got complained about on 2026-08-10.
    # The check establishes one fact: these figures are in the summary and not in
    # the file. It cannot tell which side is wrong, and it used to claim it could
    # — "the figures above are right, but the attached file is missing…". On
    # 2026-08-11 that sentence was published over a summary whose three slopes
    # were all wrong and a workbook whose three slopes were all right, so it
    # vouched for the bad numbers and cast doubt on the good ones.
    #
    # So: state the disagreement, name the file as the tiebreaker, and claim
    # nothing else. The file is what the code computed; the summary is the model
    # writing figures out a second time, which is the step that can drift.
    if state.deliverable_gaps and result_text.strip():
        figures = ", ".join(str(g) for g in state.deliverable_gaps[:8])
        if state.iteration >= state.max_iterations:
            why = "I ran out of steps before I could reconcile them"

        else:
            why = "I could not reconcile them"
        result_text = (
            f"{result_text.rstrip()}\n\n---\n"
            f"Worth checking before you rely on this: {figures} "
            f"{'appear' if len(state.deliverable_gaps) > 1 else 'appears'} in my "
            f"summary above but not in the file — {why}. The file is what the code "
            f"actually computed, so where the two disagree, go with the file. Ask "
            f"me and I'll redo it."
        )
        print(
            f"[agent] Delivering with a deliverable-gap note ({len(state.deliverable_gaps)} figures)",
            flush=True,
        )

    # A run that produced nothing, reported by the model in its own words. Those
    # words are reliably vaguer than the evidence: on 2026-08-13 benchmark task
    # T03 wrote "the data processing script failed to execute correctly,
    # preventing me from completing the analysis" over twelve steps whose error
    # named the exact problem — six fields in a row against a five-field header.
    # The sender can fix that in ten seconds and can do nothing at all with
    # "some technical issues".
    #
    # Keyed on the reply reporting a failure, not on the run having produced no
    # readable output. The first version asked the second question and the
    # benchmark caught it hours later: a model that catches its own parse error
    # and prints it leaves a step that exits 0 with output, so the run counted as
    # having findings and the caveat was withheld from the one reply that needed
    # it. A step that failed and was then got right stays uncaveated either way —
    # that reply reports results, not failure.
    if (
        result_text.strip()
        and _failed_steps(state.action_results)
        and _REPORTS_FAILURE_RE.search(result_text)
        and not _delivered_file_line(state.action_results)
    ):
        detail = _failure_detail(state.action_results)
        if detail and detail not in result_text:
            result_text = (
                f"{result_text.rstrip()}\n\n---\n"
                f"What stopped it, in case it is something you can see from your "
                f"side: {detail}\n\n{_failure_advice(state.action_results)}"
            )
            print(f"[agent] Delivering with the failure detail: {detail[:80]}", flush=True)

    # Point at the notebook, when there is one and the reply quotes figures.
    #
    # The platform already attaches the code that produced them — every run that
    # touches the sandbox travels with working.ipynb — and nobody opens an
    # attachment they were not told about. This is the only defence the platform
    # has against a wrong number, and it is a weak one: it does not catch the
    # error, it makes the error findable. On 2026-08-14 a run reported a fee of
    # 48 where the answer was 0.12 and every check passed it, because the prose
    # and the file agreed with each other. Both were wrong, and the derivation
    # was sitting in the notebook the whole time.
    #
    # Said by the platform rather than asked of the model, because it is a fact
    # about what was attached rather than a judgement, and the model has already
    # been asked for the assumption in words.
    if (
        result_text.strip()
        and _summary_figures_present(result_text)
        and any("python-sandbox" in str(a) for a in state.actions_taken)
        and "ipynb" not in result_text
    ):
        result_text = (
            f"{result_text.rstrip()}\n\n"
            "The working is attached as working.ipynb — every step I ran, in "
            "order, with its output. If a figure looks wrong, that file will "
            "show you where it came from."
        )

    # Measured arithmetic drift with no budget left to correct it. Said plainly
    # and first among the caveats, because a wrong figure is worse than a
    # missing one: the reader has no reason to doubt it.
    if state.rebuild_unfixable and state.rebuilt_figures and result_text.strip():
        pairs = "; ".join(f"{got} should be {want}" for got, want in state.rebuilt_figures[:6])
        result_text = (
            f"{result_text.rstrip()}\n\n---\n"
            f"Please check these before using them: {pairs}. They were worked out "
            f"from a rounded figure rather than the number you gave me, so they "
            f"are slightly off. Ask me and I'll redo it from your originals."
        )
        print(
            f"[agent] Delivering with a rounded-input note "
            f"({len(state.rebuilt_figures)} figures)",
            flush=True,
        )

    # A ranking the file disagrees with, still standing after the hand-backs.
    # Named as a disagreement rather than an error: the check reads columns, not
    # meaning, and the sentence may be about a narrower comparison than the one
    # it can see. What it can say for certain is which figures are in the file,
    # so it says that and lets the reader judge.
    if state.ranking_unfixable and state.ranking_conflicts and result_text.strip():
        c = state.ranking_conflicts[0]
        if c.get("subject"):
            # Every column it loses in, not the first — the first is often one
            # nobody ranks on, and "2026-04 is ahead in Size" alone reads as a
            # confused caveat rather than a real doubt about the ranking.
            ahead = ", ".join(
                f"{x.get('row')} in {x.get('column')}"
                for x in state.ranking_conflicts[:3] if x.get("row")
            )
            middle = (
                f"I call {c['subject']} the {c.get('word')}, and other rows in "
                f"the file are ahead of it — {ahead}"
            )
        else:
            where = f" in {c['column']}" if c.get("column") else ""
            who = f" ({c['row']})" if c.get("row") else ""
            middle = (
                f"I call {c.get('value')} the {c.get('word')}, and the file also "
                f"holds {c.get('beaten_by')}{who}{where}"
            )
        result_text = (
            f"{result_text.rstrip()}\n\n---\n"
            f"One thing to check before you rely on the ranking above: {middle}. "
            "Either I am ranking on something narrower than those figures or the "
            "ranking is wrong — I could not settle it, so please look at the file "
            "before quoting the comparison."
        )
        print(
            f"[agent] Delivering with a ranking note "
            f"({len(state.ranking_conflicts)} claim(s))",
            flush=True,
        )

    # ── The headline the summary sheet disagreed with, and nobody fixed ──────
    #
    # Detecting the conflict is not the same as resolving it. On 2026-08-17 the
    # check fired correctly on a re-run of D01 — the reply claimed totals of
    # 148,850 and 146,800 where the workbook's own Summary sheet held 155,300,
    # 151,450 and 3,850 — and the hand-back did nothing, because the run had
    # already printed "out of steps after 12 action(s)". The conflict was found,
    # the correction was requested, there was no budget left to make it, and the
    # wrong draft went to the approval queue looking exactly like a right one.
    #
    # So the last resort is the same one the ranking check uses: say it in the
    # message. The approval portal shows the complete draft, so this puts the
    # disagreement in front of the person deciding whether to send it. It also
    # survives a buyer whose policy is "never ask", where there is no portal and
    # no other place a warning could go.
    #
    # The condition is the conflict list itself rather than a spent-attempts
    # flag: wrap_up clears it on entry and re-checks, so anything still here at
    # finalize was never resolved, whichever budget ran out first.
    if state.headline_conflicts and result_text.strip():
        c = state.headline_conflicts[0]
        holds = ", ".join(c.get("summary_holds", [])) or "different figures"
        result_text = (
            f"{result_text.rstrip()}\n\n---\n"
            f"Before you rely on the figure above: I lead with {c.get('claimed')} "
            f"as the {c.get('word')}, and the Summary sheet of the workbook I am "
            f"attaching holds {holds}. Those disagree and I could not settle which "
            "is right, so please open the workbook before quoting the number in "
            "this message."
        )
        print(
            f"[agent] Delivering with a headline note "
            f"({len(state.headline_conflicts)} claim(s))",
            flush=True,
        )

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

    # A run that did nothing has learned nothing worth telling other agents.
    #
    # This is where the compounding started. Told by an earlier lesson not to
    # attempt something, the agent would decline, act on nothing, and then record
    # a fresh lesson about a refusal that never happened — which the next run read
    # as evidence. Seven near-identical "do not attempt" lessons accumulated that
    # way in two days, and between them they taught the agent to refuse emailing
    # its own manager, an address the platform would have allowed.
    #
    # Lessons should come from doing. The platform holds these for review as well
    # (flagReason "unfounded"), but not writing them is better than reviewing them.
    if not state.actions_taken:
        print(
            "[agentmind] Not contributing: this run took no action, so the lesson "
            "would describe something the agent never actually tried",
            flush=True,
        )
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
    graph.add_node("wrap_up", wrap_up)
    graph.add_node("verify_deliverables", verify_deliverables)
    graph.add_node("finalize", finalize)
    graph.add_node("maybe_contribute", maybe_contribute)

    graph.set_entry_point("enrich_context")
    graph.add_edge("enrich_context", "search_commons")
    graph.add_edge("search_commons", "reason_and_act")
    graph.add_conditional_edges("reason_and_act", route_after_reasoning)
    # After executing an action, either finalize (if it was an approved blocked action)
    # or loop back to reasoning for the next step.
    graph.add_conditional_edges("execute_action", route_after_execution)
    # Every route to finalize passes through the deliverable check first, so a
    # reply cannot describe a file the file does not contain.
    #
    # This used to be a fixed wrap_up → finalize edge, so the closing pass could
    # not loop back into a write it had just executed. The check can now send it
    # back, which is the point — but it is bounded by max_verify_attempts, and it
    # only fires on a gap the platform measured in the file itself, so it cannot
    # become the open-ended loop the fixed edge was guarding against.
    graph.add_edge("wrap_up", "verify_deliverables")
    graph.add_conditional_edges("verify_deliverables", route_after_verify)
    graph.add_edge("finalize", "maybe_contribute")
    graph.add_edge("maybe_contribute", END)

    return graph


# ─── Public API ──────────────────────────────────────────────────────────────

# ─── Tool result formatting ──────────────────────────────────────────────────

# How much of a tool result the model is shown. Results accumulate across
# iterations, so this is a real budget rather than an arbitrary number: a handful
# of steps at this size stays well within the context window.
RESULT_CHAR_LIMIT = 4000


# ─── Rendering results for the person who asked ──────────────────────────────
#
# Two paths send a reply the model did not write: wrap_up, when it stays silent,
# and finalize's fallback behind it. Both pasted action_results into the mail
# verbatim. For an mcp_call that entry is json.dumps of the entire sandbox
# envelope, which on this deployment reads:
#
#   {"stdout": "[{\"Region\":\"North\",\"Total Revenue (Q3)\":146050, ...}]\n",
#    "stderr": "", "returncode": 0,
#    "files": [{"name": "...xlsx", "file_id": "sandbox:270a9673d7b4",
#               "size_bytes": 5478, "note": "Pass this file_id as ..."}]}
#
# On 2026-08-10 a buyer who asked for Q3 revenue by region was sent that, twice
# in one message and undeduplicated, with the figures they wanted present only
# as backslash-escaped JSON inside it. The note is addressed to the model, the
# file_id is a handle to a process that has since exited, and returncode and
# stderr describe machinery the buyer is not operating.
#
# Everything the request asked for is in stdout, and the agent prints it there
# as JSON records. So parse those and lay them out as a table. The rest of the
# envelope is internal and is never emitted.

# Keys are taken exactly as the sandbox prints them. They arrive already
# readable — "Total Revenue (Q3)", "QoQ Growth (%)" — and an earlier draft that
# title-cased them turned the second into "Qoq Growth (%)". The code that wrote
# the header is not better at naming the column than the code that computed it.

# Envelope fields that must never reach a buyer, checked as a last line of
# defence over anything about to be sent.
_INTERNAL_MARKERS = ("file_id", "sandbox:", '"note"', '"stderr"', '"returncode"', "size_bytes")

# Results that are the run talking to itself. execute_action records failures,
# approval outcomes and its own dispatch notes in the same list as findings, so
# a composed reply quoted them to the buyer as though they were the answer. On
# 2026-08-10 one carried a raw Graph 400 — endpoint, query string and the
# internal message id — and another read "Manager decision: APPROVED —
# Approved — proceed as planned."
#
# A prefix list rather than dropping all prose, because some plain results are
# genuinely the answer: the text of a file the agent was asked to read, or the
# confirmation of an event it created.
_INTERNAL_PREFIXES = (
    "STEP FAILED",
    "Error:",
    "ERROR",
    "Manager decision:",
    "Action '",
    "Email action recorded",
    "Unknown action type",
    "Deleted item",
    # Every platform hand-back. These are addressed to the model in the second
    # person — "the platform read the file you produced" — so one reaching a
    # buyer reads as the agent talking to itself in front of them. Only
    # DELIVERABLE CHECK was listed; the other two rendered straight through on
    # the partial-progress path, which is the same mistake as the 2026-08-10
    # reply that carried "- Deliverable check: 2 figure(s) missing from the
    # file". A new check must be added here on the day it is written.
    "DELIVERABLE CHECK",
    "ROUNDED-INPUT CHECK",
    "RANKING CHECK",
    "HEADLINE CHECK",
)

_URL_IN_TEXT = re.compile(r"https?://[^\s<>\"')\]]+")

# The sandbox's scratch directory. A run that prints "Excel file created at
# /tmp/output/q3.xlsx" is narrating a filesystem the buyer has no access to and
# that ceases to exist when the run ends — and where the file actually went is
# stated separately, as a SharePoint link. Observed live on 2026-08-10: this was
# the entire printed output of a run, so it was the entire fallback reply.
_SANDBOX_PATH = re.compile(r"/tmp/(?:output|input)\b\S*")

# Pulls stdout out of an envelope that json.loads cannot take. Results are cut
# to 2000 characters before they are stored, so any run printing more than that
# leaves invalid JSON behind — the common case for a large table, and precisely
# when the buyer most needs it rendered rather than dumped.
_STDOUT_FIELD = re.compile(r'"stdout"\s*:\s*"((?:[^"\\]|\\.)*)')


def _unescape(fragment: str) -> str:
    """Decode a JSON string body that may have been truncated mid-value."""
    try:
        return json.loads(f'"{fragment}"')
    except ValueError:
        # Truncation can sever a trailing escape. Drop it and decode the rest by
        # hand rather than losing the whole payload to one broken character.
        cleaned = fragment.rstrip("\\")
        for esc, real in (("\\n", "\n"), ("\\t", "\t"), ("\\r", "\r"),
                          ('\\"', '"'), ("\\/", "/"), ("\\\\", "\\")):
            cleaned = cleaned.replace(esc, real)
        return cleaned


def _json_values(text: str) -> list:
    """Every complete JSON array or object embedded in `text`, in order."""
    found: list = []
    i, n = 0, len(text)
    while i < n:
        if text[i] not in "[{":
            i += 1
            continue
        depth, in_str, esc, j = 0, False, False, i
        while j < n:
            c = text[j]
            if in_str:
                if esc:
                    esc = False
                elif c == "\\":
                    esc = True
                elif c == '"':
                    in_str = False
            elif c == '"':
                in_str = True
            elif c in "[{":
                depth += 1
            elif c in "]}":
                depth -= 1
                if depth == 0:
                    break
            j += 1
        if j < n and depth == 0:
            try:
                found.append(json.loads(text[i:j + 1]))
            except ValueError:
                pass
            i = j + 1
        else:
            i += 1  # unbalanced — a truncated tail, nothing to salvage here
    return found


def _as_records(value: Any) -> list[dict]:
    """`value` as a list of row dicts, or [] if it is not tabular."""
    if isinstance(value, list) and value and all(isinstance(v, dict) for v in value):
        return value
    if isinstance(value, dict) and value and all(isinstance(v, dict) for v in value.values()):
        # {"North": {...}, "South": {...}} — the outer key is the row label.
        return [{"Item": k, **v} for k, v in value.items()]
    # A grid: the shape excel_read returns, as a header row followed by data
    # rows. Sheets are read by range rather than by extent, so most of those
    # rows and columns are empty padding — A1:Z100 of a four-row table is 96
    # blank rows, and on 2026-08-10 all of them were sent to a buyer.
    if isinstance(value, list) and len(value) >= 2 and all(isinstance(v, list) for v in value):
        grid = [[("" if c is None else str(c)).strip() for c in row] for row in value]
        width = max(len(r) for r in grid)
        grid = [r + [""] * (width - len(r)) for r in grid]
        keep = [i for i in range(width) if any(r[i] for r in grid)]
        grid = [[r[i] for i in keep] for r in grid]
        grid = [r for r in grid if any(r)]
        if len(grid) >= 2 and grid[0] and all(grid[0]):
            headers = grid[0]
            return [dict(zip(headers, row)) for row in grid[1:]]
    return []


def _cell(value: Any) -> str:
    """One value as the buyer should read it.

    Rounded to two decimals because that is what the figures are: money and
    percentages. 154.8780487805 is the division, not the answer.

    Numeric *strings* are rounded too. Everything read back out of a sheet
    arrives as text, so keying on the Python type alone let a whole table
    through unformatted — a buyer was sent 942.9881198347 units on
    2026-08-10, in the same message as a correctly rounded one.

    Values below 1 are left exactly as they are. Those are ratios and rates,
    where two decimals is not rounding but discarding: 0.1031 would become
    0.10 and a 10.31% growth figure would lose its point.
    """
    if value is None:
        return ""
    if isinstance(value, bool):
        return "yes" if value else "no"
    if isinstance(value, str):
        raw = value.strip()
        if not re.fullmatch(r"-?\d[\d,]*(?:\.\d+)?", raw or "x"):
            return value
        try:
            value = Decimal(raw.replace(",", ""))
        except InvalidOperation:
            return value
    if isinstance(value, (int, float, Decimal)):
        try:
            d = Decimal(str(value))
        except (InvalidOperation, ValueError):
            return str(value)
        if d == d.to_integral_value():
            return f"{d.quantize(Decimal(1)):,}"
        if abs(d) < 1:
            return str(d)
        return f"{d.quantize(Decimal('0.01'), rounding=ROUND_HALF_UP):,}"
    return str(value)


def _markdown_table(records: list[dict]) -> str:
    """Records as a markdown table.

    Markdown because the mail is rendered with the tables extension before it is
    sent, so this arrives as a real table in the buyer's client and still reads
    as one for anything that shows the plain text.
    """
    columns: list[str] = []
    for row in records:
        for key in row:
            if key not in columns:
                columns.append(str(key))
    if not columns:
        return ""

    header = "| " + " | ".join(columns) + " |"
    rule = "| " + " | ".join("---" for _ in columns) + " |"
    body = [
        "| " + " | ".join(_cell(row.get(c)) for c in columns) + " |"
        for row in records
    ]
    return "\n".join([header, rule, *body])


def _render_result(raw: str) -> str:
    """One action result as buyer-facing text, or "" if it holds nothing for them."""
    if not isinstance(raw, str) or not raw.strip():
        return ""
    text = raw.strip()

    # Hand-backs, failures and approval bookkeeping are the run talking to
    # itself, not to the requester.
    if text.startswith(_INTERNAL_PREFIXES):
        return ""

    # Where the file went is delivery, not findings. _delivered_file_line renders
    # it once, at the end, as a sentence. Letting it through here as well is what
    # put the SharePoint URL in the reply twice.
    if text.startswith(("Uploaded ", "SUCCESS: Wrote", "Appended ")):
        return ""

    # A sandbox envelope: everything worth sending is in stdout.
    stdout, complete = None, True
    if text.startswith("{"):
        parsed = None
        try:
            parsed = json.loads(text)
        except ValueError:
            parsed = None
        if isinstance(parsed, dict) and (
            "stdout" in parsed or "returncode" in parsed or "files" in parsed
        ):
            # A step that exited non-zero printed whatever it printed before it
            # fell over. Those are not findings and must not become a table.
            if parsed.get("returncode") not in (0, None):
                return ""
            stdout = str(parsed.get("stdout") or "")
        elif parsed is None:
            m = _STDOUT_FIELD.search(text)
            if m:
                stdout, complete = _unescape(m.group(1)), False

    if stdout is not None:
        return _render_stdout(stdout, complete=complete)

    # A tool result that is itself JSON — excel_read's grid, drive_list's file
    # array, excel_list_sheets' ["Sheet1"]. Render it if it is tabular, and
    # otherwise say nothing.
    #
    # Falling through to "send the text" here was the original bug wearing a
    # different hat. On 2026-08-10 the composed reply opened with a bare
    # ["Q3 Revenue Analysis"] and fifty rows of ["", "", "", ...] before it
    # reached the table the buyer had asked for. JSON is not prose, and a
    # requester who wanted revenue by region has no use for either.
    if text.startswith(("[", "{")):
        for value in _json_values(text):
            records = _as_records(value)
            if records:
                table = _markdown_table(records)
                if table:
                    return table
        return ""

    # Not an envelope, and written for a person already — but only forwarded once
    # it is clear it carries no machinery.
    if any(marker in text for marker in _INTERNAL_MARKERS):
        return ""
    return text


def _render_stdout(stdout: str, *, complete: bool = True) -> str:
    """Printed output as a table where it is tabular, and as prose where it is not."""
    stdout = (stdout or "").strip()
    if not stdout:
        return ""

    # Rows arrive two ways: as one JSON array, and — when the result was cut at
    # 2000 characters and the array lost its closing bracket — as the individual
    # objects that survived inside it. Salvaging those is the difference between
    # a short table and a wall of raw JSON, and truncation is exactly the case
    # where the output was big enough to need a table.
    values = _json_values(stdout)
    groups: list[list[dict]] = []
    loose: list[dict] = []
    consumed: list = []
    for value in values:
        records = _as_records(value)
        if records:
            if loose:
                groups.append(loose)
                loose = []
            groups.append(records)
            consumed.append(value)
        elif isinstance(value, dict) and value and not any(
            isinstance(v, (dict, list)) for v in value.values()
        ):
            loose.append(value)
            consumed.append(value)
    if loose:
        groups.append(loose)

    tables = [t for t in (_markdown_table(g) for g in groups) if t]
    if not tables:
        # Nothing tabular — the print statements themselves are the finding,
        # minus any line that only reports where a file was written inside the
        # sandbox. That is bookkeeping about a directory the buyer cannot reach.
        if any(m in stdout for m in _INTERNAL_MARKERS):
            return ""
        return "\n".join(
            line for line in stdout.splitlines()
            if line.strip() and not _SANDBOX_PATH.search(line)
        ).strip()

    # Prose printed alongside the records is kept, minus the records themselves.
    leftover = stdout
    for value in consumed:
        leftover = leftover.replace(json.dumps(value, separators=(",", ":")), " ")
    commentary = "\n".join(
        line.strip() for line in leftover.splitlines()
        if line.strip() and not line.strip().lstrip(",").startswith(("[", "{"))
    ).strip()

    parts = [p for p in (commentary, *tables) if p]
    if not complete:
        # Say so. A table that silently lost its last rows is the failure this
        # codebase already knows by name: confident, wrong, and invisible.
        parts.append(
            "_(The analysis output was longer than I can quote in full, so this "
            "table may be missing its last rows — the file has all of them.)_"
        )
    return "\n\n".join(parts)


# ─── Figures rebuilt from rounded ones ───────────────────────────────────────
#
# Asked to add a units column, a run on 2026-08-10 read the per-unit figure back
# out of the spreadsheet it had just written — 154.88, rounded for display — and
# divided revenue by it:
#
#   146050 / 154.88 = 942.9881198347     the requester had written 943
#
# It did this for all three regions, and the numbers went into the workbook and
# the reply. Nothing caught it. The deliverable check compares the reply against
# the file, and both agreed: they were wrong together.
#
# The requester's own email held the exact figure. Inverting a rounded value can
# never recover the input it came from, and there is no reason to try when the
# input is in the request — so the platform measures the drift and hands it back.
#
# The test is deliberately narrow, because a false accusation costs an
# iteration: the value given must be whole, the value produced must carry three
# or more decimals, and the two must agree to within a tenth of a percent. A
# genuinely derived statistic does not land that close to a figure it was never
# computed from. Checked against the run above, it catches all three and leaves
# 154.88, 10.31 and 0.1031 alone.
_RECONSTRUCTION_TOLERANCE = Decimal("0.001")


def _decimal_places(raw: str) -> int:
    return len(raw.split(".")[1]) if "." in raw else 0


def _rebuilt_figures(produced: str, given: str) -> list[tuple[str, str]]:
    """(produced, should-have-been) for figures rebuilt from a rounded value."""
    givens = [
        (raw, val) for raw, val in _summary_figures_local(given)
        if _decimal_places(raw) == 0
    ]
    if not givens:
        return []

    out: list[tuple[str, str]] = []
    seen: set[str] = set()
    for raw, val in _summary_figures_local(produced):
        if _decimal_places(raw) < 3 or raw in seen:
            continue
        for g_raw, g_val in givens:
            if val == g_val or not g_val:
                continue
            if abs(val - g_val) / abs(g_val) < _RECONSTRUCTION_TOLERANCE:
                out.append((raw, g_raw))
                seen.add(raw)
                break
    return out


def _summary_figures_local(text: str) -> list[tuple[str, Decimal]]:
    """Numbers in `text`, ignoring URLs — the agent-side twin of the platform's."""
    out: list[tuple[str, Decimal]] = []
    for m in re.finditer(r"-?\d[\d,]*(?:\.\d+)?", _URL_IN_TEXT.sub(" ", text or "")):
        raw = m.group(0).rstrip(".,")
        try:
            out.append((raw, Decimal(raw.replace(",", ""))))
        except InvalidOperation:
            continue
    return out


def _table_columns(block: str) -> frozenset[str] | None:
    """The column names of a rendered table, or None if it is not one."""
    first = block.split("\n", 1)[0]
    if not first.startswith("|"):
        return None
    return frozenset(c.strip() for c in first.strip("|").split("|") if c.strip())


# A webUrl column means this table is a directory listing — what drive_list and
# drive_search return while the agent is finding its way to the data. It is
# navigation, and it carries raw Drive item IDs. The buyer asked what the
# numbers are, not which files the agent opened on the way to them.
_LISTING_COLUMNS = {"weburl", "id", "item_id", "driveid", "parentreference"}


def _is_listing(block: str) -> bool:
    cols = _table_columns(block)
    return cols is not None and any(c.lower() in _LISTING_COLUMNS for c in cols)


def _buyer_readable(results: list, limit: int = 3) -> str:
    """The findings in `results`, rendered for the person who asked.

    Deduplicated twice over. The agent re-runs its analysis after a hand-back,
    so an identical table is produced two and three times in a run — and it also
    reads a sheet back after writing to it, so the reply carried the same
    figures once without the new column and again with it.

    A table whose columns are contained in a later table's is that same table at
    an earlier stage, so the later one replaces it. Tables that merely differ
    are both kept: two different cuts of the data are two findings, not one
    restated.
    """
    rendered: list[str] = []
    for raw in results or []:
        block = _render_result(raw)
        if block and block not in rendered and not _is_listing(block):
            rendered.append(block)

    kept: list[str] = []
    for i, block in enumerate(rendered):
        cols = _table_columns(block)
        if cols is not None and any(
            (later := _table_columns(other)) is not None and cols < later
            for other in rendered[i + 1:]
        ):
            continue  # superseded by a fuller version of the same table
        kept.append(block)

    return "\n\n".join(kept[-limit:])


# A figure worth standing behind: a decimal, or a number large enough not to be
# a step count. "3 files" and "12 iterations" are not claims about the data.
_FIGURE_IN_TEXT = re.compile(r"\d+\.\d|\d{3,}")


def _summary_figures_present(text: str) -> bool:
    """Does this reply actually assert a number?"""
    return bool(_FIGURE_IN_TEXT.search(_URL_IN_TEXT.sub(" ", text or "")))


def _failed_steps(results: list) -> list[str]:
    """The sandbox steps that did not finish."""
    return [
        r for r in (results or [])
        if isinstance(r, str) and r.startswith("STEP FAILED")
    ]


# A step that was killed rather than raising. Nothing writes a traceback on the
# way out, so there is no Error: block to read and the run looks unexplained.
#
# Benchmark task T15 on 2026-08-13 asked for 40 million rows in one dataframe and
# was killed eight times; the reply it produced said "returning an exit status of
# -9, which indicates a technical problem with the execution environment", which
# is the exit code read aloud.
#
# Deliberately not "your data is too large". The sandbox is capped at 256 MB and
# is shared, so the memory can be gone for reasons that have nothing to do with
# the sender's file — in that same run, T16's 4,925-byte spreadsheet was killed
# by the memory the Monte Carlo next to it was holding. What is always true is
# that the step needed more memory than it could have.
_KILL_STATUSES = {
    -9: "it needed more memory than the sandbox allows, so the system stopped it",
    137: "it needed more memory than the sandbox allows, so the system stopped it",
    -15: "the system stopped it before it finished",
    143: "the system stopped it before it finished",
    -11: "it crashed rather than raising an error I can read",
    139: "it crashed rather than raising an error I can read",
}
_EXIT_STATUS_RE = re.compile(r"exited with status (-?\d+)")


def _failure_detail(results: list) -> str:
    """The one line of a failed run worth quoting, or "".

    A STEP FAILED entry carries up to 1200 characters of stderr written for the
    model — frames through site-packages, the code that raised, an instruction
    to try again. The last unindented line of a traceback is the exception, and
    it is the only part that means anything to the person who sent the data:
    "Expected 5 fields in line 5, saw 6" tells them their table has a ragged
    row. The frames tell them nothing.

    A killed step has no traceback at all, so it is named by its status instead.
    """
    failures = _failed_steps(results)
    if not failures:
        return ""

    status = _EXIT_STATUS_RE.search(failures[-1])
    if status and int(status.group(1)) in _KILL_STATUSES:
        return _KILL_STATUSES[int(status.group(1))]

    if "Error:" not in failures[-1]:
        return ""

    block = failures[-1].split("Error:", 1)[1]
    # Stop at the next section: the partial stdout, or the instruction that
    # follows it. Both are addressed to the model.
    for marker in ("It printed this before it stopped", "Fix the code",
                   "This is the second failure"):
        block = block.split(marker, 1)[0]
    lines = [ln.rstrip() for ln in block.splitlines() if ln.strip()]
    # Unindented lines are the exception; indented ones are frames. stderr is
    # stored cut at 1200 characters, so a long traceback can end mid-frame and
    # leave no exception line at all — say nothing, rather than quoting
    # `return _read(filepath_or_buffer, kwds)` at someone who asked about
    # cohort retention.
    named = [
        ln for ln in lines
        if not ln.startswith((" ", "\t", 'File "'))
        and not ln.startswith("Traceback (most recent call last)")
    ]
    if not named:
        return ""
    return _SANDBOX_PATH.sub("a working file", named[-1].strip())[:200].strip()


# Appended to a reply the model wrote itself, when the run produced nothing else.
# Its own account of a failure is reliably vaguer than the evidence: on
# 2026-08-13 benchmark task T03 said "the data processing script failed to
# execute correctly, preventing me from completing the analysis" over an error
# naming the exact problem — a row carrying six fields against a five-field
# header. The sender can fix that in ten seconds and cannot act on "some
# technical issues" at all.
#
# The reply saying, in its own words, that it did not manage the task. Used to
# decide whether the run's own error is worth appending: under a sentence that
# reports failure it is the missing half, and under a sentence that reports
# results it is a post-mortem nobody asked for.
#
# This replaces "the run produced nothing a buyer could read", which was the
# first guard and was wrong in a way the benchmark found the same day. A model
# that catches its own parse error in a try/except and prints it has a step that
# exits 0 with output — so the run counted as having findings, and the caveat
# was held back from the one reply that needed it. T03 on 2026-08-13 said "an
# error in reading the input data" and stopped, with "Expected 5 fields in line
# 6, saw 6" sitting in the run and never sent.
_REPORTS_FAILURE_RE = re.compile(
    r"\b(could ?not|couldn't|cannot|can't|unable|not able|wasn't able|was not able|"
    r"failed|failure|did not (?:complete|finish|manage)|didn't (?:complete|finish|manage)|"
    r"interrupted|went wrong|encountered an (?:error|issue|problem))\b",
    re.IGNORECASE,
)

_WHAT_WOULD_HELP = (
    "If the data has a shape I did not expect — a ragged row, a merged header, "
    "a column that is text where I read it as numbers — telling me which, or "
    "sending the file itself, will usually be enough to get it right on the "
    "next go."
)

# The same sentence for a step that was killed. Asking about ragged rows there
# would be advice about the wrong problem: the code was fine and the size was
# not, so what helps is a smaller bite of it.
_SMALLER_SLICE = (
    "If it has to run at that size I cannot do it in one pass, but a smaller "
    "slice usually gets you the same answer — a sample, one region or one month "
    "at a time, or the aggregate rather than every row. Tell me which and I'll "
    "work it up from there."
)


def _failure_advice(results: list) -> str:
    """What would actually get this sender a result next time."""
    failures = _failed_steps(results)
    status = _EXIT_STATUS_RE.search(failures[-1]) if failures else None
    if status and int(status.group(1)) in _KILL_STATUSES:
        return _SMALLER_SLICE
    return _WHAT_WOULD_HELP


def _failure_note(results: list) -> str:
    """What stopped the run, in the requester's terms, or "" if nothing did.

    `_buyer_readable` renders findings and drops everything prefixed as
    internal, which is right for a run that produced something and wrong for a
    run that produced nothing: the buyer is left with either silence or a
    cheerful "I completed the work below" over three steps that all failed.

    So the failures get their own rendering, built on the one line of
    `_failure_detail` rather than the stored text.

    Covers failures of the sandbox steps. A tool error records itself under
    other prefixes and is not read here — the buyer is told what broke, not
    everything that went wrong.
    """
    failures = _failed_steps(results)
    if not failures:
        return ""

    tried = (
        "I tried to run the analysis and it failed."
        if len(failures) == 1 else
        f"I tried to run the analysis {len(failures)} times and it failed every time."
    )
    detail = _failure_detail(results)
    # "What went wrong" rather than "the error was", because a killed step has
    # no error to quote and the sentence has to carry both.
    note = f"{tried}\n\n" + (f"What went wrong:\n{detail}\n\n" if detail else "")
    return note + (
        "Nothing was produced, so there are no figures in this message and no "
        f"file attached to it. {_failure_advice(results)}"
    )


def _delivered_file_line(results: list) -> str:
    """A one-line pointer to the file that was actually delivered, if there is one."""
    for raw in reversed([r for r in (results or []) if isinstance(r, str)]):
        if not raw.startswith(("Uploaded ", "SUCCESS: Wrote")):
            continue
        match = _URL_IN_TEXT.search(raw)
        if not match:
            continue
        where = "OneDrive" if "OneDrive" in raw else "SharePoint"
        name = ""
        if raw.startswith("Uploaded ") and " to " in raw:
            name = raw[len("Uploaded "):raw.index(" to ")].strip()
        subject = f"The file ({name})" if name else "The file"
        return f"{subject} is on {where}: {match.group(0)}"

    # A share link created in its own step, rather than the upload's own URL.
    for raw in reversed([r for r in (results or []) if isinstance(r, str)]):
        if not raw.startswith("{"):
            continue
        try:
            obj = json.loads(raw)
        except ValueError:
            continue
        if isinstance(obj, dict) and obj.get("link"):
            return f"Shareable link: {obj['link']}"
    return ""


def _compose_reply(state: "AgentState") -> str:
    """A reply built from the results, for when the model will not write one."""
    body = _buyer_readable(state.action_results)
    link = _delivered_file_line(state.action_results)
    if not body and not link:
        return ""

    if body:
        parts = ["Here are the results you asked for.", "", body]
        if link:
            parts += ["", link]
        parts += [
            "",
            "Tell me if you'd like this broken down differently, or any of it "
            "expanded on.",
        ]
    else:
        # The work produced a file but printed nothing quotable. Point at the
        # file rather than inventing a summary of it — and say plainly that the
        # figures are in there, which is true and checkable, instead of
        # narrating the sandbox.
        parts = [
            "I've finished the analysis and put the results in the file below.",
            "",
            link,
            "",
            "I wasn't able to summarise the figures in this message — ask me "
            "and I'll send them inline.",
        ]
    return "\n".join(parts)


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
    file_resolver_fn=None,
    file_registrar_fn=None,
    file_describer_fn=None,
    ranking_fn=None,
    headline_fn=None,
    verify_fn=None,
    thread_id: str = "",
    verify_attempts: int | None = None,
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
    # Sandbox handles resolve through the adapter; see _resolve_upload_content.
    if file_resolver_fn is not None:
        set_file_resolver(file_resolver_fn)
    if file_registrar_fn is not None:
        set_file_registrar(file_registrar_fn)
    if file_describer_fn is not None:
        set_file_describer(file_describer_fn)
    if ranking_fn is not None:
        set_ranking_verifier(ranking_fn)
    if headline_fn is not None:
        set_headline_verifier(headline_fn)
    if verify_fn is not None:
        set_deliverable_verifier(verify_fn)

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
    # How many times a gap may be handed back before the reply goes out with a
    # note instead. Email leaves it at the default: the requester is waiting on
    # a message either way, so a rebuild costs them nothing they can feel. A
    # chat sets it to zero — the check still runs and still says what is
    # missing, but a person watching a chat window should not wait two extra
    # model turns for a file they can ask about in five seconds.
    if verify_attempts is not None:
        initial_state.max_verify_attempts = max(0, int(verify_attempts))

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
    file_resolver_fn=None,
    file_registrar_fn=None,
    file_describer_fn=None,
    ranking_fn=None,
    headline_fn=None,
    verify_fn=None,
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
    # Sandbox handles resolve through the adapter; see _resolve_upload_content.
    if file_resolver_fn is not None:
        set_file_resolver(file_resolver_fn)
    if file_registrar_fn is not None:
        set_file_registrar(file_registrar_fn)
    if file_describer_fn is not None:
        set_file_describer(file_describer_fn)
    if ranking_fn is not None:
        set_ranking_verifier(ranking_fn)
    if headline_fn is not None:
        set_headline_verifier(headline_fn)
    if verify_fn is not None:
        set_deliverable_verifier(verify_fn)
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
