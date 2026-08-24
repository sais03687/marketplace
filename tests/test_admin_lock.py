"""The /admin surface is locked to an allowlist of admin user IDs.

Admin pages used to be gated on "logged in" alone — any account that typed /admin
got in, and the Clerk role check was effectively unwired (sessionClaims metadata
is empty without session-token config). Admin is now an ADMIN_USER_IDS allowlist,
enforced once at the admin layout (so every admin page is covered) and on the
admin-action APIs. Fail-open when the var is UNSET so shipping cannot lock the
operator out before they configure it.
"""
from pathlib import Path

WEB = Path(__file__).resolve().parents[1] / "apps" / "web"


def _read(rel: str) -> str:
    return (WEB / rel).read_text(encoding="utf-8")


def test_admin_membership_is_an_env_allowlist():
    src = _read("lib/api-utils.ts")
    assert "export function isAdminUser" in src
    assert "process.env.ADMIN_USER_IDS" in src
    # requireAdmin uses it, not the unwired Clerk role claim.
    fn = src[src.index("export async function requireAdmin"):]
    assert "isAdminUser(userId)" in fn
    assert "publicMetadata" not in fn


def test_unset_allowlist_fails_open_not_closed():
    # An empty ADMIN_USER_IDS must not lock everyone out — it behaves as before
    # (any logged-in user) so a deploy before configuration is not a lockout.
    src = _read("lib/api-utils.ts")
    fn = src[src.index("export function isAdminUser"): src.index("export async function requireAdmin")]
    assert "if (!raw)" in fn
    assert "return true" in fn


def test_admin_layout_denies_non_admins_with_a_screen():
    src = _read("app/(auth)/admin/layout.tsx")
    assert "isAdminUser(userId)" in src
    assert "AdminAccessDenied" in src


def test_access_denied_screen_exists():
    src = _read("app/(auth)/admin/access-denied.tsx")
    assert "don" in src.lower() and "access" in src.lower()


def test_admin_action_apis_require_admin():
    for rel in (
        "app/api/packages/[id]/vet-decision/route.ts",     # approve/reject an agent
        "app/api/packages/[id]/vet-sandbox/route.ts",       # run the sandbox test box
        "app/api/admin/creator-requests/[id]/route.ts",     # approve/deny a creator
    ):
        assert "requireAdmin()" in _read(rel), f"{rel} must require admin"
