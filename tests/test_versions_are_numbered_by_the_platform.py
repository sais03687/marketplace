"""Versions are numbered by the platform: 1, 2, 3, one per upload.

Since 2026-10-16 the manifest's "version" is ignored. That retires the rules
this file used to test (re-uploading a version number replaced a pending row;
reusing an approved number was refused) because no upload can reuse a number:
every one gets the next. What must still hold:

- Reviewed code is never replaced: uploads create rows and never rewrite one.
- Only one upload waits for review; a newer one replaces the older in the queue.
- An upload identical to the latest is refused, so a push that changed nothing
  does not become a version.
- Lookups that resolve a version to a package are ordered, because rows from
  before the 2026-09-21 fix can share a version string.
"""
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "apps" / "web"
UPLOAD = (WEB / "app" / "api" / "packages" / "upload" / "route.ts").read_text(encoding="utf-8")
VERSIONS = (WEB / "app" / "api" / "agents" / "[slug]" / "versions" / "route.ts").read_text(encoding="utf-8")
HELPER = (WEB / "lib" / "agent-versions.ts").read_text(encoding="utf-8")
APPROVE = (WEB / "app" / "api" / "packages" / "[id]" / "vet-decision" / "route.ts").read_text(encoding="utf-8")
JOBS = ROOT / "apps" / "provisioning-service" / "src" / "jobs"
ROUTES = [(UPLOAD, "publish"), (VERSIONS, "versions")]


@pytest.mark.parametrize("src,label", ROUTES)
def test_the_number_comes_from_the_platform_not_the_manifest(src, label):
    assert "nextVersionNumber(" in src, label
    assert "manifest.version as string" not in src, label


@pytest.mark.parametrize("src,label", ROUTES)
def test_uploads_never_rewrite_an_existing_version(src, label):
    assert "agentVersion.create(" in src, label
    # The only version update allowed is the vetting note on the row just made.
    for m in re.finditer(r"agentVersion\.update\(\{", src):
        call = src[m.start():src.index("});", m.start())]
        assert "packageUrl" not in call and "storagePath" not in call, label


@pytest.mark.parametrize("src,label", ROUTES)
def test_an_unchanged_upload_is_refused(src, label):
    assert "unchangedSince(" in src and "409" in src, label


@pytest.mark.parametrize("src,label", ROUTES)
def test_a_newer_upload_replaces_an_older_one_in_the_queue(src, label):
    assert "supersedePending(" in src, label


def test_the_next_number_counts_every_upload_so_far():
    assert "rows.length + 1" in HELPER
    assert "while (taken.has(String(n))) n++" in HELPER


def test_the_manifest_version_does_not_change_the_fingerprint():
    assert "delete m.version" in HELPER


def test_approval_puts_the_versions_listing_on_the_page():
    for field in ('"name", "tagline", "description", "category"', "updateData.model", "graphScopes"):
        assert field in APPROVE, field


@pytest.mark.parametrize("job", ["provision.ts", "update.ts"])
def test_resolving_a_version_to_a_package_is_ordered(job):
    src = (JOBS / job).read_text(encoding="utf-8")
    for match in re.finditer(r"agentVersion\.findFirst\(\{", src):
        call = src[match.start():src.index("});", match.start())]
        assert "orderBy" in call, (
            f"{job}: an unordered findFirst can return either of two rows "
            f"sharing a version, and they hold different packages"
        )
