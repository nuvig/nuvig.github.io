// Observed soundings — Storm Prediction Center image viewer with an
// explain-on-hover overlay, backed by the actual RAOB data from the Iowa
// Environmental Mesonet (CORS-open) run through the same analysis engine as
// the model soundings (window.SkewTCore, exposed by skewt.js).
//
// The SPC SHARP gif has a fixed layout (1180×826), so hover regions are
// defined in fractional coordinates and scale with the displayed image.
// Inside the Skew-T panel the pressure axis is log-p from 100 hPa at the top
// gridline to 1000 hPa near the bottom, which lets us convert cursor height
// into pressure and read the *observed* values at that level out of the IEM
// profile — the text under the cursor describes exactly what the pixels show.

(() => {
  'use strict';

  const $ = id => document.getElementById(id);

  // ------------------------------------------------------------- cycles
  // RAOBs launch 00Z/12Z; SPC images are typically up ~1.5 h later.
  function recentCycles(n) {
    const out = [];
    let t = new Date();
    // step back to the most recent cycle that should be published
    const h = t.getUTCHours();
    let cyc = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(),
                                h >= 14 ? 12 : h >= 2 ? 0 : -12));
    for (let i = 0; i < n; i++) {
      out.push(new Date(cyc));
      cyc = new Date(cyc.getTime() - 12 * 3600e3);
    }
    return out;
  }
  const p2 = v => String(v).padStart(2, '0');
  const spcStamp = d => String(d.getUTCFullYear()).slice(2) +
    p2(d.getUTCMonth() + 1) + p2(d.getUTCDate()) + p2(d.getUTCHours());
  const iemStamp = d => `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-` +
    `${p2(d.getUTCDate())}T${p2(d.getUTCHours())}:00:00Z`;
  const cycleLabel = d => d.toLocaleString('en-US', {
    timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }) +
    ' ' + p2(d.getUTCHours()) + 'Z';

  // ------------------------------------------------------------- hover map
  // Region boxes in fractions of the 1180×826 SHARP layout. First match wins.
  const REGIONS = [
    { x: [0.025, 0.450], y: [0.020, 0.712], id: 'skewt', title: 'Skew-T log-p diagram',
      html: 'The heart of the chart: <b style="color:#e66">temperature</b> and <b style="color:#3a3">dewpoint</b> traces from the balloon, pressure decreasing upward on a log scale. The dashed line beside the temperature trace is the <b>virtual temperature</b> correction; the thin cyan trace is the <b>wetbulb</b> profile. Where T and Td pinch together the balloon flew through cloud or saturated air. Skewed orange lines are isotherms; the purple markers low on the left flag the effective inflow layer.' },
    { x: [0.450, 0.492], y: [0.020, 0.712], id: 'barbs', title: 'Wind barbs',
      html: 'Observed wind at each reporting level as the balloon drifted: each half-barb 5 kt, full barb 10 kt, flag 50 kt, plotted °true. Read shear as how quickly the barbs rotate or lengthen with height — sharp changes just above the surface mean low-level wind shear on climbout.' },
    { x: [0.497, 0.578], y: [0.020, 0.712], id: 'wspd', title: 'Wind speed vs height',
      html: 'The same winds as the barbs, redrawn as a simple speed profile so jets stand out. A pronounced bulge near the top is the jet stream; a bulge in the lowest few thousand feet is a low-level jet — a classic nocturnal turbulence and LLWS setup.' },
    { x: [0.578, 0.643], y: [0.020, 0.712], id: 'advec', title: 'Inferred temperature advection',
      html: 'Computed from how the wind veers or backs with height (thermal wind). Red = warm-air advection (wind veering with height), blue = cold-air advection (backing). Numbers are °C per hour. WAA aloft often means overrunning precipitation and icing; strong CAA aloft steepens lapse rates and destabilizes.' },
    { x: [0.643, 0.995], y: [0.020, 0.557], id: 'hodo', title: 'Hodograph',
      html: 'The tip of the wind vector traced from the surface upward — rings are speed (kt), colors change by height (red 0–3 km, green 3–6 km, yellow 6–9 km). A long, curved low-level trace means strong shear that organizes storms; the ⊕ symbols are the Bunkers right- and left-mover storm motions, and DP is the deviant-tornado motion estimate.' },
    { x: [0.640, 0.767], y: [0.557, 0.718], id: 'thetae', title: 'Theta-E vs pressure',
      html: 'Equivalent potential temperature with height — a moist-instability x-ray. Theta-E falling with height means potential instability; a deep mid-level minimum is dry air that can fuel downbursts. TEI is the theta-e index (surface minus minimum).' },
    { x: [0.767, 0.875], y: [0.557, 0.718], id: 'srw', title: 'Storm-relative winds',
      html: 'Wind speed relative to a moving storm, by height. Strong storm-relative flow in the lowest kilometer feeds a storm\'s updraft (supercell fuel); the dashed lines mark the classic-supercell range in the mid levels.' },
    { x: [0.875, 0.995], y: [0.557, 0.718], id: 'ship', title: 'Significant Hail Parameter (SHIP)',
      html: 'Box-and-whisker climatology of SHIP for hail < 2 in vs ≥ 2 in, with this sounding\'s value drawn as a horizontal line. SHIP > 1 favors large hail environments (it combines CAPE, mixing ratio, lapse rate, 500-mb temperature and shear).' },
    { x: [0.000, 0.296], y: [0.718, 0.845], id: 'parcel', title: 'Parcel table',
      html: 'CAPE / CIN / LCL / LI / LFC / EL for four different lifted parcels: <b>SURFACE</b> (right now at the ground), <b>MIXED LAYER</b> (lowest 100 mb averaged — best for afternoon convection), <b>FCST SURFACE</b> (parcel warmed to the forecast max temperature), and <b>MU</b> (most-unstable parcel anywhere in the lowest 300 mb — the one that matters for elevated storms). The highlighted row is the parcel SPC considers most relevant.' },
    { x: [0.000, 0.165], y: [0.845, 1.0], id: 'thermo', title: 'Thermodynamic indices',
      html: 'PW = precipitable water (moisture loading; > 1.5 in is juicy for the mid-Atlantic). K index > 30 favors airmass storms. WBZ/FZL = wetbulb-zero and freezing heights (hail and icing levels). ConvT = convective temperature — the surface temperature at which cumulus pop without forced lift. Lapse rates at the bottom: ≥ ~7 °C/km mid-level is steep and unstable.' },
    { x: [0.165, 0.296], y: [0.845, 1.0], id: 'stp', title: 'Composite severe indices',
      html: 'Supercell composite and Significant Tornado Parameter variants — blends of CAPE, shear, SRH and LCL height scaled so ~1+ begins to match significant-event climatology. Zeros across the board mean the ingredients aren\'t overlapping today.' },
    { x: [0.296, 0.560], y: [0.718, 0.885], id: 'kinem', title: 'Kinematic table',
      html: 'Layer-by-layer shear ingredients: SRH = storm-relative helicity (m²/s², the spin available to a storm — 0–1 km SRH > ~150 supports tornadoes), Shear = bulk wind difference through the layer (0–6 km ≥ 35–40 kt supports supercells), MnWind = mean wind, SRW = storm-relative wind. BRN shear and the effective (EBWD) values handle elevated storms properly.' },
    { x: [0.296, 0.560], y: [0.885, 1.0], id: 'motion', title: 'Storm motion vectors',
      html: 'Bunkers right/left supercell motions and Corfidi vectors (MCS propagation — upshear = back-building potential, downshear = forward-propagating lines). Direction°/speed kt. Compare with the mean wind to judge whether storms will train over one spot.' },
    { x: [0.560, 0.727], y: [0.718, 0.800], id: 'precip', title: 'Best-guess precipitation type',
      html: 'SPC\'s algorithmic precip-type call from the thermal profile (surface temperature, depth of warm/cold layers aloft). Watch this in winter: a warm nose aloft over a subfreezing surface layer is the freezing-rain signature.' },
    { x: [0.560, 0.727], y: [0.800, 1.0], id: 'sars', title: 'SARS — sounding analogs',
      html: 'The Sounding Analog Retrieval System compares today\'s profile against a historical database of soundings taken near supercell and hail events. Matches list the analog dates and what happened; "no quality matches" means nothing in the record looked like today.' },
    { x: [0.727, 1.0], y: [0.718, 1.0], id: 'stpbox', title: 'Effective-layer STP distribution',
      html: 'This sounding\'s effective-layer Significant Tornado Parameter plotted against box-and-whisker climatologies for EF0–EF4+ tornado events and nontornadic supercells. If the value line sits inside the EF2+ boxes, the environment resembles past significant-tornado days. The inset lists conditional EF2+ probabilities from several parameters.' },
  ];

  const DEFAULT_HTML = 'Move the cursor over the sounding — each panel of the SPC chart is explained here, and inside the Skew-T itself you get the observed values at the level under the cursor.';

  // Skew-T panel pressure calibration (fractions of image height)
  const Y_P100 = 0.0218, Y_P1000 = 0.6937;
  const pFromY = fy => Math.exp(Math.log(100) +
    (fy - Y_P100) / (Y_P1000 - Y_P100) * Math.log(10));

  // ------------------------------------------------------------- state
  let profile = null;       // [{p,T,Td,ws,wd,z}] surface-first, z AGL m
  let parcel = null;
  let curKey = '';

  const cycles = recentCycles(8);
  const cycSel = $('obs-cycle');
  cycles.forEach((d, i) => {
    const o = document.createElement('option');
    o.value = i; o.textContent = cycleLabel(d);
    cycSel.appendChild(o);
  });

  // ------------------------------------------------------------- loading
  function stationId() {
    return $('obs-station').value.trim().toUpperCase().replace(/^K(?=[A-Z]{3}$)/, '');
  }

  async function loadObs() {
    const st = stationId();
    if (!/^[A-Z0-9]{3}$/.test(st)) { $('obs-status').textContent = 'enter a 3-letter site id'; return; }
    const cyc = cycles[+cycSel.value];
    const key = st + spcStamp(cyc);
    if (key === curKey) return;
    curKey = key;
    profile = parcel = null;

    // the image: hotlinked straight from SPC
    const img = $('obs-img');
    $('obs-status').textContent = 'loading…';
    img.style.opacity = 0.35;
    img.onload = () => { img.style.opacity = 1; $('obs-status').textContent = ''; };
    img.onerror = () => {
      img.style.opacity = 0.15;
      $('obs-status').textContent = `no SPC sounding for ${st} at ${cycleLabel(cyc)} — check the site id, or the balloon may not have launched`;
    };
    img.src = `https://www.spc.noaa.gov/exper/soundings/${spcStamp(cyc)}_OBS/${st}.gif`;

    // the data behind it: IEM archive of the same RAOB
    $('obs-indices').innerHTML = '<div class="kv"><span class="k">loading observed data…</span></div>';
    $('obs-summary').textContent = '';
    try {
      const r = await fetch('https://mesonet.agron.iastate.edu/json/raob.py' +
        `?ts=${iemStamp(cyc)}&station=K${st}`);
      const j = await r.json();
      if (key !== curKey) return;                       // stale response
      const raw = (j.profiles[0] && j.profiles[0].profile) || [];
      const z0 = raw.length ? raw[0].hght : 0;
      const prof = raw
        .filter(q => q.pres != null && q.tmpc != null && q.dwpc != null && q.hght != null)
        .map(q => ({ p: q.pres, T: q.tmpc, Td: q.dwpc,
                     ws: q.sknt, wd: q.drct, z: Math.max(0, q.hght - z0) }));
      prof.sort((a, b) => b.p - a.p);
      if (prof.length < 6) throw new Error('profile unavailable');
      profile = prof;
      parcel = SkewTCore.analyzeParcel(prof);
      const idx = SkewTCore.computeIndices(prof, parcel);
      $('obs-indices').innerHTML = idx.map(rr =>
        `<div class="kv"><span class="k">${rr.k}</span>` +
        `<span class="v${rr.cls ? ' ' + rr.cls : ''}">${rr.v}</span></div>`).join('');
      $('obs-summary').innerHTML = SkewTCore.summaryHTML(prof, parcel);
    } catch (e) {
      $('obs-indices').innerHTML =
        '<div class="kv"><span class="k">observed data not in the IEM archive for this site/time — hover explanations still work</span></div>';
    }
  }

  // ------------------------------------------------------------- hover
  const interpObs = p => {
    if (!profile) return null;
    for (let i = 0; i < profile.length - 1; i++) {
      const a = profile[i], b = profile[i + 1];
      if (p <= a.p && p >= b.p) {
        const f = Math.log(a.p / p) / Math.log(a.p / b.p);
        const lerp = (u, v) => u == null || v == null ? null : u + f * (v - u);
        return { T: lerp(a.T, b.T), Td: lerp(a.Td, b.Td), z: lerp(a.z, b.z),
                 ws: lerp(a.ws, b.ws), wd: a.wd == null || b.wd == null ? null
                   : (a.wd + f * (((b.wd - a.wd + 540) % 360) - 180) + 360) % 360 };
      }
    }
    return null;
  };

  const wrap = $('obs-img-wrap');
  wrap.addEventListener('mousemove', ev => {
    const r = $('obs-img').getBoundingClientRect();
    const fx = (ev.clientX - r.left) / r.width;
    const fy = (ev.clientY - r.top) / r.height;
    const reg = REGIONS.find(g => fx >= g.x[0] && fx < g.x[1] && fy >= g.y[0] && fy < g.y[1]);
    if (!reg) {
      $('obs-hover-title').textContent = 'Hover the chart';
      $('obs-hover-body').innerHTML = DEFAULT_HTML;
      $('obs-readout').textContent = '';
      return;
    }
    $('obs-hover-title').textContent = reg.title;
    $('obs-hover-body').innerHTML = reg.html;
    if (reg.id === 'skewt') {
      const p = pFromY(fy);
      const e = p >= 100 && p <= 1050 ? interpObs(p) : null;
      $('obs-readout').textContent = e
        ? `observed at ${Math.round(p)} hPa · ${Math.round(e.z / 0.3048).toLocaleString()} ft AGL · ` +
          `T ${e.T.toFixed(1)} °C · Td ${e.Td.toFixed(1)} °C · spread ${(e.T - e.Td).toFixed(1)} °C` +
          (e.ws != null && e.wd != null ? ` · wind ${Math.round(e.wd)}°T / ${Math.round(e.ws)} kt` : '')
        : `≈ ${Math.round(p)} hPa`;
    } else {
      $('obs-readout').textContent = '';
    }
  });
  wrap.addEventListener('mouseleave', () => {
    $('obs-hover-title').textContent = 'Hover the chart';
    $('obs-hover-body').innerHTML = DEFAULT_HTML;
    $('obs-readout').textContent = '';
  });

  // ------------------------------------------------------------- wiring
  cycSel.addEventListener('change', loadObs);
  $('obs-station').addEventListener('change', loadObs);
  $('obs-station').addEventListener('keydown', ev => { if (ev.key === 'Enter') loadObs(); });
  $('obs-hover-body').innerHTML = DEFAULT_HTML;
  loadObs();
})();
