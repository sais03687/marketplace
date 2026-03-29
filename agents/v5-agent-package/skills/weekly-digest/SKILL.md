# Weekly Digest

## Trigger

Activated when:

- A scheduled cron job fires (Monday 8:00 AM, operator's timezone)
- The operator asks "what happened this week?" or "weekly report"
- During a heartbeat on Monday morning

## Process

1. **Gather data** from the past 7 days:
   - Read `memory/YYYY-MM-DD.md` for each day of the past week
   - Read `memory/approvals.md` for approval decisions
   - Check `email_list` for recent email activity count
   - Review `memory/workflow-drafts/` for any new workflows captured

2. **Compile report** with these sections:

### Report Template

```
Subject: [FYI] Weekly Digest — Week of YYYY-MM-DD

Hi Sai,

Here's your weekly summary:

ACTIVITY
- [X] tasks completed
- [Y] emails processed
- [Z] emails sent (with approval)

APPROVAL OUTCOMES
- [A] actions auto-executed (risk < 3.0)
- [B] actions needed clarification
- [C] actions queued for approval
  - [C1] approved without edits
  - [C2] approved with edits
  - [C3] rejected
- Approval rate: [%]
- Clean rate (no edits needed): [%]

TRUST CHANGES
- [List any risk threshold adjustments made this week]
- [Or: "No threshold changes this week"]

TOP ACTIONS
1. [Most common action type] — [count] times
2. [Second most common] — [count] times
3. [Third most common] — [count] times

NOTABLE ITEMS
- [Any unusual events, errors, or things worth flagging]
- [New workflows captured this week]
- [Lessons learned]

OPEN ITEMS
- [Pending approvals older than 24 hours]
- [Follow-ups due this week]
- [Unresolved questions from email threads]

Best,
Alex
```

3. **Deliver** via `email_send` to the operator (saiharawesome@gmail.com)
   - This is an internal report to the operator — does NOT require approval
   - Use subject prefix `[FYI]`

## Rules

- **Prose over dashboards.** Write like a colleague giving an update, not a metrics dump.
- **Highlight anomalies.** If rejection rate spiked or a new pattern emerged, call it out.
- **Keep it under 300 words.** The operator should be able to read this in 2 minutes.
- **No fluff.** If nothing notable happened in a section, skip it. Don't pad with "everything is running smoothly."
- **Include zeros.** If no approvals were needed, say so — it's useful data.
- **Link to specifics.** Reference email subjects or dates so the operator can dig in if needed.
