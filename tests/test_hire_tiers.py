"""An agent is only offered, and only hired, on a tier where it can do its job.

Email only gives an agent its own mailbox on the platform and nothing of the
buyer's: no files, spreadsheets, calendar or directory. Until 2026-10-11 nothing
connected that to the agent. Every listing said "Email only: nothing to install",
the wizard defaulted to it, and a buyer could pay for an agent that needed their
SharePoint on a tier where every such call fails.

Worse, the email tier was handed a Graph token anyway - app-only, for the
platform's own tenant, where every buyer's email-tier agent lives - guarded only
by the scopes the agent's own manifest chose to declare. So the tier also stops
issuing that token.

The rule: graphScopes beyond mail.send mean Connect Microsoft 365 only, unless
the creator states hireTiers ["platform", "buyer_org"] for an agent that also
works by email alone.
"""
import asyncio
import json
from pathlib import Path

import pytest

import adapter

ROOT = Path(__file__).resolve().parents[1]
SCHEMA_TIERS = ROOT / "packages" / "agent-package-schema" / "src" / "tiers.ts"
SERVER = ROOT / "apps" / "provisioning-service" / "src" / "server.ts"
HIRE = ROOT / "apps" / "web" / "app" / "api" / "deployments" / "route.ts"
UPLOAD = ROOT / "apps" / "web" / "app" / "api" / "packages" / "upload" / "route.ts"
VERSIONS = ROOT / "apps" / "web" / "app" / "api" / "agents" / "[slug]" / "versions" / "route.ts"
WIZARD = ROOT / "apps" / "web" / "components" / "hire" / "step-connect.tsx"
LISTING = ROOT / "apps" / "web" / "app" / "(public)" / "agents" / "[slug]" / "page.tsx"
DATA_ANALYST = ROOT / "agents" / "data-analyst"


def _read(p: Path) -> str:
    return p.read_text(encoding="utf-8")


# ── The email tier makes no Graph calls ─────────────────────────────────────

def test_graph_fn_is_refused_on_the_email_tier(monkeypatch):
    async def must_not_be_reached():
        raise AssertionError("the email tier asked for a Graph token")

    monkeypatch.setattr(adapter, "_EMAIL_TIER", True)
    monkeypatch.setattr(adapter, "_ms_token", must_not_be_reached)
    with pytest.raises(adapter.ActionRefused, match="email tier"):
        asyncio.run(adapter.graph_request("GET", "/users/someone@x.com/messages"))


def test_graph_fn_still_works_on_the_connected_tier(monkeypatch):
    class Reached(Exception):
        pass

    async def token():
        raise Reached

    monkeypatch.setattr(adapter, "_EMAIL_TIER", False)
    monkeypatch.setattr(adapter, "_ms_token", token)
    monkeypatch.setattr(adapter, "_SCOPES_DECLARED", False)
    with pytest.raises(Reached):
        asyncio.run(adapter.graph_request("GET", "/users/a@b.c/drive/root/children"))


def test_the_token_endpoint_refuses_email_tier_agents_before_minting():
    src = _read(SERVER)
    start = src.index('req.url === "/internal/microsoft-token"')
    block = src[start:src.index("mintTokenForTenant(tenantId)", start)]
    assert "if (!isPlatformCaller)" in block and "isEmailTierDeployment(deploymentId)" in block
    assert "emailTier !== false" in block, "an unknown tier must be refused, not let through"
    # Read from buyerMicrosoftTenantId, not the resolved tenant id: a connected buyer
    # whose organisation is the platform's tenant resolves to the same id.
    fn = src[src.index("async function isEmailTierDeployment"):]
    assert "!deployment.buyerMicrosoftTenantId" in fn[:1200]


# ── The rule, as the CLI and the schema state it ────────────────────────────

def _cli():
    import sys
    sys.path.insert(0, str(ROOT / "packages" / "agentstore-cli" / "src"))
    from agentstore import check as c
    return c


@pytest.mark.parametrize("manifest,tiers", [
    ({"graphScopes": ["mail.send"]}, ["platform", "buyer_org"]),
    ({"graphScopes": []}, ["platform", "buyer_org"]),
    ({}, ["platform", "buyer_org"]),
    ({"graphScopes": ["files.read", "mail.send"]}, ["buyer_org"]),
    ({"graphScopes": ["calendar.read"]}, ["buyer_org"]),
    ({"graphScopes": ["files.read"], "hireTiers": ["platform", "buyer_org"]}, ["platform", "buyer_org"]),
    ({"graphScopes": [], "hireTiers": ["buyer_org"]}, ["buyer_org"]),
])
def test_which_tiers_an_agent_is_offered_on(manifest, tiers):
    assert _cli().hire_tiers(manifest) == tiers


def test_the_cli_and_the_schema_agree_on_what_email_only_can_do():
    src = _read(SCHEMA_TIERS)
    assert 'EMAIL_TIER_SCOPES: readonly GraphScope[] = ["mail.send"]' in src
    assert 'HIRE_TIERS = ["platform", "buyer_org"]' in src
    assert _cli().EMAIL_TIER_SCOPES == {"mail.send"}
    assert _cli().HIRE_TIERS == ("platform", "buyer_org")


# ── Every surface follows it ────────────────────────────────────────────────

def test_the_hire_endpoint_refuses_an_email_hire_of_a_connected_only_agent():
    src = _read(HIRE)
    assert "tierOfVersion(agent.id, agent.currentVersion)" in src
    assert 'tier.requiresOrg && (data.mailboxLocation !== "buyer_org" || !data.buyerMicrosoftTenantId)' in src
    # Before the deployment row is written, not after.
    assert src.index("tier.requiresOrg") < src.index("prisma.deployment.create")


def test_both_upload_routes_refuse_undeclared_graph_use():
    for route in (UPLOAD, VERSIONS):
        src = _read(route)
        assert "undeclaredGraphUse(zip, manifest)" in src, route.name


def test_the_wizard_disables_email_only_when_the_agent_needs_microsoft_365():
    src = _read(WIZARD)
    assert 'const unavailable = value === "platform" && emailTierUnavailable;' in src
    assert "disabled={unavailable}" in src
    assert 'updateState({ mailboxLocation: "buyer_org", workspaceProvider: "MICROSOFT" })' in src
    # Not clickable past while the requirement is unknown.
    assert '"Checking what this agent needs…"' in src


def test_the_listing_says_when_email_only_is_not_available():
    src = _read(LISTING)
    assert "Not available on Email only" in src
    assert "tierOfVersion(agent.id, agent.currentVersion)" in src


# ── Creator tooling and the platform's own agent ────────────────────────────

def _check(tmp_path, manifest, code="async def run_agent(content, context, graph_fn):\n    return {}\n"):
    (tmp_path / "agent.py").write_text(code + "async def resume_agent(t, r, **k):\n    return {}\n")
    (tmp_path / "marketplace.json").write_text(json.dumps({
        "name": "T", "slug": "t", "version": "1.0.0", "modelTier": "standard", **manifest}))
    c = _cli()
    return [(f.level, f.message) for f in c.check(tmp_path) if "graph" in f.message or "hireTiers" in f.message]


def test_check_refuses_graph_fn_without_graph_scopes(tmp_path):
    assert any(level == "error" for level, _ in _check(tmp_path, {}))


def test_check_warns_when_graph_code_would_be_offered_on_email_only_by_default(tmp_path):
    found = _check(tmp_path, {"graphScopes": ["mail.send"]})
    assert found and all(level == "warning" for level, _ in found)


def test_check_trusts_an_explicit_email_only_promise(tmp_path):
    assert _check(tmp_path, {"graphScopes": ["files.read"], "hireTiers": ["platform", "buyer_org"]}) == []


def test_check_refuses_an_unknown_tier(tmp_path):
    assert any(level == "error" for level, _ in _check(tmp_path, {"graphScopes": [], "hireTiers": ["email"]}))


def test_data_analyst_declares_what_it_reaches_and_works_on_both_tiers():
    m = json.loads(_read(DATA_ANALYST / "marketplace.json"))
    assert m["hireTiers"] == ["platform", "buyer_org"]
    assert {"files.read", "excel.read", "mail.send"} <= set(m["graphScopes"])
    c = _cli()
    assert [f for f in c.check(DATA_ANALYST) if f.level == c.ERROR] == []


def test_data_analyst_offers_no_graph_backed_action_on_the_email_tier():
    from creator import agent
    for action in ("inbox_list", "inbox_read", "calendar_list", "calendar_create",
                   "my_drive_list", "drive_list", "excel_read"):
        assert action in agent._ORG_ONLY_ACTIONS, action
    # Mail still works there: it goes through the platform's send endpoint.
    assert "reply_email" not in agent._ORG_ONLY_ACTIONS
    assert "send_email" not in agent._ORG_ONLY_ACTIONS
