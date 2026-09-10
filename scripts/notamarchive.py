#!/usr/bin/env python3
"""US NOTAM archive — GitHub Actions edition (stdlib only).

Every active NOTAM in the National Airspace System, pulled once an hour from
the FAA's public NOTAM query services for every location in
data/notam/locations.json (airports, navaids, the ARTCCs, GPS and FDC), kept
as one day-forward archive and reduced to the aggregates notam.html draws.

  python3 scripts/notamarchive.py --out out            # one run (network)
  python3 scripts/notamarchive.py --selftest           # offline checks
  python3 scripts/notamarchive.py --out out --fixture f.json   # offline run

Sources, tried in this order per run (see fetch_batch):
  1. DINS — www.notams.faa.gov/dinsQueryWeb, the Defense Internet NOTAM
     Service: one POST per batch of locations, every NOTAM back in its own
     <pre> block. No key, no paging, the same text a pilot briefs from.
  2. FAA NOTAM Search — notams.aim.faa.gov/notamSearch/search, the JSON
     behind the public search page: 30 records a page, so many more
     requests, but structured (issue time, keyword) — the fallback when
     DINS answers nothing for the first batches.
Neither is a documented API, so a batch is trusted only when it parses, a
run that finds fewer than half of last run's NOTAMs is refused rather than
written (nothing is marked gone on a bad day), and every failure is written
to index.json where the page prints it.

Output (published at the root of the `notam-data` branch by
.github/workflows/notamarchive.yml — one force-pushed commit that carries the
whole tree forward, like wx3d-data, because ~15 MB of current state an hour
has no business in main's history):
  index.json            {v, t, ok, src, note, bootstrap, n:{active, sched,
                         total}, locations:{n, queried, failed:[q]}, runs:[{t,
                         n, new, gone, req, fail, s, src}], days:[{d, new, gone,
                         exp, cxl, active}], states:[ST], day_list:[YYYY-MM-DD]}
  summary.json          the aggregates the page draws first (see summarize())
  current/<ST>.json     {t, st, n, notams:[record]} — every NOTAM in the system
                        right now, one file per state ("--" = ARTCC / national)
  days/YYYY-MM-DD.json  {d, new:[record], gone:{id:[t, why, first_day]}, runs}
                        — UTC day; `new` is every NOTAM first seen that day,
                        `gone` every one that left the system that day
                        (why = "exp" past its end time, "cxl" before it).
                        A day file is written only during its own day.

A record (keys short — there are ~40,000 of them):
  id  "ANP 09/012"  accountability + number, the identity
  a   accountability   n  number      l  location (as written)
  k   keyword (RWY TWY APRON AD OBST NAV COM SVC AIRSPACE ODP SID STAR CHART
      DATA IAP VFP ROUTE SPECIAL SECURITY (U) (O), or "?" )
  c   class: D · FDC · TFR · GPS · INTL
  s/e start/end epoch (e null when PERM)   p 1=PERM   x 1=EST end
  raw the NOTAM text, whitespace collapsed
  f   first seen (run stamp)   i  issued (only when the source says)
  q   the locations.json query id it resolves to (coordinates live there)
  st  state (locations.json, or the ST.. prefix of an FDC airspace NOTAM)
  b   1 on records that were already in the system when the archive began

Times are UTC throughout — NOTAMs are written in UTC and the scope is the
whole country, so archive days are UTC days (unlike data/wx/, which keeps the
field's local day).
"""

import argparse
import datetime
import html as htmllib
import http.cookiejar
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOCATIONS = os.environ.get("NOTAM_LOCATIONS", os.path.join(REPO, "data", "notam", "locations.json"))

DINS_URL = os.environ.get("NOTAM_DINS_URL",
                          "https://www.notams.faa.gov/dinsQueryWeb/queryRetrievalMapAction.do")
DINS_HOME = "https://www.notams.faa.gov/dinsQueryWeb/"
NSEARCH_URL = os.environ.get("NOTAM_NSEARCH_URL", "https://notams.aim.faa.gov/notamSearch/search")
NSEARCH_HOME = "https://notams.aim.faa.gov/notamSearch/nsapp.html"

BATCH = int(os.environ.get("NOTAM_BATCH", "50"))          # locations per request
PAUSE_S = float(os.environ.get("NOTAM_PAUSE_S", "0.7"))   # between requests
TIMEOUT_S = int(os.environ.get("NOTAM_TIMEOUT_S", "60"))
BUDGET_S = int(os.environ.get("NOTAM_BUDGET_S", "1500"))  # stop querying after this
SOURCES = [s for s in os.environ.get("NOTAM_SOURCES", "dins,nsearch").split(",") if s]
# Locations the page's "local" card lists in full. Mirror of the field +
# nearby fields in js/site-config.js (SITE.notam.local) — keep the two in step.
LOCAL = [s for s in os.environ.get(
    "NOTAM_LOCAL", "KANP,KNAK,KESN,KFME,KCGE,KMTN,KBWI,KADW,KDCA,KGAI,W29,KCGS,KAPG,KNHK"
).split(",") if s]
# A run that sees fewer than this share of last run's NOTAMs is not believed.
FLOOR = float(os.environ.get("NOTAM_FLOOR", "0.5"))
UA = "Mozilla/5.0 (compatible; notamarchive/1.0; +https://jesselevine.net)"

KEYWORDS = {"RWY", "TWY", "APRON", "AD", "OBST", "NAV", "COM", "SVC", "AIRSPACE", "ODP",
            "SID", "STAR", "CHART", "DATA", "IAP", "VFP", "ROUTE", "SPECIAL", "SECURITY",
            "(U)", "(O)", "RAMP", "AIRPORT", "SNOWTAM"}
STATES = {"AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID", "IL",
          "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE",
          "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD",
          "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "PR", "VI", "GU", "AS", "MP"}
NOSTATE = "--"   # ARTCC / national / unresolved


def log(msg):
    print(msg, flush=True)


def utc_day(t):
    return datetime.datetime.fromtimestamp(t, datetime.timezone.utc).strftime("%Y-%m-%d")


def write_json(path, obj):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f, separators=(",", ":"))
    os.replace(tmp, path)


def read_json(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return default


# ---------------------------------------------------------------------------
# Locations — data/notam/locations.json, built by scripts/build_notam_locations.py
#   locs: [[q, lid, kind, name, st, lat, lon, artcc, aliases]]
#   q = the id the query service is asked for (KANP, W29, ZDC), lid = the id
#   NOTAM text uses for the same place (ANP, W29, ZDC), aliases = extra query
#   ids worth asking for the same record (KZDC beside ZDC).
# ---------------------------------------------------------------------------

class Universe:
    def __init__(self, doc):
        self.recs = {}      # q -> rec dict
        self.by_lid = {}    # lid -> q
        self.queries = []   # every id to ask for, in order
        for row in (doc or {}).get("locs") or []:
            row = list(row) + [None] * (9 - len(row))
            q, lid, kind, name, st, lat, lon, artcc, aliases = row[:9]
            if not q:
                continue
            rec = {"q": q, "lid": lid or q, "kind": kind or "apt", "name": name or "",
                   "st": st if st in STATES else NOSTATE, "lat": lat, "lon": lon,
                   "artcc": artcc}
            self.recs[q] = rec
            self.by_lid.setdefault(rec["lid"], q)
            self.by_lid.setdefault(q, q)
            self.queries.append(q)
            for a in aliases or []:
                self.queries.append(a)
                self.by_lid.setdefault(a, q)
        self.query_owner = {}   # any query id -> q of the record it serves
        for q in self.queries:
            self.query_owner[q] = self.by_lid.get(q, q)

    def resolve(self, loc):
        """NOTAM location field -> q of the locations.json record, or None."""
        if not loc:
            return None
        for cand in (loc, "K" + loc if len(loc) == 3 else None):
            if cand and cand in self.by_lid:
                return self.by_lid[cand]
        if len(loc) == 4 and loc[0] in "KP" and loc[1:] in self.by_lid:
            return self.by_lid[loc[1:]]
        return None


def load_universe(path=LOCATIONS):
    doc = read_json(path, None)
    if not doc:
        raise SystemExit(f"no locations file at {path} — run scripts/build_notam_locations.py")
    return Universe(doc)


# ---------------------------------------------------------------------------
# Parsing — the US domestic format:  !ACCT NN/NNN LOC KEYWORD text YYMMDDHHMM-YYMMDDHHMM
# FDC NOTAMs put a ST.. prefix on airspace keywords (!FDC 6/1234 ZDC VA..AIRSPACE …)
# and end -PERM when there is no end. Anything that does not start with "!"
# is tried as an ICAO-format NOTAM (A1234/26 NOTAMN Q) … A) … B) … C) … E) …).
# ---------------------------------------------------------------------------

HEAD_RE = re.compile(r"^!\s*([A-Z0-9]{2,4})\s+(\d{1,2}/\d{3,4})\s+([A-Z0-9]{2,5})\s+(.*)$", re.S)
PERIOD_RE = re.compile(r"(\d{10})\s*-\s*(\d{10}|PERM)\s*(EST)?\b")
CREATED_RE = re.compile(r"CREATED:\s*(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s+(\d{2}):(\d{2}):(\d{2})")
ICAO_RE = re.compile(r"^([A-Z]\d{4}/\d{2})\s+NOTAM([NRC])")
MONTHS = {m: i + 1 for i, m in enumerate(
    ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"])}


def stamp10(s):
    """YYMMDDHHMM (UTC) -> epoch, or None."""
    try:
        d = datetime.datetime(2000 + int(s[0:2]), int(s[2:4]), int(s[4:6]),
                              int(s[6:8]), int(s[8:10]), tzinfo=datetime.timezone.utc)
    except ValueError:
        return None
    return int(d.timestamp())


def clean_text(s):
    s = htmllib.unescape(re.sub(r"<[^>]+>", " ", s or ""))
    return re.sub(r"\s+", " ", s).strip()


def parse_created(s):
    m = CREATED_RE.search(s or "")
    if not m:
        return None
    mon = MONTHS.get(m.group(2).upper())
    if not mon:
        return None
    try:
        d = datetime.datetime(int(m.group(3)), mon, int(m.group(1)), int(m.group(4)),
                              int(m.group(5)), int(m.group(6)), tzinfo=datetime.timezone.utc)
    except ValueError:
        return None
    return int(d.timestamp())


def parse_notam(raw):
    """Text -> record fields (without f/q/st), or None when it is not a NOTAM."""
    text = clean_text(raw)
    if not text:
        return None
    if text.startswith("!"):
        m = HEAD_RE.match(text)
        if not m:
            return None
        acct, num, loc, body = m.group(1), m.group(2), m.group(3), m.group(4)
        rec = {"id": f"{acct} {num}", "a": acct, "n": num, "l": loc, "raw": text}
        st_prefix = None
        mk = re.match(r"^([A-Z]{2})\.\.\s*(\S+)", body)
        if mk and mk.group(1) in STATES:
            st_prefix, first = mk.group(1), mk.group(2)
        else:
            first = body.split(" ", 1)[0]
        kw = first.upper().strip(".,")
        rec["k"] = kw if kw in KEYWORDS else "?"
        if st_prefix:
            rec["stp"] = st_prefix
        periods = list(PERIOD_RE.finditer(body))
        if periods:
            pm = periods[-1]
            rec["s"] = stamp10(pm.group(1))
            if pm.group(2) == "PERM":
                rec["e"] = None
                rec["p"] = 1
            else:
                rec["e"] = stamp10(pm.group(2))
            if pm.group(3):
                rec["x"] = 1
        else:
            rec["s"] = None
            rec["e"] = None
            if re.search(r"\bPERM\b", body):
                rec["p"] = 1
        up = text.upper()
        if acct == "FDC":
            rec["c"] = "TFR" if "TEMPORARY FLIGHT RESTRICTION" in up else "FDC"
        elif acct == "GPS" or (rec["k"] == "NAV" and re.match(r"^NAV\s+GPS\b", body)):
            rec["c"] = "GPS"
        else:
            rec["c"] = "D"
        return rec
    m = ICAO_RE.match(text)
    if m:
        rec = {"id": m.group(1), "a": "INTL", "n": m.group(1), "raw": text, "c": "INTL", "k": "?"}
        ma = re.search(r"\bA\)\s*([A-Z0-9]{3,4})", text)
        rec["l"] = ma.group(1) if ma else ""
        mb = re.search(r"\bB\)\s*(\d{10})", text)
        mc = re.search(r"\bC\)\s*(\d{10}|PERM)(\s*EST)?", text)
        rec["s"] = stamp10(mb.group(1)) if mb else None
        if mc and mc.group(1) == "PERM":
            rec["e"], rec["p"] = None, 1
        else:
            rec["e"] = stamp10(mc.group(1)) if mc else None
            if mc and mc.group(2):
                rec["x"] = 1
        mq = re.search(r"\bQ\)\s*([A-Z]{4})/Q([A-Z]{4})", text)
        if mq:
            rec["fir"] = mq.group(1)
            rec["qc"] = mq.group(2)
        return rec
    return None


def parse_dins_html(body):
    """DINS results page -> [(raw_text, created_epoch|None)], one per NOTAM."""
    out = []
    for block in re.findall(r"<pre[^>]*>(.*?)</pre>", body or "", re.S | re.I):
        created = parse_created(block)
        text = re.split(r"CREATED:", block, 1)[0]
        text = clean_text(text)
        if not text:
            continue
        # A block that somehow holds several NOTAMs splits at each new "!".
        parts = re.split(r"\s(?=![A-Z0-9]{2,4}\s+\d{1,2}/\d{3,4}\s)", text)
        for part in parts:
            part = part.strip()
            if part:
                out.append((part, created))
    return out


def echoes_any(body, ids):
    up = (body or "").upper()
    return any(re.search(r"\b" + re.escape(i.upper()) + r"\b", up) for i in ids)


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

class SourceError(Exception):
    pass


_OPENER = None
_PRIMED = set()


def opener():
    global _OPENER
    if _OPENER is None:
        jar = http.cookiejar.CookieJar()
        _OPENER = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    return _OPENER


def prime(url):
    """One GET of the query page so the service's session cookie exists."""
    if url in _PRIMED:
        return
    _PRIMED.add(url)
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        opener().open(req, timeout=TIMEOUT_S).read()
    except Exception as e:  # not fatal — the POST may work without it
        log(f"prime {url}: {e}")


def post_form(url, fields, accept="*/*", referer=None):
    """POST a form; retries network errors and 429/5xx with backoff.
    Returns (status, body_text)."""
    data = urllib.parse.urlencode(fields).encode()
    headers = {"User-Agent": UA, "Accept": accept,
               "Content-Type": "application/x-www-form-urlencoded"}
    if referer:
        headers["Referer"] = referer
    delay = 2
    last = None
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, data=data, headers=headers)
            with opener().open(req, timeout=TIMEOUT_S) as r:
                return r.status, r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            last = f"HTTP {e.code}"
            if e.code < 500 and e.code != 429:
                return e.code, ""
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            last = str(e)
        if attempt < 3:
            time.sleep(delay)
            delay *= 2
    raise SourceError(last or "request failed")


# ---------------------------------------------------------------------------
# Sources — each takes a list of query ids and returns [(raw, issued|None)]
# or raises SourceError. A result is only trusted when it parses; an empty
# page must at least echo one of the ids it was asked about.
# ---------------------------------------------------------------------------

def dins_batch(ids):
    prime(DINS_HOME)
    status, body = post_form(DINS_URL, {
        "reportType": "Raw",
        "retrieveLocId": " ".join(ids),
        "actionType": "notamRetrievalByICAOs",
        "submit": "View NOTAMs",
        "formatType": "DOMESTIC",
    }, accept="text/html,*/*", referer=DINS_HOME)
    if status != 200:
        raise SourceError(f"DINS HTTP {status}")
    items = parse_dins_html(body)
    if not items:
        if re.search(r"error|exception|unavailable|maintenance|invalid", body, re.I) \
                or not echoes_any(body, ids):
            raise SourceError(f"DINS: no NOTAMs parsed; body head: {clean_text(body)[:160]!r}")
    return items


def nsearch_batch(ids, page_cap=60):
    prime(NSEARCH_HOME)
    out = []
    offset = 0
    for _ in range(page_cap):
        status, body = post_form(NSEARCH_URL, {
            "searchType": "0",
            "designatorsForLocation": ",".join(ids),
            "designatorForAccountable": "",
            "latDegrees": "", "latMinutes": "0", "latSeconds": "0",
            "longDegrees": "", "longMinutes": "0", "longSeconds": "0",
            "radius": "10",
            "sortColumns": "5 false",
            "sortDirection": "true",
            "radiusSearchOnDesignator": "false",
            "radiusSearchDesignator": "",
            "latitudeDirection": "N", "longitudeDirection": "W",
            "freeFormText": "", "flightPathText": "", "flightPathDivertAirfields": "",
            "flightPathBuffer": "4", "flightPathIncludeNavaids": "true",
            "flightPathIncludeArtcc": "false", "flightPathIncludeTfr": "true",
            "flightPathIncludeRegulatory": "false", "flightPathResultsType": "All NOTAMs",
            "archiveDate": "", "archiveDesignator": "",
            "offset": str(offset),
            "notamsOnly": "false", "filters": "",
            "minRunwayLength": "", "minRunwayWidth": "", "runwaySurfaceTypes": "",
            "predefinedAbbreviations": "", "savedSearchName": "",
        }, accept="application/json,*/*", referer=NSEARCH_HOME)
        if status != 200:
            raise SourceError(f"NOTAM Search HTTP {status}")
        try:
            doc = json.loads(body)
        except json.JSONDecodeError:
            raise SourceError(f"NOTAM Search: not JSON; head {clean_text(body)[:160]!r}")
        if doc.get("error"):
            raise SourceError(f"NOTAM Search: {str(doc.get('error'))[:200]}")
        items = doc.get("notamList") or []
        for it in items:
            raw = it.get("traditionalMessage") or it.get("icaoMessage") or ""
            issued = None
            m = re.match(r"(\d{2})/(\d{2})/(\d{4})\s+(\d{2})(\d{2})", str(it.get("issueDate") or ""))
            if m:
                try:
                    issued = int(datetime.datetime(int(m.group(3)), int(m.group(1)), int(m.group(2)),
                                                   int(m.group(4)), int(m.group(5)),
                                                   tzinfo=datetime.timezone.utc).timestamp())
                except ValueError:
                    issued = None
            if raw:
                out.append((raw, issued))
        total = doc.get("totalNotamCount")
        end = doc.get("endRecordCount")
        offset += len(items)
        if not items or (isinstance(total, int) and isinstance(end, int) and end >= total):
            break
        time.sleep(PAUSE_S)
    return out


class FixtureSource:
    """Offline stand-in: {"queries": {"KANP": ["!ANP 09/012 …", …]}} — anything
    not listed answers empty. Ids in `fail` raise, like a dead batch."""

    def __init__(self, path):
        doc = read_json(path, {})
        self.queries = doc.get("queries") or {}
        self.fail = set(doc.get("fail") or [])
        self.created = doc.get("created") or {}

    def batch(self, ids):
        if any(i in self.fail for i in ids):
            raise SourceError("fixture: batch marked failing")
        out = []
        for i in ids:
            for raw in self.queries.get(i) or []:
                out.append((raw, self.created.get(raw)))
        return out


def fetch_batch(source, ids):
    if source == "dins":
        return dins_batch(ids)
    if source == "nsearch":
        return nsearch_batch(ids)
    if isinstance(source, FixtureSource):
        return source.batch(ids)
    raise SourceError(f"unknown source {source}")


# ---------------------------------------------------------------------------
# One run: query every location, resolve, diff against the previous state
# ---------------------------------------------------------------------------

def collect(uni, sources, batch_size=BATCH, budget_s=BUDGET_S, pause_s=PAUSE_S, now=None):
    """Ask every query id in batches. Returns (records_by_id, ok_queries,
    stats). A failing batch is retried in halves once, then its ids are left
    unqueried this run (their NOTAMs carry over untouched)."""
    now = now or int(time.time())
    t0 = time.time()
    queries = list(uni.queries)
    recs = {}
    ok_q = set()
    stats = {"req": 0, "fail": 0, "batches": 0, "raw": 0, "unparsed": 0, "src": None,
             "budget_hit": False, "errors": []}
    src_i = 0
    consecutive_fail = 0
    failed = []   # batches to try once more at the end of the run

    def run_batch(ids, depth=0):
        nonlocal src_i, consecutive_fail
        stats["req"] += 1
        src = sources[src_i]
        try:
            items = fetch_batch(src, ids)
        except SourceError as e:
            stats["fail"] += 1
            if len(stats["errors"]) < 12:
                stats["errors"].append(str(e)[:300])
            consecutive_fail += 1
            # The first batches all dying means the source is gone, not the
            # locations: move to the next source for the rest of the run.
            if consecutive_fail >= 3 and ok_q == set() and src_i + 1 < len(sources):
                src_i += 1
                consecutive_fail = 0
                log(f"switching source -> {sources[src_i]}")
                return run_batch(ids, depth)
            if depth == 0 and len(ids) > 8:
                time.sleep(pause_s)
                h = len(ids) // 2
                run_batch(ids[:h], 1)
                time.sleep(pause_s)
                run_batch(ids[h:], 1)
            elif depth < 2:
                failed.append(list(ids))
            return
        consecutive_fail = 0
        stats["src"] = src if isinstance(src, str) else "fixture"
        for raw, issued in items:
            stats["raw"] += 1
            rec = parse_notam(raw)
            if not rec:
                stats["unparsed"] += 1
                continue
            if issued:
                rec["i"] = issued
            prev = recs.get(rec["id"])
            if prev is None or (rec.get("i") and not prev.get("i")):
                recs[rec["id"]] = rec
        ok_q.update(uni.query_owner.get(i, i) for i in ids)

    for b in range(0, len(queries), batch_size):
        if time.time() - t0 > budget_s:
            stats["budget_hit"] = True
            log(f"budget of {budget_s}s reached after {stats['req']} requests")
            break
        ids = queries[b:b + batch_size]
        run_batch(ids)
        stats["batches"] += 1
        time.sleep(pause_s)
    # Second chance for what failed — a transient error heals within the run,
    # and a batch that died before a source switch gets the new source.
    for ids in list(failed):
        if time.time() - t0 > budget_s:
            stats["budget_hit"] = True
            break
        time.sleep(pause_s)
        run_batch(ids, depth=2)
    stats["s"] = round(time.time() - t0, 1)
    stats["fail"] = sum(1 for ids in failed if not (set(uni.query_owner.get(i, i) for i in ids) <= ok_q))
    return recs, ok_q, stats


def attribute(uni, rec):
    """Fill q/st from the locations file (or the FDC ST.. prefix)."""
    q = uni.resolve(rec.get("l")) or uni.resolve(rec.get("a"))
    if q:
        rec["q"] = q
        rec["st"] = uni.recs[q]["st"]
    else:
        rec["st"] = NOSTATE
    if rec.get("stp"):
        rec["st"] = rec.pop("stp")
    return rec


def load_current(out):
    prev = {}
    d = os.path.join(out, "current")
    if os.path.isdir(d):
        for name in sorted(os.listdir(d)):
            if name.endswith(".json"):
                for r in read_json(os.path.join(d, name), {}).get("notams") or []:
                    prev[r["id"]] = r
    return prev


def run(out, uni, sources, now=None, batch_size=BATCH, budget_s=BUDGET_S, pause_s=PAUSE_S):
    now = now or int(time.time())
    os.makedirs(out, exist_ok=True)
    index = read_json(os.path.join(out, "index.json"), {})
    prev = load_current(out)
    bootstrap = not prev and not index.get("bootstrap")

    recs, ok_q, stats = collect(uni, sources, batch_size, budget_s, pause_s, now)
    n_found = len(recs)
    log(f"{n_found} NOTAMs from {stats['req']} requests ({stats['fail']} failed, "
        f"{stats['unparsed']} unparsed) in {stats['s']}s via {stats['src']}")

    # Refuse a run that cannot be right rather than mark half the country gone.
    if prev and n_found < FLOOR * len(prev):
        note = (f"refused: {n_found} NOTAMs found vs {len(prev)} last run "
                f"({stats['fail']} batches failed; {'; '.join(stats['errors'][:3])})")
        log(note)
        index.update({"t": now, "ok": False, "note": note, "v": 1})
        index.setdefault("runs", []).append({"t": now, "n": n_found, "new": 0, "gone": 0,
                                             "req": stats["req"], "fail": stats["fail"],
                                             "s": stats["s"], "src": stats["src"], "ok": False})
        index["runs"] = index["runs"][-96:]
        write_json(os.path.join(out, "index.json"), index)
        return False
    if not recs and not prev:
        note = f"nothing retrieved and nothing archived yet ({'; '.join(stats['errors'][:3])})"
        log(note)
        index.update({"t": now, "ok": False, "note": note, "v": 1})
        write_json(os.path.join(out, "index.json"), index)
        return False

    for rec in recs.values():
        attribute(uni, rec)

    # Carry forward every NOTAM whose location was not queried successfully
    # this run — absence there is a failed batch, not a cancellation.
    full_ok = stats["fail"] == 0 and not stats["budget_hit"]
    current = {}
    for rid, rec in recs.items():
        old = prev.get(rid)
        if old:
            rec["f"] = old.get("f", now)
            if old.get("b"):
                rec["b"] = 1
            if not rec.get("i") and old.get("i"):
                rec["i"] = old["i"]
        else:
            rec["f"] = now
            if bootstrap:
                rec["b"] = 1
        current[rid] = rec
    carried = 0
    gone = {}
    for rid, old in prev.items():
        if rid in current:
            continue
        q = old.get("q")
        queried = (q in ok_q) if q else full_ok
        if queried:
            e = old.get("e")
            why = "exp" if (e and e <= now) else "cxl"
            gone[rid] = (old, why)
        else:
            current[rid] = old
            carried += 1

    new = [r for r in current.values() if r["f"] == now]
    today = utc_day(now)

    # Day file (UTC day) — new records + the day's departures.
    dpath = os.path.join(out, "days", f"{today}.json")
    day = read_json(dpath, {"d": today, "new": [], "gone": {}, "runs": []})
    have = {r["id"] for r in day["new"]}
    day["new"].extend(r for r in new if r["id"] not in have)
    for rid, (old, why) in gone.items():
        day["gone"][rid] = [now, why, utc_day(old.get("f", now))]
    day["runs"].append(now)
    write_json(dpath, day)

    # Current state by state.
    by_st = {}
    for r in current.values():
        by_st.setdefault(r.get("st") or NOSTATE, []).append(r)
    cur_dir = os.path.join(out, "current")
    os.makedirs(cur_dir, exist_ok=True)
    existing = {n[:-5] for n in os.listdir(cur_dir) if n.endswith(".json")}
    for st in existing - set(by_st):
        by_st[st] = []
    for st, rows in by_st.items():
        rows.sort(key=lambda r: (r.get("l") or "", r["id"]))
        write_json(os.path.join(cur_dir, f"{st}.json"), {"t": now, "st": st, "n": len(rows), "notams": rows})

    # Index.
    days = {d["d"]: d for d in index.get("days") or []}
    n_exp = sum(1 for _, w in gone.values() if w == "exp")
    drow = days.setdefault(today, {"d": today, "new": 0, "gone": 0, "exp": 0, "cxl": 0, "active": 0})
    drow["new"] += 0 if bootstrap else len(new)
    drow["gone"] += len(gone)
    drow["exp"] += n_exp
    drow["cxl"] += len(gone) - n_exp
    drow["active"] = len(current)
    active_now = sum(1 for r in current.values() if not r.get("s") or r["s"] <= now)
    failed_q = sorted(q for q in uni.recs if q not in ok_q)
    index.update({
        "v": 1, "t": now, "ok": True, "src": stats["src"],
        "note": ("bootstrap run — every NOTAM in the system today is tagged b" if bootstrap else
                 (f"{stats['fail']} batch(es) failed; {carried} NOTAMs carried over unqueried"
                  if stats["fail"] or carried else "")),
        "bootstrap": index.get("bootstrap") or now,
        "n": {"active": active_now, "sched": len(current) - active_now, "total": len(current)},
        "locations": {"n": len(uni.recs), "queried": len(ok_q & set(uni.recs)),
                      "failed": failed_q[:300], "failed_n": len(failed_q)},
        "days": sorted(days.values(), key=lambda d: d["d"]),
        "states": sorted(by_st),
        "day_list": sorted(n[:-5] for n in os.listdir(os.path.join(out, "days")) if n.endswith(".json")),
        "errors": stats["errors"][:6],
    })
    index.setdefault("runs", []).append({"t": now, "n": len(current), "new": len(new), "gone": len(gone),
                                         "req": stats["req"], "fail": stats["fail"], "s": stats["s"],
                                         "src": stats["src"], "ok": True})
    index["runs"] = index["runs"][-96:]
    write_json(os.path.join(out, "index.json"), index)

    summary = summarize(current, gone, uni, index, now, prev)
    write_json(os.path.join(out, "summary.json"), summary)
    log(f"wrote {len(current)} current ({active_now} in effect), {len(new)} new, {len(gone)} gone "
        f"({n_exp} expired), {carried} carried, {len(by_st)} state files")
    return True


# ---------------------------------------------------------------------------
# Aggregates — everything notam.html draws before a visitor asks for more.
# ---------------------------------------------------------------------------

DAY = 86400
AGE_BINS = [("<1 d", DAY), ("1–7 d", 7 * DAY), ("7–30 d", 30 * DAY), ("30–90 d", 90 * DAY),
            ("90 d–1 y", 365 * DAY), ("1–3 y", 3 * 365 * DAY), (">3 y", None)]
DUR_BINS = [("<1 d", DAY), ("1–7 d", 7 * DAY), ("7–30 d", 30 * DAY), ("30–90 d", 90 * DAY),
            ("90 d–1 y", 365 * DAY), (">1 y", None)]

RWY_CLSD = re.compile(r"\bRWY\s+(?:ALL|[0-9]{1,2}[LRC]?(?:/[0-9]{1,2}[LRC]?)?)\b[^.]*?\bCLSD\b")
TWY_CLSD = re.compile(r"\bTWY\b.*?\bCLSD\b")
AD_CLSD = re.compile(r"\bAD\s+AP\s+CLSD\b|\bAIRPORT\s+CLSD\b")
OBST_UNLIT = re.compile(r"\bOBST\b.*?\b(?:LGTS?\s+(?:OTS|U/S)|UNLGTD|NOT\s+LGTD)")
NAV_OTS = re.compile(r"\bNAV\b.*?\b(?:OTS|U/S|UNUSBL|UNUSABLE)\b")
GPS_BAD = re.compile(r"GPS.*?(?:UNRELIABLE|NOT\s+AVBL|MAY\s+NOT\s+BE\s+AVBL|INTERFERENCE|TESTING)")


def bin_of(v, bins):
    for label, edge in bins:
        if edge is None or v < edge:
            return label
    return bins[-1][0]


def slim(r, maxlen=None):
    """A record for a summary list — the same keys, raw optionally clipped."""
    o = {k: r[k] for k in ("id", "l", "k", "c", "s", "e", "f", "q", "st") if k in r}
    for k in ("p", "x", "b", "i"):
        if r.get(k):
            o[k] = r[k]
    raw = r.get("raw", "")
    o["raw"] = raw if not maxlen or len(raw) <= maxlen else raw[:maxlen - 1] + "…"
    return o


def summarize(current, gone, uni, index, now, prev=None):
    rows = list(current.values())
    active = [r for r in rows if not r.get("s") or r["s"] <= now]
    sched = len(rows) - len(active)
    by_k, by_c, by_st, by_loc = {}, {}, {}, {}
    age, dur, hours = {b[0]: 0 for b in AGE_BINS}, {b[0]: 0 for b in DUR_BINS}, [0] * 24
    dur["PERM"] = 0
    est = perm = exp24 = 0
    counts = {"rwy_clsd": 0, "twy_clsd": 0, "ad_clsd": 0, "obst": 0, "obst_unlit": 0,
              "nav_ots": 0, "ils_ots": 0, "gps": 0, "tfr": 0, "iap": 0, "sec": 0, "com": 0,
              "svc": 0, "airspace": 0, "unverified": 0}
    rwy_by_st, tfr_by_st = {}, {}
    gps_list, tfr_list, rwy_list, ad_list = [], [], [], []
    local_set = set(LOCAL)
    local = []
    for r in active:
        k, c, st = r.get("k", "?"), r.get("c", "D"), r.get("st") or NOSTATE
        up = r.get("raw", "")
        by_k[k] = by_k.get(k, 0) + 1
        by_c[c] = by_c.get(c, 0) + 1
        srow = by_st.setdefault(st, {"n": 0, "fac": set(), "rwy": 0, "tfr": 0})
        srow["n"] += 1
        if r.get("l"):
            srow["fac"].add(r["l"])
            by_loc[r["l"]] = by_loc.get(r["l"], 0) + 1
        if r.get("s"):
            age[bin_of(now - r["s"], AGE_BINS)] += 1
            if now - r["s"] < 7 * DAY:
                hours[datetime.datetime.fromtimestamp(r["s"], datetime.timezone.utc).hour] += 1
        if r.get("p") or (r.get("e") is None and r.get("s")):
            dur["PERM"] += 1
            perm += 1
        elif r.get("s") and r.get("e"):
            dur[bin_of(r["e"] - r["s"], DUR_BINS)] += 1
        if r.get("x"):
            est += 1
        if r.get("e") and now < r["e"] <= now + DAY:
            exp24 += 1
        if c == "TFR":
            counts["tfr"] += 1
            srow["tfr"] += 1
            tfr_by_st[st] = tfr_by_st.get(st, 0) + 1
            tfr_list.append(slim(r))
        elif c == "GPS":
            counts["gps"] += 1
            gps_list.append(slim(r))
        if k == "RWY" and RWY_CLSD.search(up):
            counts["rwy_clsd"] += 1
            srow["rwy"] += 1
            rwy_by_st[st] = rwy_by_st.get(st, 0) + 1
            rwy_list.append(r)
        elif k == "TWY" and TWY_CLSD.search(up):
            counts["twy_clsd"] += 1
        elif k == "AD" and AD_CLSD.search(up):
            counts["ad_clsd"] += 1
            ad_list.append(r)
        elif k == "OBST":
            counts["obst"] += 1
            if OBST_UNLIT.search(up):
                counts["obst_unlit"] += 1
        elif k == "NAV" and c != "GPS" and NAV_OTS.search(up):
            counts["nav_ots"] += 1
            if "ILS" in up or " LOC " in up or "GS " in up:
                counts["ils_ots"] += 1
        elif k in ("IAP", "SID", "STAR", "ODP"):
            counts["iap"] += 1
        elif k == "SECURITY":
            counts["sec"] += 1
        elif k == "COM":
            counts["com"] += 1
        elif k == "SVC":
            counts["svc"] += 1
        elif k == "AIRSPACE":
            counts["airspace"] += 1
        if k == "(U)":
            counts["unverified"] += 1
        if r.get("q") in local_set or r.get("l") in local_set:
            local.append(slim(r))

    for st, srow in by_st.items():
        srow["fac"] = len(srow["fac"])
    fac_top = sorted(by_loc.items(), key=lambda kv: -kv[1])[:40]
    fac_top = [[loc, n, (uni.recs.get(uni.resolve(loc) or "") or {}).get("st", NOSTATE),
                (uni.recs.get(uni.resolve(loc) or "") or {}).get("name", "")] for loc, n in fac_top]

    dated = [r for r in active if r.get("s")]
    oldest = sorted(dated, key=lambda r: r["s"])[:30]
    longest = sorted((r for r in dated if r.get("e")), key=lambda r: -(r["e"] - r["s"]))[:30]
    day_gone = [(rid, old, why) for rid, (old, why) in gone.items()]
    recent_new = sorted((r for r in rows if not r.get("b")), key=lambda r: -r["f"])[:60]
    rwy_list.sort(key=lambda r: -(r.get("f") or 0))
    ad_list.sort(key=lambda r: -(r.get("f") or 0))
    expiring = sorted((r for r in active if r.get("e") and now < r["e"] <= now + DAY),
                      key=lambda r: r["e"])
    new24 = sum(1 for r in rows if r["f"] > now - DAY and not r.get("b"))
    gone24 = exp24g = cxl24g = 0
    for d in index.get("day_list", [])[-2:]:
        pass  # (per-day gone counts are read from index.days by the page)
    for rid, old, why in day_gone:
        gone24 += 1
        if why == "exp":
            exp24g += 1
        else:
            cxl24g += 1
    days = index.get("days") or []
    if days:
        # 24 h as the sum of today's and yesterday's departures is a fair
        # approximation of the last-day rate; the page also draws the days.
        last = days[-2:]
        gone24 = sum(d["gone"] for d in last)
        exp24g = sum(d["exp"] for d in last)
        cxl24g = sum(d["cxl"] for d in last)
    return {
        "v": 1, "t": now, "src": index.get("src"), "ok": index.get("ok", True),
        "note": index.get("note", ""), "bootstrap": index.get("bootstrap"),
        "n": {"total": len(rows), "active": len(active), "sched": sched, "perm": perm, "est": est,
              "exp24": exp24, "new24": new24, "gone24": gone24, "exp24g": exp24g, "cxl24g": cxl24g,
              "locations": len(uni.recs), "queried": index.get("locations", {}).get("queried"),
              "failed": index.get("locations", {}).get("failed_n", 0),
              "facilities": len(by_loc)},
        "counts": counts,
        "by_k": dict(sorted(by_k.items(), key=lambda kv: -kv[1])),
        "by_c": dict(sorted(by_c.items(), key=lambda kv: -kv[1])),
        "by_st": {st: [v["n"], v["fac"], v["rwy"], v["tfr"]] for st, v in sorted(by_st.items())},
        "fac_top": fac_top,
        # every facility with a NOTAM in effect -> count (the map's dots)
        "fac": dict(sorted(by_loc.items())),
        "age": [[b[0], age[b[0]]] for b in AGE_BINS],
        "dur": [[b[0], dur[b[0]]] for b in DUR_BINS] + [["PERM", dur["PERM"]]],
        "start_hour": hours,
        "oldest": [slim(r, 400) for r in oldest],
        "longest": [slim(r, 400) for r in longest],
        "gps": gps_list,
        "tfr": tfr_list,
        "rwy_clsd": {"n": counts["rwy_clsd"], "by_st": rwy_by_st, "recent": [slim(r, 300) for r in rwy_list[:60]]},
        "ad_clsd": {"n": counts["ad_clsd"], "recent": [slim(r, 300) for r in ad_list[:60]]},
        "local": sorted(local, key=lambda r: (r.get("l") or "", r["id"])),
        "local_ids": LOCAL,
        "expiring": [slim(r, 300) for r in expiring[:40]],
        "recent_new": [slim(r, 300) for r in recent_new],
        "recent_gone": [dict(slim(old, 300), t=now, why=why) for rid, old, why in
                        sorted(day_gone, key=lambda x: x[1].get("f") or 0, reverse=True)[:60]],
        "history": days[-120:],
        "runs": (index.get("runs") or [])[-48:],
        "src_note": {"dins": "DINS · www.notams.faa.gov", "nsearch": "FAA NOTAM Search · notams.aim.faa.gov",
                     "fixture": "fixture"}.get(index.get("src") or "", index.get("src") or ""),
    }


# ---------------------------------------------------------------------------
# Self-test — parser, DINS HTML, deltas, aggregates. No network.
# ---------------------------------------------------------------------------

DINS_FIXTURE = """
<html><body><table>
<tr><td><font size=3><b>KANP</b>&nbsp;&nbsp;LEE</font></td></tr>
<tr><td><PRE>!ANP 09/012 ANP RWY 12/30 CLSD 2609011430-2610012359</PRE></td></tr>
<tr><td><PRE>!ANP 08/003 ANP OBST TOWER LGT (ASR 1234567) 385700N0763500W (2.1NM SE ANP) 512FT (480FT AGL)
OUT OF SERVICE 2608151200-2609151200EST
CREATED: 15 Aug 2026 11:58:00</PRE></td></tr>
<tr><td><PRE>!FDC 6/1234 ANP IAP LEE, ANNAPOLIS, MD.
RNAV (GPS) RWY 30, AMDT 1A...
CHART NOTE: CIRCLING NA. 2609011200-PERM</PRE></td></tr>
<tr><td><font size=3><b>ZDC</b></font></td></tr>
<tr><td><pre>!FDC 6/5678 ZDC VA..AIRSPACE RICHMOND, VA..TEMPORARY FLIGHT RESTRICTIONS WI AN AREA DEFINED AS 3NM RADIUS OF 373011N0772841W (RIC080013.5) SFC-2000FT AGL. 2609121600-2609122200</pre></td></tr>
<tr><td><pre>!GPS 09/044 ZDC NAV GPS (SOMETHING GPS 26-14) (INCLUDING WAAS, GBAS, AND ADS-B) MAY NOT BE AVBL WI A 250NM RADIUS CENTERED AT 353000N0760000W (ORF230055) FL400-UNL. 2609121300-2609122359</pre></td></tr>
<tr><td><pre>!DCA 09/024 DCA TWY A CLSD DLY 0300-1000 2609010300-2609301000</pre></td></tr>
<tr><td><pre>A1234/26 NOTAMN Q) KZWY/QWELW/IV/BO/W/000/999/4000N07000W025 A) KZWY B) 2609121200 C) 2609121800 E) WARNING AREA W-105 ACT</pre></td></tr>
</table></body></html>
"""


def selftest():
    import tempfile
    items = parse_dins_html(DINS_FIXTURE)
    assert len(items) == 7, len(items)
    recs = [parse_notam(raw) for raw, _ in items]
    assert all(recs), recs
    r = recs[0]
    assert r["id"] == "ANP 09/012" and r["l"] == "ANP" and r["k"] == "RWY" and r["c"] == "D"
    assert r["s"] == stamp10("2609011430") and r["e"] == stamp10("2610012359") and not r.get("p")
    assert stamp10("2609011430") == int(datetime.datetime(2026, 9, 1, 14, 30,
                                                          tzinfo=datetime.timezone.utc).timestamp())
    r = recs[1]
    assert r["k"] == "OBST" and r.get("x") == 1 and "CREATED" not in r["raw"]
    assert items[1][1] == int(datetime.datetime(2026, 8, 15, 11, 58, tzinfo=datetime.timezone.utc).timestamp())
    r = recs[2]
    assert r["id"] == "FDC 6/1234" and r["k"] == "IAP" and r["c"] == "FDC" and r.get("p") == 1 and r["e"] is None
    r = recs[3]
    assert r["c"] == "TFR" and r["k"] == "AIRSPACE" and r["stp"] == "VA" and r["l"] == "ZDC"
    r = recs[4]
    assert r["c"] == "GPS" and r["a"] == "GPS" and r["k"] == "NAV"
    r = recs[5]
    assert r["s"] == stamp10("2609010300") and r["e"] == stamp10("2609301000"), r
    r = recs[6]
    assert r["c"] == "INTL" and r["id"] == "A1234/26" and r["l"] == "KZWY" and r["fir"] == "KZWY"
    assert parse_notam("<b>hello</b> world") is None
    assert parse_notam("!ANP 09/013 ANP AD AP CLSD 2609011430-2609011800") ["k"] == "AD"
    assert parse_notam("!ANP 09/014 ANP RAMP CLSD 2609011430-2609011800")["k"] == "RAMP"
    assert parse_notam("!ANP 09/015 ANP FOO BAR 2609011430-2609011800")["k"] == "?"
    assert not echoes_any("<html>error page</html>", ["KANP"]) and echoes_any("KANP LEE", ["KANP"])
    assert RWY_CLSD.search("RWY 12/30 CLSD") and RWY_CLSD.search("RWY 04L CLSD EXC TAXI") \
        and not RWY_CLSD.search("RWY 12/30 EDGE LGT OTS")
    assert AD_CLSD.search("AD AP CLSD") and OBST_UNLIT.search("OBST TOWER LGT OTS") \
        and NAV_OTS.search("NAV ILS RWY 30 LOC OTS") and GPS_BAD.search("NAV GPS MAY NOT BE AVBL")

    # Universe + attribution.
    uni = Universe({"locs": [["KANP", "ANP", "apt", "Lee", "MD", 38.94, -76.57, "ZDC"],
                             ["KDCA", "DCA", "apt", "Washington National", "DC", 38.85, -77.04, "ZDC"],
                             ["ZDC", "ZDC", "artcc", "Washington Center", None, 39.1, -77.55, None, ["KZDC"]],
                             ["W29", "W29", "apt", "Bay Bridge", "MD", 38.98, -76.33, "ZDC"]]})
    assert uni.queries == ["KANP", "KDCA", "ZDC", "KZDC", "W29"]
    assert uni.resolve("ANP") == "KANP" and uni.resolve("KANP") == "KANP" and uni.resolve("W29") == "W29"
    assert uni.resolve("ZDC") == "ZDC" and uni.resolve("KZDC") == "ZDC" and uni.resolve("XYZ") is None
    assert uni.query_owner["KZDC"] == "ZDC"
    tfr = attribute(uni, parse_notam(items[3][0]))
    assert tfr["q"] == "ZDC" and tfr["st"] == "VA" and "stp" not in tfr
    d = attribute(uni, parse_notam(items[0][0]))
    assert d["q"] == "KANP" and d["st"] == "MD"
    assert attribute(uni, parse_notam("!XYZ 09/001 XYZ RWY 1 CLSD 2609011430-2609011800"))["st"] == NOSTATE

    # Two runs against a fixture: bootstrap, then one new / one expired / one
    # cancelled / one carried over a failed batch.
    with tempfile.TemporaryDirectory() as tmp:
        raws = [raw for raw, _ in items]
        fx = {"queries": {"KANP": raws[:3], "ZDC": raws[3:6], "KDCA": [raws[5]], "W29": []},
              "created": {raws[1]: 1755259080}}
        fpath = os.path.join(tmp, "fx.json")
        write_json(fpath, fx)
        out = os.path.join(tmp, "out")
        t1 = stamp10("2609121400")
        ok = run(out, uni, [FixtureSource(fpath)], now=t1, batch_size=2, pause_s=0)
        assert ok
        idx = read_json(os.path.join(out, "index.json"), {})
        assert idx["ok"] and idx["bootstrap"] == t1 and idx["n"]["total"] == 6, idx["n"]
        assert idx["n"]["active"] == 5 and idx["n"]["sched"] == 1   # the TFR starts 1600Z
        cur = load_current(out)
        assert len(cur) == 6 and all(r.get("b") == 1 for r in cur.values())
        assert cur["ANP 08/003"]["i"] == 1755259080
        assert set(idx["states"]) == {"MD", "DC", "VA", "--"}, idx["states"]
        day1 = read_json(os.path.join(out, "days", "2026-09-12.json"), {})
        assert len(day1["new"]) == 6 and day1["gone"] == {}
        assert idx["days"][0]["new"] == 0   # bootstrap does not count as issuance
        summ = read_json(os.path.join(out, "summary.json"), {})
        assert summ["counts"]["tfr"] == 0 and summ["counts"]["gps"] == 1   # TFR not yet in effect
        assert summ["counts"]["rwy_clsd"] == 1 and summ["counts"]["obst"] == 1
        assert summ["by_st"]["MD"][0] == 3 and summ["by_st"]["MD"][1] == 1
        assert [f[0] for f in summ["fac_top"][:1]] == ["ANP"] and summ["fac"]["ANP"] == 3
        assert any(x["id"] == "ANP 09/012" for x in summ["local"])

        # Run 2, six hours later: the TWY NOTAM cancelled, a new one at ANP,
        # the OBST NOTAM's batch fails (KDCA/ZDC batch), TFR now in effect.
        t2 = stamp10("2609122000")
        new_raw = "!ANP 09/020 ANP TWY B CLSD 2609121900-2609132359"
        fx2 = {"queries": {"KANP": raws[:3] + [new_raw], "ZDC": raws[3:5], "KDCA": [], "W29": []},
               "fail": ["W29"]}
        write_json(fpath, fx2)
        ok = run(out, uni, [FixtureSource(fpath)], now=t2, batch_size=2, pause_s=0)
        assert ok
        idx = read_json(os.path.join(out, "index.json"), {})
        cur = load_current(out)
        assert "ANP 09/020" in cur and not cur["ANP 09/020"].get("b") and cur["ANP 09/020"]["f"] == t2
        assert "DCA 09/024" not in cur, "cancelled NOTAM should be gone"
        assert cur["ANP 09/012"]["f"] == t1 and cur["ANP 09/012"].get("b") == 1
        day = read_json(os.path.join(out, "days", "2026-09-12.json"), {})
        assert day["gone"]["DCA 09/024"][1] == "cxl" and day["gone"]["DCA 09/024"][2] == "2026-09-12"
        assert len(day["new"]) == 7 and idx["days"][0]["new"] == 1 and idx["days"][0]["gone"] == 1
        assert idx["locations"]["failed"] == ["W29"], idx["locations"]
        assert "1 batch(es) failed" in idx["note"]
        summ = read_json(os.path.join(out, "summary.json"), {})
        assert summ["counts"]["tfr"] == 1 and summ["n"]["new24"] == 1
        assert summ["recent_gone"][0]["id"] == "DCA 09/024" and summ["recent_gone"][0]["why"] == "cxl"
        assert summ["by_st"]["VA"][3] == 1

        # Run 3: a NOTAM past its end time disappears -> "exp"; a run that
        # finds under half of the set is refused and changes nothing.
        t3 = stamp10("2609130100")
        fx3 = {"queries": {"KANP": raws[:3] + [new_raw], "ZDC": [], "KDCA": [], "W29": []}}
        write_json(fpath, fx3)
        assert run(out, uni, [FixtureSource(fpath)], now=t3, batch_size=2, pause_s=0)
        day = read_json(os.path.join(out, "days", "2026-09-13.json"), {})
        assert day["gone"]["GPS 09/044"][1] == "exp", day["gone"]
        assert day["gone"]["FDC 6/5678"][1] == "exp"
        fx4 = {"queries": {"KANP": raws[:1]}}
        write_json(fpath, fx4)
        assert not run(out, uni, [FixtureSource(fpath)], now=t3 + 3600, batch_size=2, pause_s=0)
        after = read_json(os.path.join(out, "index.json"), {})
        assert after["ok"] is False and after["note"].startswith("refused") and after["runs"][-1]["ok"] is False
        assert set(load_current(out)) == {"ANP 09/012", "ANP 08/003", "FDC 6/1234", "ANP 09/020"}
        # And a source that dies on the first batches hands over to the next.
        fx5 = dict(fx3, fail=["KANP", "KDCA", "ZDC", "W29"])
        f5 = os.path.join(tmp, "fx5.json")
        write_json(f5, fx5)
        write_json(fpath, fx3)
        recs2, okq, stats = collect(uni, [FixtureSource(f5), FixtureSource(fpath)], batch_size=1,
                                    pause_s=0, now=t3 + 7200)
        assert stats["src"] == "fixture" and len(recs2) == 4 and stats["fail"] == 0 and stats["req"] == 8, stats
    log("selftest ok")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default="out", help="archive directory (the notam-data checkout)")
    ap.add_argument("--fixture", help="offline source: JSON {queries:{id:[raw…]}} instead of the network")
    ap.add_argument("--locations", default=LOCATIONS)
    ap.add_argument("--now", type=int, help="run stamp (epoch), for tests")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()
    if a.selftest:
        selftest()
        return
    uni = load_universe(a.locations)
    log(f"{len(uni.recs)} locations, {len(uni.queries)} query ids, batches of {BATCH}")
    sources = [FixtureSource(a.fixture)] if a.fixture else list(SOURCES)
    ok = run(a.out, uni, sources, now=a.now)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
