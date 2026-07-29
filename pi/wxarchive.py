#!/usr/bin/env python3
"""KANP weather archiver.

Permanently archives the raw material of the DC weather story to the repo's
`weather-data` branch so discussion.html can read history from any device via
raw.githubusercontent.com (localStorage only remembers one browser):

  - every LWX Area Forecast Discussion issuance (full text — the NWS
    products API only keeps a few days; this keeps them all)
  - NWS daily-forecast snapshots for DC several times a day (what was
    *expected*, for drift + verification)
  - KDCA METARs per day (what actually *happened*)

Run hourly by kanp-wxarchive.timer. Stdlib + git CLI only.

One-time setup (as root) — a dedicated shallow clone, same PAT as the
traffic exporter (fine-grained, read/write Contents on this repo only):

  sudo -u kanp git clone --depth 1 \
      https://<TOKEN>@github.com/nuvig/nuvig.github.io.git /var/lib/kanp/weather-data

The script creates/checks out the orphan `weather-data` branch by itself on
first run. Without the clone in place it exits cleanly with a hint.

Output layout (branch weather-data):
  wx/index.json                     archive catalog + freshness
  wx/afd/YYYY/afd-YYYYMMDD-HHMM.json  one file per AFD issuance (UTC stamp)
  wx/forecast/YYYY-MM-DD.json       {date, snaps:[{t, days:{date:{hi,lo,pop,short}}}]}
  wx/obs/YYYY-MM-DD.json            {date, station, metars:[[t, raw], ...]}

History-bloat control: like the traffic exporter, the branch is kept at a
single commit — each push amends and force-pushes. The archive files
themselves accumulate forever; that is the point.
"""

import datetime
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

ARCHIVE_DIR = os.environ.get("KANP_WX_DIR", "/var/lib/kanp/weather-data")
OFFICE = os.environ.get("KANP_WX_OFFICE", "LWX")
OBS_STATION = os.environ.get("KANP_WX_OBS", "KDCA")
POINT = os.environ.get("KANP_WX_POINT", "38.8894,-77.0352")  # downtown DC
PUSH = os.environ.get("KANP_WX_PUSH", "1") == "1"

BRANCH = "weather-data"
NWS = "https://api.weather.gov"
WX = os.path.join(ARCHIVE_DIR, "wx")
AFD_DIR = os.path.join(WX, "afd")
FC_DIR = os.path.join(WX, "forecast")
OBS_DIR = os.path.join(WX, "obs")
# Keep at most ~9 forecast snapshots/day: skip if the last one is fresher.
SNAP_GAP_S = int(os.environ.get("KANP_WX_SNAP_GAP_S", "9000"))  # 2.5 h


def log(msg):
    print(msg, flush=True)


def fetch(url):
    req = urllib.request.Request(url, headers={
        "User-Agent": "kanp-wxarchive (jesselevine.net)",
        "Accept": "application/ld+json, application/geo+json, application/json",
    })
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def git(*args, check=True):
    return subprocess.run(
        ["git", "-C", ARCHIVE_DIR,
         "-c", "user.name=kanp-wxarchive",
         "-c", "user.email=kanp@localhost", *args],
        capture_output=True, text=True, check=check,
    )


def write_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f, separators=(",", ":"))
    os.replace(tmp, path)


def read_json(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return default


def ensure_branch():
    """Check out `weather-data`, creating it as an orphan on first run."""
    cur = git("rev-parse", "--abbrev-ref", "HEAD", check=False).stdout.strip()
    if cur == BRANCH:
        return
    git("fetch", "--depth", "1", "origin", BRANCH, check=False)
    if git("rev-parse", "--verify", f"origin/{BRANCH}", check=False).returncode == 0:
        git("checkout", "-B", BRANCH, f"origin/{BRANCH}")
    else:
        git("checkout", "--orphan", BRANCH)
        git("rm", "-rf", "-q", ".", check=False)   # clear the inherited index
        log(f"created orphan branch {BRANCH}")


def archive_afds():
    """One JSON file per AFD issuance; skips those already on disk."""
    data = fetch(f"{NWS}/products/types/AFD/locations/{OFFICE}")
    new = 0
    for item in data.get("@graph", []):
        iso, pid = item.get("issuanceTime"), item.get("@id")
        if not iso or not pid:
            continue
        t = datetime.datetime.fromisoformat(iso.replace("Z", "+00:00"))
        t_utc = t.astimezone(datetime.timezone.utc)
        rel = f"{t_utc:%Y}/afd-{t_utc:%Y%m%d-%H%M}.json"
        path = os.path.join(AFD_DIR, rel)
        if os.path.exists(path):
            continue
        product = fetch(pid)
        write_json(path, {
            "id": item.get("id"),
            "office": OFFICE,
            "issuanceTime": iso,
            "productText": product.get("productText", ""),
        })
        new += 1
        log(f"archived AFD {rel}")
    return new


def digest_periods(periods):
    """NWS forecast periods -> per-date {hi, lo, pop, short} (mirrors
    js/discussion.js loadDrift — keep the two in sync)."""
    days = {}
    for p in periods:
        date = p.get("startTime", "")[:10]
        if not date:
            continue
        d = days.setdefault(date, {"hi": None, "lo": None, "pop": None, "short": None})
        if p.get("isDaytime"):
            d["hi"] = p.get("temperature")
            d["short"] = p.get("shortForecast")
        else:
            d["lo"] = p.get("temperature")
            if d["short"] is None:
                d["short"] = p.get("shortForecast")
        pop = (p.get("probabilityOfPrecipitation") or {}).get("value")
        if pop is not None:
            d["pop"] = max(d["pop"] or 0, pop)
    return days


def snapshot_forecast():
    pt = fetch(f"{NWS}/points/{POINT}")
    fc = fetch(pt["properties"]["forecast"])
    days = digest_periods(fc["properties"].get("periods", []))
    if not days:
        return False
    now = datetime.datetime.now().astimezone()
    path = os.path.join(FC_DIR, f"{now:%Y-%m-%d}.json")
    doc = read_json(path, {"date": f"{now:%Y-%m-%d}", "snaps": []})
    snaps = doc["snaps"]
    if snaps and int(now.timestamp()) - snaps[-1]["t"] < SNAP_GAP_S:
        return False
    snaps.append({"t": int(now.timestamp()), "days": days})
    write_json(path, doc)
    log(f"forecast snapshot #{len(snaps)} for {doc['date']}")
    return True


def archive_obs():
    data = fetch(f"{NWS}/stations/{OBS_STATION}/observations?limit=72")
    by_day = {}
    for f in data.get("features", []):
        p = f.get("properties") or {}
        iso, raw = p.get("timestamp"), p.get("rawMessage")
        if not iso or not raw:
            continue
        t = datetime.datetime.fromisoformat(iso.replace("Z", "+00:00"))
        day = f"{t.astimezone():%Y-%m-%d}"
        by_day.setdefault(day, []).append([int(t.timestamp()), raw])
    changed = 0
    for day, metars in by_day.items():
        path = os.path.join(OBS_DIR, f"{day}.json")
        doc = read_json(path, {"date": day, "station": OBS_STATION, "metars": []})
        have = {m[0] for m in doc["metars"]}
        add = [m for m in metars if m[0] not in have]
        if not add:
            continue
        doc["metars"] = sorted(doc["metars"] + add)
        write_json(path, doc)
        changed += len(add)
    if changed:
        log(f"archived {changed} new METAR(s) from {OBS_STATION}")
    return changed


def build_index():
    afd = []
    for root, _dirs, files in os.walk(AFD_DIR):
        for fname in files:
            if not fname.startswith("afd-") or not fname.endswith(".json"):
                continue
            stamp = fname[4:-5]  # YYYYMMDD-HHMM (UTC)
            try:
                t = datetime.datetime.strptime(stamp, "%Y%m%d-%H%M").replace(
                    tzinfo=datetime.timezone.utc)
            except ValueError:
                continue
            rel = os.path.relpath(os.path.join(root, fname), WX)
            afd.append({"t": int(t.timestamp()), "p": rel})
    afd.sort(key=lambda a: -a["t"])
    listing = lambda d: sorted(
        f[:-5] for f in (os.listdir(d) if os.path.isdir(d) else [])
        if f.endswith(".json"))
    write_json(os.path.join(WX, "index.json"), {
        "updated": int(datetime.datetime.now().timestamp()),
        "office": OFFICE,
        "station": OBS_STATION,
        "afd": afd,
        "forecast_days": listing(FC_DIR),
        "obs_days": listing(OBS_DIR),
    })
    return len(afd)


def main():
    if not os.path.isdir(os.path.join(ARCHIVE_DIR, ".git")):
        log(f"archive dir {ARCHIVE_DIR} is not a git clone — skipping.\n"
            "One-time setup:\n"
            "  sudo -u kanp git clone --depth 1 "
            f"https://<TOKEN>@github.com/nuvig/nuvig.github.io.git {ARCHIVE_DIR}")
        return 0

    ensure_branch()

    problems = 0
    for step in (archive_afds, snapshot_forecast, archive_obs):
        try:
            step()
        except (urllib.error.URLError, OSError, KeyError, json.JSONDecodeError) as e:
            log(f"{step.__name__}: {e}")
            problems += 1
    n = build_index()
    log(f"index: {n} AFD issuance(s) archived")

    if not PUSH:
        log("KANP_WX_PUSH=0 — skipping git push")
        return 0

    git("add", "-A", "wx")
    if not git("status", "--porcelain").stdout.strip():
        log("no changes to publish")
        return 0 if problems == 0 else 1

    # keep the branch at one commit: amend if we authored the tip, else new
    last_author = git("log", "-1", "--format=%an", check=False).stdout.strip()
    msg = f"weather archive {datetime.datetime.now():%Y-%m-%d %H:%M %Z}"
    if last_author == "kanp-wxarchive":
        git("commit", "--amend", "-m", msg)
    else:
        git("commit", "-m", msg)

    r = git("push", "--force", "-u", "origin", BRANCH, check=False)
    if r.returncode != 0:
        log(f"push failed:\n{r.stderr.strip()}")
        return 1
    log("published weather archive")
    return 0 if problems == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
