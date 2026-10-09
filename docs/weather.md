# Weather pages

Moved verbatim from CLAUDE.md. Sibling docs are in `docs/`; "above"/"below" references to other areas point there. Index: CLAUDE.md → Docs.

### Weather

- `weather.html` + `js/weather.js` — wind compass, flight-window scoring, crosswind/runway analysis,
  TAFs, radar. See the hard constraints section below.
  **Density altitude** (conditions card, DA chart, flyability score) is the NWS humid method,
  `densityAltFt()` — the same formula as airlab.js/almanac.js, so the hub's "now" matches the same
  hour in the almanac; don't swap the dry 118.8 ft/°C shortcut back in. TAF visibility is decoded
  through the SM table for the category dot too, not just the label (4800 m is 3 SM/MVFR, not
  2.98/IFR). **TAF cards print issuance age and flag anything over 6 h old** — the NWS TAF
  collection froze for days in Aug 2026 and "issued 6:57 PM" with no date read as tonight's.
  **First paint comes from the archive** (`paintFromArchive()`, 2026-09-01): `latest.json` is
  same-origin and answers in milliseconds where api.weather.gov has taken 20 s, so on the first
  load every METAR-driven card (compass, conditions, sun, sky wash, nearby fields, radar markers)
  is drawn from the archived obs, labelled "via site archive", and replaced when the live jobs
  finish (`state.gen`/`state.liveGen` keep a slow archive from overwriting a faster live render).
  The flight windows stay live (they need the model). **TAFs read the archive too**
  (`archiveTaf()`, 2026-09-02): `latest.json`'s `tafs` carries each station's newest issuance,
  decoded (`periods`) when the live archiver caught it and raw text (`raw`, `bf`) when
  `heal_tafs()` filled it from IEM — the page loads `js/taf-tac.js` and decodes the raw form.
  The newer of the archive's and NWS's issuance wins and says which it was ("via site
  archive"); the stale flag now means neither source has anything under 6 h old. The NWS TAF
  collection froze on 2026-08-30 22:57Z and was still frozen on 09-02, so for those days every
  TAF on the hub was the archive's. **The status line names what is partial** ("Partial data ·
  no ob: KFME") — a bare "Partial data" read as a page fault when it was one dark AWOS. `archiveLatest()` bypasses `WXA`'s per-tab cache on refreshes so the
  archive fallback is never older than the archiver's last run.
  `renderSkyWash()` paints a gentle fixed gradient behind the page from the sun phase at the field
  plus the latest KNAK ob (blue day / indigo night / amber twilight, greyed by an overcast, steel
  for rain, violet for thunder, pale for fog) — alphas are low on purpose and it crossfades between
  two layers so the 5-minute refresh never flashes; cards are opaque so it lives in the margins.
  **PIREPs · AIRMETs/SIGMETs · TFRs cards + the ring on the radar map** (2026-09-01): read
  from `latest.json` only (aviationweather.gov / tfr.faa.gov have no CORS), stamped `as of
  HH:MM` and flagged over 3 h old — hourly, never live. PIREP rows: age, nm/°true from the
  field, altitude, type, then only the decoded bits present (/TB /IC bands, sky, wx, temp,
  wind); click for the raw report. G-AIRMET snapshots are valid *at* a time (expire == valid),
  so they print `valid HH:MM`, not a zero-length range. Every archived METAR station is drawn
  on the radar map (`updateRingMarkers()`, coords from `SITE.weather.stationCoords`) colored
  by category with a permanent `ID ceiling-in-hundreds` label, grey-ringed when > 3 h old,
  the raw METAR in a popup — the map reads as a ceiling picture.
- `sky.html` + `js/sky.js` — METAR Sky: the current observation painted as an animated canvas
  scene — sky color from the real sun position (NOAA solar math anchored to the airport's TZ,
  same rule as `solarTimes()`), cloud decks at their reported bases, precip/fog/lightning from
  the present-weather groups, a windsock flying the actual wind — plus a token-by-token METAR
  decoder, TAF timelines rendered as clickable mini-scenes, a ±12 h timeline (Open-Meteo
  temp/dew/pressure between obs, bias-corrected against obs at "now"), a density-altitude series,
  and a paste-any-METAR box. Stations = the field + `SITE.weather.nearbyAirports`. The renderer
  is a **pure function of (conditions, sun, t)** — the same code paints the live scene, TAF
  thumbnails and previews; keep it side-effect-free. Data: `api.weather.gov` (METAR obs +
  IWXXM TAF) and Open-Meteo only — never aviationweather.gov.
- `sky2.html` + `js/sky2.js` — METAR Sky II: sky.html's successor — a pinhole camera standing on
  the field, pannable 360° and up to the zenith, everything placed by real azimuth/elevation:
  sun/moon/planets and ~85 naked-eye stars from Meeus low-precision series (constellation
  figures, Milky Way band), cloud decks in true perspective via a Mode-7-style row loop (a
  ceiling closes overhead and converges at the horizon), Koschmieder distance fog so reported
  visibility is where the treeline and runway lights actually vanish, and the runway on its real
  true heading with the windsock streaming the wind. Adds a runway wind brief, density-altitude
  performance and VFR-legality readouts, and a flight-category ribbon. Same data rules and
  pure-painter design as sky.html, but the code is **copied forward, not shared** — a
  parsing/data fix in one probably belongs in both. **Deliberately unlinked** (no tools.html
  card, no sitemap entry; indexable) — sky.html is the one on tools.html.
- `wx3d.html` + `js/wx3d.js` — The Air Above: the GFS forecast as a rotatable 3-D volume
  (~120 nm across × 40,000 ft, vertical exaggeration **×7.5 by default and user-set ×1–20** by the
  top-bar slider — `setZScale()` re-derives everything cached in world z, so the terrain mesh stores
  feet and converts at draw time; the choice persists in `wx3d_layers` and the footer disclosure
  tracks it).
  **Centered on KDCA, not the field** (`SITE.weather.wx3d` — Jesse's choice: DCA is the region's
  natural center and the site's verification station; KANP draws as a landmark pin). Deliberately
  chrome-light — no subtitle, no how-to card, no range rings ("this is a DATA page"); the honesty
  disclosures live in the footer line. Two
  nested **domains** share every code path: the local box (5×5 columns) and a multi-state box
  (~650 nm / 750 sm, 7×7 columns, coarser on purpose) reached by the top-bar chips or by zooming
  out past the local limit — `zoomTo()` switches domains with the apparent size continuous, and
  per-domain caches (grid data, terrain, ground texture, radar composite) make flips instant
  after the first. Camera: drag orbits, shift/right-drag (or two-finger drag) pans, wheel zooms.
  Hand-rolled **orthographic** canvas 3-D: every horizontal surface (ground map, each cloud deck)
  is an offscreen texture drawn with one affine transform — legal only because the projection is
  orthographic — and the scene paints bottom-up (correct painter's order for stacked horizontal
  layers with pitch clamped ≥ 3° — at 0° a horizontal plane projects to a zero-height
  parallelogram, so the decks and the ground map vanish and coplanar layers have no painter
  order; don't switch to perspective without redoing both). Cloud decks
  are per-pressure-level cloud cover (noise-thresholded so opaque share tracks the model's number)
  at their per-hour geopotential heights; winds-aloft arrow layers per level plus a WMO barb staff
  at the field (NH convention, feathers 90° clockwise of the upwind shaft); a **flow mode** (chip
  in the winds-aloft row) advects ~8,000 altitude-holding tracers through the volume — trilinear
  between the grid columns and the 11 wind surfaces (10 m + ten pressure levels to 200 mb), AND
  **interpolated in time** (the field for hour i and i+1 are both kept and blended: live minutes
  past the hour at "now", continuously through play), ≈2,900× time-lapse (×3 more in the wide
  domain, disclosed), an 8-step lerped speed-color ramp, world-space lagging-tail streaks (so
  trails orbit with the volume) bucketed between the cloud decks for occlusion, FPS-governed like
  glow.html's swarm — no vertical motion in the data, so tracers hold altitude, and the page says
  so. A dual-thumb **altitude-band slider** (visible only in flow mode) confines tracers to a
  layer, drawn as dashed frames + a bright axis segment in the scene; in flow mode the
  winds-aloft chips stop meaning "draw arrows here" and become presets for that band —
  each level takes the slab between its neighbours' midpoints (`flowBandFor()`), clicking
  the chip that already owns the band drops back to its arrow layer, and clicking `flow`
  again reopens the whole column (`state.bandLev` remembers which chip set it); the freezing surface
  is a warped per-grid-point mesh; precip columns rise to the lowest cloudy deck. RainViewer radar
  drapes the ground **only at the "now" hour** — other hours get a model-precip stain, captioned
  (same honesty rule as discussion.html's radar swap; radar tiles at z7 local / z5 wide). The
  ground is a real map: `data/wx3d/terrain.json` + `terrain-wide.json`, built by
  `python scripts/build_wx3d_terrain.py` (no args / `--wide`) — USGS 3DEP `ned10m` locally and
  `srtm90m` for the wide box (ned stops at the border and the wide box clips Ontario; SRTM
  reports lakes at their surface height, so the script **flattens large flat regions to 0** or
  the Great Lakes would read as land) via the OpenTopoData public API — **not** Open-Meteo's
  elevation endpoint, which weighs each coordinate as a call and 429s a 192×192 grid. Output
  committed, rerun only to change the landmark list or re-site; the page bbox-validates each
  file so a stale one is dropped, not misdrawn. Water is wherever the hydro-flattened DEM says sea level — that one rule draws the
  Bay and the tidal rivers with no coastline data; land is hillshaded hypsometric tint baked into
  the flat affine ground texture (so radar still drapes with one transform), ground above ~90 m is
  *additionally* drawn as a displaced mesh at the same exaggeration as the air (radar paints flat at
  z=0, so echoes can visually underlie the NW ridges — known, accepted), and the JSON's landmark
  list (cities, BWI/DCA/ADW, the Bay Bridge, peaks locally; big cities + Appalachian summits
  wide) draws as screen-space pins. Data: Open-Meteo `gfs_seamless` — one multi-location grid
  call per domain (responses are arrays in request order; the wide call skips the per-level RH
  fallback to stay lean) and one full-fidelity column at the center for the readout + level
  heights — plus the KDCA METAR line. **Those calls are normally made once an hour by
  `scripts/wx3dsnap.py` (`.github/workflows/wx3dsnap.yml`), not by the browser**: Open-Meteo
  weights a request by locations × variables × range, so a 25-column grid per page view earned
  HTTP 429s. The snapshot is force-pushed as a single commit to the **`wx3d-data` branch**
  (~900 KB/run — history would add ~20 MB/day to main; same amend-and-force pattern as the
  tracker's `traffic-data`) and read over raw.githubusercontent via
  `SITE.weather.wx3d.snapshotBase`. The page validates `gn`/`span`/`center` like it does the
  terrain files and **falls back to calling Open-Meteo live** when the snapshot is missing,
  built for a different box, or older than 3 h; a stale snapshot is still kept as the
  fallback's fallback (a stale sky beats no sky). The `#chip-model` chip says which one is on
  screen and how old it is — snapshot age is a different claim from live, so it is never
  hidden. The wide domain is **not** pre-fetched; `switchDomain()` loads it on demand.
  Live responses are also cached per clock hour in `sessionStorage`, so a reload or a Refresh
  inside the hour costs nothing. **`wx3dsnap.py` mirrors `DOMAINS`/`LEVELS`/`gridUrl()`/
  `centerUrl()` from `wx3d.js` — change the two together** (`--selftest` covers the geometry
  and rounding). Changing the center means rerunning the terrain builds (both boxes) — the
  page bbox-validates and drops mismatched files. Layer/wind-level choices persist (`wx3d_layers`); read-only
  `window.WX3D_DEBUG` drives it headlessly.
- `discussion.html` + `js/discussion.js` — DC Forecast Discussion, led by a **headline card**
  ("the big story") and then laid out as a four-act story
  (I setup / II reasoning / III revisions / IV verdict). The headline engine scores candidate
  stories — active NWS alerts, convection, a frontal passage, a rain episode, heat, cold, wind,
  fog, a quiet pattern — off the same sources the acts use (`buildStories()`; alerts come from
  `api.weather.gov/alerts/active`, everything else is derived at DC from the GFS grid and the NWS
  daily forecast). Highest score leads, the rest become the "also" lines, and it degrades source by
  source: no grid → forecast + alerts, no NWS → model only, nothing → the AFD's own KEY MESSAGES.
  **The card must never go quiet about a day it could have mentioned** — a reader who cancelled a
  flight on the morning forecast reads silence as "threat gone". **And it answers "why", not just
  "what"**: the LWX DISCUSSION is mined back into its KEY MESSAGE blocks (`afdStoryBlocks()` —
  `KEY MESSAGE n...` heads, the `... DESCRIPTION` variant folded in, older NEAR/SHORT/LONG TERM
  sections reading the day range from the header qualifier), each block mapped to local dates from
  its own day words (`daysFromPhrase()`) and reduced to the one sentence naming the mechanism
  (`driverSentence()`: driver terms + motion verbs score it, model-chat is docked, naming more of
  the block's days wins ties — so "a surface low develops near the VA Tidewater" beats the
  Friday-lull sentence for a Fri–Sat block). The lead story renders that sentence as
  "The driver · LWX"; **"The week"** (7 forecast chips + one driver row per block, `renderWeek()`)
  carries the coming days. Stories reach the **full 7-day forecast** — per-day
  `fcstorm:`/`fcwinter:`/`fcwind:` keys so two storm days both surface, a flattened lead-time
  penalty instead of the old +60 h cutoff — with decks honest about the ~2-day GFS window ("Past
  the ~2-day GFS window this page reads", and no GFS claims at all when the grid never loaded),
  the quiet story naming the first chance beyond the grid, and a lead that opens a multi-day wet
  stretch saying so in one clause ("Not a one-day event — chances stay up through Sunday, drier
  Monday"). A story phrase naming a feature the map can verify — the mechanism clause's front
  or surface low, the quiet story's high — carries a **text→map link** (`mapAnchor()` keeps the
  detected feature's lat/lon; features outside `SYN.VIEW` stay plain text): the phrase renders
  as a dashed-underline `.map-link`, hover draws an SVG leader line from the phrase out into
  the right margin and down (or up, for "Also in play") onto the synoptic map, ending in a
  pulsing ring + label on the feature, and click pins it and scrubs the map to the model hour
  the claim is about — legal only because the map never pans/zooms, so feature container
  positions are fixed. The scored story stays in the
  headline card (with the AFD's own `WHAT HAS CHANGED`, labelled "LWX changes", and a
  "Model vs LWX" line — `renderSplit()` — that speaks only when the GFS point read and the
  NWS forecast/AFD disagree about precip or storms in the next 36 h, silent on agreement);
  everything that isn't the headline sits with the act it belongs to: runner-up stories under the Act I map,
  the distilled story + physics in Act II, and the today/+1/+2 comparison (`outlook()` →
  "Since this morning", Act III) naming each day's forecast wording against the **first archived
  forecast snapshot of today** (`morningSnap()`) — flagging `flip` when convection appears or
  disappears, and saying "unchanged since 2:40 AM" out loud when it hasn't moved. Same reason the
  drift rows print `short` next to the numbers: "unchanged" beside a bare 64% never tells you the
  64% is thunderstorms. **Keep page copy terse** — label, fact, done.
  Act II's "big picture" card leads with the AFD's **here-and-now paragraph** (`nowLead()`:
  paragraphs scored by present-tense sentences vs other-day references), because the LWX
  DISCUSSION format opens with an essay on the *biggest* day of the week — first-sentence
  extraction once led with Sunday's severe setup while it was raining outside. No now-paragraph
  (typical of evening issuances) → the old first-reasoning-sentence lead.
  Below it: a synoptic canvas built from an
  Open-Meteo GFS grid — air-mass fill, isobars/H-L, fronts detected from 850 hPa temp gradients
  signed by advection, wind particles, RainViewer radar at "now" / model precip at other hours,
  and a rule-based precip-cause diagnosis at DC; the LWX AFD reader with jargon tooltips; a
  change log that word-diffs successive AFD issuances (every entry collapsed on load) plus a
  forecast-drift card; and a
  verification card (Act IV) built as a **front that sweeps with the clock**. Forecast windows
  close at different times, so each is checked when *it* closes and everything ahead is listed
  under "still open" rather than judged — the card must never render a verdict on a window that
  has not closed. (It used to compare whole-day aggregates against observations-so-far, which
  could only be honest near midnight: at 9 AM a 60%-PoP day whose storms fire at 4 PM took the
  "expected storms, got none" branch and explained the bust in the same confident voice it would
  use for a real one — the same failure mode as the headline card going quiet.) A ‹ › pager
  rebuilds the same card for any archived past day, where every window has closed; days the grid
  stream doesn't reach degrade to day rows plus an unjudged "what fell" line rather than scoring
  a forecast that was never captured. **Lead tabs** (`VF_LEADS`, 2026-09-22): 1 week / 3 days /
  1 day prior / morning of — `leadSnap()` takes the earliest snapshot archived on D−n that reaches
  D (the NWS 7-day list reaches D only from D−7's evening; the grid is 48 h, so 3+ days out has
  no hourly rows and rain/thunder are judged against the day's wording). The ceiling row judges **height bands on top of flight
  category** (`ceilBand()`: the LIFR/IFR/MVFR edges, then 3/5/10 k splits of VFR) — a 3,000 ft
  deck and a clear sky are both VFR but not the same forecast, so the row prints both heights,
  a same-category day ≥2 bands off scores ≈ not ✓, and a missed hour is named with
  called-vs-saw (`catCause()`: the ceiling or the visibility, whichever drove the category).
  Two low-cloud checks sit on top (added 2026-08-31, when 1–3 k SCT/BKN developed under an
  all-VFR grid call and the card read it as a ✓): the ceiling row also flags **scattered layers
  ≤ 3,000 ft** the grid never carried (`metarObs()` tracks `lowFt`, the lowest SCT+ base —
  SCT020 is "no ceiling" to the category math but still boxes in a VFR lesson; a clean row
  degrades to ≈, never stays ✓), and a **"Low clouds, area" row** sweeps
  `SITE.weather.areaStations` (BWI/FME/ADW/DCA/GAI/W29/ESN/CGE — read from the `stations/<ID>/`
  ring plus KDCA's own stream, topped up from `latest.json` when live, with a live-NWS
  per-station fallback for today only if nothing is archived; NWS wants `KW29` where the
  archive says `W29`), because one hourly AUTO station is a bad witness —
  that day W29/ESN/ADW held BKN 1–2 k while KBWI read FEW. A station with no data contributes
  nothing: absence is never scored as a clear sky.
  Sources are
  labelled per row because four places are involved: **the DC point** is the forecast being
  discussed, **KDCA** (`obs/`) is what verifies it, **KANP** is the NWS hourly grid behind the
  field rows, and **KNAK** (`fieldobs/`, ~3 nm NE) is what those field rows verify against —
  KANP has no on-field sensor. Day rows (low, high, thunder) stay on KDCA; field rows (ceiling,
  vis, wind, rain) use KNAK when the archive has it and **fall back to KDCA ~25 nm NW, relabelling
  themselves and saying why**, for any day before the stream existed. **Thunder deliberately
  stays on KDCA even when KNAK is available** — KNAK is AUTO, and an automated station only
  reports TS if it carries lightning detection, so absence there is not evidence of absence.
  **Observations are the archive first, the live NWS store as a top-up**: archive commits land every
  few hours, so at 8 PM the newest archived KDCA ob could be 4:52 PM, and the card was blind to
  exactly the storm window it exists to judge. Whenever the archive's newest ob is over an hour
  old, live obs since then are merged in without replacing an archived entry (KNAK too). And an
  advertised hour counts as *observed* only by an ob taken after the hour was mostly over
  (`covered()`: inside it past its first half-hour, or in the half-hour after) — rounding obs to the
  nearest hour let a 4:52 ob "cover" a 5 PM storm window and call it empty. The "why" paragraph
  follows the same rule: an unobserved window is never explained as a bust.
  Advertised-vs-observed precip must overlap in time to score a
  hit (`overlapsHours`): an advertised 2 PM shower and an observed 4 AM one are both "rain
  today" but are not the same event. **And an advertised hour with no observation is not a bust** —
  the rain and thunder rows check that the advertised hours are actually archived before scoring
  them, and say "not judged — the hours are not archived" otherwise, the same rule the ceiling and
  wind rows already followed by construction. Scoring absence-of-evidence as a bust explained a
  failure that may never have happened. Busts that closed are explained from the hindcast
  (CAPE/CIN, front position). The drift card is a 7-day strip centered on today
  (`DRIFT_SPAN`): behind today it verifies — archived METAR high, plus the overnight low read
  from the **next** day's pre-09:00 obs, since the NWS "low" for day D is D+1's minimum —
  against the first forecast snapshot archived that morning; today and ahead it diffs the live
  forecast against the baseline snapshot. History (change-log depth, drift/verification
  baselines) prefers the **`data/wx/` archive** written hourly by the wxarchive GitHub Action
  (`SITE.weather.archiveBase`, same-origin), falling back to the live NWS API + localStorage
  for anything the archive lacks. Same no-CORS rule as weather.html: never fetch aviationweather.gov.
  **Timing, not just the daily number (2026-09-20, v42):** Monday's daily precip went 45 → 86 %
  in a day while its daylight hours dried out — the whole rise was Monday night — and "↑41" read as
  "tomorrow got worse". Three things in Act III now show it: each "Since this morning" row carries
  the day's precip **path** across every forecast archived today (`popPath()`, "45 → 75 → 91 → 86%",
  repeats folded) and a **day / night split** (`AVN.dayNight()` / `AVN.fillDayNight()` — peak hourly
  PoP from the KANP grid, day 6 AM–6 PM, night 6 PM–6 AM, only hours both grids carry, labelled KANP
  because the row itself is the DC forecast; `moved later` / `moved earlier` when the halves move
  ≥ 10 opposite ways); and a **then-vs-now card** (`#thennow-card`, `renderThenNow()` in
  `discussion-avn.js`): tomorrow's 24 hours twice, this morning's first archived grid over the
  live one — cell colour = category, white fill = PoP, bolt = thunder, amber bar = moved. Hidden
  when the two grids share fewer than 6 of tomorrow's hours.
- `js/discussion-avn.js` — the aviation layer on `discussion.html`: the NWS hourly grid at the
  field as a 24 h flight-category strip — one cell per hour, night dimmed, a bolt where the grid
  carries thunder, an amber bar where the hour moved since the morning snapshot, hover for the
  numbers, and a one-line plain reading of where the windows are — plus "what moved in the TAF and
  why". Sunrise/sunset is the NOAA sunrise equation anchored on the **field's** calendar day
  (checked against a published 06:11 EDT sunrise), same rule as `weather.js` `solarTimes()`.
  **TAFs are fetched but deliberately not displayed** — `weather.html` already decodes them and a
  second decoder here only crowded Act II; they exist here as the evidence behind the change
  block. KANP has no TAF, so the terminals watched are KMTN/KBWI/KDCA. IWXXM XML via DOMParser
  exactly as `weather.js` does it (visibility decoded from the fixed SM table, never by dividing
  by 1609). **The change comparison reads the archive first** (2026-09-04): `loadTafPair()`
  takes every issuance from today's and yesterday's `taf/` day files (`WXA.day`, decoded
  `periods` or raw text through `js/taf-tac.js`, which the page now loads), adds whatever the
  NWS `/stations/{id}/tafs` collection lists that the archive lacks within 90 s, and diffs the
  newest against the oldest from today. Rows and the no-change line say `via site archive`
  when that is where the issuance came from. It used to read NWS alone, and the collection's
  freeze from 08-30 left the block reporting "newest TAF 5 d old" while IEM-healed issuances
  sat in the archive. Both issuances are flattened to one entry per hour before diffing —
  change groups never line up otherwise. The "why" (
  `whyThunder()`) is read off the GFS grid `discussion.js` already loaded, sampled at the field:
  CAPE, CIN (from the DC point call, ~20 nm west and labelled as such), precip and spread. The
  grid table prints the NWS `weather` array verbatim — **that array is what drives the
  thunderstorm icon in every app rendering this data**, so it is the honest answer to "why is
  there no TS symbol". Same `ceilingHeight` −30.48 m sentinel rule as weather.html.
- `wxai.html` + `js/wxai.js` — AI Weather Analysis (2026-09-05): `latest.json` (via `WXA`) flattened
  into one text block (`buildContext()`: KNAK/KDCA/ring METARs, TAFs, the NWS grid, GFS CAPE/CIN/precip,
  winds aloft, the sounding, forecast days, alerts, AIRMETs/SIGMETs, PIREPs, TFRs, the AFD; ~4k tokens)
  and POSTed straight from the browser to `api.anthropic.com/v1/messages` (streamed SSE, header
  `anthropic-dangerous-direct-browser-access`). **The key is the visitor's, in localStorage
  `anthropic_api_key`, never in the repo** — no backend exists to proxy it. Tasks in `TASKS` each name a
  default model + effort (**Sonnet 5 for everything but quick look → Haiku** — Opus 5 hit the Console tier's rate limit on every heavy task, 2026-09-05, so it is opt-in via the select; a 429/529 waits `retry-after` and retries up to 3×, stepping a bigger model down to Sonnet after two tries and saying so in the usage line);
  a `model` select overrides per task; the context block carries `cache_control` so runs inside 5 min
  share it. Opus 5 / Fable 5.1 requests send `fallbacks: "default"`; Fable omits `thinking`. Usage and
  an estimated cost (`MODELS[].price`) print under every answer; `refusal` / `max_tokens` stops are said
  out loud. **Unlinked and `noindex`** (no tools.html card, no sitemap entry, not in `wxnav.js`) — reachable by URL only, Jesse's call 2026-09-05. Every run is saved to localStorage `wxai_history` (200 max, halved on quota) and listed in a collapsed History card at the bottom. `window.WXAI_DEBUG` for headless checks.
- `almanac.html` + `js/almanac.js` — Weather Almanac: the `data/wx/` archive as a reading room.
  A GitHub-style calendar (each day its worst *daytime* 8 am–8 pm category), then per-day cards —
  the day meteogram, the forecast lead-up table, the morning grid table, alerts, the station
  explorer, TAF vs METAR, radar, PIREPs, AIRMETs/SIGMETs/TFRs, the sounding, every AFD
  issuance — and a whole-archive temperature/category strip.
  **Cut 2026-09-02 at Jesse's request ("justify or remove"):** the forecast-drift *chart*
  (42 near-identical points over a six-day lead-up, no readable axis) is now a table — one row
  per morning the call was archived, high / low / precip % / wording, then what verified; the
  morning-grid *chart* (CAPE, precip rate and PoP on three scales in one plot — the meteogram's
  own one-scale rule, broken one card down; and the meteogram already draws the morning grid
  dashed and the GFS lanes) is gone, the hour-by-hour table stays, folded; the **TAFs card is
  gone** — the station explorer holds every issuance under its station, and now sits in the
  TAFs card's old slot; **PIREPs are raw text only, folded by default** — the /TB /IC /SK decode
  was removed on both this page and the hub because the reports drop the format too often
  ("pilots/controllers/systems abandon the customs often") for a decoded line to be trusted;
  time and nm/°true come from the report's stamped position. Radar dots carry their station id
  on the big frame. Don't bring the charts or the decoder back without being asked. Reads **only** `WXA`: no live weather
  API anywhere on the page, and a card whose stream isn't archived hides itself.
  The meteogram is the page's centrepiece and has rules worth keeping:
  - **Stacked lanes, one scale each — never a second y-axis on one plot.** Two measures on two
    scales invent a correlation out of wherever the scales line up; the shared crosshair is what
    ties the lanes together. A new measure is a new entry in `LANES` (label, unit, hue, `avail`,
    `fmt`, `build`) — the layout, scale, hover and table pick it up from there.
  - Four sources, distinguished by *style* and always by name, never by color alone: the
    verification station (`obs`, KDCA) solid with dots and fill; the **field sensor** (`fieldobs`,
    KNAK — the archive stream `discussion.js` also verifies against) thinner, no dots, in a lighter
    step of the same hue, labelled with its station id; the NWS grid's **first snapshot of that
    morning** (the day as forecast, before it happened) dashed; the GFS point for CAPE/CIN/precip.
  - Scales fit the day and are labelled after: bounds hug the data + ~10 %, and the tick step is
    **searched** over the 1/2/5/2.5 ladder for the count that fits the lane's height. Deriving the
    step by division instead lands a hair over a rung (raw 10.007 → step 20) and leaves an axis
    with one label. Ceiling is log with the category thresholds as ticks.
  - **A null ceiling is a reading, not a gap** — "clear" gets a rail along the top of the lane and
    breaks the step line, which otherwise bridges two ceilings that never met. Chance-of-precip
    shades the precip lane instead of earning a scale of its own.
  - **An absent hour is not a reading at all, and must never be drawn as one.** Lines break wherever
    consecutive obs are more than `CONT_S` (1.5 h) apart, the category ribbon paints each ob for at
    most that long instead of running it to the next one, and the missing stretch is hatched across
    the whole stack and labelled "no obs" — a straight line through six lost hours is an invented
    reading, and for three weeks that invented line was most of the lane. The card states its
    coverage next to its sources ("KDCA · 14 observations · 10 h missing"), and the headline
    numbers carry a caveat saying they are the extremes of what was recorded. The calendar notches
    any day short hours, since its color is the worst *archived* hour, not necessarily the worst
    hour flown. Hours the station never reported (`nh`) are not gaps and are never counted as such.
  - Both observed sources are labelled with their station id everywhere — hover readout, legend,
    table. An unlabelled "temp" beside a labelled "KNAK temp" reads as generic rather than as KDCA.
  - Density altitude is the NWS method (same formulas as `airlab.js`); KNAK's is worked at
    **KANP's** elevation, since KNAK is standing in for the field.
  - One hue per measure from a palette checked for CVD separation and ≥3:1 on the card; two hues
    repeat across lanes on purpose (density altitude = temperature's orange, precip = dewpoint's
    aqua) — legal only because those lanes are separate plots that never share one.
  Lane/source choices persist in `localStorage` (`almanac_lanes`, `almanac_src`).
  The calendar legend's swatches are `.sw`, not `.chip` — the meteogram picker's `.chip` button
  rule pads anything else with that class into a 24×16 pill. Today's coverage line counts only
  the hours before the last archive run as expected (`hourGaps` span), so future hours never read
  as "missing".
  The **station explorer** (`#stn-card`, last card before the trends chart) is the day's METARs
  and TAFs per station — the field sensor, then `SITE.weather.areaStations` (KDCA from `obs/`,
  the rest from the `stations/<ID>/` ring, with the day's other ring stations appended after
  the configured set), then TAF-only stations — **collapsed by default** (a
  `details.fold` whose summary counts stations/obs/TAFs). A listed station with nothing archived
  renders a dashed "nothing archived this day" row rather than disappearing — absence of data is
  never a clear sky (KFME is the standing example).
  The **alerts card is a timeline, not a list**: the archive keeps one record per issuance, so
  records of the same event whose spans touch fold into one thread (`alertThreads()`) drawn as a
  bar on a shared axis — bar = in effect, ticks = issuances, dotted run-in = the lead time between
  first issuance and onset. The axis is the day widened to hold the alerts (capped at −12 h/+36 h
  so one multi-day advisory can't squash the day), so it usually matches the meteogram's hours
  exactly. **A bare clock time is the thing to avoid here** — a watch issued this afternoon for
  tomorrow morning reads as this morning's, so times outside the selected day always carry their
  date. Issue times are parsed out of the NWS headline's own words, not `seen`, which is only when
  the hourly archiver noticed; rows that had to fall back are marked `~`. Bars are colored by
  Warning/Watch/Advisory/Statement, not by CAP `severity` — on a convective day every record here
  comes back "Severe".
  **Cards added 2026-09-01, all reading the new streams** (`selectDay()` fetches each only
  when `index.json` lists the day): **TAF vs METAR** (`renderTafVerify()` — per TAF station
  with METARs archived, 24 split cells: top the category the TAF in force called for at the
  hour (`tafCatAt()`: newest issuance ≤ the hour, FM base with BECMG folded in once it ends;
  TEMPO/PROB are not the forecast's claim), bottom the METAR nearest the hour within 45 min,
  else unjudged; hits/judged and the worst miss per station). Raw TAC TAFs (backfilled/
  healed) are decoded by **`js/taf-tac.js`** (`TafTac.parse(raw, refEpoch)` → the archiver's
  period shape; day/hour groups resolved against the issuance stamp; visibility via the SM
  table, never ÷1609) so `tafBodyHtml()` renders every issuance decoded with the raw text
  folded under. **Radar** — no radar is archived: IEM's time-enabled WMS
  (`cgi-bin/wms/nexrad/n0q-t.cgi?…&LAYERS=nexrad-n0q-wmst&TIME=<ISO Z>`, any 5-minute step)
  serves the composite as an `<img>`; 12 frames at 2 h plus a 30-min slider frame, field and
  station dots placed by lat/lon (EPSG:4326 is linear), lazy-loaded when the card scrolls
  into view, failed frames say `no radar`. **PIREPs**, **AIRMETs · SIGMETs · TFRs** (what was
  in effect that day, first/last seen), **Sounding** (`renderRaob()`: KIAD 12Z then 00Z;
  T/Td-vs-height canvas with mandatory-level winds; surface, freezing level, LCL, CAPE/CIN,
  LI, low-level inversion, winds at 3/6/9/12 k ft — parcel math is Bolton LCL + a
  pseudo-adiabat integrated in 2 hPa steps, **no virtual-temperature correction, labelled
  approx**; plus "GFS CAPE at launch" from the model snap covering the hour, the site's first
  observed check on the model stream). **Model vs observed** line under the morning grid
  (`renderModelVsObs()`: GFS day precip and peak CAPE vs KDCA's measured P-group total, obs
  with rain, and whether TS was reported). Two lanes: **Area ceiling** (`ringSeries()`: per
  hour the lowest ceiling any archived station reported, hover lists the stations ≤ 3,000 ft;
  an hour nobody reported is not drawn) and **Winds aloft** (`aloftSeries()`: the GFS column
  from the shortest-lead snap covering each hour, one line per level, arrows on 850 hPa —
  model only, named GFS; RAOB winds live in the sounding card). Both lanes off by default.
- `storms.html` + `js/storms.js` + `scripts/build_storms.py` → `data/storms.json` — Storm Log
  (2026-09-28): every precipitation event in the archive as it happened, ranked. The page reads
  **only `data/storms.json`**, compiled from `data/wx/` by the build script at the end of every
  hourly `wxarchive.yml` run (a step before the commit; `git add data/wx data/storms.json`), so
  an event in progress grows each hour and the page fetches one document, not 150 day files.
  Rules in the script's docstring, worth not re-breaking: hour buckets come from each station's
  **routine ob** (minute ≥ 45, the one carrying SLP preferred) and its P-group — SPECI P-groups
  are cumulative since the last routine ob and would double-count, so SPECIs feed only present
  weather / wind / pressure; an ob without a P-group is a dry hour (ASOS omits the group), an
  hour without a routine ob is **missing, never zero**, and at the synoptic hours the 6-hourly
  group (`6RRRR`, in the bucket *before* 00/06/12/18Z since the :52 ob sits there) fills hours
  the feed dropped (`filled`), which is what makes KDCA's event total match its own 24-hour
  groups (Sep 21–23 rain: 1.64 in, = 70066 + 70098). A wet hour = KDCA or KNAK measured /
  reported precip or thunder, or a ring gauge ≥ 0.10 in; wet hours ≤ 6 h apart are one rain
  span (a nor'easter has lulls). **An event is the system, not only its rain** (Jesse,
  2026-09-28: "I care about weather events as systems as a whole"): a windy hour = KDCA or KNAK
  sustained ≥ 15 kt or gust ≥ 18 kt in any ob; windy hours ≤ 18 h apart (an evening-to-morning
  lull) form a blow, a blow touching a rain span (within 6 h) joins it, and a blow bridging two
  rain spans makes them one event — that is what turns Sep 21–23 + Sep 26–27 into the one
  Sep 21–27 nor'easter (151 h, 74 wet, 90 windy, KDCA 1.98 in, #1) LWX itself called one storm
  throughout. A blow with no rain is an event only at ≥ 12 windy hours and a gust ≥ 25 kt
  (`types` gains `wind`; none in the archive so far). Kept when KDCA or KNAK ≥ 0.10 in,
  thunder, anything frozen, a ring gauge ≥ 0.25 in, or wind-only. The card shows it: `rain N h`
  / `wind N h` facts, a grey windy-hour strip along the top of the hyetograph, the season strip
  underlines days with ≥ 6 windy hours, `windiest` sort chip. Copy stays about the weather, never
  about flying or being grounded. **Rank is by the KDCA total** (the record station; KNAK beside it), `since`
  = the last earlier event that was wetter. **`driver` is what LWX called it**: mention counts
  of named features (nor'easter · tropical · coastal low · cold/warm/stalled front · upper low
  · shortwave · trough …, weighted so a named storm beats the trough it rides) over the
  discussions issued while it rained; thunder with only a generic feature → "thunderstorms".
  The narrative is LWX's own: `expected` = the KEY MESSAGES of the last issuance before onset,
  `log` = every WHAT HAS CHANGED paragraph from 6 h before to 3 h after — quoted, stamped, no
  generated prose. Page: season strip (one bar per day, events shaded, top six labelled, dots
  for thunder/snow, click → the event) → tiles → sort/filter chips (`#sort=`, `#type=`) → a
  card per event: hero totals, hyetograph (KDCA and KNAK paired bars, thunder ticks, missing
  hours hatched), fact row, and folded (`#e=<id>` opens it): wind / pressure / ceiling lanes
  (one scale each), every gauge as a bar list (`no gauge` for KFME, `N h missing` said), NWS
  alerts at the DC point, almanac day links, the LWX log. Chart pair `#3987e5` / `#d95926`
  validated on the card surface. `--selftest` covers the parser and the 6-hourly fill.
  `window.STORMS_DEBUG` for headless checks. **Unlinked 2026-09-29** (Jesse: "storm log and afd
  clutter the website") — tools.html card, JSON-LD entry and `wxnav.js` slot removed; the page
  and its sitemap entry stay (the sequencing.html pattern). Don't re-add without being asked.
- `afd.html` + `js/afd.js` + `scripts/build_afd.py` → `data/afd.json` + `data/afd-text.json` — LWX
  Discussions (2026-09-29): every archived Area Forecast Discussion (`data/wx/afd/`, one file per
  issuance since 2026-05-01) read as one corpus. The page reads **only `data/afd.json`** (~130 KB,
  every aggregate) and fetches `afd-text.json` (the section texts, ~4 MB) only when a visitor
  searches; both are rebuilt at the end of every hourly `wxarchive.yml` run beside the storm log
  (`git add` lists them). Cards, in order: theme strip (mentions per issuance per day, each row
  scaled to its own 95th percentile, `THEMES` lexicon) · **stories** = key-message threads
  (consecutive issuances restate a key message with edits; Jaccard ≥ 0.4 on content words chains
  them, two missed issuances close a thread — `threads_of()`; the bar chart is the top 40 by
  lifetime, the table sortable by held / revised / newest) · volume (words and issuances per day,
  issuance-hour clock — LWX's four-a-day cycle at ~3 / 10 / 15 / 21 local — section share) ·
  confidence (hedges per 1,000 words weekly, `HEDGES` lexicon; high- vs low-confidence statements
  paired bars, `#3987e5` / `#d95926`; day-before-rain vs dry split read from `data/storms.json`) ·
  models and synoptic features (`MODELS`, `FEATURES` — the latter mirrors `build_storms.py`
  `DRIVERS`) · products (the `.LWX WATCHES/WARNINGS/ADVISORIES` block parsed for `<Name>
  Advisory|Warning|Watch|Statement`, a day strip) · aviation section (VFR/MVFR/IFR/LIFR/fog
  mentions per day, TAF sites named) · words of the month (unigrams and adjacent bigrams whose
  mentions are ≥ 50 % concentrated in one month) · temperature decade phrases by month · places ·
  signatures (initials from the `$$` block, issuances signed; style figures only over solo-signed
  discussions, which are rare) · full-text search (sentence hits with the archive file linked,
  a per-day hit strip, section chips, `#q=` deep link). **Parsing rules worth keeping:** AFDs are
  hard-wrapped at ~66 columns, so `sections()` unwraps lines inside a paragraph before anything
  is counted — "sea\nbreeze" is one phrase and every lexicon missed it until it did; the climate
  section (record tables) is excluded from every rate and count except section share; all rates
  are per 1,000 words so a short evening update compares with a morning package. Lexicons are
  the thing to edit (`THEMES`/`MODELS`/`FEATURES`/`HEDGES`/`PLACES` at the top of the script), not
  the page. `--selftest` covers the parser, signatures, products, lexicons and threading.
  **Unlinked 2026-09-29, same day it shipped** (Jesse: "storm log and afd clutter the website") —
  no tools.html card, no JSON-LD entry, not in `wxnav.js`; reachable by URL and the sitemap.
  `window.AFD_DEBUG` for headless checks.
- `surface.html` + `js/surface.js` — Surface Analysis (2026-10-08): WPC's coded surface bulletin
  (`data/wx/sfc/`, the `sfc` stream below) drawn on the dark CARTO Leaflet base by a canvas layer
  (`SfcCanvas`) with WMO symbology — cold/warm/stationary/occluded fronts with pips every 22 px
  along a Catmull-Rom spline through the coded vertices, troughs dashed orange, H/L letters with
  the central pressure, the field as a white ring. **The bulletin codes vertices only, no
  direction**, so the pip side is a heuristic (`frontSide()`): a front with a low within 110 nm
  of one end moves cyclonically about it, so pips point LEFT walking away from the low; otherwise
  the cold side is the side of the front's chord whose normal points most west-and-north. Checked
  against WPC's own chart for 2026-10-08 21Z (every front, pip direction and H/L matched); the
  WPC chart fold under the map (`archives/sfc/YYYY/usfntsfcYYYYMMDDHH.gif`, fetched only while
  open) is the authority. Scrubber (‹ › · play · newest · ← → space) over every loaded analysis,
  8 days first, "Load 7 more days"; `#t=<epoch>` deep-links and loads back to that day (≤ 60).
  Chips (persist in `surface_opts`): `trails` = the previous 4 analyses as fading ghosts, `low
  tracks` = each low chained back 48 h (`matchCentre`: within 40 kt·dt + 60 nm and 2 hPa·dt + 4,
  scored distance + 15·|Δp| — a looser match had a high "moving N 80 kt"), `stations` = WMO
  station models at zoom ≥ 8 (the ring's fields are 10–30 nm apart) from the archived METARs
  nearest the valid time (±45 min): cover circle, barb with feathers 90° clockwise of the staff,
  °F temp/dew, SLP tenths, a present-weather glyph — day files loaded on demand. Hover → tooltip:
  distance/bearing from KANP, which side of the front the field is on, the front's motion
  (`frontMotion()`: each vertex's normal displacement from the matched previous front, vertices
  landing on the previous front's *ends* ignored because WPC trims and extends coded ends, median
  for speed, mean vector for direction, its component toward KANP as the closing speed → "KANP in
  ~N h"; > 70 kt = no match). `matchFront` uses the **median** vertex distance (< 200 nm) — a mean
  let a long stationary front "move 78 kt". **At KANP** card: nearest front / next of another
  kind / trough / nearest low and high with their 3 h change, and the KNAK ob at the valid time
  (SLP, 3 h tendency against the ob 3 h earlier, wind, temp/dew, sky). **Barograph**: KNAK SLP
  over the loaded window (`fieldobs/` day files, gaps > 1.5 h broken), a tick per analysis along
  the top coloured when a front is within 60 nm, click → that analysis. Folds: Features (nearest
  first, row click pans) and the WPC chart. Live poll every 5 min re-reads today's day file when
  `latest.sfc.t` moves. In `wxnav.js` (sixth slot), on tools.html and in the feed (`sfc` pill).
  Reads only `WXA` plus the WPC image. `window.SURFACE_DEBUG` for headless checks.
