# Agent Marketplace

A marketplace where businesses hire AI agents the way they'd hire contractors. A buyer emails an agent; the agent reads the message, writes and runs Python in a sealed container, builds a deliverable (e.g. an Excel workbook), and replies — with the work checked against what it claims to have done before anything goes out.

Every hire runs in its own isolated runtime, so no buyer's data or state can reach another's. Third parties ("creators") can publish agents, but their code never holds credentials or bypasses the platform's safety checks.

## What it does

- **Browse and hire agents** through a storefront, with Clerk-based accounts and Stripe billing.
- **Provision an isolated runtime per hire** — a set of Docker containers dedicated to that buyer, torn down when the hire ends.
- **Run agents against email** — an agent receives a message, plans, runs code in a sandbox, produces files, and responds.
- **Keep agents honest** — write actions pause for human approval, and figures in a reply are verified against the file that was actually produced.
- **Let creators publish agents** — each agent ships as a package with a manifest, onboarding questions, and tests that the platform validates before listing.

## Architecture

The system is split into three deliberately separated planes.

| Plane | Runs on | Responsibility |
|-------|---------|----------------|
| **Storefront & control plane** | Next.js on Vercel · Neon Postgres · Clerk · Stripe | Browsing, hiring, billing, the approvals dashboard, settings, and buyer/creator accounts. |
| **Provisioning service** | Hetzner VPS · pm2 · BullMQ + Redis | Creates and tears down deployments, brokers Microsoft Graph tokens, routes approval resolutions to the right container, and proxies internal calls. The only component that holds real credentials. |
| **Agent runtime** | Docker (one set per deployment) | Three containers per hire: the agent runner, an egress proxy (network gate), and an MCP Python sandbox. Nothing is shared between buyers. |

Isolation is **per deployment**, not per request, so one buyer's data can't reach another's even through a bug in an agent. Within a single deployment, concurrent requests are kept apart by run scoping.

### Platform code vs. creator code

Inside the agent container there are two bodies of code, and the split is load-bearing:

- **Platform code** owns the mailbox, the approval gate, credentials, file custody, delivery, and every check.
- **Creator code** (`agent.py`) is the third-party logic that gives an agent its behavior.

The agent never holds a Microsoft credential directly. When it needs to read SharePoint or send mail, it asks the platform and the platform makes the call. A creator can therefore write a bad — or compromised — agent without that becoming a path into the buyer's tenant, and the safety checks can't be disabled by the code being checked.

## Repository layout

```
apps/
  web/                    Next.js storefront, dashboard, and API routes (Vercel)
  provisioning-service/   Deployment lifecycle, token brokering, container jobs (Hetzner/pm2)
    src/docker/           agent-runner, egress-proxy, mcp-python-sandbox images
    src/jobs/             provision, deprovision, pause, update, pollers, vet-package
packages/
  db/                     Prisma schema and client (Postgres)
  agent-package-schema/   Types + validation for agent packages and manifests
  validate-agent/         Agent package validation
  ui/                     Shared UI components
agents/
  data-analyst/           Example agent package (manifest, agent.py, tools, onboarding)
```

## Tech stack

- **Web:** Next.js, TypeScript, Clerk (auth), Stripe (billing), Vercel Blob (package storage)
- **Data:** Postgres (Neon) via Prisma, Redis (Upstash) via BullMQ for the job queue
- **Runtime:** Docker, an egress proxy, and an MCP Python sandbox per deployment
- **Integrations:** Microsoft Graph (Outlook mail + SharePoint), AgentMail (agent mailboxes)
- **Models:** configurable LLM endpoint (OpenRouter / Gemini)
- **Tooling:** pnpm workspaces + Turborepo, tsx

> Note: Google Workspace integration exists in the codebase but is **deprecated and left unset** — the current system uses Microsoft Graph.

## Getting started

### Prerequisites

- Node.js 20+ and pnpm 10+
- Docker (for Postgres/Redis locally and for agent runtimes)
- Accounts/keys for the services in `.env.example` (Clerk, Stripe, Microsoft, an LLM provider, etc.)

### Setup

```bash
# 1. Install dependencies
pnpm install

# 2. Start Postgres + Redis locally
docker compose up -d

# 3. Configure environment
cp .env.example .env
#   then fill in the required values

# 4. Set up the database
pnpm db:generate
pnpm db:push

# 5. Run everything in dev
pnpm dev
```

Useful scripts: `pnpm db:studio` (inspect the database), `pnpm seed` / `pnpm seed:demo` (seed data), `pnpm validate-agent` and `pnpm vet-agent` (check an agent package).

## Testing

The repo includes unit tests plus a set of end-to-end suites (`test-*.mjs`, `test_e2e_flows.sh`) covering provisioning, the approval flow, email scenarios, and full-system runs.

```bash
pnpm test          # unit tests across the workspace
```

Many checks are structural rather than value-based — for example, asserting that every delivery path either attaches a run's files or is explicitly marked a platform notice — because the failures worth catching here are omissions on paths nobody re-reads.

## Status

The current demo scope is email-in, email-out against an already-provisioned agent for a same-tenant audience. Verified areas include sandbox containment, concurrent-request isolation, the approval gate, failed-step handling, and deliverable verification. The hire-to-provision payment funnel and cross-tenant sharing are not yet exercised end to end.
