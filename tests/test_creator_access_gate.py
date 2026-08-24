"""Publishing is invite-gated: only an approved creator may put code on the platform.

During the beta, anyone could sign up and uploading auto-created a creator, so a
stranger's code ran in the sandbox unreviewed. Now a person requests access, an
admin approves or denies, and the upload/publish routes refuse anyone who is not
APPROVED. Existing creators were migrated to APPROVED so nothing they run breaks.
These pin the gate at each enforcement point.
"""
from pathlib import Path

WEB = Path(__file__).resolve().parents[1] / "apps" / "web"
DB = Path(__file__).resolve().parents[1] / "packages" / "db"


def _read(p: Path) -> str:
    return p.read_text(encoding="utf-8")


def test_upload_no_longer_auto_creates_a_creator():
    src = _read(WEB / "app" / "api" / "packages" / "upload" / "route.ts")
    # The old silent auto-create is gone; an unknown user is refused.
    assert "prisma.creator.create(" not in src
    assert "invite-only during the beta" in src
    assert 'creator.status !== "APPROVED"' in src


def test_version_publish_requires_an_approved_creator():
    src = _read(WEB / "app" / "api" / "agents" / "[slug]" / "versions" / "route.ts")
    assert 'creator.status !== "APPROVED"' in src


def test_request_endpoint_creates_a_pending_creator():
    src = _read(WEB / "app" / "api" / "creator" / "request" / "route.ts")
    assert 'status: "PENDING"' in src
    # Never self-approve: no create/update in the request path may WRITE APPROVED.
    # (Reading back an already-approved status in a response is fine.)
    assert "data: {" in src  # it does write
    assert 'status: "APPROVED",' not in src.replace(
        'jsonSuccess({ status: "APPROVED"', "jsonSuccess({ status: _approved_response"
    )


def test_admin_can_approve_or_deny_and_it_is_admin_gated():
    src = _read(WEB / "app" / "api" / "admin" / "creator-requests" / "[id]" / "route.ts")
    assert "requireAdmin()" in src
    assert '"APPROVED"' in src and '"DENIED"' in src


def test_admin_list_is_admin_gated():
    src = _read(WEB / "app" / "api" / "admin" / "creator-requests" / "route.ts")
    assert "requireAdmin()" in src


def test_migration_approves_existing_creators():
    # Existing creators are operating; the migration must not lock them out.
    mig = DB / "prisma" / "migrations" / "20260823000000_creator_access_request" / "migration.sql"
    sql = _read(mig)
    assert 'UPDATE "Creator" SET "status" = \'APPROVED\'' in sql
    assert "CreatorStatus" in sql
