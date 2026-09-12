// tunnel-model.js — a 2-D wind tunnel: lattice Boltzmann (D2Q9), BGK collision (the TRT
// split is in place with Λ as an option, but with bounce-back bodies at τ → 0.5 every
// Λ ≠ τ² blew up where BGK ran — tested to Re 5,000, α 25°, flap 40°, a cylinder at 1,000),
// half-way bounce-back on the body, fixed-velocity inlet / top / bottom with an 8-cell viscous
// sponge, zero-gradient outlet behind a 16-cell sponge. Lift and drag by momentum exchange
// at the wall. No DOM.
//   node js/tunnel-model.js [MPTT|plate|cyl] [alpha] [steps] [Re]   → Cl / Cd every 500 steps
// Lattice units throughout: cell = 1, step = 1, ρ∞ = 1, U∞ = u0 (0.1 → Mach 0.17).
// Pressure p = ρ/3, so Cp = (ρ − 1) / (1.5 u0²).
(function (root) {
  'use strict';
  const EX = [0, 1, 0, -1, 0, 1, -1, -1, 1];
  const EY = [0, 0, 1, 0, -1, 1, 1, -1, -1];
  const WT = [4 / 9, 1 / 9, 1 / 9, 1 / 9, 1 / 9, 1 / 36, 1 / 36, 1 / 36, 1 / 36];
  const OPP = [0, 3, 4, 1, 2, 7, 8, 5, 6];
    const D2R = Math.PI / 180;

  // ---------------------------------------------------------------- geometry
  // NACA 4-digit camber line (m, p in fractions) with a plain flap hinged at xh, deflected d rad
  // (positive = trailing edge down). Returns {y, dy} of the camber line at chord fraction x.
  function camberAt(x, m, p, xh, d) {
    let yc, dyc;
    if (m <= 0 || p <= 0) { yc = 0; dyc = 0; }
    else if (x < p) { yc = m / (p * p) * (2 * p * x - x * x); dyc = 2 * m / (p * p) * (p - x); }
    else { yc = m / ((1 - p) * (1 - p)) * ((1 - 2 * p) + 2 * p * x - x * x); dyc = 2 * m / ((1 - p) * (1 - p)) * (p - x); }
    if (d !== 0 && x > xh) {
      const h = camberAt(xh, m, p, xh, 0);
      const dx = x - xh, dy = yc - h.y, c = Math.cos(d), s = Math.sin(d);
      // rotate the aft camber line about the hinge, clockwise for a positive (down) deflection
      return { x: xh + dx * c + dy * s, y: h.y - dx * s + dy * c, dy: Math.tan(Math.atan(dyc) - d) };
    }
    return { x, y: yc, dy: dyc };
  }
  function thicknessAt(x, t) {
    return 5 * t * (0.2969 * Math.sqrt(x) - 0.1260 * x - 0.3516 * x * x + 0.2843 * x * x * x - 0.1036 * x * x * x * x);
  }
  // Airfoil outline in chord units, LE at (0,0), chord along +x, y up: [{x, y, s, up}] going
  // TE → upper → LE → lower → TE. kind 'cylinder' returns a circle of diameter `dia` chords.
  function outline(sh) {
    const pts = [];
    if (sh.kind === 'cylinder') {
      const r = (sh.dia || 0.3) / 2, n = 120;
      for (let k = 0; k < n; k++) { const a = Math.PI / 2 - k * 2 * Math.PI / n; const x = 0.25 + r * Math.cos(a), y = r * Math.sin(a); pts.push({ x, y, s: (x - 0.25 + r) / (2 * r), up: y >= 0 }); }
      return pts;
    }
    const m = sh.kind === 'plate' ? 0 : sh.m / 100, p = sh.p / 100, t = sh.kind === 'plate' ? 0.03 : sh.t / 100;
    const d = (sh.flap || 0) * D2R, xh = 0.7, n = 90;
    const up = [], lo = [];
    for (let k = 0; k <= n; k++) {
      const x = 0.5 * (1 - Math.cos(Math.PI * k / n));          // cosine spacing, dense at the LE
      const c = camberAt(x, m, p, xh, d), yt = thicknessAt(x, t), th = Math.atan(c.dy);
      up.push({ x: c.x - yt * Math.sin(th), y: c.y + yt * Math.cos(th), s: x, up: true });
      lo.push({ x: c.x + yt * Math.sin(th), y: c.y - yt * Math.cos(th), s: x, up: false });
    }
    for (let k = n; k >= 0; k--) pts.push(up[k]);
    for (let k = 1; k <= n; k++) pts.push(lo[k]);
    return pts;
  }
  // Thin-airfoil zero-lift angle (radians) of the camber line, flap included.
  function alphaL0(sh) {
    if (sh.kind === 'cylinder') return 0;
    const m = sh.kind === 'plate' ? 0 : sh.m / 100, p = sh.p / 100, d = (sh.flap || 0) * D2R;
    const n = 400; let sum = 0;
    for (let k = 0; k < n; k++) {
      const th = (k + 0.5) * Math.PI / n, x = 0.5 * (1 - Math.cos(th));
      sum += camberAt(x, m, p, 0.7, d).dy * (Math.cos(th) - 1);
    }
    return -sum * (Math.PI / n) / Math.PI;
  }

  // Outline in lattice coordinates: chord `chord` cells, quarter-chord at `pivot`, pitched
  // nose-up by shape.alpha (degrees), y up.
  function placeOutline(sh, chord, pivot) {
    const a = (sh.alpha || 0) * D2R, ca = Math.cos(a), sa = Math.sin(a), px = pivot[0], py = pivot[1];
    return outline(sh).map(q => {
      const x = (q.x - 0.25) * chord, y = q.y * chord;         // relative to the quarter chord
      return { x: px + x * ca + y * sa, y: py - x * sa + y * ca, s: q.s, up: q.up };
    });
  }
  // Scanline-fill the polygon into a nx×ny Uint8Array mask (cell centres at integer coords).
  function rasterize(poly, nx, ny, solid) {
    solid.fill(0);
    const n = poly.length, xs = [];
    for (let y = 1; y < ny - 1; y++) {
      xs.length = 0;
      for (let k = 0; k < n; k++) {
        const a1 = poly[k], a2 = poly[(k + 1) % n];
        if ((a1.y <= y) === (a2.y <= y)) continue;
        xs.push(a1.x + (y - a1.y) * (a2.x - a1.x) / (a2.y - a1.y));
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const x0 = Math.max(1, Math.ceil(xs[k])), x1 = Math.min(nx - 2, Math.floor(xs[k + 1]));
        for (let x = x0; x <= x1; x++) solid[y * nx + x] = 1;
      }
    }
    return solid;
  }
  const pivotFor = (nx, ny) => [Math.round(nx * 0.30), Math.round(ny / 2)];

  // ---------------------------------------------------------------- the tunnel
  class Tunnel {
    constructor(opts = {}) {
      this.nx = opts.nx || 400; this.ny = opts.ny || 220;
      this.u0 = opts.u0 || 0.1;
      this.chord = opts.chord || 90;
      this.pivot = pivotFor(this.nx, this.ny);   // the quarter-chord point
      const N = this.N = this.nx * this.ny;
      this.f = []; for (let i = 0; i < 9; i++) this.f.push(new Float32Array(N));
      this.rho = new Float32Array(N); this.ux = new Float32Array(N); this.uy = new Float32Array(N);
      this.solid = new Uint8Array(N);
      this.bnodes = new Int32Array(0);
      this.surf = []; this.sep = []; this.poly = []; this.refLen = this.chord;
      this.shape = Object.assign({ kind: 'naca', m: 2, p: 40, t: 12, alpha: 4, flap: 0, dia: 0.3 }, opts.shape || {});
      this.hist = new Float32Array(3000); this.histD = new Float32Array(3000); this.histN = 0;
      this.t = 0; this.fx = 0; this.fy = 0; this.unstable = false;
      this._re = opts.re || 1000; this.lambda = opts.lambda;
      // sponge profiles: 1 at the wall, 0 past `sp` cells in (outlet sponge twice as deep)
      const sp = this.spW = opts.sponge || 8;
      this.spx = new Float32Array(this.nx); this.spy = new Float32Array(this.ny);
      for (let x = 0; x < this.nx; x++) this.spx[x] = Math.max(Math.max(0, 1 - x / sp), Math.max(0, 1 - (this.nx - 1 - x) / (2 * sp)));
      for (let y = 0; y < this.ny; y++) this.spy[y] = Math.max(Math.max(0, 1 - y / sp), Math.max(0, 1 - (this.ny - 1 - y) / sp));
      this.setShape(this.shape);
      this.reset();
    }
    get re() { return this._re; }
    setReynolds(re) { this._re = re; this.setViscosity(this.u0 * this.refLen / re); }
    setViscosity(nu) {
      this.nu = nu;
      const lam = this.lambda || 0;
      const tp = 3 * nu + 0.5, tm = lam > 0 ? 0.5 + lam / (tp - 0.5) : tp;   // Λ > 0 → TRT, else BGK
      this.wp = 1 / tp; this.wm = 1 / tm;
    }
    // Place the body: rasterise the outline (rotated nose-up by alpha about the pivot) into the
    // solid mask, list the boundary solid nodes, the surface fluid samples (Cp) and the
    // separation probes. The flow is kept — pitching a running tunnel is the point.
    setShape(sh) {
      Object.assign(this.shape, sh);
      const s = this.shape, { nx, ny, chord } = this;
      this.refLen = s.kind === 'cylinder' ? chord * (s.dia || 0.3) : chord;
      this.setViscosity(this.u0 * this.refLen / this._re);
      const poly = this.poly = placeOutline(s, chord, this.pivot);
      const solid = this.solid, n = poly.length;
      rasterize(poly, nx, ny, solid);
      // boundary solid nodes + surface fluid samples
      const bn = [], surf = [];
      for (let y = 1; y < ny - 1; y++) for (let x = 1; x < nx - 1; x++) {
        const i = y * nx + x, me = solid[i];
        let mixed = false;
        for (let d = 1; d < 9 && !mixed; d++) if (solid[i + EY[d] * nx + EX[d]] !== me) mixed = true;
        if (!mixed) continue;
        if (me) { bn.push(i); this.ux[i] = 0; this.uy[i] = 0; }
        else {
          let best = 1e9, bq = null;
          for (let k = 0; k < n; k++) { const q = poly[k], dd = (q.x - x) * (q.x - x) + (q.y - y) * (q.y - y); if (dd < best) { best = dd; bq = q; } }
          surf.push({ i, s: bq.s, up: bq.up });
        }
      }
      this.bnodes = Int32Array.from(bn); this.surf = surf;
      for (let i = 0; i < this.N; i++) if (solid[i]) { this.ux[i] = 0; this.uy[i] = 0; }
      // separation probes: upper surface, 3 cells out along the outward normal
      const cx = poly.reduce((t, q) => t + q.x, 0) / n, cy = poly.reduce((t, q) => t + q.y, 0) / n;
      const sep = [];
      for (let st = 0.05; st < 0.99; st += 0.05) {
        let best = 1e9, bk = -1;
        for (let k = 0; k < n; k++) if (poly[k].up && Math.abs(poly[k].s - st) < best) { best = Math.abs(poly[k].s - st); bk = k; }
        if (bk < 1 || bk >= n - 1) continue;
        // upper surface runs TE → LE in the polygon, so the LE→TE tangent is prev − next
        let tx = poly[bk - 1].x - poly[bk + 1].x, ty = poly[bk - 1].y - poly[bk + 1].y;
        const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
        let nxv = -ty, nyv = tx;
        if ((poly[bk].x - cx) * nxv + (poly[bk].y - cy) * nyv < 0) { nxv = -nxv; nyv = -nyv; }
        const X = Math.round(poly[bk].x + 3 * nxv), Y = Math.round(poly[bk].y + 3 * nyv);
        if (X < 1 || X >= nx - 1 || Y < 1 || Y >= ny - 1) continue;
        sep.push({ i: Y * nx + X, s: st, tx, ty, x: X, y: Y });
      }
      this.sep = sep;
      this.aL0 = alphaL0(s);
    }
    reset() {
      const { f, N, u0 } = this;
      for (let i = 0; i < 9; i++) {
        const eu = EX[i] * u0, v = WT[i] * (1 + 3 * eu + 4.5 * eu * eu - 1.5 * u0 * u0);
        f[i].fill(v);
      }
      this.rho.fill(1); this.ux.fill(u0); this.uy.fill(0);
      for (let i = 0; i < N; i++) if (this.solid[i]) { this.ux[i] = 0; this.uy[i] = 0; }
      this.t = 0; this.histN = 0; this.fx = 0; this.fy = 0; this.unstable = false;
    }
    equilibriumInto(i, rho, ux, uy) {
      const eu = EX[i] * ux + EY[i] * uy;
      return WT[i] * rho * (1 + 3 * eu + 4.5 * eu * eu - 1.5 * (ux * ux + uy * uy));
    }
    step(n = 1) { for (let k = 0; k < n; k++) this._step(); }
    // TRT collision over cells [i0, i1) with the given even / odd rates.
    collide(i0, i1, wp, wm) {
      const { f, solid, rho, ux, uy } = this;
      const f0 = f[0], f1 = f[1], f2 = f[2], f3 = f[3], f4 = f[4], f5 = f[5], f6 = f[6], f7 = f[7], f8 = f[8];
      for (let i = i0; i < i1; i++) {
        if (solid[i]) continue;
        const a0 = f0[i], a1 = f1[i], a2 = f2[i], a3 = f3[i], a4 = f4[i], a5 = f5[i], a6 = f6[i], a7 = f7[i], a8 = f8[i];
        const r = a0 + a1 + a2 + a3 + a4 + a5 + a6 + a7 + a8;
        const vx = (a1 - a3 + a5 - a6 - a7 + a8) / r, vy = (a2 - a4 + a5 + a6 - a7 - a8) / r;
        rho[i] = r; ux[i] = vx; uy[i] = vy;
        const usq = 1.5 * (vx * vx + vy * vy), r9 = r / 9, r36 = r / 36;
        f0[i] = a0 - wp * (a0 - 4 * r9 * (1 - usq));
        // pair (1,3): e = (±1, 0)
        let ep = r9 * (1 + 4.5 * vx * vx - usq), em = r9 * 3 * vx, fp = 0.5 * (a1 + a3), fm = 0.5 * (a1 - a3);
        let dp = wp * (fp - ep), dm = wm * (fm - em);
        f1[i] = a1 - dp - dm; f3[i] = a3 - dp + dm;
        // pair (2,4): e = (0, ±1)
        ep = r9 * (1 + 4.5 * vy * vy - usq); em = r9 * 3 * vy; fp = 0.5 * (a2 + a4); fm = 0.5 * (a2 - a4);
        dp = wp * (fp - ep); dm = wm * (fm - em);
        f2[i] = a2 - dp - dm; f4[i] = a4 - dp + dm;
        // pair (5,7): e = ±(1, 1)
        let eu = vx + vy;
        ep = r36 * (1 + 4.5 * eu * eu - usq); em = r36 * 3 * eu; fp = 0.5 * (a5 + a7); fm = 0.5 * (a5 - a7);
        dp = wp * (fp - ep); dm = wm * (fm - em);
        f5[i] = a5 - dp - dm; f7[i] = a7 - dp + dm;
        // pair (6,8): e = ±(−1, 1)
        eu = -vx + vy;
        ep = r36 * (1 + 4.5 * eu * eu - usq); em = r36 * 3 * eu; fp = 0.5 * (a6 + a8); fm = 0.5 * (a6 - a8);
        dp = wp * (fp - ep); dm = wm * (fm - em);
        f6[i] = a6 - dp - dm; f8[i] = a8 - dp + dm;
      }
    }
    _step() {
      const { nx, ny, N, f, solid, rho, ux, uy, wp, wm, u0 } = this;
      const f0 = f[0], f1 = f[1], f2 = f[2], f3 = f[3], f4 = f[4], f5 = f[5], f6 = f[6], f7 = f[7], f8 = f[8];
      // ---- collide (TRT). Near the fixed-velocity walls and the outlet both rates blend
      // toward 1 (a viscous sponge): the equilibrium boundaries otherwise pump TRT's slowly
      // relaxing odd modes at the inlet corners until the run blows up. Interior rows run the
      // bulk as one call so the hot loop stays tight.
      const spx = this.spx, spy = this.spy, S = this.spW, S2 = 2 * this.spW;
      for (let y = 0; y < ny; y++) {
        const sy = spy[y], row = y * nx;
        if (sy > 0) {
          for (let x = 0; x < nx; x++) { const sp = sy > spx[x] ? sy : spx[x]; this.collide(row + x, row + x + 1, wp + (1 - wp) * sp, wm + (1 - wm) * sp); }
        } else {
          for (let x = 0; x < S; x++) this.collide(row + x, row + x + 1, wp + (1 - wp) * spx[x], wm + (1 - wm) * spx[x]);
          this.collide(row + S, row + nx - S2, wp, wm);
          for (let x = nx - S2; x < nx; x++) this.collide(row + x, row + x + 1, wp + (1 - wp) * spx[x], wm + (1 - wm) * spx[x]);
        }
      }
      // ---- stream: each direction is one memmove; the wrapped cells land in the inlet /
      // outlet columns, which the boundary pass overwrites.
      f1.copyWithin(1, 0, N - 1);
      f3.copyWithin(0, 1, N);
      f2.copyWithin(nx, 0, N - nx);
      f4.copyWithin(0, nx, N);
      f5.copyWithin(nx + 1, 0, N - nx - 1);
      f6.copyWithin(nx - 1, 0, N - nx + 1);
      f7.copyWithin(0, nx + 1, N);
      f8.copyWithin(0, nx - 1, N);
      // ---- bounce-back on the body + momentum exchange
      let fx = 0, fy = 0;
      const bn = this.bnodes;
      for (let k = 0; k < bn.length; k++) {
        const b = bn[k];
        for (let d = 1; d < 9; d++) {
          const src = b - EY[d] * nx - EX[d];
          if (solid[src]) continue;
          const v = f[d][b];
          f[OPP[d]][src] = v;
          fx += 2 * EX[d] * v; fy += 2 * EY[d] * v;
        }
      }
      this.fx = fx; this.fy = fy;
      // ---- boundaries: inlet + top + bottom at freestream equilibrium, outlet zero-gradient
      for (let d = 0; d < 9; d++) {
        const eu = EX[d] * u0, v = WT[d] * (1 + 3 * eu + 4.5 * eu * eu - 1.5 * u0 * u0), fd = f[d];
        for (let y = 0; y < ny; y++) { fd[y * nx] = v; fd[y * nx + nx - 1] = fd[y * nx + nx - 2]; }
        for (let x = 0; x < nx; x++) { fd[x] = v; fd[(ny - 1) * nx + x] = v; }
      }
      // ---- bookkeeping
      const q = 0.5 * this.u0 * this.u0 * this.refLen;
      const cl = fy / q, cd = fx / q;
      this.hist[this.histN % this.hist.length] = cl; this.histD[this.histN % this.hist.length] = cd; this.histN++;
      this.t++;
      if (!(cl === cl) || Math.abs(cl) > 50) this.unstable = true;
    }
    // Mean Cl / Cd over the last n steps (the shedding wobble averaged out).
    mean(n = 600) {
      const L = this.hist.length, m = Math.min(n, this.histN);
      if (m === 0) return { cl: 0, cd: 0, n: 0 };
      let sl = 0, sd = 0;
      for (let k = 1; k <= m; k++) { const j = (this.histN - k + L) % L; sl += this.hist[j]; sd += this.histD[j]; }
      return { cl: sl / m, cd: sd / m, n: m };
    }
    get cl() { return this.fy / (0.5 * this.u0 * this.u0 * this.refLen); }
    get cd() { return this.fx / (0.5 * this.u0 * this.u0 * this.refLen); }
    cp(i) { return (this.rho[i] - 1) / (1.5 * this.u0 * this.u0); }
    // Cp along the chord: {up:[{s,cp}], lo:[...]} binned every 2 % chord.
    cpCurve(bins = 50) {
      const up = new Float64Array(bins), lo = new Float64Array(bins), nu = new Int32Array(bins), nl = new Int32Array(bins);
      for (const q of this.surf) {
        const b = Math.min(bins - 1, Math.max(0, Math.floor(q.s * bins))), c = this.cp(q.i);
        if (q.up) { up[b] += c; nu[b]++; } else { lo[b] += c; nl[b]++; }
      }
      const U = [], Lo = [];
      for (let b = 0; b < bins; b++) { const s = (b + 0.5) / bins; if (nu[b]) U.push({ s, cp: up[b] / nu[b] }); if (nl[b]) Lo.push({ s, cp: lo[b] / nl[b] }); }
      return { up: U, lo: Lo };
    }
    // Chord fraction where the upper-surface flow first runs backwards (two probes in a row), or null.
    separation() {
      const p = this.sep; let first = null;
      for (let k = 0; k < p.length; k++) {
        const a = p[k], rev = this.ux[a.i] * a.tx + this.uy[a.i] * a.ty < 0;
        if (!rev) { first = null; continue; }
        if (first === null) first = a.s;
        if (k + 1 < p.length) { const b = p[k + 1]; if (this.ux[b.i] * b.tx + this.uy[b.i] * b.ty < 0) return first; }
        else return first;
      }
      return null;
    }
    // Bilinear velocity at a real-valued point (lattice coords).
    velAt(x, y) {
      const { nx, ny, ux, uy } = this;
      if (x < 0 || y < 0 || x >= nx - 1 || y >= ny - 1) return null;
      const x0 = x | 0, y0 = y | 0, tx = x - x0, ty = y - y0, i = y0 * nx + x0;
      const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty;
      return { ux: ux[i] * w00 + ux[i + 1] * w10 + ux[i + nx] * w01 + ux[i + nx + 1] * w11, uy: uy[i] * w00 + uy[i + 1] * w10 + uy[i + nx] * w01 + uy[i + nx + 1] * w11 };
    }
    // Vorticity (∂uy/∂x − ∂ux/∂y) into `out`, central differences.
    curl(out) {
      const { nx, ny, ux, uy } = this;
      out.fill(0);
      for (let y = 1; y < ny - 1; y++) for (let x = 1; x < nx - 1; x++) {
        const i = y * nx + x;
        out[i] = 0.5 * (uy[i + 1] - uy[i - 1]) - 0.5 * (ux[i + nx] - ux[i - nx]);
      }
      return out;
    }
  }
  Tunnel.outline = outline; Tunnel.alphaL0 = alphaL0; Tunnel.placeOutline = placeOutline;
  Tunnel.rasterize = rasterize; Tunnel.pivotFor = pivotFor; Tunnel.EX = EX; Tunnel.EY = EY;

  if (typeof module !== 'undefined' && module.exports) module.exports = Tunnel;
  if (root) root.Tunnel = Tunnel;

  // ---------------------------------------------------------------- headless run
  if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
    const arg = process.argv.slice(2);
    const code = arg[0] || '2412', alpha = +(arg[1] || 4), steps = +(arg[2] || 4000), re = +(arg[3] || 1000);
    const shape = code === 'plate' ? { kind: 'plate' } : code === 'cyl' ? { kind: 'cylinder' } :
      { kind: 'naca', m: +code[0], p: +code[1] * 10, t: +code.slice(2) };
    shape.alpha = alpha;
    const T = new Tunnel({ shape, re });
    console.log(`NACA ${code}  α ${alpha}°  Re ${T.re.toFixed(0)}  ν ${T.nu.toFixed(4)}  τ+ ${(1 / T.wp).toFixed(3)}  τ- ${(1 / T.wm).toFixed(3)}  solid ${T.bnodes.length} boundary nodes  αL0 ${(T.aL0 / D2R).toFixed(2)}°  2π(α−αL0) = ${(2 * Math.PI * (alpha * D2R - T.aL0)).toFixed(3)}`);
    const t0 = Date.now();
    for (let k = 0; k < steps; k += 500) {
      T.step(500);
      const m = T.mean(500), sep = T.separation();
      let umax = 0; for (let i = 0; i < T.N; i++) { const s = T.ux[i] * T.ux[i] + T.uy[i] * T.uy[i]; if (s > umax) umax = s; }
      console.log(`t ${String(T.t).padStart(5)}  Cl ${m.cl.toFixed(3)}  Cd ${m.cd.toFixed(3)}  L/D ${(m.cl / m.cd).toFixed(1)}  sep ${sep === null ? '—' : sep.toFixed(2)}  |u|max ${(Math.sqrt(umax) / T.u0).toFixed(2)} U  ${T.unstable ? 'UNSTABLE' : ''}`);
      if (T.unstable) break;
    }
    const ms = Date.now() - t0;
    console.log(`${steps} steps in ${ms} ms → ${(ms / steps).toFixed(2)} ms/step`);
  }
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : null);
