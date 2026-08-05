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

The mirror is resumable (re-run after an interruption; completed windows are
skipped) and verifies its row count against the Pi when done. All analysis
opens the database with SQLite `mode=ro`.

A scp'd copy of the real `/var/lib/kanp/kanp.db` drops in wherever the mirror
is used — same schema (`mirror.py` reproduces `pi/collector.py`'s exactly).

## Method notes

- An *operation* follows FAA counting: landing = 1, takeoff = 1, circuit
  (touch-and-go / low approach / go-around) = 2.
- Detection thresholds matter more than they look: KANP's pattern (~1,000 ft
  MSL at ~1 nm) sits *inside* gates of 1,200 ft / 2 nm, so loose gates merge a
  whole circuit session into one contact (undercounting ops), while the site's
  tight ops gates (600 ft MSL / 0.8 nm, `js/site-config.js` `opsGates`)
  resolve individual circuits. `kanpops.ops.sensitivity()` quantifies this.
- Altitudes are ADS-B barometric (uncorrected). Headings/courses deg TRUE.
