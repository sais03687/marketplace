"""Publishing a version again replaces it, and never stacks a second row.

Found on 2026-09-21 by publishing the same agent twice through the wizard. The
admin queue then showed two "Action Items v1.0.0" entries, both PENDING, alike
in every visible field. Since each upload now stores its own package, the two
rows pointed at different code, and approving the wrong one would have shipped
the code the creator had just replaced.

/api/agents/[slug]/versions had always handled this: an approved version is
refused with "bump the version", a pending one is updated in place. The publish
wizard calls /api/packages/upload, which did neither.

Two halves, both needed. The upload must not create the duplicate; and the
lookups that resolve a version to a package must be ordered, because rows
created before the fix are still in the database and an unordered findFirst
lets Postgres return either one.
"""
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
UPLOAD = (ROOT / "apps" / "web" / "app" / "api" / "packages" / "upload"
          / "route.ts").read_text(encoding="utf-8")
VERSIONS = (ROOT / "apps" / "web" / "app" / "api" / "agents" / "[slug]" / "versions"
            / "route.ts").read_text(encoding="utf-8")
JOBS = ROOT / "apps" / "provisioning-service" / "src" / "jobs"


def test_the_publish_route_looks_for_the_version_first():
    assert "tx.agentVersion.findFirst" in UPLOAD, (
        "the publish route must look for an existing row before writing one"
    )


def test_an_approved_version_is_not_overwritten():
    # The security half: a creator must not be able to replace reviewed code
    # under a version number buyers are already running.
    assert "VersionAlreadyApprovedError" in UPLOAD
    assert 'vetStatus !== "PENDING"' in UPLOAD
    assert "409" in UPLOAD


def test_a_pending_version_is_replaced_rather_than_duplicated():
    assert "tx.agentVersion.update" in UPLOAD
    create_at = UPLOAD.index("tx.agentVersion.create")
    update_at = UPLOAD.index("tx.agentVersion.update")
    assert update_at < create_at, "update must be the branch taken when a row exists"


def test_the_refusal_rolls_the_publish_back():
    # The agent row is written before the version row. Returning instead of
    # throwing would leave the listing describing a package never stored.
    assert "throw new VersionAlreadyApprovedError" in UPLOAD


@pytest.mark.parametrize("src,label", [(UPLOAD, "publish"), (VERSIONS, "versions")])
def test_replacing_a_package_clears_the_old_report(src, label):
    # A verdict beside a package it was never run against is what made the
    # duplicate hard to read in the first place.
    start = src.index("agentVersion.update({")
    body = src[start:start + 900]
    assert "vetNotes: null" in body, label
    assert "testResults: Prisma.DbNull" in body, label


@pytest.mark.parametrize("job", ["provision.ts", "update.ts"])
def test_resolving_a_version_to_a_package_is_ordered(job):
    src = (JOBS / job).read_text(encoding="utf-8")
    for match in re.finditer(r"agentVersion\.findFirst\(\{", src):
        call = src[match.start():src.index("});", match.start())]
        assert "orderBy" in call, (
            f"{job}: an unordered findFirst can return either of two rows "
            f"sharing a version, and they hold different packages"
        )
