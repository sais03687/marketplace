"""A hyphen inside an identifier is not a minus sign.

`_NUMBER_RE` was `-?\\d[\\d,]*(?:\\.\\d+)?`, which treated any hyphen before a
digit as a sign. So every identifier came out negative — SKU-1003 as -1003, deal
D-1007 as -1007, invoice INV-4501 as -4501 — and the range "1200-1500" read as
1200 and -1500.

Task E4 on 2026-08-17 is what it cost. The summary cited SKU-1003, the workbook
held that id as a plain 1003, and `verify_deliverables` reported a figure absent
that the file was carrying all along. The agent receives those as a real gap: on
2026-08-10 two fragments of a SharePoint download GUID were handed over the same
way, and it rebuilt and re-uploaded the workbook trying to fit them into a
revenue table.

The point of the check is to catch a figure the agent asserted and the file does
not support. An identifier that does not appear is exactly that — a cited SKU
that is not in the data is worth flagging — so the fix keeps identifiers
readable and only stops inverting their sign.
"""
import adapter

# A workbook whose id column came through as integers, which is what pandas
# gives you when the source CSV held bare numbers.
NUMERIC_IDS = "sku\tweeks_of_cover\n1001\t2.10\n1003\t0.40\n"
# The same workbook with the ids as text.
TEXT_IDS = "sku\tweeks_of_cover\nSKU-1001\t2.10\nSKU-1003\t0.40\n"


def missing(summary, blob):
    figures = adapter._summary_figures(summary)
    haystack = adapter._file_figures(blob)
    return [raw for raw, val in figures if not adapter._figure_present(val, raw, haystack)]


# ── the identifier ─────────────────────────────────────────────────────────

def test_an_identifier_is_read_as_a_positive_number():
    assert adapter._summary_figures("SKU-1003 is urgent.") == [("1003", adapter.Decimal("1003"))]


def test_e4_no_longer_reports_a_figure_the_file_holds():
    assert missing("SKU-1003 is the most urgent, at 0.4 weeks of cover.", NUMERIC_IDS) == []


def test_it_agrees_however_the_file_spells_the_id():
    # The check must not depend on whether the workbook wrote 1003 or SKU-1003.
    summary = "SKU-1003 is the most urgent, at 0.4 weeks of cover."
    assert missing(summary, NUMERIC_IDS) == missing(summary, TEXT_IDS) == []


def test_other_identifier_shapes_too():
    for text, want in [
        ("Deal D-1007 was missing an invoice.", "1007"),
        ("Invoice INV-4501 is unpaid.", "4501"),
        ("Ticket ABC-2311 breached the SLA.", "2311"),
    ]:
        assert adapter._summary_figures(text)[0][0] == want, text


def test_a_range_is_two_positive_numbers():
    got = [raw for raw, _ in adapter._summary_figures("Revenue in the 1200-1500 unit band.")]
    assert got == ["1200", "1500"]


# ── and a real negative still reads as negative ────────────────────────────
#
# The half that would rot quietly. A regex that never signs anything would pass
# every test above while silently agreeing that a loss is a gain.

def test_a_negative_after_a_space_survives():
    assert adapter._summary_figures("Margin fell to -1500.25 this quarter.") == [
        ("-1500.25", adapter.Decimal("-1500.25"))
    ]


def test_a_negative_in_brackets_survives():
    assert adapter._summary_figures("The delta was (-2,400) against plan.")[0][1] == adapter.Decimal(
        "-2400"
    )


def test_a_negative_at_the_start_of_the_text_survives():
    assert adapter._summary_figures("-3,150.00 was the shortfall.")[0][1] == adapter.Decimal(
        "-3150.00"
    )


def test_a_negative_in_the_file_still_reads_as_negative():
    assert adapter.Decimal("-412.5") in adapter._file_figures("region\tvar\nNorth\t-412.5\n")


def test_a_sign_difference_is_still_a_disagreement():
    # -1500 in the summary against 1500 in the file is a real contradiction and
    # must not be forgiven by the fix that stopped inventing minus signs.
    assert missing("The variance was -1500.00.", "x\ty\na\t1500.00\n") == ["-1500.00"]


# ── the check still catches what it is for ─────────────────────────────────

def test_a_cited_id_that_is_not_in_the_data_is_still_flagged():
    assert missing("SKU-1009 needs reordering.", NUMERIC_IDS) == ["1009"]


def test_a_figure_absent_from_the_file_is_still_flagged():
    assert missing("Total outstanding was 41,200.", NUMERIC_IDS) == ["41,200"]
