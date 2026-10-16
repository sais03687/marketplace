"""Weather Briefing — forecasts for the places and days in an email, from the US National Weather Service.

Ask, e.g., "We have site visits in Indianapolis Wednesday and Bloomington
Thursday — any rain or wind we should plan around?" It looks up the official
NWS forecast (api.weather.gov, the only outside site it can reach) for each
place and flags rain, storms, wind and temperature extremes. US locations only.
"""
import datetime as dt

import httpx

from llm_extract import extract

UA = {"User-Agent": "AgentStore Weather Briefing (agents.agentstore.it.com)", "Accept": "application/geo+json"}

SCHEMA = {
    "type": "object",
    "properties": {
        "places": {"type": "array", "items": {"type": "object", "properties": {
            "name": {"type": "string"}, "lat": {"type": "number"}, "lon": {"type": "number"},
            "days": {"type": "array", "items": {"type": "string"}}}}},
        "outside_us": {"type": "array", "items": {"type": "string"}},
        "unclear": {"type": "string"},
    },
    "required": ["places", "outside_us", "unclear"],
}

INSTRUCTIONS = (
    "You read a request for a weather briefing. Include every place the email mentions, each with its own "
    "days — never drop one. For each place, give its name and approximate latitude "
    "and longitude in decimal degrees (city centre is fine), and the days asked about as weekday names "
    "(e.g. ['Wednesday']); an empty list means the next few days. The forecasts cover the US only: list "
    "any place outside the US by name in 'outside_us' and leave it out of 'places'. 'unclear' is for "
    "anything else you had to assume, or empty."
)

FLAGS = (("thunder", "storms"), ("rain", "rain"), ("showers", "showers"), ("snow", "snow"),
         ("ice", "ice"), ("fog", "fog"), ("wind", "wind"))


async def _forecast(client: httpx.AsyncClient, lat: float, lon: float):
    pts = await client.get(f"https://api.weather.gov/points/{lat:.4f},{lon:.4f}")
    pts.raise_for_status()
    props = pts.json()["properties"]
    fc = await client.get(props["forecast"])
    fc.raise_for_status()
    where = props.get("relativeLocation", {}).get("properties", {})
    return fc.json()["properties"]["periods"], f"{where.get('city', '')}, {where.get('state', '')}".strip(", ")


async def run_agent(content: str, context: dict) -> dict:
    req = await extract(INSTRUCTIONS, content, SCHEMA, SCHEMA["required"])
    places = [p for p in (req or {}).get("places") or []
              if isinstance(p.get("lat"), (int, float)) and isinstance(p.get("lon"), (int, float))][:6]
    if not places and (req or {}).get("outside_us"):
        return {"action": "reply_email", "text": f"I can only brief on US locations — {', '.join(req['outside_us'])} "
                "is outside the National Weather Service's coverage."}
    if not places:
        return {"action": "reply_email", "text": "Tell me which US places and days you need, and I'll pull the "
                "National Weather Service forecast for each."}

    out = []
    async with httpx.AsyncClient(timeout=20, headers=UA, follow_redirects=True) as client:
        for p in places:
            try:
                periods, nws_place = await _forecast(client, float(p["lat"]), float(p["lon"]))
            except Exception as exc:
                out.append(f"{p['name']}: the forecast could not be retrieved ({type(exc).__name__}). "
                           "The location may be outside the US.")
                continue
            days = {d.strip().lower() for d in p.get("days") or []}
            # By date, not by the period's label: NWS names a holiday's periods after
            # the holiday ("Columbus Day"), so matching "monday" in the name misses it.
            chosen = [x for x in periods
                      if not days or dt.datetime.fromisoformat(x["startTime"]).strftime("%A").lower() in days][:6]
            if not chosen:
                out.append(f"{p['name']}: no forecast yet for {', '.join(sorted(days))} — NWS forecasts cover "
                           "about the next 7 days.")
                continue
            out.append(f"{p['name']} (NWS grid near {nws_place}):")
            for x in chosen:
                text = x["detailedForecast"].lower()
                flags = sorted({label for word, label in FLAGS if word in text})
                rain = (x.get("probabilityOfPrecipitation") or {}).get("value")
                out.append(f"  {x['name']}: {x['temperature']}°{x['temperatureUnit']}, {x['shortForecast']}, "
                           f"wind {x['windSpeed']} {x['windDirection']}"
                           + (f", {rain}% chance of precipitation" if rain is not None else "")
                           + (f"  ⚑ {', '.join(flags)}" if flags else ""))
    if req.get("outside_us"):
        out += ["", f"Not covered: {', '.join(req['outside_us'])} — this briefing uses the US National Weather "
                "Service, which forecasts US locations only."]
    if req.get("unclear"):
        out += ["", f"Note: {req['unclear']}"]
    out += ["", "Source: US National Weather Service (api.weather.gov), retrieved just now."]
    return {"action": "reply_email", "text": "\n".join(out)}


async def resume_agent(thread_id: str, resolution: dict, **tools) -> dict:
    return {"action": "none"}
