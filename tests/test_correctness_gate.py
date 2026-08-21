"""An agent must give the right answer, not just run.

Every other vetting step checks the agent boots and responds. None checked it was
correct - a creator could publish a plausible agent that returns wrong numbers and
it would pass. This is the gate that catches that: the creator ships golden tasks
(input -> expected answer), and vetting runs each to completion and checks the
reply.

Two pieces make it possible, and their properties are what these pin: a
synchronous run path (the normal one fires async and emails the reply, which goes
nowhere in a sandbox), and a real model in the sandbox (vet-noop cannot reason) -
gated behind an opt-in key so the default stays secret-free.
"""
import io
from pathlib import Path

ADAPTER = (
    Path(__file__).resolve().parents[1]
    / "apps" / "provisioning-service" / "src" / "templates" / "runtime" / "adapter.py"
).read_text(encoding="utf-8")
VET = (
    Path(__file__).resolve().parents[1]
    / "apps" / "provisioning-service" / "src" / "jobs" / "vet-package.ts"
).read_text(encoding="utf-8")


# ── the synchronous run path ───────────────────────────────────────────────

def test_there_is_a_synchronous_run_endpoint():
    # The normal path returns 202 and emails the reply. A correctness check needs
    # the answer back in the response.
    assert '@app.post("/internal/run-sync")' in ADAPTER
    assert "async def run_sync" in ADAPTER


def test_the_sync_run_does_not_wait_on_a_human():
    # No manager is watching a vetting run; it must not interrupt for approval.
    fn = ADAPTER[ADAPTER.index("async def run_sync"):][:2000]
    assert '"approval_policy": {"policy": "never"}' in fn


def test_the_sync_run_returns_the_reply_text():
    fn = ADAPTER[ADAPTER.index("async def run_sync"):][:3500]
    assert 'result.get("text")' in fn
    # An interrupted run still yields its draft, so the check can see the figures.
    assert '"__interrupted__"' in fn


def test_the_sync_run_is_authenticated():
    fn = ADAPTER[ADAPTER.index("async def run_sync"):][:1200]
    assert "_require_internal_auth(request)" in fn


# ── the correctness gate itself ────────────────────────────────────────────

def test_golden_tasks_are_read_from_the_package():
    assert 'join(packageDir!, "tests", "golden.json")' in VET


def test_a_failed_golden_task_fails_vetting():
    block = VET[VET.index("Golden tasks"):]
    assert "report.overallStatus" in block
    assert 'status: allGood ? "pass" : "fail"' in VET


def test_the_answer_is_checked_against_the_expected_strings():
    block = VET[VET.index("Golden tasks: does the agent"):][:3000]
    assert "run-sync" in block
    assert "reply.toLowerCase().includes(String(e).toLowerCase())" in block


def test_missing_model_skips_rather_than_fails():
    # A missing vetting model is an operator choice, not a bad package. Failing on
    # it would block every publish the moment the key was unset.
    block = VET[VET.index("Golden tasks: does the agent"):][:3000]
    assert "!process.env.VET_LLM_API_KEY" in block
    assert 'status: "skip"' in block


def test_malformed_golden_json_fails_loudly():
    block = VET[VET.index("Golden tasks: does the agent"):][:3000]
    assert "is not valid JSON" in block


def test_the_llm_key_is_opt_in_and_off_by_default():
    # The default must stay vet-noop so the container holds no secret and its logs
    # remain safe to show the creator (see test_vetting_report_visible).
    assert 'process.env.VET_LLM_API_KEY || "vet-noop"' in VET
