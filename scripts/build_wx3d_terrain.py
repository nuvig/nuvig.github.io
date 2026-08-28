#!/usr/bin/env python3
"""Build data/wx3d/terrain.json - the static terrain + landmark layer for wx3d.html.

Fetches a 192x192 elevation grid (USGS 3DEP "ned10m" via the OpenTopoData
public API, ~370 POSTs of 100 points each at 1 request/second - about 7
minutes) over the same box the page draws - SPAN_LAT x SPAN_LON degrees
centered on the field - and writes it, along with a hand-kept landmark list,
to data/wx3d/terrain.json. There is no separate water layer: the DEM is
hydro-flattened, tidal water sits at elevation ~0, and the page thresholds
that into its water mask (which is how the Chesapeake, the Potomac and the
river mouths appear without any coastline data).

Don't switch this back to Open-Meteo's elevation endpoint: it weighs each
COORDINATE as a call, so a 192x192 grid blows through its daily quota
(observed 429s within two chunks, 2026-08-27). OpenTopoData's public limits
are per REQUEST: 100 locations each, 1/second, 1000/day - one build fits
with room for a retry run.

The output is committed; rerun only to change the landmark list or if the
site is ever re-pointed at a different field (edit CENTER/SPANs here AND in
js/wx3d.js together - the page validates the file's bbox and quietly drops
terrain on a mismatch). Stdlib only.
"""

import json
import sys
import time
import urllib.request
from pathlib import Path

# Mirrors js/wx3d.js (SITE.airport + the volume constants there).
CENTER_LAT, CENTER_LON = 38.9429, -76.5684
SPAN_LAT, SPAN_LON = 2.0, 2.5
N = 192                      # grid points per side; row 0 = north edge
API = 'https://api.opentopodata.org/v1/ned10m'
CHUNK = 100                  # the API's per-request location limit
UA = 'jesselevine.net wx3d terrain build (one-time, stdlib urllib)'

# Landmarks the page draws over the map. kind: city / apt / bridge / peak.
# Airports here are the majors NOT already in SITE.weather.nearbyAirports.
LANDMARKS = [
    {'kind': 'city', 'name': 'Washington', 'lat': 38.9047, 'lon': -77.0164},
    {'kind': 'city', 'name': 'Baltimore', 'lat': 39.2904, 'lon': -76.6122},
    {'kind': 'city', 'name': 'Frederick', 'lat': 39.4143, 'lon': -77.4105},
    {'kind': 'apt', 'name': 'KBWI', 'lat': 39.1754, 'lon': -76.6683},
    {'kind': 'apt', 'name': 'KDCA', 'lat': 38.8521, 'lon': -77.0377},
    {'kind': 'apt', 'name': 'KADW', 'lat': 38.8108, 'lon': -76.8670},
    # Sandy Point -> Kent Island
    {'kind': 'bridge', 'name': 'Bay Bridge',
     'lat': 38.9930, 'lon': -76.3960, 'lat2': 38.9762, 'lon2': -76.3311},
    {'kind': 'peak', 'name': 'Sugarloaf', 'lat': 39.2621, 'lon': -77.3944},
    {'kind': 'peak', 'name': 'Catoctin', 'lat': 39.6550, 'lon': -77.4650},
]


def fetch_chunk(points, tries=4):
    body = json.dumps({
        'locations': '|'.join(f'{la:.5f},{lo:.5f}' for la, lo in points),
    }).encode()
    req = urllib.request.Request(
        API, data=body,
        headers={'Content-Type': 'application/json', 'User-Agent': UA})
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                data = json.load(r)
            results = data['results']
            if len(results) != len(points):
                raise ValueError(f'got {len(results)} results for {len(points)} points')
            # null = no data (shouldn't happen inside CONUS); treat as sea level
            return [0.0 if res['elevation'] is None else res['elevation']
                    for res in results]
        except Exception as e:                                   # noqa: BLE001
            if attempt == tries - 1:
                raise
            print(f'  retry ({e})', file=sys.stderr)
            time.sleep(5.0 * (attempt + 1))


def main():
    lat0 = CENTER_LAT + SPAN_LAT / 2          # north edge (row 0)
    lon0 = CENTER_LON - SPAN_LON / 2          # west edge (col 0)
    dlat = SPAN_LAT / (N - 1)
    dlon = SPAN_LON / (N - 1)

    coords = [(lat0 - iy * dlat, lon0 + ix * dlon)
              for iy in range(N) for ix in range(N)]
    elev = []
    nchunks = (len(coords) + CHUNK - 1) // CHUNK
    for c in range(nchunks):
        part = coords[c * CHUNK:(c + 1) * CHUNK]
        vals = fetch_chunk(part)
        elev.extend(int(round(v)) for v in vals)
        if c % 25 == 0 or c == nchunks - 1:
            print(f'  {c + 1}/{nchunks} chunks', file=sys.stderr)
        time.sleep(1.05)                        # public-API limit: 1 request/second

    water = sum(1 for e in elev if e <= 0)
    print(f'grid {N}x{N}: min {min(elev)} m, max {max(elev)} m, '
          f'{100 * water / len(elev):.0f}% at sea level', file=sys.stderr)

    out = {
        'v': 1,
        'lat0': round(lat0, 5), 'lon0': round(lon0, 5),
        'dlat': round(dlat, 7), 'dlon': round(dlon, 7),
        'ny': N, 'nx': N,
        'elev': elev,                          # int meters, row-major, row 0 = north
        'landmarks': LANDMARKS,
    }
    dest = Path(__file__).resolve().parent.parent / 'data' / 'wx3d' / 'terrain.json'
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(out, separators=(',', ':')), encoding='utf-8')
    print(f'wrote {dest} ({dest.stat().st_size / 1024:.0f} KB)', file=sys.stderr)


if __name__ == '__main__':
    main()
