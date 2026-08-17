"""The model cannot quote a number it has never been shown.

Task D01 on 2026-08-17 computed the reconciliation correctly — 155,300 CRM,
151,450 finance, a gap of 3,850 — wrote all three into the workbook's Summary
sheet, and then told the buyer the gap was 2,050 between totals of 148,850 and
146,800.

Reading the notebook it attached settles what happened. Its own data sums to
155,300 and 151,450, and its own code sums the whole frame. But **none of
148850, 146800, 155300, 151450 or 3850 appears anywhere in that notebook** —
not in a cell, not in an output. The correct totals went from `df.sum()`
straight into `to_excel`, were never printed, and so were never in the context
of the pass that wrote the email. Three plausible figures were produced instead.

That is not arithmetic and no prompt rule reaches it. So the platform reads the
Summary sheet back off the file the sandbox just produced and puts it in the
tool result, where the rest of the run can see it.
"""
import asyncio

import adapter


WORKBOOK = {
    "sheets": {
        "Summary": [
            ["Metric", "Value"],
            ["Total CRM Revenue", 155300],
            ["Total Finance Revenue", 151450],
            ["Overall Discrepancy", 3850],
        ],
        "Discrepancies": [["deal_id", "difference"], ["D-1003", 450]],
    }
}


def _result(name="july_reconciliation.xlsx"):
    """An MCP result as it looks after _register_sandbox_files has run."""
    fid = "sandbox:readback01"
    adapter._SANDBOX_FILES[fid] = {"name": name, "bytes": b"PK\x03\x04stub"}
    return {"stdout": "", "files": [{"name": name, "file_id": fid, "note": "Pass this file_id."}]}


def _run(monkeypatch, parsed, res=None):
    async def _fake(name, raw):
        return parsed
    monkeypatch.setattr(adapter, "_parsed_file", _fake)
    return asyncio.run(adapter._read_back_summary(res if res is not None else _result()))


# ── the figures come back ──────────────────────────────────────────────────

def test_the_summary_figures_are_handed_back(monkeypatch):
    out = _run(monkeypatch, WORKBOOK)
    summary = out["files"][0]["summary"]
    assert "Total CRM Revenue: 155300" in summary
    assert "Overall Discrepancy: 3850" in summary


def test_the_note_tells_the_model_to_quote_rather_than_recall(monkeypatch):
    note = _run(monkeypatch, WORKBOOK)["files"][0]["note"]
    assert "3850" in note
    assert "Quote these" in note


def test_the_original_note_is_kept(monkeypatch):
    # It is the sentence that says how to upload the file; losing it to make
    # room for figures would trade one broken step for another.
    assert "Pass this file_id" in _run(monkeypatch, WORKBOOK)["files"][0]["note"]


def test_detail_sheets_are_not_pasted_back(monkeypatch):
    # The workings can be thousands of rows. Only the sheet that answers the
    # question comes back, or the run loses its budget to its own output.
    out = _run(monkeypatch, WORKBOOK)
    assert "D-1003" not in out["files"][0]["note"]


# ── and it stays quiet when there is nothing to say ────────────────────────

def test_a_workbook_with_no_summary_sheet_is_left_alone(monkeypatch):
    out = _run(monkeypatch, {"sheets": {"Raw Data": [["a", 1]]}})
    assert "summary" not in out["files"][0]

def test_a_file_that_is_not_a_workbook_is_not_parsed(monkeypatch):
    calls = []

    async def _fake(name, raw):
        calls.append(name)
        return WORKBOOK

    monkeypatch.setattr(adapter, "_parsed_file", _fake)
    res = _result("chart.png")
    asyncio.run(adapter._read_back_summary(res))
    assert calls == [], "a PNG has no summary sheet and parsing it costs a round trip"


def test_a_result_with_no_files_is_untouched(monkeypatch):
    out = _run(monkeypatch, WORKBOOK, res={"stdout": "hello"})
    assert out == {"stdout": "hello"}


def test_a_parser_failure_never_reaches_the_caller(monkeypatch):
    async def _boom(name, raw):
        raise RuntimeError("sandbox is down")
    monkeypatch.setattr(adapter, "_parsed_file", _boom)
    out = asyncio.run(adapter._read_back_summary(_result()))
    assert "summary" not in out["files"][0], "a failed read-back must not fail the run"


def test_an_unreadable_file_is_simply_undescribed(monkeypatch):
    out = _run(monkeypatch, None)
    assert "summary" not in out["files"][0]


# ── it has to run on every path that produces a file ───────────────────────

def test_every_registration_site_reads_the_summary_back():
    import io
    from pathlib import Path
    src = io.open(Path(adapter.__file__), encoding="utf-8").read()
    assert src.count("_read_back_summary(_register_sandbox_files(") == \
        src.count("_register_sandbox_files(") - 1, (
        "a file produced on one path would come back without its figures, and "
        "that path is where the reply gets written from memory"
    )
