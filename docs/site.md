# Site pages: home, tools, sitemap, changelog, feed

Moved verbatim from CLAUDE.md. Sibling docs are in `docs/`; "above"/"below" references to other areas point there. Index: CLAUDE.md → Docs.

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
  The last section is **Unfinished projects** (2026-09-11): a collapsed `<details>` at the bottom
  holding the cards for pages that aren't done. `sky.html` (METAR Sky) and `sfra.html` (The DC
  SFRA) moved there from the Weather and Cockpit sections at Jesse's request — their sitemap
  entries stay, and the JSON-LD `ItemList` lists the finished tools only.
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
  `summary.json`) — plus `notam` (2026-09-12, below) and **`sfc` (2026-10-08: one line per WPC
  surface analysis at its valid time, `H · L · fronts · troughs · deepest L`; the expansion lists
  every feature as lat/lon)**. Reads **only** `WXA` plus that one tracker document — no weather API of
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
  **An AIRMET/SIGMET expansion draws its polygon** (`drawThumb()`): the record carries
  the vertices, and where the hazard is is what words are worst at. The coastline under
  it is `data/wx3d/terrain-wide.json`, the elevation grid wx3d.html already ships — sea
  level is water, which draws the Bay and the coast with no coastline data at all. The
  frame is that grid's box, fixed, so two thumbnails are the same picture at the same
  scale; a polygon reaching past it is clipped and the tooltip says so rather than the
  map quietly rescaling. The dashed box is `index.json`'s `region` — what the archiver
  keeps a polygon for. TFRs get no map: the FAA list carries no geometry.
  **Chip tooltips name the pages that read the stream** (`chipTitle()`, `STREAMS[].on`) —
  the feed is the intake, not the consumer, and every stream here exists for a page
  somewhere. Keep `on` in step when a page starts or stops reading a stream.
  **The live note prints the archive's last run next to the poll** — the poll is a
  minute, the archive is not, and "checked just now" alone read as "these arrived just
  now".
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
  **A day header says one thing: `complete` or `N h missing`** (Jesse, 2026-09-04:
  "just say if there is data missing or not. remove all the junk" — it used to print
  per-stream hours held, hours never reported and a station-by-station list of what IEM
  healed). The verdict reads `index.json`'s `hours`, not the rows on screen — a count of
  records cannot show what never arrived. Hours a station never reported (`nh`) are not
  missing, and neither are hours after `index.json`'s `updated` stamp, so the archiver's
  unreached hours never read as gaps. The per-station breakdown is the line's tooltip;
  a day whose files were never opened says `not loaded` rather than claiming completeness.
  Backfilled AFDs, TAFs and soundings (`bf`) still carry the `healed` tag on their row.
  Don't put the breakdown back in the header.
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
