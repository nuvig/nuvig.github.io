# RTL-SDR receiver integration guide

How to plug your own ADS-B receiver into the KANP tracker when the hardware
arrives. The tracker page already has everything needed — you just point it
at your receiver in **Settings → Data source**.

## 0. No receiver yet? 24/7 collection via the airplanes.live API

You don't have to wait for hardware to get continuous history. The
airplanes.live API is a sufficient data source — the only thing GitHub's
throttled Actions can't provide is an always-on machine. Any computer that
stays on (old laptop, desktop, the Pi itself before the antenna is up) can
run the continuous collector:

```sh
# one-time: clone the data branch with a fine-grained PAT
#   (github.com/settings/personal-access-tokens → this repo → Contents: read/write)
git clone --branch traffic-data \
  "https://<PAT>@github.com/nuvig/nuvig.github.io.git" ~/traffic-data
cd ~/traffic-data && git config user.name kanp-collector && git config user.email kanp@localhost

# fetch the collector and run it
curl -sO https://raw.githubusercontent.com/nuvig/nuvig.github.io/main/scripts/api-collector.js
node api-collector.js ~/traffic-data --push
```

It polls every 20 s (well within airplanes.live's ≤1 req/s ask), merges
tracks into the same per-day files the History Explorer reads, snapshots
for the temporal heatmap every 30 min, and pushes hourly. To survive
reboots, run it under systemd — `/etc/systemd/system/kanp-collector.service`:

```ini
[Unit]
Description=KANP airspace collector (airplanes.live)
After=network-online.target
Wants=network-online.target

[Service]
User=YOUR_USER
ExecStart=/usr/bin/node /home/YOUR_USER/api-collector.js /home/YOUR_USER/traffic-data --push
Restart=always
RestartSec=30

[Install]
WantedBy=multi-user.target
```

Then `sudo systemctl enable --now kanp-collector`.

**Important — one publisher at a time:** the GitHub Action force-pushes the
`traffic-data` branch, which will clobber and conflict with the collector's
pushes. When the collector is running, disable the Action (repo → Actions →
"Collect KANP traffic" → ⋯ → Disable workflow); re-enable it as a fallback
if the collector goes offline. If the branch's commit history ever gets
bulky (the collector pushes ~24 commits/day), it's disposable — delete and
recreate the branch from the collector's current files.

Trade-off vs your own receiver: the API's coverage of the KANP area is
excellent but ultimately someone else's network, sampled at 20 s. The
RTL-SDR gives 1-second resolution, independence, and feeder perks — when it
arrives, sections 1–4 below replace this.

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

## 4. 24/7 history: feed the History Explorer from the receiver

This is the payoff. The tracker page has a **History Explorer** that replays
per-day track files (`tracks/YYYY-MM-DD.json` on the `traffic-data` branch)
with hour-of-day and altitude filtering. Until the receiver exists, those
files are filled by GitHub Action sampling bursts — a few 5-minute windows
per hour at best. The receiver replaces that with true 24/7 coverage at
1-second resolution.

`scripts/receiver-export.js` (no npm dependencies) converts a day of
readsb's globe history into the shared track format: filters to within
20 nm of KANP, downsamples to one point per 15 s, and rebuilds the index.

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
History Explorer's day list with far more tracks and points. (Note the
GitHub Action keeps running harmlessly alongside; it merges into different
runs of the same files. Once the receiver is proven, you can disable the
Action's burst sampling or keep it as a backfill for receiver downtime.)

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
