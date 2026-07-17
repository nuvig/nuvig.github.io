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
import json
import os
import sys
import time
import urllib.parse
import urllib.request

POLL_SECONDS = 30


def api_json(url, payload=None):
    req = urllib.request.Request(url)
    if payload is not None:
        req.data = json.dumps(payload).encode()
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=30) as res:
        return json.loads(res.read())


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--api", default=os.environ.get("KANP_API",
                                                    "http://192.168.1.250:8787"))
    ap.add_argument("--model", default="small.en")
    ap.add_argument("--device", default="cpu",
                    help="cpu (default) or cuda — cuda needs the NVIDIA "
                         "cuBLAS/cuDNN 12 libraries installed")
    ap.add_argument("--once", action="store_true")
    args = ap.parse_args()
    base = args.api.rstrip("/")

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        sys.exit("faster-whisper not installed — run: pip install faster-whisper")

    print(f"loading {args.model} …", flush=True)
    model = WhisperModel(args.model, device=args.device,
                         compute_type="int8" if args.device == "cpu" else "auto")
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
        # Transcribe the whole batch, then store it in ONE POST — each store
        # rewrites day files on the Pi's SD card, so per-clip posts thrash it.
        updates = []
        for rec in pending:
            clip = rec["clip"]
            try:
                with urllib.request.urlopen(
                        f"{base}/api/atc/clip?f={urllib.parse.quote(clip)}",
                        timeout=60) as res:
                    wav = io.BytesIO(res.read())
                segments, _ = model.transcribe(
                    wav, language="en", beam_size=5, vad_filter=False,
                    initial_prompt="Air traffic control radio communication.")
                text = " ".join(s.text.strip() for s in segments).strip()
                updates.append({"clip": clip, "text": text or "[unreadable]"})
                print(f"  {clip}  {rec.get('dur', '?')}s: {text[:100]}", flush=True)
            except Exception as e:
                errors += 1
                print(f"  {clip}: FAILED ({e})", flush=True)
                if errors > 20 and errors > done:
                    sys.exit("too many failures — check the Pi API and try again")
        if updates:
            res = api_json(f"{base}/api/atc/text", {"updates": updates})
            done += res.get("stored", 0)
            if res.get("missing"):
                print(f"  {len(res['missing'])} clips vanished before storing",
                      flush=True)

    print(f"done: {done} transcribed, {errors} failed", flush=True)


if __name__ == "__main__":
    main()
