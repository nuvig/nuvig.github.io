#!/usr/bin/env python3
"""KANP traffic API server.

Serves the SQLite database written by collector.py as a filterable JSON API
for the kanp.html tracker page, and also serves the website itself so the
tracker can be used over plain HTTP on the LAN (avoids the HTTPS
mixed-content problem when the page is hosted on jesselevine.net).

Stdlib only — no pip packages required.

Endpoints (all support CORS):
  GET /api/status        collector heartbeat, DB size, row counts
  GET /api/tracks        per-aircraft position tracks
  GET /api/stats         traffic-study aggregates (hour/dow grid, histograms)
  GET /api/aircraft      distinct aircraft seen, with counts
  GET /api/export.csv    raw filtered positions as CSV

Common filter query params (tracks / stats / aircraft / export):
  start, end       unix epoch seconds (default: last 24 h)
  min_alt, max_alt baro altitude in ft
  ground           include | exclude | only   (default include)
  callsign         substring match on callsign or registration
  hex              exact icao24 (comma-separated list allowed)
  category         ADS-B emitter category, comma list (e.g. A1,A2)
  military         1 = military only
  ga               1 = general aviation only (no airliners/regional/military)
  min_dist,max_dist  distance from field in nm
  hours            local hours of day, e.g. 7-19 or 6,7,8
  dow              local days of week, comma list, 0=Mon .. 6=Sun
"""

import json
import os
import sqlite3
import sys
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from trackutil import simplify_track

DB_PATH = os.environ.get("KANP_DB", "/var/lib/kanp/kanp.db")
PORT = int(os.environ.get("KANP_PORT", "8787"))
WEB_ROOT = os.environ.get(
    "KANP_WEB_ROOT",
    os.path.abspath(os.path.join(os.path.dirname(__file__), "..")),
)
# Douglas-Peucker tolerance (nm) for track simplification — see
# trackutil.simplify_track. Drops only points that don't change a track's shape,
# so tracks stay crisp at any zoom. Mirrors the exporter's KANP_SIMPLIFY_NM so
# the home API and the public snapshots render identically.
SIMPLIFY_NM = float(os.environ.get("KANP_SIMPLIFY_NM", "0.03"))
# Above this many raw fixes in one query the response sets "dense": the page
# warns and suggests narrowing the range / adding a filter, rather than the data
# being crudely thinned.
DENSE_POINTS = int(os.environ.get("KANP_API_DENSE_POINTS", "600000"))
MAX_CSV_ROWS = 500_000

# ICAO type designators treated as non-GA (scheduled airliners / regional /
# large transport), in addition to the A3.. and B7.. families matched by
# prefix. Mirrors KANP.AIRLINER_TYPES in js/kanp.js — keep the two in sync.
AIRLINER_TYPES = [
    "A19N", "A20N", "A21N", "B37M", "B38M", "B39M", "B3XM",
    "CRJ1", "CRJ2", "CRJ7", "CRJ9", "CRJX", "BCS1", "BCS3",
    "E135", "E145", "E170", "E75L", "E75S", "E190", "E195", "E290", "E295",
    "RJ1H", "RJ85", "RJ70", "B461", "B462", "B463", "F70", "F100",
    "AT43", "AT44", "AT45", "AT46", "AT72", "AT73", "AT75", "AT76",
    "DH8A", "DH8B", "DH8C", "DH8D", "SF34", "SB20", "D328", "J328",
    "MD11", "MD81", "MD82", "MD83", "MD87", "MD88", "MD90", "DC10", "DC93", "DC94",
]

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
}


def db_conn():
    uri = f"file:{DB_PATH}?mode=ro"
    conn = sqlite3.connect(uri, uri=True, timeout=15)
    conn.row_factory = sqlite3.Row
    return conn


def parse_int_list(raw):
    out = []
    for part in raw.split(","):
        part = part.strip()
        if "-" in part[1:]:
            a, b = part.split("-", 1)
            out.extend(range(int(a), int(b) + 1))
        elif part:
            out.append(int(part))
    return sorted(set(out))


def build_filters(q):
    """Build (where_sql, params) from common query params."""
    import time as _t

    now = int(_t.time())
    start = int(q.get("start", now - 86400))
    end = int(q.get("end", now))
    where = ["p.ts BETWEEN ? AND ?"]
    params = [start, end]

    if "min_alt" in q:
        where.append("(p.alt >= ? OR p.on_ground = 1)")
        params.append(int(q["min_alt"]))
    if "max_alt" in q:
        where.append("(p.alt <= ? OR p.alt IS NULL)")
        params.append(int(q["max_alt"]))

    ground = q.get("ground", "include")
    if ground == "exclude":
        where.append("p.on_ground = 0")
    elif ground == "only":
        where.append("p.on_ground = 1")

    if q.get("callsign"):
        where.append("(p.flight LIKE ? OR p.hex IN"
                     " (SELECT hex FROM aircraft WHERE reg LIKE ?))")
        pat = f"%{q['callsign'].strip().upper()}%"
        params.extend([pat, pat])

    if q.get("hex"):
        hexes = [h.strip().lower() for h in q["hex"].split(",") if h.strip()]
        where.append(f"p.hex IN ({','.join('?' * len(hexes))})")
        params.extend(hexes)

    if q.get("category"):
        cats = [c.strip().upper() for c in q["category"].split(",") if c.strip()]
        where.append(f"p.category IN ({','.join('?' * len(cats))})")
        params.extend(cats)

    if q.get("military") == "1":
        where.append("p.military = 1")

    if q.get("ga") == "1":
        # General aviation only: not military, and the ICAO type isn't a
        # scheduled airliner / regional / large transport (A3.. and B7..
        # families by prefix, plus the AIRLINER_TYPES list). Untyped aircraft
        # are kept (most GA/experimental broadcast no type).
        airliner = ("type LIKE 'A3__' OR type LIKE 'B7__' OR type IN ("
                    + ",".join("?" * len(AIRLINER_TYPES)) + ")")
        where.append("p.military = 0 AND p.hex NOT IN "
                     f"(SELECT hex FROM aircraft WHERE {airliner})")
        params.extend(AIRLINER_TYPES)

    if "min_dist" in q:
        where.append("p.dist_nm >= ?")
        params.append(float(q["min_dist"]))
    if "max_dist" in q:
        where.append("p.dist_nm <= ?")
        params.append(float(q["max_dist"]))

    if q.get("hours"):
        hrs = parse_int_list(q["hours"])
        if hrs and len(hrs) < 24:
            where.append(
                "CAST(strftime('%H', p.ts, 'unixepoch', 'localtime') AS INTEGER)"
                f" IN ({','.join('?' * len(hrs))})")
            params.extend(hrs)

    if q.get("dow"):
        days = parse_int_list(q["dow"])  # 0=Mon .. 6=Sun
        if days and len(days) < 7:
            # strftime %w: 0=Sun..6=Sat  ->  Mon=0: (w+6)%7
            where.append(
                "(CAST(strftime('%w', p.ts, 'unixepoch', 'localtime') AS INTEGER) + 6) % 7"
                f" IN ({','.join('?' * len(days))})")
            params.extend(days)

    return " AND ".join(where), params, start, end


def q_tracks(q):
    where, params, start, end = build_filters(q)

    with db_conn() as db:
        total = db.execute(
            f"SELECT COUNT(*) c FROM positions p WHERE {where}", params
        ).fetchone()["c"]
        # Stream in (hex, ts) order and shape-simplify each aircraft's track as
        # its run ends — no corner-cutting stride, bounded memory.
        rows = db.execute(
            f"""SELECT p.ts, p.hex, p.flight, p.lat, p.lon, p.alt, p.gs,
                       p.on_ground, p.military, a.reg, a.type, a.descr
                FROM positions p LEFT JOIN aircraft a ON a.hex = p.hex
                WHERE {where}
                ORDER BY p.hex, p.ts""",
            params,
        )

        tracks = []
        kept = 0
        cur = None
        buf = None

        def flush():
            nonlocal kept
            if cur is None:
                return
            cur["points"] = [
                [p[0], round(p[1], 5), round(p[2], 5), p[3],
                 round(p[4], 1) if p[4] is not None else None, p[5]]
                for p in simplify_track(buf, SIMPLIFY_NM)
            ]
            kept += len(cur["points"])
            tracks.append(cur)

        for r in rows:
            if cur is None or r["hex"] != cur["hex"]:
                flush()
                cur = {"hex": r["hex"], "flight": r["flight"], "reg": r["reg"],
                       "type": r["type"], "descr": r["descr"],
                       "military": r["military"], "points": []}
                buf = []
            if r["flight"]:
                cur["flight"] = r["flight"]
            buf.append([r["ts"], r["lat"], r["lon"], r["alt"], r["gs"], r["on_ground"]])
        flush()

    tracks.sort(key=lambda t: -len(t["points"]))
    return {
        "start": start,
        "end": end,
        "total_points": total,
        "returned_points": kept,
        "simplify_nm": SIMPLIFY_NM,
        "dense": total > DENSE_POINTS,
        "aircraft_count": len(tracks),
        "tracks": tracks,
    }


def q_stats(q):
    where, params, start, end = build_filters(q)
    with db_conn() as db:
        grid_rows = db.execute(
            f"""SELECT (CAST(strftime('%w', p.ts,'unixepoch','localtime') AS INTEGER)+6)%7 dow,
                       CAST(strftime('%H', p.ts,'unixepoch','localtime') AS INTEGER) hr,
                       COUNT(DISTINCT p.hex) ac, COUNT(*) samples
                FROM positions p WHERE {where} GROUP BY dow, hr""",
            params,
        ).fetchall()

        daily = db.execute(
            f"""SELECT date(p.ts,'unixepoch','localtime') d,
                       COUNT(DISTINCT p.hex) ac, COUNT(*) samples
                FROM positions p WHERE {where} GROUP BY d ORDER BY d""",
            params,
        ).fetchall()

        alt_hist = db.execute(
            f"""SELECT (p.alt/500)*500 bucket, COUNT(*) samples,
                       COUNT(DISTINCT p.hex) ac
                FROM positions p WHERE {where} AND p.alt IS NOT NULL
                  AND p.on_ground = 0 AND p.alt >= 0
                GROUP BY bucket ORDER BY bucket""",
            params,
        ).fetchall()

        types = db.execute(
            f"""SELECT COALESCE(a.type,'?') type, COUNT(DISTINCT p.hex) ac
                FROM positions p LEFT JOIN aircraft a ON a.hex = p.hex
                WHERE {where} GROUP BY COALESCE(a.type,'?')
                ORDER BY ac DESC LIMIT 30""",
            params,
        ).fetchall()

        cats = db.execute(
            f"""SELECT COALESCE(p.category,'?') cat, COUNT(DISTINCT p.hex) ac
                FROM positions p WHERE {where} GROUP BY cat ORDER BY ac DESC""",
            params,
        ).fetchall()

        top = db.execute(
            f"""SELECT p.hex, a.reg, a.type, a.descr, MAX(p.military) military,
                       COUNT(*) samples, MIN(p.ts) first_ts, MAX(p.ts) last_ts,
                       MIN(p.alt) min_alt, MAX(p.alt) max_alt,
                       MIN(p.dist_nm) min_dist,
                       GROUP_CONCAT(DISTINCT p.flight) callsigns
                FROM positions p LEFT JOIN aircraft a ON a.hex = p.hex
                WHERE {where} GROUP BY p.hex ORDER BY samples DESC LIMIT 25""",
            params,
        ).fetchall()

        totals = db.execute(
            f"""SELECT COUNT(*) samples, COUNT(DISTINCT p.hex) aircraft
                FROM positions p WHERE {where}""",
            params,
        ).fetchone()

    grid = [[0] * 24 for _ in range(7)]
    grid_samples = [[0] * 24 for _ in range(7)]
    for r in grid_rows:
        grid[r["dow"]][r["hr"]] = r["ac"]
        grid_samples[r["dow"]][r["hr"]] = r["samples"]

    return {
        "start": start,
        "end": end,
        "totals": dict(totals),
        "grid_unique_aircraft": grid,
        "grid_samples": grid_samples,
        "daily": [dict(r) for r in daily],
        "altitude_histogram": [dict(r) for r in alt_hist],
        "types": [dict(r) for r in types],
        "categories": [dict(r) for r in cats],
        "top_aircraft": [dict(r) for r in top],
    }


def q_aircraft(q):
    where, params, start, end = build_filters(q)
    with db_conn() as db:
        rows = db.execute(
            f"""SELECT p.hex, a.reg, a.type, a.descr, MAX(p.military) military,
                       COUNT(*) samples, MIN(p.ts) first_ts, MAX(p.ts) last_ts,
                       GROUP_CONCAT(DISTINCT p.flight) callsigns
                FROM positions p LEFT JOIN aircraft a ON a.hex = p.hex
                WHERE {where} GROUP BY p.hex ORDER BY samples DESC""",
            params,
        ).fetchall()
    return {"start": start, "end": end, "aircraft": [dict(r) for r in rows]}


def q_status():
    out = {"db_path": DB_PATH}
    try:
        out["db_bytes"] = os.path.getsize(DB_PATH)
    except OSError:
        out["db_bytes"] = None
    with db_conn() as db:
        row = db.execute(
            "SELECT COUNT(*) n, MIN(ts) oldest, MAX(ts) newest FROM positions"
        ).fetchone()
        out.update(positions=row["n"], oldest=row["oldest"], newest=row["newest"])
        out["aircraft_seen"] = db.execute(
            "SELECT COUNT(*) n FROM aircraft").fetchone()["n"]
        for r in db.execute("SELECT key, value FROM meta"):
            out[r["key"]] = r["value"]
    return out


def csv_rows(q):
    where, params, _, _ = build_filters(q)
    yield ("ts_utc,local_time,hex,flight,reg,type,lat,lon,alt_ft,gs_kts,"
           "track,baro_rate,squawk,category,dist_nm,on_ground,military\n")
    with db_conn() as db:
        cur = db.execute(
            f"""SELECT p.*, a.reg reg, a.type actype,
                       datetime(p.ts,'unixepoch','localtime') lt
                FROM positions p LEFT JOIN aircraft a ON a.hex = p.hex
                WHERE {where} ORDER BY p.ts LIMIT {MAX_CSV_ROWS}""",
            params,
        )
        for r in cur:
            vals = [r["ts"], r["lt"], r["hex"], r["flight"], r["reg"],
                    r["actype"], r["lat"], r["lon"], r["alt"], r["gs"],
                    r["track"], r["baro_rate"], r["squawk"], r["category"],
                    r["dist_nm"], r["on_ground"], r["military"]]
            yield ",".join("" if v is None else str(v) for v in vals) + "\n"


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stdout.write("%s - %s\n" % (self.address_string(), fmt % args))

    def send_cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def send_json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        q = {k: v[0] for k, v in urllib.parse.parse_qs(parsed.query).items()}
        path = parsed.path

        try:
            if path == "/api/status":
                self.send_json(q_status())
            elif path == "/api/tracks":
                self.send_json(q_tracks(q))
            elif path == "/api/stats":
                self.send_json(q_stats(q))
            elif path == "/api/aircraft":
                self.send_json(q_aircraft(q))
            elif path == "/api/export.csv":
                self.send_response(200)
                self.send_cors()
                self.send_header("Content-Type", "text/csv; charset=utf-8")
                self.send_header("Content-Disposition",
                                 "attachment; filename=kanp_positions.csv")
                self.send_header("Transfer-Encoding", "chunked")
                self.end_headers()
                for chunk in csv_rows(q):
                    data = chunk.encode()
                    self.wfile.write(b"%x\r\n%s\r\n" % (len(data), data))
                self.wfile.write(b"0\r\n\r\n")
            elif path.startswith("/api/"):
                self.send_json({"error": "unknown endpoint"}, 404)
            else:
                self.serve_static(path)
        except sqlite3.OperationalError as e:
            self.send_json({"error": f"database unavailable: {e}"}, 503)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:  # keep the server up no matter what
            try:
                self.send_json({"error": str(e)}, 500)
            except Exception:
                pass

    def serve_static(self, path):
        if path in ("/", ""):
            path = "/kanp.html"
        rel = urllib.parse.unquote(path).lstrip("/")
        full = os.path.abspath(os.path.join(WEB_ROOT, rel))
        if not full.startswith(os.path.abspath(WEB_ROOT)) or not os.path.isfile(full):
            self.send_json({"error": "not found"}, 404)
            return
        ext = os.path.splitext(full)[1].lower()
        ctype = CONTENT_TYPES.get(ext, "application/octet-stream")
        with open(full, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)


def main():
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"kanp-api serving on :{PORT}  db={DB_PATH}  web={WEB_ROOT}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
