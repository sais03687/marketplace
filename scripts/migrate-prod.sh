#!/bin/bash
# Production migration script — safe wrapper around prisma migrate deploy.
# Run this from the VPS after setup-vps.sh, or locally if you have
# direct access to the production DATABASE_URL.
#
# Usage:
#   export DATABASE_URL=postgresql://...
#   bash scripts/migrate-prod.sh
#
# Or on the VPS:
#   bash scripts/migrate-prod.sh --env /opt/marketplace/.env.prod

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() { echo -e "${GREEN}[✓]${NC} $1"; }
die()  { echo -e "${RED}[✗]${NC} $1"; exit 1; }

# Allow passing an env file directly
if [[ "${1:-}" == "--env" ]]; then
  [[ -f "${2:-}" ]] || die "Env file not found: ${2:-}"
  set -o allexport
  source "$2"
  set +o allexport
  info "Loaded env from $2"
fi

[[ -z "${DATABASE_URL:-}" ]] && die "DATABASE_URL is not set"

# Confirm before touching production
echo ""
echo -e "${YELLOW}You are about to run migrations against:${NC}"
# Mask password in URL for display
DISPLAY_URL=$(echo "$DATABASE_URL" | sed 's/:\/\/[^:]*:[^@]*@/:\/\/***:***@/')
echo "  $DISPLAY_URL"
echo ""
read -rp "Type 'yes' to continue: " CONFIRM
[[ "$CONFIRM" == "yes" ]] || { echo "Aborted."; exit 0; }

# Navigate to repo root regardless of where script is called from
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$REPO_ROOT"

info "Running prisma migrate deploy..."
pnpm --filter @marketplace/db exec prisma migrate deploy

info "Migrations applied successfully."
echo ""
echo "  To verify: pnpm --filter @marketplace/db exec prisma migrate status"
echo ""
