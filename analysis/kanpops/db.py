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

    @property
    def uptime_frac(self) -> float:
        span = self.last_ts - self.first_ts
        return 1.0 - self.downtime_s / span if span else 1.0


def coverage(db: sqlite3.Connection, gap_threshold_s: int = 120) -> Coverage:
    """Time coverage and polling gaps.

    Caveat: the collector inserts rows only for aircraft actually present, so
    a silent gap is *no rows at all*. Within 60 nm of Washington DC the sky
    is never empty for long, so any multi-minute hole in distinct timestamps
    is a polling/feed outage, not an empty sky.
    """
    import numpy as np

    first, last, rows = db.execute(
        "SELECT MIN(ts), MAX(ts), COUNT(*) FROM positions").fetchone()
    ts = np.fromiter((r[0] for r in
                      db.execute("SELECT DISTINCT ts FROM positions ORDER BY ts")),
                     dtype=np.int64)
    d = np.diff(ts)
    idx = np.nonzero(d > gap_threshold_s)[0]
    gaps = sorted(((int(ts[i]), int(d[i])) for i in idx),
                  key=lambda g: -g[1])
    per_day = {}
    for r in db.execute(
            "SELECT date(ts, 'unixepoch', '-4 hours') d, COUNT(*) c"
            " FROM positions GROUP BY d ORDER BY d"):
        per_day[r["d"]] = r["c"]
    return Coverage(first_ts=first, last_ts=last,
                    days_spanned=(last - first) / 86400.0, rows=rows,
                    distinct_seconds=len(ts), gaps=gaps,
                    gap_threshold_s=gap_threshold_s,
                    downtime_s=int(sum(g for _, g in gaps)),
                    rows_per_day=per_day)


# --- altitude / distance distributions --------------------------------------

def alt_dist_distribution(db: sqlite3.Connection):
    """Joint distribution of altitude and distance from KANP.

    Returns (alt_hist, dist_hist, joint, null_alt, ground) where alt_hist is
    {bin_floor_ft: rows} in 500 ft bins, dist_hist is {bin_floor_nm: rows} in
    5 nm bins, and joint is {(dist_bin, alt_bin): rows} for dist bins
    (0-2, 2-5, 5-10, 10-60) x alt bins (0-1200, 1200-3000, 3000-10000, >10000).
    """
    alt_hist = {r[0] * 500: r[1] for r in db.execute(
        "SELECT CAST(alt/500 AS INT) b, COUNT(*) FROM positions"
        " WHERE alt IS NOT NULL GROUP BY b ORDER BY b")}
    dist_hist = {r[0] * 5: r[1] for r in db.execute(
        "SELECT CAST(dist_nm/5 AS INT) b, COUNT(*) FROM positions"
        " WHERE dist_nm IS NOT NULL GROUP BY b ORDER BY b")}
    joint = {}
    for r in db.execute("""
        SELECT CASE WHEN dist_nm <= 2 THEN '0-2'   WHEN dist_nm <= 5 THEN '2-5'
                    WHEN dist_nm <= 10 THEN '5-10' ELSE '10-60' END db,
               CASE WHEN on_ground = 1 OR alt IS NULL THEN 'ground'
                    WHEN alt <= 1200 THEN '<=1200'  WHEN alt <= 3000 THEN '1200-3000'
                    WHEN alt <= 10000 THEN '3000-10k' ELSE '>10k' END ab,
               COUNT(*) c
        FROM positions GROUP BY db, ab"""):
        joint[(r["db"], r["ab"])] = r["c"]
    null_alt = db.execute("SELECT COUNT(*) FROM positions"
                          " WHERE alt IS NULL AND on_ground = 0").fetchone()[0]
    ground = db.execute("SELECT COUNT(*) FROM positions"
                        " WHERE on_ground = 1").fetchone()[0]
    return alt_hist, dist_hist, joint, null_alt, ground


def unique_aircraft(db: sqlite3.Connection) -> dict:
    out = {"total": db.execute(
        "SELECT COUNT(DISTINCT hex) FROM positions").fetchone()[0]}
    out["low_2nm"] = db.execute(
        "SELECT COUNT(DISTINCT hex) FROM positions"
        " WHERE dist_nm <= 2 AND (on_ground = 1 OR alt <= 1200)").fetchone()[0]
    out["low_3nm"] = db.execute(
        "SELECT COUNT(DISTINCT hex) FROM positions"
        " WHERE dist_nm <= 3 AND (on_ground = 1 OR alt <= 2000)").fetchone()[0]
    return out
