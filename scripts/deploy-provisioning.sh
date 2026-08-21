#!/bin/sh
# Deploy the provisioning service, rebuilding the workspace packages it depends
# on, from origin/main.
#
# The service runs src/index.ts directly via tsx, so its own code needs no build.
# But it imports two *built* artifacts: @marketplace/agent-package-schema (whose
# dist/ is gitignored) and the Prisma client (generated). A change to either that
# is not rebuilt leaves the VPS running stale logic while the web app runs the
# new one.
#
# That is not hypothetical. On 2026-08-20 onboardingDurationDays was removed
# everywhere — schema source, web app, agent — but the VPS kept the old
# agent-package-schema build, so vetting rejected a field the publish page
# accepted. The two disagreed for every creator until the package was rebuilt by
# hand.
#
# So this ALWAYS rebuilds both before restarting. Both are fast, and always
# rebuilding removes the "forgot to notice the change" failure mode entirely —
# which is the whole point of a deploy script over a remembered sequence.
#
# A plain `pm2 restart` (no --update-env) keeps the process env; do not change
# that without sourcing .env.prod first (the pm2 env trap).
set -e
cd /opt/marketplace

git fetch -q origin main
git checkout origin/main -- apps/provisioning-service/ packages/agent-package-schema/ packages/db/

echo "rebuilding agent-package-schema..."
( cd packages/agent-package-schema && npx tsc >/dev/null 2>&1 )

echo "regenerating prisma client..."
( cd packages/db && npx prisma generate >/dev/null 2>&1 )

echo "restarting provisioning service..."
pm2 restart marketplace-provisioning >/dev/null

# Confirm it came back rather than assuming. The service listens on 3003.
sleep 8
if pm2 jlist 2>/dev/null | grep -q '"name":"marketplace-provisioning","pm2_env":{[^}]*"status":"online"' \
   || pm2 describe marketplace-provisioning 2>/dev/null | grep -q "online"; then
  echo "deployed $(git rev-parse --short origin/main); provisioning is online"
else
  echo "WARNING: provisioning did not report online — check: pm2 logs marketplace-provisioning"
  exit 1
fi
