// Pressure Systems — pressure.html
//
// Field: 1013 hPa + one Gaussian per system (signed amplitude, radius), so the
// gradient, Laplacian and isobar curvature are all analytic — no grid noise.
// Wind at a point is the steady balance of pressure-gradient force P = −∇p/ρ,
// Coriolis (f = 2Ω sin φ) and linear friction k·v:
//     v = P (k − i f) / (k² + f²)          (complex notation, i = 90° left)
// k = 0 → geostrophic (‖ isobars, low on the left in the N hemisphere);
// f = 0 → straight down the gradient; both 0 → no balance, speed capped.
// Speed is then scaled by the gradient-wind solution for the local isobar
// curvature (cyclonic → subgeostrophic, anticyclonic → supergeostrophic).
// Parcels integrate the same three forces from rest (RK2), so without
// friction they trace inertial loops instead of settling.
// 3-D: k falls linearly to 0 across the friction layer (0–1.5 km); the
// ageostrophic divergence is a(k)·∇²p/ρ with a = k/(k²+f²), integrated in
// closed form for w; above the layer w arches to 0 at 10 km and the return
// outflow is −P scaled to carry the same mass. Schematic, mass-consistent.
// Units: SI inside, nm / kt / hPa on screen. All directions °true.
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const OMEGA = 7.292e-5, RHO = 1.2, NM = 1852, MS2KT = 1.943844;
  const DOMW = 3.0e6, DOMH = 1.875e6;           // m — 1,620 × 1,012 nm
  const Z_BL = 1500, Z_TOP = 10000, Z_CLOUD = 3000, EXAG = 100;
  const K_MAX = 1.2e-4;                          // friction slider 1 → k (s⁻¹)
  const TIME = 10800;                            // model s per real s at ×1 (1 s = 3 h)
  const VCAP = 77;                               // m/s ≈ 150 kt — no balance exists
  const GX = 96, GY = 60, ISO = 400;             // field grid; isobar step (Pa)
  const FS = 2.6e4, VS = 1.8;                    // px per m/s², px per m/s (arrows)
  const COL = { P: '#ffb84d', C: '#4a9eff', F: '#9aa', N: '#7fd8a2', V: '#fff' };

  const S = {
    view: 'plan', mode: 'edit', sys: [], sel: -1, lat: 39, fric: 0.5, speed: 1, curv: true,
    iso: true, tint: true, tracers: true, barbs: false, band: 'all',
    tr: [], tr3: [], parcels: [], cam: { az: 28, el: 32 },
    hover: null, inside: false, drag: null, last: 0, raf: 0,
  };
  const PRESETS = {
    pair: [[-.22, .10, -20, 450], [.25, -.12, 16, 650]],
    low: [[0, 0, -24, 500]],
    high: [[0, 0, 18, 700]],
    squeeze: [[-.14, .05, -22, 420], [.16, -.05, 20, 480]],
    col: [[-.3, .22, 14, 450], [.3, .22, -14, 450], [-.3, -.22, -14, 450], [.3, -.22, 14, 450]],
  };
  const mkSys = (fx, fy, hpa, km) => ({ x: fx * DOMW, y: fy * DOMH, A: hpa * 100, sig: km * 1000 });
  const loadPreset = (k) => { S.sys = (PRESETS[k] || PRESETS.pair).map((a) => mkSys(...a)); S.sel = -1; S.parcels = []; S.tr = []; S.tr3 = []; syncSel(); };

  /* ------------------------------ physics ------------------------------ */
  const coriolis = () => 2 * OMEGA * Math.sin(S.lat * Math.PI / 180);
  const kSfc = () => S.fric * K_MAX;
  function field(x, y) {
    let p = 101300, px = 0, py = 0, pxx = 0, pyy = 0, pxy = 0;
    for (const o of S.sys) {
      const dx = x - o.x, dy = y - o.y, s2 = o.sig * o.sig, e = o.A * Math.exp(-(dx * dx + dy * dy) / (2 * s2));
      p += e; px -= dx / s2 * e; py -= dy / s2 * e;
      pxx += (dx * dx / s2 - 1) / s2 * e; pyy += (dy * dy / s2 - 1) / s2 * e; pxy += dx * dy / (s2 * s2) * e;
    }
    return { p, px, py, pxx, pyy, pxy };
  }
  // steady balanced wind at one point for friction k and Coriolis f
  function wind(F, k, f) {
    const Px = -F.px / RHO, Py = -F.py / RHO, den = k * k + f * f;
    let vx, vy, capped = false;
    if (den < 1e-16) { const m = Math.hypot(Px, Py) || 1e-12; vx = Px / m * VCAP; vy = Py / m * VCAP; capped = true; }
    else { vx = (Px * k + Py * f) / den; vy = (Py * k - Px * f) / den; }
    let ratio = 1;
    const g2 = F.px * F.px + F.py * F.py, fa = Math.abs(f);
    if (S.curv && fa > 2e-6 && g2 > 1e-12) {
      const kap = (F.pxx * F.py * F.py - 2 * F.pxy * F.px * F.py + F.pyy * F.px * F.px) / Math.pow(g2, 1.5);
      if (Math.abs(kap) > 2e-7) {                       // straighter than R = 5,000 km → straight
        const R = 1 / Math.abs(kap), Pm = Math.hypot(Px, Py), Vg = Pm / fa;
        let V;
        if (kap > 0) V = (-fa * R + Math.sqrt(fa * fa * R * R + 4 * R * Pm)) / 2;      // cyclonic
        else { const d = fa * fa * R * R - 4 * R * Pm; V = d >= 0 ? (fa * R - Math.sqrt(d)) / 2 : fa * R / 2; } // anticyclonic
        ratio = Math.max(.3, Math.min(2.5, V / Vg));
      }
    }
    vx *= ratio; vy *= ratio;
    const sp = Math.hypot(vx, vy);
    if (sp > VCAP) { vx *= VCAP / sp; vy *= VCAP / sp; capped = true; }
    return { vx, vy, Px, Py, ratio, capped };
  }
  // ∫₀ᶻ a(k) dz through the friction layer, closed form (k linear in z)
  const fEff = (f) => Math.max(Math.abs(f), 1e-5);
  function wBL(F, z, f, ks) {
    if (ks < 1e-9) return 0;
    const fe = fEff(f), k = ks * Math.max(0, 1 - z / Z_BL);
    return (F.pxx + F.pyy) / RHO * Z_BL / (2 * ks) * Math.log((ks * ks + fe * fe) / (k * k + fe * fe));
  }
  const Cprime = (f, ks) => { if (ks < 1e-9) return 0; const fe = fEff(f); return Z_BL / (2 * ks) * Math.log((ks * ks + fe * fe) / (fe * fe)); };
  function wind3(x, y, z, f, ks) {
    const F = field(x, y);
    if (z <= Z_BL) { const w = wind(F, ks * (1 - z / Z_BL), f); return [w.vx, w.vy, wBL(F, z, f, ks)]; }
    const g = wind(F, 0, f), r = (z - Z_BL) / (Z_TOP - Z_BL), C = Cprime(f, ks);
    const s = 2 * C / (Z_TOP - Z_BL) * r, W = (F.pxx + F.pyy) / RHO * C;
    return [g.vx - s * g.Px, g.vy - s * g.Py, W * (1 - r * r)];
  }

  /* ------------------------------- grid -------------------------------- */
  const G = { p: new Float32Array(GX * GY), lap: new Float32Array(GX * GY), min: 0, max: 0 };
  const gx = (i) => -DOMW / 2 + i * DOMW / (GX - 1), gy = (j) => DOMH / 2 - j * DOMH / (GY - 1);
  let segs = [];                                            // [{lv, pts: Float32Array(x1,y1,x2,y2,…)}]
  function buildGrid() {
    let mn = 1e9, mx = -1e9;
    for (let j = 0; j < GY; j++) for (let i = 0; i < GX; i++) {
      const F = field(gx(i), gy(j)), n = j * GX + i;
      G.p[n] = F.p; G.lap[n] = F.pxx + F.pyy; if (F.p < mn) mn = F.p; if (F.p > mx) mx = F.p;
    }
    G.min = mn; G.max = mx;
    segs = [];
    const lo = Math.ceil(mn / ISO) * ISO, hi = Math.floor(mx / ISO) * ISO;
    for (let lv = lo; lv <= hi; lv += ISO) {
      const out = [];
      for (let j = 0; j < GY - 1; j++) for (let i = 0; i < GX - 1; i++) {
        const a = G.p[j * GX + i], b = G.p[j * GX + i + 1], c = G.p[(j + 1) * GX + i + 1], d = G.p[(j + 1) * GX + i];
        if ((a < lv) === (b < lv) && (b < lv) === (c < lv) && (c < lv) === (d < lv)) continue;
        const x0 = gx(i), x1 = gx(i + 1), y0 = gy(j), y1 = gy(j + 1), pts = [];
        const ip = (p, q, ax, ay, bx, by) => { const t = (lv - p) / (q - p); pts.push(ax + (bx - ax) * t, ay + (by - ay) * t); };
        if ((a < lv) !== (b < lv)) ip(a, b, x0, y0, x1, y0);
        if ((b < lv) !== (c < lv)) ip(b, c, x1, y0, x1, y1);
        if ((c < lv) !== (d < lv)) ip(c, d, x1, y1, x0, y1);
        if ((d < lv) !== (a < lv)) ip(d, a, x0, y1, x0, y0);
        if (pts.length === 4) out.push(...pts);
        else if (pts.length === 8) out.push(pts[0], pts[1], pts[2], pts[3], pts[4], pts[5], pts[6], pts[7]);
      }
      if (out.length) segs.push({ lv, pts: out });
    }
  }
  // textures: pressure tint (plan + 3-D ground) and cloud (3-D, where the friction layer pumps air up)
  const tintC = document.createElement('canvas'); tintC.width = GX; tintC.height = GY;
  const cloudC = document.createElement('canvas'); cloudC.width = GX; cloudC.height = GY;
  function buildTint() {
    const g = tintC.getContext('2d'), im = g.createImageData(GX, GY), d = im.data;
    for (let n = 0; n < GX * GY; n++) {
      const v = Math.max(-1, Math.min(1, (G.p[n] - 101300) / 2400)), hi = v > 0;
      d[n * 4] = hi ? 90 : 255; d[n * 4 + 1] = hi ? 150 : 110; d[n * 4 + 2] = hi ? 255 : 110; d[n * 4 + 3] = Math.abs(v) * 80;
    }
    g.putImageData(im, 0, 0);
  }
  function buildCloud(f, ks) {
    const g = cloudC.getContext('2d'), im = g.createImageData(GX, GY), d = im.data, C = Cprime(f, ks);
    for (let n = 0; n < GX * GY; n++) {
      const W = G.lap[n] / RHO * C, a = Math.pow(Math.max(0, Math.min(1, W / 0.12)), 1.4);
      d[n * 4] = 235; d[n * 4 + 1] = 240; d[n * 4 + 2] = 248; d[n * 4 + 3] = a * 120;
    }
    g.putImageData(im, 0, 0);
  }

  /* ---------------------------- projection ----------------------------- */
  const cv = $('viz'), ctx = cv.getContext('2d');
  let cw = 960, ch = 600, dpr = 1;
  function resize() {
    const w = Math.max(320, Math.round(cv.getBoundingClientRect().width || 960));
    dpr = Math.min(2, window.devicePixelRatio || 1);
    cw = w; ch = Math.round(w * DOMH / DOMW);
    cv.width = Math.round(cw * dpr); cv.height = Math.round(ch * dpr); cv.style.height = ch + 'px';
  }
  // orthographic orbit; plan view is az = 0, el = 90 with the box filling the canvas
  let PR = null;
  function makeProj() {
    const plan = S.view === 'plan', az = plan ? 0 : S.cam.az * Math.PI / 180, el = plan ? Math.PI / 2 : S.cam.el * Math.PI / 180;
    const ca = Math.cos(az), sa = Math.sin(az), se = Math.sin(el), ce = Math.cos(el);
    let sc, cx, cy;
    if (plan) { sc = cw / DOMW; cx = cw / 2; cy = ch / 2; }
    else {
      let x0 = 1e18, x1 = -1e18, y0 = 1e18, y1 = -1e18;
      for (const [x, y, z] of [[-DOMW / 2, -DOMH / 2, 0], [DOMW / 2, -DOMH / 2, 0], [DOMW / 2, DOMH / 2, 0], [-DOMW / 2, DOMH / 2, 0],
        [-DOMW / 2, -DOMH / 2, Z_TOP], [DOMW / 2, -DOMH / 2, Z_TOP], [DOMW / 2, DOMH / 2, Z_TOP], [-DOMW / 2, DOMH / 2, Z_TOP]]) {
        const X = x * ca - y * sa, Y = x * sa + y * ca, sy = -(Y * se + z * EXAG * ce);
        x0 = Math.min(x0, X); x1 = Math.max(x1, X); y0 = Math.min(y0, sy); y1 = Math.max(y1, sy);
      }
      sc = Math.min((cw - 130) / (x1 - x0), (ch - 40) / (y1 - y0));
      cx = cw / 2 + 40 - (x0 + x1) / 2 * sc; cy = ch / 2 - (y0 + y1) / 2 * sc;
    }
    PR = {
      plan, sc, cx, cy, ca, sa, se, ce,
      p: (x, y, z = 0) => [cx + (x * ca - y * sa) * sc, cy - ((x * sa + y * ca) * se + z * EXAG * ce) * sc],
      depth: (x, y, z) => -(x * sa + y * ca) * ce + z * EXAG * se,
      inv: (sx, sy) => [(sx - cx) / sc, (cy - sy) / sc],                // plan only
      affine: (z, tw, th) => {                                          // texture (tw×th over the domain) → screen, plane at z
        const kx = DOMW / tw, ky = DOMH / th, x0 = -DOMW / 2, y1 = DOMH / 2;
        return [kx * ca * sc, -kx * sa * se * sc, ky * sa * sc, ky * ca * se * sc,
          cx + (x0 * ca - y1 * sa) * sc, cy - ((x0 * sa + y1 * ca) * se + z * EXAG * ce) * sc];
      },
    };
  }

  /* ------------------------------ tracers ------------------------------ */
  const inDom = (x, y) => x > -DOMW / 2 && x < DOMW / 2 && y > -DOMH / 2 && y < DOMH / 2;
  const spawn2 = () => ({ x: (Math.random() - .5) * DOMW, y: (Math.random() - .5) * DOMH, px: 0, py: 0, life: 200 + Math.random() * 400, age: 0 });
  function spawnZ() {
    const u = Math.random();
    if (S.band === 'sfc') return u * Z_BL * .95;
    if (S.band === 'aloft') return Z_BL + u * (Z_TOP - Z_BL) * .9;
    return Z_TOP * u * u * u;
  }
  const spawn3 = () => ({ x: (Math.random() - .5) * DOMW, y: (Math.random() - .5) * DOMH, z: spawnZ(), px: 0, py: 0, pz: 0, life: 250 + Math.random() * 450, age: 0 });
  function stepTracers(dtm, f, ks) {
    const N = S.tracers ? Math.round(cw * ch / 380) : 0;
    while (S.tr.length < N) { const t = spawn2(); t.age = Math.random() * 100; S.tr.push(t); }
    if (S.tr.length > N) S.tr.length = N;
    for (const t of S.tr) {
      const w1 = wind(field(t.x, t.y), ks, f), xm = t.x + w1.vx * dtm / 2, ym = t.y + w1.vy * dtm / 2;
      const w2 = wind(field(xm, ym), ks, f);
      t.px = t.x; t.py = t.y; t.x += w2.vx * dtm; t.y += w2.vy * dtm; t.sp = Math.hypot(w2.vx, w2.vy); t.life--; t.age++;
      if (t.life <= 0 || !inDom(t.x, t.y)) Object.assign(t, spawn2());
    }
  }
  function stepTracers3(dtm, f, ks) {
    const N = S.tracers ? Math.round(cw * ch / 300) : 0;
    while (S.tr3.length < N) { const t = spawn3(); t.age = Math.random() * 100; S.tr3.push(t); }
    if (S.tr3.length > N) S.tr3.length = N;
    for (const t of S.tr3) {
      const v1 = wind3(t.x, t.y, t.z, f, ks);
      const v2 = wind3(t.x + v1[0] * dtm / 2, t.y + v1[1] * dtm / 2, Math.max(0, t.z + v1[2] * dtm / 2), f, ks);
      t.px = t.x; t.py = t.y; t.pz = t.z;
      t.x += v2[0] * dtm; t.y += v2[1] * dtm; t.z = Math.max(0, t.z + v2[2] * dtm); t.w = v2[2]; t.life--; t.age++;
      if (t.life <= 0 || !inDom(t.x, t.y) || t.z > Z_TOP) Object.assign(t, spawn3());
    }
  }
  // parcels: the real equation of motion, from rest
  function stepParcels(dtm, f, ks) {
    const n = 6, h = dtm / n;
    const acc = (x, y, vx, vy) => { const F = field(x, y); return [-F.px / RHO + f * vy - ks * vx, -F.py / RHO - f * vx - ks * vy]; };
    for (const q of S.parcels) {
      for (let s = 0; s < n; s++) {
        const a1 = acc(q.x, q.y, q.vx, q.vy);
        const xm = q.x + q.vx * h / 2, ym = q.y + q.vy * h / 2, vxm = q.vx + a1[0] * h / 2, vym = q.vy + a1[1] * h / 2;
        const a2 = acc(xm, ym, vxm, vym);
        q.x += vxm * h; q.y += vym * h; q.vx += a2[0] * h; q.vy += a2[1] * h;
        const sp = Math.hypot(q.vx, q.vy); if (sp > VCAP * 2) { q.vx *= VCAP * 2 / sp; q.vy *= VCAP * 2 / sp; }
      }
      q.t += dtm;
      if (q.t - q.lastT > 900) { q.trail.push(q.x, q.y); q.lastT = q.t; if (q.trail.length > 1200) q.trail.splice(0, 2); }
      q.acc = acc(q.x, q.y, q.vx, q.vy);
    }
    S.parcels = S.parcels.filter((q) => inDom(q.x, q.y));
  }

  /* ------------------------------ drawing ------------------------------ */
  function arrow(g, x, y, dx, dy, color, w = 2, dash = null) {
    const L = Math.hypot(dx, dy); if (L < 2) return;
    g.save(); g.strokeStyle = color; g.fillStyle = color; g.lineWidth = w; g.lineCap = 'round';
    if (dash) g.setLineDash(dash);
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + dx, y + dy); g.stroke(); g.setLineDash([]);
    const ux = dx / L, uy = dy / L, hs = Math.min(9, 3 + L * .18);
    g.beginPath(); g.moveTo(x + dx, y + dy); g.lineTo(x + dx - ux * hs - uy * hs * .55, y + dy - uy * hs + ux * hs * .55);
    g.lineTo(x + dx - ux * hs + uy * hs * .55, y + dy - uy * hs - ux * hs * .55); g.closePath(); g.fill(); g.restore();
  }
  function barb(g, x, y, vx, vy, nh) {
    const kt = Math.hypot(vx, vy) * MS2KT;
    g.strokeStyle = 'rgba(210,225,245,.75)'; g.lineWidth = 1.3; g.lineCap = 'round';
    if (kt < 2.5) { g.beginPath(); g.arc(x, y, 3, 0, 6.283); g.stroke(); return; }
    const m = Math.hypot(vx, vy), ux = -vx / m, uy = vy / m;             // screen unit vector, upwind
    let fx = -uy, fy = ux; if (!nh) { fx = uy; fy = -ux; }              // feathers: 90° clockwise of the staff (N), CCW (S)
    const dx = fx * .866 + ux * .5, dy = fy * .866 + uy * .5;             // 60° off the staff, leaning outward
    const L = 24; g.beginPath(); g.moveTo(x, y); g.lineTo(x + ux * L, y + uy * L); g.stroke();
    let rem = Math.round(kt / 5) * 5, pos = L;
    const step = 4.5, fl = 9;
    g.fillStyle = g.strokeStyle;
    while (rem >= 50) { const ax = x + ux * pos, ay = y + uy * pos, bx = x + ux * (pos - step), by = y + uy * (pos - step);
      g.beginPath(); g.moveTo(ax, ay); g.lineTo(bx + dx * fl, by + dy * fl); g.lineTo(bx, by); g.closePath(); g.fill(); pos -= step * 1.3; rem -= 50; }
    while (rem >= 10) { const ax = x + ux * pos, ay = y + uy * pos; g.beginPath(); g.moveTo(ax, ay); g.lineTo(ax + dx * fl, ay + dy * fl); g.stroke(); pos -= step; rem -= 10; }
    if (rem >= 5) { if (pos === L) pos -= step; const ax = x + ux * pos, ay = y + uy * pos; g.beginPath(); g.moveTo(ax, ay); g.lineTo(ax + dx * fl / 2, ay + dy * fl / 2); g.stroke(); }
  }
  function drawIso(g, z = 0) {
    if (!S.iso) return;
    for (const s of segs) {
      const major = s.lv % 800 === 0;
      g.strokeStyle = `rgba(160,190,235,${major ? .55 : .25})`; g.lineWidth = major ? 1.2 : 1; g.beginPath();
      const q = s.pts;
      for (let n = 0; n < q.length; n += 4) { const a = PR.p(q[n], q[n + 1], z), b = PR.p(q[n + 2], q[n + 3], z); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); }
      g.stroke();
    }
    // isobar values along the west edge (plan)
    if (!PR.plan) return;
    g.font = '10px Segoe UI, system-ui'; g.fillStyle = 'rgba(160,190,235,.6)'; g.textAlign = 'left'; g.textBaseline = 'middle';
    for (const s of segs) { const q = s.pts; let best = null;
      for (let n = 0; n < q.length; n += 4) if (q[n] < -DOMW / 2 + DOMW / GX * 1.2 && (!best || q[n] < best[0])) best = [q[n], q[n + 1]];
      if (best) { const a = PR.p(best[0], best[1]); g.fillText(s.lv / 100, a[0] + 3, a[1] - 6); } }
  }
  function drawTexture(g, tex, z, alpha = 1) {
    const m = PR.affine(z, tex.width, tex.height);
    g.save(); g.globalAlpha = alpha; g.imageSmoothingEnabled = true; g.transform(...m); g.drawImage(tex, 0, 0); g.restore();
  }
  function drawMarkers(g) {
    g.textAlign = 'center'; g.textBaseline = 'middle';
    S.sys.forEach((o, k) => {
      const [x, y] = PR.p(o.x, o.y, 0), low = o.A < 0, act = k === S.sel || (S.drag && S.drag.k === k), pc = field(o.x, o.y).p / 100;
      if (act && PR.plan) { g.strokeStyle = 'rgba(255,255,255,.35)'; g.lineWidth = 1; g.beginPath(); g.arc(x, y, 26, 0, 6.283); g.stroke(); }
      g.fillStyle = low ? `rgba(255,130,130,${act ? 1 : .85})` : `rgba(130,175,255,${act ? 1 : .85})`;
      g.font = `700 ${PR.plan ? 34 : 26}px Segoe UI, system-ui`; g.fillText(low ? 'L' : 'H', x, y);
      g.font = '12px Segoe UI, system-ui'; g.fillStyle = 'rgba(210,222,240,.8)'; g.fillText(Math.round(pc) + ' hPa', x, y + (PR.plan ? 26 : 20));
    });
  }
  function forceArrows(g, x, y, Px, Py, vx, vy, f, k, label) {
    const cx = f * vy, cy = -f * vx, fx = -k * vx, fy = -k * vy, nx = Px + cx + fx, ny = Py + cy + fy;
    arrow(g, x, y, Px * FS, -Py * FS, COL.P, 2.2);
    arrow(g, x, y, cx * FS, -cy * FS, COL.C, 2.2);
    if (k > 0) arrow(g, x, y, fx * FS, -fy * FS, COL.F, 2);
    if (Math.hypot(nx, ny) * FS > 6) arrow(g, x, y, nx * FS, -ny * FS, COL.N, 1.5, [4, 3]);
    arrow(g, x, y, vx * VS, -vy * VS, COL.V, 2.6);
    if (label) { g.font = '11px Segoe UI, system-ui'; g.fillStyle = 'rgba(235,240,250,.85)'; g.textAlign = 'left'; g.textBaseline = 'bottom'; g.fillText(label, x + 8, y - 6); }
  }
  const hmsLabel = () => { const h = TIME * S.speed / 3600; return `1 s = ${h >= 10 ? Math.round(h) : h.toFixed(1)} h`; };

  function drawPlan(f, ks) {
    const g = ctx;
    g.fillStyle = '#14181e'; g.fillRect(0, 0, cw, ch);
    if (S.tint) drawTexture(g, tintC, 0);
    drawIso(g);
    if (S.barbs) {
      const nh = S.lat >= 0, st = 74, nx = Math.floor(cw / st), ny = Math.floor(ch / st), ox = (cw - (nx - 1) * st) / 2, oy = (ch - (ny - 1) * st) / 2;
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const sx = ox + i * st, sy = oy + j * st, [x, y] = PR.inv(sx, sy), w = wind(field(x, y), ks, f); barb(g, sx, sy, w.vx, w.vy, nh); }
    }
    g.lineWidth = 1.4; g.lineCap = 'round';
    for (const t of S.tr) {
      if (t.age < 2) continue;
      const a = PR.p(t.px, t.py), b = PR.p(t.x, t.y), fade = Math.min(1, t.age / 30, t.life / 40);
      const kt = t.sp * MS2KT, al = Math.min(.7, .08 + kt / 70) * fade, dx = b[0] - a[0], dy = b[1] - a[1], m = Math.hypot(dx, dy) || 1;
      const L = Math.min(18, 2 + kt * .3);
      g.strokeStyle = `rgba(200,222,255,${al})`; g.beginPath(); g.moveTo(b[0] - dx / m * L, b[1] - dy / m * L); g.lineTo(b[0], b[1]); g.stroke();
    }
    for (const q of S.parcels) {
      const tr = q.trail; if (tr.length >= 4) { g.strokeStyle = 'rgba(255,255,255,.45)'; g.lineWidth = 1.5; g.beginPath();
        for (let n = 0; n < tr.length; n += 2) { const s = PR.p(tr[n], tr[n + 1]); if (n) g.lineTo(s[0], s[1]); else g.moveTo(s[0], s[1]); }
        const e = PR.p(q.x, q.y); g.lineTo(e[0], e[1]); g.stroke(); }
      const [x, y] = PR.p(q.x, q.y), F = field(q.x, q.y);
      g.fillStyle = '#fff'; g.beginPath(); g.arc(x, y, 4, 0, 6.283); g.fill();
      forceArrows(g, x, y, -F.px / RHO, -F.py / RHO, q.vx, q.vy, f, ks, Math.round(Math.hypot(q.vx, q.vy) * MS2KT) + ' kt');
    }
    drawMarkers(g);
    if (S.inside && S.hover && S.mode === 'edit' && hit(S.hover.sx, S.hover.sy) < 0 && !S.drag) {
      const [x, y] = [S.hover.sx, S.hover.sy], F = field(S.hover.x, S.hover.y), w = wind(F, ks, f);
      forceArrows(g, x, y, w.Px, w.Py, w.vx, w.vy, f, ks, (w.capped ? '≥' : '') + Math.round(Math.hypot(w.vx, w.vy) * MS2KT) + ' kt');
    }
    // scale bar + clock
    const bar = 200 * NM * PR.sc; g.strokeStyle = 'rgba(200,210,225,.6)'; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(14, ch - 14); g.lineTo(14 + bar, ch - 14); g.moveTo(14, ch - 18); g.lineTo(14, ch - 10); g.moveTo(14 + bar, ch - 18); g.lineTo(14 + bar, ch - 10); g.stroke();
    g.font = '11px Segoe UI, system-ui'; g.fillStyle = 'rgba(200,210,225,.7)'; g.textAlign = 'left'; g.textBaseline = 'bottom'; g.fillText('200 nm', 18, ch - 17);
    g.textAlign = 'right'; g.fillText(hmsLabel() + ' · N ↑', cw - 12, ch - 8);
  }

  function draw3D(f, ks) {
    const g = ctx;
    g.fillStyle = '#14181e'; g.fillRect(0, 0, cw, ch);
    const c = [[-DOMW / 2, -DOMH / 2], [DOMW / 2, -DOMH / 2], [DOMW / 2, DOMH / 2], [-DOMW / 2, DOMH / 2]];
    const P0 = c.map(([x, y]) => PR.p(x, y, 0)), P1 = c.map(([x, y]) => PR.p(x, y, Z_TOP)), PB = c.map(([x, y]) => PR.p(x, y, Z_BL));
    g.fillStyle = '#1b222c'; g.beginPath(); P0.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]))); g.closePath(); g.fill();
    if (S.tint) drawTexture(g, tintC, 0, .9);
    drawIso(g, 0);
    g.strokeStyle = 'rgba(200,210,225,.5)'; g.lineWidth = 1; g.beginPath(); P0.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]))); g.closePath(); g.stroke();
    drawMarkers(g);
    // box: verticals, friction-layer top (dashed), lid
    g.strokeStyle = 'rgba(200,210,225,.3)'; g.beginPath(); for (let i = 0; i < 4; i++) { g.moveTo(P0[i][0], P0[i][1]); g.lineTo(P1[i][0], P1[i][1]); } g.stroke();
    g.setLineDash([4, 4]); g.strokeStyle = 'rgba(255,184,77,.35)'; g.beginPath(); PB.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]))); g.closePath(); g.stroke();
    g.strokeStyle = 'rgba(200,210,225,.3)'; g.beginPath(); P1.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]))); g.closePath(); g.stroke(); g.setLineDash([]);
    // tracers, split at the cloud plane so the cloud sheet occludes correctly
    const streak = (t) => {
      if (t.age < 2) return;
      const a = PR.p(t.px, t.py, t.pz), b = PR.p(t.x, t.y, t.z), fade = Math.min(1, t.age / 30, t.life / 40), u = Math.min(1, t.z / Z_TOP);
      const r = Math.round(255 - 135 * u), gg = Math.round(190 + 10 * u), bb = Math.round(90 + 165 * u);
      const dx = b[0] - a[0], dy = b[1] - a[1], m = Math.hypot(dx, dy) || 1, L = Math.min(16, 2 + m * 5);
      g.strokeStyle = `rgba(${r},${gg},${bb},${.55 * fade})`; g.beginPath(); g.moveTo(b[0] - dx / m * L, b[1] - dy / m * L); g.lineTo(b[0], b[1]); g.stroke();
    };
    g.lineWidth = 1.3; g.lineCap = 'round';
    for (const t of S.tr3) if (t.z < Z_CLOUD) streak(t);
    drawTexture(g, cloudC, Z_CLOUD, .9);
    for (const t of S.tr3) if (t.z >= Z_CLOUD) streak(t);
    // height axis on the leftmost vertical edge
    let k0 = 0; for (let i = 1; i < 4; i++) if (P0[i][0] < P0[k0][0]) k0 = i;
    g.font = '10.5px Segoe UI, system-ui'; g.fillStyle = 'rgba(200,210,225,.6)'; g.textAlign = 'right'; g.textBaseline = 'middle';
    g.strokeStyle = 'rgba(200,210,225,.45)'; g.lineWidth = 1;
    for (let ft = 0; ft <= 30000; ft += 10000) { const z = ft * .3048, p = PR.p(c[k0][0], c[k0][1], z); g.beginPath(); g.moveTo(p[0] - 5, p[1]); g.lineTo(p[0], p[1]); g.stroke(); g.fillText(ft ? (ft / 1000) + ',000 ft' : '0', p[0] - 8, p[1]); }
    const pb = PR.p(c[k0][0], c[k0][1], Z_BL); g.fillStyle = 'rgba(255,184,77,.7)'; g.fillText('friction layer', pb[0] - 8, pb[1]);
    g.fillStyle = 'rgba(200,210,225,.7)'; g.font = '11px Segoe UI, system-ui'; g.textAlign = 'right'; g.textBaseline = 'bottom';
    g.fillText(`${hmsLabel()} · vertical ×${EXAG} · cloud = rising air`, cw - 12, ch - 8);
    g.textAlign = 'left'; g.fillText('N', PR.p(0, DOMH / 2 + 60000, 0)[0], PR.p(0, DOMH / 2 + 60000, 0)[1]);
  }

  /* ------------------------------ readout ------------------------------ */
  const fmtDir = (vx, vy) => { let d = Math.atan2(-vx, -vy) * 180 / Math.PI; d = (d + 360) % 360; return String(Math.round(d / 10) * 10 || 360).padStart(3, '0'); };
  function readout(f, ks) {
    const h = S.hover || { x: 0, y: 0 }, F = field(h.x, h.y), w = wind(F, ks, f);
    const gm = Math.hypot(F.px, F.py) * 185200 / 100, kt = Math.hypot(w.vx, w.vy) * MS2KT, Pm = Math.hypot(w.Px, w.Py);
    $('r-p').innerHTML = `${(F.p / 100).toFixed(1)} <span class="u">hPa</span>`;
    $('r-grad').innerHTML = `${gm.toFixed(1)} <span class="u">hPa / 100 nm</span>`;
    $('r-wind').innerHTML = kt < 1 ? 'calm' : `${fmtDir(w.vx, w.vy)}° <span class="u">true</span> ${w.capped ? '≥' : ''}${Math.round(kt)} <span class="u">kt</span>`;
    let cross = '—';
    if (Pm > 1e-7 && kt >= 1) { const cs = (w.vx * w.Px + w.vy * w.Py) / (Math.hypot(w.vx, w.vy) * Pm); const a = 90 - Math.acos(Math.max(-1, Math.min(1, cs))) * 180 / Math.PI; cross = `${Math.round(a)}° <span class="u">toward low</span>`; }
    $('r-cross').innerHTML = cross;
    const W = wBL(F, Z_BL, f, ks) * 100;
    $('r-w').innerHTML = Math.abs(W) < .05 ? '0 <span class="u">cm/s</span>' : `${W > 0 ? '↑' : '↓'} ${Math.abs(W).toFixed(1)} <span class="u">cm/s</span>`;
    $('r-f').innerHTML = `${(f * 1e4).toFixed(2)} <span class="u">×10⁻⁴ s⁻¹</span>`;
  }

  /* ------------------------------- frame ------------------------------- */
  function tick(t) {
    S.raf = requestAnimationFrame(tick);
    if (document.hidden) return;
    const dt = Math.min(50, S.last ? t - S.last : 16); S.last = t;
    const dtm = dt / 1000 * TIME * S.speed, f = coriolis(), ks = kSfc();
    buildGrid(); if (S.tint) buildTint();
    makeProj();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (S.view === 'plan') { stepTracers(dtm, f, ks); stepParcels(dtm, f, ks); drawPlan(f, ks); }
    else { buildCloud(f, ks); stepTracers3(dtm, f, ks); draw3D(f, ks); }
    readout(f, ks);
  }

  /* ------------------------------- input ------------------------------- */
  const evPos = (e) => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) * cw / r.width, (e.clientY - r.top) * ch / r.height]; };
  function hit(sx, sy) { let best = -1, bd = 26; if (!PR) return best; S.sys.forEach((o, k) => { const [x, y] = PR.p(o.x, o.y, 0), d = Math.hypot(sx - x, sy - y); if (d < bd) { bd = d; best = k; } }); return best; }
  function setHover(e) { if (!PR) return; const [sx, sy] = evPos(e); if (S.view !== 'plan') { S.hover = null; return; } const [x, y] = PR.inv(sx, sy); S.hover = { sx, sy, x, y }; }
  cv.addEventListener('pointerdown', (e) => {
    if (!PR) return;
    const [sx, sy] = evPos(e); try { cv.setPointerCapture(e.pointerId); } catch (_) {} e.preventDefault();
    if (S.view === '3d') { S.drag = { orbit: true, sx, sy, az: S.cam.az, el: S.cam.el }; cv.classList.add('orbit'); return; }
    const k = hit(sx, sy);
    if (k >= 0) { S.sel = k; syncSel(); const [x, y] = PR.inv(sx, sy); S.drag = { k, dx: S.sys[k].x - x, dy: S.sys[k].y - y }; cv.classList.add('grab'); return; }
    if (S.mode === 'parcel') { const [x, y] = PR.inv(sx, sy); if (S.parcels.length >= 8) S.parcels.shift(); S.parcels.push({ x, y, vx: 0, vy: 0, t: 0, lastT: 0, trail: [], acc: [0, 0] }); return; }
    S.sel = -1; syncSel();
  });
  cv.addEventListener('pointermove', (e) => {
    if (!PR) return;
    S.inside = true; setHover(e);
    if (!S.drag) { const [sx, sy] = evPos(e); cv.classList.toggle('grab', S.view === 'plan' && hit(sx, sy) >= 0); cv.classList.toggle('drop', S.view === 'plan' && S.mode === 'parcel' && hit(sx, sy) < 0); return; }
    const [sx, sy] = evPos(e);
    if (S.drag.orbit) { S.cam.az = S.drag.az + (sx - S.drag.sx) * .4; S.cam.el = Math.max(8, Math.min(89, S.drag.el - (sy - S.drag.sy) * .3)); return; }
    const [x, y] = PR.inv(sx, sy), o = S.sys[S.drag.k]; if (o) { o.x = x + S.drag.dx; o.y = y + S.drag.dy; }
  });
  const endDrag = (e) => {
    if (S.drag && !S.drag.orbit) { const o = S.sys[S.drag.k]; if (o && !inDom(o.x, o.y)) { S.sys.splice(S.drag.k, 1); S.sel = -1; syncSel(); } }
    S.drag = null; cv.classList.remove('orbit'); if (e.pointerType !== 'mouse') { S.inside = false; S.hover = null; }
  };
  cv.addEventListener('pointerup', endDrag); cv.addEventListener('pointercancel', endDrag);
  cv.addEventListener('pointerleave', () => { S.inside = false; });
  cv.addEventListener('wheel', (e) => {
    if (S.view !== 'plan') return; const [sx, sy] = evPos(e), k = S.drag && !S.drag.orbit ? S.drag.k : hit(sx, sy); if (k < 0) return;
    e.preventDefault(); adjust(k, e.deltaY < 0 ? 100 : -100);
  }, { passive: false });
  document.addEventListener('keydown', (e) => {
    if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
    if (S.sel < 0) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { S.sys.splice(S.sel, 1); S.sel = -1; syncSel(); }
    if (e.key === 'ArrowUp' || e.key === '+' || e.key === '=') { e.preventDefault(); adjust(S.sel, 100); }
    if (e.key === 'ArrowDown' || e.key === '-') { e.preventDefault(); adjust(S.sel, -100); }
    if (e.key === 'Escape') { S.sel = -1; syncSel(); }
  });
  function adjust(k, dA) { const o = S.sys[k]; if (!o) return; let A = o.A + dA; A = Math.max(-4000, Math.min(4000, A)); if (Math.abs(A) < 100) A = dA > 0 ? 100 : -100; o.A = A; syncSel(); }

  /* ------------------------------ controls ----------------------------- */
  const setView = (v) => { S.view = v; S.hover = null; $('v-plan').classList.toggle('active', v === 'plan'); $('v-3d').classList.toggle('active', v === '3d');
    $('m-edit').disabled = $('m-parcel').disabled = v === '3d'; hint(); };
  const setMode = (m) => { S.mode = m; $('m-edit').classList.toggle('active', m === 'edit'); $('m-parcel').classList.toggle('active', m === 'parcel'); hint(); };
  const hint = () => { $('hint').textContent = S.view === '3d' ? 'drag → orbit · edit systems in Plan' : S.mode === 'parcel' ? 'click → drop a parcel at rest · drag H/L · scroll or ↑↓ → central pressure' : 'drag H/L · scroll or ↑↓ → central pressure · drag off the edge → remove · hover → force balance'; };
  function syncSel() {
    const o = S.sys[S.sel], on = !!o;
    $('b-del').disabled = !on; $('s-p').disabled = $('s-r').disabled = !on;
    if (on) { $('s-p').value = Math.round(1013 + o.A / 100); $('s-r').value = Math.round(o.sig / NM / 5) * 5; }
    $('s-p-val').innerHTML = on ? `${Math.round(1013 + o.A / 100)} <span class="u">hPa · ${o.A < 0 ? 'low' : 'high'}</span>` : '—';
    $('s-r-val').innerHTML = on ? `${Math.round(o.sig / NM)} <span class="u">nm</span>` : '—';
  }
  function syncAir() {
    const f = coriolis(), k = kSfc(), cross = Math.atan2(k, Math.abs(f)) * 180 / Math.PI;
    $('c-lat-val').innerHTML = `${Math.abs(S.lat)}° ${S.lat < 0 ? 'S' : S.lat > 0 ? 'N' : ''}`.trim();
    $('c-fric-val').innerHTML = S.fric === 0 ? 'none <span class="u">· aloft</span>' : `${(k * 1e4).toFixed(2)} <span class="u">×10⁻⁴ s⁻¹ · ${Math.round(cross)}° across</span>`;
    $('c-speed-val').innerHTML = `×${S.speed.toFixed(1)} <span class="u">· ${hmsLabel()}</span>`;
  }
  $('v-plan').onclick = () => setView('plan'); $('v-3d').onclick = () => setView('3d');
  $('m-edit').onclick = () => setMode('edit'); $('m-parcel').onclick = () => setMode('parcel');
  $('b-clear').onclick = () => { S.parcels = []; };
  const addSys = (hpa) => { S.sys.push(mkSys((Math.random() - .5) * .6, (Math.random() - .5) * .6, hpa, 450)); S.sel = S.sys.length - 1; syncSel(); };
  $('b-addH').onclick = () => addSys(14); $('b-addL').onclick = () => addSys(-14);
  $('b-del').onclick = () => { if (S.sel >= 0) { S.sys.splice(S.sel, 1); S.sel = -1; syncSel(); } };
  $('p-preset').onchange = (e) => loadPreset(e.target.value);
  $('s-p').oninput = (e) => { const o = S.sys[S.sel]; if (!o) return; let A = (parseFloat(e.target.value) - 1013) * 100; if (Math.abs(A) < 100) A = o.A < 0 ? -100 : 100; o.A = A; syncSel(); };
  $('s-r').oninput = (e) => { const o = S.sys[S.sel]; if (o) { o.sig = parseFloat(e.target.value) * NM; syncSel(); } };
  $('c-lat').oninput = (e) => { S.lat = parseFloat(e.target.value); syncAir(); };
  $('c-fric').oninput = (e) => { S.fric = parseFloat(e.target.value); syncAir(); };
  $('c-speed').oninput = (e) => { S.speed = parseFloat(e.target.value); syncAir(); };
  $('c-band').onchange = (e) => { S.band = e.target.value; S.tr3 = []; };
  for (const k of ['iso', 'tint', 'tracers', 'barbs', 'curv']) $('o-' + k).onchange = (e) => { S[k] = e.target.checked; };

  window.addEventListener('resize', resize);
  resize(); loadPreset('pair'); syncAir(); hint(); setView('plan');
  S.raf = requestAnimationFrame(tick);
  window.PRESSURE_DEBUG = { state: S, field, wind, wind3, wBL };
})();
