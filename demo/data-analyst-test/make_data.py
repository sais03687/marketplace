import random, datetime as dt
import pandas as pd

random.seed(42)
products = {"Desk Lamp": 39.0, "Monitor Arm": 89.0, "Standing Desk": 449.0,
            "Ergo Chair": 329.0, "USB-C Dock": 149.0, "Keyboard": 79.0}
regions = ["West", "East", "Central", "South"]
rows = []
oid = 10001
start = dt.date(2026, 7, 1)
for i in range(140):
    d = start + dt.timedelta(days=random.randint(0, 91))       # Jul 1 .. Sep 30
    p = random.choice(list(products))
    # Standing desks sell well in July/Aug, then fall off in September
    if p == "Standing Desk" and d.month == 9 and random.random() < 0.7:
        p = "Keyboard"
    rows.append(dict(order_id=f"SO-{oid}", order_date=d, region=random.choice(regions),
                     product=p, quantity=random.randint(1, 6), unit_price=products[p],
                     discount_pct=random.choice([0, 0, 0, 5, 10, 15]), status="Completed"))
    oid += 1

df = pd.DataFrame(rows)
# Trap 1: 6 orders cancelled
for i in [3, 17, 44, 71, 98, 120]:
    df.loc[i, "status"] = "Cancelled"
# Trap 2: 4 refunds as their own negative-quantity lines
for i in [10, 55, 90, 130]:
    r = df.loc[i].copy(); r["order_id"] = r["order_id"] + "-R"; r["quantity"] = -r["quantity"]; r["status"] = "Refunded"
    df = pd.concat([df, r.to_frame().T], ignore_index=True)
# Trap 3: 3 exact duplicate rows (export glitch)
df = pd.concat([df, df.loc[[25, 60, 101]]], ignore_index=True)
# Trap 4: 2 orders dated Oct 1 (outside Q3)
extra = df.loc[[5, 6]].copy(); extra["order_id"] = ["SO-10141", "SO-10142"]; extra["order_date"] = dt.date(2026, 10, 1)
df = pd.concat([df, extra], ignore_index=True)
# Trap 5: inconsistent region spelling
for i in [8, 33, 77]:
    df.loc[i, "region"] = df.loc[i, "region"].lower() + " "

df = df.sample(frac=1, random_state=7).reset_index(drop=True)
df["order_date"] = pd.to_datetime(df["order_date"])
df.to_excel("q3_orders_export.xlsx", index=False, sheet_name="orders")
print(len(df), "rows written")
