#!/usr/bin/env python3
"""The Air Above — hourly Open-Meteo snapshot (stdlib only).

wx3d.html used to call Open-Meteo from every visitor's browser: one 25-column
grid, one 49-column grid and a full column at the center, per page load. Open-
Meteo weights a request by locations x variables x range, so a handful of
reloads was enough to earn an HTTP 429 and an empty volume. This script does
those calls **once an hour from a GitHub Actions runner** and publishes the
result; the page reads the published files and only falls back to calling
Open-Meteo itself when the snapshot is missing or hours stale.

Run by .github/workflows/wx3dsnap.yml, which publishes whatever lands in the
output directory to the `wx3d-data` branch as a single force-pushed commit —
the same "no history to accumulate" trick pi/exporter.py uses for tracker
snapshots, because ~900 KB an hour on main would dwarf everything else in the
repo. Nothing here touches the Pi; like the weather archive, this is
GitHub-side only.

Output (one flat directory, published at the root of `wx3d-data`):
  index.json    {t, files:[{name, t, bytes}], center, note}
  local.json    the 5x5 box  — {t, domain, gn, center, span, times, hourly[25]}
  wide.json     the 7x7 box  — same shape, hourly[49]
  center.json   the full-fidelity column at the center — {t, times, hourly}

`hourly` is exactly what Open-Meteo returned (one object per requested
location, in request order, each keyed by variable name) with the numbers
rounded, so js/wx3d.js consumes a snapshot and a live response through the
same accessor. **The domain geometry, the level list and the variable list
below mirror DOMAINS / LEVELS / gridUrl() / centerUrl() in js/wx3d.js — change
the two together**, or the page will reject the snapshot as not built for the
box it is drawing (it validates gn, span and center, exactly like the terrain
files).

  python3 scripts/wx3dsnap.py --out snap      # write the four files
  python3 scripts/wx3dsnap.py --selftest      # offline checks, no network
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

API = "https://api.open-meteo.com/v1/forecast"

# Mirrors SITE.weather.wx3d in js/site-config.js (the volume's center).
CENTER_LAT = float(os.environ.get("WX3D_LAT", "38.8521"))
CENTER_LON = float(os.environ.get("WX3D_LON", "-77.0377"))

# Mirrors LEVELS in js/wx3d.js.
LEVELS = [1000, 925, 850, 700, 600, 500, 400, 300, 250, 200]

# Mirrors DOMAINS in js/wx3d.js (gn = columns per side, spans in degrees).
# `rh` = include per-level relative humidity, the cloud-cover fallback the
# local box carries and the wide box deliberately does not.
DOMAINS = {
    "local": {"gn": 5, "span_lat": 2.0, "span_lon": 2.5, "rh": True},
    "wide": {"gn": 7, "span_lat": 10.8, "span_lon": 13.9, "rh": False},
}

FORECAST_DAYS = 3
MODEL = "gfs_seamless"
TIMEOUT = 60

# How much precision each variable keeps. Everything unlisted becomes an int:
# a cloud cover of 47.31 % and a wind direction of 213.7° are false precision,
# and trimming them is most of the file size.
ROUND = {
    "precipitation": 2,
    "wind_speed": 1,
    "temperature": 1,
    "dew_point": 1,
    "surface_pressure": 1,
}


def round_for(name, value):
    if value is None:
        return None
    for prefix, digits in ROUND.items():
        if name.startswith(prefix):
            return round(float(value), digits)
    return int(round(float(value)))


def grid_points(d):
    """The domain's lat/lon lists, in the same request order as wx3d.js."""
    lat0 = CENTER_LAT + d["span_lat"] / 2
    lon0 = CENTER_LON - d["span_lon"] / 2
    lats, lons = [], []
    for iy in range(d["gn"]):
        for ix in range(d["gn"]):
            lats.append(round(lat0 - iy * d["span_lat"] / (d["gn"] - 1), 3))
            lons.append(round(lon0 + ix * d["span_lon"] / (d["gn"] - 1), 3))
    return lats, lons


def grid_vars(d):
    v = []
    for L in LEVELS:
        v += [f"cloud_cover_{L}hPa", f"wind_speed_{L}hPa", f"wind_direction_{L}hPa"]
        if d["rh"]:
            v.append(f"relative_humidity_{L}hPa")
    v += ["precipitation", "freezing_level_height", "cape",
          "wind_speed_10m", "wind_direction_10m"]
    return v


def center_vars():
    v = []
    for L in LEVELS:
        v += [f"temperature_{L}hPa", f"relative_humidity_{L}hPa",
              f"cloud_cover_{L}hPa", f"wind_speed_{L}hPa",
              f"wind_direction_{L}hPa", f"geopotential_height_{L}hPa"]
    v += ["temperature_2m", "dew_point_2m", "surface_pressure",
          "wind_speed_10m", "wind_direction_10m", "precipitation",
          "precipitation_probability", "cape", "freezing_level_height"]
    return v


def build_url(lats, lons, variables):
    return (f"{API}?latitude=" + ",".join(str(x) for x in lats) +
            "&longitude=" + ",".join(str(x) for x in lons) +
            "&hourly=" + ",".join(variables) +
            f"&models={MODEL}&windspeed_unit=kn&timezone=UTC"
            f"&forecast_days={FORECAST_DAYS}")


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "jesselevine.net wx3d snapshot"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return json.loads(r.read().decode("utf-8"))


def trim(hourly, variables):
    """One location's `hourly` block: keep time + the requested variables, rounded."""
    out = {}
    for name in variables:
        series = hourly.get(name)
        if series is None:
            continue
        out[name] = [round_for(name, v) for v in series]
    return out


def snap_domain(key):
    d = DOMAINS[key]
    lats, lons = grid_points(d)
    variables = grid_vars(d)
    raw = fetch(build_url(lats, lons, variables))
    blocks = raw if isinstance(raw, list) else [raw]
    if len(blocks) != d["gn"] ** 2:
        raise SystemExit(f"{key}: expected {d['gn'] ** 2} locations, got {len(blocks)}")
    return {
        "t": int(time.time()),
        "domain": key,
        "gn": d["gn"],
        "center": [CENTER_LAT, CENTER_LON],
        "span": [d["span_lat"], d["span_lon"]],
        "model": MODEL,
        "times": blocks[0]["hourly"]["time"],
        "hourly": [trim(b["hourly"], variables) for b in blocks],
    }


def snap_center():
    variables = center_vars()
    raw = fetch(build_url([CENTER_LAT], [CENTER_LON], variables))
    block = raw[0] if isinstance(raw, list) else raw
    return {
        "t": int(time.time()),
        "center": [CENTER_LAT, CENTER_LON],
        "model": MODEL,
        "times": block["hourly"]["time"],
        "hourly": trim(block["hourly"], variables),
    }


def write(out_dir, name, obj):
    path = os.path.join(out_dir, name)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, separators=(",", ":"))
    size = os.path.getsize(path)
    print(f"  {name:12s} {size / 1024:7.0f} KB")
    return size


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", default="snap", help="output directory (created)")
    ap.add_argument("--selftest", action="store_true", help="offline checks, no network")
    args = ap.parse_args()

    if args.selftest:
        return selftest()

    os.makedirs(args.out, exist_ok=True)
    now = int(time.time())
    files = []
    for name, obj in (("local.json", snap_domain("local")),
                      ("wide.json", snap_domain("wide")),
                      ("center.json", snap_center())):
        files.append({"name": name, "t": obj["t"], "bytes": write(args.out, name, obj)})

    write(args.out, "index.json", {
        "t": now,
        "center": [CENTER_LAT, CENTER_LON],
        "model": MODEL,
        "files": files,
        "note": ("Hourly Open-Meteo snapshot for wx3d.html (The Air Above), so the "
                 "page does not call the API from every visitor's browser. Built by "
                 "scripts/wx3dsnap.py; shape documented there."),
    })
    return 0


def selftest():
    ok = True

    def check(label, cond):
        nonlocal ok
        print(("  ok   " if cond else "  FAIL ") + label)
        ok = ok and cond

    lats, lons = grid_points(DOMAINS["local"])
    check("local grid is 25 points", len(lats) == 25 and len(lons) == 25)
    # points are emitted at 3 dp (same as wx3d.js gridUrl), so the centroid
    # can sit a ten-thousandth of a degree — about 10 m — off the center
    check("local grid is centered", abs((min(lats) + max(lats)) / 2 - CENTER_LAT) < 1e-3
          and abs((min(lons) + max(lons)) / 2 - CENTER_LON) < 1e-3)
    check("local grid spans 2.0 x 2.5 deg",
          abs((max(lats) - min(lats)) - 2.0) < 1e-6 and abs((max(lons) - min(lons)) - 2.5) < 1e-6)
    check("first point is the NW corner", lats[0] == max(lats) and lons[0] == min(lons))

    wlats, _ = grid_points(DOMAINS["wide"])
    check("wide grid is 49 points", len(wlats) == 49)

    v = grid_vars(DOMAINS["local"])
    check("local asks for RH (cloud fallback)", "relative_humidity_850hPa" in v)
    check("wide skips RH", "relative_humidity_850hPa" not in grid_vars(DOMAINS["wide"]))
    check("every level is requested", all(f"cloud_cover_{L}hPa" in v for L in LEVELS))
    check("center adds geopotential heights", "geopotential_height_500hPa" in center_vars())

    check("cloud cover rounds to int", round_for("cloud_cover_850hPa", 47.31) == 47)
    check("direction rounds to int", round_for("wind_direction_10m", 213.7) == 214)
    check("wind speed keeps a decimal", round_for("wind_speed_850hPa", 12.34) == 12.3)
    check("precip keeps two", round_for("precipitation", 0.4567) == 0.46)
    check("null stays null", round_for("cape", None) is None)

    trimmed = trim({"time": ["x"], "cape": [1.7, None], "junk": [1]}, ["cape"])
    check("trim drops unrequested keys", list(trimmed) == ["cape"])
    check("trim rounds in place", trimmed["cape"] == [2, None])

    url = build_url([1.5], [-2.5], ["cape"])
    check("url carries the model", f"models={MODEL}" in url)
    check("url asks for knots", "windspeed_unit=kn" in url)
    check("url is UTC", "timezone=UTC" in url)
    print("selftest:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
