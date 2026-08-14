"""The model had the right handle. The boundary refused the packaging.

On 2026-08-14, 58 of 77 sandbox calls in the DABstep run came back "Unknown file
handle". 38 of them carried a perfectly good handle, wrapped:

    {'file_id': 'inbound:1a5a24ef5f37', 'filename': 'payments.csv'}
    {'handle': 'inbound:9ee9903d30ae', 'filename': 'payments.csv'}
    {'id': 'inbound:afd3643c0c30', 'name': 'payments.csv'}

The model was not losing handles. It was sending the handle together with the
name it wanted the file staged under — a sensible thing to send — and the
boundary demanded a bare string and threw the whole argument away. Those
refusals took three quarters of every sandbox call in the run out of a
twelve-step budget, which is most of why the hard tasks ended in "I was unable
to" rather than in a wrong answer.

A boundary that can see what was meant and refuses it over packaging is not
strict, it is expensive. The payloads below are the real ones from that run.
"""
import pytest

import adapter

CSV = b"psp_reference,merchant,eur_amount\n1,Crossfit_Hanna,12.50\n"


@pytest.fixture
def held():
    """One file this run holds, and a clean registry around it."""
    inbound, sandbox = dict(adapter._INBOUND_FILES), dict(adapter._SANDBOX_FILES)
    adapter._INBOUND_FILES.clear()
    adapter._SANDBOX_FILES.clear()
    handle = adapter._register_inbound_file("payments.csv", CSV)
    yield handle
    adapter._INBOUND_FILES.clear()
    adapter._SANDBOX_FILES.clear()
    adapter._INBOUND_FILES.update(inbound)
    adapter._SANDBOX_FILES.update(sandbox)


def _stage(arguments):
    out, unresolved = adapter._resolve_handles_in_arguments("execute_python", arguments)
    return out, unresolved


# ── the shapes the live run actually sent ──────────────────────────────────

@pytest.mark.parametrize("key", ["file_id", "handle", "id", "path", "file"])
def test_a_handle_wrapped_in_a_dict_is_still_a_handle(held, key):
    out, unresolved = _stage({"input_files": [{key: held, "filename": "payments.csv"}]})
    assert unresolved == []
    assert [f["name"] for f in out["input_files"]] == ["payments.csv"]


def test_a_bare_handle_still_works(held):
    out, unresolved = _stage({"input_files": [held]})
    assert unresolved == [] and len(out["input_files"]) == 1


def test_the_filename_alone_is_enough(held):
    # The model knows the file as "payments.csv" because that is what it asked
    # for; the token is bookkeeping the platform imposed.
    out, unresolved = _stage({"input_files": ["payments.csv"]})
    assert unresolved == [] and out["input_files"][0]["name"] == "payments.csv"


def test_a_sharepoint_id_beside_a_name_we_hold_resolves_by_the_name(held):
    # 16 of the 58 failures were the SharePoint item_id — the id the model saw
    # in drive_list — sent next to the filename it had already fetched.
    out, unresolved = _stage({"input_files": [
        {"id": "01HBC6OGZI6DGJVGGOLVHK4CWQGNYWZZLO", "filename": "payments.csv"},
    ]})
    assert unresolved == []
    assert out["input_files"][0]["name"] == "payments.csv"


def test_a_mapping_of_name_to_handle_is_read_as_the_files_it_names(held):
    # The shape that cost DB1753 every remaining step: all three files fetched
    # and registered, none of them ever staged, because input_files arrived as
    # {'payments.csv': 'inbound:…'} — which says which file is which, and is
    # arguably clearer than the list we ask for.
    out, unresolved = _stage({"input_files": {"payments.csv": held}})
    assert unresolved == []
    assert [f["name"] for f in out["input_files"]] == ["payments.csv"]


def test_a_mapping_falls_back_to_its_key_when_the_value_is_not_a_handle(held):
    # Half-fetched: one file has a handle, the other still carries the id the
    # model saw in drive_list. The name is enough for the one we hold.
    out, unresolved = _stage({"input_files": {
        "payments.csv": "01HBC6OGZI6DGJVGGOLVHK4CWQGNYWZZLO",
    }})
    assert unresolved == []
    assert out["input_files"][0]["name"] == "payments.csv"


def test_a_mapping_naming_a_file_nobody_has_is_still_refused(held):
    out, unresolved = _stage({"input_files": {"ledger_2019.csv": "01HBCNOTOURS"}})
    assert unresolved and out["input_files"] == []


def test_one_file_sent_unwrapped_is_not_refused_for_not_being_a_list(held):
    out, unresolved = _stage({"input_files": held})
    assert unresolved == [] and len(out["input_files"]) == 1


def test_a_path_under_tmp_input_resolves_by_its_basename(held):
    # The model writes /tmp/input/payments.csv because that is where the file
    # will be, and then passes the same string back as the reference.
    out, unresolved = _stage({"input_files": ["/tmp/input/payments.csv"]})
    assert unresolved == [] and out["input_files"][0]["name"] == "payments.csv"


def test_the_document_parsers_accept_the_same_shapes(held):
    for ref in (held, {"file_id": held, "filename": "payments.csv"}, "payments.csv"):
        out, unresolved = adapter._resolve_handles_in_arguments(
            "parse_xlsx", {"file_content_base64": ref})
        assert unresolved == [], f"{ref!r} was refused"
        import base64 as b64
        assert b64.b64decode(out["file_content_base64"]) == CSV


# ── the code is the declaration that never goes wrong ──────────────────────

def test_the_file_the_code_opens_is_staged_even_when_the_declaration_is_empty(held):
    # DB1753's last six calls: input_files empty, code reading
    # /tmp/input/payments.csv anyway. No error — an empty list is not a mistake,
    # it is nothing — so the run spent every step failing silently.
    out, unresolved = _stage({
        "code": "import pandas as pd\ndf = pd.read_csv('/tmp/input/payments.csv')\n",
        "input_files": [],
    })
    assert unresolved == []
    assert [f["name"] for f in out["input_files"]] == ["payments.csv"]


def test_the_code_and_the_declaration_together_stage_each_file_once(held):
    out, _ = _stage({
        "code": "open('/tmp/input/payments.csv')",
        "input_files": [held],
    })
    assert [f["name"] for f in out["input_files"]] == ["payments.csv"]


def test_a_stale_id_is_forgiven_when_the_code_got_what_it_needed(held):
    # The declaration carries a SharePoint id we cannot place, and the code
    # opens a file we hold. Failing the call over the id would throw away a
    # step that was going to work.
    out, unresolved = _stage({
        "code": "pd.read_csv('/tmp/input/payments.csv')",
        "input_files": [{"file_id": "01HBCSTALE", "filename": "something_else.csv"}],
    })
    assert unresolved == []
    assert [f["name"] for f in out["input_files"]] == ["payments.csv"]


def test_the_code_cannot_conjure_a_file_this_run_does_not_hold(held):
    # Only ever stages what is already registered — a path in code is a
    # request, not an authorisation.
    out, unresolved = _stage({
        "code": "pd.read_csv('/tmp/input/salaries.csv')",
        "input_files": [],
    })
    assert out.get("input_files") in ([], None)


# ── and it still refuses what it genuinely does not have ───────────────────

def test_a_file_nobody_has_is_still_an_error(held):
    out, unresolved = _stage({"input_files": ["ledger_2019.csv"]})
    assert unresolved == ["ledger_2019.csv"]


def test_real_base64_is_left_alone(held):
    # A caller that already has the bytes must not have them treated as a name.
    import base64 as b64
    payload = b64.b64encode(b"x" * 800).decode()
    out, unresolved = adapter._resolve_handles_in_arguments(
        "parse_xlsx", {"file_content_base64": payload})
    assert unresolved == [] and out["file_content_base64"] == payload


def test_the_error_shows_a_line_that_would_have_worked(held):
    err = adapter._unresolved_handle_error(["ledger_2019.csv"])["error"]
    assert held in err, "name the handle it could have used"
    assert "payments.csv" in err, "and the filename, which also works"
    assert "input_files" in err


def test_the_error_says_what_to_do_when_the_run_holds_nothing():
    inbound, sandbox = dict(adapter._INBOUND_FILES), dict(adapter._SANDBOX_FILES)
    adapter._INBOUND_FILES.clear()
    adapter._SANDBOX_FILES.clear()
    try:
        err = adapter._unresolved_handle_error(["payments.csv"])["error"]
        assert "holds no files at all" in err
        assert "drive_fetch" in err
    finally:
        adapter._INBOUND_FILES.update(inbound)
        adapter._SANDBOX_FILES.update(sandbox)
