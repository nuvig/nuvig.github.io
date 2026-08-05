"""Full analysis run: exploration, ops, sensitivity, figures, abstract summary.

    python -m kanpops.report --db analysis/data/kanp_mirror.db \
        --out analysis/output [--skip-sensitivity] [--skip-figures]

Read-only against the database throughout.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone

import numpy as np

from . import config, db as dbmod, ops as opsmod
from .config import DEFAULT_THRESHOLDS, TIGHT_THRESHOLDS
from .flights import candidate_hexes


def _utc(ts: int) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%d %H:%MZ")


def section(title: str):
    print(f"\n{'=' * 72}\n{title}\n{'=' * 72}")


def explore(db) -> dict:
    section("STEP 1 — SCHEMA, COVERAGE, DISTRIBUTIONS")
    print(dbmod.schema_report(db))

    cov = dbmod.coverage(db)
    print(f"\ntime coverage : {_utc(cov.first_ts)} .. {_utc(cov.last_ts)}"
          f"  ({cov.days_spanned:.1f} days)")
    print(f"position rows : {cov.rows:,}")
    print(f"seconds with data: {cov.distinct_seconds:,}"
          f"  (poll cadence ~3 s while aircraft present)")
    print(f"polling gaps > {cov.gap_threshold_s}s: {len(cov.gaps)}"
          f"  (total {cov.downtime_s / 3600:.2f} h,"
          f" uptime {100 * cov.uptime_frac:.2f}%)")
    for t, g in cov.gaps[:8]:
        print(f"    {_utc(t)}  gap {g / 60:6.1f} min")
    if len(cov.gaps) > 8:
        print(f"    … and {len(cov.gaps) - 8} more")

    alt_hist, dist_hist, joint, null_alt, ground = dbmod.alt_dist_distribution(db)
    tot = cov.rows
    print("\naltitude distribution (baro ft MSL, airborne rows):")
    acc = {}
    for b, n in alt_hist.items():   # coarse rollup on the 500 ft bin edges
        k = ("<1,500" if b < 1500 else "1,500-3,000" if b < 3000
             else "3,000-10,000" if b < 10000 else ">=10,000")
        acc[k] = acc.get(k, 0) + n
    for k in ("<1,500", "1,500-3,000", "3,000-10,000", ">=10,000"):
        n = acc.get(k, 0)
        print(f"    {k:>12} ft : {n:12,}  ({100 * n / tot:5.1f}%)")
    print(f"    {'on ground':>12}    : {ground:12,}  ({100 * ground / tot:5.1f}%)")
    print(f"    {'alt unknown':>12}  : {null_alt:12,}  ({100 * null_alt / tot:5.1f}%)")

    print("\ndistance from KANP:")
    acc = {}
    for b, n in dist_hist.items():
        k = "0-5" if b < 5 else "5-10" if b < 10 else "10-30" if b < 30 else "30-60"
        acc[k] = acc.get(k, 0) + n
    for k in ("0-5", "5-10", "10-30", "30-60"):
        n = acc.get(k, 0)
        print(f"    {k:>6} nm : {n:12,}  ({100 * n / tot:5.1f}%)")

    local = joint.get(("0-2", "<=1200"), 0) + joint.get(("0-2", "ground"), 0)
    print(f"\nlow-and-local rows (<=2 nm and <=1,200 ft or ground):"
          f" {local:,} ({100 * local / tot:.2f}% of all rows)")
    print("-> the overwhelming majority of stored traffic is overflight;"
          " KANP-relevant rows are a thin slice, as expected under the"
          " DC-area shelf.")

    ac = dbmod.unique_aircraft(db)
    print(f"\nunique aircraft: {ac['total']:,} anywhere in the 60 nm circle;"
          f" {ac['low_3nm']:,} ever below 2,000 ft within 3 nm;"
          f" {ac['low_2nm']:,} ever below 1,200 ft within 2 nm")
    return {"coverage": cov, "aircraft": ac}


def detect(db) -> dict:
    section("STEP 2 — OPERATION DETECTION")
    print(f"\nTIGHT gates (site ops gates — resolve individual circuits):"
          f" <= {TIGHT_THRESHOLDS.contact_alt_msl_ft:.0f} ft MSL,"
          f" <= {TIGHT_THRESHOLDS.contact_dist_nm} nm,"
          f" gap {TIGHT_THRESHOLDS.flight_gap_s}s")
    tight = opsmod.run_detection(db, TIGHT_THRESHOLDS)
    _print_ops(tight)

    print(f"\nUSER-SPEC gates (~1,200 ft / 2 nm — the whole pattern is inside"
          f" these gates, so circuit sessions merge into single contacts):")
    loose = opsmod.run_detection(db, DEFAULT_THRESHOLDS)
    _print_ops(loose)
    return {"tight": tight, "loose": loose}


def _print_ops(r: opsmod.OpsResult):
    print(f"    flights scanned {r.flights_scanned:,} -> op flights"
          f" {r.op_flights:,} (pattern flights, >=2 contacts:"
          f" {r.pattern_flights:,}; ignored: {r.ground_only:,} ground-only,"
          f" {r.transits:,} low transits)")
    print(f"    arrivals {r.arrivals:,} | departures {r.departures:,} |"
          f" touch/circuit contacts {r.touches:,} (x2 ops each)")
    print(f"    TOTAL OPS {r.total_ops:,} by {r.unique_aircraft:,} unique"
          f" aircraft")
    rw = r.runway_split()
    for side in ("arrivals", "departures"):
        d = rw[side]
        n12, n30 = d.get("12", 0), d.get("30", 0)
        amb = sum(v for k, v in d.items() if k is None)
        known = n12 + n30
        if known:
            print(f"    {side}: RWY 12 {n12:,} ({100 * n12 / known:.0f}%) |"
                  f" RWY 30 {n30:,} ({100 * n30 / known:.0f}%)"
                  f" | unresolved {amb:,}")


def sensitivity(db) -> dict:
    section("STEP 2b — THRESHOLD SENSITIVITY (total ops)")
    sens = opsmod.sensitivity(db)
    for gap_s, grid in sens.items():
        print(f"\nflight gap {gap_s}s — total ops"
              f" (rows: contact alt ft MSL, cols: contact radius nm)")
        dists = sorted({d for _, d in grid})
        print("    " + "".join(f"{d:>9}" for d in dists))
        for a in sorted({a for a, _ in grid}):
            print(f"{a:6.0f}" + "".join(f"{grid[(a, d)]['ops']:>9,}"
                                        for d in dists))
    return sens


def report_numbers(db, tight: opsmod.OpsResult) -> dict:
    section("STEP 3 — ABSTRACT NUMBERS (tight gates)")
    by_day = tight.ops_by_date()
    days = len(by_day)
    vals = np.array(list(by_day.values()))
    print(f"\nops per local day over {days} days:"
          f" mean {vals.mean():.1f}, median {np.median(vals):.0f},"
          f" min {vals.min()} ({min(by_day, key=by_day.get)}),"
          f" max {vals.max()} ({max(by_day, key=by_day.get)})")
    for d, n in by_day.items():
        print(f"    {d}  {n:4,}  {'#' * min(60, n)}")

    # aircraft types among op aircraft
    hexes = sorted({c.hex for c in tight.contacts})
    types = {}
    for i in range(0, len(hexes), 500):   # stay under the ?-param limit
        chunk = hexes[i:i + 500]
        q = ",".join("?" * len(chunk))
        for r in db.execute(f"SELECT type, COUNT(*) c FROM aircraft"
                            f" WHERE hex IN ({q}) GROUP BY type", chunk):
            types[r[0] or "unknown"] = types.get(r[0] or "unknown", 0) + r[1]
    types = dict(sorted(types.items(), key=lambda kv: -kv[1]))
    top = list(types.items())[:8]
    print("\ntop types among operating aircraft: "
          + ", ".join(f"{t} x{n}" for t, n in top))

    dq = opsmod.data_quality(db, tight)
    print(f"\ndata quality: median {dq['median_points_per_op']:.0f} position"
          f" reports per operation within 3 nm;"
          f" median update interval {dq['median_update_s']:.0f} s"
          f" (mean {dq['mean_update_s']:.1f} s)")
    return {"by_day": by_day, "types": types, "quality": dq}


def abstract_summary(cov, tight: opsmod.OpsResult, extras: dict):
    section("ABSTRACT-READY SUMMARY")
    by_day = tight.ops_by_date()
    vals = np.array(list(by_day.values()))
    rw = tight.runway_split()
    arr, dep = rw["arrivals"], rw["departures"]
    n12 = arr.get("12", 0) + dep.get("12", 0)
    n30 = arr.get("30", 0) + dep.get("30", 0)
    dq = extras["quality"]
    print(f"""
Over {cov.days_spanned:.0f} days ({_utc(cov.first_ts)[:10]} to {_utc(cov.last_ts)[:10]}), a
single ADS-B receiver-driven collector near KANP (Lee Airport, Annapolis,
MD) stored {cov.rows / 1e6:.1f} M position reports from {extras['n_aircraft_total']:,} distinct
aircraft inside a 60 nm radius. Of these, {tight.unique_aircraft:,} aircraft conducted
{tight.total_ops:,} operations at KANP ({tight.arrivals:,} arrivals, {tight.departures:,} departures, and
{tight.touches:,} circuit contacts counted as two operations each), a mean of
{vals.mean():.0f} operations per day (median {np.median(vals):.0f}, max {vals.max()}). Runway use split
{100 * n12 / max(1, n12 + n30):.0f}% / {100 * n30 / max(1, n12 + n30):.0f}% between runways 12 and 30 among resolvable
final courses. Operations carry a median of {dq['median_points_per_op']:.0f} position reports
within 3 nm at a median update interval of {dq['median_update_s']:.0f} s.
""".strip("\n"))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--db", required=True)
    ap.add_argument("--out", default="output", help="figure/json output dir")
    ap.add_argument("--skip-sensitivity", action="store_true")
    ap.add_argument("--skip-figures", action="store_true")
    args = ap.parse_args(argv)

    db = dbmod.open_ro(args.db)
    info = explore(db)
    runs = detect(db)
    tight = runs["tight"]
    sens = None if args.skip_sensitivity else sensitivity(db)
    extras = report_numbers(db, tight)
    extras["n_aircraft_total"] = info["aircraft"]["total"]

    if not args.skip_figures:
        section("STEP 4 — FIGURES")
        import os
        from . import figures
        os.makedirs(args.out, exist_ok=True)
        hexes = candidate_hexes(db, TIGHT_THRESHOLDS.contact_dist_nm,
                                TIGHT_THRESHOLDS.contact_alt_msl_ft)
        tracks, dw = figures.collect_figure_data(db, hexes)
        figures.fig_track_density(
            tracks, f"{args.out}/fig1_track_density")
        figures.fig_downwind_altitude(
            dw, f"{args.out}/fig2_downwind_altitude")

    abstract_summary(info["coverage"], tight, extras)

    # machine-readable dump for the paper pipeline
    if sens is not None:
        import os
        os.makedirs(args.out, exist_ok=True)
        dump = {
            "generated_utc": datetime.now(timezone.utc).isoformat(),
            "tight": _ops_dict(tight), "loose": _ops_dict(runs["loose"]),
            "sensitivity": {str(g): {f"{a}ft_{d}nm": v for (a, d), v in grid.items()}
                            for g, grid in sens.items()},
            "quality": extras["quality"],
            "ops_by_day": extras["by_day"],
        }
        with open(f"{args.out}/ops_summary.json", "w") as f:
            json.dump(dump, f, indent=1)
        print(f"\nwrote {args.out}/ops_summary.json")
    db.close()
    return 0


def _ops_dict(r: opsmod.OpsResult):
    return {"total_ops": r.total_ops, "arrivals": r.arrivals,
            "departures": r.departures, "touches": r.touches,
            "transits_excluded": r.transits,
            "unique_aircraft": r.unique_aircraft,
            "op_flights": r.op_flights, "pattern_flights": r.pattern_flights,
            "runways": r.runway_split(),
            "thresholds": vars(r.thresholds)}


if __name__ == "__main__":
    sys.exit(main())
