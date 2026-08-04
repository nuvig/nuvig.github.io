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
  - the NWS hourly grid at KANP (ceiling/vis/wind/PoP/weather, 48 h out)
  - every TAF issuance for KMTN/KBWI/KDCA, decoded from IWXXM
  - active alerts, and a GFS CAPE/CIN/precip digest at the field

Everything is written day-forward: each stream is one file per local day, so
history accumulates from the moment this starts running and nothing is ever
rewritten. data/wx/latest.json holds the current state of every stream in a
single same-origin document, so any page on the site can render weather from
the archive instead of calling NWS itself.

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
import re
import sys
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET

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
GRID_DIR = os.path.join(WX, "grid")
TAF_DIR = os.path.join(WX, "taf")
ALERT_DIR = os.path.join(WX, "alerts")
MODEL_DIR = os.path.join(WX, "model")

# The airfield the aviation streams describe (KANP), its TAF neighbours (KANP
# has no TAF of its own), and how far ahead each hourly snapshot reaches.
FIELD = os.environ.get("WX_FIELD", "38.9429,-76.5684")
TAF_STATIONS = [s for s in os.environ.get("WX_TAFS", "KMTN,KBWI,KDCA").split(",") if s]
GRID_HOURS = int(os.environ.get("WX_GRID_HOURS", "48"))
OPEN_METEO = "https://api.open-meteo.com/v1/forecast"
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


def fetch_text(url):
    req = urllib.request.Request(url, headers={
        "User-Agent": "wxarchive (jesselevine.net)",
        "Accept": "application/xml, text/xml, */*",
    })
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", "replace")


def epoch(iso):
    return int(datetime.datetime.fromisoformat(
        iso.replace("Z", "+00:00")).timestamp())


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


# ---------------------------------------------------------------------------
# Hourly grid at the field — the table every aviation app renders
# ---------------------------------------------------------------------------

DUR_RE = re.compile(r"P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?")


def expand_series(series, t0, n, conv=lambda v: v):
    """An NWS grid series (validTime/value, ISO-8601 durations) flattened to n
    hourly values starting at epoch t0. Pure — the unit tests drive it."""
    out = [None] * n
    for v in (series or {}).get("values", []):
        iso, _, dur = (v.get("validTime") or "").partition("/")
        try:
            start = epoch(iso)
        except ValueError:
            continue
        m = DUR_RE.match(dur or "PT1H")
        hrs = max(1, (int(m.group(1) or 0) * 24 + int(m.group(2) or 0))
                  + (1 if m.group(3) else 0))
        val = v.get("value")
        for h in range(hrs):
            i = (start + h * 3600 - t0) // 3600
            if 0 <= i < n:
                out[i] = None if val is None else conv(val)
    return out


def digest_grid(props, t0, n=None):
    """Compact hourly digest: ceilings ft, visibility SM, wind kt/deg true,
    temps degC, PoP %, and the grid's own weather strings. LWX encodes "no
    ceiling" as -30.48 m, so any non-positive height means none."""
    n = n or GRID_HOURS
    ser = lambda key, conv: expand_series(props.get(key), t0, n, conv)
    wx_join = lambda v: ",".join(sorted({
        w.get("weather") for w in (v or []) if w and w.get("weather")})) or None
    return {
        "t0": t0, "n": n,
        "ceil": ser("ceilingHeight", lambda v: None if v <= 0 else round(v * 3.28084 / 50) * 50),
        "vis": ser("visibility", lambda v: None if v < 0 else round(v / 1609.34, 1)),
        "spd": ser("windSpeed", lambda v: round(v / 1.852)),
        "gst": ser("windGust", lambda v: round(v / 1.852)),
        "dir": ser("windDirection", lambda v: round(v)),
        "pop": ser("probabilityOfPrecipitation", lambda v: round(v)),
        "temp": ser("temperature", lambda v: round(v, 1)),
        "dew": ser("dewpoint", lambda v: round(v, 1)),
        "wx": ser("weather", wx_join),
    }


def snapshot_grid():
    pt = fetch(f"{NWS}/points/{FIELD}")
    props = fetch(pt["properties"]["forecastGridData"])["properties"]
    now = local_now()
    t0 = int(now.timestamp()) // 3600 * 3600
    doc_path = os.path.join(GRID_DIR, f"{now:%Y-%m-%d}.json")
    doc = read_json(doc_path, {"date": f"{now:%Y-%m-%d}", "field": FIELD, "snaps": []})
    if doc["snaps"] and int(now.timestamp()) - doc["snaps"][-1]["t"] < SNAP_GAP_S:
        return False
    snap = digest_grid(props, t0)
    snap["t"] = int(now.timestamp())
    doc["snaps"].append(snap)
    write_json(doc_path, doc)
    log(f"grid snapshot #{len(doc['snaps'])} for {doc['date']}")
    return True


# ---------------------------------------------------------------------------
# TAFs — decoded from IWXXM, one entry per issuance
# ---------------------------------------------------------------------------

XLINK_HREF = "{http://www.w3.org/1999/xlink}href"
_local = lambda tag: tag.rsplit("}", 1)[-1]


def _all(el, name):
    return [e for e in el.iter() if _local(e.tag) == name]


def _text(el, name):
    got = _all(el, name)
    return got[0].text.strip() if got and got[0].text else None


def _code(el):
    return (el.get(XLINK_HREF) or el.get("href") or "").rsplit("/", 1)[-1]


def decode_taf_xml(text):
    """IWXXM TAF -> [{ind, b, e, dir, kt, gust, visM, wx[], cld[]}]. Pure."""
    root = ET.fromstring(text)
    periods = []
    for f in _all(root, "MeteorologicalAerodromeForecast"):
        p = {"ind": f.get("changeIndicator") or "FM", "wx": [], "cld": []}
        tp = _all(f, "TimePeriod")
        if tp:
            b, e = _text(tp[0], "beginPosition"), _text(tp[0], "endPosition")
            if b and e:
                p["b"], p["e"] = epoch(b), epoch(e)
        for key, name in (("dir", "meanWindDirection"), ("kt", "meanWindSpeed"),
                          ("gust", "windGustSpeed"), ("visM", "prevailingVisibility")):
            val = _text(f, name)
            if val is not None:
                p[key] = round(float(val))
        for w in _all(f, "weather"):
            c = _code(w)
            if c and c != "NSW":
                p["wx"].append(c)
        for cl in _all(f, "CloudLayer"):
            amt = _all(cl, "amount")
            base = _text(cl, "base")
            p["cld"].append({
                "amt": _code(amt[0]) if amt else None,
                "ft": round(float(base)) if base else None,
            })
        if "b" in p:
            periods.append(p)
    return periods


def archive_tafs():
    """Every TAF issuance, decoded, deduped by issue time. The NWS collection
    endpoint only keeps recent ones — this keeps them all."""
    now = local_now()
    added = 0
    for station in TAF_STATIONS:
        try:
            data = fetch(f"{NWS}/stations/{station}/tafs")
        except (urllib.error.URLError, OSError, KeyError) as e:
            log(f"taf {station}: {e}")
            continue
        for item in (data.get("@graph") or [])[:6]:
            iso = item.get("issueTime")
            if not iso or not item.get("id"):
                continue
            t = epoch(iso)
            day = f"{datetime.datetime.fromtimestamp(t, now.tzinfo):%Y-%m-%d}"
            path = os.path.join(TAF_DIR, f"{day}.json")
            doc = read_json(path, {"date": day, "tafs": []})
            if any(x["station"] == station and x["t"] == t for x in doc["tafs"]):
                continue
            try:
                periods = decode_taf_xml(fetch_text(item["id"]))
            except (urllib.error.URLError, OSError, ET.ParseError) as e:
                log(f"taf {station} {iso}: {e}")
                continue
            doc["tafs"].append({"station": station, "t": t, "periods": periods})
            doc["tafs"].sort(key=lambda x: (x["t"], x["station"]))
            write_json(path, doc)
            added += 1
    if added:
        log(f"archived {added} TAF issuance(s)")
    return added


# ---------------------------------------------------------------------------
# Active alerts and the model digest behind the "why"
# ---------------------------------------------------------------------------

def snapshot_alerts():
    data = fetch(f"{NWS}/alerts/active?point={POINT}")
    feats = data.get("features") or data.get("@graph") or []
    now = local_now()
    path = os.path.join(ALERT_DIR, f"{now:%Y-%m-%d}.json")
    doc = read_json(path, {"date": f"{now:%Y-%m-%d}", "alerts": []})
    have = {a.get("id") for a in doc["alerts"]}
    added = 0
    for f in feats:
        p = f.get("properties") or f
        if not p or not p.get("event") or p.get("id") in have:
            continue
        doc["alerts"].append({
            "id": p.get("id"), "seen": int(now.timestamp()), "event": p.get("event"),
            "severity": p.get("severity"), "onset": p.get("onset"),
            "ends": p.get("ends") or p.get("expires"), "headline": p.get("headline"),
            "desc": (p.get("description") or "")[:600],
        })
        added += 1
    if added:
        write_json(path, doc)
        log(f"archived {added} alert(s)")
    return added


def snapshot_model():
    """GFS CAPE/CIN/precip at the field — the parameters the page reaches for
    when it has to explain why a forecast moved."""
    url = (f"{OPEN_METEO}?latitude={FIELD.split(',')[0]}&longitude={FIELD.split(',')[1]}"
           "&hourly=cape,convective_inhibition,precipitation"
           f"&forecast_hours={GRID_HOURS}&timeformat=unixtime&timezone=UTC&models=gfs_global")
    d = fetch(url)
    now = local_now()
    path = os.path.join(MODEL_DIR, f"{now:%Y-%m-%d}.json")
    doc = read_json(path, {"date": f"{now:%Y-%m-%d}", "field": FIELD, "snaps": []})
    if doc["snaps"] and int(now.timestamp()) - doc["snaps"][-1]["t"] < SNAP_GAP_S:
        return False
    h = d.get("hourly") or {}
    times = h.get("time") or []
    rnd = lambda arr: [None if v is None else round(v) for v in (arr or [])]
    doc["snaps"].append({
        "t": int(now.timestamp()),
        "t0": times[0] if times else None,
        "n": len(times),
        "cape": rnd(h.get("cape")),
        "cin": rnd(h.get("convective_inhibition")),
        "pr": [None if v is None else round(v, 2) for v in (h.get("precipitation") or [])],
    })
    write_json(path, doc)
    log(f"model snapshot #{len(doc['snaps'])} for {doc['date']}")
    return True


# ---------------------------------------------------------------------------
# latest.json — one same-origin fetch that gives any page the current state
# ---------------------------------------------------------------------------

def newest_afd():
    best = None
    for root, _dirs, files in os.walk(AFD_DIR):
        for fname in files:
            if fname.startswith("afd-") and fname.endswith(".json"):
                path = os.path.join(root, fname)
                if best is None or fname > os.path.basename(best):
                    best = path
    return read_json(best, None) if best else None


def write_latest():
    """A single current-state document for the whole site: whatever any page
    needs to render weather without touching NWS directly."""
    now = local_now()
    today = f"{now:%Y-%m-%d}"
    last = lambda doc, key: (doc.get(key) or [None])[-1] if doc else None
    fc = read_json(os.path.join(FC_DIR, today + ".json"), {})
    grid = read_json(os.path.join(GRID_DIR, today + ".json"), {})
    model = read_json(os.path.join(MODEL_DIR, today + ".json"), {})
    obs = read_json(os.path.join(OBS_DIR, today + ".json"), {})
    alerts = read_json(os.path.join(ALERT_DIR, today + ".json"), {})
    tafs = {}
    for day in (today, f"{now - datetime.timedelta(days=1):%Y-%m-%d}"):
        for t in read_json(os.path.join(TAF_DIR, day + ".json"), {}).get("tafs", []):
            cur = tafs.get(t["station"])
            if not cur or t["t"] > cur["t"]:
                tafs[t["station"]] = t
    afd = newest_afd()
    write_json(os.path.join(WX, "latest.json"), {
        "t": int(now.timestamp()),
        "office": OFFICE, "station": OBS_STATION, "point": POINT, "field": FIELD,
        "afd": afd,
        "forecast": last(fc, "snaps"),
        "grid": last(grid, "snaps"),
        "model": last(model, "snaps"),
        "tafs": tafs,
        "alerts": alerts.get("alerts", []),
        "obs": (obs.get("metars") or [])[-12:],
    })
    log("latest.json written")


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
        "grid_days": listing(GRID_DIR),
        "taf_days": listing(TAF_DIR),
        "alert_days": listing(ALERT_DIR),
        "model_days": listing(MODEL_DIR),
        "field": FIELD,
        "taf_stations": TAF_STATIONS,
    })
    return len(afd)


def main():
    problems = 0
    for step in (archive_afds, snapshot_forecast, archive_obs,
                 snapshot_grid, archive_tafs, snapshot_alerts, snapshot_model):
        try:
            step()
        except (urllib.error.URLError, OSError, KeyError, ValueError,
                json.JSONDecodeError, ET.ParseError) as e:
            log(f"{step.__name__}: {e}")
            problems += 1
    try:
        write_latest()          # built from whatever landed on disk above
    except (OSError, ValueError) as e:
        log(f"write_latest: {e}")
        problems += 1
    n = build_index()
    log(f"index: {n} AFD issuance(s) archived")
    return 0 if problems == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
