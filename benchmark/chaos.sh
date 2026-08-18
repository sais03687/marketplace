#!/usr/bin/env bash
# Run a benchmark task with the agent container restarted underneath it.
#
# Why this exists. On 2026-08-18 two bugs shipped green: produced files were
# saved under a sanitised name and looked up under the real one, so nothing
# could find them; and two ids that sanitise alike overwrote each other. The
# unit suite could not see either, because both sides of every test ran in one
# process and agreed with each other. What found them was restarting the
# container mid-run, by hand, once. By hand once is not a test.
#
#   bash chaos.sh F3 --when file        # restart as soon as a workbook exists
#   bash chaos.sh F3 --when approval    # restart while it waits for approval
#   bash chaos.sh F3 --when none        # control: same task, no restart
#
# `--when file` is the interesting one: the work is done and held only in memory
# and on disk, which is the window both bugs lived in.
set -uo pipefail

BENCH=/root/bench
CONTAINER=custom-agent-cmsmc95d
ENVFILE=/opt/marketplace/.env.prod

TASK="${1:?usage: chaos.sh <TASKID> [--when file|approval|none] [--match SUBSTRING]}"
shift
WHEN=file
MATCH=""
while [ $# -gt 0 ]; do
  case "$1" in
    --when)  WHEN="$2"; shift 2 ;;
    --match) MATCH="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$MATCH" ]; then
  MATCH=$(node "$BENCH/task_subject.mjs" "$TASK") || exit 1
fi

DATA=$(docker exec "$CONTAINER" sh -c 'ls -d /data/*/sandbox_files 2>/dev/null | head -1' | tr -d '\r')
if [ -z "$DATA" ]; then echo "could not locate sandbox_files" >&2; exit 1; fi

count_files() {
  docker exec "$CONTAINER" sh -c "ls $DATA/*.bin 2>/dev/null | wc -l" | tr -d '\r '
}

BEFORE=$(count_files)
SINCE=$(date -u +%Y-%m-%dT%H:%M:%SZ)
printf 'task         : %s\nsubject      : %s\nrestart when : %s\nfiles now    : %s\n\n' \
       "$TASK" "$MATCH" "$WHEN" "$BEFORE"

node --env-file="$ENVFILE" "$BENCH/send_wave.mjs" "$TASK" || exit 1

case "$WHEN" in
  file)
    echo "waiting for the agent to produce a file..."
    for _ in $(seq 1 80); do
      NOW=$(count_files)
      if [ "${NOW:-0}" -gt "${BEFORE:-0}" ]; then
        echo "a new file exists ($BEFORE -> $NOW) — restarting now"
        docker restart "$CONTAINER" >/dev/null
        echo "restarted at $(date -u +%H:%M:%SZ)"
        break
      fi
      sleep 15
    done
    ;;
  approval)
    echo "waiting for the approval request..."
    for _ in $(seq 1 80); do
      if docker logs --since "$SINCE" "$CONTAINER" 2>&1 | grep -q "queue_for_approval"; then
        echo "approval queued — restarting now"
        docker restart "$CONTAINER" >/dev/null
        break
      fi
      sleep 15
    done
    ;;
  none) echo "control run: no restart" ;;
  *) echo "unknown --when: $WHEN" >&2; exit 2 ;;
esac

echo
echo "waiting for the reply..."
OUT=$(mktemp)
node --env-file="$ENVFILE" "$BENCH/await_reply.mjs" \
     --contains "$MATCH" --since "$SINCE" --timeout 1500 --json > "$OUT"
if [ $? -ne 0 ]; then echo "no reply arrived"; rm -f "$OUT"; exit 1; fi

AFTER=$(count_files)
node "$BENCH/check_reply.mjs" "$OUT" "$AFTER" "$BEFORE"
RC=$?
rm -f "$OUT"
exit $RC
