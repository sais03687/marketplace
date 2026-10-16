#!/bin/sh
# Build the city grid SUMO simulates rush-hour traffic on, once, at build time.
set -e
NETGEN=$(python -c "import sumo, os; print(os.path.join(sumo.SUMO_HOME, 'bin', 'netgenerate'))")
"$NETGEN" --grid --grid.number 6 --grid.length 250 --default.lanenumber 1 \
  --tls.guess true -o grid.net.xml
echo "built grid.net.xml"
