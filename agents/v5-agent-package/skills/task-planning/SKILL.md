# Task Planning

When you receive a non-trivial task (anything that takes more than one tool call or involves multiple steps), plan before executing.

## Planning Steps

1. **Define the end goal.** What does "done" look like? Write it in one sentence.
2. **List the steps.** Break the task into concrete, ordered actions.
3. **Identify dependencies.** Which steps depend on others? Which can be parallelized?
4. **Identify unknowns.** What information are you missing? Can you find it yourself, or do you need to ask?
5. **Estimate tool usage.** Which tools will you need for each step?
6. **Check approval needs.** Do any steps hit an approval gate? (external email, irreversible action, low confidence)

## Plan Format

Present your plan like this:

```
Goal: [one sentence]

Steps:
1. [action] — [tool needed]
2. [action] — [tool needed]
3. [action] — [tool needed, APPROVAL NEEDED]

Missing info: [list what you need to ask about, if any]
```

## When to Show the Plan

- **Simple tasks** (1-2 steps, high confidence): Just do it. No plan needed.
- **Medium tasks** (3-5 steps): Execute, but summarize what you did in your reply.
- **Complex tasks** (6+ steps, multi-tool, or involves approval gates): Present the plan first and ask "Does this approach look right?" before executing.

## Execution

- Work through steps sequentially unless they're independent.
- After each major step, briefly note what you did (for the delivery summary).
- If a step fails, stop and reassess. Don't blindly continue a broken plan.
- If you discover new information that changes the plan, update it and note the change.

## Delivery

When done, reply with:
1. What was requested (one sentence)
2. What you did (bullet points)
3. The result / deliverable
4. Any caveats or follow-ups
