/* Weather Almanac — the reading room for the site's own weather archive.
   ---------------------------------------------------------------------------
   Everything on this page is read from data/wx/ via WXA (js/wx-archive.js):
   index.json for the catalog, then one file per stream per selected day.
   Nothing here calls a live weather API — if it isn't archived, the card
   hides. Stream shapes are documented in scripts/wxarchive.py; backfilled
   entries (wxbackfill.py, tagged `bf`) differ for TAFs: raw text instead of
   decoded periods, so the TAF card handles both.

   Needs js/site-config.js and js/wx-archive.js loaded first. */

'use strict';

const $ = (id) => document.getElementById(id);
const TZ = SITE.weather.timeZone;

/* ---------------------------------------------------------------------------
   Local time. Archive days are local days at the field (America/New_York) —
   all day/hour math goes through the formatter so viewers anywhere see the
   field's clock, mirroring weather.js's solarTimes() rule.
--------------------------------------------------------------------------- */

const FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

/* epoch seconds -> {date:'YYYY-MM-DD', h, m} at the field */
function lp(ts) {
  const s = FMT.format(new Date(ts * 1000));         // "2026-08-10, 14:05"
  const m = s.match(/(\d{4}-\d{2}-\d{2}),? (\d{2}):(\d{2})/);
  return { date: m[1], h: +m[2], m: +m[3] };
}

const _midCache = new Map();
/* epoch seconds of local midnight starting date 'YYYY-MM-DD' */
function midnight(date) {
  if (_midCache.has(date)) return _midCache.get(date);
  let t = Date.parse(`${date}T00:00:00Z`) / 1000 + 5 * 3600; // EST guess
  for (let i = 0; i < 3; i++) {
    const p = lp(t);
    const off = Date.parse(`${p.date}T00:00:00Z`) / 1000 + p.h * 3600 + p.m * 60
      - Date.parse(`${date}T00:00:00Z`) / 1000;
    if (!off) break;
    t -= off;
  }
  _midCache.set(date, t);
  return t;
}

function addDays(date, n) {
  const d = new Date(Date.parse(`${date}T12:00:00Z`) + n * 86400e3);
  return d.toISOString().slice(0, 10);
}

const hhmm = (ts) => { const p = lp(ts); return `${String(p.h).padStart(2, '0')}:${String(p.m).padStart(2, '0')}`; };
const niceDate = (date) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US',
  { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const dow = (date) => new Date(`${date}T12:00:00Z`).getUTCDay();

/* ---------------------------------------------------------------------------
   METAR decoding — just enough for category, temps, wind and weather.
--------------------------------------------------------------------------- */

const CAT = [
  { name: 'VFR',  color: '#22c55e' },
  { name: 'MVFR', color: '#4a9eff' },
  { name: 'IFR',  color: '#ef4444' },
  { name: 'LIFR', color: '#d946ef' },
];

function catOf(visSM, ceilFt) {
  const v = visSM == null ? 99 : visSM, c = ceilFt == null ? 99999 : ceilFt;
  if (v < 1 || c < 500) return 3;
  if (v < 3 || c < 1000) return 2;
  if (v <= 5 || c <= 3000) return 1;
  return 0;
}

function parseMetar(raw) {
  const body = raw.split(' RMK')[0];
  const o = { raw };

  const w = body.match(/(?:^|\s)(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?KT\b/);
  if (w) { o.dir = w[1] === 'VRB' ? null : +w[1]; o.spd = +w[2]; o.gst = w[3] ? +w[3] : null; }

  if (/\bP6SM\b/.test(body)) o.visSM = 7;
  else {
    const v = body.match(/(?:^|\s)(?:(\d{1,2})\s)?(M)?(\d{1,2})(?:\/(\d{1,2}))?SM\b/);
    if (v) {
      o.visSM = (+v[1] || 0) + (v[4] ? +v[3] / +v[4] : +v[3]);
      if (v[2]) o.visSM = Math.max(0, o.visSM - 0.01);   // M1/4SM = "less than"
    }
  }

  o.ceilFt = null; o.clouds = [];
  const cre = /\b(FEW|SCT|BKN|OVC|VV)(\d{3})/g;
  let c;
  while ((c = cre.exec(body))) {
    const ft = +c[2] * 100;
    o.clouds.push(`${c[1]} ${ft}`);
    if (o.ceilFt === null && (c[1] === 'BKN' || c[1] === 'OVC' || c[1] === 'VV')) o.ceilFt = ft;
  }

  /* temp: the RMK T-group (tenths) when present, else the body pair */
  const tg = raw.match(/\bT([01])(\d{3})([01])(\d{3})\b/);
  if (tg) { o.tC = (tg[1] === '1' ? -1 : 1) * +tg[2] / 10; o.dC = (tg[3] === '1' ? -1 : 1) * +tg[4] / 10; }
  else {
    const t2 = body.match(/\s(M?\d{2})\/(M?\d{2})\b/);
    if (t2) { o.tC = +t2[1].replace('M', '-'); o.dC = +t2[2].replace('M', '-'); }
  }

  o.ts = /(?:^|\s)[+-]?(?:VC)?TS/.test(body);
  o.rain = /(?:^|\s)[+-]?(?:VC)?(?:TS|SH|FZ)?(?:RA|DZ)/.test(body);
  o.snow = /(?:^|\s)[+-]?(?:SH|BL)?(?:SN|PL|IC|GS)/.test(body);
  o.fog = /(?:^|\s)(?:FG|BR|MIFG|BCFG|PRFG)\b/.test(body);
  o.cat = catOf(o.visSM, o.ceilFt);
  return o;
}

const cToF = (c) => Math.round(c * 9 / 5 + 32);

/* Day summary for the calendar + trends. Daytime = 8 am–8 pm local: a single
   5 am fog ob shouldn't paint a flyable day LIFR. */
function summarize(metars) {
  const s = { n: 0, counts: [0, 0, 0, 0], worstDay: null, hiC: null, loC: null,
    maxSpd: 0, maxGst: 0, ts: false, rain: false, snow: false, fog: false };
  for (const [t, raw] of metars || []) {
    const o = parseMetar(raw);
    s.n++;
    s.counts[o.cat]++;
    const h = lp(t).h;
    if (h >= 8 && h < 20) s.worstDay = Math.max(s.worstDay ?? 0, o.cat);
    if (o.tC != null) {
      s.hiC = s.hiC == null ? o.tC : Math.max(s.hiC, o.tC);
      s.loC = s.loC == null ? o.tC : Math.min(s.loC, o.tC);
    }
    if (o.spd) s.maxSpd = Math.max(s.maxSpd, o.spd);
    if (o.gst) s.maxGst = Math.max(s.maxGst, o.gst);
    if (o.ts) s.ts = true;
    if (o.rain) s.rain = true;
    if (o.snow) s.snow = true;
    if (o.fog) s.fog = true;
  }
  if (s.worstDay == null) s.worstDay = s.counts.findLastIndex((v) => v > 0);
  return s.n ? s : null;
}

/* Mirrors discussion.js dayHighF / overnightLowF: the NWS "low" for day D is
   the following night's minimum, so it reads from D+1's pre-09:00 obs. */
function dayHighF(metars) {
  let hi = null;
  for (const [, raw] of metars || []) {
    const c = parseMetar(raw).tC;
    if (c != null) hi = hi == null ? c : Math.max(hi, c);
  }
  return hi == null ? null : cToF(hi);
}
function overnightLowF(nextDayMetars) {
  let lo = null;
  for (const [t, raw] of nextDayMetars || []) {
    if (lp(t).h >= 9) continue;
    const c = parseMetar(raw).tC;
    if (c != null) lo = lo == null ? c : Math.min(lo, c);
  }
  return lo == null ? null : cToF(lo);
}

/* ---------------------------------------------------------------------------
   State
--------------------------------------------------------------------------- */

const S = {
  index: null,
  days: [],                 // every calendar day in range, oldest first
  first: null, last: null,  // range bounds
  have: {},                 // stream -> Set of dates
  afdByDate: new Map(),     // date -> [{t, p}] oldest first
  summaries: new Map(),     // date -> day summary (from obs)
  selected: null,
  cells: new Map(),         // date -> calendar cell element
  charts: new Map(),        // canvas id -> redraw fn (for resize)
};

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}

/* ---------------------------------------------------------------------------
   Boot
--------------------------------------------------------------------------- */

async function boot() {
  S.index = await WXA.index();
  if (!S.index) {
    $('stats').textContent = 'Archive unreachable — data/wx/index.json did not load.';
    return;
  }
  const ix = S.index;

  for (const [stream, key] of [['obs', 'obs_days'], ['forecast', 'forecast_days'],
    ['grid', 'grid_days'], ['taf', 'taf_days'], ['alerts', 'alert_days'], ['model', 'model_days']]) {
    S.have[stream] = new Set(ix[key] || []);
  }
  for (const a of (ix.afd || []).slice().reverse()) {
    const d = lp(a.t).date;
    if (!S.afdByDate.has(d)) S.afdByDate.set(d, []);
    S.afdByDate.get(d).push(a);
  }

  const today = lp(Date.now() / 1000).date;
  const firsts = Object.values(S.have).filter((s) => s.size)
    .map((s) => [...s].sort()[0]);
  if (S.afdByDate.size) firsts.push([...S.afdByDate.keys()].sort()[0]);
  S.first = firsts.sort()[0] || today;
  S.last = today;
  for (let d = S.first; d <= S.last; d = addDays(d, 1)) S.days.push(d);

  renderStats();
  buildCalendar();
  wireDayNav();

  const fromHash = (location.hash.match(/d=(\d{4}-\d{2}-\d{2})/) || [])[1];
  selectDay(fromHash && S.days.includes(fromHash) ? fromHash
    : [...S.have.obs].sort().pop() || S.last);

  loadAllObs();

  window.addEventListener('resize', () => {
    clearTimeout(S._rz);
    S._rz = setTimeout(() => { for (const fn of S.charts.values()) fn(); }, 150);
  });
}

function renderStats() {
  const ix = S.index;
  const age = Math.round((Date.now() / 1000 - ix.updated) / 3600);
  const span = (set) => {
    const d = [...set].sort();
    return d.length ? `<b>${d.length}</b> days since ${d[0].slice(5).replace('-', '/')}` : 'none yet';
  };
  $('stats').innerHTML = [
    `Archive updated <b>${age <= 0 ? 'this hour' : `${age} h ago`}</b>`,
    `METARs (${esc(ix.station)}): ${span(S.have.obs)}`,
    `TAFs: ${span(S.have.taf)}`,
    `Discussions: <b>${(ix.afd || []).length}</b> issuances`,
    `Forecast snaps: ${span(S.have.forecast)}`,
    `Grid: ${span(S.have.grid)}`,
    `Model: ${span(S.have.model)}`,
    `Alerts: ${span(S.have.alerts)}`,
  ].join(' · ');
}

/* ---------------------------------------------------------------------------
   Calendar — GitHub-style strip, one column per week, grouped by month.
--------------------------------------------------------------------------- */

function buildCalendar() {
  const cal = $('cal');
  cal.innerHTML = '';
  let month = null, monthEl = null, weeksEl = null, weekEl = null;

  for (const d of S.days) {
    const m = d.slice(0, 7);
    if (m !== month) {
      month = m;
      monthEl = el('div', 'cal-month');
      monthEl.appendChild(el('div', 'm-label',
        new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US',
          m.endsWith('-01') || !cal.children.length
            ? { month: 'short', year: 'numeric', timeZone: 'UTC' }
            : { month: 'short', timeZone: 'UTC' })));
      weeksEl = el('div', 'cal-weeks');
      monthEl.appendChild(weeksEl);
      cal.appendChild(monthEl);
      weekEl = null;
    }
    if (!weekEl || dow(d) === 0) {
      weekEl = el('div', 'cal-week');
      if (!weeksEl.children.length) {         // pad the month's first week
        for (let i = 0; i < dow(d); i++) weekEl.appendChild(el('div', 'cal-day empty'));
      }
      weeksEl.appendChild(weekEl);
    }
    const cell = el('div', anyData(d) ? 'cal-day' : 'cal-day nodata');
    cell.dataset.date = d;
    cell.title = d;
    if (anyData(d)) cell.addEventListener('click', () => selectDay(d));
    weekEl.appendChild(cell);
    S.cells.set(d, cell);
  }

  $('cal-legend').innerHTML =
    CAT.map((c) => `<span><span class="chip" style="background:${c.color}"></span>${c.name}</span>`).join('') +
    '<span><span class="chip" style="background:#222"></span>no METARs</span>' +
    '<span><span class="chip" style="background:#1d1d1d"></span>nothing archived</span>' +
    '<span>⚡ thunderstorms</span>';

  $('cal-scroll').scrollLeft = $('cal-scroll').scrollWidth;
}

function anyData(d) {
  return Object.values(S.have).some((s) => s.has(d)) || S.afdByDate.has(d);
}

function paintCell(d) {
  const cell = S.cells.get(d), s = S.summaries.get(d);
  if (!cell || !s) return;
  cell.style.background = CAT[s.worstDay].color;
  if (s.ts) cell.appendChild(el('span', 'bolt', '⚡'));
  const parts = CAT.map((c, i) => (s.counts[i] ? `${s.counts[i]} ${c.name}` : null)).filter(Boolean);
  cell.title = `${d} · ${parts.join(' / ')}` +
    (s.hiC != null ? ` · ${cToF(s.hiC)}°/${cToF(s.loC)}°` : '') +
    (s.maxGst ? ` · gust ${s.maxGst} kt` : '') +
    (s.ts ? ' · TS' : s.rain ? ' · rain' : '');
  if (d === S.selected) cell.classList.add('sel');
}

/* Sweep the whole obs stream (a few KB per day) with limited concurrency,
   painting the calendar and finally the trends chart. WXA caches by path, so
   day views opened later reuse these same fetches. */
async function loadAllObs() {
  const dates = [...S.have.obs].sort();
  let done = 0;
  const prog = $('cal-progress');
  const worker = async () => {
    while (dates.length) {
      const d = dates.shift();
      const doc = await WXA.day('obs', d);
      const s = doc && summarize(doc.metars);
      if (s) { S.summaries.set(d, s); paintCell(d); }
      done++;
      if (done % 10 === 0) prog.textContent = `Reading METAR history… ${done} days`;
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  prog.textContent = '';
  renderTrends();
}

/* ---------------------------------------------------------------------------
   Day selection
--------------------------------------------------------------------------- */

function wireDayNav() {
  $('day-prev').addEventListener('click', () => step(-1));
  $('day-next').addEventListener('click', () => step(1));
  $('day-pick').min = S.first;
  $('day-pick').max = S.last;
  $('day-pick').addEventListener('change', (e) => {
    if (e.target.value >= S.first && e.target.value <= S.last) selectDay(e.target.value);
  });
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === 'ArrowLeft') step(-1);
    if (e.key === 'ArrowRight') step(1);
  });
}

function step(n) {
  const d = addDays(S.selected, n);
  if (d >= S.first && d <= S.last) selectDay(d);
}

let daySeq = 0;
async function selectDay(date) {
  const seq = ++daySeq;
  const prev = S.cells.get(S.selected);
  if (prev) prev.classList.remove('sel');
  S.selected = date;
  const cell = S.cells.get(date);
  if (cell) { cell.classList.add('sel'); cell.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
  history.replaceState(null, '', `#d=${date}`);

  $('day-title').textContent = niceDate(date);
  $('day-pick').value = date;
  $('day-prev').disabled = date <= S.first;
  $('day-next').disabled = date >= S.last;

  const chips = [
    ['METARs', S.have.obs.has(date)],
    ['forecast', S.have.forecast.has(date)],
    ['grid', S.have.grid.has(date)],
    ['TAFs', S.have.taf.has(date)],
    ['AFD ×' + (S.afdByDate.get(date) || []).length, S.afdByDate.has(date)],
    ['alerts', S.have.alerts.has(date)],
    ['model', S.have.model.has(date)],
  ];
  $('day-chips').innerHTML = chips
    .map(([label, on]) => `<span class="${on ? '' : 'off'}">${esc(label)}</span>`).join('');

  /* fetch everything the day has in parallel; WXA caches repeats */
  const [obs, nextObs, grid, model, taf, alerts] = await Promise.all([
    S.have.obs.has(date) ? WXA.day('obs', date) : null,
    S.have.obs.has(addDays(date, 1)) ? WXA.day('obs', addDays(date, 1)) : null,
    S.have.grid.has(date) ? WXA.day('grid', date) : null,
    S.have.model.has(date) ? WXA.day('model', date) : null,
    S.have.taf.has(date) ? WXA.day('taf', date) : null,
    S.have.alerts.has(date) ? WXA.day('alerts', date) : null,
  ]);
  const drift = await loadDrift(date);
  if (seq !== daySeq) return;   // user moved on mid-fetch

  renderObs(date, obs);
  renderDrift(date, drift, obs, nextObs);
  renderGrid(date, grid, model);
  renderAlerts(alerts);
  renderTafs(date, taf);
  renderAfds(date);

  $('day-empty').hidden = ['obs-card', 'drift-card', 'grid-card', 'alert-card', 'taf-card', 'afd-card']
    .some((id) => !$(id).hidden);

  const trend = S.charts.get('trend-chart');   // move the selected-day marker
  if (trend) trend();
}

/* ---------------------------------------------------------------------------
   Observations card
--------------------------------------------------------------------------- */

function renderObs(date, doc) {
  const card = $('obs-card');
  if (!doc || !doc.metars || !doc.metars.length) { card.hidden = true; return; }
  card.hidden = false;
  $('obs-sub').textContent = `${doc.station} · ${doc.metars.length} observations`;

  const obs = doc.metars.map(([t, raw]) => ({ t, ...parseMetar(raw) }));
  const s = summarize(doc.metars);

  chart('obs-chart', (ctx, W, H) => drawDayChart(ctx, W, H, date, obs));

  const bits = [];
  if (s.hiC != null) bits.push(`<b>${cToF(s.hiC)}°</b> / <b>${cToF(s.loC)}°</b>F`);
  const worst = obs.reduce((w, o) => Math.max(w, o.cat), 0);
  bits.push(`worst <b class="cat-word" style="color:${CAT[worst].color}">${CAT[worst].name}</b>`);
  if (s.maxSpd) bits.push(`max wind <b>${s.maxSpd}${s.maxGst ? `G${s.maxGst}` : ''} kt</b>`);
  const tsObs = obs.filter((o) => o.ts);
  if (tsObs.length) bits.push(`⚡ thunder ${hhmm(tsObs[0].t)}–${hhmm(tsObs[tsObs.length - 1].t)}`);
  else if (s.rain) bits.push('rain reported');
  if (s.snow) bits.push('winter precip');
  if (s.fog) bits.push('fog/mist');
  $('obs-stats').innerHTML = bits.join(' · ');

  $('ob-list').innerHTML = obs.map((o) =>
    `<div class="ob-row"><span class="t">${hhmm(o.t)}</span>` +
    `<span class="cat" style="background:${CAT[o.cat].color}">${CAT[o.cat].name}</span>` +
    `<code>${esc(o.raw)}</code></div>`).join('');
}

function drawDayChart(ctx, W, H, date, obs) {
  const L = 36, R = 8, ribbonH = 12, windH = 52;
  const T = ribbonH + 8, B = H - 18 - windH;
  const t0 = midnight(date), x = (t) => L + (t - t0) / 86400 * (W - L - R);

  ctx.clearRect(0, 0, W, H);

  /* hour grid + labels */
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'center';
  for (let h = 0; h <= 24; h += 3) {
    const px = x(t0 + h * 3600);
    ctx.strokeStyle = '#242424';
    ctx.beginPath(); ctx.moveTo(px, T); ctx.lineTo(px, H - 14); ctx.stroke();
    ctx.fillStyle = '#666';
    ctx.fillText(h === 24 ? '24' : String(h).padStart(2, '0'), px, H - 3);
  }

  /* flight-category ribbon (each ob paints until the next) */
  for (let i = 0; i < obs.length; i++) {
    const a = Math.max(x(obs[i].t), L);
    const b = i + 1 < obs.length ? x(obs[i + 1].t) : Math.min(x(obs[i].t + 3600), W - R);
    ctx.fillStyle = CAT[obs[i].cat].color;
    ctx.fillRect(a, 0, Math.max(b - a, 1.5), ribbonH);
  }

  /* temp + dewpoint */
  const temps = obs.filter((o) => o.tC != null);
  if (temps.length) {
    const vals = temps.flatMap((o) => [cToF(o.tC), o.dC != null ? cToF(o.dC) : cToF(o.tC)]);
    let lo = Math.min(...vals), hi = Math.max(...vals);
    const pad = Math.max(2, (hi - lo) * 0.12); lo -= pad; hi += pad;
    const y = (f) => B - (f - lo) / (hi - lo) * (B - T);

    ctx.textAlign = 'right';
    for (const f of [Math.ceil(lo / 10) * 10, Math.round((lo + hi) / 20) * 10, Math.floor(hi / 10) * 10]) {
      if (f <= lo || f >= hi) continue;
      ctx.strokeStyle = '#202020';
      ctx.beginPath(); ctx.moveTo(L, y(f)); ctx.lineTo(W - R, y(f)); ctx.stroke();
      ctx.fillStyle = '#666'; ctx.fillText(`${f}°`, L - 4, y(f) + 3);
    }
    const line = (pick, color) => {
      ctx.strokeStyle = color; ctx.lineWidth = 1.6; ctx.beginPath();
      let started = false;
      for (const o of temps) {
        const v = pick(o);
        if (v == null) continue;
        const px = x(o.t), py = y(cToF(v));
        started ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
        started = true;
      }
      ctx.stroke(); ctx.lineWidth = 1;
    };
    line((o) => o.tC, '#f59e0b');
    line((o) => o.dC, '#22c55e');
    ctx.textAlign = 'left';
    ctx.fillStyle = '#f59e0b'; ctx.fillText('temp °F', L + 4, T + 10);
    ctx.fillStyle = '#22c55e'; ctx.fillText('dewpoint', L + 52, T + 10);
  }

  /* wind lane: speed bars, gust ticks, weather glyphs above */
  const wTop = B + 6, wBot = H - 18;
  const maxKt = Math.max(15, ...obs.map((o) => o.gst || o.spd || 0));
  const wy = (kt) => wBot - kt / maxKt * (wBot - wTop);
  ctx.strokeStyle = '#242424';
  ctx.beginPath(); ctx.moveTo(L, wBot); ctx.lineTo(W - R, wBot); ctx.stroke();
  for (const o of obs) {
    if (o.spd == null) continue;
    const px = x(o.t);
    ctx.fillStyle = '#3b6ea5';
    ctx.fillRect(px - 1, wy(o.spd), 2.5, wBot - wy(o.spd));
    if (o.gst) {
      ctx.fillStyle = '#f59e0b';
      ctx.fillRect(px - 2, wy(o.gst), 5, 1.5);
    }
  }
  ctx.fillStyle = '#666'; ctx.textAlign = 'right';
  ctx.fillText(`${maxKt} kt`, L - 4, wTop + 8);
  ctx.textAlign = 'center'; ctx.font = '9px system-ui, sans-serif';
  for (const o of obs) {
    const g = o.ts ? '⚡' : o.snow ? '❄' : o.rain ? '🌧' : o.fog ? '≡' : null;
    if (g) ctx.fillText(g, x(o.t), wTop + 8);
  }
}

/* ---------------------------------------------------------------------------
   Forecast drift + verification card
--------------------------------------------------------------------------- */

/* Every archived expectation for `date`: snaps from up to a week of earlier
   forecast files (NWS reaches ~7 days out), plus the day's own. */
async function loadDrift(date) {
  const files = [];
  for (let back = 6; back >= 0; back--) {
    const d = addDays(date, -back);
    if (S.have.forecast.has(d)) files.push(WXA.day('forecast', d));
  }
  const points = [];
  for (const doc of await Promise.all(files)) {
    for (const snap of (doc && doc.snaps) || []) {
      const day = snap.days && snap.days[date];
      if (day) points.push({ t: snap.t, ...day });
    }
  }
  return points;
}

function renderDrift(date, points, obsDoc, nextObsDoc) {
  const card = $('drift-card');
  if (!points || !points.length) { card.hidden = true; return; }
  card.hidden = false;

  const obsHi = obsDoc ? dayHighF(obsDoc.metars) : null;
  const obsLo = nextObsDoc ? overnightLowF(nextObsDoc.metars) : null;
  const firstDay = lp(points[0].t).date;
  $('drift-sub').textContent = `${points.length} snapshots, first archived ${firstDay === date ? 'that morning' : firstDay}`;

  chart('drift-chart', (ctx, W, H) => drawDriftChart(ctx, W, H, date, points, obsHi, obsLo));

  const first = points[0], last = points[points.length - 1];
  const bits = [];
  bits.push(`first call: <b>${esc(first.short || '—')}</b>` +
    (first.hi != null ? ` (${first.hi}°` + (first.lo != null ? `/${first.lo}°` : '') + (first.pop != null ? `, ${first.pop}% precip` : '') + ')' : ''));
  if (last.short && last.short !== first.short) bits.push(`final: <b>${esc(last.short)}</b>`);
  if (obsHi != null) {
    const missHi = first.hi != null ? obsHi - first.hi : null;
    bits.push(`verified <b>${obsHi}°</b>${obsLo != null ? ` / <b>${obsLo}°</b>` : ''}` +
      (missHi != null && Math.abs(missHi) >= 2 ? ` — high missed by ${missHi > 0 ? '+' : ''}${missHi}°` : missHi != null ? ' — on the money' : ''));
  }
  $('drift-stats').innerHTML = bits.join(' · ');
}

function drawDriftChart(ctx, W, H, date, points, obsHi, obsLo) {
  const L = 36, R = 44, T = 10, B = H - 18;
  const tEnd = midnight(date) + 86400;
  const tStart = Math.min(points[0].t, tEnd - 86400);
  const x = (t) => L + (t - tStart) / (tEnd - tStart) * (W - L - R);

  ctx.clearRect(0, 0, W, H);
  ctx.font = '10px system-ui, sans-serif';

  /* day boundaries */
  ctx.textAlign = 'center';
  for (let d = lp(tStart).date; d <= date; d = addDays(d, 1)) {
    const px = x(midnight(d));
    if (px < L - 1) continue;
    ctx.strokeStyle = '#242424';
    ctx.beginPath(); ctx.moveTo(px, T); ctx.lineTo(px, B); ctx.stroke();
    ctx.fillStyle = d === date ? '#aaa' : '#555';
    ctx.fillText(d.slice(5).replace('-', '/'), Math.max(px + 16, L + 16), H - 4);
  }

  const temps = [...points.map((p) => p.hi), ...points.map((p) => p.lo), obsHi, obsLo]
    .filter((v) => v != null);
  if (!temps.length) return;
  let lo = Math.min(...temps) - 3, hi = Math.max(...temps) + 3;
  const y = (f) => B - (f - lo) / (hi - lo) * (B - T);

  /* PoP bars along the bottom, right axis */
  ctx.fillStyle = 'rgba(74,158,255,0.25)';
  for (const p of points) {
    if (p.pop == null) continue;
    const px = x(p.t);
    ctx.fillRect(px - 1.5, B - p.pop / 100 * (B - T) * 0.5, 3, p.pop / 100 * (B - T) * 0.5);
  }
  ctx.fillStyle = '#4a7ba5'; ctx.textAlign = 'left';
  ctx.fillText('precip %', W - R + 4, B - 4);

  const series = (pick, color) => {
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 1.5;
    ctx.beginPath();
    let started = false;
    for (const p of points) {
      const v = pick(p);
      if (v == null) continue;
      const px = x(p.t), py = y(v);
      started ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
      started = true;
    }
    ctx.stroke(); ctx.lineWidth = 1;
    for (const p of points) {
      const v = pick(p);
      if (v != null) { ctx.beginPath(); ctx.arc(x(p.t), y(v), 2, 0, 7); ctx.fill(); }
    }
  };
  series((p) => p.hi, '#f59e0b');
  series((p) => p.lo, '#4a9eff');

  /* what verified */
  ctx.setLineDash([4, 3]);
  ctx.textAlign = 'left';
  const ref = (v, color, label) => {
    if (v == null) return;
    ctx.strokeStyle = color;
    ctx.beginPath(); ctx.moveTo(L, y(v)); ctx.lineTo(W - R, y(v)); ctx.stroke();
    ctx.fillStyle = color;
    ctx.fillText(`${label} ${v}°`, W - R + 4, y(v) + 3);
  };
  ref(obsHi, '#fbbf24', 'obs');
  ref(obsLo, '#7ab8ff', 'obs');
  ctx.setLineDash([]);

  ctx.fillStyle = '#f59e0b'; ctx.fillText('forecast high', L + 4, T + 9);
  ctx.fillStyle = '#4a9eff'; ctx.fillText('low', L + 82, T + 9);
}

/* ---------------------------------------------------------------------------
   Morning grid + model card
--------------------------------------------------------------------------- */

function renderGrid(date, gridDoc, modelDoc) {
  const card = $('grid-card');
  const gsnap = gridDoc && gridDoc.snaps && gridDoc.snaps[0];
  const msnap = modelDoc && modelDoc.snaps && modelDoc.snaps[0];
  if (!gsnap && !msnap) { card.hidden = true; return; }
  card.hidden = false;

  const seen = gsnap ? (gsnap.t || gsnap.t0) : msnap.t;
  $('grid-sub').textContent = `as archived at ${hhmm(seen)} local`;

  /* hours of the snapshot that fall on the selected local day */
  const hours = (snap) => {
    const out = [];
    if (!snap) return out;
    for (let i = 0; i < snap.n; i++) {
      const ts = snap.t0 + i * 3600;
      const p = lp(ts);
      if (p.date === date) out.push({ i, ts, h: p.h });
    }
    return out;
  };
  const gh = hours(gsnap), mh = hours(msnap);

  chart('grid-chart', (ctx, W, H) => drawGridChart(ctx, W, H, date, gsnap, gh, msnap, mh));

  /* hour-by-hour table from the grid */
  if (gsnap && gh.length) {
    const fmtWind = (i) => {
      const d = gsnap.dir[i], s = gsnap.spd[i], g = gsnap.gst[i];
      if (s == null) return '—';
      return `${d != null ? String(d).padStart(3, '0') + '°' : ''} ${s}${g ? `G${g}` : ''} kt`;
    };
    $('grid-table').innerHTML = '<table class="grid-tab"><tr><th>local</th><th>temp</th><th>wind</th>' +
      '<th>ceiling</th><th>vis</th><th>precip %</th><th>weather</th></tr>' +
      gh.map(({ i, h }) => {
        const t = gsnap.temp[i], wx = gsnap.wx[i];
        return `<tr><td>${String(h).padStart(2, '0')}:00</td>` +
          `<td>${t != null ? cToF(t) + '°' : '—'}</td>` +
          `<td>${fmtWind(i)}</td>` +
          `<td>${gsnap.ceil[i] != null ? gsnap.ceil[i].toLocaleString() + ' ft' : 'none'}</td>` +
          `<td>${gsnap.vis[i] != null ? gsnap.vis[i] + ' SM' : '—'}</td>` +
          `<td>${gsnap.pop[i] != null ? gsnap.pop[i] : '—'}</td>` +
          `<td class="wx">${wx ? esc(wx.replace(/_/g, ' ').replace(/,/g, ', ')) : ''}</td></tr>`;
      }).join('') + '</table>';
  } else {
    $('grid-table').innerHTML = '<p class="note">No grid snapshot archived this day.</p>';
  }
}

function drawGridChart(ctx, W, H, date, gsnap, gh, msnap, mh) {
  const L = 44, R = 44, T = 10, B = H - 18;
  const t0 = midnight(date), x = (t) => L + (t - t0) / 86400 * (W - L - R);

  ctx.clearRect(0, 0, W, H);
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'center';
  for (let h = 0; h <= 24; h += 3) {
    const px = x(t0 + h * 3600);
    ctx.strokeStyle = '#242424';
    ctx.beginPath(); ctx.moveTo(px, T); ctx.lineTo(px, B); ctx.stroke();
    ctx.fillStyle = '#666';
    ctx.fillText(String(h).padStart(2, '0'), px, H - 4);
  }

  /* CAPE area, left axis */
  if (msnap && mh.length) {
    const maxCape = Math.max(500, ...mh.map(({ i }) => msnap.cape[i] || 0));
    const yc = (v) => B - v / maxCape * (B - T);
    ctx.beginPath();
    ctx.moveTo(x(mh[0].ts), B);
    for (const { i, ts } of mh) ctx.lineTo(x(ts), yc(msnap.cape[i] || 0));
    ctx.lineTo(x(mh[mh.length - 1].ts), B);
    ctx.closePath();
    ctx.fillStyle = 'rgba(245,158,11,0.18)';
    ctx.fill();
    ctx.strokeStyle = '#f59e0b';
    ctx.beginPath();
    for (let k = 0; k < mh.length; k++) {
      const { i, ts } = mh[k];
      const px = x(ts), py = yc(msnap.cape[i] || 0);
      k ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    }
    ctx.stroke();
    ctx.fillStyle = '#666'; ctx.textAlign = 'right';
    ctx.fillText(`${maxCape}`, L - 4, T + 8);
    ctx.fillText('CAPE', L - 4, T + 18);

    /* precip rate bars */
    const maxPr = Math.max(...mh.map(({ i }) => msnap.pr[i] || 0));
    if (maxPr > 0) {
      const yp = (v) => B - v / maxPr * (B - T) * 0.6;
      ctx.fillStyle = 'rgba(34,197,94,0.5)';
      for (const { i, ts } of mh) {
        if (msnap.pr[i]) ctx.fillRect(x(ts) - 2, yp(msnap.pr[i]), 4, B - yp(msnap.pr[i]));
      }
      ctx.fillStyle = '#4a9e6e'; ctx.textAlign = 'left';
      ctx.fillText(`precip ≤${maxPr} mm/h`, L + 4, B - 6);
    }
  }

  /* PoP line, right axis */
  if (gsnap && gh.length) {
    const yp = (v) => B - v / 100 * (B - T);
    ctx.strokeStyle = '#4a9eff'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    let started = false;
    for (const { i, ts } of gh) {
      if (gsnap.pop[i] == null) continue;
      const px = x(ts), py = yp(gsnap.pop[i]);
      started ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
      started = true;
    }
    ctx.stroke(); ctx.lineWidth = 1;
    ctx.fillStyle = '#4a9eff'; ctx.textAlign = 'left';
    ctx.fillText('precip %', W - R + 4, yp(100) + 8);
    ctx.fillText('0', W - R + 4, B);

    /* thunder marks from the grid's own weather strings */
    ctx.textAlign = 'center'; ctx.fillStyle = '#fbbf24';
    for (const { i, ts } of gh) {
      if (gsnap.wx[i] && gsnap.wx[i].includes('thunder')) ctx.fillText('⚡', x(ts), T + 10);
    }
  }
}

/* ---------------------------------------------------------------------------
   Alerts, TAFs, AFDs
--------------------------------------------------------------------------- */

const SEV_COLOR = { Extreme: '#ef4444', Severe: '#f59e0b', Moderate: '#eab308', Minor: '#4a9eff' };

function renderAlerts(doc) {
  const card = $('alert-card');
  const alerts = doc && doc.alerts;
  if (!alerts || !alerts.length) { card.hidden = true; return; }
  card.hidden = false;
  $('alert-list').innerHTML = alerts.map((a) => {
    const when = a.onset ? new Date(a.onset).toLocaleTimeString('en-US',
      { hour: 'numeric', minute: '2-digit', timeZone: TZ }) : '';
    const until = a.ends ? new Date(a.ends).toLocaleTimeString('en-US',
      { hour: 'numeric', minute: '2-digit', timeZone: TZ }) : '';
    return `<div class="alert-row" style="--sev:${SEV_COLOR[a.severity] || '#888'}">` +
      `<span class="ev">${esc(a.event)}</span>` +
      `<span class="when">${when}${until ? ` → ${until}` : ''}</span>` +
      `<div class="hl">${esc(a.headline || '')}</div>` +
      (a.desc ? `<details class="fold"><summary>Full text</summary><pre class="product">${esc(a.desc)}</pre></details>` : '') +
      '</div>';
  }).join('');
}

/* IWXXM changeIndicator -> the TAF word a pilot reads */
function tafInd(ind) {
  if (!ind || ind === 'FM' || /FROM/.test(ind)) return 'FM';
  if (/PROBABILITY_30.*TEMPO/.test(ind)) return 'PROB30 TEMPO';
  if (/PROBABILITY_40.*TEMPO/.test(ind)) return 'PROB40 TEMPO';
  if (/PROBABILITY_30/.test(ind)) return 'PROB30';
  if (/PROBABILITY_40/.test(ind)) return 'PROB40';
  if (/TEMPO/.test(ind)) return 'TEMPO';
  if (/BECOM/.test(ind)) return 'BECMG';
  return ind;
}

/* NWS encodes TAF visibility in meters via a fixed SM table — decode it back
   through the table (mirrors weather.js), never by dividing by 1609. */
const VIS_TABLE = [[400, '1/4'], [800, '1/2'], [1200, '3/4'], [1600, '1'], [2400, '1 1/2'],
  [3200, '2'], [4800, '3'], [6000, '4'], [8000, '5'], [9000, '6'], [9999, '6']];
function tafVis(visM) {
  if (visM == null) return null;
  if (visM >= 16000) return 'P6SM';
  for (const [m, sm] of VIS_TABLE) if (Math.abs(visM - m) <= 100) return `${sm}SM`;
  return `${Math.round(visM / 1609.34 * 2) / 2}SM`;
}

function tafPeriodLine(p) {
  const bits = [];
  if (p.kt === 0 && !p.gust) bits.push('calm');
  else if (p.dir != null || p.kt != null) {
    bits.push(`${p.dir != null ? String(p.dir).padStart(3, '0') + '°' : 'VRB'} ` +
      `${p.kt != null ? p.kt : '?'}${p.gust ? `G${p.gust}` : ''} kt`);
  }
  const v = tafVis(p.visM);
  if (v) bits.push(v);
  if (p.wx && p.wx.length) bits.push(p.wx.join(' '));
  if (p.cld && p.cld.length) {
    bits.push(p.cld.map((c) => `${c.amt || '?'}${c.ft != null ? ' ' + c.ft.toLocaleString() : ''}`).join(', '));
  }
  return bits.join(' · ') || '—';
}

function renderTafs(date, doc) {
  const card = $('taf-card');
  const tafs = doc && doc.tafs;
  if (!tafs || !tafs.length) { card.hidden = true; return; }
  card.hidden = false;

  const order = (SITE.weather.tafStations || []).map((s) => s.id);
  const sorted = tafs.slice().sort((a, b) =>
    (order.indexOf(a.station) - order.indexOf(b.station)) || (a.t - b.t));

  $('taf-list').innerHTML = sorted.map((taf) => {
    let body;
    if (taf.periods) {
      body = taf.periods.map((p) =>
        `<div class="taf-line"><span class="ind">${esc(tafInd(p.ind))}</span>` +
        `<span class="when">${hhmm(p.b)}–${hhmm(p.e)}</span>` +
        `<span class="what">${esc(tafPeriodLine(p))}</span></div>`).join('');
    } else {
      body = `<pre class="product">${esc((taf.raw || '').trim())}</pre>`;
    }
    return `<details class="iss"><summary><span class="who">${esc(taf.station)}</span>` +
      `issued ${hhmm(taf.t)}` +
      `<span class="meta">${taf.periods ? `${taf.periods.length} periods` : 'raw text (backfilled)'}</span>` +
      `</summary><div class="body">${body}</div></details>`;
  }).join('');
}

function renderAfds(date) {
  const card = $('afd-card');
  const list = S.afdByDate.get(date);
  if (!list || !list.length) { card.hidden = true; return; }
  card.hidden = false;

  const wrap = $('afd-list');
  wrap.innerHTML = '';
  for (const a of list) {
    const d = el('details', 'iss',
      `<summary><span class="who">AFD</span>issued ${hhmm(a.t)}<span class="meta">${esc(S.index.office)}</span></summary>` +
      '<div class="body">Loading…</div>');
    d.addEventListener('toggle', async () => {
      if (!d.open || d.dataset.loaded) return;
      d.dataset.loaded = '1';
      const doc = await WXA.json(a.p);
      d.querySelector('.body').innerHTML = doc
        ? `<pre class="product">${esc((doc.productText || '').trim())}</pre>`
        : '<p class="note">Could not load this issuance.</p>';
    });
    wrap.appendChild(d);
  }
}

/* ---------------------------------------------------------------------------
   Trends — the whole archive on one canvas.
--------------------------------------------------------------------------- */

function renderTrends() {
  const dates = [...S.summaries.keys()].sort();
  if (dates.length < 7) return;
  $('trend-card').hidden = false;
  $('trend-sub').textContent = `${dates.length} days of ${S.index.station} observations, ${dates[0]} → ${dates[dates.length - 1]}`;
  chart('trend-chart', (ctx, W, H) => drawTrendChart(ctx, W, H, dates));
}

/* high-temp color ramp: cool blue -> mild green -> hot red */
function tempColor(f) {
  const stops = [[40, [90, 140, 255]], [60, [60, 190, 150]], [80, [235, 180, 60]], [95, [239, 68, 68]], [105, [190, 30, 120]]];
  let a = stops[0], b = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (f >= stops[i][0] && f <= stops[i + 1][0]) { a = stops[i]; b = stops[i + 1]; break; }
  }
  const f01 = Math.max(0, Math.min(1, (f - a[0]) / (b[0] - a[0] || 1)));
  const c = a[1].map((v, i) => Math.round(v + (b[1][i] - v) * f01));
  return `rgb(${c.join(',')})`;
}

function drawTrendChart(ctx, W, H, dates) {
  const L = 34, R = 6, T = 12;
  const stripH = 10, markH = 14;
  const B = H - 18 - stripH - markH;
  const n = dates.length;
  const bw = (W - L - R) / n;
  const x = (i) => L + i * bw;

  ctx.clearRect(0, 0, W, H);
  ctx.font = '10px system-ui, sans-serif';

  const all = dates.flatMap((d) => {
    const s = S.summaries.get(d);
    return s.hiC != null ? [cToF(s.hiC), cToF(s.loC)] : [];
  });
  if (!all.length) return;
  let lo = Math.min(...all) - 4, hi = Math.max(...all) + 4;
  const y = (f) => B - (f - lo) / (hi - lo) * (B - T);

  ctx.textAlign = 'right';
  for (let f = Math.ceil(lo / 10) * 10; f < hi; f += 10) {
    ctx.strokeStyle = '#202020';
    ctx.beginPath(); ctx.moveTo(L, y(f)); ctx.lineTo(W - R, y(f)); ctx.stroke();
    ctx.fillStyle = '#666'; ctx.fillText(`${f}°`, L - 4, y(f) + 3);
  }

  /* month boundaries + labels */
  ctx.textAlign = 'left';
  for (let i = 0; i < n; i++) {
    if (i === 0 || dates[i].slice(8, 10) === '01') {
      ctx.strokeStyle = '#2a2a2a';
      ctx.beginPath(); ctx.moveTo(x(i), T); ctx.lineTo(x(i), H - 16); ctx.stroke();
      ctx.fillStyle = '#777';
      ctx.fillText(new Date(`${dates[i]}T12:00:00Z`).toLocaleDateString('en-US',
        { month: 'short', timeZone: 'UTC' }), x(i) + 3, H - 5);
    }
  }

  for (let i = 0; i < n; i++) {
    const s = S.summaries.get(dates[i]);
    const px = x(i) + bw * 0.15, w = Math.max(bw * 0.7, 1);
    if (s.hiC != null) {
      const hF = cToF(s.hiC), lF = cToF(s.loC);
      ctx.fillStyle = tempColor(hF);
      const top = y(hF), bot = y(lF);
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(px, top, w, Math.max(bot - top, 2), w / 2);
      else ctx.rect(px, top, w, Math.max(bot - top, 2));
      ctx.fill();
    }
    /* category strip */
    ctx.fillStyle = CAT[s.worstDay].color;
    ctx.fillRect(x(i), B + 6, Math.max(bw - 1, 1), stripH);
    /* precip marks */
    if (s.ts) {
      ctx.fillStyle = '#fbbf24'; ctx.textAlign = 'center';
      ctx.font = `${Math.min(10, Math.max(7, bw))}px system-ui, sans-serif`;
      ctx.fillText('⚡', x(i) + bw / 2, B + 6 + stripH + 10);
      ctx.font = '10px system-ui, sans-serif';
    } else if (s.rain || s.snow) {
      ctx.fillStyle = s.snow ? '#dbeafe' : '#4a9eff';
      ctx.beginPath(); ctx.arc(x(i) + bw / 2, B + 6 + stripH + 6, 1.6, 0, 7); ctx.fill();
    }
  }

  /* selected-day marker */
  const si = dates.indexOf(S.selected);
  if (si >= 0) {
    ctx.strokeStyle = '#fff';
    ctx.strokeRect(x(si), T, Math.max(bw, 2), B + 6 + stripH - T);
  }
}

/* ---------------------------------------------------------------------------
   Canvas plumbing — HiDPI-scaled, redraws on resize via S.charts.
--------------------------------------------------------------------------- */

function chart(id, draw) {
  const cv = $(id);
  const render = () => {
    const cssW = cv.clientWidth || cv.parentElement.clientWidth;
    const cssH = +cv.getAttribute('height');
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(cssW * dpr);
    cv.height = Math.round(cssH * dpr);
    cv.style.height = `${cssH}px`;
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw(ctx, cssW, cssH);
  };
  S.charts.set(id, render);
  render();
}

boot();
