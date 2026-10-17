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
import math
import re
import threading
import time

from llm_extract import extract
import report
import roads

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


# Only for the straight-line fallback: city speed for short legs, road speeds for long ones.
def _fallback_kmh(km: float) -> float:
    return 35.0 if km < 10 else 60.0 if km < 40 else 85.0


SCHEMA = {
    "type": "object",
    "properties": {
        "depot": {"type": "object", "properties": {
            "name": {"type": "string"}, "lat": {"type": "number"}, "lon": {"type": "number"}}},
        "stops": {"type": "array", "items": {"type": "object", "properties": {
            "name": {"type": "string"}, "lat": {"type": "number"}, "lon": {"type": "number"},
            "demand": {"type": "number"}, "opens": {"type": "string"}, "closes": {"type": "string"}}}},
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
        "unclear": {"type": "string"},
    },
    "required": ["depot", "stops", "vans", "van_capacity", "rush_hour", "departure_time",
                 "main_road_speed_pct", "shift_hours", "current_routes", "fuel_price_per_gallon",
                 "driver_cost_per_hour", "deliveries_per_week", "unclear"],
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
    "gives, or 0. Do not invent coordinates: a stop without them goes in 'unclear'."
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


def _listed_points(text: str) -> list[dict]:
    points = []
    for m in POINT_LINE.finditer(text or ""):
        rest = m.group("rest")
        win = _window(rest)
        if win:
            rest = rest[:win[2][0]] + rest[win[2][1]:]
        amount = re.search(r"(\d+(?:\.\d+)?)", rest)
        points.append({"name": m.group("name").strip(), "lat": float(m.group("lat")), "lon": float(m.group("lon")),
                       "demand": float(amount.group(1)) if amount else 0.0,
                       "window": win[:2] if win else None})
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


def _clock_text(value) -> int | None:
    m = CLOCK.match(str(value or ""))
    return _minutes(m.group(1), m.group(2), None) if m else None


def _km(a, b) -> float:
    la1, lo1, la2, lo2 = map(math.radians, (a["lat"], a["lon"], b["lat"], b["lon"]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * 6371.0 * math.asin(math.sqrt(h)) * 1.3   # x1.3: roads are not straight lines


def _solve(cost, demands, vans, capacity, service_s=0, windows=None, shift_s=None):
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
        for node, (o, c) in (windows or {}).items():
            td.CumulVar(mgr.NodeToIndex(node)).SetRange(max(0, int(o)), max(0, int(c)))
    params = pywrapcp.DefaultRoutingSearchParameters()
    params.first_solution_strategy = routing_enums_pb2.FirstSolutionStrategy.PATH_CHEAPEST_ARC
    params.local_search_metaheuristic = routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
    params.time_limit.FromSeconds(10)
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


def _plan_on_roads(points, demands, vans, capacity, speeds, windows, shift_s, current):
    """Plan on the real road network and drive the plan (and today's routes) in SUMO.

    Raises RoadsUnavailable. Everything the pictures need is copied out before the
    SUMO session closes, so drawing happens with its memory already freed.
    """
    net = roads.build_network(points)
    with _SUMO:
        t0 = time.monotonic()
        R = roads.Roads(net)
        try:
            _log(f"road network loaded: {len(R._core):,} roads, {time.monotonic() - t0:.1f}s")
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
            far = [(points[i]["name"], d) for i, (_, _, d) in enumerate(snaps) if d > roads.SNAP_WARN_M]
            return {"routes": routes, "today": today, "far": far, "xy": xy, "streets": streets,
                    "secs": secs, "metres": metres}
        finally:
            R.close()


def _plan_straight(points, demands, vans, capacity, slow, windows, shift_s):
    """The fallback: straight-line distances x1.3 at assumed speeds."""
    dist = [[_km(a, b) * 1000 for b in points] for a in points]
    secs = [[d / 1000 / _fallback_kmh(d / 1000) * 3600 * slow for d in row] for row in dist]
    routes = _solve(secs if windows or shift_s else dist, demands, vans, capacity, STOP_MINUTES * 60,
                    windows, shift_s)
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
    req = await extract(INSTRUCTIONS, content, SCHEMA, SCHEMA["required"])
    if req is None:
        return {"action": "reply_email", "text": "Sorry — I couldn't read that request just now. Please send it "
                "again; if it keeps happening, list the depot and stops one per line as name, latitude, longitude."}
    # Coordinates are read from the email directly when they are written one place
    # per line: a model asked to copy dozens of numbers drops or mangles some, and a
    # route built on one wrong digit is thousands of km long.
    listed = _listed_points(content)
    if len(listed) >= 3:
        depot_i = next((i for i, p in enumerate(listed) if "depot" in p["name"].lower()), 0)
        depot = listed.pop(depot_i)
        stops = listed
    else:
        depot = req.get("depot") or {}
        stops = []
        for s in req.get("stops") or []:
            if isinstance(s.get("lat"), (int, float)) and isinstance(s.get("lon"), (int, float)):
                o, c = _clock_text(s.get("opens")), _clock_text(s.get("closes"))
                stops.append({**s, "window": (o, c) if o is not None and c is not None and c > o else None})
    if not isinstance(depot.get("lat"), (int, float)) or len(stops) < 2:
        return {"action": "reply_email", "text": "I need the depot and at least two stops, each with a latitude "
                "and longitude, to plan routes. Paste them as a list (name, lat, lon, and optionally the amount)."}
    stops = stops[:60]
    far = [s["name"] for s in stops if _km(depot, s) / 1.3 > MAX_KM_FROM_DEPOT]
    if far:
        return {"action": "reply_email", "text": f"These stops are more than {MAX_KM_FROM_DEPOT} km from the depot, "
                f"which usually means a typo in a coordinate: {', '.join(far)}. Check them and send again."}
    vans = max(1, min(int(req.get("vans") or 1), 10))
    capacity = float(req.get("van_capacity") or 0)
    points = [{"name": depot.get("name") or "Depot", "lat": depot["lat"], "lon": depot["lon"]}] + stops
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
    per_week = float(req.get("deliveries_per_week") or 0) or _runs_per_week(content)
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
    lines = [head + ".", ""]

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

    rows = ["van,order,stop,lat,lon,demand,opens,closes,arrives,street"]
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
            rows.append(f"{r['van']},{k},{points[i]['name']},{points[i]['lat']},{points[i]['lon']},{demands[i]:g},"
                        f"{_clock(0, win[0] * 60) if win else ''},{_clock(0, win[1] * 60) if win else ''},{w},"
                        f"\"{street}\"")
    lines += ["", f"Total: {sum(r['km'] for r in routes):.1f} km."]
    late = _late(routes, points, windows)
    if late:
        lines.append(f"In the simulation, {', '.join(late)} would be reached after closing — the drive took "
                     f"longer than the plan expected. Starting earlier or adding a van would fix it.")

    if on_roads:
        lines.append("Planned on the real road network (OpenStreetMap) for the least driving time"
                     + (", within opening hours" if windows else "") + (f" and a {shift_h:g}-hour shift" if shift_s else "")
                     + ", then checked by driving each van through a SUMO simulation of those roads: speed limits, "
                       "one-way streets, turns and traffic lights, with no other traffic.")
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
    if rush:
        lines.append(f"Rush hour: main roads at {main_pct:g}% of their speed limits and side streets at "
                     f"{max(main_pct, PEAK_MINOR_PCT):g}%. That is an assumption, not measured traffic — tell me "
                     f"your own figure (for example \"main roads at 50%\") to see how it changes the plan.")
    elif on_roads:
        lines.append(f"Outside rush hour, roads are taken at {BASE_SPEED_PCT:g}% of their speed limits: real city "
                     f"driving runs well below the limits, and this matches typical drive times in the area.")
    lines.append("Times are estimates, not live traffic — road closures and incidents on the day aren't known — "
                 "so the comparison between plans is more reliable than any single arrival time.")
    if on_roads:
        lines.append("Map data © OpenStreetMap contributors (ODbL).")
    if req.get("unclear"):
        lines += ["", f"Note: {req['unclear']}"]

    deliverables = []
    if attach_fn:
        if attach_fn("routes.csv", "\n".join(rows) + "\n"):
            deliverables.append("routes.csv")
        if on_roads:
            deliverables += _attach_pictures(attach_fn, points, on_roads, start_min, lines, req, fuel_price,
                                             driver_rate, plan_t)
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
            "stops": [{"name": p["name"], "lat": p["lat"], "lon": p["lon"], "matched_street": on_roads["streets"][i],
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
