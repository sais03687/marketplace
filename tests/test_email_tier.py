"""An agent with no buyer workspace must not be offered workspace tools.

Tested on 2026-09-17 and settled: Microsoft will not let an ordinary employee
consent to a file-reading scope. A role-less user in a real tenant was refused
with "Need admin approval", and publisher verification would not change it,
because the default low-impact classification is only openid / profile / email /
offline_access / User.Read. So every buyer whose IT will not sign off gets the
email tier, where work arrives as an attachment and leaves the same way.

Two reasons the tools are withheld rather than discouraged:

1. In email-tier mode the drive_* tools resolve against the PLATFORM tenant's
   SharePoint - shared infrastructure holding other buyers' agents. Advertising
   them is an isolation bug, not merely a dead end.
2. A tool the model is told not to use is a tool it uses eventually. E4 on
   2026-08-18 and T01 on 2026-09-17 were both a rule losing to a louder rule.
   One it was never handed, it cannot use.

The enum and the tool guide come from one list for the same reason the benchmark
harness got consolidated: two hand-maintained copies drift, and a tool removed
from one stays advertised in the other.
"""
import io
from pathlib import Path

import pytest

from creator import agent

AGENT_SRC = io.open(
    Path(__file__).resolve().parents[1] / "agents" / "data-analyst" / "agent.py",
    encoding="utf-8",
).read()


@pytest.fixture
def email_tier(monkeypatch):
    monkeypatch.setattr(agent, "_EMAIL_ONLY", True)


@pytest.fixture
def org_tier(monkeypatch):
    monkeypatch.setattr(agent, "_EMAIL_ONLY", False)


def test_email_tier_offers_no_workspace_actions(email_tier):
    offered = agent._action_types_for_prompt().split(" | ")
    leaked = sorted(set(offered) & agent._ORG_ONLY_ACTIONS)
    assert not leaked, f"email tier must not advertise {leaked}"


def test_email_tier_keeps_what_it_needs(email_tier):
    offered = agent._action_types_for_prompt().split(" | ")
    for essential in ("mcp_call", "reply_email", "send_email", "request_decision",
                      "remember", "none"):
        assert essential in offered, f"{essential} is how the email tier works at all"


def test_org_tier_is_unchanged(org_tier):
    offered = agent._action_types_for_prompt().split(" | ")
    assert set(agent._ALL_ACTIONS) == set(offered), (
        "the org tier must keep every action; this change is additive"
    )


def test_tool_guide_drops_the_same_rows(email_tier):
    table = agent._tools_table_for_prompt(agent._TOOLS_TABLE_ROWS)
    for gone in ("| drive_list |", "| drive_upload |", "| excel_read |",
                 "| sharepoint_read |"):
        assert gone not in table, f"{gone} still described to an agent that lacks it"
    for kept in ("| mcp_call |", "| reply_email |"):
        assert kept in table


def test_tool_guide_intact_on_org_tier(org_tier):
    assert agent._tools_table_for_prompt(agent._TOOLS_TABLE_ROWS) == agent._TOOLS_TABLE_ROWS


def test_the_enum_and_the_guide_cannot_disagree():
    """Every action in the list is described, and every row is a real action."""
    described = set()
    for line in agent._TOOLS_TABLE_ROWS.split("\n"):
        cells = line.split("|")
        if len(cells) > 1:
            described.add(cells[1].strip())
    for action in agent._ORG_ONLY_ACTIONS:
        assert action in agent._ALL_ACTIONS, f"{action} withheld but never offered"
    stray = described - set(agent._ALL_ACTIONS) - {"Action", "--------", ""}
    assert not stray, f"tool guide describes actions the enum lacks: {sorted(stray)}"


def test_delivery_rule_flips_with_the_tier(email_tier):
    rule = agent._delivery_rules_for_prompt()
    assert "SharePoint" not in rule.split("no SharePoint")[0], (
        "an email-tier agent must not be told to upload to SharePoint"
    )
    assert "Attach every deliverable" in rule
    assert "/tmp/input/" in rule, "it has to be told where attachments arrive"


def test_delivery_rule_unchanged_on_org_tier(org_tier):
    assert "Upload all deliverables to SharePoint" in agent._delivery_rules_for_prompt()


def test_missing_data_rule_does_not_send_it_hunting(email_tier):
    rule = agent._missing_data_rule_for_prompt()
    assert "drive_list" not in rule and "drive_search" not in rule
    assert "do not go looking" in rule


def test_execute_action_refuses_a_withheld_action():
    """The prompt is not the boundary; the node is."""
    assert "if not _action_available(action_type):" in AGENT_SRC
    assert "does not exist for you" in AGENT_SRC, (
        "the hand-back must name the substitute, or the turn is wasted"
    )


def test_availability_helper_is_tier_scoped(email_tier):
    assert not agent._action_available("drive_upload")
    assert agent._action_available("mcp_call")
    assert agent._action_available("reply_email")

def test_every_prompt_placeholder_is_supplied():
    """A placeholder with no kwarg is a KeyError on every single run.

    Three were added here (action_types, tools_table, delivery_rules) plus
    missing_data_rule, and the format call is forty lines away from the template.
    Nothing else catches this until a live run dies.
    """
    import re, string

    i = AGENT_SRC.index('REASONING_PROMPT = ' + '"""')
    j = AGENT_SRC.index('"""', i + 25)
    fields = {f for _, f, _, _ in string.Formatter().parse(AGENT_SRC[i:j]) if f}

    k = AGENT_SRC.index("prompt = REASONING_PROMPT.format(")
    call = AGENT_SRC[k:AGENT_SRC.index("\n    )", k)]
    supplied = set(re.findall(r"^\s{8}(\w+)=", call, re.M))

    assert not (fields - supplied), f"no value for {sorted(fields - supplied)}"
    assert not (supplied - fields), f"unused kwargs {sorted(supplied - fields)}"
