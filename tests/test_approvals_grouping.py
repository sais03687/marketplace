"""Two agents, and no way to tell whose approval you were resolving.

With one agent the list was unambiguous. With two it was not: on 2026-08-19 the
dashboard showed two `data-analysis` rows raised minutes apart, and nothing on
either said which agent had raised it. The only way to tell was the sign-off the
model happened to put in the draft — "Data Analyst Two" against "Isolation
Probe" — which is not a property of the approval at all.

"Approve All (4)" sat above them, offering to send both agents' outbound mail in
one click without ever naming either.

The data was already there: every approval carries `deployment.agentName`. It
was simply never rendered.
"""
import io
from pathlib import Path

PAGE = (
    Path(__file__).resolve().parents[1]
    / "apps" / "web" / "app" / "(auth)" / "dashboard" / "approvals" / "page.tsx"
)
SRC = io.open(PAGE, encoding="utf-8").read()


def test_approvals_are_grouped_by_agent():
    assert "const groups = useMemo(" in SRC
    assert "group.name" in SRC, "the agent's name has to actually be drawn"


def test_groups_are_keyed_on_the_deployment_not_the_name():
    """Two agents can be given the same name, which is the case that matters.

    Grouping by name would merge them back together and reintroduce exactly the
    ambiguity this exists to remove.
    """
    body = SRC[SRC.index("const groups = useMemo("):][:900]
    assert "a.deploymentId" in body
    assert "byDeployment" in body


def test_each_group_can_be_collapsed():
    assert "toggleGroup" in SRC
    assert "aria-expanded" in SRC, "a disclosure that screen readers cannot follow is half a control"


def test_each_group_shows_how_many_are_waiting():
    body = SRC[SRC.index("groups.map("):][:2200]
    assert "pendingHere" in body
    assert 'a.status === "PENDING"' in body, "the count must be of pending ones, not of all rows"


def test_the_count_is_hidden_when_there_is_nothing_pending():
    # A badge reading 0 is noise, and trains people to ignore the badge.
    body = SRC[SRC.index("groups.map("):][:2200]
    assert "pendingHere > 0 &&" in body


def test_the_keyboard_still_walks_one_flat_list():
    """Grouping changes how approvals are drawn, not the order j/k moves through.

    Focus computed per group would jump between agents on every keypress.
    """
    assert "const pendingOrder = useMemo(" in SRC
    assert "pendingOrder[focusIndex]?.id === approval.id" in SRC


def test_resolving_still_carries_the_right_deployment():
    # Every resolve path builds its URL from this, and the approval being
    # resolved must be the one whose deployment is used - across groups.
    assert "handleResolve(id, action, approval.deploymentId, data)" in SRC
