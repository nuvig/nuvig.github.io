/* ---------------------------------------------------------------------------
   METAR Sky II — jesselevine.net/sky2.html

   The successor to sky.html. Where v1 painted a fixed side-on picture, this
   one is a *place*: a pinhole camera standing on the field that you can pan
   through 360° and pitch up to the zenith. Everything is positioned by real
   azimuth and elevation, so the picture is internally consistent —

     · sun, moon, planets and ~85 naked-eye stars from Meeus low-precision
       series → true topocentric alt/az for the scene's clock and the
       airport's lat/lon (with constellation figures and the Milky Way band);
     · cloud decks rendered in true perspective by a Mode-7 style row loop:
       a deck at its reported base closes over your head and converges at the
       horizon, exactly the way a ceiling actually looks;
     · Koschmieder distance fog, so the reported visibility is the distance at
       which the ground, the treeline and the runway lights actually vanish;
     · the runway under your feet on its real true heading, with the windsock
       streaming the reported wind — pan to either end and the geometry holds.

   Data: api.weather.gov ONLY (METAR latest + history, IWXXM TAF XML) — never
   aviationweather.gov (no CORS) — plus Open-Meteo for temperature/pressure
   between observations. All directions °true.

   The painter is a pure function of (conditions, ephemeris, camera, t), so the
   same code draws the live scene, the TAF thumbnails and pasted METARs.
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
const EYE_FT = 5.6;              // eye height above the ramp
const HIST_MS = 12.5 * 3600000;  // how far back the timeline reaches

/* =============================== state =================================== */

const state = {
  metars: {},          // metar station id -> parsed metar or {error}
  tafs: {},            // taf station id -> {issued, periods} or {error}
  history: {},         // metar station id -> [{ms, m}] ascending, or {error}
  model: {},           // airport id -> Open-Meteo hourly {t,temp,dew,pmsl} or {error}
  modelBias: { tb: 0, db: 0, ab: 0 },  // obs-minus-model at "now", decayed outward
  densSeries: null,    // [{min, ms, da, rho, ratio, src, night}] across ±12 h
  ribbon: null,        // [{min, cat, src}] for the category strip
  sel: HOME.id,        // selected airport id
  preview: null,       // {cond, timeMs, label} — TAF period or pasted METAR
  offsetMin: 0,        // ±12 h timeline offset in minutes (0 = live)
  playing: false,
  labels: true,        // sky labels (stars/planets/compass names)
};

// The camera. hdg/pitch in degrees, fov = horizontal field of view.
const cam = { hdg: 108, pitch: 7, fov: 100 };

/* =============================== utils =================================== */

const $ = (id) => document.getElementById(id);
const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const rad = (d) => d * D2R;
const round = Math.round;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, f) => a + (b - a) * f;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const cToF = (c) => c * 9 / 5 + 32;
const norm360 = (d) => ((d % 360) + 360) % 360;
const norm180 = (d) => { const x = norm360(d); return x > 180 ? x - 360 : x; };
const smooth = (e0, e1, v) => { const t = clamp((v - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };

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

/* color helpers — arrays of 0..255, mixed linearly */
function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function mixC(c1, c2, f) {
  f = clamp(f, 0, 1);
  return [lerp(c1[0], c2[0], f), lerp(c1[1], c2[1], f), lerp(c1[2], c2[2], f)];
}
const css = (c, a) => a == null
  ? `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`
  : `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
const mix = (h1, h2, f) => mixC(rgb(h1), rgb(h2), f);

// The airport's UTC offset at a moment, in ms (handles DST by asking Intl).
function tzOffsetMs(ms) {
  const s = new Date(ms).toLocaleString('en-US', {
    timeZone: TZ, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const m = s.match(/(\d+)\/(\d+)\/(\d+),?\s+(\d+):(\d+):(\d+)/);
  if (!m) return 0;
  const asUTC = Date.UTC(+m[3], +m[1] - 1, +m[2], (+m[4]) % 24, +m[5], +m[6]);
  return asUTC - Math.floor(ms / 1000) * 1000;
}
// Start of the calendar day AT THE AIRPORT'S TZ, as a UTC instant. Anchoring
// on the browser's timezone instead would put dawn/dusk a day off for viewers
// west of the field (the bug weather.js documents).
function localDayStart(ms) {
  const off = tzOffsetMs(ms);
  return Math.floor((ms + off) / 86400000) * 86400000 - off;
}

/* =========================== astronomy =================================== */
/* Meeus low-precision series throughout: good to ~0.01° for the sun, ~0.3°
   for the moon, a few arcminutes for the planets — far finer than a 1,100 px
   canvas can show. Positions are geocentric apparent; topocentric parallax
   matters only for the moon (~1°) and is ignored on purpose. */

const J2000 = 2451545.0;
const jdOf = (ms) => ms / 86400000 + 2440587.5;

function obliquity(d) { return (23.439 - 0.0000004 * d) * D2R; }

function sunEq(jd) {
  const d = jd - J2000;
  const L = norm360(280.460 + 0.9856474 * d);
  const g = norm360(357.528 + 0.9856003 * d) * D2R;
  const lam = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * D2R;
  const eps = obliquity(d);
  return {
    ra: norm360(Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam)) * R2D),
    dec: Math.asin(Math.sin(eps) * Math.sin(lam)) * R2D,
    lam: norm360(lam * R2D),
  };
}

function moonEq(jd) {
  const d = jd - J2000;
  const L = norm360(218.316 + 13.176396 * d);
  const M = norm360(134.963 + 13.064993 * d) * D2R;
  const F = norm360(93.272 + 13.229350 * d) * D2R;
  const lam = (L + 6.289 * Math.sin(M)) * D2R;
  const bet = (5.128 * Math.sin(F)) * D2R;
  const eps = obliquity(d);
  const sl = Math.sin(lam), cl = Math.cos(lam), sb = Math.sin(bet), cb = Math.cos(bet);
  return {
    ra: norm360(Math.atan2(sl * Math.cos(eps) - (sb / cb) * Math.sin(eps), cl) * R2D),
    dec: Math.asin(sb * Math.cos(eps) + cb * Math.sin(eps) * sl) * R2D,
    lam: norm360(lam * R2D),
    distKm: 385001 - 20905 * Math.cos(M),
  };
}

// Equatorial → local horizon. az measured from true north through east.
function toHorizon(raDeg, decDeg, jd, lat, lon) {
  const gmst = norm360(280.46061837 + 360.98564736629 * (jd - J2000));
  const H = norm180(gmst + lon - raDeg) * D2R;
  const dec = decDeg * D2R, la = lat * D2R;
  const sinAlt = Math.sin(dec) * Math.sin(la) + Math.cos(dec) * Math.cos(la) * Math.cos(H);
  const alt = Math.asin(clamp(sinAlt, -1, 1));
  const cosA = (Math.sin(dec) - Math.sin(alt) * Math.sin(la)) / (Math.cos(alt) * Math.cos(la) || 1e-9);
  let A = Math.acos(clamp(cosA, -1, 1));
  if (Math.sin(H) > 0) A = 2 * Math.PI - A;
  let altD = alt * R2D;
  // atmospheric refraction — lifts the disc ~0.57° at the horizon
  if (altD > -1.5) altD += 0.017 / Math.tan((altD + 10.3 / (altD + 5.11)) * D2R);
  return { alt: altD, az: norm360(A * R2D), H: H * R2D, ra: raDeg, dec: decDeg };
}

/* ---- planets: JPL approximate elements, valid 1800–2050 ----------------- */
// a, e, I, L, longPeri, longNode  and their per-century rates.
const PLANETS = [
  ['Mercury', 0.38709927, 0.20563593, 7.00497902, 252.25032350, 77.45779628, 48.33076593,
    0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081, -0.6],
  ['Venus', 0.72333566, 0.00677672, 3.39467605, 181.97909950, 131.60246718, 76.67984255,
    0.00000390, -0.00004107, -0.00078890, 58517.81538729, 0.00268329, -0.27769418, -4.4],
  ['Earth', 1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0.0,
    0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0.0, 0],
  ['Mars', 1.52371034, 0.09339410, 1.84969142, -4.55343205, -23.94362959, 49.55953891,
    0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343, -1.5],
  ['Jupiter', 5.20288700, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909,
    -0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106, -9.4],
  ['Saturn', 9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448,
    -0.00125060, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794, -8.9],
];

// Heliocentric ecliptic rectangular coordinates (au) of one planet.
function helioXYZ(p, T) {
  const a = p[1] + p[7] * T, e = p[2] + p[8] * T;
  const I = (p[3] + p[9] * T) * D2R;
  const L = norm360(p[4] + p[10] * T);
  const wbar = p[5] + p[11] * T, node = (p[6] + p[12] * T) * D2R;
  const w = (wbar - (p[6] + p[12] * T)) * D2R;
  let M = norm180(L - wbar) * D2R;
  let E = M + e * Math.sin(M);
  for (let i = 0; i < 6; i++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  const xp = a * (Math.cos(E) - e);
  const yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const cw = Math.cos(w), sw = Math.sin(w), cn = Math.cos(node), sn = Math.sin(node);
  const ci = Math.cos(I), si = Math.sin(I);
  return [
    (cw * cn - sw * sn * ci) * xp + (-sw * cn - cw * sn * ci) * yp,
    (cw * sn + sw * cn * ci) * xp + (-sw * sn + cw * cn * ci) * yp,
    (sw * si) * xp + (cw * si) * yp,
  ];
}

function planetPositions(jd, lat, lon) {
  const T = (jd - J2000) / 36525;
  const earth = helioXYZ(PLANETS[2], T);
  const eps = obliquity(jd - J2000);
  const out = [];
  for (const p of PLANETS) {
    if (p[0] === 'Earth') continue;
    const h = helioXYZ(p, T);
    const x = h[0] - earth[0], y = h[1] - earth[1], z = h[2] - earth[2];
    const lam = Math.atan2(y, x), bet = Math.atan2(z, Math.hypot(x, y));
    const sl = Math.sin(lam), cl = Math.cos(lam), tb = Math.tan(bet);
    const ra = norm360(Math.atan2(sl * Math.cos(eps) - tb * Math.sin(eps), cl) * R2D);
    const dec = Math.asin(Math.sin(bet) * Math.cos(eps) +
      Math.cos(bet) * Math.sin(eps) * sl) * R2D;
    const hz = toHorizon(ra, dec, jd, lat, lon);
    const dist = Math.hypot(x, y, z);
    const rSun = Math.hypot(h[0], h[1], h[2]);
    hz.name = p[0];
    hz.mag = p[13] + 5 * Math.log10(Math.max(0.05, dist * rSun));
    out.push(hz);
  }
  return out;
}

/* ---- bright stars (J2000: name, RA hours, Dec °, visual magnitude) ------ */
// Precession since J2000 is under 0.4° — invisible at this scale, so the
// catalogue is used as-is.
const STAR_DATA = [
  ['Sirius', 6.7525, -16.716, -1.46], ['Arcturus', 14.2610, 19.182, -0.05],
  ['Vega', 18.6156, 38.784, 0.03], ['Capella', 5.2782, 45.998, 0.08],
  ['Rigel', 5.2423, -8.202, 0.13], ['Procyon', 7.6551, 5.225, 0.34],
  ['Betelgeuse', 5.9195, 7.407, 0.50], ['Altair', 19.8464, 8.868, 0.77],
  ['Aldebaran', 4.5987, 16.509, 0.85], ['Spica', 13.4199, -11.161, 1.04],
  ['Antares', 16.4901, -26.432, 1.09], ['Pollux', 7.7553, 28.026, 1.14],
  ['Fomalhaut', 22.9608, -29.622, 1.16], ['Deneb', 20.6905, 45.280, 1.25],
  ['Regulus', 10.1395, 11.967, 1.35], ['Adhara', 6.9771, -28.972, 1.50],
  ['Castor', 7.5766, 31.888, 1.58], ['Shaula', 17.5601, -37.104, 1.62],
  ['Bellatrix', 5.4185, 6.350, 1.64], ['Elnath', 5.4382, 28.608, 1.65],
  ['Alnilam', 5.6036, -1.202, 1.69], ['Alioth', 12.9005, 55.960, 1.77],
  ['Alnitak', 5.6793, -1.943, 1.77], ['Dubhe', 11.0621, 61.751, 1.79],
  ['Mirfak', 3.4054, 49.861, 1.79], ['Wezen', 7.1399, -26.393, 1.83],
  ['Kaus Australis', 18.4029, -34.385, 1.85], ['Alkaid', 13.7923, 49.313, 1.86],
  ['Sargas', 17.6220, -42.998, 1.87], ['Menkalinan', 5.9921, 44.947, 1.90],
  ['Alhena', 6.6285, 16.399, 1.93], ['Mirzam', 6.3783, -17.956, 1.98],
  ['Alphard', 9.4598, -8.659, 1.98], ['Polaris', 2.5303, 89.264, 1.98],
  ['Hamal', 2.1195, 23.463, 2.00], ['Diphda', 0.7265, -17.987, 2.04],
  ['Nunki', 18.9211, -26.297, 2.05], ['Alpheratz', 0.1398, 29.090, 2.06],
  ['Mirach', 1.1622, 35.621, 2.06], ['Rasalhague', 17.5822, 12.560, 2.08],
  ['Kochab', 14.8451, 74.155, 2.08], ['Algieba', 10.3329, 19.841, 2.08],
  ['Saiph', 5.7959, -9.670, 2.09], ['Almach', 2.0650, 42.330, 2.10],
  ['Algol', 3.1361, 40.956, 2.12], ['Denebola', 11.8177, 14.572, 2.14],
  ['Alphecca', 15.5781, 26.715, 2.22], ['Mizar', 13.3987, 54.925, 2.23],
  ['Sadr', 20.3704, 40.257, 2.23], ['Mintaka', 5.5334, -0.299, 2.23],
  ['Eltanin', 17.9434, 51.489, 2.24], ['Schedar', 0.6751, 56.537, 2.24],
  ['Caph', 0.1529, 59.150, 2.28], ['Dschubba', 16.0056, -22.622, 2.29],
  ['Epsilon Sco', 16.8360, -34.293, 2.29], ['Izar', 14.7498, 27.074, 2.37],
  ['Merak', 11.0307, 56.383, 2.37], ['Enif', 21.7364, 9.875, 2.39],
  ['Scheat', 23.0629, 28.083, 2.42], ['Phecda', 11.8972, 53.695, 2.44],
  ['Aludra', 7.4016, -29.303, 2.45], ['Gamma Cas', 0.9451, 60.717, 2.47],
  ['Gienah Cyg', 20.7702, 33.970, 2.48], ['Markab', 23.0793, 15.205, 2.49],
  ['Menkar', 3.0380, 4.090, 2.53], ['Zosma', 11.2351, 20.524, 2.56],
  ['Graffias', 16.0906, -19.806, 2.62], ['Ruchbah', 1.4303, 60.235, 2.68],
  ['Upsilon Sco', 17.5127, -37.296, 2.69], ['Tarazed', 19.7710, 10.613, 2.72],
  ['Delta Cyg', 19.7496, 45.131, 2.87], ['Alcyone', 3.7914, 24.105, 2.87],
  ['Mu Gem', 6.3827, 22.514, 2.87], ['Cor Caroli', 12.9338, 38.318, 2.89],
  ['Pi Sco', 15.9808, -26.114, 2.89], ['Algenib', 0.2206, 15.184, 2.83],
  ['Mebsuta', 6.7322, 25.131, 2.98], ['Epsilon Leo', 9.7642, 23.774, 2.98],
  ['Seginus', 14.5346, 38.308, 3.03], ['Pherkad', 15.3455, 71.834, 3.05],
  ['Albireo', 19.5121, 27.960, 3.08], ['Sulafat', 18.9824, 32.690, 3.25],
  ['Megrez', 12.2571, 57.033, 3.31], ['Theta Leo', 11.2373, 15.430, 3.33],
  ['Zeta Leo', 10.2782, 23.417, 3.44], ['Delta Boo', 15.2584, 33.315, 3.47],
  ['Nekkar', 15.0324, 40.391, 3.49], ['Eta Leo', 10.1222, 16.763, 3.51],
  ['Sheliak', 18.8347, 33.363, 3.52], ['Wasat', 7.3354, 21.982, 3.53],
  ['Segin', 1.9066, 63.670, 3.38], ['Alshain', 19.9219, 6.407, 3.71],
];
const STAR_IX = {};
STAR_DATA.forEach((s, i) => { STAR_IX[s[0]] = i; });

// Constellation stick figures — chains of star names, drawn as polylines.
const FIGURES = [
  ['Orion', ['Betelgeuse', 'Bellatrix'], ['Bellatrix', 'Mintaka'], ['Mintaka', 'Alnilam', 'Alnitak'],
    ['Alnitak', 'Saiph'], ['Saiph', 'Rigel'], ['Rigel', 'Mintaka'], ['Betelgeuse', 'Alnitak']],
  ['Ursa Major', ['Alkaid', 'Mizar', 'Alioth', 'Megrez', 'Phecda', 'Merak', 'Dubhe', 'Megrez']],
  ['Cassiopeia', ['Caph', 'Schedar', 'Gamma Cas', 'Ruchbah', 'Segin']],
  ['Cygnus', ['Deneb', 'Sadr', 'Albireo'], ['Gienah Cyg', 'Sadr', 'Delta Cyg']],
  ['Lyra', ['Vega', 'Sheliak', 'Sulafat', 'Vega']],
  ['Aquila', ['Tarazed', 'Altair', 'Alshain']],
  ['Leo', ['Regulus', 'Eta Leo', 'Algieba', 'Zeta Leo', 'Epsilon Leo'],
    ['Regulus', 'Theta Leo', 'Denebola'], ['Theta Leo', 'Zosma', 'Denebola'], ['Algieba', 'Zosma']],
  ['Gemini', ['Castor', 'Mebsuta', 'Mu Gem'], ['Pollux', 'Wasat', 'Alhena'], ['Castor', 'Pollux']],
  ['Taurus', ['Elnath', 'Aldebaran', 'Alcyone']],
  ['Canis Major', ['Mirzam', 'Sirius', 'Wezen', 'Aludra'], ['Wezen', 'Adhara']],
  ['Scorpius', ['Graffias', 'Dschubba', 'Pi Sco'], ['Dschubba', 'Antares'],
    ['Antares', 'Epsilon Sco', 'Sargas', 'Shaula', 'Upsilon Sco']],
  ['Bootes', ['Arcturus', 'Izar', 'Delta Boo', 'Nekkar', 'Seginus', 'Arcturus']],
  ['Pegasus', ['Markab', 'Scheat', 'Alpheratz', 'Algenib', 'Markab'], ['Markab', 'Enif']],
  ['Auriga', ['Capella', 'Menkalinan', 'Elnath', 'Capella']],
  ['Ursa Minor', ['Kochab', 'Pherkad']],
  ['Perseus', ['Mirfak', 'Algol']],
];

// Galactic equator sampled into equatorial coordinates, once.
const MILKY_WAY = (() => {
  const gpRa = 192.85948 * D2R, gpDec = 27.12825 * D2R;      // north galactic pole
  const gcRa = 266.40510 * D2R, gcDec = -28.936175 * D2R;    // galactic centre
  const unit = (ra, dec) => [Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)];
  const z = unit(gpRa, gpDec), x = unit(gcRa, gcDec);
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  const pts = [];
  for (let l = 0; l < 360; l += 3) {
    const c = Math.cos(l * D2R), s = Math.sin(l * D2R);
    const v = [c * x[0] + s * y[0], c * x[1] + s * y[1], c * x[2] + s * y[2]];
    pts.push([norm360(Math.atan2(v[1], v[0]) * R2D), Math.asin(clamp(v[2], -1, 1)) * R2D,
      // rough brightness: brightest toward the galactic centre and Cygnus
      0.35 + 0.65 * Math.pow(Math.max(Math.cos(l * D2R), Math.cos((l - 80) * D2R) * 0.8, 0), 2)]);
  }
  return pts;
})();

/* ---- the ephemeris bundle the painter consumes ------------------------- */

const ephemCache = { key: '', val: null };
function ephemerisAt(ms, lat, lon) {
  const key = `${Math.floor(ms / 60000)}|${lat.toFixed(2)}`;
  if (ephemCache.key === key) return ephemCache.val;
  const jd = jdOf(ms);
  const se = sunEq(jd), me = moonEq(jd);
  const sun = toHorizon(se.ra, se.dec, jd, lat, lon);
  const moon = toHorizon(me.ra, me.dec, jd, lat, lon);
  // illuminated fraction and the position angle of the bright limb
  const elong = norm360(me.lam - se.lam);
  moon.illum = (1 - Math.cos(elong * D2R)) / 2;
  moon.waxing = elong < 180;
  const dRa = (se.ra - me.ra) * D2R, sd = se.dec * D2R, md = me.dec * D2R;
  const chi = Math.atan2(Math.cos(sd) * Math.sin(dRa),
    Math.sin(sd) * Math.cos(md) - Math.cos(sd) * Math.sin(md) * Math.cos(dRa));
  const q = Math.atan2(Math.sin(moon.H * D2R),
    Math.tan(lat * D2R) * Math.cos(md) - Math.sin(md) * Math.cos(moon.H * D2R));
  moon.limbAngle = chi - q;   // 0 = bright limb points to screen-up (zenith)
  const val = { jd, ms, lat, lon, sun, moon, planets: planetPositions(jd, lat, lon) };
  ephemCache.key = key; ephemCache.val = val;
  return val;
}

// Sun crossings of a given altitude across the local day (rise/set/twilight).
const solarCache = {};
function solarDay(ms, lat, lon) {
  const start = localDayStart(ms);
  const key = `${start}|${lat.toFixed(2)}`;
  if (solarCache[key]) return solarCache[key];
  const altAt = (t) => {
    const jd = jdOf(t), e = sunEq(jd);
    return toHorizon(e.ra, e.dec, jd, lat, lon).alt;
  };
  const cross = (target) => {
    let prev = altAt(start), out = { up: null, down: null };
    for (let m = 4; m <= 24 * 60; m += 4) {
      const t = start + m * 60000, a = altAt(t);
      if (prev < target && a >= target) out.up = refine(t - 240000, t, target);
      if (prev > target && a <= target) out.down = refine(t - 240000, t, target);
      prev = a;
    }
    return out;
  };
  const refine = (t0, t1, target) => {
    for (let i = 0; i < 20; i++) {
      const tm = (t0 + t1) / 2;
      if ((altAt(t0) - target) * (altAt(tm) - target) <= 0) t1 = tm; else t0 = tm;
    }
    return (t0 + t1) / 2;
  };
  const day = cross(-0.833), civil = cross(-6), naut = cross(-12);
  const val = {
    sunrise: day.up, sunset: day.down,
    dawn: civil.up, dusk: civil.down,
    nautDawn: naut.up, nautDusk: naut.down,
  };
  solarCache[key] = val;
  if (Object.keys(solarCache).length > 8) delete solarCache[Object.keys(solarCache)[0]];
  return val;
}

/* ============================ METAR parsing ============================== */
// Same grammar as weather.js / sky.js parseMetar.

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
  const vr = body.match(/\b(\d{3})V(\d{3})\b/);
  if (vr) m.windVarRange = [+vr[1], +vr[2]];
  const vv = body.match(/\bVV(\d{3})\b/);
  const vis = body.match(/\b(?:(\d{1,2}) )?(?:M)?(?:(\d)\/(\d{1,2}))SM\b/) || body.match(/\b(\d{1,2})SM\b/);
  if (vis) m.visSM = vis[2] ? (+(vis[1] || 0) + (+vis[2] / +vis[3])) : +vis[1];
  for (const c of body.matchAll(/\b(FEW|SCT|BKN|OVC)(\d{3})(CB|TCU)?\b/g)) {
    m.clouds.push({ amt: c[1], baseFt: +c[2] * 100, cb: c[3] || '' });
  }
  if (vv) m.clouds.push({ amt: 'VV', baseFt: +vv[1] * 100, cb: '' });
  if (/\b(CLR|SKC|NCD|NSC)\b/.test(body)) m.clear = true;
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

const COVER = { FEW: 0.18, SCT: 0.45, BKN: 0.78, OVC: 1, VV: 1 };

function sceneCond(m) {
  const c = {
    windKt: m.windKt == null ? 0 : m.windKt,
    gustKt: m.gustKt || null,
    windDir: m.windDir == null ? null : m.windDir,
    windVrb: !!m.windVrb,
    windVarRange: m.windVarRange || null,
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

/* ========================= camera & projection =========================== */
/* A pinhole camera at eye height on the ramp. Screen space is CSS pixels.
   With a level roll the horizon is a straight line at a constant y — that
   falls out of the algebra below and the whole Mode-7 row loop depends on it. */

function makeCam(c, W, H) {
  const A = rad(c.hdg), P = rad(c.pitch);
  const focal = (W / 2) / Math.tan(rad(c.fov) / 2);
  const sA = Math.sin(A), cA = Math.cos(A), sP = Math.sin(P), cP = Math.cos(P);
  return {
    W, H, focal, A, P, sA, cA, sP, cP,
    hdg: c.hdg, pitch: c.pitch, fov: c.fov,
    f: [sA * cP, cA * cP, sP],       // forward
    r: [cA, -sA, 0],                 // right (always horizontal)
    u: [-sA * sP, -cA * sP, cP],     // up
    horY: H / 2 + focal * Math.tan(P),
  };
}

// Project a direction (need not be unit). Returns null when behind the lens.
function proj(K, dx, dy, dz) {
  const zc = dx * K.f[0] + dy * K.f[1] + dz * K.f[2];
  if (zc <= 1e-4) return null;
  const xc = dx * K.r[0] + dy * K.r[1];
  const yc = dx * K.u[0] + dy * K.u[1] + dz * K.u[2];
  return { x: K.W / 2 + K.focal * xc / zc, y: K.H / 2 - K.focal * yc / zc, z: zc };
}
function projAltAz(K, altDeg, azDeg) {
  const a = rad(altDeg), z = rad(azDeg), ca = Math.cos(a);
  return proj(K, Math.sin(z) * ca, Math.cos(z) * ca, Math.sin(a));
}
// World point in feet: E east, N north, U up from the ramp.
function projWorld(K, E, N, U) { return proj(K, E, N, U - EYE_FT); }

// Screen x of an azimuth on the horizon, extended past the frame edges so
// off-screen glows still bloom from the right side. null = behind you.
function azScreenX(K, azDeg) {
  const d = norm180(azDeg - K.hdg);
  if (Math.abs(d) > 88) return null;
  return K.W / 2 + K.focal * Math.tan(rad(d));
}

/* ====================== procedural tiling textures ======================= */
/* Tileable fBm value noise. The cloud/ground textures are built in
   VIEW-ALIGNED coordinates (lateral × along-view), which is what lets each
   screen row be a single drawImage of a horizontal texture strip. Panning
   regenerates them; wind drift is a scroll offset, so the common case costs
   nothing. Each texture canvas is the tile repeated 3× horizontally so a wide
   source rectangle never has to wrap. */

const TEX_N = 192;
// Repeats laid side by side so a wide row never has to wrap. More tiles push
// the distance at which a deck has to collapse into a flat sheet much further
// out — with only three, an overcast goes featureless well above the horizon.
const TEX_TILES = 6;

function fbmTile(N, seed, octaves, baseCells) {
  const out = new Float32Array(N * N);
  let amp = 1, tot = 0;
  for (let o = 0; o < octaves; o++) {
    const cells = baseCells << o;
    const g = new Float32Array(cells * cells);
    for (let i = 0; i < g.length; i++) g[i] = h01(seed * 7919 + o * 104729 + i * 31);
    const sc = cells / N;
    for (let y = 0; y < N; y++) {
      const fy = y * sc, y0 = Math.floor(fy), ty = fy - y0;
      const sy = ty * ty * (3 - 2 * ty);
      const y0i = y0 % cells, y1i = (y0i + 1) % cells;
      for (let x = 0; x < N; x++) {
        const fx = x * sc, x0 = Math.floor(fx), tx = fx - x0;
        const sx = tx * tx * (3 - 2 * tx);
        const x0i = x0 % cells, x1i = (x0i + 1) % cells;
        const a = g[y0i * cells + x0i], b = g[y0i * cells + x1i];
        const cc = g[y1i * cells + x0i], d = g[y1i * cells + x1i];
        out[y * N + x] += amp * (a + (b - a) * sx + (cc - a) * sy + (a - b - cc + d) * sx * sy);
      }
    }
    tot += amp; amp *= 0.5;
  }
  for (let i = 0; i < out.length; i++) out[i] /= tot;
  return out;
}

// Threshold that leaves `cov` of the field above it (histogram, 128 bins).
function coverThreshold(field, cov) {
  if (cov >= 0.999) return -1;
  if (cov <= 0.001) return 2;
  const bins = new Int32Array(129);
  for (let i = 0; i < field.length; i++) bins[clamp(field[i] * 128 | 0, 0, 128)]++;
  const want = field.length * (1 - cov);
  let acc = 0;
  for (let b = 0; b <= 128; b++) {
    acc += bins[b];
    if (acc >= want) return b / 128;
  }
  return 1;
}

// Wrap an NxN RGBA buffer into a strip of TEX_TILES copies.
function tileCanvas(N, data) {
  const cv = document.createElement('canvas');
  cv.width = N * TEX_TILES; cv.height = N;
  const ctx = cv.getContext('2d');
  const one = document.createElement('canvas');
  one.width = N; one.height = N;
  one.getContext('2d').putImageData(new ImageData(data, N, N), 0, 0);
  for (let i = 0; i < TEX_TILES; i++) ctx.drawImage(one, i * N, 0);
  cv.tileN = N;
  return cv;
}

const texCache = new Map();
function cachedTex(key, build) {
  let v = texCache.get(key);
  if (v) { texCache.delete(key); texCache.set(key, v); return v; }
  v = build();
  texCache.set(key, v);
  if (texCache.size > 48) texCache.delete(texCache.keys().next().value);
  return v;
}

/* ---- cloud deck texture: the UNDERSIDE of a layer ----------------------- */
// lit  = colour of a sunlit edge, dark = colour of the thick middle.
function cloudTex(amt, seed, lit, dark, sharp) {
  const N = TEX_N;
  const f = fbmTile(N, seed, 4, amt === 'OVC' || amt === 'BKN' ? 3 : 4);
  const cov = COVER[amt] || 0.4;
  const thr = coverThreshold(f, cov);
  const soft = sharp ? 0.06 : (amt === 'OVC' || amt === 'BKN' || amt === 'VV' ? 0.28 : 0.13);
  const data = new Uint8ClampedArray(N * N * 4);
  // Shading has to come from the noise field itself, not from how far above
  // the coverage threshold a pixel is: for an overcast the threshold sits
  // below every sample, so the latter saturates and the deck goes dead flat.
  let lo = 1, hi = 0;
  for (let i = 0; i < f.length; i++) { if (f[i] < lo) lo = f[i]; if (f[i] > hi) hi = f[i]; }
  const span = Math.max(1e-3, hi - lo);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x, v = f[i];
      const a = smooth(thr, thr + soft, v);
      const depth = (v - lo) / span;                       // 0 thin … 1 thick
      const gx = f[y * N + ((x + 1) % N)] - f[y * N + ((x + N - 1) % N)];
      const gy = f[((y + 1) % N) * N + x] - f[((y + N - 1) % N) * N + x];
      const rim = clamp(0.5 - (gx + gy * 0.5) * 4, 0, 1);  // lit edge vs shaded
      const col = mixC(lit, dark, clamp(depth * 0.62 + (1 - rim) * 0.2, 0, 1));
      const o = i * 4;
      data[o] = col[0]; data[o + 1] = col[1]; data[o + 2] = col[2];
      data[o + 3] = a * 255;
    }
  }
  return tileCanvas(N, data);
}

/* ---- ground texture ---------------------------------------------------- */
function groundTex(seed, base, alt2, snowy) {
  const N = TEX_N;
  const f = fbmTile(N, seed, 4, snowy ? 3 : 5);
  const data = new Uint8ClampedArray(N * N * 4);
  for (let i = 0; i < N * N; i++) {
    const v = f[i];
    const col = mixC(base, alt2, clamp((v - 0.32) * 2.1, 0, 1));
    const o = i * 4;
    data[o] = col[0]; data[o + 1] = col[1]; data[o + 2] = col[2]; data[o + 3] = 255;
  }
  return tileCanvas(N, data);
}

/* ======================== lighting & sky colour ========================== */

// Everything the painter needs to know about how bright the world is.
function lightModel(cond, ephem) {
  const sa = ephem.sun.alt;
  const dl = smooth(-8, 4, sa);                       // twilight ramp 0..1
  const gloom = clamp(cond.gloomCover * 0.62 + cond.precipInt * 0.09 +
    (cond.fog ? 0.25 : 0) + (cond.smoke ? 0.15 : 0), 0, 0.88);
  const L = clamp((0.06 + 0.94 * dl) * (1 - 0.5 * gloom), 0.035, 1);
  // how much of the sun's disc actually reaches the ground
  const blocked = clamp(cond.cover * 0.55 + cond.gloomCover * 0.35 +
    (cond.fog ? 0.85 : 0) + (1 - clamp(cond.visSM / 8, 0, 1)) * 0.5, 0, 1);
  return { sa, dl, gloom, L, blocked, night: sa < -0.833 };
}

// Zenith / mid / horizon colours as a function of solar altitude (degrees).
const SKY_STOPS = [
  [-18, ['#060a14', '#080d1c', '#0c1526']],   // never pure black — airglow
  [-10, ['#070c1c', '#0c142e', '#18203c']],
  [-5, ['#0a1330', '#1b2450', '#4a3358']],
  [-1, ['#122048', '#3d3670', '#d9743f']],
  [3, ['#1d3f80', '#5a7ab4', '#f0a765']],
  [10, ['#2a63b4', '#6a97d4', '#c9dcef']],
  [30, ['#2f6ec8', '#66a0dd', '#c4e0f4']],
  [70, ['#2160c4', '#5e9ade', '#cfe6f7']],
];
function skyColors(sa) {
  let i = 0;
  while (i < SKY_STOPS.length - 2 && sa > SKY_STOPS[i + 1][0]) i++;
  const [a0, c0] = SKY_STOPS[i], [a1, c1] = SKY_STOPS[i + 1];
  const f = clamp((sa - a0) / (a1 - a0), 0, 1);
  return [mix(c0[0], c1[0], f), mix(c0[1], c1[1], f), mix(c0[2], c1[2], f)];
}

// Koschmieder: the fraction of a target's contrast lost over `distFt`.
function fogFrac(distFt, visSM) {
  return 1 - Math.exp(-3 * distFt / Math.max(120, visSM * 5280));
}
// Extinction for something at infinity (sun, moon, stars) — the haze layer is
// shallow, so it is an air-mass path through ~2,500 ft of murk, not infinity.
function skyExtinction(altDeg, visSM) {
  const airmass = 1 / Math.max(0.09, Math.sin(rad(Math.max(altDeg, 0.5))));
  return fogFrac(2500 * Math.min(airmass, 8), visSM);
}
// Mix a colour toward the haze as if seen through `distFt` of air.
function fogged(col, distFt, F) { return mixC(col, F.col, fogFrac(distFt, F.vis) * F.max); }

/* ---- the sky dome ------------------------------------------------------ */

function drawSky(ctx, K, cond, ephem, LM, hazeCol) {
  const { W, H } = K;
  // Only a light grey wash for cloud here: unlike v1, the deck is now actually
  // drawn on top of the sky, so tinting by the full gloom would count it
  // twice. Low visibility, on the other hand, hazes the whole dome — in ¼ SM
  // fog there is no blue overhead at all.
  const skyHaze = fogFrac(3500, cond.visSM) * (cond.fog ? 1 : 0.92);
  const [zen, mid, hor] = skyColors(LM.sa)
    .map((c) => mixC(mixC(c, mixC([26, 30, 36], [140, 149, 162], LM.dl), LM.gloom * 0.45),
      hazeCol, skyHaze));
  // vertical band: zenith at the top of the frame down to the horizon line
  const g = ctx.createLinearGradient(0, Math.min(0, K.horY - H), 0, Math.max(K.horY, 2));
  g.addColorStop(0, css(zen));
  g.addColorStop(0.62, css(mid));
  g.addColorStop(1, css(hor));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, Math.max(0, K.horY) + 1);
  if (K.horY < H) { // below the horizon the sky still shows through haze gaps
    ctx.fillStyle = css(hor);
    ctx.fillRect(0, Math.max(0, K.horY), W, H - Math.max(0, K.horY));
  }

  // warm glow around the sun's bearing — strongest when it is low
  const sx = azScreenX(K, ephem.sun.az);
  if (sx != null && LM.sa > -12) {
    const sp = projAltAz(K, Math.max(ephem.sun.alt, -6), ephem.sun.az);
    const sy = sp ? sp.y : K.horY;
    const low = clamp(1 - Math.max(ephem.sun.alt, 0) / 18, 0, 1);
    const warm = mixC(rgb('#ffd9a0'), rgb('#ff8a3c'), low * 0.8);
    const a = clamp(0.42 * smooth(-12, 2, LM.sa) * (1 - LM.gloom * 0.75) * (0.35 + 0.65 * low), 0, 0.55);
    const R = W * (0.35 + 0.45 * low);
    const rg = ctx.createRadialGradient(sx, sy, 0, sx, sy, R);
    rg.addColorStop(0, css(warm, a));
    rg.addColorStop(0.45, css(warm, a * 0.35));
    rg.addColorStop(1, css(warm, 0));
    ctx.fillStyle = rg;
    ctx.fillRect(sx - R, sy - R, R * 2, R * 2);
  }

  // twilight: Earth's shadow rising opposite the sun, with the Belt of Venus
  // (backscattered red sunlight) sitting on top of it
  if (LM.sa < 2 && LM.sa > -9) {
    const ax = azScreenX(K, norm360(ephem.sun.az + 180));
    if (ax != null) {
      const band = clamp(1 - Math.abs(LM.sa + 3) / 6, 0, 1);
      const shadowTop = K.horY - K.focal * Math.tan(rad(clamp(-LM.sa * 2.2, 0, 14)));
      const bg = ctx.createLinearGradient(0, shadowTop - H * 0.10, 0, K.horY);
      bg.addColorStop(0, css([222, 138, 132], 0));
      bg.addColorStop(0.42, css([222, 138, 132], 0.20 * band));
      bg.addColorStop(0.62, css([70, 84, 140], 0.16 * band));
      bg.addColorStop(1, css([38, 48, 96], 0.30 * band));
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = bg;
      ctx.fillRect(0, Math.max(0, shadowTop - H * 0.10), W, K.horY - shadowTop + H * 0.10);
      ctx.restore();
    }
  }

  // a haze band hugging the horizon — the visual signature of low visibility
  const hz = clamp(1 - cond.visSM / 10, 0, 1);
  if (hz > 0.02 && K.horY > 0) {
    const top = K.horY - K.focal * Math.tan(rad(2 + 10 * hz));
    const hg = ctx.createLinearGradient(0, top, 0, K.horY);
    hg.addColorStop(0, css(hazeCol, 0));
    hg.addColorStop(1, css(hazeCol, clamp(hz * 0.75, 0, 0.8)));
    ctx.fillStyle = hg;
    ctx.fillRect(0, Math.max(0, top), W, K.horY - Math.max(0, top));
  }
}

/* ---- stars, constellations, the Milky Way, planets --------------------- */

// A named catalogue alone gives about ninety dots across the whole sky, which
// reads as an empty planetarium. Fill in with a deterministic faint field
// (uniform on the sphere, magnitudes 4–6) so the naked-eye sky has depth.
const FAINT = (() => {
  const out = [];
  for (let i = 0; i < 1500; i++) {
    out.push([h01(i * 2654435761) * 360,                       // RA
      Math.asin(h01(i * 40503 + 7) * 2 - 1) * R2D,             // Dec, area-fair
      4.0 + h01(i * 97 + 13) * 2.2]);
  }
  return out;
})();

const starCache = { key: '', val: null };
function starsAt(ephem) {
  const key = `${Math.floor(ephem.ms / 120000)}|${ephem.lat.toFixed(2)}`;
  if (starCache.key === key) return starCache.val;
  const named = STAR_DATA.map((s) => {
    const h = toHorizon(s[1] * 15, s[2], ephem.jd, ephem.lat, ephem.lon);
    h.name = s[0]; h.mag = s[3];
    return h;
  });
  const faint = [];
  for (const s of FAINT) {
    if (s[1] < ephem.lat - 92 || s[1] > ephem.lat + 92) continue;
    const h = toHorizon(s[0], s[1], ephem.jd, ephem.lat, ephem.lon);
    if (h.alt < 0.3) continue;
    h.mag = s[2];
    faint.push(h);
  }
  const val = { named, faint };
  starCache.key = key; starCache.val = val;
  return val;
}

function drawStars(ctx, K, cond, ephem, LM, t) {
  // stars fade out through twilight, behind cloud and through murk
  const dark = 1 - smooth(-14, -2, LM.sa);
  const clear = clamp(1 - (cond.cover * 0.5 + cond.gloomCover * 0.55), 0, 1);
  const aBase = dark * clear;
  if (aBase < 0.03) return;
  const cat = starsAt(ephem);
  const stars = cat.named;
  const labels = [];

  // Milky Way — a soft band along the galactic equator
  if (aBase > 0.55 && cond.visSM > 5) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < MILKY_WAY.length; i++) {
      const p = MILKY_WAY[i];
      const h = toHorizon(p[0], p[1], ephem.jd, ephem.lat, ephem.lon);
      if (h.alt < 2) continue;
      const s = projAltAz(K, h.alt, h.az);
      if (!s || s.x < -200 || s.x > K.W + 200) continue;
      const r = K.focal * 0.075;
      const a = 0.055 * aBase * p[2] * (1 - skyExtinction(h.alt, cond.visSM));
      const g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, r);
      g.addColorStop(0, css([186, 196, 224], a));
      g.addColorStop(1, css([186, 196, 224], 0));
      ctx.fillStyle = g;
      ctx.fillRect(s.x - r, s.y - r, r * 2, r * 2);
    }
    ctx.restore();
  }

  // constellation figures, under the stars themselves
  if (aBase > 0.4 && state.labels) {
    ctx.strokeStyle = css([120, 160, 220], 0.16 * aBase);
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const fig of FIGURES) {
      for (let li = 1; li < fig.length; li++) {
        const chain = fig[li];
        let prev = null;
        for (const nm of chain) {
          const st = stars[STAR_IX[nm]];
          const s = st && st.alt > 0.5 ? projAltAz(K, st.alt, st.az) : null;
          if (prev && s && Math.abs(prev.x - s.x) < K.W * 0.8) {
            ctx.moveTo(prev.x, prev.y); ctx.lineTo(s.x, s.y);
          }
          prev = s;
        }
      }
    }
    ctx.stroke();
  }

  // the faint background field first — flat dots, no bloom, no twinkle budget
  {
    const ext10 = clamp(cond.visSM / 10, 0, 1);
    for (let i = 0; i < cat.faint.length; i++) {
      const st = cat.faint[i];
      const s = projAltAz(K, st.alt, st.az);
      if (!s || s.x < 0 || s.x > K.W || s.y < 0 || s.y > K.H) continue;
      const a = clamp((1.35 - st.mag * 0.17) * aBase * ext10 *
        (1 - skyExtinction(st.alt, cond.visSM)) * (0.7 + 0.3 * h01(i * 31)), 0, 1);
      if (a < 0.03) continue;
      ctx.fillStyle = css([214, 222, 238], a);
      const r = a > 0.35 ? 1.4 : 1;
      ctx.fillRect(s.x, s.y, r, r);
    }
  }

  // the named stars
  for (let i = 0; i < stars.length; i++) {
    const st = stars[i];
    if (st.alt < 0.2) continue;
    const s = projAltAz(K, st.alt, st.az);
    if (!s || s.x < -6 || s.x > K.W + 6 || s.y < -6 || s.y > K.H + 6) continue;
    // A linear flux mapping makes everything below first magnitude vanish on
    // a screen, so compress it the way a planetarium does: alpha and radius
    // both fall roughly linearly with magnitude.
    const bright = clamp(1.18 - st.mag * 0.215, 0.14, 1);
    const ext = 1 - skyExtinction(st.alt, cond.visSM);
    const tw = 0.74 + 0.26 * Math.sin(t * (1.6 + h01(i) * 3.4) + i * 2.1);
    const a = clamp(bright * aBase * ext * tw * 1.25, 0, 1);
    if (a < 0.035) continue;
    const r = clamp(2.5 - st.mag * 0.4, 0.75, 2.6);
    ctx.fillStyle = css([236, 240, 250], a);
    ctx.beginPath(); ctx.arc(s.x, s.y, r, 0, 7); ctx.fill();
    if (r > 1.7) { // a little bloom on the brightest
      const g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, r * 4);
      g.addColorStop(0, css([200, 216, 255], a * 0.35));
      g.addColorStop(1, css([200, 216, 255], 0));
      ctx.fillStyle = g;
      ctx.fillRect(s.x - r * 4, s.y - r * 4, r * 8, r * 8);
    }
    if (state.labels && (st.mag < 0.9 || st.name === 'Polaris') && a > 0.3) {
      labels.push([s.x, s.y, st.name, '#9db4d8']);
    }
  }

  // planets — brighter, steadier, and worth naming
  for (const p of ephem.planets) {
    if (p.alt < 0.2) continue;
    const s = projAltAz(K, p.alt, p.az);
    if (!s || s.x < -6 || s.x > K.W + 6) continue;
    const bright = clamp(1.3 - p.mag * 0.2, 0.2, 1);
    const ext = 1 - skyExtinction(p.alt, cond.visSM);
    const a = clamp(bright * aBase * ext * 1.15, 0, 1);
    if (a < 0.05) continue;
    const r = clamp(3 - p.mag * 0.45, 1.1, 3.4);
    const tint = p.name === 'Mars' ? [255, 176, 140] : p.name === 'Venus' ? [255, 250, 232] : [246, 244, 226];
    const g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, r * 5);
    g.addColorStop(0, css(tint, a * 0.4));
    g.addColorStop(1, css(tint, 0));
    ctx.fillStyle = g;
    ctx.fillRect(s.x - r * 5, s.y - r * 5, r * 10, r * 10);
    ctx.fillStyle = css(tint, a);
    ctx.beginPath(); ctx.arc(s.x, s.y, r, 0, 7); ctx.fill();
    if (state.labels && a > 0.25) labels.push([s.x, s.y, p.name, '#d8cfa8']);
  }

  if (labels.length) {
    ctx.font = '10.5px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'left';
    for (const [x, y, nm, col] of labels) {
      ctx.fillStyle = css(rgb(col), 0.62 * aBase);
      ctx.fillText(nm, x + 6, y + 3.5);
    }
  }
}

/* ---- sun and moon discs ------------------------------------------------ */

function drawSunMoon(ctx, K, cond, ephem, LM) {
  const ext = (alt) => 1 - skyExtinction(alt, cond.visSM);

  if (ephem.sun.alt > -1) {
    const s = projAltAz(K, ephem.sun.alt, ephem.sun.az);
    if (s) {
      const vis = clamp((1 - LM.blocked * 0.85) * ext(ephem.sun.alt), 0, 1);
      const low = clamp(1 - Math.max(ephem.sun.alt, 0) / 12, 0, 1);
      const col = mixC(rgb('#fff8e0'), rgb('#ff8032'), low * 0.9);
      const R = Math.max(3, K.focal * 0.0093);   // the sun really is only 0.53° wide
      const gr = R * (6 + 10 * low);
      const g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, gr);
      g.addColorStop(0, css(col, 0.55 * vis));
      g.addColorStop(0.3, css(col, 0.16 * vis));
      g.addColorStop(1, css(col, 0));
      ctx.fillStyle = g;
      ctx.fillRect(s.x - gr, s.y - gr, gr * 2, gr * 2);
      if (vis > 0.06) {
        ctx.fillStyle = css(mixC(col, [255, 255, 255], 0.5 * (1 - low)), Math.min(1, vis * 1.6));
        ctx.beginPath(); ctx.arc(s.x, s.y, R, 0, 7); ctx.fill();
      }
    }
  }

  if (ephem.moon.alt > -1 && LM.dl < 0.97) {
    const s = projAltAz(K, ephem.moon.alt, ephem.moon.az);
    if (s) {
      const m = ephem.moon;
      const vis = clamp((1 - LM.blocked * 0.9) * ext(m.alt) * (1 - LM.dl * 0.85) *
        (0.25 + 0.75 * m.illum), 0, 1);
      if (vis > 0.03) {
        const R = Math.max(3.2, K.focal * 0.0091);
        const gr = R * 5;
        const g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, gr);
        g.addColorStop(0, css([214, 220, 214], 0.22 * vis));
        g.addColorStop(1, css([214, 220, 214], 0));
        ctx.fillStyle = g;
        ctx.fillRect(s.x - gr, s.y - gr, gr * 2, gr * 2);
        ctx.save();
        ctx.globalAlpha = clamp(vis * 1.5, 0, 1);
        ctx.translate(s.x, s.y);
        ctx.rotate(m.limbAngle);       // bright limb now points at the sun
        ctx.fillStyle = css(mixC([232, 228, 212], [190, 150, 110], clamp(1 - m.alt / 12, 0, 1) * 0.6));
        ctx.beginPath(); ctx.arc(0, 0, R, 0, 7); ctx.fill();
        // maria — a couple of soft grey patches so it reads as the moon
        ctx.fillStyle = css([196, 192, 180], 0.5);
        ctx.beginPath(); ctx.arc(-R * 0.28, -R * 0.22, R * 0.3, 0, 7); ctx.fill();
        ctx.beginPath(); ctx.arc(R * 0.22, R * 0.3, R * 0.22, 0, 7); ctx.fill();
        // terminator: a dark disc offset along the limb axis, clipped to the moon
        if (m.illum < 0.985) {
          ctx.beginPath(); ctx.arc(0, 0, R + 0.4, 0, 7); ctx.clip();
          ctx.fillStyle = css(mixC(skyColors(LM.sa)[0], [8, 10, 18], 0.35));
          const d = (1 - m.illum) * 2.05 * R * (m.waxing ? -1 : 1);
          ctx.beginPath(); ctx.arc(d, 0, R * 1.02, 0, 7); ctx.fill();
        }
        ctx.restore();
      }
    }
  }
}

/* ===================== Mode-7 planes: decks & ground ===================== */
/* One drawImage per screen row. For a level camera every row above the
   horizon maps to a single distance from a horizontal plane, and the lateral
   world offset is linear across the row — so a row is exactly a horizontal
   strip of a view-aligned texture. That is what makes a real ceiling: the
   deck closes overhead and squeezes into the horizon. */

// Returns {t, Y} for the screen row `sy` where the ray meets height `h`
// (feet above eye; negative for the ground). null when it never does.
function planeRow(K, sy, h) {
  const ky = (K.H / 2 - sy) / K.focal;
  const Dz = K.sP + ky * K.cP;
  if (h > 0 ? Dz <= 0.004 : Dz >= -0.004) return null;
  const t = h / Dz;
  if (t <= 0) return null;
  return { t, Y: t * (K.cP - ky * K.sP), ky };
}

function drawPlaneRows(ctx, K, tex, h, S, alpha, driftE, driftN, step, F, fromY, toY, opts) {
  const N = tex.tileN, pxPerFt = N / S;
  const maxSrc = N * (TEX_TILES - 2) + N * 0.95;   // stays inside the tile strip
  const skipFar = opts && opts.maxDistFt;
  const latDrift = driftE * K.cA - driftN * K.sA;
  const alongDrift = driftE * K.sA + driftN * K.cA;
  const wrap = (v, n) => ((v % n) + n) % n;
  ctx.save();
  for (let sy = fromY; sy < toY; sy += step) {
    const pr = planeRow(K, sy, h);
    if (!pr) continue;
    const dist = Math.abs(pr.t);
    if (skipFar && dist > opts.maxDistFt) continue;
    const fog = fogFrac(dist, F.vis) * F.max;
    // An opaque plane (the ground) must fade *to the haze colour*, not to
    // transparency — fading it out would reveal the sky behind it.
    let a = opts && opts.opaque ? alpha : alpha * (1 - fog);
    if (skipFar) a *= 1 - smooth(opts.maxDistFt * 0.45, opts.maxDistFt, dist);
    if (a < 0.02) continue;
    const srcW = Math.abs(pxPerFt * pr.t * K.W / K.focal);
    if (srcW > maxSrc || srcW < 0.02) {
      // Beyond this the deck is finer than one texture pixel per screen pixel:
      // it really has merged into a flat sheet, so fill with the texture's own
      // average — including its average opacity, or a FEW layer would paint a
      // solid band across the distance.
      if (!skipFar) {
        ctx.globalAlpha = clamp(a * tex.meanAlpha, 0, 1);
        ctx.fillStyle = css(tex.meanCol);
        ctx.fillRect(0, sy, K.W, step + 0.6);
        if (opts && opts.opaque && fog > 0.01) {
          ctx.globalAlpha = clamp(fog, 0, 1);
          ctx.fillStyle = css(F.col);
          ctx.fillRect(0, sy, K.W, step + 0.6);
        }
      }
      continue;
    }
    // cross-fade into the flat sheet rather than switching at one row, or the
    // boundary shows up as a hard seam straight across the sky
    const blend = smooth(maxSrc * 0.72, maxSrc, srcW);
    const u0 = N + wrap(pxPerFt * (pr.t * (-K.W / 2) / K.focal - latDrift), N);
    const v0 = Math.min(N - 1.001, wrap(pxPerFt * (pr.Y - alongDrift), N));
    ctx.globalAlpha = clamp(a * (1 - blend), 0, 1);
    ctx.drawImage(tex, u0, v0, srcW, 1, 0, sy, K.W, step + 0.6);
    if (blend > 0.01 && !skipFar) {
      ctx.globalAlpha = clamp(a * blend * tex.meanAlpha, 0, 1);
      ctx.fillStyle = css(tex.meanCol);
      ctx.fillRect(0, sy, K.W, step + 0.6);
    }
    if (opts && opts.opaque && fog > 0.01) {
      ctx.globalAlpha = clamp(fog, 0, 1);
      ctx.fillStyle = css(F.col);
      ctx.fillRect(0, sy, K.W, step + 0.6);
    }
  }
  ctx.restore();
}

// Mean colour of a texture, for the unresolvable far rows.
function texMean(cv) {
  const N = cv.tileN;
  const d = cv.getContext('2d').getImageData(0, 0, N, N).data;
  let r = 0, g = 0, b = 0, a = 0;
  for (let i = 0; i < d.length; i += 4) { const w = d[i + 3] / 255; r += d[i] * w; g += d[i + 1] * w; b += d[i + 2] * w; a += w; }
  const n = Math.max(1, a);
  cv.meanCol = [r / n, g / n, b / n];
  cv.meanAlpha = a / (d.length / 4);
  return cv;
}

/* ---- cloud layers ------------------------------------------------------ */

// Feet of sky per texture tile. Low decks get a tighter scale so the
// overhead view — where one tile is magnified hardest — keeps its structure.
const DECK_SCALE = (baseFt) => baseFt >= 12000 ? 38000 : baseFt >= 5000 ? 16000 : 6500;

function drawClouds(ctx, K, cond, ephem, LM, t, seed, F, step) {
  if (!cond.clouds.length) return;
  const lightB = Math.round(LM.L * 6);            // texture cache bucket
  const lit = mixC(mixC([246, 248, 251], [128, 136, 148], LM.gloom), [22, 27, 40],
    clamp(1 - LM.L * 1.55, 0, 0.85));
  const dark = mixC(lit, [34, 40, 54], 0.5 + LM.gloom * 0.28);
  // wind pushes the deck; higher decks move faster
  const toAz = cond.windDir == null ? K.hdg : norm360(cond.windDir + 180);
  // VV (vertical visibility) is not a layer you look up at — it is the height
  // you can see *into* the murk you are standing in, so draw it as a solid
  // obscuration deck at that height rather than skipping it.
  const layers = [...cond.clouds].sort((a, b) => b.baseFt - a.baseFt);
  for (const lay of layers) {
    const S = lay.amt === 'VV' ? 3000 : DECK_SCALE(lay.baseFt);
    const spd = (cond.windKt * 1.688) * (0.5 + 0.9 * clamp(lay.baseFt / 10000, 0, 1.6));
    const dE = spd * Math.sin(rad(toAz)) * t, dN = spd * Math.cos(rad(toAz)) * t;
    // A thin high veil is lit through; a low solid deck is looked at from
    // underneath, so it carries most of the shading.
    const thin = lay.baseFt >= 12000 ? 0.45 : lay.amt === 'FEW' || lay.amt === 'SCT' ? 0.72 : 1;
    const key = `c|${lay.amt}|${lay.cb}|${lightB}|${LM.gloom.toFixed(1)}|${seed & 1023}|${lay.baseFt}`;
    const tex = cachedTex(key, () => texMean(cloudTex(lay.amt, seed + lay.baseFt,
      mixC(lit, [255, 255, 255], (1 - thin) * 0.5), mixC(lit, dark, thin), !!lay.cb)));
    const alpha = lay.baseFt >= 12000 ? 0.55 : 0.97;
    const h = Math.max(60, lay.baseFt - EYE_FT);
    const toY = Math.min(K.horY, K.H);
    drawPlaneRows(ctx, K, tex, h, S, alpha, dE, dN, step, F, 0, toY);
    // Overhead, one tile is stretched several screen pixels per texel and the
    // deck goes soft. A second, finer pass over the near sky puts the detail
    // back where you are actually looking into the cloud.
    if (lay.baseFt < 8000 && lay.amt !== 'FEW' && step <= 2) {
      const dkey = key + '|d';
      const dtex = cachedTex(dkey, () => texMean(cloudTex(lay.amt, seed + lay.baseFt + 5501,
        mixC(lit, [255, 255, 255], (1 - thin) * 0.5), mixC(lit, dark, thin), !!lay.cb)));
      drawPlaneRows(ctx, K, dtex, h, S / 3.2, alpha * 0.5, dE, dN, step, F, 0, toY,
        { maxDistFt: Math.max(6000, lay.baseFt * 6) });
    }
  }
}

// A cumulonimbus is a tower, not a deck — draw it as a billboard at a bearing.
function drawCbTower(ctx, K, cond, LM, t, seed, F) {
  const cb = cond.clouds.find((l) => l.cb) || { baseFt: cond.ceil || 3500 };
  const az = norm360(h01(seed + 3) * 360);
  const distFt = 18000 + h01(seed + 4) * 22000;
  const topFt = 33000 + h01(seed + 5) * 12000;
  const base = projAltAz(K, Math.atan2(cb.baseFt, distFt) * R2D, az);
  const top = projAltAz(K, Math.atan2(topFt, distFt) * R2D, az);
  if (!base || !top) return;
  const wBase = K.focal * Math.atan2(9000, distFt);
  const fade = 1 - fogFrac(distFt, F.vis) * F.max;
  if (fade < 0.05) return;
  const lit = mixC([238, 242, 248], [40, 46, 60], clamp(1 - LM.L * 1.5, 0, 0.85));
  const dark = mixC(lit, [26, 30, 44], 0.55);
  ctx.save();
  ctx.globalAlpha = fade;
  for (let i = 0; i <= 13; i++) {
    const f = i / 13;
    const y = lerp(base.y, top.y, f);
    const half = wBase * lerp(0.55, 0.30, f) * (1 + 0.18 * Math.sin(i * 2.7 + seed));
    ctx.fillStyle = css(mixC(dark, lit, f * 0.6), 0.96);
    ctx.beginPath();
    ctx.ellipse(base.x + Math.sin(i * 1.9 + seed) * wBase * 0.08, y, half, Math.abs(base.y - top.y) / 11, 0, 0, 7);
    ctx.fill();
  }
  ctx.fillStyle = css(mixC(lit, dark, 0.2), 0.9);   // anvil
  ctx.beginPath();
  ctx.ellipse(base.x + wBase * 0.2, top.y, wBase * 0.95, Math.abs(base.y - top.y) * 0.055, 0, 0, 7);
  ctx.fill();
  if (cond.precipInt > 0 || cond.ts) {              // rain shaft under the cell
    ctx.fillStyle = css(mixC(dark, [96, 106, 124], 0.35), 0.3);
    ctx.beginPath();
    ctx.moveTo(base.x - wBase * 0.4, base.y); ctx.lineTo(base.x + wBase * 0.4, base.y);
    ctx.lineTo(base.x + wBase * 0.55, K.horY); ctx.lineTo(base.x - wBase * 0.2, K.horY);
    ctx.closePath(); ctx.fill();
  }
  ctx.restore();
}

/* ---- the ground -------------------------------------------------------- */

function drawGround(ctx, K, cond, LM, t, seed, F, step) {
  const snow = cond.snowGround;
  const base = snow ? mixC([226, 231, 238], [30, 36, 50], 1 - LM.L)
    : mixC(mixC([54, 68, 45], [15, 19, 15], 1 - LM.L), [80, 86, 92], LM.gloom * 0.22);
  const alt2 = snow ? mixC([200, 210, 224], [26, 32, 46], 1 - LM.L)
    : mixC(mixC([40, 54, 34], [12, 16, 12], 1 - LM.L), [80, 86, 92], LM.gloom * 0.22);
  const key = `g|${snow}|${Math.round(LM.L * 8)}|${Math.round(LM.gloom * 5)}`;
  const tex = cachedTex(key, () => texMean(groundTex(11, base, alt2, snow)));
  const fine = cachedTex(key + '|f', () => texMean(groundTex(29, base, alt2, snow)));
  const from = Math.max(0, Math.floor(K.horY));
  // Two passes: a broad pass that carries all the way to the horizon, plus a
  // fine one over the first few hundred feet so the grass at your feet is not
  // a flat wash. One scale cannot do both — the near rows magnify a tile 40×.
  drawPlaneRows(ctx, K, tex, -EYE_FT, 900, 1, 0, 0, step, F, from, K.H, { opaque: true });
  drawPlaneRows(ctx, K, fine, -EYE_FT, 130, 0.5, 0, 0, step, F, from, K.H, { maxDistFt: 900 });
  if (cond.rain > 0 || cond.drzl > 0) {   // wet sheen
    ctx.fillStyle = css([210, 224, 245], 0.05);
    ctx.fillRect(0, from, K.W, K.H - from);
  }
}

// The Chesapeake sits east of the field — a strip of water on the horizon.
function drawBay(ctx, K, cond, ephem, LM, F) {
  const distFt = 12000;
  const fade = 1 - fogFrac(distFt, F.vis) * F.max;
  if (fade < 0.06 || K.horY < -20) return;
  const col = mixC(mixC(skyColors(LM.sa)[2], [34, 60, 84], 0.55), [90, 96, 104], LM.gloom * 0.35);
  ctx.save();
  ctx.globalAlpha = fade;
  ctx.beginPath();
  let started = false;
  for (let az = 25; az <= 155; az += 5) {
    const p = projAltAz(K, -0.02, az);
    if (!p) { started = false; continue; }
    if (!started) { ctx.moveTo(p.x, K.horY - 1); started = true; }
    ctx.lineTo(p.x, K.horY + 1.5);
  }
  ctx.lineTo(K.W * 2, K.horY + 6); ctx.lineTo(-K.W, K.horY + 6);
  ctx.closePath();
  ctx.fillStyle = css(col);
  ctx.fill();
  // sun glitter on the water
  if (ephem.sun.alt > 1 && LM.blocked < 0.6) {
    const sx = azScreenX(K, ephem.sun.az);
    if (sx != null) {
      const g = ctx.createRadialGradient(sx, K.horY + 2, 0, sx, K.horY + 2, K.W * 0.09);
      g.addColorStop(0, css([255, 238, 196], 0.35 * (1 - LM.blocked)));
      g.addColorStop(1, css([255, 238, 196], 0));
      ctx.fillStyle = g;
      ctx.fillRect(sx - K.W * 0.09, K.horY - 2, K.W * 0.18, 10);
    }
  }
  ctx.restore();
}

/* ======================== the field, in 3-D ============================== */

// Which end is favoured, and the world frame the objects live in.
function fieldLayout(apt, cond) {
  const rw = (apt.runways && apt.runways[0]) || { ends: [{ name: '', hdg: 0 }], len: 3000, wid: 60 };
  const hwOf = (e) => cond.windDir == null || !cond.windKt ? 0
    : cond.windKt * Math.cos(rad(cond.windDir - e.hdg));
  const ends = rw.ends;
  const act = ends.length > 1 && hwOf(ends[1]) > hwOf(ends[0]) + 0.01 ? ends[1] : ends[0];
  const hdg = act.hdg;
  const ax = Math.sin(rad(hdg)), ay = Math.cos(rad(hdg));   // along, in E/N
  return {
    rw, act, other: ends.find((e) => e !== act) || act, hdg, ax, ay,
    px: Math.cos(rad(hdg)), py: -Math.sin(rad(hdg)),        // right of the axis
    thrFt: 70, len: rw.len || 3000, halfW: (rw.wid || 60) / 2,
    hwOf,
  };
}
// Point on the runway frame: `a` ft along from the camera, `s` ft right.
const fpt = (L, a, s) => [L.ax * a + L.px * s, L.ay * a + L.py * s];

// Draw an offscreen image mapped onto a patch of the ground (affine approx).
function drawGroundImage(ctx, K, img, L, a, s, alongFt, acrossFt) {
  const o = fpt(L, a + alongFt / 2, s - acrossFt / 2);
  const xEnd = fpt(L, a + alongFt / 2, s + acrossFt / 2);
  const yEnd = fpt(L, a - alongFt / 2, s - acrossFt / 2);
  const P = projWorld(K, o[0], o[1], 0), X = projWorld(K, xEnd[0], xEnd[1], 0),
    Y = projWorld(K, yEnd[0], yEnd[1], 0);
  if (!P || !X || !Y) return;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const dpr = ctx.__dpr || 1;
  ctx.setTransform((X.x - P.x) / img.width * dpr, (X.y - P.y) / img.width * dpr,
    (Y.x - P.x) / img.height * dpr, (Y.y - P.y) / img.height * dpr,
    P.x * dpr, P.y * dpr);
  ctx.drawImage(img, 0, 0);
  ctx.restore();
}

const numCache = {};
function numberImg(txt) {
  if (numCache[txt]) return numCache[txt];
  const cv = document.createElement('canvas');
  cv.width = 64; cv.height = 96;
  const c = cv.getContext('2d');
  c.fillStyle = '#fff';
  c.font = 'bold 82px "Segoe UI", system-ui, sans-serif';
  c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText(txt, 32, 50);
  numCache[txt] = cv;
  return cv;
}

function drawField(ctx, K, cond, LM, t, F, apt) {
  const L = fieldLayout(apt, cond);
  const snow = cond.snowGround;
  const fg = (col, d) => fogged(col, d, F);
  const poly = (pts, col, dist) => {
    const ps = pts.map((p) => projWorld(K, p[0], p[1], p[2] || 0));
    if (ps.some((p) => !p)) return;
    ctx.fillStyle = css(fg(col, dist));
    ctx.beginPath();
    ctx.moveTo(ps[0].x, ps[0].y);
    for (let i = 1; i < ps.length; i++) ctx.lineTo(ps[i].x, ps[i].y);
    ctx.closePath(); ctx.fill();
  };

  /* --- distant treeline: one continuous silhouette, sampled per column --- */
  {
    const dist = 5200;
    const fade = 1 - fogFrac(dist, F.vis) * F.max;
    if (fade > 0.04 && K.horY > -40 && K.horY < K.H + 40) {
      const col = fg(snow ? mixC([132, 142, 138], [20, 26, 24], 1 - LM.L)
        : mixC([27, 42, 27], [8, 12, 11], 1 - LM.L), dist);
      ctx.fillStyle = css(col);
      ctx.beginPath();
      ctx.moveTo(-4, K.horY + 10);
      for (let x = -4; x <= K.W + 4; x += 3) {
        // the azimuth this column looks along, then a wobbly canopy height
        const az = K.hdg + Math.atan((x - K.W / 2) / K.focal) * R2D;
        const s = az * 2.4;
        const hgt = 48 + 26 * Math.sin(s * 0.7) + 22 * h01((s * 3.1) | 0)
          + 12 * Math.sin(s * 2.9 + 1.7);
        const p = projAltAz(K, Math.atan2(hgt - EYE_FT, dist) * R2D, norm360(az));
        ctx.lineTo(x, p ? p.y : K.horY);
      }
      ctx.lineTo(K.W + 4, K.horY + 10);
      ctx.closePath();
      ctx.fill();
    }
  }

  /* --- runway --- */
  const nearD = L.thrFt, farD = L.thrFt + L.len;
  const rwCol = snow ? mixC([206, 212, 220], [28, 32, 42], 1 - LM.L)
    : mixC([66, 71, 78], [15, 17, 23], 1 - LM.L);
  // Segment the surface along its length: a 2,500 ft runway spans a lot of
  // visibility, and in fog you should watch the centreline dissolve ahead of
  // you rather than have the whole strip dim by one average amount.
  {
    const segs = 14;
    for (let i = 0; i < segs; i++) {
      const d0 = lerp(nearD, farD, i / segs), d1 = lerp(nearD, farD, (i + 1) / segs);
      poly([
        fpt(L, d0, -L.halfW).concat(0), fpt(L, d1, -L.halfW).concat(0),
        fpt(L, d1, L.halfW).concat(0), fpt(L, d0, L.halfW).concat(0),
      ], rwCol, (d0 + d1) / 2);
    }
  }

  if (!snow) {
    const mark = mixC([225, 228, 232], [40, 44, 52], clamp(1 - LM.L * 2.2, 0, 0.75));
    // threshold bars
    for (let i = -4; i <= 4; i++) {
      if (i === 0) continue;
      const s = i * (L.halfW / 5.2);
      poly([
        fpt(L, nearD + 12, s - L.halfW * 0.045).concat(0.02),
        fpt(L, nearD + 80, s - L.halfW * 0.045).concat(0.02),
        fpt(L, nearD + 80, s + L.halfW * 0.045).concat(0.02),
        fpt(L, nearD + 12, s + L.halfW * 0.045).concat(0.02),
      ], mark, nearD + 45);
    }
    // runway designator, clear of the threshold bars
    drawGroundImage(ctx, K, numberImg(L.act.name), L, nearD + 250, 0, 62, 44);
    // centreline
    for (let d = nearD + 250; d < farD - 100; d += 200) {
      poly([
        fpt(L, d, -1.5).concat(0.02), fpt(L, d + 120, -1.5).concat(0.02),
        fpt(L, d + 120, 1.5).concat(0.02), fpt(L, d, 1.5).concat(0.02),
      ], mark, d);
    }
  }

  /* --- edge lights, threshold bar, PAPI --- */
  const lightsOn = LM.L < 0.45 || cond.cat === 'IFR' || cond.cat === 'LIFR';
  if (lightsOn) {
    // Lights are point sources: the disc stays a couple of pixels wide and it
    // is the halo that carries the apparent brightness. Sizing the disc off
    // focal/dist instead would make the nearest lamp fill the frame.
    const dot = (E, N, U, col, bright) => {
      const p = projWorld(K, E, N, U);
      if (!p) return;
      const d = Math.hypot(E, N);
      const a = 1 - fogFrac(d, F.vis) * 0.9;
      if (a < 0.05) return;
      const rr = clamp(bright * 40 / Math.max(d, 60), 0.7, 3.2);
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, rr * 4);
      g.addColorStop(0, css(col, 0.55 * a));
      g.addColorStop(1, css(col, 0));
      ctx.fillStyle = g;
      ctx.fillRect(p.x - rr * 4, p.y - rr * 4, rr * 8, rr * 8);
      ctx.fillStyle = css(col, a);
      ctx.beginPath(); ctx.arc(p.x, p.y, rr, 0, 7); ctx.fill();
    };
    for (let d = nearD; d <= farD; d += 200) {
      const isEnd = d <= nearD + 1, isFar = d >= farD - 199;
      const col = isEnd ? [60, 240, 130] : isFar ? [255, 80, 70] : [248, 240, 205];
      for (const s of [-L.halfW - 8, L.halfW + 8]) {
        const q = fpt(L, d, s);
        dot(q[0], q[1], 1.8, col, 3.4);
      }
    }
    // PAPI, left side, abeam 1,000 ft — two white two red is on the glidepath
    for (let i = 0; i < 4; i++) {
      const q = fpt(L, nearD + 1000, -L.halfW - 55 - i * 22);
      dot(q[0], q[1], 3, i < 2 ? [255, 255, 250] : [255, 70, 62], 5);
    }
  }

  /* --- windsock --- */
  {
    const baseA = 210, baseS = -L.halfW - 130;
    const b = fpt(L, baseA, baseS);
    const dist = Math.hypot(b[0], b[1]);
    const poleTop = projWorld(K, b[0], b[1], 17);
    const poleBot = projWorld(K, b[0], b[1], 0);
    if (poleTop && poleBot) {
      ctx.strokeStyle = css(fg(mixC([120, 126, 132], [26, 30, 36], 1 - LM.L), dist));
      ctx.lineWidth = Math.max(1.2, K.focal * 0.5 / dist);
      ctx.beginPath(); ctx.moveTo(poleBot.x, poleBot.y); ctx.lineTo(poleTop.x, poleTop.y); ctx.stroke();
      // the sock streams downwind, fully extended at its 15 kt rating
      let wEff = cond.windKt;
      if (cond.gustKt) {
        const g = Math.max(0, Math.sin(t * 0.9) * 0.6 + Math.sin(t * 2.3) * 0.4);
        wEff = lerp(cond.windKt, cond.gustKt, clamp(g, 0, 1));
      }
      const ext = clamp(wEff / 15, 0, 1);
      const droop = lerp(0.85, 0.03, ext);        // radians below horizontal
      const vrbSwing = cond.windVrb ? Math.sin(t * 0.4) * 35 : Math.sin(t * 0.7) * (6 - 5 * ext);
      const toAz = cond.windDir == null ? K.hdg : norm360(cond.windDir + 180 + vrbSwing);
      const len = 26;
      const segs = 5;
      let pe = b[0], pn = b[1], pu = 17;
      for (let i = 0; i < segs; i++) {
        const dr = droop * (1 + i * 0.25) + Math.sin(t * (6 + wEff * 0.3) + i) * 0.05 * (1 - ext * 0.6);
        const seg = len / segs;
        const ne = pe + Math.sin(rad(toAz)) * seg * Math.cos(dr);
        const nn = pn + Math.cos(rad(toAz)) * seg * Math.cos(dr);
        const nu = pu - seg * Math.sin(dr);
        const p0 = projWorld(K, pe, pn, pu), p1 = projWorld(K, ne, nn, nu);
        if (p0 && p1) {
          const w0 = (K.focal * 2.6 / dist) * (1 - i / segs * 0.7);
          ctx.strokeStyle = css(fg(i % 2 ? [235, 231, 222] : [226, 112, 29], dist));
          ctx.lineWidth = Math.max(1.4, w0);
          ctx.lineCap = 'round';
          ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.stroke();
        }
        pe = ne; pn = nn; pu = nu;
      }
      ctx.lineCap = 'butt';
    }
  }

  /* --- rotating beacon: on from sunset to sunrise, or in daytime IFR --- */
  {
    const b = fpt(L, 620, L.halfW + 420);
    const dist = Math.hypot(b[0], b[1]);
    const top = projWorld(K, b[0], b[1], 42), bot = projWorld(K, b[0], b[1], 0);
    if (top && bot) {
      ctx.strokeStyle = css(fg(mixC([96, 102, 110], [22, 26, 32], 1 - LM.L), dist));
      ctx.lineWidth = Math.max(1, K.focal * 0.6 / dist);
      ctx.beginPath(); ctx.moveTo(bot.x, bot.y); ctx.lineTo(top.x, top.y); ctx.stroke();
      const on = LM.sa < 0.5 || cond.cat === 'IFR' || cond.cat === 'LIFR';
      if (on) {
        const cyc = t % 2;
        const flash = cyc < 0.14 ? [255, 255, 240] : (cyc > 1 && cyc < 1.14) ? [60, 235, 120] : null;
        if (flash) {
          const r = Math.max(6, K.focal * 30 / dist);
          const g = ctx.createRadialGradient(top.x, top.y, 0, top.x, top.y, r);
          g.addColorStop(0, css(flash, 0.8 * (1 - fogFrac(dist, F.vis) * 0.8)));
          g.addColorStop(1, css(flash, 0));
          ctx.fillStyle = g;
          ctx.fillRect(top.x - r, top.y - r, r * 2, r * 2);
        }
      }
    }
  }

  /* --- hangar + a parked high-wing --- */
  {
    const c = fpt(L, 520, L.halfW + 250);
    const dist = Math.hypot(c[0], c[1]);
    const wallC = fg(mixC([88, 92, 98], [20, 23, 29], 1 - LM.L), dist);
    const roofC = fg(mixC([112, 116, 122], [24, 28, 34], 1 - LM.L), dist);
    const cor = (da, ds, u) => { const q = fpt(L, 520 + da, L.halfW + 250 + ds); return projWorld(K, q[0], q[1], u); };
    const quad = (a, b2, c2, d, col) => {
      if (!a || !b2 || !c2 || !d) return;
      ctx.fillStyle = css(col);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b2.x, b2.y);
      ctx.lineTo(c2.x, c2.y); ctx.lineTo(d.x, d.y); ctx.closePath(); ctx.fill();
    };
    quad(cor(-45, -30, 0), cor(-45, -30, 22), cor(45, -30, 22), cor(45, -30, 0), wallC);
    quad(cor(-45, -30, 22), cor(-45, 30, 26), cor(45, 30, 26), cor(45, -30, 22), roofC);
  }
  {
    const c = fpt(L, 330, L.halfW + 130);
    const dist = Math.hypot(c[0], c[1]);
    const col = fg(mixC([18, 21, 26], [205, 210, 216], LM.L * 0.22), dist);
    const q = (da, ds, u) => { const p = fpt(L, 330 + da, L.halfW + 130 + ds); return projWorld(K, p[0], p[1], u); };
    const fus = [q(-12, 0, 4), q(-12, 0, 8), q(11, 0, 8.5), q(14, 0, 6.5)];
    if (fus.every(Boolean)) {
      ctx.fillStyle = css(col);
      ctx.beginPath(); ctx.moveTo(fus[0].x, fus[0].y);
      for (let i = 1; i < fus.length; i++) ctx.lineTo(fus[i].x, fus[i].y);
      ctx.closePath(); ctx.fill();
      const wl = q(0, -18, 9), wr = q(0, 18, 9), tt = q(12, 0, 14);
      if (wl && wr && tt) {
        ctx.strokeStyle = css(col);
        ctx.lineWidth = Math.max(1.2, K.focal * 1.4 / dist);
        ctx.beginPath(); ctx.moveTo(wl.x, wl.y); ctx.lineTo(wr.x, wr.y); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(fus[2].x, fus[2].y); ctx.lineTo(tt.x, tt.y); ctx.stroke();
      }
    }
  }
  return L;
}

/* ========================== weather effects ============================== */

function drawPrecip(ctx, K, cond, LM, t, seed) {
  const { W, H } = K;
  // wind's lateral component in the current view decides which way it slants
  const toAz = cond.windDir == null ? K.hdg + 90 : norm360(cond.windDir + 180);
  const latKt = cond.windKt * Math.sin(rad(toAz - K.hdg));
  const slant = clamp(latKt / 26, -0.85, 0.85);
  const h01s = (i) => h01(seed * 13 + i);

  if (cond.rain > 0 || (cond.ts && cond.precipInt === 0)) {
    const int = Math.max(cond.rain, cond.ts ? 2 : 0);
    const rc = mixC([168, 188, 216], [70, 86, 112], 1 - LM.L);
    for (let layer = 0; layer < 3; layer++) {          // near/mid/far parallax
      const scale = [1, 0.62, 0.38][layer];
      const n = Math.floor(W / 26 * int * int * (1.2 - layer * 0.25));
      ctx.strokeStyle = css(rc, 0.42 * scale + 0.08);
      ctx.lineWidth = int >= 3 ? 1.6 * scale : 1.05 * scale;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const j = i + layer * 977;
        const spd = (430 + h01s(j) * 250 + int * 90) * scale;
        const len = (10 + int * 5 + h01s(j + 11) * 8) * scale;
        const yy = ((h01s(j + 23) * H + t * spd) % (H + 40)) - 20;
        const xx = ((h01s(j + 37) * (W + 240) - 120 + yy * slant) % (W + 240) + (W + 240)) % (W + 240) - 120;
        ctx.moveTo(xx, yy);
        ctx.lineTo(xx + slant * len, yy + len);
      }
      ctx.stroke();
    }
    // splashes where the rain lands on the near ground
    if (K.horY < H) {
      ctx.strokeStyle = css(mixC([200, 220, 245], [90, 105, 130], 1 - LM.L), 0.3);
      ctx.lineWidth = 1;
      const n = 26 * int;
      for (let i = 0; i < n; i++) {
        const ph = (t * 1.7 + h01s(i + 700)) % 1;
        const fy = 0.15 + h01s(i + 800) * 0.85;
        const sy = K.horY + (H - K.horY) * fy * fy;
        if (sy > H) continue;
        const sx = h01s(i + 900) * W;
        const r = ph * (2 + (1 - fy) * 0 + fy * 9);
        ctx.globalAlpha = (1 - ph) * 0.5;
        ctx.beginPath(); ctx.ellipse(sx, sy, r, r * 0.32, 0, 0, 7); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
  }
  if (cond.drzl > 0 && cond.rain === 0) {
    const n = Math.floor(W / 14 * cond.drzl);
    ctx.fillStyle = css(mixC([176, 190, 210], [82, 92, 110], 1 - LM.L), 0.32);
    for (let i = 0; i < n; i++) {
      const spd = 95 + h01s(i) * 70;
      const yy = (h01s(i + 5) * H + t * spd) % H;
      const xx = (h01s(i + 9) * W + Math.sin(t + i) * 7 + yy * slant * 0.5 + W) % W;
      ctx.fillRect(xx, yy, 1.2, 2.6);
    }
  }
  if (cond.snow > 0) {
    const n = Math.floor(W / 11 * cond.snow * cond.snow);
    ctx.fillStyle = css([238, 242, 250], 0.82);
    for (let i = 0; i < n; i++) {
      const spd = 48 + h01s(i) * 58 + cond.snow * 12;
      const yy = ((h01s(i + 3) * H + t * spd) % (H + 20)) - 10;
      const xx = ((h01s(i + 17) * (W + 120) + Math.sin(t * (0.8 + h01s(i) * 1.2) + i) * 24 +
        yy * slant * 0.8) % (W + 120) + (W + 120)) % (W + 120) - 60;
      const r = 0.8 + h01s(i + 29) * 1.9;
      ctx.beginPath(); ctx.arc(xx, yy, r, 0, 7); ctx.fill();
    }
  }
  if (cond.sleet > 0) {
    const n = Math.floor(W / 20 * cond.sleet);
    ctx.fillStyle = css([224, 232, 242], 0.78);
    for (let i = 0; i < n; i++) {
      const spd = 390 + h01s(i) * 180;
      const yy = (h01s(i + 41) * H + t * spd) % H;
      const xx = ((h01s(i + 43) * W + yy * slant) % W + W) % W;
      ctx.fillRect(xx, yy, 1.8, 4.2);
    }
  }
}

function drawLightning(ctx, K, cond, t, seed) {
  if (!cond.ts) return;
  const { W, H } = K;
  for (let k = 0; k < 2; k++) {
    const period = 4.2 + h01(seed + k + 55) * 3.5;
    const ph = (t + h01(seed + k + 66) * 20) % period;
    if (ph >= 0.42) continue;
    const strike = Math.floor((t + h01(seed + k + 66) * 20) / period);
    if (ph < 0.15) {
      const bx = (h01(strike * 7 + k) * 0.86 + 0.07) * W;
      const by0 = Math.max(0, K.horY - H * 0.55);
      ctx.strokeStyle = css([255, 250, 232], 0.92 * (1 - ph / 0.15));
      ctx.lineWidth = 2;
      ctx.beginPath();
      let lx = bx, ly = by0;
      ctx.moveTo(lx, ly);
      for (let i = 1; i <= 8; i++) {
        lx += (h01(strike * 31 + i + k * 100) - 0.5) * W * 0.05;
        ly += (K.horY - by0) / 8;
        ctx.lineTo(lx, ly);
        if (i === 4 && h01(strike + k) > 0.5) {   // a branch
          ctx.moveTo(lx, ly);
          ctx.lineTo(lx + (h01(strike + 5) - 0.5) * W * 0.07, ly + (K.horY - by0) * 0.25);
          ctx.moveTo(lx, ly);
        }
      }
      ctx.stroke();
    }
    ctx.fillStyle = css([236, 240, 255], 0.3 * Math.exp(-ph * 8.5));
    ctx.fillRect(0, 0, W, H);
  }
}

/* ---------------------------- compass HUD -------------------------------- */

function drawCompass(ctx, K, cond, apt) {
  if (K.horY < 8 || K.horY > K.H - 4) return;
  const y = K.horY;
  ctx.save();
  ctx.font = '10px "Segoe UI", system-ui, sans-serif';
  ctx.textAlign = 'center';
  for (let az = 0; az < 360; az += 10) {
    const x = azScreenX(K, az);
    if (x == null || x < -20 || x > K.W + 20) continue;
    const major = az % 30 === 0;
    ctx.strokeStyle = `rgba(255,255,255,${major ? 0.34 : 0.16})`;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y - (major ? 9 : 5)); ctx.stroke();
    if (major && state.labels) {
      const name = az % 90 === 0 ? ['N', 'E', 'S', 'W'][az / 90] : String(az).padStart(3, '0');
      ctx.fillStyle = `rgba(226,236,250,${az % 90 === 0 ? 0.8 : 0.42})`;
      ctx.fillText(name, x, y - 12);
    }
  }
  // where the wind is coming from
  if (cond.windKt > 0 && cond.windDir != null && state.labels) {
    const x = azScreenX(K, cond.windDir);
    if (x != null && x > -30 && x < K.W + 30) {
      ctx.fillStyle = 'rgba(74,158,255,0.85)';
      ctx.beginPath();
      ctx.moveTo(x, y - 15); ctx.lineTo(x - 5, y - 24); ctx.lineTo(x + 5, y - 24);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = 'rgba(160,205,255,0.9)';
      ctx.fillText(`${cond.windKt}kt`, x, y - 28);
    }
  }
  // runway ends, labelled where they actually lie
  const rw = apt.runways && apt.runways[0];
  if (rw && state.labels) {
    for (const e of rw.ends) {
      const x = azScreenX(K, e.hdg);
      if (x == null || x < -20 || x > K.W + 20) continue;
      ctx.fillStyle = 'rgba(240,192,64,0.75)';
      ctx.fillText(`RWY ${e.name}`, x, y + 13);
    }
  }
  ctx.restore();
}

/* ============================ the painter ================================ */
/* Pure function of (cond, ephem, cam, t, seed) — the live scene, the TAF
   thumbnails and pasted METARs all come through here. */

function drawScene(ctx, W, H, cond, ephem, t, seed, camIn, apt, quality) {
  const K = makeCam(camIn, W, H);
  const LM = lightModel(cond, ephem);
  const step = quality || 2;
  const hazeCol = cond.smoke ? mixC([136, 118, 96], [34, 28, 22], 1 - LM.L)
    : cond.haze ? mixC([198, 178, 142], [50, 44, 36], 1 - LM.L)
      : mixC([208, 214, 222], [14, 18, 26], 1 - LM.L);
  const F = { vis: cond.visSM, col: hazeCol, max: 1 };

  ctx.clearRect(0, 0, W, H);
  drawSky(ctx, K, cond, ephem, LM, hazeCol);
  drawStars(ctx, K, cond, ephem, LM, t);
  drawSunMoon(ctx, K, cond, ephem, LM);
  drawClouds(ctx, K, cond, ephem, LM, t, seed, F, step);
  if (cond.hasCb) drawCbTower(ctx, K, cond, LM, t, seed, F);
  drawGround(ctx, K, cond, LM, t, seed, F, step);
  drawBay(ctx, K, cond, ephem, LM, F);
  drawField(ctx, K, cond, LM, t, F, apt);
  drawCompass(ctx, K, cond, apt);

  // Obscuration wash. Distance fog is already applied row by row and object by
  // object, so this is only the murk within arm's reach — keep it short or a
  // 1/4 SM fog whites out the threshold markings 60 ft in front of you, which
  // is exactly what you *can* still see in real fog.
  const obsc = Math.max(
    cond.fog || cond.clouds.some((l) => l.amt === 'VV') ? 0.22 : cond.mist ? 0.09 : 0,
    fogFrac(260, cond.visSM) * 0.8);
  if (obsc > 0.015) {
    ctx.fillStyle = css(hazeCol, clamp(obsc, 0, 0.97));
    ctx.fillRect(0, 0, W, H);
    for (let i = 0; i < 3; i++) {   // drifting banks
      const fx = ((t * (4 + i * 3) + h01(i + 90) * W * 2) % (W * 1.7)) - W * 0.35;
      const ry = H * 0.07;
      const g = ctx.createRadialGradient(fx, K.horY - i * H * 0.05, 0, fx, K.horY - i * H * 0.05, W * 0.3);
      g.addColorStop(0, css(hazeCol, obsc * 0.3));
      g.addColorStop(1, css(hazeCol, 0));
      ctx.fillStyle = g;
      ctx.fillRect(fx - W * 0.3, K.horY - i * H * 0.05 - ry * 2, W * 0.6, ry * 4);
    }
  }

  drawPrecip(ctx, K, cond, LM, t, seed);
  drawLightning(ctx, K, cond, t, seed);

  const vg = ctx.createRadialGradient(W / 2, H / 2, H * 0.52, W / 2, H / 2, W * 0.74);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(0,0,0,0.24)');
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, W, H);
  return K;
}

/* ======================= scene canvas & main loop ======================== */

const sceneCanvas = $('scene');
const sceneCtx = sceneCanvas.getContext('2d');
let sceneW = 0, sceneH = 0, needResize = true, quality = 2;

function resizeScene() {
  const r = sceneCanvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  sceneCanvas.width = Math.max(1, round(r.width * dpr));
  sceneCanvas.height = Math.max(1, round(r.height * dpr));
  sceneCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  sceneCtx.__dpr = dpr;
  sceneCtx.imageSmoothingEnabled = true;
  sceneW = r.width; sceneH = r.height;
  needResize = false;
}
new ResizeObserver(() => { needResize = true; }).observe(sceneCanvas);

// What the loop paints: set by applyScene() / setOffset().
let active = null;
let frameMs = 16;

function frame() {
  requestAnimationFrame(frame);
  if (document.hidden) return;
  densFrame(performance.now());
  if (!active) return;
  if (needResize) resizeScene();
  if (!sceneW) return;
  const t0 = performance.now();
  const ms = active.timeMs || Date.now();
  const eph = ephemerisAt(ms, active.lat, active.lon);
  drawScene(sceneCtx, sceneW, sceneH, active.cond, eph, t0 / 1000, active.seed, cam, active.apt, quality);
  frameMs = frameMs * 0.9 + (performance.now() - t0) * 0.1;
  if (frameMs > 22 && quality < 4) quality++;
  else if (frameMs < 9 && quality > 1) quality--;
  if (hudDirty) { updateHud(eph); hudDirty = false; }
}
requestAnimationFrame(frame);

/* --------------------------- looking around ----------------------------- */

let hudDirty = true;
function setView(hdg, pitch, fov) {
  cam.hdg = norm360(hdg);
  if (pitch != null) cam.pitch = clamp(pitch, -30, 85);
  if (fov != null) cam.fov = clamp(fov, 35, 130);
  hudDirty = true;
}

function updateHud(eph) {
  const el = $('hud-look');
  if (!el) return;
  const az = round(cam.hdg) % 360;
  const card = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW',
    'W', 'WNW', 'NW', 'NNW'][round(az / 22.5) % 16];
  el.textContent = `looking ${String(az).padStart(3, '0')}°T ${card} · ${cam.pitch > 0 ? '+' : ''}${round(cam.pitch)}°`;
  const note = $('hud-note');
  if (note && eph) {
    const bits = [];
    const s = eph.sun, m = eph.moon;
    bits.push(s.alt > -0.9
      ? `sun ${round(s.alt)}° up, bearing ${String(round(s.az)).padStart(3, '0')}°`
      : `sun ${round(-s.alt)}° below the horizon`);
    if (m.alt > 0) bits.push(`moon ${round(m.illum * 100)}% lit at ${round(m.alt)}°`);
    note.textContent = bits.join(' · ');
  }
}

function bindLook() {
  let drag = null;
  sceneCanvas.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY, hdg: cam.hdg, pitch: cam.pitch };
    sceneCanvas.setPointerCapture(e.pointerId);
    sceneCanvas.classList.add('dragging');
    const hint = $('drag-hint');
    if (hint) hint.style.opacity = '0';
  });
  sceneCanvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const perPx = cam.fov / Math.max(1, sceneW);
    setView(drag.hdg - (e.clientX - drag.x) * perPx, drag.pitch + (e.clientY - drag.y) * perPx);
  });
  const end = () => { drag = null; sceneCanvas.classList.remove('dragging'); };
  sceneCanvas.addEventListener('pointerup', end);
  sceneCanvas.addEventListener('pointercancel', end);
  sceneCanvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    setView(cam.hdg, cam.pitch, cam.fov * (e.deltaY > 0 ? 1.08 : 0.926));
  }, { passive: false });
  setTimeout(() => { const h = $('drag-hint'); if (h) h.style.opacity = '0'; }, 6000);
}

/* ============================ flight maths =============================== */

// Air density kg/m³ from temp, dewpoint (moist air is LIGHTER), altimeter.
function airDensity(tempC, dewC, altInHg, elevFt) {
  const pa = elevFt + (29.92 - altInHg) * 1000;
  const p = 1013.25 * Math.pow(1 - 6.87559e-6 * pa, 5.2559);
  let tK = tempC + 273.15;
  if (dewC != null) {
    const e = 6.1078 * Math.pow(10, 7.5 * dewC / (237.3 + dewC));
    tK = tK / (1 - (e / p) * (1 - 0.622));
  }
  return { rho: (p * 100) / (287.05 * tK), pa };
}
function densityAltitude(tempC, dewC, altInHg, elevFt) {
  const { pa } = airDensity(tempC, dewC, altInHg, elevFt);
  const isa = 15 - 1.98 * (elevFt / 1000);
  return { pa, da: pa + 118.8 * (tempC - isa), isa };
}
function relHumidity(tempC, dewC) {
  const e = (x) => Math.exp(17.625 * x / (243.04 + x));
  return round(100 * e(dewC) / e(tempC));
}
// Head/cross components for a runway end, °true throughout.
function windComponents(cond, hdgDeg) {
  if (cond.windDir == null || !cond.windKt) return { hw: 0, xw: 0, xwAbs: 0, side: '', gustXw: 0 };
  const d = rad(cond.windDir - hdgDeg);
  const hw = cond.windKt * Math.cos(d), xw = cond.windKt * Math.sin(d);
  const gustXw = cond.gustKt ? Math.abs(cond.gustKt * Math.sin(d)) : 0;
  return { hw, xw, xwAbs: Math.abs(xw), side: xw >= 0 ? 'right' : 'left', gustXw };
}

const catClass = (v) => v === 'VFR' ? 'good' : v === 'MVFR' ? '' : 'bad';

/* --------------------------- runway diagram ----------------------------- */

function drawRwyDiagram(cv, cond, apt) {
  const r = cv.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  cv.width = Math.max(1, round(r.width * dpr));
  cv.height = Math.max(1, round(r.height * dpr));
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = r.width, H = r.height;
  ctx.clearRect(0, 0, W, H);
  const cx = W / 2, cy = H / 2, R = Math.min(W, H) * 0.36;

  // compass rose
  ctx.strokeStyle = '#2b2b2b';
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, 7); ctx.stroke();
  ctx.font = '10px "Segoe UI", system-ui, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = '#555';
  for (const [az, nm] of [[0, 'N'], [90, 'E'], [180, 'S'], [270, 'W']]) {
    ctx.fillText(nm, cx + Math.sin(rad(az)) * (R + 9), cy - Math.cos(rad(az)) * (R + 9));
  }

  // every runway at the field, drawn on its true alignment
  for (const rw of (apt.runways || [])) {
    const hdg = rw.ends[0].hdg;
    const dx = Math.sin(rad(hdg)) * R * 0.86, dy = -Math.cos(rad(hdg)) * R * 0.86;
    ctx.strokeStyle = '#4a4a4a';
    ctx.lineWidth = 9;
    ctx.lineCap = 'butt';
    ctx.beginPath(); ctx.moveTo(cx - dx, cy - dy); ctx.lineTo(cx + dx, cy + dy); ctx.stroke();
    ctx.strokeStyle = '#777';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(cx - dx, cy - dy); ctx.lineTo(cx + dx, cy + dy); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#999';
    ctx.font = '9.5px "Segoe UI", system-ui, sans-serif';
    ctx.fillText(rw.ends[0].name, cx + dx * 1.14, cy + dy * 1.14);
    if (rw.ends[1]) ctx.fillText(rw.ends[1].name, cx - dx * 1.14, cy - dy * 1.14);
  }

  // the wind, as an arrow flying from where it comes from
  if (cond.windKt > 0) {
    const from = cond.windVrb || cond.windDir == null ? null : cond.windDir;
    if (from == null) {
      ctx.fillStyle = '#4a9eff';
      ctx.font = '11px "Segoe UI", system-ui, sans-serif';
      ctx.fillText(`VRB ${cond.windKt} kt`, cx, cy - R - 22 < 8 ? H - 8 : 10);
    } else {
      const sx = cx + Math.sin(rad(from)) * R, sy = cy - Math.cos(rad(from)) * R;
      const ex = cx + Math.sin(rad(from)) * R * 0.22, ey = cy - Math.cos(rad(from)) * R * 0.22;
      ctx.strokeStyle = '#4a9eff';
      ctx.lineWidth = 2.4;
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();
      const a = Math.atan2(ey - sy, ex - sx);
      ctx.fillStyle = '#4a9eff';
      ctx.beginPath();
      ctx.moveTo(ex, ey);
      ctx.lineTo(ex - Math.cos(a - 0.4) * 10, ey - Math.sin(a - 0.4) * 10);
      ctx.lineTo(ex - Math.cos(a + 0.4) * 10, ey - Math.sin(a + 0.4) * 10);
      ctx.closePath(); ctx.fill();
      // variable-direction fan
      if (cond.windVarRange) {
        ctx.strokeStyle = 'rgba(74,158,255,0.3)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(cx, cy, R * 0.92, rad(cond.windVarRange[0] - 90), rad(cond.windVarRange[1] - 90));
        ctx.stroke();
      }
    }
  } else {
    ctx.fillStyle = '#666';
    ctx.font = '12px "Segoe UI", system-ui, sans-serif';
    ctx.fillText('calm', cx, cy);
  }
}

/* --------------------------- the brief cards ---------------------------- */

function renderBrief(c, apt, atMs) {
  const grid = $('brief-grid');
  if (!grid) return;
  const ms = atMs == null ? Date.now() : atMs;
  const cards = [];

  /* --- 1. runway & wind --- */
  const rw = (apt.runways || [])[0];
  let windRows = '';
  let favored = null;
  if (rw) {
    const scored = [];
    for (const r of apt.runways) {
      for (const e of r.ends) scored.push({ e, w: windComponents(c, e.hdg) });
    }
    scored.sort((a, b) => b.w.hw - a.w.hw);
    favored = scored[0];
    for (const s of scored.slice(0, 4)) {
      const w = s.w;
      const xwCls = w.xwAbs >= 15 ? 'bad' : w.xwAbs >= 10 ? 'warn' : '';
      const hwTxt = w.hw >= -0.05 ? `${round(w.hw)} kt head` :
        `<span style="color:#ef4444">${round(-w.hw)} kt TAIL</span>`;
      windRows += `<div class="kv"><span class="k">${s === favored ? '★ ' : ''}RWY ${esc(s.e.name)} ` +
        `<span style="color:#555">${String(s.e.hdg).padStart(3, '0')}°T</span></span>` +
        `<span class="v ${xwCls}">${hwTxt} · ${round(w.xwAbs)} kt X${w.xwAbs >= 0.5 ? ' ' + w.side[0].toUpperCase() : ''}` +
        `${w.gustXw >= w.xwAbs + 1 ? ` <span style="color:#f59e0b">(G${round(w.gustXw)})</span>` : ''}</span></div>`;
    }
  }
  const xwWorst = favored ? favored.w : { xwAbs: 0, gustXw: 0, hw: 0 };
  const wv = xwWorst.gustXw > xwWorst.xwAbs ? xwWorst.gustXw : xwWorst.xwAbs;
  const wVerdict = c.windKt === 0 ? 'Calm — take the runway that suits the pattern.'
    : c.windVrb ? 'Variable direction: expect the sock to swing on final; be ready for either drift.'
      : wv >= 20 ? 'Beyond most light-single demonstrated crosswind values — think hard.'
        : wv >= 15 ? 'A real crosswind. Wing down, top rudder, and a firm plan for the go-around.'
          : wv >= 8 ? 'Honest crosswind practice weather.'
            : xwWorst.hw < -1 ? 'Every usable end has a tailwind component — expect a long roll.'
              : 'Straightforward — mostly down the runway.';
  cards.push(`<div class="card"><h3>Wind on the runway</h3>
    <canvas id="rwy-canvas"></canvas>${windRows}
    <div class="verdict${wv >= 15 ? ' warn' : ''}">${esc(wVerdict)}</div></div>`);

  /* --- 2. density altitude & performance --- */
  let perf = '<div class="kv"><span class="k">density altitude</span><span class="v">no temp/pressure</span></div>';
  let perfVerdict = '';
  if (c.tempC != null && c.altInHg != null) {
    const { da, pa, isa } = densityAltitude(c.tempC, c.dewC, c.altInHg, apt.elevFt);
    const { rho } = airDensity(c.tempC, c.dewC, c.altInHg, apt.elevFt);
    const daR = round(da / 50) * 50;
    const k = da / 1000;
    const roll = Math.pow(1.1, Math.max(0, k)) - 1;         // +10% ground roll per 1,000 ft
    const climb = clamp(k * 0.08, 0, 0.85);                 // −8% climb per 1,000 ft
    const daCol = da <= 1500 ? 'good' : da <= 3000 ? 'warn' : 'bad';
    perf = `<div class="kv"><span class="k">density altitude</span><span class="v ${daCol}">${daR.toLocaleString()} ft</span></div>
      <div class="kv"><span class="k">pressure altitude</span><span class="v">${round(pa).toLocaleString()} ft</span></div>
      <div class="kv"><span class="k">air density</span><span class="v">${rho.toFixed(3)} kg/m³ · ${(rho / 1.225 * 100).toFixed(1)}% std</span></div>
      <div class="kv"><span class="k">temp vs ISA</span><span class="v">${round(c.tempC)}° vs ${isa.toFixed(0)}° C (${c.tempC - isa >= 0 ? '+' : ''}${round(c.tempC - isa)})</span></div>
      <div class="kv"><span class="k">takeoff roll</span><span class="v ${roll > 0.25 ? 'warn' : ''}">≈ ${roll >= 0 ? '+' : ''}${round(roll * 100)}%</span></div>
      <div class="kv"><span class="k">rate of climb</span><span class="v ${climb > 0.2 ? 'warn' : ''}">≈ −${round(climb * 100)}%</span></div>
      <div class="kv"><span class="k">TAS at 100 KIAS</span><span class="v">${round(100 * (1 + 0.02 * Math.max(0, k)))} kt</span></div>`;
    perfVerdict = da <= apt.elevFt + 200
      ? 'The airplane performs at (or better than) its book field-elevation numbers.'
      : `Wing, prop and cylinders behave as if ${esc(apt.id)} sat at ${daR.toLocaleString()} ft.`;
  }
  cards.push(`<div class="card"><h3>What the airplane feels</h3>${perf}
    <div class="verdict">${esc(perfVerdict)}</div>
    <div class="brief-note">Roll and climb factors are the standard CFI rules of thumb (+10% roll, −8% climb
      per 1,000 ft of DA) — a planning sanity check, not a substitute for the POH chart.</div></div>`);

  /* --- 3. legality --- */
  {
    const vis = c.visKnown ? c.visSM : null;
    const ceil = c.ceil;
    const eOk = (vis == null || vis >= 3) && (ceil == null || ceil >= 1000);
    const gOk = (vis == null || vis >= 1) && (ceil == null || ceil >= 0);
    const paLines = [];
    paLines.push(`<div class="kv"><span class="k">category</span><span class="v ${catClass(c.cat)}">${c.cat}</span></div>`);
    paLines.push(`<div class="kv"><span class="k">ceiling</span><span class="v">${ceil == null ? 'none reported' : ceil.toLocaleString() + ' ft AGL'}</span></div>`);
    paLines.push(`<div class="kv"><span class="k">visibility</span><span class="v">${vis == null ? '—' : fmtVisSM(vis) + ' SM'}</span></div>`);
    paLines.push(`<div class="kv"><span class="k">Class E (≥700 AGL)</span><span class="v ${eOk ? 'good' : 'bad'}">${eOk ? 'VFR legal' : 'below VFR'}</span></div>`);
    paLines.push(`<div class="kv"><span class="k">Class G (surface–700)</span><span class="v ${gOk ? 'good' : 'bad'}">${gOk ? '1 SM &amp; clear of cloud' : 'below VFR'}</span></div>`);
    // Only worth saying when the deck is low enough to matter in the pattern.
    if (ceil != null && ceil < 6000) {
      const room = ceil - 1000;   // 1,000 ft AGL pattern
      paLines.push(`<div class="kv"><span class="k">room at pattern alt</span><span class="v ${room < 500 ? 'bad' : room < 1500 ? 'warn' : ''}">${room >= 0 ? room.toLocaleString() + ' ft under the deck' : 'deck is BELOW pattern altitude'}</span></div>`);
    }
    const verdict = !eOk
      ? 'Below basic VFR in controlled airspace — this is an IFR (or stay-home) day.'
      : c.cat === 'MVFR'
        ? 'Legal VFR, but marginal: the deck or the visibility will squeeze you somewhere.'
        : 'Basic VFR with room to spare.';
    cards.push(`<div class="card"><h3>Can you go?</h3>${paLines.join('')}
      <div class="verdict${!eOk ? ' bad' : c.cat === 'MVFR' ? ' warn' : ''}">${esc(verdict)}</div>
      <div class="brief-note">Day VFR, no special authorisations. 500 below / 1,000 above / 2,000 horizontal
        cloud clearance applies in Class E below 10,000 ft.</div></div>`);
  }

  /* --- 4. moisture & temperature --- */
  if (c.tempC != null) {
    const rows = [];
    const spread = c.dewC != null ? c.tempC - c.dewC : null;
    rows.push(`<div class="kv"><span class="k">temp / dewpoint</span><span class="v">${round(cToF(c.tempC))}° / ${c.dewC != null ? round(cToF(c.dewC)) + '°' : '—'} F</span></div>`);
    if (spread != null) {
      rows.push(`<div class="kv"><span class="k">spread</span><span class="v ${spread <= 2 ? 'warn' : ''}">${spread.toFixed(0)} °C · RH ${relHumidity(c.tempC, c.dewC)}%</span></div>`);
      const espy = Math.max(0, round(spread * 400 / 100) * 100);
      const rep = c.clouds.length ? Math.min(...c.clouds.map((l) => l.baseFt)) : null;
      rows.push(`<div class="kv"><span class="k">Espy cloud base</span><span class="v">≈ ${espy.toLocaleString()} ft AGL${rep != null ? ` (reported ${rep.toLocaleString()})` : ''}</span></div>`);
    }
    const fl = apt.elevFt + c.tempC * 500;   // 2 °C / 1,000 ft standard lapse
    rows.push(`<div class="kv"><span class="k">freezing level</span><span class="v ${fl < 4000 ? 'warn' : ''}">${c.tempC <= 0 ? 'at the surface' : '≈ ' + (round(fl / 100) * 100).toLocaleString() + ' ft MSL'}</span></div>`);
    const icing = c.tempC <= 2 && (c.precipInt > 0 || c.fog || c.ceil != null && c.ceil < 4000);
    const verdict = c.fz ? 'Freezing precipitation is reported — that is a no-go in anything without ice protection.'
      : icing ? 'Cold, moist and cloudy near the surface: structural icing is on the table in cloud.'
        : spread != null && spread <= 2 ? 'Temperature and dewpoint are converging — fog or a low deck is likely, especially near sunrise.'
          : 'Nothing unusual in the moisture picture.';
    cards.push(`<div class="card"><h3>Moisture &amp; temperature</h3>${rows.join('')}
      <div class="verdict${c.fz || icing ? ' bad' : spread != null && spread <= 2 ? ' warn' : ''}">${esc(verdict)}</div>
      <div class="brief-note">Espy's rule: convective cloud base ≈ 400 ft per °C of spread. Freezing level
        assumes the 2 °C / 1,000 ft standard lapse from the field.</div></div>`);
  }

  /* --- 5. sun, moon, and legal night --- */
  {
    const sd = solarDay(ms, apt.lat, apt.lon);
    const eph = ephemerisAt(ms, apt.lat, apt.lon);
    const T = (v) => v ? fmtTime(v) : '—';
    const rows = [
      `<div class="kv"><span class="k">civil twilight</span><span class="v">${T(sd.dawn)} → ${T(sd.dusk)}</span></div>`,
      `<div class="kv"><span class="k">sunrise / sunset</span><span class="v">${T(sd.sunrise)} → ${T(sd.sunset)}</span></div>`,
      `<div class="kv"><span class="k">position log “night”</span><span class="v">${T(sd.dusk)} → ${T(sd.dawn)}</span></div>`,
      `<div class="kv"><span class="k">night landings count</span><span class="v">${sd.sunset ? T(+sd.sunset + 3600000) : '—'} → ${sd.sunrise ? T(+sd.sunrise - 3600000) : '—'}</span></div>`,
      `<div class="kv"><span class="k">sun right now</span><span class="v">${round(eph.sun.alt)}° alt · ${String(round(eph.sun.az)).padStart(3, '0')}°T</span></div>`,
      `<div class="kv"><span class="k">moon</span><span class="v">${round(eph.moon.illum * 100)}% ${eph.moon.waxing ? 'waxing' : 'waning'}${eph.moon.alt > 0.5 ? ` · ${round(eph.moon.alt)}° up at ${String(round(eph.moon.az)).padStart(3, '0')}°T` : ' · below the horizon'}</span></div>`,
    ];
    const upSoon = eph.sun.alt < 0 && eph.sun.alt > -12;
    cards.push(`<div class="card"><h3>Sun &amp; moon</h3>${rows.join('')}
      <div class="verdict">${upSoon ? 'Twilight — position lights on, and the sun will be right on the horizon on one runway heading.' : eph.sun.alt > 0 && eph.sun.alt < 12 ? 'Low sun: expect real glare on the reciprocal heading, and a long shadow on final.' : ''}</div>
      <div class="brief-note">61.57(b) currency landings need the hour-after-sunset window; the position-log
        definition of night is evening to morning civil twilight.</div></div>`);
  }

  grid.innerHTML = cards.join('');
  const cv = $('rwy-canvas');
  if (cv) requestAnimationFrame(() => drawRwyDiagram(cv, c, apt));
}

/* ========================= decode dictionary ============================= */

const WX_DESC = { TS: 'thunderstorm', SH: 'showers of', FZ: 'freezing', DR: 'low drifting', BL: 'blowing', MI: 'shallow', BC: 'patches of', PR: 'partial' };
const WX_PHEN = {
  DZ: 'drizzle', RA: 'rain', SN: 'snow', SG: 'snow grains', IC: 'ice crystals', PL: 'ice pellets',
  GR: 'hail', GS: 'small hail / snow pellets', UP: 'unknown precipitation', BR: 'mist', FG: 'fog',
  FU: 'smoke', VA: 'volcanic ash', DU: 'widespread dust', SA: 'sand', HZ: 'haze', PO: 'dust/sand whirls',
  SQ: 'squalls', FC: 'funnel cloud', SS: 'sandstorm', DS: 'duststorm',
};
const AMT_WORD = {
  FEW: 'few (1–2 oktas)', SCT: 'scattered (3–4 oktas)',
  BKN: 'broken (5–7 oktas — this is a ceiling)', OVC: 'overcast (8 oktas — ceiling)',
};

function decodeWx(tok) {
  let s = tok; const parts = [];
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
    if (/^6\d{4}$/.test(tok)) return `${(+tok.slice(1) / 100).toFixed(2)}" of precipitation in the past 3 or 6 hours.`;
    if (/^5\d{4}$/.test(tok)) return 'Three-hour pressure tendency — the shape and size of the barometric change.';
    if (/^(PK|WND)$/.test(tok)) return 'Peak wind group.';
    if (/^\d{5}\d?\/\d{4}$/.test(tok)) return 'Peak wind: direction + speed / the time it occurred.';
    if (tok === '$') return 'The station itself needs maintenance.';
    if (/^LTG/.test(tok)) return 'Lightning observed (type and direction follow).';
    if (/^(TSNO|PNO|RVRNO|FZRANO)$/.test(tok)) return 'That sensor is not operating right now.';
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
    return `Wind ${dir} at ${+w[2]} knots${w[3] ? `, <b>gusting ${+w[3]} kt</b>` : ''}. METAR winds are °true — only voice reports are magnetic. Drag the picture to ${w[1] === 'VRB' ? 'any' : String(+w[1]).padStart(3, '0') + '°'} and you are looking into it.`;
  }
  if (/^\d{3}V\d{3}$/.test(tok)) return `Wind direction varying between ${+tok.slice(0, 3)}° and ${+tok.slice(4)}° true — the windsock in the scene swings across that arc.`;
  if (/^M?\d{0,2}(\s?\d\/\d{1,2})?SM$/.test(tok) || /^\d{1,2}(\/\d{1,2})?SM$/.test(tok)) {
    const less = tok.startsWith('M') ? 'less than ' : '';
    return `Visibility ${less}${esc(tok.replace(/^M/, '').replace('SM', ''))} statute miles — in the scene that is literally where the ground fades out.`;
  }
  if (/^R\d{2}[LRC]?\/.+$/.test(tok)) return 'Runway visual range (RVR) — measured visibility along that runway, in feet.';
  if (/^(FEW|SCT|BKN|OVC)\d{3}(CB|TCU)?$/.test(tok)) {
    const g = tok.match(/^(FEW|SCT|BKN|OVC)(\d{3})(CB|TCU)?$/);
    const extra = g[3] === 'CB' ? ' — cumulonimbus (thunderstorm cloud)!' : g[3] === 'TCU' ? ' — towering cumulus (building convection).' : '.';
    return `${AMT_WORD[g[1]]} clouds at ${(+g[2] * 100).toLocaleString()} ft AGL${extra} Pitch the view up and that deck is drawn at exactly that height.`;
  }
  if (/^VV\d{3}$/.test(tok)) return `Sky obscured — vertical visibility ${(+tok.slice(2) * 100).toLocaleString()} ft. This IS a ceiling.`;
  if (tok === 'CLR') return 'Sky clear below 12,000 ft (automated stations cannot see higher).';
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

/* ============================ phrasing =================================== */

function stationOf(id) { return STATIONS.find((a) => a.id === id) || HOME; }

function fmtVisSM(v) {
  if (v == null) return '—';
  if (v >= 10) return '10+';
  if (Number.isInteger(v)) return String(v);
  const whole = Math.floor(v), fr = v - whole;
  const F = { 0.25: '¼', 0.5: '½', 0.75: '¾' };
  for (const k of Object.keys(F)) if (Math.abs(fr - k) < 0.03) return (whole ? whole : '') + F[k];
  return v.toFixed(1);
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

/* ============================ info rendering ============================= */

function renderInfo(c, meta) {
  const apt = stationOf(state.sel);
  $('scene-chip').style.display = 'flex';
  $('chip-icao').textContent = meta.chipLabel;
  $('chip-cat').textContent = c.cat;
  $('chip-cat').style.background = CAT_COLORS[c.cat];
  $('chip-age').textContent = meta.ageText || '';
  const hasT = c.tempC != null;
  $('scene-temp').style.display = hasT ? 'block' : 'none';
  if (hasT) {
    $('temp-big').textContent = `${round(cToF(c.tempC))}°F`;
    $('temp-sub').textContent = `dew ${c.dewC != null ? round(cToF(c.dewC)) + '°' : '—'} · ${c.tempC}/${c.dewC == null ? '—' : c.dewC} °C`;
  }

  const parts = [skyPhrase(c)];
  const wx = wxPhrase(c);
  if (wx) parts.push(wx);
  parts.push(`${fmtVisSM(c.visKnown ? c.visSM : null)} ${c.visKnown ? 'SM visibility' : 'visibility not reported'}`.trim());
  parts.push(windPhrase(c));
  const beaconDay = c.cat === 'IFR' || c.cat === 'LIFR';
  $('summary').innerHTML =
    `${meta.summaryLead} ${esc(parts.filter(Boolean).join(' · '))} — ` +
    `<span class="cat-chip" style="background:${CAT_COLORS[c.cat]}">${c.cat}</span>` +
    (beaconDay ? ' <span class="beacon-note">the beacon in the scene runs in daylight — that is the signal a field is below VFR minimums.</span>' : '');

  // raw decoder
  const rawEl = $('decode-raw');
  rawEl.innerHTML = '';
  $('tok-explain').textContent = 'Click any group above to see what it means.';
  if (c.raw) {
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
        // clicking a wind group swings the camera into the wind
        const w = tk.match(/^(\d{3})\d{2,3}(G\d{2,3})?KT$/);
        if (w) setView(+w[1], cam.pitch);
      });
      rawEl.appendChild(sp);
    });
  } else {
    rawEl.innerHTML = '<span class="faint">no raw METAR at this time — conditions are forecast (TAF prevailing + model temp/pressure)</span>';
  }

  // condition cards
  const cards = [];
  cards.push(['Wind', c.windKt ? `${c.windVrb || c.windDir == null ? 'VRB' : String(c.windDir).padStart(3, '0') + '°'} @ ${c.windKt}${c.gustKt ? '<span style="color:#f59e0b">G' + c.gustKt + '</span>' : ''} kt` : 'Calm',
    c.gustKt ? `gust factor ${c.gustKt - c.windKt} kt` : (c.windKt >= 15 ? 'windsock fully extended (rated 15 kt)' : 'directions °true')]);
  cards.push(['Visibility', `${fmtVisSM(c.visKnown ? c.visSM : null)}${c.visKnown ? ' SM' : ''}`,
    c.visSM < 1 ? 'below LIFR minimum' : c.visSM < 3 ? 'IFR visibility' : c.visSM <= 5 ? 'MVFR visibility' : 'good visibility']);
  const skyList = c.clouds.length
    ? c.clouds.map((l) => `${l.amt} ${l.baseFt.toLocaleString()} ft${l.cb ? ' ' + l.cb : ''}`).join('<br>')
    : (c.clear ? 'clear' : 'no layers reported');
  cards.push(['Sky / ceiling', c.ceil != null ? `${c.ceil.toLocaleString()} ft` : 'no ceiling', skyList]);
  if (c.tempC != null) {
    const spread = c.dewC != null ? c.tempC - c.dewC : null;
    cards.push(['Temp / dewpoint', `${round(cToF(c.tempC))}° / ${c.dewC != null ? round(cToF(c.dewC)) + '°' : '—'} F`,
      spread == null ? '' : `spread ${spread} °C · RH ${relHumidity(c.tempC, c.dewC)}%${spread <= 3 ? ' — fog risk' : ''}${c.tempC <= 0 ? ' · below freezing' : ''}`]);
  }
  if (c.altInHg != null) {
    let daTxt = '';
    if (c.tempC != null) {
      const { da } = densityAltitude(c.tempC, c.dewC, c.altInHg, apt.elevFt);
      daTxt = `density altitude ≈ ${(round(da / 50) * 50).toLocaleString()} ft (${apt.id} elev ${apt.elevFt} ft)`;
    }
    cards.push(['Altimeter', `${c.altInHg.toFixed(2)}"`, daTxt]);
  }
  cards.push(['Category', `<span class="cat-chip" style="background:${CAT_COLORS[c.cat]};font-size:14px;padding:2px 10px">${c.cat}</span>`,
    { VFR: 'ceiling > 3,000 ft and vis > 5 SM', MVFR: 'ceiling 1,000–3,000 ft or vis 3–5 SM', IFR: 'ceiling 500–999 ft or vis 1–2 SM', LIFR: 'ceiling < 500 ft or vis < 1 SM' }[c.cat]]);
  $('cond-grid').innerHTML = cards.map(([h, big, small]) =>
    `<div class="card"><h3>${h}</h3><div class="big">${big}</div><div class="small">${small || ''}</div></div>`).join('');

  renderBrief(c, apt, meta.atMs != null ? meta.atMs : null);
  updateDensity(c, meta.chipLabel, meta.atMs != null ? meta.atMs : null);
  hudDirty = true;
}

/* --------- pick what the scene shows (live obs or a preview) ------------ */

function resetTimeline() {
  stopPlay();
  state.offsetMin = 0;
  $('time-slider').value = 0;
  updateTimeBar(null, null);
}

function applyScene() {
  if (state.offsetMin) { setOffset(state.offsetMin, true); return; }
  lastScrubSig = '';
  const apt = stationOf(state.sel);
  const err = $('scene-err');
  if (state.preview) {
    active = { cond: state.preview.cond, timeMs: state.preview.timeMs, lat: apt.lat, lon: apt.lon, apt, seed: hashStr(state.preview.label) };
    err.style.display = 'none';
    $('preview-banner').style.display = 'flex';
    $('preview-label').textContent = state.preview.label;
    renderInfo(state.preview.cond, {
      chipLabel: state.preview.chip || 'preview',
      ageText: state.preview.timeMs ? fmtTime(state.preview.timeMs, { minute: undefined }) : '',
      summaryLead: `<b>${esc(state.preview.label)}:</b>`,
      atMs: state.preview.timeMs,
    });
    return;
  }
  $('preview-banner').style.display = 'none';
  const m = state.metars[apt.metarStation];
  if (!m || m.error) {
    active = { cond: sceneCond({ clear: true }), timeMs: null, lat: apt.lat, lon: apt.lon, apt, seed: hashStr(apt.id) };
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
  active = { cond, timeMs: null, lat: apt.lat, lon: apt.lon, apt, seed: hashStr(apt.id) };
  renderInfo(cond, {
    chipLabel: apt.id + (apt.metarStation !== apt.id ? ` · obs ${apt.metarStation}` : ''),
    ageText: `${ageMin(m.time)} min ago`,
    summaryLead: `<b>${esc(apt.name)}</b> right now:`,
  });
}

/* ====================== ±12 h timeline (scrub / play) ==================== */
// Past half: real archived observations. Future half: the prevailing state of
// the nearest TAF. The clock — and therefore the whole sky — always follows.

async function loadHistory(stId) {
  if (state.history[stId]) return;
  state.history[stId] = [];
  try {
    const end = new Date().toISOString();
    const start = new Date(Date.now() - HIST_MS).toISOString();
    const d = await fetchJSON(`${NWS}/stations/${stId}/observations?start=${start}&end=${end}&limit=250`);
    const arr = [];
    for (const f of d.features || []) {
      const p = f.properties;
      if (!p.rawMessage) continue;
      arr.push({ ms: +new Date(p.timestamp), m: parseMetar(p.rawMessage, p.timestamp) });
    }
    arr.sort((a, b) => a.ms - b.ms);
    state.history[stId] = arr;
  } catch (e) {
    state.history[stId] = { error: e.message };
  }
}

function timelineAt(ms) {
  const apt = stationOf(state.sel);
  const cur = state.metars[apt.metarStation];
  const curOk = cur && !cur.error;
  if (ms <= Date.now() + 15 * 60000) {
    const h = state.history[apt.metarStation];
    let best = null;
    if (Array.isArray(h)) for (const o of h) { if (o.ms <= ms + 5 * 60000) best = o; else break; }
    if (best) return { cond: sceneCond(best.m), src: `${apt.metarStation} obs ${fmtTime(best.ms)}` };
    if (curOk) return { cond: sceneCond(cur), src: `${apt.metarStation} latest obs` };
    return { cond: sceneCond({ clear: true }), src: 'no observation available' };
  }
  const tst = TAF_STATIONS[0];
  const taf = state.tafs[tst.id];
  if (taf && !taf.error) {
    let best = null;
    for (const tile of tafTiles(taf)) {
      if ((tile.ind === '' || tile.ind === 'BECMG') && tile.begin && +tile.begin <= ms) best = tile;
    }
    if (best && best.end && ms <= +best.end + 6 * 3600000) {
      const cond = injectModelMet(sceneCond(best.m), ms);
      return { cond, src: `${tst.id} TAF${cond.modelMet ? ' + model temp/pressure' : ''} (nearest TAF — ${HOME.id} has none)` };
    }
  }
  if (curOk) {
    const held = sceneCond(cur);
    const mv = modelAt(ms);
    if (mv) {
      held.tempC = round(mv.tempC * 10) / 10;
      held.dewC = mv.dewC != null ? round(mv.dewC * 10) / 10 : held.dewC;
      held.altInHg = round(mv.altInHg * 100) / 100;
      held.modelMet = true;
      return { cond: held, src: 'sky held from current obs · temp/pressure from model' };
    }
    return { cond: held, src: 'holding the current obs — no TAF or model coverage' };
  }
  return { cond: sceneCond({ clear: true }), src: 'no data' };
}

// TAFs never forecast temperature or pressure — fill those from the
// bias-corrected model so the temp chip, brief and density stay honest.
function injectModelMet(cond, ms) {
  if (cond.tempC == null || cond.altInHg == null) {
    const mv = modelAt(ms);
    if (mv) {
      if (cond.tempC == null) {
        cond.tempC = round(mv.tempC * 10) / 10;
        cond.dewC = mv.dewC != null ? round(mv.dewC * 10) / 10 : null;
      }
      if (cond.altInHg == null) cond.altInHg = round(mv.altInHg * 100) / 100;
      cond.modelMet = true;
    }
  }
  return cond;
}

function fmtOffset(min) {
  const a = Math.abs(round(min));
  return `${min < 0 ? '−' : '+'}${Math.floor(a / 60)}h${String(a % 60).padStart(2, '0')}m`;
}

let lastScrubSig = '';

function setOffset(min, fromPlay) {
  min = clamp(min, -720, 720);
  state.offsetMin = min;
  $('time-slider').value = round(min);
  if (!fromPlay && Math.abs(min) < 3) {
    state.offsetMin = 0;
    $('time-slider').value = 0;
    stopPlay();
    updateTimeBar(null, null);
    applyScene();
    return;
  }
  if (state.preview) {
    state.preview = null;
    $('preview-banner').style.display = 'none';
    document.querySelectorAll('.taf-tile.sel').forEach((x) => x.classList.remove('sel'));
  }
  const ms = Date.now() + min * 60000;
  const tl = timelineAt(ms);
  const apt = stationOf(state.sel);
  active = { cond: tl.cond, timeMs: ms, lat: apt.lat, lon: apt.lon, apt, seed: hashStr(apt.id) };
  $('scene-err').style.display = 'none';
  // full panel re-render is throttled to 15-min buckets so the play sweep
  // does not thrash the DOM every frame
  const sig = `${state.sel}|${tl.src}|${Math.floor(ms / 900000)}`;
  if (sig !== lastScrubSig) {
    lastScrubSig = sig;
    renderInfo(tl.cond, {
      chipLabel: apt.id,
      ageText: `${fmtOffset(min)} · ${fmtTime(ms)}`,
      summaryLead: `<b>${esc(apt.name)} at ${fmtTime(ms)} (${fmtOffset(min)}):</b>`,
      atMs: ms,
    });
  } else {
    $('chip-age').textContent = `${fmtOffset(min)} · ${fmtTime(ms)}`;
    drawDensChart(ms);
    drawRibbon(ms);
  }
  updateTimeBar(tl.src, ms);
  drawRibbon(ms);
  hudDirty = true;
}

function updateTimeBar(src, ms) {
  const off = state.offsetMin;
  $('time-label').innerHTML = off === 0 ? '<b>now</b>' : `<b>${fmtOffset(off)}</b> · ${fmtTime(ms)}`;
  $('time-src').textContent = off === 0 ? '' : src || '';
  $('time-now-btn').style.display = off === 0 ? 'none' : 'inline-block';
}

/* -------- play: sweep −12 h → +12 h -------- */

const PLAY_RATE = 75;   // simulated minutes per real second (~19 s full sweep)
let playLast = 0;

function stepPlay(ts) {
  if (!state.playing) return;
  const dt = Math.min(0.1, (ts - playLast) / 1000);
  playLast = ts;
  const m = state.offsetMin + PLAY_RATE * dt;
  if (m >= 720) { setOffset(720, true); stopPlay(); return; }
  setOffset(m, true);
  requestAnimationFrame(stepPlay);
}
function startPlay() {
  if (state.playing) return;
  state.playing = true;
  $('play-btn').textContent = '⏸ Pause';
  if (state.offsetMin === 0 || state.offsetMin >= 715) setOffset(-720, true);
  playLast = performance.now();
  requestAnimationFrame(stepPlay);
}
function stopPlay() {
  state.playing = false;
  $('play-btn').textContent = '▶ Play';
}

/* ------------------- flight-category ribbon (±12 h) --------------------- */

function buildRibbon() {
  const apt = stationOf(state.sel);
  const out = [];
  for (let min = -720; min <= 720; min += 15) {
    const ms = Date.now() + min * 60000;
    const tl = timelineAt(ms);
    out.push({
      min, ms, cat: tl.cond.cat,
      obs: /obs/.test(tl.src),
      night: ephemerisAt(ms, apt.lat, apt.lon).sun.alt < -0.833,
      ceil: tl.cond.ceil, vis: tl.cond.visKnown ? tl.cond.visSM : null,
    });
  }
  state.ribbon = out;
}

function drawRibbon(cursorMs) {
  const cv = $('cat-ribbon');
  if (!cv) return;
  const r = cv.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (cv.width !== round(r.width * dpr)) { cv.width = round(r.width * dpr); cv.height = round(r.height * dpr); }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = r.width, H = r.height;
  ctx.clearRect(0, 0, W, H);
  const S = state.ribbon;
  ctx.font = '10px "Segoe UI", system-ui, sans-serif';
  if (!S || !S.length) return;
  const x = (min) => ((min + 720) / 1440) * W;
  const barTop = 13, barH = 16;
  for (let i = 0; i < S.length - 1; i++) {
    const x0 = x(S[i].min), x1 = x(S[i + 1].min) + 0.6;
    ctx.fillStyle = CAT_COLORS[S[i].cat] || '#444';
    ctx.globalAlpha = S[i].obs ? 1 : 0.55;
    ctx.fillRect(x0, barTop, x1 - x0, barH);
    ctx.globalAlpha = 1;
    if (S[i].night) {   // night shading beneath the bar
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(x0, barTop + barH, x1 - x0, 4);
    }
  }
  ctx.strokeStyle = '#333';
  ctx.strokeRect(0.5, barTop + 0.5, W - 1, barH);
  // hour ticks
  ctx.textAlign = 'center';
  const tickStep = W < 420 ? 360 : W < 640 ? 240 : 180;   // keep labels apart
  for (let min = -720; min <= 720; min += tickStep) {
    ctx.fillStyle = '#555';
    ctx.fillText(min === 0 ? 'now' : fmtTime(Date.now() + min * 60000, { minute: undefined }).replace(' ', ''),
      clamp(x(min), 18, W - 18), barTop + barH + 15);
    ctx.strokeStyle = min === 0 ? '#888' : '#2e2e2e';
    ctx.beginPath(); ctx.moveTo(x(min), barTop); ctx.lineTo(x(min), barTop + barH + 5); ctx.stroke();
  }
  if (W > 420) {
    ctx.textAlign = 'right';
    ctx.fillStyle = '#4a5566';
    ctx.fillText('solid = observed · faded = forecast', W - 2, barTop - 2);
  }
  const cm = cursorMs == null ? (state.offsetMin || null) : (cursorMs - Date.now()) / 60000;
  if (cm != null) {
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x(cm), barTop - 3); ctx.lineTo(x(cm), barTop + barH + 6); ctx.stroke();
    ctx.lineWidth = 1;
  }
}

/* ===================== air density module ================================ */

const DENS_BASE = 130;   // dots in the ISA chamber
const DENS_AMP = 12;     // dramatisation factor for the count difference

const dens = {
  canvas: null, ctx: null, W: 0, H: 0, needResize: true,
  chart: null, chartCtx: null,
  parts: [[], []],
  target: [DENS_BASE, DENS_BASE],
  tempsK: [288.15, 288.15],
  hotC: [15, 15],
  labelRight: 'RIGHT NOW (dramatised)',
  last: 0,
};

async function loadModel(apt) {
  if (state.model[apt.id] && !state.model[apt.id].error) return;
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${apt.lat}&longitude=${apt.lon}` +
      '&hourly=temperature_2m,dew_point_2m,pressure_msl&past_days=1&forecast_days=2' +
      '&timeformat=unixtime&timezone=UTC';
    const d = await fetchJSON(url);
    state.model[apt.id] = { t: d.hourly.time, temp: d.hourly.temperature_2m, dew: d.hourly.dew_point_2m, pmsl: d.hourly.pressure_msl };
  } catch (e) {
    state.model[apt.id] = { error: e.message };
  }
}

function rawModelAt(ms) {
  const mo = state.model[stationOf(state.sel).id];
  if (!mo || mo.error) return null;
  const s = ms / 1000;
  let i = -1;
  for (let k = 0; k < mo.t.length - 1; k++) { if (mo.t[k] <= s && s <= mo.t[k + 1]) { i = k; break; } }
  if (i < 0) return null;
  const f = (s - mo.t[i]) / (mo.t[i + 1] - mo.t[i]);
  const L = (a) => (a[i] == null || a[i + 1] == null) ? null : a[i] + (a[i + 1] - a[i]) * f;
  const temp = L(mo.temp), pmsl = L(mo.pmsl);
  if (temp == null || pmsl == null) return null;
  return { tempC: temp, dewC: L(mo.dew), altInHg: pmsl * 0.02953 };
}

function modelAt(ms) {
  const v = rawModelAt(ms);
  if (!v) return null;
  const decay = Math.max(0, 1 - Math.abs(ms - Date.now()) / (10 * 3600000));
  const b = state.modelBias;
  v.tempC += b.tb * decay;
  if (v.dewC != null) v.dewC = Math.min(v.dewC + b.db * decay, v.tempC);
  v.altInHg += b.ab * decay;
  return v;
}

function densAt(ms) {
  const apt = stationOf(state.sel);
  let tempC = null, dewC = null, alt = null, src = null;
  if (ms <= Date.now() + 20 * 60000) {
    const h = state.history[apt.metarStation];
    let best = null;
    if (Array.isArray(h)) {
      for (const o of h) {
        if (o.m.tempC == null || o.m.altInHg == null) continue;
        if (Math.abs(o.ms - ms) <= 75 * 60000 && (!best || Math.abs(o.ms - ms) < Math.abs(best.ms - ms))) best = o;
      }
    }
    const cur = state.metars[apt.metarStation];
    if (cur && !cur.error && cur.tempC != null && cur.altInHg != null &&
        Math.abs(+new Date(cur.time) - ms) <= 75 * 60000 &&
        (!best || Math.abs(+new Date(cur.time) - ms) < Math.abs(best.ms - ms))) {
      best = { ms: +new Date(cur.time), m: cur };
    }
    if (best) { tempC = best.m.tempC; dewC = best.m.dewC; alt = best.m.altInHg; src = 'obs'; }
  }
  if (src == null) {
    const mv = modelAt(ms);
    if (mv) { tempC = mv.tempC; dewC = mv.dewC; alt = mv.altInHg; src = 'model'; }
  }
  if (src == null) {
    const cur = state.metars[apt.metarStation];
    if (cur && !cur.error && cur.tempC != null && cur.altInHg != null) {
      tempC = cur.tempC; dewC = cur.dewC; alt = cur.altInHg; src = 'held';
    } else return null;
  }
  const { rho } = airDensity(tempC, dewC, alt, apt.elevFt);
  const { da, pa } = densityAltitude(tempC, dewC, alt, apt.elevFt);
  return { tempC, dewC, altInHg: alt, rho, ratio: rho / 1.225, pa, da, src };
}

function buildDensSeries() {
  const apt = stationOf(state.sel);
  const cur = state.metars[apt.metarStation];
  state.modelBias = { tb: 0, db: 0, ab: 0 };
  if (cur && !cur.error && cur.tempC != null) {
    const mv = rawModelAt(+new Date(cur.time));
    if (mv) {
      const cl = (v) => clamp(v, -5, 5);
      state.modelBias.tb = cl(cur.tempC - mv.tempC);
      if (cur.dewC != null && mv.dewC != null) state.modelBias.db = cl(cur.dewC - mv.dewC);
      if (cur.altInHg != null) state.modelBias.ab = clamp(cur.altInHg - mv.altInHg, -0.12, 0.12);
    }
  }
  const now = Date.now();
  const pts = [];
  for (let min = -720; min <= 720; min += 30) {
    const ms = now + min * 60000;
    const d = densAt(ms);
    if (!d) continue;
    pts.push({ min, ms, da: d.da, rho: d.rho, ratio: d.ratio, src: d.src,
      night: ephemerisAt(ms, apt.lat, apt.lon).sun.alt < -0.833 });
  }
  state.densSeries = pts.length ? pts : null;
}

function drawDensChart(cursorMs) {
  const cv = dens.chart;
  if (!cv) return;
  const r = cv.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (cv.width !== round(r.width * dpr)) { cv.width = round(r.width * dpr); cv.height = round(r.height * dpr); }
  const ctx = dens.chartCtx;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = r.width, H = r.height;
  ctx.clearRect(0, 0, W, H);
  ctx.font = '10px "Segoe UI", system-ui, sans-serif';
  const S = state.densSeries;
  if (!S || S.length < 2) {
    ctx.fillStyle = '#555'; ctx.textAlign = 'center';
    ctx.fillText('density trend unavailable — waiting for data', W / 2, H / 2);
    return;
  }
  const L = 40, R = 8, T = 12, B = 18;
  const das = S.map((p) => p.da);
  const lo = Math.min(0, Math.floor(Math.min(...das) / 500) * 500);
  const hi = Math.max(3200, Math.ceil(Math.max(...das) / 500) * 500 + 300);
  const x = (min) => L + ((min + 720) / 1440) * (W - L - R);
  const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);

  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  for (let i = 0; i < S.length - 1; i++) {
    if (S[i].night) ctx.fillRect(x(S[i].min), T, x(S[i + 1].min) - x(S[i].min) + 0.5, H - T - B);
  }
  if (y(3000) > T) {
    ctx.fillStyle = 'rgba(245,158,11,0.07)';
    ctx.fillRect(L, T, W - L - R, Math.max(0, y(3000) - T));
    ctx.strokeStyle = 'rgba(245,158,11,0.45)'; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(L, y(3000)); ctx.lineTo(W - R, y(3000)); ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.textAlign = 'right';
  for (let v = lo; v <= hi; v += 1000) {
    ctx.strokeStyle = '#252525';
    ctx.beginPath(); ctx.moveTo(L, y(v)); ctx.lineTo(W - R, y(v)); ctx.stroke();
    ctx.fillStyle = '#555';
    ctx.fillText(v === 0 ? '0' : (v / 1000) + 'k', L - 5, y(v) + 3);
  }
  ctx.textAlign = 'center';
  for (let min = -720; min <= 720; min += 180) {
    ctx.fillStyle = '#555';
    ctx.fillText(min === 0 ? 'now' : fmtTime(Date.now() + min * 60000, { minute: undefined }).replace(' ', ''), x(min), H - 4);
  }
  for (let i = 0; i < S.length - 1; i++) {
    const modeled = S[i].src !== 'obs' || S[i + 1].src !== 'obs';
    ctx.strokeStyle = modeled ? '#f0c040' : '#4a9eff';
    ctx.setLineDash(modeled ? [5, 4] : []);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x(S[i].min), y(S[i].da));
    ctx.lineTo(x(S[i + 1].min), y(S[i + 1].da));
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.strokeStyle = '#666'; ctx.setLineDash([3, 4]);
  ctx.beginPath(); ctx.moveTo(x(0), T); ctx.lineTo(x(0), H - B); ctx.stroke();
  ctx.setLineDash([]);
  let pk = S[0];
  for (const p of S) if (p.da > pk.da) pk = p;
  ctx.fillStyle = '#f59e0b';
  ctx.beginPath(); ctx.arc(x(pk.min), y(pk.da), 3, 0, 7); ctx.fill();
  ctx.textAlign = pk.min > 400 ? 'right' : 'left';
  ctx.fillText(`peak ${(round(pk.da / 50) * 50).toLocaleString()} ft`, x(pk.min) + (pk.min > 400 ? -7 : 7), y(pk.da) - 6);
  const cMin = cursorMs == null ? null : (cursorMs - Date.now()) / 60000;
  if (cMin != null && cMin >= -720 && cMin <= 720) {
    let yc = null;
    for (let i = 0; i < S.length - 1; i++) {
      if (S[i].min <= cMin && cMin <= S[i + 1].min) {
        yc = y(lerp(S[i].da, S[i + 1].da, (cMin - S[i].min) / (S[i + 1].min - S[i].min)));
        break;
      }
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.beginPath(); ctx.moveTo(x(cMin), T); ctx.lineTo(x(cMin), H - B); ctx.stroke();
    if (yc != null) { ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(x(cMin), yc, 4, 0, 7); ctx.fill(); }
  }
  ctx.textAlign = 'left';
  ctx.fillStyle = '#4a9eff'; ctx.fillText('— observed', L + 4, T + 2);
  ctx.fillStyle = '#f0c040'; ctx.fillText('- - model (obs-corrected)', L + 78, T + 2);
}

const DENS_SRC_WORD = {
  obs: 'from the actual observation',
  model: 'model forecast, corrected to the latest obs',
  held: 'holding the latest obs (no model data)',
};

function updateDensity(cond, srcLabel, ms) {
  const read = $('dens-read');
  if (!read) return;
  const apt = stationOf(state.sel);
  const atMs = ms == null ? Date.now() : ms;
  let vals = null, srcWord = null;
  if (cond && cond.tempC != null && cond.altInHg != null && !cond.modelMet) {
    vals = { tempC: cond.tempC, dewC: cond.dewC, altInHg: cond.altInHg };
    srcWord = cond.raw ? 'from the actual observation' : 'from the conditions shown';
  } else {
    const d = densAt(atMs);
    if (d) { vals = d; srcWord = DENS_SRC_WORD[d.src]; }
  }
  if (!vals) {
    read.innerHTML = '<div class="kv"><span class="k">air density</span><span class="v">no data yet</span></div>';
    dens.target = [DENS_BASE, DENS_BASE];
    dens.tempsK = [288.15, 288.15];
    dens.hotC = [15, 15];
    drawDensChart(ms);
    return;
  }
  const { rho } = airDensity(vals.tempC, vals.dewC, vals.altInHg, apt.elevFt);
  const { da: daRaw, pa } = densityAltitude(vals.tempC, vals.dewC, vals.altInHg, apt.elevFt);
  const ratio = rho / 1.225;
  const da = round(daRaw / 50) * 50;
  dens.target = [DENS_BASE, round(DENS_BASE * clamp(1 + (ratio - 1) * DENS_AMP, 0.1, 2.2))];
  dens.tempsK = [288.15, vals.tempC + 273.15];
  dens.hotC = [15, vals.tempC];
  dens.labelRight = (state.offsetMin && ms != null)
    ? `AT ${fmtTime(ms).toUpperCase()} (DRAMATISED)` : 'RIGHT NOW (DRAMATISED)';

  const daCol = da <= 1500 ? '#22c55e' : da <= 3000 ? '#f0c040' : da <= 4500 ? '#f59e0b' : '#ef4444';
  const nowD = densAt(Date.now());
  let deltaRow = '';
  if (state.offsetMin && nowD) {
    const dd = round((da - nowD.da) / 50) * 50;
    const col = dd > 0 ? '#f59e0b' : '#22c55e';
    deltaRow = `<div class="kv"><span class="k">vs right now</span><span class="v" style="color:${col}">${dd > 0 ? '+' : ''}${dd.toLocaleString()} ft ${dd > 0 ? '(worse)' : dd < 0 ? '(better)' : ''}</span></div>`;
  }
  let peakRow = '';
  const S = state.densSeries;
  if (S) {
    let pk = null;
    for (const p of S) if (p.min >= 0 && (!pk || p.da > pk.da)) pk = p;
    if (pk) peakRow = `<div class="kv"><span class="k">next 12 h peak</span><span class="v">${(round(pk.da / 50) * 50).toLocaleString()} ft · ${fmtTime(pk.ms, { minute: undefined })}</span></div>`;
  }
  read.innerHTML = `
    <div class="dens-big" style="color:${daCol}">${da.toLocaleString()}<span> ft DA</span></div>
    <div class="kv"><span class="k">air density</span><span class="v">${rho.toFixed(3)} kg/m³ · ${(ratio * 100).toFixed(1)}% of std</span></div>
    ${deltaRow}
    <div class="kv"><span class="k">pressure altitude</span><span class="v">${round(pa).toLocaleString()} ft</span></div>
    ${peakRow}
    <div class="kv"><span class="k">source</span><span class="v" style="color:#667">${esc(srcWord || '')}</span></div>`;
  drawDensChart(ms);
}

function densResize() {
  const r = dens.canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  dens.canvas.width = Math.max(1, round(r.width * dpr));
  dens.canvas.height = Math.max(1, round(r.height * dpr));
  dens.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  dens.W = r.width; dens.H = r.height;
  dens.needResize = false;
}

function densFrame(now) {
  if (!dens.canvas) return;
  if (dens.needResize) densResize();
  const { ctx, W, H } = dens;
  if (!W) return;
  const dt = Math.min(0.05, (now - dens.last) / 1000 || 0.016);
  dens.last = now;
  const gap = 14, cw = (W - gap) / 2, top = 22, ch = H - top - 20;
  ctx.clearRect(0, 0, W, H);
  ctx.font = '10px "Segoe UI", system-ui, sans-serif';
  const labels = ['STANDARD DAY — ISA SEA LEVEL', dens.labelRight];
  for (let k = 0; k < 2; k++) {
    const x0 = k * (cw + gap);
    ctx.fillStyle = '#10141b';
    ctx.strokeStyle = '#333';
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x0, top, cw, ch, 6); else ctx.rect(x0, top, cw, ch);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#889';
    ctx.textAlign = 'left';
    ctx.fillText(labels[k], x0 + 2, 13);
    const P = dens.parts[k];
    if (P.length < dens.target[k] && Math.random() < 0.5) {
      const a = Math.random() * Math.PI * 2;
      P.push({ x: x0 + 6 + Math.random() * (cw - 12), y: top + 6 + Math.random() * (ch - 12), vx: Math.cos(a), vy: Math.sin(a) });
    } else if (P.length > dens.target[k]) P.splice(0, Math.min(2, P.length - dens.target[k]));
    const hot = clamp((dens.hotC[k] + 5) / 40, 0, 1);
    ctx.fillStyle = css(mixC([122, 168, 216], [235, 140, 74], hot), 0.92);
    const spd = 26 * Math.sqrt(dens.tempsK[k] / 288.15) * (0.7 + 0.3 * hot + (dens.hotC[k] > 25 ? 0.35 : 0));
    for (const p of P) {
      p.vx += (Math.random() - 0.5) * 0.35; p.vy += (Math.random() - 0.5) * 0.35;
      const v = Math.hypot(p.vx, p.vy) || 1;
      p.vx /= v; p.vy /= v;
      p.x += p.vx * spd * dt; p.y += p.vy * spd * dt;
      if (p.x < x0 + 4) { p.x = x0 + 4; p.vx = Math.abs(p.vx); }
      if (p.x > x0 + cw - 4) { p.x = x0 + cw - 4; p.vx = -Math.abs(p.vx); }
      if (p.y < top + 4) { p.y = top + 4; p.vy = Math.abs(p.vy); }
      if (p.y > top + ch - 4) { p.y = top + ch - 4; p.vy = -Math.abs(p.vy); }
      ctx.beginPath(); ctx.arc(p.x, p.y, 2.1, 0, 7); ctx.fill();
    }
    ctx.fillStyle = '#667';
    ctx.textAlign = 'right';
    ctx.fillText(`${P.length} dots`, x0 + cw - 4, top + ch + 14);
  }
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

// NWS TAF visibility is metres from a fixed SM table — decode via the table,
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
    if (p.wx.length) patch.wx = wxReal;
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
  const apt = stationOf(state.sel);
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
    for (const tile of tafTiles(t)) {
      const cond = sceneCond(tile.m);
      const el = document.createElement('div');
      el.className = 'taf-tile';
      const cv = document.createElement('canvas');
      cv.width = 312; cv.height = 176;
      el.appendChild(cv);
      const midMs = tile.begin ? Math.min(+tile.begin + 1.5 * 3600000, (+tile.begin + +tile.end) / 2) : Date.now();
      const cctx = cv.getContext('2d');
      cctx.setTransform(2, 0, 0, 2, 0, 0);
      cctx.__dpr = 2;
      cctx.imageSmoothingEnabled = true;
      const tcam = { hdg: cam.hdg, pitch: 12, fov: 105 };
      drawScene(cctx, 156, 88, cond, ephemerisAt(midMs, apt.lat, apt.lon),
        60 + hashStr(st.id) % 50, hashStr(st.id + tile.ind + (tile.begin || '')), tcam, apt, 2);
      const when = tile.begin ? `${fmtTime(tile.begin, { minute: undefined })}–${fmtTime(tile.end, { minute: undefined })}` : '';
      const info = document.createElement('div');
      info.innerHTML = `<div class="when"><span class="catdot" style="background:${CAT_COLORS[cond.cat]}"></span>` +
        `${tile.ind ? `<span class="ind">${tile.ind}</span>` : ''}<span>${when}</span></div>` +
        `<div class="what">${esc(fmtTafShort(tile.m))}</div>`;
      el.appendChild(info);
      el.addEventListener('click', () => {
        resetTimeline();
        document.querySelectorAll('.taf-tile.sel').forEach((x) => x.classList.remove('sel'));
        el.classList.add('sel');
        state.preview = {
          cond, timeMs: midMs, chip: `${st.id} TAF`,
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
  // Pasted METARs are always drawn at (and scored against) the selected
  // field, so keep the examples at plausible elevations for it.
  ['hot & humid', 'KANP 041953Z 22007KT 10SM SCT060 37/24 A2985'],
  ['ragged low deck', 'KANP 041154Z 09006KT 3SM BR OVC004 14/14 A3001'],
  ['crosswind drill', 'KANP 021853Z 20018G26KT 10SM SCT045 18/06 A2998'],
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
  resetTimeline();
  document.querySelectorAll('.taf-tile.sel').forEach((x) => x.classList.remove('sel'));
  const id = raw.split(/\s+/)[0];
  state.preview = {
    cond: sceneCond(m), timeMs: null,
    chip: /^[A-Z]{4}$/.test(id) ? `${id} (pasted)` : 'pasted METAR',
    label: `pasted METAR${/^[A-Z]{4}$/.test(id) ? ' · ' + id : ''}`,
  };
  applyScene();
  $('scene-wrap').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* ============================ tabs & presets ============================= */

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
      renderPresets();
      Promise.all([loadHistory(a.metarStation), loadModel(a)]).then(() => {
        buildDensSeries();
        buildRibbon();
        lastScrubSig = '';
        if (state.offsetMin) setOffset(state.offsetMin, true); else applyScene();
        drawRibbon(null);
      });
      applyScene();
    });
    wrap.appendChild(b);
  }
}

function renderPresets() {
  const wrap = $('view-presets');
  if (!wrap) return;
  const apt = stationOf(state.sel);
  wrap.innerHTML = '';
  const add = (label, fn, title) => {
    const b = document.createElement('button');
    b.textContent = label;
    if (title) b.title = title;
    b.addEventListener('click', fn);
    wrap.appendChild(b);
  };
  for (const r of (apt.runways || [])) {
    for (const e of r.ends) {
      add(`RWY ${e.name}`, () => setView(e.hdg, 10), `look down runway ${e.name} (${e.hdg}°T)`);
    }
  }
  add('☀ sun', () => {
    const eph = ephemerisAt(active && active.timeMs || Date.now(), apt.lat, apt.lon);
    setView(eph.sun.az, clamp(eph.sun.alt, -6, 78));
  }, 'point the camera at the sun');
  add('☾ moon', () => {
    const eph = ephemerisAt(active && active.timeMs || Date.now(), apt.lat, apt.lon);
    setView(eph.moon.az, clamp(eph.moon.alt, -6, 78));
  }, 'point the camera at the moon');
  add('⇢ wind', () => {
    const c = active && active.cond;
    if (c && c.windDir != null) setView(c.windDir, 8);
  }, 'look into the wind');
  add('↑ zenith', () => setView(cam.hdg, 78), 'look straight up at the deck');
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
  const apt = stationOf(state.sel);
  delete state.history[apt.metarStation];
  delete state.model[apt.id];
  await Promise.all([loadMetars(), loadTafs(), loadHistory(apt.metarStation), loadModel(apt)]);
  buildDensSeries();
  if (!state.preview) applyScene();
  buildRibbon();
  drawRibbon(null);
  renderTafs();
  $('update-time').textContent = `updated ${fmtTime(Date.now())}`;
}

document.addEventListener('DOMContentLoaded', () => {
  // start looking down the runway that the wind (once we have it) will favour
  const rw0 = (HOME.runways || [])[0];
  if (rw0) cam.hdg = rw0.ends[0].hdg;

  renderTabs();
  renderPresets();
  resizeScene();
  bindLook();
  applyScene();
  loadAll().then(() => {
    // once the wind is known, face the favoured end and lift the nose enough
    // to put the sun (or the deck) in frame
    const apt = stationOf(state.sel);
    const c = active && active.cond;
    if (c) {
      const L = fieldLayout(apt, c);
      const eph = ephemerisAt(Date.now(), apt.lat, apt.lon);
      setView(L.hdg, clamp(eph.sun.alt > 2 ? eph.sun.alt * 0.4 : 8, 5, 26));
    }
  });
  setInterval(loadAll, REFRESH_MS);
  setInterval(() => {
    if (state.preview || state.offsetMin) return;
    const m = state.metars[stationOf(state.sel).metarStation];
    if (m && !m.error) $('chip-age').textContent = `${ageMin(m.time)} min ago`;
  }, 30000);

  dens.canvas = $('dens-canvas');
  dens.ctx = dens.canvas.getContext('2d');
  new ResizeObserver(() => { dens.needResize = true; }).observe(dens.canvas);
  dens.chart = $('dens-chart');
  dens.chartCtx = dens.chart.getContext('2d');
  const chartScrub = (ev) => {
    const r = dens.chart.getBoundingClientRect();
    const f = clamp((ev.clientX - r.left - 40) / (r.width - 48), 0, 1);
    stopPlay();
    setOffset(round((f * 1440 - 720) / 5) * 5);
  };
  let chartDrag = false;
  dens.chart.addEventListener('pointerdown', (e) => { chartDrag = true; dens.chart.setPointerCapture(e.pointerId); chartScrub(e); });
  dens.chart.addEventListener('pointermove', (e) => { if (chartDrag) chartScrub(e); });
  dens.chart.addEventListener('pointerup', () => { chartDrag = false; });
  drawDensChart(null);

  const ribbon = $('cat-ribbon');
  const ribScrub = (ev) => {
    const r = ribbon.getBoundingClientRect();
    const f = clamp((ev.clientX - r.left) / r.width, 0, 1);
    stopPlay();
    setOffset(round((f * 1440 - 720) / 5) * 5);
  };
  let ribDrag = false;
  ribbon.addEventListener('pointerdown', (e) => { ribDrag = true; ribbon.setPointerCapture(e.pointerId); ribScrub(e); });
  ribbon.addEventListener('pointermove', (e) => { if (ribDrag) ribScrub(e); });
  ribbon.addEventListener('pointerup', () => { ribDrag = false; });
  window.addEventListener('resize', () => { drawRibbon(state.offsetMin ? Date.now() + state.offsetMin * 60000 : null); });

  $('time-slider').addEventListener('input', () => { stopPlay(); setOffset(+$('time-slider').value); });
  $('play-btn').addEventListener('click', () => (state.playing ? stopPlay() : startPlay()));
  $('time-now-btn').addEventListener('click', () => { stopPlay(); setOffset(0); });
  $('refresh-btn').addEventListener('click', loadAll);
  $('labels-chk').addEventListener('change', (e) => { state.labels = e.target.checked; });
  $('preview-off').addEventListener('click', () => {
    state.preview = null;
    document.querySelectorAll('.taf-tile.sel').forEach((x) => x.classList.remove('sel'));
    resetTimeline();
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
  // arrow keys pan too — nice on a laptop
  window.addEventListener('keydown', (e) => {
    if (/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) return;
    const s = e.shiftKey ? 15 : 5;
    if (e.key === 'ArrowLeft') setView(cam.hdg - s, cam.pitch);
    else if (e.key === 'ArrowRight') setView(cam.hdg + s, cam.pitch);
    else if (e.key === 'ArrowUp') setView(cam.hdg, cam.pitch + s);
    else if (e.key === 'ArrowDown') setView(cam.hdg, cam.pitch - s);
    else return;
    e.preventDefault();
  });

  // debug hook — renderNow() paints one frame without the rAF loop, which is
  // how the scene gets verified in a headless/background tab
  window.__sky2 = {
    state, cam, setView, ephemerisAt, drawScene, sceneCond, parseMetar,
    get active() { return active; },
    renderNow(t) {
      needResize = true; resizeScene();
      if (!active) return false;
      const ms = active.timeMs || Date.now();
      drawScene(sceneCtx, sceneW, sceneH, active.cond, ephemerisAt(ms, active.lat, active.lon),
        t == null ? performance.now() / 1000 : t, active.seed, cam, active.apt, quality);
      updateHud(ephemerisAt(ms, active.lat, active.lon));
      return true;
    },
  };
});
})();
