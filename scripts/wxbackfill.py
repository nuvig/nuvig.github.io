#!/usr/bin/env python3
"""Backfill data/wx/ from historical archives (stdlib only, run by hand).

The hourly archiver (scripts/wxarchive.py) only captures what is on the wire
when it runs — GitHub's scheduler fires it every ~2.4 h in practice, and the
archive only reaches back to when each stream was added. This script repairs
the past for the streams where a trustworthy public archive exists:

  obs   KDCA METARs        Iowa Environmental Mesonet (IEM) ASOS archive
  fieldobs KNAK METARs     same IEM ASOS archive — the field's own sensor,
                           so aviation rows verify a KANP forecast against
                           KANP weather instead of KDCA 25 nm NW
  stations local ring      same again, one directory per field in
                           wxarchive.STATIONS (W29, KFME, KBWI, KESN …)
  afd   LWX discussions    IEM NWS text-product archive (AFOS pil AFDLWX)
  taf   KMTN/KBWI/KDCA     IEM text-product archive (pils TAFMTN/TAFBWI/TAFDCA)
                           — raw text incl. AMD amendments (Ogimet has the
                           same data but rate-limits hard; IEM is the default)
  model GFS CAPE/CIN/pr    Open-Meteo historical *forecast* API (what the
                           model said at the time, not a reanalysis).
                           Opt-in via --streams: less battle-tested.

Deliberately NOT backfillable — no public archive preserves what was
*predicted* at the time, and substituting later data would poison the
drift/verification cards with forecasts nobody ever saw:

  forecast   NWS point-forecast snapshots
  grid       NWS hourly grid at the field
  alerts     (an IEM archive exists, but the page only reads alerts live)

Honesty rules, enforced here:
  - an hour IEM has no ob for, on a day that is over, is recorded as "nh" —
    the station never reported it. A part-time AWOS (KAPG runs 06-15, KNHK
    sleeps overnight) is not an archive gap, and counting it as one is the
    same failure as calling a short day complete, pointed the other way
  - never modify or replace an entry the live archiver captured
  - never rewrite an existing AFD issuance file
  - everything backfilled is tagged ("bf") so consumers can tell provenance
  - backfilled TAF entries carry raw text (t/raw), not the decoded periods
    the live archiver stores — the raw product is the ground truth anyway

Usage:
  python3 scripts/wxbackfill.py --since 2026-05-01 [--until 2026-08-05]
      [--streams obs,fieldobs,afd,taf] [--dry-run]
  python3 scripts/wxbackfill.py --selftest

A 90-day afd+taf backfill is a few thousand polite requests (~0.5 s apart) —
expect ~30 min. Reruns are cheap: anything already on disk is skipped before
its text is fetched.
"""

import argparse
import datetime
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wxarchive as wxa

IEM = "https://mesonet.agron.iastate.edu"
OM_HIST = "https://historical-forecast-api.open-meteo.com/v1/forecast"
PAUSE_S = 0.5          # between requests — IEM asks for politeness
UTC = datetime.timezone.utc

# Injectable for --selftest; real transport below.
def http_json(url):
    _pause()
    return wxa.fetch(url)


def http_text(url):
    _pause()
    return wxa.fetch_text(url)


_last_req = [0.0]

def _pause():
    dt = time.monotonic() - _last_req[0]
    if dt < PAUSE_S:
        time.sleep(PAUSE_S - dt)
    _last_req[0] = time.monotonic()


def days_between(since, until):
    d, out = since, []
    while d <= until:
        out.append(d)
        d += datetime.timedelta(days=1)
    return out


def local_day(epoch_s, tzinfo):
    return f"{datetime.datetime.fromtimestamp(epoch_s, tzinfo):%Y-%m-%d}"


mark_bf = wxa.mark_bf


# ---------------------------------------------------------------------------
# obs — IEM ASOS archive, one bulk CSV request for the whole range
# ---------------------------------------------------------------------------

# These live in wxarchive.py now: the hourly archiver heals its own gaps from
# the same IEM endpoint, and live and backfill must agree on parsing, dedupe
# and provenance tagging down to the tolerance.
parse_asos_csv = wxa.parse_asos_csv
merge_obs_day = wxa.merge_metars


def _backfill_metars(station, out_dir, label, since, until, dry):
    entries = parse_asos_csv(http_text(wxa.asos_url(station, since, until)))
    tz = wxa.local_now().tzinfo
    lo, hi = f"{since:%Y-%m-%d}", f"{until:%Y-%m-%d}"
    by_day = {}
    for t, raw in entries:
        day = local_day(t, tz)
        if lo <= day <= hi:
            by_day.setdefault(day, []).append((t, raw))
    total = 0
    settled = 0
    today = f"{wxa.local_now():%Y-%m-%d}"
    # Every day in range that either IEM has entries for or we already hold a
    # file for — a day we hold but IEM returned nothing for still needs its
    # hours settled.
    on_disk = {f[:-5] for f in (os.listdir(out_dir) if os.path.isdir(out_dir) else [])
               if f.endswith(".json") and lo <= f[:-5] <= hi}
    for day in sorted(set(by_day) | on_disk):
        ents = by_day.get(day, [])
        path = os.path.join(out_dir, f"{day}.json")
        doc = wxa.read_json(path, {"date": day, "station": station, "metars": []})
        before_nh = doc.get("nh") or []
        added = merge_obs_day(doc, ents)
        # For a day that is over, IEM *is* the archive of record: an hour it
        # doesn't have is an hour the station never reported, not a hole in
        # ours. Recording that (same "nh" key the hourly heal writes) is what
        # keeps the health panel from crying wolf — KAPG reports 06–15 and
        # KNHK sleeps overnight, which is a thousand "missing" hours that were
        # never observable. Without this the panel swaps one dishonesty for
        # its mirror image.
        nh = before_nh
        if day < today:
            nh = sorted(set(before_nh) | set(wxa.missing_hours(doc, day, tz)))
            if nh:
                doc["nh"] = nh
        if (added or nh != before_nh) and not dry:
            wxa.write_json(path, doc)
        if added:
            wxa.log(f"{label} {day}: +{added} METAR(s)")
        if nh != before_nh:
            settled += len(nh) - len(before_nh)
        total += added
    wxa.log(f"{label}: {total} METAR(s) backfilled from {station} "
            f"({len(entries)} fetched)" +
            (f", {settled} hour(s) settled as never reported" if settled else ""))
    return total


def backfill_obs(since, until, dry):
    return _backfill_metars(wxa.OBS_STATION, wxa.OBS_DIR, "obs", since, until, dry)


def backfill_stations(since, until, dry):
    """Every other field in the local ring (wxarchive.STATIONS), one directory
    per station. These are ordinary ASOS/AWOS sites, so IEM has them as far
    back as anyone needs — a station added to the ring today can be given the
    same history as the rest with one run."""
    total = 0
    for station in wxa.STATIONS:
        if station in (wxa.OBS_STATION, wxa.FIELD_OBS_STATION):
            continue          # dedicated streams — see wxarchive.archive_stations
        try:
            total += _backfill_metars(station, wxa.station_dir(station),
                                      f"stations/{station}", since, until, dry)
        except (urllib.error.URLError, OSError, ValueError) as e:
            wxa.log(f"stations {station}: FAILED — {e}")
        _pause()
    return total


def backfill_fieldobs(since, until, dry):
    """The field's own station. Same IEM source as obs — KNAK is in the ASOS
    archive — so the field rows on discussion.html get history back to
    whatever date is asked for, not just from when the stream was added."""
    station = wxa.FIELD_OBS_STATION
    if not station or station == wxa.OBS_STATION:
        wxa.log("fieldobs: no distinct field station configured — skipping")
        return 0
    return _backfill_metars(station, wxa.FIELDOBS_DIR, "fieldobs", since, until, dry)


# ---------------------------------------------------------------------------
# afd + taf — IEM AFOS text-product archive
# ---------------------------------------------------------------------------

# The AFOS helpers live in wxarchive.py now (heal_tafs() uses them hourly);
# these wrappers add the politeness pause a long backfill needs.
product_time = wxa.product_time
clean_product = wxa.clean_product


def list_products(pil, day):
    data = http_json(wxa.afos_list_url(pil, day))
    return [p.get("product_id") for p in (data.get("data") or []) if p.get("product_id")]


def fetch_product(product_id):
    return clean_product(http_text(wxa.afos_text_url(product_id)))


def backfill_afd(since, until, dry):
    added = 0
    for day in days_between(since, until):
        try:
            pids = list_products(f"AFD{wxa.OFFICE}", day)
        except (urllib.error.URLError, OSError, json.JSONDecodeError) as e:
            wxa.log(f"afd {day:%Y-%m-%d}: {e}")
            continue
        for pid in pids:
            t = product_time(pid)
            if not t:
                continue
            path = os.path.join(wxa.AFD_DIR, f"{t:%Y}", f"afd-{t:%Y%m%d-%H%M}.json")
            if os.path.exists(path):
                continue                        # live capture wins, always
            try:
                text = fetch_product(pid)
            except (urllib.error.URLError, OSError) as e:
                wxa.log(f"afd {pid}: {e}")
                continue
            if not dry:
                wxa.write_json(path, {
                    "id": pid, "office": wxa.OFFICE,
                    "issuanceTime": t.isoformat().replace("+00:00", "Z"),
                    "productText": text, "bf": 1,
                })
            added += 1
    wxa.log(f"afd: {added} issuance(s) backfilled")
    return added


merge_taf_day = wxa.merge_taf_day


def backfill_taf(since, until, dry):
    tz = wxa.local_now().tzinfo
    added = 0
    for station in wxa.TAF_STATIONS:
        pil = wxa.taf_pil(station)
        for day in days_between(since, until):
            try:
                pids = list_products(pil, day)
            except (urllib.error.URLError, OSError, json.JSONDecodeError) as e:
                wxa.log(f"taf {station} {day:%Y-%m-%d}: {e}")
                continue
            for pid in pids:
                t = product_time(pid)
                if not t:
                    continue
                epoch_s = int(t.timestamp())
                day_key = local_day(epoch_s, tz)
                path = os.path.join(wxa.TAF_DIR, f"{day_key}.json")
                doc = wxa.read_json(path, {"date": day_key, "tafs": []})
                if any(x["station"] == station and abs(x["t"] - epoch_s) <= 90
                       for x in doc["tafs"]):
                    continue                    # dedupe before fetching text
                try:
                    raw = fetch_product(pid)
                except (urllib.error.URLError, OSError) as e:
                    wxa.log(f"taf {pid}: {e}")
                    continue
                if merge_taf_day(doc, station, epoch_s, raw) and not dry:
                    wxa.write_json(path, doc)
                added += 1
    wxa.log(f"taf: {added} issuance(s) backfilled")
    return added


# ---------------------------------------------------------------------------
# model — Open-Meteo historical forecast API (opt-in)
# ---------------------------------------------------------------------------

def model_day_doc(day_str, field, hourly):
    """One synthetic snap covering the local day — tagged bf, and only ever
    written into a day file the live archiver never touched. Pure."""
    times = hourly.get("time") or []
    rnd = lambda arr: [None if v is None else round(v) for v in (arr or [])]
    return {"date": day_str, "field": field, "snaps": [{
        "t": times[0] if times else None,
        "t0": times[0] if times else None,
        "n": len(times),
        "cape": rnd(hourly.get("cape")),
        "cin": rnd(hourly.get("convective_inhibition")),
        "pr": [None if v is None else round(v, 2)
               for v in (hourly.get("precipitation") or [])],
        "bf": 1,
    }], "bf": {"src": "open-meteo", "n": 1, "at": int(time.time())}}


def backfill_model(since, until, dry):
    lat, lon = wxa.FIELD.split(",")
    added = 0
    for day in days_between(since, until):
        day_str = f"{day:%Y-%m-%d}"
        path = os.path.join(wxa.MODEL_DIR, f"{day_str}.json")
        if os.path.exists(path):
            continue                            # never mix into a live day
        url = (f"{OM_HIST}?latitude={lat}&longitude={lon}"
               "&hourly=cape,convective_inhibition,precipitation"
               f"&start_date={day_str}&end_date={day_str}"
               f"&timeformat=unixtime&timezone={urllib.parse.quote(wxa.TZ)}"
               "&models=gfs_global")
        try:
            d = http_json(url)
        except (urllib.error.URLError, OSError, json.JSONDecodeError) as e:
            wxa.log(f"model {day_str}: {e}")
            continue
        doc = model_day_doc(day_str, wxa.FIELD, d.get("hourly") or {})
        if not doc["snaps"][0]["n"]:
            continue
        if not dry:
            wxa.write_json(path, doc)
        added += 1
    wxa.log(f"model: {added} day(s) backfilled")
    return added


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

STREAMS = {"obs": backfill_obs, "fieldobs": backfill_fieldobs,
           "afd": backfill_afd, "taf": backfill_taf, "model": backfill_model,
           "stations": backfill_stations}


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="Backfill data/wx/ from IEM / Open-Meteo archives.")
    ap.add_argument("--since", help="first local day, YYYY-MM-DD")
    ap.add_argument("--until", help="last local day (default: yesterday)")
    ap.add_argument("--streams", default="obs,fieldobs,stations,afd,taf",
                    help="comma list of obs,fieldobs,stations,afd,taf,model "
                         "(default: obs,fieldobs,stations,afd,taf)")
    ap.add_argument("--dry-run", action="store_true",
                    help="fetch and report, write nothing")
    ap.add_argument("--selftest", action="store_true",
                    help="run the built-in unit tests and exit")
    args = ap.parse_args(argv)

    if args.selftest:
        return run_selftest()
    if not args.since:
        ap.error("--since is required (or use --selftest)")

    parse_day = lambda s: datetime.date.fromisoformat(s)
    since = parse_day(args.since)
    until = parse_day(args.until) if args.until else \
        wxa.local_now().date() - datetime.timedelta(days=1)
    if since > until:
        ap.error(f"--since {since} is after --until {until}")

    names = [s.strip() for s in args.streams.split(",") if s.strip()]
    bad = [s for s in names if s not in STREAMS]
    if bad:
        ap.error(f"unknown stream(s): {', '.join(bad)} "
                 f"(forecast/grid/alerts are not backfillable — see docstring)")

    wxa.log(f"backfilling {', '.join(names)} for {since} .. {until}"
            f"{' (dry run)' if args.dry_run else ''}")
    failures = 0
    for name in names:
        try:
            STREAMS[name](since, until, args.dry_run)
        except (urllib.error.URLError, OSError, KeyError, ValueError,
                json.JSONDecodeError) as e:
            wxa.log(f"{name}: FAILED — {e}")
            failures += 1
    if not args.dry_run:
        n = wxa.build_index()
        wxa.log(f"index rebuilt: {n} AFD issuance(s) total")
    return 1 if failures else 0


# ---------------------------------------------------------------------------
# --selftest — fixture tests for every pure part
# ---------------------------------------------------------------------------

def run_selftest():
    import tempfile
    import unittest

    class Fixtures(unittest.TestCase):
        def setUp(self):
            self.tmp = tempfile.TemporaryDirectory()
            root = self.tmp.name
            self.saved = {k: getattr(wxa, k) for k in
                          ("WX", "AFD_DIR", "FC_DIR", "OBS_DIR", "FIELDOBS_DIR",
                           "GRID_DIR", "TAF_DIR", "ALERT_DIR", "MODEL_DIR",
                           "STATIONS_DIR")}
            wxa.WX = root
            for k in list(self.saved)[1:]:
                setattr(wxa, k, os.path.join(root, k[:-4].lower()))

        def tearDown(self):
            for k, v in self.saved.items():
                setattr(wxa, k, v)
            self.tmp.cleanup()

        def test_asos_csv(self):
            csv = ("station,valid,metar\n"
                   "DCA,2026-08-05 00:52,KDCA 050052Z 04008KT 10SM FEW250 28/17 A3003\n"
                   "DCA,2026-08-05 01:13,KDCA 050113Z 05006KT 10SM RMK AO2, odd remark\n"
                   "DCA,bad-time,KDCA nope\n"
                   "DCA,2026-08-05 01:52,M\n")
            got = parse_asos_csv(csv)
            self.assertEqual(len(got), 2)
            self.assertEqual(got[0][0], 1785891120)  # 2026-08-05 00:52Z
            self.assertIn("odd remark", got[1][1])   # comma survives maxsplit

        def test_obs_merge_no_clobber(self):
            doc = {"date": "2026-08-05", "station": "KDCA",
                   "metars": [[1000, "LIVE"], [2000, "LIVE2"]]}
            added = merge_obs_day(doc, [(1030, "DUPE"), (1000, "DUPE"),
                                        (3000, "NEW")], tol_s=90)
            self.assertEqual(added, 1)
            raws = [m[1] for m in doc["metars"]]
            self.assertEqual(raws, ["LIVE", "LIVE2", "NEW"])
            self.assertEqual(doc["bf"]["n"], 1)

        def test_product_time(self):
            t = product_time("202608061838-KLWX-FXUS61-AFDLWX")
            self.assertEqual(t.isoformat(), "2026-08-06T18:38:00+00:00")
            self.assertIsNone(product_time("garbage"))

        def test_clean_product(self):
            s = clean_product("\x01\r\n847 \r\nFXUS61 KLWX 061838\r\nAFDLWX\r\nBody\x03\n")
            self.assertNotIn("\x01", s)
            self.assertNotIn("\r", s)
            self.assertIn("FXUS61 KLWX 061838", s)
            self.assertTrue(s.endswith("Body\n"))

        def test_taf_merge_dedupe(self):
            doc = {"date": "2026-08-05", "tafs": [
                {"station": "KBWI", "t": 5000, "periods": []}]}   # live decoded
            self.assertEqual(merge_taf_day(doc, "KBWI", 5060, "RAW"), 0)
            self.assertEqual(merge_taf_day(doc, "KDCA", 5060, "RAW"), 1)
            self.assertEqual(merge_taf_day(doc, "KDCA", 5060, "RAW"), 0)
            self.assertEqual([x["station"] for x in doc["tafs"]], ["KBWI", "KDCA"])
            self.assertEqual(doc["tafs"][1].get("bf"), 1)

        def test_afd_skips_existing(self):
            t = product_time("202608061838-KLWX-FXUS61-AFDLWX")
            path = os.path.join(wxa.AFD_DIR, f"{t:%Y}", f"afd-{t:%Y%m%d-%H%M}.json")
            wxa.write_json(path, {"live": True})
            calls = []
            g_json, g_text = globals()["http_json"], globals()["http_text"]
            globals()["http_json"] = lambda u: {"data": [
                {"product_id": "202608061838-KLWX-FXUS61-AFDLWX"}]}
            globals()["http_text"] = lambda u: calls.append(u) or "TEXT"
            try:
                n = backfill_afd(datetime.date(2026, 8, 6),
                                 datetime.date(2026, 8, 6), dry=False)
            finally:
                globals()["http_json"], globals()["http_text"] = g_json, g_text
            self.assertEqual(n, 0)
            self.assertEqual(calls, [])          # text never fetched
            self.assertEqual(wxa.read_json(path, None), {"live": True})

        def test_model_day_doc(self):
            doc = model_day_doc("2026-08-05", "38.9,-76.5", {
                "time": [100, 200], "cape": [512.4, None],
                "convective_inhibition": [-12.6, 0], "precipitation": [0.125, 2]})
            snap = doc["snaps"][0]
            self.assertEqual(snap["n"], 2)
            self.assertEqual(snap["cape"], [512, None])
            self.assertEqual(snap["pr"], [0.12, 2])
            self.assertEqual(snap["bf"], 1)

        def test_index_sees_backfill(self):
            t = product_time("202601021200-KLWX-FXUS61-AFDLWX")
            wxa.write_json(os.path.join(wxa.AFD_DIR, "2026",
                                        "afd-20260102-1200.json"), {"bf": 1})
            wxa.write_json(os.path.join(wxa.OBS_DIR, "2026-01-02.json"),
                           {"date": "2026-01-02", "station": "KDCA",
                            "metars": [[1767330720, "KDCA 021052Z"]]})
            # a file holding no obs is heal_metars' record that nobody
            # reported — bookkeeping, not a day of data, and listing it let a
            # dark station read as healthy
            wxa.write_json(os.path.join(wxa.OBS_DIR, "2026-01-03.json"),
                           {"date": "2026-01-03", "station": "KDCA",
                            "metars": [], "nh": list(range(24))})
            n = wxa.build_index()
            idx = wxa.read_json(os.path.join(wxa.WX, "index.json"), {})
            self.assertEqual(n, 1)
            self.assertEqual(idx["afd"][0]["t"], int(t.timestamp()))
            self.assertEqual(idx["obs_days"], ["2026-01-02"])
            self.assertEqual(len(idx["hours"]["obs"]["h"]), 1)

        def test_missing_hours(self):
            tz = wxa.local_now().tzinfo
            noon = int(datetime.datetime(2026, 8, 20, 12, 52,
                                         tzinfo=tz).timestamp())
            doc = {"metars": [[noon, "RAW"], [noon + 3600, "RAW"]]}
            miss = wxa.missing_hours(doc, "2026-08-20", tz)
            self.assertNotIn(12, miss)
            self.assertNotIn(13, miss)
            self.assertIn(14, miss)
            self.assertEqual(len(miss), 22)

        def test_index_lists_only_stations_with_days(self):
            wxa.write_json(os.path.join(wxa.STATIONS_DIR, "W29",
                                        "2026-01-02.json"),
                           {"date": "2026-01-02", "station": "W29",
                            "metars": [[1, "W29 raw"]]})
            os.makedirs(os.path.join(wxa.STATIONS_DIR, "KXXX"), exist_ok=True)
            wxa.build_index()
            idx = wxa.read_json(os.path.join(wxa.WX, "index.json"), {})
            self.assertEqual(idx["stations"], ["W29"])   # empty KXXX omitted
            self.assertEqual(idx["station_days"]["W29"], ["2026-01-02"])

        def test_heal_fills_and_settles(self):
            """The hourly archiver's IEM catch-up: fills what the NWS API
            never served, never touches a live entry, and stops asking about
            hours the station simply didn't report."""
            tz = wxa.local_now().tzinfo
            day = wxa.local_now().date() - datetime.timedelta(days=1)
            key = f"{day:%Y-%m-%d}"
            at = lambda h, m: int(datetime.datetime(
                day.year, day.month, day.day, h, m, tzinfo=tz).timestamp())
            wxa.write_json(os.path.join(wxa.OBS_DIR, key + ".json"),
                           {"date": key, "station": "KDCA",
                            "metars": [[at(0, 52), "LIVE 00"]]})
            calls = []

            now = wxa.local_now()

            def fake_text(url):
                """Every routine ob for the healed range except hour 05
                yesterday, which nobody observed. Today only as far as now."""
                calls.append(url)
                rows = ["station,valid,metar"]
                for d in (day, now.date()):
                    for h in range(24):
                        if d == day and h == 5:
                            continue
                        t = datetime.datetime(d.year, d.month, d.day, h, 52,
                                              tzinfo=tz)
                        if t > now:
                            continue
                        rows.append(f"DCA,{t.astimezone(UTC):%Y-%m-%d %H:%M},"
                                    f"KDCA IEM {d:%m%d} {h:02d}")
                return "\n".join(rows)

            saved = (wxa.fetch_text, wxa.STATIONS, wxa.FIELD_OBS_STATION,
                     wxa.HEAL_DAYS)
            wxa.fetch_text, wxa.STATIONS = fake_text, []
            wxa.FIELD_OBS_STATION, wxa.HEAL_DAYS = "", 2
            try:
                wxa.heal_metars()
                doc = wxa.read_json(os.path.join(wxa.OBS_DIR, key + ".json"), {})
                # 24 hours − the live 00 already held − the 05 nobody observed
                self.assertEqual(doc["bf"]["n"], 22)
                self.assertEqual(len(doc["metars"]), 23)
                self.assertEqual(doc["metars"][0][1], "LIVE 00")   # not clobbered
                self.assertEqual(doc["nh"], [5])     # settled, not a hole
                calls.clear()
                self.assertEqual(wxa.heal_metars(), 0)
                self.assertEqual(calls, [])          # nothing left to ask for
            finally:
                (wxa.fetch_text, wxa.STATIONS, wxa.FIELD_OBS_STATION,
                 wxa.HEAL_DAYS) = saved

        def test_backfill_settles_part_time_station(self):
            """A field that only reports 06-15 is not an archive with 14 holes
            a day. The hours IEM has no ob for, on a day that is over, are
            recorded as never-reported so the health panel counts real losses
            only."""
            tz = wxa.local_now().tzinfo
            day = wxa.local_now().date() - datetime.timedelta(days=2)
            rows = ["station,valid,metar"]
            for h in range(6, 16):
                t = datetime.datetime(day.year, day.month, day.day, h, 55, tzinfo=tz)
                rows.append(f"APG,{t.astimezone(UTC):%Y-%m-%d %H:%M},KAPG raw {h:02d}")
            saved = globals()["http_text"]
            globals()["http_text"] = lambda u: "\n".join(rows)
            try:
                out = os.path.join(wxa.STATIONS_DIR, "KAPG")
                n = _backfill_metars("KAPG", out, "stations/KAPG", day, day, dry=False)
            finally:
                globals()["http_text"] = saved
            doc = wxa.read_json(os.path.join(out, f"{day:%Y-%m-%d}.json"), {})
            self.assertEqual(n, 10)
            self.assertEqual(doc["nh"], [0, 1, 2, 3, 4, 5, 16, 17, 18, 19, 20, 21, 22, 23])
            self.assertEqual(wxa.missing_hours(doc, f"{day:%Y-%m-%d}", tz),
                             doc["nh"])          # settled, and still visible

        def test_days_between(self):
            got = days_between(datetime.date(2026, 1, 30), datetime.date(2026, 2, 2))
            self.assertEqual(len(got), 4)

        def _taf_run(self, stamps_docs, cap=30):
            """Drive wxa.archive_tafs() against a canned collection.
            stamps_docs: [(iso_utc, doc_key)] — doc_key names which fake XML
            the per-issuance URL serves; decode is stubbed to map it to a
            distinct periods payload. Returns the list of doc_keys fetched."""
            fetched = []
            saved = (wxa.taf_collection, wxa.fetch_text, wxa.decode_taf_xml,
                     wxa.TAF_STATIONS, wxa.TAF_FETCH_CAP)
            wxa.taf_collection = lambda station, on_disk: [
                {"issueTime": iso, "id": key} for iso, key in stamps_docs]
            wxa.fetch_text = lambda url: (fetched.append(url), url)[1]
            wxa.decode_taf_xml = lambda xml: [{"ind": "FM", "doc": xml,
                                              "b": 1, "e": 2}]
            wxa.TAF_STATIONS, wxa.TAF_FETCH_CAP = ["KBWI"], cap
            try:
                added = wxa.archive_tafs()
            finally:
                (wxa.taf_collection, wxa.fetch_text, wxa.decode_taf_xml,
                 wxa.TAF_STATIONS, wxa.TAF_FETCH_CAP) = saved
            return added, fetched

        def test_taf_phantom_stamps_settle_as_dup(self):
            """2026-08-30 in miniature: the collection lists per-minute
            issueTimes that all serve the same document. One issuance is
            archived; the rest settle into "dup" and are never re-fetched."""
            now = wxa.local_now()
            iso = lambda mins: (now - datetime.timedelta(minutes=mins)) \
                .astimezone(datetime.timezone.utc) \
                .strftime("%Y-%m-%dT%H:%M:00+00:00")
            coll = [(iso(300), "docA")] + [(iso(m), "docB")
                                           for m in (90, 60, 45, 30)]
            added, fetched = self._taf_run(coll)
            self.assertEqual(added, 2)               # docA once, docB once
            self.assertEqual(len(fetched), 5)        # each stamp fetched once
            day = f"{now:%Y-%m-%d}"
            doc = wxa.read_json(os.path.join(wxa.TAF_DIR, day + ".json"), {})
            tafs = [x for x in doc.get("tafs", []) if x["station"] == "KBWI"]
            dups = (doc.get("dup") or {}).get("KBWI", [])
            # the same stamps may straddle local midnight into yesterday's file
            prev = wxa.read_json(os.path.join(
                wxa.TAF_DIR, f"{now - datetime.timedelta(days=1):%Y-%m-%d}.json"), {})
            tafs += [x for x in prev.get("tafs", []) if x["station"] == "KBWI"]
            dups += (prev.get("dup") or {}).get("KBWI", [])
            self.assertEqual(len(tafs), 2)
            self.assertEqual(len(dups), 3)
            # a second run over the same frozen collection fetches nothing
            added, fetched = self._taf_run(coll)
            self.assertEqual((added, fetched), (0, []))

        def test_taf_fetch_cap_defers_oldest(self):
            now = wxa.local_now()
            iso = lambda mins: (now - datetime.timedelta(minutes=mins)) \
                .astimezone(datetime.timezone.utc) \
                .strftime("%Y-%m-%dT%H:%M:00+00:00")
            coll = [(iso(m), f"doc{m}") for m in (240, 180, 120, 60)]
            added, fetched = self._taf_run(coll, cap=2)
            self.assertEqual(added, 2)
            self.assertEqual(fetched, ["doc60", "doc120"])   # newest first
            added, fetched = self._taf_run(coll, cap=2)      # next run: the rest
            self.assertEqual(added, 2)
            self.assertEqual(fetched, ["doc180", "doc240"])

        def test_taf_holes_are_unfilled_settled_slots(self):
            tz = wxa.local_now().tzinfo
            day = "2026-08-30"
            # 05:20Z slot filled (issued 05:23Z); 11:20Z, 17:20Z, 23:20Z empty
            doc = {"date": day, "tafs": [
                {"station": "KBWI", "t": 1788067380, "raw": "x"}]}
            now = datetime.datetime(2026, 8, 31, 1, 0, tzinfo=UTC)   # 21:00 EDT 08-30
            holes = wxa.taf_holes(doc, "KBWI", day, tz, now)
            hm = [datetime.datetime.fromtimestamp(s, UTC).strftime("%H:%M") for s in holes]
            self.assertEqual(hm, ["11:20", "17:20"])   # 23:20Z not settled yet
            # a station with nothing on file is short every settled slot
            self.assertEqual(len(wxa.taf_holes(doc, "KDCA", day, tz, now)), 3)

        def test_heal_tafs_fills_from_iem_then_goes_quiet(self):
            day = "2026-08-30"
            path = os.path.join(wxa.TAF_DIR, day + ".json")
            wxa.write_json(path, {"date": day, "tafs": [
                {"station": "KBWI", "t": 1788067380, "raw": "x"}]})
            calls = []
            listing = {"data": [
                {"product_id": "202608301120-KLWX-FTUS41-TAFBWI"},
                {"product_id": "202608301722-KLWX-FTUS41-TAFBWI"},
                {"product_id": "202608300523-KLWX-FTUS41-TAFBWI"},   # already there
            ]}
            saved = (wxa.fetch, wxa.fetch_text, wxa.local_now, wxa.TAF_STATIONS,
                     wxa.HEAL_DAYS)
            wxa.fetch = lambda url, fresh=False: (calls.append(url), listing)[1]
            wxa.fetch_text = lambda url: (calls.append(url), "\x01TAF\nKBWI " + url[-30:] + "\x03")[1]
            wxa.local_now = lambda: datetime.datetime(2026, 8, 31, 1, 0, tzinfo=UTC) \
                .astimezone(self.saved_tz)
            wxa.TAF_STATIONS, wxa.HEAL_DAYS = ["KBWI"], 1
            try:
                healed = wxa.heal_tafs()
                doc = wxa.read_json(path, {})
                self.assertEqual(healed, 2)
                self.assertEqual(len(doc["tafs"]), 3)
                self.assertEqual(doc["bf"]["n"], 2)
                self.assertTrue(all(x.get("bf") for x in doc["tafs"][1:]))
                self.assertEqual(sum("afos/list" in c for c in calls), 1)
                calls.clear()
                self.assertEqual(wxa.heal_tafs(), 0)
                self.assertEqual(calls, [])              # healthy day: no requests
            finally:
                (wxa.fetch, wxa.fetch_text, wxa.local_now, wxa.TAF_STATIONS,
                 wxa.HEAL_DAYS) = saved

    Fixtures.saved_tz = wxa.local_now().tzinfo
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(Fixtures)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    sys.exit(main())
