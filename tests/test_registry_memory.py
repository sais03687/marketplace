"""Sixteen files is a sensible number of files and 377 MB of a 512 MB container.

The handle registries were capped by count. At the 25 MB a handle will hold,
that ceiling is most of the agent container — and the registry is process-global,
so it outlives the run that filled it. A buyer whose agent opens a large
spreadsheet a few times a day accumulates them until something dies.

Something did, on 2026-08-14, in the middle of the DABstep run: six consecutive
tasks had each fetched the same 23.58 MB CSV, and staging three files into one
sandbox call — raw bytes, base64, the JSON body, the request — spiked on top of
everything the five runs before it were still holding. The container restarted
and took the task in flight with it.
"""
import adapter


def _reg(sizes):
    return {f"inbound:{i}": {"name": f"f{i}.csv", "bytes": b"x" * n}
            for i, n in enumerate(sizes)}


def _total(reg):
    return sum(len(e["bytes"]) for e in reg.values())


def test_weight_is_capped_not_just_count():
    reg = _reg([20 * 1024**2] * 6)  # 120 MB in six files: fine by count, not by weight
    adapter._evict_to_fit(reg, 16, 64 * 1024**2)
    assert _total(reg) <= 64 * 1024**2
    assert len(reg) < 6


def test_the_oldest_go_first():
    reg = _reg([30 * 1024**2, 30 * 1024**2, 30 * 1024**2])
    adapter._evict_to_fit(reg, 16, 64 * 1024**2)
    # The newest survives; the first one in is the first out.
    assert "inbound:2" in reg
    assert "inbound:0" not in reg


def test_the_file_the_run_just_asked_for_is_never_dropped():
    # One file over the ceiling on its own. Evicting it would fail the work
    # being done now to protect work that is already finished.
    reg = _reg([100 * 1024**2])
    adapter._evict_to_fit(reg, 16, 64 * 1024**2)
    assert len(reg) == 1


def test_the_count_ceiling_still_applies():
    reg = _reg([1] * 40)
    adapter._evict_to_fit(reg, 16, 64 * 1024**2)
    assert len(reg) == 16


def test_a_registry_within_both_ceilings_is_left_alone():
    reg = _reg([1024, 2048, 4096])
    adapter._evict_to_fit(reg, 16, 64 * 1024**2)
    assert len(reg) == 3


def test_both_registries_are_bounded_by_weight():
    src = __import__("io").open(adapter.__file__, encoding="utf-8").read() \
        if hasattr(adapter, "__file__") else ""
    assert src.count("_evict_to_fit(") >= 3, (
        "inbound and sandbox registries must both be weight-bounded, or the "
        "one that is not becomes the leak"
    )


def test_a_registry_of_large_files_stays_inside_the_container():
    # Ten DABstep-sized fetches in a row, which is what the benchmark did.
    reg = {}
    for i in range(10):
        reg[f"inbound:{i}"] = {"name": "payments.csv", "bytes": b"x" * (23_581_339)}
        adapter._evict_to_fit(reg, 16, 64 * 1024**2)
    assert _total(reg) <= 64 * 1024**2, "the leak that restarted the container"


# ── the transient spike, which the byte cap did not fix ────────────────────

def _drain(agen):
    import asyncio
    async def go():
        return [chunk async for chunk in agen]
    return asyncio.run(go())


def test_the_streamed_body_reassembles_into_the_same_request():
    import base64, json
    raw = b"col_a,col_b\n" + b"1,2\n" * 50_000
    lean, files = adapter._streamable_files(
        {"code": "print(1)", "input_files": [{"name": "big.csv", "_bytes": raw}]})
    body = b"".join(_drain(adapter._stream_call_body("execute_python", lean, files)))

    sent = json.loads(body)
    staged = sent["arguments"]["input_files"][0]
    assert staged["name"] == "big.csv"
    assert base64.b64decode(staged["content_base64"]) == raw, "the file changed in transit"
    assert sent["arguments"]["code"] == "print(1)"


def test_the_encoding_is_produced_in_pieces_rather_than_all_at_once():
    # The whole point: a 23.58 MB file becomes ~31 MB of base64, and holding
    # that beside the JSON document and httpx's copy is what killed the
    # container twice.
    raw = b"x" * (3 * 1024 * 1024)
    lean, files = adapter._streamable_files(
        {"input_files": [{"name": "big.csv", "_bytes": raw}]})
    chunks = _drain(adapter._stream_call_body("execute_python", lean, files))
    assert len(chunks) > 8, "the file was encoded in one go"
    assert max(len(c) for c in chunks) < 1024 * 1024, "a chunk held too much at once"


def test_several_files_each_land_in_their_own_place():
    import base64, json
    a, b = b"first file", b"second file"
    lean, files = adapter._streamable_files({"input_files": [
        {"name": "a.csv", "_bytes": a}, {"name": "b.csv", "_bytes": b}]})
    sent = json.loads(b"".join(_drain(adapter._stream_call_body("execute_python", lean, files))))
    got = {f["name"]: base64.b64decode(f["content_base64"]) for f in sent["arguments"]["input_files"]}
    assert got == {"a.csv": a, "b.csv": b}


def test_a_call_with_no_files_is_left_completely_alone():
    args = {"code": "print(1)"}
    lean, files = adapter._streamable_files(args)
    assert files == [] and lean == args
