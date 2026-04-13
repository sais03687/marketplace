"""Build test zip packages for MVP demo testing."""
import zipfile
import json
import os
import shutil
from pathlib import Path

OUT = Path(__file__).parent
AGENTS_DIR = Path(__file__).parent.parent / "agents"


def make_zip(name: str, files: dict[str, str | bytes]):
    """Create a zip from a dict of {filename: content}."""
    path = OUT / f"{name}.zip"
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        for fname, content in files.items():
            if isinstance(content, str):
                zf.writestr(fname, content)
            else:
                zf.writestr(fname, content)
    print(f"  Created: {path} ({len(files)} files)")
    return path


def zip_from_dir(name: str, src_dir: Path, manifest_overrides: dict = None):
    """Zip an existing directory, optionally overriding manifest fields."""
    files = {}
    for fpath in src_dir.rglob("*"):
        if fpath.is_file() and "__pycache__" not in str(fpath):
            rel = fpath.relative_to(src_dir).as_posix()
            files[rel] = fpath.read_bytes()

    if manifest_overrides and "marketplace.json" in files:
        manifest = json.loads(files["marketplace.json"])
        manifest.update(manifest_overrides)
        files["marketplace.json"] = json.dumps(manifest, indent=2)

    return make_zip(name, files)


# ─── 1. Custom Runtime (LangChain) with fresh slug ──────────────────────────
print("\n1. Custom Runtime Agent (LangChain)")

# Read the original agent.py and patch it to include approval_id in results
agent_py = (AGENTS_DIR / "langchain-starter" / "agent.py").read_text()

# Patch: add approval_id to the result dicts in handle_approval
agent_py_patched = agent_py.replace(
    '            "approval_resolution": resolution,\n        }\n    elif resolution.get("status") == "EDITED":',
    '            "approval_id": state.approval_id,\n            "approval_resolution": resolution,\n        }\n    elif resolution.get("status") == "EDITED":',
)
agent_py_patched = agent_py_patched.replace(
    '            "approval_resolution": resolution,\n        }\n    else:',
    '            "approval_id": state.approval_id,\n            "approval_resolution": resolution,\n        }\n    else:',
    1,  # only second occurrence
)

# Build from directory but override slug and use patched agent.py
files = {}
src = AGENTS_DIR / "langchain-starter"
for fpath in src.rglob("*"):
    if fpath.is_file() and "__pycache__" not in str(fpath):
        rel = fpath.relative_to(src).as_posix()
        files[rel] = fpath.read_bytes()

# Override manifest
manifest = json.loads(files["marketplace.json"])
manifest["slug"] = "test-langchain-agent"
manifest["name"] = "Test LangChain Agent"
manifest["version"] = "1.0.0"
manifest["pricePerMonth"] = 9900
manifest["modelTier"] = "sonnet"
files["marketplace.json"] = json.dumps(manifest, indent=2)

# Use patched agent.py
files["agent.py"] = agent_py_patched

make_zip("test-custom-langchain", files)


# ─── 2. OpenClaw Runtime (v5-style) with fresh slug ─────────────────────────
print("\n2. OpenClaw Runtime Agent (v5-style)")

zip_from_dir(
    "test-openclaw-alex",
    AGENTS_DIR / "v5-agent-package",
    manifest_overrides={
        "slug": "test-openclaw-alex",
        "name": "Test Alex — General Ops",
        "version": "1.0.0",
        "pricePerMonth": 4900,
        "modelTier": "haiku",
        "runtime": "openclaw",
    },
)


# ─── 3. Minimal Custom Agent (simplest possible) ────────────────────────────
print("\n3. Minimal Custom Agent")

minimal_agent_py = '''"""Minimal agent for testing the platform contract."""

async def run_agent(content, context, approve_fn=None, resolve_fn=None,
                    contribute_fn=None, search_fn=None):
    """Echo agent — returns the message as a no-action response."""
    print(f"[minimal-agent] Received: {content[:100]}")
    print(f"[minimal-agent] Context: {context.get('hook_name')}, {context.get('session_key')}")
    return {
        "action": "none",
        "text": f"Received and processed: {content[:200]}",
    }
'''

minimal_manifest = {
    "name": "Minimal Test Agent",
    "slug": "test-minimal-agent",
    "tagline": "Simplest possible custom agent for testing.",
    "description": "A minimal echo agent that tests the platform adapter contract. Does not send emails or request approvals.",
    "category": "GENERAL",
    "version": "1.0.0",
    "pricePerMonth": 9900,
    "modelTier": "sonnet",
    "runtime": "custom",
    "capabilities": [
        {"name": "Echo", "description": "Echoes back received messages for testing"}
    ],
    "requiredTools": [],
    "requiredIntegrations": [],
    "onboardingDurationDays": 1,
    "autonomyDefaults": {},
}

make_zip("test-minimal-custom", {
    "agent.py": minimal_agent_py,
    "marketplace.json": json.dumps(minimal_manifest, indent=2),
    "requirements.txt": "# no extra deps needed\n",
    "SOUL.md": "# Minimal Test Agent\n\nYou are a simple test agent. Acknowledge messages politely.\n",
    "AGENTS.md": "# Behavioral Rules\n\n- Always respond politely\n- Never send emails without approval\n",
    "TOOLS.md": "# Tools\n\nNo external tools configured.\n",
    "onboarding/questions.json": json.dumps([
        {
            "id": "q1",
            "order": 1,
            "question": "What is your name?",
            "memoryKey": "user_name",
            "required": True,
        },
        {
            "id": "q2",
            "order": 2,
            "question": "What does your company do?",
            "memoryKey": "company_description",
            "required": False,
        },
    ], indent=2),
    "onboarding/MEMORY_TEMPLATE.md": "# Agent Memory\n\n## User\n- Name: {{user_name}}\n- Company: {{company_description}}\n",
})


# ─── 4. Security Test: Reserved file (adapter.py) ───────────────────────────
print("\n4. Security Test: Reserved File")

make_zip("test-SHOULD-FAIL-reserved-file", {
    "agent.py": "async def run_agent(**kwargs): return {'action': 'none'}\n",
    "adapter.py": "# EVIL: trying to overwrite platform adapter\n",
    "marketplace.json": json.dumps({
        "name": "Evil Agent",
        "slug": "test-evil-reserved",
        "tagline": "Should be rejected",
        "description": "Contains adapter.py which should be blocked",
        "category": "GENERAL",
        "version": "1.0.0",
        "pricePerMonth": 9900,
        "modelTier": "sonnet",
        "runtime": "custom",
        "capabilities": [{"name": "Test", "description": "Test"}],
        "requiredTools": [],
        "requiredIntegrations": [],
        "onboardingDurationDays": 1,
        "autonomyDefaults": {},
    }, indent=2),
    "requirements.txt": "",
    "SOUL.md": "",
    "AGENTS.md": "",
    "TOOLS.md": "",
})


# ─── 5. Security Test: Shadow module (httpx.py) ─────────────────────────────
print("\n5. Security Test: Shadow Module")

make_zip("test-SHOULD-FAIL-shadow-module", {
    "agent.py": "async def run_agent(**kwargs): return {'action': 'none'}\n",
    "httpx.py": "# EVIL: shadows the real httpx library\nclass Client: pass\n",
    "marketplace.json": json.dumps({
        "name": "Shadow Agent",
        "slug": "test-evil-shadow",
        "tagline": "Should be rejected",
        "description": "Contains httpx.py which shadows a system module",
        "category": "GENERAL",
        "version": "1.0.0",
        "pricePerMonth": 9900,
        "modelTier": "sonnet",
        "runtime": "custom",
        "capabilities": [{"name": "Test", "description": "Test"}],
        "requiredTools": [],
        "requiredIntegrations": [],
        "onboardingDurationDays": 1,
        "autonomyDefaults": {},
    }, indent=2),
    "requirements.txt": "",
    "SOUL.md": "",
    "AGENTS.md": "",
    "TOOLS.md": "",
})


# ─── 6. Security Test: Under-priced opus agent ──────────────────────────────
print("\n6. Security Test: Under-Priced Opus")

make_zip("test-SHOULD-FAIL-cheap-opus", {
    "agent.py": "async def run_agent(**kwargs): return {'action': 'none'}\n",
    "marketplace.json": json.dumps({
        "name": "Cheap Opus Agent",
        "slug": "test-evil-cheap-opus",
        "tagline": "Should be rejected — too cheap for opus",
        "description": "Opus tier agent priced at $5/month — should be rejected",
        "category": "GENERAL",
        "version": "1.0.0",
        "pricePerMonth": 500,
        "modelTier": "opus",
        "runtime": "custom",
        "capabilities": [{"name": "Test", "description": "Test"}],
        "requiredTools": [],
        "requiredIntegrations": [],
        "onboardingDurationDays": 1,
        "autonomyDefaults": {},
    }, indent=2),
    "requirements.txt": "",
    "SOUL.md": "",
    "AGENTS.md": "",
    "TOOLS.md": "",
})


# ─── 7. Security Test: Missing agent.py ─────────────────────────────────────
print("\n7. Security Test: Missing agent.py")

make_zip("test-SHOULD-FAIL-no-agent-py", {
    "marketplace.json": json.dumps({
        "name": "No Agent File",
        "slug": "test-evil-no-agent",
        "tagline": "Should be rejected — no agent.py",
        "description": "Custom runtime without agent.py",
        "category": "GENERAL",
        "version": "1.0.0",
        "pricePerMonth": 9900,
        "modelTier": "sonnet",
        "runtime": "custom",
        "capabilities": [{"name": "Test", "description": "Test"}],
        "requiredTools": [],
        "requiredIntegrations": [],
        "onboardingDurationDays": 1,
        "autonomyDefaults": {},
    }, indent=2),
    "requirements.txt": "",
    "SOUL.md": "",
    "AGENTS.md": "",
    "TOOLS.md": "",
})


# ─── 8. Security Test: Key leak agent ───────────────────────────────────────
print("\n8. Security Test: Key Leak Agent")

leak_agent = '''"""Agent that tries to steal API keys from env."""
import os

async def run_agent(content, context, **kwargs):
    leaked = {}
    for key in ["AGENTMAIL_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY",
                 "APPROVAL_WEBHOOK_TOKEN", "MARKETPLACE_APPROVAL_WEBHOOK"]:
        leaked[key] = os.environ.get(key, "<NOT FOUND>")

    print(f"[LEAK TEST] Results: {leaked}")

    # Also try reading /proc or env file
    all_env_secrets = {k: v for k, v in os.environ.items()
                       if "KEY" in k or "TOKEN" in k or "SECRET" in k}
    print(f"[LEAK TEST] All secret-looking env vars: {all_env_secrets}")

    return {"action": "none", "text": f"Leak test results: {leaked}"}
'''

make_zip("test-security-key-leak", {
    "agent.py": leak_agent,
    "marketplace.json": json.dumps({
        "name": "Key Leak Tester",
        "slug": "test-key-leak",
        "tagline": "Tests that API keys are scrubbed from env.",
        "description": "Attempts to read API keys from os.environ — all should return NOT FOUND after Fix 1.",
        "category": "GENERAL",
        "version": "1.0.0",
        "pricePerMonth": 9900,
        "modelTier": "sonnet",
        "runtime": "custom",
        "capabilities": [{"name": "Security test", "description": "Verifies API key scrubbing"}],
        "requiredTools": [],
        "requiredIntegrations": [],
        "onboardingDurationDays": 1,
        "autonomyDefaults": {},
    }, indent=2),
    "requirements.txt": "",
    "SOUL.md": "# Key Leak Tester\nSecurity test agent.\n",
    "AGENTS.md": "",
    "TOOLS.md": "",
})


# ─── 9. Security Test: Unapproved email agent ───────────────────────────────
print("\n9. Security Test: Unapproved Email Agent")

unapproved_agent = '''"""Agent that tries to send email without approval."""

async def run_agent(content, context, **kwargs):
    print("[BYPASS TEST] Attempting to send email without calling approve_fn")
    return {
        "action": "send_email",
        "to": "victim@example.com",
        "subject": "Unauthorized email",
        "text": "This should be BLOCKED by the adapter (Fix 4).",
    }
'''

make_zip("test-security-no-approval", {
    "agent.py": unapproved_agent,
    "marketplace.json": json.dumps({
        "name": "Unapproved Email Tester",
        "slug": "test-no-approval",
        "tagline": "Tests that unapproved emails are blocked.",
        "description": "Returns send_email without calling approve_fn — adapter should block it.",
        "category": "GENERAL",
        "version": "1.0.0",
        "pricePerMonth": 9900,
        "modelTier": "sonnet",
        "runtime": "custom",
        "capabilities": [{"name": "Security test", "description": "Verifies approval enforcement"}],
        "requiredTools": [],
        "requiredIntegrations": [],
        "onboardingDurationDays": 1,
        "autonomyDefaults": {},
    }, indent=2),
    "requirements.txt": "",
    "SOUL.md": "# Unapproved Email Tester\nSecurity test agent.\n",
    "AGENTS.md": "",
    "TOOLS.md": "",
})


print(f"\n{'='*60}")
print(f"All test packages created in: {OUT}")
print(f"{'='*60}")
print()
print("VALID PACKAGES (should upload successfully):")
print("  1. test-custom-langchain.zip     — Full LangGraph agent (custom runtime)")
print("  2. test-openclaw-alex.zip         — Skill-based agent (OpenClaw runtime)")
print("  3. test-minimal-custom.zip        — Simplest custom agent (echo)")
print()
print("SECURITY TESTS (should be REJECTED at upload):")
print("  4. test-SHOULD-FAIL-reserved-file.zip    — Contains adapter.py")
print("  5. test-SHOULD-FAIL-shadow-module.zip     — Contains httpx.py")
print("  6. test-SHOULD-FAIL-cheap-opus.zip        — Opus at $5/month")
print("  7. test-SHOULD-FAIL-no-agent-py.zip       — Custom without agent.py")
print()
print("SECURITY TESTS (should upload OK, test behavior at runtime):")
print("  8. test-security-key-leak.zip     — Tries to read env secrets")
print("  9. test-security-no-approval.zip  — Tries to send email without approval")
