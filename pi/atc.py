#!/usr/bin/env python3
"""LiveATC recorder + transcriber.

Streams one or more LiveATC.net feeds via ffmpeg, splits the audio into
individual transmissions with an RMS squelch (ATC is push-to-talk, so silence
gaps segment cleanly), saves each transmission as a WAV clip, and transcribes
it with whisper.cpp. Results land under KANP_ATC_DIR:

    {mount}/{YYYY-MM-DD}/{HH-MM-SS.f}.wav   audio clips
    {mount}/{YYYY-MM-DD}.jsonl              one JSON object per transmission

server.py exposes these as /api/atc/* for the atc.html viewer. Everything is
LAN-only personal use — LiveATC's ToS doesn't allow republishing streams, so
nothing here is exported to GitHub.

Stdlib only; external binaries: ffmpeg (required), whisper.cpp's whisper-cli
(optional — without it clips are still recorded and text is left empty).

Config via /etc/kanp/site.env (see site.env.example):
  KANP_ATC_FEEDS      semicolon list of mount|label|freq entries
  KANP_ATC_DIR        data dir (default /var/lib/kanp/atc)
  KANP_ATC_WHISPER_BIN / KANP_ATC_WHISPER_MODEL
  KANP_ATC_RETENTION_DAYS  clip retention (default 14)
"""

import json
import math
import os
import queue
import shutil
import signal
import struct
import subprocess
import sys
import threading
import time
import wave
from datetime import datetime, timedelta

ATC_DIR = os.environ.get("KANP_ATC_DIR", "/var/lib/kanp/atc")
FEEDS_RAW = os.environ.get(
    "KANP_ATC_FEEDS",
    "kbwi_es_app_124550|Potomac Approach GRACO|124.550;"
    "kbwi_es_app_125525|Potomac Approach BELAY|125.525;"
    "kbwi_es_final|Potomac BWI Final|119.0/119.7",
)
STREAM_BASE = os.environ.get("KANP_ATC_STREAM_BASE", "https://d.liveatc.net")
WHISPER_BIN = os.environ.get("KANP_ATC_WHISPER_BIN",
                             "/opt/whisper.cpp/build/bin/whisper-cli")
WHISPER_MODEL = os.environ.get("KANP_ATC_WHISPER_MODEL",
                               "/opt/whisper.cpp/models/ggml-base.en.bin")
WHISPER_THREADS = os.environ.get("KANP_ATC_WHISPER_THREADS", "3")
RETENTION_DAYS = int(os.environ.get("KANP_ATC_RETENTION_DAYS", "14"))

# Squelch tuning. Audio is 16 kHz mono s16le; we look at 0.25 s blocks.
RATE = 16000
BLOCK_SAMPLES = RATE // 4                 # 0.25 s
BLOCK_BYTES = BLOCK_SAMPLES * 2
OPEN_RMS = int(os.environ.get("KANP_ATC_OPEN_RMS", "700"))    # start of tx
CLOSE_RMS = int(os.environ.get("KANP_ATC_CLOSE_RMS", "400"))  # sustained quiet
HANG_BLOCKS = 5        # 1.25 s of quiet ends the transmission
PRE_ROLL_BLOCKS = 2    # keep 0.5 s before the squelch opened
MIN_TX_SECONDS = 0.6   # discard shorter blips (squelch tails, noise)
MAX_TX_SECONDS = 120   # force-split anything longer


def log(msg):
    print(msg, flush=True)


def parse_feeds():
    feeds = []
    for entry in FEEDS_RAW.split(";"):
        entry = entry.strip()
        if not entry:
            continue
        parts = entry.split("|")
        mount = parts[0].strip()
        label = parts[1].strip() if len(parts) > 1 else mount
        freq = parts[2].strip() if len(parts) > 2 else ""
        feeds.append({"mount": mount, "label": label, "freq": freq})
    return feeds


def rms(block):
    n = len(block) // 2
    if n == 0:
        return 0
    samples = struct.unpack(f"<{n}h", block[: n * 2])
    return int(math.sqrt(sum(s * s for s in samples) / n))


def write_wav(path, pcm):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(pcm)


# --- transcription worker (one queue, whisper runs serialized) --------------

tx_queue = queue.Queue()
whisper_ok = None  # decided on first use


def transcribe(wav_path):
    global whisper_ok
    if whisper_ok is None:
        whisper_ok = os.path.isfile(WHISPER_BIN) and os.path.isfile(WHISPER_MODEL)
        if not whisper_ok:
            log(f"[atc] whisper not found ({WHISPER_BIN} / {WHISPER_MODEL}) — "
                "recording clips without transcripts")
    if not whisper_ok:
        return ""
    try:
        out = subprocess.run(
            [WHISPER_BIN, "-m", WHISPER_MODEL, "-f", wav_path,
             "-t", WHISPER_THREADS, "-l", "en", "-nt", "--no-prints"],
            capture_output=True, text=True, timeout=600)
        return " ".join(out.stdout.split()).strip()
    except (subprocess.TimeoutExpired, OSError) as e:
        log(f"[atc] whisper failed on {wav_path}: {e}")
        return ""


def transcriber_loop():
    while True:
        item = tx_queue.get()
        if item is None:
            return
        mount, ts, dur, wav_path = item
        text = transcribe(wav_path)
        day = datetime.fromtimestamp(ts).strftime("%Y-%m-%d")
        rec = {
            "ts": round(ts, 2),
            "dur": round(dur, 2),
            "clip": os.path.relpath(wav_path, ATC_DIR).replace(os.sep, "/"),
            "text": text,
        }
        jsonl = os.path.join(ATC_DIR, mount, f"{day}.jsonl")
        os.makedirs(os.path.dirname(jsonl), exist_ok=True)
        with open(jsonl, "a") as f:
            f.write(json.dumps(rec) + "\n")
        backlog = tx_queue.qsize()
        log(f"[{mount}] {datetime.fromtimestamp(ts):%H:%M:%S} "
            f"{dur:.1f}s{f' (queue {backlog})' if backlog > 3 else ''}: "
            f"{text[:120] if text else '(no transcript)'}")


# --- per-feed capture --------------------------------------------------------

def capture_feed(feed, stop):
    mount = feed["mount"]
    url = f"{STREAM_BASE}/{mount}"
    backoff = 5
    while not stop.is_set():
        log(f"[{mount}] connecting to {url}")
        proc = subprocess.Popen(
            ["ffmpeg", "-nostdin", "-loglevel", "error",
             "-reconnect", "1", "-reconnect_streamed", "1",
             "-reconnect_delay_max", "10",
             "-i", url, "-ac", "1", "-ar", str(RATE), "-f", "s16le", "-"],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        started = time.time()
        pre = []          # rolling pre-roll blocks
        recording = None  # bytearray while squelch is open
        rec_start = 0.0
        quiet = 0

        def close_tx(now):
            nonlocal recording
            dur = len(recording) / 2 / RATE
            pcm = bytes(recording)
            recording = None
            if dur < MIN_TX_SECONDS:
                return
            day = datetime.fromtimestamp(rec_start).strftime("%Y-%m-%d")
            name = datetime.fromtimestamp(rec_start).strftime("%H-%M-%S.%f")[:-4]
            wav_path = os.path.join(ATC_DIR, mount, day, name + ".wav")
            write_wav(wav_path, pcm)
            tx_queue.put((mount, rec_start, dur, wav_path))

        while not stop.is_set():
            block = proc.stdout.read(BLOCK_BYTES)
            if not block:
                break
            now = time.time()
            level = rms(block)
            if recording is None:
                pre.append(block)
                if len(pre) > PRE_ROLL_BLOCKS:
                    pre.pop(0)
                if level >= OPEN_RMS:
                    recording = bytearray(b"".join(pre))
                    rec_start = now - len(pre) * 0.25
                    pre = []
                    quiet = 0
            else:
                recording.extend(block)
                quiet = quiet + 1 if level < CLOSE_RMS else 0
                if quiet >= HANG_BLOCKS:
                    # trim the trailing hang time off the clip
                    del recording[-(HANG_BLOCKS - 1) * BLOCK_BYTES:]
                    close_tx(now)
                elif (now - rec_start) > MAX_TX_SECONDS:
                    close_tx(now)

        if recording:
            close_tx(time.time())
        proc.kill()
        proc.wait()
        if stop.is_set():
            return
        # quick death = stream problem; back off, else reconnect promptly
        backoff = min(backoff * 2, 120) if time.time() - started < 30 else 5
        log(f"[{mount}] stream ended, retrying in {backoff}s")
        stop.wait(backoff)


# --- retention ----------------------------------------------------------------

def purge_old():
    cutoff = (datetime.now() - timedelta(days=RETENTION_DAYS)).strftime("%Y-%m-%d")
    for mount in os.listdir(ATC_DIR) if os.path.isdir(ATC_DIR) else []:
        mdir = os.path.join(ATC_DIR, mount)
        if not os.path.isdir(mdir):
            continue
        for entry in os.listdir(mdir):
            day = entry[:10]
            if len(day) == 10 and day < cutoff:
                target = os.path.join(mdir, entry)
                log(f"[atc] purging {target}")
                if os.path.isdir(target):
                    shutil.rmtree(target, ignore_errors=True)
                else:
                    try:
                        os.remove(target)
                    except OSError:
                        pass


def retention_loop(stop):
    while not stop.is_set():
        try:
            purge_old()
        except Exception as e:
            log(f"[atc] retention error: {e}")
        stop.wait(6 * 3600)


def main():
    feeds = parse_feeds()
    if not feeds:
        log("[atc] no feeds configured (KANP_ATC_FEEDS empty)")
        return
    os.makedirs(ATC_DIR, exist_ok=True)
    # feeds.json lets server.py report labels/frequencies without env access
    with open(os.path.join(ATC_DIR, "feeds.json"), "w") as f:
        json.dump(feeds, f)

    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())

    threads = [threading.Thread(target=transcriber_loop, daemon=True),
               threading.Thread(target=retention_loop, args=(stop,), daemon=True)]
    for feed in feeds:
        threads.append(threading.Thread(target=capture_feed, args=(feed, stop),
                                        daemon=True))
    for t in threads:
        t.start()
    log(f"[atc] recording {len(feeds)} feed(s) -> {ATC_DIR}")
    while not stop.is_set():
        stop.wait(60)
    log("[atc] shutting down")
    time.sleep(2)  # let in-flight clip writes finish


if __name__ == "__main__":
    main()
