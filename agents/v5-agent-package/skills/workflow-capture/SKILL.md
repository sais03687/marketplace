# Workflow Capture

## Trigger

Activated when:

- You complete a multi-step task successfully
- You notice a recurring pattern (same type of request handled 3+ times)
- Someone asks you to "learn this process" or "remember how to do this"
- During heartbeat reviews when reviewing daily notes

## Purpose

Extract recurring task patterns from your work and codify them as reusable workflows. This lets you handle similar future requests faster and more consistently.

## Process

### Capture Phase

1. **Identify the pattern** — Look for tasks that share:
   - Similar trigger conditions (same type of email, same requester, same topic)
   - Similar tool sequences (search → draft → approve → send)
   - Similar decision points (same clarification questions needed)

2. **Extract the workflow** — Document:
   - **Trigger**: What starts this workflow? (email subject pattern, keywords, requester)
   - **Context needed**: What information must be gathered first?
   - **Steps**: Ordered list of actions with decision branches
   - **Tools used**: Which tools in what order
   - **Common mistakes**: Things that went wrong or needed edits
   - **Approval points**: Which steps need human sign-off
   - **Example**: One concrete input/output pair

3. **Format as a skill draft** — Write to `memory/workflow-drafts/[name].md`:

   ```
   # [Workflow Name]

   ## Trigger
   [When this workflow activates]

   ## Prerequisites
   [What you need before starting]

   ## Steps
   1. [Step 1] — Tool: [tool_name] | Risk: [level]
   2. [Step 2] — Tool: [tool_name] | Risk: [level]
   ...

   ## Decision Points
   - If [condition]: [branch A]
   - If [condition]: [branch B]

   ## Example
   Input: [example request]
   Output: [example result]

   ## Learned From
   - [Date]: [original task reference]
   - [Date]: [refinement from subsequent task]
   ```

### Review Phase (During Heartbeats)

1. **Check `memory/workflow-drafts/`** for new drafts
2. **Validate** — Does the workflow still make sense? Has it been used 3+ times?
3. **Promote** — If stable, move to `skills/[name]/SKILL.md` (note: only for workflows you've confirmed work reliably)

## Rules

- **Don't over-capture.** Only codify patterns seen 3+ times. One-off tasks aren't workflows.
- **Keep workflows atomic.** Each workflow should handle one type of task. Don't create mega-workflows.
- **Include failure modes.** Document what to do when a step fails.
- **Update, don't duplicate.** If a workflow evolves, update the existing one instead of creating a new variant.
- **Operator review.** Before promoting a draft to a full skill, note it in your next communication to the operator for review.
