"""
Platform Adapter — FastAPI bridge between the marketplace and the LangGraph agent.

Implements the 3-endpoint adapter contract:
  POST /hooks/agent           — receive messages (email, onboarding)
  GET  /internal/health       — health check
  POST /internal/approvals/{id}/resolve — receive approval resolutions
"""

import datetime
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

# NOW safe to import creator code — secrets are no longer in os.environ
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


# ─── Google Workspace ────────────────────────────────────────────────────────

GOOGLE_SA_EMAIL = os.environ.get("GOOGLE_SERVICE_ACCOUNT_EMAIL", "")
GOOGLE_SA_KEY_RAW = os.environ.get("GOOGLE_SERVICE_ACCOUNT_KEY", "")

# Parse SA key — accepts full JSON key file content or a bare private key PEM.
# Also checks /agent/sa_config.json as a fallback (used when env vars can't be
# set on an already-running container, e.g. during a hot-update).
_GOOGLE_SA_INFO: dict = {}
_SA_CONFIG_PATH = Path("/agent/sa_config.json")

def _load_sa_info() -> dict:
    raw = GOOGLE_SA_KEY_RAW
    email = GOOGLE_SA_EMAIL
    # File-based override: wins if present
    if _SA_CONFIG_PATH.exists():
        try:
            cfg = json.loads(_SA_CONFIG_PATH.read_text())
            if isinstance(cfg, dict) and cfg.get("private_key"):
                return cfg
            if isinstance(cfg, dict) and cfg.get("key"):
                raw = cfg["key"]
                email = cfg.get("email", email)
        except Exception:
            pass
    if raw:
        try:
            return json.loads(raw)
        except (json.JSONDecodeError, ValueError):
            pass
        # Could be base64-encoded JSON
        try:
            import base64
            decoded = base64.b64decode(raw + "==").decode("utf-8")
            return json.loads(decoded)
        except Exception:
            pass
        # Bare private key PEM
        return {
            "type": "service_account",
            "client_email": email,
            "private_key": raw,
            "token_uri": "https://oauth2.googleapis.com/token",
        }
    return {}

_GOOGLE_SA_INFO = _load_sa_info()

_GOOGLE_SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/documents",
    "https://www.googleapis.com/auth/calendar",
]

_google_token_cache: dict = {"token": None, "expires_at": 0.0}


async def _get_google_access_token() -> str | None:
    """Return a valid Google OAuth access token for the service account."""
    if not _GOOGLE_SA_INFO:
        return None
    now = time.time()
    if _google_token_cache["token"] and now < _google_token_cache["expires_at"] - 60:
        return _google_token_cache["token"]

    def _refresh_sync() -> tuple[str, float]:
        from google.oauth2 import service_account
        from google.auth.transport.requests import Request as GRequest
        creds = service_account.Credentials.from_service_account_info(
            _GOOGLE_SA_INFO, scopes=_GOOGLE_SCOPES
        )
        creds.refresh(GRequest())
        exp = creds.expiry.timestamp() if creds.expiry else time.time() + 3600
        return creds.token, exp

    try:
        token, expires_at = await asyncio.to_thread(_refresh_sync)
        _google_token_cache["token"] = token
        _google_token_cache["expires_at"] = expires_at
        return token
    except Exception as exc:
        print(f"[adapter] Google auth failed: {exc}", flush=True)
        return None


async def google_sheets_read(spreadsheet_id: str, range_: str = "A1:Z1000") -> str:
    """Read a Google Sheet and return tab-separated content."""
    token = await _get_google_access_token()
    if not token:
        return "[Google Workspace not configured — no service account credentials]"
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(
            f"https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}/values/{range_}",
            headers={"Authorization": f"Bearer {token}"},
        )
        if not resp.is_success:
            return f"[Error reading sheet {spreadsheet_id}: {resp.status_code}]"
        values = resp.json().get("values", [])
        if not values:
            return "[Sheet is empty]"
        return "\n".join("\t".join(str(c) for c in row) for row in values)


async def google_sheets_write(spreadsheet_id: str, range_: str, values: list) -> str:
    """Write values to a Google Sheet range."""
    token = await _get_google_access_token()
    if not token:
        return "[Google Workspace not configured]"
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.put(
            f"https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}/values/{range_}",
            headers={"Authorization": f"Bearer {token}"},
            params={"valueInputOption": "USER_ENTERED"},
            json={"values": values},
        )
        if not resp.is_success:
            return f"[Error writing sheet {spreadsheet_id}: {resp.status_code} {resp.text[:200]}]"
        updated = resp.json().get("updatedCells", "?")
        return f"Updated {updated} cell(s) in {spreadsheet_id} range {range_}."


async def google_sheets_append(spreadsheet_id: str, range_: str, values: list) -> str:
    """Append rows to a Google Sheet."""
    token = await _get_google_access_token()
    if not token:
        return "[Google Workspace not configured]"
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            f"https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}/values/{range_}:append",
            headers={"Authorization": f"Bearer {token}"},
            params={"valueInputOption": "USER_ENTERED", "insertDataOption": "INSERT_ROWS"},
            json={"values": values},
        )
        if not resp.is_success:
            return f"[Error appending to sheet: {resp.status_code} {resp.text[:200]}]"
        return f"Appended {len(values)} row(s) to {spreadsheet_id}."


async def google_docs_read(doc_id: str) -> str:
    """Read a Google Doc and return its plain text content."""
    token = await _get_google_access_token()
    if not token:
        return "[Google Workspace not configured]"
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(
            f"https://docs.googleapis.com/v1/documents/{doc_id}",
            headers={"Authorization": f"Bearer {token}"},
        )
        if not resp.is_success:
            return f"[Error reading doc {doc_id}: {resp.status_code}]"
        content = resp.json().get("body", {}).get("content", [])
        parts = []
        for block in content:
            for el in block.get("paragraph", {}).get("elements", []):
                parts.append(el.get("textRun", {}).get("content", ""))
        return "".join(parts)[:8000]


async def google_docs_append(doc_id: str, text: str) -> str:
    """Append text to the end of a Google Doc."""
    token = await _get_google_access_token()
    if not token:
        return "[Google Workspace not configured]"
    # First get the doc to find end index
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(
            f"https://docs.googleapis.com/v1/documents/{doc_id}",
            headers={"Authorization": f"Bearer {token}"},
        )
        if not resp.is_success:
            return f"[Error reading doc {doc_id}: {resp.status_code}]"
        body = resp.json().get("body", {}).get("content", [])
        end_index = 1
        for block in body:
            ei = block.get("endIndex")
            if ei:
                end_index = ei
        # Insert text before last newline (index is 1-based, end_index is exclusive)
        insert_index = max(1, end_index - 1)
        patch = {"requests": [{"insertText": {"location": {"index": insert_index}, "text": text}}]}
        resp2 = await client.post(
            f"https://docs.googleapis.com/v1/documents/{doc_id}:batchUpdate",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            json=patch,
        )
        if not resp2.is_success:
            return f"[Error writing to doc {doc_id}: {resp2.status_code}]"
        return f"[Appended {len(text)} chars to doc {doc_id}]"


async def google_drive_search(query: str, limit: int = 10) -> str:
    """Search Google Drive files visible to the service account."""
    token = await _get_google_access_token()
    if not token:
        return "[Google Workspace not configured]"
    # Build a Drive API query — support plain text or raw q= syntax
    if not any(op in query for op in ["=", "contains", "in", "has", "trashed"]):
        q = f"name contains '{query}' and trashed = false"
    else:
        q = query
    params = f"q={q}&pageSize={limit}&fields=files(id,name,mimeType,modifiedTime,owners,size,webViewLink)"
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(
            f"https://www.googleapis.com/drive/v3/files?{params}",
            headers={"Authorization": f"Bearer {token}"},
        )
        if not resp.is_success:
            return f"[Drive search failed: {resp.status_code}]"
        files = resp.json().get("files", [])
        if not files:
            return "[No files found matching that query]"
        lines = [f"Found {len(files)} file(s):"]
        for f in files:
            lines.append(
                f"  - {f['name']} ({f.get('mimeType','').split('.')[-1]}) "
                f"| ID: {f['id']} | Modified: {f.get('modifiedTime','?')[:10]} "
                f"| Link: {f.get('webViewLink','')}"
            )
        return "\n".join(lines)


async def google_drive_get_file(file_id: str) -> str:
    """Get metadata and text content for a Drive file."""
    token = await _get_google_access_token()
    if not token:
        return "[Google Workspace not configured]"
    async with httpx.AsyncClient(timeout=30.0) as client:
        # Get metadata
        meta_resp = await client.get(
            f"https://www.googleapis.com/drive/v3/files/{file_id}"
            "?fields=id,name,mimeType,modifiedTime,owners,size,webViewLink",
            headers={"Authorization": f"Bearer {token}"},
        )
        if not meta_resp.is_success:
            return f"[Error getting file {file_id}: {meta_resp.status_code}]"
        meta = meta_resp.json()
        mime = meta.get("mimeType", "")

        info = (
            f"File: {meta.get('name')}\n"
            f"Type: {mime}\n"
            f"ID: {file_id}\n"
            f"Modified: {meta.get('modifiedTime','?')[:10]}\n"
            f"Link: {meta.get('webViewLink','')}\n"
        )

        # Try to export text content for Google native types
        if "spreadsheet" in mime:
            content = await google_sheets_read(file_id)
            return info + f"\nContent:\n{content[:4000]}"
        elif "document" in mime:
            content = await google_docs_read(file_id)
            return info + f"\nContent:\n{content[:4000]}"
        elif "presentation" in mime:
            # Export as plain text
            export_resp = await client.get(
                f"https://www.googleapis.com/drive/v3/files/{file_id}/export?mimeType=text/plain",
                headers={"Authorization": f"Bearer {token}"},
            )
            if export_resp.is_success:
                return info + f"\nContent:\n{export_resp.text[:4000]}"
        else:
            # Try plain download for text files
            dl_resp = await client.get(
                f"https://www.googleapis.com/drive/v3/files/{file_id}?alt=media",
                headers={"Authorization": f"Bearer {token}"},
            )
            if dl_resp.is_success and len(dl_resp.content) < 50_000:
                try:
                    return info + f"\nContent:\n{dl_resp.text[:4000]}"
                except Exception:
                    pass
        return info + "\n[Binary file — content not extracted]"


async def google_calendar_list_events(
    calendar_id: str = "primary",
    time_min: str | None = None,
    time_max: str | None = None,
    max_results: int = 20,
) -> str:
    """List Google Calendar events in a time range."""
    token = await _get_google_access_token()
    if not token:
        return "[Google Workspace not configured]"
    import urllib.parse
    now = datetime.datetime.utcnow()
    t_min = time_min or now.strftime("%Y-%m-%dT00:00:00Z")
    t_max = time_max or (now + datetime.timedelta(days=7)).strftime("%Y-%m-%dT23:59:59Z")
    params = urllib.parse.urlencode({
        "timeMin": t_min,
        "timeMax": t_max,
        "maxResults": max_results,
        "singleEvents": "true",
        "orderBy": "startTime",
        "fields": "items(id,summary,description,start,end,attendees,location,status)",
    })
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(
            f"https://www.googleapis.com/calendar/v3/calendars/{urllib.parse.quote(calendar_id)}/events?{params}",
            headers={"Authorization": f"Bearer {token}"},
        )
        if not resp.is_success:
            return f"[Calendar list failed ({resp.status_code}): share your calendar with {GOOGLE_SA_EMAIL}]"
        items = resp.json().get("items", [])
        if not items:
            return f"[No events found between {t_min[:10]} and {t_max[:10]}]"
        lines = [f"Calendar events ({t_min[:10]} → {t_max[:10]}):"]
        for ev in items:
            start = ev.get("start", {})
            end = ev.get("end", {})
            start_str = start.get("dateTime", start.get("date", "?"))[:16]
            end_str = end.get("dateTime", end.get("date", "?"))[:16]
            attendees = [a.get("email","") for a in ev.get("attendees", [])]
            att_str = f" | Attendees: {', '.join(attendees)}" if attendees else ""
            loc = f" | Location: {ev['location']}" if ev.get("location") else ""
            lines.append(f"  [{ev['id']}] {ev.get('summary','(no title)')} — {start_str} → {end_str}{loc}{att_str}")
        return "\n".join(lines)


async def google_calendar_create_event(
    calendar_id: str = "primary",
    summary: str = "",
    description: str = "",
    start: str = "",
    end: str = "",
    attendees: list | None = None,
    location: str = "",
    timezone: str = "UTC",
) -> str:
    """Create a Google Calendar event."""
    token = await _get_google_access_token()
    if not token:
        return "[Google Workspace not configured]"
    import urllib.parse
    body: dict = {
        "summary": summary,
        "description": description,
        "start": {"dateTime": start, "timeZone": timezone} if "T" in start else {"date": start},
        "end": {"dateTime": end, "timeZone": timezone} if "T" in end else {"date": end},
    }
    if location:
        body["location"] = location
    if attendees:
        body["attendees"] = [{"email": a} for a in attendees]
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            f"https://www.googleapis.com/calendar/v3/calendars/{urllib.parse.quote(calendar_id)}/events",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            json=body,
        )
        if not resp.is_success:
            return f"[Calendar create failed ({resp.status_code}): {resp.text[:200]}]"
        ev = resp.json()
        return f"[Created event '{ev.get('summary')}' — ID: {ev.get('id')} | Link: {ev.get('htmlLink','')}]"


async def google_calendar_update_event(
    event_id: str,
    calendar_id: str = "primary",
    summary: str | None = None,
    description: str | None = None,
    start: str | None = None,
    end: str | None = None,
    location: str | None = None,
    timezone: str = "UTC",
) -> str:
    """Update an existing Google Calendar event (partial update)."""
    token = await _get_google_access_token()
    if not token:
        return "[Google Workspace not configured]"
    import urllib.parse
    patch: dict = {}
    if summary is not None:
        patch["summary"] = summary
    if description is not None:
        patch["description"] = description
    if location is not None:
        patch["location"] = location
    if start is not None:
        patch["start"] = {"dateTime": start, "timeZone": timezone} if "T" in start else {"date": start}
    if end is not None:
        patch["end"] = {"dateTime": end, "timeZone": timezone} if "T" in end else {"date": end}
    if not patch:
        return "[No fields to update]"
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.patch(
            f"https://www.googleapis.com/calendar/v3/calendars/{urllib.parse.quote(calendar_id)}/events/{event_id}",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            json=patch,
        )
        if not resp.is_success:
            return f"[Calendar update failed ({resp.status_code}): {resp.text[:200]}]"
        ev = resp.json()
        return f"[Updated event '{ev.get('summary')}' ({event_id})]"


async def google_calendar_delete_event(event_id: str, calendar_id: str = "primary") -> str:
    """Delete a Google Calendar event."""
    token = await _get_google_access_token()
    if not token:
        return "[Google Workspace not configured]"
    import urllib.parse
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.delete(
            f"https://www.googleapis.com/calendar/v3/calendars/{urllib.parse.quote(calendar_id)}/events/{event_id}",
            headers={"Authorization": f"Bearer {token}"},
        )
        if resp.status_code == 204:
            return f"[Deleted event {event_id}]"
        return f"[Calendar delete failed ({resp.status_code}): {resp.text[:200]}]"


# Google URL patterns for context enrichment
_GOOGLE_SHEETS_RE = re.compile(r"docs\.google\.com/spreadsheets/d/([a-zA-Z0-9_-]+)")
_GOOGLE_DOCS_RE = re.compile(r"docs\.google\.com/document/d/([a-zA-Z0-9_-]+)")
_GOOGLE_DRIVE_RE = re.compile(r"drive\.google\.com/(?:file/d/|open\?id=)([a-zA-Z0-9_-]+)")


_CALENDAR_KEYWORDS = re.compile(
    r"\b(schedul|calendar|meeting|availab|free slot|busy|appointment|event|book a|"
    r"set up a call|block time|when are you|what('s| is) on|remind me|rsvp|invite)\b",
    re.IGNORECASE,
)


async def _enrich_with_google_content(message: str) -> str:
    """Pre-fetch Google file content and calendar data relevant to the message."""
    if not _GOOGLE_SA_INFO:
        return message

    additions = []
    seen_ids: set[str] = set()

    # Sheets URLs
    for match in _GOOGLE_SHEETS_RE.finditer(message):
        fid = match.group(1)
        if fid not in seen_ids:
            seen_ids.add(fid)
            try:
                content = await google_sheets_read(fid)
                additions.append(f"\n\n[Google Sheet {fid} — pre-fetched]:\n{content[:4000]}")
            except Exception as exc:
                print(f"[adapter] Sheet pre-fetch {fid} failed: {exc}", flush=True)

    # Docs URLs
    for match in _GOOGLE_DOCS_RE.finditer(message):
        fid = match.group(1)
        if fid not in seen_ids:
            seen_ids.add(fid)
            try:
                content = await google_docs_read(fid)
                additions.append(f"\n\n[Google Doc {fid} — pre-fetched]:\n{content[:4000]}")
            except Exception as exc:
                print(f"[adapter] Doc pre-fetch {fid} failed: {exc}", flush=True)

    # Drive file URLs
    for match in _GOOGLE_DRIVE_RE.finditer(message):
        fid = match.group(1)
        if fid not in seen_ids:
            seen_ids.add(fid)
            try:
                content = await google_drive_get_file(fid)
                additions.append(f"\n\n[Google Drive file {fid} — pre-fetched]:\n{content[:4000]}")
            except Exception as exc:
                print(f"[adapter] Drive pre-fetch {fid} failed: {exc}", flush=True)

    # Proactive calendar fetch when message mentions scheduling
    if _CALENDAR_KEYWORDS.search(message):
        try:
            now = datetime.datetime.utcnow()
            t_min = now.strftime("%Y-%m-%dT00:00:00Z")
            t_max = (now + datetime.timedelta(days=7)).strftime("%Y-%m-%dT23:59:59Z")
            cal_content = await google_calendar_list_events(time_min=t_min, time_max=t_max)
            additions.append(f"\n\n[Calendar — next 7 days, pre-fetched]:\n{cal_content}")
        except Exception as exc:
            print(f"[adapter] Calendar pre-fetch failed: {exc}", flush=True)

    if additions:
        return message + "".join(additions)
    return message


async def _execute_google_reads(read_requests: list[dict]) -> str:
    """Execute read requests from the agent and return results as a formatted string."""
    parts = []
    for req in read_requests:
        req_type = req.get("type", "")
        try:
            if req_type == "drive_search":
                r = await google_drive_search(req.get("query", ""), req.get("limit", 10))
                parts.append(f"[Drive search '{req.get('query')}']:\n{r}")
            elif req_type == "drive_get_file":
                r = await google_drive_get_file(req["file_id"])
                parts.append(f"[Drive file {req['file_id']}]:\n{r}")
            elif req_type == "sheets_read":
                r = await google_sheets_read(req["file_id"], req.get("range", "A1:Z1000"))
                parts.append(f"[Sheet {req['file_id']} {req.get('range','')}]:\n{r}")
            elif req_type == "docs_read":
                r = await google_docs_read(req["file_id"])
                parts.append(f"[Doc {req['file_id']}]:\n{r[:4000]}")
            elif req_type == "calendar_list":
                r = await google_calendar_list_events(
                    req.get("calendar_id", "primary"),
                    req.get("time_min"),
                    req.get("time_max"),
                    req.get("max_results", 20),
                )
                parts.append(f"[Calendar events]:\n{r}")
        except Exception as exc:
            parts.append(f"[{req_type} failed: {exc}]")
    return "\n\n".join(parts)


async def _execute_google_writes(google_writes: list[dict]) -> list[str]:
    """Execute a list of Google write/action operations returned by the agent."""
    results = []
    for op in google_writes:
        op_type = op.get("type", "")
        try:
            if op_type == "sheets_write":
                r = await google_sheets_write(op["file_id"], op["range"], op["values"])
            elif op_type == "sheets_append":
                r = await google_sheets_append(op["file_id"], op["range"], op["values"])
            elif op_type == "docs_append":
                r = await google_docs_append(op["file_id"], op["text"])
            elif op_type == "calendar_create":
                r = await google_calendar_create_event(
                    calendar_id=op.get("calendar_id", "primary"),
                    summary=op.get("summary", ""),
                    description=op.get("description", ""),
                    start=op.get("start", ""),
                    end=op.get("end", ""),
                    attendees=op.get("attendees"),
                    location=op.get("location", ""),
                    timezone=op.get("timezone", "UTC"),
                )
            elif op_type == "calendar_update":
                r = await google_calendar_update_event(
                    event_id=op["event_id"],
                    calendar_id=op.get("calendar_id", "primary"),
                    summary=op.get("summary"),
                    description=op.get("description"),
                    start=op.get("start"),
                    end=op.get("end"),
                    location=op.get("location"),
                    timezone=op.get("timezone", "UTC"),
                )
            elif op_type == "calendar_delete":
                r = await google_calendar_delete_event(
                    event_id=op["event_id"],
                    calendar_id=op.get("calendar_id", "primary"),
                )
            else:
                r = f"[Unknown op type: {op_type}]"
            results.append(r)
        except Exception as exc:
            results.append(f"[Google op '{op_type}' failed: {exc}]")
    return results


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
    """Send an email via the AgentMail API with both text + HTML bodies."""
    client = _get_client()
    clean_text = scrub_placeholders(text)
    clean_subject = scrub_placeholders(subject)
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
    """Reply to a specific inbound message via the AgentMail API.

    AgentMail's reply endpoint is message-scoped:
      POST /v0/inboxes/{inbox_id}/messages/{message_id}/reply

    If ``message_id`` is missing or the endpoint fails, falls back to
    ``send_email`` with the original thread_id so the message still threads
    correctly on the recipient's side.
    """
    client = _get_client()
    clean_text = scrub_placeholders(text)

    if message_id:
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

        # Enrich message with Google file content if any Drive/Sheets/Docs URLs detected
        enriched_message = await _enrich_with_google_content(message)
        if enriched_message != message:
            print("[adapter] Enriched message with Google file content", flush=True)

        # Pass Google capabilities info to the context so the agent knows what's available
        google_tools_available = bool(_GOOGLE_SA_INFO)
        context = {
            **context,
            "google_tools_available": google_tools_available,
            "google_sa_email": GOOGLE_SA_EMAIL if google_tools_available else "",
        }

        print(f"[adapter] Running agent graph...", flush=True)
        result = await run_agent(
            content=enriched_message,
            context=context,
            approve_fn=_bypass_approve,
            resolve_fn=_bypass_resolve,
            contribute_fn=contribute_knowledge,
            search_fn=search_knowledge,
        )

        if not isinstance(result, dict):
            print(f"[adapter] run_agent returned non-dict ({type(result).__name__}) — skipping", flush=True)
            return

        # ── Google read-request second pass ──────────────────────────────────
        # If the agent returned google_read_requests (e.g. drive_search, calendar_list,
        # docs_read), execute them and re-run the agent with the fetched data so it
        # can compose an informed response. Limited to one extra pass to avoid loops.
        google_read_requests = result.get("google_read_requests") or []
        if google_read_requests and _GOOGLE_SA_INFO:
            print(f"[adapter] Agent requested {len(google_read_requests)} Google read(s) — fetching...", flush=True)
            try:
                read_data = await _execute_google_reads(google_read_requests)
                enriched2 = enriched_message + f"\n\n[Google Data Retrieved]\n{read_data}"
                result = await run_agent(
                    content=enriched2,
                    context=context,
                    approve_fn=_bypass_approve,
                    resolve_fn=_bypass_resolve,
                    contribute_fn=contribute_knowledge,
                    search_fn=search_knowledge,
                )
                if not isinstance(result, dict):
                    print(f"[adapter] Second-pass run_agent returned non-dict — skipping", flush=True)
                    return
                print(f"[adapter] Second pass complete", flush=True)
            except Exception as exc:
                print(f"[adapter] Google read-request second pass failed: {exc}", flush=True)

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

            # Execute any Google write operations the agent requested
            google_writes = result.get("google_writes") or []
            if google_writes:
                write_results = await _execute_google_writes(google_writes)
                print(f"[adapter] Google writes: {write_results}", flush=True)

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
                    enriched_message
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
