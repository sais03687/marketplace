"""An agent declares what it reaches, and is held to it.

The platform holds broad Microsoft 365 permissions — files, mail, calendar, the
directory — and every agent inherited all of them. A buyer had no way to tell an
agent that reads spreadsheets from one that could rewrite their directory, and
nothing stopped the second from doing it.

So the manifest declares scopes. They are shown on the listing before anyone
pays, in the buyer's language, and the adapter refuses a Graph call outside them.

Declaring is optional and omitting it changes no behaviour: every agent published
before this existed keeps working. What omitting it does is say so on the listing,
where buyers are comparing.

This stops a rogue agent, not a rogue platform — the credential is still the
platform's. Per-agent app registrations would be the other thing, and are not
this.
"""
import json
import re
import subprocess
import shutil
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
ADAPTER = ROOT / "apps" / "provisioning-service" / "src" / "templates" / "runtime" / "adapter.py"
TYPES = ROOT / "packages" / "agent-package-schema" / "src" / "types.ts"
VALIDATE = ROOT / "packages" / "agent-package-schema" / "src" / "validate.ts"
LISTING = ROOT / "apps" / "web" / "app" / "(public)" / "agents" / "[slug]" / "page.tsx"
UPLOAD = ROOT / "apps" / "web" / "app" / "api" / "packages" / "upload" / "route.ts"
PROVISION = ROOT / "apps" / "provisioning-service" / "src" / "jobs" / "provision.ts"

needs_python = pytest.mark.skipif(shutil.which("python") is None, reason="python needed")


def scope_for(method: str, path: str, declared: str = ""):
    """Drive the adapter's own _required_scope / _enforce_declared_scope."""
    src = ADAPTER.read_text(encoding="utf-8")

    def grab(name):
        start = src.index(f"def {name}(")
        end = src.index("\ndef ", start + 1)
        return src[start:end]

    # Assembled line by line rather than dedented: the grabbed function bodies
    # start at column 0, so the common indent is zero and dedent does nothing.
    harness = "\n".join([
        "import os, json",
        f"os.environ['GRAPH_SCOPES'] = {json.dumps(declared)}",
        "class ActionRefused(RuntimeError): pass",
        "_DECLARED_SCOPES = {s.strip() for s in os.environ.get('GRAPH_SCOPES','').split(',') if s.strip()}",
        grab("_required_scope"),
        grab("_enforce_declared_scope"),
        f"scope = _required_scope({json.dumps(method)}, {json.dumps(path)})",
        "try:",
        f"    _enforce_declared_scope({json.dumps(method)}, {json.dumps(path)})",
        "    refused = None",
        "except ActionRefused as e:",
        "    refused = str(e)",
        "print(json.dumps({'scope': scope, 'refused': refused}))",
    ])
    proc = subprocess.run(["python", "-c", harness], capture_output=True, text=True, timeout=60)
    assert proc.returncode == 0, proc.stderr
    return json.loads(proc.stdout)


@needs_python
@pytest.mark.parametrize("method,path,expected", [
    ("GET", "/users/a@b.c/drive/items/1/workbook/worksheets", "excel.read"),
    ("PATCH", "/users/a@b.c/drive/items/1/workbook/worksheets/S/range", "excel.write"),
    ("GET", "/users/a@b.c/drive/root/children", "files.read"),
    ("PUT", "/users/a@b.c/drive/items/1/content", "files.write"),
    ("POST", "/users/a@b.c/drive/items/1/invite", "files.share"),
    ("POST", "/users/a@b.c/sendMail", "mail.send"),
    ("GET", "/users/a@b.c/messages", "mail.read"),
    ("GET", "/users/a@b.c/calendarView", "calendar.read"),
    ("POST", "/users/a@b.c/events", "calendar.write"),
    ("GET", "/users/a@b.c/manager", "directory.read"),
])
def test_each_kind_of_call_maps_to_the_scope_a_buyer_would_expect(method, path, expected):
    assert scope_for(method, path)["scope"] == expected


@needs_python
def test_a_mailbox_is_not_filed_as_a_directory_lookup():
    # /users/{id}/messages contains "/users". Matching that first would let an
    # agent that asked only to look people up read everyone's mail.
    assert scope_for("GET", "/users/a@b.c/messages")["scope"] == "mail.read"
    assert scope_for("GET", "/users/a@b.c/drive/root")["scope"] == "files.read"


@needs_python
def test_sharing_is_its_own_scope_not_merely_writing():
    # Sharing sends data out of the tenant; writing does not. A buyer agreeing to
    # one has not agreed to the other.
    assert scope_for("POST", "/users/a@b.c/drive/items/1/createLink")["scope"] == "files.share"


@needs_python
def test_an_undeclared_call_is_refused_and_says_what_was_missing():
    got = scope_for("PUT", "/users/a@b.c/drive/items/1/content", declared="files.read")
    assert got["refused"], "a write must be refused when only reading was declared"
    assert "files.write" in got["refused"]
    assert "graphScopes" in got["refused"], "the refusal should say how to fix it"


@needs_python
def test_a_declared_call_passes():
    assert scope_for("PUT", "/users/a@b.c/drive/items/1/content",
                     declared="files.read,files.write")["refused"] is None


@needs_python
def test_declaring_nothing_enforces_nothing():
    # Every agent published before this field existed has to keep working.
    assert scope_for("PUT", "/users/a@b.c/drive/items/1/content")["refused"] is None
    assert scope_for("POST", "/users/a@b.c/sendMail")["refused"] is None


@needs_python
def test_an_unmapped_path_is_not_refused():
    # The vocabulary is small on purpose. A genuinely novel call — Planner, To Do
    # — matches no scope, and refusing it here would punish creators for using
    # Graph we simply have not named. An unclassified write still needs a human.
    got = scope_for("POST", "/planner/tasks", declared="files.read")
    assert got["scope"] is None
    assert got["refused"] is None


def test_the_gate_runs_before_the_approval_policy():
    # Otherwise an undeclared capability becomes a prompt, and the buyer is asked
    # to permit something the listing told them was not needed.
    src = ADAPTER.read_text(encoding="utf-8")
    body = src[src.index("async def graph_request("):]
    assert body.index("_enforce_declared_scope") < body.index("_classify_graph_call")


def test_buyers_are_shown_words_not_scope_strings():
    types = TYPES.read_text(encoding="utf-8")
    assert "GRAPH_SCOPE_LABELS" in types
    assert "Read files in your workspace" in types
    listing = LISTING.read_text(encoding="utf-8")
    assert "GRAPH_SCOPE_LABELS" in listing
    assert "What this agent can reach" in listing


def test_declaring_nothing_and_declaring_none_read_differently_to_a_buyer():
    listing = LISTING.read_text(encoding="utf-8")
    assert "has not declared what it accesses" in listing
    assert "It works only from what you email it." in listing


def test_an_unknown_scope_fails_at_upload():
    validate = VALIDATE.read_text(encoding="utf-8")
    assert "graphScopes" in validate
    assert "unknown scope" in validate


def test_the_declaration_reaches_the_container_and_the_database():
    assert "GRAPH_SCOPES:" in PROVISION.read_text(encoding="utf-8")
    upload = UPLOAD.read_text(encoding="utf-8")
    # DbNull, not undefined: undefined leaves a stale declaration in place after
    # a creator removes the field.
    assert "graphScopes: manifest.graphScopes ?? Prisma.DbNull" in upload
    assert len(re.findall(r"graphScopes: manifest\.graphScopes", upload)) == 2, \
        "both the create and the update path must persist it"


def test_creators_are_told_how_and_why_to_declare():
    docs = (ROOT / "apps" / "web" / "app" / "(public)" / "docs" / "creators"
            / "page.tsx").read_text(encoding="utf-8")
    assert "constraints-scopes" in docs
    assert "graphScopes" in docs
    # The honest limit, stated where creators will read it: this binds their code,
    # not the platform's credential, so they must not sell it as isolation.
    assert "binds your agent, not the platform" in docs
    # And the incentive to declare, which is the whole mechanism.
    assert "has not declared" in docs
