import pandas as pd
df = pd.read_excel("q3_orders_export.xlsx")
print("raw rows:", len(df))
dups = df[df.duplicated(keep="first")]
print("exact duplicate rows:", sorted(dups.order_id))
df = df.drop_duplicates()
print("cancelled:", (df.status == "Cancelled").sum(), "| refund lines:", (df.status == "Refunded").sum())
outside = df[(df.order_date < "2026-07-01") | (df.order_date > "2026-09-30")]
print("outside Q3:", sorted(outside.order_id))
df = df[(df.order_date >= "2026-07-01") & (df.order_date <= "2026-09-30") & (df.status != "Cancelled")].copy()
df["region"] = df.region.str.strip().str.title()
df["net"] = df.quantity * df.unit_price * (1 - df.discount_pct / 100)
print(f"\nQ3 NET REVENUE: {df.net.sum():,.2f}")
print(f"  of which refunds: {df[df.status=='Refunded'].net.sum():,.2f}")
print("\nBY REGION:"); print(df.groupby("region").net.sum().sort_values(ascending=False).round(2).to_string())
df["month"] = df.order_date.dt.month
m = df.pivot_table(index="product", columns="month", values="net", aggfunc="sum", fill_value=0).round(2)
m["aug_to_sep"] = (m[9] - m[8]).round(2)
print("\nBY PRODUCT x MONTH:"); print(m.sort_values("aug_to_sep").to_string())
print("\nBY MONTH:"); print(df.groupby("month").net.sum().round(2).to_string())
