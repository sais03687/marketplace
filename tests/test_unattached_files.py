"""A reply must not describe a file it is not carrying.

Task F3 on 2026-08-18 sent this, with nothing attached:

    The Excel workbook containing these calculations and the full data table
    is attached.

Two fixes went in and neither reached that sentence. Persisting the file
registry removed the cause — the container had been redeployed and the registry
was gone — and `note_the_notebook` corrected the platform's own half of the
claim. But the sentence above is the model's, written before it can know what
will be attached, and a send failure or an eviction under the size ceiling would
produce the same lie from a different direction.

So the check is an invariant over the run's own state rather than a reading of
its prose: the run made files, the message has none of them, say so. Nothing is
matched against the word "attached" — that misfires on "the data attached to
your email", misses "I've included the workbook", and a vocabulary is exactly
what could not be made to work for the headline check.
"""
import adapter
import pytest


@pytest.fixture(autouse=True)
def _clean_run(monkeypatch):
    monkeypatch.setattr(adapter, "_SANDBOX_FILES", {})
    monkeypatch.setattr(adapter, "_RUN_FILES", {"t": []})
    monkeypatch.setattr(adapter, "_current_run", adapter._current_run)
    adapter._current_run.set("t")
    yield


def _produced(*names):
    for i, n in enumerate(names):
        h = f"sandbox:p{i}"
        adapter._SANDBOX_FILES[h] = {"name": n, "bytes": b"x"}
        adapter._RUN_FILES["t"].append(h)


F3 = "Team utilisation is 82.50%. The Excel workbook containing these calculations is attached."


# ── the case it exists for ─────────────────────────────────────────────────

def test_the_f3_reply_no_longer_goes_out_unqualified():
    _produced("consultant_utilisation_report.xlsx", "working.ipynb")
    out = adapter.note_unattached_files(F3, [])
    assert "could not attach" in out
    assert "consultant_utilisation_report.xlsx" in out


def test_the_figures_are_still_delivered():
    # The analysis was right. The note qualifies the message, it does not
    # replace it.
    _produced("report.xlsx")
    out = adapter.note_unattached_files(F3, None)
    assert out.startswith("Team utilisation is 82.50%.")


def test_it_says_what_to_do_about_it():
    _produced("report.xlsx")
    assert "send it again" in adapter.note_unattached_files(F3, []).lower()


# ── and it must stay quiet the rest of the time ────────────────────────────

def test_a_message_that_is_carrying_the_files_is_left_alone():
    _produced("report.xlsx")
    out = adapter.note_unattached_files(F3, [{"name": "report.xlsx"}])
    assert out == F3


def test_a_run_that_produced_nothing_is_left_alone():
    assert adapter.note_unattached_files("Nothing to compute here.", []) == \
        "Nothing to compute here."


def test_a_partial_attachment_is_not_second_guessed():
    # run_attachments filters legitimately — inbound files are not deliverables,
    # and a rebuilt workbook replaces its earlier copy. Only the unambiguous
    # case is worth a caveat.
    _produced("a.xlsx", "b.xlsx", "working.ipynb")
    out = adapter.note_unattached_files(F3, [{"name": "a.xlsx"}])
    assert out == F3


def test_an_empty_reply_is_not_given_a_caveat_to_carry():
    _produced("report.xlsx")
    assert adapter.note_unattached_files("", []) == ""


def test_it_reads_no_words_from_the_reply():
    # A reply that never mentions a file still gets the note, because the fact
    # is about the run and not about the sentence.
    _produced("report.xlsx")
    out = adapter.note_unattached_files("The total is 733.", [])
    assert "could not attach" in out


def test_the_same_file_is_not_named_twice():
    _produced("report.xlsx", "report.xlsx")
    out = adapter.note_unattached_files(F3, [])
    assert out.count("report.xlsx") == 1


# ── every delivery path gets both checks ───────────────────────────────────

def test_both_facts_are_settled_in_one_call():
    _produced("report.xlsx", "working.ipynb")
    out = adapter.finalise_reply_text(F3, [])
    assert "could not attach" in out
    assert "working.ipynb — every step" not in out, (
        "the notebook must not be promised in the same breath as admitting "
        "nothing was attached"
    )


def test_a_full_delivery_gets_the_notebook_pointer_and_no_caveat():
    _produced("report.xlsx", "working.ipynb")
    out = adapter.finalise_reply_text(
        "The total is 733.", [{"name": "report.xlsx"}, {"name": "working.ipynb"}]
    )
    assert "could not attach" not in out
    assert "working.ipynb" in out


def test_no_delivery_path_calls_only_half_of_it():
    import io
    from pathlib import Path
    src = io.open(Path(adapter.__file__), encoding="utf-8").read()
    body = src[src.index("async def _deliver_email_result"):]
    assert "note_the_notebook(" not in body and "note_unattached_files(" not in body, (
        "a send site that calls one check and not the other is how F3 happened"
    )
