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

# Hosts a creator declared in their manifest are matched exactly — no
# subdomains. Allowing "github.com" must not also allow "gist.github.com",
# which anyone can write to. The platform's own hosts above keep subdomains
# because the platform chose them.
if [ -n "${EXACT_DOMAINS:-}" ]; then
  echo "$EXACT_DOMAINS" | tr ',' '\n' | while IFS= read -r raw; do
    domain=$(printf '%s' "$raw" | tr -d '[:space:]')
    [ -z "$domain" ] && continue
    escaped=$(printf '%s' "$domain" | sed 's/\./\\./g')
    printf '^%s$\n' "$escaped" >> "$FILTER"
  done
fi

echo "[netgate] egress allowlist ($(wc -l < "$FILTER") rule(s), everything else denied):" >&2
cat "$FILTER" >&2

# ── Egress: refuse private and internal addresses ──────────────────────────────
#
# The filter above decides by NAME; tinyproxy then resolves the name and
# connects to whatever address comes back. A name whose DNS the creator controls
# could be pointed at this host, another agent's gate, or the cloud provider's
# metadata service, and the name check would pass. These rules decide by
# ADDRESS: the only private destinations this gate may reach are the platform
# host (for Graph tokens and mail) and its own agent's network (for the ingress
# below). Everything else private, loopback-to-elsewhere, link-local, CGNAT and
# multicast is dropped.
#
# Set up before tinyproxy starts and fatal if it fails: a gate that cannot hold
# this line refuses to start rather than run without it.
if [ "${BLOCK_PRIVATE:-1}" = "1" ]; then
  GATEWAY_IP=$(getent hosts host.docker.internal | awk '{print $1}' | head -1)
  iptables -A OUTPUT -o lo -j ACCEPT
  iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  [ -n "$GATEWAY_IP" ] && iptables -A OUTPUT -d "$GATEWAY_IP" -j ACCEPT
  [ -n "${AGENT_SUBNET:-}" ] && iptables -A OUTPUT -d "$AGENT_SUBNET" -j ACCEPT
  for net in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 \
             172.16.0.0/12 192.0.0.0/24 192.168.0.0/16 198.18.0.0/15 \
             224.0.0.0/4 240.0.0.0/4; do
    iptables -A OUTPUT -d "$net" -j DROP
  done
  # No IPv6 route is configured for agents; refuse it outright rather than
  # maintain a second list nobody tests.
  ip6tables -A OUTPUT -o lo -j ACCEPT 2>/dev/null || true
  ip6tables -P OUTPUT DROP 2>/dev/null || true
  echo "[netgate] private destinations blocked (allowed: gateway ${GATEWAY_IP:-none}, agent net ${AGENT_SUBNET:-none})" >&2
fi

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
