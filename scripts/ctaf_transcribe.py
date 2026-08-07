#!/usr/bin/env python3
"""CTAF transcript builder — data/ctaf/YYYY-MM-DD.json.

Polls the SDR box's public clip index (the same one ctaf.html reads),
downloads any 122.9 clip that has no transcript yet, transcribes it with
faster-whisper, and merges the text into per-day JSON files that ctaf.html
fetches same-origin. Unlike the LiveATC feeds (pi/atc.py — ToS forbids
republishing), these clips come off our own receiver, so publishing the
text is fine.

Runs two ways, same code:
  - .github/workflows/ctaf-transcribe.yml every 30 min (CPU, small.en), and
  - by hand on the PC for backlog chewing:  python scripts/ctaf_transcribe.py

Accuracy helpers: whisper is biased with CTAF phraseology (including Lee's
SuperUnicom automated-advisory wording), the shared pc/atc_vocab.txt terms,
and — the big one for callsign digits — the spoken tail numbers of aircraft
the ADS-B snapshots (traffic-data branch) show near the field that day
("Skyhawk seven five five zero papa").

Day files are keyed by the clip's path inside the day folder, so a clip is
transcribed exactly once; entries persist after the SDR box prunes old
audio, so data/ctaf/ accumulates into a permanent text log of the frequency.
Requires faster-whisper; everything else is stdlib.
"""

import argparse
import io
import json
import os
import re
import sys
import time
import urllib.request

DEFAULT_HOST = os.environ.get("KANP_SDR_HOST", "https://jalpine.taila8f067.ts.net")
SNAPSHOT_BASE = ("https://raw.githubusercontent.com/nuvig/nuvig.github.io/"
                 "traffic-data/v2")
CTAF_MHZ = 122.9
CLIP_RE = re.compile(r"^clips/(\d{4}-\d{2}-\d{2})/([^/]+\.(?:mp3|wav))$")

# Aircraft near the field, for callsign biasing (loose — this only feeds the
# prompt, so err toward including).
NEAR_NM, NEAR_FT = 8.0, 4500
FIELD_LAT, FIELD_LON = 38.9422, -76.5684   # SITE.tracker in js/site-config.js

# ICAO type designator -> what pilots actually say on frequency. Fallback is
# "November", which is also what's said when the type isn't announced.
TYPE_WORDS = {
    "C120": "Cessna", "C140": "Cessna", "C150": "Cessna", "C152": "Cessna",
    "C170": "Cessna", "C172": "Skyhawk", "C175": "Cessna", "C177": "Cardinal",
    "C180": "Cessna", "C182": "Skylane", "C206": "Stationair", "C210": "Centurion",
    "P28A": "Cherokee", "P28B": "Cherokee", "P28R": "Arrow", "P28T": "Arrow",
    "PA18": "Super Cub", "PA22": "Piper", "PA24": "Comanche", "PA32": "Saratoga",
    "P32R": "Saratoga", "PA44": "Seminole", "PA46": "Malibu",
    "BE23": "Musketeer", "BE24": "Sierra", "BE33": "Bonanza", "BE35": "Bonanza",
    "BE36": "Bonanza", "BE55": "Baron", "BE58": "Baron", "BE76": "Duchess",
    "SR20": "Cirrus", "SR22": "Cirrus", "DA20": "Diamond", "DA40": "Diamond Star",
    "DA42": "Twin Star", "M20P": "Mooney", "M20T": "Mooney", "AA5": "Grumman",
    "AA5A": "Grumman", "AA5B": "Tiger", "DV20": "Katana", "7ECA": "Citabria",
    "8KCB": "Decathlon", "J3": "Cub",
}
DIGIT_WORDS = {"0": "zero", "1": "one", "2": "two", "3": "three", "4": "four",
               "5": "five", "6": "six", "7": "seven", "8": "eight", "9": "niner"}
NATO = {"A": "alpha", "B": "bravo", "C": "charlie", "D": "delta", "E": "echo",
        "F": "foxtrot", "G": "golf", "H": "hotel", "I": "india", "J": "juliet",
        "K": "kilo", "L": "lima", "M": "mike", "N": "november", "O": "oscar",
        "P": "papa", "Q": "quebec", "R": "romeo", "S": "sierra", "T": "tango",
        "U": "uniform", "V": "victor", "W": "whiskey", "X": "x-ray",
        "Y": "yankee", "Z": "zulu"}

# The prompt leads with real Lee Airport phraseology — the SuperUnicom
# automated advisory is a big share of what's on 122.9, and quoting its
# actual wording locks whisper onto it.
BASE_PROMPT = (
    "Radio calls on the CTAF at a non-towered airport. "
    "Annapolis traffic, Skyhawk seven five five zero papa, left downwind "
    "runway three zero, full stop, Lee traffic. "
    "Lee Annapolis automated advisory, wind two three zero at four, altimeter "
    "three zero one one, density altitude one thousand six hundred, runway "
    "one two, listen for traffic. "
    "Welcome to Lee Airport, caution short field, obstructions, wildlife may "
    "be on runway and taxiway. ")


def fetch_json(url, timeout=30):
    with urllib.request.urlopen(url, timeout=timeout) as res:
        return json.loads(res.read())


def is_ctaf(clip):
    """Same rule as ctaf.html: no freq field (pre-scanner clips) = CTAF."""
    freq = clip.get("freq")
    if not freq:
        return True
    try:
        return abs(float(str(freq).rstrip("Mm")) - CTAF_MHZ) < 0.0005
    except ValueError:
        return False


def spoken_reg(reg, actype):
    """'N7550P', 'C172' -> 'Skyhawk seven five five zero papa'."""
    tail = reg[1:] if reg.upper().startswith("N") else reg
    words = [DIGIT_WORDS.get(ch) or NATO.get(ch.upper()) for ch in tail.upper()]
    if not all(words):
        return None
    return f"{TYPE_WORDS.get((actype or '').upper(), 'November')} {' '.join(words)}"


def nearby_callsigns(days):
    """Spoken tail numbers of ADS-B aircraft seen near the field on those days."""
    out, seen = [], set()
    for day in sorted(days):
        try:
            data = fetch_json(f"{SNAPSHOT_BASE}/days/{day}.json", timeout=120)
        except (OSError, ValueError):
            continue
        for t in data.get("tracks", []):
            reg = t.get("reg")
            if not reg or reg in seen:
                continue
            for ts, lat, lon, alt, gs, og in t.get("points", []):
                # cheap flat-earth distance — 8 nm gate doesn't need haversine
                dx = (lon - FIELD_LON) * 60 * 0.777   # cos(38.94°)
                dy = (lat - FIELD_LAT) * 60
                if dx * dx + dy * dy > NEAR_NM * NEAR_NM:
                    continue
                if og or alt is None or alt <= NEAR_FT:
                    s = spoken_reg(reg, t.get("type"))
                    if s:
                        seen.add(reg)
                        out.append(s)
                    break
    return out


def enable_cuda_dlls():
    """Make the pip-installed NVIDIA runtime DLLs loadable on Windows
    (same trick as pc/atc_transcribe.py; needs nvidia-cublas-cu12 +
    nvidia-cudnn-cu12)."""
    import importlib
    for mod in ("nvidia.cublas", "nvidia.cudnn"):
        try:
            m = importlib.import_module(mod)
        except ImportError:
            continue
        for root in list(getattr(m, "__path__", [])):
            d = os.path.join(root, "bin")
            if os.path.isdir(d):
                os.add_dll_directory(d)
                os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")


def load_vocab(repo_root):
    path = os.path.join(repo_root, "pc", "atc_vocab.txt")
    try:
        with open(path, encoding="utf-8") as f:
            return [ln.strip() for ln in f
                    if ln.strip() and not ln.lstrip().startswith("#")]
    except OSError:
        return []


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--host", default=DEFAULT_HOST)
    ap.add_argument("--out", default=os.path.join("data", "ctaf"))
    ap.add_argument("--model", default=os.environ.get("CTAF_WHISPER_MODEL",
                                                      "small.en"))
    ap.add_argument("--beam", type=int, default=3)
    ap.add_argument("--device", default="cpu",
                    help="cpu (default, what CI uses) or cuda — cuda needs the "
                         "NVIDIA cuBLAS/cuDNN 12 pip libraries")
    ap.add_argument("--max", type=int, default=150,
                    help="clips per run (newest first; backlog drains over runs)")
    ap.add_argument("--budget", type=int, default=660,
                    help="seconds of transcription before stopping (0 = no cap)")
    ap.add_argument("--dry-run", action="store_true",
                    help="transcribe and print but write nothing")
    args = ap.parse_args()
    base = args.host.rstrip("/") + "/ctaf"

    try:
        index = fetch_json(f"{base}/index.json?t={int(time.time())}")
    except (OSError, ValueError) as e:
        print(f"SDR box unreachable ({e}) — nothing to do")
        return 0

    # (day, name, clip) for every CTAF clip on the wire, newest first so the
    # page's visible top gets text before old backlog does.
    on_wire = []
    for c in index.get("clips", []):
        if not is_ctaf(c):
            continue
        m = CLIP_RE.match(c.get("clip", ""))
        if m:
            on_wire.append((m.group(1), m.group(2), c))
    on_wire.sort(key=lambda x: x[2]["ts"], reverse=True)

    days = {}      # day -> {"clips": {...}, ...} (existing file content)
    for day in {d for d, _, _ in on_wire}:
        try:
            with open(os.path.join(args.out, f"{day}.json"), encoding="utf-8") as f:
                days[day] = json.load(f)
        except (OSError, ValueError):
            days[day] = None

    pending = [(d, n, c) for d, n, c in on_wire
               if n not in ((days[d] or {}).get("clips") or {})][:args.max]
    if not pending:
        print(f"{len(on_wire)} clips on the wire, all transcribed")
        return 0
    print(f"{len(on_wire)} clips on the wire, {len(pending)} to transcribe")

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        sys.exit("faster-whisper not installed — pip install faster-whisper")

    repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    vocab = load_vocab(repo_root)
    callsigns = nearby_callsigns({d for d, _, _ in pending})
    print(f"biasing with {len(callsigns)} nearby ADS-B callsigns")
    prompt = (BASE_PROMPT + " ".join(vocab) + ". Aircraft on frequency: "
              + ", ".join(callsigns[:15]) + ".")
    hotwords = " ".join(vocab + callsigns[:15]) or None

    if args.device == "cuda" and sys.platform == "win32":
        enable_cuda_dlls()
    print(f"loading {args.model} on {args.device} …", flush=True)
    model = WhisperModel(args.model, device=args.device,
                         compute_type="int8" if args.device == "cpu" else "auto",
                         cpu_threads=os.cpu_count() or 4)

    done, t0 = 0, time.time()
    for day, name, c in pending:
        if args.budget and time.time() - t0 > args.budget:
            print(f"time budget hit after {done} clips — rest next run")
            break
        try:
            with urllib.request.urlopen(f"{base}/{c['clip']}", timeout=60) as res:
                audio = io.BytesIO(res.read())
        except OSError as e:
            print(f"  {name}: download failed ({e})")
            continue
        segments, _ = model.transcribe(audio, language="en", beam_size=args.beam,
                                       vad_filter=False, initial_prompt=prompt,
                                       hotwords=hotwords)
        # Same hallucination gate as pc/atc_transcribe.py: low avg_logprob =
        # whisper guessing at static; high no_speech_prob = nobody talking.
        kept = [s.text.strip() for s in segments
                if s.avg_logprob > -1.0 and s.no_speech_prob < 0.6]
        text = " ".join(kept).strip() or "[noise]"
        print(f"  {day}/{name} {c.get('dur', '?')}s: {text[:110]}", flush=True)
        if days[day] is None:
            days[day] = {"date": day, "freq": f"{CTAF_MHZ}", "clips": {}}
        days[day]["clips"][name] = {"ts": c["ts"], "dur": c.get("dur"),
                                    "text": text}
        days[day]["model"] = args.model
        days[day]["updated"] = int(time.time())
        done += 1

    if args.dry_run:
        print(f"dry run: {done} transcribed, nothing written")
        return 0

    os.makedirs(args.out, exist_ok=True)
    for day, data in days.items():
        if data is None:
            continue
        data["clips"] = dict(sorted(data["clips"].items()))
        path = os.path.join(args.out, f"{day}.json")
        with open(path, "w", encoding="utf-8", newline="\n") as f:
            json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
            f.write("\n")
    print(f"done: {done} transcribed into {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
