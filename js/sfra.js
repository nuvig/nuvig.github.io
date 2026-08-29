// sfra.js — The DC SFRA explainer: boundaries drawn from their legal
// descriptions, a click-anywhere rule inspector, and the procedure decision
// tree. Educational only — never navigate by this page.
//
// Boundary sources: 14 CFR 93.335 (SFRA + FRZ polygon vertices, verbatim
// lat/lons), FAA Order JO 7400.10H (P-56A/B, P-73, P-40/R-4009). Arcs are
// regenerated from the reg's own vertex coordinates (bearings computed from
// the published points, so no magnetic-variation guesswork).

(function () {
  'use strict';
  const $ = id => document.getElementById(id);

  // ---------------------------------------------------------------- geometry
  const R_NM = 3440.065;                       // earth radius, nautical miles
  const rad = d => d * Math.PI / 180;
  const deg = r => r * 180 / Math.PI;

  function distNm(a, b) {
    const dLat = rad(b[0] - a[0]), dLon = rad(b[1] - a[1]);
    const s = Math.sin(dLat / 2) ** 2 +
      Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
    return 2 * R_NM * Math.asin(Math.sqrt(s));
  }
  function bearing(a, b) {
    const y = Math.sin(rad(b[1] - a[1])) * Math.cos(rad(b[0]));
    const x = Math.cos(rad(a[0])) * Math.sin(rad(b[0])) -
      Math.sin(rad(a[0])) * Math.cos(rad(b[0])) * Math.cos(rad(b[1] - a[1]));
    return (deg(Math.atan2(y, x)) + 360) % 360;
  }
  function dest(a, brg, nm) {
    const d = nm / R_NM, t = rad(brg);
    const la1 = rad(a[0]), lo1 = rad(a[1]);
    const la2 = Math.asin(Math.sin(la1) * Math.cos(d) +
      Math.cos(la1) * Math.sin(d) * Math.cos(t));
    const lo2 = lo1 + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(la1),
      Math.cos(d) - Math.sin(la1) * Math.sin(la2));
    return [deg(la2), deg(lo2)];
  }
  // Points along an arc of `nm` around `c`, clockwise from the bearing of
  // `from` to the bearing of `to` (both actual boundary vertices, which are
  // kept verbatim as the arc's endpoints so the polygon meets the reg's
  // published coordinates exactly).
  function arc(c, nm, from, to) {
    let b1 = bearing(c, from), b2 = bearing(c, to);
    if (b2 <= b1) b2 += 360;
    const pts = [from];
    for (let b = Math.ceil(b1) + 1; b < b2; b += 2) pts.push(dest(c, b % 360, nm));
    pts.push(to);
    return pts;
  }
  function pointInPoly(p, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [yi, xi] = poly[i], [yj, xj] = poly[j];
      if ((xi > p[1]) !== (xj > p[1]) &&
          p[0] < (yj - yi) * (p[1] - xi) / (xj - xi) + yi) inside = !inside;
    }
    return inside;
  }

  // ---------------------------------------------------------------- data
  // DCA VOR/DME — the SFRA's center (93.335): 38°51'34"N 077°02'11"W.
  const DCA = [38.85944, -77.03639];

  // FRZ boundary vertices, verbatim from 93.335.
  const FRZ_A = [38.99194, -77.30833];   // DCA 311°/15 nm — start of 15 nm arc
  const FRZ_B = [39.10778, -77.07556];   // DCA 002°/15 nm — end of 15 nm arc
  const FRZ_C = [39.03833, -76.84389];   // DCA 049°/14 nm
  const FRZ_D = [38.98361, -76.80889];   // DCA 064°/13 nm — start of 13 nm arc
  const FRZ_E = [38.84806, -77.31333];   // DCA 276°/13 nm — end of 13 nm arc
  const FRZ_POLY = [
    ...arc(DCA, 15, FRZ_A, FRZ_B),
    FRZ_C,
    ...arc(DCA, 13, FRZ_D, FRZ_E),
  ];                                      // closes A←E with the straight north leg

  // P-56A — Monumental core (JO 7400.10H legal description vertices).
  const P56A = [
    [38.88889, -77.05056], [38.89583, -77.05639], [38.89722, -77.05472],
    [38.90222, -77.05028], [38.90222, -77.00361], [38.89306, -76.99889],
    [38.88306, -77.00667], [38.88222, -77.02000], [38.88750, -77.02000],
    [38.88778, -77.03361], [38.88667, -77.04083],
  ];
  const P56B = { c: [38.92139, -77.06694], nm: 0.434 };  // ½ SM radius
  const P73  = { c: [38.70778, -77.08611], nm: 0.434 };  // Mount Vernon, sfc–1,500
  const P40  = { c: [39.64806, -77.46667], nm: 3 };      // Camp David (+R-4009 above)

  // Airports (coords verified against FAA NASR-derived sources; see sfra.html
  // sources footer). kind: home | frz | fringe | note | closed.
  const AIRPORTS = [
    { id: 'ANP', name: 'Lee · Annapolis — home field', ll: [38.9429, -76.5684], kind: 'home',
      note: 'inside SFRA, outside FRZ · non-towered · CTAF 122.9' },
    { id: 'CGS', name: 'College Park', ll: [38.9805, -76.9222], kind: 'frz', note: 'FRZ field — vetted pilots only' },
    { id: 'VKX', name: 'Potomac Airfield', ll: [38.7486, -76.9559], kind: 'frz', note: 'FRZ field — vetted pilots only' },
    { id: 'W32', name: 'Washington Executive / Hyde', ll: [38.7483, -76.9328], kind: 'closed', note: 'closed 2022', lblDir: 'left' },
    { id: 'W00', name: 'Freeway', ll: [38.9414, -76.7724], kind: 'note', note: '1 nm FRZ cutout around the field' },
    { id: 'JYO', name: 'Leesburg Executive', ll: [39.0780, -77.5575], kind: 'note', note: 'maneuvering area — squawk 1226 direct in/out' },
    { id: 'MD47', name: 'Barnes', ll: [39.3329, -77.0969], kind: 'fringe', note: 'fringe — depart on 1205', lblDir: 'left' },
    { id: 'MD14', name: 'Robinson', ll: [38.5243, -76.6836], kind: 'fringe', note: 'fringe — depart on 1205' },
    { id: '51VA', name: 'Skyview', ll: [38.7162, -77.6339], kind: 'fringe', note: 'fringe — depart on 1205' },
  ];

  // Gate fixes at their true NAS positions (OpenNav + FAA CIFP, agreeing).
  // Several deliberately sit outside the 30 nm ring — a gate is an ordinary
  // NAS intersection used as a *filing fix*: it names a slice of the 30 nm
  // boundary (bounded by DCA VOR radials, per the FAA ALC-405 kneeboard),
  // and you never have to overfly the fix itself. r: [from, to] radials,
  // freq: the Jan 2020 kneeboard sector frequency (verify on the current TAC).
  const GATES = [
    { id: 'WOOLY', ll: [39.33866, -77.03644], r: [341, 46],  freq: '132.775', note: 'north — I-270 to I-95' },
    { id: 'PALEO', ll: [39.02799, -76.37272], r: [47, 119],  freq: '132.775', note: 'northeast/east — Lee’s usual door' },
    { id: 'WHINO', ll: [38.40971, -76.70519], r: [120, 172], freq: '125.125', note: 'southeast' },
    { id: 'GRUBY', ll: [38.20816, -77.17398], r: [173, 214], freq: '125.125', note: 'south' },
    { id: 'BRV',   ll: [38.33626, -77.35287], r: [215, 236], freq: '127.325', note: 'Brooke VORTAC — south-southwest' },
    { id: 'FLUKY', ll: [38.50644, -77.72922], r: [237, 269], freq: '127.325', note: 'southwest' },
    { id: 'JASEN', ll: [39.06069, -77.86811], r: [270, 309], freq: '127.325', note: 'west' },
    { id: 'LUCKE', ll: [39.22466, -77.59780], r: [310, 340], freq: '127.325', note: 'northwest' },
  ];

  // DCA VOR station declination, derived from the reg's own data: 93.335
  // gives each FRZ vertex as BOTH a DCA radial and a lat/lon, so the offset
  // between the true bearing to the point and the published radial IS the
  // declination (≈9°W) — no magnetic-model guesswork.
  const DECL = (() => {
    const pairs = [[FRZ_A, 311], [FRZ_B, 2], [FRZ_C, 49], [FRZ_D, 64], [FRZ_E, 276]];
    let s = 0;
    for (const [pt, r] of pairs) {
      let d = bearing(DCA, pt) - r;
      while (d > 180) d -= 360; while (d < -180) d += 360;
      s += d;
    }
    return s / pairs.length;
  })();
  const radTrue = r => (r + DECL + 360) % 360;   // DCA radial -> true bearing

  // NAS navaids in/around the SFRA (coords verified against FAA NASR-derived
  // sources, 2026-08 data cycle). BRV (Brooke VORTAC) is drawn with the gates.
  // OTT (Nottingham) is deliberately absent — its VOR was decommissioned under
  // the MON program (TACAN remains); don't re-add it as a VOR.
  const NAVAIDS = [
    { id: 'DCA', name: 'Washington',  type: 'VOR/DME', freq: '111.0',  ll: [38.85945, -77.03644] },
    { id: 'ADW', name: 'Andrews',     type: 'VORTAC',  freq: '113.1',  ll: [38.80722, -76.86626] },
    { id: 'BAL', name: 'Baltimore',   type: 'VORTAC',  freq: '115.1',  ll: [39.17106, -76.66126] },
    { id: 'EMI', name: 'Westminster', type: 'VORTAC',  freq: '117.9',  ll: [39.49501, -76.97857] },
    { id: 'AML', name: 'Armel',       type: 'VOR/DME', freq: '113.5',  ll: [38.93459, -77.46670] },
    { id: 'CSN', name: 'Casanova',    type: 'VORTAC',  freq: '116.3',  ll: [38.64120, -77.86550] },
  ];

  // ---------------------------------------------------------------- map
  let map, clickMk = null;

  function initMap() {
    map = L.map('sfra-map', { zoomControl: true }).setView([38.86, -77.04], 9);
    const esc = { maxNativeZoom: 11, maxZoom: 16 };
    const base = {
      // Esri Dark Gray Canvas, not Carto — Carto began watermarking its free
      // basemap tiles "API KEY REQUIRED" (observed 2026-08-26). The site now
      // has a CARTO key (SITE.basemap.cartoKey, added 2026-08-29, used by the
      // other map pages); switch back once the watermark is confirmed gone.
      'Dark': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
        { attribution: 'Esri', maxZoom: 16 }),
      'Streets': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',
        { attribution: '© OpenStreetMap', maxZoom: 16 }),
      'VFR Sectional': L.tileLayer('https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/VFR_Sectional/MapServer/tile/{z}/{y}/{x}',
        { attribution: 'FAA', ...esc }),
      'VFR Sectional (dark)': L.tileLayer('https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/VFR_Sectional/MapServer/tile/{z}/{y}/{x}',
        { attribution: 'FAA', className: 'inverted-tiles', ...esc }),
    };
    const gateGroup = L.layerGroup().addTo(map);
    const navGroup = L.layerGroup().addTo(map);
    const over = {
      'Gates & sectors': gateGroup,
      'Navaids': navGroup,
      'VFR Terminal (TAC)': L.tileLayer('https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/VFR_Terminal/MapServer/tile/{z}/{y}/{x}',
        { attribution: 'FAA', opacity: 0.85, ...esc }),
    };
    base['Dark'].addTo(map);
    L.control.layers(base, over, { collapsed: true }).addTo(map);

    // rings, outside in
    L.circle(DCA, { radius: 60 * 1852, color: '#8a94a4', weight: 1.5, dashArray: '6 6', fill: false }).addTo(map)
      .bindTooltip('60 nm — ALC-405 training ring · ≤230 KIAS from 30 nm', { sticky: true });
    L.circle(DCA, { radius: 30 * 1852, color: '#f0b45a', weight: 2.5, fillColor: '#f0b45a', fillOpacity: 0.05 }).addTo(map)
      .bindTooltip('DC SFRA — 30 nm · surface to FL180 · plan + discrete code + comms · ≤180 KIAS', { sticky: true });
    L.polygon(FRZ_POLY, { color: '#ef4444', weight: 2, fillColor: '#ef4444', fillOpacity: 0.12 }).addTo(map)
      .bindTooltip('FRZ — GA prohibited without FAA/TSA authorization', { sticky: true });
    L.polygon(P56A, { color: '#c026d3', weight: 1.5, fillColor: '#c026d3', fillOpacity: 0.3 }).addTo(map)
      .bindTooltip('P-56A — prohibited, surface to 18,000 ft', { sticky: true });
    L.circle(P56B.c, { radius: P56B.nm * 1852, color: '#c026d3', weight: 1.5, fillColor: '#c026d3', fillOpacity: 0.3 }).addTo(map)
      .bindTooltip('P-56B — Naval Observatory · prohibited', { sticky: true });
    L.circle(P73.c, { radius: P73.nm * 1852, color: '#c026d3', weight: 1.5, fillColor: '#c026d3', fillOpacity: 0.22 }).addTo(map)
      .bindTooltip('P-73 — Mount Vernon · surface to 1,500 ft', { sticky: true });
    L.circle(P40.c, { radius: P40.nm * 1852, color: '#c026d3', weight: 1.5, dashArray: '4 5', fillColor: '#c026d3', fillOpacity: 0.15 }).addTo(map)
      .bindTooltip('P-40 + R-4009 — Camp David, 3 nm charted · expands ~10 nm by TFR with the President in residence', { sticky: true });
    // (the DCA VOR itself is drawn with the navaids below — it IS the center)

    // Gate sectors: each gate names a radial-bounded slice of the 30 nm ring
    // (kneeboard radials converted to true via the reg-derived declination),
    // with a tick at each boundary radial and a dotted leader tying the
    // filing fix to the slice it names.
    GATES.forEach((g, gi) => {
      const [rf, rt] = g.r;
      const span = (rt - rf + 360) % 360;
      const midTrue = radTrue((rf + span / 2) % 360);
      // band drawn just OUTSIDE the ring (31 nm) so the amber SFRA boundary
      // stays its own line; adjacent slices alternate shades to read apart.
      const bandPts = [];
      for (let d = 0; d <= span; d += 1) bandPts.push(dest(DCA, radTrue((rf + d) % 360), 31));
      const shade = gi % 2 ? '#1f8a80' : '#4fd8cf';
      const detail = `<b>${g.id} gate</b> — ${g.note}<br>DCA R-${String(rf).padStart(3, '0')} → R-${String(rt).padStart(3, '0')}` +
        `<br>kneeboard freq ${g.freq} <i>(Jan 2020 — verify current TAC)</i>`;
      L.polyline(bandPts, { color: shade, weight: 5, opacity: 0.7 }).bindPopup(detail).addTo(gateGroup);
      L.polyline([dest(DCA, radTrue(rf), 29.2), dest(DCA, radTrue(rf), 31.8)],
        { color: '#4fd8cf', weight: 1, opacity: 0.5 }).addTo(gateGroup);
      L.polyline([g.ll, dest(DCA, midTrue, 31)],
        { color: shade, weight: 1, opacity: 0.5, dashArray: '2 6' }).addTo(gateGroup);
      L.circleMarker(g.ll, { radius: 5, color: '#4fd8cf', weight: 1.5, fillColor: '#123a38', fillOpacity: 1 })
        .bindPopup(detail)
        .bindTooltip(g.id, { permanent: true, direction: 'right', offset: [6, 0], className: 'maplbl maplbl-gate' })
        .addTo(gateGroup);
    });

    for (const n of NAVAIDS) {
      L.marker(n.ll, { icon: L.divIcon({ className: 'vor-wrap', html: '<div class="vor-icon"></div>', iconSize: [12, 12], iconAnchor: [6, 6] }) })
        .bindPopup(`<b>${n.id}</b> ${n.name}<br>${n.type} · ${n.freq}` +
          (n.id === 'DCA' ? '<br>the SFRA/FRZ center point — every ring and radial measures from here' : ''))
        .bindTooltip(n.id, { permanent: true, direction: 'right', offset: [7, 0], className: 'maplbl maplbl-vor' })
        .addTo(navGroup);
    }
    const AP_STYLE = {
      home:   { color: '#4a9eff', fill: '#0f2742', r: 6 },
      frz:    { color: '#ef4444', fill: '#3a1010', r: 5 },
      fringe: { color: '#9fd45a', fill: '#22320e', r: 5 },
      note:   { color: '#b89cff', fill: '#241a3a', r: 5 },
      closed: { color: '#666',    fill: '#222',    r: 4 },
    };
    for (const a of AIRPORTS) {
      const s = AP_STYLE[a.kind] || AP_STYLE.note;
      L.circleMarker(a.ll, { radius: s.r, color: s.color, weight: 1.5, fillColor: s.fill, fillOpacity: 1 }).addTo(map)
        .bindPopup(`<b>${a.id}</b> ${a.name}${a.note ? '<br>' + a.note : ''}`)
        .bindTooltip(a.id, { permanent: true, direction: a.lblDir || 'right', offset: [a.lblDir === 'left' ? -6 : 6, 0], className: 'maplbl' + (a.kind === 'closed' ? ' maplbl-dim' : '') });
    }

    const LEGEND = [
      ['line', '#f0b45a', 'SFRA (30 nm)'], ['dash', '#8a94a4', 'training ring (60 nm)'],
      ['line', '#ef4444', 'FRZ'], ['line', '#c026d3', 'prohibited (P-56, P-73, P-40)'],
      ['line', '#4fd8cf', 'gate sectors (radial slices of the ring)'],
      ['dot', '#4fd8cf', 'gate filing fixes'], ['dot', '#dfe6ee', 'VOR/VORTAC'],
      ['dot', '#4a9eff', 'Lee (KANP)'],
      ['dot', '#ef4444', 'FRZ fields'], ['dot', '#9fd45a', 'fringe fields'],
    ];
    $('legend').innerHTML = LEGEND.map(([k, c, t]) =>
      `<span><span class="${k === 'dot' ? 'dot' : 'sw' + (k === 'dash' ? ' dash' : '')}" style="${k === 'dot' ? 'background' : 'border-top-color'}:${c}"></span>${t}</span>`
    ).join('');

    map.on('click', e => inspect([e.latlng.lat, e.latlng.lng]));
  }

  // ---------------------------------------------------------------- inspector
  function inspect(p) {
    if (clickMk) map.removeLayer(clickMk);
    clickMk = L.circleMarker(p, { radius: 6, color: '#fff', weight: 2, fillColor: '#4a9eff', fillOpacity: 0.9 }).addTo(map);

    const d = distNm(DCA, p);
    const inFrz = pointInPoly(p, FRZ_POLY) && distNm(p, [38.9414, -76.7724]) > 1; // Freeway (W00) cutout
    const flags = {
      p56: pointInPoly(p, P56A) || distNm(p, P56B.c) <= P56B.nm,
      p73: distNm(p, P73.c) <= P73.nm,
      p40: distNm(p, P40.c) <= P40.nm,
      frz: inFrz, sfra: d <= 30, shell: d > 30 && d <= 60,
    };

    let verdict, color, rules = [];
    if (flags.p56) {
      verdict = 'PROHIBITED — P-56'; color = '#c026d3';
      rules = ['<b>No civil flight, ever</b>, surface to 18,000 ft — this is the innermost fence.',
        'You are also inside the FRZ and the SFRA; every one of their rules applies too.'];
    } else if (flags.frz) {
      verdict = 'Inside the FRZ'; color = '#ef4444';
      rules = ['<b>GA prohibited without FAA/TSA authorization</b> — vetted-pilot ops to CGS/VKX only (93.341–343).',
        'FRZ plans are filed by phone with Washington Center: <span class="phone">703-771-3476</span>.',
        'Plus every SFRA rule: discrete code, comms, ≤180 KIAS, never 1200.'];
    } else if (flags.sfra) {
      verdict = `Inside the SFRA — ${d.toFixed(1)} nm from the DCA VOR`; color = '#f0b45a';
      rules = ['<b>Before being here</b>: DC SFRA flight plan filed, discrete code received, two-way comms with Potomac (93.339).',
        'Squawk the code continuously — <b>never 1200</b>. Mode C required. ≤180 KIAS.',
        'VFR pilot? ALC-405 training certificate required (91.161).',
        'Surface up to (not including) FL180.'];
    } else if (flags.shell) {
      verdict = `30–60 nm shell — ${d.toFixed(1)} nm out`; color = '#8a94a4';
      rules = ['No plan, code, or comms required out here.',
        '<b>VFR: ALC-405 training certificate required</b> (91.161) · ≤230 KIAS.',
        'Mind the arc: GPS-direct routes love to clip the 30 nm circle.'];
    } else {
      verdict = `Outside the SFRA system — ${d.toFixed(0)} nm from DCA`; color = '#52d273';
      rules = ['No DC SFRA requirements at this spot. Normal airspace rules apply.'];
    }
    if (flags.p40) rules.unshift('<b>P-40/R-4009 (Camp David)</b>: prohibited sfc–5,000 / restricted 5,000–12,500 — and it grows to ~10 nm by TFR when the President visits.');
    if (flags.p73) rules.unshift('<b>P-73 (Mount Vernon)</b>: prohibited surface to 1,500 ft — right on the river route.');

    $('inspect-verdict').textContent = verdict;
    $('inspect-verdict').style.color = color;
    $('inspect-verdict').classList.remove('faint');
    $('inspect-body').innerHTML = '<ul>' + rules.map(r => `<li>${r}</li>`).join('') + '</ul>';
  }

  // ---------------------------------------------------------------- decision tree
  // Question nodes: { q, help, opts: [[label, sub, target], …] }
  // Terminal nodes: { end: true, headline, hue, one, chips, steps, warn, cite }
  const CITE = {
    core: '<b>14 CFR 93.339</b> · <b>91.161</b> · Chart Supplement NE special notice',
    frz: '<b>14 CFR 93.341–93.343</b> · 49 CFR 1562 · Chart Supplement NE special notice',
    notice: 'Chart Supplement NE special notice',
  };
  const TREE = {
    ROOT: {
      q: 'What are you flying today?',
      help: 'Start from the mission — the tree only asks what actually changes the procedure. (Everything below assumes below FL180; above it, none of this applies.)',
      opts: [
        ['Depart an airport inside the SFRA', 'Lee, Freeway, Gaithersburg, Tipton…', 'DEP'],
        ['Arrive at an airport inside the SFRA', 'coming home from outside the ring', 'ARR'],
        ['Transit past DC — no landing inside', 'or just flying somewhere near Washington', 'TRANSIT'],
        ['Stay in the traffic pattern', 'closed traffic at an SFRA airport', 'PATTERN'],
        ['College Park or Potomac Airfield', 'the FRZ fields', 'FRZQ'],
        ['Depart a fringe airport', 'Barnes, Robinson, Skyview', 'FRINGE'],
        ['Leesburg (JYO), straight in or out', 'the JYO maneuvering area', 'T_JYO'],
        ['Something has gone wrong', 'lost comms, transponder, interceptor, lasers', 'EMERG'],
      ],
    },
    DEP: {
      q: 'VFR or IFR?',
      help: 'IFR flights ride on their clearance. VFR flights need the SFRA machinery — and the pilot needs the training certificate.',
      opts: [['VFR', null, 'DEPVFR'], ['IFR', null, 'T_DEP_IFR']],
    },
    DEPVFR: {
      q: 'Towered or non-towered airport?',
      help: 'The difference is only where the discrete code comes from — a frequency, or a phone call from the ramp.',
      opts: [
        ['Non-towered', 'Lee-style: the code comes by phone before takeoff', 'T_DEP_NT'],
        ['Towered', 'clearance delivery / ground issues the code', 'T_DEP_TWR'],
      ],
    },
    ARR: { q: 'VFR or IFR?', opts: [['VFR', null, 'T_ARR_VFR'], ['IFR', null, 'T_ARR_IFR']] },
    TRANSIT: {
      q: 'Will your route cross inside the 30 nm ring?',
      help: 'Measure to the DCA VOR/DME, not the airport. A GPS-direct line past Washington clips the arc more often than you\'d think.',
      opts: [
        ['Yes — through the SFRA', null, 'T_TRANSIT_IN'],
        ['No, but inside 60 nm', 'skirting the ring', 'T_TRANSIT_60'],
        ['No — beyond 60 nm', null, 'T_TRANSIT_FAR'],
      ],
    },
    PATTERN: {
      q: 'What kind of airport?',
      opts: [
        ['Non-towered', 'Lee, Freeway…', 'T_PAT_NT'],
        ['Towered', 'inside the SFRA', 'T_PAT_TWR'],
        ['Leesburg (JYO)', 'special case', 'T_PAT_JYO'],
      ],
    },
    FRZQ: {
      q: 'Are you vetted into the TSA program, with a PIN?',
      help: 'The FRZ has exactly one GA doorway: the DC-airports vetting program of 49 CFR 1562. A flight plan alone opens nothing.',
      opts: [['Yes — I hold a PIN', null, 'T_FRZ_YES'], ['No', null, 'T_FRZ_NO']],
    },
    FRINGE: {
      q: 'Departing or arriving?',
      help: 'The fringe shortcut only works in one direction.',
      opts: [['Departing', null, 'T_FRINGE_DEP'], ['Arriving', null, 'T_FRINGE_ARR']],
    },
    EMERG: {
      q: 'What\'s happening?',
      opts: [
        ['Two-way radio failure', null, 'T_E_COMMS'],
        ['Transponder failure', null, 'T_E_XPDR'],
        ['I\'m being intercepted', null, 'T_E_INT'],
        ['Red-red-green lasers from the ground', null, 'T_E_VWS'],
      ],
    },

    // ---- terminals -------------------------------------------------------
    T_DEP_NT: {
      end: true, headline: 'VFR departure — non-towered SFRA airport', hue: '#4a9eff',
      one: 'The Lee Airport case. Everything that matters happens before the wheels move.',
      chips: [['squawk', 'discrete'], ['phone', 'Potomac Clearance (Chesapeake area) · 866-429-5882']],
      steps: [
        '<b>ALC-405 certificate</b> aboard — required for any VFR flight inside 60 nm.',
        'File a <b>DC SFRA flight plan</b>: airport → your exit gate (from Lee, usually <b>ANP → PALEO</b> eastbound). Leidos / your EFB; it is not a regular VFR plan.',
        'From the ramp, <b>phone Potomac Clearance</b> for your discrete code and departure frequency. Receiving the code is what activates the plan.',
        '<b>Squawk the code before takeoff</b> — 1200 is forbidden anywhere in the SFRA.',
        'Announce on CTAF, depart, then establish two-way comms with Potomac climbing out (published for the Lee area: 119.7 — confirm on the current TAC).',
        '≤180 KIAS. Stay with Potomac to the boundary; the plan closes itself when you exit.',
        'Cross the ring, get <b>well clear</b>, then turn on course.',
      ],
      warn: '<b>No search-and-rescue rides on an SFRA plan.</b> Want SAR coverage for the rest of the trip? File a separate standard VFR flight plan and open it after you exit.',
      cite: CITE.core,
    },
    T_DEP_TWR: {
      end: true, headline: 'VFR departure — towered SFRA airport', hue: '#4a9eff',
      one: 'Same machinery as everywhere else in the ring; the tower just hands you the code on frequency.',
      chips: [['squawk', 'discrete']],
      steps: [
        '<b>ALC-405 certificate</b> aboard.',
        'File a <b>DC SFRA flight plan</b>, airport → exit gate.',
        'Get the <b>discrete code from clearance delivery / ground</b> with your initial call.',
        'Squawk it from takeoff; tower hands you to Potomac departure.',
        '≤180 KIAS; comply with the Class D (91.129); stay with ATC to the boundary, then well clear before turning on course.',
      ],
      cite: CITE.core,
    },
    T_DEP_IFR: {
      end: true, headline: 'IFR departure from inside the SFRA', hue: '#52d273',
      one: 'Your IFR clearance is the SFRA machinery — with two sharp edges.',
      chips: [['squawk', 'assigned']],
      steps: [
        'File and fly IFR normally — the clearance and its code satisfy §93.339.',
        'Get clearance and code <b>before takeoff</b>. At a non-towered field that\'s the usual phone call (Lee area: 866-429-5882).',
        '<b>You may not depart VFR and pick up the clearance airborne</b> — explicitly barred inside the SFRA.',
        'The 60 nm training rule doesn\'t apply to IFR flights — but if you ever cancel inside the ring, you become a VFR SFRA flight on the spot: keep the code, stay with ATC.',
      ],
      cite: CITE.core,
    },
    T_ARR_VFR: {
      end: true, headline: 'VFR arrival into the SFRA', hue: '#4a9eff',
      one: 'The departure film run backwards: code and comms first, boundary second.',
      chips: [['squawk', 'discrete']],
      steps: [
        '<b>ALC-405 certificate</b> aboard.',
        'File a <b>DC SFRA flight plan</b>: entry gate → destination — before you get anywhere near the ring.',
        'Well outside 30 nm, call Potomac on the <b>sector frequency for your gate</b> (from the current TAC). They issue the discrete code — that activates the plan.',
        '<b>Only cross the ring with code set and comms established.</b> ≤230 KIAS inside 60 nm, ≤180 inside 30.',
        'Keep the code to touchdown — even after “radar services terminated” and the switch to CTAF. The plan closes when you land.',
        'Class B or D on the way in still needs its own clearance — an SFRA code is not a Bravo clearance.',
      ],
      warn: 'Never loiter across the boundary “waiting for the code.” If they\'re busy, hold <i>outside</i> the ring.',
      cite: CITE.core,
    },
    T_ARR_IFR: {
      end: true, headline: 'IFR arrival into the SFRA', hue: '#52d273',
      one: 'Fly the clearance; the system already knows you.',
      chips: [['squawk', 'assigned']],
      steps: [
        'Normal IFR arrival — your code and comms satisfy §93.339.',
        'Landing at a non-towered field: keep the assigned code all the way to the ground. <b>Never 1200</b>, even taxiing in.',
        'Cancel IFR in the air inside the ring and you\'re instantly a VFR SFRA flight — keep the code and stay with Potomac; don\'t cancel unless that picture works.',
      ],
      cite: CITE.core,
    },
    T_TRANSIT_IN: {
      end: true, headline: 'VFR transit through the SFRA', hue: '#f0b45a',
      one: 'Gate to gate, talking the whole way.',
      chips: [['squawk', 'discrete']],
      steps: [
        '<b>ALC-405 certificate</b> aboard.',
        'File a <b>DC SFRA plan, entry gate → exit gate</b>.',
        'Get the code from Potomac on the sector frequency <b>before the boundary</b>; comms throughout.',
        '≤180 KIAS. Expect vectors or altitude requests — security first, your routing second.',
        'Exit the far side, get well clear, then resume your own navigation. The plan closes at the boundary.',
      ],
      warn: '<b>Flight following is not an SFRA plan</b> and an SFRA plan is not flight following — the code correlates you for security and buys no traffic services.',
      cite: CITE.core,
    },
    T_TRANSIT_60: {
      end: true, headline: 'Skirting the ring — 30 to 60 nm out', hue: '#8a94a4',
      one: 'No plan, no code — but two rules still reach you out here.',
      steps: [
        'Flying VFR: <b>ALC-405 training certificate required</b> — this is the rule\'s whole reason to exist.',
        '<b>≤230 KIAS</b> in the 30–60 nm shell.',
        'Give the arc real margin — measure to the DCA VOR, not the field, and watch GPS-direct lines that graze the circle.',
        'Northbound? Brief <b>P-40 (Camp David)</b>: 3 nm charted, ~10 nm by TFR when occupied.',
      ],
      cite: '<b>91.161</b> · Chart Supplement NE special notice',
    },
    T_TRANSIT_FAR: {
      end: true, headline: 'Beyond 60 nm', hue: '#52d273',
      one: 'The DC rules don\'t reach you — today\'s TFRs still might.',
      steps: [
        'No SFRA requirements apply.',
        'Brief TFRs anyway: P-40\'s presidential expansion, stadium TFRs, and VIP movement all live in the NOTAM system, not on the chart.',
      ],
      cite: CITE.notice,
    },
    T_PAT_NT: {
      end: true, headline: 'Pattern work — non-towered SFRA airport', hue: '#4a9eff',
      one: 'The Lee case — and the single most-misunderstood SFRA procedure.',
      chips: [['squawk', 'discrete'], ['phone', 'code: 866-429-5882 · close: 540-351-6129']],
      steps: [
        '<b>ALC-405 certificate</b> aboard.',
        'File a <b>DC SFRA flight plan for pattern work</b>.',
        'Phone Potomac for a <b>discrete code</b> before takeoff, and squawk it for the whole session.',
        'Make normal <b>CTAF position calls</b> every leg (Lee: 122.9); monitor 121.5 when able.',
        'Done for the day: <b>close the plan by phone</b> — 540-351-6129.',
        'Decide to leave the pattern after all? Meet the full departure list first — this plan only covers the pattern.',
      ],
      warn: '<b>Not 1234.</b> The famous pattern code belongs to <i>towered</i> SFRA airports only. At a non-towered field the code must be discrete, from Potomac — squawking 1234 (or 1200) in the pattern at Lee is a violation.',
      cite: '<b>14 CFR 93.339(c)</b> · Chart Supplement NE special notice',
    },
    T_PAT_TWR: {
      end: true, headline: 'Pattern work — towered SFRA airport', hue: '#4a9eff',
      one: 'The one place the famous code is real.',
      chips: [['squawk', '1234']],
      steps: [
        '<b>ALC-405 certificate</b> aboard.',
        '<b>Ask tower for closed traffic before departing</b> (or before entering the pattern).',
        'Squawk <b>1234</b> unless ATC assigns something else; stay in two-way comms with tower; monitor guard when able.',
        'Leaving the pattern means meeting the full §93.339(a) list first — plan, discrete code, the works.',
      ],
      cite: '<b>14 CFR 93.339(d)</b>',
    },
    T_PAT_JYO: {
      end: true, headline: 'Pattern work at Leesburg — not the shortcut', hue: '#b89cff',
      one: 'JYO\'s 1226 carve-out covers straight in and straight out only.',
      chips: [['squawk', 'discrete']],
      steps: [
        'Closed traffic, practice approaches, maneuvering: <b>a regular SFRA operation</b> — plan, discrete code from Potomac, CTAF calls, close by phone after.',
        'Only a direct arrival or departure through the JYO maneuvering area rides on 1226 with no plan.',
      ],
      cite: CITE.notice,
    },
    T_JYO: {
      end: true, headline: 'The JYO maneuvering area', hue: '#b89cff',
      one: 'Leesburg\'s private doorway through the SFRA wall.',
      chips: [['squawk', '1226']],
      steps: [
        'Direct arrivals and departures at Leesburg: squawk <b>1226</b>, make CTAF calls, <b>no flight plan needed</b> — most direct route in or out of the maneuvering area.',
        'Anything more — pattern work, practice approaches, transiting onward — is a full SFRA operation with a plan and a discrete code.',
        'Older kneeboards show 1227 inbound; the current notice says 1226 both directions. As always, the current chart cycle wins.',
      ],
      cite: CITE.notice,
    },
    T_FRZ_YES: {
      end: true, headline: 'Into the FRZ — vetted pilot', hue: '#ef4444',
      one: 'College Park (CGS) and Potomac Airfield (VKX) — the last two doors, and they open by telephone.',
      chips: [['squawk', 'discrete'], ['phone', 'Washington Center flight data · 703-771-3476']],
      steps: [
        'File an <b>IFR or DC FRZ flight plan by phone with Washington Center</b> — one per departure <i>and</i> per arrival. No electronic filing exists; your PIN is verified before the plan is accepted.',
        'Discrete code transmitted at all times; two-way comms throughout; monitor guard when able.',
        'VFR ingress: <b>remain outside the SFRA until ATC authorizes entry</b>, then expect the published ingress routing for your field.',
        'Every SFRA rule still applies on top — ≤180 KIAS, never 1200.',
      ],
      warn: 'Hyde Field (W32), the third of the “Maryland Three,” closed permanently in 2022 — references to the DC-3 airports are one airport stale.',
      cite: CITE.frz,
    },
    T_FRZ_NO: {
      end: true, headline: 'The FRZ is closed to you today', hue: '#ef4444',
      one: 'Without TSA vetting there is no way to fly yourself in — no flight plan or code changes that.',
      steps: [
        'The path in, if you want it: TSA\'s DC-airports program (49 CFR 1562) — application through the airport, fingerprints, background check, then a personal PIN for filing.',
        'Until then, plan around the wall: the FRZ boundary runs ~13–15 nm from the DCA VOR (its eastern edge passes roughly 8 nm west of Lee).',
        'P-56 sits inside it over the Mall and the Naval Observatory — that one is closed to <i>everyone</i>.',
      ],
      cite: CITE.frz,
    },
    T_FRINGE_DEP: {
      end: true, headline: 'Fringe-airport departure', hue: '#9fd45a',
      one: 'The one legal way to fly in the SFRA without talking to anyone.',
      chips: [['squawk', '1205']],
      steps: [
        'Departing <b>Barnes (MD47), Robinson (MD14), or Skyview (51VA)</b>: squawk <b>1205</b> — no flight plan, no comms required (unless ATC asks).',
        '<b>Exit the SFRA by the most direct route</b> before proceeding on course.',
        'Monitor 121.5 on the way out.',
      ],
      warn: '<b>Outbound only.</b> There is no inbound 1205 — arriving at a fringe field is a full SFRA arrival. (The CFR still lists five fringe airports; the current notice lists these three.)',
      cite: '<b>14 CFR 93.345</b> · Chart Supplement NE special notice',
    },
    T_FRINGE_ARR: {
      end: true, headline: 'Fringe-airport arrival — no shortcut', hue: '#9fd45a',
      one: 'Inbound, a fringe field is just another non-towered SFRA airport.',
      chips: [['squawk', 'discrete']],
      steps: [
        'File a <b>DC SFRA plan, entry gate → airport</b>.',
        'Get the discrete code from Potomac on frequency <b>before crossing the 30 nm ring</b>; comms until switching to CTAF.',
        'Keep the code to landing; the plan closes on touchdown.',
      ],
      cite: '<b>14 CFR 93.345(b)</b>, 93.339',
    },
    T_E_COMMS: {
      end: true, headline: 'Radio failure inside the SFRA', hue: '#f59e0b',
      one: 'Become predictable, then leave.',
      chips: [['squawk', '7600']],
      steps: [
        'Squawk <b>7600</b>.',
        '<b>Exit the SFRA by the most direct lateral route</b> — or return to your departure point if that\'s closer (inside the FRZ: only if within 5 nm of it).',
        'IFR: fly §91.185 lost-comms procedures — that\'s a defense under the rules.',
        'Expect company: an unresponsive track here gets looked at. Fly the procedure and let them look.',
      ],
      cite: CITE.notice,
    },
    T_E_XPDR: {
      end: true, headline: 'Transponder failure inside the SFRA', hue: '#f59e0b',
      one: 'You just went dark on the security scope — say so.',
      steps: [
        '<b>Tell ATC immediately</b> and comply with their instructions — they may keep you with position reports.',
        'Can\'t reach anyone? Same as radio failure: most direct lateral route out, or the departure point if closer.',
        'Don\'t continue the mission dark — a code-less target in the SFRA is exactly what the system exists to chase.',
      ],
      cite: CITE.notice,
    },
    T_E_INT: {
      end: true, headline: 'You\'re being intercepted', hue: '#ef4444',
      one: 'A Black Hawk, a Coast Guard helicopter, or an F-16 is on your wing. There is exactly one script.',
      chips: [['squawk', '7700']],
      steps: [
        '<b>Follow the interceptor\'s instructions</b> — immediately, all of them. Rock your wings back if signaled.',
        'Come up on <b>121.5</b> with call sign and position.',
        'Squawk <b>7700</b> unless directed otherwise.',
        'Do not maneuver abruptly, do not press on toward your destination, and save the explanation for the ground.',
      ],
      cite: 'AIM 5-6-2 · Chart Supplement NE special notice',
    },
    T_E_VWS: {
      end: true, headline: 'Red-red-green lasers — the Visual Warning System', hue: '#ef4444',
      one: 'Ground-based, eye-safe lasers aimed at your aircraft: security thinks you\'re in the SFRA/FRZ without authorization.',
      steps: [
        'Talking to ATC already? <b>Tell them immediately</b> that you\'re being illuminated.',
        'Not talking to anyone? <b>Turn away from the center of DC now</b>, then contact ATC on the appropriate frequency or 121.5.',
        'The beam is Class I / eye-safe and visible 15–20 mi. It is a question — “who are you?” — and turning away plus talking is the answer.',
      ],
      cite: 'AIM 5-6-16',
    },
  };

  // ---------------------------------------------------------------- tree UI
  const path = [];   // [{node, optLabel}]

  function chipHtml([kind, val]) {
    if (kind === 'squawk') {
      const label = /^\d{4}$/.test(val) ? val : val;
      return `<span class="faint" style="font-size:11px;text-transform:uppercase;letter-spacing:.05em">squawk</span> <span class="squawk">${label}</span>`;
    }
    return `<span class="phone">${val}</span>`;
  }

  function renderTree() {
    const id = path.length ? path[path.length - 1].to : 'ROOT';
    const node = TREE[id];
    const crumbs = $('tree-crumbs');
    crumbs.innerHTML = '';
    path.forEach((step, i) => {
      const c = document.createElement('span');
      c.className = 'crumb'; c.textContent = step.label; c.title = 'Back to this question';
      c.onclick = () => { path.length = i; renderTree(); };
      crumbs.appendChild(c);
      if (i < path.length - 1 || !node.end) {
        const s = document.createElement('span'); s.className = 'sep'; s.textContent = '›';
        crumbs.appendChild(s);
      }
    });

    const qWrap = $('tree-node'), end = $('tree-end');
    if (node.end) {
      qWrap.style.display = 'none'; end.style.display = 'block';
      end.querySelector('.headline').textContent = node.headline;
      end.querySelector('.headline').style.color = node.hue || '#eee';
      end.querySelector('.oneliner').textContent = node.one || '';
      end.querySelector('.chips').innerHTML = (node.chips || []).map(chipHtml).join('<span class="faint" style="margin:0 2px">·</span>');
      end.querySelector('.chips').style.display = node.chips ? 'flex' : 'none';
      end.querySelector('.steps').innerHTML = node.steps.map(s => `<li>${s}</li>`).join('');
      const w = end.querySelector('.warnbox');
      if (node.warn) { w.style.display = 'block'; w.innerHTML = node.warn; } else w.style.display = 'none';
      end.querySelector('.cite').innerHTML = node.cite || '';
    } else {
      end.style.display = 'none'; qWrap.style.display = 'block';
      $('tree-q').textContent = node.q;
      $('tree-help').textContent = node.help || '';
      $('tree-help').style.display = node.help ? 'block' : 'none';
      const opts = $('tree-opts'); opts.innerHTML = '';
      node.opts.forEach(([label, sub, to]) => {
        const b = document.createElement('button');
        b.innerHTML = label + (sub ? `<span class="sub">${sub}</span>` : '');
        b.onclick = () => { path.push({ label, to }); renderTree(); };
        opts.appendChild(b);
      });
    }
    $('tree-back').style.visibility = path.length ? 'visible' : 'hidden';
  }

  function buildOutline() {
    const seen = new Set();
    function walk(id) {
      const node = TREE[id];
      if (node.end) return `<li class="oend">→ ${node.headline}</li>`;
      if (seen.has(id)) return '';
      seen.add(id);
      const kids = node.opts.map(([label, , to]) => {
        const t = TREE[to];
        if (t.end) return `<li><b style="color:#c8d2dd;font-weight:600">${label}</b> <span class="oend">→ ${t.headline}</span></li>`;
        return `<li><b style="color:#c8d2dd;font-weight:600">${label}</b><ul><li class="oq">${t.q}</li>${walk(to)}</ul></li>`;
      }).join('');
      return `<ul>${kids}</ul>`;
    }
    $('tree-outline').querySelector('.body').innerHTML =
      `<p class="oq" style="color:#8ab8e8">${TREE.ROOT.q}</p>` + walk('ROOT');
  }

  // ---------------------------------------------------------------- ASRS record
  // Reads data/sfra/asrs.json (built by scripts/build_sfra_reports.py from
  // ASRS Database Online exports — change the two together). The section
  // stays hidden if the file is missing.
  const REC = { data: null, filter: 'all', shown: 20 };
  const FILTERS = [
    ['all', 'All reports'], ['viol', 'Violation-flagged'], ['SFRA', 'SFRA'],
    ['ADIZ', 'ADIZ'], ['FRZ', 'FRZ'], ['P-56', 'P-56'], ['anp', 'At Lee (ANP)'],
  ];

  function recFiltered() {
    const evs = REC.data.events;
    if (REC.filter === 'all') return evs;
    if (REC.filter === 'viol') return evs.filter(e => e.viol);
    if (REC.filter === 'anp') return evs.filter(e => e.loc.startsWith('ANP'));
    return evs.filter(e => e.terms.includes(REC.filter));
  }

  function drawAsrsChart(hoverYear) {
    const cv = $('asrs-chart'), ctx = cv.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const W = cv.clientWidth, H = cv.clientHeight;
    cv.width = W * dpr; cv.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const years = REC.data.years;
    const y0 = Math.min(...Object.keys(years).map(Number));
    const y1 = Math.max(...Object.keys(years).map(Number));
    const n = y1 - y0 + 1;
    const padL = 30, padB = 18, padT = 14;
    const bw = (W - padL - 4) / n;
    const max = Math.max(...Object.values(years).map(v => v.n));
    // sqrt scale: the 2003 ADIZ spike (413) would flatten the modern era on
    // a linear axis. Labelled ticks keep it honest.
    const sy = v => H - padB - Math.sqrt(v / max) * (H - padB - padT);

    ctx.font = '10px sans-serif';
    ctx.fillStyle = '#555'; ctx.strokeStyle = '#262626';
    for (const t of [10, 50, 100, 200, 400].filter(t => t <= max * 1.05)) {
      const y = sy(t);
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W, y); ctx.stroke();
      ctx.fillText(String(t), 2, y + 3);
    }
    for (let y = y0; y <= y1; y++) {
      const d = years[String(y)] || { n: 0, viol: 0 };
      const x = padL + (y - y0) * bw;
      const hv = String(y) === String(hoverYear);
      if (d.n) {
        ctx.fillStyle = hv ? '#ffd75a' : (y < 2003 ? '#6b6255' : '#f0b45a');
        ctx.fillRect(x + 1, sy(d.n), Math.max(1, bw - 2), H - padB - sy(d.n));
        ctx.fillStyle = hv ? '#e86a5a' : '#b0543f';
        ctx.fillRect(x + 1, sy(d.viol), Math.max(1, bw - 2), H - padB - sy(d.viol));
      }
      if (y % 5 === 0) {
        ctx.fillStyle = '#666';
        ctx.fillText(String(y), x - 6, H - 5);
      }
    }
    // era markers
    ctx.fillStyle = '#8a94a4'; ctx.strokeStyle = '#3a4450';
    for (const [yy, lbl] of [[2003, 'ADIZ'], [2009, 'SFRA']]) {
      const x = padL + (yy - y0) * bw;
      ctx.beginPath(); ctx.setLineDash([3, 4]); ctx.moveTo(x, padT); ctx.lineTo(x, H - padB); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillText(lbl, x + 3, padT + 8);
    }
  }

  function renderAsrsList() {
    const evs = recFiltered();
    const list = $('asrs-list');
    list.innerHTML = evs.slice(0, REC.shown).map(e => {
      const ym = e.ym.length === 6 ? `${e.ym.slice(0, 4)}-${e.ym.slice(4)}` : e.ym;
      const anom = e.anom.split(';')[0].trim();
      return `<div class="asrs-row">
        <div class="hd"><b>${ym}</b><span>${e.loc || '—'}${e.st ? ' · ' + e.st : ''}</span>
          <span class="faint">ACN ${e.acn}</span><span class="faint">${anom}</span>
          ${e.viol ? '<span class="vflag">airspace violation</span>' : ''}</div>
        <div class="syn">${e.syn}</div>
      </div>`;
    }).join('') || '<div class="canvas-note">No reports match this filter.</div>';
    $('asrs-more').style.display = evs.length > REC.shown ? 'inline-block' : 'none';
    $('asrs-more').textContent = `Show 20 more (${evs.length - Math.min(REC.shown, evs.length)} remaining)`;
  }

  function renderAsrsFilters() {
    const evs = REC.data.events;
    const counts = {
      all: evs.length, viol: evs.filter(e => e.viol).length,
      anp: evs.filter(e => e.loc.startsWith('ANP')).length,
      'SFRA': 0, 'ADIZ': 0, 'FRZ': 0, 'P-56': 0,
    };
    for (const e of evs) for (const t of e.terms) counts[t]++;
    $('asrs-filters').innerHTML = FILTERS.map(([k, lbl]) =>
      `<span class="fchip${REC.filter === k ? ' on' : ''}" data-f="${k}">${lbl} · ${counts[k]}</span>`).join('');
    for (const c of $('asrs-filters').children) {
      c.onclick = () => { REC.filter = c.dataset.f; REC.shown = 20; renderAsrsFilters(); renderAsrsList(); };
    }
  }

  async function initRecord() {
    try {
      const r = await fetch('data/sfra/asrs.json');
      if (!r.ok) return;
      REC.data = await r.json();
    } catch { return; }
    document.getElementById('sec-record').style.display = 'block';
    drawAsrsChart();
    renderAsrsFilters();
    renderAsrsList();
    $('asrs-more').onclick = () => { REC.shown += 20; renderAsrsList(); };
    const cv = $('asrs-chart');
    const years = Object.keys(REC.data.years).map(Number);
    const y0 = Math.min(...years), y1 = Math.max(...years);
    cv.addEventListener('mousemove', ev => {
      const rc = cv.getBoundingClientRect();
      const y = y0 + Math.floor((ev.clientX - rc.left - 30) / ((rc.width - 34) / (y1 - y0 + 1)));
      const d = REC.data.years[String(y)];
      if (y >= y0 && y <= y1) {
        drawAsrsChart(y);
        $('asrs-chart-note').textContent = d
          ? `${y} — ${d.n} report${d.n === 1 ? '' : 's'} mentioning the airspace, ${d.viol} flagged as airspace violations` +
            (y === 2003 ? ' · the ADIZ appeared that February' : y < 2003 ? ' · pre-2003 hits are mostly the coastal ADIZ' : '')
          : `${y} — no reports`;
      }
    });
    cv.addEventListener('mouseleave', () => {
      drawAsrsChart();
      $('asrs-chart-note').textContent =
        `${REC.data.count} reports, ${y0}–${y1} · amber = mentions, red = ASRS-coded airspace violations · square-root scale · retrieved ${REC.data.retrieved}`;
    });
    $('asrs-chart-note').textContent =
      `${REC.data.count} reports, ${y0}–${y1} · amber = mentions, red = ASRS-coded airspace violations · square-root scale · retrieved ${REC.data.retrieved}`;
    window.addEventListener('resize', () => drawAsrsChart());
  }

  // ---------------------------------------------------------------- boot
  document.addEventListener('DOMContentLoaded', () => {
    initMap();
    renderTree();
    buildOutline();
    initRecord();
    $('tree-back').onclick = () => { if (path.length) { path.pop(); renderTree(); } };
    $('tree-restart').onclick = () => { path.length = 0; renderTree(); };
  });
})();
