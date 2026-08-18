#!/usr/bin/env bash
# How many approval gates does a task raise, and is any of them the agent asking
# permission rather than the platform gating an action?
#
#   bash gate_count.sh E4 F1 E4 F3
#
# One decision should cost the manager one click. On 2026-08-18 E4 cost two: the
# agent raised request_decision asking "may I share this file?", and the platform
# then blocked drive_upload and asked the same thing itself. The prompt was
# changed to stop the agent asking for permission the platform asks for anyway,
# and this counts whether that held.
#
# Counted per run, from a marker written into the container log at the start of
# each one. The first version counted `docker logs --since 15m`, which is a
# window rather than a run: every task inherited the gates of the ones before it
# and the column read 2, 3, 4, 5 for four runs of one gate each. Only the
# differences meant anything, and nothing said so.
set -uo pipefail

CONTAINER=custom-agent-cmsmc95d
BENCH=/root/bench

printf '%-6s %-8s %-7s %-14s %s\n' task gates asks verdict where
for task in "$@"; do
  START=$(date -u +%Y-%m-%dT%H:%M:%S)
  bash "$BENCH/chaos.sh" "$task" --when none > "/tmp/gate_$task.log" 2>&1
  VERDICT=$(grep -oE '^(PASS|FAIL|INCOMPLETE|no reply arrived)' "/tmp/gate_$task.log" | head -1)

  # Everything the container logged since this run began.
  WINDOW=$(docker logs -t --since "${START}Z" "$CONTAINER" 2>&1)

  # One gate per approval queued. Unambiguous: it is written once, where the
  # "interrupting"/"gate reached" lines are printed again on every resume.
  GATES=$(printf '%s' "$WINDOW" | grep -c 'Queued approval' || true)

  # The agent asking rather than acting. Halved, because the line is printed
  # once when the graph stops and once when it resumes.
  RAW=$(printf '%s' "$WINDOW" | grep -c 'request_decision — interrupting' || true)
  ASKS=$(( (RAW + 1) / 2 ))

  printf '%-6s %-8s %-7s %-14s %s\n' \
         "$task" "$GATES" "$ASKS" "${VERDICT:-none}" "/tmp/gate_$task.log"
done
