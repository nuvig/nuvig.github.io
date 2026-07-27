# jesselevine.net

Personal site for Jesse Levine — flight instructor (CFI/CFII/MEI) in
Annapolis, MD. Hosted on GitHub Pages, served from `main`.

Plain HTML/CSS/JS: no build step, no framework, no npm. Leaflet is vendored in
`js/vendor/`. The only tooling is two stdlib-Python data generators whose
output is committed to the repo.

## Pages

**Site**

- **`index.html`** — landing page: flight-training services and contact.
  Includes a small ball-physics toy (`js/sim.js`), lazy-loaded on first click
  of the ▶ button so it costs a normal visit nothing.
- **`tools.html`** — the Aviation Tools hub; the categorized index of the
  explainers below.

**Flight tracker**

- **`kanp.html`** — flight tracker for Lee Airport (KANP), in three tabs:
  - *Live* — current ADS-B traffic within 60 nm on a Leaflet map, with
    altitude-colored trails and a geographic heatmap.
  - *History Map* — replays any collected day's tracks with hour-of-day and
    altitude filtering; the airspace-study tool.
  - *Traffic Study* — hour-of-day × day-of-week activity grids, altitude and
    type histograms, runway operations counts, plus two comparison tools:
    **climb-out** (altitude gained vs distance from liftoff, for comparing the
    same aircraft across density altitudes) and **straight-in** (how precisely
    each arrival tracked the extended centerline).

**Interactive explainers** (self-contained, no backend)

- **`procedures.html`** — Procedure Explorer: overlays any US SID/STAR/IAP on
  a sectional/TAC/IFR map with a 3D altitude view, per-transition selection,
  flow animation and shareable links.
- **`power.html`** — the airplane power curve: parasite vs induced power,
  minimum-power speed, the region of reversed command, slow flight, and a
  live approach simulation of the low-and-slow trap.
- **`eights.html`** — eights on pylons: pivotal altitude, why the wingtip
  stays on the pylon, and a wind-aware simulation of the full maneuver.
- **`airlab.html`** — atmosphere and performance lab: pressure and density
  altitude, an air-parcel stability simulator, and IAS → TAS → GS.
- **`knowledge.html`** — an expandable concept graph of the airplane
  knowledge domains, with the cross-links between them.

**Weather**

- **`weather.html`** — wind compass, flight-window scoring, crosswind and
  runway analysis, TAFs and radar. Sources are NWS (`api.weather.gov`) for
  observations, TAFs and the forecast grid, Open-Meteo for CAPE/pressure/winds
  aloft, and RainViewer for radar tiles.

**Radio**

- **`atc.html`** — LiveATC transcript viewer for the Potomac feeds around
  KANP. Requires the Pi backend; there is no public fallback, and recordings
  are never republished (LiveATC's terms forbid it).
- **`ctaf.html`** / **`scanner.html`** — KANP CTAF 122.9 clips and a remotely
  tunable SDR scanner. These talk to a separate SDR machine over a private
  Tailscale funnel; that server's code is not in this repo.

## KANP tracker architecture

A Raspberry Pi is the whole data pipeline; the browser only reads.

- **Collection** — `pi/collector.py` polls [airplanes.live](https://airplanes.live)
  every 3 s for traffic within 60 nm of KANP and writes positions to SQLite at
  `/var/lib/kanp/kanp.db`. It can poll a local dump1090-fa/readsb receiver
  instead via `KANP_SOURCE`. Python 3 stdlib only — nothing to pip install.
- **Serving** — `pi/server.py` serves a filterable API *and* the tracker page
  itself on port 8787: `/api/status`, `/api/tracks`, `/api/stats`,
  `/api/aircraft`, `/api/export.csv`, `/api/site-traffic`, `/api/atc/*`.
- **Publishing** — `pi/exporter.py` runs hourly and pushes simplified per-day
  JSON snapshots to this repo's `traffic-data` branch, where
  `tracks/index.json` lists the available days. Tracks are shape-simplified
  with Douglas-Peucker in a local tangent plane (`pi/trackutil.py`), so turns
  and pattern work survive while straight legs collapse to a few points.
- **Routing in the browser** — the page tries the Pi API first and falls back
  to the GitHub snapshots automatically (`js/kanp-static.js`), which is what
  happens off-LAN, since the HTTPS site can't call a plain-HTTP Pi. Snapshot
  data is up to an hour stale, so Live polls every 3 s against the Pi and
  every 60 s against snapshots. Served from the Pi itself, the page uses the
  same origin with no setup; otherwise set `kanp_api_base` in `localStorage`
  (or `none` to force snapshot mode).

Backend install, configuration and storage math: **[`pi/README.md`](pi/README.md)**
(`sudo bash pi/install.sh`; update later with `git pull && sudo bash pi/install.sh`).

Wiring up your own RTL-SDR antenna: [`docs/receiver-setup.md`](docs/receiver-setup.md)
— note that its collector sections describe the older Node collector in
`scripts/`, which `pi/` has superseded; the receiver-hardware sections still
apply.

## Generated data

Two datasets are built by script and committed. Neither runs at page load and
neither should be hand-edited.

**Instrument procedures** — `data/procedures/` (an airport index plus one JSON
file per airport, ~3,000 of them), converted from the FAA CIFP. Rebuild each
28-day AIRAC cycle:

```sh
python scripts/build_procedures.py        # downloads the current cycle
```

**Knowledge map** — `data/knowledge/*.md` is the source of truth, one Markdown
file per domain. Edit the Markdown, then rebuild:

```sh
python scripts/build_knowledge.py
```

This compiles `data/knowledge.json` and validates as it goes: duplicate ids
and unresolved cross-links are fatal errors rather than silent omissions.
Commit the regenerated JSON alongside the Markdown. The grammar is documented
in [`data/knowledge/README.md`](data/knowledge/README.md).

## Development

No build step. Serve the directory with any static server:

```sh
python3 -m http.server
```

Site-wide constants — airport, coordinates, runway geometry, nearby fields,
TAF stations — live in `js/site-config.js` as a single `SITE` global. Edit
those rather than the pages that consume them; `pi/site.env.example` is the
Pi-side mirror.

A few assets are versioned by query string (`js/foo.js?v=3`). If you change
one, bump the number wherever it's referenced, or GitHub Pages will keep
serving the cached copy.

The site deploys itself on push to `main`. API keys never belong in this
repo — it's public.
