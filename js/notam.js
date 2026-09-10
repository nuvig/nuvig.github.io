/* NOTAM Hub — every active US NOTAM, archived and counted.
   ---------------------------------------------------------------------------
   Reads the notam-data branch (scripts/notamarchive.py, hourly): summary.json
   carries every aggregate drawn on first paint; current/<ST>.json holds the
   NOTAMs themselves, one file per state, fetched only when a visitor browses
   or searches; data/notam/locations.json (same-origin) places facilities on
   the map and resolves a typed id to its state.

   Nothing here calls the FAA. The page is a view of what the archive holds,
   and it says how old that is. Times are Z throughout — NOTAMs are written in
   UTC and the scope is the whole country.

   Colours: single-hue blue for magnitude (bars, dots); the trend's two lines
   (first seen · left the system) are the blue/orange pair validated for CVD
   separation on the card surface (ΔE 26.8 worst case, both ≥ 3:1).

   Needs js/site-config.js first (SITE.notam). window.NOTAM_DEBUG exposes the
   loaded state for headless checks. */

'use strict';

const $ = (id) => document.getElementById(id);
const CFG = SITE.notam;
const BASE = (() => {
  try { return localStorage.getItem('notam_data_base') || CFG.dataBase; } catch (e) { return CFG.dataBase; }
})();
const NOSTATE = '--';
const BLUE = '#3987e5', ORANGE = '#d95926';
const RAMP = ['#1c5cab', '#3987e5', '#5598e7', '#86b6ef', '#b7d3f6'];   // low → high, dark surface

const S = {
  sum: null, idx: null, locs: null,
  byQ: new Map(), byLid: new Map(),
  files: new Map(),       // ST -> Promise<records[]>
  draws: [],              // redraw fns for resize
  browse: { q: '', st: '', k: '', shown: 300 },
};
window.NOTAM_DEBUG = S;

/* ---------------------------------------------------------------------------
   Formatting
--------------------------------------------------------------------------- */

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n) => String(n).padStart(2, '0');
const fmtN = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US'));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function zt(ts, withYear) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const y = withYear || d.getUTCFullYear() !== new Date().getUTCFullYear() ? ` ${d.getUTCFullYear()}` : '';
  return `${MON[d.getUTCMonth()]} ${d.getUTCDate()}${y} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}Z`;
}
function zd(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  return `${MON[d.getUTCMonth()]} ${d.getUTCDate()} ${d.getUTCFullYear()}`;
}
function ago(sec) {
  if (sec == null) return '';
  const a = Math.abs(sec);
  const s = a < 90 ? `${Math.round(a)} s` : a < 5400 ? `${Math.round(a / 60)} min` : a < 172800 ? `${Math.round(a / 3600)} h`
    : a < 86400 * 60 ? `${Math.round(a / 86400)} d` : a < 86400 * 730 ? `${Math.round(a / 86400 / 30.4)} mo` : `${(a / 86400 / 365.25).toFixed(1)} y`;
  return sec < 0 ? `in ${s}` : `${s} ago`;
}
function span(sec) {
  if (sec == null) return '';
  if (sec < 3600) return `${Math.round(sec / 60)} min`;
  if (sec < 86400 * 2) return `${(sec / 3600).toFixed(sec < 36000 ? 1 : 0)} h`;
  if (sec < 86400 * 90) return `${Math.round(sec / 86400)} d`;
  if (sec < 86400 * 730) return `${Math.round(sec / 86400 / 30.4)} mo`;
  return `${(sec / 86400 / 365.25).toFixed(1)} y`;
}
const now = () => Math.floor(Date.now() / 1000);

/* ---------------------------------------------------------------------------
   Data
--------------------------------------------------------------------------- */

async function getJson(url, bust) {
  try {
    const u = bust ? `${url}?t=${Math.floor(Date.now() / 300000)}` : url;
    const r = await fetch(u, { headers: { Accept: 'application/json' } });
    return r.ok ? await r.json() : null;
  } catch (e) { return null; }
}

function indexLocations(doc) {
  S.locs = doc;
  for (const row of (doc && doc.locs) || []) {
    const loc = { q: row[0], lid: row[1] || row[0], kind: row[2] || 'apt', name: row[3] || '', st: row[4] || NOSTATE,
      lat: row[5], lon: row[6], artcc: row[7], aliases: row[8] || [] };
    S.byQ.set(loc.q, loc);
    if (!S.byLid.has(loc.lid)) S.byLid.set(loc.lid, loc);
    for (const a of loc.aliases) if (!S.byQ.has(a)) S.byQ.set(a, loc);
  }
}

/* A typed or printed id -> the location record, or null. */
function locFor(id) {
  if (!id) return null;
  const u = id.toUpperCase().trim();
  return S.byQ.get(u) || S.byLid.get(u) || (u.length === 3 && S.byQ.get('K' + u))
    || (u.length === 4 && /^[KP]/.test(u) && S.byLid.get(u.slice(1))) || null;
}
function locLabel(loc) {
  if (!loc) return '';
  return `${loc.name}${loc.st && loc.st !== NOSTATE ? ` ${loc.st}` : ''}`;
}

/* One state's NOTAMs, fetched once. */
function stateFile(st) {
  if (!S.files.has(st)) {
    S.files.set(st, getJson(`${BASE}/current/${encodeURIComponent(st)}.json`, true).then((d) => (d && d.notams) || []));
  }
  return S.files.get(st);
}

/* ---------------------------------------------------------------------------
   Canvas toolkit — DPR-aware, resize-redrawn, one shared tooltip
--------------------------------------------------------------------------- */

const TIP = document.createElement('div');
TIP.id = 'tip';
TIP.style.cssText = 'position:fixed;display:none;pointer-events:none;background:#111e;border:1px solid #444;' +
  'border-radius:6px;padding:5px 8px;font-size:12px;color:#ddd;z-index:20;max-width:340px;font-variant-numeric:tabular-nums';
document.body.appendChild(TIP);
function tip(x, y, html) {
  if (!html) { TIP.style.display = 'none'; return; }
  TIP.innerHTML = html;
  TIP.style.display = 'block';
  const w = TIP.offsetWidth, h = TIP.offsetHeight;
  TIP.style.left = `${Math.min(x + 12, window.innerWidth - w - 8)}px`;
  TIP.style.top = `${y + 14 + h > window.innerHeight ? y - h - 8 : y + 14}px`;
}

function setup(c, hCss) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(200, c.clientWidth || c.parentElement.clientWidth || 300);
  c.width = Math.round(w * dpr); c.height = Math.round(hCss * dpr);
  c.style.height = `${hCss}px`;
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, hCss);
  ctx.font = '11.5px system-ui, "Segoe UI", sans-serif';
  return { ctx, W: w, H: hCss };
}

/* Hover plumbing: a chart registers hit rects with a tooltip each. */
function hover(c, hits, fmt) {
  c.onmousemove = (ev) => {
    const r = c.getBoundingClientRect();
    const x = ev.clientX - r.left, y = ev.clientY - r.top;
    const h = hits.find((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h);
    tip(ev.clientX, ev.clientY, h ? fmt(h) : '');
    c.style.cursor = h && h.click ? 'pointer' : 'default';
  };
  c.onmouseleave = () => tip();
  c.onclick = (ev) => {
    const r = c.getBoundingClientRect();
    const x = ev.clientX - r.left, y = ev.clientY - r.top;
    const h = hits.find((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h);
    if (h && h.click) h.click();
  };
}

function roundRight(ctx, x, y, w, h, r) {
  r = Math.min(r, h / 2, Math.max(0, w));
  ctx.beginPath();
  ctx.moveTo(x, y); ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r); ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h); ctx.lineTo(x, y + h); ctx.closePath();
}
function roundTop(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, Math.max(0, h));
  ctx.beginPath();
  ctx.moveTo(x, y + h); ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y); ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r); ctx.lineTo(x + w, y + h); ctx.closePath();
}

/* Horizontal bars: rows = [[label, value, note?]]; one hue, value labelled at
   the bar end (a single series needs no legend). Height follows the rows. */
function hbars(id, rows, opts = {}) {
  const c = $(id);
  if (!c) return;
  const draw = () => {
    const rowH = opts.rowH || 21;
    const H = Math.max(40, rows.length * rowH + 8);
    const { ctx, W } = setup(c, H);
    const max = Math.max(1, ...rows.map((r) => r[1]));
    const labW = opts.labW || Math.min(150, Math.max(...rows.map((r) => ctx.measureText(r[0]).width)) + 12);
    const x0 = labW, x1 = W - 52;
    const hits = [];
    rows.forEach((r, i) => {
      const y = 4 + i * rowH;
      const bw = Math.max(1.5, (x1 - x0) * r[1] / max);
      ctx.fillStyle = '#999';
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillText(r[0], x0 - 8, y + rowH / 2);
      ctx.fillStyle = opts.color || BLUE;
      roundRight(ctx, x0, y + rowH * 0.26, bw, rowH * 0.48, 4);
      ctx.fill();
      ctx.fillStyle = '#ccc'; ctx.textAlign = 'left';
      ctx.fillText(fmtN(r[1]), x0 + bw + 6, y + rowH / 2);
      hits.push({ x: 0, y, w: W, h: rowH, row: r, click: opts.onClick ? () => opts.onClick(r) : null });
    });
    hover(c, hits, (h) => `<b>${esc(h.row[0])}</b> · ${fmtN(h.row[1])}${h.row[2] ? `<br>${esc(h.row[2])}` : ''}`);
  };
  S.draws.push(draw); draw();
}

/* Vertical bars over an ordered axis (the start-hour clock). */
function vbars(id, values, labels, opts = {}) {
  const c = $(id);
  if (!c) return;
  const draw = () => {
    const H = opts.h || 150;
    const { ctx, W } = setup(c, H);
    const max = Math.max(1, ...values);
    const x0 = 34, x1 = W - 8, y0 = 6, y1 = H - 22;
    const n = values.length, slot = (x1 - x0) / n, bw = Math.max(2, slot - 3);
    const hits = [];
    ctx.strokeStyle = '#2a2a2a'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x0, y1 + 0.5); ctx.lineTo(x1, y1 + 0.5); ctx.stroke();
    ctx.fillStyle = '#777'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ctx.fillText(fmtN(max), x0 - 6, y0 + 4);
    ctx.fillText('0', x0 - 6, y1);
    const peak = values.indexOf(max);
    values.forEach((v, i) => {
      const x = x0 + i * slot + (slot - bw) / 2;
      const bh = (y1 - y0) * v / max;
      ctx.fillStyle = BLUE;
      roundTop(ctx, x, y1 - bh, bw, bh, 3);
      ctx.fill();
      if (i === peak && v > 0) {
        ctx.fillStyle = '#ccc'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
        ctx.fillText(fmtN(v), x + bw / 2, y1 - bh - 3);
      }
      if (i % (opts.every || 3) === 0) {
        ctx.fillStyle = '#777'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        ctx.fillText(labels[i], x + bw / 2, y1 + 5);
      }
      hits.push({ x: x0 + i * slot, y: y0, w: slot, h: y1 - y0, i });
    });
    hover(c, hits, (h) => `<b>${esc(labels[h.i])}${opts.unit || ''}</b> · ${fmtN(values[h.i])}`);
  };
  S.draws.push(draw); draw();
}

/* Nice tick step for a max value: 1/2/5 ladder. */
function nice(max, target = 4) {
  if (max <= 0) return 1;
  const raw = max / target, p = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= raw) return m * p;
  return 10 * p;
}

/* Trend: two lanes, one y-scale each (never two scales on one plot).
   Lane 1 first seen (blue) vs left the system (orange); lane 2 active. */
function trend(id, days) {
  const c = $(id);
  if (!c) return;
  const draw = () => {
    const H = 260;
    const { ctx, W } = setup(c, H);
    const n = days.length;
    if (!n) { ctx.fillStyle = '#666'; ctx.fillText('no days archived yet', 8, 20); return; }
    const x0 = 46, x1 = W - 78;
    const lanes = [
      { y0: 8, y1: 150, series: [['first seen', (d) => d.new, BLUE], ['left', (d) => d.gone, ORANGE]] },
      { y0: 172, y1: 236, series: [['in system', (d) => d.active, BLUE]] },
    ];
    const xAt = (i) => (n === 1 ? (x0 + x1) / 2 : x0 + (x1 - x0) * i / (n - 1));
    const hits = [];
    for (const L of lanes) {
      const max = Math.max(1, ...days.flatMap((d) => L.series.map((s) => s[1](d) || 0)));
      const step = nice(max, 3), top = Math.ceil(max / step) * step;
      const yAt = (v) => L.y1 - (L.y1 - L.y0) * v / top;
      ctx.strokeStyle = '#262626'; ctx.lineWidth = 1;
      ctx.fillStyle = '#777'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      for (let v = 0; v <= top + 1e-9; v += step) {
        const y = Math.round(yAt(v)) + 0.5;
        ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
        ctx.fillText(fmtN(v), x0 - 6, y);
      }
      L.series.forEach(([name, f, col]) => {
        ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.lineJoin = 'round';
        ctx.beginPath();
        days.forEach((d, i) => { const y = yAt(f(d) || 0); i ? ctx.lineTo(xAt(i), y) : ctx.moveTo(xAt(i), y); });
        ctx.stroke();
        ctx.fillStyle = col;
        days.forEach((d, i) => { ctx.beginPath(); ctx.arc(xAt(i), yAt(f(d) || 0), n < 40 ? 3 : 1.5, 0, 7); ctx.fill(); });
        // direct label at the line end — identity never by colour alone
        const last = days[n - 1];
        ctx.fillStyle = '#bbb'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillText(name, x1 + 8, yAt(f(last) || 0));
      });
    }
    // x labels
    ctx.fillStyle = '#777'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor((x1 - x0) / 70))));
    days.forEach((d, i) => {
      if (i % every === 0 || i === n - 1) {
        const [, m, dd] = d.d.split('-');
        ctx.fillText(`${MON[+m - 1]} ${+dd}`, xAt(i), 242);
      }
      const half = n === 1 ? 40 : (x1 - x0) / (n - 1) / 2;
      hits.push({ x: xAt(i) - half, y: 0, w: half * 2, h: H, d, i });
    });
    hover(c, hits, (h) => {
      const d = h.d, first = S.sum && S.sum.bootstrap && d.d === new Date(S.sum.bootstrap * 1000).toISOString().slice(0, 10);
      return `<b>${esc(d.d)}</b>${first ? ' · archive began' : ''}<br>first seen ${fmtN(d.new)} · left ${fmtN(d.gone)}` +
        ` (${fmtN(d.cxl)} cancelled · ${fmtN(d.exp)} expired)<br>in system ${fmtN(d.active)}`;
    });
  };
  S.draws.push(draw); draw();
}

/* ---------------------------------------------------------------------------
   Map — Albers conic for the lower 48, insets for AK · HI · PR/VI; one dot per
   facility with NOTAMs in effect, radius by count. Airport density draws the
   coastline by itself, which is why no boundary file is needed.
--------------------------------------------------------------------------- */

const RAD = Math.PI / 180;
function albers(lat, lon, p1, p2, p0, l0) {
  const φ = lat * RAD, λ = lon * RAD, φ1 = p1 * RAD, φ2 = p2 * RAD, φ0 = p0 * RAD, λ0 = l0 * RAD;
  const n = (Math.sin(φ1) + Math.sin(φ2)) / 2;
  const C = Math.cos(φ1) ** 2 + 2 * n * Math.sin(φ1);
  const ρ = Math.sqrt(C - 2 * n * Math.sin(φ)) / n, ρ0 = Math.sqrt(C - 2 * n * Math.sin(φ0)) / n;
  const θ = n * (λ - λ0);
  return [ρ * Math.sin(θ), ρ0 - ρ * Math.cos(θ)];
}
const REGIONS = [
  { name: 'conus', test: (la, lo) => la > 24 && la < 50 && lo > -125.5 && lo < -66, proj: (la, lo) => albers(la, lo, 29.5, 45.5, 23, -96),
    box: [[24.5, -124.8], [49.4, -66.9], [31, -117], [29, -81], [47, -68], [25.5, -80.5]], frame: [0.02, 0.02, 0.98, 0.94] },
  { name: 'ak', test: (la, lo) => la >= 50 && lo < -125, proj: (la, lo) => albers(la, lo, 55, 65, 50, -154),
    box: [[51, -179], [71.5, -130], [55, -165], [60, -141]], frame: [0.02, 0.62, 0.24, 0.98] },
  { name: 'hi', test: (la, lo) => la > 18 && la < 23 && lo < -154 && lo > -161, proj: (la, lo) => albers(la, lo, 8, 18, 13, -157),
    box: [[18.8, -160.4], [22.4, -154.7]], frame: [0.27, 0.78, 0.4, 0.98] },
  { name: 'pr', test: (la, lo) => la > 17 && la < 19 && lo > -68 && lo < -64, proj: (la, lo) => albers(la, lo, 8, 18, 13, -66),
    box: [[17.8, -67.4], [18.6, -64.4]], frame: [0.78, 0.86, 0.9, 0.98] },
];

function drawMap(fac) {
  const c = $('map');
  if (!c) return;
  const pts = [];
  for (const [lid, n] of Object.entries(fac || {})) {
    const loc = locFor(lid);
    if (!loc || loc.lat == null || loc.lon == null) continue;
    pts.push({ lid, n, loc });
  }
  pts.sort((a, b) => a.n - b.n);
  const draw = () => {
    const H = Math.max(300, Math.min(520, Math.round((c.clientWidth || 600) * 0.62)));
    const { ctx, W } = setup(c, H);
    // per-region affine from the projected box corners to the frame
    for (const R of REGIONS) {
      const pr = R.box.map(([la, lo]) => R.proj(la, lo));
      const xs = pr.map((p) => p[0]), ys = pr.map((p) => p[1]);
      const minx = Math.min(...xs), maxx = Math.max(...xs), miny = Math.min(...ys), maxy = Math.max(...ys);
      const fx0 = R.frame[0] * W, fy0 = R.frame[1] * H, fw = (R.frame[2] - R.frame[0]) * W, fh = (R.frame[3] - R.frame[1]) * H;
      const k = Math.min(fw / (maxx - minx), fh / (maxy - miny));
      const ox = fx0 + (fw - k * (maxx - minx)) / 2, oy = fy0 + (fh - k * (maxy - miny)) / 2;
      R.toXY = (la, lo) => { const [x, y] = R.proj(la, lo); return [ox + (x - minx) * k, oy + (maxy - y) * k]; };
      if (R.name !== 'conus') {
        ctx.strokeStyle = '#2a2a2a'; ctx.lineWidth = 1;
        ctx.strokeRect(fx0 + 0.5, fy0 + 0.5, fw - 1, fh - 1);
        ctx.fillStyle = '#555'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
        ctx.fillText(R.name.toUpperCase(), fx0 + 5, fy0 + 4);
      }
    }
    const hits = [];
    let placed = 0;
    for (const p of pts) {
      const R = REGIONS.find((r) => r.test(p.loc.lat, p.loc.lon));
      if (!R) continue;
      const [x, y] = R.toXY(p.loc.lat, p.loc.lon);
      const r = Math.min(15, 1.6 + 1.5 * Math.sqrt(p.n));
      const col = p.n <= 2 ? RAMP[0] : p.n <= 5 ? RAMP[1] : p.n <= 15 ? RAMP[2] : p.n <= 40 ? RAMP[3] : RAMP[4];
      ctx.globalAlpha = 0.82;
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
      if (p.n > 5) { ctx.globalAlpha = 1; ctx.strokeStyle = '#111'; ctx.lineWidth = 1; ctx.stroke(); }
      const hr = Math.max(r, 5);
      hits.push({ x: x - hr, y: y - hr, w: hr * 2, h: hr * 2, p, click: () => browseFacility(p.loc.q) });
      placed++;
    }
    ctx.globalAlpha = 1;
    // the local field, marked
    const home = locFor(SITE.airport.id);
    if (home && home.lat != null) {
      const R = REGIONS[0], [x, y] = R.toXY(home.lat, home.lon);
      ctx.strokeStyle = '#eee'; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.arc(x, y, 6, 0, 7); ctx.stroke();
    }
    hits.reverse();   // big dots drawn last, so hit-test them first
    hover(c, hits, (h) => `<b>${esc(h.p.loc.q)}</b> · ${esc(locLabel(h.p.loc))}<br>${fmtN(h.p.n)} in effect`);
    const off = pts.length - placed;
    $('map-legend').innerHTML = RAMP.map((col, i) => `<span><i style="background:${col}"></i>${['1–2', '3–5', '6–15', '16–40', '41+'][i]}</span>`).join('') +
      `<span>${fmtN(placed)} facilities drawn${off ? ` · ${fmtN(off)} off-frame` : ''}</span>` +
      `<span title="${esc(SITE.airport.id)}">○ ${esc(SITE.airport.id)}</span>`;
  };
  S.draws.push(draw); draw();
}

/* ---------------------------------------------------------------------------
   Rendering
--------------------------------------------------------------------------- */

const KW_HELP = {
  RWY: 'runway', TWY: 'taxiway', APRON: 'apron / ramp', AD: 'aerodrome', OBST: 'obstruction', NAV: 'navaid',
  COM: 'communications', SVC: 'services', AIRSPACE: 'airspace', ODP: 'obstacle departure procedure', SID: 'departure procedure',
  STAR: 'arrival procedure', CHART: 'chart', DATA: 'data', IAP: 'instrument approach', VFP: 'visual flight procedure',
  ROUTE: 'route', SPECIAL: 'special activity', SECURITY: 'security', '(U)': 'unverified', '(O)': 'other', '?': 'no keyword parsed',
};
const CLASS_HELP = { D: 'domestic (D) NOTAM', FDC: 'Flight Data Center — procedures, charts, airspace', TFR: 'FDC temporary flight restriction', GPS: 'GPS interference / testing', MIL: 'military', LMIL: 'local military', INTL: 'international, ICAO format' };

function renderStatus() {
  const s = S.sum, t = now();
  const parts = [];
  if (!s) {
    $('status').innerHTML = `<span class="warn">archive not published yet</span> · the hourly run writes <b>${esc(BASE)}</b>`;
    return;
  }
  parts.push(`<b>${fmtN(s.n.active)}</b> in effect`);
  if (s.n.sched) parts.push(`<b>${fmtN(s.n.sched)}</b> scheduled`);
  parts.push(`as of <b>${zt(s.t)}</b> · ${ago(t - s.t)}`);
  parts.push(`<b>${fmtN(s.n.queried)}</b>/${fmtN(s.n.locations)} locations`);
  parts.push(`via <b>${esc(s.src_note || s.src || '?')}</b>`);
  if (!s.ok) parts.push(`<span class="warn">⚠ last run refused · ${esc(s.note)}</span>`);
  else if (s.note && !/^bootstrap/.test(s.note)) parts.push(`<span class="warn">⚠ ${esc(s.note)}</span>`);
  if (t - s.t > 4 * 3600) parts.push(`<span class="warn">⚠ ${ago(t - s.t)} · stale</span>`);
  $('status').innerHTML = parts.map((p) => `<span>${p}</span>`).join('');
}

function renderTiles() {
  const s = S.sum, c = s.counts, n = s.n;
  const tiles = [
    ['in effect', n.active, 'NOTAMs whose start time has passed'],
    ['new 24 h', n.new24, 'first seen by the archive in the last 24 h'],
    ['gone 24 h', n.gone24, `left the system today and yesterday · ${fmtN(n.cxl24g)} cancelled before their end time · ${fmtN(n.exp24g)} ran to it`],
    ['runway closures', c.rwy_clsd, 'RWY … CLSD'],
    ['airports closed', c.ad_clsd, 'AD AP CLSD'],
    ['TFRs', c.tfr, 'FDC airspace NOTAMs headed TEMPORARY FLIGHT RESTRICTIONS'],
    ['GPS interference', c.gps, 'NAV GPS NOTAMs'],
    ['navaids out', c.nav_ots, `NAV … OTS / U/S · ${fmtN(c.ils_ots)} ILS`],
    ['obstacle lights out', c.obst_unlit, `OBST … LGT OTS · of ${fmtN(c.obst)} obstruction NOTAMs`],
    ['permanent', n.perm, 'ends PERM'],
    ['ending 24 h', n.exp24, 'end time inside the next 24 h'],
    ['unverified', c.unverified, '(U) NOTAMs'],
  ];
  $('tiles').innerHTML = tiles.map(([l, v, help, small]) =>
    `<div class="tile${!v ? ' dim' : ''}" title="${esc(help)}"><div class="v">${fmtN(v)}${small ? `<small>${esc(small)}</small>` : ''}</div><div class="l">${esc(l)}</div></div>`).join('');
}

function renderCharts() {
  const s = S.sum;
  const kw = Object.entries(s.by_k).map(([k, v]) => [k, v, KW_HELP[k] || '']);
  $('n-kw').textContent = `${fmtN(s.n.active)} total`;
  hbars('c-kw', kw, { onClick: (r) => browseKeyword(r[0]) });
  hbars('c-cls', Object.entries(s.by_c).map(([k, v]) => [k, v, CLASS_HELP[k] || '']), { onClick: (r) => browseKeyword(r[0]) });
  const ends = [['dated end', s.n.active - s.n.perm - s.n.est, 'a fixed end time'], ['estimated (EST)', s.n.est, 'end time is an estimate — the NOTAM stays until cancelled'], ['PERM', s.n.perm, 'no end — stays until charted or cancelled']];
  hbars('c-end', ends, { labW: 110 });
  hbars('c-age', s.age.map(([k, v]) => [k, v]), { labW: 70 });
  hbars('c-dur', s.dur.map(([k, v]) => [k, v]), { labW: 70 });
  trend('c-trend', s.history || []);
  vbars('c-hour', s.start_hour || [], Array.from({ length: 24 }, (_, i) => pad(i)), { every: 3, unit: 'Z' });
}

function renderStates() {
  const rows = Object.entries(S.sum.by_st).map(([st, v]) => ({ st, n: v[0], fac: v[1], rwy: v[2], tfr: v[3] }));
  rows.sort((a, b) => b.n - a.n);
  const max = Math.max(1, ...rows.map((r) => r.n));
  const top = rows.filter((r) => r.st !== NOSTATE).slice(0, 16);
  const nat = rows.find((r) => r.st === NOSTATE);
  const tr = (r, label) => `<tr class="pick" data-st="${esc(r.st)}" title="${fmtN(r.rwy)} runway closures · ${fmtN(r.tfr)} TFRs">` +
    `<td>${esc(label || r.st)}</td><td class="r"><span class="bar" style="width:${Math.round(60 * r.n / max)}px"></span>${fmtN(r.n)}</td>` +
    `<td class="r">${fmtN(r.fac)}</td><td class="r">${r.fac ? (r.n / r.fac).toFixed(1) : '—'}</td></tr>`;
  $('states').innerHTML = `<table class="t"><thead><tr><th>state</th><th class="r">NOTAMs</th><th class="r">facilities</th><th class="r">each</th></tr></thead>` +
    `<tbody>${top.map((r) => tr(r)).join('')}${nat ? tr(nat, 'ARTCC · national') : ''}</tbody></table>`;
  $('states').querySelectorAll('tr.pick').forEach((el) => { el.onclick = () => browseState(el.dataset.st); });
}

function ntRow(r, extra) {
  const loc = locFor(r.q || r.l);
  const t = now();
  const when = r.s ? `${zt(r.s)} → ${r.p ? 'PERM' : r.e ? zt(r.e) : '?'}${r.x ? ' EST' : ''}` : 'no period parsed';
  const age = r.s && r.s <= t ? span(t - r.s) : r.s ? `starts ${ago(t - r.s)}` : '';
  const cls = r.c && r.c !== 'D' ? r.c : '';
  return `<div class="nt"><div class="nt-head"><b>${esc(r.id)}</b>` +
    `<span class="kw ${esc(cls)}" title="${esc(KW_HELP[r.k] || '')}${cls ? ` · ${esc(CLASS_HELP[cls] || '')}` : ''}">${esc(cls ? `${cls} · ${r.k}` : r.k)}</span>` +
    `<span class="loc" data-q="${esc(loc ? loc.q : r.l)}" title="browse ${esc(r.l)}">${esc(r.l)}${loc ? ` · ${esc(locLabel(loc))}` : r.st && r.st !== NOSTATE ? ` · ${esc(r.st)}` : ''}</span>` +
    `<span class="when">${when}</span>${age ? `<span class="when">${esc(age)}</span>` : ''}` +
    (r.b ? '' : `<span class="when" title="first seen by the archive">seen ${zt(r.f)}</span>`) +
    (extra || '') + `</div><pre class="raw">${esc(r.raw)}</pre></div>`;
}

function list(el, rows, extraFn, cap = 300) {
  if (!rows.length) { el.innerHTML = '<p class="empty">none</p>'; return; }
  const shown = rows.slice(0, cap);
  el.innerHTML = shown.map((r) => ntRow(r, extraFn ? extraFn(r) : '')).join('') +
    (rows.length > cap ? `<button class="more" data-cap="${cap}">show ${fmtN(Math.min(300, rows.length - cap))} more of ${fmtN(rows.length)}</button>` : '');
  el.querySelectorAll('.loc').forEach((x) => { x.onclick = () => browseFacility(x.dataset.q); });
  const more = el.querySelector('.more');
  if (more) more.onclick = () => list(el, rows, extraFn, cap + 300);
}

function renderFold(id, rows, extraFn, pre) {
  const d = $(id);
  d.querySelector('summary .n').textContent = fmtN(rows.length);
  const body = d.querySelector('.body');
  let done = false;
  const fill = () => { if (done) return; done = true; body.innerHTML = pre || ''; const holder = document.createElement('div'); body.appendChild(holder); list(holder, rows, extraFn); };
  d.addEventListener('toggle', () => { if (d.open) fill(); });
  if (d.open) fill();
}

function renderLeaders() {
  const s = S.sum, t = now();
  $('top-fac').innerHTML = s.fac_top.slice(0, 15).map(([lid, n, st, name]) => {
    const loc = locFor(lid);
    return `<li><a data-q="${esc(loc ? loc.q : lid)}">${esc(lid)}</a> <span class="m">${esc(loc ? locLabel(loc) : `${name || ''} ${st && st !== NOSTATE ? st : ''}`.trim())}</span> <b>${fmtN(n)}</b></li>`;
  }).join('');
  $('top-fac').querySelectorAll('a').forEach((a) => { a.onclick = () => browseFacility(a.dataset.q); });
  const clip = (raw, n = 150) => (raw.length > n ? `${raw.slice(0, n - 1)}…` : raw);
  $('oldest').innerHTML = s.oldest.slice(0, 12).map((r) =>
    `<li><b>${esc(r.id)}</b> <span class="m">${esc(r.l)} · since ${zd(r.s)} · ${span(t - r.s)}${r.p ? ' · PERM' : ''}</span><br><span class="m">${esc(clip(r.raw))}</span></li>`).join('') || '<li class="m">none</li>';
  $('longest').innerHTML = s.longest.slice(0, 12).map((r) =>
    `<li><b>${esc(r.id)}</b> <span class="m">${esc(r.l)} · ${span(r.e - r.s)} · ${zd(r.s)} → ${zd(r.e)}${r.x ? ' EST' : ''}</span><br><span class="m">${esc(clip(r.raw))}</span></li>`).join('') || '<li class="m">none</li>';
}

function renderFolds() {
  const s = S.sum;
  renderFold('f-tfr', s.tfr || []);
  renderFold('f-gps', s.gps || []);
  const rb = Object.entries(s.rwy_clsd.by_st || {}).filter(([st]) => st !== NOSTATE).sort((a, b) => b[1] - a[1]).slice(0, 12);
  const pre = rb.length ? `<table class="t" style="max-width:360px;margin-bottom:8px"><tbody>${rb.map(([st, n]) =>
    `<tr><td>${esc(st)}</td><td class="r"><span class="bar" style="width:${Math.round(80 * n / rb[0][1])}px"></span>${fmtN(n)}</td></tr>`).join('')}</tbody></table>` +
    `<p class="empty">${fmtN(s.rwy_clsd.n)} in effect · newest ${fmtN(Math.min(60, (s.rwy_clsd.recent || []).length))} below</p>` : '';
  renderFold('f-rwy', s.rwy_clsd.recent || [], null, pre);
  $('f-rwy').querySelector('summary .n').textContent = fmtN(s.rwy_clsd.n);
  renderFold('f-ad', s.ad_clsd.recent || []);
  $('f-ad').querySelector('summary .n').textContent = fmtN(s.ad_clsd.n);
  renderFold('f-exp', s.expiring || [], (r) => `<span class="tag">ends ${ago(now() - r.e)}</span>`);
  $('f-exp').querySelector('summary .n').textContent = fmtN(s.n.exp24);
  renderFold('f-new', s.recent_new || []);
  renderFold('f-gone', s.recent_gone || [], (r) => `<span class="why">${r.why === 'exp' ? 'expired' : 'cancelled'} · gone ${zt(r.t)}</span>`);
  const hist = (s.history || []).slice(-1)[0];
  if (hist) $('f-gone').querySelector('summary .n').textContent = fmtN(hist.gone);
}

function renderLocal() {
  const s = S.sum;
  const ids = (s.local_ids || CFG.local || []);
  $('local-sub').textContent = ids.join(' · ');
  const rows = (s.local || []).filter((r) => !r.s || r.s <= now() + 86400 * 30);
  $('n-local').textContent = fmtN(rows.length);
  const el = $('local');
  if (!rows.length) { el.innerHTML = '<p class="empty">none in effect</p>'; return; }
  const groups = new Map();
  for (const r of rows) { const k = r.q || r.l; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
  el.innerHTML = '';
  for (const id of ids) {
    const g = groups.get(id) || groups.get((locFor(id) || {}).q) || [];
    if (!g.length) continue;
    const loc = locFor(id);
    const h = document.createElement('div');
    h.className = 'nt-head'; h.style.marginTop = '10px';
    h.innerHTML = `<b>${esc(id)}</b> <span class="when">${esc(locLabel(loc))} · ${fmtN(g.length)}</span>`;
    el.appendChild(h);
    const holder = document.createElement('div');
    el.appendChild(holder);
    list(holder, g);
  }
}

function renderCoverage() {
  const s = S.sum, idx = S.idx || {};
  const runs = idx.runs || s.runs || [];
  let cadence = '';
  if (runs.length > 2) {
    const gaps = runs.slice(1).map((r, i) => r.t - runs[i].t).filter((g) => g > 0);
    gaps.sort((a, b) => a - b);
    cadence = `cadence <b>~${span(gaps[Math.floor(gaps.length / 2)])}</b> · `;
  }
  const days = idx.day_list || [];
  const failed = s.n.failed ? ` (<b>${fmtN(s.n.failed)}</b> unanswered${(idx.locations && idx.locations.failed || []).length ? `: ${esc((idx.locations.failed).slice(0, 8).join(' '))}${idx.locations.failed.length > 8 ? ' …' : ''}` : ''})` : '';
  $('coverage').innerHTML =
    `runs <b>${fmtN(runs.length)}</b> kept · last <b>${zt(s.t)}</b> · ${cadence}` +
    `locations <b>${fmtN(s.n.locations)}</b>${failed} · facilities with NOTAMs <b>${fmtN(s.n.facilities)}</b><br>` +
    `archive since <b>${s.bootstrap ? zd(s.bootstrap) : '—'}</b> · <b>${fmtN(days.length)}</b> day${days.length === 1 ? '' : 's'} · ` +
    `source <b>${esc(s.src_note || s.src || '?')}</b> · ` +
    `data → <a href="https://github.com/nuvig/nuvig.github.io/tree/notam-data">notam-data branch</a> · ` +
    `locations → <a href="${esc(CFG.locations)}">locations.json</a>${S.locs && S.locs.built ? ` (${esc(S.locs.src)} · ${esc(S.locs.built)})` : ''}`;
}

/* ---------------------------------------------------------------------------
   Browse — facility id, state and keyword filters over the state files
--------------------------------------------------------------------------- */

const KW_CHIPS = ['RWY', 'TWY', 'OBST', 'NAV', 'AD', 'SVC', 'COM', 'AIRSPACE', 'IAP', 'SID', 'STAR', 'ODP', 'TFR', 'GPS', 'FDC'];

function initBrowse() {
  const sel = $('st');
  const states = (S.idx && S.idx.states) || Object.keys(S.sum.by_st);
  for (const st of states) {
    const o = document.createElement('option');
    o.value = st; o.textContent = st === NOSTATE ? 'ARTCC · national' : st;
    sel.appendChild(o);
  }
  $('kw-chips').innerHTML = KW_CHIPS.map((k) => `<button class="chip" data-k="${k}" title="${esc(KW_HELP[k] || CLASS_HELP[k] || '')}">${k}</button>`).join('');
  $('kw-chips').querySelectorAll('.chip').forEach((b) => {
    b.onclick = () => { S.browse.k = S.browse.k === b.dataset.k ? '' : b.dataset.k; runBrowse(); };
  });
  let timer = null;
  $('q').oninput = () => { clearTimeout(timer); timer = setTimeout(() => { S.browse.q = $('q').value.trim(); runBrowse(); }, 350); };
  $('q').onkeydown = (e) => { if (e.key === 'Enter') { clearTimeout(timer); S.browse.q = $('q').value.trim(); runBrowse(); } };
  sel.onchange = () => { S.browse.st = sel.value; runBrowse(); };
  const h = new URLSearchParams(location.hash.replace(/^#/, ''));
  if (h.get('q') || h.get('st') || h.get('k')) {
    S.browse.q = h.get('q') || ''; S.browse.st = h.get('st') || ''; S.browse.k = h.get('k') || '';
    $('q').value = S.browse.q; sel.value = S.browse.st;
    runBrowse();
  }
}

function browseFacility(q) {
  S.browse.q = q; S.browse.st = ''; S.browse.k = '';
  $('q').value = q; $('st').value = '';
  runBrowse();
  $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function browseState(st) {
  S.browse.q = ''; S.browse.st = st; S.browse.k = '';
  $('q').value = ''; $('st').value = st;
  runBrowse();
  $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function browseKeyword(k) {
  S.browse.k = k;
  if (!S.browse.q && !S.browse.st) S.browse.st = (locFor(SITE.airport.id) || {}).st || '';
  $('st').value = S.browse.st;
  runBrowse();
  $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

let browseGen = 0;
async function runBrowse() {
  const gen = ++browseGen;
  const b = S.browse;
  $('kw-chips').querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c.dataset.k === b.k));
  const parts = [];
  if (b.q) parts.push(`q=${encodeURIComponent(b.q)}`);
  if (b.st) parts.push(`st=${encodeURIComponent(b.st)}`);
  if (b.k) parts.push(`k=${encodeURIComponent(b.k)}`);
  history.replaceState(null, '', parts.length ? `#${parts.join('&')}` : location.pathname);
  const out = $('results');
  const loc = b.q ? locFor(b.q) : null;
  let states;
  if (loc) states = [loc.st || NOSTATE];
  else if (b.st) states = [b.st];
  else if (b.q || b.k) states = (S.idx && S.idx.states) || Object.keys(S.sum.by_st);
  else { out.innerHTML = '<p class="empty">type a facility id, pick a state, or click a dot on the map</p>'; $('b-count').textContent = ''; return; }
  const cached = states.every((st) => S.files.has(st));
  if (!cached) out.innerHTML = `<p class="empty">loading ${states.length === 1 ? states[0] : `${states.length} state files`}…</p>`;
  const lists = await Promise.all(states.map(stateFile));
  if (gen !== browseGen) return;
  let rows = lists.flat();
  if (loc) rows = rows.filter((r) => r.q === loc.q || r.l === loc.lid || r.l === loc.q);
  else if (b.q) { const T = b.q.toUpperCase(); rows = rows.filter((r) => r.raw.toUpperCase().includes(T)); }
  if (b.k) rows = rows.filter((r) => r.k === b.k || r.c === b.k);
  const t = now();
  rows.sort((a, b2) => (a.l || '').localeCompare(b2.l || '') || (b2.f || 0) - (a.f || 0));
  const inEffect = rows.filter((r) => !r.s || r.s <= t).length;
  $('b-count').textContent = rows.length ? `${fmtN(rows.length)} NOTAMs · ${fmtN(inEffect)} in effect${loc ? ` · ${esc(locLabel(loc))}` : ''}` : '';
  if (!rows.length) {
    out.innerHTML = `<p class="empty">${loc ? `nothing in the system for ${esc(loc.q)}` : 'no match'}${b.q && !loc && !b.st ? ' · searched every state file' : ''}</p>`;
    return;
  }
  list(out, rows);
}

/* ---------------------------------------------------------------------------
   Boot
--------------------------------------------------------------------------- */

async function main() {
  const [sum, idx, locs] = await Promise.all([
    getJson(`${BASE}/summary.json`, true), getJson(`${BASE}/index.json`, true), getJson(CFG.locations),
  ]);
  if (locs) indexLocations(locs);
  S.sum = sum; S.idx = idx;
  renderStatus();
  if (!sum) {
    $('coverage').innerHTML = idx && idx.note ? `last run: ${esc(idx.note)}` : '';
    return;
  }
  renderTiles();
  renderCharts();
  drawMap(sum.fac);
  renderStates();
  renderLeaders();
  renderFolds();
  renderLocal();
  renderCoverage();
  initBrowse();
  let rt = null;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => S.draws.forEach((d) => d()), 150); });
}

main();
