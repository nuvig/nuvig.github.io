/* ===========================================================================
   Air Lab — interactive atmosphere / density-altitude / airspeed simulations.
   Plain canvas, no dependencies. Educational only.

   Sections:
     1. Atmosphere column (pressure / temperature / density vs altitude)
     2. Pressure altitude & density altitude explorer (NWS method, humidity)
     3. Parcel-of-air stability simulator (animated)
     4. IAS → TAS → GS (TAS-vs-altitude chart + wind triangle)
   =========================================================================== */
'use strict';

/* ============================ atmosphere math ============================ */

const ISA = {
  T0K: 288.15,        // sea-level standard temp, K
  P0: 1013.25,        // sea-level standard pressure, hPa
  RHO0: 1.225,        // sea-level standard density, kg/m³
  LAPSE: 1.9812,      // standard lapse, °C per 1,000 ft
  TROP: 36089,        // tropopause, ft
};

function isaTempC(ft) {
  return ft < ISA.TROP ? 15 - ISA.LAPSE * ft / 1000 : -56.5;
}
function isaPresHpa(ft) {
  if (ft < ISA.TROP) return ISA.P0 * Math.pow(1 - 6.87559e-6 * ft, 5.2559);
  return 226.32 * Math.exp(-(ft - ISA.TROP) / 20806);
}
// density of (possibly moist) air. p = total pressure hPa, tC = temp °C,
// e = water-vapor partial pressure hPa
function airDensity(pHpa, tC, eHpa = 0) {
  const T = tC + 273.15;
  return (100 * (pHpa - eHpa)) / (287.05 * T) + (100 * eHpa) / (461.495 * T);
}
// Tetens saturation vapor pressure, hPa (over water)
function vaporPresHpa(tdC) {
  return 6.1078 * Math.pow(10, (7.5 * tdC) / (tdC + 237.3));
}
// pressure altitude from field elevation + altimeter setting (exact form)
function pressureAltFt(elevFt, qnhInHg) {
  return elevFt + 145366.45 * (1 - Math.pow(qnhInHg / 29.92126, 0.190284));
}
// station pressure (inHg) from altimeter setting + elevation (NWS)
function stationPresInHg(qnhInHg, elevFt) {
  const k = 0.190284;
  return Math.pow(Math.pow(qnhInHg, k) - 1.313e-5 * elevFt, 1 / k);
}
// density altitude from actual density (NWS)
function densityAltFt(rho) {
  return 145442.16 * (1 - Math.pow(rho / ISA.RHO0, 0.234969));
}
// density ratio σ at a given density altitude (ISA density profile)
function sigmaAtDa(daFt) {
  return Math.pow(1 - 6.87559e-6 * daFt, 4.2559);
}

const cToF = (c) => c * 9 / 5 + 32;
const fToC = (f) => (f - 32) * 5 / 9;
const fmt0 = (n) => Math.round(n).toLocaleString('en-US');
const fmt1 = (n) => n.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const rad = (d) => d * Math.PI / 180;
const norm360 = (d) => ((d % 360) + 360) % 360;

/* =============================== canvas kit ============================== */

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

function gridH(ctx, y, L, W, R, label) {
  ctx.strokeStyle = '#252525';
  ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(W - R, y); ctx.stroke();
  if (label != null) {
    ctx.fillStyle = '#555'; ctx.textAlign = 'right';
    ctx.fillText(label, L - 6, y + 3);
  }
}

// generic pointer-drag helper: calls fn(x, y) in CSS px on down + move
function onDrag(canvas, fn, endFn) {
  let active = false;
  canvas.addEventListener('pointerdown', (e) => {
    active = true;
    canvas.setPointerCapture(e.pointerId);
    const r = canvas.getBoundingClientRect();
    fn(e.clientX - r.left, e.clientY - r.top, true);
    e.preventDefault();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!active) return;
    const r = canvas.getBoundingClientRect();
    fn(e.clientX - r.left, e.clientY - r.top, false);
  });
  const up = (e) => {
    if (active && endFn) endFn();
    active = false;
  };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
}

const $ = (id) => document.getElementById(id);

// slider + formatted value label + change hook
function bindSlider(id, fmtFn, onChange) {
  const el = $(id), lbl = $(id + '-val');
  const update = () => { lbl.innerHTML = fmtFn(parseFloat(el.value)); };
  el.addEventListener('input', () => { update(); onChange(parseFloat(el.value)); });
  update();
  return el;
}

/* ========================================================================
   1. ATMOSPHERE COLUMN
   ======================================================================== */

const col = { alt: 5500, slTempC: 15, qnh: 29.92, TOP: 40000 };

// the day's profiles: temp follows the standard lapse from the chosen
// sea-level temp; pressure scales the ISA profile to the altimeter setting.
function colTempC(ft) {
  return Math.max(col.slTempC - ISA.LAPSE * ft / 1000, col.slTempC - ISA.LAPSE * ISA.TROP / 1000);
}
function colPresHpa(ft) {
  return isaPresHpa(ft) * (col.qnh / 29.92126);
}
function colRho(ft) {
  return airDensity(colPresHpa(ft), colTempC(ft));
}

function drawColumn() {
  const cv = $('col-canvas');
  const { ctx, W, H } = prepCanvas(cv);
  const L = 46, R = 14, T = 16, B = 34;
  const y = (ft) => T + (1 - ft / col.TOP) * (H - T - B);
  const x = (frac) => L + clamp(frac, 0, 1.08) * (W - L - R) / 1.08;

  for (let a = 0; a <= col.TOP; a += 5000) gridH(ctx, y(a), L, W, R, a ? (a / 1000) + 'k' : '0');
  ctx.fillStyle = '#555'; ctx.textAlign = 'center';
  for (let f = 0; f <= 1; f += 0.25) {
    ctx.fillText(Math.round(f * 100) + '%', x(f), H - 20);
  }
  ctx.fillText('fraction of sea-level value', (L + W - R) / 2, H - 6);
  ctx.save();
  ctx.translate(12, (T + H - B) / 2); ctx.rotate(-Math.PI / 2);
  ctx.fillText('altitude (ft)', 0, 0);
  ctx.restore();

  // lblAt: altitude at which each curve carries its direct label — spread out
  // so the labels can't collide (the curves all converge near 100 % at the ground)
  const series = [
    { name: 'pressure', color: '#4a9eff', lblAt: 30000, fn: (ft) => colPresHpa(ft) / ISA.P0, isaFn: (ft) => isaPresHpa(ft) / ISA.P0 },
    { name: 'density',  color: '#22c55e', lblAt: 22000, fn: (ft) => colRho(ft) / ISA.RHO0,   isaFn: (ft) => airDensity(isaPresHpa(ft), isaTempC(ft)) / ISA.RHO0 },
    { name: 'temp (K)', color: '#ef4444', lblAt: 14000, fn: (ft) => (colTempC(ft) + 273.15) / ISA.T0K, isaFn: (ft) => (isaTempC(ft) + 273.15) / ISA.T0K },
  ];

  // faint ISA reference curves
  ctx.setLineDash([3, 4]); ctx.lineWidth = 1;
  for (const s of series) {
    ctx.strokeStyle = s.color + '55';
    ctx.beginPath();
    for (let a = 0; a <= col.TOP; a += 400) {
      const px = x(s.isaFn(a)), py = y(a);
      a ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    }
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // actual-day curves + direct labels, each at its own altitude
  ctx.lineWidth = 2;
  for (const s of series) {
    ctx.strokeStyle = s.color;
    ctx.beginPath();
    for (let a = 0; a <= col.TOP; a += 400) {
      const px = x(s.fn(a)), py = y(a);
      a ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    }
    ctx.stroke();
    ctx.fillStyle = s.color; ctx.textAlign = 'left';
    ctx.fillText(s.name, x(s.fn(s.lblAt)) + 7, y(s.lblAt) - 4);
  }

  // "half the atmosphere" annotation: altitude where pressure = 50 %
  let half = 0;
  for (let a = 0; a <= col.TOP; a += 100) { if (colPresHpa(a) / ISA.P0 <= 0.5) { half = a; break; } }
  if (half) {
    ctx.fillStyle = '#666'; ctx.textAlign = 'left';
    ctx.fillText('◂ half the air is below ' + fmt0(half) + ' ft', x(0.52), y(half) + 3);
  }

  // selected-altitude marker
  const my = y(col.alt);
  ctx.strokeStyle = '#ddd'; ctx.lineWidth = 1.2; ctx.setLineDash([6, 4]);
  ctx.beginPath(); ctx.moveTo(L, my); ctx.lineTo(W - R, my); ctx.stroke();
  ctx.setLineDash([]);
  for (const s of series) {
    ctx.beginPath(); ctx.arc(x(s.fn(col.alt)), my, 4.5, 0, 7);
    ctx.fillStyle = s.color; ctx.fill();
    ctx.strokeStyle = '#1a1a1a'; ctx.lineWidth = 2; ctx.stroke();
  }
  ctx.fillStyle = '#fff'; ctx.textAlign = 'left';
  ctx.fillText(fmt0(col.alt) + ' ft', L + 4, my - 5);
}

function colNoteFor(alt) {
  if (alt < 1200) return 'Down in the thick stuff — pattern-altitude territory. Best performance your airplane will ever have today.';
  if (alt < 4000) return 'Typical local-cruise altitudes around the Chesapeake. Density is already a few percent down on sea level.';
  if (alt < 9000) return 'Classic piston cruise band — enough altitude for a real TAS gain, still plenty of molecules for the engine.';
  if (alt < 12500) return 'Above 10,000 the crew needs oxygen after 30 minutes (91.211); a normally aspirated engine is down to ~65 % power.';
  if (alt < 18000) return 'Oxygen required for the crew above 12,500 ft (after 30 min) and continuously above 14,000.';
  if (alt < ISA.TROP) return 'Class A airspace: everyone is IFR on 29.92, flying pressure altitudes as flight levels.';
  return 'The tropopause (~36,000 ft ISA): the lapse stops and temperature holds near −56.5 °C — jet cruise country.';
}

function updateColumn() {
  const p = colPresHpa(col.alt), t = colTempC(col.alt), rho = colRho(col.alt);
  const sigma = rho / ISA.RHO0;
  $('col-ro-alt').textContent = fmt0(col.alt) + ' ft';
  $('col-ro-p').innerHTML = `<b>${(p / 33.8639).toFixed(2)}</b> inHg · ${fmt0(p)} hPa`;
  $('col-ro-t').innerHTML = `<b>${Math.round(t)} °C</b> · ${Math.round(cToF(t))} °F`;
  $('col-ro-rho').innerHTML = `<b>${rho.toFixed(3)}</b> kg/m³`;
  $('col-ro-sigma').innerHTML = `<b>${Math.round(sigma * 100)} %</b>`;
  $('col-ro-mol').innerHTML = `<b>${(sigma * 7.21).toFixed(1)} ×10²³</b>`;
  $('col-ro-note').textContent = colNoteFor(col.alt);
  drawColumn();
}

function initColumn() {
  const altEl = bindSlider('col-alt', (v) => `${fmt0(v)} <span class="u">ft</span>`,
    (v) => { col.alt = v; updateColumn(); });
  const tempEl = bindSlider('col-temp', (v) => `${v} <span class="u">°C</span> · ${Math.round(cToF(v))} <span class="u">°F</span>`,
    (v) => { col.slTempC = v; updateColumn(); });
  const qnhEl = bindSlider('col-qnh', (v) => `${v.toFixed(2)} <span class="u">inHg</span>`,
    (v) => { col.qnh = v; updateColumn(); });
  $('col-isa').addEventListener('click', () => {
    tempEl.value = 15; qnhEl.value = 29.92;
    tempEl.dispatchEvent(new Event('input'));
    qnhEl.dispatchEvent(new Event('input'));
  });
  onDrag($('col-canvas'), (px, py) => {
    const cv = $('col-canvas'), r = cv.getBoundingClientRect();
    const T = 16, B = 34;
    const ft = clamp((1 - (py - T) / (r.height - T - B)) * col.TOP, 0, col.TOP);
    col.alt = Math.round(ft / 100) * 100;
    altEl.value = col.alt;
    altEl.dispatchEvent(new Event('input'));
  });
  updateColumn();
}

/* ========================================================================
   2. PRESSURE / DENSITY ALTITUDE
   ======================================================================== */

const da = { elev: 34, tempF: 59, dewF: 41, qnh: 29.92 };

function daCompute() {
  const tC = fToC(da.tempF);
  const dC = Math.min(fToC(da.dewF), tC);       // dewpoint can't exceed temp
  const pa = pressureAltFt(da.elev, da.qnh);
  const pStn = stationPresInHg(da.qnh, da.elev) * 33.8639;  // hPa
  const e = vaporPresHpa(dC);
  const rho = airDensity(pStn, tC, e);
  const rhoDry = airDensity(pStn, tC, 0);
  const daFt = densityAltFt(rho);
  const daDry = densityAltFt(rhoDry);
  const isaT = isaTempC(pa);
  const sigma = rho / ISA.RHO0;
  // rule-of-thumb performance trends vs sea-level ISA (piston, fixed pitch):
  // ground roll ∝ 1/σ² (TAS² for the same IAS) × extra for lost engine power;
  // naturally aspirated power ≈ (σ − 0.117)/0.883 of rated.
  const powerFrac = clamp((sigma - 0.117) / 0.883, 0.05, 1.15);
  const rollFactor = (1 / (sigma * sigma)) * Math.min(1 / powerFrac, 3) ** 0.55;
  const climbFrac = clamp(1 - 0.075 * daFt / 1000, 0, 1.2);
  return { tC, dC, pa, pStn, e, rho, daFt, daDry, isaT, sigma, rollFactor, climbFrac };
}

// chart-only quick DA (dry, 29.92) for the elevation curves
function daQuick(elevFt, tempF) {
  return elevFt + 118.8 * (fToC(tempF) - isaTempC(elevFt));
}

const DA_X = { lo: -10, hi: 115 };   // °F
const DA_Y = { lo: -2000, hi: 16000 };

function drawDaChart() {
  const cv = $('da-canvas');
  const { ctx, W, H } = prepCanvas(cv);
  const L = 46, R = 14, T = 14, B = 30;
  const x = (f) => L + (f - DA_X.lo) / (DA_X.hi - DA_X.lo) * (W - L - R);
  const y = (ft) => T + (1 - (ft - DA_Y.lo) / (DA_Y.hi - DA_Y.lo)) * (H - T - B);

  for (let a = 0; a <= DA_Y.hi; a += 2000) gridH(ctx, y(a), L, W, R, a ? (a / 1000) + 'k' : '0');
  ctx.fillStyle = '#555'; ctx.textAlign = 'center';
  for (let f = 0; f <= 110; f += 20) ctx.fillText(f + '°F', x(f), H - 10);
  ctx.save(); ctx.translate(12, (T + H - B) / 2); ctx.rotate(-Math.PI / 2);
  ctx.fillText('density altitude (ft)', 0, 0); ctx.restore();

  // caution band above 3,000 ft DA
  ctx.fillStyle = 'rgba(245,158,11,0.07)';
  ctx.fillRect(L, T, W - L - R, Math.max(0, y(3000) - T));
  ctx.strokeStyle = 'rgba(245,158,11,0.45)'; ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(L, y(3000)); ctx.lineTo(W - R, y(3000)); ctx.stroke();
  ctx.setLineDash([]);

  // elevation curves — sequential blue ramp, light → dark with elevation;
  // clip to the plot area so cold-day negative DAs run off the edge cleanly
  ctx.save();
  ctx.beginPath(); ctx.rect(L, T, W - L - R, H - T - B); ctx.clip();
  const curves = [
    { elev: 0,    color: '#b3d4fb' },
    { elev: 2000, color: '#7cb3f5' },
    { elev: 5000, color: '#4a9eff' },
    { elev: 8000, color: '#2a6fd4' },
  ];
  for (const c of curves) {
    ctx.strokeStyle = c.color; ctx.lineWidth = 1.6;
    ctx.beginPath();
    for (let f = DA_X.lo; f <= DA_X.hi; f += 2) {
      const px = x(f), py = y(daQuick(c.elev, f));
      f > DA_X.lo ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    }
    ctx.stroke();
    ctx.fillStyle = c.color; ctx.textAlign = 'left';
    const fLbl = DA_X.hi - 13;
    ctx.fillText(fmt0(c.elev) + ' ft', x(fLbl) + 3, y(daQuick(c.elev, fLbl)) - 5);
  }

  // the user's field elevation, highlighted
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.2;
  ctx.beginPath();
  for (let f = DA_X.lo; f <= DA_X.hi; f += 2) {
    const px = x(f), py = y(daQuick(da.elev, f));
    f > DA_X.lo ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
  }
  ctx.stroke();
  ctx.fillStyle = '#fff'; ctx.textAlign = 'left';
  ctx.fillText('your field (' + fmt0(da.elev) + ' ft)', L + 4,
    clamp(y(daQuick(da.elev, DA_X.lo)) - 6, T + 10, H - B - 6));
  ctx.restore();

  // current point (exact computation incl. humidity + altimeter)
  const r = daCompute();
  const px = x(clamp(da.tempF, DA_X.lo, DA_X.hi)), py = y(clamp(r.daFt, DA_Y.lo, DA_Y.hi));
  ctx.strokeStyle = '#ef4444'; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(px, y(DA_Y.lo)); ctx.lineTo(px, py); ctx.lineTo(L, py); ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath(); ctx.arc(px, py, 6, 0, 7);
  ctx.fillStyle = '#ef4444'; ctx.fill();
  ctx.strokeStyle = '#1a1a1a'; ctx.lineWidth = 2; ctx.stroke();
  ctx.fillStyle = '#fff'; ctx.textAlign = px > W - 120 ? 'right' : 'left';
  ctx.fillText('DA ' + fmt0(r.daFt) + ' ft', px + (px > W - 120 ? -10 : 10), py - 8);
}

function updateDa() {
  const r = daCompute();
  const paEl = $('da-pa'), daEl = $('da-da');
  paEl.textContent = fmt0(r.pa);
  daEl.textContent = fmt0(r.daFt);
  daEl.className = 'num' + (r.daFt >= 5000 ? ' bad' : r.daFt >= 3000 ? ' warn' : '');
  const dev = r.tC - r.isaT;
  $('da-isa-t').innerHTML = `${fmt1(r.isaT)} °C · ${fmt1(cToF(r.isaT))} °F`;
  $('da-isa-dev').innerHTML = `<b>${dev >= 0 ? '+' : '−'}${fmt1(Math.abs(dev))} °C</b> (ISA${dev >= 0 ? '+' : '−'}${Math.abs(Math.round(dev))})`;
  $('da-hum').innerHTML = `<b>${fmt0(Math.max(0, r.daFt - r.daDry))} ft</b> of DA`;
  const rollPct = Math.round((r.rollFactor - 1) * 100);
  $('da-roll').innerHTML = `<b>${rollPct >= 0 ? '+' : ''}${rollPct} %</b> (×${r.rollFactor.toFixed(2)})`;
  $('da-climb').innerHTML = `<b>${Math.round(r.climbFrac * 100)} %</b> of sea-level ISA`;
  drawDaChart();
  updateChain();   // TAS panel references DA conditions in its note
}

function initDa() {
  const elevEl = bindSlider('da-elev', (v) => `${fmt0(v)} <span class="u">ft</span>`, (v) => { da.elev = v; updateDa(); });
  const tempEl = bindSlider('da-temp', (v) => `${v} <span class="u">°F</span> · ${Math.round(fToC(v))} <span class="u">°C</span>`, (v) => { da.tempF = v; updateDa(); });
  const dewEl = bindSlider('da-dew', (v) => `${v} <span class="u">°F</span>`, (v) => { da.dewF = v; updateDa(); });
  const qnhEl = bindSlider('da-qnh', (v) => `${v.toFixed(2)} <span class="u">inHg</span>`, (v) => { da.qnh = v; updateDa(); });

  const setAll = (elev, tempF, dewF, qnh) => {
    elevEl.value = elev; tempEl.value = tempF; dewEl.value = dewF; qnhEl.value = qnh;
    for (const el of [elevEl, tempEl, dewEl, qnhEl]) el.dispatchEvent(new Event('input'));
  };

  $('da-kanp').addEventListener('click', () => {
    setAll(SITE.airport.elevFt, 59, 41, 29.92);
    $('da-metar-note').textContent = '';
  });

  $('da-metar').addEventListener('click', async () => {
    const note = $('da-metar-note'), btn = $('da-metar');
    btn.disabled = true; note.textContent = 'Fetching latest ' + SITE.airport.metarStation + ' observation…';
    try {
      const stn = SITE.airport.metarStation;
      const res = await fetch(`https://api.weather.gov/stations/${stn}/observations/latest`);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const js = await res.json();
      const raw = js.properties && js.properties.rawMessage;
      if (!raw) throw new Error('no raw METAR in observation');
      const tg = raw.match(/\s(M?\d{2})\/(M?\d{2})\s/);
      const ag = raw.match(/\bA(\d{4})\b/);
      if (!tg || !ag) throw new Error('could not parse METAR: ' + raw);
      const dec = (s) => (s[0] === 'M' ? -parseInt(s.slice(1), 10) : parseInt(s, 10));
      const tF = Math.round(cToF(dec(tg[1]))), dF = Math.round(cToF(dec(tg[2])));
      const qnh = parseInt(ag[1], 10) / 100;
      setAll(SITE.airport.elevFt, tF, dF, qnh);
      note.textContent = `${raw.trim()} — applied at ${SITE.airport.id} field elevation (${SITE.airport.obsNote}).`;
    } catch (err) {
      note.textContent = 'Could not load live weather (' + err.message + ') — sliders unchanged.';
    }
    btn.disabled = false;
  });

  // drag horizontally on the chart to sweep temperature
  onDrag($('da-canvas'), (px) => {
    const r = $('da-canvas').getBoundingClientRect();
    const L = 46, R = 14;
    const f = clamp(DA_X.lo + (px - L) / (r.width - L - R) * (DA_X.hi - DA_X.lo), DA_X.lo, DA_X.hi);
    tempEl.value = Math.round(f);
    tempEl.dispatchEvent(new Event('input'));
  });
  updateDa();
}

/* ========================================================================
   3. PARCEL OF AIR
   ======================================================================== */

const DALR = 3.0;      // dry adiabatic lapse, °C / 1,000 ft
const MALR = 1.8;      // moist adiabatic lapse (typical low-level value)
const LCL_RATE = 2.45; // temp–dewpoint convergence, °C / 1,000 ft

const pc = {
  Ts: 27, Td: 16, elr: 2.0,   // surface temp/dewpoint °C, environment lapse
  heat: 0,                    // extra parcel heating from the sun button
  alt: 0, vel: 0,             // parcel state (ft, ft/s of sim time)
  dragging: false,
  TOP: 15000,
  lastT: 0,
};

function pcEnvT(ft) { return pc.Ts - pc.elr * ft / 1000; }
function pcLclFt() {
  return Math.max(0, (pc.Ts + pc.heat - pc.Td) / LCL_RATE * 1000);
}
function pcParcelT(ft) {
  const lcl = pcLclFt();
  const t0 = pc.Ts + pc.heat;
  if (ft <= lcl) return t0 - DALR * ft / 1000;
  return t0 - DALR * lcl / 1000 - MALR * (ft - lcl) / 1000;
}
// equilibrium level: first altitude above `from` where the parcel stops being
// warmer than the environment (null if it never is)
function pcEquilibrium(from) {
  for (let a = from; a <= pc.TOP; a += 100) {
    if (pcParcelT(a) <= pcEnvT(a)) return a;
  }
  return null;
}

function pcStability() {
  if (pc.elr < 0) return { label: 'VERY STABLE — INVERSION', color: '#22c55e', note: 'Temperature rises with height: a lid on the atmosphere. Dead-smooth air, but haze, smoke and poor visibility get trapped underneath — a classic Chesapeake summer morning.' };
  if (pc.elr < MALR) return { label: 'STABLE', color: '#22c55e', note: 'Lifted air ends up colder and heavier than its surroundings, so it sinks back. Smooth ride; clouds spread in flat layers if any.' };
  if (pc.elr <= DALR) return { label: 'CONDITIONALLY UNSTABLE', color: '#f59e0b', note: 'Stable while dry — but if a parcel is forced up past its cloud base, condensation heating can keep it going. Fair-weather cumulus country; watch how tall they grow.' };
  return { label: 'ABSOLUTELY UNSTABLE', color: '#ef4444', note: 'The environment cools faster with height than a rising parcel does, so any nudge grows: thermals, building cumulus, an afternoon of bumps. Glider pilots call this "a good day".' };
}

function pcTempRange() {
  const cold = Math.min(pcEnvT(pc.TOP), pcParcelT(pc.TOP), pc.Td - 3);
  const warm = Math.max(pc.Ts, pc.Ts + pc.heat) + 4;
  return { lo: Math.floor(cold / 5) * 5 - 2, hi: Math.ceil(warm / 5) * 5 + 2 };
}

function drawParcel() {
  const cv = $('parcel-canvas');
  const { ctx, W, H } = prepCanvas(cv);
  const L = 46, R = 16, T = 12, B = 40;
  const tr = pcTempRange();
  const x = (t) => L + (t - tr.lo) / (tr.hi - tr.lo) * (W - L - R);
  const y = (ft) => T + (1 - ft / pc.TOP) * (H - T - B);

  for (let a = 0; a <= pc.TOP; a += 2500) gridH(ctx, y(a), L, W, R, a ? (a / 1000) + 'k' : '0');
  ctx.fillStyle = '#555'; ctx.textAlign = 'center';
  const tStep = (tr.hi - tr.lo) > 45 ? 20 : 10;
  for (let t = Math.ceil(tr.lo / tStep) * tStep; t <= tr.hi; t += tStep) ctx.fillText(t + '°C', x(t), H - 24);
  ctx.fillText('temperature', (L + W - R) / 2, H - 10);
  ctx.save(); ctx.translate(12, (T + H - B) / 2); ctx.rotate(-Math.PI / 2);
  ctx.fillText('altitude (ft)', 0, 0); ctx.restore();

  // ground
  ctx.fillStyle = '#20301c';
  ctx.fillRect(L, y(0), W - L - R, 5);

  const lcl = pcLclFt();

  // cloud layer: from LCL to the equilibrium level (or a thin deck if stable)
  if (lcl < pc.TOP) {
    const el = pcEquilibrium(Math.max(lcl, 100));
    const topFt = el == null ? pc.TOP : Math.max(el, lcl + 600);
    const grow = pcParcelT(lcl + 200) > pcEnvT(lcl + 200);
    const cloudTop = grow ? topFt : lcl + 600;
    ctx.fillStyle = 'rgba(200,205,215,0.10)';
    ctx.fillRect(L, y(Math.min(cloudTop, pc.TOP)), W - L - R, Math.max(3, y(lcl) - y(Math.min(cloudTop, pc.TOP))));
    // scalloped cloud-base edge
    ctx.fillStyle = 'rgba(200,205,215,0.22)';
    for (let px = L + 8; px < W - R - 8; px += 26) {
      ctx.beginPath(); ctx.arc(px, y(lcl), 8, Math.PI, 0); ctx.fill();
    }
    ctx.fillStyle = '#9aa3b0'; ctx.textAlign = 'right';
    ctx.fillText('cloud base ' + fmt0(lcl) + ' ft', W - R - 4, y(lcl) - 6);
  }

  // environment temperature profile (solid blue)
  ctx.strokeStyle = '#4a9eff'; ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x(pcEnvT(0)), y(0));
  ctx.lineTo(x(pcEnvT(pc.TOP)), y(pc.TOP));
  ctx.stroke();
  ctx.fillStyle = '#4a9eff'; ctx.textAlign = 'left';
  ctx.fillText('surrounding air', x(pcEnvT(pc.TOP * 0.93)) + 8, y(pc.TOP * 0.93));

  // parcel temperature path (dashed red, kinked at the LCL)
  ctx.strokeStyle = '#ef4444'; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.moveTo(x(pcParcelT(0)), y(0));
  if (lcl < pc.TOP) ctx.lineTo(x(pcParcelT(lcl)), y(lcl));
  ctx.lineTo(x(pcParcelT(pc.TOP)), y(pc.TOP));
  ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = '#ef4444';
  ctx.fillText('the parcel', x(pcParcelT(pc.TOP * 0.8)) - 62, y(pc.TOP * 0.8));

  // the parcel itself
  const pT = pcParcelT(pc.alt), eT = pcEnvT(pc.alt);
  const bx = x(pT), by = y(pc.alt);
  const saturated = pc.alt >= lcl - 1;
  ctx.beginPath(); ctx.arc(bx, by, 13, 0, 7);
  ctx.fillStyle = pT > eT + 0.05 ? 'rgba(239,68,68,0.85)' : pT < eT - 0.05 ? 'rgba(96,140,200,0.85)' : 'rgba(160,160,160,0.85)';
  ctx.fill();
  ctx.strokeStyle = saturated ? '#e8ecf2' : '#1a1a1a';
  ctx.lineWidth = saturated ? 3 : 2; ctx.stroke();
  ctx.fillStyle = '#fff'; ctx.textAlign = 'center';
  ctx.font = 'bold 10px "Segoe UI", system-ui, sans-serif';
  ctx.fillText(Math.round(pT) + '°', bx, by + 3.5);
}

function updateParcelReadouts() {
  const st = pcStability();
  const chip = $('pc-stab');
  chip.textContent = st.label; chip.style.background = st.color;
  const lcl = pcLclFt();
  $('pc-lcl').innerHTML = lcl >= pc.TOP ? 'above ' + fmt0(pc.TOP) + ' ft' : `<b>${fmt0(lcl)} ft</b> AGL`;
  $('pc-alt').innerHTML = `<b>${fmt0(pc.alt)} ft</b>`;
  const pT = pcParcelT(pc.alt), eT = pcEnvT(pc.alt);
  $('pc-temps').innerHTML = `<b>${fmt1(pT)}</b> / ${fmt1(eT)} °C`;
  const d = pT - eT;
  $('pc-buoy').innerHTML = Math.abs(d) < 0.1
    ? 'neutral — it floats here'
    : d > 0 ? `<b style="color:#ef4444">+${fmt1(d)} °C warmer</b> → rising` : `<b style="color:#8ab8e8">${fmt1(d)} °C colder</b> → sinking`;
  $('pc-note').textContent = st.note;
}

function parcelFrame(tMs) {
  const dtReal = pc.lastT ? Math.min(0.05, (tMs - pc.lastT) / 1000) : 0.016;
  pc.lastT = tMs;
  if (!pc.dragging) {
    const dt = dtReal * 7;                    // sim runs faster than real time
    const dT = pcParcelT(pc.alt) - pcEnvT(pc.alt);
    const accel = 260 * dT - 0.45 * pc.vel;   // buoyancy + drag (tuned, ft/s²)
    pc.vel += accel * dt;
    pc.alt += pc.vel * dt;
    if (pc.alt <= 0) { pc.alt = 0; if (pc.vel < 0) pc.vel = 0; }
    if (pc.alt >= pc.TOP) { pc.alt = pc.TOP; if (pc.vel > 0) pc.vel = 0; }
  }
  drawParcel();
  updateParcelReadouts();
  requestAnimationFrame(parcelFrame);
}

function initParcel() {
  bindSlider('pc-temp', (v) => `${v} <span class="u">°C</span> · ${Math.round(cToF(v))} <span class="u">°F</span>`,
    (v) => { pc.Ts = v; pc.Td = Math.min(pc.Td, v); });
  const dewEl = bindSlider('pc-dew', (v) => `${v} <span class="u">°C</span> · ${Math.round(cToF(v))} <span class="u">°F</span>`,
    (v) => { pc.Td = Math.min(v, pc.Ts); });
  bindSlider('pc-elr', (v) => `${v.toFixed(1)} <span class="u">°C/1k ft</span>`,
    (v) => { pc.elr = v; });
  $('pc-heat').addEventListener('click', () => { pc.heat = Math.min(pc.heat + 2, 8); });
  $('pc-reset').addEventListener('click', () => {
    pc.heat = 0; pc.alt = 0; pc.vel = 0;
    // re-clamp dewpoint display if it was above temp
    dewEl.dispatchEvent(new Event('input'));
  });
  onDrag($('parcel-canvas'), (px, py) => {
    const r = $('parcel-canvas').getBoundingClientRect();
    const T = 12, B = 40;
    pc.dragging = true;
    pc.alt = clamp((1 - (py - T) / (r.height - T - B)) * pc.TOP, 0, pc.TOP);
    pc.vel = 0;
  }, () => { pc.dragging = false; });
  requestAnimationFrame(parcelFrame);
}

/* ========================================================================
   4. IAS → TAS → GS
   ======================================================================== */

const spd = { ias: 105, alt: 5500, isaDev: 0, crs: 287, wdir: 230, wspd: 18 };

function spdTas(altFt) {
  // density altitude for the cruise level: pressure altitude (29.92 assumed)
  // plus ~118.8 ft per °C of ISA deviation
  const daFt = altFt + 118.8 * spd.isaDev;
  return spd.ias / Math.sqrt(sigmaAtDa(Math.max(-2000, daFt)));
}

function drawTasChart() {
  const cv = $('tas-canvas');
  const { ctx, W, H } = prepCanvas(cv);
  const L = 44, R = 14, T = 12, B = 26;
  const TOPA = 17500;
  const vLo = spd.ias - 6, vHi = spdTas(TOPA) + 8;
  const x = (v) => L + (v - vLo) / (vHi - vLo) * (W - L - R);
  const y = (ft) => T + (1 - ft / TOPA) * (H - T - B);

  for (let a = 0; a <= TOPA; a += 2500) gridH(ctx, y(a), L, W, R, a ? (a / 1000) + 'k' : '0');
  ctx.fillStyle = '#555'; ctx.textAlign = 'center';
  const step = vHi - vLo > 60 ? 20 : 10;
  for (let v = Math.ceil(vLo / step) * step; v <= vHi; v += step) ctx.fillText(v + ' kt', x(v), H - 8);

  // IAS reference (vertical dashed blue)
  ctx.strokeStyle = '#4a9eff'; ctx.lineWidth = 1.6; ctx.setLineDash([5, 4]);
  ctx.beginPath(); ctx.moveTo(x(spd.ias), y(0)); ctx.lineTo(x(spd.ias), y(TOPA)); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = '#4a9eff'; ctx.textAlign = 'left';
  ctx.fillText('indicated ' + spd.ias + ' kt', x(spd.ias) + 5, y(TOPA) + 10);

  // TAS curve (red)
  ctx.strokeStyle = '#ef4444'; ctx.lineWidth = 2;
  ctx.beginPath();
  for (let a = 0; a <= TOPA; a += 250) {
    const px = x(spdTas(a)), py = y(a);
    a ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
  }
  ctx.stroke();
  ctx.fillStyle = '#ef4444';
  ctx.fillText('true', x(spdTas(TOPA * 0.75)) + 7, y(TOPA * 0.75));

  // marker at cruise altitude
  const tas = spdTas(spd.alt);
  ctx.strokeStyle = '#888'; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(L, y(spd.alt)); ctx.lineTo(x(tas), y(spd.alt)); ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath(); ctx.arc(x(tas), y(spd.alt), 5.5, 0, 7);
  ctx.fillStyle = '#fff'; ctx.fill();
  ctx.strokeStyle = '#1a1a1a'; ctx.lineWidth = 2; ctx.stroke();
  ctx.fillStyle = '#fff'; ctx.textAlign = 'left';
  ctx.fillText(Math.round(tas) + ' kt TAS', x(tas) + 9, y(spd.alt) + 3);
}

function windSolve() {
  const tas = spdTas(spd.alt);
  const rel = rad(spd.wdir - spd.crs);
  const s = (spd.wspd / tas) * Math.sin(rel);
  const impossible = Math.abs(s) > 1;
  const wca = Math.asin(clamp(s, -1, 1));            // + = crab right
  const hdg = norm360(spd.crs + wca * 180 / Math.PI);
  const gs = tas * Math.cos(wca) - spd.wspd * Math.cos(rel);
  const head = spd.wspd * Math.cos(rel);              // + = headwind
  const cross = spd.wspd * Math.sin(rel);             // + = from the right
  return { tas, wca: wca * 180 / Math.PI, hdg, gs, head, cross, impossible };
}

function drawWindTriangle() {
  const cv = $('wind-canvas');
  const { ctx, W, H } = prepCanvas(cv);
  const cx = W / 2, cy = H / 2;
  const Rr = Math.min(W, H) / 2 - 20;
  const sol = windSolve();
  const scale = (Rr * 0.9) / Math.max(sol.tas + spd.wspd * 0.4, sol.tas * 1.1, 60);

  // compass ring
  ctx.strokeStyle = '#2c2c2c'; ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.arc(cx, cy, Rr, 0, 7); ctx.stroke();
  ctx.fillStyle = '#666'; ctx.textAlign = 'center';
  for (let d = 0; d < 360; d += 30) {
    const a = rad(d);
    const x1 = cx + Math.sin(a) * Rr, y1 = cy - Math.cos(a) * Rr;
    const x2 = cx + Math.sin(a) * (Rr - 6), y2 = cy - Math.cos(a) * (Rr - 6);
    ctx.strokeStyle = '#3a3a3a';
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    if (d % 90 === 0) {
      ctx.fillStyle = '#888';
      ctx.fillText('NESW'[d / 90], cx + Math.sin(a) * (Rr - 16), cy - Math.cos(a) * (Rr - 16) + 3);
    }
  }

  const pt = (fromX, fromY, deg, kt) => [fromX + Math.sin(rad(deg)) * kt * scale, fromY - Math.cos(rad(deg)) * kt * scale];
  const arrow = (x1, y1, x2, y2, color, w, dash) => {
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = w;
    if (dash) ctx.setLineDash(dash);
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    ctx.setLineDash([]);
    const a = Math.atan2(y2 - y1, x2 - x1);
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - 9 * Math.cos(a - 0.42), y2 - 9 * Math.sin(a - 0.42));
    ctx.lineTo(x2 - 9 * Math.cos(a + 0.42), y2 - 9 * Math.sin(a + 0.42));
    ctx.closePath(); ctx.fill();
  };

  // course line (faint, through the middle)
  ctx.strokeStyle = '#3d3d3d'; ctx.lineWidth = 1; ctx.setLineDash([7, 6]);
  const [cxa, cya] = pt(cx, cy, spd.crs, sol.tas + spd.wspd);
  const [cxb, cyb] = pt(cx, cy, spd.crs + 180, sol.tas + spd.wspd);
  ctx.beginPath(); ctx.moveTo(cxb, cyb); ctx.lineTo(cxa, cya); ctx.stroke();
  ctx.setLineDash([]);

  // heading/TAS vector (blue), then wind (amber) tip-to-tail, resultant GS (red)
  const [hx, hy] = pt(cx, cy, sol.hdg, sol.tas);
  const [wx, wy] = pt(hx, hy, spd.wdir + 180, spd.wspd);
  arrow(cx, cy, hx, hy, '#4a9eff', 2.4);
  if (spd.wspd > 0) arrow(hx, hy, wx, wy, '#f59e0b', 2.4);
  arrow(cx, cy, wx, wy, '#ef4444', 2.8, [2, 3]);

  // direct labels — offset perpendicular to each vector so they can't stack
  // when the vectors are nearly collinear
  ctx.font = 'bold 10.5px "Segoe UI", system-ui, sans-serif';
  const labelAlong = (x1, y1, x2, y2, text, color, side, off) => {
    const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1;
    ctx.fillStyle = color; ctx.textAlign = 'center';
    ctx.fillText(text, (x1 + x2) / 2 - dy / len * off * side, (y1 + y2) / 2 + dx / len * off * side + 3.5);
  };
  labelAlong(cx, cy, hx, hy, `hdg ${String(Math.round(norm360(sol.hdg))).padStart(3, '0')}° · TAS ${Math.round(sol.tas)}`, '#4a9eff', -1, 16);
  if (spd.wspd > 0) {
    // wind label sits just beyond the amber vector's tip, continuing its direction
    const wl = Math.hypot(wx - hx, wy - hy) || 1;
    ctx.fillStyle = '#f59e0b'; ctx.textAlign = 'center';
    ctx.fillText(`wind ${String(spd.wdir).padStart(3, '0')}@${spd.wspd}`,
      wx + (wx - hx) / wl * 20, wy + (wy - hy) / wl * 20 + 3.5);
  }
  labelAlong(cx, cy, wx, wy, `GS ${Math.round(Math.max(0, sol.gs))}`, '#ef4444', 1, 15);
  ctx.font = '10px "Segoe UI", system-ui, sans-serif';

  // little airplane at the center, pointed along heading
  ctx.save();
  ctx.translate(cx, cy); ctx.rotate(rad(sol.hdg));
  ctx.fillStyle = '#ddd';
  ctx.beginPath();
  ctx.moveTo(0, -9); ctx.lineTo(6, 5); ctx.lineTo(0, 2); ctx.lineTo(-6, 5);
  ctx.closePath(); ctx.fill();
  ctx.restore();
}

function updateSpeeds() {
  const sol = windSolve();
  drawTasChart();
  drawWindTriangle();

  const rot = spd.ias * (1 + 0.02 * spd.alt / 1000);
  $('tas-note').textContent =
    `At ${fmt0(spd.alt)} ft (ISA${spd.isaDev >= 0 ? '+' : ''}${spd.isaDev}) your ${spd.ias} kt indicated is ` +
    `${Math.round(sol.tas)} kt true — the +2 %/1,000 ft rule of thumb says ~${Math.round(rot)} kt.`;

  const wtn = $('wt-note');
  if (sol.impossible) {
    wtn.textContent = 'The wind is too strong for this TAS to hold that course — even crabbed 90° you drift. Try more speed or a different course.';
  } else {
    const xw = Math.abs(sol.cross) < 0.5 ? 'no crosswind' :
      `${Math.round(Math.abs(sol.cross))} kt crosswind from the ${sol.cross > 0 ? 'right' : 'left'}`;
    const hw = Math.abs(sol.head) < 0.5 ? 'no wind component on course' :
      `${Math.round(Math.abs(sol.head))} kt ${sol.head > 0 ? 'headwind' : 'tailwind'}`;
    const crab = Math.abs(sol.wca) < 0.5 ? 'no crab needed' :
      `crab ${Math.round(Math.abs(sol.wca))}° ${sol.wca > 0 ? 'right' : 'left'}`;
    wtn.textContent = `${hw}, ${xw} — ${crab}. Drag anywhere on the compass to steer the wind: direction from the center, strength with distance.`;
  }
  updateChain();
}

function updateChain() {
  const sol = windSolve();
  const daHere = spd.alt + 118.8 * spd.isaDev;
  const gs = Math.max(1, sol.gs);
  const tTas = 100 / sol.tas * 60, tGs = 100 / gs * 60;
  const dTas = Math.round(sol.tas - spd.ias);
  const dGs = Math.round(sol.gs - sol.tas);
  $('chain-body').innerHTML = `
    <table class="tbl">
      <tr><th>Speed</th><th>kt</th><th>vs previous</th><th style="text-align:left">why</th></tr>
      <tr><td>Indicated (IAS)</td><td>${spd.ias}</td><td>—</td>
        <td style="text-align:left">dynamic pressure on the pitot tube — what the wing feels</td></tr>
      <tr><td>Calibrated (CAS)</td><td>≈ ${spd.ias}</td><td class="faint">≈ 0</td>
        <td style="text-align:left">position/instrument error — small at cruise speeds</td></tr>
      <tr class="hl"><td>True (TAS)</td><td>${Math.round(sol.tas)}</td><td>${dTas >= 0 ? '+' : ''}${dTas}</td>
        <td style="text-align:left">thin air at ${fmt0(daHere)} ft density altitude under-reads the gauge</td></tr>
      <tr class="hl"><td>Ground (GS)</td><td>${Math.round(Math.max(0, sol.gs))}</td><td>${dGs >= 0 ? '+' : ''}${dGs}</td>
        <td style="text-align:left">${dGs <= 0 ? 'headwind component along the course' : 'tailwind component along the course'}</td></tr>
    </table>
    <div class="canvas-note">A 100 nm leg: <b style="color:#ddd">${Math.round(tGs)} min</b> over the ground at this GS,
      vs ${Math.round(tTas)} min if the air were still. ${dGs < -1 ? 'The wind is charging you ' + Math.round(tGs - tTas) + ' minutes.' : dGs > 1 ? 'The wind is refunding ' + Math.round(tTas - tGs) + ' minutes.' : ''}</div>`;
}

function initSpeeds() {
  bindSlider('tas-ias', (v) => `${v} <span class="u">kt</span>`, (v) => { spd.ias = v; updateSpeeds(); });
  bindSlider('tas-alt', (v) => `${fmt0(v)} <span class="u">ft</span>`, (v) => { spd.alt = v; updateSpeeds(); });
  bindSlider('tas-isadev', (v) => `${v >= 0 ? '+' : ''}${v} <span class="u">°C</span>`, (v) => { spd.isaDev = v; updateSpeeds(); });
  const crsEl = bindSlider('wt-crs', (v) => `${String(v).padStart(3, '0')}<span class="u">° true</span>`, (v) => { spd.crs = v; updateSpeeds(); });
  const wdirEl = bindSlider('wt-wdir', (v) => `${String(v).padStart(3, '0')}<span class="u">° true</span>`, (v) => { spd.wdir = v; updateSpeeds(); });
  const wspdEl = bindSlider('wt-wspd', (v) => `${v} <span class="u">kt</span>`, (v) => { spd.wspd = v; updateSpeeds(); });

  // drag the wind arrow: pointer position relative to center sets a wind
  // vector pointing INTO the center (wind "from" the pointer side)
  onDrag($('wind-canvas'), (px, py) => {
    const r = $('wind-canvas').getBoundingClientRect();
    const cx = r.width / 2, cy = r.height / 2;
    const Rr = Math.min(r.width, r.height) / 2 - 20;
    const sol = windSolve();
    const scale = (Rr * 0.9) / Math.max(sol.tas + spd.wspd * 0.4, sol.tas * 1.1, 60);
    const dx = px - cx, dy = py - cy;
    const from = norm360(Math.atan2(dx, -dy) * 180 / Math.PI);
    const kt = clamp(Math.hypot(dx, dy) / scale * 0.35, 0, 60);
    wdirEl.value = Math.round(from / 5) * 5;
    wspdEl.value = Math.round(kt);
    wdirEl.dispatchEvent(new Event('input'));
    wspdEl.dispatchEvent(new Event('input'));
  });
  crsEl.dispatchEvent(new Event('input'));
  updateSpeeds();
}

/* ================================= init ================================== */

function initAirLab() {
  // localize defaults to the configured home airport
  da.elev = SITE.airport.elevFt;
  $('da-elev').value = SITE.airport.elevFt;
  initColumn();
  initDa();
  initParcel();
  initSpeeds();

  let resizeT;
  window.addEventListener('resize', () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(() => { updateColumn(); drawDaChart(); drawTasChart(); drawWindTriangle(); }, 120);
  });
}

document.addEventListener('DOMContentLoaded', initAirLab);
