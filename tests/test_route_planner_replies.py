"""Route Planner v14: a reply in a planned thread is a change, a question, or thanks.

Decided in code from what the sender just wrote (the platform strips the quoted
thread). On 2026-10-17 "Do you have the routes and sumo animations?" was taken as
a change and the plan was redone from the stop list quoted under it.

The agent module needs SUMO and OR-tools, so the helpers are lifted from its
source and run on their own; the end-to-end behaviour is exercised on the server.
"""
import io
import re
from pathlib import Path

SRC = io.open(Path(__file__).resolve().parents[1] / "demo" / "agents" / "route-planner" / "agent.py",
              encoding="utf-8").read()


def _helpers() -> dict:
    ns = {"re": re}
    start = SRC.index("ACK_ONLY = re.compile(")
    end = SRC.index("def _same_name(")
    exec(SRC[start:end].replace("async def _answer_from_plan", "async def _unused"), ns)
    return ns


H = _helpers()


def test_questions_thanks_and_changes():
    kind = H["_followup_kind"]
    assert kind("Do you have the routes and sumo animations?", False) == "question"
    assert kind("Which van goes to Haughville", False) == "question"
    assert kind("Thanks!", False) == "ack"
    assert kind("thanks, looks good", False) == "ack"
    assert kind("Add a van please.", True) == "change"
    assert kind("", False) == "ack"


def test_a_setting_counts_as_changed_only_when_it_differs():
    d = H["_differs"]
    assert d(3, 2) and not d(2, 2) and not d(0, 2) and not d("", "08:00")


def test_an_answer_with_an_invented_figure_is_caught():
    facts = "Van 1: 15.9 km, about 47 min, back 08:47\nVan 2: 16.8 km, about 39 min"
    bad = H["_untraced_numbers"]
    assert bad("Van 2 takes about 39 min and is back first.", facts, "") == []
    assert bad("Van 2 takes about 4321 minutes.", facts, "") == ["4321"]


def test_one_maps_link_per_van_and_long_routes_split():
    links = H["_maps_links"]
    pts = [{"lat": 39.7 + i / 100, "lon": -86.1} for i in range(14)]
    short = links([{"van": 1, "seq": [0, 1, 2, 0]}], pts)
    assert len(short) == 1 and short[0].startswith("Van 1: https://www.google.com/maps/dir/?api=1")
    assert "waypoints=39.710000,-86.100000%7C39.720000,-86.100000" in short[0]
    long = links([{"van": 2, "seq": [0] + list(range(1, 14)) + [0]}], pts)
    assert len(long) == 2 and "part 1 of 2" in long[0]
    assert all(link.count("%7C") <= 8 for link in long), "at most 8 waypoints per link"


def test_question_handling_never_replans_from_quoted_text():
    assert 'listed = []' in SRC[SRC.index('if kind == "question":'):]
    assert '"no_reply": "an acknowledgement' in SRC
