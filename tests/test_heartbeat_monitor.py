"""A silent failure becomes a visible one.

This system's signature problem is silence: a dead container, a stalled poller, a
hung run, none of which announce themselves, so the buyer finds out through days
of nothing happening.

The agent posts a heartbeat every 60s. The dashboard shows it, and this monitor
alerts the manager when it goes stale. The rules that matter — and would rot
quietly if wrong — are: alert once per outage, not every cycle; re-arm when the
agent recovers; and only for agents that were actually alive to begin with.
"""
import io
from pathlib import Path

SRC = (
    Path(__file__).resolve().parents[1]
    / "apps" / "provisioning-service" / "src" / "jobs" / "heartbeat-monitor.ts"
).read_text(encoding="utf-8")
ROUTE = (
    Path(__file__).resolve().parents[1]
    / "apps" / "web" / "app" / "api" / "deployments" / "[id]" / "heartbeat" / "route.ts"
).read_text(encoding="utf-8")


def test_it_only_alerts_for_agents_that_were_alive():
    # lastHeartbeatAt: { not: null } — an agent that never checked in (still
    # provisioning, or broken from birth) is not a "went quiet" case and would
    # be a false alarm.
    assert "lastHeartbeatAt: { not: null, lt: cutoff }" in SRC


def test_it_alerts_once_per_outage_not_every_cycle():
    # heartbeatAlertedAt: null in the query, set after sending. Without both, a
    # down agent is re-nagged every two minutes forever.
    assert "heartbeatAlertedAt: null" in SRC
    assert "heartbeatAlertedAt: new Date()" in SRC


def test_recovery_re_arms_the_alarm():
    # The heartbeat route clears heartbeatAlertedAt, so a recovered-then-failed
    # agent alerts again rather than staying silent because it alerted once weeks
    # ago.
    assert "heartbeatAlertedAt: null" in ROUTE


def test_a_failed_send_is_retried_not_swallowed():
    # heartbeatAlertedAt is set only when the mail actually went. A transient
    # send failure must not mark it alerted, or the outage goes unreported.
    idx_send = SRC.index("const sent = await sendAlert")
    idx_mark = SRC.index("heartbeatAlertedAt: new Date()")
    assert idx_send < idx_mark
    assert "if (sent) {" in SRC


def test_the_threshold_is_several_missed_beats_not_one():
    # One late beat is not an outage. The stale window must be well above the 60s
    # heartbeat interval.
    assert "5 * 60 * 1000" in SRC


def test_it_runs_on_a_timer():
    assert "setInterval(" in SRC
    assert "startHeartbeatMonitor" in SRC


def test_the_alert_says_work_is_not_lost():
    # The interrupted-run fix means in-flight work is preserved and reported; the
    # alert must not contradict that by implying data loss.
    assert "has been lost" in SRC and "Nothing you asked it to do has been lost" in SRC
