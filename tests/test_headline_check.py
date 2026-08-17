"""The reply led with the wrong number, and every check passed.

Task D01 on 2026-08-16 reconciled a CRM export against a finance register and
got it right. The workbook it attached held a sheet named `Summary`:

    Total CRM Revenue      155300
    Total Finance Revenue  151450
    Overall Discrepancy      3850

and a `Discrepancies` sheet listing all four exceptions, including the £18,400
deal that closed and was never invoiced. The email led with "The primary
difference of $450" and never mentioned that deal at all.

`verify_deliverables` asks whether a figure appears anywhere in the delivered
files. 450 does — it is the D-1003 row, correctly computed. So containment
passed on a reply whose headline contradicted the workbook's own summary, and
the buyer who read the message got a materially false answer while the true one
sat in the attachment.

This check asks the narrower question the other one structurally cannot: the
file volunteered a sheet saying what the top-line numbers are, and the reply's
top-line number is not among them.
"""
import asyncio
import json

import adapter


# The real Summary sheet, as parse_xlsx returns it.
D01_PARSED = {
    "sheets": {
        "Summary": [
            ["Metric", "Value"],
            ["Total CRM Revenue", 155300],
            ["Total Finance Revenue", 151450],
            ["Overall Discrepancy", 3850],
        ],
        "Discrepancies": [
            ["deal_id", "crm_amount", "finance_amount", "difference"],
            ["D-1003", 12500.0, 12050.0, 450],
            ["D-1005", 9800.0, 19600.0, -9800],
            ["D-1007", 18400.0, None, 18400],
            ["D-1099", None, 5200.0, -5200],
        ],
    }
}

D01_REPLY = (
    "Hi Sai, I've reconciled the CRM and finance revenue numbers for July. The "
    "primary difference of $450 is due to a discrepancy in the amount recorded "
    "for Fabrikam Inc. (Deal ID D-1003) and an additional duplicate invoice for "
    "Litware Inc. (Deal ID D-1005) in the finance data."
)


def _values(parsed):
    return adapter._summary_sheet_values(parsed)


# ── the failure it was built for ───────────────────────────────────────────

def test_the_headline_d01_led_with_is_caught():
    conflicts = adapter._headline_conflicts(D01_REPLY, _values(D01_PARSED))
    assert conflicts, "450 was called the primary difference; the summary says 3850"
    assert conflicts[0]["claimed"] == "450"
    assert conflicts[0]["word"] == "primary"


def test_the_hand_back_names_what_the_summary_holds():
    # "Your headline is wrong" invites disagreement. "You called 450 the primary
    # and the sheet holds 3850" can be acted on in one step.
    conflicts = adapter._headline_conflicts(D01_REPLY, _values(D01_PARSED))
    assert "3850" in " ".join(conflicts[0]["summary_holds"])


def test_a_figure_in_a_detail_sheet_is_not_a_defence():
    # The whole point: 450 IS in the workbook, on the Discrepancies sheet, and
    # correctly computed. Containment passes and the reply is still wrong.
    whole_file = adapter._file_figures(json.dumps(D01_PARSED, default=str))
    assert any(v == 450 for v in whole_file), "450 is genuinely in the file"
    assert adapter._headline_conflicts(D01_REPLY, _values(D01_PARSED))


def test_leading_from_the_summary_passes():
    good = (
        "Hi Sai, CRM shows 155300 for July and finance shows 151450, an overall "
        "gap of 3850 across four exceptions. The largest is D-1007 (Tailspin "
        "Toys, 18400) which closed in July and was never invoiced."
    )
    assert adapter._headline_conflicts(good, _values(D01_PARSED)) == []


# ── it must not fire on the replies that were fine ─────────────────────────

def test_a_per_customer_breakdown_is_not_a_headline_claim():
    # D02 listed four customers and never called any of them a total. Flagging
    # those would cost a round trip on every itemised reply there is.
    d02 = (
        "Here's a summary of July revenue by customer: Acme Corp: $6,525.00 "
        "Globex Industries: $4,480.00 Initech LLC: $3,982.50 Umbrella Co: $2,730.00"
    )
    summary = {"sheets": {"Summary": [["Total July Revenue", 17717.5]]}}
    assert adapter._headline_conflicts(d02, _values(summary)) == []


def test_totaling_one_customer_is_not_a_top_line_word():
    # D04: "totaling $41,200" is about Fabrikam, not about the report. The word
    # boundary is doing this work and the test pins it, because loosening the
    # pattern to `total\w*` would break a correct reply.
    d04 = (
        "Fabrikam Inc is the customer we should be chasing hardest. They have "
        "the highest amount of overdue invoices, totaling $41,200, with $18,900 "
        "of that being over 90 days past due."
    )
    summary = {"sheets": {"Summary": [["Total Outstanding", 130450]]}}
    assert adapter._headline_conflicts(d04, _values(summary)) == []


def test_a_reply_with_no_headline_word_is_left_alone():
    # D03 stated no figure at all. A refusal is not a claim about a total.
    assert adapter._headline_conflicts(
        "I don't have the Q2 2026 data readily available.", _values(D01_PARSED)
    ) == []


# ── the sheet has to have volunteered itself ───────────────────────────────

def test_a_workbook_with_no_summary_sheet_yields_nothing_to_check():
    # An agent that wrote no summary is not accused of contradicting one.
    only_detail = {"sheets": {"Discrepancies": [["deal_id", "difference"], ["D-1003", 450]]}}
    assert _values(only_detail) == []


def test_the_sheet_is_found_under_the_names_people_actually_use():
    # "AR Aging Summary" is D04's real sheet name. Requiring the bare word would
    # have meant this check quietly never ran on the workbooks that have one.
    for name in ("Summary", "summary", "Key Figures", "Overview", "Totals",
                 "AR Aging Summary", "Q3 Overview"):
        parsed = {"sheets": {name: [["Total", 3850]]}}
        assert _values(parsed), f"{name} should count as a summary sheet"


def test_a_detail_sheet_is_not_mistaken_for_one():
    # Trailing words make it a section of the analysis rather than the place the
    # top line lives, and widening to any sheet containing "summary" would pool
    # so many figures that the headline could never contradict them.
    for name in ("Raw Data", "Discrepancies", "Open Invoices Detail",
                 "Summary of Findings by Region"):
        parsed = {"sheets": {name: [["Total", 3850]]}}
        assert _values(parsed) == [], f"{name} is not the summary sheet"


def test_a_file_with_no_sheets_at_all_is_silent():
    assert _values({"__text__": "some,csv\n1,2\n"}) == []


# ── and it reaches the agent ───────────────────────────────────────────────

def test_nothing_delivered_means_nothing_raised():
    assert asyncio.run(adapter.check_headline_against_summary(D01_REPLY, [])) == []


def test_a_reply_without_a_headline_word_short_circuits():
    # Cheap exit before any file is parsed: no top-line word, nothing to weigh.
    assert asyncio.run(
        adapter.check_headline_against_summary("No figures here.", ["sandbox:x"])
    ) == []


def test_the_verifier_is_injected_at_every_call_site():
    import io
    from pathlib import Path
    src = io.open(Path(adapter.__file__), encoding="utf-8").read()
    assert src.count("headline_fn=check_headline_against_summary") == \
        src.count("ranking_fn=check_rankings_against_file"), (
        "a run that can have its rankings checked must have its headline checked"
    )


def test_the_hand_back_never_reaches_a_buyer():
    import io
    from pathlib import Path
    agent_src = io.open(
        Path(__file__).resolve().parents[1] / "agents" / "data-analyst" / "agent.py",
        encoding="utf-8",
    ).read()
    # It is addressed to the model in the second person; one reaching a buyer
    # reads as the agent talking to itself in front of them.
    assert '"HEADLINE CHECK",' in agent_src, "not filtered out of the rendered reply"
