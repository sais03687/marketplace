"""The homepage does not sell an integration the hire wizard calls unfinished.

The hero read "they live in your email and Slack" and the comparison table
claimed "Works in existing tools (email, Slack)" with a tick, while the hire
wizard badged Slack "Coming soon" and nothing in the product ever set it
connected. A buyer reached the wizard expecting a thing that was not there.

Found on 2026-09-21 while walking the platform as a new user. The general rule
is the one worth holding: whatever the wizard admits is unfinished, the front
page must not advertise as present.
"""
import re
from pathlib import Path

WEB = Path(__file__).resolve().parents[1] / "apps" / "web"
WIZARD = WEB / "components" / "hire"
HOME = WEB / "components" / "home"


def _unfinished_integrations() -> set[str]:
    """Names the hire wizard shows with a "Coming soon" badge."""
    names: set[str] = set()
    for f in WIZARD.glob("*.tsx"):
        src = f.read_text(encoding="utf-8")
        for m in re.finditer(r"Coming soon", src):
            # The label sits in the nearest preceding <p className="font-medium...">
            before = src[max(0, m.start() - 800):m.start()]
            labels = re.findall(r'className="font-medium text-sm">([A-Za-z0-9 ]+)<', before)
            if labels:
                names.add(labels[-1].strip())
    return names


def test_the_wizard_is_the_source_of_truth():
    # If this ever empties, the extraction broke rather than the product becoming
    # complete — and the test below would pass for the wrong reason.
    assert _unfinished_integrations(), "found no 'Coming soon' integrations to check against"


def test_the_homepage_does_not_claim_them():
    unfinished = _unfinished_integrations()
    offences = []
    for f in HOME.glob("*.tsx"):
        src = f.read_text(encoding="utf-8")
        # Ignore comments, which are allowed to explain why a claim was removed.
        # Block comments span lines, line comments must not: one pattern with
        # DOTALL for both deleted everything after the first "//" in the file,
        # and the test passed on a homepage that did make the claim.
        body = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
        body = re.sub(r"//[^\n]*", "", body)
        for name in unfinished:
            if re.search(rf"\b{re.escape(name)}\b", body):
                offences.append(f"{f.name} advertises {name!r}, which the wizard calls unfinished")
    assert not offences, offences
