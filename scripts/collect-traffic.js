// Fetches current aircraft near KANP from airplanes.live and appends a
// compact snapshot to the traffic history file. Run by the scheduled
// GitHub Action in .github/workflows/collect-traffic.yml.
//
// Usage: node scripts/collect-traffic.js <existing.json> <out.json>
//
// Snapshot format (kept small — this file is fetched by the tracker page):
//   [{ "ts": 1720000000000, "ac": [[38.9422, -76.5684, 1200], ...] }, ...]
// Each aircraft is [lat, lon, alt_ft] (alt null when unknown, 0 on ground).
// Older snapshots may have [lat, lon] pairs; the page handles both.

const fs = require('fs');

const [, , existingPath, outPath] = process.argv;
if (!existingPath || !outPath) {
  console.error('usage: node collect-traffic.js <existing.json> <out.json>');
  process.exit(1);
}

const KANP_LAT   = 38.9422;
const KANP_LON   = -76.5684;
const SEARCH_NM  = 20;
const MAX_AGE_MS = 30 * 86_400_000; // keep 30 days

async function main() {
  let existing = [];
  try {
    existing = JSON.parse(fs.readFileSync(existingPath, 'utf8'));
    if (!Array.isArray(existing)) existing = [];
  } catch {
    // first run, or corrupt file — start fresh
  }

  const url = `https://api.airplanes.live/v2/point/${KANP_LAT}/${KANP_LON}/${SEARCH_NM}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'kanp-tracker (jesselevine.net)' } });
  if (!res.ok) throw new Error(`airplanes.live API error ${res.status}`);

  const data = await res.json();
  const ac = (data.ac || [])
    .filter(a => a.lat && a.lon)
    .map(a => {
      const alt = a.alt_baro === 'ground' ? 0
        : typeof a.alt_baro === 'number' ? Math.round(a.alt_baro)
        : null;
      return [Number(a.lat.toFixed(4)), Number(a.lon.toFixed(4)), alt];
    });

  const now = Date.now();
  existing.push({ ts: now, ac });
  const pruned = existing.filter(o => o.ts > now - MAX_AGE_MS);

  fs.writeFileSync(outPath, JSON.stringify(pruned));
  console.log(`${pruned.length} snapshots stored, latest has ${ac.length} aircraft`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
