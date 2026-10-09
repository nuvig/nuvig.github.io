# Backends: Pi, PC, legacy collector

Moved verbatim from CLAUDE.md. Sibling docs are in `docs/`; "above"/"below" references to other areas point there. Index: CLAUDE.md → Docs.

### Backends

- `pi/` — Raspberry Pi backend, Python 3 **stdlib only** (`collector.py`, `server.py`, `exporter.py`,
  `trackutil.py`, `gitutil.py`, `atc.py`, `install.sh`, systemd units).
  The collector tries the public feeds in order (adsb.lol → adsb.fi → airplanes.live) and
  **treats an empty-but-200 response as a degraded feed, not empty sky** — it moves on to the next
  feed and warns on a sustained all-feeds-empty run. Don't "simplify" that away: on 2026-08-01
  adsb.lol served empty 200s for 11 h and the then-first-well-formed-wins logic silently lost the
  data. **Two polls, one request budget** (2026-09-01): the 60 nm poll every 3 s plus a 5 nm
  poll of the pattern area every second in between (`KANP_NEAR_RADIUS_NM` /
  `KANP_NEAR_POLL_SECONDS`) — 2 near + 1 wide per 3 s is the feeds' 1 req/s, and the near
  answer is a handful of aircraft. An empty near poll is a quiet pattern, never "degraded".
  **Fixes are stamped `now − seen_pos`** (the feed's position age), not the poll time, so both
  polls give the same fix the same row and pattern turns aren't smeared by up to a poll
  interval; anything over 5 min old is skipped as stale. Health meta keys describe the wide
  poll only. **Collector I/O rebuilt 2026-09-05** after the History tab showed pattern laps as
  straight chords: the day files held 979 collector-wide stalls of 8–100 s (25 % of the day,
  51 % on 08-29) while adsb.lol's own trace of the same aircraft was complete — polls were
  answering (zero "fetch failed" in the journal, adsb.lol at 0.4–0.6 s with a 429 on the 20th
  request while the collector also polled) yet nothing stored, and the collector logged only
  when all three feeds failed at once, so the journal was blind. Now: every poll is counted
  (`Stats` — per feed ok/429/err/empty and max latency, rows stored, zero-row polls, DNS
  lookup time), summarised once a minute as a `poll stats` journal line and `meta.poll_stats`;
  a **stall warning** fires when feeds answer but nothing new stores for 15 s; the **near poll
  runs on its own thread** with its own DB connection (`near_loop`, paused while a wide fetch
  is in flight so the request budget stays ~1 req/s; `store()` takes `STORE_LOCK`); feeds are
  `Feed` objects with **persistent connections** (a fresh TLS handshake cost ~0.6 s per poll on
  the Pi, most of the near poll's budget; a server-closed keep-alive reconnects once, timeouts
  never retry) and a **429 cooldown** (`KANP_FEED_COOLDOWN_S`, 3 s); **timeouts are 3 s near /
  10 s wide** (`KANP_NEAR_TIMEOUT_S` / `KANP_WIDE_TIMEOUT_S`; the old 20 s let one slow feed
  stall every poll); **DNS is cached** ten minutes via a `socket.getaddrinfo` wrapper (a socket
  timeout never covered the lookup) and slow lookups are counted; feed URL templates come from
  `KANP_FEEDS`; both loops catch everything and log a traceback rather than crash-looping under
  systemd's `Restart=always`. Tested against a three-feed stub (fast keep-alive · 429-every-3rd
  that closes connections · 6 s sleeper). **The first deploy's `poll stats` line named the cause**
  (16:31 local, 63 s): adsb.lol answered 429 to 15 of the 27 requests it got, so 28 of 33 near
  polls fell through to adsb.fi, and 11 of those stored nothing new — adsb.fi's positions for the
  ring weren't fresh, while adsb.lol's own trace of the same laps was complete. The second deploy
  (near on adsb.lol first) then showed the real numbers: **adsb.lol accepts ~5 requests a minute
  at steady state** (5–6 ok per minute every minute, old build or new; the 19-of-20 curl burst
  rode a stored allowance), **airplanes.live's point endpoint 404s on every call** (0 of 98) and
  each attempt cost the near poll a round trip (54 → 28 polls/min), and **adsb.fi is the only
  feed answering at 1 Hz, stale in the ring a quarter to a third of the time** (near zero-row
  21/54, 13/32, 7/28) — that is the ceiling for live collection at Lee. So both polls run
  adsb.fi → adsb.lol (`KANP_FEEDS_NEAR` / `KANP_FEEDS_WIDE`, per-poll lists kept so they can
  diverge again), airplanes.live is out, and the fix for complete patterns is **`pi/heal.py`
  (`kanp-heal.timer`, every 30 min)**: for every hex with a fix inside the pattern box (3 nm /
  1,800 ft, `KANP_HEAL_BOX_*`) in the last 30 h it fetches adsb.lol's stored readsb trace —
  `adsb.lol/data/traces/<last2>/trace_full_<hex>.json` for the current UTC day,
  `adsb.lol/globe_history/YYYY/MM/DD/traces/<last2>/…` for completed days (both confirmed 200 from
  the Pi 2026-09-05; gzip) — drops stale-flagged points (flags bit 1) and anything outside 60 nm,
  and inserts what has no fix of ours within 1 s, `src='lol'` (column added by the heal on first
  run; the collector's rows are NULL). One request per 12 s, 40 per run, a completed day fetched
  once per hex and UTC day the hex was in the box — never every day in the window, which made a month's backfill thousands of 404s (`meta heal:<hex>:<yyyymmdd>`, 404 remembered too), today's refetched after 25 min. Every DB write is one `BEGIN IMMEDIATE` per item with retries (`write_item()`): the collector's two threads commit several times a second and SQLite's busy wait polls rather than queues, so a third writer starved for its whole 30 s timeout and the run died on `database is locked` (2026-09-05 20:58). adsb.lol holds traces from 2026-08-10 on and nothing for 2025-10-11..2026-08-09, so that is the useful backfill floor.
  The exporter's next run carries healed rows into the day files (it re-exports today and
  yesterday, so the 30 h window matches). **Only today and yesterday**, so a backfill further back is invisible on the site until one exporter run with `KANP_EXPORT_SINCE=YYYY-MM-DD` (2026-09-05) re-exports every day from that date. `--selftest` runs offline fixture checks. Healed fixes
  are not distinguished on the site yet. A feed's 429
  cooldown doubles per repeat (3 → 20 s, `KANP_FEED_COOLDOWN_MAX_S`) and resets on a success. The
  near thread yields only the tick on which a wide poll *starts* (`WIDE_STARTED_AT`,
  `NEAR_YIELD_S`), never waits for it — pausing for the whole fetch starved it to 1 poll in 66 s on
  the stub's 4 s wide poll. Watch `zero-row` in the near stats: it is the number of polls whose
  feed returned aircraft with no new position, i.e. the staleness of whatever feed is answering. **The exporter must call `gitutil.maintain()` after pushing** — the amend + force-push pattern
  orphans the previous commit's blobs locally every run, and without pruning `.git` grows without
  bound (it hit 5.7 GB against 301 MB of data on the real Pi). Weather archiving used to live
  here (`wxarchive.py`) but moved to the wxarchive GitHub Action so the Pi stores no weather
  history; `install.sh` retires the old `kanp-wxarchive` units.
  **Disk (2026-09-12 incident):** the Pi's root is 27 GB shared with the OS, not a dedicated
  card. `KANP_RETENTION_DAYS` defaulted to 365 and `KANP_MAX_DB_MB` to 8000 measured on the
  main file only, so nothing ever pruned: `kanp.db` reached 7.5 GB, root filled, SQLite could
  no longer checkpoint (WAL grew to 3.9 GB, then 6.6 GB with `kanp-api`'s readers pinning
  it), `git push` failed and the site went stale for a day. Now: **retention 45 days, cap
  6000 MB on live pages + WAL** (`db_live_mb()`; `auto_vacuum` never took on the live DB, so
  the file only ever grows to its high-water mark and freed pages are reused, which is why
  the cap must not read the file size), deletes in 100k-row batches with a TRUNCATE
  checkpoint after. **ATC clips live on a USB stick** (`LABEL=kanp-atc`, ext4, mounted **at
  `/var/lib/kanp/atc`** — the recorder's default dir, so the hardened unit needs no change;
  a `/mnt/atc` + `ReadWritePaths` drop-in was tried first and the recorder still could not
  write; `nofail` in fstab; ~186 MB/day for three feeds, 45-day retention ≈ 8.4 GB).
  **`pi/recover.sh`** is the one-line repair for a stale-snapshot day (`curl … | sudo bash`,
  URL in its header): sets retention, mounts the stick and repoints the recorder, restarts
  the units, runs an export (re-cloning the traffic-data checkout if the push fails — a push
  that died on a full disk leaves it unusable), then verifies from GitHub and the DB and
  prints ALL GOOD or NOT FIXED with the reason. Never delete `kanp.db-wal` to free space —
  it holds committed rows; checkpoint it (`PRAGMA wal_checkpoint(TRUNCATE)`) with every
  reader and writer stopped, including `kanp-api`. **And the WAL grows on its own even with
  space** — the DB always has readers (the API, the exporter's minutes-long reads), so it never
  gets the reader-free moment a reset needs: ~5 GB a day on 2026-09-13, freed only by the
  service restart in `install.sh`. `prune()` now TRUNCATE-checkpoints every hourly pass with a
  2 s busy wait (it holds the write lock while waiting) and `journal_size_limit` is 256 MB.
  **Two watchers** so it is noticed next time:
  the **Tracker watch** step at the end of `wxarchive.yml` (rides the existing hourly run so
  it costs no extra Actions runs — Jesse didn't want a workflow of its own; fails — and so
  emails — when the push or the last stored fix is over 3 h old or `disk_free_mb` < 2000) and a `Pi disk` row in
  changelog.html's tracker panel; both read `summary.json`, which the exporter now stamps
  with `disk_free_mb` and `db_mb` (main file + WAL). Until the new exporter is installed on
  the Pi the row says `not reported`. `KANP_MAX_DB_MB` is 20000 in the live `site.env` (the
  pre-ec459e63 collector still installed measures the file, which sat at 8050 MB, and its
  emergency loop wiped every row hourly on 2026-09-12 evening — the Pi's raw history is gone
  back to that night; GitHub has all days) — drop it back to the default after `install.sh`.
- `pc/` — `atc_transcribe.py` (faster-whisper worker) + `atc_vocab.txt`. Runs on the PC, not the Pi.
- `scripts/api-collector.js`, `scripts/receiver-export.js` — legacy Node collector, superseded by
  `pi/`; don't extend it.
- `docs/receiver-setup.md` — RTL-SDR receiver wiring. **Its collector sections (0, 0.5, 4) still
  describe the legacy Node collector as "the setup in use" and are stale**; the receiver-hardware
  sections (1–3) are current. `pi/README.md` is the authority on the backend.

