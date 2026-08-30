"""AgentMind knowledge is scoped to the caller's own organization.

The buyer docs promise "AgentMind knowledge is scoped to your organisation — other
companies' data is never visible." The serve/search route filtered only by agentId
+ APPROVED, with NO company filter, so an approved lesson from one company was
served to every other company that hired the same agent — contradicting the docs.
This pins that the search route scopes to the caller's company. Contributions are
also PII-scrubbed and reviewed, but knowledge must not cross a company boundary.
"""
from pathlib import Path

WEB = Path(__file__).resolve().parents[1] / "apps" / "web"


def test_search_is_scoped_to_the_callers_company():
    src = (WEB / "app" / "api" / "agentmind" / "search" / "route.ts").read_text(encoding="utf-8")
    # The where clause must filter by the caller's company via the contributing
    # deployment's company.
    assert "deployment: { companyId: deployment.companyId }" in src
    # And it still requires the deployment token (auth) + APPROVED.
    assert "requireDeploymentToken(request, params.deploymentId)" in src
    assert 'status: "APPROVED"' in src


def test_contributions_list_stays_company_scoped():
    # The buyer-facing list was already org-scoped; guard it does not regress.
    src = (WEB / "app" / "api" / "agentmind" / "contributions" / "route.ts").read_text(encoding="utf-8")
    assert "companyId: company.id" in src
    assert "deploymentId: { in: deploymentIds }" in src
