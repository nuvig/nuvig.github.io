// KANP Flight Tracker — static snapshot data source
// When the Pi API isn't reachable (e.g. viewing the HTTPS site away from
// home), History Map and Traffic Study read hourly per-day JSON snapshots
// that the Pi's exporter pushes to the repo's traffic-data branch. GitHub
// serves them over HTTPS with CORS, so no tunnel is needed. All filtering
// happens client-side here, mirroring the Pi API's semantics.

const KANPStatic = (() => {
  const DEFAULT_BASE = SITE.tracker.snapshotBase;
  const base = () =>
    localStorage.getItem(`${SITE.tracker.storagePrefix}_static_base`) || DEFAULT_BASE;
  const MAX_DAYS = 62;
  // Day files arrive already shape-simplified by the exporter, so they're
  // returned as-is. Any "too much to draw" decision is made by the History tab
  // on the *drawn* set (after filters), not here on the raw fetch.
  const DENSE_POINTS = 250_000;

  let summaryCache = null;
  let summaryAt = 0;
  const dayCache = new Map();

  async function summary() {
    if (summaryCache && Date.now() - summaryAt < 60_000) return summaryCache;
    const res = await fetch(`${base()}/summary.json`, { cache: 'no-cache' });
    if (!res.ok) throw new Error('No GitHub snapshots found (is the Pi exporter set up?)');
    summaryCache = await res.json();
    summaryAt = Date.now();
    return summaryCache;
  }

  function localDateStr(ts) {
    const d = new Date(ts * 1000);
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function datesInRange(start, end) {
    const out = [];
    const d = new Date(start * 1000);
    d.setHours(0, 0, 0, 0);
    while (d.getTime() / 1000 <= end && out.length < MAX_DAYS) {
      out.push(localDateStr(d.getTime() / 1000));
      d.setDate(d.getDate() + 1);
    }
    return out;
  }

  async function loadDays(start, end) {
    const sum = await summary();
    const avail = new Set(sum.days.map(d => d.date));
    const today = localDateStr(Date.now() / 1000);
    const wanted = datesInRange(start, end).filter(d => avail.has(d));
    if (!wanted.length) throw new Error('No snapshot data for this date range');

    const days = await Promise.all(wanted.map(async date => {
      if (dayCache.has(date) && date !== today) return dayCache.get(date);
      try {
        const res = await fetch(`${base()}/days/${date}.json`,
          date === today ? { cache: 'no-cache' } : undefined);
        if (!res.ok) return null;
        const j = await res.json();
        dayCache.set(date, j);
        return j;
      } catch { return null; }
    }));
    return days.filter(Boolean);
  }

  function haversineNm(lat1, lon1, lat2, lon2) {
    const R = 3440.065, r = Math.PI / 180;
    const a = Math.sin((lat2 - lat1) * r / 2) ** 2 +
      Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin((lon2 - lon1) * r / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  function parseIntList(raw) {
    const out = new Set();
    raw.split(',').forEach(part => {
      part = part.trim();
      const m = part.match(/^(\d+)\s*-\s*(\d+)$/);
      if (m) for (let i = +m[1]; i <= +m[2]; i++) out.add(i);
      else if (part) out.add(+part);
    });
    return out;
  }

  // Apply the same filters the Pi API supports; returns merged track map.
  async function filteredTracks(p) {
    const now = Math.floor(Date.now() / 1000);
    const start = p.start != null ? +p.start : now - 86400;
    const end = p.end != null ? +p.end : now;
    const days = await loadDays(start, end);

    const hours = p.hours ? parseIntList(String(p.hours)) : null;
    const dows = p.dow ? parseIntList(String(p.dow)) : null;
    const csPat = p.callsign ? String(p.callsign).trim().toUpperCase() : null;
    const ground = p.ground || 'include';
    const minAlt = p.min_alt !== undefined ? +p.min_alt : null;
    const maxAlt = p.max_alt !== undefined ? +p.max_alt : null;
    const minDist = p.min_dist !== undefined ? +p.min_dist : null;
    const maxDist = p.max_dist !== undefined ? +p.max_dist : null;

    const tracks = new Map();
    let totalPoints = 0;

    for (const day of days) {
      for (const t of day.tracks) {
        if (p.military == 1 && !t.military) continue;
        if (p.ga == 1 && !KANP.isGA(t)) continue;
        if (csPat) {
          const f = (t.flight || '').toUpperCase();
          const r = (t.reg || '').toUpperCase();
          if (!f.includes(csPat) && !r.includes(csPat)) continue;
        }
        const kept = [];
        for (const pt of t.points) {
          const [ts, lat, lon, alt, , og] = pt;
          if (ts < start || ts > end) continue;
          if (ground === 'exclude' && og) continue;
          if (ground === 'only' && !og) continue;
          if (minAlt != null && !og && !(alt != null && alt >= minAlt)) continue;
          if (maxAlt != null && alt != null && alt > maxAlt) continue;
          if (hours || dows) {
            const d = new Date(ts * 1000);
            if (hours && !hours.has(d.getHours())) continue;
            if (dows && !dows.has((d.getDay() + 6) % 7)) continue;
          }
          if (minDist != null || maxDist != null) {
            const dist = haversineNm(KANP.LAT, KANP.LON, lat, lon);
            if (minDist != null && dist < minDist) continue;
            if (maxDist != null && dist > maxDist) continue;
          }
          kept.push(pt);
        }
        if (!kept.length) continue;
        let entry = tracks.get(t.hex);
        if (!entry) {
          entry = { hex: t.hex, flight: t.flight, reg: t.reg, type: t.type,
                    descr: t.descr, military: t.military, points: [] };
          tracks.set(t.hex, entry);
        }
        if (t.flight) entry.flight = t.flight;
        entry.points.push(...kept);
        totalPoints += kept.length;
      }
    }

    tracks.forEach(t => t.points.sort((a, b) => a[0] - b[0]));
    return { tracks, totalPoints, start, end };
  }

  async function getTracks(p) {
    const { tracks, totalPoints, start, end } = await filteredTracks(p);
    const list = [...tracks.values()].sort((a, b) => b.points.length - a.points.length);

    return {
      start, end,
      total_points: totalPoints,
      returned_points: totalPoints,
      dense: totalPoints > DENSE_POINTS,
      aircraft_count: list.length,
      tracks: list,
      snapshot_generated: summaryCache ? summaryCache.generated : null,
    };
  }

  async function getStats(p) {
    const { tracks, totalPoints, start, end } = await filteredTracks(p);

    const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
    const gridSets = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => new Set()));
    const gridSamples = Array.from({ length: 7 }, () => new Array(24).fill(0));
    const daily = new Map();
    const altHist = new Map();
    const top = new Map();
    const typeSets = new Map();

    tracks.forEach(t => {
      const typeKey = t.type || '?';
      if (!typeSets.has(typeKey)) typeSets.set(typeKey, new Set());
      typeSets.get(typeKey).add(t.hex);
      let e = top.get(t.hex);
      if (!e) {
        e = { hex: t.hex, reg: t.reg, type: t.type, descr: t.descr,
              military: t.military, samples: 0, first_ts: Infinity, last_ts: 0,
              min_alt: null, max_alt: null, min_dist: null,
              callsigns: new Set() };
        top.set(t.hex, e);
      }
      if (t.flight) e.callsigns.add(t.flight);

      for (const [ts, lat, lon, alt, , og] of t.points) {
        const d = new Date(ts * 1000);
        const dow = (d.getDay() + 6) % 7, hr = d.getHours();
        gridSets[dow][hr].add(t.hex);
        gridSamples[dow][hr]++;

        const dayKey = localDateStr(ts);
        let day = daily.get(dayKey);
        if (!day) { day = { d: dayKey, ac: new Set(), samples: 0 }; daily.set(dayKey, day); }
        day.ac.add(t.hex);
        day.samples++;

        if (!og && alt != null && alt >= 0) {
          const bucket = Math.floor(alt / 500) * 500;
          altHist.set(bucket, (altHist.get(bucket) || 0) + 1);
        }

        e.samples++;
        e.first_ts = Math.min(e.first_ts, ts);
        e.last_ts = Math.max(e.last_ts, ts);
        if (alt != null && !og) {
          e.min_alt = e.min_alt == null ? alt : Math.min(e.min_alt, alt);
          e.max_alt = e.max_alt == null ? alt : Math.max(e.max_alt, alt);
        }
        const dist = haversineNm(KANP.LAT, KANP.LON, lat, lon);
        e.min_dist = e.min_dist == null ? dist : Math.min(e.min_dist, dist);
      }
    });

    for (let d = 0; d < 7; d++)
      for (let h = 0; h < 24; h++)
        grid[d][h] = gridSets[d][h].size;

    return {
      start, end,
      totals: { samples: totalPoints, aircraft: tracks.size },
      grid_unique_aircraft: grid,
      grid_samples: gridSamples,
      types: [...typeSets.entries()].map(([type, hexes]) => ({ type, ac: hexes.size }))
        .sort((a, b) => b.ac - a.ac),
      daily: [...daily.values()].sort((a, b) => a.d.localeCompare(b.d))
        .map(d => ({ d: d.d, ac: d.ac.size, samples: d.samples })),
      altitude_histogram: [...altHist.entries()].sort((a, b) => a[0] - b[0])
        .map(([bucket, samples]) => ({ bucket, samples })),
      top_aircraft: [...top.values()].sort((a, b) => b.samples - a.samples).slice(0, 25)
        .map(e => ({ ...e, min_dist: e.min_dist != null ? +e.min_dist.toFixed(1) : null,
                     callsigns: [...e.callsigns].join(',') || null })),
      snapshot_generated: summaryCache ? summaryCache.generated : null,
    };
  }

  // Snapshot CSV built in the browser (decimated snapshot data, fewer columns
  // than the Pi's full export)
  async function exportCsv(p) {
    const { tracks } = await filteredTracks(p);
    const lines = ['ts_utc,local_time,hex,flight,reg,type,lat,lon,alt_ft,gs_kts,dist_nm,on_ground,military'];
    tracks.forEach(t => {
      for (const [ts, lat, lon, alt, gs, og] of t.points) {
        const dist = haversineNm(KANP.LAT, KANP.LON, lat, lon).toFixed(2);
        lines.push([ts, new Date(ts * 1000).toLocaleString().replace(/,/g, ''),
          t.hex, t.flight || '', t.reg || '', t.type || '',
          lat, lon, alt ?? '', gs ?? '', dist, og, t.military ? 1 : 0].join(','));
      }
    });
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'kanp_positions_snapshot.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return { getTracks, getStats, exportCsv, summary };
})();
