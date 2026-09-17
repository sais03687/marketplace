"""A hire with no buyer tenant provisions the email tier, and says so.

Microsoft will not let an ordinary employee consent to a file-reading scope
(tested 2026-09-17: a role-less user in a real tenant got "Need admin
approval", and publisher verification would not change it because the default
low-impact classification is only openid/profile/email/offline_access/
User.Read). So a buyer whose IT will not sign off needs an agent that never
touches their tenant: the mailbox lives in the platform tenant, work arrives as
an attachment and leaves the same way.

provision.ts already had the branch for this - "Platform mode: create user in
platform tenant" - but it was an accident rather than a product. Two things were
missing.

It never recorded where the mailbox went. The branch wrote workspaceEmail and
workspaceUserId and left mailboxLocation and workspaceScope at their defaults,
which is why the two oldest platform-mailbox deployments carry rows that
contradict themselves: mailboxLocation "platform" alongside workspaceScope
"buyer_org". Teardown and the pollers read those fields to choose a tenant, so a
wrong value is not cosmetic.

And the container was never told. Without AGENT_TIER the agent offers its
drive_*/excel_* actions, which on this path resolve against the PLATFORM
tenant's SharePoint - shared infrastructure holding other buyers' agents. That
is an isolation bug, not merely a dead end, so the tier has to reach the
container for the tools to be withheld.
"""
import io
import re
from pathlib import Path

PROVISION = (
    Path(__file__).resolve().parents[1]
    / "apps" / "provisioning-service" / "src" / "jobs" / "provision.ts"
)
SRC = io.open(PROVISION, encoding="utf-8").read()


def _platform_env_block() -> str:
    """The env branch used when a deployment has no buyer tenant."""
    i = SRC.index('WORKSPACE_SCOPE: "platform"')
    j = SRC.index("OUTLOOK_SEND_URL", i)
    return SRC[i:j]


def test_the_container_is_told_it_is_the_email_tier():
    assert 'AGENT_TIER: "email"' in _platform_env_block(), (
        "without this the agent advertises drive tools that resolve against the "
        "platform tenant's own SharePoint"
    )


def test_the_buyer_org_branch_does_not_claim_the_email_tier():
    """The org tier keeps every tool; only the platform branch declares email."""
    assert SRC.count('AGENT_TIER: "email"') == 1
    i = SRC.index('WORKSPACE_SCOPE: "buyer_org"')
    j = SRC.index('WORKSPACE_SCOPE: "platform"', i)
    assert "AGENT_TIER" not in SRC[i:j], "buyer_org must not be tagged email tier"


def test_the_folder_stays_per_agent_even_though_the_tools_are_withheld():
    """microsoft_tools defaults SHAREPOINT_FOLDER to a shared "default"."""
    assert "SHAREPOINT_FOLDER: agentSlug" in _platform_env_block(), (
        "an unset value is the version that crosses a buyer boundary"
    )


def test_platform_mode_records_where_the_mailbox_went():
    i = SRC.index("Platform mode: create user in platform tenant")
    block = SRC[i : i + 2200]
    assert 'mailboxLocation: "platform"' in block, (
        "teardown and the pollers read this to choose a tenant"
    )
    assert 'workspaceScope: "platform"' in block


def test_both_platform_paths_agree_on_what_they_wrote():
    """The error fallback and the deliberate branch must record the same thing."""
    assert SRC.count('mailboxLocation: "platform"') >= 2, (
        "the fallback recorded these fields and the deliberate branch did not; "
        "that mismatch is the self-contradicting row"
    )


def test_a_buyer_tenant_failure_still_refuses_to_relocate_the_agent():
    """Unchanged: choosing your own tenant means your tenant or a visible error."""
    assert "if (err instanceof BuyerTenantProvisioningError || buyerTenantId) {" in SRC
    assert "Buyer tenant cannot host this agent" in SRC
