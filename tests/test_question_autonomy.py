"""A question must always reach a human, however well the agent has behaved.

Autonomy is scored per task type from approval history, which is right for
actions: an agent that has uploaded a hundred workbooks correctly should stop
asking before each one. It is meaningless for a question. `request_decision`
exists precisely because the agent cannot proceed without a person, so
"approving" one resolves it with no answer and the graph resumes knowing exactly
as much as when it stopped to ask. Promoted to auto_execute, the agent asks into
the void and carries on — worse than never asking, because it looks like it
consulted someone.

On 2026-08-17 `decision_request` stood at 50% and `always_queue`, so nothing had
gone wrong yet. Two more approvals would have put it at 0.8 and
queue_if_stakes_gt_7, at which point a low-stakes question stops being shown.

The threshold ladder was written out three times — the resolve path, the nightly
cron, and the manual override — so a floor added to one of them would have been
a floor in name only. These tests are about there being one ladder.

Source-level on purpose: apps/web has no JS test runner, and the property worth
protecting is structural rather than behavioural.
"""
import io
import re
from pathlib import Path

import pytest

WEB = Path(__file__).resolve().parents[1] / "apps" / "web"
AUTONOMY = WEB / "lib" / "autonomy.ts"

CONSUMERS = [
    WEB / "lib" / "resolve-approval.ts",
    WEB / "app" / "api" / "cron" / "update-trust-scores" / "route.ts",
    WEB / "app" / "api" / "deployments" / "[id]" / "trust-scores" / "route.ts",
]


def _read(p: Path) -> str:
    return io.open(p, encoding="utf-8").read()


def test_the_shared_module_exists():
    assert AUTONOMY.exists(), "the one place the ladder and the floor live"


def test_a_question_can_never_be_promoted():
    src = _read(AUTONOMY)
    assert "isQuestionTaskType" in src
    assert 'return "always_queue"' in src


def test_both_spellings_of_the_task_type_are_floored():
    # The agent's action is request_decision and the portal's is
    # decision_request. Flooring one spelling leaves the other promotable, and
    # both existed as separate trust rows until 2026-08-17.
    src = _read(AUTONOMY)
    assert "decision_request" in src and "request_decision" in src


def test_a_hand_set_level_is_clamped_too():
    # The buyer's choice is honoured everywhere except here, where every level
    # above always_queue means the same thing.
    assert "clampManualAutonomy" in _read(AUTONOMY)


@pytest.mark.parametrize("path", CONSUMERS, ids=lambda p: p.name)
def test_every_consumer_goes_through_the_shared_module(path):
    src = _read(path)
    assert "@/lib/autonomy" in src, f"{path.name} computes autonomy on its own"


@pytest.mark.parametrize("path", CONSUMERS, ids=lambda p: p.name)
def test_no_consumer_still_has_its_own_ladder(path):
    # The literal thresholds are the tell. One of these left behind is a path
    # that keeps promoting questions no matter what the shared module says.
    src = _read(path)
    ladder = re.search(r"0\.95[^\n]*total\s*>=\s*20", src)
    assert ladder is None, (
        f"{path.name} still computes the thresholds inline — the floor added to "
        "lib/autonomy does not apply on this path"
    )


def test_the_thresholds_are_written_once():
    # Counting across the whole app rather than the known consumers, so a fourth
    # copy added later fails here instead of silently disagreeing.
    copies = [
        p for p in WEB.rglob("*.ts")
        if "node_modules" not in str(p) and ".next" not in str(p)
        and re.search(r"0\.95[^\n]*total\s*>=\s*20", _read(p))
    ]
    assert [p.name for p in copies] == ["autonomy.ts"], (
        f"the ladder exists in more than one place: {[p.name for p in copies]}"
    )
