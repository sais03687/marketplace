"""A response the parser cannot read must not kill the message.

There is a regex salvage immediately after the JSON parse, and it exists to
recover exactly these cases. On 2026-08-12 it never got the chance: a response
of a bare "```" made `split("\\n", 1)[1]` raise IndexError, which was not in the
except clause, so it escaped the salvage entirely and took the whole run with
it — "[adapter] Error handling message: list index out of range". The requester
received nothing at all.

Degenerate responses are likeliest on the action=none retry, which is already
the path taken because something went wrong once.
"""
import ast
import io
from pathlib import Path

import pytest

AGENT_SRC = (Path(__file__).resolve().parents[1] /
             "agents" / "data-analyst" / "agent.py")


# ── the specific crash, reproduced against the real expression ─────────────

def _strip_fence(text: str) -> str:
    """The parser's fence handling, as written in agent.py."""
    src = io.open(AGENT_SRC, encoding="utf-8").read()
    assert 'cleaned.split("\\n", 1)[-1].rsplit("```", 1)[0]' in src, (
        "the fence strip no longer uses [-1]; a bare fence will raise IndexError "
        "again and escape the salvage below it"
    )
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.split("\n", 1)[-1].rsplit("```", 1)[0]
    return cleaned


@pytest.mark.parametrize("degenerate", [
    "```",
    "```json",
    "```\n",
    "``````",
])
def test_a_bare_fence_does_not_raise(degenerate):
    _strip_fence(degenerate)  # must simply not raise


def test_a_normal_fenced_body_still_unwraps():
    out = _strip_fence('```json\n{"action": "reply_email"}\n```')
    assert out.strip() == '{"action": "reply_email"}'


def test_an_unfenced_body_is_untouched():
    assert _strip_fence('{"action": "none"}') == '{"action": "none"}'


# ── and no parse failure may escape as an exception ────────────────────────

def _except_handlers_for_the_json_parse():
    """The exception types guarding the fenced-JSON parse in reason_and_act."""
    tree = ast.parse(io.open(AGENT_SRC, encoding="utf-8").read())
    found = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Try):
            continue
        body = ast.unparse(node)
        if "json.loads(cleaned)" not in body or "state.analysis" not in body:
            continue
        for h in node.handlers:
            if h.type is None:
                found.append("bare except")
            elif isinstance(h.type, ast.Tuple):
                found += [ast.unparse(e) for e in h.type.elts]
            else:
                found.append(ast.unparse(h.type))
    return found


def test_indexerror_is_caught_so_the_salvage_can_run():
    handlers = _except_handlers_for_the_json_parse()
    assert handlers, "could not find the fenced-JSON parse guard"
    assert "IndexError" in handlers, (
        f"IndexError escapes the parse guard and skips the regex salvage: {handlers}"
    )


def test_the_usual_parse_failures_are_still_caught():
    handlers = _except_handlers_for_the_json_parse()
    assert "json.JSONDecodeError" in handlers
    assert "ValueError" in handlers


def test_the_salvage_still_follows_the_parse():
    # The recovery this whole test file is about: if it is ever removed, a bad
    # response goes back to producing no reply.
    src = io.open(AGENT_SRC, encoding="utf-8").read()
    i = src.index("json.loads(cleaned)")
    assert 're.search(r"\\{.*\\}", text, re.DOTALL)' in src[i:i + 1200], (
        "the regex salvage after the JSON parse is gone"
    )
