"""The code-scan rules the platform's vetting applies, so `agentstore check` refuses
the same things before you upload.

A copy of DANGEROUS_PATTERNS in apps/provisioning-service/src/jobs/vet-package.ts.
On 2026-10-16 a package passed `agentstore check` and then failed vetting on
`import subprocess` and `import requests`, because the CLI had never been told.
tests/test_cli_scan_rules_match_platform.py fails if the two lists drift apart.
"""
import re

# (regular expression, label) — the label is the platform's own wording.
PLATFORM_RULES: list[tuple[str, str]] = [
    (r"\bimport\s+subprocess\b", "import subprocess"),
    (r"\bfrom\s+subprocess\b", "from subprocess"),
    (r"\bos\.system\s*\(", "os.system()"),
    (r"\bos\.popen\s*\(", "os.popen()"),
    (r"\bos\.exec[vple]+\s*\(", "os.exec*()"),
    (r"\bos\.spawn[vple]*\s*\(", "os.spawn*()"),
    (r"(?<!\.)\beval\s*\(", "eval()"),
    (r"\b__import__\s*\(", "__import__()"),
    (r"\bimport\s+ctypes\b", "import ctypes"),
    (r"\bfrom\s+ctypes\b", "from ctypes"),
    (r"\bimport\s+pty\b", "import pty"),
    (r"\bimport\s+pickle\b", "import pickle"),
    (r"\bimport\s+marshal\b", "import marshal"),
    (r"(?<!\.)\bexec\s*\(", "exec()"),
    (r"(?<!\.)\bcompile\s*\(", "compile()"),
    (r"\bimport\s+multiprocessing\b", "import multiprocessing"),
    (r"\bfrom\s+multiprocessing\b", "from multiprocessing"),
    (r"\bimport\s+socket\b|\bfrom\s+socket\b", "import socket"),
    (r"\bimport\s+requests\b", "import requests (use platform MCP tools for external access)"),
    (r"\bfrom\s+requests\b", "from requests (use platform MCP tools for external access)"),
    (r"\bimport\s+urllib\b", "import urllib (use platform MCP tools for external access)"),
    (r"\bfrom\s+urllib\b", "from urllib (use platform MCP tools for external access)"),
    (r"\bimport\s+aiohttp\b", "import aiohttp (use platform MCP tools for external access)"),
    (r"\bfrom\s+aiohttp\b", "from aiohttp (use platform MCP tools for external access)"),
    (r"\bimport\s+websocket\b", "import websocket (direct WebSocket access not allowed)"),
    (r"\bimport\s+websockets\b", "import websockets (direct WebSocket access not allowed)"),
    (r"\bfrom\s+websocket\b", "from websocket (direct WebSocket access not allowed)"),
    (r"\bfrom\s+websockets\b", "from websockets (direct WebSocket access not allowed)"),
    (r"\bimport\s+docker\b", "import docker (container access not allowed)"),
    (r"\bfrom\s+docker\b", "from docker (container access not allowed)"),
]

_COMPILED = [(re.compile(p), label) for p, label in PLATFORM_RULES]


def fix_for(label: str) -> str:
    """What to do instead, in the creator's terms."""
    if "subprocess" in label or "os." in label or "multiprocessing" in label or "pty" in label:
        return ("running other programs is only allowed while the agent is built: "
                "do it in build.sh and use its output at run time")
    if any(lib in label for lib in ("requests", "urllib", "aiohttp")):
        return 'use httpx instead, and list the site in "connectsTo" in marketplace.json'
    if "socket" in label:
        return 'use httpx for web requests, and list the site in "connectsTo"'
    if label.startswith(("eval", "exec", "compile", "__import__")):
        return "call the code directly instead of building it from a string"
    if "pickle" in label or "marshal" in label:
        return "store data as JSON instead"
    return "remove it; the platform's vetting refuses packages that use it"


def scan(source: str):
    """(line number, label) for each rule the source breaks, once per rule, as vetting reports."""
    lines = source.split("\n")
    for pattern, label in _COMPILED:
        for i, line in enumerate(lines, 1):
            if line.lstrip().startswith("#"):
                continue
            if pattern.search(line):
                yield i, label
                break
