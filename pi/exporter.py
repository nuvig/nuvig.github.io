#!/usr/bin/env python3
"""KANP traffic exporter.

Publishes the collector's SQLite data as per-day JSON snapshot files on the
repo's `traffic-data` branch so the HTTPS site (jesselevine.net) can read
history remotely via raw.githubusercontent.com — no tunnel required.

Run hourly by kanp-export.timer. Stdlib + git CLI only.

One-time setup (as root):
  sudo -u kanp git clone --branch traffic-data \
      https://<TOKEN>@github.com/nuvig/nuvig.github.io.git /var/lib/kanp/traffic-data

where <TOKEN> is a fine-grained PAT with read/write Contents access to this
repo only. Without that clone in place this script exits cleanly with a hint.

Output layout (branch traffic-data):
  v2/summary.json          available days + totals + freshness (each day entry
                           carries "stats": 1 once its stats sidecar exists)
  v2/days/YYYY-MM-DD.json  decimated per-day tracks (same point tuple as the
                           live API: [ts, lat, lon, alt, gs, on_ground])
  v2/stats/YYYY-MM-DD.json per-day aggregate stats sidecar (a few hundred KB
                           at most vs ~10 MB for the day file). Lets the site
                           build the Traffic Study / heat-grid aggregates
                           without downloading raw tracks — the 60-day
                           all-time grid used to pull every day file
                           (~400 MB). Consumed by js/kanp-static.js
                           (statsGetStats / getFieldGrid) — change the two
                           together. Shape (all hours are Pi-local, matching
                           the day-file boundaries):
                             { date, generated, v,
                               totals: {aircraft, samples},
                               alt_hist:    [[bucket_ft, samples], ...],
                               alt_hist_ga: [[bucket_ft, samples], ...],
                               aircraft: [ per-aircraft record ] }
                           Per-aircraft record (absent keys mean null/0):
                             x hex · r reg · t type · de descr · m military
                             cs callsign · n samples · f/l first/last ts
                             a0/a1 min/max airborne alt · d0 min dist (nm)
                             h  {hour: samples} for every fix
                             fh [hours] with fixes inside the field-grid
                                gates, present only when the aircraft made
                                field contact (OPS gates) — drives the
                                "KANP traffic only" grid

History-bloat control: the branch is kept at a single commit — each push
amends and force-pushes, so the repo only ever stores the current snapshot.
"""

import datetime
import json
import os
import re
import sqlite3
import subprocess
import sys
import urllib.error
import urllib.request

import gitutil
from trackutil import simplify_track

DB_PATH = os.environ.get("KANP_DB", "/var/lib/kanp/kanp.db")
EXPORT_DIR = os.environ.get("KANP_EXPORT_DIR", "/var/lib/kanp/traffic-data")
# Website visitor stats (GitHub Pages traffic), accumulated locally — GitHub's
# API only keeps 14 days, so each hourly run merges the current window in.
# Served by server.py at /api/site-traffic. Stays on the Pi; never published.
SITE_TRAFFIC_PATH = os.environ.get(
    "KANP_SITE_TRAFFIC", os.path.join(os.path.dirname(DB_PATH), "site-traffic.json"))
# Track simplification tolerance (nm) — see trackutil.simplify_track. Fixes are
# dropped only where they don't change a track's shape, so turns and pattern
# work stay crisp (no corner-cutting) while straight cruise legs collapse to a
# couple of points. ~0.03 nm (~180 ft) is finer than ADS-B noise → visually
# lossless; raise it to shrink files further, lower it for even more fidelity.
SIMPLIFY_NM = float(os.environ.get("KANP_SIMPLIFY_NM", "0.03"))
# Inside the collector's near-poll ring (KANP_NEAR_RADIUS_NM) the tolerance is
# finer — 0 publishes every fix. Those 1 Hz fixes are why the near poll exists,
# and at 0.03 nm a straight downwind collapses to its endpoints no matter how
# fast it was sampled. Costs a few percent on the day file. Mirrors server.py.
NEAR_RADIUS_NM = float(os.environ.get("KANP_NEAR_RADIUS_NM", "5"))
SIMPLIFY_NEAR_NM = float(os.environ.get("KANP_SIMPLIFY_NEAR_NM", "0"))
PUSH = os.environ.get("KANP_EXPORT_PUSH", "1") == "1"
# How often to prune/repack the export clone (see gitutil.maintain). Lower it
# if the clone still grows between runs; 0 disables collection entirely.
GC_INTERVAL_S = int(os.environ.get("KANP_GC_INTERVAL_S", gitutil.DEFAULT_INTERVAL_S))

V2_DIR = os.path.join(EXPORT_DIR, "v2")
DAYS_DIR = os.path.join(V2_DIR, "days")
STATS_DIR = os.path.join(V2_DIR, "stats")

# --- stats-sidecar constants (mirrors of the site's JS — keep in sync) ------
# Field center, as the collector uses (env mirror of SITE.tracker.lat/lon).
FIELD_LAT = float(os.environ.get("KANP_LAT", "38.9422"))
FIELD_LON = float(os.environ.get("KANP_LON", "-76.5684"))
NEAR = (FIELD_LAT, FIELD_LON, NEAR_RADIUS_NM, SIMPLIFY_NEAR_NM)
# "At the field" ops gates — mirrors SITE.tracker.opsGates (js/site-config.js).
OPS_NEAR_NM = 0.8
OPS_LOW_FT = 600
# Point gates for the "KANP traffic only" grid — mirrors the getTracks params
# in KANP.kanpTrafficGrid (js/kanp.js): max_dist 4 nm, max_alt 3,500 ft.
GRID_MAX_NM = 4.0
GRID_MAX_FT = 3500
# Non-GA ICAO type designators, plus the A3../B7.. families matched by prefix.
# Mirrors AIRLINER_TYPES in pi/server.py and KANP.AIRLINER_TYPES in js/kanp.js.
AIRLINER_TYPES = frozenset([
    "A19N", "A20N", "A21N", "B37M", "B38M", "B39M", "B3XM",
    "CRJ1", "CRJ2", "CRJ7", "CRJ9", "CRJX", "BCS1", "BCS3",
    "E135", "E145", "E170", "E75L", "E75S", "E190", "E195", "E290", "E295",
    "RJ1H", "RJ85", "RJ70", "B461", "B462", "B463", "F70", "F100",
    "AT43", "AT44", "AT45", "AT46", "AT72", "AT73", "AT75", "AT76",
    "DH8A", "DH8B", "DH8C", "DH8D", "SF34", "SB20", "D328", "J328",
    "MD11", "MD81", "MD82", "MD83", "MD87", "MD88", "MD90",
    "DC10", "DC93", "DC94",
])


def log(msg):
    print(msg, flush=True)


def git(*args, check=True):
    return subprocess.run(
        ["git", "-C", EXPORT_DIR,
         "-c", "user.name=kanp-exporter",
         "-c", "user.email=kanp@localhost", *args],
        capture_output=True, text=True, check=check,
    )


def day_bounds(day_str):
    """Local-midnight epoch bounds for a YYYY-MM-DD string."""
    d = datetime.datetime.strptime(day_str, "%Y-%m-%d")
    start = d.astimezone()  # midnight local -> aware
    end = (d + datetime.timedelta(days=1)).astimezone()
    return int(start.timestamp()), int(end.timestamp())


def is_ga(ac_type, military):
    """Mirror of KANP.isGA (js/kanp.js) / the ga filter in pi/server.py."""
    if military:
        return False
    t = (ac_type or "").upper().strip()
    if not t:
        return True                     # untyped -> assume light GA
    if len(t) == 4 and (t.startswith("A3") or t.startswith("B7")):
        return False                    # Airbus/Boeing airliner families
    return t not in AIRLINER_TYPES


def dist_nm(lat, lon):
    """Great-circle distance from the field, nm (mirror of KANP.distNm)."""
    import math
    r = math.pi / 180
    dlat = (lat - FIELD_LAT) * r
    dlon = (lon - FIELD_LON) * r
    a = (math.sin(dlat / 2) ** 2
         + math.cos(FIELD_LAT * r) * math.cos(lat * r) * math.sin(dlon / 2) ** 2)
    return 2 * 3440.065 * math.asin(math.sqrt(a))


def stats_for_day(day):
    """Aggregate a parsed day JSON into the small stats sidecar (see module
    docstring for the shape). Point tuple: [ts, lat, lon, alt, gs, on_ground].
    Hour buckets use this machine's local time, same as the day boundaries."""
    aircraft = []
    alt_hist = {}
    alt_hist_ga = {}
    total_samples = 0

    for t in day["tracks"]:
        pts = t.get("points") or []
        if not pts:
            continue
        ga = is_ga(t.get("type"), t.get("military"))
        hours = {}
        fhours = set()
        contact = False
        a0 = a1 = d0 = None
        for ts, lat, lon, alt, _gs, og in pts:
            hr = datetime.datetime.fromtimestamp(ts).hour
            hours[hr] = hours.get(hr, 0) + 1
            d = dist_nm(lat, lon)
            if d0 is None or d < d0:
                d0 = d
            if not og and alt is not None:
                a0 = alt if a0 is None else min(a0, alt)
                a1 = alt if a1 is None else max(a1, alt)
                if alt >= 0:
                    bucket = int(alt // 500) * 500
                    alt_hist[bucket] = alt_hist.get(bucket, 0) + 1
                    if ga:
                        alt_hist_ga[bucket] = alt_hist_ga.get(bucket, 0) + 1
            # field-grid gates (mirror kanpTrafficGrid: dist<=4, alt<=3500 or
            # unknown), then the tighter ops gates decide "field contact"
            if d <= GRID_MAX_NM and (alt is None or alt <= GRID_MAX_FT):
                fhours.add(hr)
                if (og == 1 or (alt is not None and alt <= OPS_LOW_FT)) \
                        and d <= OPS_NEAR_NM:
                    contact = True
        total_samples += len(pts)

        rec = {"x": t["hex"], "n": len(pts),
               "f": pts[0][0], "l": pts[-1][0],
               "h": {str(h): c for h, c in sorted(hours.items())}}
        if t.get("reg"):
            rec["r"] = t["reg"]
        if t.get("type"):
            rec["t"] = t["type"]
        if t.get("descr"):
            rec["de"] = t["descr"]
        if t.get("military"):
            rec["m"] = 1
        if t.get("flight"):
            rec["cs"] = t["flight"]
        if a0 is not None:
            rec["a0"], rec["a1"] = a0, a1
        if d0 is not None:
            rec["d0"] = round(d0, 1)
        if contact:
            rec["fh"] = sorted(fhours)
        aircraft.append(rec)

    return {
        "date": day["date"],
        "generated": int(datetime.datetime.now().timestamp()),
        "v": 1,
        "totals": {"aircraft": len(aircraft), "samples": total_samples},
        "alt_hist": sorted(alt_hist.items()),
        "alt_hist_ga": sorted(alt_hist_ga.items()),
        "aircraft": aircraft,
    }


def write_stats(day):
    os.makedirs(STATS_DIR, exist_ok=True)
    path = os.path.join(STATS_DIR, f"{day['date']}.json")
    with open(path, "w") as f:
        json.dump(stats_for_day(day), f, separators=(",", ":"))


def export_day(db, day_str):
    start, end = day_bounds(day_str)
    total = db.execute(
        "SELECT COUNT(*) FROM positions WHERE ts >= ? AND ts < ?", (start, end)
    ).fetchone()[0]
    if total == 0:
        return None

    # Stream rows in (hex, ts) order and simplify each aircraft's track as its
    # run ends — bounds memory to a single aircraft's raw fixes.
    rows = db.execute(
        """SELECT f.ts, f.hex, f.flight, f.lat, f.lon, f.alt, f.gs, f.on_ground,
                  f.military, a.reg, a.type, a.descr
           FROM positions f LEFT JOIN aircraft a ON a.hex = f.hex
           WHERE f.ts >= ? AND f.ts < ?
           ORDER BY f.hex, f.ts""",
        (start, end),
    )

    tracks = []
    kept = 0
    cur = None      # current track's metadata dict
    buf = None      # current aircraft's raw [ts,lat,lon,alt,gs,og] fixes

    def flush():
        nonlocal kept
        if cur is None:
            return
        cur["points"] = [
            [p[0], round(p[1], 5), round(p[2], 5), p[3],
             round(p[4], 1) if p[4] is not None else None, p[5]]
            for p in simplify_track(buf, SIMPLIFY_NM, NEAR)
        ]
        kept += len(cur["points"])
        tracks.append(cur)

    for r in rows:
        if cur is None or r["hex"] != cur["hex"]:
            flush()
            cur = {"hex": r["hex"], "flight": r["flight"], "reg": r["reg"],
                   "type": r["type"], "descr": r["descr"],
                   "military": r["military"], "points": []}
            buf = []
        if r["flight"]:
            cur["flight"] = r["flight"]
        buf.append([r["ts"], r["lat"], r["lon"], r["alt"], r["gs"], r["on_ground"]])
    flush()

    tracks.sort(key=lambda t: -len(t["points"]))
    out = {
        "date": day_str,
        "generated": int(datetime.datetime.now().timestamp()),
        "simplify_nm": SIMPLIFY_NM,
        "simplify_near_nm": SIMPLIFY_NEAR_NM,
        "near_nm": NEAR_RADIUS_NM,
        "total_points": total,
        "points": kept,
        "tracks": tracks,
    }
    path = os.path.join(DAYS_DIR, f"{day_str}.json")
    with open(path, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    write_stats(out)
    return {
        "date": day_str,
        "aircraft": len(tracks),
        "points": kept,
        "total_points": total,
    }


def update_site_traffic():
    """Merge GitHub Pages visitor stats into the local history file.

    Uses the PAT embedded in the export clone's remote URL. The traffic API
    needs the token to have repository "Administration: read" permission — if
    it only has Contents access GitHub answers 403, which is logged as a hint
    and skipped (the snapshot export is unaffected).
    """
    url = git("config", "remote.origin.url", check=False).stdout.strip()
    m = re.match(r"https://([^@/]+)@github\.com/([^/]+/[^/.]+)", url)
    if not m:
        log("site-traffic: no token in the export remote URL — skipping")
        return
    token, repo = m.group(1), m.group(2)
    if ":" in token:                       # user:token@ form
        token = token.split(":", 1)[1]

    try:
        with open(SITE_TRAFFIC_PATH) as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        data = {"views": {}, "clones": {}, "paths": []}

    def gh(path):
        req = urllib.request.Request(
            f"https://api.github.com/repos/{repo}/traffic/{path}",
            headers={"Authorization": f"Bearer {token}",
                     "Accept": "application/vnd.github+json",
                     "User-Agent": "kanp-exporter"})
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.load(r)

    try:
        for key in ("views", "clones"):
            for row in gh(key).get(key, []):
                data.setdefault(key, {})[row["timestamp"][:10]] = {
                    "count": row["count"], "uniques": row["uniques"]}
        data["paths"] = gh("popular/paths")
        data["updated"] = int(datetime.datetime.now().timestamp())
    except urllib.error.HTTPError as e:
        if e.code == 403:
            log("site-traffic: 403 — give the exporter PAT 'Administration: "
                "read' repository permission to read visitor stats")
        else:
            log(f"site-traffic: GitHub API error {e.code}")
        return
    except OSError as e:
        log(f"site-traffic: {e}")
        return

    tmp = SITE_TRAFFIC_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, separators=(",", ":"))
    os.replace(tmp, SITE_TRAFFIC_PATH)
    week = sorted(data["views"])[-7:]
    views = sum(data["views"][d]["count"] for d in week)
    log(f"site-traffic: updated ({views} views over last {len(week)} day(s))")


def main():
    if not os.path.isdir(os.path.join(EXPORT_DIR, ".git")):
        log(f"export dir {EXPORT_DIR} is not a git clone — skipping.\n"
            "One-time setup:\n"
            "  sudo -u kanp git clone --branch traffic-data "
            f"https://<TOKEN>@github.com/nuvig/nuvig.github.io.git {EXPORT_DIR}")
        return 0

    os.makedirs(DAYS_DIR, exist_ok=True)

    db = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True, timeout=30)
    db.row_factory = sqlite3.Row

    db_days = [r[0] for r in db.execute(
        "SELECT DISTINCT date(ts,'unixepoch','localtime') FROM positions ORDER BY 1")]
    if not db_days:
        log("database has no positions yet — nothing to export")
        return 0

    have = {f[:-5] for f in os.listdir(DAYS_DIR) if f.endswith(".json")}
    today = datetime.date.today().isoformat()
    yesterday = (datetime.date.today() - datetime.timedelta(days=1)).isoformat()
    # first run backfills every day in the DB; after that only today/yesterday
    # can gain data, so only they are re-exported
    todo = [d for d in db_days if d not in have or d in (today, yesterday)]

    exported = []
    for d in todo:
        info = export_day(db, d)
        if info:
            exported.append(info)
            log(f"exported {d}: {info['aircraft']} aircraft, "
                f"{info['points']}/{info['total_points']} points")

    # summary over everything on disk; backfill any missing stats sidecar from
    # the day file already on disk (one-time cost when this feature first ships)
    days = []
    for fname in sorted(os.listdir(DAYS_DIR)):
        if not fname.endswith(".json"):
            continue
        try:
            with open(os.path.join(DAYS_DIR, fname)) as f:
                d = json.load(f)
            stats_path = os.path.join(STATS_DIR, fname)
            if not os.path.exists(stats_path):
                write_stats(d)
                log(f"backfilled stats for {d['date']}")
            days.append({
                "date": d["date"],
                "aircraft": len(d["tracks"]),
                "points": sum(len(t["points"]) for t in d["tracks"]),
                "stats": 1,
            })
        except (json.JSONDecodeError, KeyError):
            continue

    newest = db.execute("SELECT MAX(ts) FROM positions").fetchone()[0]
    with open(os.path.join(V2_DIR, "summary.json"), "w") as f:
        json.dump({
            "generated": int(datetime.datetime.now().timestamp()),
            "newest_position": newest,
            "days": days,
        }, f, separators=(",", ":"))
    db.close()

    update_site_traffic()

    if not exported and not todo:
        log("nothing new to export")

    if not PUSH:
        log("KANP_EXPORT_PUSH=0 — skipping git push")
        return 0

    git("add", "-A")
    if not git("status", "--porcelain").stdout.strip():
        log("no changes to publish")
        return 0

    # keep the branch at one commit: amend if we authored the tip, else new
    last_author = git("log", "-1", "--format=%an", check=False).stdout.strip()
    msg = f"traffic snapshot {datetime.datetime.now():%Y-%m-%d %H:%M %Z}"
    if last_author == "kanp-exporter":
        git("commit", "--amend", "-m", msg)
    else:
        git("commit", "-m", msg)

    r = git("push", "--force", "origin", "traffic-data", check=False)
    if r.returncode != 0:
        log(f"push failed:\n{r.stderr.strip()}")
        return 1
    log(f"published {len(days)} day file(s) to traffic-data")
    # Amending hourly orphans the previous commit's blobs — reclaim them, or
    # .git grows without bound (it reached 5.7 GB against 301 MB of data).
    gitutil.maintain(EXPORT_DIR, log, GC_INTERVAL_S)
    return 0


if __name__ == "__main__":
    sys.exit(main())
