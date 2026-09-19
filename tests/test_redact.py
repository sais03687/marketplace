"""Deployment records reach the browser without their credentials.

The behaviour is tested in test_redact.mjs so it runs the shipped function; this
file runs it under pytest (which is what CI runs) and checks both deployment
routes still pass their response through it.
"""
import io
import shutil
import subprocess
from pathlib import Path

import pytest

WEB = Path(__file__).resolve().parents[1] / "apps" / "web"
SCRIPT = Path(__file__).resolve().parent / "test_redact.mjs"


@pytest.mark.skipif(shutil.which("node") is None, reason="node is needed")
def test_the_redaction_behaves():
    r = subprocess.run(
        ["node", "--experimental-strip-types", str(SCRIPT)],
        capture_output=True, text=True, cwd=SCRIPT.parent.parent,
    )
    print(r.stdout or r.stderr)
    assert r.returncode == 0, r.stdout + r.stderr
    assert r.stdout.count("ok   ") >= 5, r.stdout


@pytest.mark.parametrize("route", ["deployments/route.ts", "deployments/[id]/route.ts"])
def test_both_deployment_routes_redact_their_response(route):
    src = io.open(WEB / "app" / "api" / route, encoding="utf-8").read()
    assert "jsonSuccess(redactSecrets(" in src, f"{route} returns the raw deployment row"
