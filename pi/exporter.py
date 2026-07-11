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
  v2/summary.json          available days + totals + freshness
  v2/days/YYYY-MM-DD.json  decimated per-day tracks (same point tuple as the
                           live API: [ts, lat, lon, alt, gs, on_ground])

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
PUSH = os.environ.get("KANP_EXPORT_PUSH", "1") == "1"

V2_DIR = os.path.join(EXPORT_DIR, "v2")
DAYS_DIR = os.path.join(V2_DIR, "days")


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
            for p in simplify_track(buf, SIMPLIFY_NM)
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
        "total_points": total,
        "points": kept,
        "tracks": tracks,
    }
    path = os.path.join(DAYS_DIR, f"{day_str}.json")
    with open(path, "w") as f:
        json.dump(out, f, separators=(",", ":"))
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

    # summary over everything on disk
    days = []
    for fname in sorted(os.listdir(DAYS_DIR)):
        if not fname.endswith(".json"):
            continue
        try:
            with open(os.path.join(DAYS_DIR, fname)) as f:
                d = json.load(f)
            days.append({
                "date": d["date"],
                "aircraft": len(d["tracks"]),
                "points": sum(len(t["points"]) for t in d["tracks"]),
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
    return 0


if __name__ == "__main__":
    sys.exit(main())
