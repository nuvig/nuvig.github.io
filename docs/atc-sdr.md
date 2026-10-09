# ATC and SDR pages

Moved verbatim from CLAUDE.md. Sibling docs are in `docs/`; "above"/"below" references to other areas point there. Index: CLAUDE.md → Docs.

## ATC & SDR pages

- `atc.html` + `js/atc.js` — LiveATC transcript viewer. **Pi-only, no GitHub fallback.** `pi/atc.py`
  records LiveATC feeds (ffmpeg RMS-squelch segmentation → WAV clips); `server.py` serves `/api/atc/*`.
  The Pi (32-bit OS) is ~100× too slow for whisper — transcription runs on the PC via
  `pc/atc_transcribe.py` (faster-whisper, polls `/api/atc/pending`, POSTs to `/api/atc/text`); on the Pi
  `KANP_ATC_WHISPER_BIN` points at a nonexistent path so it records only. Feeds configured in
  `site.env` (`KANP_ATC_FEEDS`); defaults baked into `atc.py` are Potomac Approach GRACO 124.550 /
  Baltimore Tower 119.400 / Potomac BWI Final 119.0-119.7.
  **LiveATC ToS forbids republishing — never export ATC audio/transcripts to the traffic-data branch
  or anywhere public.**
- `ctaf.html` (KANP CTAF 122.9 clips + live stream) and `scanner.html` (remotely tunable SDR) talk to a
  **separate SDR box over a Tailscale funnel** (`https://jalpine.taila8f067.ts.net`, `/ctaf`,
  `/kanp.mp3`, `/api/state`, `/api/tune`, `/api/audio`) — not the Pi tracker API. That server's code is
  **not in this repo**; these two pages are self-contained HTML with the host hardcoded near the top of
  their inline `<script>`. They're unlinked from site navigation (scanner links to ctaf and back).
- On top of the clip list, `ctaf.html` layers **who was flying**: each clip is matched against the
  traffic-data snapshots (same raw.githubusercontent source as `kanp-static.js`; the 10–16 MB day file
  is fetched lazily per day and prefiltered to near-field tracks). Match gates: airborne ≤ 6 nm and
  ≤ 3,000 ft MSL, or on the surface ≤ 2 nm, interpolating across ≤ 240 s gaps like `kanp-conflict.js`;
  selected clips get a runway-frame mini-map of the ±2 min trails. The page degrades to a plain clip
  list when snapshots are unreachable. Times render in the field's zone (`America/New_York`,
  hardcoded — the page stays self-contained).
- **Transcripts are parked (2026-08-06): whisper accuracy wasn't good enough for Jesse — don't
  re-enable or re-surface them without being asked.** The pipeline is kept intact but idle:
  `scripts/ctaf_transcribe.py` (faster-whisper; biased by `pc/atc_vocab.txt`, Lee's SuperUnicom
  advisory phrasing, and spoken tail numbers from the snapshots; `--device cuda` for GPU backlog
  runs) writes `data/ctaf/YYYY-MM-DD.json`, and `.github/workflows/ctaf-transcribe.yml` has its
  schedule commented out (`workflow_dispatch` remains for manual tests). The page's transcript
  display/search code was removed — it lives in git history at commit `6b0460c`. Existing
  `data/ctaf/` day files stay as inert history. Since these clips come from our own receiver, the
  LiveATC no-republish rule above does not apply to them; it still applies to everything
  `pi/atc.py` records.

