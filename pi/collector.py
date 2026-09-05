#!/usr/bin/env python3
"""KANP traffic collector.

Polls the public ADS-B aggregators (adsb.lol → adsb.fi → airplanes.live, or a
local dump1090-fa/readsb/tar1090 instance) for aircraft around Lee Airport
(KANP) and stores positions in a local SQLite database for traffic-study
analysis. Two polls: 60 nm every 3 s on the main thread, 5 nm every second on
its own thread (paused while a wide fetch is in flight). Every poll is
accounted for — see Stats — and summarised once a minute in the journal.

Stdlib only — no pip packages required.

Configuration is via environment variables (see DEFAULTS below), so the
systemd unit can override anything without editing this file.
"""

import http.client
import json
import logging
import math
import os
import signal
import socket
import sqlite3
import sys
import threading
import time
import traceback
import urllib.error
import urllib.parse
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
    # Per-request timeouts. A 5 nm answer that takes longer than this is
    # worthless to a 1 Hz poll — skip to the next feed rather than wait; the
    # old 20 s timeout let one slow feed stall every poll for 20 s.
    "KANP_NEAR_TIMEOUT_S": "3",
    "KANP_WIDE_TIMEOUT_S": "10",
    # A feed that answered 429 is left alone for this long (its fallbacks take
    # the polls meanwhile).
    "KANP_FEED_COOLDOWN_S": "3",
    # Comma-separated feed URL templates ({lat} {lon} {r}) for the "airplanes"
    # source, tried in order. Default = adsb.lol → adsb.fi → airplanes.live.
    "KANP_FEEDS": "",
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
NEAR_TIMEOUT_S = float(cfg("KANP_NEAR_TIMEOUT_S"))
WIDE_TIMEOUT_S = float(cfg("KANP_WIDE_TIMEOUT_S"))
FEED_COOLDOWN_S = float(cfg("KANP_FEED_COOLDOWN_S"))
# A position older than this (feed `seen_pos`) is a stale entry the aggregator
# hasn't dropped yet — an earlier poll already stored it, or the aircraft is
# gone. Never worth a row.
MAX_POS_AGE_S = 300

# Public readsb "re-api" feeds for the "airplanes" source, tried in order until
# one answers with an {ac:[…]} / {aircraft:[…]} body. All share the same schema.
# Mirrors KANP.LIVE_SOURCES in js/kanp.js.
DEFAULT_FEEDS = [
    "https://api.adsb.lol/v2/point/{lat}/{lon}/{r}",
    "https://opendata.adsb.fi/api/v2/lat/{lat}/lon/{lon}/dist/{r}",
    "https://api.airplanes.live/v2/point/{lat}/{lon}/{r}",
]
FEED_TEMPLATES = [u.strip() for u in cfg("KANP_FEEDS").split(",") if u.strip()] or DEFAULT_FEEDS


def feed_urls(radius_nm):
    return [t.format(lat=LAT, lon=LON, r=f"{radius_nm:g}") for t in FEED_TEMPLATES]


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


# ---------------------------------------------------------------------------
# Poll accounting. The collector used to log only when every feed failed at
# once, so a day where a quarter of the polls stored nothing left no trace in
# the journal (2026-09-05: 979 collector-wide stalls of 8-100 s, 25 % of the
# day, zero log lines). Every poll now counts: which feed answered, how long
# it took, how many rows it stored, 429s and errors per feed, slow DNS
# lookups — summarised once a minute in the journal and in meta.poll_stats.
# ---------------------------------------------------------------------------
class Stats:
    def __init__(self):
        self.lock = threading.Lock()
        self.reset()

    def reset(self):
        self.since = time.time()
        self.feeds = {}          # (kind, feed) -> counters
        self.polls = {"near": 0, "wide": 0}
        self.rows = {"near": 0, "wide": 0}
        self.zero = {"near": 0, "wide": 0}   # polls that returned aircraft but stored nothing
        self.fail = {"near": 0, "wide": 0}   # polls no feed could answer
        self.max_ms = {"near": 0, "wide": 0}
        self.dns_slow = 0
        self.dns_max_ms = 0

    def feed(self, kind, name, key, ms=None):
        with self.lock:
            c = self.feeds.setdefault((kind, name), {"ok": 0, "r429": 0, "err": 0, "empty": 0, "ms": 0})
            c[key] += 1
            if ms is not None:
                c["ms"] = max(c["ms"], ms)
                self.max_ms[kind] = max(self.max_ms[kind], ms)

    def poll(self, kind, returned, stored):
        with self.lock:
            self.polls[kind] += 1
            self.rows[kind] += stored
            if returned and not stored:
                self.zero[kind] += 1

    def failed(self, kind):
        with self.lock:
            self.fail[kind] += 1

    def dns(self, ms):
        with self.lock:
            self.dns_max_ms = max(self.dns_max_ms, ms)
            if ms > 1000:
                self.dns_slow += 1

    def snapshot(self):
        with self.lock:
            span = max(1.0, time.time() - self.since)
            feeds = {}
            for (kind, name), c in self.feeds.items():
                feeds.setdefault(name, {})[kind] = dict(c)
            snap = {
                "window_s": round(span), "polls": dict(self.polls), "rows": dict(self.rows),
                "zero_row_polls": dict(self.zero), "all_feeds_failed": dict(self.fail),
                "max_fetch_ms": dict(self.max_ms), "dns_slow": self.dns_slow,
                "dns_max_ms": self.dns_max_ms, "feeds": feeds,
            }
            self.reset()
            return snap

    def snapshot_feeds(self):
        with self.lock:
            return {name: c for (kind, name), c in self.feeds.items() if c["ok"]}

    @staticmethod
    def line(snap):
        parts = []
        for kind in ("wide", "near"):
            fs = " ".join(f"{n}:{c[kind]['ok']}" + (f"/429×{c[kind]['r429']}" if c[kind]["r429"] else "")
                          + (f"/err×{c[kind]['err']}" if c[kind]["err"] else "")
                          for n, c in snap["feeds"].items() if kind in c)
            parts.append(f"{kind} {snap['polls'][kind]} polls {snap['rows'][kind]} rows "
                         f"zero-row {snap['zero_row_polls'][kind]} failed {snap['all_feeds_failed'][kind]} "
                         f"max {snap['max_fetch_ms'][kind]} ms [{fs}]")
        dns = f" · dns max {snap['dns_max_ms']} ms" + (f" slow×{snap['dns_slow']}" if snap["dns_slow"] else "")
        return f"poll stats {snap['window_s']} s: " + " · ".join(parts) + dns


STATS = Stats()

# DNS: urllib/http.client resolve the host on every connection, and a socket
# timeout does not cover getaddrinfo — a flaky resolver hangs a poll for its
# own 5-30 s. Cache answers for ten minutes and time every real lookup.
_dns_cache = {}
_dns_lock = threading.Lock()
_real_getaddrinfo = socket.getaddrinfo


def _cached_getaddrinfo(host, port, *args, **kwargs):
    key = (host, port, args, tuple(sorted(kwargs.items())))
    now = time.time()
    with _dns_lock:
        hit = _dns_cache.get(key)
    if hit and hit[0] > now:
        return hit[1]
    t0 = time.time()
    res = _real_getaddrinfo(host, port, *args, **kwargs)
    STATS.dns(int((time.time() - t0) * 1000))
    with _dns_lock:
        _dns_cache[key] = (now + 600, res)
    return res


socket.getaddrinfo = _cached_getaddrinfo


class RateLimited(Exception):
    pass


class Feed:
    """One upstream, polled over a persistent connection.

    A fresh TLS handshake per poll cost ~0.6 s on the Pi (measured with curl
    2026-09-05) — most of a 1 Hz near poll's budget. Keep the connection open
    and reuse it; drop it on any error and reconnect next time.
    """

    def __init__(self, template):
        self.template = template
        u = urllib.parse.urlsplit(template.format(lat=LAT, lon=LON, r=1))
        self.name = u.hostname or template
        self.scheme = u.scheme
        self.host = u.hostname
        self.port = u.port
        self.conn = None
        self.cooldown_until = 0.0

    def url_path(self, radius_nm):
        u = urllib.parse.urlsplit(self.template.format(lat=LAT, lon=LON, r=f"{radius_nm:g}"))
        return u.path + (f"?{u.query}" if u.query else "")

    def _connect(self, timeout):
        cls = http.client.HTTPSConnection if self.scheme == "https" else http.client.HTTPConnection
        self.conn = cls(self.host, self.port, timeout=timeout)

    def close(self):
        if self.conn is not None:
            try:
                self.conn.close()
            except Exception:
                pass
            self.conn = None

    def fetch(self, radius_nm, timeout):
        path = self.url_path(radius_nm)
        headers = {"User-Agent": "kanp-tracker-collector/1.1", "Accept": "application/json"}
        for attempt in (1, 2):
            fresh = self.conn is None
            if fresh:
                self._connect(timeout)
            else:
                self.conn.timeout = timeout
                if self.conn.sock is not None:
                    self.conn.sock.settimeout(timeout)
            try:
                self.conn.request("GET", path, headers=headers)
                resp = self.conn.getresponse()
                body = resp.read()
                break
            except (http.client.RemoteDisconnected, http.client.BadStatusLine,
                    ConnectionResetError, BrokenPipeError) as e:
                # A kept-alive connection the server closed meanwhile — one
                # retry on a fresh socket. Never retry a timeout (it would
                # double the wait) or a fresh connection's failure.
                self.close()
                if fresh or attempt == 2:
                    raise
                log.debug("%s: reconnecting after %s", self.name, e.__class__.__name__)
            except Exception:
                self.close()
                raise
        if resp.status == 429:
            self.cooldown_until = time.time() + FEED_COOLDOWN_S
            raise RateLimited(f"{self.name}: 429")
        if resp.status != 200:
            self.close()
            raise urllib.error.HTTPError(self.name, resp.status, resp.reason, resp.headers, None)
        return json.loads(body)


def make_feeds():
    if SOURCE != "airplanes":
        return [Feed(SOURCE.replace("{", "{{").replace("}", "}}"))]
    feeds = [Feed(t) for t in FEED_TEMPLATES]
    # stats are keyed by name — two feeds on one host (test stubs) get their path
    names = [f.name for f in feeds]
    for f in feeds:
        if names.count(f.name) > 1:
            f.name = f"{f.name}{urllib.parse.urlsplit(f.template).path.split('{')[0].rstrip('/')}"
    return feeds


def fetch_aircraft(feeds, radius_nm, timeout, empty_ok=False, kind="wide"):
    """Return (aircraft list, feed name) from the first feed that answers.

    Feeds are tried in order so one 404ing, 429ing or going down doesn't halt
    collection; a feed inside its 429 cooldown is skipped without a request.
    empty_ok: an empty list is a believable answer (the near poll — nobody
    in the pattern at 3 AM is normal) rather than a degraded feed.
    """
    last_err = None
    empty = None
    now = time.time()
    for f in feeds:
        if f.cooldown_until > now:
            continue
        t0 = time.time()
        try:
            data = f.fetch(radius_nm, timeout)
        except RateLimited as e:
            STATS.feed(kind, f.name, "r429")
            last_err = e
            continue
        except Exception as e:  # network / HTTP / timeout — try the next feed
            STATS.feed(kind, f.name, "err", int((time.time() - t0) * 1000))
            last_err = e
            continue
        ms = int((time.time() - t0) * 1000)
        if "ac" in data or "aircraft" in data:
            ac = data.get("ac") or data.get("aircraft") or []
            if ac or empty_ok:
                STATS.feed(kind, f.name, "ok", ms)
                return ac, f.name
            # A well-formed 200 with zero aircraft is almost certainly a
            # degraded feed, not empty sky — 60 nm around KANP includes BWI
            # and DCA. Keep trying the other feeds before believing it
            # (2026-08-01: adsb.lol served empty 200s for 11 h and masked
            # the healthy feeds behind it).
            STATS.feed(kind, f.name, "empty", ms)
            if empty is None:
                empty = (ac, f.name)
        else:
            STATS.feed(kind, f.name, "err", ms)
            last_err = ValueError(f"{f.name}: no ac/aircraft key in response")
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
STORE_LOCK = threading.Lock()   # near and wide threads both write; the dedupe map is shared
LAST_STORED = [0.0]             # wall time a poll last stored a row (the stall detector reads it)


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
    with STORE_LOCK:
        return _store(db, aircraft, now, wide)


def _store(db, aircraft, now, wide):
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
    if inserted:
        LAST_STORED[0] = time.time()
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


# The near poll runs on its own thread with its own DB connection: the old
# single loop ran it between wide polls, so a slow wide fetch (300 aircraft,
# up to 20 s of timeout) silently delayed or skipped the 1 Hz fixes the ring
# exists for. It pauses while a wide fetch is in flight so the request budget
# stays where it was (~2 near + 1 wide per 3 s ≈ the feeds' 1 req/s).
WIDE_BUSY = threading.Event()


def near_loop(stop):
    db = open_db()
    feeds = make_feeds()
    nxt = time.time()
    last_warn = 0.0
    while not stop.is_set():
        started = time.time()
        now = int(started)
        if not WIDE_BUSY.is_set():
            try:
                aircraft, _feed = fetch_aircraft(feeds, NEAR_RADIUS_NM, NEAR_TIMEOUT_S,
                                                 empty_ok=True, kind="near")
                n = store(db, aircraft, now, wide=False)
                STATS.poll("near", len(aircraft), n)
            except Exception as e:  # noqa: BLE001 — the thread must never die
                STATS.failed("near")
                if started - last_warn > 60:
                    last_warn = started
                    log.warning("near fetch failed on every feed: %s", e)
        nxt = max(nxt + NEAR_POLL_SECONDS, started + 0.2)
        stop.wait(max(0.05, nxt - time.time()))
    db.close()


def main():
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        stream=sys.stdout,
    )
    src = "public ADS-B feeds" if SOURCE == "airplanes" else SOURCE
    log.info("collector starting: %s, %g nm around %.4f,%.4f every %ds (timeout %gs) -> %s",
             src, RADIUS_NM, LAT, LON, POLL_SECONDS, WIDE_TIMEOUT_S, DB_PATH)
    if SOURCE == "airplanes":
        log.info("feeds in order: %s", ", ".join(Feed(t).name for t in FEED_TEMPLATES))
    if NEAR_ENABLED:
        log.info("near poll: %g nm every %ds between wide polls (timeout %gs)",
                 NEAR_RADIUS_NM, NEAR_POLL_SECONDS, NEAR_TIMEOUT_S)
    elif NEAR_RADIUS_NM > 0 and SOURCE != "airplanes":
        log.info("near poll skipped: local receiver source, lower KANP_POLL_SECONDS instead")

    db = open_db()
    feeds = make_feeds()
    set_meta(db, "started", int(time.time()))
    db.commit()

    stop = threading.Event()

    def stop_handler(*_):
        stop.set()

    signal.signal(signal.SIGTERM, stop_handler)
    signal.signal(signal.SIGINT, stop_handler)

    near_thread = None
    if NEAR_ENABLED:
        near_thread = threading.Thread(target=near_loop, args=(stop,), name="near", daemon=True)
        near_thread.start()

    last_prune = 0
    last_stats = time.time()
    errors = 0
    empty_polls = 0
    stall_warned = False
    LAST_STORED[0] = time.time()
    while not stop.is_set():
        started = time.time()
        now = int(started)
        try:
            WIDE_BUSY.set()
            try:
                aircraft, feed = fetch_aircraft(feeds, RADIUS_NM, WIDE_TIMEOUT_S, kind="wide")
            finally:
                WIDE_BUSY.clear()
            n = store(db, aircraft, now, wide=True)
            STATS.poll("wide", len(aircraft), n)
            errors = 0
            # Empty sky never actually happens here (BWI/DCA are in radius) —
            # a sustained run of empty 200s means every feed is degraded, and
            # it must not stay silent (it left no journal trace on 2026-08-01).
            if aircraft:
                if empty_polls >= 20:
                    log.info("aircraft data resumed after %d empty polls", empty_polls)
                empty_polls = 0
            else:
                empty_polls += 1
                if empty_polls == 20 or empty_polls % 1200 == 0:
                    log.warning("all feeds returning empty responses (%d polls in a row)",
                                empty_polls)
            log.debug("stored %d/%d aircraft (wide, %s)", n, len(aircraft), feed)
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, RateLimited,
                ConnectionError, OSError, json.JSONDecodeError, ValueError, RuntimeError) as e:
            errors += 1
            STATS.failed("wide")
            set_meta(db, "last_poll", now)
            set_meta(db, "last_error", f"{now}: {e}")
            db.commit()
            log.warning("wide fetch failed on every feed (%d in a row): %s", errors, e)
        except Exception:  # noqa: BLE001 — log and keep polling, never crash-loop
            errors += 1
            log.error("unexpected error in wide poll:\n%s", traceback.format_exc())

        # Stall detector: polls are answering but nothing new is being stored.
        quiet = time.time() - LAST_STORED[0]
        if quiet > 15 and not stall_warned:
            stall_warned = True
            log.warning("no new position stored for %.0f s (feeds answering: %s)", quiet,
                        ", ".join(f"{n}" for n, c in STATS.snapshot_feeds().items()) or "none")
        elif quiet < 5:
            stall_warned = False

        if now - last_prune > 3600:
            prune(db, now)
            last_prune = now

        if started - last_stats >= 60:
            last_stats = started
            snap = STATS.snapshot()
            log.info(Stats.line(snap))
            set_meta(db, "poll_stats", json.dumps(snap, separators=(",", ":")))
            db.commit()

        # back off gently on repeated failures (rate limit / outage)
        backoff = min(8, 1 + errors)
        next_wide = started + POLL_SECONDS * backoff
        stop.wait(max(0.1, next_wide - time.time()))

    if near_thread is not None:
        near_thread.join(timeout=5)
    db.close()
    log.info("collector stopped")


if __name__ == "__main__":
    main()
