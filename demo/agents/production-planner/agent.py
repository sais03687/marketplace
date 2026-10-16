"""Production Planner — finds the most profitable production mix, with Pyomo and the HiGHS solver.

Describe your products (profit per unit, any minimum or maximum quantities) and
your resources (hours, machines, materials — how much is available and how much
each product uses). It replies with the optimal quantities, the profit, which
resources are the bottleneck and what one more unit of each is worth, and
attaches the plan as a CSV.
"""
import asyncio

from llm_extract import extract

SCHEMA = {
    "type": "object",
    "properties": {
        "products": {"type": "array", "items": {"type": "object", "properties": {
            "name": {"type": "string"}, "profit": {"type": "number"},
            "min_qty": {"type": "number"}, "max_qty": {"type": "number"}}}},
        "resources": {"type": "array", "items": {"type": "object", "properties": {
            "name": {"type": "string"}, "available": {"type": "number"},
            "usage": {"type": "array", "items": {"type": "object", "properties": {
                "product": {"type": "string"}, "per_unit": {"type": "number"}}}}}}},
        "whole_units": {"type": "boolean"},
        "unclear": {"type": "string"},
    },
    "required": ["products", "resources", "whole_units", "unclear"],
}

INSTRUCTIONS = (
    "You read a production planning problem. List each product with its profit per unit, and min_qty / "
    "max_qty if stated (0 and -1 if not). A quantity that must be made — an order, a commitment, 'a customer "
    "wants N', 'can we make N', 'at least N' — is that product's min_qty; 'at most N', 'no more than N' or a "
    "market limit is its max_qty. List each limited resource with the amount available and, in "
    "'usage', how much of it one unit of each product uses (only products that use it). 'whole_units' is "
    "true unless fractional quantities clearly make sense (e.g. litres, kilograms). Copy numbers exactly; "
    "put anything ambiguous in 'unclear'."
)


def _solve(products, resources, whole):
    import pyomo.environ as pyo

    m = pyo.ConcreteModel()
    names = [p["name"] for p in products]
    m.x = pyo.Var(names, domain=pyo.NonNegativeIntegers if whole else pyo.NonNegativeReals)
    for p in products:
        if (p.get("min_qty") or 0) > 0:
            m.x[p["name"]].setlb(p["min_qty"])
        if (p.get("max_qty") if p.get("max_qty") is not None else -1) >= 0:
            m.x[p["name"]].setub(p["max_qty"])
    m.profit = pyo.Objective(expr=sum(p["profit"] * m.x[p["name"]] for p in products), sense=pyo.maximize)
    m.cap = pyo.ConstraintList()
    used_by = {}
    for r in resources:
        terms = {u["product"]: u["per_unit"] for u in r.get("usage") or [] if u.get("product") in names}
        used_by[r["name"]] = terms
        if terms:
            m.cap.add(sum(v * m.x[k] for k, v in terms.items()) <= r["available"])
    solver = pyo.SolverFactory("appsi_highs")
    res = solver.solve(m, load_solutions=False)
    status = str(res.solver.termination_condition)
    if "optimal" not in status.lower():
        return None, status
    m.solutions.load_from(res)
    plan = {n: pyo.value(m.x[n]) for n in names}

    # What one more unit of each resource is worth: the LP's shadow price, read
    # by re-solving the relaxation with that resource increased by one.
    def profit_with(extra):
        mm = m.clone()
        for v in mm.x.values():
            v.domain = pyo.NonNegativeReals
        mm.cap.clear()
        for r in resources:
            terms = used_by[r["name"]]
            if terms:
                mm.cap.add(sum(v * mm.x[k] for k, v in terms.items()) <= r["available"] + extra.get(r["name"], 0))
        pyo.SolverFactory("appsi_highs").solve(mm)
        return pyo.value(mm.profit)

    base = profit_with({})
    usage = []
    for r in resources:
        used = sum(v * plan[k] for k, v in used_by[r["name"]].items())
        worth = profit_with({r["name"]: 1}) - base
        usage.append({"name": r["name"], "available": r["available"], "used": used, "worth": worth})
    return {"plan": plan, "profit": pyo.value(m.profit), "usage": usage}, status


async def run_agent(content: str, context: dict, attach_fn=None) -> dict:
    req = await extract(INSTRUCTIONS, content, SCHEMA, SCHEMA["required"])
    products = [p for p in (req or {}).get("products") or []
                if p.get("name") and isinstance(p.get("profit"), (int, float))][:30]
    resources = [r for r in (req or {}).get("resources") or []
                 if r.get("name") and isinstance(r.get("available"), (int, float))][:30]
    if not products or not resources:
        return {"action": "reply_email", "text": "Tell me the products (profit per unit) and the limited resources "
                "(how much is available, and how much each product uses), and I'll find the best mix."}

    whole = bool(req.get("whole_units", True))
    try:
        result, status = await asyncio.to_thread(_solve, products, resources, whole)
    except Exception as exc:
        return {"action": "reply_email", "text": f"The model could not be solved ({type(exc).__name__}: {exc}). "
                "Check that every resource's usage refers to a product by the same name."}
    if not result:
        short = []
        for r in resources:
            need = sum(u["per_unit"] * (next((p.get("min_qty") or 0) for p in products if p["name"] == u["product"]))
                       for u in r.get("usage") or [] if any(p["name"] == u.get("product") for p in products))
            if need > r["available"] + 1e-9:
                short.append(f"{r['name']}: the minimums need {need:,.2f} but only {r['available']:,.2f} is available")
        mins = "; ".join(f"{p['name']} at least {p['min_qty']:g}" for p in products if (p.get("min_qty") or 0) > 0)
        return {"action": "reply_email", "text": "No — that can't be done with the current capacity."
                + (f" Required: {mins}." if mins else "")
                + ("\n" + "\n".join(short) if short else f" (solver status: {status})")
                + "\nMore of the short resource, or a smaller order, would make it possible."}

    fmt = (lambda v: f"{v:,.0f}") if whole else (lambda v: f"{v:,.2f}")
    lines = [f"Best plan — profit {result['profit']:,.2f}:"]
    lines += [f"  {n}: {fmt(q)}" for n, q in result["plan"].items()]
    lines += ["", "Resources (used / available, and what one more unit would add to profit):"]
    for u in result["usage"]:
        tight = u["used"] >= u["available"] - 1e-6
        lines.append(f"  {u['name']}: {u['used']:,.2f} / {u['available']:,.2f}"
                     + (f" — bottleneck, +{u['worth']:,.2f} per extra unit" if tight and u["worth"] > 1e-6
                        else " — spare capacity"))
    bounds = [f"{p['name']} at least {p['min_qty']:g}" for p in products if (p.get("min_qty") or 0) > 0]
    bounds += [f"{p['name']} at most {p['max_qty']:g}" for p in products
               if p.get("max_qty") is not None and p["max_qty"] >= 0]
    lines += ["", "Requirements applied: " + ("; ".join(bounds) if bounds else "none beyond the resource limits")]
    lines.append("Solved exactly with HiGHS" + (" in whole units." if whole else " (fractional quantities allowed)."))
    if whole:
        lines.append("Values of extra capacity come from the continuous version of the problem, so treat them "
                     "as a guide rather than an exact figure.")
    if req.get("unclear"):
        lines += ["", f"Assumed: {req['unclear']}"]

    deliverables = []
    if attach_fn:
        csv = "product,quantity,profit_per_unit,profit\n" + "".join(
            f"{p['name']},{result['plan'][p['name']]:.4f},{p['profit']},{p['profit'] * result['plan'][p['name']]:.2f}\n"
            for p in products)
        if attach_fn("production_plan.csv", csv):
            deliverables.append("production_plan.csv")
    return {"action": "reply_email", "text": "\n".join(lines), "deliverables": deliverables}


async def resume_agent(thread_id: str, resolution: dict, **tools) -> dict:
    return {"action": "none"}
