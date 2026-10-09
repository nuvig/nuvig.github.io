/* Surface Analysis — surface.html
   ---------------------------------------------------------------------------
   WPC's coded surface bulletin (data/wx/sfc/, one analysis every 3 h, written
   by scripts/wxarchive.py and backfilled from IEM) drawn on the site's dark
   Leaflet map with WMO frontal symbology, a scrubber over every archived
   analysis, fading trails of the previous 12 h, low-centre tracks, station
   plots from the archived METARs at zoom, a KNAK barograph, and a label →
   value reading of what the analysis means at KANP (nearest front, which side
   of it the field is on, its motion over the last 3 h and when it gets here).

   Reads only WXA (index.json, sfc/, fieldobs/, obs/, stations/) — no weather
   API of its own — plus WPC's archived chart image for the same valid time.

   Symbology rules (the bulletin codes vertices only, no direction):
     - pips point the way a front moves: triangles toward the warm air on a
       cold front, semicircles toward the cold air on a warm front, both
       alternating on the direction-of-motion side of an occlusion, and on
       opposite sides of a stationary front
     - which side is which: a front with a low at one end moves cyclonically
       about it, so pips point LEFT walking away from the low; otherwise the
       cold side is the side of the front's chord whose normal points most
       west-and-north (the climatological rule — cold air comes from the NW)
   Both are heuristics and are said so in the chip tooltip; the WPC chart in
   the fold below the map is the authority.
--------------------------------------------------------------------------- */

'use strict';

const $ = (id) => document.getElementById(id);
const HOME = SITE.airport;
const TZ = SITE.weather.timeZone;
const D2R = Math.PI / 180;
const INITIAL_DAYS = 8, MORE_DAYS = 7;
const TRAIL_N = 4;                       // previous analyses drawn as ghosts (12 h)
const PIP_PX = 22;
const STATION_ZOOM = 8;              // the ring's stations are 10-30 nm apart
const KIND = {
  cold:  { name: 'cold front',       col: '#4a9eff' },
  warm:  { name: 'warm front',       col: '#ef4444' },
  stnry: { name: 'stationary front', col: '#4a9eff', col2: '#ef4444' },
  ocfnt: { name: 'occluded front',   col: '#c084fc' },
  trof:  { name: 'trough',           col: '#f0883e' },
};
const kindOf = (k) => KIND[k] || { name: k, col: '#aaa' };
const H_COL = '#5aa9ff', L_COL = '#f05252';
const FONT = "'Segoe UI', system-ui, Arial, sans-serif";

const S = {
  idx: null, latest: null,
  days: [],                 // sfc days, newest first
  loaded: new Set(),
  an: [],                   // analyses, oldest first
  sel: -1,
  map: null, layer: null,
  opts: { trails: true, tracks: false, stations: true },
  knak: new Map(),          // day -> KNAK metars [[t, raw]]
  obs: new Map(),           // day -> Promise<{id: metars}> (every archived station)
  playing: null,
  hover: null,
};

/* ---------------------------------------------------------------------------
   Time
--------------------------------------------------------------------------- */

const pad = (n) => String(n).padStart(2, '0');
const zHour = (t) => `${pad(new Date(t * 1000).getUTCHours())}Z`;
const zStamp = (t) => { const d = new Date(t * 1000); return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}`; };
const local = (t, o) => new Date(t * 1000).toLocaleString('en-US', Object.assign({ timeZone: TZ }, o));
const whenLabel = (t) => `${zHour(t)} · ${local(t, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
const clockLabel = (t) => local(t, { hour: 'numeric', minute: '2-digit' });
const dayOf = (t) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t * 1000));
const now = () => Date.now() / 1000;
function ago(sec) {
  if (sec < 90) return 'just now';
  if (sec < 5400) return `${Math.round(sec / 60)} min ago`;
  if (sec < 48 * 3600) return `${(sec / 3600).toFixed(sec < 10 * 3600 ? 1 : 0)} h ago`;
  return `${Math.round(sec / 86400)} d ago`;
}
const fmtN = (n) => Math.round(n).toLocaleString('en-US');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------------------------------------------------------------------------
   Geometry — nautical miles, °true, a local plane for point-to-line work
--------------------------------------------------------------------------- */

function nm(a, b) {
  const la1 = a[0] * D2R, la2 = b[0] * D2R, dla = la2 - la1, dlo = (b[1] - a[1]) * D2R;
  const h = Math.sin(dla / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dlo / 2) ** 2;
  return 2 * 3440.065 * Math.asin(Math.min(1, Math.sqrt(h)));
}
function brg(a, b) {
  const la1 = a[0] * D2R, la2 = b[0] * D2R, dlo = (b[1] - a[1]) * D2R;
  const y = Math.sin(dlo) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dlo);
  return ((Math.atan2(y, x) / D2R) + 360) % 360;
}
const COMP = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const comp = (b) => COMP[Math.round((((b % 360) + 360) % 360) / 22.5) % 16];
const latlonText = (lat, lon) => `${Math.abs(lat).toFixed(1)}${lat < 0 ? 'S' : 'N'} ${Math.abs(lon).toFixed(1)}${lon < 0 ? 'W' : 'E'}`;

/* (lat, lon) → [E, N] nm on a plane tangent at (lat0, lon0). */
function plane(lat0, lon0) {
  const k = Math.cos(lat0 * D2R) * 60;
  return (p) => [(p[1] - lon0) * k, (p[0] - lat0) * 60];
}

/* Nearest point of a polyline [[lat, lon]…] to (lat, lon): distance in nm,
   the point, the segment index, and `cross` > 0 when (lat, lon) lies to the
   LEFT of the line's direction of travel there. */
function nearestOn(poly, lat, lon) {
  const P = plane(lat, lon);
  const pts = poly.map(P);
  let best = null;
  if (pts.length === 1) best = { d: Math.hypot(pts[0][0], pts[0][1]), i: 0, t: 0, x: pts[0][0], y: pts[0][1], cross: 0 };
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    let t = l2 ? (-ax * dx - ay * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    const x = ax + t * dx, y = ay + t * dy, d = Math.hypot(x, y);
    if (!best || d < best.d) best = { d, i, t, x, y, cross: dx * (0 - ay) - dy * (0 - ax) };
  }
  best.lat = lat + best.y / 60;
  best.lon = lon + best.x / (60 * Math.cos(lat * D2R));
  return best;
}

function frontLengthNm(p) {
  let s = 0;
  for (let i = 0; i + 1 < p.length; i++) s += nm(p[i], p[i + 1]);
  return s;
}

/* Which side of a front is cold, and which side the pips go on — see the
   header comment. pipLeft is null for a stationary front (both sides). */
function frontSide(f, an) {
  const p = f.p;
  if (p.length < 2) return null;
  const nearLow = (pt) => (an.lows || []).some((l) => nm([l[1], l[2]], pt) < 110);
  const a = nearLow(p[0]), b = nearLow(p[p.length - 1]);
  const e = plane(p[0][0], p[0][1])(p[p.length - 1]);     // chord, nm E/N
  const nl = [-e[1], e[0]];                                // left normal
  let coldLeft = (-nl[0] + nl[1]) > 0;                     // W+N normal = cold side
  let pipLeft, low = false;
  if (f.k === 'stnry') pipLeft = null;
  else if ((f.k === 'cold' || f.k === 'warm' || f.k === 'ocfnt') && a !== b) {
    pipLeft = a;                                           // cyclonic about the low
    low = true;
    if (f.k === 'cold') coldLeft = !pipLeft;
    if (f.k === 'warm') coldLeft = pipLeft;
  } else if (f.k === 'warm') pipLeft = coldLeft;
  else pipLeft = !coldLeft;
  return { coldLeft, pipLeft, low };
}

/* ---------------------------------------------------------------------------
   Motion — matching features between consecutive analyses
--------------------------------------------------------------------------- */

const prevOf = (i) => (i > 0 && S.an[i].t - S.an[i - 1].t <= 6.5 * 3600 ? S.an[i - 1] : null);

const median = (arr) => { const s = arr.slice().sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : NaN; };

/* Median distance of p's vertices to polyline q — the median, because WPC
   extends or trims a front's coded end from one analysis to the next and
   a mean let a long stationary front "move" 78 kt. */
function polyMedianDist(p, q) {
  return median(p.map((pt) => nearestOn(q, pt[0], pt[1]).d));
}

function matchFront(f, prev) {
  let best = null;
  for (const g of prev.fronts) {
    if (g.k !== f.k || g.p.length < 2 || f.p.length < 2) continue;
    const m = polyMedianDist(f.p, g.p);
    if (m < 200 && (!best || m < best.m)) best = { g, m };
  }
  return best && best.g;
}

/* The front's motion over the last analysis interval: each vertex's normal
   displacement from the previous front (vertices that land on an end of the
   previous front are ignored — that is the coded extent changing, not the
   front moving), the median for speed, the mean vector for direction, and
   the component of that motion toward KANP as the closing speed (negative =
   opening). No match, or a speed no front has, is no motion. */
function frontMotion(f, cur, prev) {
  if (!prev || f.p.length < 2) return null;
  const g = matchFront(f, prev);
  if (!g) return null;
  const dt = (cur.t - prev.t) / 3600;
  const vs = [];
  for (const pt of f.p) {
    const n = nearestOn(g.p, pt[0], pt[1]);
    const atEnd = (n.i === 0 && n.t === 0) || (n.i === g.p.length - 2 && n.t === 1);
    if (atEnd && g.p.length > 2) continue;
    const v = plane(n.lat, n.lon)(pt);
    vs.push({ x: v[0], y: v[1], d: n.d });
  }
  if (vs.length < 2) return null;
  const med = median(vs.map((v) => v.d));
  const keep = vs.filter((v) => v.d <= 2 * med + 5);
  let mx = 0, my = 0;
  for (const v of keep) { mx += v.x; my += v.y; }
  mx /= keep.length; my /= keep.length;
  const spd = med / dt;
  if (spd > 70) return null;
  const nc = nearestOn(f.p, HOME.lat, HOME.lon);
  const toHome = plane(nc.lat, nc.lon)([HOME.lat, HOME.lon]);
  const L = Math.hypot(toHome[0], toHome[1]) || 1;
  const closing = (mx * toHome[0] + my * toHome[1]) / L / dt;
  return { spd, dir: (Math.atan2(mx, my) / D2R + 360) % 360, closing, dt, dCur: nc.d };
}

/* The same centre in another analysis: within what a centre can travel in
   dt hours (40 kt plus slack) and a plausible pressure change, nearest by
   distance plus a pressure penalty so a neighbouring centre of a different
   depth does not steal the match. */
function matchCentre(c, list, dt) {
  let best = null;
  for (const d of list || []) {
    const r = nm([c[1], c[2]], [d[1], d[2]]);
    const dp = Math.abs(d[0] - c[0]);
    if (r >= 40 * dt + 60 || dp > 2 * dt + 4) continue;
    const score = r + 15 * dp;
    if (!best || score < best.score) best = { score, d };
  }
  return best && best.d;
}

function centreMotion(c, key, cur, prev) {
  if (!prev) return null;
  const dt = (cur.t - prev.t) / 3600;
  const m = matchCentre(c, prev[key], dt);
  if (!m) return null;
  const dist = nm([m[1], m[2]], [c[1], c[2]]);
  return { spd: dist / dt, dir: brg([m[1], m[2]], [c[1], c[2]]), dp: c[0] - m[0], dt, pPrev: m[0] };
}

/* Where each low in analysis i has been over the last 48 h. */
function lowTracks(i) {
  const out = [];
  const a = S.an[i];
  for (const c of a.lows || []) {
    const pts = [[c[1], c[2], c[0], a.t]];
    let cur = c, j = i;
    while (j > 0 && a.t - S.an[j - 1].t <= 48 * 3600) {
      const dt = (S.an[j].t - S.an[j - 1].t) / 3600;
      if (dt > 6.5) break;
      const m = matchCentre(cur, S.an[j - 1].lows, dt);
      if (!m) break;
      pts.push([m[1], m[2], m[0], S.an[j - 1].t]);
      cur = m; j--;
    }
    if (pts.length > 1) out.push(pts);
  }
  return out;
}

/* ---------------------------------------------------------------------------
   METARs → station models
--------------------------------------------------------------------------- */

function parseMetar(raw) {
  const body = raw.split(' RMK')[0];
  const o = { raw };
  const w = body.match(/(?:^|\s)(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?KT\b/);
  if (w) { o.dir = w[1] === 'VRB' ? null : +w[1]; o.spd = +w[2]; o.gst = w[3] ? +w[3] : null; o.vrb = w[1] === 'VRB'; }
  const tg = raw.match(/\bT([01])(\d{3})([01])(\d{3})\b/);
  if (tg) { o.tC = (tg[1] === '1' ? -1 : 1) * +tg[2] / 10; o.dC = (tg[3] === '1' ? -1 : 1) * +tg[4] / 10; }
  else {
    const t2 = body.match(/\s(M?\d{2})\/(M?\d{2})\b/);
    if (t2) { o.tC = +t2[1].replace('M', '-'); o.dC = +t2[2].replace('M', '-'); }
  }
  const slp = raw.match(/\bSLP(\d{3})\b/);
  if (slp) o.slp = (+slp[1] >= 500 ? 900 : 1000) + +slp[1] / 10;
  const alt = body.match(/\bA(\d{4})\b/);
  if (alt) o.alt = +alt[1] / 100;
  let cov = 0;
  const cre = /\b(FEW|SCT|BKN|OVC|VV)(\d{3})/g;
  let c;
  while ((c = cre.exec(body))) cov = Math.max(cov, { FEW: 2, SCT: 4, BKN: 6, OVC: 8, VV: 9 }[c[1]]);
  o.cov = cov;
  o.wx = body.split(/\s+/).filter((t) => /^[-+]?(VC)?(TS|SH|FZ|MI|BC|PR|DR|BL|DZ|RA|SN|SG|IC|PL|GR|GS|UP|BR|FG|FU|VA|DU|SA|HZ|PY|PO|SQ|FC|SS|DS)+$/.test(t));
  return o;
}

function wxGlyph(wx) {
  const s = wx.join(' ');
  if (!s) return '';
  if (/TS/.test(s)) return '⚡';
  if (/FZ/.test(s)) return '~';
  if (/SN|SG|IC|PL/.test(s)) return '✱';
  if (/GR|GS/.test(s)) return '▲';
  if (/RA|DZ|SH|UP/.test(s)) return s.includes('+') ? '●●●' : s.includes('-') ? '●' : '●●';
  if (/FG/.test(s)) return '≡';
  if (/BR/.test(s)) return '=';
  if (/HZ|FU|DU|SA|VA/.test(s)) return '∞';
  return '';
}
const cToF = (c) => Math.round(c * 9 / 5 + 32);

/* The ob nearest t within ±tol s, out of [[t, raw]…]. */
function nearestOb(metars, t, tol) {
  let best = null;
  for (const m of metars || []) {
    const d = Math.abs(m[0] - t);
    if (d <= tol && (!best || d < best.d)) best = { d, t: m[0], raw: m[1] };
  }
  return best;
}

/* ---------------------------------------------------------------------------
   Canvas layer
--------------------------------------------------------------------------- */

/* Catmull-Rom through screen points → sampled polyline with arc length. */
function smooth(pts) {
  if (pts.length < 2) return pts.map((p) => [p.x, p.y]);
  const out = [[pts[0].x, pts[0].y]];
  for (let i = 0; i + 1 < pts.length; i++) {
    const p0 = pts[Math.max(i - 1, 0)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(i + 2, pts.length - 1)];
    const d = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const n = Math.max(1, Math.min(24, Math.ceil(d / 6)));
    for (let s = 1; s <= n; s++) {
      const t = s / n, t2 = t * t, t3 = t2 * t;
      out.push([
        0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      ]);
    }
  }
  return out;
}

function tracePath(ctx, sm) {
  ctx.beginPath();
  ctx.moveTo(sm[0][0], sm[0][1]);
  for (let i = 1; i < sm.length; i++) ctx.lineTo(sm[i][0], sm[i][1]);
}

function pip(ctx, x, y, nx, ny, tx, ty, shape, col) {
  ctx.fillStyle = col;
  ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  if (shape === 'tri') {
    const w = 4.5, h = 8;
    ctx.moveTo(x - tx * w, y - ty * w);
    ctx.lineTo(x + nx * h, y + ny * h);
    ctx.lineTo(x + tx * w, y + ty * w);
    ctx.closePath();
  } else {
    const a = Math.atan2(ny, nx);
    ctx.arc(x, y, 4.5, a - Math.PI / 2, a + Math.PI / 2);
    ctx.closePath();
  }
  ctx.fill();
  ctx.stroke();
}

/* Pips every PIP_PX px along the sampled front. Screen y is down, so the
   geographic LEFT of travel (dx, dy) is the normal (dy, -dx). */
function drawPips(ctx, sm, k, side) {
  const kd = kindOf(k);
  let acc = 0, next = PIP_PX / 2, n = 0;
  for (let i = 1; i < sm.length; i++) {
    const dx = sm[i][0] - sm[i - 1][0], dy = sm[i][1] - sm[i - 1][1];
    const len = Math.hypot(dx, dy);
    if (!len) continue;
    while (next <= acc + len) {
      const f = (next - acc) / len;
      const x = sm[i - 1][0] + dx * f, y = sm[i - 1][1] + dy * f;
      const tx = dx / len, ty = dy / len;
      const lx = ty, ly = -tx;                               // left normal (screen)
      let onLeft, shape, col;
      if (k === 'stnry') {
        const tri = n % 2 === 0;                             // triangles toward the warm air
        onLeft = tri ? !side.coldLeft : side.coldLeft;
        shape = tri ? 'tri' : 'semi';
        col = tri ? kd.col : kd.col2;
      } else {
        onLeft = side.pipLeft;
        shape = k === 'cold' ? 'tri' : k === 'warm' ? 'semi' : (n % 2 === 0 ? 'tri' : 'semi');
        col = kd.col;
      }
      const s = onLeft ? 1 : -1;
      pip(ctx, x, y, lx * s, ly * s, tx, ty, shape, col);
      n++;
      next += PIP_PX;
    }
    acc += len;
  }
}

function haloText(ctx, text, x, y, col, font, align = 'center') {
  ctx.font = font;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 3.5;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(0,0,0,0.8)';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = col;
  ctx.fillText(text, x, y);
}

/* A WMO station model: cover circle, wind barb (°true; feathers on the
   NH side, toward low pressure), temp / dewpoint °F left, SLP tenths right,
   present weather left-middle, the id beneath. */
function drawStation(ctx, st, x, y) {
  const o = st.ob;
  const r = 5.5;
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = '#111'; ctx.fill();
  ctx.strokeStyle = '#e5e5e5'; ctx.lineWidth = 1.3; ctx.stroke();
  if (o.cov >= 9) {
    ctx.beginPath(); ctx.moveTo(x - 3.5, y - 3.5); ctx.lineTo(x + 3.5, y + 3.5); ctx.moveTo(x + 3.5, y - 3.5); ctx.lineTo(x - 3.5, y + 3.5); ctx.stroke();
  } else if (o.cov > 0) {
    ctx.beginPath(); ctx.moveTo(x, y);
    ctx.arc(x, y, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * o.cov / 8);
    ctx.closePath(); ctx.fillStyle = '#e5e5e5'; ctx.fill();
  }
  if (o.spd != null && o.spd >= 3 && o.dir != null) {
    const a = o.dir * D2R;
    const ux = Math.sin(a), uy = -Math.cos(a);              // toward upwind (screen)
    const fx = -uy, fy = ux;                                // feathers: 90° clockwise of the staff
    const L = 26;
    const x1 = x + ux * L, y1 = y + uy * L;
    ctx.strokeStyle = '#e5e5e5'; ctx.lineWidth = 1.3;
    ctx.beginPath(); ctx.moveTo(x + ux * r, y + uy * r); ctx.lineTo(x1, y1); ctx.stroke();
    let spd = Math.round(o.spd / 5) * 5, px = x1, py = y1;
    const step = 4.5;
    const draw = (len) => { ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px + fx * len, py + fy * len); ctx.stroke(); };
    while (spd >= 50) {
      ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px + fx * 9, py + fy * 9); ctx.lineTo(px - ux * step, py - uy * step); ctx.closePath();
      ctx.fillStyle = '#e5e5e5'; ctx.fill();
      px -= ux * step * 1.3; py -= uy * step * 1.3; spd -= 50;
    }
    while (spd >= 10) { draw(9); px -= ux * step; py -= uy * step; spd -= 10; }
    if (spd >= 5) { if (px === x1 && py === y1) { px -= ux * step; py -= uy * step; } draw(4.5); }
  } else if (o.spd === 0) {
    ctx.beginPath(); ctx.arc(x, y, r + 3, 0, Math.PI * 2); ctx.strokeStyle = '#999'; ctx.lineWidth = 1; ctx.stroke();
  }
  const f = `600 11px ${FONT}`;
  if (o.tC != null) haloText(ctx, `${cToF(o.tC)}`, x - 9, y - 8, '#f6a35c', f, 'right');
  if (o.dC != null) haloText(ctx, `${cToF(o.dC)}`, x - 9, y + 8, '#6ad3c9', f, 'right');
  if (o.slp != null) haloText(ctx, pad(Math.round(o.slp * 10) % 1000).padStart(3, '0'), x + 9, y - 8, '#ddd', f, 'left');
  const g = wxGlyph(o.wx);
  if (g) haloText(ctx, g, x - 15, y, '#fff', `600 10px ${FONT}`, 'right');
  haloText(ctx, st.id, x, y + 17, '#8a8a8a', `500 9px ${FONT}`);
}

const SfcCanvas = L.Layer.extend({
  initialize() { this._scene = null; this._hits = { fronts: [], centres: [] }; },

  setScene(scene) { this._scene = scene; if (this._map) this._redraw(); },

  onAdd(map) {
    this._canvas = L.DomUtil.create('canvas', 'leaflet-zoom-animated');
    map.getPane('overlayPane').appendChild(this._canvas);
    map.on('viewreset zoomend moveend resize', this._reset, this);
    if (map.options.zoomAnimation && L.Browser.any3d) map.on('zoomanim', this._animateZoom, this);
    this._reset();
  },
  onRemove(map) {
    L.DomUtil.remove(this._canvas);
    map.off('viewreset zoomend moveend resize', this._reset, this);
    map.off('zoomanim', this._animateZoom, this);
  },
  _animateZoom(e) {
    if (!this._map._latLngBoundsToNewLayerBounds) return;
    const scale = this._map.getZoomScale(e.zoom);
    const offset = this._map._latLngBoundsToNewLayerBounds(this._map.getBounds(), e.zoom, e.center).min;
    L.DomUtil.setTransform(this._canvas, offset, scale);
  },
  _reset() {
    const size = this._map.getSize();
    const dpr = window.devicePixelRatio || 1;
    L.DomUtil.setPosition(this._canvas, this._map.containerPointToLayerPoint([0, 0]));
    this._canvas.width = Math.round(size.x * dpr);
    this._canvas.height = Math.round(size.y * dpr);
    this._canvas.style.width = `${size.x}px`;
    this._canvas.style.height = `${size.y}px`;
    this._dpr = dpr;
    this._redraw();
  },

  _pt(lat, lon) { return this._map.latLngToContainerPoint([lat, lon]); },

  _front(ctx, f, side, alpha, pips, width) {
    const size = this._map.getSize();
    const pts = f.p.map(([la, lo]) => this._pt(la, lo));
    const m = 60;
    if (pts.every((p) => p.x < -m || p.x > size.x + m || p.y < -m || p.y > size.y + m)) return null;
    const sm = smooth(pts);
    const kd = kindOf(f.k);
    ctx.globalAlpha = alpha;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.setLineDash(f.k === 'trof' ? [8, 6] : []);
    ctx.lineWidth = width + 2.5; ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    tracePath(ctx, sm); ctx.stroke();
    ctx.lineWidth = width;
    if (f.k === 'stnry' && pips) {
      ctx.setLineDash([PIP_PX, PIP_PX]);
      ctx.strokeStyle = kd.col; ctx.lineDashOffset = 0; tracePath(ctx, sm); ctx.stroke();
      ctx.strokeStyle = kd.col2; ctx.lineDashOffset = PIP_PX; tracePath(ctx, sm); ctx.stroke();
      ctx.lineDashOffset = 0;
    } else {
      ctx.strokeStyle = kd.col; tracePath(ctx, sm); ctx.stroke();
    }
    ctx.setLineDash([]);
    if (pips && f.k !== 'trof' && side) drawPips(ctx, sm, f.k, side);
    ctx.globalAlpha = 1;
    return sm;
  },

  _centre(ctx, c, letter, col, alpha, small) {
    const p = this._pt(c[1], c[2]);
    ctx.globalAlpha = alpha;
    if (small) {
      ctx.beginPath(); ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill();
    } else {
      haloText(ctx, letter, p.x, p.y, col, `800 21px ${FONT}`);
      haloText(ctx, String(c[0]), p.x, p.y + 15, '#ddd', `600 11px ${FONT}`);
    }
    ctx.globalAlpha = 1;
    return p;
  },

  _redraw() {
    const map = this._map, sc = this._scene;
    const size = map.getSize();
    const ctx = this._canvas.getContext('2d');
    ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
    ctx.clearRect(0, 0, size.x, size.y);
    this._hits = { fronts: [], centres: [] };
    if (!sc || !sc.cur) return;

    // ghosts: oldest first, faintest first
    const tr = sc.trails || [];
    tr.forEach((a, i) => {
      const alpha = 0.1 + 0.22 * (i + 1) / tr.length;
      for (const f of a.fronts) this._front(ctx, f, null, alpha, false, 1.4);
      for (const c of a.lows) this._centre(ctx, c, 'L', L_COL, alpha, true);
      for (const c of a.highs) this._centre(ctx, c, 'H', H_COL, alpha, true);
    });

    // low tracks
    for (const tk of sc.tracks || []) {
      ctx.globalAlpha = 0.8;
      ctx.lineWidth = 1.2; ctx.strokeStyle = L_COL; ctx.setLineDash([3, 3]);
      ctx.beginPath();
      tk.forEach((q, i) => { const p = this._pt(q[0], q[1]); if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); });
      ctx.stroke(); ctx.setLineDash([]);
      tk.forEach((q, i) => {
        if (!i) return;
        const p = this._pt(q[0], q[1]);
        ctx.beginPath(); ctx.arc(p.x, p.y, 2, 0, Math.PI * 2); ctx.fillStyle = L_COL; ctx.fill();
        if (i === tk.length - 1) haloText(ctx, `${q[2]} · −${Math.round((tk[0][3] - q[3]) / 3600)} h`, p.x, p.y - 9, '#c9c9c9', `500 10px ${FONT}`);
      });
      ctx.globalAlpha = 1;
    }

    // the analysis
    const a = sc.cur;
    for (const f of a.fronts) {
      if (f.k !== 'trof') continue;
      const sm = this._front(ctx, f, null, 1, false, 2);
      if (sm) this._hits.fronts.push({ f, sm });
    }
    for (const f of a.fronts) {
      if (f.k === 'trof') continue;
      const sm = this._front(ctx, f, sc.sides.get(f), 1, true, 2.5);
      if (sm) this._hits.fronts.push({ f, sm });
    }
    for (const c of a.highs) this._hits.centres.push({ c, key: 'highs', letter: 'H', p: this._centre(ctx, c, 'H', H_COL, 1, false) });
    for (const c of a.lows) this._hits.centres.push({ c, key: 'lows', letter: 'L', p: this._centre(ctx, c, 'L', L_COL, 1, false) });

    // station plots
    if (sc.stations && map.getZoom() >= STATION_ZOOM) {
      for (const st of sc.stations) { const p = this._pt(st.lat, st.lon); drawStation(ctx, st, p.x, p.y); }
    }

    // the field
    const h = this._pt(HOME.lat, HOME.lon);
    ctx.beginPath(); ctx.arc(h.x, h.y, 6, 0, Math.PI * 2);
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.7)'; ctx.stroke();
    ctx.lineWidth = 1.6; ctx.strokeStyle = '#fff'; ctx.stroke();
    if (map.getZoom() >= 5 && !(sc.stations && map.getZoom() >= STATION_ZOOM)) haloText(ctx, HOME.id, h.x, h.y + 15, '#ddd', `600 10px ${FONT}`);
  },

  /* Nearest feature to a container point: centres within 13 px, else a
     front within 9 px of its drawn path. */
  hitTest(pt) {
    let best = null;
    for (const c of this._hits.centres) {
      const d = Math.hypot(c.p.x - pt.x, c.p.y - pt.y);
      if (d < 13 && (!best || d < best.d)) best = { d, type: 'centre', c: c.c, key: c.key, letter: c.letter };
    }
    if (best) return best;
    for (const fr of this._hits.fronts) {
      for (const q of fr.sm) {
        const d = Math.hypot(q[0] - pt.x, q[1] - pt.y);
        if (d < 9 && (!best || d < best.d)) best = { d, type: 'front', f: fr.f };
      }
    }
    return best;
  },
});

/* ---------------------------------------------------------------------------
   Scene for the selected analysis
--------------------------------------------------------------------------- */

function sceneFor(i) {
  const cur = S.an[i];
  const sides = new Map();
  for (const f of cur.fronts) sides.set(f, frontSide(f, cur));
  const trails = [];
  if (S.opts.trails) {
    for (let j = i - 1; j >= 0 && i - j <= TRAIL_N; j--) {
      if (cur.t - S.an[j].t > 26 * 3600) break;
      trails.unshift(S.an[j]);
    }
  }
  return { cur, prev: prevOf(i), sides, trails, tracks: S.opts.tracks ? lowTracks(i) : [], stations: null };
}

function pushScene() {
  if (S.sel < 0 || !S.layer) return;
  const sc = sceneFor(S.sel);
  S.layer.setScene(sc);
  if (S.opts.stations && S.map.getZoom() >= STATION_ZOOM) loadStations(S.sel, sc);
}

/* Station plots: every archived station's ob nearest the valid time (±45
   min), loaded per local day the first time it is needed. */
function loadObsDay(day) {
  if (S.obs.has(day)) return S.obs.get(day);
  const ids = Object.keys(SITE.weather.stationCoords).filter((id) => id !== HOME.id);
  const p = {};
  const promise = Promise.all(ids.map(async (id) => {
    const stream = id === S.idx.station ? 'obs' : id === S.idx.field_station ? 'fieldobs' : `stations/${id}`;
    const days = id === S.idx.station ? S.idx.obs_days : id === S.idx.field_station ? S.idx.fieldobs_days : (S.idx.station_days || {})[id];
    if (!days || !days.includes(day)) return;
    const doc = await WXA.day(stream, day);
    if (doc && doc.metars) p[id] = doc.metars;
  })).then(() => p);
  S.obs.set(day, promise);
  return promise;
}

async function loadStations(i, sc) {
  const a = S.an[i];
  const obs = await loadObsDay(dayOf(a.t));
  if (S.sel !== i || S.layer._scene !== sc) return;
  const out = [];
  for (const [id, metars] of Object.entries(obs)) {
    const ob = nearestOb(metars, a.t, 45 * 60);
    const ll = SITE.weather.stationCoords[id];
    if (ob && ll) out.push({ id, lat: ll[0], lon: ll[1], ob: parseMetar(ob.raw), t: ob.t });
  }
  sc.stations = out;
  S.layer.setScene(sc);
}

/* ---------------------------------------------------------------------------
   Hover / click
--------------------------------------------------------------------------- */

function motionWords(m) {
  if (!m) return null;
  if (m.spd < 3) return 'stationary over the last 3 h';
  return `moving ${comp(m.dir)} ${Math.round(m.spd)} kt`;
}

function closingWords(m) {
  if (!m) return '';
  if (m.closing > 2) {
    const h = m.dCur / m.closing;
    return ` · closing ${Math.round(m.closing)} kt${h < 72 ? ` → KANP in ~${h < 10 ? h.toFixed(1) : Math.round(h)} h` : ''}`;
  }
  if (m.closing < -2) return ` · opening ${Math.round(-m.closing)} kt`;
  return ' · holding its distance';
}

function sideWords(f, side) {
  if (!side || side.pipLeft === undefined) return '';
  const n = nearestOn(f.p, HOME.lat, HOME.lon);
  const left = n.cross > 0;
  if (f.k === 'ocfnt') return side.pipLeft === null ? '' : (left === side.pipLeft ? 'KANP ahead of it' : 'KANP behind it');
  return left === side.coldLeft ? 'KANP on the cold side' : 'KANP on the warm side';
}

function tipFor(hit, cur, prev) {
  if (hit.type === 'centre') {
    const c = hit.c, m = centreMotion(c, hit.key, cur, prev);
    const d = nm([HOME.lat, HOME.lon], [c[1], c[2]]), b = brg([HOME.lat, HOME.lon], [c[1], c[2]]);
    return `<b>${hit.letter} ${c[0]} hPa</b><br>${latlonText(c[1], c[2])} · ${fmtN(d)} nm ${comp(b)} of KANP`
      + (m ? `<br>3 h: ${m.pPrev} → ${c[0]} hPa${m.dp ? ` (${m.dp > 0 ? '+' : ''}${m.dp})` : ''} · ${m.spd < 3 ? 'stationary' : `moved ${comp(m.dir)} ${Math.round(m.spd)} kt`}` : '');
  }
  const f = hit.f, side = frontSide(f, cur);
  const n = nearestOn(f.p, HOME.lat, HOME.lon);
  const m = frontMotion(f, cur, prev);
  const bits = [`${fmtN(n.d)} nm ${comp(brg([HOME.lat, HOME.lon], [n.lat, n.lon]))} of KANP`];
  if (f.k !== 'trof') { const sw = sideWords(f, side); if (sw) bits.push(sw); }
  let line3 = motionWords(m);
  if (line3) line3 += closingWords(m);
  return `<b>${kindOf(f.k).name}</b> · ${fmtN(frontLengthNm(f.p))} nm long<br>${bits.join(' · ')}${line3 ? `<br>${line3}` : ''}`;
}

function onHover(e) {
  if (S.sel < 0) return;
  const hit = S.layer.hitTest(e.containerPoint);
  const tip = $('tip');
  if (!hit) { tip.style.display = 'none'; S.hover = null; return; }
  tip.innerHTML = tipFor(hit, S.an[S.sel], prevOf(S.sel));
  tip.style.display = 'block';
  const wrap = $('map-wrap').getBoundingClientRect();
  let x = e.containerPoint.x + 14, y = e.containerPoint.y + 14;
  if (x + tip.offsetWidth > wrap.width - 8) x = e.containerPoint.x - tip.offsetWidth - 10;
  if (y + tip.offsetHeight > wrap.height - 8) y = e.containerPoint.y - tip.offsetHeight - 10;
  tip.style.left = `${x}px`; tip.style.top = `${y}px`;
  S.hover = hit;
}

/* ---------------------------------------------------------------------------
   At KANP — label → value
--------------------------------------------------------------------------- */

function fieldObAt(t) {
  const day = dayOf(t);
  const m = S.knak.get(day) || [];
  // the day before, for an analysis in the first hour of a local day
  const ob = nearestOb(m, t, 45 * 60) || nearestOb(S.knak.get(dayOf(t - 86400)) || [], t, 45 * 60);
  return ob ? Object.assign(parseMetar(ob.raw), { t: ob.t }) : null;
}

function renderKanp(i) {
  const a = S.an[i], prev = prevOf(i);
  $('kanp-sub').textContent = `${whenLabel(a.t)} · distances from the field · °true`;
  const fr = a.fronts.filter((f) => f.k !== 'trof' && f.p.length > 1)
    .map((f) => ({ f, n: nearestOn(f.p, HOME.lat, HOME.lon) })).sort((x, y) => x.n.d - y.n.d);
  const tr = a.fronts.filter((f) => f.k === 'trof' && f.p.length > 1)
    .map((f) => ({ f, n: nearestOn(f.p, HOME.lat, HOME.lon) })).sort((x, y) => x.n.d - y.n.d);
  const rows = [];
  const kv = (k, v) => rows.push(`<span class="k">${k}</span><span class="v">${v}</span>`);
  const where = (n) => `${fmtN(n.d)} nm ${comp(brg([HOME.lat, HOME.lon], [n.lat, n.lon]))}`;
  const frontRow = (label, x) => {
    const side = frontSide(x.f, a), m = frontMotion(x.f, a, prev);
    const sw = sideWords(x.f, side);
    let v = `<span class="${x.f.k}">${kindOf(x.f.k).name}</span> · ${where(x.n)}${sw ? ` <span class="f">· ${sw.replace('KANP ', '')}</span>` : ''}`;
    const mw = motionWords(m);
    if (mw) v += `<br><span class="f">${mw}${closingWords(m)}</span>`;
    else if (prev) v += '<br><span class="f">no match in the previous analysis</span>';
    kv(label, v);
  };
  if (fr.length) {
    frontRow('nearest front', fr[0]);
    const second = fr.find((x) => x.f.k !== fr[0].f.k);
    if (second && second.n.d < 900) frontRow('next', second);
  } else kv('nearest front', '<span class="f">none coded</span>');
  if (tr.length && tr[0].n.d < 600) kv('trough', where(tr[0].n));
  const cen = (list, letter) => {
    let best = null;
    for (const c of list || []) { const d = nm([HOME.lat, HOME.lon], [c[1], c[2]]); if (!best || d < best.d) best = { c, d }; }
    if (!best) return '<span class="f">none coded</span>';
    const m = centreMotion(best.c, letter === 'L' ? 'lows' : 'highs', a, prev);
    const b = brg([HOME.lat, HOME.lon], [best.c[1], best.c[2]]);
    return `<span style="color:${letter === 'L' ? L_COL : H_COL};font-weight:700">${letter}</span> ${best.c[0]} hPa · ${fmtN(best.d)} nm ${comp(b)}`
      + (m ? ` <span class="f">· ${m.dp ? `${m.dp > 0 ? '+' : ''}${m.dp} hPa / 3 h` : 'steady'}${m.spd >= 3 ? ` · ${comp(m.dir)} ${Math.round(m.spd)} kt` : ''}</span>` : '');
  };
  kv('nearest low', cen(a.lows, 'L'));
  kv('nearest high', cen(a.highs, 'H'));
  $('kv-fronts').innerHTML = rows.join('');

  // the field's own sensor at the valid time
  const f = [];
  const fkv = (k, v) => f.push(`<span class="k">${k}</span><span class="v">${v}</span>`);
  const ob = fieldObAt(a.t);
  const st = S.idx.field_station || 'KNAK';
  if (ob) {
    const p = ob.slp != null ? `${ob.slp.toFixed(1)} hPa` : ob.alt != null ? `${(ob.alt * 33.8639).toFixed(1)} hPa <span class="f">(altimeter)</span>` : '—';
    fkv(`${st} ${clockLabel(ob.t)}`, p);
    const ob3 = fieldObAt(a.t - 3 * 3600);
    if (ob3 && ob.slp != null && ob3.slp != null) {
      const d = ob.slp - ob3.slp;
      fkv('3 h tendency', `${d > 0 ? '+' : ''}${d.toFixed(1)} hPa <span class="f">${Math.abs(d) < 0.3 ? 'steady' : d > 0 ? 'rising' : 'falling'}${Math.abs(d) >= 3 ? ' · fast' : ''}</span>`);
    } else fkv('3 h tendency', '<span class="f">no SLP 3 h earlier</span>');
    fkv('wind', ob.spd == null ? '—' : ob.spd === 0 ? 'calm' : `${ob.vrb ? 'VRB' : pad(ob.dir).padStart(3, '0') + '°'} ${ob.spd} kt${ob.gst ? ` G${ob.gst}` : ''}`);
    if (ob.tC != null) fkv('temp / dew', `${cToF(ob.tC)} / ${cToF(ob.dC)} °F <span class="f">${ob.tC} / ${ob.dC} °C</span>`);
    const g = wxGlyph(ob.wx);
    fkv('sky', `${['clear', '', 'few', '', 'scattered', '', 'broken', '', 'overcast', 'obscured'][ob.cov] || '—'}${ob.wx.length ? ` · ${ob.wx.join(' ')}${g ? ` ${g}` : ''}` : ''}`);
  } else fkv(`${st} ob`, '<span class="f">none archived within 45 min</span>');
  $('kv-field').innerHTML = f.join('');
}

/* ---------------------------------------------------------------------------
   Barograph — KNAK sea-level pressure over the loaded window
--------------------------------------------------------------------------- */

const BARO = { pts: [], x0: 0, x1: 1, px: null };

function baroSeries() {
  const out = [];
  for (const day of [...S.knak.keys()].sort()) {
    for (const [t, raw] of S.knak.get(day)) {
      const o = parseMetar(raw);
      if (o.slp != null) out.push([t, o.slp]);
    }
  }
  out.sort((a, b) => a[0] - b[0]);
  return out;
}

function drawBaro() {
  const cv = $('baro');
  const card = $('baro-card');
  if (!S.an.length) return;
  const pts = baroSeries();
  BARO.pts = pts;
  if (pts.length < 3) { card.hidden = true; return; }
  card.hidden = false;
  const W = cv.clientWidth, H = cv.clientHeight;
  if (!W || !H) return;
  const dpr = window.devicePixelRatio || 1;
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const L = 44, R = 10, T = 14, B = 22;
  const t0 = S.an[0].t - 3600, t1 = S.an[S.an.length - 1].t + 3600;
  BARO.x0 = t0; BARO.x1 = t1;
  const vis = pts.filter((p) => p[0] >= t0 && p[0] <= t1);
  if (vis.length < 3) { card.hidden = true; return; }
  let lo = Infinity, hi = -Infinity;
  for (const p of vis) { if (p[1] < lo) lo = p[1]; if (p[1] > hi) hi = p[1]; }
  const padP = Math.max(1, (hi - lo) * 0.1); lo -= padP; hi += padP;
  const X = (t) => L + (t - t0) / (t1 - t0) * (W - L - R);
  const Y = (p) => T + (hi - p) / (hi - lo) * (H - T - B);
  BARO.X = X; BARO.Y = Y;
  // ticks: the step from the 1/2/5 ladder that gives 3-6 labels
  let step = 1;
  for (const s of [1, 2, 4, 5, 10, 20]) { step = s; if ((hi - lo) / s <= 6) break; }
  ctx.font = `11px ${FONT}`; ctx.fillStyle = '#777'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  ctx.strokeStyle = '#262626'; ctx.lineWidth = 1;
  for (let p = Math.ceil(lo / step) * step; p <= hi; p += step) {
    const y = Y(p);
    ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(W - R, y); ctx.stroke();
    ctx.fillText(p.toFixed(0), L - 6, y);
  }
  // day boundaries; labels thin out as the window grows (every day needs ~40 px)
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  const pxDay = (W - L - R) / ((t1 - t0) / 86400);
  const every = pxDay >= 40 ? 1 : pxDay >= 14 ? 3 : 7;
  let nd = 0;
  for (let t = t0; t <= t1; t += 3600) {
    const h = +local(t, { hour: 'numeric', hour12: false });
    const m = +local(t, { minute: 'numeric' });
    if (h === 0 && m === 0) {
      const x = X(t);
      ctx.strokeStyle = '#333'; ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, H - B); ctx.stroke();
      if (nd++ % every === 0) { ctx.fillStyle = '#777'; ctx.fillText(local(t, { month: 'short', day: 'numeric' }), x + 3, H - 6); }
    }
  }
  // analyses along the top; a front within 60 nm = a coloured tick
  for (const a of S.an) {
    const x = X(a.t);
    ctx.strokeStyle = '#3a3a3a'; ctx.beginPath(); ctx.moveTo(x, T - 8); ctx.lineTo(x, T - 4); ctx.stroke();
    let best = null;
    for (const f of a.fronts) {
      if (f.k === 'trof' || f.p.length < 2) continue;
      const n = nearestOn(f.p, HOME.lat, HOME.lon);
      if (n.d <= 60 && (!best || n.d < best.d)) best = { d: n.d, k: f.k };
    }
    if (best) { ctx.strokeStyle = kindOf(best.k).col; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x, T - 10); ctx.lineTo(x, T - 2); ctx.stroke(); ctx.lineWidth = 1; }
  }
  // the trace, broken at gaps > 1.5 h
  ctx.strokeStyle = '#6ad3c9'; ctx.lineWidth = 1.6; ctx.lineJoin = 'round';
  ctx.beginPath();
  let prev = null;
  for (const p of vis) {
    const x = X(p[0]), y = Y(p[1]);
    if (!prev || p[0] - prev > 5400) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    prev = p[0];
  }
  ctx.stroke();
  // selected analysis
  if (S.sel >= 0) {
    const x = X(S.an[S.sel].t);
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(x, T - 2); ctx.lineTo(x, H - B); ctx.stroke(); ctx.setLineDash([]);
  }
  // hover
  if (BARO.px != null) {
    const t = t0 + (BARO.px - L) / (W - L - R) * (t1 - t0);
    let near = null;
    for (const p of vis) if (!near || Math.abs(p[0] - t) < Math.abs(near[0] - t)) near = p;
    if (near) {
      const x = X(near[0]), y = Y(near[1]);
      ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
      $('baro-read').textContent = `${whenLabel(near[0])} → ${near[1].toFixed(1)} hPa`;
    }
  } else $('baro-read').textContent = `${vis.length} obs · ${vis[0][1] <= vis[vis.length - 1][1] ? '' : ''}low ${Math.min(...vis.map((p) => p[1])).toFixed(1)} · high ${Math.max(...vis.map((p) => p[1])).toFixed(1)} hPa · click → that analysis`;
}

function baroHover(e) {
  const r = $('baro').getBoundingClientRect();
  BARO.px = e == null ? null : e.clientX - r.left;
  drawBaro();
}

function baroClick(e) {
  const r = $('baro').getBoundingClientRect();
  const W = r.width, L = 44, R = 10;
  const t = BARO.x0 + (e.clientX - r.left - L) / (W - L - R) * (BARO.x1 - BARO.x0);
  let bi = -1, bd = Infinity;
  S.an.forEach((a, i) => { const d = Math.abs(a.t - t); if (d < bd) { bd = d; bi = i; } });
  if (bi >= 0) select(bi);
}

/* ---------------------------------------------------------------------------
   Features fold, chart fold
--------------------------------------------------------------------------- */

function renderFeatures(i) {
  const a = S.an[i], prev = prevOf(i);
  const rows = [];
  for (const [key, letter, col] of [['lows', 'L', L_COL], ['highs', 'H', H_COL]]) {
    for (const c of a[key] || []) {
      const d = nm([HOME.lat, HOME.lon], [c[1], c[2]]);
      const m = centreMotion(c, key, a, prev);
      rows.push({ d, lat: c[1], lon: c[2], html: `<td><span style="color:${col};font-weight:700">${letter}</span> ${c[0]} hPa</td><td>${latlonText(c[1], c[2])}</td><td>${fmtN(d)} nm ${comp(brg([HOME.lat, HOME.lon], [c[1], c[2]]))}</td><td>${m ? `${m.dp ? `${m.dp > 0 ? '+' : ''}${m.dp} hPa` : 'steady'}${m.spd >= 3 ? ` · ${comp(m.dir)} ${Math.round(m.spd)} kt` : ''}` : '—'}</td>` });
    }
  }
  for (const f of a.fronts) {
    if (f.p.length < 2) continue;
    const n = nearestOn(f.p, HOME.lat, HOME.lon);
    const m = frontMotion(f, a, prev);
    rows.push({ d: n.d, lat: n.lat, lon: n.lon, html: `<td><span style="color:${kindOf(f.k).col}">${kindOf(f.k).name}</span></td><td>${fmtN(frontLengthNm(f.p))} nm long</td><td>${fmtN(n.d)} nm ${comp(brg([HOME.lat, HOME.lon], [n.lat, n.lon]))}</td><td>${m ? (m.spd < 3 ? 'stationary' : `${comp(m.dir)} ${Math.round(m.spd)} kt`) + (m.closing > 2 ? ` · closing ${Math.round(m.closing)} kt` : m.closing < -2 ? ` · opening ${Math.round(-m.closing)} kt` : '') : '—'}</td>` });
  }
  rows.sort((x, y) => x.d - y.d);
  const nf = a.fronts.filter((f) => f.k !== 'trof').length, nt = a.fronts.length - nf;
  $('feat-sub').textContent = `${a.highs.length} H · ${a.lows.length} L · ${nf} front${nf === 1 ? '' : 's'} · ${nt} trough${nt === 1 ? '' : 's'} · nearest first`;
  $('feat-list').innerHTML = `<table class="t"><thead><tr><th>feature</th><th></th><th>from KANP</th><th>last 3 h</th></tr></thead><tbody>${rows.map((r) => `<tr data-ll="${r.lat},${r.lon}">${r.html}</tr>`).join('')}</tbody></table>`;
  $('feat-list').querySelectorAll('tr[data-ll]').forEach((tr) => tr.addEventListener('click', () => {
    const [la, lo] = tr.dataset.ll.split(',').map(Number);
    S.map.panTo([la, lo]);
  }));
}

function renderChart(i) {
  const a = S.an[i];
  const stamp = zStamp(a.t), year = stamp.slice(0, 4);
  $('chart-sub').textContent = `valid ${whenLabel(a.t)}`;
  const img = $('chart-img');
  const fresh = now() - a.t < 24 * 3600;
  const bulletin = fresh
    ? `https://www.wpc.ncep.noaa.gov/discussions/codsus${zHour(a.t).slice(0, 2)}_hr`
    : `https://mesonet.agron.iastate.edu/wx/afos/p.php?pil=CODSUS&e=${stamp}00`;
  const links = `US fronts → <a href="https://www.wpc.ncep.noaa.gov/archives/sfc/${year}/usfntsfc${stamp}.gif">WPC</a> · North America → <a href="https://www.wpc.ncep.noaa.gov/archives/sfc/${year}/namussfc${stamp}.gif">WPC</a> · coded bulletin → <a href="${bulletin}">${fresh ? 'WPC' : 'IEM'}</a> · current chart → <a href="https://www.wpc.ncep.noaa.gov/html/sfc2.shtml">WPC</a>`;
  if (!$('chart-fold').open) { img.hidden = true; img.removeAttribute('src'); $('chart-note').innerHTML = links; return; }
  img.hidden = false;
  img.onerror = () => { img.hidden = true; $('chart-note').innerHTML = `not in WPC's archive for this hour · ${links}`; };
  img.onload = () => { $('chart-note').innerHTML = links; };
  img.src = `https://www.wpc.ncep.noaa.gov/archives/sfc/${year}/usfntsfc${stamp}.gif`;
  $('chart-note').innerHTML = `loading… · ${links}`;
}

/* ---------------------------------------------------------------------------
   Selection, status, loading
--------------------------------------------------------------------------- */

function select(i, keepHash) {
  if (!S.an.length) return;
  i = Math.max(0, Math.min(S.an.length - 1, i));
  S.sel = i;
  const a = S.an[i];
  $('scrub').max = S.an.length - 1;
  $('scrub').value = i;
  $('prev').disabled = i === 0;
  $('next').disabled = i === S.an.length - 1;
  const age = now() - a.t;
  $('when').innerHTML = `<span class="z">${zHour(a.t)}</span> <span class="lo">${local(a.t, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span> <span class="age">· ${ago(age)}${a.bf ? ' · IEM' : ''}</span>`;
  pushScene();
  renderKanp(i);
  renderFeatures(i);
  renderChart(i);
  drawBaro();
  if (!keepHash) history.replaceState(null, '', `#t=${a.t}`);
}

function renderStatus() {
  const bar = $('status');
  if (!S.an.length) { bar.innerHTML = '<span class="warn">nothing archived yet</span>'; return; }
  const newest = S.an[S.an.length - 1];
  const age = now() - newest.t;
  const days = S.loaded.size;
  const first = S.days[S.days.length - 1];
  const warn = age > 7 * 3600 ? ' class="warn"' : '';
  bar.innerHTML = `<span>newest → <b${warn}>${whenLabel(newest.t)}</b> <span${warn}>(${ago(age)})</span></span>`
    + `<span>issued → <b>${newest.i ? clockLabel(newest.i) : '—'}</b></span>`
    + `<span>loaded → <b>${S.an.length}</b> analyses · ${days} day${days === 1 ? '' : 's'}</span>`
    + `<span>archive → <b>${S.days.length}</b> days since ${first}</span>`
    + `<span>source → <b>WPC</b> · ${newest.hr ? '0.1°' : '1°'}</span>`;
  $('since').textContent = first ? local(new Date(first + 'T12:00:00').getTime() / 1000, { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
  $('more').disabled = S.loaded.size >= S.days.length;
  $('more-note').textContent = S.loaded.size >= S.days.length ? 'the whole archive is loaded' : `${S.days.length - S.loaded.size} more day${S.days.length - S.loaded.size === 1 ? '' : 's'} archived`;
}

function mergeAnalyses(list) {
  const byT = new Map(S.an.map((a) => [a.t, a]));
  for (const a of list) {
    const ex = byT.get(a.t);
    if (!ex || (a.hr || 0) > (ex.hr || 0) || ((a.hr || 0) === (ex.hr || 0) && (a.i || 0) > (ex.i || 0))) byT.set(a.t, a);
  }
  S.an = [...byT.values()].sort((a, b) => a.t - b.t);
}

async function loadDays(days) {
  const fresh = days.filter((d) => !S.loaded.has(d));
  if (!fresh.length) return 0;
  const docs = await Promise.all(fresh.map(async (d) => {
    const [sfc, fo] = await Promise.all([
      WXA.day('sfc', d),
      (S.idx.fieldobs_days || []).includes(d) ? WXA.day('fieldobs', d) : Promise.resolve(null),
    ]);
    return { d, sfc, fo };
  }));
  const all = [];
  for (const { d, sfc, fo } of docs) {
    S.loaded.add(d);
    if (sfc && sfc.analyses) all.push(...sfc.analyses);
    if (fo && fo.metars) S.knak.set(d, fo.metars);
  }
  mergeAnalyses(all);
  return all.length;
}

async function loadMore() {
  const next = S.days.filter((d) => !S.loaded.has(d)).slice(0, MORE_DAYS);
  if (!next.length) return;
  $('more').disabled = true;
  const sel = S.sel >= 0 ? S.an[S.sel].t : null;
  await loadDays(next);
  renderStatus();
  const i = sel == null ? S.an.length - 1 : S.an.findIndex((a) => a.t === sel);
  select(Math.max(0, i), true);
}

/* Live: when the archive's newest analysis moves past what is loaded,
   re-read today's (and yesterday's, across midnight) day file. */
async function poll() {
  WXA._cache.delete('latest.json');
  const latest = await WXA.latest();
  if (!latest || !latest.sfc) return;
  const newest = S.an.length ? S.an[S.an.length - 1].t : 0;
  if (latest.sfc.t <= newest) return;
  WXA._cache.delete('index.json');
  S.idx = (await WXA.index()) || S.idx;
  S.days = (S.idx.sfc_days || []).slice().reverse();
  const follow = S.sel === S.an.length - 1;
  const today = dayOf(latest.sfc.t), yday = dayOf(latest.sfc.t - 86400);
  for (const d of [today, yday]) { WXA._cache.delete(`sfc/${d}.json`); WXA._cache.delete(`fieldobs/${d}.json`); S.loaded.delete(d); }
  await loadDays([today, yday].filter((d) => S.days.includes(d)));
  renderStatus();
  if (follow) select(S.an.length - 1); else select(S.sel, true);
}

/* ---------------------------------------------------------------------------
   Map, controls, boot
--------------------------------------------------------------------------- */

function buildMap() {
  const map = L.map($('map'), { worldCopyJump: false, zoomSnap: 0.5, minZoom: 2 });
  L.tileLayer(`https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png?key=${SITE.basemap.cartoKey}`, {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a> · fronts &copy; NWS/WPC',
    subdomains: 'abcd', maxZoom: 19 }).addTo(map);
  map.fitBounds([[24.5, -110], [49.5, -62]]);
  S.map = map;
  S.layer = new SfcCanvas().addTo(map);
  map.on('mousemove', onHover);
  map.on('mouseout', () => { $('tip').style.display = 'none'; });
  map.on('zoomend', () => { if (S.opts.stations && map.getZoom() >= STATION_ZOOM && S.layer._scene && !S.layer._scene.stations) loadStations(S.sel, S.layer._scene); });
  map.on('click', onHover);
}

function setChip(id, on) { $(id).classList.toggle('on', !!on); }

function wireControls() {
  $('scrub').addEventListener('input', () => select(+$('scrub').value));
  $('prev').addEventListener('click', () => select(S.sel - 1));
  $('next').addEventListener('click', () => select(S.sel + 1));
  $('now').addEventListener('click', () => select(S.an.length - 1));
  $('play').addEventListener('click', togglePlay);
  $('more').addEventListener('click', loadMore);
  for (const k of ['trails', 'tracks', 'stations']) {
    setChip(`chip-${k}`, S.opts[k]);
    $(`chip-${k}`).addEventListener('click', () => {
      S.opts[k] = !S.opts[k];
      setChip(`chip-${k}`, S.opts[k]);
      try { localStorage.setItem('surface_opts', JSON.stringify(S.opts)); } catch (e) { /* private mode */ }
      pushScene();
    });
  }
  $('chart-fold').addEventListener('toggle', () => { if (S.sel >= 0) renderChart(S.sel); });
  const cv = $('baro');
  cv.addEventListener('mousemove', baroHover);
  cv.addEventListener('mouseleave', () => baroHover(null));
  cv.addEventListener('click', baroClick);
  window.addEventListener('resize', () => drawBaro());
  document.addEventListener('keydown', (e) => {
    if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    if (e.key === 'ArrowLeft') { select(S.sel - 1); e.preventDefault(); }
    else if (e.key === 'ArrowRight') { select(S.sel + 1); e.preventDefault(); }
    else if (e.key === ' ') { togglePlay(); e.preventDefault(); }
  });
}

function togglePlay() {
  if (S.playing) { clearInterval(S.playing); S.playing = null; $('play').textContent = '▶'; return; }
  $('play').textContent = '❚❚';
  S.playing = setInterval(() => select(S.sel >= S.an.length - 1 ? 0 : S.sel + 1), 450);
}

async function init() {
  try { Object.assign(S.opts, JSON.parse(localStorage.getItem('surface_opts') || '{}')); } catch (e) { /* ignore */ }
  wireControls();
  const [idx, latest] = await Promise.all([WXA.index(), WXA.latest()]);
  S.idx = idx || {};
  S.latest = latest;
  S.days = (S.idx.sfc_days || []).slice().reverse();
  if (!S.days.length) { renderStatus(); $('kanp-card').hidden = true; return; }
  // #t= older than the first window: load back to its day (up to 60 days)
  const m = location.hash.match(/#t=(\d+)/);
  const want = m ? +m[1] : null;
  let first = S.days.slice(0, INITIAL_DAYS);
  if (want) {
    const wd = dayOf(want);
    const k = S.days.indexOf(wd);
    if (k >= INITIAL_DAYS && k < 60) first = S.days.slice(0, k + 1);
  }
  await loadDays(first);
  buildMap();
  renderStatus();
  let i = S.an.length - 1;
  if (want) { const j = S.an.findIndex((a) => a.t === want); if (j >= 0) i = j; }
  select(i, true);
  setInterval(poll, 5 * 60 * 1000);
}

window.SURFACE_DEBUG = { S, frontSide, nearestOn, parseMetar, frontMotion, matchFront, lowTracks, select, sceneFor };

init().catch((e) => { console.error(e); $('status').innerHTML = `<span class="warn">failed to load: ${esc(e.message || e)}</span>`; });
