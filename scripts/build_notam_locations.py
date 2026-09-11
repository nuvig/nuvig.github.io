#!/usr/bin/env python3
"""Build data/notam/locations.json — every place scripts/notamarchive.py asks
the FAA for NOTAMs (stdlib only).

    python3 scripts/build_notam_locations.py            # NASR download (current 28-day cycle)
    python3 scripts/build_notam_locations.py --seed     # offline: from data/procedures + tables
    python3 scripts/build_notam_locations.py --nasr /path/to/DD_Mon_YYYY_CSV.zip   # or the APT_CSV zip

Output shape:
  {v, built, src, cycle, n, locs:[[q, lid, kind, name, st, lat, lon, artcc, aliases?]]}
    q        the id the NOTAM services are queried with (KANP, W29, 00R, ZDC, GPS)
    lid      the id NOTAM text uses for the place (ANP, W29, 00R, ZDC)
    kind     apt · heli · sea · nav · artcc · sys
    aliases  extra query ids for the same record (KZDC beside ZDC)

Two ways to build it:
  --seed  Offline. Airports = data/procedures/index.json (every US airport with
          a coded instrument procedure, ~3,200, with lat/lon/city/state);
          navaids = the recommended-navaid fields of the coded legs in
          data/procedures/apt/*.json (~650 VOR/NDB/TACAN idents with
          coordinates, localizers dropped — their NOTAMs file under the
          airport); plus the ARTCC table below and the GPS / FDC pseudo-
          locations. This is what ships until a NASR build runs: it covers
          the airports that generate nearly all NOTAM traffic but not the
          ~2,000 public-use fields with no instrument procedure.
  NASR    The FAA's 28-day National Airspace System Resources subscription,
          CSV edition — the per-subject zips
          nfdc.faa.gov/webContent/28DaySub/extra/DD_Mon_YYYY_APT_CSV.zip and
          …_NAV_CSV.zip (the whole-subscription DD_Mon_YYYY_CSV.zip also works
          via --nasr): APT_BASE.csv (every airport, heliport and seaplane base —
          kept when public-use, flagged for NOTAM D service, or military-owned)
          and NAV_BASE.csv (every navaid). Column names are looked up
          tolerantly (see COLS) because the FAA has renamed them before.
          Verified live 2026-09-10 against the 2026-09-03 cycle: 19,411 APT rows
          (ARPT_ID, ICAO_ID, ARPT_NAME, CITY, STATE_CODE, LAT_DECIMAL,
          LONG_DECIMAL, SITE_TYPE_CODE, FACILITY_USE_CODE, NOTAM_FLAG,
          NOTAM_ID, RESP_ARTCC_ID, OWNERSHIP_TYPE_CODE) and 1,617 NAV rows
          (NAV_ID, NAV_TYPE, NAME, STATE_CODE, LAT_DECIMAL, LONG_DECIMAL).
          NASR's NOTAM_ID is the *accountability* (ANP's is DCA), not the
          location id — `lid` is ARPT_ID. If a column moves, the error says
          which, and --seed still works.

Cycle dates are AIRAC (28 days from the anchor scripts/build_procedures.py
uses); NASR effective dates coincide with them.
"""

import argparse
import csv
import io
import json
import math
import os
import re
import sys
import urllib.request
import zipfile
from datetime import date, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "notam", "locations.json")
PROC_INDEX = os.path.join(ROOT, "data", "procedures", "index.json")
PROC_APT = os.path.join(ROOT, "data", "procedures", "apt")
AIRAC_ANCHOR = date(2026, 7, 9)

# The 22 CONUS/AK/HI centers plus San Juan CERAP and Guam CERAP: the facility
# id NOTAM text uses, a name, its state, and roughly where the building is
# (a map pin for airspace NOTAMs, nothing more precise is needed).
ARTCC = [
    ("ZAB", "Albuquerque Center", "NM", 35.17, -106.57), ("ZAU", "Chicago Center", "IL", 41.78, -88.33),
    ("ZBW", "Boston Center", "NH", 42.74, -71.48), ("ZDC", "Washington Center", "VA", 39.10, -77.55),
    ("ZDV", "Denver Center", "CO", 40.19, -105.13), ("ZFW", "Fort Worth Center", "TX", 32.83, -97.07),
    ("ZHU", "Houston Center", "TX", 29.96, -95.33), ("ZID", "Indianapolis Center", "IN", 39.74, -86.28),
    ("ZJX", "Jacksonville Center", "FL", 30.70, -81.91), ("ZKC", "Kansas City Center", "KS", 38.88, -94.79),
    ("ZLA", "Los Angeles Center", "CA", 34.60, -118.08), ("ZLC", "Salt Lake Center", "UT", 40.79, -111.98),
    ("ZMA", "Miami Center", "FL", 25.82, -80.32), ("ZME", "Memphis Center", "TN", 35.07, -89.96),
    ("ZMP", "Minneapolis Center", "MN", 44.64, -93.15), ("ZNY", "New York Center", "NY", 40.78, -73.10),
    ("ZOA", "Oakland Center", "CA", 37.54, -121.98), ("ZOB", "Cleveland Center", "OH", 41.30, -82.21),
    ("ZSE", "Seattle Center", "WA", 47.29, -122.19), ("ZTL", "Atlanta Center", "GA", 33.38, -84.30),
    ("ZAN", "Anchorage Center", "AK", 61.17, -149.98), ("ZHN", "Honolulu Control Facility", "HI", 21.32, -157.93),
    ("ZSU", "San Juan CERAP", "PR", 18.43, -66.00), ("ZUA", "Guam CERAP", "GU", 13.48, 144.80),
]
# National pseudo-locations: GPS interference NOTAMs file under GPS; FDC
# "special notices" under FDC. No coordinates.
SYSTEM = [("GPS", "GPS NOTAMs"), ("FDC", "FDC special notices")]

STATES = {"AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID", "IL",
          "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE",
          "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD",
          "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "PR", "VI", "GU", "AS", "MP"}

# NASR CSV columns, by role, first present wins.
COLS = {
    "apt_id": ["ARPT_ID", "LOC_ID", "LOCATION_IDENTIFIER"],
    "icao": ["ICAO_ID", "ICAO_IDENTIFIER"],
    "name": ["ARPT_NAME", "FACILITY_NAME", "NAME"],
    "city": ["CITY", "ASSOC_CITY"],
    "state": ["STATE_CODE", "STATE", "ST"],
    "lat": ["LAT_DECIMAL", "LATITUDE_DECIMAL", "LAT_DD"],
    "lon": ["LONG_DECIMAL", "LON_DECIMAL", "LONGITUDE_DECIMAL", "LONG_DD"],
    "type": ["SITE_TYPE_CODE", "FACILITY_TYPE", "TYPE"],
    "use": ["FACILITY_USE_CODE", "FACILITY_USE", "USE"],
    "notam_flag": ["NOTAM_FLAG", "NOTAM_D_AVBL", "NOTAM_D"],
    "notam_id": ["NOTAM_ID", "NOTAM_FACILITY_IDENT"],
    "artcc": ["RESP_ARTCC_ID", "ARTCC_ID", "ARTCC"],
    "owner": ["OWNERSHIP_TYPE_CODE", "OWNERSHIP"],
    "nav_id": ["NAV_ID", "NAVAID_ID", "NAVAID_IDENTIFIER"],
    "nav_type": ["NAV_TYPE", "NAVAID_TYPE", "TYPE"],
}


def col(row, role):
    for c in COLS[role]:
        if c in row and row[c] not in (None, ""):
            return row[c].strip()
    return ""


def current_cycle_date(today=None):
    today = today or date.today()
    d = AIRAC_ANCHOR
    while d + timedelta(days=28) <= today:
        d += timedelta(days=28)
    while d > today:
        d -= timedelta(days=28)
    return d


def nasr_urls(d):
    """The per-subject CSV zips (APT ~8 MB, NAV ~0.6 MB) rather than the whole
    subscription (extra/DD_Mon_YYYY_CSV.zip, which also exists)."""
    base = f"https://nfdc.faa.gov/webContent/28DaySub/extra/{d:%d_%b_%Y}"
    return [base + "_APT_CSV.zip", base + "_NAV_CSV.zip"]


def haversine_nm(lat1, lon1, lat2, lon2):
    p = math.pi / 180
    a = (math.sin((lat2 - lat1) * p / 2) ** 2
         + math.cos(lat1 * p) * math.cos(lat2 * p) * math.sin((lon2 - lon1) * p / 2) ** 2)
    return 3440.065 * 2 * math.asin(math.sqrt(a))


def lid_of(q):
    """NOTAM-text id for a query id: the FAA LID is the ICAO id less its K/P
    prefix for the ordinary case (KANP -> ANP). Alaska/Hawaii/Pacific fields
    whose LID is not the ICAO id less one letter are corrected by the NASR
    build (ARPT_ID vs ICAO_ID); the seed guesses."""
    if len(q) == 4 and q[0] in "KP" and q[1:].isalpha():
        return q[1:]
    return q


def fixed_rows():
    rows = []
    for fid, name, st, lat, lon in ARTCC:
        rows.append([fid, fid, "artcc", name, st, lat, lon, fid, ["K" + fid]])
    for fid, name in SYSTEM:
        rows.append([fid, fid, "sys", name, None, None, None, None])
    return rows


def seed_rows():
    idx = json.load(open(PROC_INDEX))
    apts = idx.get("apts") or []
    rows = []
    apt_pts = []
    for a in apts:
        q, name, lat, lon = a[0], a[1], a[2], a[3]
        city, st = (a[7] if len(a) > 7 else ""), (a[8] if len(a) > 8 else None)
        st = st if st in STATES else None
        label = f"{name} · {city}" if city and city.upper() not in name.upper() else name
        rows.append([q, lid_of(q), "apt", label, st, round(lat, 4), round(lon, 4), None])
        if st and lat is not None:
            apt_pts.append((lat, lon, st))
    # Navaids from the coded legs' recommended-navaid field: [ident, lat, lon].
    navs = {}
    for fn in os.listdir(PROC_APT):
        if not fn.endswith(".json"):
            continue
        try:
            doc = json.load(open(os.path.join(PROC_APT, fn)))
        except (OSError, json.JSONDecodeError):
            continue
        stack = [doc]
        while stack:
            o = stack.pop()
            if isinstance(o, dict):
                stack.extend(o.values())
            elif isinstance(o, list):
                if (len(o) == 3 and isinstance(o[0], str) and isinstance(o[1], (int, float))
                        and isinstance(o[2], (int, float)) and re.fullmatch(r"[A-Z0-9]{1,4}", o[0])):
                    navs.setdefault(o[0], (o[1], o[2]))
                else:
                    stack.extend(o)
    have = {r[0] for r in rows}
    n_nav = 0
    for ident, (lat, lon) in sorted(navs.items()):
        if len(ident) == 4 and ident[0] == "I":   # localizer — NOTAMs file under the airport
            continue
        if ident in have or "K" + ident in have:  # a VOR on the field shares the airport's id
            continue
        # State: the nearest airport's — good enough for a map and a state count.
        best, best_d = None, 1e9
        for alat, alon, ast in apt_pts:
            d = abs(alat - lat) + abs(alon - lon)
            if d < best_d:
                best, best_d = ast, d
        rows.append([ident, ident, "nav", "navaid", best, round(lat, 4), round(lon, 4), None])
        n_nav += 1
    print(f"seed: {len(apts)} airports, {n_nav} navaids", file=sys.stderr)
    return rows


def nasr_rows(zips):
    """zips: the zip bytes to read APT_BASE.csv / NAV_BASE.csv from — the two
    subject zips, or the one whole-subscription zip."""
    members = {}   # basename -> (ZipFile, member name), first seen wins
    for zb in zips:
        zf = zipfile.ZipFile(io.BytesIO(zb))
        for n in zf.namelist():
            members.setdefault(n.rsplit("/", 1)[-1].upper(), (zf, n))
    if "APT_BASE.CSV" not in members:
        raise SystemExit(f"APT_BASE.csv not in the archive; members: {sorted(members)[:20]}…")
    zf, apt_name = members["APT_BASE.CSV"]
    nav = members.get("NAV_BASE.CSV")
    rows = []
    # NASR SITE_TYPE_CODE: A airport, B balloonport, C seaplane base,
    # G gliderport, H heliport, U ultralight.
    kinds = {"A": "apt", "H": "heli", "C": "sea", "B": "apt", "G": "apt", "U": "apt"}
    n_skip = 0
    with zf.open(apt_name) as f:
        rd = csv.DictReader(io.TextIOWrapper(f, encoding="utf-8", errors="replace"))
        if rd.fieldnames is None or not any(c in rd.fieldnames for c in COLS["apt_id"]):
            raise SystemExit(f"APT_BASE.csv columns not recognized: {rd.fieldnames[:12] if rd.fieldnames else None}")
        for row in rd:
            lid = col(row, "apt_id")
            if not lid:
                continue
            use = col(row, "use").upper()
            flag = col(row, "notam_flag").upper()
            owner = col(row, "owner").upper()
            # Public-use, flagged for NOTAM D service, or military-owned (a
            # base is private-use in NASR but files NOTAMs like any airport).
            if use != "PU" and flag != "Y" and not owner.startswith("M"):
                n_skip += 1
                continue
            icao = col(row, "icao")
            q = icao if re.fullmatch(r"[A-Z]{4}", icao or "") else lid
            try:
                lat, lon = float(col(row, "lat")), float(col(row, "lon"))
            except ValueError:
                lat = lon = None
            st = col(row, "state").upper()
            name = re.sub(r"\s+", " ", col(row, "name")).title()
            city = re.sub(r"\s+", " ", col(row, "city")).title()
            label = f"{name} · {city}" if city else name
            kind = kinds.get(col(row, "type").upper()[:1], "apt")
            if owner.startswith("M"):
                kind = "mil"
            rows.append([q, lid, kind, label, st if st in STATES else None,
                         round(lat, 4) if lat is not None else None,
                         round(lon, 4) if lon is not None else None, col(row, "artcc") or None])
    n_nav = 0
    if nav:
        with nav[0].open(nav[1]) as f:
            rd = csv.DictReader(io.TextIOWrapper(f, encoding="utf-8", errors="replace"))
            have = {r[0] for r in rows} | {r[1] for r in rows}
            seen = set()
            for row in rd:
                ident = col(row, "nav_id")
                if not ident or ident in seen or ident in have:
                    continue
                seen.add(ident)
                try:
                    lat, lon = float(col(row, "lat")), float(col(row, "lon"))
                except ValueError:
                    lat = lon = None
                st = col(row, "state").upper()
                rows.append([ident, ident, "nav", f"{col(row, 'name').title()} {col(row, 'nav_type')}".strip(),
                             st if st in STATES else None,
                             round(lat, 4) if lat is not None else None,
                             round(lon, 4) if lon is not None else None, col(row, "artcc") or None])
                n_nav += 1
    print(f"nasr: {len(rows) - n_nav} airports kept ({n_skip} private/no-NOTAM skipped), {n_nav} navaids",
          file=sys.stderr)
    return rows


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--seed", action="store_true", help="offline build from data/procedures")
    ap.add_argument("--nasr", help="a downloaded NASR CSV subscription zip")
    ap.add_argument("--out", default=OUT)
    a = ap.parse_args()
    cycle = current_cycle_date()
    if a.seed:
        rows, src = seed_rows(), "seed"
    else:
        if a.nasr:
            zips = [open(a.nasr, "rb").read()]
        else:
            zips = []
            for url in nasr_urls(cycle):
                print("downloading", url, file=sys.stderr)
                req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
                zips.append(urllib.request.urlopen(req, timeout=300).read())
        rows, src = nasr_rows(zips), "nasr"
    rows.extend(fixed_rows())
    seen = set()
    uniq = []
    for r in rows:
        if r[0] in seen:
            continue
        seen.add(r[0])
        uniq.append(r)
    uniq.sort(key=lambda r: ({"artcc": 1, "sys": 2}.get(r[2], 0), r[0]))
    doc = {"v": 1, "built": f"{date.today():%Y-%m-%d}", "src": src, "cycle": f"{cycle:%Y-%m-%d}",
           "n": len(uniq), "locs": uniq}
    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    with open(a.out, "w") as f:
        json.dump(doc, f, separators=(",", ":"))
    print(f"wrote {a.out}: {len(uniq)} locations ({src})", file=sys.stderr)


if __name__ == "__main__":
    main()
