"""
Platform Adapter — FastAPI bridge between the marketplace and the LangGraph agent.

Implements the 3-endpoint adapter contract:
  POST /hooks/agent           — receive messages (email, onboarding)
  GET  /internal/health       — health check
  POST /internal/approvals/{id}/resolve — receive approval resolutions
"""

import json
import os
import re
import time
import asyncio
from pathlib import Path

import httpx
import uvicorn
from fastapi import FastAPI, Request
from pydantic import BaseModel

try:
    import markdown as _markdown
    _MARKDOWN_AVAILABLE = True
except ImportError:
    _markdown = None
    _MARKDOWN_AVAILABLE = False

# ─── Fix 1: Read secrets BEFORE importing creator code, then scrub from env ──

_SECRETS_TO_SCRUB = [
    "AGENTMAIL_API_KEY",
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "APPROVAL_WEBHOOK_TOKEN",
    "MARKETPLACE_APPROVAL_WEBHOOK",
]

_secrets: dict[str, str] = {}
for _key in _SECRETS_TO_SCRUB:
    _secrets[_key] = os.environ.pop(_key, "")

# ─── MCP Sidecar Discovery ─────────────────────────────────────────────────
# Read MCP_*_URL env vars, scrub them, then discover tools at startup.

_mcp_servers: dict[str, str] = {}  # integration_type → URL
for _env_key in list(os.environ):
    if _env_key.startswith("MCP_") and _env_key.endswith("_URL"):
        _integration = _env_key[4:-4].lower().replace("_", "-")  # MCP_PYTHON_SANDBOX_URL → python-sandbox
        _mcp_servers[_integration] = os.environ.pop(_env_key)

# NOW safe to import creator code — secrets and MCP URLs are no longer in os.environ
from creator.agent import run_agent

# ─── Config ──────────────────────────────────────────────────────────────────

DEPLOYMENT_ID = os.environ.get("DEPLOYMENT_ID", "unknown")
AGENT_EMAIL = os.environ.get("AGENT_EMAIL", "")
AGENT_NAME = os.environ.get("AGENT_NAME", "Agent")
COMPANY_NAME = os.environ.get("COMPANY_NAME", "")
COMPANY_DOMAIN = os.environ.get("COMPANY_DOMAIN", "")
MANAGER_EMAIL = os.environ.get("WEEKLY_DIGEST_EMAIL", "")
AGENTMAIL_API_KEY = _secrets["AGENTMAIL_API_KEY"]
ANTHROPIC_API_KEY = _secrets["ANTHROPIC_API_KEY"]
MODEL = os.environ.get("MODEL", "sonnet")
APPROVAL_WEBHOOK = _secrets["MARKETPLACE_APPROVAL_WEBHOOK"] or "http://localhost:3002"
APPROVAL_TOKEN = _secrets["APPROVAL_WEBHOOK_TOKEN"]
MARKETPLACE_URL = os.environ.get("MARKETPLACE_URL", "http://localhost:3002")
# PORTAL_TOKEN: env var is preferred; falls back to /agent/portal_token.txt for containers
# that were created before this field was added to the provisioning env set.
_portal_token_file = Path("/agent/portal_token.txt")
PORTAL_TOKEN = (
    os.environ.get("PORTAL_TOKEN", "")
    or (_portal_token_file.read_text().strip() if _portal_token_file.exists() else "")
)
AGENT_ID = os.environ.get("AGENT_ID", "")
PORT = int(os.environ.get("PORT", "4000"))

# Email mode: "outlook" sends via Graph API proxy, "agentmail" (default) uses AgentMail API
EMAIL_MODE = os.environ.get("EMAIL_MODE", "agentmail").strip().lower()
OUTLOOK_SEND_URL = os.environ.get("OUTLOOK_SEND_URL", "")

# Approval policy (configurable per-deployment via autonomyConfig → env vars)
APPROVAL_POLICY = os.environ.get("APPROVAL_POLICY", "external-only").strip().lower()
try:
    APPROVAL_RISK_THRESHOLD = float(os.environ.get("APPROVAL_RISK_THRESHOLD", "6.0"))
except (TypeError, ValueError):
    APPROVAL_RISK_THRESHOLD = 6.0
# Path to a JSON override file that, if present, wins over env vars. Useful for
# testing and for hot-updating policy without restarting the container.
# File shape: {"policy": str, "riskThreshold": float, "autoApprove": [str], "requireApproval": [str]}
APPROVAL_OVERRIDE_PATH = Path("/agent/approval_policy.json")

DATA_DIR = Path(f"/data/{DEPLOYMENT_ID}")
WORKSPACE_DIR = Path("/agent/creator")
RESOLUTIONS_DIR = DATA_DIR / "resolutions"
RESOLUTIONS_DIR.mkdir(parents=True, exist_ok=True)

# ─── MCP Client ─────────────────────────────────────────────────────────────

_mcp_tools: dict[str, list[dict]] = {}  # integration_type → list of tool defs


async def _discover_mcp_tools() -> None:
    """Fetch tool lists from all MCP sidecar servers. Called once at startup."""
    if not _mcp_servers:
        return
    async with httpx.AsyncClient(timeout=15.0) as client:
        for integration, url in _mcp_servers.items():
            for attempt in range(5):
                try:
                    resp = await client.post(f"{url}/mcp/tools/list")
                    resp.raise_for_status()
                    tools = resp.json().get("tools", [])
                    _mcp_tools[integration] = tools
                    print(f"[mcp] Discovered {len(tools)} tool(s) from {integration}: "
                          f"{[t['name'] for t in tools]}", flush=True)
                    break
                except Exception as e:
                    if attempt < 4:
                        import asyncio as _aio
                        await _aio.sleep(2)
                    else:
                        print(f"[mcp] Failed to discover tools from {integration}: {e}", flush=True)


async def call_mcp_tool(server_type: str, tool_name: str, arguments: dict) -> dict:
    """Call a tool on an MCP sidecar server.

    Args:
        server_type: Integration type (e.g., "python-sandbox")
        tool_name: Tool name (e.g., "execute_python")
        arguments: Tool arguments dict

    Returns:
        Result dict from the MCP server, or error dict on failure.
    """
    url = _mcp_servers.get(server_type)
    if not url:
        return {"error": f"MCP server '{server_type}' not available"}

    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(
                f"{url}/mcp/tools/call",
                json={"name": tool_name, "arguments": arguments},
            )
            resp.raise_for_status()
            return resp.json().get("result", resp.json())
    except httpx.TimeoutException:
        return {"error": f"MCP tool {tool_name} timed out"}
    except Exception as e:
        return {"error": f"MCP tool {tool_name} failed: {str(e)}"}


def _write_mcp_tools_doc() -> None:
    """Write a dynamic MCP_TOOLS.md to the creator directory so the LLM knows
    which MCP tools are available and how to call them."""
    if not _mcp_tools:
        return

    lines = ["# Available MCP Tools\n",
             "These tools are available through the `mcp_fn` function passed to `run_agent()`.\n",
             "Call them like: `result = await mcp_fn(server_type, tool_name, arguments)`\n"]

    for integration, tools in _mcp_tools.items():
        lines.append(f"\n## {integration}\n")
        for tool in tools:
            lines.append(f"### `{tool['name']}`\n")
            lines.append(f"{tool.get('description', '')}\n")
            schema = tool.get("inputSchema", {})
            props = schema.get("properties", {})
            required = schema.get("required", [])
            if props:
                lines.append("\n**Parameters:**\n")
                for pname, pinfo in props.items():
                    req = " (required)" if pname in required else ""
                    lines.append(f"- `{pname}`: {pinfo.get('description', pinfo.get('type', ''))}{req}\n")

    doc_path = WORKSPACE_DIR / "MCP_TOOLS.md"
    try:
        doc_path.write_text("".join(lines), encoding="utf-8")
        print(f"[mcp] Wrote MCP_TOOLS.md with {sum(len(t) for t in _mcp_tools.values())} tool(s)", flush=True)
    except Exception as e:
        print(f"[mcp] Failed to write MCP_TOOLS.md: {e}", flush=True)


app = FastAPI(title=f"{AGENT_NAME} Adapter", version="1.0.0")


@app.on_event("startup")
async def _startup():
    """Discover MCP tools from sidecars and write dynamic tool docs."""
    await _discover_mcp_tools()
    _write_mcp_tools_doc()


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


# ─── Google SA email (informational context only) ────────────────────────────
# The full SA key and all Google logic lives in the agent package (google_tools.py).
# The adapter only surfaces the SA email so the agent can tell users what to share.

WORKSPACE_EMAIL = os.environ.get("WORKSPACE_EMAIL", "") or os.environ.get("GOOGLE_SERVICE_ACCOUNT_EMAIL", "")
WORKSPACE_PROVIDER = os.environ.get("WORKSPACE_PROVIDER", "NONE")
# Legacy alias kept for any adapter code that still references GOOGLE_SA_EMAIL
GOOGLE_SA_EMAIL = WORKSPACE_EMAIL

# ─── Markdown → HTML rendering ───────────────────────────────────────────────

_EMAIL_HTML_WRAPPER = """<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  body {{
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
                 Helvetica, Arial, sans-serif;
    font-size: 15px;
    line-height: 1.55;
    color: #222;
    max-width: 640px;
    margin: 0 auto;
    padding: 16px;
  }}
  p {{ margin: 0 0 12px 0; }}
  strong {{ font-weight: 600; }}
  em {{ font-style: italic; }}
  ul, ol {{ margin: 0 0 12px 20px; padding: 0; }}
  li {{ margin: 4px 0; }}
  h1, h2, h3, h4 {{ margin: 16px 0 8px 0; line-height: 1.3; }}
  h1 {{ font-size: 22px; }}
  h2 {{ font-size: 19px; }}
  h3 {{ font-size: 17px; }}
  code {{
    background: #f4f4f4;
    padding: 2px 6px;
    border-radius: 3px;
    font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
    font-size: 13px;
  }}
  pre {{
    background: #f4f4f4;
    padding: 12px;
    border-radius: 4px;
    overflow-x: auto;
    font-size: 13px;
  }}
  pre code {{ background: transparent; padding: 0; }}
  table {{
    border-collapse: collapse;
    margin: 12px 0;
    width: 100%;
  }}
  th, td {{
    border: 1px solid #ddd;
    padding: 8px 12px;
    text-align: left;
  }}
  th {{ background: #f7f7f7; font-weight: 600; }}
  blockquote {{
    margin: 12px 0;
    padding: 0 0 0 16px;
    border-left: 3px solid #ddd;
    color: #555;
  }}
  a {{ color: #0366d6; }}
</style>
</head>
<body>
{body}
</body>
</html>"""


# Identity placeholder scrubber — safety net. Even if upstream code (creator
# prompts, LLM outputs, memory templates) leaks a literal "{{AGENT_NAME}}"
# into a draft, this replaces it with the actual deployment value before the
# email is dispatched. Prevents embarrassing placeholders from landing in
# customer-facing emails.
_EMAIL_PLACEHOLDERS = {
    "{{AGENT_NAME}}": AGENT_NAME,
    "{{AGENT_EMAIL}}": AGENT_EMAIL,
    "{{COMPANY_NAME}}": COMPANY_NAME,
    "{{COMPANY_DOMAIN}}": COMPANY_DOMAIN,
    "{{MANAGER_EMAIL}}": MANAGER_EMAIL,
}


def scrub_placeholders(text: str) -> str:
    """Replace any literal {{AGENT_NAME}}-style placeholders with real values."""
    if not text:
        return text
    for key, value in _EMAIL_PLACEHOLDERS.items():
        if key in text:
            text = text.replace(key, value)
    return text


def render_markdown_email(text: str) -> str:
    """Convert a markdown-formatted draft into an HTML email body.

    Returns a full HTML document with inline styles. Falls back to a
    ``<pre>``-wrapped escaped version of the input if the ``markdown``
    package is unavailable at runtime.
    """
    if not text:
        return _EMAIL_HTML_WRAPPER.format(body="")
    if _MARKDOWN_AVAILABLE:
        try:
            body = _markdown.markdown(
                text,
                extensions=["tables", "fenced_code", "nl2br", "sane_lists"],
                output_format="html5",
            )
        except Exception as e:
            print(f"[adapter] markdown render failed ({e}); using <pre> fallback", flush=True)
            body = None
        if body is not None:
            return _EMAIL_HTML_WRAPPER.format(body=body)

    # Fallback: escape HTML entities and preserve line breaks.
    import html
    escaped = html.escape(text).replace("\n", "<br>\n")
    return _EMAIL_HTML_WRAPPER.format(body=f"<div>{escaped}</div>")


async def send_email(to: str, subject: str, text: str, thread_id: str | None = None) -> dict:
    """Send an email via Outlook Graph proxy or AgentMail, depending on EMAIL_MODE."""
    clean_text = scrub_placeholders(text)
    clean_subject = scrub_placeholders(subject)

    if EMAIL_MODE == "outlook" and OUTLOOK_SEND_URL:
        async with httpx.AsyncClient(timeout=30.0) as c:
            payload = {
                "deploymentId": DEPLOYMENT_ID,
                "agentEmail": WORKSPACE_EMAIL or AGENT_EMAIL,
                "to": to,
                "subject": clean_subject,
                "body": render_markdown_email(clean_text),
                "bodyType": "html",
            }
            resp = await c.post(OUTLOOK_SEND_URL, json=payload)
            resp.raise_for_status()
            return resp.json()

    # Default: AgentMail
    client = _get_client()
    payload: dict = {
        "to": to,
        "subject": clean_subject,
        "text": clean_text,
        "html": render_markdown_email(clean_text),
    }
    if thread_id:
        payload["thread_id"] = thread_id
    resp = await client.post(f"/inboxes/{AGENT_EMAIL}/messages/send", json=payload)
    resp.raise_for_status()
    return resp.json()


async def reply_email(
    message_id: str,
    text: str,
    *,
    fallback_to: str | None = None,
    fallback_subject: str | None = None,
    fallback_thread_id: str | None = None,
) -> dict:
    """Reply to a specific inbound message.

    Outlook mode: POSTs to the Graph proxy with replyToMessageId.
    AgentMail mode: uses the message-scoped reply endpoint.

    Falls back to ``send_email`` if the reply endpoint fails.
    """
    clean_text = scrub_placeholders(text)

    if EMAIL_MODE == "outlook" and OUTLOOK_SEND_URL and message_id:
        try:
            async with httpx.AsyncClient(timeout=30.0) as c:
                payload = {
                    "deploymentId": DEPLOYMENT_ID,
                    "agentEmail": WORKSPACE_EMAIL or AGENT_EMAIL,
                    "to": fallback_to or "",
                    "body": render_markdown_email(clean_text),
                    "bodyType": "html",
                    "replyToMessageId": message_id,
                }
                resp = await c.post(OUTLOOK_SEND_URL, json=payload)
                resp.raise_for_status()
                return resp.json()
        except Exception as exc:
            print(
                f"[adapter] Outlook reply to message {message_id} failed ({exc}); "
                f"falling back to send_email",
                flush=True,
            )
    elif message_id and EMAIL_MODE != "outlook":
        # AgentMail reply
        client = _get_client()
        try:
            resp = await client.post(
                f"/inboxes/{AGENT_EMAIL}/messages/{message_id}/reply",
                json={
                    "text": clean_text,
                    "html": render_markdown_email(clean_text),
                },
            )
            resp.raise_for_status()
            return resp.json()
        except httpx.HTTPStatusError as exc:
            print(
                f"[adapter] reply_email to message {message_id} failed "
                f"({exc.response.status_code}); falling back to send_email",
                flush=True,
            )

    # Fallback: treat as a new message in the same thread.
    if fallback_to:
        subj = fallback_subject or "Re:"
        if not subj.lower().startswith("re:"):
            subj = f"Re: {subj}"
        return await send_email(
            to=fallback_to,
            subject=subj,
            text=clean_text,
            thread_id=fallback_thread_id,
        )

    raise RuntimeError(
        "reply_email failed: no message_id and no fallback recipient available"
    )


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

    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            f"{APPROVAL_WEBHOOK}/api/deployments/{DEPLOYMENT_ID}/approvals",
            json=payload,
            headers={
                "Authorization": f"Bearer {APPROVAL_TOKEN}",
                "Content-Type": "application/json",
            },
        )
    resp.raise_for_status()
    data = resp.json()
    # API returns { approval: { id, status } }. Fall back to flat shapes for legacy.
    if isinstance(data, dict):
        approval = data.get("approval") or {}
        if isinstance(approval, dict) and approval.get("id"):
            return str(approval["id"])
        return str(data.get("id") or data.get("approvalId") or "")
    return ""


async def wait_for_resolution(approval_id: str, timeout_s: int = int(os.environ.get("APPROVAL_TIMEOUT_S", "14400"))) -> dict:
    """Poll the local resolutions directory for a resolution file."""
    resolution_path = RESOLUTIONS_DIR / f"{approval_id}.json"
    deadline = asyncio.get_event_loop().time() + timeout_s
    while asyncio.get_event_loop().time() < deadline:
        if resolution_path.exists():
            data = json.loads(resolution_path.read_text())
            resolution_path.unlink(missing_ok=True)
            # Normalize status to uppercase so callers can compare
            # against "APPROVED"/"EDITED"/"REJECTED" regardless of how
            # the resolution endpoint received the value.
            if isinstance(data.get("status"), str):
                data["status"] = data["status"].upper()
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


async def report_usage(contribution_ids: list[str]) -> dict:
    """Report that specific contributions were used in a response.

    This signals real value — increments usage count and auto-upvotes
    each contribution the agent actually incorporated.
    """
    if not contribution_ids:
        return {}
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            f"{MARKETPLACE_URL}/api/agentmind/use",
            json={
                "deploymentId": DEPLOYMENT_ID,
                "contributionIds": contribution_ids,
            },
        )
        resp.raise_for_status()
        return resp.json()


async def _sync_approval_to_portal(
    approval_id: str,
    action: str,
    edited_text: str | None,
    rejection_reason: str | None,
) -> None:
    """Call the marketplace portal API to sync an email-resolved approval to the DB.

    This keeps the platform's approval dashboard in sync when a manager approves/
    rejects/edits via email reply rather than clicking the portal link.
    """
    if not PORTAL_TOKEN:
        return
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(
                f"{MARKETPLACE_URL}/api/portal/{PORTAL_TOKEN}/approvals/{approval_id}/resolve",
                json={
                    "action": action,           # "APPROVED" | "EDITED" | "REJECTED"
                    "editedText": edited_text,  # only for EDITED
                    "rejectionReason": rejection_reason,
                },
            )
            if resp.status_code in (200, 201):
                print(f"[adapter] Portal sync: approval {approval_id} → {action} (synced)", flush=True)
            else:
                print(f"[adapter] Portal sync: approval {approval_id} got {resp.status_code}", flush=True)
    except Exception as exc:
        print(f"[adapter] Portal sync failed (non-fatal): {exc}", flush=True)


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

- NEVER include ANY content, names, emails, or references from PRIVATE.md
  in contributions. PRIVATE.md contains team rosters, internal URLs, and
  sensitive company details — none of it may appear in AgentMind.
- Never include PII, company names, individual names, or confidential data
  in contributions. Keep them general and reusable.
- Keep titles concise (under 80 chars). Keep content under 2000 chars.
- Use 1–3 lowercase tags that describe the topic.
- Contribute only genuinely useful insights — not every interaction warrants
  a contribution. Quality over quantity.
- Do NOT mention AgentMind to the humans you work with. It operates silently.
""".strip()


# ─── Fix 4: Approval Enforcement ─────────────────────────────────────────────

PRE_APPROVED_HOOKS = {
    "hook:onboarding",
    "hook:onboarding-answers",
    "hook:introduction",
    "hook:weekly-digest",
}


def _extract_email(addr: str) -> str:
    """Extract the email address from a string like 'Name <email@x.com>' or 'email@x.com'."""
    if not addr:
        return ""
    addr = addr.strip()
    if "<" in addr and ">" in addr:
        start = addr.find("<") + 1
        end = addr.find(">", start)
        return addr[start:end].strip().lower()
    return addr.lower()


def _parse_list(raw: str) -> list[str]:
    """Parse a comma/newline/semicolon-separated list of emails or @domains."""
    if not raw:
        return []
    out: list[str] = []
    for chunk in raw.replace("\n", ",").replace(";", ",").split(","):
        v = chunk.strip().lower()
        if v:
            out.append(v)
    return out


def _load_policy() -> dict:
    """Load current approval policy. File override > env vars.

    Returns a dict with keys: policy, riskThreshold, autoApprove, requireApproval.
    """
    policy = {
        "policy": APPROVAL_POLICY,
        "riskThreshold": APPROVAL_RISK_THRESHOLD,
        "autoApprove": _parse_list(os.environ.get("AUTO_APPROVE_LIST", "")),
        "requireApproval": _parse_list(os.environ.get("REQUIRE_APPROVAL_LIST", "")),
    }
    # Hot-reloadable override for testing / runtime tuning
    try:
        if APPROVAL_OVERRIDE_PATH.exists():
            data = json.loads(APPROVAL_OVERRIDE_PATH.read_text())
            if isinstance(data, dict):
                if isinstance(data.get("policy"), str):
                    policy["policy"] = data["policy"].strip().lower()
                if data.get("riskThreshold") is not None:
                    try:
                        policy["riskThreshold"] = float(data["riskThreshold"])
                    except (TypeError, ValueError):
                        pass
                if isinstance(data.get("autoApprove"), list):
                    policy["autoApprove"] = [str(x).strip().lower() for x in data["autoApprove"] if x]
                elif isinstance(data.get("autoApprove"), str):
                    policy["autoApprove"] = _parse_list(data["autoApprove"])
                if isinstance(data.get("requireApproval"), list):
                    policy["requireApproval"] = [str(x).strip().lower() for x in data["requireApproval"] if x]
                elif isinstance(data.get("requireApproval"), str):
                    policy["requireApproval"] = _parse_list(data["requireApproval"])
    except Exception as e:
        print(f"[adapter] Failed to load approval override file: {e}", flush=True)
    return policy


def _match_list(email: str, entries: list[str]) -> bool:
    """Return True if email matches any entry. Entries can be:
      - exact email like 'a@b.com'
      - domain prefix like '@example.com' or 'example.com'
    """
    if not email or not entries:
        return False
    for entry in entries:
        if not entry:
            continue
        if entry.startswith("@"):
            if email.endswith(entry):
                return True
        elif "@" in entry:
            if email == entry:
                return True
        else:
            # bare domain like "acme.com"
            if email.endswith("@" + entry):
                return True
    return False


def _should_require_approval(
    recipient: str,
    risk_assessment: dict | None = None,
) -> tuple[bool, str]:
    """Decide if an outbound email needs human approval.

    Returns (needs_approval, reason). The reason is a short human-readable
    explanation that gets logged so the decision is auditable.

    Policy evaluation order (highest precedence first):
      1. Explicit AUTO_APPROVE_LIST match → auto-approve
      2. Explicit REQUIRE_APPROVAL_LIST match → require approval
      3. Global policy:
          - "always"        → require approval
          - "never"         → auto-approve
          - "external-only" → require unless recipient is manager or on COMPANY_DOMAIN
          - "risk-based"    → require if LLM combined risk >= riskThreshold
    """
    email = _extract_email(recipient)
    if not email:
        return True, "no recipient email (fail-safe: require approval)"

    policy_cfg = _load_policy()
    policy = policy_cfg["policy"]
    threshold = policy_cfg["riskThreshold"]
    auto_approve = policy_cfg["autoApprove"]
    require_list = policy_cfg["requireApproval"]

    # 1. Explicit allowlist wins
    if _match_list(email, auto_approve):
        return False, f"recipient in AUTO_APPROVE_LIST ({email})"

    # 2. Explicit denylist wins next
    if _match_list(email, require_list):
        return True, f"recipient in REQUIRE_APPROVAL_LIST ({email})"

    # 3. Global policy
    if policy == "always":
        return True, "policy=always"
    if policy == "never":
        return False, "policy=never"

    if policy == "risk-based":
        risk = risk_assessment or {}
        try:
            combined = float(risk.get("combined") or 0.0)
        except (TypeError, ValueError):
            combined = 0.0
        if combined >= threshold:
            return True, f"policy=risk-based, combined={combined:.1f} >= {threshold}"
        return False, f"policy=risk-based, combined={combined:.1f} < {threshold}"

    # Default: "external-only" (prior hardcoded behavior)
    # Manager and company domain auto-approve; everyone else requires approval.
    if MANAGER_EMAIL and email == MANAGER_EMAIL.strip().lower():
        return False, f"policy=external-only, recipient is manager ({email})"
    if COMPANY_DOMAIN and email.endswith("@" + COMPANY_DOMAIN.strip().lower()):
        return False, f"policy=external-only, recipient on company domain ({email})"
    return True, f"policy=external-only, recipient is external ({email})"


def _is_internal_recipient(to: str) -> bool:
    """Legacy shim retained for callers that only need a boolean.
    Prefer _should_require_approval which also returns a reason."""
    needs, _ = _should_require_approval(to)
    return not needs

_approved_actions: dict[str, dict] = {}  # approval_id -> resolution data


# ─── Return Contract Validator ────────────────────────────────────────────────

_VALID_ACTIONS = {"send_email", "reply_email", "resolve_approval", "none"}


def _validate_result(result: dict) -> None:
    """Non-fatal runtime validation of the dict returned by run_agent().

    Logs warnings for contract violations — never raises. When the action is
    unknown we coerce it to "none" so downstream code has a safe default.
    All other violations are informational only; the adapter will still attempt
    the action and may surface a more specific error later.
    """
    action = result.get("action")

    if action not in _VALID_ACTIONS:
        logging.warning(
            "[adapter] run_agent returned unknown action %r — coercing to 'none'. "
            "Valid actions: %s",
            action,
            ", ".join(sorted(_VALID_ACTIONS)),
        )
        result["action"] = "none"
        action = "none"

    if action == "send_email":
        if not result.get("to"):
            logging.warning(
                "[adapter] action='send_email' but 'to' is missing or empty — "
                "email send will fail. Set result['to'] to the recipient address."
            )
        if not result.get("text"):
            logging.warning(
                "[adapter] action='send_email' but 'text' is missing or empty — "
                "email will be sent with a blank body."
            )

    if action == "reply_email":
        if not result.get("text"):
            logging.warning(
                "[adapter] action='reply_email' but 'text' is missing or empty — "
                "reply will be sent with a blank body."
            )

    if action == "resolve_approval":
        if not result.get("approval_id"):
            logging.warning(
                "[adapter] action='resolve_approval' but 'approval_id' is missing — "
                "resolution will fail. Make sure run_agent returns the approval_id "
                "received from approve_fn()."
            )

    risk = result.get("risk_assessment")
    if risk and isinstance(risk, dict):
        for key in ("stakes", "ambiguity", "reversibility", "combined"):
            val = risk.get(key)
            if val is not None:
                try:
                    fval = float(val)
                    if not (1.0 <= fval <= 10.0):
                        logging.warning(
                            "[adapter] risk_assessment.%s=%r is outside [1, 10] — "
                            "will be clamped by downstream logic.",
                            key, val,
                        )
                except (TypeError, ValueError):
                    logging.warning(
                        "[adapter] risk_assessment.%s=%r is not numeric — ignoring.",
                        key, val,
                    )


_original_queue = queue_for_approval
_original_resolve = wait_for_resolution


async def _tracked_queue(*args, **kwargs) -> str:
    approval_id = await _original_queue(*args, **kwargs)
    return approval_id


async def _tracked_resolve(approval_id: str, **kwargs) -> dict:
    result = await _original_resolve(approval_id, **kwargs)
    if result.get("status") in ("APPROVED", "EDITED"):
        _approved_actions[approval_id] = result
    return result


# ─── Decision Request — agent asks manager for high-level input ─────────────

async def request_decision(
    question: str,
    context: str = "",
    options: list[str] | None = None,
    urgency: str = "normal",
) -> dict:
    """Ask the manager a question and wait for their response.

    Unlike email approvals (which show a draft to approve/reject), decision
    requests present a question with optional choices. The manager's answer
    comes back as the resolution.

    Args:
        question: The question to ask the manager.
        context: Background context to help the manager decide.
        options: Optional list of suggested answers (manager can also free-text).
        urgency: "low", "normal", or "high" — affects notification phrasing.

    Returns:
        Dict with:
          - status: "APPROVED" (manager answered), "REJECTED" (manager declined), "EXPIRED"
          - answer: The manager's response text (from resolutionAction field)
    """
    # Build a readable draft that shows the question + context in the portal
    draft_parts = [f"**Question:** {question}"]
    if context:
        draft_parts.append(f"\n**Context:** {context}")
    if options:
        draft_parts.append("\n**Suggested options:**")
        for i, opt in enumerate(options, 1):
            draft_parts.append(f"  {i}. {opt}")
    draft_parts.append(f"\n*Urgency: {urgency}*")
    draft = "\n".join(draft_parts)

    # Map urgency to risk scores so the portal shows appropriate priority
    urgency_scores = {
        "low": (2.0, 2.0, 2.0),
        "normal": (5.0, 5.0, 5.0),
        "high": (8.0, 8.0, 3.0),
    }
    stakes, ambiguity, reversibility = urgency_scores.get(urgency, (5.0, 5.0, 5.0))

    try:
        approval_id = await _tracked_queue(
            task_type="decision_request",
            channel="decision",
            draft=draft,
            reasoning=f"Agent needs manager input: {question[:100]}",
            stakes=stakes,
            ambiguity=ambiguity,
            reversibility=reversibility,
            original_request=question,
        )
        print(f"[adapter] Decision request queued: {approval_id}", flush=True)

        resolution = await _tracked_resolve(approval_id)
        status = resolution.get("status", "EXPIRED")
        answer = resolution.get("resolutionAction", "")

        if status == "APPROVED":
            # Manager approved without editing — means "yes" or "proceed"
            return {"status": "APPROVED", "answer": answer or "Approved — proceed as planned."}
        elif status == "EDITED":
            # Manager provided specific guidance
            return {"status": "APPROVED", "answer": answer}
        elif status == "REJECTED":
            return {"status": "REJECTED", "answer": resolution.get("rejectionReason", "Request declined.")}
        else:
            return {"status": "EXPIRED", "answer": "No response received within the timeout period."}
    except Exception as e:
        print(f"[adapter] Decision request failed: {e}", flush=True)
        return {"status": "ERROR", "answer": f"Failed to submit question: {str(e)}"}


# ─── Fix 6: Per-Deployment Usage Caps ────────────────────────────────────────

_TIER_LIMITS = {
    "haiku":  {"llm_calls": 500, "emails": 100},
    "sonnet": {"llm_calls": 200, "emails": 100},
    "opus":   {"llm_calls": 100, "emails": 50},
}

_usage_counts: dict[str, int] = {"llm_calls": 0, "emails": 0}
_usage_window_start = time.time()


def _check_and_increment(counter: str) -> bool:
    """Returns True if within limits, False if exceeded."""
    global _usage_window_start
    if time.time() - _usage_window_start > 86400:
        _usage_counts["llm_calls"] = 0
        _usage_counts["emails"] = 0
        _usage_window_start = time.time()

    tier = MODEL.lower()
    limits = _TIER_LIMITS.get(tier, _TIER_LIMITS["sonnet"])
    if _usage_counts[counter] >= limits[counter]:
        return False
    _usage_counts[counter] += 1
    return True


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

_llm_health_cache: dict = {"ok": None, "checked_at": 0.0}

async def _check_llm_health() -> bool:
    """Quick LLM connectivity test, cached for 5 minutes."""
    now = time.time()
    if _llm_health_cache["ok"] is not None and now - _llm_health_cache["checked_at"] < 300:
        return _llm_health_cache["ok"]
    try:
        llm_key = os.environ.get("LLM_API_KEY", "")
        llm_base = os.environ.get("LLM_BASE_URL", "")
        if not llm_key or not llm_base:
            _llm_health_cache.update(ok=False, checked_at=now)
            return False
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(
                f"{llm_base}/models",
                headers={"Authorization": f"Bearer {llm_key}"},
            )
            ok = resp.status_code < 500
            _llm_health_cache.update(ok=ok, checked_at=now)
            return ok
    except Exception:
        _llm_health_cache.update(ok=False, checked_at=now)
        return False


@app.get("/internal/health")
async def health():
    llm_ok = await _check_llm_health()
    return {"ok": True, "llm": llm_ok, "deploymentId": DEPLOYMENT_ID}


@app.get("/internal/skills")
async def skills():
    """List skill directories under /agent/skills/."""
    skills_dir = WORKSPACE_DIR / "skills"
    result = []
    if skills_dir.is_dir():
        for entry in sorted(skills_dir.iterdir()):
            if entry.is_dir():
                skill_md = entry / "SKILL.md"
                result.append({
                    "name": entry.name,
                    "hasSkillMd": skill_md.exists(),
                })
    return {"skills": result}


@app.get("/internal/memory")
async def memory():
    """Return MEMORY.md + all memory/*.md files as keyed JSON."""
    files: dict[str, str] = {}
    main_memory = WORKSPACE_DIR / "MEMORY.md"
    if main_memory.exists():
        files["MEMORY.md"] = main_memory.read_text(encoding="utf-8", errors="replace")
    memory_dir = WORKSPACE_DIR / "memory"
    if memory_dir.is_dir():
        for md_file in sorted(memory_dir.glob("*.md")):
            files[f"memory/{md_file.name}"] = md_file.read_text(encoding="utf-8", errors="replace")
    return {"memory": files}


class UpdateSkillsPayload(BaseModel):
    files: dict[str, str]  # path -> content (relative to /agent/)


@app.post("/internal/update-skills")
async def update_skills(body: UpdateSkillsPayload):
    """Write skill/memory files to disk. Paths are relative to /agent/."""
    written = []
    for rel_path, content in body.files.items():
        # Prevent path traversal
        target = (WORKSPACE_DIR / rel_path).resolve()
        if not str(target).startswith(str(WORKSPACE_DIR.resolve())):
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
        written.append(rel_path)
    return {"ok": True, "written": written}


class ApprovalPolicyPayload(BaseModel):
    policy: str | None = None
    riskThreshold: float | None = None
    autoApprove: list[str] | None = None
    requireApproval: list[str] | None = None


@app.post("/internal/approval-policy")
async def set_approval_policy(body: ApprovalPolicyPayload):
    """Write /agent/approval_policy.json. The adapter's _load_policy()
    reads this file on every approval check, so the new policy takes
    effect on the next outbound email without a container restart.
    """
    override: dict = {}
    if body.policy is not None:
        override["policy"] = body.policy
    if body.riskThreshold is not None:
        override["riskThreshold"] = body.riskThreshold
    if body.autoApprove is not None:
        override["autoApprove"] = body.autoApprove
    if body.requireApproval is not None:
        override["requireApproval"] = body.requireApproval
    APPROVAL_OVERRIDE_PATH.parent.mkdir(parents=True, exist_ok=True)
    APPROVAL_OVERRIDE_PATH.write_text(json.dumps(override), encoding="utf-8")
    return {"ok": True, "policy": override}


@app.get("/internal/approval-policy")
async def get_approval_policy():
    """Return the current approval policy (env + file override merged)."""
    return _load_policy()


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


@app.post("/hooks/agentmail")
async def receive_agentmail_webhook(request: Request):
    """Receive an email webhook from the AgentMail poller or AgentMail directly.

    Payload format (from poller):
      { message: { from, to, subject, text, thread_id, ... }, thread: { ... } }
    """
    payload = await request.json()
    msg = payload.get("message", {})

    sender = msg.get("from", "unknown")
    subject = msg.get("subject", "")
    text = msg.get("text", "")
    thread_id = msg.get("thread_id", "")
    # The poller puts message_id on the message block AND on event_id at the
    # top level (older clients). Accept either.
    message_id = msg.get("message_id") or payload.get("event_id", "")

    # Build a human-readable message for the agent
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

    asyncio.create_task(_handle_message(formatted, context))
    return {"ok": True, "status": "accepted"}


@app.post("/hooks/teams")
async def receive_teams_message(request: Request):
    """Receive a message from Microsoft Teams via the provisioning service.

    Unlike email hooks (fire-and-forget), this endpoint is synchronous —
    it waits for the agent to process and returns the reply text so the
    provisioning service can send it back to Teams immediately.

    Payload: { message, teamsUserId, teamsUserName, tenantId, deploymentId, conversationId }
    Response: { ok: true, reply: "..." } or { ok: false, error: "..." }
    """
    payload = await request.json()
    message = payload.get("message", "").strip()
    teams_user_name = payload.get("teamsUserName", "Teams User")
    teams_user_id = payload.get("teamsUserId", "")
    conversation_id = payload.get("conversationId", "")

    if not message:
        return {"ok": False, "error": "Empty message"}

    # Rate limit check
    if not _check_and_increment("llm_calls"):
        return {"ok": False, "error": "Rate limit exceeded. Please try again later."}

    context = {
        "agent_name": AGENT_NAME,
        "agent_email": AGENT_EMAIL,
        "company_name": COMPANY_NAME,
        "company_domain": COMPANY_DOMAIN,
        "hook_name": "Teams",
        "session_key": f"hook:teams:{conversation_id}",
        "agentmind_prompt": AGENTMIND_PROMPT,
        "teams_user_id": teams_user_id,
        "teams_user_name": teams_user_name,
        "google_sa_email": GOOGLE_SA_EMAIL,
        "workspace_email": WORKSPACE_EMAIL,
        "workspace_provider": WORKSPACE_PROVIDER,
    }

    try:
        async def _bypass_approve(*args, **kwargs) -> str:
            return ""

        async def _bypass_resolve(approval_id, **kwargs) -> dict:
            return {"status": "APPROVED"}

        print(f"[adapter] Teams message from {teams_user_name}: {message[:100]}...", flush=True)

        result = await run_agent(
            content=f"Teams message from {teams_user_name}:\n{message}",
            context=context,
            approve_fn=_bypass_approve,
            resolve_fn=_bypass_resolve,
            contribute_fn=contribute_knowledge,
            search_fn=search_knowledge,
            use_fn=report_usage,
            request_decision_fn=request_decision,
            **({"mcp_fn": call_mcp_tool} if _mcp_servers else {}),
        )

        if not isinstance(result, dict):
            return {"ok": False, "error": "Agent returned invalid response"}

        # Extract the reply text from the agent result.
        # The agent may return action=send_email/reply_email with text, or action=none.
        # For Teams we just need the text content regardless of action type.
        reply_text = result.get("text", "")

        if not reply_text:
            # Retry once with explicit instruction (same pattern as AgentMail fallback)
            retry_content = (
                f"Teams message from {teams_user_name}:\n{message}"
                "\n\n[SYSTEM REMINDER] The above is a direct message from a user "
                "on Microsoft Teams who is waiting for a response. You MUST reply. "
                "Populate draft.text with a complete, helpful response."
            )
            retry_result = await run_agent(
                content=retry_content,
                context=context,
                approve_fn=_bypass_approve,
                resolve_fn=_bypass_resolve,
                contribute_fn=contribute_knowledge,
                search_fn=search_knowledge,
                use_fn=report_usage,
                request_decision_fn=request_decision,
                **({"mcp_fn": call_mcp_tool} if _mcp_servers else {}),
            )
            reply_text = retry_result.get("text", "") if isinstance(retry_result, dict) else ""

        if not reply_text:
            reply_text = "I received your message but wasn't able to formulate a response. Could you try rephrasing?"

        # Strip HTML if markdown lib is available (Teams prefers plain text / markdown)
        # The agent may return HTML-formatted email text
        if "<" in reply_text and ">" in reply_text:
            import re as _re
            reply_text = _re.sub(r"<br\s*/?>", "\n", reply_text)
            reply_text = _re.sub(r"<[^>]+>", "", reply_text)
            reply_text = reply_text.strip()

        print(f"[adapter] Teams reply ({len(reply_text)} chars) to {teams_user_name}", flush=True)
        return {"ok": True, "reply": reply_text}

    except Exception as exc:
        print(f"[adapter] Teams handler error: {exc}", flush=True)
        return {"ok": False, "error": "Internal error processing your message"}


async def _handle_message(message: str, context: dict):
    """Process a message through the LangGraph agent and act on the result."""
    print(f"[adapter] _handle_message called with session_key={context.get('session_key', '')}", flush=True)
    try:
        # Fix 6: check LLM call budget
        if not _check_and_increment("llm_calls"):
            print(f"[adapter] Rate limited: LLM call budget exceeded for tier {MODEL}", flush=True)
            return

        pre_approved = context.get("session_key", "") in PRE_APPROVED_HOOKS

        # The graph's handle_approval node is advisory only — it doesn't know
        # about internal-vs-external recipients, per-deployment pre-approved
        # hooks, or marketplace state. If we gave it the real queue/resolve
        # functions, it would block for up to 48h waiting on a resolution file
        # even for replies to the hiring manager (which should auto-approve).
        #
        # Instead, bypass it: pass no-op approve/resolve that always succeed,
        # so run_agent returns immediately. Real approval enforcement happens
        # below, after we know the final recipient.
        async def _bypass_approve(*args, **kwargs) -> str:
            return ""

        async def _bypass_resolve(approval_id, **kwargs) -> dict:
            return {"status": "APPROVED"}

        # Surface the SA email so the agent can tell users what to share with it
        context = {
            **context,
            "google_sa_email": GOOGLE_SA_EMAIL,
            "workspace_email": WORKSPACE_EMAIL,
            "workspace_provider": WORKSPACE_PROVIDER,
        }

        print(f"[adapter] Running agent graph...", flush=True)
        result = await run_agent(
            content=message,
            context=context,
            approve_fn=_bypass_approve,
            resolve_fn=_bypass_resolve,
            contribute_fn=contribute_knowledge,
            search_fn=search_knowledge,
            use_fn=report_usage,
            request_decision_fn=request_decision,
            **({"mcp_fn": call_mcp_tool} if _mcp_servers else {}),
        )

        if not isinstance(result, dict):
            print(f"[adapter] run_agent returned non-dict ({type(result).__name__}) — skipping", flush=True)
            return

        _validate_result(result)

        action = result.get("action", "none")
        print(f"[adapter] Agent returned action={action} to={result.get('to', '')}", flush=True)

        # ── Email-reply approval resolution ─────────────────────────────────
        # The agent detected the manager approved/rejected/edited via email reply
        # and returned action="resolve_approval". We:
        #   1. Write the resolution file so any waiting _tracked_resolve() unblocks.
        #   2. Sync the resolution to the marketplace DB via the portal API.
        #   3. Reply to the manager confirming (optional, if agent provided a reply).
        if action == "resolve_approval":
            approval_id = result.get("approval_id", "")
            resolution_action = (result.get("resolution") or "APPROVED").upper()
            edited_text = result.get("edited_text")  # if manager sent edited draft
            rejection_reason = result.get("rejection_reason")

            if approval_id:
                # 1. Write local resolution file (unblocks waiting _tracked_resolve)
                resolution_path = RESOLUTIONS_DIR / f"{approval_id}.json"
                resolution_path.write_text(json.dumps({
                    "status": resolution_action,
                    "resolutionAction": edited_text,
                    "rejectionReason": rejection_reason,
                }))
                print(f"[adapter] Email-resolve: wrote resolution file for {approval_id} → {resolution_action}", flush=True)

                # 2. Sync to marketplace DB via portal token (best-effort, non-blocking)
                if PORTAL_TOKEN and MARKETPLACE_URL:
                    asyncio.create_task(_sync_approval_to_portal(approval_id, resolution_action, edited_text, rejection_reason))

            # 3. Reply to manager confirming (if agent drafted a confirmation)
            reply_text = result.get("text")
            if reply_text:
                if _check_and_increment("emails"):
                    await reply_email(
                        message_id=context.get("message_id", ""),
                        text=reply_text,
                        fallback_to=_extract_email(context.get("sender", "")),
                        fallback_subject=context.get("subject", ""),
                        fallback_thread_id=context.get("thread_id"),
                    )
            return

        if action in ("send_email", "reply_email"):
            approval_id = result.get("approval_id")

            # Determine the actual recipient. For replies, fall back to the
            # sender of the incoming email (the one we're replying to).
            recipient = result.get("to") or context.get("sender", "")
            risk_from_llm = result.get("risk_assessment") or {}
            needs_approval_policy, policy_reason = _should_require_approval(
                recipient, risk_from_llm
            )

            # Policy says auto-approve OR session is pre-approved (onboarding, etc.)
            if pre_approved or not needs_approval_policy:
                if not pre_approved:
                    print(f"[adapter] Auto-approving ({policy_reason})", flush=True)
                    # Record the auto-approval in the DB so AgentMind eligibility
                    # is satisfied after the first successful task (Fix B).
                    try:
                        risk = result.get("risk_assessment") or {}
                        auto_stakes = float(risk.get("stakes") or 2.0)
                        auto_ambiguity = float(risk.get("ambiguity") or 2.0)
                        auto_reversibility = float(risk.get("reversibility") or 2.0)
                        async with httpx.AsyncClient(timeout=10.0) as _ac:
                            await _ac.post(
                                f"{APPROVAL_WEBHOOK}/api/deployments/{DEPLOYMENT_ID}/approvals/auto-complete",
                                json={
                                    "taskType": result.get("task_type", action),
                                    "draft": result.get("text", ""),
                                    "originalRequest": context.get("subject", ""),
                                    "reasoning": f"Auto-approved: {policy_reason}",
                                    "threadId": result.get("thread_id") or context.get("thread_id"),
                                    "stakesScore": auto_stakes,
                                    "ambiguityScore": auto_ambiguity,
                                    "reversibilityScore": auto_reversibility,
                                },
                                headers={
                                    "Authorization": f"Bearer {APPROVAL_TOKEN}",
                                    "Content-Type": "application/json",
                                },
                            )
                    except Exception as _e:
                        print(f"[adapter] Failed to record auto-approval (non-fatal): {_e}", flush=True)
                else:
                    print(f"[adapter] Pre-approved session ({context.get('session_key', '')})", flush=True)
            else:
                print(f"[adapter] Requiring approval ({policy_reason})", flush=True)
                # External recipient without a pre-approved session.
                # Platform guarantees approval regardless of creator code logic.
                if not approval_id:
                    print(f"[adapter] External recipient — auto-queueing {action} for approval")
                    draft_text = result.get("text", "")
                    thread_id = result.get("thread_id") or context.get("thread_id")
                    # Use the LLM's real risk assessment from the creator graph.
                    # Falls back to mid-range defaults if the LLM didn't provide scores.
                    risk = result.get("risk_assessment") or {}
                    try:
                        stakes_val = float(risk.get("stakes") or 5.0)
                        ambiguity_val = float(risk.get("ambiguity") or 5.0)
                        reversibility_val = float(risk.get("reversibility") or 5.0)
                    except (TypeError, ValueError):
                        stakes_val = ambiguity_val = reversibility_val = 5.0
                    try:
                        queued_id = await _tracked_queue(
                            task_type=result.get("task_type", action),
                            channel="email",
                            draft=draft_text,
                            reasoning=result.get("reasoning", "Auto-queued by platform adapter"),
                            stakes=stakes_val,
                            ambiguity=ambiguity_val,
                            reversibility=reversibility_val,
                            thread_id=thread_id,
                            original_request=context.get("subject", ""),
                        )
                        print(f"[adapter] Queued approval {queued_id}; waiting for resolution", flush=True)
                        resolution = await _tracked_resolve(queued_id)
                        if resolution.get("status") not in ("APPROVED", "EDITED"):
                            print(f"[adapter] Approval {queued_id} {resolution.get('status')} — not sending", flush=True)
                            return
                        if resolution.get("status") == "EDITED" and resolution.get("resolutionAction"):
                            result["text"] = resolution["resolutionAction"]
                        approval_id = queued_id
                    except Exception as e:
                        print(f"[adapter] Failed to auto-queue approval: {e}")
                        return
                elif approval_id not in _approved_actions:
                    print(f"[adapter] BLOCKED: {action} with unverified approval_id {approval_id}")
                    return

            # Fix 6: check email budget
            if not _check_and_increment("emails"):
                print(f"[adapter] Rate limited: email budget exceeded for tier {MODEL}")
                return

            if action == "send_email":
                send_to = result.get("to") or context.get("sender", "")
                if not send_to:
                    print("[adapter] send_email skipped: no recipient (to=None)", flush=True)
                    return
                await send_email(
                    to=send_to,
                    subject=result.get("subject", ""),
                    text=result["text"],
                    thread_id=result.get("thread_id"),
                )
            elif action == "reply_email":
                await reply_email(
                    message_id=result.get("message_id") or context.get("message_id", ""),
                    text=result["text"],
                    fallback_to=_extract_email(result.get("to") or context.get("sender", "")),
                    fallback_subject=context.get("subject", ""),
                    fallback_thread_id=result.get("thread_id") or context.get("thread_id"),
                )

            # Clean up tracked approval
            if approval_id:
                _approved_actions.pop(approval_id, None)

        elif context.get("hook_name") == "AgentMail":
            # Defense in depth: if the LLM returned action=none for an
            # inbound email, the human is waiting for a response. Retry
            # run_agent once with an explicit reminder; if that still
            # returns none, send a one-line acknowledgement so the sender
            # is never left hanging. This protects against LLM
            # non-determinism on free-tier models.
            print(f"[adapter] Agent returned action=none on AgentMail hook — retrying with explicit reminder", flush=True)
            try:
                retry_content = (
                    message
                    + "\n\n[SYSTEM REMINDER] The above is an inbound email "
                    "from a human who is waiting for a response. You MUST "
                    "reply. Set action to reply_email and populate draft.text "
                    "with a complete, helpful response to their question or "
                    "request. Do NOT return action=none."
                )
                retry_result = await run_agent(
                    content=retry_content,
                    context=context,
                    approve_fn=_bypass_approve,
                    resolve_fn=_bypass_resolve,
                    contribute_fn=contribute_knowledge,
                    search_fn=search_knowledge,
                    use_fn=report_usage,
                    request_decision_fn=request_decision,
                    **({"mcp_fn": call_mcp_tool} if _mcp_servers else {}),
                )
                retry_action = retry_result.get("action", "none")
                print(f"[adapter] Retry returned action={retry_action}", flush=True)
                if retry_action in ("send_email", "reply_email") and retry_result.get("text"):
                    recipient = retry_result.get("to") or context.get("sender", "")
                    is_internal = _is_internal_recipient(recipient)
                    if pre_approved or is_internal:
                        if _check_and_increment("emails"):
                            await reply_email(
                                message_id=retry_result.get("message_id") or context.get("message_id", ""),
                                text=retry_result["text"],
                                fallback_to=_extract_email(recipient),
                                fallback_subject=context.get("subject", ""),
                                fallback_thread_id=retry_result.get("thread_id") or context.get("thread_id"),
                            )
                            print(f"[adapter] Sent retry reply to {_extract_email(recipient)}", flush=True)
                            return
                # Last-resort acknowledgement for internal recipients only
                incoming_sender = context.get("sender", "")
                if _is_internal_recipient(incoming_sender) and _check_and_increment("emails"):
                    print(f"[adapter] Sending default acknowledgement to {_extract_email(incoming_sender)}", flush=True)
                    await reply_email(
                        message_id=context.get("message_id", ""),
                        text=(
                            "Hi,\n\nThanks for your message — I received it but "
                            "wasn't sure how to respond. Could you rephrase or "
                            "give me a bit more context on what you're looking "
                            "for?\n\nBest,\n" + AGENT_NAME
                        ),
                        fallback_to=_extract_email(incoming_sender),
                        fallback_subject=context.get("subject", ""),
                        fallback_thread_id=context.get("thread_id"),
                    )
            except Exception as e:
                print(f"[adapter] Fallback retry/ack failed: {e}", flush=True)

        # action == "none" → agent chose not to act (e.g., clarification stored)

    except Exception as e:
        print(f"[adapter] Error handling message: {e}", flush=True)


# ─── Entry Point ─────────────────────────────────────────────────────────────

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="info")
