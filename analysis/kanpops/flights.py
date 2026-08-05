"""Per-aircraft flight segmentation.

A "flight" is a run of consecutive position reports for one ICAO hex with no
gap larger than gap_s. Parked aircraft with ADS-B on are downsampled by the
collector to one row per 300 s, so overnight parking does NOT split flights
at the default 600 s gap — an evening arrival, the parked night, and the
morning departure can merge into one segment. The ops classifier handles
that correctly (the single ground contact has airborne context both sides).
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass

import numpy as np

POINT_COLS = "ts, lat, lon, alt, gs, track, dist_nm, on_ground, baro_rate"


@dataclass
class Flight:
    hex: str
    ts: np.ndarray          # int64, seconds
    lat: np.ndarray
    lon: np.ndarray
    alt: np.ndarray         # float64, NaN when unknown/on-ground
    gs: np.ndarray          # float64, NaN when unknown
    track: np.ndarray       # float64 deg true, NaN when unknown
    dist_nm: np.ndarray
    on_ground: np.ndarray   # bool
    baro_rate: np.ndarray   # float64 fpm, NaN when unknown

    def __len__(self):
        return len(self.ts)


def candidate_hexes(db: sqlite3.Connection, max_dist_nm: float,
                    max_alt_ft: float) -> list[str]:
    """Hexes with at least one plausibly-at-the-field point (loose gates)."""
    return [r[0] for r in db.execute(
        "SELECT DISTINCT hex FROM positions"
        " WHERE dist_nm <= ? AND (on_ground = 1 OR alt <= ?)",
        (max_dist_nm, max_alt_ft))]


def _to_flight(hexid: str, rows: list) -> Flight:
    a = np.array(rows, dtype=object)
    def col(i, dtype=np.float64, none=np.nan):
        return np.array([none if v is None else v for v in a[:, i]], dtype=dtype)
    return Flight(
        hex=hexid,
        ts=col(0, np.int64, 0),
        lat=col(1), lon=col(2), alt=col(3), gs=col(4), track=col(5),
        dist_nm=col(6),
        on_ground=col(7, np.int64, 0).astype(bool),
        baro_rate=col(8),
    )


def iter_hex_rows(db: sqlite3.Connection, hexes: list[str]):
    """Yield (hex, rows) one aircraft at a time (uses idx_pos_hex_ts), so
    memory stays bounded by the busiest single aircraft, not the month."""
    for hexid in hexes:
        rows = db.execute(
            f"SELECT {POINT_COLS} FROM positions WHERE hex = ? ORDER BY ts",
            (hexid,)).fetchall()
        if rows:
            yield hexid, rows


def segment_rows(hexid: str, rows: list, gap_s: int):
    """Split one aircraft's ordered rows into Flights at gaps > gap_s."""
    start = 0
    for i in range(1, len(rows)):
        if rows[i][0] - rows[i - 1][0] > gap_s:
            yield _to_flight(hexid, rows[start:i])
            start = i
    yield _to_flight(hexid, rows[start:])


def iter_flights(db: sqlite3.Connection, hexes: list[str], gap_s: int = 600):
    """Yield Flight objects for the given hexes, split at gaps > gap_s."""
    for hexid, rows in iter_hex_rows(db, hexes):
        yield from segment_rows(hexid, rows, gap_s)
