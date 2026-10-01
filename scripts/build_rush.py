#!/usr/bin/env python3
"""Airline Traffic compile — the tracker's rush-hour data (kanp.html, Airline
Traffic tab).

Reads the Pi exporter's per-day snapshots on the `traffic-data` branch
(v2/summary.json + v2/days/YYYY-MM-DD.json) and compiles every airline
movement at the big airports inside the 60 nm circle into one small tree,
published to the `rush-data` branch by .github/workflows/rush.yml (one
force-pushed commit, like notam-data: the tree is the state).

    python3 scripts/build_rush.py --out rush            # incremental
    python3 scripts/build_rush.py --out rush --force    # recompile every day
    python3 scripts/build_rush.py --selftest

Stdlib only. Source base: RUSH_SRC (default the traffic-data raw URL);
--local DIR reads day files from a directory instead (tests, dev).

What a day file becomes (days/YYYY-MM-DD.json):

  date, generated, src {generated, aircraft, points}  — the day file's own
      stamps; a day is recompiled when summary.json's aircraft/points for it
      move (the exporter re-exports today and yesterday, and heal.py
      backfills), or always for today and yesterday.
  cs_hist   1 when the day file carries callsign history (exporter ≥ v2
      writes `flights: [[ts, callsign], …]` on a track whose callsign
      changed during the day). Without it a track carries only the LAST
      callsign seen, so a jet that lands as SWA123 and leaves as SWA456 is
      logged SWA456 both ways — airline and timing right, the arrival's
      flight number wrong. Ops carry `x` = 1 when the callsign is exact.
  cov [24]  distinct aircraft seen per local hour, any type. An hour with
      fewer than COV_MIN is an outage, not a quiet hour, and the aggregates
      leave it out of every mean (the 09-12 disk incident is a day of them).
  ops [[ts, ap, kind, cs, type, hex, rwy, lee, x], …]
      ts    touchdown (first on-ground fix, else the last fix) for an
            arrival; liftoff (last on-ground fix, else the first fix) for a
            departure
      ap    BWI · DCA · IAD · ADW · MTN
      kind  A / D
      rwy   runway direction from the course flown on final / initial climb
            (e.g. "33"; L/R is not resolved), "" when it could not be read
      lee   lowest altitude the same flight segment had within LEE_NM of
            KANP, null if it never came that close — what the "near Lee"
            share of an airport's arrivals is counted from
  low [24][BANDS]  airliner-type aircraft within LEE_NM of KANP, by hour and
      by the lowest altitude band each reached in that hour — one count per
      aircraft per hour, in the band of its lowest point
  term {region: [96]}  distinct aircraft airborne per 15-min slot inside
      each region (airliner-type only for the 25 nm airport circles, every
      aircraft for lee15) — the approach-control workload proxy. ADS-B
      counts aircraft, not transmissions; it is labelled a proxy on the page.
  map {band: [[x, y, seconds], …]}  seconds of airliner-type presence per
      MAP_CELL_NM cell (east/north of KANP, ±MAP_HALF_NM) per altitude band,
      from the flight paths resampled every MAP_STEP_S s — where the big
      ones are when they are low near the field
  atc {feed: {label, freq, n: [96], s: [96]}}  transmissions and airtime
      seconds per 15-min slot per recorded frequency, copied from
      v2/atc/YYYY-MM-DD.json when the exporter has published it (counts
      only — no audio or text ever leaves the Pi)

rush.json (what the page reads — one document):

  generated, v, tz, airports {id: {name, lat, lon, rwys}}, order,
  airlines {prefix: name}, cov_min, bands, map_meta,
  days [{d, cls (wk/sat/sun/hol), cov "24 chars: 1 covered, 0 missing, x not
         yet reached by the exporter when the day was compiled", cs_hist,
         ap {ID: {a "96", d "96", al {PFX: ["96 arr", "96 dep"]},
                  rwy {"33": "24 arrivals by hour"},
                  lee {"33": [arrivals that passed within lee_nm of KANP
                              below 6,000 ft, arrivals on that runway,
                              arrivals that passed below 3,000 ft]}}},
         low ["BANDS" × 24], term {region: "96"}, atc {feed: {n "96", s [96]}}}]
      — every quoted series is one base-62 character per slot (slot_alphabet,
      clamped at 61): "96" = 15-min slots, "24" = hours; airline series only
      for the airports in TOP_AIRLINES
  feeds {feed: {label, freq}}
  recurring [[ap, kind, cs, type, median_min, p25, p75, days_seen,
              days_possible, first, last, dowmask], …]  — the observed
      schedule: a callsign seen on ≥ REC_MIN_DAYS days at one airport,
      timed over its last 30 sightings. There is no schedule feed; this is
      what the sky did.
  map {band: [[x, y, seconds], …]}  every compiled day summed

Day classes: wk = Mon–Fri, sat, sun, hol = a US federal holiday (kept out of
the weekday mean). Local time is RUSH_TZ (America/New_York), the Pi's zone,
which is also what the day files are cut on.
"""

import argparse
import collections
import datetime as dt
import gzip
import http.client
import json
import math
import os
import statistics
import sys
import tempfile
import urllib.error
import urllib.request
from zoneinfo import ZoneInfo

SRC = os.environ.get(
    "RUSH_SRC", "https://raw.githubusercontent.com/nuvig/nuvig.github.io/traffic-data/v2")
TZ = ZoneInfo(os.environ.get("RUSH_TZ", "America/New_York"))
VERSION = 1

# Field center — mirror of SITE.tracker (js/site-config.js) / KANP_LAT, KANP_LON.
KANP_LAT, KANP_LON = 38.9422, -76.5684

# The airports. Runway true headings were read off the data itself (the peaks
# of the final-approach course histogram over archived days), then named by
# magnetic ≈ true + 11° W: BWI 33 = 319°, DCA 01 = 355°, IAD 01 = 002° / 30 =
# 289°, ADW 01 ≈ 001°, MTN 33 = 315° (js/site-config.js agrees on MTN).
AIRPORTS = {
    "BWI": {"name": "Baltimore/Washington Intl", "lat": 39.1754, "lon": -76.6683, "elev": 146,
            "rwys": {"10": 89, "28": 269, "15": 139, "33": 319}},
    "DCA": {"name": "Washington National", "lat": 38.8521, "lon": -77.0377, "elev": 15,
            "rwys": {"01": 355, "19": 175, "15": 141, "33": 321, "04": 25, "22": 205}},
    "IAD": {"name": "Washington Dulles", "lat": 38.9445, "lon": -77.4558, "elev": 313,
            "rwys": {"01": 2, "19": 182, "12": 109, "30": 289}},
    "ADW": {"name": "Joint Base Andrews", "lat": 38.8108, "lon": -76.8670, "elev": 280,
            "rwys": {"01": 1, "19": 181}},
    "MTN": {"name": "Martin State", "lat": 39.3254, "lon": -76.4138, "elev": 21,
            "rwys": {"15": 135, "33": 315}},
}
ORDER = ["BWI", "DCA", "IAD", "ADW", "MTN"]
AT_NM = 3.0          # "at the airport": within this and low
AT_AGL = 1500        # … below field elevation + this (ft, barometric)
FAR_NM = 5.0         # a flight must also have been this far out to be an op
RWY_TOL = 18         # course must sit within this of a runway heading
GAP_S = 600          # a track splits into flights at a gap this long…
DWELL_S = 300        # …or at a ground dwell this long (DP collapses a parked
                     # aircraft to two fixes far apart in time)
COV_MIN = 3          # distinct aircraft per hour below this = outage
LEE_NM = 5.0
BANDS = [3000, 4000, 5000, 6000, 8000]   # upper edges, ft; last = ceiling considered
MAP_HALF_NM = 8.0
MAP_CELL_NM = 0.25
MAP_STEP_S = 10
TERM_STEP_S = 60
TERM = {  # region: (lat, lon, radius nm, max alt ft, airliner-only)
    "bwi25": (AIRPORTS["BWI"]["lat"], AIRPORTS["BWI"]["lon"], 25.0, 10000, True),
    "dca25": (AIRPORTS["DCA"]["lat"], AIRPORTS["DCA"]["lon"], 25.0, 10000, True),
    "iad25": (AIRPORTS["IAD"]["lat"], AIRPORTS["IAD"]["lon"], 25.0, 10000, True),
    "lee15": (KANP_LAT, KANP_LON, 15.0, 6000, False),
}
MAP_MIN_S = 60       # a cell with less airliner time than this over the archive is noise
REC_MIN_DAYS = 4
REC_CAP = 2000
# Airline prefixes carried as per-day 15-min series, per airport. ADW and MTN
# see almost no airline-coded traffic, so they carry totals only.
TOP_AIRLINES = {"BWI": 6, "DCA": 4, "IAD": 4, "ADW": 0, "MTN": 0}
# 96-slot series are stored as one base-62 character per slot (0-9a-zA-Z,
# clamped at 61) — half the bytes of a JSON array, and rush.json carries
# several hundred of them per day. Decoded by SLOT_ALPHABET.indexOf in
# js/kanp-rush.js.
SLOT_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"

# Non-GA ICAO type designators — mirror of AIRLINER_TYPES in pi/exporter.py /
# KANP.AIRLINER_TYPES in js/kanp.js (plus the A3../B7.. families by prefix).
AIRLINER_TYPES = frozenset("""
A19N A20N A21N B37M B38M B39M B3XM CRJ1 CRJ2 CRJ7 CRJ9 CRJX BCS1 BCS3
E135 E145 E170 E75L E75S E190 E195 E290 E295 RJ1H RJ85 RJ70 B461 B462 B463
F70 F100 AT43 AT44 AT45 AT46 AT72 AT73 AT75 AT76 DH8A DH8B DH8C DH8D SF34
SB20 D328 J328 MD11 MD81 MD82 MD83 MD87 MD88 MD90 DC10 DC93 DC94
""".split())

# Names for the callsign prefixes the page will show. Unknown prefixes print
# as themselves; this is not a registry, just the ones that turn up here.
AIRLINES = {
    "SWA": "Southwest", "AAL": "American", "DAL": "Delta", "UAL": "United",
    "JBU": "JetBlue", "FFT": "Frontier", "NKS": "Spirit", "ASA": "Alaska",
    "AAY": "Allegiant", "MXY": "Breeze", "SCX": "Sun Country",
    "RPA": "Republic", "JIA": "PSA", "EDV": "Endeavor", "ENY": "Envoy",
    "PDT": "Piedmont", "SKW": "SkyWest", "GJS": "GoJet", "ASH": "Mesa",
    "UCA": "CommuteAir", "AWI": "Air Wisconsin", "CXK": "Contour",
    "FDX": "FedEx", "UPS": "UPS", "ATN": "Air Transport Intl", "ABX": "ABX Air",
    "GTI": "Atlas", "CKS": "Kalitta", "PAC": "Polar",
    "EJA": "NetJets", "LXJ": "Flexjet", "VXP": "Vista", "XOJ": "XOJet",
    "JTL": "Jet Linx", "TWY": "Sunwest", "WUP": "Wheels Up",
    "ACA": "Air Canada", "BAW": "British Airways", "VIR": "Virgin Atlantic",
    "DLH": "Lufthansa", "AFR": "Air France", "KLM": "KLM", "UAE": "Emirates",
    "QTR": "Qatar", "ETH": "Ethiopian", "SAA": "South African", "ETD": "Etihad",
    "SAM": "Special Air Mission", "RCH": "Reach (AMC)", "EVA": "EVA Air",
    "TRP": "Teton / Travel", "CAP": "Civil Air Patrol",
}

HOLIDAY_CACHE = {}


def log(msg):
    print(msg, flush=True)


# ---------------------------------------------------------------------------
# geometry
# ---------------------------------------------------------------------------
def dist_nm(lat1, lon1, lat2, lon2):
    r = math.pi / 180
    a = (math.sin((lat2 - lat1) * r / 2) ** 2
         + math.cos(lat1 * r) * math.cos(lat2 * r) * math.sin((lon2 - lon1) * r / 2) ** 2)
    return 2 * 3440.065 * math.asin(math.sqrt(a))


def bearing(lat1, lon1, lat2, lon2):
    r = math.pi / 180
    y = math.sin((lon2 - lon1) * r) * math.cos(lat2 * r)
    x = (math.cos(lat1 * r) * math.sin(lat2 * r)
         - math.sin(lat1 * r) * math.cos(lat2 * r) * math.cos((lon2 - lon1) * r))
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def angdiff(a, b):
    d = abs(a - b) % 360
    return min(d, 360 - d)


def is_airliner(ac_type):
    t = (ac_type or "").upper().strip()
    if not t:
        return False
    if len(t) == 4 and (t.startswith("A3") or t.startswith("B7")):
        return True
    return t in AIRLINER_TYPES


def airline_prefix(cs):
    """ICAO three-letter operator prefix of an airline-style callsign
    ('SWA1234' → 'SWA'); None for N-numbers and the rest."""
    cs = (cs or "").strip().upper()
    if len(cs) >= 4 and cs[:3].isalpha() and cs[3].isdigit():
        return cs[:3]
    return None


def local(ts):
    return dt.datetime.fromtimestamp(ts, TZ)


def slot_of(ts):
    t = local(ts)
    return t.hour * 4 + t.minute // 15


def us_holidays(year):
    """US federal holidays (observed) for a year — by rule, no table."""
    if year in HOLIDAY_CACHE:
        return HOLIDAY_CACHE[year]
    D = dt.date

    def nth_weekday(month, weekday, n):
        d = D(year, month, 1)
        d += dt.timedelta(days=(weekday - d.weekday()) % 7)
        return d + dt.timedelta(weeks=n - 1)

    def last_weekday(month, weekday):
        d = D(year, month + 1, 1) - dt.timedelta(days=1) if month < 12 else D(year, 12, 31)
        return d - dt.timedelta(days=(d.weekday() - weekday) % 7)

    def observed(d):
        if d.weekday() == 5:
            return d - dt.timedelta(days=1)
        if d.weekday() == 6:
            return d + dt.timedelta(days=1)
        return d

    days = {
        observed(D(year, 1, 1)), nth_weekday(1, 0, 3), nth_weekday(2, 0, 3),
        last_weekday(5, 0), observed(D(year, 6, 19)), observed(D(year, 7, 4)),
        nth_weekday(9, 0, 1), nth_weekday(10, 0, 2), observed(D(year, 11, 11)),
        nth_weekday(11, 3, 4), observed(D(year, 12, 25)),
    }
    HOLIDAY_CACHE[year] = days
    return days


def day_class(date_str):
    d = dt.date.fromisoformat(date_str)
    if d in us_holidays(d.year):
        return "hol"
    return ("wk", "wk", "wk", "wk", "wk", "sat", "sun")[d.weekday()]


# ---------------------------------------------------------------------------
# per-day compile
# ---------------------------------------------------------------------------
def at_airport(lat, lon, alt, og):
    for ap in ORDER:
        a = AIRPORTS[ap]
        if dist_nm(lat, lon, a["lat"], a["lon"]) <= AT_NM and \
                (og or (alt is not None and alt <= a["elev"] + AT_AGL)):
            return ap
    return None


def split_flights(pts):
    """One track (a hex's whole day) → flight segments."""
    segs, cur = [], [pts[0]]
    for p, q in zip(pts, pts[1:]):
        if q[0] - p[0] > GAP_S or (p[5] and q[5] and q[0] - p[0] > DWELL_S):
            segs.append(cur)
            cur = [q]
        else:
            cur.append(q)
    segs.append(cur)
    return segs


def runway_for(ap, course):
    best, bd = "", 999
    for name, hdg in AIRPORTS[ap]["rwys"].items():
        d = angdiff(course, hdg)
        if d < bd:
            best, bd = name, d
    return best if bd <= RWY_TOL else ""


def course_at(seg, ap, arrival):
    """Course over the last (arrival) / first (departure) ≥ 1 nm of airborne
    fixes within 5 nm of the airport below pattern height."""
    a = AIRPORTS[ap]
    low = [p for p in seg if not p[5] and p[3] is not None and p[3] < a["elev"] + AT_AGL
           and dist_nm(p[1], p[2], a["lat"], a["lon"]) < 5]
    if len(low) < 2:
        return None
    if arrival:
        end = low[-1]
        for p in reversed(low[:-1]):
            if dist_nm(p[1], p[2], end[1], end[2]) >= 1 and end[0] - p[0] < 900:
                return bearing(p[1], p[2], end[1], end[2])
    else:
        start = low[0]
        for p in low[1:]:
            if dist_nm(start[1], start[2], p[1], p[2]) >= 1 and p[0] - start[0] < 900:
                return bearing(start[1], start[2], p[1], p[2])
    return None


def callsign_at(track, ts):
    hist = track.get("flights")
    if not hist:
        return track.get("flight") or ""
    cs = hist[0][1]
    for t, c in hist:
        if t <= ts:
            cs = c
        else:
            break
    return cs


def lee_min_alt(seg):
    m = None
    for p in seg:
        if p[5] or p[3] is None:
            continue
        if dist_nm(p[1], p[2], KANP_LAT, KANP_LON) <= LEE_NM:
            m = p[3] if m is None else min(m, p[3])
    return m


def band_of(alt):
    for i, top in enumerate(BANDS):
        if alt < top:
            return i
    return None


def resample(seg, step):
    """Linear resample of a flight's airborne path every `step` s. DP leaves a
    straight cruise as two fixes minutes apart, so interpolation across a
    gap inside a segment is the right reading of the data, not a guess."""
    out = []
    for p, q in zip(seg, seg[1:]):
        if p[5] or q[5] or p[3] is None or q[3] is None:
            continue
        span = q[0] - p[0]
        if span <= 0:
            continue
        n = max(1, int(span // step))
        for i in range(n):
            f = i / n
            out.append((p[0] + span * f, p[1] + (q[1] - p[1]) * f,
                        p[2] + (q[2] - p[2]) * f, p[3] + (q[3] - p[3]) * f))
    if seg and not seg[-1][5] and seg[-1][3] is not None:
        out.append((seg[-1][0], seg[-1][1], seg[-1][2], seg[-1][3]))
    return out


def near_any(seg, lat, lon, nm):
    return any(dist_nm(p[1], p[2], lat, lon) <= nm for p in seg)


def compile_day(day):
    """Day file dict → compiled record (see the module docstring)."""
    date = day["date"]
    cs_hist = 1 if day.get("cs_hist") else 0
    cov = [set() for _ in range(24)]
    ops = []
    low = [[0] * len(BANDS) for _ in range(24)]
    low_min = [dict() for _ in range(24)]      # hour → {hex: lowest band reached}
    term = {k: [set() for _ in range(96)] for k in TERM}
    grid = {b: collections.Counter() for b in range(len(BANDS))}
    cos_lat = math.cos(KANP_LAT * math.pi / 180)

    for track in day["tracks"]:
        pts = track.get("points") or []
        if len(pts) < 2:
            continue
        hx = track["hex"]
        airliner = is_airliner(track.get("type"))
        for p in pts:
            cov[local(p[0]).hour].add(hx)

        for seg in split_flights(pts):
            if len(seg) < 3:
                continue
            f, l = seg[0], seg[-1]
            ap_f = at_airport(f[1], f[2], f[3], f[5])
            ap_l = at_airport(l[1], l[2], l[3], l[5])
            lee = lee_min_alt(seg)

            def far(ap):
                a = AIRPORTS[ap]
                return any(dist_nm(p[1], p[2], a["lat"], a["lon"]) > FAR_NM for p in seg)

            def emit(ap, kind):
                if kind == "A":
                    ground = [p for p in seg if p[5]]
                    ts = ground[0][0] if ground else l[0]
                else:
                    ground = [p for p in seg if p[5] and at_airport(p[1], p[2], p[3], 1) == ap]
                    ts = ground[-1][0] if ground else f[0]
                c = course_at(seg, ap, kind == "A")
                rwy = runway_for(ap, c) if c is not None else ""
                ops.append([int(ts), ap, kind, callsign_at(track, ts), track.get("type") or "",
                            hx, rwy, lee, cs_hist])

            if ap_f and ap_l and ap_f == ap_l:
                if far(ap_f):
                    emit(ap_f, "D")
                    emit(ap_l, "A")
            else:
                if ap_l and far(ap_l):
                    emit(ap_l, "A")
                if ap_f and far(ap_f):
                    emit(ap_f, "D")

            # terminal-area presence, every aircraft (lee15) / airliners (circles)
            for ts, lat, lon, alt in resample(seg, TERM_STEP_S):
                sl = slot_of(ts)
                for k, (clat, clon, rad, top, al_only) in TERM.items():
                    if al_only and not airliner:
                        continue
                    if alt <= top and dist_nm(lat, lon, clat, clon) <= rad:
                        term[k][sl].add(hx)

            # the low picture around Lee, airliner types only
            if airliner and near_any(seg, KANP_LAT, KANP_LON, MAP_HALF_NM + 4):
                for ts, lat, lon, alt in resample(seg, MAP_STEP_S):
                    if alt >= BANDS[-1]:
                        continue
                    east = (lon - KANP_LON) * 60 * cos_lat
                    north = (lat - KANP_LAT) * 60
                    if abs(east) <= MAP_HALF_NM and abs(north) <= MAP_HALF_NM:
                        b = band_of(alt)
                        x = int((east + MAP_HALF_NM) // MAP_CELL_NM)
                        y = int((north + MAP_HALF_NM) // MAP_CELL_NM)
                        grid[b][(x, y)] += MAP_STEP_S
                    if east * east + north * north <= LEE_NM * LEE_NM:
                        hm = low_min[local(ts).hour]
                        b = band_of(alt)
                        if hx not in hm or b < hm[hx]:
                            hm[hx] = b

    for h in range(24):
        for b in low_min[h].values():
            low[h][b] += 1
    ops.sort(key=lambda o: o[0])
    return {
        "date": date,
        "generated": int(dt.datetime.now().timestamp()),
        "src": {"generated": day.get("generated"), "aircraft": len(day["tracks"]),
                "points": sum(len(t.get("points") or []) for t in day["tracks"])},
        "cs_hist": cs_hist,
        "cov": [len(s) for s in cov],
        "ops": ops,
        "low": low,
        "term": {k: [len(s) for s in v] for k, v in term.items()},
        "map": {str(b): [[x, y, s] for (x, y), s in sorted(g.items())]
                for b, g in grid.items() if g},
    }


# ---------------------------------------------------------------------------
# aggregate: rush.json
# ---------------------------------------------------------------------------
def dow_of(date_str):
    return dt.date.fromisoformat(date_str).weekday()


def enc(arr):
    return "".join(SLOT_ALPHABET[min(61, max(0, int(v)))] for v in arr)


def dec(s):
    return [SLOT_ALPHABET.index(c) for c in s]


def minute_of(ts):
    t = local(ts)
    return t.hour * 60 + t.minute


def aggregate(days, feeds):
    """Compiled day records (sorted by date) → rush.json dict."""
    # the per-airport airline set: top prefixes by ops over everything
    pfx_count = {ap: collections.Counter() for ap in ORDER}
    for d in days:
        for ts, ap, kind, cs, typ, hx, rwy, lee, x in d["ops"]:
            p = airline_prefix(cs)
            if p:
                pfx_count[ap][p] += 1
    top = {ap: [p for p, _ in pfx_count[ap].most_common(TOP_AIRLINES[ap])] for ap in ORDER}
    cs_hist_from = next((d["date"] for d in days if d.get("cs_hist")), None)

    out_days = []
    rec = collections.defaultdict(list)       # (ap, kind, cs) → [(date, minute, type)]
    grid = {str(b): collections.Counter() for b in range(len(BANDS))}
    for d in days:
        ap_rec = {}
        for ap in ORDER:
            ap_rec[ap] = {"a": [0] * 96, "d": [0] * 96,
                          "al": {p: [[0] * 96, [0] * 96] for p in top[ap]},
                          "rwy": {}, "lee": {}}
        for ts, ap, kind, cs, typ, hx, rwy, lee, x in d["ops"]:
            sl = slot_of(ts)
            r = ap_rec[ap]
            r["a" if kind == "A" else "d"][sl] += 1
            p = airline_prefix(cs)
            if p in r["al"]:
                r["al"][p][0 if kind == "A" else 1][sl] += 1
            if kind == "A" and rwy:
                r["rwy"].setdefault(rwy, [0] * 24)[local(ts).hour] += 1
                lr = r["lee"].setdefault(rwy, [0, 0, 0])
                lr[1] += 1
                if lee is not None and lee < BANDS[-2]:
                    lr[0] += 1
                    if lee < BANDS[0]:
                        lr[2] += 1
            if p:
                rec[(ap, kind, cs)].append((d["date"], minute_of(ts), typ))
        for b, cells in d.get("map", {}).items():
            for x, y, s in cells:
                grid[b][(x, y)] += s
        atc = None
        if d.get("atc"):
            atc = {k: {"n": enc(v["n"]), "s": [int(x) for x in v["s"]]}
                   for k, v in d["atc"].items()}
        for ap, r in ap_rec.items():
            r["a"], r["d"] = enc(r["a"]), enc(r["d"])
            r["al"] = {p: [enc(v[0]), enc(v[1])] for p, v in r["al"].items()}
            r["rwy"] = {k: enc(v) for k, v in r["rwy"].items()}
        gen = (d.get("src") or {}).get("generated") or 0
        day0 = dt.datetime.combine(dt.date.fromisoformat(d["date"]), dt.time(0), tzinfo=TZ)
        cov = ""
        for h, c in enumerate(d["cov"]):
            if c >= COV_MIN:
                cov += "1"
            elif (day0 + dt.timedelta(hours=h)).timestamp() > gen:
                cov += "x"            # the exporter had not reached this hour
            else:
                cov += "0"
        out_days.append({
            "d": d["date"], "cls": day_class(d["date"]),
            "cov": cov,
            "cs_hist": d.get("cs_hist", 0),
            "ap": ap_rec, "low": [enc(row) for row in d["low"]],
            "term": {k: enc(v) for k, v in d["term"].items()},
            **({"atc": atc} if atc else {}),
        })

    # the observed schedule
    recurring = []
    for (ap, kind, cs), seen in rec.items():
        by_day = {}
        for date, minute, typ in seen:
            by_day.setdefault(date, []).append((minute, typ))
        if len(by_day) < REC_MIN_DAYS:
            continue
        dates = sorted(by_day)
        last30 = dates[-30:]
        mins = [m for date in last30 for m, _ in by_day[date]]
        mins.sort()
        q = statistics.quantiles(mins, n=4) if len(mins) >= 2 else [mins[0]] * 3
        types = collections.Counter(t for date in dates for _, t in by_day[date] if t)
        possible = (dt.date.fromisoformat(dates[-1]) - dt.date.fromisoformat(dates[0])).days + 1
        dowmask = 0
        for date in dates:
            dowmask |= 1 << dow_of(date)
        recurring.append([ap, kind, cs, types.most_common(1)[0][0] if types else "",
                          int(statistics.median(mins)), int(q[0]), int(q[2]),
                          len(dates), possible, dates[0], dates[-1], dowmask])
    recurring.sort(key=lambda r: (-r[7], r[4]))
    recurring = recurring[:REC_CAP]

    return {
        "generated": int(dt.datetime.now().timestamp()),
        "v": VERSION,
        "tz": str(TZ),
        "airports": {ap: {"name": AIRPORTS[ap]["name"], "lat": AIRPORTS[ap]["lat"],
                          "lon": AIRPORTS[ap]["lon"], "rwys": AIRPORTS[ap]["rwys"]}
                     for ap in ORDER},
        "order": ORDER,
        "airlines": {p: AIRLINES[p] for ap in ORDER for p in top[ap] if p in AIRLINES},
        "top": top,
        "cs_hist_from": cs_hist_from,
        "slot_alphabet": SLOT_ALPHABET,
        "cov_min": COV_MIN,
        "bands": BANDS,
        "lee_nm": LEE_NM,
        "term": {k: {"nm": v[2], "ft": v[3], "airliners": v[4]} for k, v in TERM.items()},
        "map_meta": {"cell_nm": MAP_CELL_NM, "half_nm": MAP_HALF_NM, "step_s": MAP_STEP_S},
        "feeds": feeds,
        "days": out_days,
        "recurring": recurring,
        "map": {b: [[x, y, s] for (x, y), s in sorted(g.items()) if s >= MAP_MIN_S]
                for b, g in grid.items() if g},
    }


# ---------------------------------------------------------------------------
# fetching
# ---------------------------------------------------------------------------
def fetch_json(url, timeout=120, tries=3):
    """GET + parse, retrying a cut transfer (a 14 MB day file through a proxy
    does get cut now and then; the next attempt usually completes)."""
    import time
    err = None
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "kanp-rush/1",
                                                       "Accept-Encoding": "gzip"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw = r.read()
                if r.headers.get("Content-Encoding") == "gzip":
                    raw = gzip.decompress(raw)
            return json.loads(raw)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                raise
            err = e
        except (urllib.error.URLError, http.client.HTTPException, OSError, ValueError) as e:
            err = e
        time.sleep(2 * (attempt + 1))
    raise err


class Source:
    def __init__(self, base=None, local=None):
        self.base, self.local = base, local

    def summary(self):
        if self.local:
            p = os.path.join(self.local, "summary.json")
            if os.path.exists(p):
                with open(p) as f:
                    return json.load(f)
            days = sorted(f[:-5] for f in os.listdir(os.path.join(self.local, "days"))
                          if f.endswith(".json"))
            return {"days": [{"date": d} for d in days]}
        return fetch_json(f"{self.base}/summary.json")

    def day(self, date):
        if self.local:
            with open(os.path.join(self.local, "days", f"{date}.json")) as f:
                return json.load(f)
        return fetch_json(f"{self.base}/days/{date}.json", timeout=300)

    def atc(self, date):
        try:
            if self.local:
                p = os.path.join(self.local, "atc", f"{date}.json")
                if not os.path.exists(p):
                    return None
                with open(p) as f:
                    return json.load(f)
            return fetch_json(f"{self.base}/atc/{date}.json")
        except (urllib.error.HTTPError, urllib.error.URLError, http.client.HTTPException,
                OSError, ValueError):
            return None


def write_json(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f, separators=(",", ":"))
    os.replace(tmp, path)


def run(out, src, force=False, limit=None):
    days_dir = os.path.join(out, "days")
    os.makedirs(days_dir, exist_ok=True)
    summary = src.summary()
    today = dt.datetime.now(TZ).date()
    hot = {today.isoformat(), (today - dt.timedelta(days=1)).isoformat()}

    listed = [d for d in summary.get("days", []) if d.get("date")]
    todo = []
    for entry in listed:
        date = entry["date"]
        path = os.path.join(days_dir, f"{date}.json")
        have = None
        if os.path.exists(path) and not force:
            try:
                with open(path) as f:
                    have = json.load(f)
            except (OSError, ValueError):
                have = None
        need = have is None or date in hot
        if have is not None and not need and "aircraft" in entry:
            s = have.get("src") or {}
            need = (s.get("aircraft") != entry.get("aircraft")
                    or s.get("points") != entry.get("points"))
        want_atc = entry.get("atc") and have is not None and not have.get("atc")
        if need or want_atc:
            todo.append((date, entry, have, need))
    if limit:
        todo = todo[-limit:]
    log(f"{len(listed)} days listed, {len(todo)} to compile")

    feeds = {}
    for date, entry, have, need in todo:
        path = os.path.join(days_dir, f"{date}.json")
        try:
            if need:
                day = src.day(date)
                rec = compile_day(day)
                del day
            else:
                rec = have
            if entry.get("atc"):
                atc = src.atc(date)
                if atc and atc.get("feeds"):
                    rec["atc"] = {m: {"label": v.get("label", m), "freq": v.get("freq", ""),
                                      "n": v["n"], "s": v["s"]}
                                  for m, v in atc["feeds"].items()}
            write_json(path, rec)
            nops = len(rec["ops"])
            log(f"  {date}: {nops} ops" + (" · atc" if rec.get("atc") else ""))
        except (urllib.error.HTTPError, urllib.error.URLError, http.client.HTTPException,
                OSError, ValueError, KeyError) as e:
            log(f"  {date}: failed — {e}")

    compiled = []
    for fname in sorted(os.listdir(days_dir)):
        if not fname.endswith(".json"):
            continue
        try:
            with open(os.path.join(days_dir, fname)) as f:
                rec = json.load(f)
            compiled.append(rec)
            for m, v in (rec.get("atc") or {}).items():
                feeds.setdefault(m, {"label": v.get("label", m), "freq": v.get("freq", "")})
        except (OSError, ValueError):
            continue
    if not compiled:
        log("nothing compiled")
        return 1
    rush = aggregate(compiled, feeds)
    write_json(os.path.join(out, "rush.json"), rush)
    log(f"rush.json: {len(compiled)} days, {len(rush['recurring'])} recurring flights, "
        f"{sum(len(v) for v in rush['map'].values())} map cells")
    return 0


# ---------------------------------------------------------------------------
# selftest
# ---------------------------------------------------------------------------
def _line(t0, lat0, lon0, alt0, lat1, lon1, alt1, n, dt_s, og=0):
    pts = []
    for i in range(n):
        f = i / max(1, n - 1)
        pts.append([t0 + i * dt_s, round(lat0 + (lat1 - lat0) * f, 5),
                    round(lon0 + (lon1 - lon0) * f, 5), alt0 + (alt1 - alt0) * f, 250, og])
    return pts


def selftest():
    # 2026-09-29 (Tue) 07:00 local
    t0 = int(dt.datetime(2026, 9, 29, 7, 0, tzinfo=TZ).timestamp())
    bwi = AIRPORTS["BWI"]
    # an arrival to BWI 33 from the southeast, through 4,000 ft over Lee
    arr = _line(t0, 38.85, -76.40, 6000, bwi["lat"] - 0.11, bwi["lon"] + 0.11, 1200, 30, 20)
    arr += _line(t0 + 600, bwi["lat"] - 0.11, bwi["lon"] + 0.11, 1200, bwi["lat"], bwi["lon"], 0, 10, 20)
    arr += [[t0 + 800, bwi["lat"], bwi["lon"], None, 5, 1], [t0 + 820, bwi["lat"], bwi["lon"], None, 5, 1]]
    # the same hex departs later as another flight number
    dep = [[t0 + 3600, bwi["lat"], bwi["lon"], None, 5, 1]]
    dep += _line(t0 + 3620, bwi["lat"], bwi["lon"], 0, bwi["lat"] - 0.14, bwi["lon"] + 0.14, 1400, 10, 20)
    dep += _line(t0 + 3820, bwi["lat"] - 0.14, bwi["lon"] + 0.14, 1400, 38.6, -76.0, 9000, 30, 20)
    swa = {"hex": "a1", "flight": "SWA456", "type": "B738", "points": arr + dep,
           "flights": [[t0, "SWA123"], [t0 + 3000, "SWA456"]]}
    # a GA out-and-back at MTN
    mtn = AIRPORTS["MTN"]
    ga = _line(t0, mtn["lat"], mtn["lon"], 0, mtn["lat"] + 0.2, mtn["lon"] - 0.2, 2500, 20, 30)
    ga += _line(t0 + 600, mtn["lat"] + 0.2, mtn["lon"] - 0.2, 2500, mtn["lat"], mtn["lon"], 0, 20, 30)
    c172 = {"hex": "a2", "flight": "N12345", "type": "C172", "points": ga}
    # an overflight at FL350 that never descends
    hi = {"hex": "a3", "flight": "UAL1", "type": "B739",
          "points": _line(t0, 38.5, -77.5, 35000, 39.4, -75.8, 35000, 20, 60)}
    day = {"date": "2026-09-29", "generated": t0 + 86400, "cs_hist": 1, "tracks": [swa, c172, hi]}
    rec = compile_day(day)
    kinds = sorted((o[1], o[2], o[3]) for o in rec["ops"])
    assert kinds == [("BWI", "A", "SWA123"), ("BWI", "D", "SWA456"),
                     ("MTN", "A", "N12345"), ("MTN", "D", "N12345")], kinds
    a = next(o for o in rec["ops"] if o[1] == "BWI" and o[2] == "A")
    assert a[0] == t0 + 800, a            # touchdown = first ground fix
    assert a[6] == "33", a                # final course → runway 33
    assert a[7] is not None and a[7] < 6000, a   # passed low near Lee
    assert a[8] == 1
    d = next(o for o in rec["ops"] if o[1] == "BWI" and o[2] == "D")
    assert d[0] == t0 + 3600 and d[6] == "15", d
    assert rec["cov"][7] == 3 and rec["cov"][3] == 0, rec["cov"]
    assert sum(sum(r) for r in rec["low"]) >= 1, rec["low"]
    assert any(rec["term"]["bwi25"]), rec["term"]
    assert rec["map"], "map empty"
    # aggregate over four copies so the schedule qualifies
    days = []
    for i in range(4):
        r = json.loads(json.dumps(rec))
        r["date"] = (dt.date(2026, 9, 29) + dt.timedelta(days=i)).isoformat()
        days.append(r)
    rush = aggregate(days, {})
    assert dec(rush["days"][0]["ap"]["BWI"]["a"])[28] == 1, rush["days"][0]["ap"]["BWI"]["a"]
    assert "SWA" in rush["days"][0]["ap"]["BWI"]["al"]
    assert dec(rush["days"][0]["ap"]["BWI"]["al"]["SWA"][0])[28] == 1
    assert dec(rush["days"][0]["ap"]["BWI"]["rwy"]["33"])[7] == 1
    assert rush["days"][0]["ap"]["BWI"]["lee"]["33"] == [1, 1, 1], rush["days"][0]["ap"]["BWI"]["lee"]
    assert rush["days"][0]["cov"][7] == "1" and rush["days"][0]["cov"][3] == "0", rush["days"][0]["cov"]
    days[0]["src"]["generated"] = t0 + 1800          # compiled at 07:30 → 08:00 on is unreached
    assert aggregate(days, {})["days"][0]["cov"][8:] == "x" * 16
    assert rush["cs_hist_from"] == "2026-09-29"
    assert dec(enc([0, 5, 61, 99])) == [0, 5, 61, 61]
    recs = {(r[0], r[1], r[2]): r for r in rush["recurring"]}
    assert ("BWI", "A", "SWA123") in recs and recs[("BWI", "A", "SWA123")][7] == 4, recs
    assert recs[("BWI", "A", "SWA123")][4] == 7 * 60 + 13
    assert day_class("2026-09-07") == "hol" and day_class("2026-09-26") == "sat" \
        and day_class("2026-09-27") == "sun" and day_class("2026-09-28") == "wk" \
        and day_class("2026-07-03") == "hol" and day_class("2026-11-26") == "hol"
    assert airline_prefix("SWA1234") == "SWA" and airline_prefix("N123AB") is None
    assert runway_for("BWI", 322) == "33" and runway_for("BWI", 200) == ""
    log("selftest ok")
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--out", help="rush-data tree to update")
    ap.add_argument("--local", help="read day files from DIR/days instead of the branch")
    ap.add_argument("--force", action="store_true", help="recompile every listed day")
    ap.add_argument("--limit", type=int, help="compile at most the newest N due days")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()
    if args.selftest:
        return selftest()
    if not args.out:
        ap.error("--out is required")
    return run(args.out, Source(base=SRC, local=args.local), force=args.force, limit=args.limit)


if __name__ == "__main__":
    sys.exit(main())
