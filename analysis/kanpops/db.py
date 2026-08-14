"""Read-only database access, schema introspection, and Step-1 exploration.

Works against the local mirror (kanpops.mirror) or a scp'd copy of the Pi's
/var/lib/kanp/kanp.db — the schema is identical.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

# The study window (Jul 2026) is entirely Eastern Daylight Time. zoneinfo
# needs the tzdata wheel on Windows, so fall back to fixed UTC-4 without it.
try:
    from zoneinfo import ZoneInfo
    LOCAL_TZ = ZoneInfo("America/New_York")
except Exception:  # pragma: no cover
    LOCAL_TZ = timezone(timedelta(hours=-4), "EDT")


def open_ro(path: str) -> sqlite3.Connection:
    """Open the database strictly read-only (URI mode=ro)."""
    db = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=30)
    db.row_factory = sqlite3.Row
    return db


def local_date(ts: int) -> str:
    return datetime.fromtimestamp(ts, LOCAL_TZ).strftime("%Y-%m-%d")


def utc_date(ts: int) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%d")


# --- analysis window --------------------------------------------------------
# Every DB reader takes an optional Window so a run can be restricted to a
# defined span instead of "whatever happens to be in the file". Boundaries are
# UTC and INCLUSIVE on both ends; `None` on either side means unbounded.

@dataclass(frozen=True)
class Window:
    start: int | None = None      # unix seconds, inclusive
    end: int | None = None        # unix seconds, inclusive

    def sql(self, col: str = "ts") -> tuple:
        """(sql_fragment, params) — an ' AND ...' clause, or ('', ()) if open."""
        bits, params = [], []
        if self.start is not None:
            bits.append(f"{col} >= ?")
            params.append(self.start)
        if self.end is not None:
            bits.append(f"{col} <= ?")
            params.append(self.end)
        return ((" AND " + " AND ".join(bits)) if bits else "", tuple(params))

    def where(self, col: str = "ts") -> tuple:
        """Same, but as a leading ' WHERE ...' clause."""
        frag, params = self.sql(col)
        return (frag.replace(" AND ", " WHERE ", 1) if frag else "", params)

    def contains(self, ts: int) -> bool:
        return ((self.start is None or ts >= self.start)
                and (self.end is None or ts <= self.end))

    @property
    def span_s(self) -> int | None:
        if self.start is None or self.end is None:
            return None
        return self.end - self.start + 1

    def label(self) -> str:
        f = lambda t: (datetime.fromtimestamp(t, timezone.utc)
                       .strftime("%Y-%m-%d %H:%MZ")) if t is not None else "-inf"
        return f"{f(self.start)} .. {f(self.end)}"


OPEN_WINDOW = Window()


def parse_day(s: str, end_of_day: bool = False) -> int:
    """'YYYY-MM-DD' (UTC midnight, or 23:59:59 with end_of_day) or a unix int."""
    s = str(s).strip()
    if s.isdigit() and len(s) >= 9:
        return int(s)
    d = datetime.strptime(s, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    if end_of_day:
        d += timedelta(days=1) - timedelta(seconds=1)
    return int(d.timestamp())


def last_complete_utc_day_end(db: sqlite3.Connection) -> int:
    """End (23:59:59Z) of the newest UTC day the DB covers *in full*.

    The collector writes continuously, so the newest day in the file is
    always partial; including it would drag the ops/day statistics down.
    """
    last = db.execute("SELECT MAX(ts) FROM positions").fetchone()[0]
    day = datetime.fromtimestamp(int(last), timezone.utc).replace(
        hour=0, minute=0, second=0, microsecond=0)
    return int(day.timestamp()) - 1        # 23:59:59Z of the previous day


def resolve_window(db: sqlite3.Connection, start=None, end=None) -> Window:
    """Build the analysis Window, defaulting to first row .. last COMPLETE
    UTC day. Both bounds are clamped to what the database actually holds."""
    first_ts, last_ts = db.execute(
        "SELECT MIN(ts), MAX(ts) FROM positions").fetchone()
    s = parse_day(start) if start is not None else int(first_ts)
    e = (parse_day(end, end_of_day=True) if end is not None
         else last_complete_utc_day_end(db))
    return Window(start=max(s, int(first_ts)), end=min(e, int(last_ts)))


# --- schema ---------------------------------------------------------------

def schema_report(db: sqlite3.Connection) -> str:
    """Human-readable schema: tables, columns/types, indexes, row counts."""
    out = []
    tables = [r["name"] for r in db.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"
        " AND name NOT LIKE 'sqlite_%' ORDER BY name")]
    for t in tables:
        n = db.execute(f"SELECT COUNT(*) c FROM {t}").fetchone()["c"]
        out.append(f"table {t}  ({n:,} rows)")
        for c in db.execute(f"PRAGMA table_info({t})"):
            flags = " PK" if c["pk"] else ""
            flags += " NOT NULL" if c["notnull"] else ""
            out.append(f"    {c['name']:<10} {c['type'] or '-':<8}{flags}")
        for ix in db.execute(f"PRAGMA index_list({t})"):
            cols = ",".join(r["name"] for r in
                            db.execute(f"PRAGMA index_info({ix['name']})"))
            kind = "UNIQUE " if ix["unique"] else ""
            out.append(f"    {kind}index {ix['name']} ({cols})")
    return "\n".join(out)


# --- coverage / polling gaps ------------------------------------------------

@dataclass
class Coverage:
    first_ts: int
    last_ts: int
    days_spanned: float
    rows: int
    distinct_seconds: int          # seconds with >=1 stored position
    gaps: list                     # (gap_start_ts, gap_seconds), > threshold
    gap_threshold_s: int
    downtime_s: int                # total time inside listed gaps
    rows_per_day: dict = field(default_factory=dict)   # local date -> rows
    rows_per_day_utc: dict = field(default_factory=dict)   # UTC date -> rows
    window: "Window" = OPEN_WINDOW

    @property
    def uptime_frac(self) -> float:
        span = self.window_span_s
        return 1.0 - self.downtime_s / span if span else 1.0

    @property
    def window_span_s(self) -> int:
        """Seconds the window asks for — not merely first_ts..last_ts, so a
        run whose data starts late or stops early scores that as downtime."""
        return (self.window.span_s if self.window.span_s is not None
                else self.last_ts - self.first_ts)

    def gaps_since(self, ts: int) -> list:
        """Gaps starting at or after ts, in chronological order."""
        return sorted((g for g in self.gaps if g[0] >= ts), key=lambda g: g[0])


def coverage(db: sqlite3.Connection, gap_threshold_s: int = 120,
             w: "Window" = OPEN_WINDOW) -> Coverage:
    """Time coverage and polling gaps within the window.

    Caveat: the collector inserts rows only for aircraft actually present, so
    a silent gap is *no rows at all*. Within 60 nm of Washington DC the sky
    is never empty for long, so any multi-minute hole in distinct timestamps
    is a polling/feed outage, not an empty sky.

    Gaps are measured against the window edges too: if the first row lands
    after w.start (or the last before w.end), that shortfall is a gap, so a
    collector that was down across the boundary can't hide as "no data yet".
    """
    import numpy as np

    where, params = w.where()
    first, last, rows = db.execute(
        f"SELECT MIN(ts), MAX(ts), COUNT(*) FROM positions{where}",
        params).fetchone()
    ts = np.fromiter((r[0] for r in db.execute(
        f"SELECT DISTINCT ts FROM positions{where} ORDER BY ts", params)),
        dtype=np.int64)
    d = np.diff(ts)
    idx = np.nonzero(d > gap_threshold_s)[0]
    gaps = [(int(ts[i]), int(d[i])) for i in idx]
    # shortfall at either window edge counts as downtime as well
    if w.start is not None and first is not None and first - w.start > gap_threshold_s:
        gaps.append((int(w.start), int(first - w.start)))
    if w.end is not None and last is not None and w.end - last > gap_threshold_s:
        gaps.append((int(last), int(w.end - last)))
    gaps.sort(key=lambda g: -g[1])

    per_day, per_day_utc = {}, {}
    for r in db.execute(
            f"SELECT date(ts, 'unixepoch', '-4 hours') d, COUNT(*) c"
            f" FROM positions{where} GROUP BY d ORDER BY d", params):
        per_day[r["d"]] = r["c"]
    for r in db.execute(
            f"SELECT date(ts, 'unixepoch') d, COUNT(*) c"
            f" FROM positions{where} GROUP BY d ORDER BY d", params):
        per_day_utc[r["d"]] = r["c"]
    return Coverage(first_ts=first, last_ts=last,
                    days_spanned=(last - first) / 86400.0, rows=rows,
                    distinct_seconds=len(ts), gaps=gaps,
                    gap_threshold_s=gap_threshold_s,
                    downtime_s=int(sum(g for _, g in gaps)),
                    rows_per_day=per_day, rows_per_day_utc=per_day_utc,
                    window=w)


# --- altitude / distance distributions --------------------------------------

def alt_dist_distribution(db: sqlite3.Connection, w: "Window" = OPEN_WINDOW):
    """Joint distribution of altitude and distance from KANP.

    Returns (alt_hist, dist_hist, joint, null_alt, ground) where alt_hist is
    {bin_floor_ft: rows} in 500 ft bins, dist_hist is {bin_floor_nm: rows} in
    5 nm bins, and joint is {(dist_bin, alt_bin): rows} for dist bins
    (0-2, 2-5, 5-10, 10-60) x alt bins (0-1200, 1200-3000, 3000-10000, >10000).
    """
    wsql, wp = w.sql()
    alt_hist = {r[0] * 500: r[1] for r in db.execute(
        f"SELECT CAST(alt/500 AS INT) b, COUNT(*) FROM positions"
        f" WHERE alt IS NOT NULL{wsql} GROUP BY b ORDER BY b", wp)}
    dist_hist = {r[0] * 5: r[1] for r in db.execute(
        f"SELECT CAST(dist_nm/5 AS INT) b, COUNT(*) FROM positions"
        f" WHERE dist_nm IS NOT NULL{wsql} GROUP BY b ORDER BY b", wp)}
    wwhere, wwp = w.where()
    joint = {}
    for r in db.execute(f"""
        SELECT CASE WHEN dist_nm <= 2 THEN '0-2'   WHEN dist_nm <= 5 THEN '2-5'
                    WHEN dist_nm <= 10 THEN '5-10' ELSE '10-60' END db,
               CASE WHEN on_ground = 1 OR alt IS NULL THEN 'ground'
                    WHEN alt <= 1200 THEN '<=1200'  WHEN alt <= 3000 THEN '1200-3000'
                    WHEN alt <= 10000 THEN '3000-10k' ELSE '>10k' END ab,
               COUNT(*) c
        FROM positions{wwhere} GROUP BY db, ab""", wwp):
        joint[(r["db"], r["ab"])] = r["c"]
    null_alt = db.execute(f"SELECT COUNT(*) FROM positions"
                          f" WHERE alt IS NULL AND on_ground = 0{wsql}",
                          wp).fetchone()[0]
    ground = db.execute(f"SELECT COUNT(*) FROM positions"
                        f" WHERE on_ground = 1{wsql}", wp).fetchone()[0]
    return alt_hist, dist_hist, joint, null_alt, ground


def unique_aircraft(db: sqlite3.Connection, w: "Window" = OPEN_WINDOW) -> dict:
    wsql, wp = w.sql()
    wwhere, wwp = w.where()
    out = {"total": db.execute(
        f"SELECT COUNT(DISTINCT hex) FROM positions{wwhere}", wwp).fetchone()[0]}
    out["low_2nm"] = db.execute(
        f"SELECT COUNT(DISTINCT hex) FROM positions"
        f" WHERE dist_nm <= 2 AND (on_ground = 1 OR alt <= 1200){wsql}",
        wp).fetchone()[0]
    out["low_3nm"] = db.execute(
        f"SELECT COUNT(DISTINCT hex) FROM positions"
        f" WHERE dist_nm <= 3 AND (on_ground = 1 OR alt <= 2000){wsql}",
        wp).fetchone()[0]
    return out
