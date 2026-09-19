"""What the platform does to every agent's reply before it is sent.

The Data Analyst learned each of these on 2026-09-19; they live in the adapter
so every agent on the platform gets them, whatever its code does.
"""
import asyncio
import json

import pytest

import adapter

D = adapter.Decimal


def _run(thread="t-review", request="", **meta):
    adapter.begin_run(thread, request)
    adapter.current_run_meta().update(meta)


# ── numbers in scientific notation ───────────────────────────────────────────

@pytest.mark.parametrize("raw, cell", [
    ("8.498004e+08", "849800412.37"),
    ("1.2e3", "1200"),
    ("3.5E-02", "0.035"),
])
def test_a_figure_in_scientific_notation_matches_its_cell(raw, cell):
    val = D(raw)
    assert adapter._figure_present(val, raw, [D(cell)])


def test_scientific_notation_still_rejects_a_different_number():
    assert not adapter._figure_present(D("8.498004e+08"), "8.498004e+08", [D("849900412")])


def test_a_long_scientific_figure_reads_as_one_number():
    assert [r for r, _ in adapter._summary_figures("Region_1 8.498004e+08 total")] == ["8.498004e+08"]


# ── the requester's own numbers are inputs, not results ─────────────────────

def _missing(monkeypatch, summary, values):
    async def fake_text(name, raw):
        return json.dumps({"sheets": {"Sheet1": [[v] for v in values]}})
    monkeypatch.setattr(adapter, "_file_text", fake_text)
    monkeypatch.setitem(adapter._SANDBOX_FILES, "f1", {"name": "t.xlsx", "bytes": b""})
    return asyncio.run(adapter.verify_deliverables(summary, ["f1"]))


@pytest.mark.parametrize("request_text, reply", [
    ("Merchants with more than 100 transactions get the lower rate.", "Northwind has over 100 transactions."),
    ("Budget was $1,250.00 for the event.", "Against the 1250.00 budget, spend was fine."),
    ("Target conversion is 4.5 percent.", "We beat the 4.5 target."),
])
def test_a_number_from_the_request_is_not_a_file_gap(monkeypatch, request_text, reply):
    _run(request=request_text)
    assert _missing(monkeypatch, reply, [999]) == []


def test_a_computed_number_absent_from_the_file_is_still_a_gap(monkeypatch):
    _run(request="Rate is 2.9% over 100 sales.")
    assert _missing(monkeypatch, "Fees total 17.19545.", [17.2]) == ["17.19545"]


# ── only the deliverables are attached ───────────────────────────────────────

FILES = [{"name": n} for n in ("_check.csv", "draft.xlsx", "final.xlsx", "chart.png")]


def test_named_deliverables_are_the_only_files_sent():
    _run(deliverables=["final.xlsx", "chart.png"])
    assert [f["name"] for f in adapter._only_deliverables(FILES)] == ["final.xlsx", "chart.png"]


def test_without_deliverables_scratch_files_stay_out():
    _run()
    assert [f["name"] for f in adapter._only_deliverables(FILES)] == ["draft.xlsx", "final.xlsx", "chart.png"]


def test_a_misnamed_deliverable_never_means_no_file():
    _run(deliverables=["finale.xlsx"])
    assert [f["name"] for f in adapter._only_deliverables(FILES)] == ["draft.xlsx", "final.xlsx", "chart.png"]


def test_the_agent_result_is_recorded_for_delivery():
    _run()
    adapter.record_agent_output({"check": ["a", " b ", "none", "c", "d"], "deliverables": ["out/final.xlsx"]})
    meta = adapter.current_run_meta()
    assert meta["checks"] == ["a", "b", "c"]
    assert meta["deliverables"] == ["final.xlsx"]


# ── the check list ───────────────────────────────────────────────────────────

def test_platform_problems_lead_and_agent_items_follow():
    _run(request="orders", checks=["I removed one duplicate row."], platform_checks=["The file lacks 5,000."])
    assert adapter.run_checks("Total 7,385.75.") == ["The file lacks 5,000.", "I removed one duplicate row."]


def test_the_list_sits_under_the_answer_and_keeps_a_lead_in_whole():
    text = adapter.with_check_section(
        "Revenue by customer (total 7,385.75):\n\nGamma 2,605.00\n\nMethod: summed.", ["x"])
    assert text.index("Gamma") < text.index("Check before you use this") < text.index("Method:")


def test_the_list_is_never_added_twice():
    once = adapter.with_check_section("Answer.\n\nMore.", ["x"])
    assert adapter.with_check_section(once, ["x"]).count("Check before you use this") == 1


def test_an_uncomputed_figure_in_a_check_item_is_labelled():
    out = adapter.label_unverified(["Keeping it would make Beta $35,401.00."], "orders", [{"stdout": "beta 2550.25"}], "Total 7,385.75")
    assert "not calculated" in out[0]


def test_a_computed_figure_in_a_check_item_is_not():
    out = adapter.label_unverified(["As a return, the total is $5,510.75."], "1005,-4", [{"stdout": "5510.75"}], "")
    assert "not calculated" not in out[0]


def test_every_send_path_gets_the_list_through_finalise():
    _run(checks=["I assumed a two-tailed test."])
    out = adapter.finalise_reply_text("Yes, the lift is real.\n\nDetails follow.", [])
    assert "Check before you use this" in out and "two-tailed" in out


def test_no_items_means_no_list():
    _run()
    assert "Check before you use this" not in adapter.finalise_reply_text("Answer.\n\nMore.", [])


# ── claimed work ─────────────────────────────────────────────────────────────

@pytest.mark.parametrize("text", [
    "The workbook is attached with the totals.",
    "I built the summary and uploaded it to SharePoint.",
    "See the attached chart for the trend.",
    "I calculated the fees per merchant.",
])
def test_a_reply_claiming_work_is_recognised(text):
    assert adapter._claims_work(text)


@pytest.mark.parametrize("text", [
    "I could not build the workbook because the file was unreadable.",
    "Nothing was attached - I need the source data first.",
    "Total revenue is 7,385.75 across 6 orders.",
    "",
])
def test_an_honest_or_plain_reply_is_not_a_claim(text):
    assert not adapter._claims_work(text)


def test_claimed_work_with_nothing_run_is_a_problem():
    _run(thread="t-claim")
    problems = asyncio.run(adapter.verified_problems("The workbook is attached with the totals."))
    assert problems and "nothing was computed" in problems[0]


def test_claimed_work_after_real_work_is_not():
    _run(thread="t-claim2")
    adapter.current_run_steps().append({"tool": "execute_python"})
    assert asyncio.run(adapter.verified_problems("The workbook is attached.")) == []


# ── the revision round ───────────────────────────────────────────────────────

def _fake_problems(monkeypatch, bad_texts):
    async def fake(text):
        return ["figure X is not in the file"] if text in bad_texts else []
    monkeypatch.setattr(adapter, "verified_problems", fake)


def test_a_revision_that_fixes_the_reply_is_sent_clean(monkeypatch):
    _run(thread="t-rev1")
    _fake_problems(monkeypatch, {"bad reply"})
    seen = []

    async def revise(feedback):
        seen.append(feedback)
        return {"action": "reply_email", "text": "good reply", "check": ["I rounded to cents."]}

    out = asyncio.run(adapter.review_reply({"action": "reply_email", "text": "bad reply"}, revise))
    assert out["text"] == "good reply"
    assert seen[0]["problems"] == ["figure X is not in the file"] and seen[0]["previous_reply"] == "bad reply"
    assert adapter.current_run_meta()["platform_checks"] == []
    assert adapter.current_run_meta()["checks"] == ["I rounded to cents."]


def test_an_agent_that_ignores_feedback_is_asked_twice_then_the_reader_is_told(monkeypatch):
    _run(thread="t-rev2")
    _fake_problems(monkeypatch, {"bad reply"})
    calls = []

    async def revise(feedback):
        calls.append(feedback["round"])
        return {"action": "reply_email", "text": "bad reply"}

    asyncio.run(adapter.review_reply({"action": "reply_email", "text": "bad reply"}, revise))
    assert calls == [1, 2]
    assert adapter.current_run_meta()["platform_checks"] == ["figure X is not in the file"]


@pytest.mark.parametrize("revised", [
    {"status": "__interrupted__"},
    {"action": "none", "text": ""},
    "not a dict",
])
def test_an_unusable_revision_keeps_the_original_reply(monkeypatch, revised):
    _run(thread="t-rev3")
    _fake_problems(monkeypatch, {"bad reply"})

    async def revise(feedback):
        return revised

    out = asyncio.run(adapter.review_reply({"action": "reply_email", "text": "bad reply"}, revise))
    assert out["text"] == "bad reply"
    assert adapter.current_run_meta()["platform_checks"] == ["figure X is not in the file"]


def test_without_a_revise_function_problems_are_shown_not_retried(monkeypatch):
    _run(thread="t-rev4")
    _fake_problems(monkeypatch, {"bad reply"})
    asyncio.run(adapter.review_reply({"action": "reply_email", "text": "bad reply"}))
    assert adapter.current_run_meta()["platform_checks"] == ["figure X is not in the file"]


def test_a_blank_reply_is_never_sent_blank():
    _run(thread="t-rev5")
    out = asyncio.run(adapter.review_reply({"action": "reply_email", "text": "  "}))
    assert "wasn't able to finish" in out["text"]
