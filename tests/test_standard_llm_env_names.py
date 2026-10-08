"""An agent written elsewhere as `OpenAI()` reaches the broker unchanged.

OpenAI's SDK and LangChain's ChatOpenAI read OPENAI_API_KEY and OPENAI_BASE_URL
when given no arguments. The runtime only ever set LLM_API_KEY / LLM_BASE_URL,
so code brought from outside had to be rewritten to name them before it could
reach a model. The runtime now mirrors them, and must mirror the *brokered*
values: the per-deployment token, never a provider key.

Each case starts the runtime in a fresh interpreter, because the variables are
set once, at import, before creator code loads.
"""
import json
import os
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
BROKER = "http://host.docker.internal:3003/internal/llm"
REAL_KEY = "sk-or-real-provider-key-must-not-reach-creator-code"

PROBE = f"""
import json, os, sys
sys.path.insert(0, {str(REPO / 'tests')!r})
_conftest = {str(REPO / 'tests' / 'conftest.py')!r}
exec(open(_conftest).read(), {{"__file__": _conftest, "__name__": "conftest"}})
import adapter
print(json.dumps({{k: os.environ.get(k) for k in
    ("OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_API_BASE", "LLM_API_KEY", "LLM_BASE_URL")}}))
"""


def _start_runtime(extra_env: dict) -> dict:
    env = {k: v for k, v in os.environ.items()
           if not k.startswith(("OPENAI_", "LLM_"))}
    env.update(extra_env)
    out = subprocess.run(
        [sys.executable, "-c", PROBE], env=env, capture_output=True, text=True, timeout=120,
    )
    assert out.returncode == 0, out.stderr[-2000:]
    return json.loads(out.stdout.strip().splitlines()[-1])


def test_brokered_agent_gets_the_broker_under_the_standard_names():
    seen = _start_runtime({
        "LLM_BROKER_URL": BROKER,
        "LLM_BASE_URL": "https://openrouter.ai/api/v1",
        "LLM_API_KEY": REAL_KEY,
        "DEPLOYMENT_ID": "dep123",
        "AGENT_TOKEN": "tok456",
    })
    assert seen["OPENAI_BASE_URL"] == BROKER
    assert seen["OPENAI_API_BASE"] == BROKER
    assert seen["OPENAI_API_KEY"] == "dep123.tok456"
    assert REAL_KEY not in json.dumps(seen)


def test_a_leftover_openai_key_in_the_environment_is_replaced():
    seen = _start_runtime({
        "LLM_BROKER_URL": BROKER,
        "LLM_API_KEY": "brokered-see-adapter",
        "DEPLOYMENT_ID": "dep123",
        "AGENT_TOKEN": "tok456",
        "OPENAI_API_KEY": "sk-proj-creator-left-this-behind",
        "OPENAI_BASE_URL": "https://api.openai.com/v1",
    })
    assert seen["OPENAI_API_KEY"] == "dep123.tok456"
    assert seen["OPENAI_BASE_URL"] == BROKER


def test_an_unbrokered_agent_gets_the_same_values_under_both_names():
    seen = _start_runtime({
        "LLM_BASE_URL": "https://openrouter.ai/api/v1",
        "LLM_API_KEY": "direct-key",
    })
    assert seen["OPENAI_BASE_URL"] == seen["LLM_BASE_URL"] == "https://openrouter.ai/api/v1"
    assert seen["OPENAI_API_KEY"] == seen["LLM_API_KEY"] == "direct-key"


def test_nothing_is_invented_when_there_is_no_model_endpoint():
    seen = _start_runtime({"LLM_API_KEY": "only-a-key"})
    assert seen["OPENAI_BASE_URL"] is None
    assert seen["OPENAI_API_KEY"] is None
