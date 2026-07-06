# RTL-SDR receiver integration guide

How to plug your own ADS-B receiver into the KANP tracker when the hardware
arrives. The tracker page already has everything needed — you just point it
at your receiver in **Settings → Data source**.

## 0. The collector: 24/7 collection on the Pi (this is the setup in use)

The Pi runs `scripts/api-collector.js` around the clock. It polls the
airplanes.live API for all traffic within **60 nm of KANP**, builds per-day
track files, and pushes them to this repo's `traffic-data` branch, where
the tracker page's History Explorer reads them. (The old scheduled GitHub
Action that sampled in bursts has been removed — the Pi is the sole
publisher, so there is nothing to conflict with.)

**One-time setup, start to finish:**

```sh
# 0. Node.js if missing:  sudo apt install -y nodejs

# 1. A key so the Pi may write to GitHub: create a fine-grained PAT at
#    github.com/settings/personal-access-tokens — repository access:
#    only nuvig/nuvig.github.io, permission "Contents: read and write".

# 2. Clone the data branch using that key (paste it in place of <PAT>)
git clone --branch traffic-data \
  "https://<PAT>@github.com/nuvig/nuvig.github.io.git" ~/traffic-data
cd ~/traffic-data && git config user.name kanp-collector && git config user.email kanp@localhost

# 3. Fetch the collector and test-run it (Ctrl-C to stop)
cd ~ && curl -sO https://raw.githubusercontent.com/nuvig/nuvig.github.io/main/scripts/api-collector.js
KANP_POLL_S=1 node api-collector.js ~/traffic-data --push
```

You should see a status line every few minutes and a `pushed` line within
the hour. Then make it permanent with systemd —
`/etc/systemd/system/kanp-collector.service` (replace `pi` with your
username if different):

```ini
[Unit]
Description=KANP airspace collector (airplanes.live, 60 nm)
After=network-online.target
Wants=network-online.target

[Service]
User=pi
Environment=KANP_POLL_S=1
ExecStart=/usr/bin/node /home/pi/api-collector.js /home/pi/traffic-data --push
Restart=always
RestartSec=30

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl enable --now kanp-collector
journalctl -u kanp-collector -f     # watch it work
```

**How the numbers fit together:** `KANP_POLL_S=1` polls once per second —
the maximum airplanes.live allows. Storage is bounded separately by
`KANP_KEEP_S` (default 5): at most one stored fix per aircraft per 5 s.
That's deliberate — 60 nm around KANP includes BWI/DCA traffic, and
storing every 1-second fix would make day files too large for the web page
to load, while 5 s spacing is visually indistinguishable at map scale.
If you want denser storage anyway, add `Environment=KANP_KEEP_S=1` and
expect day files in the tens of MB. Radius is `KANP_RADIUS_NM` (default 60).

Housekeeping: the collector pushes ~24 commits/day to `traffic-data`. That
branch is disposable — if it ever feels bulky, delete and recreate it from
the collector's current files.

## 0.5 Alternative: collect from your own antenna (dump1090-fa)

The same collector can read your receiver directly instead of the API —
pass `--url` with the local `aircraft.json`:

```sh
node api-collector.js ~/traffic-data --push \
  --url http://localhost/skyaware/data/aircraft.json
```

Notes:
- **Data URL**: modern dump1090-fa serves `/skyaware/data/aircraft.json`;
  older installs use `/dump1090-fa/data/aircraft.json`. Verify with
  `curl -s http://localhost/skyaware/data/aircraft.json | head`.
- Positions with `seen_pos` older than 15 s are skipped, and everything
  beyond `KANP_RADIUS_NM` is filtered out.
- This coexists happily with piaware/FlightAware feeding — it's just
  another reader of dump1090-fa's JSON output.
- Trade-off vs the API: your antenna is independent and fast, but a single
  receiver's low-altitude coverage at 40–60 nm is limited by terrain and
  the radio horizon — the API (thousands of pooled receivers) sees more of
  the far-out, low traffic. For a 60 nm study area the API is usually the
  more complete source; your antenna wins inside its solid coverage.
- Section 4's nightly `receiver-export.js` path is **readsb-only**
  (dump1090-fa doesn't write a globe-history archive).

## 1. Set up the receiver

The standard stack (works on a Raspberry Pi or any small Linux box):

- **readsb** — decodes ADS-B from the RTL-SDR dongle
- **tar1090** — local map UI + serves `aircraft.json` over HTTP

Easiest install is the [adsb.im image](https://adsb.im/home) (flash and go)
or the [wiedehopf install scripts](https://github.com/wiedehopf/adsb-scripts/wiki):

```sh
sudo bash -c "$(curl -sSL https://github.com/wiedehopf/adsb-scripts/raw/master/readsb-install.sh)"
sudo bash -c "$(curl -sSL https://github.com/wiedehopf/tar1090/raw/master/install.sh)"
```

After install, verify the JSON feed works from another machine on your LAN:

```sh
curl http://<receiver-ip>/tar1090/data/aircraft.json | head
```

You should see `{ "now": ..., "aircraft": [ ... ] }` — that's the exact
format the tracker page understands (same schema family as airplanes.live
and ADS-B Exchange; they all derive from readsb).

## 2. Feed the aggregators (recommended)

Feeding your data to aggregators is free, helps coverage, and is what earns
you **ADS-B Exchange API access** as a feeder perk. The adsb.im image and
wiedehopf scripts both have one-command feed setup for ADS-B Exchange,
airplanes.live, adsb.lol, etc.

## 3. Point the tracker at your receiver

On the [tracker page](https://jesselevine.net/kanp.html):
**Settings → Data source → "Local receiver / custom URL"**, then enter:

```
http://<receiver-ip>/tar1090/data/aircraft.json
```

The page polls it every 5 seconds (vs 15 s for airplanes.live), so trails
get noticeably smoother. Settings stay in your browser's localStorage —
nothing is committed to the repo.

### The mixed-content gotcha

`https://jesselevine.net` cannot fetch from a plain-`http://` LAN address —
browsers block https→http requests ("mixed content"). Three ways around it,
simplest first:

1. **Open the page over http on your LAN**: clone this repo on the receiver
   (or any machine) and serve it locally — `python3 -m http.server` — then
   browse `http://<ip>:8000/kanp.html`. http→http is allowed.
2. **Use tar1090's own map** for casual local viewing (it's excellent), and
   the public tracker page for the shared/heatmap view.
3. **Cloudflare Tunnel** (free): gives your receiver a real
   `https://receiver.yourdomain.com` URL that works from anywhere, including
   from the public tracker page. This is the best long-term option — you
   get remote access to your receiver, and the public page can use it as a
   data source from any network.

### ADS-B Exchange API mode

The Settings panel also supports ADS-B Exchange via RapidAPI: paste your
key and it's stored **only in your browser's localStorage**. Never commit
an API key to this (public) repository — anyone could read and abuse it.
Note the page polls ADSBx at 60 s intervals because RapidAPI plans have
monthly request quotas. If your feeder perk gives you a direct re-api URL
instead, use "Local receiver / custom URL" mode with that full URL.

## 4. 24/7 history from readsb's globe-history archive (readsb only)

> **dump1090-fa users:** skip this section — dump1090-fa doesn't write the
> globe-history archive this relies on. Use the continuous collector with
> `--url` (section 0.5) instead.

This is the payoff. The tracker page has a **History Explorer** that replays
per-day track files (`tracks/YYYY-MM-DD.json` on the `traffic-data` branch)
with hour-of-day and altitude filtering. This path only applies if you run
readsb instead of dump1090-fa; it exports readsb's on-disk archive at
1-second source resolution instead of polling.

`scripts/receiver-export.js` (no npm dependencies) converts a day of
readsb's globe history into the shared track format: filters to within
60 nm of KANP, downsamples to one point per 15 s, and rebuilds the index.

**One-time setup on the receiver:**

1. Make sure readsb runs with `--write-globe-history=/var/globe_history`
   (wiedehopf installs enable this for tar1090's replay feature).
2. Create a [fine-grained GitHub PAT](https://github.com/settings/personal-access-tokens)
   scoped to this repo with *Contents: read and write*.
3. Clone the data branch and this repo's scripts once:

   ```sh
   git clone --branch traffic-data https://<PAT>@github.com/nuvig/nuvig.github.io.git ~/traffic-data
   curl -sO https://raw.githubusercontent.com/nuvig/nuvig.github.io/main/scripts/receiver-export.js
   ```

4. Nightly cron (runs at 00:25 UTC, exports yesterday, pushes):

   ```cron
   25 0 * * * cd ~ && node receiver-export.js /var/globe_history ~/traffic-data \
     && cd ~/traffic-data && git add -A && git commit -m "Receiver export" && git push
   ```

The page needs no changes — receiver-exported days simply appear in the
History Explorer's day list. Don't run this and the continuous collector's
push on the same branch clone at the same time; pick one publisher.

## 5. Later ideas

- **Destination/route tagging**: ADS-B broadcasts don't include the
  destination airport. To filter "traffic landing at KANP" vs overflights,
  either classify behaviorally (descending below ~1,500 ft within ~3 nm of
  the field) or look up routes by callsign via the free
  [adsbdb](https://www.adsbdb.com/) API and cache results.
- **Multi-day aggregation**: composite heatmaps of approach corridors from
  weeks of receiver data, split weekday/weekend or by wind direction.
- If data volume ever outgrows a git branch (~30 days × ~1 MB/day is fine),
  the natural next step is Cloudflare R2/Pages for the data files — the
  page's fetch URLs are the only thing that would change.
