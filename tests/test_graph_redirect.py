"""Downloading a file from Graph means following a redirect.

Graph does not serve file bytes from /items/{id}/content. It answers 302 with a
Location pointing at a short-lived, pre-authenticated URL on a storage host.
httpx does not follow redirects unless told to, so the agent received a 302 with
an empty body: on 2026-08-14 drive_fetch asked for payments.csv three times in a
row and got nothing each time, until the repeat guard stopped the run.

Following it globally would be the wrong fix. `follow_redirects=True` on the
client applies to every call this transport makes, including the ones that
mutate — and a redirect on a POST replays the body at whatever the Location
says. So it is followed for GET only, and the platform's credential is not
carried to the target: that is a different origin, and the URL it hands back
already carries its own authorisation.
"""
import ast
import io
from pathlib import Path

import pytest

RUNTIME = (Path(__file__).resolve().parents[1] /
           "apps" / "provisioning-service" / "src" / "templates" / "runtime" / "adapter.py")
SRC = io.open(RUNTIME, encoding="utf-8").read()


def _graph_request_source() -> str:
    tree = ast.parse(SRC)
    for node in ast.walk(tree):
        if isinstance(node, ast.AsyncFunctionDef) and node.name == "graph_request":
            return ast.unparse(node)
    raise AssertionError("graph_request is gone")


def test_a_redirect_is_followed():
    body = _graph_request_source()
    assert "resp.headers.get('location')" in body or 'resp.headers.get("location")' in body, (
        "a file download returns 302 and the bytes are at the Location; without "
        "following it the agent gets an empty body and no file"
    )


def test_only_a_get_is_followed():
    body = _graph_request_source()
    i = body.index("301, 302, 303, 307, 308")
    guard = body[max(0, i - 200):i]
    assert "'GET'" in guard or '"GET"' in guard, (
        "following a redirect on a mutating call replays the body at the Location"
    )


def test_the_platform_credential_is_not_carried_to_the_redirect_target():
    body = _graph_request_source()
    i = body.index("301, 302, 303, 307, 308")
    after = body[i:i + 700]
    assert "follower.get(location)" in after
    # No headers argument at all on the followed request: the target is another
    # origin, and the pre-authenticated URL needs nothing from us.
    assert "follower.get(location, headers" not in after
    assert "Authorization" not in after


def test_redirects_are_not_switched_on_for_every_call():
    # The one-line version of this fix, and the reason it was not used.
    i = SRC.index("async def graph_request")
    body = SRC[i:i + 4000]
    assert "httpx.AsyncClient(timeout=30.0)" in body
    assert "follow_redirects=True) as client" not in body


def test_the_download_gets_longer_than_the_api_timeout():
    # 23.58 MB over a 30-second budget shared with the API call is not enough.
    body = _graph_request_source()
    i = body.index("301, 302, 303, 307, 308")
    assert "timeout=120.0" in body[i:i + 700]
