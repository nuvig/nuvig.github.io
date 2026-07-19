#!/usr/bin/env python3
"""Convert the FAA CIFP (ARINC 424) into per-airport procedure JSON for procedures.html.

Run on the PC whenever a new AIRAC cycle drops (28 days):

    python scripts/build_procedures.py            # downloads current cycle, writes data/procedures/
    python scripts/build_procedures.py FAACIFP18  # use an already-downloaded file

Output:
    data/procedures/index.json        airport list [icao, name, lat, lon, nSID, nSTAR, nAPP]
    data/procedures/apt/{ICAO}.json   full procedure geometry for one airport

Leg array layout (mirrored in js/procedures.js decodeLeg()):
    [fix, lat, lon, pathTerm, turnDir, altDesc, alt1, alt2, speed,
     course, dist, vertAngle, flags, recNav, theta, rho, center]
    flags bit0 = missed-approach segment, bit1 = flyover
    recNav = [ident, lat, lon] (AF arc center / conventional nav reference) or null
    center = [lat, lon] RF-leg arc centre, or null

Stdlib only — no pip installs.
"""
import io, json, os, re, sys, urllib.request, zipfile
from collections import defaultdict
from datetime import date, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'data', 'procedures')

# ---------------------------------------------------------------- download

AIRAC_ANCHOR = date(2026, 7, 9)  # a known cycle effective date; cycles are 28 days

def current_cycle_date(today=None):
    today = today or date.today()
    d = AIRAC_ANCHOR
    while d + timedelta(days=28) <= today:
        d += timedelta(days=28)
    while d > today:
        d -= timedelta(days=28)
    return d

def download_cifp():
    d = current_cycle_date()
    url = f'https://aeronav.faa.gov/Upload_313-d/cifp/CIFP_{d:%y%m%d}.zip'
    print('downloading', url)
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    data = urllib.request.urlopen(req).read()
    zf = zipfile.ZipFile(io.BytesIO(data))
    name = [n for n in zf.namelist() if n.startswith('FAACIFP')][0]
    return zf.read(name).decode('ascii', 'replace').splitlines(), d

# ---------------------------------------------------------------- field helpers

def f(line, a, b):
    """1-based inclusive column slice, stripped."""
    return line[a - 1:b].strip()

def parse_lat(s):
    if not s or len(s) < 9 or s[0] not in 'NS':
        return None
    v = int(s[1:3]) + int(s[3:5]) / 60 + int(s[5:9]) / 360000
    return round(-v if s[0] == 'S' else v, 5)

def parse_lon(s):
    if not s or len(s) < 10 or s[0] not in 'EW':
        return None
    v = int(s[1:4]) + int(s[4:6]) / 60 + int(s[6:10]) / 360000
    return round(-v if s[0] == 'W' else v, 5)

def parse_alt(s):
    s = s.strip()
    if not s:
        return None
    if s.startswith('FL'):
        try: return int(s[2:]) * 100
        except ValueError: return None
    try: return int(s)
    except ValueError: return None

def parse_num(s, scale=1.0):
    s = s.strip()
    if not s or not re.fullmatch(r'-?\d+', s):
        return None
    return round(int(s) * scale, 3)

def parse_magvar(s):
    # E/W + tenths of a degree, e.g. W0110 -> -11.0 (west negative)
    if not s or s[0] not in 'EW':
        return None
    try: v = int(s[1:]) / 10
    except ValueError: return None
    return -v if s[0] == 'W' else v

# ---------------------------------------------------------------- approach names

APP_TYPES = {'I': 'ILS or LOC', 'L': 'LOC', 'B': 'LOC BC', 'R': 'RNAV (GPS)',
             'H': 'RNAV (RNP)', 'P': 'GPS', 'V': 'VOR', 'S': 'VOR/DME',
             'D': 'VOR/DME', 'N': 'NDB', 'Q': 'NDB/DME', 'X': 'LDA',
             'U': 'SDF', 'J': 'GLS', 'T': 'TACAN', 'G': 'IGS', 'W': 'MLS'}
APP_TYPES3 = {'RNV': 'RNAV (GPS)', 'VDM': 'VOR/DME', 'VOR': 'VOR', 'NDB': 'NDB',
              'LOC': 'LOC', 'LDA': 'LDA', 'GPS': 'GPS', 'ILS': 'ILS', 'LBC': 'LOC BC',
              'TAC': 'TACAN', 'SDF': 'SDF', 'RNP': 'RNAV (RNP)'}

def approach_name(ident):
    ident = ident.strip()
    m = re.fullmatch(r'([A-Z]{3})-([A-Z])', ident)          # circling: RNV-A
    if m:
        t = APP_TYPES3.get(m.group(1))
        return f'{t}-{m.group(2)}' if t else ident
    m = re.fullmatch(r'([A-Z])(\d{2})([LRC]?)(?:-?([XYZW]))?', ident)  # I10, R28-Y, H15L
    if m:
        t = APP_TYPES.get(m.group(1))
        if t:
            sfx = f' {m.group(4)}' if m.group(4) else ''
            return f'{t}{sfx} RWY {int(m.group(2))}{m.group(3)}'
    return ident

# route-type char -> transition kind, per subsection
SID_KIND = {'1': 'runway', '4': 'runway', 'F': 'runway', 'T': 'runway',
            '2': 'common', '5': 'common', 'M': 'common', '0': 'common',
            '3': 'enroute', '6': 'enroute', 'S': 'enroute', 'V': 'enroute'}
STAR_KIND = {'1': 'enroute', '4': 'enroute', '7': 'enroute', 'F': 'enroute',
             '2': 'common', '5': 'common', '8': 'common', 'M': 'common',
             '3': 'runway', '6': 'runway', '9': 'runway', 'S': 'runway'}

# ---------------------------------------------------------------- main parse

def build(lines):
    airports = {}                    # icao -> dict
    term_wp = {}                     # (apt, ident) -> (lat, lon)
    enroute_wp = {}                  # ident -> (lat, lon)
    navaids = {}                     # ident -> (lat, lon)
    ndbs = {}                        # ident -> (lat, lon)
    term_ndb = {}                    # (apt, ident) -> (lat, lon)
    runways = defaultdict(list)      # apt -> [[ident, lat, lon, brg, len], ...]
    legs = defaultdict(list)         # (apt, sub, proc) -> [raw lines]

    for line in lines:
        if len(line) < 132 or line[0] != 'S':
            continue
        sec = line[4]
        if sec == 'D':                                   # navaids: D (VHF) / DB (NDB)
            if line[5] == 'B':
                if f(line, 22, 22) in ('', '0', '1'):
                    lat, lon = parse_lat(f(line, 33, 41)), parse_lon(f(line, 42, 51))
                    if lat is not None:
                        ndbs.setdefault(f(line, 14, 17), (lat, lon))
            else:
                if f(line, 22, 22) in ('', '0', '1'):
                    lat, lon = parse_lat(f(line, 33, 41)), parse_lon(f(line, 42, 51))
                    if lat is None:                      # DME-only navaid
                        lat, lon = parse_lat(f(line, 56, 64)), parse_lon(f(line, 65, 74))
                    if lat is not None:
                        navaids.setdefault(f(line, 14, 17), (lat, lon))
        elif sec == 'E' and line[5] == 'A':              # enroute waypoints
            if f(line, 22, 22) in ('', '0', '1'):
                lat, lon = parse_lat(f(line, 33, 41)), parse_lon(f(line, 42, 51))
                if lat is not None:
                    enroute_wp.setdefault(f(line, 14, 18), (lat, lon))
        elif sec == 'P':
            apt, sub = f(line, 7, 10), line[12]
            if sub == 'A':
                lat, lon = parse_lat(f(line, 33, 41)), parse_lon(f(line, 42, 51))
                if lat is not None:
                    airports[apt] = {'id': apt, 'name': f(line, 94, 123).title(),
                                     'lat': lat, 'lon': lon,
                                     'elev': parse_num(f(line, 57, 61)),
                                     'mv': parse_magvar(f(line, 52, 56))}
            elif sub == 'C':
                if f(line, 22, 22) in ('', '0', '1'):
                    lat, lon = parse_lat(f(line, 33, 41)), parse_lon(f(line, 42, 51))
                    if lat is not None:
                        term_wp.setdefault((apt, f(line, 14, 18)), (lat, lon))
            elif sub == 'N':
                if f(line, 22, 22) in ('', '0', '1'):
                    lat, lon = parse_lat(f(line, 33, 41)), parse_lon(f(line, 42, 51))
                    if lat is not None:
                        term_ndb.setdefault((apt, f(line, 14, 17)), (lat, lon))
            elif sub == 'G':
                if f(line, 22, 22) in ('', '0', '1'):
                    lat, lon = parse_lat(f(line, 33, 41)), parse_lon(f(line, 42, 51))
                    if lat is not None:
                        runways[apt].append([f(line, 14, 18), lat, lon,
                                             parse_num(f(line, 28, 31), 0.1),
                                             parse_num(f(line, 23, 27))])
            elif sub in 'DEF':
                if f(line, 39, 39) in ('', '0', '1'):
                    legs[(apt, sub, f(line, 14, 19))].append(line)

    def resolve(apt, ident, fsec, fsub):
        key2 = (apt, ident)
        if fsec == 'P' and fsub == 'C': hit = term_wp.get(key2)
        elif fsec == 'E' and fsub == 'A': hit = enroute_wp.get(ident)
        elif fsec == 'D' and fsub == 'B': hit = ndbs.get(ident)
        elif fsec == 'D': hit = navaids.get(ident)
        elif fsec == 'P' and fsub == 'N': hit = term_ndb.get(key2)
        elif fsec == 'P' and fsub == 'G':
            hit = next(((r[1], r[2]) for r in runways.get(apt, []) if r[0] == ident), None)
        elif fsec == 'P' and fsub == 'A':
            a = airports.get(ident)
            hit = (a['lat'], a['lon']) if a else None
        else:
            hit = None
        if hit is None:  # fall back through every table — regional quirks
            hit = (term_wp.get(key2) or enroute_wp.get(ident) or navaids.get(ident)
                   or ndbs.get(ident) or term_ndb.get(key2))
        return hit

    def decode_leg(apt, line):
        fix = f(line, 30, 34)
        pos = resolve(apt, fix, line[36], line[37]) if fix else None
        desc = line[39:43]
        flags = (1 if desc[2] == 'M' else 0) | (2 if desc[1] == 'Y' else 0)
        rec = f(line, 51, 54)
        rec_pos = (navaids.get(rec) or ndbs.get(rec) or term_wp.get((apt, rec))
                   or enroute_wp.get(rec)) if rec else None
        ctr = f(line, 107, 111)
        ctr_pos = resolve(apt, ctr, f(line, 115, 115) or 'P', f(line, 116, 116) or 'C') if ctr else None
        dist_raw = f(line, 75, 78)
        dist = None if dist_raw.startswith('T') else parse_num(dist_raw, 0.1)
        return [fix or None,
                pos[0] if pos else None, pos[1] if pos else None,
                f(line, 48, 49) or None,
                f(line, 44, 44) or None,
                f(line, 83, 83) or None,
                parse_alt(f(line, 85, 89)), parse_alt(f(line, 90, 94)),
                parse_num(f(line, 100, 102)),
                parse_num(f(line, 71, 74), 0.1),
                dist,
                parse_num(f(line, 103, 106), 0.01),
                flags,
                [rec, rec_pos[0], rec_pos[1]] if rec_pos else None,
                parse_num(f(line, 63, 66), 0.1), parse_num(f(line, 67, 70), 0.1),
                [round(ctr_pos[0], 5), round(ctr_pos[1], 5)] if ctr_pos else None]

    # group legs into procedures/transitions per airport
    apt_procs = defaultdict(list)
    for (apt, sub, proc), rows in sorted(legs.items()):
        rows.sort(key=lambda l: (l[19], f(l, 21, 25), f(l, 27, 29)))
        trans = []
        cur = None
        for line in rows:
            rt, tid = line[19], f(line, 21, 25)
            if sub == 'D': kind = SID_KIND.get(rt, 'other')
            elif sub == 'E': kind = STAR_KIND.get(rt, 'other')
            else: kind = 'transition' if rt == 'A' else 'final'
            key = (rt, tid)
            if cur is None or cur['_k'] != key:
                cur = {'_k': key, 't': tid or ('(final)' if kind == 'final' else '(common)'),
                       'k': kind, 'legs': []}
                trans.append(cur)
            cur['legs'].append(decode_leg(apt, line))
        for t in trans:
            del t['_k']
        entry = {'id': proc, 'type': {'D': 'SID', 'E': 'STAR', 'F': 'APP'}[sub],
                 'trans': trans}
        if sub == 'F':
            entry['name'] = approach_name(proc)
        apt_procs[apt].append(entry)

    return airports, runways, apt_procs

# ---------------------------------------------------------------- write

def main():
    if len(sys.argv) > 1:
        with open(sys.argv[1], encoding='ascii', errors='replace') as fh:
            lines = fh.read().splitlines()
        cyc = current_cycle_date()   # assume the local file is the current cycle
    else:
        lines, cyc = download_cifp()

    airports, runways, apt_procs = build(lines)
    os.makedirs(os.path.join(OUT, 'apt'), exist_ok=True)

    index = []
    for apt, procs in sorted(apt_procs.items()):
        a = airports.get(apt)
        if not a:
            continue
        order = {'SID': 0, 'STAR': 1, 'APP': 2}
        procs.sort(key=lambda p: (order[p['type']], p['id']))
        doc = dict(a)
        doc['rw'] = runways.get(apt, [])
        doc['procs'] = procs
        with open(os.path.join(OUT, 'apt', apt + '.json'), 'w') as fh:
            json.dump(doc, fh, separators=(',', ':'))
        n = lambda t: sum(1 for p in procs if p['type'] == t)
        index.append([apt, a['name'], a['lat'], a['lon'], n('SID'), n('STAR'), n('APP')])

    meta = {'effective': f'{cyc:%Y-%m-%d}' if cyc else None,
            'built': f'{date.today():%Y-%m-%d}', 'apts': index}
    with open(os.path.join(OUT, 'index.json'), 'w') as fh:
        json.dump(meta, fh, separators=(',', ':'))
    print(f'{len(index)} airports written to {OUT}')

if __name__ == '__main__':
    main()
