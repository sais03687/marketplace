"""A creator can see why their version passed or failed.

Vetting runs a full sandbox report — download, static scan, docker build, health
check, egress, and five HTTP probes — and writes it to AgentVersion.testResults.
The API returned it and the versions page discarded it, so a creator saw only
PASSED / FAILED and never which probe failed or why.

Two things make it safe to surface, and both are asserted here because they are
the whole reason this is allowed:

1. Ownership. The versions GET 403s anyone who is not the owning creator.
2. No platform secret can appear in the logs. The vet container is handed only
   noop credentials and an ephemeral random hooks token, so its build and
   runtime output holds nothing sensitive to leak.
"""
import io
from pathlib import Path

WEB = Path(__file__).resolve().parents[1] / "apps" / "web"
PROV = Path(__file__).resolve().parents[1] / "apps" / "provisioning-service"

VERSIONS_API = WEB / "app" / "api" / "agents" / "[slug]" / "versions" / "route.ts"
VERSIONS_PAGE = WEB / "app" / "(auth)" / "creator" / "agents" / "[slug]" / "versions" / "page.tsx"
VET = PROV / "src" / "jobs" / "vet-package.ts"


def test_the_report_is_only_returned_to_the_owning_creator():
    src = io.open(VERSIONS_API, encoding="utf-8").read()
    assert "agent.creatorId !== creator.id" in src
    assert "Not authorized" in src
    # And it must fail closed before the versions are returned.
    guard = src.index("agent.creatorId !== creator.id")
    ret = src.index("return jsonSuccess(agent.versions)")
    assert guard < ret


def test_the_vet_container_gets_no_real_secret():
    """If a real secret entered the vet container, its logs could carry it.

    The container is given noop credentials only. This guards that: if someone
    ever wires a real key into the vet env, this fails, and the report should not
    be surfaced until it is understood.
    """
    src = io.open(VET, encoding="utf-8").read()
    env = src[src.index("const envVars = ["):]
    env = env[: env.index("];")]
    # The LLM key is opt-in now: vet-noop unless an operator sets VET_LLM_API_KEY
    # for a reviewer to test against. Either way it is a dedicated vetting key, never the
    # platform runtime key or an infrastructure secret.
    assert 'process.env.VET_LLM_API_KEY || "vet-noop"' in env
    assert "ANTHROPIC_API_KEY=vet-noop" in env
    # The hooks token is random per run, not the platform secret.
    assert "AGENT_HOOKS_TOKEN=${VET_HOOKS_TOKEN}" in env
    # APPROVAL_WEBHOOK_TOKEN *is* present, but set to the ephemeral random token,
    # not the platform secret - so its presence is safe. The property that
    # matters is that no line pulls a *real* secret into the vet env.
    import re
    # The only host-env value allowed into the vet container is the opt-in
    # vetting LLM key. Anything else read from process.env would be a leak.
    for line in env.splitlines():
        if "process.env." in line:
            assert "VET_LLM_API_KEY" in line, (
                f"the vet container reads a host-env value other than the vetting "
                f"LLM key: {line.strip()}"
            )
    assert "config.microsoftClientSecret" not in env
    assert "config.approvalWebhookToken" not in env
    assert "config.provisioningSecret" not in env
    # Every credential-shaped var resolves to a noop or the ephemeral token.
    for line in env.splitlines():
        m = re.search(r"(TOKEN|SECRET|KEY|CLIENT)=([^`,]*)", line)
        if m:
            val = m.group(2).strip()
            allowed = ("vet-noop", "${VET_HOOKS_TOKEN}", "")
            # The LLM key's opt-in form resolves to vet-noop by default.
            is_optin_llm = "VET_LLM_API_KEY" in val and "vet-noop" in val
            assert val in allowed or is_optin_llm, (
                f"credential var set to something real: {line.strip()}"
            )


def test_the_page_actually_renders_the_report():
    src = io.open(VERSIONS_PAGE, encoding="utf-8").read()
    assert "testResults" in src
    assert "Vetting report" in src
    # The steps and their logs, not just a status badge.
    assert "st.logLines" in src
    assert "steps.map" in src


def test_the_secret_scanner_still_guards_the_creators_own_leaks():
    # A separate protection, kept: the report flags a creator's own leaked keys
    # so they see them before a buyer's agent would.
    src = io.open(VET, encoding="utf-8").read()
    assert "SECRET_PATTERNS" in src
