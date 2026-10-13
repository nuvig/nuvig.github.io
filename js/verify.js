/* Forecast verification — verify.html.
   ---------------------------------------------------------------------------
   Scores three kinds of forecast against the METARs that verified them, all
   read from the site's own archive (data/wx/, via WXA):

     MOS   mos/<ID>/<day>.json  GFS (MAV) and NAM (MET) station guidance,
                                every run, from IEM (live + backfilled)
     TAF   taf/<day>.json       every LWX issuance for KMTN/KBWI/KDCA —
                                decoded IWXXM periods, or raw text (bf) run
                                through TafTac
     grid  grid/<day>.json      the NWS hourly grid at KANP, ~4 snapshots a day
                                (live only, from 2026-08-04)
     obs   obs / fieldobs / stations/<ID>   the verifying METARs

   Every forecast is expanded to (issue, valid hour, forecast) records; each
   record with a METAR within ±30 min of its valid hour is one scored pair,
   counted in the lead band of valid − issue. MOS has no issue time in the
   archive, only its model run, so issue = run + 4 h (MAV/MET text goes out
   ~3.5-4 h after the cycle). Persistence — "the weather at issue time stays"
   — is scored alongside as the floor any forecast has to beat.

   MOS ceiling / visibility are category codes, not values; flight category
   comes straight from the codes (MAV/MET tables below). Everything °true. */

'use strict';

const TZ = SITE.weather.timeZone;
const H = 3600;
const MOS_ISSUE_DELAY = 4 * H;

const BANDS = [
  { k: '0', a: 0, b: 6, label: '0–6 h' },
  { k: '6', a: 6, b: 12, label: '6–12 h' },
  { k: '12', a: 12, b: 24, label: '12–24 h' },
  { k: '24', a: 24, b: 48, label: '24–48 h' },
  { k: '48', a: 48, b: 72, label: '48–72 h' },
  { k: 'all', a: 0, b: 72, label: 'all' },
];
const WINDOWS = [7, 30, 90];
const STATIONS = ['KNAK', 'KBWI', 'KDCA', 'KMTN'];
const BUCKET_H = 3;                      // lead-chart resolution
const NBUCKET = 72 / BUCKET_H;

const PRODUCTS = {
  gfs: { label: 'GFS MOS', color: 'var(--s-gfs)' },
  nam: { label: 'NAM MOS', color: 'var(--s-nam)' },
  taf: { label: 'TAF', color: 'var(--s-third)' },
  grid: { label: 'NWS grid', color: 'var(--s-third)' },
  pers: { label: 'Persistence', color: '#8a8a8a', dash: true },
};

const CAT = [
  { name: 'VFR', color: '#22c55e' },
  { name: 'MVFR', color: '#4a9eff' },
  { name: 'IFR', color: '#ef4444' },
  { name: 'LIFR', color: '#d946ef' },
];

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ------------------------------------------------------------------ state */

const S = {
  st: 'KBWI', win: 30, band: '6', metric: 'cat', mosModel: 'GFS',
  idx: null, gen: 0,
};

(function readUrl() {
  const q = new URLSearchParams(location.search);
  if (STATIONS.includes(q.get('st'))) S.st = q.get('st');
  if (WINDOWS.includes(+q.get('w'))) S.win = +q.get('w');
  if (BANDS.some((b) => b.k === q.get('lead'))) S.band = q.get('lead');
})();

function writeUrl() {
  const q = new URLSearchParams({ st: S.st, w: S.win, lead: S.band });
  history.replaceState(null, '', `${location.pathname}?${q}`);
}

/* ------------------------------------------------------------ time helpers */

const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const hourFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric' });
const wdayFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' });
const mdFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric' });
const localDay = (sec) => dayFmt.format(new Date(sec * 1000));

function dayList(n, extra = 0) {
  const [y, m, d] = localDay(Date.now() / 1000).split('-').map(Number);
  const out = [];
  for (let k = n - 1 + extra; k >= 0; k--) {
    out.push(new Date(Date.UTC(y, m - 1, d - k)).toISOString().slice(0, 10));
  }
  return out;
}

const zLabel = (sec) => `${String(new Date(sec * 1000).getUTCHours()).padStart(2, '0')}Z`;

/* --------------------------------------------------------- METAR decoding */

function catOf(visSM, ceilFt) {
  const v = visSM == null ? 99 : visSM, c = ceilFt == null ? 99999 : ceilFt;
  if (v < 1 || c < 500) return 3;
  if (v < 3 || c < 1000) return 2;
  if (v <= 5 || c <= 3000) return 1;
  return 0;
}

/* the almanac's parser, trimmed to what is scored */
function parseMetar(raw) {
  const body = raw.split(' RMK')[0];
  const o = {};
  const w = body.match(/(?:^|\s)(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?KT\b/);
  if (w) { o.dir = w[1] === 'VRB' ? null : +w[1]; o.spd = +w[2]; }
  if (/\bP6SM\b/.test(body)) o.visSM = 7;
  else {
    const v = body.match(/(?:^|\s)(?:(\d{1,2})\s)?(M)?(\d{1,2})(?:\/(\d{1,2}))?SM\b/);
    if (v) {
      o.visSM = (+v[1] || 0) + (v[4] ? +v[3] / +v[4] : +v[3]);
      if (v[2]) o.visSM = Math.max(0, o.visSM - 0.01);
    }
  }
  o.ceilFt = null;
  const cre = /\b(FEW|SCT|BKN|OVC|VV)(\d{3})/g;
  let c;
  while ((c = cre.exec(body))) {
    if (c[1] === 'BKN' || c[1] === 'OVC' || c[1] === 'VV') { o.ceilFt = +c[2] * 100; break; }
  }
  const tg = raw.match(/\bT([01])(\d{3})([01])(\d{3})\b/);
  if (tg) o.tC = (tg[1] === '1' ? -1 : 1) * +tg[2] / 10;
  else {
    const t2 = body.match(/\s(M?\d{2})\/(M?\d{2})\b/);
    if (t2) o.tC = +t2[1].replace('M', '-');
  }
  const pg = raw.match(/\bP(\d{4})\b/);
  o.precip = /(?:^|\s)[+-]?(?:VC)?(?:TS|SH|FZ)?(?:RA|DZ|SN|PL|GS|GR|UP)/.test(body)
    || /(?:^|\s)[+-]?TS/.test(body) || !!(pg && +pg[1] > 0);
  o.hasVis = o.visSM != null;
  o.cat = catOf(o.visSM, o.ceilFt);
  return o;
}

const cToF = (c) => c * 9 / 5 + 32;

/* ----------------------------------------------------------- MOS decoding */

/* MAV/MET category codes (1 = lowest). CIG: 1 <200 · 2 200-400 · 3 500-900 ·
   4 1000-1900 · 5 2000-3000 · 6 3100-6500 · 7 6600-12000 · 8 >12000/unlimited.
   VIS: 1 <½ · 2 ½-<1 · 3 1-<2 · 4 2-<3 · 5 3-5 · 6 6 · 7 >6 SM. */
const MOS_CIG = ['<200', '200–400', '500–900', '1000–1900', '2000–3000', '3100–6500', '6600–12000', 'none'];
const MOS_VIS = ['<½', '½–<1', '1–<2', '2–<3', '3–5', '6', '>6'];
const MOS_SKY = { CL: 'CLR', FW: 'FEW', SC: 'SCT', BK: 'BKN', OV: 'OVC' };

function mosCat(cig, vis) {
  if (cig == null && vis == null) return null;
  const c = cig == null ? 8 : cig, v = vis == null ? 7 : vis;
  if (c <= 2 || v <= 2) return 3;
  if (c === 3 || v <= 4) return 2;
  if (c <= 5 || v === 5) return 1;
  return 0;
}

/* ----------------------------------------------------------- TAF decoding */

const SM_M = [[0.25, 400], [0.5, 800], [0.75, 1200], [1, 1600], [1.5, 2400],
  [2, 3200], [3, 4800], [4, 6000], [5, 8000], [6, 9000]];
function visSMofM(m) {
  if (m == null) return null;
  if (m > 9000) return 7;
  for (const [sm, mm] of SM_M) if (Math.abs(mm - m) < 50) return sm;
  return m / 1609.34;
}

function tafPeriods(e) {
  if (e.periods && e.periods.length) return e.periods;
  if (e.raw && window.TafTac) {
    try { return TafTac.parse(e.raw, e.t).periods || []; } catch (_) { return []; }
  }
  return [];
}

const isFm = (ind) => /^(FM|FROM|BASE)$/i.test(ind || 'FM');
const isBecmg = (ind) => /^BEC/i.test(ind || '');

/* One issuance -> hourly prevailing state, top of each hour in its validity. */
function expandTaf(e) {
  const ps = tafPeriods(e).filter((p) => p.b != null && p.e != null).sort((x, y) => x.b - y.b);
  const prev = ps.filter((p) => isFm(p.ind) || isBecmg(p.ind));
  if (!prev.length) return [];
  const start = Math.ceil(Math.min(...prev.map((p) => p.b)) / H) * H;
  const end = Math.max(...ps.map((p) => p.e));
  const out = [];
  for (let h = start; h < end; h += H) {
    let st = null;
    for (const p of prev) {
      if (p.b > h) break;
      if (isFm(p.ind)) { if (h < p.e) st = { ...p, cld: p.cld || [] }; }
      else if (st) {                                    // BECMG: changed elements only
        for (const k of ['dir', 'kt', 'visM']) if (p[k] != null) st[k] = p[k];
        if (p.cld && p.cld.length) st.cld = p.cld;
      }
    }
    if (!st) continue;
    let ceil = null;
    for (const c of st.cld) {
      if ((c.amt === 'BKN' || c.amt === 'OVC' || c.amt === 'VV') && c.ft != null) {
        if (ceil == null || c.ft < ceil) ceil = c.ft;
      }
    }
    const vis = visSMofM(st.visM);
    out.push({ v: h, cat: catOf(vis, ceil), spd: st.kt, dir: st.kt ? st.dir : null });
  }
  return out;
}

/* ------------------------------------------------------------------ load */

function obsStream(st, idx) {
  if (st === idx.station) return 'obs';
  if (st === idx.field_station) return 'fieldobs';
  return `stations/${st}`;
}

const has = (list, d) => !!list && list.includes(d);

async function loadStation(st, win) {
  const idx = S.idx;
  const days = dayList(win);
  const fcDays = dayList(win, 3);                      // runs/issuances made before the window
  const obsName = obsStream(st, idx);
  const obsDays = obsName === 'obs' ? idx.obs_days : obsName === 'fieldobs' ? idx.fieldobs_days
    : (idx.station_days || {})[st];
  const mosDays = (idx.mos_days || {})[st];
  const tafOn = (idx.taf_stations || []).includes(st);
  const gridOn = st === idx.field_station;

  const want = (cond, path) => (cond ? WXA.json(path) : Promise.resolve(null));
  const [obsDocs, mosDocs, tafDocs, gridDocs] = await Promise.all([
    Promise.all(dayList(win, 1).map((d) => want(has(obsDays, d), `${obsName}/${d}.json`))),
    Promise.all(fcDays.map((d) => want(has(mosDays, d), `mos/${st}/${d}.json`))),
    Promise.all(fcDays.map((d) => want(tafOn && has(idx.taf_days, d), `taf/${d}.json`))),
    Promise.all(fcDays.map((d) => want(gridOn && has(idx.grid_days, d), `grid/${d}.json`))),
  ]);

  /* observations, time-sorted */
  const obs = [];
  for (const doc of obsDocs) {
    for (const [t, raw] of (doc && doc.metars) || []) {
      const o = parseMetar(raw);
      o.t = t;
      obs.push(o);
    }
  }
  obs.sort((a, b) => a.t - b.t);

  /* forecasts: {p, iss, v, cat, spd, dir, tF, pop} */
  const fc = [];
  const counts = { gfs: 0, nam: 0, taf: 0, grid: 0 };
  const latestMos = {};
  for (const doc of mosDocs) {
    if (!doc) continue;
    const cols = doc.cols || ['ft', 'tmp', 'dpt', 'wdr', 'wsp', 'cig', 'vis', 'p06', 'cld', 'obv'];
    const ci = Object.fromEntries(cols.map((c, i) => [c, i]));
    for (const r of doc.runs || []) {
      const p = r.m === 'NAM' ? 'nam' : 'gfs';
      counts[p]++;
      if (!latestMos[r.m] || r.t > latestMos[r.m].run.t) latestMos[r.m] = { run: r, ci };
      for (const row of r.f) {
        const g = (k) => (ci[k] == null ? null : row[ci[k]]);
        const wsp = g('wsp');
        fc.push({
          p, iss: r.t + MOS_ISSUE_DELAY, v: row[ci.ft],
          cat: mosCat(g('cig'), g('vis')), spd: wsp,
          dir: wsp ? g('wdr') : null, tF: g('tmp'), pop: g('p06'),
        });
      }
    }
  }
  const seenTaf = new Set();
  for (const doc of tafDocs) {
    for (const e of (doc && doc.tafs) || []) {
      if (e.station !== st || seenTaf.has(e.t)) continue;
      seenTaf.add(e.t);
      counts.taf++;
      for (const h of expandTaf(e)) fc.push({ p: 'taf', iss: e.t, ...h });
    }
  }
  for (const doc of gridDocs) {
    for (const s of (doc && doc.snaps) || []) {
      counts.grid++;
      for (let i = 0; i < s.n; i++) {
        const v = s.t0 + i * H;
        if (v <= s.t) continue;
        const at = (k) => (s[k] ? s[k][i] : null);
        let pop = null;
        if (new Date(v * 1000).getUTCHours() % 6 === 0 && s.pop) {
          for (let j = Math.max(0, i - 5); j <= i; j++) if (s.pop[j] != null) pop = Math.max(pop || 0, s.pop[j]);
        }
        const tC = at('temp');
        fc.push({
          p: 'grid', iss: s.t, v, cat: catOf(at('vis'), at('ceil')),
          spd: at('spd'), dir: at('spd') ? at('dir') : null,
          tF: tC == null ? null : cToF(tC), pop,
        });
      }
    }
  }

  const [y0, m0, d0] = days[0].split('-').map(Number);
  const from = Date.UTC(y0, m0 - 1, d0) / 1000 + 4 * H;   // ~local midnight (EDT/EST)
  return { st, days, obs, fc, counts, latestMos, from, tafOn, gridOn, obsName };
}

/* -------------------------------------------------------------- matching */

function nearestOb(obs, v) {
  let lo = 0, hi = obs.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (obs[m].t < v) lo = m + 1; else hi = m; }
  let best = null;
  for (const k of [lo - 1, lo]) {
    const o = obs[k];
    if (o && Math.abs(o.t - v) <= 1800 && (!best || Math.abs(o.t - v) < Math.abs(best.t - v))) best = o;
  }
  return best;
}

/* precipitation in (v − 6 h, v]; null when fewer than 4 obs cover it */
function precip6(obs, v) {
  let n = 0, any = false;
  for (let i = obs.length - 1; i >= 0; i--) {
    const o = obs[i];
    if (o.t > v) continue;
    if (o.t <= v - 6 * H) break;
    n++;
    if (o.precip) any = true;
  }
  return n >= 4 ? any : null;
}

/* ------------------------------------------------------------- scoring */

const acc = () => ({ n: 0, cat: 0, catN: 0, ih: 0, im: 0, ifa: 0, sAbs: 0, sBias: 0, sN: 0,
  dAbs: 0, dN: 0, tAbs: 0, tBias: 0, tN: 0, br: 0, bN: 0 });

function addPair(a, f, o, wet) {
  a.n++;
  if (f.cat != null && o.hasVis) {
    a.catN++;
    if (f.cat === o.cat) a.cat++;
    const fi = f.cat >= 2, oi = o.cat >= 2;
    if (fi && oi) a.ih++; else if (oi) a.im++; else if (fi) a.ifa++;
  }
  if (f.spd != null && o.spd != null) { a.sN++; a.sAbs += Math.abs(f.spd - o.spd); a.sBias += f.spd - o.spd; }
  if (f.dir != null && o.dir != null && o.spd >= 6) {
    let d = Math.abs(f.dir - o.dir) % 360;
    if (d > 180) d = 360 - d;
    a.dN++; a.dAbs += d;
  }
  if (f.tF != null && o.tC != null) { const e = f.tF - cToF(o.tC); a.tN++; a.tAbs += Math.abs(e); a.tBias += e; }
  if (f.pop != null && wet != null) { a.bN++; a.br += (f.pop / 100 - (wet ? 1 : 0)) ** 2; }
}

function merge(into, a) { for (const k in a) into[k] += a[k]; return into; }

const METRICS = {
  cat: { label: 'Category', unit: '%', better: 'hi', min: 20,
    val: (a) => (a.catN >= 20 ? 100 * a.cat / a.catN : null), fmt: (x) => `${x.toFixed(0)}%` },
  csi: { label: 'IFR CSI', unit: '', better: 'hi', min: 5,
    val: (a) => (a.ih + a.im + a.ifa >= 5 ? a.ih / (a.ih + a.im + a.ifa) : null), fmt: (x) => x.toFixed(2) },
  spd: { label: 'Wind kt', unit: 'kt', better: 'lo',
    val: (a) => (a.sN >= 20 ? a.sAbs / a.sN : null), fmt: (x) => x.toFixed(1) },
  dir: { label: 'Wind dir', unit: '°', better: 'lo',
    val: (a) => (a.dN >= 20 ? a.dAbs / a.dN : null), fmt: (x) => `${x.toFixed(0)}°` },
  temp: { label: 'Temp °F', unit: '°F', better: 'lo',
    val: (a) => (a.tN >= 20 ? a.tAbs / a.tN : null), fmt: (x) => x.toFixed(1) },
  pop: { label: 'PoP Brier', unit: '', better: 'lo',
    val: (a) => (a.bN >= 10 ? a.br / a.bN : null), fmt: (x) => x.toFixed(3) },
};

/* Every pair scored once, into its product's per-lead-hour accumulator
   (0..71); bands and chart buckets are sums of those. */
function score(D) {
  const now = Date.now() / 1000;
  const byLead = {};
  const ensure = (p) => (byLead[p] || (byLead[p] = Array.from({ length: 72 }, acc)));
  const wetCache = new Map();
  const wet = (v) => {
    if (!wetCache.has(v)) wetCache.set(v, new Date(v * 1000).getUTCHours() % 6 === 0 ? precip6(D.obs, v) : null);
    return wetCache.get(v);
  };
  const verifying = new Set();
  for (const f of D.fc) {
    if (f.v < D.from || f.v > now) continue;
    const L = Math.floor((f.v - f.iss) / H);
    if (L < 0 || L >= 72) continue;
    const o = nearestOb(D.obs, f.v);
    if (!o) continue;
    verifying.add(f.v);
    addPair(ensure(f.p)[L], f, o, wet(f.v));
  }
  /* persistence: the ob at v − L forecasts v, for every verifying hour */
  const pers = ensure('pers');
  for (const v of verifying) {
    const o = nearestOb(D.obs, v);
    for (let L = 1; L < 72; L++) {
      const p = nearestOb(D.obs, v - L * H);
      if (!p) continue;
      addPair(pers[L], { cat: p.hasVis ? p.cat : null, spd: p.spd, dir: p.spd ? p.dir : null,
        tF: p.tC == null ? null : cToF(p.tC), pop: null }, o, null);
    }
  }
  return { byLead, hours: verifying.size };
}

function bandAcc(arr, band) {
  const a = acc();
  for (let L = band.a; L < band.b; L++) merge(a, arr[L]);
  return a;
}

/* ------------------------------------------------------------- rendering */

function chips(el, items, cur, onPick) {
  el.innerHTML = items.map((it) => `<button class="chip${it.k === cur ? ' on' : ''}" data-k="${esc(it.k)}"` +
    `${it.disabled ? ' disabled' : ''}${it.title ? ` title="${esc(it.title)}"` : ''}>${esc(it.label)}</button>`).join('');
  for (const b of el.querySelectorAll('button')) b.onclick = () => onPick(b.dataset.k);
}

function renderControls() {
  chips($('st-chips'), STATIONS.map((s) => ({ k: s, label: s,
    title: s === S.idx.field_station ? `field · ${SITE.airport.id}` : '' })), S.st,
  (k) => { S.st = k; run(); });
  chips($('win-chips'), WINDOWS.map((w) => ({ k: String(w), label: `${w} d` })), String(S.win),
    (k) => { S.win = +k; run(); });
  chips($('lead-chips'), BANDS.map((b) => ({ k: b.k, label: b.label })), S.band,
    (k) => { S.band = k; render(); });
  chips($('metric-chips'), Object.entries(METRICS).map(([k, m]) => ({ k, label: m.label })), S.metric,
    (k) => { S.metric = k; renderLead(); });
}

function productsFor(D) {
  const ps = [];
  if (D.gridOn) ps.push('grid');
  if (D.tafOn) ps.push('taf');
  ps.push('gfs', 'nam');
  return ps;
}

let D = null, R = null;

function renderStatus() {
  const c = D.counts;
  const parts = [`<span><b>${esc(D.st)}</b>${D.st === S.idx.field_station ? ` · ${esc(SITE.airport.id)} field` : ''}</span>`,
    `<span>${S.win} d</span>`, `<span>hours verified <b>${R.hours}</b></span>`,
    `<span>METARs <b>${D.obs.length}</b></span>`,
    `<span>MOS runs <b>${c.gfs + c.nam}</b></span>`];
  if (D.tafOn) parts.push(`<span>TAFs <b>${c.taf}</b></span>`);
  if (D.gridOn) parts.push(`<span>grid snapshots <b>${c.grid}</b></span>`);
  $('status').innerHTML = parts.join('');
}

function renderScorecard() {
  const band = BANDS.find((b) => b.k === S.band);
  $('sc-sub').textContent = `lead ${band.label}`;
  const prods = productsFor(D).filter((p) => R.byLead[p]).concat('pers');
  const rows = prods.map((p) => ({ p, a: R.byLead[p] ? bandAcc(R.byLead[p], band) : acc() }));
  const keys = Object.keys(METRICS);
  const best = {};
  for (const k of keys) {
    const m = METRICS[k];
    const vals = rows.filter((r) => r.p !== 'pers').map((r) => m.val(r.a)).filter((x) => x != null);
    if (vals.length >= 2) best[k] = m.better === 'hi' ? Math.max(...vals) : Math.min(...vals);
  }
  const missing = productsFor(D).filter((p) => !R.byLead[p]);
  let h = '<table class="sc"><thead><tr><th>forecast</th><th>pairs</th>' +
    keys.map((k) => `<th>${esc(METRICS[k].label)}</th>`).join('') + '</tr></thead><tbody>';
  for (const { p, a } of rows) {
    h += `<tr><td>${swatch(p)}${esc(PRODUCTS[p].label)}</td><td>${a.n || '—'}</td>`;
    for (const k of keys) {
      const m = METRICS[k], x = m.val(a);
      if (x == null) { h += '<td class="na">—</td>'; continue; }
      let extra = '', title = '';
      if (k === 'csi') {
        const pod = a.ih / Math.max(1, a.ih + a.im), far = a.ifa / Math.max(1, a.ih + a.ifa);
        title = `POD ${pod.toFixed(2)} · FAR ${far.toFixed(2)} · ${a.ih + a.im} IFR hours observed`;
      } else if (k === 'spd') extra = sgn(a.sBias / a.sN);
      else if (k === 'temp') extra = sgn(a.tBias / a.tN);
      else if (k === 'cat') title = `${a.cat} / ${a.catN}`;
      const cls = p !== 'pers' && best[k] != null && Math.abs(x - best[k]) < 1e-9 ? ' class="best"' : '';
      h += `<td${cls}${title ? ` title="${esc(title)}"` : ''}>${m.fmt(x)}${extra ? `<span class="sm" title="bias">${extra}</span>` : ''}</td>`;
    }
    h += '</tr>';
  }
  h += '</tbody></table>';
  if (missing.length) {
    h += `<p class="muted">no archive · ${missing.map((p) => esc(PRODUCTS[p].label)).join(', ')} · ${esc(D.st)}</p>`;
  }
  $('scorecard').innerHTML = h;
}

const sgn = (x) => (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(1);
const swatch = (p) => PRODUCTS[p].dash
  ? '<span class="sw" style="background:repeating-linear-gradient(90deg,#8a8a8a 0 3px,transparent 3px 5px)"></span>'
  : `<span class="sw" style="background:${PRODUCTS[p].color}"></span>`;

function renderLead() {
  for (const b of $('metric-chips').querySelectorAll('button')) b.classList.toggle('on', b.dataset.k === S.metric);
  const m = METRICS[S.metric];
  const prods = productsFor(D).filter((p) => R.byLead[p]).concat('pers');
  const series = prods.map((p) => ({
    p,
    pts: Array.from({ length: NBUCKET }, (_, i) => {
      const a = bandAcc(R.byLead[p], { a: i * BUCKET_H, b: (i + 1) * BUCKET_H });
      return { i, y: m.val(a), n: a.n };
    }),
  }));
  const all = series.flatMap((s) => s.pts.map((q) => q.y)).filter((y) => y != null);
  const box = $('lead-chart');
  box.querySelector('svg')?.remove();
  $('lead-sub').textContent = `${m.label}${m.better === 'hi' ? ' · higher is better' : ' · lower is better'}`;
  if (!all.length) {
    box.insertAdjacentHTML('afterbegin', '<svg viewBox="0 0 700 40"><text x="0" y="24">not enough pairs</text></svg>');
    $('lead-legend').innerHTML = '';
    return;
  }
  const W = 700, Hh = 240, ml = 44, mr = 12, mt = 10, mb = 26;
  let lo = Math.min(...all), hi = Math.max(...all);
  if (S.metric === 'cat') { lo = Math.min(lo, 50); hi = 100; }
  if (S.metric === 'csi') { lo = 0; hi = Math.max(hi, 0.5); }
  if (m.better === 'lo') lo = 0;
  const step = niceStep((hi - lo) / 4);
  lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step || step;
  const x = (i) => ml + (i + 0.5) / NBUCKET * (W - ml - mr);
  const y = (v) => mt + (1 - (v - lo) / (hi - lo)) * (Hh - mt - mb);
  let g = '';
  for (let v = lo; v <= hi + 1e-9; v += step) {
    g += `<line class="grid" x1="${ml}" x2="${W - mr}" y1="${y(v)}" y2="${y(v)}"/>` +
      `<text x="${ml - 6}" y="${y(v) + 4}" text-anchor="end">${fmtTick(v, step)}</text>`;
  }
  for (let L = 0; L <= 72; L += 12) {
    const px = ml + L / 72 * (W - ml - mr);
    g += `<text x="${px}" y="${Hh - 8}" text-anchor="middle">${L} h</text>`;
  }
  g += `<line class="ax" x1="${ml}" x2="${W - mr}" y1="${Hh - mb}" y2="${Hh - mb}"/>`;
  for (const s of series) {
    const c = PRODUCTS[s.p].color;
    let d = '', pen = false;
    for (const q of s.pts) {
      if (q.y == null) { pen = false; continue; }
      d += `${pen ? 'L' : 'M'}${x(q.i).toFixed(1)},${y(q.y).toFixed(1)}`;
      pen = true;
    }
    g += `<path d="${d}" fill="none" stroke="${c}" stroke-width="2" stroke-linejoin="round"` +
      `${PRODUCTS[s.p].dash ? ' stroke-dasharray="5 4"' : ''}/>`;
    for (const q of s.pts) {
      if (q.y != null) g += `<circle cx="${x(q.i)}" cy="${y(q.y)}" r="2.5" fill="${c}"/>`;
    }
  }
  g += `<line id="lead-x" class="ax" y1="${mt}" y2="${Hh - mb}" x1="-10" x2="-10" stroke-dasharray="2 3"/>`;
  g += `<rect x="${ml}" y="${mt}" width="${W - ml - mr}" height="${Hh - mt - mb}" fill="transparent" id="lead-hit"/>`;
  box.insertAdjacentHTML('afterbegin', `<svg viewBox="0 0 ${W} ${Hh}" role="img" aria-label="${esc(m.label)} by lead time">${g}</svg>`);
  $('lead-legend').innerHTML = series.map((s) => `<span>${swatch(s.p)}${esc(PRODUCTS[s.p].label)}</span>`).join('');

  const svg = box.querySelector('svg'), tip = $('lead-tip'), cross = svg.querySelector('#lead-x');
  const hit = svg.querySelector('#lead-hit');
  const move = (ev) => {
    const r = svg.getBoundingClientRect();
    const px = (ev.clientX - r.left) / r.width * W;
    const i = Math.max(0, Math.min(NBUCKET - 1, Math.floor((px - ml) / (W - ml - mr) * NBUCKET)));
    cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i));
    tip.innerHTML = `<b>${i * BUCKET_H}–${(i + 1) * BUCKET_H} h</b><br>` + series.map((s) => {
      const q = s.pts[i];
      return `${swatch(s.p)}${esc(PRODUCTS[s.p].label)} ${q.y == null ? '—' : m.fmt(q.y)} <span style="color:#666">n ${q.n}</span>`;
    }).join('<br>');
    tip.style.display = 'block';
    const bx = box.getBoundingClientRect();
    let left = ev.clientX - bx.left + 14;
    if (left + tip.offsetWidth > bx.width) left = ev.clientX - bx.left - tip.offsetWidth - 14;
    tip.style.left = `${Math.max(0, left)}px`;
    tip.style.top = `${Math.max(0, ev.clientY - bx.top - 20)}px`;
  };
  hit.addEventListener('pointermove', move);
  hit.addEventListener('pointerleave', () => { tip.style.display = 'none'; cross.setAttribute('x1', -10); cross.setAttribute('x2', -10); });
}

function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(raw || 1));
  for (const k of [1, 2, 2.5, 5, 10]) if (raw <= k * p) return k * p;
  return 10 * p;
}
const fmtTick = (v, step) => (step < 0.1 ? v.toFixed(2) : step < 1 ? v.toFixed(1) : v.toFixed(0));

function renderStrip() {
  const band = BANDS.find((b) => b.k === S.band);
  $('strip-sub').textContent = `newest forecast at lead ${band.label}`;
  const days = dayList(7);
  const [y0, m0, d0] = days[0].split('-').map(Number);
  /* local midnight of the first day: the UTC instant whose local date flips */
  let start = Date.UTC(y0, m0 - 1, d0) / 1000 - 12 * H;
  while (localDay(start) !== days[0]) start += H;
  start = Math.floor(start / H) * H;
  const now = Date.now() / 1000;
  const hours = [];
  for (let t = start; localDay(t) <= days[6] && hours.length < 7 * 25; t += H) hours.push(t);

  const pick = {};
  for (const f of D.fc) {
    const L = (f.v - f.iss) / H;
    if (L < band.a || L >= band.b || f.cat == null) continue;
    const key = `${f.p}|${f.v}`;
    if (!pick[key] || f.iss > pick[key].iss) pick[key] = f;
  }
  const cell = (cat, first, title) => `<span class="c${first ? ' day0' : ''}"` +
    `${cat != null ? ` style="background:${CAT[cat].color}"` : ''} title="${esc(title)}"></span>`;
  const lab = (t) => `${mdFmt.format(new Date(t * 1000))} ${hourFmt.format(new Date(t * 1000))}`;
  const rowHtml = (name, fn) => `<div class="strip-row"><span class="nm">${esc(name)}</span><span class="cells">` +
    hours.map((t, i) => {
      const first = i > 0 && localDay(t) !== localDay(hours[i - 1]);
      const c = t > now ? null : fn(t);
      return cell(c, first, `${lab(t)} · ${c == null ? '—' : CAT[c].name}`);
    }).join('') + '</span></div>';
  let h = rowHtml('METAR', (t) => { const o = nearestOb(D.obs, t); return o && o.hasVis ? o.cat : null; });
  for (const p of productsFor(D)) {
    if (!R.byLead[p]) continue;
    /* MOS projections are 3-hourly: each holds until the next one */
    const span = p === 'gfs' || p === 'nam' ? 3 : 1;
    h += rowHtml(PRODUCTS[p].label, (t) => {
      for (let k = 0; k < span; k++) { const f = pick[`${p}|${t - k * H}`]; if (f) return f.cat; }
      return null;
    });
  }
  const dayStarts = [];
  hours.forEach((t, i) => { if (i === 0 || localDay(t) !== localDay(hours[i - 1])) dayStarts.push(i); });
  h += '<div class="strip-days">' + dayStarts.map((i, k) => {
    const w = ((dayStarts[k + 1] ?? hours.length) - i) * 4;
    return `<span style="width:${w}px">${esc(mdFmt.format(new Date(hours[i] * 1000)))}</span>`;
  }).join('') + '</div>';
  $('strip').innerHTML = h;
  $('strip').scrollLeft = $('strip').scrollWidth;          // newest at hand on a phone
  $('cat-legend').innerHTML = CAT.map((c) => `<span><span class="sw" style="background:${c.color}"></span>${c.name}</span>`).join('') +
    '<span><span class="sw" style="background:#1f1f1f;border:1px solid #333"></span>none</span>';
}

function renderMos() {
  const models = ['GFS', 'NAM'];
  chips($('mos-chips'), models.map((m) => ({ k: m, label: `${m} MOS`, disabled: !D.latestMos[m] })), S.mosModel,
    (k) => { S.mosModel = k; renderMos(); });
  const L = D.latestMos[S.mosModel] || D.latestMos[models.find((m) => D.latestMos[m])];
  if (!L) {
    $('mos-sub').textContent = '';
    $('mos-table').innerHTML = `<p class="muted">no MOS archived · ${esc(D.st)}</p>`;
    return;
  }
  const { run, ci } = L;
  const g = (row, k) => (ci[k] == null ? null : row[ci[k]]);
  const issued = new Date((run.t + MOS_ISSUE_DELAY) * 1000);
  $('mos-sub').textContent = `${D.st} · ${run.m} ${zLabel(run.t)} ${mdFmt.format(new Date(run.t * 1000))} run · ` +
    `out ~${hourFmt.format(issued)}`;
  const rows = run.f.filter((r) => r[ci.ft] > Date.now() / 1000 - 3 * H);
  const f = rows.length ? rows : run.f;
  const td = (v) => `<td>${v == null || v === '' ? '' : esc(v)}</td>`;
  let lastDay = '';
  const dayRow = f.map((r) => {
    const d = wdayFmt.format(new Date(r[ci.ft] * 1000));
    const out = d !== lastDay ? d : '';
    lastDay = d;
    return td(out);
  }).join('');
  const line = (name, fn) => `<tr><th>${esc(name)}</th>${f.map((r) => td(fn(r))).join('')}</tr>`;
  let h = '<table class="mos">';
  h += `<tr class="day"><th></th>${dayRow}</tr>`;
  h += `<tr class="hd"><th>local</th>${f.map((r) => td(hourFmt.format(new Date(r[ci.ft] * 1000)).replace(' ', ''))).join('')}</tr>`;
  h += line('Temp °F', (r) => g(r, 'tmp'));
  h += line('Dew °F', (r) => g(r, 'dpt'));
  h += line('Wind', (r) => {
    const s = g(r, 'wsp'), d = g(r, 'wdr');
    if (s == null) return null;
    return s === 0 ? 'calm' : `${d == null ? '' : String(d).padStart(3, '0')}/${s}`;
  });
  h += line('Ceiling ft', (r) => { const c = g(r, 'cig'); return c == null ? null : MOS_CIG[c - 1]; });
  h += line('Vis SM', (r) => { const v = g(r, 'vis'); return v == null ? null : MOS_VIS[v - 1]; });
  h += line('Sky', (r) => MOS_SKY[g(r, 'cld')] || g(r, 'cld'));
  h += line('Obstruction', (r) => { const o = g(r, 'obv'); return o && o !== 'N' ? o : null; });
  h += line('PoP 6 h %', (r) => g(r, 'p06'));
  h += `<tr><th>Category</th>${f.map((r) => {
    const c = mosCat(g(r, 'cig'), g(r, 'vis'));
    return c == null ? '<td></td>' : `<td title="${CAT[c].name}"><span class="dot" style="background:${CAT[c].color}"></span></td>`;
  }).join('')}</tr>`;
  h += '</table>';
  $('mos-table').innerHTML = h;
}

function render() {
  if (!D) return;
  writeUrl();
  renderControls();
  renderStatus();
  renderScorecard();
  renderLead();
  renderStrip();
  renderMos();
}

async function run() {
  const gen = ++S.gen;
  writeUrl();
  renderControls();
  $('status').textContent = `Loading ${S.st} · ${S.win} d…`;
  try {
    const d = await loadStation(S.st, S.win);
    if (gen !== S.gen) return;
    D = d;
    R = score(D);
    render();
  } catch (e) {
    $('status').innerHTML = `<span class="err">${esc(e.message || e)}</span>`;
  }
}

(async function init() {
  S.idx = await WXA.index();
  if (!S.idx) { $('status').innerHTML = '<span class="err">archive index unavailable</span>'; return; }
  window.VERIFY_DEBUG = { S, get D() { return D; }, get R() { return R; }, expandTaf, mosCat, parseMetar };
  run();
})();
