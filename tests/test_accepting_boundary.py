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
