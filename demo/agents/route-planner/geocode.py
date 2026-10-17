"""Street addresses to coordinates, with the U.S. Census Bureau Geocoder.

Chosen over OpenStreetMap's public Nominatim: Nominatim's usage policy discourages
being built into services and warns commercial users access can be withdrawn,
while the Census geocoder is a free federal service with no key, built on public
address-range data. It covers the United States only, which is all this agent's
road map covers anyway.

Measured 2026-10-17 from the platform's server: about 170 ms per address, matches
within ~50 m of a mainstream map service for the demo addresses, and an address
it cannot find returns no match rather than a guess.
"""
import asyncio

import httpx

URL = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress"
_cache: dict[str, tuple[float, float, str] | None] = {}


async def locate(address: str, client: httpx.AsyncClient) -> tuple[float, float, str] | None:
    """(lat, lon, matched address) for one address, or None if it cannot be found."""
    key = " ".join(address.lower().split())
    if key in _cache:
        return _cache[key]
    params = {"address": address, "benchmark": "Public_AR_Current", "format": "json"}
    for attempt in range(3):
        try:
            resp = await client.get(URL, params=params, timeout=15.0)
            # A 4xx is the service refusing this input, not the service being
            # down: it is "not found", and retrying it changes nothing. Reported
            # as "could not be reached" it sent the sender off to retry later.
            if 400 <= resp.status_code < 500:
                _cache[key] = None
                return None
            if resp.status_code != 200:
                raise httpx.HTTPStatusError(f"status {resp.status_code}", request=resp.request, response=resp)
            matches = resp.json().get("result", {}).get("addressMatches") or []
            found = None
            if matches:
                m = matches[0]
                found = (float(m["coordinates"]["y"]), float(m["coordinates"]["x"]), m.get("matchedAddress", ""))
            _cache[key] = found
            return found
        except (httpx.HTTPError, ValueError, KeyError) as exc:
            print(f"[geocode] attempt {attempt + 1} for {address!r}: {type(exc).__name__}", flush=True)
            await asyncio.sleep(1.5 * (attempt + 1))
    raise GeocoderUnavailable("the address service could not be reached")


class GeocoderUnavailable(Exception):
    """The address service did not answer; says so in words for the buyer."""


async def locate_all(addresses: list[str]) -> list[tuple[float, float, str] | None]:
    """Look up several addresses, four at a time."""
    sem = asyncio.Semaphore(4)
    async with httpx.AsyncClient(headers={"User-Agent": "AgentStore-RoutePlanner/1.2"}) as client:
        async def one(a):
            async with sem:
                return await locate(a, client)
        return await asyncio.gather(*(one(a) for a in addresses))
