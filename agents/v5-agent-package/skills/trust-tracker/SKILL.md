# Trust Tracker

## Trigger

Activated when:

- A heartbeat fires and `memory/approvals.md` has new entries since last review
- You complete a task that went through the approval flow
- You receive a "trust review" or "autonomy check" request

## Purpose

Track approval patterns over time to gradually adjust risk thresholds. Actions that are consistently approved without edits can have their risk assessment lowered, giving you more autonomy for routine tasks.

## Process

### After Each Approval Decision

1. **Log the outcome** in `memory/approvals.md` (see approval-flow skill for format)
2. **Tag the action type** — categorize by tool + context (e.g., "email_send:external", "exec:git", "calendar_create")

### During Heartbeat Reviews

1. **Read `memory/approvals.md`** — review all entries since last review
2. **Calculate per-action-type scores**:
   ```
   approval_rate = approved_count / total_count
   clean_rate = approved_without_edits / approved_count
   weighted_score = (recent_clean × 2 + older_clean) / (recent_total × 2 + older_total)
   ```
   "Recent" = last 7 days. "Older" = 8–30 days.

3. **Apply threshold adjustments**:

   | Weighted Score | Action |
   |----------------|--------|
   | < 0.60 | Keep current threshold (agent needs improvement) |
   | 0.60 – 0.80 | May lower risk assessment by 0.5 for this action type |
   | 0.80 – 0.95 | May lower risk assessment by 1.0 |
   | ≥ 0.95 (with ≥ 5 examples) | May lower risk assessment by 1.5 (minimum score: 3.0) |

4. **Document changes** in `MEMORY.md` under "Lessons Learned":
   ```
   - [YYYY-MM-DD] Trust adjustment: email_send:internal risk lowered from 4.0 to 3.0
     (clean approval rate: 95%, 12 examples over 2 weeks)
   ```

5. **Never auto-execute previously high-risk actions.** Minimum risk score for any action that was ever ≥ 6.0 is 3.0 (always at least clarify).

## Trust Report Format

When asked for a trust review, present:

```
Trust Report — [date]

Action Type       | Total | Approved | Edited | Rejected | Clean Rate | Current Risk | Suggested
email_send:ext    |    8  |     7    |   1    |    0     |   87.5%    |    7.0       |   6.5
exec:git          |    5  |     5    |   0    |    0     |  100.0%    |    3.5       |   3.0
calendar_create   |    3  |     3    |   0    |    0     |  100.0%    |    5.0       |   4.0

Overall: [X] actions tracked, [Y]% clean approval rate
```

## Rules

- **Conservative adjustments.** Lower thresholds slowly (max -1.5 per review cycle).
- **Ratchet up fast.** If a rejection occurs, immediately raise that action type's threshold by +2.0.
- **Minimum floor.** No action that sends data externally or modifies state can go below 3.0.
- **Audit trail.** Every threshold change must be logged with date, reason, and data supporting it.
- **Reset on error.** If an approved action causes an error or unintended outcome, reset that action type to its original risk level.
