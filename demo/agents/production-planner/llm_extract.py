"""Turn an email into the parameters an agent needs, with the platform's model.

The field names are spelled out in the prompt as well as the schema: the schema
only reaches anthropic/* models, and other models are asked for plain JSON, so a
prompt that did not name the fields would get the model's own choice of them.
"""
import json
import os
import re

from langchain_openai import ChatOpenAI
from platform_llm import StructuredLLM, has_any

MODEL = os.environ.get("LLM_MODEL", "openai/gpt-oss-120b")
_llm = ChatOpenAI(model=MODEL, temperature=0)   # no key: the platform supplies it
_structured = StructuredLLM(model=MODEL)


async def extract(instructions: str, email: str, schema: dict, required: list[str]) -> dict | None:
    """The fields `schema` describes, read from `email`; None if the model's answer is unusable."""
    prompt = (
        f"{instructions}\n\n"
        f"Answer with one JSON object using exactly these field names: {', '.join(required)}.\n"
        f"JSON schema: {json.dumps(schema)}\n\n"
        f"EMAIL:\n{email[:12000]}"
    )
    for attempt in range(3):
        try:
            raw = await _structured.ainvoke(
                _llm, prompt, timeout=60,
                schema={"name": "request", "schema": schema},
            )
        except Exception as exc:   # a timeout or a provider error: try again
            print(f"[extract] attempt {attempt + 1}: {type(exc).__name__}: {exc}", flush=True)
            continue
        data = _parse(raw.content)
        if isinstance(data, dict) and has_any(data, required) and not _garbled(data):
            return data
        print(f"[extract] attempt {attempt + 1} unusable: {str(raw.content)[:300]!r}", flush=True)
    return None


def _parse(content):
    """The JSON object in a model's answer, which may be wrapped in a code fence or a sentence."""
    if isinstance(content, dict):
        return content
    text = str(content or "").strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    fenced = re.search(r"```(?:json)?\s*(\{.*\})\s*```", text, re.S)
    start, end = text.find("{"), text.rfind("}")
    for candidate in ([fenced.group(1)] if fenced else []) + ([text[start:end + 1]] if 0 <= start < end else []):
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            continue
    return None


def _garbled(value) -> bool:
    """True if the answer carries control characters, a model glitch and never real content."""
    if isinstance(value, dict):
        return any(_garbled(v) for v in value.values())
    if isinstance(value, list):
        return any(_garbled(v) for v in value)
    return isinstance(value, str) and any((ord(c) < 32 and c not in ALLOWED_WHITESPACE) or c == REPLACEMENT for c in value)


ALLOWED_WHITESPACE = chr(9) + chr(10) + chr(13)
REPLACEMENT = chr(0xFFFD)
