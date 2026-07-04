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

Data comes from the free [airplanes.live](https://airplanes.live) API.

- **Live view** (`js/kanp.js`): the page polls the API every 60 s while open
  and also stores those observations in `localStorage`.
- **Shared history**: a scheduled GitHub Action
  (`.github/workflows/collect-traffic.yml`) runs `scripts/collect-traffic.js`
  every 30 minutes, appends a compact snapshot to a rolling 30-day
  `traffic.json`, and force-pushes it as a single commit to the
  `traffic-data` branch. The page fetches that file from
  `raw.githubusercontent.com` and merges it with local observations, so
  visitors see real traffic patterns without needing to keep the page open.

## Development

No build step — plain HTML/CSS/JS. Open the files locally or serve the
directory with any static server:

```sh
python3 -m http.server
```
