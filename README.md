# jesselevine.net

Personal site for Jesse Levine — flight instructor (CFI/CFII/MEI) in
Annapolis, MD. Hosted on GitHub Pages.

## Pages

- **`index.html`** — landing page: flight-training services and contact.
  Includes a small ball-physics toy (`js/sim.js`) behind the ▶ button.
- **`kanp.html`** — live flight tracker for Lee Airport (KANP): a Leaflet map
  showing current ADS-B traffic within 60 nm, a geographic heatmap of where
  traffic accumulates, and an hour-of-day × day-of-week activity heatmap.

## KANP tracker architecture

- **Live view** (`js/kanp.js`): polls a data source every 5–60 s (depending
  on source) while the page is open, draws aircraft and altitude-colored
  trails, and stores observations in `localStorage`. The altitude band
  filter applies to trails, live aircraft, and the geographic heatmap.
- **Data sources** (selectable in Settings, persisted in the browser):
  [airplanes.live](https://airplanes.live) (default, no key), a local
  readsb/tar1090 receiver or any custom `aircraft.json` URL, or ADS-B
  Exchange via RapidAPI (key stored only in the browser — never commit API
  keys to this public repo). See `docs/receiver-setup.md` for wiring up an
  RTL-SDR receiver.
- **24/7 collection**: `scripts/api-collector.js` runs continuously on a
  Raspberry Pi, polling the airplanes.live API once per second for all
  traffic within 60 nm of KANP (radius/intervals env-tunable). It stores
  one fix per aircraft per 5 s into per-day track files plus temporal
  heatmap snapshots, and pushes the `traffic-data` branch hourly. It can
  alternatively poll a local dump1090-fa/readsb receiver via `--url`.
  Setup: `docs/receiver-setup.md`. (An earlier scheduled GitHub Action
  that burst-sampled the same files has been removed — the Pi is the sole
  publisher.)
- **History Explorer**: the page lists available track days
  (`tracks/index.json` on the `traffic-data` branch) and replays any day's
  tracks on the map with hour-of-day and altitude filtering — the
  airspace-study tool. Tracks render on a canvas layer with low-altitude
  segments emphasized; very large days are decimated at render time, and
  trails split at sampling gaps so intermittent data doesn't draw false
  straight lines.

## Development

No build step — plain HTML/CSS/JS. Open the files locally or serve the
directory with any static server:

```sh
python3 -m http.server
```
