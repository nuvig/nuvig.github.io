---
name: verify
description: How to run and verify the KANP tracker (kanp.html live tab, pi/ collector+server, scripts/api-collector.js) without real hardware or hitting public ADS-B APIs.
---

# Verifying the KANP tracker

No build step — static HTML/JS plus two collectors (Node + Python).

## Handle

Run a stub server that serves the repo root over http **and** fakes the
Pi API + a local receiver (poll cadence is observable via a hit log):

- `GET /api/tracks` → `{tracks:[{hex,flight,reg,type,military,points:[[ts,lat,lon,alt,gs,ground],…]}]}`
  (same shape as `pi/server.py`; `ts` in epoch seconds, newest ≈ now)
- `GET /aircraft.json` → `{aircraft:[{hex,flight,lat,lon,alt_baro,gs,seen_pos:0.1}]}`
  (dump1090/tar1090 shape for both collectors' `--url` / `KANP_SOURCE` modes)
- log every request `{ts,path}` and expose it at `GET /__hits`

Serve on `127.0.0.1:<port>`: `KANP.apiBase()` auto-uses same-origin when the
page is opened over `http:` with a port, so `http://127.0.0.1:8080/kanp.html`
talks to the stub's `/api/tracks` with no localStorage setup.

## Drive

- **Page**: Playwright (`NODE_PATH=/opt/node22/lib/node_modules`, global
  install; `executablePath: '/opt/pw-browsers/chromium'`). Click
  `button[data-tab="tab-live"]` — History Map is the default tab. Read
  `#status-text` ("Live · via Pi"), `#ac-num`, `#update-time`; poll cadence
  = gaps between `/api/tracks` hits in `/__hits`. Snapshot-fallback mode:
  `localStorage.setItem('kanp_api_base','none')` + reload (page then fetches
  `raw.githubusercontent.com/...` — reachable here via the proxy).
- **Node collector**: `timeout 6 node scripts/api-collector.js <tmpdir> --url
  http://127.0.0.1:8080/aircraft.json` — cadence from `/__hits`; SIGTERM
  flushes `<tmpdir>/tracks/YYYY-MM-DD.json`.
- **Pi collector**: `KANP_SOURCE=http://127.0.0.1:8080/aircraft.json
  KANP_DB=<tmp>/kanp.db timeout 6 python3 pi/collector.py` — startup log line
  states the poll interval; rows land in table `positions`.

## Gotchas

- Don't poll the real public feeds (airplanes.live/adsb.lol) in tests.
- Session history is throttled: `kanp_obs` in localStorage should gain at
  most ~1 entry/min regardless of poll rate.
- `/__hits` accumulates across phases — filter by timestamp captured before
  each phase.
