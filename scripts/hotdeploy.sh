#!/bin/sh
# Fast agent-code deploy: repo -> container, no reprovision.
#
# Tracked in the repo at scripts/hotdeploy.sh; the copy that runs is
# /opt/marketplace/hotdeploy.sh on the VPS. Keep them identical.
#
# Reprovisioning rebuilds the image (~5 min), wipes `docker logs` and orphans
# any pending approval. `docker cp` writes to the container's writable layer,
# which `docker restart` preserves, so the same code lands in ~10s with the
# logs intact.
#
# The git checkout still happens, so the next real reprovision picks up
# identical code from the repo rather than reverting this.
set -e
DEP=cmsmc95dp0003l704az3d9btj
CTR=custom-agent-cmsmc95d
cd /opt/marketplace
git fetch -q origin main
git checkout origin/main -- agents/data-analyst/ apps/provisioning-service/src/templates/runtime/adapter.py apps/provisioning-service/src/templates/runtime/platform_llm.py
docker cp agents/data-analyst/agent.py       $CTR:/agent/creator/agent.py
docker cp agents/data-analyst/microsoft_tools.py $CTR:/agent/creator/microsoft_tools.py
docker cp agents/data-analyst/AGENTS.md      $CTR:/agent/creator/AGENTS.md
docker cp agents/data-analyst/TOOLS.md       $CTR:/agent/creator/TOOLS.md
docker cp apps/provisioning-service/src/templates/runtime/adapter.py $CTR:/agent/adapter.py
docker cp apps/provisioning-service/src/templates/runtime/platform_llm.py $CTR:/agent/platform_llm.py
docker exec $CTR sh -c 'rm -rf /agent/creator/__pycache__' 2>/dev/null || true
docker restart $CTR >/dev/null
sleep 6
echo "deployed $(git rev-parse --short origin/main) -> $CTR : $(docker ps --filter name=$CTR --format '{{.Status}}')"
