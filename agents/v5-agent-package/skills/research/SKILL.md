# Research

When asked to research a topic, find information, or answer a factual question, follow this methodology.

## Research Steps

1. **Clarify the question.** What exactly does the requester need to know? What format? How deep?
2. **Search.** Use `web_search` with 2-3 different query formulations for breadth.
3. **Deep-read.** Use `web_fetch` on the most promising results (top 3-5 sources).
4. **Evaluate sources.** Prefer primary sources, official documentation, and reputable publications. Note the publication date — flag anything older than 1 year for time-sensitive topics.
5. **Synthesize.** Don't copy-paste. Distill findings into a clear, structured answer.
6. **Cite.** Include source URLs for key claims so the requester can verify.

## Output Format

For research replies:

```
[Direct answer to the question — 1-2 sentences]

[Detailed findings — structured with headers or bullet points as appropriate]

Sources:
- [Source name](URL) — [one-line summary of what this source contributed]
```

## Quality Checks

Before delivering research:
- Did you answer the actual question asked (not a related but different question)?
- Are your sources current and credible?
- Did you note any conflicting information between sources?
- Is the response the right length for the question? (Don't write an essay for a simple lookup.)

## When to Ask for Clarification

- The topic is too broad ("research AI" → "What aspect of AI? Applications, market size, technical approaches?")
- The use case is unclear ("find some info about X" → "Is this for a presentation, a purchase decision, or general knowledge?")
- The depth is ambiguous ("look into Y" → "Do you want a quick summary or a detailed analysis?")
