"""Route Planner — plans delivery routes for a list of stops, with OR-tools and SUMO.

Email the depot and the stops (name plus latitude/longitude, and optionally how
much each stop needs), how many vans and how much each carries. It replies with
each van's route, distance and time, and — for rush-hour departures — times
adjusted by a traffic slowdown measured in a SUMO simulation. Attaches a CSV of
the routes and a map.
"""
import asyncio
import io
import math
import os
import random
import re

from llm_extract import extract

HERE = os.path.dirname(os.path.abspath(__file__))
FREE_FLOW_KMH = 35.0
STOP_MINUTES = 5.0

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
        "unclear": {"type": "string"},
    },
    "required": ["depot", "stops", "vans", "van_capacity", "rush_hour", "unclear"],
}

INSTRUCTIONS = (
    "You read a request to plan delivery routes. Copy the depot and every stop exactly as given, with "
    "latitude and longitude in decimal degrees. 'demand' is how much a stop needs (0 if not given). "
    "'vans' is the number of vehicles (1 if not given). 'van_capacity' is what one van carries in the "
    "same units as demand (0 if not given, meaning unlimited). 'rush_hour' is true if the departure is "
    "during a morning or evening peak. Do not invent coordinates: a stop without them goes in 'unclear'."
)


MAX_KM_FROM_DEPOT = 300
# "- Fountain Square Pantry: 39.7486, -86.1386 — 12 crates"
POINT_LINE = re.compile(r"^\s*(?:[-*•]|\d+[.)])?\s*(?P<name>[^\n:]+?)\s*[:,]\s*(?P<lat>-?\d{1,2}\.\d+)\s*,\s*"
                        r"(?P<lon>-?\d{1,3}\.\d+)(?P<rest>[^\n]*)$", re.M)


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


def _plan(points, demands, vans, capacity):
    from ortools.constraint_solver import pywrapcp, routing_enums_pb2

    n = len(points)
    dist = [[int(round(_km(points[i], points[j]) * 1000)) for j in range(n)] for i in range(n)]
    mgr = pywrapcp.RoutingIndexManager(n, vans, 0)
    routing = pywrapcp.RoutingModel(mgr)
    cb = routing.RegisterTransitCallback(lambda i, j: dist[mgr.IndexToNode(i)][mgr.IndexToNode(j)])
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
        idx, seq, meters = routing.Start(v), [], 0
        while not routing.IsEnd(idx):
            seq.append(mgr.IndexToNode(idx))
            nxt = sol.Value(routing.NextVar(idx))
            meters += dist[mgr.IndexToNode(idx)][mgr.IndexToNode(nxt)]
            idx = nxt
        seq.append(0)
        if len(seq) > 2:
            routes.append({"van": v + 1, "seq": seq, "km": meters / 1000})
    return routes


_RUSH_FACTOR = None


def _rush_factor() -> float:
    """How much slower trips are at peak than off-peak, measured once with SUMO on a 5x5 city grid."""
    global _RUSH_FACTOR
    if _RUSH_FACTOR is not None:
        return _RUSH_FACTOR
    import libsumo

    def mean_seconds_per_km(cars: int) -> float:
        libsumo.start(["sumo", "-n", os.path.join(HERE, "grid.net.xml"), "--no-step-log",
                       "--no-warnings", "--end", "1800", "--seed", "1"])
        edges = [e for e in libsumo.edge.getIDList() if not e.startswith(":")]
        rnd = random.Random(1)
        for i in range(cars):
            a, b = rnd.sample(edges, 2)
            r = libsumo.simulation.findRoute(a, b).edges
            if r:
                libsumo.route.add(f"r{i}", r)
                libsumo.vehicle.add(f"v{i}", f"r{i}", depart=str(rnd.uniform(0, 600)))
        depart, length, rates = {}, {}, []
        while libsumo.simulation.getMinExpectedNumber() > 0 and libsumo.simulation.getTime() < 1800:
            libsumo.simulationStep()
            now = libsumo.simulation.getTime()
            for vid in libsumo.simulation.getDepartedIDList():
                depart[vid] = now
                length[vid] = libsumo.route.getEdges(libsumo.vehicle.getRouteID(vid))
            for vid in libsumo.simulation.getArrivedIDList():
                km = sum(libsumo.lane.getLength(f"{e}_0") for e in length.get(vid, [])) / 1000
                if km > 0.2:
                    rates.append((now - depart[vid]) / km)
        libsumo.close()
        return sum(rates) / len(rates) if rates else 1.0

    off_peak, peak = mean_seconds_per_km(40), mean_seconds_per_km(900)
    _RUSH_FACTOR = max(1.0, peak / off_peak)
    return _RUSH_FACTOR


def _map(points, routes) -> bytes:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig, ax = plt.subplots(figsize=(7, 6), dpi=120)
    for r in routes:
        xs = [points[i]["lon"] for i in r["seq"]]
        ys = [points[i]["lat"] for i in r["seq"]]
        ax.plot(xs, ys, marker="o", label=f"Van {r['van']} ({r['km']:.1f} km)")
    ax.scatter([points[0]["lon"]], [points[0]["lat"]], marker="s", s=120, c="black", zorder=5, label="Depot")
    for i, p in enumerate(points[1:], 1):
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
    vans =max(1, min(int(req.get("vans") or 1), 10))
    capacity = float(req.get("van_capacity") or 0)
    points = [{"name": depot.get("name") or "Depot", "lat": depot["lat"], "lon": depot["lon"]}] + stops
    demands = [0.0] + [float(s.get("demand") or 0) for s in stops]

    if capacity > 0 and sum(demands) > capacity * vans:
        return {"action": "reply_email", "text": f"The stops need {sum(demands):g} in total but {vans} van(s) carry "
                f"{capacity * vans:g}. Add a van or raise the capacity and I'll plan it."}

    routes = await asyncio.to_thread(_plan, points, demands, vans, capacity)
    if not routes:
        return {"action": "reply_email", "text": "No plan fits those constraints — usually one stop needs more "
                "than a single van carries. Check the amounts and capacity."}

    factor = await asyncio.to_thread(_rush_factor) if req.get("rush_hour") else 1.0
    lines = [f"{len(stops)} stops, {vans} van(s)" + (f", capacity {capacity:g} each" if capacity else "") + ".", ""]
    rows = ["van,order,stop,lat,lon,demand"]
    total_km = 0.0
    for r in routes:
        load = sum(demands[i] for i in r["seq"])
        minutes = (r["km"] / FREE_FLOW_KMH * 60) * factor + STOP_MINUTES * (len(r["seq"]) - 2)
        total_km += r["km"]
        names = " → ".join(points[i]["name"] for i in r["seq"])
        lines.append(f"Van {r['van']}: {r['km']:.1f} km, about {minutes:.0f} min"
                     + (f", load {load:g}" if capacity else "") + f"\n  {names}")
        rows += [f"{r['van']},{k},{points[i]['name']},{points[i]['lat']},{points[i]['lon']},{demands[i]:g}"
                 for k, i in enumerate(r["seq"])]
    lines += ["", f"Total: {total_km:.1f} km."]
    if req.get("rush_hour"):
        lines.append(f"Rush hour: times include a {factor:.2f}x slowdown measured in a SUMO traffic simulation "
                     f"of a city grid at peak versus off-peak volume.")
    lines.append(f"Distances are straight-line x1.3 for streets; times assume {FREE_FLOW_KMH:g} km/h free-flow "
                 f"and {STOP_MINUTES:g} min per stop.")
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
