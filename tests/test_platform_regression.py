"""Platform-owned regression tasks run against every new version in vetting.

Not the creator-authored golden gate removed on 2026-08-21 (a creator could pick
inputs the agent handles): these live in the platform and grow from real
failures, starting with the 2026-10-17 email battery.
"""
import io
import json
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SVC = ROOT / "apps" / "provisioning-service"
VET = io.open(SVC / "src" / "jobs" / "vet-package.ts", encoding="utf-8").read()
REG = io.open(SVC / "src" / "jobs" / "regression.ts", encoding="utf-8").read()


@pytest.mark.parametrize("slug", ["route-planner", "data-analyst"])
def test_each_task_has_an_input_and_something_to_check(slug):
    tasks = json.load(open(SVC / "regression" / f"{slug}.json", encoding="utf-8"))
    assert tasks
    for t in tasks:
        assert t["name"] and t["input"].strip() and t["expect"] and all(e.strip() for e in t["expect"])


def test_the_tasks_come_from_the_platform_not_the_package():
    assert 'join(dirname(fileURLToPath(import.meta.url)), "..", "..", "regression")' in REG
    assert "golden.json" not in VET, "the creator-authored gate stays removed"


def test_a_wrong_answer_fails_the_version():
    start = VET.index("const regression = regressionTasksFor(slug);")
    block = VET[start: VET.index("// Manual review:", start)]
    assert 'if (failed.length) report.overallStatus = "fail";' in block


def test_the_matcher_ignores_case_and_thousands_separators():
    if not shutil.which("node"):
        pytest.skip("node not installed")
    body = REG[REG.index("export function normaliseAnswer"):]
    body = body.replace("export function", "function").replace("(text: string): string", "(text)") \
        .replace("(reply: string, expect: string[]): string[]", "(reply, expect)")
    code = body + ';console.log(JSON.stringify([missingFrom("Total: $1,984,000; West grew 42.5%", ["1984000","west","42.5"]), missingFrom("6 stops", ["7 stops"])]))'
    out = subprocess.run(["node", "-e", code], capture_output=True, text=True, timeout=30)
    assert out.returncode == 0, out.stderr
    assert json.loads(out.stdout) == [[], ["7 stops"]]
