"""Two ways the approval queue wasted a person's attention.

The first: on 2026-08-16 task D05 emitted a `drive_upload` whose
`content_base64` was the repr of a bytes object — `b'PK\\x03\\x04\\x14\\x00...`.
`_resolve_upload_content` refuses anything that is not a handle, so that upload
could never have succeeded. It was queued for approval anyway. A person was
shown 30 KB of escaped binary, approved it, and the upload failed; the workbook
was lost and the reply had to say so. The platform knew the payload was bad
before it knew whether anyone would allow it.

The second: trust is scored per task type, and the same task type was being
recorded under two names. The agent's action is `request_decision`; the portal
and server.ts speak `decision_request`. One call site mapped between them and
the resume path did not, so the Trust Scores page showed both as separate rows
with one sample each — a reputation split in half, neither half able to grow.
"""
import asyncio

import adapter
import agent


# ── the upload that could only fail ────────────────────────────────────────

def test_a_bytes_repr_is_not_accepted_as_upload_content():
    # The exact shape D05 produced.
    agent.set_file_resolver(lambda ref: None)
    try:
        raised = None
        try:
            agent._resolve_upload_content("b'PK\\x03\\x04\\x14\\x00\\x00\\x00\\x08\\x00'", "book.xlsx")
        except ValueError as e:
            raised = e
        assert raised is not None, "this is what got approved and then failed"
        assert "file id" in str(raised)
    finally:
        agent.set_file_resolver(None)


def test_a_handle_still_resolves():
    agent.set_file_resolver(lambda ref: b"PK\x03\x04real workbook bytes" if ref.startswith("sandbox:") else None)
    try:
        assert agent._resolve_upload_content("sandbox:abc123", "book.xlsx").startswith(b"PK")
    finally:
        agent.set_file_resolver(None)


def test_the_check_runs_before_the_interrupt_not_after():
    # Source-level, because the ordering *is* the fix: the same call after the
    # interrupt is what shipped, and it still raised — just one human too late.
    import io
    from pathlib import Path
    src = io.open(
        Path(__file__).resolve().parents[1] / "agents" / "data-analyst" / "agent.py",
        encoding="utf-8",
    ).read()
    guard = src.index('if action_type in ("drive_upload", "my_drive_upload"):')
    block = src.index("BLOCKED action '{action_type}' — interrupting for approval")
    assert guard < block, "the payload must be refused before anyone is asked about it"


def test_the_refusal_is_handed_back_as_a_failed_step():
    # STEP FAILED is already filtered out of buyer-facing text and already read
    # by the model as something to fix, so the refusal needs no new machinery.
    import io
    from pathlib import Path
    src = io.open(
        Path(__file__).resolve().parents[1] / "agents" / "data-analyst" / "agent.py",
        encoding="utf-8",
    ).read()
    assert "was not sent for approval, because" in src
    assert "STEP FAILED" in src


# ── one name per task type ─────────────────────────────────────────────────

def test_the_agents_action_name_is_recorded_as_the_portals():
    assert adapter._task_type_for("request_decision") == "decision_request"


def test_the_portals_name_is_left_alone():
    # Idempotent, or normalising twice would rename it again.
    assert adapter._task_type_for("decision_request") == "decision_request"


def test_every_other_action_keeps_its_own_name():
    for action in ("drive_upload", "reply_email", "excel_write", "data-analysis"):
        assert adapter._task_type_for(action) == action


def test_whitespace_does_not_make_a_second_task_type():
    assert adapter._task_type_for("  request_decision ") == "decision_request"


def test_an_empty_action_does_not_crash_the_queue():
    assert adapter._task_type_for("") == ""
    assert adapter._task_type_for(None) == ""


def test_the_mapping_is_applied_inside_the_queue_not_at_the_call_sites():
    # The bug was a call site that forgot. Normalising in the one function they
    # all go through is what makes forgetting impossible.
    import io
    from pathlib import Path
    src = io.open(Path(adapter.__file__), encoding="utf-8").read()
    assert '"taskType": _task_type_for(task_type),' in src
    assert src.count('task_type = "decision_request"') == 0, (
        "a second place that renames is a second place that can drift"
    )
