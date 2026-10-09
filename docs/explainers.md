# Aviation explainers and knowledge map

Moved verbatim from CLAUDE.md. Sibling docs are in `docs/`; "above"/"below" references to other areas point there. Index: CLAUDE.md → Docs.

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
  Navaid and enroute-fix idents collide nationally (NDB `RU` is in NC and TX; KRUQ's NDB approach
  drew its final from Texas until 2026-09-12), so the builder keeps every position per ident and
  `resolve()` takes the one nearest the airport.
  **It is an analysis tool about procedures at large, not a flying tutor** (Jesse, 2026-09-12:
  students learn to fly the procedure from the chart, which already has its own map). Two views
  beside the explorer, in `js/procedures-national.js` (`#modes` tabs, `#view=national|changes`
  in the hash alongside the explorer's `apt`/`sel`; a row click hands off to
  `window.ProcExplorer.open(apt, procId)` in `procedures.js`): **Nationwide** — every coded
  procedure in the country queried at once from `data/procedures/metrics.json`
  (type · kind · state · text · RF / DME-arc / procedure-turn / hold-in-lieu / circling-only /
  missed-ends-in-hold / plate-only flags · VPA ≥ · SID climb ≥ · STAR descent ≥, plus presets),
  with stat tiles, a zoomable Leaflet dot map on the explorer's dark basemap (was an Albers canvas
  for a day — Jesse: too big, and the PR inset sat on Florida), by-kind / by-state bars
  that filter on click, a one-measure histogram (VPA, FAF→MAP, FAF altitude, missed climb-to,
  SID climb, STAR descent, top constraint, length, transitions, legs, fixes — single hue, dashed
  median), a sortable table and the most-shared fixes; **This cycle** — `changes.json`, the diff
  against the previous AIRAC cycle: added, withdrawn, and changed leg by leg (altitudes, speeds,
  angles, courses ≥ 1°, fixes, transitions; a renumbered SID/STAR is paired with its successor as
  one "revised from" entry, and tenth-of-a-degree course shifts are magvar noise, dropped).
  Both files come from **`python scripts/build_procedure_metrics.py`** (stdlib, no downloads;
  reads the committed airport files and the previous cycle out of git history — the newest
  commit of `index.json` with a different `cycle`), so **each cycle is two commands**:
  `build_procedures.py` then `build_procedure_metrics.py`, and commit all three outputs. Column
  meanings are in that script's docstring; two of them are honest approximations and say so in
  the table tooltips — a SID's `grad` is measured over the straight line from the departure end
  to the first at-or-above fix (the shortest possible path, so a ceiling on the gradient, and
  no figure at all when a vector leg precedes the fix), and a STAR's `dg` is the steepest
  descent the constraints *require* (floor at the earlier fix to ceiling at the later).
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
- `alternates.html` — Alternate Rules: FAA alternate airport requirements by part (91/121/135/125),
  alternate minima, takeoff alternates, a flowchart per part. Self-contained. Tracked since
  2026-08-21 but **never linked or in the sitemap** — no tools.html card. Orphan until promoted.
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
- `pressure.html` + `js/pressure.js` — Pressure Systems (2026-09-03): a field of draggable Gaussian
  highs/lows (1013 hPa + one Gaussian each, so ∇p, ∇²p and isobar curvature are analytic) with the
  wind at every point as the **steady balance of pressure-gradient force, Coriolis (f = 2Ω sin φ,
  latitude slider −90..90) and linear friction** (slider, k ≤ 1.2×10⁻⁴ s⁻¹) — k = 0 → geostrophic,
  f = 0 → straight down the gradient, both 0 → no balance, capped at 150 kt and said so. Speed is
  then scaled by the gradient-wind solution for the local curvature (toggle; anticyclonic
  no-solution case caps at fR/2). Plan view: marching-squares isobars every 4 hPa, pressure tint,
  speed-scaled tracers, WMO barbs (feathers 90° clockwise of the upwind staff in the N hemisphere,
  CCW in the S), hover → the force vectors at the cursor (PGF amber · Coriolis blue · friction
  grey · dashed green net = the centripetal residual when curvature is on · wind white), and
  **parcels dropped from rest that integrate the real equation of motion** (RK2, 6 substeps) —
  without friction they trace inertial loops and never settle; that is the point, don't damp
  them. 3-D view: same field, orthographic orbit like wx3d (drag), vertical ×100; k falls
  linearly to 0 across a 1.5 km friction layer, ageostrophic divergence a(k)·∇²p/ρ integrated in
  closed form gives w (rising over the L, sinking over the H), above the layer w arches to 0 at
  10 km and a −P outflow returns the mass — mass-consistent, but a schematic (the footer says
  so). Cloud sheet at 3 km = where the layer pumps air up. Time runs 1 s = 3 h at ×1. Units SI
  inside, nm / kt / hPa on screen, °true. Self-contained (no `site-config.js`, no fetches);
  `window.PRESSURE_DEBUG` exposes `field`/`wind`/`wind3`/`wBL` for headless checks. Distinct from
  the homepage easter egg `js/synop.js` (geostrophic-only tracers behind the landing page).
- `storm.html` + `js/storm.js` + `js/storm-model.js` — Thunderstorm Lab (2026-09-04): a 2-D
  cloud model run live in the browser, from a warm bubble to anvil debris. `storm-model.js` is
  the physics and has no DOM — `node js/storm-model.js <preset> <minutes>` steps it headless
  and prints stage/updraft/rain/charge/flash diagnostics, which is how it was tuned; keep it
  that way. Grid 128 × 64 (312 × 250 m, 40 × 16 km), 5 s steps, ~4 ms each. Dynamics:
  anelastic, MAC-staggered, semi-Lagrangian, **exact** pressure solve (FFT in x, tridiagonal
  in z) — a Gauss-Seidel projection left the flow compressible and the updraft hit 99 m/s;
  **θ is advected as a total, never as the perturbation** (advecting θ′ hands a rising parcel
  the environment's own dθ̄/dz as free heating: +45 K aloft). Storm-relative frame (mean 0–6 km
  wind subtracted; the ground and the field scroll under it). Microphysics: Kessler warm rain
  plus a mixed-phase branch (freezing by temperature, Bergeron, riming → graupel, rain
  freezing, hail growth, melting, deposition/sublimation), every latent heat fed back;
  graupel accretion is deliberately slow (0.8·qc·qg^0.875) — faster starved the mixed-phase
  region and no charge separated. Electrification: non-inductive graupel–ice charging in
  supercooled water, sign flipping at −15 °C with the warm-side rate 0.6× (the lower positive
  centre must stay weaker than the main negative or nothing reaches the ground); E from 3-D
  point charges of an 8 km slab + image charges; initiation 130 kV/m·ρ/ρ₀ **halved in heavy
  precipitation** (hydrometeor corona) — without that every flash fires in the upper dipole
  and CGs never happen; bidirectional leaders (negative end follows −E), ground contact = CG,
  channel neutralises charge within 1.1 km. Typical mature cell: 25 m/s, 2–3 flashes/min,
  ~15 % CG, 5–20 C per flash. Thunder is synthesised from the channel geometry (each segment
  arrives at d/343 s, 1/d, low-passed with distance) in **real time**, not model time. The
  microscope panel is a molecule-scale view of the probe cell driven by the model's own
  tendencies there (condensation/evaporation, Bergeron transfer droplet → crystal, riming,
  melting, freezing, charging collisions with e⁻ transfer), crystal habit by temperature.
  Sounding panel: skewed T–z of the environment, parcel, CAPE/CIN fills, live model column at
  the probe; sliders rebuild the environment and restart. Presets in `StormModel.PRESETS`
  (pulse · multicell · strong shear · capped · high-based dry · stable). Known limits, said in
  the help: 2-D has no rotation so no supercells, no corona screening (ground E runs high),
  the "strong shear" preset is weaker than reality for that reason. Self-contained (no
  `site-config.js`, no shared CSS, no fetches); carries GoatCounter + pagever like the other
  explainers. `window.STORM_DEBUG` exposes the model and UI state for headless checks.
- `tunnel.html` + `js/tunnel.js` + `js/tunnel-model.js` + `js/tunnel-worker.js` — Wind Tunnel
  (2026-09-12): a 2-D lattice-Boltzmann flow solver (D2Q9) run live around a NACA 4-digit
  airfoil (camber · position · thickness · plain flap at 70 % · α about the quarter chord;
  presets incl. a flat plate and a cylinder), with smoke rakes, pressure / speed / vorticity
  tints, live C_L / C_D by momentum exchange at the wall, Cp along the chord from the first
  fluid cell, a separation point (first upper-surface probe 3 cells out with reversed flow),
  a lift sparkline that buffets at stall, and a `sweep α` that plots the lift curve against
  the thin-airfoil line 2π(α − α₀). `tunnel-model.js` is the physics and has no DOM —
  `node js/tunnel-model.js 2412 12 3000 1500` steps it headless and prints Cl/Cd/separation —
  and runs in a Web Worker (`tunnel-worker.js`, buffers ping-ponged with transferables,
  ~12 ms of steps per publish) with an in-thread fallback. Lattice 400 × 220, chord 90 cells,
  U∞ = 0.1 (Mach 0.17), Re slider 100–3,000 (ν from Re; a phone gets 300 × 165 / chord 68).
  **Collision is BGK, not TRT, on purpose**: the TRT split is in the code (`lambda` option)
  but with bounce-back bodies at τ → 0.5 every Λ ≠ τ² blew up where BGK ran clean to Re
  5,000 / α 25° / flap 40° / the cylinder at 1,000 — and the fixed-velocity inlet/top/bottom
  rows need the **8-cell viscous sponge** (16 at the outlet; both relaxation rates blend to 1
  there) or the inlet corners pump the run unstable. Validation: cylinder Cd 1.5 at Re 100
  (textbook 1.4 plus blockage). Known and disclosed: 2-D (no induced drag), Re ≤ 3,000 vs
  ~3×10⁶ on a real wing, walls 2.4 chords apart inflate lift, and post-stall lift keeps
  rising with α as a 2-D bluff body's does — the stall story is the separation point, the
  buffet and the Cd rise, not a C_L peak. Streaklines fade with stretch and break past 9
  cells (a chord across a vortex core is not smoke). Self-contained (no `site-config.js`, no
  shared CSS, no fetches); `window.TUNNEL_DEBUG` for headless checks.
- `skew-t.html` + `js/skewt.js` + `js/skewt-obs.js` — Skew-T Explorer: canvas skew-T log-p
  (1000→100 hPa, 21 levels) of Open-Meteo pressure-level forecast soundings, 3 days hourly, for
  any US airport (coords resolved via `api.weather.gov/stations/{id}`; model selectable), with
  parcel analysis. Thermo is Bolton (1980); CAPE/CIN are integrated from the plotted profile
  **without virtual-temperature correction** (said in the UI — keep the disclosure if you change
  the math).
  **Parcel rules fixed 2026-09-10 — three of them, verified against all 254 archived KIAD
  soundings in `data/wx/raob`:** the **LFC is at or above the LCL** (a superadiabatic surface
  layer makes the dry-adiabat parcel buoyant at the ground, and taking that as the LFC put
  "LFC 0 ft AGL" on 116 of those soundings and left CIN at 0 on every capped day); **CIN is the
  negative area from the surface to the LFC**, sub-LCL layer included — which is where most of
  it usually is, and which the blue shading on the diagram already drew, so the number and the
  picture disagreed; and **no LFC means no CIN to state** (`cin: null` → `—`), since integrating
  negative area to 100 hPa printed −17,672 J/kg on a stable morning. Every derived index carries
  a `title` tooltip defining the acronym (`push(k, v, cls, t)` in `computeIndices`, rendered by
  both this page and `skewt-obs.js` — keep the two renderers in step; no double quotes in the
  tooltip text).
  `skewt.js` exposes `window.SkewTCore`, which `skewt-obs.js` reuses for observed
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
- `sequencing.html` + `js/sequencing-{nav,core,demos,ui}.js` — GPS Sequencing (2026-09-05).
  **Its tools.html card was removed 2026-09-06 at Jesse's request** — the page and its
  sitemap entry stay, so it is reachable by URL and by search but unlinked from navigation
  (the fireworks.html pattern). Don't re-add the card without being asked. What it is:
  why an IFR navigator sequences when it does. **Started as a touchscreen replica of a panel GPS
  and was pivoted away from that**, because students who need muscle memory should be on the
  manufacturer's own trainer app on a tablet, and a browser mock will always lose that fight.
  What a simulator can't show is the box's reasoning, so that is what this draws: active leg, next
  leg, whether sequencing is armed or suspended, and **the reason in words**
  (`nav().note` — "Fly-by WEGRO — sequences in 2.6 nm", "SUSP at the missed approach point").
  Don't rebuild the bezel. Six sections, each with buttons that drive one shared demo: load vs
  activate · fly-by vs flyover · SUSP · OBS · GPS→VLOC · tuned-is-not-identified. A demo is one
  object in `sequencing-demos.js` (`id`/`label`/`note`/`run()`); helpers there load an approach and
  place the aircraft a given range and bearing off one of its fixes.
  Nav data is the existing `data/procedures/` CIFP build, no second copy.
  **Three properties were verified across every approach in that build and the engine depends on
  them**: exactly one leg per final carries flags bit0 and never the first, so the missed approach
  starts there and the MAP is the leg before it; the vertical angle always sits on that MAP leg, so
  the FAF is `MAP - 1`; and **coded courses and radials are MAGNETIC**, converted to true once in
  `decodeLeg()` (`true = coded + apt.mv`) — before that fix the coded 041 sat on the leg the
  geometry called 031. Recheck all three after an AIRAC rebuild; the FAF is what the CDI capture
  geometry measures from.
  Modelled: fly-by turn anticipation vs flyover, auto-suspend at the MAP / in holds / on altitude
  legs, OBS (and the same key becoming *unsuspend* whenever the box suspended itself), hold in lieu
  of PT flown as a real racetrack for one circuit, and GPS→VLOC switching only with the approach
  active, the localizer **active rather than standby**, within 1.2 nm of the final course, and
  2.0–15.0 nm from the FAF **on the approach side** — measuring range alone let the window re-arm
  past the FAF, firing exactly where the 2 nm rule exists to prevent it. **Tuning and identifying
  are separate states on purpose**: the name under a frequency is a reverse-frequency lookup from
  the database and appears even for a standby frequency; identification is the Morse decoded off
  the *active* frequency with the ident audio on, and students conflate the two.
  `SeqDemos.watches()` is the old misstep list rebuilt as a live annunciator — loaded-not-activated,
  localizer-in-standby, tuned-but-not-identified, inside-2-nm-still-on-GPS, OBS-left-on — shown in
  the "Worth flagging" pane rather than graded.
  **`data/sequencing/facilities.json` frequencies are placeholders** (`"verified": false`): the CIFP
  build carries no navaid frequencies. The navaid *idents* are real, read off the coded legs'
  recommended-navaid field. `window.SEQUENCING_DEBUG` drives it headlessly.
  Gotcha fixed and worth not reintroducing: activating a leg whose predecessor is a vector leg
  (VI/CA/VM, no coded fix) must fall back to present position for the leg origin — storing the
  previous leg's null lat/lon made the geo math read 0°N 0°E and the leg sequenced instantly, which
  hit every missed approach.

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

