/* Instrument Errors — interactive explainer
   1. #ps-*  pitot-static blockage sim: plumbing diagram + live ASI / altimeter / VSI
   2. #alt-* altimeter pressure & temperature errors (side view vs an obstacle)
   3. #gy-*  heading-indicator earth-rate drift · #ai-* attitude-indicator false climb
   4. #mc-*  magnetic compass: dip, turning (UNOS) and acceleration (ANDS) errors
   No dependencies. All pressures in inches Hg, altitudes ft, speeds kt.
*/
(() => {
'use strict';

const $ = id => document.getElementById(id);
const DEG = Math.PI / 180;
const G = 32.174;                 // ft/s²
const fmt = (n, d = 0) => n.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d });
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const norm360 = a => ((a % 360) + 360) % 360;
const angdiff = (a, b) => ((a - b + 540) % 360) - 180;      // signed a−b in (−180,180]
const h3 = v => { let r = Math.round(norm360(v)); if (r === 0) r = 360; return String(r).padStart(3, '0'); };

// crisp canvas setup at devicePixelRatio, returns ctx with logical w/h
function setup(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.width, h = canvas.height;
  canvas.width = w * dpr; canvas.height = h * dpr;
  canvas.style.aspectRatio = `${w} / ${h}`;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  return { ctx, w, h };
}

const AX = '#3a4150', GRID = '#20242c', INK = '#98a2b3', INK2 = '#5d6675', ACC = '#4a9eff';
const AMBER = '#d8a04c', BLUE = '#7fb2e8', RED = '#e0565f', GREEN = '#4ade80';

/* ── ISA + airspeed calibration ─────────────────────────────── */
const P0 = 29.92126;                                        // in Hg at sea level
const isaP = hFt => P0 * Math.pow(1 - 6.87535e-6 * hFt, 5.2561);
const isaH = p => (1 - Math.pow(p / P0, 1 / 5.2561)) / 6.87535e-6;
const A0 = 661.47;                                          // kt, speed of sound SL
const qcOf = cas => P0 * (Math.pow(1 + 0.2 * (cas / A0) ** 2, 3.5) - 1);
const casOf = qc => qc <= 0 ? 0 : A0 * Math.sqrt(5 * (Math.pow(qc / P0 + 1, 2 / 7) - 1));

/* ── shared gauge primitives ────────────────────────────────── */
function gaugeFace(ctx, cx, cy, r, label) {
  ctx.fillStyle = '#0c0f14'; ctx.beginPath(); ctx.arc(cx, cy, r + 8, 0, 7); ctx.fill();
  ctx.strokeStyle = '#39404e'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(cx, cy, r + 8, 0, 7); ctx.stroke(); ctx.lineWidth = 1;
  ctx.fillStyle = '#10151c'; ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7); ctx.fill();
  if (label) {
    ctx.fillStyle = INK2; ctx.font = '11px system-ui';
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText(label, cx, cy + r + 12);
  }
}
function tickAt(ctx, cx, cy, angDeg, r0, r1, color, w) {
  const a = angDeg * DEG;
  ctx.strokeStyle = color; ctx.lineWidth = w || 1;
  ctx.beginPath();
  ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
  ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
  ctx.stroke(); ctx.lineWidth = 1;
}
function needleAt(ctx, cx, cy, angDeg, len, color, w, tail) {
  const a = angDeg * DEG;
  ctx.strokeStyle = color; ctx.lineWidth = w || 3; ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(cx - Math.cos(a) * (tail || 14), cy - Math.sin(a) * (tail || 14));
  ctx.lineTo(cx + Math.cos(a) * len, cy + Math.sin(a) * len);
  ctx.stroke(); ctx.lineCap = 'butt'; ctx.lineWidth = 1;
  ctx.fillStyle = color; ctx.beginPath(); ctx.arc(cx, cy, 4.5, 0, 7); ctx.fill();
}
function redX(ctx, x, y, s) {
  ctx.strokeStyle = RED; ctx.lineWidth = 3; ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x - s, y - s); ctx.lineTo(x + s, y + s);
  ctx.moveTo(x + s, y - s); ctx.lineTo(x - s, y + s);
  ctx.stroke(); ctx.lineCap = 'butt'; ctx.lineWidth = 1;
  ctx.strokeStyle = RED + '66';
  ctx.beginPath(); ctx.arc(x, y, s + 5, 0, 7); ctx.stroke();
}

/* ══ 1 · Pitot-static blockage sim ══════════════════════════ */
(() => {
  const dia = setup($('ps-diagram'));
  const guts = setup($('ps-guts'));
  const gau = setup($('ps-gauges'));
  const GX = { asi: 170, alt: 480, vsi: 790 };   // gauge centers (x), shared with diagram
  const CY = 152, R = 118;
  const TSCALE = 8;                              // sim time speed-up (VSI reads sim-time rate)

  let scenario = 'normal';
  let frozenPt = null, frozenPs = null, blockAlt = null;
  let vsCmd = 0;                                 // commanded fpm from profile buttons
  let altF = +$('ps-alt').value;                 // float altitude — source of truth
  let dIas = 105, dAlt = altF, dVsi = 0, prevIndAlt = altF, last = null;
  $('ps-alt').addEventListener('input', () => { altF = +$('ps-alt').value; });

  function snapshot() {
    frozenPs = isaP(altF);
    frozenPt = isaP(altF) + qcOf(+$('ps-ias').value);
    blockAlt = Math.round(altF);
  }

  const SCN_BTNS = { normal: 'ps-normal', ram: 'ps-ram', both: 'ps-both', static: 'ps-static' };
  function setScenario(s) {
    scenario = s;
    if (s !== 'normal') snapshot();
    for (const k in SCN_BTNS) $(SCN_BTNS[k]).classList.toggle('active', k === s);
    drawDiagram();
  }
  for (const k in SCN_BTNS) $(SCN_BTNS[k]).addEventListener('click', () => setScenario(k));

  const PRO_BTNS = [['ps-climb', 500], ['ps-level', 0], ['ps-desc', -500]];
  function setProfile(v) {
    vsCmd = v;
    PRO_BTNS.forEach(([id, pv]) => $(id).classList.toggle('active', pv === v));
  }
  PRO_BTNS.forEach(([id, v]) => $(id).addEventListener('click', () => setProfile(v)));

  function state() {
    const alt = altF, ias = +$('ps-ias').value;
    const psA = isaP(alt), ptA = psA + qcOf(ias);
    let psL = psA, ptL = ptA;
    if (scenario === 'ram') ptL = psA;           // ram blocked, drain bleeds line to static
    else if (scenario === 'both') ptL = frozenPt;
    else if (scenario === 'static') psL = frozenPs;
    return { alt, ias, psL, ptL, indIas: casOf(ptL - psL), indAlt: isaH(psL) };
  }

  /* ---- air molecules in the cases: dot count tracks static-line pressure ----
     Dots drift Brownian-style inside the case, bouncing off the walls and the
     mechanism's keep-out box; the first N are drawn each frame with N mapped
     over the working pressure range (exaggerated, so a climb visibly thins the
     air). The wafers get none — that's the vacuum. */
  const inBox = (x, y, b) => x > b[0] && y > b[1] && x < b[2] && y < b[3];
  function gasRegion(n, cx, ex) {
    const x0 = cx - 102, y0 = 42, x1 = cx + 102, y1 = 188;
    const pts = [];
    let guard = 0;
    while (pts.length < n && guard < n * 80) {
      guard++;
      const x = x0 + Math.random() * (x1 - x0), y = y0 + Math.random() * (y1 - y0);
      if (inBox(x, y, ex)) continue;
      pts.push({ x, y, a: Math.random() * 6.28 });
    }
    return { pts, x0, y0, x1, y1, ex };
  }
  const MOL = {
    asi: gasRegion(44, GX.asi, [GX.asi - 84, 82, GX.asi + 88, 158]),
    alt: gasRegion(52, GX.alt, [GX.alt - 38, 46, GX.alt + 98, 186]),
    vsi: gasRegion(44, GX.vsi, [GX.vsi - 82, 92, GX.vsi + 78, 160])
  };
  const MOL_V = 16;                                // px/s drift speed
  function moveGas(rg, dt) {
    for (const p of rg.pts) {
      p.a += (Math.random() - 0.5) * 0.5;
      const nx = p.x + Math.cos(p.a) * MOL_V * dt;
      const ny = p.y + Math.sin(p.a) * MOL_V * dt;
      if (nx < rg.x0 || nx > rg.x1) { p.a = Math.PI - p.a; continue; }
      if (ny < rg.y0 || ny > rg.y1) { p.a = -p.a; continue; }
      if (inBox(nx, ny, rg.ex)) { p.a += Math.PI; continue; }
      p.x = nx; p.y = ny;
    }
  }
  function drawGas(ctx, rg, n) {
    ctx.fillStyle = 'rgba(139,187,238,0.9)';
    for (let i = 0; i < n && i < rg.pts.length; i++) {
      ctx.beginPath(); ctx.arc(rg.pts[i].x, rg.pts[i].y, 2.1, 0, 7); ctx.fill();
    }
  }
  // pressure → dot count, stretched over the 0–12,000 ft working range
  const nOf = (maxN, p) => Math.round(maxN * clamp((p / P0 - 0.55) / 0.45, 0.07, 1.05));
  let molT = null;

  /* ---- plumbing diagram (redrawn on scenario change) ---- */
  function drawDiagram() {
    const { ctx, w, h } = dia;
    ctx.clearRect(0, 0, w, h);

    const deadPitot = scenario === 'ram';
    const deadStatic = scenario === 'static';

    // pitot line: tube → across → down into the ASI (x = GX.asi − 12)
    const PX = GX.asi - 12;
    ctx.strokeStyle = deadPitot ? '#6b5a3a' : AMBER; ctx.lineWidth = 2.5;
    if (deadPitot) ctx.setLineDash([5, 5]);
    ctx.beginPath(); ctx.moveTo(150, 71); ctx.lineTo(PX, 71); ctx.lineTo(PX, h); ctx.stroke();
    ctx.setLineDash([]);

    // static line: port → across → tee down at each instrument
    const dim = deadStatic;
    ctx.strokeStyle = dim ? '#41546b' : BLUE;
    ctx.beginPath();
    ctx.moveTo(78, 152); ctx.lineTo(GX.vsi, 152); ctx.lineTo(GX.vsi, h);
    ctx.moveTo(GX.asi + 12, 152); ctx.lineTo(GX.asi + 12, h);
    ctx.moveTo(GX.alt, 152); ctx.lineTo(GX.alt, h);
    ctx.stroke(); ctx.lineWidth = 1;

    // pitot tube (side view, open mouth at left, drain underneath)
    ctx.strokeStyle = '#c5cbd6'; ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(58, 62); ctx.lineTo(150, 62);                 // top wall
    ctx.moveTo(58, 80); ctx.lineTo(124, 80);                 // bottom wall to drain gap
    ctx.moveTo(136, 80); ctx.lineTo(150, 80);                // bottom wall after drain
    ctx.moveTo(58, 62); ctx.lineTo(58, 66);                  // lip
    ctx.moveTo(58, 80); ctx.lineTo(58, 76);
    ctx.stroke(); ctx.lineWidth = 1;
    ctx.strokeStyle = INK2;                                  // drain passage
    ctx.beginPath(); ctx.moveTo(130, 80); ctx.lineTo(130, 92); ctx.stroke();

    // ram-air arrows
    ctx.strokeStyle = INK; ctx.fillStyle = INK;
    for (const ay of [66, 71, 76]) {
      ctx.beginPath(); ctx.moveTo(22, ay); ctx.lineTo(46, ay); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(52, ay); ctx.lineTo(45, ay - 3); ctx.lineTo(45, ay + 3); ctx.fill();
    }

    // static port
    ctx.strokeStyle = '#c5cbd6'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(70, 152, 9, 0, 7); ctx.stroke(); ctx.lineWidth = 1;
    ctx.fillStyle = '#c5cbd6';
    for (const [dx, dy] of [[-3, -3], [3, -3], [-3, 3], [3, 3], [0, 0]]) {
      ctx.beginPath(); ctx.arc(70 + dx, 152 + dy, 1.1, 0, 7); ctx.fill();
    }

    // labels
    ctx.font = '11px system-ui'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillStyle = INK; ctx.fillText('pitot tube', 62, 48);
    ctx.fillStyle = INK2; ctx.fillText('drain hole', 140, 98);
    ctx.fillStyle = INK; ctx.fillText('static port', 52, 176);
    ctx.fillStyle = deadPitot ? '#6b5a3a' : AMBER;
    ctx.fillText(scenario === 'both' ? `pitot (total) pressure — trapped at ${fmt(blockAlt)} ft` : 'pitot (total) pressure', 200, 60);
    ctx.fillStyle = dim ? '#41546b' : BLUE;
    ctx.fillText(deadStatic ? `static pressure — trapped at ${fmt(blockAlt)} ft` : 'static pressure', 200, 141);

    // which gauge gets which line
    ctx.fillStyle = INK2; ctx.textAlign = 'center';
    ctx.fillText('↓ pitot + static', GX.asi, 190);
    ctx.fillText('↓ static only', GX.alt, 190);
    ctx.fillText('↓ static only', GX.vsi, 190);

    // blockages
    if (scenario === 'ram' || scenario === 'both') redX(ctx, 52, 71, 7);
    if (scenario === 'both') redX(ctx, 130, 88, 6);
    if (scenario === 'static') redX(ctx, 70, 152, 7);
  }

  /* ---- mechanism cutaways (the "X-ray" row) ----
     Positions are driven by the same displayed values as the needles, so a
     frozen static line literally freezes the wafers and the trapped-pitot
     diaphragm keeps swelling in a climb. */
  function capsulePath(ctx, x0, x1, ymid, b) {
    ctx.beginPath();
    ctx.moveTo(x0, ymid);
    ctx.quadraticCurveTo((x0 + x1) / 2, ymid - 2 * b, x1, ymid);
    ctx.quadraticCurveTo((x0 + x1) / 2, ymid + 2 * b, x0, ymid);
    ctx.closePath();
  }
  function gearAt(ctx, x, y) {
    ctx.fillStyle = '#232833'; ctx.beginPath(); ctx.arc(x, y, 7, 0, 7); ctx.fill();
    ctx.strokeStyle = '#8892a2'; ctx.beginPath(); ctx.arc(x, y, 7, 0, 7); ctx.stroke();
    ctx.fillStyle = '#8892a2'; ctx.beginPath(); ctx.arc(x, y, 2, 0, 7); ctx.fill();
  }

  function drawGuts(st, tSec) {
    const { ctx, w, h } = guts;
    ctx.clearRect(0, 0, w, h);
    const P_COL = scenario === 'ram' ? '#6b5a3a' : AMBER;
    const S_COL = scenario === 'static' ? '#41546b' : BLUE;
    const CASE_T = 34, CASE_B = 196, GEAR_Y = 178;
    const dtm = molT === null ? 0 : clamp(tSec - molT, 0, 0.1);
    molT = tSec;
    for (const k in MOL) moveGas(MOL[k], dtm);

    ctx.font = '10.5px system-ui'; ctx.textBaseline = 'middle';
    const label = (x, y, txt, color, align) => {
      ctx.fillStyle = color; ctx.textAlign = align || 'left'; ctx.fillText(txt, x, y);
    };
    const caseBox = cx => {
      ctx.fillStyle = 'rgba(127,178,232,0.06)';
      ctx.strokeStyle = '#4a5262'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.roundRect(cx - 110, CASE_T, 220, CASE_B - CASE_T, 10);
      ctx.fill(); ctx.stroke(); ctx.lineWidth = 1;
    };
    const stub = (x, color) => {
      ctx.strokeStyle = color; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, CASE_T); ctx.stroke(); ctx.lineWidth = 1;
    };
    const shaft = cx => {
      ctx.strokeStyle = '#8892a2'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(cx, CASE_B); ctx.lineTo(cx, h); ctx.stroke(); ctx.lineWidth = 1;
      gearAt(ctx, cx, GEAR_Y);
    };
    const rod = pts => {
      ctx.strokeStyle = '#8892a2'; ctx.lineWidth = 2;
      ctx.beginPath(); pts.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
      ctx.stroke(); ctx.lineWidth = 1;
    };
    const bracket = (x, y) => { ctx.fillStyle = '#39404e'; ctx.fillRect(x, y, 12, 24); };
    const corrugate = (cxm, halfw, ymid, b, color) => {
      ctx.strokeStyle = color; ctx.globalAlpha = 0.35;
      for (const s of [0.62, 0.82]) {
        capsulePath(ctx, cxm - halfw * s, cxm + halfw * s, ymid, b * s); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    };

    /* — ASI: diaphragm, pitot inside, static around it — */
    {
      const cx = GX.asi;
      caseBox(cx);
      drawGas(ctx, MOL.asi, nOf(44, st.psL));
      stub(cx - 12, P_COL); stub(cx + 12, S_COL);
      ctx.strokeStyle = S_COL; ctx.lineWidth = 2.5;                       // static vents into the case
      ctx.beginPath(); ctx.moveTo(cx + 12, CASE_T); ctx.lineTo(cx + 12, 52); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx + 4, 56); ctx.lineTo(cx + 20, 56); ctx.stroke();
      ctx.beginPath();                                                    // pitot pipes into the capsule
      ctx.moveTo(cx - 12, CASE_T); ctx.lineTo(cx - 12, 58);
      ctx.lineTo(cx - 74, 58); ctx.lineTo(cx - 74, 120);
      ctx.stroke(); ctx.lineWidth = 1;
      bracket(cx - 82, 108);
      const qFrac = clamp(qcOf(clamp(dIas, 0, 200)) / qcOf(200), 0, 1);
      const bA = 4 + 26 * Math.sqrt(qFrac);
      capsulePath(ctx, cx - 70, cx + 74, 120, bA);
      ctx.fillStyle = 'rgba(216,160,76,0.22)'; ctx.fill();
      ctx.strokeStyle = P_COL; ctx.lineWidth = 2; ctx.stroke(); ctx.lineWidth = 1;
      corrugate(cx + 2, 72, 120, bA, P_COL);
      rod([[cx + 74, 120], [cx + 88, 146], [cx + 6, 174]]);
      shaft(cx);
      label(cx - 102, 162, 'diaphragm — pitot inside', P_COL);
      label(cx + 102, 72, 'static fills the case', S_COL, 'right');
      label(cx + 10, h - 14, 'gears turn the needle below', '#8892a2');
    }

    /* — Altimeter: sealed vacuum wafers, static around them — */
    {
      const cx = GX.alt;
      caseBox(cx);
      drawGas(ctx, MOL.alt, nOf(52, st.psL));
      stub(cx, S_COL);
      ctx.strokeStyle = S_COL; ctx.lineWidth = 2.5;                       // static vents into the case
      ctx.beginPath();
      ctx.moveTo(cx, CASE_T); ctx.lineTo(cx, 46); ctx.lineTo(cx - 48, 46); ctx.lineTo(cx - 48, 56);
      ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx - 56, 60); ctx.lineTo(cx - 40, 60); ctx.stroke(); ctx.lineWidth = 1;
      ctx.fillStyle = '#39404e'; ctx.fillRect(cx + 18, 50, 24, 8);        // top anchor for the stack
      const aFrac = clamp(dAlt / 12000, 0, 1);
      const hw = 7 + 9 * aFrac;
      let y = 62 + hw;
      for (let i = 0; i < 3; i++) {
        capsulePath(ctx, cx - 30, cx + 90, y, hw);
        ctx.fillStyle = '#10141a'; ctx.fill();
        ctx.strokeStyle = '#9aa5b4'; ctx.lineWidth = 1.5; ctx.stroke(); ctx.lineWidth = 1;
        ctx.strokeStyle = '#4a5262';
        ctx.beginPath(); ctx.moveTo(cx - 26, y); ctx.lineTo(cx + 86, y); ctx.stroke();
        y += 2 * hw + 5;
      }
      const stackBot = y - hw - 5;                // bottom tip of the lowest wafer
      rod([[cx + 30, stackBot], [cx + 4, 174]]);
      shaft(cx);
      label(cx - 104, 100, 'sealed wafers,', '#9aa5b4');
      label(cx - 104, 113, 'vacuum inside', '#9aa5b4');
      label(cx - 104, 132, 'they swell as the', INK2);
      label(cx - 104, 145, 'case pressure falls', INK2);
    }

    /* — VSI: diaphragm fed directly, case fed through the leak — */
    {
      const cx = GX.vsi;
      caseBox(cx);
      drawGas(ctx, MOL.vsi, nOf(44, st.psL));
      stub(cx, S_COL);
      ctx.strokeStyle = S_COL; ctx.lineWidth = 2.5;
      ctx.beginPath();                                                    // direct branch → capsule
      ctx.moveTo(cx, CASE_T); ctx.lineTo(cx, 44);
      ctx.lineTo(cx - 74, 44); ctx.lineTo(cx - 74, 126);
      ctx.stroke();
      ctx.beginPath();                                                    // leak branch → case
      ctx.moveTo(cx, 44); ctx.lineTo(cx + 66, 44); ctx.lineTo(cx + 66, 56);
      ctx.stroke(); ctx.lineWidth = 1;
      ctx.strokeStyle = S_COL;                                            // the calibrated leak: a throat
      ctx.beginPath();
      ctx.moveTo(cx + 62, 56); ctx.lineTo(cx + 64.5, 68);
      ctx.moveTo(cx + 70, 56); ctx.lineTo(cx + 67.5, 68);
      ctx.moveTo(cx + 66, 68); ctx.lineTo(cx + 66, 76);
      ctx.stroke();
      if (Math.abs(dVsi) > 150) {                                         // air squeezing through the leak
        const up = dVsi > 0;                                              // climb: case bleeds out
        ctx.fillStyle = '#cfe6ff';
        ctx.beginPath();
        ctx.moveTo(cx + 66, up ? 58 : 66);
        ctx.lineTo(cx + 63, up ? 64 : 60);
        ctx.lineTo(cx + 69, up ? 64 : 60);
        ctx.fill();
      }
      bracket(cx - 86, 114);
      const bV = 14 - 10 * clamp(dVsi / 2000, -1, 1);
      capsulePath(ctx, cx - 74, cx + 70, 126, bV);
      ctx.fillStyle = 'rgba(127,178,232,0.20)'; ctx.fill();
      ctx.strokeStyle = S_COL; ctx.lineWidth = 2; ctx.stroke(); ctx.lineWidth = 1;
      corrugate(cx - 2, 72, 126, bV, S_COL);
      rod([[cx + 70, 126], [cx + 84, 152], [cx + 6, 174]]);
      shaft(cx);
      label(cx - 68, 58, 'direct to diaphragm', S_COL);
      label(cx + 66, 90, 'calibrated leak', S_COL, 'center');
      label(cx - 102, 166, 'diaphragm — static inside', S_COL);
    }
  }

  /* ---- gauges ---- */
  function drawASI(ctx, cx, cy, v) {
    gaugeFace(ctx, cx, cy, R, 'airspeed — knots');
    const ang = k => -90 + k * (330 / 200);
    // arcs: white 45–85 (inner), green 50–130, yellow 130–165, red line 165
    const arc = (v0, v1, rr, color, lw) => {
      ctx.strokeStyle = color; ctx.lineWidth = lw;
      ctx.beginPath(); ctx.arc(cx, cy, rr, ang(v0) * DEG, ang(v1) * DEG); ctx.stroke();
      ctx.lineWidth = 1;
    };
    arc(50, 130, R - 13, '#3f8f57', 5);
    arc(130, 165, R - 13, '#b99a3d', 5);
    arc(45, 85, R - 21, '#c9d2df', 4);
    tickAt(ctx, cx, cy, ang(165), R - 19, R - 6, RED, 3);
    for (let k = 0; k <= 200; k += 10) {
      const major = k % 20 === 0;
      tickAt(ctx, cx, cy, ang(k), R - (major ? 12 : 8), R - 2, '#aeb7c4', major ? 2 : 1);
      if (major) {
        const a = ang(k) * DEG;
        ctx.fillStyle = '#c9d2df'; ctx.font = '600 11px system-ui';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(k, cx + Math.cos(a) * (R - 34), cy + Math.sin(a) * (R - 34));
      }
    }
    needleAt(ctx, cx, cy, ang(clamp(v, 0, 200)), R - 30, '#f2f5fa');
  }

  function drawALT(ctx, cx, cy, alt) {
    gaugeFace(ctx, cx, cy, R, 'altimeter — feet');
    for (let i = 0; i < 50; i++) {
      const major = i % 5 === 0;
      tickAt(ctx, cx, cy, -90 + i * 7.2, R - (major ? 12 : 7), R - 2, '#aeb7c4', major ? 2 : 1);
    }
    for (let i = 0; i < 10; i++) {
      const a = (-90 + i * 36) * DEG;
      ctx.fillStyle = '#c9d2df'; ctx.font = '600 14px system-ui';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(i, cx + Math.cos(a) * (R - 28), cy + Math.sin(a) * (R - 28));
    }
    // Kollsman window (this sim: correctly set, standard day)
    ctx.fillStyle = '#0b0e12'; ctx.strokeStyle = '#2a3040';
    ctx.fillRect(cx + 28, cy - 10, 52, 20); ctx.strokeRect(cx + 28, cy - 10, 52, 20);
    ctx.fillStyle = INK; ctx.font = '11px system-ui'; ctx.textAlign = 'center';
    ctx.fillText('29.92', cx + 54, cy + 1);
    const a = clamp(alt, -1000, 20000);
    needleAt(ctx, cx, cy, -90 + (((a % 10000) + 10000) % 10000) / 10000 * 360, R * 0.5, '#dfe6f0', 7, 10);
    needleAt(ctx, cx, cy, -90 + (((a % 1000) + 1000) % 1000) / 1000 * 360, R - 32, '#f2f5fa', 3);
  }

  function drawVSI(ctx, cx, cy, v) {
    gaugeFace(ctx, cx, cy, R, 'vertical speed — fpm ×100');
    const ang = k => 180 + (k / 2000) * 160;
    for (let k = -2000; k <= 2000; k += 100) {
      const major = k % 500 === 0;
      tickAt(ctx, cx, cy, ang(k), R - (major ? 12 : 7), R - 2, '#aeb7c4', major ? 2 : 1);
      if (major) {
        const a = ang(k) * DEG;
        ctx.fillStyle = '#c9d2df'; ctx.font = '600 12px system-ui';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(Math.abs(k) / 100, cx + Math.cos(a) * (R - 28), cy + Math.sin(a) * (R - 28));
      }
    }
    ctx.fillStyle = INK2; ctx.font = '10px system-ui'; ctx.textAlign = 'center';
    ctx.fillText('UP', cx - R * 0.52, cy - R * 0.42);
    ctx.fillText('DOWN', cx - R * 0.52, cy + R * 0.46);
    needleAt(ctx, cx, cy, ang(clamp(v, -2100, 2100)), R - 30, '#f2f5fa');
  }

  function drawGauges() {
    const { ctx, w, h } = gau;
    ctx.clearRect(0, 0, w, h);
    // needle drive shafts continuing down from the mechanism row above
    ctx.strokeStyle = '#8892a2'; ctx.lineWidth = 2;
    for (const x of [GX.asi, GX.alt, GX.vsi]) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, CY - R - 4); ctx.stroke();
    }
    ctx.lineWidth = 1;
    drawASI(ctx, GX.asi, CY, dIas);
    drawALT(ctx, GX.alt, CY, dAlt);
    drawVSI(ctx, GX.vsi, CY, dVsi);
  }

  /* one-sentence failure impact per instrument, bold across the top */
  const IMPACT = {
    normal: [['ok', 'ASI — healthy: reads your true airspeed.'],
             ['ok', 'Altimeter — healthy: tracks your altitude.'],
             ['ok', 'VSI — healthy: shows the real climb rate.']],
    ram:    [['bad', 'ASI — pressure bleeds out the drain: winds down to zero and stays there.'],
             ['ok', 'Altimeter — unaffected: it relies on the static port only.'],
             ['ok', 'VSI — unaffected: it relies on the static port only.']],
    both:   [['bad', 'ASI — trapped pitot air makes it a fake altimeter: reads fast in a climb, slow in a descent.'],
             ['ok', 'Altimeter — unaffected: it relies on the static port only.'],
             ['ok', 'VSI — unaffected: it relies on the static port only.']],
    static: [['bad', 'ASI — reads slow above the blockage altitude, fast below it.'],
             ['bad', 'Altimeter — frozen at the blockage altitude.'],
             ['bad', 'VSI — stuck on zero no matter what you fly.']]
  };
  let impactScn = null;

  function updateText(st) {
    if (impactScn !== scenario) {
      impactScn = scenario;
      [['imp-asi', 0], ['imp-alt', 1], ['imp-vsi', 2]].forEach(([id, i]) => {
        const el = $(id);
        el.className = 'imp ' + IMPACT[scenario][i][0];
        el.textContent = IMPACT[scenario][i][1];
      });
    }
    $('ps-alt-val').innerHTML = `${fmt(st.alt)} <span class="u">ft</span>`;
    $('ps-ias-val').innerHTML = `${fmt(st.ias)} <span class="u">kt</span>`;
    $('ps-t-alt').innerHTML = `${fmt(st.alt)}<span class="u"> ft</span>`;
    $('ps-t-ias').innerHTML = `${fmt(st.ias)}<span class="u"> kt</span>`;
    $('ps-t-vs').innerHTML = vsCmd === 0 ? `level` : `${vsCmd > 0 ? '+' : '−'}500<span class="u"> fpm</span>`;
    $('ps-t-block').innerHTML =
      scenario === 'normal' ? '—' :
      scenario === 'ram' ? 'pitot ram' :
      `${scenario === 'both' ? 'pitot' : 'static'}<span class="u"> @ ${fmt(blockAlt)} ft</span>`;

    const vd = $('ps-verdict');
    const dAltFt = st.alt - (blockAlt ?? st.alt);
    if (scenario === 'normal') {
      vd.className = 'verdict on';
      vd.innerHTML = `<b>System healthy.</b> ASI reads ${fmt(st.indIas)} kt, altimeter ${fmt(st.indAlt)} ft, VSI tracking the profile. Pick a blockage above, then climb or descend — the failures only show themselves when the pressure changes.`;
    } else if (scenario === 'ram') {
      vd.className = 'verdict high';
      vd.innerHTML = `<b>Ram opening blocked, drain open.</b> The trapped pressure bled out the drain hole, so the ASI drops to <b>zero</b> and stays there — no matter what you fly (you're actually at ${fmt(st.ias)} kt). The altimeter and VSI live on the static side and are still honest.`;
    } else if (scenario === 'both') {
      const diff = st.indIas - st.ias;
      vd.className = 'verdict bad';
      vd.innerHTML = `<b>Pitot ram + drain both blocked — the ASI is now an altimeter.</b> Total pressure is trapped from ${fmt(blockAlt)} ft. ` +
        (Math.abs(dAltFt) < 60
          ? `Right now you're near the blockage altitude so it reads about right — <b>climb and watch it read faster</b>.`
          : `You're ${fmt(Math.abs(dAltFt))} ft ${dAltFt > 0 ? 'above' : 'below'} the blockage: it reads <b>${fmt(st.indIas)} kt</b> while you're actually at ${fmt(st.ias)} kt (${diff > 0 ? 'over' : 'under'}-reading by ${fmt(Math.abs(diff))} kt). ${dAltFt > 0 ? 'Chasing this needle in a climb means pitching up toward the stall.' : 'In a descent it under-reads — tempting a push toward Vne.'}`);
    } else {
      const diff = st.indIas - st.ias;
      vd.className = 'verdict bad';
      vd.innerHTML = `<b>Static port blocked.</b> The altimeter is frozen at <b>${fmt(blockAlt)} ft</b> and the VSI swears you're level. ` +
        (Math.abs(dAltFt) < 60
          ? `Climb or descend and watch all three gauges lie at once.`
          : `You're really ${fmt(Math.abs(dAltFt))} ft ${dAltFt > 0 ? 'higher' : 'lower'}, and the ASI is lying too: <b>${fmt(st.indIas)} kt</b> indicated vs ${fmt(st.ias)} kt actual — it reads ${diff < 0 ? 'slow above' : 'fast below'} the blockage. Pull the alternate static.`);
    }
  }

  let dtCarry = 0;
  function frame(t) {
    if (last === null) last = t;
    const dt = Math.min(0.1, (t - last) / 1000); last = t;
    const dtSim = dt * TSCALE;
    if (vsCmd !== 0) {
      altF += vsCmd / 60 * dtSim;
      if (altF >= 12000 || altF <= 0) { altF = clamp(altF, 0, 12000); setProfile(0); }
      $('ps-alt').value = altF;
    }
    const st = state();
    const k = 1 - Math.exp(-dtSim / 0.6);
    dIas += (st.indIas - dIas) * k;
    dAlt += (st.indAlt - dAlt) * k;
    const rate = dtSim > 0 ? (st.indAlt - prevIndAlt) / dtSim * 60 : 0;
    prevIndAlt = st.indAlt;
    dVsi += (clamp(rate, -2400, 2400) - dVsi) * (1 - Math.exp(-dtSim / 1.6));
    drawGuts(st, t / 1000);
    drawGauges();
    updateText(st);
    requestAnimationFrame(frame);
  }

  drawDiagram();
  requestAnimationFrame(frame);
})();

/* ══ 2 · Altimeter errors ═══════════════════════════════════ */
(() => {
  const { ctx, w, h } = setup($('alt-canvas'));
  const OBST = 3000;
  const py = ft => 296 - ft / 8500 * 272;

  function drawPlane(c, x, y, color, ghost) {
    c.save(); c.translate(x, y);
    c.strokeStyle = color; c.fillStyle = color; c.lineWidth = 2;
    if (ghost) c.setLineDash([3, 3]);
    c.beginPath();                                  // fuselage, nose right
    c.moveTo(24, 0); c.quadraticCurveTo(10, -6, -16, -4);
    c.lineTo(-24, -12); c.lineTo(-26, -10); c.lineTo(-20, -2);
    c.lineTo(-24, 2); c.quadraticCurveTo(0, 6, 24, 0);
    c.closePath();
    ghost ? c.stroke() : c.fill();
    if (!ghost) { c.beginPath(); c.moveTo(4, -2); c.lineTo(-6, 8); c.lineTo(-2, 8); c.lineTo(8, -1); c.fill(); }
    c.setLineDash([]); c.restore(); c.lineWidth = 1;
  }

  function draw() {
    const hInd = +$('alt-ind').value, setV = +$('alt-set').value,
          actV = +$('alt-act').value, dIsa = +$('alt-oat').value;
    $('alt-ind-val').innerHTML = `${fmt(hInd)} <span class="u">ft</span>`;
    $('alt-set-val').innerHTML = `${setV.toFixed(2)} <span class="u">in Hg</span>`;
    $('alt-act-val').innerHTML = `${actV.toFixed(2)} <span class="u">in Hg</span>`;
    $('alt-oat-val').innerHTML = `ISA${dIsa >= 0 ? '+' : '−'}${Math.abs(dIsa)} <span class="u">(${fmt(15 + dIsa)} °C sfc)</span>`;

    const pressErr = isaH(setV) - isaH(actV);       // ft, true − indicated (pressure part)
    const tRatio = (288.15 + dIsa) / 288.15;
    const hTrue = (hInd + pressErr) * tRatio;
    const tempErr = hTrue - (hInd + pressErr);
    const clear = hTrue - OBST;

    const sgn = v => `${v >= 0 ? '+' : '−'}${fmt(Math.abs(v))}`;
    $('alt-t-press').innerHTML = `${sgn(pressErr)}<span class="u"> ft</span>`;
    $('alt-t-temp').innerHTML = `${sgn(tempErr)}<span class="u"> ft</span>`;
    $('alt-t-true').innerHTML = `${fmt(hTrue)}<span class="u"> ft</span>`;
    $('alt-t-clear').innerHTML = `${fmt(clear)}<span class="u"> ft</span>`;

    // ---- scene ----
    ctx.clearRect(0, 0, w, h);
    const gy = 296;
    ctx.strokeStyle = '#3d4450'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(20, gy); ctx.lineTo(w - 20, gy); ctx.stroke(); ctx.lineWidth = 1;
    ctx.strokeStyle = '#262b33';
    for (let x = 26; x < w - 20; x += 17) { ctx.beginPath(); ctx.moveTo(x, gy); ctx.lineTo(x - 8, gy + 8); ctx.stroke(); }

    // ridge
    ctx.fillStyle = '#242a33'; ctx.strokeStyle = '#39404e';
    ctx.beginPath(); ctx.moveTo(470, gy); ctx.lineTo(600, py(OBST)); ctx.lineTo(730, gy); ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = INK; ctx.font = '11px system-ui'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    ctx.fillText(`ridge — ${fmt(OBST)} ft MSL`, 614, py(OBST) - 2);

    // indicated (dashed) line + ghost airplane
    const yi = py(hInd);
    ctx.strokeStyle = '#3a5a80'; ctx.setLineDash([6, 5]);
    ctx.beginPath(); ctx.moveTo(40, yi); ctx.lineTo(w - 40, yi); ctx.stroke(); ctx.setLineDash([]);
    drawPlane(ctx, 210, yi, '#5f87b5', true);
    ctx.fillStyle = '#8ab8e8'; ctx.font = '11px system-ui'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    ctx.fillText(`altimeter says ${fmt(hInd)} ft`, 44, yi - 5);

    // true position
    const yt = py(hTrue);
    const col = clear < 0 ? RED : clear < 800 ? AMBER : GREEN;
    drawPlane(ctx, 210, yt, col, false);
    ctx.fillStyle = col; ctx.textBaseline = yt > yi ? 'top' : 'bottom';
    ctx.fillText(`you're actually at ${fmt(hTrue)} ft`, 250, yt + (yt > yi ? 8 : -8));

    // error bracket
    const err = hTrue - hInd;
    if (Math.abs(err) > 40) {
      const bx = 120;
      ctx.strokeStyle = INK; ctx.beginPath(); ctx.moveTo(bx, yi); ctx.lineTo(bx, yt); ctx.stroke();
      ctx.fillStyle = INK;
      const tip = (yy, up) => { ctx.beginPath(); ctx.moveTo(bx, yy); ctx.lineTo(bx - 4, yy + (up ? 7 : -7)); ctx.lineTo(bx + 4, yy + (up ? 7 : -7)); ctx.fill(); };
      tip(Math.min(yi, yt), true); tip(Math.max(yi, yt), false);
      ctx.font = '600 11px system-ui'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillText(`${fmt(Math.abs(err))} ft ${err < 0 ? 'low' : 'high'}`, bx - 8, (yi + yt) / 2);
    }

    const vd = $('alt-verdict');
    if (clear < 0) {
      vd.className = 'verdict bad';
      vd.innerHTML = `<b>Below the ridge line.</b> The altimeter promises ${fmt(hInd - OBST)} ft of clearance; ${fmt(Math.abs(err))} ft of it doesn't exist. This is the controlled-flight-into-terrain setup — nothing in the cockpit looks wrong until the trees do.`;
    } else if (clear < 800) {
      vd.className = 'verdict high';
      vd.innerHTML = `<b>Only ${fmt(clear)} ft of real clearance</b> while the altimeter claims ${fmt(hInd - OBST)}. ${Math.abs(tempErr) > Math.abs(pressErr) ? 'Temperature is the bigger thief here — the whole air column below you has shrunk.' : 'The stale altimeter setting is the bigger thief here — reset it and the pressure error vanishes.'}`;
    } else if (Math.abs(err) < 60) {
      vd.className = 'verdict on';
      vd.innerHTML = `<b>Honest altimeter.</b> Setting current and temperature near standard — true and indicated agree within ${fmt(Math.abs(err))} ft.`;
    } else {
      vd.className = 'verdict on';
      vd.innerHTML = `<b>${fmt(clear)} ft of true clearance.</b> The altimeter is off by ${fmt(Math.abs(err))} ft (${err < 0 ? 'reading high — the dangerous direction' : 'reading low — annoying, but safe'}), and there's still room over this ridge. Drop the pressure or the temperature further and watch that margin go.`;
    }
  }

  const set = (id, v) => { $(id).value = v; };
  $('alt-p-low').addEventListener('click', () => { set('alt-set', 30.15); set('alt-act', 29.45); set('alt-oat', 0); set('alt-ind', 4000); draw(); });
  $('alt-p-cold').addEventListener('click', () => { set('alt-set', 29.92); set('alt-act', 29.92); set('alt-oat', -30); set('alt-ind', 4000); draw(); });
  $('alt-p-both').addEventListener('click', () => { set('alt-set', 30.05); set('alt-act', 29.55); set('alt-oat', -25); set('alt-ind', 4000); draw(); });
  $('alt-p-reset').addEventListener('click', () => { set('alt-set', 29.92); set('alt-act', 29.92); set('alt-oat', 0); set('alt-ind', 4000); draw(); });
  ['alt-ind', 'alt-set', 'alt-act', 'alt-oat'].forEach(id => $(id).addEventListener('input', draw));
  draw();
})();

/* ══ 3a · Heading indicator drift ═══════════════════════════ */
(() => {
  const { ctx, w, h } = setup($('gy-canvas'));
  const CARD = ['N', '3', '6', 'E', '12', '15', 'S', '21', '24', 'W', '30', '33'];

  function rose(cx, cy, r, ind, title) {
    gaugeFace(ctx, cx, cy, r, null);
    for (let H = 0; H < 360; H += 5) {
      const sa = angdiff(H, ind) - 90;              // screen angle: H at top when H == ind
      const major = H % 30 === 0, mid = H % 10 === 0;
      tickAt(ctx, cx, cy, sa, r - (major ? 14 : mid ? 10 : 6), r - 2, '#aeb7c4', major ? 2 : 1);
      if (major) {
        const a = sa * DEG;
        ctx.save();
        ctx.translate(cx + Math.cos(a) * (r - 26), cy + Math.sin(a) * (r - 26));
        ctx.rotate((sa + 90) * DEG);
        const lbl = CARD[H / 30];
        ctx.fillStyle = 'NEWS'.includes(lbl) ? '#e8eef6' : '#9aa5b4';
        ctx.font = `600 ${'NEWS'.includes(lbl) ? 14 : 12}px system-ui`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(lbl, 0, 0);
        ctx.restore();
      }
    }
    // fixed aircraft symbol + lubber mark
    ctx.strokeStyle = AMBER; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(cx, cy - 16); ctx.lineTo(cx, cy - 4); ctx.stroke();      // nose
    ctx.beginPath(); ctx.moveTo(cx - 14, cy + 2); ctx.lineTo(cx + 14, cy + 2); ctx.stroke(); // wings
    ctx.beginPath(); ctx.moveTo(cx - 6, cy + 9); ctx.lineTo(cx + 6, cy + 9); ctx.stroke();   // tail
    ctx.lineWidth = 1;
    ctx.fillStyle = AMBER;
    ctx.beginPath(); ctx.moveTo(cx, cy - r + 3); ctx.lineTo(cx - 5, cy - r - 6); ctx.lineTo(cx + 5, cy - r - 6); ctx.fill();
    ctx.fillStyle = INK2; ctx.font = '11px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText(title, cx, cy + r + 12);
  }

  function draw() {
    const lat = +$('gy-lat').value, min = +$('gy-min').value;
    $('gy-lat-val').innerHTML = `${lat}<span class="u">°N</span>`;
    $('gy-min-val').innerHTML = `${min} <span class="u">min</span>`;
    const rate = 15.04 * Math.sin(lat * DEG);
    const err = rate * min / 60;
    $('gy-t-rate').innerHTML = `${fmt(rate, 1)}<span class="u"> °/hr</span>`;
    $('gy-t-err').innerHTML = `${fmt(err, 1)}<span class="u">°</span>`;

    ctx.clearRect(0, 0, w, h);
    const r = 96, cy = 118;
    rose(260, cy, r, norm360(360 - err), `heading indicator — reads ${h3(360 - err)}`);
    rose(700, cy, r, 360, 'actual heading — 360');

    // error arc on the drifting rose: where true north ended up
    if (err > 0.5) {
      ctx.strokeStyle = RED; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(260, cy, r + 7, -90 * DEG, (-90 + err) * DEG); ctx.stroke();
      ctx.lineWidth = 1;
      ctx.fillStyle = RED; ctx.font = '600 11px system-ui'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
      ctx.fillText(`${fmt(err, 1)}° off`, 260 + 24, cy - r - 8);
    }
    ctx.fillStyle = INK2; ctx.font = '11px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('same airplane, parked on the same heading —', 480, h - 26);
    ctx.fillText('only the gyro card has moved', 480, h - 12);
  }
  ['gy-lat', 'gy-min'].forEach(id => $(id).addEventListener('input', draw));
  draw();
})();

/* ══ 3b · Attitude indicator false climb ════════════════════ */
(() => {
  const { ctx, w, h } = setup($('ai-canvas'));

  function draw() {
    const aG = +$('ai-acc').value;
    const tilt = Math.atan(aG) / DEG;                       // apparent-vertical tilt, ° (+ = aft)
    const aiPitch = clamp(tilt * 0.35, -5, 5);              // illustrative slow AI creep
    $('ai-acc-val').innerHTML = `${aG >= 0 ? '+' : '−'}${Math.abs(aG).toFixed(2)} <span class="u">g</span>`;
    $('ai-t-acc').innerHTML = `${Math.abs(aG).toFixed(2)}<span class="u"> g (${fmt(Math.abs(aG) * 19.06, 1)} kt/s)</span>`;
    $('ai-t-tilt').innerHTML = `${fmt(Math.abs(tilt), 1)}<span class="u">° ${aG >= 0 ? 'aft' : 'fwd'}</span>`;
    $('ai-t-ai').innerHTML = `≈${fmt(Math.abs(aiPitch), 1)}<span class="u">° ${aG >= 0 ? 'up' : 'down'}, slowly</span>`;
    $('ai-t-ear').innerHTML = `${fmt(Math.abs(tilt), 1)}<span class="u">° ${aG >= 0 ? 'up' : 'down'}, now</span>`;

    ctx.clearRect(0, 0, w, h);

    /* attitude indicator */
    const cx = 210, cy = 122, r = 100, PPD = 5;             // px per degree of pitch
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7); ctx.clip();
    const hy = cy + aiPitch * PPD;                          // indicated climb → horizon below center
    ctx.fillStyle = '#2c5b8f'; ctx.fillRect(cx - r, cy - r - 40, 2 * r, hy - (cy - r - 40));
    ctx.fillStyle = '#6b4726'; ctx.fillRect(cx - r, hy, 2 * r, cy + r + 40 - hy);
    ctx.strokeStyle = '#e8eef6'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(cx - r, hy); ctx.lineTo(cx + r, hy); ctx.stroke();
    // pitch ladder
    ctx.font = '10px system-ui'; ctx.textBaseline = 'middle'; ctx.lineWidth = 1.5;
    for (const p of [-10, -5, 5, 10]) {
      const y = hy - p * PPD, len = Math.abs(p) === 5 ? 22 : 36;
      ctx.strokeStyle = '#dfe6f0';
      ctx.beginPath(); ctx.moveTo(cx - len, y); ctx.lineTo(cx + len, y); ctx.stroke();
      ctx.fillStyle = '#dfe6f0'; ctx.textAlign = 'left';
      ctx.fillText(Math.abs(p), cx + len + 5, y);
    }
    ctx.restore(); ctx.lineWidth = 1;
    // miniature airplane (fixed)
    ctx.strokeStyle = '#f2a83c'; ctx.lineWidth = 4; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(cx - 52, cy); ctx.lineTo(cx - 16, cy); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx + 16, cy); ctx.lineTo(cx + 52, cy); ctx.stroke();
    ctx.lineCap = 'butt'; ctx.lineWidth = 1;
    ctx.fillStyle = '#f2a83c'; ctx.beginPath(); ctx.arc(cx, cy, 4, 0, 7); ctx.fill();
    // bezel
    ctx.strokeStyle = '#39404e'; ctx.lineWidth = 6;
    ctx.beginPath(); ctx.arc(cx, cy, r + 3, 0, 7); ctx.stroke(); ctx.lineWidth = 1;
    ctx.fillStyle = INK2; ctx.font = '11px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText(`attitude indicator — ${Math.abs(aiPitch) < 0.3 ? 'level' : `false ${fmt(Math.abs(aiPitch), 1)}° ${aiPitch >= 0 ? 'climb' : 'descent'}`}`, cx, cy + r + 14);

    /* apparent-gravity vector diagram */
    const vx = 650, vy = 70, S = 95;                        // 1 g ≡ S px
    ctx.strokeStyle = '#c5cbd6'; ctx.lineWidth = 2;         // airplane silhouette (nose right)
    ctx.beginPath(); ctx.moveTo(vx - 60, vy); ctx.lineTo(vx + 55, vy);
    ctx.moveTo(vx + 55, vy); ctx.lineTo(vx + 38, vy - 9);
    ctx.moveTo(vx - 30, vy); ctx.lineTo(vx - 46, vy - 16);
    ctx.stroke(); ctx.lineWidth = 1;
    const arrow = (x0, y0, x1, y1, color, label, lx, ly) => {
      ctx.strokeStyle = color; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke(); ctx.lineWidth = 1;
      const a = Math.atan2(y1 - y0, x1 - x0);
      ctx.save(); ctx.translate(x1, y1); ctx.rotate(a);
      ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(7, 0); ctx.lineTo(-4, -5); ctx.lineTo(-4, 5); ctx.fill();
      ctx.restore();
      ctx.fillStyle = color; ctx.font = '11px system-ui'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(label, lx, ly);
    };
    arrow(vx, vy + 8, vx, vy + 8 + S, INK, 'gravity — 1 g', vx + 10, vy + 8 + S - 6);
    if (Math.abs(aG) > 0.005) {
      arrow(vx, vy + 8, vx - aG * S, vy + 8, BLUE, `inertia — ${Math.abs(aG).toFixed(2)} g`, vx - aG * S + (aG > 0 ? -8 - 90 : 12), vy - 4);
      arrow(vx, vy + 8, vx - aG * S, vy + 8 + S, RED, '"down" you feel', vx - aG * S + (aG > 0 ? -8 - 92 : 12), vy + 8 + S + 10);
      // tilt arc between true and apparent vertical
      ctx.strokeStyle = RED;
      ctx.beginPath(); ctx.arc(vx, vy + 8, 52, 90 * DEG, (90 + tilt) * DEG, tilt < 0); ctx.stroke();
      ctx.fillStyle = RED; ctx.font = '600 11px system-ui'; ctx.textAlign = 'center';
      ctx.fillText(`${fmt(Math.abs(tilt), 1)}°`, vx - Math.sin(tilt / 2 * DEG) * 68, vy + 8 + 66);
    } else {
      ctx.fillStyle = INK2; ctx.font = '11px system-ui'; ctx.textAlign = 'left';
      ctx.fillText('no acceleration — "down" is straight down', vx + 16, vy + 60);
    }
  }
  $('ai-acc').addEventListener('input', draw);
  draw();
})();

/* ══ 4 · Magnetic compass — dip, UNOS, ANDS ═════════════════ */
(() => {
  const { ctx, w, h } = setup($('mc-canvas'));
  const V = 100 * 1.6878;                        // ft/s (TAS 100 kt for turn geometry)
  const TSCALE = 3;                              // turn sped up for the demo
  const CARD = ['N', '3', '6', 'E', '12', '15', 'S', '21', '24', 'W', '30', '33'];

  let mode = 'turn';
  let psi = 315, psiT = null, bankNow = 0, dir = 1;
  let spd = 105, spdT = 105, aNow = 0;
  let ind = null, last = null;

  const dipOf = lat => Math.atan(2 * Math.tan(lat * DEG));  // dipole approximation, radians

  function indicatedOf(psiDeg, bankDeg, aG, latDeg) {
    const d = dipOf(latDeg), p = psiDeg * DEG, phi = bankDeg * DEG, beta = Math.atan(aG);
    const fx = Math.cos(d) * Math.cos(p);
    const fy = -Math.cos(d) * Math.sin(p);
    const fz = Math.sin(d);
    const y1 = fy * Math.cos(phi) + fz * Math.sin(phi);     // card banks with the airplane
    const z1 = -fy * Math.sin(phi) + fz * Math.cos(phi);
    const xc = fx * Math.cos(beta) + z1 * Math.sin(beta);   // card tilts aft under acceleration
    return norm360(Math.atan2(-y1, xc) / DEG);
  }

  /* ---- controls ---- */
  function setMode(m) {
    mode = m;
    $('mc-turn').classList.toggle('active', m === 'turn');
    $('mc-accel').classList.toggle('active', m === 'accel');
    $('mc-turn-rows').style.display = m === 'turn' ? '' : 'none';
    $('mc-accel-rows').style.display = m === 'accel' ? '' : 'none';
    if (m === 'accel') { psiT = 90; aNow = 0; spd = 105; spdT = 105; setHdgBtns(90); }
    else { psi = 315; psiT = null; setDir(1); }
  }
  $('mc-turn').addEventListener('click', () => setMode('turn'));
  $('mc-accel').addEventListener('click', () => setMode('accel'));

  function setDir(d2) {
    dir = d2;
    $('mc-left').classList.toggle('active', d2 === -1);
    $('mc-stop').classList.toggle('active', d2 === 0);
    $('mc-right').classList.toggle('active', d2 === 1);
  }
  $('mc-left').addEventListener('click', () => setDir(-1));
  $('mc-stop').addEventListener('click', () => setDir(0));
  $('mc-right').addEventListener('click', () => setDir(1));

  const HDG_BTNS = [['mc-hn', 0], ['mc-he', 90], ['mc-hs', 180], ['mc-hw', 270]];
  function setHdgBtns(hd) {
    HDG_BTNS.forEach(([id, v]) => $(id).classList.toggle('active', v === hd));
  }
  HDG_BTNS.forEach(([id, v]) => $(id).addEventListener('click', () => { psiT = v; setHdgBtns(v); }));
  $('mc-acc').addEventListener('click', () => { spdT = 125; });
  $('mc-dec').addEventListener('click', () => { spdT = 85; });

  /* ---- drawing ---- */
  function drawCompass(indHdg) {
    // housing + window
    ctx.fillStyle = '#171b21'; ctx.strokeStyle = '#39404e'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.roundRect(50, 86, 400, 178, 14); ctx.fill(); ctx.stroke(); ctx.lineWidth = 1;
    const wx = 78, wy = 116, ww = 344, wh = 118, cx = wx + ww / 2;
    ctx.fillStyle = '#0b0e12'; ctx.fillRect(wx, wy, ww, wh);
    ctx.strokeStyle = '#2a3040'; ctx.strokeRect(wx, wy, ww, wh);

    ctx.save();
    ctx.beginPath(); ctx.rect(wx, wy, ww, wh); ctx.clip();
    const PPD = 3.8;
    const lo = Math.floor((indHdg - 48) / 5) * 5;
    for (let m = lo; m <= indHdg + 48; m += 5) {
      const H = norm360(m);
      const x = cx - angdiff(H, indHdg) * PPD;              // headings increase to the LEFT
      const major = H % 30 === 0, mid = H % 10 === 0;
      ctx.strokeStyle = '#aeb7c4'; ctx.lineWidth = major ? 2 : 1;
      ctx.beginPath(); ctx.moveTo(x, wy + wh - (major ? 26 : mid ? 20 : 13)); ctx.lineTo(x, wy + wh - 6); ctx.stroke();
      if (major) {
        const lbl = CARD[H / 30];
        ctx.fillStyle = 'NEWS'.includes(lbl) ? '#e8eef6' : '#9aa5b4';
        ctx.font = `600 ${'NEWS'.includes(lbl) ? 24 : 19}px system-ui`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(lbl, x, wy + 42);
      }
    }
    ctx.lineWidth = 1;
    ctx.restore();
    // lubber line
    ctx.strokeStyle = AMBER; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.moveTo(cx, wy + 2); ctx.lineTo(cx, wy + wh - 2); ctx.stroke(); ctx.lineWidth = 1;

    ctx.fillStyle = INK2; ctx.font = '11px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText('wet compass — front window', 250, 64);
    ctx.fillText('note the card reads backwards: 33 sits to the right of N', 250, 274);
  }

  function drawTopdown(indHdg) {
    const cx = 720, cy = 178, r = 122;
    ctx.strokeStyle = AX; ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7); ctx.stroke();
    for (let H = 0; H < 360; H += 30) {
      const a = (H - 90) * DEG;
      tickAt(ctx, cx, cy, H - 90, r - (H % 90 === 0 ? 10 : 6), r, INK2, H % 90 === 0 ? 2 : 1);
      if (H % 90 === 0) {
        ctx.fillStyle = INK; ctx.font = '600 12px system-ui';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(['N', 'E', 'S', 'W'][H / 90], cx + Math.cos(a) * (r + 14), cy + Math.sin(a) * (r + 14));
      }
    }
    // error wedge
    const err = angdiff(indHdg, psi);
    if (Math.abs(err) > 1.5) {
      ctx.strokeStyle = RED; ctx.lineWidth = 4; ctx.globalAlpha = 0.75;
      ctx.beginPath(); ctx.arc(cx, cy, r - 34, (psi - 90) * DEG, (indHdg - 90) * DEG, err < 0); ctx.stroke();
      ctx.globalAlpha = 1; ctx.lineWidth = 1;
    }
    // compass-says arrow
    const ai = (indHdg - 90) * DEG;
    ctx.strokeStyle = AMBER; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(ai) * (r - 26), cy + Math.sin(ai) * (r - 26)); ctx.stroke();
    ctx.save(); ctx.translate(cx + Math.cos(ai) * (r - 26), cy + Math.sin(ai) * (r - 26)); ctx.rotate(ai);
    ctx.fillStyle = AMBER; ctx.beginPath(); ctx.moveTo(8, 0); ctx.lineTo(-5, -6); ctx.lineTo(-5, 6); ctx.fill();
    ctx.restore(); ctx.lineWidth = 1;
    ctx.fillStyle = AMBER; ctx.font = '600 11px system-ui'; ctx.textAlign = 'center';
    ctx.fillText('card says', cx + Math.cos(ai) * (r + 32), cy + Math.sin(ai) * (r + 32) + 4);
    // airplane at true heading
    const ap = (psi - 90) * DEG;
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(ap);
    ctx.fillStyle = '#f2f5fa';
    ctx.beginPath(); ctx.moveTo(30, 0); ctx.lineTo(-20, -15); ctx.lineTo(-11, 0); ctx.lineTo(-20, 15); ctx.fill();
    ctx.strokeStyle = '#f2f5fa'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(3, -22); ctx.lineTo(3, 22); ctx.stroke();
    ctx.restore(); ctx.lineWidth = 1;
    ctx.fillStyle = '#e8eef6'; ctx.font = '600 11px system-ui'; ctx.textAlign = 'center';
    const al = (psi - 90) * DEG;
    ctx.fillText('actually pointing', cx + Math.cos(al) * (r + 32), cy + Math.sin(al) * (r + 32) - 8);
    ctx.fillText(h3(psi) + '°', cx + Math.cos(al) * (r + 32), cy + Math.sin(al) * (r + 32) + 6);
  }

  function draw() {
    ctx.clearRect(0, 0, w, h);
    drawCompass(ind);
    drawTopdown(ind);
    ctx.fillStyle = INK; ctx.font = '11px system-ui'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    const status = mode === 'turn'
      ? (Math.abs(bankNow) < 1 ? 'TAS 100 kt · wings level' : `TAS 100 kt · ${fmt(Math.abs(bankNow))}° bank ${bankNow < 0 ? 'left' : 'right'}`)
      : `${fmt(spd)} kt ${Math.abs(aNow) > 0.03 ? (aNow > 0 ? '· accelerating' : '· slowing') : '· steady'}`;
    ctx.fillText(status, 50, 26);
  }

  function verdict(lat, bank) {
    const vd = $('mc-verdict');
    const err = angdiff(ind, psi);
    const errTxt = `${fmt(Math.abs(err))}°`;
    if (mode === 'turn') {
      if (Math.abs(bankNow) < 2 && Math.abs(err) < 2) {
        vd.className = 'verdict on';
        vd.innerHTML = `<b>Wings level, speed steady.</b> The card settles on ${h3(psi)} — the only condition where the compass tells the truth, and the moment to set your heading indicator from it.`;
        return;
      }
      const nearN = Math.abs(angdiff(psi, 0)) <= 45, nearS = Math.abs(angdiff(psi, 180)) <= 45;
      if (nearN) {
        const lead = Math.round(lat + bank / 2);
        const target = dir >= 0 ? norm360(360 - lead) : lead;
        vd.className = 'verdict low';
        vd.innerHTML = `<b>Turning through north — the card lags ${errTxt} behind</b> (near due north it can even swing the wrong way). <b>UNOS:</b> to roll out on north, start when the card still reads about <b>${h3(target)}</b> — undershoot by ~latitude + ½ bank ≈ ${lead}°.`;
      } else if (nearS) {
        const lag = Math.max(0, Math.round(lat - bank / 2));
        const target = norm360(180 + (dir >= 0 ? lag : -lag));
        vd.className = 'verdict high';
        vd.innerHTML = `<b>Turning through south — the card leads by ${errTxt}</b>, racing ahead of the airplane. To roll out on south, let it swing past to about <b>${h3(target)}</b> — overshoot by ~latitude − ½ bank ≈ ${lag}°.`;
      } else {
        const ew = Math.abs(angdiff(psi, 90)) < 45 ? 'east' : 'west';
        const next = dir >= 0 ? (ew === 'east' ? 'south' : 'north') : (ew === 'east' ? 'north' : 'south');
        vd.className = 'verdict on';
        vd.innerHTML = `<b>Passing ${ew}.</b> Turning error crosses <b>zero</b> exactly on east/west — watch the error flip sign here (currently ${errTxt}), from ${next === 'south' ? 'lagging out of the north sector to leading into the south' : 'leading out of the south sector to lagging into the north'}. Rolling out on ${ew}? Just roll out on the number.`;
      }
    } else {
      const onEW = Math.min(Math.abs(angdiff(psi, 90)), Math.abs(angdiff(psi, 270))) < 45;
      if (Math.abs(aNow) > 0.03) {
        if (onEW) {
          vd.className = 'verdict high';
          vd.innerHTML = `<b>${aNow > 0 ? 'Accelerating' : 'Decelerating'} on ${Math.abs(angdiff(psi, 90)) < 45 ? 'east' : 'west'}: the card swings toward ${aNow > 0 ? 'north' : 'south'}</b> — reading ${h3(ind)} while the heading hasn't moved a degree. <b>ANDS</b>: Accelerate-North, Decelerate-South.`;
        } else {
          vd.className = 'verdict on';
          vd.innerHTML = `<b>${aNow > 0 ? 'Accelerating' : 'Decelerating'} on ${Math.abs(angdiff(psi, 0)) < 45 ? 'north' : 'south'}: almost no error.</b> Here the dip tilt is fore-aft, where it can't twist the card. ANDS only bites on easterly and westerly headings — try east or west.`;
        }
      } else {
        vd.className = 'verdict on';
        vd.innerHTML = `<b>Speed steady</b> — the card returns to ${h3(psi)}. Change speed and watch it swing with nothing turning.`;
      }
    }
  }

  function frame(t) {
    if (last === null) last = t;
    const dt = Math.min(0.1, (t - last) / 1000); last = t;
    const lat = +$('mc-lat').value, bank = +$('mc-bank').value;
    $('mc-lat-val').innerHTML = `${lat}<span class="u">°N</span>`;
    $('mc-bank-val').innerHTML = `${bank}<span class="u">°</span>`;

    if (mode === 'turn') {
      const bankT = dir * bank;
      const step = 30 * dt * TSCALE;
      bankNow += clamp(bankT - bankNow, -step, step);
      psi = norm360(psi + (G * Math.tan(bankNow * DEG) / V) / DEG * dt * TSCALE);
      aNow = 0;
    } else {
      bankNow = 0;
      if (psiT !== null) {
        const d2 = angdiff(psiT, psi);
        psi = Math.abs(d2) < 0.5 ? psiT : norm360(psi + clamp(d2, -90 * dt, 90 * dt));
      }
      const remain = spdT - spd;
      const aT = Math.abs(remain) > 0.5 ? Math.sign(remain) * 0.25 : 0;
      aNow += (aT - aNow) * Math.min(1, dt / 0.4);
      spd = clamp(spd + aNow * 19.06 * dt, 60, 130);
    }

    const model = indicatedOf(psi, bankNow, aNow, lat);
    if (ind === null) ind = model;
    ind = norm360(ind + angdiff(model, ind) * Math.min(1, dt / 0.35));

    const dip = dipOf(lat) / DEG;
    $('mc-t-dip').innerHTML = `${fmt(dip)}<span class="u">° down</span>`;
    $('mc-t-act').innerHTML = `${h3(psi)}<span class="u">°</span>`;
    $('mc-t-ind').innerHTML = `${h3(ind)}<span class="u">°</span>`;
    const err = angdiff(ind, psi);
    $('mc-t-err').innerHTML = `${err >= 0 ? '+' : '−'}${fmt(Math.abs(err))}<span class="u">°</span>`;

    draw();
    verdict(lat, bank);
    requestAnimationFrame(frame);
  }

  setMode('turn');
  requestAnimationFrame(frame);
})();

})();
