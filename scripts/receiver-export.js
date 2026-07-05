// Exports a day of full-fidelity tracks from a readsb/tar1090 receiver's
// globe_history archive into the tracker's shared track format:
//
//   <out-dir>/tracks/YYYY-MM-DD.json   (same schema as collect-airspace.js)
//   <out-dir>/tracks/index.json        (rebuilt)
//
// Runs on the receiver (e.g. a Raspberry Pi with an RTL-SDR). Requires
// readsb started with --write-globe-history=/var/globe_history (the
// wiedehopf/adsb.im installs enable this by default for tar1090's replay).
// No npm dependencies — plain Node.
//
// Usage:
//   node receiver-export.js <globe-history-dir> <out-dir> [YYYY-MM-DD]
//   (date defaults to yesterday UTC — run it shortly after midnight UTC)
//
// See docs/receiver-setup.md for the cron + git push wiring.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const KANP_LAT   = 38.9422;
const KANP_LON   = -76.5684;
const SEARCH_NM  = 20;
const DOWNSAMPLE_S = 15;   // keep at most one point per 15 s per aircraft
const TRACK_KEEP_DAYS = 30;

const [, , historyDir, outDir, dateArg] = process.argv;
if (!historyDir || !outDir) {
  console.error('usage: node receiver-export.js <globe-history-dir> <out-dir> [YYYY-MM-DD]');
  process.exit(1);
}

const day = dateArg || new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
  console.error(`invalid date: ${day}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------

function distNm(lat1, lon1, lat2, lon2) {
  const R = 3440.065;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function normAlt(v) {
  if (v === 'ground') return 0;
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null;
}

// Trace files may be stored gzipped (nginx gzip_static setups) or plain.
function readTrace(file) {
  let buf = fs.readFileSync(file);
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
  return JSON.parse(buf.toString('utf8'));
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) ?? fallback; }
  catch { return fallback; }
}

// ---------------------------------------------------------------------------

function main() {
  const [y, m, d] = day.split('-');
  const tracesRoot = path.join(historyDir, y, m, d, 'traces');
  if (!fs.existsSync(tracesRoot)) {
    console.error(`no traces found at ${tracesRoot} — is --write-globe-history enabled?`);
    process.exit(1);
  }

  const dayMidnightSec = Date.UTC(+y, +m - 1, +d) / 1000;
  const tracks = [];
  let filesRead = 0;

  for (const shard of fs.readdirSync(tracesRoot)) {
    const shardDir = path.join(tracesRoot, shard);
    if (!fs.statSync(shardDir).isDirectory()) continue;

    for (const f of fs.readdirSync(shardDir)) {
      if (!f.startsWith('trace_full_')) continue;
      let trace;
      try { trace = readTrace(path.join(shardDir, f)); }
      catch (err) { console.warn(`skipping ${f}: ${err.message}`); continue; }
      filesRead++;

      const baseTs = trace.timestamp; // epoch seconds
      const hex = (trace.icao || f.replace(/^trace_full_|\.json$/g, '')).toLowerCase();
      let cs = '';
      const pts = [];
      let lastKept = -Infinity;

      for (const p of trace.trace || []) {
        // trace point: [seconds_offset, lat, lon, alt_baro, gs, track, flags,
        //               vert_rate, aircraft_object?, ...]
        // Callsign rides along on sparse points — check before any skipping
        if (!cs && p[8] && typeof p[8] === 'object' && p[8].flight) cs = p[8].flight.trim();

        const ts = baseTs + p[0];
        const lat = p[1], lon = p[2];
        if (typeof lat !== 'number' || typeof lon !== 'number') continue;
        if (ts - lastKept < DOWNSAMPLE_S) continue;
        if (distNm(KANP_LAT, KANP_LON, lat, lon) > SEARCH_NM) continue;

        const sec = Math.round(ts - dayMidnightSec);
        if (sec < 0 || sec >= 86_400) continue; // trace files can span midnight
        pts.push([sec, Number(lat.toFixed(4)), Number(lon.toFixed(4)), normAlt(p[3])]);
        lastKept = ts;
      }

      if (pts.length >= 2) tracks.push({ hex, cs, pts });
    }
  }

  const tracksDir = path.join(outDir, 'tracks');
  fs.mkdirSync(tracksDir, { recursive: true });
  fs.writeFileSync(path.join(tracksDir, `${day}.json`), JSON.stringify({ date: day, tracks }));

  // Prune old files, rebuild index (same layout as collect-airspace.js)
  const cutoff = new Date(Date.now() - TRACK_KEEP_DAYS * 86_400_000).toISOString().slice(0, 10);
  const index = [];
  for (const f of fs.readdirSync(tracksDir).sort()) {
    const mm = f.match(/^(\d{4}-\d{2}-\d{2})\.json$/);
    if (!mm) continue;
    if (mm[1] < cutoff) { fs.unlinkSync(path.join(tracksDir, f)); continue; }
    const dj = readJson(path.join(tracksDir, f), null);
    if (!dj) continue;
    index.push({
      date: mm[1],
      tracks: dj.tracks.length,
      points: dj.tracks.reduce((n, t) => n + t.pts.length, 0),
    });
  }
  fs.writeFileSync(path.join(tracksDir, 'index.json'), JSON.stringify(index));

  const totalPts = tracks.reduce((n, t) => n + t.pts.length, 0);
  console.log(`${day}: ${filesRead} trace files → ${tracks.length} tracks within ` +
              `${SEARCH_NM} nm (${totalPts} points)`);
}

main();
