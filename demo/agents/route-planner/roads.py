"""Real roads for Route Planner: an OpenStreetMap road network, driving times between
stops, and a SUMO simulation of vans driving it, with traffic lights, turns, speed
limits, opening hours at stops, and SUMO's own fuel and CO2 model.

Kept apart from agent.py so the email handling stays readable. Nothing here talks to
the model; everything is computed.

The network (and the grey street background the maps are drawn on) is built once by
build.sh for a fixed area; this module only reads it, so nothing here runs other
programs or reaches the internet.

Coordinates: maps and the replay are drawn in the network's own x/y metres, the same
system SUMO reports van positions in, so nothing needs converting back to lat/lon.
"""
import json
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))
NET = os.path.join(HERE, "roads.net.xml")       # built by build.sh
AREA = os.path.join(HERE, "map_area.json")
BACKGROUND = os.path.join(HERE, "background.png")
SNAP_WARN_M = 250.0      # a stop further than this from any road is probably a wrong coordinate
# SUMO's HBEFA4 class for a diesel delivery van (N1 class III, Euro 6). Checked
# 2026-10-16 on SUMO 1.28: a 12 km run used 1.05 L (8.6 L/100 km) and 2.65 kg CO2/L.
VAN_EMISSION_CLASS = "HBEFA4/LCV_diesel_N1-III_Euro-6ab"
DIESEL_KG_PER_L = 0.832
TRACE_EVERY_S = 10.0


class RoadsUnavailable(Exception):
    """The road map cannot be used for this request; the message says why, in words for the buyer."""


def area() -> dict | None:
    try:
        with open(AREA, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def build_network(points) -> str:
    """Path to the road network, if every point lies in the area it covers."""
    a = area()
    if a is None or not os.path.exists(NET):
        raise RoadsUnavailable("the road map is missing from this installation")
    outside = [p["name"] for p in points
               if not (a["south"] <= p["lat"] <= a["north"] and a["west"] <= p["lon"] <= a["east"])]
    if outside:
        listed = ", ".join(outside[:5]) + (f" and {len(outside) - 5} more" if len(outside) > 5 else "")
        raise RoadsUnavailable(f"I have road maps for {a['name']} only, and these are outside it: {listed}")
    return NET


def _largest_scc(succ: dict) -> set:
    """The largest strongly connected set of nodes in a successor map (iterative Tarjan)."""
    index, low, on, stack, best, counter = {}, {}, set(), [], set(), 0
    for root in succ:
        if root in index:
            continue
        index[root] = low[root] = counter; counter += 1
        stack.append(root); on.add(root)
        work = [(root, iter(succ[root]))]
        while work:
            v, it = work[-1]
            for w in it:
                if w not in index:
                    index[w] = low[w] = counter; counter += 1
                    stack.append(w); on.add(w)
                    work.append((w, iter(succ[w])))
                    break
                if w in on:
                    low[v] = min(low[v], index[w])
            else:
                work.pop()
                if work:
                    low[work[-1][0]] = min(low[work[-1][0]], low[v])
                if low[v] == index[v]:
                    comp = set()
                    while True:
                        w = stack.pop(); on.discard(w); comp.add(w)
                        if w == v:
                            break
                    if len(comp) > len(best):
                        best = comp
    return best


def strong_core(net_path: str) -> set:
    """Edges in the largest strongly connected part of a SUMO network file.

    A stop snapped to a one-way stub at the map's edge can be reached but not left
    (or the reverse), which makes every route through it impossible; keeping only
    this core rules that out. Run by build.sh, reading the XML directly: the build
    stage has SUMO's programs but not the libraries its Python engine loads, and
    doing it there keeps a 31,000-edge graph out of the running agent's memory.
    """
    import xml.etree.ElementTree as ET

    succ = {}
    for _, el in ET.iterparse(net_path, events=("end",)):
        if el.tag == "edge" and el.get("function") != "internal":
            succ.setdefault(el.get("id"), set())
        elif el.tag == "connection":
            frm, to = el.get("from"), el.get("to")
            if frm and to and not frm.startswith(":") and not to.startswith(":"):
                succ.setdefault(frm, set()).add(to)
                succ.setdefault(to, set())
        el.clear()
    return _largest_scc(succ)


def render_background(net_path: str, png_path: str, area_path: str) -> None:
    """Draw every street in light grey, once, at build time; record the extent drawn.

    Drawing 26,000 streets per email would cost the running agent memory and time
    it does not have on the standard tier, so the maps and the replay paste this
    picture behind the routes instead.
    """
    import xml.etree.ElementTree as ET
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.collections import LineCollection

    lines, xs, ys = [], [], []
    for _, el in ET.iterparse(net_path, events=("end",)):
        if el.tag == "edge" and el.get("function") != "internal":
            lane = el.find("lane")
            if lane is not None and lane.get("shape"):
                pts = [tuple(map(float, p.split(","))) for p in lane.get("shape").split()]
                lines.append(pts)
                xs += [p[0] for p in pts]
                ys += [p[1] for p in pts]
            el.clear()
    extent = [min(xs), max(xs), min(ys), max(ys)]
    fig = plt.figure(figsize=(6.4, 6.4 * (extent[3] - extent[2]) / (extent[1] - extent[0])), dpi=250)
    ax = fig.add_axes([0, 0, 1, 1])
    ax.add_collection(LineCollection(lines, colors="#c4c4cc", linewidths=0.35))
    ax.set_xlim(extent[0], extent[1])
    ax.set_ylim(extent[2], extent[3])
    ax.axis("off")
    fig.savefig(png_path, dpi=250)
    plt.close(fig)
    with open(area_path, encoding="utf-8") as fh:
        a = json.load(fh)
    a["xy_extent"] = extent
    with open(area_path, "w", encoding="utf-8") as fh:
        json.dump(a, fh)


class Roads:
    """One SUMO session on a network: snapping, driving times, then simulations.

    libsumo runs one simulation per process, so this is used once per email and
    closed. Driving times are read at time zero, before any van exists, so they are
    free-flow times on the real roads (speed limits, one-way streets, turns).
    """

    def __init__(self, net_path: str):
        import libsumo
        self.ts = libsumo
        libsumo.start(["sumo", "-n", net_path, "--no-step-log", "--no-warnings",
                       "--ignore-route-errors", "--time-to-teleport", "600",
                       "--collision.action", "none"])
        # build.sh already cut the network down to its strongly connected core
        # (see strong_core above), so every road left can be reached and left.
        self._core = {e for e in libsumo.edge.getIDList() if not e.startswith(":")}
        libsumo.vehicletype.copy("DEFAULT_VEHTYPE", "van")
        libsumo.vehicletype.setEmissionClass("van", VAN_EMISSION_CLASS)
        self._made = 0

    def close(self):
        try:
            self.ts.close()
        except Exception:
            pass

    def xy(self, lat: float, lon: float):
        return self.ts.simulation.convertGeo(lon, lat, True)

    def snap(self, lat: float, lon: float):
        """(edge, position on it, metres from the point to the road)."""
        ts = self.ts
        x, y = ts.simulation.convertGeo(lon, lat, True)
        try:
            edge, pos, lane = ts.simulation.convertRoad(lon, lat, True, "passenger")
            if edge in self._core:
                return edge, pos, self._gap(x, y, edge, pos, lane)
        except Exception:
            pass
        # Nearest road that is part of the connected core.
        best = None
        for e in self._core:
            shape = ts.lane.getShape(f"{e}_0")
            along = 0.0
            for (ax, ay), (bx, by) in zip(shape, shape[1:]):
                dx, dy = bx - ax, by - ay
                seg = math.hypot(dx, dy) or 1e-9
                t = max(0.0, min(1.0, ((x - ax) * dx + (y - ay) * dy) / (seg * seg)))
                d = math.hypot(x - (ax + t * dx), y - (ay + t * dy))
                if best is None or d < best[0]:
                    best = (d, e, along + t * seg)
                along += seg
        if best is None:
            raise RoadsUnavailable("no drivable roads were found near the stops")
        d, e, pos = best
        return e, min(pos, ts.lane.getLength(f"{e}_0")), d

    def street(self, edge: str) -> str:
        """The street name of an edge, or "" when the map has none."""
        try:
            return self.ts.edge.getStreetName(edge) or ""
        except Exception:
            return ""

    def _gap(self, x, y, edge, pos, lane):
        lx, ly = self.ts.simulation.convert2D(edge, pos, lane, False)
        return math.hypot(x - lx, y - ly)

    def route(self, a: str, b: str):
        """(seconds, metres, edges) driving from edge a to edge b at the current road speeds."""
        if a == b:
            return 0.0, 0.0, [a]
        r = self.ts.simulation.findRoute(a, b, vType="DEFAULT_VEHTYPE")
        if not r.edges:
            return None
        return r.travelTime, r.length, list(r.edges)

    def matrices(self, edges):
        """Driving seconds and metres between every pair of snapped edges."""
        n = len(edges)
        secs = [[0.0] * n for _ in range(n)]
        metres = [[0.0] * n for _ in range(n)]
        missing = []
        for i in range(n):
            for j in range(n):
                if i == j:
                    continue
                r = self.route(edges[i], edges[j])
                if r is None:
                    missing.append((i, j))
                    secs[i][j] = metres[i][j] = 1e7
                else:
                    secs[i][j], metres[i][j] = r[0], r[1]
        return secs, metres, missing

    def shape_xy(self, edges):
        """The road geometry of a list of edges, in network x/y metres."""
        pts = []
        for e in edges:
            pts += list(self.ts.lane.getShape(f"{e}_0"))
        return pts

    # ── rush hour ───────────────────────────────────────────────────────────────
    def apply_peak(self, main_pct: float, minor_pct: float) -> None:
        """Slow every road to a share of its speed limit, for a peak-hour run.

        An assumption, stated in the reply, rather than simulated traffic: on
        2026-10-16 random background trips were tried on central Indianapolis
        (3,600 lane-km). 4,400 of them barely changed anything; 34,000 took 9.5
        minutes on one CPU and jammed into gridlock that is not what rush hour
        looks like. Neither is measured traffic either way. A stated speed share
        is fast, gives the same answer twice, and the buyer can put their own
        figure in. Main roads are told apart by their limit (50 km/h and up).
        """
        ts = self.ts
        for e in self._core:
            limit = ts.lane.getMaxSpeed(f"{e}_0")
            share = main_pct if limit >= 13.8 else minor_pct
            ts.edge.setMaxSpeed(e, max(1.0, limit * share / 100.0))

    # ── the simulation ──────────────────────────────────────────────────────────
    def simulate(self, vans, stop_seconds: float, label: str = "plan", horizon_s: float = 14 * 3600.0, log=print):
        """Drive vans through SUMO and record what happens to each.

        `vans` is a list of {"van": n, "stops": [(edge, pos, opens_s or None), ...]}
        with the depot first and last. opens_s is when that stop starts receiving,
        in seconds after departure: a van that arrives earlier waits there, as a
        real one would. The vans drive the real network (speed limits or the peak
        share set by apply_peak, turns, junctions, traffic lights) with no other
        traffic, using SUMO's fuel and emission model for a diesel delivery van.

        Called once per plan in the same session; each call departs when the
        previous plan has finished, so plans never share the road.

        Returns {van: {"arrivals": [s after departure per stop], "back": s or None,
        "teleported": bool, "expected": stops, "waited_s": s stood on the road (lights,
        junctions; not stops), "km": driven, "fuel_l": litres, "co2_kg": kg,
        "trace": [(s, x, y), ...], "edges": route}}.
        """
        ts = self.ts
        t0 = ts.simulation.getTime() + 1.0
        plan = {}
        for v in vans:
            stops = v["stops"]
            edges = [stops[0][0]]
            for (a, *_), (b, *_) in zip(stops, stops[1:]):
                r = self.route(a, b)
                if r is None:
                    raise RoadsUnavailable("a planned leg has no road route")
                edges += r[2][1:] if r[2][0] == edges[-1] else r[2]
            self._made += 1
            vid = f"{label}{v['van']}_{self._made}"
            ts.route.add(f"r_{vid}", edges)
            ts.vehicle.add(vid, f"r_{vid}", typeID="van", depart=f"{t0:.1f}",
                           departPos=str(max(0.0, stops[0][1])), arrivalPos=str(max(0.0, stops[-1][1])))
            for edge, pos, opens in stops[1:-1]:
                length = ts.lane.getLength(f"{edge}_0")
                until = t0 + opens + stop_seconds if opens is not None and opens > 0 else -1073741824.0
                ts.vehicle.setStop(vid, edge, pos=min(max(pos, 1.0), length - 0.1), laneIndex=0,
                                   duration=stop_seconds, until=until)
            plan[vid] = {"van": v["van"], "arrivals": [], "back": None, "teleported": False,
                         "expected": len(stops) - 2, "edges": edges, "waited_s": 0.0, "km": 0.0,
                         "fuel_l": 0.0, "co2_kg": 0.0, "trace": [], "_next_trace": 0.0}
            log(f"sim [{label}]: van {v['van']} loaded with a {len(edges)}-road route and {len(stops) - 2} stops")

        dt = ts.simulation.getDeltaT()
        while ts.simulation.getTime() < t0 + horizon_s:
            ts.simulationStep()
            now = ts.simulation.getTime()
            rel = now - t0
            on_road = set(ts.vehicle.getIDList())
            for vid, p in plan.items():
                if vid not in on_road:
                    continue
                p["km"] = ts.vehicle.getDistance(vid) / 1000
                p["fuel_l"] += ts.vehicle.getFuelConsumption(vid) * dt / 1e6 / DIESEL_KG_PER_L
                p["co2_kg"] += ts.vehicle.getCO2Emission(vid) * dt / 1e6
                stopped = ts.vehicle.isStopped(vid)
                if ts.vehicle.getSpeed(vid) < 0.1 and not stopped:
                    p["waited_s"] += dt
                if rel >= p["_next_trace"]:
                    x, y = ts.vehicle.getPosition(vid)
                    p["trace"].append((rel, x, y))
                    p["_next_trace"] = rel + TRACE_EVERY_S
            for vid in ts.simulation.getStopStartingVehiclesIDList():
                if vid in plan:
                    p = plan[vid]
                    p["arrivals"].append(rel)
                    log(f"sim [{label}] t={rel / 60:6.1f} min: van {p['van']} reached stop {len(p['arrivals'])}/"
                        f"{p['expected']} after {p['km']:.1f} km")
            for vid in ts.simulation.getStartingTeleportIDList():
                if vid in plan:
                    plan[vid]["teleported"] = True
                    log(f"sim [{label}] t={rel / 60:6.1f} min: van {plan[vid]['van']} stuck and teleported by SUMO")
            for vid in ts.simulation.getArrivedIDList():
                if vid in plan:
                    p = plan[vid]
                    p["back"] = rel
                    log(f"sim [{label}] t={rel / 60:6.1f} min: van {p['van']} back at the depot, {p['km']:.1f} km, "
                        f"{p['fuel_l']:.2f} L diesel, {p['waited_s'] / 60:.1f} min at lights and junctions")
            if all(p["back"] is not None for p in plan.values()):
                break
        for p in plan.values():
            p.pop("_next_trace", None)
        return {p["van"]: p for p in plan.values()}


if __name__ == "__main__":
    import sys
    if len(sys.argv) == 4 and sys.argv[1] == "core":
        # build.sh: python roads.py core <network> <edge list out>
        core = strong_core(sys.argv[2])
        with open(sys.argv[3], "w", encoding="utf-8") as fh:
            fh.writelines(e + "\n" for e in sorted(core))
        print(f"strong core: {len(core)} edges")
    elif len(sys.argv) == 5 and sys.argv[1] == "background":
        # build.sh: python roads.py background <network> <png out> <map_area.json>
        render_background(sys.argv[2], sys.argv[3], sys.argv[4])
        print(f"background drawn to {sys.argv[3]}")
