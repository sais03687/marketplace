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
