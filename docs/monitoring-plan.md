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
- [ ] A1 Cost check: real cost per task per agent from OpenRouter; agree allowance and safety stop
- [x] A2 Public `/healthz` + outside uptime monitor (done 2026-10-16)
  - [x] `/healthz` live at https://api.agentstore.it.com/healthz (f435369): database, queue, disk < 85%,
        agents checking in, mail readers running; answers ok/down + check names only; cached 15 s
  - [x] UptimeRobot watching `/healthz` and https://www.agentstore.it.com (it checks with HEAD — fixed in 1ca1d8c)
  - [x] Down test: stopped 14:42:29 UTC → down email; back 14:49:42 UTC → up email; mail reader restored
- [ ] A3 Sentry on web app, provisioning service and agent adapter, with scrubbing
- [ ] A4 Per-agent OpenRouter keys (created on hire, deleted on fire) + safety stop
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
