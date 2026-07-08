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
import sqlite3
import subprocess
import sys

DB_PATH = os.environ.get("KANP_DB", "/var/lib/kanp/kanp.db")
EXPORT_DIR = os.environ.get("KANP_EXPORT_DIR", "/var/lib/kanp/traffic-data")
# Per-day point budget: each aircraft's fixes are uniformly decimated to keep a
# day under this many points. The resulting spacing is roughly
# total_aircraft_seconds / budget — independent of the poll rate — so it was the
# old, small 40k budget that made tracks coarse (~2 min between fixes on busy
# DC-airspace days), not the polling. 200k keeps busy days near ~25 s spacing in
# a few-MB file; quieter days stay at native resolution (stride 1).
MAX_PTS_PER_DAY = int(os.environ.get("KANP_EXPORT_MAX_PTS", "200000"))
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
    stride = max(1, -(-total // MAX_PTS_PER_DAY))

    rows = db.execute(
        """WITH f AS (
               SELECT ts, hex, flight, lat, lon, alt, gs, on_ground, military,
                      ROW_NUMBER() OVER (PARTITION BY hex ORDER BY ts) rn
               FROM positions WHERE ts >= ? AND ts < ?
           )
           SELECT f.*, a.reg, a.type, a.descr
           FROM f LEFT JOIN aircraft a ON a.hex = f.hex
           WHERE (f.rn - 1) % ? = 0
           ORDER BY f.hex, f.ts""",
        (start, end, stride),
    ).fetchall()

    tracks = {}
    for r in rows:
        t = tracks.get(r["hex"])
        if t is None:
            t = tracks[r["hex"]] = {
                "hex": r["hex"], "flight": r["flight"], "reg": r["reg"],
                "type": r["type"], "descr": r["descr"],
                "military": r["military"], "points": [],
            }
        if r["flight"]:
            t["flight"] = r["flight"]
        t["points"].append([
            r["ts"], round(r["lat"], 5), round(r["lon"], 5), r["alt"],
            round(r["gs"], 1) if r["gs"] is not None else None, r["on_ground"],
        ])

    out = {
        "date": day_str,
        "generated": int(datetime.datetime.now().timestamp()),
        "stride": stride,
        "total_points": total,
        "tracks": sorted(tracks.values(), key=lambda t: -len(t["points"])),
    }
    path = os.path.join(DAYS_DIR, f"{day_str}.json")
    with open(path, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    return {
        "date": day_str,
        "aircraft": len(tracks),
        "points": sum(len(t["points"]) for t in tracks.values()),
        "total_points": total,
    }


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
