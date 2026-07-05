# RTL-SDR receiver integration guide

How to plug your own ADS-B receiver into the KANP tracker when the hardware
arrives. The tracker page already has everything needed — you just point it
at your receiver in **Settings → Data source**.

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

## 4. Ideas once the receiver is running 24/7

The receiver is the natural place for heavy data collection — it sees every
position at 1-second resolution, far beyond what any polling API or GitHub
Action can capture:

- **readsb history**: enable `--write-globe-history` and readsb archives
  complete daily tracks on disk automatically. tar1090's `?pTracks` view
  can replay everything it heard in the last 24 h.
- **Nightly aggregate upload**: a cron job on the receiver can downsample
  the day's tracks (e.g. one point per 10 s, rounded coords) and push a
  `tracks.json` to this repo's `traffic-data` branch — the same pattern the
  GitHub Action uses for snapshots today, but with real track fidelity.
  That would let the public page render historical approach paths, filtered
  by the existing altitude controls.
- **Destination/route tagging**: ADS-B broadcasts don't include the
  destination airport. To filter "traffic landing at KANP" vs overflights,
  either classify behaviorally (descending below ~1,500 ft within ~3 nm of
  the field) or look up routes by callsign via the free
  [adsbdb](https://www.adsbdb.com/) API and cache results.
