"""Currency Desk — converts amounts and compares exchange rates, from the Frankfurter API.

Ask, e.g., "Convert our $12,400 invoice to EUR and GBP at today's rate" or
"How has USD to INR moved since the start of September?" It uses official
reference rates (European Central Bank and other central banks, via
api.frankfurter.dev — the only outside site it reaches) and says which date
each rate is from.
"""
import httpx

from llm_extract import extract

API = "https://api.frankfurter.dev/v2"

SCHEMA = {
    "type": "object",
    "properties": {
        "conversions": {"type": "array", "items": {"type": "object", "properties": {
            "amount": {"type": "number"}, "from": {"type": "string"}, "to": {"type": "string"},
            "date": {"type": "string"}}}},
        "trend": {"type": "object", "properties": {
            "from": {"type": "string"}, "to": {"type": "string"},
            "start": {"type": "string"}, "end": {"type": "string"}}},
        "unclear": {"type": "string"},
    },
    "required": ["conversions", "trend", "unclear"],
}

INSTRUCTIONS = (
    "You read a currency request. In 'conversions', list each amount to convert with ISO currency codes "
    "(USD, EUR, GBP, INR...) — one entry per target currency — and 'date' as YYYY-MM-DD if a past date is "
    "asked for, else an empty string. If the request asks how a rate moved over a period, fill 'trend' "
    "with the two codes and start/end dates as YYYY-MM-DD (end empty for today); otherwise leave 'trend' "
    "codes empty. Today is {today}."
)


async def run_agent(content: str, context: dict) -> dict:
    import datetime as dt

    today = dt.date.today().isoformat()
    req = await extract(INSTRUCTIONS.replace("{today}", today), content, SCHEMA, SCHEMA["required"])
    if not req:
        return {"action": "reply_email", "text": "Tell me the amount and currencies to convert (e.g. 1,200 USD "
                "to EUR), or which exchange rate and period to look at."}

    out = []
    async with httpx.AsyncClient(timeout=20) as client:
        for c in (req.get("conversions") or [])[:10]:
            frm, to = str(c.get("from", "")).upper()[:3], str(c.get("to", "")).upper()[:3]
            if len(frm) != 3 or len(to) != 3 or not isinstance(c.get("amount"), (int, float)):
                continue
            params = {"date": c["date"]} if c.get("date") else {}
            r = await client.get(f"{API}/rate/{frm.lower()}/{to.lower()}", params=params)
            if r.status_code != 200:
                out.append(f"{frm}→{to}: no rate available ({r.json().get('message', r.status_code)}).")
                continue
            d = r.json()
            out.append(f"{c['amount']:,.2f} {frm} = {c['amount'] * d['rate']:,.2f} {to}  "
                       f"(rate {d['rate']:.5f}, {d['date']})")

        t = req.get("trend") or {}
        frm, to = str(t.get("from", "")).upper()[:3], str(t.get("to", "")).upper()[:3]
        if len(frm) == 3 and len(to) == 3 and t.get("start"):
            params = {"base": frm, "quotes": to, "from": t["start"], "to": t.get("end") or today}
            r = await client.get(f"{API}/rates", params=params)
            series = r.json() if r.status_code == 200 else []
            if isinstance(series, list) and len(series) >= 2:
                first, last = series[0], series[-1]
                lo = min(series, key=lambda s: s["rate"])
                hi = max(series, key=lambda s: s["rate"])
                change = (last["rate"] / first["rate"] - 1) * 100
                if out:
                    out.append("")
                out += [f"{frm}→{to} from {first['date']} to {last['date']}: {first['rate']:.5f} → "
                        f"{last['rate']:.5f} ({change:+.2f}%).",
                        f"Low {lo['rate']:.5f} on {lo['date']}, high {hi['rate']:.5f} on {hi['date']}, "
                        f"{len(series)} daily rates."]
            else:
                out.append(f"No {frm}→{to} rates found for that period.")

    if not out:
        return {"action": "reply_email", "text": "I couldn't find a conversion or rate to look up in that message. "
                "Give me an amount and two currencies, e.g. 500 GBP to USD."}
    if req.get("unclear"):
        out += ["", f"Note: {req['unclear']}"]
    out += ["", "Reference rates from api.frankfurter.dev (central bank data, published on working days). "
                "Your bank's rate will include its own margin."]
    return {"action": "reply_email", "text": "\n".join(out)}


async def resume_agent(thread_id: str, resolution: dict, **tools) -> dict:
    return {"action": "none"}
