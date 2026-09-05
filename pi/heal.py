#!/usr/bin/env python3
"""KANP trace heal — fill the collector's holes from adsb.lol's stored traces.

Why this exists (2026-09-05): live collection at Lee cannot be complete. adsb.lol
accepts ~5 requests a minute at steady state, adsb.fi answers at 1 Hz but its
position for an aircraft in the pattern is unchanged a quarter to a third of the
time, and airplanes.live's point endpoint 404s. Yet adsb.lol *stores* every
aircraft's full trace for the day — the KML export Jesse pulled of N754SP had 32
positions inside a 107 s hole of ours. So, after the fact, this script asks for
that trace once per aircraft and inserts the fixes we never received.

    python3 heal.py            # heal the last KANP_HEAL_HOURS hours
    python3 heal.py --dry-run  # fetch and count, insert nothing
    python3 heal.py --selftest # offline fixture checks

Sources (readsb "trace_full" JSON, gzip-served):
    today (UTC)      https://adsb.lol/data/traces/<last2>/trace_full_<hex>.json
    completed days   https://adsb.lol/globe_history/YYYY/MM/DD/traces/<last2>/trace_full_<hex>.json
Shape: {"icao", "r", "t", "desc", "dbFlags", "timestamp": t0,
        "trace": [[dt, lat, lon, alt|"ground", gs, track, flags, vrate, ac|null, source, ...], ...]}
flags bit 1 = stale position (skipped); the day is the trace's UTC day.

Which aircraft: every hex with a fix inside the pattern box (KANP_HEAL_BOX_NM,
KANP_HEAL_BOX_FT) in the window — pattern work, arrivals and departures, not
the 60 nm overflight crowd. Which fixes: trace points inside KANP_RADIUS_NM,
not stale, with no fix of ours for that hex within KANP_HEAL_DEDUPE_S. Inserted
rows carry src='lol' (column added on first run; consumers ignore it).

Politeness: KANP_HEAL_SPACING_S between requests (default 12 → 5/min), at most
KANP_HEAL_MAX_REQ per run. A completed UTC day's trace is fetched once per hex
and remembered in meta; today's is refetched when older than KANP_HEAL_REFRESH_S.
Runs from kanp-heal.timer every 30 min; the exporter's next run carries the
healed rows into the day files (it re-exports today and yesterday).
"""

import datetime
import gzip
import json
import logging
import math
import os
import sqlite3
import sys
import time
import urllib.error
import urllib.request

DEFAULTS = {
    "KANP_LAT": "38.9422",
    "KANP_LON": "-76.5684",
    "KANP_RADIUS_NM": "60",
    "KANP_DB": "/var/lib/kanp/kanp.db",
    "KANP_HEAL_BASE": "https://adsb.lol",
    "KANP_HEAL_HOURS": "30",
    "KANP_HEAL_BOX_NM": "3",
    "KANP_HEAL_BOX_FT": "1800",
    "KANP_HEAL_DEDUPE_S": "1",
    "KANP_HEAL_SPACING_S": "12",
    "KANP_HEAL_MAX_REQ": "40",
    "KANP_HEAL_REFRESH_S": "1500",
}


def cfg(key):
    return os.environ.get(key, DEFAULTS[key])


LAT = float(cfg("KANP_LAT"))
LON = float(cfg("KANP_LON"))
RADIUS_NM = float(cfg("KANP_RADIUS_NM"))
DB_PATH = cfg("KANP_DB")
BASE = cfg("KANP_HEAL_BASE").rstrip("/")
HOURS = float(cfg("KANP_HEAL_HOURS"))
BOX_NM = float(cfg("KANP_HEAL_BOX_NM"))
BOX_FT = float(cfg("KANP_HEAL_BOX_FT"))
DEDUPE_S = float(cfg("KANP_HEAL_DEDUPE_S"))
SPACING_S = float(cfg("KANP_HEAL_SPACING_S"))
MAX_REQ = int(cfg("KANP_HEAL_MAX_REQ"))
REFRESH_S = float(cfg("KANP_HEAL_REFRESH_S"))

log = logging.getLogger("kanp-heal")


def haversine_nm(lat1, lon1, lat2, lon2):
    r_nm = 3440.065
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r_nm * math.asin(math.sqrt(a))


# ---------------------------------------------------------------------------
# DB
# ---------------------------------------------------------------------------
def open_db(path=DB_PATH):
    db = sqlite3.connect(path, timeout=30)
    db.row_factory = sqlite3.Row
    cols = {r["name"] for r in db.execute("PRAGMA table_info(positions)")}
    if not cols:
        raise SystemExit(f"{path}: no positions table — has the collector run?")
    if "src" not in cols:
        db.execute("ALTER TABLE positions ADD COLUMN src TEXT")   # NULL = collector
        db.commit()
    db.execute("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT)")
    return db


def get_meta(db, key):
    r = db.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    return r["value"] if r else None


def set_meta(db, key, value):
    db.execute("INSERT INTO meta(key, value) VALUES(?, ?) "
               "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, str(value)))


def candidates(db, start, end):
    """Hexes with a fix inside the pattern box in [start, end)."""
    rows = db.execute(
        "SELECT hex, lat, lon, alt, on_ground FROM positions "
        "WHERE ts >= ? AND ts < ? AND dist_nm <= ?",
        (start, end, BOX_NM)).fetchall()
    out = set()
    for r in rows:
        if r["on_ground"] == 1 or (r["alt"] is not None and r["alt"] <= BOX_FT):
            out.add(r["hex"])
    return sorted(out)


def existing_ts(db, hexid, start, end):
    return [r["ts"] for r in db.execute(
        "SELECT ts FROM positions WHERE hex=? AND ts >= ? AND ts < ? ORDER BY ts",
        (hexid, start - 5, end + 5))]


# ---------------------------------------------------------------------------
# adsb.lol traces
# ---------------------------------------------------------------------------
def trace_url(hexid, utc_day, today):
    hexid = hexid.lower()
    tail = f"traces/{hexid[-2:]}/trace_full_{hexid}.json"
    if utc_day == today:
        return f"{BASE}/data/{tail}"
    return f"{BASE}/globe_history/{utc_day:%Y/%m/%d}/{tail}"


def fetch_json(url, timeout=20):
    req = urllib.request.Request(url, headers={
        "User-Agent": "kanp-tracker-heal/1.0 (jesselevine.net)",
        "Accept": "application/json", "Accept-Encoding": "gzip"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = resp.read()
        if resp.headers.get("Content-Encoding") == "gzip" or body[:2] == b"\x1f\x8b":
            body = gzip.decompress(body)
    return json.loads(body)


def trace_fixes(doc):
    """readsb trace -> list of fix dicts, stale positions and no-position rows dropped."""
    t0 = float(doc.get("timestamp") or 0)
    out = []
    for p in doc.get("trace") or []:
        if len(p) < 7 or p[1] is None or p[2] is None:
            continue
        flags = p[6] or 0
        if flags & 1:                      # stale / interpolated position
            continue
        alt = p[3]
        on_ground = 1 if alt == "ground" else 0
        alt_ft = alt if isinstance(alt, (int, float)) else None
        ac = p[8] if len(p) > 8 and isinstance(p[8], dict) else {}
        out.append({
            "ts": int(round(t0 + float(p[0]))),
            "lat": float(p[1]), "lon": float(p[2]),
            "alt": int(alt_ft) if alt_ft is not None else None,
            "gs": p[4], "track": p[5],
            "baro_rate": p[7] if len(p) > 7 else None,
            "on_ground": on_ground,
            "squawk": ac.get("squawk"), "category": ac.get("category"),
            "flight": (ac.get("flight") or "").strip() or None,
        })
    return out


def merge(db, hexid, doc, fixes, start, end, dry_run=False):
    """Insert the fixes we lack. Returns (inserted, considered)."""
    have = existing_ts(db, hexid, start, end)
    inserted = considered = 0
    military = 1 if (doc.get("dbFlags") or 0) & 1 else 0
    reg, typ, desc = doc.get("r"), doc.get("t"), doc.get("desc")
    flight = None
    j = 0
    for f in sorted(fixes, key=lambda x: x["ts"]):
        ts = f["ts"]
        if ts < start or ts >= end:
            continue
        d = haversine_nm(LAT, LON, f["lat"], f["lon"])
        if d > RADIUS_NM:
            continue
        considered += 1
        if f["flight"]:
            flight = f["flight"]
        # nearest existing fix (have is sorted)
        while j < len(have) and have[j] < ts - DEDUPE_S:
            j += 1
        if j < len(have) and abs(have[j] - ts) <= DEDUPE_S:
            continue
        if j > 0 and abs(have[j - 1] - ts) <= DEDUPE_S:
            continue
        inserted += 1
        if dry_run:
            continue
        db.execute(
            "INSERT INTO positions(ts, hex, flight, lat, lon, alt, gs, track, baro_rate,"
            " squawk, category, dist_nm, on_ground, military, src)"
            " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'lol')",
            (ts, hexid, flight or reg, f["lat"], f["lon"], f["alt"], f["gs"], f["track"],
             f["baro_rate"], f["squawk"], f["category"], round(d, 2), f["on_ground"], military))
    if inserted and not dry_run:
        db.execute(
            "INSERT INTO aircraft(hex, reg, type, descr, military, first_seen, last_seen)"
            " VALUES(?,?,?,?,?,?,?)"
            " ON CONFLICT(hex) DO UPDATE SET"
            "  reg=COALESCE(aircraft.reg, excluded.reg),"
            "  type=COALESCE(aircraft.type, excluded.type),"
            "  descr=COALESCE(aircraft.descr, excluded.descr),"
            "  military=MAX(excluded.military, aircraft.military)",
            (hexid, reg, typ, desc, military, start, end))
    return inserted, considered


# ---------------------------------------------------------------------------
# run
# ---------------------------------------------------------------------------
def utc_days(start, end):
    d0 = datetime.datetime.fromtimestamp(start, datetime.timezone.utc).date()
    d1 = datetime.datetime.fromtimestamp(end - 1, datetime.timezone.utc).date()
    out = []
    d = d0
    while d <= d1:
        out.append(d)
        d += datetime.timedelta(days=1)
    return out


def run(dry_run=False, now=None, db=None, sleep=time.sleep):
    now = now or time.time()
    db = db or open_db()
    end = int(now)
    start = end - int(HOURS * 3600)
    today = datetime.datetime.fromtimestamp(now, datetime.timezone.utc).date()
    hexes = candidates(db, start, end)
    log.info("window %s → %s · %d aircraft touched the pattern box (%g nm / %g ft)",
             datetime.datetime.fromtimestamp(start).strftime("%m-%d %H:%M"),
             datetime.datetime.fromtimestamp(end).strftime("%m-%d %H:%M"), len(hexes), BOX_NM, BOX_FT)
    requests = 0
    total_ins = total_seen = 0
    fetched = skipped = failed = 0
    for hexid in hexes:
        for day in utc_days(start, end):
            key = f"heal:{hexid}:{day:%Y%m%d}"
            last = get_meta(db, key)
            if last is not None:
                if day != today:
                    skipped += 1
                    continue                          # completed day, fetched once
                if now - float(last) < REFRESH_S:
                    skipped += 1
                    continue
            if requests >= MAX_REQ:
                log.info("request cap %d reached — the rest next run", MAX_REQ)
                break
            if requests:
                sleep(SPACING_S)
            requests += 1
            url = trace_url(hexid, day, today)
            try:
                doc = fetch_json(url)
            except urllib.error.HTTPError as e:
                if e.code == 404:                     # adsb.lol never saw it that day
                    if day != today and not dry_run:
                        set_meta(db, key, "404")
                        db.commit()
                    log.debug("%s: 404", url)
                    continue
                failed += 1
                log.warning("%s: HTTP %d", url, e.code)
                if e.code == 429:
                    log.warning("rate limited — stopping this run")
                    break
                continue
            except Exception as e:  # noqa: BLE001
                failed += 1
                log.warning("%s: %s", url, e)
                continue
            fetched += 1
            fixes = trace_fixes(doc)
            ins, seen = merge(db, hexid, doc, fixes, start, end, dry_run)
            total_ins += ins
            total_seen += seen
            if not dry_run:
                set_meta(db, key, f"{now:.0f}")
                db.commit()
            log.info("%s %s %s: trace %d fixes, %d in window/radius, %d new%s",
                     hexid, doc.get("r") or "", day, len(fixes), seen, ins,
                     " (dry run)" if dry_run else "")
        else:
            continue
        break
    if not dry_run:
        set_meta(db, "heal_last_run", int(now))
        set_meta(db, "heal_last_inserted", total_ins)
        db.commit()
    log.info("done: %d requests, %d traces, %d skipped (already healed), %d failed · "
             "%d fixes in window, %d inserted%s",
             requests, fetched, skipped, failed, total_seen, total_ins, " (dry run)" if dry_run else "")
    return total_ins


# ---------------------------------------------------------------------------
# selftest
# ---------------------------------------------------------------------------
def selftest():
    import tempfile
    tmp = tempfile.mkdtemp()
    path = os.path.join(tmp, "t.db")
    db = sqlite3.connect(path)
    db.executescript("""
    CREATE TABLE positions(id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, hex TEXT NOT NULL,
      flight TEXT, lat REAL NOT NULL, lon REAL NOT NULL, alt INTEGER, gs REAL, track REAL,
      baro_rate INTEGER, squawk TEXT, category TEXT, dist_nm REAL, on_ground INTEGER NOT NULL DEFAULT 0,
      military INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE aircraft(hex TEXT PRIMARY KEY, reg TEXT, type TEXT, descr TEXT,
      military INTEGER NOT NULL DEFAULT 0, first_seen INTEGER, last_seen INTEGER);
    CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
    """)
    now = 1_788_640_000
    # our fixes: an aircraft on short final, 1 s apart, then a 100 s hole, then more
    ours = [now - 3600 + i for i in range(0, 40)] + [now - 3600 + 140 + i for i in range(0, 20)]
    for t in ours:
        db.execute("INSERT INTO positions(ts,hex,lat,lon,alt,dist_nm,on_ground) VALUES(?,?,?,?,?,?,0)",
                   (t, "abc123", LAT + 0.005, LON, 500, 0.3))
    # an overflight at 4,000 ft inside 3 nm — not a candidate
    db.execute("INSERT INTO positions(ts,hex,lat,lon,alt,dist_nm,on_ground) VALUES(?,?,?,?,?,?,0)",
               (now - 1000, "ffff01", LAT + 0.02, LON, 4000, 1.2))
    db.commit(); db.close()
    db = open_db(path)
    assert candidates(db, now - 7200, now) == ["abc123"], candidates(db, now - 7200, now)

    # trace: t0 = start of our data, points every 2 s across the whole stretch,
    # one stale, one 80 nm away, one on the ground
    t0 = now - 3600
    trace = []
    for i in range(0, 160, 2):
        trace.append([i, LAT + 0.005 + i * 1e-5, LON, 500 - i, 70, 287, 0, -300, None, "adsb_icao"])
    trace.append([161, LAT, LON, 500, 70, 287, 1, 0, None, "adsb_icao"])          # stale → dropped
    trace.append([162, LAT + 1.3, LON, 500, 70, 287, 0, 0, None, "adsb_icao"])    # 78 nm → outside radius
    trace.append([163, LAT, LON, "ground", 5, 287, 0, 0, {"flight": "N123AB ", "squawk": "1200"}, "adsb_icao"])
    doc = {"icao": "abc123", "r": "N123AB", "t": "C172", "desc": "CESSNA 172", "dbFlags": 0,
           "timestamp": t0, "trace": trace}
    fixes = trace_fixes(doc)
    assert len(fixes) == 82, len(fixes)                 # 80 + far + ground; stale dropped
    ins, seen = merge(db, "abc123", doc, fixes, now - 7200, now)
    db.commit()
    # in-window & in-radius: 80 + ground = 81 considered; those within 1 s of ours (even offsets
    # 0..40 → 21, since 40 is 1 s from our 39; 140..158 → 10) are dupes → 50 new
    assert seen == 81, seen
    assert ins == 50, ins
    n = db.execute("SELECT COUNT(*) FROM positions WHERE hex='abc123' AND src='lol'").fetchone()[0]
    assert n == 50, n
    g = db.execute("SELECT flight, squawk, on_ground FROM positions WHERE src='lol' AND on_ground=1").fetchone()
    assert (g[0], g[1], g[2]) == ("N123AB", "1200", 1), tuple(g)
    # rerun is a no-op
    ins2, _ = merge(db, "abc123", doc, fixes, now - 7200, now)
    assert ins2 == 0, ins2
    reg = db.execute("SELECT reg, type FROM aircraft WHERE hex='abc123'").fetchone()
    assert (reg[0], reg[1]) == ("N123AB", "C172")
    # url shapes
    today = datetime.date(2026, 9, 5)
    assert trace_url("AA2A83", today, today) == f"{BASE}/data/traces/83/trace_full_aa2a83.json"
    assert trace_url("a5a388", datetime.date(2026, 9, 4), today) == \
        f"{BASE}/globe_history/2026/09/04/traces/88/trace_full_a5a388.json"
    # run(): fetch stubbed, meta remembered, completed day fetched once
    calls = []

    def fake_fetch(url, timeout=20):
        calls.append(url)
        return doc
    global fetch_json
    real = fetch_json
    fetch_json = fake_fetch
    try:
        run(now=now, db=db, sleep=lambda s: None)
        first = len(calls)
        assert first == len(utc_days(now - int(HOURS * 3600), now)), (first, calls)
        run(now=now, db=db, sleep=lambda s: None)
        # today's day refetched only after REFRESH_S; completed days never → no new calls
        assert len(calls) == first, (first, len(calls))
        run(now=now + REFRESH_S + 1, db=db, sleep=lambda s: None)
        assert len(calls) == first + 1, (first, len(calls))
    finally:
        fetch_json = real
    print("selftest ok")


def main(argv):
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s",
                        stream=sys.stdout)
    if "--selftest" in argv:
        selftest()
        return 0
    run(dry_run="--dry-run" in argv)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
