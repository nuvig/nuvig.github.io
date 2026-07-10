// KANP Flight Tracker — shared utilities + Live tab
// All tabs read the Pi collector (pi/): its API on the home network, else the
// hourly GitHub snapshots. Live = the most recently collected fix.

const KANP = {
  LAT: 38.9422,
  LON: -76.5684,
  SEARCH_NM: 60,          // study/display radius around the field, nm
  POLL_MS: 60_000,        // snapshot mode: the GitHub data only changes hourly
  PI_POLL_MS: 3_000,      // Pi API mode: the collector samples every 3 s
  MAX_AGE_MS: 7 * 86_400_000,
  OBS_KEY: 'kanp_obs',
  API_KEY: 'kanp_api_base',
};

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  // Each tab boots independently: one failing must not kill the others
  // (e.g. leaflet-heat throws on a zero-width map container when the page
  // loads in a hidden/background pane).
  [initTabs, initApiSettings, initLive,
   () => KANPHistory.init(), () => KANPStudy.init()].forEach(step => {
    try { step(); } catch (e) { console.error('[KANP] init step failed:', e); }
  });
});

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
function initTabs() {
  const activate = (btn, updateHash) => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(btn.dataset.tab).classList.add('active');
    if (updateHash) {
      // shareable / refresh-stable tab (replaceState: no history spam)
      history.replaceState(null, '', '#' + btn.dataset.tab.replace('tab-', ''));
    }
    // A hidden panel has no layout box, so anything sized from its width was
    // drawn at the fallback width. Re-measure now that the panel is visible.
    if (btn.dataset.tab === 'tab-history') KANPHistory.onShow();
    if (btn.dataset.tab === 'tab-live') {
      if (window._liveMap) window._liveMap.invalidateSize();
      renderTemporalGrid();
    }
  };

  document.querySelectorAll('.tab-btn').forEach(btn =>
    btn.addEventListener('click', () => activate(btn, true)));

  // restore tab from URL hash (#live / #history / #study); runs before the
  // per-tab init steps, so their "am I the active tab?" checks see the result
  const fromHash = document.querySelector(
    `.tab-btn[data-tab="tab-${location.hash.slice(1)}"]`);
  if (fromHash && !fromHash.classList.contains('active')) activate(fromHash, false);
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
  if (!base) throw new Error('No Pi API configured');
  const url = new URL(base + path);
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
};

// The Data Source panel is gone; the Pi API is still auto-detected (same
// origin when served from the Pi) or set manually via
// localStorage.setItem('kanp_api_base', url) in the console.
function initApiSettings() {
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

  KANP.initAltSlider(bar);
};

// Dual-thumb altitude slider that stays in sync with the min_alt / max_alt
// number inputs (readFilters still reads those, so nothing downstream changes).
// Bottom of range (0) means "no floor"; top (40k) means "no ceiling" — both
// map to an empty number input so the filter is unbounded on that end.
KANP.initAltSlider = function (bar) {
  const wrap = bar.querySelector('.dual-range');
  if (!wrap) return;
  const sMin = wrap.querySelector('.alt-min');
  const sMax = wrap.querySelector('.alt-max');
  const fill = wrap.querySelector('.fill');
  const val = bar.querySelector('.alt-range-val');
  const nMin = bar.querySelector('[data-f=min_alt]');
  const nMax = bar.querySelector('[data-f=max_alt]');
  const MAX = +sMax.max;
  const clamp = v => Math.max(0, Math.min(MAX, v));

  const paint = () => {
    const lo = +sMin.value, hi = +sMax.value;
    fill.style.left = `${lo / MAX * 100}%`;
    fill.style.width = `${(hi - lo) / MAX * 100}%`;
    val.textContent = `${lo === 0 ? '0' : lo.toLocaleString()} – ` +
      `${hi >= MAX ? '∞' : hi.toLocaleString()} ft`;
  };

  // slider drag → number inputs
  const fromSlider = mover => {
    let lo = +sMin.value, hi = +sMax.value;
    if (lo > hi) {                       // don't let thumbs cross
      if (mover === sMin) sMax.value = hi = lo;
      else sMin.value = lo = hi;
    }
    nMin.value = lo === 0 ? '' : lo;
    nMax.value = hi >= MAX ? '' : hi;
    paint();
  };
  sMin.addEventListener('input', () => fromSlider(sMin));
  sMax.addEventListener('input', () => fromSlider(sMax));

  // typed number → slider (leave the typed value alone; just reflect it)
  const fromNumber = () => {
    const lo = nMin.value === '' ? 0 : clamp(+nMin.value);
    const hi = nMax.value === '' ? MAX : clamp(+nMax.value);
    sMin.value = Math.min(lo, hi);
    sMax.value = Math.max(lo, hi);
    paint();
  };
  nMin.addEventListener('input', fromNumber);
  nMax.addEventListener('input', fromNumber);

  // scroll wheel over the slider shifts the whole band up/down — "x-raying"
  // the airspace one step per notch. Dispatching 'input' on the thumbs keeps
  // the number inputs in sync and fires any live-reload listeners.
  wrap.addEventListener('wheel', e => {
    e.preventDefault();
    const step = +sMin.step * (e.deltaY < 0 ? 1 : -1);   // wheel up = higher
    const lo = +sMin.value, hi = +sMax.value;
    const shift = Math.max(-lo, Math.min(MAX - hi, step)); // stop at the edges
    if (!shift) return;
    sMin.value = lo + shift;
    sMax.value = hi + shift;
    sMax.dispatchEvent(new Event('input', { bubbles: true }));
  }, { passive: false });

  fromNumber();   // initialise thumbs + fill from any preset number values
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
  // Controls are read defensively: the History bar omits some of these
  // (altitude / GA / military are applied client-side there for instant
  // filtering), so any missing control is simply skipped.
  const val = f => { const el = get(f); return el ? el.value : null; };
  const sv = val('start'), ev = val('end');
  if (sv) p.start = Math.floor(new Date(sv).getTime() / 1000);
  if (ev) p.end = Math.floor(new Date(ev).getTime() / 1000);
  if (val('min_alt') != null && val('min_alt') !== '') p.min_alt = val('min_alt');
  if (val('max_alt') != null && val('max_alt') !== '') p.max_alt = val('max_alt');
  if (val('ground') != null) p.ground = val('ground');
  if (val('callsign') && val('callsign').trim()) p.callsign = val('callsign').trim();
  if (val('hours') && val('hours').trim()) p.hours = val('hours').trim();
  if (get('military') && get('military').checked) p.military = 1;
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
// Shared: arrival / departure classifier for a single track's points.
// "At the field" = within NEAR_NM horizontally and low (on ground, or at/below
// LOW_FT MSL). A track that begins at the field and ends away from it is a
// departure; one that begins away and ends at the field is an arrival. Local
// pattern work (both ends at the field) and overflights (neither) are neither.
// Point tuple is [ts, lat, lon, alt, gs, on_ground], as returned by getTracks.
KANP.FIELD = { NEAR_NM: 2.0, LOW_FT: 1500 };

KANP.distNm = function (lat, lon) {
  const R = 3440.065, r = Math.PI / 180;
  const dLat = (lat - KANP.LAT) * r, dLon = (lon - KANP.LON) * r;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(KANP.LAT * r) * Math.cos(lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
};

KANP.classifyArrDep = function (points) {
  const n = points ? points.length : 0;
  if (n < 2) return { arrival: false, departure: false };
  const atField = p => p[1] != null && p[2] != null &&
    (p[5] === 1 || (p[3] != null && p[3] <= KANP.FIELD.LOW_FT)) &&
    KANP.distNm(p[1], p[2]) <= KANP.FIELD.NEAR_NM;
  const k = Math.max(1, Math.ceil(n * 0.2));   // examine each end of the track
  let startAt = false, endAt = false;
  for (let i = 0; i < k; i++) if (atField(points[i])) { startAt = true; break; }
  for (let i = 0; i < k; i++) if (atField(points[n - 1 - i])) { endAt = true; break; }
  return { departure: startAt && !endAt, arrival: endAt && !startAt };
};

// ---------------------------------------------------------------------------
// Shared: runway geometry. KANP has a single strip, 12/30. The true axis was
// fitted from ~2 weeks of collected ground/low-altitude ADS-B segments within
// 1 nm of the field (principal course axis): 107° / 287° true, consistent
// with the charted 120/300 magnetic minus ~11°W variation.
// ---------------------------------------------------------------------------
KANP.RWY = {
  axisTrue: 107,            // landing direction on RWY 12, degrees true
  names: ['12', '30'],      // names[0] = axisTrue direction, names[1] = reciprocal
};

// "At the field" gates shared by the operations detector (kanp-ops.js) and
// the Lee-traffic filter: tighter than the arrival/departure classifier above
// because KANP pattern altitude (~1,000 ft MSL, ~1 nm out) must NOT count as
// a field contact — only short final, the runway, and initial upwind do.
KANP.OPS_GATES = { NEAR_NM: 0.8, LOW_FT: 600 };

// Did this track ever touch the field? True for arrivals, departures and
// pattern work alike — the test the "Lee traffic" filter uses.
KANP.fieldContact = function (points) {
  const g = KANP.OPS_GATES;
  for (const p of points || []) {
    if ((p[5] === 1 || (p[3] != null && p[3] <= g.LOW_FT)) &&
        KANP.distNm(p[1], p[2]) <= g.NEAR_NM) return true;
  }
  return false;
};

// Douglas-Peucker track simplification (mirror of pi/trackutil.py). Drops only
// points that don't change a track's shape, so turns stay crisp — used
// client-side purely to keep very large multi-day snapshot ranges drawable
// (the exporter/API already simplify what they serve). Point: [ts,lat,lon,alt,gs,og].
KANP.simplifyTrack = function (pts, epsNm) {
  const n = pts.length;
  if (n <= 2 || epsNm <= 0) return pts;
  const NM_DEG = 60, GAP = 300, BUCKET = 500;
  const cosLat = Math.cos(pts[0][1] * Math.PI / 180);
  const colour = p => (p[5] ? 'g' : p[3] == null ? 'u' : Math.floor(p[3] / BUCKET));
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const rdp = (lo, hi) => {
    const stack = [[lo, hi]];
    while (stack.length) {
      const [a, b] = stack.pop();
      if (b <= a + 1) continue;
      const ax = pts[a][2] * cosLat, ay = pts[a][1];
      const bx = pts[b][2] * cosLat, by = pts[b][1];
      const dx = bx - ax, dy = by - ay, seg2 = dx * dx + dy * dy;
      let dmax = -1, idx = -1;
      for (let k = a + 1; k < b; k++) {
        const px = pts[k][2] * cosLat, py = pts[k][1];
        let d;
        if (seg2 === 0) d = Math.hypot(px - ax, py - ay);
        else {
          let t = ((px - ax) * dx + (py - ay) * dy) / seg2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
        }
        if (d > dmax) { dmax = d; idx = k; }
      }
      if (idx >= 0 && dmax * NM_DEG > epsNm) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
    }
  };
  let segStart = 0, prev = colour(pts[0]);
  for (let i = 1; i < n; i++) {
    const c = colour(pts[i]);
    if (c !== prev) { keep[i] = 1; keep[i - 1] = 1; prev = c; }
    if (pts[i][0] - pts[i - 1][0] > GAP) { keep[i - 1] = 1; keep[i] = 1; rdp(segStart, i - 1); segStart = i; }
  }
  rdp(segStart, n - 1);
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i]);
  return out;
};

// ---------------------------------------------------------------------------
// Shared: size a chart canvas for the device pixel ratio so text and bars
// stay crisp on HiDPI / scaled displays. Returns a ctx pre-scaled so all
// drawing code keeps working in CSS-pixel coordinates.
// ---------------------------------------------------------------------------
// Usable width inside an element: clientWidth still counts padding, so a
// canvas sized from it overflows the card it lives in.
KANP.contentWidth = function (el) {
  const cs = getComputedStyle(el);
  const w = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  return w > 0 ? w : 620;
};

KANP.setupCanvas = function (canvas, W, H) {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  return ctx;
};

// ---------------------------------------------------------------------------
// Shared: simple canvas bar chart (Traffic Study + Operations sections)
// ---------------------------------------------------------------------------
KANP.drawBars = function (canvas, labels, values, opts = {}) {
  const W = KANP.contentWidth(canvas.parentElement);
  const H = opts.height || 160;
  const ctx = KANP.setupCanvas(canvas, W, H);

  // values: number[] (plain bars) or number[][] (stacked series per bar)
  const stacked = Array.isArray(values[0]);
  const totals = stacked ? values.map(v => v.reduce((a, b) => a + b, 0)) : values;

  if (!totals.length || !totals.some(v => v > 0)) {
    ctx.fillStyle = '#444';
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('no data in range', W / 2, H / 2);
    return;
  }

  const PAD_L = 44, PAD_B = 22, PAD_T = 8;
  const plotW = W - PAD_L - 6;
  const plotH = H - PAD_T - PAD_B;
  const maxV = Math.max(1, ...totals);
  const bw = plotW / totals.length;

  // y grid + labels
  ctx.strokeStyle = '#2a2a2a';
  ctx.fillStyle = '#666';
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= 4; i++) {
    const v = maxV * i / 4;
    const y = PAD_T + plotH - plotH * i / 4;
    ctx.beginPath();
    ctx.moveTo(PAD_L, y);
    ctx.lineTo(W - 6, y);
    ctx.stroke();
    ctx.fillText(Math.round(v).toLocaleString(), PAD_L - 5, y);
  }

  // bars
  for (let i = 0; i < totals.length; i++) {
    const x = PAD_L + i * bw + 1, w = Math.max(1, bw - 2);
    if (stacked) {
      let y = PAD_T + plotH;
      values[i].forEach((v, s) => {
        const h = plotH * v / maxV;
        const colors = opts.stackColors || ['#4a9eff', '#22c55e', '#f0c040'];
        ctx.fillStyle = colors[s % colors.length];
        ctx.fillRect(x, y - h, w, h);
        y -= h;
      });
    } else {
      const h = plotH * totals[i] / maxV;
      ctx.fillStyle = opts.color ? opts.color(i) : '#4a9eff';
      ctx.fillRect(x, PAD_T + plotH - h, w, h);
    }
  }

  // x labels (sparse)
  const every = Math.ceil(labels.length / (opts.maxTicks || 12));
  ctx.fillStyle = '#666';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let i = 0; i < labels.length; i += every) {
    ctx.fillText(String(labels[i]), PAD_L + i * bw + bw / 2, PAD_T + plotH + 5);
  }
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
// Shared: 7×24 heat grid renderer (Live all-time, History week, Study, GA ops)
// opts.unit names what a cell counts, for the hover tooltip ("aircraft", "ops").
// ---------------------------------------------------------------------------
KANP.renderGrid = function (canvas, grid, opts = {}) {
  const W = KANP.contentWidth(canvas.parentElement);
  const H = 168;
  const ctx = KANP.setupCanvas(canvas, W, H);

  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const PAD_L = 38, PAD_T = 10, PAD_B = 26;
  const cellW = (W - PAD_L) / 24;
  const cellH = (H - PAD_T - PAD_B) / 7;
  const maxVal = Math.max(1, ...grid.flat());

  attachGridHover(canvas, { grid, PAD_L, PAD_T, cellW, cellH,
                            unit: opts.unit || 'aircraft' });

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

// Hover a heat-grid cell → floating tooltip with the day, hour and value.
// The geometry is re-stashed on every render (the grid resizes with the card),
// but the listeners are bound only once per canvas.
const DAYS_FULL = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday',
                   'Saturday', 'Sunday'];

function gridTip() {
  let el = document.getElementById('kanp-grid-tip');
  if (!el) {
    el = document.createElement('div');
    el.id = 'kanp-grid-tip';
    el.className = 'grid-tip';
    document.body.appendChild(el);
  }
  return el;
}

function attachGridHover(canvas, geom) {
  canvas._grid = geom;
  if (canvas._gridHoverBound) return;
  canvas._gridHoverBound = true;
  canvas.style.cursor = 'crosshair';

  canvas.addEventListener('mousemove', e => {
    const g = canvas._grid;
    const h = Math.floor((e.offsetX - g.PAD_L) / g.cellW);
    const d = Math.floor((e.offsetY - g.PAD_T) / g.cellH);
    if (h < 0 || h > 23 || d < 0 || d > 6) return hideGridTip();

    const v = g.grid[d][h];
    const hr = n => n === 0 ? '12am' : n < 12 ? `${n}am` : n === 12 ? '12pm' : `${n - 12}pm`;
    const tip = gridTip();
    tip.innerHTML =
      `<strong>${DAYS_FULL[d]} ${hr(h)}–${hr((h + 1) % 24)}</strong><br>` +
      `${v.toLocaleString()} ${g.unit}`;
    tip.style.display = 'block';
    // keep the tooltip on-screen near the pointer
    const r = tip.getBoundingClientRect();
    const x = Math.min(e.clientX + 12, window.innerWidth - r.width - 6);
    const y = Math.max(6, e.clientY - r.height - 10);
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
  });
  canvas.addEventListener('mouseleave', hideGridTip);
}

function hideGridTip() {
  const el = document.getElementById('kanp-grid-tip');
  if (el) el.style.display = 'none';
}

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
    // FAA publishes IFR enroute as IFR_AreaLow (low altitude) and IFR_High.
    // Native zoom ranges verified against the tile service — outside them the
    // server 404s, so let Leaflet upscale instead of requesting missing tiles.
    'IFR Enroute Low': L.tileLayer(
      'https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/IFR_AreaLow/MapServer/tile/{z}/{y}/{x}', {
        attribution: 'FAA', opacity: 0.8,
        minNativeZoom: 7, maxNativeZoom: 12, maxZoom: 19,
      }),
    'IFR Enroute High': L.tileLayer(
      'https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/IFR_High/MapServer/tile/{z}/{y}/{x}', {
        attribution: 'FAA', opacity: 0.8,
        minNativeZoom: 5, maxNativeZoom: 9, maxZoom: 19,
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

  [15, 30, 60].forEach(nm => L.circle([KANP.LAT, KANP.LON], {
    radius: nm * 1852, color: '#444', weight: 1, fill: false, interactive: false,
  }).addTo(map));
};

// ===========================================================================
// LIVE TAB — latest positions from the Pi collector
// ===========================================================================
// Reads the same source as History (the Pi API on the home network, else the
// hourly GitHub snapshot). The browser no longer calls a third-party ADS-B API
// directly — those dropped CORS — so "live" is the most recently collected fix,
// shown with a freshness label. Session heat/temporal history stays in
// localStorage as before.
const LIVE_WINDOW_S = 3600;   // pull the last hour of tracks
const RECENT_S = 300;         // "current" = last fix within 5 min of the newest fix

let liveMap, heatLayer, aircraftLayer, pollTimer;

function initLive() {
  liveMap = L.map('map', { layers: [] }).setView([KANP.LAT, KANP.LON], 8);
  window._liveMap = liveMap;

  const bases = KANP.baseLayers();
  const overlays = KANP.overlayLayers();
  bases['Dark'].addTo(liveMap);
  L.control.layers(bases, overlays, { position: 'topright' }).addTo(liveMap);

  KANP.addAirport(liveMap);

  // deliberately subtle: the heat is background texture, not the main event
  heatLayer = L.heatLayer([], {
    radius: 14, blur: 18, maxZoom: 13, minOpacity: 0.05,
    gradient: { 0.1: '#0077b6', 0.4: '#00b4d8', 0.65: '#f0c040', 1.0: '#ef4444' },
  });
  try {
    heatLayer.addTo(liveMap);
  } catch (e) {
    // zero-width container: leaflet-heat can't draw yet — attach once the
    // map first gets real dimensions (invalidateSize fires 'resize')
    liveMap.once('resize', () => {
      try { heatLayer.addTo(liveMap); renderFromStorage(); } catch { /* still hidden */ }
    });
  }
  aircraftLayer = L.layerGroup().addTo(liveMap);

  const ro = new ResizeObserver(() => renderTemporalGrid());
  ro.observe(document.getElementById('temporal-canvas').parentElement);

  renderFromStorage();
  loadAllTimeGrid();
  // Poll fast only when the Pi API is answering — hammering the hourly
  // GitHub snapshots (or a dead network) every few seconds buys nothing.
  const poll = async () => {
    const source = await fetchNow();
    if (document.hidden) { pollTimer = null; return; }  // resumes on visibilitychange
    pollTimer = setTimeout(poll, source === 'pi' ? KANP.PI_POLL_MS : KANP.POLL_MS);
  };
  poll();

  // don't poll while the page sits in a background tab; catch up on return
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      clearTimeout(pollTimer);
      pollTimer = null;
    } else if (!pollTimer) {
      poll();
    }
  });
}

async function fetchNow() {
  // only before the first data lands — at fast Pi polls this would flicker
  if (!KANP._liveNewest) setStatus('yellow', 'Loading…');
  try {
    const now = Math.floor(Date.now() / 1000);
    const data = await KANP.getTracks({ start: now - LIVE_WINDOW_S, end: now, ground: 'include' });

    // the newest fix across all tracks anchors what counts as "current"
    let newest = 0;
    for (const t of data.tracks) {
      const last = t.points[t.points.length - 1];
      if (last && last[0] > newest) newest = last[0];
    }

    // one marker per aircraft: its last fix, if close to the newest fix.
    // points carry no heading, so derive it from the previous fix.
    const ac = [];
    for (const t of data.tracks) {
      const p = t.points[t.points.length - 1];
      if (!p || p[0] < newest - RECENT_S) continue;
      const prev = t.points[t.points.length - 2];
      ac.push({
        lat: p[1], lon: p[2], hex: t.hex, flight: t.flight, reg: t.reg, type: t.type,
        alt_baro: p[5] ? 'ground' : p[3], gs: p[4], military: t.military,
        track: prev ? bearing(prev[1], prev[2], p[1], p[2]) : 0,
      });
    }

    // only fold a genuinely new snapshot into the session history, at most
    // once a minute — fast Pi polls would otherwise flood localStorage, and
    // the public snapshot updates hourly so re-storing it would dupe it
    if (newest && newest !== KANP._liveNewest &&
        Date.now() - (KANP._lastObsMs || 0) >= KANP.POLL_MS) {
      KANP._liveNewest = newest;
      KANP._lastObsMs = Date.now();
      storeObs(ac);
      renderFromStorage();
    }
    renderLiveAircraft(ac);

    const ageMin = newest ? Math.max(0, Math.round((Date.now() / 1000 - newest) / 60)) : null;
    const viaPi = data._source === 'pi';
    const fresh = ageMin != null && ageMin <= 2;
    setStatus(fresh ? 'green' : 'yellow',
      ageMin == null ? 'No recent data'
        : fresh && viaPi ? 'Live · via Pi'
          : `${viaPi ? 'via Pi' : 'Snapshot'} · collected ${ageMin} min ago`);
    show('ac-count-wrap');
    document.getElementById('ac-num').textContent = ac.length;
    show('update-wrap');
    document.getElementById('update-time').textContent = new Date().toLocaleTimeString();
    return data._source;
  } catch (err) {
    setStatus('red', 'No data — try History / Traffic Study');
    console.warn('[KANP] live latest-positions failed:', err.message);
    return null;
  }
}

// initial-bearing (great-circle) from point 1 to point 2, degrees
function bearing(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const y = Math.sin((lon2 - lon1) * r) * Math.cos(lat2 * r);
  const x = Math.cos(lat1 * r) * Math.sin(lat2 * r) -
    Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lon2 - lon1) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
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
  obs.forEach(o => o.ac.forEach(a => { if (a.lat && a.lon) pts.push([a.lat, a.lon, 0.35]); }));
  if (heatLayer && liveMap && liveMap.hasLayer(heatLayer)) heatLayer.setLatLngs(pts);
}

// ---------------------------------------------------------------------------
// All-time hour × day-of-week grid: unique aircraft from the full collector
// dataset (Pi database, or every published day snapshot — up to the snapshot
// window; 60 days, not 62, because KANPStatic.datesInRange caps at 62 iterated
// dates from `start`, so asking for 62 would push today past the cap). Day
// files are big, so the computed grid is cached in localStorage and reused
// for an hour (the snapshots update hourly anyway).
// ---------------------------------------------------------------------------
KANP.GRID_CACHE_KEY = 'kanp_alltime_grid_v1';
let allTimeGrid = null;

async function loadAllTimeGrid() {
  const label = document.getElementById('obs-label');
  try {
    const cached = JSON.parse(localStorage.getItem(KANP.GRID_CACHE_KEY) || 'null');
    if (cached && Date.now() - cached.at < 3_600_000) {
      allTimeGrid = cached.grid;
      label.textContent = cached.label;
      renderTemporalGrid();
      return;
    }
  } catch { /* bad cache — refetch */ }

  try {
    const now = Math.floor(Date.now() / 1000);
    const s = await KANP.getStats({ start: now - 60 * 86_400, end: now });
    allTimeGrid = s.grid_unique_aircraft;
    const labelTxt =
      `${Number(s.totals.aircraft).toLocaleString()} aircraft · ` +
      `${Number(s.totals.samples).toLocaleString()} reports · ${KANP.sourceLabel(s)}`;
    label.textContent = labelTxt;
    try {
      localStorage.setItem(KANP.GRID_CACHE_KEY,
        JSON.stringify({ at: Date.now(), grid: allTimeGrid, label: labelTxt }));
    } catch { /* storage full — fine, just uncached */ }
    renderTemporalGrid();
  } catch (e) {
    document.getElementById('no-history').textContent =
      'Could not load collected traffic data.';
    console.warn('[KANP] all-time grid failed:', e.message);
  }
}

function renderTemporalGrid() {
  if (!allTimeGrid) return;
  const canvas = document.getElementById('temporal-canvas');
  document.getElementById('no-history').style.display = 'none';
  canvas.style.display = 'block';
  KANP.renderGrid(canvas, allTimeGrid);
}

function setStatus(color, text) {
  const dot = document.getElementById('status-dot');
  dot.className = `dot${color ? ' ' + color : ''}`;
  document.getElementById('status-text').textContent = text;
}

function show(id) {
  document.getElementById(id).style.display = '';
}
