/* ---------------------------------------------------------------------------
   KANP Weather Hub — jesselevine.net/weather.html
   All data fetched client-side from CORS-enabled public APIs:
     - api.weather.gov          METARs (latest obs), TAFs (IWXXM), forecast, alerts
     - api.open-meteo.com       hourly model forecast + winds aloft at KANP
     - api.rainviewer.com       animated radar frames (IEM NEXRAD fallback)
   No keys, no backend. Directions are °true throughout (runway alignments are
   FAA true headings, METAR/model winds are true), so components are consistent.
   --------------------------------------------------------------------------- */
(() => {
'use strict';

/* ============================== config =================================== */

// Home airport, nearby fields, TAF stations, and timezone all come from
// SITE (js/site-config.js) — edit them there. Runway hdg = FAA true
// alignment; METAR + model winds are also true.
const KANP = SITE.airport;   // home airport (historical name; any field works)
// Fields flagged `offline` in the config (sensor down for a while) are left
// out entirely rather than shown as an error every refresh.
const AIRPORTS = [SITE.airport, ...SITE.weather.nearbyAirports.filter((a) => !a.offline)];
const TAF_STATIONS = SITE.weather.tafStations;

const NWS = 'https://api.weather.gov';
const REFRESH_MS = 5 * 60 * 1000;
const TZ = SITE.weather.timeZone;

/* =============================== state =================================== */

const state = {
  metars: {},     // station id -> parsed metar (or {error})
  om: null,       // open-meteo payload
  grid: null,     // NWS forecast grid, expanded to per-hour Maps
  sun: null,      // today's solar times
  fly: null,      // flyability hours
  alerts: null,
  outlook: null,
  tafs: {},
  errors: [],
  wash: null, washIdx: 0,   // the page tint currently shown (see renderSkyWash)
  gen: 0, liveGen: 0,       // load generation; liveGen = last one the live sources rendered
};

/* =============================== utils =================================== */

const $ = (id) => document.getElementById(id);
const rad = (d) => (d * Math.PI) / 180;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const cToF = (c) => c * 9 / 5 + 32;
const round = Math.round;

// Relative humidity from temp/dewpoint (Magnus, over water). METAR T/Td are whole
// degrees C, so this lands within a couple of percent — good enough to read at a glance.
function relHumidity(tempC, dewC) {
  if (tempC == null || dewC == null) return null;
  const es = (t) => 6.112 * Math.exp((17.67 * t) / (t + 243.5));
  return Math.max(0, Math.min(100, (100 * es(dewC)) / es(tempC)));
}

function fmtTime(d, opts) {
  return new Date(d).toLocaleTimeString('en-US',
    Object.assign({ timeZone: TZ, hour: 'numeric', minute: '2-digit' }, opts));
}
// Date + time in the field's zone ("Sun 6:57 PM") — for stamps that may not be today's.
function fmtDT(d, opts) {
  return new Intl.DateTimeFormat('en-US', Object.assign({ timeZone: TZ }, opts)).format(new Date(d));
}
const localDay = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: TZ });
function ageText(min) {
  if (min < 60) return `${min} min ago`;
  if (min < 36 * 60) return `${(min / 60).toFixed(min < 600 ? 1 : 0).replace(/\.0$/, '')} h ago`;
  return `${Math.round(min / 1440)} d ago`;
}

// Density altitude, NWS method with humidity — the same formulas airlab.js and
// almanac.js use, so a number here matches the same hour in the almanac. Moist
// air is lighter than dry air at the same temperature and pressure, so a humid
// summer afternoon reads a few hundred feet higher than the dry approximation.
const satVapHpa = (tC) => 6.1078 * Math.pow(10, 7.5 * tC / (tC + 237.3));   // Tetens
function densityAltFt(tC, dC, altimInHg, elevFt) {
  const k = 0.190284;
  const pHpa = Math.pow(Math.pow(altimInHg, k) - 1.313e-5 * elevFt, 1 / k) * 33.8639;
  const e = dC == null ? 0 : satVapHpa(Math.min(dC, tC));
  const T = tC + 273.15;
  const rho = (100 * (pHpa - e)) / (287.05 * T) + (100 * e) / (461.495 * T);
  return 145442.16 * (1 - Math.pow(rho / 1.225, 0.234969));
}

// NWS encodes TAF visibility in meters from a fixed SM table — decode through
// the table, never by dividing by 1609: 4800 m is 3 SM (MVFR), not 2.98 (IFR).
const VIS_SM = [[400, 0.25], [800, 0.5], [1200, 0.75], [1600, 1], [2400, 1.5],
  [3200, 2], [4800, 3], [6000, 4], [8000, 5], [9000, 6], [9999, 6], [16000, 6]];
function visSMfromM(m) {
  if (m == null) return null;
  for (const [mm, sm] of VIS_SM) if (Math.abs(m - mm) <= 100) return sm;
  return m / 1609.34;
}
function fmtHour(d) { // "2 PM" -> "2p"
  const h = new Date(d).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', hour12: true });
  return h.replace(' AM', 'a').replace(' PM', 'p').replace(' ', '');
}
function ageMin(iso) { return round((Date.now() - new Date(iso).getTime()) / 60000); }

async function fetchJSON(url) {
  const res = await fetch(url, { headers: { Accept: 'application/geo+json, application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url.split('/')[2]}`);
  return res.json();
}

/* ========================= solar (NOAA equations) ======================== */
// Accurate to ~1 min. zenith 90.833° = sunrise/sunset, 96° = civil twilight.
function solarTimes(date, lat, lon) {
  // Anchor on the calendar day *at the airport* (TZ), not the viewer's browser
  // timezone. Using browser-local Y/M/D here put the UTC-midnight base a day off
  // for viewers west of the airport, pushing dawn/dusk outside the scored window
  // so every hour read as night.
  const [y, mo, d] = date.toLocaleDateString('en-CA', { timeZone: TZ }).split('-').map(Number);
  const base = Date.UTC(y, mo - 1, d); // 00:00 UTC of that calendar day
  const doy = Math.floor((base - Date.UTC(y, 0, 0)) / 86400000);
  const g = (2 * Math.PI / 365) * (doy - 1 + 0.5);
  const eqtime = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g)
    - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g)
    - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g)
    - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const utcMin = (zen, rising) => {
    const cosH = (Math.cos(rad(zen)) / (Math.cos(rad(lat)) * Math.cos(decl)))
      - Math.tan(rad(lat)) * Math.tan(decl);
    if (cosH > 1 || cosH < -1) return null;
    const ha = (Math.acos(cosH) * 180 / Math.PI) * (rising ? 1 : -1);
    return 720 - 4 * (lon + ha) - eqtime;
  };
  const mk = (min) => min == null ? null : new Date(base + min * 60000);
  return {
    dawn: mk(utcMin(96, true)),
    sunrise: mk(utcMin(90.833, true)),
    sunset: mk(utcMin(90.833, false)),
    dusk: mk(utcMin(96, false)),
  };
}

/* ============================ METAR parsing ============================== */

function parseMetar(raw, timestamp) {
  const m = { raw, time: timestamp, clouds: [], wx: [] };
  const body = raw.split(' RMK')[0].replace(/\s+/g, ' ');

  const w = body.match(/\b(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?KT\b/);
  if (w) {
    m.windVrb = w[1] === 'VRB';
    m.windDir = m.windVrb ? null : +w[1];
    m.windKt = +w[2];
    m.gustKt = w[3] ? +w[3] : null;
  }
  const vv = body.match(/\bVV(\d{3})\b/);
  const vis = body.match(/\b(?:(\d{1,2}) )?(?:M)?(?:(\d)\/(\d{1,2}))SM\b/) || body.match(/\b(\d{1,2})SM\b/);
  if (vis) {
    m.visSM = vis[2] ? (+(vis[1] || 0) + (+vis[2] / +vis[3])) : +vis[1];
  }
  for (const c of body.matchAll(/\b(FEW|SCT|BKN|OVC)(\d{3})(CB|TCU)?\b/g)) {
    m.clouds.push({ amt: c[1], baseFt: +c[2] * 100, cb: c[3] || '' });
  }
  if (vv) m.clouds.push({ amt: 'VV', baseFt: +vv[1] * 100, cb: '' });
  if (/\b(CLR|SKC)\b/.test(body)) m.clear = true;
  const t = body.match(/ (M?\d{2})\/(M?\d{2})( |$)/);
  if (t) {
    m.tempC = +t[1].replace('M', '-');
    m.dewC = +t[2].replace('M', '-');
  }
  const a = body.match(/\bA(\d{4})\b/);
  if (a) m.altInHg = +a[1] / 100;
  for (const wx of body.matchAll(/(?:^| )([+-]?(?:VC)?(?:TS|SH|FZ|DR|BL|MI|BC|PR)?(?:DZ|RA|SN|SG|IC|PL|GR|GS|UP|BR|FG|FU|VA|DU|SA|HZ|PO|SQ|FC|SS|DS)+)(?= |$)/g)) {
    m.wx.push(wx[1]);
  }
  return m;
}

function ceilingFt(metar) {
  let ceil = null;
  for (const c of metar.clouds) {
    if (c.amt === 'BKN' || c.amt === 'OVC' || c.amt === 'VV') {
      if (ceil == null || c.baseFt < ceil) ceil = c.baseFt;
    }
  }
  return ceil;
}

const CAT_COLORS = { VFR: '#22c55e', MVFR: '#4a9eff', IFR: '#ef4444', LIFR: '#c026d3' };
function flightCat(visSM, ceilFt) {
  const v = visSM == null ? 99 : visSM;
  const c = ceilFt == null ? 99999 : ceilFt;
  if (v < 1 || c < 500) return 'LIFR';
  if (v < 3 || c < 1000) return 'IFR';
  if (v <= 5 || c <= 3000) return 'MVFR';
  return 'VFR';
}

/* ========================== wind ↔ runway math =========================== */

// Both directions °true. cross > 0 = wind from the right.
function windComponents(windDir, kt, rwyHdg) {
  const d = rad(((windDir - rwyHdg + 540) % 360) - 180);
  return { head: kt * Math.cos(d), cross: kt * Math.sin(d) };
}

// Pick the runway end with the best headwind; ties broken by length.
function bestEnd(airport, windDir, kt) {
  let best = null;
  for (const rwy of airport.runways) {
    for (const end of rwy.ends) {
      const c = windComponents(windDir, kt, end.hdg);
      if (!best || c.head > best.head + 0.01 ||
          (Math.abs(c.head - best.head) <= 0.01 && rwy.len > best.len)) {
        best = { end: end.name, hdg: end.hdg, len: rwy.len, head: c.head, cross: c.cross };
      }
    }
  }
  return best;
}

/* ============================ compass SVG ================================ */

const ROSE_LBL = ['N', '3', '6', 'E', '12', '15', 'S', '21', '24', 'W', '30', '33'];

function compassSVG(airport, metar, size) {
  const big = size > 200;
  let ticks = '';
  for (let d = 0; d < 360; d += 10) {
    const major = d % 30 === 0;
    const r1 = major ? 92 : 96, r2 = 100;
    const x1 = r1 * Math.sin(rad(d)), y1 = -r1 * Math.cos(rad(d));
    const x2 = r2 * Math.sin(rad(d)), y2 = -r2 * Math.cos(rad(d));
    ticks += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${major ? '#555' : '#333'}" stroke-width="${major ? 1.6 : 1}"/>`;
    if (major && big) {
      const lx = 82 * Math.sin(rad(d)), ly = -82 * Math.cos(rad(d));
      ticks += `<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" fill="#666" font-size="10" text-anchor="middle" dominant-baseline="central">${ROSE_LBL[d / 30]}</text>`;
    }
  }
  if (!big) { // just cardinal letters on minis
    for (let i = 0; i < 4; i++) {
      const d = i * 90;
      const lx = 80 * Math.sin(rad(d)), ly = -80 * Math.cos(rad(d));
      ticks += `<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" fill="#555" font-size="13" text-anchor="middle" dominant-baseline="central">${'NESW'[i]}</text>`;
    }
  }

  let rwys = '';
  for (const rwy of airport.runways) {
    const hdg = rwy.ends[0].hdg;
    const halfW = Math.max(3.5, Math.min(7, rwy.wid / 14));
    rwys += `<g transform="rotate(${hdg})">
      <rect x="${-halfW}" y="-62" width="${halfW * 2}" height="124" rx="2" fill="#3a3a3a" stroke="#4a4a4a" stroke-width="1"/>
      <line x1="0" y1="-52" x2="0" y2="52" stroke="#555" stroke-width="1.2" stroke-dasharray="6 5"/>
    </g>`;
    for (const end of rwy.ends) {
      // the painted number sits at the threshold you approach from, which is
      // opposite the direction the runway points: "12" (hdg 108) marks the NW end
      const a = rad(end.hdg + 180);
      const x = 71 * Math.sin(a), y = -71 * Math.cos(a);
      rwys += `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" fill="#999" font-size="${big ? 12 : 13}" font-weight="700" text-anchor="middle" dominant-baseline="central">${end.name}</text>`;
    }
  }

  let wind = '';
  const hasWind = metar && metar.windKt != null;
  if (hasWind && metar.windKt === 0) {
    wind = big ? '' : '';
  } else if (hasWind && metar.windVrb) {
    wind = `<circle r="46" fill="none" stroke="#f0c040" stroke-width="1.5" stroke-dasharray="4 5"/>`;
  } else if (hasWind && metar.windDir != null) {
    wind = `<g transform="rotate(${metar.windDir})">
      <line x1="0" y1="-98" x2="0" y2="-46" stroke="#4a9eff" stroke-width="${big ? 4 : 3.4}" stroke-linecap="round"/>
      <path d="M -8,-52 L 0,-34 L 8,-52 Z" fill="#4a9eff"/>
      <circle cy="-98" r="${big ? 5 : 4}" fill="#4a9eff"/>
    </g>`;
  }

  let center = '';
  if (hasWind) {
    if (metar.windKt === 0) {
      center = `<text y="2" fill="#22c55e" font-size="${big ? 18 : 15}" font-weight="700" text-anchor="middle">CALM</text>`;
    } else {
      center = `<text y="${big ? -1 : 0}" fill="#fff" font-size="${big ? 26 : 20}" font-weight="700" text-anchor="middle">${metar.windKt}</text>
        <text y="${big ? 14 : 13}" fill="#777" font-size="${big ? 10 : 9}" text-anchor="middle">kt${metar.gustKt ? ` G${metar.gustKt}` : ''}</text>`;
    }
  } else {
    center = `<text y="2" fill="#555" font-size="12" text-anchor="middle">no data</text>`;
  }

  return `<svg viewBox="-112 -112 224 224" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg" font-family="inherit">
    <circle r="100" fill="#141414" stroke="#333" stroke-width="1.5"/>
    ${ticks}${rwys}${wind}
    <circle r="${big ? 21 : 17}" fill="#141414" stroke="#333" stroke-width="1"/>
    ${center}
  </svg>`;
}

/* ============================== charts =================================== */

function prepCanvas(canvas) {
  const r = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = r.width * dpr;
  canvas.height = r.height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.font = '10px "Segoe UI", system-ui, sans-serif';
  return { ctx, W: r.width, H: r.height };
}

// hours: [{t(ms), ...}] — draws x labels every 3rd hour + returns x mapper
function xAxis(ctx, hours, L, R, W, H) {
  const x = (i) => L + (i / (hours.length - 1)) * (W - L - R);
  ctx.fillStyle = '#666';
  ctx.textAlign = 'center';
  hours.forEach((h, i) => {
    const d = new Date(h.t);
    if (d.getMinutes() === 0 && new Date(h.t).getHours() % 3 === 0) {
      ctx.fillText(fmtHour(h.t), x(i), H - 4);
    }
  });
  return x;
}

function gridY(ctx, val, y, L, W, R, label) {
  ctx.strokeStyle = '#252525';
  ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(W - R, y); ctx.stroke();
  ctx.fillStyle = '#555'; ctx.textAlign = 'right';
  ctx.fillText(label != null ? label : String(val), L - 6, y + 3);
}

function drawWindChart(canvas, hours) {
  const { ctx, W, H } = prepCanvas(canvas);
  const L = 34, R = 8, T = 10, B = 44;
  const maxV = Math.max(16, ...hours.map((h) => h.gst || 0)) + 3;
  const x = xAxis(ctx, hours, L, R, W, H);
  const y = (v) => T + (1 - v / maxV) * (H - T - B);
  const step = maxV > 40 ? 10 : 5;
  for (let v = 0; v <= maxV; v += step) gridY(ctx, v, y(v), L, W, R);

  // gusts (dashed amber)
  ctx.strokeStyle = '#f59e0b'; ctx.lineWidth = 1.4; ctx.setLineDash([5, 4]);
  ctx.beginPath();
  hours.forEach((h, i) => { const yy = y(h.gst || h.spd); i ? ctx.lineTo(x(i), yy) : ctx.moveTo(x(i), yy); });
  ctx.stroke(); ctx.setLineDash([]);

  // sustained (blue, filled)
  ctx.beginPath();
  hours.forEach((h, i) => { i ? ctx.lineTo(x(i), y(h.spd)) : ctx.moveTo(x(i), y(h.spd)); });
  ctx.strokeStyle = '#4a9eff'; ctx.lineWidth = 2; ctx.stroke();
  ctx.lineTo(x(hours.length - 1), y(0)); ctx.lineTo(x(0), y(0)); ctx.closePath();
  ctx.fillStyle = 'rgba(74,158,255,0.13)'; ctx.fill();

  // direction arrows (point downwind — the way the air is moving)
  const ay = H - B + 16;
  ctx.strokeStyle = '#8ab8e8'; ctx.fillStyle = '#8ab8e8'; ctx.lineWidth = 1.4;
  hours.forEach((h, i) => {
    if (i % 2 || h.dir == null) return;
    const cx = x(i), a = rad(h.dir + 180), len = 7;
    const dx = Math.sin(a) * len, dy = -Math.cos(a) * len;
    ctx.beginPath(); ctx.moveTo(cx - dx, ay - dy); ctx.lineTo(cx + dx, ay + dy); ctx.stroke();
    const ha = Math.atan2(dy, dx);
    ctx.beginPath();
    ctx.moveTo(cx + dx, ay + dy);
    ctx.lineTo(cx + dx - 5 * Math.cos(ha - 0.5), ay + dy - 5 * Math.sin(ha - 0.5));
    ctx.lineTo(cx + dx - 5 * Math.cos(ha + 0.5), ay + dy - 5 * Math.sin(ha + 0.5));
    ctx.closePath(); ctx.fill();
  });

  // legend
  ctx.textAlign = 'left'; ctx.fillStyle = '#4a9eff'; ctx.fillText('— sustained (kt)', L + 4, T + 4);
  ctx.fillStyle = '#f59e0b'; ctx.fillText('- - gusts', L + 92, T + 4);
}

function drawTempChart(canvas, hours) {
  const { ctx, W, H } = prepCanvas(canvas);
  const L = 34, R = 8, T = 8, B = 18;
  const vals = hours.flatMap((h) => [h.tempF, h.dewF]);
  const lo = Math.floor(Math.min(...vals) / 5) * 5 - 5;
  const hi = Math.ceil(Math.max(...vals) / 5) * 5 + 5;
  const x = xAxis(ctx, hours, L, R, W, H);
  const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  for (let v = lo; v <= hi; v += 10) gridY(ctx, v, y(v), L, W, R, `${v}°`);
  const line = (key, color) => {
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath();
    hours.forEach((h, i) => { i ? ctx.lineTo(x(i), y(h[key])) : ctx.moveTo(x(i), y(h[key])); });
    ctx.stroke();
  };
  line('tempF', '#ef4444');
  line('dewF', '#22c55e');
  ctx.textAlign = 'left'; ctx.fillStyle = '#ef4444'; ctx.fillText('— temp', L + 4, T + 4);
  ctx.fillStyle = '#22c55e'; ctx.fillText('— dewpoint', L + 54, T + 4);
}

function drawPrecipChart(canvas, hours) {
  const { ctx, W, H } = prepCanvas(canvas);
  const L = 34, R = 8, T = 8, B = 18;
  const x = xAxis(ctx, hours, L, R, W, H);
  const y = (v) => T + (1 - v / 100) * (H - T - B);
  for (let v = 0; v <= 100; v += 25) gridY(ctx, v, y(v), L, W, R, `${v}%`);
  const bw = Math.max(2, (W - L - R) / hours.length - 2);
  ctx.fillStyle = 'rgba(74,158,255,0.55)';
  hours.forEach((h, i) => ctx.fillRect(x(i) - bw / 2, y(h.pp), bw, y(0) - y(h.pp)));
  ctx.strokeStyle = '#999'; ctx.lineWidth = 1.6; ctx.beginPath();
  hours.forEach((h, i) => { i ? ctx.lineTo(x(i), y(h.sky)) : ctx.moveTo(x(i), y(h.sky)); });
  ctx.stroke();
}

function drawCeilingChart(canvas, hours) {
  const { ctx, W, H } = prepCanvas(canvas);
  const L = 38, R = 8, T = 8, B = 18;
  const CAP = 10000; // display cap; higher/unlimited = no bar
  const x = xAxis(ctx, hours, L, R, W, H);
  const y = (v) => T + (1 - v / CAP) * (H - T - B);
  for (let v = 0; v <= CAP; v += 2000) gridY(ctx, v, y(v), L, W, R, v ? (v / 1000) + 'k' : '0');

  // sky cover as faint background area (scaled to full chart height)
  ctx.beginPath();
  hours.forEach((h, i) => { const yy = T + (1 - (h.sky || 0) / 100) * (H - T - B); i ? ctx.lineTo(x(i), yy) : ctx.moveTo(x(i), yy); });
  ctx.lineTo(x(hours.length - 1), y(0)); ctx.lineTo(x(0), y(0)); ctx.closePath();
  ctx.fillStyle = 'rgba(160,160,160,0.13)'; ctx.fill();

  const bw = Math.max(2, (W - L - R) / hours.length - 2);
  hours.forEach((h, i) => {
    if (h.ceil == null) return;
    const c = Math.min(h.ceil, CAP);
    ctx.fillStyle = CAT_COLORS[flightCat(99, h.ceil)];
    ctx.fillRect(x(i) - bw / 2, y(c), bw, y(0) - y(c));
  });
}

function drawDaChart(canvas, hours) {
  const { ctx, W, H } = prepCanvas(canvas);
  const L = 38, R = 8, T = 8, B = 18;
  const vals = hours.map((h) => h.da).filter((v) => v != null);
  if (!vals.length) return;
  const lo = Math.min(0, Math.floor(Math.min(...vals) / 500) * 500);
  const hi = Math.max(3500, Math.ceil(Math.max(...vals) / 500) * 500 + 500);
  const x = xAxis(ctx, hours, L, R, W, H);
  const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  for (let v = lo; v <= hi; v += 1000) gridY(ctx, v, y(v), L, W, R, (v / 1000) + 'k');

  // amber caution zone above 3,000 ft DA
  ctx.fillStyle = 'rgba(245,158,11,0.08)';
  ctx.fillRect(L, T, W - L - R, Math.max(0, y(3000) - T));
  ctx.strokeStyle = 'rgba(245,158,11,0.5)'; ctx.setLineDash([4, 4]); ctx.beginPath();
  ctx.moveTo(L, y(3000)); ctx.lineTo(W - R, y(3000)); ctx.stroke(); ctx.setLineDash([]);

  ctx.strokeStyle = '#f0c040'; ctx.lineWidth = 2; ctx.beginPath();
  let started = false;
  hours.forEach((h, i) => {
    if (h.da == null) return;
    started ? ctx.lineTo(x(i), y(h.da)) : ctx.moveTo(x(i), y(h.da));
    started = true;
  });
  ctx.stroke();

  // field elevation reference
  ctx.strokeStyle = '#3a3a3a'; ctx.beginPath();
  ctx.moveTo(L, y(KANP.elevFt)); ctx.lineTo(W - R, y(KANP.elevFt)); ctx.stroke();
  ctx.fillStyle = '#555'; ctx.textAlign = 'left';
  ctx.fillText(`field elev ${KANP.elevFt} ft`, L + 4, y(KANP.elevFt) - 4);
}

/* ============================ flyability ================================= */

function scoreHour(h) {
  let s = 100;
  const why = [];
  if (h.spd > 10) { s -= (h.spd - 10) * 2.5; if (h.spd >= 15) why.push(`wind ${round(h.spd)} kt`); }
  const gf = (h.gst || h.spd) - h.spd;
  if (gf > 8) { s -= (gf - 8) * 2.5; why.push(`gust factor ${round(gf)} kt`); }
  if (h.dir != null && h.spd > 3) {
    const b = bestEnd(AIRPORTS[0], h.dir, h.spd);
    h.best = b;
    const xw = Math.abs(b.cross);
    if (xw > 7) { s -= (xw - 7) * 3; why.push(`${round(xw)} kt crosswind on best rwy`); }
  }
  if (h.ceil != null) {
    if (h.ceil < 500) s -= 55;
    else if (h.ceil < 1000) s -= 40;
    else if (h.ceil < 2000) s -= 22;
    else if (h.ceil < 3000) s -= 12;
    else if (h.ceil < 5000) s -= 5;
    if (h.ceil < 3000) why.push(`ceiling ${round(h.ceil / 100) * 100} ft`);
  } else if (h.sky > 85) {
    s -= 5; // overcast but high/unlimited base
  }
  if (h.visSM < 6) {
    if (h.visSM < 1) s -= 50;
    else if (h.visSM < 3) s -= 30;
    else if (h.visSM < 5) s -= 12;
    else s -= 6;
    why.push(`${h.visSM < 3 ? h.visSM.toFixed(1) : round(h.visSM)} SM visibility`);
  }
  if (h.pp >= 30) why.push(`${h.pp}% precip chance`);
  s -= h.pp * 0.25;
  if (h.precip > 0.4) { s -= 10; why.push('rain'); }
  if (h.cape > 1000) { s -= (h.cape - 1000) / 50; why.push(`convective potential (CAPE ${round(h.cape)})`); }
  if (h.da != null && h.da > 2500) {
    s -= (h.da - 2500) / 75;
    if (h.da > 3000) why.push(`density altitude ${(round(h.da / 50) * 50).toLocaleString()} ft`);
  }
  h.score = Math.max(5, Math.min(100, round(s)));
  h.why = why;
  return h;
}

function flyColor(score) {
  if (score >= 80) return ['#22c55e', 'Good'];
  if (score >= 60) return ['#a3d635', 'Fair'];
  if (score >= 40) return ['#f59e0b', 'Marginal'];
  return ['#ef4444', 'Poor'];
}

function renderFlyStrip(hours) {
  const wrap = $('fly-strip');
  wrap.innerHTML = '';
  hours.forEach((h) => {
    const [color, band] = flyColor(h.score);
    const el = document.createElement('div');
    el.className = 'fly-block' + (h.night ? ' night' : '');
    el.style.background = color;
    el.innerHTML = `<span class="hr">${fmtHour(h.t)}</span><span class="sc">${h.score}</span>` +
      `<span class="tmp">${round(h.tempF)}°</span>` +
      `<span class="catbar" style="background:${CAT_COLORS[h.cat]}"></span>`;
    const show = () => {
      document.querySelectorAll('.fly-block.sel').forEach((b) => b.classList.remove('sel'));
      el.classList.add('sel');
      const windTxt = h.dir != null
        ? `wind ${String(round(h.dir)).padStart(3, '0')}°@${round(h.spd)}${h.gst && h.gst - h.spd > 4 ? 'G' + round(h.gst) : ''} kt`
        : `wind ${round(h.spd)} kt`;
      const rwyTxt = h.best ? `, favors RWY ${h.best.end} (xw ${round(Math.abs(h.best.cross))} kt)` : '';
      const cloudTxt = h.ceil != null
        ? `${skyWord(h.sky)} ceiling ${(round(h.ceil / 100) * 100).toLocaleString()} ft`
        : (h.sky > 10 ? `${skyWord(h.sky)}, no ceiling` : 'clear');
      const visTxt = h.visSM < 10 ? ` · vis ${h.visSM < 3 ? h.visSM.toFixed(1) : round(h.visSM)} SM` : '';
      const daTxt = h.da != null ? ` · DA ${(round(h.da / 50) * 50).toLocaleString()} ft` : '';
      $('fly-detail').innerHTML =
        `<b>${fmtTime(h.t, { minute: undefined })}</b> — <b>${h.score} · ${band}</b>` +
        ` <span class="cat-chip" style="background:${CAT_COLORS[h.cat]}">${h.cat}</span>` +
        `${h.night ? ' · night' : ''} — ` +
        esc(`${windTxt}${rwyTxt} · ${cloudTxt}${visTxt}${daTxt}`) +
        (h.why.length ? `<br><span class="faint">issues: ${esc(h.why.join(' · '))}</span>` : '');
    };
    el.addEventListener('mouseenter', show);
    el.addEventListener('click', show);
    wrap.appendChild(el);
  });
}

/* ====================== data loading & rendering ========================= */

// The newest ob the site's own archive holds for a station (data/wx/latest.json
// via WXA): the field sensor, the verification station, or the local ring.
function archiveOb(arc, id) {
  if (!arc) return null;
  const last = (list) => (list && list.length ? { ts: list[list.length - 1][0], raw: list[list.length - 1][1] } : null);
  if (id === arc.field_station) return last(arc.fieldobs);
  if (id === arc.station) return last(arc.obs);
  const s = arc.stations && arc.stations[id];
  return s && s.length === 2 ? { ts: s[0], raw: s[1] } : null;
}

// The site archive's current-state document. WXA caches a path for the life
// of the tab, which is right for day files and wrong for latest.json — a hub
// left open all afternoon would fall back to the archive as it stood at page
// load. First call goes through WXA (shared with any other reader); refreshes
// re-fetch with a 10-minute cache key, since the archiver runs hourly.
async function archiveLatest() {
  if (typeof WXA === 'undefined') return null;
  if (!state.liveGen) return WXA.latest();
  try {
    const r = await fetch(`${WXA.base}/latest.json?t=${Math.floor(Date.now() / 600000)}`,
      { headers: { Accept: 'application/json' } });
    return r.ok ? await r.json() : WXA.latest();
  } catch (e) { return WXA.latest(); }
}

// First paint from the archive. latest.json is same-origin and answers in
// tens of milliseconds; api.weather.gov has taken 20 s. Everything a METAR
// drives — compass, conditions, sky wash, the nearby fields, radar markers —
// is drawn from the archived obs (labelled "via site archive") and replaced
// as soon as the live sources answer. TAFs and the flight windows stay live:
// the archive holds no decoded TAF periods and the windows need the model.
async function paintFromArchive(gen) {
  const arc = await archiveLatest();
  if (!arc || state.liveGen >= gen) return;   // live already rendered this load
  let any = false;
  for (const id of new Set(AIRPORTS.map((a) => a.metarStation))) {
    const a = archiveOb(arc, id);
    if (!a) continue;
    state.metars[id] = parseMetar(a.raw, new Date(a.ts * 1000).toISOString());
    state.metars[id].src = 'site archive';
    any = true;
  }
  renderArchiveCards(arc);
  if (!any || state.liveGen >= gen) return;
  renderSun();
  renderHero();
  renderConditions();
  renderSkyWash();
  renderAirports();
  updateRadarMarkers();
  $('status-text').textContent = 'Updating… · showing the site archive';
}

// api.weather.gov's /observations/latest routinely serves an ob whose
// rawMessage is blank (2026-09-01: every ring station's 23:45Z ob), and for
// some stations kept serving that blank one while a newer good ob sat in the
// collection — the page read it as "empty observation". So: read the last few
// obs, keep the newest that carries text, and fall back to the site archive
// (hourly, so up to a few hours old — labelled "via site archive").
async function loadMetars() {
  const stations = [...new Set(AIRPORTS.map((a) => a.metarStation))];
  const arc = await archiveLatest();   // resolves null, never throws
  await Promise.all(stations.map(async (id) => {
    let best = null, err = null;
    try {
      const d = await fetchJSON(`${NWS}/stations/${id}/observations?limit=4`);
      const withRaw = (d.features || []).map((f) => f && f.properties)
        .filter((p) => p && p.rawMessage && p.timestamp)
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      if (withRaw.length) best = { raw: withRaw[0].rawMessage, time: withRaw[0].timestamp, src: 'NWS' };
      else err = 'NWS served no METAR text';
    } catch (e) { err = e.message; }
    const a = archiveOb(arc, id);
    if (a && (!best || a.ts * 1000 > new Date(best.time).getTime())) {
      best = { raw: a.raw, time: new Date(a.ts * 1000).toISOString(), src: 'site archive' };
    }
    if (best) {
      state.metars[id] = parseMetar(best.raw, best.time);
      state.metars[id].src = best.src;
    } else {
      state.metars[id] = { error: err || 'no observation' };
    }
  }));
}
const viaArchive = (m) => (m && m.src === 'site archive' ? ' · via site archive' : '');

async function loadOpenMeteo() {
  const H = [
    'temperature_2m', 'dew_point_2m', 'precipitation_probability', 'precipitation',
    'cloud_cover', 'visibility', 'cape',
    'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m',
    'wind_speed_925hPa', 'wind_direction_925hPa', 'temperature_925hPa',
    'wind_speed_850hPa', 'wind_direction_850hPa', 'temperature_850hPa',
    'wind_speed_700hPa', 'wind_direction_700hPa', 'temperature_700hPa',
  ].join(',');
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${KANP.lat}&longitude=${KANP.lon}` +
    `&current=temperature_2m,relative_humidity_2m,dew_point_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m` +
    `&hourly=${H},pressure_msl&wind_speed_unit=kn&timeformat=unixtime&timezone=UTC&forecast_days=2`;
  state.om = await fetchJSON(url);
}

/* -------- NWS forecast grid (the data behind NWS/aviation forecasts) ------ */

// Expand one grid property ({uom, values:[{validTime:"iso/PT3H", value}]})
// into a Map of hour-start(ms) -> converted value (null = explicit "none").
function expandSeries(prop, conv) {
  const out = new Map();
  if (!prop || !prop.values) return out;
  for (const v of prop.values) {
    const [startIso, dur] = v.validTime.split('/');
    const start = new Date(startIso).getTime();
    const m = (dur || 'PT1H').match(/P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?/);
    const hrs = Math.max(1, (m ? (+m[1] || 0) * 24 + (+m[2] || 0) : 0) + ((m && +m[3]) ? 1 : 0));
    for (let h = 0; h < hrs; h++) {
      out.set(start + h * 3600000, v.value == null ? null : conv(v.value));
    }
  }
  return out;
}

async function loadNwsGrid() {
  let gUrl = localStorage.getItem('wx_grid_url');
  if (!gUrl) {
    const pt = await fetchJSON(`${NWS}/points/${KANP.lat},${KANP.lon}`);
    gUrl = pt.properties.forecastGridData;
    localStorage.setItem('wx_grid_url', gUrl);
  }
  let g;
  try {
    g = (await fetchJSON(gUrl)).properties;
  } catch (e) {
    localStorage.removeItem('wx_grid_url');
    throw e;
  }
  const kmh2kt = (v) => v / 1.852;
  // LWX encodes "no ceiling" as -30.48 m (-100 ft); treat any non-positive
  // height as no ceiling rather than a (very) low one.
  const m2ftCeil = (v) => (v <= 0 ? null : v * 3.28084);
  const m2sm = (v) => (v < 0 ? null : v / 1609.34);
  const id = (v) => v;
  state.grid = {
    spd: expandSeries(g.windSpeed, kmh2kt),
    gst: expandSeries(g.windGust, kmh2kt),
    dir: expandSeries(g.windDirection, id),
    sky: expandSeries(g.skyCover, id),
    ceil: expandSeries(g.ceilingHeight, m2ftCeil),
    vis: expandSeries(g.visibility, m2sm),
    pp: expandSeries(g.probabilityOfPrecipitation, id),
    tempC: expandSeries(g.temperature, id),
    dewC: expandSeries(g.dewpoint, id),
  };
}

// Merge NWS grid (primary — same NOAA data family aviation apps use) with
// Open-Meteo (fallback + CAPE + pressure for density altitude).
function buildHours() {
  const om = state.om;
  const g = state.grid;
  const now = Date.now() / 1000;
  const t = om.hourly.time;
  // first entry = the hour currently in progress
  let i0 = t.findIndex((s) => s > now - 3600);
  if (i0 < 0) i0 = 0;
  const hours = [];
  const solarCache = {};
  const gv = (map, ms) => (g && map.has(ms) ? map.get(ms) : undefined);

  // Anchor the forecast to the latest observation: the grid can run a few
  // degrees off (e.g. +4°F on a bay-breeze afternoon), so blend the current
  // obs-vs-forecast error into the next hours, decaying to pure forecast.
  let tempBias = 0, dewBias = 0;
  const ob = state.metars[KANP.metarStation];
  if (ob && !ob.error && ob.tempC != null && ageMin(ob.time) <= 120) {
    const obsHourMs = Math.floor(new Date(ob.time).getTime() / 3600000) * 3600000;
    const fcT = gv(g && g.tempC, obsHourMs);
    const fcD = gv(g && g.dewC, obsHourMs);
    const clamp = (v) => Math.max(-3.5, Math.min(3.5, v)); // ±~6°F sanity cap
    if (fcT != null) tempBias = clamp(ob.tempC - fcT);
    if (fcD != null && ob.dewC != null) dewBias = clamp(ob.dewC - fcD);
  }
  const BIAS_HOURS = 8;

  for (let i = i0; i < Math.min(i0 + 24, t.length); i++) {
    const ms = t[i] * 1000;
    const decay = Math.max(0, 1 - (i - i0) / BIAS_HOURS);
    let tempC = gv(g && g.tempC, ms) ?? om.hourly.temperature_2m[i];
    let dewC = gv(g && g.dewC, ms) ?? om.hourly.dew_point_2m[i];
    if (tempC != null) tempC += tempBias * decay;
    if (dewC != null) dewC = Math.min(dewC + dewBias * decay, tempC ?? Infinity);
    // NWS ceiling: value null (or hour absent) = no ceiling forecast
    const ceilRaw = gv(g && g.ceil, ms);
    const pmsl = om.hourly.pressure_msl ? om.hourly.pressure_msl[i] : null;
    const h = {
      t: ms,
      tempF: cToF(tempC),
      dewF: cToF(dewC),
      pp: gv(g && g.pp, ms) ?? om.hourly.precipitation_probability[i] ?? 0,
      precip: om.hourly.precipitation[i] ?? 0,
      sky: gv(g && g.sky, ms) ?? om.hourly.cloud_cover[i] ?? 0,
      ceil: ceilRaw == null ? null : ceilRaw,
      visSM: gv(g && g.vis, ms) ?? (om.hourly.visibility[i] ?? 99999) / 1609.34,
      cape: om.hourly.cape[i] ?? 0,
      spd: gv(g && g.spd, ms) ?? om.hourly.wind_speed_10m[i] ?? 0,
      dir: gv(g && g.dir, ms) ?? om.hourly.wind_direction_10m[i],
      gst: gv(g && g.gst, ms) ?? om.hourly.wind_gusts_10m[i],
    };
    if (h.gst != null && h.gst < h.spd) h.gst = h.spd;
    h.cat = flightCat(h.visSM, h.ceil);
    if (tempC != null && pmsl != null) {
      // sea-level pressure stands in for the altimeter setting: at 34 ft the
      // two differ by well under 0.01 inHg
      h.da = densityAltFt(tempC, dewC, pmsl / 33.8639, KANP.elevFt);
    }
    const day = new Date(ms).toLocaleDateString('en-CA', { timeZone: TZ });
    if (!solarCache[day]) solarCache[day] = solarTimes(new Date(ms), KANP.lat, KANP.lon);
    const s = solarCache[day];
    h.night = !(s.dawn && s.dusk && ms >= s.dawn.getTime() && ms <= s.dusk.getTime());
    hours.push(scoreHour(h));
  }
  return hours;
}

// sky cover % -> METAR-style word
function skyWord(sky) {
  if (sky == null) return '';
  if (sky <= 10) return 'CLR';
  if (sky <= 25) return 'FEW';
  if (sky <= 50) return 'SCT';
  if (sky <= 87) return 'BKN';
  return 'OVC';
}

function renderHero() {
  const metar = state.metars[AIRPORTS[0].metarStation];
  const ok = metar && !metar.error;
  const cur = state.om && state.om.current;

  // Fall back to model wind if the METAR is missing
  let wind = ok ? metar : null;
  let src = ok
    ? `${KANP.metarStation} METAR, ${ageMin(metar.time)} min ago${viaArchive(metar)} · directions °true`
    : null;
  if (!ok && cur) {
    wind = { windDir: round(cur.wind_direction_10m), windKt: round(cur.wind_speed_10m), gustKt: round(cur.wind_gusts_10m) };
    src = `${KANP.metarStation} unavailable — model wind (Open-Meteo) · °true`;
  }
  $('hero-compass').innerHTML = compassSVG(AIRPORTS[0], wind, 300);
  $('hero-src-line').textContent = src || 'no wind data available';

  if (wind && wind.windKt != null) {
    let line;
    if (wind.windKt === 0) line = 'Wind calm';
    else if (wind.windVrb) line = `Wind variable at ${wind.windKt} kt${wind.gustKt ? `, gusting ${wind.gustKt}` : ''}`;
    else line = `Wind ${String(wind.windDir).padStart(3, '0')}° at ${wind.windKt} kt${wind.gustKt ? `, gusting ${wind.gustKt}` : ''}`;
    $('hero-wind-line').textContent = line;

    if (wind.windDir != null && wind.windKt > 0) {
      const b = bestEnd(AIRPORTS[0], wind.windDir, wind.gustKt || wind.windKt);
      const side = b.cross > 0 ? 'right' : 'left';
      const sus = windComponents(wind.windDir, wind.windKt, b.hdg);
      $('hero-rwy-line').innerHTML =
        `<b style="color:#22c55e">RWY ${b.end} favored</b> — ` +
        `${round(Math.max(0, sus.head))} kt headwind, ${round(Math.abs(sus.cross))} kt ${side} crosswind` +
        (wind.gustKt ? `<br>${round(Math.abs(b.cross))} kt crosswind in gusts` : '');
    } else {
      $('hero-rwy-line').textContent = wind.windKt === 0 ? 'Either runway works — pick your favorite.' : 'Variable wind — check the sock.';
    }
  } else {
    $('hero-wind-line').textContent = '—';
    $('hero-rwy-line').textContent = '';
  }
}

function renderConditions() {
  const m = state.metars[KANP.metarStation];
  const el = $('cond-body');
  if (!m || m.error) {
    el.innerHTML = `<span class="apt-err">${KANP.metarStation} observation unavailable${m ? ` (${esc(m.error)})` : ''}.</span>`;
    return;
  }
  const ceil = ceilingFt(m);
  const cat = flightCat(m.visSM, ceil);
  const sky = m.clear ? 'clear' :
    (m.clouds.map((c) => `${c.amt}${c.cb} ${(c.baseFt).toLocaleString()}`).join(', ') || '—');

  const rh = relHumidity(m.tempC, m.dewC);
  const rhHtml = rh == null ? '' :
    `<div class="kv"><span class="k">Relative humidity</span>
      <span class="v">${round(rh)}%<span class="faint"> · spread ${round(m.tempC - m.dewC)}°C</span></span></div>`;

  let daHtml = '';
  if (m.tempC != null && m.altInHg != null) {
    const da = round(densityAltFt(m.tempC, m.dewC, m.altInHg, KANP.elevFt) / 50) * 50;
    daHtml = `<div class="kv"><span class="k">Density altitude (${KANP.id}, ${KANP.elevFt} ft, with humidity)</span>
      <span class="v" style="color:${da > 3000 ? '#f59e0b' : '#ddd'}">${da.toLocaleString()} ft</span></div>`;
  }
  el.innerHTML = `
    <div class="kv"><span class="k">Flight category</span>
      <span class="v"><span class="cat-chip" style="background:${CAT_COLORS[cat]}">${cat}</span></span></div>
    <div class="kv"><span class="k">Visibility</span><span class="v">${m.visSM != null ? m.visSM + ' SM' : '—'}</span></div>
    <div class="kv"><span class="k">Sky</span><span class="v">${esc(sky)}${m.wx.length ? ' · ' + esc(m.wx.join(' ')) : ''}</span></div>
    <div class="kv"><span class="k">Ceiling</span><span class="v">${ceil != null ? ceil.toLocaleString() + ' ft' : 'none'}</span></div>
    <div class="kv"><span class="k">Temp / dewpoint</span><span class="v">${m.tempC != null ? `${round(cToF(m.tempC))}°F / ${round(cToF(m.dewC))}°F <span class="faint">(${m.tempC}/${m.dewC}C)</span>` : '—'}</span></div>
    ${rhHtml}
    <div class="kv"><span class="k">Altimeter</span><span class="v">${m.altInHg != null ? m.altInHg.toFixed(2) + ' inHg' : '—'}</span></div>
    ${daHtml}
    <div class="apt-raw" style="margin-bottom:0">${esc(m.raw)}</div>
    <div class="apt-meta">${KANP.metarStation} · observed ${fmtTime(m.time)} · ${ageMin(m.time)} min ago${viaArchive(m)}</div>`;
}

function renderSun() {
  const now = new Date();
  const s = solarTimes(now, KANP.lat, KANP.lon);
  state.sun = s;
  const f = (d) => d ? fmtTime(d) : '—';
  const nightCurrency = s.sunset ? new Date(s.sunset.getTime() + 3600000) : null;
  const dayLeft = s.sunset && now < s.sunset
    ? `${Math.floor((s.sunset - now) / 3600000)}h ${round(((s.sunset - now) % 3600000) / 60000)}m of daylight left`
    : 'sun is down';
  $('sun-body').innerHTML = `
    <div class="kv"><span class="k">Civil dawn</span><span class="v">${f(s.dawn)}</span></div>
    <div class="kv"><span class="k">Sunrise</span><span class="v">${f(s.sunrise)}</span></div>
    <div class="kv"><span class="k">Sunset</span><span class="v">${f(s.sunset)}</span></div>
    <div class="kv"><span class="k">Civil dusk</span><span class="v">${f(s.dusk)}</span></div>
    <div style="border-top:1px solid #2a2a2a;margin:8px 0 6px"></div>
    <div class="kv"><span class="k">Position lights required</span><span class="v">${f(s.sunset)} → ${f(s.sunrise)}</span></div>
    <div class="kv"><span class="k">Loggable night</span><span class="v">${f(s.dusk)} → ${f(s.dawn)}</span></div>
    <div class="kv"><span class="k">Night currency landings</span><span class="v">after ${f(nightCurrency)}</span></div>
    <div class="apt-meta">${dayLeft} · times for ${KANP.id}, ${now.toLocaleDateString('en-US', { timeZone: TZ, weekday: 'long', month: 'long', day: 'numeric' })}</div>`;
}

function renderAloft() {
  const om = state.om;
  const now = Date.now() / 1000;
  let i0 = om.hourly.time.findIndex((s) => s >= now - 1800);
  if (i0 < 0) i0 = 0;
  const levels = [
    ['925', '~2,500 ft'],
    ['850', '~5,000 ft'],
    ['700', '~10,000 ft'],
  ];
  const offs = [0, 3, 6, 9];
  const head = offs.map((o) => `<th>${o === 0 ? 'Now' : '+' + o + ' h'}</th>`).join('');
  const rows = levels.map(([p, alt]) => {
    const cells = offs.map((o) => {
      const i = Math.min(i0 + o, om.hourly.time.length - 1);
      const d = om.hourly[`wind_direction_${p}hPa`][i];
      const sp = om.hourly[`wind_speed_${p}hPa`][i];
      const tc = om.hourly[`temperature_${p}hPa`][i];
      if (d == null || sp == null) return '<td>—</td>';
      return `<td>${String(round(d)).padStart(3, '0')}°@${round(sp)} <span class="faint">${round(tc)}°C</span></td>`;
    }).join('');
    return `<tr><td><b style="color:#ccc">${alt}</b> <span class="faint">${p} mb</span></td>${cells}</tr>`;
  }).join('');
  $('aloft-body').innerHTML =
    `<table class="wx-table"><thead><tr><th>Level (MSL)</th>${head}</tr></thead><tbody>${rows}</tbody></table>
     <div class="apt-meta">speeds kt · directions °true · pressure-level heights are approximate</div>`;
}

async function loadOutlook() {
  try {
    let fUrl = localStorage.getItem('wx_forecast_url');
    if (!fUrl) {
      const pt = await fetchJSON(`${NWS}/points/${KANP.lat},${KANP.lon}`);
      fUrl = pt.properties.forecast;
      localStorage.setItem('wx_forecast_url', fUrl);
    }
    const fc = await fetchJSON(fUrl);
    state.outlook = fc.properties.periods.slice(0, 6);
    $('outlook-body').innerHTML = state.outlook.map((p) => `
      <div class="outlook-row">
        <span class="day">${esc(p.name)}</span>
        <span class="tmp">${p.temperature}°${p.temperatureUnit}</span>
        <span class="txt">${esc(p.shortForecast)}${p.windSpeed ? ` · ${esc(p.windDirection || '')} ${esc(p.windSpeed)}` : ''}</span>
      </div>`).join('');
  } catch (e) {
    localStorage.removeItem('wx_forecast_url');
    $('outlook-body').innerHTML = `<span class="apt-err">NWS forecast unavailable (${esc(e.message)})</span>`;
  }
}

async function loadAlerts() {
  try {
    const d = await fetchJSON(`${NWS}/alerts/active?point=${KANP.lat},${KANP.lon}`);
    const feats = d.features || [];
    const box = $('alerts');
    if (!feats.length) { box.style.display = 'none'; box.innerHTML = ''; return; }
    box.innerHTML = feats.map((f) => {
      const p = f.properties;
      const minor = !['Severe', 'Extreme'].includes(p.severity);
      return `<div class="alert-box${minor ? ' minor' : ''}">
        <span class="hd">⚠ ${esc(p.event)}</span> — ${esc(p.headline || '')}
        <span class="faint">(${esc(p.severity)}, until ${p.ends ? fmtTime(p.ends) : '—'})</span>
      </div>`;
    }).join('');
    box.style.display = 'block';
  } catch { /* alerts are non-critical */ }
}

/* -------- PIREPs · AIRMETs / SIGMETs · TFRs, from the site archive --------
   aviationweather.gov and tfr.faa.gov send no CORS headers, so the browser
   cannot read them; the hourly archiver can, and latest.json is where these
   live. Every card prints the archive stamp: this is hourly, never live. */

const hmLocal = (t) => new Date(t * 1000).toLocaleTimeString('en-US',
  { hour: 'numeric', minute: '2-digit', timeZone: TZ });
const ageShort = (sec) => (sec < 3600 ? `${round(sec / 60)}m` : sec < 86400 ? `${round(sec / 3600)}h` : `${round(sec / 86400)}d`);

// great-circle distance (nm) and true bearing from the field
function fromField(lat, lon) {
  const R = 3440.065;
  const p1 = rad(KANP.lat), p2 = rad(lat), dl = rad(lon - KANP.lon);
  const a = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  const nm = 2 * R * Math.asin(Math.sqrt(a));
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  const brg = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  return { nm, brg };
}

function archiveStamp(arc) {
  const age = Date.now() / 1000 - arc.t;
  return `as of ${hmLocal(arc.t)}${age > 3 * 3600 ? ` · ${ageShort(age)} old` : ''}`;
}

function renderPireps(arc) {
  const box = $('pirep-body');
  if (!box) return;
  const list = (arc.pireps || []).slice();
  $('pirep-sub').textContent = archiveStamp(arc);
  if (!list.length) { box.innerHTML = '<span class="faint">no PIREPs in the last 12 h</span>'; return; }
  const urgent = (p) => /urgent|UUA/i.test(p.type || '');
  list.sort((a, b) => (urgent(b) - urgent(a)) || (b.t - a.t));
  const now = Date.now() / 1000;
  // raw text only — the /TB /IC decode is gone (2026-09-02): the reports
  // drop the format too often for a decoded line to be trusted, and the raw
  // report is what a pilot reads anyway
  box.innerHTML = list.map((p) => {
    const loc = (p.lat != null && p.lon != null) ? fromField(p.lat, p.lon) : null;
    return `<div class="pr-row${urgent(p) ? ' urgent' : ''}">
      <span class="pr-age num-mono" title="${esc(hmLocal(p.t))}">${ageShort(now - p.t)}</span>
      <span class="pr-loc num-mono">${loc ? `${round(loc.nm)} nm ${String(round(loc.brg)).padStart(3, '0')}°` : '—'}</span>
      <code>${esc((p.raw || '').trim())}</code>
    </div>`;
  }).join('');
}

function renderAirsig(arc) {
  const box = $('airsig-body');
  if (!box) return;
  const items = arc.airsig || [], tfrs = arc.tfrs || [];
  const win = (it) => (it.from && it.to && it.to > it.from ? `${hmLocal(it.from)}–${hmLocal(it.to)}` : it.from ? `valid ${hmLocal(it.from)}` : '');
  const galt = (it) => [it.base != null ? `base ${it.base}` : null, it.top != null ? `top ${it.top}` : null,
    it.fzl ? `FZL ${it.fzl[0] != null ? it.fzl[0] : '?'}–${it.fzl[1] != null ? it.fzl[1] : '?'}` : null].filter(Boolean).join(' · ');
  const salt = (it) => [it.lo != null ? `${it.lo.toLocaleString()} ft` : null, it.hi != null ? `to ${it.hi.toLocaleString()} ft` : null].filter(Boolean).join(' ');
  const groups = [];
  for (const prod of ['SIERRA', 'TANGO', 'ZULU']) {
    const rows = items.filter((it) => it.kind === 'G-AIRMET' && it.product === prod);
    groups.push(`<div class="as-grp"><span class="as-h">${prod}</span>` + (rows.length
      ? rows.map((it) => `<div class="as-row"><b>${esc(it.hazard || '')}</b> <span class="num-mono">${esc(win(it))}</span>` +
          `${galt(it) ? ` · ${esc(galt(it))}` : ''}${it.due ? ` <span class="faint">${esc(it.due)}</span>` : ''}</div>`).join('')
      : '<span class="faint">none in effect</span>') + '</div>');
  }
  const sigs = items.filter((it) => it.kind !== 'G-AIRMET');
  groups.push(`<div class="as-grp"><span class="as-h">SIGMET · AIRMET</span>` + (sigs.length
    ? sigs.map((it, i) => `<div class="as-row as-sig" data-i="${i}"><b>${esc(it.kind)} ${esc(it.hazard || '')}</b> <span class="num-mono">${esc(win(it))}</span>` +
        `${salt(it) ? ` · ${esc(salt(it))}` : ''}${it.mov && it.mov[0] != null ? ` · mov ${String(it.mov[0]).padStart(3, '0')}/${it.mov[1] || '?'}` : ''}` +
        `<div class="pr-raw" hidden>${esc(it.raw || '')}</div></div>`).join('')
    : '<span class="faint">none in effect</span>') + '</div>');
  const standing = (r) => r.state === 'USA';
  const tf = tfrs.slice().sort((a, b) => (standing(a) - standing(b)) || String(a.id).localeCompare(String(b.id)));
  groups.push(`<div class="as-grp"><span class="as-h">TFR</span>` + (tf.length
    ? tf.map((r) => `<div class="as-row"><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.id)}</a> ` +
        `<b>${esc(r.type || 'TFR')}</b> · ${esc(r.desc || '')}${standing(r) ? ' <span class="faint">· standing</span>' : ''}</div>`).join('')
    : '<span class="faint">none listed</span>') + '</div>');
  box.innerHTML = groups.join('');
  box.onclick = (e) => {
    const row = e.target.closest('.as-sig');
    if (!row) return;
    const raw = row.querySelector('.pr-raw');
    raw.hidden = !raw.hidden;
  };
}

// The ring on the radar map: every archived METAR station not already drawn
// as an airport card, colored by flight category with the ceiling (hundreds
// of feet) as a permanent label, so the map reads as a ceiling picture.
function updateRingMarkers(arc) {
  if (!radar.map || !arc) return;
  const drawn = new Set(AIRPORTS.map((a) => a.metarStation).concat(AIRPORTS.map((a) => a.id)));
  const coords = SITE.weather.stationCoords || {};
  const obs = {};
  for (const [id, pair] of Object.entries(arc.stations || {})) if (pair && pair.length === 2) obs[id] = pair;
  const lastOf = (list) => (list && list.length ? list[list.length - 1] : null);
  if (arc.station && lastOf(arc.obs)) obs[arc.station] = lastOf(arc.obs);
  if (arc.field_station && lastOf(arc.fieldobs)) obs[arc.field_station] = lastOf(arc.fieldobs);
  const now = Date.now() / 1000;
  radar.ring = radar.ring || {};
  for (const [id, [ts, raw]] of Object.entries(obs)) {
    if (drawn.has(id) || !coords[id]) continue;
    const m = parseMetar(raw, new Date(ts * 1000).toISOString());
    const ceil = ceilingFt(m);
    const cat = flightCat(m.visSM, ceil);
    const stale = now - ts > 3 * 3600;
    const label = `${id} ${ceil != null ? String(round(ceil / 100)).padStart(3, '0') : m.clear ? 'CLR' : '—'}`;
    const style = { radius: 5, color: stale ? '#888' : '#111', weight: 1.5, fillColor: CAT_COLORS[cat], fillOpacity: 0.95 };
    let mk = radar.ring[id];
    if (!mk) {
      mk = radar.ring[id] = L.circleMarker(coords[id], style).addTo(radar.map)
        .bindTooltip(label, { permanent: true, direction: 'right', offset: [6, 0], className: 'ring-lbl' });
    } else {
      mk.setStyle(style);
      mk.setTooltipContent(label);
    }
    mk.bindPopup(`<b>${id}</b> ${cat} · ${ceil != null ? `${ceil.toLocaleString()} ft` : 'no ceiling'} · ${ageShort(now - ts)} ago<br><span style="font-family:monospace;font-size:11px">${esc(raw.split(' RMK')[0])}</span>`);
  }
}

function renderArchiveCards(arc) {
  if (!arc) return;
  renderPireps(arc);
  renderAirsig(arc);
  updateRingMarkers(arc);
  // the section stays folded; the summary line carries the counts
  const el = $('arc-summary');
  if (el) {
    const n = (arc.pireps || []).length, a = (arc.airsig || []).length, f = (arc.tfrs || []).length;
    el.textContent = `${n} PIREP${n === 1 ? '' : 's'} · ${a} AIRMET/SIGMET${a === 1 ? '' : 's'} · ${f} TFR${f === 1 ? '' : 's'} · ~150 nm`;
  }
}

/* -------- runway analysis cards -------- */

function renderAirports() {
  const grid = $('airports');
  grid.innerHTML = '';
  for (const apt of AIRPORTS) {
    const m = state.metars[apt.metarStation];
    const card = document.createElement('div');
    card.className = 'card';
    if (!m || m.error) {
      card.innerHTML = `
        <div class="apt-head"><span class="icao">${apt.id}</span><span class="name">${esc(apt.name)}</span></div>
        <div class="apt-err">Observation unavailable${m ? ` — ${esc(m.error)}` : ''}.</div>`;
      grid.appendChild(card);
      continue;
    }
    const ceil = ceilingFt(m);
    const cat = flightCat(m.visSM, ceil);
    const hasDir = m.windDir != null && m.windKt > 0;
    const best = hasDir ? bestEnd(apt, m.windDir, m.windKt) : null;

    let rows = '';
    for (const rwy of apt.runways) {
      for (const end of rwy.ends) {
        let comp = '<span class="comp faint">—</span>';
        if (hasDir) {
          const kt = m.windKt;
          const c = windComponents(m.windDir, kt, end.hdg);
          const g = m.gustKt ? windComponents(m.windDir, m.gustKt, end.hdg) : null;
          const xw = Math.abs(c.cross);
          const xwG = g ? Math.abs(g.cross) : null;
          const side = c.cross > 0 ? 'R' : 'L';
          const headTxt = c.head >= -0.5
            ? `<span class="comp">head <b>${round(Math.max(0, c.head))}</b>${g ? `<span class="faint">G${round(Math.max(0, g.head))}</span>` : ''}</span>`
            : `<span class="comp tail">tail <b>${round(-c.head)}</b>${g ? `<span class="faint">G${round(Math.max(0, -g.head))}</span>` : ''}</span>`;
          const xwTxt = `<span class="comp${xw > 12 ? ' xw-bad' : ''}">xw <b>${round(xw)}</b>${xwG != null ? `<span class="faint">G${round(xwG)}</span>` : ''} kt ${side}</span>`;
          comp = `${headTxt} · ${xwTxt}`;
        } else if (m.windVrb) {
          comp = `<span class="comp faint">variable ${m.windKt} kt</span>`;
        } else if (m.windKt === 0) {
          comp = `<span class="comp faint">calm</span>`;
        }
        const isBest = best && best.end === end.name;
        rows += `<div class="rwy-row${isBest ? ' best' : ''}">
          <span class="rwy">${end.name}</span>${comp}${isBest ? ' <span class="best-tag">USE</span>' : ''}
        </div>`;
      }
    }
    const rwyMeta = apt.runways.map((r) => `${r.ends[0].name}/${r.ends[1].name} ${r.len.toLocaleString()}×${r.wid} ft`).join(' · ');
    card.innerHTML = `
      <div class="apt-head">
        <span class="icao">${apt.id}</span>
        <span class="cat-chip" style="background:${CAT_COLORS[cat]}">${cat}</span>
        <span class="name">${esc(apt.name)}</span>
      </div>
      <div class="apt-raw">${esc(m.raw)}</div>
      <div class="apt-body">
        <div class="apt-rows">${rows}</div>
        <div class="apt-compass">${compassSVG(apt, m, 128)}</div>
      </div>
      <div class="apt-meta">${rwyMeta} · elev ${apt.elevFt} ft · obs ${ageMin(m.time)} min ago${viaArchive(m)}${apt.obsNote ? `<br>${esc(apt.obsNote)}` : ''}</div>`;
    grid.appendChild(card);
  }
}

/* -------- TAFs (IWXXM XML from api.weather.gov) -------- */

const XLINK = 'http://www.w3.org/1999/xlink';
const tag = (el, name) => el.getElementsByTagNameNS('*', name);
const href = (el) => (el.getAttributeNS(XLINK, 'href') || el.getAttribute('xlink:href') || '');
const code = (el) => href(el).split('/').pop();

async function loadTaf(stationId) {
  const list = await fetchJSON(`${NWS}/stations/${stationId}/tafs`);
  // newest first by issueTime — the collection is not guaranteed to be ordered
  const items = (list['@graph'] || []).filter((i) => i && i.id && i.issueTime)
    .sort((a, b) => new Date(b.issueTime) - new Date(a.issueTime));
  const item = items[0];
  if (!item) return null;
  const res = await fetch(item.id);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const doc = new DOMParser().parseFromString(await res.text(), 'application/xml');
  const periods = [];
  for (const f of tag(doc, 'MeteorologicalAerodromeForecast')) {
    const p = { indicator: f.getAttribute('changeIndicator') || 'FM', wx: [], clouds: [] };
    const tp = tag(f, 'TimePeriod')[0];
    if (tp) {
      p.begin = new Date(tag(tp, 'beginPosition')[0].textContent);
      p.end = new Date(tag(tp, 'endPosition')[0].textContent);
    }
    const wd = tag(f, 'meanWindDirection')[0];
    const ws = tag(f, 'meanWindSpeed')[0];
    const wg = tag(f, 'windGustSpeed')[0];
    const swf = tag(f, 'AerodromeSurfaceWindForecast')[0];
    if (wd) p.windDir = round(+wd.textContent);
    if (ws) p.windKt = round(+ws.textContent);
    if (wg) p.gustKt = round(+wg.textContent);
    if (swf && swf.getAttribute('variableWindDirection') === 'true') p.windVrb = true;
    const pv = tag(f, 'prevailingVisibility')[0];
    if (pv) {
      p.visM = +pv.textContent;
      p.visSM = visSMfromM(p.visM);
      if (tag(f, 'prevailingVisibilityOperator')[0] && p.visSM >= 6) p.visPlus = true;
      if (p.visM >= 16000) p.visPlus = true;
    }
    for (const w of tag(f, 'weather')) { const c = code(w); if (c && c !== 'NSW') p.wx.push(c); }
    for (const cl of tag(f, 'CloudLayer')) {
      const amt = code(tag(cl, 'amount')[0] || cl);
      const base = tag(cl, 'base')[0];
      const cb = tag(cl, 'cloudType')[0];
      p.clouds.push({ amt, baseFt: base ? round(+base.textContent) : null, cb: cb && code(cb) === 'CB' ? 'CB' : '' });
    }
    periods.push(p);
  }
  return { issued: item.issueTime, periods };
}

// NWS encodes TAF visibility in meters using a fixed SM→m table; decode it back.
const VIS_TABLE = [[400, '1/4'], [800, '1/2'], [1200, '3/4'], [1600, '1'], [2400, '1 1/2'],
  [3200, '2'], [4800, '3'], [6000, '4'], [8000, '5'], [9000, '6'], [9999, '6']];
function fmtVis(p) {
  if (p.visM == null) return '';
  if (p.visPlus) return 'P6SM';
  for (const [m, sm] of VIS_TABLE) if (Math.abs(p.visM - m) <= 100) return sm + 'SM';
  return (round(p.visM / 1609.34 * 2) / 2) + 'SM';
}

function renderTafs() {
  const grid = $('tafs');
  grid.innerHTML = '';
  const today = localDay(Date.now());
  for (const st of TAF_STATIONS) {
    const t = state.tafs[st.id];
    const card = document.createElement('div');
    card.className = 'card';
    if (!t || t.error) {
      card.innerHTML = `<div class="taf-head"><span class="icao">${st.id}</span>
        <span class="iss">${esc(st.label)}</span></div>
        <div class="apt-err">${t ? esc(t.error) : 'No TAF available.'}</div>`;
      grid.appendChild(card);
      continue;
    }
    const IND = { TEMPORARY_FLUCTUATIONS: 'TEMPO', BECOMING: 'BECMG', PROBABILITY_30: 'PROB30', PROBABILITY_40: 'PROB40' };
    const rows = t.periods.map((p) => {
      const indName = IND[p.indicator] || (p.indicator === 'FM' ? '' : p.indicator.replace(/_/g, ' '));
      const ind = indName ? `<span class="ind">${esc(indName)}</span> ` : '';
      // a period on another day carries its weekday — a stale TAF's "10 AM–8 PM"
      // otherwise reads as today's
      const dayTag = (d, ref) => (localDay(d) === ref ? {} : { weekday: 'short' });
      const when = p.begin
        ? `${fmtDT(p.begin, { hour: 'numeric', ...dayTag(p.begin, today) })}–` +
          `${fmtDT(p.end, { hour: 'numeric', ...dayTag(p.end, localDay(p.begin)) })}`
        : '';
      let wind = '';
      if (p.windKt != null) {
        wind = p.windKt === 0 ? 'calm'
          : `${p.windVrb || p.windDir == null ? 'VRB' : String(p.windDir).padStart(3, '0') + '°'}@${p.windKt}${p.gustKt ? 'G' + p.gustKt : ''}`;
      }
      const clouds = p.clouds.length
        ? p.clouds.map((c) => c.amt === 'SKC' || c.amt === 'NSC' ? 'SKC' : `${c.amt}${c.baseFt != null ? String(round(c.baseFt / 100)).padStart(3, '0') : ''}${c.cb}`).join(' ')
        : 'SKC';
      const ceil = (() => {
        let cl = null;
        for (const c of p.clouds) if (['BKN', 'OVC', 'VV'].includes(c.amt) && c.baseFt != null && (cl == null || c.baseFt < cl)) cl = c.baseFt;
        return cl;
      })();
      const cat = flightCat(p.visPlus ? 7 : p.visSM, ceil);
      return `<div class="taf-period">
        <span class="catdot" style="background:${CAT_COLORS[cat]}" title="${cat}"></span>
        <span class="when">${ind}${when}</span>
        <span class="what">${esc([wind, fmtVis(p), p.wx.join(' '), clouds].filter(Boolean).join(' · '))}</span>
      </div>`;
    }).join('');
    // Issuance age is the honesty check: api.weather.gov served one frozen TAF
    // collection for days at a time (Aug 2026), and "issued 6:57 PM" with no
    // date read as this evening's. Over 6 h old is flagged, not hidden.
    const age = ageMin(t.issued);
    const stale = age > 6 * 60;
    const issued = `${localDay(t.issued) === today ? fmtTime(t.issued)
      : fmtDT(t.issued, { weekday: 'short', hour: 'numeric', minute: '2-digit' })} · ${ageText(age)}`;
    card.innerHTML = `<div class="taf-head"><span class="icao">${st.id}</span>
      <span class="iss${stale ? ' stale' : ''}">${esc(st.label)} · issued ${esc(issued)}` +
      `${t.src === 'site archive' ? ' · via site archive' : ''}` +
      `${stale ? ' · ⚠ stale — no newer issuance on NWS or in the archive' : ''}</span></div>${rows}`;
    grid.appendChild(card);
  }
}

// The archive's newest issuance for a station (latest.json `tafs`), in the
// shape renderTafs() draws. The archiver stores live captures decoded
// (`periods`, the same keys js/taf-tac.js emits) and IEM-healed ones as raw
// text — the NWS TAF collection froze on 2026-08-30 22:57Z and stayed frozen
// for days while LWX kept issuing, so the archive is where current TAFs are.
function archiveTaf(arc, id) {
  const t = arc && arc.tafs && arc.tafs[id];
  if (!t || !t.t) return null;
  let periods = t.periods;
  if (!periods && t.raw && typeof TafTac !== 'undefined') {
    try { periods = TafTac.parse(t.raw, t.t).periods; } catch (e) { periods = null; }
  }
  if (!periods || !periods.length) return null;
  const IND = { FM: 'FM', TEMPO: 'TEMPORARY_FLUCTUATIONS', BECMG: 'BECOMING', PROB30: 'PROBABILITY_30', PROB40: 'PROBABILITY_40' };
  return {
    issued: new Date(t.t * 1000).toISOString(), src: 'site archive',
    periods: periods.map((p) => {
      const q = {
        indicator: IND[p.ind] || String(p.ind || 'FM').replace(/ /g, '_'),
        begin: new Date(p.b * 1000), end: new Date(p.e * 1000),
        wx: p.wx || [],
        clouds: (p.cld || []).map((c) => ({ amt: c.amt, baseFt: c.ft != null ? c.ft : null, cb: c.cb ? 'CB' : '' })),
      };
      if (typeof p.dir === 'number') q.windDir = p.dir;
      if (p.dir === 'VRB' || p.vrb) q.windVrb = true;
      if (p.kt != null) q.windKt = p.kt;
      if (p.gust != null) q.gustKt = p.gust;
      if (p.visM != null) {
        q.visM = p.visM; q.visSM = visSMfromM(p.visM);
        if (p.visM >= 16000) q.visPlus = true;
      }
      return q;
    }),
  };
}

async function loadTafs() {
  const arc = await archiveLatest();
  await Promise.all(TAF_STATIONS.map(async (st) => {
    let live = null, err = null;
    try { live = await loadTaf(st.id); } catch (e) { err = `TAF unavailable (${e.message})`; }
    const a = archiveTaf(arc, st.id);
    // newest issuance wins, whichever source holds it
    if (a && (!live || new Date(a.issued) > new Date(live.issued))) state.tafs[st.id] = a;
    else state.tafs[st.id] = live || { error: err || 'No TAF published right now.' };
  }));
  renderTafs();
}

/* ============================== radar map ================================ */

const radar = { map: null, frames: [], layers: {}, idx: 0, timer: null, playing: true, markers: {} };

function initRadar() {
  radar.map = L.map('radar-map', { zoomControl: true }).setView([KANP.lat, KANP.lon], 8);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png?key=' + SITE.basemap.cartoKey, {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
    maxZoom: 19,
  }).addTo(radar.map);
  const sectional = L.tileLayer(
    'https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/VFR_Sectional/MapServer/tile/{z}/{y}/{x}',
    { attribution: 'FAA', maxZoom: 12, opacity: 0.5 });
  L.control.layers(null, { 'VFR Sectional': sectional }, { collapsed: true }).addTo(radar.map);

  for (const nm of [10, 25]) {
    L.circle([KANP.lat, KANP.lon], {
      radius: nm * 1852, color: '#555', weight: 1, dashArray: '4 6', fill: false, interactive: false,
    }).addTo(radar.map);
  }
  for (const apt of AIRPORTS) {
    radar.markers[apt.id] = L.circleMarker([apt.lat, apt.lon], {
      radius: 7, color: '#111', weight: 1.5, fillColor: '#666', fillOpacity: 0.95,
    }).addTo(radar.map).bindTooltip(apt.id, { permanent: true, direction: 'right', offset: [7, 0], className: 'ring-lbl' });
  }
  loadRadarFrames();
  $('radar-play').addEventListener('click', () => {
    radar.playing = !radar.playing;
    $('radar-play').textContent = radar.playing ? '⏸ Pause' : '▶ Play';
  });
}

function updateRadarMarkers() {
  for (const apt of AIRPORTS) {
    const m = state.metars[apt.metarStation];
    const mk = radar.markers[apt.id];
    if (!mk) continue;
    if (m && !m.error) {
      const ceil = ceilingFt(m);
      const cat = flightCat(m.visSM, ceil);
      mk.setStyle({ fillColor: CAT_COLORS[cat] });
      mk.setTooltipContent(`${apt.id} ${ceil != null ? String(round(ceil / 100)).padStart(3, '0') : m.clear ? 'CLR' : '—'}`);
      mk.bindPopup(`<b>${apt.id}</b> ${cat}${apt.metarStation !== apt.id ? ` (obs ${apt.metarStation})` : ''} · ${ceil != null ? `${ceil.toLocaleString()} ft` : 'no ceiling'}<br><span style="font-family:monospace;font-size:11px">${esc(m.raw.split(' RMK')[0])}</span>`);
    }
  }
}

async function loadRadarFrames() {
  try {
    const d = await fetchJSON('https://api.rainviewer.com/public/weather-maps.json');
    const frames = [...d.radar.past.slice(-7), ...(d.radar.nowcast || [])];
    // clear any previous animation layers
    for (const k of Object.keys(radar.layers)) { radar.map.removeLayer(radar.layers[k]); delete radar.layers[k]; }
    if (radar.timer) clearInterval(radar.timer);
    radar.frames = frames.map((f) => ({
      time: f.time * 1000,
      // free tier serves radar tiles up to z7 only; upscale beyond that
      layer: L.tileLayer(`${d.host}${f.path}/256/{z}/{x}/{y}/2/1_1.png`, { opacity: 0, maxNativeZoom: 7, maxZoom: 19 }),
      future: f.time * 1000 > Date.now(),
    }));
    radar.frames.forEach((f, i) => { radar.layers[i] = f.layer; f.layer.addTo(radar.map); });
    radar.idx = Math.max(0, radar.frames.findIndex((f) => f.future) - 1);
    const show = () => {
      radar.frames.forEach((f, i) => f.layer.setOpacity(i === radar.idx ? 0.72 : 0));
      const f = radar.frames[radar.idx];
      $('radar-label').textContent = `${fmtTime(f.time)}${f.future ? ' (forecast)' : ''}`;
    };
    show();
    radar.timer = setInterval(() => {
      if (!radar.playing) return;
      radar.idx = (radar.idx + 1) % radar.frames.length;
      show();
    }, 750);
  } catch {
    // fallback: static latest NEXRAD composite
    L.tileLayer('https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/{z}/{x}/{y}.png', {
      attribution: 'IEM NEXRAD', opacity: 0.65,
    }).addTo(radar.map);
    $('radar-label').textContent = 'live NEXRAD (animation unavailable)';
    $('radar-play').style.display = 'none';
  }
}

/* ========================== sky wash (page tint) ========================= */
// A gentle full-viewport gradient behind the page, keyed to the sun's phase at
// the field and the current KNAK observation: blue by day, indigo at night,
// amber through civil twilight; an overcast greys it, rain steels it, thunder
// turns it violet, fog washes it pale. Alphas stay low on purpose — the cards
// read exactly as before, the tint lives in the margins and the gaps between
// them. Two stacked layers crossfade so a 5-minute refresh never flashes.

const WASH = {
  day: [74, 158, 255], night: [28, 40, 100], twilight: [236, 132, 72],
  overcast: [118, 132, 156], rain: [56, 104, 168], thunder: [128, 88, 200],
  snow: [186, 204, 232], fog: [138, 148, 160],
};
const mixRgb = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

function skyWashSpec() {
  const now = Date.now(), s = state.sun;
  let phase = 'day';
  if (s && s.dawn && s.sunrise && s.sunset && s.dusk) {
    const soft = 40 * 60000;   // the warm minutes either side of sunrise/sunset
    if (now < s.dawn.getTime() || now > s.dusk.getTime()) phase = 'night';
    else if (now < s.sunrise.getTime() + soft || now > s.sunset.getTime() - soft) phase = 'twilight';
  }
  let rgb = WASH[phase];
  let alpha = phase === 'night' ? 0.22 : phase === 'twilight' ? 0.17 : 0.15;
  const m = state.metars[KANP.metarStation];
  if (m && !m.error) {
    const ceil = ceilingFt(m);
    const wx = (re) => m.wx.some((w) => re.test(w));
    const wet = phase === 'night' ? 0.5 : 0.65;   // night keeps more of its own hue
    if (wx(/TS/)) rgb = mixRgb(rgb, WASH.thunder, wet + 0.1);
    else if (wx(/SN|SG|PL|IC|GS|GR/)) rgb = mixRgb(rgb, WASH.snow, wet);
    else if (wx(/RA|DZ|SH|UP/)) rgb = mixRgb(rgb, WASH.rain, wet);
    else if (wx(/FG|BR|HZ|FU/) || (m.visSM != null && m.visSM < 3)) { rgb = mixRgb(rgb, WASH.fog, wet); alpha *= 0.85; }
    else if (ceil != null && ceil <= 3000) rgb = mixRgb(rgb, WASH.overcast, 0.6);
    else if (m.clouds.some((c) => c.amt === 'BKN' || c.amt === 'OVC')) rgb = mixRgb(rgb, WASH.overcast, 0.35);
    else if (m.clouds.some((c) => c.amt === 'SCT')) rgb = mixRgb(rgb, WASH.overcast, 0.15);
  }
  const c = (a) => `rgba(${rgb.join(',')},${a.toFixed(3)})`;
  return `linear-gradient(180deg, ${c(alpha)} 0%, ${c(alpha * 0.45)} 38%, ${c(0)} 80%)`;
}

function renderSkyWash() {
  let el = $('sky-wash');
  if (!el) {
    el = document.createElement('div');
    el.id = 'sky-wash';
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = '<div></div><div></div>';
    document.body.prepend(el);
  }
  const g = skyWashSpec();
  if (g === state.wash) return;          // same sky — leave it alone
  state.wash = g;
  state.washIdx = 1 - state.washIdx;
  const [a, b] = el.children;
  const next = state.washIdx ? b : a, cur = state.washIdx ? a : b;
  next.style.background = g;
  next.style.opacity = '1';
  cur.style.opacity = '0';
}

/* ============================ orchestration ============================== */

function renderCharts() {
  if (!state.fly) return;
  drawWindChart($('chart-wind'), state.fly);
  drawCeilingChart($('chart-ceiling'), state.fly);
  drawDaChart($('chart-da'), state.fly);
  drawTempChart($('chart-temp'), state.fly);
  drawPrecipChart($('chart-precip'), state.fly);
}

async function loadAll() {
  const dot = $('status-dot'), txt = $('status-text');
  dot.className = 'dot yellow';
  txt.textContent = 'Updating…';
  state.errors = [];
  const gen = ++state.gen;
  if (gen === 1) paintFromArchive(gen).catch(() => {});   // not awaited — the live jobs run alongside

  const jobs = [
    loadMetars().catch((e) => state.errors.push('obs: ' + e.message)),
    loadOpenMeteo().catch((e) => state.errors.push('model: ' + e.message)),
    loadNwsGrid().catch((e) => state.errors.push('NWS grid: ' + e.message)),
    loadAlerts(),
    loadOutlook(),
    loadTafs().catch(() => {}),
  ];
  await Promise.all(jobs);
  state.liveGen = gen;   // from here on the archive paint may not overwrite
  archiveLatest().then(renderArchiveCards).catch(() => {});

  renderSun();
  renderHero();
  renderConditions();
  renderSkyWash();
  renderAirports();
  updateRadarMarkers();
  window.__wxState = state; // debug/inspection hook
  if (state.om) {
    state.fly = buildHours();
    renderFlyStrip(state.fly);
    renderCharts();
    renderAloft();
  }

  const noOb = Object.entries(state.metars).filter(([, m]) => m.error).map(([id]) => id);
  const metarFails = noOb.length;
  if (state.errors.length === 0 && metarFails === 0) {
    dot.className = 'dot green';
    txt.textContent = 'Live';
  } else if (state.om || metarFails < AIRPORTS.length) {
    dot.className = 'dot yellow';
    // say what is missing — a bare "Partial data" reads as a page problem
    const why = state.errors.map((e) => e.split(':')[0] + ' failed');
    if (noOb.length) why.push(`no ob: ${noOb.join(', ')}`);
    txt.textContent = `Partial data · ${why.join(' · ')}`;
  } else {
    dot.className = 'dot red';
    txt.textContent = 'Data sources unreachable';
  }
  $('update-time').textContent = fmtTime(Date.now(), { second: '2-digit' });
  nextRefresh = Date.now() + REFRESH_MS;
}

let nextRefresh = Date.now() + REFRESH_MS;
function tickCountdown() {
  const s = Math.max(0, round((nextRefresh - Date.now()) / 1000));
  $('refresh-count').textContent = `auto-refresh in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

document.addEventListener('DOMContentLoaded', () => {
  initRadar();
  loadAll();
  setInterval(() => { loadAll(); loadRadarFrames(); }, REFRESH_MS);
  setInterval(tickCountdown, 1000);
  $('refresh-btn').addEventListener('click', () => { loadAll(); loadRadarFrames(); });
  let rto;
  window.addEventListener('resize', () => { clearTimeout(rto); rto = setTimeout(renderCharts, 200); });
});
})();
