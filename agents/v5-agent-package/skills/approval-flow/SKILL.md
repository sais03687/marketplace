# Approval Flow

## Trigger

Activated when:

- A tool call scores ≥ 6.0 on the risk assessment framework
- An action matches an approval gate (external email, state-changing command, money, credentials)
- You are less than 70% confident in an action's correctness

## Process

1. **Assess risk** using the 3-axis framework from AGENTS.md:
   - Stakes (0–10): Impact level
   - Ambiguity (0–10): Parameter clarity
   - Reversibility (0–10): Can it be undone?
   - Combined = (Stakes × 0.5) + (Ambiguity × 0.3) + (Reversibility × 0.2)

2. **Draft the action** — Prepare the exact parameters you would use:
   - For `email_send`: draft the full email (to, subject, body)
   - For `exec`: show the exact command
   - For file operations: show the diff or new content
   - For calendar: show event details (title, time, attendees)

3. **Register in the approval queue** — Call `http_post` to register the action:

   Call `http_post` with:
   - `url`: `http://localhost:3001/approvals` (or the value of `MARKETPLACE_APPROVAL_WEBHOOK` if set in the environment)
   - `body`: a JSON object containing:
     ```json
     {
       "taskType": "<the type of task, e.g. email_reply_external>",
       "channel": "<email or slack>",
       "draft": "<the full proposed action text>",
       "reasoning": "<why the agent is taking this action>",
       "stakesScore": <0-10>,
       "ambiguityScore": <0-10>,
       "reversibilityScore": <0-10>,
       "combinedScore": <0-10>,
       "threadId": "<email thread ID if applicable>",
       "originalRequest": "<the email or message that triggered this>"
     }
     ```

   Save the returned **approval ID** from the response for later resolution.

4. **Reply in the email thread** to notify the requester:
   ```
   I've drafted a response and queued it for your approval. You'll see it in the approval queue — reply APPROVE, EDIT [your changes], or REJECT [reason] to this email, or resolve it in the portal.

   Action: [tool name]
   Details:
   [formatted draft — full email text, command, file diff, etc.]

   Risk: [score]/10
   - Stakes: [X]/10 — [reason]
   - Ambiguity: [X]/10 — [reason]
   - Reversibility: [X]/10 — [reason]
   ```

5. **Wait** — Do NOT execute the action. Stop and wait for a reply in the thread.

6. **Process the response**:
   - **APPROVE** (or "yes", "go ahead", "do it", "proceed"):
     - Call `resolve_approval` with the approval ID and status `"approved"`
     - Execute the action exactly as drafted
     - Confirm completion in the thread
     - Log: `APPROVED` in `memory/approvals.md`
   - **EDIT** (followed by changes):
     - Apply the requested edits to your draft
     - Call `resolve_approval` with the approval ID and status `"edited"`, include edit details in `note`
     - If changes are minor: execute and confirm
     - If changes are major: re-present the updated draft for another round
     - Log: `APPROVED_WITH_EDITS` in `memory/approvals.md`
   - **REJECT** (or "no", "cancel", "don't", "stop"):
     - Call `resolve_approval` with the approval ID and status `"rejected"`, include reason in `note`
     - Acknowledge the rejection
     - Do NOT execute the action
     - Note the reason (if given) for future learning
     - Log: `REJECTED` in `memory/approvals.md`

## Approval Log Format

Maintain `memory/approvals.md` with this table:

```
# Approval Log

| Date | Thread | Action | Tool | Score | Decision | Edits | Notes |
|------|--------|--------|------|-------|----------|-------|-------|
| 2026-03-20 | Re: Project update | Send email to john@example.com | email_send | 7.2 | APPROVED | None | First external email to this contact |
```

## Rules

- **Never bypass.** If an action triggers approval, always go through the flow. No shortcuts.
- **Batch approvals.** If a task requires multiple high-risk actions, present them all in one approval request.
- **One round.** Don't ask for approval more than twice for the same action. If rejected twice, drop it.
- **Explain reasoning.** Always include why the risk score is what it is, not just the number.
- **Be specific.** Show exact content (email text, command, etc.), not vague descriptions.
- **Default to caution.** When in doubt about whether something needs approval, request it.
