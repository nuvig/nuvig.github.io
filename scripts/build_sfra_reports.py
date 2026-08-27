"""Reduce NASA ASRS Database Online CSV exports to data/sfra/asrs.json.

The DC SFRA page's "violation record" section reads that JSON. Pipeline:

  1. Export the reports from ASRS Database Online (asrs.arc.nasa.gov ->
     "Launch ASRS Database Online"). Two queries, Text contains [words] over
     Narrative + Synopsis:
        "SFRA OR ADIZ OR FRZ"   -> sfra.csv
        "P56"                   -> p56.csv
     scripts/fetch_asrs.py replays the query wizard end-to-end and works as
     of 2026-08 (brittle if NASA revs the ASP.NET app — run it by hand, not
     in CI):
        python scripts/fetch_asrs.py "SFRA OR ADIZ OR FRZ" sfra.csv
        python scripts/fetch_asrs.py "P56" p56.csv
  2. python scripts/build_sfra_reports.py sfra.csv p56.csv
  3. Commit data/sfra/asrs.json.

Output shape (consumed by js/sfra.js — change the two together):
  { "retrieved": "YYYY-MM-DD", "query": "...", "count": N,
    "years": { "2003": {"n":400,"viol":123}, ... },       # by incident year
    "events": [ { "acn": 87212, "ym": "198805", "loc": "SXC", "st": "CA",
                  "anom": "...", "syn": "...", "terms": ["ADIZ"],
                  "viol": true }, ... ] }                  # newest first

ASRS CSVs have TWO header rows (category / field). Dates are YYYYMM only —
ASRS de-identifies to month granularity. Narratives are deliberately NOT
carried into the JSON (2+ MB); the synopsis is.

Stdlib only, like every scripts/build_*.py.
"""
import csv
import json
import re
import sys
from datetime import date
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / 'data' / 'sfra' / 'asrs.json'

TERMS = [
    ('SFRA', re.compile(r'\bSFRA\b', re.I)),
    ('ADIZ', re.compile(r'\bADIZ\b', re.I)),
    ('FRZ', re.compile(r'\bFRZ\b', re.I)),
    ('P-56', re.compile(r'\bP[- ]?56[AB]?\b', re.I)),
]


def read_export(path):
    """Yield dicts keyed 'Category::Field' from a 2-header-row ASRS CSV."""
    with open(path, newline='', encoding='utf-8', errors='replace') as f:
        rows = csv.reader(f)
        cats = next(rows)
        fields = next(rows)
        keys = [f'{c.strip()}::{n.strip()}'.strip(':') for c, n in zip(cats, fields)]
        for row in rows:
            if not row or not row[0].strip().isdigit():
                continue  # trailing blank/footer lines
            yield dict(zip(keys, row))


def main(argv):
    if not argv:
        sys.exit('usage: python scripts/build_sfra_reports.py <sfra.csv> [p56.csv ...]')
    events = {}
    for path in argv:
        for rec in read_export(path):
            acn = int(rec['ACN'])
            text = ' '.join((rec.get('Report 1::Narrative', ''),
                             rec.get('Report 2::Narrative', ''),
                             rec.get('Report 1::Synopsis', '')))
            terms = [name for name, rx in TERMS if rx.search(text)]
            anom = rec.get('Events::Anomaly', '').strip()
            ev = {
                'acn': acn,
                'ym': rec.get('Time::Date', '').strip(),
                'loc': rec.get('Place::Locale Reference', '').strip(),
                'st': rec.get('Place::State Reference', '').strip(),
                'anom': anom,
                'syn': rec.get('Report 1::Synopsis', '').strip(),
                'terms': terms,
                'viol': 'Airspace Violation' in anom,
            }
            prev = events.get(acn)
            if prev:  # same report matched both queries — merge term flags
                prev['terms'] = sorted(set(prev['terms']) | set(terms))
            else:
                events[acn] = ev

    evs = sorted(events.values(), key=lambda e: (e['ym'], e['acn']), reverse=True)
    years = {}
    for e in evs:
        y = e['ym'][:4]
        if not y.isdigit():
            continue
        bucket = years.setdefault(y, {'n': 0, 'viol': 0})
        bucket['n'] += 1
        bucket['viol'] += 1 if e['viol'] else 0

    out = {
        'retrieved': date.today().isoformat(),
        'query': 'ASRS Database Online full-text: "SFRA OR ADIZ OR FRZ" + "P56" '
                 '(narrative & synopsis, whole word)',
        'count': len(evs),
        'years': years,
        'events': evs,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(out, f, separators=(',', ':'), ensure_ascii=False)
    print(f'wrote {OUT} — {len(evs)} events, {min(years)}–{max(years)}, '
          f'{sum(v["viol"] for v in years.values())} flagged as airspace violations')


if __name__ == '__main__':
    main(sys.argv[1:])
