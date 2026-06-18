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

# 2. (Weekly digest cron removed — use manager email via MANAGER_EMAIL env var directly)

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

# 3b. Add heartbeat cron job if the creator opted in via marketplace.json.
# HEARTBEAT_INTERVAL_HOURS is set by the provisioning service when the manifest
# includes a "heartbeat" block. Absent = heartbeat disabled for this deployment.
if [ -n "${HEARTBEAT_INTERVAL_HOURS}" ]; then
  mkdir -p ~/.openclaw/cron
  HEARTBEAT_MSG="HEARTBEAT: You have been woken for periodic maintenance. Check HEARTBEAT.md in your workspace for any queued operator instructions. Then perform proactive maintenance as described in your Heartbeats section: memory distillation, trust-tracker review, workflow promotion, etc. Reply HEARTBEAT_OK when done."

  # Merge heartbeat job into existing jobs.json if present, else create fresh
  if [ -f ~/.openclaw/cron/jobs.json ]; then
    # Read existing jobs array and append heartbeat job using node
    node -e "
      const fs = require('fs');
      const path = '${HOME}/.openclaw/cron/jobs.json';
      const data = JSON.parse(fs.readFileSync(path, 'utf8'));
      data.jobs = data.jobs.filter(j => j.name !== 'Heartbeat');
      data.jobs.push({
        name: 'Heartbeat',
        schedule: { kind: 'cron', expr: '0 */${HEARTBEAT_INTERVAL_HOURS} * * *' },
        sessionTarget: 'isolated',
        wakeMode: 'now',
        payload: { kind: 'agentTurn', message: $(node -e 'process.stdout.write(JSON.stringify(process.env.HEARTBEAT_MSG))') },
        delivery: { mode: 'none' }
      });
      fs.writeFileSync(path, JSON.stringify(data, null, 2));
    " HEARTBEAT_MSG="$HEARTBEAT_MSG" 2>/dev/null || true
  else
    node -e "
      const fs = require('fs');
      const msg = process.env.HEARTBEAT_MSG;
      const interval = parseInt(process.env.HEARTBEAT_INTERVAL_HOURS, 10) || 6;
      fs.writeFileSync('${HOME}/.openclaw/cron/jobs.json', JSON.stringify({
        version: 1,
        jobs: [{
          name: 'Heartbeat',
          schedule: { kind: 'cron', expr: '0 */' + interval + ' * * *' },
          sessionTarget: 'isolated',
          wakeMode: 'now',
          payload: { kind: 'agentTurn', message: msg },
          delivery: { mode: 'none' }
        }]
      }, null, 2));
    " HEARTBEAT_MSG="$HEARTBEAT_MSG" HEARTBEAT_INTERVAL_HOURS="$HEARTBEAT_INTERVAL_HOURS" 2>/dev/null || true
  fi
  echo "[startup] Heartbeat cron configured: every ${HEARTBEAT_INTERVAL_HOURS}h"
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
