// storm-model.js — the physics behind storm.html (Thunderstorm Lab).
// A 2-D (x–z) anelastic cloud model on a 160 × 64 grid, 250 m cells,
// 40 km × 16 km, 5 s steps. No DOM: the same file runs under Node for tuning
// (`node js/storm-model.js` steps a preset and prints the diagnostics).
//
// Dynamics ...... semi-Lagrangian advection (Stam), buoyancy from θ' + vapor −
//                 water loading, pressure projection ∇·(ρ̄ ∇φ) = ∇·(ρ̄ u),
//                 rigid lid + top sponge, lateral nudging to the environment,
//                 storm-relative frame (the mean 0–6 km wind is subtracted).
// Microphysics .. Kessler warm rain (saturation adjustment, autoconversion,
//                 accretion, rain evaporation, K–W fall speed) plus a mixed-phase
//                 branch: cloud water freezing by temperature, WBF (Bergeron)
//                 growth of ice at the expense of liquid, riming ice → graupel,
//                 rain freezing, graupel dry growth, melting, sublimation and
//                 deposition. Latent heat of vaporisation, fusion and
//                 sublimation all feed back on θ'.
// Electrification non-inductive graupel–ice charging in the presence of
//                 supercooled water, sign flipping at −15 °C (graupel negative
//                 colder than that); charge rides its carrier (graupel / ice /
//                 rain, handed over at melting and riming). E from the charge
//                 field treated as 3-D point charges of an 8 km-deep slab with
//                 an image below a conducting ground; a bidirectional leader
//                 walk from the cell that first exceeds the initiation field
//                 decides IC vs CG and neutralises charge along the channel.
// Not modelled .. rotation (2-D has none, so no supercells), entrainment beyond
//                 numerical mixing, radiation, size spectra.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StormModel = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---- constants -------------------------------------------------------
  const G = 9.81, CP = 1004.0, RD = 287.04, RV = 461.5, EPS = 0.622;
  const LV = 2.501e6, LF = 3.34e5, LS = LV + LF, P0 = 1e5, KAPPA = RD / CP;
  const T0 = 273.15;

  const NX = 128, NZ = 64, DX = 312.5, DZ = 250, DT = 5;   // NX a power of two: the pressure solve is an FFT in x
  const LX = NX * DX, LZ = NZ * DZ, N = NX * NZ;
  const ESTEP = 4;               // E-field solve every 4 steps (20 s)
  const LY = 8000;               // assumed depth of the storm slab for E (m)
  const K_COUL = 8.988e9;
  const VI = 0.6;                // cloud-ice fall speed m/s

  function es(Tc) { return 611.2 * Math.exp(17.67 * Tc / (Tc + 243.5)); }
  function esi(Tc) { return 611.2 * Math.exp(22.46 * Tc / (Tc + 272.62)); }
  function qsat(e, p) { return EPS * e / Math.max(p - e, 1); }
  function tdew(qv, p) {           // °C from mixing ratio and pressure
    const e = Math.max(qv * p / (EPS + qv), 1e-3);
    const l = Math.log(e / 611.2);
    return 243.5 * l / (17.67 - l);
  }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  const PRESETS = {
    pulse:     { name: 'Pulse (airmass)',  ts: 31, td: 21, ml: 1000, lapse: 6.8, cap: 0.5, rhmid: 60, shear: 3,  usfc: 2, heat: 250, chg: 1, bubble: true },
    multicell: { name: 'Multicell',        ts: 30, td: 20, ml: 1200, lapse: 7.2, cap: 1.2, rhmid: 45, shear: 14, usfc: 3, heat: 220, chg: 1, bubble: true },
    sheared:   { name: 'Strong shear',     ts: 31, td: 21, ml: 1200, lapse: 7.5, cap: 2.0, rhmid: 40, shear: 26, usfc: 4, heat: 180, chg: 1, bubble: true },
    capped:    { name: 'Capped',           ts: 33, td: 21, ml: 800,  lapse: 6.6, cap: 4.5, rhmid: 35, shear: 10, usfc: 3, heat: 250, chg: 1, bubble: true },
    dry:       { name: 'High-based · dry', ts: 36, td: 6,  ml: 3200, lapse: 8.6, cap: 0.0, rhmid: 30, shear: 6,  usfc: 3, heat: 400, chg: 1, bubble: true },
    stable:    { name: 'Stable',           ts: 22, td: 13, ml: 500,  lapse: 5.5, cap: 1.0, rhmid: 50, shear: 8,  usfc: 3, heat: 150, chg: 1, bubble: true },
  };

  class StormModel {
    constructor() {
      const F = () => new Float32Array(N);
      // staggered (MAC) grid: u on x-faces (i+½,k), wf on z-faces (i,j−½), j = 0..NZ
      this.u = F(); this.wf = new Float32Array(NX * (NZ + 1)); this.uc = F(); this.wc = F();
      this.th = F(); this.qv = F();
      this.qc = F(); this.qr = F(); this.qi = F(); this.qg = F();
      this.cg = F(); this.ci = F(); this.cr = F();      // charge densities C/m³
      this.vr = F(); this.vg = F();                      // fall speeds
      this.tmp = F(); this.tmp2 = new Float32Array(NX * (NZ + 1)); this.tmpW = new Float32Array(NX * (NZ + 1));
      this.fftInit();
      this.ex = F(); this.ez = F(); this.em = F();       // E field (fine grid)
      // base state per level
      const L = () => new Float32Array(NZ);
      this.z = L(); this.pb = L(); this.tb = L(); this.thb = L(); this.qvb = L();
      this.rho = L(); this.pi = L(); this.uenv = L(); this.tdb = L();
      this.heatNoise = new Float32Array(NX);
      this.rainRate = new Float32Array(NX);   // mm/h at the ground per column
      this.hailRate = new Float32Array(NX);
      this.eGround = new Float32Array(NX);    // V/m at the ground
      this.t = 0; this.stepCount = 0;
      this.flashes = [];            // all flashes (pts in metres)
      this.newFlashes = [];         // queue for the UI
      this.probe = { x: 12000, z: 6000 };
      this.probeDiag = {};
      this.diag = {};
      this.eMax = 0; this.eMaxAt = null;
      this.rng = Math.random;
      this.setParams(Object.assign({}, PRESETS.pulse));
    }

    // ---- environment -------------------------------------------------
    setParams(P) {
      this.P = Object.assign({}, P);
      this.buildEnv();
      this.reset();
    }

    buildEnv() {
      const P = this.P;
      const dzf = 50, nf = Math.round(LZ / dzf) + 1;
      const Tf = new Float64Array(nf), pf = new Float64Array(nf), qf = new Float64Array(nf);
      const ztp = 12000, capz = 300;
      const Ts = P.ts + T0, Tml = Ts - 9.8e-3 * P.ml;
      const Tat = z => {
        let T;
        if (z <= P.ml) T = Ts - 9.8e-3 * z;
        else if (z < P.ml + capz) T = Tml + P.cap * (z - P.ml) / capz;
        else T = Tml + P.cap - P.lapse * 1e-3 * (z - P.ml - capz);
        return T;
      };
      let Ttp = Tat(ztp);
      for (let j = 0; j < nf; j++) { const z = j * dzf; Tf[j] = z < ztp ? Tat(z) : Ttp; }
      // moisture (needs p; iterate twice with hydrostatics)
      const ps = 1e5;
      const qml = qsat(es(P.td), ps);
      for (let pass = 0; pass < 2; pass++) {
        pf[0] = ps;
        for (let j = 1; j < nf; j++) {
          const Tv0 = Tf[j - 1] * (1 + 0.61 * (pass ? qf[j - 1] : 0));
          const Tv1 = Tf[j] * (1 + 0.61 * (pass ? qf[j] : 0));
          pf[j] = pf[j - 1] * Math.exp(-G * dzf / (RD * 0.5 * (Tv0 + Tv1)));
        }
        let rhTop = 0.7;
        for (let j = 0; j < nf; j++) {
          const z = j * dzf, Tc = Tf[j] - T0, qs = qsat(es(Tc), pf[j]);
          let q;
          if (z <= P.ml) { q = Math.min(qml, 0.98 * qs); rhTop = q / qs; }
          else {
            let rh;
            const rm = P.rhmid / 100;
            if (z < 3500) rh = rhTop + (rm - rhTop) * (z - P.ml) / Math.max(3500 - P.ml, 1);
            else if (z < 6000) rh = rm;
            else if (z < 10000) rh = rm + (0.25 - rm) * (z - 6000) / 4000;
            else if (z < ztp) rh = 0.25 + (0.05 - 0.25) * (z - 10000) / (ztp - 10000);
            else rh = 0.03;
            q = clamp(rh, 0.02, 0.98) * qs;
          }
          qf[j] = q;
        }
      }
      // sample to levels
      for (let k = 0; k < NZ; k++) {
        const z = (k + 0.5) * DZ, j = z / dzf, j0 = Math.floor(j), f = j - j0, j1 = Math.min(j0 + 1, nf - 1);
        this.z[k] = z;
        this.tb[k] = Tf[j0] * (1 - f) + Tf[j1] * f;
        this.pb[k] = pf[j0] * (1 - f) + pf[j1] * f;
        this.qvb[k] = qf[j0] * (1 - f) + qf[j1] * f;
        this.pi[k] = Math.pow(this.pb[k] / P0, KAPPA);
        this.thb[k] = this.tb[k] / this.pi[k];
        this.rho[k] = this.pb[k] / (RD * this.tb[k] * (1 + 0.61 * this.qvb[k]));
        this.tdb[k] = tdew(this.qvb[k], this.pb[k]) + T0;
      }
      // winds: unidirectional shear over 0–6 km; frame moves with the 0–6 km mean
      const uAt = z => P.usfc + P.shear * Math.min(z, 6000) / 6000;
      this.us = P.usfc + P.shear * 0.5;
      for (let k = 0; k < NZ; k++) this.uenv[k] = uAt(this.z[k]) - this.us;
      this.envFine = { dz: dzf, T: Tf, p: pf, q: qf };
      this.parcel = this.liftParcel(Ts, qml);
      // isotherm heights (environment)
      this.isoZ = {};
      for (const tc of [0, -15, -40]) this.isoZ[tc] = this.heightOfT(T0 + tc);
    }

    heightOfT(T) {
      const { dz, T: Tf } = this.envFine;
      for (let j = 1; j < Tf.length; j++) if (Tf[j] <= T && Tf[j - 1] > T) {
        return dz * (j - 1 + (Tf[j - 1] - T) / (Tf[j - 1] - Tf[j]));
      }
      return null;
    }

    // surface-based parcel, pseudo-adiabatic, 50 m steps
    liftParcel(thp, qp) {
      const { dz, T: Tf, p: pf, q: qf } = this.envFine;
      const nf = Tf.length, Tp = new Float64Array(nf), buoy = new Float64Array(nf);
      let lcl = null, lfc = null, el = null, cape = 0, cin = 0, sat = false, T = thp, tlcl = null;
      for (let j = 0; j < nf; j++) {
        const p = pf[j], z = j * dz;
        let qpv;
        if (!sat) {
          T = thp * Math.pow(p / P0, KAPPA);
          const qs = qsat(es(T - T0), p);
          if (qs <= qp) { sat = true; lcl = z; tlcl = T; qpv = qs; }
          else qpv = qp;
        } else {
          const qs = qsat(es(T - T0), p);
          const gm = G * (1 + LV * qs / (RD * T)) / (CP + LV * LV * qs * EPS / (RD * T * T));
          T -= gm * dz;
          qpv = qsat(es(T - T0), p);
        }
        Tp[j] = T;
        const b = G * (T * (1 + 0.61 * qpv) - Tf[j] * (1 + 0.61 * qf[j])) / (Tf[j] * (1 + 0.61 * qf[j]));
        buoy[j] = b;
      }
      // CIN/CAPE/LFC/EL from the buoyancy profile above the LCL
      if (lcl != null) {
        const j0 = Math.round(lcl / dz);
        let inCape = false;
        for (let j = j0; j < nf; j++) {
          const b = buoy[j];
          if (!inCape) {
            if (b > 0 && Tp[j] > 150) { inCape = true; if (lfc == null) lfc = j * dz; }
            else cin += Math.min(b, 0) * dz;
          }
          if (inCape) {
            if (b > 0) { cape += b * dz; el = j * dz; }
            else if (j * dz > (lfc || 0) + 1000 && cape > 50) break;   // first EL past a real layer
          }
        }
      }
      if (lfc == null) cin = 0;
      return { Tp, buoy, lcl, lfc, el, cape, cin, tlcl };
    }

    // ---- state ----------------------------------------------------------
    reset() {
      this.u.fill(0); this.wf.fill(0); this.uc.fill(0); this.wc.fill(0); this.th.fill(0);
      this.qc.fill(0); this.qr.fill(0); this.qi.fill(0); this.qg.fill(0);
      this.cg.fill(0); this.ci.fill(0); this.cr.fill(0);
      this.ex.fill(0); this.ez.fill(0); this.em.fill(0); this.eGround.fill(0);
      this.rainRate.fill(0); this.hailRate.fill(0);
      for (let k = 0; k < NZ; k++) for (let i = 0; i < NX; i++) {
        this.qv[k * NX + i] = this.qvb[k]; this.u[k * NX + i] = this.uenv[k];
      }
      for (let i = 0; i < NX; i++) this.heatNoise[i] = 0.75 + 0.5 * this.rng();
      this.t = 0; this.stepCount = 0;
      this.flashes = []; this.newFlashes = [];
      this.nFlash = 0; this.nCG = 0; this.nIC = 0; this.lastFlashT = null;
      this.rainTotalField = 0; this.eMax = 0;
      this.xBubble = 12000;
      this.xField0 = clamp(this.xBubble + Math.max(4000, this.us * 1200), 4000, LX - 4000);
      if (this.P.bubble) { const zb = clamp(0.6 * this.P.ml, 1200, 2200); this.bubble(this.xBubble, zb, this.P.bamp || 3.0, this.P.brx || 5000, zb - 100); }
      this.probe = { x: this.xBubble, z: Math.min(6000, this.isoZ[-15] || 6000) };
      this.diagnose();
    }

    // storm-relative → ground: the field slides under the fixed frame
    xField() { let x = (this.xField0 - this.us * this.t) % LX; if (x < 0) x += LX; return x; }

    bubble(x, z, amp, rx, rz) {
      for (let k = 0; k < NZ; k++) for (let i = 0; i < NX; i++) {
        let dx = Math.abs(i * DX + DX / 2 - x); if (dx > LX / 2) dx = LX - dx;
        const dz = this.z[k] - z, r = Math.sqrt((dx / rx) ** 2 + (dz / rz) ** 2);
        if (r < 1) {
          const n = k * NX + i, f = Math.cos(Math.PI * r / 2) ** 2;
          this.th[n] += amp * f;
          // keep RH roughly what it was as the parcel warms
          const T = (this.thb[k] + this.th[n]) * this.pi[k];
          const qs = qsat(es(T - T0), this.pb[k]);
          this.qv[n] = Math.max(this.qv[n], Math.min(this.qvb[k] / qsat(es(this.tb[k] - T0), this.pb[k]) * qs, 0.98 * qs));
        }
      }
    }

    // ---- numerics -------------------------------------------------------
    // semi-Lagrangian sample; x periodic; hydro fields are 0 outside the column
    sample(src, x, z, hydro) {
      if (x < 0) x += NX; else if (x >= NX) x -= NX;
      const i0 = x | 0, fx = x - i0; let i1 = i0 + 1; if (i1 === NX) i1 = 0;
      if (hydro) {
        if (z <= -1 || z >= NZ) return 0;
        const k0 = Math.floor(z), fz = z - k0, k1 = k0 + 1;
        const a = k0 >= 0 ? src[k0 * NX + i0] * (1 - fx) + src[k0 * NX + i1] * fx : 0;
        const b = k1 < NZ ? src[k1 * NX + i0] * (1 - fx) + src[k1 * NX + i1] * fx : 0;
        return a * (1 - fz) + b * fz;
      }
      if (z < 0) z = 0; else if (z > NZ - 1) z = NZ - 1;
      let k0 = z | 0; if (k0 > NZ - 2) k0 = NZ - 2;
      const fz = z - k0, r0 = k0 * NX, r1 = r0 + NX;
      return (src[r0 + i0] * (1 - fx) + src[r0 + i1] * fx) * (1 - fz) + (src[r1 + i0] * (1 - fx) + src[r1 + i1] * fx) * fz;
    }

    advect(dst, src, vfall, hydro) {
      const u = this.uc, w = this.wc, ax = DT / DX, az = DT / DZ;
      for (let k = 0; k < NZ; k++) for (let i = 0; i < NX; i++) {
        const n = k * NX + i;
        const wf = vfall ? w[n] - vfall[n] : w[n];
        dst[n] = this.sample(src, i - u[n] * ax, k - wf * az, hydro);
      }
    }
    advectConst(dst, src, vfall, hydro) {
      const u = this.uc, w = this.wc, ax = DT / DX, az = DT / DZ;
      for (let k = 0; k < NZ; k++) for (let i = 0; i < NX; i++) {
        const n = k * NX + i;
        dst[n] = this.sample(src, i - u[n] * ax, k - (w[n] - vfall) * az, hydro);
      }
    }

    // ---- staggered-grid velocity advection ------------------------------
    // u lives at (i+½, k): sample the u array at fractional u-index xu = x − ½
    sampleU(x, z) {
      const u = this.u;
      let xu = x - 0.5; if (xu < 0) xu += NX; else if (xu >= NX) xu -= NX;
      const i0 = xu | 0, fx = xu - i0; let i1 = i0 + 1; if (i1 === NX) i1 = 0;
      if (z < 0) z = 0; else if (z > NZ - 1) z = NZ - 1;
      let k0 = z | 0; if (k0 > NZ - 2) k0 = NZ - 2;
      const fz = z - k0, r0 = k0 * NX, r1 = r0 + NX;
      return (u[r0 + i0] * (1 - fx) + u[r0 + i1] * fx) * (1 - fz) + (u[r1 + i0] * (1 - fx) + u[r1 + i1] * fx) * fz;
    }
    // wf lives at (i, j−½): sample at fractional w-index zw = z + ½ ∈ [0, NZ]
    sampleW(x, z) {
      const w = this.wf;
      if (x < 0) x += NX; else if (x >= NX) x -= NX;
      const i0 = x | 0, fx = x - i0; let i1 = i0 + 1; if (i1 === NX) i1 = 0;
      let zw = z + 0.5; if (zw < 0) zw = 0; else if (zw > NZ) zw = NZ;
      let j0 = zw | 0; if (j0 > NZ - 1) j0 = NZ - 1;
      const fz = zw - j0, r0 = j0 * NX, r1 = r0 + NX;
      return (w[r0 + i0] * (1 - fx) + w[r0 + i1] * fx) * (1 - fz) + (w[r1 + i0] * (1 - fx) + w[r1 + i1] * fx) * fz;
    }
    advectVelocity() {
      const u = this.u, wf = this.wf, tu = this.tmp, tw = this.tmpW, ax = DT / DX, az = DT / DZ;
      for (let k = 0; k < NZ; k++) for (let i = 0; i < NX; i++) {
        const n = k * NX + i, x = i + 0.5, z = k;
        const uu = u[n], ww = this.sampleW(x, z);
        tu[n] = this.sampleU(x - uu * ax, z - ww * az);
      }
      for (let j = 1; j < NZ; j++) for (let i = 0; i < NX; i++) {
        const n = j * NX + i, x = i, z = j - 0.5;
        const ww = wf[n], uu = this.sampleU(x, z);
        tw[n] = this.sampleW(x - uu * ax, z - ww * az);
      }
      u.set(tu);
      for (let j = 1; j < NZ; j++) { const r = j * NX; for (let i = 0; i < NX; i++) wf[r + i] = tw[r + i]; }
    }
    // cell-centre velocities for scalar advection, tracers and diagnostics
    centreVelocities() {
      const u = this.u, wf = this.wf, uc = this.uc, wc = this.wc;
      for (let k = 0; k < NZ; k++) {
        const r = k * NX;
        for (let i = 0; i < NX; i++) {
          const n = r + i, il = i ? n - 1 : n + NX - 1;
          uc[n] = 0.5 * (u[il] + u[n]);
          wc[n] = 0.5 * (wf[n] + wf[n + NX]);
        }
      }
    }

    // ---- pressure projection: ∇·(ρ̄∇φ) = ∇·(ρ̄u), FFT in x, tridiagonal in z ----
    fftInit() {
      const n = NX, bits = Math.log2(n) | 0;
      this.fftRev = new Uint16Array(n);
      for (let i = 0; i < n; i++) { let r = 0, v = i; for (let b = 0; b < bits; b++) { r = (r << 1) | (v & 1); v >>= 1; } this.fftRev[i] = r; }
      this.fftCos = new Float64Array(n / 2); this.fftSin = new Float64Array(n / 2);
      for (let i = 0; i < n / 2; i++) { this.fftCos[i] = Math.cos(2 * Math.PI * i / n); this.fftSin[i] = Math.sin(2 * Math.PI * i / n); }
      this.fRe = new Float64Array(N); this.fIm = new Float64Array(N);
      this.lam = new Float64Array(NX);
      for (let m = 0; m < NX; m++) this.lam[m] = (2 - 2 * Math.cos(2 * Math.PI * m / NX)) / (DX * DX);
      this.rowRe = new Float64Array(NX); this.rowIm = new Float64Array(NX);
      this.tdA = new Float64Array(NZ); this.tdB = new Float64Array(NZ); this.tdC = new Float64Array(NZ);
      this.tdCp = new Float64Array(NZ); this.tdDr = new Float64Array(NZ); this.tdDi = new Float64Array(NZ);
    }
    fft(re, im, inverse) {          // in-place radix-2, length NX
      const n = NX, rev = this.fftRev;
      for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
      for (let len = 2; len <= n; len <<= 1) {
        const half = len >> 1, stepT = n / len;
        for (let i = 0; i < n; i += len) {
          for (let j = 0; j < half; j++) {
            const c = this.fftCos[j * stepT], s = (inverse ? 1 : -1) * this.fftSin[j * stepT];
            const a = i + j, b = a + half;
            const xr = re[b] * c - im[b] * s, xi = re[b] * s + im[b] * c;
            re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
          }
        }
      }
      if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
    }
    project() {
      const u = this.u, wf = this.wf, rho = this.rho, fRe = this.fRe, fIm = this.fIm;
      const rowRe = this.rowRe, rowIm = this.rowIm;
      // divergence of ρ̄u at cell centres
      for (let k = 0; k < NZ; k++) {
        const r = k * NX, rk = rho[k];
        const rup = k < NZ - 1 ? 0.5 * (rho[k] + rho[k + 1]) : 0, rdn = k > 0 ? 0.5 * (rho[k] + rho[k - 1]) : 0;
        for (let i = 0; i < NX; i++) {
          const n = r + i, il = i ? n - 1 : n + NX - 1;
          fRe[n] = rk * (u[n] - u[il]) / DX + (rup * wf[n + NX] - rdn * wf[n]) / DZ;
          fIm[n] = 0;
        }
      }
      for (let k = 0; k < NZ; k++) {
        const r = k * NX;
        for (let i = 0; i < NX; i++) { rowRe[i] = fRe[r + i]; rowIm[i] = 0; }
        this.fft(rowRe, rowIm, false);
        for (let i = 0; i < NX; i++) { fRe[r + i] = rowRe[i]; fIm[r + i] = rowIm[i]; }
      }
      const A = this.tdA, B = this.tdB, C = this.tdC, Cp = this.tdCp, Dr = this.tdDr, Di = this.tdDi, DZ2 = DZ * DZ;
      for (let m = 0; m < NX; m++) {
        const lam = this.lam[m];
        for (let k = 0; k < NZ; k++) {
          const a = k < NZ - 1 ? 0.5 * (rho[k] + rho[k + 1]) / DZ2 : 0, b = k > 0 ? 0.5 * (rho[k] + rho[k - 1]) / DZ2 : 0;
          A[k] = b; C[k] = a; B[k] = -rho[k] * lam - a - b;
          Dr[k] = fRe[k * NX + m]; Di[k] = fIm[k * NX + m];
        }
        if (m === 0) { B[0] = 1; C[0] = 0; Dr[0] = 0; Di[0] = 0; }   // pin the constant mode
        Cp[0] = C[0] / B[0]; Dr[0] /= B[0]; Di[0] /= B[0];
        for (let k = 1; k < NZ; k++) {
          const den = B[k] - A[k] * Cp[k - 1];
          Cp[k] = C[k] / den; Dr[k] = (Dr[k] - A[k] * Dr[k - 1]) / den; Di[k] = (Di[k] - A[k] * Di[k - 1]) / den;
        }
        for (let k = NZ - 2; k >= 0; k--) { Dr[k] -= Cp[k] * Dr[k + 1]; Di[k] -= Cp[k] * Di[k + 1]; }
        for (let k = 0; k < NZ; k++) { fRe[k * NX + m] = Dr[k]; fIm[k * NX + m] = Di[k]; }
      }
      for (let k = 0; k < NZ; k++) {
        const r = k * NX;
        for (let i = 0; i < NX; i++) { rowRe[i] = fRe[r + i]; rowIm[i] = fIm[r + i]; }
        this.fft(rowRe, rowIm, true);
        for (let i = 0; i < NX; i++) fRe[r + i] = rowRe[i];
      }
      for (let k = 0; k < NZ; k++) {
        const r = k * NX;
        for (let i = 0; i < NX; i++) {
          const n = r + i, ir = i < NX - 1 ? n + 1 : n - NX + 1;
          u[n] -= (fRe[ir] - fRe[n]) / DX;
          if (k > 0) wf[n] -= (fRe[n] - fRe[n - NX]) / DZ;
        }
      }
      for (let i = 0; i < NX; i++) { wf[i] = 0; wf[NZ * NX + i] = 0; }
    }

    smooth(f, a, rows) {    // light 5-point diffusion over rows 1..rows−2
      const t = this.tmp2; t.set(f.subarray(0, rows * NX));
      for (let k = 1; k < rows - 1; k++) {
        const r = k * NX;
        for (let i = 0; i < NX; i++) {
          const n = r + i, il = i ? n - 1 : n + NX - 1, ir = i < NX - 1 ? n + 1 : n - NX + 1;
          f[n] = (1 - a) * t[n] + a * 0.25 * (t[il] + t[ir] + t[n + NX] + t[n - NX]);
        }
      }
    }

    // ---- one model step ---------------------------------------------------
    step() {
      const { u, wf, th, qv, qc, qr, qi, qg, cg, ci, cr, thb, qvb, rho, uenv } = this;
      const P = this.P;
      this.t += DT; this.stepCount++;

      // buoyancy on the w faces (mean of the two cells either side)
      const B = this.tmp;
      for (let k = 0; k < NZ; k++) {
        const r = k * NX, tk = thb[k], qk = qvb[k];
        for (let i = 0; i < NX; i++) {
          const n = r + i;
          B[n] = G * (th[n] / tk + 0.61 * (qv[n] - qk) - qc[n] - qr[n] - qi[n] - qg[n]);
        }
      }
      for (let j = 1; j < NZ; j++) {
        const r = j * NX;
        for (let i = 0; i < NX; i++) wf[r + i] += DT * 0.5 * (B[r + i] + B[r - NX + i]);
      }
      // top sponge (gravity waves, overshoot) and lateral nudging to the environment
      if (this.stepCount % 120 === 0) for (let i = 0; i < NX; i++) this.heatNoise[i] = 0.75 + 0.5 * this.rng();
      for (let k = 0; k < NZ; k++) {
        const r = k * NX, qk = qvb[k], dk = NZ - 1 - k;
        const sp = dk < 12 ? DT / (20 + dk * dk * 8) : 0;
        for (let i = 0; i < NX; i++) {
          const n = r + i;
          if (sp) { th[n] -= sp * th[n]; wf[n + NX] -= sp * wf[n + NX]; u[n] += sp * (uenv[k] - u[n]); }
          const d = Math.min(i, NX - 1 - i);
          if (d < 10) {
            const a = DT / (15 + d * d * 16);
            u[n] += a * (uenv[k] - u[n]); wf[n + NX] -= a * wf[n + NX]; th[n] -= a * th[n]; qv[n] += a * (qk - qv[n]);
            qc[n] -= a * qc[n]; qr[n] -= a * qr[n]; qi[n] -= a * qi[n]; qg[n] -= a * qg[n];
            cg[n] -= a * cg[n]; ci[n] -= a * ci[n]; cr[n] -= a * cr[n];
          }
        }
      }
      for (let i = 0; i < NX; i++) { wf[i] = 0; wf[NZ * NX + i] = 0; }
      // surface heat + moisture flux
      const heat = P.heat || 0;
      if (heat > 0) {
        const dth = heat / (rho[0] * CP * DZ) * DT, dq = 0.6 * heat / (rho[0] * LV * DZ) * DT;
        for (let i = 0; i < NX; i++) {
          const f = this.heatNoise[i];
          th[i] += 0.65 * dth * f; th[NX + i] += 0.35 * dth * f;
          qv[i] += 0.65 * dq * f; qv[NX + i] += 0.35 * dq * f;
        }
      }
      for (let i = 0; i < NX; i++) u[i] -= DT / 1500 * (u[i] - uenv[0]);   // surface drag

      // velocity: advect, diffuse, project, then cell-centre it for the scalars
      this.advectVelocity();
      this.smooth(u, 0.02, NZ); this.smooth(wf, 0.02, NZ + 1);
      for (let i = 0; i < NX; i++) { wf[i] = 0; wf[NZ * NX + i] = 0; }
      this.project();
      this.centreVelocities();

      // fall speeds
      const vr = this.vr, vg = this.vg;
      for (let k = 0; k < NZ; k++) {
        const r = k * NX, rk = rho[k], s = Math.sqrt(1.2 / rk);
        for (let i = 0; i < NX; i++) {
          const n = r + i;
          vr[n] = qr[n] > 1e-7 ? Math.min(12, 36.34 * Math.pow(1e-3 * rk * qr[n], 0.1364) * s) : 0;
          vg[n] = qg[n] > 1e-7 ? Math.min(16, (1.0 + 4.5 * Math.sqrt(qg[n] * 1e3)) * s) : 0;   // light graupel ~2 m/s, hail-sized content ~12
        }
      }
      // scalars
      // θ is advected as a total (θ̄ + θ'): moving θ' alone would hand a rising parcel the
      // environment's own θ increase with height as free heating
      const tt = this.tmp2;
      for (let k = 0; k < NZ; k++) { const r = k * NX, tk = thb[k]; for (let i = 0; i < NX; i++) tt[r + i] = th[r + i] + tk; }
      this.advect(this.tmp, tt, null, false);
      for (let k = 0; k < NZ; k++) { const r = k * NX, tk = thb[k]; for (let i = 0; i < NX; i++) th[r + i] = this.tmp[r + i] - tk; }
      this.advect(this.tmp, qv, null, false); qv.set(this.tmp);
      this.advect(this.tmp, qc, null, true); qc.set(this.tmp);
      this.advectConst(this.tmp, qi, VI, true); qi.set(this.tmp);
      this.advect(this.tmp, qr, vr, true); qr.set(this.tmp);
      this.advect(this.tmp, qg, vg, true); qg.set(this.tmp);
      this.advect(this.tmp, cg, vg, true); cg.set(this.tmp);
      this.advectConst(this.tmp, ci, VI, true); ci.set(this.tmp);
      this.advect(this.tmp, cr, vr, true); cr.set(this.tmp);

      // subgrid mixing (entrainment proxy)
      const mix = P.mix == null ? 0.01 : P.mix;
      if (mix > 0) { this.smooth(th, mix, NZ); this.smooth(qv, mix, NZ); this.smooth(qc, mix, NZ); this.smooth(qi, mix, NZ); }
      this.microphysics();
      if (this.stepCount % ESTEP === 0) { this.solveE(); this.tryLightning(); }
      if (this.stepCount % 2 === 0) this.diagnose();
    }

    // ---- microphysics -----------------------------------------------------
    microphysics() {
      const { th, qv, qc, qr, qi, qg, cg, ci, cr, thb, pb, pi, rho } = this;
      const pIdx = this.probeIndex(), chgK = 5e-5 * (this.P.chg || 1);
      let pd = null;
      for (let k = 0; k < NZ; k++) {
        const r = k * NX, p = pb[k], pik = pi[k], rk = rho[k];
        const lvc = LV / (CP * pik), lfc = LF / (CP * pik), lsc = LS / (CP * pik);
        for (let i = 0; i < NX; i++) {
          const n = r + i;
          let T = (thb[k] + th[n]) * pik, Tc = T - T0;
          const esw = es(Tc), qsw = qsat(esw, p);
          let cond = 0, dep = 0, rime = 0, frz = 0, melt = 0, evapR = 0, chg = 0, auto = 0;
          // 1. saturation adjustment (liquid)
          if (qv[n] > qsw || qc[n] > 0) {
            let dq = (qv[n] - qsw) / (1 + LV * LV * qsw / (CP * RV * T * T));
            if (dq < 0) dq = Math.max(dq, -qc[n]);
            qv[n] -= dq; qc[n] += dq; th[n] += lvc * dq; cond = dq / DT;
            T = (thb[k] + th[n]) * pik; Tc = T - T0;
          }
          if (qc[n] < 1e-9) qc[n] = 0;
          // 2. warm rain
          if (qc[n] > 1e-3) { auto = 1e-3 * (qc[n] - 1e-3) * DT; qc[n] -= auto; qr[n] += auto; }
          if (qc[n] > 0 && qr[n] > 1e-6) {
            const acc = Math.min(qc[n], 2.2 * qc[n] * Math.pow(qr[n], 0.875) * DT);
            qc[n] -= acc; qr[n] += acc; auto += acc;
          }
          // 3. rain evaporation
          if (qr[n] > 1e-7 && qv[n] < qsw) {
            const S = qv[n] / qsw;
            let e = (1 - S) * 5e-6 * Math.pow(qr[n] * 1e3, 0.65) * DT;
            e = Math.min(e, qr[n], (qsw - qv[n]) * 0.9);
            if (e > 0) { qr[n] -= e; qv[n] += e; th[n] -= lvc * e; evapR = e / DT; T = (thb[k] + th[n]) * pik; Tc = T - T0; }
            if (qr[n] < 1e-9) { qr[n] = 0; cr[n] = 0; }
          }
          // 4. ice
          if (Tc < 0) {
            const esI = esi(Tc), qsi = qsat(esI, p);
            // homogeneous freezing
            if (Tc < -38) {
              if (qc[n] > 0) { frz += qc[n]; qi[n] += qc[n]; th[n] += lfc * qc[n]; qc[n] = 0; }
              if (qr[n] > 0) { frz += qr[n]; qg[n] += qr[n]; th[n] += lfc * qr[n]; cg[n] += cr[n]; cr[n] = 0; qr[n] = 0; }
            } else {
              // heterogeneous freezing of cloud water
              if (qc[n] > 0 && Tc < -5) {
                const tau = 3600 * Math.exp(-0.14 * (-5 - Tc));
                const f = qc[n] * (1 - Math.exp(-DT / tau));
                qc[n] -= f; qi[n] += f; th[n] += lfc * f; frz += f;
              }
              // WBF: ice grows at the expense of liquid (vapour pressure gap)
              if (qc[n] > 0 && qi[n] > 1e-6) {
                const gap = (qsw - qsi) / qsw;               // 0 at 0 °C, ~0.12 at −12 °C
                const tau = 400 / Math.max(gap / 0.1, 0.05) / Math.min(1, qi[n] / 2e-4 + 0.2);
                const f = Math.min(qc[n], qc[n] * (1 - Math.exp(-DT / tau)));
                qc[n] -= f; qi[n] += f; th[n] += lfc * f; dep += f;
              }
              // riming: ice collecting cloud water becomes graupel
              if (qc[n] > 1e-4 && qi[n] > 1e-5) {
                const rc = Math.min(qc[n], 2.0 * qi[n] * qc[n] * DT);
                const ri = Math.min(qi[n], rc * 0.2);
                qc[n] -= rc; qi[n] -= ri; qg[n] += rc + ri; th[n] += lfc * rc; rime += rc;
                if (qi[n] + ri > 0) { const fr = ri / (qi[n] + ri); cg[n] += ci[n] * fr; ci[n] -= ci[n] * fr; }
              }
              // rain freezing (faster when ice is around)
              if (qr[n] > 1e-6 && Tc < -3) {
                const tau = (qi[n] > 1e-5 || qg[n] > 1e-5 ? 150 : 400) * Math.exp(-0.1 * (-3 - Tc));
                const f = qr[n] * (1 - Math.exp(-DT / tau));
                const fr = f / qr[n];
                qr[n] -= f; qg[n] += f; th[n] += lfc * f; frz += f;
                cg[n] += cr[n] * fr; cr[n] -= cr[n] * fr;
              }
              // graupel dry growth (hail)
              if (qc[n] > 1e-5 && qg[n] > 1e-5) {
                const gc = Math.min(qc[n], 0.8 * qc[n] * Math.pow(qg[n], 0.875) * DT);
                qc[n] -= gc; qg[n] += gc; th[n] += lfc * gc; rime += gc;
              }
            }
            // vapour ↔ ice: deposition when supersaturated w.r.t. ice, sublimation otherwise
            if (qi[n] > 1e-7 || qg[n] > 1e-7) {
              const Si = qv[n] / qsi;
              if (Si > 1 && qc[n] <= 0) {
                let d = (qv[n] - qsi) / (1 + LS * LS * qsi / (CP * RV * T * T));
                d *= 1 - Math.exp(-DT / (300 / Math.min(1, (qi[n] + qg[n]) / 5e-4 + 0.1)));
                qv[n] -= d; qi[n] += d; th[n] += lsc * d; dep += d;
              } else if (Si < 1) {
                const s = Math.min(qi[n], qi[n] * (1 - Si) * DT / 300, (qsi - qv[n]) * 0.9);
                if (s > 0) { qi[n] -= s; qv[n] += s; th[n] -= lsc * s; dep -= s; }
                if (qi[n] < 1e-9) { qi[n] = 0; ci[n] = 0; }
              }
            }
            // non-inductive charging: graupel × ice × supercooled water
            if (qc[n] > 1e-5 && qg[n] > 1e-5 && qi[n] > 1e-6) {
              const rate = chgK * Math.min(qg[n], 5e-3) * rk * Math.min(qi[n], 2e-3) * rk * Math.min(1, qc[n] / 3e-4) * DT;
              // graupel negative colder than the reversal temperature; the warm-side positive
              // charging is weaker (Takahashi), so the main negative centre dominates
              const sgn = Tc < -15 ? -1 : 0.6;
              cg[n] += sgn * rate; ci[n] -= sgn * rate; chg = sgn * rate / DT;
            }
          } else {
            // melting
            if (qg[n] > 0) {
              const tauM = 300 * (1 + 1.2 * qg[n] * 1e3);
              const f = Math.min(qg[n], qg[n] * DT * Tc / tauM), fr = f / qg[n];
              qg[n] -= f; qr[n] += f; th[n] -= lfc * f; melt += f;
              cr[n] += cg[n] * fr; cg[n] -= cg[n] * fr;
              if (qg[n] < 1e-9) { qg[n] = 0; cg[n] = 0; }
            }
            if (qi[n] > 0) {
              const f = Math.min(qi[n], qi[n] * DT * Tc / 60);
              qi[n] -= f; qr[n] += f * 0.5; qc[n] += f * 0.5; th[n] -= lfc * f; melt += f;
              if (qi[n] < 1e-9) { qi[n] = 0; ci[n] = 0; } else { const fr = f / (qi[n] + f); cr[n] += ci[n] * fr; ci[n] -= ci[n] * fr; }
            }
          }
          if (qg[n] < 1e-9) { qg[n] = 0; cg[n] = 0; }
          if (n === pIdx) {
            pd = { T, Tc, p, qsw, qsi: Tc < 0 ? qsat(esi(Tc), p) : qsw, cond, dep, rime, frz, melt, evapR, chg, auto,
              esw, esI: Tc < 0 ? esi(Tc) : esw };
          }
        }
      }
      // ground fallout diagnostics
      const rr = this.rainRate, hr = this.hailRate, rk0 = rho[0];
      for (let i = 0; i < NX; i++) { rr[i] = rk0 * qr[i] * this.vr[i] * 3600; hr[i] = rk0 * qg[i] * this.vg[i] * 3600; }
      if (pd) this.probeDiag = pd;
    }

    probeIndex() {
      let i = Math.floor(this.probe.x / DX), k = Math.floor(this.probe.z / DZ);
      i = clamp(i, 0, NX - 1); k = clamp(k, 0, NZ - 1);
      return k * NX + i;
    }

    // ---- electrostatics -----------------------------------------------------
    solveE() {
      const BX = NX / 4, BZ = NZ / 4, NB = BX * BZ;
      if (!this.bq) { this.bq = new Float64Array(NB); this.bex = new Float64Array(NB); this.bez = new Float64Array(NB); }
      const bq = this.bq, bex = this.bex, bez = this.bez;
      bq.fill(0);
      const { cg, ci, cr } = this;
      const cellQ = DX * DZ * LY;
      let any = false;
      for (let k = 0; k < NZ; k++) for (let i = 0; i < NX; i++) {
        const n = k * NX + i, q = (cg[n] + ci[n] + cr[n]) * cellQ;
        if (q) { bq[(k >> 2) * BX + (i >> 2)] += q; any = true; }
      }
      bex.fill(0); bez.fill(0); this.eGround.fill(0);
      if (!any) { this.ex.fill(0); this.ez.fill(0); this.em.fill(0); this.eMax = 0; return; }
      const soft2 = 600 * 600, bs = 4 * DX;
      const src = [];
      for (let b = 0; b < NB; b++) if (Math.abs(bq[b]) > 1e-3) src.push(b);
      for (let b = 0; b < NB; b++) {
        const x = ((b % BX) + 0.5) * bs, z = (Math.floor(b / BX) + 0.5) * bs;
        let ex = 0, ez = 0;
        for (const s of src) {
          const xs = ((s % BX) + 0.5) * bs, zs = (Math.floor(s / BX) + 0.5) * bs, q = K_COUL * bq[s];
          let dx = x - xs; if (dx > LX / 2) dx -= LX; else if (dx < -LX / 2) dx += LX;
          let dz = z - zs, r2 = dx * dx + dz * dz + soft2, r = Math.sqrt(r2), f = q / (r2 * r);
          ex += f * dx; ez += f * dz;
          dz = z + zs; r2 = dx * dx + dz * dz + soft2; r = Math.sqrt(r2); f = -q / (r2 * r);   // image
          ex += f * dx; ez += f * dz;
        }
        bex[b] = ex; bez[b] = ez;
      }
      for (let i = 0; i < NX; i++) {
        const x = (i + 0.5) * DX; let ez = 0;
        for (const s of src) {
          const xs = ((s % BX) + 0.5) * bs, zs = (Math.floor(s / BX) + 0.5) * bs;
          let dx = x - xs; if (dx > LX / 2) dx -= LX; else if (dx < -LX / 2) dx += LX;
          const r2 = dx * dx + zs * zs + soft2;
          ez += -2 * K_COUL * bq[s] * zs / (r2 * Math.sqrt(r2));
        }
        this.eGround[i] = ez;
      }
      // bilinear to the fine grid
      let emax = 0, emaxN = -1;
      for (let k = 0; k < NZ; k++) {
        const bz = clamp((k + 0.5) / 4 - 0.5, 0, BZ - 1), k0 = Math.floor(bz), fz = bz - k0, k1 = Math.min(k0 + 1, BZ - 1);
        for (let i = 0; i < NX; i++) {
          const bx = (i + 0.5) / 4 - 0.5; let i0 = Math.floor(bx); const fx = bx - i0;
          if (i0 < 0) i0 += BX; let i1 = i0 + 1; if (i1 >= BX) i1 = 0;
          const a = k0 * BX, b = k1 * BX;
          const ex = (bex[a + i0] * (1 - fx) + bex[a + i1] * fx) * (1 - fz) + (bex[b + i0] * (1 - fx) + bex[b + i1] * fx) * fz;
          const ez = (bez[a + i0] * (1 - fx) + bez[a + i1] * fx) * (1 - fz) + (bez[b + i0] * (1 - fx) + bez[b + i1] * fx) * fz;
          const n = k * NX + i, m = Math.sqrt(ex * ex + ez * ez);
          this.ex[n] = ex; this.ez[n] = ez; this.em[n] = m;
          if (m > emax) { emax = m; emaxN = n; }
        }
      }
      this.eMax = emax; this.eMaxN = emaxN;
    }

    // initiation threshold: ~130 kV/m at sea-level density, scaled by ρ̄; halved inside heavy
    // precipitation, where corona from large hydrometeors seeds the first streamers
    eInit(k, n) {
      let e = 1.3e5 * this.rho[k] / 1.225 * (this.P.eScale || 1);
      if (n != null) e *= 1 - 0.5 * Math.min(1, (this.qg[n] + this.qr[n]) / 3e-3);
      return e;
    }

    eAt(x, z) {      // bilinear E at metres
      const fx = x / DX - 0.5, fz = z / DZ - 0.5;
      let i0 = Math.floor(fx); const ax = fx - i0; if (i0 < 0) i0 += NX; if (i0 >= NX) i0 -= NX; let i1 = i0 + 1; if (i1 >= NX) i1 = 0;
      let k0 = Math.floor(fz); if (k0 < 0) k0 = 0; if (k0 > NZ - 2) k0 = NZ - 2; const az = clamp(fz - k0, 0, 1), k1 = k0 + 1;
      const a = k0 * NX, b = k1 * NX;
      const ex = (this.ex[a + i0] * (1 - ax) + this.ex[a + i1] * ax) * (1 - az) + (this.ex[b + i0] * (1 - ax) + this.ex[b + i1] * ax) * az;
      let ez = (this.ez[a + i0] * (1 - ax) + this.ez[a + i1] * ax) * (1 - az) + (this.ez[b + i0] * (1 - ax) + this.ez[b + i1] * ax) * az;
      if (z < DZ / 2) {       // blend toward the ground field below the first level
        const f = z / (DZ / 2); let i = Math.floor(x / DX); if (i < 0) i += NX; if (i >= NX) i -= NX;
        ez = ez * f + this.eGround[i] * (1 - f);
      }
      return [ex, ez];
    }

    tryLightning() {
      if (this.eMax <= 0) return;
      if (this.rng() > 0.75) return;           // not every solve that could flash does
      // candidate cells above the initiation threshold
      const cand = [];
      let wsum = 0;
      for (let k = 0; k < NZ; k++) {
        for (let i = 0; i < NX; i++) {
          const n = k * NX + i, e = this.em[n], th = this.eInit(k, n);
          if (e > th) { const wgt = (e / th - 1); cand.push(n, wgt); wsum += wgt; }
        }
      }
      if (!cand.length) return;
      let pick = this.rng() * wsum, n0 = cand[0];
      for (let j = 0; j < cand.length; j += 2) { pick -= cand[j + 1]; if (pick <= 0) { n0 = cand[j]; break; } }
      const x0 = (n0 % NX + 0.5) * DX + (this.rng() - 0.5) * DX, z0 = (Math.floor(n0 / NX) + 0.5) * DZ;
      const branches = [];
      const neg = this.leader(x0, z0, -1, branches, 200);
      const pos = this.leader(x0, z0, +1, branches, 200);
      const cgNeg = neg.ground, cgPos = pos.ground;
      const cg = cgNeg || cgPos;
      const q = this.neutralise(branches);
      const flash = {
        t: this.t, x0, z0, branches, cg, polarity: cgPos && !cgNeg ? '+' : '-',
        xStrike: cgNeg ? neg.pts[neg.pts.length - 1][0] : cgPos ? pos.pts[pos.pts.length - 1][0] : null,
        charge: q, eInit: this.em[n0], id: this.nFlash + 1, neg, pos,
      };
      this.flashes.push(flash); this.newFlashes.push(flash);
      this.nFlash++; if (cg) this.nCG++; else this.nIC++;
      this.lastFlashT = this.t;
      if (this.flashes.length > 60) this.flashes.shift();
      this.solveE();
    }

    // bidirectional leader: sign +1 follows +E (positive leader), −1 follows −E
    leader(x, z, sign, branches, steps) {
      const pts = [[x, z]];
      let px = 0, pz = 0, ground = false, first = true, why = 'steps';
      const stepLen = 220;
      for (let s = 0; s < steps; s++) {
        const [ex, ez] = this.eAt(x, z), e = Math.hypot(ex, ez);
        const k = clamp(Math.floor(z / DZ), 0, NZ - 1);
        const need = first ? 0 : 0.04 * this.eInit(k) * Math.max(0.05, 1 - s / 60);   // a long leader carries the cloud's potential with it
        if (e < need) { why = 'weak'; break; }
        let dx = sign * ex / (e + 1e-9), dz = sign * ez / (e + 1e-9);
        if (!first && dx * px + dz * pz < -0.5) { why = 'reversed'; break; }   // field reversed: leader has crossed its target charge
        // persistence + tortuosity
        const ang = Math.atan2(dz, dx) + (this.rng() + this.rng() + this.rng() - 1.5) * 0.9;
        let nx = Math.cos(ang), nz = Math.sin(ang);
        if (!first) { nx = 0.55 * nx + 0.45 * px; nz = 0.55 * nz + 0.45 * pz; const l = Math.hypot(nx, nz); nx /= l; nz /= l; }
        px = nx; pz = nz; first = false;
        x += nx * stepLen; z += nz * stepLen;
        if (x < 0) x += LX; else if (x >= LX) x -= LX;
        if (z <= 150) { z = 0; pts.push([x, z]); ground = true; why = 'ground'; break; }   // attachment: upward streamers close the last ~100 m
        if (z >= LZ - DZ) { why = 'top'; break; }
        pts.push([x, z]);
        if (s > 2 && this.rng() < 0.07 && steps > 30) {
          const b = this.leader(x, z, sign, branches, Math.floor(steps / 3));
          if (b.pts.length > 3) { b.minor = true; if (b.ground) ground = ground || b.ground; }
        }
      }
      const rec = { pts, sign, ground, minor: false, why };
      if (pts.length > 1) branches.push(rec);
      return rec;
    }

    neutralise(branches) {
      const { cg, ci, cr } = this;
      const R = 1100, R2 = R * R, cellQ = DX * DZ * LY;
      let moved = 0;
      const touched = new Uint8Array(N);
      for (const b of branches) for (let j = 0; j < b.pts.length; j += 2) {
        const [x, z] = b.pts[j];
        const i0 = Math.floor((x - R) / DX), i1 = Math.floor((x + R) / DX), k0 = Math.max(0, Math.floor((z - R) / DZ)), k1 = Math.min(NZ - 1, Math.floor((z + R) / DZ));
        for (let k = k0; k <= k1; k++) for (let ii = i0; ii <= i1; ii++) {
          let i = ii; if (i < 0) i += NX; else if (i >= NX) i -= NX;
          const n = k * NX + i;
          if (touched[n]) continue;
          let dx = (i + 0.5) * DX - x; if (dx > LX / 2) dx -= LX; else if (dx < -LX / 2) dx += LX;
          const dz = (k + 0.5) * DZ - z, d2 = dx * dx + dz * dz;
          if (d2 > R2) continue;
          touched[n] = 1;
          const f = 0.85 * (1 - d2 / R2);
          moved += Math.abs(cg[n] + ci[n] + cr[n]) * f * cellQ;
          cg[n] *= 1 - f; ci[n] *= 1 - f; cr[n] *= 1 - f;
        }
      }
      return moved / 2;
    }

    // ---- diagnostics ---------------------------------------------------------
    diagnose() {
      const w = this.wc, u = this.uc, { th, qc, qi, qr, qg, cg, ci, cr } = this;
      let maxW = 0, minW = 0, top = 0, base = null, maxQg = 0, maxQr = 0, coldMin = 0, maxChg = 0, hailAloft = false;
      let iceOnly = true, anyCloud = false, scw = 0;
      for (let k = 0; k < NZ; k++) {
        const r = k * NX, Tc = this.tb[k] - T0;
        for (let i = 0; i < NX; i++) {
          const n = r + i;
          if (w[n] > maxW) maxW = w[n]; if (w[n] < minW) minW = w[n];
          const cl = qc[n] + qi[n];
          if (cl > 1e-4) { anyCloud = true; if (this.z[k] > top) top = this.z[k]; if (qc[n] > 1e-4) { iceOnly = false; if (base == null || this.z[k] < base) base = this.z[k]; } }
          if (qg[n] > maxQg) maxQg = qg[n]; if (qr[n] > maxQr) maxQr = qr[n];
          if (k < 3 && th[n] < coldMin) coldMin = th[n];
          const c = Math.abs(cg[n] + ci[n] + cr[n]); if (c > maxChg) maxChg = c;
          if (qg[n] > 2e-3 && Tc < 0) hailAloft = true;
          if (Tc < 0 && Tc > -20 && qc[n] > 2e-4) scw++;
        }
      }
      let rainMax = 0, hailMax = 0, rainI = 0;
      for (let i = 0; i < NX; i++) { if (this.rainRate[i] > rainMax) { rainMax = this.rainRate[i]; rainI = i; } if (this.hailRate[i] > hailMax) hailMax = this.hailRate[i]; }
      // at the field
      const xf = this.xField(); let iF = Math.floor(xf / DX); if (iF >= NX) iF = NX - 1;
      const uG = u[iF] + this.us;                      // ground-relative surface wind
      const rainF = this.rainRate[iF], hailF = this.hailRate[iF];
      this.rainTotalField += rainF / 3600 * DT * 2;    // diagnose() runs every 2 steps
      // microburst: surface divergence under a downdraft
      let microburst = null;
      for (let i = 2; i < NX - 2; i++) {
        const dv = (u[i + 2] - u[i - 2]) / (4 * DX);
        if (dv > 2.2e-3 && w[4 * NX + i] < -5) {
          const gust = Math.max(Math.abs(u[i + 3] + this.us), Math.abs(u[i - 3] + this.us));
          if (!microburst || gust > microburst.gust) microburst = { x: (i + 0.5) * DX, gust, dv };
        }
      }
      // gust front: leading edge of the cold pool
      let gustFront = null;
      for (let i = 1; i < NX - 1; i++) if (th[i] < -1.5 && th[i + 1] >= -1.5 || th[i] < -1.5 && th[i - 1] >= -1.5) { gustFront = gustFront || []; gustFront.push((i + 0.5) * DX); }
      let stage;
      const since = this.lastFlashT == null ? null : this.t - this.lastFlashT;
      if (!anyCloud) stage = this.t > 300 && coldMin < -1 ? 'dissipated' : 'clear';
      else if (iceOnly) stage = 'anvil debris';
      else if (rainMax < 1 && top < 5000) stage = 'cumulus';
      else if (rainMax < 2) stage = maxW > 5 ? 'towering cumulus' : 'cumulus';
      else if (maxW > 8) stage = 'mature';
      else stage = 'dissipating';
      this.diag = {
        maxW, minW, top, base, maxQg, maxQr, coldMin, maxChg, hailAloft, rainMax, hailMax, rainX: (rainI + 0.5) * DX,
        rainF, hailF, uG, gustKt: Math.abs(uG) * 1.944, microburst, gustFront, stage, since,
        eMax: this.eMax, nFlash: this.nFlash, nCG: this.nCG, nIC: this.nIC, icing: scw > 40, xField: xf,
        eGroundF: this.eGround[iF], rainTotalF: this.rainTotalField, anyCloud,
      };
    }

    // model column at x (for the sounding overlay): T and Td per level
    column(x) {
      let i = Math.floor(x / DX); i = clamp(i, 0, NX - 1);
      const T = new Float32Array(NZ), Td = new Float32Array(NZ), W = new Float32Array(NZ);
      for (let k = 0; k < NZ; k++) {
        const n = k * NX + i;
        T[k] = (this.thb[k] + this.th[n]) * this.pi[k];
        Td[k] = tdew(this.qv[n], this.pb[k]) + T0;
        W[k] = this.wc[n];
      }
      return { T, Td, W };
    }

    cellAt(x, z) {
      let i = Math.floor(x / DX), k = Math.floor(z / DZ);
      i = clamp(i, 0, NX - 1); k = clamp(k, 0, NZ - 1);
      const n = k * NX + i, T = (this.thb[k] + this.th[n]) * this.pi[k], Tc = T - T0, p = this.pb[k];
      const qsw = qsat(es(Tc), p), qsi = Tc < 0 ? qsat(esi(Tc), p) : qsw;
      return {
        i, k, n, T, Tc, p, qsw, qsi, rhw: this.qv[n] / qsw, rhi: this.qv[n] / qsi,
        qv: this.qv[n], qc: this.qc[n], qr: this.qr[n], qi: this.qi[n], qg: this.qg[n],
        u: this.uc[n], w: this.wc[n], th: this.th[n],
        chg: this.cg[n] + this.ci[n] + this.cr[n], chgG: this.cg[n], chgI: this.ci[n], chgR: this.cr[n],
        e: this.em[n], ex: this.ex[n], ez: this.ez[n], rho: this.rho[k], vr: this.vr[n], vg: this.vg[n],
      };
    }
  }

  StormModel.C = { NX, NZ, DX, DZ, DT, LX, LZ, N, LY, T0, VI, G, CP, LV, LF };
  StormModel.PRESETS = PRESETS;
  StormModel.es = es; StormModel.esi = esi; StormModel.qsat = qsat; StormModel.tdew = tdew;
  return StormModel;
});

// ---- Node tuning harness: node js/storm-model.js [preset] [minutes] -----------
if (typeof module === 'object' && module.exports && require.main === module) {
  const M = module.exports;
  const preset = process.argv[2] || 'pulse', mins = +(process.argv[3] || 60);
  const m = new M();
  let seed = 12345; m.rng = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  m.setParams(Object.assign({}, M.PRESETS[preset]));
  const pc = m.parcel;
  console.log(`${preset}: CAPE ${pc.cape | 0} J/kg  CIN ${pc.cin | 0}  LCL ${pc.lcl}  LFC ${pc.lfc}  EL ${pc.el}  us ${m.us.toFixed(1)} m/s  iso0 ${m.isoZ[0] | 0} iso-15 ${m.isoZ[-15] | 0} iso-40 ${m.isoZ[-40] | 0}`);
  const t0 = Date.now(); let steps = 0;
  const every = 300 / M.C.DT;
  while (m.t < mins * 60) {
    m.step(); steps++;
    if (steps % every === 0) {
      const d = m.diag;
      console.log(`t+${(m.t / 60).toFixed(0).padStart(3)} min  ${d.stage.padEnd(16)} top ${(d.top / 1000).toFixed(1)} km  w ${d.maxW.toFixed(1)}/${d.minW.toFixed(1)}  rain ${d.rainMax.toFixed(1)} mm/h  qg ${(d.maxQg * 1e3).toFixed(2)} g/kg  cold ${d.coldMin.toFixed(1)} K  chg ${(d.maxChg * 1e9).toFixed(2)} nC/m³  E ${(d.eMax / 1e3).toFixed(0)} kV/m  flashes ${d.nFlash} (IC ${d.nIC} CG ${d.nCG})  gustF ${d.gustKt.toFixed(0)} kt  mb ${d.microburst ? d.microburst.gust.toFixed(0) : '-'}`);
    }
  }
  const ms = Date.now() - t0;
  console.log(`${steps} steps in ${ms} ms  (${(ms / steps).toFixed(2)} ms/step)`);
}
