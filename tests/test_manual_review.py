"""Vetting proves an agent RUNS; a human judges whether it is CORRECT.

The automated golden-task gate was removed - correctness is now assessed by a
reviewer who sends the agent tasks in the sandbox and reads its real answers. What
makes that possible is kept: a synchronous run endpoint that returns the composed
reply (the normal path fires async and emails it, which goes nowhere in a
sandbox), and a real model in the vet container when the operator opts in. These
pin that the engine stays and the automated gate is gone.
"""
from pathlib import Path

ADAPTER = (
    Path(__file__).resolve().parents[1]
    / "apps" / "provisioning-service" / "src" / "templates" / "runtime" / "adapter.py"
).read_text(encoding="utf-8")
VET = (
    Path(__file__).resolve().parents[1]
    / "apps" / "provisioning-service" / "src" / "jobs" / "vet-package.ts"
).read_text(encoding="utf-8")


# ── the synchronous run engine (kept, powers manual testing) ────────────────

def test_there_is_a_synchronous_run_endpoint():
    assert '@app.post("/internal/run-sync")' in ADAPTER
    assert "async def run_sync" in ADAPTER


def test_the_sync_run_does_not_wait_on_a_human():
    fn = ADAPTER[ADAPTER.index("async def run_sync"):][:2000]
    assert '"approval_policy": {"policy": "never"}' in fn


def test_the_sync_run_returns_the_reply_text():
    fn = ADAPTER[ADAPTER.index("async def run_sync"):][:3500]
    assert 'result.get("text")' in fn
    assert '"__interrupted__"' in fn


def test_the_sync_run_is_authenticated():
    fn = ADAPTER[ADAPTER.index("async def run_sync"):][:1200]
    assert "_require_internal_auth(request)" in fn


# ── the automated golden gate is gone ───────────────────────────────────────

def test_no_automated_golden_task_gate():
    # No golden.json is read, and no pass/fail correctness step is pushed. If this
    # comes back, it was re-added on purpose and this test should change with it.
    assert "golden.json" not in VET
    assert "Golden tasks" not in VET


# ── the real model stays available for manual review ────────────────────────

def test_vet_container_gets_a_real_model_when_the_operator_opts_in():
    # The reviewer's manual tests only show real answers if the sandbox has a real
    # model. Default stays vet-noop so the container holds no secret by default.
    assert 'LLM_API_KEY=${process.env.VET_LLM_API_KEY || "vet-noop"}' in VET
    assert "process.env.VET_LLM_BASE_URL" in VET
