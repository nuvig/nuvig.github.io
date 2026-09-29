#!/usr/bin/env python3
"""AFD study builder — data/wx/afd/ → data/afd.json + data/afd-text.json (stdlib only).

afd.html reads every LWX Area Forecast Discussion the weather archive holds
(one file per issuance, written hourly by scripts/wxarchive.py) as a corpus:
what the office wrote about, how much, how surely, which models it leaned
on, which stories it carried for weeks and which for a night. This script
compiles that once so the page fetches one small document; it runs at the
end of every hourly archive run (wxarchive.yml) beside build_storms.py.

Two outputs
-----------
data/afd.json       every aggregate the page draws (~300 KB)
data/afd-text.json  the corpus itself — one entry per issuance with the
                    section texts — fetched only when a visitor searches
                    (a few MB; the page says the size before loading it)

How the text is read
--------------------
An AFD is `.SECTION.../&&` blocks under a WMO header and a `$$` signature
block (`DISCUSSION...ABC/DEF`). Sections are keyed: chg (WHAT HAS CHANGED),
key (KEY MESSAGES), disc, avn, mar, tide, clim, fire, wwa (watches/warnings).
Word counts are whitespace tokens of the section body. Every rate below is
per 1,000 words of the issuance's prose (chg + key + disc + avn + mar +
tide + clim + fire), so a short evening update and a long morning package
compare.

Lexicons (edit these, not the consumers):
  THEMES   weather topics — mention count per issuance → the theme strip
  MODELS   model / guidance names
  FEATURES synoptic features (mirrors build_storms.py DRIVERS)
  HEDGES   hedging phrases — the hedge index is hedges per 1,000 words
  PLACES   place names LWX uses for its own area
Phrases are matched case-insensitively on word boundaries; a phrase list is
counted once per occurrence of any member (an issuance saying "hurricane"
twice and "tropical storm" once scores 3 for tropical).

Key-message threads: consecutive issuances restate the same key message
with edits, so each message is matched to the open thread whose last
version shares ≥ THREAD_SIM of its content words (Jaccard); an unmatched
message opens a thread, and a thread with no match for THREAD_GAP
issuances closes. A thread's `hours` is last issuance − first; `versions`
counts distinct wordings. These are the stories LWX chose to lead with and
how long each lasted.

Watches/warnings: the `.LWX WATCHES/WARNINGS/ADVISORIES...` block is parsed
for product names (`<Name> Advisory|Warning|Watch|Statement`); each is
recorded per issuance and rolled up to the days it was named on.

Signatures: the `$$` block lists who signed each section. Style rows are
computed only over issuances a set of initials signed the DISCUSSION alone,
so a co-signed package attributes nothing to anyone.

Output shape (data/afd.json)
----------------------------
  built, archive_updated, first, last, n, words
  iss     [[t, words, hedge, key_n, sig, wwa_n] …] per issuance (t epoch)
  days    {ymd: {n, w, h, themes: {id: n}, feats: {…}, models: {…}, wwa: [...],
                 avn: {vfr,mvfr,ifr,lifr,fog}, sec: {chg,key,disc,avn,mar,tide,clim}}}
  themes  [{id, label, total}]      models, feats, places, hedges: [[term, n] …]
  weeks   [{ymd (Monday), n, w, models: {…}, feats: {…}, conf: {hi, lo}}]
  threads [{first, last, hours, n, versions, text, last_text}] longest first
  wwa     [{name, days, first, last}]
  sigs    [{sig, n, disc_n, disc_w, hedge, sent, models}]
  hours   [24] issuances by local issuance hour
  slots   {slot: {n, w}}          overnight / morning / afternoon / evening
  temps   {month: {decade: n}}    "upper 80s"-style decade phrases
  terms   {month: [[term, n, share] …]} words concentrated in that month
  longest, shortest  [t, words, path]
  rain    {wet: {n, h, w}, dry: {n, h, w}}  hedge/words on the day before a
          wet day vs a dry one, from data/storms.json when present
"""
import json
import os
import re
import sys
import time
from collections import Counter, defaultdict
from datetime import datetime, timezone, timedelta
from zoneinfo import ZoneInfo

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WX = os.path.join(ROOT, "data", "wx")
AFD_DIR = os.path.join(WX, "afd")
OUT = os.path.join(ROOT, "data", "afd.json")
OUT_TEXT = os.path.join(ROOT, "data", "afd-text.json")
STORMS = os.path.join(ROOT, "data", "storms.json")
TZ = ZoneInfo("America/New_York")

THREAD_SIM = 0.4
THREAD_GAP = 2

THEMES = [
    ("heat", "heat", ["heat", "hot", "heat index", "humid", "humidity", "oppressive", "sweltering", "90s", "100", "triple digits"]),
    ("storms", "thunderstorms", ["thunderstorm", "thunderstorms", "storms", "severe", "damaging wind", "hail", "tornado", "cape", "shear", "convection", "convective", "downburst", "microburst"]),
    ("flood", "rain & flooding", ["flood", "flooding", "flash flood", "heavy rain", "downpour", "downpours", "rainfall", "qpf", "inches of rain"]),
    ("fog", "fog & low clouds", ["fog", "stratus", "low clouds", "low cloud", "drizzle", "mist"]),
    ("wind", "wind", ["gusty", "gusts", "wind advisory", "windy", "breezy", "gale"]),
    ("tropical", "tropical", ["tropical", "hurricane", "remnants", "remnant", "nhc", "tropical storm"]),
    ("coastal", "coastal & tidal", ["nor'easter", "noreaster", "coastal low", "coastal flood", "coastal flooding", "tidal", "tide", "tides", "storm surge", "surge"]),
    ("cool", "cool & frost", ["frost", "freeze", "chilly", "cool", "cooler", "below normal", "cold"]),
    ("dry", "dry & fire", ["dry", "drought", "fire weather", "red flag", "relative humidity", "abnormally dry", "rain-free", "dry weather"]),
    ("smoke", "smoke & haze", ["smoke", "wildfire", "wildfires", "haze", "hazy", "air quality"]),
    ("quiet", "quiet weather", ["quiet", "tranquil", "benign", "pleasant", "uneventful", "high pressure", "ridge", "ridging"]),
]

MODELS = [
    ("GFS", ["gfs"]), ("NAM", ["nam", "nam nest", "nam3km"]), ("ECMWF", ["ecmwf", "euro", "ec "]),
    ("HRRR", ["hrrr"]), ("HREF", ["href"]), ("NBM", ["nbm", "national blend"]), ("GEFS", ["gefs"]),
    ("EPS / ENS", ["eps", "ens", "ecmwf ensemble"]), ("RAP", ["rap"]), ("CAMs", ["cam", "cams", "convection allowing", "convection-allowing"]),
    ("SREF", ["sref"]), ("UKMET", ["ukmet", "ukmo", "uk met"]), ("Canadian", ["gdps", "cmc", "rdps", "gem"]),
    ("ICON", ["icon"]), ("MOS", ["mos", "mav", "mex"]), ("ensembles", ["ensemble", "ensembles", "ensemble member", "ensemble members"]),
    ("guidance", ["guidance"]), ("deterministic", ["deterministic"]), ("WPC", ["wpc"]), ("SPC", ["spc"]),
]

FEATURES = [
    ("cold front", ["cold front", "cold frontal"]), ("warm front", ["warm front", "warm frontal"]),
    ("stalled front", ["stalled front", "stationary front", "stalled boundary", "stationary boundary", "quasi-stationary"]),
    ("backdoor front", ["backdoor", "back door"]), ("trough", ["trough", "troughing"]), ("ridge", ["ridge", "ridging"]),
    ("shortwave", ["shortwave", "short wave", "vort max", "vorticity max"]), ("upper low", ["upper low", "upper-level low", "upper level low", "cutoff low", "cut-off low", "closed low"]),
    ("surface low", ["surface low", "area of low pressure", "low pressure system", "low pressure"]), ("high pressure", ["high pressure", "surface high"]),
    ("coastal low", ["coastal low", "coastal storm", "coastal system"]), ("nor'easter", ["nor'easter", "noreaster"]),
    ("tropical system", ["tropical storm", "hurricane", "tropical cyclone", "tropical system", "remnants of"]),
    ("bay breeze", ["sea breeze", "bay breeze"]), ("jet", ["jet", "jet streak", "jet stream"]), ("inversion", ["inversion"]),
    ("outflow", ["outflow", "outflow boundary"]), ("dry line", ["dry line", "dryline"]), ("omega block", ["omega block", "blocking", "rex block"]),
]

HEDGES = [
    "uncertain", "uncertainty", "uncertainties", "confidence", "could", "may", "might", "possible", "possibly",
    "can't be ruled out", "cannot be ruled out", "can not be ruled out", "not out of the question",
    "chance", "chances", "potential", "potentially", "unclear", "questionable", "if", "depending",
    "some question", "remains to be seen", "hard to say", "difficult", "low confidence",
]
CONF_HI = ["high confidence", "confidence is high", "confidence remains high", "good confidence", "confident", "increasing confidence", "confidence has increased", "confidence increases"]
CONF_LO = ["low confidence", "confidence is low", "confidence remains low", "confidence decreases", "confidence is lower", "lower confidence", "decreasing confidence", "less confidence", "little confidence"]

PLACES = [
    ("Annapolis", ["annapolis"]), ("Chesapeake Bay", ["chesapeake", "the bay"]), ("Baltimore", ["baltimore"]),
    ("Washington / DC", ["washington", " dc "]), ("I-95", ["i-95", "i95"]), ("Blue Ridge", ["blue ridge"]),
    ("Alleghenies", ["allegheny", "alleghenies", "allegheny front"]), ("Shenandoah Valley", ["shenandoah"]),
    ("Potomac", ["potomac"]), ("Eastern Shore", ["eastern shore"]), ("Northern Neck", ["northern neck"]),
    ("Piedmont", ["piedmont"]), ("Panhandle", ["panhandle"]), ("mountains", ["mountains", "mountain"]),
    ("metro", ["metro", "metros", "beltway"]), ("Southern Maryland", ["southern maryland", "southern md"]),
    ("Delmarva", ["delmarva"]), ("Mason-Dixon", ["mason-dixon", "mason dixon"]), ("Cumberland", ["cumberland"]),
    ("Fredericksburg", ["fredericksburg"]), ("Charlottesville", ["charlottesville"]), ("Winchester", ["winchester"]),
    ("Hagerstown", ["hagerstown"]), ("Frederick", ["frederick"]), ("Dahlgren", ["dahlgren"]), ("Alexandria", ["alexandria"]),
    ("Havre de Grace", ["havre de grace"]), ("St. Inigoes", ["st. inigoes", "st inigoes"]), ("Tidewater", ["tidewater"]),
    ("Appalachians", ["appalachian", "appalachians"]), ("Ohio Valley", ["ohio valley"]), ("Great Lakes", ["great lakes"]),
    ("Gulf", ["gulf of mexico", "gulf coast", "the gulf"]), ("Mid-Atlantic", ["mid atlantic", "mid-atlantic"]),
]

TAF_SITES = ["BWI", "DCA", "IAD", "MTN", "MRB", "CHO"]
CATS = [("vfr", r"\bvfr\b"), ("mvfr", r"\bmvfr\b"), ("ifr", r"(?<![a-z])ifr\b"), ("lifr", r"\blifr\b")]

STOP = set("""a about above across after again against ahead all along already also although am among an and another any
are area areas around as at away back be because been before behind being below between beyond both but by can
could day days did do does doing down due during each early either else end even ever every far few for from
further get gets go goes going had has have having he her here him his how however i if in into is it its
just keep later least less like likely little long look low made make many may me mean might more most much
must my near need next no nor not now of off on once one only onto or other our out over own per rather
remain remains same see seen set she should since so some still such than that the their them then there
these they this those though through throughout time to today tomorrow tonight too toward under until up upon
us very was we well were what when where whether which while who will with within would yet you your
morning afternoon evening night overnight late mid weekend week monday tuesday wednesday thursday friday
saturday sunday mon tue wed thu fri sat sun am pm est edt z expected expect forecast period areas
temperatures temperature highs lows high mostly partly across area much increase decrease continue continues
conditions possible chance pressure system front weather region regions northern southern eastern western
central along west east north south northwest northeast southwest southeast winds wind sky skies cloudy
clouds rain showers upper lower mid middle 70s 80s 90s 60s 50s 40s degrees f
km hpa mb kt knots mph ft feet january february march april may june july august september october november
december message messages key""".split())

SEC_RE = re.compile(r"^\.([A-Z][A-Z /&'\-]*?)(?:\s*/[^/\n]*/)?\.\.\.\s*$", re.M)
SEC_KEY = {
    "WHAT HAS CHANGED": "chg", "KEY MESSAGES": "key", "DISCUSSION": "disc", "AVIATION": "avn",
    "MARINE": "mar", "TIDES/COASTAL FLOODING": "tide", "COASTAL FLOODING": "tide", "CLIMATE": "clim",
    "FIRE WEATHER": "fire", "LWX WATCHES/WARNINGS/ADVISORIES": "wwa",
}
PROSE = ["chg", "key", "disc", "avn", "mar", "tide", "clim", "fire"]
METRIC = ["chg", "key", "disc", "avn", "mar", "tide", "fire"]   # the climate section lists record tables, not forecasting
WWA_RE = re.compile(r"\b((?:[A-Z][a-z']+ ){1,4}(?:Advisory|Warning|Watch|Statement))\b")
KEY_RE = re.compile(r"^\s*-\s*(?:\(?\d+\)\s*)?(.+?)(?=^\s*-\s|\Z)", re.M | re.S)
SIG_RE = re.compile(r"^([A-Z/ ]+?)\.\.\.([A-Z]{2,4}(?:/[A-Z]{2,4})*)\s*$", re.M)
TEMP_RE = re.compile(r"\b(?:upper|mid|middle|lower|low|near|around)\s+(\d)0s\b|\b(\d)0s\b|\b(?:near|around|approach(?:ing)?|reach(?:ing)?|top(?:ping)? out (?:near|around))\s+(\d)0\b(?!s)|\bnear\s+(100)\b|\b(triple digits)\b", re.I)
WORD_RE = re.compile(r"[a-z][a-z'\-]+")


def load(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def phrase_re(phrases):
    parts = []
    for p in phrases:
        p = p.strip()
        pre = r"(?<![a-z0-9'])" if p[0].isalnum() else ""
        suf = r"(?![a-z0-9])" if p[-1].isalnum() else ""
        parts.append(pre + re.escape(p) + suf)
    return re.compile("|".join(parts), re.I)


THEME_RE = [(i, phrase_re(p)) for i, _l, p in THEMES]
MODEL_RE = [(n, phrase_re(p)) for n, p in MODELS]
FEAT_RE = [(n, phrase_re(p)) for n, p in FEATURES]
PLACE_RE = [(n, phrase_re(p)) for n, p in PLACES]
HEDGE_RE = [(h, phrase_re([h])) for h in HEDGES]
CONF_HI_RE = phrase_re(CONF_HI)
CONF_LO_RE = phrase_re(CONF_LO)
CAT_RE = [(k, re.compile(r, re.I)) for k, r in CATS]
FOG_RE = phrase_re(["fog", "stratus"])


def sections(text):
    """Split an AFD's productText into {key: body}. Unknown headers keep their name."""
    out = {}
    heads = list(SEC_RE.finditer(text))
    for i, m in enumerate(heads):
        name = m.group(1).strip()
        key = SEC_KEY.get(name)
        if key is None:
            for k, v in SEC_KEY.items():
                if name.startswith(k.split("/")[0]) and k in ("AVIATION", "MARINE"):
                    key = v
            if key is None:
                key = name.lower()
        end = heads[i + 1].start() if i + 1 < len(heads) else len(text)
        body = text[m.end():end]
        body = body.split("\n&&")[0].split("\n$$")[0].strip()
        # AFDs are hard-wrapped at ~66 columns: "sea\nbreeze" is one phrase.
        # Unwrap lines inside a paragraph; a blank line stays a paragraph break.
        body = re.sub(r"[ \t]+\n", "\n", body)
        body = re.sub(r"(?<!\n)\n(?![ \t]*\n)(?![ \t]*-\s)[ \t]*", " ", body)
        body = re.sub(r"[ \t]{2,}", " ", body)
        out[key] = body
    return out


def signatures(text):
    tail = text.split("$$")[-1] if "$$" in text else ""
    return {sec.strip().lower(): sig for sec, sig in SIG_RE.findall(tail)}


def key_messages(body):
    msgs = [re.sub(r"\s+", " ", m).strip() for m in KEY_RE.findall(body or "")]
    return [m for m in msgs if len(m) > 12]


def content_words(s):
    return {w for w in WORD_RE.findall(s.lower()) if w not in STOP and len(w) > 2}


def jaccard(a, b):
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def sentences(s):
    return [x for x in re.split(r"(?<=[.!?])\s+(?=[A-Z])", s.strip()) if len(x.split()) >= 3]


def count_all(rx_list, text):
    out = {}
    for name, rx in rx_list:
        n = len(rx.findall(text))
        if n:
            out[name] = n
    return out


def slot_of(hour):
    return "overnight" if hour < 6 else "morning" if hour < 12 else "afternoon" if hour < 18 else "evening"


def analyze(rec, path):
    text = rec.get("productText") or ""
    t_iso = rec.get("issuanceTime")
    t = int(datetime.fromisoformat(t_iso.replace("Z", "+00:00")).timestamp())
    local = datetime.fromtimestamp(t, TZ)
    sec = sections(text)
    prose = "\n".join(sec.get(k, "") for k in METRIC)
    low = " " + prose.lower() + " "
    words = len(prose.split())
    sec_w = {k: len(sec[k].split()) for k in sec if k in PROSE}
    hedges = count_all(HEDGE_RE, low)
    hedge_n = sum(hedges.values())
    sents = sentences(prose)
    avn = sec.get("avn", "").lower()
    cats = {k: len(rx.findall(avn)) for k, rx in CAT_RE}
    cats["fog"] = len(FOG_RE.findall(avn))
    tafs = {s: len(re.findall(r"\bK?" + s + r"\b", sec.get("avn", ""))) for s in TAF_SITES}
    wwa = sorted(set(WWA_RE.findall(sec.get("wwa", ""))))
    kms = key_messages(sec.get("key"))
    sig = signatures(text)
    temps = Counter()
    for m in TEMP_RE.finditer(sec.get("disc", "")):
        d = m.group(1) or m.group(2) or m.group(3)
        temps[d + "0s" if d else "100"] += 1
    return {
        "t": t, "ymd": local.strftime("%Y-%m-%d"), "hour": local.hour, "slot": slot_of(local.hour),
        "path": path, "words": words, "sec_w": sec_w, "hedges": hedges, "hedge_n": hedge_n,
        "hedge_k": round(hedge_n * 1000 / words, 1) if words else 0,
        "conf_hi": len(CONF_HI_RE.findall(low)), "conf_lo": len(CONF_LO_RE.findall(low)),
        "sent_n": len(sents), "sent_len": round(sum(len(s.split()) for s in sents) / len(sents), 1) if sents else 0,
        "themes": count_all(THEME_RE, low), "models": count_all(MODEL_RE, low),
        "feats": count_all(FEAT_RE, low), "places": count_all(PLACE_RE, low),  # low excludes the climate section
        "cats": cats, "tafs": tafs, "wwa": wwa, "kms": kms, "sig": sig, "temps": dict(temps),
        "sec": sec,
    }


def threads_of(issuances):
    """Chain key messages across issuances into stories (see docstring)."""
    open_t, closed = [], []
    for iss in issuances:
        used = set()
        for msg in iss["kms"]:
            cw = content_words(msg)
            best, bs = None, 0
            for th in open_t:
                if id(th) in used:
                    continue
                s = jaccard(cw, th["cw"])
                if s > bs:
                    best, bs = th, s
            if best is not None and bs >= THREAD_SIM:
                used.add(id(best))
                best["last"] = iss["t"]
                best["n"] += 1
                best["miss"] = 0
                if msg != best["texts"][-1]:
                    best["texts"].append(msg)
                best["cw"] = cw
            else:
                th = {"first": iss["t"], "last": iss["t"], "n": 1, "miss": 0, "texts": [msg], "cw": cw}
                open_t.append(th)
                used.add(id(th))
        still = []
        for th in open_t:
            if id(th) in used:
                still.append(th)
            else:
                th["miss"] += 1
                (still if th["miss"] < THREAD_GAP else closed).append(th)
        open_t = still
    closed += open_t
    out = []
    for th in closed:
        out.append({
            "first": th["first"], "last": th["last"], "hours": round((th["last"] - th["first"]) / 3600),
            "n": th["n"], "versions": len(th["texts"]), "text": th["texts"][0], "last_text": th["texts"][-1],
            "themes": count_all(THEME_RE, " " + " ".join(th["texts"]).lower() + " "),
        })
    out.sort(key=lambda x: (-x["hours"], -x["n"]))
    return out


def month_terms(issuances):
    """Words and bigrams concentrated in one month: share of the term's corpus
    count that fell in that month, times the count (so a rare word said twice
    doesn't win). Ranked per month, top 15."""
    per = defaultdict(Counter)
    total = Counter()
    for iss in issuances:
        raw = WORD_RE.findall(iss["sec"].get("disc", "").lower())
        keep = [w not in STOP and len(w) > 2 for w in raw]
        grams = Counter(w for w, k in zip(raw, keep) if k)
        grams.update(f"{a} {b}" for a, b, ka, kb in zip(raw, raw[1:], keep, keep[1:]) if ka and kb)
        per[iss["ymd"][:7]].update(grams)
        total.update(grams)
    months = {}
    for m, c in sorted(per.items()):
        rows = []
        for term, n in c.items():
            if n < 6:
                continue
            share = n / total[term]
            if share < 0.5:
                continue
            rows.append((term, n, round(share, 2), n * share * share))
        rows.sort(key=lambda r: -r[3])
        # drop a unigram the listed bigrams already carry (heat index → index)
        bigrams = [(t, n) for t, n, _s, _ in rows[:60] if " " in t]
        seen = []
        for term, n, share, _ in rows:
            if " " not in term and any(term in b.split() and bn >= 0.6 * n for b, bn in bigrams):
                continue
            if " " in term and any(term.split()[-1] in b.split() and term != b and len(b) > len(term) for b, _bn in bigrams[:20]) and term.split()[0] in ("message",):
                continue
            seen.append(term)
            if len(seen) >= 15:
                break
        months[m] = [[t, c[t], round(c[t] / total[t], 2)] for t in seen]
    return months


def build(afd_dir=AFD_DIR, storms_path=STORMS, index_path=os.path.join(WX, "index.json")):
    paths = []
    for root, _dirs, files in os.walk(afd_dir):
        for fn in files:
            if fn.startswith("afd-") and fn.endswith(".json"):
                paths.append(os.path.join(root, fn))
    issuances = []
    for p in sorted(paths):
        rec = load(p)
        if not rec or not rec.get("productText") or not rec.get("issuanceTime"):
            continue
        rel = os.path.relpath(p, WX).replace(os.sep, "/")
        try:
            issuances.append(analyze(rec, rel))
        except Exception as e:  # one bad file never sinks the build
            print(f"skip {rel}: {e}", file=sys.stderr)
    issuances.sort(key=lambda x: x["t"])
    # dedupe identical issuance times
    seen, uniq = set(), []
    for iss in issuances:
        if iss["t"] in seen:
            continue
        seen.add(iss["t"])
        uniq.append(iss)
    issuances = uniq
    if not issuances:
        raise SystemExit("no AFDs found")

    days = {}
    weeks = {}
    themes_tot, models_tot, feats_tot, places_tot, hedges_tot = Counter(), Counter(), Counter(), Counter(), Counter()
    wwa_days = defaultdict(set)
    hours = [0] * 24
    slots = defaultdict(lambda: {"n": 0, "w": 0})
    temps = defaultdict(Counter)
    sig_rows = defaultdict(lambda: {"n": 0, "disc_n": 0, "disc_w": 0, "hedge": 0, "words": 0, "sent": 0.0, "models": Counter()})
    for iss in issuances:
        d = days.setdefault(iss["ymd"], {"n": 0, "w": 0, "h": 0, "themes": Counter(), "feats": Counter(), "models": Counter(),
                                         "wwa": set(), "avn": Counter(), "sec": Counter(), "hi": 0, "lo": 0})
        d["n"] += 1
        d["w"] += iss["words"]
        d["h"] += iss["hedge_n"]
        d["hi"] += iss["conf_hi"]
        d["lo"] += iss["conf_lo"]
        d["themes"].update(iss["themes"])
        d["feats"].update(iss["feats"])
        d["models"].update(iss["models"])
        d["wwa"].update(iss["wwa"])
        d["avn"].update(iss["cats"])
        d["sec"].update(iss["sec_w"])
        mon = datetime.strptime(iss["ymd"], "%Y-%m-%d")
        wk = (mon - timedelta(days=mon.weekday())).strftime("%Y-%m-%d")
        w = weeks.setdefault(wk, {"ymd": wk, "n": 0, "w": 0, "h": 0, "models": Counter(), "feats": Counter(), "conf": {"hi": 0, "lo": 0}, "tafs": Counter()})
        w["n"] += 1
        w["w"] += iss["words"]
        w["h"] += iss["hedge_n"]
        w["models"].update(iss["models"])
        w["feats"].update(iss["feats"])
        w["conf"]["hi"] += iss["conf_hi"]
        w["conf"]["lo"] += iss["conf_lo"]
        w["tafs"].update(iss["tafs"])
        themes_tot.update(iss["themes"])
        models_tot.update(iss["models"])
        feats_tot.update(iss["feats"])
        places_tot.update(iss["places"])
        hedges_tot.update(iss["hedges"])
        for name in iss["wwa"]:
            wwa_days[name].add(iss["ymd"])
        hours[iss["hour"]] += 1
        slots[iss["slot"]]["n"] += 1
        slots[iss["slot"]]["w"] += iss["words"]
        temps[iss["ymd"][:7]].update(iss["temps"])
        signed = set()
        for sec, sig in iss["sig"].items():
            for person in sig.split("/"):
                if person not in signed:
                    signed.add(person)
                    sig_rows[person]["n"] += 1
            if sec == "discussion" and "/" not in sig and iss["sec_w"].get("disc"):
                row = sig_rows[sig]
                if True:
                    row["disc_n"] += 1
                    row["disc_w"] += iss["sec_w"]["disc"]
                    dl = " " + iss["sec"]["disc"].lower() + " "
                    row["hedge"] += sum(len(rx.findall(dl)) for _h, rx in HEDGE_RE)
                    row["words"] += iss["sec_w"]["disc"]
                    ss = sentences(iss["sec"]["disc"])
                    row["sent"] += sum(len(s.split()) for s in ss) / len(ss) if ss else 0
                    row["models"].update(count_all(MODEL_RE, dl))

    days_out = {}
    for ymd, d in days.items():
        days_out[ymd] = {
            "n": d["n"], "w": d["w"], "h": round(d["h"] * 1000 / d["w"], 1) if d["w"] else 0,
            "hi": d["hi"], "lo": d["lo"],
            "themes": dict(d["themes"]), "feats": dict(d["feats"]), "models": dict(d["models"]),
            "wwa": sorted(d["wwa"]), "avn": dict(d["avn"]), "sec": dict(d["sec"]),
        }
    weeks_out = []
    for wk in sorted(weeks):
        w = weeks[wk]
        weeks_out.append({"ymd": wk, "n": w["n"], "w": w["w"], "h": round(w["h"] * 1000 / w["w"], 1) if w["w"] else 0,
                          "models": dict(w["models"]), "feats": dict(w["feats"]), "conf": w["conf"], "tafs": dict(w["tafs"])})
    sigs = []
    for sig, r in sig_rows.items():
        if r["n"] < 3:
            continue
        row = {"sig": sig, "n": r["n"], "disc_n": r["disc_n"]}
        if r["disc_n"]:
            row["disc_w"] = round(r["disc_w"] / r["disc_n"])
            row["hedge"] = round(r["hedge"] * 1000 / r["words"], 1) if r["words"] else 0
            row["sent"] = round(r["sent"] / r["disc_n"], 1)
            row["models"] = [[m, n] for m, n in r["models"].most_common(4)]
        sigs.append(row)
    sigs.sort(key=lambda s: -s["n"])
    wwa_out = sorted(
        [{"name": n, "days": len(ds), "first": min(ds), "last": max(ds)} for n, ds in wwa_days.items()],
        key=lambda x: -x["days"])

    rain = None
    storms = load(storms_path)
    if storms and storms.get("days"):
        wet = {row[0]: (row[1] or 0) >= 0.01 for row in storms["days"]}
        acc = {"wet": {"n": 0, "h": 0.0, "w": 0}, "dry": {"n": 0, "h": 0.0, "w": 0}}
        for ymd, d in days_out.items():
            nxt = (datetime.strptime(ymd, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d")
            if nxt not in wet:
                continue
            k = "wet" if wet[nxt] else "dry"
            acc[k]["n"] += 1
            acc[k]["h"] += d["h"]
            acc[k]["w"] += d["w"] / d["n"]
        rain = {k: {"n": v["n"], "h": round(v["h"] / v["n"], 1) if v["n"] else None, "w": round(v["w"] / v["n"]) if v["n"] else None}
                for k, v in acc.items()}

    index = load(index_path) or {}
    by_words = sorted(issuances, key=lambda x: x["words"])
    out = {
        "built": int(time.time()), "archive_updated": index.get("updated"),
        "first": issuances[0]["ymd"], "last": issuances[-1]["ymd"], "n": len(issuances),
        "words": sum(i["words"] for i in issuances),
        "iss": [[i["t"], i["words"], i["hedge_k"], len(i["kms"]), i["sig"].get("discussion", ""), len(i["wwa"])] for i in issuances],
        "days": days_out,
        "themes": [{"id": i, "label": l, "total": themes_tot.get(i, 0)} for i, l, _ in THEMES],
        "models": [[m, n] for m, n in models_tot.most_common()],
        "feats": [[m, n] for m, n in feats_tot.most_common()],
        "places": [[m, n] for m, n in places_tot.most_common()],
        "hedges": [[m, n] for m, n in hedges_tot.most_common()],
        "weeks": weeks_out,
        "threads": threads_of(issuances)[:60],
        "wwa": wwa_out,
        "sigs": sigs,
        "hours": hours,
        "slots": {k: {"n": v["n"], "w": round(v["w"] / v["n"])} for k, v in slots.items()},
        "temps": {m: dict(c) for m, c in sorted(temps.items())},
        "terms": month_terms(issuances),
        "longest": [by_words[-1]["t"], by_words[-1]["words"], by_words[-1]["path"]],
        "shortest": [by_words[0]["t"], by_words[0]["words"], by_words[0]["path"]],
        "rain": rain,
        "sections": {k: sum(i["sec_w"].get(k, 0) for i in issuances) for k in PROSE},
    }
    text = [{"t": i["t"], "p": i["path"], "s": {k: v for k, v in i["sec"].items() if k in PROSE and v}} for i in issuances]
    return out, text


def selftest():
    sample = """000
FXUS61 KLWX 291346
AFDLWX

Area Forecast Discussion
National Weather Service Baltimore MD/Washington DC
946 AM EDT Tue Sep 29 2026

.WHAT HAS CHANGED...
Added patchy drizzle. Otherwise no changes.

&&

.KEY MESSAGES...
- 1) Tranquil weather is expected through Thursday with climbing
  temperatures.

- 2) Rain chances increase this weekend as a cold front approaches,
  but confidence is low.

&&

.DISCUSSION...
KEY MESSAGE 1...Tranquil weather.

What's left of the Nor'easter is over the Gulf of Maine. Highs in the
upper 80s Thursday; some spots near 90. The GFS and ECMWF disagree, and
ensemble members vary. Fog could develop tonight but can't be ruled out
everywhere.

&&

.AVIATION /13Z TUESDAY THROUGH SATURDAY/...
VFR today. MVFR TEMPO at KMRB. Fog possible at MRB and CHO tonight.

&&

.MARINE...
Light winds.

&&

.LWX WATCHES/WARNINGS/ADVISORIES...
DC...None.
MD...Coastal Flood Advisory until 8 PM EDT this evening for MDZ014.
VA...None.
WV...None.
MARINE...Small Craft Advisory from 6 PM this evening for ANZ530.

&&

$$

DISCUSSION...ADS/KJP
AVIATION...ADS
MARINE...KJP
"""
    r = analyze({"productText": sample, "issuanceTime": "2026-09-29T13:46:00+00:00"}, "afd/2026/x.json")
    assert set(r["sec"]) >= {"chg", "key", "disc", "avn", "mar", "wwa"}, r["sec"].keys()
    assert "over the Gulf of Maine. Highs in the upper 80s" in r["sec"]["disc"], r["sec"]["disc"]
    assert "\n\n" in r["sec"]["disc"] and r["sec"]["disc"].count("\n") == 2, repr(r["sec"]["disc"])
    assert len(r["kms"]) == 2 and r["kms"][0].startswith("Tranquil"), r["kms"]
    assert r["sig"] == {"discussion": "ADS/KJP", "aviation": "ADS", "marine": "KJP"}, r["sig"]
    assert key_messages("- (1) Heat builds through the week.\n\n- 2) Storms Friday afternoon.") == ["Heat builds through the week.", "Storms Friday afternoon."]
    assert r["wwa"] == ["Coastal Flood Advisory", "Small Craft Advisory"], r["wwa"]
    assert r["models"].get("GFS") == 1 and r["models"].get("ECMWF") == 1 and r["models"].get("ensembles") == 1, r["models"]
    assert r["feats"].get("nor'easter") == 1 and r["feats"].get("cold front") == 1, r["feats"]
    assert r["cats"]["vfr"] == 1 and r["cats"]["mvfr"] == 1 and r["cats"]["fog"] == 1, r["cats"]
    assert r["tafs"]["MRB"] == 2 and r["tafs"]["CHO"] == 1, r["tafs"]
    assert r["temps"] == {"80s": 1, "90s": 1}, r["temps"]
    assert r["hedges"].get("can't be ruled out") == 1 and r["hedges"].get("could") == 1, r["hedges"]
    assert r["conf_lo"] == 1 and r["hour"] == 9 and r["slot"] == "morning", (r["conf_lo"], r["hour"])
    # threads: same message restated joins; a new one opens
    a = dict(r, t=r["t"], kms=["Tranquil weather is expected through Thursday with climbing temperatures.", "Rain chances increase this weekend."])
    b = dict(r, t=r["t"] + 21600, kms=["Tranquil weather expected through Thursday, temperatures climbing.", "Heat builds Friday."])
    th = threads_of([a, b])
    assert len(th) == 3 and th[0]["n"] == 2 and th[0]["versions"] == 2 and th[0]["hours"] == 6, th
    print("selftest ok")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
        sys.exit(0)
    out, text = build()
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"), ensure_ascii=False)
    with open(OUT_TEXT, "w", encoding="utf-8") as f:
        json.dump(text, f, separators=(",", ":"), ensure_ascii=False)
    print(f"{out['n']} issuances · {out['words']:,} words · {len(out['days'])} days · {len(out['threads'])} threads → "
          f"{os.path.getsize(OUT)//1024} KB + {os.path.getsize(OUT_TEXT)//1024} KB")
