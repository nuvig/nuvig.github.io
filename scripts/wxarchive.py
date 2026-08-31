#!/usr/bin/env python3
"""DC weather archiver — GitHub Actions edition (stdlib only).

Permanently archives the raw material of the DC weather story into the
repo's own data/wx/ folder so discussion.html can read history from any
device (localStorage only remembers one browser):

  - every LWX Area Forecast Discussion issuance (full text — the NWS
    products API only keeps a few days; this keeps them all)
  - NWS daily-forecast snapshots for DC several times a day (what was
    *expected*, for drift + verification)
  - KDCA METARs per day (what actually *happened* where the forecast is for)
  - KNAK METARs per day (what actually happened *at the field* — KANP has no
    on-field sensor, and verifying a KANP forecast against KDCA means
    verifying it 25 nm away)
  - METARs from every reporting field in the local ring (W29, KFME, KBWI,
    KESN, KADW … — what a KANP pilot actually looks at before launching)
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
  fieldobs/YYYY-MM-DD.json         same shape, the field's own station (hourly,
                                   so sparser than obs/ — tolerate gaps)
  stations/<ID>/YYYY-MM-DD.json    same shape again, one directory per station
                                   in the local ring (WX_STATIONS)

METAR day files may also carry "nh": hours of that day neither the NWS API nor
IEM has an observation for, i.e. hours the station never reported. It is a
bookkeeping key for heal_metars(); consumers only ever read "metars".

Self-healing: api.weather.gov is the live source, but it is not a reliable
source of *record* — see heal_metars() for what it drops and why every METAR
stream is re-checked against IEM's ASOS archive at the end of each run.

Growth math: AFDs are ~8 KB × ~5/day, forecasts + obs a few KB/day, and each
extra station ~2.5 KB/day — roughly 25 MB/year of JSON with a dozen stations.
A public repo doesn't notice.
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
# The field's own sensor. The grid stream forecasts KANP, but KANP has no
# on-field METAR, so the nearest one (KNAK, USNA, ~3 nm NE) stands in for it.
# Without this the aviation rows on discussion.html can only check a KANP
# forecast against KDCA weather ~25 nm NW. Blank — or the same id as WX_OBS,
# for a field that reports its own METAR — disables the stream.
FIELD_OBS_STATION = os.environ.get("WX_FIELD_OBS", "KNAK")
# Every other METAR-reporting field in the local ring, archived per station
# under stations/<ID>/. This is "the weather where I actually fly" — the fields
# on the sectional around KANP, near-to-far. KDCA and KNAK are deliberately
# absent: they already have dedicated streams (obs/ and fieldobs/) that the
# verification cards are built on, and archiving them twice would fork the
# record. An id nobody publishes is not fatal — it logs and the run continues.
STATIONS = [s for s in os.environ.get(
    "WX_STATIONS",
    "W29,KFME,KCGS,KADW,KBWI,KMTN,KESN,KGAI,KRJD,KAPG,KCGE,KNHK"
).split(",") if s.strip()]
POINT = os.environ.get("WX_POINT", "38.8894,-77.0352")  # downtown DC
TZ = "America/New_York"   # archive days are local DC days (matches the page)

NWS = "https://api.weather.gov"
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WX = os.path.join(REPO, "data", "wx")
AFD_DIR = os.path.join(WX, "afd")
FC_DIR = os.path.join(WX, "forecast")
OBS_DIR = os.path.join(WX, "obs")
FIELDOBS_DIR = os.path.join(WX, "fieldobs")
GRID_DIR = os.path.join(WX, "grid")
TAF_DIR = os.path.join(WX, "taf")
ALERT_DIR = os.path.join(WX, "alerts")
MODEL_DIR = os.path.join(WX, "model")
STATIONS_DIR = os.path.join(WX, "stations")

# The airfield the aviation streams describe (KANP), its TAF neighbours (KANP
# has no TAF of its own), and how far ahead each hourly snapshot reaches.
FIELD = os.environ.get("WX_FIELD", "38.9429,-76.5684")
TAF_STATIONS = [s for s in os.environ.get("WX_TAFS", "KMTN,KBWI,KDCA").split(",") if s]
GRID_HOURS = int(os.environ.get("WX_GRID_HOURS", "48"))
OPEN_METEO = "https://api.open-meteo.com/v1/forecast"
# Keep at most ~9 forecast snapshots/day: skip if the last one is fresher.
# Minimum spacing between kept snapshots. GitHub's scheduler is best-effort:
# measured over 68 h this workflow's hourly cron actually fired every ~2.4 h
# (29 of ~68 runs; worst gap 4.3 h). A throttle near that cadence threw away
# runs we did get, so keep it well under it — the binding constraint is how
# often Actions runs us, not how often we are willing to write.
SNAP_GAP_S = int(os.environ.get("WX_SNAP_GAP_S", "2400"))  # 40 min
# How far back each run re-reads the obs feed. Comfortably past the worst
# observed scheduler gap (4.3 h) so a missed run heals on the next one.
OBS_LOOKBACK_H = int(os.environ.get("WX_OBS_LOOKBACK_H", "36"))
# Same idea for TAFs: how far back each run is willing to re-check the
# issuance list. Bounds the per-run XML fetches without capping by position.
TAF_LOOKBACK_H = int(os.environ.get("WX_TAF_LOOKBACK_H", "36"))
# How many local days back heal_metars() re-checks against IEM. Three days is
# well past any plausible NWS ingest delay while keeping the request cheap;
# older holes are wxbackfill.py's job.
HEAL_DAYS = int(os.environ.get("WX_HEAL_DAYS", "3"))
# An hour neither the NWS API nor IEM has, once this old, is taken as an hour
# the station never reported (normal for a part-time AWOS overnight) and
# recorded in the day file's "nh" list so it is never re-fetched.
NH_SETTLE_H = int(os.environ.get("WX_NH_SETTLE_H", "3"))
IEM = os.environ.get("WX_IEM", "https://mesonet.agron.iastate.edu")


def log(msg):
    print(msg, flush=True)


def local_now():
    try:
        from zoneinfo import ZoneInfo
        return datetime.datetime.now(ZoneInfo(TZ))
    except Exception:
        return datetime.datetime.now().astimezone()


def fetch(url, fresh=False):
    """`fresh=True` asks the CDN to revalidate. api.weather.gov's edge will
    otherwise hand back a collection that is hours old — measured on
    2026-08-07, six identical requests to /stations/KBWI/tafs returned one
    response whose newest issuance was 21 h stale. A stale collection looks
    exactly like "nothing new" to a dedupe, so the archiver silently lost
    every KBWI/KMTN TAF issued that afternoon. Use it on the collection
    endpoints; the per-product URLs are immutable and don't need it."""
    headers = {
        "User-Agent": "wxarchive (jesselevine.net)",
        "Accept": "application/ld+json, application/geo+json, application/json",
    }
    if fresh:
        headers["Cache-Control"] = "no-cache"
        headers["Pragma"] = "no-cache"
    req = urllib.request.Request(url, headers=headers)
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


# ---------------------------------------------------------------------------
# IEM ASOS archive — the source of record behind every METAR stream.
# Shared with scripts/wxbackfill.py, which fills older ranges from the same
# endpoint; keep the parsing in one place so live and backfill agree.
# ---------------------------------------------------------------------------

def iem_id(station):
    """IEM keys ASOS sites without the leading K (DCA, NAK); non-ICAO ids
    like W29 are stored verbatim."""
    return station[1:] if len(station) == 4 and station.startswith("K") else station


def asos_url(station, since, until):
    """One bulk CSV request for a whole date range. `until` is inclusive here;
    IEM's end date is exclusive, so it is padded by a day."""
    end = until + datetime.timedelta(days=2)
    return (f"{IEM}/cgi-bin/request/asos.py?station={iem_id(station)}&data=metar"
            f"&year1={since:%Y}&month1={since:%m}&day1={since:%d}"
            f"&year2={end:%Y}&month2={end:%m}&day2={end:%d}"
            "&tz=Etc/UTC&format=onlycomma&missing=M&trace=T"
            "&report_type=3&report_type=4")


def parse_asos_csv(text):
    """IEM asos.py onlycomma CSV -> [(epoch, raw_metar)]. Pure."""
    out = []
    for line in text.splitlines():
        parts = line.split(",", 2)
        if len(parts) != 3 or parts[1] == "valid":
            continue
        _station, valid, raw = parts
        raw = raw.strip()
        if not raw or raw == "M":
            continue
        try:
            t = datetime.datetime.strptime(valid.strip(), "%Y-%m-%d %H:%M")
        except ValueError:
            continue
        out.append((int(t.replace(tzinfo=datetime.timezone.utc).timestamp()), raw))
    return out


def mark_bf(doc, added):
    """Tag what came from an archive rather than the live wire, so consumers
    (and anyone reading the JSON) can tell provenance apart."""
    bf = doc.get("bf") or {"src": "iem", "n": 0}
    bf["n"] += added
    bf["at"] = int(datetime.datetime.now(datetime.timezone.utc).timestamp())
    doc["bf"] = bf


def merge_metars(doc, entries, tol_s=90):
    """Add only observations the live archiver missed: anything within tol_s
    of an existing timestamp is treated as already captured, because IEM and
    the NWS API round the same ob to slightly different seconds. Never
    replaces a live entry. Pure."""
    have = sorted(m[0] for m in doc["metars"])
    added = 0
    for t, raw in sorted(entries):
        if any(abs(t - h) <= tol_s for h in have):
            continue
        doc["metars"].append([t, raw])
        have.append(t)
        added += 1
    if added:
        doc["metars"].sort()
        mark_bf(doc, added)
    return added


def missing_hours(doc, day, tz):
    """Which local hours of `day` hold no METAR at all. A routine ob is issued
    every hour at every station here, so an empty hour is a hole, not weather.
    Today's not-yet-happened hours are excluded by the caller."""
    seen = set()
    for m in doc.get("metars", []):
        t = datetime.datetime.fromtimestamp(m[0], tz)
        if f"{t:%Y-%m-%d}" == day:
            seen.add(t.hour)
    return [h for h in range(24) if h not in seen]


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


def archive_metars(station, out_dir):
    """Window by *time*, never by count. KDCA publishes a 5-minute ob, so the
    old `?limit=72` reached back only ~5 h and carried just 5 rawMessages —
    any scheduler gap longer than that dropped those hours for good, because
    no later run could see back far enough to fill them. `?start=` costs one
    bigger response (~475 features) and makes every run self-healing."""
    start = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(
        hours=OBS_LOOKBACK_H)
    data = fetch(f"{NWS}/stations/{station}/observations"
                 f"?start={start:%Y-%m-%dT%H:00:00Z}", fresh=True)
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
        path = os.path.join(out_dir, f"{day}.json")
        doc = read_json(path, {"date": day, "station": station, "metars": []})
        have = {m[0] for m in doc["metars"]}
        add = [m for m in metars if m[0] not in have]
        if not add:
            continue
        doc["metars"] = sorted(doc["metars"] + add)
        write_json(path, doc)
        changed += len(add)
    if changed:
        log(f"archived {changed} new METAR(s) from {station}")
    return changed


def archive_obs():
    """The station that verifies the DC forecast this archive is built around."""
    return archive_metars(OBS_STATION, OBS_DIR)


def archive_field_obs():
    """The airfield's own weather, so the aviation rows can check a forecast
    made *for the field* against a sensor at the field. KNAK reports hourly
    (not KDCA's 5-minute cadence) and occasionally omits rawMessage, so this
    stream is sparser than obs/ by nature — consumers must tolerate gaps."""
    if not FIELD_OBS_STATION or FIELD_OBS_STATION == OBS_STATION:
        return 0
    return archive_metars(FIELD_OBS_STATION, FIELDOBS_DIR)


def station_dir(station):
    return os.path.join(STATIONS_DIR, station)


def archive_stations():
    """The rest of the local ring. Same shape and same rules as obs/, one
    directory per station, so a page can read any nearby field's day exactly
    the way it reads KDCA's. A station the NWS API doesn't publish (some
    non-ICAO AWOS sites are IEM-only) fails alone and is picked up by the
    heal pass below rather than sinking the run."""
    total = 0
    for station in STATIONS:
        if station in (OBS_STATION, FIELD_OBS_STATION):
            continue          # already has a dedicated stream — don't fork it
        try:
            total += archive_metars(station, station_dir(station))
        except (urllib.error.URLError, OSError, KeyError, ValueError,
                json.JSONDecodeError) as e:
            log(f"stations {station}: {e}")
    return total


def heal_metars():
    """Re-check every METAR stream against IEM and fill whatever the live wire
    never handed us.

    Why this exists: api.weather.gov is a good live source and a poor source of
    record. Over 2026-08-12..30 the obs/ and fieldobs/ streams lost ~7 hours a
    day each, and on 13 of those 19 days the *set of missing hours was
    identical for both stations* — KDCA on a 5-minute cadence and KNAK on an
    hourly one do not fail in the same hours by coincidence, so the loss is on
    the fetch side, not at the stations. It is not the scheduler either: each
    run already re-reads OBS_LOOKBACK_H=36 h, and runs land every few hours, so
    every one of those hours was asked for again and still came back absent.
    IEM has all of them (a backfill fills those days to 24/24), so the fix is
    to stop treating one API as the whole record.

    One bulk CSV per station, and only when that station is actually short an
    hour — on a healthy day this makes no requests at all. An hour that IEM
    doesn't have either is recorded in the day file as "nh" (no ob: the station
    was simply not reporting, which is normal for a part-time AWOS overnight)
    and never asked about again, so a field that sleeps at night doesn't make
    this pass fetch its whole ring every hour for the rest of time. Only hours
    at least NH_SETTLE_H old are settled that way — a hole younger than that
    may still be an ingest delay at either source. wxbackfill.py ignores "nh",
    so a wrongly settled hour can always be repaired by hand.
    """
    tz = local_now().tzinfo
    now = local_now()
    days = [(now - datetime.timedelta(days=d)).date() for d in range(HEAL_DAYS)]
    days.sort()
    streams = [(OBS_STATION, OBS_DIR)]
    if FIELD_OBS_STATION and FIELD_OBS_STATION != OBS_STATION:
        streams.append((FIELD_OBS_STATION, FIELDOBS_DIR))
    streams += [(st, station_dir(st)) for st in STATIONS
                if st not in (OBS_STATION, FIELD_OBS_STATION)]
    healed = 0
    for station, out_dir in streams:
        holes = {}
        for day in days:
            key = f"{day:%Y-%m-%d}"
            doc = read_json(os.path.join(out_dir, key + ".json"),
                            {"date": key, "station": station, "metars": []})
            settled = set(doc.get("nh") or [])
            miss = [h for h in missing_hours(doc, key, tz) if h not in settled]
            if key == f"{now:%Y-%m-%d}":
                # the day is still running: only hours that have fully passed
                # can be called missing
                miss = [h for h in miss if h < now.hour]
            if miss:
                holes[key] = miss
        if not holes:
            continue
        log(f"heal {station}: {sum(len(v) for v in holes.values())} missing "
            f"hour(s) across {len(holes)} day(s)")
        try:
            text = fetch_text(asos_url(station, days[0], days[-1]))
        except (urllib.error.URLError, OSError) as e:
            log(f"heal {station}: {e}")
            continue
        by_day = {}
        for t, raw in parse_asos_csv(text):
            key = f"{datetime.datetime.fromtimestamp(t, tz):%Y-%m-%d}"
            if key in holes:
                by_day.setdefault(key, []).append((t, raw))
        for key in sorted(holes):
            path = os.path.join(out_dir, key + ".json")
            doc = read_json(path, {"date": key, "station": station, "metars": []})
            before = doc.get("nh") or []
            added = merge_metars(doc, by_day.get(key, []))
            # Whatever is still missing and old enough to have settled is not a
            # hole in the archive — it is an hour nobody observed. wxbackfill.py
            # ignores "nh" entirely, so a wrongly settled hour is still
            # repairable by hand.
            cutoff = now.hour - NH_SETTLE_H if key == f"{now:%Y-%m-%d}" else 24
            nh = sorted(set(before) |
                        {h for h in missing_hours(doc, key, tz) if h < cutoff})
            if nh:
                doc["nh"] = nh
            if added or nh != before:
                write_json(path, doc)
            if added:
                log(f"heal {station} {key}: +{added} METAR(s) from IEM")
                healed += added
    if healed:
        log(f"heal: {healed} METAR(s) recovered that the NWS API never served")
    return healed


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


def newest_taf_on_disk(station, now):
    """Latest issue time already archived for a station, over the window we
    re-read. The staleness check below compares against this."""
    newest = 0
    for back in range(0, TAF_LOOKBACK_H // 24 + 2):
        day = f"{now - datetime.timedelta(days=back):%Y-%m-%d}"
        for x in read_json(os.path.join(TAF_DIR, f"{day}.json"), {}).get("tafs", []):
            if x["station"] == station:
                newest = max(newest, x["t"])
    return newest


def taf_collection(station, on_disk):
    """The station's issuance list, retried until the CDN stops handing back a
    cached copy older than what we already have. A stale collection is
    indistinguishable from "no new TAFs" downstream, so it must be caught
    here — see fetch()."""
    stale = None
    for attempt in range(3):
        data = fetch(f"{NWS}/stations/{station}/tafs", fresh=True)
        items = [i for i in (data.get("@graph") or [])
                 if i.get("issueTime") and i.get("id")]
        if not items:
            stale = "empty collection"
            continue
        newest = max(epoch(i["issueTime"]) for i in items)
        if newest >= on_disk:
            return items
        stale = (f"newest {datetime.datetime.fromtimestamp(newest, datetime.timezone.utc):%m-%d %H:%MZ}"
                 f" is older than archived "
                 f"{datetime.datetime.fromtimestamp(on_disk, datetime.timezone.utc):%m-%d %H:%MZ}")
        log(f"taf {station}: stale response ({stale}), retry {attempt + 1}/3")
    log(f"taf {station}: giving up on a fresh collection — {stale}")
    return []


def archive_tafs():
    """Every TAF issuance, decoded, deduped by issue time. The NWS collection
    endpoint only keeps recent ones — this keeps them all."""
    now = local_now()
    cutoff = int((now - datetime.timedelta(hours=TAF_LOOKBACK_H)).timestamp())
    added = 0
    for station in TAF_STATIONS:
        try:
            items = taf_collection(station, newest_taf_on_disk(station, now))
        except (urllib.error.URLError, OSError, KeyError) as e:
            log(f"taf {station}: {e}")
            continue
        for item in items:
            iso = item["issueTime"]
            t = epoch(iso)
            if t < cutoff:      # bounded work; anything older is already ours
                continue
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
    fieldobs = read_json(os.path.join(FIELDOBS_DIR, today + ".json"), {})
    alerts = read_json(os.path.join(ALERT_DIR, today + ".json"), {})
    tafs = {}
    for day in (today, f"{now - datetime.timedelta(days=1):%Y-%m-%d}"):
        for t in read_json(os.path.join(TAF_DIR, day + ".json"), {}).get("tafs", []):
            cur = tafs.get(t["station"])
            if not cur or t["t"] > cur["t"]:
                tafs[t["station"]] = t
    stations_now = {}
    for station in STATIONS:
        if station in (OBS_STATION, FIELD_OBS_STATION):
            continue
        doc = read_json(os.path.join(station_dir(station), today + ".json"), {})
        metars = doc.get("metars") or []
        if metars:
            stations_now[station] = metars[-1]
    afd = newest_afd()
    write_json(os.path.join(WX, "latest.json"), {
        "t": int(now.timestamp()),
        "office": OFFICE, "station": OBS_STATION, "point": POINT, "field": FIELD,
        "field_station": FIELD_OBS_STATION,
        "afd": afd,
        "forecast": last(fc, "snaps"),
        "grid": last(grid, "snaps"),
        "model": last(model, "snaps"),
        "tafs": tafs,
        "alerts": alerts.get("alerts", []),
        "obs": (obs.get("metars") or [])[-12:],
        # hourly station, so a shorter tail still covers the same span as obs
        "fieldobs": (fieldobs.get("metars") or [])[-6:],
        # the local ring: just the current ob per station, which is all a
        # "weather around the field right now" view needs
        "stations": stations_now,
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
    # only stations that actually have days on disk — the catalog reports what
    # is archived, not what was asked for, so an id that publishes nothing
    # never shows up as an empty stream
    station_days = {}
    for station in sorted(os.listdir(STATIONS_DIR)
                          if os.path.isdir(STATIONS_DIR) else []):
        days = listing(os.path.join(STATIONS_DIR, station))
        if days:
            station_days[station] = days
    write_json(os.path.join(WX, "index.json"), {
        "updated": int(datetime.datetime.now().timestamp()),
        "office": OFFICE,
        "station": OBS_STATION,
        "field_station": FIELD_OBS_STATION,
        "afd": afd,
        "forecast_days": listing(FC_DIR),
        "obs_days": listing(OBS_DIR),
        "fieldobs_days": listing(FIELDOBS_DIR),
        "grid_days": listing(GRID_DIR),
        "taf_days": listing(TAF_DIR),
        "alert_days": listing(ALERT_DIR),
        "model_days": listing(MODEL_DIR),
        "stations": sorted(station_days),
        "station_days": station_days,
        "field": FIELD,
        "taf_stations": TAF_STATIONS,
    })
    return len(afd)


def main():
    problems = 0
    # heal_metars runs last: it repairs whatever the live METAR passes above
    # could not get out of api.weather.gov, in the same run.
    for step in (archive_afds, snapshot_forecast, archive_obs, archive_field_obs,
                 archive_stations, snapshot_grid, archive_tafs, snapshot_alerts,
                 snapshot_model, heal_metars):
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
