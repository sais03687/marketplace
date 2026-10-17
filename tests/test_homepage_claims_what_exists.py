"""The homepage does not sell an integration the product does not have.

The hero read "they live in your email and Slack" and the comparison table
claimed "Works in existing tools (email, Slack)" with a tick, while the hire
wizard badged Slack "Coming soon" and nothing in the product ever set it
connected. A buyer reached the wizard expecting a thing that was not there.

Found on 2026-09-21 while walking the platform as a new user. Since 2026-10-16
the wizard shows nothing unfinished at all (the Slack card was removed), so the
rule is now simply: no "Coming soon" in the wizard, and no unbuilt integration
named on the homepage.
"""
import re
from pathlib import Path

WEB = Path(__file__).resolve().parents[1] / "apps" / "web"
WIZARD = WEB / "components" / "hire"
HOME = WEB / "components" / "home"

# Integrations that are not built.
UNBUILT = {"Slack"}


def test_the_wizard_shows_nothing_unfinished():
    for f in WIZARD.glob("*.tsx"):
        assert "Coming soon" not in f.read_text(encoding="utf-8"), f.name


def test_the_homepage_does_not_claim_them():
    offences = []
    for f in HOME.glob("*.tsx"):
        src = f.read_text(encoding="utf-8")
        # Ignore comments, which are allowed to explain why a claim was removed.
        # Block comments span lines, line comments must not: one pattern with
        # DOTALL for both deleted everything after the first "//" in the file,
        # and the test passed on a homepage that did make the claim.
        body = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
        body = re.sub(r"//[^\n]*", "", body)
        for name in UNBUILT:
            if re.search(rf"\b{re.escape(name)}\b", body):
                offences.append(f"{f.name} advertises {name!r}, which is not built")
    assert not offences, offences
