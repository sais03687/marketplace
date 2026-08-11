"""What the buyer receives when the model does not write the reply itself.

Every case here was sent to a real buyer on 2026-08-11 before it was fixed.
"""
import json

import pytest
from creator import agent


SP_URL = (
    "https://agentstore.sharepoint.com/_layouts/15/Doc.aspx"
    "?sourcedoc=%7BD8DE1B2B-C758-4B89-8D04-F47D420F1F45%7D&file=q3.xlsx"
)

# The exact string the sandbox returns, captured from the container.
ENVELOPE = json.dumps({
    "stdout": '[{"Region":"North","Total Revenue (Q3)":146050,"Revenue per unit (Q3)":154.8780487805,"QoQ Growth (%)":10.3096676737},'
              '{"Region":"South","Total Revenue (Q3)":128100,"Revenue per unit (Q3)":152.8639618138,"QoQ Growth (%)":16.5075034106},'
              '{"Region":"West","Total Revenue (Q3)":184400,"Revenue per unit (Q3)":152.2708505367,"QoQ Growth (%)":7.7102803738}]\n',
    "stderr": "",
    "returncode": 0,
    "files": [{"name": "Q3.xlsx", "file_id": "sandbox:270a9673d7b4", "size_bytes": 5478,
               "note": "Pass this file_id as content_base64 to upload it."}],
})
UPLOAD = f"Uploaded Q3_Regional_Revenue_Analysis.xlsx to SharePoint: {SP_URL}"
HANDBACK = "DELIVERABLE CHECK — these figures appear in your reply but not in the file: 758, 420."

INTERNALS = ("file_id", "sandbox:", "size_bytes", "returncode", "stderr", "Pass this file_id")


class _State:
    def __init__(self, results):
        self.action_results = results


def render(results):
    return agent._buyer_readable(results)


# ── the envelope dump, which went to a buyer twice in one message ────────────

def test_records_become_a_table_not_an_envelope():
    out = render([ENVELOPE])
    assert "| Region |" in out
    assert "| North | 146,050 | 154.88 | 10.31 |" in out


@pytest.mark.parametrize("marker", INTERNALS)
def test_no_machinery_reaches_the_buyer(marker):
    assert marker not in render([ENVELOPE, UPLOAD, HANDBACK])


def test_escaped_json_never_appears():
    assert '\\"' not in render([ENVELOPE])


def test_figures_are_rounded_to_two_decimals():
    out = render([ENVELOPE])
    for want in ("154.88", "152.86", "152.27", "10.31", "16.51", "7.71"):
        assert want in out
    for raw in ("154.8780487805", "10.3096676737", "152.2708505367"):
        assert raw not in out


def test_column_names_are_left_exactly_as_printed():
    # An earlier draft title-cased these and turned the second into "Qoq".
    out = render([ENVELOPE])
    assert "QoQ Growth (%)" in out
    assert "Qoq" not in out


def test_the_same_analysis_twice_is_rendered_once():
    # A hand-back makes the agent re-run; the buyer wants the table once.
    assert render([ENVELOPE, UPLOAD, HANDBACK, ENVELOPE]).count("| North |") == 1


def test_internal_handback_is_not_shown():
    assert "DELIVERABLE CHECK" not in render([ENVELOPE, HANDBACK])


# ── results that are JSON but not records ───────────────────────────────────

def test_sheet_grid_becomes_a_table_without_the_blank_padding():
    # excel_read returns A1:Z100 of a four-row sheet: 96 empty rows, 22 empty
    # columns. All of it was sent to a buyer.
    pad = [""] * 22
    grid = json.dumps(
        [["Region", "Total_Revenue", "Revenue_Per_Unit"] + pad,
         ["North", "146050", "154.88"] + pad,
         ["South", "128100", "152.86"] + pad]
        + [[""] * 25 for _ in range(46)]
    )
    out = render([grid])
    assert "| Region | Total_Revenue | Revenue_Per_Unit |" in out
    assert '"", ""' not in out
    assert out.count("\n") < 12


def test_a_bare_list_of_sheet_names_is_dropped():
    assert render([json.dumps(["Q3 Revenue Analysis"])] ) == ""


def test_a_file_listing_is_navigation_not_a_finding():
    listing = json.dumps([{"name": "q3.xlsx", "id": "01HBC6OGY", "webUrl": "https://x/y"}])
    assert render([listing]) == ""


def test_numbers_stored_as_text_are_still_formatted():
    # Everything read back out of a sheet arrives as strings.
    grid = json.dumps([["Region", "Units"], ["North", "942.9881198347"], ["South", "838.0217192202"]])
    out = render([grid])
    assert "942.99" in out and "942.9881198347" not in out


def test_ratios_below_one_keep_their_precision():
    # 0.1031 is a rate; rounding it to 0.10 discards the thing it measures.
    grid = json.dumps([["Region", "Growth"], ["North", "0.1031"]])
    assert "0.1031" in render([grid])


# ── results that are the run talking to itself ──────────────────────────────

def test_a_graph_error_is_never_quoted_to_the_buyer():
    err = ("Error: Client error '400 Bad Request' for url "
           "'https://graph.microsoft.com/v1.0/users/agent/messages/AAQkADI1N2Y5?%24select=id'")
    out = render([err])
    assert "400 Bad Request" not in out
    assert "graph.microsoft.com" not in out
    assert "AAQkADI1N2Y5" not in out


def test_approval_bookkeeping_is_not_an_answer():
    out = render(["Manager decision: APPROVED — Approved — proceed as planned."])
    assert "Manager decision" not in out
    assert "proceed as planned" not in out


def test_the_sandbox_scratch_directory_is_not_where_the_file_is():
    envelope = json.dumps({"stdout": "Excel file created at /tmp/output/q3.xlsx\n",
                           "stderr": "", "returncode": 0, "files": []})
    assert "/tmp/output" not in render([envelope])


# ── truncation ──────────────────────────────────────────────────────────────

def test_a_truncated_envelope_still_yields_its_complete_rows():
    # Results are cut at 2000 characters, which is exactly when a table is big
    # enough to matter.
    out = render([ENVELOPE[:180]])
    assert "| North |" in out
    assert not any(m in out for m in INTERNALS)


def test_a_truncated_table_says_so():
    out = render([ENVELOPE[:180]])
    assert "missing its last rows" in out or "omitted" in out


# ── the delivered file, named once ──────────────────────────────────────────

def test_the_file_is_pointed_at_once_not_twice():
    composed = agent._compose_reply(_State([ENVELOPE, UPLOAD]))
    assert composed.count(SP_URL) == 1


def test_the_link_names_the_file():
    line = agent._delivered_file_line([UPLOAD])
    assert SP_URL in line
    assert "Q3_Regional_Revenue_Analysis.xlsx" in line


def test_a_run_that_produced_nothing_quotable_still_points_at_the_file():
    envelope = json.dumps({"stdout": "Excel file created at /tmp/output/q3.xlsx\n",
                           "stderr": "", "returncode": 0, "files": []})
    composed = agent._compose_reply(_State([envelope, UPLOAD]))
    assert SP_URL in composed
    assert not any(m in composed for m in INTERNALS)


# ── placeholders the model writes itself ────────────────────────────────────

def test_an_unfilled_signature_slot_never_ships():
    import adapter
    out = adapter.scrub_placeholders("Best regards,\n[Your Name]\nData Analyst Two")
    assert "[Your Name]" not in out
    assert "[]" not in out
    assert out.count("Data Analyst Two") == 1  # not doubled by the substitution


@pytest.mark.parametrize("slot", [
    "[Name]", "[Your Title]", "[Your Position]", "[Company Name]",
    "[Your Company]", "[Date]", "[Recipient]", "[Insert summary here]",
    "[YOUR NAME]", "[ your name ]",
])
def test_stock_template_slots_are_filled_or_removed(slot):
    import adapter
    assert slot not in adapter.scrub_placeholders(f"Regards,\n{slot}\nend")


@pytest.mark.parametrize("text", [
    "See [1] for detail.",
    "Read the [Q3 report](https://x.com/a.pdf) first.",
    "The value was [redacted] on request.",
    "Rows [4:9] were excluded.",
    "Use the [Approve] button in the email.",
])
def test_ordinary_brackets_survive(text):
    import adapter
    assert adapter.scrub_placeholders(text) == text
