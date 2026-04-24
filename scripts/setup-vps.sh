#!/bin/bash
# VPS Setup Script — run once on a fresh Hetzner CX22 (Ubuntu 24.04)
# Usage: bash setup-vps.sh
# Takes ~5 minutes. Installs Docker, Node, pnpm, clones the repo,
# builds the provisioning service, and starts it under pm2.

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()    { echo -e "${GREEN}[✓]${NC} $1"; }
warn()    { echo -e "${YELLOW}[!]${NC} $1"; }
die()     { echo -e "${RED}[✗]${NC} $1"; exit 1; }
section() { echo -e "\n${YELLOW}── $1 ──${NC}"; }

# ── 0. Sanity checks ──────────────────────────────────────────────────────────
[[ $EUID -ne 0 ]] && die "Run as root: sudo bash setup-vps.sh"
[[ -z "${REPO_URL:-}" ]] && die "Set REPO_URL before running: export REPO_URL=https://github.com/you/marketplace.git"
[[ -z "${ENV_FILE:-}" ]] && die "Set ENV_FILE before running: export ENV_FILE=/path/to/.env.prod"
[[ -f "$ENV_FILE" ]] || die ".env.prod file not found at $ENV_FILE"

section "System update"
apt-get update -q && apt-get upgrade -y -q
info "System updated"

section "Docker"
if ! command -v docker &>/dev/null; then
  curl -fsSL https://get.docker.com | sh
  systemctl enable docker
  systemctl start docker
  info "Docker installed"
else
  info "Docker already installed ($(docker --version))"
fi

section "Node.js 20"
if ! command -v node &>/dev/null || [[ "$(node -e 'process.stdout.write(process.version.split(".")[0].slice(1))')" -lt 20 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
  info "Node.js installed ($(node --version))"
else
  info "Node.js already installed ($(node --version))"
fi

section "pnpm"
if ! command -v pnpm &>/dev/null; then
  corepack enable
  corepack prepare pnpm@latest --activate
  info "pnpm installed"
else
  info "pnpm already installed ($(pnpm --version))"
fi

section "pm2"
if ! command -v pm2 &>/dev/null; then
  npm install -g pm2
  pm2 startup systemd -u root --hp /root | tail -1 | bash
  info "pm2 installed and configured for auto-start"
else
  info "pm2 already installed"
fi

section "Clone repository"
APP_DIR="/opt/marketplace"
if [[ -d "$APP_DIR" ]]; then
  warn "Directory $APP_DIR already exists — pulling latest"
  git -C "$APP_DIR" pull
else
  git clone "$REPO_URL" "$APP_DIR"
  info "Cloned to $APP_DIR"
fi

section "Environment file"
cp "$ENV_FILE" "$APP_DIR/.env.prod"
info "Copied .env.prod to $APP_DIR"

section "Install dependencies"
cd "$APP_DIR"
pnpm install --frozen-lockfile
info "Dependencies installed"

section "Generate Prisma client"
pnpm --filter @marketplace/db exec prisma generate
info "Prisma client generated"

section "Build provisioning service"
pnpm --filter provisioning-service build
info "Build complete"

section "Start provisioning service with pm2"
cd "$APP_DIR/apps/provisioning-service"

# Stop existing instance if running
pm2 delete marketplace-provisioning 2>/dev/null || true

pm2 start dist/index.js \
  --name marketplace-provisioning \
  --env production \
  --env-file "$APP_DIR/.env.prod" \
  --max-memory-restart 512M \
  --restart-delay 5000 \
  --log /var/log/marketplace-provisioning.log \
  --merge-logs

pm2 save
info "Provisioning service started"

section "Done"
echo ""
echo "  Provisioning service is running under pm2."
echo "  Logs:    pm2 logs marketplace-provisioning"
echo "  Status:  pm2 status"
echo "  Restart: pm2 restart marketplace-provisioning"
echo ""
echo "  Next: run scripts/migrate-prod.sh to apply DB migrations."
echo ""
