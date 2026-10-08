"""Run an agent on the creator's machine the way the platform would.

The agent receives the email formatted as the platform formats it, is given the
platform tools its signature names (stand-ins that print what they would do and
never touch anything real), and reaches the model through a local gateway that
runs the manifest's model on the creator's own key. Nothing here uses an
Agentstore key or Agentstore's model account.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import importlib.util
import inspect
import json
import os
import sys
from pathlib import Path

from .gateway import Gateway

PLATFORM_DIR = Path(__file__).parent / "_platform"
OPENROUTER = "https://openrouter.ai/api/v1"
TEXTUAL = {".csv", ".txt", ".md", ".json", ".xml", ".yaml", ".yml", ".log", ".tsv"}
INLINE_LIMIT = 20_000


def _load_dotenv(folder: Path) -> None:
    """KEY=VALUE lines from .env, never overriding what is already set."""
    for path in (folder / ".env", Path.cwd() / ".env"):
        if not path.is_file():
            continue
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip().removeprefix("export ").strip()
            os.environ.setdefault(key, value.strip().strip('"').strip("'"))


class _Tools:
    """Stand-ins for the platform's tools. They print and return safe values."""

    def __init__(self, approve: str | None):
        self.files: dict[str, tuple[str, bytes]] = {}
        self.approve = approve  # "yes" / "no" / None = ask
        self.log: list[str] = []
        self._approvals = 0

    def _say(self, line: str) -> None:
        self.log.append(line)
        print(f"  [platform] {line}")

    def register(self, name: str, raw: bytes) -> str:
        handle = "inbound:" + hashlib.sha256(raw).hexdigest()[:12]
        self.files[handle] = (name, raw)
        return handle

    def offered(self) -> dict:
        async def approve_fn(*args, **kwargs):
            self._approvals += 1
            what = kwargs.get("task_type") or kwargs.get("draft") or (args[0] if args else "an action")
            self._say(f"approval requested: {str(what)[:120]}")
            return f"local-approval-{self._approvals}"

        async def resolve_fn(approval_id, *args, **kwargs):
            status = self._decide(f"approve {approval_id}?")
            self._say(f"{approval_id} -> {status}")
            return {"status": status}

        async def graph_fn(method="GET", path="", *args, **kwargs):
            self._say(f"Microsoft Graph {method} {path} — not called locally; returned an empty result")
            return {"value": []}

        async def mcp_fn(*args, **kwargs):
            self._say(f"sandbox tool {args[:2] or kwargs.get('tool')} — not available locally")
            return {"error": "sandbox tools run only on the platform"}

        def skipped(name):
            async def fn(*args, **kwargs):
                self._say(f"{name} — skipped locally")
                return [] if name == "search_fn" else None
            return fn

        def file_resolver_fn(ref, *args, **kwargs):
            entry = self.files.get(str(ref))
            return entry[1] if entry else None

        def file_registrar_fn(name, raw, *args, **kwargs):
            return self.register(name, raw)

        def file_describer_fn(name, raw, *args, **kwargs):
            return ""

        def no_problems(*args, **kwargs):
            return []

        offered = {
            "approve_fn": approve_fn, "resolve_fn": resolve_fn, "graph_fn": graph_fn,
            "file_resolver_fn": file_resolver_fn, "file_registrar_fn": file_registrar_fn,
            "file_describer_fn": file_describer_fn,
            "verify_fn": no_problems, "ranking_fn": no_problems, "headline_fn": no_problems,
            "mcp_fn": mcp_fn, "thread_id": "local-thread", "verify_attempts": 0,
        }
        for name in ("contribute_fn", "search_fn", "use_fn"):
            offered[name] = skipped(name)
        return offered

    def _decide(self, question: str) -> str:
        if self.approve == "yes":
            return "APPROVED"
        if self.approve == "no":
            return "REJECTED"
        try:
            answer = input(f"  {question} [y/n] ").strip().lower()
        except EOFError:
            answer = "y"
        return "APPROVED" if answer.startswith("y") else "REJECTED"


def _accepted(fn, offered: dict) -> dict:
    """What the platform passes: exactly what the signature names, or all of it for **kwargs."""
    try:
        params = inspect.signature(fn).parameters
    except (TypeError, ValueError):
        return offered
    if any(p.kind is inspect.Parameter.VAR_KEYWORD for p in params.values()):
        return offered
    return {k: v for k, v in offered.items() if k in params}


def _format_email(text: str, sender: str, subject: str, attachments: list[Path], tools: _Tools) -> str:
    out = f"New email from {sender}\nSubject: {subject}\nThread ID: local-thread\n\n{text}"
    if not attachments:
        return out
    lines, handles = [], 0
    for path in attachments:
        raw = path.read_bytes()
        if path.suffix.lower() in TEXTUAL and len(raw) <= INLINE_LIMIT:
            try:
                lines.append(f"- {path.name} ({len(raw)} bytes) — full contents below\n"
                             f"--- BEGIN {path.name} ---\n{raw.decode('utf-8')}\n--- END {path.name} ---")
                continue
            except UnicodeDecodeError:
                pass
        handles += 1
        lines.append(f"- {path.name} ({len(raw)} bytes) — handle: {tools.register(path.name, raw)}")
    note = ("\n\n=== ATTACHMENTS ON THIS EMAIL ===\n"
            "These arrived with the message. Where contents are shown, use them directly.\n" + "\n".join(lines))
    if handles:
        note += "\n\nA handle is how you open one of these: pass it to file_resolver_fn to get the bytes."
    return out + note


def _import_agent(folder: Path):
    sys.path[:0] = [str(folder), str(PLATFORM_DIR)]
    spec = importlib.util.spec_from_file_location("agent", folder / "agent.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules["agent"] = module
    spec.loader.exec_module(module)
    return module


def run(folder: str, message: str, sender: str, subject: str, attachments: list[str],
        approve: str | None) -> int:
    # Leave the interpreter as it was found: the agent is imported as `agent` and
    # the model variables are pointed at a gateway that stops when this returns.
    saved_env = dict(os.environ)
    saved_path = list(sys.path)
    saved_modules = {k: sys.modules.get(k) for k in ("agent", "platform_llm")}
    try:
        return _run(folder, message, sender, subject, attachments, approve)
    finally:
        os.environ.clear()
        os.environ.update(saved_env)
        sys.path[:] = saved_path
        for name, module in saved_modules.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module


def _run(folder: str, message: str, sender: str, subject: str, attachments: list[str],
         approve: str | None) -> int:
    root = Path(folder).resolve()
    if not (root / "agent.py").exists():
        print(f"No agent.py in {root}.")
        return 2
    try:
        manifest = json.loads((root / "marketplace.json").read_text(encoding="utf-8"))
    except Exception:
        manifest = {}
    model = manifest.get("model")

    _load_dotenv(root)
    key = os.environ.get("OPENAI_API_KEY", "")
    if not key:
        print("Set your own key first — this runs on your account, never Agentstore's:\n"
              "  put OPENAI_API_KEY=sk-or-... in a .env file next to agent.py\n"
              "  (an OpenRouter key from https://openrouter.ai/keys runs the exact model you will publish on)")
        return 2
    upstream = os.environ.get("OPENAI_BASE_URL") or (OPENROUTER if key.startswith("sk-or-") else "https://api.openai.com/v1")
    gateway = Gateway(upstream, model).start()
    # The names the platform sets, pointed at the local gateway.
    for name in ("OPENAI_BASE_URL", "OPENAI_API_BASE", "LLM_BASE_URL"):
        os.environ[name] = gateway.url
    os.environ["LLM_API_KEY"] = key
    if model:
        os.environ["LLM_MODEL"] = model
    os.environ.setdefault("AGENT_NAME", manifest.get("name", "Agent"))
    os.environ.setdefault("COMPANY_NAME", "Local Test Co")

    if gateway.model:
        print(f"Model: {model} (from marketplace.json — as on the platform, whatever your code asks for)")
    else:
        print(f"Model: whatever your code asks for — {upstream} is not OpenRouter, so the manifest's "
              f"model {model!r} is not applied. Use an OpenRouter key to test the exact model.")

    tools = _Tools(approve)
    content = _format_email(message, sender, subject, [Path(a) for a in attachments], tools)
    context = {"sender": sender, "subject": subject, "thread_id": "local-thread",
               "message_id": "local-message", "agent_name": os.environ["AGENT_NAME"],
               "company_name": os.environ["COMPANY_NAME"], "approval_policy": "external-only"}

    try:
        agent = _import_agent(root)
    except Exception as e:
        print(f"agent.py failed to load: {type(e).__name__}: {e}")
        gateway.stop()
        return 1

    print("Running run_agent...\n")
    try:
        result = asyncio.run(agent.run_agent(content, context, **_accepted(agent.run_agent, tools.offered())))
    except Exception as e:
        print(f"\nrun_agent raised {type(e).__name__}: {e}")
        gateway.stop()
        return 1
    code = _show(result)

    if isinstance(result, dict) and result.get("needs_approval"):
        # On the platform a draft marked needs_approval is held, not resumed: the
        # buyer approves and it is sent, or rejects and it is dropped. resume_agent
        # is for runs that paused part-way, which is not this.
        status = tools._decide("this reply is held for the buyer's approval — approve it?")
        print("\nApproved: the platform would send it as shown." if status == "APPROVED"
              else "\nRejected: the platform would not send it, and the run ends there.")

    gateway.stop()
    ok = [c for c in gateway.calls if c["status"] == 200]
    print(f"\nModel calls: {len(gateway.calls)} ({len(ok)} succeeded)"
          + (f", {sum(c['tokens'] or 0 for c in ok):,} tokens on your account" if ok else ""))
    for c in gateway.calls:
        if c["status"] != 200:
            print(f"  a call failed with HTTP {c['status']} (code asked for {c['asked']!r})")
    return code


def _show(result) -> int:
    if not isinstance(result, dict) or "action" not in result:
        print(f"run_agent must return a dict with an \"action\"; it returned {type(result).__name__}: {str(result)[:200]}")
        return 1
    action = result["action"]
    print(f"Action: {action}")
    if result.get("to"):
        print(f"To: {result['to']}")
    if result.get("text"):
        print("--- what the email would say ---")
        print(result["text"])
        print("--------------------------------")
    for item in result.get("check") or []:
        print(f"  check: {item}")
    if action in ("reply_email", "send_email"):
        print("On the platform Agentstore sends this — to the sender for a reply — once the "
              "buyer's approval setting allows it.")
    return 0
