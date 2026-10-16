"""Reaction Lab — compares experimental strategies in ChemGymRL's virtual reaction bench.

Ask, e.g., "For the Wurtz reaction, compare adding all reagents at once with
adding them gradually, run hot." Each strategy is run on the bench against one
target product; the reply ranks them by the bench's reward for that product,
reports the vessel temperature each run actually reached, and attaches a CSV
and a chart.
"""
import asyncio
import io
import statistics

from llm_extract import extract

ENVS = {"wurtz": "GenWurtzReact-v2", "fictional": "FictReact-v2"}
TARGETS = {
    "wurtz": ["dodecane", "5-methylundecane", "4-ethyldecane", "5,6-dimethyldecane",
              "4-ethyl-5-methylnonane", "4,5-diethyloctane", "NaCl"],
    "fictional": ["fict_E", "fict_F", "fict_G", "fict_H", "fict_I"],
}
STRATEGIES = {
    "all_at_once": "pour every reagent in fully at the first step",
    "gradual": "pour a quarter of each reagent per step over the first four steps",
    "staged": "pour the reagents one after another, one per step",
    "random": "random actions (a baseline)",
}
TEMPS = {"low": 0.0, "medium": 0.5, "high": 1.0}   # position in the bench's heating range

SCHEMA = {
    "type": "object",
    "properties": {
        "reaction": {"type": "string", "enum": list(ENVS)},
        "target": {"type": "string"},
        "strategies": {"type": "array", "items": {"type": "string", "enum": list(STRATEGIES)}},
        "temperatures": {"type": "array", "items": {"type": "string", "enum": list(TEMPS)}},
        "runs": {"type": "integer"},
        "unclear": {"type": "string"},
    },
    "required": ["reaction", "target", "strategies", "temperatures", "runs", "unclear"],
}

INSTRUCTIONS = (
    "You read a request to run virtual chemistry experiments. 'reaction' is 'wurtz' for the Wurtz "
    "reaction (alkyl chlorides to alkanes) or 'fictional' for the fictional training reaction. 'target' is "
    "the product to make, copied from: wurtz = " + ", ".join(TARGETS["wurtz"]) + "; fictional = "
    + ", ".join(TARGETS["fictional"]) + " (product E = fict_E), or empty if none is named. 'strategies' uses "
    "exactly these names: " + "; ".join(f"{k} = {v}" for k, v in STRATEGIES.items())
    + " ('one at a time' is staged, 'all together' is all_at_once). If none are named, use all_at_once, "
    "gradual and random. 'temperatures' from low, medium, high (medium if none given; 'hot' is high, 'cold' "
    "is low). 'runs' is how many repeats (10 if not given). Say in 'unclear' what you assumed, in plain words."
)

_KEYWORDS = (("stag", "staged"), ("one at a time", "staged"), ("one after", "staged"), ("grad", "gradual"),
             ("all", "all_at_once"), ("once", "all_at_once"), ("rand", "random"), ("baseline", "random"))


def _strategy(name: str) -> str | None:
    s = str(name).lower().strip()
    if s in STRATEGIES:
        return s
    return next((v for k, v in _KEYWORDS if k in s), None)


def _policy(name: str, step: int, temp: float, rng):
    a = [temp, 0.0, 0.0, 0.0, 0.0]
    if name == "all_at_once" and step == 0:
        a[1:] = [1.0] * 4
    elif name == "gradual" and step < 4:
        a[1:] = [0.25] * 4
    elif name == "staged" and step < 4:
        a[1 + step] = 1.0
    elif name == "random":
        a = [rng.random() for _ in range(5)]
    return a


def _run(env_id: str, target: str, strategy: str, temp_name: str, runs: int):
    import gymnasium as gym
    import numpy as np
    import chemistrylab  # noqa: F401  (registers the benches)

    env = gym.make(env_id)
    bench = env.unwrapped
    totals, final_temps = [], []
    for ep in range(runs):
        env.reset(seed=ep)
        bench._reset(target)   # the bench draws a random target on reset; every run must chase the same one
        rng = np.random.default_rng(ep)
        total, step, done = 0.0, 0, False
        while not done and step < 20:
            action = np.array(_policy(strategy, step, TEMPS[temp_name], rng), dtype=np.float32)
            _, reward, terminated, truncated, _ = env.step(action)
            total += float(reward)
            done = terminated or truncated
            step += 1
        totals.append(total)
        final_temps.append(float(bench.shelf[0].temperature))
    env.close()
    return totals, statistics.fmean(final_temps)


def _chart(results, target) -> bytes:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig, ax = plt.subplots(figsize=(7, 4), dpi=120)
    ax.bar([f"{r['strategy']}\n{r['temp']}" for r in results], [r["mean"] for r in results],
           yerr=[r["sd"] for r in results], capsize=4)
    ax.set_ylabel(f"Reward for {target}")
    ax.axhline(0, color="grey", lw=0.8)
    ax.grid(axis="y", alpha=0.3)
    buf = io.BytesIO()
    fig.tight_layout()
    fig.savefig(buf, format="png")
    plt.close(fig)
    return buf.getvalue()


async def run_agent(content: str, context: dict, attach_fn=None) -> dict:
    req = await extract(INSTRUCTIONS, content, SCHEMA, SCHEMA["required"])
    if not req or req.get("reaction") not in ENVS:
        return {"action": "reply_email", "text": "Tell me which reaction (Wurtz or the fictional training reaction) "
                "and which strategies to compare, and I'll run them."}
    reaction = req["reaction"]
    target = next((t for t in TARGETS[reaction] if t.lower() == str(req.get("target", "")).strip().lower()),
                  TARGETS[reaction][0])
    strategies = list(dict.fromkeys(s for s in map(_strategy, req.get("strategies") or []) if s)) \
        or ["all_at_once", "gradual", "random"]
    temps = [t for t in req.get("temperatures") or [] if t in TEMPS] or ["medium"]
    runs = max(3, min(int(req.get("runs") or 10), 30))

    results = []
    for s in strategies[:4]:
        for t in temps[:3]:
            totals, temp_k = await asyncio.to_thread(_run, ENVS[reaction], target, s, t, runs)
            results.append({"strategy": s, "temp": t, "kelvin": temp_k, "mean": statistics.fmean(totals),
                            "sd": statistics.pstdev(totals), "best": max(totals), "runs": totals})
    results.sort(key=lambda r: r["mean"], reverse=True)

    lines = [f"Bench {ENVS[reaction]}, target product {target}, {runs} runs per condition.", "",
             "Rank | Strategy | Heating | Vessel temp at end | Mean reward | Spread (SD) | Best run"]
    for i, r in enumerate(results, 1):
        lines.append(f"{i} | {r['strategy']} | {r['temp']} | {r['kelvin'] - 273.15:.0f} °C | {r['mean']:.4f} | "
                     f"{r['sd']:.4f} | {r['best']:.4f}")
    top = results[0]
    lines += ["", f"Best: {top['strategy']}" + (f" at {top['temp']} heating" if len(temps) > 1 else "") + "."]
    if len(results) > 1 and top["mean"] - results[1]["mean"] < max(top["sd"], results[1]["sd"]):
        lines.append(f"{top['strategy']} and {results[1]['strategy']} are within the run-to-run spread of each "
                     "other, so neither is clearly better.")

    if len(temps) > 1:
        for s in strategies[:4]:
            rows = [r for r in results if r["strategy"] == s]
            spread = max(r["mean"] for r in rows) - min(r["mean"] for r in rows)
            k = sorted(r["kelvin"] - 273.15 for r in rows)
            if spread < 0.001:
                lines.append(f"Temperature made no measurable difference for {s}: the vessel ran from {k[0]:.0f} to "
                             f"{k[-1]:.0f} °C and the outcome changed by {spread:.5f}.")
    fixed = [r["strategy"] for r in results if r["sd"] == 0 and r["strategy"] != "random"]
    if fixed:
        lines.append("The bench is deterministic, so " + ", ".join(dict.fromkeys(fixed))
                     + " gave the same result every run; only the random baseline varies.")
    if reaction == "wurtz" and target != "NaCl":
        lines.append("Note: these strategies pour every reagent, and a Wurtz coupling pairs whatever chlorides are "
                     "present, so they make all the alkanes together. Making mostly one product means adding only the "
                     "chloride(s) it is built from.")
    lines.append("Reward is the bench's measure of target product made (higher is better; below zero means less than "
                 "at the start). Strategies: " + "; ".join(f"{s} = {STRATEGIES[s]}" for s in strategies[:4]) + ".")
    if req.get("unclear"):
        lines += ["", f"Assumed: {req['unclear']}"]

    deliverables = []
    if attach_fn:
        csv = "strategy,heating,run,reward\n" + "".join(
            f"{r['strategy']},{r['temp']},{k + 1},{v:.6f}\n" for r in results for k, v in enumerate(r["runs"]))
        if attach_fn("experiment_runs.csv", csv):
            deliverables.append("experiment_runs.csv")
        if attach_fn("strategy_comparison.png", _chart(results, target)):
            deliverables.append("strategy_comparison.png")
    return {"action": "reply_email", "text": "\n".join(lines), "deliverables": deliverables}


async def resume_agent(thread_id: str, resolution: dict, **tools) -> dict:
    return {"action": "none"}
