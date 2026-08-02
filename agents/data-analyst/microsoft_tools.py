"""
Microsoft 365 tools for the LangGraph agent.

Every call goes through the platform adapter, which holds the Graph credential
and applies the buyer's approval policy before anything mutates or is shared.
This module has no way to reach Microsoft on its own, by design: agent code
deciding for itself what needed approval is what let a file be shared with an
outsider while the buyer's policy said "always ask".

- Calendar + email are scoped to the agent's workspace identity via
  /users/{WORKSPACE_EMAIL}/...
- File storage (Excel, documents) uses the shared SharePoint site drive via
  /sites/root/drive/... with per-agent folders for isolation.

No new pip packages — uses only httpx (already in requirements.txt).
"""

import os
import time
from typing import Any

import httpx

# ─── Config ───────────────────────────────────────────────────────────────────

_WORKSPACE_EMAIL = os.environ.get("WORKSPACE_EMAIL", "")
_SP_FOLDER = os.environ.get("SHAREPOINT_FOLDER", "default")
_DEPLOYMENT_ID = os.environ.get("DEPLOYMENT_ID", "")  # an identifier, not a credential

# Microsoft credentials are deliberately absent from this module now. They are
# not read from the environment because they are no longer there to read: the
# platform strips them before this code runs, and supplies a transport instead.
#
# AVAILABLE must therefore key off the agent having an identity rather than off
# credentials being present. Keying it off the old MICROSOFT_* / TOKEN_ENDPOINT
# vars would have silently disabled every Microsoft tool the moment those were
# scrubbed — the tools would simply stop being offered, with no error to explain
# why.
AVAILABLE = bool(_WORKSPACE_EMAIL)

GRAPH = "https://graph.microsoft.com/v1.0"

# ─── Token cache ──────────────────────────────────────────────────────────────

_token_cache: dict[str, Any] = {}  # {"token": str, "expires_at": float}

# ─── Platform-mediated Graph transport ───────────────────────────────────────
#
# This module used to hold a Graph token and call Microsoft itself, which meant
# the buyer's approval policy only governed whatever this file chose to route
# through it. The platform now owns the credential and inspects every request,
# classifying it from the method and path so a share cannot be passed off as a
# read.
#
# The adapter injects its graph_request here at startup. _GraphClient presents
# the small slice of the httpx.AsyncClient interface this file already used, so
# the tool functions below are unchanged — they simply no longer decide for
# themselves what reaches Microsoft.

_graph_fn = None  # set by set_graph_fn(); provided by the platform adapter


def set_graph_fn(fn) -> None:
    """Called once by the agent entry point with the adapter's graph_request."""
    global _graph_fn
    _graph_fn = fn


class _GraphClient:
    """Stands in for httpx.AsyncClient, routing every call through the platform."""

    def __init__(self, *_args, **_kwargs) -> None:
        pass

    async def __aenter__(self) -> "_GraphClient":
        return self

    async def __aexit__(self, *_exc) -> None:
        return None

    async def request(self, method: str, url: str, **kw):
        if _graph_fn is None:
            raise RuntimeError(
                "Microsoft access is not available: the platform did not provide a "
                "Graph transport. This agent cannot call Microsoft directly."
            )
        path = url[len(GRAPH):] if url.startswith(GRAPH) else url
        return await _graph_fn(
            method,
            path,
            json_body=kw.get("json"),
            params=kw.get("params"),
            content=kw.get("content"),
            headers=kw.get("headers"),
            raw=True,
        )

    async def get(self, url: str, **kw):
        return await self.request("GET", url, **kw)

    async def post(self, url: str, **kw):
        return await self.request("POST", url, **kw)

    async def put(self, url: str, **kw):
        return await self.request("PUT", url, **kw)

    async def patch(self, url: str, **kw):
        return await self.request("PATCH", url, **kw)

    async def delete(self, url: str, **kw):
        return await self.request("DELETE", url, **kw)


async def _get_access_token() -> str:
    """Retained so the tool functions below need no edits — returns nothing useful.

    Acquiring a Graph token is the platform's job now. This module no longer has
    the means to get one: the adapter attaches the credential itself and discards
    any Authorization a caller supplies, precisely so that agent code cannot
    choose what it authenticates as.
    """
    return ""


def _auth_headers(token: str) -> dict[str, str]:
    """Content-Type only. Authorization is set by the platform and stripped here."""
    return {"Content-Type": "application/json"}


def _user_url(path: str) -> str:
    """Scope a Graph path to the agent's own workspace identity (calendar, email)."""
    return f"{GRAPH}/users/{_WORKSPACE_EMAIL}/{path}"


def _drive_url(path: str = "") -> str:
    """Build a SharePoint site drive URL. All file ops use this instead of OneDrive."""
    base = f"{GRAPH}/sites/root/drive"
    return f"{base}/{path}" if path else base


# ─── Calendar ─────────────────────────────────────────────────────────────────


async def calendar_list(days_ahead: int = 7) -> list[dict]:
    """List upcoming calendar events for the next N days."""
    token = await _get_access_token()
    now_iso = _iso_now()
    end_iso = _iso_offset(days_ahead * 86400)
    async with _GraphClient() as client:
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
    async with _GraphClient() as client:
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
    async with _GraphClient() as client:
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
    async with _GraphClient() as client:
        resp = await client.delete(
            _user_url(f"events/{event_id}"),
            headers=_auth_headers(token),
        )
        if resp.status_code not in (200, 204):
            resp.raise_for_status()


# ─── SharePoint File Storage ─────────────────────────────────────────────────


async def drive_ensure_folder() -> dict:
    """Create the agent's folder on SharePoint if it doesn't exist. Returns folder metadata."""
    token = await _get_access_token()
    async with _GraphClient() as client:
        resp = await client.post(
            _drive_url("root/children"),
            headers=_auth_headers(token),
            json={
                "name": _SP_FOLDER,
                "folder": {},
                "@microsoft.graph.conflictBehavior": "fail",
            },
        )
        if resp.status_code == 409:
            # Already exists — fetch metadata
            resp2 = await client.get(
                _drive_url(f"root:/{_SP_FOLDER}"),
                headers=_auth_headers(token),
            )
            resp2.raise_for_status()
            return resp2.json()
        resp.raise_for_status()
    return resp.json()


async def drive_upload(filename: str, content: bytes, content_type: str = "application/octet-stream") -> dict:
    """Upload a file to the agent's SharePoint folder. Overwrites if exists."""
    token = await _get_access_token()
    async with _GraphClient() as client:
        resp = await client.put(
            _drive_url(f"root:/{_SP_FOLDER}/{filename}:/content"),
            headers={"Authorization": f"Bearer {token}", "Content-Type": content_type},
            content=content,
        )
        resp.raise_for_status()
    return resp.json()


async def drive_list(subfolder: str = "") -> list[dict]:
    """List files in the agent's SharePoint folder (or a subfolder)."""
    token = await _get_access_token()
    # The model calls this with subfolder omitted or explicitly null. An f-string
    # renders None as the literal "None", producing .../root:/<folder>/None:/children
    # and a 404 — so listing shared files failed whenever no subfolder was given.
    # my_drive_list() avoids this by testing truthiness; do the same here.
    subfolder = subfolder or ""
    path = f"{_SP_FOLDER}/{subfolder}".rstrip("/")
    async with _GraphClient() as client:
        resp = await client.get(
            _drive_url(f"root:/{path}:/children"),
            headers=_auth_headers(token),
            params={"$select": "id,name,webUrl,size,lastModifiedDateTime,file,folder"},
        )
        resp.raise_for_status()
    return resp.json().get("value", [])


async def drive_search(query: str, limit: int = 10) -> list[dict]:
    """Search SharePoint site drive for files matching a query string."""
    token = await _get_access_token()
    async with _GraphClient() as client:
        resp = await client.get(
            _drive_url("root/search(q='{}')".format(query.replace("'", "''"))),
            headers=_auth_headers(token),
            params={
                "$select": "id,name,webUrl,size,lastModifiedDateTime,file",
                "$top": str(limit),
            },
        )
        resp.raise_for_status()
    return resp.json().get("value", [])


async def drive_get_file(item_id: str) -> dict:
    """Get metadata for a specific SharePoint drive item."""
    token = await _get_access_token()
    async with _GraphClient() as client:
        resp = await client.get(
            _drive_url(f"items/{item_id}"),
            headers=_auth_headers(token),
        )
        resp.raise_for_status()
    return resp.json()


async def drive_read_text(item_id: str) -> str:
    """Download and return the text content of a SharePoint file."""
    token = await _get_access_token()
    async with _GraphClient() as client:
        resp = await client.get(
            _drive_url(f"items/{item_id}/content"),
            headers={"Authorization": f"Bearer {token}"},
        )
        resp.raise_for_status()
    return resp.text


async def drive_delete(item_id: str) -> None:
    """Delete a file or folder from the SharePoint site drive."""
    token = await _get_access_token()
    async with _GraphClient() as client:
        resp = await client.delete(
            _drive_url(f"items/{item_id}"),
            headers={"Authorization": f"Bearer {token}"},
        )
        if resp.status_code not in (200, 204):
            resp.raise_for_status()


async def drive_share(item_id: str, recipients: list[str], role: str = "read", message: str = "") -> dict:
    """Share a SharePoint file/folder with specific users.

    Args:
        item_id: The file or folder ID.
        recipients: List of email addresses to share with.
        role: "read" (view only) or "write" (can edit). Default "read".
        message: Optional message included in the sharing invitation.

    Returns:
        dict with sharing details.
    """
    token = await _get_access_token()
    payload: dict[str, Any] = {
        "recipients": [{"email": r} for r in recipients],
        "roles": ["write" if role == "write" else "read"],
        "requireSignIn": True,
        "sendInvitation": True,
    }
    if message:
        payload["message"] = message
    async with _GraphClient() as client:
        resp = await client.post(
            _drive_url(f"items/{item_id}/invite"),
            headers=_auth_headers(token),
            json=payload,
        )
        resp.raise_for_status()
        return resp.json()


async def drive_create_link(item_id: str, link_type: str = "view", scope: str = "organization") -> dict:
    """Create a sharing link for a SharePoint file/folder.

    Args:
        item_id: The file or folder ID.
        link_type: "view" (read-only) or "edit". Default "view".
        scope: "organization" (anyone in the org) or "anonymous" (anyone with link). Default "organization".

    Returns:
        dict with the sharing link URL.
    """
    token = await _get_access_token()
    async with _GraphClient() as client:
        resp = await client.post(
            _drive_url(f"items/{item_id}/createLink"),
            headers=_auth_headers(token),
            json={"type": link_type, "scope": scope},
        )
        resp.raise_for_status()
        data = resp.json()
        return {"link": data.get("link", {}).get("webUrl", ""), "id": data.get("id", ""), "type": link_type, "scope": scope}


# ─── Agent OneDrive (personal storage) ────────────────────────────────────────


def _my_drive_url(path: str = "") -> str:
    """Build a Graph URL for the agent's own OneDrive."""
    base = f"{GRAPH}/users/{_WORKSPACE_EMAIL}/drive"
    return f"{base}/{path}" if path else base


async def my_drive_list(subfolder: str = "") -> list[dict]:
    """List files in the agent's own OneDrive (or a subfolder)."""
    token = await _get_access_token()
    if subfolder:
        url = _my_drive_url(f"root:/{subfolder}:/children")
    else:
        url = _my_drive_url("root/children")
    async with _GraphClient() as client:
        resp = await client.get(
            url,
            headers=_auth_headers(token),
            params={"$select": "id,name,webUrl,size,lastModifiedDateTime,file,folder"},
        )
        resp.raise_for_status()
    return resp.json().get("value", [])


async def my_drive_upload(filename: str, content: bytes, folder: str = "", content_type: str = "application/octet-stream") -> dict:
    """Upload a file to the agent's own OneDrive. Overwrites if exists."""
    token = await _get_access_token()
    path = f"{folder}/{filename}" if folder else filename
    async with _GraphClient() as client:
        resp = await client.put(
            _my_drive_url(f"root:/{path}:/content"),
            headers={"Authorization": f"Bearer {token}", "Content-Type": content_type},
            content=content,
        )
        resp.raise_for_status()
    return resp.json()


async def my_drive_read_text(item_id: str) -> str:
    """Download and return the text content of a file from the agent's OneDrive."""
    token = await _get_access_token()
    async with _GraphClient() as client:
        resp = await client.get(
            _my_drive_url(f"items/{item_id}/content"),
            headers={"Authorization": f"Bearer {token}"},
        )
        resp.raise_for_status()
    return resp.text


async def my_drive_search(query: str, limit: int = 10) -> list[dict]:
    """Search the agent's own OneDrive for files matching a query."""
    token = await _get_access_token()
    async with _GraphClient() as client:
        resp = await client.get(
            _my_drive_url("root/search(q='{}')".format(query.replace("'", "''"))),
            headers=_auth_headers(token),
            params={
                "$select": "id,name,webUrl,size,lastModifiedDateTime,file",
                "$top": str(limit),
            },
        )
        resp.raise_for_status()
    return resp.json().get("value", [])


async def my_drive_ensure_folder(folder_name: str) -> dict:
    """Create a folder in the agent's OneDrive if it doesn't exist."""
    token = await _get_access_token()
    async with _GraphClient() as client:
        resp = await client.post(
            _my_drive_url("root/children"),
            headers=_auth_headers(token),
            json={
                "name": folder_name,
                "folder": {},
                "@microsoft.graph.conflictBehavior": "fail",
            },
        )
        if resp.status_code == 409:
            resp2 = await client.get(
                _my_drive_url(f"root:/{folder_name}"),
                headers=_auth_headers(token),
            )
            resp2.raise_for_status()
            return resp2.json()
        resp.raise_for_status()
    return resp.json()


async def my_drive_delete(item_id: str) -> None:
    """Delete a file or folder from the agent's OneDrive."""
    token = await _get_access_token()
    async with _GraphClient() as client:
        resp = await client.delete(
            _my_drive_url(f"items/{item_id}"),
            headers={"Authorization": f"Bearer {token}"},
        )
        if resp.status_code not in (200, 204):
            resp.raise_for_status()


async def my_drive_share(item_id: str, recipients: list[str], role: str = "read", message: str = "") -> dict:
    """Share an OneDrive file/folder with specific users.

    Args:
        item_id: The file or folder ID.
        recipients: List of email addresses to share with.
        role: "read" (view only) or "write" (can edit). Default "read".
        message: Optional message included in the sharing invitation.

    Returns:
        dict with sharing details.
    """
    token = await _get_access_token()
    payload: dict[str, Any] = {
        "recipients": [{"email": r} for r in recipients],
        "roles": ["write" if role == "write" else "read"],
        "requireSignIn": False,
        "sendInvitation": True,
    }
    if message:
        payload["message"] = message
    async with _GraphClient() as client:
        resp = await client.post(
            _my_drive_url(f"items/{item_id}/invite"),
            headers=_auth_headers(token),
            json=payload,
        )
        resp.raise_for_status()
        return resp.json()


async def my_drive_create_link(item_id: str, link_type: str = "view", scope: str = "organization") -> dict:
    """Create a sharing link for an OneDrive file/folder.

    Args:
        item_id: The file or folder ID.
        link_type: "view" (read-only) or "edit". Default "view".
        scope: "organization" (only people signed in to this company) or "anonymous"
            (ANYONE holding the link, no sign-in). Default "organization".
            Only pass "anonymous" if the requester has explicitly asked for a link
            that works outside the company — it can be forwarded to anyone.

    Returns:
        dict with the sharing link URL.
    """
    token = await _get_access_token()
    async with _GraphClient() as client:
        resp = await client.post(
            _my_drive_url(f"items/{item_id}/createLink"),
            headers=_auth_headers(token),
            json={"type": link_type, "scope": scope},
        )
        resp.raise_for_status()
        data = resp.json()
        return {"link": data.get("link", {}).get("webUrl", ""), "id": data.get("id", ""), "type": link_type, "scope": scope}


# ─── Excel ────────────────────────────────────────────────────────────────────


async def excel_list_sheets(item_id: str) -> list[str]:
    """List all worksheet names in an Excel workbook on SharePoint."""
    token = await _get_access_token()
    async with _GraphClient() as client:
        resp = await client.get(
            _drive_url(f"items/{item_id}/workbook/worksheets"),
            headers=_auth_headers(token),
            params={"$select": "name"},
        )
        resp.raise_for_status()
    return [ws["name"] for ws in resp.json().get("value", [])]


async def excel_read(item_id: str, sheet: str, range_addr: str = "A1:Z100") -> list[list]:
    """Read a range from an Excel workbook on SharePoint."""
    token = await _get_access_token()
    async with _GraphClient() as client:
        resp = await client.get(
            _drive_url(f"items/{item_id}/workbook/worksheets/{sheet}/range(address='{range_addr}')"),
            headers=_auth_headers(token),
            params={"$select": "values"},
        )
        resp.raise_for_status()
    return resp.json().get("values", [])


async def excel_write(item_id: str, sheet: str, range_addr: str, values: list[list]) -> None:
    """Write values to a range in an Excel workbook on SharePoint."""
    token = await _get_access_token()
    async with _GraphClient() as client:
        resp = await client.patch(
            _drive_url(f"items/{item_id}/workbook/worksheets/{sheet}/range(address='{range_addr}')"),
            headers=_auth_headers(token),
            json={"values": values},
        )
        resp.raise_for_status()


async def excel_append(item_id: str, sheet: str, values: list[list]) -> dict:
    """Append rows to a used range in an Excel worksheet on SharePoint."""
    token = await _get_access_token()
    async with _GraphClient() as client:
        # Get used range to find next empty row
        ur_resp = await client.get(
            _drive_url(f"items/{item_id}/workbook/worksheets/{sheet}/usedRange"),
            headers=_auth_headers(token),
            params={"$select": "address,rowCount"},
        )
        ur_resp.raise_for_status()
        ur_data = ur_resp.json()
        row_count = ur_data.get("rowCount", 1)
        # Build address for the next row after the used range
        num_cols = len(values[0]) if values and values[0] else 1
        col_letter = chr(ord("A") + num_cols - 1) if num_cols <= 26 else "Z"
        next_row = row_count + 1
        end_row = next_row + len(values) - 1
        write_addr = f"A{next_row}:{col_letter}{end_row}"
        resp = await client.patch(
            _drive_url(f"items/{item_id}/workbook/worksheets/{sheet}/range(address='{write_addr}')"),
            headers=_auth_headers(token),
            json={"values": values},
        )
        resp.raise_for_status()
    return resp.json()


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


# ─── Outlook Email ────────────────────────────────────────────────────────────

_OUTLOOK_SEND_URL = os.environ.get("OUTLOOK_SEND_URL", "")
# Mail is Microsoft-only; there is no longer an EMAIL_MODE to select a channel.
# Availability is just "can we reach the Graph send proxy".
EMAIL_AVAILABLE = bool(_OUTLOOK_SEND_URL and AVAILABLE)


async def inbox_list(limit: int = 10, unread_only: bool = True) -> list[dict]:
    """List recent messages in the agent's Outlook inbox."""
    token = await _get_access_token()
    params: dict[str, str] = {
        "$select": "id,subject,from,toRecipients,ccRecipients,receivedDateTime,isRead,conversationId,hasAttachments,bodyPreview",
        "$orderby": "receivedDateTime desc",
        "$top": str(limit),
    }
    if unread_only:
        params["$filter"] = "isRead eq false"
    async with _GraphClient() as client:
        resp = await client.get(
            _user_url("mailFolders/Inbox/messages"),
            headers=_auth_headers(token),
            params=params,
        )
        resp.raise_for_status()
    messages = resp.json().get("value", [])
    return [
        {
            "id": m.get("id"),
            "subject": m.get("subject"),
            "from": m.get("from", {}).get("emailAddress", {}).get("address"),
            "from_name": m.get("from", {}).get("emailAddress", {}).get("name"),
            "received": m.get("receivedDateTime"),
            "preview": m.get("bodyPreview", "")[:200],
            "isRead": m.get("isRead"),
            "conversationId": m.get("conversationId"),
            "hasAttachments": m.get("hasAttachments"),
        }
        for m in messages
    ]


async def inbox_read(message_id: str) -> dict:
    """Read the full content of a specific email message."""
    token = await _get_access_token()
    async with _GraphClient() as client:
        resp = await client.get(
            _user_url(f"messages/{message_id}"),
            headers=_auth_headers(token),
            params={
                "$select": "id,subject,body,from,toRecipients,ccRecipients,receivedDateTime,conversationId,hasAttachments,internetMessageId",
            },
        )
        resp.raise_for_status()
    msg = resp.json()
    result = {
        "id": msg.get("id"),
        "subject": msg.get("subject"),
        "from": msg.get("from", {}).get("emailAddress", {}).get("address"),
        "from_name": msg.get("from", {}).get("emailAddress", {}).get("name"),
        "body": msg.get("body", {}).get("content", ""),
        "bodyType": msg.get("body", {}).get("contentType", "text"),
        "received": msg.get("receivedDateTime"),
        "conversationId": msg.get("conversationId"),
        "to": [r.get("emailAddress", {}).get("address") for r in msg.get("toRecipients", [])],
        "cc": [r.get("emailAddress", {}).get("address") for r in msg.get("ccRecipients", [])],
    }
    # Fetch attachments if any
    if msg.get("hasAttachments"):
        att_resp = await client.get(
            _user_url(f"messages/{message_id}/attachments"),
            headers=_auth_headers(token),
        )
        if att_resp.status_code == 200:
            result["attachments"] = [
                {
                    "name": a.get("name"),
                    "contentType": a.get("contentType"),
                    "size": a.get("size"),
                }
                for a in att_resp.json().get("value", [])
            ]
    return result


async def inbox_search(query: str, limit: int = 10) -> list[dict]:
    """Search the agent's Outlook mailbox by keyword, sender, or subject."""
    token = await _get_access_token()
    async with _GraphClient() as client:
        resp = await client.get(
            _user_url("messages"),
            headers=_auth_headers(token),
            params={
                "$search": f'"{query}"',
                "$select": "id,subject,from,receivedDateTime,bodyPreview,conversationId",
                "$top": str(limit),
            },
        )
        resp.raise_for_status()
    return [
        {
            "id": m.get("id"),
            "subject": m.get("subject"),
            "from": m.get("from", {}).get("emailAddress", {}).get("address"),
            "received": m.get("receivedDateTime"),
            "preview": m.get("bodyPreview", "")[:200],
            "conversationId": m.get("conversationId"),
        }
        for m in resp.json().get("value", [])
    ]


async def email_send(
    to: str | list[str],
    subject: str,
    body: str,
    cc: list[str] | None = None,
    body_type: str = "html",
) -> dict:
    """Send a new email from the agent's Outlook mailbox via the send proxy."""
    if not _OUTLOOK_SEND_URL:
        raise RuntimeError("OUTLOOK_SEND_URL not configured — cannot send via Outlook")
    recipients = [to] if isinstance(to, str) else to
    payload: dict[str, Any] = {
        "deploymentId": _DEPLOYMENT_ID,
        "agentEmail": _WORKSPACE_EMAIL,
        "to": recipients,
        "subject": subject,
        "body": body,
        "bodyType": body_type,
    }
    if cc:
        payload["cc"] = cc
    async with _GraphClient() as client:
        resp = await client.post(_OUTLOOK_SEND_URL, json=payload)
        resp.raise_for_status()
    return resp.json()


async def email_reply(
    message_id: str,
    body: str,
    body_type: str = "html",
) -> dict:
    """Reply to an existing email thread via the agent's Outlook mailbox."""
    if not _OUTLOOK_SEND_URL:
        raise RuntimeError("OUTLOOK_SEND_URL not configured — cannot send via Outlook")
    async with _GraphClient() as client:
        resp = await client.post(
            _OUTLOOK_SEND_URL,
            json={
                "deploymentId": _DEPLOYMENT_ID,
                "agentEmail": _WORKSPACE_EMAIL,
                "replyToMessageId": message_id,
                "body": body,
                "bodyType": body_type,
            },
        )
        resp.raise_for_status()
    return resp.json()


async def email_forward(message_id: str, to: str | list[str], comment: str = "") -> dict:
    """Forward an email to another recipient."""
    token = await _get_access_token()
    recipients = [to] if isinstance(to, str) else to
    async with _GraphClient() as client:
        resp = await client.post(
            _user_url(f"messages/{message_id}/forward"),
            headers=_auth_headers(token),
            json={
                "comment": comment,
                "toRecipients": [
                    {"emailAddress": {"address": addr}} for addr in recipients
                ],
            },
        )
        resp.raise_for_status()
    return {"success": True}


async def email_mark_read(message_id: str, is_read: bool = True) -> None:
    """Mark an email as read or unread."""
    token = await _get_access_token()
    async with _GraphClient() as client:
        resp = await client.patch(
            _user_url(f"messages/{message_id}"),
            headers=_auth_headers(token),
            json={"isRead": is_read},
        )
        resp.raise_for_status()


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
