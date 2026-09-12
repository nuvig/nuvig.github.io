"""Nationwide procedure metrics + cycle-to-cycle changes.

Reads the committed per-airport files in data/procedures/apt/ (no downloads)
and writes:

    data/procedures/metrics.json   one row per coded procedure in the country
    data/procedures/changes.json   what this cycle added / withdrew / edited

Run after build_procedures.py each cycle:

    python scripts/build_procedure_metrics.py            # prev = last committed cycle
    python scripts/build_procedure_metrics.py --prev REV # diff against a git revision

metrics.json:
    {cycle, effective, built, cols:[...], rows:[[...],...],
     apts:{icao:[name, st, lat, lon, elev]},
     fixes:[[name, lat, lon, procs, airports], ...]}       # most-shared fixes
  cols (one value per row, null when not applicable):
    apt   ICAO / FAA id                      id    procedure ident
    name  chart name                         type  SID | STAR | APP
    kind  ILS · ILS/LOC · LOC · LOC BC · RNAV (GPS) · RNAV (RNP) · GPS · VOR ·
          VOR/DME · NDB · NDB/DME · TACAN · LDA · SDF · GLS · COPTER · VISUAL ·
          HI-… for high-altitude; SIDs/STARs: RNAV | CONV
    co    1 = plate only (no public CIFP coding)
    nt    transitions (enroute / runway), excluding the common route / final
    nl    coded legs                         nfix  distinct named fixes
    len   coded length nm: longest transition + common (or final)
    pts   leg path terminators used, comma-joined (TF,CF,HM…)
    top   highest altitude constraint ft     bot   lowest altitude constraint ft
    spd   speed restrictions                 mand  mandatory (at) altitudes
    rwy   runway from the chart name (APP)
    fc    final approach course °true (APP)  fd    FAF→MAP nm (APP)
    vpa   coded descent angle ° (APP)        faf   FAF altitude ft (APP)
    mtop  missed climb-to ft (APP)           mhold 1 = missed ends in a hold (APP)
    circ  1 = circling-only (no runway in the name) (APP)
    grad  implied climb gradient ft/nm to the first constraint (SID)
    dg    steepest descent the coded constraints require, ft/nm (STAR)

changes.json:
    {from:{cycle,effective}, to:{cycle,effective},
     apts_added:[[id,name,st]], apts_removed:[...],
     added:[[apt,id,name,type,kind]], removed:[...],
     changed:[[apt,id,name,type,kind,[note,...]]],
     counts:{added:{type:n}, removed:{type:n}, changed:{type:n}}}

Stdlib only.
"""
import glob, json, os, re, subprocess, sys
from collections import Counter, defaultdict
from math import atan2, cos, sin, hypot, radians, degrees

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PDIR = os.path.join(ROOT, 'data', 'procedures')

# leg array layout — mirrors build_procedures.py / procedures.js
L_FIX, L_LAT, L_LON, L_PT, L_TURN, L_ADESC, L_A1, L_A2, L_SPD, L_CRS, L_DIST, \
    L_VA, L_FLAGS, L_REC, L_THETA, L_RHO, L_CTR = range(17)

COLS = ['apt', 'id', 'name', 'type', 'kind', 'co', 'nt', 'nl', 'nfix', 'len', 'pts',
        'top', 'bot', 'spd', 'mand', 'rwy', 'fc', 'fd', 'vpa', 'faf', 'mtop', 'mhold',
        'circ', 'grad', 'dg']

# ---------------------------------------------------------------- geo

def dlon(a, b):
    return (b[1] - a[1] + 540) % 360 - 180   # antimeridian-safe (PMDY fixes sit at 180.0)

def dist_nm(a, b):
    dy = (b[0] - a[0]) * 60
    dx = dlon(a, b) * 60 * cos(radians((a[0] + b[0]) / 2))
    return hypot(dx, dy)

def brg(a, b):
    dy = b[0] - a[0]
    dx = dlon(a, b) * cos(radians((a[0] + b[0]) / 2))
    return (degrees(atan2(dx, dy)) + 360) % 360

def dest(p, brg_deg, nm):
    lat = p[0] + nm * cos(radians(brg_deg)) / 60
    lon = p[1] + nm * sin(radians(brg_deg)) / (60 * cos(radians(p[0])))
    return (lat, lon)

# legs that end at their named fix (a leg to a vector / manual termination does not)
AT_FIX = {'IF', 'TF', 'CF', 'DF', 'RF', 'AF', 'HF', 'HA', 'HM', 'PI', 'FC'}

# ---------------------------------------------------------------- classify

APP_KIND_RE = re.compile(
    r'^(?P<hi>HI-)?(?P<cop>COPTER )?(?P<k>ILS OR LOC|ILS/DME|ILS|LOC BC|LOC/DME|LOC/NDB|LOC|'
    r'RNAV \(RNP\)|RNAV \(GPS\)|RNP|GPS|VOR/DME OR TACAN|VOR OR TACAN|VOR/DME|VOR|'
    r'NDB/DME|NDB|TACAN|LDA/DME|LDA|SDF|GLS|MLS)\b')
PREFIX_KIND = {'I': 'ILS/LOC', 'L': 'LOC', 'B': 'LOC BC', 'R': 'RNAV (GPS)', 'H': 'RNAV (RNP)',
               'P': 'GPS', 'V': 'VOR', 'S': 'VOR', 'D': 'VOR/DME', 'N': 'NDB', 'Q': 'NDB/DME',
               'X': 'LDA', 'U': 'SDF', 'J': 'GLS', 'T': 'TACAN', 'G': 'IGS', 'W': 'MLS'}
KIND_NORM = {'ILS OR LOC': 'ILS/LOC', 'ILS/DME': 'ILS', 'LOC/DME': 'LOC', 'LOC/NDB': 'LOC',
             'RNP': 'RNAV (RNP)', 'VOR/DME OR TACAN': 'VOR/DME', 'VOR OR TACAN': 'VOR',
             'LDA/DME': 'LDA'}

def app_kind(proc):
    name = proc.get('name') or ''
    m = APP_KIND_RE.match(name)
    if m:
        k = KIND_NORM.get(m.group('k'), m.group('k'))
        if m.group('cop'):
            return 'COPTER'
        return ('HI-' if m.group('hi') else '') + k
    if 'VISUAL' in name:
        return 'VISUAL'
    return PREFIX_KIND.get(proc['id'][:1], 'OTHER')

def runway_of(name):
    m = re.search(r'RWY\s*(\d{1,2}[LRC]?(?:/[LRC])?)', name or '')
    return m.group(1) if m else None

def alt_of(leg):
    d, a1, a2 = leg[L_ADESC], leg[L_A1], leg[L_A2]
    if a1 is None and a2 is None:
        return None
    if d == 'B' and a1 is not None and a2 is not None:
        return (a1 + a2) / 2
    return a1 if a1 is not None else a2

def alts_of(leg):
    return [a for a in (leg[L_A1], leg[L_A2]) if a is not None]

def is_mandatory(leg):
    return leg[L_ADESC] in (None, '', '@') and bool(alts_of(leg))

def bounds(leg):
    """(floor, ceiling) the constraint allows; None = unbounded."""
    d, a1, a2 = leg[L_ADESC], leg[L_A1], leg[L_A2]
    if a1 is None and a2 is None:
        return None, None
    if d == '+':
        return a1, None
    if d == '-':
        return None, a1
    if d == 'B' and a1 is not None and a2 is not None:
        return min(a1, a2), max(a1, a2)
    a = a1 if a1 is not None else a2
    return a, a

# ---------------------------------------------------------------- metrics

def trans_len(legs):
    """Length along named fixes, preferring coded leg distances."""
    total, last = 0.0, None
    for leg in legs:
        p = (leg[L_LAT], leg[L_LON]) if leg[L_LAT] is not None else None
        if leg[L_DIST] and (leg[L_PT] in ('CF', 'TF', 'DF', 'FC', 'AF', 'RF')):
            total += leg[L_DIST]
        elif p and last:
            total += dist_nm(last, p)
        if p:
            last = p
    return total

def proc_row(doc, proc):
    ptype = proc['type']
    name = proc.get('name') or proc['id']
    if ptype == 'APP':
        kind = app_kind(proc)
    else:
        kind = 'RNAV' if '(RNAV)' in name or 'RNAV' in name else 'CONV'
    row = {c: None for c in COLS}
    row.update(apt=doc['id'], id=proc['id'], name=name, type=ptype, kind=kind,
               co=1 if proc.get('co') else 0)
    trans = proc.get('trans') or []
    if not trans:
        return row
    kinds_t = [t['k'] for t in trans]
    row['nt'] = sum(1 for k in kinds_t if k not in ('common', 'final'))
    legs_all = [l for t in trans for l in t['legs']]
    row['nl'] = len(legs_all)
    row['nfix'] = len({l[L_FIX] for l in legs_all if l[L_FIX]})
    pts = sorted({l[L_PT] for l in legs_all if l[L_PT]})
    row['pts'] = ','.join(pts)
    alts = [a for l in legs_all for a in alts_of(l)]
    if alts:
        row['top'], row['bot'] = max(alts), min(alts)
    row['spd'] = sum(1 for l in legs_all if l[L_SPD])
    row['mand'] = sum(1 for l in legs_all if is_mandatory(l))
    # coded length: longest side transition + the shared middle
    side = [trans_len(t['legs']) for t in trans if t['k'] not in ('common', 'final')]
    mid = sum(trans_len(t['legs']) for t in trans if t['k'] in ('common', 'final'))
    row['len'] = round((max(side) if side else 0) + mid, 1)

    if ptype == 'APP':
        row['rwy'] = runway_of(name)
        row['circ'] = 0 if row['rwy'] else 1
        fin = next((t for t in trans if t['k'] == 'final'), None)
        if fin:
            legs = fin['legs']
            mi = next((i for i, l in enumerate(legs) if l[L_FLAGS] & 1), None)
            if mi is not None and mi > 0:
                mapi = mi - 1
                vai = next((i for i, l in enumerate(legs[:mi]) if l[L_VA]), None)
                fafi = (vai - 1) if vai is not None and vai >= 1 else (mapi - 1 if mapi >= 1 else None)
                mapl = legs[mapi]
                if mapl[L_VA]:
                    row['vpa'] = abs(mapl[L_VA])
                if fafi is not None and fafi >= 0:
                    fafl = legs[fafi]
                    row['faf'] = alt_of(fafl)
                    if fafl[L_LAT] is not None and mapl[L_LAT] is not None:
                        a, b = (fafl[L_LAT], fafl[L_LON]), (mapl[L_LAT], mapl[L_LON])
                        row['fd'] = round(dist_nm(a, b), 1)
                        row['fc'] = round(brg(a, b))
                missed = legs[mi:]
                malts = [a for l in missed for a in alts_of(l)]
                if malts:
                    row['mtop'] = max(malts)
                row['mhold'] = 1 if any(l[L_PT] in ('HM', 'HA', 'HF') for l in missed) else 0
    elif ptype == 'SID':
        # implied gradient: (first at-or-above constraint - field elevation) over
        # the coded path distance from the departure end of the runway; a vector
        # leg before that constraint makes the path length unknown -> no figure
        elev = doc.get('elev') or 0
        rw = {r[0]: r for r in (doc.get('rw') or [])}
        best = None
        for t in trans:
            if t['k'] != 'runway':
                continue
            r = rw.get(t['t'])
            if not r:
                continue
            hdg = r[3]
            origin = dest((r[1], r[2]), hdg, r[4] / 6076.12) if hdg is not None and r[4] else (r[1], r[2])
            path, last = 0.0, origin
            for i, l in enumerate(t['legs']):
                if l[L_LAT] is None or l[L_PT] not in AT_FIX:
                    if i == 0 and l[L_PT] in ('VA', 'CA', 'FA'):
                        continue            # initial climb on heading: short, path unknown
                    break
                p = (l[L_LAT], l[L_LON])
                if l[L_PT] == 'DF' and hdg is not None:
                    # direct-to after the initial climb: the straight line is the path
                    # only when the fix is ahead of the runway, not behind a turn-back
                    off = abs((brg(origin, p) - hdg + 540) % 360 - 180)
                    if off > 60:
                        break
                path += dist_nm(last, p)
                last = p
                a = None
                if l[L_ADESC] == '+' and l[L_A1] is not None:
                    a = l[L_A1]
                elif l[L_ADESC] in (None, '', '@') and l[L_A1] is not None:
                    a = l[L_A1]
                elif l[L_ADESC] == 'B':
                    a = min(alts_of(l))
                if a is None:
                    continue
                if path >= 1 and a > elev:
                    g = (a - elev) / path
                    if best is None or g > best:
                        best = g
                break
        if best is not None and best < 2000:
            row['grad'] = round(best)
    elif ptype == 'STAR':
        # steepest implied descent between successive coded constraints on any path
        best = None
        for t in trans:
            prev, last, path = None, None, 0.0
            for l in t['legs']:
                if l[L_LAT] is None or l[L_PT] not in AT_FIX:
                    prev, last, path = None, None, 0.0     # vectors: path unknown
                    continue
                p = (l[L_LAT], l[L_LON])
                if last:
                    path += dist_nm(last, p)
                last = p
                lo, hi = bounds(l)
                if lo is None and hi is None:
                    continue
                # prev = (floor at the earlier fix, path there); the descent the
                # constraints *require* is from that floor down to this ceiling
                if prev and hi is not None and path - prev[1] >= 3 and prev[0] > hi:
                    g = (prev[0] - hi) / (path - prev[1])
                    if best is None or g > best:
                        best = g
                if lo is not None:
                    prev = (lo, path)
        if best is not None and best < 1500:
            row['dg'] = round(best)
    return row

def build_metrics(docs, index):
    rows, fixes = [], defaultdict(lambda: [None, None, set(), set()])
    for icao in sorted(docs):
        doc = docs[icao]
        for proc in doc.get('procs') or []:
            rows.append(proc_row(doc, proc))
            for t in proc.get('trans') or []:
                for l in t['legs']:
                    if l[L_FIX] and l[L_LAT] is not None and not l[L_FIX].startswith('RW'):
                        f = fixes[l[L_FIX]]
                        f[0], f[1] = l[L_LAT], l[L_LON]
                        f[2].add(icao + '|' + proc['id'])
                        f[3].add(icao)
    apts = {}
    for a in index['apts']:
        apts[a[0]] = [a[1], a[8] if len(a) > 8 else None, a[2], a[3],
                      docs.get(a[0], {}).get('elev')]
    top = sorted(fixes.items(), key=lambda kv: -len(kv[1][2]))[:400]
    fix_rows = [[n, v[0], v[1], len(v[2]), len(v[3])] for n, v in top]
    return {'cycle': index.get('cycle'), 'effective': index.get('effective'),
            'built': index.get('built'), 'cols': COLS,
            'rows': [[r[c] for c in COLS] for r in rows], 'apts': apts, 'fixes': fix_rows}

# ---------------------------------------------------------------- changes

def leg_sig(l):
    return (l[L_FIX], l[L_PT], l[L_TURN], l[L_ADESC], l[L_A1], l[L_A2], l[L_SPD],
            l[L_CRS], l[L_DIST], l[L_VA], l[L_FLAGS] & 1)

def fmt_alt(l):
    d, a1, a2 = l[L_ADESC], l[L_A1], l[L_A2]
    if a1 is None and a2 is None:
        return '—'
    f = lambda v: 'FL%d' % (v // 100) if v >= 18000 else '%d' % v
    if d == '+': return '≥' + f(a1)
    if d == '-': return '≤' + f(a1)
    if d == 'B': return f(min(a1, a2)) + '–' + f(max(a1, a2))
    return '@' + f(a1 if a1 is not None else a2)

def diff_trans(a, b, notes, label):
    la, lb = a['legs'], b['legs']
    fa = [l[L_FIX] or l[L_PT] for l in la]
    fb = [l[L_FIX] or l[L_PT] for l in lb]
    fa = [x for i, x in enumerate(fa) if i == 0 or fa[i - 1] != x]   # holds repeat the fix
    fb = [x for i, x in enumerate(fb) if i == 0 or fb[i - 1] != x]
    if fa != fb:
        sa, sb = set(fa), set(fb)
        gone, new = [x for x in fa if x not in sb], [x for x in fb if x not in sa]
        bits = []
        if gone: bits.append('−' + ' '.join(gone))
        if new: bits.append('+' + ' '.join(new))
        notes.append('%s: fixes %s' % (label, ', '.join(bits) if bits else 'reordered'))
        return
    for x, y in zip(la, lb):
        if leg_sig(x) == leg_sig(y):
            continue
        fx = x[L_FIX] or x[L_PT]
        if label == 'via ' + fx:
            fx = ''
        if fmt_alt(x) != fmt_alt(y):
            notes.append('%s %s: alt %s → %s' % (label, fx, fmt_alt(x), fmt_alt(y)))
        if x[L_SPD] != y[L_SPD]:
            notes.append('%s %s: speed %s → %s' % (label, fx, x[L_SPD] or '—', y[L_SPD] or '—'))
        if abs((x[L_VA] or 0) - (y[L_VA] or 0)) >= 0.05:
            notes.append('%s %s: angle %s → %s' % (label, fx, x[L_VA] or '—', y[L_VA] or '—'))
        # a tenth-of-a-degree course change is a magnetic-variation update, not an edit
        if x[L_CRS] is not None and y[L_CRS] is not None and abs(x[L_CRS] - y[L_CRS]) >= 1:
            notes.append('%s %s: course %s → %s' % (label, fx, x[L_CRS], y[L_CRS]))
        if x[L_PT] != y[L_PT] or x[L_TURN] != y[L_TURN]:
            notes.append('%s %s: leg %s%s → %s%s' % (label, fx, x[L_PT], x[L_TURN] or '',
                                                     y[L_PT], y[L_TURN] or ''))
        if (x[L_FLAGS] & 1) != (y[L_FLAGS] & 1):
            notes.append('%s %s: missed approach point moved' % (label, fx))

def diff_proc(a, b):
    notes = []
    ta = {t['t']: t for t in a.get('trans') or []}
    tb = {t['t']: t for t in b.get('trans') or []}
    for k in ta:
        if k not in tb:
            notes.append('transition %s withdrawn' % k)
    for k in tb:
        if k not in ta:
            notes.append('transition %s added' % k)
    for k in ta:
        if k in tb:
            diff_trans(ta[k], tb[k], notes, k if k.startswith('(') else 'via ' + k)
    seen, uniq = set(), []
    for n in notes:
        if n not in seen:
            seen.add(n); uniq.append(n.replace(' : ', ': '))
    notes[:] = uniq
    if (a.get('name') or '') != (b.get('name') or ''):
        notes.insert(0, 'renamed from %s' % a.get('name'))
    if bool(a.get('co')) != bool(b.get('co')):
        notes.insert(0, 'now coded' if a.get('co') else 'coding withdrawn (plate only)')
    return notes

def build_changes(old_docs, old_index, new_docs, new_index, kinds):
    out = {'from': {'cycle': old_index.get('cycle'), 'effective': old_index.get('effective')},
           'to': {'cycle': new_index.get('cycle'), 'effective': new_index.get('effective')},
           'apts_added': [], 'apts_removed': [], 'added': [], 'removed': [], 'changed': []}
    counts = {'added': Counter(), 'removed': Counter(), 'changed': Counter()}
    for icao in sorted(set(old_docs) | set(new_docs)):
        o, n = old_docs.get(icao), new_docs.get(icao)
        if o and not n:
            out['apts_removed'].append([icao, o.get('name'), None])
            for p in o.get('procs') or []:
                out['removed'].append([icao, p['id'], p.get('name') or p['id'], p['type'],
                                       kinds.get((icao, p['id']))])
                counts['removed'][p['type']] += 1
            continue
        if n and not o:
            out['apts_added'].append([icao, n.get('name'), None])
        po = {p['id']: p for p in (o or {}).get('procs') or []}
        pn = {p['id']: p for p in n.get('procs') or []}
        # a SID/STAR revision renumbers (CONLE5 -> CONLE6): pair it as one change
        base = lambda pid: re.sub(r'\d+$', '', pid)
        revised = {}
        for pid, p in po.items():
            if pid in pn or p['type'] == 'APP':
                continue
            succ = [q for q in pn if q not in po and base(q) == base(pid)
                    and pn[q]['type'] == p['type']]
            if len(succ) == 1:
                revised[succ[0]] = pid
        for pid, p in po.items():
            if pid not in pn and pid not in revised.values():
                out['removed'].append([icao, pid, p.get('name') or pid, p['type'],
                                       app_kind(p) if p['type'] == 'APP' else None])
                counts['removed'][p['type']] += 1
        for pid, p in pn.items():
            k = kinds.get((icao, pid))
            if pid in revised:
                notes = ['revised from ' + revised[pid]] + [n for n in diff_proc(po[revised[pid]], p)
                                                            if not n.startswith('renamed from')]
                out['changed'].append([icao, pid, p.get('name') or pid, p['type'], k, notes[:12]])
                counts['changed'][p['type']] += 1
            elif pid not in po:
                out['added'].append([icao, pid, p.get('name') or pid, p['type'], k])
                counts['added'][p['type']] += 1
            else:
                notes = diff_proc(po[pid], p)
                if notes:
                    out['changed'].append([icao, pid, p.get('name') or pid, p['type'], k, notes[:12]])
                    counts['changed'][p['type']] += 1
    out['counts'] = {k: dict(v) for k, v in counts.items()}
    return out

# ---------------------------------------------------------------- io

def load_tree_fs():
    docs = {}
    for f in glob.glob(os.path.join(PDIR, 'apt', '*.json')):
        with open(f, encoding='utf-8') as fh:
            d = json.load(fh)
        docs[d['id']] = d
    with open(os.path.join(PDIR, 'index.json'), encoding='utf-8') as fh:
        return docs, json.load(fh)

def git(*args, **kw):
    return subprocess.run(['git', *args], cwd=ROOT, capture_output=True, check=True, **kw).stdout

def load_tree_git(rev):
    paths = git('ls-tree', '-r', '--name-only', rev, 'data/procedures/apt').decode().split()
    spec = '\n'.join('%s:%s' % (rev, p) for p in paths) + '\n'
    raw = git('cat-file', '--batch', input=spec.encode())
    docs, i = {}, 0
    while i < len(raw):
        nl = raw.index(b'\n', i)
        header = raw[i:nl].decode().split()
        if len(header) < 3:  # missing
            i = nl + 1
            continue
        size = int(header[2])
        body = raw[nl + 1:nl + 1 + size]
        d = json.loads(body.decode('utf-8'))
        docs[d['id']] = d
        i = nl + 1 + size + 1
    index = json.loads(git('show', '%s:data/procedures/index.json' % rev).decode('utf-8'))
    return docs, index

def previous_cycle_rev(cur_cycle):
    """Newest commit whose index.json belongs to a different cycle."""
    revs = git('log', '--format=%H', '--', 'data/procedures/index.json').decode().split()
    for r in revs:
        try:
            idx = json.loads(git('show', '%s:data/procedures/index.json' % r).decode('utf-8'))
        except subprocess.CalledProcessError:
            continue
        if idx.get('cycle') != cur_cycle:
            return r, idx.get('cycle')
    return None, None

def main():
    prev = None
    if '--prev' in sys.argv:
        prev = sys.argv[sys.argv.index('--prev') + 1]
    docs, index = load_tree_fs()
    metrics = build_metrics(docs, index)
    with open(os.path.join(PDIR, 'metrics.json'), 'w', encoding='utf-8') as fh:
        json.dump(metrics, fh, separators=(',', ':'), ensure_ascii=False)
    print('metrics.json: %d procedures at %d airports, %d shared fixes'
          % (len(metrics['rows']), len(metrics['apts']), len(metrics['fixes'])))

    if not prev:
        prev, pc = previous_cycle_rev(index.get('cycle'))
        if not prev:
            print('no earlier cycle in git history; changes.json not written')
            return
        print('previous cycle %s at %s' % (pc, prev[:10]))
    old_docs, old_index = load_tree_git(prev)
    kinds = {(r[0], r[1]): r[4] for r in metrics['rows']}
    changes = build_changes(old_docs, old_index, docs, index, kinds)
    with open(os.path.join(PDIR, 'changes.json'), 'w', encoding='utf-8') as fh:
        json.dump(changes, fh, separators=(',', ':'), ensure_ascii=False)
    print('changes.json: %s -> %s: added %d, withdrawn %d, changed %d, airports +%d -%d'
          % (changes['from']['cycle'], changes['to']['cycle'], len(changes['added']),
             len(changes['removed']), len(changes['changed']),
             len(changes['apts_added']), len(changes['apts_removed'])))

if __name__ == '__main__':
    main()
