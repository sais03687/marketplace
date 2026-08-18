"""`x = f(x)` where nothing has bound `x` yet.

On 2026-08-17 this line went into `_handle_message`:

    reply_text = finalise_reply_text(reply_text, _att)

copied from `_deliver_email_result`, where `reply_text` is a parameter. In
`_handle_message` it is nothing at all, so the read raised UnboundLocalError —
and had it not, the finalised text would have gone into a local that no send
ever reads, since both sends on that path use `result["text"]`. The notebook
note and the unattached-file caveat never reached a buyer down that path.

It hid for a day because a run that pauses at a graph interrupt resumes through
a different function and never reaches the line. Only a run that finishes inside
`_handle_message` does, and E4 on 2026-08-18 was the first: its approval was the
adapter's own `queue_for_approval`, which returns there rather than resuming the
graph. The buyer was told "Something went wrong while I was working on your
request" under a finished analysis and a built workbook.

Pyflakes does not catch it — read-before-assignment needs dataflow, and it has
none. But this particular shape is decidable without dataflow: a statement whose
right-hand side reads the very name it is the first to bind is wrong however
the branches fall. That is what is checked here, and only that, so it has no
false alarms to train anyone to ignore.
"""
import ast
import io
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
SOURCES = [
    REPO / "apps" / "provisioning-service" / "src" / "templates" / "runtime" / "adapter.py",
    REPO / "agents" / "data-analyst" / "agent.py",
]


def _names_read(node):
    return {n.id for n in ast.walk(node) if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load)}


def _params(fn):
    a = fn.args
    got = {p.arg for p in a.posonlyargs + a.args + a.kwonlyargs}
    if a.vararg:
        got.add(a.vararg.arg)
    if a.kwarg:
        got.add(a.kwarg.arg)
    return got


def _binds(node):
    """Names this node binds, counting every construct that binds one.

    The first version only counted assignments, so a loop variable reassigned
    inside its own loop - `for v in val: ... v = v.get("id")` - looked like a
    read before binding. Three of those, all harmless, and a check with three
    false alarms in it is a check nobody runs twice.
    """
    out = set()
    if isinstance(node, (ast.For, ast.AsyncFor, ast.comprehension)):
        tgt = node.target
        out |= {n.id for n in ast.walk(tgt) if isinstance(n, ast.Name)}
    elif isinstance(node, (ast.With, ast.AsyncWith)):
        for item in node.items:
            if item.optional_vars is not None:
                out |= {n.id for n in ast.walk(item.optional_vars) if isinstance(n, ast.Name)}
    elif isinstance(node, ast.ExceptHandler) and node.name:
        out.add(node.name)
    elif isinstance(node, (ast.Import, ast.ImportFrom)):
        out |= {(a.asname or a.name).split(".")[0] for a in node.names}
    elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        out.add(node.name)
    elif isinstance(node, ast.NamedExpr) and isinstance(node.target, ast.Name):
        out.add(node.target.id)
    elif isinstance(node, (ast.AugAssign, ast.AnnAssign)) and isinstance(node.target, ast.Name):
        out.add(node.target.id)
    return out


def _offences(fn):
    """Statements binding a name for the first time while reading it."""
    bound = set(_params(fn))
    for n in ast.walk(fn):
        if isinstance(n, (ast.Global, ast.Nonlocal)):
            bound.update(n.names)

    found = []
    # Source order across the whole function, nested blocks included. A name
    # bound by any earlier construct counts as bound, even conditionally: the
    # aim is no false alarms, so anything arguable is left alone.
    for node in sorted(
        ast.walk(fn),
        key=lambda s: (getattr(s, "lineno", 0), getattr(s, "col_offset", 0)),
    ):
        if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(
            node.targets[0], ast.Name
        ):
            name = node.targets[0].id
            if name not in bound and name in _names_read(node.value):
                found.append((name, node.lineno))
            bound.add(name)
        else:
            bound |= _binds(node)
    return found


def _functions(tree):
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            yield node


@pytest.mark.parametrize("path", SOURCES, ids=[p.name for p in SOURCES])
def test_nothing_reads_a_name_it_is_the_first_to_bind(path):
    tree = ast.parse(io.open(path, encoding="utf-8").read())
    bad = []
    for fn in _functions(tree):
        for name, line in _offences(fn):
            bad.append(f"{path.name}:{line} in {fn.name}(): reads {name!r} while first binding it")
    assert not bad, "\n" + "\n".join(bad)


def test_the_check_catches_the_line_that_shipped():
    """Against the real shape, so this file cannot pass by looking at nothing."""
    tree = ast.parse(
        "async def _handle_message(message, context):\n"
        "    _att = run_attachments()\n"
        "    reply_text = finalise_reply_text(reply_text, _att)\n"
    )
    fn = next(_functions(tree))
    assert [n for n, _ in _offences(fn)] == ["reply_text"]


def test_it_leaves_an_ordinary_reassignment_alone():
    tree = ast.parse(
        "def f(x):\n"
        "    text = x or ''\n"
        "    text = text.strip()\n"          # bound above, fine
        "    for row in rows:\n"
        "        total = total_of(row)\n"
        "    return text, total\n"
    )
    assert _offences(next(_functions(tree))) == []


def test_it_leaves_a_parameter_alone():
    tree = ast.parse("def f(reply_text, att):\n    reply_text = finalise(reply_text, att)\n")
    assert _offences(next(_functions(tree))) == []


def test_it_leaves_a_conditional_earlier_binding_alone():
    # Bound in one branch only. Arguable, so not flagged — no false alarms.
    tree = ast.parse(
        "def f(flag):\n"
        "    if flag:\n"
        "        text = 'a'\n"
        "    text = text + 'b'\n"
    )
    assert _offences(next(_functions(tree))) == []


def test_it_leaves_a_loop_variable_reassigned_in_its_own_loop_alone():
    """The false positive the first version of this checker raised.

    Three of these in the real sources, all harmless. A check with false alarms
    in it is a check that gets skipped, so the shape is pinned here.
    """
    tree = ast.parse("def f(val):\n    for v in val:\n        if isinstance(v, dict):\n            v = v.get('id') or v.get('name')\n")
    assert _offences(next(_functions(tree))) == []


def test_it_leaves_a_with_binding_alone():
    tree = ast.parse('def f(p):\n    with open(p) as fh:\n        fh = fh.read()\n')
    assert _offences(next(_functions(tree))) == []


def test_it_leaves_a_walrus_alone():
    tree = ast.parse('def f(xs):\n    if (hit := first(xs)):\n        hit = hit.strip()\n')
    assert _offences(next(_functions(tree))) == []
