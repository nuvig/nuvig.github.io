// tunnel.js — Wind Tunnel page: drives js/tunnel-model.js (in a Web Worker when it can,
// in-thread otherwise), paints the field, advects the smoke rakes, and draws the force,
// Cp and lift-curve panels. No fetches, no site-config. `window.TUNNEL_DEBUG` for headless checks.
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const fmt = (v, d = 0) => (+v).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d });
  const D2R = Math.PI / 180;
  const MONO = '11px "Cascadia Code", Consolas, ui-monospace, monospace';
  const small = window.innerWidth < 700 || window.innerHeight < 500;
  const NX = small ? 300 : 400, NY = small ? 165 : 220, CHORD = small ? 68 : 90, U0 = 0.1;
  const PIVOT = Tunnel.pivotFor(NX, NY);
  const RE_MIN = 100, RE_MAX = 3000;
  const PRESETS = {
    '2412': { kind: 'naca', m: 2, p: 40, t: 12, flap: 0, alpha: 4 },
    '0012': { kind: 'naca', m: 0, p: 40, t: 12, flap: 0, alpha: 4 },
    '4412': { kind: 'naca', m: 4, p: 40, t: 12, flap: 0, alpha: 4 },
    '6409': { kind: 'naca', m: 6, p: 40, t: 9, flap: 0, alpha: 4 },
    'flap': { kind: 'naca', m: 2, p: 40, t: 12, flap: 30, alpha: 4 },
    'plate': { kind: 'plate', m: 0, p: 40, t: 3, flap: 0, alpha: 6 },
    'cyl': { kind: 'cylinder', m: 0, p: 40, t: 12, flap: 0, alpha: 0 },
  };
  const SWEEP = [-6, -3, 0, 3, 6, 9, 12, 15, 18, 22], HOLD = 2400;   // steps per α; a point is the mean of the last 1,200

  const state = {
    shape: Object.assign({ dia: 0.3 }, PRESETS['2412']), re: 1000, running: true, view: 'p', smoke: true,
    field: null, fresh: false, lastT: 0, points: [], sweep: null, probe: null,
    rate: 0, rateT: 0, rateAt: performance.now(), sepEma: null,
    solid: new Uint8Array(NX * NY), poly: [], aL0: 0,
  };

  // ---------------------------------------------------------------- geometry (main thread copy)
  function placeGeometry() {
    state.poly = Tunnel.placeOutline(state.shape, CHORD, PIVOT);
    Tunnel.rasterize(state.poly, NX, NY, state.solid);
    state.aL0 = Tunnel.alphaL0(state.shape);
  }

  // ---------------------------------------------------------------- engine
  let worker = null, local = null, localSteps = 4, localMs = 3, localDirty = true;
  const opts = () => ({ nx: NX, ny: NY, chord: CHORD, u0: U0, shape: state.shape, re: state.re });
  function newBufs() { const n = NX * NY; return { ux: new Float32Array(n), uy: new Float32Array(n), rho: new Float32Array(n) }; }
  function sendBufs(b) { worker.postMessage({ cmd: 'bufs', ux: b.ux, uy: b.uy, rho: b.rho }, [b.ux.buffer, b.uy.buffer, b.rho.buffer]); }
  function startEngine() {
    try {
      worker = new Worker('js/tunnel-worker.js?v=1');
      worker.onmessage = onField;
      worker.onerror = () => { if (worker) { worker.terminate(); worker = null; } if (!local) startLocal(); };
      worker.postMessage({ cmd: 'init', opts: opts(), run: state.running });
      sendBufs(newBufs()); sendBufs(newBufs());
      $('engine').textContent = 'worker';
    } catch (e) { worker = null; startLocal(); }
  }
  function startLocal() {
    local = new Tunnel(opts()); state.field = null; localDirty = true;
    $('engine').textContent = 'in-thread';
  }
  function localField() {
    const T = local, L = T.hist.length, n = Math.min(T.histN, L), spark = new Float32Array(300);
    for (let k = 0; k < 300; k++) { const back = (300 - k) * 10; spark[k] = back <= n ? T.hist[(T.histN - back + L) % L] : NaN; }
    return { t: T.t, cl: T.cl, cd: T.cd, mean: T.mean(600), mean2: T.mean(1200), sep: T.separation(), cp: T.cpCurve(), spark, ux: T.ux, uy: T.uy, rho: T.rho, msPerStep: localMs, stepsPer: localSteps };
  }
  function stepLocal() {
    if (state.running) {
      const t0 = performance.now(); local.step(localSteps); const dt = performance.now() - t0;
      localMs = 0.9 * localMs + 0.1 * dt / localSteps; localSteps = clamp(Math.round(9 / Math.max(0.2, localMs)), 1, 12);
      if (local.unstable) { local.reset(); resetSmoke(); note('flow reset — unstable'); }
      localDirty = true;
    }
    if (localDirty) { state.field = localField(); state.fresh = true; localDirty = false; }
  }
  function onField(e) {
    const m = e.data;
    if (m.reset) { resetSmoke(); note('flow reset — unstable'); return; }
    const old = state.field;
    state.field = m; state.fresh = true;
    if (old && old.ux && old.ux.byteLength) sendBufs(old);
  }
  function cmdShape() { if (worker) worker.postMessage({ cmd: 'shape', shape: state.shape }); else if (local) { local.setShape(state.shape); localDirty = true; } }
  function cmdRe() { if (worker) worker.postMessage({ cmd: 're', re: state.re }); else if (local) local.setReynolds(state.re); }
  function cmdReset() { if (worker) worker.postMessage({ cmd: 'reset' }); else if (local) { local.reset(); localDirty = true; } resetSmoke(); if (state.sweep) { state.sweep = null; $('sweep').textContent = 'sweep α'; } }
  function cmdRun(on) { if (worker) worker.postMessage({ cmd: 'run', on }); }

  // ---------------------------------------------------------------- canvas + mapping
  const cv = $('tun'), ctx = cv.getContext('2d');
  let W = 0, H = 0, DPR = 1, scale = 1, offX = 0, offY = 0;
  function resize() {
    DPR = Math.min(2, window.devicePixelRatio || 1);
    W = window.innerWidth; H = window.innerHeight;
    cv.width = W * DPR; cv.height = H * DPR; ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    scale = Math.min(W / NX, H / NY);
    offX = (W - NX * scale) / 2; offY = (H - NY * scale) / 2;
    if (W <= 700) {   // phone: the strip sits between the wing panel and the force panel
      const sb = $('shape').getBoundingClientRect().bottom + 8, fb = $('force').getBoundingClientRect().top - 8, room = fb - sb;
      if (room > 80) { scale = Math.min(scale, room / NY); offX = (W - NX * scale) / 2; offY = sb + (room - NY * scale) / 2; }
    }
  }
  function placePanels() { const top = $('bar').offsetHeight + 18; $('shape').style.top = top + 'px'; $('force').style.top = window.innerWidth <= 700 ? '' : top + 'px'; $('help').style.top = top + 'px'; }
  window.addEventListener('resize', () => { placePanels(); resize(); });
  const sx = x => offX + (x + 0.5) * scale, sy = y => offY + (NY - 0.5 - y) * scale;
  const lx = X => (X - offX) / scale - 0.5, ly = Y => NY - 0.5 - (Y - offY) / scale;

  // ---------------------------------------------------------------- field image
  const fcv = document.createElement('canvas'); fcv.width = NX; fcv.height = NY;
  const fctx = fcv.getContext('2d'); const img = fctx.createImageData(NX, NY); const px = img.data;
  const BR = 6, BG = 9, BB = 15;
  // speed ramp LUT: 0 … 1.6 U∞
  const LUT = new Uint8ClampedArray(256 * 3);
  {
    const stops = [[0, 6, 9, 15], [0.45, 22, 30, 92], [0.8, 18, 92, 132], [1.0, 40, 138, 142], [1.3, 232, 210, 108], [1.6, 255, 255, 255]];
    for (let k = 0; k < 256; k++) {
      const s = k / 255 * 1.6; let a = stops[0], b = stops[stops.length - 1];
      for (let j = 0; j + 1 < stops.length; j++) if (s >= stops[j][0] && s <= stops[j + 1][0]) { a = stops[j]; b = stops[j + 1]; break; }
      const f = (s - a[0]) / (b[0] - a[0] || 1);
      LUT[k * 3] = a[1] + (b[1] - a[1]) * f; LUT[k * 3 + 1] = a[2] + (b[2] - a[2]) * f; LUT[k * 3 + 2] = a[3] + (b[3] - a[3]) * f;
    }
  }
  const SC = new Float32Array(NX * NY);   // scalar for the p / w views, box-smoothed at paint time
  function paintField(f) {
    const { ux, uy, rho } = f, view = state.view, solid = state.solid, N = NX * NY;
    if (view === 'p') { const cpk = 1 / (1.5 * U0 * U0); for (let i = 0; i < N; i++) SC[i] = solid[i] ? 0 : (rho[i] - 1) * cpk; }
    else if (view === 'w') {
      const wk = 1 / 0.02; SC.fill(0);
      for (let y = 1; y < NY - 1; y++) for (let x = 1; x < NX - 1; x++) { const i = y * NX + x; if (!solid[i]) SC[i] = (0.5 * (uy[i + 1] - uy[i - 1]) - 0.5 * (ux[i + NX] - ux[i - NX])) * wk; }
    }
    for (let y = 0; y < NY; y++) {
      const row = (NY - 1 - y) * NX * 4, base = y * NX, inner = y > 0 && y < NY - 1;
      for (let x = 0; x < NX; x++) {
        const i = base + x, o = row + x * 4;
        let r = BR, g = BG, b = BB;
        if (!solid[i] && view !== 'n') {
          if (view === 'u') {
            const s = Math.sqrt(ux[i] * ux[i] + uy[i] * uy[i]) / U0, k = Math.min(255, (s / 1.6 * 255) | 0) * 3;
            r = LUT[k]; g = LUT[k + 1]; b = LUT[k + 2];
          } else {
            let c = SC[i];
            if (inner && x > 0 && x < NX - 1) c = (SC[i - NX - 1] + SC[i - NX] + SC[i - NX + 1] + SC[i - 1] + c + SC[i + 1] + SC[i + NX - 1] + SC[i + NX] + SC[i + NX + 1]) / 9;
            const m = Math.min(1, Math.abs(c)), a = view === 'p' ? 0.92 * m * Math.sqrt(m) : m;
            if (view === 'p') { if (c < 0) { r += (56 - r) * a; g += (124 - g) * a; b += (255 - b) * a; } else { r += (255 - r) * a; g += (112 - g) * a; b += (72 - b) * a; } }
            else if (c > 0) { r += (255 - r) * a; g += (96 - g) * a; b += (64 - b) * a; } else { r += (64 - r) * a; g += (150 - g) * a; b += (255 - b) * a; }
          }
        }
        px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = 255;
      }
    }
    fctx.putImageData(img, 0, 0);
  }

  // ---------------------------------------------------------------- smoke rakes
  const RAKES = 15, MAXP = 360, EMIT = 12, X0 = 6;
  const rakes = [];
  for (let k = 0; k < RAKES; k++) rakes.push({ y0: 10 + (NY - 20) * k / (RAKES - 1), x: new Float32Array(MAXP), y: new Float32Array(MAXP), on: new Uint8Array(MAXP), head: 0, n: 0, acc: 0 });
  function resetSmoke() { for (const r of rakes) { r.head = 0; r.n = 0; r.acc = 0; } state.lastT = 0; }
  function push(r, x, y) {
    let j;
    if (r.n === MAXP) { j = r.head; r.head = (r.head + 1) % MAXP; } else { j = (r.head + r.n) % MAXP; r.n++; }
    r.x[j] = x; r.y[j] = y; r.on[j] = 1;
  }
  let VX = 0, VY = 0;
  function velAt(f, x, y) {
    if (!(x >= 0 && y >= 0 && x < NX - 1 && y < NY - 1)) return false;
    const x0 = x | 0, y0 = y | 0, tx = x - x0, ty = y - y0, i = y0 * NX + x0;
    const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty;
    VX = f.ux[i] * w00 + f.ux[i + 1] * w10 + f.ux[i + NX] * w01 + f.ux[i + NX + 1] * w11;
    VY = f.uy[i] * w00 + f.uy[i + 1] * w10 + f.uy[i + NX] * w01 + f.uy[i + NX + 1] * w11;
    return true;
  }
  function advectSmoke(f, dt) {
    const sub = Math.ceil(dt / 4), h = dt / sub, solid = state.solid;
    for (const r of rakes) {
      r.acc += dt;
      while (r.acc >= EMIT) { r.acc -= EMIT; push(r, X0 + r.acc * U0, r.y0); }
      for (let k = 0; k < r.n; k++) {
        const j = (r.head + k) % MAXP; if (!r.on[j]) continue;
        let x = r.x[j], y = r.y[j], alive = true;
        for (let s = 0; s < sub; s++) {
          if (!velAt(f, x, y)) { alive = false; break; }
          x += VX * h; y += VY * h;
          if (x >= NX - 2 || x < 0 || y < 0.5 || y > NY - 1.5 || solid[Math.round(y) * NX + Math.round(x)]) { alive = false; break; }
        }
        r.x[j] = x; r.y[j] = y; if (!alive) r.on[j] = 0;
      }
    }
  }
  // Streaklines. A segment is drawn fainter the more the flow has stretched it, and not at
  // all past 9 cells — a vortex core pulls neighbours apart and a chord across it is not smoke.
  const SMOKE_A = [0.78, 0.42, 0.18];
  function drawSmoke() {
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    const paths = [new Path2D(), new Path2D(), new Path2D()];
    for (const r of rakes) {
      let px0 = 0, py0 = 0, pen = false;
      for (let k = 0; k < r.n; k++) {
        const j = (r.head + k) % MAXP;
        if (!r.on[j]) { pen = false; continue; }
        const x = r.x[j], y = r.y[j];
        if (pen) {
          const d = Math.hypot(x - px0, y - py0);
          if (d < 9) { const P = paths[d < 2.5 ? 0 : d < 5 ? 1 : 2]; P.moveTo(sx(px0), sy(py0)); P.lineTo(sx(x), sy(y)); }
        }
        px0 = x; py0 = y; pen = true;
      }
    }
    for (let c = 0; c < 3; c++) {
      ctx.lineWidth = 3.2; ctx.strokeStyle = `rgba(200,225,255,${(0.13 * SMOKE_A[c]).toFixed(3)})`; ctx.stroke(paths[c]);
      ctx.lineWidth = 1.15; ctx.strokeStyle = `rgba(235,242,255,${SMOKE_A[c]})`; ctx.stroke(paths[c]);
    }
  }

  // ---------------------------------------------------------------- scene
  function drawBody() {
    const p = state.poly; if (!p.length) return;
    ctx.beginPath();
    for (let k = 0; k < p.length; k++) { const X = sx(p[k].x), Y = sy(p[k].y); if (k) ctx.lineTo(X, Y); else ctx.moveTo(X, Y); }
    ctx.closePath();
    ctx.fillStyle = '#0b0e15'; ctx.fill();
    ctx.lineWidth = 1.2; ctx.strokeStyle = 'rgba(255,255,255,.6)'; ctx.stroke();
    // freestream reference through the pivot + α label
    if (state.shape.kind !== 'cylinder') {
      const X0 = sx(PIVOT[0]), Y0 = sy(PIVOT[1]);
      ctx.setLineDash([3, 5]); ctx.strokeStyle = 'rgba(255,255,255,.22)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(X0 - 0.35 * CHORD * scale, Y0); ctx.lineTo(X0 + 0.95 * CHORD * scale, Y0); ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = MONO; ctx.fillStyle = 'rgba(255,255,255,.55)'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
      ctx.fillText(`α ${state.shape.alpha.toFixed(1)}°`, X0 - 0.35 * CHORD * scale, Y0 - 5);
    }
  }
  function drawProbe(f) {
    const p = state.probe; if (!p) return;
    const X = sx(p.x), Y = sy(p.y);
    ctx.strokeStyle = 'rgba(255,255,255,.5)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(X - 8, Y); ctx.lineTo(X + 8, Y); ctx.moveTo(X, Y - 8); ctx.lineTo(X, Y + 8); ctx.stroke();
    if (velAt(f, p.x, p.y)) {
      const s = Math.hypot(VX, VY) / U0, i = Math.round(p.y) * NX + Math.round(p.x);
      const cp = (f.rho[i] - 1) / (1.5 * U0 * U0);
      const inSolid = state.solid[i];
      const el = $('probe');
      el.textContent = inSolid ? 'inside the wing' : `${s.toFixed(2)} U∞ · Cp ${cp >= 0 ? '+' : ''}${cp.toFixed(2)}`;
      el.style.display = 'block'; el.style.left = (p.cx + 14) + 'px'; el.style.top = (p.cy + 14) + 'px';
      // local velocity arrow
      if (!inSolid) { ctx.strokeStyle = 'rgba(240,181,96,.9)'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(X, Y); ctx.lineTo(X + VX / U0 * 22, Y - VY / U0 * 22); ctx.stroke(); }
    }
  }
  function draw(f) {
    ctx.fillStyle = '#05070c'; ctx.fillRect(0, 0, W, H);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(fcv, offX, offY, NX * scale, NY * scale);
    if (state.smoke) drawSmoke();
    drawBody();
    drawProbe(f);
    // chord bar
    const bx = offX + 14, by = offY + NY * scale - 14;
    ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx + CHORD * scale, by); ctx.moveTo(bx, by - 3); ctx.lineTo(bx, by + 3); ctx.moveTo(bx + CHORD * scale, by - 3); ctx.lineTo(bx + CHORD * scale, by + 3); ctx.stroke();
    ctx.font = MONO; ctx.fillStyle = 'rgba(255,255,255,.4)'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    ctx.fillText('1 chord', bx + 4, by - 3);
  }

  // ---------------------------------------------------------------- readouts
  const thinCl = () => state.shape.kind === 'cylinder' ? null : 2 * Math.PI * (state.shape.alpha * D2R - state.aL0);
  function updateReadouts(f) {
    const m = f.mean, ok = m.n >= 100;
    $('cl').textContent = ok ? m.cl.toFixed(2) : '—';
    $('cd').textContent = ok ? m.cd.toFixed(3) : '—';
    $('ld').textContent = ok && Math.abs(m.cd) > 0.005 ? (m.cl / m.cd).toFixed(1) : '—';
    const cyl = state.shape.kind === 'cylinder';
    if (f.sep === null) state.sepEma = state.sepEma === null ? null : (state.sepEma > 0.97 ? null : state.sepEma + (1 - state.sepEma) * 0.15);
    else state.sepEma = state.sepEma === null ? f.sep : state.sepEma + (f.sep - state.sepEma) * 0.15;
    const sep = state.sepEma;
    $('sep').textContent = cyl ? '—' : sep === null ? 'attached' : `x/c ${sep.toFixed(2)}`;
    const st = $('state');
    if (cyl) { st.textContent = 'bluff body'; st.className = ''; }
    else if (sep === null || sep >= 0.85) { st.textContent = 'attached'; st.className = ''; }
    else if (sep >= 0.35) { st.textContent = 'separating'; st.className = 'sep'; }
    else { st.textContent = 'stalled'; st.className = 'stall'; }
    const th = thinCl(); $('thin').textContent = th === null ? '—' : th.toFixed(2);
    $('re').textContent = fmt(state.re);
    $('rate').textContent = state.rate ? `${fmt(state.rate)} steps/s · ${f.stepsPer}/frame` : '—';
  }
  const spc = $('spark'), spg = spc.getContext('2d');
  function drawSpark(f) {
    const w = spc.width / 2, h = spc.height / 2; spg.setTransform(2, 0, 0, 2, 0, 0); spg.clearRect(0, 0, w, h);
    const s = f.spark; let lo = Infinity, hi = -Infinity, any = false;
    for (let k = 0; k < s.length; k++) { const v = s[k]; if (v === v) { any = true; if (v < lo) lo = v; if (v > hi) hi = v; } }
    if (!any) return;
    if (hi - lo < 0.05) { const c = (hi + lo) / 2; lo = c - 0.025; hi = c + 0.025; }
    const pad = (hi - lo) * 0.1; lo -= pad; hi += pad;
    const Y = v => h - 2 - (v - lo) / (hi - lo) * (h - 4);
    spg.strokeStyle = 'rgba(255,255,255,.25)'; spg.setLineDash([3, 3]); spg.lineWidth = 1;
    spg.beginPath(); spg.moveTo(0, Y(f.mean.cl)); spg.lineTo(w, Y(f.mean.cl)); spg.stroke(); spg.setLineDash([]);
    if (lo < 0 && hi > 0) { spg.strokeStyle = 'rgba(255,255,255,.12)'; spg.beginPath(); spg.moveTo(0, Y(0)); spg.lineTo(w, Y(0)); spg.stroke(); }
    spg.strokeStyle = '#f0b560'; spg.lineWidth = 1.2; spg.beginPath(); let pen = false;
    for (let k = 0; k < s.length; k++) { const v = s[k]; if (v !== v) { pen = false; continue; } const X = k / (s.length - 1) * w; if (pen) spg.lineTo(X, Y(v)); else spg.moveTo(X, Y(v)); pen = true; }
    spg.stroke();
    spg.font = '10px "Cascadia Code", Consolas, monospace'; spg.fillStyle = 'rgba(255,255,255,.45)'; spg.textAlign = 'left'; spg.textBaseline = 'top';
    spg.fillText(hi.toFixed(2), 2, 1); spg.textBaseline = 'bottom'; spg.fillText(lo.toFixed(2), 2, h - 1);
  }

  // ---------------------------------------------------------------- Cp plot
  const cpc = $('cpc'), cpg = cpc.getContext('2d');
  function drawCp(f) {
    const w = cpc.width / 2, h = cpc.height / 2; cpg.setTransform(2, 0, 0, 2, 0, 0); cpg.clearRect(0, 0, w, h);
    const padL = 34, padR = 12, padT = 10, padB = 22;
    let cmin = -2; for (const q of f.cp.up) if (q.cp < cmin) cmin = q.cp; for (const q of f.cp.lo) if (q.cp < cmin) cmin = q.cp;
    cmin = Math.floor(cmin); const cmax = 1.2;
    const X = s => padL + s * (w - padL - padR), Y = c => padT + (c - cmin) / (cmax - cmin) * (h - padT - padB);
    cpg.font = '10px "Cascadia Code", Consolas, monospace'; cpg.textBaseline = 'middle'; cpg.textAlign = 'right';
    for (let c = cmin; c <= 1; c++) {
      cpg.strokeStyle = c === 0 ? 'rgba(255,255,255,.3)' : 'rgba(255,255,255,.08)'; cpg.lineWidth = 1;
      cpg.beginPath(); cpg.moveTo(padL, Y(c)); cpg.lineTo(w - padR, Y(c)); cpg.stroke();
      cpg.fillStyle = 'rgba(255,255,255,.45)'; cpg.fillText(c === 0 ? '0' : (c > 0 ? '+' : '−') + Math.abs(c), padL - 5, Y(c));
    }
    cpg.textAlign = 'center'; cpg.textBaseline = 'top';
    for (const s of [0, 0.25, 0.5, 0.75, 1]) { cpg.strokeStyle = 'rgba(255,255,255,.08)'; cpg.beginPath(); cpg.moveTo(X(s), padT); cpg.lineTo(X(s), h - padB); cpg.stroke(); cpg.fillStyle = 'rgba(255,255,255,.45)'; cpg.fillText(s === 0 ? 'LE' : s === 1 ? 'TE' : s.toFixed(2).replace(/^0/, ''), X(s), h - padB + 4); }
    cpg.textAlign = 'left'; cpg.fillStyle = 'rgba(255,255,255,.35)'; cpg.fillText('Cp', 3, 2); cpg.textAlign = 'right'; cpg.fillText('x/c', w - 2, h - padB + 4);
    const up = f.cp.up, lo = f.cp.lo;
    if (!up.length || !lo.length) return;
    // lift area
    cpg.beginPath();
    up.forEach((q, k) => k ? cpg.lineTo(X(q.s), Y(q.cp)) : cpg.moveTo(X(q.s), Y(q.cp)));
    for (let k = lo.length - 1; k >= 0; k--) cpg.lineTo(X(lo[k].s), Y(lo[k].cp));
    cpg.closePath(); cpg.fillStyle = 'rgba(240,181,96,.13)'; cpg.fill();
    const line = (arr, col) => { cpg.strokeStyle = col; cpg.lineWidth = 1.8; cpg.beginPath(); arr.forEach((q, k) => k ? cpg.lineTo(X(q.s), Y(q.cp)) : cpg.moveTo(X(q.s), Y(q.cp))); cpg.stroke(); };
    line(lo, '#6fa8ff'); line(up, '#f0b560');
    const mid = a => a[Math.floor(a.length * 0.45)];
    cpg.textBaseline = 'bottom'; cpg.textAlign = 'center';
    cpg.fillStyle = '#f0b560'; cpg.fillText('upper', X(mid(up).s), Y(mid(up).cp) - 5);
    cpg.textBaseline = 'top'; cpg.fillStyle = '#6fa8ff'; cpg.fillText('lower', X(mid(lo).s), Y(mid(lo).cp) + 5);
  }

  // ---------------------------------------------------------------- lift curve
  const cvc = $('curvec'), cvg = cvc.getContext('2d');
  function drawCurve(f) {
    const w = cvc.width / 2, h = cvc.height / 2; cvg.setTransform(2, 0, 0, 2, 0, 0); cvg.clearRect(0, 0, w, h);
    const padL = 34, padR = 10, padT = 8, padB = 20, gap = 14;
    const hL = Math.round((h - padT - padB - gap) * 0.6), hD = h - padT - padB - gap - hL;
    const a0 = -10, a1 = 25, X = a => padL + (a - a0) / (a1 - a0) * (w - padL - padR);
    let clLo = -1.2, clHi = 2.6, cdHi = 0.6;
    const live = f.mean.n >= 100 ? f.mean : null;
    for (const p of state.points) { clLo = Math.min(clLo, p.cl - 0.1); clHi = Math.max(clHi, p.cl + 0.1); cdHi = Math.max(cdHi, p.cd * 1.15); }
    if (live) { clLo = Math.min(clLo, live.cl - 0.1); clHi = Math.max(clHi, live.cl + 0.1); cdHi = Math.max(cdHi, live.cd * 1.15); }
    const YL = c => padT + (clHi - c) / (clHi - clLo) * hL, YD = c => padT + hL + gap + (cdHi - c) / cdHi * hD;
    cvg.font = '10px "Cascadia Code", Consolas, monospace';
    // lanes
    const lane = (y0, y1, label) => { cvg.fillStyle = 'rgba(255,255,255,.03)'; cvg.fillRect(padL, y0, w - padL - padR, y1 - y0); cvg.fillStyle = 'rgba(255,255,255,.35)'; cvg.textAlign = 'left'; cvg.textBaseline = 'top'; cvg.fillText(label, 3, y0); };
    lane(padT, padT + hL, 'Cl'); lane(padT + hL + gap, h - padB, 'Cd');
    cvg.textAlign = 'right'; cvg.textBaseline = 'middle'; cvg.fillStyle = 'rgba(255,255,255,.45)';
    for (let c = Math.ceil(clLo); c <= Math.floor(clHi); c++) { cvg.strokeStyle = c === 0 ? 'rgba(255,255,255,.3)' : 'rgba(255,255,255,.08)'; cvg.beginPath(); cvg.moveTo(padL, YL(c)); cvg.lineTo(w - padR, YL(c)); cvg.stroke(); cvg.fillText(String(c), padL - 4, YL(c)); }
    const dStep = cdHi > 1.5 ? 0.5 : cdHi > 0.7 ? 0.25 : 0.2;
    for (let c = 0; c <= cdHi + 1e-9; c += dStep) { cvg.strokeStyle = 'rgba(255,255,255,.08)'; cvg.beginPath(); cvg.moveTo(padL, YD(c)); cvg.lineTo(w - padR, YD(c)); cvg.stroke(); cvg.fillText(c.toFixed(c % 1 ? 2 : 0).replace(/^0\./, '.'), padL - 4, YD(c)); }
    cvg.textAlign = 'center'; cvg.textBaseline = 'top';
    for (const a of [-10, 0, 10, 20]) { cvg.strokeStyle = a === 0 ? 'rgba(255,255,255,.2)' : 'rgba(255,255,255,.08)'; cvg.beginPath(); cvg.moveTo(X(a), padT); cvg.lineTo(X(a), h - padB); cvg.stroke(); cvg.fillStyle = 'rgba(255,255,255,.45)'; cvg.fillText(`${a}°`, X(a), h - padB + 4); }
    cvg.textAlign = 'right'; cvg.fillText('α', w - 2, h - padB + 4);
    // thin-airfoil line
    if (state.shape.kind !== 'cylinder') {
      cvg.save(); cvg.beginPath(); cvg.rect(padL, padT, w - padL - padR, hL); cvg.clip();
      cvg.setLineDash([4, 4]); cvg.strokeStyle = 'rgba(255,255,255,.35)'; cvg.lineWidth = 1; cvg.beginPath();
      cvg.moveTo(X(a0), YL(2 * Math.PI * (a0 * D2R - state.aL0))); cvg.lineTo(X(a1), YL(2 * Math.PI * (a1 * D2R - state.aL0)));
      cvg.stroke(); cvg.setLineDash([]); cvg.restore();
    }
    // points
    const pts = state.points.slice().sort((p, q) => p.alpha - q.alpha);
    if (pts.length > 1) {
      cvg.strokeStyle = 'rgba(240,181,96,.5)'; cvg.lineWidth = 1; cvg.beginPath(); pts.forEach((p, k) => k ? cvg.lineTo(X(p.alpha), YL(p.cl)) : cvg.moveTo(X(p.alpha), YL(p.cl))); cvg.stroke();
      cvg.strokeStyle = 'rgba(111,168,255,.5)'; cvg.beginPath(); pts.forEach((p, k) => k ? cvg.lineTo(X(p.alpha), YD(p.cd)) : cvg.moveTo(X(p.alpha), YD(p.cd))); cvg.stroke();
    }
    for (const p of pts) {
      cvg.fillStyle = '#f0b560'; cvg.beginPath(); cvg.arc(X(p.alpha), YL(p.cl), 3, 0, 7); cvg.fill();
      cvg.fillStyle = '#6fa8ff'; cvg.beginPath(); cvg.arc(X(p.alpha), YD(p.cd), 3, 0, 7); cvg.fill();
    }
    if (live) {
      const a = state.shape.alpha;
      cvg.lineWidth = 1.5; cvg.strokeStyle = '#ffe0b0'; cvg.beginPath(); cvg.arc(X(a), YL(clamp(live.cl, clLo, clHi)), 4.5, 0, 7); cvg.stroke();
      cvg.strokeStyle = '#a9c8ff'; cvg.beginPath(); cvg.arc(X(a), YD(clamp(live.cd, 0, cdHi)), 4.5, 0, 7); cvg.stroke();
    }
  }
  function recordPoint(f) {
    if (!f || f.mean.n < 100) return;
    const a = state.shape.alpha, m = f.mean2 || f.mean;
    state.points = state.points.filter(p => Math.abs(p.alpha - a) > 0.01);
    state.points.push({ alpha: a, cl: m.cl, cd: m.cd });
    $('npts').textContent = `${state.points.length} point${state.points.length === 1 ? '' : 's'} · ${codeLabel()} · Re ${fmt(state.re)}`;
  }
  function clearPoints() { state.points = []; $('npts').textContent = 'no points yet'; }

  // ---------------------------------------------------------------- controls
  const sl = { alpha: $('s-alpha'), m: $('s-m'), p: $('s-p'), t: $('s-t'), flap: $('s-flap'), re: $('s-re') };
  const reFromSlider = v => Math.round(RE_MIN * Math.pow(RE_MAX / RE_MIN, v) / 10) * 10;
  const sliderFromRe = re => Math.log(re / RE_MIN) / Math.log(RE_MAX / RE_MIN);
  function codeLabel() {
    const s = state.shape;
    if (s.kind === 'cylinder') return 'cylinder';
    if (s.kind === 'plate') return 'flat plate';
    return `NACA ${s.m}${s.m ? s.p / 10 : 0}${String(s.t).padStart(2, '0')}`;
  }
  function refreshLabels() {
    const s = state.shape;
    $('o-alpha').textContent = `${s.alpha.toFixed(1)}°`; $('o-m').textContent = `${s.m} %`; $('o-p').textContent = `${s.p} %`;
    $('o-t').textContent = `${s.t} %`; $('o-flap').textContent = `${s.flap}°`; $('o-re').textContent = fmt(state.re);
    $('code').textContent = codeLabel();
    const bits = [];
    if (s.kind === 'cylinder') bits.push('d = 0.3 c');
    else { if (s.flap) bits.push(`flap ${s.flap}°`); bits.push(`α₀ ${(state.aL0 / D2R).toFixed(1)}°`); }
    $('code2').textContent = bits.length ? '· ' + bits.join(' · ') : '';
    const cyl = s.kind === 'cylinder';
    for (const k of ['alpha', 'm', 'p', 't', 'flap']) sl[k].disabled = cyl;
  }
  function updateShape() { placeGeometry(); cmdShape(); refreshLabels(); }
  function setAlpha(a) { state.shape.alpha = clamp(a, -10, 25); sl.alpha.value = state.shape.alpha; updateShape(); }
  function setSliders() {
    const s = state.shape;
    sl.alpha.value = s.alpha; sl.m.value = s.m; sl.p.value = s.p; sl.t.value = s.t; sl.flap.value = s.flap; sl.re.value = sliderFromRe(state.re);
  }
  sl.alpha.addEventListener('input', () => { state.shape.alpha = +sl.alpha.value; updateShape(); });
  for (const k of ['m', 'p', 't', 'flap']) sl[k].addEventListener('input', () => {
    state.shape[k] = +sl[k].value;
    if (state.shape.kind !== 'naca') state.shape.kind = 'naca';
    $('preset').value = 'custom'; clearPoints(); updateShape();
  });
  sl.re.addEventListener('input', () => { state.re = reFromSlider(+sl.re.value); cmdRe(); refreshLabels(); clearPoints(); });
  $('preset').addEventListener('change', () => {
    const p = PRESETS[$('preset').value]; if (!p) return;
    Object.assign(state.shape, p); setSliders(); clearPoints(); updateShape();
  });
  function setRunning(on) { state.running = on; $('play').textContent = on ? '❚❚' : '▶'; cmdRun(on); }
  $('play').addEventListener('click', () => setRunning(!state.running));
  $('reset').addEventListener('click', cmdReset);
  $('sweep').addEventListener('click', () => {
    if (state.sweep) { state.sweep = null; $('sweep').textContent = 'sweep α'; return; }
    if (state.shape.kind === 'cylinder') return;
    if (!state.running) setRunning(true);
    state.sweep = { k: 0, until: (state.field ? state.field.t : 0) + HOLD + 600 };
    setAlpha(SWEEP[0]); $('sweep').textContent = `sweep 1/${SWEEP.length}`;
  });
  function sweepTick(f) {
    const s = state.sweep;
    if (f.t < s.until) return;
    recordPoint(f); s.k++;
    if (s.k >= SWEEP.length) { state.sweep = null; $('sweep').textContent = 'sweep α'; note('sweep done — the curve is on the lift-curve card'); return; }
    setAlpha(SWEEP[s.k]); s.until = f.t + HOLD; $('sweep').textContent = `sweep ${s.k + 1}/${SWEEP.length}`;
  }
  function setView(v) { state.view = v; state.fresh = true; document.querySelectorAll('#views .chip').forEach(c => c.classList.toggle('on', c.dataset.v === v)); }
  document.querySelectorAll('#views .chip').forEach(c => c.addEventListener('click', () => setView(c.dataset.v)));
  $('smoke').addEventListener('click', () => { state.smoke = !state.smoke; $('smoke').classList.toggle('on', state.smoke); });
  $('mark').addEventListener('click', () => recordPoint(state.field));
  $('clear').addEventListener('click', clearPoints);
  $('helpbtn').addEventListener('click', () => $('help').classList.toggle('on'));
  $('helpclose').addEventListener('click', () => $('help').classList.remove('on'));
  window.addEventListener('keydown', e => {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;
    if (e.key === ' ') { e.preventDefault(); setRunning(!state.running); }
    else if (e.key === 'r' || e.key === 'R') cmdReset();
    else if (e.key === 's' || e.key === 'S') $('smoke').click();
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (state.shape.kind !== 'cylinder') setAlpha(state.shape.alpha + 1); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); if (state.shape.kind !== 'cylinder') setAlpha(state.shape.alpha - 1); }
    else if (e.key === '1') setView('p'); else if (e.key === '2') setView('u'); else if (e.key === '3') setView('w'); else if (e.key === '0') setView('n');
    else if (e.key === '?') $('help').classList.toggle('on');
    else if (e.key === 'Escape') $('help').classList.remove('on');
  });
  cv.addEventListener('pointermove', e => {
    const x = lx(e.clientX), y = ly(e.clientY);
    state.probe = (x >= 0 && y >= 0 && x < NX - 1 && y < NY - 1) ? { x, y, cx: e.clientX, cy: e.clientY } : null;
    if (!state.probe) $('probe').style.display = 'none';
  });
  cv.addEventListener('pointerleave', () => { state.probe = null; $('probe').style.display = 'none'; });
  document.addEventListener('visibilitychange', () => cmdRun(!document.hidden && state.running));
  let noteTimer = null;
  function note(s) { const el = $('hint'); el.textContent = s; el.style.opacity = 1; clearTimeout(noteTimer); noteTimer = setTimeout(() => { el.style.opacity = 0; }, 6000); }

  // ---------------------------------------------------------------- frame loop
  let frames = 0;
  function frame() {
    requestAnimationFrame(frame);
    if (local) stepLocal();
    const f = state.field; if (!f || !f.ux || !f.ux.length) return;
    const dt = f.t - state.lastT;
    if (dt > 0 && dt <= 400 && state.smoke) advectSmoke(f, dt);
    else if (dt < 0 || dt > 400) resetSmoke();          // a reset, or a tab that was asleep
    state.lastT = f.t;
    if (state.fresh) { paintField(f); state.fresh = false; }
    draw(f);
    frames++;
    const now = performance.now();
    if (now - state.rateAt > 1000) { state.rate = (f.t - state.rateT) / ((now - state.rateAt) / 1000); state.rateT = f.t; state.rateAt = now; }
    if (frames % 3 === 0) { updateReadouts(f); drawSpark(f); drawCp(f); drawCurve(f); }
    if (state.sweep) sweepTick(f);
  }

  // ---------------------------------------------------------------- go
  placeGeometry(); setSliders(); refreshLabels(); placePanels(); resize();
  startEngine();
  requestAnimationFrame(frame);
  setTimeout(() => { $('hint').style.opacity = 0; }, 9000);

  window.TUNNEL_DEBUG = {
    state, rakes, NX, NY, CHORD, get field() { return state.field; }, setAlpha, setView, recordPoint, engine: () => worker ? 'worker' : local ? 'local' : 'none',
  };
})();
