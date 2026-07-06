#!/usr/bin/env python3
"""KANP traffic collector.

Polls airplanes.live (or a local dump1090-fa/readsb/tar1090 instance) for
aircraft around Lee Airport (KANP) and stores positions in a local SQLite
database for traffic-study analysis.

Stdlib only — no pip packages required.

Configuration is via environment variables (see DEFAULTS below), so the
systemd unit can override anything without editing this file.
"""

import json
import logging
import math
import os
import signal
import sqlite3
import sys
import time
import urllib.error
import urllib.request

DEFAULTS = {
    "KANP_LAT": "38.9422",
    "KANP_LON": "-76.5684",
    "KANP_RADIUS_NM": "20",
    # "airplanes" = airplanes.live API; anything starting with http = local
    # receiver aircraft.json URL, e.g. http://127.0.0.1/skyaware/data/aircraft.json
    "KANP_SOURCE": "airplanes",
    "KANP_POLL_SECONDS": "15",
    "KANP_DB": "/var/lib/kanp/kanp.db",
    "KANP_RETENTION_DAYS": "365",
    # Safety cap so the DB can never fill the SD card. Oldest data is pruned
    # in 30-day chunks once this is exceeded.
    "KANP_MAX_DB_MB": "8000",
    # Skip re-inserting a stationary aircraft more than once per this many
    # seconds (parked aircraft with ADS-B on would otherwise flood the DB).
    "KANP_STATIONARY_SECONDS": "300",
}


def cfg(key):
    return os.environ.get(key, DEFAULTS[key])


LAT = float(cfg("KANP_LAT"))
LON = float(cfg("KANP_LON"))
RADIUS_NM = float(cfg("KANP_RADIUS_NM"))
SOURCE = cfg("KANP_SOURCE")
POLL_SECONDS = max(5, int(cfg("KANP_POLL_SECONDS")))
DB_PATH = cfg("KANP_DB")
RETENTION_DAYS = int(cfg("KANP_RETENTION_DAYS"))
MAX_DB_MB = int(cfg("KANP_MAX_DB_MB"))
STATIONARY_SECONDS = int(cfg("KANP_STATIONARY_SECONDS"))

AIRPLANES_URL = f"https://api.airplanes.live/v2/point/{LAT}/{LON}/{RADIUS_NM:g}"

log = logging.getLogger("kanp-collector")

SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA auto_vacuum=INCREMENTAL;

CREATE TABLE IF NOT EXISTS positions (
    id        INTEGER PRIMARY KEY,
    ts        INTEGER NOT NULL,          -- unix epoch seconds (UTC)
    hex       TEXT    NOT NULL,          -- icao24
    flight    TEXT,                      -- callsign, trimmed
    lat       REAL    NOT NULL,
    lon       REAL    NOT NULL,
    alt       INTEGER,                   -- baro altitude ft, NULL when on ground
    gs        REAL,                      -- ground speed kts
    track     REAL,                      -- true track deg
    baro_rate INTEGER,                   -- fpm
    squawk    TEXT,
    category  TEXT,                      -- ADS-B emitter category (A1, A3, ...)
    dist_nm   REAL,                      -- distance from field
    on_ground INTEGER NOT NULL DEFAULT 0,
    military  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_pos_ts     ON positions(ts);
CREATE INDEX IF NOT EXISTS idx_pos_hex_ts ON positions(hex, ts);

CREATE TABLE IF NOT EXISTS aircraft (
    hex        TEXT PRIMARY KEY,
    reg        TEXT,
    type       TEXT,
    descr      TEXT,
    military   INTEGER NOT NULL DEFAULT 0,
    first_seen INTEGER,
    last_seen  INTEGER
);

CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
);
"""


def haversine_nm(lat1, lon1, lat2, lon2):
    r_nm = 3440.065
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r_nm * math.asin(math.sqrt(a))


def open_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    db = sqlite3.connect(DB_PATH, timeout=30)
    db.executescript(SCHEMA)
    db.commit()
    return db


def fetch_aircraft():
    """Return list of aircraft dicts from the configured source."""
    url = AIRPLANES_URL if SOURCE == "airplanes" else SOURCE
    req = urllib.request.Request(url, headers={"User-Agent": "kanp-tracker-collector/1.0"})
    with urllib.request.urlopen(req, timeout=20) as resp:
        data = json.load(resp)
    # airplanes.live uses "ac"; dump1090/readsb/tar1090 use "aircraft"
    return data.get("ac") or data.get("aircraft") or []


def set_meta(db, key, value):
    db.execute(
        "INSERT INTO meta(key, value) VALUES(?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, str(value)),
    )


# hex -> (lat, lon, last_insert_ts) used to downsample stationary aircraft
_last_pos = {}


def store(db, aircraft, now):
    inserted = 0
    for a in aircraft:
        lat, lon, hexid = a.get("lat"), a.get("lon"), a.get("hex")
        if lat is None or lon is None or not hexid:
            continue

        alt_raw = a.get("alt_baro")
        on_ground = 1 if alt_raw == "ground" else 0
        alt = alt_raw if isinstance(alt_raw, (int, float)) else None

        prev = _last_pos.get(hexid)
        moved = prev is None or abs(prev[0] - lat) > 1e-5 or abs(prev[1] - lon) > 1e-5
        if not moved and now - prev[2] < STATIONARY_SECONDS:
            continue
        _last_pos[hexid] = (lat, lon, now)

        dbflags = a.get("dbFlags") or 0
        military = 1 if dbflags & 1 else 0
        flight = (a.get("flight") or "").strip() or None

        db.execute(
            "INSERT INTO positions(ts, hex, flight, lat, lon, alt, gs, track,"
            " baro_rate, squawk, category, dist_nm, on_ground, military)"
            " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                now, hexid, flight, lat, lon,
                int(alt) if alt is not None else None,
                a.get("gs"), a.get("track"), a.get("baro_rate"),
                a.get("squawk"), a.get("category"),
                round(haversine_nm(LAT, LON, lat, lon), 2),
                on_ground, military,
            ),
        )
        db.execute(
            "INSERT INTO aircraft(hex, reg, type, descr, military, first_seen, last_seen)"
            " VALUES(?,?,?,?,?,?,?)"
            " ON CONFLICT(hex) DO UPDATE SET"
            "  reg=COALESCE(excluded.reg, reg),"
            "  type=COALESCE(excluded.type, type),"
            "  descr=COALESCE(excluded.descr, descr),"
            "  military=MAX(excluded.military, military),"
            "  last_seen=excluded.last_seen",
            (hexid, a.get("r"), a.get("t"), a.get("desc"), military, now, now),
        )
        inserted += 1

    # stop the stationary-dedupe map growing forever
    if len(_last_pos) > 5000:
        cutoff = now - 3600
        for k in [k for k, v in _last_pos.items() if v[2] < cutoff]:
            del _last_pos[k]

    set_meta(db, "last_poll", now)
    set_meta(db, "last_ok", now)
    set_meta(db, "last_count", len(aircraft))
    db.commit()
    return inserted


def prune(db, now):
    """Retention pruning plus a hard DB-size cap for the 32 GB SD card."""
    cutoff = now - RETENTION_DAYS * 86400
    cur = db.execute("DELETE FROM positions WHERE ts < ?", (cutoff,))
    if cur.rowcount:
        log.info("pruned %d rows older than %d days", cur.rowcount, RETENTION_DAYS)
    db.commit()

    for _ in range(12):  # at most a year of emergency pruning per pass
        try:
            size_mb = os.path.getsize(DB_PATH) / 1e6
        except OSError:
            break
        if size_mb <= MAX_DB_MB:
            break
        row = db.execute("SELECT MIN(ts) FROM positions").fetchone()
        if not row or row[0] is None:
            break
        chunk_cutoff = row[0] + 30 * 86400
        log.warning("DB %.0f MB over cap %d MB — dropping oldest 30 days", size_mb, MAX_DB_MB)
        db.execute("DELETE FROM positions WHERE ts < ?", (chunk_cutoff,))
        db.commit()
        db.execute("PRAGMA incremental_vacuum")
        db.commit()

    db.execute("PRAGMA incremental_vacuum(2000)")
    db.commit()


def main():
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        stream=sys.stdout,
    )
    src = "airplanes.live" if SOURCE == "airplanes" else SOURCE
    log.info("collector starting: %s, %.0f nm around %.4f,%.4f every %ds -> %s",
             src, RADIUS_NM, LAT, LON, POLL_SECONDS, DB_PATH)

    db = open_db()
    running = True

    def stop(*_):
        nonlocal running
        running = False

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    last_prune = 0
    errors = 0
    while running:
        started = time.time()
        now = int(started)
        try:
            aircraft = fetch_aircraft()
            n = store(db, aircraft, now)
            errors = 0
            log.debug("stored %d/%d aircraft", n, len(aircraft))
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError,
                ConnectionError, json.JSONDecodeError) as e:
            errors += 1
            set_meta(db, "last_poll", now)
            set_meta(db, "last_error", f"{now}: {e}")
            db.commit()
            log.warning("fetch failed (%d in a row): %s", errors, e)

        if now - last_prune > 3600:
            prune(db, now)
            last_prune = now

        # back off gently on repeated failures (rate limit / outage)
        delay = POLL_SECONDS * min(8, 1 + errors)
        time.sleep(max(1, delay - (time.time() - started)))

    db.close()
    log.info("collector stopped")


if __name__ == "__main__":
    main()
