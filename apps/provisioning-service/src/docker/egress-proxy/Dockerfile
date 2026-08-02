# Network gate for agent containers — the only way in or out of an agent's network.
#
# Agent networks are Internal, which removes the default gateway: a container on
# one has no route off the host, and cannot be reached from it either. Docker
# will not publish ports for such a container, so this image handles both
# directions:
#
#   egress  — tinyproxy, forwarding only to a per-deployment allowlist
#   ingress — socat, forwarding a published host port to the agent's gateway
#
# Built from alpine rather than pulled from a third party on purpose: the image
# enforcing egress should not itself be an unreviewed dependency.
FROM alpine:3.20

RUN apk add --no-cache tinyproxy socat

# The allowlist arrives as ALLOWED_DOMAINS and the forward target as AGENT_HOST,
# so the image is identical for every deployment and nothing is mounted from the
# host.
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8888 4000
ENTRYPOINT ["/entrypoint.sh"]
