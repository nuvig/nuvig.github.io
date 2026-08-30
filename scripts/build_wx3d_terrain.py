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

# Mirrors js/wx3d.js (SITE.airport + the DOMAINS table there). Run once with
# no args for the local box and once with --wide for the multi-state box.
WIDE = '--wide' in sys.argv
CENTER_LAT, CENTER_LON = 38.9429, -76.5684
SPAN_LAT, SPAN_LON = (10.8, 13.9) if WIDE else (2.0, 2.5)
N = 160 if WIDE else 192     # grid points per side; row 0 = north edge
# ned10m stops at the border; the wide box clips Ontario, so it uses srtm90m
# (global to 60°N). SRTM reports lakes at their SURFACE height, which breaks
# the water = sea-level rule — flatten_lakes() handles that below.
DATASET = 'srtm90m' if WIDE else 'ned10m'
OUT_NAME = 'terrain-wide.json' if WIDE else 'terrain.json'
API = 'https://api.opentopodata.org/v1/' + DATASET
CHUNK = 100                  # the API's per-request location limit
UA = 'jesselevine.net wx3d terrain build (one-time, stdlib urllib)'

# Landmarks the page draws over the map. kind: city / apt / bridge / peak.
# Airports here are the majors NOT already in SITE.weather.nearbyAirports.
LANDMARKS_WIDE = [
    {'kind': 'city', 'name': 'New York', 'lat': 40.7128, 'lon': -74.0060},
    {'kind': 'city', 'name': 'Boston', 'lat': 42.3601, 'lon': -71.0589},
    {'kind': 'city', 'name': 'Philadelphia', 'lat': 39.9526, 'lon': -75.1652},
    {'kind': 'city', 'name': 'Pittsburgh', 'lat': 40.4406, 'lon': -79.9959},
    {'kind': 'city', 'name': 'Cleveland', 'lat': 41.4993, 'lon': -81.6944},
    {'kind': 'city', 'name': 'Detroit', 'lat': 42.3314, 'lon': -83.0458},
    {'kind': 'city', 'name': 'Toronto', 'lat': 43.6532, 'lon': -79.3832},
    {'kind': 'city', 'name': 'Buffalo', 'lat': 42.8864, 'lon': -78.8784},
    {'kind': 'city', 'name': 'Columbus', 'lat': 39.9612, 'lon': -82.9988},
    {'kind': 'city', 'name': 'Charlotte', 'lat': 35.2271, 'lon': -80.8431},
    {'kind': 'city', 'name': 'Raleigh', 'lat': 35.7796, 'lon': -78.6382},
    {'kind': 'city', 'name': 'Norfolk', 'lat': 36.8508, 'lon': -76.2859},
    {'kind': 'city', 'name': 'Richmond', 'lat': 37.5407, 'lon': -77.4360},
    {'kind': 'city', 'name': 'Washington', 'lat': 38.9047, 'lon': -77.0164},
    {'kind': 'city', 'name': 'Baltimore', 'lat': 39.2904, 'lon': -76.6122},
    {'kind': 'peak', 'name': 'Mt Mitchell', 'lat': 35.7650, 'lon': -82.2652},
    {'kind': 'peak', 'name': 'Spruce Knob', 'lat': 38.6998, 'lon': -79.5326},
    {'kind': 'peak', 'name': 'Mt Marcy', 'lat': 44.1126, 'lon': -73.9235},
    {'kind': 'peak', 'name': 'Mt Washington', 'lat': 44.2706, 'lon': -71.3033},
]
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


def flatten_lakes(elev, n, min_cells=35):
    """Zero out large flat above-sea-level regions (lake surfaces).

    SRTM reports a lake at its surface elevation (Lake Ontario ~74 m), so
    the page's water rule (elevation <= ~0) misses it. A connected region
    that stays within +/-1 m of its seed and covers >= min_cells cells
    (~2,000 km2 at the wide grid's spacing) is a lake surface: set it to 0.
    Sea-level cells are already water and are skipped.
    """
    seen = bytearray(n * n)
    lakes = 0
    for start in range(n * n):
        if seen[start] or elev[start] <= 0:
            continue
        seed = elev[start]
        stack = [start]
        seen[start] = 1
        region = []
        while stack:
            j = stack.pop()
            region.append(j)
            y, x = divmod(j, n)
            for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                yy, xx = y + dy, x + dx
                if 0 <= yy < n and 0 <= xx < n:
                    jj = yy * n + xx
                    if not seen[jj] and abs(elev[jj] - seed) <= 1:
                        seen[jj] = 1
                        stack.append(jj)
        if len(region) >= min_cells:
            lakes += 1
            for j in region:
                elev[j] = 0
    print(f'flattened {lakes} lake surface(s)', file=sys.stderr)


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

    if WIDE:
        flatten_lakes(elev, N)
    water = sum(1 for e in elev if e <= 0)
    print(f'grid {N}x{N}: min {min(elev)} m, max {max(elev)} m, '
          f'{100 * water / len(elev):.0f}% at sea level', file=sys.stderr)

    out = {
        'v': 1,
        'lat0': round(lat0, 5), 'lon0': round(lon0, 5),
        'dlat': round(dlat, 7), 'dlon': round(dlon, 7),
        'ny': N, 'nx': N,
        'elev': elev,                          # int meters, row-major, row 0 = north
        'landmarks': LANDMARKS_WIDE if WIDE else LANDMARKS,
    }
    dest = Path(__file__).resolve().parent.parent / 'data' / 'wx3d' / OUT_NAME
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(out, separators=(',', ':')), encoding='utf-8')
    print(f'wrote {dest} ({dest.stat().st_size / 1024:.0f} KB)', file=sys.stderr)


if __name__ == '__main__':
    main()
