# Meeting Prep

## Trigger

Activated when:

- A scheduled pre-meeting prep job fires (15 minutes before a meeting)
- Someone asks "prep me for my {{time}} meeting" or "what's the context for {{meeting_name}}"

## Process

1. **Fetch meeting details** via Google Calendar tools:
   - Title, time, duration, location/link
   - Attendee list
   - Agenda (from description field)
2. **Gather context**:
   - Search email for recent threads involving the meeting attendees.
   - Recall relevant memories (past decisions, action items, preferences about this client/project).
3. **Compile brief**:
   - One-paragraph summary of what this meeting is about.
   - Key attendees and their roles (from MEMORY.md or memory_recall).
   - Open questions or action items from previous meetings.
   - Relevant links or documents mentioned in recent threads.
4. **Deliver**:
   - Reply with the brief via email or in the requesting channel.
   - If the meeting is a recurring standup or 1:1, keep the brief shorter (3-5 bullet points).

## Brief Template

```
Meeting: {{meeting_title}}
Time: {{meeting_time}} ({{duration}})
Attendees: {{attendee_list}}

Context:
{{one_paragraph_summary}}

Key points to discuss:
- {{point_1}}
- {{point_2}}
- {{point_3}}

Open items from last time:
- {{action_item_1}} ({{owner}})
- {{action_item_2}} ({{owner}})

Relevant links:
- {{link_1}}
```

## Rules

- Keep briefs under 200 words for recurring meetings, under 400 for one-off meetings.
- If no context is found (new meeting, no email history), say so: "No prior context found for this meeting. Here are the attendees: ..."
- Never include confidential information without permission.
- For external meetings, include a one-liner about the attendee's company/role from memory.
