"""The SUMO simulation itself, packed as a zip for the person who asked.

So a tester does not have to take the agent's word for it: the zip holds the same
road network, the same van routes and stops, and a script that re-runs them with
SUMO on their own machine — with the road speeds and stop times as settings they
can change — plus config files that open the run in SUMO's own viewer (sumo-gui).

Run with the defaults it reproduces the numbers in the email. Changing a setting
re-simulates the same routes; re-planning (new stop order, more vans) is done by
replying to the email, because that needs the solver as well as SUMO.

The network ships pre-compressed (build.sh writes roads.net.xml.gz; SUMO reads .gz
directly), about 4.4 MB for central Indianapolis.
"""
import io
import json
import os
import zipfile

import roads

NET_GZ = os.path.join(roads.HERE, "roads.net.xml.gz")

RUN_SCRIPT = r'''"""Re-run the Route Planner's SUMO simulation yourself, with your own settings.

    pip install eclipse-sumo traci
    python run_scenario.py              # the plan, numbers as in the email
    python run_scenario.py today        # how the vans run today (if you sent it)
    python run_scenario.py plan --gui   # watch it in SUMO's viewer (press play)

Change the settings below and run again: the vans drive the same routes and stops,
and the times, fuel and CO2 change with them. SUMO is doing all of it.
"""
import json
import os
import sys

# ── Settings you can change ─────────────────────────────────────────────────────
MAIN_ROADS_PCT = None     # % of the speed limit on main roads (50 km/h+); None = as in the email
SIDE_STREETS_PCT = None   # % on side streets; None = as in the email
STOP_MINUTES = None       # unloading time at each stop; None = as in the email
# ────────────────────────────────────────────────────────────────────────────────

HERE = os.path.dirname(os.path.abspath(__file__))


def main():
    which = next((a for a in sys.argv[1:] if not a.startswith("-")), "plan")
    gui = "--gui" in sys.argv
    with open(os.path.join(HERE, "scenario.json"), encoding="utf-8") as fh:
        sc = json.load(fh)
    if which not in sc["plans"]:
        sys.exit(f"no '{which}' plan in this scenario; there is: {', '.join(sc['plans'])}")
    main_pct = MAIN_ROADS_PCT if MAIN_ROADS_PCT is not None else sc["main_roads_pct"]
    side_pct = SIDE_STREETS_PCT if SIDE_STREETS_PCT is not None else sc["side_streets_pct"]
    stop_s = (STOP_MINUTES if STOP_MINUTES is not None else sc["stop_minutes"]) * 60

    import traci
    try:
        import sumo
        binary = os.path.join(sumo.SUMO_HOME, "bin", "sumo-gui" if gui else "sumo")
    except ImportError:
        binary = "sumo-gui" if gui else "sumo"
    traci.start([binary, "-n", os.path.join(HERE, "roads.net.xml.gz"), "--no-step-log", "--no-warnings",
                 "--ignore-route-errors", "--time-to-teleport", "600", "--collision.action", "none"]
                + (["--start", "--delay", "40"] if gui else []))

    # The same road speeds the agent used: every road at a share of its limit,
    # main roads (limit 50 km/h and up) told apart from side streets.
    for e in traci.edge.getIDList():
        if e.startswith(":"):
            continue
        limit = traci.lane.getMaxSpeed(f"{e}_0")
        share = main_pct if limit >= 13.8 else side_pct
        traci.edge.setMaxSpeed(e, max(1.0, limit * share / 100.0))

    traci.vehicletype.copy("DEFAULT_VEHTYPE", "van")
    traci.vehicletype.setEmissionClass("van", sc["emission_class"])
    traci.vehicletype.setSpeedDeviation("van", 0.0)   # as the agent: no random speed or driving
    traci.vehicletype.setImperfection("van", 0.0)
    vans = {}
    for v in sc["plans"][which]:
        vid = f"van{v['van']}"
        traci.route.add(f"r_{vid}", v["edges"])
        stops = v["stops"]
        depart = v.get("depart_s", 1.0)
        traci.vehicle.add(vid, f"r_{vid}", typeID="van", depart=str(depart),
                          departPos=str(stops[0]["pos"]), arrivalPos=str(stops[-1]["pos"]))
        for s in stops[1:-1]:
            until = depart + s["opens_s"] + stop_s if s.get("opens_s") else -1073741824.0
            traci.vehicle.setStop(vid, s["edge"], pos=s["pos"], laneIndex=0, duration=stop_s, until=until)
        vans[vid] = {"name": v["van"], "stops": [s["name"] for s in stops[1:-1]], "arrivals": [], "back": None,
                     "fuel_l": 0.0, "co2_kg": 0.0, "km": 0.0, "depart": depart}
    if gui:
        traci.gui.setSchema("View #0", "real world")

    while traci.simulation.getMinExpectedNumber() > 0:
        traci.simulationStep()
        now = traci.simulation.getTime()
        for vid in traci.vehicle.getIDList():
            if vid in vans:
                p = vans[vid]
                p["km"] = traci.vehicle.getDistance(vid) / 1000
                p["fuel_l"] += traci.vehicle.getFuelConsumption(vid) / 1e6 / 0.832
                p["co2_kg"] += traci.vehicle.getCO2Emission(vid) / 1e6
        for vid in traci.simulation.getStopStartingVehiclesIDList():
            if vid in vans:
                vans[vid]["arrivals"].append(now - vans[vid]["depart"])
        for vid in traci.simulation.getArrivedIDList():
            if vid in vans:
                vans[vid]["back"] = now - vans[vid]["depart"]
    traci.close()

    start = sc["departure_minutes"]

    def clock(s):
        if start is None:
            return f"+{s / 60:.0f} min"
        m = (start + s / 60) % 1440
        return f"{int(m // 60):02d}:{int(m % 60):02d}"

    print(f"{which}: main roads {main_pct:g}%, side streets {side_pct:g}%, {stop_s / 60:g} min per stop")
    for p in vans.values():
        legs = " -> ".join(f"{n} ({clock(t)})" for n, t in zip(p["stops"], p["arrivals"]))
        back = clock(p["back"]) if p["back"] is not None else "not back"
        print(f"  van {p['name']}: {p['km']:.1f} km, back {back}, {p['fuel_l']:.2f} L diesel, "
              f"{p['co2_kg']:.1f} kg CO2\n    {legs}")


if __name__ == "__main__":
    main()
'''

README = """Route Planner — the SUMO simulation behind your email

This is the simulation the agent ran, so you can check it and change it yourself.

  roads.net.xml.gz   the road network (OpenStreetMap, central Indianapolis), as SUMO reads it
  scenario.json      each van's route (road by road), its stops, opening hours and settings
  plan.rou.xml       the plan's vans as a SUMO route file      (today.rou.xml: your current routes)
  plan.sumocfg       open this in SUMO's viewer to watch the plan (today.sumocfg likewise)
  run_scenario.py    re-run it with your own settings and print the times, fuel and CO2

Watch it:   install SUMO (https://eclipse.dev/sumo/ or `pip install eclipse-sumo`), open
            plan.sumocfg in sumo-gui and press play. Road speeds there are the speed limits;
            run_scenario.py --gui applies the email's road speeds as well.
Change it:  pip install eclipse-sumo traci, edit the settings at the top of run_scenario.py
            (road speeds, minutes per stop) and run `python run_scenario.py`. With no changes
            it reproduces the email's numbers.
Re-plan:    for a different stop order, more vans or other stops, reply to the email.

Map data © OpenStreetMap contributors (ODbL). Simulation: Eclipse SUMO.
"""


def _routes_xml(vans) -> str:
    out = ['<routes>', f'  <vType id="van" emissionClass="{roads.VAN_EMISSION_CLASS}" speedDev="0" sigma="0"/>']
    for v in vans:
        stops = v["stops"]
        out.append(f'  <vehicle id="van{v["van"]}" type="van" depart="{v.get("depart_s", 0):.0f}" departPos="{stops[0]["pos"]:.1f}" '
                   f'arrivalPos="{stops[-1]["pos"]:.1f}">')
        out.append(f'    <route edges="{" ".join(v["edges"])}"/>')
        for s in stops[1:-1]:
            until = f' until="{v.get("depart_s", 0) + s["opens_s"] + s["duration"]:.0f}"' if s.get("opens_s") else ""
            out.append(f'    <stop lane="{s["edge"]}_0" endPos="{s["pos"]:.1f}" duration="{s["duration"]:.0f}"{until}/>')
        out.append('  </vehicle>')
    out.append('</routes>')
    return "\n".join(out) + "\n"


def _config_xml(routes_file: str) -> str:
    return ("<configuration>\n  <input>\n    <net-file value=\"roads.net.xml.gz\"/>\n"
            f"    <route-files value=\"{routes_file}\"/>\n  </input>\n"
            "  <processing>\n    <time-to-teleport value=\"600\"/>\n  </processing>\n</configuration>\n")


def scenario_zip(plans: dict, settings: dict) -> bytes | None:
    """The zip, or None if this installation has no packed network.

    `plans` is {"plan": [van...], "today": [van...]} where each van is
    {"van", "edges", "stops": [{"name", "edge", "pos", "opens_s", "duration"}]}.
    """
    if not os.path.exists(NET_GZ):
        return None
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.write(NET_GZ, "roads.net.xml.gz", compress_type=zipfile.ZIP_STORED)
        z.writestr("scenario.json", json.dumps({**settings, "plans": plans}, indent=1))
        z.writestr("run_scenario.py", RUN_SCRIPT)
        z.writestr("README.txt", README)
        for name, vans in plans.items():
            z.writestr(f"{name}.rou.xml", _routes_xml(vans))
            z.writestr(f"{name}.sumocfg", _config_xml(f"{name}.rou.xml"))
    return buf.getvalue()
