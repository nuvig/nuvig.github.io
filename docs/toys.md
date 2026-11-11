# Toys and personal pages

Moved verbatim from CLAUDE.md. Sibling docs are in `docs/`; "above"/"below" references to other areas point there. Index: CLAUDE.md → Docs.

- `celebrate.html` — one-off page marking the tracker's return after the 2026-10-14 Pi SD-card failure (down 10-14 20:20 local, rebuilt 10-20). Confetti canvas; Down/Back/Gap are hardcoded, Archive and Snapshot lines read `summary.json` from `SITE.tracker.snapshotBase` live (amber dot + "export pending" while the newest snapshot is over 2 h old). Loads `site-config.js` only; `noindex`, unlinked, not in the sitemap.
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
- `kristina.html` — single-screen personal page: breathing orb with an in/out cue on an 8 s
  cycle, a status line, and an "is he done yet?" button that cycles through no. ™ is the running
  joke — on every line, a floating ™ field behind the page, a burst per click. A second
  full-height section (`#fire`, linked from the first) says STOP PLAYING WITH FIRE™ over CSS
  flames; its "put it out" button lowers the flames a step and they grow back. A third (`#og`)
  is Olive Garden™ without her: a plate of CSS breadsticks, a his/hers tally (hers is 0), and an
  "another breadstick" button that bumps his count and the plate. A fourth (`#packet`) riffs
  on the 2013 "friggin' packet, yo" classroom video: ruled-paper background, a pile of stapled CSS
  packets, a packets-handed-out / hearts-touched tally (the latter stays 0), a "hand her a packet"
  button, and a "walk out" link back to the top. `#tm` sits at `z-index: 2` (pointer-events
  none) so the ™ field shows over the coloured sections. Self-contained;
  **unlinked and `noindex`**.
- `design.html` + `css/design.css` + `js/design.js` — Design Specimens (2026-11-06): a design
  showcase, not an aviation tool. Hero is a split-flap departures board (one WAAPI half-turn per
  flap, per-column drums — digits-only for the row numbers and clock so they don't crawl through
  the alphabet, a UTC clock row, rows are buttons that scroll to their plate, the method column
  cycles alternates every 6.5 s after the reveal). Eight plates: **01 Type** — Recursive from
  Google Fonts, five axes on sliders with an idle auto-drift, weight waterfall, sans/mono ×
  linear/casual, fluid `clamp()` scale printing live px; falls back to system fonts and says so
  under the waterfall. **02 Color** — OKLCH hue dial; OKLCH→sRGB with chroma-walk gamut mapping
  in JS (`color()`), constant-chroma ramp vs an HSL ramp at the matched hue, `in oklch` vs
  `in srgb` gradients, WCAG ratios; "accent → page" writes `--accent-h` on `<html>`, which every
  canvas picks up through `pal()`. **03 Motion** — six easing lanes (cubic-bezier solved in JS for
  the thumbnails; spring and bounce emitted as `linear()` when supported, sampled keyframes
  otherwise), distance-staggered tile ripple. **04 Light** — SVG attitude indicator (moving card
  with pitch ladder, sky pointer, fixed bank scale, GYRO flag that retracts 1.5 s after first
  sight) inside a 3-D-tilting card with a pointer-tracking specular; spring-damped; a chip asks
  for `deviceorientation` (iOS permission prompt). **05 Physics** — windsock: 3-D Verlet spine
  (v² drag ∝ local radius, bending constraint, value-noise gusts and direction wander), rings
  lofted into shaded quads drawn in painter's order, pole + ground shadow; compass dial sets
  wind-from, slider sets speed. **06 Generative** — simplex-noise pressure field drifting east,
  marching-squares isobars every 4 hPa, NH geostrophic wind drawn as station barbs (barbs on the
  right looking up the shaft), H/L extrema labelled, tap drops a low that fills over ~10 s, hover
  reads pressure and wind. **07 Sound** — NAV radio: dual-concentric knob (outer MHz, inner 50 kHz,
  by pointer angle / wheel / arrows), ACT⇄STBY flip, the six VORs from `js/sfra.js` as station
  chips (same NASR-verified frequencies); a tuned station keys its Morse ident at 1020 Hz every
  ~8 s through Web Audio, letters light as they key, a scrolling keyed-carrier scope; audio only
  after the sound chip (gesture). **08 Icons** — eight 24-grid line icons with per-part CSS motion
  on hover/tap, the compass at 16–96 px. Page controls (top right): night/day theme with a View
  Transitions circular reveal, 8 px baseline + 12-column grid overlay (also shows the plates'
  registration marks), SVG-turbulence grain, sound; prefs persist in localStorage `design-prefs`
  (also the applied accent hue). Every animation loop is gated by one IntersectionObserver plus
  page visibility (`Vis`); `window.__design.vis()` lists `[el, visible, running]` for headless
  checks. Verified with headless Edge (the Browser pane throttles rAF to ~2 fps, so it can't judge
  motion). Indexed (sitemap, README) but **not on tools.html** — same rule as glow/watercycle.

