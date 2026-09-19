"""The shared structured-output helper every agent image ships with."""
import asyncio
from types import SimpleNamespace

import pytest

import platform_llm as pl


@pytest.mark.parametrize("model, setting, mode", [
    ("anthropic/claude-sonnet-5", "auto", "schema"),
    ("anthropic/claude-haiku-4.5", "auto", "schema"),
    ("openai/gpt-oss-120b", "auto", "json"),
    ("google/gemini-2.5-flash", "auto", "json"),
    ("openai/gpt-oss-120b", "schema", "schema"),
    ("anthropic/claude-sonnet-5", "none", "none"),
])
def test_the_mode_follows_the_vendor_unless_overridden(model, setting, mode):
    assert pl.schema_mode_for(model, setting) == mode


def test_schema_mode_sends_the_schema_and_json_mode_does_not():
    s = pl.StructuredLLM("anthropic/claude-sonnet-5", "auto")
    assert s.response_format({"type": "object"})["type"] == "json_schema"
    assert s.response_format(None) == {"type": "json_object"}
    assert pl.StructuredLLM("openai/gpt-oss-120b", "auto").response_format({"type": "object"}) == {"type": "json_object"}


@pytest.mark.parametrize("obj, ok", [
    ({"action": {"type": "x", "params": '{"a": 1}'}}, True),
    ({"action": {"type": "x", "params": {"a": 1}}}, True),
    ({"action": {"type": "x"}}, True),
    ({"action": {"type": "x", "params": "not json"}}, False),
    ({"action": {"type": "x", "params": "[1, 2]"}}, False),
])
def test_encoded_fields_decode_in_place(obj, ok):
    assert pl.decode_json_strings(obj, ["action.params"]) is ok
    if ok and "params" in obj["action"]:
        assert isinstance(obj["action"]["params"], dict)


def test_an_object_without_the_callers_fields_is_not_usable():
    assert pl.has_any({"heading": "# Plan"}, ("action", "completed")) is False
    assert pl.has_any({"completed": True}, ("action", "completed")) is True
    assert pl.has_any("prose", ("action",)) is False


def test_a_timeout_propagates_to_the_caller():
    class Slow:
        def bind(self, **kw):
            return self
        async def ainvoke(self, prompt):
            await asyncio.sleep(5)

    with pytest.raises(asyncio.TimeoutError):
        asyncio.run(pl.StructuredLLM("openai/gpt-oss-120b").ainvoke(Slow(), "hi", timeout=0.01))


def test_structure_off_calls_the_client_plainly():
    class Plain:
        bound = False
        def bind(self, **kw):
            Plain.bound = True
            return self
        async def ainvoke(self, prompt):
            return SimpleNamespace(content="plain")

    out = asyncio.run(pl.StructuredLLM("openai/gpt-oss-120b", "none").ainvoke(Plain(), "hi", timeout=5))
    assert out.content == "plain" and Plain.bound is False
