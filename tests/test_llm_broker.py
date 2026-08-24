"""The LLM key can be brokered so it never enters an untrusted container.

Creator code builds its own LLM client from LLM_BASE_URL / LLM_API_KEY. Rather
than hand it the shared model key (which a hostile package could abuse), the
platform can point it at a proxy on the provisioning service that injects the real
key server-side. The adapter overwrites the two env vars BEFORE creator code
imports, encoding the deployment id into the key so the proxy can authenticate it.
Opt-in: absent LLM_BROKER_URL nothing changes, so this is inert for deployments
that still hold the key directly (the first-party pilot).
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SERVER = (ROOT / "apps" / "provisioning-service" / "src" / "server.ts").read_text(encoding="utf-8")
ADAPTER = (ROOT / "apps" / "provisioning-service" / "src" / "templates" / "runtime" / "adapter.py").read_text(encoding="utf-8")


def test_broker_endpoint_exists_and_injects_the_real_key():
    block = SERVER[SERVER.index("/internal/llm/"):]
    block = block[: block.index("/internal/outlook-send")]
    # The real key is read from the platform env, never from the request.
    assert "process.env.LLM_BROKER_KEY || process.env.OPENROUTER_API_KEY" in block
    assert "Authorization: `Bearer ${realKey}`" in block


def test_broker_authenticates_the_deployment_token():
    block = SERVER[SERVER.index("/internal/llm/"):]
    block = block[: block.index("/internal/outlook-send")]
    # "<deploymentId>.<agentToken>" is split and the derived token verified.
    assert "lastIndexOf" in block
    assert "agentTokenMatches(agentToken, deploymentId, SECRET)" in block
    assert "send(res, 401" in block


def test_adapter_redirects_llm_env_only_when_opted_in():
    # The override must happen before creator code imports, and be a no-op without
    # LLM_BROKER_URL.
    assert 'os.environ.pop("LLM_BROKER_URL"' in ADAPTER
    broker = ADAPTER[ADAPTER.index("_llm_broker_url"):]
    broker = broker[: broker.index("# ─── MCP Sidecar Discovery")]
    assert 'os.environ["LLM_BASE_URL"] = _llm_broker_url' in broker
    assert 'os.environ["LLM_API_KEY"] = f"{_dep}.{_tok}"' in broker
    # Must run before the creator import line.
    assert ADAPTER.index("_llm_broker_url") < ADAPTER.index("from creator.agent import")


def test_broker_is_off_by_default():
    # No LLM_BROKER_URL is injected anywhere by default — this pins that enabling it
    # is a deliberate act, so the live agent keeps holding its key until then.
    runner = (ROOT / "apps" / "provisioning-service" / "src" / "jobs" / "custom-runner.ts").read_text(encoding="utf-8")
    assert "LLM_BROKER_URL" not in runner
