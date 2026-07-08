# KANP tracker — Raspberry Pi backend

Collects aircraft positions around Lee Airport (KANP) 24/7 into a local
SQLite database and serves them as a filterable API for
[kanp.html](../kanp.html). Python 3 stdlib only — nothing to pip install.

## Install

```bash
git clone https://github.com/nuvig/nuvig.github.io.git
cd nuvig.github.io
sudo bash pi/install.sh
```

This creates a `kanp` system user, copies the code to `/opt/kanp`, and
starts two services:

| service | what it does |
|---|---|
| `kanp-collector` | polls airplanes.live every 3 s, writes `/var/lib/kanp/kanp.db` |
| `kanp-api` | serves the API **and the tracker page** on port 8787 |
| `kanp-export.timer` | hourly: publishes per-day snapshots to the `traffic-data` branch (needs one-time setup, below) |

Then open `http://<pi-ip>:8787/` — the tracker served from the Pi itself,
with the History Map and Traffic Study tabs talking to the local database.

To update later: `git pull && sudo bash pi/install.sh`.

## Configuration

Everything is an environment variable — uncomment/edit in the `.service`
files (`sudo systemctl edit kanp-collector` is the clean way), then
`sudo systemctl daemon-reload && sudo systemctl restart kanp-collector`.

| var | default | notes |
|---|---|---|
| `KANP_SOURCE` | `airplanes` | or a local receiver URL, e.g. `http://127.0.0.1/skyaware/data/aircraft.json` (dump1090-fa) or `http://127.0.0.1/tar1090/data/aircraft.json` |
| `KANP_POLL_SECONDS` | `3` | airplanes.live allows 1 req/s, so 1 is the floor. Raise to 15 to cut storage / be polite to the public feeds |
| `KANP_RADIUS_NM` | `60` | search radius around KANP |
| `KANP_RETENTION_DAYS` | `365` | positions older than this are pruned hourly |
| `KANP_MAX_DB_MB` | `8000` | hard cap; oldest 30-day chunks dropped if exceeded |
| `KANP_PORT` | `8787` | API/web port |

### Storage math (32 GB SD card)

A position row is ~90 bytes with indexes. At a 15 s poll with ~10–25
aircraft in range that's roughly **8–20 MB/day**, so a full year lands
around 3–7 GB — comfortably inside the 8 GB cap, which itself leaves
plenty of headroom on the card.

## Remote access (jesselevine.net, HTTPS)

The public page is HTTPS, so browsers block it from calling a plain-HTTP
Pi on your LAN (mixed content). Two ways in, both supported by the page:

**1. GitHub snapshots (built in — recommended).** `exporter.py` publishes
per-day JSON files to the repo's `traffic-data` branch every hour; the page
automatically falls back to them whenever the Pi API isn't reachable. Data is
up to an hour stale. Tracks are shape-simplified (Douglas-Peucker, tolerance
`KANP_SIMPLIFY_NM`, default 0.03 nm) — straight legs collapse to a few points
while turns stay crisp, so the snapshots render the same as the live API.
One-time setup:

1. Create a **fine-grained personal access token** at
   github.com → Settings → Developer settings → Fine-grained tokens:
   repository access = *only this repo*, permissions = **Contents:
   Read and write**. Copy the token.
2. On the Pi:
   ```bash
   sudo -u kanp git clone --branch traffic-data \
     https://<TOKEN>@github.com/nuvig/nuvig.github.io.git /var/lib/kanp/traffic-data
   sudo systemctl start kanp-export.service   # first run backfills all days
   journalctl -u kanp-export -n 20            # check it pushed
   ```
   The hourly timer takes it from there. The branch is kept at a single
   commit (amend + force-push) so the repo never bloats.

**2. Cloudflare Tunnel / Tailscale** for full live-database access from
anywhere: expose `localhost:8787` as an HTTPS URL and paste it into the
tracker's Data Source settings.

On the LAN, neither is needed — just use `http://<pi-ip>:8787/`.

## API quick reference

```
GET /api/status                      # heartbeat, row counts, DB size
GET /api/tracks?start=&end=&...      # per-aircraft tracks (decimated to max_points)
GET /api/stats?start=&end=&...       # hour×day grid, daily counts, altitude histogram, top aircraft
GET /api/aircraft?start=&end=&...    # distinct aircraft with counts
GET /api/export.csv?start=&end=&...  # raw filtered rows as CSV
```

Common filters on all of the above: `start`/`end` (unix seconds, default
last 24 h), `min_alt`/`max_alt` (ft), `ground=include|exclude|only`,
`callsign` (matches callsign or registration), `hex`, `category` (A1,A2,…),
`military=1`, `min_dist`/`max_dist` (nm), `hours` (e.g. `7-19`), `dow`
(0=Mon…6=Sun, e.g. `5,6` for weekends). Hours/days use the Pi's local
timezone — make sure it's set: `sudo timedatectl set-timezone America/New_York`.

Example — weekend pattern-altitude traffic in June, as CSV:

```
http://pi:8787/api/export.csv?start=1780286400&end=1782878400&max_alt=2000&ground=exclude&dow=5,6
```
