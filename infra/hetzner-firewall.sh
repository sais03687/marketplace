#!/bin/sh
# The network boundary, as code.
#
# WHY THIS FILE EXISTS
# The single security boundary for the whole platform is a Hetzner Cloud Firewall
# rule that lived only in the Hetzner console — un-reviewable, un-versioned, and
# un-recreatable. If it were deleted, nobody could reconstruct it from the repo,
# and the provisioning service (3003, bound 0.0.0.0) plus every agent gateway
# would fall open to the internet with only their per-request token checks left.
# This makes the intended rules reviewable in git and recreatable with one command.
#
# WHAT THE BOUNDARY IS
# A Hetzner Cloud Firewall is default-DENY inbound once attached: only the rules
# below pass, everything else is dropped. So the rule set is just the allow-list
# of ports the public internet may reach. Everything else — 3003, agent gateways,
# any published container port — is private by omission. Outbound is unrestricted
# (the egress proxy governs agent traffic separately, inside Docker).
#
# INTENDED INBOUND RULES (source: verified against production with
# scripts/check-firewall-boundary.sh):
#   tcp 22    SSH            from 0.0.0.0/0, ::/0
#   tcp 80    HTTP           from 0.0.0.0/0, ::/0   (redirects to 443)
#   tcp 443   HTTPS          from 0.0.0.0/0, ::/0
#   icmp      ping           from 0.0.0.0/0, ::/0   (monitoring; harmless)
# Everything else inbound: DENIED by default.
#
# Consider tightening tcp 22 to your own admin IP/range later — left open here to
# match the current live posture, not because open SSH is ideal.
#
# USAGE
#   HCLOUD_TOKEN=... sh infra/hetzner-firewall.sh check      # read-only diff (default)
#   HCLOUD_TOKEN=... sh infra/hetzner-firewall.sh apply      # create/update the rules
#   HCLOUD_TOKEN=... SERVER=<name-or-id> sh infra/hetzner-firewall.sh attach
#
# check never changes anything. apply is idempotent — it sets the rule set to
# exactly what is defined here. attach binds the firewall to the server. The token
# is read from the environment and never stored; do not paste it into this file.

set -eu

FW_NAME="${FW_NAME:-marketplace-boundary}"
CMD="${1:-check}"

# The intended rule set, one rule per line: "protocol port". "icmp -" has no port.
INTENDED='tcp 22
tcp 80
tcp 443
icmp -'

need() { command -v "$1" >/dev/null 2>&1 || { echo "error: '$1' is required but not installed."; exit 2; }; }
need hcloud
: "${HCLOUD_TOKEN:?set HCLOUD_TOKEN to your Hetzner API token (never commit it)}"
export HCLOUD_TOKEN

print_intended() {
  echo "Intended inbound allow-list (firewall '$FW_NAME'), default-deny for the rest:"
  echo "$INTENDED" | while read -r proto port; do
    [ "$port" = "-" ] && echo "  $proto  from 0.0.0.0/0, ::/0" || echo "  $proto/$port  from 0.0.0.0/0, ::/0"
  done
}

case "$CMD" in
  check)
    print_intended
    echo
    if hcloud firewall describe "$FW_NAME" >/dev/null 2>&1; then
      echo "Live rules on '$FW_NAME':"
      hcloud firewall describe "$FW_NAME" -o json \
        | grep -E '"(protocol|port|direction)"' || true
      echo
      echo "Compare the live rules above against the intended list. Run 'apply' to reconcile."
    else
      echo "Firewall '$FW_NAME' does not exist yet. Run 'apply' to create it, then 'attach'."
    fi
    ;;

  apply)
    print_intended
    echo
    hcloud firewall describe "$FW_NAME" >/dev/null 2>&1 || {
      echo "Creating firewall '$FW_NAME'..."
      hcloud firewall create --name "$FW_NAME"
    }
    # Replace all inbound rules with exactly the intended set. hcloud replace-rules
    # takes the full desired state, so this is declarative, not additive.
    # Build the rules file (hcloud accepts a JSON rules file for atomic replace).
    RULES_JSON="$(
      printf '['
      first=1
      echo "$INTENDED" | while read -r proto port; do
        [ "$first" = 1 ] || printf ','
        first=0
        if [ "$port" = "-" ]; then
          printf '{"direction":"in","protocol":"%s","source_ips":["0.0.0.0/0","::/0"]}' "$proto"
        else
          printf '{"direction":"in","protocol":"%s","port":"%s","source_ips":["0.0.0.0/0","::/0"]}' "$proto" "$port"
        fi
      done
      printf ']'
    )"
    TMP="$(mktemp)"
    printf '%s' "$RULES_JSON" > "$TMP"
    echo "Applying declarative rule set..."
    hcloud firewall replace-rules "$FW_NAME" --rules-file "$TMP"
    rm -f "$TMP"
    echo "Done. Verify from OUTSIDE the box: sh scripts/check-firewall-boundary.sh"
    ;;

  attach)
    : "${SERVER:?set SERVER to the Hetzner server name or id to attach the firewall to}"
    echo "Attaching '$FW_NAME' to server '$SERVER'..."
    hcloud firewall apply-to-resource "$FW_NAME" --type server --server "$SERVER"
    echo "Done. Verify from OUTSIDE the box: sh scripts/check-firewall-boundary.sh"
    ;;

  *)
    echo "usage: $0 [check|apply|attach]"
    exit 2
    ;;
esac
