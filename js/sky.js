/* ---------------------------------------------------------------------------
   METAR Sky — jesselevine.net/sky.html
   Draws the current observation as an animated canvas scene: sky color from
   the real sun position (NOAA solar math, anchored to the airport's TZ),
   cloud decks at their reported bases, precipitation / fog / lightning from
   the present-weather groups, and a windsock flying the actual wind.
   Also: a token-by-token METAR decoder, condition cards, TAF timelines
   rendered as clickable mini-scenes, and a paste-any-METAR box.

   Data: api.weather.gov ONLY (METAR latest obs + IWXXM TAF XML) — never
   aviationweather.gov (no CORS). All directions °true.

   The renderer is a pure deterministic function of (conditions, sun, t), so
   the same code paints the live scene, static TAF thumbnails, and previews.
   --------------------------------------------------------------------------- */
(() => {
'use strict';

/* ============================== config =================================== */

const HOME = SITE.airport;
const STATIONS = [SITE.airport, ...SITE.weather.nearbyAirports];
const TAF_STATIONS = SITE.weather.tafStations;
const NWS = 'https://api.weather.gov';
const TZ = SITE.weather.timeZone;
const REFRESH_MS = 5 * 60 * 1000;

/* =============================== state =================================== */

const state = {
  metars: {},          // metar station id -> parsed metar or {error}
  tafs: {},            // taf station id -> {issued, periods} or {error}
  sel: HOME.id,        // selected airport id
  preview: null,       // {cond, timeMs, label} — TAF period or custom METAR
};

/* =============================== utils =================================== */

const $ = (id) => document.getElementById(id);
const rad = (d) => (d * Math.PI) / 180;
const round = Math.round;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, f) => a + (b - a) * f;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const cToF = (c) => c * 9 / 5 + 32;

function fmtTime(d, opts) {
  return new Date(d).toLocaleTimeString('en-US',
    Object.assign({ timeZone: TZ, hour: 'numeric', minute: '2-digit' }, opts));
}
function ageMin(iso) { return round((Date.now() - new Date(iso).getTime()) / 60000); }

async function fetchJSON(url) {
  const res = await fetch(url, { headers: { Accept: 'application/geo+json, application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url.split('/')[2]}`);
  return res.json();
}

// deterministic 0..1 hash (keeps the scene stable frame-to-frame)
function h01(n) {
  n = Math.imul(n ^ (n >>> 15), 2246822519);
  n = Math.imul(n ^ (n >>> 13), 3266489917);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/* color helpers — hex in, rgb string out */
function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function mixC(c1, c2, f) {
  f = clamp(f, 0, 1);
  return [round(lerp(c1[0], c2[0], f)), round(lerp(c1[1], c2[1], f)), round(lerp(c1[2], c2[2], f))];
}
const css = (c, a) => a == null ? `rgb(${c[0]},${c[1]},${c[2]})` : `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const mix = (h1, h2, f) => mixC(rgb(h1), rgb(h2), f);

/* ========================= solar (NOAA equations) ======================== */
// Same math as weather.js — anchored on the calendar day AT THE AIRPORT'S TZ,
// never the viewer's browser timezone (a viewer west of the field would
// otherwise get dawn/dusk a day off).
function solarTimes(date, lat, lon) {
  const [y, mo, d] = date.toLocaleDateString('en-CA', { timeZone: TZ }).split('-').map(Number);
  const base = Date.UTC(y, mo - 1, d);
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

// Sun/moon state for a moment: e = elevation proxy (-0.5..1), f = sun path
// fraction (0 rise → 1 set), nf = night path fraction for the moon.
function sunState(ms, lat, lon) {
  const s = solarTimes(new Date(ms), lat, lon);
  let e = -0.5, f = 0.5;
  const t = +ms;
  if (s.sunrise && s.sunset && t >= +s.sunrise && t <= +s.sunset) {
    f = (t - s.sunrise) / (s.sunset - s.sunrise);
    e = Math.sin(Math.PI * f);
  } else if (s.dawn && s.sunrise && t >= +s.dawn && t < +s.sunrise) {
    e = -0.12 * (s.sunrise - t) / (s.sunrise - s.dawn); f = 0;
  } else if (s.dusk && s.sunset && t > +s.sunset && t <= +s.dusk) {
    e = -0.12 * (t - s.sunset) / (s.dusk - s.sunset); f = 1;
  } else if (s.dusk && t > +s.dusk) {
    e = clamp(-0.12 - (t - s.dusk) / 3600000 * 0.25, -0.5, -0.12);
  } else if (s.dawn && t < +s.dawn) {
    e = clamp(-0.12 - (s.dawn - t) / 3600000 * 0.25, -0.5, -0.12);
  }
  // moon path: rough local-hour arc 19:00 → 05:00
  const parts = new Date(ms).toLocaleTimeString('en-GB', { timeZone: TZ, hour12: false, hour: '2-digit', minute: '2-digit' }).split(':');
  const lh = +parts[0] + (+parts[1]) / 60;
  const nf = clamp(((lh - 19 + 24) % 24) / 10, 0, 1);
  return { e, f, nf, night: e <= 0 };
}

// moon phase 0..1 (0 = new, 0.5 = full)
function moonPhase(ms) {
  const SYNODIC = 29.530588853 * 86400000;
  return (((ms - 947182440000) % SYNODIC) + SYNODIC) % SYNODIC / SYNODIC;
}

/* ============================ METAR parsing ============================== */
// Same grammar as weather.js parseMetar.
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

function ceilingFt(clouds) {
  let ceil = null;
  for (const c of clouds) {
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

/* ===================== scene conditions from a METAR ===================== */

const COVER = { FEW: 0.18, SCT: 0.45, BKN: 0.8, OVC: 1, VV: 1 };

// m = parsed METAR (or a TAF-period merge shaped like one) → everything the
// painter needs.
function sceneCond(m) {
  const c = {
    windKt: m.windKt == null ? 0 : m.windKt,
    gustKt: m.gustKt || null,
    windDir: m.windDir == null ? null : m.windDir,
    windVrb: !!m.windVrb,
    visSM: m.visSM == null ? 10 : m.visSM,
    visKnown: m.visSM != null,
    clouds: (m.clouds || []).filter((l) => l.baseFt != null),
    clear: !!m.clear,
    tempC: m.tempC != null ? m.tempC : null,
    dewC: m.dewC != null ? m.dewC : null,
    altInHg: m.altInHg != null ? m.altInHg : null,
    wxCodes: m.wx || [],
    raw: m.raw || null,
  };
  let rain = 0, snow = 0, drzl = 0, sleet = 0;
  let ts = false, fog = false, mist = false, haze = false, smoke = false, fz = false, funnel = false;
  for (const w of c.wxCodes) {
    const int = w.startsWith('+') ? 3 : w.startsWith('-') ? 1 : 2;
    const vc = w.includes('VC');
    if (/TS/.test(w)) ts = true;
    if (/RA|UP/.test(w)) rain = Math.max(rain, vc ? 1 : int);
    if (/DZ/.test(w)) drzl = Math.max(drzl, int);
    if (/SN|SG/.test(w)) snow = Math.max(snow, vc ? 1 : int);
    if (/GR|GS|PL|IC/.test(w)) sleet = Math.max(sleet, int);
    if (/SH/.test(w) && !/RA|SN|GR|GS|PL/.test(w)) rain = Math.max(rain, int);
    if (/FG/.test(w)) fog = true;
    if (/BR/.test(w)) mist = true;
    if (/HZ|DU|SA|PO/.test(w)) haze = true;
    if (/FU|VA/.test(w)) smoke = true;
    if (/FZ/.test(w)) fz = true;
    if (/FC/.test(w)) funnel = true;
  }
  Object.assign(c, { rain, snow, drzl, sleet, ts, fog, mist, haze, smoke, fz, funnel });
  c.precipInt = Math.max(rain, snow, drzl * 0.6, sleet);
  c.cover = c.clouds.reduce((a, l) => Math.max(a, COVER[l.amt] || 0), 0);
  // gloom weight: a high deck (cirrus country) barely dims the day
  const hw = (ft) => ft <= 8000 ? 1 : ft >= 15000 ? 0.2 : 1 - (ft - 8000) / 7000 * 0.8;
  c.gloomCover = c.clouds.reduce((a, l) => Math.max(a, (COVER[l.amt] || 0) * hw(l.baseFt)), 0);
  c.hasCb = c.clouds.some((l) => l.cb) || ts;
  c.ceil = ceilingFt(c.clouds);
  c.cat = flightCat(m.visSM, c.ceil);
  c.snowGround = snow > 0 || (sleet > 0 && c.tempC != null && c.tempC <= 1);
  return c;
}

/* ============================ the painter ================================ */
// Pure function of (cond, sun, t, seed): paints one frame. Used by the live
// scene, TAF thumbnails (fixed t) and previews alike.

const SKY_STOPS = [
  [-0.50, ['#04060f', '#070b18', '#0d1322']],
  [-0.12, ['#070d1f', '#141a38', '#3a2a44']],
  [0.00, ['#12204a', '#4a3a6e', '#e8804a']],
  [0.12, ['#2a5aa0', '#6a8ac4', '#f0b878']],
  [0.45, ['#3a7bd5', '#6ba3e0', '#b8d8f0']],
  [1.00, ['#2f6ec8', '#66a0dd', '#c4e0f4']],
];

function skyColors(e) {
  let i = 0;
  while (i < SKY_STOPS.length - 2 && e > SKY_STOPS[i + 1][0]) i++;
  const [e0, c0] = SKY_STOPS[i], [e1, c1] = SKY_STOPS[i + 1];
  const f = clamp((e - e0) / (e1 - e0), 0, 1);
  return [mix(c0[0], c1[0], f), mix(c0[1], c1[1], f), mix(c0[2], c1[2], f)];
}

function drawScene(ctx, W, H, cond, sun, t, seed) {
  const c = cond;
  const horY = H * 0.8;
  const dl = clamp((sun.e + 0.12) / 0.5, 0, 1);               // daylight 0..1
  const gloom = clamp(c.gloomCover * 0.62 + c.precipInt * 0.09 + (c.fog ? 0.25 : 0) + (c.smoke ? 0.15 : 0), 0, 0.88);
  const L = clamp((0.07 + 0.93 * dl) * (1 - 0.5 * gloom), 0.04, 1); // scene light level
  const visA = clamp(c.visSM / 8, 0.06, 1);                   // how far you can see
  const gray = mixC([26, 30, 36], [138, 147, 160], dl);       // gloom tone at this light
  const H1 = (n) => h01(seed + n);                            // seeded hash

  /* ---- 1. sky ---- */
  let [top, mid, hor] = skyColors(sun.e).map((col) => mixC(col, gray, gloom));
  const skyGrad = ctx.createLinearGradient(0, 0, 0, horY);
  skyGrad.addColorStop(0, css(top));
  skyGrad.addColorStop(0.62, css(mid));
  skyGrad.addColorStop(1, css(hor));
  ctx.fillStyle = skyGrad;
  ctx.fillRect(0, 0, W, H);

  /* ---- 2. stars ---- */
  if (dl < 0.28) {
    const starA = (1 - dl / 0.28) * (1 - (c.cover * 0.45 + c.gloomCover * 0.55)) * visA;
    if (starA > 0.02) {
      for (let i = 0; i < 110; i++) {
        const x = h01(seed * 3 + i) * W;
        const y = h01(seed * 3 + i + 500) * horY * 0.92;
        const tw = 0.55 + 0.45 * Math.sin(t * (0.6 + h01(i) * 2) + i);
        ctx.fillStyle = css([230, 235, 245], starA * tw * (0.35 + 0.65 * h01(i + 900)));
        const r = h01(i + 300) > 0.92 ? 1.4 : 0.8;
        ctx.fillRect(x, y, r, r);
      }
    }
  }

  /* ---- 3. sun / moon ---- */
  const blocked = clamp((c.cover + c.gloomCover) * 0.6 + (c.fog ? 0.8 : 0) + (1 - visA) * 0.5, 0, 1);
  if (sun.e > 0.005) {
    const sx = W * (0.1 + 0.8 * sun.f);
    const sy = horY - sun.e * (horY - H * 0.1);
    const warm = clamp(1 - sun.e * 2.2, 0, 1); // orange near horizon
    const sc = mixC(rgb('#fff6d8'), rgb('#ff9840'), warm);
    const R = H * 0.055;
    const glow = ctx.createRadialGradient(sx, sy, 0, sx, sy, R * 5);
    glow.addColorStop(0, css(sc, 0.5 * (1 - blocked * 0.8)));
    glow.addColorStop(1, css(sc, 0));
    ctx.fillStyle = glow;
    ctx.fillRect(sx - R * 5, sy - R * 5, R * 10, R * 10);
    if (blocked < 0.85) {
      ctx.fillStyle = css(sc, 1 - blocked);
      ctx.beginPath(); ctx.arc(sx, sy, R, 0, 7); ctx.fill();
    }
  } else if (dl < 0.25) {
    const mx = W * (0.15 + 0.7 * sun.nf);
    const my = horY - Math.sin(Math.PI * clamp(sun.nf, 0.02, 0.98)) * (horY - H * 0.14) * 0.85;
    const R = H * 0.045;
    const ph = moonPhase(Date.now());
    const illum = 1 - Math.abs(ph - 0.5) * 2;
    const mA = (1 - blocked * 0.85) * (1 - dl / 0.25);
    if (mA > 0.03) {
      const glow = ctx.createRadialGradient(mx, my, 0, mx, my, R * 4);
      glow.addColorStop(0, css([220, 224, 216], 0.25 * mA * illum));
      glow.addColorStop(1, css([220, 224, 216], 0));
      ctx.fillStyle = glow;
      ctx.fillRect(mx - R * 4, my - R * 4, R * 8, R * 8);
      ctx.save();
      ctx.globalAlpha = mA;
      ctx.fillStyle = '#e6e2d4';
      ctx.beginPath(); ctx.arc(mx, my, R, 0, 7); ctx.fill();
      // phase shadow: offset dark disc, clipped so it only darkens the moon
      if (illum < 0.97) {
        const d = illum * 2.15 * R * (ph < 0.5 ? -1 : 1);
        ctx.beginPath(); ctx.arc(mx, my, R + 0.5, 0, 7); ctx.clip();
        ctx.fillStyle = css(mixC(top, [10, 12, 20], 0.4));
        ctx.beginPath(); ctx.arc(mx + d, my, R * 1.02, 0, 7); ctx.fill();
      }
      ctx.restore();
    }
  }

  /* ---- 4. far scenery (Chesapeake horizon), faded by visibility ---- */
  ctx.save();
  ctx.globalAlpha = clamp((visA - 0.08) * 1.15, 0, 1);
  // water strip
  const wat = mixC(mixC(hor, rgb('#2a4a66'), 0.55), gray, gloom * 0.4);
  ctx.fillStyle = css(wat);
  ctx.fillRect(0, horY - H * 0.018, W, H * 0.018 + 1);
  if (sun.e > 0.02 && blocked < 0.7) { // sun glints
    ctx.fillStyle = css([255, 240, 200], 0.25 * (1 - blocked));
    for (let i = 0; i < 14; i++) {
      const gx = W * (0.1 + 0.8 * sun.f) + (h01(i + 40) - 0.5) * W * 0.16;
      ctx.fillRect(gx, horY - H * 0.014 + h01(i) * H * 0.012, 6 + h01(i + 7) * 10, 1.2);
    }
  }
  // far treeline
  const farCol = mixC(mixC(hor, [16, 22, 18], 0.75), hor, 1 - visA);
  ctx.fillStyle = css(farCol);
  ctx.beginPath();
  ctx.moveTo(0, horY - H * 0.018);
  for (let x = 0; x <= W; x += W / 40) {
    ctx.lineTo(x, horY - H * 0.018 - (0.35 + h01(seed + x) * 0.65) * H * 0.028);
  }
  ctx.lineTo(W, horY - H * 0.018); ctx.closePath(); ctx.fill();
  // sailboats out on the bay (daytime, sailable wind, decent vis)
  if (dl > 0.3 && c.windKt > 3 && c.windKt < 22 && c.precipInt === 0 && visA > 0.5) {
    for (let i = 0; i < 2; i++) {
      const bx = ((t * (2.5 + i) + H1(i) * W * 3) % (W * 1.2)) - W * 0.1;
      const by = horY - H * 0.02;
      const s = H * 0.022 * (0.7 + 0.3 * h01(i + 12));
      const heel = clamp(c.windKt / 30, 0, 0.4) * (i % 2 ? 1 : -1);
      ctx.save();
      ctx.translate(bx, by); ctx.rotate(heel);
      ctx.fillStyle = css(mixC([235, 238, 242], hor, 1 - visA), 0.85);
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -s * 1.5); ctx.lineTo(s * 0.7, 0); ctx.closePath(); ctx.fill();
      ctx.restore();
    }
  }
  ctx.restore();

  /* ---- 5. clouds ---- */
  const altY = (ft) => horY - 8 - Math.pow(clamp(ft / 18000, 0, 1), 0.55) * (horY - H * 0.07 - 8);
  const cloudTop = mixC(mixC([242, 245, 248], [122, 130, 142], gloom), [30, 36, 50], 1 - L * 1.6 > 0 ? clamp(1 - L * 1.6, 0, 0.88) : 0);
  const cloudBot = mixC(cloudTop, [40, 46, 58], 0.45 + gloom * 0.3);
  const layers = [...c.clouds].sort((a, b) => b.baseFt - a.baseFt); // high first
  let li = 0;
  for (const lay of layers) {
    li++;
    if (lay.amt === 'VV') continue; // obscuration handled by fog pass
    const y = altY(lay.baseFt);
    const drift = (t * (4 + c.windKt * 0.9) * (0.4 + 0.6 * clamp(lay.baseFt / 12000, 0, 1))) % W;
    const ls = seed + li * 977;
    const high = lay.baseFt >= 12000; // cirrus country — thin translucent veil
    if (high) {
      const cov = COVER[lay.amt] || 0.2;
      const cirA = 0.16 + cov * 0.3;
      ctx.fillStyle = css(mixC(cloudTop, [255, 255, 255], 0.3), cirA);
      const n = round(4 + cov * 8);
      for (let i = 0; i < n; i++) {
        const cw = W * (0.1 + h01(ls + i) * 0.16);
        const cx = ((h01(ls + i + 31) * W + drift * 0.5) % (W + cw * 2)) - cw;
        const cy = y + (h01(ls + i + 61) - 0.5) * H * 0.06;
        ctx.beginPath();
        ctx.ellipse(cx, cy, cw, H * (0.008 + h01(ls + i + 7) * 0.008), 0, 0, 7);
        ctx.fill();
      }
    } else if (lay.amt === 'BKN' || lay.amt === 'OVC') {
      // solid deck: fill above the base, bumpy bottom edge
      const thick = lay.amt === 'OVC' ? y : Math.min(y, H * 0.16);
      ctx.fillStyle = css(cloudBot);
      ctx.fillRect(0, y - thick, W, thick);
      const n = 30;
      for (let i = -2; i < n + 2; i++) {
        const bx = ((i / n) * W + drift * 0.35) % (W + W / n * 4) - W / n * 2;
        const ry = H * (0.022 + h01(ls + i) * 0.03);
        ctx.beginPath();
        ctx.ellipse(bx, y - ry * 0.3 + (h01(ls + i + 50) - 0.5) * H * 0.02, W / n * 1.5, ry, 0, 0, 7);
        ctx.fill();
      }
      // lighter tops band
      ctx.fillStyle = css(mixC(cloudBot, cloudTop, 0.55));
      ctx.fillRect(0, y - thick, W, Math.max(2, thick - H * 0.05));
    } else { // FEW / SCT — individual cumulus
      const nCl = lay.amt === 'SCT' ? 5 : 2;
      for (let i = 0; i < nCl; i++) {
        const cw = W * (0.09 + h01(ls + i) * 0.08);
        const cx = ((h01(ls + i + 31) * W + drift) % (W + cw * 2)) - cw;
        const cy = y - H * 0.012 + (h01(ls + i + 61) - 0.5) * H * 0.03;
        const puffs = 6;
        for (let p = 0; p < puffs; p++) {
          const px = cx + (p / (puffs - 1) - 0.5) * cw;
          const pr = cw * (0.16 + h01(ls + i * 9 + p) * 0.14) * (1 - Math.abs(p / (puffs - 1) - 0.5) * 0.8);
          ctx.fillStyle = css(mixC(cloudTop, cloudBot, h01(ls + i * 9 + p + 400) * 0.25), 0.95);
          ctx.beginPath(); ctx.arc(px, cy - pr * 0.4, pr, 0, 7); ctx.fill();
        }
        ctx.fillStyle = css(cloudBot, 0.5);
        ctx.beginPath(); ctx.ellipse(cx, cy + 2, cw * 0.4, cw * 0.045, 0, 0, 7);
        ctx.fill();
      }
    }
  }

  // cumulonimbus tower (CB reported, or thunderstorm)
  if (c.hasCb) {
    const cbBase = c.clouds.find((l) => l.cb) || { baseFt: c.ceil || 3000 };
    const yb = altY(cbBase.baseFt);
    const cbx = W * (0.6 + H1(5) * 0.25);
    const topY = H * 0.08;
    const colDark = mixC(cloudBot, [24, 28, 40], 0.5);
    for (let i = 0; i < 12; i++) {
      const f = i / 11;
      const y = lerp(yb, topY, f);
      const half = W * lerp(0.09, 0.045, f) * (1 + 0.15 * Math.sin(i * 2.7 + seed));
      ctx.fillStyle = css(mixC(colDark, cloudTop, f * 0.55), 0.96);
      ctx.beginPath(); ctx.ellipse(cbx + Math.sin(i * 1.9 + seed) * W * 0.012, y, half, H * 0.045, 0, 0, 7);
      ctx.fill();
    }
    // anvil
    ctx.fillStyle = css(mixC(cloudTop, colDark, 0.25), 0.92);
    ctx.beginPath(); ctx.ellipse(cbx + W * 0.03, topY, W * 0.14, H * 0.032, 0, 0, 7); ctx.fill();
    // rain shaft under the cell
    if (c.precipInt > 0 || c.ts) {
      ctx.fillStyle = css(mixC(colDark, [80, 90, 105], 0.3), 0.3);
      ctx.beginPath();
      ctx.moveTo(cbx - W * 0.06, yb); ctx.lineTo(cbx + W * 0.06, yb);
      ctx.lineTo(cbx + W * 0.09, horY); ctx.lineTo(cbx - W * 0.02, horY);
      ctx.closePath(); ctx.fill();
    }
  }

  /* ---- 6. ground & foreground ---- */
  const grass = c.snowGround
    ? mixC([223, 228, 234], [34, 40, 52], 1 - L)
    : mixC(mixC([49, 62, 42], [16, 20, 16], 1 - L), gray, gloom * 0.25);
  ctx.fillStyle = css(grass);
  ctx.fillRect(0, horY, W, H - horY);
  if (c.rain > 0 || c.drzl > 0) { // wet ground sheen
    ctx.fillStyle = css([255, 255, 255], 0.035);
    ctx.fillRect(0, horY, W, H - horY);
  }

  // runway (perspective, viewer looking down the strip)
  const cxr = W * 0.5;
  const rwCol = c.snowGround ? mixC([200, 205, 212], [30, 34, 42], 1 - L) : mixC([62, 67, 74], [16, 18, 24], 1 - L);
  ctx.fillStyle = css(rwCol);
  ctx.beginPath();
  ctx.moveTo(cxr - W * 0.16, H); ctx.lineTo(cxr - W * 0.013, horY + 3);
  ctx.lineTo(cxr + W * 0.013, horY + 3); ctx.lineTo(cxr + W * 0.16, H);
  ctx.closePath(); ctx.fill();
  // centerline dashes + threshold
  if (!c.snowGround) {
    ctx.fillStyle = css([210, 214, 220], 0.5 * clamp(L * 2.5, 0.25, 1));
    for (let i = 0; i < 7; i++) {
      const f0 = 0.06 + i * 0.13, f1 = f0 + 0.06;
      const y0 = lerp(H, horY + 3, f0), y1 = lerp(H, horY + 3, f1);
      const w0 = lerp(W * 0.006, W * 0.0006, f0), w1 = lerp(W * 0.006, W * 0.0006, f1);
      ctx.beginPath();
      ctx.moveTo(cxr - w0, y0); ctx.lineTo(cxr - w1, y1);
      ctx.lineTo(cxr + w1, y1); ctx.lineTo(cxr + w0, y0);
      ctx.closePath(); ctx.fill();
    }
    for (let s = -1; s <= 1; s += 2) { // threshold stripes
      for (let i = 1; i <= 3; i++) {
        const x = cxr + s * W * 0.03 * i;
        ctx.fillRect(x - W * 0.008, H - H * 0.035, W * 0.016, H * 0.028);
      }
    }
  }
  // runway lighting after dark (or in genuinely poor light)
  const lightsOn = L < 0.42;
  if (lightsOn) {
    for (let i = 0; i <= 9; i++) {
      const f = i / 9;
      const y = lerp(H - 4, horY + 5, f);
      const dx = lerp(W * 0.165, W * 0.016, f);
      const r = lerp(2.2, 0.7, f);
      ctx.fillStyle = i === 9 ? '#35e07a' : '#f5f2d8';
      ctx.beginPath(); ctx.arc(cxr - dx, y, r, 0, 7); ctx.fill();
      ctx.beginPath(); ctx.arc(cxr + dx, y, r, 0, 7); ctx.fill();
    }
    // PAPI — two white two red, on glide
    const py = lerp(H, horY, 0.45);
    for (let i = 0; i < 4; i++) {
      ctx.fillStyle = i < 2 ? '#fff' : '#ff4545';
      ctx.beginPath(); ctx.arc(cxr - W * 0.2 - i * W * 0.012, py, 1.6, 0, 7); ctx.fill();
    }
  }

  // trees left and right, swaying with the wind
  const sway = Math.sin(t * 1.4 + seed) * clamp(c.windKt, 0, 30) * 0.15;
  const treeCol = c.snowGround ? mixC([120, 130, 125], [20, 26, 24], 1 - L) : mixC([30, 42, 28], [10, 14, 12], 1 - L);
  for (const [tx0, tw, th] of [[0.02, 0.13, 0.1], [0.86, 0.13, 0.085]]) {
    ctx.fillStyle = css(treeCol);
    ctx.beginPath();
    const baseY = horY + H * 0.01;
    ctx.moveTo(W * tx0, baseY);
    for (let i = 0; i <= 10; i++) {
      const f = i / 10;
      ctx.lineTo(W * tx0 + f * W * tw + sway * f * (1 - f) * 4,
        baseY - Math.sin(f * Math.PI) * H * th * (0.6 + h01(seed + i + tx0 * 999) * 0.4));
    }
    ctx.closePath(); ctx.fill();
  }

  // parked high-wing silhouette, right of the runway
  {
    const px = W * 0.73, py = horY + H * 0.055, s = H * 0.052;
    ctx.fillStyle = css(mixC([16, 19, 24], [200, 205, 210], L * 0.18));
    ctx.strokeStyle = ctx.fillStyle;
    ctx.lineWidth = Math.max(1.5, s * 0.09);
    ctx.beginPath(); // fuselage
    ctx.ellipse(px, py - s * 0.42, s * 0.85, s * 0.2, 0, 0, 7); ctx.fill();
    ctx.beginPath(); // wing
    ctx.moveTo(px - s * 0.75, py - s * 0.72); ctx.lineTo(px + s * 0.55, py - s * 0.72);
    ctx.stroke();
    ctx.beginPath(); // strut + tail + gear
    ctx.moveTo(px - s * 0.25, py - s * 0.7); ctx.lineTo(px - s * 0.05, py - s * 0.45);
    ctx.moveTo(px + s * 0.55, py - s * 0.5); ctx.lineTo(px + s * 0.85, py - s * 0.85);
    ctx.moveTo(px - s * 0.3, py - s * 0.28); ctx.lineTo(px - s * 0.3, py);
    ctx.moveTo(px + s * 0.25, py - s * 0.28); ctx.lineTo(px + s * 0.25, py);
    ctx.stroke();
    ctx.beginPath(); ctx.moveTo(px + s * 0.85, py - s * 0.85); ctx.lineTo(px + s * 0.85, py - s * 0.4); ctx.lineTo(px + s * 0.6, py - s * 0.4); ctx.closePath(); ctx.fill();
  }

  // rotating beacon — on from sunset to sunrise, or in daytime IFR (that's
  // the "beacon on in daylight" signal that the field is below VFR minimums)
  const beaconOn = sun.e < 0.015 || c.cat === 'IFR' || c.cat === 'LIFR';
  {
    const bx = W * 0.905, byTop = horY - H * 0.075;
    ctx.strokeStyle = css(mixC([18, 21, 26], [190, 195, 200], L * 0.2));
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(bx - H * 0.012, horY + H * 0.012); ctx.lineTo(bx, byTop);
    ctx.moveTo(bx + H * 0.012, horY + H * 0.012); ctx.lineTo(bx, byTop);
    for (let i = 1; i <= 3; i++) {
      const f = i / 4;
      ctx.moveTo(bx - H * 0.012 * (1 - f), lerp(horY + H * 0.012, byTop, f));
      ctx.lineTo(bx + H * 0.012 * (1 - f), lerp(horY + H * 0.012, byTop, f));
    }
    ctx.stroke();
    if (beaconOn) {
      const cyc = t % 2; // white … green, ~2 s rotation
      let flash = null;
      if (cyc < 0.13) flash = [255, 255, 240];
      else if (cyc > 1 && cyc < 1.13) flash = [60, 235, 120];
      if (flash) {
        const g = ctx.createRadialGradient(bx, byTop - 3, 0, bx, byTop - 3, H * 0.06);
        g.addColorStop(0, css(flash, 0.85));
        g.addColorStop(1, css(flash, 0));
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(bx, byTop - 3, H * 0.06, 0, 7); ctx.fill();
      }
      ctx.fillStyle = css([255, 255, 245], 0.7);
      ctx.beginPath(); ctx.arc(bx, byTop - 3, 1.6, 0, 7); ctx.fill();
    }
  }

  // windsock — angle from wind speed (rated: fully extended at 15 kt),
  // pointing downwind; foreshortened when the wind blows along the view axis
  {
    const px = W * 0.235, base = horY + H * 0.075, poleH = H * 0.16;
    const topY = base - poleH;
    ctx.strokeStyle = css(mixC([90, 95, 100], [30, 33, 38], 1 - L));
    ctx.lineWidth = Math.max(1.5, H * 0.006);
    ctx.beginPath(); ctx.moveTo(px, base); ctx.lineTo(px, topY); ctx.stroke();
    // effective wind: breathe between sustained and gusts
    let wEff = c.windKt;
    if (c.gustKt) {
      const g = Math.max(0, Math.sin(t * 0.9) * 0.6 + Math.sin(t * 2.3) * 0.4);
      wEff = lerp(c.windKt, c.gustKt, clamp(g, 0, 1));
    }
    const toward = c.windDir == null ? 90 : (c.windDir + 180) % 360; // blowing toward
    const ew = c.windDir == null ? 1 : Math.sin(rad(toward));        // + = toward east (right; scene faces north)
    const dirSign = c.windVrb ? Math.sign(Math.sin(t * 0.35) || 1) : (ew >= 0 ? 1 : -1);
    const fores = c.windVrb || c.windDir == null ? 0.9 : Math.max(0.4, Math.abs(ew));
    const ext = clamp(wEff / 15, 0, 1);
    const sockLen = H * 0.085 * fores;
    let ang = lerp(Math.PI * 0.44, 0.06, ext); // from hanging to horizontal
    const flut = Math.sin(t * (5 + wEff * 0.4)) * (0.16 - 0.13 * ext) + Math.sin(t * 9.7) * 0.04 * (1 - ext);
    ctx.save();
    ctx.translate(px, topY);
    let sx0 = 0, sy0 = 0, a = ang + flut;
    const segs = 5, segL = sockLen / segs;
    for (let i = 0; i < segs; i++) {
      const w0 = H * 0.016 * (1 - i / segs * 0.75);
      const w1 = H * 0.016 * (1 - (i + 1) / segs * 0.75);
      const aSeg = a + (1 - ext) * i * 0.22 + Math.sin(t * 8 + i * 1.7) * 0.05 * (1 - ext * 0.5);
      const sx1 = sx0 + Math.cos(aSeg) * segL * dirSign;
      const sy1 = sy0 + Math.sin(aSeg) * segL;
      ctx.fillStyle = i % 2 ? '#e8e4dc' : '#e2701d';
      if (L < 0.35) ctx.fillStyle = i % 2 ? css(mixC([232, 228, 220], [60, 62, 66], 0.6)) : css(mixC([226, 112, 29], [70, 40, 18], 0.55));
      ctx.beginPath();
      ctx.moveTo(sx0, sy0 - w0); ctx.lineTo(sx1, sy1 - w1);
      ctx.lineTo(sx1, sy1 + w1); ctx.lineTo(sx0, sy0 + w0);
      ctx.closePath(); ctx.fill();
      sx0 = sx1; sy0 = sy1;
    }
    ctx.restore();
  }

  // birds on a nice day
  if (dl > 0.35 && c.precipInt === 0 && !c.fog && c.windKt < 15 && c.visSM > 5) {
    const bt = (t * 16) % (W * 1.7) - W * 0.35;
    for (let i = 0; i < 5; i++) {
      const bx = bt + i * 26 + h01(i + 70) * 14;
      const by = H * 0.3 + h01(i + 80) * H * 0.1 + Math.sin(t * 2 + i) * 3;
      if (bx < -20 || bx > W + 20) continue;
      ctx.strokeStyle = css([20, 24, 30], 0.55);
      ctx.lineWidth = 1.2;
      const flap = Math.sin(t * 7 + i * 2) * 2.5;
      ctx.beginPath();
      ctx.moveTo(bx - 5, by - flap); ctx.quadraticCurveTo(bx, by + 2, bx + 0.5, by);
      ctx.quadraticCurveTo(bx + 1, by + 2, bx + 6, by - flap);
      ctx.stroke();
    }
  }

  /* ---- 7. precipitation (in front of everything on the field) ---- */
  const slant = c.windDir == null ? 0.15 : clamp(c.windKt / 35, 0, 0.75) * (Math.sin(rad((c.windDir + 180) % 360)) >= 0 ? 1 : -1);
  if (c.rain > 0 || (c.ts && c.precipInt === 0)) {
    const int = Math.max(c.rain, c.ts ? 2 : 0);
    const n = Math.floor(W / 22 * int * int);
    const rc = mixC([160, 180, 210], [70, 85, 110], 1 - L);
    ctx.strokeStyle = css(rc, 0.4);
    ctx.lineWidth = int >= 3 ? 1.5 : 1;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const spd = 420 + h01(i) * 260 + int * 90;
      const len = 9 + int * 5 + h01(i + 11) * 8;
      const yy = ((h01(i + 23) * H + t * spd) % (H + 40)) - 20;
      const xx = ((h01(i + 37) * (W + 200) - 100 + yy * slant) % (W + 200) + (W + 200)) % (W + 200) - 100;
      ctx.moveTo(xx, yy);
      ctx.lineTo(xx + slant * len, yy + len);
    }
    ctx.stroke();
  }
  if (c.drzl > 0 && c.rain === 0) {
    const n = Math.floor(W / 14 * c.drzl);
    ctx.fillStyle = css(mixC([170, 185, 205], [80, 90, 108], 1 - L), 0.3);
    for (let i = 0; i < n; i++) {
      const spd = 90 + h01(i) * 70;
      const yy = ((h01(i + 5) * H + t * spd) % H);
      const xx = (h01(i + 9) * W + Math.sin(t + i) * 6) % W;
      ctx.fillRect(xx, yy, 1.2, 2.5);
    }
  }
  if (c.snow > 0) {
    const n = Math.floor(W / 10 * c.snow * c.snow);
    ctx.fillStyle = css([235, 240, 248], 0.8);
    for (let i = 0; i < n; i++) {
      const spd = 45 + h01(i) * 55 + c.snow * 12;
      const yy = ((h01(i + 3) * H + t * spd) % (H + 20)) - 10;
      const xx = ((h01(i + 17) * (W + 100) + Math.sin(t * (0.8 + h01(i) * 1.2) + i) * 22 + yy * slant * 0.6) % (W + 100) + (W + 100)) % (W + 100) - 50;
      const r = 0.8 + h01(i + 29) * 1.8;
      ctx.beginPath(); ctx.arc(xx, yy, r, 0, 7); ctx.fill();
    }
  }
  if (c.sleet > 0) {
    const n = Math.floor(W / 20 * c.sleet);
    ctx.fillStyle = css([220, 228, 238], 0.75);
    for (let i = 0; i < n; i++) {
      const spd = 380 + h01(i) * 180;
      const yy = ((h01(i + 41) * H + t * spd) % H);
      const xx = ((h01(i + 43) * W + yy * slant) % W + W) % W;
      ctx.fillRect(xx, yy, 1.8, 4);
    }
  }

  /* ---- 8. lightning ---- */
  if (c.ts) {
    for (let k = 0; k < 2; k++) {
      const period = 4.2 + h01(k + 55) * 3.5;
      const ph = (t + h01(k + 66) * 20) % period;
      if (ph < 0.4) {
        const strike = Math.floor((t + h01(k + 66) * 20) / period);
        if (ph < 0.14) { // the bolt itself
          const bx = (h01(strike * 7 + k) * 0.8 + 0.1) * W;
          const by0 = altY((c.ceil || 3000)) + H * 0.02;
          ctx.strokeStyle = css([255, 250, 230], 0.9 * (1 - ph / 0.14));
          ctx.lineWidth = 2;
          ctx.beginPath();
          let lx = bx, ly = by0;
          ctx.moveTo(lx, ly);
          const steps = 7;
          for (let i = 1; i <= steps; i++) {
            lx += (h01(strike * 31 + i + k * 100) - 0.5) * W * 0.05;
            ly += (horY - by0) / steps;
            ctx.lineTo(lx, ly);
          }
          ctx.stroke();
        }
        // scene flash
        ctx.fillStyle = css([235, 240, 255], 0.28 * Math.exp(-ph * 9));
        ctx.fillRect(0, 0, W, H);
      }
    }
  }

  /* ---- 9. obscuration: fog / mist / haze / smoke ---- */
  let fogA = 0;
  if (c.fog || c.clouds.some((l) => l.amt === 'VV')) fogA = 0.85;
  else if (c.mist) fogA = 0.42;
  fogA = Math.max(fogA, clamp(1 - c.visSM / 8, 0, 1) * 0.6);
  if (fogA > 0.02) {
    const fogCol = mixC([17, 21, 29], c.smoke ? [138, 122, 102] : [201, 205, 212], L);
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, css(fogCol, fogA * 0.55));
    g.addColorStop(clamp(horY / H, 0, 1), css(fogCol, fogA));
    g.addColorStop(1, css(fogCol, fogA * 0.8));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    // slowly drifting banks
    for (let i = 0; i < 3; i++) {
      const fx = ((t * (3 + i * 2) + h01(i + 90) * W * 2) % (W * 1.6)) - W * 0.3;
      ctx.fillStyle = css(fogCol, fogA * 0.22);
      ctx.beginPath();
      ctx.ellipse(fx, horY - H * 0.03 - i * H * 0.05, W * 0.3, H * 0.05, 0, 0, 7);
      ctx.fill();
    }
  } else if (c.haze || c.smoke) {
    const hzCol = c.smoke ? mixC([120, 104, 86], [40, 34, 28], 1 - L) : mixC([196, 172, 128], [60, 52, 40], 1 - L);
    const g = ctx.createLinearGradient(0, H * 0.15, 0, horY);
    g.addColorStop(0, css(hzCol, 0.06));
    g.addColorStop(1, css(hzCol, 0.3));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  /* ---- 10. vignette ---- */
  const vg = ctx.createRadialGradient(W / 2, H / 2, H * 0.5, W / 2, H / 2, W * 0.72);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(0,0,0,0.22)');
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, W, H);
}

/* ======================= scene canvas & main loop ======================== */

const sceneCanvas = $('scene');
const sceneCtx = sceneCanvas.getContext('2d');
let sceneW = 0, sceneH = 0, needResize = true;

function resizeScene() {
  const r = sceneCanvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  sceneCanvas.width = Math.max(1, round(r.width * dpr));
  sceneCanvas.height = Math.max(1, round(r.height * dpr));
  sceneCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  sceneW = r.width; sceneH = r.height;
  needResize = false;
}
new ResizeObserver(() => { needResize = true; }).observe(sceneCanvas);

// what the loop paints: {cond, seed, timeMs|null(=now)} — set by applyScene()
let active = null;
const sunCache = {};
function cachedSun(ms, lat, lon) {
  const key = `${lat.toFixed(2)}|${Math.floor(ms / 60000)}`;
  if (!sunCache[key]) {
    for (const k of Object.keys(sunCache)) delete sunCache[k]; // keep it tiny
    sunCache[key] = sunState(ms, lat, lon);
  }
  return sunCache[key];
}

function frame() {
  requestAnimationFrame(frame);
  if (document.hidden || !active) return;
  if (needResize) resizeScene();
  if (!sceneW) return;
  const ms = active.timeMs || Date.now();
  const sun = cachedSun(ms, active.lat, active.lon);
  drawScene(sceneCtx, sceneW, sceneH, active.cond, sun, performance.now() / 1000, active.seed);
}
requestAnimationFrame(frame);

/* ========================= decode dictionary ============================= */

const WX_DESC = { TS: 'thunderstorm', SH: 'showers of', FZ: 'freezing', DR: 'low drifting', BL: 'blowing', MI: 'shallow', BC: 'patches of', PR: 'partial' };
const WX_PHEN = {
  DZ: 'drizzle', RA: 'rain', SN: 'snow', SG: 'snow grains', IC: 'ice crystals', PL: 'ice pellets',
  GR: 'hail', GS: 'small hail / snow pellets', UP: 'unknown precipitation', BR: 'mist', FG: 'fog',
  FU: 'smoke', VA: 'volcanic ash', DU: 'widespread dust', SA: 'sand', HZ: 'haze', PO: 'dust/sand whirls',
  SQ: 'squalls', FC: 'funnel cloud', SS: 'sandstorm', DS: 'duststorm',
};
const AMT_WORD = { FEW: 'few (1–2 oktas)', SCT: 'scattered (3–4 oktas)', BKN: 'broken (5–7 oktas — this is a ceiling)', OVC: 'overcast (8 oktas — ceiling)' };

function decodeWx(tok) {
  let s = tok, parts = [];
  if (s.startsWith('+')) { parts.push('heavy'); s = s.slice(1); }
  else if (s.startsWith('-')) { parts.push('light'); s = s.slice(1); }
  if (s.startsWith('VC')) { parts.push('in the vicinity (5–10 SM away):'); s = s.slice(2); }
  while (s.length >= 2) {
    const code = s.slice(0, 2);
    if (WX_DESC[code]) parts.push(WX_DESC[code]);
    else if (WX_PHEN[code]) parts.push(WX_PHEN[code]);
    else return null;
    s = s.slice(2);
  }
  return parts.join(' ');
}

function decodeToken(tok, i, inRmk) {
  if (inRmk) {
    if (tok === 'RMK') return 'Remarks follow — additional detail, mostly for meteorologists.';
    if (/^AO2A?$/.test(tok)) return `Automated station <b>with</b> a precipitation sensor${tok.endsWith('A') ? ', plus a human augmenter' : ''}.`;
    if (tok === 'AO1') return 'Automated station without a precipitation discriminator.';
    if (/^SLP\d{3}$/.test(tok)) { const v = +tok.slice(3); const p = (v < 500 ? 1000 : 900) + v / 10; return `Sea-level pressure ${p.toFixed(1)} hPa.`; }
    if (/^T\d{8}$/.test(tok)) {
      const s1 = tok[1] === '1' ? -1 : 1, s2 = tok[5] === '1' ? -1 : 1;
      return `Precise temperature ${(s1 * +tok.slice(2, 5) / 10).toFixed(1)} °C, dewpoint ${(s2 * +tok.slice(6) / 10).toFixed(1)} °C.`;
    }
    if (/^P\d{4}$/.test(tok)) return `${(+tok.slice(1) / 100).toFixed(2)}" of precipitation in the past hour.`;
    if (/^PK$/.test(tok) || /^WND$/.test(tok)) return 'Peak wind group.';
    if (/^\d{5}\d?\/\d{4}$/.test(tok)) return 'Peak wind: direction+speed / time it occurred.';
    if (tok === '$') return 'The station itself needs maintenance.';
    if (/^LTG/.test(tok)) return 'Lightning observed (direction/type follows).';
    return 'Remark — supplemental coded data.';
  }
  if (i === 0 && /^[A-Z]{4}$/.test(tok)) return `Station identifier — the reporting airport (${esc(tok)}).`;
  if (i === 1 && tok === 'METAR') return 'Report type: routine observation.';
  if (tok === 'SPECI') return 'Special report — conditions changed significantly between routine obs.';
  if (/^\d{6}Z$/.test(tok)) return `Observation time: day ${+tok.slice(0, 2)} of the month at ${tok.slice(2, 4)}:${tok.slice(4, 6)} UTC (Z = Zulu).`;
  if (tok === 'AUTO') return 'Fully automated observation — no human observer.';
  if (tok === 'COR') return 'Corrected report.';
  if (/^(\d{3}|VRB)\d{2,3}(G\d{2,3})?KT$/.test(tok)) {
    const w = tok.match(/^(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?KT$/);
    const dir = w[1] === 'VRB' ? 'variable in direction' : `from ${+w[1]}° true`;
    return `Wind ${dir} at ${+w[2]} knots${w[3] ? `, <b>gusting ${+w[3]} kt</b>` : ''}. METAR winds are °true (only voice reports are magnetic).`;
  }
  if (/^\d{3}V\d{3}$/.test(tok)) return `Wind direction varying between ${+tok.slice(0, 3)}° and ${+tok.slice(4)}° true.`;
  if (/^M?\d{0,2}(\s?\d\/\d{1,2})?SM$/.test(tok) || /^\d{1,2}(\/\d{1,2})?SM$/.test(tok) || /^\d+ \d\/\dSM$/.test(tok)) {
    const less = tok.startsWith('M') ? 'less than ' : '';
    return `Visibility ${less}${esc(tok.replace(/^M/, '').replace('SM', ''))} statute miles.`;
  }
  if (/^R\d{2}[LRC]?\/.+$/.test(tok)) return 'Runway visual range (RVR) — measured visibility along that runway, in feet.';
  if (/^(FEW|SCT|BKN|OVC)\d{3}(CB|TCU)?$/.test(tok)) {
    const g = tok.match(/^(FEW|SCT|BKN|OVC)(\d{3})(CB|TCU)?$/);
    const extra = g[3] === 'CB' ? ' — cumulonimbus (thunderstorm cloud)!' : g[3] === 'TCU' ? ' — towering cumulus (building convection).' : '.';
    return `${AMT_WORD[g[1]]} clouds at ${(+g[2] * 100).toLocaleString()} ft AGL${extra}`;
  }
  if (/^VV\d{3}$/.test(tok)) return `Sky obscured — vertical visibility ${(+tok.slice(2) * 100).toLocaleString()} ft. This IS a ceiling.`;
  if (tok === 'CLR') return 'Sky clear below 12,000 ft (automated stations can\'t see higher).';
  if (tok === 'SKC') return 'Sky clear (human observer).';
  if (/^M?\d{2}\/M?\d{2}$/.test(tok)) {
    const [tt, dd] = tok.split('/').map((v) => +v.replace('M', '-'));
    const spread = tt - dd;
    return `Temperature ${tt} °C / dewpoint ${dd} °C (M = minus). Spread ${spread} °C${spread <= 3 ? ' — <b>small: fog or low cloud is likely</b>.' : '.'}`;
  }
  if (/^A\d{4}$/.test(tok)) return `Altimeter setting ${(+tok.slice(1) / 100).toFixed(2)} inHg — set this in the Kollsman window.`;
  const wx = decodeWx(tok);
  if (wx) return `Present weather: <b>${esc(wx)}</b>.`;
  return 'Not a group this decoder knows — see the AIM METAR key.';
}

/* ============================ UI rendering =============================== */

function stationOf(id) { return STATIONS.find((a) => a.id === id) || HOME; }

function renderTabs() {
  const wrap = $('station-tabs');
  wrap.innerHTML = '';
  for (const a of STATIONS) {
    const b = document.createElement('button');
    b.className = 'st-tab' + (a.id === state.sel ? ' sel' : '');
    b.textContent = a.id;
    b.title = a.name + (a.metarStation !== a.id ? ` (obs from ${a.metarStation})` : '');
    b.addEventListener('click', () => {
      state.sel = a.id;
      state.preview = null;
      renderTabs();
      applyScene();
    });
    wrap.appendChild(b);
  }
}

function skyPhrase(c) {
  if (c.fog) return 'fog';
  if (c.clouds.some((l) => l.amt === 'VV')) return 'sky obscured';
  if (!c.clouds.length) return 'clear skies';
  const low = [...c.clouds].sort((a, b) => a.baseFt - b.baseFt)[0];
  const word = { FEW: 'a few clouds', SCT: 'scattered clouds', BKN: 'a broken deck', OVC: 'an overcast deck' }[low.amt] || 'clouds';
  return `${word} at ${low.baseFt.toLocaleString()} ft`;
}

function wxPhrase(c) {
  const bits = [];
  if (c.ts) bits.push('thunderstorms');
  if (c.rain) bits.push(['', 'light rain', 'rain', 'heavy rain'][c.rain]);
  if (c.drzl) bits.push('drizzle');
  if (c.snow) bits.push(['', 'light snow', 'snow', 'heavy snow'][c.snow]);
  if (c.sleet) bits.push('ice pellets');
  if (c.fz) bits.push('(freezing!)');
  if (c.mist && !c.fog) bits.push('mist');
  if (c.haze) bits.push('haze');
  if (c.smoke) bits.push('smoke');
  if (c.funnel) bits.push('a FUNNEL CLOUD');
  return bits.join(', ');
}

function windPhrase(c) {
  if (!c.windKt) return 'calm wind';
  const dir = c.windVrb || c.windDir == null ? 'variable' : `${String(c.windDir).padStart(3, '0')}°`;
  return `wind ${dir} at ${c.windKt} kt${c.gustKt ? ` gusting ${c.gustKt}` : ''}`;
}

function fmtVisSM(v) {
  if (v == null) return '—';
  if (v >= 10) return '10+';
  if (Number.isInteger(v)) return String(v);
  const whole = Math.floor(v), fr = v - whole;
  const F = { 0.25: '¼', 0.5: '½', 0.75: '¾' };
  for (const k of Object.keys(F)) if (Math.abs(fr - k) < 0.03) return (whole ? whole : '') + F[k];
  return v.toFixed(1);
}

function renderInfo(c, meta) {
  // chips over the scene
  $('scene-chip').style.display = 'flex';
  $('chip-icao').textContent = meta.chipLabel;
  $('chip-cat').textContent = c.cat;
  $('chip-cat').style.background = CAT_COLORS[c.cat];
  $('chip-age').textContent = meta.ageText || '';
  const hasT = c.tempC != null;
  $('scene-temp').style.display = hasT ? 'block' : 'none';
  if (hasT) {
    $('temp-big').textContent = `${round(cToF(c.tempC))}°F`;
    $('temp-sub').textContent = `dew ${c.dewC != null ? round(cToF(c.dewC)) + '°' : '—'} · ${c.tempC}/${c.dewC ?? '—'} °C`;
  }

  // summary sentence
  const parts = [skyPhrase(c)];
  const wx = wxPhrase(c);
  if (wx) parts.push(wx);
  parts.push(`${fmtVisSM(c.visKnown ? c.visSM : null)} ${c.visKnown ? 'SM visibility' : 'visibility not reported'}`.trim());
  parts.push(windPhrase(c));
  const beaconDay = (c.cat === 'IFR' || c.cat === 'LIFR');
  $('summary').innerHTML =
    `${meta.summaryLead} ${esc(parts.filter(Boolean).join(' · '))} — ` +
    `<span class="cat-chip" style="background:${CAT_COLORS[c.cat]}">${c.cat}</span>` +
    (beaconDay ? ' <span class="beacon-note">the rotating beacon runs in daylight when a field goes below VFR minimums — that\'s what it means.</span>' : '');

  // raw decoder
  const rawEl = $('decode-raw');
  rawEl.innerHTML = '';
  $('tok-explain').textContent = 'Click any group above to see what it means.';
  if (c.raw) {
    // join mixed-number visibility ("1 1/2SM") into one chip
    const toks = [];
    for (const tk of c.raw.trim().split(/\s+/)) {
      if (/^\d\/\d{1,2}SM$/.test(tk) && toks.length && /^M?\d{1,2}$/.test(toks[toks.length - 1])) {
        toks[toks.length - 1] += ' ' + tk;
      } else toks.push(tk);
    }
    let inRmk = false;
    toks.forEach((tk, i) => {
      if (tk === 'RMK') inRmk = true;
      const sp = document.createElement('span');
      sp.className = 'tok' + (inRmk ? ' rmk' : '');
      sp.textContent = tk;
      const rmkNow = inRmk;
      sp.addEventListener('click', () => {
        document.querySelectorAll('.tok.sel').forEach((x) => x.classList.remove('sel'));
        sp.classList.add('sel');
        $('tok-explain').innerHTML = `<b>${esc(tk)}</b> — ${decodeToken(tk, i, rmkNow && tk !== 'RMK' ? true : tk === 'RMK')}`;
      });
      rawEl.appendChild(sp);
    });
  } else {
    rawEl.innerHTML = '<span class="faint">no raw METAR for this view (TAF preview)</span>';
  }

  // condition cards
  const apt = stationOf(state.sel);
  const cards = [];
  cards.push(['Wind', c.windKt ? `${c.windVrb || c.windDir == null ? 'VRB' : String(c.windDir).padStart(3, '0') + '°'} @ ${c.windKt}${c.gustKt ? '<span style="color:#f59e0b">G' + c.gustKt + '</span>' : ''} kt` : 'Calm',
    c.gustKt ? `gust factor ${c.gustKt - c.windKt} kt` : (c.windKt >= 15 ? 'windsock fully extended (rated 15 kt)' : 'directions °true')]);
  cards.push(['Visibility', `${fmtVisSM(c.visKnown ? c.visSM : null)}${c.visKnown ? ' SM' : ''}`,
    c.visSM < 1 ? 'below LIFR minimum' : c.visSM < 3 ? 'IFR visibility' : c.visSM <= 5 ? 'MVFR visibility' : 'good visibility']);
  const skyList = c.clouds.length
    ? c.clouds.map((l) => `${l.amt}${l.amt === 'VV' ? '' : ''} ${l.baseFt.toLocaleString()} ft${l.cb ? ' ' + l.cb : ''}`).join('<br>')
    : (c.clear ? 'clear' : 'no layers reported');
  cards.push(['Sky / ceiling', c.ceil != null ? `${c.ceil.toLocaleString()} ft` : 'no ceiling', skyList]);
  if (c.tempC != null) {
    const spread = c.dewC != null ? c.tempC - c.dewC : null;
    let rh = null;
    if (c.dewC != null) {
      const e = (x) => Math.exp(17.625 * x / (243.04 + x));
      rh = round(100 * e(c.dewC) / e(c.tempC));
    }
    cards.push(['Temp / dewpoint', `${round(cToF(c.tempC))}° / ${c.dewC != null ? round(cToF(c.dewC)) + '°' : '—'} F`,
      spread == null ? '' : `spread ${spread} °C · RH ${rh}%${spread <= 3 ? ' — fog risk' : ''}${c.tempC <= 0 ? ' · below freezing' : ''}`]);
  }
  if (c.altInHg != null) {
    let daTxt = '';
    if (c.tempC != null) {
      const pa = apt.elevFt + (29.92 - c.altInHg) * 1000;
      const isa = 15 - 1.98 * (apt.elevFt / 1000);
      const da = round((pa + 118.8 * (c.tempC - isa)) / 50) * 50;
      daTxt = `density altitude ≈ ${da.toLocaleString()} ft (${apt.id} elev ${apt.elevFt} ft)`;
    }
    cards.push(['Altimeter', `${c.altInHg.toFixed(2)}"`, daTxt]);
  }
  cards.push(['Category', `<span class="cat-chip" style="background:${CAT_COLORS[c.cat]};font-size:14px;padding:2px 10px">${c.cat}</span>`,
    { VFR: 'ceiling > 3,000 ft and vis > 5 SM', MVFR: 'ceiling 1,000–3,000 ft or vis 3–5 SM', IFR: 'ceiling 500–999 ft or vis 1–2 SM', LIFR: 'ceiling < 500 ft or vis < 1 SM' }[c.cat]]);
  $('cond-grid').innerHTML = cards.map(([h, big, small]) =>
    `<div class="card"><h3>${h}</h3><div class="big">${big}</div><div class="small">${small || ''}</div></div>`).join('');
}

/* --------- pick what the scene shows (live obs or a preview) ------------ */

function applyScene() {
  const apt = stationOf(state.sel);
  const err = $('scene-err');
  if (state.preview) {
    active = { cond: state.preview.cond, timeMs: state.preview.timeMs, lat: apt.lat, lon: apt.lon, seed: hashStr(state.preview.label) };
    err.style.display = 'none';
    $('preview-banner').style.display = 'flex';
    $('preview-label').textContent = state.preview.label;
    renderInfo(state.preview.cond, {
      chipLabel: state.preview.chip || 'preview',
      ageText: state.preview.timeMs ? fmtTime(state.preview.timeMs, { minute: undefined }) : '',
      summaryLead: `<b>${esc(state.preview.label)}:</b>`,
    });
    return;
  }
  $('preview-banner').style.display = 'none';
  const m = state.metars[apt.metarStation];
  if (!m || m.error) {
    // neutral clear scene behind the error note
    active = { cond: sceneCond({ clear: true }), timeMs: null, lat: apt.lat, lon: apt.lon, seed: hashStr(apt.id) };
    err.style.display = 'flex';
    err.textContent = `${apt.metarStation} observation unavailable${m && m.error ? ` — ${m.error}` : ''}`;
    $('scene-chip').style.display = 'none';
    $('scene-temp').style.display = 'none';
    $('summary').textContent = '';
    $('decode-raw').innerHTML = '';
    $('cond-grid').innerHTML = '';
    return;
  }
  err.style.display = 'none';
  const cond = sceneCond(m);
  active = { cond, timeMs: null, lat: apt.lat, lon: apt.lon, seed: hashStr(apt.id) };
  renderInfo(cond, {
    chipLabel: apt.id + (apt.metarStation !== apt.id ? ` · obs ${apt.metarStation}` : ''),
    ageText: `${ageMin(m.time)} min ago`,
    summaryLead: `<b>${esc(apt.name)}</b> right now:`,
  });
}

/* ============================== TAFs ===================================== */
// IWXXM XML from api.weather.gov — same decoding as weather.js.

const XLINK = 'http://www.w3.org/1999/xlink';
const tagNS = (el, name) => el.getElementsByTagNameNS('*', name);
const href = (el) => (el.getAttributeNS(XLINK, 'href') || el.getAttribute('xlink:href') || '');
const code = (el) => href(el).split('/').pop();

async function loadTaf(stationId) {
  const list = await fetchJSON(`${NWS}/stations/${stationId}/tafs`);
  const item = (list['@graph'] || [])[0];
  if (!item) return null;
  const res = await fetch(item.id);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const doc = new DOMParser().parseFromString(await res.text(), 'application/xml');
  const periods = [];
  for (const f of tagNS(doc, 'MeteorologicalAerodromeForecast')) {
    const p = { indicator: f.getAttribute('changeIndicator') || 'FM', wx: [], clouds: [] };
    const tp = tagNS(f, 'TimePeriod')[0];
    if (tp) {
      p.begin = new Date(tagNS(tp, 'beginPosition')[0].textContent);
      p.end = new Date(tagNS(tp, 'endPosition')[0].textContent);
    }
    const wd = tagNS(f, 'meanWindDirection')[0];
    const ws = tagNS(f, 'meanWindSpeed')[0];
    const wg = tagNS(f, 'windGustSpeed')[0];
    const swf = tagNS(f, 'AerodromeSurfaceWindForecast')[0];
    if (wd) p.windDir = round(+wd.textContent);
    if (ws) p.windKt = round(+ws.textContent);
    if (wg) p.gustKt = round(+wg.textContent);
    if (swf && swf.getAttribute('variableWindDirection') === 'true') p.windVrb = true;
    const pv = tagNS(f, 'prevailingVisibility')[0];
    if (pv) {
      p.visM = +pv.textContent;
      if (tagNS(f, 'prevailingVisibilityOperator')[0] && p.visM >= 9000) p.visPlus = true;
      if (p.visM >= 16000) p.visPlus = true;
    }
    for (const w of tagNS(f, 'weather')) { const cd = code(w); if (cd) p.wx.push(cd); }
    for (const cl of tagNS(f, 'CloudLayer')) {
      const amt = code(tagNS(cl, 'amount')[0] || cl);
      const base = tagNS(cl, 'base')[0];
      const cb = tagNS(cl, 'cloudType')[0];
      p.clouds.push({ amt, baseFt: base ? round(+base.textContent) : null, cb: cb && code(cb) === 'CB' ? 'CB' : '' });
    }
    periods.push(p);
  }
  return { issued: item.issueTime, periods };
}

// NWS TAF visibility is meters from a fixed SM table — decode via the table,
// never divide by 1609.
const VIS_M2SM = [[400, 0.25], [800, 0.5], [1200, 0.75], [1600, 1], [2400, 1.5],
  [3200, 2], [4800, 3], [6000, 4], [8000, 5], [9000, 6], [9999, 6]];
function tafVisSM(p) {
  if (p.visM == null) return null;
  if (p.visPlus) return 7;
  for (const [m, sm] of VIS_M2SM) if (Math.abs(p.visM - m) <= 100) return sm;
  return round(p.visM / 1609.34 * 2) / 2;
}

const IND_LABEL = { TEMPORARY_FLUCTUATIONS: 'TEMPO', BECOMING: 'BECMG', PROBABILITY_30: 'PROB30', PROBABILITY_40: 'PROB40' };

// Fold periods into tiles: FM/BECMG rows update the prevailing state;
// TEMPO/PROB tiles are the prevailing state with the fluctuation layered on.
function tafTiles(taf) {
  let base = {};
  const tiles = [];
  for (const p of taf.periods) {
    const ind = IND_LABEL[p.indicator] || (p.indicator === 'FM' ? '' : p.indicator);
    const isBase = ind === '' || ind === 'BECMG';
    const patch = {};
    if (p.windKt != null || p.windDir != null || p.windVrb) {
      patch.windDir = p.windDir; patch.windKt = p.windKt; patch.gustKt = p.gustKt || null; patch.windVrb = !!p.windVrb;
    }
    const v = tafVisSM(p);
    if (v != null) patch.visSM = v;
    const wxReal = p.wx.filter((w) => w !== 'NSW');
    if (p.wx.length) patch.wx = wxReal; // NSW alone → clears weather
    if (p.clouds.length) patch.clouds = p.clouds.filter((l) => l.baseFt != null || l.amt === 'VV');
    if (isBase) base = Object.assign({}, base, patch);
    const view = isBase ? base : Object.assign({}, base, patch);
    tiles.push({ ind, begin: p.begin, end: p.end, m: view });
  }
  return tiles;
}

function fmtTafShort(m) {
  const bits = [];
  if (m.windKt != null) bits.push(`${m.windVrb || m.windDir == null ? 'VRB' : String(m.windDir).padStart(3, '0') + '°'}@${m.windKt}${m.gustKt ? 'G' + m.gustKt : ''}`);
  if (m.visSM != null) bits.push(m.visSM >= 7 ? 'P6SM' : `${fmtVisSM(m.visSM)}SM`);
  if (m.wx && m.wx.length) bits.push(m.wx.join(' '));
  if (m.clouds && m.clouds.length) {
    bits.push(m.clouds.map((l) => ['SKC', 'NSC'].includes(l.amt) ? 'SKC'
      : `${l.amt}${l.baseFt != null ? String(round(l.baseFt / 100)).padStart(3, '0') : ''}${l.cb}`).join(' '));
  } else if (m.clouds && !m.clouds.length) bits.push('SKC');
  return bits.join(' · ');
}

function renderTafs() {
  const wrap = $('tafs');
  wrap.innerHTML = '';
  for (const st of TAF_STATIONS) {
    const t = state.tafs[st.id];
    const card = document.createElement('div');
    card.className = 'card taf-card';
    if (!t || t.error) {
      card.innerHTML = `<div class="taf-head"><span class="icao">${st.id}</span><span class="iss">${esc(st.label)}</span></div>
        <div class="apt-err">${t ? esc(t.error) : 'No TAF available.'}</div>`;
      wrap.appendChild(card);
      continue;
    }
    card.innerHTML = `<div class="taf-head"><span class="icao">${st.id}</span>
      <span class="iss">${esc(st.label)} · issued ${fmtTime(t.issued)}</span></div>`;
    const strip = document.createElement('div');
    strip.className = 'taf-strip';
    const apt = stationOf(state.sel);
    for (const tile of tafTiles(t)) {
      const cond = sceneCond(tile.m);
      const el = document.createElement('div');
      el.className = 'taf-tile';
      const cv = document.createElement('canvas');
      cv.width = 312; cv.height = 168;
      el.appendChild(cv);
      const midMs = tile.begin ? Math.min(+tile.begin + 1.5 * 3600000, (+tile.begin + +tile.end) / 2) : Date.now();
      const cctx = cv.getContext('2d');
      cctx.setTransform(2, 0, 0, 2, 0, 0);
      drawScene(cctx, 156, 84, cond, cachedSun(midMs, HOME.lat, HOME.lon), 60 + hashStr(st.id) % 50, hashStr(st.id + tile.ind + (tile.begin || '')));
      const when = tile.begin ? `${fmtTime(tile.begin, { minute: undefined })}–${fmtTime(tile.end, { minute: undefined })}` : '';
      const info = document.createElement('div');
      info.innerHTML = `<div class="when"><span class="catdot" style="background:${CAT_COLORS[cond.cat]}"></span>` +
        `${tile.ind ? `<span class="ind">${tile.ind}</span>` : ''}<span>${when}</span></div>` +
        `<div class="what">${esc(fmtTafShort(tile.m))}</div>`;
      el.appendChild(info);
      el.addEventListener('click', () => {
        document.querySelectorAll('.taf-tile.sel').forEach((x) => x.classList.remove('sel'));
        el.classList.add('sel');
        state.preview = {
          cond,
          timeMs: midMs,
          chip: `${st.id} TAF`,
          label: `${st.id} TAF ${tile.ind ? tile.ind + ' ' : ''}${when}`.trim(),
        };
        applyScene();
        $('scene-wrap').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
      strip.appendChild(el);
    }
    card.appendChild(strip);
    wrap.appendChild(card);
  }
}

/* ========================= custom METAR input ============================ */

const EXAMPLES = [
  ['severe clear', 'KANP 271753Z 00000KT 10SM CLR 22/10 A3021'],
  ['summer storm', 'KOSH 271853Z 24012G28KT 2SM +TSRA BR BKN008CB OVC020 24/22 A2965'],
  ['snowy night', 'KMSP 020354Z 33015G25KT 1/2SM +SN BLSN VV003 M08/M10 A2992'],
  ['LIFR fog', 'KSFO 120956Z 27004KT 1/4SM FG VV002 12/12 A3002'],
  ['windy MVFR', 'KBOS 151654Z 04022G35KT 4SM -RA BR BKN014 OVC025 07/05 A2951'],
];

function drawCustom() {
  const raw = $('custom-raw').value.trim().toUpperCase();
  const errEl = $('custom-err');
  errEl.textContent = '';
  if (!raw) return;
  const m = parseMetar(raw, new Date().toISOString());
  if (m.windKt == null && m.visSM == null && !m.clouds.length && !m.clear && m.tempC == null && !m.wx.length) {
    errEl.textContent = 'Couldn\'t find any METAR groups in that — check the format (e.g. "KANP 271753Z 31008KT 10SM SCT045 24/12 A3005").';
    return;
  }
  document.querySelectorAll('.taf-tile.sel').forEach((x) => x.classList.remove('sel'));
  const id = raw.split(/\s+/)[0];
  state.preview = {
    cond: sceneCond(m),
    timeMs: null,
    chip: /^[A-Z]{4}$/.test(id) ? `${id} (pasted)` : 'pasted METAR',
    label: `pasted METAR${/^[A-Z]{4}$/.test(id) ? ' · ' + id : ''}`,
  };
  applyScene();
  $('scene-wrap').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* ========================= data loading & init =========================== */

async function loadMetars() {
  const stations = [...new Set(STATIONS.map((a) => a.metarStation))];
  await Promise.all(stations.map(async (id) => {
    try {
      const d = await fetchJSON(`${NWS}/stations/${id}/observations/latest`);
      const p = d.properties;
      if (!p.rawMessage) throw new Error('empty observation');
      state.metars[id] = parseMetar(p.rawMessage, p.timestamp);
    } catch (e) {
      state.metars[id] = { error: e.message };
    }
  }));
}

async function loadTafs() {
  await Promise.all(TAF_STATIONS.map(async (st) => {
    try { state.tafs[st.id] = await loadTaf(st.id) || { error: 'No TAF published right now.' }; }
    catch (e) { state.tafs[st.id] = { error: `TAF unavailable (${e.message})` }; }
  }));
}

async function loadAll() {
  $('update-time').textContent = 'updating…';
  await Promise.all([loadMetars(), loadTafs()]);
  if (!state.preview) applyScene();
  renderTafs();
  $('update-time').textContent = `updated ${fmtTime(Date.now())}`;
}

document.addEventListener('DOMContentLoaded', () => {
  renderTabs();
  resizeScene();
  applyScene(); // neutral scene while loading
  loadAll();
  setInterval(loadAll, REFRESH_MS);
  setInterval(() => { // keep the obs age fresh
    if (state.preview) return;
    const m = state.metars[stationOf(state.sel).metarStation];
    if (m && !m.error) $('chip-age').textContent = `${ageMin(m.time)} min ago`;
  }, 30000);
  $('refresh-btn').addEventListener('click', loadAll);
  $('preview-off').addEventListener('click', () => {
    state.preview = null;
    document.querySelectorAll('.taf-tile.sel').forEach((x) => x.classList.remove('sel'));
    applyScene();
  });
  $('custom-btn').addEventListener('click', drawCustom);
  $('custom-raw').addEventListener('keydown', (e) => { if (e.key === 'Enter') drawCustom(); });
  const ex = $('examples');
  for (const [label, raw] of EXAMPLES) {
    const b = document.createElement('button');
    b.textContent = label;
    b.addEventListener('click', () => { $('custom-raw').value = raw; drawCustom(); });
    ex.appendChild(b);
  }
  window.__skyState = state; // debug/inspection hook
});
})();
