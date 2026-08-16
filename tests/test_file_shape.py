"""Code written against an assumed shape is this agent's oldest failure.

A ragged row pandas refused. `KeyError: 'merchant_name'` where the column is
`merchant`. A header of `Month, North` read as the column `" North"`. `"Acme
Corp "` and `"Acme Corp"` counted as two customers. And three times in one
benchmark, an equality test against a field holding a list — which matches
nothing and returns an empty answer that reads like a finding.

None of it is a capability gap. Handed the record structure in the prompt, the
model we run wrote correct list-handling code, and so did GPT-OSS-120B and
Claude Sonnet 5 — all three returned the same 416 ids. What the agent lacks in
the wild is the structure. So the platform describes the file at the moment it
hands out a handle, which is the moment it already holds the bytes.

The description is a sample, and the tests below hold it to saying so.
"""
import json

import adapter

FEES = json.dumps([
    {"ID": 1, "card_scheme": "TransactPlus", "account_type": [],
     "aci": ["C", "B"], "rate": 19, "intracountry": None},
    {"ID": 2, "card_scheme": "GlobalCard", "account_type": ["R", "H"],
     "aci": [], "rate": 22, "intracountry": True},
]).encode()

ORDERS = (b"order_id,customer,amount,qty\n"
          b"1001,Acme Corp,1250.00,5\n"
          b"1002,acme corp ,980.50,3\n"
          b"1003,Beta Ltd,2100.00,8\n")

RAGGED = (b"Cohort,Size,M1,M2,M3\n"
          b"2026-01,500,320,240,200\n"
          b"2026-04,700,,,,\n")


# ── the failure it was built for ───────────────────────────────────────────

def test_a_list_field_is_named_as_a_list():
    out = adapter.describe_file_shape("fees.json", FEES)
    assert "account_type: LIST" in out
    assert "aci: LIST" in out


def test_it_says_to_test_membership_rather_than_equality():
    # `account_type == 'R'` matched nothing and the agent reported "no fee IDs
    # apply" when 338 do. The instruction is the whole point of naming the type.
    out = adapter.describe_file_shape("fees.json", FEES)
    assert "membership" in out and "equality" in out


def test_empty_lists_are_counted_because_they_mean_no_restriction():
    out = adapter.describe_file_shape("fees.json", FEES)
    assert "sampled are empty" in out


def test_a_scalar_field_is_not_called_a_list():
    out = adapter.describe_file_shape("fees.json", FEES)
    assert "card_scheme: str" in out
    assert "card_scheme: LIST" not in out


def test_nulls_are_counted_so_a_join_key_is_not_assumed_dense():
    out = adapter.describe_file_shape("fees.json", FEES)
    assert "sampled are null" in out


# ── CSV, and the shapes that have actually broken runs ─────────────────────

def test_a_ragged_row_is_flagged_with_the_row_number():
    out = adapter.describe_file_shape("cohorts.csv", RAGGED)
    assert "RAGGED" in out
    assert "row 3" in out, "name the row, or the sender cannot find it"
    assert "5 fields" in out and "6" in out


def test_the_ragged_warning_says_what_to_do():
    out = adapter.describe_file_shape("cohorts.csv", RAGGED)
    assert "on_bad_lines" in out or "fix the row" in out


def test_a_clean_csv_is_not_accused_of_being_ragged():
    assert "RAGGED" not in adapter.describe_file_shape("orders.csv", ORDERS)


def test_a_sample_that_ends_mid_row_does_not_invent_a_ragged_row(monkeypatch):
    # The prototype's own bug: it read 2 MB of a 24 MB file, the last row was
    # cut in half, and it reported a ragged row that did not exist. A warning
    # about damage the profiler did itself is worse than saying nothing.
    monkeypatch.setattr(adapter, "_PROFILE_SAMPLE_BYTES", 40)
    big = b"a,b,c\n" + b"1,2,3\n" * 200
    out = adapter.describe_file_shape("big.csv", big)
    assert "RAGGED" not in out


def test_a_truncated_read_admits_it_is_partial(monkeypatch):
    monkeypatch.setattr(adapter, "_PROFILE_SAMPLE_BYTES", 40)
    out = adapter.describe_file_shape("big.csv", b"a,b,c\n" + b"1,2,3\n" * 200)
    assert "of a larger file" in out


def test_trailing_whitespace_shows_up_as_two_distinct_values():
    # T04 merged "Acme Corp " and "Acme Corp" in its prose and not in its data.
    out = adapter.describe_file_shape("orders.csv", ORDERS)
    assert "'acme corp '" in out or "acme corp " in out


def test_low_cardinality_columns_list_their_values():
    out = adapter.describe_file_shape("orders.csv", ORDERS)
    assert "3 distinct" in out


# ── it must never cost the file it describes ───────────────────────────────

def test_a_file_it_cannot_read_yields_nothing_rather_than_raising():
    assert adapter.describe_file_shape("broken.json", b"{not json at all") \
        .startswith("broken.json: not valid JSON")


def test_a_format_it_does_not_know_is_simply_undescribed():
    assert adapter.describe_file_shape("chart.png", b"\x89PNG\r\n") == ""


def test_a_profiler_crash_never_reaches_the_caller(monkeypatch):
    def _boom(*a, **k):
        raise RuntimeError("profiler is broken")
    monkeypatch.setattr(adapter, "_profile_csv", _boom)
    assert adapter.describe_file_shape("orders.csv", ORDERS) == ""


def test_an_empty_file_says_so():
    assert "empty" in adapter.describe_file_shape("nothing.csv", b"")


# ── and it reaches the agent, on both routes ───────────────────────────────

def test_an_attachment_is_described_where_it_is_handed_over():
    import io as _io
    from pathlib import Path
    src = _io.open(Path(adapter.__file__), encoding="utf-8").read() \
        if getattr(adapter, "__file__", None) else ""
    assert "describe_file_shape(safe_name, raw)" in src, (
        "an emailed dataset arrives with a handle and no description"
    )


def test_the_describer_is_injected_at_every_call_site():
    import io as _io
    from pathlib import Path
    src = _io.open(Path(adapter.__file__), encoding="utf-8").read()
    assert src.count("file_describer_fn=describe_file_shape") == \
        src.count("file_registrar_fn=_register_inbound_file"), (
        "a workspace file can be fetched somewhere that cannot describe it"
    )
