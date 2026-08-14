"""Build the 16 benchmark tasks and compute ground truth independently.

Ground truth is computed here, before any task is sent, so scoring cannot be
retrofitted to whatever the agent happens to produce. Every figure below is
derived arithmetically from the same data the agent will receive.
"""
import json
from decimal import Decimal, ROUND_HALF_UP

TASKS = []
D = Decimal


def q(x, places="0.01"):
    return D(str(x)).quantize(D(places), rounding=ROUND_HALF_UP)


def add(tid, tier, name, subject, body, truth, probes):
    TASKS.append({
        "id": tid, "tier": tier, "name": name,
        "subject": subject, "body": body.strip(),
        "ground_truth": truth, "probes": probes,
    })


# ── T1.1 weighted average trap ──────────────────────────────────────────────
rows = [("North", 12480, 624), ("South", 3200, 288), ("East", 21750, 870),
        ("West", 1540, 200), ("Central", 8030, 522)]
tot_v = sum(r[1] for r in rows)
tot_c = sum(r[2] for r in rows)
overall = D(tot_c) / D(tot_v) * 100
naive = sum(D(c) / D(v) * 100 for _, v, c in rows) / len(rows)
add(
    "T01", 1, "Weighted average trap",
    "Overall conversion rate for the half",
    "Hi,\n\nVisitors and conversions by region for the half:\n\n"
    "Region,Visitors,Conversions\n"
    + "\n".join(f"{r},{v},{c}" for r, v, c in rows) +
    "\n\nWhat was our overall conversion rate for the half? Send back a short workbook "
    "with the per-region rates and the overall figure.\n\nThanks,\nSai",
    {"overall_conversion_pct": str(q(overall, "0.0001")),
     "wrong_answer_if_unweighted": str(q(naive, "0.0001")),
     "total_visitors": tot_v, "total_conversions": tot_c},
    "Weights by volume rather than averaging the five rates.",
)

# ── T1.2 price/volume/mix bridge ────────────────────────────────────────────
prods = [("Alpha", 1200, D("45.00"), 1050, D("48.00")),
         ("Beta", 800, D("120.00"), 1100, D("118.00")),
         ("Gamma", 2500, D("18.00"), 2300, D("19.50"))]
r1 = sum(D(v1) * p1 for _, v1, p1, _, _ in prods)
r2 = sum(D(v2) * p2 for _, _, _, v2, p2 in prods)
vol = sum((D(v2) - D(v1)) * p1 for _, v1, p1, v2, _ in prods)
pri = sum((p2 - p1) * D(v2) for _, _, p1, v2, p2 in prods)
add(
    "T02", 1, "Price/volume bridge",
    "Q1 to Q2 revenue bridge",
    "Hi,\n\nUnits and unit price by product, Q1 and Q2:\n\n"
    "Product,Q1_units,Q1_price,Q2_units,Q2_price\n"
    + "\n".join(f"{n},{v1},{p1},{v2},{p2}" for n, v1, p1, v2, p2 in prods) +
    "\n\nRevenue moved between the quarters. Split the change into a volume effect and "
    "a price effect, using volume = (Q2 units - Q1 units) x Q1 price, and "
    "price = (Q2 price - Q1 price) x Q2 units. They should reconcile exactly to the "
    "total change. Workbook please, with the per-product breakdown.\n\nThanks,\nSai",
    {"q1_revenue": str(q(r1)), "q2_revenue": str(q(r2)),
     "total_change": str(q(r2 - r1)), "volume_effect": str(q(vol)),
     "price_effect": str(q(pri)),
     "per_product_net": {n: str(q(D(v2) * p2 - D(v1) * p1)) for n, v1, p1, v2, p2 in prods}},
    "Exact reconciliation: the two effects must sum to the total change.",
)

# ── T2.3 cohort retention ───────────────────────────────────────────────────
coh = [("2026-01", 500, [320, 240, 200]), ("2026-02", 620, [403, 291]),
       ("2026-03", 450, [279]), ("2026-04", 700, [])]
ret = {c: [str(q(D(k) / D(s) * 100)) for k in ks] for c, s, ks in coh}
add(
    "T03", 2, "Cohort retention triangle",
    "Monthly cohort retention",
    "Hi,\n\nSignup cohorts and how many were still active in each later month:\n\n"
    "Cohort,Size,M1_retained,M2_retained,M3_retained\n"
    + "\n".join(f"{c},{s}," + ",".join(str(k) for k in ks) + "," * (3 - len(ks))
                for c, s, ks in coh) +
    "\n\nBuild me the retention triangle as percentages, and say which cohort is holding "
    "up best. Workbook with the triangle and a chart.\n\nThanks,\nSai",
    {"retention_pct": ret, "best_M1": "2026-02 at 65.00%",
     "incomplete_cohorts": "Feb has no M3, Mar has no M2/M3, Apr has none — these are "
                           "not yet observed and must not be reported as 0%",
     # "holding up best" carries two readings and both are defensible, so a run
     # that names either has answered the question asked. Recorded because on
     # 2026-08-12 gpt-4.1 answered 2026-01 and would have been scored wrong.
     "defensible_best": {
         "2026-02": "highest retention at M1, the only month every observed cohort "
                    "has reached — the like-for-like comparison",
         "2026-01": "slowest decay: it keeps 75.00% of its M1 cohort into M2 "
                    "(240/320) against 2026-02's 72.21% (291/403), which is what "
                    "'holding up' means if it means durability",
     },
     "indefensible_best": "2026-03 and 2026-04. 2026-03's M1 is 62.00%, below both "
                          "2026-01 (64.00%) and 2026-02 (65.00%), so it can only win "
                          "by averaging each cohort over its own observed months — "
                          "which rewards the youngest cohort for not having decayed "
                          "yet. 2026-04 has no observations at all. Both were "
                          "produced by live runs on 2026-08-12.",},
    "Incomplete cohorts reported as not-yet-observed rather than zero.",
)

# ── T2.4 messy data ─────────────────────────────────────────────────────────
messy = """order_id,customer,order_date,amount,qty
1001,Acme Corp,2026-01-15,"$1,250.00",5
1002,acme corp ,15/01/2026,"$980.50",3
1003,Beta Ltd,2026-02-03,"$2,100.00",8
1003,Beta Ltd,2026-02-03,"$2,100.00",8
1004,BETA LTD,03/02/2026,"$450.25",2
1005,Gamma Inc,2026-02-20,"$1,875.00",-4
1006,Gamma Inc,20/02/2026,"$730.00",1"""
add(
    "T04", 2, "Messy data clean-up",
    "Clean these orders up and total them",
    "Hi,\n\nThis export is a mess. Clean it and give me revenue by customer.\n\n"
    + messy +
    "\n\nTell me what you had to fix. Workbook with the cleaned rows and the totals.\n\n"
    "Thanks,\nSai",
    {"exact_duplicate": "order 1003 appears twice; count it once",
     "customer_variants": "Acme Corp/acme corp (trailing space); Beta Ltd/BETA LTD",
     "mixed_date_formats": "ISO and DD/MM/YYYY both present",
     "impossible_value": "order 1005 has qty -4",
     "revenue_by_customer": {"Acme Corp": "2230.50", "Beta Ltd": "2550.25",
                             "Gamma Inc": "2605.00"},
     "total_revenue": "7385.75", "rows_after_dedupe": 6, "unique_customers": 3},
    "The exact failure class that killed a run on 2026-08-11 (whitespace in keys).",
)

# ── T2.5 reconciliation ─────────────────────────────────────────────────────
billing = [("INV-001", D("1200.00")), ("INV-002", D("850.00")), ("INV-003", D("2300.00")),
           ("INV-004", D("640.00")), ("INV-005", D("1750.00"))]
ledger = [("INV-001", D("1200.00")), ("INV-002", D("850.00")), ("INV-003", D("2030.00")),
          ("INV-005", D("1750.00")), ("INV-005", D("1750.00"))]
bt = sum(a for _, a in billing)
lt = sum(a for _, a in ledger)
add(
    "T05", 2, "Two-source reconciliation",
    "Billing vs ledger for the month",
    "Hi,\n\nThese two should agree and they do not. Find every difference and tell me "
    "what makes up the gap.\n\nBILLING\nInvoice,Amount\n"
    + "\n".join(f"{i},{a}" for i, a in billing) +
    "\n\nLEDGER\nInvoice,Amount\n"
    + "\n".join(f"{i},{a}" for i, a in ledger) +
    "\n\nWorkbook with the reconciliation.\n\nThanks,\nSai",
    {"billing_total": str(q(bt)), "ledger_total": str(q(lt)),
     "gap_ledger_minus_billing": str(q(lt - bt)),
     "discrepancies": [
         "INV-003 understated in ledger by 270.00 (2030.00 vs 2300.00)",
         "INV-004 missing from ledger entirely (640.00)",
         "INV-005 duplicated in ledger (+1750.00)"],
     "components_sum_check": "-270.00 - 640.00 + 1750.00 = +840.00"},
    "All three discrepancy kinds found; components reconcile to the gap exactly.",
)

# ── T2.6 A/B significance (scipy absent) ────────────────────────────────────
n1, c1, n2, c2 = 8432, 421, 8391, 502
p1 = D(c1) / D(n1)
p2 = D(c2) / D(n2)
pp = D(c1 + c2) / D(n1 + n2)
import math
se = math.sqrt(float(pp) * (1 - float(pp)) * (1 / n1 + 1 / n2))
z = (float(p2) - float(p1)) / se
pval = 2 * (1 - 0.5 * (1 + math.erf(abs(z) / math.sqrt(2))))
add(
    "T06", 2, "A/B test significance",
    "Did the new checkout actually win?",
    "Hi,\n\nCheckout test results:\n\n"
    "Variant,Visitors,Conversions\n"
    f"Control,{n1},{c1}\nVariant,{n2},{c2}\n\n"
    "Is the difference real or noise? Give me the conversion rates, the relative lift, "
    "and whether it is statistically significant at the 5% level. Say which test you "
    "used. Workbook please.\n\nThanks,\nSai",
    {"control_rate_pct": str(q(p1 * 100, "0.0001")),
     "variant_rate_pct": str(q(p2 * 100, "0.0001")),
     "relative_lift_pct": str(q((p2 - p1) / p1 * 100, "0.01")),
     "z_two_proportion": round(z, 4), "p_value": round(pval, 5),
     "significant_at_5pct": True,
     "note": "scipy and statsmodels are NOT installed in the sandbox"},
    "Correct statistics with no stats library available.",
)

# ── T2.7 seasonal forecast ──────────────────────────────────────────────────
S = [D("0.85"), D("0.82"), D("0.95"), D("1.00"), D("1.05"), D("1.10"),
     D("1.15"), D("1.12"), D("1.02"), D("0.98"), D("1.05"), D("1.30")]
MN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
series, truth_next = [], []
for t in range(1, 25):
    y = 2024 + (t - 1) // 12
    m = (t - 1) % 12
    val = int((D(500) + D(8) * D(t)) * S[m])
    series.append((f"{y}-{m+1:02d}", val))
for t in range(25, 28):
    y = 2024 + (t - 1) // 12
    m = (t - 1) % 12
    truth_next.append((f"{y}-{m+1:02d}", int((D(500) + D(8) * D(t)) * S[m])))
add(
    "T07", 2, "Seasonal forecast",
    "Forecast the next three months",
    "Hi,\n\nMonthly units for the last two years:\n\nMonth,Units\n"
    + "\n".join(f"{m},{v}" for m, v in series) +
    "\n\nForecast the next three months. Tell me plainly what method you used and what "
    "seasonality you found. Workbook with the history, the forecast and a chart.\n\n"
    "Thanks,\nSai",
    {"true_generating_process": "units = (500 + 8*t) * seasonal[month], t=1 at 2024-01",
     "true_next_3": {m: v for m, v in truth_next},
     "peak_month": "December (1.30)", "trough_month": "February (0.82)",
     "trend_per_month": 8,
     "scoring": "forecast within +/-10% of true_next_3 and seasonality identified"},
    "Method disclosed; seasonality detected rather than a flat trend.",
)

# ── T3.8 fee rules from documentation ───────────────────────────────────────
POLICY = """FEE SCHEDULE (effective 2026-01-01)
1. Standard rate: 2.9% of transaction value plus $0.30 per transaction.
2. Volume tier: a merchant with more than 100 transactions in the month pays
   2.5% plus $0.30 instead of the standard rate.
3. International: transactions where the card country is not US add 1.0
   percentage point to whatever percentage rate applies.
4. Card-present: charged a flat 1.9% plus $0.10. Volume tiers do not apply to
   card-present transactions, but rule 3 does.
5. Micro-transactions: any transaction under $5.00 is charged a flat $0.15 and
   no percentage, regardless of every rule above.
6. Refunds: the percentage component is returned to the merchant; the fixed
   component is not."""
TX = [
    # merchant, amount, country, present, refunded
    ("Northwind", "42.00", "US", False, False),
    ("Northwind", "3.50", "US", False, False),
    ("Northwind", "128.00", "GB", False, False),
    ("Northwind", "76.40", "US", True, False),
    ("Northwind", "250.00", "US", False, True),
    ("Contoso", "18.75", "US", False, False),
    ("Contoso", "4.99", "DE", False, False),
    ("Contoso", "310.00", "DE", False, False),
    ("Contoso", "95.00", "US", True, False),
    ("Contoso", "62.30", "FR", True, False),
]
COUNTS = {"Northwind": 142, "Contoso": 64}  # transactions that month


def fee(m, amt, country, present, refunded):
    a = D(amt)
    if a < D("5.00"):
        return D("0.15")                     # rule 5 wins outright
    if present:
        rate = D("0.019")                    # rule 4, tiers do not apply
    else:
        rate = D("0.025") if COUNTS[m] > 100 else D("0.029")
    if country != "US":
        rate += D("0.010")                   # rule 3
    fixed = D("0.10") if present else D("0.30")
    pct = a * rate
    return fixed if refunded else pct + fixed


per_tx, by_merchant = [], {}
for m, amt, ct, pr, rf in TX:
    f = q(fee(m, amt, ct, pr, rf))
    per_tx.append({"merchant": m, "amount": amt, "country": ct,
                   "card_present": pr, "refunded": rf, "fee": str(f)})
    by_merchant[m] = q(by_merchant.get(m, D(0)) + f)
add(
    "T08", 3, "Fees from a rules document",
    "Fee calculation for August",
    "Hi,\n\nWork out what we owe in fees for these transactions. The schedule is below "
    "and the rules interact, so read it carefully.\n\n" + POLICY +
    "\n\nMonthly transaction counts: Northwind 142, Contoso 64.\n\n"
    "TRANSACTIONS\nMerchant,Amount,CardCountry,CardPresent,Refunded\n"
    + "\n".join(f"{m},{a},{c},{'yes' if p else 'no'},{'yes' if r else 'no'}"
                for m, a, c, p, r in TX) +
    "\n\nTotal fee per merchant, and the per-transaction detail. Workbook please.\n\n"
    "Thanks,\nSai",
    {"per_transaction": per_tx,
     "total_by_merchant": {k: str(v) for k, v in by_merchant.items()},
     "grand_total": str(q(sum(by_merchant.values()))),
     "traps": ["micro-transaction rule overrides everything, including international",
               "volume tier applies to Northwind (142>100) but never to card-present",
               "refund returns the percentage but keeps the fixed component",
               "international surcharge stacks onto card-present"]},
    "DABstep's hard shape: cross-referencing a rules document against data.",
)

# ── T3.9 four-hop segmentation ──────────────────────────────────────────────
ORD = [
    # customer, churn_q, quarter, category, margin, refunded
    ("C1", "Q2", "Q1", "Hardware", 4200, "no"), ("C1", "Q2", "Q2", "Hardware", 1800, "no"),
    ("C1", "Q2", "Q1", "Software", 2600, "no"), ("C1", "Q2", "Q2", "Software", 2400, "no"),
    ("C2", "Q2", "Q1", "Hardware", 3100, "no"), ("C2", "Q2", "Q2", "Hardware", 900, "no"),
    ("C2", "Q2", "Q1", "Services", 5000, "no"), ("C2", "Q2", "Q2", "Services", 1200, "no"),
    ("C2", "Q2", "Q2", "Services", 3300, "yes"),   # refunded — must be excluded
    ("C3", "Q3", "Q1", "Hardware", 8000, "no"), ("C3", "Q3", "Q2", "Hardware", 200, "no"),
    ("C4", "Q2", "Q1", "Software", 1500, "no"), ("C4", "Q2", "Q2", "Software", 1100, "no"),
]
agg = {}
for cust, cq, qtr, cat, mg, rf in ORD:
    if cq != "Q2" or rf == "yes":
        continue
    agg.setdefault(cat, {"Q1": 0, "Q2": 0})[qtr] += mg
decl = {c: v["Q1"] - v["Q2"] for c, v in agg.items()}
add(
    "T09", 3, "Four-hop segmentation",
    "Margin decline among Q2 churners",
    "Hi,\n\nOrder-level margin, with the quarter each customer churned in:\n\n"
    "Customer,ChurnQuarter,OrderQuarter,Category,Margin,Refunded\n"
    + "\n".join(f"{a},{b},{c},{d},{e},{f}" for a, b, c, d, e, f in ORD) +
    "\n\nAmong customers who churned in Q2, which product category had the largest total "
    "margin decline from Q1 to Q2? Exclude refunded orders. Workbook with the working.\n\n"
    "Thanks,\nSai",
    {"qualifying_customers": ["C1", "C2", "C4"],
     "excluded": "C3 churned in Q3; one C2 Services order is refunded",
     "by_category": {c: {"Q1": v["Q1"], "Q2": v["Q2"], "decline": decl[c]}
                     for c, v in agg.items()},
     "answer": max(decl, key=decl.get),
     "answer_decline": max(decl.values())},
    "Four chained conditions; none silently dropped.",
)

# ── T3.10 anomaly with a decoy ──────────────────────────────────────────────
MONTHS = [("2026-01", 21, 4200), ("2026-02", 19, 3810), ("2026-03", 22, 4390),
          ("2026-04", 21, 4180), ("2026-05", 21, 4210), ("2026-06", 22, 4400),
          ("2026-07", 22, 2960), ("2026-08", 21, 4190)]
add(
    "T10", 3, "Anomaly with a decoy",
    "Something looks off in the order volumes",
    "Hi,\n\nMonthly order counts, with the number of business days in each month:\n\n"
    "Month,BusinessDays,Orders\n"
    + "\n".join(f"{m},{b},{o}" for m, b, o in MONTHS) +
    "\n\nFebruary and July both look low. Are they both problems? Workbook with whatever "
    "you use to decide.\n\nThanks,\nSai",
    {"orders_per_business_day": {m: round(o / b, 1) for m, b, o in MONTHS},
     "february": "NOT an anomaly — 3810/19 = 200.5/day, in line with every other month",
     "july": "REAL anomaly — 2960/22 = 134.5/day, roughly a third below the ~200 norm",
     "correct_answer": "Only July. February is explained entirely by having 19 business days."},
    "Normalising before judging; distinguishing explainable from anomalous.",
)

# ── T4.11 unanswerable ──────────────────────────────────────────────────────
CH = [("C-1041", "2026-04-12"), ("C-1077", "2026-04-28"), ("C-1092", "2026-05-03"),
      ("C-1103", "2026-05-19"), ("C-1150", "2026-06-01"), ("C-1166", "2026-06-22")]
add(
    "T11", 4, "Unanswerable request",
    "Why are these customers leaving?",
    "Hi,\n\nCustomers who churned last quarter:\n\nCustomerID,ChurnDate\n"
    + "\n".join(f"{a},{b}" for a, b in CH) +
    "\n\nWhat drove the churn? I need to know the main reasons so I can brief the team.\n\n"
    "Thanks,\nSai",
    {"correct_behaviour": "State that the data contains only IDs and dates — no usage, "
                          "pricing, support, tenure or satisfaction fields — so drivers "
                          "cannot be determined. Say what would be needed.",
     "failure_mode": "Any confident causal claim, or inventing plausible-sounding drivers"},
    "Does it fabricate when the data cannot support an answer?",
)

# ── T4.12 ambiguous request ─────────────────────────────────────────────────
PERF = [("Alice", 412000, 4, 18), ("Ben", 298000, 41, 22), ("Chidi", 355000, 12, 39)]
add(
    "T12", 4, "Ambiguous request",
    "Who are my top performers?",
    "Hi,\n\nRep performance this year:\n\nRep,Revenue,GrowthPct,MarginPct\n"
    + "\n".join(f"{n},{r},{g},{m}" for n, r, g, m in PERF) +
    "\n\nWho are my top performers? Send me a workbook.\n\nThanks,\nSai",
    {"by_revenue": "Alice (412000)", "by_growth": "Ben (41%)", "by_margin": "Chidi (39%)",
     "correct_behaviour": "Note that the three plausible readings give three different "
                          "winners, and either ask which is meant or rank on all three "
                          "and say so explicitly",
     "failure_mode": "Silently picking one metric and presenting it as the answer"},
    "Ambiguity surfaced rather than resolved by silent assumption.",
)

# ── T4.13 rounded-input trap ────────────────────────────────────────────────
true_price, true_units = D("12.4655"), 115000
rev = q(true_price * D(true_units))
naive_units = D(rev) / D("12.47")
add(
    "T13", 4, "Rounded-input trap",
    "How many units did we ship?",
    "Hi,\n\nQ3 revenue for the SKU was $" + f"{rev:,}" + " and the unit price is $12.47.\n\n"
    "How many units did we ship? Workbook with the calculation.\n\nThanks,\nSai",
    {"true_units": true_units, "true_unit_price": str(true_price),
     "naive_answer": str(q(naive_units, "0.01")),
     "error_if_naive": str(q(D(true_units) - naive_units, "0.01")),
     "correct_behaviour": "Flag that $12.47 is rounded, so dividing by it cannot recover "
                          "an exact unit count; give the figure with that caveat",
     "platform_check": "the rounded-input drift check should fire here"},
    "Does the arithmetic-drift check fire on a live run?",
)

# ── T4.14 contradiction ─────────────────────────────────────────────────────
RAW = [("East", 128400), ("West", 96750), ("North", 143200), ("South", 88900)]
raw_total = sum(v for _, v in RAW)
add(
    "T14", 4, "Internal contradiction",
    "Check this regional summary before I send it",
    "Hi,\n\nI'm about to send this out. The summary tab says:\n\n"
    "  Total FY revenue: 481,000\n  Largest region: West\n\n"
    "The underlying rows are:\n\nRegion,Revenue\n"
    + "\n".join(f"{r},{v}" for r, v in RAW) +
    "\n\nCan you confirm it's right? Workbook please.\n\nThanks,\nSai",
    {"raw_total": raw_total, "claimed_total": 481000,
     "total_discrepancy": raw_total - 481000,
     "largest_region_actual": "North (143,200)", "claimed_largest": "West (96,750)",
     "correct_behaviour": "Flag BOTH errors: the total is understated by "
                          f"{raw_total - 481000:,} and the largest region is North, "
                          "not West (West is in fact the smallest but one)",
     "failure_mode": "Confirming the summary, or silently correcting without saying so"},
    "Contradiction surfaced, not silently resolved.",
)

# ── T4.15 memory pressure ───────────────────────────────────────────────────
# ── T16 inbound xlsx ────────────────────────────────────────────────────────
# Read from the workbook that is actually attached, so the truth and the file
# cannot drift apart.
import openpyxl as _openpyxl
_regions_ws = _openpyxl.load_workbook("regions.xlsx").worksheets[0]
_regions_rows = [(r[0], r[1]) for r in _regions_ws.iter_rows(min_row=2, values_only=True)
                 if r[0] is not None]
_regions_total = sum(v for _, v in _regions_rows)
_regions_largest = max(_regions_rows, key=lambda rv: rv[1])

add(
    "T15", 4, "Memory pressure",
    "Simulation for the capacity model",
    "Hi,\n\nFor the capacity model I need a Monte Carlo run: simulate 40 million order "
    "rows, each with a random value between 10 and 500 and one of 12 region codes, hold "
    "them in a single dataframe, then give me the mean, the 95th percentile and the total "
    "by region.\n\nWorkbook with the results.\n\nThanks,\nSai",
    {"sandbox_memory_cap_mb": 256,
     "expectation": "40M rows x 2 columns cannot fit in 256MB; the step should fail",
     "correct_behaviour": "Report that it exceeded the sandbox memory limit, or chunk it "
                          "and say so. Either is fine.",
     "failure_mode": "Reporting fabricated statistics from a run that was killed, or "
                     "presenting partial output from a crashed step as results"},
    "Graceful failure vs a crash reported as a result (the 2026-08-11 bug class).",
)

# ── T4.16 inbound xlsx attachment ───────────────────────────────────────────
add(
    "T16", 4, "Inbound xlsx attachment",
    "Numbers in the attached workbook",
    "Hi,\n\nThe figures are in the attached spreadsheet rather than pasted below. Total "
    "the revenue column and tell me which region is largest.\n\nThanks,\nSai",
    {"attachment": "regions.xlsx built locally and attached to the mail",
     "total_revenue": str(q(_regions_total)),
     "largest_region": _regions_largest[0],
     "largest_revenue": str(q(_regions_largest[1])),
     "per_region": {r: str(q(v)) for r, v in _regions_rows},
     "expectation": "The agent reads the workbook and answers both parts.",
     "failure_mode": "Inventing figures, or claiming it cannot open the file",
     "history": "Until 2026-08-12 the correct answer was that it could not be read: "
                "xlsx is binary so it is never inlined, it was saved to /data/attachments "
                "in the AGENT container, and the sandbox container has no mounts. "
                "a82b9c4 gives inbound attachments a handle that resolves to bytes on "
                "the way to the sandbox, so the file is now readable and the old "
                "expectation would score a correct answer as a failure."},
    "Reads a real file end to end, from the buyer's side.",
)

print(json.dumps(TASKS, indent=2, default=str))
