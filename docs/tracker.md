# Flight tracker (kanp.html)

Moved verbatim from CLAUDE.md. Sibling docs are in `docs/`; "above"/"below" references to other areas point there. Index: CLAUDE.md → Docs.

### Flight tracker

`kanp.html` — three tabs: Live / History Map / Traffic Study. Scripts load in dependency order
(`site-config` → leaflet → `kanp-static` → `kanp` → the rest).

- `js/kanp.js` — shared utils + Live tab (trails, heatmap, localStorage), plus `KANP.apiBase()` /
  `getTracks()` / `getStats()` data routing. Also the shared filter-bar widget
  (`initFilterBar(barId, onChange)` — range chips + ‹ › stepper; `readFilters()` re-applies a
  chip against now, never a stepped window), the classifiers `isGA` / `isHelicopter`
  (`AIRLINER_TYPES` / `HELI_TYPES`), the tri-state button helpers `triState` / `triFilter`, and
  `simplifyTrack(pts, eps, near)` (ring-aware — see `kanp-history.js`). Live polls every 3 s against the Pi (`PI_POLL_MS`,
  matching the collector) and every 60 s against snapshots (`POLL_MS`, which only change hourly).
  KANP = 38.9422, -76.5684, 60 nm radius (from `SITE.tracker`).
- `js/kanp-history.js` — altitude-colored historical tracks on a canvas layer, FAA VFR + NEXRAD
  overlays, and the trailing-7-days heat grid (its `markNow` flag draws a "now" line in today's row —
  left of it fresh data, right of it week-old; only meaningful for trailing windows, so the 60-day
  Live grid and Study grid don't set it).
  **Filter bar (reworked 2026-09-05):** the range is a chip row on its own full-width row
  (`.qr-field`, under From / To / Hours / Days — Jesse's order, 2026-09-05; the whole History bar sits *below* the map, also his call) — chip width grows with the range (`flex-grow` =
  1 + log₂ hours, set in `initFilterBar`, so 1 h is a stub and 30 d / 1 y stretch) — plus ‹ ›
  (`.qr-step`, slides the window by its own span; a day window steps by calendar days; › is
  disabled at now). Stepping deselects the chip so Load no longer slides the range back to
  now — From/To are then the range. A chip or step reloads the History tab
  (`initFilterBar(barId, onChange)`); the Study bar shares the widget but keeps its Run button.
  GA / Military / Helicopters (that order, Helicopters last) are **tri-state** buttons
  (`KANP.triState`: all → hidden → only, text `"<label> hidden"` / `"<label> only"`, state in
  `data-state`; the cycle is explained in each button's `title`, not on the page), client-side
  like the altitude band; rotorcraft = `KANP.isHelicopter` (ICAO type set `KANP.HELI_TYPES`,
  description fallback only for untyped, and an untyped track is *not* a helicopter — the
  tooltip says so). "KANP only" sits in its own `KANP` field beside its ops dropdown. **Button and
  option labels on this page are sentence case** (Today, Yesterday, Helicopters, Include, Pattern
  work, All traffic…) — Jesse asked 2026-09-05. **The History tab carries no explanatory copy**:
  the result line is empty until data loads, and the legend under the map is just the colour bar
  with `ground` / `40,000 ft` — Jesse cut the "layers ▛ top-right: VFR sectional… dashed ring 5 nm:
  sampled every second" line the same day ("get this shit off my page"). Don't put a how-to back.
  **KANP ops modes clip, they don't filter** (`applyKanpMode`): `lee` keeps whole tracks that
  touched the field; `pattern` keeps only laps — consecutive field contacts ≤ 8 min apart whose
  fixes stay inside 3 nm and ≤ 1,800 ft MSL (measured: real KANP laps run 1–5 min, all inside
  3 nm / 1,200 ft); `dep`/`arr` keep liftoff → 10 nm or 10 min (or the mirror), cut where the
  aircraft comes back to (or last left) the field, and a `tng` contact a lap away from its
  neighbour belongs to `pattern`, not to these. Contacts come from `KANPOps.analyze` (`ts`/`ts1`
  = first/last at-field fix). Clipped stretches become `breaks` the canvas honours, and the
  altitude band merges its own breaks into them rather than replacing them. The old whole-track
  "pattern" mode drew a one-lap-then-Easton flight in full — don't bring it back. **Per-runway leg modes** (`dep30` / `arr30` / `dep12` / `arr12`, 2026-09-05): `kanpModeParts()` splits the value into base + runway and `legWindows()` keeps only contacts whose `rwy` (the ops detector's attribution) matches, while the full contact list still supplies the lap / neighbour context — so the runway modes partition the plain one exactly.
  **Coarsening honours the 1 s ring and runs once, at load** (`coarsen()`): over `DRAW_LIMIT`
  points the fetched set is re-simplified at 0.08 nm *outside* `KANP.NEAR_NM` and left whole
  inside it. It used to (a) thin the ring too, throwing away ~90 % of the fixes the Pi had
  deliberately kept (`simplify_near_nm 0`) — the reason the pattern "didn't look better" on any
  range past ~24 h — and (b) run inside `render()` on every altitude-band tick and toggle
  (≈0.3 s per archived day, seconds on a month), which was most of the lag. The ring must stay
  at eps 0 even when coarsening: the ops detector and the clip modes read those fixes, and 0.01 nm
  there turned 5 pattern aircraft into 10 on the test day. `KANP.simplifyTrack(pts, eps, near)`
  mirrors `pi/trackutil.py` (tolerance `near.eps` inside the ring, run broken at each crossing).
  Coarsening barely shrinks the count anyway (361k → 330k on a day: the Pi already simplified at
  0.03 nm and the colour-bucket rule keeps every 500 ft crossing), so the screen cost lives in
  `TrackCanvas`: `setData()` projects every run **once** to zoom-0 Web Mercator (inline math, no
  per-point objects) and `_redraw()` scales/offsets plain numbers and **skips sub-pixel segments**
  (< 0.7 px from the last drawn point, never the run's last) — zoom-adaptive, so the 1 Hz detail
  is all there up close and free at 60 nm. The result line says `· coarsened` (tooltip explains)
  when the load-time pass ran.
- `js/kanp-study.js` — stats (hour×day grids, histograms, type/operator breakdowns).
  **Run study drives the whole tab (2026-10-01):** it fetches the stats and **one shared
  near-field track set** (10 nm / 4,500 ft, ground included — `KANPStudy.data()`, keyed on the
  filter bar). **The sub-tools stay behind their own Analyze buttons** (ops, climb, final,
  pattern, conflict) — for one day Run study auto-ran all five and Jesse asked why
  (2026-10-09: "did i ask for that?"); don't bring that back. Each button reads the shared set,
  clipped to its own box by `KANPStudy.clip()` — the same clip the server used to apply per
  fetch, so results are unchanged (checked on 2026-09-30: 108 ops / 38 climbs / 2 finals /
  30 legs / 3 events, old and new) — and fetches only when the filters moved; the conflict
  tool's "whole 60 nm" mode is still its own fetch.
  The result line reads `Loading analysis…` (amber, pulsing) and then, green with a glow,
  `N unique aircraft · N position reports · <range>` — **no `via GitHub snapshot` / age on this
  tab** (Jesse's call); the Live/History heat-grid labels keep theirs.
- `js/kanp-ops.js` — ops detection: contiguous "at the field" segments (inside `OPS_GATES`), classified
  by airborne context before/after into arrival / departure / go-around, attributed to runway 12 or 30.
  Each op carries `ts` / `ts1` (first / last at-field fix) — the History tab's clipping modes cut
  tracks at those, so keep both.
- `js/kanp-climb.js` — Traffic Study sub-tool: climb-out comparison. Extracts the initial climb from
  each departure and plots altitude gained vs distance from liftoff (density-altitude comparisons).
  Altitudes are ADS-B barometric — fine for day-to-day gradient comparison, not true geometric gradient.
  **Rate beside gradient (2026-10-02/09):** each climb carries `grad` (ft/nm, gain over ground
  to `GRAD_AT` 500 ft) and `rate` (fpm, the same gain over the climb's own timestamps — never
  gradient × GS), in the departures table, hover, summary, the per-reg ranking and a **By type**
  table (median per ICAO type, best rate first — the fleet comparison Jesse asked for). **The
  highlighted reg gets a smoothed mean curve** (`meanCurve()`: gain on a 0.05 nm grid where ≥ ⅓
  of its climbs reach, 5-point moving average) drawn breathing — `paintGlow()` blits a cached
  offscreen copy of the chart and strokes a **1.4 px line over a faint 5 px halo stroke** whose
  alpha rides a sine, plus a small white point of light running liftoff → top every ~3 s, under
  rAF (Jesse 2026-10-09: the first cut, a 3.5 px line with a 20 px shadowBlur, was "too thick";
  shadows blur into a band — use a wide low-alpha stroke, not shadowBlur), only while a reg is highlighted, idling (500 ms recheck) while the tab is hidden; any
  `renderChart()` stops the loop first. **Why some curves are smooth and others staircases:**
  altitude encoder resolution — N6289U (M20P), the PA23, RV7, DA40 report in 25 ft steps, most
  of the C172/PA-28 training fleet in 100 ft; not a data-rate difference (all ~2 s near the field).
  **Liftoff anchor (2026-10-09):** some transponders never set on-ground (N3383A), so the
  profile used to start at the last fix under the 600 ft gate and drew the climb beginning
  500–900 ft up at 0 nm (and a 1,914 ft/nm "gradient"). `onGround()` now also takes a fix
  rolling ≤ `TAXI_KT` 25 kt as a ground report (for the baseline and the origin), and with no
  ground fix at all the origin is the lowest-altitude fix in the contact. **`min climbs`
  chips** (1/2/3/5/10, `kanp_climb_min` in localStorage) hide aircraft and types with fewer
  climbs from both fleet tables and say `N hidden` — a short range makes one-climb rows.
  **Layout under the chart (2026-10-09, Jesse):** the chart, the `min climbs` chips and the
  per-reg ranking are open; **By type and the Departures table are collapsed `details.rush-fold`s**
  ("hide departures table. its huge and unhelpful, cant even see the graph while hovering").
- `js/kanp-final.js` — Traffic Study sub-tool: straight-in comparison. Ranks approaches by lateral
  precision and glidepath angle, working in the shared runway frame (`KANP.runwayFrame` in `kanp.js`):
  `along` = nm from the field along the extended centerline, + on the approach side; signed `cross`
  = nm off it, **+ to the left of the landing direction for either end**. That invariant is what lets
  12 and 30 share one picture — don't "simplify" it to a raw bearing rotation.
- `js/kanp-pattern.js` — Traffic Study sub-tool: pattern shape. Measures the downwind flown into
  every landing/low approach (each lap counted once, attributed to the contact that follows it) and
  plots the circuits as an equal-scale plan view plus downwind-width and pattern-altitude
  distributions — "what a normal KANP pattern looks like" as numbers. Same runway frame as
  `kanp-final.js`. Measurements integrate *along* each leg rather than averaging its points, because
  Douglas-Peucker leaves a steady downwind as few as two fixes; pattern altitude is the leg's
  **peak** over the abeam window, since a downwind is level and then descends.
  **ADS-B altitude is pressure altitude**, so AGL is taken against the field's own pressure altitude
  per hour, estimated from the low decile of what aircraft report *at the field* — deliberately not
  `kanp-climb.js`'s ground-fix-only estimate, which is fine there (it only uses differences) but
  degrades to charted elevation on the GitHub snapshots, where ground fixes carry no altitude. That
  fallback silently reported real 1,000 ft patterns as ~600 on a 30.2 inHg day. Don't unify the two.
- `js/kanp-conflict.js` — Traffic Study sub-tool: proximity events. Finds pairs of airborne
  aircraft that got close (user-set thresholds, default 0.5 nm / 500 ft), lists each event with
  its closest point of approach and a severity tier, and replays any event as an animated
  two-ship playback on the map. Method: every airborne track is linearly interpolated onto a
  shared 10 s timeline (across gaps ≤ 240 s — the rule `ctaf.html`'s clip matching copies), a
  (time × 1.5 nm grid-cell) hash finds candidate pairs cheaply, each refined at 1 s into
  contiguous in-threshold runs; ≥ 180 s of proximity is flagged as formation-looking, and a
  "pattern area only" toggle scopes the fetch. The page copy's honesty caveats are deliberate —
  both data sources serve Douglas-Peucker-simplified tracks, so CPA numbers come from
  interpolated straight segments (approximate, not evidentiary), only ADS-B-equipped aircraft
  appear, and altitudes are barometric. Keep them.
- `js/kanp-static.js` — GitHub-snapshot fallback data source (see Data flow).
- `js/kanp-rush.js` — **Airline Traffic tab** (2026-10-01, fourth tab, `#rush`): when the
  airliners come and go at BWI · DCA · IAD · ADW · MTN, and what that means at Lee. Reads
  **one document, `rush.json` on the `rush-data` branch** (`SITE.tracker.rushBase`;
  localStorage `kanp_rush_base` overrides it), compiled hourly by
  `.github/workflows/rush.yml` → **`scripts/build_rush.py`** (stdlib) from the traffic-data
  day files — the notam-data pattern: one force-pushed commit, the tree is the state, nothing
  on main grows; `days/YYYY-MM-DD.json` beside it holds every op of a day for the tab's "One
  day" view. Chips: airport · airline (the airport's top prefixes, `top`) · days (weekdays /
  Sat / Sun / all — US federal holidays are `hol`, kept out of the weekday mean) · range (7 /
  30 / 90 d / all). Every figure is a **mean per covered day**: `cov` is 24 chars per day,
  `1` covered, `0` the collector missed the hour (fewer than `COV_MIN` = 3 distinct aircraft
  in it — the 08-01 and 09-12 outages), `x` the exporter had not reached it yet; a `0`/`x`
  hour is left out of the mean, never counted as quiet. **Layout (rebuilt twice the same day —
  Jesse: "so data heavy, bars everywhere, huge tables", then "I kind of don't like that the
  airline traffic is operational specific. 'Best windows left today'. That should be
  concluded by me through basic data"): it states what was measured and draws no
  conclusions.** No quiet/busy tiers, no "now → lull", no best windows, no "where the jets
  are" sentence — those were built and removed; don't bring them back. The top is airport +
  airline chips, one result line, and a **Today card**: a 5a–11p strip with the usual arrivals
  per 15 min for today's day class as a soft area and today's actual arrivals as ticks (from
  `days/<today>.json`, so up to an hour behind — the legend says "as of"), a now-line, and one
  fact line (`so far → 125 arrivals · 134 departures · landing → RWY 15 121 · RWY 33 1`).
  Three tiles: arrivals / day · departures / day · arrivals so far vs the usual count by the
  compile time. Then **By airline**, always visible — the table Jesse asked for ("totals by
  company, right now that's a little hidden"): rows = airline prefixes, columns = BWI · DCA ·
  IAD · ADW · MTN · total, movements / day over the selected days, the selected airport's
  column highlighted, types at that airport as shares of the top three; airlines under 5 / day
  fold into one row, `other` = N-numbers / military / untagged, a total row; a row click
  filters the page to that airline. It reads per-day `co {PFX: [arr, dep]}` for every prefix
  (not just the `al` top-N series) and the archive-level `fleet`. Then five
  `details.rush-fold`s, each with a one-line summary in its header and rendered only when
  opened (a closed details has no width): **Day profile** (its own days/range chips, the
  mirrored arrivals/departures chart, **banks** = runs of slots ≥ 1.25× the day's median on a
  lightly smoothed series, a lone slot at 1.6×, hour × weekday grid) · **Runway and near Lee**
  (arrival runway share from the course on final, L/R not resolved, axes calibrated from the
  data's own course histogram: BWI 33 = 319° true, DCA 01 = 355°, IAD 01 = 002° / 30 = 289°,
  ADW 01 ≈ 001°, MTN 33 = 315°, each runway's share of arrivals within 5 nm of Lee below
  6,000 / 3,000 ft; unique airliners within 5 nm per hour by the lowest band each reached; a
  ±8 nm map of airliner seconds per 0.25 nm cell by band, all days, log scale — the 33L final
  shows as a streak NE of the field) · **Timetable** (the regulars: callsigns with spread
  ≤ 15 min seen on ≥ 60 % of their days, grouped by hour; the full sortable recurring table —
  a callsign seen on ≥ 4 days, median time over its last 30 sightings — in a sub-fold; there
  is no schedule feed, this is what the sky did) · **Approach-area load** (distinct aircraft
  per 15 min below 10,000 ft within 25 nm of BWI / DCA / IAD, airliner types only, and every
  aircraft below 6,000 ft within 15 nm of Lee — **an ADS-B count, labelled so, not frequency
  traffic**; the measured per-feed transmissions chart appears here once the exporter
  publishes it) · **One day** (date picker, every op of that day as a strip and a table).
  **Callsign caveat:** a day file carried one callsign per aircraft (the last seen) until the
  exporter started writing `flights` history (2026-10-01, `cs_hist`), so before that a
  turnaround's arrival carries its departing flight number — airline and timing are right,
  the number is not; `rush.json`'s `cs_hist_from` is the first exact day and the tab says so
  under the result line. Ops attribution: a track splits into flights at a 10-min gap or a
  5-min ground dwell; a flight whose last fix is within 3 nm of an airport and below field
  elevation + 1,500 ft (or on the ground) after having been > 5 nm out is an arrival there
  (stamped at the first ground fix, else the last fix), the mirror for a departure. Checked
  against two real days: BWI 313 / 290, DCA 465 / 454, IAD 492 / 513 per day. Shapes are in
  the script's docstring; `--selftest` covers attribution, runway reads, coverage, the
  schedule and the encodings (96-slot series are base-62 strings, `slot_alphabet`).
  `window.KANPRush._data()` for headless checks.

The climb / final / pattern sub-tools mirror `kanp-ops.js` detection logic — if you change how a
field contact is classified there, check all four (`kanp-conflict.js` is about aircraft pairs, not
field contacts, and doesn't care).

## Data flow (tracker)

Pi is the sole pipeline: `collector.py` polls the public ADS-B feeds every 3 s → SQLite
`/var/lib/kanp/kanp.db` → `server.py` serves API + page on port 8787 (LAN HTTP): `/api/status`,
`/api/tracks`, `/api/stats`, `/api/aircraft`, `/api/export.csv`, `/api/site-traffic`, `/api/atc/*`.
`exporter.py` (systemd timer — hourly in the repo unit, but the real Pi runs it every 15 min via a
local `override.conf` drop-in) pushes simplified per-day JSON snapshots to the **`traffic-data` branch** (single amended commit;
`tracks/index.json` lists days). **Since 2026-10-01 it also writes** (a) `flights: [[ts, callsign], …]` on
any track whose callsign changed during the day, with a top-level `"cs_hist": 1` so a reader can
tell "one callsign all day" from "history not recorded", and (b) `v2/atc/YYYY-MM-DD.json` — per
recorded feed, transmissions and airtime seconds per 15-minute slot, read from `pi/atc.py`'s
`<mount>/<day>.jsonl` (timestamps and durations only; the recorder's purge does not touch the
export; `summary.json` marks the day `"atc": 1`). Both feed `scripts/build_rush.py`. The exporter
runs as `kanp` under `ProtectSystem=strict` with `ReadWritePaths=/var/lib/kanp`, which is where the
ATC stick is mounted — `KANP_ATC_DIR` is the one env var both scripts read. Track simplification is Douglas-Peucker in a local tangent plane
(`pi/trackutil.py`), shared by the exporter and the API; point tuples are
`[ts, lat, lon, alt, gs, on_ground]` everywhere. **Inside the collector's 1 s
near-poll ring (`KANP_NEAR_RADIUS_NM`, 5 nm) the tolerance is its own**
(`KANP_SIMPLIFY_NEAR_NM`, default 0 = keep every fix): DP is a *spatial*
filter, so at 0.03 nm a straight downwind collapsed to its endpoints however
fast it was sampled, and the near poll's extra fixes never reached the map.
The run breaks at each ring crossing so neither tolerance leaks across it.
The ring is drawn on both tracker maps as a dashed grey circle
(`KANP.addAirport`, `SITE.tracker.nearNm` — mirror of the Pi env).

Frontend tries the Pi API first; off-LAN (or HTTPS mixed-content block) it falls back to the GitHub raw
snapshots via `kanp-static.js`, mirroring the API's filter semantics client-side. Data there is up to
1 h stale. `KANP.apiBase()` auto-uses same-origin when the page is served over `http:` with a port
(i.e. from the Pi itself); `localStorage` `kanp_api_base = 'none'` forces snapshot mode.

Day files run 10–16 MB, so aggregate queries in snapshot mode never read them when they can avoid
it: the exporter also publishes per-day **stats sidecars** (`v2/stats/YYYY-MM-DD.json`, ~500 KB —
per-aircraft hour buckets + day-level altitude histograms; shape documented in `pi/exporter.py`,
consumed by `statsGetStats`/`getFieldGrid` in `kanp-static.js` — **change the two together**).
`KANPStatic.getStats` serves unfiltered/GA week-plus windows from the sidecars (the Live 60-day
grid, History 7-day grid, GA/KANP heat toggles — the old path downloaded every raw day file in the
window, hundreds of MB); anything else, and any window whose sidecars aren't published
(`"stats": 1` per day in `summary.json`), falls back to the raw day files. Today's re-polled files
skip the multi-MB re-parse when the body is unchanged (`freshJson` — length + head compare, because
raw.githubusercontent doesn't expose `ETag` via CORS).

There is **no data-source picker in the UI** — `kanp.html` has leftover `.settings-panel` CSS but no
panel, and the old browser-selectable sources (custom `aircraft.json` URL, ADS-B Exchange via
RapidAPI) are gone. `kanp_api_base` is set by hand; only `atc.js` still prompts for it. Routing is
automatic, so don't reintroduce a source selector without being asked.

**Pi deploy:** on the Pi, `git pull` in the repo checkout, then `sudo bash pi/install.sh` (copies to
`/opt/kanp`, restarts services). Site deploys itself on push to `main`.

