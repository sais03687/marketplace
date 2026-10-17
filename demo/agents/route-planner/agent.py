"""Route Planner — plans delivery routes on real roads with OR-tools, then drives them in SUMO.

Email the depot and the stops (name plus latitude/longitude, optionally how much each
stop needs and when it takes deliveries), how many vans and how much each carries, and
optionally a departure time. It uses the area's real roads (OpenStreetMap, built into
the agent for a fixed area — see build.sh), works out driving times between every pair
of stops, plans the routes that take the least driving time within opening hours and
shift limits, then drives each van through a SUMO simulation of those roads — speed
limits, one-way streets, turns and traffic lights, and SUMO's fuel and emission model
for a diesel delivery van — to get its arrival time at every stop.

If the email also says how the vans run today, it simulates that too and reports what
the plan saves in distance, time, fuel, cost and CO2.

Attaches a CSV of the routes, a map of them on the streets, an animated replay of the
simulation, and a working notebook of everything that was computed. For stops outside
the mapped area it plans on straight-line distances instead and says so.
"""
import asyncio
import hashlib
import json
import math
import os
import re
import threading
import time

from llm_extract import extract, answer as answer_question
import geocode
import report
import roads
import scenario

STOP_MINUTES = 5.0
# Real city driving runs well below the speed limit (turns, lights, parking,
# stopping and starting). On 2026-10-16 eight legs of the demo plan were looked up by
# hand in a mainstream map service for an off-peak evening: road distances agreed
# within ~10%, but drive times were ~1.5x what SUMO simulated at full limits. Roads
# are therefore taken at 65% of their limits by default. Only this one factor came
# from the check; no outside routing data is used by the agent.
BASE_SPEED_PCT = 65.0
PEAK_MAIN_PCT = 45.0        # rush hour default: main roads at this share of their limit
PEAK_MINOR_PCT = 58.0       # ... and side streets at least this share
# Stated assumptions; the sender can give their own and the reply says which were used.
FUEL_PRICE_PER_GALLON = 3.60
DRIVER_COST_PER_HOUR = 25.0
LITRES_PER_GALLON = 3.785
DEFAULT_DEPARTURE = 8 * 60  # when opening hours are given but no departure time
# libsumo runs one simulation per process; two emails at once must take turns.
_SUMO = threading.Lock()
# One SUMO session for the whole process, reused by every email (see Roads.prepare).
_SESSION = None


# Only for the straight-line fallback: city speed for short legs, road speeds for long ones.
def _fallback_kmh(km: float) -> float:
    return 35.0 if km < 10 else 60.0 if km < 40 else 85.0


SCHEMA = {
    "type": "object",
    "properties": {
        "depot": {"type": "object", "properties": {
            "name": {"type": "string"}, "lat": {"type": "number"}, "lon": {"type": "number"},
            "address": {"type": "string"}}},
        "stops": {"type": "array", "items": {"type": "object", "properties": {
            "name": {"type": "string"}, "lat": {"type": "number"}, "lon": {"type": "number"},
            "address": {"type": "string"}, "demand": {"type": "number"}, "opens": {"type": "string"}, "closes": {"type": "string"}}}},
        "vans": {"type": "integer"},
        "van_capacity": {"type": "number"},
        "rush_hour": {"type": "boolean"},
        "departure_time": {"type": "string"},
        "main_road_speed_pct": {"type": "number"},
        "shift_hours": {"type": "number"},
        "current_routes": {"type": "array", "items": {"type": "object", "properties": {
            "van": {"type": "integer"}, "stops": {"type": "array", "items": {"type": "string"}}}}},
        "fuel_price_per_gallon": {"type": "number"},
        "driver_cost_per_hour": {"type": "number"},
        "deliveries_per_week": {"type": "number"},
        "remove_stops": {"type": "array", "items": {"type": "string"}},
        "rush_hour_off": {"type": "boolean"},
        "unclear": {"type": "string"},
    },
    "required": ["depot", "stops", "vans", "van_capacity", "rush_hour", "departure_time",
                 "main_road_speed_pct", "shift_hours", "current_routes", "fuel_price_per_gallon",
                 "driver_cost_per_hour", "deliveries_per_week", "remove_stops", "rush_hour_off", "unclear"],
}

INSTRUCTIONS = (
    "You read a request to plan delivery routes. Copy the depot and every stop exactly as given, with "
    "latitude and longitude in decimal degrees. 'demand' is how much a stop needs (0 if not given). "
    "'opens' and 'closes' are when that stop takes deliveries, as 24-hour HH:MM, or '' if not given. "
    "'vans' is the number of vehicles (1 if not given). 'van_capacity' is what one van carries in the "
    "same units as demand (0 if not given, meaning unlimited). 'rush_hour' is true if the departure is "
    "during a morning or evening peak. 'departure_time' is when the vans leave as 24-hour HH:MM, or '' if "
    "not given. 'main_road_speed_pct' is a percentage the sender gives for how fast main roads move at "
    "peak compared with the speed limit (e.g. 'main roads at 50%' or 'half speed' is 50), or 0 if not given. "
    "'shift_hours' is the longest a driver may be out, in hours, or 0 if not given. "
    "'current_routes' is how the vans run TODAY if the sender describes it: one entry per van with the stop "
    "names in the order visited, using the stop names exactly as listed, not including the depot; [] if not "
    "given. 'fuel_price_per_gallon', 'driver_cost_per_hour' and 'deliveries_per_week' are numbers the sender "
    "gives, or 0. A stop (or the depot) may be given as a street address instead of coordinates: copy it "
    "exactly into 'address' and set lat and lon to 0. Never invent coordinates or addresses: a stop with "
    "neither goes in 'unclear'. 'remove_stops' lists stop names the sender wants dropped, [] if none. "
    "'rush_hour_off' is true only if the sender says the run is not at rush hour or is off-peak."
)


MAX_KM_FROM_DEPOT = 300
# "- Fountain Square Pantry: 39.7486, -86.1386 — 12 crates, 9:00-11:00"
POINT_LINE = re.compile(r"^\s*(?:[-*•]|\d+[.)])?\s*(?P<name>[^\n:]+?)\s*[:,]\s*(?P<lat>-?\d{1,2}\.\d+)\s*,\s*"
                        r"(?P<lon>-?\d{1,3}\.\d+)(?P<rest>[^\n]*)$", re.M)
CLOCK = re.compile(r"^\s*(\d{1,2}):(\d{2})\s*$")
_T = r"(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?"
WINDOW = re.compile(_T + r"\s*(?:-|–|—|to|until)\s*" + _T, re.I)


def _minutes(h, m, ampm) -> int | None:
    h, m = int(h), int(m or 0)
    ampm = (ampm or "").lower().replace(".", "")
    if ampm == "pm" and h < 12:
        h += 12
    if ampm == "am" and h == 12:
        h = 0
    return h * 60 + m if h < 24 and m < 60 else None


def _window(text: str):
    """(opens, closes) in minutes after midnight from text like '9:00-11:00' or '9am to 11'."""
    for m in WINDOW.finditer(text or ""):
        h1, m1, a1, h2, m2, a2 = m.groups()
        # A plain "12-15" is an amount, not hours: a time needs minutes or am/pm.
        if not (m1 or m2 or a1 or a2):
            continue
        if a2 and not a1 and int(h1) <= int(h2):
            a1 = a2
        o, c = _minutes(h1, m1, a1), _minutes(h2, m2, a2)
        if o is not None and c is not None and c > o:
            return o, c, m.span()
    return None


# "- Fountain Square Pantry: 1119 S State Ave, Indianapolis, IN 46203 - 12 crates - 9:00-10:30"
# A bullet is required, so a sentence with a colon in it is never taken for a stop.
ADDRESS_LINE = re.compile(r"^\s*(?:[-*•]|\d+[.)])\s+(?P<name>[^\n:]{2,80}?)\s*:\s*(?P<rest>[^\n]+)$", re.M)
SEGMENT_SPLIT = re.compile(r"\s+[-–—]\s+|;")
COORDS_FIRST = re.compile(r"\s*-?\d{1,2}\.\d+\s*,\s*-?\d{1,3}\.\d+")
# A depot written into a sentence rather than listed: "Depot 39.7486, -86.1386.",
# "leaving 8:00 from 39.7486, -86.1386", "start at 39.74, -86.13". Coordinates only:
# an inline street address is left to the model, which reads those well.
INLINE_DEPOT = re.compile(
    r"\b(?:depot|warehouse|base|from|start(?:ing)?\s+(?:at|from))\b[^\n\d-]{0,25}?"
    r"(?P<lat>-?\d{1,2}\.\d+)\s*,\s*(?P<lon>-?\d{1,3}\.\d+)", re.I)


def _inline_depot(text: str) -> dict | None:
    """The depot when it is written inline in the request rather than listed."""
    m = INLINE_DEPOT.search(text or "")
    if not m:
        return None
    return {"name": "Depot", "lat": float(m.group("lat")), "lon": float(m.group("lon")), "address": ""}


def _extras(rest: str):
    """(demand, window) from what follows a stop's location."""
    win = _window(rest)
    if win:
        rest = rest[:win[2][0]] + rest[win[2][1]:]
    amount = re.search(r"(\d+(?:\.\d+)?)", rest)
    return (float(amount.group(1)) if amount else 0.0), (win[:2] if win else None)


def _listed_points(text: str) -> list[dict]:
    """Stops written one per line, each with coordinates or a street address.

    Read from the email directly rather than by the model: a model asked to copy
    dozens of numbers drops or mangles some, and one wrong digit moves a stop miles.
    """
    points = []
    coord_lines = set()
    for m in POINT_LINE.finditer(text or ""):
        coord_lines.add(m.start())
        demand, window = _extras(m.group("rest"))
        points.append({"name": m.group("name").strip(), "lat": float(m.group("lat")), "lon": float(m.group("lon")),
                       "demand": demand, "window": window, "_at": m.start()})
    for m in ADDRESS_LINE.finditer(text or ""):
        if COORDS_FIRST.match(m.group("rest")):
            continue   # a coordinates line, already read above
        # A line already read as coordinates is not a second, address stop, even
        # when a note on it holds a colon: "8. Bates-Hendricks, 41.87, -87.62,
        # 6 crates - NOTE: this pantry has moved to Chicago, ~280 km" sent the note
        # to the geocoder as a street address on 2026-10-17.
        if m.start() in coord_lines:
            continue
        segments = [s.strip() for s in SEGMENT_SPLIT.split(m.group("rest")) if s.strip()]
        address = segments[0] if segments else ""
        # An address has a house number and a street name; anything else on the
        # line ("12 crates", "9:00-10:30") is not one.
        if not (re.search(r"\d", address) and re.search(r"[A-Za-z]{3,}", address)) or _window(address):
            continue
        demand, window = _extras(" - ".join(segments[1:]))
        points.append({"name": m.group("name").strip(), "address": address, "demand": demand, "window": window,
                       "_at": m.start()})
    points.sort(key=lambda p: p.pop("_at"))
    return points


RUNS_PER_WEEK = re.compile(r"\b(\d{1,2}|one|two|three|four|five|six|seven)\s+(?:days?|times|runs?|deliveries)\s+"
                           r"(?:a|per|each|every)\s+week\b", re.I)
WORD_NUMBERS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7}


def _runs_per_week(text: str) -> float:
    """'5 days a week', 'three times per week'. Read from the email directly: on
    2026-10-16 the model returned 0 for 'We run this 5 days a week'."""
    m = RUNS_PER_WEEK.search(text or "")
    if not m:
        return 0.0
    n = m.group(1).lower()
    n = WORD_NUMBERS.get(n) or int(n)
    return float(n) if 1 <= n <= 14 else 0.0


REQUEST_MARKER = "## THE REQUEST"


def _request_part(content: str) -> str:
    """The new email itself, without the quoted thread the platform puts above it."""
    i = (content or "").find(REQUEST_MARKER)
    if i < 0:
        return content or ""
    rest = content[i:]
    return rest.split("\n", 1)[1].strip() if "\n" in rest else ""


def _thread_file(thread: str) -> str:
    """Where a thread's plan is kept: the hire's own data folder, which survives restarts."""
    root = os.path.join(os.environ.get("AGENT_DATA_ROOT") or "/data", os.environ.get("DEPLOYMENT_ID") or "local",
                        "route_planner_threads")
    try:
        os.makedirs(root, exist_ok=True)
    except OSError:
        root = os.path.join("/tmp", "route_planner_threads")
        os.makedirs(root, exist_ok=True)
    return os.path.join(root, hashlib.sha256(thread.encode("utf-8")).hexdigest()[:32] + ".json")


def _load_thread(thread: str) -> dict | None:
    if not thread:
        return None
    try:
        with open(_thread_file(thread), encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def _save_thread(thread: str, points: list, settings: dict, facts: str = "") -> None:
    if not thread:
        return
    keep = ("name", "lat", "lon", "address", "matched", "demand", "window")
    try:
        with open(_thread_file(thread), "w", encoding="utf-8") as fh:
            # `facts` is the plan as sent (vans, stops in order, times, totals,
            # files): what a follow-up question is answered from, and the only
            # source its numbers may come from.
            json.dump({"points": [{k: p.get(k) for k in keep} for p in points], "settings": settings,
                       "facts": facts}, fh)
    except OSError as exc:
        _log(f"could not remember this thread's plan: {exc}")


ACK_ONLY = re.compile(r"^\W*(thanks?( you)?|thank u|thx|ty|ok(ay)?|great|perfect|got it|cool|awesome|sounds good|"
                      r"looks good|will do|noted|cheers)\b[\W\w]{0,40}$", re.I)
QUESTION_START = re.compile(r"^\W*(what|where|when|why|how|who|which|do|does|did|can|could|would|will|is|are|was|"
                            r"were|have|has|should|any|send|resend|attach|share|show)\b", re.I)


def _followup_kind(text: str, changed: bool) -> str:
    """'change', 'question' or 'ack' for a reply in a thread that already has a plan.

    Decided in code from what the sender just wrote, never from quoted history.
    On 2026-10-17 "Do you have the routes and sumo animations?" was taken as a
    change: the quoted stop list was read as new stops and the plan redone, worse.
    """
    if changed:
        return "change"
    t = " ".join((text or "").split())
    if not t:
        return "ack"
    if "?" in t or QUESTION_START.match(t):
        return "question"
    if ACK_ONLY.match(t):
        return "ack"
    return "question"   # unclear: answer with the current plan rather than re-plan or stay silent


NUMBER = re.compile(r"\d+(?:[.:]\d+)?")
FILE_WORDS = re.compile(r"\b(files?|attach\w*|csv|map|replay|animat\w*|gif|sumo|scenario|notebook|resend|send)\b", re.I)


def _untraced_numbers(answer: str, facts: str, question: str) -> list[str]:
    """Figures in a model's answer that appear in neither the plan's facts nor the question.

    Single digits are let through ("2 vans", "van 1"); anything else has to be
    copied, not worked out, because a reply that quotes a figure the plan never
    produced is the failure this agent exists to avoid.
    """
    known = set(NUMBER.findall((facts or "") + " " + (question or "")))
    known |= {k.lstrip("0") or "0" for k in known}
    return [n for n in NUMBER.findall(answer or "")
            if len(n) > 1 and n not in known and (n.lstrip("0") or "0") not in known]


async def _answer_from_plan(question: str, facts: str) -> str | None:
    """The model's answer to a question about the saved plan, or None if it quotes an untraced figure."""
    if not facts:
        return None
    text = await answer_question(question, facts)
    if not text:
        return None
    bad = _untraced_numbers(text, facts, question)
    if bad:
        _log(f"answer discarded: figures not in the plan: {', '.join(bad[:5])}")
        return None
    return text


def _differs(new, old) -> bool:
    """A setting the new email actually changes: given (not 0/''/[]) and different from the saved one."""
    if new in (None, 0, 0.0, "", [], False):
        return False
    return new != old


MAPS_STOPS_PER_LINK = 10   # origin + up to 8 waypoints + destination, inside Google's 9-waypoint limit


def _maps_links(routes: list, points: list) -> list[str]:
    """One Google Maps directions link per van (split into parts on long routes).

    A Maps URL, not the Maps API: no key, no charge, and nothing of Google's is
    shown on our map. The stop order is ours; Google draws the driving route
    between stops and gives the driver turn-by-turn directions with live traffic.
    """
    def ll(i):
        p = points[i]
        return f"{p['lat']:.6f},{p['lon']:.6f}" if isinstance(p.get("lat"), (int, float)) else None

    out = []
    for r in routes:
        seq = [i for i in r["seq"] if ll(i)]
        if len(seq) < 2:
            continue
        parts = []
        k = 0
        while k < len(seq) - 1:
            chunk = seq[k:k + MAPS_STOPS_PER_LINK]
            url = ("https://www.google.com/maps/dir/?api=1&travelmode=driving"
                   f"&origin={ll(chunk[0])}&destination={ll(chunk[-1])}")
            if len(chunk) > 2:
                url += "&waypoints=" + "%7C".join(ll(i) for i in chunk[1:-1])
            parts.append(url)
            k += MAPS_STOPS_PER_LINK - 1
        for n, url in enumerate(parts, 1):
            label = f"Van {r['van']}" + (f", part {n} of {len(parts)}" if len(parts) > 1 else "")
            out.append(f"{label}: {url}")
    return out


def _same_name(a: str, b: str) -> bool:
    a, b = " ".join(str(a).lower().split()), " ".join(str(b).lower().split())
    return bool(a and b) and (a == b or a in b or b in a)


SETTING_KEYS = ("vans", "van_capacity", "departure_time", "main_road_speed_pct", "rush_hour", "shift_hours",
                "fuel_price_per_gallon", "driver_cost_per_hour", "deliveries_per_week", "current_routes")


def _merge_settings(saved: dict, req: dict, text: str, changes: list) -> dict:
    """This email's settings on top of the thread's earlier ones; notes each change in `changes`."""
    out = {k: saved.get(k) for k in SETTING_KEYS}
    labels = {"vans": "vans", "van_capacity": "van capacity", "departure_time": "departure",
              "main_road_speed_pct": "main roads at rush hour (% of limit)", "shift_hours": "shift hours",
              "fuel_price_per_gallon": "diesel $/gallon", "driver_cost_per_hour": "driver $/hour",
              "deliveries_per_week": "runs a week"}
    new = dict(req)
    if not new.get("deliveries_per_week"):
        new["deliveries_per_week"] = _runs_per_week(text)
    for k, label in labels.items():
        v = new.get(k)
        if v not in (None, "", 0, 0.0) and v != out.get(k):
            if saved and out.get(k) not in (None, "", 0, 0.0):
                changes.append(f"{label} {out[k]} → {v}")
            elif saved:
                changes.append(f"{label} {v}")
            out[k] = v
    if new.get("rush_hour_off"):
        if saved and out.get("rush_hour"):
            changes.append("not rush hour")
        out["rush_hour"], out["main_road_speed_pct"] = False, 0
    elif new.get("rush_hour"):
        if saved and not out.get("rush_hour"):
            changes.append("rush hour")
        out["rush_hour"] = True
    if new.get("current_routes"):
        out["current_routes"] = new["current_routes"]
    out["unclear"] = new.get("unclear") or ""
    return out


def _clock_text(value) -> int | None:
    m = CLOCK.match(str(value or ""))
    return _minutes(m.group(1), m.group(2), None) if m else None


def _km(a, b) -> float:
    la1, lo1, la2, lo2 = map(math.radians, (a["lat"], a["lon"], b["lat"], b["lon"]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * 6371.0 * math.asin(math.sqrt(h)) * 1.3   # x1.3: roads are not straight lines


def _solve(cost, demands, vans, capacity, service_s=0, windows=None, shift_s=None, exact=True):
    """The best of two searches: least driving, and least total van time.

    With opening hours, counting waiting time is what stops a van being sent to
    sit outside a stop until it opens; but over a 6-second search that version
    sometimes settles on a plan with more van time overall than plain least-driving
    (2 h 47 min against 2 h 36 min on the demo). So both run, and the plan with the
    least total van time, waiting included, is kept. Without opening hours or a
    shift there is no waiting, and one search is enough.
    """
    proven = False
    if exact and len(cost) - 1 <= EXACT_MAX_STOPS:
        t = time.monotonic()
        routes = _solve_exact(cost, demands, vans, capacity, service_s, windows, shift_s)
        proven = True   # an exact search that finds nothing has proven nothing fits
        _log(f"exact search over every plan for {len(cost) - 1} stops in {time.monotonic() - t:.1f}s"
             + (f": {_van_time(routes, cost, service_s, windows) / 60:.1f} van-minutes, proven best" if routes
                else ": no plan fits"))
    elif not (windows or shift_s):
        routes = _solve_once(cost, demands, vans, capacity, service_s, None, None, False, 10)
    else:
        options = [r for r in (_solve_once(cost, demands, vans, capacity, service_s, windows, shift_s, span, 6)
                               for span in (False, True)) if r]
        routes = min(options, key=lambda rs: _van_time(rs, cost, service_s, windows)) if options else None
    # Number the vans in use 1, 2, 3 — the solver's own numbering skips any it left idle.
    for k, r in enumerate(routes or [], 1):
        r["van"] = k
        r["proven"] = proven
    return routes


# Up to this many stops every plan is checked and the best one proven. On the demo
# (8 stops) OR-tools' 6-second search came within 1.6% of the best but not to it
# (142.6 against 140.4 van-minutes, 2026-10-17), so "best" was not an honest word.
EXACT_MAX_STOPS = 11


def _solve_exact(cost, demands, vans, capacity, service_s, windows, shift_s):
    """The plan with the least total van time, waiting included, by checking every plan.

    For each set of stops one van could take, the best order is found with the
    Held-Karp method (best way to reach each stop having visited a given set),
    keeping the earliest time a van can start serving each stop: arriving earlier
    never hurts, since a van can always wait. Then every way of splitting all the
    stops between the vans is compared. Opening hours, van capacity and the shift
    limit are rules a plan must keep, exactly as in the search.
    """
    n = len(cost) - 1
    full = (1 << n) - 1
    INF = float("inf")

    def svc(i):
        return service_s if i != 0 else 0

    def arrive(t, j):
        """Service start at stop j for a van reaching it at t, or None if it has closed."""
        if windows and j in windows:
            o, c = windows[j]
            if t > c:
                return None
            return max(t, o)
        return t

    demand = [0.0] * (1 << n)
    for mask in range(1, 1 << n):
        low = (mask & -mask).bit_length() - 1
        demand[mask] = demand[mask & (mask - 1)] + demands[low + 1]

    # label[mask][j]: earliest service start at stop j+1 after visiting exactly `mask`.
    label = [[INF] * n for _ in range(1 << n)]
    back = [[-1] * n for _ in range(1 << n)]
    for j in range(n):
        t = arrive(cost[0][j + 1], j + 1)
        if t is not None:
            label[1 << j][j] = t
    for mask in range(1, 1 << n):
        if capacity > 0 and demand[mask] > capacity:
            continue
        row = label[mask]
        for j in range(n):
            t = row[j]
            if t == INF:
                continue
            for k in range(n):
                if mask >> k & 1:
                    continue
                nm = mask | (1 << k)
                if capacity > 0 and demand[nm] > capacity:
                    continue
                t2 = arrive(t + svc(j + 1) + cost[j + 1][k + 1], k + 1)
                if t2 is not None and t2 < label[nm][k]:
                    label[nm][k] = t2
                    back[nm][k] = j

    # One van's best time and last stop for each set of stops it could take.
    route = [INF] * (1 << n)
    last = [-1] * (1 << n)
    route[0] = 0.0
    for mask in range(1, 1 << n):
        for j in range(n):
            if label[mask][j] < INF:
                t = label[mask][j] + svc(j + 1) + cost[j + 1][0]
                if (not shift_s or t <= shift_s) and t < route[mask]:
                    route[mask], last[mask] = t, j

    # Split all stops between at most `vans` vans; each van's set holds its lowest stop.
    best = {0: (0.0, [])}
    for _ in range(min(vans, n)):
        nxt = dict(best)
        for covered, (total, sets) in best.items():
            rest = full & ~covered
            if not rest:
                continue
            low = rest & -rest
            sub = rest
            while sub:
                if sub & low and route[sub] < INF:
                    m2 = covered | sub
                    cand = total + route[sub]
                    if m2 not in nxt or cand < nxt[m2][0]:
                        nxt[m2] = (cand, sets + [sub])
                sub = (sub - 1) & rest
        best = nxt
    if full not in best:
        return None

    routes = []
    for mask in best[full][1]:
        order, m, j = [], mask, last[mask]
        while j >= 0:
            order.append(j + 1)
            pj = back[m][j]
            m &= ~(1 << j)
            j = pj
        routes.append({"seq": [0] + order[::-1] + [0]})
    return routes


def _van_time(routes, cost, service_s, windows):
    """Total seconds out across vans: driving, unloading, and waiting for stops to open."""
    total = 0.0
    for r in routes:
        t = 0.0
        for a, b in zip(r["seq"], r["seq"][1:]):
            t += cost[a][b] + (service_s if a != 0 else 0)
            if windows and b in windows:
                t = max(t, windows[b][0])
        total += t
    return total


def _solve_once(cost, demands, vans, capacity, service_s, windows, shift_s, count_waiting, seconds):
    """Routes minimising total `cost` (a square matrix of seconds or metres).

    With opening hours or a shift limit, a time dimension is added: the time at a
    stop is when the van starts serving it (it may wait there for the stop to open),
    and must fall inside that stop's window; a van must be back within the shift.
    """
    from ortools.constraint_solver import pywrapcp, routing_enums_pb2

    n = len(cost)
    mgr = pywrapcp.RoutingIndexManager(n, vans, 0)
    routing = pywrapcp.RoutingModel(mgr)
    cb = routing.RegisterTransitCallback(lambda i, j: int(cost[mgr.IndexToNode(i)][mgr.IndexToNode(j)]))
    routing.SetArcCostEvaluatorOfAllVehicles(cb)
    if capacity > 0:
        dcb = routing.RegisterUnaryTransitCallback(lambda i: int(round(demands[mgr.IndexToNode(i)])))
        routing.AddDimensionWithVehicleCapacity(dcb, 0, [int(capacity)] * vans, True, "load")
    if windows or shift_s:
        def transit(i, j):
            a, b = mgr.IndexToNode(i), mgr.IndexToNode(j)
            return int(cost[a][b]) + (int(service_s) if a != 0 else 0)
        tcb = routing.RegisterTransitCallback(transit)
        routing.AddDimension(tcb, 6 * 3600, int(shift_s or 16 * 3600), False, "time")
        td = routing.GetDimensionOrDie("time")
        for v in range(vans):
            td.CumulVar(routing.Start(v)).SetRange(0, 0)
        # Count each van's whole time out, waiting included, not only its driving.
        # Without this a van could be sent across town to sit outside a stop until
        # it opens - free to the solver, a paid driver doing nothing in reality.
        if count_waiting:
            td.SetSpanCostCoefficientForAllVehicles(1)
        for node, (o, c) in (windows or {}).items():
            td.CumulVar(mgr.NodeToIndex(node)).SetRange(max(0, int(o)), max(0, int(c)))
    params = pywrapcp.DefaultRoutingSearchParameters()
    params.first_solution_strategy = routing_enums_pb2.FirstSolutionStrategy.PATH_CHEAPEST_ARC
    params.local_search_metaheuristic = routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
    params.time_limit.FromSeconds(seconds)
    sol = routing.SolveWithParameters(params)
    if not sol:
        return None
    routes = []
    for v in range(vans):
        idx, seq = routing.Start(v), []
        while not routing.IsEnd(idx):
            seq.append(mgr.IndexToNode(idx))
            idx = sol.Value(routing.NextVar(idx))
        seq.append(0)
        if len(seq) > 2:
            routes.append({"van": v + 1, "seq": seq})
    return routes


def _log(line: str) -> None:
    """One step of the work, for the container log (not the reply)."""
    print(f"[route-planner] {line}", flush=True)


def _attach_sim(r, s):
    r["complete"] = len(s["arrivals"]) == s["expected"] and s["back"] is not None and not s["teleported"]
    r["arrive_s"] = s["arrivals"]
    r["back_s"] = s["back"]
    r["waited_min"] = s["waited_s"] / 60
    r["fuel_l"] = s["fuel_l"]
    r["co2_kg"] = s["co2_kg"]
    r["sim_km"] = s["km"]
    r["trace"] = s["trace"]
    r["edges"] = s["edges"]
    r["t0"] = s["t0"]


def _plan_on_roads(points, demands, vans, capacity, speeds, windows, shift_s, current):
    """Plan on the real road network and drive the plan (and today's routes) in SUMO.

    Raises RoadsUnavailable. Everything the pictures need is copied out before the
    SUMO session closes, so drawing happens with its memory already freed.
    """
    net = roads.build_network(points)
    global _SESSION
    with _SUMO:
        t0 = time.monotonic()
        if _SESSION is None:
            _SESSION = roads.Roads(net)
            _log(f"road network loaded: {len(_SESSION._core):,} roads, {time.monotonic() - t0:.1f}s")
        R = _SESSION
        R.prepare()
        try:
            snaps = [R.snap(p["lat"], p["lon"]) for p in points]
            streets = [R.street(s[0]) for s in snaps]
            for p, street, (_, _, gap) in zip(points, streets, snaps):
                _log(f"snapped {p['name']!r} to {street or 'an unnamed road'} ({gap:.0f} m away)")
            xy = [R.xy(p["lat"], p["lon"]) for p in points]
            R.apply_peak(*speeds)
            _log(f"road speeds: main roads at {speeds[0]:g}% of their limits, side streets {speeds[1]:g}%")
            t1 = time.monotonic()
            secs, metres, missing = R.matrices([s[0] for s in snaps])
            legs = [secs[i][j] for i in range(len(points)) for j in range(len(points))
                    if i != j and secs[i][j] < 1e6] or [0.0]
            _log(f"driving times: {len(points)}x{len(points)} matrix of road routes in {time.monotonic() - t1:.1f}s, "
                 f"legs {min(legs) / 60:.1f}-{max(legs) / 60:.1f} min")
            if missing:
                cut = sorted({points[j]["name"] for _, j in missing} | {points[i]["name"] for i, _ in missing})
                raise roads.RoadsUnavailable("some stops cannot be reached by road from the others "
                                             f"({', '.join(cut[:5])})")
            t1 = time.monotonic()
            secs = R.simulated_matrix([s[0] for s in snaps], [s[1] for s in snaps], secs, log=_log)
            _log(f"  ({time.monotonic() - t1:.1f}s)")
            t2 = time.monotonic()
            routes = _solve(secs, demands, vans, capacity, STOP_MINUTES * 60, windows, shift_s)
            if not routes:
                _log("solver: no plan meets the capacity, opening hours and shift limit together")
                return None
            planned = sum(secs[a][b] for r in routes for a, b in zip(r["seq"], r["seq"][1:])) / 60
            _log(f"solver (OR-tools, guided local search): {len(routes)} route(s), {planned:.1f} min of driving "
                 f"in total, {time.monotonic() - t2:.1f}s"
                 + (f", {len(windows)} opening-hours window(s)" if windows else "")
                 + (f", shift limit {shift_s / 3600:g} h" if shift_s else ""))
            for r in routes:
                _log(f"  van {r['van']}: " + " -> ".join(points[i]["name"] for i in r["seq"]))

            def stops_of(seq):
                return [(snaps[i][0], snaps[i][1], (windows or {}).get(i, (None, None))[0]) for i in seq]

            t3 = time.monotonic()
            sim = R.simulate([{"van": r["van"], "stops": stops_of(r["seq"])} for r in routes],
                             STOP_MINUTES * 60, label="plan", log=_log)
            for r in routes:
                _attach_sim(r, sim[r["van"]])
            today = None
            if current:
                today = [{"van": k + 1, "seq": [0] + seq + [0]} for k, seq in enumerate(current)]
                sim_t = R.simulate([{"van": r["van"], "stops": stops_of(r["seq"])} for r in today],
                                   STOP_MINUTES * 60, label="today", log=_log)
                for r in today:
                    _attach_sim(r, sim_t[r["van"]])
            _log(f"simulation finished in {time.monotonic() - t3:.1f}s of computing")
            for plan in [routes] + ([today] if today else []):
                for r in plan:
                    pairs = list(zip(r["seq"], r["seq"][1:]))
                    r["km"] = sum(metres[a][b] for a, b in pairs) / 1000
                    r["planned_min"] = sum(secs[a][b] for a, b in pairs) / 60 + STOP_MINUTES * (len(r["seq"]) - 2)
                    r["line"] = R.shape_xy(r["edges"])
            def scenario_vans(plan):
                # Exactly what was simulated, stop positions clamped as simulate()
                # clamps them, so re-running the zip gives the same numbers.
                vans_out = []
                for r in plan:
                    stops_out = []
                    for k, i in enumerate(r["seq"]):
                        edge, pos = snaps[i][0], snaps[i][1]
                        if 0 < k < len(r["seq"]) - 1:
                            pos = min(max(pos, 1.0), R.ts.lane.getLength(f"{edge}_0") - 0.1)
                        else:
                            pos = max(0.0, pos)
                        opens = (windows or {}).get(i, (None, None))[0]
                        stops_out.append({"name": points[i]["name"], "edge": edge, "pos": pos,
                                          "opens_s": opens if opens and opens > 0 else None,
                                          "duration": STOP_MINUTES * 60})
                    # The simulation clock it left at: traffic lights cycle on that clock,
                    # so the re-run must leave at the same moment to meet the same lights.
                    vans_out.append({"van": r["van"], "edges": r["edges"], "stops": stops_out,
                                     "depart_s": r["t0"]})
                return vans_out

            scen = {"plan": scenario_vans(routes)}
            if today:
                scen["today"] = scenario_vans(today)
            far = [(points[i]["name"], d) for i, (_, _, d) in enumerate(snaps) if d > roads.SNAP_WARN_M]
            return {"routes": routes, "today": today, "far": far, "xy": xy, "streets": streets,
                    "secs": secs, "metres": metres, "scenario": scen}
        except roads.RoadsUnavailable:
            raise   # a problem with the request, not with the session
        except Exception:
            # A session that failed mid-run may hold half a simulation; start the
            # next email from a fresh one rather than trust it.
            R.close()
            _SESSION = None
            raise


def _plan_straight(points, demands, vans, capacity, slow, windows, shift_s):
    """The fallback: straight-line distances x1.3 at assumed speeds."""
    dist = [[_km(a, b) * 1000 for b in points] for a in points]
    secs = [[d / 1000 / _fallback_kmh(d / 1000) * 3600 * slow for d in row] for row in dist]
    # No exact search on straight-line guesses: proving the best plan for distances
    # that are themselves estimates would claim more than it shows.
    routes = _solve(secs if windows or shift_s else dist, demands, vans, capacity, STOP_MINUTES * 60,
                    windows, shift_s, exact=False)
    for r in routes or []:
        legs = list(zip(r["seq"], r["seq"][1:]))
        r["km"] = sum(dist[a][b] for a, b in legs) / 1000
        r["planned_min"] = sum(secs[a][b] for a, b in legs) / 60 + STOP_MINUTES * (len(r["seq"]) - 2)
        r["complete"] = False
    return routes


def _clock(start_min, offset_s):
    if start_min is None:
        return f"+{offset_s / 60:.0f} min"
    t = (start_min + offset_s / 60) % (24 * 60)
    return f"{int(t // 60):02d}:{int(t % 60):02d}"


def _totals(plan, fuel_price, driver_rate):
    """Distance, van hours, fuel, money and CO2 for a simulated plan."""
    km = sum(r["km"] for r in plan)
    hours = sum((r["back_s"] if r.get("complete") else r["planned_min"] * 60) for r in plan) / 3600
    fuel = sum(r.get("fuel_l", 0.0) for r in plan)
    co2 = sum(r.get("co2_kg", 0.0) for r in plan)
    fuel_cost = fuel / LITRES_PER_GALLON * fuel_price
    driver_cost = hours * driver_rate
    return {"km": km, "hours": hours, "fuel_l": fuel, "co2_kg": co2, "fuel_cost": fuel_cost,
            "driver_cost": driver_cost, "cost": fuel_cost + driver_cost}


def _hm(hours):
    h, m = divmod(round(max(hours, 0) * 60), 60)
    return f"{h} h {m:02d} min" if h else f"{m} min"


def _match_current(current_raw, points):
    """Today's routes as lists of point indexes, or (None, reason) when they cannot be compared."""
    if not isinstance(current_raw, list) or not current_raw:
        return None, ""
    names = {p["name"].strip().lower(): i for i, p in enumerate(points) if i > 0}

    def find(name):
        n = str(name or "").strip().lower()
        if n in names:
            return names[n]
        hits = [i for key, i in names.items() if n and (n in key or key in n)]
        return hits[0] if len(hits) == 1 else None

    routes, unknown = [], []
    for van in current_raw:
        seq = []
        for name in (van or {}).get("stops") or []:
            i = find(name)
            if i is None:
                if "depot" not in str(name).lower():
                    unknown.append(str(name))
            elif i not in seq:
                seq.append(i)
        if seq:
            routes.append(seq)
    covered = {i for seq in routes for i in seq}
    if unknown:
        return None, f"I couldn't match these stops in today's routes to the list: {', '.join(unknown[:5])}"
    if covered != set(range(1, len(points))):
        missing = [points[i]["name"] for i in range(1, len(points)) if i not in covered]
        return None, f"today's routes don't visit every stop on the list (missing {', '.join(missing[:5])})"
    return routes, ""


async def run_agent(content: str, context: dict, attach_fn=None) -> dict:
    # A reply in the same thread adjusts the plan already made there ("main roads
    # at 40%", "add a van", "drop Haughville") instead of starting from nothing:
    # the stops and settings are remembered per thread, because the platform only
    # passes back the last 4,000 characters of quoted history.
    request_text = _request_part(content)
    thread = str(context.get("thread_id") or "")
    saved = _load_thread(thread)
    if saved:
        prompt = (
            "This email replies to a plan already made in this thread. Settings of that plan: "
            + json.dumps(saved["settings"]) + ". Stops already planned: "
            + ", ".join(p["name"] for p in saved["points"])
            + ". Fill a field only if THIS email changes it, giving the full new value (for example 'add a van' to "
              "2 vans means vans 3); leave every other field 0, '' or [].\n\nTHE NEW EMAIL:\n" + request_text)
        req = await extract(INSTRUCTIONS, prompt, SCHEMA, SCHEMA["required"])
    else:
        req = await extract(INSTRUCTIONS, content, SCHEMA, SCHEMA["required"])
    if req is None:
        return {"action": "reply_email", "text": "Sorry — I couldn't read that request just now. Please send it "
                "again; if it keeps happening, list the depot and stops one per line as name, latitude, longitude."}

    def usable(s):
        has_xy = isinstance(s.get("lat"), (int, float)) and isinstance(s.get("lon"), (int, float)) \
            and (s["lat"], s["lon"]) != (0, 0)
        if has_xy:
            return {**s, "address": ""}
        if str(s.get("address") or "").strip():
            return {**s, "lat": None, "lon": None}
        return None

    def from_model(items):
        out = []
        for s in items or []:
            s = usable(s)
            if s:
                o, c = _clock_text(s.get("opens")), _clock_text(s.get("closes"))
                out.append({**s, "window": (o, c) if o is not None and c is not None and c > o else None})
        return out

    # Coordinates and addresses are read from the email directly when they are
    # written one place per line: a model asked to copy dozens of numbers drops or
    # mangles some, and a route built on one wrong digit is thousands of km long.
    listed = _listed_points(request_text if saved else content)
    changes = []
    depot_assumed = None
    reply_lead = None
    if saved:
        changed = bool(listed) or bool(req.get("remove_stops")) or bool(from_model(req.get("stops"))) \
            or bool(req.get("rush_hour_off")) \
            or any(_differs(req.get(k), saved["settings"].get(k)) for k in SETTING_KEYS)
        kind = _followup_kind(request_text, changed)
        _log(f"reply in a planned thread: {kind}")
        if kind == "ack":
            return {"action": "none", "no_reply": "an acknowledgement, with no change or question in it"}
        if kind == "question":
            # Nothing to change. Answer from the plan as sent, never by re-planning
            # from anything quoted below; re-send the plan and its files only when
            # the question is about them.
            answered = await _answer_from_plan(request_text, saved.get("facts") or "")
            if answered and not FILE_WORDS.search(request_text):
                return {"action": "reply_email", "text": answered + "\n\nNothing in the plan has changed. To change "
                        "it, reply with the change - for example \"add a van\" or \"drop Haughville Pantry\"."}
            req = {**{k: v for k, v in req.items() if k not in SETTING_KEYS}, "stops": [], "remove_stops": []}
            listed = []
            reply_lead = (answered + "\n\n" if answered else "") + (
                "No changes made — here is the current plan again, with its files and a Google Maps link "
                "for each van. To change it, reply with the change (for example \"add a van\" or "
                "\"drop Haughville Pantry\").")
    if saved and not (len(listed) >= 3 and any("depot" in p["name"].lower() for p in listed)):
        # A follow-up: start from the thread's plan, then apply what this email adds,
        # replaces or removes.
        depot = dict(saved["points"][0])
        stops = [dict(p) for p in saved["points"][1:]]
        for p in listed or from_model(req.get("stops")):
            same = next((k for k, s in enumerate(stops) if _same_name(s["name"], p["name"])), None)
            if same is None:
                stops.append(p)
                changes.append(f"added {p['name']}")
            else:
                stops[same] = {**stops[same], **{k: v for k, v in p.items() if v not in (None, "", 0.0)}}
                changes.append(f"updated {p['name']}")
        dropped = []
        for name in req.get("remove_stops") or []:
            keep = [s for s in stops if not _same_name(s["name"], name)]
            if len(keep) < len(stops):
                dropped += [s["name"] for s in stops if s not in keep]
                stops = keep
        if dropped:
            changes.append(f"dropped {', '.join(dropped)}")
        req = _merge_settings(saved["settings"], req, request_text, changes)
        # A dropped stop leaves today's routes too, so the comparison still works.
        if dropped and req.get("current_routes"):
            req["current_routes"] = [{**v, "stops": [n for n in v.get("stops") or []
                                                      if not any(_same_name(n, d) for d in dropped)]}
                                     for v in req["current_routes"]]
    else:
        if len(listed) >= 3:
            # The depot is the line named as one; failing that, one written inline
            # ("Depot 39.74, -86.13." or "leaving 8:00 from 39.74, -86.13"); only
            # then the first line. Taking the first line unconditionally turned the
            # first stop into the depot whenever the depot was given in a sentence:
            # 4 of 7 Route Planner tasks in the 2026-10-17 battery planned one stop
            # short, and one reported 22 crates for a 37-crate request.
            depot_i = next((i for i, p in enumerate(listed) if "depot" in p["name"].lower()), None)
            inline = _inline_depot(request_text if saved else content)
            same_place = next((i for i, p in enumerate(listed) if inline and isinstance(p.get("lat"), (int, float))
                               and _km(inline, p) < 0.05), None)
            if depot_i is not None:
                depot = listed.pop(depot_i)
            elif same_place is not None:
                depot = listed.pop(same_place)
            elif inline:
                depot = inline
            else:
                depot = listed.pop(0)
                depot_assumed = depot.get("name") or "the first place listed"
            stops = listed
        else:
            depot = usable(req.get("depot") or {}) or {}
            stops = from_model(req.get("stops"))
        req = _merge_settings({}, req, content, [])
    if not depot or len(stops) < 2:
        return {"action": "reply_email", "text": "I need the depot and at least two stops to plan routes. List them "
                "one per line as name: street address (or latitude, longitude), and optionally the amount and "
                "opening hours — for example \"- Fountain Square Pantry: 1119 S State Ave, Indianapolis, IN 46203 "
                "- 12 crates - 9:00-10:30\"."}

    # Street addresses become coordinates before anything else runs.
    to_find = [p for p in [depot] + stops if p.get("address") and not isinstance(p.get("lat"), (int, float))]
    if to_find:
        try:
            found = await geocode.locate_all([p["address"] for p in to_find])
        except geocode.GeocoderUnavailable as exc:
            return {"action": "reply_email", "text": f"Sorry — {exc} just now, so I couldn't look up the addresses. "
                    "Please send it again in a few minutes, or give latitude and longitude instead."}
        missing = []
        for p, f in zip(to_find, found):
            if f is None:
                missing.append(f"{p['name']} ({p['address']})")
            else:
                p["lat"], p["lon"], p["matched"] = f
        _log(f"addresses: {len(to_find) - len(missing)} of {len(to_find)} located with the Census geocoder")
        for p in to_find:
            if p.get("matched"):
                _log(f"  {p['name']!r}: {p['address']!r} -> {p['matched']} ({p['lat']:.5f}, {p['lon']:.5f})")
        if missing:
            return {"action": "reply_email", "text": "I couldn't find these addresses: " + "; ".join(missing) +
                    ". Check the street, number and ZIP code (US addresses only), or give latitude and longitude "
                    "for them, and send the list again."}
    stops = stops[:60]
    far = [s["name"] for s in stops if _km(depot, s) / 1.3 > MAX_KM_FROM_DEPOT]
    if far:
        return {"action": "reply_email", "text": f"These stops are more than {MAX_KM_FROM_DEPOT} km from the depot, "
                f"which usually means a typo in a coordinate: {', '.join(far)}. Check them and send again."}
    vans_assumed = not req.get("vans")
    vans = max(1, min(int(req.get("vans") or 1), 10))
    capacity = float(req.get("van_capacity") or 0)
    points = [{"name": depot.get("name") or "Depot", "lat": depot["lat"], "lon": depot["lon"],
               "address": depot.get("address", ""), "matched": depot.get("matched", "")}] + stops
    demands = [0.0] + [float(s.get("demand") or 0) for s in stops]

    if capacity > 0 and sum(demands) > capacity * vans:
        return {"action": "reply_email", "text": f"The stops need {sum(demands):g} in total but {vans} van(s) carry "
                f"{capacity * vans:g}. Add a van or raise the capacity and I'll plan it."}

    start_min = _clock_text(req.get("departure_time"))
    has_windows = any(s.get("window") for s in stops)
    assumed_departure = has_windows and start_min is None
    if assumed_departure:
        start_min = DEFAULT_DEPARTURE
    windows = {}
    for i, s in enumerate(stops, 1):
        if s.get("window"):
            o, c = s["window"]
            windows[i] = ((o - start_min) * 60, (c - start_min) * 60)
    shift_h = float(req.get("shift_hours") or 0)
    shift_s = shift_h * 3600 if 0 < shift_h <= 16 else None
    # Rush hour is inferred only from a departure the sender gave, never from the
    # 08:00 assumed above, which would slow every road on a guess about a guess.
    rush = bool(req.get("rush_hour")) or (start_min is not None and not assumed_departure and
                                          (7 * 60 <= start_min < 9 * 60 + 30 or 16 * 60 <= start_min < 18 * 60 + 30))
    main_pct = float(req.get("main_road_speed_pct") or 0)
    main_pct = main_pct if 5 <= main_pct <= 100 else PEAK_MAIN_PCT
    speeds = (main_pct, max(main_pct, PEAK_MINOR_PCT)) if rush else (BASE_SPEED_PCT, BASE_SPEED_PCT)
    fuel_price = float(req.get("fuel_price_per_gallon") or 0) or FUEL_PRICE_PER_GALLON
    driver_rate = float(req.get("driver_cost_per_hour") or 0) or DRIVER_COST_PER_HOUR
    per_week = float(req.get("deliveries_per_week") or 0)
    current, current_note = _match_current(req.get("current_routes"), points)

    closed_before = [points[i]["name"] for i, (o, c) in windows.items() if c < 0]
    if closed_before:
        return {"action": "reply_email", "text": f"These stops close before the vans leave at {_clock(start_min, 0)}: "
                f"{', '.join(closed_before)}. Check the times, or give an earlier departure."}

    _log(f"request: {len(stops)} stops, {vans} van(s), capacity {capacity:g}, "
         f"departure {_clock(start_min, 0) if start_min is not None else 'not given'}"
         f"{' (assumed)' if assumed_departure else ''}, "
         f"rush hour {'yes, main roads ' + format(main_pct, 'g') + '%' if rush else 'no'}, "
         f"{len(windows)} opening-hours window(s), shift {shift_h:g} h, "
         f"today's routes {'given' if current else 'not given' + (' (' + current_note + ')' if current_note else '')}")
    on_roads, why_not = None, ""
    try:
        on_roads = await asyncio.to_thread(_plan_on_roads, points, demands, vans, capacity, speeds, windows,
                                           shift_s, current)
        if on_roads is None:
            return {"action": "reply_email", "text": _no_plan_text(vans, windows, shift_h)}
    except roads.RoadsUnavailable as exc:
        why_not = str(exc)
        _log(f"real roads not used: {why_not}; falling back to straight-line estimates")
    except Exception as exc:   # anything unexpected in the road path: still answer, on the estimate
        print(f"[route-planner] road planning failed: {type(exc).__name__}: {exc}", flush=True)
        why_not = "the road simulation failed"

    if on_roads:
        routes, today = on_roads["routes"], on_roads["today"]
    else:
        today = None
        routes = await asyncio.to_thread(_plan_straight, points, demands, vans, capacity,
                                         100.0 / main_pct if rush else 1.0, windows, shift_s)
        if not routes:
            return {"action": "reply_email", "text": _no_plan_text(vans, windows, shift_h)}

    head = f"{len(stops)} stops, {vans} van(s)" + (f", capacity {capacity:g} each" if capacity else "")
    if start_min is not None:
        head += f", leaving at {_clock(start_min, 0)}" + (" (my assumption — tell me if not)" if assumed_departure else "")
    lines = ([reply_lead, ""] if reply_lead else []) \
        + ([f"Re-planned with your changes: {'; '.join(changes)}.", ""] if changes else []) + [head + ".", ""]
    # Say what was assumed rather than plan on it silently.
    assumed = []
    if depot_assumed:
        assumed.append(f"I used {depot_assumed} as the depot, since none was marked — tell me if the vans start "
                       "somewhere else")
    if vans_assumed:
        assumed.append("you didn't say how many vans, so I planned for one"
                       + ("" if capacity else " with no load limit") + " — tell me how many and how much each carries")
    elif not capacity and any(d > 0 for d in demands):
        assumed.append("you didn't say how much each van carries, so I planned with no load limit")
    if assumed:
        lines += ["Assumed: " + "; ".join(assumed) + ".", ""]

    plan_t = _totals(routes, fuel_price, driver_rate) if on_roads else None
    if on_roads and today:
        today_t = _totals(today, fuel_price, driver_rate)
        save = {k: today_t[k] - plan_t[k] for k in today_t}
        pct = 100 * save["km"] / today_t["km"] if today_t["km"] else 0
        lines += [
            "Compared with how the vans run today (both simulated the same way):",
            f"  Today:     {today_t['km']:.1f} km, {_hm(today_t['hours'])} of van time, {today_t['fuel_l']:.1f} L diesel, "
            f"{today_t['co2_kg']:.0f} kg CO2, about ${today_t['cost']:.0f}",
            f"  This plan: {plan_t['km']:.1f} km, {_hm(plan_t['hours'])} of van time, {plan_t['fuel_l']:.1f} L diesel, "
            f"{plan_t['co2_kg']:.0f} kg CO2, about ${plan_t['cost']:.0f}",
        ]
        if save["cost"] > 0.5:
            lines.append(f"  Saving per run: {save['km']:.1f} km ({pct:.0f}%), {_hm(save['hours'])}, "
                         f"{save['fuel_l']:.1f} L diesel, {save['co2_kg']:.0f} kg CO2, about ${save['cost']:.0f} "
                         f"(${save['fuel_cost']:.0f} fuel + ${save['driver_cost']:.0f} driver time)")
            if per_week:
                lines.append(f"  At {per_week:g} runs a week: about ${save['cost'] * per_week:.0f} and "
                             f"{save['co2_kg'] * per_week:.0f} kg CO2 a week.")
        else:
            lines.append("  Today's routes are already about as good as this plan — I couldn't find a meaningful saving.")
        late_today = _late(today, points, windows)
        if late_today:
            lines.append(f"  Today's routes also reach {', '.join(late_today)} after they close.")
        lines.append("")
    elif current_note:
        lines += [f"Note: {current_note}, so I haven't compared with today's routes.", ""]

    rows = ["van,order,stop,address,matched_address,lat,lon,demand,opens,closes,arrives,street"]
    for r in routes:
        load = sum(demands[i] for i in r["seq"])
        if r["complete"]:
            minutes = r["back_s"] / 60
            stops_txt = [f"{points[i]['name']} ({_arrival_text(start_min, t, windows.get(i))})"
                         for i, t in zip(r["seq"][1:-1], r["arrive_s"])]
            when = [_clock(start_min, 0)] + [_clock(start_min, t) for t in r["arrive_s"]] + [_clock(start_min, r["back_s"])]
        else:
            minutes = r["planned_min"]
            stops_txt = [points[i]["name"] for i in r["seq"][1:-1]]
            when = [""] * len(r["seq"])
        back = f"{points[0]['name']} (back {_clock(start_min, r['back_s'])})" if r["complete"] else points[0]["name"]
        names = " → ".join([points[0]["name"]] + stops_txt + [back])
        extra = (f" and {r['waited_min']:.0f} min at traffic lights and junctions, {r['fuel_l']:.1f} L diesel"
                 if r["complete"] else "")
        lines.append(f"Van {r['van']}: {r['km']:.1f} km, about {minutes:.0f} min including {STOP_MINUTES:g} min "
                     f"per stop{extra}" + (f", load {load:g}" if capacity else "") + f"\n  {names}")
        for k, (i, w) in enumerate(zip(r["seq"], when)):
            win = points[i].get("window")
            street = on_roads["streets"][i] if on_roads else ""
            rows.append(f"{r['van']},{k},{points[i]['name']},\"{points[i].get('address', '')}\","
                        f"\"{points[i].get('matched', '')}\",{points[i]['lat']},{points[i]['lon']},{demands[i]:g},"
                        f"{_clock(0, win[0] * 60) if win else ''},{_clock(0, win[1] * 60) if win else ''},{w},"
                        f"\"{street}\"")
    lines += ["", f"Total: {sum(r['km'] for r in routes):.1f} km."]
    late = _late(routes, points, windows)
    if late:
        lines.append(f"In the simulation, {', '.join(late)} would be reached after closing — the drive took "
                     f"longer than the plan expected. Starting earlier or adding a van would fix it.")

    if on_roads:
        lines.append("Planned on the real road network (OpenStreetMap) for the least total van time"
                     + (", within opening hours" if windows else "") + (f" and a {shift_h:g}-hour shift" if shift_s else "")
                     + ", then checked by driving each van through a SUMO simulation of those roads: speed limits, "
                       "one-way streets, turns and traffic lights, with no other traffic.")
        if routes and routes[0].get("proven"):
            lines.append("This is the best possible plan for these driving times: every way of splitting the stops "
                         "between the vans, and every order, was checked (measured by total van time, waiting "
                         "included).")
        else:
            lines.append(f"With more than {EXACT_MAX_STOPS} stops this is the best plan found in a short search — "
                         "very good, but not proven to be the very best.")
        lines.append(f"Fuel and CO2 are from SUMO's emission model for a diesel delivery van. Costs assume diesel at "
                     f"${fuel_price:.2f}/gallon and driver time at ${driver_rate:.0f}/hour — tell me your own figures.")
        if any(not r["complete"] for r in routes):
            lines.append("For " + ", ".join(f"van {r['van']}" for r in routes if not r["complete"]) +
                         " the simulation did not finish cleanly, so its time is from the plan.")
        if on_roads["far"]:
            lines.append("Check these coordinates — they are more than "
                         f"{roads.SNAP_WARN_M:.0f} m from the nearest road, so I used the nearest road: "
                         + ", ".join(f"{n} ({d:.0f} m)" for n, d in on_roads["far"]) + ".")
    else:
        lines.append(f"I couldn't use real roads this time ({why_not}), so distances are straight-line x1.3 "
                     f"estimates, and times assume 35 km/h for short legs, 60 km/h up to 40 km and 85 km/h beyond.")
        lines.append("The route map, the replay and the SUMO scenario all need every stop inside the area I have "
                     "road maps for, so this reply has routes.csv and the Google Maps links below instead. Plan the "
                     "stops outside it separately and you'll get all of them.")
    if rush:
        lines.append(f"Rush hour: main roads at {main_pct:g}% of their speed limits and side streets at "
                     f"{max(main_pct, PEAK_MINOR_PCT):g}%. That is an assumption, not measured traffic — tell me "
                     f"your own figure (for example \"main roads at 50%\") to see how it changes the plan.")
    elif on_roads:
        lines.append(f"Outside rush hour, roads are taken at {BASE_SPEED_PCT:g}% of their speed limits: real city "
                     f"driving runs well below the limits, and this matches typical drive times in the area.")
    links = _maps_links(routes, points)
    if links:
        lines += ["", "Open each van's route in Google Maps (stops in this order; Google gives the driver turn-by-turn "
                  "directions with live traffic):"] + links + [""]
    lines.append("Times are estimates, not live traffic — road closures and incidents on the day aren't known — "
                 "so the comparison between plans is more reliable than any single arrival time.")
    if on_roads:
        lines.append("Map data © OpenStreetMap contributors (ODbL)."
                     + (" Addresses located with the U.S. Census Bureau Geocoder; the matched addresses are in "
                        "routes.csv." if any(p.get("matched") for p in points) else ""))
        lines += ["",
                  "Check it or change it yourself: sumo-scenario.zip is the SUMO simulation behind these numbers. "
                  "Open plan.sumocfg in SUMO's viewer to watch it, or edit the settings in run_scenario.py "
                  "(road speeds, minutes per stop) and run it to see the times, fuel and CO2 move.",
                  "Or just reply with a change — \"main roads at 40%\", \"add a van\", \"leave at 7:30\", "
                  "\"drop Haughville Pantry\" — and I'll re-plan and re-simulate."]
    if req.get("unclear"):
        lines += ["", f"Note: {req['unclear']}"]

    deliverables = []
    if attach_fn:
        if attach_fn("routes.csv", "\n".join(rows) + "\n"):
            deliverables.append("routes.csv")
        if on_roads:
            deliverables += _attach_pictures(attach_fn, points, on_roads, start_min, lines, req, fuel_price,
                                             driver_rate, plan_t)
            try:
                packed = scenario.scenario_zip(on_roads["scenario"], {
                    "main_roads_pct": speeds[0], "side_streets_pct": speeds[1], "stop_minutes": STOP_MINUTES,
                    "emission_class": roads.VAN_EMISSION_CLASS, "departure_minutes": start_min})
                if packed and attach_fn("sumo-scenario.zip", packed):
                    deliverables.append("sumo-scenario.zip")
                    _log(f"SUMO scenario packed ({len(packed) // 1024} KB)")
            except Exception as exc:
                _log(f"scenario failed: {type(exc).__name__}: {exc}")
    facts = "\n".join(l for l in lines if l and not l.startswith(("Check it or change it", "Or just reply"))) \
        + "\nFiles sent with this plan: " + (", ".join(deliverables) or "none") \
        + ("\nReal roads were used." if on_roads else f"\nReal roads were not used: {why_not}.")
    _save_thread(thread, points, {k: req.get(k) for k in SETTING_KEYS}, facts)
    return {"action": "reply_email", "text": "\n".join(lines), "deliverables": deliverables}


def _arrival_text(start_min, t, window):
    """'08:58, waits for 09:00 opening' when the van is early; otherwise just the time."""
    if window and t < window[0] - 30:
        return f"{_clock(start_min, t)}, waits for {_clock(start_min, window[0])} opening"
    return _clock(start_min, t)


def _late(plan, points, windows):
    """Stops a simulated van reached after they closed."""
    out = []
    for r in plan:
        if not r.get("complete"):
            continue
        for i, t in zip(r["seq"][1:-1], r["arrive_s"]):
            if i in windows and t > windows[i][1] + 60:
                out.append(points[i]["name"])
    return out


def _no_plan_text(vans, windows, shift_h):
    reasons = []
    if windows:
        reasons.append("the opening hours")
    if shift_h:
        reasons.append(f"a {shift_h:g}-hour shift")
    if reasons:
        return (f"No plan with {vans} van(s) meets {' and '.join(reasons)} together with the van capacity. "
                "Try another van, a longer shift, an earlier start, or wider delivery windows, and I'll plan it again.")
    return ("No plan fits those constraints — usually one stop needs more than a single van carries. "
            "Check the amounts and capacity.")


def _attach_pictures(attach_fn, points, on_roads, start_min, lines, req, fuel_price, driver_rate, plan_t):
    """Map, replay and working notebook. A failure here must not lose the reply."""
    out = []
    xy = on_roads["xy"]
    labels = [(p["name"], *xy[i]) for i, p in enumerate(points) if i > 0]

    def panel(title, plan):
        return {"title": title, "depot": xy[0], "labels": labels,
                "vans": [{"van": r["van"], "line": r["line"], "stops": [xy[i] for i in r["seq"][1:-1]],
                          "label": f"Van {r['van']} ({r['km']:.1f} km)"} for r in plan]}

    plan_panel = panel("This plan", on_roads["routes"])
    panels = ([panel("Today", on_roads["today"])] if on_roads["today"] else []) + [plan_panel]
    map_png = None
    try:
        t = time.monotonic()
        map_png = report.static_map(panels)
        if attach_fn("route_map.png", map_png):
            out.append("route_map.png")
        _log(f"map drawn in {time.monotonic() - t:.1f}s ({len(map_png) // 1024} KB)")
    except Exception as exc:
        _log(f"map failed: {type(exc).__name__}: {exc}")
    try:
        t = time.monotonic()
        traces = {r["van"]: r["trace"] for r in on_roads["routes"] if r.get("trace")}
        gif = report.replay_gif(plan_panel, traces, lambda s: _clock(start_min, s))
        if attach_fn("route_replay.gif", gif):
            out.append("route_replay.gif")
        _log(f"replay drawn in {time.monotonic() - t:.1f}s ({len(gif) // 1024} KB)")
    except Exception as exc:
        _log(f"replay failed: {type(exc).__name__}: {exc}")
    try:
        def plan_data(name, plan):
            return {"name": name, "vans": [{
                "van": r["van"], "stops": [points[i]["name"] for i in r["seq"]],
                "arrivals": [_clock(start_min, s) for s in r.get("arrive_s", [])],
                "back": _clock(start_min, r["back_s"]) if r.get("complete") else None,
                "road_km": round(r["km"], 2), "fuel_litres": round(r.get("fuel_l", 0.0), 2),
                "co2_kg": round(r.get("co2_kg", 0.0), 2),
                "minutes_at_lights_and_junctions": round(r.get("waited_min", 0.0), 1),
                "line": [[round(x), round(y)] for x, y in r["line"][::3] + r["line"][-1:]]} for r in plan]}

        names = [p["name"] for p in points]
        data = {
            "request": {k: req.get(k) for k in ("vans", "van_capacity", "departure_time", "rush_hour",
                                                "main_road_speed_pct", "shift_hours", "current_routes")},
            "assumptions": {"stop_minutes": STOP_MINUTES, "fuel_price_per_gallon": fuel_price,
                            "driver_cost_per_hour": driver_rate, "emission_model": roads.VAN_EMISSION_CLASS},
            "stops": [{"name": p["name"], "address_given": p.get("address", ""),
                       "address_matched": p.get("matched", ""), "lat": p["lat"], "lon": p["lon"],
                       "matched_street": on_roads["streets"][i],
                       "opens_closes": p.get("window")} for i, p in enumerate(points)],
            "driving_minutes": {"order": names,
                                "matrix": [[round(s / 60, 1) for s in row] for row in on_roads["secs"]]},
            "plans": [plan_data("This plan", on_roads["routes"])]
                     + ([plan_data("Today", on_roads["today"])] if on_roads["today"] else []),
            "totals": plan_t,
        }
        summary = "\n".join("> " + line if line else ">" for line in lines)
        nb = report.notebook("Route Planner — working", summary, data, map_png)
        if attach_fn("route-planner-working.ipynb", nb):
            out.append("route-planner-working.ipynb")
    except Exception as exc:
        _log(f"notebook failed: {type(exc).__name__}: {exc}")
    return out


async def resume_agent(thread_id: str, resolution: dict, **tools) -> dict:
    return {"action": "none"}
