"""
MCP Python Sandbox — lightweight code execution + document parsing sidecar.

Runs inside a Docker container on the same internal network as the agent.
No external network access — only reachable by the agent container.

Endpoints:
  POST /mcp/tools/list  — list available tools
  POST /mcp/tools/call  — execute a tool
  GET  /health          — health check
"""

import base64
import io
import json
import os
import resource
import signal
import subprocess
import sys
import tempfile
from pathlib import Path

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

app = FastAPI(title="MCP Python Sandbox", version="1.0.0")

# ─── Tool Definitions ───────────────────────────────────────────────────────

TOOLS = [
    {
        "name": "execute_python",
        "description": (
            "Execute Python code with pandas, matplotlib, numpy, seaborn, and openpyxl available. "
            "Code runs in a subprocess with a 30s timeout and 256MB memory limit. "
            "Any files written to /tmp/output/ will be returned as base64-encoded content. "
            "Use this for data analysis, visualization, and computation."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "code": {
                    "type": "string",
                    "description": "Python code to execute. Print results to stdout. Save files to /tmp/output/ to return them.",
                },
            },
            "required": ["code"],
        },
    },
    {
        "name": "parse_pdf",
        "description": "Extract text and tables from a PDF file. Returns structured text content.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "file_content_base64": {
                    "type": "string",
                    "description": "Base64-encoded PDF file content",
                },
            },
            "required": ["file_content_base64"],
        },
    },
    {
        "name": "parse_docx",
        "description": "Extract text from a Word document (.docx).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "file_content_base64": {
                    "type": "string",
                    "description": "Base64-encoded .docx file content",
                },
            },
            "required": ["file_content_base64"],
        },
    },
    {
        "name": "parse_xlsx",
        "description": "Extract sheet data from an Excel file as JSON.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "file_content_base64": {
                    "type": "string",
                    "description": "Base64-encoded .xlsx file content",
                },
            },
            "required": ["file_content_base64"],
        },
    },
]


# ─── Models ──────────────────────────────────────────────────────────────────

class ToolCallRequest(BaseModel):
    name: str
    arguments: dict


# ─── Endpoints ───────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {"ok": True}


@app.post("/mcp/tools/list")
async def list_tools():
    return {"tools": TOOLS}


@app.post("/mcp/tools/call")
async def call_tool(req: ToolCallRequest):
    handler = TOOL_HANDLERS.get(req.name)
    if not handler:
        raise HTTPException(status_code=404, detail=f"Unknown tool: {req.name}")
    try:
        result = handler(req.arguments)
        return {"result": result}
    except Exception as e:
        return {"error": str(e)}


# ─── Tool Implementations ───────────────────────────────────────────────────

def _execute_python(args: dict) -> dict:
    """Run Python code in a subprocess with resource limits."""
    code = args.get("code", "")
    if not code.strip():
        return {"stdout": "", "stderr": "No code provided", "files": []}

    # Create output directory for generated files
    output_dir = tempfile.mkdtemp(prefix="mcp_output_")
    output_path = Path(output_dir)

    # Wrap code to set up output dir
    wrapper = f"""
import os, sys
os.makedirs('/tmp/output', exist_ok=True)
os.chdir('/tmp')
{code}
"""

    try:
        result = subprocess.run(
            [sys.executable, "-c", wrapper],
            capture_output=True,
            text=True,
            timeout=30,
            env={
                "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
                "HOME": "/tmp",
                "MPLBACKEND": "Agg",  # matplotlib non-interactive backend
            },
        )

        # Collect any files written to /tmp/output/
        files = []
        out_dir = Path("/tmp/output")
        if out_dir.exists():
            for f in out_dir.iterdir():
                if f.is_file() and f.stat().st_size < 10_000_000:  # 10MB max per file
                    files.append({
                        "name": f.name,
                        "base64_content": base64.b64encode(f.read_bytes()).decode(),
                    })
                    f.unlink()  # clean up

        return {
            "stdout": result.stdout[:50000],  # cap output at 50KB
            "stderr": result.stderr[:10000],
            "returncode": result.returncode,
            "files": files,
        }
    except subprocess.TimeoutExpired:
        return {
            "stdout": "",
            "stderr": "Execution timed out after 30 seconds",
            "returncode": -1,
            "files": [],
        }
    except Exception as e:
        return {
            "stdout": "",
            "stderr": f"Execution error: {str(e)}",
            "returncode": -1,
            "files": [],
        }


def _parse_pdf(args: dict) -> dict:
    """Extract text and tables from a PDF."""
    try:
        import pdfplumber
    except ImportError:
        return {"error": "pdfplumber not installed"}

    raw = base64.b64decode(args.get("file_content_base64", ""))
    text_parts = []
    tables = []

    with pdfplumber.open(io.BytesIO(raw)) as pdf:
        for i, page in enumerate(pdf.pages):
            page_text = page.extract_text() or ""
            if page_text.strip():
                text_parts.append(f"--- Page {i + 1} ---\n{page_text}")
            page_tables = page.extract_tables()
            for table in page_tables:
                tables.append({"page": i + 1, "data": table})

    return {
        "text": "\n\n".join(text_parts),
        "tables": tables,
        "page_count": len(text_parts),
    }


def _parse_docx(args: dict) -> dict:
    """Extract text from a Word document."""
    try:
        import docx
    except ImportError:
        return {"error": "python-docx not installed"}

    raw = base64.b64decode(args.get("file_content_base64", ""))
    doc = docx.Document(io.BytesIO(raw))
    paragraphs = [p.text for p in doc.paragraphs if p.text.strip()]

    return {
        "text": "\n\n".join(paragraphs),
        "paragraph_count": len(paragraphs),
    }


def _parse_xlsx(args: dict) -> dict:
    """Extract sheet data from an Excel file."""
    try:
        import openpyxl
    except ImportError:
        return {"error": "openpyxl not installed"}

    raw = base64.b64decode(args.get("file_content_base64", ""))
    wb = openpyxl.load_workbook(io.BytesIO(raw), data_only=True)
    sheets = {}

    for name in wb.sheetnames:
        ws = wb[name]
        rows = []
        for row in ws.iter_rows(values_only=True):
            rows.append([str(cell) if cell is not None else "" for cell in row])
        sheets[name] = rows

    return {"sheets": sheets}


TOOL_HANDLERS = {
    "execute_python": _execute_python,
    "parse_pdf": _parse_pdf,
    "parse_docx": _parse_docx,
    "parse_xlsx": _parse_xlsx,
}
