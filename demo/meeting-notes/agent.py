"""Meeting Notes: email it your raw meeting notes, get back a clean summary."""
import os

from langchain_openai import ChatOpenAI

# The platform sets these. Locally, point them at OpenRouter with your own key.
llm = ChatOpenAI(
    model=os.environ["LLM_MODEL"],
    base_url=os.environ["LLM_BASE_URL"],
    api_key=os.environ["LLM_API_KEY"],
    temperature=0,
)

PROMPT = """Turn these meeting notes into a short summary for people who missed it.

Use exactly these three sections:
Summary: two or three sentences.
Decisions: one line each.
Action items: one line each, like "Marcus: migrate the payments API (by Nov 8)".

Write plain text for an email: no markdown, no asterisks, no bold.
Only use what the notes say. End each action item with its deadline in
brackets, written out: (by Thursday), (by Nov 8). If the notes give no
deadline, end it with (no date). If no one owns it, start with "No owner".

NOTES:
{notes}"""


async def run_agent(content: str, context: dict, **tools) -> dict:
    """Called for every email the agent receives."""
    notes = (content or "").strip()
    if not notes:
        return {"action": "reply_email", "text": "Paste your meeting notes into the email body."}

    reply = await llm.ainvoke(PROMPT.format(notes=notes[:15000]))
    return {
        "action": "reply_email",
        "text": reply.content,
        "needs_approval": False,  # True holds the reply until the buyer approves it
    }


async def resume_agent(thread_id: str, resolution: dict, **tools) -> dict:
    """Called after the buyer approves or rejects a held reply."""
    return {"action": "none"}
