// KANP Flight Tracker
//
// Live data sources (selectable in Settings, persisted in localStorage):
//   - airplanes.live point API (default, free, no key)
//   - Local receiver / custom URL — e.g. a readsb/tar1090 aircraft.json from
//     an RTL-SDR box on your LAN, or an ADS-B Exchange feeder re-api URL
//   - ADS-B Exchange via RapidAPI (key stored ONLY in this browser)
//
// History comes from two sources, merged at render time:
//   1. A shared snapshot file collected by a scheduled GitHub Action
//      (pushed to the `traffic-data` branch of this repo).
//   2. Observations from this browser while the page is open (localStorage).
//
// Trails: positions are accumulated per aircraft while the page is open and
// drawn as polylines colored by altitude band. The altitude filter applies
// to trails, live aircraft, and the geographic heatmap — the building block
// for exploring approach paths.

const KANP_LAT   = 38.9422;
const KANP_LON   = -76.5684;
const SEARCH_NM  = 20;              // nautical miles radius
const MAX_AGE_MS = 30 * 86_400_000; // keep 30 days of history
const TRAIL_MAX_AGE_MS = 45 * 60_000; // keep 45 min of trail per aircraft
const OBS_KEY      = 'kanp_obs';
const SETTINGS_KEY = 'kanp_settings';
const DATA_BASE    = 'https://raw.githubusercontent.com/nuvig/nuvig.github.io/traffic-data/';
const SHARED_URL   = DATA_BASE + 'traffic.json';
const HISTORY_GAP_S = 180; // split history trails at sampling gaps > 3 min

// Poll intervals per source. Local receivers update every second and can
// take fast polling; RapidAPI plans have monthly quotas, so go slow there.
const POLL_INTERVALS = { airplanes: 15_000, custom: 5_000, adsbx: 60_000 };

// Altitude bands (ft) and their trail colors, low → high
const ALT_BANDS = [
  { max: 500,      color: '#9ca3af', label: '<500'    },
  { max: 1500,     color: '#ef4444', label: '500–1.5k' },
  { max: 3000,     color: '#f59e0b', label: '1.5–3k'  },
  { max: 6000,     color: '#22c55e', label: '3–6k'    },
  { max: 10000,    color: '#00b4d8', label: '6–10k'   },
  { max: Infinity, color: '#a78bfa', label: '10k+'    },
];

const DEFAULT_SETTINGS = {
  source: 'airplanes',  // 'airplanes' | 'custom' | 'adsbx'
  customUrl: '',
  adsbxKey: '',
  altMin: 0,
  altMax: 45000,
  trails: true,
};

let settings = loadSettings();
let pollTimer = null;
let map, heatLayer, aircraftLayer, trailLayer, historyLayer;
let sharedObs = [];     // snapshots collected server-side, fetched once per load
let lastAc = [];        // most recent live aircraft list, for filter re-renders
const trails = new Map(); // hex -> { lastTs, points: [{lat, lon, alt, ts}] }
let historyDay = null;  // loaded History Explorer day: { date, tracks }

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  // If Leaflet failed to load (CDN down, offline), keep the rest of the
  // page — status bar and temporal heatmap — working without the map.
  try { initMap(); }
  catch (err) { console.error('[KANP tracker] map init failed', err); }
  initUI();
  renderFromStorage();
  fetchSharedHistory();
  loadHistoryIndex();
  startPolling();
});

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------
function initMap() {
  map = L.map('map').setView([KANP_LAT, KANP_LON], 11);

  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 19,
  }).addTo(map);

  // Airport pin
  L.marker([KANP_LAT, KANP_LON], {
    icon: L.divIcon({
      html: '<div style="font-size:22px;line-height:1;filter:drop-shadow(0 0 4px #fff)">✈</div>',
      className: '',
      iconAnchor: [11, 11],
    }),
    interactive: false,
  }).addTo(map).bindTooltip('KANP — Lee Airport');

  // 20 nm range ring (1 nm ≈ 1852 m)
  L.circle([KANP_LAT, KANP_LON], {
    radius: SEARCH_NM * 1852,
    color: '#444',
    weight: 1,
    fill: false,
  }).addTo(map);

  heatLayer = L.heatLayer([], { radius: 22, blur: 28, maxZoom: 13, gradient: { 0.1: '#0077b6', 0.4: '#00b4d8', 0.65: '#f0c040', 1.0: '#ef4444' } }).addTo(map);
  historyLayer  = L.layerGroup().addTo(map);
  trailLayer    = L.layerGroup().addTo(map);
  aircraftLayer = L.layerGroup().addTo(map);
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// UI bindings
// ---------------------------------------------------------------------------
function initUI() {
  document.getElementById('clear-data-btn').addEventListener('click', clearHistory);

  // Re-render temporal canvas on resize
  const ro = new ResizeObserver(() => renderTemporalHeatmap(allObs()));
  ro.observe(document.getElementById('temporal-canvas').parentElement);

  // Refresh immediately when the tab becomes visible again — background tabs
  // get their timers throttled, so the display may be stale.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) fetchNow();
  });

  // --- Display controls ---
  const trailsToggle = document.getElementById('trails-toggle');
  const altMinInput  = document.getElementById('alt-min');
  const altMaxInput  = document.getElementById('alt-max');

  trailsToggle.checked = settings.trails;
  altMinInput.value = settings.altMin;
  altMaxInput.value = settings.altMax;

  trailsToggle.addEventListener('change', () => {
    settings.trails = trailsToggle.checked;
    saveSettings();
    renderTrails();
  });

  const onAltChange = () => {
    settings.altMin = clampAlt(parseInt(altMinInput.value, 10), 0);
    settings.altMax = clampAlt(parseInt(altMaxInput.value, 10), 45000);
    saveSettings();
    applyFilters();
  };
  altMinInput.addEventListener('change', onAltChange);
  altMaxInput.addEventListener('change', onAltChange);

  document.getElementById('alt-reset').addEventListener('click', () => {
    settings.altMin = 0;
    settings.altMax = 45000;
    altMinInput.value = 0;
    altMaxInput.value = 45000;
    saveSettings();
    applyFilters();
  });

  // Altitude legend
  const legend = document.getElementById('alt-legend');
  legend.innerHTML = ALT_BANDS.map(b =>
    `<span class="alt-band"><span class="swatch" style="background:${b.color}"></span>${b.label}</span>`
  ).join('');

  // --- Data source controls ---
  const sourceSel  = document.getElementById('source-select');
  const customUrl  = document.getElementById('custom-url');
  const adsbxKey   = document.getElementById('adsbx-key');

  sourceSel.value = settings.source;
  customUrl.value = settings.customUrl;
  adsbxKey.value  = settings.adsbxKey;
  updateSourceFieldVisibility();

  sourceSel.addEventListener('change', () => {
    settings.source = sourceSel.value;
    saveSettings();
    updateSourceFieldVisibility();
    startPolling();
  });
  customUrl.addEventListener('change', () => {
    settings.customUrl = customUrl.value.trim();
    saveSettings();
    if (settings.source === 'custom') startPolling();
  });
  adsbxKey.addEventListener('change', () => {
    settings.adsbxKey = adsbxKey.value.trim();
    saveSettings();
    if (settings.source === 'adsbx') startPolling();
  });
}

function updateSourceFieldVisibility() {
  document.getElementById('custom-url-row').style.display  = settings.source === 'custom' ? '' : 'none';
  document.getElementById('adsbx-key-row').style.display   = settings.source === 'adsbx'  ? '' : 'none';
}

function clampAlt(v, fallback) {
  return Number.isFinite(v) ? Math.max(0, Math.min(60000, v)) : fallback;
}

// Re-render everything affected by the altitude filter
function applyFilters() {
  renderLiveAircraft(lastAc);
  renderTrails();
  renderGeoHeatmap(allObs());
  renderHistory();
}

// ---------------------------------------------------------------------------
// Altitude helpers
// ---------------------------------------------------------------------------
function normAlt(v) {
  if (v === 'ground') return 0;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function filterIsDefault() {
  return settings.altMin <= 0 && settings.altMax >= 45000;
}

// Unknown altitudes are shown only when the filter is wide open, so
// filtering never silently includes aircraft we can't classify.
function altInRange(alt) {
  if (alt == null) return filterIsDefault();
  return alt >= settings.altMin && alt <= settings.altMax;
}

function altBand(alt) {
  const a = alt ?? 0;
  for (const band of ALT_BANDS) {
    if (a < band.max) return band;
  }
  return ALT_BANDS[ALT_BANDS.length - 1];
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------
function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  const interval = POLL_INTERVALS[settings.source] || 60_000;
  pollTimer = setInterval(fetchNow, interval);
  fetchNow();
}

// Fetch the current aircraft list from whichever source is configured and
// normalize to: { lat, lon, alt, hex, flight, gs, track }
async function fetchAircraft() {
  let res, raw;

  if (settings.source === 'custom') {
    if (!settings.customUrl) throw new Error('No custom URL configured');
    res = await fetch(settings.customUrl);
  } else if (settings.source === 'adsbx') {
    if (!settings.adsbxKey) throw new Error('No ADS-B Exchange API key configured');
    res = await fetch(
      `https://adsbexchange-com1.p.rapidapi.com/v2/lat/${KANP_LAT}/lon/${KANP_LON}/dist/${SEARCH_NM}/`,
      { headers: {
          'X-RapidAPI-Key': settings.adsbxKey,
          'X-RapidAPI-Host': 'adsbexchange-com1.p.rapidapi.com',
      } },
    );
  } else {
    res = await fetch(`https://api.airplanes.live/v2/point/${KANP_LAT}/${KANP_LON}/${SEARCH_NM}`);
  }

  if (res.status === 429) { const e = new Error('rate limited'); e.rateLimited = true; throw e; }
  if (!res.ok) throw new Error(`API error ${res.status}`);
  raw = await res.json();

  // airplanes.live & ADSBx return {ac:[]}; readsb/tar1090 returns {aircraft:[]}
  const list = raw.ac || raw.aircraft || [];

  return list
    .filter(a => typeof a.lat === 'number' && typeof a.lon === 'number')
    .map(a => ({
      lat: a.lat,
      lon: a.lon,
      alt: normAlt(a.alt_baro ?? a.alt_geom),
      hex: a.hex,
      flight: (a.flight || '').trim(),
      gs: a.gs,
      track: a.track,
    }))
    // Local receivers see far beyond 20 nm — keep the view consistent
    .filter(a => distNm(KANP_LAT, KANP_LON, a.lat, a.lon) <= SEARCH_NM);
}

async function fetchNow() {
  setStatus('yellow', 'Fetching…');

  try {
    const ac = await fetchAircraft();

    lastAc = ac;
    storeObs(ac);
    updateTrails(ac);
    if (aircraftLayer) renderLiveAircraft(ac);
    renderTrails();
    renderFromStorage();

    setStatus('green', `Live · ${sourceLabel()}`);
    show('ac-count-wrap');
    document.getElementById('ac-num').textContent = ac.length;
    show('update-wrap');
    document.getElementById('update-time').textContent = new Date().toLocaleTimeString();
  } catch (err) {
    if (err.rateLimited) setStatus('yellow', 'Rate limit — will retry');
    else setStatus('red', err.message || 'Network error');
    console.error('[KANP tracker]', err);
  }
}

function sourceLabel() {
  return { airplanes: 'airplanes.live', custom: 'local/custom', adsbx: 'ADS-B Exchange' }[settings.source] || settings.source;
}

// ---------------------------------------------------------------------------
// Trails
// ---------------------------------------------------------------------------
function updateTrails(ac) {
  const now = Date.now();

  ac.forEach(a => {
    if (!a.hex) return;
    let t = trails.get(a.hex);
    if (!t) {
      t = { lastTs: now, points: [] };
      trails.set(a.hex, t);
    }
    t.lastTs = now;

    const last = t.points[t.points.length - 1];
    // Skip stationary aircraft (parked with ADS-B on) to avoid point buildup
    if (last && distNm(last.lat, last.lon, a.lat, a.lon) < 0.02 && last.alt === a.alt) return;
    t.points.push({ lat: a.lat, lon: a.lon, alt: a.alt, ts: now });
  });

  // Prune old points and stale aircraft
  for (const [hex, t] of trails) {
    t.points = t.points.filter(p => now - p.ts < TRAIL_MAX_AGE_MS);
    if (!t.points.length && now - t.lastTs > TRAIL_MAX_AGE_MS) trails.delete(hex);
  }
}

// Draw each trail as polyline segments grouped by altitude band, so a
// descent renders as a color gradient from cruise color down to red.
function renderTrails() {
  if (!trailLayer) return;
  trailLayer.clearLayers();
  if (!settings.trails) return;

  for (const t of trails.values()) {
    if (t.points.length < 2) continue;

    let seg = [];
    let segBand = null;

    const flush = () => {
      if (seg.length > 1 && segBand) {
        L.polyline(seg.map(p => [p.lat, p.lon]), {
          color: segBand.color,
          weight: 2,
          opacity: 0.8,
          interactive: false,
        }).addTo(trailLayer);
      }
    };

    for (const p of t.points) {
      if (!altInRange(p.alt)) {
        flush();
        seg = [];
        segBand = null;
        continue;
      }
      const b = altBand(p.alt);
      if (!segBand) {
        segBand = b;
        seg = [p];
      } else if (b === segBand) {
        seg.push(p);
      } else {
        seg.push(p); // include the transition point in both segments
        flush();
        seg = [p];
        segBand = b;
      }
    }
    flush();
  }
}

// ---------------------------------------------------------------------------
// History Explorer — replay per-day track files from the traffic-data branch
// (written by the GitHub Action's sampling bursts and, at much higher
// fidelity, by an RTL-SDR receiver via scripts/receiver-export.js)
// ---------------------------------------------------------------------------
async function loadHistoryIndex() {
  try {
    const res = await fetch(DATA_BASE + 'tracks/index.json', { cache: 'no-cache' });
    if (!res.ok) return; // no track data yet — leave the section hidden

    const index = await res.json();
    if (!Array.isArray(index) || !index.length) return;

    const sel = document.getElementById('history-day');
    sel.innerHTML = index
      .slice()
      .sort((a, b) => b.date.localeCompare(a.date))
      .map(d => `<option value="${esc(d.date)}">${esc(d.date)} · ${d.tracks} aircraft</option>`)
      .join('');

    document.getElementById('history-card').style.display = '';
    document.getElementById('history-load').addEventListener('click', loadHistoryDay);
    document.getElementById('history-clear').addEventListener('click', () => {
      historyDay = null;
      renderHistory();
      document.getElementById('history-status').textContent = '';
    });
    document.getElementById('hour-min').addEventListener('change', renderHistory);
    document.getElementById('hour-max').addEventListener('change', renderHistory);
  } catch (err) {
    console.warn('[KANP tracker] track index unavailable', err);
  }
}

async function loadHistoryDay() {
  const date = document.getElementById('history-day').value;
  const status = document.getElementById('history-status');
  if (!date) return;
  status.textContent = 'Loading…';
  try {
    const res = await fetch(`${DATA_BASE}tracks/${date}.json`, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    historyDay = await res.json();
    renderHistory();
  } catch (err) {
    status.textContent = 'Failed to load day';
    console.error('[KANP tracker] history day load failed', err);
  }
}

// Convert a UTC second-of-day to a local hour for the hour-range filter.
// The UTC offset is taken at the day's midpoint — constant across the day
// except on DST transition days, which is close enough for filtering.
function localHourAt(dayMidnightMs, sec) {
  return new Date(dayMidnightMs + sec * 1000).getHours() +
         new Date(dayMidnightMs + sec * 1000).getMinutes() / 60;
}

function renderHistory() {
  if (!historyLayer) return;
  historyLayer.clearLayers();
  if (!historyDay) return;

  const [y, m, d] = historyDay.date.split('-').map(Number);
  const dayMidnightMs = Date.UTC(y, m - 1, d);

  const hourMin = clampHour(document.getElementById('hour-min').value, 0);
  const hourMax = clampHour(document.getElementById('hour-max').value, 24);

  let shownTracks = 0, shownPts = 0;

  for (const track of historyDay.tracks) {
    let seg = [];
    let segBand = null;
    let lastSec = null;
    let drewAny = false;

    const flush = () => {
      if (seg.length > 1 && segBand) {
        L.polyline(seg.map(p => [p[1], p[2]]), {
          color: segBand.color,
          weight: 1.5,
          opacity: 0.6,
          interactive: false,
        }).addTo(historyLayer);
        drewAny = true;
      }
    };

    for (const p of track.pts) {
      const [sec, , , alt] = p;
      const hr = localHourAt(dayMidnightMs, sec);
      const keep = hr >= hourMin && hr <= hourMax && altInRange(alt);
      const gap = lastSec != null && sec - lastSec > HISTORY_GAP_S;

      if (!keep || gap) {
        flush();
        seg = [];
        segBand = null;
        if (!keep) { lastSec = sec; continue; }
      }

      const b = altBand(alt);
      if (!segBand) {
        segBand = b;
        seg = [p];
      } else if (b === segBand) {
        seg.push(p);
      } else {
        seg.push(p);
        flush();
        seg = [p];
        segBand = b;
      }
      shownPts++;
      lastSec = sec;
    }
    flush();
    if (drewAny) shownTracks++;
  }

  document.getElementById('history-status').textContent =
    `${historyDay.date}: ${shownTracks} aircraft · ${shownPts.toLocaleString()} points shown`;
}

function clampHour(v, fallback) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(24, n)) : fallback;
}

// ---------------------------------------------------------------------------
// Shared history (collected by GitHub Action, see .github/workflows/)
// ---------------------------------------------------------------------------
async function fetchSharedHistory() {
  try {
    const res = await fetch(SHARED_URL, { cache: 'no-cache' });
    if (!res.ok) return; // branch may not exist yet — local data still works

    const raw = await res.json();
    const cutoff = Date.now() - MAX_AGE_MS;

    // Shared snapshots store aircraft as compact [lat, lon] or [lat, lon, alt]
    sharedObs = raw
      .filter(o => o.ts > cutoff)
      .map(o => ({
        ts: o.ts,
        ac: o.ac.map(p => ({ lat: p[0], lon: p[1], alt: p.length > 2 ? normAlt(p[2]) : null })),
      }));

    renderFromStorage();
  } catch (err) {
    console.warn('[KANP tracker] shared history unavailable', err);
  }
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------
function getObs() {
  try { return JSON.parse(localStorage.getItem(OBS_KEY) || '[]'); }
  catch { return []; }
}

// Everything we know: shared snapshots + this browser's observations,
// in timestamp order.
function allObs() {
  return [...sharedObs, ...getObs()].sort((a, b) => a.ts - b.ts);
}

function storeObs(ac) {
  const now = Date.now();
  const obs  = getObs();

  obs.push({
    ts: now,
    ac: ac.map(a => ({
      lat: a.lat,
      lon: a.lon,
      hex: a.hex,
      cs:  a.flight,
      alt: a.alt,
      gs:  a.gs,
      trk: a.track,
    })),
  });

  const pruned = obs.filter(o => o.ts > now - MAX_AGE_MS);

  try {
    localStorage.setItem(OBS_KEY, JSON.stringify(pruned));
  } catch {
    // Storage quota — drop oldest 25 %
    const trimmed = pruned.slice(Math.floor(pruned.length * 0.25));
    try { localStorage.setItem(OBS_KEY, JSON.stringify(trimmed)); } catch { /* give up */ }
  }
}

// ---------------------------------------------------------------------------
// Live aircraft layer
// ---------------------------------------------------------------------------
function renderLiveAircraft(ac) {
  if (!aircraftLayer) return;
  aircraftLayer.clearLayers();

  ac.forEach(a => {
    if (!altInRange(a.alt)) return;

    const heading = a.track ?? 0;
    const label   = esc(a.flight || a.hex || '?');
    const alt     = a.alt != null ? `${Number(a.alt).toLocaleString()} ft` : '— ft';
    const gs      = a.gs != null ? ` · ${Math.round(a.gs)} kts` : '';
    const color   = altBand(a.alt).color;

    const icon = L.divIcon({
      html: `<div style="font-size:15px;transform:rotate(${heading}deg);transform-origin:center;
                         filter:drop-shadow(0 0 3px ${color});color:${color};line-height:1">✈</div>`,
      className: '',
      iconAnchor: [7, 7],
    });

    L.marker([a.lat, a.lon], { icon })
      .bindTooltip(`<strong>${label}</strong><br>${alt}${gs}`, { sticky: true, className: 'kanp-tip' })
      .addTo(aircraftLayer);
  });
}

// ---------------------------------------------------------------------------
// Rendering from stored data
// ---------------------------------------------------------------------------
function renderFromStorage() {
  const obs = allObs();
  renderGeoHeatmap(obs);
  renderTemporalHeatmap(obs);
  updateMeta(obs);
}

function renderGeoHeatmap(obs) {
  if (!heatLayer) return; // map unavailable
  const pts = [];
  obs.forEach(o => o.ac.forEach(a => {
    if (a.lat && a.lon && altInRange(normAlt(a.alt))) pts.push([a.lat, a.lon, 0.6]);
  }));
  heatLayer.setLatLngs(pts);
}

function renderTemporalHeatmap(obs) {
  const canvas = document.getElementById('temporal-canvas');
  const noHist = document.getElementById('no-history');

  if (!obs.length) {
    canvas.style.display = 'none';
    noHist.style.display = 'block';
    return;
  }
  noHist.style.display = 'none';
  canvas.style.display = 'block';

  const W = canvas.parentElement.clientWidth || 620;
  canvas.width  = W;
  canvas.height = 168;

  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, 168);

  const DAYS  = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const PAD_L = 38, PAD_T = 24, PAD_B = 30;
  const cellW = (W - PAD_L) / 24;
  const cellH = (canvas.height - PAD_T - PAD_B) / 7;

  // Build grid: [dayOfWeek 0=Mon][hour 0-23] = total aircraft seen
  const grid = Array.from({ length: 7 }, () => new Int32Array(24));
  obs.forEach(o => {
    const d   = new Date(o.ts);
    const dow = (d.getDay() + 6) % 7; // JS Sunday=0 → Mon=0
    const hr  = d.getHours();
    grid[dow][hr] += o.ac.length;
  });

  const maxVal = Math.max(1, ...grid.flatMap(row => Array.from(row)));

  // Cells
  for (let d = 0; d < 7; d++) {
    for (let h = 0; h < 24; h++) {
      const t = grid[d][h] / maxVal;
      ctx.fillStyle = heatColor(t);
      ctx.fillRect(
        PAD_L + h * cellW + 1,
        PAD_T + d * cellH + 1,
        cellW - 2,
        cellH - 2,
      );
    }
  }

  // Day labels
  ctx.fillStyle    = '#666';
  ctx.font         = `${Math.min(11, Math.floor(cellH * 0.65))}px sans-serif`;
  ctx.textAlign    = 'right';
  ctx.textBaseline = 'middle';
  DAYS.forEach((day, i) => {
    ctx.fillText(day, PAD_L - 4, PAD_T + i * cellH + cellH / 2);
  });

  // Hour labels (every 6 hours)
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'top';
  [0, 6, 12, 18].forEach(h => {
    const label = h === 0 ? '12a' : h < 12 ? `${h}a` : h === 12 ? '12p' : `${h - 12}p`;
    ctx.fillText(label, PAD_L + h * cellW + cellW / 2, PAD_T + 7 * cellH + 5);
  });
}

function heatColor(t) {
  if (t <= 0) return '#111';
  // navy → blue → cyan → yellow → red
  const stops = [
    [0.0,  [17,  17,  46]],
    [0.25, [0,   119, 182]],
    [0.5,  [0,   180, 216]],
    [0.75, [240, 192, 64]],
    [1.0,  [239, 68,  68]],
  ];
  for (let i = 1; i < stops.length; i++) {
    const [t0, c0] = stops[i - 1];
    const [t1, c1] = stops[i];
    if (t <= t1) {
      const u = (t - t0) / (t1 - t0);
      return `rgb(${Math.round(c0[0] + (c1[0] - c0[0]) * u)},${Math.round(c0[1] + (c1[1] - c0[1]) * u)},${Math.round(c0[2] + (c1[2] - c0[2]) * u)})`;
    }
  }
  return 'rgb(239,68,68)';
}

// ---------------------------------------------------------------------------
// Metadata display
// ---------------------------------------------------------------------------
function updateMeta(obs) {
  const total = obs.reduce((n, o) => n + o.ac.length, 0);
  document.getElementById('obs-label').textContent =
    total ? `${total.toLocaleString()} observations` : '';

  if (obs.length) {
    show('history-wrap');
    const days = ((Date.now() - obs[0].ts) / 86_400_000).toFixed(1);
    document.getElementById('history-span').textContent = `${days} days`;
  } else {
    document.getElementById('history-wrap').style.display = 'none';
  }
}

function clearHistory() {
  if (!confirm('Delete flight history stored in this browser? (Shared history is unaffected.)')) return;
  localStorage.removeItem(OBS_KEY);
  if (aircraftLayer) aircraftLayer.clearLayers();
  renderFromStorage();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function distNm(lat1, lon1, lat2, lon2) {
  const R = 3440.065; // Earth radius in nm
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function setStatus(color, text) {
  const dot = document.getElementById('status-dot');
  dot.className = `dot${color ? ' ' + color : ''}`;
  document.getElementById('status-text').textContent = text;
}

function show(id) {
  document.getElementById(id).style.display = '';
}
