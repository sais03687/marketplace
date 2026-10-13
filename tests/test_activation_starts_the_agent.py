"""Nothing of a new hire runs until the buyer clicks Activate.

On 2026-10-11 a newly hired agent answered two emails while its dashboard still
said "Click below to … activate them". Provisioning had started the container,
the mail poller and the onboarding brief at payment; Activate only sent the
introduction and flipped a status. The buyer's rule since: don't spin up the
container or start the agent at all before they click Activate.

So a new hire is prepared at payment — mailbox, licence, image — and started by
Activate, which then sends the introduction only once the agent is healthy.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SVC = ROOT / "apps" / "provisioning-service" / "src"
PROVISION = (SVC / "jobs" / "provision.ts").read_text(encoding="utf-8")
ACTIVATE = (SVC / "jobs" / "activate.ts").read_text(encoding="utf-8")
RUNNER = (SVC / "jobs" / "custom-runner.ts").read_text(encoding="utf-8")
SERVER = (SVC / "server.ts").read_text(encoding="utf-8")
ADVANCE = (ROOT / "apps" / "web" / "app" / "api" / "deployments" / "[id]" / "onboarding" / "advance"
           / "route.ts").read_text(encoding="utf-8")
AGENT_PAGE = (ROOT / "apps" / "web" / "app" / "(auth)" / "dashboard" / "agents" / "[deploymentId]"
              / "page.tsx").read_text(encoding="utf-8")


def test_a_new_hire_is_prepared_not_started():
    # Started by default only when it was already live (an update to a running agent).
    assert 'const startAgent = opts.start ?? statusBefore === "ACTIVE";' in PROVISION
    prepare = PROVISION[PROVISION.index("if (!startAgent) {"):PROVISION.index("} else {", PROVISION.index("if (!startAgent) {"))]
    assert "prepareCustomAgent" in prepare
    for started_thing in ("createAgentNetwork", "spawnMcpSidecars", "spawnCustomAgent"):
        assert started_thing not in prepare, started_thing


def test_health_check_and_onboarding_brief_only_for_a_started_agent():
    assert "  if (startAgent) {\n    await withRetry(\n      () => waitForCustomHealth" in PROVISION
    assert "if (startAgent) await withRetry(" in PROVISION
    assert PROVISION.index("if (startAgent) await withRetry(") < PROVISION.index('step: "trigger_onboarding"')


def test_preparing_builds_the_image_and_starts_nothing():
    fn = RUNNER[RUNNER.index("export async function prepareCustomAgent"):RUNNER.index("export async function spawnCustomAgent")]
    assert "buildCustomImage" in fn
    for started_thing in ("createContainer", "startPoller", "startNetgate", ".start()"):
        assert started_thing not in fn, started_thing


def test_activation_reuses_the_image_built_at_hire():
    assert "if (reuseImage && (await imageExists(imageName)))" in RUNNER
    assert '{ start: true, reuseImage: true }' in ACTIVATE


def test_activation_cannot_start_two_copies_and_failure_leaves_it_retryable():
    assert 'where: { id: deploymentId, status: "ONBOARDING", containerName: null }' in ACTIVATE
    assert "if (claimed.count === 0)" in ACTIVATE
    failure = ACTIVATE[ACTIVATE.index("} catch (err: any) {"):]
    assert 'status: "ONBOARDING", containerName: null' in failure


def test_the_activate_endpoint_needs_the_platform_secret_even_if_unset():
    block = SERVER[SERVER.index('req.url === "/internal/activate"'):]
    assert "if (!SECRET || presented !== `Bearer ${SECRET}`)" in block[:400]


def test_the_introduction_goes_out_only_after_the_agent_has_started():
    assert ADVANCE.index("await startAgent(id)") < ADVANCE.index("sendNotificationEmail(")
    assert ADVANCE.index("await startAgent(id)") < ADVANCE.index('status: "ACTIVE"')
    assert "if (!started.ok) return jsonError(started.error, started.status);" in ADVANCE


def test_a_hire_waiting_for_activation_shows_no_liveness_badge():
    assert 'if (status !== "ACTIVE") return null;' in AGENT_PAGE
