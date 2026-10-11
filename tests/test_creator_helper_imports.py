"""Creator code can import its own helper modules on the platform, as it does locally.

`agentstore test` puts the agent's folder on sys.path, so `from helpers import x`
beside agent.py works on the creator's machine. The adapter imported the code
as the `creator` package without that, so the same import failed at startup on
the platform, after vetting had built the image. This runs the real layout —
adapter.py beside a creator/ folder — in a fresh interpreter.
"""
import os
import shutil
import subprocess
import sys
from pathlib import Path

RUNTIME = Path(__file__).resolve().parents[1] / "apps" / "provisioning-service" / "src" / "templates" / "runtime"


def test_a_helper_beside_agent_py_imports_on_the_platform(tmp_path):
    shutil.copy(RUNTIME / "adapter.py", tmp_path / "adapter.py")
    shutil.copy(RUNTIME / "platform_llm.py", tmp_path / "platform_llm.py")
    creator = tmp_path / "creator"
    creator.mkdir()
    (creator / "helpers.py").write_text("GREETING = 'hello from a helper'\n")
    (creator / "agent.py").write_text(
        "from helpers import GREETING\n"
        "async def run_agent(content, context):\n    return {'action': 'reply_email', 'text': GREETING}\n"
        "async def resume_agent(thread_id, resolution, **tools):\n    return {'action': 'none'}\n"
    )
    env = {**os.environ, "AGENT_DATA_ROOT": str(tmp_path / "data"), "LLM_API_KEY": "test-not-a-real-key",
           "LLM_MODEL": "test-model", "AGENT_HOOKS_TOKEN": "t", "APPROVAL_WEBHOOK_TOKEN": "t",
           "DEPLOYMENT_ID": "test", "AGENT_EMAIL": "a@b.c", "MANAGER_EMAIL": "m@b.c"}
    probe = "import adapter, creator.agent; print(creator.agent.GREETING)"
    done = subprocess.run([sys.executable, "-c", probe], cwd=tmp_path, env=env,
                          capture_output=True, text=True, timeout=120)
    assert done.returncode == 0, done.stderr[-2000:]
    assert "hello from a helper" in done.stdout
