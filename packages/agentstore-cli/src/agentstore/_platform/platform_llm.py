"""Structured model output for agents on the platform.

Shipped next to adapter.py in every agent image, so creator code can do

    from platform_llm import StructuredLLM
    structured = StructuredLLM(model=os.environ["LLM_MODEL"])
    response = await structured.ainvoke(llm, prompt, timeout=120, schema=MY_SCHEMA)

and get the same guarantees the platform's own agent relies on, without
re-learning them. It takes the agent's own client: nothing here holds or sees a
credential.

What it handles, each learned on 2026-09-19 against OpenRouter:

- Asking for JSON in the prompt is a request a model can decline. A Sonnet run
  answered in markdown three times in one task, and the buyer got a truncated
  table. So the format is set at the decoder: response_format.
- Vendors differ. Anthropic models ignore json_object and honour only
  json_schema; gpt-oss-120b honours json_object on every provider tried, while
  one provider returned garbage ("-1.1e2") in schema mode. "auto" picks per
  vendor; STRUCTURED_OUTPUT=json|schema|none overrides.
- Schema mode closes every object: a field the schema does not list is dropped,
  and an object with no listed properties comes back empty. Free-form objects
  therefore travel as JSON-encoded strings; decode_json_strings() undoes that.
- In schema mode a response cut off at max_tokens raises (the OpenAI client's
  LengthFinishReasonError) instead of returning text. That is an unreadable
  turn, not a failed task, and comes back as empty content for the caller's
  retry to handle.
- `require_parameters` routes only to providers that honour response_format.
  A provider or model that rejects the parameter outright (a 4xx) switches this
  instance back to plain calls for good.
"""
from __future__ import annotations

import asyncio
import json
import os
from types import SimpleNamespace
from typing import Any, Iterable


def schema_mode_for(model: str, setting: str | None = None) -> str:
    """"schema", "json" or "none" for this model under a STRUCTURED_OUTPUT setting."""
    setting = (setting if setting is not None else os.environ.get("STRUCTURED_OUTPUT", "auto")).strip().lower()
    if setting in ("none", "json", "schema"):
        return setting
    return "schema" if (model or "").startswith("anthropic/") else "json"


def has_any(obj: Any, keys: Iterable[str]) -> bool:
    """Is this a dict carrying at least one of the fields a caller can act on?

    JSON mode guarantees an object, not your fields: six of six gpt-oss calls in
    JSON mode returned valid objects keyed "heading" and "plan" with none of the
    fields asked for. Treat such an object as unreadable, like prose.
    """
    return isinstance(obj, dict) and bool(set(keys) & set(obj))


def decode_json_strings(obj: dict, paths: Iterable[str]) -> bool:
    """Decode fields that schema mode delivered as JSON strings, in place.

    `paths` are dotted, e.g. "action.params". A field that is absent or already
    an object is left alone. Returns False if one did not decode to an object -
    the caller should treat the turn as unreadable.
    """
    for path in paths:
        *parents, leaf = path.split(".")
        node: Any = obj
        for p in parents:
            node = node.get(p) if isinstance(node, dict) else None
        if not isinstance(node, dict) or not isinstance(node.get(leaf), str):
            continue
        try:
            decoded = json.loads(node[leaf].strip() or "{}")
        except (json.JSONDecodeError, ValueError):
            return False
        if not isinstance(decoded, dict):
            return False
        node[leaf] = decoded
    return True


class StructuredLLM:
    """Calls a LangChain chat model with the right structured-output mode."""

    def __init__(self, model: str, setting: str | None = None):
        self.model = model
        self.mode = schema_mode_for(model, setting)

    @property
    def enabled(self) -> bool:
        return self.mode != "none"

    def response_format(self, schema: dict | None) -> dict:
        if self.mode == "schema" and schema:
            return {"type": "json_schema", "json_schema": {"name": "agent_output", "strict": False, "schema": schema}}
        return {"type": "json_object"}

    async def ainvoke(self, llm: Any, prompt: Any, *, timeout: float, schema: dict | None = None) -> Any:
        """Invoke `llm`, structured when possible. Timeouts propagate; nothing else crashes a turn."""
        if self.enabled and hasattr(llm, "bind"):
            bound = llm.bind(
                response_format=self.response_format(schema),
                extra_body={"provider": {"require_parameters": True}},
            )
            try:
                return await asyncio.wait_for(bound.ainvoke(prompt), timeout=timeout)
            except Exception as e:
                if isinstance(e, asyncio.TimeoutError):
                    raise  # slowness is the caller's retry, not a reason to drop structure
                if type(e).__name__ == "LengthFinishReasonError":
                    print("[platform_llm] response hit the length limit - treating it as unreadable", flush=True)
                    return SimpleNamespace(content="")
                # A 4xx is the provider refusing the parameter, not a transient
                # fault; asking again with it would fail the same way every time.
                status = getattr(e, "status_code", None) or getattr(getattr(e, "response", None), "status_code", None)
                if status is None or not (400 <= int(status) < 500) or status in (401, 402, 408, 429):
                    raise
                print(f"[platform_llm] structured output rejected ({status}: {str(e)[:160]}) - using plain calls", flush=True)
                self.mode = "none"
        return await asyncio.wait_for(llm.ainvoke(prompt), timeout=timeout)
