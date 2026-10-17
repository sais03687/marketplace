"""Real roads for Route Planner: an OpenStreetMap road network, driving times between
stops, and a SUMO simulation of the planned vans driving it, with traffic lights,
turns and speed limits.

Kept apart from agent.py so the email handling stays readable. Nothing here talks to
the model; everything is computed.

Sizes are chosen for the platform's standard tier (512 MB): the network is built
without junction-internal lanes or turnarounds, which routing does not need and which
roughly triple its size. Measured on central Indianapolis (15 x 14 km): 11 MB of map
data, 6 s to convert, 30 MB network, 320 MB peak while loaded.
"""
import hashlib
import math
import os
import subprocess
import time

import requests

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
ROAD_TYPES = ("motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|"
              "motorway_link|trunk_link|primary_link|secondary_link|tertiary_link")
MARGIN_KM = 2.0          # map beyond the outermost stops, so routes can leave the box a little
MAX_SIDE_KM = 35.0       # larger areas do not fit the standard tier; the caller falls back
SNAP_WARN_M = 250.0      # a stop further than this from any road is probably a wrong coordinate
CACHE = os.environ.get("ROUTE_PLANNER_CACHE", "/tmp/route-planner")
USER_AGENT = "AgentStore-RoutePlanner/1.1 (route planning agent; contact via agentstore.it.com)"


class RoadsUnavailable(Exception):
    """The road map could not be had; the message says why, in words for the buyer."""


def _box(points, margin_km=MARGIN_KM):
    lats = [p["lat"] for p in points]
    lons = [p["lon"] for p in points]
    mid = math.radians(sum(lats) / len(lats))
    dlat = margin_km / 111.0
    dlon = margin_km / (111.0 * max(0.2, math.cos(mid)))
    return min(lats) - dlat, min(lons) - dlon, max(lats) + dlat, max(lons) + dlon


def _side_km(box):
    s, w, n, e = box
    mid = math.radians((s + n) / 2)
    return max((n - s) * 111.0, (e - w) * 111.0 * math.cos(mid))


def build_network(points, timeout_s=150) -> str:
    """Path to a SUMO network covering `points`; downloads and converts it on first use."""
    box = _box(points)
    side = _side_km(box)
    if side > MAX_SIDE_KM:
        raise RoadsUnavailable(f"the stops span about {side:.0f} km, more than the {MAX_SIDE_KM:.0f} km "
                               f"area I can load road maps for")
    os.makedirs(CACHE, exist_ok=True)
    # Rounded so the same delivery area reuses its network across emails.
    key = hashlib.sha1(",".join(f"{v:.2f}" for v in box).encode()).hexdigest()[:12]
    net = os.path.join(CACHE, f"{key}.net.xml")
    if os.path.exists(net):
        return net
    s, w, n, e = box
    query = (f'[out:xml][timeout:{timeout_s}];way["highway"~"^({ROAD_TYPES})$"]({s:.5f},{w:.5f},{n:.5f},{e:.5f});'
             f"(._;>;);out body;")
    osm = os.path.join(CACHE, f"{key}.osm.xml")
    # The public map service is shared and answers 429/502/504 when busy; measured
    # 2026-10-16 it recovered within a minute. Its mirrors were all failing that day,
    # so retrying the one service beats spreading over several.
    problem = "the map service could not be reached"
    for wait in (0, 15, 45):
        time.sleep(wait)
        try:
            with requests.post(OVERPASS_URL, data={"data": query}, headers={"User-Agent": USER_AGENT},
                               timeout=timeout_s + 30, stream=True) as resp:
                if resp.status_code != 200:
                    problem = f"the map service was busy (it answered {resp.status_code})"
                    continue
                with open(osm, "wb") as fh:
                    for chunk in resp.iter_content(1 << 16):
                        fh.write(chunk)
                break
        except requests.RequestException as exc:
            problem = f"the map service could not be reached ({type(exc).__name__})"
    else:
        raise RoadsUnavailable(problem)
    if os.path.getsize(osm) < 2000:
        os.remove(osm)
        raise RoadsUnavailable("the map service returned no roads for this area")
    import sumo
    netconvert = os.path.join(sumo.SUMO_HOME, "bin", "netconvert")
    proc = subprocess.run(
        [netconvert, "--osm-files", osm, "-o", net + ".tmp",
         "--geometry.remove", "--ramps.guess", "--junctions.join",
         "--tls.guess-signals", "--tls.discard-simple", "--tls.join",
         "--keep-edges.by-vclass", "passenger", "--remove-edges.isolated",
         "--keep-edges.components", "1",
         "--no-internal-links", "--no-turnarounds", "--junctions.corner-detail", "0",
         "--no-warnings", "--output.street-names", "true"],
        capture_output=True, text=True, timeout=600)
    os.remove(osm)
    if proc.returncode != 0 or not os.path.exists(net + ".tmp"):
        raise RoadsUnavailable("the road map could not be converted for simulation")
    os.replace(net + ".tmp", net)
    return net


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
        self._core = self._strong_core()

    def close(self):
        try:
            self.ts.close()
        except Exception:
            pass

    # ── which roads a van can both reach and leave ──────────────────────────────
    def _strong_core(self) -> set:
        """Edges in the largest strongly connected part of the network.

        A stop snapped to a one-way stub at the map's edge can be reached but not
        left (or the reverse), which makes every route through it impossible.
        """
        ts = self.ts
        edges = [e for e in ts.edge.getIDList() if not e.startswith(":")]
        succ = {e: set() for e in edges}
        for e in edges:
            for i in range(ts.edge.getLaneNumber(e)):
                for link in ts.lane.getLinks(f"{e}_{i}"):
                    to = link[0].rsplit("_", 1)[0]
                    if to in succ:
                        succ[e].add(to)
        # Iterative Tarjan: the network has tens of thousands of edges.
        index, low, on, stack, comps, counter = {}, {}, set(), [], [], [0]
        for root in edges:
            if root in index:
                continue
            work = [(root, iter(succ[root]))]
            index[root] = low[root] = counter[0]; counter[0] += 1
            stack.append(root); on.add(root)
            while work:
                v, it = work[-1]
                advanced = False
                for w in it:
                    if w not in index:
                        index[w] = low[w] = counter[0]; counter[0] += 1
                        stack.append(w); on.add(w)
                        work.append((w, iter(succ[w])))
                        advanced = True
                        break
                    if w in on:
                        low[v] = min(low[v], index[w])
                if advanced:
                    continue
                work.pop()
                if work:
                    low[work[-1][0]] = min(low[work[-1][0]], low[v])
                if low[v] == index[v]:
                    comp = set()
                    while True:
                        w = stack.pop(); on.discard(w); comp.add(w)
                        if w == v:
                            break
                    comps.append(comp)
        return max(comps, key=len) if comps else set()

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
