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
  in the script), injected under each page's title. **`surface.html` was added as a sixth slot
  2026-10-08** when the page shipped (a weather product, in the family) — pull it if unwanted. It replaced those pages' ad-hoc subtitle links
  (weather.html keeps its non-weather tracker/air-lab links). **METAR Sky (`sky.html`) was pulled
  out of the strip the same day at Jesse's request** — it carries no `wxnav.js` script tag and
  doesn't appear in `PAGES`. Keep it scoped to the remaining weather family — it is not a site nav
  bar, and sky2/terps stay out (deliberately unlinked).
- **Every public page** (the ones listed in `docs/`, i.e. everything but the self-contained
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
- **`README.md` is the public description of the repo** (rewritten 2026-09-13 from the current
  tree; it had described early August). Its page list mirrors `tools.html`'s sections plus an
  "unlinked" list. A new page, pipeline or build script gets a line there too. Nothing personal
  about Jesse goes in it or in this file — only what the code needs.
- Never commit API keys — this repo is public. The tracker's optional RapidAPI key lives only in
  the visitor's `localStorage`. The one deliberate exception is `SITE.basemap.cartoKey`
  (CARTO basemap tile key, added 2026-08-29): it's a client-side key that appears in every
  visitor's tile URLs by design, so committing it exposes nothing the live site doesn't.


## Docs

Area detail lives in `docs/`, not here. Read the file before changing what it covers.
A new page, pipeline or script gets an entry in the matching doc.

| Doc | Covers |
|---|---|
| `docs/site.md` | index, tools, sitemap, changelog, feed, 404 |
| `docs/toys.md` | bubbles, slime, fireworks, glow, watercycle, fugue, mural, zoey |
| `docs/tracker.md` | kanp.html tabs (`js/kanp*.js`), tracker data flow |
| `docs/explainers.md` | procedures, aircraft, alternates, power, eights, instruments, airlab, pressure, storm, tunnel, skew-t, knowledge, sfra, terps, sequencing; knowledge-map build |
| `docs/notam.md` | notam.html, notamarchive, locations build |
| `docs/weather.md` | weather, sky, sky2, wx3d, discussion, wxai, almanac, storms, afd, surface |
| `docs/wx-archive.md` | wxarchive, healing, wx3dsnap, wxbackfill, `WXA` / `data/wx` |
| `docs/pi.md` | `pi/`, `pc/`, legacy collector, receiver setup |
| `docs/atc-sdr.md` | atc, ctaf, scanner |

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
- **Ship finished work to `main` — don't ask.** Jesse, 2026-09-11: "i like always ask this, it's
  in claude.md, idk how to get you to just make shit live when you're done. i cant review it
  anyway on my browser, whats the point." A web session's designated `claude/…` branch is
  scratch space: when the work is done and verified, merge it to `main` and push, in the same
  turn, without a permission round trip. The verification happens here (headless browser /
  fixture run) because he can't review a branch from his phone. Only hold back when he said to.
- Test in the browser preview before pushing; the site is live on push to `main`.
- **Don't infer Jesse's life from the code.** The site scores flight windows; that does not
  mean he cancels lessons on the morning forecast, or anything else about how he flies or
  works. State what he told you, ask what you don't know, and keep personal matters out of
  repo files (2026-09-13).
- Related repo: `C:\Users\Jesse\Documents\GitHub\kanp-tracker-ios` (SwiftUI port of the tracker).
