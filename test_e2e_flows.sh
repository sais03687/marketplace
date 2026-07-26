#!/bin/bash
# End-to-end test suite — provisioning service, mail pollers, interrupt/resume,
# Teams, and AgentMind. Runs ON the Hetzner VPS (needs docker + localhost ports).
#
#   ssh root@<vps> 'bash /opt/marketplace/test_e2e_flows.sh --quick'
#
#   --quick   Phase 0 only: infrastructure + regression guards (~15s).
#             Use this after every deploy.
#   (no flag) Phase 0 + the full behavioural suite. The behavioural tests drive a
#             real agent and poll for up to 120s each, so budget ~10 minutes.
#
# Configuration comes from the environment. Secrets are NEVER hardcoded here —
# an earlier version of this file embedded the live PROVISIONING_SECRET in
# plaintext in a directory that is one `git add -A` away from a public repo.
REPO_DIR="${REPO_DIR:-/opt/marketplace}"
ENV_FILE="${ENV_FILE:-$REPO_DIR/.env.prod}"

# Load config from .env.prod, but the caller always wins — sourcing would
# otherwise clobber an override, which makes the guards untestable (you could
# never point the script at a known-bad tree to prove a check actually fires).
_OVERRIDES=""
for _v in TENANT_CACHE_PATH GOOGLE_SERVICE_ACCOUNT_KEY PROVISIONING_PORT \
          PROVISIONING_SECRET DATABASE_URL MARKETPLACE_URL; do
  if [ -n "${!_v+x}" ]; then
    _OVERRIDES="$_OVERRIDES $_v=$(printf '%q' "${!_v}")"
  fi
done
if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  set -a; . "$ENV_FILE"; set +a
fi
[ -n "$_OVERRIDES" ] && eval "export $_OVERRIDES"

CONTAINER_NAME="${CONTAINER_NAME:-custom-agent-cmq4lu66}"
DEPLOYMENT_ID="${TEST_DEPLOYMENT_ID:-cmq4lu66z00048ibfmndlexdv}"
CONTAINER_URL="${CONTAINER_URL:-http://localhost:32789}"
PROVISIONING_URL="${PROVISIONING_URL:-http://localhost:3003}"
PROVISIONING_PORT="${PROVISIONING_PORT:-3003}"
TENANT_CACHE_PATH="${TENANT_CACHE_PATH:-/var/lib/marketplace/tenant-cache.json}"
PROVISIONING_LOG="${PROVISIONING_LOG:-/var/log/marketplace-provisioning.log}"
JOBS_DIR="$REPO_DIR/apps/provisioning-service/src/jobs"

QUICK=0
[ "$1" = "--quick" ] && QUICK=1

PASS=0
FAIL=0
SKIP=0
TOTAL=0

pass() { PASS=$((PASS + 1)); TOTAL=$((TOTAL + 1)); echo "  ✅ PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); TOTAL=$((TOTAL + 1)); echo "  ❌ FAIL: $1"; }
skip() { SKIP=$((SKIP + 1)); echo "  ⏭️  SKIP: $1"; }

if [ -z "$PROVISIONING_SECRET" ]; then
  echo "FATAL: PROVISIONING_SECRET is not set and could not be read from $ENV_FILE."
  echo "       Export it or point ENV_FILE at the right file. It is not stored in this script."
  exit 2
fi

# ── Polling helpers (avoid time-window flakiness) ──
LOG_BASELINE=0
mark_log() { LOG_BASELINE=$(docker logs "$CONTAINER_NAME" 2>&1 | wc -l); }
get_new_logs() { docker logs "$CONTAINER_NAME" 2>&1 | tail -n +$((LOG_BASELINE + 1)); }

# Poll logs for a pattern, up to $2 seconds (default 90)
wait_for() {
  local pattern="$1"
  local timeout="${2:-90}"
  local elapsed=0
  while [ $elapsed -lt $timeout ]; do
    if get_new_logs | grep -q "$pattern"; then
      return 0
    fi
    sleep 3
    elapsed=$((elapsed + 3))
  done
  return 1
}

echo "============================================"
echo "E2E Suite — infra + interrupt/resume + AgentMind"
echo "  container:  $CONTAINER_NAME"
echo "  deployment: $DEPLOYMENT_ID"
echo "  mode:       $([ $QUICK -eq 1 ] && echo 'quick (Phase 0 only)' || echo 'full')"
echo "============================================"
echo ""

# ═════════════════════════════════════════════════════════════════════════════
# PHASE 0 — Infrastructure and regression guards
#
# Every check here corresponds to something that has actually broken in
# production. These are cheap and deterministic; run them after every deploy.
# ═════════════════════════════════════════════════════════════════════════════
echo "── PHASE 0: infrastructure + regression guards ──"

# 0.1 Postgres reachable. Neon suspends the compute when its quota is exhausted,
# which is what took mail down for six days.
if [ -n "$DATABASE_URL" ] && command -v psql >/dev/null 2>&1; then
  if timeout 30 psql "$DATABASE_URL" -tAc "select 1" >/dev/null 2>&1; then
    pass "Postgres reachable"
  else
    fail "Postgres unreachable (Neon suspended, or bad DATABASE_URL)"
  fi
else
  skip "Postgres check (no psql or DATABASE_URL)"
fi

# 0.2 Provisioning service is actually serving, not merely 'online' in pm2.
if ss -ltn 2>/dev/null | grep -q ":$PROVISIONING_PORT"; then
  pass "Provisioning service listening on :$PROVISIONING_PORT"
else
  fail "Nothing listening on :$PROVISIONING_PORT (pm2 may report online while the env is wrong)"
fi

# 0.3 Graph token minting — the path that was down for six days.
MINT_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$PROVISIONING_URL/internal/microsoft-token" \
  -H "Content-Type: application/json" -d "{\"deploymentId\":\"$DEPLOYMENT_ID\"}")
if [ "$MINT_CODE" = "200" ]; then
  pass "Graph token minted (HTTP 200)"
else
  fail "Token mint returned HTTP $MINT_CODE (expected 200)"
fi

# 0.4 An unknown deployment must 404, not 500. It returned 500 for six days
# because the Prisma lookup threw before the tenant was ever resolved.
UNKNOWN_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$PROVISIONING_URL/internal/microsoft-token" \
  -H "Content-Type: application/json" -d '{"deploymentId":"definitely-does-not-exist"}')
if [ "$UNKNOWN_CODE" = "404" ]; then
  pass "Unknown deployment returns 404 (not a 500 from a DB throw)"
else
  fail "Unknown deployment returned HTTP $UNKNOWN_CODE (expected 404)"
fi

# 0.5 The tenant cache must live OUTSIDE the repo. If TENANT_CACHE_PATH is unset
# it silently defaults to the service's cwd, dropping state inside the git tree.
if [ -f "$TENANT_CACHE_PATH" ]; then
  pass "Tenant cache present at $TENANT_CACHE_PATH"
  case "$TENANT_CACHE_PATH" in
    "$REPO_DIR"*) fail "Tenant cache is INSIDE the repo ($TENANT_CACHE_PATH)" ;;
    *) pass "Tenant cache is outside the repo" ;;
  esac
else
  fail "Tenant cache missing at $TENANT_CACHE_PATH"
fi

# 0.6 Cache is actually loaded at boot — proves the disk mirror works, which is
# what keeps token minting alive across a restart while Postgres is down.
if grep -q "loaded .* cached tenant" "$PROVISIONING_LOG" 2>/dev/null; then
  pass "Tenant cache loaded from disk at boot"
else
  skip "No cache-load line in $PROVISIONING_LOG (log may have rotated)"
fi

# 0.7 Redis must be Upstash. A pm2 delete/start without sourcing .env.prod brings
# the service up pointing at localhost:6379, which fails closed and silently.
if grep -q "ECONNREFUSED.*6379\|connect ECONNREFUSED 127.0.0.1:6379" "$PROVISIONING_LOG" 2>/dev/null; then
  fail "Service is falling back to localhost Redis — .env.prod was not loaded"
else
  pass "No localhost Redis fallback (Upstash env loaded)"
fi

# 0.8 Google Workspace is retired; every deployment is workspaceProvider=MICROSOFT.
# Setting GOOGLE_SERVICE_ACCOUNT_KEY resurrects a 30s Drive poll per poller.
if [ -n "$GOOGLE_SERVICE_ACCOUNT_KEY" ]; then
  fail "GOOGLE_SERVICE_ACCOUNT_KEY is set — drive-watcher will poll a retired provider"
else
  pass "Google service account unset (drive-watcher stays disabled)"
fi

# 0.9 Structural guard: the allowlist must not be refreshed on a timer. A fixed
# heartbeat queries the marketplace API (and Postgres) around the clock, which
# prevents Neon from ever scaling to zero.
# Derived from the pollers that actually exist rather than a hardcoded count:
# AgentMail was retired, so hardcoding "2" turned its removal into a test failure.
POLLERS=""
for f in "$JOBS_DIR"/*-poller.mjs; do
  [ -f "$f" ] && POLLERS="$POLLERS $f"
done
POLLER_COUNT=$(echo $POLLERS | wc -w)

TIMER_HITS=0
for f in $POLLERS; do
  if grep -qE "setInterval\(\s*(fetchAllowlist|ensureAllowlist)" "$f"; then
    TIMER_HITS=$((TIMER_HITS + 1))
  fi
done
if [ "$TIMER_HITS" -eq 0 ]; then
  pass "No timer-based allowlist refresh in either poller"
else
  fail "$TIMER_HITS poller(s) refresh the allowlist on a timer — Postgres will never idle"
fi

# 0.10 Structural guard: a message blocked by the allowlist must not be retained
# or marked read, or it is dropped permanently and cannot be redelivered after
# the sender is added to the allowlist.
DENY_OK=0
for f in $POLLERS; do
  if grep -q "processedIds.delete" "$f"; then
    DENY_OK=$((DENY_OK + 1))
  fi
done
if [ "$POLLER_COUNT" -gt 0 ] && [ "$DENY_OK" -eq "$POLLER_COUNT" ]; then
  pass "Deny path releases held mail in all $POLLER_COUNT poller(s) (redelivery possible)"
else
  fail "Only $DENY_OK/$POLLER_COUNT pollers release denied mail — blocked messages are dropped"
fi

# 0.11 Agent container up.
if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${CONTAINER_NAME}$"; then
  pass "Agent container $CONTAINER_NAME running"
else
  fail "Agent container $CONTAINER_NAME not running"
fi

# 0.12 Auth: /internal/* must reject a bad or missing bearer token.
BAD_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$PROVISIONING_URL/internal/forward-resolve" \
  -H "Content-Type: application/json" -H "Authorization: Bearer WRONGTOKEN" \
  -d '{"containerName":"http://localhost:32789","approvalId":"fake","action":"APPROVED"}')
NO_AUTH_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$PROVISIONING_URL/internal/forward-resolve" \
  -H "Content-Type: application/json" \
  -d '{"containerName":"http://localhost:32789","approvalId":"fake","action":"APPROVED"}')
if [ "$BAD_CODE" = "401" ] && [ "$NO_AUTH_CODE" = "401" ]; then
  pass "forward-resolve rejects bad and missing tokens (401)"
else
  fail "Auth not enforced: bad=$BAD_CODE missing=$NO_AUTH_CODE (expected 401/401)"
fi

echo ""

if [ $QUICK -eq 1 ]; then
  echo "============================================"
  echo "RESULTS (quick): $PASS/$TOTAL passed, $FAIL failed, $SKIP skipped"
  echo "============================================"
  [ $FAIL -eq 0 ] || exit 1
  exit 0
fi

# ═════════════════════════════════════════════════════════════════════════════
# PHASE 1+ — Behavioural tests. These drive a real agent and are slow.
# ═════════════════════════════════════════════════════════════════════════════

# ─────────────────────────────────────────────
# TEST 1: Email — blocked action triggers interrupt
# ─────────────────────────────────────────────
echo "── TEST 1: Email — excel_write triggers interrupt ──"
mark_log
RESP=$(curl -s -X POST "$CONTAINER_URL/hooks/agentmail" \
  -H "Content-Type: application/json" \
  -d '{"message":{"from":"sai@agents.agentstore.it.com","to":"agent@agentmail.to","subject":"Update Financials","text":"Write Q1=100 to q2-financials.xlsx spreadsheet","thread_id":"e2e-test-thread-1","message_id":"e2e-msg-1"}}')
echo "  Hook response: $RESP"
if echo "$RESP" | grep -q '"ok":true'; then
  pass "Email hook accepted"
else
  fail "Email hook rejected: $RESP"
fi

echo "  Polling for approval queue (up to 90s)..."
# Poll for "Queued approval" — it's the last event in the chain, so all earlier
# patterns (BLOCKED action, Graph interrupted) are guaranteed present by then.
if wait_for "Queued approval.*e2e-test-thread-1\|Email graph interrupted" 90; then
  LOGS=$(get_new_logs)

  if echo "$LOGS" | grep -q "BLOCKED action\|Graph interrupted"; then
    pass "Blocked action detected and interrupted"
  else
    fail "No blocked action in logs"
  fi

  if echo "$LOGS" | grep -q "Graph interrupted"; then
    pass "Graph interrupted"
  else
    fail "Graph not interrupted"
  fi

  if echo "$LOGS" | grep -q "Queued approval"; then
    pass "Approval queued"
  else
    fail "Approval not queued"
  fi

  # Extract approval ID
  APPROVAL_ID=$(echo "$LOGS" | grep -oP 'Queued approval \K[a-z0-9]+' | tail -1)
  THREAD_ID=$(echo "$LOGS" | grep -oP 'thread=\Kemail:[^ )]+' | tail -1)
  echo "  Approval ID: $APPROVAL_ID"
  echo "  Thread ID: $THREAD_ID"

  if echo "$LOGS" | grep -q "Email graph interrupted"; then
    pass "Sender notification triggered"
  else
    fail "No sender notification"
  fi
else
  fail "Timed out waiting for email interrupt flow"
fi

echo ""

# ─────────────────────────────────────────────
# TEST 2: Resolution forwarding works
# ─────────────────────────────────────────────
echo "── TEST 2: Forward-resolve endpoint ──"
if [ -n "$APPROVAL_ID" ]; then
  mark_log
  RESOLVE_RESP=$(curl -s -X POST "$PROVISIONING_URL/internal/forward-resolve" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $PROVISIONING_SECRET" \
    -d "{\"containerName\":\"$CONTAINER_URL\",\"approvalId\":\"$APPROVAL_ID\",\"action\":\"APPROVED\"}")
  echo "  Resolve response: $RESOLVE_RESP"
  if echo "$RESOLVE_RESP" | grep -q '"ok":true'; then
    pass "Forward-resolve returned ok"
  else
    fail "Forward-resolve failed: $RESOLVE_RESP"
  fi

  echo "  Polling for resume + delivery (up to 90s)..."
  if wait_for "Post-resume" 90; then
    RESUME_LOGS=$(get_new_logs)

    if echo "$RESUME_LOGS" | grep -q "Resuming graph"; then
      pass "Graph resumed"
    else
      fail "Graph not resumed"
    fi

    if echo "$RESUME_LOGS" | grep -q "APPROVED.*executing"; then
      pass "Action executed after approval"
    else
      fail "Action not executed after approval"
    fi

    if echo "$RESUME_LOGS" | grep -q "Post-resume"; then
      pass "Result delivered via email"
    else
      fail "Result not delivered"
    fi
  else
    fail "Graph not resumed (timed out)"
  fi
else
  fail "No approval ID — skipping resolve test"
fi

echo ""

# ─────────────────────────────────────────────
# TEST 3: Email — non-blocked action (no interrupt)
# ─────────────────────────────────────────────
echo "── TEST 3: Email — non-blocked action (excel_read, no interrupt) ──"
mark_log
RESP=$(curl -s -X POST "$CONTAINER_URL/hooks/agentmail" \
  -H "Content-Type: application/json" \
  -d '{"message":{"from":"sai@agents.agentstore.it.com","to":"agent@agentmail.to","subject":"Read Data","text":"What data is in the q2-financials.xlsx spreadsheet? Just read it and tell me.","thread_id":"e2e-test-thread-2","message_id":"e2e-msg-2"}}')
if echo "$RESP" | grep -q '"ok":true'; then
  pass "Non-blocked email hook accepted"
else
  fail "Non-blocked email hook rejected"
fi

echo "  Polling for agent to complete read + reply (up to 120s)..."
# Poll for the final event — run_agent returning — so all intermediate logs are present
if wait_for "run_agent returning\|completed.*true" 120; then
  READ_LOGS=$(get_new_logs)

  if echo "$READ_LOGS" | grep -q "excel_read\|Excel read"; then
    pass "Excel read executed (no interrupt)"
  else
    fail "Excel read not found in logs"
  fi

  if echo "$READ_LOGS" | grep -q "BLOCKED action"; then
    fail "Read action was incorrectly blocked"
  else
    pass "Read action was NOT blocked (correct)"
  fi

  if echo "$READ_LOGS" | grep -q "reply_email\|send_email\|completed.*true"; then
    pass "Reply email sent for read result"
  else
    fail "No reply email for read result"
  fi
else
  fail "Timed out waiting for excel_read processing"
fi

echo ""

# ─────────────────────────────────────────────
# TEST 4: Teams — blocked action triggers interrupt
# ─────────────────────────────────────────────
echo "── TEST 4: Teams — excel_write triggers interrupt ──"
mark_log
RESP=$(curl -s -X POST "$CONTAINER_URL/hooks/teams" \
  -H "Content-Type: application/json" \
  -d '{"message":"Append a new row with headers Revenue, Cost, Profit and values 5000, 3000, 2000 to q2-financials.xlsx","conversationId":"e2e-teams-conv-1","userId":"user-001","userName":"Test User","tenantId":"test-tenant-001"}')
echo "  Hook response: $(echo $RESP | head -c 200)"

echo "  Polling for Teams approval queue (up to 90s)..."
if wait_for "Queued approval.*e2e-teams-conv-1\|Teams run_agent result.*interrupted" 90; then
  TEAMS_LOGS=$(get_new_logs)

  if echo "$TEAMS_LOGS" | grep -q "BLOCKED action"; then
    pass "Teams: blocked action detected"
  else
    fail "Teams: no blocked action"
  fi

  if echo "$TEAMS_LOGS" | grep -q "Queued approval"; then
    pass "Teams: approval queued"
  else
    fail "Teams: approval not queued"
  fi
else
  fail "Teams: timed out waiting for interrupt flow"
fi

TEAMS_LOGS=$(get_new_logs)
TEAMS_APPROVAL=$(echo "$TEAMS_LOGS" | grep -oP 'Queued approval \K[a-z0-9]+' | tail -1)
echo "  Teams approval ID: $TEAMS_APPROVAL"

echo ""

# ─────────────────────────────────────────────
# TEST 5: Teams — resolve and resume
# ─────────────────────────────────────────────
echo "── TEST 5: Teams — resolve, resume, and deliver ──"
if [ -n "$TEAMS_APPROVAL" ]; then
  mark_log
  RESOLVE_RESP=$(curl -s -X POST "$PROVISIONING_URL/internal/forward-resolve" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $PROVISIONING_SECRET" \
    -d "{\"containerName\":\"$CONTAINER_URL\",\"approvalId\":\"$TEAMS_APPROVAL\",\"action\":\"APPROVED\"}")
  if echo "$RESOLVE_RESP" | grep -q '"ok":true'; then
    pass "Teams: forward-resolve ok"
  else
    fail "Teams: forward-resolve failed: $RESOLVE_RESP"
  fi

  echo "  Polling for Teams resume + delivery (up to 90s)..."
  if wait_for "Post-resume" 90; then
    RESUME_LOGS=$(get_new_logs)

    if echo "$RESUME_LOGS" | grep -q "Resuming graph"; then
      pass "Teams: graph resumed"
    else
      fail "Teams: graph not resumed"
    fi

    if echo "$RESUME_LOGS" | grep -q "APPROVED.*executing"; then
      pass "Teams: action executed after approval"
    else
      fail "Teams: action not executed"
    fi

    pass "Teams: post-resume result generated"
  else
    fail "Teams: timed out waiting for resume"
  fi
else
  fail "No Teams approval ID — skipping"
fi

echo ""

# ─────────────────────────────────────────────
# TEST 6: Rejection flow
# ─────────────────────────────────────────────
echo "── TEST 6: Email — rejection flow ──"
mark_log
RESP=$(curl -s -X POST "$CONTAINER_URL/hooks/agentmail" \
  -H "Content-Type: application/json" \
  -d '{"message":{"from":"sai@agents.agentstore.it.com","to":"agent@agentmail.to","subject":"Delete Old Data","text":"Write DELETED to cell A1 in q2-financials.xlsx spreadsheet to clear it","thread_id":"e2e-test-thread-reject2","message_id":"e2e-msg-reject2"}}')
if echo "$RESP" | grep -q '"ok":true'; then
  pass "Rejection test: hook accepted"
else
  fail "Rejection test: hook rejected"
fi

echo "  Polling for approval queue (up to 90s)..."
if wait_for "Queued approval" 90; then
  REJECT_LOGS=$(get_new_logs)
  REJECT_APPROVAL=$(echo "$REJECT_LOGS" | grep -oP 'Queued approval \K[a-z0-9]+' | tail -1)
  pass "Rejection test: approval queued ($REJECT_APPROVAL)"

  mark_log
  RESOLVE_RESP=$(curl -s -X POST "$PROVISIONING_URL/internal/forward-resolve" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $PROVISIONING_SECRET" \
    -d "{\"containerName\":\"$CONTAINER_URL\",\"approvalId\":\"$REJECT_APPROVAL\",\"action\":\"REJECTED\",\"rejectionReason\":\"Not authorized for this operation\"}")
  if echo "$RESOLVE_RESP" | grep -q '"ok":true'; then
    pass "Rejection: resolve forwarded"
  else
    fail "Rejection: resolve failed"
  fi

  echo "  Polling for rejection handling (up to 60s)..."
  if wait_for "REJECTED\|rejected\|Resuming graph" 60; then
    pass "Rejection: agent handled resolution"
  else
    fail "Rejection: agent didn't handle resolution"
  fi
else
  fail "Rejection test: no approval queued (action may not have been blocked)"
fi

echo ""

# ─────────────────────────────────────────────
# TEST 7: AgentMind — contribute and search
# ─────────────────────────────────────────────
echo "── TEST 7: AgentMind — contribute/search wired ──"
# Check all logs for AgentMind calls
ALL_LOGS=$(docker logs "$CONTAINER_NAME" 2>&1)

if echo "$ALL_LOGS" | grep -q "agentmind\|contribute_knowledge\|search_knowledge\|AgentMind"; then
  pass "AgentMind references found in logs"
else
  if docker exec "$CONTAINER_NAME" grep -q "contribute_fn\|search_fn" /agent/adapter.py; then
    pass "AgentMind functions wired in adapter (contribute_fn, search_fn)"
  else
    fail "AgentMind not wired"
  fi
fi

# Verify contribute_knowledge and search_knowledge are defined
if docker exec "$CONTAINER_NAME" grep -q "async def contribute_knowledge" /agent/adapter.py; then
  pass "contribute_knowledge function defined"
else
  fail "contribute_knowledge function missing"
fi

if docker exec "$CONTAINER_NAME" grep -q "async def search_knowledge" /agent/adapter.py; then
  pass "search_knowledge function defined"
else
  fail "search_knowledge function missing"
fi

# Verify both Teams and email handlers pass AgentMind
TEAMS_AGENTMIND=$(docker exec "$CONTAINER_NAME" grep -c "contribute_fn=contribute_knowledge" /agent/adapter.py)
if [ "$TEAMS_AGENTMIND" -ge 2 ]; then
  pass "AgentMind wired in multiple handlers (Teams + email + retries)"
else
  fail "AgentMind only wired $TEAMS_AGENTMIND time(s) — expected >= 2"
fi

echo ""

# ─────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────
echo "============================================"
echo "RESULTS: $PASS/$TOTAL passed, $FAIL failed, $SKIP skipped"
echo "============================================"
[ $FAIL -eq 0 ] || exit 1
exit 0
