#!/bin/bash
set -e

echo "[startup] Agent runner starting..."
echo "[startup] Deployment ID: ${DEPLOYMENT_ID}"
echo "[startup] Agent: ${AGENT_NAME}"
echo "[startup] Company: ${COMPANY_NAME}"

# 0. If workspace is read-only (bind-mounted creator package), copy to writable location
if ! touch /agent/workspace/.write-test 2>/dev/null; then
  echo "[startup] Workspace is read-only (creator package mount), copying to writable dir..."
  cp -r /agent/workspace /agent/workspace-rw
  # Point everything at the writable copy
  WORKSPACE_DIR="/agent/workspace-rw"
else
  rm -f /agent/workspace/.write-test
  WORKSPACE_DIR="/agent/workspace"
fi
export WORKSPACE_DIR

# 1. Write openclaw config from env vars
cat > /agent/openclaw.json <<JSONEOF
{
  "model": "${MODEL:-haiku}",
  "provider": "${PROVIDER:-anthropic}",
  "apiKey": "${ANTHROPIC_API_KEY}",
  "plugins": {
    "agentmail-tools": {
      "inboxAddress": "${AGENT_EMAIL}",
      "approvalEndpoint": "http://localhost:3001"
    }
  },
  "hooks": {
    "approval_webhook": {
      "url": "${MARKETPLACE_APPROVAL_WEBHOOK}",
      "token": "${APPROVAL_WEBHOOK_TOKEN}"
    }
  },
  "cron": {
    "enabled": true
  }
}
JSONEOF

# 2. Write cron jobs for weekly digest
if [ -n "${WEEKLY_DIGEST_EMAIL}" ]; then
  mkdir -p ~/.openclaw/cron
  cat > ~/.openclaw/cron/jobs.json <<CRONJSON
{
  "version": 1,
  "jobs": [
    {
      "name": "Weekly Digest",
      "schedule": { "kind": "cron", "expr": "0 9 * * 1" },
      "sessionTarget": "isolated",
      "wakeMode": "now",
      "payload": {
        "kind": "agentTurn",
        "message": "It is Monday morning. Compose and send the weekly digest email to ${WEEKLY_DIGEST_EMAIL}. Follow the weekly-digest skill instructions exactly."
      },
      "delivery": { "mode": "none" }
    }
  ]
}
CRONJSON
  echo "[startup] Weekly digest cron job configured for ${WEEKLY_DIGEST_EMAIL}"
fi

# 3. Replace template placeholders in workspace files
for f in ${WORKSPACE_DIR}/SOUL.md ${WORKSPACE_DIR}/onboarding/MEMORY_TEMPLATE.md ${WORKSPACE_DIR}/AGENTS.md; do
  if [ -f "$f" ]; then
    sed -i "s|{{AGENT_NAME}}|${AGENT_NAME}|g" "$f"
    sed -i "s|{{COMPANY_NAME}}|${COMPANY_NAME}|g" "$f"
    sed -i "s|{{COMPANY_DOMAIN}}|${COMPANY_DOMAIN}|g" "$f"
    sed -i "s|{{AGENT_EMAIL}}|${AGENT_EMAIL}|g" "$f"
    sed -i "s|{{GOOGLE_SERVICE_ACCOUNT_EMAIL}}|${GOOGLE_SERVICE_ACCOUNT_EMAIL}|g" "$f"
  fi
done

# 3a. Inject the hired-manager's configured approval policy into AGENTS.md.
# The provisioning service renders this from deployment.autonomyConfig and
# passes it via the APPROVAL_POLICY_SECTION env var. We append it rather than
# substitute so any uploaded OpenClaw agent gets the policy for free, even
# if its AGENTS.md has no placeholder for it.
if [ -n "${APPROVAL_POLICY_SECTION}" ] && [ -f ${WORKSPACE_DIR}/AGENTS.md ]; then
  printf '\n\n%s\n' "${APPROVAL_POLICY_SECTION}" >> ${WORKSPACE_DIR}/AGENTS.md
  echo "[startup] Injected approval policy section into AGENTS.md"
fi

# Copy MEMORY_TEMPLATE as MEMORY.md if it doesn't exist yet
if [ ! -f ${WORKSPACE_DIR}/MEMORY.md ] && [ -f ${WORKSPACE_DIR}/onboarding/MEMORY_TEMPLATE.md ]; then
  cp ${WORKSPACE_DIR}/onboarding/MEMORY_TEMPLATE.md ${WORKSPACE_DIR}/MEMORY.md
fi

# 4. Start the internal API in the background
echo "[startup] Starting internal API on port 4000..."
node /agent/internal-api/server.js &
INTERNAL_PID=$!

# Wait for internal API to be ready
for i in $(seq 1 30); do
  if curl -sf http://localhost:4000/internal/health > /dev/null 2>&1; then
    echo "[startup] Internal API ready"
    break
  fi
  sleep 1
done

# 5. Start OpenClaw gateway
echo "[startup] Starting OpenClaw gateway..."
exec openclaw start --config /agent/openclaw.json --workspace ${WORKSPACE_DIR}
