"""A buyer who chose their own tenant gets it, or gets a failure they can see.

On 2026-08-20 the first hire against a genuinely separate Microsoft tenant
produced a billed, running, healthy-looking agent that could never receive an
email.

Admin consent takes minutes to propagate; the hire ran seconds after it was
granted. `createAgentMailbox` got 403 Authorization_RequestDenied three times
over about fourteen seconds and gave up — the same call succeeded by hand a few
minutes later. The catch then fell back to creating the mailbox on the
*platform* domain, while `buyerMicrosoftTenantId` went on pointing at the
buyer's tenant. So the poller asked tenant B for a user only tenant A could
have:

    [error] list messages: 404 ErrorInvalidUser
      "The requested user 'data-analyst-...@agents.agentstore.it.com' is invalid."

on every polling cycle, forever. `provision_complete` recorded success.

Two faults, one visible outcome. The retry window was far too short for what it
was waiting on, and the guard that was supposed to prevent relocating a buyer's
agent named a single error class while the failure arrived as a different one.
"""
import io
from pathlib import Path

PROVISION = (
    Path(__file__).resolve().parents[1]
    / "apps" / "provisioning-service" / "src" / "jobs" / "provision.ts"
)
SRC = io.open(PROVISION, encoding="utf-8").read()


def test_a_buyer_tenant_hire_never_falls_back_to_the_platform():
    """The comment always said this; the code checked one error class."""
    assert "if (err instanceof BuyerTenantProvisioningError || buyerTenantId) {" in SRC, (
        "any failure to place the mailbox in the chosen tenant must fail the hire, "
        "not relocate the agent's identity somewhere the buyer never picked"
    )


def test_the_fallback_is_still_available_to_platform_mode_hires():
    # It is the right behaviour when no buyer tenant was chosen — which is every
    # hire this system did before 2026-08-20, and why the hole went unnoticed.
    fallback = SRC[SRC.index("Falling back to platform Microsoft user"):][:400]
    assert "create_workspace_user_microsoft_fallback" in fallback


def test_the_mailbox_call_waits_out_consent_propagation():
    """Fourteen seconds against a thing that takes minutes is not a retry."""
    call = SRC[SRC.index("createAgentMailbox(buyerTenantId"):][:400]
    assert "maxRetries: 8" in call


def test_the_guard_sits_before_the_fallback_runs():
    guard = SRC.index("|| buyerTenantId) {")
    fallback = SRC.index("Falling back to platform Microsoft user")
    assert guard < fallback


def test_the_reason_is_recorded_where_the_next_person_will_look():
    # The failure was invisible: a healthy dashboard, a silent agent, and a
    # provisioning log reading `succeeded`. Whoever meets it next should find the
    # explanation at the line that caused it.
    assert "ErrorInvalidUser" in SRC
    assert "propagating" in SRC


# ── and teardown has to survive the same disagreement ──────────────────────

DEPROVISION = (
    Path(__file__).resolve().parents[1]
    / "apps" / "provisioning-service" / "src" / "jobs" / "deprovision.ts"
)
DEP_SRC = io.open(DEPROVISION, encoding="utf-8").read()


def test_the_identity_is_deleted_from_the_tenant_it_lives_in():
    """Firing the broken deployment left its mailbox holding a licence seat.

    deleteAgentIdentity was pointed at buyerMicrosoftTenantId — tenant B — while
    the fallback had put the mailbox in tenant A. The delete found nothing, said
    nothing, and the account sat there licensed after the agent was gone. The
    comment above that line already warned this would "silently leave them paying
    for a fired agent"; it arrived from the other direction.
    """
    assert 'mailboxLocation === "platform" ? null : buyerTenantId' in DEP_SRC
    assert "deleteAgentIdentity(identityTenant ?? null" in DEP_SRC


def test_it_reads_the_field_the_fallback_writes():
    # mailboxLocation is set to "platform" by the fallback for exactly this.
    assert "mailboxLocation" in DEP_SRC
    assert 'mailboxLocation: "platform"' in SRC, "provisioning must still record it"
