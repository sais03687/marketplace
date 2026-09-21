"""A package that will not start says why it will not start.

The health check described the container from outside — killed, exited with a
code, reaching a blocked host — and none of that names the line that broke. A
creator whose agent raised on import got sixty lines of "not yet ready" followed
by "the process exited with code 1", which is equally true of a missing
dependency, a KeyError on an environment variable, and a syntax error.

The traceback was in Docker the whole time and was never read. Found on
2026-09-21 by publishing an agent that crashed at import and having no way,
from the vetting report, to learn why.
"""
from pathlib import Path

VET = (Path(__file__).resolve().parents[1] / "apps" / "provisioning-service" / "src"
       / "jobs" / "vet-package.ts").read_text(encoding="utf-8")


def _health_failure_block() -> str:
    start = VET.index("if (!healthy) {")
    return VET[start:VET.index("report.steps.push({ name: \"Health check\", status: \"pass\"", start)]


def test_the_container_output_is_read_when_it_fails_to_start():
    block = _health_failure_block()
    assert "container.logs(" in block
    assert "stderr: true" in block, "the traceback goes to stderr"


def test_the_output_reaches_the_report_the_creator_reads():
    block = _health_failure_block()
    assert "healthLogs.push" in block
    assert "container output" in block


def test_the_error_line_is_pulled_out_of_the_noise():
    # Forty lines of output with the cause buried in it is better than nothing,
    # but the summary should name the line so the creator does not have to hunt.
    block = _health_failure_block()
    assert "it printed:" in block
    for token in ("Traceback", "ModuleNotFound", "KeyError"):
        assert token in block, token


def test_reading_the_logs_cannot_break_the_diagnosis():
    # It runs while already handling a failure. Throwing here would replace a
    # useful report with a crash.
    block = _health_failure_block()
    logs_at = block.index("container.logs(")
    after = block[logs_at:]
    assert "catch" in after, "log reading must be best-effort like the inspect above it"


def test_the_docker_frame_header_is_stripped():
    # Docker multiplexes stdout and stderr with an 8-byte header per frame when
    # there is no TTY, which renders as control characters in the report.
    block = _health_failure_block()
    assert "u0000" in block or "\\u0000" in block
