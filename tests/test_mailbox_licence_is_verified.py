"""A hire that cannot produce a mailbox must fail, not charge and go quiet.

On 2026-09-23 an email-tier hire completed against a tenant whose mailbox SKU
had every seat consumed. Graph's assignLicense returned 2xx and applied nothing.
Provisioning logged no error at all, the deployment went ACTIVE, Stripe charged
$29, and the agent's mailbox was never built:

    [error] list messages: 404 MailboxNotEnabledForRESTAPI

On this tier the mailbox is the product. The agent could not receive the email
its buyer sent, and could not send one.

Two things had to be true and were not: the licence has to be read back after it
is assigned, and a deployment with no mailbox at all must not be reported as
provisioned.
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKSPACE = (ROOT / "apps" / "provisioning-service" / "src" / "clients" / "microsoft-workspace.ts")
PROVISION = (ROOT / "apps" / "provisioning-service" / "src" / "jobs" / "provision.ts")
WS = WORKSPACE.read_text(encoding="utf-8")
PROV = PROVISION.read_text(encoding="utf-8")


def test_seat_availability_is_checked_before_assigning():
    assert "subscribedSkus" in WS
    assert "consumedUnits >= total" in WS
    # The message has to name the fix, since only an operator can apply it.
    assert "admin centre" in WS


def test_the_licence_is_read_back_after_assignment():
    block = WS[WS.index("async function ensureMailboxLicence"):]
    block = block[: block.index("\n}\n")]
    assign = block.index("assignLicense")
    # A read of assignedLicenses after the write, not only before it.
    reads_after = block.index("assignedLicenses", assign)
    assert reads_after > assign, "nothing verifies the licence actually landed"
    assert "never appeared on the" in block


def test_both_creation_paths_license_the_user():
    # The reuse path returned early, so a user left unlicensed by an earlier
    # failed attempt stayed unlicensed.
    calls = re.findall(r"ensureMailboxLicence\(", WS)
    assert len(calls) >= 3, "expected the helper, plus both create and reuse paths"


def test_a_deployment_with_no_mailbox_fails_the_hire():
    block = PROV[PROV.index("Platform mode: create user in platform tenant"):]
    block = block[: block.index("Workspace identity is created with a deterministic username")]
    assert "throw new Error(" in block, "the failure is still only warned about"
    assert "Could not give this agent a mailbox" in block
    # A re-provision that already has an identity keeps working.
    assert "existingEmail" in block
