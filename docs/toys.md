# Toys and personal pages

Moved verbatim from CLAUDE.md. Sibling docs are in `docs/`; "above"/"below" references to other areas point there. Index: CLAUDE.md → Docs.

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

