/* Eights on Pylons — interactive explainer
   Pivotal altitude PA(ft AGL) = GS(kt)² / 11.3  (≡ h = V²/g)
   No dependencies; three canvases:
     1. #pa-chart   PA vs GS curve
     2. #geom-canvas side-view geometry + competing rotation rates
     3. #sim-canvas + #alt-strip  full figure-eight simulation in wind
*/
(() => {
'use strict';

const $ = id => document.getElementById(id);
const DEG = Math.PI / 180;
const KT2FPS = 1.6878;
const G = 32.174;

const paOf = gsKt => gsKt * gsKt / 11.3;
const fmt = (n, d = 0) => n.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d });
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// single-hue sequential ramp (blue, dark→light) for magnitude coloring
function ramp(t) {
  t = clamp(t, 0, 1);
  const a = [38, 68, 110], b = [158, 201, 255];
  return `rgb(${a.map((c, i) => Math.round(c + (b[i] - c) * t)).join(',')})`;
}

// crisp canvas setup at devicePixelRatio, returns ctx with logical w/h
function setup(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.width, h = canvas.height; // logical, from HTML attrs
  canvas.width = w * dpr; canvas.height = h * dpr;
  canvas.style.aspectRatio = `${w} / ${h}`;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  return { ctx, w, h };
}

const AX = '#3a4150', GRID = '#20242c', INK = '#98a2b3', INK2 = '#5d6675', ACC = '#4a9eff';

/* ── 1 · PA vs GS chart ─────────────────────────────────────── */
(() => {
  const { ctx, w, h } = setup($('pa-chart'));
  const M = { l: 66, r: 18, t: 16, b: 34 };
  const GS0 = 50, GS1 = 160, PA1 = 2400;
  const X = gs => M.l + (gs - GS0) / (GS1 - GS0) * (w - M.l - M.r);
  const Y = pa => h - M.b - pa / PA1 * (h - M.t - M.b);
  let hoverGs = null;

  function draw() {
    const gs = +$('pa-gs').value;
    $('pa-gs-val').innerHTML = `${gs} <span class="u">kt</span>`;
    ctx.clearRect(0, 0, w, h);
    ctx.font = '11px system-ui'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (let pa = 0; pa <= PA1; pa += 400) {
      ctx.strokeStyle = GRID; ctx.beginPath(); ctx.moveTo(M.l, Y(pa)); ctx.lineTo(w - M.r, Y(pa)); ctx.stroke();
      ctx.fillStyle = INK2; ctx.fillText(fmt(pa), M.l - 8, Y(pa));
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (let g2 = GS0, i = 0; g2 <= GS1; g2 += 10, i++) {
      if (i % 2 === 0) ctx.fillText(g2, X(g2), h - M.b + 8);
    }
    ctx.fillStyle = INK2;
    ctx.fillText('groundspeed, kt', (M.l + w - M.r) / 2, h - 15);
    ctx.save(); ctx.translate(14, (M.t + h - M.b) / 2); ctx.rotate(-Math.PI / 2);
    ctx.fillText('pivotal altitude, ft AGL', 0, 0); ctx.restore();

    // curve
    ctx.strokeStyle = ACC; ctx.lineWidth = 2; ctx.beginPath();
    for (let g2 = GS0; g2 <= GS1; g2 += 1) {
      const x = X(g2), y = Y(paOf(g2));
      g2 === GS0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke(); ctx.lineWidth = 1;

    // marker + guides
    const pa = paOf(gs);
    ctx.strokeStyle = '#3a5a80'; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(X(gs), Y(0)); ctx.lineTo(X(gs), Y(pa)); ctx.lineTo(M.l, Y(pa)); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#14181e'; ctx.beginPath(); ctx.arc(X(gs), Y(pa), 6.5, 0, 7); ctx.fill();
    ctx.fillStyle = ACC; ctx.beginPath(); ctx.arc(X(gs), Y(pa), 4.5, 0, 7); ctx.fill();
    ctx.fillStyle = '#e8eef6'; ctx.font = '600 12px system-ui';
    ctx.textAlign = gs > 130 ? 'right' : 'left';
    ctx.fillText(`${gs} kt → ${fmt(pa)} ft`, X(gs) + (gs > 130 ? -12 : 12), Y(pa) - 12);

    // hover crosshair
    if (hoverGs !== null && Math.abs(hoverGs - gs) > 1) {
      const hp = paOf(hoverGs);
      ctx.strokeStyle = '#2e3644'; ctx.beginPath();
      ctx.moveTo(X(hoverGs), M.t); ctx.lineTo(X(hoverGs), h - M.b); ctx.stroke();
      ctx.fillStyle = INK; ctx.font = '11px system-ui'; ctx.textAlign = 'center';
      ctx.fillText(`${Math.round(hoverGs)} kt → ${fmt(hp)} ft`, clamp(X(hoverGs), 70, w - 80), M.t + 2);
      ctx.fillStyle = '#8ab8e8'; ctx.beginPath(); ctx.arc(X(hoverGs), Y(hp), 3.5, 0, 7); ctx.fill();
    }
  }
  const cv = $('pa-chart');
  cv.addEventListener('mousemove', e => {
    const r = cv.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width * w;
    const gs = GS0 + (px - M.l) / (w - M.l - M.r) * (GS1 - GS0);
    hoverGs = (gs >= GS0 && gs <= GS1) ? gs : null; draw();
  });
  cv.addEventListener('mouseleave', () => { hoverGs = null; draw(); });
  $('pa-gs').addEventListener('input', draw);
  draw();
})();

/* ── 2 · Geometry / competing rates ─────────────────────────── */
(() => {
  const { ctx, w, h } = setup($('geom-canvas'));
  function draw() {
    const vKt = +$('g-tas').value, alt = +$('g-alt').value, d = +$('g-dist').value;
    $('g-tas-val').innerHTML = `${vKt} <span class="u">kt</span>`;
    $('g-alt-val').innerHTML = `${fmt(alt)} <span class="u">ft AGL</span>`;
    $('g-dist-val').innerHTML = `${fmt(d)} <span class="u">ft</span>`;

    const vF = vKt * KT2FPS;
    const phi = Math.atan(alt / d);                 // bank that puts the wing on the pylon
    const turnRate = G * Math.tan(phi) / vF / DEG;  // deg/s
    const bearRate = vF / d / DEG;                  // deg/s
    const pa = paOf(vKt);

    $('g-bank').innerHTML = `${fmt(phi / DEG, 1)}<span class="u">°</span>`;
    $('g-turnrate').innerHTML = `${fmt(turnRate, 2)}<span class="u"> °/s</span>`;
    $('g-bearrate').innerHTML = `${fmt(bearRate, 2)}<span class="u"> °/s</span>`;
    $('g-pa').innerHTML = `${fmt(pa)}<span class="u"> ft</span>`;

    const err = alt - pa, vd = $('g-verdict');
    if (Math.abs(err) < 20) {
      vd.className = 'verdict on';
      vd.innerHTML = `<b>Pinned.</b> Heading and bearing rotate at the same rate — the pylon is frozen on the wingtip. You are at pivotal altitude.`;
    } else if (err > 0) {
      vd.className = 'verdict high';
      vd.innerHTML = `<b>${fmt(err)} ft too high.</b> Your heading out-turns the bearing (${fmt(turnRate, 2)} vs ${fmt(bearRate, 2)} °/s) — the pylon appears to drift <b>ahead</b> of the wingtip. Correction: <b>forward pressure, descend</b>.`;
    } else {
      vd.className = 'verdict low';
      vd.innerHTML = `<b>${fmt(-err)} ft too low.</b> The bearing out-turns your heading (${fmt(bearRate, 2)} vs ${fmt(turnRate, 2)} °/s) — the pylon appears to fall <b>behind</b> the wingtip. Correction: <b>back pressure, climb</b>.`;
    }

    // ---- side view (looking along the flight path; pylon off the low wing) ----
    ctx.clearRect(0, 0, w, h);
    const gy = h - 44;                       // ground line y
    const px2 = 120;                         // aircraft x
    const S = Math.min((w - px2 - 60) / 3300, (gy - 46) / 1900); // ft → px
    const ax = px2, ay = gy - alt * S;
    const pyx = px2 + d * S;

    // pivotal-altitude reference line
    const payy = gy - pa * S;
    ctx.strokeStyle = '#2f4d33'; ctx.setLineDash([5, 5]);
    ctx.beginPath(); ctx.moveTo(30, payy); ctx.lineTo(w - 30, payy); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = '#6fae7f'; ctx.font = '11px system-ui'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    ctx.fillText(`pivotal altitude ${fmt(pa)} ft`, 32, payy - 3);

    // ground
    ctx.strokeStyle = '#3d4450'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(20, gy); ctx.lineTo(w - 20, gy); ctx.stroke(); ctx.lineWidth = 1;
    ctx.strokeStyle = '#262b33';
    for (let x = 26; x < w - 20; x += 17) { ctx.beginPath(); ctx.moveTo(x, gy); ctx.lineTo(x - 8, gy + 8); ctx.stroke(); }

    // sight line through the low wing to the pylon
    ctx.strokeStyle = '#d8a04c'; ctx.setLineDash([6, 5]);
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(pyx, gy); ctx.stroke(); ctx.setLineDash([]);

    // pylon
    ctx.strokeStyle = '#c5cbd6'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(pyx, gy); ctx.lineTo(pyx, gy - 18); ctx.stroke(); ctx.lineWidth = 1;
    ctx.fillStyle = ACC; ctx.beginPath();
    ctx.moveTo(pyx, gy - 18); ctx.lineTo(pyx + 12, gy - 14); ctx.lineTo(pyx, gy - 10); ctx.fill();

    // aircraft, rear view, banked phi toward pylon
    ctx.save(); ctx.translate(ax, ay); ctx.rotate(phi);
    ctx.strokeStyle = '#e8eef6'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(-26, 0); ctx.lineTo(26, 0); ctx.stroke();
    ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(0, -2); ctx.lineTo(0, -12); ctx.stroke();
    ctx.restore();
    ctx.fillStyle = '#e8eef6'; ctx.beginPath(); ctx.arc(ax, ay, 4, 0, 7); ctx.fill();

    // dimensions
    ctx.strokeStyle = AX; ctx.fillStyle = INK; ctx.font = '11px system-ui';
    ctx.beginPath(); ctx.moveTo(ax - 52, ay); ctx.lineTo(ax - 52, gy); ctx.stroke();
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ctx.fillText(`h = ${fmt(alt)} ft`, ax - 58, (ay + gy) / 2);
    ctx.beginPath(); ctx.moveTo(ax, gy + 22); ctx.lineTo(pyx, gy + 22); ctx.stroke();
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText(`d = ${fmt(d)} ft`, (ax + pyx) / 2, gy + 26);
    // bank label
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#d8a04c';
    ctx.fillText(`φ = ${fmt(phi / DEG, 1)}°`, ax + 34, ay + 26 * Math.sin(phi) + 14);

    // rates meter (top-right): two horizontal bars, shared scale
    const mx = w - 300, my = 20, mw = 260, rmax = Math.max(turnRate, bearRate, 3) * 1.15;
    ctx.font = '11px system-ui'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    const bar = (label, val, y, color) => {
      ctx.fillStyle = INK2; ctx.fillText(label, mx, y + 6);
      ctx.fillStyle = '#20242c'; ctx.fillRect(mx + 92, y, mw - 92, 12);
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.roundRect(mx + 92, y, (mw - 92) * val / rmax, 12, 3); ctx.fill();
      ctx.fillStyle = '#c9d2df'; ctx.fillText(`${fmt(val, 2)}°/s`, mx + 96 + (mw - 92) * val / rmax, y + 6);
    };
    bar('heading rate', turnRate, my, '#d8a04c');
    bar('bearing rate', bearRate, my + 20, ACC);
  }
  ['g-tas', 'g-alt', 'g-dist'].forEach(id => $(id).addEventListener('input', draw));
  draw();
})();

/* ── 3 · Figure-eight simulation ────────────────────────────── */
(() => {
  const R = 1500, D = 6000;               // pylon-circle radius / pylon spacing, ft
  const sim = setup($('sim-canvas'));
  const strip = setup($('alt-strip'));

  // --- path: CW arc around left pylon, CCW arc around right, joined by
  //     crossing tangent lines through the midpoint (tangent-continuous). ---
  const path = (() => {
    const a = D / 2, t = Math.asin(2 * R / D), c = Math.cos(t), s = Math.sin(t);
    const P1 = [-a * c * c, -a * c * s], P2 = [-a * c * c, a * c * s];
    const Q1 = [a * c * c, a * c * s], Q2 = [a * c * c, -a * c * s];
    const pts = [], seg = [], STEP = 0.015;
    const angL1 = Math.atan2(P1[1], P1[0] + a), angL2 = Math.atan2(P2[1], P2[0] + a);
    let e = angL2; while (e >= angL1) e -= 2 * Math.PI;
    for (let g2 = angL1; g2 >= e; g2 -= STEP) { pts.push([-a + R * Math.cos(g2), R * Math.sin(g2)]); seg.push(0); }
    const L = Math.hypot(Q2[0] - P2[0], Q2[1] - P2[1]);
    for (let dd = R * STEP; dd < L; dd += R * STEP) { pts.push([P2[0] + (Q2[0] - P2[0]) * dd / L, P2[1] + (Q2[1] - P2[1]) * dd / L]); seg.push(2); }
    const angR2 = Math.atan2(Q2[1], Q2[0] - a);
    let f = Math.atan2(Q1[1], Q1[0] - a); while (f <= angR2) f += 2 * Math.PI;
    for (let g2 = angR2; g2 <= f; g2 += STEP) { pts.push([a + R * Math.cos(g2), R * Math.sin(g2)]); seg.push(1); }
    for (let dd = R * STEP; dd < L; dd += R * STEP) { pts.push([Q1[0] + (P1[0] - Q1[0]) * dd / L, Q1[1] + (P1[1] - Q1[1]) * dd / L]); seg.push(3); }
    // cumulative arc length + track angle
    const n = pts.length, cum = new Array(n), tau = new Array(n);
    cum[0] = 0;
    for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    const total = cum[n - 1] + Math.hypot(pts[0][0] - pts[n - 1][0], pts[0][1] - pts[n - 1][1]);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      tau[i] = Math.atan2(pts[j][1] - pts[i][1], pts[j][0] - pts[i][0]);
    }
    return { pts, seg, cum, tau, total, n };
  })();

  // --- per-point wind solution, recomputed when controls change ---
  const W = { gs: [], pa: [], bank: [], crab: [], paMin: 0, paMax: 0, ok: true };
  function recompute() {
    const tas = +$('s-tas').value, wspd = +$('s-wspd').value, wdir = +$('s-wdir').value;
    $('s-tas-val').innerHTML = `${tas} <span class="u">kt</span>`;
    $('s-wspd-val').innerHTML = `${wspd} <span class="u">kt</span>`;
    $('s-wdir-val').innerHTML = `${wdir.toString().padStart(3, '0')}<span class="u">°</span>`;
    // wind TO-vector in world coords (x east, y north); wdir is compass FROM
    const wx = -wspd * Math.sin(wdir * DEG), wy = -wspd * Math.cos(wdir * DEG);
    W.ok = wspd < tas;
    let mn = 1e9, mx = -1e9;
    for (let i = 0; i < path.n; i++) {
      const ux = Math.cos(path.tau[i]), uy = Math.sin(path.tau[i]);
      const along = wx * ux + wy * uy, cross = -wx * uy + wy * ux;
      const gs = W.ok ? along + Math.sqrt(Math.max(0, tas * tas - cross * cross)) : 0;
      W.gs[i] = gs;
      W.pa[i] = paOf(gs);
      W.crab[i] = W.ok ? Math.asin(clamp(cross / tas, -1, 1)) : 0; // + = wind from the right of nose? (push left)
      const vf = gs * KT2FPS;
      W.bank[i] = path.seg[i] < 2 ? Math.atan(vf * vf / (G * R)) : 0;
      if (path.seg[i] < 2) { mn = Math.min(mn, W.pa[i]); mx = Math.max(mx, W.pa[i]); }
    }
    // smooth bank (roll-in/out across straight-segment joins)
    const sm = new Array(path.n), K = 14;
    for (let i = 0; i < path.n; i++) {
      let acc = 0;
      for (let k = -K; k <= K; k++) acc += W.bank[(i + k + path.n) % path.n];
      sm[i] = acc / (2 * K + 1);
    }
    W.bank = sm;
    W.paMin = mn; W.paMax = mx;
    $('swing-note').textContent = `${fmt(Math.round(mn / 10) * 10)}–${fmt(Math.round(mx / 10) * 10)} ft AGL`;
    drawStrip();
  }

  // --- world → screen ---
  const PADX = 60, PADT = 26, PADB = 26;
  const SC = Math.min((sim.w - 2 * PADX) / (D + 2 * R + 1200), (sim.h - PADT - PADB) / (2 * R + 1400));
  const SX = x => sim.w / 2 + x * SC;
  const SY = y => sim.h / 2 - y * SC;

  // --- sim state ---
  let sPos = 0, mode = 'pivotal', paused = false, last = null;
  const SIMSPEED = 7;
  const trail = [];   // [x, y, pa]

  function idxAt(s) { // nearest path index for arc position s
    s = ((s % path.total) + path.total) % path.total;
    let lo = 0, hi = path.n - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; path.cum[m] < s ? lo = m + 1 : hi = m; }
    return lo;
  }

  function drawSim() {
    const { ctx, w, h } = sim;
    ctx.clearRect(0, 0, w, h);
    const i = idxAt(sPos);
    const [x, y] = path.pts[i];
    const gs = W.gs[i], pa = W.pa[i], bank = W.bank[i], seg = path.seg[i];
    const alt = mode === 'pivotal' ? pa : +$('s-hold').value;
    const wdir = +$('s-wdir').value, wspd = +$('s-wspd').value;

    // full path, faint
    ctx.strokeStyle = '#242a34'; ctx.lineWidth = 1.5; ctx.beginPath();
    path.pts.forEach(([px, py], k) => k ? ctx.lineTo(SX(px), SY(py)) : ctx.moveTo(SX(px), SY(py)));
    ctx.closePath(); ctx.stroke(); ctx.lineWidth = 1;

    // trail colored by required (pivotal) altitude — single-hue ramp
    const span = Math.max(1, W.paMax - W.paMin);
    for (let k = 1; k < trail.length; k++) {
      ctx.strokeStyle = ramp((trail[k][2] - W.paMin) / span);
      ctx.globalAlpha = k / trail.length * 0.9;
      ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.moveTo(SX(trail[k - 1][0]), SY(trail[k - 1][1]));
      ctx.lineTo(SX(trail[k][0]), SY(trail[k][1])); ctx.stroke();
    }
    ctx.globalAlpha = 1; ctx.lineWidth = 1;

    // pylons
    for (const px of [-D / 2, D / 2]) {
      ctx.strokeStyle = '#8892a2'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(SX(px), SY(0)); ctx.lineTo(SX(px), SY(0) - 14); ctx.stroke(); ctx.lineWidth = 1;
      ctx.fillStyle = ACC; ctx.beginPath();
      ctx.moveTo(SX(px), SY(0) - 14); ctx.lineTo(SX(px) + 10, SY(0) - 11); ctx.lineTo(SX(px), SY(0) - 8); ctx.fill();
      ctx.fillStyle = '#8892a2'; ctx.beginPath(); ctx.arc(SX(px), SY(0), 2.5, 0, 7); ctx.fill();
    }

    // sight line + wingtip ground-intersection dot (on arcs)
    if (seg < 2 && W.ok) {
      const pylX = seg === 0 ? -D / 2 : D / 2;
      const err = alt - pa;
      const col = Math.abs(err) < 25 ? '#4ade80' : err > 0 ? '#f0a97f' : '#8ec2f2';
      ctx.strokeStyle = col; ctx.setLineDash([5, 4]);
      ctx.beginPath(); ctx.moveTo(SX(x), SY(y)); ctx.lineTo(SX(pylX), SY(0)); ctx.stroke(); ctx.setLineDash([]);
      // where the wingtip reference line actually hits the ground: dist = alt / tan(bank)
      if (bank > 0.06) {
        const dHit = alt / Math.tan(bank);
        const dx = pylX - x, dy = -y, dd = Math.hypot(dx, dy) || 1;
        const hx = x + dx / dd * dHit, hy = y + dy / dd * dHit;
        ctx.fillStyle = col; ctx.beginPath(); ctx.arc(SX(hx), SY(hy), 4, 0, 7); ctx.fill();
        ctx.strokeStyle = col; ctx.globalAlpha = 0.5;
        ctx.beginPath(); ctx.arc(SX(hx), SY(hy), 7.5, 0, 7); ctx.stroke(); ctx.globalAlpha = 1;
      }
    }

    // aircraft (heading = track − crab correction)
    const hdgMath = path.tau[i] - W.crab[i];
    ctx.save(); ctx.translate(SX(x), SY(y)); ctx.rotate(-hdgMath);
    ctx.fillStyle = '#f2f5fa';
    ctx.beginPath(); ctx.moveTo(11, 0); ctx.lineTo(-7, -6); ctx.lineTo(-4, 0); ctx.lineTo(-7, 6); ctx.fill();
    ctx.strokeStyle = '#f2f5fa'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(1, -9); ctx.lineTo(1, 9); ctx.stroke();
    ctx.restore(); ctx.lineWidth = 1;

    // wind arrow (top-left), pointing in blow-TO direction
    if (wspd > 0) {
      const bx = 62, by = 40, len = 16 + wspd * 1.2;
      const tox = Math.sin((wdir + 180) * DEG), toy = -Math.cos((wdir + 180) * DEG);
      ctx.strokeStyle = '#7fb2e8'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(bx - tox * len / 2, by - toy * len / 2);
      ctx.lineTo(bx + tox * len / 2, by + toy * len / 2); ctx.stroke();
      ctx.save(); ctx.translate(bx + tox * len / 2, by + toy * len / 2); ctx.rotate(Math.atan2(toy, tox));
      ctx.fillStyle = '#7fb2e8'; ctx.beginPath(); ctx.moveTo(6, 0); ctx.lineTo(-4, -4.5); ctx.lineTo(-4, 4.5); ctx.fill();
      ctx.restore(); ctx.lineWidth = 1;
      ctx.fillStyle = INK; ctx.font = '11px system-ui'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(`wind ${wspd} kt from ${wdir.toString().padStart(3, '0')}°`, bx + 34, by);
    }
    // north tick
    ctx.fillStyle = INK2; ctx.font = '11px system-ui'; ctx.textAlign = 'center';
    ctx.fillText('N ↑', w - 34, 24);

    // readouts
    $('s-gs').innerHTML = `${fmt(gs)}<span class="u"> kt</span>`;
    $('s-pa').innerHTML = `${fmt(pa)}<span class="u"> ft</span>`;
    $('s-alt').innerHTML = `${fmt(alt)}<span class="u"> ft</span>`;
    $('s-bank').innerHTML = `${fmt(bank / DEG)}<span class="u">°</span>`;
    $('s-crab').innerHTML = `${fmt(Math.abs(W.crab[i] / DEG))}<span class="u">° ${W.crab[i] > 0.005 ? 'R' : W.crab[i] < -0.005 ? 'L' : ''}</span>`;

    const vd = $('s-verdict');
    if (!W.ok) {
      vd.className = 'verdict high';
      vd.innerHTML = '<b>Wind ≥ airspeed</b> — the ground track can\'t be flown. Reduce the wind or speed up.';
    } else if (mode === 'pivotal') {
      const j = (i + 4) % path.n;
      const rate = (W.pa[j] - W.pa[i]) / Math.max(1, path.cum[j] - path.cum[i] || 40) * gs * KT2FPS * 60;
      const word = rate > 40 ? `climbing ≈${fmt(Math.round(rate / 10) * 10)} fpm` : rate < -40 ? `descending ≈${fmt(-Math.round(rate / 10) * 10)} fpm` : 'level for the moment';
      vd.className = 'verdict on';
      vd.innerHTML = `<b>On the pylon.</b> Riding the pivotal altitude — ${word} as groundspeed ${rate > 40 ? 'increases' : rate < -40 ? 'decreases' : 'holds'} through the wind.`;
    } else {
      const err = alt - pa;
      if (Math.abs(err) < 25) { vd.className = 'verdict on'; vd.innerHTML = `<b>On the pylon</b> — for now. Held altitude happens to match pivotal altitude here.`; }
      else if (err > 0) { vd.className = 'verdict high'; vd.innerHTML = `<b>${fmt(err)} ft above pivotal altitude.</b> The pylon is drifting <b>ahead</b> of the wingtip (sight point overshoots the pylon). Forward pressure — descend.`; }
      else { vd.className = 'verdict low'; vd.innerHTML = `<b>${fmt(-err)} ft below pivotal altitude.</b> The pylon is falling <b>behind</b> the wingtip (sight point undershoots). Back pressure — climb.`; }
    }
  }

  /* strip chart: required altitude over one full lap */
  let stripHover = null;
  function drawStrip() {
    const { ctx, w, h } = strip;
    ctx.clearRect(0, 0, w, h);
    const M = { l: 60, r: 14, t: 20, b: 26 };
    const y0 = Math.max(0, Math.floor((W.paMin - 120) / 100) * 100);
    const y1 = Math.ceil((W.paMax + 120) / 100) * 100;
    const X = s => M.l + s / path.total * (w - M.l - M.r);
    const Y = v => h - M.b - (v - y0) / (y1 - y0) * (h - M.t - M.b);

    // segment bands + labels
    ctx.font = '10.5px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    const names = ['around left pylon', 'around right pylon', 'cross', 'cross'];
    let runStart = 0;
    for (let i = 1; i <= path.n; i++) {
      const cur = path.seg[i % path.n], prev = path.seg[i - 1];
      if (cur !== prev || i === path.n) {
        const sa = path.cum[runStart], sb = i === path.n ? path.total : path.cum[i];
        if (prev >= 2) { ctx.fillStyle = '#1a1f27'; ctx.fillRect(X(sa), M.t, X(sb) - X(sa), h - M.t - M.b); }
        ctx.fillStyle = INK2; ctx.fillText(names[prev], (X(sa) + X(sb)) / 2, h - M.b + 6);
        runStart = i;
      }
    }
    // grid
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.font = '11px system-ui';
    const step = (y1 - y0) > 500 ? 200 : 100;
    for (let v = y0; v <= y1; v += step) {
      ctx.strokeStyle = GRID; ctx.beginPath(); ctx.moveTo(M.l, Y(v)); ctx.lineTo(w - M.r, Y(v)); ctx.stroke();
      ctx.fillStyle = INK2; ctx.fillText(fmt(v), M.l - 7, Y(v));
    }

    // held-altitude line + hint (hold mode)
    if (mode === 'hold') {
      const ha = +$('s-hold').value;
      if (ha > y0 && ha < y1) {
        ctx.strokeStyle = '#b0885a'; ctx.setLineDash([6, 5]);
        ctx.beginPath(); ctx.moveTo(M.l, Y(ha)); ctx.lineTo(w - M.r, Y(ha)); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = '#d8a04c'; ctx.textAlign = 'left';
        ctx.fillText(`held ${fmt(ha)} ft`, M.l + 6, Y(ha) - 9);
      }
    }

    // required-altitude curve
    ctx.strokeStyle = ACC; ctx.lineWidth = 2; ctx.beginPath();
    for (let i = 0; i < path.n; i++) {
      const x = X(path.cum[i]), y = Y(W.pa[i]);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.stroke(); ctx.lineWidth = 1;

    // annotate extreme points (arcs only)
    if (+$('s-wspd').value > 0 && W.ok) {
      let iMax = 0, iMin = 0;
      for (let i = 0; i < path.n; i++) {
        if (path.seg[i] >= 2) continue;
        if (W.pa[i] > W.pa[iMax] || path.seg[iMax] >= 2) iMax = i;
        if (W.pa[i] < W.pa[iMin] || path.seg[iMin] >= 2) iMin = i;
      }
      ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.font = '10.5px system-ui';
      ctx.fillStyle = '#9ec9ff';
      ctx.fillText(`downwind — highest (${fmt(W.gs[iMax])} kt GS)`, clamp(X(path.cum[iMax]), 120, w - 130), Y(W.pa[iMax]) - 6);
      ctx.fillStyle = '#6d7d94'; ctx.textBaseline = 'top';
      ctx.fillText(`upwind — lowest (${fmt(W.gs[iMin])} kt GS)`, clamp(X(path.cum[iMin]), 110, w - 120), Y(W.pa[iMin]) + 7);
    }

    // moving cursor
    const i = idxAt(sPos);
    ctx.strokeStyle = '#55627a'; ctx.beginPath();
    ctx.moveTo(X(path.cum[i]), M.t); ctx.lineTo(X(path.cum[i]), h - M.b); ctx.stroke();
    ctx.fillStyle = '#14181e'; ctx.beginPath(); ctx.arc(X(path.cum[i]), Y(W.pa[i]), 6, 0, 7); ctx.fill();
    ctx.fillStyle = '#e8eef6'; ctx.beginPath(); ctx.arc(X(path.cum[i]), Y(W.pa[i]), 4, 0, 7); ctx.fill();

    // hover tooltip
    if (stripHover !== null) {
      const s = clamp((stripHover - M.l) / (w - M.l - M.r), 0, 1) * path.total;
      const j = idxAt(s);
      ctx.fillStyle = INK; ctx.font = '11px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.fillText(`${fmt(W.gs[j])} kt GS → ${fmt(W.pa[j])} ft`, clamp(X(path.cum[j]), 90, w - 90), M.t - 4 + 14);
      ctx.strokeStyle = '#2e3644'; ctx.beginPath(); ctx.moveTo(X(path.cum[j]), M.t); ctx.lineTo(X(path.cum[j]), h - M.b); ctx.stroke();
    }
    // y-axis title
    ctx.save(); ctx.translate(12, (M.t + h - M.b) / 2); ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = INK2; ctx.font = '11px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('ft AGL', 0, 0); ctx.restore();
  }
  const stripCv = $('alt-strip');
  stripCv.addEventListener('mousemove', e => {
    const r = stripCv.getBoundingClientRect();
    stripHover = (e.clientX - r.left) / r.width * strip.w;
  });
  stripCv.addEventListener('mouseleave', () => { stripHover = null; });

  // --- animation ---
  function frame(t) {
    if (last === null) last = t;
    const dt = Math.min(0.1, (t - last) / 1000); last = t;
    if (!paused && W.ok) {
      const i = idxAt(sPos);
      sPos = (sPos + W.gs[i] * KT2FPS * dt * SIMSPEED) % path.total;
      const [x, y] = path.pts[idxAt(sPos)];
      trail.push([x, y, W.pa[idxAt(sPos)]]);
      if (trail.length > 420) trail.shift();
    }
    drawSim(); drawStrip();
    requestAnimationFrame(frame);
  }

  // --- controls ---
  ['s-tas', 's-wspd', 's-wdir'].forEach(id => $(id).addEventListener('input', recompute));
  $('s-hold').addEventListener('input', () => {
    $('s-hold-val').innerHTML = `${fmt(+$('s-hold').value)} <span class="u">ft AGL</span>`;
  });
  $('m-pivotal').addEventListener('click', () => {
    mode = 'pivotal';
    $('m-pivotal').classList.add('active'); $('m-hold').classList.remove('active');
    $('hold-row').style.display = 'none';
  });
  $('m-hold').addEventListener('click', () => {
    mode = 'hold';
    $('m-hold').classList.add('active'); $('m-pivotal').classList.remove('active');
    $('hold-row').style.display = '';
  });
  $('m-pause').addEventListener('click', () => {
    paused = !paused;
    $('m-pause').textContent = paused ? '▶ Resume' : '⏸ Pause';
  });

  $('s-hold-val').innerHTML = `${fmt(+$('s-hold').value)} <span class="u">ft AGL</span>`;
  recompute();
  requestAnimationFrame(frame);
})();

})();
