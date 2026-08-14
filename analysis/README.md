# analysis/ — KANP traffic-pattern study pipeline

Python analysis package for the OpenSky Symposium abstract (and eventually the
full paper) on traffic-pattern conformance at non-towered airports, using the
ADS-B position database collected by `pi/collector.py`.

Not part of the website — nothing here is referenced by any page. Requires
`numpy` and `matplotlib` (the only non-stdlib deps, figures/stats only; the
mirror step is stdlib-only like the rest of the repo's tooling).

## Layout

    kanpops/            the analysis package
      config.py         KANP geometry + detection thresholds (all deg TRUE)
      mirror.py         build a local SQLite copy of the Pi DB over its HTTP API
      db.py             read-only access, schema report, coverage, distributions
      flights.py        per-hex flight segmentation (gap threshold)
      ops.py            operation detection + threshold sensitivity
      figures.py        publication figures (matplotlib)
      report.py         full run: exploration -> ops -> sensitivity -> figures
    data/               local mirrors (gitignored — multi-GB, repo is public)
    output/             generated figures + ops_summary.json (gitignored)

## Usage (from this directory)

    # 1. one-time (or refresh): mirror the Pi's database locally
    python -m kanpops.mirror --api http://192.168.1.250:8787 --db data/kanp_mirror.db

    # 2. everything: prints the abstract summary, writes figures to output/
    python -m kanpops.report --db data/kanp_mirror.db --out output

    # ...restricted to an explicit window, with a named density figure
    python -m kanpops.report --db data/kanp_mirror.db --out output \
        --start 2026-07-06 --end 2026-08-06 --gaps-since 2026-08-01 \
        --density-fig figures/pattern_density

The mirror is resumable (re-run after an interruption; completed windows are
skipped) and verifies its row count against the Pi when done. All analysis
opens the database with SQLite `mode=ro`.

A scp'd copy of the real `/var/lib/kanp/kanp.db` drops in wherever the mirror
is used — same schema (`mirror.py` reproduces `pi/collector.py`'s exactly).

## The analysis window

Every DB reader takes an optional `db.Window` (UTC, **inclusive both ends**);
`report.py` exposes it as `--start` / `--end` (`YYYY-MM-DD` or unix). Defaults:
`--start` = first row in the file, `--end` = **the last complete UTC day**. The
collector is always still running, so the newest day in a fresh mirror is a
partial one and would drag the mean/median ops-per-day down — the default
excludes it rather than making every caller remember to.

The window is applied at row level in `flights.iter_hex_rows`, before
segmentation, so a flight straddling the boundary is *truncated* rather than
dropped or double-counted; an operation belongs to the window holding its
field contact. `db.coverage()` also treats a shortfall at either window edge
as a gap, so a collector outage across the boundary can't masquerade as "no
data yet". `--gaps-since YYYY-MM-DD` prints the gap list from a chosen date.

**Day basis** (`--day-basis`, default `utc`): ops-per-day buckets on UTC days
so they line up with the UTC window. Bucketing on the field's local day
(`local`) keeps an evening of pattern work in one bucket but is cut by the
UTC window at 20:00 EDT. The report prints both; say which one a quoted
per-day figure used.

## Method notes

- An *operation* follows FAA counting: landing = 1, takeoff = 1, circuit
  (touch-and-go / low approach / go-around) = 2.
- Detection thresholds matter more than they look: KANP's pattern (~1,000 ft
  MSL at ~1 nm) sits *inside* gates of 1,200 ft / 2 nm, so loose gates merge a
  whole circuit session into one contact (undercounting ops), while the site's
  tight ops gates (600 ft MSL / 0.8 nm, `js/site-config.js` `opsGates`)
  resolve individual circuits. `kanpops.ops.sensitivity()` quantifies this.
- Altitudes are ADS-B barometric (uncorrected). Headings/courses deg TRUE.
