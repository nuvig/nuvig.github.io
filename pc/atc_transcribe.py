#!/usr/bin/env python3
"""PC-side ATC transcriber.

The Pi records LiveATC transmissions but is far too slow to run whisper
(32-bit ARM, ~100x real time), so this script does the transcription from
any machine on the LAN: it polls the Pi API for clips whose transcript is
still empty, downloads each WAV, transcribes it with faster-whisper, and
POSTs the text back. Run it whenever the PC is on — it chews through any
backlog, then idles polling every 30 s. Ctrl+C to stop.

Setup (once):
    pip install faster-whisper

Run:
    python pc/atc_transcribe.py --api http://192.168.1.250:8787

Options:
    --api URL      Pi API base (default http://192.168.1.250:8787,
                   or set KANP_API env var)
    --model NAME   faster-whisper model (default small.en; try medium.en if
                   your PC has the muscle, tiny.en if it doesn't)
    --once         drain the backlog and exit instead of polling forever
"""

import argparse
import io
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
import os
import sys
import time
import urllib.parse
import urllib.request

POLL_SECONDS = 30

# ICAO airline code -> radio telephony callsign, for biasing whisper toward
# what's actually said on frequency ("Southwest twenty-two eleven", never
# "SWA2211"). Common traffic in Potomac/BWI airspace.
TELEPHONY = {
    "SWA": "Southwest", "AAL": "American", "DAL": "Delta", "UAL": "United",
    "JBU": "JetBlue", "NKS": "Spirit", "FFT": "Frontier", "ASA": "Alaska",
    "FDX": "FedEx", "UPS": "UPS", "GTI": "Giant", "ABX": "Abex",
    "RPA": "Brickyard", "EDV": "Endeavor", "SKW": "SkyWest", "ENY": "Envoy",
    "PDT": "Piedmont", "JIA": "Blue Streak", "AWI": "Wisconsin",
    "MXY": "Moxy", "SCX": "Sun Country", "VXP": "Avelo", "EJA": "ExecJet",
    "LXJ": "Flexjet", "JTL": "Jet Linx", "XOJ": "Exojet", "DPJ": "Red Star",
}

DIGIT_WORDS = {"0": "zero", "1": "one", "2": "two", "3": "three", "4": "four",
               "5": "five", "6": "six", "7": "seven", "8": "eight", "9": "niner"}


def spoken_callsigns(aircraft):
    """Airline flights -> telephony + flight number; GA N-numbers as-is."""
    out = []
    for ac in aircraft:
        for cs in (ac.get("callsigns") or "").split(","):
            cs = cs.strip()
            if not cs:
                continue
            tel = TELEPHONY.get(cs[:3])
            if tel and cs[3:].isdigit():
                out.append(f"{tel} {cs[3:].lstrip('0')}")
            elif cs.startswith("N"):
                out.append(cs)  # e.g. N734JL — biases the letter/digit string
    return list(dict.fromkeys(out))  # dedupe, keep order


def enable_cuda_dlls():
    """Make the pip-installed NVIDIA runtime DLLs loadable on Windows.
    (pip install nvidia-cublas-cu12 nvidia-cudnn-cu12)"""
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


def load_vocab(path):
    try:
        with open(path, encoding="utf-8") as f:
            return [ln.strip() for ln in f
                    if ln.strip() and not ln.lstrip().startswith("#")]
    except OSError:
        return []


def api_json(url, payload=None, timeout=30, retries=1):
    req = urllib.request.Request(url)
    if payload is not None:
        req.data = json.dumps(payload).encode()
        req.add_header("Content-Type", "application/json")
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as res:
                return json.loads(res.read())
        except OSError:
            if attempt == retries - 1:
                raise
            time.sleep(10 * (attempt + 1))


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--api", default=os.environ.get("KANP_API",
                                                    "http://192.168.1.250:8787"))
    ap.add_argument("--model", default="small.en")
    ap.add_argument("--device", default="cpu",
                    help="cpu (default) or cuda — cuda needs the NVIDIA "
                         "cuBLAS/cuDNN 12 libraries installed")
    ap.add_argument("--workers", type=int, default=0,
                    help="parallel transcriptions (default: cpu_count/4, "
                         "each worker uses ~4 threads)")
    ap.add_argument("--beam", type=int, default=3,
                    help="beam size — 1 is fastest, 5 most accurate")
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--vocab", default=os.path.join(os.path.dirname(__file__),
                                                    "atc_vocab.txt"),
                    help="local fixes/SIDs/STARs/airports, one per line")
    args = ap.parse_args()
    vocab = load_vocab(args.vocab)
    base = args.api.rstrip("/")

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        sys.exit("faster-whisper not installed — run: pip install faster-whisper")

    if args.device == "cuda" and sys.platform == "win32":
        enable_cuda_dlls()
    workers = args.workers or max(1, (os.cpu_count() or 4) // 4)
    print(f"loading {args.model} ({workers} worker(s)) …", flush=True)
    model = WhisperModel(args.model, device=args.device,
                         compute_type="int8" if args.device == "cpu" else "auto",
                         cpu_threads=4, num_workers=workers)
    print(f"polling {base} for untranscribed clips", flush=True)

    done = errors = 0
    while True:
        try:
            batch = api_json(f"{base}/api/atc/pending?limit=50")
        except OSError as e:
            print(f"Pi unreachable ({e}), retrying in {POLL_SECONDS}s", flush=True)
            time.sleep(POLL_SECONDS)
            continue

        pending = batch.get("pending", [])
        if not pending:
            if args.once:
                break
            time.sleep(POLL_SECONDS)
            continue

        print(f"{batch['total']} clips pending", flush=True)

        # Live callsign cross-reference: who was actually flying nearby while
        # this batch was recorded? (tracker DB via /api/aircraft)
        callsigns = []
        try:
            t0 = min(r["ts"] for r in pending) - 600
            t1 = max(r["ts"] for r in pending) + 600
            acs = api_json(f"{base}/api/aircraft?start={int(t0)}&end={int(t1)}")
            callsigns = spoken_callsigns(acs.get("aircraft", []))
        except (OSError, ValueError) as e:
            print(f"  (callsign lookup failed: {e})", flush=True)

        # Whisper biasing: a phraseology-styled prompt plus local terms and
        # the callsigns known to be airborne. Prompt budget is ~224 tokens,
        # so callsigns are capped.
        prompt = ("Air traffic control radio. Potomac Approach, Baltimore. "
                  "Cleared ILS runway one zero left, squawk four five two one, "
                  "descend and maintain three thousand, contact tower. "
                  + " ".join(vocab) + ". Aircraft on frequency: "
                  + ", ".join(callsigns[:25]) + ".")
        hotwords = " ".join(vocab + callsigns[:25]) or None
        # Transcribe the whole batch, then store it in ONE POST — each store
        # rewrites day files on the Pi's SD card, so per-clip posts thrash it.
        def do_one(rec):
            clip = rec["clip"]
            with urllib.request.urlopen(
                    f"{base}/api/atc/clip?f={urllib.parse.quote(clip)}",
                    timeout=60) as res:
                audio = io.BytesIO(res.read())
            segments, _ = model.transcribe(
                audio, language="en", beam_size=args.beam, vad_filter=False,
                initial_prompt=prompt, hotwords=hotwords)
            # Drop hallucinated segments: whisper "hears" phrases in static.
            # Low avg_logprob = the model was guessing; high no_speech_prob =
            # it didn't think anyone was talking.
            kept = [s.text.strip() for s in segments
                    if s.avg_logprob > -1.0 and s.no_speech_prob < 0.6]
            text = " ".join(kept).strip()
            print(f"  {clip}  {rec.get('dur', '?')}s: "
                  f"{text[:100] if text else '[noise]'}", flush=True)
            return {"clip": clip, "text": text or "[noise]"}

        updates = []
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futures = {pool.submit(do_one, r): r for r in pending}
            for fut in as_completed(futures):
                try:
                    updates.append(fut.result())
                except Exception as e:
                    errors += 1
                    print(f"  {futures[fut]['clip']}: FAILED ({e})", flush=True)
                    if errors > 20 and errors > done:
                        sys.exit("too many failures — check the Pi API "
                                 "and try again")
        if updates:
            # A busy Pi can take a while to rewrite big day files — be
            # patient and retry rather than throwing away the batch's work.
            try:
                res = api_json(f"{base}/api/atc/text", {"updates": updates},
                               timeout=180, retries=3)
                done += res.get("stored", 0)
                if res.get("missing"):
                    print(f"  {len(res['missing'])} clips vanished before "
                          "storing", flush=True)
            except OSError as e:
                print(f"  store failed after retries ({e}) — batch will be "
                      "retranscribed", flush=True)

    print(f"done: {done} transcribed, {errors} failed", flush=True)


if __name__ == "__main__":
    main()
