"""Add what the platform needs to an existing project, without touching its code."""
from __future__ import annotations

import json
import re
from pathlib import Path

TODO = "TODO:"

AGENT_WRAPPER = '''"""Entry points the platform calls. Your own code stays where it is."""


async def run_agent(content: str, context: dict) -> dict:
    """Called for every email the agent receives.

    content: the email, as text (sender and subject lines first, then the body)
    context: sender, subject, thread_id and more
    Return the reply instead of sending it; the platform sends it.
    """
    # TODO: call your existing logic here, e.g.
    #   reply = await my_agent.handle(content)
    reply = "Replace this with your agent's answer."
    return {"action": "reply_email", "text": reply}


async def resume_agent(thread_id: str, resolution: dict, **tools) -> dict:
    """Called after the buyer approves or rejects something your run asked about."""
    return {"action": "none"}
'''


def _slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or "my-agent"


def init(folder: str) -> int:
    root = Path(folder).resolve()
    root.mkdir(parents=True, exist_ok=True)
    made, kept = [], []

    manifest = root / "marketplace.json"
    if manifest.exists():
        kept.append("marketplace.json")
    else:
        name = root.name.replace("-", " ").replace("_", " ").title()
        manifest.write_text(json.dumps({
            "name": name,
            "slug": _slug(root.name),
            "tagline": f"{TODO} one line a buyer reads first",
            "description": f"{TODO} what the agent does, in plain words — this becomes your public listing",
            "category": "GENERAL",
            "version": "0.1.0",
            "pricePerMonth": 29,
            "model": "openai/gpt-oss-120b",
            # Required by the validator; the upload recomputes it from the model's price.
            "modelTier": "standard",
            "runtime": "custom",
            "capabilities": [{"name": f"{TODO} capability", "description": f"{TODO} what it does"}],
            "requiredTools": ["email"],
            "requiredIntegrations": [],
            "autonomyDefaults": {"email_external": "always_queue", "email_internal": "auto_execute"},
        }, indent=2) + "\n", encoding="utf-8")
        made.append("marketplace.json")

    agent = root / "agent.py"
    if agent.exists():
        kept.append("agent.py")
        src = agent.read_text(encoding="utf-8")
        if "def run_agent" not in src or "def resume_agent" not in src:
            print("agent.py exists but does not define both entry points. Add these to it:\n")
            print(AGENT_WRAPPER)
    else:
        agent.write_text(AGENT_WRAPPER, encoding="utf-8")
        made.append("agent.py")

    reqs = root / "requirements.txt"
    if reqs.exists():
        kept.append("requirements.txt")
    else:
        reqs.write_text("openai\n", encoding="utf-8")
        made.append("requirements.txt")

    env = root / ".env"
    if not env.exists():
        env.write_text("# Your own key, for `agentstore test`. Never uploaded.\n"
                       "# An OpenRouter key (https://openrouter.ai/keys) runs the exact model you publish on.\n"
                       "OPENAI_API_KEY=\n", encoding="utf-8")
        made.append(".env")

    if made:
        print("Created: " + ", ".join(made))
    if kept:
        print("Left as they were: " + ", ".join(kept))
    print("\nNext:")
    print(f"  1. Fill in every {TODO} in marketplace.json — `agentstore check` refuses to pass while one is left")
    print("     Pick any text model from https://openrouter.ai/models for \"model\"")
    print("  2. Call your code from run_agent in agent.py, and delete any API key from your code")
    print("  3. agentstore check      — what will not work on the platform")
    print("  4. agentstore test \"a sample email\"   — run it as the platform would, on your key")
    print("  5. agentstore pack       — build the upload zip")
    return 0
