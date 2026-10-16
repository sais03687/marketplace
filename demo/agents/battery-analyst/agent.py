"""Battery Analyst — simulates battery discharges described in an email, with PyBaMM.

Ask in plain words: "Simulate a 1C discharge of an LG M50 cell at 25 °C" or
"Compare 0.5C and 2C for an LFP cell at 0 °C and 25 °C". It replies with the
capacity, energy, duration and voltages of each case, a voltage chart and a CSV.
"""
import asyncio
import io

from llm_extract import extract

# PyBaMM parameter sets a buyer is likely to mean, in words they would use.
CELLS = {
    "Chen2020": "LG M50 21700, NMC811/graphite, 5 Ah",
    "Prada2013": "A123 LFP/graphite, 2.3 Ah",
    "Marquis2019": "Kokam LCO/graphite pouch, 0.68 Ah",
    "NCA_Kim2011": "NCA/graphite, 0.43 Ah",
}
MODELS = {"SPM", "SPMe", "DFN"}
MAX_CASES = 8

SCHEMA = {
    "type": "object",
    "properties": {
        "cell": {"type": "string", "enum": list(CELLS)},
        "model": {"type": "string", "enum": sorted(MODELS)},
        "c_rates": {"type": "array", "items": {"type": "number"}},
        "temperatures_c": {"type": "array", "items": {"type": "number"}},
        "unclear": {"type": "string"},
    },
    "required": ["cell", "model", "c_rates", "temperatures_c", "unclear"],
}

INSTRUCTIONS = (
    "You read a request to simulate a battery discharge. Choose the parameter set that best matches "
    "the cell described: " + "; ".join(f"{k} = {v}" for k, v in CELLS.items()) + ". "
    "If no cell is named, use Chen2020. Choose the model: DFN when the request asks for accuracy or "
    "detail, SPM only when it asks for a quick rough answer, otherwise SPMe. List every discharge C-rate "
    "asked for (1C -> 1, C/2 -> 0.5). A fast or heavy drain without a number means 2C; a slow or light one "
    "means 0.2C; with no hint use 1C. List every ambient temperature in degrees Celsius (25 if none given). "
    "In 'unclear', tell the sender in one or two plain sentences, for a non-expert, what you assumed "
    "(for example which cell you used because they did not name one), or leave it empty."
)


def _simulate(cell: str, model_name: str, c_rate: float, temp_c: float) -> dict:
    import pybamm

    params = pybamm.ParameterValues(cell)
    kelvin = temp_c + 273.15
    params["Ambient temperature [K]"] = kelvin
    params["Initial temperature [K]"] = kelvin
    cutoff = params["Lower voltage cut-off [V]"]
    model = {"SPM": pybamm.lithium_ion.SPM, "SPMe": pybamm.lithium_ion.SPMe,
             "DFN": pybamm.lithium_ion.DFN}[model_name]()
    experiment = pybamm.Experiment([f"Discharge at {c_rate:g}C until {cutoff} V"])
    sol = pybamm.Simulation(model, parameter_values=params, experiment=experiment).solve()
    t = sol["Time [s]"].entries
    v = sol["Voltage [V]"].entries
    q = sol["Discharge capacity [A.h]"].entries
    i = sol["Current [A]"].entries
    energy_wh = float(sum((v[k] * i[k] + v[k + 1] * i[k + 1]) / 2 * (t[k + 1] - t[k]) for k in range(len(t) - 1)) / 3600)
    return {
        "c_rate": c_rate, "temp_c": temp_c,
        "capacity_ah": float(q[-1]), "energy_wh": energy_wh,
        "duration_min": float(t[-1] / 60), "v_start": float(v[0]), "v_end": float(v[-1]),
        "v_avg": energy_wh / float(q[-1]) if q[-1] else 0.0,
        "nominal_ah": float(params["Nominal cell capacity [A.h]"]),
        "curve": (q, v),
    }


def _chart(cases: list[dict], title: str) -> bytes:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig, ax = plt.subplots(figsize=(7, 4.2), dpi=120)
    for c in cases:
        q, v = c["curve"]
        ax.plot(q, v, label=f"{c['c_rate']:g}C, {c['temp_c']:g} °C")
    ax.set_xlabel("Discharge capacity (Ah)")
    ax.set_ylabel("Voltage (V)")
    ax.set_title(title)
    ax.grid(alpha=0.3)
    ax.legend()
    buf = io.BytesIO()
    fig.tight_layout()
    fig.savefig(buf, format="png")
    plt.close(fig)
    return buf.getvalue()


async def run_agent(content: str, context: dict, attach_fn=None, progress_fn=None) -> dict:
    req = await extract(INSTRUCTIONS, content, SCHEMA, SCHEMA["required"])
    if not req or req.get("cell") not in CELLS or req.get("model") not in MODELS:
        return {"action": "reply_email", "text": "I could not work out which simulation you want. Tell me the cell "
                "(e.g. LG M50, or an LFP cell), the discharge rate (e.g. 1C) and the temperature."}
    rates = [float(r) for r in req.get("c_rates") or [1] if 0 < float(r) <= 10][:4] or [1.0]
    temps = [float(t) for t in req.get("temperatures_c") or [25] if -30 <= float(t) <= 60][:3] or [25.0]
    combos = [(r, t) for t in temps for r in rates][:MAX_CASES]

    if len(combos) > 2 and progress_fn:
        await progress_fn(f"Running {len(combos)} {req['model']} simulations of the {CELLS[req['cell']]} cell — "
                          "I'll reply with the results shortly.")

    cases, failed = [], []
    for rate, temp in combos:
        try:
            cases.append(await asyncio.to_thread(_simulate, req["cell"], req["model"], rate, temp))
        except Exception as exc:  # a case the solver cannot complete, e.g. a very high rate in the cold
            failed.append(f"{rate:g}C at {temp:g} °C ({type(exc).__name__})")

    if not cases:
        return {"action": "reply_email", "text": "None of the requested simulations could be completed: "
                + "; ".join(failed) + ". Try a lower C-rate or a milder temperature."}

    lines = [f"Cell: {CELLS[req['cell']]} (PyBaMM set {req['cell']}), model {req['model']}, "
             f"discharged to the cell's {cases[0]['v_end']:.2f} V cut-off.", "",
             "Rate | Temp | Capacity | % of nominal | Energy | Duration | Avg V | Start V"]
    for c in cases:
        lines.append(f"{c['c_rate']:g}C | {c['temp_c']:g} °C | {c['capacity_ah']:.3f} Ah | "
                     f"{100 * c['capacity_ah'] / c['nominal_ah']:.1f}% | {c['energy_wh']:.2f} Wh | "
                     f"{c['duration_min']:.1f} min | {c['v_avg']:.3f} V | {c['v_start']:.3f} V")
    if failed:
        lines += ["", "Not completed: " + "; ".join(failed)]
    if len({c["temp_c"] for c in cases}) > 1 or any(c["temp_c"] < 15 for c in cases):
        lines += ["", "About temperature: PyBaMM's published cell parameters capture only part of how cold "
                  "slows a real cell, so these runs understate cold-weather loss. Real cells typically lose "
                  "noticeably more capacity near 0 °C, especially at high rates. Treat the cold results as a "
                  "best case, and size for cold weather from the manufacturer's low-temperature data."]
    if req.get("unclear"):
        lines += ["", f"Assumed: {req['unclear']}"]

    deliverables = []
    if attach_fn:
        csv = "c_rate,temp_c,capacity_ah,energy_wh,duration_min,avg_voltage,start_voltage,end_voltage\n" + "".join(
            f"{c['c_rate']},{c['temp_c']},{c['capacity_ah']:.4f},{c['energy_wh']:.4f},{c['duration_min']:.2f},"
            f"{c['v_avg']:.4f},{c['v_start']:.4f},{c['v_end']:.4f}\n" for c in cases)
        if attach_fn("discharge_results.csv", csv):
            deliverables.append("discharge_results.csv")
        if attach_fn("discharge_curves.png", _chart(cases, f"{CELLS[req['cell']]} — {req['model']}")):
            deliverables.append("discharge_curves.png")
        if deliverables:
            lines += ["", "Attached: the voltage curves and a CSV of the table."]

    return {"action": "reply_email", "text": "\n".join(lines), "deliverables": deliverables}


async def resume_agent(thread_id: str, resolution: dict, **tools) -> dict:
    return {"action": "none"}
