#!/bin/sh
# Build the road network Route Planner plans on, once, at build time.
#
# The area is fixed here rather than fetched per email: converting a map needs
# SUMO's netconvert, which is a separate program, and the platform only lets
# packages run programs while they are being built. It also means no email waits
# on the public map service, which answered 502/504 when busy on 2026-10-16.
#
# Central Indianapolis, about 15 x 15 km. Sized for the standard tier's 512 MB
# with room for the platform's own code in the same process: an 18 km area
# peaked at 480 MB with the adapter's libraries loaded, a 22 km one at 517 MB,
# and the 35 km metro did not fit at all. A larger area needs
# "resources": "large" in marketplace.json.
set -e
SOUTH=39.70
WEST=-86.22
NORTH=39.84
EAST=-86.05
NAME="central Indianapolis"

ROADS="motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link"
cat > query.txt <<EOF
[out:xml][timeout:300];
way["highway"~"^(${ROADS})\$"](${SOUTH},${WEST},${NORTH},${EAST});
(._;>;);
out body;
EOF

ok=""
for wait in 0 20 60; do
  sleep "$wait"
  code=$(curl -s -A "AgentStore-RoutePlanner-build/1.1" --max-time 400 \
    --data-urlencode data@query.txt https://overpass-api.de/api/interpreter \
    -o roads.osm.xml -w "%{http_code}") || code="000"
  if [ "$code" = "200" ] && [ "$(wc -c < roads.osm.xml)" -gt 100000 ]; then ok=1; break; fi
  echo "map download attempt answered $code; retrying"
done
[ -n "$ok" ] || { echo "could not download the road map"; exit 1; }

NETCONVERT=$(python -c "import sumo, os; print(os.path.join(sumo.SUMO_HOME, 'bin', 'netconvert'))")
# Lean on purpose: no junction-internal lanes, turnarounds or corner detail.
# Routing does not need them, and with them the network is about three times
# the size and no longer fits the standard tier once loaded.
"$NETCONVERT" --osm-files roads.osm.xml -o roads.net.xml \
  --geometry.remove --ramps.guess --junctions.join \
  --tls.guess-signals --tls.discard-simple --tls.join \
  --keep-edges.by-vclass passenger --remove-edges.isolated \
  --keep-edges.components 1 \
  --no-internal-links --no-turnarounds --junctions.corner-detail 0 \
  --no-warnings --output.street-names true
rm -f roads.osm.xml query.txt

# Keep only roads a van can both reach and leave, so the running agent neither
# snaps a stop onto a dead one-way stub nor holds the whole graph to work it out.
python roads.py core roads.net.xml core.txt
"$NETCONVERT" -s roads.net.xml --keep-edges.input-file core.txt -o roads.core.net.xml \
  --no-internal-links --no-turnarounds --junctions.corner-detail 0 --no-warnings
mv roads.core.net.xml roads.net.xml
rm -f core.txt

printf '{"name": "%s", "south": %s, "west": %s, "north": %s, "east": %s}\n' \
  "$NAME" "$SOUTH" "$WEST" "$NORTH" "$EAST" > map_area.json
echo "built roads.net.xml for $NAME"

# The grey street background every map and the replay are drawn on, drawn once
# here so the running agent never redraws 26,000 streets per email.
python roads.py background roads.net.xml background.png map_area.json
