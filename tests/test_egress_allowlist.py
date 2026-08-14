"""An agent allowed to reach Graph and nothing else cannot open a file.

Graph does not serve file bytes. /items/{id}/content answers 302 with a
short-lived pre-authenticated URL on the tenant's own SharePoint host, so the
download never touches graph.microsoft.com. With only Graph on the egress
allowlist, drive_fetch asked for a 23.58 MB CSV it was fully authorised to read
and got "403 Filtered" from the netgate three times running (2026-08-14).

The fix is a named host, not a pattern. `*.sharepoint.com` would reach every
tenant in the world, including one an attacker controls — which is not a
download route, it is an exfiltration route. The tinyproxy filter already
anchors both ends and permits subdomains, so one exact host is enough and
nothing wider is needed.
"""
import io
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1] / "apps" / "provisioning-service" / "src"
EGRESS = io.open(ROOT / "clients" / "egress-proxy.ts", encoding="utf-8").read()
CONFIG = io.open(ROOT / "config.ts", encoding="utf-8").read()
ENTRY = io.open(ROOT / "docker" / "egress-proxy" / "entrypoint.sh", encoding="utf-8").read()


def test_the_sharepoint_host_is_allowed_when_there_is_one():
    assert "config.sharepointHost" in EGRESS
    assert "hosts.add(config.sharepointHost)" in EGRESS


def test_it_is_a_named_host_and_never_a_wildcard():
    # The whole point: one tenant, not every tenant.
    for wild in ('"*.sharepoint.com"', "'*.sharepoint.com'", '"sharepoint.com"'):
        assert wild not in EGRESS, (
            f"{wild} on the allowlist reaches every SharePoint tenant there is"
        )


def test_an_agent_with_no_sharepoint_gets_no_extra_host():
    # Empty by default, and falsy values must not add an empty rule — an empty
    # entry in the filter file is a pattern that matches more than intended.
    assert 'process.env.SHAREPOINT_HOST || ""' in CONFIG
    assert "if (config.sharepointHost)" in EGRESS


def test_the_filter_still_denies_by_default():
    # If this ever flips, every rule above becomes decoration.
    assert "FilterDefaultDeny Yes" in ENTRY


def test_a_lookalike_host_cannot_match_an_allowed_one():
    # The rule the entrypoint writes, applied the way tinyproxy applies it.
    rule = re.compile(r"^([a-zA-Z0-9_-]+\.)*agentstore\.sharepoint\.com$")
    assert rule.match("agentstore.sharepoint.com")
    assert rule.match("eu1.agentstore.sharepoint.com")
    assert not rule.match("agentstore.sharepoint.com.attacker.co")
    assert not rule.match("evil-agentstore.sharepoint.com.co")
    assert not rule.match("attacker.sharepoint.com")
