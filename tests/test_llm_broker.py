"""The LLM key can be brokered so it never enters an untrusted container.

Creator code builds its own LLM client from LLM_BASE_URL / LLM_API_KEY. Rather
than hand it the shared model key (which a hostile package could abuse), the
platform points it at a proxy on the provisioning service that injects the real
key server-side. The adapter overwrites the two env vars BEFORE creator code
imports, encoding the deployment id into the key so the proxy can authenticate it.

The broker also ENFORCES: it forces the creator's declared model (so a cheap-tier
agent cannot run a premium model on the platform's dime) and rate-limits per
deployment (so a runaway agent cannot burn the budget without bound).

Opt-in: absent LLM_BROKER_URL nothing changes, so this is inert for deployments
that still hold the key directly (the first-party pilot).
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SERVER = (ROOT / "apps" / "provisioning-service" / "src" / "server.ts").read_text(encoding="utf-8")
ADAPTER = (ROOT / "apps" / "provisioning-service" / "src" / "templates" / "runtime" / "adapter.py").read_text(encoding="utf-8")


def _broker_block() -> str:
    block = SERVER[SERVER.index("/internal/llm/"):]
    return block[: block.index("/internal/outlook-send")]


def test_broker_endpoint_exists_and_injects_the_real_key():
    block = _broker_block()
    # The real key is read from the platform env, never from the request.
    assert "process.env.LLM_BROKER_KEY || process.env.OPENROUTER_API_KEY" in block
    assert "Authorization: `Bearer ${realKey}`" in block


def test_broker_authenticates_the_deployment_token():
    block = _broker_block()
    # "<deploymentId>.<agentToken>" is split and the derived token verified.
    assert "lastIndexOf" in block
    assert "agentTokenMatches(agentToken, deploymentId, SECRET)" in block
    assert "send(res, 401" in block


def test_broker_forces_the_declared_model():
    block = _broker_block()
    # Whatever the agent requests, the forwarded body uses the allowed model.
    assert "allowedModelFor(deploymentId)" in block
    assert "parsed.model = allowedModel" in block
    # The allowed model comes from the deployment's agent, not the request.
    assert "agent: { select: { model: true } }" in SERVER


def test_broker_rate_limits_per_deployment():
    block = _broker_block()
    assert "brokerRateExceeded(deploymentId)" in block
    assert "send(res, 429" in block
    assert "LLM_BROKER_RPM" in SERVER


def test_adapter_redirects_llm_env_only_when_opted_in():
    assert 'os.environ.pop("LLM_BROKER_URL"' in ADAPTER
    broker = ADAPTER[ADAPTER.index("_llm_broker_url"):]
    broker = broker[: broker.index("# ─── MCP Sidecar Discovery")]
    assert 'os.environ["LLM_BASE_URL"] = _llm_broker_url' in broker
    assert 'os.environ["LLM_API_KEY"] = f"{_dep}.{_tok}"' in broker
    assert ADAPTER.index("_llm_broker_url") < ADAPTER.index("from creator.agent import")


def test_broker_is_off_by_default():
    runner = (ROOT / "apps" / "provisioning-service" / "src" / "jobs" / "custom-runner.ts").read_text(encoding="utf-8")
    assert "LLM_BROKER_URL" not in runner


def test_provision_wires_the_broker_when_enabled():
    prov = (ROOT / "apps" / "provisioning-service" / "src" / "jobs" / "provision.ts").read_text(encoding="utf-8")
    # When the broker is on, the container gets the broker URL and a PLACEHOLDER
    # key — never the real model key.
    assert "config.llmBrokerEnabled" in prov
    assert 'brokerOn ? "brokered-see-adapter" : llmApiKey' in prov
    assert "LLM_BROKER_URL: config.llmBrokerContainerUrl" in prov
    # The container env carries the placeholder, not the raw key, under the broker.
    assert "LLM_API_KEY: containerLlmApiKey" in prov


def test_broker_flag_is_env_gated():
    cfg = (ROOT / "apps" / "provisioning-service" / "src" / "config.ts").read_text(encoding="utf-8")
    assert 'llmBrokerEnabled: process.env.LLM_BROKER_ENABLED === "1"' in cfg
    # The container-facing URL reaches the broker via host.docker.internal.
    assert "host.docker.internal" in cfg and "/internal/llm" in cfg
