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
    "KANP_RADIUS_NM": "60",
    # "airplanes" = public ADS-B API feeds (adsb.lol / adsb.fi / airplanes.live,
    # whichever answers first); anything starting with http = local receiver
    # aircraft.json URL, e.g. http://127.0.0.1/skyaware/data/aircraft.json
    "KANP_SOURCE": "airplanes",
    "KANP_POLL_SECONDS": "3",
    # A second, tight poll of just the pattern area, run between wide polls.
    # The public feeds ask for ~1 req/s and a 60 nm answer is hundreds of
    # aircraft, so the wide poll can't go faster than 3 s — but a 5 nm answer
    # is a handful, so it can run every second in the gaps (2 near + 1 wide
    # per 3 s = 1 req/s). That is what gives the pattern 1 s fixes instead
    # of 3 s ones. Only for the public feeds (a local receiver is one call
    # for everything — just lower KANP_POLL_SECONDS). 0 disables.
    "KANP_NEAR_RADIUS_NM": "5",
    "KANP_NEAR_POLL_SECONDS": "1",
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
POLL_SECONDS = max(1, int(cfg("KANP_POLL_SECONDS")))
DB_PATH = cfg("KANP_DB")
RETENTION_DAYS = int(cfg("KANP_RETENTION_DAYS"))
MAX_DB_MB = int(cfg("KANP_MAX_DB_MB"))
STATIONARY_SECONDS = int(cfg("KANP_STATIONARY_SECONDS"))
NEAR_RADIUS_NM = float(cfg("KANP_NEAR_RADIUS_NM"))
NEAR_POLL_SECONDS = max(1, int(cfg("KANP_NEAR_POLL_SECONDS")))
NEAR_ENABLED = (SOURCE == "airplanes" and NEAR_RADIUS_NM > 0
                and NEAR_POLL_SECONDS < POLL_SECONDS)
# A position older than this (feed `seen_pos`) is a stale entry the aggregator
# hasn't dropped yet — an earlier poll already stored it, or the aircraft is
# gone. Never worth a row.
MAX_POS_AGE_S = 300

# Public readsb "re-api" feeds for the "airplanes" source, tried in order until
# one answers with an {ac:[…]} / {aircraft:[…]} body. All share the same schema.
# airplanes.live is kept last: as of 2026 its /v2/point endpoint 404s, but it's
# harmless as a fallback if it returns. Mirrors KANP.LIVE_SOURCES in js/kanp.js.
def feed_urls(radius_nm):
    return [
        f"https://api.adsb.lol/v2/point/{LAT}/{LON}/{radius_nm:g}",
        f"https://opendata.adsb.fi/api/v2/lat/{LAT}/lon/{LON}/dist/{radius_nm:g}",
        f"https://api.airplanes.live/v2/point/{LAT}/{LON}/{radius_nm:g}",
    ]


API_FEEDS = feed_urls(RADIUS_NM)

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


def _fetch_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "kanp-tracker-collector/1.0"})
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.load(resp)


def fetch_aircraft(radius_nm=RADIUS_NM, empty_ok=False):
    """Return list of aircraft dicts from the configured source.

    For a local receiver URL there's a single source. For "airplanes" we try
    the public feeds in order and use the first that returns a well-formed
    response, so one feed 404ing or going down doesn't halt collection.
    empty_ok: an empty list is a believable answer (the near poll — nobody
    in the pattern at 3 AM is normal) rather than a degraded feed.
    """
    # airplanes.live/adsb.lol use "ac"; dump1090/readsb/tar1090 use "aircraft"
    if SOURCE != "airplanes":
        data = _fetch_json(SOURCE)
        return data.get("ac") or data.get("aircraft") or []

    last_err = None
    empty = None
    for url in feed_urls(radius_nm):
        try:
            data = _fetch_json(url)
        except Exception as e:  # network / HTTP error — try the next feed
            last_err = e
            continue
        if "ac" in data or "aircraft" in data:
            ac = data.get("ac") or data.get("aircraft") or []
            if ac or empty_ok:
                return ac
            # A well-formed 200 with zero aircraft is almost certainly a
            # degraded feed, not empty sky — 60 nm around KANP includes BWI
            # and DCA. Keep trying the other feeds before believing it
            # (2026-08-01: adsb.lol served empty 200s for 11 h and masked
            # the healthy feeds behind it).
            empty = ac
        else:
            last_err = ValueError(f"{url}: no ac/aircraft key in response")
    if empty is not None:
        return empty
    raise last_err or RuntimeError("no ADS-B feed reachable")


def set_meta(db, key, value):
    db.execute(
        "INSERT INTO meta(key, value) VALUES(?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, str(value)),
    )


# hex -> (lat, lon, last_insert_wall_ts, last_fix_ts): downsamples stationary
# aircraft and drops the fix a previous poll already stored
_last_pos = {}


def fix_time(a, now):
    """The moment the feed received this position, or None if it's stale.

    The feeds report each position's age (`seen_pos`, seconds). Stamping the
    fix with the poll time instead smears every fix up to a poll interval
    late, which bends turns and slews speeds along a pattern — and the near
    and wide polls would stamp the same fix at two different times.
    """
    age = a.get("seen_pos")
    if not isinstance(age, (int, float)) or age < 0:
        return now
    if age > MAX_POS_AGE_S:
        return None
    return int(round(now - age))


def store(db, aircraft, now, wide=True):
    inserted = 0
    for a in aircraft:
        lat, lon, hexid = a.get("lat"), a.get("lon"), a.get("hex")
        if lat is None or lon is None or not hexid:
            continue
        ts = fix_time(a, now)
        if ts is None:
            continue

        alt_raw = a.get("alt_baro")
        on_ground = 1 if alt_raw == "ground" else 0
        alt = alt_raw if isinstance(alt_raw, (int, float)) else None

        prev = _last_pos.get(hexid)
        moved = prev is None or abs(prev[0] - lat) > 1e-5 or abs(prev[1] - lon) > 1e-5
        if not moved:
            # Same position as the last row. Either the feed is still holding
            # the fix already stored — its stamp hasn't advanced; the near and
            # wide polls overlap by design, so this is the common case — or a
            # parked aircraft really is re-reporting it, kept once per
            # STATIONARY_SECONDS so a ramp full of ADS-B doesn't flood the DB.
            if ts <= prev[3] or now - prev[2] < STATIONARY_SECONDS:
                continue
        _last_pos[hexid] = (lat, lon, now, ts)

        dbflags = a.get("dbFlags") or 0
        military = 1 if dbflags & 1 else 0
        flight = (a.get("flight") or "").strip() or None

        db.execute(
            "INSERT INTO positions(ts, hex, flight, lat, lon, alt, gs, track,"
            " baro_rate, squawk, category, dist_nm, on_ground, military)"
            " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                ts, hexid, flight, lat, lon,
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

    # Health keys describe the wide poll; a near poll succeeding while the
    # wide one fails must not read as healthy, so it keeps its own keys.
    if wide:
        set_meta(db, "last_poll", now)
        set_meta(db, "last_ok", now)
        set_meta(db, "last_count", len(aircraft))
    else:
        set_meta(db, "last_near_poll", now)
        set_meta(db, "last_near_count", len(aircraft))
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
    src = "public ADS-B feeds" if SOURCE == "airplanes" else SOURCE
    log.info("collector starting: %s, %.0f nm around %.4f,%.4f every %ds -> %s",
             src, RADIUS_NM, LAT, LON, POLL_SECONDS, DB_PATH)
    if NEAR_ENABLED:
        log.info("near poll: %g nm every %ds between wide polls",
                 NEAR_RADIUS_NM, NEAR_POLL_SECONDS)
    elif NEAR_RADIUS_NM > 0 and SOURCE != "airplanes":
        log.info("near poll skipped: local receiver source, lower KANP_POLL_SECONDS instead")

    db = open_db()
    running = True

    def stop(*_):
        nonlocal running
        running = False

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    last_prune = 0
    errors = 0
    empty_polls = 0
    next_wide = 0.0
    next_near = 0.0
    while running:
        started = time.time()
        now = int(started)
        # The wide poll covers the near area too, so on a tick where both are
        # due only the wide one runs.
        wide = started >= next_wide
        try:
            if wide:
                aircraft = fetch_aircraft(RADIUS_NM)
            else:
                aircraft = fetch_aircraft(NEAR_RADIUS_NM, empty_ok=True)
            n = store(db, aircraft, now, wide=wide)
            errors = 0
            # Empty sky never actually happens here (BWI/DCA are in radius) —
            # a sustained run of empty 200s means every feed is degraded, and
            # it must not stay silent (it left no journal trace on 2026-08-01).
            # Only the wide poll can say so; an empty near poll is a quiet
            # pattern.
            if not wide:
                pass
            elif aircraft:
                if empty_polls >= 20:
                    log.info("aircraft data resumed after %d empty polls", empty_polls)
                empty_polls = 0
            else:
                empty_polls += 1
                if empty_polls == 20 or empty_polls % 1200 == 0:
                    log.warning("all feeds returning empty responses (%d polls in a row)",
                                empty_polls)
            log.debug("stored %d/%d aircraft (%s)", n, len(aircraft),
                      "wide" if wide else "near")
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError,
                ConnectionError, json.JSONDecodeError) as e:
            errors += 1
            if wide:
                set_meta(db, "last_poll", now)
            set_meta(db, "last_error", f"{now}: {e}")
            db.commit()
            log.warning("%s fetch failed (%d in a row): %s",
                        "wide" if wide else "near", errors, e)

        if now - last_prune > 3600:
            prune(db, now)
            last_prune = now

        # back off gently on repeated failures (rate limit / outage)
        backoff = min(8, 1 + errors)
        if wide:
            next_wide = started + POLL_SECONDS * backoff
        wake = next_wide
        if NEAR_ENABLED:
            next_near = started + NEAR_POLL_SECONDS * backoff
            wake = min(next_wide, next_near)
        time.sleep(max(0.1, wake - time.time()))

    db.close()
    log.info("collector stopped")


if __name__ == "__main__":
    main()
