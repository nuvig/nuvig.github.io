#!/usr/bin/env python3
"""Storm log builder — data/wx/ → data/storms.json (stdlib only).

storms.html is the site's record of precipitation events as they happened:
every stretch of rain, snow or thunder the weather archive holds, ranked,
with the hour-by-hour numbers and LWX's own running commentary. This script
reads the archive (the day files scripts/wxarchive.py writes) and compiles
that catalog once, so the page fetches one document instead of 150 day
files. It runs at the end of every hourly archive run (wxarchive.yml) and
the output is committed beside the archive; an event in progress grows each
run.

What an event is
----------------
Hour buckets come from the routine METAR (the :5x ob) of each station: its
P-group is the precipitation that fell in the hour ending at that ob, in
hundredths of an inch, and an ob without a P-group is a dry hour (ASOS omits
the group when nothing fell; P0000 is a trace). SPECIs are read only for
present weather, wind and pressure — their P-groups are cumulative since the
last routine ob and would double-count.

A wet hour is one where KDCA (the record station) or KNAK (the field's
sensor) measured anything, reported precipitation in the present-weather
groups (a trace keeps a run continuous), or reported thunder — or where any
ring station measured RING_WET_IN or more. Wet hours closer than MERGE_GAP_H
apart are one event: a nor'easter has lulls, and a lull is not the end.

An event is kept when KDCA or KNAK measured at least MIN_IN, or thunder was
observed at either, or frozen precipitation was observed anywhere, or a ring
station measured AREA_MIN_IN — a shower that wet the ring and missed both
gauges is still weather that happened.

Output (data/storms.json)
-------------------------
  built           epoch of this build
  archive_updated index.json's updated stamp
  first, last     first and last archived day
  record, field   the two stations every event is measured at (KDCA, KNAK)
  stations        [{id, gauge}] — gauge false = never reported a P-group
  days            [[date, p_record, p_field, p_area_max, flags, hours_missing]]
                  one row per archived day; flags bit 1 thunder, 2 snow/ice,
                  4 freezing; p_* in inches (null = no obs at all)
  events          newest first, each:
    id            start day + start hour, e.g. 2026-09-21T14
    start, end    epoch of the first and last wet hour (hour start)
    hours         wet span in hours (end − start + 1)
    live          true when the last wet hour touches the archive's last run
    rank          1 = wettest at the record station, over every event
    since         end date of the most recent earlier event that was wetter
                  at the record station; null = wettest in the archive
    totals        {ID: inches} — null for a station with no gauge or no obs
    missing       {ID: hours with no routine ob inside the span}
    filled        {ID: hours repaired from the 6-hourly group} — see finish()
    trace         [ID …] stations whose obs reported precipitation but whose
                  gauge never measured any
    peak          {p, t, station} — the wettest single hour at the record
                  station, plus field: {p, t} and area: {p, t, station}
    wind          {record: {gust, spd, dir, t}, field: {…}} — peak gust and
                  the strongest sustained wind over the span (all obs), and
                  the speed-weighted mean direction °true
    pres          {min, min_t, max, max_t} — KDCA sea-level pressure, mb
    low           {ceil, ceil_t, vis, vis_t} — lowest ceiling ft and
                  visibility SM at the record station; field: same at KNAK
    wx            {ts, sn, fz, fg, hvy} — obs counts across KDCA + KNAK
    types         subset of [rain, thunder, snow, ice] actually observed
    driver        the feature LWX's discussions named most while it rained
    drivers       [[term, mentions] …] the top three
    expected      KEY MESSAGES of the last discussion issued before onset
    log           [{t, text}] every WHAT HAS CHANGED paragraph LWX issued
                  from 6 h before onset to 3 h after the end
    alerts        [{event, first, last, n}] NWS alerts overlapping the span
    cape          peak GFS CAPE (J/kg) at the field over the span, or null
    series        hourly arrays over the span, t0 = start:
                  p (record in), pf (field in), pa (area max in), pas (its
                  station), g (gust kt), s (speed kt), d (dir), slp (mb),
                  c (ceiling ft), v (vis SM), wx (present weather, joined),
                  ts (thunder at either station, 0/1) — null = no ob

Every inch here is what a gauge measured; a station that reported rain
with no gauge total is listed under `trace`, never rounded into a number.
"""
import datetime
import json
import os
import re
import sys
from zoneinfo import ZoneInfo

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WX = os.path.join(REPO, "data", "wx")
OUT = os.path.join(REPO, "data", "storms.json")
TZ = ZoneInfo("America/New_York")

MERGE_GAP_H = 6        # dry hours that still belong to the same event
MIN_IN = 0.10          # KDCA or KNAK total that makes an event
AREA_MIN_IN = 0.25     # ring total that makes an event on its own
RING_WET_IN = 0.10     # ring hourly amount that counts as a wet hour
LOG_BEFORE_H = 6       # LWX commentary window around the event
LOG_AFTER_H = 3

# What LWX calls the thing. Order = tie-break priority; weight scales the
# mention count so a named storm beats the generic "trough" it also rides on.
DRIVERS = [
    ("nor'easter", 3.0, ["nor'easter", "noreaster", "nor easter"]),
    ("tropical system", 3.0, ["tropical storm", "hurricane", "tropical cyclone", "tropical system"]),
    ("tropical remnants", 3.0, ["remnants of", "remnant low", "remnant moisture"]),
    ("coastal low", 2.0, ["coastal low", "coastal storm", "coastal system"]),
    ("cold front", 1.5, ["cold front", "cold frontal"]),
    ("warm front", 1.5, ["warm front", "warm frontal"]),
    ("stalled front", 1.5, ["stalled front", "stationary front", "stalled boundary", "stationary boundary", "quasi-stationary"]),
    ("backdoor front", 1.5, ["backdoor", "back door"]),
    ("upper low", 1.2, ["upper low", "upper-level low", "upper level low", "cutoff low", "cut-off low", "closed low"]),
    ("shortwave", 1.0, ["shortwave", "short wave", "vort max", "vorticity max"]),
    ("sea breeze", 1.0, ["sea breeze", "bay breeze"]),
    ("surface low", 0.8, ["surface low", "area of low pressure", "low pressure system"]),
    ("trough", 0.5, ["trough"]),
    ("diurnal convection", 0.8, ["diurnal", "airmass thunderstorm", "pop-up", "pulse"]),
]

WX_PRECIP = re.compile(r"(?:^|\s)([+-]?(?:VC)?(?:TS|SH|FZ|BL|DR)?(?:RA|DZ|SN|PL|GS|GR|IC|SG|UP)+)(?=\s|$)")
WX_TS = re.compile(r"(?:^|\s)[+-]?(?:VC)?TS")
WX_FROZEN = re.compile(r"(?:^|\s)[+-]?(?:VC)?(?:SH|BL|DR|TS)?(?:SN|PL|GS|GR|IC|SG)")
WX_FZ = re.compile(r"(?:^|\s)[+-]?FZ(?:RA|DZ)")
WX_FOG = re.compile(r"(?:^|\s)(?:FG|BR|MIFG|BCFG|PRFG)(?=\s|$)")
WX_HEAVY = re.compile(r"(?:^|\s)\+(?:TS|SH|FZ)?(?:RA|SN|PL|DZ)")
P_GROUP = re.compile(r"\bP(\d{4})\b")
WIND = re.compile(r"(?:^|\s)(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?KT\b")
SLP = re.compile(r"\bSLP(\d{3})\b")
SIX = re.compile(r"(?:^|\s)6(\d{4})(?=\s|$)")   # 3/6-hourly precipitation group, RMK section
CLOUD = re.compile(r"\b(FEW|SCT|BKN|OVC|VV)(\d{3})")
VIS = re.compile(r"(?:^|\s)(?:(\d{1,2})\s)?(M)?(\d{1,2})(?:/(\d{1,2}))?SM\b")


def load(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def local_day(t):
    return datetime.datetime.fromtimestamp(t, TZ).strftime("%Y-%m-%d")


def parse(raw):
    """The bits of one METAR this page needs."""
    body = raw.split(" RMK")[0]
    o = {"p": None, "wx": [], "ts": False, "fz": False, "frozen": False, "fog": False, "hvy": False,
         "spd": None, "gst": None, "dir": None, "slp": None, "ceil": None, "vis": None}
    m = P_GROUP.search(raw)
    if m:
        o["p"] = int(m.group(1)) / 100
    o["wx"] = [w.strip() for w in WX_PRECIP.findall(body)]
    o["ts"] = bool(WX_TS.search(body))
    o["frozen"] = bool(WX_FROZEN.search(body))
    o["fz"] = bool(WX_FZ.search(body))
    o["fog"] = bool(WX_FOG.search(body))
    o["hvy"] = bool(WX_HEAVY.search(body))
    w = WIND.search(body)
    if w:
        o["dir"] = None if w.group(1) == "VRB" else int(w.group(1))
        o["spd"] = int(w.group(2))
        o["gst"] = int(w.group(3)) if w.group(3) else None
    s = SLP.search(raw)
    if s:
        v = int(s.group(1))
        o["slp"] = (900 if v >= 500 else 1000) + v / 10
    o["six"] = None
    if " RMK" in raw:
        g = SIX.search(raw.split(" RMK", 1)[1])
        if g and g.group(1) != "////":
            o["six"] = int(g.group(1)) / 100
    for kind, h in CLOUD.findall(body):
        if kind in ("BKN", "OVC", "VV"):
            o["ceil"] = int(h) * 100
            break
    if re.search(r"\bP6SM\b", body):
        o["vis"] = 7.0
    else:
        v = VIS.search(body)
        if v:
            o["vis"] = (int(v.group(1) or 0)) + (int(v.group(3)) / int(v.group(4)) if v.group(4) else int(v.group(3)))
            if v.group(2):
                o["vis"] = max(0.0, o["vis"] - 0.01)
    return o


def minute_of(raw):
    m = re.search(r"\b\d{2}\d{2}(\d{2})Z\b", raw)
    return int(m.group(1)) if m else None


class Station:
    """Hour buckets for one METAR stream."""

    def __init__(self, sid):
        self.id = sid
        self.hours = {}      # hour (epoch // 3600) -> {"p": in|None, "obs": [parsed…]}
        self.gauge = False
        self.days = set()

    def add_day(self, doc):
        if not doc or not doc.get("metars"):
            return
        self.days.add(doc.get("date"))
        for t, raw in doc["metars"]:
            if not raw:
                continue
            h = int(t) // 3600
            b = self.hours.setdefault(h, {"p": None, "routine": None, "obs": []})
            o = parse(raw)
            o["t"] = int(t)
            b["obs"].append(o)
            mn = minute_of(raw)
            if o["p"] is not None:
                self.gauge = True
            if mn is not None and mn >= 45:
                # the routine ob: prefer the one carrying SLP (the hourly at
                # an ASOS), else the first with a P-group, else the first
                cur = b["routine"]
                better = (cur is None or (o["slp"] is not None and cur["slp"] is None)
                          or (cur["slp"] is None and cur["p"] is None and o["p"] is not None))
                if better:
                    b["routine"] = o

    def finish(self):
        for b in self.hours.values():
            r = b["routine"]
            if r is None:
                b["p"] = None
            elif not self.gauge:
                b["p"] = None
            else:
                b["p"] = r["p"] if r["p"] is not None else 0.0
            b["wet"] = any(o["wx"] for o in b["obs"])
            b["ts"] = any(o["ts"] for o in b["obs"])
            b["frozen"] = any(o["frozen"] for o in b["obs"])
            b["fz"] = any(o["fz"] for o in b["obs"])
            b["filled"] = False
        # An hour with no routine ob is not a dry hour. At the synoptic hours
        # (00/06/12/18Z) an ASOS also reports the 6-hour total, which is
        # measured whatever the hourly feed dropped: where that group exceeds
        # the hourly sum of the hours it covers and some of those hours are
        # missing, the remainder is spread over the missing hours and marked
        # `filled`, so the record station's event total matches its own
        # 24-hour groups rather than what api.weather.gov happened to serve.
        if not self.gauge:
            return
        for h, b in list(self.hours.items()):
            r = b["routine"]
            # the :52 ob sits in the bucket before the synoptic hour it reports
            if r is None or r["six"] is None or (h + 1) % 6 != 0:
                continue
            span = [self.hours.get(k) for k in range(h - 5, h + 1)]
            known = sum((x["p"] or 0) for x in span if x and x["p"] is not None)
            miss = [k for k, x in zip(range(h - 5, h + 1), span) if x is None or x["p"] is None]
            if not miss:
                continue
            rem = max(0.0, r["six"] - known)
            each = round(rem / len(miss), 2)
            for k in miss:
                bb = self.hours.setdefault(k, {"p": None, "routine": None, "obs": [], "wet": False,
                                                "ts": False, "frozen": False, "fz": False})
                bb["p"] = each
                bb["filled"] = True

    def p(self, h):
        b = self.hours.get(h)
        return b["p"] if b else None

    def bucket(self, h):
        return self.hours.get(h)


def afd_sections(text):
    """{'WHAT HAS CHANGED': '…', 'KEY MESSAGES': '…', 'DISCUSSION': '…', …}"""
    out = {}
    parts = re.split(r"\n\.([A-Z][A-Z /&]+?)\.\.\.", "\n" + text)
    for i in range(1, len(parts) - 1, 2):
        name = parts[i].strip()
        body = parts[i + 1].split("\n&&")[0].strip()
        out.setdefault(name, body)
    return out


def tidy(s, cap=None):
    s = re.sub(r"[ \t]*\n[ \t]*", " ", s.strip())
    s = re.sub(r"\s{2,}", " ", s)
    if cap and len(s) > cap:
        s = s[:cap].rsplit(" ", 1)[0] + " …"
    return s


def key_messages(sec):
    if not sec:
        return []
    items = re.split(r"\n\s*-\s*\d\)\s*", "\n" + sec)
    out = [tidy(x, 220) for x in items if x.strip()]
    return out[:3]


def mean_dir(obs):
    """Speed-weighted mean wind direction, °true."""
    import math
    x = y = 0.0
    for o in obs:
        if o["dir"] is None or not o["spd"]:
            continue
        r = math.radians(o["dir"])
        x += o["spd"] * math.sin(r)
        y += o["spd"] * math.cos(r)
    if x == 0 and y == 0:
        return None
    return int(round(math.degrees(math.atan2(x, y)) % 360)) or 360


def wind_stats(st, h0, h1):
    obs = [o for h in range(h0, h1 + 1) for o in (st.bucket(h) or {"obs": []})["obs"]]
    if not obs:
        return None
    gust = max(obs, key=lambda o: (o["gst"] or o["spd"] or 0))
    sust = max(obs, key=lambda o: o["spd"] or 0)
    return {
        "gust": gust["gst"] or gust["spd"], "gust_t": gust["t"], "gust_dir": gust["dir"],
        "spd": sust["spd"], "spd_t": sust["t"],
        "dir": mean_dir(obs),
    }


def low_stats(st, h0, h1):
    obs = [o for h in range(h0, h1 + 1) for o in (st.bucket(h) or {"obs": []})["obs"]]
    ce = [o for o in obs if o["ceil"] is not None]
    vi = [o for o in obs if o["vis"] is not None]
    out = {}
    if ce:
        m = min(ce, key=lambda o: o["ceil"])
        out["ceil"], out["ceil_t"] = m["ceil"], m["t"]
    if vi:
        m = min(vi, key=lambda o: o["vis"])
        out["vis"], out["vis_t"] = round(m["vis"], 2), m["t"]
    return out or None


def build():
    idx = load(os.path.join(WX, "index.json")) or {}
    record_id = idx.get("station", "KDCA")
    field_id = idx.get("field_station", "KNAK")
    ring_ids = idx.get("stations", [])

    record = Station(record_id)
    for d in idx.get("obs_days", []):
        record.add_day(load(os.path.join(WX, "obs", f"{d}.json")))
    field = Station(field_id)
    for d in idx.get("fieldobs_days", []):
        field.add_day(load(os.path.join(WX, "fieldobs", f"{d}.json")))
    ring = []
    for sid in ring_ids:
        st = Station(sid)
        for d in (idx.get("station_days") or {}).get(sid, []):
            st.add_day(load(os.path.join(WX, "stations", sid, f"{d}.json")))
        ring.append(st)
    for st in [record, field] + ring:
        st.finish()

    days = sorted(record.days | field.days)
    if not days:
        return {"built": int(datetime.datetime.now().timestamp()), "events": [], "days": []}

    def day_hours(day):
        d0 = datetime.datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=TZ)
        d1 = d0 + datetime.timedelta(days=1)
        return int(d0.timestamp()) // 3600, int(d1.timestamp()) // 3600 - 1

    h_first = day_hours(days[0])[0]
    h_last = day_hours(days[-1])[1]
    updated = idx.get("updated") or int(datetime.datetime.now().timestamp())
    h_last = min(h_last, updated // 3600)

    # ---- wet hours ----
    def area_max(h):
        best, bs = None, None
        for st in ring:
            p = st.p(h)
            if p is not None and (best is None or p > best):
                best, bs = p, st.id
        return best, bs

    wet = []
    for h in range(h_first, h_last + 1):
        w = False
        for st in (record, field):
            b = st.bucket(h)
            if b and ((b["p"] or 0) > 0 or b["wet"] or b["ts"]):
                w = True
        am, _ = area_max(h)
        if am is not None and am >= RING_WET_IN:
            w = True
        if w:
            wet.append(h)

    spans = []
    for h in wet:
        if spans and h - spans[-1][1] <= MERGE_GAP_H:
            spans[-1][1] = h
        else:
            spans.append([h, h])

    def total(st, h0, h1):
        if not st.gauge:
            return None, h1 - h0 + 1
        s, miss, seen = 0.0, 0, False
        for h in range(h0, h1 + 1):
            p = st.p(h)
            if p is None:
                miss += 1
            else:
                s += p
                seen = True
        return (round(s, 2) if seen else None), miss

    def filled(st, h0, h1):
        return sum(1 for h in range(h0, h1 + 1) if (st.bucket(h) or {}).get("filled"))

    # ---- the AFD catalog ----
    afds = sorted(idx.get("afd", []), key=lambda a: a["t"])
    afd_cache = {}

    def afd_text(entry):
        p = entry["p"]
        if p not in afd_cache:
            doc = load(os.path.join(WX, p))
            afd_cache[p] = (doc or {}).get("productText") or ""
        return afd_cache[p]

    alert_docs = {}

    def alerts_between(t0, t1):
        out = {}
        d = local_day(t0)
        dend = local_day(t1)
        cur = datetime.datetime.strptime(d, "%Y-%m-%d")
        while cur.strftime("%Y-%m-%d") <= dend:
            day = cur.strftime("%Y-%m-%d")
            if day not in alert_docs:
                alert_docs[day] = load(os.path.join(WX, "alerts", f"{day}.json"))
            doc = alert_docs[day]
            for a in (doc or {}).get("alerts", []):
                on = iso_epoch(a.get("onset")) or a.get("seen")
                en = iso_epoch(a.get("ends")) or iso_epoch(a.get("expires")) or (on + 6 * 3600 if on else None)
                if on is None:
                    continue
                if en is None:
                    en = on + 6 * 3600
                if en < t0 or on > t1:
                    continue
                k = a.get("event") or "?"
                e = out.setdefault(k, {"event": k, "first": on, "last": en, "n": 0})
                e["first"] = min(e["first"], on)
                e["last"] = max(e["last"], en)
                e["n"] += 1
            cur += datetime.timedelta(days=1)
        return sorted(out.values(), key=lambda e: e["first"])

    model_docs = {}

    def cape_max(t0, t1):
        best = None
        d = datetime.datetime.strptime(local_day(t0), "%Y-%m-%d")
        dend = local_day(t1)
        while d.strftime("%Y-%m-%d") <= dend:
            day = d.strftime("%Y-%m-%d")
            if day not in model_docs:
                model_docs[day] = load(os.path.join(WX, "model", f"{day}.json"))
            doc = model_docs[day]
            for s in (doc or {}).get("snaps", []):
                cape = s.get("cape") or []
                for i, v in enumerate(cape):
                    th = s["t0"] + i * 3600
                    if v is not None and t0 <= th <= t1 and (best is None or v > best):
                        best = v
            d += datetime.timedelta(days=1)
        return None if best is None else int(round(best))

    events = []
    for h0, h1 in spans:
        t0, t1 = h0 * 3600, h1 * 3600
        tot_r, miss_r = total(record, h0, h1)
        tot_f, miss_f = total(field, h0, h1)
        totals = {record.id: tot_r, field.id: tot_f}
        missing = {record.id: miss_r, field.id: miss_f}
        for st in ring:
            totals[st.id], missing[st.id] = total(st, h0, h1)
        filled_h = {st.id: filled(st, h0, h1) for st in [record, field] + ring if filled(st, h0, h1)}
        ring_max = max((v for k, v in totals.items() if v is not None and k not in (record.id, field.id)), default=0)
        obs_all = [o for st in (record, field) for h in range(h0, h1 + 1) for o in (st.bucket(h) or {"obs": []})["obs"]]
        ts_n = sum(1 for o in obs_all if o["ts"])
        sn_n = sum(1 for o in obs_all if o["frozen"])
        fz_n = sum(1 for o in obs_all if o["fz"])
        fg_n = sum(1 for o in obs_all if o["fog"])
        hv_n = sum(1 for o in obs_all if o["hvy"])
        frozen_any = sn_n or fz_n or any(
            (st.bucket(h) or {}).get("frozen") or (st.bucket(h) or {}).get("fz")
            for st in ring for h in range(h0, h1 + 1))
        keep = ((tot_r or 0) >= MIN_IN or (tot_f or 0) >= MIN_IN or ts_n or frozen_any
                or ring_max >= AREA_MIN_IN)
        if not keep:
            continue

        trace = [k for k, v in totals.items() if (v or 0) == 0 and any(
            (st.bucket(h) or {}).get("wet") for st in [record, field] + ring if st.id == k for h in range(h0, h1 + 1))]

        # peak hours
        def peak_of(st):
            best = None
            for h in range(h0, h1 + 1):
                p = st.p(h)
                if p and (best is None or p > best["p"]):
                    best = {"p": p, "t": h * 3600}
            return best
        peak = peak_of(record)
        if peak:
            peak["station"] = record.id
        area_peak = None
        for h in range(h0, h1 + 1):
            am, ams = area_max(h)
            if am and (area_peak is None or am > area_peak["p"]):
                area_peak = {"p": am, "t": h * 3600, "station": ams}

        # pressure
        slp = [(o["slp"], o["t"]) for h in range(h0, h1 + 1) for o in (record.bucket(h) or {"obs": []})["obs"] if o["slp"] is not None]
        pres = None
        if slp:
            lo, hi = min(slp), max(slp)
            pres = {"min": lo[0], "min_t": lo[1], "max": hi[0], "max_t": hi[1]}

        # series
        n = h1 - h0 + 1
        ser = {"t0": t0, "n": n, "p": [], "pf": [], "pa": [], "pas": [], "g": [], "s": [], "d": [],
               "slp": [], "c": [], "v": [], "wx": [], "ts": []}
        for h in range(h0, h1 + 1):
            ser["p"].append(record.p(h))
            ser["pf"].append(field.p(h))
            am, ams = area_max(h)
            ser["pa"].append(am)
            ser["pas"].append(ams)
            b = record.bucket(h)
            r = b["routine"] if b else None
            obs = b["obs"] if b else []
            g = max((o["gst"] or 0 for o in obs), default=0) or None
            ser["g"].append(g)
            ser["s"].append(r["spd"] if r else (max((o["spd"] or 0 for o in obs), default=None) or None))
            ser["d"].append(r["dir"] if r else None)
            ser["slp"].append(r["slp"] if r else None)
            ser["c"].append(min((o["ceil"] for o in obs if o["ceil"] is not None), default=None))
            ser["v"].append(min((o["vis"] for o in obs if o["vis"] is not None), default=None))
            codes = []
            for st in (record, field):
                bb = st.bucket(h)
                for o in (bb["obs"] if bb else []):
                    for w in o["wx"]:
                        if w not in codes:
                            codes.append(w)
            ser["wx"].append(" ".join(codes))
            fb = field.bucket(h)
            ser["ts"].append(1 if ((b and b["ts"]) or (fb and fb["ts"])) else 0)

        # LWX commentary
        lo_t, hi_t = t0 - LOG_BEFORE_H * 3600, t1 + (LOG_AFTER_H + 1) * 3600
        window = [a for a in afds if lo_t <= a["t"] <= hi_t]
        before = [a for a in afds if a["t"] < t0]
        expected = None
        if before:
            secs = afd_sections(afd_text(before[-1]))
            km = key_messages(secs.get("KEY MESSAGES"))
            if not km and secs.get("SYNOPSIS"):
                km = [tidy(secs["SYNOPSIS"], 260)]
            if km:
                expected = {"t": before[-1]["t"], "key": km}
        log = []
        counts = {}
        for a in window:
            secs = afd_sections(afd_text(a))
            ch = secs.get("WHAT HAS CHANGED")
            if ch:
                log.append({"t": a["t"], "text": tidy(ch, 420)})
            body = " ".join(v for k, v in secs.items() if k not in ("WHAT HAS CHANGED",)).lower()
            for name, w, terms in DRIVERS:
                c = sum(body.count(t) for t in terms)
                if c:
                    counts[name] = counts.get(name, 0) + c
        drivers = sorted(counts.items(), key=lambda kv: -kv[1] * dict((n, w) for n, w, _ in DRIVERS)[kv[0]])
        # convection without a named feature: the thunder is the story
        if ts_n and (not drivers or drivers[0][0] in ("trough", "shortwave", "diurnal convection")):
            driver = "thunderstorms"
        else:
            driver = drivers[0][0] if drivers else ("thunderstorms" if ts_n else "rain")

        types = []
        if any(("RA" in w or "DZ" in w or "UP" in w) and "FZ" not in w for o in obs_all for w in o["wx"]) or (tot_r or 0) > 0 or (tot_f or 0) > 0:
            types.append("rain")
        if ts_n:
            types.append("thunder")
        if sn_n:
            types.append("snow")
        if fz_n:
            types.append("ice")

        d0 = datetime.datetime.fromtimestamp(t0, TZ)
        events.append({
            "id": d0.strftime("%Y-%m-%dT%H"),
            "start": t0, "end": t1, "hours": n,
            "live": (h1 >= h_last - 1),
            "totals": totals, "missing": missing, "filled": filled_h, "trace": trace,
            "peak": peak, "peak_field": peak_of(field), "peak_area": area_peak,
            "wind": {"record": wind_stats(record, h0, h1), "field": wind_stats(field, h0, h1)},
            "pres": pres,
            "low": {"record": low_stats(record, h0, h1), "field": low_stats(field, h0, h1)},
            "wx": {"ts": ts_n, "sn": sn_n, "fz": fz_n, "fg": fg_n, "hvy": hv_n},
            "types": types,
            "driver": driver, "drivers": [[k, v] for k, v in drivers[:3]],
            "expected": expected, "log": log,
            "alerts": alerts_between(t0 - 6 * 3600, t1 + 6 * 3600),
            "cape": cape_max(t0, t1),
            "series": ser,
        })

    # ---- rank, since ----
    def key(e):
        v = e["totals"].get(record.id)
        if v is None:
            v = e["totals"].get(field.id) or 0
        return v
    order = sorted(events, key=lambda e: (-key(e), -e["hours"]))
    for i, e in enumerate(order):
        e["rank"] = i + 1
    for e in events:
        bigger = [x for x in events if x["start"] < e["start"] and key(x) > key(e)]
        e["since"] = local_day(max(bigger, key=lambda x: x["start"])["end"]) if bigger else None
    events.sort(key=lambda e: -e["start"])

    # ---- days ----
    day_rows = []
    for day in days:
        a, b = day_hours(day)
        b = min(b, h_last)
        if b < a:
            continue
        pr, mr = total(record, a, b)
        pf, _ = total(field, a, b)
        # the day's area figure is the wettest ring gauge over the day
        best = None
        for st in ring:
            v, _ = total(st, a, b)
            if v is not None and (best is None or v > best):
                best = v
        flags = 0
        for h in range(a, b + 1):
            for st in (record, field):
                bb = st.bucket(h)
                if not bb:
                    continue
                if bb["ts"]:
                    flags |= 1
                if bb["frozen"]:
                    flags |= 2
                if bb["fz"]:
                    flags |= 4
        day_rows.append([day, pr, pf, best, flags, mr])

    return {
        "built": int(datetime.datetime.now().timestamp()),
        "archive_updated": idx.get("updated"),
        "first": days[0], "last": days[-1],
        "record": record.id, "field": field.id,
        "stations": [{"id": st.id, "gauge": st.gauge} for st in [record, field] + ring],
        "rules": {"merge_gap_h": MERGE_GAP_H, "min_in": MIN_IN, "area_min_in": AREA_MIN_IN},
        "days": day_rows,
        "events": events,
    }


def iso_epoch(s):
    if not s:
        return None
    try:
        return int(datetime.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp())
    except ValueError:
        return None


def selftest():
    """Offline checks of the parser and the event rules."""
    o = parse("KDCA 220452Z 06015G21KT 3SM -RA BR OVC008 14/13 A3007 RMK AO2 P0007 SLP192 T01390128")
    assert o["p"] == 0.07 and o["gst"] == 21 and o["spd"] == 15 and o["dir"] == 60, o
    assert o["slp"] == 1019.2 and o["ceil"] == 800 and o["vis"] == 3 and o["wx"] == ["-RA"], o
    o = parse("KNAK 221856Z AUTO 02010KT 1/2SM +TSRA FG VV004 15/15 A2990 RMK AO2 P0055")
    assert o["ts"] and o["hvy"] and o["ceil"] == 400 and abs(o["vis"] - 0.5) < 1e-9 and o["p"] == 0.55, o
    o = parse("KBWI 011254Z 00000KT 10SM CLR 20/10 A3010 RMK AO2 SLP195")
    assert o["p"] is None and not o["wx"] and o["ceil"] is None and o["vis"] == 10, o
    secs = afd_sections("\n000\nFXUS61 KLWX\n\n.WHAT HAS CHANGED...\nA Gale Watch was issued.\n\n&&\n\n.KEY MESSAGES...\n- 1) Rain\n  through Tuesday.\n\n- 2) Drier this weekend.\n\n&&\n\n.DISCUSSION...\nA coastal low deepens.\n&&\n")
    assert secs["WHAT HAS CHANGED"] == "A Gale Watch was issued." and "coastal low" in secs["DISCUSSION"], secs
    assert key_messages(secs["KEY MESSAGES"]) == ["Rain through Tuesday.", "Drier this weekend."], key_messages(secs["KEY MESSAGES"])
    st = Station("KTST")
    base = 1_700_000_000 - 1_700_000_000 % 3600
    st.add_day({"date": "x", "metars": [
        [base + 52 * 60, "KTST 010052Z 00000KT 10SM CLR 20/10 A3010 RMK AO2 SLP195"],
        [base + 3600 + 52 * 60, "KTST 010152Z 04010KT 5SM -RA BKN020 18/16 A3005 RMK AO2 P0012 SLP180"],
        [base + 3600 + 55 * 60, "KTST 010155Z 04012KT 3SM RA BKN012 18/16 A3005 RMK AO2 P0015"],
    ]})
    st.finish()
    assert st.gauge and st.p(base // 3600) == 0.0 and st.p(base // 3600 + 1) == 0.12, (st.p(base // 3600), st.p(base // 3600 + 1))
    assert st.bucket(base // 3600 + 1)["wet"] and not st.bucket(base // 3600)["wet"]
    assert mean_dir([{"dir": 350, "spd": 10}, {"dir": 10, "spd": 10}]) == 360
    st = Station("KSIX")
    h6 = (base // 3600 // 6 + 1) * 6 - 1       # the bucket holding the next synoptic ob
    obs = []
    for k in range(h6 - 5, h6 + 1):
        if k == h6 - 2:
            continue                             # one hour never served
        p = "P0010" if k != h6 - 5 else ""
        six = " 60050" if k == h6 else ""
        obs.append([k * 3600 + 52 * 60, f"KSIX 010052Z 00000KT 10SM -RA OVC020 20/10 A3010 RMK AO2 {p}{six} SLP195"])
    st.add_day({"date": "x", "metars": obs})
    st.finish()
    # 4 known hours × 0.10 = 0.40 against a 0.50 group → the missing hour gets 0.10
    assert st.p(h6 - 2) == 0.10 and st.bucket(h6 - 2)["filled"], st.p(h6 - 2)
    print("selftest ok")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
        sys.exit(0)
    doc = build()
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(doc, f, separators=(",", ":"), ensure_ascii=False)
    n = len(doc["events"])
    print(f"storms.json: {n} events over {doc.get('first')}..{doc.get('last')}, "
          f"{os.path.getsize(OUT) // 1024} KB")
    for e in sorted(doc["events"], key=lambda e: e["rank"])[:10]:
        print(f"  #{e['rank']:2d} {e['id']} {e['hours']:3d} h  {doc['record']} {e['totals'].get(doc['record'])}  "
              f"{doc['field']} {e['totals'].get(doc['field'])}  {e['driver']}  ts={e['wx']['ts']}")
