"""The rule, against every real reply collected on 2026-08-17.

Unit tests use fixtures, and a fixture agrees with whatever belief wrote it —
two of the ones in test_headline_check.py asserted that D02's and D04's replies
were fine, on no evidence, and D02's was wrong. These cases carry the reply text
as it was actually sent, and the verdict is the one established by comparing it
against independently computed answers.

Measured across this corpus when the rule was chosen:

    word list      caught 2 of 3 wrong,  0 false alarms in 4 right
    first figure   caught 3 of 3 wrong,  0 false alarms in 4 right
"""
import adapter
import pytest

D01_V1 = (
    "Hi Sai, I've reconciled the CRM and finance revenue numbers for July. The "
    "primary difference of $450 is due to a discrepancy in the amount recorded "
    "for Fabrikam Inc. (Deal ID D-1003), and a duplicate invoice for Litware."
)
D01_V3 = (
    "Hi Sai, I've reconciled the CRM deals against the finance invoices for July "
    "and found a total discrepancy of $4,200. This is primarily due to two "
    "factors: Missing Invoice: Deal D-1007 (Tailspin Toys, $18,400)."
)
D02 = (
    "Hi Sai, I've analyzed the July order export. Acme Corp: $6,525.00 "
    "Globex Industries: $4,480.00 Initech LLC: $3,982.50 Umbrella Co: $2,730.00"
)
D04 = (
    "Hi Sai, Fabrikam Inc is the customer we should be chasing hardest. They have "
    "the highest amount of overdue invoices, totaling $41,200, with $18,900 of "
    "that being over 90 days past due."
)
E3 = "Hi Sai, Overall first-response SLA hit rate: 90% (9 of 10 tickets met the target)."
E4 = (
    "Hi Sai, Total SKUs that need to be reordered: 3. Average weeks of cover "
    "(including flagged items): 0.78 weeks."
)

RECON = {"sheets": {"Summary": [["Total CRM Revenue", 155300],
                                ["Total Finance Revenue", 151450],
                                ["Overall Discrepancy", 3850]]}}
REVENUE = {"sheets": {"Summary": [["Total July Revenue", 17717.5]]}}
AGING = {"sheets": {"AR Aging Summary": [["customer", "Total Outstanding"],
                                         ["Fabrikam Inc", 41200], ["Blue Yonder", 31200]]}}
SLA = {"sheets": {"Summary": [["Overall SLA Hit Rate", 0.9], ["High", 0.75]]}}
REORDER = {"sheets": {"Summary": [["Total SKUs needing reorder", 3.0],
                                  ["Average weeks of cover", 0.78]]}}

# reply, workbook, was the reply wrong?
CORPUS = [
    ("D01 v1 — claimed 450 was the difference", D01_V1, RECON, True),
    ("D01 v3 — claimed 4,200 was the difference", D01_V3, RECON, True),
    ("D02 — Acme understated by 1,305", D02, REVENUE, True),
    ("D04 — aging, correct throughout", D04, AGING, False),
    ("E3 — SLA, correct throughout", E3, SLA, False),
    ("E4 — reorder, correct throughout", E4, REORDER, False),
]


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
    assert caught == 3


def test_it_stays_silent_on_every_correct_one():
    fired = sum(
        bool(adapter._headline_conflicts(r, adapter._summary_sheet_values(b)))
        for _, r, b, wrong in CORPUS if not wrong
    )
    assert fired == 0
