#!/usr/bin/env python3
"""Build data/radar.json — every radar site in the US National Airspace System
that a public source places on the map: FAA surveillance radars (terminal ASR
and en route ARSR sites, by their Mode S / ATCBI beacon assignments), the 45
FAA TDWRs, and the operational WSR-88D (NEXRAD) network.

Stdlib only. The inputs are three public GitHub repos, cloned beside this one
(nothing is fetched here — the FAA/NOAA hosts are not reachable from the web
session, and the repos are the mirrors that are):

  open-air-data/atc-radar   data/radars.geojson
      FAA Mode S site-assignment file (CONUS-NavC, 2010-03-03) + a few
      RadioReference rows carrying the primary radar type and range.
  danielway/nexrad          nexrad-model/data/operational-radar-sites.csv
      NWS GeoServer nws:radar_sites snapshot, operational WSR-88Ds only,
      audited weekly against NOAA (last_verified row = snapshot date).
  ARM-DOE/pyart             pyart/io/nexrad_common.py
      NEXRAD_LOCATIONS dict — the TDWR rows (T*** ids) are taken from here.

Usage (repo root):
  python3 scripts/build_radar.py \
      --atc   ../open-air-data/atc-radar/data/radars.geojson \
      --nws   ../danielway/nexrad/nexrad-model/data/operational-radar-sites.csv \
      --pyart ../arm-doe/pyart/pyart/io/nexrad_common.py

Output record (data/radar.json → sites[]):
  id    FAA site id (surveillance) or ICAO-style radar id (TDWR/WSR-88D)
  name  site name as the source gives it
  cat   term | enr | tdwr | nexrad
  pri   primary radar type when the source names it (ASR-9, ARSR-4 …)
  bcn   beacon / secondary (Mode S, ATCBI-6, ATCBI-6M)
  rng   nominal range, nm (source value where given, else the class default)
  lat, lon  degrees (WGS-84)
  elev  site elevation, ft MSL (WSR-88D/TDWR only)
  ii    Mode S interrogator code (II-nn) where the FAA file lists one
  mil   1 for DoD-owned sites the source flags
  src   key into meta.sources
"""

import argparse
import csv
import datetime as dt
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'data', 'radar.json')

# Nominal ranges, nautical miles. ASR: 60 nm (ASR-9/11 instrumented range).
# ARSR/CARSR: 200 nm (ARSR-4: 250). TDWR: 48 nm Doppler range. WSR-88D: 230 km
# reflectivity = 124 nm.
RNG = {'term': 60, 'enr': 200, 'tdwr': 48, 'nexrad': 124}
RNG_BY_TYPE = {'ARSR-4': 250, 'ARSR-3': 200, 'ARSR-1E': 200, 'AN/FPS-67B': 200,
               'FPS-117': 200, 'ASR-9': 60, 'ASR-11': 60, 'ASR-8': 60}

# FAA Mode S file type codes → (category, primary, beacon).
FAA_TYPES = {
    'ASR9-MDS': ('term', 'ASR-9', 'Mode S'),
    'ASR-9':    ('term', 'ASR-9', 'Mode S'),
    'TER-MDS':  ('term', None, 'Mode S'),
    'ENR-MDS':  ('enr', None, 'Mode S'),
    'ATCBI-6':  ('enr', None, 'ATCBI-6'),
    'ATCBI-6M': ('enr', None, 'ATCBI-6M'),
    'ATCBI-6C': None,            # NAV CANADA sites in the coordination file — not NAS
    'ARSR-4':   ('enr', 'ARSR-4', None),
    'ARSR-3':   ('enr', 'ARSR-3', None),
    'ARSR-1E':  ('enr', 'ARSR-1E', None),
    'AN/FPS-67B': ('enr', 'AN/FPS-67B', None),
    'FPS-117':  ('enr', 'FPS-117', None),
    '':         ('term', None, None),   # DoD airfield sites with no type given
    None:       ('term', None, None),
}

# TDWR ids are T + the airport the radar serves (NWS TDWR list, 45 sites).
TDWR_NAMES = {
    'TADW': 'Andrews AFB', 'TATL': 'Atlanta', 'TBNA': 'Nashville', 'TBOS': 'Boston',
    'TBWI': 'Baltimore–Washington', 'TCLT': 'Charlotte', 'TCMH': 'Columbus',
    'TCVG': 'Cincinnati', 'TDAL': 'Dallas Love', 'TDAY': 'Dayton',
    'TDCA': 'Washington National', 'TDEN': 'Denver', 'TDFW': 'Dallas–Fort Worth',
    'TDTW': 'Detroit', 'TEWR': 'Newark', 'TFLL': 'Fort Lauderdale',
    'THOU': 'Houston Hobby', 'TIAD': 'Washington Dulles', 'TIAH': 'Houston Intercontinental',
    'TICH': 'Wichita', 'TIDS': 'Indianapolis', 'TJFK': 'New York JFK',
    'TLAS': 'Las Vegas', 'TLVE': 'Cleveland', 'TMCI': 'Kansas City', 'TMCO': 'Orlando',
    'TMDW': 'Chicago Midway', 'TMEM': 'Memphis', 'TMIA': 'Miami', 'TMKE': 'Milwaukee',
    'TMSP': 'Minneapolis–St Paul', 'TMSY': 'New Orleans', 'TOKC': 'Oklahoma City',
    'TORD': "Chicago O'Hare", 'TPBI': 'West Palm Beach', 'TPHL': 'Philadelphia',
    'TPHX': 'Phoenix', 'TPIT': 'Pittsburgh', 'TRDU': 'Raleigh–Durham',
    'TSDF': 'Louisville', 'TSJU': 'San Juan', 'TSLC': 'Salt Lake City',
    'TSTL': 'St Louis', 'TTPA': 'Tampa', 'TTUL': 'Tulsa',
}

FAA_FILE_MARK = 'working_03mar10'      # the FAA spectrum file's name carries its date


def r5(x):
    return round(float(x), 5)


def load_faa(path):
    """FAA surveillance sites from the atc-radar GeoJSON. Rows from the FAA Mode S
    file are the base; RadioReference rows for the same id add the primary type
    and range (the FAA file only names the beacon)."""
    with open(path, encoding='utf-8') as f:
        gj = json.load(f)
    base, extra = {}, []
    for ft in gj['features']:
        p = ft['properties']
        lon, lat = ft['geometry']['coordinates'][:2]
        if not (-180 < lon < -60 and 15 < lat < 75):
            continue                                   # Europe / Asia rows
        src = p.get('source', '')
        t = p.get('type')
        if t not in FAA_TYPES:
            print('unknown FAA type', t, p, file=sys.stderr)
            continue
        if FAA_TYPES[t] is None:
            continue                                   # Canadian beacon sites
        cat, pri, bcn = FAA_TYPES[t]
        rec = {
            'id': (p.get('id') or '').strip(), 'name': p.get('name', '').strip(),
            'cat': cat, 'pri': pri, 'bcn': bcn,
            'rng': RNG_BY_TYPE.get(pri, RNG[cat]),
            'lat': r5(lat), 'lon': r5(lon),
        }
        if p.get('range'):
            m = re.match(r'(\d+)\s*NM', p['range'])
            if m:
                rec['rng'] = int(m.group(1))
        if p.get('idents'):
            rec['ii'] = p['idents']
        if p.get('military'):
            rec['mil'] = 1
        if FAA_FILE_MARK in src:
            rec['src'] = 'faa2010'
            key = rec['id'] or rec['name']
            if key in base:
                print('duplicate FAA id', key, file=sys.stderr)
            base[key] = rec
        else:
            rec['src'] = 'rr' if 'radioreference' in src else 'hbag'
            extra.append(rec)
    out = list(base.values())
    for rec in extra:
        key = rec['id'] or rec['name']
        b = base.get(key)
        if b is None:
            out.append(rec)
            continue
        # Same site: keep the FAA position/beacon, take the primary type + range.
        if rec['pri']:
            b['pri'] = rec['pri']
            b['rng'] = rec['rng']
            b['src'] = 'faa2010+rr'
    return out


def load_nws(path):
    """Operational WSR-88Ds from the NWS radar_sites snapshot CSV."""
    sites, verified = [], None
    with open(path, encoding='utf-8') as f:
        rows = list(csv.reader(f))
    header_i = next(i for i, r in enumerate(rows) if r and r[0] == 'id')
    for r in rows[:header_i]:
        if r and r[0] == 'last_verified':
            verified = r[1]
    cols = rows[header_i]
    for r in rows[header_i + 1:]:
        if not r or len(r) < len(cols):
            continue
        d = dict(zip(cols, r))
        name = d['registry_name']
        if d['source_name'] and d['source_name'] != name:
            name = f"{name} ({d['source_name']})"
        sites.append({
            'id': d['id'], 'name': name, 'cat': 'nexrad', 'pri': 'WSR-88D', 'bcn': None,
            'rng': RNG['nexrad'], 'lat': r5(d['latitude']), 'lon': r5(d['longitude']),
            'elev': int(round(float(d['elevation_meters']) / 0.3048)), 'src': 'nws',
        })
    return sites, verified


def load_tdwr(path):
    """TDWR rows (T***) out of Py-ART's NEXRAD_LOCATIONS dict. TJUA is the San
    Juan WSR-88D (in the NWS list), not a TDWR, so it is skipped here."""
    src = open(path, encoding='utf-8').read()
    pat = re.compile(r'"(T[A-Z]{3})":\s*\{"lat":\s*([-\d.]+),\s*"lon":\s*([-\d.]+),\s*"elev":\s*(-?\d+)\}')
    sites = []
    for sid, lat, lon, elev in pat.findall(src):
        if sid not in TDWR_NAMES:
            if sid != 'TJUA':
                print('TDWR id without a name', sid, file=sys.stderr)
            continue
        sites.append({
            'id': sid, 'name': TDWR_NAMES[sid], 'cat': 'tdwr', 'pri': 'TDWR', 'bcn': None,
            'rng': RNG['tdwr'], 'lat': r5(lat), 'lon': r5(lon), 'elev': int(elev), 'src': 'pyart',
        })
    missing = sorted(set(TDWR_NAMES) - {s['id'] for s in sites})
    if missing:
        print('TDWR sites not in Py-ART table', missing, file=sys.stderr)
    return sites


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--atc', required=True, help='open-air-data/atc-radar data/radars.geojson')
    ap.add_argument('--nws', required=True, help='danielway/nexrad nexrad-model/data/operational-radar-sites.csv')
    ap.add_argument('--pyart', required=True, help='ARM-DOE/pyart pyart/io/nexrad_common.py')
    ap.add_argument('-o', '--out', default=OUT)
    a = ap.parse_args()

    faa = load_faa(a.atc)
    nex, verified = load_nws(a.nws)
    tdwr = load_tdwr(a.pyart)
    sites = faa + tdwr + nex
    order = {'term': 0, 'enr': 1, 'tdwr': 2, 'nexrad': 3}
    sites.sort(key=lambda s: (order[s['cat']], s['id'] or '~', s['name']))
    for s in sites:                       # drop empty optionals, keep the file small
        for k in ('pri', 'bcn'):
            if s.get(k) is None:
                del s[k]

    counts = {}
    for s in sites:
        counts[s['cat']] = counts.get(s['cat'], 0) + 1
    out = {
        'built': dt.date.today().isoformat(),
        'counts': counts,
        'ranges': RNG,
        'sources': {
            'faa2010': {'label': 'FAA Mode S site file (CONUS-NavC, 2010-03-03)',
                        'via': 'open-air-data/atc-radar',
                        'url': 'https://github.com/open-air-data/atc-radar'},
            'rr': {'label': 'RadioReference ATC radar sites thread (primary type, range)',
                   'via': 'open-air-data/atc-radar',
                   'url': 'https://github.com/open-air-data/atc-radar'},
            'hbag': {'label': 'FAA NAS overview briefing, 2011 (DoD sites)',
                     'via': 'open-air-data/atc-radar',
                     'url': 'https://github.com/open-air-data/atc-radar'},
            'nws': {'label': f'NWS radar_sites (operational WSR-88D), snapshot {verified}',
                    'via': 'danielway/nexrad',
                    'url': 'https://github.com/danielway/nexrad'},
            'pyart': {'label': 'Py-ART NEXRAD_LOCATIONS (TDWR rows)',
                      'via': 'ARM-DOE/pyart',
                      'url': 'https://github.com/ARM-DOE/pyart'},
        },
        'sites': sites,
    }
    with open(a.out, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
        f.write('\n')
    print(f"wrote {a.out}: {len(sites)} sites {counts}")


if __name__ == '__main__':
    main()
