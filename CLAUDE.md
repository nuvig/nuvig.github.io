# CLAUDE.md

Personal website (jesselevine.net, GitHub Pages from `main`) + KANP flight tracker, weather hub,
and a set of interactive aviation explainers.
Plain HTML/JS/CSS — **no build step, no framework, no npm**. Leaflet is vendored in `js/vendor/`.
The only build tooling is a few stdlib-Python data generators (`scripts/build_*.py`) whose output is
committed. Owner: Jesse, CFI/CFII/MEI pilot based at KANP (Lee Airport, Annapolis MD).

## Conventions

- **Visitor-facing copy is terse. No prose.** Jesse has said this repeatedly (last 2026-09-01:
  "stop using like human prose for stuff like that, i dont know how many times i have to tell
  you"). Rules: label → value, never a sentence; a link is `label → link`, not
  "(those are on the data feed)"; no aphorisms, slogans, bolded taglines or explanatory
  parentheticals; no page has a footer essay; a subtitle is one line or absent; tooltips are a
  clause. Name records by what they are (METAR, TAF, AFD) and stations by ID; never an
  archive-internal name (`obs`, `ring`, `fieldobs`) in the UI. Before shipping, reread every
  string a visitor sees and cut anything that reads like a writer talking.
- **`js/site-config.js` holds all site-specific constants** (airport, coordinates, runway geometry,
  ops gates, nearby airports, TAF stations, snapshot URL, timezone) in one `SITE` global, loaded
  first on every page that needs it. Pi mirror: `pi/site.env.example` → `/etc/kanp/site.env` (read by
  the systemd units via `EnvironmentFile`). Edit these, not the consumers.
- **All headings/directions are °true** throughout the site (FAA true runway alignments; METAR and
  model winds are also true). Never magnetic.
- `css/main.css` is the shared stylesheet (dark theme, CSS vars, 760 px max-width). Every page uses
  it except the self-contained toys/SDR/personal pages (`bubbles.html`, `glow.html`, `ctaf.html`,
  `scanner.html`, `fugue.html`, `mural.html`, `watercycle.html`, `zoey.html`).
- **Cache-busting is manual**: assets are referenced as `js/foo.js?v=N` / `css/main.css?v=N`.
  When you change a file that already carries a `?v=`, bump the number in every page referencing it
  — GitHub Pages caches aggressively and stale JS is the usual "my fix didn't deploy" cause.
  `discussion.html` prints the running JS version in its footer (`DISC_VER` in `js/discussion.js`,
  bumped in step with the `?v=`) so a stale deploy is visible at a glance.
  **Every page references `css/main.css?v=3`** (normalized 2026-08-21; a bare unversioned
  reference is a different cache key and reintroduces the split-cache bug).
- **There is no site-wide navigation bar.** `js/nav.js` existed for one day and was deleted
  2026-08-21 — Jesse didn't like it. Navigation is: the homepage cards → `tools.html` → a tool,
  plus each page's own `#back-link` to `/`. Don't reintroduce a shared bar without being asked.
  **One requested exception (2026-08-29): `js/wxnav.js`** — a one-line cross-link strip among
  five weather pages (weather, discussion, skew-t, wx3d, almanac, in that order; page list lives
  in the script), injected under each page's title. It replaced those pages' ad-hoc subtitle links
  (weather.html keeps its non-weather tracker/air-lab links). **METAR Sky (`sky.html`) was pulled
  out of the strip the same day at Jesse's request** — it carries no `wxnav.js` script tag and
  doesn't appear in `PAGES`. Keep it scoped to the remaining weather family — it is not a site nav
  bar, and sky2/terps stay out (deliberately unlinked).
- **Every public page** (the ones listed under Layout, i.e. everything but the self-contained
  toys/SDR/personal pages) carries, just before `</body>`, the
  GoatCounter analytics snippet (jesselevine.goatcounter.com — cookie-less, nothing secret) and
  `js/pagever.js`, which shows a "vN · updated <date>" badge (N = the page's commit count on
  `main` via the GitHub API, cached 6 h in localStorage). Add both to any new public page.
- `.gitattributes` forces LF on `pi/*.{py,sh,service,timer}` and `.claude/hooks/*.sh` — the Pi and
  the web-session containers are Linux and CRLF breaks bash/systemd on checkout. Don't override it.
- **Commits are authored as `nuvig` everywhere.** `.claude/settings.json` blanks Claude Code's
  commit/PR attribution (`attribution` empty + `sessionUrl: false`, so no `Co-Authored-By` or
  `Claude-Session` trailers), and its SessionStart hook (`.claude/hooks/session-start.sh`,
  remote-only via `CLAUDE_CODE_REMOTE`) sets the git identity in web sessions, whose containers
  otherwise commit as "Claude". Jesse's choice — don't re-add attribution. (`.gitignore` ignores
  `.claude/` wholesale to keep local state private; these files, like `.claude/skills/`, are
  force-added — a new file under `.claude/` meant for the repo needs `git add -f`.)
- `.nojekyll` is present; GitHub Pages serves the tree as-is. `CNAME` pins jesselevine.net.
- Never commit API keys — this repo is public. The tracker's optional RapidAPI key lives only in
  the visitor's `localStorage`. The one deliberate exception is `SITE.basemap.cartoKey`
  (CARTO basemap tile key, added 2026-08-29): it's a client-side key that appears in every
  visitor's tile URLs by design, so committing it exposes nothing the live site doesn't.

## Layout

### Personal site

- `index.html` + `js/home.js` — landing page (flight-training services, contact, live card teasers).
  The Tracker / Weather / Tools cards *are* the site's navigation, so keep their blurbs in step
  with `tools.html`.
  `js/home.js` lazy-loads `js/sim.js` (neon ball-physics easter egg) on first click of the ▶ toggle
  so its ~13 KB never costs a normal visit. `js/sim.js` is loaded *only* this way — it is not
  referenced from any HTML. **Second easter egg (2026-09-03): `js/synop.js`**, a surface
  analysis behind the page — draggable H/L pressure centres (wheel/↑↓ sets the centre in mb,
  crossing 1013 flips the sign, drag off the edge removes), isobars by marching squares every
  frame, ~1,400 geostrophic wind tracers the pointer stirs, and a small bottom-left panel
  (+L/+H, reset = clear all, wind speed, tracer count, spacing, stir — off by default). Loaded lazily by `home.js` on a
  click of the location line or the `P` key; also not referenced from any HTML. The canvas
  sits at `z-index:-1` behind the column (cards are opaque, so it lives in the margins) and
  it never intercepts a pointer event that started on a link/button/input.
- `tools.html` — the Aviation Tools hub; the categorized index of the explainers below. The homepage
  links here rather than to each tool, so **a new explainer needs a card added to `tools.html`**
  (and a `<url>` in `sitemap.xml`).
- `sitemap.xml` — hand-maintained XML sitemap, referenced from `robots.txt`. Public pages only:
  `noindex` pages (`404`, `atc`, `scanner`, `bubbles`, `fugue`, `mural`, `slime`) and the
  deliberately unlinked `glow` / `sky2` / `watercycle` / `zoey` / `ctaf` are excluded on purpose. `lastmod` is
  the page's last commit date.
- `changelog.html` + `js/changelog.js` + `js/data-health.js` — the site changelog (commit history of
  `main` via the GitHub API, unauthenticated) side by side with two data-health panels. The commit
  list **hides automated data drops** (`wx: archive`/`wx: backfill`/`ctaf: transcripts` titles and
  any `*[bot]` author), chaining extra API pages (max 3/load) so a screenful of real changes still
  renders; in their place `data-health.js` monitors the pipelines those commits come from: the
  weather archive (via `WXA` — per-stream freshness judged against each stream's own cadence, plus
  42-day coverage strips; alerts are event-driven, so absent days there are "quiet", never gaps —
  and a **reach/integrity** pair read from `index.json` over the *whole* archive, not the drawn
  window: first day held per stream, and the missing days collapsed into `--since/--until`-shaped
  ranges. **Integrity counts hours, not just days** — it read day lists only and so reported the
  archive COMPLETE through three weeks in which a quarter of every day's hours was missing, which
  is the worst thing a health panel can do; a day that is on file but short hours is now its own
  state in the strip (hatched), in the row badge and in the verdict, and a stream whose hours were
  never published says "days only" rather than borrowing the day verdict's confidence.
  Missing days are still collapsed into ranges, marked `(unrecoverable)` for the streams `wxbackfill.py` deliberately can't refill
  (`forecast`/`grid`). Today is never counted a gap — a day-forward stream fills it as the day runs)
  and the tracker snapshots (`summary.json` — exporter push age vs `newest_position` "last aircraft
  heard", which fail independently, plus aircraft/day bars). Needs `site-config.js` + `wx-archive.js`.
- `feed.html` + `js/feed.js` — Data Feed: the site's intake log — every record it takes in,
  newest first, as one merged stream. Thirteen pills as the page labels them: `metar` (KDCA
  from `obs/`, KNAK from `fieldobs/`, and the `stations/<ID>/` ring, one stream with the
  station in the source column — the badge names the record type, never an archive-internal
  name like "ring") · `taf` · `afd` · `pirep` · `airsig` (G-AIRMETs and SIGMETs) · `tfr` ·
  `raob` · `aloft` · `forecast` · `grid` · `model` · `alert` · `tracker` (the Pi exporter's
  `summary.json`). Reads **only** `WXA` plus that one tracker document — no weather API of
  its own, same rule as the almanac. Rules worth keeping:
  **Two kinds of timestamp, never merged.** `grid`/`forecast`/`model`/`aloft` snapshots stamp
  `t` when the archiver wrote them, `alerts` stamp `seen`, `airsig`/`tfr` items stamp `first`,
  the tracker stamps `generated` — for those the row time is the capture time. METARs, TAFs,
  AFDs, PIREPs and soundings carry only their own moment (observation / issuance / report /
  launch) and were picked up later by the hourly run; those times get a dotted underline and
  say which they are on hover. The page never labels the second kind as an arrival.
  **METARs that arrive together are one line.** The hourly routine obs land in a
  batch (a dozen stations between :52 and :56) and one line each buries every other
  record on the page, so a run of METARs within `MET_GAP` (300 s) folds into a set:
  the source column counts the stations, the one-liner lists their ids, the size is
  the total, and opening it prints every report with the file each came from. A run
  covering only one station never folds — a SPECI after its routine ob is two
  readings from one place, not a batch. Only METARs fold; the day header's record
  count stays the record count, not the line count.
  **The rail is the day's shape** (`drawRail()`, right of the log at ≥980 px): a row
  per hour, a column per stream, each cell shaded by the bytes that arrived in it on
  a shared log scale — bytes, not records, because an AFD outweighs a thousand
  METARs and the weight is the point. An empty cell is an hour that held nothing,
  which no amount of scrolling shows; hours after `index.json`'s `updated` are not
  drawn at all, since an hour the archiver has not reached is not an empty hour. It
  is built from every record of the day, so the stream chips do not thin it; a cell
  click jumps the log to that hour of that stream, and the rail follows whichever
  day section you have scrolled to (a throttled scroll read — the Browser pane
  delivers neither IntersectionObserver callbacks nor scroll events, so this is
  verified in headless Edge, not the pane).
  **Truncation is stated.** Every row prints its record's size; one-liners cut the field
  carrying the least (a METAR's RMK group, a TAF's WMO transmission header, a snapshot's
  48 hourly values); an expansion over 20,000 chars says where it stopped and links the file.
  Each expansion cites the archive path it came from (an AFD from `latest.json` cites its
  `afd/YYYY/afd-…` file, derived from `issuanceTime`; a TFR row also links the FAA detail page).
  **A day header reports the archive, not the filter** — hours held, hours missing and hours
  the station never reported per METAR stream (out of `index.json`'s `hours`), plus what each
  day file's `bf` says was filled in from IEM afterwards. Today's expected hours run only up
  to `index.json`'s `updated` stamp (the last archive run), so hours the archiver hasn't
  reached yet are never counted as missing. A day whose files were never opened says so
  rather than borrowing the look of a measured one. Backfilled AFDs, TAFs and soundings
  (`bf`) carry the `healed` tag on their row; METAR provenance is per file, so it appears in
  the header only.
  **Only files `index.json` lists are fetched** (`DAY_STREAMS` + `station_days`), so a stream
  that never held a day is not a 404. METARs dedupe within 90 s per station, the archiver's
  own tolerance, so a live copy and an IEM-healed copy of one ob are one row. Day files load
  newest-first **before** `latest.json` — both hold the same newest records and the first added
  wins the dedupe, so the archived record wins and cites its own path. Live tail re-reads
  `latest.json` + `summary.json` every 60 s, and when `index.json`'s `updated` moves it drops
  today's files from `WXA`'s cache and re-reads them, so coverage follows the archive.
  Expanded rows stay open across re-renders (`openKeys`); rows are keyboard-expandable; the
  filter searches full record text; "Load 7 more days" loads a batch in parallel; each day
  header links `almanac.html#d=<date>`.
  **Page copy is plain and minimal** (Jesse, 2026-09-01: "get rid of this AI speak", then
  "remove header and footer text unless it's really important") — a one-line subtitle, no
  footer prose; the hover titles carry the timestamp/healed explanations. Keep it that way.
  Site-meta page like `changelog.html`: sitemap entry + footer links on `index.html`/`tools.html`,
  and **no tools.html card**.
- `404.html`, `robots.txt`, `assets/og.png`, favicons.
- `bubbles.html` — standalone `noindex` toy, self-contained, unlinked from navigation.
- `slime.html` — Slime Simulator: a full-screen slime slab (wobbly rim inset a few px from the
  viewport edge) with four slime types, each with distinct physics/texture/sound: glossy (viscous,
  shiny, holds fingerprints), cloud (matte creamy — smears are *plastic*: the deformation grid's
  rest positions chase the smear and self-heal over ~30 s), sprinkles (floam — sprinkles advect
  with the flow, carried hard while stirred and slipping on the spring-back, so stirring
  redistributes them permanently; crackle audio), and water (borax jelly — low damping so it
  jiggles, refracted dot-grid seen through it, prints won't hold). One spring-mesh deformation
  grid covers the screen and every texture layer samples it, so drags visibly stretch everything;
  googly eyes have real Verlet pupil physics (shaken by the slime, gravity, bounce). All audio
  synthesized (squelch/puff/crackle/plip families). `?type=` deep-links a type; selections persist
  in localStorage. Self-contained like glow.html. **Unlinked and `noindex`** by request — to
  promote: drop the noindex meta, add a tools.html card + sitemap `<url>`.
- `fireworks.html` — Fireworks, a click-to-launch canvas fireworks show: peonies, willows, rings,
  crossettes, strobe and crackle shells, procedural booms, an auto show and an on-demand grand
  finale. Self-contained like glow.html (no shared CSS/JS, no `site-config.js`). **Unlinked**
  (its tools.html "Just for Fun" card was removed 2026-08-21 along with the section, which held
  nothing else) but still indexed — the sitemap entry stays, so the page is reachable by URL and
  by search.
- `glow.html` — Glow, an interactive generative-art toy: WebGL Julia/Mandelbrot/Burning Ship
  explorer (cursor morphs the Julia c; iterations and palette re-center with zoom depth), additive
  wave ribbons with click ripples, a flow-field particle swarm with an FPS governor that trims
  the count on slow machines, a laser playground (draw mirrors, place spinning emitters, raytraced
  bounces), a Verlet cloth you can pull, cut (right-drag) and tear (pin modes incl. a wind-blown
  flag, draggable ball obstacle, weave density), and squishy soft-body jelly blocks with faces
  (grab and fling, tap to spawn, they stack). Self-contained like
  bubbles.html (no shared CSS/JS, no libs); cosine
  palettes are shared between the shader and the canvas modes. **Deliberately unlinked from site
  navigation** — it is not an aviation tool, so it does not belong on `tools.html`; reachable only by
  direct URL (unlike bubbles.html it is still indexable, no `noindex`).
- `watercycle.html` — The Water Machine: a self-contained side-on water-cycle/weather sim
  (sea → coast → mountain range). Vapor/droplet particles carry latent-heat bookkeeping through
  evaporation, thermals, orographic lift, condensation at the LCL, rain shadow, virga, night-time
  radiation fog, snowcaps above the freezing level and aquifer baseflow ("counted, not drawn");
  a pressure-picture overlay and an energy ledger tie it together. Click any parcel to follow it
  (narrated journal + trace on the parcel card's mini sounding — environment temp, dew line, LCL);
  click the sea or ground to stir an evaporation burst or a thermal; sliders for time of day
  (with play/pause), humidity, wind and sea temp. **Deliberately unlinked** like glow (indexable,
  no `noindex`).
- `fugue.html` — Pattern Fugue: replays any archived day of real KANP-area traffic as generative
  music (WebAudio, all procedural) over a runway-frame stage — altitude picks each aircraft's note
  on a C-lydian scale, position pans it, distance sets volume/reverb, landings ring a bell, and the
  day's KDCA METARs (`data/wx/obs/`) drive a wind/rain/thunder bed; every flight also burns a
  long-exposure "plate" (PNG-exportable). Data: `summary.json` + `days/YYYY-MM-DD.json` from the
  traffic-data branch (localStorage `fugue_snap` overrides the base for testing, like
  `kanp_api_base`). Self-contained like glow.html. Ops detection is deliberately ops-lite (bells
  and captions only, not stats — `js/kanp-ops.js` remains the real classifier). **Deliberately
  unlinked and `noindex`** — an experiment; if promoted, remove the noindex meta and add the
  tools.html card + sitemap entry. Exposes read-only `window.FUGUE_DEBUG` for headless tests.
- `mural.html` — Mural, an infinite collaborative canvas for two trusted people. Self-contained
  like glow.html; **unlinked and `noindex`** — personal, not an aviation tool. Objects (strokes /
  text / JPEG-downscaled images) live in world coordinates and re-render from geometry at any zoom;
  a promoted object holds its own child world — zooming past a threshold crosses into it
  (unbounded nesting, breadcrumbs surface back) — and a history scrubber replays any level's log
  as a pure view. Persistence is an **append-only object log sharded by 2000×2000-unit chunk**:
  `canvas/<path>/chunk_<x>_<y>.json` (`<path>` = `root/<objId>/…`; segments seal near 600 KB;
  `large.json` per level for chunk-spanning objects; `canvas/__registry.json` maps promoted ids →
  bbox for deep links). Erase/move/promote/undo are appended event records folded at read time in
  `(t, id)` order — timestamps are per-client monotonic so same-ms causal chains fold correctly —
  and every write is read → merge-by-id → compare-and-swap with conflict retry, so overwriting
  someone's work is impossible by construction. Two storage adapters share that code path:
  **Shared** (a separate GitHub data repo — create one empty, private is fine; each person a
  fine-grained PAT, Contents R/W on just that repo, held in localStorage like the tracker's
  RapidAPI key; sync polls one conditional request per 3 s — 304s don't count against the rate
  limit) and **Solo** (localStorage; `?store=local&author=X&db=Y` lets two tabs play both people —
  how it's tested). `?selftest=1` runs storage/fold assertions; `window.MURAL_DEBUG` drives it
  headlessly. The GitHub adapter follows the documented contents/git-data API but hasn't run
  against a live repo yet — first real session, watch the sync pill.
- `zoey.html` — photo gallery for Zoey (the dog). Self-contained; masonry columns (2–4 by width),
  album chips, shuffle, lightbox with keyboard nav, tiles lazy-rendered in batches of 48. Reads
  `data/zoey.json`, built by `python scripts/build_zoey.py` (stdlib) from whatever sits under
  `photos/zoey/` — a subfolder becomes an album, EXIF orientation/date are respected, captions
  come from an optional `captions.txt` (else camera-ish filenames get none and anything else is
  prettified), HEIC is skipped with a warning (browsers can't show it — export as JPEG). Commit
  the photos *and* the regenerated JSON; the manifest shape is shared between the script and the
  page — change them together. **Unlinked** (indexable, no `noindex`); the manifest is currently
  empty and the page shows its own how-to.

### Flight tracker

`kanp.html` — three tabs: Live / History Map / Traffic Study. Scripts load in dependency order
(`site-config` → leaflet → `kanp-static` → `kanp` → the rest).

- `js/kanp.js` — shared utils + Live tab (trails, heatmap, localStorage), plus `KANP.apiBase()` /
  `getTracks()` / `getStats()` data routing. Live polls every 3 s against the Pi (`PI_POLL_MS`,
  matching the collector) and every 60 s against snapshots (`POLL_MS`, which only change hourly).
  KANP = 38.9422, -76.5684, 60 nm radius (from `SITE.tracker`).
- `js/kanp-history.js` — altitude-colored historical tracks on a canvas layer, FAA VFR + NEXRAD
  overlays, and the trailing-7-days heat grid (its `markNow` flag draws a "now" line in today's row —
  left of it fresh data, right of it week-old; only meaningful for trailing windows, so the 60-day
  Live grid and Study grid don't set it).
- `js/kanp-study.js` — stats (hour×day grids, histograms, type/operator breakdowns).
- `js/kanp-ops.js` — ops detection: contiguous "at the field" segments (inside `OPS_GATES`), classified
  by airborne context before/after into arrival / departure / go-around, attributed to runway 12 or 30.
- `js/kanp-climb.js` — Traffic Study sub-tool: climb-out comparison. Extracts the initial climb from
  each departure and plots altitude gained vs distance from liftoff (density-altitude comparisons).
  Altitudes are ADS-B barometric — fine for day-to-day gradient comparison, not true geometric gradient.
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

The climb / final / pattern sub-tools mirror `kanp-ops.js` detection logic — if you change how a
field contact is classified there, check all four (`kanp-conflict.js` is about aircraft pairs, not
field contacts, and doesn't care).

### Aviation explainers (self-contained, no backend)

- `procedures.html` + `js/procedures.js` — Procedure Explorer: overlays any US SID/STAR/IAP on Leaflet
  (sectional/TAC/IFR layers) with a custom canvas 3D altitude view, transition-by-transition selection,
  a leg-by-leg table (courses shown °true = chart magnetic + station mv), flow animation, shareable
  `#apt=…&sel=…` links, and an embedded FAA-plate viewer (iframe on
  `aeronav.faa.gov/d-tpp/{cycle}/{pdf}` — those PDFs send no X-Frame-Options; a cycle's URLs 404 once
  the next is effective, so `dtppCycle()` advances the built cycle in 28-day steps at view time,
  mirrored by `dtpp_cycle_label()` in the builder). Data: `data/procedures/` (`index.json` + ~3,180
  per-airport JSON files), regenerated each 28-day AIRAC cycle by `python scripts/build_procedures.py`
  (downloads FAA CIFP **and the d-TPP chart metafile**, stdlib only). The builder matches charts to
  CIFP codings (DP/STAR via `<faanfd18>`, IAPs by parsing chart titles into candidate ARINC idents);
  published plates with no public CIFP coding (many VOR/NDB/TACAN full procedures, visuals, most
  military fields — e.g. KGED VOR RWY 22) become `co:1` chart-only entries with empty `trans`, so
  a procedure "missing" from the map is usually FAA coding absence, not a bug. **Leg-array layout is
  documented in that script and mirrored in `procedures.js` `decodeLeg()` — change both together.**
- `aircraft.html` + `js/aircraft.js` + `data/aircraft.json` — Aircraft Compare: pick up to six aircraft and
  put every number side by side. **`data/aircraft.json` is the whole tool** — a field registry
  (`fields`: id, group, label, unit, `hi` = which direction is better, `c` = computed) plus one specs
  object per aircraft. Adding a measurement is one registry entry and adding an airplane is one
  `aircraft` entry; the master table, both scatter axes, the bar-chart picker, the unit switch and the
  row filter all read the registry, so **`js/aircraft.js` should not need editing to grow the data**.
  One row per *certified variant* (CRJ900 ≠ CRJ1000), each a single named configuration. Values are stored
  in one canonical unit per field (m, m², m³, kg, L, kN, kW, ft, kt, nm, cm, psi, °, kg/h) and converted
  at display time by `UNIT_DEFS` — **never convert in the data**. Per-aircraft `n` holds field-level
  footnotes and `~` lists the fields whose value is rounded/preliminary (rendered `≈`, and inherited by
  any derived field computed from them). The ten `der` fields (aspect ratio, wing loading, thrust-to-weight,
  structural payload = MZFW − OEW, fuel/payload fraction, fuel per seat-hour…) are computed in
  `DERIVED` and are deliberately *not* quoted from manufacturers — where a manufacturer's published
  "max payload" disagrees with MZFW − OEW it is because their empty-weight basis differs, and the
  table shows the derivation rather than the quote so the arithmetic always closes.
  **The silhouettes are generated from the table, not traced**: `geoTop`/`geoSide`/`geoFront`/`geoCabin`
  build SVG in metres from span, length, wing area, quarter-chord sweep, fuselage width/height, tail
  height and fan diameter, plus a per-type `geom` block (`mount` wing/aft/nose, `tail` T/conv, `wing`
  low/high, taper ratio, wing root position, tail span fraction). That is what makes every drawing
  honestly to scale against every other one — if an airplane looks wrong the fix is a number or a `geom`
  value, not a path. Series colours are the six-slot dark categorical palette validated for CVD
  separation (adjacent ΔE 8.4 worst case, all ≥3:1 on this background); **re-run the check before
  reordering or extending it**, and note `MAX_SEL` is tied to the palette length. Self-contained
  otherwise — no `site-config.js`, no network beyond the one JSON fetch. `window.ACOMP` is a read-only
  handle for headless checks.
**`power.html`, `eights.html` and `instruments.html` are unlinked as of 2026-08-21** — their
`tools.html` cards (and JSON-LD list entries) were removed at Jesse's request. The pages and their
sitemap entries are untouched, and `js/knowledge.js` still deep-links to them from the relevant
concepts; to relink, add the tools.html card back.

- `power.html` + `js/power.js` — The Power Curve: parasite vs induced power, minimum-power speed, the
  region of reversed command, slow flight, and a point-mass approach sim. Internals are SI; display
  converts to kt/hp/fpm.
- `eights.html` + `js/eights.js` — Eights on Pylons: pivotal altitude `PA = GS²/11.3`, side-view
  geometry, wind-aware full-figure simulation.
- `instruments.html` + `js/instruments.js` — Instrument Errors: block the pitot/static lines and
  watch a live ASI/altimeter/VSI (ISA atmosphere + compressible qc↔CAS calibration), altimeter
  setting and cold-weather errors flown against an obstacle, heading-indicator earth-rate drift and
  attitude-indicator false climb, and a flyable magnetic-compass sim (dip, UNOS turning, ANDS
  acceleration errors). No fetches, no `site-config.js`; inches Hg / ft / kt throughout. The
  compass sections deal in *magnetic* headings — the subject demands it; that's the deliberate
  exception to the site's °true rule.
- `airlab.html` + `js/airlab.js` — Air Lab: atmosphere column, pressure/density altitude (NWS method,
  humidity), air-parcel stability sim, IAS→TAS→GS wind triangle.
- `skew-t.html` + `js/skewt.js` + `js/skewt-obs.js` — Skew-T Explorer: canvas skew-T log-p
  (1000→100 hPa, 21 levels) of Open-Meteo pressure-level forecast soundings, 3 days hourly, for
  any US airport (coords resolved via `api.weather.gov/stations/{id}`; model selectable), with
  parcel analysis. Thermo is Bolton (1980); CAPE/CIN are integrated from the plotted profile
  **without virtual-temperature correction** (said in the UI — keep the disclosure if you change
  the math). `skewt.js` exposes `window.SkewTCore`, which `skewt-obs.js` reuses for observed
  soundings: the SPC SHARP gif (fixed 1180×826 layout, so hover regions live in fractional
  coordinates; inside the diagram the pressure axis is log-p 100→1000 hPa, converting cursor
  height to pressure) overlaid with explain-on-hover text read from the actual IEM RAOB JSON
  (CORS-open) at that level — the text describes exactly what the pixels show. RAOBs launch
  00Z/12Z; SPC images publish ~1.5 h later (`recentCycles()` accounts for it).
- `knowledge.html` + `js/knowledge.js` — Aviation Knowledge Map: expandable canvas concept graph with
  dashed cross-links. See the build pipeline below.
- `sfra.html` + `js/sfra.js` — The DC SFRA: the Washington SFRA/FRZ explained from a KANP seat.
  Leaflet map (vendored, same FAA tile layers as procedures.js) drawing the 30/60 nm rings, the FRZ
  polygon regenerated from the verbatim 14 CFR 93.335 vertex coordinates (arcs re-derived from the
  reg's own lat/lons — no magnetic-radial math), P-56A/B, P-73, P-40/R-4009 from JO 7400.10H, the
  8 gate fixes at their true NAS positions (several sit deliberately outside the ring) each tied to
  its radial-bounded sector of the ring (kneeboard DCA radials → true using the station declination
  *derived from 93.335's own radial↔lat/lon vertex pairs*, ≈9°W — don't swap in a magnetic model),
  area VOR/VORTACs (OTT deliberately omitted — TACAN-only since the VOR MON cuts), and a
  click-anywhere rule inspector (point-in-polygon + distance from the DCA VOR). Procedures are a
  **decision tree** (Jesse's choice — explicitly not a quiz): 8 entry points → 18 terminal
  checklist cards with squawk chips, phone numbers and reg cites. Facts worth not re-breaking:
  squawk 1234 is the *towered*-field pattern code only — non-towered pattern work (Lee) takes a
  filed SFRA plan + a discrete code from Potomac (866-429-5882) + CTAF, closed at 540-351-6129
  (§93.339(c)/(d)); fringe 1205 is outbound-only; JYO's 1226 covers direct in/out only; Hyde (W32)
  closed 2022 so the "Maryland Three" is two; the gate/sector frequency table is the Jan 2020
  ALC-405 kneeboard and is labelled "verify on the current TAC" — keep that hedge, and don't
  present 124.55 (GRACO LiveATC lore) as the ANP-area SFRA frequency (published App/Dep is 119.7).
  The **violation record** section reads `data/sfra/asrs.json`, built by
  `python scripts/build_sfra_reports.py <sfra.csv> <p56.csv>` from NASA ASRS Database Online CSV
  exports (queries "SFRA OR ADIZ OR FRZ" and "P56" over narrative+synopsis;
  `scripts/fetch_asrs.py` replays the ASP.NET query wizard to fetch them — works as of 2026-08 but
  brittle, run by hand, never in CI). JSON shape is documented in the build script and consumed by
  `js/sfra.js` — change the two together; the section hides itself if the JSON is missing. ASRS is
  voluntary/de-identified (month-granularity dates, mention ≠ violation — the caveats block says so;
  keep it). The official counts card is hand-cited (Mica/Shays Jul 2005 House hearing, GAO-05-928T,
  AOPA brief) — there is NO public official per-year series after ~2005 (FAA EIS/deviation data is
  FOIA-only), so never extend that card with uncited numbers.
- `terps.html` + `js/terps.js` — TERPS, Demystified: pilot-first tabbed explorer of FAA Order
  8260.3G (the 2024 "G" revision; all paragraph refs cite it). Six tabs: rulebook overview,
  Approach Anatomy (the one interactive: shared-axis plan+profile canvas, draggable obstacle,
  navaid morphing, real 3-3-1/3-3-3/3-3-4 visibility logic, 102/GPA ILS OCS with the ≈1.78
  ft-per-ft DA slide-up approximation), minimums, departures, controller side, field guide.
  Tabs deep-link by hash (`#anatomy`), `?nav=`/`?cat=` preselect the interactive. **Currently an
  unlinked `noindex` draft** — on promotion: remove the noindex meta and add the tools.html card
  and sitemap.xml `<url>`.

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
  a forecast that was never captured. The ceiling row judges **height bands on top of flight
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
  by 1609). The change comparison needs no
  archive: `/stations/{id}/tafs` returns a *collection*, so `loadTafPair()` diffs the newest
  issuance against the oldest one still on the wire from today. Both issuances are flattened to
  one entry per hour before diffing — change groups never line up otherwise. The "why" (
  `whyThunder()`) is read off the GFS grid `discussion.js` already loaded, sampled at the field:
  CAPE, CIN (from the DC point call, ~20 nm west and labelled as such), precip and spread. The
  grid table prints the NWS `weather` array verbatim — **that array is what drives the
  thunderstorm icon in every app rendering this data**, so it is the honest answer to "why is
  there no TS symbol". Same `ceilingHeight` −30.48 m sentinel rule as weather.html.
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
- `.github/workflows/wxarchive.yml` + `scripts/wxarchive.py` — hourly Action that archives the
  site's weather history into `data/wx/` on `main` (stdlib only; the workflow commits, no Pi
  involved). **Day-forward: one file per stream per local day, never rewritten**, so history
  accumulates from whenever a stream was added; the only retroactive writes are wxbackfill's
  (below), which fill gaps without touching live-captured entries.
  Streams: `afd/` (every LWX issuance) · `forecast/` (DC daily digests) · `obs/` (KDCA METARs —
  the station the DC forecast is verified against) · `fieldobs/` (KNAK METARs — the airfield's
  own sensor, **hourly not 5-minute, so it is sparser than `obs/` by nature**; set by
  `WX_FIELD_OBS`, skipped when blank or equal to `WX_OBS`) ·
  `stations/<ID>/` (**the local ring** — every other METAR-reporting field around KANP, one
  directory per station, same day-file shape as `obs/`. **Not redundancy**: a ceilometer is a
  pencil beam over one point, and the deck that decides whether a lesson flies — BKN/SCT
  1,000–3,000 ft, nowhere near IFR — is exactly what a single site misses, so KNAK can report
  clear with a layer over the field while KFME/KBWI/W29 see it. Jesse's reason for wanting the
  ring; don't drop stations as duplicates. List in `WX_STATIONS`, default
  W29 · KFME · KCGS · KADW · KBWI · KMTN · KESN · KGAI · KAPG · KCGE · KNHK. KDCA and
  KNAK are deliberately excluded — they already have dedicated streams the verification cards
  are built on, and archiving them twice would fork the record. A station nobody publishes logs
  and is skipped, never fatal) ·
  `grid/` (NWS hourly grid at KANP — ceiling/vis/wind/PoP/weather, 48 h out) · `taf/` (every
  KMTN/KBWI/KDCA issuance, decoded from IWXXM; KADW has no TAF on the NWS API — checked.
  **Deduped by content as well as by issue time**: over 2026-08-27..31 the NWS collection
  endpoint listed hundreds of phantom per-minute issueTimes per station per day, all serving
  the same document — 1,075 entries archived on the 30th holding two distinct forecasts, most
  under wrong times — then froze outright while LWX kept issuing normally. A stamp whose
  decoded periods match a temporal neighbour's now settles into the day file's `"dup"`
  bookkeeping (never re-fetched, capped at `WX_TAF_FETCH_CAP` XML fetches/station/run,
  newest first); consumers only read `"tafs"`. The corrupt days were wiped into `dup` and
  rebuilt from IEM as raw-text `bf` entries) ·
  `alerts/` · `model/` (GFS CAPE/CIN/precip at the field). `git add data/wx` in the workflow
  picks up new streams automatically.
  Its forecast digest mirrors `js/discussion.js` `loadDrift()` — change both together.
  Growth is roughly 70 KB/day (~25 MB/year) with the ring.
- **`api.weather.gov` is a live source, not a source of record — every METAR stream is healed
  from IEM at the end of each run** (`heal_metars()`). Measured over 2026-08-12..30, `obs/` and
  `fieldobs/` each lost ~7 hours a day, and on 13 of those 19 days *the set of missing hours was
  identical for both stations* — KDCA on a 5-minute cadence and KNAK on an hourly one do not fail
  in the same hours by coincidence, so the loss is on the fetch side, not at the stations. It is
  not the scheduler either: each run already re-reads 36 h (`WX_OBS_LOOKBACK_H`) and runs land
  every few hours, so those hours were re-requested and still came back absent. So each run now
  looks for hours with no METAR in the last `WX_HEAL_DAYS` (3) days and, **only for a station
  actually short an hour**, pulls one bulk IEM CSV and merges it — same parsing, dedupe tolerance
  and `bf` tagging as `wxbackfill.py`, which is why those helpers live in `wxarchive.py` now and
  the backfiller imports them. On a healthy day it makes no requests at all. An hour IEM doesn't
  have either, once ≥3 h old, is recorded in the day file as **`nh`** (hours the station never
  reported — normal for a part-time AWOS overnight) and never re-fetched, so a field that sleeps
  at night can't make this pass re-scrape the ring every hour forever. `wxbackfill.py` ignores
  `nh`, so a wrongly settled hour is still repairable by hand. Consumers only ever read `metars`.
  A day file that ends up holding **no** obs is that bookkeeping and nothing else — `index.json`
  does not list it as a day, or a station that has gone dark shows a full day count and reads as
  healthy (KFME did exactly that).
  **TAFs heal the same way** (`heal_tafs()`, added 2026-09-01): the NWS `/stations/{id}/tafs`
  collection listed hundreds of phantom per-minute issue times a day from 08-27 and then froze
  outright on 08-30 22:57Z for every station (still frozen 09-01) while LWX kept issuing, so the
  stream simply stopped. Each run checks the last `WX_HEAL_DAYS` days for a scheduled slot
  (`WX_TAF_SLOTS`, 0520/1120/1720/2320Z) with no issuance within −1 h/+100 min for a station,
  and only for such a station-day lists IEM's AFOS products (`TAF<ID>` pil) and merges what is
  missing as raw-text `bf` entries — the same shape `wxbackfill.py` writes, whose AFOS helpers
  now live in `wxarchive.py`. Amendments between slots are only picked up alongside a missed
  slot; the backfiller remains the thorough repair. **The 08-31 fix commit `adaa826b`
  (content-dedupe into `dup`, 08-27..30 rebuilt from IEM) had been stranded on an unmerged
  web-session branch** — the almanac showed 1,082 TAF "issuances" for 08-30 until it was
  cherry-picked to main on 09-01.
  **Five streams added 2026-09-01, all server-side because their sources have no CORS:**
  `pirep/` (aviationweather.gov PIREPs in `WX_REGION`, ~150 nm box, keyed by report time,
  raw + decoded /TB /IC bands) · `airsig/` (G-AIRMETs SIERRA/TANGO/ZULU and SIGMETs/AIRMETs
  whose polygon touches the region — one record per item per day with `first`/`last` seen,
  so a day file says what was in effect that day) · `tfr/` (the region's rows of the FAA TFR
  list by state/ARTCC, same first/last shape, each with a link to the FAA detail page — there
  is no public detail endpoint; the permanent DC SFRA/FRZ security NOTAMs come through as
  `state: USA` rows) · `raob/` (KIAD 00Z/12Z soundings from IEM as level arrays, ~14 KB/day,
  backfilled to 2026-05-01 with `wxbackfill.py --streams raob`) · `aloft/` (GFS winds/temps
  aloft at the field, 925/850/700/500 hPa + 10 m, 12 h per snap). `latest.json` carries
  `pireps` (last 12 h), `airsig` and `tfrs` (in effect at the last run), `raob` (newest
  sounding) and `aloft` (last snap); `index.json` lists `*_days` for each plus `raob_station`,
  `region`, `aloft_levels`. Shapes are in the `wxarchive.py` docstring.
  **A failing step never blocks the commit** (2026-09-02): the workflow runs the archiver with
  `|| echo ::warning`, because one upstream blip (aviationweather.gov handed the PIREP fetch an
  empty body) made the script exit 1 and the commit step was skipped, throwing away every
  other stream's writes for that hour. The optional AWC/FAA fetches go through `fetch_soft()`
  (empty/non-JSON body → logged, nothing this run).
  Don't "simplify" the archiver back to a single API.
- `.github/workflows/wx3dsnap.yml` + `scripts/wx3dsnap.py` — hourly Action that pulls wx3d.html's
  two GFS grids + center column from Open-Meteo once for everyone and force-pushes them to the
  `wx3d-data` branch (see The Air Above above). Stdlib only, no Pi involved; `--selftest` runs
  its offline checks.
- `scripts/wxbackfill.py` + `.github/workflows/wxbackfill.yml` — **manual** backfill of the
  factual streams (`obs`/`fieldobs`/`stations`/`afd`/`taf` from IEM's archives; `model` opt-in from
  Open-Meteo's historical-forecast API) for a date range, run from the Actions tab or by hand.
  It is now for *history* only — METAR hours and scheduled TAF slots inside the last three days heal themselves hourly.
  KNAK is in IEM's ASOS archive under id `NAK`, so `fieldobs` backfills exactly like `obs`;
  `stations` walks the whole ring the same way, so a field added to `WX_STATIONS` today can be
  given the same history as the rest in one run.
  It never
  touches an entry the live archiver captured and tags everything it writes (`bf`).
  `forecast`/`grid` are deliberately **not** backfillable — no public archive preserves what
  was predicted at the time, and substituting later data would poison drift/verification.
  `--selftest` runs its fixture tests. Backfilled TAF entries carry raw text (`t`/`raw`), not
  the decoded `periods` the live archiver stores — consumers must handle both shapes.
  **Coverage after the 2026-08-06 run:** `obs`/`afd`/`taf` reach back to 2026-05-01;
  `forecast` starts 2026-07-30 and `grid`/`alerts`/`model` 2026-08-04 (live-only, by design).
  `fieldobs` was added 2026-08-12 and backfilled to 2026-05-01 as well. **Commit
  what a backfill writes** — day files *and* `index.json`, which is what every
  consumer reads to know a day exists. A backfill sitting in a working tree
  looks complete on a dev server and is invisible to the site.
- **`data/wx/latest.json` + `js/wx-archive.js` (the `WXA` global) are the site's centralized
  weather source.** `latest.json` is the current state of every stream in one same-origin
  document, rewritten each run; `WXA` wraps it with `latest()`, `index()`, `day(stream, date)`,
  `station(id, date)` / `stations()` / `stationDays(id)` (the local ring — `stations()` reports
  what is *archived*, out of `index.json`, not what was configured),
  `firstSnap(stream, date)` (the morning baseline a go/no-go was made against) and
  `gridAt(snap, field, ms)`. `index.json` also carries **`hours`** — hours held per day,
  parallel to each METAR stream's day list, minus the hours the station never reported — because
  a day file existing is not the same as a day being complete, and nothing on the site could tell
  the two apart. Every call resolves to `null` rather than throwing, so a page can
  read the archive first and fall back to the live NWS API. `discussion.html` uses it for the
  hourly grid's "vs this morning" column; other pages can adopt it incrementally instead of
  each calling NWS themselves. Requires `js/site-config.js` first.

### Backends

- `pi/` — Raspberry Pi backend, Python 3 **stdlib only** (`collector.py`, `server.py`, `exporter.py`,
  `trackutil.py`, `gitutil.py`, `atc.py`, `install.sh`, systemd units).
  The collector tries the public feeds in order (adsb.lol → adsb.fi → airplanes.live) and
  **treats an empty-but-200 response as a degraded feed, not empty sky** — it moves on to the next
  feed and warns on a sustained all-feeds-empty run. Don't "simplify" that away: on 2026-08-01
  adsb.lol served empty 200s for 11 h and the then-first-well-formed-wins logic silently lost the
  data. **Two polls, one request budget** (2026-09-01): the 60 nm poll every 3 s plus a 5 nm
  poll of the pattern area every second in between (`KANP_NEAR_RADIUS_NM` /
  `KANP_NEAR_POLL_SECONDS`) — 2 near + 1 wide per 3 s is the feeds' 1 req/s, and the near
  answer is a handful of aircraft. An empty near poll is a quiet pattern, never "degraded".
  **Fixes are stamped `now − seen_pos`** (the feed's position age), not the poll time, so both
  polls give the same fix the same row and pattern turns aren't smeared by up to a poll
  interval; anything over 5 min old is skipped as stale. Health meta keys describe the wide
  poll only. **The exporter must call `gitutil.maintain()` after pushing** — the amend + force-push pattern
  orphans the previous commit's blobs locally every run, and without pruning `.git` grows without
  bound (it hit 5.7 GB against 301 MB of data on the real Pi). Weather archiving used to live
  here (`wxarchive.py`) but moved to the wxarchive GitHub Action so the Pi stores no weather
  history; `install.sh` retires the old `kanp-wxarchive` units.
- `pc/` — `atc_transcribe.py` (faster-whisper worker) + `atc_vocab.txt`. Runs on the PC, not the Pi.
- `scripts/api-collector.js`, `scripts/receiver-export.js` — legacy Node collector, superseded by
  `pi/`; don't extend it.
- `docs/receiver-setup.md` — RTL-SDR receiver wiring. **Its collector sections (0, 0.5, 4) still
  describe the legacy Node collector as "the setup in use" and are stale**; the receiver-hardware
  sections (1–3) are current. `pi/README.md` is the authority on the backend.

## Data flow (tracker)

Pi is the sole pipeline: `collector.py` polls the public ADS-B feeds every 3 s → SQLite
`/var/lib/kanp/kanp.db` → `server.py` serves API + page on port 8787 (LAN HTTP): `/api/status`,
`/api/tracks`, `/api/stats`, `/api/aircraft`, `/api/export.csv`, `/api/site-traffic`, `/api/atc/*`.
`exporter.py` (systemd timer — hourly in the repo unit, but the real Pi runs it every 15 min via a
local `override.conf` drop-in) pushes simplified per-day JSON snapshots to the **`traffic-data` branch** (single amended commit;
`tracks/index.json` lists days). Track simplification is Douglas-Peucker in a local tangent plane
(`pi/trackutil.py`), shared by the exporter and the API; point tuples are
`[ts, lat, lon, alt, gs, on_ground]` everywhere.

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
  `api.weather.gov/stations/{id}/observations?limit=4`, newest feature that carries a
  `rawMessage` — **not** `/observations/latest`, which routinely serves an ob with blank raw text
  (2026-09-01: every ring station's 23:45Z ob, and for KESN/KMTN it kept serving the blank one
  while a newer good ob sat in the collection; the page reported "empty observation" on four of
  five cards). The site archive's `latest.json` (`WXA`, so `wx-archive.js` is loaded) is the
  fallback, labelled "via site archive" wherever it's used. TAFs: same host, IWXXM XML
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
