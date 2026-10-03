"""The service must not depend on who started it for its secrets.

pm2's ecosystem config carried `env_file: "/opt/marketplace/.env.prod"`. pm2 has
no such option — it is Docker Compose syntax, accepted and ignored — so the
process only ever held the env of the shell that happened to start it.

Found live on 2026-10-03, weeks after the file was written: the running service
was missing LLM_BROKER_ENABLED and VET_LLM_API_KEY while both sat correctly in
.env.prod. With the broker flag gone, every new agent would have been handed the
platform's real model key instead of a broker token — the control built to keep
untrusted creator code away from that key, off, with nothing saying so.

So the service loads the file itself, and the load has to happen before any
module reads process.env.
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "apps" / "provisioning-service" / "src"
LOADER = (SRC / "load-env.ts").read_text(encoding="utf-8")
CONFIG = (SRC / "config.ts").read_text(encoding="utf-8")
INDEX = (SRC / "index.ts").read_text(encoding="utf-8")
ECOSYSTEM = (ROOT / "ecosystem.config.cjs").read_text(encoding="utf-8")


def test_the_loader_runs_on_import_not_on_call():
    # An exported function called from index.ts would run too late: ES module
    # imports are evaluated before any statement in the importing module.
    assert re.search(r"^loadEnvFile\(\);", LOADER, re.M), (
        "load-env.ts must invoke itself at import time"
    )


def test_config_loads_env_before_reading_it():
    first_import = re.search(r'^import\s+(?:"([^"]+)"|.*?from\s+"([^"]+)")', CONFIG, re.M)
    assert first_import, "config.ts has no imports"
    assert "load-env" in (first_import.group(1) or first_import.group(2)), (
        "config.ts reads process.env at import time, so the env file must be "
        "loaded by its first import"
    )


def test_the_entry_point_loads_env_first():
    first_import = re.search(r'^import\s+(?:"([^"]+)"|.*?from\s+"([^"]+)")', INDEX, re.M)
    assert "load-env" in (first_import.group(1) or first_import.group(2))


def test_an_existing_value_is_not_overwritten():
    assert "if (key in process.env) continue" in LOADER


def test_a_missing_file_is_not_fatal():
    # Development has no .env.prod, and a service that refuses to boot without
    # one is worse than the problem being fixed.
    assert "existsSync" in LOADER
    assert "if (!path) return;" in LOADER


def test_the_loader_never_logs_a_value():
    # It reports a count and the path, never a name=value pair.
    log_lines = [l for l in LOADER.splitlines() if "console.log" in l or "console.warn" in l]
    assert log_lines, "the loader should say what it did"
    for line in log_lines:
        assert "value" not in line, f"this log line could print a secret: {line.strip()}"


def test_pm2_is_not_trusted_with_the_env_file_again():
    assert "env_file:" not in ECOSYSTEM, (
        "pm2 ignores env_file; reintroducing it brings back a config that lies "
        "about loading secrets"
    )
    assert "load-env" in ECOSYSTEM, "say where the env actually comes from"
