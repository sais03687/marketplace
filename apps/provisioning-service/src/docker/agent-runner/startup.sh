#!/bin/bash
set -e

echo "[startup] Agent runner starting..."
echo "[startup] Deployment ID: ${DEPLOYMENT_ID}"
echo "[startup] Agent: ${AGENT_NAME}"
echo "[startup] Company: ${COMPANY_NAME}"

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
  }
}
JSONEOF

# 2. Replace template placeholders in workspace files
for f in /agent/workspace/SOUL.md /agent/workspace/onboarding/MEMORY_TEMPLATE.md; do
  if [ -f "$f" ]; then
    sed -i "s|{{AGENT_NAME}}|${AGENT_NAME}|g" "$f"
    sed -i "s|{{COMPANY_NAME}}|${COMPANY_NAME}|g" "$f"
    sed -i "s|{{COMPANY_DOMAIN}}|${COMPANY_DOMAIN}|g" "$f"
    sed -i "s|{{AGENT_EMAIL}}|${AGENT_EMAIL}|g" "$f"
    sed -i "s|{{GOOGLE_SERVICE_ACCOUNT_EMAIL}}|${GOOGLE_SERVICE_ACCOUNT_EMAIL}|g" "$f"
  fi
done

# Copy MEMORY_TEMPLATE as MEMORY.md if it doesn't exist yet
if [ ! -f /agent/workspace/MEMORY.md ] && [ -f /agent/workspace/onboarding/MEMORY_TEMPLATE.md ]; then
  cp /agent/workspace/onboarding/MEMORY_TEMPLATE.md /agent/workspace/MEMORY.md
fi

# 3. Start the internal API in the background
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

# 4. Start OpenClaw gateway
echo "[startup] Starting OpenClaw gateway..."
exec openclaw start --config /agent/openclaw.json --workspace /agent/workspace
