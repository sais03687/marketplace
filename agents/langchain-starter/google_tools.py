"""
Google Workspace tools for the LangGraph agent.

All Google API calls live here so the adapter stays a thin email bridge.
The SA credentials are injected by the platform at provision time:
  GOOGLE_SERVICE_ACCOUNT_EMAIL — the service account email
  GOOGLE_SERVICE_ACCOUNT_KEY   — the full service account JSON key (as a string)

To give this agent access to a file or calendar, share it with the SA email.
"""

import json
import os
import re
import time
import base64
from typing import Any

import httpx

# ─── SA Credential Loading ────────────────────────────────────────────────────

_SA_EMAIL = os.environ.get("GOOGLE_SERVICE_ACCOUNT_EMAIL", "")
_SA_KEY_RAW = os.environ.get("GOOGLE_SERVICE_ACCOUNT_KEY", "")

_SA_INFO: dict = {}
if _SA_KEY_RAW:
    try:
        _SA_INFO = json.loads(_SA_KEY_RAW)
    except (json.JSONDecodeError, ValueError):
        # Maybe base64-encoded
        try:
            _SA_INFO = json.loads(base64.b64decode(_SA_KEY_RAW).decode())
        except Exception:
            pass

AVAILABLE = bool(_SA_INFO and _SA_INFO.get("private_key"))

# ─── OAuth2 Token Cache ───────────────────────────────────────────────────────

_token_cache: dict[str, dict] = {}  # scope → {"token": str, "expires_at": float}

GOOGLE_SCOPES = {
    "drive":    "https://www.googleapis.com/auth/drive",
    "sheets":   "https://www.googleapis.com/auth/spreadsheets",
    "docs":     "https://www.googleapis.com/auth/documents",
    "calendar": "https://www.googleapis.com/auth/calendar",
}


def _make_jwt(sa_info: dict, scope: str) -> str:
    """Create a self-signed JWT for the service account."""
    import struct
    try:
        from cryptography.hazmat.primitives.serialization import load_pem_private_key
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives.asymmetric import padding
    except ImportError:
        raise RuntimeError(
            "cryptography package required for Google SA auth. "
            "Add 'cryptography' to requirements.txt."
        )

    now = int(time.time())
    header = {"alg": "RS256", "typ": "JWT"}
    payload = {
        "iss": sa_info["client_email"],
        "scope": scope,
        "aud": "https://oauth2.googleapis.com/token",
        "iat": now,
        "exp": now + 3600,
    }

    def b64url(data: bytes) -> str:
        return base64.urlsafe_b64encode(data).rstrip(b"=").decode()

    h = b64url(json.dumps(header).encode())
    p = b64url(json.dumps(payload).encode())
    signing_input = f"{h}.{p}".encode()

    private_key = load_pem_private_key(sa_info["private_key"].encode(), password=None)
    signature = private_key.sign(signing_input, padding.PKCS1v15(), hashes.SHA256())
    return f"{h}.{p}.{b64url(signature)}"


async def get_access_token(scope_key: str) -> str:
    """Return a valid OAuth2 access token for the given scope key.

    scope_key is one of: 'drive', 'sheets', 'docs', 'calendar'
    Tokens are cached and refreshed automatically.
    """
    if not AVAILABLE:
        raise RuntimeError(
            "Google service account not configured. "
            f"Share your files/calendar with {_SA_EMAIL or 'the SA email shown in your context'}."
        )

    scope = GOOGLE_SCOPES.get(scope_key)
    if not scope:
        raise ValueError(f"Unknown scope key: {scope_key}")

    cached = _token_cache.get(scope_key)
    if cached and cached["expires_at"] > time.time() + 60:
        return cached["token"]

    jwt = _make_jwt(_SA_INFO, scope)
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(
            "https://oauth2.googleapis.com/token",
            data={
                "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
                "assertion": jwt,
            },
        )
        resp.raise_for_status()
        data = resp.json()

    token = data["access_token"]
    _token_cache[scope_key] = {
        "token": token,
        "expires_at": time.time() + data.get("expires_in", 3600),
    }
    return token


def _auth_headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


# ─── Google Drive ─────────────────────────────────────────────────────────────

async def drive_search(query: str, limit: int = 5) -> list[dict]:
    """Search Drive files accessible to the SA.

    Returns a list of {id, name, mimeType, webViewLink} dicts.
    """
    token = await get_access_token("drive")
    params = {
        "q": query,
        "pageSize": str(min(limit, 20)),
        "fields": "files(id,name,mimeType,webViewLink,modifiedTime)",
        "orderBy": "modifiedTime desc",
    }
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.get(
            "https://www.googleapis.com/drive/v3/files",
            params=params,
            headers=_auth_headers(token),
        )
        resp.raise_for_status()
        return resp.json().get("files", [])


async def drive_get_file(file_id: str) -> dict:
    """Get file metadata from Drive."""
    token = await get_access_token("drive")
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.get(
            f"https://www.googleapis.com/drive/v3/files/{file_id}",
            params={"fields": "id,name,mimeType,webViewLink,size,modifiedTime"},
            headers=_auth_headers(token),
        )
        resp.raise_for_status()
        return resp.json()


async def drive_export_text(file_id: str, mime_type: str) -> str:
    """Export a Google Doc/Sheet/Slide as plain text."""
    token = await get_access_token("drive")
    export_formats = {
        "application/vnd.google-apps.document":     "text/plain",
        "application/vnd.google-apps.spreadsheet":  "text/csv",
        "application/vnd.google-apps.presentation": "text/plain",
    }
    export_mime = export_formats.get(mime_type, "text/plain")
    async with httpx.AsyncClient(timeout=20.0) as client:
        resp = await client.get(
            f"https://www.googleapis.com/drive/v3/files/{file_id}/export",
            params={"mimeType": export_mime},
            headers={"Authorization": f"Bearer {token}"},
        )
        resp.raise_for_status()
        return resp.text[:8000]  # cap to avoid context overflow


# ─── Google Sheets ────────────────────────────────────────────────────────────

async def sheets_read(file_id: str, range_: str = "A1:Z100") -> list[list]:
    """Read a range from a Google Sheet. Returns a 2D list of cell values."""
    token = await get_access_token("sheets")
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.get(
            f"https://sheets.googleapis.com/v4/spreadsheets/{file_id}/values/{range_}",
            headers=_auth_headers(token),
        )
        resp.raise_for_status()
        return resp.json().get("values", [])


async def sheets_write(file_id: str, range_: str, values: list[list]) -> dict:
    """Write values to a range in a Google Sheet (overwrites)."""
    token = await get_access_token("sheets")
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.put(
            f"https://sheets.googleapis.com/v4/spreadsheets/{file_id}/values/{range_}",
            params={"valueInputOption": "USER_ENTERED"},
            json={"range": range_, "majorDimension": "ROWS", "values": values},
            headers=_auth_headers(token),
        )
        resp.raise_for_status()
        return resp.json()


async def sheets_append(file_id: str, range_: str, values: list[list]) -> dict:
    """Append rows to a sheet without overwriting existing data."""
    token = await get_access_token("sheets")
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(
            f"https://sheets.googleapis.com/v4/spreadsheets/{file_id}/values/{range_}:append",
            params={"valueInputOption": "USER_ENTERED", "insertDataOption": "INSERT_ROWS"},
            json={"majorDimension": "ROWS", "values": values},
            headers=_auth_headers(token),
        )
        resp.raise_for_status()
        return resp.json()


# ─── Google Docs ──────────────────────────────────────────────────────────────

async def docs_read(file_id: str) -> str:
    """Read the full text of a Google Doc."""
    token = await get_access_token("docs")
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.get(
            f"https://docs.googleapis.com/v1/documents/{file_id}",
            headers=_auth_headers(token),
        )
        resp.raise_for_status()
        doc = resp.json()

    # Extract plain text from the document body
    parts: list[str] = []
    for elem in doc.get("body", {}).get("content", []):
        para = elem.get("paragraph", {})
        for pe in para.get("elements", []):
            text_run = pe.get("textRun", {})
            content = text_run.get("content", "")
            if content:
                parts.append(content)
    return "".join(parts)[:8000]


async def docs_append(file_id: str, text: str) -> dict:
    """Append text to the end of a Google Doc."""
    token = await get_access_token("docs")
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(
            f"https://docs.googleapis.com/v1/documents/{file_id}:batchUpdate",
            json={
                "requests": [
                    {
                        "insertText": {
                            "location": {"index": 1},
                            "text": "\n" + text,
                        }
                    }
                ]
            },
            headers=_auth_headers(token),
        )
        resp.raise_for_status()
        return resp.json()


# ─── Google Calendar ──────────────────────────────────────────────────────────

async def calendar_list(
    time_min: str,
    time_max: str,
    calendar_id: str = "primary",
) -> list[dict]:
    """List calendar events in a time range.

    time_min / time_max should be ISO 8601 with timezone, e.g. '2026-05-16T00:00:00Z'
    Returns a list of event dicts.
    """
    token = await get_access_token("calendar")
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.get(
            f"https://www.googleapis.com/calendar/v3/calendars/{calendar_id}/events",
            params={
                "timeMin": time_min,
                "timeMax": time_max,
                "singleEvents": "true",
                "orderBy": "startTime",
                "maxResults": "20",
            },
            headers=_auth_headers(token),
        )
        resp.raise_for_status()
        return resp.json().get("items", [])


async def calendar_create(
    summary: str,
    start: str,
    end: str,
    description: str = "",
    attendees: list[str] | None = None,
    timezone: str = "UTC",
    calendar_id: str = "primary",
) -> dict:
    """Create a calendar event. Returns the created event dict."""
    token = await get_access_token("calendar")
    event: dict = {
        "summary": summary,
        "description": description,
        "start": {"dateTime": start, "timeZone": timezone},
        "end": {"dateTime": end, "timeZone": timezone},
    }
    if attendees:
        event["attendees"] = [{"email": e} for e in attendees]

    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(
            f"https://www.googleapis.com/calendar/v3/calendars/{calendar_id}/events",
            json=event,
            headers=_auth_headers(token),
        )
        resp.raise_for_status()
        return resp.json()


async def calendar_update(
    event_id: str,
    calendar_id: str = "primary",
    **fields,
) -> dict:
    """Update fields on an existing calendar event."""
    token = await get_access_token("calendar")
    async with httpx.AsyncClient(timeout=15.0) as client:
        # Patch only the provided fields
        resp = await client.patch(
            f"https://www.googleapis.com/calendar/v3/calendars/{calendar_id}/events/{event_id}",
            json=fields,
            headers=_auth_headers(token),
        )
        resp.raise_for_status()
        return resp.json()


async def calendar_delete(event_id: str, calendar_id: str = "primary") -> None:
    """Delete a calendar event."""
    token = await get_access_token("calendar")
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.delete(
            f"https://www.googleapis.com/calendar/v3/calendars/{calendar_id}/events/{event_id}",
            headers=_auth_headers(token),
        )
        resp.raise_for_status()


# ─── URL Detection & Passive Enrichment ──────────────────────────────────────

_DRIVE_URL_RE = re.compile(
    r"https://(?:docs|drive|sheets)\.google\.com/"
    r"(?:document|spreadsheets|presentation|file)/d/([A-Za-z0-9_-]{25,})"
)
_CALENDAR_KEYWORDS = re.compile(
    r"\b(schedule|calendar|meeting|event|availability|free\s*slot|busy)\b",
    re.IGNORECASE,
)


def _extract_file_ids(text: str) -> list[tuple[str, str]]:
    """Return [(file_id, original_url), ...] for all Google URLs found in text."""
    return [(m.group(1), m.group(0)) for m in _DRIVE_URL_RE.finditer(text)]


async def enrich_message(message: str) -> str:
    """Auto-fetch Google file content for any Drive/Docs/Sheets URLs in the message.

    Returns the enriched message with file contents appended.
    """
    if not AVAILABLE:
        return message

    file_ids = _extract_file_ids(message)
    if not file_ids:
        return message

    enrichments: list[str] = []
    for file_id, url in file_ids:
        try:
            meta = await drive_get_file(file_id)
            mime = meta.get("mimeType", "")
            name = meta.get("name", file_id)
            if "google-apps" in mime:
                text = await drive_export_text(file_id, mime)
                enrichments.append(f"\n[{name}]\n{text}")
            else:
                enrichments.append(f"\n[{name}] (binary file — metadata only: {meta})")
        except Exception as exc:
            enrichments.append(f"\n[File {file_id}] Could not fetch: {exc}")

    if enrichments:
        return message + "\n\n[Google file content attached]\n" + "".join(enrichments)
    return message


# ─── Execute Read/Write Batches ───────────────────────────────────────────────

async def execute_reads(requests: list[dict]) -> str:
    """Execute a list of google_read_requests and return a formatted text block.

    Each request is a dict with a 'type' key. Supported types:
      drive_search, drive_get_file, sheets_read, docs_read, calendar_list
    """
    if not AVAILABLE or not requests:
        return ""

    parts: list[str] = []
    for req in requests:
        rtype = req.get("type", "")
        try:
            if rtype == "drive_search":
                files = await drive_search(req.get("query", ""), req.get("limit", 5))
                parts.append(
                    f"[Drive search: {req.get('query', '')}]\n"
                    + "\n".join(f"  - {f['name']} ({f['id']}) {f.get('webViewLink','')}" for f in files)
                )
            elif rtype == "drive_get_file":
                meta = await drive_get_file(req["file_id"])
                parts.append(f"[Drive file: {meta['name']}]\n{json.dumps(meta, indent=2)}")
            elif rtype == "sheets_read":
                values = await sheets_read(req["file_id"], req.get("range", "A1:Z100"))
                rows = "\n".join(",".join(str(c) for c in row) for row in values[:50])
                parts.append(f"[Sheet {req['file_id']} {req.get('range','')}]\n{rows}")
            elif rtype == "docs_read":
                text = await docs_read(req["file_id"])
                parts.append(f"[Doc {req['file_id']}]\n{text}")
            elif rtype == "calendar_list":
                events = await calendar_list(req["time_min"], req["time_max"])
                formatted = "\n".join(
                    f"  - {e.get('summary','(no title)')} @ "
                    f"{e.get('start',{}).get('dateTime') or e.get('start',{}).get('date','?')}"
                    for e in events
                )
                parts.append(f"[Calendar {req['time_min']} – {req['time_max']}]\n{formatted}")
            else:
                parts.append(f"[Unknown read type: {rtype}]")
        except Exception as exc:
            parts.append(f"[{rtype} failed: {exc}]")

    return "\n\n".join(parts)


async def execute_writes(writes: list[dict]) -> list[dict]:
    """Execute a list of google_writes. Returns a list of {type, status, error?} dicts."""
    if not AVAILABLE or not writes:
        return []

    results: list[dict] = []
    for op in writes:
        wtype = op.get("type", "")
        try:
            if wtype == "sheets_write":
                await sheets_write(op["file_id"], op["range"], op["values"])
                results.append({"type": wtype, "status": "ok"})
            elif wtype == "sheets_append":
                await sheets_append(op["file_id"], op["range"], op["values"])
                results.append({"type": wtype, "status": "ok"})
            elif wtype == "docs_append":
                await docs_append(op["file_id"], op["text"])
                results.append({"type": wtype, "status": "ok"})
            elif wtype == "calendar_create":
                event = await calendar_create(
                    summary=op["summary"],
                    start=op["start"],
                    end=op["end"],
                    description=op.get("description", ""),
                    attendees=op.get("attendees"),
                    timezone=op.get("timezone", "UTC"),
                )
                results.append({"type": wtype, "status": "ok", "event_id": event.get("id")})
            elif wtype == "calendar_update":
                fields = {k: v for k, v in op.items() if k not in ("type", "event_id")}
                await calendar_update(op["event_id"], **fields)
                results.append({"type": wtype, "status": "ok"})
            elif wtype == "calendar_delete":
                await calendar_delete(op["event_id"])
                results.append({"type": wtype, "status": "ok"})
            else:
                results.append({"type": wtype, "status": "skipped", "error": f"unknown type: {wtype}"})
        except Exception as exc:
            results.append({"type": wtype, "status": "error", "error": str(exc)})

    return results
