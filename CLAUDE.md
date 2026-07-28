# CLAUDE.md

Personal website (jesselevine.net, GitHub Pages from `main`) + KANP flight tracker, weather hub,
and a set of interactive aviation explainers.
Plain HTML/JS/CSS — **no build step, no framework, no npm**. Leaflet is vendored in `js/vendor/`.
The only build tooling is two stdlib-Python data generators (`scripts/build_*.py`) whose output is
committed. Owner: Jesse, CFI/CFII/MEI pilot based at KANP (Lee Airport, Annapolis MD).

## Conventions

- **`js/site-config.js` holds all site-specific constants** (airport, coordinates, runway geometry,
  ops gates, nearby airports, TAF stations, snapshot URL, timezone) in one `SITE` global, loaded
  first on every page that needs it. Pi mirror: `pi/site.env.example` → `/etc/kanp/site.env` (read by
  the systemd units via `EnvironmentFile`). Edit these, not the consumers.
- **All headings/directions are °true** throughout the site (FAA true runway alignments; METAR and
  model winds are also true). Never magnetic.
- `css/main.css` is the shared stylesheet (dark theme, CSS vars, 760 px max-width). Every page uses
  it except the three self-contained toys/SDR pages (`bubbles.html`, `ctaf.html`, `scanner.html`).
- **Cache-busting is manual**: assets are referenced as `js/foo.js?v=N` / `css/main.css?v=N`.
  When you change a file that already carries a `?v=`, bump the number in every page referencing it
  — GitHub Pages caches aggressively and stale JS is the usual "my fix didn't deploy" cause.
- `.gitattributes` forces LF on `pi/*.{py,sh,service,timer}` — the Pi is Linux and CRLF breaks
  bash/systemd on checkout. Don't override it.
- `.nojekyll` is present; GitHub Pages serves the tree as-is. `CNAME` pins jesselevine.net.
- Never commit API keys — this repo is public. The tracker's optional RapidAPI key lives only in
  the visitor's `localStorage`.

## Layout

### Personal site

- `index.html` + `js/home.js` — landing page (flight-training services, contact, live card teasers).
  `js/home.js` lazy-loads `js/sim.js` (neon ball-physics easter egg) on first click of the ▶ toggle
  so its ~13 KB never costs a normal visit. `js/sim.js` is loaded *only* this way — it is not
  referenced from any HTML.
- `tools.html` — the Aviation Tools hub; the categorized index of the explainers below. The homepage
  links here rather than to each tool, so **a new explainer needs a card added to `tools.html`**.
- `404.html`, `robots.txt`, `assets/og.png`, favicons.
- `bubbles.html` — standalone `noindex` toy, self-contained, unlinked from navigation.

### Flight tracker

`kanp.html` — three tabs: Live / History Map / Traffic Study. Scripts load in dependency order
(`site-config` → leaflet → `kanp-static` → `kanp` → the rest).

- `js/kanp.js` — shared utils + Live tab (trails, heatmap, localStorage), plus `KANP.apiBase()` /
  `getTracks()` / `getStats()` data routing. Live polls every 3 s against the Pi (`PI_POLL_MS`,
  matching the collector) and every 60 s against snapshots (`POLL_MS`, which only change hourly).
  KANP = 38.9422, -76.5684, 60 nm radius (from `SITE.tracker`).
- `js/kanp-history.js` — altitude-colored historical tracks on a canvas layer, FAA VFR + NEXRAD overlays.
- `js/kanp-study.js` — stats (hour×day grids, histograms, type/operator breakdowns).
- `js/kanp-ops.js` — ops detection: contiguous "at the field" segments (inside `OPS_GATES`), classified
  by airborne context before/after into arrival / departure / go-around, attributed to runway 12 or 30.
- `js/kanp-climb.js` — Traffic Study sub-tool: climb-out comparison. Extracts the initial climb from
  each departure and plots altitude gained vs distance from liftoff (density-altitude comparisons).
  Altitudes are ADS-B barometric — fine for day-to-day gradient comparison, not true geometric gradient.
- `js/kanp-final.js` — Traffic Study sub-tool: straight-in comparison. Converts positions into a
  runway frame (`along` / signed `cross`) and ranks approaches by lateral precision and glidepath angle.
- `js/kanp-static.js` — GitHub-snapshot fallback data source (see Data flow).

Both sub-tools mirror `kanp-ops.js` detection logic — if you change how a field contact is
classified there, check all three.

### Aviation explainers (self-contained, no backend)

- `procedures.html` + `js/procedures.js` — Procedure Explorer: overlays any US SID/STAR/IAP on Leaflet
  (sectional/TAC/IFR layers) with a custom canvas 3D altitude view, transition-by-transition selection,
  flow animation, shareable `#apt=…&sel=…` links. Data: `data/procedures/` (`index.json` + ~3,070
  per-airport JSON files), regenerated each 28-day AIRAC cycle by `python scripts/build_procedures.py`
  (downloads FAA CIFP, stdlib only). **Leg-array layout is documented in that script and mirrored in
  `procedures.js` `decodeLeg()` — change both together.**
- `power.html` + `js/power.js` — The Power Curve: parasite vs induced power, minimum-power speed, the
  region of reversed command, slow flight, and a point-mass approach sim. Internals are SI; display
  converts to kt/hp/fpm.
- `eights.html` + `js/eights.js` — Eights on Pylons: pivotal altitude `PA = GS²/11.3`, side-view
  geometry, wind-aware full-figure simulation.
- `airlab.html` + `js/airlab.js` — Air Lab: atmosphere column, pressure/density altitude (NWS method,
  humidity), air-parcel stability sim, IAS→TAS→GS wind triangle.
- `knowledge.html` + `js/knowledge.js` — Aviation Knowledge Map: expandable canvas concept graph with
  dashed cross-links. See the build pipeline below.

### Weather

- `weather.html` + `js/weather.js` — wind compass, flight-window scoring, crosswind/runway analysis,
  TAFs, radar. See the hard constraints section below.
- `discussion.html` + `js/discussion.js` — DC Forecast Discussion: LWX AFD reader with jargon
  tooltips, a change log that word-diffs successive AFD issuances (plus a localStorage
  forecast-drift card), and a synoptic canvas built from an Open-Meteo GFS grid — air-mass fill,
  isobars/H-L, fronts detected from 850 hPa temp gradients signed by advection, wind particles,
  RainViewer radar at "now" / model precip at other hours, and a rule-based precip-cause
  diagnosis at DC. A verification card compares the morning forecast (localStorage snapshot)
  against KDCA METARs and explains busts from the hindcast (CAPE/CIN, front position).
  Same no-CORS rule as weather.html: never fetch aviationweather.gov.

### Backends

- `pi/` — Raspberry Pi backend, Python 3 **stdlib only** (`collector.py`, `server.py`, `exporter.py`,
  `trackutil.py`, `atc.py`, `install.sh`, systemd units).
- `pc/` — `atc_transcribe.py` (faster-whisper worker) + `atc_vocab.txt`. Runs on the PC, not the Pi.
- `scripts/api-collector.js`, `scripts/receiver-export.js` — legacy Node collector, superseded by
  `pi/`; don't extend it.
- `docs/receiver-setup.md` — RTL-SDR receiver wiring. **Its collector sections (0, 0.5, 4) still
  describe the legacy Node collector as "the setup in use" and are stale**; the receiver-hardware
  sections (1–3) are current. `pi/README.md` is the authority on the backend.

## Data flow (tracker)

Pi is the sole pipeline: `collector.py` polls airplanes.live every 3 s → SQLite `/var/lib/kanp/kanp.db`
→ `server.py` serves API + page on port 8787 (LAN HTTP): `/api/status`, `/api/tracks`, `/api/stats`,
`/api/aircraft`, `/api/export.csv`, `/api/site-traffic`, `/api/atc/*`. `exporter.py` (hourly systemd
timer) pushes simplified per-day JSON snapshots to the **`traffic-data` branch** (single amended commit;
`tracks/index.json` lists days). Track simplification is Douglas-Peucker in a local tangent plane
(`pi/trackutil.py`), shared by the exporter and the API; point tuples are
`[ts, lat, lon, alt, gs, on_ground]` everywhere.

Frontend tries the Pi API first; off-LAN (or HTTPS mixed-content block) it falls back to the GitHub raw
snapshots via `kanp-static.js`, mirroring the API's filter semantics client-side. Data there is up to
1 h stale. `KANP.apiBase()` auto-uses same-origin when the page is served over `http:` with a port
(i.e. from the Pi itself); `localStorage` `kanp_api_base = 'none'` forces snapshot mode.

There is **no data-source picker in the UI** — `kanp.html` has leftover `.settings-panel` CSS but no
panel, and the old browser-selectable sources (custom `aircraft.json` URL, ADS-B Exchange via
RapidAPI) are gone. `kanp_api_base` is set by hand; only `atc.js` still prompts for it. Routing is
automatic, so don't reintroduce a source selector without being asked.

**Pi deploy:** on the Pi, `git pull` in the repo checkout, then `sudo bash pi/install.sh` (copies to
`/opt/kanp`, restarts services). Site deploys itself on push to `main`.

## Knowledge map build pipeline

`data/knowledge/*.md` is the **source of truth** — one Markdown file per domain (`aero`, `air`, `emerg`,
`frame`, `hf`, `inst`, `man`, `nav`, `perf`, `power`, `regs`, `wx`) plus `_root.md`. Line grammar:
`- <label> [{#id}] :: <summary> [-> <target-id> "<link label>"] …`, 2-space indent = containment.

```
python scripts/build_knowledge.py     # from the repo root
```

compiles them to `data/knowledge.json` (fetched by the page) and validates — duplicate ids and
unresolved `->` targets are fatal. **Never hand-edit `data/knowledge.json`**; `js/knowledge.js` is only
the rendering engine. Commit the regenerated JSON alongside the Markdown. Full grammar:
`data/knowledge/README.md`.

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

## KANP operational facts (assume, don't infer)

- All patterns are **left traffic** on both RWY 12 and 30 (`SITE.tracker.runway.pattern = 'L'`).
  Don't infer pattern side from geometry.
- **Touch-and-gos are not permitted** — a `tng` profile in `kanp-ops.js` is a go-around or full-stop
  taxi-back (2 ops either way, per FAA counting).
- Single runway 12/30, true axis 107°/287° (~11°W variation, charted 120/300 magnetic). PAPI is a steep
  4.25° both ends (obstacles). At snapshot resolution a taxi-back looks like one merged field contact.
- Ops gates are deliberately tight (`NEAR_NM 0.8`, `LOW_FT 600` MSL) so pattern altitude (~1,000 ft MSL
  at ~1 nm) does *not* count as a field contact — only short final, the runway, and initial upwind.

## Weather page constraints (breaks silently if violated)

- **aviationweather.gov has no CORS** — never fetch it from the browser. METARs:
  `api.weather.gov/stations/{id}/observations/latest` (parse rawMessage). TAFs: same host, IWXXM XML
  via DOMParser.
- KANP has no sensor; obs come from KNAK (~3 NM NE). TAFs exist for KMTN/KBWI/KDCA only.
- NWS TAF visibility is meters from a fixed SM table (3200=2SM … ≥16000=P6SM) — decode via table,
  never divide by 1609.
- RainViewer free tiles cap at zoom 7 — keep `maxNativeZoom: 7`.
- NWS grid `ceilingHeight` uses −30.48 m as "no ceiling" — treat non-positive as null.
- Flight-window scoring uses the NWS grid (`gridpoints/LWX/113,76`), cross-checked against ForeFlight —
  **don't switch it to Open-Meteo** (Open-Meteo stays for CAPE, pressure_msl, winds aloft only). Hourly
  temps are bias-corrected against the latest KNAK obs.
- `solarTimes()` must anchor on the calendar day **at the airport's TZ**, not the viewer's browser
  timezone — browser-local Y/M/D put the UTC-midnight base a day off for viewers west of the field,
  pushing dawn/dusk outside the scored window so every hour read as night.
- All wind math is °true throughout.

## Verifying

`.claude/skills/verify` (the `/verify` skill) documents how to exercise the tracker without real
hardware or hitting public ADS-B APIs: a stub server that serves the repo root over http *and* fakes
the Pi API (`/api/tracks`) plus a dump1090-shaped `/aircraft.json`, driven with Playwright
(`executablePath: '/opt/pw-browsers/chromium'`). Use it before touching tracker data paths.

Otherwise: `python3 -m http.server` from the repo root and open the page.

## Working style

- Jesse runs Claude on Windows; the Pi is remote — give him copy-paste Pi commands rather than trying
  to run them here. Same for the SDR box behind Tailscale.
- Test in the browser preview before pushing; the site is live on push to `main`.
- Related repo: `C:\Users\Jesse\Documents\GitHub\kanp-tracker-ios` (SwiftUI port of the tracker).
