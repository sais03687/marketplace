"""Release Notes — turns merged pull requests into notes a user can read.

Strict about one thing: a pull request whose title does not say what changed for
a user is listed as needing a human, not given an invented benefit. A refactor
is not a feature, and a version bump is not news.
"""
import json
import os
from typing import Any, Callable

from langchain_openai import ChatOpenAI
from platform_llm import StructuredLLM, has_any

AGENT_NAME = os.environ.get("AGENT_NAME", "Release Notes")

llm = ChatOpenAI(
    model=os.environ["LLM_MODEL"],
    base_url=os.environ["LLM_BASE_URL"],
    api_key=os.environ["LLM_API_KEY"],
    temperature=0,
)
structured = StructuredLLM(model=os.environ["LLM_MODEL"])

_NOTE = {
    "type": "object",
    "properties": {
        "text": {"type": "string"},
        "from": {"type": "array", "items": {"type": "integer"}},
    },
    "required": ["text", "from"],
    "additionalProperties": False,
}

NOTES_SCHEMA = {
    "name": "release_notes",
    "schema": {
        "type": "object",
        "properties": {
            "new": {"type": "array", "items": _NOTE},
            "improved": {"type": "array", "items": _NOTE},
            "fixed": {"type": "array", "items": _NOTE},
            "needs_a_human": {
                "type": "array",
                "items": {"type": "integer"},
                "description": "numbers of entries that do not say what changed for a user",
            },
            "not_entries": {
                "type": "array",
                "items": {"type": "integer"},
                "description": "numbers of lines that are not pull requests: headings, links",
            },
        },
        "required": ["new", "improved", "fixed", "needs_a_human", "not_entries"],
        "additionalProperties": False,
    },
}

# The field names are spelled out here as well as in the schema because the
# schema only reaches the model on anthropic/* models. Everything else is asked
# for plain JSON — valid JSON with no promise about key names — so a prompt that
# does not name the fields gets the model's own choice of them.
#
# Entries are referred to by number, never copied back. A model asked to quote
# the entries it skipped sometimes returns a fragment or a run of blank
# characters instead, and the entries it should have named silently vanish. With
# numbers, the agent quotes the input itself and can tell which entries the
# model never mentioned at all.
PROMPT = """Write release notes from these merged pull requests.

Write for the people who use the product, not the people who wrote it. One line
per change, in plain words, saying what is different for them.

Each line of the list below is numbered like [3]. Refer to lines only by those
numbers.

Rules you must not break:
- Only describe a change the entry actually states. Do not infer a benefit.
- An entry that says nothing user-facing — a refactor, a dependency bump, a
  test fix, a rename, a title you cannot read — goes in "needs_a_human" by
  number. Do not guess at what it did.
- A line that is not a pull request at all (a heading, a date, a changelog
  link) goes in "not_entries" by number.
- Every number must appear somewhere: in the "from" of a note, in
  "needs_a_human", or in "not_entries".
- Do not invent entries that are not in the list.
- A change that was added, reverted and re-landed in the same list shipped
  once: write one note for what finally shipped and put all of those numbers in
  its "from". A bug fixed inside that cycle never reached users; do not mention
  it.

Answer with JSON in exactly this shape, using exactly these field names:

{{
  "new": [{{"text": "Share a report with a link that expires", "from": [2]}}],
  "improved": [{{"text": "Exports finish about twice as fast on large files", "from": [4]}}],
  "fixed": [{{"text": "Fixed the timezone on scheduled sends", "from": [5, 6]}}],
  "needs_a_human": [3],
  "not_entries": [1]
}}

The field names matter: "new", "improved", "fixed", "needs_a_human", "not_entries".

MERGED PULL REQUESTS:
{entries}
"""


def _split_entries(text: str) -> list[str]:
    """One entry per top-level line; indented lines are context for the one above."""
    entries: list[str] = []
    for line in text.splitlines():
        if not line.strip():
            continue
        if line[:1].isspace() and entries:
            entries[-1] += "\n" + line.rstrip()
        else:
            entries.append(line.strip())
    return entries


def _numbers(value: Any) -> set[int]:
    out: set[int] = set()
    for v in value if isinstance(value, list) else []:
        try:
            out.add(int(v))
        except (TypeError, ValueError):
            continue
    return out


def _garbled(text: str) -> bool:
    """A note the model degenerated on: mostly dots, blanks and symbols."""
    t = text.strip()
    if len(t) < 4 or t.lower() in ("from", "text"):
        return True
    letters = sum(c.isalnum() for c in t)
    return letters / len(t) < 0.6


def _readable(parsed: Any) -> bool:
    """The answer has the fields asked for and no note in it is garbage."""
    if not has_any(parsed, ("new", "improved", "fixed", "needs_a_human")):
        return False
    for key in ("new", "improved", "fixed"):
        for note in parsed.get(key) or []:
            text = note.get("text") if isinstance(note, dict) else note
            if _garbled(str(text or "")):
                return False
    return True


def _format(parsed: dict, entries: list[str]) -> tuple[str, list[str]]:
    """Render the notes, and the list of things the reader should check."""
    valid = set(range(1, len(entries) + 1))
    sections = [("New", "new"), ("Improved", "improved"), ("Fixed", "fixed")]
    lines: list[str] = []
    used: set[int] = set()
    for heading, key in sections:
        items: list[str] = []
        for note in parsed.get(key) or []:
            text = note.get("text") if isinstance(note, dict) else note
            text = str(text or "").strip()
            if not text:
                continue
            items.append(text)
            if isinstance(note, dict):
                used |= _numbers(note.get("from")) & valid
        if not items:
            continue
        lines.append(f"{heading}")
        lines.extend(f"- {item}" for item in items)
        lines.append("")

    flagged = _numbers(parsed.get("needs_a_human")) & valid
    not_entries = _numbers(parsed.get("not_entries")) & valid
    # A note that cites no line at all means the model ignored the numbering, so
    # the agent cannot tell which entries it covered. Only then is an unmentioned
    # entry not counted as skipped; otherwise nothing leaves without a mention.
    if used or not lines:
        flagged |= valid - used - not_entries
    flagged -= used

    checks: list[str] = []
    if flagged:
        quoted = [entries[n - 1].split("\n")[0].lstrip("*- ")[:70] for n in sorted(flagged)]
        checks.append(
            f"{len(quoted)} entr{'y' if len(quoted) == 1 else 'ies'} did not say what changed "
            "for a user, so I left them out: " + "; ".join(quoted)
        )
    if not lines:
        checks.append("Nothing in that list described a user-facing change.")
    return "\n".join(lines).strip(), checks


async def run_agent(
    content: str,
    context: dict[str, Any],
    **tools: Callable,
) -> dict[str, Any]:
    """Called for every inbound message.

    `content` is the message text; the sender, subject and thread id are in
    `context`. Name any platform tool you want as a keyword argument instead of
    taking **tools — you are given exactly what you ask for.
    """
    text = (content or "").strip()
    if not text:
        return {
            "action": "reply_email",
            "text": "There were no pull requests in that message. Paste the merged PR "
                    "titles into the body and I will write the notes.",
            "needs_approval": False,
        }

    NOTE_LIMIT = 12000
    truncated = len(text) > NOTE_LIMIT
    entries = _split_entries(text[:NOTE_LIMIT])
    numbered = "\n".join(f"[{i}] {e}" for i, e in enumerate(entries, 1))

    # gpt-oss now and then degenerates partway through an answer (a note that is
    # a run of dots and blanks, or no recognisable fields at all). That is a bad
    # draw, not a verdict on the list, so it gets one fresh attempt.
    parsed = None
    for _attempt in range(2):
        raw = await structured.ainvoke(
            llm, PROMPT.format(entries=numbered), timeout=120, schema=NOTES_SCHEMA
        )
        try:
            parsed = json.loads(raw.content) if isinstance(raw.content, str) else raw.content
        except (json.JSONDecodeError, TypeError):
            parsed = None
        if _readable(parsed):
            break
    else:
        # An unreadable answer is not an empty one. Reporting it as "no
        # user-facing changes" would turn a model failure into a confident claim
        # about the release.
        return {
            "action": "reply_email",
            "text": "I could not read a clean set of notes back from the model for that "
                    "list, so I have not guessed at one. Send it again and I will retry.",
            "needs_approval": False,
        }

    body, checks = _format(parsed, entries)
    if truncated:
        checks.insert(
            0,
            f"That list was longer than I read in one go — I used the first "
            f"{NOTE_LIMIT:,} characters of {len(text):,}, so anything after that is "
            f"not in these notes.",
        )

    if not body:
        return {
            "action": "reply_email",
            "text": "None of those entries said what changed for a user, so there are no "
                    "notes to write yet. They look like internal work.",
            "check": checks[:3],
            "needs_approval": False,
        }

    return {
        "action": "reply_email",
        "text": f"Release notes from those pull requests:\n\n{body}",
        "check": checks[:3],
        "needs_approval": False,
    }


async def resume_agent(thread_id: str, resolution: dict, **tools: Callable) -> dict:
    """Continue a run that paused for a human decision.

    Required even here, where nothing is ever queued by the agent itself: the
    platform imports both entry points at startup, and a buyer's policy can hold
    an outbound email regardless of what the agent asked for.
    """
    status = str((resolution or {}).get("status", "")).upper()
    if status in ("APPROVED", "EDITED"):
        return {"action": "none"}
    return {
        "action": "reply_email",
        "text": "That was not approved, so I have not sent anything further. Send the "
                "list again if you would like a different draft.",
        "needs_approval": False,
    }
