// KANP Flight Tracker
// Live flight data via airplanes.live (free, no key required).
// History comes from two sources, merged at render time:
//   1. A shared snapshot file collected every 30 min by a GitHub Action
//      (pushed to the `traffic-data` branch of this repo).
//   2. Observations from this browser while the page is open (localStorage).

const KANP_LAT   = 38.9422;
const KANP_LON   = -76.5684;
const SEARCH_NM  = 20;             // nautical miles radius
const POLL_MS    = 60_000;         // poll interval
const MAX_AGE_MS = 30 * 86_400_000; // keep 30 days of history
const OBS_KEY    = 'kanp_obs';
const SHARED_URL = 'https://raw.githubusercontent.com/nuvig/nuvig.github.io/traffic-data/traffic.json';

let pollTimer = null;
let map, heatLayer, aircraftLayer;
let sharedObs = []; // snapshots collected server-side, fetched once per load

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

  heatLayer    = L.heatLayer([], { radius: 22, blur: 28, maxZoom: 13, gradient: { 0.1: '#0077b6', 0.4: '#00b4d8', 0.65: '#f0c040', 1.0: '#ef4444' } }).addTo(map);
  aircraftLayer = L.layerGroup().addTo(map);
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
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------
function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(fetchNow, POLL_MS);
  fetchNow();
}

async function fetchNow() {
  setStatus('yellow', 'Fetching…');

  try {
    const url = `https://api.airplanes.live/v2/point/${KANP_LAT}/${KANP_LON}/${SEARCH_NM}`;
    const res  = await fetch(url);

    if (res.status === 429) { setStatus('yellow', 'Rate limit — will retry'); return; }
    if (!res.ok) { setStatus('red', `API error ${res.status}`); return; }

    const data = await res.json();
    const ac   = (data.ac || []).filter(a => a.lat && a.lon);

    storeObs(ac);
    if (aircraftLayer) renderLiveAircraft(ac);
    renderFromStorage();

    setStatus('green', 'Live');
    show('ac-count-wrap');
    document.getElementById('ac-num').textContent = ac.length;
    show('update-wrap');
    document.getElementById('update-time').textContent = new Date().toLocaleTimeString();
  } catch (err) {
    setStatus('red', 'Network error');
    console.error('[KANP tracker]', err);
  }
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

    // Shared snapshots store aircraft as compact [lat, lon] pairs.
    sharedObs = raw
      .filter(o => o.ts > cutoff)
      .map(o => ({
        ts: o.ts,
        ac: o.ac.map(([lat, lon]) => ({ lat, lon })),
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
      cs:  (a.flight || '').trim(),
      alt: a.alt_baro,
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
  aircraftLayer.clearLayers();
  ac.forEach(a => {
    const heading = a.track ?? 0;
    const label   = esc((a.flight || '').trim() || a.hex || '?');
    const alt     = a.alt_baro != null ? `${Number(a.alt_baro).toLocaleString()} ft` : '— ft';
    const gs      = a.gs != null ? ` · ${Math.round(a.gs)} kts` : '';

    const icon = L.divIcon({
      html: `<div style="font-size:15px;transform:rotate(${heading}deg);transform-origin:center;
                         filter:drop-shadow(0 0 3px #39ff14);color:#39ff14;line-height:1">✈</div>`,
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
    if (a.lat && a.lon) pts.push([a.lat, a.lon, 0.6]);
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
