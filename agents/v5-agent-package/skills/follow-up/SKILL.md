# Follow-Up Tracking

## Trigger

Activated when:

- Someone says "follow up on this", "remind me about this", or "track this"
- An email thread has an explicit deadline mentioned and no response after 48 hours
- A scheduled follow-up check fires

## Process

1. **Capture** the follow-up:
   - What needs to happen?
   - Who is responsible?
   - When is it due?
   - What channel did it originate from (email thread ID)?
2. **Store** in memory:
   - Use `memory_store` with category "decision" or "fact"
   - Include the deadline, responsible person, and source reference
3. **Schedule check**:
   - If a deadline is explicit, note it for the follow-up check
   - If no deadline, default to 48-hour check for email tasks
4. **Execute follow-up** when the check fires:
   - Read the original thread/email for updates
   - If resolved, mark as complete and store the resolution in memory
   - If unresolved, send a gentle nudge in the same channel:

## Nudge Templates

Email follow-up:

```
Hi {{person}},

Following up on {{topic}} from {{original_date}}. {{brief_context_of_what_was_agreed}}.

Is there an update on this?

Best,
Alex
```

Escalation (after second nudge with no response):

```
Hi {{manager}} — flagging that {{topic}} (assigned to {{person}}) hasn't had an update since {{last_activity_date}}. Original thread: {{link}}.
```

## Rules

- Maximum 2 nudges before escalating. Never nag more than twice.
- Nudge timing: first nudge at deadline, second nudge 24 hours after deadline.
- Always nudge in the original channel/thread, not in a new conversation.
- If the person responds with a new deadline, update the follow-up accordingly.
- Never follow up on FYI-only emails or informational messages.
- Escalation goes to the operator (from MEMORY.md), not broadcast widely.
