#!/bin/sh
# Assert the network boundary holds — run this FROM OUTSIDE the VPS.
#
# The whole security model rests on a Hetzner Cloud Firewall rule that is not in
# any repo (see RUNBOOK "The firewall"). The provisioning service binds 3003 on
# 0.0.0.0 and agent gateways are reachable on the host; what keeps them off the
# public internet is that firewall, and nothing else. If the rule is ever removed
# or widened, the per-request token checks become the ONLY line of defence instead
# of the second one they were designed to be.
#
# This turns the RUNBOOK's manual curl checks into a pass/fail assertion so the
# posture can be verified on a schedule (a cron on any machine that is NOT the
# VPS, or by hand after any Hetzner networking change) rather than remembered.
#
# Exit 0 = boundary intact. Exit 1 = a port that must be private answered — FIX
# THE FIREWALL BEFORE ANYTHING ELSE.
#
# Usage: sh scripts/check-firewall-boundary.sh [host]
#   host defaults to the production IP.

set -eu

HOST="${1:-5.161.125.216}"
TIMEOUT=8
fail=0

# Ports that MUST be reachable from the internet (the public web app).
# A timeout here is a real outage, not a security problem, but still worth knowing.
PUBLIC_PORTS="80 443"

# Ports that MUST NOT be reachable from the internet. A response here is a breach:
# the cloud firewall has been removed or widened.
PRIVATE_PORTS="3003 4000 4001 8080"

echo "Probing $HOST — public ports should answer, private ports should time out."
echo

for p in $PUBLIC_PORTS; do
  # -k: we only care that TLS/HTTP connects, not that the cert matches this raw IP.
  scheme="http"; [ "$p" = "443" ] && scheme="https"
  if curl -k -m "$TIMEOUT" -s -o /dev/null "$scheme://$HOST:$p/" 2>/dev/null; then
    echo "  ok    $p reachable (public, expected)"
  else
    echo "  WARN  $p NOT reachable — the web app may be down (not a security issue)"
  fi
done

for p in $PRIVATE_PORTS; do
  # No -k and no scheme assumptions: any completed connection is bad. curl exit 0
  # means it connected and got a response — a breach. Timeout/refused is the
  # intended state.
  if curl -m "$TIMEOUT" -s -o /dev/null "http://$HOST:$p/" 2>/dev/null; then
    echo "  FAIL  $p ANSWERED from the internet — the firewall is breached"
    fail=1
  else
    echo "  ok    $p blocked (private, expected)"
  fi
done

echo
if [ "$fail" -ne 0 ]; then
  echo "BOUNDARY BREACHED. A port that must be private is reachable from the internet."
  echo "Check the Hetzner Cloud Firewall rule immediately (see RUNBOOK and infra/hetzner-firewall.sh)."
  exit 1
fi
echo "Boundary intact."
