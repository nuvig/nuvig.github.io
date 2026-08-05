"""Mirror the Pi's kanp.db to a local SQLite file via the tracker API.

The Pi (pi/server.py) exposes the SQLite DB read-only over HTTP. This module
rebuilds a faithful local copy so analysis never touches the live database:

  positions  <- GET /api/export.csv  (raw, full-resolution rows, windowed —
                the endpoint caps at 500k rows/request, so we fetch in time
                windows and bisect any window that hits the cap)
  aircraft   <- GET /api/aircraft    (registration / type / description)
  meta       <- mirror provenance (source API, window, fetch time)

The local schema matches pi/collector.py exactly, so every downstream module
also works unchanged against a scp'd copy of the real /var/lib/kanp/kanp.db.

Stdlib only. Resumable: completed windows are recorded in _mirror_windows;
a re-run deletes any partial leftovers in uncovered spans and refetches only
those spans.

    python -m kanpops.mirror --api http://192.168.1.250:8787 \
        --db analysis/data/kanp_mirror.db
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
import time
import urllib.parse
import urllib.request

MAX_CSV_ROWS = 500_000          # pi/server.py MAX_CSV_ROWS — keep in sync
MIN_WINDOW_S = 300              # never bisect below 5 minutes
CSV_COLS = 17                   # fixed column count of /api/export.csv
BATCH = 20_000

# Same schema as pi/collector.py. idx_pos_ts is created at load time: window
# rows arrive in ts order, so maintaining it is a cheap rightmost-append and
# it makes the truncation/resume range-DELETEs O(log n) instead of full scans.
# idx_pos_hex_ts waits until finalize().
SCHEMA = """
CREATE TABLE IF NOT EXISTS positions (
    id        INTEGER PRIMARY KEY,
    ts        INTEGER NOT NULL,
    hex       TEXT    NOT NULL,
    flight    TEXT,
    lat       REAL    NOT NULL,
    lon       REAL    NOT NULL,
    alt       INTEGER,
    gs        REAL,
    track     REAL,
    baro_rate INTEGER,
    squawk    TEXT,
    category  TEXT,
    dist_nm   REAL,
    on_ground INTEGER NOT NULL DEFAULT 0,
    military  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_pos_ts ON positions(ts);
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
CREATE TABLE IF NOT EXISTS _mirror_windows (
    start INTEGER NOT NULL,
    end   INTEGER NOT NULL,
    rows  INTEGER NOT NULL,
    PRIMARY KEY (start, end)
);
"""


def _get_json(api: str, path: str, params: dict | None = None, timeout: int = 300):
    url = api.rstrip("/") + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": "kanpops-mirror/0.1"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.load(resp)


def _f(v: str):
    return float(v) if v else None


def _i(v: str):
    return int(v) if v else None


def fetch_window(api: str, start: int, end: int, timeout: int = 600):
    """Yield positions-row tuples for ts in [start, end] (inclusive).

    Yields None for a malformed line (the export CSV is a naive comma join
    with no quoting, so a stray comma in a field breaks the column count —
    better to skip and count than to mis-parse).
    """
    url = (api.rstrip("/") + "/api/export.csv?"
           + urllib.parse.urlencode({"start": start, "end": end}))
    req = urllib.request.Request(url, headers={"User-Agent": "kanpops-mirror/0.1"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        header = resp.readline()  # column header
        if not header.startswith(b"ts_utc,"):
            raise RuntimeError(f"unexpected export header: {header[:80]!r}")
        for raw in resp:
            parts = raw.decode("utf-8", "replace").rstrip("\r\n").split(",")
            if len(parts) != CSV_COLS:
                yield None
                continue
            # 0 ts_utc, 1 local_time, 2 hex, 3 flight, 4 reg, 5 type, 6 lat,
            # 7 lon, 8 alt_ft, 9 gs_kts, 10 track, 11 baro_rate, 12 squawk,
            # 13 category, 14 dist_nm, 15 on_ground, 16 military
            p = parts
            yield (int(p[0]), p[2], p[3] or None, float(p[6]), float(p[7]),
                   _i(p[8]), _f(p[9]), _f(p[10]), _i(p[11]), p[12] or None,
                   p[13] or None, _f(p[14]), int(p[15]), int(p[16]))


INSERT_SQL = ("INSERT INTO positions(ts, hex, flight, lat, lon, alt, gs, track,"
              " baro_rate, squawk, category, dist_nm, on_ground, military)"
              " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")


def _uncovered_gaps(db: sqlite3.Connection, start: int, end: int):
    """Sub-ranges of [start, end] not yet covered by completed windows."""
    ivals = sorted(
        (max(s, start), min(e, end)) for s, e in
        db.execute("SELECT start, end FROM _mirror_windows"
                   " WHERE end >= ? AND start <= ?", (start, end)))
    gaps, cursor = [], start
    for s, e in ivals:
        if s > cursor:
            gaps.append((cursor, s - 1))
        cursor = max(cursor, e + 1)
    if cursor <= end:
        gaps.append((cursor, end))
    return gaps


def mirror_positions(db: sqlite3.Connection, api: str, start: int, end: int,
                     window_s: int = 6 * 3600, log=print) -> int:
    """Fetch [start, end] inclusive into the local DB. Returns total rows.

    Windows that return exactly MAX_CSV_ROWS are treated as truncated and
    bisected. Only spans not already recorded in _mirror_windows are fetched;
    partial leftovers from an interrupted run are deleted first.
    """
    gaps = _uncovered_gaps(db, start, end)
    span = sum(e - s + 1 for s, e in gaps)
    if not span:
        log("  nothing to fetch — window already mirrored")
        return db.execute("SELECT COUNT(*) FROM positions").fetchone()[0]

    stack = []  # LIFO, pushed in reverse so pop() walks forward in time
    for g_start, g_end in gaps:
        # clear partial rows from a previously interrupted fetch of this gap
        db.execute("DELETE FROM positions WHERE ts BETWEEN ? AND ?",
                   (g_start, g_end))
        t = g_start
        while t <= g_end:
            w_end = min(t + window_s - 1, g_end)
            stack.append((t, w_end))
            t = w_end + 1
    db.commit()
    stack.reverse()

    total = db.execute("SELECT COUNT(*) FROM positions").fetchone()[0]
    t0 = time.time()
    fetched_span = 0

    while stack:
        w_start, w_end = stack.pop()
        w_span = w_end - w_start + 1

        rows, bad, batch = 0, 0, []
        for tup in fetch_window(api, w_start, w_end):
            if tup is None:
                bad += 1
                continue
            batch.append(tup)
            rows += 1
            if len(batch) >= BATCH:
                db.executemany(INSERT_SQL, batch)
                batch.clear()

        if rows >= MAX_CSV_ROWS and w_span > MIN_WINDOW_S:
            # possibly truncated — drop what we inserted and bisect
            db.execute("DELETE FROM positions WHERE ts BETWEEN ? AND ?",
                       (w_start, w_end))
            db.commit()
            mid = w_start + w_span // 2
            stack.append((mid, w_end))        # popped second
            stack.append((w_start, mid - 1))  # popped first
            log(f"  window {_ts(w_start)}..{_ts(w_end)} hit {MAX_CSV_ROWS:,}"
                f" rows — bisecting")
            continue

        if batch:
            db.executemany(INSERT_SQL, batch)
        db.execute("INSERT OR REPLACE INTO _mirror_windows(start, end, rows)"
                   " VALUES(?,?,?)", (w_start, w_end, rows))
        db.commit()
        total += rows
        fetched_span += w_span
        pct = 100.0 * fetched_span / span
        rate = fetched_span / max(1e-9, time.time() - t0)
        eta_min = (span - fetched_span) / max(1e-9, rate) / 60
        log(f"  {_ts(w_start)}..{_ts(w_end)}  +{rows:>7,} rows"
            f"  (total {total:>10,}, {pct:5.1f}%, ETA {eta_min:4.0f} min"
            + (f", {bad} malformed skipped" if bad else "") + ")")
    return total


def mirror_aircraft(db: sqlite3.Connection, api: str, start: int, end: int,
                    log=print) -> int:
    log("fetching aircraft table (one heavy GROUP BY on the Pi — be patient)…")
    data = _get_json(api, "/api/aircraft", {"start": start, "end": end},
                     timeout=600)
    rows = [(a["hex"], a.get("reg"), a.get("type"), a.get("descr"),
             a.get("military") or 0, a.get("first_ts"), a.get("last_ts"))
            for a in data["aircraft"]]
    db.executemany(
        "INSERT OR REPLACE INTO aircraft(hex, reg, type, descr, military,"
        " first_seen, last_seen) VALUES(?,?,?,?,?,?,?)", rows)
    db.commit()
    return len(rows)


def finalize(db: sqlite3.Connection, api: str, start: int, end: int, log=print):
    log("creating hex,ts index…")
    db.execute("CREATE INDEX IF NOT EXISTS idx_pos_hex_ts ON positions(hex, ts)")
    for k, v in (("mirror_source", api), ("mirror_start", start),
                 ("mirror_end", end), ("mirror_fetched_utc", int(time.time()))):
        db.execute("INSERT OR REPLACE INTO meta(key, value) VALUES(?,?)",
                   (k, str(v)))
    db.commit()
    db.execute("PRAGMA optimize")


def verify(db: sqlite3.Connection, api: str, start: int, end: int, log=print):
    """Cross-check local row count against the Pi for the mirrored window."""
    local = db.execute("SELECT COUNT(*) FROM positions WHERE ts BETWEEN ? AND ?",
                       (start, end)).fetchone()[0]
    data = _get_json(api, "/api/aircraft", {"start": start, "end": end},
                     timeout=600)
    remote = sum(a["samples"] for a in data["aircraft"])
    ok = local == remote
    log(f"verify: local {local:,} rows vs Pi {remote:,} for the same window"
        f" — {'OK' if ok else 'MISMATCH'}")
    return ok, local, remote


def _ts(t: int) -> str:
    return time.strftime("%m-%d %H:%M", time.gmtime(t)) + "Z"


def open_mirror(path: str) -> sqlite3.Connection:
    db = sqlite3.connect(path, timeout=60)
    # rebuildable mirror — favor bulk-load speed over durability
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA synchronous=OFF")
    db.executescript(SCHEMA)
    db.commit()
    return db


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--api", required=True, help="Pi API base, e.g. http://192.168.1.250:8787")
    ap.add_argument("--db", required=True, help="local mirror SQLite path")
    ap.add_argument("--window-hours", type=float, default=6.0)
    ap.add_argument("--start", type=int, help="unix start (default: oldest on Pi)")
    ap.add_argument("--end", type=int, help="unix end (default: newest on Pi at launch)")
    args = ap.parse_args(argv)

    status = _get_json(args.api, "/api/status", timeout=60)
    start = args.start or int(status["oldest"])
    end = args.end or int(status["newest"])
    print(f"Pi reports {status['positions']:,} positions,"
          f" {status['aircraft_seen']:,} aircraft,"
          f" {_ts(int(status['oldest']))} .. {_ts(int(status['newest']))}")
    print(f"mirroring window {_ts(start)} .. {_ts(end)} -> {args.db}")

    db = open_mirror(args.db)
    try:
        total = mirror_positions(db, args.api, start, end,
                                 window_s=int(args.window_hours * 3600))
        n_ac = mirror_aircraft(db, args.api, start, end)
        print(f"aircraft table: {n_ac:,} rows")
        finalize(db, args.api, start, end)
        verify(db, args.api, start, end)
        print(f"done: {total:,} position rows in {args.db}")
    finally:
        db.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
