"""The read surfaces added this session must stay scoped to the caller's org.

Every dashboard read of a deployment's data — the deployment itself, its
approvals, its pushed memory — must resolve the row by (id AND companyId), so a
user in org B handing the API org A's deployment id gets a 404, not org A's data.
The agent-push endpoints (heartbeat, memory POST, approvals POST) authenticate
with the per-deployment token instead. These pin both, so a future edit that
drops the company scope or the token check fails here.
"""
from pathlib import Path

WEB = Path(__file__).resolve().parents[1] / "apps" / "web"


def _read(rel: str) -> str:
    return (WEB / "app" / "api" / rel).read_text(encoding="utf-8")


def test_deployment_get_is_company_scoped():
    src = _read("deployments/[id]/route.ts")
    assert "companyId: company.id" in src


def test_approvals_get_requires_deployment_access():
    src = _read("deployments/[id]/approvals/route.ts")
    get = src[src.index("export async function GET"): src.index("export async function POST")]
    assert "requireDeploymentAccess(id, company.id)" in get


def test_memory_get_requires_deployment_access_and_post_requires_token():
    src = _read("deployments/[id]/memory/route.ts")
    get = src[src.index("export async function GET"): src.index("export async function POST")]
    post = src[src.index("export async function POST"):]
    assert "requireDeploymentAccess(id, company.id)" in get
    assert "requireDeploymentToken(request, id)" in post


def test_heartbeat_post_requires_the_deployment_token():
    src = _read("deployments/[id]/heartbeat/route.ts")
    assert "requireDeploymentToken(request, id)" in src


def test_require_deployment_access_matches_on_company():
    src = (WEB / "lib" / "api-utils.ts").read_text(encoding="utf-8")
    fn = src[src.index("function requireDeploymentAccess"):]
    fn = fn[: fn.index("return { deployment }")]
    assert "id: deploymentId, companyId" in fn
    assert 'jsonError("Deployment not found", 404)' in fn
