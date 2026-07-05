// Continuous 24/7 airspace collector using the airplanes.live API.
//
// Runs on any always-on machine (old laptop, desktop, Raspberry Pi) — no
// RTL-SDR hardware required. Polls the free airplanes.live point API and
// writes the same per-day track files the History Explorer reads, so it's a
// drop-in upgrade over the GitHub Action's sampling bursts. When an RTL-SDR
// receiver is available, scripts/receiver-export.js replaces this with
// full-fidelity local data — same format, same page.
//
// Usage:
//   node api-collector.js <data-dir> [--push]
//
//   <data-dir>  where traffic.json and tracks/ live. To publish, make it a
//               clone of the repo's traffic-data branch and pass --push:
//               git clone --branch traffic-data \
//                 https://<PAT>@github.com/nuvig/nuvig.github.io.git traffic-data
//   --push      git commit + push <data-dir> after each hourly flush
//
// Intervals (env-overridable, seconds):
//   KANP_POLL_S=20    API poll (airplanes.live asks ≤1 req/s; 20 s is polite)
//   KANP_FLUSH_S=300  write track files to disk
//   KANP_SNAP_S=1800  append a snapshot to traffic.json (temporal heatmap)
//   KANP_PUSH_S=3600  git push cadence when --push is set
//
// No npm dependencies. Run under systemd/pm2 for restarts — see
// docs/receiver-setup.md for a unit file.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const KANP_LAT   = 38.9422;
const KANP_LON   = -76.5684;
const SEARCH_NM  = 20;
const SNAP_MAX_AGE_MS = 30 * 86_400_000;
const TRACK_KEEP_DAYS = 30;
const MIN_MOVE_NM = 0.02;

const POLL_S  = envNum('KANP_POLL_S', 20);
const FLUSH_S = envNum('KANP_FLUSH_S', 300);
const SNAP_S  = envNum('KANP_SNAP_S', 1800);
const PUSH_S  = envNum('KANP_PUSH_S', 3600);

const args = process.argv.slice(2);
const doPush = args.includes('--push');
const dataDir = args.find(a => !a.startsWith('--'));
if (!dataDir) {
  console.error('usage: node api-collector.js <data-dir> [--push]');
  process.exit(1);
}
const tracksDir = path.join(dataDir, 'tracks');
fs.mkdirSync(tracksDir, { recursive: true });

function envNum(name, fallback) {
  const v = Number(process.env[name]);
  return v > 0 ? v : fallback;
}

// ---------------------------------------------------------------------------

function normAlt(v) {
  if (v === 'ground') return 0;
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null;
}

function distNm(lat1, lon1, lat2, lon2) {
  const R = 3440.065;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) ?? fallback; }
  catch { return fallback; }
}

function utcDateStr(ts) { return new Date(ts).toISOString().slice(0, 10); }
function utcMidnight(ts) {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Collection state
// ---------------------------------------------------------------------------
// Points gathered since the last flush: hex -> { cs, pts: [{ts,lat,lon,alt}] }
let pending = new Map();
// Last kept point per aircraft (survives flushes, for stationary dedupe)
const lastPoint = new Map(); // hex -> {ts, lat, lon, alt}
let lastPollAc = null;
let pollCount = 0, pollFailures = 0;

async function pollOnce() {
  const url = `https://api.airplanes.live/v2/point/${KANP_LAT}/${KANP_LON}/${SEARCH_NM}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'kanp-tracker (jesselevine.net)' } });
  if (!res.ok) throw new Error(`API ${res.status}`);
  const data = await res.json();
  return (data.ac || [])
    .filter(a => typeof a.lat === 'number' && typeof a.lon === 'number')
    .map(a => ({
      hex: a.hex || '',
      cs:  (a.flight || '').trim(),
      lat: Number(a.lat.toFixed(4)),
      lon: Number(a.lon.toFixed(4)),
      alt: normAlt(a.alt_baro),
    }));
}

function recordPoll(ac) {
  const now = Date.now();
  lastPollAc = ac;
  for (const a of ac) {
    if (!a.hex) continue;
    const last = lastPoint.get(a.hex);
    if (last && distNm(last.lat, last.lon, a.lat, a.lon) < MIN_MOVE_NM && last.alt === a.alt) continue;

    let t = pending.get(a.hex);
    if (!t) { t = { cs: a.cs, pts: [] }; pending.set(a.hex, t); }
    if (!t.cs && a.cs) t.cs = a.cs;
    const p = { ts: now, lat: a.lat, lon: a.lon, alt: a.alt };
    t.pts.push(p);
    lastPoint.set(a.hex, p);
  }
  // Forget aircraft not seen for an hour
  for (const [hex, p] of lastPoint) {
    if (now - p.ts > 3_600_000) lastPoint.delete(hex);
  }
}

// ---------------------------------------------------------------------------
// Persistence (same file formats as collect-airspace.js)
// ---------------------------------------------------------------------------
function flushTracks() {
  if (!pending.size) return;
  const batch = pending;
  pending = new Map();

  // day -> hex -> { cs, pts: [[sec,lat,lon,alt]] }
  const byDay = new Map();
  for (const [hex, t] of batch) {
    for (const p of t.pts) {
      const day = utcDateStr(p.ts);
      const sec = Math.round((p.ts - utcMidnight(p.ts)) / 1000);
      let dayMap = byDay.get(day);
      if (!dayMap) { dayMap = new Map(); byDay.set(day, dayMap); }
      let dt = dayMap.get(hex);
      if (!dt) { dt = { cs: t.cs, pts: [] }; dayMap.set(hex, dt); }
      dt.pts.push([sec, p.lat, p.lon, p.alt]);
    }
  }

  for (const [day, dayMap] of byDay) {
    const file = path.join(tracksDir, `${day}.json`);
    const existing = readJson(file, { date: day, tracks: [] });
    const merged = new Map(existing.tracks.map(t => [t.hex, t]));
    for (const [hex, dt] of dayMap) {
      const cur = merged.get(hex) || { hex, cs: dt.cs, pts: [] };
      if (!cur.cs && dt.cs) cur.cs = dt.cs;
      cur.pts = cur.pts.concat(dt.pts)
        .sort((a, b) => a[0] - b[0])
        .filter((p, i, arr) => i === 0 || p[0] !== arr[i - 1][0]);
      merged.set(hex, cur);
    }
    fs.writeFileSync(file, JSON.stringify({ date: day, tracks: [...merged.values()] }));
  }

  rebuildIndex();
}

function rebuildIndex() {
  const cutoff = utcDateStr(Date.now() - TRACK_KEEP_DAYS * 86_400_000);
  const index = [];
  for (const f of fs.readdirSync(tracksDir).sort()) {
    const m = f.match(/^(\d{4}-\d{2}-\d{2})\.json$/);
    if (!m) continue;
    if (m[1] < cutoff) { fs.unlinkSync(path.join(tracksDir, f)); continue; }
    const day = readJson(path.join(tracksDir, f), null);
    if (!day) continue;
    index.push({
      date: m[1],
      tracks: day.tracks.length,
      points: day.tracks.reduce((n, t) => n + t.pts.length, 0),
    });
  }
  fs.writeFileSync(path.join(tracksDir, 'index.json'), JSON.stringify(index));
}

function writeSnapshot() {
  if (!lastPollAc) return;
  const now = Date.now();
  const file = path.join(dataDir, 'traffic.json');
  const snaps = readJson(file, []);
  snaps.push({ ts: now, ac: lastPollAc.map(a => [a.lat, a.lon, a.alt]) });
  fs.writeFileSync(file, JSON.stringify(snaps.filter(o => o.ts > now - SNAP_MAX_AGE_MS)));
}

function gitPush() {
  try {
    execSync('git add -A', { cwd: dataDir, stdio: 'pipe' });
    const status = execSync('git status --porcelain', { cwd: dataDir, stdio: 'pipe' }).toString();
    if (!status.trim()) return;
    execSync('git commit -m "Update KANP airspace data (api-collector)"', { cwd: dataDir, stdio: 'pipe' });
    execSync('git push', { cwd: dataDir, stdio: 'pipe' });
    console.log(`[${new Date().toISOString()}] pushed`);
  } catch (err) {
    console.warn(`push failed (will retry next cycle): ${err.message.split('\n')[0]}`);
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
async function main() {
  console.log(`Collecting airplanes.live traffic within ${SEARCH_NM} nm of KANP into ${dataDir}`);
  console.log(`poll ${POLL_S}s · flush ${FLUSH_S}s · snapshot ${SNAP_S}s · push ${doPush ? PUSH_S + 's' : 'off'}`);

  let lastFlush = Date.now(), lastSnap = 0, lastPush = Date.now();

  const shutdown = () => {
    console.log('shutting down — flushing…');
    flushTracks();
    if (doPush) gitPush();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  while (true) {
    try {
      recordPoll(await pollOnce());
      pollCount++;
    } catch (err) {
      pollFailures++;
      console.warn(`poll failed: ${err.message}`);
    }

    const now = Date.now();
    if (now - lastSnap >= SNAP_S * 1000) { writeSnapshot(); lastSnap = now; }
    if (now - lastFlush >= FLUSH_S * 1000) {
      flushTracks();
      lastFlush = now;
      console.log(`[${new Date().toISOString()}] polls=${pollCount} failures=${pollFailures} tracked=${lastPoint.size}`);
    }
    if (doPush && now - lastPush >= PUSH_S * 1000) { gitPush(); lastPush = now; }

    await sleep(POLL_S * 1000);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
