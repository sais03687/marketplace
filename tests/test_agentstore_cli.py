"""agentstore init / test / pack, run offline against a fake model server.

`test` must behave like the platform: the email formatted as the platform
formats it, the manifest's model run whatever the code asks for, a held draft
approved or dropped rather than resumed. `pack` must build the zip the upload
expects and never include the creator's key. None of it may cost anything.
"""
import json
import sys
import threading
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "packages" / "agentstore-cli" / "src"))

from agentstore.check import ERROR, check  # noqa: E402
from agentstore.gateway import Gateway  # noqa: E402
from agentstore.init import init  # noqa: E402
from agentstore.pack import pack  # noqa: E402
from agentstore.run import run  # noqa: E402


@pytest.fixture
def fake_model():
    """An OpenAI-compatible server that echoes the model it was asked for and the prompt."""
    seen = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            seen.append(body)
            prompt = body["messages"][-1]["content"]
            reply = json.dumps({
                "id": "x", "object": "chat.completion", "created": 0, "model": body["model"],
                "choices": [{"index": 0, "finish_reason": "stop",
                             "message": {"role": "assistant", "content": f"MODEL={body['model']} SAW={prompt[:60]}"}}],
                "usage": {"prompt_tokens": 5, "completion_tokens": 5, "total_tokens": 10},
            }).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(reply)))
            self.end_headers()
            self.wfile.write(reply)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_address[1]}", seen
    server.shutdown()


def _agent(folder: Path, body: str, model="openai/gpt-oss-120b"):
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "agent.py").write_text(body, encoding="utf-8")
    (folder / "marketplace.json").write_text(json.dumps({
        "name": "T", "slug": "t", "version": "1.0.0", "model": model, "tagline": "t", "description": "t"}))
    (folder / "requirements.txt").write_text("openai\n")
    return folder


# Standard library only, so CI needs no SDK. It reads the two variables exactly as
# OpenAI's client does when built with no arguments, which is the behaviour under test.
OPENAI_AGENT = '''
import asyncio, json, os, urllib.request

def _complete(prompt):
    req = urllib.request.Request(
        os.environ["OPENAI_BASE_URL"].rstrip("/") + "/chat/completions",
        data=json.dumps({"model": "gpt-4o", "messages": [{"role": "user", "content": prompt}]}).encode(),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + os.environ["OPENAI_API_KEY"]})
    return json.loads(urllib.request.urlopen(req).read())["choices"][0]["message"]["content"]

async def run_agent(content: str, context: dict) -> dict:
    text = await asyncio.to_thread(_complete, content)
    return {"action": "reply_email", "text": text, "needs_approval": NEEDS}

async def resume_agent(thread_id: str, resolution: dict, **tools) -> dict:
    raise AssertionError("a held draft is approved or dropped, never resumed")
'''


def test_the_gateway_runs_the_manifests_model_whatever_the_code_asks(fake_model):
    import urllib.request
    url, seen = fake_model
    gw = Gateway(url, "openai/gpt-oss-120b", rewrite=True).start()
    try:
        req = urllib.request.Request(gw.url + "/chat/completions", method="POST",
                                     data=json.dumps({"model": "gpt-4o", "messages": [{"role": "user", "content": "hi"}]}).encode(),
                                     headers={"Content-Type": "application/json", "Authorization": "Bearer k"})
        urllib.request.urlopen(req).read()
    finally:
        gw.stop()
    assert seen[-1]["model"] == "openai/gpt-oss-120b"
    assert gw.calls == [{"asked": "gpt-4o", "ran": "openai/gpt-oss-120b", "status": 200, "tokens": 10}]


def test_test_runs_the_agent_as_the_platform_would(tmp_path, fake_model, monkeypatch, capsys):
    url, seen = fake_model
    monkeypatch.setenv("OPENAI_API_KEY", "creator-own-key")
    monkeypatch.setenv("OPENAI_BASE_URL", url)
    folder = _agent(tmp_path / "a", OPENAI_AGENT.replace("NEEDS", "False"))
    code = run(str(folder), "Where is my order?", "Dana <dana@x.com>", "Order", [], None)
    out = capsys.readouterr().out
    assert code == 0
    assert "Action: reply_email" in out
    # The email reaches the agent formatted the way the platform formats it.
    assert seen[-1]["messages"][-1]["content"].startswith("New email from Dana <dana@x.com>\nSubject: Order")
    assert "Model calls: 1 (1 succeeded)" in out


def test_without_the_creators_own_key_nothing_runs(tmp_path, monkeypatch, capsys):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.chdir(tmp_path)
    folder = _agent(tmp_path / "a", OPENAI_AGENT.replace("NEEDS", "False"))
    assert run(str(folder), "hi", "a@b.c", "s", [], None) == 2
    assert "never Agentstore's" in capsys.readouterr().out


def test_a_held_draft_is_approved_or_dropped_not_resumed(tmp_path, fake_model, monkeypatch, capsys):
    url, _ = fake_model
    monkeypatch.setenv("OPENAI_API_KEY", "k")
    monkeypatch.setenv("OPENAI_BASE_URL", url)
    folder = _agent(tmp_path / "a", OPENAI_AGENT.replace("NEEDS", "True"))
    assert run(str(folder), "refund please", "a@b.c", "s", [], "no") == 0
    assert "would not send it" in capsys.readouterr().out


def test_text_attachments_are_inlined_like_the_platform_does(tmp_path, fake_model, monkeypatch):
    url, seen = fake_model
    monkeypatch.setenv("OPENAI_API_KEY", "k")
    monkeypatch.setenv("OPENAI_BASE_URL", url)
    data = tmp_path / "sales.csv"
    data.write_text("region,total\nWest,10\n")
    folder = _agent(tmp_path / "a", OPENAI_AGENT.replace("NEEDS", "False"))
    run(str(folder), "total?", "a@b.c", "s", [str(data)], None)
    sent = seen[-1]["messages"][-1]["content"]
    assert "=== ATTACHMENTS ON THIS EMAIL ===" in sent and "West,10" in sent


def test_pack_builds_a_flat_zip_without_the_key(tmp_path, capsys):
    folder = _agent(tmp_path / "a", "async def run_agent(content, context):\n    return {}\n"
                                    "async def resume_agent(t, r, **k):\n    return {}\n")
    (folder / ".env").write_text("OPENAI_API_KEY=sk-or-v1-secret")
    (folder / "__pycache__").mkdir()
    (folder / "__pycache__" / "agent.cpython-312.pyc").write_bytes(b"x")
    (folder / "helpers.py").write_text("X = 1\n")
    assert pack(str(folder)) == 0
    names = set(zipfile.ZipFile(tmp_path / "t-1.0.0.zip").namelist())
    assert names == {"agent.py", "marketplace.json", "requirements.txt", "helpers.py"}


def test_pack_refuses_what_the_upload_would_refuse(tmp_path, capsys):
    folder = _agent(tmp_path / "a", "def run_agent(content, context):\n    return {}\n")
    assert pack(str(folder)) == 1
    assert not list(tmp_path.glob("*.zip"))


def test_init_adds_what_is_missing_and_leaves_the_rest(tmp_path, capsys):
    (tmp_path / "agent.py").write_text("# my existing agent\n")
    init(str(tmp_path))
    assert (tmp_path / "agent.py").read_text() == "# my existing agent\n"
    manifest = json.loads((tmp_path / "marketplace.json").read_text())
    assert manifest["modelTier"] and manifest["model"]
    assert (tmp_path / ".env").exists() and (tmp_path / "requirements.txt").exists()
    # The placeholders can never reach the marketplace as a listing.
    assert any(f.level == ERROR and "TODO" in f.message for f in check(tmp_path))


def test_the_bundled_platform_llm_is_the_platforms_own():
    bundled = REPO / "packages" / "agentstore-cli" / "src" / "agentstore" / "_platform" / "platform_llm.py"
    runtime = REPO / "apps" / "provisioning-service" / "src" / "templates" / "runtime" / "platform_llm.py"
    assert bundled.read_bytes().replace(b"\r\n", b"\n") == runtime.read_bytes().replace(b"\r\n", b"\n"), \
        "copy apps/.../runtime/platform_llm.py into packages/agentstore-cli/src/agentstore/_platform/"
