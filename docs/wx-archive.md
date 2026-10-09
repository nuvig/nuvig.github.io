# Weather archive and snapshot pipelines

Moved verbatim from CLAUDE.md. Sibling docs are in `docs/`; "above"/"below" references to other areas point there. Index: CLAUDE.md → Docs.

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
  **IEM rate-limits bursts (found 2026-10-01):** the heal fired its 13 ASOS requests 0.15 s
  apart and IEM answered 429 to every station after the first two, every run since the ring was
  added — KDCA/KNAK healed (first in line), the ring never did, and a 429'd station was skipped
  unsettled, which is why Sep 22–26 showed ~300 ring hours missing a week later with nothing
  marked `nh`. Every IEM request now goes through `iem_text()` / `iem_json()` (`WX_IEM_PAUSE_S`
  2 s apart, a 429/5xx retried 3× with Retry-After or 4/8/16 s); `wxbackfill.py` shares them.
  Check the Actions log for `heal <ID>: HTTP Error 429` before blaming a station.
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
  **`sfc/` (2026-10-08): WPC's coded surface bulletin.** `snapshot_sfc()` reads the eight
  `wpc.ncep.noaa.gov/discussions/codsusHH_hr` pages — the newest 0.1° bulletin per synoptic
  hour, so one run covers 24 h and a 2.4 h-late run misses nothing — and `parse_codsus()` turns
  `HIGHS 1018 2640581 …` / `COLD 4750622 4420644 …` into `{t, i, hr, highs:[[mb, lat, lon]],
  lows, fronts:[{k: cold|warm|stnry|ocfnt|trof, p:[[lat, lon]]}]}` (7/6-digit tokens are tenths,
  4/5-digit the whole-degree ASUS01 bulletin IEM also files under the pil; IEM's copies wrap at
  70 columns; the valid time's year is the issuance line's, rolled back when the valid time lands
  > 2 days after issuance). One entry per valid time, in the local day file of the valid time
  (`sfc_merge`: 0.1° beats 1°, a later issuance beats an earlier one). `latest.json` carries
  `sfc` (the newest analysis), `index.json` `sfc_days`. `wxbackfill.py --streams sfc` fills from
  IEM (`cgi-bin/afos/retrieve.py?pil=CODSUS&sdate&edate`, sdate inclusive / edate exclusive /
  UTC, a week per request, both resolutions and every retransmission in one text, filed by local
  day, tagged `bf`, never over a live entry) — run 2026-10-08 back to 2026-05-01: 1,277 analyses,
  ~50 KB/day, 7.5 MB. `--selftest` covers the parser, the merge and the backfill. Read by
  `surface.html`, the feed and the changelog health panel.
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

