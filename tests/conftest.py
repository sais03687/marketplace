"""Make the runtime importable outside its container.

Everything under test normally runs inside the agent container, which is why
every check written while finding these bugs had to be `docker cp`-ed in and
executed there. Three things stand in the way of importing it here, and this
file removes each:

1. adapter.py reads its secrets at import time and pops them out of the
   environment, raising if any are absent. Stubbed with placeholders — none of
   them are used by the pure functions under test, and stubbing them locally
   guarantees a test can never reach a real credential.

2. adapter.py does `from creator.agent import ...`, and agent.py does
   `from . import microsoft_tools`. In the container the package lives at
   /agent/creator; in the repo it is agents/data-analyst. A namespace package
   pointed at that directory satisfies both, including the relative import.

3. agent.py imports langchain and langgraph at module scope and constructs an
   LLM client. Those are installed in the container, not here, and a test has no
   business reaching a model anyway. Stubbed to inert objects — the graph is not
   exercised, only the pure functions around it.
"""
import os
import sys
import tempfile
import types
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
AGENT_DIR = REPO / "agents" / "data-analyst"
RUNTIME_DIR = REPO / "apps" / "provisioning-service" / "src" / "templates" / "runtime"

# 0. adapter.py creates its state directories at import time, under /data — the
#    container's volume. On a CI runner that path is not writable, and on
#    Windows it silently becomes C:\data, which is worse: it passes locally and
#    fails everywhere else. Point it somewhere disposable instead.
os.environ.setdefault("AGENT_DATA_ROOT", str(Path(tempfile.gettempdir()) / "agent-tests-data"))

# 1. Secrets and identity the runtime expects to exist. Deliberately obvious
#    placeholders: if one of these ever appears in a failure message, it is
#    plainly a stub rather than something real that leaked into a test.
for _key, _value in {
    "ANTHROPIC_API_KEY": "test-not-a-real-key",
    "GEMINI_API_KEY": "test-not-a-real-key",
    "APPROVAL_WEBHOOK_TOKEN": "test-approval-token",
    "MARKETPLACE_APPROVAL_WEBHOOK": "http://localhost:0",
    "AGENT_TOKEN": "test-agent-token",
    "AGENT_HOOKS_TOKEN": "test-hooks-token",
    "TOKEN_ENDPOINT_URL": "http://localhost:0/token",
    "MICROSOFT_CLIENT_SECRET": "test-not-a-real-secret",
    "MICROSOFT_CLIENT_ID": "test-client-id",
    "MICROSOFT_TENANT_ID": "test-tenant-id",
    "PROVISIONING_SECRET": "test-provisioning-secret",
    "DEPLOYMENT_ID": "test-deployment",
    "AGENT_NAME": "Data Analyst Two",
    "COMPANY_NAME": "Acme Corp",
    "COMPANY_DOMAIN": "acme.com",
    "AGENT_EMAIL": "agent@agents.example.com",
    "WORKSPACE_EMAIL": "agent@agents.example.com",
    "MANAGER_EMAIL": "manager@acme.com",
    "OUTLOOK_SEND_URL": "http://localhost:0/send",
    "LLM_API_KEY": "test-not-a-real-key",
    "LLM_MODEL": "test-model",
}.items():
    os.environ.setdefault(_key, _value)

# 3. Stub the model libraries before anything can import them for real.
_STUBS = {
    "langchain_openai": {"ChatOpenAI": lambda *a, **k: object()},
    "langgraph": {},
    "langgraph.graph": {"StateGraph": object, "END": "END"},
    "langgraph.types": {"interrupt": lambda *a, **k: None, "Command": object},
    "langgraph.checkpoint.memory": {"MemorySaver": object},
    "langgraph.checkpoint.sqlite.aio": {"AsyncSqliteSaver": object},
    "langgraph.errors": {"GraphInterrupt": type("GraphInterrupt", (Exception,), {})},
}
for _name, _attrs in _STUBS.items():
    if _name in sys.modules:
        continue
    _mod = types.ModuleType(_name)
    for _attr, _val in _attrs.items():
        setattr(_mod, _attr, _val)
    sys.modules[_name] = _mod

# 2. Present agents/data-analyst as the `creator` package the adapter imports.
if "creator" not in sys.modules:
    _creator = types.ModuleType("creator")
    _creator.__path__ = [str(AGENT_DIR)]
    sys.modules["creator"] = _creator

if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))
if str(AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(AGENT_DIR))
