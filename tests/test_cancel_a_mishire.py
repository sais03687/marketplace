"""A buyer who hires by mistake has to be able to undo it.

On 2026-08-19 the overview for an ONBOARDING deployment offered one control:
"Activate Agent". No fire, no cancel, nothing in Settings either. The whole
action bar was behind `!isFired && !isOnboarding`.

So the only way out of a mis-hire was to activate the agent first — which sends
an introduction email to the buyer's team. The escape from a mistake was to
announce it. The API could always do this; the dashboard could not, which is how
it went unnoticed: every test of firing used an ACTIVE deployment.
"""
import io
from pathlib import Path

PAGE = (
    Path(__file__).resolve().parents[1]
    / "apps" / "web" / "app" / "(auth)" / "dashboard" / "agents" / "[deploymentId]" / "page.tsx"
)
SRC = io.open(PAGE, encoding="utf-8").read()


def test_the_action_bar_is_not_hidden_during_onboarding():
    assert "{!isFired && !isOnboarding && (" not in SRC, (
        "this hid the only way to cancel a hire that had not started"
    )
    assert "{!isFired && (" in SRC


def test_pause_is_still_hidden_before_the_agent_starts():
    # Pausing something that has not begun is not a thing to offer.
    bar = SRC[SRC.index("{/* Action buttons */}"):][:2600]
    assert "{!isOnboarding && (" in bar


def test_the_button_is_worded_for_someone_who_never_started():
    assert 'isOnboarding ? "Cancel hire" : "Fire agent"' in SRC


def test_it_goes_through_the_same_confirmation():
    """The dialog explains the seat is released and billing stops at period end.

    Both are exactly as true for a cancelled hire as a fired one, so it would be
    worse to invent a second, thinner path than to reuse this.
    """
    bar = SRC[SRC.index("{/* Action buttons */}"):][:2600]
    assert "setConfirmFire(true)" in bar
    assert "licence seat, free for another agent" in SRC
