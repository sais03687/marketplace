"""The two decisions an update makes on the buyer's behalf.

An update restarts the agent. That cancels whatever it was doing, and if the new
version does not come up it leaves the buyer with nothing at all. Neither is
avoided by being careful; both need code.

The checks themselves are in test_update_safety.mjs, run here so they sit in the
same suite as everything else — the arrangement test_inbound_message.py already
uses, and for the same reason: it exercises the real functions rather than a
Python retelling of them that could agree with itself while the shipped code
disagrees.
"""
import shutil
import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parent / "test_update_safety.mjs"

pytestmark = pytest.mark.skipif(
    shutil.which("node") is None, reason="node is needed to exercise the update helpers"
)


def test_the_update_helpers_behave():
    r = subprocess.run(
        ["node", "--experimental-strip-types", str(SCRIPT)],
        capture_output=True, text=True, cwd=SCRIPT.parent.parent,
    )
    print(r.stdout or r.stderr)
    assert r.returncode == 0, r.stdout + r.stderr
    # A silent pass would mean the file ran nothing at all.
    assert r.stdout.count("ok   ") >= 12, r.stdout
