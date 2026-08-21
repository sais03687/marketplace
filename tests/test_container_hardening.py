"""The agent container should hold no privilege, and no credential it doesn't use.

Two boundaries. Capabilities: the agent runs creator code as a Python HTTP
server that needs no privileged kernel operation, so the container drops every
Linux capability - the same posture the MCP sidecar has always run with. Secrets:
the adapter reads sensitive env vars into a private dict and pops them from
os.environ before creator code imports, so creator code cannot read a credential
it has no business touching. These pin which credentials are scrubbed and that
the one the creator legitimately needs (LLM_API_KEY) is knowingly left.
"""
from pathlib import Path

ADAPTER = (
    Path(__file__).resolve().parents[1]
    / "apps" / "provisioning-service" / "src" / "templates" / "runtime" / "adapter.py"
).read_text(encoding="utf-8")
RUNNER = (
    Path(__file__).resolve().parents[1]
    / "apps" / "provisioning-service" / "src" / "jobs" / "custom-runner.ts"
).read_text(encoding="utf-8")

# The scrub list literal.
_SCRUB_BLOCK = ADAPTER[ADAPTER.index("_SECRETS_TO_SCRUB = ["): ADAPTER.index("_secrets: dict")]


def test_agent_container_drops_all_capabilities():
    # In the container's HostConfig, not the sidecar's or the egress proxy's.
    host = RUNNER[RUNNER.index("Image: imageName"):]
    host = host[: host.index("await container.start()")]
    assert 'CapDrop: ["ALL"]' in host
    assert 'SecurityOpt: ["no-new-privileges"]' in host


def test_every_platform_only_credential_is_scrubbed():
    # These are used by the adapter, never by creator code — none may remain in
    # os.environ once creator code imports.
    for cred in (
        "APPROVAL_WEBHOOK_TOKEN",
        "AGENT_TOKEN",
        "AGENT_HOOKS_TOKEN",
        "MICROSOFT_CLIENT_SECRET",
        "PORTAL_TOKEN",
    ):
        assert f'"{cred}"' in _SCRUB_BLOCK, f"{cred} must be scrubbed from creator env"


def test_portal_token_is_read_from_the_scrubbed_copy_not_env():
    # If it were still read from os.environ it would always be empty after the
    # pop — silently breaking approval sync — or, if not popped, readable by
    # creator code. It must come from _secrets.
    assert '_secrets.get("PORTAL_TOKEN"' in ADAPTER
    assert 'os.environ.get("PORTAL_TOKEN"' not in ADAPTER


def test_llm_key_is_knowingly_not_scrubbed_with_a_reason():
    # Creator code builds its own LLM client and needs the key, so scrubbing it
    # would break the agent; isolating it needs a proxy, not a pop. This asserts
    # the boundary is documented where the decision lives, not silently omitted.
    assert '"LLM_API_KEY"' not in _SCRUB_BLOCK
    assert "LLM_API_KEY is" in _SCRUB_BLOCK  # the explanatory comment
