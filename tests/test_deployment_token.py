"""Naming a deployment is not the same as being one.

`/api/agentmind/contribute` took a `deploymentId` in the request body and checked
only that it existed and was ACTIVE. Nothing proved the caller was that
deployment, and an unauthenticated POST from outside the network reached the
handler on 2026-08-18.

What it reaches is the point. Contributions auto-approve by default, and search
serves APPROVED lessons to every deployment of an agent across every company —
the route's own comment says "a lesson written by one buyer reaches all of them".
So it was a way to put chosen text into other companies' agents, from anywhere.

The compare lives in test_deployment_token.mjs so it runs the shipped function.
The wiring is checked here, because the hole was never in the comparison — it was
in the four routes that never made one.
"""
import io
import shutil
import subprocess
from pathlib import Path

import pytest

WEB = Path(__file__).resolve().parents[1] / "apps" / "web"
AGENTMIND = WEB / "app" / "api" / "agentmind"
SCRIPT = Path(__file__).resolve().parent / "test_deployment_token.mjs"

ROUTES = ["contribute", "search", "use", "vote"]


@pytest.mark.skipif(shutil.which("node") is None, reason="node is needed")
def test_the_comparison_behaves():
    r = subprocess.run(
        ["node", "--experimental-strip-types", str(SCRIPT)],
        capture_output=True, text=True, cwd=SCRIPT.parent.parent,
    )
    print(r.stdout or r.stderr)
    assert r.returncode == 0, r.stdout + r.stderr
    assert r.stdout.count("ok   ") >= 6, r.stdout


@pytest.mark.parametrize("route", ROUTES)
def test_every_agentmind_route_authenticates_the_caller(route):
    src = io.open(AGENTMIND / route / "route.ts", encoding="utf-8").read()
    assert "requireDeploymentToken" in src, (
        f"{route} identifies the caller by a field they supply, which is not "
        "identification"
    )


@pytest.mark.parametrize("route", ROUTES)
def test_the_check_comes_before_the_work(route):
    """An unauthenticated caller must not reach the database or the model.

    Ordering matters beyond the write itself: the duplicate-detection in
    contribute embeds the submitted text before deciding anything, so a check
    that ran afterwards would still let a stranger spend an embedding call per
    request.
    """
    src = io.open(AGENTMIND / route / "route.ts", encoding="utf-8").read()
    auth = src.index("requireDeploymentToken(")
    for later in ("prisma.knowledgeContribution", "embedTexts(", "findNeighbours("):
        if later in src:
            assert auth < src.index(later), f"{route} does {later} before authenticating"


def test_the_token_is_never_compared_with_plain_equality():
    """The whole point of the shared helper.

    /approvals/auto-complete compared its token with `!==` while approval-link.ts
    next door used timingSafeEqual "so a token cannot be discovered a byte at a
    time". Both were about the same secret.
    """
    for path in list(AGENTMIND.rglob("route.ts")) + [
        WEB / "app" / "api" / "deployments" / "[id]" / "approvals" / "auto-complete" / "route.ts"
    ]:
        src = io.open(path, encoding="utf-8").read()
        assert "approvalWebhookToken !==" not in src, path
        assert "approvalWebhookToken ===" not in src, path


def test_an_unknown_deployment_and_a_wrong_token_are_not_distinguishable():
    """Otherwise the endpoint becomes a lookup service for valid ids.

    A 404 for "no such deployment" and a 403 for "wrong token" tells an
    unauthenticated caller which ids are real, which is the first half of the
    attack this defends against.
    """
    src = io.open(WEB / "lib" / "deployment-token.ts", encoding="utf-8").read()
    assert "Deployment not found" in src
    # The 404 is returned before any token comparison, so the two paths cannot be
    # told apart by timing either.
    assert src.index("Deployment not found") < src.index("tokensMatch(")
