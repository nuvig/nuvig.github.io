// Samples the airspace around KANP from airplanes.live for a few minutes and
// merges the results into the traffic-data directory:
//
//   <data-dir>/traffic.json            rolling 30-day snapshots (one per run)
//                                      → feeds the temporal heatmap
//   <data-dir>/tracks/YYYY-MM-DD.json  per-UTC-day track segments
//                                      → feeds the History Explorer
//   <data-dir>/tracks/index.json       list of available days
//
// Run by the scheduled GitHub Action (.github/workflows/collect-traffic.yml).
// The receiver exporter (scripts/receiver-export.js) writes the same track
// format from full-fidelity RTL-SDR data — the page treats both identically.
//
// Usage: node scripts/collect-airspace.js <data-dir> [durationSec] [intervalSec]

const fs = require('fs');
const path = require('path');

const KANP_LAT   = 38.9422;
const KANP_LON   = -76.5684;
const SEARCH_NM  = 20;
const SNAP_MAX_AGE_MS = 30 * 86_400_000; // snapshots: 30 days
const TRACK_KEEP_DAYS = 30;              // per-day track files: 30 days
const MIN_MOVE_NM = 0.02;                // skip stationary aircraft points

const [, , dataDir, durationArg, intervalArg] = process.argv;
if (!dataDir) {
  console.error('usage: node collect-airspace.js <data-dir> [durationSec] [intervalSec]');
  process.exit(1);
}
const DURATION_S = Number(durationArg) > 0 ? Number(durationArg) : 300;
const INTERVAL_S = Number(intervalArg) > 0 ? Number(intervalArg) : 20;

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
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

async function pollOnce() {
  const url = `https://api.airplanes.live/v2/point/${KANP_LAT}/${KANP_LON}/${SEARCH_NM}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'kanp-tracker (jesselevine.net)' } });
  if (!res.ok) throw new Error(`airplanes.live API error ${res.status}`);
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

const sleep = ms => new Promise(r => setTimeout(r, ms));

function utcDateStr(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

function utcMidnight(ts) {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

// ---------------------------------------------------------------------------

async function main() {
  const tracksDir = path.join(dataDir, 'tracks');
  fs.mkdirSync(tracksDir, { recursive: true });

  // --- Sampling burst ---
  const startTs = Date.now();
  const deadline = startTs + DURATION_S * 1000;
  // hex -> { cs, pts: [{ts, lat, lon, alt}] }
  const burst = new Map();
  let firstSnapshot = null;
  let polls = 0, failures = 0;

  while (true) {
    try {
      const ac = await pollOnce();
      polls++;
      if (!firstSnapshot) firstSnapshot = ac;
      const now = Date.now();
      for (const a of ac) {
        if (!a.hex) continue;
        let t = burst.get(a.hex);
        if (!t) { t = { cs: a.cs, pts: [] }; burst.set(a.hex, t); }
        if (!t.cs && a.cs) t.cs = a.cs;
        const last = t.pts[t.pts.length - 1];
        if (last && distNm(last.lat, last.lon, a.lat, a.lon) < MIN_MOVE_NM && last.alt === a.alt) continue;
        t.pts.push({ ts: now, lat: a.lat, lon: a.lon, alt: a.alt });
      }
    } catch (err) {
      failures++;
      console.warn(`poll failed: ${err.message}`);
    }
    if (Date.now() + INTERVAL_S * 1000 > deadline) break;
    await sleep(INTERVAL_S * 1000);
  }

  if (!firstSnapshot) throw new Error(`all ${failures} polls failed`);

  // --- Snapshot file (temporal heatmap) ---
  const trafficFile = path.join(dataDir, 'traffic.json');
  const snapshots = readJson(trafficFile, []);
  snapshots.push({ ts: startTs, ac: firstSnapshot.map(a => [a.lat, a.lon, a.alt]) });
  const prunedSnaps = snapshots.filter(o => o.ts > startTs - SNAP_MAX_AGE_MS);
  fs.writeFileSync(trafficFile, JSON.stringify(prunedSnaps));

  // --- Track files (history explorer), grouped by UTC day ---
  // dayStr -> hex -> { cs, pts: [[secOfDay, lat, lon, alt]] }
  const byDay = new Map();
  for (const [hex, t] of burst) {
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

  // --- Prune old track files, rebuild index ---
  const cutoff = utcDateStr(startTs - TRACK_KEEP_DAYS * 86_400_000);
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

  console.log(`${polls} polls (${failures} failed), ${burst.size} aircraft tracked, ` +
              `${prunedSnaps.length} snapshots, ${index.length} track days`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
