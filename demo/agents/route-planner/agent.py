"""Route Planner — plans delivery routes on real roads with OR-tools, then drives them in SUMO.

Email the depot and the stops (name plus latitude/longitude, and optionally how
much each stop needs), how many vans and how much each carries, and optionally a
departure time. It loads the area's roads from OpenStreetMap, works out driving
times between every pair of stops, plans the routes that take the least driving
time, then drives each van through a SUMO simulation of those roads — speed
limits, one-way streets, turns and traffic lights — to get its arrival time at
every stop. Attaches a CSV of the routes and a map of them on the roads.

If the road map cannot be loaded (the map service is down, or the stops span too
large an area), it plans on straight-line distances instead and says so.
"""
import asyncio
import io
import math
import re
import threading

from llm_extract import extract
import roads

# Only for the straight-line fallback: city speed for short legs, road speeds for long ones.
def _fallback_kmh(km: float) -> float:
    return 35.0 if km < 10 else 60.0 if km < 40 else 85.0
STOP_MINUTES = 5.0
PEAK_MAIN_PCT = 70.0        # rush hour default: main roads at this share of their limit
PEAK_MINOR_PCT = 90.0       # ... and side streets at this share
# libsumo runs one simulation per process; two emails at once must take turns.
_SUMO = threading.Lock()

SCHEMA = {
    "type": "object",
    "properties": {
        "depot": {"type": "object", "properties": {
            "name": {"type": "string"}, "lat": {"type": "number"}, "lon": {"type": "number"}}},
        "stops": {"type": "array", "items": {"type": "object", "properties": {
            "name": {"type": "string"}, "lat": {"type": "number"}, "lon": {"type": "number"},
            "demand": {"type": "number"}}}},
        "vans": {"type": "integer"},
        "van_capacity": {"type": "number"},
        "rush_hour": {"type": "boolean"},
        "departure_time": {"type": "string"},
        "main_road_speed_pct": {"type": "number"},
        "unclear": {"type": "string"},
    },
    "required": ["depot", "stops", "vans", "van_capacity", "rush_hour", "departure_time",
                 "main_road_speed_pct", "unclear"],
}

INSTRUCTIONS = (
    "You read a request to plan delivery routes. Copy the depot and every stop exactly as given, with "
    "latitude and longitude in decimal degrees. 'demand' is how much a stop needs (0 if not given). "
    "'vans' is the number of vehicles (1 if not given). 'van_capacity' is what one van carries in the "
    "same units as demand (0 if not given, meaning unlimited). 'rush_hour' is true if the departure is "
    "during a morning or evening peak. 'departure_time' is when the vans leave as 24-hour HH:MM, or '' if "
    "not given. 'main_road_speed_pct' is a percentage the sender gives for how fast main roads move at "
    "peak compared with the speed limit (e.g. 'main roads at 50%' is 50), or 0 if not given. "
    "Do not invent coordinates: a stop without them goes in 'unclear'."
)


MAX_KM_FROM_DEPOT = 300
# "- Fountain Square Pantry: 39.7486, -86.1386 — 12 crates"
POINT_LINE = re.compile(r"^\s*(?:[-*•]|\d+[.)])?\s*(?P<name>[^\n:]+?)\s*[:,]\s*(?P<lat>-?\d{1,2}\.\d+)\s*,\s*"
                        r"(?P<lon>-?\d{1,3}\.\d+)(?P<rest>[^\n]*)$", re.M)
CLOCK = re.compile(r"^\s*(\d{1,2}):(\d{2})\s*$")


def _listed_points(text: str) -> list[dict]:
    points = []
    for m in POINT_LINE.finditer(text or ""):
        amount = re.search(r"(\d+(?:\.\d+)?)", m.group("rest"))
        points.append({"name": m.group("name").strip(), "lat": float(m.group("lat")), "lon": float(m.group("lon")),
                       "demand": float(amount.group(1)) if amount else 0.0})
    return points


def _km(a, b) -> float:
    la1, lo1, la2, lo2 = map(math.radians, (a["lat"], a["lon"], b["lat"], b["lon"]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * 6371.0 * math.asin(math.sqrt(h)) * 1.3   # x1.3: roads are not straight lines


def _solve(cost, demands, vans, capacity):
    """Routes minimising total `cost` (a square integer matrix), with van capacity."""
    from ortools.constraint_solver import pywrapcp, routing_enums_pb2

    n = len(cost)
    mgr = pywrapcp.RoutingIndexManager(n, vans, 0)
    routing = pywrapcp.RoutingModel(mgr)
    cb = routing.RegisterTransitCallback(lambda i, j: cost[mgr.IndexToNode(i)][mgr.IndexToNode(j)])
    routing.SetArcCostEvaluatorOfAllVehicles(cb)
    if capacity > 0:
        dcb = routing.RegisterUnaryTransitCallback(lambda i: int(round(demands[mgr.IndexToNode(i)])))
        routing.AddDimensionWithVehicleCapacity(dcb, 0, [int(capacity)] * vans, True, "load")
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


def _plan_on_roads(points, demands, vans, capacity, peak):
    """Plan on the real road network and drive the plan in SUMO. Raises RoadsUnavailable."""
    net = roads.build_network(points)
    with _SUMO:
        R = roads.Roads(net)
        try:
            snaps = [R.snap(p["lat"], p["lon"]) for p in points]
            if peak:
                R.apply_peak(*peak)
            secs, metres, missing = R.matrices([s[0] for s in snaps])
            if missing:
                cut = sorted({points[j]["name"] for _, j in missing} | {points[i]["name"] for i, _ in missing})
                raise roads.RoadsUnavailable("some stops cannot be reached by road from the others "
                                             f"({', '.join(cut[:5])})")
            routes = _solve([[int(round(t)) for t in row] for row in secs], demands, vans, capacity)
            if not routes:
                return None
            sim = R.simulate([{"van": r["van"], "stops": [snaps[i][:2] for i in r["seq"]]} for r in routes],
                             STOP_MINUTES * 60)
            for r in routes:
                legs = list(zip(r["seq"], r["seq"][1:]))
                r["km"] = sum(metres[a][b] for a, b in legs) / 1000
                r["planned_min"] = sum(secs[a][b] for a, b in legs) / 60 + STOP_MINUTES * (len(r["seq"]) - 2)
                s = sim[r["van"]]
                r["complete"] = (len(s["arrivals"]) == s["expected"] and s["back"] is not None
                                 and not s["teleported"])
                r["arrive_s"] = s["arrivals"]
                r["back_s"] = s["back"]
                r["geo"] = R.geo(s["edges"])
            far = [(points[i]["name"], d) for i, (_, _, d) in enumerate(snaps) if d > roads.SNAP_WARN_M]
            return {"routes": routes, "far": far}
        finally:
            R.close()


def _plan_straight(points, demands, vans, capacity, slow):
    """The fallback: straight-line distances x1.3 at assumed speeds."""
    dist = [[int(round(_km(a, b) * 1000)) for b in points] for a in points]
    routes = _solve(dist, demands, vans, capacity)
    for r in routes or []:
        legs = [dist[a][b] / 1000 for a, b in zip(r["seq"], r["seq"][1:])]
        r["km"] = sum(legs)
        r["planned_min"] = (sum(k / _fallback_kmh(k) * 60 for k in legs) * slow
                            + STOP_MINUTES * (len(r["seq"]) - 2))
        r["complete"] = False
    return routes


def _clock(start_min, offset_s):
    if start_min is None:
        return f"+{offset_s / 60:.0f} min"
    t = (start_min + offset_s / 60) % (24 * 60)
    return f"{int(t // 60):02d}:{int(t % 60):02d}"


def _map(points, routes) -> bytes:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig, ax = plt.subplots(figsize=(7, 6), dpi=120)
    for r in routes:
        if r.get("geo") and r["geo"][0]:
            xs, ys = r["geo"]
        else:
            xs = [points[i]["lon"] for i in r["seq"]]
            ys = [points[i]["lat"] for i in r["seq"]]
        line, = ax.plot(xs, ys, linewidth=1.6, label=f"Van {r['van']} ({r['km']:.1f} km)")
        ax.scatter([points[i]["lon"] for i in r["seq"][1:-1]], [points[i]["lat"] for i in r["seq"][1:-1]],
                   s=22, color=line.get_color(), zorder=4)
    ax.scatter([points[0]["lon"]], [points[0]["lat"]], marker="s", s=120, c="black", zorder=5, label="Depot")
    for p in points[1:]:
        ax.annotate(p["name"][:18], (p["lon"], p["lat"]), fontsize=7, xytext=(3, 3), textcoords="offset points")
    ax.set_xlabel("Longitude")
    ax.set_ylabel("Latitude")
    ax.legend(fontsize=8)
    ax.grid(alpha=0.3)
    buf = io.BytesIO()
    fig.tight_layout()
    fig.savefig(buf, format="png")
    plt.close(fig)
    return buf.getvalue()


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
        stops = [s for s in req.get("stops") or []
                 if isinstance(s.get("lat"), (int, float)) and isinstance(s.get("lon"), (int, float))]
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

    clock = CLOCK.match(str(req.get("departure_time") or ""))
    start_min = int(clock.group(1)) * 60 + int(clock.group(2)) if clock and int(clock.group(1)) < 24 else None
    rush = bool(req.get("rush_hour")) or (start_min is not None and
                                          (7 * 60 <= start_min < 9 * 60 + 30 or 16 * 60 <= start_min < 18 * 60 + 30))
    main_pct = float(req.get("main_road_speed_pct") or 0)
    main_pct = main_pct if 5 <= main_pct <= 100 else PEAK_MAIN_PCT
    peak = (main_pct, max(main_pct, PEAK_MINOR_PCT)) if rush else None

    on_roads, why_not = None, ""
    try:
        on_roads = await asyncio.to_thread(_plan_on_roads, points, demands, vans, capacity, peak)
        if on_roads is None:
            return {"action": "reply_email", "text": "No plan fits those constraints — usually one stop needs more "
                    "than a single van carries. Check the amounts and capacity."}
    except roads.RoadsUnavailable as exc:
        why_not = str(exc)
    except Exception as exc:   # anything unexpected in the road path: still answer, on the estimate
        print(f"[route-planner] road planning failed: {type(exc).__name__}: {exc}", flush=True)
        why_not = "the road simulation failed"

    if on_roads:
        routes = on_roads["routes"]
    else:
        routes = await asyncio.to_thread(_plan_straight, points, demands, vans, capacity,
                                         100.0 / main_pct if rush else 1.0)
        if not routes:
            return {"action": "reply_email", "text": "No plan fits those constraints — usually one stop needs more "
                    "than a single van carries. Check the amounts and capacity."}

    head = f"{len(stops)} stops, {vans} van(s)" + (f", capacity {capacity:g} each" if capacity else "")
    if start_min is not None:
        head += f", leaving at {_clock(start_min, 0)}"
    lines = [head + ".", ""]
    rows = ["van,order,stop,lat,lon,demand,arrives"]
    total_km = 0.0
    for r in routes:
        load = sum(demands[i] for i in r["seq"])
        total_km += r["km"]
        if r["complete"]:
            minutes = r["back_s"] / 60
            stops_txt = [f"{points[i]['name']} ({_clock(start_min, t)})" for i, t in zip(r["seq"][1:-1], r["arrive_s"])]
            when = [_clock(start_min, 0)] + [_clock(start_min, t) for t in r["arrive_s"]] + [_clock(start_min, r["back_s"])]
        else:
            minutes = r["planned_min"]
            stops_txt = [points[i]["name"] for i in r["seq"][1:-1]]
            when = [""] * len(r["seq"])
        back = f"{points[0]['name']} (back {_clock(start_min, r['back_s'])})" if r["complete"] else points[0]["name"]
        names = " → ".join([points[0]["name"]] + stops_txt + [back])
        lines.append(f"Van {r['van']}: {r['km']:.1f} km, about {minutes:.0f} min including {STOP_MINUTES:g} min "
                     f"per stop" + (f", load {load:g}" if capacity else "") + f"\n  {names}")
        rows += [f"{r['van']},{k},{points[i]['name']},{points[i]['lat']},{points[i]['lon']},{demands[i]:g},{w}"
                 for k, (i, w) in enumerate(zip(r["seq"], when))]
    lines += ["", f"Total: {total_km:.1f} km."]

    if on_roads:
        lines.append("Planned on the real road network (OpenStreetMap) for the least driving time, then checked by "
                     "driving each van through a SUMO simulation of those roads: speed limits, one-way streets, "
                     "turns and traffic lights, with no other traffic.")
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
    if req.get("unclear"):
        lines += ["", f"Note: {req['unclear']}"]

    deliverables = []
    if attach_fn:
        if attach_fn("routes.csv", "\n".join(rows) + "\n"):
            deliverables.append("routes.csv")
        if attach_fn("route_map.png", _map(points, routes)):
            deliverables.append("route_map.png")
    return {"action": "reply_email", "text": "\n".join(lines), "deliverables": deliverables}


async def resume_agent(thread_id: str, resolution: dict, **tools) -> dict:
    return {"action": "none"}
