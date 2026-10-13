#!/usr/bin/env python3
"""Notables compile — the tracker's notable-traffic log (kanp.html, Notables
tab).

Reads the Pi exporter's per-day snapshots on the `traffic-data` branch
(v2/summary.json + v2/days/YYYY-MM-DD.json), picks out the tracks worth a
look, and publishes one small tree to the `notables-data` branch via
.github/workflows/notables.yml (one force-pushed commit, like rush-data: the
tree is the state).

    python3 scripts/build_notables.py --out notables            # incremental
    python3 scripts/build_notables.py --out notables --force    # recompile all
    python3 scripts/build_notables.py --out x --local DIR       # DIR/days/*.json
    python3 scripts/build_notables.py --selftest

Stdlib only; shares fetching, geometry and the airliner list with
build_rush.py. Source base: NOTABLES_SRC (default the traffic-data raw URL).

Kinds (an event can carry several):

  vip      AF1 / AF2 / EXEC1F / EXEC2F callsigns, and US-serial military 747s
           (VC-25, E-4B and the like — VIP_REGS names the known ones)
  state    military-flagged aircraft whose ICAO address sits in a non-US
           block (country from ICAO_BLOCKS) — heads of state, foreign air
           forces
  mil      military types that are rare around here (MIL_TYPES)
  warbird  vintage / ex-military types (WARBIRD_TYPES)
  rare     a type only one airframe has carried in the whole archive
  lee      a field contact at KANP (within OPS_NEAR_NM, on the ground or
           below OPS_LOW_FT — the tracker's ops gates) by a helicopter, a
           military aircraft, or an airframe seen there for the first time
           (only once the archive has FIRST_MIN_DAYS days before it)
  low      airliner or large military aircraft below LOW_FT within LOW_NM of
           KANP without touching the field

A day file (days/YYYY-MM-DD.json):

  date, src {aircraft, points}   summary.json's stamps, to tell when the
                                  exporter re-exported the day
  ev   [event, …]                every candidate track (rare candidates
                                  included); kinds `rare` and `lee`'s
                                  first-visit flag are settled in aggregate()
  inv  {type: [hex, …] | 0}      airframes per type that day (0 = more than
                                  INV_MAX, never rare)
  fld  [hex, …]                  every airframe with a field contact

An event:

  {ts, h hex, r reg, c callsign, t type, n description, m military 0/1,
   d nm closest to KANP, a ft at that point (barometric, null unknown),
   g 1 on the ground there, k [kinds], lbl name for vip, cty country,
   why "heli" / "mil" / "new" for lee}

notables.json (what the page reads): generated, v, days [dates compiled],
ev [event, …] newest first, counts {kind: n}.
"""
import argparse
import datetime as dt
import os
import re
import sys
import urllib.error

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_rush as BR  # noqa: E402

SRC = os.environ.get(
    "NOTABLES_SRC", "https://raw.githubusercontent.com/nuvig/nuvig.github.io/traffic-data/v2")
VERSION = 1
KANP_LAT, KANP_LON = BR.KANP_LAT, BR.KANP_LON

OPS_NEAR_NM, OPS_LOW_FT = 0.8, 600   # mirror of SITE.tracker.opsGates
LOW_NM, LOW_FT = 2.0, 2000
FIRST_MIN_DAYS = 14
INV_MAX = 3

VIP_CS = re.compile(r"^(AF1|AF2|EXEC1F|EXEC2F)$")
US_SERIAL = re.compile(r"^\d{2}-\d{4,5}$")
VIP_REGS = {
    "82-8000": "VC-25A", "92-9000": "VC-25A",
    "73-1676": "E-4B", "73-1677": "E-4B", "74-0787": "E-4B", "75-0125": "E-4B",
}
VIP_747 = {"B741", "B742", "B744", "B748"}

MIL_TYPES = {
    "B1": "B-1B", "B52": "B-52", "B2": "B-2", "R135": "RC-135", "E3TF": "E-3",
    "E3CF": "E-3", "E6": "E-6B", "U2": "U-2", "F35": "F-35", "F22": "F-22",
    "F15": "F-15", "F16": "F-16", "F18S": "F/A-18", "F18H": "F/A-18", "A10": "A-10",
    "C2": "C-2A", "MI8": "Mi-8/17", "H64": "AH-64", "AV8B": "AV-8B", "EA18": "EA-18G",
    "Q9": "MQ-9",
}  # E-2 / P-3 / MQ-4C left out: Pax River's daily traffic
WARBIRD_TYPES = set("""
B17 B24 B25 B29 P51 P40 P47 P38 P39 P63 TBM F4U F6F F8F SNJ T28
MG15 MG17 MG19 MG21 L39 L29 YK52 YK11 YK18 CJ6 DC3 C47 PBY A26 SPIT HURI
BU31 BU33 N3N L5 AN2 DO27 PT22 PT19 FW44
""".split())  # Stearman / T-6 / T-34 / Cub left out: ride and tour flights, daily

# Never "state": US callsigns that turn up on a mis-coded non-US address.
US_CS = re.compile(r"^(TSTR|TESTR|VVTP|SPAR|ASH|PAT|RCH|SAM|CNV|N\d)")

# ICAO 24-bit address blocks → country, the ones that turn up here (checked
# against the archive's military-flagged traffic; not a full registry).
ICAO_BLOCKS = [
    (0x008000, 0x00FFFF, "South Africa"), (0x010000, 0x017FFF, "Egypt"),
    (0x020000, 0x027FFF, "Morocco"), (0x028000, 0x02FFFF, "Tunisia"),
    (0x038000, 0x038FFF, "Côte d'Ivoire"), (0x042000, 0x042FFF, "Equatorial Guinea"),
    (0x064000, 0x064FFF, "Nigeria"), (0x06A000, 0x06AFFF, "Qatar"),
    (0x070000, 0x070FFF, "Senegal"), (0x0A0000, 0x0A7FFF, "Algeria"),
    (0x0AC000, 0x0ACFFF, "Colombia"), (0x0C2000, 0x0C2FFF, "Panama"),
    (0x0D0000, 0x0D7FFF, "Mexico"), (0x100000, 0x1FFFFF, "Russia"),
    (0x300000, 0x33FFFF, "Italy"), (0x340000, 0x37FFFF, "Spain"),
    (0x380000, 0x3BFFFF, "France"), (0x3C0000, 0x3FFFFF, "Germany"),
    (0x400000, 0x43FFFF, "UK"), (0x440000, 0x447FFF, "Austria"),
    (0x448000, 0x44FFFF, "Belgium"), (0x450000, 0x457FFF, "Bulgaria"),
    (0x458000, 0x45FFFF, "Denmark"), (0x460000, 0x467FFF, "Finland"),
    (0x468000, 0x46FFFF, "Greece"), (0x470000, 0x477FFF, "Hungary"),
    (0x478000, 0x47FFFF, "Norway"), (0x480000, 0x487FFF, "Netherlands"),
    (0x488000, 0x48FFFF, "Poland"), (0x490000, 0x497FFF, "Portugal"),
    (0x498000, 0x49FFFF, "Czechia"), (0x4A0000, 0x4A7FFF, "Romania"),
    (0x4A8000, 0x4AFFFF, "Sweden"), (0x4B0000, 0x4B7FFF, "Switzerland"),
    (0x4B8000, 0x4BFFFF, "Turkey"), (0x4CA000, 0x4CAFFF, "Ireland"),
    (0x508000, 0x50FFFF, "Ukraine"), (0x600800, 0x600FFF, "Azerbaijan"),
    (0x706000, 0x706FFF, "Kuwait"), (0x710000, 0x717FFF, "Saudi Arabia"),
    (0x718000, 0x71FFFF, "South Korea"), (0x730000, 0x737FFF, "Iran"),
    (0x738000, 0x73FFFF, "Israel"), (0x740000, 0x747FFF, "Jordan"),
    (0x750000, 0x757FFF, "Malaysia"), (0x758000, 0x75FFFF, "Philippines"),
    (0x760000, 0x767FFF, "Pakistan"), (0x768000, 0x76FFFF, "Singapore"),
    (0x780000, 0x7BFFFF, "China"), (0x7C0000, 0x7FFFFF, "Australia"),
    (0x800000, 0x83FFFF, "India"), (0x840000, 0x87FFFF, "Japan"),
    (0x880000, 0x887FFF, "Thailand"), (0x894000, 0x894FFF, "Bahrain"),
    (0x895000, 0x8953FF, "Brunei"), (0x896000, 0x896FFF, "UAE"),
    (0x8A0000, 0x8A7FFF, "Indonesia"), (0xC00000, 0xC3FFFF, "Canada"),
    (0xC80000, 0xC87FFF, "New Zealand"), (0xE00000, 0xE3FFFF, "Argentina"),
    (0xE40000, 0xE7FFFF, "Brazil"), (0xE80000, 0xE80FFF, "Chile"),
    (0xE84000, 0xE84FFF, "Ecuador"), (0xE88000, 0xE88FFF, "Paraguay"),
    (0xE8C000, 0xE8CFFF, "Peru"), (0xE90000, 0xE90FFF, "Uruguay"),
    (0xE94000, 0xE94FFF, "Bolivia"),
]
HELI_TYPES = set("""
R22 R44 R66 G2CA H269 S269 EN28 EN48 H500 MD50 MD52 MD60 EXPL B06 B06T B105
B212 B222 B230 B407 B412 B427 B429 B430 B47G B505 UH1 UH1Y AH1 AH1Z V22
EC20 EC30 EC35 EC45 EC55 EC75 H125 H130 H135 H145 H160 H175 AS50 AS55 AS65
AS32 AS3B A109 A119 A139 A149 A169 A189 S76 S92 S61 S64 H60 H47 H53 H53S H64
BK17 MI8 UH12 GYRO
""".split())


def country_of(hexid):
    try:
        v = int(hexid, 16)
    except (TypeError, ValueError):
        return None
    for lo, hi, name in ICAO_BLOCKS:
        if lo <= v <= hi:
            return name
    return None


CS_OK = re.compile(r"^[A-Z0-9]{2,8}$")
ALT_MAX = 60000   # above this a barometric altitude is a decoding glitch


def callsigns(track):
    out = [(track.get("flight") or "").strip()]
    out += [(c or "").strip() for _, c in track.get("flights") or []]
    return [c for c in out if CS_OK.match(c)]


def display_cs(track, ts, css):
    c = (BR.callsign_at(track, ts) or "").strip()
    return c if CS_OK.match(c) else (css[0] if css else "")


def summarize(track):
    """Closest point to KANP, with the altitude nearest it in time when that
    fix has none; plus field contact and the low-pass check."""
    pts = track["points"]
    best, bi = None, 0
    contact = False
    low = None
    for i, p in enumerate(pts):
        d = BR.dist_nm(KANP_LAT, KANP_LON, p[1], p[2])
        if best is None or d < best:
            best, bi = d, i
        if d <= OPS_NEAR_NM and (p[5] == 1 or (p[3] is not None and p[3] <= OPS_LOW_FT)):
            contact = True
        if d <= LOW_NM and p[5] != 1 and p[3] is not None and p[3] > 0:
            if low is None or p[3] < low[0]:
                low = (p[3], p[0])
    p = pts[bi]
    alt = p[3]
    if alt is None and p[5] != 1:
        near = [q for q in pts if q[3] is not None and abs(q[0] - p[0]) <= 60]
        if near:
            alt = min(near, key=lambda q: abs(q[0] - p[0]))[3]
    if alt is not None and alt > ALT_MAX:
        alt = None
    return {"ts": p[0], "d": round(best, 2), "a": alt, "g": 1 if p[5] == 1 else 0,
            "contact": contact, "low": low}


def compile_day(day):
    inv = {}
    for t in day["tracks"]:
        ty = (t.get("type") or "").strip()
        if ty:
            inv.setdefault(ty, set()).add(t["hex"])
    ev, fld = [], []
    for t in day["tracks"]:
        if not t.get("points"):
            continue
        ty = (t.get("type") or "").strip()
        reg = (t.get("reg") or "").strip()
        mil = 1 if t.get("military") else 0
        css = callsigns(t)
        kinds, extra = [], {}
        vip_cs = next((c for c in css if VIP_CS.match(c)), None)
        if vip_cs or reg in VIP_REGS or (mil and ty in VIP_747 and US_SERIAL.match(reg)):
            kinds.append("vip")
            if reg in VIP_REGS:
                extra["lbl"] = VIP_REGS[reg]
        cty = country_of(t["hex"]) if mil else None
        if cty and not any(US_CS.match(c) for c in css):
            kinds.append("state")
            extra["cty"] = cty
        if ty in MIL_TYPES and (mil or ty in ("B1", "B52", "B2", "U2", "MI8")):
            kinds.append("mil")
        if ty in WARBIRD_TYPES:
            kinds.append("warbird")
        rare_cand = bool(ty) and len(inv.get(ty, ())) == 1
        heli = ty in HELI_TYPES
        s = summarize(t)
        if s["contact"]:
            fld.append(t["hex"])
            if heli or mil:
                kinds.append("lee")
                extra["why"] = "heli" if heli else "mil"
        if (s["low"] and not s["contact"] and s["low"][0] < LOW_FT
                and (BR.is_airliner(ty) or (mil and ty in ("C17", "C5M", "C130", "C30J", "K35R",
                                                           "B762", "P8", "E6", "B1", "B52",
                                                           "V22", "H47", "H53S", "B752",
                                                           "B737", "GLF5")))):
            kinds.append("low")
        if not kinds and not rare_cand and not s["contact"]:
            continue
        ts = s["ts"]
        if "low" in kinds:
            ts = s["low"][1]
        e = {"ts": ts, "h": t["hex"], "r": reg, "c": vip_cs or display_cs(t, ts, css),
             "t": ty, "n": (t.get("descr") or "").strip(), "m": mil, "d": s["d"], "a": s["a"],
             "g": s["g"], "k": kinds}
        if "low" in kinds:
            e["la"] = s["low"][0]
        if s["contact"]:
            e["fc"] = 1
        if rare_cand:
            e["rc"] = 1
        e.update(extra)
        ev.append(e)
    return {
        "date": day["date"],
        "ev": ev,
        "inv": {ty: (sorted(h) if len(h) <= INV_MAX else 0) for ty, h in inv.items()},
        "fld": sorted(set(fld)),
    }


def aggregate(days):
    days = sorted(days, key=lambda r: r["date"])
    # airframes per type over the whole archive (None = too many to be rare)
    frames = {}
    for rec in days:
        for ty, hs in rec["inv"].items():
            if hs == 0 or frames.get(ty, set()) is None:
                frames[ty] = None
                continue
            frames.setdefault(ty, set()).update(hs)
            if len(frames[ty]) > 1:
                frames[ty] = None
    rare_types = {ty for ty, hs in frames.items() if hs is not None and len(hs) == 1}
    # the closest pass of each rare type stands for it
    rare_best = {}
    for rec in days:
        for e in rec["ev"]:
            if e.get("rc") and e["t"] in rare_types:
                b = rare_best.get(e["t"])
                if b is None or e["d"] < b["d"]:
                    rare_best[e["t"]] = e
    rare_ids = {id(e) for e in rare_best.values()}

    seen_field = set()
    out = []
    for i, rec in enumerate(days):
        for e in rec["ev"]:
            k = list(e["k"])
            why = e.get("why")
            if id(e) in rare_ids:
                k.append("rare")
            if e.get("fc") and e["h"] not in seen_field and i >= FIRST_MIN_DAYS and "lee" not in k:
                k.append("lee")
                why = "new"
            elif e.get("fc") and e["h"] not in seen_field and i >= FIRST_MIN_DAYS and why:
                why = why + " new"
            if not k:
                continue
            o = {key: v for key, v in e.items() if key not in ("k", "rc", "fc", "why")}
            o["k"] = k
            if why and "lee" in k:
                o["why"] = why
            out.append(o)
        seen_field.update(rec["fld"])
    out.sort(key=lambda e: -e["ts"])
    counts = {}
    for e in out:
        for k in e["k"]:
            counts[k] = counts.get(k, 0) + 1
    return {
        "generated": int(dt.datetime.now(dt.timezone.utc).timestamp()),
        "v": VERSION,
        "tz": str(BR.TZ),
        "days": [r["date"] for r in days],
        "first_min_days": FIRST_MIN_DAYS,
        "counts": counts,
        "ev": out,
    }


def run(out, src, force=False, limit=None):
    days_dir = os.path.join(out, "days")
    os.makedirs(days_dir, exist_ok=True)
    summary = src.summary()
    today = dt.datetime.now(BR.TZ).date()
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
                    have = BR.json.load(f)
            except (OSError, ValueError):
                have = None
        need = have is None or date in hot or have.get("v") != VERSION
        if have is not None and not need and "aircraft" in entry:
            s = have.get("src") or {}
            need = (s.get("aircraft") != entry.get("aircraft")
                    or s.get("points") != entry.get("points"))
        if need:
            todo.append((date, entry))
    if limit:
        todo = todo[-limit:]
    BR.log(f"{len(listed)} days listed, {len(todo)} to compile")
    for date, entry in todo:
        try:
            day = src.day(date)
            rec = compile_day(day)
            del day
            rec["v"] = VERSION
            rec["src"] = {"aircraft": entry.get("aircraft"), "points": entry.get("points")}
            BR.write_json(os.path.join(days_dir, f"{date}.json"), rec)
            BR.log(f"  {date}: {len(rec['ev'])} candidates")
        except (urllib.error.HTTPError, urllib.error.URLError, BR.http.client.HTTPException,
                OSError, ValueError, KeyError) as e:
            BR.log(f"  {date}: failed — {e}")
    compiled = []
    for fname in sorted(os.listdir(days_dir)):
        if fname.endswith(".json"):
            try:
                with open(os.path.join(days_dir, fname)) as f:
                    compiled.append(BR.json.load(f))
            except (OSError, ValueError):
                continue
    if not compiled:
        BR.log("nothing compiled")
        return 1
    agg = aggregate(compiled)
    BR.write_json(os.path.join(out, "notables.json"), agg)
    BR.log(f"notables.json: {len(compiled)} days, {len(agg['ev'])} events {agg['counts']}")
    return 0


# ---------------------------------------------------------------------------
# selftest
# ---------------------------------------------------------------------------
def selftest():
    t0 = int(dt.datetime(2026, 9, 29, 12, 0, tzinfo=BR.TZ).timestamp())
    line = BR._line

    def tr(hexid, cs, ty, pts, reg="", mil=0, **kw):
        return dict(hex=hexid, flight=cs, type=ty, reg=reg, descr="", military=mil,
                    points=pts, **kw)
    over = line(t0, 38.80, -76.70, 10000, 39.10, -76.40, 10000, 30, 20)
    landing = (line(t0, 38.99, -76.70, 1500, KANP_LAT, KANP_LON, 300, 20, 10)
               + [[t0 + 210, KANP_LAT, KANP_LON, None, 5, 1]])
    tracks = [
        tr("ae0001", "", "B742", over, reg="92-9000", mil=1, flights=[[t0, "AF1"]]),
        tr("71be43", "KAF001", "B748", over, reg="22-001", mil=1),
        tr("15cd28", "TSTR1", "T38", over, reg="78-23132", mil=1),
        tr("ae0002", "DRAGO51", "B1", over, reg="86-0137", mil=1),
        tr("a00003", "N3774", "B25", over, reg="N3774"),
        tr("a00004", "N1", "C172", landing, reg="N1"),
        tr("ae0005", "RAVEN90", "H60", landing, reg="87-26003", mil=1),
        tr("a00006", "SWA1", "B738", line(t0, 38.92, -76.60, 1500, 38.96, -76.53, 1700, 10, 10)),
        tr("a00007", "N7", "ZZZZ", over, reg="N7"),
        tr("a00008", "N8", "C172", over, reg="N8"),
    ]
    day = {"date": "2026-09-29", "tracks": tracks}
    rec = compile_day(day)
    by = {e["h"]: e for e in rec["ev"]}
    assert by["ae0001"]["k"] == ["vip"] and by["ae0001"]["c"] == "AF1" \
        and by["ae0001"]["lbl"] == "VC-25A", by["ae0001"]
    assert by["71be43"]["k"] == ["state"] and by["71be43"]["cty"] == "South Korea", by["71be43"]
    assert "state" not in by["15cd28"]["k"], by["15cd28"]
    assert by["ae0002"]["k"] == ["mil"], by["ae0002"]
    assert by["a00003"]["k"] == ["warbird"], by["a00003"]
    assert by["ae0005"]["k"] == ["lee"] and by["ae0005"]["why"] == "heli", by["ae0005"]
    assert by["a00006"]["k"] == ["low"] and by["a00006"]["la"] == 1500, by["a00006"]
    assert by["a00004"]["fc"] == 1 and by["a00004"]["k"] == []
    assert "a00008" not in by           # a C172 overflight: nothing
    assert rec["fld"] == ["a00004", "ae0005"], rec["fld"]
    assert by["ae0001"]["d"] < 1.0, by["ae0001"]
    # 20 days: N1 lands on day 0 and day 19 (not new); N9 first lands on day 19
    days = []
    for i in range(20):
        r = BR.json.loads(BR.json.dumps(rec))
        r["date"] = (dt.date(2026, 9, 1) + dt.timedelta(days=i)).isoformat()
        if i == 19:
            n9 = dict(by["a00004"], h="a00009", r="N9", k=[])
            r["ev"].append(n9)
            r["fld"].append("a00009")
            r["inv"]["C172"] = ["a00004", "a00008", "a00009"]
        days.append(r)
    agg = aggregate(days)
    new = [e for e in agg["ev"] if e.get("why") == "new"]
    assert [e["h"] for e in new] == ["a00009"], new
    rare = [e for e in agg["ev"] if "rare" in e["k"]]
    assert sorted(e["t"] for e in rare) == ["B1", "B25", "B738", "B742", "B748", "H60",
                                             "T38", "ZZZZ"], rare
    assert len([e for e in rare if e["t"] == "ZZZZ"]) == 1
    assert agg["counts"]["vip"] == 20
    assert country_of("3c0000") == "Germany" and country_of("ae0001") is None
    BR.log("selftest ok")
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--out", help="notables-data tree to update")
    ap.add_argument("--local", help="read day files from DIR/days instead of the branch")
    ap.add_argument("--force", action="store_true", help="recompile every listed day")
    ap.add_argument("--limit", type=int, help="compile at most the newest N due days")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()
    if args.selftest:
        return selftest()
    if not args.out:
        ap.error("--out is required")
    return run(args.out, BR.Source(base=SRC, local=args.local), force=args.force,
               limit=args.limit)


if __name__ == "__main__":
    sys.exit(main())
