"""Creators are told that all of Graph is theirs, and what the limits are.

The Data Analyst wraps a handful of Graph calls, and nothing said whether that
was the agent's choice or the platform's ceiling. It is the agent's choice: the
egress proxy allows the whole host, the adapter attaches the credential, reads
are ungated and unclassified writes escalate to the buyer rather than being
refused. A creator who assumed otherwise would build a smaller agent than they
could have, or ask for a permission they already have.

The three things that actually bite are documented with it: the granted
permission set (a 403 outside it needs every buyer to re-consent, so it is not a
code problem), the escalation behaviour of unrecognised writes, and the Excel
API's own limits.
"""
from pathlib import Path

DOCS = (Path(__file__).resolve().parents[1] / "apps" / "web" / "app" / "(public)"
        / "docs" / "creators" / "page.tsx").read_text(encoding="utf-8")
ADAPTER = (Path(__file__).resolve().parents[1] / "apps" / "provisioning-service" / "src"
           / "templates" / "runtime" / "adapter.py").read_text(encoding="utf-8")


def test_creators_are_told_the_whole_api_is_available():
    assert "constraints-graph" in DOCS
    assert "not just our helpers" in DOCS


def test_creators_are_told_not_to_send_their_own_credential():
    # The adapter strips it; a creator who does not know that writes token code
    # that silently does nothing.
    assert "Do not attach an Authorization header" in DOCS


def test_the_documented_permissions_match_what_the_platform_holds():
    # Sourced from the live token's roles claim on 2026-09-20. If the app
    # registration changes, this doc goes stale and a creator plans around a
    # permission that is no longer there.
    for permission in (
        "Mail.ReadWrite", "Mail.Send", "Calendars.ReadWrite",
        "Files.ReadWrite.All", "Sites.ReadWrite.All",
        "User.ReadWrite.All", "Organization.ReadWrite.All",
    ):
        assert permission in DOCS, permission


def test_creators_are_warned_that_widening_permissions_is_not_free():
    assert "consent again" in DOCS


def test_the_escalation_rule_is_documented_as_the_adapter_implements_it():
    # Documented behaviour and actual behaviour, checked against each other.
    assert 'graph_POST:/the/path' in DOCS
    assert 'return f"graph_{m.lower()}:{p.split(\'?\')[0][:80]}"' in ADAPTER
    assert "GET / HEAD — reads are not gated here." in ADAPTER


def test_the_excel_limits_that_cause_silent_wrong_answers_are_named():
    for limit in ("Unbounded ranges", "chunks", ".xls"):
        assert limit in DOCS, limit


def test_the_formula_difference_between_the_tiers_is_stated():
    # The org tier reads Excel-evaluated values; the sandbox has no formula
    # engine, so the same workbook read from an attachment yields nothing.
    assert "no formula engine" in DOCS
