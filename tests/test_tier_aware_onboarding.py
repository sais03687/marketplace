"""Don't ask a buyer about a workspace they don't have.

The first real email-tier hire (2026-09-18) was asked "How is your SharePoint
organized? Are there specific folders for reports?" - on a tier where every
drive and SharePoint action is withheld from the agent. Answering it is wasted
effort, and being asked implies a capability the agent does not have.

Two smaller things from the same hire:

The Confirm step printed "Workspace: Microsoft 365" one step after the buyer
chose the option labelled "no IT approval needed". workspaceProvider is
MICROSOFT on both tiers - the agent's own mailbox is a Microsoft 365 mailbox
wherever it lives - so the row was reading the wrong field and implied a tenant
connection that had not happened. And "Data location" rendered only when a
tenant WAS connected, so the buyer who most needed to know where their files end
up, the one emailing them to us, was the only one not told.

And createMicrosoftUser queued OneDrive for an agent whose my_drive_* actions
are all withheld. Not free: it resets the user's password, takes a delegated
token and re-randomises, and on a seconds-old account the reset races directory
propagation and logs a 404 that reads like a failed hire.

Filtered server-side rather than left to creator guidance, for the same reason
the workspace tools are withheld rather than discouraged: a question a creator
was merely advised not to ask still gets asked. Omitting `tiers` means both, so
every existing package is untouched.
"""
import io
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _read(*parts: str) -> str:
    return io.open(ROOT.joinpath(*parts), encoding="utf-8").read()


QUESTIONS = _read("apps", "web", "lib", "platform-questions.ts")
INTERVIEW = _read("apps", "web", "components", "hire", "step-interview.tsx")
CONFIRM = _read("apps", "web", "components", "hire", "step-confirmation.tsx")
MSW = _read("apps", "provisioning-service", "src", "clients", "microsoft-workspace.ts")
PROVISION = _read("apps", "provisioning-service", "src", "jobs", "provision.ts")
SCHEMA = _read("packages", "agent-package-schema", "src", "types.ts")


# ── tier-aware questions ────────────────────────────────────────────────────

def test_the_merge_takes_a_tier():
    assert 'mailboxLocation: "platform" | "buyer_org" = "buyer_org",' in QUESTIONS


def test_a_question_with_no_tiers_is_asked_on_both():
    """Every package published before this field keeps working."""
    assert "!Array.isArray(q.tiers) || q.tiers.length === 0" in QUESTIONS


def test_both_creator_and_platform_questions_are_filtered():
    assert ").filter(appliesHere);" in QUESTIONS, "creator questions"
    assert "!existingIds.has(q.id) && appliesHere(q)" in QUESTIONS, "platform questions"


def test_the_hire_wizard_passes_the_chosen_tier():
    assert "mergeWithPlatformQuestions(agent.onboardingQuestions, state.mailboxLocation)" in INTERVIEW


def test_the_wizard_refetches_when_the_tier_changes():
    """The tier is chosen on the previous step and Back is allowed."""
    assert "[state.agentSlug, state.mailboxLocation]" in INTERVIEW


def test_the_sharepoint_question_is_org_only():
    raw = json.loads(_read("agents", "data-analyst", "onboarding", "questions.json"))
    qs = raw if isinstance(raw, list) else raw["questions"]
    by_id = {q["id"]: q for q in qs}
    assert by_id["sharepoint_structure"]["tiers"] == ["buyer_org"]
    for other in ("team_roster", "data_sources", "approval_instructions", "off_limits"):
        assert "tiers" not in by_id[other], f"{other} applies to both tiers"


def test_the_field_exists_in_the_package_schema():
    """A creator's questions.json is validated against this."""
    assert 'tiers?: Array<"platform" | "buyer_org">;' in SCHEMA


# ── the confirm step ────────────────────────────────────────────────────────

def test_confirm_reports_the_tier_not_the_provider():
    assert "<span>Microsoft 365</span>" not in CONFIRM, (
        "true on both tiers, so it told an email-tier buyer they had connected "
        "a tenant they had not"
    )
    assert '"Email only — no connection needed"' in CONFIRM


def test_data_location_is_shown_on_both_tiers():
    assert '"Files you email are processed on our servers"' in CONFIRM
    i = CONFIRM.index("Data location")
    assert "state.buyerMicrosoftTenantId &&" not in CONFIRM[max(0, i - 400):i], (
        "this row used to be hidden from exactly the buyer who needed it"
    )


# ── no drive for a tier with no drive tools ─────────────────────────────────

def test_onedrive_can_be_skipped():
    assert "opts: { skipOneDrive?: boolean } = {}," in MSW
    assert "if (opts.skipOneDrive) {" in MSW


def test_the_email_tier_skips_it():
    assert "createMicrosoftUser(username, agentName, { skipOneDrive: true })" in PROVISION


def test_the_org_path_is_untouched():
    """The buyer-tenant mailbox comes from createAgentMailbox, not this call."""
    assert "createAgentMailbox(buyerTenantId" in PROVISION

# ── the fire dialog ─────────────────────────────────────────────────────────

AGENT_PAGE = _read(
    "apps", "web", "app", "(auth)", "dashboard", "agents", "[deploymentId]", "page.tsx"
)


def test_fire_dialog_does_not_promise_to_delete_a_drive_that_never_existed():
    assert 'deployment.mailboxLocation !== "platform" && (' in AGENT_PAGE, (
        "an email-tier agent has no OneDrive; every my_drive_* action is withheld"
    )


def test_fire_dialog_says_something_true_about_kept_files():
    assert 'deployment.mailboxLocation === "platform" ? (' in AGENT_PAGE
    assert "it only" in AGENT_PAGE and "ever had what you emailed it" in AGENT_PAGE, (
        "the email tier has no shared SharePoint folder to keep"
    )


def test_the_page_can_actually_read_the_tier():
    assert "mailboxLocation: string | null;" in AGENT_PAGE, (
        "the API returns the whole deployment row; the interface omitted this"
    )
