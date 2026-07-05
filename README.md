# jesselevine.net

Personal site for Jesse Levine — flight instructor (CFI/CFII/MEI) in
Annapolis, MD. Hosted on GitHub Pages.

## Pages

- **`index.html`** — landing page: flight-training services and contact.
  Includes a small ball-physics toy (`js/sim.js`) behind the ▶ button.
- **`kanp.html`** — live flight tracker for Lee Airport (KANP): a Leaflet map
  showing current ADS-B traffic within 20 nm, a geographic heatmap of where
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
- **Shared history**: a scheduled GitHub Action
  (`.github/workflows/collect-traffic.yml`) runs `scripts/collect-traffic.js`
  to append compact `[lat, lon, alt]` snapshots to a rolling 30-day
  `traffic.json`, force-pushed as a single commit to the `traffic-data`
  branch. The page fetches that file from `raw.githubusercontent.com` and
  merges it with local observations, so visitors see traffic patterns
  without keeping the page open. Note: GitHub schedules are best-effort —
  in practice runs land every ~2–3 h, not the requested 30 min.

## Development

No build step — plain HTML/CSS/JS. Open the files locally or serve the
directory with any static server:

```sh
python3 -m http.server
```
