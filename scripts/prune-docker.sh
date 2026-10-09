#!/bin/sh
# Weekly disk cleanup for the agent host. Tracked here; the copy that runs is
# /opt/marketplace/scripts/prune-docker.sh, from root's crontab:
#
#   0 4 * * 0  /opt/marketplace/scripts/prune-docker.sh >> /var/log/marketplace-prune.log 2>&1
#
# Every hire builds its own image (350-840 MB) and firing it removes the
# container but not the image, so the disk filled a little with each hire and
# test: 19 GB of them had built up by 2026-10-09. Removing them is safe because
# provisioning always builds the image afresh, resume included.
#
# Only agent and vetting images are touched, and only ones no container uses
# (running or stopped) and that are over a day old. The age check matters: a
# hire's image exists for a moment before its container does, and removing it
# then would fail that hire. Base images (python, alpine) and platform images
# (netgate, the python sandbox) are left alone so builds stay fast.
set -u
echo "=== $(date -u '+%F %T UTC') prune start — $(df -h / | awk 'NR==2 {print $3 " used, " $4 " free"}')"

used=$(docker ps -a --format '{{.Image}}' | sort -u)
cutoff=$(date -u -d '24 hours ago' +%s)

docker images --format '{{.Repository}}:{{.Tag}}' | grep -E '^marketplace/(custom|vet)-' | while read -r ref; do
  if echo "$used" | grep -qxF "$ref"; then
    continue
  fi
  created=$(date -u -d "$(docker image inspect -f '{{.Created}}' "$ref" 2>/dev/null)" +%s 2>/dev/null || echo 0)
  if [ "$created" -eq 0 ] || [ "$created" -gt "$cutoff" ]; then
    echo "  kept (newer than a day) $ref"
    continue
  fi
  # No -f: if a container started using it since the check above, docker refuses.
  if docker rmi "$ref" >/dev/null 2>&1; then echo "  removed $ref"; else echo "  kept (in use) $ref"; fi
done

echo "  untagged layers: $(docker image prune -f 2>/dev/null | tail -1)"
echo "  build cache over a week old: $(docker builder prune -f --filter until=168h 2>/dev/null | tail -1)"
echo "=== prune done — $(df -h / | awk 'NR==2 {print $3 " used, " $4 " free"}')"
