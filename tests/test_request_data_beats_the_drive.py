"""Data in the request outranks a file on the drive.

On 2026-09-17 a follow-up on the conversion-rate task (T01) replied:

    "I'm unable to calculate the overall conversion rate weighted by visitors
     because the current file (ALPHA_Region_Data.xlsx) does not contain the
     required fields."

There was no file. The visitors and conversions were pasted in the original
email, and ALPHA_Region_Data.xlsx belongs to a different task. T04 did the same
and answered $35,122 against a truth of $7,385.75, having aggregated a
`cleaned_orders` workbook left behind by an earlier run. Told where to look,
both went to exactly right — 5.33% and 7,385.75 — so the analysis was never the
problem.

Two things caused it, and the thread history was not one of them: the poller
does forward the quoted chain under "Earlier in this thread".

1. The prompt carried an absolute — "ALWAYS use drive_list FIRST" — which fired
   even when the data was already in hand. Same shape as the E4 double gate:
   two rules in conflict and the loudest one wins.
2. After ~30 benchmark runs the agent's SharePoint held 13 workbooks it had
   produced itself, so each run's output became the next run's input and there
   was always a plausible-looking file to find.

`_describe_pasted_data` already detects a pasted table — the platform knows, at
no cost, when the data is in the message. It now says so, and says not to go
looking for a file instead. Inferred from the artifact rather than asked for in
prose, as in `384525d`.
"""
import io
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
AGENT_SRC = io.open(REPO / "agents" / "data-analyst" / "agent.py", encoding="utf-8").read()
ADAPTER = REPO / "apps" / "provisioning-service" / "src" / "templates" / "runtime" / "adapter.py"
ADAPTER_SRC = io.open(ADAPTER, encoding="utf-8").read()


def test_the_drive_first_absolute_is_gone():
    assert "- ALWAYS use drive_list FIRST" not in AGENT_SRC, (
        "an unconditional drive-first rule overrides data the agent already holds"
    )
    assert "When the data is NOT already in the request, ALWAYS use drive_list FIRST" in AGENT_SRC


def test_the_prompt_states_the_precedence():
    assert "The request's own data comes first" in AGENT_SRC
    assert "do not go looking for a file" in AGENT_SRC


def test_the_spreadsheet_rule_is_qualified():
    assert "spreadsheet you have not been given" in AGENT_SRC, (
        "this rule sent the agent to drive_list for a table it had been handed"
    )


def test_pasted_data_note_claims_precedence_over_the_drive():
    assert "is in the message above, not in a file" in ADAPTER_SRC
    assert "Do not run drive_list or drive_search looking for a file" in ADAPTER_SRC


def test_the_note_warns_about_the_agents_own_leftovers():
    assert "produced on an earlier run" in ADAPTER_SRC, (
        "the stale file is usually the agent's own output, which is why it looks right"
    )


def test_the_note_only_appears_when_a_table_really_is_pasted():
    """Grounded in a detector, not asserted unconditionally."""
    i = ADAPTER_SRC.index("def _describe_pasted_data")
    body = ADAPTER_SRC[i : i + 1400]
    assert "_find_pasted_table(text)" in body
    assert "if not table:" in body and 'return ""' in body
