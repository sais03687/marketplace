"""The rule, against every real reply collected on 2026-08-17.

Unit tests use fixtures, and a fixture agrees with whatever belief wrote it -
two of the ones in test_headline_check.py asserted that D02's and D04's replies
were fine, on no evidence, and D02's was wrong. These cases carry the reply text
as it was actually sent, and the verdict is the one established by comparing it
against independently computed answers.

The corpus itself now lives in tests/fixtures/2026-08-17-headline-corpus.json,
next to its own provenance. It was inline here, which meant the record of where
it came from was a docstring nobody could check; test_fixture_provenance.py can
check a file. That fixture is honest about being transcribed rather than
captured, which is the weaker kind - benchmark/capture_fixture.mjs exists so
later ones are not.

Measured across this corpus when the rule was chosen:

    word list      caught 2 of 3 wrong,  0 false alarms in 4 right
    first figure   caught 3 of 3 wrong,  0 false alarms in 4 right
"""
import json
from pathlib import Path

import adapter
import pytest

CORPUS_FILE = Path(__file__).resolve().parent / "fixtures" / "2026-08-17-headline-corpus.json"
_RAW = json.loads(CORPUS_FILE.read_text(encoding="utf-8"))

# reply, workbook, was the reply wrong?
CORPUS = [
    (c["note"], c["reply"], c["workbook"], c["verdict"] == "wrong")
    for c in _RAW["cases"]
]

WRONG = sum(1 for c in _RAW["cases"] if c["verdict"] == "wrong")
RIGHT = len(_RAW["cases"]) - WRONG


def test_the_corpus_is_the_one_the_rule_was_measured_against():
    # If a case is added or removed the counts below stop meaning what the
    # docstring says, and the two totals asserted further down would silently
    # become a different claim.
    assert (WRONG, RIGHT) == (3, 3), (
        "the corpus changed; re-measure the rule rather than adjusting the counts"
    )


@pytest.mark.parametrize("name,reply,book,wrong", CORPUS, ids=[c[0] for c in CORPUS])
def test_the_rule_matches_the_verdict(name, reply, book, wrong):
    fired = bool(adapter._headline_conflicts(reply, adapter._summary_sheet_values(book)))
    if wrong:
        assert fired, "a wrong headline went unflagged"
    else:
        assert not fired, "a caveat on correct work teaches the reader to skip caveats"


def test_it_catches_every_wrong_reply_in_the_corpus():
    caught = sum(
        bool(adapter._headline_conflicts(r, adapter._summary_sheet_values(b)))
        for _, r, b, wrong in CORPUS if wrong
    )
    assert caught == WRONG


def test_it_stays_silent_on_every_correct_one():
    fired = sum(
        bool(adapter._headline_conflicts(r, adapter._summary_sheet_values(b)))
        for _, r, b, wrong in CORPUS if not wrong
    )
    assert fired == 0  # every correct reply, silent
