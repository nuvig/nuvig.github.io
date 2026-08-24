// Skew-T Explorer — fetches Open-Meteo pressure-level forecasts and renders a
// canvas Skew-T log-p diagram with parcel analysis. Plain JS, no dependencies.
// Loaded by skew-t.html after site-config.js (SITE global).
//
// All thermodynamics use Bolton (1980) formulas; CAPE/CIN are computed from
// the plotted profile without virtual-temperature correction (noted in UI).

(() => {
  'use strict';

  // ---------------------------------------------------------------- config
  const LEVELS = [1000, 975, 950, 925, 900, 850, 800, 750, 700, 650, 600,
                  550, 500, 450, 400, 350, 300, 250, 200, 150, 100];
  const FORECAST_DAYS = 3;                    // 72 hourly steps
  const P_TOP = 100, P_BOT = 1050;            // plot pressure range, hPa
  const T_MIN = -40, T_MAX = 45;              // °C at the bottom of the plot
  const TZ = SITE.weather.timeZone;

  const Rd = 287.05, Cp = 1004, Lv = 2.501e6, EPS = 0.622, G = 9.81;

  // ---------------------------------------------------------------- thermo
  const esat = T => 6.112 * Math.exp(17.67 * T / (T + 243.5));      // hPa, T °C
  const mixRatio = (p, T) => { const e = esat(T); return EPS * e / (p - e); }; // kg/kg
  // temperature (°C) at which mixing ratio w (kg/kg) saturates at pressure p
  const tempAtMixRatio = (p, w) => {
    const e = w * p / (EPS + w);
    const ln = Math.log(e / 6.112);
    return 243.5 * ln / (17.67 - ln);
  };
  const theta = (p, T) => (T + 273.15) * Math.pow(1000 / p, 0.2854) - 273.15;
  const tempOnDryAdiabat = (p, th) => (th + 273.15) * Math.pow(p / 1000, 0.2854) - 273.15;

  // dT/dp (°C per hPa) along a saturated adiabat
  function moistLapse(p, T) {
    const Tk = T + 273.15;
    const rs = mixRatio(p, T);
    const num = Rd * Tk + Lv * rs;
    const den = Cp + (Lv * Lv * rs * EPS) / (Rd * Tk * Tk);
    return num / den / p;
  }

  // integrate a moist adiabat from (p0,T0) down to pressure p1 (p1 < p0 = up)
  function followMoist(p0, T0, p1) {
    let p = p0, T = T0;
    const step = p1 < p0 ? -4 : 4;
    while ((step < 0 && p > p1) || (step > 0 && p < p1)) {
      const dp = Math.abs(p1 - p) < Math.abs(step) ? p1 - p : step;
      const k1 = moistLapse(p, T);
      const k2 = moistLapse(p + dp / 2, T + k1 * dp / 2);
      T += k2 * dp;
      p += dp;
    }
    return T;
  }

  // Bolton LCL from surface T/Td (°C) and pressure (hPa) → {p, T}
  function lclFrom(p, T, Td) {
    const Tk = T + 273.15, Tdk = Td + 273.15;
    const Tl = 1 / (1 / (Tdk - 56) + Math.log(Tk / Tdk) / 800) + 56;
    const pl = p * Math.pow(Tl / Tk, 1 / 0.2854);
    return { p: pl, T: Tl - 273.15 };
  }

  const dewFromRH = (T, rh) => {
    const e = esat(T) * Math.max(rh, 0.1) / 100;
    const ln = Math.log(e / 6.112);
    return 243.5 * ln / (17.67 - ln);
  };

  // ---------------------------------------------------------------- state
  const $ = id => document.getElementById(id);
  // default forecast site; any-airport lookup replaces it
  let curSite = { id: 'KDCA', name: 'Ronald Reagan Washington National Airport',
                  lat: 38.8521, lon: -77.0377, elevFt: 15 };
  let data = null;          // parsed API response for current site+model
  let hourIdx = 0;
  let sounding = null;      // current profile array
  let parcel = null;        // current parcel analysis
  const cache = new Map();

  function setSiteTitle() {
    $('model-site-name').textContent = `${curSite.id} — ${curSite.name}`;
  }

  // ------------------------------------------------- any-airport lookup
  // Geocode an ICAO/IATA-style code via api.weather.gov station metadata
  // (CORS-open) and add it to the site list. US stations only.
  async function lookupAirport(codeRaw) {
    const code = codeRaw.trim().toUpperCase();
    if (!/^[A-Z0-9]{3,4}$/.test(code)) throw new Error('enter a 3–4 letter airport id');
    const tries = code.length === 3 ? ['K' + code, code] : [code];
    for (const id of tries) {
      const r = await fetch('https://api.weather.gov/stations/' + id);
      if (!r.ok) continue;
      const j = await r.json();
      const [lon, lat] = j.geometry.coordinates;
      const elevM = j.properties.elevation ? j.properties.elevation.value : 0;
      return { id, name: j.properties.name || id, lat, lon,
               elevFt: Math.round((elevM || 0) / 0.3048) };
    }
    throw new Error(code + ' not found (US stations only)');
  }

  async function addAirport() {
    const inp = $('site-input');
    $('status-msg').textContent = 'looking up ' + inp.value.toUpperCase() + '…';
    try {
      curSite = await lookupAirport(inp.value);
      inp.value = '';
      setSiteTitle();
      $('status-msg').textContent = '';
      load();
    } catch (e) {
      $('status-msg').textContent = e.message;
    }
  }

  // ---------------------------------------------------------------- fetch
  function apiUrl(site, model) {
    const vars = [];
    for (const L of LEVELS) {
      vars.push(`temperature_${L}hPa`, `relative_humidity_${L}hPa`,
                `wind_speed_${L}hPa`, `wind_direction_${L}hPa`,
                `geopotential_height_${L}hPa`);
    }
    vars.push('temperature_2m', 'dew_point_2m', 'surface_pressure',
              'wind_speed_10m', 'wind_direction_10m');
    return 'https://api.open-meteo.com/v1/forecast' +
      `?latitude=${site.lat}&longitude=${site.lon}` +
      `&hourly=${vars.join(',')}` +
      `&models=${model}&windspeed_unit=kn&timezone=UTC&forecast_days=${FORECAST_DAYS}`;
  }

  async function load() {
    const site = curSite;
    const model = $('model-select').value;
    const key = site.id + '|' + model;
    $('status-msg').textContent = cache.has(key) ? '' : 'loading…';
    try {
      if (!cache.has(key)) {
        const r = await fetch(apiUrl(site, model));
        if (!r.ok) throw new Error('HTTP ' + r.status);
        cache.set(key, (await r.json()).hourly);
      }
      data = cache.get(key);
      $('status-msg').textContent = '';
      const slider = $('hour-slider');
      slider.max = data.time.length - 1;
      // default to the current hour on first load
      if (sounding === null) {
        const now = Date.now();
        hourIdx = Math.max(0, data.time.findIndex(t => new Date(t + 'Z') >= now));
      }
      hourIdx = Math.min(hourIdx, data.time.length - 1);
      slider.value = hourIdx;
      update();
    } catch (e) {
      $('status-msg').textContent = 'fetch failed — ' + e.message;
    }
  }

  // ---------------------------------------------------------------- profile
  function buildSounding(i) {
    const h = data;
    const sp = h.surface_pressure[i];
    const prof = [];
    if (sp != null) {
      prof.push({
        p: sp, T: h.temperature_2m[i], Td: h.dew_point_2m[i],
        ws: h.wind_speed_10m[i], wd: h.wind_direction_10m[i], z: 0, sfc: true,
      });
    }
    for (const L of LEVELS) {
      if (sp != null && L >= sp - 2) continue;        // below ground
      const T = h[`temperature_${L}hPa`][i];
      const rh = h[`relative_humidity_${L}hPa`][i];
      if (T == null || rh == null) continue;
      prof.push({
        p: L, T, Td: dewFromRH(T, rh),
        ws: h[`wind_speed_${L}hPa`][i], wd: h[`wind_direction_${L}hPa`][i],
        z: h[`geopotential_height_${L}hPa`][i],
      });
    }
    prof.sort((a, b) => b.p - a.p);
    // surface z: geopotential heights are MSL; make z AGL using site elevation
    const elevM = curSite.elevFt * 0.3048;
    for (const pt of prof) if (!pt.sfc) pt.z = Math.max(0, pt.z - elevM);
    return prof;
  }

  const interpEnv = (prof, p) => {
    for (let i = 0; i < prof.length - 1; i++) {
      const a = prof[i], b = prof[i + 1];
      if (p <= a.p && p >= b.p) {
        const f = Math.log(a.p / p) / Math.log(a.p / b.p);
        return { T: a.T + f * (b.T - a.T), Td: a.Td + f * (b.Td - a.Td),
                 z: a.z + f * (b.z - a.z) };
      }
    }
    return null;
  };

  // Surface-based parcel: path + CAPE/CIN + LCL/LFC/EL
  function analyzeParcel(prof) {
    const sfc = prof[0];
    const lcl = lclFrom(sfc.p, sfc.T, sfc.Td);
    const th = theta(sfc.p, sfc.T);
    const path = [];                       // [{p, T}]
    // dry segment
    for (let p = sfc.p; p > lcl.p; p -= 5) path.push({ p, T: tempOnDryAdiabat(p, th) });
    path.push({ p: lcl.p, T: lcl.T });
    // moist segment
    let T = lcl.T;
    for (let p = lcl.p; p > P_TOP; ) {
      const pn = Math.max(p - 5, P_TOP);
      T = followMoist(p, T, pn);
      path.push({ p: pn, T });
      p = pn;
    }
    // CAPE / CIN via ∫ Rd (Tp−Te) dlnp
    let cape = 0, cin = 0, lfc = null, el = null;
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i], b = path[i + 1];
      const ea = interpEnv(prof, a.p), eb = interpEnv(prof, b.p);
      if (!ea || !eb) continue;
      const buoy = ((a.T - ea.T) + (b.T - eb.T)) / 2;        // °C = K diff
      const dlnp = Math.log(a.p / b.p);
      const seg = Rd * buoy * dlnp;                          // J/kg
      if (buoy > 0) {
        if (lfc === null && a.p <= sfc.p) lfc = a.p;
        if (lfc !== null) { cape += seg; el = b.p; }
      } else if (lfc === null && a.p <= lcl.p) {
        cin += seg;                                          // cap below LFC
      }
    }
    return { path, lcl, lfc, el, cape: Math.round(cape), cin: Math.round(cin) };
  }

  // ---------------------------------------------------------------- indices
  const atP = (prof, p) => interpEnv(prof, p);
  const ftAtP = (prof, p) => { const e = atP(prof, p); return e ? e.z / 0.3048 : null; };

  function computeIndices(prof, pcl) {
    const out = [];
    const push = (k, v, cls) => out.push({ k, v, cls });
    const sfc = prof[0];

    const capeCls = pcl.cape > 1500 ? 'bad' : pcl.cape > 500 ? 'warn' : 'good';
    push('CAPE (sfc parcel)', `${pcl.cape} J/kg`, capeCls);
    push('CIN', `${pcl.cin} J/kg`);
    push('LCL — est. cu base', fmtFt(ftAtP(prof, pcl.lcl.p)));
    push('LFC', pcl.lfc ? fmtFt(ftAtP(prof, pcl.lfc)) : '—');
    push('EL — est. storm top', pcl.el && pcl.cape > 0 ? fmtFt(ftAtP(prof, pcl.el)) : '—');

    // freezing level: first crossing of 0°C going up
    let fz = null;
    for (let i = 0; i < prof.length - 1; i++) {
      const a = prof[i], b = prof[i + 1];
      if ((a.T >= 0) !== (b.T >= 0)) {
        const f = a.T / (a.T - b.T);
        fz = a.z + f * (b.z - a.z);
        break;
      }
    }
    push('Freezing level', fz === null ? (sfc.T < 0 ? 'surface' : 'above chart')
                                       : fmtFt(fz / 0.3048));

    const e850 = atP(prof, 850), e700 = atP(prof, 700), e500 = atP(prof, 500);
    if (e500) {
      const p500 = pcl.path.find(q => q.p <= 500);
      if (p500) {
        const li = e500.T - p500.T;
        push('Lifted index', li.toFixed(1) + ' °C',
             li < -4 ? 'bad' : li < 0 ? 'warn' : 'good');
      }
    }
    if (e850 && e700 && e500) {
      const K = e850.T - e500.T + e850.Td - (e700.T - e700.Td);
      push('K index', K.toFixed(0));
    }

    // precipitable water, mm
    let pw = 0;
    for (let i = 0; i < prof.length - 1; i++) {
      const a = prof[i], b = prof[i + 1];
      const qa = mixRatio(a.p, a.Td), qb = mixRatio(b.p, b.Td);
      pw += 0.5 * (qa + qb) * (a.p - b.p) * 100 / G;
    }
    push('Precipitable water', (pw / 25.4).toFixed(2) + ' in');

    // 0–6 km bulk shear
    const top = envAtHeight(prof, 6000);
    if (top) {
      const [u1, v1] = windUV(sfc.ws, sfc.wd), [u2, v2] = windUV(top.ws, top.wd);
      const shr = Math.hypot(u2 - u1, v2 - v1);
      push('0–6 km shear', shr.toFixed(0) + ' kt', shr > 40 ? 'warn' : undefined);
    }
    return out;
  }

  const windUV = (ws, wd) => {
    const r = (wd + 180) * Math.PI / 180;
    return [ws * Math.sin(r), ws * Math.cos(r)];
  };
  function envAtHeight(prof, zm) {
    for (let i = 0; i < prof.length - 1; i++) {
      const a = prof[i], b = prof[i + 1];
      if (zm >= a.z && zm <= b.z) {
        const f = (zm - a.z) / (b.z - a.z);
        return { ws: a.ws + f * (b.ws - a.ws), wd: lerpDir(a.wd, b.wd, f) };
      }
    }
    return null;
  }
  const lerpDir = (a, b, f) => {
    let d = ((b - a + 540) % 360) - 180;
    return (a + f * d + 360) % 360;
  };
  const fmtFt = ft => ft == null ? '—'
    : ft >= 10000 ? (ft / 1000).toFixed(1) + ' kft AGL'
    : Math.round(ft / 100) * 100 + ' ft AGL';

  // ---------------------------------------------------------------- summary
  function summaryHTML(prof, pcl) {
    const bits = [];
    if (pcl.cape > 1500 && pcl.cin > -50)
      bits.push('<strong style="color:#ef4444">Strong instability with little cap</strong> — thunderstorms likely if lift arrives.');
    else if (pcl.cape > 500)
      bits.push('<strong style="color:#f59e0b">Moderately unstable</strong> — expect building cumulus; watch for storms.');
    else if (pcl.cape > 50)
      bits.push('Mildly unstable — fair-weather cumulus possible.');
    else
      bits.push('<strong style="color:#22c55e">Stable profile</strong> — convection unlikely.');

    // inversion in the lowest ~2 km
    for (let i = 0; i < prof.length - 1 && prof[i + 1].z < 2500; i++) {
      if (prof[i + 1].T > prof[i].T + 0.3) {
        bits.push(`Low-level inversion near ${fmtFt(prof[i].z / 0.3048)} — haze and bumps trapped below, smoother above.`);
        break;
      }
    }
    // saturated layers → cloud decks
    const decks = [];
    for (const pt of prof) {
      if (pt.T - pt.Td < 3 && pt.z > 100 && pt.p > 300)
        decks.push(pt.z / 0.3048);
    }
    if (decks.length)
      bits.push(`Moist layers (T−Td &lt; 3 °C) around ${fmtFt(decks[0])}${decks.length > 1 ? ` and ${fmtFt(decks[decks.length - 1])}` : ''} — likely cloud.`);
    else
      bits.push('No saturated layers — mostly clear column.');

    const icing = prof.filter(pt => pt.T <= 0 && pt.T >= -20 && pt.T - pt.Td < 3);
    if (icing.length)
      bits.push(`<strong style="color:#f59e0b">Icing band</strong>: moisture at ${fmtFt(icing[0].z / 0.3048)}–${fmtFt(icing[icing.length - 1].z / 0.3048)} between 0 and −20 °C.`);

    return bits.map(b => `<p>${b}</p>`).join('');
  }

  // ---------------------------------------------------------------- drawing
  const canvas = $('skewt');
  const ctx = canvas.getContext('2d');
  let PL = { left: 44, right: 46, top: 10, bottom: 24, W: 0, H: 0, cw: 0, ch: 0 };

  const yOf = p => PL.top + PL.H *
    (Math.log(p) - Math.log(P_TOP)) / (Math.log(P_BOT) - Math.log(P_TOP));
  const xOf = (T, y) => PL.left + PL.W * (T - T_MIN) / (T_MAX - T_MIN)
    + (PL.top + PL.H - y);                                   // 45° skew
  const pOfY = y => Math.exp(Math.log(P_TOP) +
    (y - PL.top) / PL.H * (Math.log(P_BOT) - Math.log(P_TOP)));

  function sizeCanvas() {
    const cw = canvas.clientWidth || 700;
    // Near-square by preference, but never taller than the window: on a wide
    // screen the square aspect would push the bottom of the sounding (and the
    // hover boxes) below the fold. The 45° skew is a pixel offset, so a
    // wider-than-tall plot is still a correct skew-T — it just spends the
    // extra width on temperature resolution.
    const ch = Math.round(Math.min(cw * 1.02,
                                   Math.max(520, window.innerHeight * 0.85)));
    const dpr = window.devicePixelRatio || 1;
    canvas.width = cw * dpr; canvas.height = ch * dpr;
    canvas.style.height = ch + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    PL.cw = cw; PL.ch = ch;
    PL.W = cw - PL.left - PL.right;
    PL.H = ch - PL.top - PL.bottom;
  }

  function line(pts, color, width, dash) {
    ctx.beginPath();
    pts.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
    ctx.strokeStyle = color; ctx.lineWidth = width;
    ctx.setLineDash(dash || []);
    ctx.stroke(); ctx.setLineDash([]);
  }

  function draw() {
    sizeCanvas();
    ctx.fillStyle = '#141414';
    ctx.fillRect(0, 0, PL.cw, PL.ch);
    ctx.save();
    ctx.beginPath();
    ctx.rect(PL.left, PL.top, PL.W, PL.H);
    ctx.clip();

    // isotherms every 10°C (skewed)
    for (let T = -110; T <= 40; T += 10) {
      const yb = PL.top + PL.H, yt = PL.top;
      const col = T === 0 ? '#4a6a8a' : '#2a3540';
      line([[xOf(T, yb), yb], [xOf(T, yt), yt]], col, T === 0 ? 1.4 : 1);
    }
    // dry adiabats
    for (let th = -30; th <= 160; th += 10) {
      const pts = [];
      for (let p = P_BOT; p >= P_TOP; p -= 10) {
        const y = yOf(p);
        pts.push([xOf(tempOnDryAdiabat(p, th), y), y]);
      }
      line(pts, '#3d3226', 1);
    }
    // moist adiabats (start temps at 1000 hPa)
    for (let T0 = -30; T0 <= 35; T0 += 5) {
      const pts = [];
      let T = T0;
      for (let p = 1000; p >= 200; p -= 10) {
        const y = yOf(p);
        pts.push([xOf(T, y), y]);
        T = followMoist(p, T, p - 10);
      }
      line(pts, '#26443a', 1);
    }
    // mixing-ratio lines
    for (const w of [0.5, 1, 2, 3, 5, 8, 12, 20]) {
      const pts = [];
      for (let p = 1050; p >= 400; p -= 25) {
        const y = yOf(p);
        pts.push([xOf(tempAtMixRatio(p, w / 1000), y), y]);
      }
      line(pts, '#3d3450', 1, [3, 4]);
      const [lx, ly] = pts[pts.length - 1];
      ctx.fillStyle = '#5a4d75'; ctx.font = '9px sans-serif';
      ctx.fillText(String(w), lx - 4, ly - 3);
    }
    // isobars
    for (let p = 1000; p >= P_TOP; p -= 100) {
      const y = yOf(p);
      line([[PL.left, y], [PL.left + PL.W, y]], '#2c2c2c', 1);
    }

    if (sounding) {
      // CAPE (red) / CIN (blue) fill between parcel and environment
      if (parcel) drawBuoyancy();
      // parcel path
      if (parcel) line(parcel.path.map(q => { const y = yOf(q.p); return [xOf(q.T, y), y]; }),
                       'rgba(255,255,255,0.75)', 1.4, [6, 4]);
      // dewpoint + temperature traces
      line(sounding.map(q => { const y = yOf(q.p); return [xOf(q.Td, y), y]; }), '#22c55e', 2.2);
      line(sounding.map(q => { const y = yOf(q.p); return [xOf(q.T, y), y]; }), '#ef4444', 2.2);
    }
    ctx.restore();

    // frame + axis labels
    ctx.strokeStyle = '#444'; ctx.lineWidth = 1;
    ctx.strokeRect(PL.left, PL.top, PL.W, PL.H);
    ctx.fillStyle = '#777'; ctx.font = '11px sans-serif'; ctx.textAlign = 'right';
    for (let p = 1000; p >= P_TOP; p -= 100) {
      const y = yOf(p);
      ctx.fillText(String(p), PL.left - 5, y + 4);
      if (sounding) {
        const e = atP(sounding, p);
        if (e && e.z > 50) {
          ctx.save(); ctx.textAlign = 'left'; ctx.fillStyle = '#4d4d4d';
          ctx.fillText(Math.round(e.z / 304.8) + ' kft', PL.left + 4, y - 3);
          ctx.restore();
        }
      }
    }
    ctx.textAlign = 'center';
    for (let T = -40; T <= 40; T += 10)
      ctx.fillText(T + '°', xOf(T, PL.top + PL.H), PL.top + PL.H + 15);
    ctx.save();
    ctx.translate(12, PL.top + PL.H / 2); ctx.rotate(-Math.PI / 2);
    ctx.fillText('pressure (hPa)', 0, 0);
    ctx.restore();

    if (sounding) drawBarbs();
    ctx.textAlign = 'left';
  }

  function drawBuoyancy() {
    for (const positive of [true, false]) {
      ctx.beginPath();
      let open = false;
      const seg = [];
      for (const q of parcel.path) {
        const e = atP(sounding, q.p);
        if (!e) continue;
        const diff = q.T - e.T;
        const inside = positive ? diff > 0 && parcel.lfc && q.p <= parcel.lfc
                                : diff < 0 && q.p <= sounding[0].p && (!parcel.lfc || q.p > parcel.lfc);
        if (inside) seg.push({ p: q.p, Tp: q.T, Te: e.T });
        else if (seg.length) { fillSeg(seg, positive); seg.length = 0; }
      }
      if (seg.length) fillSeg(seg, positive);
    }
  }
  function fillSeg(seg, positive) {
    ctx.beginPath();
    seg.forEach((s, i) => {
      const y = yOf(s.p), x = xOf(s.Tp, y);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    for (let i = seg.length - 1; i >= 0; i--) {
      const y = yOf(seg[i].p);
      ctx.lineTo(xOf(seg[i].Te, y), y);
    }
    ctx.closePath();
    ctx.fillStyle = positive ? 'rgba(239,68,68,0.18)' : 'rgba(74,158,255,0.16)';
    ctx.fill();
  }

  function drawBarbs() {
    const bx = PL.left + PL.W + 24;
    ctx.strokeStyle = '#9ab'; ctx.fillStyle = '#9ab'; ctx.lineWidth = 1.2;
    let lastY = 1e9;
    for (const pt of sounding) {
      if (pt.ws == null || pt.wd == null) continue;
      const y = yOf(pt.p);
      if (Math.abs(lastY - y) < 16) continue;       // avoid overlap
      lastY = y;
      drawBarb(bx, y, pt.ws, pt.wd);
    }
  }
  function drawBarb(x, y, ws, wd) {
    const len = 22;
    const a = (wd + 180) * Math.PI / 180;           // shaft points where wind goes
    const ux = Math.sin(a), uy = -Math.cos(a);      // toward the arrow head
    const tx = x - ux * len, ty = y - uy * len;     // tail (wind comes from here)
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(tx, ty); ctx.stroke();
    let spd = Math.round(ws / 5) * 5, off = 0;
    const px = -uy, py = ux;                        // perpendicular
    const feather = (frac, dep) => {
      const fx = tx + ux * off, fy = ty + uy * off;
      ctx.beginPath(); ctx.moveTo(fx, fy);
      ctx.lineTo(fx + px * dep - ux * dep * 0.35, fy + py * dep - uy * dep * 0.35);
      ctx.stroke();
      off += frac;
    };
    while (spd >= 50) {
      const fx = tx + ux * off, fy = ty + uy * off;
      ctx.beginPath(); ctx.moveTo(fx, fy);
      ctx.lineTo(fx + px * 8 - ux * 4, fy + py * 8 - uy * 4);
      ctx.lineTo(fx + ux * 6, fy + uy * 6);
      ctx.closePath(); ctx.fill();
      off += 7; spd -= 50;
    }
    while (spd >= 10) { feather(5, 8); spd -= 10; }
    if (spd >= 5) feather(4, 4.5);
    if (ws < 3) { ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI * 2); ctx.stroke(); }
  }

  // ---------------------------------------------------------------- hover
  // Element-aware hover: identify what's under the cursor (a trace, the
  // parcel, the shaded buoyancy areas, the barbs, or the background grid)
  // and explain what it implies at that specific level.
  const WHAT = {
    temp:   ['Temperature trace', 'The red line — actual air temperature at each height. Its slope is the stability story: leaning left fast = cooling quickly with height (unstable), leaning right = an inversion (very stable).'],
    dew:    ['Dewpoint trace', 'The green line — how much moisture is in the air. Read it together with the red line: the gap between them says how close the air is to saturation (cloud).'],
    parcel: ['Parcel path', 'The dashed white line — what a bubble of surface air would do if lifted: cooling fast while clear, slower once it condenses into cloud. Comparing it to the red line tells you whether it keeps rising on its own.'],
    cape:   ['CAPE — positive buoyancy area', 'Red shading — here the lifted parcel is warmer than the air around it, so it floats upward on its own. The bigger this area, the stronger the updrafts: this is thunderstorm fuel.'],
    cin:    ['CIN — the cap', 'Blue shading — here the lifted parcel is colder than its surroundings, so it resists rising. This is the lid that must be broken (by heating or lift) before the CAPE above can be released.'],
    barbs:  ['Wind barbs', 'Wind at each level, plotted °true: half barb 5 kt, full barb 10 kt, flag 50 kt. Watch how they change with height — that change is shear.'],
    bg:     ['Background grid', 'Just graph paper: skewed blue isotherms (constant temperature), brown dry adiabats (path of unsaturated rising air), green moist adiabats (saturated rising air), dashed purple mixing-ratio lines (constant moisture).'],
  };

  const parcelTAt = p => {
    if (!parcel) return null;
    const path = parcel.path;
    if (p > path[0].p) return null;
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i], b = path[i + 1];
      if (p <= a.p && p >= b.p) {
        const f = (a.p - p) / ((a.p - b.p) || 1);
        return a.T + f * (b.T - a.T);
      }
    }
    return null;
  };

  const fmtFtC = ft => Math.round(ft / 100) * 100 >= 10000
    ? (Math.round(ft / 100) / 10).toFixed(1) + ' kft' : Math.round(ft / 100) * 100 + ' ft';

  // °C per 1000 ft over the ~50 hPa below this level (negative = cooling aloft)
  function lapseBelow(p) {
    const lo = atP(sounding, Math.min(p * 1.07, sounding[0].p));
    const hi = atP(sounding, p);
    if (!lo || !hi || hi.z - lo.z < 30) return null;
    return (hi.T - lo.T) / (hi.z - lo.z) * 304.8;
  }

  function meaningAt(el, p, e, w, x, y) {
    const ft = e.z / 0.3048;
    const here = `At ${fmtFtC(ft)} AGL (${Math.round(p)} hPa): `;
    const spread = e.T - e.Td;
    const bits = [];
    if (el === 'temp') {
      bits.push(`${here}the air is <b>${e.T.toFixed(1)} °C</b>${e.T <= 0 ? ' — below freezing' : ''}.`);
      const lr = lapseBelow(p);
      if (lr != null) {
        if (lr > 0.4) bits.push(`Temperature is <b>rising</b> with height here — an inversion. Expect smooth air above it, with haze, and bumps trapped underneath; climbing through it often feels like a switch.`);
        else if (lr > -1.1) bits.push(`Cooling only ${(-lr).toFixed(1)} °C per 1,000 ft — a <b>stable</b> layer that resists vertical motion: smoother air, but also where stratus and poor visibility like to sit.`);
        else if (lr > -2.6) bits.push(`Cooling ${(-lr).toFixed(1)} °C per 1,000 ft — a normal, conditionally unstable lapse rate.`);
        else bits.push(`Cooling fast (${(-lr).toFixed(1)} °C per 1,000 ft) — a <b>steep, unstable</b> layer: good thermals, bumpy air, and fuel for convection.`);
      }
    } else if (el === 'dew') {
      bits.push(`${here}dewpoint <b>${e.Td.toFixed(1)} °C</b>, ${spread.toFixed(1)} °C below the temperature.`);
      if (spread < 2) bits.push(`That's essentially <b>saturated — expect cloud at this level</b>.`);
      else if (spread < 5) bits.push(`Humid — near-saturated air; scattered cloud or building cumulus territory.`);
      else bits.push(`A wide spread — <b>dry air</b> at this level, no cloud here.`);
      if (spread < 3 && e.T <= 0 && e.T >= -20)
        bits.push(`⚠ Moisture with the temperature between 0 and −20 °C: this level is in the <b>structural icing band</b>.`);
    } else if (el === 'parcel') {
      const pT = parcelTAt(p);
      const diff = pT != null ? pT - e.T : null;
      if (p > parcel.lcl.p)
        bits.push(`${here}the rising surface parcel is still <b>clear air</b>, cooling ~3 °C per 1,000 ft. It saturates (cloud base) at ${fmtFtC((ftAtP(sounding, parcel.lcl.p) || 0))}.`);
      else if (diff != null && diff < 0 && (!parcel.lfc || p > parcel.lfc))
        bits.push(`${here}the parcel is <b>${(-diff).toFixed(1)} °C colder</b> than the surrounding air — inside the cap (CIN). It only keeps rising if something pushes it (heating, terrain, a front).`);
      else if (diff != null && diff > 0 && (!parcel.el || p > parcel.el || parcel.cape === 0))
        bits.push(`${here}the parcel is <b>${diff.toFixed(1)} °C warmer</b> than its surroundings — freely buoyant, accelerating upward. This is the updraft region of a building cumulus or storm.`);
      else
        bits.push(`${here}parcel and environment are about the same temperature — near the equilibrium level, where updrafts run out of push (storm-top territory).`);
    } else if (el === 'cape') {
      const pT = parcelTAt(p);
      bits.push(`${here}lifted air would be <b>${pT != null ? (pT - e.T).toFixed(1) : '?'} °C warmer</b> than its surroundings — actively buoyant. Total CAPE in this sounding: <b>${parcel.cape} J/kg</b>.`);
    } else if (el === 'cin') {
      const pT = parcelTAt(p);
      bits.push(`${here}lifted air would be <b>${pT != null ? (e.T - pT).toFixed(1) : '?'} °C colder</b> than its surroundings — suppressed. Total CIN: <b>${parcel.cin} J/kg</b>${parcel.cin > -25 ? ' (a weak cap — easily broken)' : parcel.cin < -100 ? ' (a strong lid — storms unlikely unless it erodes)' : ''}.`);
    } else if (el === 'barbs') {
      if (w.ws != null) {
        bits.push(`${here}wind <b>${Math.round(w.wd)}°T at ${Math.round(w.ws)} kt</b>.`);
        const below = envAtHeight(sounding, Math.max(0, e.z - 610));
        if (below && below.ws != null) {
          const [u1, v1] = windUV(below.ws, below.wd), [u2, v2] = windUV(w.ws, w.wd);
          const shr = Math.hypot(u2 - u1, v2 - v1);
          if (shr > 15) bits.push(`⚠ It changes by <b>${Math.round(shr)} kt</b> over the 2,000 ft below — significant shear: expect turbulence, and LLWS if this is near the surface.`);
          else bits.push(`Changing only ${Math.round(shr)} kt over the 2,000 ft below — little shear here.`);
        }
      } else bits.push(`${here}no wind data at this level.`);
    } else {                                       // background grid
      const Tcur = T_MIN + (x - PL.left - (PL.top + PL.H - y)) / PL.W * (T_MAX - T_MIN);
      const w_gkg = mixRatio(p, Tcur) * 1000;
      bits.push(`${here}this spot on the grid is <b>${Tcur.toFixed(0)} °C</b>. Air here would have a potential temperature of ${theta(p, Tcur).toFixed(0)} °C and hold ${w_gkg > 0 ? w_gkg.toFixed(1) : '0'} g/kg of moisture if saturated.`);
      bits.push(`The nearest data is: T ${e.T.toFixed(1)} °C, Td ${e.Td.toFixed(1)} °C at this height.`);
    }
    return bits.map(b => `<p style="margin:4px 0">${b}</p>`).join('');
  }

  function resetHover() {
    $('hov-what-t').textContent = 'What am I looking at?';
    $('hov-what-b').textContent = 'Point at any line on the diagram — this box names it and says what it is.';
    $('hov-here-t').textContent = 'What does it mean here?';
    $('hov-here-b').textContent = 'This box reads the value under your cursor and says what it implies at that altitude.';
  }

  canvas.addEventListener('mousemove', ev => {
    if (!sounding) return;
    const r = canvas.getBoundingClientRect();
    const x = ev.clientX - r.left, y = ev.clientY - r.top;
    if (y < PL.top || y > PL.top + PL.H || x < PL.left) { resetHover(); return; }
    const p = pOfY(y);
    const e = atP(sounding, p);
    if (!e) { resetHover(); return; }
    const w = envAtHeight(sounding, e.z) || sounding[0];

    let el;
    if (x > PL.left + PL.W) el = 'barbs';
    else {
      const xT = xOf(e.T, y), xTd = xOf(e.Td, y);
      const pT = parcelTAt(p);
      const xP = pT == null ? 1e9 : xOf(pT, y);
      const dT = Math.abs(x - xT), dTd = Math.abs(x - xTd), dP = Math.abs(x - xP);
      const best = Math.min(dT, dTd, dP);
      if (best <= 9) el = best === dTd ? 'dew' : best === dT ? 'temp' : 'parcel';
      else if (parcel && pT != null && x > Math.min(xP, xT) + 2 && x < Math.max(xP, xT) - 2)
        el = pT > e.T ? 'cape' : 'cin';
      else el = 'bg';
    }
    $('hov-what-t').textContent = WHAT[el][0];
    $('hov-what-b').textContent = WHAT[el][1];
    $('hov-here-t').textContent = 'At your cursor';
    $('hov-here-b').innerHTML = meaningAt(el, p, e, w, x, y);
  });
  canvas.addEventListener('mouseleave', resetHover);
  resetHover();

  // ---------------------------------------------------------------- update
  function update() {
    if (!data) return;
    sounding = buildSounding(hourIdx);
    parcel = sounding.length > 5 ? analyzeParcel(sounding) : null;
    const t = new Date(data.time[hourIdx] + 'Z');
    $('valid-label').textContent = 'valid ' + t.toLocaleString('en-US', {
      timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
    }) + ' L';
    draw();
    if (parcel) {
      const idx = computeIndices(sounding, parcel);
      $('indices').innerHTML = idx.map(r =>
        `<div class="kv"><span class="k">${r.k}</span>` +
        `<span class="v${r.cls ? ' ' + r.cls : ''}">${r.v}</span></div>`).join('');
      $('summary').innerHTML = summaryHTML(sounding, parcel);
    } else {
      $('indices').innerHTML = '<div class="kv"><span class="k">no data at this hour</span></div>';
      $('summary').textContent = '';
    }
  }

  // ---------------------------------------------------------------- wiring
  $('hour-slider').addEventListener('input', ev => { hourIdx = +ev.target.value; update(); });
  $('prev-hr').addEventListener('click', () => {
    hourIdx = Math.max(0, hourIdx - 1); $('hour-slider').value = hourIdx; update();
  });
  $('next-hr').addEventListener('click', () => {
    hourIdx = Math.min(+$('hour-slider').max, hourIdx + 1);
    $('hour-slider').value = hourIdx; update();
  });
  $('site-go').addEventListener('click', addAirport);
  $('site-input').addEventListener('keydown', ev => { if (ev.key === 'Enter') addAirport(); });
  $('model-select').addEventListener('change', load);
  let resizeT;
  window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(draw, 150); });

  setSiteTitle();
  load();

  // Analysis engine shared with the observed-sounding module (skewt-obs.js):
  // works on any profile array of {p,T,Td,ws,wd,z} sorted surface-first.
  window.SkewTCore = { analyzeParcel, computeIndices, summaryHTML };
})();
