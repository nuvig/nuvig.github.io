// KANP Flight Tracker — shared utilities + Live tab
// Live data via airplanes.live; history/study via the Pi collector API (pi/).

const KANP = {
  LAT: 38.9422,
  LON: -76.5684,
  SEARCH_NM: 20,
  POLL_MS: 60_000,
  MAX_AGE_MS: 7 * 86_400_000,
  OBS_KEY: 'kanp_obs',
  API_KEY: 'kanp_api_base',
};

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  initTabs();
  initApiSettings();
  initLive();
  KANPHistory.init();
  KANPStudy.init();
});

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
function initTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(btn.dataset.tab).classList.add('active');
      // Leaflet needs a size refresh when its container becomes visible
      if (btn.dataset.tab === 'tab-history') KANPHistory.onShow();
      if (btn.dataset.tab === 'tab-live' && window._liveMap) window._liveMap.invalidateSize();
    });
  });
}

// ---------------------------------------------------------------------------
// Pi API base URL
// ---------------------------------------------------------------------------
KANP.apiBase = function () {
  const saved = localStorage.getItem(KANP.API_KEY);
  if (saved === 'none') return null; // force GitHub-snapshot mode
  if (saved) return saved.replace(/\/+$/, '');
  // Served from the Pi itself? Use same origin.
  if (location.protocol === 'http:' && location.port) return location.origin;
  return null;
};

// ---------------------------------------------------------------------------
// Data routing: Pi API when reachable, GitHub hourly snapshots otherwise
// ---------------------------------------------------------------------------
KANP.getTracks = async function (params) {
  if (KANP.apiBase()) {
    try {
      const d = await KANP.apiFetch('/api/tracks', params);
      d._source = 'pi';
      return d;
    } catch (e) {
      console.warn('[KANP] Pi API unreachable, falling back to snapshots:', e.message);
    }
  }
  const d = await KANPStatic.getTracks(params);
  d._source = 'github';
  return d;
};

KANP.getStats = async function (params) {
  if (KANP.apiBase()) {
    try {
      const d = await KANP.apiFetch('/api/stats', params);
      d._source = 'pi';
      return d;
    } catch (e) {
      console.warn('[KANP] Pi API unreachable, falling back to snapshots:', e.message);
    }
  }
  const d = await KANPStatic.getStats(params);
  d._source = 'github';
  return d;
};

KANP.sourceLabel = function (d) {
  if (d._source === 'pi') return 'via Pi database';
  const age = d.snapshot_generated
    ? ` · snapshot ${Math.max(0, Math.round((Date.now() / 1000 - d.snapshot_generated) / 60))} min old`
    : '';
  return `via GitHub snapshot${age}`;
};

KANP.apiFetch = async function (path, params) {
  const base = KANP.apiBase();
  if (!base) throw new Error('No Pi API configured — set it under Data Source below');
  const url = new URL(base + path);
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
};

function initApiSettings() {
  const input = document.getElementById('api-base');
  const status = document.getElementById('api-status');
  input.value = localStorage.getItem(KANP.API_KEY) || '';
  if (!input.value && KANP.apiBase()) input.placeholder = `auto: ${KANP.apiBase()}`;

  document.getElementById('api-save').addEventListener('click', async () => {
    const val = input.value.trim().replace(/\/+$/, '');
    if (val) localStorage.setItem(KANP.API_KEY, val);
    else localStorage.removeItem(KANP.API_KEY);
    status.textContent = 'testing…';
    try {
      const s = await KANP.apiFetch('/api/status', {});
      status.textContent = `✓ connected — ${Number(s.positions).toLocaleString()} positions stored`;
      status.style.color = '#22c55e';
      updateCollectorBadge(s);
    } catch (e) {
      status.textContent = `✗ ${e.message}`;
      status.style.color = '#ef4444';
    }
  });

  document.getElementById('clear-data-btn').addEventListener('click', clearHistory);

  // quiet auto-check on load
  if (KANP.apiBase()) {
    KANP.apiFetch('/api/status', {}).then(updateCollectorBadge).catch(() => {});
  }
}

function updateCollectorBadge(s) {
  const wrap = document.getElementById('collector-wrap');
  const txt = document.getElementById('collector-text');
  if (!s || s.positions == null) return;
  const mb = s.db_bytes ? ` · ${(s.db_bytes / 1e6).toFixed(0)} MB` : '';
  const age = s.newest ? Math.round((Date.now() / 1000 - s.newest) / 60) : null;
  const fresh = age == null ? '' : age < 5 ? ' · live' : ` · last data ${age} min ago`;
  txt.textContent = `${Number(s.positions).toLocaleString()} positions${mb}${fresh}`;
  wrap.style.display = '';
}

// ---------------------------------------------------------------------------
// Shared: filter bar → API params
// ---------------------------------------------------------------------------
KANP.initFilterBar = function (barId) {
  const bar = document.getElementById(barId);

  bar.querySelectorAll('.dow-btn').forEach(b =>
    b.addEventListener('click', () => b.classList.toggle('on')));

  const quick = bar.querySelector('[data-f=quick]');
  const start = bar.querySelector('[data-f=start]');
  const end = bar.querySelector('[data-f=end]');

  const applyQuick = () => {
    const v = quick.value;
    if (!v) return;
    const now = new Date();
    let s, e = now;
    if (v === 'today') {
      s = new Date(now); s.setHours(0, 0, 0, 0);
    } else if (v === 'yesterday') {
      e = new Date(now); e.setHours(0, 0, 0, 0);
      s = new Date(e.getTime() - 86_400_000);
    } else {
      s = new Date(now.getTime() - Number(v) * 1000);
    }
    start.value = toLocalInput(s);
    end.value = toLocalInput(e);
  };
  quick.addEventListener('change', applyQuick);
  [start, end].forEach(el => el.addEventListener('input', () => { quick.value = ''; }));
  applyQuick();
};

KANP.readFilters = function (barId) {
  const bar = document.getElementById(barId);
  const get = f => bar.querySelector(`[data-f=${f}]`);

  // re-apply quick range so "last 24 h" means 24 h before *now*, not page load
  const quick = get('quick');
  if (quick.value) {
    quick.dispatchEvent(new Event('change'));
  }

  const p = {};
  const sv = get('start').value, ev = get('end').value;
  if (sv) p.start = Math.floor(new Date(sv).getTime() / 1000);
  if (ev) p.end = Math.floor(new Date(ev).getTime() / 1000);
  if (get('min_alt').value !== '') p.min_alt = get('min_alt').value;
  if (get('max_alt').value !== '') p.max_alt = get('max_alt').value;
  p.ground = get('ground').value;
  if (get('callsign').value.trim()) p.callsign = get('callsign').value.trim();
  if (get('hours') && get('hours').value.trim()) p.hours = get('hours').value.trim();
  if (get('military').checked) p.military = 1;
  if (get('ga') && get('ga').checked) p.ga = 1;

  const dowBtns = [...bar.querySelectorAll('.dow-btn')];
  const on = dowBtns.map((b, i) => b.classList.contains('on') ? i : -1).filter(i => i >= 0);
  if (on.length > 0 && on.length < 7) p.dow = on.join(',');

  return p;
};

function toLocalInput(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ---------------------------------------------------------------------------
// Shared: "general aviation" classifier for the GA-only filter.
// GA = everything that isn't a scheduled airliner, regional carrier, large
// transport, or military — so light pistons, twins, turboprops, business
// jets, helicopters, and untyped/experimental aircraft all count. Works from
// the ICAO type designator + military flag, the only identity fields present
// in both the Pi database and the GitHub snapshots. NOTE: the airliner set is
// mirrored in pi/server.py (build_filters) — keep the two in sync.
KANP.AIRLINER_TYPES = new Set([
  // Airbus neo / Boeing MAX (non A3../B7.. designators)
  'A19N', 'A20N', 'A21N', 'B37M', 'B38M', 'B39M', 'B3XM',
  // regional jets
  'CRJ1', 'CRJ2', 'CRJ7', 'CRJ9', 'CRJX', 'BCS1', 'BCS3',
  'E135', 'E145', 'E170', 'E75L', 'E75S', 'E190', 'E195', 'E290', 'E295',
  'RJ1H', 'RJ85', 'RJ70', 'B461', 'B462', 'B463', 'F70', 'F100',
  // regional turboprops
  'AT43', 'AT44', 'AT45', 'AT46', 'AT72', 'AT73', 'AT75', 'AT76',
  'DH8A', 'DH8B', 'DH8C', 'DH8D', 'SF34', 'SB20', 'D328', 'J328',
  // older / large transports
  'MD11', 'MD81', 'MD82', 'MD83', 'MD87', 'MD88', 'MD90', 'DC10', 'DC93', 'DC94',
]);

KANP.isGA = function (t) {
  if (!t || t.military) return false;
  const type = (t.type || '').toUpperCase().trim();
  if (!type) return true;                              // untyped → assume light GA
  if (/^A3..$/.test(type) || /^B7..$/.test(type)) return false;  // Airbus/Boeing airliner families
  return !KANP.AIRLINER_TYPES.has(type);
};

// ---------------------------------------------------------------------------
// Shared: tar1090-style altitude color (dump1090-fa ColorByAlt)
// ---------------------------------------------------------------------------
KANP.altColor = function (alt, onGround) {
  if (onGround) return 'hsl(120,100%,30%)';
  if (alt == null) return 'hsl(0,0%,40%)';
  // hue: 2000 ft → 20, 10000 ft → 140, 40000 ft → 300
  let h;
  if (alt <= 2000) h = 20;
  else if (alt <= 10000) h = 20 + (alt - 2000) / 8000 * 120;
  else if (alt <= 40000) h = 140 + (alt - 10000) / 30000 * 160;
  else h = 300;
  return `hsl(${Math.round(h)},85%,50%)`;
};

// ---------------------------------------------------------------------------
// Shared: 7×24 heat grid renderer (used by Live session + Traffic Study)
// ---------------------------------------------------------------------------
KANP.renderGrid = function (canvas, grid) {
  const W = canvas.parentElement.clientWidth || 620;
  const H = 168;
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);

  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const PAD_L = 38, PAD_T = 10, PAD_B = 26;
  const cellW = (W - PAD_L) / 24;
  const cellH = (H - PAD_T - PAD_B) / 7;
  const maxVal = Math.max(1, ...grid.flat());

  for (let d = 0; d < 7; d++) {
    for (let h = 0; h < 24; h++) {
      ctx.fillStyle = heatColor(grid[d][h] / maxVal);
      ctx.fillRect(PAD_L + h * cellW + 1, PAD_T + d * cellH + 1, cellW - 2, cellH - 2);
    }
  }

  ctx.fillStyle = '#666';
  ctx.font = `${Math.min(11, Math.floor(cellH * 0.65))}px sans-serif`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  DAYS.forEach((day, i) => ctx.fillText(day, PAD_L - 4, PAD_T + i * cellH + cellH / 2));

  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  [0, 6, 12, 18].forEach(h => {
    const label = h === 0 ? '12a' : h < 12 ? `${h}a` : h === 12 ? '12p' : `${h - 12}p`;
    ctx.fillText(label, PAD_L + h * cellW + cellW / 2, PAD_T + 7 * cellH + 5);
  });
};

function heatColor(t) {
  if (t <= 0) return '#111';
  const stops = [
    [0.0, [17, 17, 46]], [0.25, [0, 119, 182]], [0.5, [0, 180, 216]],
    [0.75, [240, 192, 64]], [1.0, [239, 68, 68]],
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
// Shared: base + overlay layers (Live and History maps)
// ---------------------------------------------------------------------------
KANP.baseLayers = function () {
  return {
    'Dark': L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
      subdomains: 'abcd', maxZoom: 19,
    }),
    'Streets': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>', maxZoom: 19,
    }),
    'Satellite': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      attribution: '&copy; Esri', maxZoom: 19,
    }),
  };
};

KANP.overlayLayers = function () {
  return {
    'VFR Sectional': L.tileLayer(
      'https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/VFR_Sectional/MapServer/tile/{z}/{y}/{x}', {
        attribution: 'FAA', opacity: 0.75,
        minNativeZoom: 8, maxNativeZoom: 12, maxZoom: 19,
      }),
    'VFR Terminal (TAC)': L.tileLayer(
      'https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/VFR_Terminal/MapServer/tile/{z}/{y}/{x}', {
        attribution: 'FAA', opacity: 0.8,
        minNativeZoom: 10, maxNativeZoom: 12, maxZoom: 19,
      }),
    'Weather (NEXRAD)': L.tileLayer(
      'https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/{z}/{x}/{y}.png', {
        attribution: 'IEM NEXRAD', opacity: 0.55, maxZoom: 19,
      }),
  };
};

KANP.addAirport = function (map) {
  L.marker([KANP.LAT, KANP.LON], {
    icon: L.divIcon({
      html: '<div style="font-size:22px;line-height:1;filter:drop-shadow(0 0 4px #fff)">✈</div>',
      className: '', iconAnchor: [11, 11],
    }),
    interactive: false,
  }).addTo(map).bindTooltip('KANP — Lee Airport');

  [5, 10, 20].forEach(nm => L.circle([KANP.LAT, KANP.LON], {
    radius: nm * 1852, color: '#444', weight: 1, fill: false, interactive: false,
  }).addTo(map));
};

// ===========================================================================
// LIVE TAB (airplanes.live from the browser, session history in localStorage)
// ===========================================================================
let liveMap, heatLayer, aircraftLayer, pollTimer;

function initLive() {
  liveMap = L.map('map', { layers: [] }).setView([KANP.LAT, KANP.LON], 11);
  window._liveMap = liveMap;

  const bases = KANP.baseLayers();
  const overlays = KANP.overlayLayers();
  bases['Dark'].addTo(liveMap);
  L.control.layers(bases, overlays, { position: 'topright' }).addTo(liveMap);

  KANP.addAirport(liveMap);

  heatLayer = L.heatLayer([], {
    radius: 22, blur: 28, maxZoom: 13,
    gradient: { 0.1: '#0077b6', 0.4: '#00b4d8', 0.65: '#f0c040', 1.0: '#ef4444' },
  }).addTo(liveMap);
  aircraftLayer = L.layerGroup().addTo(liveMap);

  const ro = new ResizeObserver(() => renderTemporalHeatmap(getObs()));
  ro.observe(document.getElementById('temporal-canvas').parentElement);

  renderFromStorage();
  pollTimer = setInterval(fetchNow, KANP.POLL_MS);
  fetchNow();
}

async function fetchNow() {
  setStatus('yellow', 'Fetching…');
  try {
    const url = `https://api.airplanes.live/v2/point/${KANP.LAT}/${KANP.LON}/${KANP.SEARCH_NM}`;
    const res = await fetch(url);
    if (res.status === 429) { setStatus('yellow', 'Rate limit — will retry'); return; }
    if (!res.ok) { setStatus('red', `API error ${res.status}`); return; }

    const data = await res.json();
    const ac = (data.ac || []).filter(a => a.lat && a.lon);

    storeObs(ac);
    renderLiveAircraft(ac);
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

function getObs() {
  try { return JSON.parse(localStorage.getItem(KANP.OBS_KEY) || '[]'); }
  catch { return []; }
}

function storeObs(ac) {
  const now = Date.now();
  const obs = getObs();
  obs.push({
    ts: now,
    ac: ac.map(a => ({
      lat: a.lat, lon: a.lon, hex: a.hex,
      cs: (a.flight || '').trim(),
      alt: a.alt_baro, gs: a.gs, trk: a.track,
    })),
  });
  const pruned = obs.filter(o => o.ts > now - KANP.MAX_AGE_MS);
  try {
    localStorage.setItem(KANP.OBS_KEY, JSON.stringify(pruned));
  } catch {
    const trimmed = pruned.slice(Math.floor(pruned.length * 0.25));
    try { localStorage.setItem(KANP.OBS_KEY, JSON.stringify(trimmed)); } catch { /* give up */ }
  }
}

function renderLiveAircraft(ac) {
  aircraftLayer.clearLayers();
  ac.forEach(a => {
    const heading = a.track ?? 0;
    const label = (a.flight || '').trim() || a.hex || '?';
    const onGround = a.alt_baro === 'ground';
    const altN = typeof a.alt_baro === 'number' ? a.alt_baro : null;
    const alt = onGround ? 'ground' : altN != null ? `${altN.toLocaleString()} ft` : '— ft';
    const gs = a.gs != null ? ` · ${Math.round(a.gs)} kts` : '';
    const color = KANP.altColor(altN, onGround);

    const icon = L.divIcon({
      html: `<div style="font-size:15px;transform:rotate(${heading}deg);transform-origin:center;
                         filter:drop-shadow(0 0 3px ${color});color:${color};line-height:1">✈</div>`,
      className: '', iconAnchor: [7, 7],
    });

    L.marker([a.lat, a.lon], { icon })
      .bindTooltip(`<strong>${label}</strong><br>${alt}${gs}`, { sticky: true, className: 'kanp-tip' })
      .addTo(aircraftLayer);
  });
}

function renderFromStorage() {
  const obs = getObs();
  const pts = [];
  obs.forEach(o => o.ac.forEach(a => { if (a.lat && a.lon) pts.push([a.lat, a.lon, 0.6]); }));
  heatLayer.setLatLngs(pts);
  renderTemporalHeatmap(obs);

  const total = obs.reduce((n, o) => n + o.ac.length, 0);
  document.getElementById('obs-label').textContent =
    total ? `${total.toLocaleString()} observations this session` : '';
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

  const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
  obs.forEach(o => {
    const d = new Date(o.ts);
    grid[(d.getDay() + 6) % 7][d.getHours()] += o.ac.length;
  });
  KANP.renderGrid(canvas, grid);
}

function clearHistory() {
  if (!confirm('Delete flight history stored in this browser? (Pi database is not affected.)')) return;
  localStorage.removeItem(KANP.OBS_KEY);
  aircraftLayer.clearLayers();
  renderFromStorage();
}

function setStatus(color, text) {
  const dot = document.getElementById('status-dot');
  dot.className = `dot${color ? ' ' + color : ''}`;
  document.getElementById('status-text').textContent = text;
}

function show(id) {
  document.getElementById(id).style.display = '';
}
