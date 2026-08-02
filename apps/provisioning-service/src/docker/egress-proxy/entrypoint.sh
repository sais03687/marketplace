#!/bin/sh
set -eu

# ── Egress: build the allowlist filter from ALLOWED_DOMAINS ──────────────────
#
# tinyproxy matches these extended regexes against the destination host. With
# FilterDefaultDeny on, a host matching nothing is refused, so this is an
# allowlist — and an empty or malformed ALLOWED_DOMAINS denies everything rather
# than allowing everything. That direction is deliberate: an agent that cannot
# reach the internet is a broken agent, one that can reach all of it is a breach.

FILTER=/etc/tinyproxy/filter
: > "$FILTER"

if [ -n "${ALLOWED_DOMAINS:-}" ]; then
  echo "$ALLOWED_DOMAINS" | tr ',' '\n' | while IFS= read -r raw; do
    domain=$(printf '%s' "$raw" | tr -d '[:space:]')
    [ -z "$domain" ] && continue
    # Anchor both ends and escape dots, so "graph.microsoft.com.attacker.co"
    # cannot match an entry for "graph.microsoft.com". Subdomains are permitted
    # via the optional leading group.
    escaped=$(printf '%s' "$domain" | sed 's/\./\\./g')
    printf '^([a-zA-Z0-9_-]+\\.)*%s$\n' "$escaped" >> "$FILTER"
  done
fi

echo "[netgate] egress allowlist ($(wc -l < "$FILTER") rule(s), everything else denied):" >&2
cat "$FILTER" >&2

cat > /etc/tinyproxy/tinyproxy.conf <<EOF
User tinyproxy
Group tinyproxy
Port 8888
Listen 0.0.0.0
Timeout 600
LogLevel Info

# Who may use the proxy. The agent network is Internal, so only containers on it
# can reach this at all; this is a second bound, not the primary one.
Allow 0.0.0.0/0

MaxClients 50
StartServers 2
MinSpareServers 2
MaxSpareServers 5

Filter "$FILTER"
FilterExtended On
# FilterDefaultDeny is what makes this an allowlist rather than a blocklist —
# without it an unmatched host would be permitted.
FilterDefaultDeny Yes
# Match the host, not the path: a URL filter would not apply to CONNECT, which is
# how all HTTPS traffic arrives.
FilterURLs Off

# HTTPS arrives as CONNECT. Restricting which ports it may open stops the proxy
# being used to reach arbitrary services on an otherwise allowed host.
ConnectPort 443
ConnectPort 80
EOF

# ── Ingress: forward the published port to the agent ─────────────────────────
#
# Docker will not publish a port for a container on an Internal network, so the
# platform cannot reach the agent's gateway directly. socat resolves AGENT_HOST
# per connection rather than at startup, which matters because this container
# starts first — the agent does not exist yet when this line runs.
if [ -n "${AGENT_HOST:-}" ]; then
  echo "[netgate] ingress :4000 -> ${AGENT_HOST}:4000" >&2
  socat TCP-LISTEN:4000,fork,reuseaddr "TCP:${AGENT_HOST}:4000" &
fi

exec tinyproxy -d -c /etc/tinyproxy/tinyproxy.conf
