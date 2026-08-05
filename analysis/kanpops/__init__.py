"""kanpops — analysis pipeline for KANP (Lee Airport) ADS-B traffic-pattern study.

Reusable modules, not a throwaway script:

    config    site constants (KANP geometry, runway, thresholds)
    mirror    build a faithful local SQLite copy of the Pi's kanp.db via its API
    db        read-only access, schema introspection, coverage / gap statistics
    flights   per-aircraft flight segmentation (gap threshold)
    ops       operation detection (arrival / departure / circuits) + sensitivity
    figures   publication figures (matplotlib)
    report    abstract-ready summary text

Everything downstream of `mirror` is strictly read-only against the database.

Typical use:

    python -m kanpops.mirror --api http://192.168.1.250:8787 --db analysis/data/kanp_mirror.db
    python -m kanpops.report --db analysis/data/kanp_mirror.db
"""

__version__ = "0.1.0"
