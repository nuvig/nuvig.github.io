// design.js — design specimens page. No libraries.
// One IIFE per specimen; shared helpers at the top. Every animation loop is
// gated by Vis (IntersectionObserver + page visibility), so nothing off-screen
// burns a frame. Canvases read colors from the CSS vars through pal(), so the
// theme and accent controls recolor them too.

(() => {
'use strict';

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const RM = matchMedia('(prefers-reduced-motion: reduce)').matches;
const DEG = Math.PI / 180;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const root = document.documentElement;

// ---------------------------------------------------------------- prefs
const prefs = (() => { try { return JSON.parse(localStorage.getItem('design-prefs') || '{}'); } catch (e) { return {}; } })();
function savePrefs() { try { localStorage.setItem('design-prefs', JSON.stringify(prefs)); } catch (e) { /* private mode */ } }

// ---------------------------------------------------------------- palette
// Resolves the CSS vars to RGB through a 1×1 canvas, so canvases can build
// alpha variants of any color the stylesheet uses.
const pal = (() => {
  const NAMES = ['bg', 'bg2', 'panel', 'panel2', 'line', 'line2', 'ink', 'ink2', 'ink3', 'accent', 'blue', 'green', 'red', 'orange'];
  const scratch = document.createElement('canvas'); scratch.width = scratch.height = 1;
  const sctx = scratch.getContext('2d', { willReadFrequently: true });
  let cache = null;
  function read() {
    const cs = getComputedStyle(root); const o = {};
    for (const n of NAMES) {
      const raw = cs.getPropertyValue('--' + n).trim();
      sctx.clearRect(0, 0, 1, 1); sctx.fillStyle = raw; sctx.fillRect(0, 0, 1, 1);
      const d = sctx.getImageData(0, 0, 1, 1).data;
      o[n] = { css: raw, r: d[0], g: d[1], b: d[2] };
    }
    return (cache = o);
  }
  return {
    get: () => cache || read(),
    css: n => (cache || read())[n].css,
    rgba: (n, a) => { const c = (cache || read())[n]; return `rgba(${c.r},${c.g},${c.b},${a})`; },
    lin: n => { const c = (cache || read())[n]; return [c.r, c.g, c.b].map(v => { v /= 255; return v <= .04045 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); }); },
    invalidate() { cache = null; document.dispatchEvent(new CustomEvent('palette')); },
  };
})();

// ---------------------------------------------------------------- visibility
const Vis = (() => {
  const map = new Map();
  const io = new IntersectionObserver(es => {
    for (const e of es) { const m = map.get(e.target); if (m) { m.visible = e.isIntersecting; sync(m); } }
  }, { rootMargin: '60px 0px' });
  function sync(m) {
    const on = m.visible && !document.hidden;
    if (on && !m.running) { m.running = true; m.start(); }
    else if (!on && m.running) { m.running = false; m.stop(); }
  }
  document.addEventListener('visibilitychange', () => { for (const m of map.values()) sync(m); });
  // read-only state for headless checks
  window.__design = { vis: () => [...map].map(([el, m]) => [el.id || el.className, m.visible, m.running]) };
  return {
    add(el, start, stop) { const m = { visible: false, running: false, start, stop }; map.set(el, m); io.observe(el); return m; },
    // rAF loop helper: fn(dt seconds, t seconds since page load)
    loop(el, fn) {
      let raf = 0, last = 0;
      const tick = now => { const dt = Math.min(.05, (now - last) / 1000) || .016; last = now; fn(dt, now / 1000); raf = requestAnimationFrame(tick); };
      return this.add(el, () => { last = performance.now(); raf = requestAnimationFrame(tick); }, () => cancelAnimationFrame(raf));
    },
  };
})();

function fitCanvas(cv) {
  const r = cv.getBoundingClientRect();
  const dpr = Math.min(2, devicePixelRatio || 1);
  const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  return { w: Math.max(1, r.width), h: Math.max(1, r.height), dpr };
}

// ---------------------------------------------------------------- sound
const Sound = (() => {
  let ctx = null, master = null, on = false, lastClack = 0, nb = null;
  function ensure() {
    if (!ctx) { ctx = new (window.AudioContext || window.webkitAudioContext)(); master = ctx.createGain(); master.gain.value = .5; master.connect(ctx.destination); }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  function noise(c) {
    if (nb) return nb;
    nb = c.createBuffer(1, Math.floor(c.sampleRate * .05), c.sampleRate);
    const d = nb.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return nb;
  }
  function clack() {
    if (!on) return;
    const now = performance.now(); if (now - lastClack < 14) return; lastClack = now;
    const c = ensure(), t = c.currentTime;
    const src = c.createBufferSource(); src.buffer = noise(c);
    const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1600 + Math.random() * 900; bp.Q.value = 1.1;
    const g = c.createGain();
    g.gain.setValueAtTime(.0001, t); g.gain.exponentialRampToValueAtTime(.07, t + .002); g.gain.exponentialRampToValueAtTime(.0001, t + .035);
    src.connect(bp).connect(g).connect(master); src.start(t); src.stop(t + .05);
  }
  function tone(freq, t0, dur) {
    const c = ensure();
    const o = c.createOscillator(); o.type = 'sine'; o.frequency.value = freq;
    const g = c.createGain();
    g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(.3, t0 + .006);
    g.gain.setValueAtTime(.3, t0 + dur - .006); g.gain.linearRampToValueAtTime(0, t0 + dur);
    o.connect(g).connect(master); o.start(t0); o.stop(t0 + dur + .02);
  }
  return {
    get on() { return on; },
    set(v) { on = !!v; if (on) ensure(); document.dispatchEvent(new CustomEvent('sound', { detail: on })); },
    clack, tone, ensure,
  };
})();

// ---------------------------------------------------------------- page chrome
(() => {
  const themeBtn = $('#tTheme'), gridBtn = $('#tGrid'), grainBtn = $('#tGrain'), soundBtn = $('#tSound');
  function paint() {
    const day = root.dataset.theme === 'day';
    themeBtn.textContent = day ? 'night' : 'day';
    themeBtn.setAttribute('aria-pressed', String(day));
    gridBtn.setAttribute('aria-pressed', String(root.classList.contains('grid')));
    grainBtn.setAttribute('aria-pressed', String(root.classList.contains('grain')));
    soundBtn.setAttribute('aria-pressed', String(Sound.on));
  }
  themeBtn.addEventListener('click', e => {
    const next = root.dataset.theme === 'day' ? 'night' : 'day';
    const apply = () => { root.dataset.theme = next; prefs.theme = next; savePrefs(); pal.invalidate(); paint(); };
    if (!document.startViewTransition || RM) { apply(); return; }
    const x = e.clientX || innerWidth - 40, y = e.clientY || 30;
    const r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
    const vt = document.startViewTransition(apply);
    vt.ready.then(() => root.animate(
      { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] },
      { duration: 700, easing: 'cubic-bezier(.2,.8,.2,1)', pseudoElement: '::view-transition-new(root)' })).catch(() => {});
  });
  gridBtn.addEventListener('click', () => { prefs.grid = root.classList.toggle('grid'); savePrefs(); paint(); });
  grainBtn.addEventListener('click', () => { prefs.grain = root.classList.toggle('grain'); savePrefs(); paint(); });
  soundBtn.addEventListener('click', () => Sound.set(!Sound.on));
  document.addEventListener('sound', paint);
  paint();

  // scroll progress fallback where scroll-driven animations are missing
  if (!CSS.supports('animation-timeline', 'scroll()')) {
    const bar = $('#progress');
    addEventListener('scroll', () => {
      const d = root; bar.style.setProperty('--p', (d.scrollTop / (d.scrollHeight - d.clientHeight || 1)).toFixed(4));
    }, { passive: true });
  }

  // rail: highlight the plate under the upper part of the viewport
  const links = $$('#rail a'), plates = $$('.plate');
  function rail() {
    const mid = innerHeight * .4; let cur = null;
    for (const p of plates) if (p.getBoundingClientRect().top <= mid) cur = p.id;
    links.forEach(a => a.classList.toggle('cur', a.getAttribute('href') === '#' + cur));
  }
  addEventListener('scroll', () => requestAnimationFrame(rail), { passive: true });
  rail();

  // font state (document.fonts.check() is true for an unknown family, so look at the faces)
  document.fonts.ready.then(() => {
    const ok = [...document.fonts].some(f => f.family.replace(/["']/g, '') === 'Recursive' && f.status === 'loaded');
    root.classList.toggle('nofont', !ok);
    const el = $('#fontState'); if (el) el.textContent = ok ? 'Recursive · variable · loaded' : 'Recursive unavailable → system fallback';
  });
})();

// ================================================================ 00 board
(() => {
  const el = $('#board'); if (!el) return;
  const LET = ' ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789:', DIG = '0123456789', NUM = ' 0123456789', COLS = 22;
  const FLIP = 40; // ms per half-turn

  class Flap {
    constructor(drum) {
      this.drum = drum; this.cur = ' '; this.tgt = ' '; this.busy = false;
      this.el = document.createElement('span'); this.el.className = 'flap';
      this.el.innerHTML = '<span class="h t"><span> </span></span><span class="h b"><span> </span></span>' +
                          '<span class="h t ft"><span> </span></span><span class="h b fb"><span> </span></span>';
      [this.t, this.b, this.ft, this.fb] = $$('.h', this.el);
      this.tS = this.t.firstChild; this.bS = this.b.firstChild; this.ftS = this.ft.firstChild; this.fbS = this.fb.firstChild;
    }
    set(ch) { this.tgt = this.drum.includes(ch) ? ch : ' '; if (!this.busy) this.step(); }
    commit(ch) { this.cur = ch; this.tS.textContent = ch; this.bS.textContent = ch; this.ftS.textContent = ch; this.fbS.textContent = ch; }
    async step() {
      if (this.cur === this.tgt) { this.busy = false; return; }
      this.busy = true;
      if (RM || document.hidden) { this.commit(this.tgt); this.busy = false; return; }
      const next = this.drum[(this.drum.indexOf(this.cur) + 1) % this.drum.length];
      this.tS.textContent = next; this.fbS.textContent = next; this.ftS.textContent = this.cur; this.bS.textContent = this.cur;
      const a1 = this.ft.animate([{ transform: 'rotateX(0deg)', filter: 'brightness(1)' }, { transform: 'rotateX(-90deg)', filter: 'brightness(.45)' }],
        { duration: FLIP, easing: 'ease-in', fill: 'forwards' });
      await a1.finished.catch(() => {});
      const a2 = this.fb.animate([{ transform: 'rotateX(90deg)', filter: 'brightness(.45)' }, { transform: 'rotateX(0deg)', filter: 'brightness(1)' }],
        { duration: FLIP, easing: 'ease-out', fill: 'forwards' });
      await a2.finished.catch(() => {});
      this.cur = next; this.bS.textContent = next; this.ftS.textContent = next;
      a1.cancel(); a2.cancel();
      Sound.clack();
      this.step();
    }
  }

  function row(opts = {}) {
    const r = document.createElement(opts.onclick ? 'button' : 'div');
    r.className = 'brow ' + (opts.cls || '');
    if (opts.onclick) { r.type = 'button'; r.classList.add('link'); r.setAttribute('aria-label', opts.label); r.addEventListener('click', opts.onclick); }
    else r.setAttribute('aria-hidden', 'true');
    const flaps = [];
    for (let i = 0; i < COLS; i++) { const f = new Flap(opts.drums ? opts.drums[i] : LET); r.appendChild(f.el); flaps.push(f); }
    el.appendChild(r);
    return {
      el: r, flaps,
      set(s, delay = 0, stagger = 16) {
        s = s.toUpperCase().padEnd(COLS).slice(0, COLS);
        flaps.forEach((f, i) => setTimeout(() => f.set(s[i]), delay + i * stagger));
      },
    };
  }
  function gap() { const g = document.createElement('div'); g.className = 'brow gap'; g.setAttribute('aria-hidden', 'true'); el.appendChild(g); }
  function head() {
    const h = document.createElement('div'); h.className = 'brow head'; h.setAttribute('aria-hidden', 'true');
    const s = ('NO SPECIMEN'.padEnd(14) + 'METHOD').padEnd(COLS).slice(0, COLS);
    for (let i = 0; i < COLS; i++) { const c = document.createElement('span'); c.className = 'c'; c.textContent = s[i]; h.appendChild(c); }
    el.appendChild(h);
  }

  const SPEC = [
    ['01', 'TYPE',       'type',       ['VARIABLE', '5 AXES', 'FLUID']],
    ['02', 'COLOR',      'color',      ['OKLCH', 'GAMUT', 'CONTRAST']],
    ['03', 'MOTION',     'motion',     ['EASING', 'SPRING', 'STAGGER']],
    ['04', 'LIGHT',      'light',      ['ATTITUDE', 'SPECULAR', 'TILT']],
    ['05', 'PHYSICS',    'physics',    ['WINDSOCK', 'VERLET', 'GUSTS']],
    ['06', 'GENERATIVE', 'generative', ['ISOBARS', 'BARBS', 'NOISE']],
    ['07', 'SOUND',      'sound',      ['MORSE', '1020 HZ', 'WEBAUDIO']],
    ['08', 'ICONS',      'icons',      ['STROKE', '24 GRID', 'HOVER']],
  ];
  const line = (n, name, tech) => `${n} ${name.padEnd(10)} ${tech.padEnd(8)}`;

  const title = row({ cls: 'title' });
  gap(); head();
  const specDrums = []; for (let i = 0; i < COLS; i++) specDrums.push(i < 2 ? NUM : LET);
  const rows = SPEC.map(([n, name, id, techs]) => {
    const r = row({ drums: specDrums, onclick: () => $('#' + id).scrollIntoView({ behavior: RM ? 'auto' : 'smooth', block: 'start' }), label: `${n} ${name}` });
    r.techs = techs; r.ti = 0; r.n = n; r.name = name; return r;
  });
  gap();
  const clockDrums = []; for (let i = 0; i < COLS; i++) clockDrums.push([12, 13, 15, 16, 18, 19].includes(i) ? DIG : LET);
  const clock = row({ cls: 'clock', drums: clockDrums });

  function utc() { const d = new Date(); const p = n => String(n).padStart(2, '0'); return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`; }

  function reveal() {
    title.set('   DESIGN SPECIMENS   ', 0, 22);
    rows.forEach((r, i) => r.set(line(r.n, r.name, r.techs[0]), 500 + i * 110));
    clock.set('UTC'.padEnd(12) + utc() + 'Z', 500 + rows.length * 110);
    const tick = () => { clock.set('UTC'.padEnd(12) + utc() + 'Z', 0, 0); };
    setTimeout(() => { tick(); setInterval(tick, 1000); }, 1000 - (Date.now() % 1000) + 2200);
    if (!RM) {
      let k = 0;
      setTimeout(() => setInterval(() => { const r = rows[k++ % rows.length]; r.ti = (r.ti + 1) % r.techs.length; r.set(line(r.n, r.name, r.techs[r.ti]), 0, 20); }, 6500), 9000);
    }
  }
  // wait for the font (or 1.5 s) so glyphs don't swap mid-flip
  let shown = false; const go = () => { if (!shown) { shown = true; reveal(); } };
  document.fonts.ready.then(go); setTimeout(go, 1500);
})();

// ================================================================ 01 type
(() => {
  const hero = $('#typeHero'); if (!hero) return;
  const ax = { w: $('#axW'), s: $('#axS'), c: $('#axC'), r: $('#axR'), m: $('#axM') };
  const autoBtn = $('#axAuto');
  let auto = !RM, t0 = performance.now();
  const fmt = (k, v) => k === 'w' ? String(Math.round(v)) : (+v).toFixed(k === 's' ? 1 : 2);
  function apply(v) {
    for (const k in v) { hero.style.setProperty('--' + k, v[k]); ax[k].value = v[k]; ax[k].previousElementSibling.value = fmt(k, v[k]); }
  }
  for (const k in ax) ax[k].addEventListener('input', () => {
    auto = false; autoBtn.setAttribute('aria-pressed', 'false');
    const v = {}; for (const j in ax) v[j] = +ax[j].value; apply(v);
  });
  autoBtn.addEventListener('click', () => { auto = !auto; autoBtn.setAttribute('aria-pressed', String(auto)); t0 = performance.now() - 4000; });
  autoBtn.setAttribute('aria-pressed', String(auto));
  apply({ w: 500, s: 0, c: 0, r: .5, m: 0 });
  Vis.loop(hero, () => {
    if (!auto) return;
    const t = (performance.now() - t0) / 1000;
    apply({
      w: 650 + 350 * Math.sin(t * .45),
      s: -7.5 - 7.5 * Math.sin(t * .33 + 1),
      c: .5 + .5 * Math.sin(t * .27 + 2),
      r: .5 + .5 * Math.sin(t * .2),
      m: clamp(.5 + .65 * Math.sin(t * .17 + 4), 0, 1),
    });
  });
  // fluid scale readout
  const scs = $$('.scale .sc');
  const px = () => { for (const s of scs) s.querySelector('.px').textContent = Math.round(parseFloat(getComputedStyle(s.firstElementChild).fontSize)) + ' px · ' + s.dataset.css; };
  addEventListener('resize', px); px();
})();

// ================================================================ 02 color
(() => {
  const dial = $('#hueDial'); if (!dial) return;
  const handle = $('.dial-handle', dial), hv = $('#hueVal');
  let hue = +(prefs.hue || 75);

  function oklchToLin(L, C, h) {
    const a = C * Math.cos(h * DEG), b = C * Math.sin(h * DEG);
    const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
    const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
    const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
    const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
    return [
       4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
    ];
  }
  const gam = c => c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - .055;
  const inGamut = rgb => rgb.every(v => v >= -0.0005 && v <= 1.0005);
  function color(L, C, h) {              // gamut-map by walking chroma down
    let lo = 0, hi = C, lin = oklchToLin(L, C, h), c = C;
    if (!inGamut(lin)) {
      for (let i = 0; i < 18; i++) { const mid = (lo + hi) / 2; const r = oklchToLin(L, mid, h); if (inGamut(r)) { lo = mid; lin = r; } else hi = mid; }
      c = lo;
    }
    lin = lin.map(v => clamp(v, 0, 1));
    const hex = '#' + lin.map(v => Math.round(gam(v) * 255).toString(16).padStart(2, '0')).join('');
    return { hex, lin, c, css: `oklch(${(L * 100).toFixed(0)}% ${c.toFixed(3)} ${Math.round(h)})` };
  }
  const lum = lin => .2126 * lin[0] + .7152 * lin[1] + .0722 * lin[2];
  const contrast = (a, b) => (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
  function hslHue(lin) {
    const [r, g, b] = lin.map(gam); const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    if (d < 1e-6) return 0; let h;
    if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
    return (h * 60 + 360) % 360;
  }

  const rampOk = $('#rampOk'), rampHsl = $('#rampHsl'), hslLab = $('#hslHue');
  const LS = [97, 92, 85, 76, 66, 56, 47, 38, 30, 22, 15];
  function swatch(parent, bg, text, title, light) {
    const d = document.createElement('div'); d.className = 'sw'; d.style.background = bg;
    d.style.color = light ? 'rgba(0,0,0,.72)' : 'rgba(255,255,255,.82)'; d.textContent = text; d.title = title; parent.appendChild(d);
  }
  let raf = 0;
  function render() {
    raf = 0;
    const H = Math.round(hue);
    handle.style.setProperty('--a', hue + 'deg'); handle.style.setProperty('--sw', color(.72, .17, hue).hex);
    hv.textContent = H + '°'; dial.setAttribute('aria-valuenow', H);
    rampOk.innerHTML = ''; rampHsl.innerHTML = '';
    for (const L of LS) { const c = color(L / 100, .12, hue); swatch(rampOk, c.hex, c.hex, c.css, L > 55); }
    const hh = Math.round(hslHue(color(.6, .15, hue).lin));
    for (const L of LS) swatch(rampHsl, `hsl(${hh} 70% ${L}%)`, L + '%', `hsl(${hh} 70% ${L}%)`, L > 55);
    hslLab.textContent = `hsl · hue ${hh}° · S 70% · L 97→15`;
    const a = `oklch(70% 0.16 ${H})`, b = `oklch(70% 0.16 ${(H + 180) % 360})`;
    $('#gradOk').style.background = `linear-gradient(to right in oklch, ${a}, ${b})`;
    $('#gradSrgb').style.background = `linear-gradient(to right in srgb, ${a}, ${b})`;
    // readouts
    const day = root.dataset.theme === 'day';
    const acc = color(day ? .60 : .80, .15, hue), bgL = lum(pal.lin('bg')), inkL = lum(pal.lin('ink'));
    const put = (id, c, extra) => { const dd = $(id); dd.innerHTML = ''; const dot = document.createElement('span'); dot.className = 'dot'; dot.style.background = c.hex; dd.appendChild(dot); dd.append(`${c.hex} · ${c.css}${extra || ''}`); };
    put('#cAcc', acc, ` · ${contrast(lum(acc.lin), bgL).toFixed(1)}:1 on bg · ${contrast(lum(acc.lin), inkL).toFixed(1)}:1 on ink`);
    put('#cComp', color(day ? .60 : .80, .15, (hue + 180) % 360));
    put('#cTri1', color(day ? .60 : .80, .15, (hue + 120) % 360));
    put('#cTri2', color(day ? .60 : .80, .15, (hue + 240) % 360));
  }
  const queue = () => { if (!raf) raf = requestAnimationFrame(render); };
  const angle = e => { const r = dial.getBoundingClientRect(); return (Math.atan2(e.clientX - (r.left + r.width / 2), -(e.clientY - (r.top + r.height / 2))) / DEG + 360) % 360; };
  dial.addEventListener('pointerdown', e => {
    try { dial.setPointerCapture(e.pointerId); } catch (_) {}
    hue = angle(e); queue();
    const mv = ev => { hue = angle(ev); queue(); };
    const up = () => { dial.removeEventListener('pointermove', mv); dial.removeEventListener('pointerup', up); dial.removeEventListener('pointercancel', up); };
    dial.addEventListener('pointermove', mv); dial.addEventListener('pointerup', up); dial.addEventListener('pointercancel', up);
    e.preventDefault();
  });
  dial.addEventListener('keydown', e => {
    const d = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key]; if (!d) return;
    hue = (hue + d * (e.shiftKey ? 10 : 1) + 360) % 360; queue(); e.preventDefault();
  });
  $('#applyHue').addEventListener('click', () => { root.style.setProperty('--accent-h', Math.round(hue)); prefs.hue = Math.round(hue); savePrefs(); pal.invalidate(); });
  $('#resetHue').addEventListener('click', () => { root.style.removeProperty('--accent-h'); delete prefs.hue; savePrefs(); hue = 75; pal.invalidate(); queue(); });
  document.addEventListener('palette', queue);
  render();
})();

// ================================================================ 03 motion
(() => {
  const wrap = $('#lanes'); if (!wrap) return;
  function bezier(x1, y1, x2, y2) {
    const A = (a, b) => 1 - 3 * b + 3 * a, B = (a, b) => 3 * b - 6 * a, C = a => 3 * a;
    const calc = (t, a, b) => ((A(a, b) * t + B(a, b)) * t + C(a)) * t;
    const slope = (t, a, b) => 3 * A(a, b) * t * t + 2 * B(a, b) * t + C(a);
    return x => {
      if (x <= 0) return 0; if (x >= 1) return 1;
      let t = x;
      for (let i = 0; i < 8; i++) { const s = slope(t, x1, x2); if (Math.abs(s) < 1e-6) break; t -= (calc(t, x1, x2) - x) / s; }
      return calc(clamp(t, 0, 1), y1, y2);
    };
  }
  const spring = (z, w) => t => { const wd = w * Math.sqrt(1 - z * z); return 1 - Math.exp(-z * w * t) * (Math.cos(wd * t) + (z / Math.sqrt(1 - z * z)) * Math.sin(wd * t)); };
  function bounce(t) {
    const n = 7.5625, d = 2.75;
    if (t < 1 / d) return n * t * t;
    if (t < 2 / d) return n * (t -= 1.5 / d) * t + .75;
    if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + .9375;
    return n * (t -= 2.625 / d) * t + .984375;
  }
  const S = spring(.26, 12);
  const EASE = [
    { n: 'linear',                      css: 'linear',                      f: t => t },
    { n: 'ease-in-out',                 css: 'ease-in-out',                 f: bezier(.42, 0, .58, 1) },
    { n: 'cubic-bezier(.2,.9,.2,1)',    css: 'cubic-bezier(.2,.9,.2,1)',    f: bezier(.2, .9, .2, 1) },
    { n: 'linear() · spring ζ .26',     lin: true,                          f: t => S(t * 1.8) },
    { n: 'linear() · bounce',           lin: true,                          f: bounce },
    { n: 'steps(8)',                    css: 'steps(8, end)',               f: t => Math.min(1, Math.floor(t * 8) / 8) },
  ];
  const linOK = CSS.supports('animation-timing-function', 'linear(0, 0.5 50%, 1)');
  const linCss = f => { const N = 64, p = []; for (let i = 0; i <= N; i++) p.push(f(i / N).toFixed(4) + (i === 0 || i === N ? '' : ' ' + (i / N * 100).toFixed(1) + '%')); return `linear(${p.join(', ')})`; };
  const W = 104, H = 60;
  const lanes = EASE.map(e => {
    if (e.lin) e.css = linCss(e.f);
    const el = document.createElement('div'); el.className = 'lane';
    let d = ''; for (let i = 0; i <= 80; i++) { const x = i / 80; d += (i ? 'L' : 'M') + (x * W).toFixed(1) + ' ' + ((1 - e.f(x)) * H).toFixed(1) + ' '; }
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" aria-hidden="true"><line class="ax" x1="0" y1="${H}" x2="${W}" y2="${H}"/><line class="ax" x1="0" y1="0" x2="${W}" y2="0" stroke-dasharray="2 3"/><path class="cv" d="${d}"/></svg>` +
                   `<div class="track"><span class="name">${e.n}</span><div class="dot"></div></div>`;
    wrap.appendChild(el);
    return { e, dot: $('.dot', el), track: $('.track', el) };
  });
  let anims = [];
  function play() {
    anims.forEach(a => a.cancel());
    anims = lanes.map(({ e, dot, track }) => {
      const dist = Math.max(0, track.clientWidth - 16); const opts = { duration: 1800, fill: 'forwards' }; let kf;
      if (!e.lin || linOK) { opts.easing = e.css; kf = [{ transform: 'translateX(0px)' }, { transform: `translateX(${dist}px)` }]; }
      else { kf = []; for (let i = 0; i <= 80; i++) kf.push({ transform: `translateX(${(e.f(i / 80) * dist).toFixed(1)}px)`, offset: i / 80 }); opts.easing = 'linear'; }
      return dot.animate(kf, opts);
    });
  }
  $('#replay').addEventListener('click', play);
  let timer = null;
  Vis.add(wrap, () => { play(); if (!RM) timer = setInterval(play, 3600); }, () => { clearInterval(timer); timer = null; });

  // stagger grid
  const rip = $('#ripple'); const tiles = [];
  for (let k = 0; k < 84; k++) { const t = document.createElement('div'); t.className = 'tile'; rip.appendChild(t); tiles.push(t); }
  function ripple(ci, cj) {
    const cols = getComputedStyle(rip).gridTemplateColumns.split(' ').length; const p = pal.get();
    tiles.forEach((t, k) => {
      const i = k % cols, j = Math.floor(k / cols); const d = Math.hypot(i - ci, j - cj);
      t.animate([
        { transform: 'scale(1)', background: p.panel2.css, borderColor: p.line2.css },
        { transform: 'scale(.5)', background: p.accent.css, borderColor: p.accent.css, offset: .35 },
        { transform: 'scale(1)', background: p.panel2.css, borderColor: p.line2.css },
      ], { duration: 820, delay: d * 44, easing: 'cubic-bezier(.2,.8,.2,1)' });
    });
  }
  rip.addEventListener('click', e => {
    const t = e.target.closest('.tile'); if (!t) return;
    const k = tiles.indexOf(t), cols = getComputedStyle(rip).gridTemplateColumns.split(' ').length;
    ripple(k % cols, Math.floor(k / cols));
  });
  let did = false;
  Vis.add(rip, () => { if (!did) { did = true; setTimeout(() => ripple(6, 2), 400); } }, () => {});
})();

// ================================================================ 04 light
(() => {
  const card = $('#tiltCard'); if (!card) return;
  const gyro = $('#aiGyro'), ptr = $('#aiBankPtr'), flag = $('#aiFlag'), ladder = $('#aiLadder'), scale = $('#aiScale');
  const bankOut = $('#aiBank'), pitchOut = $('#aiPitch');
  const NS = 'http://www.w3.org/2000/svg';
  const mk = (tag, attrs) => { const n = document.createElementNS(NS, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); return n; };
  // pitch ladder: 4.5 px per degree
  for (let p = -30; p <= 30; p += 5) {
    if (p === 0) continue;
    const y = 200 - p * 4.5, w = p % 10 === 0 ? 34 : 16;
    ladder.appendChild(mk('line', { x1: 200 - w, y1: y, x2: 200 + w, y2: y, stroke: '#fff', 'stroke-width': p % 10 === 0 ? 2 : 1.5 }));
    if (p % 10 === 0) for (const s of [-1, 1]) {
      const t = mk('text', { x: 200 + s * (w + 10), y: y + 4, 'font-size': 12, 'text-anchor': 'middle' }); t.textContent = Math.abs(p); ladder.appendChild(t);
    }
  }
  // fixed bank scale on the case
  for (const a of [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60]) {
    const r0 = 150, len = a === 0 ? 0 : (a % 30 === 0 ? 16 : 9);
    const s = Math.sin(a * DEG), c = Math.cos(a * DEG);
    if (a === 0) scale.appendChild(mk('polygon', { points: `${200},${200 - r0 + 16} ${192},${200 - r0 + 2} ${208},${200 - r0 + 2}`, fill: '#fff' }));
    else scale.appendChild(mk('line', { x1: 200 + s * r0, y1: 200 - c * r0, x2: 200 + s * (r0 - len), y2: 200 - c * (r0 - len), stroke: '#fff', 'stroke-width': a % 30 === 0 ? 3 : 2 }));
  }
  const s = { bank: -42, pitch: 16, vb: 0, vp: 0, tb: 0, tp: 0, rx: 0, ry: 0, trx: 0, try: 0, gx: 50, gy: 50, tgx: 50, tgy: 50 };
  let device = false;
  function fromPointer(e) {
    const r = card.getBoundingClientRect();
    const dx = clamp((e.clientX - r.left) / r.width * 2 - 1, -1, 1), dy = clamp((e.clientY - r.top) / r.height * 2 - 1, -1, 1);
    s.tb = dx * 32; s.tp = -dy * 14; s.try = dx * 9; s.trx = -dy * 9; s.tgx = 50 + dx * 40; s.tgy = 50 + dy * 40;
  }
  const level = () => { s.tb = 0; s.tp = 0; s.trx = 0; s.try = 0; s.tgx = 50; s.tgy = 50; };
  card.addEventListener('pointermove', e => { if (!device) fromPointer(e); });
  card.addEventListener('pointerdown', e => { if (!device) fromPointer(e); });
  card.addEventListener('pointerleave', () => { if (!device) level(); });
  const fmtDeg = (v, neg, pos) => { const a = Math.abs(v); return a < .5 ? '0°' : `${a.toFixed(0)}° ${v < 0 ? neg : pos}`; };
  function frame(dt) {
    const k = 55, c = 9;
    for (const [p, v, t] of [['bank', 'vb', 'tb'], ['pitch', 'vp', 'tp']]) { s[v] += (k * (s[t] - s[p]) - c * s[v]) * dt; s[p] += s[v] * dt; }
    const e = 1 - Math.exp(-dt * 9);
    s.rx = lerp(s.rx, s.trx, e); s.ry = lerp(s.ry, s.try, e); s.gx = lerp(s.gx, s.tgx, e); s.gy = lerp(s.gy, s.tgy, e);
    gyro.setAttribute('transform', `rotate(${(-s.bank).toFixed(2)} 200 200) translate(0 ${(s.pitch * 4.5).toFixed(2)})`);
    ptr.setAttribute('transform', `rotate(${(-s.bank).toFixed(2)} 200 200)`);
    card.style.setProperty('--rx', s.rx.toFixed(2) + 'deg'); card.style.setProperty('--ry', s.ry.toFixed(2) + 'deg');
    card.style.setProperty('--gx', s.gx.toFixed(1) + '%'); card.style.setProperty('--gy', s.gy.toFixed(1) + '%');
    bankOut.textContent = fmtDeg(s.bank, 'L', 'R'); pitchOut.textContent = fmtDeg(s.pitch, 'DN', 'UP');
  }
  let flagged = false;
  const m = Vis.loop(card, frame);
  const start0 = m.start;
  m.start = () => { start0(); if (!flagged) { flagged = true; setTimeout(() => flag.animate([{ transform: 'translateX(0)', opacity: 1 }, { transform: 'translateX(90px)', opacity: 0 }], { duration: 650, easing: 'ease-in', fill: 'forwards' }), 1500); } };
  if (m.running) m.start();
  // device orientation
  const btn = $('#tiltBtn');
  if (!('DeviceOrientationEvent' in window)) btn.hidden = true;
  function onOri(e) {
    if (!device || e.gamma == null) return;
    const ang = (screen.orientation && screen.orientation.angle) || 0; let roll = e.gamma, pitch = e.beta;
    if (ang === 90) { roll = e.beta; pitch = -e.gamma; } else if (ang === 270 || ang === -90) { roll = -e.beta; pitch = e.gamma; }
    s.tb = clamp(roll, -60, 60); s.tp = clamp((pitch - 45) * .6, -25, 25);
    s.try = clamp(roll / 6, -9, 9); s.trx = clamp(-(pitch - 45) / 6, -9, 9);
    s.tgx = 50 + clamp(roll / 60, -1, 1) * 40; s.tgy = 50 + clamp((pitch - 45) / 40, -1, 1) * 40;
  }
  btn.addEventListener('click', async () => {
    if (device) { device = false; btn.setAttribute('aria-pressed', 'false'); removeEventListener('deviceorientation', onOri); level(); return; }
    try { if (typeof DeviceOrientationEvent.requestPermission === 'function') { if (await DeviceOrientationEvent.requestPermission() !== 'granted') return; } } catch (_) { return; }
    device = true; btn.setAttribute('aria-pressed', 'true'); addEventListener('deviceorientation', onOri);
  });
})();

// ================================================================ 05 physics
(() => {
  const cv = $('#sock'); if (!cv) return;
  const ctx = cv.getContext('2d');
  const dialEl = $('#windDial'), arrow = $('#windArrow'), spdIn = $('#windSpd'), spdOut = $('#windSpdOut'), gustBtn = $('#gustBtn'), read = $('#windRead');
  let dirFrom = 290, spdKt = 12, gusts = !RM;
  const N = 11, SEG = .235, R0 = .25, R1 = .085, PIV = { x: 0, y: 3.25, z: 0 }, ARM = .3;
  const P = []; for (let i = 0; i < N; i++) P.push({ x: 0, y: PIV.y - .12 * i, z: .3 + i * SEG * .4 });
  P.forEach(p => { p.px = p.x; p.py = p.y; p.pz = p.z; });
  const hash = i => { const x = Math.sin(i * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
  const n1 = t => { const i = Math.floor(t), f = t - i, u = f * f * (3 - 2 * f); return (hash(i) + (hash(i + 1) - hash(i)) * u) * 2 - 1; };
  let yaw = (dirFrom + 180) * DEG, now = { spd: 0 };
  function wind(t) {
    const g = gusts ? 1 + .42 * (.6 * n1(t * .33) + .3 * n1(t * 1.2 + 7) + .1 * n1(t * 3.4 + 13)) : 1;
    const wander = gusts ? 7 * n1(t * .19 + 40) : 0;
    const spd = Math.max(0, spdKt * .5144 * g), th = (dirFrom + wander + 180) * DEG;
    return { x: Math.sin(th) * spd, z: Math.cos(th) * spd, spd, th };
  }
  function step(dt, t) {
    const w = wind(t); now = w;
    if (w.spd > .3) { const d = ((w.th - yaw + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI; yaw += d * Math.min(1, dt * (1 + w.spd * .5)); }
    const ux = Math.sin(yaw), uz = Math.cos(yaw);
    P[0].x = PIV.x + ux * ARM; P[0].y = PIV.y; P[0].z = PIV.z + uz * ARM;
    const damp = .985, turb = w.spd > 1.5 ? .9 * w.spd : 0;
    for (let i = 1; i < N; i++) {
      const p = P[i];
      const vx = (p.x - p.px) * damp, vy = (p.y - p.py) * damp, vz = (p.z - p.pz) * damp;
      const rvx = w.x - vx / dt, rvy = -vy / dt, rvz = w.z - vz / dt, rs = Math.hypot(rvx, rvy, rvz);
      const k = .5 * (1 - .45 * i / N);
      const ax = k * rs * rvx + (Math.random() - .5) * turb, ay = -9.81 + k * rs * rvy + (Math.random() - .5) * turb * .5, az = k * rs * rvz + (Math.random() - .5) * turb;
      p.px = p.x; p.py = p.y; p.pz = p.z;
      p.x += vx + ax * dt * dt; p.y += vy + ay * dt * dt; p.z += vz + az * dt * dt;
    }
    for (let it = 0; it < 6; it++) {
      { const b = P[1]; const tx = P[0].x + ux * SEG, ty = P[0].y, tz = P[0].z + uz * SEG; b.x += (tx - b.x) * .55; b.y += (ty - b.y) * .55; b.z += (tz - b.z) * .55; }
      for (let i = 0; i < N - 1; i++) {
        const a = P[i], b = P[i + 1]; const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z; const d = Math.hypot(dx, dy, dz) || 1e-6;
        const f = (d - SEG) / d, wa = i === 0 ? 0 : .5, wb = i === 0 ? 1 : .5;
        a.x += dx * f * wa; a.y += dy * f * wa; a.z += dz * f * wa; b.x -= dx * f * wb; b.y -= dy * f * wb; b.z -= dz * f * wb;
      }
      for (let i = 0; i < N - 2; i++) {
        const a = P[i], b = P[i + 2]; const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z; const d = Math.hypot(dx, dy, dz) || 1e-6, min = SEG * 1.8;
        if (d < min) { const f = (d - min) / d * .5, wa = i === 0 ? 0 : .5, wb = i === 0 ? 1 : .5; a.x += dx * f * wa; a.y += dy * f * wa; a.z += dz * f * wa; b.x -= dx * f * wb; b.y -= dy * f * wb; b.z -= dz * f * wb; }
      }
      for (let i = 1; i < N; i++) if (P[i].y < .06) P[i].y = .06;
    }
  }
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = v => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
  const LIGHT = norm([-.35, .85, -.45]);
  function render(w, h, dpr) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
    const cam = { x: 0, y: 2.45, z: -7.3 }, f = h * 1.12, cx = w / 2, cy = h * .5;
    const proj = p => { const X = p.x - cam.x, Y = p.y - cam.y, Z = p.z - cam.z; return { x: cx + f * X / Z, y: cy - f * Y / Z, z: Z }; };
    const seg = (a, b) => { ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); };
    // ground grid + horizon
    ctx.lineWidth = 1; ctx.strokeStyle = pal.rgba('ink', .07);
    for (let gx = -10; gx <= 10; gx += 2) seg(proj({ x: gx, y: 0, z: 1.2 }), proj({ x: gx, y: 0, z: 60 }));
    for (let gz = 1.2; gz < 60; gz *= 1.45) seg(proj({ x: -14, y: 0, z: gz }), proj({ x: 14, y: 0, z: gz }));
    const hz = proj({ x: 0, y: 0, z: 1e4 }); ctx.strokeStyle = pal.rgba('ink', .2); seg({ x: 0, y: hz.y }, { x: w, y: hz.y });
    // shadow
    ctx.beginPath();
    P.forEach((p, i) => { const q = proj({ x: p.x + .35 * p.y, y: 0, z: p.z + .25 * p.y }); i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); });
    ctx.strokeStyle = 'rgba(0,0,0,.22)'; ctx.lineWidth = 9 * (h / 440); ctx.lineCap = 'round'; ctx.stroke();
    // pole + swivel arm
    const base = proj({ x: 0, y: 0, z: 0 }), top = proj(PIV), m0 = proj(P[0]);
    ctx.strokeStyle = pal.rgba('ink2', .85); ctx.lineWidth = 3.5; seg(base, top); ctx.lineWidth = 2; seg(top, m0);
    ctx.fillStyle = pal.css('ink2'); ctx.beginPath(); ctx.arc(top.x, top.y, 3.2, 0, 7); ctx.fill();
    // rings
    const fill = Math.pow(clamp(now.spd / 7.7, 0, 1), .6), infl = .32 + .68 * fill, K = 14, rings = [];
    for (let i = 0; i < N; i++) {
      const p = P[i], a = P[Math.max(0, i - 1)], b = P[Math.min(N - 1, i + 1)];
      const t = norm([b.x - a.x, b.y - a.y, b.z - a.z]);
      let u = cross(t, [0, 1, 0]); if (Math.hypot(u[0], u[1], u[2]) < 1e-3) u = [1, 0, 0]; u = norm(u);
      const v = cross(t, u);
      const r = lerp(R0, R1, i / (N - 1)) * (i === 0 ? 1 : infl), sq = i === 0 ? 1 : .55 + .45 * fill;
      const ring = [];
      for (let j = 0; j < K; j++) {
        const an = j / K * 2 * Math.PI, cu = Math.cos(an) * r, sv = Math.sin(an) * r * sq;
        const wp = { x: p.x + u[0] * cu + v[0] * sv, y: p.y + u[1] * cu + v[1] * sv, z: p.z + u[2] * cu + v[2] * sv };
        ring.push({ w: wp, s: proj(wp) });
      }
      rings.push(ring);
    }
    const quads = [];
    for (let i = 0; i < N - 1; i++) {
      const white = Math.floor(i * 5 / (N - 1)) % 2 === 1;
      for (let j = 0; j < K; j++) {
        const j2 = (j + 1) % K, a = rings[i][j], b = rings[i][j2], c = rings[i + 1][j2], d = rings[i + 1][j];
        const n = norm(cross([b.w.x - a.w.x, b.w.y - a.w.y, b.w.z - a.w.z], [d.w.x - a.w.x, d.w.y - a.w.y, d.w.z - a.w.z]));
        const sh = .5 + .5 * Math.abs(n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2]);
        quads.push({ z: (a.s.z + b.s.z + c.s.z + d.s.z) / 4, p: [a.s, b.s, c.s, d.s], white, sh });
      }
    }
    quads.sort((p, q) => q.z - p.z);
    for (const q of quads) {
      const col = q.white ? `oklch(${(58 + q.sh * 40).toFixed(1)}% 0.012 85)` : `oklch(${(48 + q.sh * 28).toFixed(1)}% 0.21 48)`;
      ctx.fillStyle = col; ctx.strokeStyle = col; ctx.lineWidth = .7;
      ctx.beginPath(); ctx.moveTo(q.p[0].x, q.p[0].y); for (let k = 1; k < 4; k++) ctx.lineTo(q.p[k].x, q.p[k].y); ctx.closePath(); ctx.fill(); ctx.stroke();
    }
    // mouth hoop
    ctx.beginPath(); rings[0].forEach((r, j) => j ? ctx.lineTo(r.s.x, r.s.y) : ctx.moveTo(r.s.x, r.s.y)); ctx.closePath();
    ctx.strokeStyle = 'rgba(20,20,22,.9)'; ctx.lineWidth = 2.2; ctx.stroke();
  }
  let acc = 0, size = null;
  Vis.loop(cv, (dt, t) => {
    size = fitCanvas(cv);
    acc = Math.min(acc + dt, .1); const h = 1 / 120;
    while (acc >= h) { step(h, t); acc -= h; t += h; }
    render(size.w, size.h, size.dpr);
    const kt = now.spd / .5144;
    read.innerHTML = `${String(Math.round(dirFrom)).padStart(3, '0')}° · ${kt.toFixed(0)} kt<small>set ${spdKt} kt${gusts ? ' · gusting' : ''}</small>`;
  });
  // controls
  { const NS = 'http://www.w3.org/2000/svg', g = $('#windTicks');
    for (let a = 0; a < 360; a += 10) {
      const major = a % 90 === 0, mid = a % 30 === 0, s = Math.sin(a * DEG), c = Math.cos(a * DEG), r0 = 84, len = major ? 0 : mid ? 10 : 5;
      if (major) { const t = document.createElementNS(NS, 'text'); t.setAttribute('class', 'card'); t.setAttribute('x', 90 + s * 70); t.setAttribute('y', 90 - c * 70 + 4); t.setAttribute('text-anchor', 'middle'); t.textContent = 'NESW'[a / 90]; g.appendChild(t); continue; }
      const l = document.createElementNS(NS, 'line'); l.setAttribute('class', 'tick');
      l.setAttribute('x1', 90 + s * r0); l.setAttribute('y1', 90 - c * r0); l.setAttribute('x2', 90 + s * (r0 - len)); l.setAttribute('y2', 90 - c * (r0 - len));
      l.setAttribute('stroke-width', mid ? 1.5 : 1); g.appendChild(l);
    } }
  function paintDial() { arrow.setAttribute('transform', `rotate(${dirFrom} 90 90)`); dialEl.setAttribute('aria-valuenow', Math.round(dirFrom)); }
  const ang = e => { const r = dialEl.getBoundingClientRect(); return (Math.atan2(e.clientX - (r.left + r.width / 2), -(e.clientY - (r.top + r.height / 2))) / DEG + 360) % 360; };
  dialEl.addEventListener('pointerdown', e => {
    try { dialEl.setPointerCapture(e.pointerId); } catch (_) {}
    dirFrom = ang(e); paintDial();
    const mv = ev => { dirFrom = ang(ev); paintDial(); };
    const up = () => { dialEl.removeEventListener('pointermove', mv); dialEl.removeEventListener('pointerup', up); dialEl.removeEventListener('pointercancel', up); };
    dialEl.addEventListener('pointermove', mv); dialEl.addEventListener('pointerup', up); dialEl.addEventListener('pointercancel', up);
    e.preventDefault();
  });
  dialEl.addEventListener('keydown', e => {
    const d = { ArrowRight: 5, ArrowUp: 5, ArrowLeft: -5, ArrowDown: -5 }[e.key]; if (!d) return;
    dirFrom = (dirFrom + d + 360) % 360; paintDial(); e.preventDefault();
  });
  spdIn.addEventListener('input', () => { spdKt = +spdIn.value; spdOut.value = spdKt + ' kt'; });
  gustBtn.addEventListener('click', () => { gusts = !gusts; gustBtn.setAttribute('aria-pressed', String(gusts)); });
  gustBtn.setAttribute('aria-pressed', String(gusts));
  spdIn.value = spdKt; spdOut.value = spdKt + ' kt'; paintDial();
})();

// ================================================================ 06 generative
(() => {
  const cv = $('#iso'); if (!cv) return;
  const ctx = cv.getContext('2d'), read = $('#isoRead');
  // 2-D simplex noise (Gustavson), seeded permutation
  const G = [[1, 1], [-1, 1], [1, -1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]];
  const perm = new Uint8Array(512);
  { const p = new Uint8Array(256); for (let i = 0; i < 256; i++) p[i] = i; let s = 1337;
    for (let i = 255; i > 0; i--) { s = (s * 16807) % 2147483647; const j = s % (i + 1); const t = p[i]; p[i] = p[j]; p[j] = t; }
    for (let i = 0; i < 512; i++) perm[i] = p[i & 255]; }
  const F2 = .5 * (Math.sqrt(3) - 1), G2 = (3 - Math.sqrt(3)) / 6;
  function snoise(x, y) {
    const s = (x + y) * F2, i = Math.floor(x + s), j = Math.floor(y + s), t = (i + j) * G2;
    const x0 = x - (i - t), y0 = y - (j - t), i1 = x0 > y0 ? 1 : 0, j1 = x0 > y0 ? 0 : 1;
    const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2, x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2, ii = i & 255, jj = j & 255;
    let n = 0, t0 = .5 - x0 * x0 - y0 * y0, t1 = .5 - x1 * x1 - y1 * y1, t2 = .5 - x2 * x2 - y2 * y2;
    if (t0 > 0) { const g = G[perm[ii + perm[jj]] & 7]; t0 *= t0; n += t0 * t0 * (g[0] * x0 + g[1] * y0); }
    if (t1 > 0) { const g = G[perm[ii + i1 + perm[jj + j1]] & 7]; t1 *= t1; n += t1 * t1 * (g[0] * x1 + g[1] * y1); }
    if (t2 > 0) { const g = G[perm[ii + 1 + perm[jj + 1]] & 7]; t2 *= t2; n += t2 * t2 * (g[0] * x2 + g[1] * y2); }
    return 70 * n;
  }
  const CELL = 12; let cols = 0, rows = 0, C = 0, F = null, W = 0, H = 0;
  const lows = [];
  function field(t) {
    for (let j = 0; j <= rows; j++) for (let i = 0; i <= cols; i++) {
      const x = i * CELL, y = j * CELL;
      let p = 1013 + 22 * (.78 * snoise((x - t * 16) * .0022, y * .0022 + t * .003) + .22 * snoise((x - t * 7) * .0042 + 100, y * .0042 - t * .005 + 50));
      for (const l of lows) { const d2 = (x - l.x) ** 2 + (y - l.y) ** 2; p -= l.amp * l.env * Math.exp(-d2 / (2 * l.sig * l.sig)); }
      F[j * C + i] = p;
    }
  }
  function isolines(level) {
    ctx.beginPath();
    const S = (p, q) => { ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]); };
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      const a = F[j * C + i], b = F[j * C + i + 1], c = F[(j + 1) * C + i + 1], d = F[(j + 1) * C + i];
      if (level < Math.min(a, b, c, d) || level >= Math.max(a, b, c, d)) continue;
      const idx = (a >= level ? 8 : 0) | (b >= level ? 4 : 0) | (c >= level ? 2 : 0) | (d >= level ? 1 : 0);
      const x = i * CELL, y = j * CELL;
      const top = [x + CELL * (level - a) / (b - a), y], right = [x + CELL, y + CELL * (level - b) / (c - b)];
      const bottom = [x + CELL * (level - d) / (c - d), y + CELL], left = [x, y + CELL * (level - a) / (d - a)];
      switch (idx) {
        case 1: case 14: S(left, bottom); break;
        case 2: case 13: S(bottom, right); break;
        case 3: case 12: S(left, right); break;
        case 4: case 11: S(top, right); break;
        case 6: case 9:  S(top, bottom); break;
        case 7: case 8:  S(top, left); break;
        case 5:  if ((a + b + c + d) / 4 >= level) { S(top, left); S(right, bottom); } else { S(top, right); S(left, bottom); } break;
        case 10: if ((a + b + c + d) / 4 >= level) { S(top, right); S(left, bottom); } else { S(top, left); S(right, bottom); } break;
      }
    }
    ctx.stroke();
  }
  const KT = 150; // knots per hPa/px — 5–45 kt around the systems
  function windAt(x, y) {
    const i = clamp(Math.round(x / CELL), 1, cols - 1), j = clamp(Math.round(y / CELL), 1, rows - 1);
    const dpdx = (F[j * C + i + 1] - F[j * C + i - 1]) / (2 * CELL), dpdn = -(F[(j + 1) * C + i] - F[(j - 1) * C + i]) / (2 * CELL);
    const u = -dpdn * KT, v = dpdx * KT;
    return { u, v, spd: Math.min(75, Math.hypot(u, v)), from: (Math.atan2(-u, -v) / DEG + 360) % 360, p: F[j * C + i] };
  }
  function barb(x, y, w) {
    const kt = Math.round(w.spd / 5) * 5;
    ctx.save(); ctx.translate(x, y);
    if (kt < 5) { ctx.beginPath(); ctx.arc(0, 0, 4, 0, 7); ctx.stroke(); ctx.restore(); return; }
    ctx.rotate(w.from * DEG);
    const L = 26, bl = 9, gap = 4.2; let yy = -L, rem = kt;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -L); ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, 2.2, 0, 7); ctx.fill();
    while (rem >= 50) { ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(bl * .95, yy + gap * .5); ctx.lineTo(0, yy + gap * 1.6); ctx.closePath(); ctx.fill(); yy += gap * 1.8; rem -= 50; }
    while (rem >= 10) { ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(bl * .87, yy - bl * .5); ctx.stroke(); yy += gap; rem -= 10; }
    if (rem >= 5) { if (yy === -L) yy += gap; ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(bl * .45, yy - bl * .26); ctx.stroke(); }
    ctx.restore();
  }
  function centers() {
    const out = [], R = 6;
    for (let j = R; j <= rows - R; j += 2) for (let i = R; i <= cols - R; i += 2) {
      const v = F[j * C + i]; let mx = true, mn = true;
      for (let dj = -R; dj <= R && (mx || mn); dj += 2) for (let di = -R; di <= R; di += 2) {
        if (!di && !dj) continue; const u = F[(j + dj) * C + i + di]; if (u >= v) mx = false; if (u <= v) mn = false; if (!mx && !mn) break;
      }
      if (!mx && !mn) continue;
      let s = 0, n = 0;
      for (let k = 0; k < 16; k++) { const a = k / 16 * 2 * Math.PI; const ii = Math.round(i + R * 1.7 * Math.cos(a)), jj = Math.round(j + R * 1.7 * Math.sin(a)); if (ii >= 0 && ii <= cols && jj >= 0 && jj <= rows) { s += F[jj * C + ii]; n++; } }
      if (n && Math.abs(v - s / n) > 3) out.push({ x: i * CELL, y: j * CELL, p: v, hi: mx });
    }
    out.sort((a, b) => (b.hi ? b.p : 2000 - b.p) - (a.hi ? a.p : 2000 - a.p));
    const keep = []; for (const c of out) if (!keep.some(k => Math.hypot(k.x - c.x, k.y - c.y) < 130)) keep.push(c);
    return keep;
  }
  let hover = null;
  Vis.loop(cv, (dt, t) => {
    const s = fitCanvas(cv);
    if (s.w !== W || s.h !== H) { W = s.w; H = s.h; cols = Math.ceil(W / CELL) + 1; rows = Math.ceil(H / CELL) + 1; C = cols + 1; F = new Float32Array(C * (rows + 1)); }
    for (let k = lows.length - 1; k >= 0; k--) { const l = lows[k], age = t - l.t0; l.env = Math.min(1, age / 1.5) * Math.exp(-Math.max(0, age - 1.5) / 9); if (age > 1.5 && l.env < .03) lows.splice(k, 1); }
    field(t);
    ctx.setTransform(s.dpr, 0, 0, s.dpr, 0, 0); ctx.clearRect(0, 0, W, H);
    ctx.lineWidth = 1; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    for (let lv = 976; lv <= 1048; lv += 4) { ctx.strokeStyle = pal.rgba('ink', lv % 8 === 0 ? .42 : .22); isolines(lv); }
    ctx.strokeStyle = pal.css('accent'); ctx.fillStyle = pal.css('accent'); ctx.lineWidth = 1.3;
    for (let y = 40; y < H; y += 72) for (let x = 40 + (Math.round(y / 72) % 2) * 36; x < W; x += 72) barb(x, y, windAt(x, y));
    ctx.font = `800 20px ${getComputedStyle(cv).getPropertyValue('--mono') || 'monospace'}`; ctx.textAlign = 'center';
    for (const c of centers()) {
      ctx.fillStyle = c.hi ? pal.css('blue') : pal.css('red'); ctx.fillText(c.hi ? 'H' : 'L', c.x, c.y + 7);
      ctx.fillStyle = pal.rgba('ink', .85); ctx.font = `600 11px ${getComputedStyle(cv).getPropertyValue('--mono') || 'monospace'}`; ctx.fillText(Math.round(c.p), c.x, c.y + 22);
      ctx.font = `800 20px ${getComputedStyle(cv).getPropertyValue('--mono') || 'monospace'}`;
    }
    if (hover) { const w = windAt(hover.x, hover.y); read.textContent = `${w.p.toFixed(1)} hPa · ${String(Math.round(w.from)).padStart(3, '0')}° ${Math.round(w.spd)} kt`; }
    else read.textContent = `${lows.length ? lows.length + ' low' + (lows.length > 1 ? 's' : '') + ' · ' : ''}4 hPa isobars · geostrophic barbs`;
  });
  const pos = e => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  cv.addEventListener('pointermove', e => { if (e.pointerType !== 'touch') hover = pos(e); });
  cv.addEventListener('pointerleave', () => { hover = null; });
  cv.addEventListener('click', e => { const p = pos(e); if (lows.length >= 6) lows.shift(); lows.push({ x: p.x, y: p.y, amp: 7, sig: 90, t0: performance.now() / 1000, env: 0 }); });
})();

// ================================================================ 07 sound
(() => {
  const knob = $('#knob'); if (!knob) return;
  // Frequencies as on the SFRA page (verified against FAA NASR, 2026-08 cycle).
  const STATIONS = [
    { id: 'DCA', f: 111.00, n: 'Washington',  t: 'VOR/DME' },
    { id: 'ADW', f: 113.10, n: 'Andrews',     t: 'VORTAC' },
    { id: 'AML', f: 113.50, n: 'Armel',       t: 'VOR/DME' },
    { id: 'BAL', f: 115.10, n: 'Baltimore',   t: 'VORTAC' },
    { id: 'CSN', f: 116.30, n: 'Casanova',    t: 'VORTAC' },
    { id: 'EMI', f: 117.90, n: 'Westminster', t: 'VORTAC' },
  ];
  const MORSE = { A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.', H: '....', I: '..', J: '.---', K: '-.-', L: '.-..', M: '--', N: '-.', O: '---', P: '.--.', Q: '--.-', R: '.-.', S: '...', T: '-', U: '..-', V: '...-', W: '.--', X: '-..-', Y: '-.--', Z: '--..' };
  let act = 115.10, sby = 111.00, ao = 0, ai = 0;
  const fA = $('#fAct'), fS = $('#fSby'), idEl = $('#ident .id'), codeEl = $('#ident .code'), nmEl = $('#ident .nm');
  const scope = $('#scope'), sctx = scope.getContext('2d'), sndLocal = $('#sndLocal');
  const fmt = f => f.toFixed(2);
  const stationFor = f => STATIONS.find(s => Math.abs(s.f - f) < 1e-6);
  function update() {
    fA.textContent = fmt(act); fS.textContent = fmt(sby);
    knob.style.setProperty('--ao', ao + 'deg'); knob.style.setProperty('--ai', ai + 'deg'); knob.setAttribute('aria-valuetext', fmt(sby) + ' standby');
    $$('#stations .chip').forEach(c => { c.classList.toggle('tuned', Math.abs(+c.dataset.f - act) < 1e-6); c.setAttribute('aria-pressed', String(Math.abs(+c.dataset.f - sby) < 1e-6)); });
  }
  function stepInner(d) { const mhz = Math.floor(sby + 1e-6); let k = Math.round((sby - mhz) * 100); k = (k + d * 5 + 100) % 100; sby = mhz + k / 100; ai += d * 18; update(); Sound.clack(); }
  function stepOuter(d) { let mhz = Math.floor(sby + 1e-6); const k = Math.round((sby - mhz) * 100); mhz += d; if (mhz > 117) mhz = 108; if (mhz < 108) mhz = 117; sby = mhz + k / 100; ao += d * 30; update(); Sound.clack(); }
  let drag = null;
  knob.addEventListener('pointerdown', e => {
    const r = knob.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    drag = { cx, cy, inner: Math.hypot(e.clientX - cx, e.clientY - cy) < r.width * .28, last: Math.atan2(e.clientY - cy, e.clientX - cx), acc: 0 };
    try { knob.setPointerCapture(e.pointerId); } catch (_) {}
    e.preventDefault();
  });
  knob.addEventListener('pointermove', e => {
    if (!drag) return;
    const a = Math.atan2(e.clientY - drag.cy, e.clientX - drag.cx); let d = a - drag.last;
    if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI;
    drag.last = a; drag.acc += d / DEG; const st = drag.inner ? 18 : 30, fn = drag.inner ? stepInner : stepOuter;
    while (drag.acc >= st) { drag.acc -= st; fn(1); }
    while (drag.acc <= -st) { drag.acc += st; fn(-1); }
  });
  const end = () => { drag = null; };
  knob.addEventListener('pointerup', end); knob.addEventListener('pointercancel', end);
  knob.addEventListener('wheel', e => { e.preventDefault(); (e.shiftKey ? stepOuter : stepInner)(e.deltaY < 0 ? 1 : -1); }, { passive: false });
  knob.addEventListener('keydown', e => {
    const m = { ArrowRight: [stepInner, 1], ArrowLeft: [stepInner, -1], ArrowUp: [stepOuter, 1], ArrowDown: [stepOuter, -1] }[e.key];
    if (m) { m[0](m[1]); e.preventDefault(); } else if (e.key === 'Enter') { flip(); e.preventDefault(); }
  });
  $('#flip').addEventListener('click', flip);
  const sc = $('#stations');
  for (const s of STATIONS) {
    const b = document.createElement('button'); b.className = 'chip'; b.type = 'button'; b.dataset.f = s.f;
    b.innerHTML = `<b>${s.id}</b> ${fmt(s.f)}`; b.title = `${s.n} ${s.t} → standby`;
    b.addEventListener('click', () => { sby = s.f; update(); }); sc.appendChild(b);
  }
  // ident
  const DIT = .085; let identTimer = null, timers = [], keyed = false, visible = false;
  function cancelPlay() { clearTimeout(identTimer); identTimer = null; timers.forEach(clearTimeout); timers = []; keyed = false; }
  function key(li, on) { const sp = idEl.children; for (let i = 0; i < sp.length; i++) sp[i].className = (on && i === li) ? 'on' : 'off'; keyed = on; }
  function playIdent(s) {
    const ev = []; let t = .5;
    [...s.id].forEach((ch, li) => { for (const sym of MORSE[ch]) { const d = sym === '.' ? DIT : 3 * DIT; ev.push({ t, d, li }); t += d + DIT; } t += 2 * DIT; });
    if (Sound.on) { const c = Sound.ensure(), a0 = c.currentTime; for (const e of ev) Sound.tone(1020, a0 + e.t, e.d); }
    for (const e of ev) { timers.push(setTimeout(() => key(e.li, true), e.t * 1000)); timers.push(setTimeout(() => key(e.li, false), (e.t + e.d) * 1000)); }
    identTimer = setTimeout(() => { timers = []; playIdent(s); }, (t + 5.5) * 1000);
  }
  function retune() {
    cancelPlay();
    const s = stationFor(act);
    if (!s) { idEl.innerHTML = ''; codeEl.textContent = '— — —'; nmEl.textContent = 'no ident'; return; }
    idEl.innerHTML = [...s.id].map(ch => `<span class="off">${ch}</span>`).join('');
    codeEl.textContent = [...s.id].map(ch => MORSE[ch].replace(/\./g, '·').replace(/-/g, '−')).join(' ');
    nmEl.textContent = `${s.n} · ${s.t}`;
    if (visible) playIdent(s);
  }
  function flip() { [act, sby] = [sby, act]; update(); retune(); Sound.clack(); }
  // scope: scrolling keyed-carrier strip
  const hist = new Uint8Array(1024); let hp = 0;
  Vis.add(scope, () => { visible = true; retune(); scopeRaf = requestAnimationFrame(scopeTick); }, () => { visible = false; cancelPlay(); cancelAnimationFrame(scopeRaf); });
  let scopeRaf = 0;
  function scopeTick() {
    const s = fitCanvas(scope); hist[hp] = keyed ? 1 : 0; hp = (hp + 1) % hist.length;
    sctx.setTransform(s.dpr, 0, 0, s.dpr, 0, 0); sctx.clearRect(0, 0, s.w, s.h);
    const amber = getComputedStyle(scope.parentElement).getPropertyValue('--amber') || '#f0b429';
    sctx.strokeStyle = amber; sctx.globalAlpha = .25; sctx.beginPath(); sctx.moveTo(0, s.h / 2 + .5); sctx.lineTo(s.w, s.h / 2 + .5); sctx.stroke();
    sctx.globalAlpha = 1; sctx.fillStyle = amber; sctx.shadowColor = amber; sctx.shadowBlur = 6;
    const n = Math.min(hist.length, Math.floor(s.w)); let run = -1;
    for (let k = 0; k < n; k++) {
      const v = hist[(hp - n + k + hist.length) % hist.length];
      if (v && run < 0) run = k; if ((!v || k === n - 1) && run >= 0) { sctx.fillRect(run, 3, k - run + (v ? 1 : 0), s.h - 6); run = -1; }
    }
    sctx.shadowBlur = 0;
    scopeRaf = requestAnimationFrame(scopeTick);
  }
  sndLocal.addEventListener('click', () => Sound.set(!Sound.on));
  document.addEventListener('sound', () => { sndLocal.setAttribute('aria-pressed', String(Sound.on)); sndLocal.textContent = Sound.on ? 'sound on' : 'sound off'; if (visible) retune(); });
  update();
})();

// ================================================================ 08 icons
(() => {
  const wrap = $('#iconGrid'); if (!wrap) return;
  const ICONS = [
    ['compass', '<circle cx="12" cy="12" r="9"/><g class="needle"><path class="fa" d="M12 5 L14.4 12 L9.6 12 Z"/><path d="M12 19 L14.4 12 L9.6 12 Z" fill="currentColor" stroke="none"/></g><circle cx="12" cy="12" r="1.1" fill="var(--bg2)" stroke="none"/>'],
    ['windsock', '<path d="M5 3v18M3 21h4"/><g class="sock"><path d="M5 6 L19.5 8.6 V10.9 L5 13.5 Z"/><path d="M9.8 6.9v5.7M14.6 7.7v4.1" opacity=".55"/></g>'],
    ['rain', '<path d="M7 16a4 4 0 0 1-.5-8 5.5 5.5 0 0 1 10.6 1.6A3.3 3.3 0 0 1 17 16Z"/><g class="ac"><path class="drop" d="M9 18.5v2.2"/><path class="drop" d="M12.5 18.5v2.2"/><path class="drop" d="M16 18.5v2.2"/></g>'],
    ['aircraft', '<path class="plane" d="M12 2.5 L13.3 8.2 L21 11.6 V13.3 L13.3 11.2 L12.9 17 L15.6 18.9 V20.4 L12 19.3 L8.4 20.4 V18.9 L11.1 17 L10.7 11.2 L3 13.3 V11.6 L10.7 8.2 Z"/>'],
    ['radio', '<path d="M12 21V9.5M8.5 21h7"/><circle class="fa" cx="12" cy="7.5" r="1.6"/><g class="ac"><path class="wave w1" d="M8.6 10.9a4.8 4.8 0 0 1 0-6.8M15.4 4.1a4.8 4.8 0 0 1 0 6.8"/><path class="wave w2" d="M5.8 13.7a8.8 8.8 0 0 1 0-12.4M18.2 1.3a8.8 8.8 0 0 1 0 12.4"/></g>'],
    ['lightning', '<path d="M6.5 15.5a4 4 0 0 1 0-7.6 5.5 5.5 0 0 1 10.6 1.7 3.3 3.3 0 0 1 .4 6"/><path class="bolt ac" d="M12.6 10.5 L9.4 16.6 H12.1 L11 22 L14.6 15.3 H12 L13.1 10.5 Z"/>'],
    ['sun', '<circle cx="12" cy="12" r="3.8"/><g class="rays ac"><path d="M12 2.5v2.4M12 19.1v2.4M2.5 12h2.4M19.1 12h2.4M5.3 5.3l1.7 1.7M17 17l1.7 1.7M5.3 18.7 7 17M17 7l1.7-1.7"/></g>'],
    ['runway', '<path d="M8 21 L10.4 3 H13.6 L16 21 Z"/><path class="cl ac" d="M12 18.5 V5.5" stroke-dasharray="2 2"/><path d="M9.6 17.5h4.8" opacity=".5"/>'],
  ];
  const svg = (body, size) => `<svg class="ico" viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true">${body}</svg>`;
  const figs = ICONS.map(([name, body]) => {
    const f = document.createElement('figure'); f.tabIndex = 0; f.innerHTML = svg(body, 48) + `<figcaption>${name}</figcaption>`;
    f.addEventListener('click', () => { f.classList.add('play'); setTimeout(() => f.classList.remove('play'), 2600); });
    wrap.appendChild(f); return f;
  });
  let did = false;
  Vis.add(wrap, () => { if (did || RM) return; did = true; figs.forEach((f, i) => setTimeout(() => { f.classList.add('play'); setTimeout(() => f.classList.remove('play'), 2600); }, i * 160)); }, () => {});
  const sizes = $('#iconSizes');
  for (const sz of [16, 24, 32, 48, 96]) { const d = document.createElement('div'); d.innerHTML = svg(ICONS[0][1], sz) + `<small>${sz}</small>`; sizes.appendChild(d); }
})();

})();
