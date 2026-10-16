# Monitoring, usage and reporting — build checklist

Agreed 2026-10-16. Each step goes: scope → build → automated tests → deploy →
live check → owner's 5-minute check → commit and tick. A step is not started
until the one before it is ticked.

Ground rules for every step:
- Each audience gets its own server endpoint that only returns what that
  audience may see. Hiding on the page is never the protection.
- Creators never see buyer content: no message text, files, numbers, names,
  error messages or printouts from buyers' runs.
- Records the creator's code could forge are labelled "reported by the agent".

## Part A — Protection and alerts
- [x] A1 Cost check (2026-10-16). Standard (gpt-oss-120b) ≈ $0.002/task; Pro (Claude Sonnet 5, Data Analyst)
      ≈ $0.30–1.20/task. Agreed monthly model allowance per hire: Standard $0.50, Pro $7, Premium $30.
      Top-ups: $10 of usage for $13, no creator share. Hourly runaway stop: $1 / $5 / $15.
      Price floors stay $29/$59/$149; mailbox seat ($7, Business Basic since 2026-07-01) absorbed during the
      pilot, mailbox fee (~$8 on Email-only) decided before public launch.
- [x] A2 Public `/healthz` + outside uptime monitor (done 2026-10-16)
  - [x] `/healthz` live at https://api.agentstore.it.com/healthz (f435369): database, queue, disk < 85%,
        agents checking in, mail readers running; answers ok/down + check names only; cached 15 s
  - [x] UptimeRobot watching `/healthz` and https://www.agentstore.it.com (it checks with HEAD — fixed in 1ca1d8c)
  - [x] Down test: stopped 14:42:29 UTC → down email; back 14:49:42 UTC → up email; mail reader restored
- [ ] A3 Sentry on web app, provisioning service and agent adapter, with scrubbing
- [ ] A4 Per-agent OpenRouter keys (created on hire, deleted on fire) + safety stop
  - [x] Keys per hire, created on first model call (dc64264); key file root-only, gitignored
  - [x] Found live: OpenRouter's per-key usage lags >10 min and a $0.01 key ran $0.02 → its limits are only a
        backstop. Broker now meters each call's reported cost and refuses before the call (c3b3c8e):
        402 agent_allowance_reached / 403 agent_safety_stop / 403 agent_fired
  - [x] Live: real broker calls (plain + streamed) metered to the cent; fired hire refused; allowance and
        safety stop tripped on real spend; key switched off and refused by OpenRouter; resume; delete
  - [x] Safety-stop email received by the operator; now carries the status and lift commands
  - [ ] Fire path on a real hire: key deleted at OpenRouter (do with the A5 test hire)
  - [x] Tier bug found live (DB stores PRO; read as standard) — fixed; live test 20/20 incl. broker uses the hire's key
  - Note: Data Analyst Two calls OpenRouter directly (predates the broker) — not capped until moved
- [ ] A5 "Limit reached" reply + 80% warning email

## Part B — Buying more usage
- [ ] B1 Usage bar on the buyer dashboard
- [ ] B2 "Add more" via Stripe; limit raised on payment
- [ ] B3 (optional) Unused top-ups carry over

## Part C — Run records
- [ ] C1 Records table + ingestion endpoint
- [ ] C2 Server-side records: email in, model calls and cost, reply sent, approvals
- [ ] C3 In-agent records (labelled) + per-run printout capture
- [ ] C4 Survives platform outage; 90-day deletion

## Part D — Buyer timeline
- [ ] D0 Clickable mockup approved
- [ ] D1 Task list
- [ ] D2 One task's full timeline

## Part E — Operator page
- [ ] E0 Clickable mockup approved
- [ ] E1 Tasks today, failing agents, spend, OpenRouter balance

**Checkpoint: ready for real companies.**

## Part F — Report a problem
- [ ] F1 Footer link on every agent email (not removable by creators)
- [ ] F2 No-login report page (shows nothing private, rate-limited)
- [ ] F3 Dashboard button; "let the developer read my description" for the account holder only
- [ ] F4 Operator reports list

## Part G — Creator side
- [ ] G0 Clickable mockup approved
- [ ] G1 Step names declared in the manifest, checked by `agentstore check` and vetting
- [ ] G2 Creator Runs page (crash file:line verified against the uploaded package)
- [ ] G3 Data-free bug-report emails to creators

## Part H — Leak and stress testing
- [ ] H1 "Sneaky agent" leak test, raw API responses inspected
- [ ] H2 Cross-account access test
- [ ] H3 Load and outage test

## Later
Share-a-run button · free test hires · automatic pay-as-you-go · Langfuse for vetting runs and test hires
