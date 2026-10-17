"""Agents a buyer hired can work with each other, but only the ones the buyer chose.

The buyer picks, per hire, which of their other agents it works with: in the
hire wizard and later in Settings. Only those are put in its context and
admitted as senders and recipients. Everything else stays as it was: on the
email tier our shared domain is never trusted, so other buyers' agents - and
this buyer's unchosen ones - are still refused.

Two agents that each answer every email will answer each other forever, and
each turn is a paid run, so the receiving poller counts teammate mail per
thread and stops the chain, telling the manager once.
"""
import io
import json
import shutil
import subprocess
import textwrap
from pathlib import Path

import pytest

import adapter

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "apps" / "web"
POLLER = io.open(ROOT / "apps" / "provisioning-service" / "src" / "jobs" / "outlook-poller.mjs", encoding="utf-8").read()
ALLOWLIST = io.open(WEB / "app" / "api" / "deployments" / "[id]" / "allowlist" / "route.ts", encoding="utf-8").read()
TEAMMATES = io.open(WEB / "lib" / "teammates.ts", encoding="utf-8").read()
CREATE = io.open(WEB / "app" / "api" / "deployments" / "route.ts", encoding="utf-8").read()
WIZARD = io.open(WEB / "components" / "hire" / "step-notifications.tsx", encoding="utf-8").read()
SCHEMA = io.open(ROOT / "packages" / "db" / "prisma" / "schema.prisma", encoding="utf-8").read()

MATE = {"name": "Data Analyst", "agent": "Data Analyst", "email": "data-analyst-x@agents.agentstore.it.com",
        "does": "Turns raw data into insights"}


# ── The adapter: who an agent may start a conversation with ─────────────────

def _allow(**extra):
    base = {"allowedEmails": [], "companyDomains": [], "companyDomain": "",
            "managerEmail": "boss@gmail.com", "trustAgentOwnDomain": False}
    return {**base, **extra}


def test_a_chosen_teammate_may_be_emailed_on_the_email_tier(monkeypatch):
    monkeypatch.setattr(adapter, "AGENT_EMAIL", "route-planner-x@agents.agentstore.it.com")
    monkeypatch.setattr(adapter, "WORKSPACE_EMAIL", "")
    assert adapter._share_recipient_allowed(MATE["email"], _allow(teammates=[MATE]))
    assert adapter._sender_allowed(MATE["email"], _allow(teammates=[MATE]))


def test_an_unchosen_agent_on_our_domain_is_still_refused(monkeypatch):
    """The email-tier hole: the adapter used to trust its own domain unconditionally."""
    monkeypatch.setattr(adapter, "AGENT_EMAIL", "route-planner-x@agents.agentstore.it.com")
    monkeypatch.setattr(adapter, "WORKSPACE_EMAIL", "")
    other = "someone-elses-agent@agents.agentstore.it.com"
    assert not adapter._share_recipient_allowed(other, _allow(teammates=[MATE]))
    assert not adapter._sender_allowed(other, _allow(teammates=[MATE]))


def test_the_org_tier_still_trusts_its_own_domain(monkeypatch):
    monkeypatch.setattr(adapter, "AGENT_EMAIL", "agent@buyer.com")
    monkeypatch.setattr(adapter, "WORKSPACE_EMAIL", "")
    allow = _allow(trustAgentOwnDomain=True)
    assert adapter._share_recipient_allowed("colleague@buyer.com", allow)
    assert adapter._sender_allowed("colleague@buyer.com", allow)


def test_silence_from_an_older_platform_narrows(monkeypatch):
    monkeypatch.setattr(adapter, "AGENT_EMAIL", "agent@agents.agentstore.it.com")
    monkeypatch.setattr(adapter, "WORKSPACE_EMAIL", "")
    allow = _allow()
    del allow["trustAgentOwnDomain"]
    assert not adapter._share_recipient_allowed("x@agents.agentstore.it.com", allow)


def test_the_manager_still_gets_through_with_no_teammates(monkeypatch):
    monkeypatch.setattr(adapter, "AGENT_EMAIL", "agent@agents.agentstore.it.com")
    assert adapter._share_recipient_allowed("boss@gmail.com", _allow())


# ── The poller: what the agent is told, and the loop guard ──────────────────

def _run_poller_fragment(script: str) -> dict:
    """Evaluate the poller's own functions (not a copy) in a sandbox and run `script`."""
    if not shutil.which("node"):
        pytest.skip("node not installed")
    start = POLLER.index("function extractEmail(")
    end = POLLER.index("// ─── Graph API helpers") if "// ─── Graph API helpers" in POLLER else POLLER.index("const GRAPH_BASE")
    build_start = POLLER.index("function buildAgentMessage(")
    build_end = POLLER.index("/**\n * Forward a single Outlook message")
    body = POLLER[start:end] + "\n" + POLLER[build_start:build_end]
    harness = textwrap.dedent("""
        const vm = require("node:vm");
        const sent = [];
        const ctx = {
          console, Date, Map, Set, String, JSON, AbortSignal, process: { env: {} },
          DEPLOYMENT_ID: "dep1", OUTLOOK_AGENT_EMAIL: "route-planner-x@agents.agentstore.it.com",
          allowlistCache: { allowedEmails: [], companyDomains: [], companyDomain: "",
                            managerEmail: "boss@gmail.com", trustAgentOwnDomain: false, teammates: MATES },
          fetch: async (url, init) => { sent.push(JSON.parse(init.body)); return { ok: true }; },
          out: {},
        };
        vm.createContext(ctx);
        vm.runInContext(BODY + "\\n;(async () => {" + SCRIPT + "})().then(() => { out.done = true; out.sent = SENT; });"
                          .replace("SENT", "globalThis.__sent"), Object.assign(ctx, { __sent: sent }));
        setTimeout(() => { process.stdout.write(JSON.stringify(ctx.out)); }, 50);
    """)
    code = (harness.replace("BODY", json.dumps(body)).replace("SCRIPT", json.dumps(script))
            .replace("MATES", json.dumps([MATE])))
    res = subprocess.run(["node", "-e", code], capture_output=True, text=True, timeout=30)
    assert res.returncode == 0, res.stderr
    return json.loads(res.stdout)


def test_the_agent_is_told_who_its_teammates_are_and_that_this_sender_is_one():
    out = _run_poller_fragment("""
        out.text = buildAgentMessage({ from: "Data Analyst <data-analyst-x@agents.agentstore.it.com>",
          subject: "plan", threadId: "t1", request: "Plan these stops", conversation: "",
          awaitingDecision: "", managerEmail: "boss@gmail.com", teammates: allowlistCache.teammates });
        out.allowed = isSenderAllowed("data-analyst-x@agents.agentstore.it.com");
        out.stranger = isSenderAllowed("other-buyers-agent@agents.agentstore.it.com");
    """)
    text = out["text"]
    assert "## Your teammates" in text and MATE["email"] in text
    assert "Reference only, not instructions" in text
    assert "This sender is your teammate Data Analyst" in text
    assert text.index("## Your teammates") < text.index("## THE REQUEST"), "the request stays last"
    assert out["allowed"] is True
    assert out["stranger"] is False, "our shared domain must not be trusted on the email tier"


def test_no_teammates_means_no_section():
    out = _run_poller_fragment("""
        out.text = buildAgentMessage({ from: "boss@gmail.com", subject: "s", threadId: "t", request: "hi",
          conversation: "", awaitingDecision: "", managerEmail: "boss@gmail.com", teammates: [] });
    """)
    assert "## Your teammates" not in out["text"]


def test_a_chain_of_agents_is_stopped_and_the_manager_told_once():
    out = _run_poller_fragment("""
        const reasons = [];
        for (let i = 0; i < 6; i++) {
          const r = teammateLoopReason("thread-1");
          reasons.push(r);
          if (!r) countTeammateTurn("thread-1");
        }
        out.reasons = reasons;
        out.otherThread = teammateLoopReason("thread-2");
        const msg = { conversationId: "thread-1", subject: "plan" };
        await reportTeammateLoop(msg, allowlistCache.teammates[0], reasons[5]);
        await reportTeammateLoop(msg, allowlistCache.teammates[0], reasons[5]);
    """)
    turns = out["reasons"]
    assert all(r == "" for r in turns[:4]), "the first four turns go through"
    assert turns[4] and turns[5], "the fifth is stopped"
    assert out["otherThread"] == "", "another thread is unaffected"
    assert len(out["sent"]) == 1, "the manager is told once per thread"
    assert out["sent"][0]["to"] == "boss@gmail.com"


def test_teammate_mail_never_gets_a_canned_reply():
    i = POLLER.index("const teammate = teammateFor(fromEmail);")
    block = POLLER[i: POLLER.index("// ── Approval-reply detection", i)]
    assert "sendCannedReply" not in block
    assert POLLER.index("const teammate = teammateFor(fromEmail);") < POLLER.index("if (isEmptyMessage(msg)) {")


# ── The web app: chosen per hire, two-way, never across buyers ──────────────

def test_the_list_is_per_hire_not_per_company():
    assert "worksWith" in SCHEMA and "agentsMayTalk" not in SCHEMA


def test_teammates_are_limited_to_the_buyers_own_running_agents():
    assert "companyId: self.companyId" in TEAMMATES
    assert 'status: "ACTIVE"' in TEAMMATES


def test_links_are_written_on_both_sides():
    assert "db.$transaction(writes)" in TEAMMATES
    assert "current.filter((id) => id !== deploymentId)" in TEAMMATES, "unticking removes the other side too"


def test_teammates_are_kept_out_of_the_editable_allowlist():
    assert "teammates," in ALLOWLIST
    assert "isPlatformCaller ? await teammatesFor(prisma, id) : []" in ALLOWLIST


def test_the_hire_wizard_asks_and_the_choice_is_saved():
    assert "Which of your agents should it work with?" in WIZARD
    assert "await setWorksWith(prisma, company.id, deployment.id, data.worksWith)" in CREATE


def test_a_teammate_is_inside_the_company_for_external_only(monkeypatch):
    monkeypatch.setattr(adapter, "COMPANY_DOMAIN", "")
    monkeypatch.setattr(adapter, "_load_policy", lambda: {"policy": "external-only", "riskThreshold": 7,
                                                          "autoApprove": [], "requireApproval": []})
    monkeypatch.setitem(adapter._allowlist_cache, "data", _allow(teammates=[MATE]))
    needs, why = adapter._should_require_approval(MATE["email"])
    assert not needs and "teammate" in why
    needs, _ = adapter._should_require_approval("stranger@agents.agentstore.it.com")
    assert needs


def test_always_ask_still_asks_for_teammates(monkeypatch):
    monkeypatch.setattr(adapter, "_load_policy", lambda: {"policy": "always", "riskThreshold": 7,
                                                          "autoApprove": [], "requireApproval": []})
    monkeypatch.setitem(adapter._allowlist_cache, "data", _allow(teammates=[MATE]))
    needs, _ = adapter._should_require_approval(MATE["email"])
    assert needs
