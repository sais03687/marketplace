"""`agentstore check` finds what will not work when an agent moves onto the platform.

The fixture is an agent as it might arrive from a creator's laptop: its own key,
its own inbox loop, a Slack post, a web server, a synchronous entry point. Each
problem must be reported at its line, and an agent already shaped for the
platform must come back clean, so the checker never teaches creators to ignore it.
"""
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "packages" / "agentstore-cli" / "src"))

from agentstore.check import ERROR, WARN, check  # noqa: E402

LAPTOP_AGENT = '''\
import imaplib
import os
import requests
from anthropic import Anthropic
from flask import Flask
from slack_sdk import WebClient
from openai import OpenAI

client = OpenAI(api_key="sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz012345")
claude = Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
app = Flask(__name__)

def run_agent(content, context):
    data = requests.get("https://api.example-crm.com/v1/contacts").json()
    answer = input("Approve? ")
    WebClient(token=os.environ.get("SLACK_TOKEN")).chat_postMessage(channel="#x", text=content)
    return {"action": "reply_email", "text": answer}
'''

CLEAN_AGENT = '''\
import asyncio
from openai import AsyncOpenAI

client = AsyncOpenAI()

async def run_agent(content: str, context: dict) -> dict:
    r = await client.chat.completions.create(model="gpt-4o", messages=[{"role": "user", "content": content}])
    return {"action": "reply_email", "text": r.choices[0].message.content}

async def resume_agent(thread_id: str, resolution: dict, **tools) -> dict:
    return {"action": "none"}
'''


def _agent(tmp_path, source, manifest=None, requirements="openai\n", extra=()):
    (tmp_path / "agent.py").write_text(source, encoding="utf-8")
    if manifest is not False:
        (tmp_path / "marketplace.json").write_text(json.dumps(manifest or {
            "name": "Triage", "slug": "triage", "version": "1.0.0", "model": "openai/gpt-oss-120b"}))
    if requirements is not None:
        (tmp_path / "requirements.txt").write_text(requirements)
    for name in extra:
        (tmp_path / name).write_text("x")
    return check(tmp_path)


def _at(findings, line, text, level=None):
    hits = [f for f in findings if f.line == line and text in f.message and (level is None or f.level == level)]
    assert hits, f"expected '{text}' at line {line}; got " + "; ".join(
        f"{f.line}:{f.message}" for f in findings)
    return hits[0]


def test_an_agent_already_shaped_for_the_platform_is_clean(tmp_path):
    assert _agent(tmp_path, CLEAN_AGENT) == []


def test_every_laptop_habit_is_reported_at_its_line(tmp_path):
    f = _agent(tmp_path, LAPTOP_AGENT)
    _at(f, 1, "imaplib", WARN)
    _at(f, 4, "Anthropic SDK", WARN)
    _at(f, 5, "Flask runs a server", WARN)
    _at(f, 6, "Slack is not reachable", WARN)
    _at(f, 9, "api_key= is set to a fixed value", ERROR)
    _at(f, 9, "OpenAI-style key", ERROR)
    _at(f, 10, "ANTHROPIC_API_KEY", WARN)
    _at(f, 14, "api.example-crm.com", WARN)
    _at(f, 15, "input()", WARN)


def test_entry_points_must_exist_and_be_async(tmp_path):
    f = _agent(tmp_path, LAPTOP_AGENT)
    _at(f, 13, "run_agent is not async", ERROR)
    assert any("does not define resume_agent" in x.message and x.level == ERROR for x in f)


def test_the_fix_for_a_key_never_repeats_the_key(tmp_path):
    f = _agent(tmp_path, LAPTOP_AGENT)
    for x in f:
        assert "AbCdEfGhIjKlMnOpQrStUvWxYz012345" not in x.message + x.fix


def test_package_files_the_upload_would_refuse(tmp_path):
    f = _agent(tmp_path, CLEAN_AGENT, requirements="openai\nagentstore==0.1.0\n",
               extra=("platform_llm.py", "MEMORY.md"))
    _at(f, 0, "platform_llm.py is supplied by the platform", ERROR)
    _at(f, 0, "MEMORY.md belongs to the buyer", ERROR)
    _at(f, 2, "agentstore is a tool for your machine", ERROR)


def test_a_missing_model_points_at_the_live_list(tmp_path):
    f = _agent(tmp_path, CLEAN_AGENT, manifest={"name": "T", "slug": "t", "version": "1.0.0"})
    hit = _at(f, 0, 'no "model" is named', WARN)
    assert "openrouter.ai/models" in hit.fix


def test_missing_manifest_and_agent_are_errors(tmp_path):
    assert any(x.file == "marketplace.json" and x.level == ERROR
               for x in _agent(tmp_path, CLEAN_AGENT, manifest=False))
    assert any(x.file == "agent.py" and x.level == ERROR for x in check(tmp_path / "nowhere"))


def test_graph_and_the_model_gateway_are_not_flagged(tmp_path):
    src = CLEAN_AGENT + '''
import httpx
def graph():
    return httpx.get("https://graph.microsoft.com/v1.0/me")
'''
    assert _agent(tmp_path, src) == []


def test_the_platforms_own_agents_pass():
    for folder in ("agents/data-analyst", "demo/release-notes", "demo/meeting-notes"):
        path = REPO / folder
        if path.exists():
            errors = [x for x in check(path) if x.level == ERROR]
            assert errors == [], f"{folder}: {errors}"
