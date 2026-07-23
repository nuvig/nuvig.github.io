# CLAUDE.md

Personal website (jesselevine.net, GitHub Pages from `main`) + KANP flight tracker + weather hub.
Plain HTML/JS/CSS — **no build step, no framework, no npm**. Leaflet is vendored in `js/vendor/`.
Owner: Jesse, CFI/CFII/MEI pilot based at KANP (Lee Airport, Annapolis MD).

## Layout

- `index.html` — personal site landing page
- `js/site-config.js` — **all site-specific constants** (airport, coordinates, runway geometry, ops gates, nearby airports, TAF stations, snapshot URL, timezone) in one `SITE` global, loaded first on every page. Pi mirror: `pi/site.env.example` → `/etc/kanp/site.env` (read by the systemd units via `EnvironmentFile`). Edit these, not the consumers.
- `kanp.html` — flight tracker (Live / History Map / Traffic Study tabs)
  - `js/kanp.js` — shared utils + Live tab (poll every 5–60 s, trails, heatmap, localStorage). KANP = 38.9422, -76.5684, 60 nm radius (from `SITE`)
  - `js/kanp-history.js` — altitude-colored historical tracks on a canvas layer, FAA VFR + NEXRAD overlays
  - `js/kanp-study.js` — stats (hour×day grids, histograms); `js/kanp-ops.js` — ops detection (arrivals/departures/go-arounds by track geometry, runway 12/30)
  - `js/kanp-static.js` — GitHub-snapshot fallback data source (see Data flow)
- `atc.html` + `js/atc.js` — ATC transcript viewer. Pi-only (no GitHub fallback): `pi/atc.py` records LiveATC feeds (ffmpeg RMS-squelch segmentation → WAV clips) and transcribes with whisper.cpp; `server.py` serves `/api/atc/*`. The Pi (32-bit OS) is ~100× too slow for whisper — transcription runs on the PC via `pc/atc_transcribe.py` (faster-whisper, polls `/api/atc/pending`, POSTs to `/api/atc/text`); on the Pi `KANP_ATC_WHISPER_BIN` points at a nonexistent path so it records only. **LiveATC ToS forbids republishing — never export ATC audio/transcripts to the traffic-data branch or anywhere public.** Feeds configured in `site.env` (`KANP_ATC_FEEDS`), default: Potomac GRACO 124.55 / BELAY 125.525 / BWI Final.
- `procedures.html` + `js/procedures.js` — Procedure Explorer: overlays any US SID/STAR/IAP on Leaflet (sectional/TAC/IFR layers) with a custom canvas 3D altitude view, transition-by-transition selection, flow animation, shareable `#apt=…&sel=…` links. Data: `data/procedures/` (index + per-airport JSON), regenerated each 28-day AIRAC cycle by `python scripts/build_procedures.py` (downloads FAA CIFP, stdlib only; leg-array layout documented in that file and mirrored in procedures.js).
- `weather.html` + `js/weather.js` — weather hub (wind compass, flight-window scoring, crosswind analysis, TAFs, radar)
- `pi/` — Raspberry Pi backend, Python 3 **stdlib only**
- `scripts/` — legacy Node collector, superseded by `pi/`; don't extend it

## Data flow (tracker)

Pi is the sole pipeline: `collector.py` polls airplanes.live every 3 s → SQLite `/var/lib/kanp/kanp.db` → `server.py` serves API + page on port 8787 (LAN HTTP): `/api/status`, `/api/tracks`, `/api/stats`, `/api/aircraft`, `/api/export.csv`, `/api/site-traffic`. `exporter.py` (hourly systemd timer) pushes simplified per-day JSON snapshots to the **`traffic-data` branch** (single amended commit; `tracks/index.json` lists days).

Frontend tries the Pi API first; off-LAN (or HTTPS mixed-content block) it falls back to the GitHub raw snapshots via `kanp-static.js`, mirroring the API's filter semantics client-side. Data there is up to 1 h stale.

**Pi deploy:** on the Pi, `git pull` in the repo checkout, then `sudo bash pi/install.sh` (copies to `/opt/kanp`, restarts services). Site deploys itself on push to `main`.

## KANP operational facts (assume, don't infer)

- All patterns are **left traffic** on both RWY 12 and 30 (`KANP.RWY.pattern = 'L'` in kanp.js). Don't infer pattern side from geometry.
- **Touch-and-gos are not permitted** — a `tng` profile in kanp-ops.js is a go-around or full-stop taxi-back (2 ops either way, per FAA counting).
- Single runway 12/30, true axis 107°/287° (~11°W variation). At snapshot resolution a taxi-back looks like one merged field contact.

## Weather page constraints (breaks silently if violated)

- **aviationweather.gov has no CORS** — never fetch it from the browser. METARs: `api.weather.gov/stations/{id}/observations/latest` (parse rawMessage). TAFs: same host, IWXXM XML via DOMParser.
- KANP has no sensor; obs come from KNAK (~3 NM NE). TAFs exist for KMTN/KBWI/KDCA only.
- NWS TAF visibility is meters from a fixed SM table (3200=2SM … ≥16000=P6SM) — decode via table, never divide by 1609.
- RainViewer free tiles cap at zoom 7 — keep `maxNativeZoom: 7`.
- NWS grid `ceilingHeight` uses −30.48 m as "no ceiling" — treat non-positive as null.
- Flight-window scoring uses the NWS grid (`gridpoints/LWX/113,76`), cross-checked against ForeFlight — **don't switch it to Open-Meteo** (Open-Meteo stays for CAPE, pressure_msl, winds aloft only). Hourly temps are bias-corrected against the latest KNAK obs.
- All wind math is °true throughout.

## Working style

- Jesse runs Claude on Windows; the Pi is remote — give him copy-paste Pi commands rather than trying to run them here.
- Test in the browser preview before pushing; the site is live on push to `main`.
- Related repo: `C:\Users\Jesse\Documents\GitHub\kanp-tracker-ios` (SwiftUI port of the tracker).
