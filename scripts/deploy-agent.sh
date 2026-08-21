#!/bin/sh
# Fast agent-code deploy: repo -> container, no reprovision.
#
# Reprovisioning rebuilds the image (~5 min), wipes `docker logs` and orphans any
# pending approval. `docker cp` writes to the container's writable layer, which
# `docker restart` preserves, so the same code lands in ~10s with the logs
# intact. The git checkout still happens, so the next real reprovision picks up
# identical code from the repo rather than reverting this.
#
# Version-controlled on purpose: this used to live only on the VPS, untracked, so
# the one script that ships code to production could not be reviewed or restored.
set -e

# The single live agent. When there is more than one, pass the deployment id and
# container name as $1 and $2.
DEP="${1:-cmsmc95dp0003l704az3d9btj}"
CTR="${2:-custom-agent-cmsmc95d}"

cd /opt/marketplace
git fetch -q origin main
git checkout origin/main -- agents/data-analyst/ apps/provisioning-service/src/templates/runtime/adapter.py

docker cp agents/data-analyst/agent.py            "$CTR:/agent/creator/agent.py"
docker cp agents/data-analyst/microsoft_tools.py  "$CTR:/agent/creator/microsoft_tools.py"
docker cp agents/data-analyst/AGENTS.md           "$CTR:/agent/creator/AGENTS.md"
docker cp agents/data-analyst/TOOLS.md            "$CTR:/agent/creator/TOOLS.md"
docker cp apps/provisioning-service/src/templates/runtime/adapter.py "$CTR:/agent/adapter.py"
docker exec "$CTR" sh -c 'rm -rf /agent/creator/__pycache__' 2>/dev/null || true
docker restart "$CTR" >/dev/null
sleep 6
echo "deployed $(git rev-parse --short origin/main) -> $CTR : $(docker ps --filter name="$CTR" --format '{{.Status}}')"
