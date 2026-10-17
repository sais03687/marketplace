"""Real roads for Route Planner: an OpenStreetMap road network, driving times between
stops, and a SUMO simulation of the planned vans driving it, with traffic lights,
turns and speed limits.

Kept apart from agent.py so the email handling stays readable. Nothing here talks to
the model; everything is computed.

The network is built once by build.sh for a fixed area (see there for sizes); this
module only reads it, so nothing here runs other programs or reaches the internet.
"""
import json
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))
NET = os.path.join(HERE, "roads.net.xml")       # built by build.sh
AREA = os.path.join(HERE, "map_area.json")
SNAP_WARN_M = 250.0      # a stop further than this from any road is probably a wrong coordinate


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


class Roads:
    """One SUMO session on a network: snapping, driving times, then a simulation.

    libsumo runs one simulation per process, so this is used once per email and
    closed. Driving times are read at time zero, before any traffic exists, so they
    are free-flow times on the real roads (speed limits, one-way streets, turns).
    """

    def __init__(self, net_path: str):
        import libsumo
        self.ts = libsumo
        libsumo.start(["sumo", "-n", net_path, "--no-step-log", "--no-warnings",
                       "--ignore-route-errors", "--time-to-teleport", "600",
                       "--collision.action", "none"])
        # build.sh already cut the network down to its strongly connected core
        # (see strong_core below), so every road left can be reached and left.
        self._core = {e for e in libsumo.edge.getIDList() if not e.startswith(":")}

    def close(self):
        try:
            self.ts.close()
        except Exception:
            pass

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

    def _gap(self, x, y, edge, pos, lane):
        lx, ly = self.ts.simulation.convert2D(edge, pos, lane, False)
        return math.hypot(x - lx, y - ly)

    def route(self, a: str, b: str):
        """(seconds, metres, edges) driving from edge a to edge b at free flow."""
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

    def geo(self, edges):
        """The road geometry of a list of edges, as (lons, lats)."""
        lons, lats = [], []
        for e in edges:
            for x, y in self.ts.lane.getShape(f"{e}_0"):
                lon, lat = self.ts.simulation.convertGeo(x, y, False)
                lons.append(lon); lats.append(lat)
        return lons, lats

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
    def simulate(self, vans, stop_seconds: float, horizon_s: float = 8 * 3600.0):
        """Drive each van's planned route through SUMO and record when it reaches each stop.

        `vans` is a list of {"van": n, "stops": [(edge, pos), ...]} with the depot first
        and last. The vans drive the real network: speed limits (or the peak share set
        by apply_peak), turns, junctions and traffic lights, but no other traffic.

        Returns {van: {"arrivals": [seconds after departure per stop], "back": seconds
        or None, "teleported": bool, "expected": stops}}.
        """
        ts = self.ts
        plan = {}
        for v in vans:
            stops = v["stops"]
            edges = [stops[0][0]]
            for (a, _), (b, _) in zip(stops, stops[1:]):
                r = self.route(a, b)
                if r is None:
                    raise RoadsUnavailable("a planned leg has no road route")
                edges += r[2][1:] if r[2][0] == edges[-1] else r[2]
            vid = f"van{v['van']}"
            ts.route.add(f"r_{vid}", edges)
            ts.vehicle.add(vid, f"r_{vid}", depart="0", departPos=str(max(0.0, stops[0][1])),
                           arrivalPos=str(max(0.0, stops[-1][1])))
            for edge, pos in stops[1:-1]:
                length = ts.lane.getLength(f"{edge}_0")
                ts.vehicle.setStop(vid, edge, pos=min(max(pos, 1.0), length - 0.1), laneIndex=0,
                                   duration=stop_seconds)
            plan[vid] = {"van": v["van"], "arrivals": [], "back": None, "teleported": False,
                         "expected": len(stops) - 2, "edges": edges}

        while ts.simulation.getTime() < horizon_s:
            ts.simulationStep()
            now = ts.simulation.getTime()
            for vid in ts.simulation.getStopStartingVehiclesIDList():
                if vid in plan:
                    plan[vid]["arrivals"].append(now)
            for vid in ts.simulation.getStartingTeleportIDList():
                if vid in plan:
                    plan[vid]["teleported"] = True
            for vid in ts.simulation.getArrivedIDList():
                if vid in plan:
                    plan[vid]["back"] = now
            if all(p["back"] is not None for p in plan.values()):
                break
        return {p["van"]: p for p in plan.values()}


if __name__ == "__main__":
    # build.sh: python roads.py core <network> <edge list out>
    import sys
    if len(sys.argv) == 4 and sys.argv[1] == "core":
        core = strong_core(sys.argv[2])
        with open(sys.argv[3], "w", encoding="utf-8") as fh:
            fh.writelines(e + "\n" for e in sorted(core))
        print(f"strong core: {len(core)} edges")
