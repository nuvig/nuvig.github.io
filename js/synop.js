// Surface analysis easter egg for the homepage: a pressure field of draggable
// highs and lows behind the page, contoured every frame, with geostrophic wind
// tracers running along the isobars. Loaded lazily by home.js (click the
// location line or press P); nothing here is referenced from HTML.
//
// Field: 1013 mb + one Gaussian per system (signed amplitude = central
// pressure − 1013) + low-frequency noise. Contours by marching squares on a
// 12 px grid. Tracers move ⟂ ∇p with low pressure on the left (NH), speed ∝
// |∇p|; the pointer stirs nearby tracers; dragging a system carries its wind.
// Wheel / ↑↓ over a marker sets its central pressure 1 mb a notch; past 1013
// it flips sign. Drag a marker off the edge to remove it.
(() => {
  if (window.SYNOP) { window.SYNOP.toggle(); return; }

  const S = {
    on: false, raf: 0, c: null, g: null, panel: null,
    sys: [], tracers: [], N: 1400, speed: 0.5, gap: 2, stir: false,
    ptr: { x: -1, y: -1, vx: 0, vy: 0, t: 0 }, drag: null, hover: -1, last: 0,
  };
  const rnd = (i, j) => { const n = Math.sin(i * 127.1 + j * 311.7) * 43758.5453; return n - Math.floor(n); };
  const sm = (t) => t * t * (3 - 2 * t);
  const noise = (x, y) => { const i = Math.floor(x), j = Math.floor(y), u = sm(x - i), v = sm(y - j);
    return (rnd(i, j) * (1 - u) + rnd(i + 1, j) * u) * (1 - v) + (rnd(i, j + 1) * (1 - u) + rnd(i + 1, j + 1) * u) * v; };

  const mkSys = (p, x, y) => ({ p, x, y, r: .22 + Math.random() * .2, ax: .06 + Math.random() * .06, ay: .04 + Math.random() * .04,
    fx: 1 / (70 + Math.random() * 60), fy: 1 / (70 + Math.random() * 60), ph: Math.random() * 6.28 });
  const defaultSys = () => [
    Object.assign(mkSys(999, .72, .28), { r: .34 }),
    Object.assign(mkSys(1025, .18, .80), { r: .42 }),
    Object.assign(mkSys(1007, .30, .15), { r: .22 }),
  ];
  const mkTracer = () => ({ x: Math.random(), y: Math.random(), px: 0, py: 0, life: Math.random() * 400 });
  const wander = (o, ts) => [o.ax * Math.sin(ts * o.fx * 6.28 + o.ph), o.ay * Math.cos(ts * o.fy * 6.28 + o.ph)];
  let pos = [];

  /* ------------------------------ input ------------------------------- */
  const overUI = (e) => e.target && e.target.closest && e.target.closest('a, button, input, label, select, textarea, #sim-controls, #sim, #synop-panel');
  const hit = (e) => { const s = devicePixelRatio; let best = -1, bd = 34 * s;
    pos.forEach((p, k) => { const d = Math.hypot(e.clientX * s - p.x * S.c.width, e.clientY * s - p.y * S.c.height); if (d < bd) { bd = d; best = k; } });
    return best; };
  const onDown = (e) => { if (overUI(e)) return; const k = hit(e); if (k < 0) return; e.preventDefault();
    S.drag = { k, dx: e.clientX / innerWidth - pos[k].x, dy: e.clientY / innerHeight - pos[k].y, id: e.pointerId }; };
  const onMove = (e) => {
    const P = S.ptr, now = performance.now(), dtp = Math.max(8, now - P.t), nx = e.clientX / innerWidth, ny = e.clientY / innerHeight;
    if (P.x >= 0) { P.vx = P.vx * .5 + ((nx - P.x) / dtp * 1000) * .5; P.vy = P.vy * .5 + ((ny - P.y) / dtp * 1000) * .5; }
    P.x = nx; P.y = ny; P.t = now;
    if (S.drag && e.pointerId === S.drag.id) { const o = S.sys[S.drag.k], w = wander(o, now / 1000);
      o.x = nx - S.drag.dx - w[0]; o.y = ny - S.drag.dy - w[1]; return; }
    S.hover = overUI(e) ? -1 : hit(e); document.body.style.cursor = S.hover >= 0 ? 'grab' : ''; };
  const onUp = (e) => { if (!S.drag || e.pointerId !== S.drag.id) return;
    const k = S.drag.k, p = pos[k]; S.drag = null;
    if (p && (p.x < -.02 || p.x > 1.02 || p.y < -.02 || p.y > 1.02)) S.sys.splice(k, 1); };
  const adjust = (k, d) => { const o = S.sys[k]; if (!o) return; let v = o.p - 1013 + d; v = Math.max(-40, Math.min(40, v));
    if (Math.abs(v) < 1) v = d > 0 ? 1 : -1; o.p = 1013 + v; };
  const onWheel = (e) => { if (overUI(e)) return; const k = S.drag ? S.drag.k : hit(e); if (k < 0) return; e.preventDefault(); adjust(k, e.deltaY < 0 ? 1 : -1); };
  const onKey = (e) => {
    if (e.key === 'Escape' && S.on && !document.body.classList.contains('sim-open')) { e.preventDefault(); stop(); return; }
    const k = S.drag ? S.drag.k : S.hover; if (k < 0) return;
    if (e.key === 'ArrowUp' || e.key === '+' || e.key === '=') { e.preventDefault(); adjust(k, 1); }
    if (e.key === 'ArrowDown' || e.key === '-') { e.preventDefault(); adjust(k, -1); } };
  const onResize = () => { S.c.width = innerWidth * devicePixelRatio; S.c.height = innerHeight * devicePixelRatio; };
  const bind = (on) => { const f = on ? 'addEventListener' : 'removeEventListener';
    document[f]('pointerdown', onDown, true); document[f]('pointermove', onMove, true);
    document[f]('pointerup', onUp, true); document[f]('pointercancel', onUp, true);
    document[f]('wheel', onWheel, { capture: true, passive: false }); document[f]('keydown', onKey, true);
    window[f]('resize', onResize); };

  /* ------------------------------ frame ------------------------------- */
  const tick = (t) => {
    if (!S.on) return;
    if (document.hidden) { S.raf = requestAnimationFrame(tick); return; }
    const c = S.c, g = S.g, W = c.width, H = c.height, s = devicePixelRatio;
    const dt = Math.min(50, t - S.last || 16); S.last = t; const ts = t / 1000, asp = W / H;
    pos = S.sys.map((o) => { const w = wander(o, ts); return { x: o.x + w[0], y: o.y + w[1] }; });
    const P = (u, v) => { let p = 1013;
      for (let k = 0; k < S.sys.length; k++) { const o = S.sys[k], dx = (u - pos[k].x) * asp, dy = v - pos[k].y;
        p += (o.p - 1013) * Math.exp(-(dx * dx + dy * dy) / (2 * o.r * o.r)); }
      return p + 4 * (noise(u * 2.2 * asp + ts / 60, v * 2.2 + 7) - .5); };
    const step = 12 * s, cols = Math.ceil(W / step) + 1, rows = Math.ceil(H / step) + 1;
    const F = new Float32Array(cols * rows);
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) F[j * cols + i] = P(i * step / W, j * step / H);
    g.clearRect(0, 0, W, H);
    g.lineWidth = 1 * s; g.lineJoin = 'round';
    for (let lv = 972; lv <= 1056; lv += S.gap) {
      const major = lv % 8 === 0;
      g.strokeStyle = `rgba(150,180,225,${major ? .3 : .13})`; g.beginPath();
      for (let j = 0; j < rows - 1; j++) for (let i = 0; i < cols - 1; i++) {
        const a = F[j * cols + i], b = F[j * cols + i + 1], cc = F[(j + 1) * cols + i + 1], d = F[(j + 1) * cols + i];
        if ((a < lv) === (b < lv) && (b < lv) === (cc < lv) && (cc < lv) === (d < lv)) continue;
        const x = i * step, y = j * step, pts = [];
        const ip = (p, q, x1, y1, x2, y2) => { const tt = (lv - p) / (q - p); return [x1 + (x2 - x1) * tt, y1 + (y2 - y1) * tt]; };
        if ((a < lv) !== (b < lv)) pts.push(ip(a, b, x, y, x + step, y));
        if ((b < lv) !== (cc < lv)) pts.push(ip(b, cc, x + step, y, x + step, y + step));
        if ((cc < lv) !== (d < lv)) pts.push(ip(cc, d, x + step, y + step, x, y + step));
        if ((d < lv) !== (a < lv)) pts.push(ip(d, a, x, y + step, x, y));
        if (pts.length === 2) { g.moveTo(pts[0][0], pts[0][1]); g.lineTo(pts[1][0], pts[1][1]); }
        else if (pts.length === 4) { g.moveTo(pts[0][0], pts[0][1]); g.lineTo(pts[1][0], pts[1][1]); g.moveTo(pts[2][0], pts[2][1]); g.lineTo(pts[3][0], pts[3][1]); }
      }
      g.stroke();
    }
    // tracers
    const grad = (u, v) => { const gxq = u * W / step, gyq = v * H / step;
      const i = Math.max(1, Math.min(cols - 3, Math.floor(gxq))), j = Math.max(1, Math.min(rows - 3, Math.floor(gyq)));
      const fu = gxq - i, fv = gyq - j, at = (ii, jj) => F[jj * cols + ii];
      const dxl = (at(i + 1, j) - at(i - 1, j)) * (1 - fv) + (at(i + 1, j + 1) - at(i - 1, j + 1)) * fv;
      const dyl = (at(i, j + 1) - at(i, j - 1)) * (1 - fu) + (at(i + 1, j + 1) - at(i + 1, j - 1)) * fu;
      return [dxl / 2 * cols, dyl / 2 * rows]; };
    while (S.tracers.length < S.N) S.tracers.push(mkTracer());
    if (S.tracers.length > S.N) S.tracers.length = S.N;
    const pt = S.ptr, decay = Math.exp(-dt / 400); pt.vx *= decay; pt.vy *= decay;
    const stir = S.stir && Math.hypot(pt.vx, pt.vy) > .02, R = .09;
    g.lineWidth = 1.4 * s; g.lineCap = 'round';
    for (const tr of S.tracers) {
      const [gx, gy] = grad(tr.x, tr.y);
      let vx = gy / asp, vy = -gx;
      if (stir) { const dx = (tr.x - pt.x) * asp, dy = tr.y - pt.y, d2 = dx * dx + dy * dy;
        if (d2 < R * R) { const w = 1 - Math.sqrt(d2) / R; vx += pt.vx * 900 * w * w; vy += pt.vy * 900 * w * w; } }
      const spd = Math.hypot(vx, vy), k = .0000045 * dt * S.speed;
      tr.px = tr.x; tr.py = tr.y; tr.x += vx * k / asp; tr.y += vy * k;
      tr.life -= dt / 16;
      if (tr.life <= 0 || tr.x < 0 || tr.x > 1 || tr.y < 0 || tr.y > 1) { tr.x = Math.random(); tr.y = Math.random(); tr.px = tr.x; tr.py = tr.y; tr.life = 250 + Math.random() * 350; continue; }
      const fade = Math.min(1, tr.life / 60, (600 - tr.life) / 60);
      g.strokeStyle = `rgba(190,215,255,${Math.min(.55, .05 + spd * .006) * fade})`;
      const dx = (tr.x - tr.px) * W, dy = (tr.y - tr.py) * H;
      g.beginPath(); g.moveTo(tr.px * W - dx * 5, tr.py * H - dy * 5); g.lineTo(tr.x * W, tr.y * H); g.stroke();
    }
    // markers
    g.textAlign = 'center'; g.textBaseline = 'middle';
    S.sys.forEach((o, k) => { const x = pos[k].x * W, y = pos[k].y * H, low = o.p < 1013;
      const big = Math.abs(o.p - 1013) >= 8, act = (S.drag && S.drag.k === k) || S.hover === k, A = act ? .9 : .5;
      if (act) { g.strokeStyle = 'rgba(255,255,255,.25)'; g.lineWidth = 1 * s; g.beginPath(); g.arc(x, y, 30 * s, 0, 6.28); g.stroke(); }
      g.fillStyle = low ? `rgba(255,130,130,${A})` : `rgba(130,175,255,${A})`;
      g.font = `600 ${(big ? 40 : 26) * s}px Segoe UI, system-ui`; g.fillText(low ? 'L' : 'H', x, y);
      if (!big && !act) return;
      g.font = `${13 * s}px Segoe UI, system-ui`; g.fillStyle = `rgba(200,215,240,${act ? .8 : .4})`; g.fillText(Math.round(P(pos[k].x, pos[k].y)) + ' mb', x, y + 30 * s);
      if (act) { g.font = `${11 * s}px Segoe UI, system-ui`; g.fillStyle = 'rgba(200,215,240,.5)'; g.fillText('scroll · ↑↓', x, y + 46 * s); } });
    S.raf = requestAnimationFrame(tick);
  };

  /* ------------------------------ panel ------------------------------- */
  const CSS = `
#synop-canvas { position: fixed; inset: 0; width: 100vw; height: 100vh; z-index: -1; pointer-events: none; }
#synop-panel { position: fixed; left: 16px; bottom: 16px; z-index: 900; background: rgba(12,18,32,.88); border: 1px solid #333;
  border-radius: 8px; padding: 8px 10px; font-size: 12px; color: #ccc; display: grid; gap: 6px; backdrop-filter: blur(4px); }
#synop-panel .r { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
#synop-panel button { background: #1a1a1a; color: #ddd; border: 1px solid #3a3a3a; border-radius: 5px; padding: 3px 8px; cursor: pointer; font-size: 12px; }
#synop-panel button:hover { border-color: var(--accent, #4a9eff); }
#synop-panel label { display: flex; gap: 6px; align-items: center; color: #999; }
#synop-panel input[type=range] { width: 90px; accent-color: var(--accent, #4a9eff); }
#synop-panel .hint { color: #666; }
#synop-panel .x { margin-left: auto; }
@media (max-width: 600px) { #synop-panel { left: 8px; right: 8px; bottom: 8px; } #synop-panel input[type=range] { width: 70px; } }`;
  const panelHTML = `
<div class="r"><button data-a="addL">+ L</button><button data-a="addH">+ H</button><button data-a="reset">Reset</button><button data-a="close" class="x" aria-label="Close">✕</button></div>
<div class="r"><label>Wind <input type="range" data-s="speed" min="0.1" max="3" step="0.1" value="0.5"></label>
<label>Tracers <input type="range" data-s="N" min="200" max="3000" step="100" value="1400"></label>
<label>Spacing <select data-s="gap"><option value="1">1 mb</option><option value="2" selected>2 mb</option><option value="4">4 mb</option></select></label>
<label><input type="checkbox" data-s="stir"> Stir</label></div>`;

  function start() {
    if (S.on) return; S.on = true;
    if (!document.getElementById('synop-css')) { const st = document.createElement('style'); st.id = 'synop-css'; st.textContent = CSS; document.head.appendChild(st); }
    S.c = document.createElement('canvas'); S.c.id = 'synop-canvas'; document.body.prepend(S.c); S.g = S.c.getContext('2d'); onResize();
    for (const el of document.querySelectorAll('body > header, body > main, body > footer')) { el.style.position = 'relative'; }
    S.panel = document.createElement('div'); S.panel.id = 'synop-panel'; S.panel.innerHTML = panelHTML; document.body.appendChild(S.panel);
    S.panel.addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return;
      const a = b.dataset.a;
      if (a === 'addL' || a === 'addH') S.sys.push(mkSys(a === 'addL' ? 1003 : 1023, .15 + Math.random() * .7, .15 + Math.random() * .7));
      if (a === 'reset') { S.sys = []; S.tracers = []; }
      if (a === 'close') stop(); });
    S.panel.addEventListener('input', (e) => { const el = e.target, k = el.dataset.s; if (!k) return;
      S[k] = el.type === 'checkbox' ? el.checked : parseFloat(el.value); });
    if (!S.sys.length) S.sys = defaultSys();
    bind(true); S.last = 0; S.raf = requestAnimationFrame(tick);
  }
  function stop() {
    if (!S.on) return; S.on = false; cancelAnimationFrame(S.raf); bind(false);
    S.c.remove(); S.panel.remove(); S.c = S.g = S.panel = null; S.drag = null; S.hover = -1; document.body.style.cursor = '';
  }
  window.SYNOP = { start, stop, toggle: () => (S.on ? stop() : start()), state: S };
  start();
})();
