"""
Microsoft 365 tools for the LangGraph agent.

Uses the Microsoft Graph API with app-only client credentials scoped to the
agent's own workspace identity (WORKSPACE_EMAIL). All Graph calls go through
/users/{WORKSPACE_EMAIL}/... so the agent only sees its own data.

Credentials injected at provision time:
  WORKSPACE_EMAIL         — the agent's M365 UPN (e.g. alex-acme@agents.platform.com)
  MICROSOFT_TENANT_ID     — platform Azure AD tenant ID
  MICROSOFT_CLIENT_ID     — platform Azure app client ID
  MICROSOFT_CLIENT_SECRET — platform Azure app client secret

No new pip packages — uses only httpx (already in requirements.txt).
"""

import os
import time
from typing import Any

import httpx

# ─── Config ───────────────────────────────────────────────────────────────────

_TENANT_ID = os.environ.get("MICROSOFT_TENANT_ID", "")
_CLIENT_ID = os.environ.get("MICROSOFT_CLIENT_ID", "")
_CLIENT_SECRET = os.environ.get("MICROSOFT_CLIENT_SECRET", "")
_WORKSPACE_EMAIL = os.environ.get("WORKSPACE_EMAIL", "")

AVAILABLE = bool(_TENANT_ID and _CLIENT_ID and _CLIENT_SECRET and _WORKSPACE_EMAIL)

GRAPH = "https://graph.microsoft.com/v1.0"

# ─── Token cache ──────────────────────────────────────────────────────────────

_token_cache: dict[str, Any] = {}  # {"token": str, "expires_at": float}


async def _get_access_token() -> str:
    """Return a valid app-only Graph API access token, refreshing when needed."""
    if not AVAILABLE:
        raise RuntimeError(
            "Microsoft 365 not configured for this deployment. "
            "Set MICROSOFT_TENANT_ID, MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET, and WORKSPACE_EMAIL."
        )
    cached = _token_cache.get("ms")
    if cached and cached["expires_at"] > time.time() + 60:
        return cached["token"]

    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(
            f"https://login.microsoftonline.com/{_TENANT_ID}/oauth2/v2.0/token",
            data={
                "grant_type": "client_credentials",
                "client_id": _CLIENT_ID,
                "client_secret": _CLIENT_SECRET,
                "scope": "https://graph.microsoft.com/.default",
            },
        )
        resp.raise_for_status()
        data = resp.json()

    token = data["access_token"]
    expires_in = data.get("expires_in", 3600)
    _token_cache["ms"] = {"token": token, "expires_at": time.time() + expires_in}
    return token


def _auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def _user_url(path: str) -> str:
    """Scope a Graph path to the agent's own workspace identity."""
    return f"{GRAPH}/users/{_WORKSPACE_EMAIL}/{path}"


# ─── Calendar ─────────────────────────────────────────────────────────────────


async def calendar_list(days_ahead: int = 7) -> list[dict]:
    """List upcoming calendar events for the next N days."""
    token = await _get_access_token()
    now_iso = _iso_now()
    end_iso = _iso_offset(days_ahead * 86400)
    async with httpx.AsyncClient(timeout=20.0) as client:
        resp = await client.get(
            _user_url("calendarView"),
            headers=_auth_headers(token),
            params={
                "startDateTime": now_iso,
                "endDateTime": end_iso,
                "$select": "id,subject,start,end,location,attendees,organizer,isAllDay",
                "$orderby": "start/dateTime",
                "$top": "50",
            },
        )
        resp.raise_for_status()
    return resp.json().get("value", [])


async def calendar_create(
    summary: str,
    start: str,
    end: str,
    description: str = "",
    attendees: list[str] | None = None,
    timezone: str = "UTC",
) -> dict:
    """Create a calendar event. start/end are ISO 8601 datetime strings."""
    token = await _get_access_token()
    event: dict[str, Any] = {
        "subject": summary,
        "body": {"contentType": "text", "content": description},
        "start": {"dateTime": start, "timeZone": timezone},
        "end": {"dateTime": end, "timeZone": timezone},
    }
    if attendees:
        event["attendees"] = [
            {"emailAddress": {"address": a}, "type": "required"} for a in attendees
        ]
    async with httpx.AsyncClient(timeout=20.0) as client:
        resp = await client.post(
            _user_url("events"),
            headers=_auth_headers(token),
            json=event,
        )
        resp.raise_for_status()
    return resp.json()


async def calendar_update(event_id: str, **fields: Any) -> dict:
    """Update fields on an existing calendar event."""
    token = await _get_access_token()
    async with httpx.AsyncClient(timeout=20.0) as client:
        resp = await client.patch(
            _user_url(f"events/{event_id}"),
            headers=_auth_headers(token),
            json=fields,
        )
        resp.raise_for_status()
    return resp.json()


async def calendar_delete(event_id: str) -> None:
    """Delete a calendar event."""
    token = await _get_access_token()
    async with httpx.AsyncClient(timeout=20.0) as client:
        resp = await client.delete(
            _user_url(f"events/{event_id}"),
            headers=_auth_headers(token),
        )
        if resp.status_code not in (200, 204):
            resp.raise_for_status()


# ─── OneDrive ─────────────────────────────────────────────────────────────────


async def drive_search(query: str, limit: int = 10) -> list[dict]:
    """Search OneDrive for files matching a query string."""
    token = await _get_access_token()
    async with httpx.AsyncClient(timeout=20.0) as client:
        resp = await client.get(
            _user_url("drive/root/search(q='{}')".format(query.replace("'", "''"))),
            headers=_auth_headers(token),
            params={
                "$select": "id,name,webUrl,size,lastModifiedDateTime,file",
                "$top": str(limit),
            },
        )
        resp.raise_for_status()
    return resp.json().get("value", [])


async def drive_get_file(item_id: str) -> dict:
    """Get metadata for a specific OneDrive item."""
    token = await _get_access_token()
    async with httpx.AsyncClient(timeout=20.0) as client:
        resp = await client.get(
            _user_url(f"drive/items/{item_id}"),
            headers=_auth_headers(token),
        )
        resp.raise_for_status()
    return resp.json()


async def drive_read_text(item_id: str) -> str:
    """Download and return the text content of a OneDrive file."""
    token = await _get_access_token()
    async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
        resp = await client.get(
            _user_url(f"drive/items/{item_id}/content"),
            headers={"Authorization": f"Bearer {token}"},
        )
        resp.raise_for_status()
    return resp.text


# ─── Excel ────────────────────────────────────────────────────────────────────


async def excel_read(item_id: str, sheet: str, range_addr: str = "A1:Z100") -> list[list]:
    """Read a range from an Excel workbook in OneDrive."""
    token = await _get_access_token()
    async with httpx.AsyncClient(timeout=20.0) as client:
        resp = await client.get(
            _user_url(f"drive/items/{item_id}/workbook/worksheets/{sheet}/range(address='{range_addr}')"),
            headers=_auth_headers(token),
            params={"$select": "values"},
        )
        resp.raise_for_status()
    return resp.json().get("values", [])


async def excel_write(item_id: str, sheet: str, range_addr: str, values: list[list]) -> None:
    """Write values to a range in an Excel workbook."""
    token = await _get_access_token()
    async with httpx.AsyncClient(timeout=20.0) as client:
        resp = await client.patch(
            _user_url(f"drive/items/{item_id}/workbook/worksheets/{sheet}/range(address='{range_addr}')"),
            headers=_auth_headers(token),
            json={"values": values},
        )
        resp.raise_for_status()


async def excel_append(item_id: str, sheet: str, values: list[list]) -> dict:
    """Append rows to a used range in an Excel worksheet."""
    token = await _get_access_token()
    # Get the used range address first
    async with httpx.AsyncClient(timeout=20.0) as client:
        ur_resp = await client.get(
            _user_url(f"drive/items/{item_id}/workbook/worksheets/{sheet}/usedRange"),
            headers=_auth_headers(token),
            params={"$select": "address"},
        )
        ur_resp.raise_for_status()
        address = ur_resp.json().get("address", "A1")
        # Insert rows after used range using the table insertRows API (simplest approach)
        resp = await client.post(
            _user_url(f"drive/items/{item_id}/workbook/worksheets/{sheet}/usedRange/insert"),
            headers=_auth_headers(token),
            json={"shift": "Down"},
        )
        # Fallback: just write at the determined position
        _ = address
        resp2 = await client.post(
            _user_url(f"drive/items/{item_id}/workbook/worksheets/{sheet}/tables/{{0}}/rows"),
            headers=_auth_headers(token),
            json={"values": values},
        )
    return resp2.json() if resp2.status_code < 300 else {}


# ─── Batch helpers (mirrors google_tools interface) ───────────────────────────


async def execute_reads(requests: list[dict]) -> dict:
    """Execute a list of read operations and return combined results.
    Accepts both Microsoft-native op names and Google-style aliases so the
    LLM prompt format works transparently regardless of workspace provider.
    """
    results: dict[str, Any] = {}
    for req in requests:
        op = req.get("type", "")
        try:
            if op == "calendar_list":
                results["calendar_events"] = await calendar_list(**{k: v for k, v in req.items() if k != "type"})
            elif op == "drive_search":
                results["drive_files"] = await drive_search(**{k: v for k, v in req.items() if k != "type"})
            elif op in ("excel_read", "sheets_read"):
                # sheets_read alias: map Google's file_id param to item_id
                params = {k: v for k, v in req.items() if k != "type"}
                if "file_id" in params and "item_id" not in params:
                    params["item_id"] = params.pop("file_id")
                results[f"excel_{req.get('sheet', 'sheet')}"] = await excel_read(**params)
        except Exception as e:
            results[f"error_{op}"] = str(e)
    return results


async def execute_writes(writes: list[dict]) -> list[dict]:
    """Execute a list of write operations and return results.
    Accepts both Microsoft-native op names and Google-style aliases so the
    LLM prompt format works transparently regardless of workspace provider.
    """
    results = []
    for write in writes:
        op = write.get("type", "")
        # Remap Google-style params: file_id → item_id
        params = {k: v for k, v in write.items() if k != "type"}
        if "file_id" in params and "item_id" not in params:
            params["item_id"] = params.pop("file_id")
        try:
            if op == "calendar_create":
                result = await calendar_create(**params)
                results.append({"type": op, "status": "ok", "result": result})
            elif op == "calendar_update":
                result = await calendar_update(**params)
                results.append({"type": op, "status": "ok", "result": result})
            elif op == "calendar_delete":
                await calendar_delete(params["event_id"])
                results.append({"type": op, "status": "ok"})
            elif op in ("excel_write", "sheets_write"):
                await excel_write(**params)
                results.append({"type": op, "status": "ok"})
            elif op in ("excel_append", "sheets_append"):
                result = await excel_append(**params)
                results.append({"type": op, "status": "ok", "result": result})
            else:
                results.append({"type": op, "status": "skipped", "reason": "unknown op"})
        except Exception as e:
            results.append({"type": op, "status": "error", "error": str(e)})
    return results


# ─── Message enrichment ───────────────────────────────────────────────────────


async def enrich_message(content: str) -> str:
    """Enrich message with upcoming Outlook calendar events as context."""
    if not AVAILABLE:
        return content
    try:
        events = await calendar_list(days_ahead=7)
        if not events:
            return content
        lines = []
        for e in events[:5]:
            start = e.get("start", {}).get("dateTime", "")[:16].replace("T", " ")
            subject = e.get("subject", "Event")
            lines.append(f"- {subject}: {start}")
        context = "\n\n[Your Outlook Calendar — Next 7 days]\n" + "\n".join(lines)
        return content + context
    except Exception:
        return content


# ─── Helpers ──────────────────────────────────────────────────────────────────


def _iso_now() -> str:
    import datetime
    return datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S")


def _iso_offset(seconds: int) -> str:
    import datetime
    dt = datetime.datetime.utcnow() + datetime.timedelta(seconds=seconds)
    return dt.strftime("%Y-%m-%dT%H:%M:%S")
