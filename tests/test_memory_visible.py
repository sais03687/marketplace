"""The buyer can see their agent's memory, and PRIVATE.md never gets there.

The Memory tab showed "Container unreachable" on every load and was hidden,
because the route proxied to the provisioning service and Vercel cannot reach a
container. Memory now travels the way approvals do: the agent pushes a snapshot
to the platform (authenticated with its deployment token), the snapshot is stored
on the Deployment, and the buyer reads the stored copy scoped to their own org.

The safety property that gates the whole thing: PRIVATE.md — the team roster and
internal detail — must never reach the dashboard. It is excluded at source (the
agent assembles only MEMORY.md and memory/*.md) and dropped again on the way in,
so it cannot arrive even if a future change to the agent forgets.
"""
import base64
import io
from pathlib import Path

import pytest

import adapter

ROUTE = (
    Path(__file__).resolve().parents[1]
    / "apps" / "web" / "app" / "api" / "deployments" / "[id]" / "memory" / "route.ts"
)
LAYOUT = (
    Path(__file__).resolve().parents[1]
    / "apps" / "web" / "app" / "(auth)" / "dashboard" / "agents" / "[deploymentId]" / "layout.tsx"
)


# ── the agent assembles only the buyer-safe files ──────────────────────────

@pytest.fixture
def workspace(tmp_path, monkeypatch):
    monkeypatch.setattr(adapter, "WORKSPACE_DIR", tmp_path)
    (tmp_path / "MEMORY.md").write_text("Acme closes books on the 5th.\n", encoding="utf-8")
    (tmp_path / "PRIVATE.md").write_text("Priya, priya@acme.com, Finance\n", encoding="utf-8")
    (tmp_path / "memory").mkdir()
    (tmp_path / "memory" / "clients.md").write_text("Fabrikam pays late.\n", encoding="utf-8")
    return tmp_path


def test_the_snapshot_carries_memory_but_never_private(workspace):
    snap = adapter._read_memory_for_snapshot()
    assert "MEMORY.md" in snap
    assert "memory/clients.md" in snap
    assert "PRIVATE.md" not in snap, "PRIVATE.md must never be assembled for the dashboard"
    # and its content must not have leaked under any key
    assert all("priya@acme.com" not in v for v in snap.values())


def test_the_snapshot_is_the_same_allowlist_the_internal_endpoint_serves():
    # If /internal/memory grows a source, the push must grow with it, not silently
    # diverge into showing something the endpoint deliberately withholds.
    src = io.open(Path(adapter.__file__), encoding="utf-8").read()
    reader = src[src.index("def _read_memory_for_snapshot"):]
    reader = reader[: reader.index("async def _push_memory_snapshot")]
    assert 'WORKSPACE_DIR / "MEMORY.md"' in reader
    assert 'WORKSPACE_DIR / "memory"' in reader
    # The word appears in the docstring explaining it is excluded. What matters
    # is that no line of *code* reads it - no PRIVATE.md path is ever opened.
    # Strip the docstring (a multi-line triple-quoted block) and comments, then
    # assert no remaining code line touches PRIVATE.md.
    import re
    body = re.sub(r'"""[\s\S]*?"""', "", reader)
    code = chr(10).join(l for l in body.splitlines() if not l.lstrip().startswith("#"))
    assert "PRIVATE" not in code, "a code line touches PRIVATE.md"


def test_an_empty_workspace_pushes_an_empty_snapshot(tmp_path, monkeypatch):
    monkeypatch.setattr(adapter, "WORKSPACE_DIR", tmp_path)
    assert adapter._read_memory_for_snapshot() == {}


def test_the_push_authenticates_with_the_deployment_token():
    src = io.open(Path(adapter.__file__), encoding="utf-8").read()
    fn = src[src.index("async def _push_memory_snapshot"):][:1200]
    assert "client.post(" in fn
    assert "/memory" in fn
    assert "Bearer" in fn and "APPROVAL_TOKEN" in fn


def test_it_pushes_on_the_same_loop_as_the_setup_sync():
    src = io.open(Path(adapter.__file__), encoding="utf-8").read()
    loop = src[src.index("_setup_answer_loop"):][:400]
    assert "_push_memory_snapshot()" in loop


# ── the route: agent writes with a token, buyer reads scoped to their org ───

def test_the_write_requires_the_deployment_token():
    src = io.open(ROUTE, encoding="utf-8").read()
    post = src[src.index("export async function POST"):]
    assert "requireDeploymentToken(request, id)" in post
    # A person's session must not be able to write memory.
    assert "requireOrg" not in post[: post.index("prisma.deployment.update")]


def test_the_read_is_scoped_to_the_callers_org():
    src = io.open(ROUTE, encoding="utf-8").read()
    get = src[src.index("export async function GET"):src.index("export async function POST")]
    assert "requireDeploymentAccess(id, company.id)" in get


def test_the_route_drops_private_md_even_if_it_arrives():
    # Belt and braces: the agent excludes it, and the route excludes it again, so
    # a future agent change that forgot could not leak it through the stored copy.
    src = io.open(ROUTE, encoding="utf-8").read()
    assert 'base === "PRIVATE.md"' in src
    assert "continue;" in src[src.index('base === "PRIVATE.md"'):][:60]


def test_the_route_no_longer_proxies_to_the_container():
    # The old failure mode. Vercel cannot reach the container; the proxy always
    # returned "Container unreachable".
    src = io.open(ROUTE, encoding="utf-8").read()
    # Both strings appear in the comment explaining what this route used to do.
    # The property is that no code does it: no proxy fetch, no path that returns
    # "Container unreachable".
    code = chr(10).join(
        l for l in src.splitlines()
        if not l.lstrip().startswith("*") and not l.lstrip().startswith("//")
        and not l.lstrip().startswith("/*")
    )
    assert "/proxy/" not in code
    assert "Container unreachable" not in code


def test_the_memory_tab_is_visible_again():
    src = io.open(LAYOUT, encoding="utf-8").read()
    assert '{ slug: "/memory", label: "Memory" },' in src
    assert "// { slug: \"/memory\"" not in src
