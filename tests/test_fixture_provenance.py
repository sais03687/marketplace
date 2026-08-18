"""Where a fixture came from must be recorded on the fixture.

Two tests in test_headline_check.py asserted that D02's and D04's replies were
fine. Neither had been checked against anything; I had typed the replies out
while writing the tests and my belief about them came along invisibly. D02's
reply was wrong — Acme was understated by 1,305 — so a test was pinning a defect
in place as correct behaviour.

Nothing about the code could have caught that. What catches it is knowing, when
reading a fixture, whether anyone ever verified it and how. So every fixture
declares three things: how it was obtained, what the verdict is, and on what
basis the verdict was reached. `benchmark/capture_fixture.mjs` fills the first
in automatically; the other two are judgements and are recorded as judgements.

A `transcribed` fixture is not forbidden — the 2026-08-17 corpus predates the
capture tool and cannot be re-obtained. It is required to say so, so that a
later reader knows which fixtures to distrust.
"""
import json
from pathlib import Path

import pytest

FIXTURES = Path(__file__).resolve().parent / "fixtures"
FILES = sorted(FIXTURES.glob("*.json"))


def test_there_are_fixtures_to_check():
    # A convention test over an empty directory passes and means nothing.
    assert FILES, "no fixtures found; this file would pass vacuously"


@pytest.mark.parametrize("path", FILES, ids=[f.stem for f in FILES])
def test_a_fixture_says_where_it_came_from(path):
    d = json.loads(path.read_text(encoding="utf-8"))
    prov = d.get("provenance")
    assert isinstance(prov, dict), "no provenance block"
    assert prov.get("capture") in ("automatic", "transcribed", "mixed"), (
        "capture must say whether a person typed this out or a tool captured it"
    )
    assert prov.get("captured_at"), "no date"
    assert prov.get("source"), "no statement of where it came from"


@pytest.mark.parametrize("path", FILES, ids=[f.stem for f in FILES])
def test_a_hand_typed_fixture_admits_it(path):
    d = json.loads(path.read_text(encoding="utf-8"))
    if d["provenance"]["capture"] == "automatic":
        return
    assert d["provenance"].get("warning"), (
        "a transcribed fixture must carry a warning, because the next reader "
        "cannot otherwise tell it from a captured one"
    )


@pytest.mark.parametrize("path", FILES, ids=[f.stem for f in FILES])
def test_every_verdict_states_how_it_was_reached(path):
    d = json.loads(path.read_text(encoding="utf-8"))
    basis = d.get("verdict_basis")
    assert basis and len(basis) > 20, (
        "a verdict with no stated basis is an opinion, and an opinion in a "
        "fixture is indistinguishable from a measurement"
    )
    for case in d.get("cases", [d]):
        assert case.get("verdict") in ("correct", "wrong"), (
            f"{case.get('id', '?')} has no verdict"
        )


@pytest.mark.parametrize("path", FILES, ids=[f.stem for f in FILES])
def test_a_corpus_holds_both_verdicts(path):
    """A corpus of only-wrong or only-right cases cannot measure a rule.

    The word-list rule scored well until it was run against replies that were
    correct, where it raised caveats on good work. Both halves are needed, and a
    corpus that has drifted to one is worth knowing about.
    """
    d = json.loads(path.read_text(encoding="utf-8"))
    cases = d.get("cases")
    if not cases or len(cases) < 3:
        return
    verdicts = {c["verdict"] for c in cases}
    assert verdicts == {"correct", "wrong"}, (
        f"only {verdicts} present — a rule cannot be measured for false alarms "
        "against a corpus with nothing correct in it, nor for misses against "
        "one with nothing wrong"
    )
