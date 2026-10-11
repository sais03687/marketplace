"""Find what will not work when an existing agent moves onto Agentstore.

Reads the code; never imports or runs it, so it is safe to point at anything.
Each finding names the file and line, says why, and says what to do instead.

What it does NOT do is decide whether the platform will accept the package —
the upload's own checks do that, and `agentstore`'s GitHub workflow asks the
platform directly (a dry-run upload). This looks for the things those checks
cannot see coming: code written for a laptop that will not work on a server
with no inbox, no API key and no route to other websites.
"""
from __future__ import annotations

import ast
import json
import re
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

ERROR = "error"
WARN = "warning"

# Files the platform supplies itself; the upload refuses a package carrying one.
RESERVED_FILES = ("adapter.py", "platform_llm.py", "Dockerfile", "platform-requirements.txt")
# Files that belong to the buyer who hires the agent, not to the package.
BUYER_FILES = ("MEMORY.md", "PRIVATE.md")

SKIP_DIRS = {".git", ".github", ".venv", "venv", "env", "__pycache__", "node_modules", "tests", "test"}

SECRET_PATTERNS = [
    (re.compile(r"sk-or-v1-[A-Za-z0-9]{20,}"), "an OpenRouter key"),
    (re.compile(r"sk-ant-[A-Za-z0-9_\-]{20,}"), "an Anthropic key"),
    (re.compile(r"sk-(?:proj-)?[A-Za-z0-9_\-]{20,}"), "an OpenAI-style key"),
    (re.compile(r"AKIA[0-9A-Z]{16}"), "an AWS access key"),
    (re.compile(r"gh[pousr]_[A-Za-z0-9]{30,}"), "a GitHub token"),
    (re.compile(r"xox[abposr]-[A-Za-z0-9\-]{10,}"), "a Slack token"),
    (re.compile(r"AIza[0-9A-Za-z_\-]{30,}"), "a Google API key"),
]

# Libraries whose whole purpose is reaching a service the platform cannot reach.
BLOCKED_SERVICES = {
    "slack_sdk": "Slack", "slack_bolt": "Slack", "slack": "Slack",
    "tweepy": "X (Twitter)", "discord": "Discord", "telegram": "Telegram",
    "stripe": "Stripe", "twilio": "Twilio", "sendgrid": "SendGrid",
    "boto3": "AWS", "botocore": "AWS",
    "googleapiclient": "Google APIs", "gspread": "Google Sheets", "firebase_admin": "Firebase",
    "pymongo": "MongoDB", "motor": "MongoDB",
    "psycopg2": "a Postgres server", "psycopg": "a Postgres server", "asyncpg": "a Postgres server",
    "pymysql": "a MySQL server", "mysql": "a MySQL server",
    "redis": "Redis", "supabase": "Supabase",
    "pinecone": "Pinecone", "weaviate": "Weaviate", "qdrant_client": "Qdrant",
    "notion_client": "Notion", "github": "GitHub", "jira": "Jira",
    "hubspot": "HubSpot", "simple_salesforce": "Salesforce",
    "tavily": "Tavily search", "serpapi": "SerpAPI", "duckduckgo_search": "DuckDuckGo search",
}

# Provider SDKs that talk to their own API rather than the platform's gateway.
OTHER_PROVIDER_SDKS = {
    "anthropic": "Anthropic",
    "google.generativeai": "Google Gemini", "google.genai": "Google Gemini",
    "mistralai": "Mistral", "cohere": "Cohere", "groq": "Groq",
}

MAIL_LIBS = {"imaplib", "poplib", "smtplib", "exchangelib", "O365", "msal", "yagmail"}
SERVER_LIBS = {
    "flask": "Flask", "fastapi": "FastAPI", "uvicorn": "uvicorn", "django": "Django",
    "gradio": "Gradio", "streamlit": "Streamlit", "http.server": "http.server",
    "aiohttp.web": "aiohttp's web server", "chainlit": "Chainlit",
}
SCHEDULER_LIBS = {"schedule": "schedule", "apscheduler": "APScheduler", "celery": "Celery"}

HTTP_CALLS = {
    ("requests", "get"), ("requests", "post"), ("requests", "put"), ("requests", "patch"),
    ("requests", "delete"), ("requests", "request"),
    ("httpx", "get"), ("httpx", "post"), ("httpx", "put"), ("httpx", "patch"),
    ("httpx", "delete"), ("httpx", "request"),
    ("urllib.request", "urlopen"), ("request", "urlopen"),
}
# Hosts an agent can reach. Model calls go through the platform's gateway via
# OPENAI_BASE_URL, so a literal openrouter.ai URL is not flagged here either.
REACHABLE_HOSTS = ("graph.microsoft.com", "sharepoint.com", "openrouter.ai", "localhost", "127.0.0.1")


# Mirrors packages/agent-package-schema/src/hosts.ts — the platform's upload uses
# that file; tests/test_agentstore_check.py runs the same cases against both.
MAX_DECLARED_HOSTS = 10
_LABEL = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
_RESERVED_HOSTS = {"localhost", "host.docker.internal", "gateway.docker.internal", "metadata.google.internal", "metadata"}
_RESERVED_SUFFIXES = (".localhost", ".local", ".internal", ".lan", ".home", ".corp", ".intranet",
                      ".private", ".arpa", ".test", ".invalid", ".example", ".onion")


def host_problem(raw) -> str | None:
    """Why `raw` cannot be listed in connectsTo, or None if it can."""
    if not isinstance(raw, str):
        return "each entry must be a host name in quotes"
    host = raw.strip().lower()
    if not host:
        return "an entry is empty"
    if "://" in host:
        return f'"{raw}" is a URL — give the host only, e.g. "api.example.com"'
    if re.search(r"[/?#]", host):
        return f'"{raw}" has a path — give the host only'
    if "*" in host:
        return f'"{raw}" is a wildcard — list each host exactly'
    if ":" in host or host.startswith("["):
        return f'"{raw}" has a port or is an IPv6 address — give the host name only'
    if re.search(r"\s", host):
        return f'"{raw}" contains a space'
    if len(host) > 253:
        return f'"{raw}" is longer than a host name can be'
    labels = host.rstrip(".").split(".")
    if len(labels) < 2:
        return f'"{raw}" is not a full host name (expected something like api.example.com)'
    if not all(_LABEL.match(l) for l in labels):
        return f'"{raw}" is not a valid host name'
    if labels[-1].isdigit():
        return f'"{raw}" is an IP address — declare the service\'s host name instead'
    if host in _RESERVED_HOSTS or host.endswith(_RESERVED_SUFFIXES):
        return f'"{raw}" is a private or internal name, which agents cannot reach'
    return None


def check_connects_to(value) -> tuple[list[str], list[str]]:
    """(normalised hosts, errors) for a manifest's connectsTo."""
    if value is None:
        return [], []
    if not isinstance(value, list):
        return [], ["connectsTo must be a list of host names"]
    hosts, errors = [], []
    for entry in value:
        problem = host_problem(entry)
        if problem:
            errors.append(problem)
            continue
        host = entry.strip().lower().rstrip(".")
        if host in hosts:
            errors.append(f'"{host}" is listed twice')
        else:
            hosts.append(host)
    if len(hosts) > MAX_DECLARED_HOSTS:
        errors.append(f"connectsTo lists {len(hosts)} hosts; the most an agent may declare is {MAX_DECLARED_HOSTS}")
    return hosts, errors


@dataclass
class Finding:
    level: str
    file: str
    line: int
    message: str
    fix: str


class _Visitor(ast.NodeVisitor):
    def __init__(self, rel: str, out: list[Finding], declared: list[str] | None = None):
        self.rel = rel
        self.out = out
        self.declared = set(declared or [])
        self.aliases: dict[str, str] = {}  # local name -> module path

    def add(self, level: str, node: ast.AST | None, message: str, fix: str) -> None:
        self.out.append(Finding(level, self.rel, getattr(node, "lineno", 0), message, fix))

    # imports ---------------------------------------------------------------
    def _check_module(self, module: str, node: ast.AST) -> None:
        root = module.split(".")[0]
        for name in (module, ".".join(module.split(".")[:2]), root):
            if name in OTHER_PROVIDER_SDKS:
                vendor = OTHER_PROVIDER_SDKS[name]
                self.add(WARN, node, f"imports {name}: the {vendor} SDK calls {vendor}'s own API, which the platform does not route",
                         f"use the OpenAI client (openai or langchain_openai) with no key, and name the {vendor} model "
                         f"by its OpenRouter id, e.g. anthropic/claude-sonnet-5, in marketplace.json")
                return
            if name in BLOCKED_SERVICES:
                svc = BLOCKED_SERVICES[name]
                self.add(WARN, node, f"imports {name}: {svc} needs an account or API key, which agents cannot hold yet",
                         "a site can be listed in connectsTo, but there is no safe place for its key until key "
                         "storage ships; services that need no key work today")
                return
            if name in SERVER_LIBS:
                self.add(WARN, node, f"imports {name}: {SERVER_LIBS[name]} runs a server, and the platform runs none for you",
                         "the platform calls your run_agent for each email; call your existing logic from there")
                return
            if name in SCHEDULER_LIBS:
                self.add(WARN, node, f"imports {name}: background schedules do not run on the platform",
                         "the agent runs when an email arrives; for periodic work see `heartbeat` in the manifest reference")
                return
        if root in MAIL_LIBS or module in MAIL_LIBS:
            self.add(WARN, node, f"imports {module}: the platform receives and sends the agent's email itself",
                     "remove the fetching and sending; the email arrives as `content`, and you return "
                     '{"action": "reply_email", "text": ...}. Microsoft 365 is available through graph_fn')

    def visit_Import(self, node: ast.Import) -> None:
        for a in node.names:
            self.aliases[(a.asname or a.name).split(".")[0]] = a.name if a.asname else a.name.split(".")[0]
            self._check_module(a.name, node)

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        if node.module and node.level == 0:
            for a in node.names:
                self.aliases[a.asname or a.name] = f"{node.module}.{a.name}"
            self._check_module(node.module, node)

    # calls -----------------------------------------------------------------
    def _dotted(self, func: ast.AST) -> tuple[str, str] | None:
        if isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name):
            return (self.aliases.get(func.value.id, func.value.id), func.attr)
        if isinstance(func, ast.Attribute) and isinstance(func.value, ast.Attribute) \
                and isinstance(func.value.value, ast.Name):
            base = self.aliases.get(func.value.value.id, func.value.value.id)
            return (f"{base}.{func.value.attr}", func.attr)
        if isinstance(func, ast.Name) and func.id in self.aliases:
            mod, _, attr = self.aliases[func.id].rpartition(".")
            return (mod, attr)
        return None

    def visit_Call(self, node: ast.Call) -> None:
        for kw in node.keywords:
            if kw.arg in ("api_key", "openai_api_key", "anthropic_api_key") and \
                    isinstance(kw.value, ast.Constant) and isinstance(kw.value.value, str) and kw.value.value:
                self.add(ERROR, node, f"{kw.arg}= is set to a fixed value in the code",
                         "delete the argument; the platform supplies OPENAI_API_KEY, and on your machine "
                         "put your own key in .env")
        if isinstance(node.func, ast.Name) and node.func.id == "input":
            self.add(WARN, node, "input() waits for someone to type, and no one is there on the platform",
                     "ask in the reply instead; the next email arrives as a new run_agent call")
        target = self._dotted(node.func)
        if target in HTTP_CALLS and node.args and isinstance(node.args[0], ast.Constant) \
                and isinstance(node.args[0].value, str):
            host = urlparse(node.args[0].value).hostname or ""
            reachable = any(host == h or host.endswith("." + h) for h in REACHABLE_HOSTS)
            if host and host not in self.declared and not reachable:
                self.add(WARN, node, f"calls {host}, which is not listed in connectsTo",
                         f'add "{host}" to "connectsTo" in marketplace.json — buyers see the list — '
                         "if the agent needs it; unlisted sites are unreachable")
        if target and target[0] in ("os.environ", "os") and target[1] in ("get", "getenv") and node.args \
                and isinstance(node.args[0], ast.Constant) and node.args[0].value in ("ANTHROPIC_API_KEY", "GEMINI_API_KEY"):
            self.add(WARN, node, f"reads {node.args[0].value}, which is empty on the platform",
                     "model calls go through the OpenAI client with no key; see the migration guide")
        self.generic_visit(node)

    def visit_Subscript(self, node: ast.Subscript) -> None:
        if isinstance(node.value, ast.Attribute) and node.value.attr == "environ" \
                and isinstance(node.slice, ast.Constant) and node.slice.value in ("ANTHROPIC_API_KEY", "GEMINI_API_KEY"):
            self.add(WARN, node, f"reads {node.slice.value}, which is empty on the platform",
                     "model calls go through the OpenAI client with no key; see the migration guide")
        self.generic_visit(node)

    def visit_Constant(self, node: ast.Constant) -> None:
        if isinstance(node.value, str):
            for pattern, what in SECRET_PATTERNS:
                m = pattern.search(node.value)
                if m:
                    self.add(ERROR, node, f"looks like {what} ({m.group(0)[:10]}…) written into the code",
                             "delete it and revoke it with the provider — it would be uploaded with your agent")
                    break


def _python_files(root: Path):
    for path in sorted(root.rglob("*.py")):
        if not any(part in SKIP_DIRS for part in path.relative_to(root).parts[:-1]):
            yield path


def _check_entry_points(root: Path, out: list[Finding]) -> None:
    agent = root / "agent.py"
    if not agent.exists():
        out.append(Finding(ERROR, "agent.py", 0, "there is no agent.py at the top of the folder",
                           "add one that defines async run_agent and async resume_agent; "
                           "see the migration guide in the creator docs"))
        return
    try:
        tree = ast.parse(agent.read_text(encoding="utf-8"), filename="agent.py")
    except SyntaxError as e:
        out.append(Finding(ERROR, "agent.py", e.lineno or 0, f"agent.py does not parse: {e.msg}", "fix the syntax error"))
        return
    defs = {n.name: n for n in tree.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))}
    for name in ("run_agent", "resume_agent"):
        fn = defs.get(name)
        if fn is None:
            out.append(Finding(ERROR, "agent.py", 0, f"agent.py does not define {name}",
                               f"add `async def {name}(...)`; the platform imports both at startup"))
        elif isinstance(fn, ast.FunctionDef):
            out.append(Finding(ERROR, "agent.py", fn.lineno, f"{name} is not async",
                               f"make it `async def {name}`; for code that is not async, call it with "
                               f"`await asyncio.to_thread(your_function, ...)`"))


# Mirrors apps/web/lib/agent-pricing.ts. Without it a price below the floor
# passed every local check and was refused only on the last step of publishing.
MIN_PRICE_USD = {"standard": 29, "pro": 59, "premium": 149, "haiku": 29, "sonnet": 59, "opus": 149}
LARGE_COMPUTE_SURCHARGE_USD = 40


def _check_price(data: dict, out: list) -> None:
    price = data.get("pricePerMonth")
    if price is None:
        return
    if not isinstance(price, (int, float)) or price < 0:
        out.append(Finding(ERROR, "marketplace.json", 0, '"pricePerMonth" must be a number of dollars, 0 or more',
                           'for example "pricePerMonth": 29'))
        return
    large = str(data.get("resources") or "standard").lower() == "large"
    if price == 0 and not large:
        return   # a free agent is allowed on purpose
    tier = str(data.get("modelTier") or "standard").lower()
    floor = MIN_PRICE_USD.get(tier, 29) + (LARGE_COMPUTE_SURCHARGE_USD if large else 0)
    if price < floor:
        out.append(Finding(ERROR, "marketplace.json", 0,
                           f"pricePerMonth ${price:g} is below the ${floor} minimum for a {tier}"
                           + (" large-compute" if large else "") + " agent",
                           f'raise it to at least {floor}' + ("" if large else ", or set 0 for a free agent")))


def _check_package_files(root: Path, out: list[Finding]) -> None:
    for name in RESERVED_FILES:
        if (root / name).exists():
            out.append(Finding(ERROR, name, 0, f"{name} is supplied by the platform",
                               "remove it from the folder you upload; the upload refuses packages carrying it"))
    for name in BUYER_FILES:
        if (root / name).exists():
            out.append(Finding(ERROR, name, 0, f"{name} belongs to the buyer who hires the agent",
                               "move a starting version to onboarding/MEMORY_TEMPLATE.md"))

    manifest = root / "marketplace.json"
    if not manifest.exists():
        out.append(Finding(ERROR, "marketplace.json", 0, "there is no marketplace.json",
                           "add one — name, slug, version, price and model; see the manifest reference"))
    else:
        try:
            data = json.loads(manifest.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError) as e:
            out.append(Finding(ERROR, "marketplace.json", 0, f"marketplace.json is not valid JSON: {e}", "fix the JSON"))
            data = None
        if isinstance(data, dict):
            for field in ("name", "slug", "version"):
                if not data.get(field):
                    out.append(Finding(ERROR, "marketplace.json", 0, f'"{field}" is missing', f'add "{field}"'))
            # A placeholder left in by `agentstore init` would become the public
            # listing the moment the version is approved.
            def _strings(value):
                if isinstance(value, str):
                    yield value
                elif isinstance(value, dict):
                    for v in value.values():
                        yield from _strings(v)
                elif isinstance(value, list):
                    for v in value:
                        yield from _strings(v)
            if any("TODO:" in s for s in _strings(data)):
                out.append(Finding(ERROR, "marketplace.json", 0, "still has TODO: placeholders",
                                   "replace each one — the name, tagline, description and capabilities "
                                   "become your public listing"))
            _check_price(data, out)
            pkgs = data.get("systemPackages")
            if pkgs is not None and not (
                isinstance(pkgs, list) and len(pkgs) <= 25
                and all(isinstance(p, str) and re.fullmatch(r"[a-z0-9][a-z0-9+.-]{1,62}", p) for p in pkgs)
            ):
                out.append(Finding(ERROR, "marketplace.json", 0,
                                   "systemPackages must be a list of at most 25 Debian package names",
                                   'e.g. "systemPackages": ["libgl1", "libx11-6"]'))
            _, host_errors = check_connects_to(data.get("connectsTo"))
            for message in host_errors:
                out.append(Finding(ERROR, "marketplace.json", 0, f"connectsTo: {message}",
                                   "see Reaching other sites in the creator docs"))
            if not data.get("model"):
                out.append(Finding(WARN, "marketplace.json", 0, 'no "model" is named, so the platform default runs',
                                   "pick any text model from https://openrouter.ai/models and put its id in \"model\""))

    build = root / "build.sh"
    if build.exists():
        # Not a problem — a notice, so the creator knows it runs and where.
        out.append(Finding(WARN, "build.sh", 0,
                           "build.sh runs once while your agent is built, with internet access and a C/C++/Fortran "
                           "toolchain, as an unprivileged user; only what it leaves in this folder reaches the agent",
                           "keep it to compiling and downloading what the agent needs — a reviewer reads it at vetting, "
                           "and the build stops after 20 minutes"))

    reqs = root / "requirements.txt"
    if not reqs.exists():
        out.append(Finding(WARN, "requirements.txt", 0, "there is no requirements.txt",
                           "list the packages your agent imports, one per line"))
    else:
        for i, line in enumerate(reqs.read_text(encoding="utf-8").splitlines(), 1):
            if re.match(r"^\s*agentstore\b", line, re.I):
                out.append(Finding(ERROR, "requirements.txt", i, "agentstore is a tool for your machine, not a dependency",
                                   "remove it; the platform supplies what it provides"))


def _declared(root: Path) -> list[str]:
    try:
        hosts, errors = check_connects_to(json.loads((root / "marketplace.json").read_text(encoding="utf-8")).get("connectsTo"))
        return [] if errors else hosts
    except Exception:
        return []


def check(folder: str | Path) -> list[Finding]:
    root = Path(folder)
    out: list[Finding] = []
    declared = _declared(root)
    _check_package_files(root, out)
    _check_entry_points(root, out)
    for path in _python_files(root):
        rel = path.relative_to(root).as_posix()
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=rel)
        except (SyntaxError, UnicodeDecodeError):
            if rel != "agent.py":  # agent.py's syntax error is already reported
                out.append(Finding(ERROR, rel, 0, f"{rel} does not parse", "fix the syntax error"))
            continue
        _Visitor(rel, out, declared).visit(tree)
    out.sort(key=lambda f: (f.level != ERROR, f.file, f.line))
    return out
