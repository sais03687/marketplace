"""Vetting runs unreviewed code, so it must not hold the real model key either.

Uploading a package auto-runs it in the vetting sandbox, and the creator is shown
that container's own output on their Versions page. For as long as the sandbox was
handed VET_LLM_API_KEY directly — the same value as the platform's OpenRouter key
on the live VPS — a package could print it and read it back out of its own report.

So vetting takes the same path a provisioned agent takes: a broker token instead
of a key. The difference from a deployment is that a vet id has no row to revoke
and its derived token never expires on its own, so the broker accepts it only
while the run is in flight.

Source-level assertions, like test_llm_broker.py: they prove the wiring is
present and consistent, not that a live sandbox behaves this way. That is what
the live re-vet of a print-the-key package is for.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "apps" / "provisioning-service" / "src"
VET = (SRC / "jobs" / "vet-package.ts").read_text(encoding="utf-8")
SERVER = (SRC / "server.ts").read_text(encoding="utf-8")
VET_BROKER = (SRC / "utils" / "vet-broker.ts").read_text(encoding="utf-8")
REDACT = (SRC / "utils" / "redact.ts").read_text(encoding="utf-8")


def test_vet_container_gets_a_placeholder_not_the_vetting_key():
    # The placeholder is what the adapter swaps for the broker token; the real
    # key stays in the provisioning process.
    assert '`LLM_API_KEY=${brokerVetLlm ? "brokered-see-adapter" : process.env.VET_LLM_API_KEY || "vet-noop"}`' in VET


def test_vet_container_is_given_the_broker_url_and_a_run_token():
    assert "LLM_BROKER_URL=${config.llmBrokerContainerUrl}" in VET
    assert "AGENT_TOKEN=${agentTokenFor(vetDeploymentId, config.provisioningSecret)}" in VET


def test_brokering_requires_both_the_flag_and_a_vetting_key():
    # No vetting key means no model in the sandbox at all — nothing to broker.
    assert "config.llmBrokerEnabled && Boolean(process.env.VET_LLM_API_KEY)" in VET


def test_the_run_is_registered_before_start_and_cleared_in_finally():
    assert "registerVetRun(vetDeploymentId, vetModel)" in VET
    finally_block = VET[VET.index("} finally {"):]
    assert "endVetRun(vetDeploymentId)" in finally_block


def test_broker_refuses_a_vet_token_once_the_run_is_over():
    block = SERVER[SERVER.index("/internal/llm/"):]
    block = block[: block.index("/internal/outlook-send")]
    assert "isVetDeploymentId(deploymentId) && !vetRunActive(deploymentId)" in block
    # Refused the same way an unauthenticated caller is.
    assert block.count("send(res, 401") >= 2


def test_broker_pins_a_vet_run_to_the_declared_model():
    # A vet id has no deployment row, so the model comes from the run registry
    # rather than the DB lookup — checked before it, or the lookup would win.
    assert "const vetModel = vetRunModel(deploymentId);" in SERVER
    assert SERVER.index("vetRunModel(deploymentId)") < SERVER.index("prisma.deployment.findUnique")


def test_vet_run_registry_is_scoped_to_vet_ids():
    assert 'deploymentId.startsWith("vet-")' in VET_BROKER
    # A real deployment is never touched by this gate.
    assert "isVetDeploymentId" in SERVER


def test_reports_are_redacted_before_they_are_stored():
    assert "testResults: redactSecrets(report) as any" in VET
    # Redacts values this process actually holds, not guessed key shapes.
    assert "VET_LLM_API_KEY" in REDACT and "OPENROUTER_API_KEY" in REDACT
    assert "[redacted]" in REDACT


def test_redaction_skips_short_values():
    # A secret var set to something like "1" would otherwise redact ordinary text.
    assert "value.length >= 12" in REDACT
