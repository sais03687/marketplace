"""Publishing an agent has to start the review the creator is promised.

The wizard's final screen says "Your agent is under review. Once approved by an
admin it will be listed on the marketplace." On 2026-08-17 that was not true of
anything: the upload route set `vetStatus: "PENDING"` and stopped.
`enqueueVetPackage` existed in the provisioning service and no caller ever
reached it, so the only way to vet a package was for someone to POST
`/api/packages/:id/vet-sandbox` by hand.

The record read as though the pipeline was broken — no package had ever passed
vetting. It was not broken. The first package put through it by hand passed 5 of
5 once two environment variables were corrected. Nothing had ever asked it to
run.

Source-level: apps/web has no JS test runner, and the property worth holding is
that the call exists on the path a creator actually takes.
"""
import io
import re
from pathlib import Path

WEB = Path(__file__).resolve().parents[1] / "apps" / "web"
UPLOAD = WEB / "app" / "api" / "packages" / "upload" / "route.ts"
MANUAL = WEB / "app" / "api" / "packages" / "[id]" / "vet-sandbox" / "route.ts"

UPLOAD_SRC = io.open(UPLOAD, encoding="utf-8").read()
MANUAL_SRC = io.open(MANUAL, encoding="utf-8").read()


def test_publishing_enqueues_a_vetting_job():
    assert '"vet_package"' in UPLOAD_SRC, (
        "publishing sets PENDING and tells the creator they are under review; "
        "without this nothing reviews them"
    )


def test_it_enqueues_the_version_that_was_just_created():
    # Enqueuing the wrong id vets someone else's package and leaves this one
    # pending forever, which is indistinguishable from the bug being fixed.
    block = UPLOAD_SRC[UPLOAD_SRC.index('"vet_package"'):][:400]
    assert "result.version.id" in block


def test_a_queue_outage_does_not_lose_the_upload():
    # The package is stored and the version row written before this point.
    # Throwing here would fail the request and lose work the creator has already
    # done, to protect a step that has a manual retry.
    block = UPLOAD_SRC[UPLOAD_SRC.index('"vet_package"') - 600:]
    assert "try {" in block and "catch" in block


def test_only_packages_that_can_be_vetted_are_queued():
    # The sandbox builds a Docker image from the package. A version with no
    # stored file, or a runtime the harness cannot build, would fail the job
    # rather than the check.
    block = UPLOAD_SRC[UPLOAD_SRC.index('"vet_package"') - 600:UPLOAD_SRC.index('"vet_package"')]
    assert "storagePath" in block
    assert "CUSTOM" in block


def test_the_manual_route_still_exists_as_the_retry():
    # Automatic queueing is the normal path; the manual POST is what recovers a
    # package whose job was lost, and it is what proved the pipeline works.
    assert '"vet_package"' in MANUAL_SRC


def test_both_paths_use_the_same_queue():
    for src in (UPLOAD_SRC, MANUAL_SRC):
        assert "getProvisioningQueue" in src, (
            "a second queue accessor is a second place for the connection to "
            "differ, and the symptom is a job that is never picked up"
        )
