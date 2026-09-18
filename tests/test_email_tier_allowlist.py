"""An email-tier agent must not treat our tenant as the buyer's organisation.

Who may email an agent is decided by isSenderAllowed: the manager, an explicit
per-deployment list, and a domain wildcard for "inside the organisation". On the
org tier the wildcard is right - the mailbox lives in the buyer's tenant, so
Microsoft's verified domains for that tenant are their colleagues.

The email tier has no buyer tenant, and both sources of the wildcard silently
pointed at ours instead.

provision.ts read `getVerifiedDomains(buyerTenantId || config.microsoftTenantId)`
and wrote the result onto the buyer's company row. With no buyer tenant that is
OUR verified domains, so the company record claimed to own agents.agentstore.it.com.

And isSenderAllowed adds agentOwnDomain() unconditionally - the domain of the
agent's own mailbox. On the org tier that is the buyer's domain and admits their
colleagues with no network call. On the email tier the mailbox is in our tenant,
so it admits every other agent on the platform: one buyer's agent could mail
another's and be accepted.

Together: the buyer's actual colleagues locked out, and a cross-buyer trust leak
in their place. Neither was noticed because platform-hosted mailboxes were an
error path nobody sold until 2026-09-17.

So the email tier has no wildcard at all. The manager, plus whoever the buyer
lists - which is also the tighter default a buyer would expect from a tier that
never touches their tenant.
"""
import io
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PROVISION = io.open(ROOT / "apps" / "provisioning-service" / "src" / "jobs" / "provision.ts", encoding="utf-8").read()
POLLER = io.open(ROOT / "apps" / "provisioning-service" / "src" / "jobs" / "outlook-poller.mjs", encoding="utf-8").read()
ALLOWLIST = io.open(ROOT / "apps" / "web" / "app" / "api" / "deployments" / "[id]" / "allowlist" / "route.ts", encoding="utf-8").read()


def test_our_tenant_is_never_read_as_the_buyers():
    assert "getVerifiedDomains(buyerTenantId || config.microsoftTenantId)" not in PROVISION, (
        "this fallback wrote the platform's own domains onto a buyer's company row"
    )
    assert "getVerifiedDomains(buyerTenantId)" in PROVISION


def test_the_domain_lookup_is_gated_on_having_a_tenant():
    i = PROVISION.index("getVerifiedDomains(buyerTenantId)")
    assert "if (buyerTenantId) {" in PROVISION[max(0, i - 700) : i]


def test_the_email_tier_says_why_it_has_no_wildcard():
    assert "Email tier: no tenant to verify" in PROVISION


def test_the_poller_only_trusts_its_own_domain_when_told_to():
    assert "...(allowlistCache.trustAgentOwnDomain ? [agentOwnDomain()] : [])" in POLLER, (
        "unconditional agentOwnDomain() admits every agent in our tenant"
    )


def test_silence_from_an_older_platform_narrows_rather_than_widens():
    i = POLLER.index("let allowlistCache = {")
    assert "trustAgentOwnDomain: false," in POLLER[i : i + 700], (
        "defaulting true would re-open the leak against a platform that has not "
        "redeployed"
    )


def test_the_api_reports_the_tier():
    assert 'trustAgentOwnDomain: deployment.mailboxLocation !== "platform"' in ALLOWLIST
    assert "mailboxLocation: true," in ALLOWLIST, "it has to be selected to be read"


def test_the_manager_and_the_explicit_list_still_work():
    """The two routes that must survive on a tier with no wildcard."""
    assert "if (managerEmail && email === managerEmail.toLowerCase()) return true;" in POLLER
    assert "for (const entry of allowedEmails || []) {" in POLLER
