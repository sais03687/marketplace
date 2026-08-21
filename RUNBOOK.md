# Operational runbook

Day-to-day operation and the things that bite. `DEPLOY.md` is first-time setup;
this is what you reach for once it is running.

## Deploying a change

Three tiers deploy independently. Deploy the one you changed.

| You changed | Deploy with |
|---|---|
| Web app (`apps/web`) | Push to `main` — Vercel auto-deploys and runs `prisma migrate deploy`. |
| Provisioning service, the schema package, or the DB schema (`apps/provisioning-service`, `packages/agent-package-schema`, `packages/db`) | On the VPS: `bash scripts/deploy-provisioning.sh` |
| Agent code (`agents/data-analyst`, `adapter.py`) | On the VPS: `bash scripts/deploy-agent.sh` |

`deploy-provisioning.sh` always rebuilds the schema package and regenerates the
Prisma client before restarting, because both are built artifacts the service
imports and a stale one makes the VPS disagree with the web app. See the script
header for the incident that made this necessary.

### The two-deploy rule for auth changes — this WILL bite if ignored

When a change adds a required credential to a call — a caller starts sending a
token and a route starts requiring it — **deploy the caller first, then the
route.** Deploy them the other way and every request is rejected in the window
between the two deploys, and a live integration goes dark.

This is why the AgentMind and approvals auth work shipped in two commits each: the
callers (adapter, poller) started *sending* the token in one deploy, and the
routes started *requiring* it in a later one. Reversing that order on 2026-08-19
caused a brief 401 storm. There is no way to make a push-based auth change atomic
across Vercel and the VPS, so the ordering is the mitigation.

## The firewall — the security boundary that is not in any repo

**This is a single point of failure with no version control. Read this before
touching Hetzner networking.**

Each agent runs in a container on an internal Docker network with no published
ports of its own. Its `netgate` sidecar owns the published port (e.g.
`127.0.0.1:32805 -> 4000/tcp`) and binds it to **localhost on the VPS**, not to a
public interface. The provisioning service (port 3003) is likewise not meant to
be reachable from the internet.

What keeps all of this off the open internet is a **Hetzner Cloud Firewall rule**,
configured in the Hetzner console — **not** in this repository, not in `ufw`
(which is inactive on the box). If that rule is ever removed or widened:

- agent gateways and the provisioning service become internet-reachable;
- the per-deployment token check on `/internal/microsoft-token` and the hooks-token
  check on `/hooks/*` become the *only* thing between a stranger and an agent,
  instead of the second line of defence they are designed to be.

Those token checks are sound (see `apps/provisioning-service/src/utils/agent-token.ts`),
but they were built assuming the network boundary exists. Do not treat the
firewall as optional.

**To verify the boundary from outside the VPS** (should all fail / time out):

```sh
curl -m 8 http://5.161.125.216:3003/                         # provisioning service
curl -m 8 http://5.161.125.216:4000/                         # any agent gateway
```

If either connects, the firewall rule is wrong — fix it before anything else.

**TODO (tracked, not done):** move this rule into infrastructure-as-code (Hetzner
Terraform provider or an `hcloud` script committed here) so it is reviewable and
recreatable, and add a startup assertion that the expected posture holds.

## Container isolation — what creator code can and cannot reach

Agent containers run creator code. Two layers keep that code boxed in, and one
known boundary is left open on purpose for the first-party pilot.

**Capabilities and resources.** Each agent container runs with `CapDrop: ["ALL"]`,
`no-new-privileges`, no swap, a 512 MB / 1-CPU / 256-PID cap, and on an Internal
Docker network with no published ports of its own (the netgate publishes for it).
A bug or a malicious dependency in creator code is an unprivileged process that
cannot reach the network except through the egress proxy.

**Secret scrubbing.** `adapter.py` reads sensitive env into a private `_secrets`
dict and `os.environ.pop`s each one *before* it imports creator code, so creator
code cannot read them from `os.environ`: the approval/hooks/agent tokens, the
Microsoft client secret, the portal token. This is defence-in-depth, not a hard
wall — `os.environ.pop` does not rewrite `/proc/1/environ`, so code that reads the
raw process environment can still recover a scrubbed value. The hard wall is not
putting a secret in the container at all.

**The open boundary — close before onboarding untrusted third-party creators.**
Two shared, broadly-scoped secrets are *not* scrubbed, because creator code needs
them directly:

- `LLM_API_KEY` — the platform's shared model key. Creator code builds its own LLM
  client (`agent.py` reads it), so it cannot be hidden without proxying every LLM
  call through the adapter and injecting the key server-side.
- `GOOGLE_WORKSPACE_SA_KEY` — a domain-wide-delegation service-account key, shared
  across all Google deployments, present only on Google-workspace agents. Same
  shape: creator Google tools read it directly.

For the current first-party pilot, where all creator code is the platform's own,
this is acceptable. Before opening publishing to untrusted creators, both must
move behind a broker: an LLM proxy that injects the key, and a Google token
endpoint that mints a short-lived scoped token (mirroring the existing
`/internal/microsoft-token` broker, which is why Microsoft creds are already
absent from the container). Until then, treat a published third-party package as
able to read the shared LLM key.

## Microsoft tenant gotchas

- A brand-new tenant's mailbox takes **5–15 minutes to warm up**. During that
  window listing messages returns `502 UnknownError` — which is normal, NOT the
  `404 ErrorInvalidUser` that means the mailbox was created on the wrong tenant.
- A new tenant's outbound mail to another org may be slow or land in Junk until it
  has sending reputation.
- Provisioning against a buyer tenant fails the hire loudly if the mailbox cannot
  be created there (it does not silently fall back to a platform mailbox — that
  bug is fixed). If a hire fails, check `provisioningLog` for the deployment.

## Never

- `git pull` on the VPS. Use `git fetch origin main && git checkout origin/main -- <paths>`.
- Restart the provisioning service from the ecosystem file without sourcing
  `.env.prod` first — a plain `pm2 restart marketplace-provisioning` keeps the
  env; starting fresh loses it.
