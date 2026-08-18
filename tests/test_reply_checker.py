"""The harness's own judgement, tested.

`benchmark/check_reply.mjs` decides whether a delivered reply is self-consistent
— whether it claims an attachment it did not send, produced a file it never
pointed at, leaked an internal diagnostic. Until now that judgement was a human
reading the output, which is exactly how the missing attachment on the restart
run survived its first review: every figure was right, and "attachments: NONE"
sat one line above them.

A checker nobody checks is a checker that quietly stops working, so its rules
are pinned here against the reply shapes that have actually been delivered.
"""
import json
import shutil
import subprocess
from pathlib import Path

import pytest

CHECKER = Path(__file__).resolve().parents[1] / "benchmark" / "check_reply.mjs"

pytestmark = pytest.mark.skipif(
    shutil.which("node") is None, reason="node is not installed here"
)


def run(tmp_path, body, attachments, after=3, before=2):
    p = tmp_path / "reply.json"
    p.write_text(json.dumps({"body": body, "attachments": attachments}), encoding="utf-8")
    r = subprocess.run(
        ["node", str(CHECKER), str(p), str(after), str(before)],
        capture_output=True, text=True,
    )
    return r.returncode, r.stdout


# ── the failures it exists to catch ────────────────────────────────────────

def test_claiming_an_attachment_and_sending_none(tmp_path):
    rc, out = run(tmp_path, "Please find the workbook attached.", [])
    assert rc == 1
    assert "says a file is attached" in out


def test_producing_a_file_and_pointing_at_nothing(tmp_path):
    # The thread-key bug from outside: every figure right, the workbook nowhere.
    rc, out = run(tmp_path, "Team utilisation was 82.5%.", [])
    assert rc == 1
    assert "neither attaches nor links" in out


def test_an_internal_diagnostic_reaching_the_buyer(tmp_path):
    rc, out = run(tmp_path, "HEADLINE CHECK - the figure disagrees. 82.5%.", ["r.xlsx"])
    assert rc == 1
    assert "HEADLINE CHECK" in out


def test_a_raw_handle_reaching_the_buyer(tmp_path):
    rc, out = run(tmp_path, "Saved as sandbox:9bbf269d67a7 for you.", ["r.xlsx"])
    assert rc == 1
    assert "sandbox:" in out


def test_a_status_note_delivered_as_the_answer(tmp_path):
    rc, _ = run(tmp_path, "Not finished yet - this is a status note.", [], after=2)
    assert rc == 1


# ── and the deliveries it must not flag ────────────────────────────────────
#
# A checker that fails everything is as useless as one that passes everything,
# and the second half is the half that rots silently.

def test_a_link_counts_as_pointing_at_the_file(tmp_path):
    # F3 delivered a SharePoint link rather than an attachment, correctly.
    rc, out = run(tmp_path, "Utilisation was 82.5%. Available here: "
                            "https://x.sharepoint.com/a.xlsx", [])
    assert rc == 0, out


def test_a_real_attachment_passes(tmp_path):
    rc, out = run(tmp_path, "Attached is the report.", ["report.xlsx"])
    assert rc == 0, out


def test_a_run_that_produced_nothing_need_not_attach_anything(tmp_path):
    # "no rows matched" is a legitimate answer, not a missing deliverable.
    rc, out = run(tmp_path, "No rows matched Q3, so there is nothing to report.",
                  [], after=2, before=2)
    assert rc == 0, out


def test_the_word_attached_inside_a_larger_word_is_not_a_claim(tmp_path):
    # "unattached" and "detached" are not attachment claims. The rule is
    # word-bounded for this reason; without it the caveat the platform appends
    # about unattached files would flag itself.
    rc, out = run(tmp_path, "Two files were left unattached upstream. "
                            "See https://x.sharepoint.com/a.xlsx", [])
    assert rc == 0, out


# ── the interruption notice, and the seam it sits on ───────────────────────

def test_an_interruption_notice_is_incomplete_not_broken(tmp_path):
    """The run did not finish, and said so. That is not a delivery failure.

    Without this the harness reported FAIL on the very outcome the interrupted-
    run fix exists to produce: a file had been built, the reply pointed at
    nothing, and the checker could not tell an honest "I could not finish" from
    a workbook silently lost.
    """
    rc, out = run(
        tmp_path,
        'I was working on "Q3 utilisation" when I was restarted, and I could '
        "not finish it. I have not sent you a result, so nothing you have "
        "received from me covers this.",
        [],
        after=6, before=5,
    )
    assert rc == 2, out
    assert "INCOMPLETE" in out


def test_the_checker_and_the_adapter_have_not_drifted():
    """The sentence the checker keys on must be one the platform really sends.

    It is a constant we author, not a guess at model wording — but a constant in
    two languages, in two files, is a pair that drifts. Reword the notice in
    adapter.py and this fails, rather than the harness quietly reclassifying
    every interrupted run as a broken delivery.
    """
    import io
    from pathlib import Path
    checker = io.open(CHECKER, encoding="utf-8").read()
    phrase = checker.split('const NO_RESULT = "')[1].split('"')[0]

    adapter_src = io.open(
        Path(__file__).resolve().parents[1]
        / "apps" / "provisioning-service" / "src" / "templates" / "runtime" / "adapter.py",
        encoding="utf-8",
    ).read()
    assert phrase in adapter_src, (
        f"the checker looks for {phrase!r}, which the adapter no longer says"
    )


def test_a_lost_workbook_is_still_a_failure(tmp_path):
    # The half that must keep firing: silence about a produced file, with no
    # admission of not finishing, is the original bug.
    rc, out = run(tmp_path, "Team utilisation was 82.5%.", [], after=6, before=5)
    assert rc == 1, out
