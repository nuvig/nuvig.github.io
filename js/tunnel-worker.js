// tunnel-worker.js — runs js/tunnel-model.js off the main thread for tunnel.html.
// Protocol (main → worker): {cmd:'init', opts, run} · {cmd:'shape', shape} · {cmd:'re', re} ·
// {cmd:'reset'} · {cmd:'run', on} · {cmd:'step', n} · {cmd:'bufs', ux, uy, rho} (a buffer set
// handed back after rendering). Worker → main: a field message {t, cl, cd, mean, sep, cp,
// spark, ux, uy, rho, msPerStep, stepsPer} with the arrays transferred, or {reset:true}
// after an unstable run was restarted. The step count per publish adapts to ~12 ms of work.
importScripts('tunnel-model.js?v=1');
let T = null, running = false, pool = [], stepsPer = 4, msPerStep = 3, dirty = false, queued = false;
const ch = new MessageChannel();
ch.port1.onmessage = loop;
function schedule() { if (!queued) { queued = true; ch.port2.postMessage(0); } }

function publish() {
  if (!T || !pool.length) return false;
  const b = pool.pop();
  b.ux.set(T.ux); b.uy.set(T.uy); b.rho.set(T.rho);
  const L = T.hist.length, n = Math.min(T.histN, L), spark = new Float32Array(300);
  for (let k = 0; k < 300; k++) { const back = (300 - k) * 10; spark[k] = back <= n ? T.hist[(T.histN - back + L) % L] : NaN; }
  postMessage({ t: T.t, cl: T.cl, cd: T.cd, mean: T.mean(600), mean2: T.mean(1200), sep: T.separation(), cp: T.cpCurve(),
    spark, ux: b.ux, uy: b.uy, rho: b.rho, msPerStep, stepsPer },
    [b.ux.buffer, b.uy.buffer, b.rho.buffer, spark.buffer]);
  dirty = false;
  return true;
}
function loop() {
  queued = false;
  if (!running || !T) return;
  const t0 = performance.now();
  T.step(stepsPer);
  const dt = performance.now() - t0;
  msPerStep = 0.9 * msPerStep + 0.1 * dt / stepsPer;
  stepsPer = Math.max(1, Math.min(16, Math.round(12 / Math.max(0.2, msPerStep))));
  if (T.unstable) { T.reset(); postMessage({ reset: true }); }
  publish();
  schedule();
}
onmessage = e => {
  const m = e.data;
  switch (m.cmd) {
    case 'init': T = new Tunnel(m.opts); running = !!m.run; dirty = true; schedule(); break;
    case 'shape': if (T) { T.setShape(m.shape); dirty = true; } break;
    case 're': if (T) T.setReynolds(m.re); break;
    case 'reset': if (T) { T.reset(); dirty = true; } break;
    case 'run': running = !!m.on; if (running) schedule(); break;
    case 'step': if (T) { T.step(m.n || 1); dirty = true; } break;
    case 'bufs': pool.push({ ux: m.ux, uy: m.uy, rho: m.rho }); break;
  }
  if (T && !running && dirty) publish();
};
