"""One run's work must stay its own, and be recoverable afterwards.

The inbound hook is fire-and-forget and the poller posts whole batches, so runs
overlap inside one container. Anything a run keeps in module state is shared
with every other run in flight — which is how one buyer's summary came to be
checked against another's workbook.
"""
import asyncio
import base64
import json

import adapter


PNG = base64.b64encode(b"\x89PNG\r\n\x1a\n fake chart bytes").decode()


def envelope(name, payload=b"data"):
    return {"stdout": "", "stderr": "", "returncode": 0,
            "files": [{"name": name, "base64_content": base64.b64encode(payload).decode()}]}


# ── file handles, per run ───────────────────────────────────────────────────

def test_overlapping_runs_keep_their_own_files():
    async def run(label, filename, hold):
        adapter.begin_run(f"email:{label}")
        adapter._register_sandbox_files(envelope(filename))
        mine = list(adapter.current_run_files())
        await asyncio.sleep(hold)              # the window the other run starts in
        return mine, list(adapter.current_run_files())

    async def main():
        return await asyncio.gather(run("A", "alpha.csv", 0.05),
                                    run("B", "beta.csv", 0.01))

    (a_mine, a_after), (b_mine, b_after) = asyncio.run(main())
    assert a_after == a_mine, "run A lost its own handles to run B"
    assert b_after == b_mine
    assert not set(a_after) & set(b_after)


def test_a_resume_rejoins_its_own_run():
    adapter.begin_run("email:C")
    adapter._register_sandbox_files(envelope("gamma.csv"))
    c_files = list(adapter.current_run_files())

    adapter.begin_run("email:D")               # another run, mid-flight
    adapter._register_sandbox_files(envelope("delta.csv"))
    d_files = list(adapter.current_run_files())

    adapter.attach_run("email:C")              # the approval comes back
    assert adapter.current_run_files() == c_files
    assert not set(adapter.current_run_files()) & set(d_files)


def test_a_new_message_on_the_same_thread_starts_clean():
    adapter.begin_run("email:E")
    adapter._register_sandbox_files(envelope("old.csv"))
    adapter.begin_run("email:E")
    assert adapter.current_run_files() == []


def test_the_thread_table_stays_bounded():
    for i in range(adapter._RUN_FILES_LIMIT + 20):
        adapter.begin_run(f"email:throwaway:{i}")
    assert len(adapter._RUN_FILES) <= adapter._RUN_FILES_LIMIT


# ── the working, recorded ───────────────────────────────────────────────────

def _record_a_run():
    adapter.begin_run("email:nb")
    adapter.record_sandbox_step(
        "execute_python",
        {"code": "rpu = 910000 / 3500\nprint(f'Revenue per unit: {rpu:.2f}')"},
        {"stdout": "Revenue per unit: 260.00\n", "stderr": "", "returncode": 0,
         "files": [{"name": "alpha.xlsx", "base64_content": "eHl6"}]},
    )
    # The real crash: partial output, NameError, exit 1 — reported as a finding.
    adapter.record_sandbox_step(
        "execute_python",
        {"code": "print(sl_growth_region)"},
        {"stdout": "Fastest Growing Region: West (14.05%)\n",
         "stderr": "NameError: name 'sl_growth_region' is not defined\n",
         "returncode": 1, "files": []},
    )
    adapter.record_sandbox_step(
        "execute_python",
        {"code": "plt.savefig('/tmp/output/chart.png')"},
        {"stdout": "", "stderr": "", "returncode": 0,
         "files": [{"name": "chart.png", "base64_content": PNG}]},
    )


def test_the_code_is_kept_rather_than_discarded():
    _record_a_run()
    steps = adapter.current_run_steps()
    assert len(steps) == 3
    assert "910000 / 3500" in steps[0]["code"]


def test_stdout_is_kept_whole():
    _record_a_run()
    assert "260.00" in adapter.current_run_steps()[0]["stdout"]


def test_a_failure_is_kept_rather_than_hidden():
    _record_a_run()
    step = adapter.current_run_steps()[1]
    assert step["returncode"] == 1
    assert "NameError" in step["stderr"]


def test_charts_are_captured_before_the_bytes_become_handles():
    _record_a_run()
    assert adapter.current_run_steps()[2]["images"][0]["base64"] == PNG


def test_a_spreadsheet_is_not_mistaken_for_a_chart():
    _record_a_run()
    assert adapter.current_run_steps()[0]["images"] == []


def test_parsing_a_document_is_not_working_worth_showing():
    adapter.begin_run("email:parse")
    adapter.record_sandbox_step("parse_xlsx", {"file_content_base64": "..."}, {"sheets": {}})
    assert adapter.current_run_steps() == []


def test_steps_are_run_scoped_like_the_handles():
    _record_a_run()
    adapter.begin_run("email:unrelated")
    adapter.record_sandbox_step("execute_python", {"code": "print('other')"},
                                {"stdout": "other\n", "stderr": "", "returncode": 0, "files": []})
    assert len(adapter.current_run_steps()) == 1
    adapter.attach_run("email:nb")
    assert len(adapter.current_run_steps()) == 3


def test_the_recorder_never_takes_down_the_run_it_describes():
    adapter.begin_run("email:robust")
    for bad in (None, {}, {"stdout": None}, {"files": [{"name": None}]}, "not a dict"):
        adapter.record_sandbox_step("execute_python", {"code": "x"}, bad)  # must not raise


# ── the notebook ────────────────────────────────────────────────────────────

def _notebook():
    _record_a_run()
    att = adapter.notebook_attachment(adapter.current_run_steps(),
                                      request="ALPHA revenue 910000, units 3500.",
                                      subject="ALPHA region sheet")
    return att, json.loads(base64.b64decode(att["content_base64"]).decode())


def test_the_notebook_is_valid():
    att, nb = _notebook()
    assert att["name"].endswith(".ipynb")
    assert nb["nbformat"] == 4
    assert "kernelspec" in nb["metadata"]


def test_one_cell_per_execution_in_order():
    _, nb = _notebook()
    assert len([c for c in nb["cells"] if c["cell_type"] == "code"]) == 3


def test_the_traceback_is_visible_in_the_notebook():
    _, nb = _notebook()
    flat = json.dumps(nb)
    assert "NameError" in flat
    assert "exited with code 1" in flat


def test_the_chart_is_embedded_not_referenced():
    _, nb = _notebook()
    codes = [c for c in nb["cells"] if c["cell_type"] == "code"]
    assert any(o["output_type"] == "display_data" for c in codes for o in c["outputs"])
    assert PNG in json.dumps(nb)


def test_the_request_is_recorded_alongside_the_working():
    _, nb = _notebook()
    assert "910000" in json.dumps(nb)


def test_nothing_to_show_means_no_attachment():
    adapter.begin_run("email:empty")
    assert adapter.notebook_attachment(adapter.current_run_steps()) is None
