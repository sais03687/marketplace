"""An agent gateway must be published on loopback, never a public interface.

Each agent's netgate publishes the gateway port on the host so the platform can
reach it, but pinned to 127.0.0.1 — the cloud firewall does not cover these
ephemeral high ports, so a gateway on 0.0.0.0 would sit on the public internet
with only its per-request token check between it and the world. This pins both
that the binding is requested on loopback and that the code fails closed if Docker
ever reports otherwise.
"""
from pathlib import Path

EGRESS = (
    Path(__file__).resolve().parents[1]
    / "apps" / "provisioning-service" / "src" / "clients" / "egress-proxy.ts"
).read_text(encoding="utf-8")


def test_gateway_is_published_on_loopback():
    assert 'HostIp: "127.0.0.1"' in EGRESS


def test_startup_asserts_the_binding_and_fails_closed():
    # After inspecting the real binding, a non-loopback HostIp must throw, not warn.
    assert 'binding[0].HostIp' in EGRESS
    block = EGRESS[EGRESS.index("const hostIp = binding[0].HostIp"):]
    block = block[: block.index("const hostPort")]
    assert '!== "127.0.0.1"' in block
    assert "throw new Error" in block
    assert "refusing to start" in block
