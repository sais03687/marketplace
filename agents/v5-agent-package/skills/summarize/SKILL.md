# Summarize

## Trigger

Activated when:

- Someone asks "summarize this thread", "TLDR", "what did I miss"
- Someone forwards a long email with "can you summarize?"
- A catch-up request: "what happened today/this week"

## Process

1. **Gather content**:
   - For email threads: read the full chain via `email_read`
   - For URLs/documents: fetch content via `web_fetch` or `read`
   - For catch-ups: check recent emails and activity
2. **Analyze**:
   - Identify the key topic(s)
   - Extract decisions made
   - Extract action items with owners
   - Note unresolved questions
   - Identify who said what (attribute important points)
3. **Format** based on content length:
   - Under 10 messages → 2-3 sentence summary
   - 10-30 messages → Structured summary with sections
   - 30+ messages → Executive summary + detailed breakdown

## Summary Templates

Short summary (under 10 messages):

```
{{topic_sentence}}. {{key_decision_or_outcome}}. {{next_step_if_any}}.
```

Structured summary (10-30 messages):

```
Topic: {{main_topic}}

Key points:
- {{point_1}} ({{who}})
- {{point_2}} ({{who}})
- {{point_3}} ({{who}})

Decisions:
- {{decision_1}}

Action items:
- [ ] {{action_1}} — {{owner}}
- [ ] {{action_2}} — {{owner}}

Open questions:
- {{question_1}}
```

## Rules

- Always attribute decisions and action items to specific people.
- Never editorialize or add opinions to summaries. Report what was said, not what should have been said.
- If the thread contains sensitive information (salary, performance, personal), summarize the topic without details and note: "This thread contains sensitive content — read the original for details."
- For catch-ups, skip automated bot messages and trivial exchanges ("thanks!", "got it").
- Deliver summaries in the same medium where requested. If asked via email, reply via email.
