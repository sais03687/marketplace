"""An action that cannot be undone must score riskier than one that can.

`reversibility` was undefined in the prompt — just `<1-10>` — and averaged in
raw alongside stakes and ambiguity, where higher means worse. The model read it
the way the word reads: how easily the thing is undone. Across 54 live samples
it gave `drive_upload` — a write you delete in one click — an 8 or a 9 in 45 of
them.

So the arithmetic ran backwards. A trivially reversible upload was pushed
*towards* the approval threshold by being safe (stakes 3, ambiguity 2,
reversibility 9 -> combined 4.7, against a default threshold of 5), and a
permanent action scoring 1-2 was pulled *away* from it. The gate exists for
irreversible actions, so the error ran against exactly the case it was built
for — and on `risk-based`, the policy the buyer docs recommend graduating to,
that means the consequential write is the one waved through.

The scale is now stated in the prompt and the contribution is `10 -
reversibility` everywhere it is computed. `_risk_combined` also recomputes from
the components instead of trusting the model's own `combined` field, for the
same reason `_read_back_summary` exists: arithmetic the model does unprompted is
the least trustworthy thing in the response.
"""
import io
from pathlib import Path

import pytest

from creator import agent

REPO = Path(__file__).resolve().parents[1]
AGENT_SRC = io.open(REPO / "agents" / "data-analyst" / "agent.py", encoding="utf-8").read()


def test_permanent_action_scores_riskier_than_undoable_one():
    same = {"stakes": 5, "ambiguity": 5}
    undoable = agent._risk_combined({**same, "reversibility": 10})
    permanent = agent._risk_combined({**same, "reversibility": 1})
    assert permanent > undoable, (
        "an action that cannot be undone must not score safer than one that can"
    )


def test_the_live_upload_no_longer_sits_at_the_threshold():
    """stakes 3 / ambiguity 2 / reversibility 9 — a real assessment from 2026-09-16."""
    combined = agent._risk_combined({"stakes": 3, "ambiguity": 2, "reversibility": 9})
    assert combined == pytest.approx(2.0), combined
    assert combined < 5, "a safe, easily undone upload must not reach the default gate"


def test_reversibility_is_not_summed_raw():
    assert agent._risk_combined({"stakes": 0, "ambiguity": 0, "reversibility": 10}) == 0.0
    assert agent._risk_combined({"stakes": 0, "ambiguity": 0, "reversibility": 0}) == pytest.approx(10 / 3)


def test_missing_scores_do_not_read_as_low_risk():
    """An unreadable assessment must not become a zero — callers fail toward the human."""
    assert agent._risk_combined(None) is None
    assert agent._risk_combined({"stakes": 5}) is None
    assert agent._risk_combined({"stakes": "x", "ambiguity": "y", "reversibility": "z"}) is None


def test_gate_uses_the_recomputed_value_not_the_models_own():
    assert '"_risk_combined": _risk_combined(_risk)' in AGENT_SRC, (
        "the gate must recompute from the components; the model's `combined` is "
        "unverified arithmetic"
    )


def test_the_prompt_states_which_way_the_scale_runs():
    assert "how EASILY UNDONE this is" in AGENT_SRC
    assert "Higher\n                      is SAFER" in AGENT_SRC or "is SAFER" in AGENT_SRC
