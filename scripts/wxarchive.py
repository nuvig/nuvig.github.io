#!/usr/bin/env python3
"""DC weather archiver — GitHub Actions edition (stdlib only).

Permanently archives the raw material of the DC weather story into the
repo's own data/wx/ folder so discussion.html can read history from any
device (localStorage only remembers one browser):

  - every LWX Area Forecast Discussion issuance (full text — the NWS
    products API only keeps a few days; this keeps them all)
  - NWS daily-forecast snapshots for DC several times a day (what was
    *expected*, for drift + verification)
  - KDCA METARs per day (what actually *happened*)

Run hourly by .github/workflows/wxarchive.yml, which commits whatever this
script writes. No Pi, no PAT, no side branch — the archive is ordinary
files on main, served by GitHub Pages at /data/wx/.

Output layout (data/wx/):
  index.json                       archive catalog + freshness
  afd/YYYY/afd-YYYYMMDD-HHMM.json  one file per AFD issuance (UTC stamp)
  forecast/YYYY-MM-DD.json         {date, snaps:[{t, days:{date:{hi,lo,pop,short}}}]}
  obs/YYYY-MM-DD.json              {date, station, metars:[[t, raw], ...]}

Growth math: AFDs are ~8 KB × ~5/day, forecasts + obs a few KB/day —
roughly 15 MB/year of JSON. A public repo doesn't notice.
"""

import datetime
import json
import os
import sys
import urllib.error
import urllib.request

OFFICE = os.environ.get("WX_OFFICE", "LWX")
OBS_STATION = os.environ.get("WX_OBS", "KDCA")
POINT = os.environ.get("WX_POINT", "38.8894,-77.0352")  # downtown DC
TZ = "America/New_York"   # archive days are local DC days (matches the page)

NWS = "https://api.weather.gov"
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WX = os.path.join(REPO, "data", "wx")
AFD_DIR = os.path.join(WX, "afd")
FC_DIR = os.path.join(WX, "forecast")
OBS_DIR = os.path.join(WX, "obs")
# Keep at most ~9 forecast snapshots/day: skip if the last one is fresher.
SNAP_GAP_S = int(os.environ.get("WX_SNAP_GAP_S", "9000"))  # 2.5 h


def log(msg):
    print(msg, flush=True)


def local_now():
    try:
        from zoneinfo import ZoneInfo
        return datetime.datetime.now(ZoneInfo(TZ))
    except Exception:
        return datetime.datetime.now().astimezone()


def fetch(url):
    req = urllib.request.Request(url, headers={
        "User-Agent": "wxarchive (jesselevine.net)",
        "Accept": "application/ld+json, application/geo+json, application/json",
    })
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


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
    now = local_now()
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
    tz = local_now().tzinfo
    by_day = {}
    for f in data.get("features", []):
        p = f.get("properties") or {}
        iso, raw = p.get("timestamp"), p.get("rawMessage")
        if not iso or not raw:
            continue
        t = datetime.datetime.fromisoformat(iso.replace("Z", "+00:00"))
        day = f"{t.astimezone(tz):%Y-%m-%d}"
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
            rel = os.path.relpath(os.path.join(root, fname), WX).replace(os.sep, "/")
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
    problems = 0
    for step in (archive_afds, snapshot_forecast, archive_obs):
        try:
            step()
        except (urllib.error.URLError, OSError, KeyError, json.JSONDecodeError) as e:
            log(f"{step.__name__}: {e}")
            problems += 1
    n = build_index()
    log(f"index: {n} AFD issuance(s) archived")
    return 0 if problems == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
