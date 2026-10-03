"""A heartbeat that stops has to leave a trace in the container log.

On 2026-10-03 an agent that had been up nine days showed "Not responding · last
seen 3m ago" on its dashboard. The platform's staleness check did its job; the
container said nothing at all, so there was no way to tell whether it had lost
the network, lost its token, or lost the loop. Pausing and resuming rebuilt the
container and took the evidence with it.

Two things were wrong with the old code:

  * every failure was swallowed with a bare `pass`, and
  * httpx does not raise on 4xx, so a *rejected* heartbeat — the case that does
    not fix itself — counted as a success while the timestamp went stale.

Failures must still never crash the agent: the heartbeat is a report, not a
dependency.
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ADAPTER = (ROOT / "apps" / "provisioning-service" / "src" / "templates" / "runtime" / "adapter.py").read_text(encoding="utf-8")


def _heartbeat_fn() -> str:
    start = ADAPTER.index("async def _send_heartbeat()")
    return ADAPTER[start : ADAPTER.index("async def _push_memory_snapshot()", start)]


def test_a_rejected_heartbeat_counts_as_a_failure():
    fn = _heartbeat_fn()
    assert "resp.status_code >= 400" in fn, (
        "httpx does not raise on 4xx; a refused heartbeat would read as success"
    )


def test_failures_are_logged_not_swallowed_silently():
    fn = _heartbeat_fn()
    assert "heartbeat failed" in fn
    assert re.search(r"except Exception as e:", fn), "the error itself should be reported"


def test_the_log_does_not_repeat_every_minute():
    # Beats are every 60s. A platform blip should not write a line a minute
    # forever, or the log becomes the outage.
    fn = _heartbeat_fn()
    assert "streak == 1 or streak % 10 == 0" in fn


def test_a_good_beat_clears_the_streak():
    fn = _heartbeat_fn()
    assert '_heartbeat_failures["streak"] = 0' in fn


def test_the_heartbeat_still_cannot_crash_the_agent():
    fn = _heartbeat_fn()
    # The raise is inside the try, so the except below catches it.
    raise_at = fn.index("raise RuntimeError")
    except_at = fn.index("except Exception as e:")
    assert raise_at < except_at, "the status check must be guarded by the same try"
