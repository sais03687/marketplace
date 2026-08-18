"""A slow call should cost a retry, not the task.

Until 2026-08-18 a timeout set `completed` and sent the run straight to
finalize, so one slow reasoning call ended a task with eleven of twelve steps
still in hand. The churn task that exposed it timed out on an early call,
produced no workbook, and queued an empty reply for approval.

Raising the ceiling alone was the wrong fix, and the measurement is why.
Identical requests to the same model returned in 4.1s, 8.5s, 12.7s, 17.6s and
38.3s, and twice ran past 120s — a long tail rather than a slow model. Against
that spread the next attempt is usually fast, so retrying is nearly always
right. What needs bounding is not the single call but the whole run: twelve
generous calls in a row is two hours, and nobody sends an email expecting that.

So there are three limits, and they answer three different questions.
`LLM_TIMEOUT_S` — how long one call may take. `LLM_MAX_TIMEOUTS` — how many slow
calls a run absorbs before giving up on the step. `LLM_RUN_DEADLINE_S` — how
long the person waiting can be left, whatever the other two say.
"""
import io
from pathlib import Path

from creator import agent

SRC = io.open(
    Path(__file__).resolve().parents[1] / "agents" / "data-analyst" / "agent.py",
    encoding="utf-8",
).read()


# ── the three limits ───────────────────────────────────────────────────────

def test_all_three_limits_are_configurable():
    for var in ("LLM_TIMEOUT_S", "LLM_MAX_TIMEOUTS", "LLM_RUN_DEADLINE_S"):
        assert f'os.environ.get("{var}"' in SRC, f"{var} is not settable"


def test_the_run_deadline_is_shorter_than_the_worst_case_it_replaces():
    # The point of a run deadline: a per-call ceiling times twelve steps is the
    # real wait, and it must not be hours.
    assert agent._RUN_DEADLINE_S < agent._LLM_TIMEOUT_S * 12


def test_a_single_call_may_outlast_the_measured_tail():
    # The tail reached past 120s on a model whose median is under 20s.
    assert agent._LLM_TIMEOUT_S >= 180


def test_a_run_absorbs_more_than_one_slow_call():
    assert agent._MAX_TIMEOUTS >= 2


# ── retry rather than abandon ──────────────────────────────────────────────

def test_a_timeout_within_budget_does_not_complete_the_run():
    handler = SRC[SRC.index("except asyncio.TimeoutError:"):][:2600]
    retry = handler[:handler.index("state.analysis = {}")]
    assert '"completed": True' not in retry, (
        "a slow call ended a task that had eleven steps left"
    )


def test_the_retry_is_routed_explicitly_rather_than_by_falling_through():
    # The router only re-reasons on an empty analysis once `actions_taken` is
    # non-empty. The churn run timed out before anything had run, so falling
    # through ended it — which is the bug this exists to keep fixed.
    router = SRC[SRC.index("def route_after_reasoning"):][:1800]
    assert '_retry_after_timeout' in router
    assert router.index("_retry_after_timeout") < router.index('get("completed"'), (
        "the retry has to be decided before every other question the router asks"
    )


def test_the_flag_is_cleared_once_a_call_returns():
    assert 'state.context.pop("_retry_after_timeout", None)' in SRC, (
        "a flag that outlives its timeout re-reasons forever"
    )


def test_giving_up_still_composes_from_what_the_run_holds():
    handler = SRC[SRC.index("except asyncio.TimeoutError:"):][:2600]
    give_up = handler[handler.index("state.analysis = {}"):]
    assert '"text": ""' in give_up, (
        "finalize decides what to say from what the run has; a placeholder "
        "pre-empts that"
    )


def test_both_exits_are_distinguishable_in_the_log():
    # "retrying" and "no retries left" are different events and a log that says
    # the same thing for both cannot be used to tell whether the budget is right.
    assert "retrying the same step" in SRC
    assert "has no retries left" in SRC
    assert "past its deadline" in SRC


# ── the clock belongs to the run ───────────────────────────────────────────

def test_the_run_carries_its_own_start_time():
    assert "started_at: float = Field(default_factory=time.monotonic)" in SRC, (
        "wall-clock would jump if the host clock moved; monotonic will not"
    )


def test_timeouts_are_counted_per_run_not_globally():
    assert "timeouts: int = 0" in SRC
