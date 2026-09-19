"""Figures the platform measures rather than trusts.

Two different questions, and conflating them is what let a wrong number through:
does the file back what the reply claims, and was the arithmetic sound at all.
The first can pass while the answer is wrong — on 2026-08-11 it did, because the
reply and the workbook agreed on 942.99 and both were wrong.
"""
import pytest
import adapter
from creator import agent


SP_URL = ("https://agentstore.sharepoint.com/_layouts/15/Doc.aspx"
          "?sourcedoc=%7BD8DE1B2B-C758-4B89-8D04-F47D420F1F45%7D&file=q3.xlsx")


# ── digits inside a URL are addressing, not arithmetic ──────────────────────

def test_a_sharepoint_guid_does_not_invent_figures():
    # The GUID above contains C758 and F420. Read as prose they became "missing
    # figures" 758 and 420, and the agent rebuilt a workbook chasing them.
    reply = f"North 146050, per unit 154.88, growth 10.31%. File: {SP_URL}"
    found = [raw for raw, _ in adapter._summary_figures(reply)]
    assert "758" not in found
    assert "420" not in found


def test_the_real_figures_still_survive():
    reply = f"North 146050, per unit 154.88, growth 10.31%. File: {SP_URL}"
    found = [raw for raw, _ in adapter._summary_figures(reply)]
    assert {"146050", "154.88", "10.31"} <= set(found)


def test_a_url_alone_asserts_nothing():
    assert adapter._summary_figures(f"Here is the file: {SP_URL}") == []


def test_urls_are_stripped_from_the_file_side_too():
    # Otherwise a link inside a document could vouch for a figure never in it.
    assert adapter._file_figures(f"see {SP_URL}") == []


# ── a figure rebuilt by inverting a rounded one ─────────────────────────────

REQUEST = """Q3 revenue by region.
North 132400 -> 146050, 943 units
South 109950 -> 128100, 838 units
West  171200 -> 184400, 1211 units"""


def test_units_recovered_from_a_rounded_per_unit_figure_are_caught():
    # 146050 / 154.88 = 942.988…, when the request plainly said 943.
    produced = ('{"stdout": "[{\\"Units Sold\\":942.9881198347},'
                '{\\"Units Sold\\":838.0217192202},{\\"Units Sold\\":1211.0067643003}]"}')
    found = agent._rebuilt_figures(produced, REQUEST)
    assert len(found) == 3
    assert {want for _, want in found} == {"943", "838", "1211"}


def test_correct_work_is_not_accused():
    clean = ("North 146050, per unit 154.88, growth 10.31%. "
             "South 128100, 152.86, 16.51%. Units: 943, 838, 1211. Ratio 0.1031.")
    assert agent._rebuilt_figures(clean, REQUEST) == []


def test_a_genuine_full_precision_intermediate_is_not_accused():
    honest = "per unit 154.8780487805 and 152.8639618138 and growth 10.3096676737"
    assert agent._rebuilt_figures(honest, REQUEST) == []


def test_a_two_decimal_figure_is_never_flagged():
    # The signature is a long tail, which is what inverting a rounded value gives.
    assert agent._rebuilt_figures("942.99 units", REQUEST) == []


@pytest.mark.parametrize("produced,request_text", [
    ("942.9881198347", ""),           # nothing given to compare against
    ("", REQUEST),                     # nothing produced
    ("942.9881198347", "please do the thing"),  # request has no figures
])
def test_degenerate_inputs_accuse_nobody(produced, request_text):
    assert agent._rebuilt_figures(produced, request_text) == []


# ── does the file back the reply ────────────────────────────────────────────

def test_rounding_in_the_summary_is_not_a_gap():
    # A summary says 152.94 where the cell holds 152.9382.
    assert adapter._figure_present(adapter.Decimal("152.9382"), "152.94",
                                   [adapter.Decimal("152.9382")]) is True


def test_a_figure_absent_from_the_file_is_a_gap():
    assert adapter._figure_present(adapter.Decimal("999888.77"), "999888.77",
                                   [adapter.Decimal("146050")]) is False


def test_a_bare_year_is_not_treated_as_a_cell_value():
    assert [raw for raw, _ in adapter._summary_figures("in 2026 we grew")] == []


def test_a_small_bare_integer_is_not_a_figure():
    # "3 regions", "top 5" — counts and ordinals, not money.
    assert [raw for raw, _ in adapter._summary_figures("across 3 regions, top 5")] == []


# ── T01, 2026-09-19: a correct reply told its reader not to trust it ────────

def _missing(monkeypatch, summary, cells):
    """What verify_deliverables flags for this reply against this workbook."""
    import asyncio
    import json

    async def fake_text(name, raw):
        return json.dumps({"sheets": {"Summary": cells}})

    monkeypatch.setattr(adapter, "_file_text", fake_text)
    monkeypatch.setitem(adapter._SANDBOX_FILES, "f1", {"name": "t.xlsx", "bytes": b""})
    return asyncio.run(adapter.verify_deliverables(summary, ["f1"]))


def test_a_rate_stated_as_a_percentage_is_backed_by_its_fraction(monkeypatch):
    cells = [["North", 0.05], ["South", 0.09], ["Overall", 0.05327659574468085]]
    assert _missing(monkeypatch, "North 5.00%, South 9.00%, overall 5.33%.", cells) == []


def test_a_python_float_repr_matches_the_cell_excel_stored(monkeypatch):
    # Seventeen significant digits in the reply, fifteen in the workbook.
    cells = [["West", 0.12987012987013]]
    assert _missing(monkeypatch, "West: 0.12987012987012986", cells) == []


def test_a_percentage_the_file_does_not_hold_is_still_a_gap(monkeypatch):
    cells = [["North", 0.05]]
    assert _missing(monkeypatch, "North converted at 7.40%.", cells) == ["7.40"]
