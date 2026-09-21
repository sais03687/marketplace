"""What the platform's own emails and settings promise has to be true.

Each of these was a small untruth that a buyer could only discover by acting on
it: an approval email that asked for consent to text it had cut off mid-sentence,
a new hire opening by offering SharePoint on a tier where SharePoint is withheld,
a setting that said new versions are applied as they are approved while the query
behind it only ever looked at one of the two states it runs in, and a log line
claiming a feature was Enabled from a process with no way to know.
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EMAIL = ROOT / "apps" / "web" / "lib" / "email.ts"
ADVANCE = (ROOT / "apps" / "web" / "app" / "api" / "deployments" / "[id]"
           / "onboarding" / "advance" / "route.ts")
VET = ROOT / "apps" / "web" / "app" / "api" / "packages" / "[id]" / "vet-decision" / "route.ts"
POLLER = ROOT / "apps" / "provisioning-service" / "src" / "jobs" / "outlook-poller.mjs"
MANIFEST = ROOT / "agents" / "data-analyst" / "marketplace.json"


def test_an_approval_shows_enough_to_approve():
    # 200 characters stopped inside the opening sentence, before any figure.
    src = EMAIL.read_text(encoding="utf-8")
    assert "draftPreview.slice(0, 200)" not in src
    assert "const LIMIT = 2000;" in src


def test_a_trimmed_draft_says_what_was_left_out():
    src = EMAIL.read_text(encoding="utf-8")
    assert "more characters" in src and "before approving" in src


def test_the_draft_keeps_its_line_breaks():
    # The draft is plain text going into HTML; without this it arrives as one
    # unreadable paragraph, tables and all.
    src = EMAIL.read_text(encoding="utf-8")
    assert 'replace(/\\n/g, "<br>")' in src


def test_the_intro_email_does_not_promise_a_workspace_the_tier_lacks():
    src = ADVANCE.read_text(encoding="utf-8")
    assert 'deployment.workspaceScope === "platform"' in src
    assert "WORKSPACE_WORDS" in src
    # The Drive service account offer is gated by the same test.
    assert "googleServiceAccountEmail: emailTier" in src


def test_the_capability_filter_catches_the_obvious_words():
    src = ADVANCE.read_text(encoding="utf-8")
    pattern = re.search(r"WORKSPACE_WORDS\s*=\s*\n?\s*/(.+?)/i", src, re.S)
    assert pattern, "the filter must be a regex"
    rx = re.compile(pattern.group(1), re.I)
    for phrase in ["Reads SharePoint files", "Writes to OneDrive", "Excel on the workspace",
                   "Shares a link to the result", "Reads Google Drive"]:
        assert rx.search(phrase), phrase
    # And leaves the tier's real abilities alone.
    for phrase in ["Cleans and totals a CSV", "Answers questions about your figures",
                   "Builds a chart from attached data"]:
        assert not rx.search(phrase), phrase


def test_auto_update_covers_every_state_it_claims_to():
    src = VET.read_text(encoding="utf-8")
    assert 'status: { in: ["ACTIVE", "ONBOARDING"] }' in src


def test_the_poller_does_not_claim_agentmind_is_enabled():
    src = POLLER.read_text(encoding="utf-8")
    assert "[agentmind] Enabled" not in src
    assert "Will query" in src


def test_the_listing_does_not_promise_sharepoint_to_every_buyer():
    manifest = MANIFEST.read_text(encoding="utf-8")
    assert "delivered via SharePoint" not in manifest
