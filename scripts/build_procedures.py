#!/usr/bin/env python3
"""Convert the FAA CIFP (ARINC 424) + d-TPP chart metafile into per-airport
procedure JSON for procedures.html.

Run on the PC whenever a new AIRAC cycle drops (28 days):

    python scripts/build_procedures.py                         # downloads current cycle
    python scripts/build_procedures.py FAACIFP18               # local CIFP, download metafile
    python scripts/build_procedures.py FAACIFP18 metafile.xml  # both local

Output:
    data/procedures/index.json        {effective, built, cycle, apts:[[icao, name,
                                       lat, lon, nSID, nSTAR, nAPP, city, state]]}
    data/procedures/apt/{ICAO}.json   full procedure geometry + chart refs for one airport

Each procedure may carry a d-TPP chart ref {n: chart name, p: pdf, a: amdt,
c: [continuation pdfs], v: [variant charts (CAT II / PRM / …)]} — the FAA plate
lives at https://aeronav.faa.gov/d-tpp/{cycle}/{pdf}. Published charts with no
CIFP coding (many VOR/NDB/TACAN procedures, visuals, most military fields)
become chart-only entries: {co: 1, trans: []}. Airport-level charts (diagram,
takeoff/alternate minimums, hotspots, LAHSO) land in doc.tpp.apt.

Leg array layout (mirrored in js/procedures.js decodeLeg()):
    [fix, lat, lon, pathTerm, turnDir, altDesc, alt1, alt2, speed,
     course, dist, vertAngle, flags, recNav, theta, rho, center]
    flags bit0 = missed-approach segment, bit1 = flyover
    recNav = [ident, lat, lon] (AF arc center / conventional nav reference) or null
    center = [lat, lon] RF-leg arc centre, or null

Stdlib only — no pip installs.
"""
import io, json, os, re, sys, urllib.request, zipfile
import xml.etree.ElementTree as ET
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

def dtpp_cycle_label(d):
    """d-TPP cycle number ('2607') for the cycle starting on date d.

    Cycle starts are exactly 28 days apart; the number is YY + the 1-based
    index of the start date within its calendar year (resets each January).
    Mirrored in js/procedures.js dtppCycle().
    """
    n = (d - date(d.year, 1, 1)).days // 28 + 1
    return f'{d.year % 100:02d}{n:02d}'

def download_metafile(cycle):
    url = f'https://aeronav.faa.gov/d-tpp/{cycle}/xml_data/d-TPP_Metafile.xml'
    print('downloading', url)
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    return urllib.request.urlopen(req).read()

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

# ARINC 5.10: 'S' is a VOR procedure flown off a VOR/DME or VORTAC — the chart
# is titled plain "VOR RWY xx" (KGED S04 = VOR RWY 04), not VOR/DME.
APP_TYPES = {'I': 'ILS or LOC', 'L': 'LOC', 'B': 'LOC BC', 'R': 'RNAV (GPS)',
             'H': 'RNAV (RNP)', 'P': 'GPS', 'V': 'VOR', 'S': 'VOR',
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

# ---------------------------------------------------------------- d-TPP charts
#
# The d-TPP metafile lists every published terminal chart. DP/STAR records carry
# the ARINC ident in <faanfd18> ("TERPZ8.TERPZ" / "BUBBI.ANTHM5"); IAP records
# don't, so approach charts are matched by parsing the chart title into
# candidate ARINC idents ("VOR RWY 04" -> V04/S04/D04). Charts that match no
# CIFP procedure become chart-only entries so the plate is still browsable.

# each " OR "-separated title piece: chart type -> candidate ident letters,
# in priority order (e.g. a "VOR" title may be coded V, S or D)
IAP_CHART_TYPES = [
    ('ILS/DME', 'IL'), ('ILS PRM', 'I'), ('ILS', 'IL'),
    ('LOC/DME BC', 'B'), ('LOC BC', 'B'), ('LOC/DME', 'LI'), ('LOC/NDB', 'L'),
    ('LOC PRM', 'L'), ('LOC', 'LI'),
    ('RNAV (GPS) PRM', 'R'), ('RNAV (GPS)', 'R'), ('RNAV (RNP)', 'H'), ('RNAV', 'R'),
    ('GLS PRM', 'J'), ('GLS', 'J'), ('GBAS', 'J'),
    ('GPS', 'P'),
    ('VOR/DME', 'DSV'), ('VOR', 'VSD'),
    ('NDB/DME', 'QN'), ('NDB', 'NQ'),
    ('TACAN', 'T'), ('LDA/DME', 'X'), ('LDA PRM', 'X'), ('LDA', 'X'),
    ('SDF', 'U'), ('MLS', 'W'),
]
# circling procedures use 3-letter type codes: "VOR-A" -> VOR-A / VDM-A
CIRC3 = {'I': ['ILS'], 'L': ['LOC'], 'B': ['LBC'], 'R': ['RNV'], 'H': ['RNP'],
         'P': ['GPS'], 'V': ['VOR', 'VDM'], 'S': ['VOR', 'VDM'], 'D': ['VDM', 'VOR'],
         'N': ['NDB'], 'Q': ['NDB'], 'T': ['TAC'], 'X': ['LDA'], 'U': ['SDF'],
         'W': ['MLS'], 'J': ['GLS']}
_TYPE_ALT = '|'.join(re.escape(t) for t, _ in IAP_CHART_TYPES)
_IAP_TYPE_MAP = dict(IAP_CHART_TYPES)
# "ILS Z OR LOC Z RWY 13": every piece is TYPE [suffix letter]; the last piece
# also carries "RWY nn[LRC][/R]" or a circling "-A"
_PIECE_RE = re.compile(r'^(?:HI-|HI )?(?P<typ>' + _TYPE_ALT + r')(?: (?P<sfx>[A-Z]))?$')
_TAIL_RE = re.compile(
    r'^(?:HI-|HI )?(?P<typ>' + _TYPE_ALT + r')'
    r'(?: (?P<sfx>[A-Z]))?'
    r'(?: (?:RWY|RY) (?P<rw>\d{1,2})(?P<side>[LRC]?)(?:/(?P<side2>[LRC]))?|(?P<circ>-[A-Z]))'
    r'(?P<var>\s*\(.*\))?$')

def iap_candidates(name):
    """Chart title -> (candidate ARINC idents, is_variant) or None if unparsable.

    is_variant marks charts that share another chart's coding (CAT II/III,
    SA CAT, PRM, CONVERGING): they attach to the matched procedure as extra
    plates instead of claiming it.
    """
    n = re.sub(r'\s+', ' ', name.upper().strip())
    variant = False
    if n.startswith('CONVERGING '):
        n = n[len('CONVERGING '):]
        variant = True
    pieces = n.split(' OR ')
    tail = _TAIL_RE.match(pieces[-1])
    if not tail:
        return None
    typed = []
    for p in pieces[:-1]:
        m = _PIECE_RE.match(p)
        if not m:
            return None
        typed.append((_IAP_TYPE_MAP[m.group('typ')], m.group('sfx') or ''))
    typed.append((_IAP_TYPE_MAP[tail.group('typ')], tail.group('sfx') or ''))
    out = []
    add = out.append
    if tail.group('circ'):
        letter = tail.group('circ')[-1]
        for letters, _ in typed:
            for t in letters:
                for c3 in CIRC3.get(t, []):
                    ident = f'{c3}-{letter}'
                    if ident not in out:
                        add(ident)
    else:
        rw = int(tail.group('rw'))
        sides = [tail.group('side') or '']
        if tail.group('side2'):
            sides.append(tail.group('side2'))
        for letters, sfx in typed:
            for side in sides:
                for t in letters:
                    base = f'{t}{rw:02d}{side}'
                    for ident in ((base + sfx, base + '-' + sfx) if sfx else (base,)):
                        if ident not in out:
                            add(ident)
    if tail.group('var') or any('PRM' in p for p in pieces):
        variant = True
    return out, variant

NUMWORD = {'ONE': 1, 'TWO': 2, 'THREE': 3, 'FOUR': 4, 'FIVE': 5, 'SIX': 6,
           'SEVEN': 7, 'EIGHT': 8, 'NINE': 9}

def dp_name_ident(name):
    """Fallback for DP/STAR charts missing <faanfd18>: 'CONLE FIVE (RNAV)' -> CONLE5."""
    words = re.sub(r'\(.*?\)', '', name.upper()).split()
    if len(words) >= 2 and words[-1] in NUMWORD:
        return (''.join(words[:-1]))[:5] + str(NUMWORD[words[-1]])
    return None

def parse_dtpp(xml_bytes, cifp_airports):
    """Metafile XML -> {cifp airport id: {'city','st','charts':[chart dicts]}}.

    Continuation pages (", CONT.1") fold into their base chart's 'c' list.
    """
    root = ET.fromstring(xml_bytes)
    out = {}
    skipped = 0
    for st_el in root:
        st = st_el.get('ID') or ''
        for city_el in st_el:
            city = (city_el.get('ID') or '').title()
            for apt_el in city_el:
                icao = apt_el.get('icao_ident') or ''
                fid = apt_el.get('apt_ident') or ''
                key = icao if icao in cifp_airports else (fid if fid in cifp_airports else None)
                if key is None:
                    skipped += 1
                    continue
                entry = out.setdefault(key, {'city': city, 'st': st, 'charts': []})
                by_base = {}
                for rec in apt_el.findall('record'):
                    d = {c.tag: (c.text or '').strip() for c in rec}
                    name = d.get('chart_name', '')
                    m = re.search(r',?\s*CONT\.(\d+)$', name)
                    if m:
                        base = by_base.get((d['chart_code'], name[:m.start()]))
                        if base is not None:
                            base.setdefault('c', []).append(d['pdf_name'])
                        continue
                    ch = {'code': d['chart_code'], 'n': name, 'p': d['pdf_name']}
                    if d.get('amdtnum'):
                        ch['a'] = d['amdtnum']
                    if d.get('faanfd18'):
                        ch['f18'] = d['faanfd18']
                    by_base[(d['chart_code'], name)] = ch
                    entry['charts'].append(ch)
    print(f'd-TPP metafile: {len(out)} airports matched, {skipped} not in CIFP')
    return out

def chart_ref(ch):
    """Public chart dict for the JSON output (drop matching-only keys)."""
    ref = {'n': ch['n'], 'p': ch['p']}
    if ch.get('a'):
        ref['a'] = ch['a']
    if ch.get('c'):
        ref['c'] = ch['c']
    return ref

def merge_charts(procs, dtpp_entry):
    """Attach chart refs to CIFP procedures and append chart-only entries.

    Returns the airport-level chart list [[label, pdf], ...].
    """
    apt_charts = []
    if not dtpp_entry:
        return apt_charts
    by_type = {'APP': {}, 'SID': {}, 'STAR': {}}
    for p in procs:
        by_type[p['type']][p['id']] = p

    def set_chart(proc, ch, rename):
        if 'chart' in proc:                       # extra plate for the same coding
            proc['chart'].setdefault('v', []).append(chart_ref(ch))
        else:
            proc['chart'] = chart_ref(ch)
            if rename:
                proc['name'] = ch['n']            # display the charted title

    def chart_only(ch, ptype, ident=None):
        ident = ident or re.sub(r'[^A-Z0-9]+', '', ch['n'].upper())[:10] or 'CHART'
        base, k = ident, 2
        while ident in by_type[ptype]:
            ident = f'{base}{k}'
            k += 1
        entry = {'id': ident, 'type': ptype, 'name': ch['n'], 'co': 1,
                 'chart': chart_ref(ch), 'trans': []}
        by_type[ptype][ident] = entry
        procs.append(entry)

    # plain titles first so e.g. "ILS OR LOC RWY 10" claims I10 before
    # "ILS RWY 10 (CAT II - III)" attaches to it as a variant plate
    iaps = [ch for ch in dtpp_entry['charts'] if ch['code'] == 'IAP']
    parsed = [(ch, iap_candidates(ch['n'])) for ch in iaps]
    parsed.sort(key=lambda t: bool(t[1] and t[1][1]))
    for ch, cand in parsed:
        if cand is None:                          # visuals, copter, AAUP pages
            if 'AAUP' in ch['n']:
                apt_charts.append([ch['n'].title(), ch['p']])
            else:
                chart_only(ch, 'APP')
            continue
        idents, variant = cand
        appmap = by_type['APP']
        hits = [appmap[i] for i in idents if i in appmap]
        if not hits:
            chart_only(ch, 'APP', idents[0])
        elif variant:
            # CAT II / SA CAT / PRM / converging plates ride on the chart that
            # claimed the shared coding (the plain "ILS OR LOC …" chart)
            tgt = next((p for p in hits if 'chart' in p), hits[0])
            set_chart(tgt, ch, rename=False)
        else:
            # "ILS OR LOC RWY 10" covers both the I10 and L10 codings — give
            # the plate to every uncharted sibling, retitling only the primary
            fresh = [p for p in hits if 'chart' not in p]
            if fresh:
                for p in fresh:
                    set_chart(p, ch, rename=(p is hits[0]))
            else:
                set_chart(hits[0], ch, rename=False)

    for ch in dtpp_entry['charts']:
        code = ch['code']
        if code in ('DP', 'ODP', 'STR'):
            ptype = 'STAR' if code == 'STR' else 'SID'
            pmap = by_type[ptype]
            parts = [p for p in ch.get('f18', '').split('.') if p]
            hit = next((p for p in parts if p in pmap), None)
            if not hit:
                ni = dp_name_ident(ch['n'])
                if ni and ni in pmap:
                    hit = ni
            if hit:
                set_chart(pmap[hit], ch, rename='chart' not in pmap[hit])
            else:
                chart_only(ch, ptype, parts[0] if parts else None)
        elif code in ('APD', 'MIN', 'HOT', 'LAH', 'DAU'):
            apt_charts.append([ch['n'].title(), ch['p']])
    return apt_charts

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
    cycle = dtpp_cycle_label(cyc)
    if len(sys.argv) > 2:
        with open(sys.argv[2], 'rb') as fh:
            meta_xml = fh.read()
    else:
        meta_xml = download_metafile(cycle)

    airports, runways, apt_procs = build(lines)
    dtpp = parse_dtpp(meta_xml, airports)

    # airports that publish procedure charts but have no CIFP-coded procedures
    # (most military fields) still get a page of chart-only entries
    for apt, entry in dtpp.items():
        if apt not in apt_procs and \
           any(ch['code'] in ('IAP', 'DP', 'ODP', 'STR') for ch in entry['charts']):
            apt_procs[apt] = []

    os.makedirs(os.path.join(OUT, 'apt'), exist_ok=True)

    index = []
    n_chart_only = n_charted = 0
    for apt, procs in sorted(apt_procs.items()):
        a = airports.get(apt)
        if not a:
            continue
        entry = dtpp.get(apt)
        apt_charts = merge_charts(procs, entry)
        n_chart_only += sum(1 for p in procs if p.get('co'))
        n_charted += sum(1 for p in procs if 'chart' in p)
        order = {'SID': 0, 'STAR': 1, 'APP': 2}
        procs.sort(key=lambda p: (order[p['type']], p['id']))
        doc = dict(a)
        doc['rw'] = runways.get(apt, [])
        if entry or apt_charts:
            doc['tpp'] = {'city': entry['city'] if entry else '',
                          'st': entry['st'] if entry else '', 'apt': apt_charts}
        doc['procs'] = procs
        with open(os.path.join(OUT, 'apt', apt + '.json'), 'w') as fh:
            json.dump(doc, fh, separators=(',', ':'))
        n = lambda t: sum(1 for p in procs if p['type'] == t)
        index.append([apt, a['name'], a['lat'], a['lon'], n('SID'), n('STAR'), n('APP'),
                      entry['city'] if entry else '', entry['st'] if entry else ''])

    meta = {'effective': f'{cyc:%Y-%m-%d}' if cyc else None,
            'built': f'{date.today():%Y-%m-%d}', 'cycle': cycle, 'apts': index}
    with open(os.path.join(OUT, 'index.json'), 'w') as fh:
        json.dump(meta, fh, separators=(',', ':'))
    print(f'{len(index)} airports written to {OUT} '
          f'({n_charted} procedures with plates, {n_chart_only} chart-only)')

if __name__ == '__main__':
    main()
