"""`agentstore check` refuses exactly what the platform's vetting refuses.

On 2026-10-16 Route Planner 1.1.0 passed `agentstore check` and then failed
vetting on `import subprocess` and `import requests`: the CLI had never been
given the platform's scan rules. It now carries a copy, and this test fails the
moment the copy and vet-package.ts disagree.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VET = (ROOT / "apps" / "provisioning-service" / "src" / "jobs" / "vet-package.ts").read_text(encoding="utf-8")
sys.path.insert(0, str(ROOT / "packages" / "agentstore-cli" / "src"))

from agentstore import scan_rules  # noqa: E402


def _platform_rules():
    block = VET[VET.index("const DANGEROUS_PATTERNS"):]
    block = block[: block.index("];")]
    return re.findall(r'\{\s*re:\s*/(.+?)/,\s*label:\s*"(.+?)"\s*\}', block)


def test_the_cli_has_the_platforms_rules_exactly():
    platform = _platform_rules()
    assert len(platform) >= 25, "could not read the platform's rules"
    assert scan_rules.PLATFORM_RULES == platform


def test_the_cli_catches_what_failed_route_planner_1_1_0():
    found = [label for _, label in scan_rules.scan("import subprocess\nimport requests\nimport httpx\n")]
    assert "import subprocess" in found
    assert any(label.startswith("import requests") for label in found)
    assert not any("httpx" in label for label in found)


def test_commented_lines_are_skipped_as_vetting_skips_them():
    assert list(scan_rules.scan("# import subprocess\n")) == []
