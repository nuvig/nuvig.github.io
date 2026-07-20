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

// one step of the parcel sim — driven by the shared animation loop
function parcelTick(dtReal) {
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
  drawParcel();            // first paint even if the section starts off-screen
  updateParcelReadouts();
}

/* ========================================================================
   3½. RAM PRESSURE — the pitot tube
   ======================================================================== */

const pit = { tas: 105, alt: 0, parts: [] };

function pitSigma() { return sigmaAtDa(pit.alt); }
function pitIas() { return pit.tas * Math.sqrt(pitSigma()); }
function pitQpsf() {  // dynamic pressure in lb/ft²
  const v = pit.tas * 0.514444;                    // m/s
  return 0.5 * ISA.RHO0 * pitSigma() * v * v * 0.020885;
}

// geometry helpers shared by draw + tick (CSS px, from the live rect)
function pitGeom(cv) {
  const r = cv.getBoundingClientRect();
  const W = r.width, H = r.height;
  return {
    W, H,
    mouthX: W - 175, mouthY: H * 0.34, mouthH: 30,   // tube opening
    chamberW: 60,
    gaugeX: W - 92, gaugeY: H - 76, gaugeR: 54,
  };
}

function pitotTick(dt) {
  const cv = $('pitot-canvas');
  const g = pitGeom(cv);
  const sigma = pitSigma();
  const N = Math.round(clamp(g.W * g.H / 1600, 50, 170) * sigma);
  const spd = 36 + pit.tas * 1.7;                   // stream speed, px/s

  // maintain population
  while (pit.parts.length < N) {
    pit.parts.push({ x: Math.random() * g.W, y: Math.random() * g.H, mode: 'free', ttl: 0, j: Math.random() });
  }
  if (pit.parts.length > N) pit.parts.length = N;

  if (!REDUCED) {
    for (const p of pit.parts) {
      if (p.mode === 'cap') {
        // trapped in the chamber: fast jitter inside the stagnation region
        p.ttl -= dt;
        p.x += (Math.random() - 0.5) * 260 * dt;
        p.y += (Math.random() - 0.5) * 260 * dt;
        p.x = clamp(p.x, g.mouthX + 4, g.mouthX + g.chamberW - 4);
        p.y = clamp(p.y, g.mouthY - g.mouthH / 2 + 4, g.mouthY + g.mouthH / 2 - 4);
        if (p.ttl <= 0) { p.mode = 'free'; p.x = -5; p.y = Math.random() * g.H; }
        continue;
      }
      p.x += spd * dt * (0.85 + p.j * 0.3);
      p.y += (Math.random() - 0.5) * 30 * dt;
      // capture into the tube mouth
      if (p.x >= g.mouthX && p.x < g.mouthX + 10 && Math.abs(p.y - g.mouthY) < g.mouthH / 2 - 2) {
        p.mode = 'cap'; p.ttl = 0.5 + Math.random() * 0.9;
      } else if (p.x >= g.mouthX - 2 && p.x <= g.mouthX + g.chamberW + 8 &&
                 Math.abs(p.y - g.mouthY) < g.mouthH / 2 + 6) {
        // deflect around the tube body
        p.y += (p.y > g.mouthY ? 1 : -1) * 90 * dt;
      }
      if (p.x > g.W + 4) { p.x = -4; p.y = Math.random() * g.H; }
    }
  }
  drawPitot();
}

function drawPitot() {
  const cv = $('pitot-canvas');
  const { ctx, W, H } = prepCanvas(cv);
  const g = pitGeom(cv);
  const sigma = pitSigma(), ias = pitIas(), q = pitQpsf();

  // relative-wind cue
  ctx.fillStyle = '#565f6b'; ctx.textAlign = 'left';
  ctx.fillText('relative wind (your TAS) →', 10, 16);

  // free-stream molecules as speed streaks; captured ones as bright dots
  const streak = 2.5 + pit.tas * 0.055;
  ctx.strokeStyle = 'rgba(170,180,195,0.6)'; ctx.lineWidth = 1.6; ctx.lineCap = 'round';
  ctx.beginPath();
  for (const p of pit.parts) {
    if (p.mode === 'cap') continue;
    ctx.moveTo(p.x - streak, p.y);
    ctx.lineTo(p.x, p.y);
  }
  ctx.stroke(); ctx.lineCap = 'butt';
  ctx.fillStyle = 'rgba(160,205,255,0.9)';
  for (const p of pit.parts) {
    if (p.mode !== 'cap') continue;
    ctx.beginPath(); ctx.arc(p.x, p.y, 2.1, 0, 7); ctx.fill();
  }

  // stagnation-pressure glow, brightness ∝ ram pressure
  const qNorm = clamp(q / 60, 0, 1);   // 60 psf ≈ 133 kt IAS
  ctx.fillStyle = `rgba(74,158,255,${0.10 + qNorm * 0.38})`;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(g.mouthX, g.mouthY - g.mouthH / 2, g.chamberW, g.mouthH, 4);
  else ctx.rect(g.mouthX, g.mouthY - g.mouthH / 2, g.chamberW, g.mouthH);
  ctx.fill();

  // tube body: chamber walls + closed back, mouth open to the left
  ctx.strokeStyle = '#7a828e'; ctx.lineWidth = 3; ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(g.mouthX, g.mouthY - g.mouthH / 2);
  ctx.lineTo(g.mouthX + g.chamberW, g.mouthY - g.mouthH / 2);
  ctx.lineTo(g.mouthX + g.chamberW, g.mouthY + g.mouthH / 2);
  ctx.lineTo(g.mouthX, g.mouthY + g.mouthH / 2);
  ctx.stroke();
  ctx.lineCap = 'butt';
  ctx.fillStyle = '#9aa3b0'; ctx.textAlign = 'left';
  ctx.fillText('pitot tube', g.mouthX + 2, g.mouthY - g.mouthH / 2 - 8);

  // pressure line from chamber down to the gauge
  ctx.strokeStyle = '#4a5563'; ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(g.mouthX + g.chamberW, g.mouthY);
  ctx.lineTo(g.mouthX + g.chamberW + 26, g.mouthY);
  ctx.lineTo(g.gaugeX, g.gaugeY - g.gaugeR - 6);
  ctx.stroke();

  // the airspeed indicator
  ctx.beginPath(); ctx.arc(g.gaugeX, g.gaugeY, g.gaugeR, 0, 7);
  ctx.fillStyle = '#141414'; ctx.fill();
  ctx.strokeStyle = '#3a3a3a'; ctx.lineWidth = 2; ctx.stroke();
  const A0 = 0.75 * Math.PI, A1 = 2.25 * Math.PI;   // dial arc, 40 → 200 kt
  const ang = (kt) => A0 + clamp((kt - 40) / 160, 0, 1) * (A1 - A0);
  ctx.strokeStyle = '#555'; ctx.lineWidth = 1.5;
  for (let kt = 40; kt <= 200; kt += 20) {
    const a = ang(kt);
    ctx.beginPath();
    ctx.moveTo(g.gaugeX + Math.cos(a) * (g.gaugeR - 4), g.gaugeY + Math.sin(a) * (g.gaugeR - 4));
    ctx.lineTo(g.gaugeX + Math.cos(a) * (g.gaugeR - 11), g.gaugeY + Math.sin(a) * (g.gaugeR - 11));
    ctx.stroke();
    if (kt % 40 === 0) {
      ctx.fillStyle = '#777'; ctx.textAlign = 'center';
      ctx.fillText(kt, g.gaugeX + Math.cos(a) * (g.gaugeR - 21), g.gaugeY + Math.sin(a) * (g.gaugeR - 21) + 3);
    }
  }
  const na = ang(ias);
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.4;
  ctx.beginPath();
  ctx.moveTo(g.gaugeX - Math.cos(na) * 9, g.gaugeY - Math.sin(na) * 9);
  ctx.lineTo(g.gaugeX + Math.cos(na) * (g.gaugeR - 14), g.gaugeY + Math.sin(na) * (g.gaugeR - 14));
  ctx.stroke();
  ctx.beginPath(); ctx.arc(g.gaugeX, g.gaugeY, 3.5, 0, 7);
  ctx.fillStyle = '#fff'; ctx.fill();
  ctx.fillStyle = '#8ab8e8'; ctx.textAlign = 'center';
  ctx.font = 'bold 11px "Segoe UI", system-ui, sans-serif';
  ctx.fillText(Math.round(ias) + ' kt', g.gaugeX, g.gaugeY + g.gaugeR + 14);
  ctx.font = '10px "Segoe UI", system-ui, sans-serif';
  ctx.fillStyle = '#666';
  ctx.fillText('IAS', g.gaugeX, g.gaugeY + 22);

  // condition strip, bottom-left
  ctx.fillStyle = '#666'; ctx.textAlign = 'left';
  ctx.fillText(`TAS ${Math.round(pit.tas)} kt · air density ${Math.round(sigma * 100)} % · ram pressure ${q.toFixed(1)} lb/ft²`, 10, H - 10);
}

function updatePitot() {
  const sigma = pitSigma(), ias = pitIas();
  $('pit-sigma').innerHTML = `<b>${Math.round(sigma * 100)} %</b> of sea level`;
  $('pit-q').innerHTML = `<b>${pitQpsf().toFixed(1)}</b> lb/ft²`;
  $('pit-ias').innerHTML = `<b>${Math.round(ias)} kt</b> indicated`;
  $('pit-tas-ro').innerHTML = `<b>${Math.round(pit.tas)} kt</b> true`;
  $('pit-note').textContent = pit.alt < 250
    ? 'At sea level the gauge tells the whole truth: IAS = TAS. Climb and watch them split.'
    : `Up at ${fmt0(pit.alt)} ft the pile-up in the tube is exactly what ${Math.round(ias)} kt makes at sea level — so that's what the needle says, while you truly move at ${Math.round(pit.tas)} kt. The wing is equally fooled, which is why V-speeds are flown indicated.`;
}

function initPitot() {
  const tasEl = bindSlider('pit-tas', (v) => `${v} <span class="u">kt TAS</span>`, (v) => { pit.tas = v; updatePitot(); });
  const altEl = bindSlider('pit-alt', (v) => `${fmt0(v)} <span class="u">ft</span>`, (v) => { pit.alt = v; updatePitot(); });
  const setBoth = (alt, tas) => {
    altEl.value = alt; tasEl.value = clamp(Math.round(tas), 40, 200);
    altEl.dispatchEvent(new Event('input'));
    tasEl.dispatchEvent(new Event('input'));
  };
  // both presets hold the needle steady so the IAS/TAS split is the one thing that moves
  $('pit-climb').addEventListener('click', () => {
    const ias = pitIas();
    setBoth(10000, ias / Math.sqrt(sigmaAtDa(10000)));
  });
  $('pit-sl').addEventListener('click', () => setBoth(0, pitIas()));
  updatePitot();
  pitotTick(0.016);   // first paint even if the section starts off-screen
}

/* ========================================================================
   4. FOUR FORCES — animated lift / weight / thrust / drag diagram.
   Concept-trainer numbers (172-ish): rated 180 hp, MTOW 2,550 lb,
   Vs0 48 kt IAS at gross. Arrows are qualitative; readouts are the rules
   of thumb made visible.
   ======================================================================== */

const forces = { da: 0, ias: 105, wt: 2300, parts: [], propPh: 0 };

function forcesCalc() {
  const sigma = sigmaAtDa(forces.da);
  const tas = forces.ias / Math.sqrt(sigma);
  const pwrFrac = clamp((sigma - 0.117) / 0.883, 0.05, 1);
  const stallIas = 48 * Math.sqrt(forces.wt / 2550);
  // drag relative to the 105 kt / 2,300 lb / sea-level reference: parasite
  // scales with IAS², induced with weight² / IAS² (same at any altitude for
  // a given IAS — that's the point)
  const dragRel = 0.8 * Math.pow(forces.ias / 105, 2) +
                  0.2 * Math.pow(forces.wt / 2300, 2) * Math.pow(105 / forces.ias, 2);
  // thrust available ∝ power/TAS, and the prop's grip thins with the air
  const thrustRel = pwrFrac / (tas / 105);
  return { sigma, tas, pwrFrac, stallIas, dragRel, thrustRel };
}

function forcesTick(dt) {
  const cv = $('forces-canvas');
  const r = cv.getBoundingClientRect();
  const W = r.width, H = r.height;
  const c = forcesCalc();
  const cx = W * 0.46, cy = H * 0.48;
  const noseX = cx - 78, tailX = cx + 78;

  // molecule stream: density-scaled population, TAS-scaled speed
  const N = Math.round(clamp(W * H / 2400, 40, 130) * c.sigma);
  while (forces.parts.length < N) {
    forces.parts.push({ x: Math.random() * W, y: Math.random() * H, vy: 0, j: Math.random() });
  }
  if (forces.parts.length > N) forces.parts.length = N;
  const spd = 30 + c.tas * 1.5;
  if (!REDUCED) {
    forces.propPh += dt * (6 + c.pwrFrac * 30);
    for (const p of forces.parts) {
      let v = spd * (0.85 + p.j * 0.3);
      // propwash: the tube of air behind the prop moves faster
      if (p.x > noseX - 6 && Math.abs(p.y - cy) < 20) v *= 1.35 + c.pwrFrac * 0.5;
      // downwash: air that has passed the wing gets thrown downward
      if (p.x > cx && p.x < cx + 150 && Math.abs(p.y - cy) < 34 && p.y > cy - 30) {
        p.vy += (34 + forces.wt / 60) * dt;
      } else {
        p.vy *= Math.max(0, 1 - 3 * dt);
      }
      p.x += v * dt;
      p.y += p.vy * dt;
      if (p.x > W + 4) { p.x = -4; p.y = Math.random() * H; p.vy = 0; }
      if (p.y > H + 4) { p.y = -4; }
    }
  }
  drawForces(c, cx, cy, noseX, tailX);
}

function drawForces(c, cx, cy, noseX, tailX) {
  const cv = $('forces-canvas');
  const { ctx, W, H } = prepCanvas(cv);

  ctx.fillStyle = '#565f6b'; ctx.textAlign = 'left';
  ctx.fillText('relative wind →', 10, 16);

  // molecules (streaks, like the pitot panel)
  const streak = 2 + c.tas * 0.04;
  ctx.strokeStyle = 'rgba(170,180,195,0.5)'; ctx.lineWidth = 1.5; ctx.lineCap = 'round';
  ctx.beginPath();
  for (const p of forces.parts) {
    ctx.moveTo(p.x - streak, p.y - p.vy * 0.03);
    ctx.lineTo(p.x, p.y);
  }
  ctx.stroke(); ctx.lineCap = 'butt';

  // the airplane, nose left: fuselage, wing chord, stabilizer, prop disc
  ctx.fillStyle = '#c8ccd2';
  ctx.beginPath(); ctx.ellipse(cx, cy, 80, 11, 0, 0, 7); ctx.fill();
  ctx.fillStyle = '#aeb4bc';
  ctx.beginPath(); ctx.ellipse(cx + 4, cy - 2, 26, 5, -0.06, 0, 7); ctx.fill();   // wing chord
  ctx.beginPath();
  ctx.moveTo(tailX - 14, cy - 2); ctx.lineTo(tailX + 4, cy - 24); ctx.lineTo(tailX + 8, cy - 2);
  ctx.closePath(); ctx.fill();                                                     // fin
  const ph = Math.sin(forces.propPh * 4) * (1 - 0.4);
  ctx.strokeStyle = 'rgba(200,210,220,0.55)'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(noseX - 4, cy - 26 * ph); ctx.lineTo(noseX - 4, cy + 26 * ph); ctx.stroke();
  ctx.strokeStyle = 'rgba(200,210,220,0.16)'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(noseX - 4, cy - 26); ctx.lineTo(noseX - 4, cy + 26); ctx.stroke();

  // force arrows
  const arrow = (x, y, dx, dy, color, label, lx, ly) => {
    const x2 = x + dx, y2 = y + dy;
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x2, y2); ctx.stroke();
    const a = Math.atan2(dy, dx);
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - 10 * Math.cos(a - 0.42), y2 - 10 * Math.sin(a - 0.42));
    ctx.lineTo(x2 - 10 * Math.cos(a + 0.42), y2 - 10 * Math.sin(a + 0.42));
    ctx.closePath(); ctx.fill();
    ctx.font = 'bold 11px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.fillText(label, lx, ly);
    ctx.font = '10px "Segoe UI", system-ui, sans-serif';
  };
  const wLen = 30 + (forces.wt / 2550) * 55;                 // weight sets the scale
  const tLen = clamp(22 + c.thrustRel * 42, 14, 92);
  const dLen = clamp(22 + c.dragRel * 42, 14, 92);
  arrow(cx + 4, cy - 14, 0, -wLen, '#4a9eff', 'LIFT (= weight)', cx + 4, cy - wLen - 22);
  arrow(cx, cy + 12, 0, wLen, '#c8ccd2', 'WEIGHT', cx, cy + wLen + 26);
  arrow(noseX - 10, cy, -tLen, 0, '#22c55e', 'THRUST', noseX - tLen / 2 - 8, cy - 10);
  arrow(tailX + 10, cy, dLen, 0, '#ef4444', 'DRAG', tailX + dLen / 2 + 10, cy - 10);

  // when thrust available can't match drag, say so — that IS the lesson
  if (tLen < dLen * 0.88) {
    ctx.fillStyle = '#f59e0b'; ctx.textAlign = 'center';
    ctx.fillText('thrust can no longer match drag at this IAS —', cx, cy + wLen + 44);
    ctx.fillText('up here the airplane cruises slower (or descends)', cx, cy + wLen + 57);
  }

  ctx.fillStyle = '#666'; ctx.textAlign = 'left';
  ctx.fillText(`IAS ${forces.ias} kt · TAS ${Math.round(c.tas)} kt · air density ${Math.round(c.sigma * 100)} % · ${fmt0(forces.wt)} lb`, 10, H - 10);
}

function updateForces() {
  const c = forcesCalc();
  $('f-tas').innerHTML = `<b>${Math.round(c.tas)} kt</b> (gauge says ${forces.ias})`;
  $('f-pwr').innerHTML = `<b>${Math.round(c.pwrFrac * 100)} %</b> of rated`;
  $('f-prop').innerHTML = `<b>${Math.round(c.sigma * 100)} %</b> of sea-level grip`;
  $('f-drag').innerHTML = `<b>same ½ρV²</b> as ${forces.ias} kt at sea level`;
  $('f-stall').innerHTML = `<b>${Math.round(c.stallIas)} kt</b> indicated — at any altitude`;
  const margin = forces.ias - c.stallIas;
  $('f-note').textContent =
    forces.da >= 7000
      ? `Up here thrust is cut twice — ${Math.round((1 - c.pwrFrac) * 100)} % less engine power and ${Math.round((1 - c.sigma) * 100)} % fewer molecules per blade — while weight hasn't budged. That asymmetry is the density-altitude problem.`
      : margin < 15
        ? `Only ${Math.round(margin)} kt above the stall: slow and heavy is where induced drag is greediest — short final and liftoff live here.`
        : `Thick air: full grip for the prop, full bite for the wing. Load and speed changes move the arrows more than altitude does down low.`;
}

function initForces() {
  bindSlider('f-da', (v) => `${fmt0(v)} <span class="u">ft</span>`, (v) => { forces.da = v; updateForces(); });
  bindSlider('f-ias', (v) => `${v} <span class="u">kt</span>`, (v) => { forces.ias = v; updateForces(); });
  bindSlider('f-wt', (v) => `${fmt0(v)} <span class="u">lb</span>`, (v) => { forces.wt = v; updateForces(); });
  updateForces();
  forcesTick(0.016);   // first paint even if the section starts off-screen
}

/* ========================================================================
   5. IAS → TAS → GS
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

/* ----- cruise performance vs density altitude (concept trainer) -----
   180 hp × 0.85 prop efficiency; power required = parasite (AσV³) +
   induced (B/(σV)); cruise at 75 % of rated until the engine can no
   longer give 75 %, then whatever full throttle has left. */
const CRZ = { PMAX: 153, A: 7.43e-5, BW: 2196 };

function cruiseTasAt(daFt) {
  const s = sigmaAtDa(daFt);
  const P = Math.min(0.75 * CRZ.PMAX, CRZ.PMAX * clamp((s - 0.117) / 0.883, 0, 1));
  let lo = 40, hi = 170;
  for (let i = 0; i < 40; i++) {
    const V = (lo + hi) / 2;
    (CRZ.A * s * V * V * V + CRZ.BW / (s * V) > P) ? hi = V : lo = V;
  }
  return (lo + hi) / 2;
}

function cruiseDaNow() { return clamp(spd.alt + 118.8 * spd.isaDev, 0, 14000); }

function drawCruiseChart() {
  const cv = $('cruise-canvas');
  const { ctx, W, H } = prepCanvas(cv);
  const L = 40, R = 12, T = 14, B = 26;
  const DTOP = 14000;
  const pts = [];
  for (let da = 0; da <= DTOP; da += 250) pts.push([da, cruiseTasAt(da)]);
  const vLo = Math.floor(Math.min(...pts.map((p) => p[1])) / 5) * 5 - 2;
  const vHi = Math.ceil(Math.max(...pts.map((p) => p[1])) / 5) * 5 + 3;
  const x = (da) => L + da / DTOP * (W - L - R);
  const y = (v) => T + (1 - (v - vLo) / (vHi - vLo)) * (H - T - B);

  for (let v = vLo + 2; v <= vHi; v += 5) gridH(ctx, y(v), L, W, R, v + '');
  ctx.fillStyle = '#555'; ctx.textAlign = 'center';
  for (let da = 0; da <= DTOP; da += 2000) ctx.fillText((da / 1000) + 'k', x(da), H - 8);
  ctx.fillText('density altitude (ft)', (L + W - R) / 2, H + 2 - 26 + 22);
  ctx.save(); ctx.translate(11, (T + H - B) / 2); ctx.rotate(-Math.PI / 2);
  ctx.fillText('cruise TAS (kt)', 0, 0); ctx.restore();

  // the hump: where 75 % stops being available
  let bend = DTOP;
  for (let da = 0; da <= DTOP; da += 100) {
    if (CRZ.PMAX * clamp((sigmaAtDa(da) - 0.117) / 0.883, 0, 1) < 0.75 * CRZ.PMAX) { bend = da; break; }
  }
  ctx.strokeStyle = '#3a3a3a'; ctx.setLineDash([3, 4]);
  ctx.beginPath(); ctx.moveTo(x(bend), y(vLo)); ctx.lineTo(x(bend), T); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = '#666'; ctx.textAlign = 'left';
  ctx.fillText('◂ 75 % still available', x(bend) + 4, T + 8);
  ctx.fillText('engine fading ▸', x(bend) + 4, T + 20);

  ctx.strokeStyle = '#4a9eff'; ctx.lineWidth = 2;
  ctx.beginPath();
  pts.forEach(([da, v], i) => { i ? ctx.lineTo(x(da), y(v)) : ctx.moveTo(x(da), y(v)); });
  ctx.stroke();

  const daNow = cruiseDaNow(), vNow = cruiseTasAt(daNow);
  ctx.beginPath(); ctx.arc(x(daNow), y(vNow), 5.5, 0, 7);
  ctx.fillStyle = '#fff'; ctx.fill();
  ctx.strokeStyle = '#1a1a1a'; ctx.lineWidth = 2; ctx.stroke();
  ctx.fillStyle = '#fff'; ctx.textAlign = x(daNow) > W - 110 ? 'right' : 'left';
  ctx.fillText(`your cruise · ${Math.round(vNow)} kt`, x(daNow) + (x(daNow) > W - 110 ? -10 : 9), y(vNow) - 8);
}

function updateCruise() {
  drawCruiseChart();
  const daNow = cruiseDaNow(), vNow = cruiseTasAt(daNow);
  const vIsa = cruiseTasAt(clamp(spd.alt, 0, 14000));
  const el = $('cruise-note');
  const diff = vNow - vIsa;
  el.innerHTML = `At ${fmt0(spd.alt)} ft on an ISA${spd.isaDev >= 0 ? '+' : ''}${spd.isaDev} day the trainer cruises about ` +
    `<b style="color:#ddd">${Math.round(vNow)} kt true</b>` +
    (Math.abs(diff) >= 1
      ? ` — ${Math.abs(Math.round(diff))} kt ${diff < 0 ? 'slower' : 'faster'} than a standard day, from temperature alone. Humidity quietly shaves a knot more on muggy days.`
      : `. Warm the day with the ISA slider and watch the marker slide along the curve.`);
}

function updateSpeeds() {
  const sol = windSolve();
  drawTasChart();
  drawWindTriangle();
  updateCruise();

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

/* ========================================================================
   0. PLAYGROUND — direct hands on the background parcel.
   Temperature, dewpoint and pressure sliders drive the molecule field
   with the honest gas physics: ρ = P/(R·T), vapor via Tetens.
   ======================================================================== */

// The playground exposes every density lever: temp, dewpoint, RH, pressure.
// Dewpoint and RH are two views of the same moisture, so one of them is
// "held" as temperature moves and the other follows.
const play = { tC: 15, dC: 5, pres: 1013, hold: 'dew' };

// inverse Tetens: dewpoint that gives relative humidity rh at temperature tC
function dewFromRh(tC, rh) {
  const e = Math.max(1e-4, rh * vaporPresHpa(tC));
  const L = Math.log10(e / 6.1078);
  return clamp(237.3 * L / (7.5 - L), -25, tC);
}

function playState() {
  const dC = Math.min(play.dC, play.tC);          // dewpoint can't exceed temp
  const e = vaporPresHpa(dC);
  const rho = airDensity(play.pres, play.tC, e);
  return { dC, rho, sigma: rho / ISA.RHO0, rh: relHumidity(play.tC, dC) };
}

// push state into every slider + label + readout (no input events, no loops)
function playRefresh() {
  const s = playState();
  const set = (id, v, html) => { $(id).value = v; $(id + '-val').innerHTML = html; };
  set('play-temp', play.tC, `${play.tC} <span class="u">°C</span> · ${Math.round(cToF(play.tC))} <span class="u">°F</span>`);
  set('play-dew', s.dC, `${Math.round(s.dC)} <span class="u">°C</span> · ${Math.round(cToF(s.dC))} <span class="u">°F</span>`);
  set('play-rh', Math.round(s.rh * 100), `${Math.round(s.rh * 100)} <span class="u">%</span>`);
  set('play-pres', play.pres, `${fmt0(play.pres)} <span class="u">hPa</span> · ${(play.pres / 33.8639).toFixed(2)} <span class="u">inHg</span>`);

  const daFt = densityAltFt(s.rho);
  $('play-sigma').innerHTML = `<b>${Math.round(s.sigma * 100)} %</b> of standard sea level`;
  $('play-rh-ro').innerHTML = s.rh >= 0.99
    ? `<b style="color:#8ab8e8">100 % — saturated</b>`
    : `<b>${Math.round(s.rh * 100)} %</b>`;
  $('play-da').innerHTML = `<b>DA ${fmt0(daFt)} ft</b>`;
  const bits = [];
  if (s.rh >= 0.99) bits.push('The vapor is condensing — this is the inside of a cloud, and exactly what happens at the LCL in panel 6.');
  else if (play.tC >= 30) bits.push('Hot: the dots race around and spread out — fewer molecules in every cubic foot of wing.');
  else if (play.tC <= -5) bits.push('Cold: slow, tightly packed molecules — the airplane loves this.');
  if (play.pres <= 850) bits.push('Low pressure is altitude in disguise: this is the squeeze the parcel loses as it climbs.');
  if (!bits.length) bits.push('An honest parcel: density comes straight from ρ = P / (R·T), vapor from the dewpoint.');
  $('play-note').textContent = bits.join(' ');
}

function initPlay() {
  $('play-temp').addEventListener('input', (e) => {
    const rhBefore = playState().rh;
    play.tC = parseFloat(e.target.value);
    if (play.hold === 'rh') play.dC = dewFromRh(play.tC, rhBefore);
    else play.dC = Math.min(play.dC, play.tC);
    playRefresh();
  });
  $('play-dew').addEventListener('input', (e) => {
    play.dC = Math.min(parseFloat(e.target.value), play.tC);
    playRefresh();
  });
  $('play-rh').addEventListener('input', (e) => {
    play.dC = dewFromRh(play.tC, parseFloat(e.target.value) / 100);
    playRefresh();
  });
  $('play-pres').addEventListener('input', (e) => {
    play.pres = parseFloat(e.target.value);
    playRefresh();
  });
  for (const r of document.querySelectorAll('input[name="play-hold"]')) {
    r.addEventListener('change', () => { play.hold = r.value; });
  }
  const setAll = (t, d, p) => { play.tC = t; play.dC = d; play.pres = p; playRefresh(); };
  $('play-std').addEventListener('click', () => setAll(15, 5, 1013));
  $('play-july').addEventListener('click', () => setAll(33, 24, 1013));
  playRefresh();
}

/* ========================================================================
   MOLECULE BACKGROUND — the page-wide dot field.
   Dot count tracks density, jiggle speed tracks temperature, blue dots are
   water vapor, and drift follows the active section's airflow. Whichever
   section is nearest the viewport's focus line drives the state.
   ======================================================================== */

const bg = {
  cv: null, ctx: null, W: 0, H: 0, dpr: 1,
  dots: [],
  cur: { sigma: 1, tempC: 15, hum: 0.2, wx: 0, wy: 0 },
  label: '', hudT: 0,
};

// registered sections: { el, getState() -> {sigma, tempC, hum, wx, wy, label} }
const SECTIONS = [];
function regSection(id, getState) {
  const el = document.getElementById(id);
  if (el) SECTIONS.push({ el, getState });
}
function activeSection() {
  const focus = window.innerHeight * 0.42;
  let best = SECTIONS[0], bd = Infinity;
  for (const s of SECTIONS) {
    const r = s.el.getBoundingClientRect();
    if (r.top <= focus && r.bottom >= focus) return s;
    const d = Math.min(Math.abs(r.top - focus), Math.abs(r.bottom - focus));
    if (d < bd) { bd = d; best = s; }
  }
  return best;
}

function bgResize() {
  bg.dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  bg.W = window.innerWidth; bg.H = window.innerHeight;
  bg.cv.width = bg.W * bg.dpr; bg.cv.height = bg.H * bg.dpr;
  bg.ctx.setTransform(bg.dpr, 0, 0, bg.dpr, 0, 0);
}

// exaggerated but monotonic: molecular jiggle speed in px/s from temperature
function bgJiggle(tempC) { return clamp(6 + (tempC + 60) * 0.55, 4, 80); }

function bgSpawnDot(vap) {
  return {
    x: Math.random() * bg.W, y: Math.random() * bg.H,
    th: Math.random() * 7, sp0: 0.6 + Math.random() * 0.8,
    vap, a: 0,
  };
}

function bgTick(dt, st) {
  const c = bg.cur;
  const k = Math.min(1, dt * 2.2);            // smooth approach to the target
  c.sigma += (st.sigma - c.sigma) * k;
  c.tempC += (st.tempC - c.tempC) * k;
  c.hum += (st.hum - c.hum) * k;
  c.wx += (st.wx - c.wx) * k;
  c.wy += (st.wy - c.wy) * k;

  // population follows density
  const target = Math.round(clamp(bg.W * bg.H / 9000, 60, 340) * clamp(c.sigma, 0.03, 1.15));
  if (bg.dots.length < target) {
    for (let i = 0; i < 4 && bg.dots.length < target; i++) bg.dots.push(bgSpawnDot(Math.random() < c.hum * 0.45));
  } else if (bg.dots.length > target) {
    bg.dots.splice(0, Math.min(3, bg.dots.length - target));
  }

  // vapor fraction follows humidity (flip a dot or two per frame toward target)
  const wantVap = Math.round(bg.dots.length * clamp(c.hum, 0, 1) * 0.45);
  let haveVap = 0;
  for (const d of bg.dots) if (d.vap) haveVap++;
  if (haveVap !== wantVap && bg.dots.length) {
    const flipTo = haveVap < wantVap;
    for (let i = 0; i < 2; i++) {
      const d = bg.dots[(Math.random() * bg.dots.length) | 0];
      if (d.vap !== flipTo) { d.vap = flipTo; break; }
    }
  }

  const sp = bgJiggle(c.tempC);
  // condensation kicks in as RH approaches 100 %: vapor dots swell into
  // droplets, slow down (droplets are heavy), and a faint fog washes the page
  const cond = clamp((clamp(c.hum, 0, 1) - 0.85) / 0.15, 0, 1);
  const ctx = bg.ctx;
  ctx.clearRect(0, 0, bg.W, bg.H);
  if (cond > 0) {
    ctx.fillStyle = `rgba(175,185,200,${cond * 0.05})`;
    ctx.fillRect(0, 0, bg.W, bg.H);
  }
  for (const d of bg.dots) {
    d.a = Math.min(1, d.a + dt * 1.5);
    d.th += (Math.random() - 0.5) * 3 * dt;
    const mySp = sp * d.sp0 * (d.vap ? 1 - cond * 0.6 : 1);
    d.x += (Math.cos(d.th) * mySp + c.wx) * dt;
    d.y += (Math.sin(d.th) * mySp + c.wy) * dt;
    if (d.x < -8) d.x = bg.W + 8; else if (d.x > bg.W + 8) d.x = -8;
    if (d.y < -8) d.y = bg.H + 8; else if (d.y > bg.H + 8) d.y = -8;
    if (d.vap) {
      if (cond > 0) {   // soft droplet halo
        ctx.beginPath();
        ctx.fillStyle = `rgba(150,190,230,${0.16 * cond * d.a})`;
        ctx.arc(d.x, d.y, 2.2 + cond * 4.5, 0, 7);
        ctx.fill();
      }
      ctx.beginPath();
      ctx.fillStyle = `rgba(91,157,217,${(0.5 + cond * 0.3) * d.a})`;
      ctx.arc(d.x, d.y, 2.2 + cond * 1.6, 0, 7);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.fillStyle = `rgba(168,178,192,${0.34 * d.a})`;
      ctx.arc(d.x, d.y, 1.6, 0, 7);
      ctx.fill();
    }
  }

  // HUD, a few times a second
  bg.hudT -= dt;
  if (bg.hudT <= 0) {
    bg.hudT = 0.25;
    const el = $('mol-hud-line');
    if (el) el.innerHTML = `<b>background air</b> · ${st.label} · ` +
      `${Math.round(c.sigma * 100)} % density · ${Math.round(c.tempC)} °C · RH ${Math.round(clamp(c.hum, 0, 1) * 100)} %`;
  }
}

/* ----- per-section states for the background field ----- */

function relHumidity(tC, dC) {
  return clamp(vaporPresHpa(Math.min(dC, tC)) / vaporPresHpa(tC), 0, 1);
}

function registerBgSections() {
  regSection('sec-play', () => {
    const s = playState();
    return {
      sigma: s.sigma, tempC: play.tC, hum: s.rh, wx: 0, wy: 0,
      label: 'your playground parcel',
    };
  });
  regSection('sec-atmo', () => ({
    sigma: colRho(col.alt) / ISA.RHO0,
    tempC: colTempC(col.alt),
    hum: 0.22, wx: 0, wy: 0,
    label: `the column at ${fmt0(col.alt)} ft`,
  }));
  regSection('sec-da', () => {
    const r = daCompute();
    return {
      sigma: r.sigma, tempC: r.tC,
      hum: relHumidity(r.tC, r.dC), wx: 0, wy: 0,
      label: `on the ramp — DA ${fmt0(r.daFt)} ft`,
    };
  });
  regSection('sec-pitot', () => ({
    sigma: pitSigma(), tempC: isaTempC(pit.alt),
    hum: 0.15,
    wx: 26 + pit.tas * 0.85, wy: 0,          // stream matches the pitot canvas
    label: `relative wind at ${fmt0(pit.alt)} ft`,
  }));
  regSection('sec-forces', () => {
    const c = forcesCalc();
    return {
      sigma: c.sigma, tempC: isaTempC(forces.da),
      hum: 0.18,
      wx: 24 + c.tas * 0.8, wy: 0,             // stream matches the diagram
      label: `in flight at ${fmt0(forces.da)} ft DA`,
    };
  });
  regSection('sec-speeds', () => {
    const toDir = rad(spd.wdir + 180);        // dots drift downwind
    return {
      sigma: sigmaAtDa(spd.alt + 118.8 * spd.isaDev),
      tempC: isaTempC(spd.alt) + spd.isaDev,
      hum: 0.2,
      wx: Math.sin(toDir) * spd.wspd * 2.4,
      wy: -Math.cos(toDir) * spd.wspd * 2.4,
      label: `cruise at ${fmt0(spd.alt)} ft · wind ${String(spd.wdir).padStart(3, '0')}@${spd.wspd}`,
    };
  });
  regSection('sec-parcel', () => {
    const lcl = pcLclFt();
    const surfRH = relHumidity(pc.Ts + pc.heat, pc.Td);
    return {
      sigma: sigmaAtDa(pc.alt),
      tempC: pcParcelT(pc.alt),
      hum: Math.min(1, surfRH + (1 - surfRH) * (lcl > 0 ? pc.alt / lcl : 1)),
      wx: 0,
      wy: clamp(-pc.vel * 0.03, -45, 45),     // dots rise and sink with the parcel
      label: `inside the parcel at ${fmt0(pc.alt)} ft`,
    };
  });
}

/* ============================ shared animation =========================== */

const REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function nearViewport(el) {
  const r = el.getBoundingClientRect();
  return r.bottom > -60 && r.top < window.innerHeight + 60;
}

let lastFrameT = 0;
function masterFrame(t) {
  const dt = lastFrameT ? Math.min(0.05, (t - lastFrameT) / 1000) : 0.016;
  lastFrameT = t;
  if (!REDUCED && bg.ctx) bgTick(dt, activeSection().getState());
  if (nearViewport($('parcel-canvas'))) parcelTick(dt);
  if (nearViewport($('pitot-canvas'))) pitotTick(dt);
  if (nearViewport($('forces-canvas'))) forcesTick(dt);
  requestAnimationFrame(masterFrame);
}

/* ================================= init ================================== */

function initAirLab() {
  // localize defaults to the configured home airport
  da.elev = SITE.airport.elevFt;
  $('da-elev').value = SITE.airport.elevFt;
  initPlay();
  initColumn();
  initDa();
  initPitot();
  initForces();
  initSpeeds();
  initParcel();

  bg.cv = $('mol-bg');
  if (bg.cv && !REDUCED) {
    bg.ctx = bg.cv.getContext('2d');
    bgResize();
  }
  registerBgSections();
  requestAnimationFrame(masterFrame);

  let resizeT;
  window.addEventListener('resize', () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(() => {
      if (bg.ctx) bgResize();
      updateColumn(); drawDaChart(); drawTasChart(); drawWindTriangle(); drawCruiseChart();
    }, 120);
  });
}

document.addEventListener('DOMContentLoaded', initAirLab);
