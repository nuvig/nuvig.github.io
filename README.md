# jesselevine.net

Personal site for Jesse Levine, flight instructor (CFI/CFII/MEI) at Lee Airport
(KANP), Annapolis MD. GitHub Pages, served from `main`.

Plain HTML/CSS/JS. No build step, no framework, no npm. Leaflet is vendored in
`js/vendor/`. Tooling is stdlib Python: a few data generators whose output is
committed, and three GitHub Actions that archive weather, GFS grids and NOTAMs
into the repo on a schedule.

## Pages

**Site**

- `index.html` — landing page: flight-training services, contact, live cards.
  The cards are the navigation: Tracker, Weather, Tools.
- `tools.html` — Aviation Tools hub, the index of everything below.
- `changelog.html` — commit history of `main` beside health panels for the
  data pipelines.
- `feed.html` — the site's intake log: every record the weather and tracker
  archives take in, newest first.

**Flight tracker**

- `kanp.html` — ADS-B traffic within 60 nm of KANP, three tabs:
  - *Live* — current traffic, altitude-colored trails, heatmap.
  - *History Map* — any archived day's tracks, filtered by time, altitude,
    aircraft class and KANP operation (pattern laps, departures, arrivals by
    runway).
  - *Traffic Study* — hour × day grids, histograms, type/operator breakdowns,
    and five sub-tools: climb-out comparison, straight-in precision, pattern
    shape, proximity events, runway ops counts.

**Weather** (KANP / DC area)

- `weather.html` — wind compass, flight-window scoring, crosswind and runway
  analysis, TAFs, radar, PIREPs, AIRMETs/SIGMETs, TFRs.
- `discussion.html` — the LWX forecast discussion read as a story: headline,
  synoptic map, AFD reader with change log, aviation grid strip, and a
  verification card that judges each forecast window as it closes.
- `skew-t.html` — Skew-T log-p of forecast soundings for any US airport, with
  parcel analysis and an explain-on-hover overlay for SPC observed soundings.
- `wx3d.html` — The Air Above: the GFS forecast as a rotatable 3-D volume
  over the DC region, cloud decks, winds aloft, flow tracers, radar drape.
- `almanac.html` — the weather archive as a reading room: calendar, day
  meteogram, forecast lead-up, TAF vs METAR, alerts timeline, sounding.
- `sky.html` — METAR Sky: the current observation painted as a scene.

**Atmosphere and performance**

- `airlab.html` — atmosphere column, pressure/density altitude, parcel
  stability, wind triangle.
- `pressure.html` — Pressure Systems: draggable highs and lows with the wind
  as the balance of pressure gradient, Coriolis and friction; 3-D view.
- `storm.html` — Thunderstorm Lab: a 2-D cloud model run live in the browser,
  warm bubble to anvil, mixed-phase microphysics, charging, lightning, thunder.
- `tunnel.html` — Wind Tunnel: lattice-Boltzmann flow around a reshapeable
  NACA airfoil, smoke, pressure, live lift and drag, stall.
- `aircraft.html` — Aircraft Compare: up to six aircraft side by side, every
  number from one registry, silhouettes drawn to scale from the table.

**Cockpit and procedures**

- `procedures.html` — Procedure Explorer: any US SID/STAR/IAP on a map with a
  3-D altitude view, leg table, FAA plate, plus a nationwide query view and a
  cycle-to-cycle diff.
- `notam.html` — NOTAM Hub: every active NOTAM in the country, archived hourly,
  counted, mapped, searchable, with a decoder.
- `sfra.html` — The DC SFRA from a KANP seat: rings, FRZ, gates, decision tree,
  ASRS report record.

**Study and reference**

- `knowledge.html` — expandable concept graph of the airplane knowledge
  domains.

**Reachable by URL, not linked from the hub**

- `power.html`, `eights.html`, `instruments.html` — power curve, eights on
  pylons, instrument errors.
- `sequencing.html` — why a GPS navigator sequences when it does.
- `alternates.html` — FAA alternate airport rules by part.
- `sky2.html`, `wxai.html`, `terps.html` — successors and drafts.
- `fireworks.html`, `glow.html`, `watercycle.html`, `slime.html`,
  `bubbles.html`, `fugue.html`, `mural.html`, `zoey.html` — toys and personal
  pages, self-contained.

**Radio** (need a backend on the LAN or the SDR box; no public fallback)

- `atc.html` — LiveATC clip viewer for the Potomac feeds. Recordings are never
  republished; LiveATC's terms forbid it.
- `ctaf.html` / `scanner.html` — KANP CTAF 122.9 clips and a remotely tunable
  SDR scanner, served from a separate machine over a private Tailscale funnel.

## Data pipelines

**Tracker.** A Raspberry Pi is the whole pipeline; the browser only reads.

- `pi/collector.py` polls the public ADS-B feeds (adsb.fi, then adsb.lol):
  60 nm every 3 s, plus the 5 nm pattern area every second. SQLite at
  `/var/lib/kanp/kanp.db`. `pi/heal.py` fills pattern gaps from adsb.lol's
  stored traces every 30 min.
- `pi/server.py` serves the API and the page on port 8787.
- `pi/exporter.py` pushes simplified per-day JSON to the `traffic-data`
  branch (one amended commit; `tracks/index.json` lists days). Tracks are
  Douglas-Peucker simplified except inside the 5 nm ring, where every fix is
  kept.
- The page tries the Pi first and falls back to the GitHub snapshots
  (`js/kanp-static.js`), which is what happens off the LAN. Snapshots are up
  to an hour stale.

Install and configuration: [`pi/README.md`](pi/README.md). Receiver wiring:
[`docs/receiver-setup.md`](docs/receiver-setup.md), whose hardware sections are
current and whose collector sections describe the retired Node collector.

**Weather archive.** `.github/workflows/wxarchive.yml` runs `scripts/wxarchive.py`
hourly and commits `data/wx/` on `main`: METARs for KDCA, KNAK and the local
ring of fields, TAFs, every LWX discussion, the NWS forecast and hourly grid,
alerts, GFS point data, PIREPs, AIRMETs/SIGMETs, TFRs, KIAD soundings, winds
aloft. One file per stream per day, never rewritten; METARs and TAFs the live
API dropped are healed from IEM. `data/wx/latest.json` is the current state of
every stream in one document, and `js/wx-archive.js` is the page-side reader.
`scripts/wxbackfill.py` fills history by hand.

**GFS grids.** `.github/workflows/wx3dsnap.yml` pulls wx3d's Open-Meteo grids
hourly to the `wx3d-data` branch, so page views don't hit the API.

**NOTAMs.** `.github/workflows/notamarchive.yml` runs `scripts/notamarchive.py`
hourly against the FAA NMS API and force-pushes the `notam-data` branch:
the whole system by state, a daily new/gone ledger, and aggregates.

## Generated data

Built by script, committed, never hand-edited.

| Output | Script | When |
|---|---|---|
| `data/procedures/` | `scripts/build_procedures.py` then `scripts/build_procedure_metrics.py` | each 28-day AIRAC cycle |
| `data/notam/locations.json` | `scripts/build_notam_locations.py` | each AIRAC cycle |
| `data/knowledge.json` | `scripts/build_knowledge.py` from `data/knowledge/*.md` | when the Markdown changes |
| `data/wx3d/terrain*.json` | `scripts/build_wx3d_terrain.py` | only to re-site |
| `data/sfra/asrs.json` | `scripts/build_sfra_reports.py` from ASRS CSV exports | by hand |
| `data/zoey.json` | `scripts/build_zoey.py` | when photos change |

## Development

No build step. Serve the directory with any static server:

```sh
python3 -m http.server
```

Site constants (airport, coordinates, runway geometry, nearby fields, TAF
stations, snapshot URLs) live in `js/site-config.js` as one `SITE` global;
`pi/site.env.example` is the Pi-side mirror. Edit those, not the consumers.

Assets are versioned by query string (`js/foo.js?v=N`). Change one, bump the
number everywhere it's referenced, or GitHub Pages keeps serving the cached
copy.

The site deploys itself on push to `main`. API keys never belong in this repo;
it's public.
