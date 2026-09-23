"""The agent's token must reach the database before the agent does.

A container is handed APPROVAL_WEBHOOK_TOKEN and starts using it immediately: it
fetches the buyer's setup answers and pushes a memory snapshot, and the
marketplace authenticates both against deployment.approvalWebhookToken. That
column was only written at the end of provisioning, well after the container was
spawned, so both calls 403'd on every single hire:

    [adapter] setup answers: HTTP 403
    [adapter] memory snapshot push: HTTP 403

Seen on a real hire on 2026-09-23. It self-heals, because the adapter re-syncs
on a timer — but that timer is ten minutes, and the first thing a buyer does
with a new agent is email it. Until the retry landed, the agent had never read
the answers they gave during setup.
"""
import ast
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PROVISION = (ROOT / "apps" / "provisioning-service" / "src" / "jobs" / "provision.ts")
SRC = PROVISION.read_text(encoding="utf-8")


def _line_of(needle: str) -> int:
    idx = SRC.index(needle)
    return SRC[:idx].count("\n") + 1


def test_the_token_is_written_before_the_container_starts():
    token_writes = [
        SRC[:m].count("\n") + 1
        for m in range(len(SRC))
        if SRC.startswith("approvalWebhookToken: config.approvalWebhookToken", m)
    ]
    assert token_writes, "provisioning no longer writes approvalWebhookToken at all"

    spawn = _line_of("spawnCustomAgent(deploymentId")
    assert min(token_writes) < spawn, (
        f"the deployment token is only written at line(s) {token_writes}, after the "
        f"container spawns at line {spawn} — the agent's first calls will 403"
    )


def test_the_container_is_still_handed_that_token():
    assert "APPROVAL_WEBHOOK_TOKEN: config.approvalWebhookToken" in SRC


def test_the_early_write_targets_this_deployment():
    # A write that forgets the where clause would be a far worse bug than the
    # one it fixes.
    early = SRC[: SRC.index("spawnCustomAgent(deploymentId")]
    block = early[early.rindex("approvalWebhookToken: config.approvalWebhookToken") - 400 :]
    assert "where: { id: deploymentId }" in block
