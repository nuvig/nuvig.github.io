"""KANP operation detection and threshold sensitivity.

An *operation* follows FAA counting: one landing = 1 op, one takeoff = 1 op,
a circuit (touch-and-go / stop-and-go / low approach) = 2 ops.

Detection: within each flight (flights.iter_flights), a *field contact* is a
maximal run of points satisfying

    dist_nm <= contact_dist_nm  AND  (on_ground OR alt <= contact_alt_msl_ft)

(runs separated by < merge_gap_s are merged — low-altitude ADS-B flicker).
Each contact is classified by airborne context within the same flight:

    airborne before only  -> arrival    (1 op)
    airborne after only   -> departure  (1 op)
    both                  -> touch      (2 ops: arrival + departure; at KANP,
                             where touch-and-goes are prohibited, this is a
                             go-around / low approach, or a full-stop +
                             taxi-back + takeoff merged at snapshot resolution)
    neither               -> ground_only (0 ops; parked/taxi-only, or an
                             aircraft first acquired inside the gates)

THRESHOLD CAVEAT (why the sensitivity sweep matters): KANP pattern altitude
is ~1,000 ft MSL flown ~1 nm out. Gates of 1,200 ft / 2 nm therefore contain
the entire traffic pattern — a session of circuits never *leaves* contact and
collapses into one touch (2 ops). The site's tight gates (600 ft / 0.8 nm)
let each circuit exit and re-enter contact, resolving individual circuits.
Expect op counts to *rise* as gates tighten, until they start clipping real
short-final coverage.
"""

from __future__ import annotations

import math
import sqlite3
from collections import Counter
from dataclasses import dataclass, field

import numpy as np

from . import config
from .config import OpsThresholds
from .db import local_date
from .flights import Flight, candidate_hexes, iter_flights

MERGE_GAP_S = 60


# --- geometry helpers -------------------------------------------------------

def circular_mean_deg(deg: np.ndarray) -> float | None:
    d = deg[~np.isnan(deg)]
    if len(d) < 2:
        return None
    r = np.radians(d)
    s, c = np.sin(r).mean(), np.cos(r).mean()
    if math.hypot(s, c) < 0.3:      # scattered headings — circling, no answer
        return None
    return math.degrees(math.atan2(s, c)) % 360.0


def ang_diff(a: float, b: float) -> float:
    return abs((a - b + 180.0) % 360.0 - 180.0)


def runway_from_heading(hdg: float | None) -> str | None:
    if hdg is None:
        return None
    d12 = ang_diff(hdg, config.RWY_12_TRUE)
    d30 = ang_diff(hdg, config.RWY_30_TRUE)
    if min(d12, d30) > 55.0:        # not aligned with either — ambiguous
        return None
    return "12" if d12 < d30 else "30"


# --- detection --------------------------------------------------------------

@dataclass
class Contact:
    hex: str
    kind: str                 # arrival | departure | touch | ground_only
    t_start: int
    t_end: int
    min_alt: float            # ft MSL (NaN if all-ground)
    closest_nm: float
    n_points: int
    arr_rwy: str | None = None
    dep_rwy: str | None = None
    date: str = ""            # local date of t_start

    @property
    def ops(self) -> int:
        return {"arrival": 1, "departure": 1, "touch": 2}.get(self.kind, 0)


def _contact_mask(f: Flight, th: OpsThresholds) -> np.ndarray:
    with np.errstate(invalid="ignore"):
        low = f.alt <= th.contact_alt_msl_ft   # NaN compares False
    return (f.dist_nm <= th.contact_dist_nm) & (f.on_ground | low)


def _runs(mask: np.ndarray, ts: np.ndarray, merge_gap_s: int):
    """Maximal True runs [i0, i1] inclusive, merging gaps < merge_gap_s."""
    idx = np.nonzero(mask)[0]
    if not len(idx):
        return []
    runs = []
    start = prev = idx[0]
    for i in idx[1:]:
        if i == prev + 1 or ts[i] - ts[prev] < merge_gap_s:
            prev = i
            continue
        runs.append((start, prev))
        start = prev = i
    runs.append((start, prev))
    return runs


def _infer_runways(f: Flight, i0: int, i1: int, th: OpsThresholds,
                   arrival: bool, departure: bool):
    """Approach / climb-out mean headings inside the final window."""
    ground = f.on_ground[i0:i1 + 1]
    g_idx = np.nonzero(ground)[0]
    t_touch = f.ts[i0 + g_idx[0]] if len(g_idx) else None
    t_lift = f.ts[i0 + g_idx[-1]] if len(g_idx) else None
    t_close = f.ts[i0 + int(np.nanargmin(f.dist_nm[i0:i1 + 1]))]

    in_final = ((f.dist_nm >= th.final_min_nm) & (f.dist_nm <= th.final_max_nm)
                & ~f.on_ground)
    arr_rwy = dep_rwy = None
    # Only the few points nearest the reference time: short final for the
    # arrival, initial climb for the departure. A wider window would sweep in
    # crosswind/downwind headings and cancel the circular mean.
    K = 8
    if arrival:
        t_ref = t_touch if t_touch is not None else t_close
        idx = np.nonzero(in_final & (f.ts >= f.ts[i0] - 180)
                         & (f.ts <= t_ref))[0][-K:]
        arr_rwy = runway_from_heading(circular_mean_deg(f.track[idx]))
    if departure:
        t_ref = t_lift if t_lift is not None else t_close
        idx = np.nonzero(in_final & (f.ts >= t_ref)
                         & (f.ts <= f.ts[i1] + 180))[0][:K]
        dep_rwy = runway_from_heading(circular_mean_deg(f.track[idx]))
    return arr_rwy, dep_rwy


def detect_flight_contacts(f: Flight, th: OpsThresholds,
                           merge_gap_s: int = MERGE_GAP_S,
                           infer_rwy: bool = True) -> list[Contact]:
    mask = _contact_mask(f, th)
    airborne_ctx = ~mask & ~f.on_ground & ~np.isnan(f.alt)
    contacts = []
    for i0, i1 in _runs(mask, f.ts, merge_gap_s):
        if i1 - i0 + 1 < th.min_contact_points:
            continue
        before = bool(airborne_ctx[:i0].any())
        after = bool(airborne_ctx[i1 + 1:].any())
        kind = ("touch" if before and after else
                "arrival" if before else
                "departure" if after else "ground_only")
        seg_alt = f.alt[i0:i1 + 1]
        if (kind == "touch" and not f.on_ground[i0:i1 + 1].any()
                and not np.all(np.isnan(seg_alt))
                and np.nanmin(seg_alt) >= th.transit_floor_msl_ft):
            kind = "transit"   # skimmed the gates without approaching the rwy
        c = Contact(
            hex=f.hex, kind=kind, t_start=int(f.ts[i0]), t_end=int(f.ts[i1]),
            min_alt=float(np.nanmin(seg_alt)) if not np.all(np.isnan(seg_alt))
            else float("nan"),
            closest_nm=float(np.nanmin(f.dist_nm[i0:i1 + 1])),
            n_points=int(i1 - i0 + 1),
            date=local_date(int(f.ts[i0])),
        )
        if infer_rwy and kind in ("arrival", "departure", "touch"):
            c.arr_rwy, c.dep_rwy = _infer_runways(
                f, i0, i1, th,
                arrival=kind in ("arrival", "touch"),
                departure=kind in ("departure", "touch"))
        contacts.append(c)
    return contacts


# --- whole-database run -----------------------------------------------------

@dataclass
class OpsResult:
    thresholds: OpsThresholds
    contacts: list = field(default_factory=list)     # arrival/departure/touch
    ground_only: int = 0
    transits: int = 0                                # low pass-throughs, 0 ops
    flights_scanned: int = 0
    op_flights: int = 0                              # flights with >=1 op
    pattern_flights: int = 0                         # flights with >=2 contacts

    @property
    def arrivals(self):
        return sum(1 for c in self.contacts if c.kind == "arrival")

    @property
    def departures(self):
        return sum(1 for c in self.contacts if c.kind == "departure")

    @property
    def touches(self):
        return sum(1 for c in self.contacts if c.kind == "touch")

    @property
    def total_ops(self):
        return sum(c.ops for c in self.contacts)

    @property
    def unique_aircraft(self):
        return len({c.hex for c in self.contacts})

    def ops_by_date(self) -> dict:
        d = Counter()
        for c in self.contacts:
            d[c.date] += c.ops
        return dict(sorted(d.items()))

    def runway_split(self) -> dict:
        arr = Counter(c.arr_rwy for c in self.contacts
                      if c.kind in ("arrival", "touch"))
        dep = Counter(c.dep_rwy for c in self.contacts
                      if c.kind in ("departure", "touch"))
        return {"arrivals": dict(arr), "departures": dict(dep)}


def run_detection(db: sqlite3.Connection,
                  th: OpsThresholds = config.DEFAULT_THRESHOLDS,
                  hexes: list[str] | None = None,
                  log=print) -> OpsResult:
    if hexes is None:
        hexes = candidate_hexes(db, th.contact_dist_nm, th.contact_alt_msl_ft)
        log(f"  {len(hexes)} candidate aircraft"
            f" (<= {th.contact_dist_nm} nm, <= {th.contact_alt_msl_ft:.0f} ft)")
    res = OpsResult(thresholds=th)
    for f in iter_flights(db, hexes, th.flight_gap_s):
        res.flights_scanned += 1
        contacts = detect_flight_contacts(f, th)
        real = [c for c in contacts
                if c.kind in ("arrival", "departure", "touch")]
        res.ground_only += sum(1 for c in contacts if c.kind == "ground_only")
        res.transits += sum(1 for c in contacts if c.kind == "transit")
        res.contacts.extend(real)
        if real:
            res.op_flights += 1
        if len(real) >= 2:
            res.pattern_flights += 1
    return res


# --- sensitivity sweep ------------------------------------------------------

def sensitivity(db: sqlite3.Connection,
                alt_grid=config.SWEEP_ALT_FT,
                dist_grid=config.SWEEP_DIST_NM,
                gap_grid=config.SWEEP_GAP_S,
                base: OpsThresholds = config.DEFAULT_THRESHOLDS,
                log=print) -> dict:
    """Op counts across the (alt x dist) grid for each flight-gap value.

    Flights are loaded once per gap value (the slow part) and every gate
    combination is evaluated in memory. Candidates come from the loosest
    gates so no combination is starved of input.

    Returns {gap_s: {(alt, dist): {"ops": .., "arr": .., "dep": ..,
                                   "touch": .., "aircraft": ..}}}
    """
    from .flights import iter_hex_rows, segment_rows

    hexes = candidate_hexes(db, max(dist_grid), max(alt_grid))
    log(f"  sensitivity: {len(hexes)} candidate aircraft under loosest gates")
    combos = [OpsThresholds(contact_alt_msl_ft=a, contact_dist_nm=d,
                            flight_gap_s=g,
                            min_contact_points=base.min_contact_points,
                            transit_floor_msl_ft=base.transit_floor_msl_ft)
              for g in gap_grid for a in alt_grid for d in dist_grid]
    grid = {(th.flight_gap_s, th.contact_alt_msl_ft, th.contact_dist_nm):
            {"ops": 0, "arr": 0, "dep": 0, "touch": 0, "transit": 0,
             "hexes": set()}
            for th in combos}

    # one DB pass: each aircraft's rows are read once, re-segmented in memory
    # for every gap value, and every gate combination evaluated on the result
    for hexid, rows in iter_hex_rows(db, hexes):
        for gap_s in gap_grid:
            fls = list(segment_rows(hexid, rows, gap_s))
            for th in combos:
                if th.flight_gap_s != gap_s:
                    continue
                cell = grid[(gap_s, th.contact_alt_msl_ft, th.contact_dist_nm)]
                for f in fls:
                    for c in detect_flight_contacts(f, th, infer_rwy=False):
                        if c.kind == "ground_only":
                            continue
                        if c.kind == "transit":
                            cell["transit"] += 1
                            continue
                        cell["ops"] += c.ops
                        cell["arr"] += c.kind == "arrival"
                        cell["dep"] += c.kind == "departure"
                        cell["touch"] += c.kind == "touch"
                        cell["hexes"].add(c.hex)

    out = {g: {} for g in gap_grid}
    for (g, a, d), v in grid.items():
        out[g][(a, d)] = {"ops": v["ops"], "arr": v["arr"], "dep": v["dep"],
                          "touch": v["touch"], "transit": v["transit"],
                          "aircraft": len(v["hexes"])}
    return out


# --- data quality ------------------------------------------------------------

def data_quality(db: sqlite3.Connection, res: OpsResult,
                 radius_nm: float = 3.0, pad_s: int = 300) -> dict:
    """Median points-per-operation and update rate near the field."""
    pts_per_op, intervals = [], []
    for c in res.contacts:
        rows = db.execute(
            "SELECT ts FROM positions WHERE hex = ? AND ts BETWEEN ? AND ?"
            " AND dist_nm <= ? ORDER BY ts",
            (c.hex, c.t_start - pad_s, c.t_end + pad_s, radius_nm)).fetchall()
        n = len(rows)
        pts_per_op.append(n)
        if n > 1:
            ts = np.array([r[0] for r in rows], dtype=np.int64)
            d = np.diff(ts)
            intervals.extend(d[d <= 60])   # within-track cadence only
    return {
        "median_points_per_op": float(np.median(pts_per_op)) if pts_per_op else 0,
        "median_update_s": float(np.median(intervals)) if intervals else None,
        "mean_update_s": float(np.mean(intervals)) if intervals else None,
    }
