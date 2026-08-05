"""Boundary regression: sender rules, recipient rules, action classification.

These are the checks that decide who the agent may write to, who may write to
it, and which guard runs for a given action. They are the security boundary, so
re-run this after touching adapter.py's allowlist logic or the action sets.

    scp scripts/boundary-regression.py root@<vps>:/tmp/
    ssh root@<vps> 'docker cp /tmp/boundary-regression.py <container>:/tmp/         && docker exec <container> python /tmp/boundary-regression.py'

It must run *inside* a container, because the answers depend on that
deployment's WORKSPACE_EMAIL, COMPANY_DOMAIN and MANAGER_EMAIL.

Functions are extracted from adapter.py by AST rather than imported: importing
starts FastAPI and reaches the network, whereas these are pure decision
functions and can be exercised directly.

Lives in the repo because the previous copy existed only at /tmp inside a
container and was lost to a restart, at which point there was no way to check a
security boundary except by reasoning about it.
"""
import ast, os, re, sys

src = open("/agent/adapter.py", encoding="utf-8").read()
tree = ast.parse(src)
lines = src.split("\n")

FUNCS = {"_agent_own_domain", "_share_recipient_allowed", "_sender_allowed", "_manager_email"}
CONSTS = {"SHARING_ACTIONS", "MAIL_INITIATING_ACTIONS", "MUTATING_ACTIONS"}
chunks = []
for node in tree.body:
    if isinstance(node, ast.FunctionDef) and node.name in FUNCS:
        chunks.append("\n".join(lines[node.lineno - 1:node.end_lineno]))
    if isinstance(node, ast.Assign) and any(
        isinstance(t, ast.Name) and t.id in CONSTS for t in node.targets):
        chunks.append("\n".join(lines[node.lineno - 1:node.end_lineno]))

ns = {
    "WORKSPACE_EMAIL": os.environ.get("WORKSPACE_EMAIL", ""),
    "AGENT_EMAIL": os.environ.get("AGENT_EMAIL", ""),
    "COMPANY_DOMAIN": os.environ.get("COMPANY_DOMAIN", ""),
    "MANAGER_EMAIL": os.environ.get("MANAGER_EMAIL", ""),
    "_manager_email_live": None, "re": re,
}
exec("\n\n".join(chunks), ns)

recipient = ns["_share_recipient_allowed"]
sender    = ns["_sender_allowed"]
MGR       = os.environ.get("MANAGER_EMAIL", "")
allow_empty = {"managerEmail": MGR, "allowedEmails": [], "companyDomain": "acme.com"}
allow_listed = {"managerEmail": MGR, "allowedEmails": ["partner@vendor.com"], "companyDomain": "acme.com"}

checks = []
def check(name, got, want):
    checks.append((name, got == want, got, want))

# ── Outbound recipients ──────────────────────────────────────────────────────
check("recipient: manager",                 recipient(MGR, allow_empty), True)
check("recipient: agent's own domain",      recipient("colleague@agents.agentstore.it.com", allow_empty), True)
check("recipient: company domain",          recipient("someone@acme.com", allow_empty), True)
check("recipient: stranger refused",        recipient("x@gmail.com", allow_empty), False)
check("recipient: lookalike suffix",        recipient("x@agents.agentstore.it.com.evil.com", allow_empty), False)
check("recipient: empty refused",           recipient("", allow_empty), False)
check("recipient: allowlisted partner",     recipient("partner@vendor.com", allow_listed), True)
check("recipient: unlisted vendor refused", recipient("other@vendor.com", allow_listed), False)

# ── Inbound senders: empty allowlist must mean organisation-only, not everyone
check("sender: manager may write",          sender(MGR, allow_empty), True)
check("sender: own domain may write",       sender("colleague@agents.agentstore.it.com", allow_empty), True)
check("sender: stranger may not",           sender("x@gmail.com", allow_empty), False)
check("sender: allowlisted may write",      sender("partner@vendor.com", allow_listed), True)

# ── Action classification drives which guard runs ────────────────────────────
check("email_send is mail-initiating",      "email_send" in ns["MAIL_INITIATING_ACTIONS"], True)
check("email_forward is mail-initiating",   "email_forward" in ns["MAIL_INITIATING_ACTIONS"], True)
check("email_reply is NOT (replies free)",  "email_reply" in ns["MAIL_INITIATING_ACTIONS"], False)
check("drive_share is sharing",             "drive_share" in ns["SHARING_ACTIONS"], True)
check("drive_create_link is sharing",       "drive_create_link" in ns["SHARING_ACTIONS"], True)
check("my_drive_share is sharing",          "my_drive_share" in ns["SHARING_ACTIONS"], True)
check("excel_write is mutating",            "excel_write" in ns["MUTATING_ACTIONS"], True)

failed = 0
for name, ok, got, want in checks:
    if not ok:
        failed += 1
    print(f"  {'ok  ' if ok else 'FAIL'} {name:38} got={got} want={want}")

print(f"\n{len(checks) - failed}/{len(checks)} passed")
sys.exit(1 if failed else 0)
