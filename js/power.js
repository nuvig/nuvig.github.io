/* The Power Curve — interactive explainer
   Power required Preq(V) = ½ρV³·S·CD0  +  2kW²/(ρVS)   (parasite + induced)
   Everything internal is SI (N, m, m/s, W); display converts to kt / hp / fpm.
   No dependencies. Three canvases:
     1. #pc-curve    Preq vs V, split into components, key speeds marked
     2. #pc-command  Preq + power-available line, two trim speeds, excess power
     3. #pc-sim      point-mass approach sim: the reversed-command trap
*/
(() => {
'use strict';

const $ = id => document.getElementById(id);

/* ── units & aircraft model ─────────────────────────────────── */
const RHO   = 1.225;          // kg/m^3, sea level
const S     = 16.16;          // m^2  (~174 ft^2)
const K     = 0.058;          // induced-drag factor 1/(pi e AR)
const G     = 9.80665;
const HP    = 745.7;          // W per hp
const PSHAFT_MAX = 160 * HP;  // 160 hp
const ETA   = 0.72;           // prop efficiency -> thrust power available
const PAV_MAX = PSHAFT_MAX * ETA;

const LB2N  = 4.44822;
const MS2KT = 1.94384;
const MS2FPM = 196.850;

const CONFIG = {
  clean: { cd0: 0.032, clmax: 1.5 },
  flaps: { cd0: 0.075, clmax: 2.1 },
};

const fmt = (n, d = 0) => n.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d });
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// power required (W) at true airspeed V (m/s) for weight W (N), config cd0
function preq(V, W, cd0) {
  const q = 0.5 * RHO * V * V;
  const parasite = q * V * S * cd0;               // ½ρV³ S CD0
  const induced  = 2 * K * W * W / (RHO * V * S);  // 2kW²/(ρVS)
  return { parasite, induced, total: parasite + induced };
}
// stall speed (m/s)
const vstall = (W, clmax) => Math.sqrt(2 * W / (RHO * S * clmax));
// minimum-power speed: Vmp = (2W/ρS)·√(k/(3·CD0)) ... solve numerically for robustness
function vminPower(W, cd0) {
  let best = 20, bp = Infinity;
  for (let V = 10; V < 90; V += 0.05) { const p = preq(V, W, cd0).total; if (p < bp) { bp = p; best = V; } }
  return { v: best, p: bp };
}
// min-drag / best-glide speed: minimize Preq/V  (= drag)
function vminDrag(W, cd0) {
  let best = 20, bd = Infinity;
  for (let V = 10; V < 110; V += 0.05) { const d = preq(V, W, cd0).total / V; if (d < bd) { bd = d; best = V; } }
  const D = bd; // N
  return { v: best, ld: W / D };
}
// the two speeds where Preq == Pav (trim speeds); returns {slow, fast} in m/s or null
function trimSpeeds(Pav, W, cd0, vsMin) {
  let slow = null, fast = null, prev = null;
  for (let V = vsMin; V < 110; V += 0.1) {
    const cur = preq(V, W, cd0).total - Pav;
    if (prev !== null && prev <= 0 !== cur <= 0) {
      const Vx = V - 0.1 + 0.1 * prev / (prev - cur); // linear crossing
      if (slow === null) slow = Vx; else fast = Vx;
    }
    prev = cur;
  }
  return { slow, fast };
}

/* ── crisp canvas at devicePixelRatio ───────────────────────── */
function setup(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.width, h = canvas.height;
  canvas.width = w * dpr; canvas.height = h * dpr;
  canvas.style.aspectRatio = `${w} / ${h}`;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  return { ctx, w, h };
}

const GRID = '#20242c', INK = '#98a2b3', INK2 = '#5d6675', ACC = '#4a9eff';
const ORANGE = '#f0a97f', BLUE = '#8ec2f2', WHITE = '#e6ecf5', RED = '#e2597a', GREEN = '#7fd8a2';

// axis frame helper for a Preq-vs-V plot
function axes(ctx, w, h, M, V0, V1, P1) {
  const X = v => M.l + (v - V0) / (V1 - V0) * (w - M.l - M.r);
  const Y = p => h - M.b - clamp(p, 0, P1) / P1 * (h - M.t - M.b);
  ctx.clearRect(0, 0, w, h);
  ctx.font = '11px system-ui';
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  const pstep = P1 <= 100000 ? 20000 : 40000;
  for (let p = 0; p <= P1 + 1; p += pstep) {
    ctx.strokeStyle = GRID; ctx.beginPath(); ctx.moveTo(M.l, Y(p)); ctx.lineTo(w - M.r, Y(p)); ctx.stroke();
    ctx.fillStyle = INK2; ctx.fillText(fmt(p / HP), M.l - 8, Y(p));
  }
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (let v = 40; v <= V1 * MS2KT; v += 10) {
    const vv = v / MS2KT; if (vv < V0 || vv > V1) continue;
    ctx.strokeStyle = GRID; ctx.beginPath(); ctx.moveTo(X(vv), M.t); ctx.lineTo(X(vv), h - M.b); ctx.stroke();
    ctx.fillStyle = INK2; ctx.fillText(v, X(vv), h - M.b + 7);
  }
  ctx.fillStyle = INK2;
  ctx.fillText('airspeed, kt', (M.l + w - M.r) / 2, h - 14);
  ctx.save(); ctx.translate(13, (M.t + h - M.b) / 2); ctx.rotate(-Math.PI / 2);
  ctx.fillText('power, hp', 0, 0); ctx.restore();
  return { X, Y };
}

function label(ctx, x, y, text, color, align = 'center') {
  ctx.font = '11px system-ui'; ctx.textAlign = align; ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = color; ctx.fillText(text, x, y);
}

/* ── 1 · anatomy of the curve ───────────────────────────────── */
const S1 = (() => {
  const { ctx, w, h } = setup($('pc-curve'));
  const M = { l: 52, r: 16, t: 16, b: 40 };
  const V0 = 40 / MS2KT, V1 = 135 / MS2KT, P1 = 120000;
  let showComp = true, cfg = 'clean';

  function draw() {
    const W = +$('c-weight').value * LB2N;
    const { cd0, clmax } = CONFIG[cfg];
    $('c-weight-val').innerHTML = `${fmt(+$('c-weight').value)} <span class="u">lb</span>`;
    const { X, Y } = axes(ctx, w, h, M, V0, V1, P1);

    const vs = vstall(W, clmax);
    const vmp = vminPower(W, cd0);
    const vmd = vminDrag(W, cd0);

    // shade region of reversed command (Vs .. Vmp)
    ctx.fillStyle = 'rgba(226,89,122,0.10)';
    ctx.fillRect(X(Math.max(vs, V0)), M.t, X(vmp.v) - X(Math.max(vs, V0)), h - M.t - M.b);
    label(ctx, (X(Math.max(vs, V0)) + X(vmp.v)) / 2, M.t + 14, 'reversed command', '#e2597a99');

    // stall barrier
    ctx.strokeStyle = RED; ctx.setLineDash([4, 4]); ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(X(vs), M.t); ctx.lineTo(X(vs), h - M.b); ctx.stroke();
    ctx.setLineDash([]);
    label(ctx, X(vs), h - M.b + 21, `Vs ${fmt(vs * MS2KT)}kt`, RED);

    // component curves
    if (showComp) {
      ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]);
      for (const [key, col] of [['parasite', ORANGE], ['induced', BLUE]]) {
        ctx.strokeStyle = col; ctx.beginPath(); let started = false;
        for (let V = vs; V <= V1; V += 0.4) {
          const p = preq(V, W, cd0)[key]; const x = X(V), y = Y(p);
          if (p > P1 && key === 'induced' && V > vs + 1) continue;
          started ? ctx.lineTo(x, y) : (ctx.moveTo(x, y), started = true);
        }
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    // total curve
    ctx.strokeStyle = WHITE; ctx.lineWidth = 2.4; ctx.beginPath();
    let started = false;
    for (let V = vs; V <= V1; V += 0.3) {
      const p = preq(V, W, cd0).total; const x = X(V), y = Y(p);
      started ? ctx.lineTo(x, y) : (ctx.moveTo(x, y), started = true);
    }
    ctx.stroke();

    // best-glide tangent: line from the origin corner touching the curve at min-drag speed
    ctx.strokeStyle = '#4c5768'; ctx.lineWidth = 1; ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(M.l, h - M.b);
    ctx.lineTo(X(vmd.v), Y(preq(vmd.v, W, cd0).total)); ctx.stroke();
    ctx.setLineDash([]);

    // markers: min power & best glide
    const mark = (V, col, txt) => {
      const p = preq(V, W, cd0).total;
      ctx.fillStyle = col; ctx.beginPath(); ctx.arc(X(V), Y(p), 4, 0, 7); ctx.fill();
    };
    mark(vmp.v, ACC);
    label(ctx, X(vmp.v), Y(vmp.p) + 22, `min power ${fmt(vmp.v * MS2KT)}kt`, ACC);
    mark(vmd.v, GREEN);
    label(ctx, X(vmd.v), Y(preq(vmd.v, W, cd0).total) - 10, `best glide ${fmt(vmd.v * MS2KT)}kt`, GREEN);

    // readouts
    $('c-vs').innerHTML = `${fmt(vs * MS2KT)} <span class="u">kt</span>`;
    $('c-vmp').innerHTML = `${fmt(vmp.v * MS2KT)} <span class="u">kt</span>`;
    $('c-vmd').innerHTML = `${fmt(vmd.v * MS2KT)} <span class="u">kt</span>`;
    $('c-pmin').innerHTML = `${fmt(vmp.p / HP, 1)} <span class="u">hp</span>`;
    $('c-ld').innerHTML = `${fmt(vmd.ld, 1)}`;
  }

  $('c-weight').addEventListener('input', draw);
  $('c-clean').addEventListener('click', () => { cfg = 'clean'; $('c-clean').classList.add('active'); $('c-flaps').classList.remove('active'); draw(); });
  $('c-flaps').addEventListener('click', () => { cfg = 'flaps'; $('c-flaps').classList.add('active'); $('c-clean').classList.remove('active'); draw(); });
  $('c-comp').addEventListener('click', () => { showComp = !showComp; $('c-comp').classList.toggle('active', showComp); draw(); });
  return { draw };
})();

/* ── 2 · region of reversed command ─────────────────────────── */
const S2 = (() => {
  const { ctx, w, h } = setup($('pc-command'));
  const M = { l: 52, r: 16, t: 16, b: 40 };
  const V0 = 40 / MS2KT, V1 = 135 / MS2KT, P1 = 120000;
  const W = 2300 * LB2N, cfg = CONFIG.clean;

  function draw() {
    const Pav = (+$('r-power').value / 100) * PAV_MAX;
    const V = (+$('r-speed').value) / MS2KT;
    $('r-power-val').innerHTML = `${$('r-power').value}<span class="u">%</span> · ${fmt(Pav / HP)}<span class="u">hp</span>`;
    $('r-speed-val').innerHTML = `${$('r-speed').value} <span class="u">kt</span>`;

    const { X, Y } = axes(ctx, w, h, M, V0, V1, P1);
    const vs = vstall(W, cfg.clmax);
    const vmp = vminPower(W, cfg.cd0);

    // reversed-command shading
    ctx.fillStyle = 'rgba(226,89,122,0.10)';
    ctx.fillRect(X(Math.max(vs, V0)), M.t, X(vmp.v) - X(Math.max(vs, V0)), h - M.t - M.b);
    label(ctx, (X(Math.max(vs, V0)) + X(vmp.v)) / 2, M.t + 14, 'reversed command', '#e2597a99');

    // stall barrier
    ctx.strokeStyle = RED; ctx.setLineDash([4, 4]); ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(X(vs), M.t); ctx.lineTo(X(vs), h - M.b); ctx.stroke();
    ctx.setLineDash([]);
    label(ctx, X(vs), h - M.b + 21, `Vs ${fmt(vs * MS2KT)}kt`, RED);

    // total curve
    ctx.strokeStyle = WHITE; ctx.lineWidth = 2.4; ctx.beginPath();
    let started = false;
    for (let v = vs; v <= V1; v += 0.3) {
      const p = preq(v, W, cfg.cd0).total;
      started ? ctx.lineTo(X(v), Y(p)) : (ctx.moveTo(X(v), Y(p)), started = true);
    }
    ctx.stroke();

    // power-available line
    ctx.strokeStyle = GREEN; ctx.lineWidth = 2; ctx.beginPath();
    ctx.moveTo(M.l, Y(Pav)); ctx.lineTo(w - M.r, Y(Pav)); ctx.stroke();
    label(ctx, w - M.r, Y(Pav) - 6, 'power available', GREEN, 'right');

    // trim speeds
    const tr = trimSpeeds(Pav, W, cfg.cd0, vs);
    const dot = (v, col) => { const p = preq(v, W, cfg.cd0).total; ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.moveTo(X(v), Y(p)); ctx.lineTo(X(v), h - M.b); ctx.stroke(); ctx.setLineDash([]); ctx.fillStyle = col; ctx.beginPath(); ctx.arc(X(v), Y(p), 4, 0, 7); ctx.fill(); };
    if (tr.slow) dot(tr.slow, ORANGE);
    if (tr.fast) dot(tr.fast, BLUE);

    // your current point
    const pv = preq(V, W, cfg.cd0).total;
    const excess = Pav - pv;
    ctx.fillStyle = excess >= 0 ? ACC : RED;
    ctx.beginPath(); ctx.arc(X(V), Y(pv), 6, 0, 7); ctx.fill();
    ctx.strokeStyle = '#fff8'; ctx.lineWidth = 1; ctx.stroke();
    // excess-power bar between curve and available line
    ctx.strokeStyle = excess >= 0 ? GREEN : RED; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(X(V), Y(pv)); ctx.lineTo(X(V), Y(Pav)); ctx.stroke();

    // readouts
    const vsRate = excess / W * MS2FPM; // rate = excess power / weight
    $('r-preq').innerHTML = `${fmt(pv / HP, 1)} <span class="u">hp</span>`;
    $('r-pav').innerHTML = `${fmt(Pav / HP, 1)} <span class="u">hp</span>`;
    $('r-vs').innerHTML = `${vsRate >= 0 ? '+' : ''}${fmt(vsRate)} <span class="u">fpm</span>`;
    $('r-slow').innerHTML = tr.slow ? `${fmt(tr.slow * MS2KT)} <span class="u">kt</span>` : '—';
    $('r-fast').innerHTML = tr.fast ? `${fmt(tr.fast * MS2KT)} <span class="u">kt</span>` : '—';

    // verdict
    const el = $('r-verdict');
    const backSide = V < vmp.v;
    if (!tr.slow) {
      el.className = 'verdict high';
      el.innerHTML = '<b>Not enough power to hold altitude at any speed.</b> The whole curve is above the throttle line — you can only descend. Add power or accept the sink.';
    } else if (V < vs) {
      el.className = 'verdict high';
      el.innerHTML = `<b>Below stall speed (${fmt(vs * MS2KT)} kt).</b> The wing quits before drag matters — this part of the curve isn't flyable.`;
    } else if (backSide) {
      el.className = 'verdict low';
      el.innerHTML = `<b>Back side / reversed command.</b> You're slower than min-power speed. To hold altitude here you'd need <b>${fmt(pv / HP, 1)} hp</b> — and going even slower needs <i>more</i>. Speed is unstable: get slow and you'll keep sinking. Add power, lower the nose.`;
    } else {
      el.className = 'verdict on';
      el.innerHTML = `<b>Front side — normal command.</b> Faster than min-power speed. ${excess >= 0 ? `You have <b>${fmt(excess / HP, 1)} hp</b> to spare for a ${fmt(vsRate)} fpm climb.` : 'Power required exceeds available, so you\'d sink — but pitch and power behave the way you expect.'}`;
    }
  }

  $('r-power').addEventListener('input', draw);
  $('r-speed').addEventListener('input', draw);
  return { draw };
})();

/* ── 3 · approach simulation ────────────────────────────────── */
const S3 = (() => {
  const { ctx, w, h } = setup($('pc-sim'));
  const cfg = CONFIG.flaps;         // on approach, flaps out
  let mode = 'trap';                // 'trap' | 'correct'
  let paused = false;
  let st, trail, done;

  const TACC = 3.5;            // time acceleration so a run resolves in a watchable ~10-15 s
  const HOLD_ALT = 32;        // altitude the "trap" pilot stubbornly tries to hold (m)

  function reset() {
    st = { V: 27, gamma: -0.05, h: 34, x: 0, t: 0,
           _n: 1, _Vs: 22, _stalled: false, _Preq: 30000, _nStall: 2 };  // ~54 kt, slight descent, low on final
    trail = [];
    done = null;
    $('s-state').textContent = '';
  }
  reset();

  // one physics step, dt seconds
  function step(dt) {
    const W = +$('s-weight').value * LB2N;
    const m = W / G;
    const Pav = (+$('s-power').value / 100) * PAV_MAX;
    const { cd0, clmax } = cfg;
    let { V, gamma, h: alt, x } = st;

    const q = 0.5 * RHO * V * V;
    const nStall = clmax * q * S / W;        // max load factor before stall at this speed
    const Vs = vstall(W, clmax);

    // pilot commanded load factor n
    let nCmd;
    if (mode === 'trap') {
      // pull to hold altitude: PD on altitude error + damp flight-path angle
      nCmd = Math.cos(gamma) + 1.1 * (HOLD_ALT - alt) / 22 - 2.2 * gamma;
    } else {
      // pitch for airspeed: hold Vref, let altitude go; add power handles glidepath
      const Vref = Vs * 1.3;                  // ~1.3 Vs target
      nCmd = Math.cos(gamma) + 0.055 * (V - Vref) - 1.6 * gamma;
    }
    // elevator can't exceed the wing: n limited by stall (and a sane pull limit)
    let stalled = false;
    let n = clamp(nCmd, 0.1, 2.2);
    if (n > nStall) { n = nStall; stalled = true; }

    // forces
    const CL = n * W / (q * S);
    const CD = cd0 + K * CL * CL;
    const D = q * S * CD;
    const T = Pav / Math.max(V, 12);         // thrust from available power

    // longitudinal point-mass equations
    const dV = (T - D - W * Math.sin(gamma)) / m;
    const dGamma = (G / V) * (n - Math.cos(gamma));
    V += dV * dt;
    gamma += dGamma * dt;
    V = clamp(V, 14, 80);
    alt += V * Math.sin(gamma) * dt;
    x += V * Math.cos(gamma) * dt;

    st = { V, gamma, h: alt, x, t: st.t + dt };
    st._n = n; st._Vs = Vs; st._stalled = stalled;
    st._D = D; st._Pav = Pav; st._Preq = preq(V, W, cd0).total; st._nStall = nStall;

    if (alt <= 0 && !done) {
      // touchdown or crash: judge by descent rate & speed
      const vsi = V * Math.sin(gamma) * MS2FPM;
      done = (vsi < -600 || stalled || V < Vs * 1.05) ? 'crash' : 'land';
    }
    if (st.t > 60) done = done || 'timeout';
  }

  function draw() {
    const W = +$('s-weight').value * LB2N;
    $('s-power-val').innerHTML = `${$('s-power').value}<span class="u">%</span>`;
    $('s-weight-val').innerHTML = `${fmt(+$('s-weight').value)} <span class="u">lb</span>`;

    ctx.clearRect(0, 0, w, h);
    const groundY = h - 46;

    // sky/ground
    ctx.fillStyle = '#101822'; ctx.fillRect(0, 0, w, groundY);
    ctx.fillStyle = '#15130e'; ctx.fillRect(0, groundY, w, h - groundY);
    ctx.strokeStyle = '#3a3222'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(0, groundY); ctx.lineTo(w, groundY); ctx.stroke();

    // altitude scale: map 0..90 m to groundY..top
    const H1 = 90, topY = 30;
    const AY = a => groundY - clamp(a, -5, H1) / H1 * (groundY - topY);
    // world x scale: keep airplane at a fixed screen column, scroll world under it
    const planeX = w * 0.30;
    const XPX = wx => planeX + (wx - st.x) * 1.9;

    // "hold altitude" reference the trap pilot is fighting to keep
    ctx.strokeStyle = '#2b3a4a'; ctx.setLineDash([4, 5]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, AY(HOLD_ALT)); ctx.lineTo(w, AY(HOLD_ALT)); ctx.stroke();
    ctx.setLineDash([]);
    label(ctx, w - 12, AY(HOLD_ALT) - 5, 'altitude to hold', '#4a6a8a', 'right');
    // aim point on the ground ahead
    const aimX = st.x + 60;
    ctx.fillStyle = '#4a6a4a'; ctx.fillRect(XPX(aimX) - 1, groundY - 10, 3, 10);
    label(ctx, XPX(aimX), groundY + 18, 'aim point', '#6a8a6a');

    // trail
    trail.push({ x: st.x, h: st.h });
    if (trail.length > 400) trail.shift();
    ctx.strokeStyle = '#3d5a7a'; ctx.lineWidth = 1.5; ctx.beginPath();
    trail.forEach((p, i) => { const px = XPX(p.x), py = AY(p.h); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
    ctx.stroke();

    // airplane
    const px = XPX(st.x), py = AY(st.h);
    const pitch = -(st.gamma + 0.05) - (st._n > 1 ? (st._n - 1) * 0.08 : 0); // rough body attitude
    ctx.save(); ctx.translate(px, py); ctx.rotate(-pitch);
    ctx.fillStyle = st._stalled ? RED : '#cfe6ff';
    ctx.beginPath();
    ctx.moveTo(14, 0); ctx.lineTo(-10, -5); ctx.lineTo(-6, 0); ctx.lineTo(-10, 5); ctx.closePath(); ctx.fill();
    ctx.fillRect(-2, -9, 3, 18); // wing
    ctx.restore();

    // stall flag
    if (st._stalled && !done) {
      ctx.fillStyle = RED; ctx.font = 'bold 13px system-ui'; ctx.textAlign = 'center';
      ctx.fillText('STALL', px, py - 20);
    }

    // readouts
    const kt = st.V * MS2KT;
    const vsi = st.V * Math.sin(st.gamma) * MS2FPM;
    const CL = st._n * W / (0.5 * RHO * st.V * st.V * S);
    const aoaMargin = (st._Vs ? (st.V - st._Vs) * MS2KT : 0);
    $('s-ias').innerHTML = `${fmt(kt)} <span class="u">kt</span>`;
    $('s-vsi').innerHTML = `${vsi >= 0 ? '+' : ''}${fmt(vsi)} <span class="u">fpm</span>`;
    $('s-aoa').innerHTML = `CL ${fmt(CL, 2)}`;
    $('s-preq').innerHTML = `${fmt(st._Preq / HP, 1)} <span class="u">hp</span>`;
    $('s-margin').innerHTML = `${aoaMargin >= 0 ? '+' : ''}${fmt(aoaMargin)} <span class="u">kt</span>`;
    $('s-margin').parentElement.classList.toggle('warn', aoaMargin < 8);

    // verdict
    const el = $('s-verdict');
    if (done === 'crash') {
      el.className = 'verdict high';
      el.innerHTML = mode === 'trap'
        ? '<b>Stalled it in short of the aim point.</b> Pulling to hold altitude bled the airspeed, induced drag climbed, and the sink accelerated — a textbook back-side descent into the ground. Power for altitude, pitch for airspeed.'
        : '<b>Descent too steep to arrest.</b> With this little throttle no technique holds altitude — the correct call is more power or a go-around.';
      $('s-state').textContent = '● stopped';
    } else if (done === 'land') {
      el.className = 'verdict on';
      el.innerHTML = '<b>Flew it down under control.</b> Trading altitude to keep the airspeed kept you off the back side; the airplane stayed responsive to the flare.';
      $('s-state').textContent = '● stopped';
    } else if (done === 'timeout') {
      el.className = 'verdict low';
      el.innerHTML = '<b>Stabilized.</b> This power and technique holds a steady flight path.';
      $('s-state').textContent = '● stopped';
    } else if (mode === 'trap') {
      el.className = 'verdict low';
      el.innerHTML = 'Holding altitude with back pressure. Watch the airspeed and sink rate as the airplane walks left along the power curve.';
    } else {
      el.className = 'verdict on';
      el.innerHTML = 'Pitching to hold the target approach speed, using the throttle for the glidepath. Speed stays put; altitude is the variable.';
    }
  }

  let last = performance.now();
  function loop(now) {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    if (!paused && !done) { const sub = dt * TACC; for (let i = 0; i < 5; i++) step(sub / 5); }
    draw();
    requestAnimationFrame(loop);
  }

  $('s-power').addEventListener('input', draw);
  $('s-weight').addEventListener('input', draw);
  $('s-trap').addEventListener('click', () => { mode = 'trap'; $('s-trap').classList.add('active'); $('s-correct').classList.remove('active'); reset(); });
  $('s-correct').addEventListener('click', () => { mode = 'correct'; $('s-correct').classList.add('active'); $('s-trap').classList.remove('active'); reset(); });
  $('s-reset').addEventListener('click', reset);
  $('s-pause').addEventListener('click', () => { paused = !paused; $('s-pause').classList.toggle('active', paused); $('s-pause').textContent = paused ? '▶ Resume' : '⏸ Pause'; });
  requestAnimationFrame(loop);
  return { draw };
})();

/* ── init ───────────────────────────────────────────────────── */
S1.draw();
S2.draw();
})();
