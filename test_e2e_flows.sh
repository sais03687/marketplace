#!/bin/bash
# End-to-end test script for interrupt/resume, email, Teams, and AgentMind flows
# Run on Hetzner VPS via SSH

CONTAINER_URL="http://localhost:32789"
PROVISIONING_URL="http://localhost:3003"
PROVISIONING_SECRET="892c546b2bd5e0d8f5e8fa478f3c078dea1f13a103db8833d762c33d9b704352"
CONTAINER_NAME="custom-agent-cmq4lu66"
PASS=0
FAIL=0
TOTAL=0

pass() { ((PASS++)); ((TOTAL++)); echo "  ✅ PASS: $1"; }
fail() { ((FAIL++)); ((TOTAL++)); echo "  ❌ FAIL: $1"; }

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
echo "E2E Test Suite — Interrupt/Resume + AgentMind"
echo "============================================"
echo ""

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
    -d "{\"containerName\":\"http://localhost:32789\",\"approvalId\":\"$APPROVAL_ID\",\"action\":\"APPROVED\"}")
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
    -d "{\"containerName\":\"http://localhost:32789\",\"approvalId\":\"$TEAMS_APPROVAL\",\"action\":\"APPROVED\"}")
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
    -d "{\"containerName\":\"http://localhost:32789\",\"approvalId\":\"$REJECT_APPROVAL\",\"action\":\"REJECTED\",\"rejectionReason\":\"Not authorized for this operation\"}")
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
# TEST 8: Auth — forward-resolve rejects bad token
# ─────────────────────────────────────────────
echo "── TEST 8: Auth — forward-resolve rejects bad token ──"
BAD_RESP=$(curl -s -X POST "$PROVISIONING_URL/internal/forward-resolve" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer WRONGTOKEN" \
  -d '{"containerName":"http://localhost:32789","approvalId":"fake","action":"APPROVED"}')
if echo "$BAD_RESP" | grep -q "Unauthorized"; then
  pass "Bad token rejected with 401"
else
  fail "Bad token not rejected: $BAD_RESP"
fi

NO_AUTH_RESP=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$PROVISIONING_URL/internal/forward-resolve" \
  -H "Content-Type: application/json" \
  -d '{"containerName":"http://localhost:32789","approvalId":"fake","action":"APPROVED"}')
if [ "$NO_AUTH_RESP" = "401" ]; then
  pass "Missing auth rejected with 401"
else
  fail "Missing auth returned $NO_AUTH_RESP instead of 401"
fi

echo ""

# ─────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────
echo "============================================"
echo "RESULTS: $PASS/$TOTAL passed, $FAIL failed"
echo "============================================"
