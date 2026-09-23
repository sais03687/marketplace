"""An agent written exactly as the docs describe must be callable.

This is the contract that broke: the docs promised
`run_agent(content, context, approve_fn, resolve_fn, contribute_fn, search_fn,
use_fn)`, while every adapter call site passed a different fixed list — graph_fn
and six others the documented agent never declared, and neither of the two it
did. A doc-following package raised TypeError on its first message, /internal/
run-sync swallowed it into {"ok": false}, and vetting showed "(no reply)" with no
cause. approve_fn/resolve_fn exist in the runtime as queue_for_approval and
wait_for_resolution, so a creator following the docs also had no approval rail.

Rather than assert on source text, these tests lift the real filtering function
out of adapter.py and the real signature out of the docs page, then check that
the call the adapter would make actually succeeds. adapter.py cannot be imported
here — it imports creator.agent, fastapi and uvicorn — so the function is
compiled on its own.
"""
import ast
import asyncio
import inspect
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ADAPTER_PATH = ROOT / "apps" / "provisioning-service" / "src" / "templates" / "runtime" / "adapter.py"
DOCS_PATH = ROOT / "apps" / "web" / "app" / "(public)" / "docs" / "creators" / "page.tsx"
ADAPTER = ADAPTER_PATH.read_text(encoding="utf-8")
DOCS = DOCS_PATH.read_text(encoding="utf-8")


def _function_from_adapter(name: str):
    """Compile one top-level function out of adapter.py, with nothing else."""
    tree = ast.parse(ADAPTER)
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name == name:
            module = ast.Module(body=[node], type_ignores=[])
            namespace: dict = {"inspect": inspect}
            exec(compile(module, str(ADAPTER_PATH), "exec"), namespace)
            return namespace[name]
    raise AssertionError(f"{name}() is gone from adapter.py")


def _offered_tool_names() -> set[str]:
    """The keys _creator_tool_kwargs offers, read from its own source."""
    tree = ast.parse(ADAPTER)
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name == "_creator_tool_kwargs":
            names = set()
            for sub in ast.walk(node):
                if isinstance(sub, ast.Dict):
                    names |= {k.value for k in sub.keys if isinstance(k, ast.Constant)}
                if isinstance(sub, ast.Subscript) and isinstance(sub.slice, ast.Constant):
                    names.add(sub.slice.value)
            return names
    raise AssertionError("_creator_tool_kwargs() is gone from adapter.py")


def _documented_run_agent():
    """Build a function with the signature the published docs show."""
    match = re.search(r"async def run_agent\((.*?)\n\) -> dict\[str, Any\]:", DOCS, re.S)
    assert match, "the docs no longer show a run_agent signature"
    params = []
    for raw in match.group(1).split("\n"):
        raw = raw.strip().rstrip(",")
        if not raw:
            continue
        name = raw.split(":")[0].strip()
        params.append(name)
    source = f"async def documented({', '.join(params)}):\n    return {{'action': 'none'}}\n"
    namespace: dict = {}
    exec(source, namespace)
    return namespace["documented"], params


def test_a_doc_following_agent_can_actually_be_called():
    accepted = _function_from_adapter("_accepted_kwargs")
    documented, params = _documented_run_agent()
    offered = {name: (lambda *a, **k: None) for name in _offered_tool_names()}
    offered |= {"mcp_fn": None, "thread_id": "t", "verify_attempts": 0}

    kwargs = accepted(documented, offered)
    # The call the adapter makes. TypeError here is the production bug.
    result = asyncio.run(documented(content={"text": "hi"}, context={}, **kwargs))
    assert result["action"] == "none"
    # Sanity: the docs example is not just content/context, or this proves little.
    assert len(params) > 2


def test_content_is_a_string_everywhere_and_the_docs_say_so():
    """The second half of the same mismatch.

    Every call site passes the message as a str — the email body, the Teams
    message wrapped in chat instructions, or run-sync's test message. The docs
    described `content: dict[str, Any]` carrying from/subject/text, so an agent
    written to them called content.get("text") and died with AttributeError.
    Those fields are real, but they live in context.
    """
    tree = ast.parse(ADAPTER)
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        if not (isinstance(node.func, ast.Name) and node.func.id in ("run_agent", "resume_agent")):
            continue
        for kw in node.keywords:
            if kw.arg == "content":
                # A dict literal here would mean the runtime changed shape and
                # the docs below need to change with it.
                assert not isinstance(kw.value, ast.Dict), (
                    f"line {node.lineno} passes a dict as content; the docs promise a string"
                )

    assert "content: str," in DOCS, "the docs no longer declare content as a string"
    assert "It is never a dict" in DOCS
    # The fields a creator actually needs are documented where they really are.
    for field in ("sender", "subject", "thread_id"):
        assert field in DOCS


def test_the_documented_example_survives_a_real_string():
    """Run the docs' own example body the way the platform calls it."""
    match = re.search(r"(    subject = context\.get.*?\n    \})`\}</Pre>", DOCS, re.S)
    assert match, "the docs no longer show an example body"
    # Already indented one level, so it drops straight into a def.
    source = f"async def example(content, context, **tools):\n{match.group(1)}\n"
    namespace: dict = {}
    exec(source, namespace)
    # content as the platform really sends it: a plain string.
    result = asyncio.run(namespace["example"]("Please total the Q3 numbers", {"subject": "Q3"}))
    assert result["action"] == "reply_email"


def test_the_approval_rail_reaches_a_creator_that_asks_for_it():
    offered = _offered_tool_names()
    assert {"approve_fn", "resolve_fn"} <= offered, (
        "the docs tell creators to take approve_fn/resolve_fn — the platform must pass them"
    )
    # Backed by the real functions, not stubs.
    assert '"approve_fn": queue_for_approval' in ADAPTER
    assert '"resolve_fn": wait_for_resolution' in ADAPTER


def test_an_agent_that_wants_nothing_is_still_callable():
    accepted = _function_from_adapter("_accepted_kwargs")

    async def minimal(content, context):
        return {"action": "none"}

    offered = {name: None for name in _offered_tool_names()}
    assert accepted(minimal, offered) == {}
    asyncio.run(minimal(content={}, context={}, **accepted(minimal, offered)))


def test_an_agent_that_takes_kwargs_gets_everything():
    accepted = _function_from_adapter("_accepted_kwargs")

    async def greedy(content, context, **tools):
        return {"action": "none"}

    offered = {name: None for name in _offered_tool_names()}
    assert accepted(greedy, offered) == offered


def test_every_call_site_goes_through_the_filter():
    # The bug was a fixed kwargs list repeated at six call sites; one missed copy
    # brings it back for whichever path it is on.
    tree = ast.parse(ADAPTER)
    bad = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        fn = node.func
        if not (isinstance(fn, ast.Name) and fn.id in ("run_agent", "resume_agent")):
            continue
        passed = {kw.arg for kw in node.keywords if kw.arg}
        tools = passed - {"content", "context"}
        if tools:
            bad.append(f"line {node.lineno}: passes {sorted(tools)} directly")
    assert not bad, "call sites bypass _creator_tool_kwargs: " + "; ".join(bad)


def test_the_no_reply_failure_now_names_its_cause():
    # run-sync returning a bare {"ok": false} is what hid this for a day.
    block = ADAPTER[ADAPTER.index("async def run_sync("):]
    block = block[: block.index("class UpdateSkillsPayload")]
    assert 'f"run failed: {type(e).__name__}: {e}"' in block
    assert "traceback.format_exc()" in block


def test_startup_warns_about_a_tool_that_does_not_exist():
    assert "_warn_about_unfillable_params" in ADAPTER
    startup = ADAPTER[ADAPTER.index("async def _startup():"):]
    startup = startup[:2000]
    assert "_warn_about_unfillable_params()" in startup
