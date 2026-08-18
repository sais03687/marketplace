"""A reasoning call that times out must not throw away the answer.

Task E1 on 2026-08-17 asked for headcount cost by department. The agent computed
it correctly, wrote a workbook whose Summary sheet held "Highest Average Salary:
96000; Engineering: 3; Marketing: 1; Operations: 2", and then the next reasoning
call timed out. The handler replaced the entire run with

    I need more time to process this — I'll follow up shortly.

and set completed. Nothing followed up: there was nothing left to follow up
with. The buyer got a sentence, and the answer sat in a file they were never
told about.

`_buyer_readable` cannot rescue this. The run's one real result is a sandbox
envelope — stdout, handles, a files array — and it drops those whole, correctly,
because sending one to a buyer tells them nothing. But the platform now reads
the workbook's Summary sheet back into that envelope, so the figures are in
reach, and quoting them needs no model at all.
"""
import io
import json
from pathlib import Path

from creator import agent


AGENT_SRC = io.open(
    Path(__file__).resolve().parents[1] / "agents" / "data-analyst" / "agent.py",
    encoding="utf-8",
).read()

PAIRS = ["Highest Average Salary: 96000", "Engineering: 3", "Marketing: 1", "Operations: 2"]

# The envelope as the sandbox returns it once the read-back has run: the figures
# are in the `summary` list, and the note repeats them in prose.
ENVELOPE = json.dumps({
    "stdout": "Analysis complete\n", "stderr": "", "returncode": 0,
    "files": [{
        "name": "headcount_cost_by_department.xlsx",
        "file_id": "sandbox:086ca97ce0d1",
        "size_bytes": 6044,
        "summary": PAIRS,
        "note": ("Pass this file_id as content_base64 to upload it. The contents are "
                 "held by the platform. Its Summary sheet holds: "
                 + "; ".join(PAIRS) + ". Quote these in your reply."),
    }],
})


# ── the figures are recoverable ────────────────────────────────────────────

def test_the_figures_are_pulled_back_out_of_the_envelope():
    out = agent._summary_figures_from_results([ENVELOPE])
    assert "Highest Average Salary: 96000" in out
    assert "Engineering: 3" in out


def test_every_pair_is_kept_not_just_the_first():
    out = agent._summary_figures_from_results([ENVELOPE])
    assert len([ln for ln in out.splitlines() if ln.startswith("- ")]) == 4


# ── it must not depend on any particular wording ───────────────────────────
#
# The figures are read out of the `summary` list on the file entry. A sentence
# can be reworded by whoever edits the adapter next; a JSON key cannot be
# reworded by accident. These tests exist to keep the structure load-bearing.

def test_rewording_the_note_changes_nothing():
    reworded = json.loads(ENVELOPE)
    reworded["files"][0]["note"] = "Totally different sentence with no figures in it."
    out = agent._summary_figures_from_results([json.dumps(reworded)])
    assert "Engineering: 3" in out, "the prose was load-bearing after all"


def test_dropping_the_note_entirely_changes_nothing():
    bare = json.loads(ENVELOPE)
    del bare["files"][0]["note"]
    assert "Marketing: 1" in agent._summary_figures_from_results([json.dumps(bare)])


def test_a_result_handed_over_as_an_object_rather_than_a_string():
    # Nothing guarantees these arrive stringified.
    assert "Operations: 2" in agent._summary_figures_from_results([json.loads(ENVELOPE)])


def test_the_figures_are_found_however_deeply_the_result_nests():
    nested = {"result": {"data": {"files": [{"summary": ["Gap: 3850"]}]}}}
    assert "Gap: 3850" in agent._summary_figures_from_results([nested])


def test_a_summary_given_as_a_string_is_still_split():
    entry = {"files": [{"summary": "Total: 100910; Top earner: E. Rasmussen"}]}
    out = agent._summary_figures_from_results([entry])
    assert "Total: 100910" in out and "Top earner: E. Rasmussen" in out


def test_prose_still_rescues_a_truncated_envelope():
    # The 300-char log path truncates routinely, and half a JSON document parses
    # as nothing at all. The sentence is the fallback, not the mechanism.
    truncated = ENVELOPE[:ENVELOPE.index('"summary"')] + (
        'note": "Its Summary sheet holds: Highest Average Salary: 96000; Engineering: 3'
    )
    out = agent._summary_figures_from_results([truncated])
    assert "Highest Average Salary: 96000" in out


def test_a_qualified_sheet_name_is_still_found_in_prose():
    # D04's workbook called its sheet "AR Aging Summary".
    env = 'note: "Its AR Aging Summary sheet holds: Total Outstanding: 130450."'
    assert "Total Outstanding: 130450" in agent._summary_figures_from_results([env])


def test_malformed_json_never_raises():
    for junk in ["{not json at all", "{", '{"files": [', "", "   "]:
        agent._summary_figures_from_results([junk])


def test_a_run_with_no_workbook_yields_nothing():
    assert agent._summary_figures_from_results(["Fetched 2 files", "STEP FAILED"]) == ""
    assert agent._summary_figures_from_results([]) == ""


def test_the_same_workbook_twice_is_not_listed_twice():
    out = agent._summary_figures_from_results([ENVELOPE, ENVELOPE])
    assert out.count("Engineering: 3") == 1


def test_the_envelope_itself_never_reaches_the_buyer():
    # The point of extracting rather than pasting: handles and stdout are not an
    # answer, and _buyer_readable drops the envelope for exactly that reason.
    out = agent._summary_figures_from_results([ENVELOPE])
    for internal in ("sandbox:", "file_id", "stdout", "returncode"):
        assert internal not in out


# ── the two halves, joined ─────────────────────────────────────────────────

def test_the_platform_writes_what_the_agent_reads(monkeypatch):
    """End to end across the boundary, on the shape E1's workbook actually had.

    Both halves are tested above against a fixture. This is the one that would
    catch them agreeing with the fixture and not with each other — the adapter
    writes the summary, the agent reads it back, and nothing in between is
    mocked except the sandbox parser.
    """
    import asyncio
    import adapter

    async def _fake_parse(name, raw):
        return {"sheets": {"Summary": [
            ["Metric", "Value"],                 # header, must not survive
            ["Highest Average Salary", 96000],
            ["Engineering", 3], ["Marketing", 1],
            ["Operations", 2], ["Sales", 2],
        ]}}

    monkeypatch.setattr(adapter, "_parsed_file", _fake_parse)
    adapter._SANDBOX_FILES["sandbox:e1"] = {"name": "headcount.xlsx", "bytes": b"PK"}

    written = asyncio.run(adapter._read_back_summary({
        "stdout": "Analysis complete",
        "files": [{"name": "headcount.xlsx", "file_id": "sandbox:e1",
                   "note": "Pass this file_id."}],
    }))

    recovered = agent._summary_figures_from_results([json.dumps(written)])
    assert "Highest Average Salary: 96000" in recovered
    assert "Sales: 2" in recovered
    assert "Metric: Value" not in recovered, "the header row is not a figure"


# ── and the timeout no longer discards them ────────────────────────────────

def _code_only(src: str) -> str:
    """The source with comment lines dropped.

    The first version of the test below searched the whole file, and failed on
    the comment explaining why the placeholder was removed. What matters is that
    nothing assigns it, not that the words never appear.
    """
    return "\n".join(
        line for line in src.splitlines() if not line.lstrip().startswith("#")
    )


def test_the_timeout_no_longer_writes_a_placeholder():
    assert "I need more time to process this" not in _code_only(AGENT_SRC), (
        "the placeholder replaced a run that had already produced the answer"
    )


def test_the_timeout_hands_finalize_an_empty_reply_to_compose_from():
    # Widened from 1800: the handler grew a retry branch ahead of this, and a
    # fixed window that clips the code under test reports a passing fix as
    # broken. Sliced to the end of the handler instead.
    start = AGENT_SRC.index("except asyncio.TimeoutError:")
    handler = AGENT_SRC[start:AGENT_SRC.index("text = response.content", start)]
    assert '"text": ""' in handler, (
        "finalize decides what to say from what the run holds; a placeholder "
        "pre-empts that and there is no path back"
    )


def test_the_timeout_is_configurable_because_it_is_a_property_of_the_model():
    # 60s was chosen against Gemini Flash. A slower model spends it on work Flash
    # finished inside it, and every timeout costs a step.
    assert 'os.environ.get("LLM_TIMEOUT_S"' in AGENT_SRC
    assert "timeout=_LLM_TIMEOUT_S" in AGENT_SRC


def test_finalize_prefers_the_computed_figures_over_admitting_nothing():
    # Ordering matters: the "nothing to show" branches must not run while there
    # are figures in hand.
    computed = AGENT_SRC.index("elif computed:")
    failure = AGENT_SRC.index("elif failure:")
    assert computed < failure
