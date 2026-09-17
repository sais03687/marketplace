"""A buyer with no Global Administrator must be able to finish a hire.

Step 3 of the wizard used to hard-block: the Continue button was disabled
until a Microsoft 365 tenant was connected, and connecting runs
/common/adminconsent, which only a Global Administrator can complete. So every
buyer whose IT would not sign off reached a dead end with no way forward and no
explanation of why.

That gate cannot be engineered away on Microsoft's side - tested against a live
tenant on 2026-09-17, a role-less user requesting a file-reading scope was
refused with "Need admin approval", and publisher verification would not change
it because the default low-impact classification is only openid / profile /
email / offline_access / User.Read.

So the tier became a choice. "platform" asks nothing of the buyer's tenant: the
agent's mailbox lives in ours, work arrives as an attachment and leaves the same
way, and its workspace tools are withheld rather than offered and broken. It is
the default because it is the path that always completes.

The one subtlety: workspaceProvider stays MICROSOFT on both tiers, because the
agent's own mailbox is a Microsoft 365 mailbox whichever tenant hosts it.
Setting it to NONE would skip mailbox creation entirely in provision.ts and
leave the agent unable to receive anything.
"""
import io
from pathlib import Path

WEB = Path(__file__).resolve().parents[1] / "apps" / "web"
STEP = io.open(WEB / "components" / "hire" / "step-connect.tsx", encoding="utf-8").read()
CTX = io.open(WEB / "lib" / "hire-context.tsx", encoding="utf-8").read()


def test_the_email_tier_can_never_block_the_hire():
    assert 'state.mailboxLocation === "platform"\n      ? null' in STEP, (
        "the email tier asks nothing of their tenant, so nothing can be missing"
    )


def test_the_block_message_names_the_way_out():
    assert "or choose Email only above" in STEP, (
        "a disabled button with no alternative is the dead end this fixes"
    )


def test_both_tiers_are_offered():
    assert "TIER_OPTIONS" in STEP
    assert '"platform"' in STEP and '"buyer_org"' in STEP
    assert "no IT approval needed" in STEP


def test_the_easy_tier_is_listed_first_and_is_the_default():
    # by label, not by `value:` — the type annotation lists both values above
    # the options array and would match first.
    i = STEP.index("Email only — no IT approval needed")
    j = STEP.index("Connect Microsoft 365\",")
    assert i < j, "the path that always completes should be the one they see first"
    assert 'mailboxLocation: "platform",' in CTX, "default must be the unblocked tier"


def test_choosing_email_drops_the_tenant():
    """Dropping the tenant is what selects the email tier in provisioning."""
    assert 'if (value === "platform") {' in STEP
    assert "buyerMicrosoftTenantId: null" in STEP


def test_provider_stays_microsoft_on_both_tiers():
    assert 'workspaceProvider: "MICROSOFT" })' in STEP, (
        "NONE would skip mailbox creation and leave the agent unreachable"
    )


def test_the_microsoft_panels_follow_the_tier_not_the_provider():
    """workspaceProvider is MICROSOFT on both tiers, so it cannot gate the UI."""
    assert 'state.workspaceProvider === "MICROSOFT"' not in STEP, (
        "this condition is now true on both tiers and would show admin-consent "
        "prompts to a buyer who chose email only"
    )
    assert 'state.mailboxLocation === "buyer_org" && !msConnected' in STEP


def test_the_email_tier_explains_what_it_is():
    assert "Nothing to set up" in STEP
    assert "cannot reach anything you don" in STEP, (
        "the smaller blast radius is the selling point, not a caveat"
    )
