// storm.js — Thunderstorm Lab page: renders js/storm-model.js.
// Sky canvas (clouds, precipitation, cold pool, overlays, lightning, the field),
// lightning + thunder (real-time acoustics from the channel geometry), the sounding
// panel (environment, parcel, live model column, sliders), the molecule microscope
// at a draggable probe, readouts and hazard chips. No fetches, no site-config.

(() => {
  'use strict';
  const M = window.StormModel, C = M.C;
  const { NX, NZ, DX, DZ, DT, LX, LZ, T0 } = C;
  const FT = 3.28084, KT = 1.94384, NM = 1852;
  const $ = id => document.getElementById(id);
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const fmt = (v, d = 0) => (+v).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d });

  const model = new M();
  const state = {
    running: true, speed: 60, acc: 0, lastT: performance.now(),
    layer: null, tracers: false, wind: false, sound: false,
    drag: null, probeR: 11, bang: null, flashesSeen: 0, visFlashes: [],
    dtVis: 3, ground: 74,
  };

  // ---------------------------------------------------------------- sky canvas
  const sky = $('sky'), ctx = sky.getContext('2d');
  const cloudCv = document.createElement('canvas'); cloudCv.width = NX; cloudCv.height = NZ;
  const cctx = cloudCv.getContext('2d'); const img = cctx.createImageData(NX, NZ);
  let W = 0, H = 0, DPR = 1, scale = 1, offX = 0, skyTop = 0, groundY = 0;
  function resize() {
    DPR = Math.min(2, window.devicePixelRatio || 1);
    W = window.innerWidth; H = window.innerHeight;
    sky.width = W * DPR; sky.height = H * DPR; ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    const availH = H - state.ground - 4;
    scale = W / LX; if (LZ * scale > availH) scale = availH / LZ;
    offX = (W - LX * scale) / 2;
    skyTop = Math.max(0, (availH - LZ * scale) * 0.6);
    groundY = skyTop + LZ * scale;
  }
  function placePanels() { const top = $('bar').offsetHeight + 18; $('read').style.top = top + 'px'; $('snd').style.top = top + 'px'; $('help').style.top = top + 'px'; }
  window.addEventListener('resize', () => { resize(); placePanels(); }); resize(); placePanels();
  const sx = x => offX + x * scale, sy = z => groundY - z * scale;
  const wx = px => (px - offX) / scale, wz = py => (groundY - py) / scale;

  // ---------------------------------------------------------------- particles
  const drops = [], hail = [], tracers = [];
  function spawnPrecip(dtv) {
    const { qr, qg, uc, wc, vr, vg, tb } = model;
    for (let s = 0; s < 40; s++) {
      const n = (Math.random() * C.N) | 0, k = (n / NX) | 0, i = n % NX;
      if (drops.length < 2600 && qr[n] > 2e-4 && Math.random() < qr[n] / 3e-3) drops.push({ x: (i + Math.random()) * DX, z: (k + Math.random()) * DZ, a: 0.5 + Math.random() * 0.5 });
      if (hail.length < 500 && qg[n] > 8e-4 && tb[k] > T0 - 8 && Math.random() < qg[n] / 6e-3) hail.push({ x: (i + Math.random()) * DX, z: (k + Math.random()) * DZ, r: 1 + Math.random() * 1.6 });
    }
    const mv = (p, fall) => {
      const c = model.cellAt(p.x, p.z);
      p.x += c.u * dtv; p.z += (c.w - fall(c)) * dtv;
      p.vx = c.u; p.vz = c.w - fall(c);
      if (p.x < 0) p.x += LX; else if (p.x >= LX) p.x -= LX;
      return p.z > 0 && p.z < LZ;
    };
    for (let j = drops.length - 1; j >= 0; j--) { const p = drops[j]; if (!mv(p, c => Math.max(3, c.vr))) { drops[j] = drops[drops.length - 1]; drops.pop(); continue; } if (Math.random() < 0.004) { drops[j] = drops[drops.length - 1]; drops.pop(); } }
    for (let j = hail.length - 1; j >= 0; j--) { const p = hail[j]; if (!mv(p, c => Math.max(4, c.vg))) { hail[j] = hail[hail.length - 1]; hail.pop(); continue; } if (Math.random() < 0.006) { hail[j] = hail[hail.length - 1]; hail.pop(); } }
  }
  function stepTracers(dtv) {
    while (tracers.length < 1400) tracers.push({ x: Math.random() * LX, z: Math.pow(Math.random(), 1.6) * LZ * 0.85 });
    for (const p of tracers) {
      const c = model.cellAt(p.x, p.z);
      p.u = c.u; p.w = c.w;
      p.x += c.u * dtv; p.z += c.w * dtv;
      if (p.x < 0) p.x += LX; else if (p.x >= LX) p.x -= LX;
      if (p.z <= 0 || p.z >= LZ || Math.random() < 0.002) { p.x = Math.random() * LX; p.z = Math.pow(Math.random(), 1.6) * LZ * 0.85; }
    }
  }

  // ---------------------------------------------------------------- cloud image
  const cloudNoise = new Float32Array(C.N); for (let i = 0; i < C.N; i++) cloudNoise[i] = 0.6 + 0.8 * Math.random();
  function buildCloudImage(flashGlow) {
    const { qc, qi, qr, qg, th, cg, ci, cr, em, tb, wc } = model;
    const d = img.data, colAcc = new Float32Array(NX);
    const layer = state.layer;
    for (let k = NZ - 1; k >= 0; k--) {
      let rowAcc = 0;
      const row = (NZ - 1 - k) * NX;
      for (let i = 0; i < NX; i++) {
        const n = k * NX + i;
        const ac = 1 - Math.exp(-(qc[n] * 2600 + qi[n] * 650) * cloudNoise[n]);
        const fi = (qi[n] + 1e-9) / (qc[n] + qi[n] + 1e-9);
        const b = 0.32 + 0.68 * Math.exp(-0.9 * colAcc[i]);
        const bl = 0.8 + 0.2 * Math.exp(-0.6 * rowAcc);
        colAcc[i] += ac; rowAcc += ac * 0.5;
        let r = 0, g = 0, bb = 0, a = 0;
        // air tints under the cloud
        if (layer === 'temp') {
          const t = clamp(th[n] / 8, -1, 1); a = Math.min(0.75, Math.abs(t) * 0.9);
          if (t > 0) { r = 255; g = 120 - 60 * t; bb = 60; } else { r = 70; g = 140 + 60 * t; bb = 255; }
        } else if (layer === 'w') {
          const t = clamp(wc[n] / 20, -1, 1); a = Math.min(0.75, Math.abs(t) * 1.2);
          if (t > 0) { r = 255; g = 130; bb = 70; } else { r = 80; g = 160; bb = 255; }
        } else if (layer === 'charge') {
          const q = (cg[n] + ci[n] + cr[n]) * 1e9, t = clamp(q / 0.8, -1, 1); a = Math.min(0.85, Math.abs(t) * 1.4 + (Math.abs(q) > 0.01 ? 0.08 : 0));
          if (t > 0) { r = 255; g = 90; bb = 80; } else { r = 80; g = 130; bb = 255; }
        } else if (layer === 'efield') {
          const t = clamp(em[n] / model.eInit(k, n), 0, 1.2); a = Math.min(0.9, t * 0.9);
          r = 255; g = 200 + 55 * Math.min(1, t); bb = 60 + 190 * Math.max(0, t - 0.9) * 10;
        } else {
          const t = th[n];
          if (t < -0.6 && k < 16) { a = Math.min(0.42, (-t - 0.6) / 9); r = 95; g = 125; bb = 175; }
          else if (t > 0.6 && qc[n] < 1e-5 && k < 20) { a = Math.min(0.14, (t - 0.6) / 14); r = 255; g = 190; bb = 110; }
        }
        // precipitation
        const ar = (1 - Math.exp(-qr[n] * 420)) * 0.62, ag = (1 - Math.exp(-qg[n] * 350)) * (tb[k] > T0 - 6 ? 0.55 : 0.25);
        if (ar > 0.01) { const w2 = ar; r = r * (1 - w2) + 115 * w2; g = g * (1 - w2) + 135 * w2; bb = bb * (1 - w2) + 165 * w2; a = 1 - (1 - a) * (1 - ar); }
        if (ag > 0.01) { const w2 = ag; r = r * (1 - w2) + 205 * w2; g = g * (1 - w2) + 212 * w2; bb = bb * (1 - w2) + 225 * w2; a = 1 - (1 - a) * (1 - ag); }
        // cloud on top
        if (ac > 0.003) {
          const cb = b * bl * (1 + flashGlow);
          const cr_ = (248 - 20 * fi) * cb, cg_ = (246 - 8 * fi) * cb, cb_ = (250 + 5 * fi) * cb;
          const acl = layer ? ac * 0.55 : ac;
          const na = 1 - (1 - a) * (1 - acl), w2 = acl / Math.max(na, 1e-6);
          r = r * (1 - w2) + cr_ * w2; g = g * (1 - w2) + cg_ * w2; bb = bb * (1 - w2) + cb_ * w2; a = na;
        }
        const o = (row + i) * 4;
        d[o] = Math.min(255, r); d[o + 1] = Math.min(255, g); d[o + 2] = Math.min(255, bb); d[o + 3] = a * 255;
      }
    }
    cctx.putImageData(img, 0, 0);
  }

  // ---------------------------------------------------------------- lightning visuals
  function pollFlashes() {
    while (model.newFlashes.length) {
      const f = model.newFlashes.shift();
      const xf = model.xField();
      let dmin = Infinity;
      for (const b of f.branches) for (const [x, z] of b.pts) { let dx = x - xf; if (dx > LX / 2) dx -= LX; else if (dx < -LX / 2) dx += LX; const dd = Math.hypot(dx, z); if (dd < dmin) dmin = dd; }
      f.dmin = dmin;
      state.visFlashes.push({ f, t0: performance.now() });
      if (state.visFlashes.length > 3) state.visFlashes.shift();
      state.bang = { t: performance.now(), s: dmin / 343, nm: dmin / NM, cg: f.cg, q: f.charge };
      if (state.sound) thunder(f, xf);
    }
  }
  function drawFlashes(now) {
    let glow = 0;
    for (const v of state.visFlashes) {
      const age = (now - v.t0) / 1000, f = v.f;
      if (age > 1.3) continue;
      const lead = clamp(age / 0.22, 0, 1);
      let inten;
      if (age < 0.22) inten = 0.35;
      else {
        const a = age - 0.22;
        inten = Math.exp(-a / 0.12);
        if (f.cg) { if (a > 0.18) inten = Math.max(inten, 0.75 * Math.exp(-(a - 0.18) / 0.1)); if (a > 0.36) inten = Math.max(inten, 0.55 * Math.exp(-(a - 0.36) / 0.12)); }
        else inten *= 0.7;
      }
      glow = Math.max(glow, inten * (f.cg ? 0.9 : 0.6));
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (const b of f.branches) {
        if (b.pts.length < 2) continue;
        const npts = Math.min(b.pts.length, Math.max(2, Math.floor(b.pts.length * lead)));
        ctx.beginPath();
        let px = null;
        for (let j = 0; j < npts; j++) {
          const [x, z] = b.pts[j];
          if (px != null && Math.abs(x - px) > LX / 2) { ctx.moveTo(sx(x), sy(z)); } else if (j === 0) ctx.moveTo(sx(x), sy(z)); else ctx.lineTo(sx(x), sy(z));
          px = x;
        }
        const wmain = b.minor ? 1 : 2.4;
        ctx.strokeStyle = `rgba(235,240,255,${Math.min(1, 0.35 + inten)})`;
        ctx.lineWidth = wmain * (0.6 + inten * 1.2);
        ctx.shadowBlur = 6 + 18 * inten; ctx.shadowColor = f.cg ? 'rgba(190,210,255,1)' : 'rgba(200,190,255,1)';
        ctx.stroke();
        if (inten > 0.5 && !b.minor) { ctx.lineWidth = 0.8; ctx.strokeStyle = 'rgba(255,255,255,1)'; ctx.stroke(); }
      }
      // diffuse cloud illumination around the channel
      const g = ctx.createRadialGradient(sx(f.x0), sy(f.z0), 0, sx(f.x0), sy(f.z0), 4500 * scale);
      g.addColorStop(0, `rgba(210,215,255,${0.16 * inten})`); g.addColorStop(1, 'rgba(210,215,255,0)');
      ctx.fillStyle = g; ctx.fillRect(offX, skyTop, LX * scale, LZ * scale);
      if (f.cg && f.xStrike != null && lead >= 1) {
        ctx.fillStyle = `rgba(255,255,255,${inten})`; ctx.beginPath(); ctx.arc(sx(f.xStrike), sy(0), 3 + 6 * inten, 0, 7); ctx.fill();
      }
      ctx.restore();
    }
    return glow;
  }

  // ---------------------------------------------------------------- audio
  let actx = null, master = null, rainSrc = null, rainGain = null, windGain = null, windFilt = null, voices = 0;
  function initAudio() {
    if (actx) return;
    actx = new (window.AudioContext || window.webkitAudioContext)();
    master = actx.createGain(); master.gain.value = 0.9; master.connect(actx.destination);
    const noise = (sec, brown) => {
      const b = actx.createBuffer(1, sec * actx.sampleRate, actx.sampleRate), d = b.getChannelData(0);
      let last = 0;
      for (let i = 0; i < d.length; i++) { const w = Math.random() * 2 - 1; if (brown) { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; } else d[i] = w; }
      return b;
    };
    rainSrc = actx.createBufferSource(); rainSrc.buffer = noise(3, false); rainSrc.loop = true;
    const rf = actx.createBiquadFilter(); rf.type = 'lowpass'; rf.frequency.value = 2200;
    rainGain = actx.createGain(); rainGain.gain.value = 0;
    rainSrc.connect(rf); rf.connect(rainGain); rainGain.connect(master); rainSrc.start();
    const ws = actx.createBufferSource(); ws.buffer = noise(4, true); ws.loop = true;
    windFilt = actx.createBiquadFilter(); windFilt.type = 'bandpass'; windFilt.frequency.value = 300; windFilt.Q.value = 0.7;
    windGain = actx.createGain(); windGain.gain.value = 0;
    ws.connect(windFilt); windFilt.connect(windGain); windGain.connect(master); ws.start();
  }
  function updateAmbience() {
    if (!actx || !state.sound) return;
    const d = model.diag, t = actx.currentTime;
    const r = clamp((d.rainF || 0) / 40, 0, 1), hz = (d.hailF || 0) > 5 ? 1 : 0;
    rainGain.gain.setTargetAtTime(0.16 * Math.sqrt(r) + 0.08 * hz, t, 0.4);
    const g = clamp((Math.abs(d.uG || 0) - 4) / 20, 0, 1);
    windGain.gain.setTargetAtTime(0.35 * g, t, 0.6);
    windFilt.frequency.setTargetAtTime(220 + 500 * g, t, 0.6);
  }
  // Thunder: each channel segment is an impulse arriving after d/343 s; near ones crack, far ones rumble.
  function thunder(f, xf) {
    if (!actx || voices >= 3) return;
    const pts = [];
    for (const b of f.branches) for (let j = 0; j < b.pts.length; j += 2) {
      const [x, z] = b.pts[j]; let dx = x - xf; if (dx > LX / 2) dx -= LX; else if (dx < -LX / 2) dx += LX;
      pts.push(Math.hypot(dx, z));
    }
    if (!pts.length) return;
    pts.sort((a, b) => a - b);
    const sr = actx.sampleRate, dmin = pts[0], dmax = pts[pts.length - 1];
    const dur = dmax / 343 + 2.5, n = Math.ceil(dur * sr);
    if (n > sr * 60) return;
    const buf = actx.createBuffer(1, n, sr), d = buf.getChannelData(0);
    const stride = Math.max(1, Math.floor(pts.length / 90));
    for (let p = 0; p < pts.length; p += stride) {
      const dist = pts[p], t0 = dist / 343, amp = 1.6 / Math.pow(dist / 1000 + 0.4, 1.15);
      const tau = 0.06 + dist / 30000, len = Math.min(n - Math.floor(t0 * sr), Math.floor(tau * 5 * sr));
      const o = Math.floor(t0 * sr);
      // low-pass the burst more the farther it travelled (air absorbs the highs)
      const k = clamp(1 - dist / 9000, 0.03, 1);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1; lp += k * (w - lp);
        d[o + i] += amp * lp * Math.exp(-i / (tau * sr));
      }
    }
    // the crack: a close strike front-loads a sharp broadband snap
    if (dmin < 2500) { const o = Math.floor(dmin / 343 * sr), len = Math.floor(0.05 * sr); for (let i = 0; i < len && o + i < n; i++) d[o + i] += (Math.random() * 2 - 1) * 2.5 * Math.exp(-i / (0.012 * sr)); }
    let peak = 0; for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(d[i]));
    const norm = Math.min(1, 0.9 / Math.max(peak, 1e-6)) * clamp(1.2 - dmin / 25000, 0.2, 1) * (f.cg ? 1 : 0.7);
    for (let i = 0; i < n; i++) d[i] *= norm;
    const src = actx.createBufferSource(); src.buffer = buf;
    const lpf = actx.createBiquadFilter(); lpf.type = 'lowpass'; lpf.frequency.value = clamp(4000 / (1 + dmin / 700), 70, 4000);
    src.connect(lpf); lpf.connect(master); src.start();
    voices++; src.onended = () => { voices--; };
  }

  // ---------------------------------------------------------------- draw the scene
  function fieldWind() { const d = model.diag; return d.uG || 0; }
  function draw(now) {
    ctx.clearRect(0, 0, W, H);
    // sky
    const sg = ctx.createLinearGradient(0, skyTop, 0, groundY);
    sg.addColorStop(0, '#0b1230'); sg.addColorStop(0.45, '#22437a'); sg.addColorStop(1, '#7fa6cf');
    ctx.fillStyle = sg; ctx.fillRect(0, 0, W, groundY);
    // clouds & precip image
    const flashGlow = state.visFlashes.reduce((m, v) => { const a = (now - v.t0) / 1000; return a < 0.6 && a > 0.2 ? Math.max(m, 0.35 * Math.exp(-(a - 0.2) / 0.15)) : m; }, 0);
    buildCloudImage(flashGlow);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(cloudCv, offX, skyTop, LX * scale, LZ * scale);
    // isotherms
    ctx.save(); ctx.setLineDash([4, 6]); ctx.lineWidth = 1; ctx.font = '10px ' + getComputedStyle(document.body).getPropertyValue('--mono');
    for (const tc of [0, -15, -40]) {
      const z = model.isoZ[tc]; if (z == null) continue;
      ctx.strokeStyle = 'rgba(255,255,255,.22)'; ctx.beginPath(); ctx.moveTo(offX, sy(z)); ctx.lineTo(offX + LX * scale, sy(z)); ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,.55)'; ctx.fillText(`${tc} °C · ${fmt(z * FT)} ft`, offX + LX * scale - 118, sy(z) - 3);
    }
    ctx.restore();
    // altitude scale
    ctx.save(); ctx.font = '10px ' + getComputedStyle(document.body).getPropertyValue('--mono'); ctx.fillStyle = 'rgba(255,255,255,.5)'; ctx.strokeStyle = 'rgba(255,255,255,.25)';
    for (let ft = 5000; ft <= 50000; ft += 5000) { const z = ft / FT; if (z > LZ) break; ctx.beginPath(); ctx.moveTo(offX, sy(z)); ctx.lineTo(offX + 6, sy(z)); ctx.stroke(); ctx.fillText(fmt(ft / 1000) + 'k', offX + 9, sy(z) + 3); }
    ctx.restore();
    // precipitation particles
    const dtv = state.dtVis;
    ctx.save(); ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(205,225,255,.38)'; ctx.beginPath();
    for (const p of drops) { const len = Math.min(22, Math.hypot(p.vx || 0, p.vz || -6) * scale * 0.9); const ang = Math.atan2(p.vz || -6, p.vx || 0); const X = sx(p.x), Y = sy(p.z); ctx.moveTo(X, Y); ctx.lineTo(X - Math.cos(ang) * len, Y + Math.sin(ang) * len); }
    ctx.stroke();
    ctx.fillStyle = 'rgba(240,245,255,.85)';
    for (const p of hail) { ctx.beginPath(); ctx.arc(sx(p.x), sy(p.z), p.r, 0, 7); ctx.fill(); }
    ctx.restore();
    // tracers
    if (state.tracers) {
      ctx.save(); ctx.lineWidth = 1.2;
      for (const p of tracers) {
        const w = p.w || 0, u = p.u || 0, sp = Math.hypot(u, w);
        const c = w > 1 ? `rgba(255,150,80,${Math.min(0.9, 0.35 + w / 20)})` : w < -1 ? `rgba(110,180,255,${Math.min(0.9, 0.35 - w / 20)})` : 'rgba(255,255,255,.3)';
        const L = clamp(sp * 0.7, 2, 14), X = sx(p.x), Y = sy(p.z);
        ctx.strokeStyle = c; ctx.beginPath(); ctx.moveTo(X, Y); ctx.lineTo(X - u / (sp + 1e-6) * L, Y + w / (sp + 1e-6) * L); ctx.stroke();
      }
      ctx.restore();
    }
    // wind arrows
    if (state.wind) {
      ctx.save(); ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.fillStyle = 'rgba(255,255,255,.55)'; ctx.lineWidth = 1;
      for (let k = 1; k < NZ; k += 4) for (let i = 2; i < NX; i += 6) {
        const n = k * NX + i, u = model.uc[n], w = model.wc[n], sp = Math.hypot(u, w); if (sp < 0.8) continue;
        const L = Math.min(26, 4 + sp * 0.9), X = sx((i + 0.5) * DX), Y = sy((k + 0.5) * DZ), ex = X + u / sp * L, ey = Y - w / sp * L;
        ctx.beginPath(); ctx.moveTo(X, Y); ctx.lineTo(ex, ey); ctx.stroke();
        const a = Math.atan2(-(w / sp), u / sp); ctx.beginPath(); ctx.moveTo(ex, ey); ctx.lineTo(ex - 5 * Math.cos(a - 0.5), ey - 5 * Math.sin(a - 0.5)); ctx.lineTo(ex - 5 * Math.cos(a + 0.5), ey - 5 * Math.sin(a + 0.5)); ctx.closePath(); ctx.fill();
      }
      ctx.restore();
    }
    // lightning
    const fl = drawFlashes(now);
    if (fl > 0) { ctx.fillStyle = `rgba(230,235,255,${0.10 * fl})`; ctx.fillRect(0, 0, W, groundY); }
    // ground
    drawGround();
    // probe ring
    const px = sx(model.probe.x), py = sy(model.probe.z);
    ctx.save(); ctx.strokeStyle = 'rgba(240,181,96,.95)'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(px, py, state.probeR, 0, 7); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(px - 16, py); ctx.lineTo(px - 6, py); ctx.moveTo(px + 6, py); ctx.lineTo(px + 16, py); ctx.moveTo(px, py - 16); ctx.lineTo(px, py - 6); ctx.moveTo(px, py + 6); ctx.lineTo(px, py + 16); ctx.stroke();
    ctx.restore();
  }
  function drawGround() {
    const t = model.t, us = model.us, xf = model.xField();
    const g = ctx.createLinearGradient(0, groundY, 0, H);
    g.addColorStop(0, '#2a3b2c'); g.addColorStop(0.15, '#1d2a20'); g.addColorStop(1, '#0a1020');
    ctx.fillStyle = g; ctx.fillRect(0, groundY, W, H - groundY);
    ctx.fillStyle = '#3a5a3c'; ctx.fillRect(0, groundY, W, 3);
    // wet ground under rain, cold-pool shade
    for (let i = 0; i < NX; i++) {
      const rr = model.rainRate[i]; if (rr > 0.5) { ctx.fillStyle = `rgba(120,160,220,${Math.min(0.45, rr / 80)})`; ctx.fillRect(sx(i * DX), groundY, DX * scale + 0.5, 3); }
    }
    ctx.save(); ctx.font = '10px ' + getComputedStyle(document.body).getPropertyValue('--mono'); ctx.fillStyle = 'rgba(255,255,255,.4)'; ctx.strokeStyle = 'rgba(255,255,255,.25)';
    // ground-fixed km ticks scrolling under the storm-relative frame
    const shift = ((us * t) % 5000 + 5000) % 5000;
    for (let xg = -shift; xg < LX; xg += 5000) {
      if (xg < 0) continue; const X = sx(xg);
      ctx.beginPath(); ctx.moveTo(X, groundY + 3); ctx.lineTo(X, groundY + 9); ctx.stroke();
    }
    ctx.fillText('5 km ticks · ground', offX + 6, groundY + 20);
    // the field
    const X = sx(xf);
    ctx.fillStyle = '#9aa3ad'; ctx.fillRect(X - 14, groundY - 1, 28, 3);
    ctx.fillStyle = 'rgba(255,255,255,.75)'; ctx.fillText('field', X - 12, groundY + 20);
    // windsock: ground-relative surface wind
    const u = fieldWind(), kt = Math.abs(u) * KT, dir = u >= 0 ? 1 : -1;
    const poleH = 22, sockL = 6 + Math.min(18, kt * 0.9), droop = Math.max(0, 10 - kt * 0.7);
    ctx.strokeStyle = '#c8ced6'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(X + 22, groundY); ctx.lineTo(X + 22, groundY - poleH); ctx.stroke();
    ctx.fillStyle = kt > 15 ? '#ff8a5a' : '#f0b560';
    ctx.beginPath(); ctx.moveTo(X + 22, groundY - poleH); ctx.lineTo(X + 22 + dir * sockL, groundY - poleH + droop - 2.5); ctx.lineTo(X + 22 + dir * sockL, groundY - poleH + droop + 2.5); ctx.lineTo(X + 22, groundY - poleH + 4); ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.75)'; ctx.fillText(`${fmt(kt)} kt`, X + 30, groundY - poleH + 4);
    // gust front markers
    const gf = model.diag.gustFront; if (gf) { ctx.fillStyle = 'rgba(140,190,255,.8)'; for (const x of gf) { ctx.beginPath(); ctx.moveTo(sx(x), groundY - 8); ctx.lineTo(sx(x) - 4, groundY); ctx.lineTo(sx(x) + 4, groundY); ctx.closePath(); ctx.fill(); } }
    const mb = model.diag.microburst; if (mb) { ctx.fillStyle = 'rgba(255,120,80,.9)'; ctx.fillText('microburst', sx(mb.x) - 26, groundY + 34); }
    ctx.restore();
  }

  // ---------------------------------------------------------------- readouts
  const rowsEl = $('rows');
  function readouts() {
    const d = model.diag, p = model.parcel, xf = d.xField;
    $('stage').textContent = d.stage || '—';
    const tt = model.t | 0; $('clock').textContent = `t+${String(Math.floor(tt / 60)).padStart(2, '0')}:${String(tt % 60).padStart(2, '0')}`;
    const rows = [
      ['top', d.anyCloud ? `${fmt(d.top * FT)} ft` : '—'],
      ['base', d.base != null ? `${fmt(d.base * FT)} ft` : '—'],
      ['updraft', `${fmt(d.maxW, 1)} m/s`],
      ['downdraft', `${fmt(d.minW, 1)} m/s`],
      ['rain · field', `${fmt(d.rainF, d.rainF < 10 ? 1 : 0)} mm/h${d.hailF > 1 ? ' · hail' : ''}`],
      ['rain · total', `${fmt(d.rainTotalF, 1)} mm`],
      ['gust · field', `${fmt(d.gustKt)} kt`],
      ['cold pool', `${fmt(d.coldMin, 1)} K`],
      ['charge max', `${fmt(d.maxChg * 1e9, 2)} nC/m³`],
      ['E max', `${fmt(d.eMax / 1e3)} kV/m`],
      ['E · field', `${fmt(d.eGroundF / 1e3, 1)} kV/m`],
      ['flashes', `${d.nFlash} · IC ${d.nIC} · CG ${d.nCG}`],
      ['last flash', d.since == null ? '—' : `${fmt(d.since)} s ago`],
      ['CAPE · CIN', `${fmt(p.cape)} · ${fmt(p.cin)} J/kg`],
      ['LCL · EL', `${p.lcl != null ? fmt(p.lcl * FT) : '—'} · ${p.el != null ? fmt(p.el * FT) : '—'} ft`],
    ];
    rowsEl.innerHTML = rows.map(([a, b]) => `<div class="row"><span>${a}</span><b>${b}</b></div>`).join('');
    const hz = { updraft: d.maxW > 15, downdraft: d.minW < -8, hail: d.hailAloft || d.hailMax > 1, microburst: !!d.microburst, gust: !!d.gustFront, lightning: d.since != null && d.since < 180, icing: d.icing };
    for (const el of document.querySelectorAll('#hz i')) { const k = el.dataset.h, on = !!hz[k]; el.classList.toggle('on', on); el.classList.toggle('red', on && (k === 'microburst' || k === 'hail' || (k === 'lightning' && d.since < 60))); }
    const b = state.bang;
    $('bang').textContent = b && performance.now() - b.t < 12000 ? `${b.cg ? 'CG' : 'IC'} flash → bang ${fmt(b.s)} s · ${fmt(b.nm, 1)} nm · ${fmt(b.q, 0)} C` : '';
  }

  // ---------------------------------------------------------------- sounding panel
  const sndc = $('sndc'), sctx = sndc.getContext('2d');
  const SW = 260, SH = 300;
  function sndX(T, z, pad) { return pad.l + (T - T0 + 40) * pad.kx + z * pad.skew; }
  function drawSounding() {
    const dpr = 2; sctx.setTransform(dpr, 0, 0, dpr, 0, 0); sctx.clearRect(0, 0, SW, SH);
    const pad = { l: 8, r: 34, t: 10, b: 18 };
    const zTop = LZ, ph = SH - pad.t - pad.b, pw = SW - pad.l - pad.r;
    pad.kx = pw / 80; pad.skew = pw * 0.55 / zTop;             // −40…+40 °C across, skewed right with height
    const Y = z => pad.t + ph * (1 - z / zTop);
    const mono = getComputedStyle(document.body).getPropertyValue('--mono');
    sctx.font = '9px ' + mono;
    // isotherms
    for (let tc = -80; tc <= 40; tc += 10) {
      sctx.strokeStyle = tc === 0 ? 'rgba(120,200,255,.5)' : 'rgba(255,255,255,.08)'; sctx.lineWidth = 1;
      sctx.beginPath(); sctx.moveTo(sndX(tc + T0, 0, pad), Y(0)); sctx.lineTo(sndX(tc + T0, zTop, pad), Y(zTop)); sctx.stroke();
      if (tc >= -40 && tc <= 40) { sctx.fillStyle = 'rgba(255,255,255,.4)'; sctx.fillText(tc, sndX(tc + T0, 0, pad) - 6, SH - 5); }
    }
    // altitude ticks
    sctx.fillStyle = 'rgba(255,255,255,.4)';
    for (let ft = 10000; ft <= 50000; ft += 10000) { const z = ft / FT; if (z > zTop) break; sctx.fillText(`${ft / 1000}k`, SW - 30, Y(z) + 3); }
    const { envFine: env, parcel: pc } = model;
    const dz = env.dz, nf = env.T.length;
    const zf = j => j * dz;
    // CAPE / CIN fills
    if (pc.lcl != null) {
      const fill = (z0, z1, color) => {
        if (z1 == null || z0 == null || z1 <= z0) return;
        sctx.fillStyle = color; sctx.beginPath();
        const j0 = Math.round(z0 / dz), j1 = Math.min(nf - 1, Math.round(z1 / dz));
        for (let j = j0; j <= j1; j++) sctx.lineTo(sndX(pc.Tp[j], zf(j), pad), Y(zf(j)));
        for (let j = j1; j >= j0; j--) sctx.lineTo(sndX(env.T[j], zf(j), pad), Y(zf(j)));
        sctx.closePath(); sctx.fill();
      };
      fill(pc.lcl, pc.lfc, 'rgba(100,160,255,.25)');
      fill(pc.lfc, pc.el, 'rgba(255,110,90,.28)');
    }
    // environment T, Td
    const path = (arr, color, width, dash) => {
      sctx.strokeStyle = color; sctx.lineWidth = width; sctx.setLineDash(dash || []); sctx.beginPath();
      for (let j = 0; j < arr.length; j++) { const T = arr[j]; if (!(T > 100)) continue; const x = sndX(T, zf(j), pad), y = Y(zf(j)); if (j === 0) sctx.moveTo(x, y); else sctx.lineTo(x, y); }
      sctx.stroke(); sctx.setLineDash([]);
    };
    const Td = new Float64Array(nf); for (let j = 0; j < nf; j++) Td[j] = M.tdew(env.q[j], env.p[j]) + T0;
    path(env.T, '#ff6b5a', 2); path(Td, '#5fd27a', 2); path(pc.Tp, '#ffd166', 1.5, [4, 3]);
    // live model column at the probe
    const col = model.column(model.probe.x);
    sctx.strokeStyle = 'rgba(255,255,255,.85)'; sctx.lineWidth = 1.2; sctx.beginPath();
    for (let k = 0; k < NZ; k++) { const x = sndX(col.T[k], model.z[k], pad), y = Y(model.z[k]); if (k === 0) sctx.moveTo(x, y); else sctx.lineTo(x, y); }
    sctx.stroke();
    sctx.strokeStyle = 'rgba(255,255,255,.5)'; sctx.setLineDash([2, 3]); sctx.beginPath();
    for (let k = 0; k < NZ; k++) { const x = sndX(Math.min(col.Td[k], col.T[k]), model.z[k], pad), y = Y(model.z[k]); if (k === 0) sctx.moveTo(x, y); else sctx.lineTo(x, y); }
    sctx.stroke(); sctx.setLineDash([]);
    // markers
    const mark = (z, label, color) => { if (z == null) return; sctx.strokeStyle = color; sctx.beginPath(); sctx.moveTo(pad.l, Y(z)); sctx.lineTo(pad.l + 14, Y(z)); sctx.stroke(); sctx.fillStyle = color; sctx.fillText(`${label} ${fmt(z * FT)}`, pad.l + 17, Y(z) + 3); };
    mark(pc.lcl, 'LCL', '#9ec5ff'); mark(pc.lfc, 'LFC', '#ffb08a'); mark(pc.el, 'EL', '#ffd166');
    // wind profile (ground-relative), right margin
    sctx.strokeStyle = 'rgba(255,255,255,.6)'; sctx.fillStyle = 'rgba(255,255,255,.6)'; sctx.lineWidth = 1;
    for (let z = 1000; z < zTop; z += 2000) { const k = Math.min(NZ - 1, Math.floor(z / DZ)); const u = model.uenv[k] + model.us, X = SW - 16, y = Y(z), L = clamp(Math.abs(u) * 0.5, 2, 12); sctx.beginPath(); sctx.moveTo(X - Math.sign(u) * L, y); sctx.lineTo(X + Math.sign(u) * L, y); sctx.stroke(); sctx.beginPath(); sctx.arc(X + Math.sign(u) * L, y, 1.6, 0, 7); sctx.fill(); }
    // legend
    sctx.fillStyle = '#ff6b5a'; sctx.fillText('T', pad.l + 4, 12); sctx.fillStyle = '#5fd27a'; sctx.fillText('Td', pad.l + 16, 12); sctx.fillStyle = '#ffd166'; sctx.fillText('parcel', pad.l + 34, 12); sctx.fillStyle = 'rgba(255,255,255,.85)'; sctx.fillText('model at probe', pad.l + 70, 12);
    $('capeline').innerHTML = `CAPE <b>${fmt(pc.cape)}</b> J/kg · CIN <b>${fmt(pc.cin)}</b> · LCL <b>${pc.lcl != null ? fmt(pc.lcl * FT) : '—'}</b> ft · EL <b>${pc.el != null ? fmt(pc.el * FT) : '—'}</b> ft · √(2·CAPE) <b>${fmt(Math.sqrt(2 * Math.max(0, pc.cape)))}</b> m/s`;
  }
  const SLIDERS = [
    ['ts', 'T sfc', 10, 42, 0.5, v => `${v} °C`], ['td', 'Td sfc', -5, 28, 0.5, v => `${v} °C`], ['ml', 'mixed layer', 300, 3500, 100, v => `${fmt(v)} m`],
    ['lapse', 'lapse', 5, 9.5, 0.1, v => `${(+v).toFixed(1)} K/km`], ['cap', 'cap', 0, 6, 0.1, v => `${(+v).toFixed(1)} K`], ['rhmid', 'RH mid', 10, 90, 5, v => `${v} %`],
    ['shear', 'shear 0–6 km', 0, 40, 1, v => `${v} m/s`], ['heat', 'heating', 0, 600, 25, v => `${v} W/m²`], ['chg', 'charging', 0.25, 4, 0.25, v => `${v}×`],
  ];
  function buildSliders() {
    const box = $('sliders'); box.innerHTML = '';
    for (const [key, label, min, max, step, f] of SLIDERS) {
      const l = document.createElement('label'); l.textContent = label; l.htmlFor = 'sl-' + key;
      const inp = document.createElement('input'); inp.type = 'range'; inp.min = min; inp.max = max; inp.step = step; inp.id = 'sl-' + key; inp.value = model.P[key];
      const out = document.createElement('output'); out.textContent = f(model.P[key]);
      inp.addEventListener('input', () => { out.textContent = f(inp.value); });
      inp.addEventListener('change', () => { const P = Object.assign({}, model.P); P[key] = +inp.value; applyParams(P, true); });
      box.append(l, inp, out);
    }
  }
  function syncSliders() { for (const [key, , , , , f] of SLIDERS) { const inp = $('sl-' + key); if (!inp) continue; inp.value = model.P[key]; inp.nextElementSibling.textContent = f(model.P[key]); } }
  function applyParams(P, keepPreset) {
    model.setParams(P);
    if (!keepPreset) syncSliders();
    drops.length = 0; hail.length = 0; state.visFlashes.length = 0; state.bang = null;
    drawSounding(); readouts();
  }

  // ---------------------------------------------------------------- microscope
  const lensc = $('lensc'), lctx = lensc.getContext('2d');
  const LW = 260, LH = 260, LR = 124, LCX = 130, LCY = 130;
  const lens = {
    mols: [], fx: [], t: 0, drop: { r: 0 }, ice: { r: 0, rot: 0 }, grp: { r: 0, y: -40, x: 0, bumps: [] }, rains: [], iceBits: [], lastChg: 0, lastRime: 0,
  };
  function newMol(type, x, y) {
    const a = Math.random() * Math.PI * 2;
    return { type, x: x == null ? LCX + (Math.random() - 0.5) * LR * 1.6 : x, y: y == null ? LCY + (Math.random() - 0.5) * LR * 1.6 : y, ang: a, spin: (Math.random() - 0.5) * 6, dir: Math.random() * Math.PI * 2, boost: 1, fly: null };
  }
  for (let i = 0; i < 60; i++) lens.mols.push(newMol(Math.random() < 0.79 ? 'N2' : 'O2'));
  const MASS = { N2: 28, O2: 32, H2O: 18 };
  function lensUpdate(dt) {
    const c = model.cellAt(model.probe.x, model.probe.z), pd = model.probeDiag || {};
    lens.t += dt; lens.cell = c; lens.pd = pd;
    const Tc = c.Tc, tspeed = Math.sqrt(Math.max(c.T, 150) / 288);
    // vapour population follows the mixing ratio
    const nV = clamp(Math.round(3 + 1700 * c.qv), 2, 34);
    let have = lens.mols.filter(m => m.type === 'H2O' && !m.fly).length;
    while (have < nV) { const a = Math.random() * 6.283; lens.mols.push(newMol('H2O', LCX + Math.cos(a) * (LR - 6), LCY + Math.sin(a) * (LR - 6))); have++; }
    if (have > nV + 2) { const idx = lens.mols.findIndex(m => m.type === 'H2O' && !m.fly); if (idx >= 0) lens.mols.splice(idx, 1); }
    // hydrometeors sized by content
    const tgt = { drop: c.qc > 2e-5 ? clamp(6 + 22 * Math.cbrt(c.qc / 1e-3), 6, 34) : 0, ice: c.qi > 4e-6 ? clamp(8 + 24 * Math.cbrt(c.qi / 1e-3), 8, 40) : 0, grp: c.qg > 1e-5 ? clamp(8 + 22 * Math.cbrt(c.qg / 2e-3), 8, 38) : 0 };
    lens.drop.r += (tgt.drop - lens.drop.r) * Math.min(1, dt * 2.5);
    lens.ice.r += (tgt.ice - lens.ice.r) * Math.min(1, dt * 2.5);
    lens.grp.r += (tgt.grp - lens.grp.r) * Math.min(1, dt * 2.5);
    lens.ice.rot += dt * 0.25;
    if (lens.grp.r > 1) { lens.grp.y += dt * (18 + 6 * (c.vg || 4)); lens.grp.x = LCX + 18 + 26 * Math.sin(lens.t * 0.7); if (lens.grp.y > LCY + LR + lens.grp.r) { lens.grp.y = LCY - LR - lens.grp.r; lens.grp.bumps.length = 0; } }
    if (c.qr > 1e-5) { if (Math.random() < dt * (0.6 + c.qr * 400)) lens.rains.push({ x: LCX + (Math.random() - 0.5) * LR * 1.7, y: LCY - LR - 8, r: 4 + Math.random() * 4 }); }
    for (let j = lens.rains.length - 1; j >= 0; j--) { const rd = lens.rains[j]; rd.y += dt * 95; if (rd.y > LCY + LR + 10) lens.rains.splice(j, 1); }
    // events driven by the model's tendencies at this cell (kg/kg per s)
    const ev = (rate, fn) => { if (rate <= 0) return; const p = Math.min(rate, 10) * dt; if (Math.random() < p) fn(); };
    const cond = pd.cond || 0, dep = pd.dep || 0, rime = pd.rime || 0, melt = pd.melt || 0, frz = pd.frz || 0, chg = pd.chg || 0, evapR = pd.evapR || 0;
    const dropPos = () => ({ x: LCX - 52, y: LCY + 28 }), icePos = () => ({ x: LCX + 50, y: LCY - 24 });
    const freeVapour = () => lens.mols.find(m => m.type === 'H2O' && !m.fly);
    if (lens.drop.r > 1) {
      ev(cond * 2.5e5, () => { const m = freeVapour(); if (m) m.fly = { to: 'drop', heat: 1 }; });
      ev(-cond * 2.5e5, () => { const p = dropPos(), a = Math.random() * 6.283, m = newMol('H2O', p.x + Math.cos(a) * lens.drop.r, p.y + Math.sin(a) * lens.drop.r); m.dir = a; m.boost = 1.6; lens.mols.push(m); lens.fx.push({ k: 'cool', x: p.x, y: p.y, t: 0 }); });
    }
    if (lens.ice.r > 1) {
      ev(dep * 3e5, () => { if (lens.drop.r > 1 && Tc < 0) { const p = dropPos(), a = Math.random() * 6.283, m = newMol('H2O', p.x + Math.cos(a) * lens.drop.r, p.y + Math.sin(a) * lens.drop.r); m.fly = { to: 'ice', heat: 1, wbf: true }; lens.mols.push(m); } else { const m = freeVapour(); if (m) m.fly = { to: 'ice', heat: 1 }; } });
      ev(-dep * 3e5, () => { const p = icePos(), a = Math.random() * 6.283, m = newMol('H2O', p.x + Math.cos(a) * lens.ice.r, p.y + Math.sin(a) * lens.ice.r); m.dir = a; m.boost = 1.5; lens.mols.push(m); lens.fx.push({ k: 'cool', x: p.x, y: p.y, t: 0 }); });
    }
    if (lens.grp.r > 1) {
      ev(rime * 2e5, () => { const a = Math.random() * 6.283; lens.fx.push({ k: 'rimedrop', x: LCX + (Math.random() - 0.5) * LR * 1.5, y: LCY + (Math.random() - 0.5) * LR * 1.5, t: 0 }); });
      ev(melt * 2e5, () => { lens.fx.push({ k: 'melt', x: lens.grp.x + (Math.random() - 0.5) * lens.grp.r, y: lens.grp.y + lens.grp.r, t: 0 }); });
      if (chg !== 0 && lens.t - lens.lastChg > 1.4) { lens.lastChg = lens.t; lens.iceBits.push({ x: lens.grp.x + (Math.random() < 0.5 ? -1 : 1) * (LR * 0.8), y: lens.grp.y + 40 + Math.random() * 30, vx: 0, hit: false, sgn: chg < 0 ? -1 : 1 }); }
    }
    if (frz > 0 && lens.drop.r > 1) ev(frz * 1e5, () => lens.fx.push({ k: 'freeze', x: dropPos().x, y: dropPos().y, r: lens.drop.r, t: 0 }));
    if (evapR > 0 && lens.rains.length) ev(evapR * 3e5, () => { const rd = lens.rains[0]; const m = newMol('H2O', rd.x, rd.y); m.boost = 1.4; lens.mols.push(m); lens.fx.push({ k: 'cool', x: rd.x, y: rd.y, t: 0 }); });
    // ice bits approaching the graupel (charging collisions)
    for (let j = lens.iceBits.length - 1; j >= 0; j--) {
      const b = lens.iceBits[j], dx = lens.grp.x - b.x, dy = lens.grp.y - b.y, dd = Math.hypot(dx, dy);
      if (!b.hit) { b.x += dx / dd * dt * 70; b.y += dy / dd * dt * 70 - dt * 12; if (dd < lens.grp.r + 7) { b.hit = true; b.vx = -dx / dd * 60; b.vy = -dy / dd * 60 - 20; lens.fx.push({ k: 'chg', x: b.x, y: b.y, t: 0, sgn: b.sgn, gx: lens.grp.x, gy: lens.grp.y }); } }
      else { b.x += b.vx * dt; b.y += b.vy * dt; b.charge = -b.sgn; if (Math.hypot(b.x - LCX, b.y - LCY) > LR + 10) lens.iceBits.splice(j, 1); }
    }
    // molecules
    for (let j = lens.mols.length - 1; j >= 0; j--) {
      const m = lens.mols[j];
      const sp = 26 * tspeed * Math.sqrt(28 / MASS[m.type]) * m.boost;
      m.boost += (1 - m.boost) * Math.min(1, dt * 1.5);
      if (m.fly) {
        const p = m.fly.to === 'drop' ? dropPos() : icePos(), R = m.fly.to === 'drop' ? lens.drop.r : lens.ice.r;
        const dx = p.x - m.x, dy = p.y - m.y, dd = Math.hypot(dx, dy);
        if (dd < R + 2 || R < 1) {
          lens.mols.splice(j, 1);
          if (R >= 1) { lens.fx.push({ k: m.fly.wbf ? 'wbf' : 'heat', x: m.x, y: m.y, t: 0 }); for (const o of lens.mols) if (Math.hypot(o.x - m.x, o.y - m.y) < 45) o.boost = Math.max(o.boost, 1.6); }
          continue;
        }
        m.x += dx / dd * dt * 110; m.y += dy / dd * dt * 110; m.ang += m.spin * dt; continue;
      }
      if (Math.random() < dt * 1.2) m.dir += (Math.random() - 0.5) * 2.2;
      m.x += Math.cos(m.dir) * sp * dt; m.y += Math.sin(m.dir) * sp * dt; m.ang += m.spin * dt;
      const rr = Math.hypot(m.x - LCX, m.y - LCY);
      if (rr > LR - 4) { const nx = (m.x - LCX) / rr, ny = (m.y - LCY) / rr; const vd = Math.cos(m.dir) * nx + Math.sin(m.dir) * ny; if (vd > 0) { const vx = Math.cos(m.dir) - 2 * vd * nx, vy = Math.sin(m.dir) - 2 * vd * ny; m.dir = Math.atan2(vy, vx); } m.x = LCX + nx * (LR - 4); m.y = LCY + ny * (LR - 4); }
      // bounce off hydrometeors
      const bounce = (cx, cy, R) => { if (R < 1) return; const d = Math.hypot(m.x - cx, m.y - cy); if (d < R + 3) { const nx = (m.x - cx) / d, ny = (m.y - cy) / d; m.dir = Math.atan2(ny, nx) + (Math.random() - 0.5) * 0.6; m.x = cx + nx * (R + 3); m.y = cy + ny * (R + 3); } };
      bounce(dropPos().x, dropPos().y, lens.drop.r); bounce(icePos().x, icePos().y, lens.ice.r); bounce(lens.grp.x, lens.grp.y, lens.grp.r);
    }
    for (let j = lens.fx.length - 1; j >= 0; j--) { const f = lens.fx[j]; f.t += dt; if (f.t > (f.k === 'chg' ? 1.6 : f.k === 'rimedrop' ? 1.2 : 0.7)) lens.fx.splice(j, 1); }
  }
  function hexPath(x, y, r, rot) { lctx.beginPath(); for (let i = 0; i < 6; i++) { const a = rot + i * Math.PI / 3; if (i === 0) lctx.moveTo(x + r * Math.cos(a), y + r * Math.sin(a)); else lctx.lineTo(x + r * Math.cos(a), y + r * Math.sin(a)); } lctx.closePath(); }
  function drawCrystal(x, y, r, rot, Tc, rhi) {
    lctx.save(); lctx.translate(x, y); lctx.rotate(rot);
    lctx.strokeStyle = 'rgba(200,235,255,.95)'; lctx.fillStyle = 'rgba(170,215,255,.35)'; lctx.lineWidth = 1.3;
    const habit = Tc > -4 ? 'plate' : Tc > -10 ? 'column' : Tc > -22 ? (Tc < -12 && Tc > -18 && rhi > 1.05 ? 'dendrite' : 'plate') : 'column';
    if (habit === 'column') { lctx.beginPath(); lctx.roundRect(-r * 0.28, -r, r * 0.56, 2 * r, 3); lctx.fill(); lctx.stroke(); lctx.beginPath(); lctx.moveTo(0, -r); lctx.lineTo(0, r); lctx.stroke(); }
    else if (habit === 'dendrite') { for (let i = 0; i < 6; i++) { const a = i * Math.PI / 3; lctx.beginPath(); lctx.moveTo(0, 0); lctx.lineTo(r * Math.cos(a), r * Math.sin(a)); lctx.stroke(); for (const f of [0.45, 0.7]) { const bx = r * f * Math.cos(a), by = r * f * Math.sin(a), bl = r * 0.3 * (1 - f * 0.5); lctx.beginPath(); lctx.moveTo(bx, by); lctx.lineTo(bx + bl * Math.cos(a + 1.05), by + bl * Math.sin(a + 1.05)); lctx.moveTo(bx, by); lctx.lineTo(bx + bl * Math.cos(a - 1.05), by + bl * Math.sin(a - 1.05)); lctx.stroke(); } } hexPath(0, 0, r * 0.25, 0); lctx.fill(); lctx.stroke(); }
    else { hexPath(0, 0, r, 0); lctx.fill(); lctx.stroke(); hexPath(0, 0, r * 0.55, 0); lctx.stroke(); }
    lctx.restore();
    return habit;
  }
  function lensDraw() {
    const dpr = 2; lctx.setTransform(dpr, 0, 0, dpr, 0, 0); lctx.clearRect(0, 0, LW, LH);
    const c = lens.cell; if (!c) return;
    const Tc = c.Tc;
    lctx.save(); lctx.beginPath(); lctx.arc(LCX, LCY, LR, 0, 7); lctx.clip();
    const warm = clamp((Tc + 10) / 40, 0, 1);
    lctx.fillStyle = `rgb(${Math.round(18 + 40 * warm)},${Math.round(30 + 10 * warm)},${Math.round(60 - 30 * warm)})`; lctx.fillRect(0, 0, LW, LH);
    // droplet
    const dp = { x: LCX - 52, y: LCY + 28 };
    if (lens.drop.r > 1) {
      const r = lens.drop.r, g = lctx.createRadialGradient(dp.x - r * 0.35, dp.y - r * 0.35, r * 0.1, dp.x, dp.y, r);
      g.addColorStop(0, 'rgba(210,235,255,.95)'); g.addColorStop(0.7, 'rgba(120,180,240,.75)'); g.addColorStop(1, 'rgba(70,130,210,.6)');
      lctx.fillStyle = g; lctx.beginPath(); lctx.arc(dp.x, dp.y, r, 0, 7); lctx.fill();
      lctx.fillStyle = 'rgba(255,240,200,.9)'; lctx.fillRect(dp.x - 1.5, dp.y - 1.5, 3, 3);   // the nucleus
    }
    const ip = { x: LCX + 50, y: LCY - 24 };
    let habit = null;
    if (lens.ice.r > 1) habit = drawCrystal(ip.x, ip.y, lens.ice.r, lens.ice.rot, Tc, c.rhi);
    // graupel
    if (lens.grp.r > 1) {
      const r = lens.grp.r, gx = lens.grp.x, gy = lens.grp.y;
      lctx.fillStyle = 'rgba(225,232,240,.92)'; lctx.strokeStyle = 'rgba(255,255,255,.7)'; lctx.lineWidth = 1;
      lctx.beginPath(); for (let i = 0; i < 18; i++) { const a = i / 18 * 6.283, rr = r * (0.86 + 0.14 * Math.sin(i * 2.7 + 1) * Math.cos(i * 1.3)); lctx.lineTo(gx + rr * Math.cos(a), gy + rr * Math.sin(a)); } lctx.closePath(); lctx.fill(); lctx.stroke();
      for (const b of lens.grp.bumps) { lctx.beginPath(); lctx.arc(gx + b[0], gy + b[1], 2.2, 0, 7); lctx.fill(); }
      if (Tc > 0) { lctx.fillStyle = 'rgba(120,180,240,.55)'; lctx.beginPath(); lctx.arc(gx, gy, r + 2, 0.2, Math.PI - 0.2); lctx.fill(); }
      if (c.chgG) { lctx.fillStyle = c.chgG < 0 ? '#7fb7ff' : '#ff8f8f'; lctx.font = 'bold 13px sans-serif'; lctx.fillText(c.chgG < 0 ? '−' : '+', gx - 4, gy + 5); }
    }
    // ice bits colliding with graupel
    for (const b of lens.iceBits) { hexPath(b.x, b.y, 6, lens.t); lctx.strokeStyle = 'rgba(200,235,255,.95)'; lctx.lineWidth = 1.2; lctx.stroke(); if (b.charge) { lctx.fillStyle = b.charge < 0 ? '#7fb7ff' : '#ff8f8f'; lctx.font = 'bold 11px sans-serif'; lctx.fillText(b.charge < 0 ? '−' : '+', b.x - 3, b.y + 4); } }
    // raindrops
    for (const rd of lens.rains) { lctx.fillStyle = 'rgba(140,190,245,.85)'; lctx.beginPath(); lctx.ellipse(rd.x, rd.y, rd.r * 1.15, rd.r * 0.8, 0, 0, 7); lctx.fill(); }
    // molecules
    for (const m of lens.mols) {
      if (m.type === 'H2O') {
        lctx.fillStyle = m.boost > 1.15 ? '#ff8f6a' : '#ff5c4d'; lctx.beginPath(); lctx.arc(m.x, m.y, 3.1, 0, 7); lctx.fill();
        lctx.fillStyle = '#f4f6ff'; for (const s of [-0.91, 0.91]) { lctx.beginPath(); lctx.arc(m.x + 4.4 * Math.cos(m.ang + s), m.y + 4.4 * Math.sin(m.ang + s), 2, 0, 7); lctx.fill(); }
      } else {
        lctx.fillStyle = m.type === 'N2' ? (m.boost > 1.15 ? '#a9c1e6' : '#7d93b5') : (m.boost > 1.15 ? '#ffb0a0' : '#d98a7a');
        for (const s of [-1, 1]) { lctx.beginPath(); lctx.arc(m.x + 2.4 * s * Math.cos(m.ang), m.y + 2.4 * s * Math.sin(m.ang), 2.5, 0, 7); lctx.fill(); }
      }
    }
    // effects
    for (const f of lens.fx) {
      const k = f.t / 0.7;
      if (f.k === 'heat' || f.k === 'wbf') { lctx.strokeStyle = `rgba(255,${f.k === 'wbf' ? 220 : 160},80,${1 - k})`; lctx.lineWidth = 1.5; lctx.beginPath(); lctx.arc(f.x, f.y, 4 + 30 * k, 0, 7); lctx.stroke(); }
      else if (f.k === 'cool') { lctx.strokeStyle = `rgba(120,190,255,${1 - k})`; lctx.lineWidth = 1.5; lctx.beginPath(); lctx.arc(f.x, f.y, 4 + 22 * k, 0, 7); lctx.stroke(); }
      else if (f.k === 'freeze') { lctx.strokeStyle = `rgba(200,240,255,${1 - k})`; lctx.lineWidth = 2; hexPath(f.x, f.y, f.r + 3 + 6 * k, 0.3); lctx.stroke(); }
      else if (f.k === 'rimedrop') { const q = f.t / 1.2, x = f.x + (lens.grp.x - f.x) * q, y = f.y + (lens.grp.y - f.y) * q; lctx.fillStyle = 'rgba(150,200,250,.9)'; lctx.beginPath(); lctx.arc(x, y, 3.2 * (1 - q * 0.5), 0, 7); lctx.fill(); if (q > 0.97) { lens.grp.bumps.push([(f.x - lens.grp.x) / Math.hypot(f.x - lens.grp.x, f.y - lens.grp.y) * lens.grp.r * 0.9, (f.y - lens.grp.y) / Math.hypot(f.x - lens.grp.x, f.y - lens.grp.y) * lens.grp.r * 0.9]); if (lens.grp.bumps.length > 26) lens.grp.bumps.shift(); lens.fx.push({ k: 'heat', x, y, t: 0 }); } }
      else if (f.k === 'melt') { lctx.fillStyle = `rgba(140,190,245,${1 - k})`; lctx.beginPath(); lctx.arc(f.x, f.y + 40 * k, 2.6, 0, 7); lctx.fill(); }
      else if (f.k === 'chg') { const q = f.t / 1.6; const sx1 = f.x + (f.gx - f.x) * Math.min(1, q * 2), sy1 = f.y + (f.gy - f.y) * Math.min(1, q * 2); lctx.font = 'bold 12px sans-serif'; lctx.fillStyle = f.sgn < 0 ? `rgba(127,183,255,${1 - q})` : `rgba(255,143,143,${1 - q})`; lctx.fillText(f.sgn < 0 ? '−' : '+', sx1 - 3, sy1 + 4); lctx.fillStyle = 'rgba(255,255,255,.8)'; lctx.font = '9px sans-serif'; if (q < 0.5) lctx.fillText('e⁻', f.x + 6, f.y - 6); }
    }
    lctx.restore();
    lctx.strokeStyle = 'rgba(240,181,96,.7)'; lctx.lineWidth = 1.5; lctx.beginPath(); lctx.arc(LCX, LCY, LR, 0, 7); lctx.stroke();
    // labels
    lctx.font = '9.5px ' + getComputedStyle(document.body).getPropertyValue('--mono'); lctx.fillStyle = 'rgba(255,255,255,.7)';
    if (lens.drop.r > 1) lctx.fillText('droplet', dp.x - 18, dp.y + lens.drop.r + 11);
    if (habit) lctx.fillText(habit, ip.x - 14, ip.y + lens.ice.r + 11);
    if (lens.grp.r > 1 && lens.grp.y > 20 && lens.grp.y < LH - 20) lctx.fillText(c.qg > 2e-3 ? 'hail' : 'graupel', lens.grp.x + lens.grp.r + 3, lens.grp.y + 3);
    lctx.fillText(`${fmt(model.probe.z * FT)} ft`, 6, 12);
    lctx.fillText(`${Tc.toFixed(1)} °C`, LW - 52, 12);
    // micro readouts
    const procs = [];
    const pd = lens.pd || {};
    const add = (v, thr, txt) => { if (Math.abs(v) > thr) procs.push([Math.abs(v), txt]); };
    add(pd.cond || 0, 2e-7, (pd.cond > 0 ? 'condensing · latent heat +' : 'evaporating · cooling') + ` ${fmt(Math.abs(pd.cond || 0) * C.LV / C.CP * 60, 2)} K/min`);
    add(pd.dep || 0, 1e-7, pd.dep > 0 ? (lens.drop.r > 1 && Tc < 0 ? 'Bergeron: eₛ ice < eₛ water → vapour leaves the droplet, grows the crystal' : 'deposition onto ice · latent heat +') : 'sublimating · cooling');
    add(pd.rime || 0, 1e-7, 'riming: droplets freeze onto graupel · fusion heat +');
    add(pd.frz || 0, 1e-7, Tc < -38 ? 'homogeneous freezing' : 'freezing · fusion heat +');
    add(pd.melt || 0, 1e-7, 'melting · cooling');
    add(pd.evapR || 0, 1e-7, 'rain evaporating · cooling → downdraft');
    add(Math.abs(pd.chg || 0) * 1e12, 0.01, pd.chg < 0 ? 'charging: graupel −, ice + (T < −15 °C)' : 'charging: graupel +, ice − (T > −15 °C)');
    procs.sort((a, b) => b[0] - a[0]);
    const g = v => fmt(v * 1e3, 2);
    $('micro').innerHTML =
      `T <b>${Tc.toFixed(1)} °C</b> · p <b>${fmt(c.p / 100)} hPa</b> · ρ <b>${c.rho.toFixed(2)}</b><br>` +
      `RH water <b>${fmt(c.rhw * 100)} %</b> · RH ice <b>${Tc < 0 ? fmt(c.rhi * 100) + ' %' : '—'}</b><br>` +
      `eₛ water <b>${(M.es(Tc) / 100).toFixed(2)}</b> · eₛ ice <b>${Tc < 0 ? (M.esi(Tc) / 100).toFixed(2) : '—'}</b> hPa<br>` +
      `vapour <b>${g(c.qv)}</b> · cloud <b>${g(c.qc)}</b> · rain <b>${g(c.qr)}</b> g/kg<br>` +
      `ice <b>${g(c.qi)}</b> · graupel <b>${g(c.qg)}</b> g/kg · w <b>${c.w >= 0 ? '+' : ''}${c.w.toFixed(1)} m/s</b><br>` +
      `charge <b>${fmt(c.chg * 1e9, 2)} nC/m³</b> · E <b>${fmt(c.e / 1e3)} kV/m</b><br>` +
      `<div class="proc">${procs.slice(0, 2).map(p => p[1]).join('<br>') || (c.qc + c.qi + c.qg + c.qr < 1e-6 ? 'clear air · molecules only' : 'quiet')}</div>`;
  }

  // ---------------------------------------------------------------- interaction
  function hitProbe(px, py) { return Math.hypot(px - sx(model.probe.x), py - sy(model.probe.z)) < state.probeR + 8; }
  sky.addEventListener('pointerdown', e => {
    const r = sky.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
    if (hitProbe(px, py)) { state.drag = 'probe'; sky.setPointerCapture(e.pointerId); return; }
    if (py < groundY && py > skyTop) {
      model.bubble(clamp(wx(px), 0, LX), clamp(wz(py), 300, LZ - 1000), 2.0, 2500, 900);
      $('hint').style.opacity = 0;
    }
  });
  sky.addEventListener('pointermove', e => {
    const r = sky.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
    if (state.drag === 'probe') { model.probe.x = clamp(wx(px), 0, LX - 1); model.probe.z = clamp(wz(py), 50, LZ - 50); return; }
    sky.style.cursor = hitProbe(px, py) ? 'grab' : 'crosshair';
  });
  sky.addEventListener('pointerup', () => { state.drag = null; });
  sky.addEventListener('pointercancel', () => { state.drag = null; });

  const presetSel = $('preset');
  for (const [k, v] of Object.entries(M.PRESETS)) { const o = document.createElement('option'); o.value = k; o.textContent = v.name; presetSel.appendChild(o); }
  presetSel.addEventListener('change', () => applyParams(Object.assign({}, M.PRESETS[presetSel.value])));
  function setRunning(on) { state.running = on; $('play').textContent = on ? '❚❚' : '▶'; state.lastT = performance.now(); }
  $('play').addEventListener('click', () => setRunning(!state.running));
  $('reset').addEventListener('click', () => applyParams(Object.assign({}, model.P), true));
  $('bubble').addEventListener('click', () => model.bubble(model.xField(), 1200, 2.5, 3000, 1000));
  $('speeds').addEventListener('click', e => { const b = e.target.closest('.chip'); if (!b) return; state.speed = +b.dataset.s; for (const c of $('speeds').children) c.classList.toggle('on', c === b); });
  $('layers').addEventListener('click', e => {
    const b = e.target.closest('.chip'); if (!b) return; const l = b.dataset.l;
    if (l === 'tracers') { state.tracers = !state.tracers; b.classList.toggle('on', state.tracers); return; }
    if (l === 'wind') { state.wind = !state.wind; b.classList.toggle('on', state.wind); return; }
    state.layer = state.layer === l ? null : l;
    for (const c of $('layers').querySelectorAll('.chip')) if (!['tracers', 'wind'].includes(c.dataset.l)) c.classList.toggle('on', c.dataset.l === state.layer);
  });
  function toggleSound() { state.sound = !state.sound; if (state.sound) { initAudio(); actx.resume(); } else if (actx) { rainGain.gain.value = 0; windGain.gain.value = 0; } $('sound').textContent = state.sound ? '🔊' : '🔇'; $('sound').classList.toggle('on', state.sound); }
  $('sound').addEventListener('click', toggleSound);
  $('helpbtn').addEventListener('click', () => $('help').classList.toggle('on'));
  $('helpclose').addEventListener('click', () => $('help').classList.remove('on'));
  window.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    const k = e.key.toLowerCase();
    if (k === ' ') { e.preventDefault(); setRunning(!state.running); }
    else if (k === 'r') $('reset').click();
    else if (k === 'b') $('bubble').click();
    else if (k === 's') toggleSound();
    else if (k === 't') $('layers').querySelector('[data-l=tracers]').click();
    else if (k >= '1' && k <= '5') $('speeds').children[+k - 1].click();
    else if (k === 'escape') $('help').classList.remove('on');
  });
  document.addEventListener('visibilitychange', () => { state.lastT = performance.now(); state.acc = 0; });

  // ---------------------------------------------------------------- main loop
  let sndTick = 0, readTick = 0;
  function frame(now) {
    const dtWall = Math.min(0.1, (now - state.lastT) / 1000); state.lastT = now;
    if (state.running) {
      state.acc += dtWall * state.speed;
      let steps = 0;
      while (state.acc >= DT && steps < 6) { model.step(); state.acc -= DT; steps++; }
      if (steps === 6) state.acc = 0;
      state.dtVis = clamp(dtWall * state.speed, 1.2, 6);
      spawnPrecip(state.dtVis);
      if (state.tracers) stepTracers(state.dtVis);
    }
    pollFlashes();
    const p0 = performance.now(); draw(now); const p1 = performance.now();
    lensUpdate(dtWall); lensDraw(); const p2 = performance.now();
    if ((readTick += dtWall) > 0.2) { readTick = 0; readouts(); updateAmbience(); }
    if ((sndTick += dtWall) > 0.5) { sndTick = 0; drawSounding(); }
    state.perf = { draw: p1 - p0, lens: p2 - p1, other: performance.now() - p2, frame: dtWall * 1000 };
    requestAnimationFrame(frame);
  }

  buildSliders();
  applyParams(Object.assign({}, M.PRESETS.pulse), true);
  setTimeout(() => { $('hint').style.opacity = 0; }, 9000);
  requestAnimationFrame(frame);

  window.STORM_DEBUG = Object.freeze({ get model() { return model; }, get state() { return state; } });
})();
