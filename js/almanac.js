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

  /* pressure: the altimeter setting a pilot sets (inHg), and the RMK sea-level
     pressure in tenths of a mb around 1000 — SLP149 = 1014.9, SLP985 = 998.5.
     SLP is the meteorologist's number and only appears on the hourly ob. */
  const alt = body.match(/\bA(\d{4})\b/);
  if (alt) o.altim = +alt[1] / 100;
  const slp = raw.match(/\bSLP(\d{3})\b/);
  if (slp) o.slpMb = (+slp[1] >= 500 ? 900 : 1000) + +slp[1] / 10;
  /* P-group: precipitation since the last hourly ob, hundredths of an inch */
  const pg = raw.match(/\bP(\d{4})\b/);
  if (pg) o.precIn = +pg[1] / 100;

  o.ts = /(?:^|\s)[+-]?(?:VC)?TS/.test(body);
  o.rain = /(?:^|\s)[+-]?(?:VC)?(?:TS|SH|FZ)?(?:RA|DZ)/.test(body);
  o.snow = /(?:^|\s)[+-]?(?:SH|BL)?(?:SN|PL|IC|GS)/.test(body);
  o.fog = /(?:^|\s)(?:FG|BR|MIFG|BCFG|PRFG)\b/.test(body);
  o.cat = catOf(o.visSM, o.ceilFt);
  return o;
}

const cToF = (c) => Math.round(c * 9 / 5 + 32);

/* Which hours of a local day hold no observation at all.

   Every number this page prints about a day — the calendar's worst category,
   the high and low, the peak gust — is an extreme over the obs that were
   archived, which is only the same thing as an extreme over the day when the
   day is complete. It often isn't: api.weather.gov drops routine obs, and
   before the archiver healed itself from IEM a fifth of a typical day could
   be absent. So the page states its coverage rather than quietly ranging over
   holes. Hours the station never reported ("nh" in the day file — a part-time
   AWOS overnight) are not gaps and are not counted. */
function hourGaps(doc) {
  const date = doc && doc.date;
  if (!date || !doc.metars) return null;
  const seen = new Set();
  for (const [t] of doc.metars) {
    const p = lp(t);
    if (p.date === date) seen.add(p.h);
  }
  const never = new Set(doc.nh || []);
  /* Today is still being written: an hour that hasn't happened, or that the
     archiver hasn't run for yet, is not missing. Only the hours before the
     last archive run are expected on file, so the span is capped there. */
  let span = 24;
  if (date === lp(nowSec()).date) {
    const u = S.index && S.index.updated ? lp(S.index.updated) : null;
    /* an archive that last ran yesterday has written none of today's hours */
    const updH = !u ? lp(nowSec()).h : u.date === date ? u.h : u.date < date ? 0 : 24;
    span = Math.min(lp(nowSec()).h, updH);
  }
  const missing = [];
  for (let h = 0; h < span; h++) if (!seen.has(h) && !never.has(h)) missing.push(h);
  return { held: seen.size, never: never.size, missing, span };
}

/* "6 h missing" / "" — the phrase every card uses, so the wording never
   drifts between them. */
function gapNote(gaps) {
  if (!gaps || !gaps.missing.length) return '';
  const n = gaps.missing.length;
  return `${n} h missing`;
}

const gapHours = (gaps) => (gaps && gaps.missing.length)
  ? `hours with no ob: ${gaps.missing.map((h) => String(h).padStart(2, '0')).join(', ')}`
  : '';

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
  day: null,                // decoded day model behind the meteogram
  lanes: null,              // Set of lane keys the reader has on
  src: null,                // {obs, grid, model} source toggles
  hover: null,              // crosshair time, epoch seconds
  meteo: null,              // last meteogram layout (for hit-testing)
  alerts: null,             // the selected day's alert doc (re-rendered on resize)
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

  for (const [stream, key] of [['obs', 'obs_days'], ['fieldobs', 'fieldobs_days'],
    ['forecast', 'forecast_days'], ['grid', 'grid_days'], ['taf', 'taf_days'],
    ['alerts', 'alert_days'], ['model', 'model_days'], ['pirep', 'pirep_days'],
    ['airsig', 'airsig_days'], ['tfr', 'tfr_days'], ['raob', 'raob_days'],
    ['aloft', 'aloft_days']]) {
    S.have[stream] = new Set(ix[key] || []);
  }
  /* the local METAR ring: which nearby fields the archive actually holds,
     and which days each has (stations/<ID>/ — the station explorer's fuel) */
  S.ringIds = ix.stations || [];
  S.ringDays = {};
  for (const id of S.ringIds) S.ringDays[id] = new Set((ix.station_days || {})[id] || []);
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
  loadPrefs();
  buildPicker();

  const fromHash = (location.hash.match(/d=(\d{4}-\d{2}-\d{2})/) || [])[1];
  selectDay(fromHash && S.days.includes(fromHash) ? fromHash
    : [...S.have.obs].sort().pop() || S.last);

  loadAllObs();

  window.addEventListener('resize', () => {
    clearTimeout(S._rz);
    S._rz = setTimeout(() => {
      for (const fn of S.charts.values()) fn();
      /* the alert timeline is DOM, so it reflows itself — but how many hour
         labels fit is a width decision, so it has to be re-run */
      if (S.alerts) renderAlerts(S.selected, S.alerts);
    }, 150);
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
    ...(ix.field_station ? [`Field (${esc(ix.field_station)}): ${span(S.have.fieldobs)}`] : []),
    ...(S.ringIds.length ? [`Ring: <b>${S.ringIds.length}</b> stations`] : []),
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

  /* swatches are .sw, not .chip — the meteogram picker's .chip button rule
     (padding, border, pointer) would pad these into 24×16 pills */
  $('cal-legend').innerHTML =
    CAT.map((c) => `<span><span class="sw" style="background:${c.color}"></span>${c.name}</span>`).join('') +
    '<span><span class="sw" style="background:#222"></span>no METARs</span>' +
    '<span><span class="sw" style="background:#1d1d1d"></span>nothing archived</span>' +
    '<span><span class="sw cal-day short" style="background:#3d7dc4;position:relative">' +
    '</span>hours missing</span>' +
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
  /* A day's color is its worst *daytime* category — a claim about the whole
     day, made from whatever hours were archived. When hours are missing the
     cell is hatched and says so: the color may simply not have seen the worst
     hour. */
  const note = gapNote(s.gaps);
  cell.classList.toggle('short', !!note);
  cell.title = `${d} · ${parts.join(' / ')}` +
    (s.hiC != null ? ` · ${cToF(s.hiC)}°/${cToF(s.loC)}°` : '') +
    (s.maxGst ? ` · gust ${s.maxGst} kt` : '') +
    (s.ts ? ' · TS' : s.rain ? ' · rain' : '') +
    (note ? `\n${s.gaps.held} of 24 h on file — may not include the day's worst hour` : '');
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
      if (s) {
        s.gaps = hourGaps(doc);   // today is still filling, so it never counts
        if (d === lp(Date.now() / 1000).date) s.gaps = null;
        S.summaries.set(d, s);
        paintCell(d);
      }
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

  const ringToday = S.ringIds.filter((id) => S.ringDays[id].has(date));
  const chips = [
    ['METARs', S.have.obs.has(date)],
    [`${S.index.field_station || 'field'} obs`, S.have.fieldobs.has(date)],
    [`nearby ×${ringToday.length}`, ringToday.length > 0],
    ['forecast', S.have.forecast.has(date)],
    ['grid', S.have.grid.has(date)],
    ['TAFs', S.have.taf.has(date)],
    ['AFD ×' + (S.afdByDate.get(date) || []).length, S.afdByDate.has(date)],
    ['alerts', S.have.alerts.has(date)],
    ['model', S.have.model.has(date)],
    ['PIREPs', S.have.pirep.has(date)],
    ['AIRMETs', S.have.airsig.has(date)],
    ['TFRs', S.have.tfr.has(date)],
    ['sounding', S.have.raob.has(date)],
    ['aloft', S.have.aloft.has(date)],
  ];
  $('day-chips').innerHTML = chips
    .map(([label, on]) => `<span class="${on ? '' : 'off'}">${esc(label)}</span>`).join('');

  /* fetch everything the day has in parallel; WXA caches repeats. A stream
     that never held the day is null, never a request. */
  const get = (stream, d = date) => (S.have[stream].has(d) ? WXA.day(stream, d) : null);
  const [obs, fobs, ringPairs, nextObs, grid, model, taf, alerts, pirep, airsig, tfr, raob, aloft] =
    await Promise.all([
      get('obs'), get('fieldobs'),
      Promise.all(ringToday.map(async (id) => [id, await WXA.station(id, date)])),
      get('obs', addDays(date, 1)), get('grid'), get('model'), get('taf'), get('alerts'),
      get('pirep'), get('airsig'), get('tfr'), get('raob'), get('aloft'),
    ]);
  const drift = await loadDrift(date);
  if (seq !== daySeq) return;   // user moved on mid-fetch

  const ringDocs = new Map(ringPairs);
  S.extra = { ringDocs, aloft, raob };
  renderObs(date, obs, fobs, grid, model);
  renderDrift(date, drift, obs, nextObs);
  renderGrid(date, grid, model);
  renderModelVsObs(date, model, obs);
  renderAlerts(date, alerts);
  renderTafVerify(date, taf, obs, ringDocs);
  renderRadar(date, ringDocs, obs, fobs);
  renderPireps(date, pirep);
  renderAirsig(date, airsig, tfr);
  renderRaob(date, raob, model);
  renderAfds(date);
  renderStations(date, ringDocs, obs, fobs, taf);

  $('day-empty').hidden = ['obs-card', 'drift-card', 'grid-card', 'alert-card', 'tafv-card',
    'radar-card', 'pirep-card', 'airsig-card', 'raob-card', 'afd-card', 'stn-card']
    .some((id) => !$(id).hidden);

  const trend = S.charts.get('trend-chart');   // move the selected-day marker
  if (trend) trend();
}

/* ---------------------------------------------------------------------------
   Observations card — the day meteogram
   ---------------------------------------------------------------------------
   One lane per selected measure, stacked, all sharing the day's time axis and
   one crosshair. Deliberately NOT an overlay with several y-scales: two
   measures on two scales invent a correlation out of wherever the scales
   happen to line up. Each lane keeps a single scale that re-steps itself to
   the day's own range, so every reading is honest.

   Three sources can fill a lane: the day's METARs (solid), the first NWS grid
   snapshot archived that morning — what was expected before the day happened
   (dashed) — and the GFS point archived at the field (CAPE/CIN, precip rate).

   Palette: one hue per measure, from the site's categorical slots, checked for
   colorblind separation and ≥3:1 contrast on the card surface. Two hues repeat
   across lanes on purpose — density altitude reuses temperature's orange (it
   is the temperature story in feet) and precipitation reuses dewpoint's aqua —
   which is fine because those lanes are separate plots, each directly labelled,
   and the pairs never share one.
--------------------------------------------------------------------------- */

const C = {
  temp: '#d95926', dew: '#199e70', wind: '#3987e5', pres: '#9085e9',
  rh: '#008300', vis: '#c98500', ceil: '#d55181', cape: '#e66767',
  da: '#d95926', precip: '#199e70',
  ink: '#d6d6d0', muted: '#8d8d86', dim: '#6a6a65',
  grid: '#242424', hour: 'rgba(255,255,255,0.05)', lane: 'rgba(255,255,255,0.022)',
  night: 'rgba(9,14,34,0.62)', nightClear: 'rgba(9,14,34,0)',
};

const rgbOf = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const rgba = (hex, a) => `rgba(${rgbOf(hex).join(',')},${a})`;
/* a lighter step of the same hue — forecast lines, gust caps, model fills */
const lighten = (hex, t = 0.42) => '#' + rgbOf(hex)
  .map((v) => Math.round(v + (255 - v) * t).toString(16).padStart(2, '0')).join('');

/* The scale is fitted to the day, then labelled — bounds hug the data (plus a
   little air) and the 1 / 2 / 2.5 / 5 × 10^k ticks fall wherever they land
   inside. Snapping the *bounds* to tick multiples instead is what leaves a
   68–93° day drawn on a 60–100° axis, flat and unreadable. */
function autoScale(lo, hi, want, maxTicks, { zero = false, minSpan = 0, pad = 0.1, ladder = [1, 2, 5, 2.5] } = {}) {
  if (!(hi > lo)) hi = lo;
  if (hi - lo < minSpan) {
    if (zero) hi = Math.max(hi, minSpan);
    else { const c = (lo + hi) / 2; lo = c - minSpan / 2; hi = c + minSpan / 2; }
  }
  const air = Math.max((hi - lo) * pad, 1e-9);
  hi += air;
  lo = zero ? 0 : lo - air;

  /* Search the 1/2/5/2.5 ladder for the step whose tick count lands nearest
     the target, rather than deriving one from a division — the padding above
     routinely pushes that division a hair over a rung (raw 10.007 → step 20),
     which is how an axis ends up with a single label. */
  const mag = Math.pow(10, Math.floor(Math.log10((hi - lo) / Math.max(2, want))));
  let step = mag, best = Infinity;
  for (const m of [mag / 10, mag, mag * 10]) {
    for (const f of ladder) {
      const s = m * f;
      const k = Math.floor(hi / s + 1e-9) - Math.ceil(lo / s - 1e-9) + 1;
      if (k < 2) continue;
      const score = Math.abs(k - want) + (k > maxTicks ? 100 : 0);
      if (score < best) { best = score; step = s; }
    }
  }
  const ticks = [];
  for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + 1e-9; v += step) ticks.push(+v.toFixed(10));
  return { lo, hi, ticks };
}

/* Keep tick labels from stacking up in a short lane. */
function thin(ticks, h) {
  const max = Math.max(2, Math.floor(h / 20));
  let t = ticks;
  while (t.length > max) t = t.filter((_, i) => i % 2 === 0);
  return t;
}

/* Monotone cubic — smooth without inventing peaks between two hourly obs the
   way a plain Catmull-Rom does. */
function smoothPath(ctx, p) {
  const n = p.length;
  if (n < 3) { p.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); return; }
  const dx = [], sl = [], m = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = p[i + 1][0] - p[i][0] || 1e-6;
    sl[i] = (p[i + 1][1] - p[i][1]) / dx[i];
  }
  m[0] = sl[0]; m[n - 1] = sl[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = sl[i - 1] * sl[i] <= 0 ? 0 : (sl[i - 1] + sl[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (!sl[i]) { m[i] = m[i + 1] = 0; continue; }
    const a = m[i] / sl[i], b = m[i + 1] / sl[i], s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * sl[i]; m[i + 1] = t * b * sl[i]; }
  }
  ctx.moveTo(p[0][0], p[0][1]);
  for (let i = 0; i < n - 1; i++) {
    ctx.bezierCurveTo(p[i][0] + dx[i] / 3, p[i][1] + m[i] * dx[i] / 3,
      p[i + 1][0] - dx[i] / 3, p[i + 1][1] - m[i + 1] * dx[i] / 3, p[i + 1][0], p[i + 1][1]);
  }
}

/* ---- derived values -------------------------------------------------------

   Field elevation of the observing station, needed for pressure/density
   altitude. KDCA is the archive's station; SITE covers the local fields. An
   unknown station leaves density altitude out rather than guessing. */
const STATION_ELEV_FT = { KDCA: 15 };
function stationElev(id) {
  if (STATION_ELEV_FT[id] != null) return STATION_ELEV_FT[id];
  if (id === SITE.airport.id || id === SITE.airport.metarStation) return SITE.airport.elevFt;
  const a = (SITE.weather.nearbyAirports || []).find((x) => x.id === id || x.metarStation === id);
  return a ? a.elevFt : null;
}

const satVapHpa = (tC) => 6.1078 * Math.pow(10, 7.5 * tC / (tC + 237.3));   // Tetens
const relHum = (tC, dC) => Math.max(1, Math.min(100, 100 * satVapHpa(dC) / satVapHpa(tC)));

/* Density altitude, NWS method with humidity — same formulas as airlab.js. */
function densityAltFt(tC, dC, altimInHg, elevFt) {
  const k = 0.190284;
  const pHpa = Math.pow(Math.pow(altimInHg, k) - 1.313e-5 * elevFt, 1 / k) * 33.8639;
  const e = dC == null ? 0 : satVapHpa(dC);
  const T = tC + 273.15;
  const rho = (100 * (pHpa - e)) / (287.05 * T) + (100 * e) / (461.495 * T);
  return 145442.16 * (1 - Math.pow(rho / 1.225, 0.234969));
}

/* Sunrise/sunset for an archived day (NOAA equation), for the night shading.
   Anchored on the field's own calendar day like weather.js solarTimes() —
   browser-local Y/M/D slips the base a day for viewers west of here. */
function solarTimes(date, lat, lon) {
  const [y, mo, d] = date.split('-').map(Number);
  const base = Date.UTC(y, mo - 1, d) / 1000;
  const doy = Math.floor((Date.UTC(y, mo - 1, d) - Date.UTC(y, 0, 0)) / 86400000);
  const rad = (deg) => deg * Math.PI / 180;
  const g = (2 * Math.PI / 365) * (doy - 1 + 0.5);
  const eqtime = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g)
    - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g)
    - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g)
    - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const at = (zen, rising) => {
    const cosH = (Math.cos(rad(zen)) / (Math.cos(rad(lat)) * Math.cos(decl)))
      - Math.tan(rad(lat)) * Math.tan(decl);
    if (cosH > 1 || cosH < -1) return null;
    const ha = (Math.acos(cosH) * 180 / Math.PI) * (rising ? 1 : -1);
    return base + (720 - 4 * (lon + ha) - eqtime) * 60;
  };
  return { dawn: at(96, true), sunrise: at(90.833, true), sunset: at(90.833, false), dusk: at(96, false) };
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const dirName = (deg) => COMPASS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
const ftShort = (v) => (Math.abs(v) >= 10000 ? `${Math.round(v / 1000)}k`
  : Math.round(v).toLocaleString('en-US'));

/* ---- the day, decoded into plottable series ---------------------------- */

const pick = (arr, key) => arr.filter((p) => p[key] != null).map((p) => [p.t, p[key]]);
const hasData = (s) => s.pts.some((p) => p[1] != null);

function buildDay(date, obsDoc, fieldDoc, gridDoc, modelDoc) {
  const t0 = midnight(date), t1 = t0 + 86400;
  const station = (obsDoc && obsDoc.station) || S.index.station;
  const fieldStation = (fieldDoc && fieldDoc.station) || S.index.field_station;

  const decode = (doc, elev) => ((doc && doc.metars) || []).map(([t, raw]) => {
    const o = { t, ...parseMetar(raw) };
    o.tF = o.tC != null ? o.tC * 9 / 5 + 32 : null;
    o.dF = o.dC != null ? o.dC * 9 / 5 + 32 : null;
    o.rhPct = (o.tC != null && o.dC != null) ? relHum(o.tC, o.dC) : null;
    o.daFt = (o.tC != null && o.altim != null && elev != null)
      ? densityAltFt(o.tC, o.dC, o.altim, elev) : null;
    o.precMm = o.precIn != null ? o.precIn * 25.4 : null;
    return o;
  });

  /* KNAK stands in for KANP (no on-field sensor), so its density altitude is
     worked at the *field's* elevation — that is the number that matters here,
     and the two fields are 3 nm and ~30 ft apart. */
  const fieldElev = fieldStation === SITE.airport.metarStation
    ? SITE.airport.elevFt : stationElev(fieldStation);
  const obs = decode(obsDoc, stationElev(station));
  const fobs = decode(fieldDoc, fieldElev);

  /* the morning snapshot of each forecast stream — the version of the day that
     existed before it happened, which is the interesting one to lay over obs */
  const gs = gridDoc && gridDoc.snaps && gridDoc.snaps[0];
  const gpts = [];
  if (gs) {
    for (let i = 0; i < gs.n; i++) {
      const t = gs.t0 + i * 3600;
      if (t < t0 - 3600 || t > t1 + 3600) continue;
      const tC = gs.temp[i], dC = gs.dew[i];
      gpts.push({
        t, tF: tC != null ? tC * 9 / 5 + 32 : null, dF: dC != null ? dC * 9 / 5 + 32 : null,
        rhPct: (tC != null && dC != null) ? relHum(tC, dC) : null,
        spd: gs.spd[i], gst: gs.gst[i], dir: gs.dir[i],
        visSM: gs.vis[i], ceilFt: gs.ceil[i], pop: gs.pop[i], wx: gs.wx[i],
      });
    }
  }

  const ms = modelDoc && modelDoc.snaps && modelDoc.snaps[0];
  const mpts = [];
  if (ms) {
    for (let i = 0; i < ms.n; i++) {
      const t = ms.t0 + i * 3600;
      if (t < t0 - 3600 || t > t1 + 3600) continue;
      mpts.push({ t, cape: ms.cape[i], cin: ms.cin[i], pr: ms.pr[i] });
    }
  }

  /* every station archived that day, for the area-ceiling lane; the GFS
     column for the winds-aloft lane */
  const ex = S.extra || {};
  const all = [];
  if (obsDoc && obsDoc.metars) all.push({ id: station, metars: obsDoc.metars });
  if (fieldDoc && fieldDoc.metars) all.push({ id: fieldStation, metars: fieldDoc.metars });
  for (const [id, d] of (ex.ringDocs || new Map())) if (d && d.metars) all.push({ id, metars: d.metars });

  return {
    date, t0, t1, station, fieldStation, elev: stationElev(station), fieldElev, obs, fobs, gpts, mpts,
    gridAt: gs ? (gs.t || gs.t0) : null, modelAt: ms ? ms.t : null,
    sun: solarTimes(date, SITE.airport.lat, SITE.airport.lon),
    ring: ringSeries(t0, all), aloft: aloftSeries(t0, ex.aloft),
  };
}

/* Per hour, the lowest ceiling any station reported, and which stations
   held a ceiling at or under 3,000 ft. An hour nobody reported is n = 0 and
   is not drawn. */
function ringSeries(t0, docs) {
  const out = [];
  for (let h = 0; h < 24; h++) {
    const lo = t0 + h * 3600, hi = lo + 3600;
    let min = null, n = 0;
    const low = [];
    for (const d of docs) {
      const obs = d.metars.filter((m) => m[0] >= lo && m[0] < hi);
      if (!obs.length) continue;
      n++;
      let c = null;
      for (const m of obs) {
        const o = parseMetar(m[1]);
        if (o.ceilFt != null && (c == null || o.ceilFt < c)) c = o.ceilFt;
      }
      if (c != null) {
        if (min == null || c < min) min = c;
        if (c <= 3000) low.push(`${d.id} ${c.toLocaleString()}`);
      }
    }
    out.push({ t: lo + 1800, min, n, low });
  }
  return out;
}

/* The GFS column at each hour of the day, from the snap with the shortest
   lead that covers it (the newest snap taken at or before the hour). */
function aloftSeries(t0, doc) {
  const snaps = (doc && doc.snaps) || [];
  if (!snaps.length) return null;
  const pts = [];
  for (let h = 0; h < 24; h++) {
    const ts = t0 + h * 3600;
    let best = null;
    for (const s of snaps) {
      if (s.t0 == null || ts < s.t0 || ts >= s.t0 + s.n * 3600) continue;
      if (s.t <= ts + 3599 && (!best || s.t > best.t)) best = s;
    }
    if (!best) for (const s of snaps) if (s.t0 != null && ts >= s.t0 && ts < s.t0 + s.n * 3600) { best = s; break; }
    if (!best) continue;
    const i = Math.round((ts - best.t0) / 3600);
    pts.push({ t: ts, lead: (ts - best.t) / 3600,
      spd: best.lev.map((_, L) => (best.spd[L] || [])[i]),
      dir: best.lev.map((_, L) => (best.dir[L] || [])[i]),
      tmp: best.lev.map((_, L) => (best.tmp[L] || [])[i]) });
  }
  return pts.length ? { lev: snaps[0].lev, pts } : null;
}
const ALOFT_FT = { 925: '~2,500 ft', 850: '~5,000 ft', 700: '~10,000 ft', 500: '~18,000 ft' };

/* ---- lanes -------------------------------------------------------------- */

/* Category washes behind visibility and ceiling: the thresholds that decide
   VFR/MVFR/IFR, in the same colors as the calendar. */
const VIS_BANDS = [[0, 1, 3], [1, 3, 2], [3, 5, 1]];
const CEIL_BANDS = [[0, 500, 3], [500, 1000, 2], [1000, 3000, 1]];

/* The observed stations switched on, in draw order. KDCA is the archive's
   verification station and draws as the solid, dotted, filled line; the field
   sensor (KNAK, which stands in for KANP) draws thinner in a lighter step of
   the same hue and always carries its station id, so telling the two apart
   never rests on color. */
function obsOn(D, src) {
  const out = [];
  /* Both observed sources carry their station id, never just one: an
     unlabelled "temp" next to a labelled "KNAK temp" reads as a generic
     series rather than as KDCA, which is exactly the confusion the
     name-every-source rule exists to prevent. */
  if (src.obs && D.obs.length) out.push({ p: D.obs, pre: `${D.station} `, tint: (c) => c, main: true, w: 2 });
  if (src.field && D.fobs.length) {
    out.push({ p: D.fobs, pre: `${D.fieldStation} `, tint: (c) => lighten(c, 0.55), main: false, w: 1.5 });
  }
  return out;
}
const anyObs = (D, fn) => D.obs.some(fn) || D.fobs.some(fn);

const LANES = [
  {
    key: 'temp', label: 'Temp & dewpoint', unit: '°F', hue: C.temp,
    avail: (D) => anyObs(D, (o) => o.tF != null) || D.gpts.some((g) => g.tF != null),
    fmt: (v) => `${Math.round(v)}°`,
    build(D, src) {
      const s = [];
      for (const o of obsOn(D, src)) {
        s.push({ name: o.pre + 'temp', color: o.tint(C.temp), kind: 'smooth', fill: o.main && 0.2, dots: o.main, width: o.w, pts: pick(o.p, 'tF') });
        s.push({ name: o.pre + 'dewpoint', color: o.tint(C.dew), kind: 'smooth', dots: o.main, width: o.w, pts: pick(o.p, 'dF') });
      }
      if (src.grid) {
        s.push({ name: 'NWS temp', color: lighten(C.temp), kind: 'smooth', dash: [5, 4], pts: pick(D.gpts, 'tF') });
        s.push({ name: 'NWS dew', color: lighten(C.dew), kind: 'smooth', dash: [5, 4], pts: pick(D.gpts, 'dF') });
      }
      return { series: s, minSpan: 12, refs: [{ v: 32, label: 'freezing' }] };
    },
  },
  {
    key: 'wind', label: 'Wind', unit: 'kt', hue: C.wind,
    avail: (D) => anyObs(D, (o) => o.spd != null) || D.gpts.some((g) => g.spd != null),
    fmt: (v) => String(Math.round(v)),
    build(D, src) {
      const s = [];
      const on = obsOn(D, src);
      for (const o of on) {
        const g = o.p.filter((x) => x.gst != null).map((x) => [x.t, x.spd || 0, x.gst]);
        if (g.length) s.push({ name: o.pre + 'gusts', color: lighten(o.tint(C.wind), 0.3), kind: 'gust', pts: g });
        s.push({ name: o.pre + 'sustained', color: o.tint(C.wind), kind: o.main ? 'area' : 'line', fill: o.main && 0.28, dots: o.main, width: o.w, pts: pick(o.p, 'spd') });
      }
      if (src.grid) {
        s.push({ name: 'NWS wind', color: lighten(C.wind), kind: 'line', dash: [5, 4], pts: pick(D.gpts, 'spd') });
      }
      /* arrows come from whichever source is actually drawn */
      const arrows = on.length ? on[0].p : src.grid ? D.gpts : null;
      /* headroom keeps the speed trace clear of the arrow band above it */
      return { series: s, zero: true, minSpan: 12, headroom: arrows ? 32 : 8, arrows };
    },
  },
  {
    key: 'pres', label: 'Pressure', unit: 'inHg', hue: C.pres,
    avail: (D) => anyObs(D, (o) => o.altim != null),
    fmt: (v) => v.toFixed(2),
    build(D, src) {
      const s = [];
      for (const o of obsOn(D, src)) {
        s.push({ name: o.pre + 'altimeter', color: o.tint(C.pres), kind: 'smooth', fill: o.main && 0.18, dots: o.main, width: o.w, pts: pick(o.p, 'altim') });
      }
      /* no 2.5 rung: an altimeter is read in hundredths, so 0.025 steps make
         an axis that looks unevenly spaced once the labels round to 2 dp */
      return { series: s, minSpan: 0.12, ladder: [1, 2, 5], refs: [{ v: 29.92, label: 'standard' }] };
    },
  },
  {
    key: 'rh', label: 'Humidity', unit: '%', hue: C.rh,
    avail: (D) => anyObs(D, (o) => o.rhPct != null) || D.gpts.some((g) => g.rhPct != null),
    fmt: (v) => `${Math.round(v)}`,
    build(D, src) {
      const s = [];
      for (const o of obsOn(D, src)) {
        s.push({ name: o.pre + 'relative humidity', color: o.tint(C.rh), kind: 'smooth', fill: o.main && 0.22, width: o.w, pts: pick(o.p, 'rhPct') });
      }
      if (src.grid) s.push({ name: 'NWS', color: lighten(C.rh), kind: 'smooth', dash: [5, 4], pts: pick(D.gpts, 'rhPct') });
      return { series: s, fixed: { lo: 0, hi: 100, ticks: [0, 25, 50, 75, 100] } };
    },
  },
  {
    key: 'vis', label: 'Visibility', unit: 'SM', hue: C.vis,
    avail: (D) => anyObs(D, (o) => o.visSM != null) || D.gpts.some((g) => g.visSM != null),
    fmt: (v) => String(+v.toFixed(2)),
    build(D, src) {
      const s = [];
      for (const o of obsOn(D, src)) {
        s.push({ name: o.pre + 'observed', color: o.tint(C.vis), kind: 'step', fill: o.main && 0.18, width: o.w, pts: pick(o.p, 'visSM') });
      }
      if (src.grid) s.push({ name: 'NWS', color: lighten(C.vis), kind: 'step', dash: [5, 4], pts: pick(D.gpts, 'visSM') });
      return { series: s, zero: true, minSpan: 10, bands: VIS_BANDS };
    },
  },
  {
    key: 'ceil', label: 'Ceiling', unit: 'ft', hue: C.ceil,
    avail: (D) => D.obs.length > 0 || D.fobs.length > 0 || D.gpts.length > 0,
    fmt: ftShort,
    build(D, src) {
      const s = [];
      const on = obsOn(D, src);
      for (const o of on) {
        /* nulls kept, not filtered: on this lane "no ceiling" is a reading */
        s.push({ name: o.pre + 'observed', color: o.tint(C.ceil), kind: 'step', fill: o.main && 0.16, width: o.w, pts: o.p.map((z) => [z.t, z.ceilFt]) });
      }
      if (src.grid) s.push({ name: 'NWS', color: lighten(C.ceil), kind: 'step', dash: [5, 4], pts: D.gpts.map((z) => [z.t, z.ceilFt]) });
      /* a clear sky has no ceiling at all — that is a fact, not a gap, so the
         obs with no ceiling get their own rail along the top of the lane */
      const rail = on.length ? on[0].p.filter((o) => o.ceilFt == null).map((o) => o.t) : [];
      /* ticks are the numbers a pilot already thinks in — the category
         thresholds, then two for scale */
      return {
        series: s, log: [150, 30000], ticks: [500, 1000, 3000, 10000, 25000],
        bands: CEIL_BANDS, rail, headroom: rail.length ? 28 : 8,
      };
    },
  },
  {
    key: 'da', label: 'Density altitude', unit: 'ft', hue: C.da,
    avail: (D) => anyObs(D, (o) => o.daFt != null),
    fmt: ftShort,
    build(D, src) {
      const s = [];
      const on = obsOn(D, src);
      for (const o of on) {
        s.push({ name: o.pre + 'density altitude', color: o.tint(C.da), kind: 'smooth', fill: o.main && 0.2, dots: o.main, width: o.w, pts: pick(o.p, 'daFt') });
      }
      /* the reference line is the elevation the shown series was worked at */
      const primary = on.length && on[0].main;
      const elev = primary ? D.elev : D.fieldElev;
      const who = primary ? D.station : `${SITE.airport.id} (via ${D.fieldStation})`;
      return {
        series: s, minSpan: 600,
        refs: elev != null ? [{ v: elev, label: `${who} elevation` }] : [],
      };
    },
  },
  {
    key: 'precip', label: 'Precipitation', unit: 'mm/h', hue: C.precip,
    avail: (D) => anyObs(D, (o) => o.precMm != null) || D.mpts.some((m) => m.pr != null)
      || D.gpts.some((g) => g.pop != null),
    fmt: (v) => String(+v.toFixed(v >= 10 ? 0 : 1)),
    build(D, src) {
      const s = [];
      /* bars, not a line: a step area at 0 draws a rule across a dry day */
      if (src.model) s.push({ name: 'GFS rate', color: lighten(C.precip, 0.45), kind: 'bars', w: 11, pts: pick(D.mpts, 'pr') });
      for (const o of obsOn(D, src)) {
        s.push({ name: o.pre + 'measured', color: o.tint(C.precip), kind: 'bars', w: o.main ? 6 : 3,
          pts: o.p.filter((x) => x.precMm).map((x) => [x.t, x.precMm]) });
      }
      /* chance-of-precip is a probability, not a rate — it gets no second
         y-scale, it shades the lane behind the rates instead */
      return { series: s, zero: true, minSpan: 1, wash: src.grid ? pick(D.gpts, 'pop') : null };
    },
  },
  {
    key: 'cape', label: 'Instability', unit: 'J/kg', hue: C.cape,
    avail: (D) => D.mpts.some((m) => m.cape != null),
    fmt: (v) => String(Math.round(v)),
    build(D, src) {
      const s = [];
      if (src.model) {
        s.push({ name: 'CAPE', color: C.cape, kind: 'area', fill: 0.2, pts: pick(D.mpts, 'cape') });
        s.push({ name: 'CIN (the cap)', color: lighten(C.cape, 0.4), kind: 'line', dash: [4, 3], pts: pick(D.mpts, 'cin') });
      }
      return { series: s, zero: true, minSpan: 500 };
    },
  },
];

LANES.push({
  key: 'ring', label: 'Area ceiling', unit: 'ft', hue: C.ceil,
  avail: (D) => !!(D.ring && D.ring.some((h) => h.n > 0)),
  fmt: ftShort,
  build(D) {
    const hrs = D.ring.filter((h) => h.n > 0);
    return {
      series: [{ name: 'lowest ceiling at any station', color: C.ceil, kind: 'step', fill: 0.16,
        pts: hrs.map((h) => [h.t, h.min]) }],
      log: [150, 30000], ticks: [500, 1000, 3000, 10000, 25000], bands: CEIL_BANDS,
      rail: hrs.filter((h) => h.min == null).map((h) => h.t), headroom: 28,
    };
  },
}, {
  key: 'aloft', label: 'Winds aloft', unit: 'kt', hue: C.wind,
  avail: (D) => !!(D.aloft && D.aloft.pts.length),
  fmt: (v) => String(Math.round(v)),
  build(D) {
    const A = D.aloft;
    const dash = [null, [6, 3], [2, 3], [8, 3, 2, 3]];
    const series = A.lev.map((lv, i) => ({
      name: `GFS ${lv} hPa ${ALOFT_FT[lv] || ''}`.trim(), color: lighten(C.wind, i * 0.18),
      kind: 'line', dash: dash[i] || undefined, pts: A.pts.map((p) => [p.t, p.spd[i]]),
    }));
    const k = A.lev.length > 1 ? 1 : 0;   // arrows follow the 850 hPa wind
    const arrows = A.pts.map((p) => ({ t: p.t, dir: p.dir[k], spd: p.spd[k] }));
    return { series, zero: true, minSpan: 20, headroom: 32, arrows };
  },
});

const SOURCES = [
  { key: 'obs', label: () => S.index.station, note: 'the archive’s verification station' },
  { key: 'field', label: () => `${S.index.field_station} · the field`,
    note: 'the nearest sensor to KANP, which has none of its own',
    skip: () => !S.index.field_station },
  { key: 'grid', label: () => 'NWS forecast', note: 'the hourly grid archived that morning' },
  { key: 'model', label: () => 'GFS model', note: 'the model point at the field' },
];

/* ---- picker (the chart's legend, and its controls) ---------------------- */

const LS_LANES = 'almanac_lanes', LS_SRC = 'almanac_src';

function loadPrefs() {
  let lanes = ['temp', 'wind', 'pres', 'ceil'];
  try {
    const raw = JSON.parse(localStorage.getItem(LS_LANES));
    if (Array.isArray(raw) && raw.length) lanes = raw.filter((k) => LANES.some((l) => l.key === k));
  } catch { /* first visit */ }
  let src = { obs: true, field: false, grid: true, model: true };
  try {
    const raw = JSON.parse(localStorage.getItem(LS_SRC));
    if (raw && typeof raw === 'object') src = { ...src, ...raw };
  } catch { /* first visit */ }
  S.lanes = new Set(lanes);
  S.src = src;
}

function savePrefs() {
  try {
    localStorage.setItem(LS_LANES, JSON.stringify([...S.lanes]));
    localStorage.setItem(LS_SRC, JSON.stringify(S.src));
  } catch { /* private mode — the chart still works, it just won't remember */ }
}

function buildPicker() {
  const srcRow = $('obs-sources'), laneRow = $('obs-series');
  srcRow.innerHTML = SOURCES.filter((s) => !(s.skip && s.skip())).map((s) =>
    `<button class="chip src" data-src="${s.key}" title="${esc(s.note)}">${esc(s.label())}</button>`).join('');
  laneRow.innerHTML = LANES.map((l) =>
    `<button class="chip" data-lane="${l.key}" title="${esc(l.label)} (${esc(l.unit)})">` +
    `<i style="background:${l.hue}"></i>${esc(l.label)}</button>`).join('');

  srcRow.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-src]');
    if (!b || b.disabled) return;
    S.src[b.dataset.src] = !S.src[b.dataset.src];
    savePrefs(); syncPicker(); drawObsChart();
  });
  laneRow.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-lane]');
    if (!b || b.disabled) return;
    S.lanes.has(b.dataset.lane) ? S.lanes.delete(b.dataset.lane) : S.lanes.add(b.dataset.lane);
    savePrefs(); syncPicker(); drawObsChart();
  });
}

/* Chips carry two states: on/off (the reader's choice) and available (whether
   this day archived anything that could fill the lane). */
function syncPicker() {
  const D = S.day;
  const stock = { obs: 'obs', field: 'fobs', grid: 'gpts', model: 'mpts' };
  for (const b of $('obs-sources').querySelectorAll('button')) {
    const k = b.dataset.src;
    const have = !!(D && D[stock[k]] && D[stock[k]].length);
    const on = have && !!S.src[k];
    b.disabled = !have;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
    b.title = have ? (SOURCES.find((s) => s.key === k) || {}).note || '' : 'nothing archived this day';
  }
  for (const b of $('obs-series').querySelectorAll('button')) {
    const lane = LANES.find((l) => l.key === b.dataset.lane);
    const have = D ? lane.avail(D) : false;
    const on = have && S.lanes.has(lane.key);
    b.disabled = !have;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
    b.title = have ? `${lane.label} (${lane.unit})` : `${lane.label} — not archived this day`;
  }
}

/* ---- render ------------------------------------------------------------- */

function renderObs(date, obsDoc, fieldDoc, gridDoc, modelDoc) {
  const card = $('obs-card');
  const D = buildDay(date, obsDoc, fieldDoc, gridDoc, modelDoc);
  S.day = D; S.hover = null;
  $('obs-readout').hidden = true;
  if (!D.obs.length && !D.fobs.length && !D.gpts.length && !D.mpts.length) { card.hidden = true; return; }
  card.hidden = false;

  const srcBits = [];
  const oGap = hourGaps(obsDoc), fGap = hourGaps(fieldDoc);
  if (D.obs.length) {
    srcBits.push(`${D.station} · ${D.obs.length} observations` +
      (gapNote(oGap) ? ` · ${gapNote(oGap)}` : ''));
  }
  if (D.fobs.length) {
    srcBits.push(`${D.fieldStation} · ${D.fobs.length}` +
      (gapNote(fGap) ? ` · ${gapNote(fGap)}` : ''));
  }
  if (D.gridAt) srcBits.push(`NWS grid ${hhmm(D.gridAt)}`);
  if (D.modelAt) srcBits.push(`GFS ${hhmm(D.modelAt)}`);
  $('obs-sub').textContent = srcBits.join(' · ');
  $('obs-sub').title = [gapHours(oGap) && `${D.station} — ${gapHours(oGap)}`,
    gapHours(fGap) && `${D.fieldStation} — ${gapHours(fGap)}`].filter(Boolean).join('\n');

  syncPicker();
  drawObsChart();

  /* headline numbers */
  const bits = [];
  const s = D.obs.length ? summarize(obsDoc.metars) : null;
  if (s) {
    if (s.hiC != null) bits.push(`<b>${cToF(s.hiC)}°</b> / <b>${cToF(s.loC)}°</b>F`);
    const worst = D.obs.reduce((w, o) => Math.max(w, o.cat), 0);
    bits.push(`worst <b class="cat-word" style="color:${CAT[worst].color}">${CAT[worst].name}</b>`);
    if (s.maxSpd) bits.push(`max wind <b>${s.maxSpd}${s.maxGst ? `G${s.maxGst}` : ''} kt</b>`);
    const pres = D.obs.filter((o) => o.altim != null).map((o) => o.altim);
    if (pres.length) {
      const lo = Math.min(...pres), hi = Math.max(...pres);
      bits.push(`pressure <b>${lo.toFixed(2)}–${hi.toFixed(2)}</b> inHg` +
        (hi - lo >= 0.15 ? ` (${((hi - lo) * 33.86).toFixed(0)} mb swing)` : ''));
    }
    const das = D.obs.filter((o) => o.daFt != null).map((o) => o.daFt);
    if (das.length) bits.push(`peak density alt <b>${ftShort(Math.max(...das))} ft</b>`);
    const tsObs = D.obs.filter((o) => o.ts);
    if (tsObs.length) bits.push(`⚡ thunder ${hhmm(tsObs[0].t)}–${hhmm(tsObs[tsObs.length - 1].t)}`);
    else if (s.rain) bits.push('rain reported');
    if (s.snow) bits.push('winter precip');
    if (s.fog) bits.push('fog/mist');
  }
  /* Every number above is an extreme over the obs on file. Saying so is the
     whole difference between "the day peaked at 12 kt" and "the archived hours
     peaked at 12 kt" on a day missing six of them. */
  const worstGap = [oGap, fGap].filter((g) => g && g.missing.length)
    .sort((a, b) => b.missing.length - a.missing.length)[0];
  $('obs-stats').innerHTML = bits.join(' · ') +
    (worstGap ? `<div class="obs-caveat" title="${esc(gapHours(worstGap))}">` +
      `${worstGap.held} of ${worstGap.span} hours ${worstGap.span < 24 ? 'archived so far' : 'on file'} — ` +
      'highs and lows of what was recorded, not of the day</div>' : '');

  renderObsTable(D);
  const raw = obsOn(D, S.src).flatMap((o) => o.p).sort((a, b) => a.t - b.t);
  $('ob-list').innerHTML = raw.map((o) =>
    `<div class="ob-row"><span class="t">${hhmm(o.t)}</span>` +
    `<span class="cat" style="background:${CAT[o.cat].color}">${CAT[o.cat].name}</span>` +
    `<code>${esc(o.raw)}</code></div>`).join('');
}

/* Every plotted value, readable without a mouse — one table per observing
   station that is switched on. */
function renderObsTable(D) {
  const tables = obsOn(D, S.src)
    .map((o) => (o.p.length ? obsTableHtml(D, o.p, o.main ? D.station : D.fieldStation) : ''))
    .filter(Boolean);
  $('obs-table').innerHTML = tables.length ? tables.join('')
    : '<p class="note">No observations archived this day.</p>';
}

function obsTableHtml(D, obs, station) {
  const wx = (o) => [o.ts && 'TS', o.rain && 'RA', o.snow && 'SN', o.fog && 'FG'].filter(Boolean).join(' ');
  return `<p class="note">${esc(station)}</p>` +
    '<table class="grid-tab"><tr><th>local</th><th>cat</th><th>temp</th>' +
    '<th>dew</th><th>RH</th><th>wind</th><th>altim</th><th>vis</th><th>ceiling</th><th>dens alt</th>' +
    '<th>precip</th><th>wx</th></tr>' +
    obs.map((o) => `<tr><td>${hhmm(o.t)}</td>` +
      `<td style="color:${CAT[o.cat].color}">${CAT[o.cat].name}</td>` +
      `<td>${o.tF != null ? Math.round(o.tF) + '°' : '—'}</td>` +
      `<td>${o.dF != null ? Math.round(o.dF) + '°' : '—'}</td>` +
      `<td>${o.rhPct != null ? Math.round(o.rhPct) + '%' : '—'}</td>` +
      `<td>${o.spd == null ? '—' : o.spd === 0 ? 'calm'
        : `${o.dir != null ? String(o.dir).padStart(3, '0') + '°' : 'VRB'} ${o.spd}${o.gst ? 'G' + o.gst : ''}`}</td>` +
      `<td>${o.altim != null ? o.altim.toFixed(2) : '—'}</td>` +
      `<td>${o.visSM != null ? (o.visSM >= 7 ? '10+' : o.visSM) : '—'}</td>` +
      `<td>${o.ceilFt != null ? o.ceilFt.toLocaleString() : 'none'}</td>` +
      `<td>${o.daFt != null ? ftShort(o.daFt) : '—'}</td>` +
      `<td>${o.precMm ? o.precMm.toFixed(1) + ' mm' : ''}</td>` +
      `<td class="wx">${wx(o)}</td></tr>`).join('') + '</table>';
}

/* Lane heights shrink as lanes are added, but never below readable — the
   canvas grows instead, which is why its height is computed, not fixed.
   Generous by design: the taller the lane, the more tick labels laneScale()
   gives it, and a 4 °F wobble that reads as a flat line in 60 px is a visible
   afternoon sea breeze in 130. */
const laneH = (n) => (n <= 2 ? 168 : n === 3 ? 146 : n === 4 ? 130 : n === 5 ? 116 : n <= 7 ? 104 : 94);
const RIB_H = 13, LANE_GAP = 12, AXIS_H = 26, PAD_L = 50, PAD_R = 14;

function activeLanes() {
  const D = S.day;
  if (!D) return [];
  return LANES.filter((l) => S.lanes.has(l.key) && l.avail(D))
    .map((l) => ({ spec: l, ...l.build(D, S.src) }))
    .filter((l) => l.series.some(hasData) || l.rail && l.rail.length || l.wash && l.wash.length);
}

function drawObsChart() {
  if (!S.day) return;
  const lanes = activeLanes();
  const n = lanes.length;
  const h = RIB_H + 10 + (n ? n * laneH(n) + (n - 1) * LANE_GAP : 26) + AXIS_H;
  chart('obs-chart', (ctx, W, H) => drawMeteogram(ctx, W, H, S.day, lanes), h);
  wireHover($('obs-chart'));
}

/* Stretches of the day with no observation at all, from whichever observed
   station the reader has switched on. Absence has to be drawn: a break in a
   line and an unpainted ribbon read as "nothing happened" just as easily as
   "nothing recorded", and only one of those is true. */
function obsGaps(D, src) {
  const on = obsOn(D, src);
  if (!on.length) return [];
  const ts = [...new Set(on.flatMap((o) => o.p.map((p) => p.t)))].sort((a, b) => a - b);
  if (!ts.length) return [{ a: D.t0, b: Math.min(D.t1, nowSec()) }];
  const end = Math.min(D.t1, Math.max(nowSec(), D.t0));   // today stops at now
  const out = [];
  if (ts[0] - D.t0 > CONT_S) out.push({ a: D.t0, b: ts[0] });
  for (let i = 1; i < ts.length; i++) {
    if (ts[i] - ts[i - 1] > CONT_S) out.push({ a: ts[i - 1], b: ts[i] });
  }
  const last = ts[ts.length - 1];
  if (end - last > CONT_S) out.push({ a: last, b: end });
  return out;
}

const nowSec = () => Date.now() / 1000;

function drawMeteogram(ctx, W, H, D, lanes) {
  ctx.clearRect(0, 0, W, H);
  ctx.font = '10px system-ui, sans-serif';
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';

  const x = (t) => PAD_L + (t - D.t0) / 86400 * (W - PAD_L - PAD_R);
  const x0 = x(D.t0), x1 = x(D.t1);
  S.meteo = { W, H, x0, x1, t0: D.t0, t1: D.t1 };

  /* flight-category ribbon: each ob paints until the next one */
  if (D.obs.length) {
    ctx.save();
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x0, 0, x1 - x0, RIB_H, 3); else ctx.rect(x0, 0, x1 - x0, RIB_H);
    ctx.clip();
    /* each ob paints until the next one — but only as far as it can speak
       for: an ob at 14:52 whose successor is at 19:52 does not make the
       intervening four hours VFR, so its block stops after CONT_S and the
       gap is left to the hatch below */
    for (let i = 0; i < D.obs.length; i++) {
      const t = D.obs[i].t;
      const next = i + 1 < D.obs.length ? D.obs[i + 1].t : t + 3600;
      const a = x(t), b = Math.min(x(Math.min(next, t + CONT_S)), x1);
      ctx.fillStyle = CAT[D.obs[i].cat].color;
      ctx.fillRect(a, 0, Math.max(b - a, 1.5), RIB_H);
    }
    ctx.restore();
    ctx.fillStyle = C.dim; ctx.textAlign = 'right';
    ctx.fillText('cat', x0 - 6, RIB_H - 3);
  }

  const n = lanes.length;
  const lh = laneH(Math.max(n, 1));
  let y = RIB_H + 10;
  const boxes = [];
  for (const lane of lanes) {
    const box = { x: x0, y, w: x1 - x0, h: lh };
    boxes.push(box);
    drawLane(ctx, D, lane, box, x);
    y += lh + LANE_GAP;
  }
  S.meteo.boxes = boxes; S.meteo.lanes = lanes;

  const top = RIB_H + 10, bot = y - LANE_GAP;

  /* the day's holes, hatched across the ribbon and every lane at once, so a
     gap reads as one missing column of the day rather than as a quiet patch
     in each measure */
  const gaps = obsGaps(D, S.src);
  for (const g of gaps) {
    const a = Math.max(x(g.a), x0), b = Math.min(x(g.b), x1);
    if (b - a < 1) continue;
    ctx.save();
    ctx.beginPath(); ctx.rect(a, 0, b - a, Math.max(bot, RIB_H) - 0);
    ctx.clip();
    /* faint on purpose: the hatch has to be unmistakable where you look for
       it and quiet everywhere else — on a day missing ten hours it covers
       nearly half the card, and a loud fill would bury the readings that
       *are* there */
    ctx.strokeStyle = 'rgba(201,162,39,0.13)'; ctx.lineWidth = 1;
    for (let px = a - Math.max(bot, RIB_H); px < b; px += 9) {
      ctx.beginPath(); ctx.moveTo(px, Math.max(bot, RIB_H)); ctx.lineTo(px + Math.max(bot, RIB_H), 0);
      ctx.stroke();
    }
    ctx.restore();
    if (b - a > 46) {                       // label the wide ones only
      ctx.save();
      ctx.fillStyle = 'rgba(201,162,39,0.6)';
      ctx.textAlign = 'center'; ctx.font = '9px system-ui, sans-serif';
      ctx.fillText('no obs', (a + b) / 2, RIB_H - 3);
      ctx.restore();
      ctx.font = '10px system-ui, sans-serif';
    }
  }
  if (!n) {
    ctx.fillStyle = C.muted; ctx.textAlign = 'center';
    ctx.fillText('Pick a measure above to plot it.', (x0 + x1) / 2, top + 16);
  }

  /* hour axis, shared by every lane */
  ctx.textAlign = 'center'; ctx.fillStyle = C.muted;
  for (let hh = 0; hh <= 24; hh += 3) {
    ctx.fillText(hh === 24 ? '24' : String(hh).padStart(2, '0'), x(D.t0 + hh * 3600), H - 13);
  }
  ctx.textAlign = 'left'; ctx.fillStyle = C.dim;
  ctx.fillText('local', 0, H - 13);

  /* sun marks: night is already shaded inside each lane, this names the edges */
  if (n) {
    ctx.textAlign = 'center';
    for (const [t, label] of [[D.sun.sunrise, '☀ ' + (D.sun.sunrise ? hhmm(D.sun.sunrise) : '')],
      [D.sun.sunset, '☾ ' + (D.sun.sunset ? hhmm(D.sun.sunset) : '')]]) {
      if (t == null || t < D.t0 || t > D.t1) continue;
      ctx.strokeStyle = 'rgba(255,214,140,0.16)';
      ctx.beginPath(); ctx.moveTo(x(t), top); ctx.lineTo(x(t), bot); ctx.stroke();
      ctx.fillStyle = 'rgba(255,214,140,0.5)';
      ctx.fillText(label, Math.min(Math.max(x(t), x0 + 26), x1 - 26), H - 2);
    }
    /* "now" on today's page */
    const now = Date.now() / 1000;
    if (now > D.t0 && now < D.t1) {
      ctx.strokeStyle = 'rgba(255,255,255,0.28)';
      ctx.beginPath(); ctx.moveTo(x(now), top); ctx.lineTo(x(now), bot); ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.4)'; ctx.textAlign = 'left';
      ctx.fillText('now', x(now) + 3, top - 2);
    }
  }

  /* crosshair */
  if (S.hover != null && n) {
    const px = x(S.hover);
    ctx.strokeStyle = 'rgba(255,255,255,0.45)';
    ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, bot); ctx.stroke();
    for (let i = 0; i < lanes.length; i++) markHover(ctx, lanes[i], boxes[i], x, S.hover);
  }
}

/* ---- one lane ----------------------------------------------------------- */

function laneScale(lane, box) {
  /* every lane reserves a little top for its label row */
  const head = Math.max(lane.headroom || 0, 11);
  const plot = box.h - head;
  if (lane.log) {
    const [lo, hi] = lane.log, k = Math.log(hi / lo);
    return {
      ticks: thin(lane.ticks, plot), lo, hi,
      y: (v) => box.y + box.h - Math.log(Math.max(lo, Math.min(hi, v)) / lo) / k * plot,
    };
  }
  if (lane.fixed) {
    const { lo, hi, ticks } = lane.fixed;
    return { ticks: thin(ticks, plot), lo, hi, y: (v) => box.y + box.h - (v - lo) / (hi - lo) * plot };
  }
  /* reference lines deliberately stay out of the range: pinning 29.92 (or
     freezing) into the scale would flatten the day's own variation. */
  const vals = [];
  for (const s of lane.series) {
    for (const p of s.pts) {
      if (p[1] == null) continue;
      vals.push(p[1]);
      if (p.length > 2) vals.push(p[2]);
    }
  }
  if (!vals.length) vals.push(0, 1);
  /* how many labels this lane can carry without crowding */
  const want = lane.want || Math.max(2, Math.min(5, Math.round(plot / 22)));
  const sc = autoScale(Math.min(...vals), Math.max(...vals), want, Math.max(2, Math.floor(plot / 18)),
    { zero: !!lane.zero, minSpan: lane.minSpan || 0, ladder: lane.ladder });
  return {
    ticks: sc.ticks, lo: sc.lo, hi: sc.hi,
    y: (v) => box.y + box.h - (v - sc.lo) / (sc.hi - sc.lo) * plot,
  };
}

function drawLane(ctx, D, lane, box, x) {
  const sc = laneScale(lane, box);
  const round = (r) => {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(box.x, box.y, box.w, box.h, r); else ctx.rect(box.x, box.y, box.w, box.h);
  };

  /* plate */
  round(5); ctx.fillStyle = C.lane; ctx.fill();

  /* category washes (visibility, ceiling) */
  ctx.save(); round(5); ctx.clip();
  for (const [lo, hi, cat] of lane.bands || []) {
    const a = sc.y(Math.min(hi, sc.hi)), b = sc.y(Math.max(lo, sc.lo));
    if (b - a > 0.5) { ctx.fillStyle = rgba(CAT[cat].color, 0.07); ctx.fillRect(box.x, a, box.w, b - a); }
  }

  /* chance-of-precip behind the rates: probability as shade, not a second axis */
  if (lane.wash) {
    for (let i = 0; i < lane.wash.length; i++) {
      const [t, pop] = lane.wash[i];
      if (!pop) continue;
      const a = x(t - 1800), b = x(t + 1800);
      ctx.fillStyle = rgba(C.wind, 0.03 + pop / 100 * 0.16);
      ctx.fillRect(a, box.y, b - a, box.h);
    }
  }

  /* night */
  const g = ctx.createLinearGradient(box.x, 0, box.x + box.w, 0);
  const f = (t) => Math.max(0, Math.min(1, (t - D.t0) / 86400));
  const sun = D.sun;
  if (sun.dawn && sun.sunrise && sun.sunset && sun.dusk) {
    g.addColorStop(0, C.night);
    g.addColorStop(f(sun.dawn), C.night);
    g.addColorStop(f(sun.sunrise), C.nightClear);
    g.addColorStop(f(sun.sunset), C.nightClear);
    g.addColorStop(f(sun.dusk), C.night);
    g.addColorStop(1, C.night);
    ctx.fillStyle = g; ctx.fillRect(box.x, box.y, box.w, box.h);
  }
  ctx.restore();

  /* grid: solid hairlines, one shade off the plate */
  ctx.strokeStyle = C.grid; ctx.lineWidth = 1;
  ctx.textAlign = 'right'; ctx.fillStyle = C.muted;
  for (const v of sc.ticks) {
    const py = Math.round(sc.y(v)) + 0.5;
    if (py < box.y - 0.5 || py > box.y + box.h + 0.5) continue;
    ctx.beginPath(); ctx.moveTo(box.x, py); ctx.lineTo(box.x + box.w, py); ctx.stroke();
    ctx.fillText(lane.spec.fmt(v), box.x - 6, py + 3);
  }
  ctx.strokeStyle = C.hour;
  for (let hh = 3; hh < 24; hh += 3) {
    const px = Math.round(x(D.t0 + hh * 3600)) + 0.5;
    ctx.beginPath(); ctx.moveTo(px, box.y); ctx.lineTo(px, box.y + box.h); ctx.stroke();
  }

  /* reference lines that mean something (freezing, 29.92, field elevation) */
  ctx.save(); round(5); ctx.clip();
  for (const r of lane.refs || []) {
    if (r.v <= sc.lo || r.v >= sc.hi) continue;
    const py = Math.round(sc.y(r.v)) + 0.5;
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.beginPath(); ctx.moveTo(box.x, py); ctx.lineTo(box.x + box.w, py); ctx.stroke();
    ctx.fillStyle = C.dim; ctx.textAlign = 'right';
    ctx.fillText(r.label, box.x + box.w - 5, py - 3);
  }

  for (const s of lane.series) plotSeries(ctx, box, sc, s, x);
  if (lane.arrows) drawWindArrows(ctx, box, lane.arrows, x);
  if (lane.rail && lane.rail.length) drawClearRail(ctx, box, lane.rail, x);
  ctx.restore();

  /* frame + labels: names in muted ink, identity carried by the swatch, on a
     backdrop so a trace running along the top of the lane stays legible */
  round(5); ctx.strokeStyle = 'rgba(255,255,255,0.05)'; ctx.stroke();
  ctx.textAlign = 'left';
  const uw = ctx.measureText(lane.spec.unit).width;
  /* series names are added while they fit — on a phone the chips above are
     already the legend, so a clipped name row would only be noise */
  const room = box.w - 24 - uw;
  const drawn = [];
  let w = 12 + ctx.measureText(lane.spec.label).width;
  for (const s of lane.series) {
    if (!hasData(s)) continue;
    const need = 15 + ctx.measureText(s.name).width + 12;
    if (w + need > room) break;
    drawn.push(s); w += need;
  }
  const plate = (x0p, wp) => {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x0p, box.y + 2, wp, 15, 4); else ctx.rect(x0p, box.y + 2, wp, 15);
    ctx.fillStyle = 'rgba(14,14,14,0.72)'; ctx.fill();
  };
  plate(box.x + 3, Math.min(w, box.w - 6));

  let lx = box.x + 8;
  ctx.fillStyle = C.ink; ctx.fillText(lane.spec.label, lx, box.y + 12);
  lx += ctx.measureText(lane.spec.label).width + 10;
  for (const s of drawn) {
    ctx.strokeStyle = s.color; ctx.lineWidth = 2;
    if (s.dash) ctx.setLineDash(s.dash);
    ctx.beginPath(); ctx.moveTo(lx, box.y + 8.5); ctx.lineTo(lx + 11, box.y + 8.5); ctx.stroke();
    ctx.setLineDash([]); ctx.lineWidth = 1;
    lx += 15;
    ctx.fillStyle = C.muted; ctx.fillText(s.name, lx, box.y + 12);
    lx += ctx.measureText(s.name).width + 12;
  }
  plate(box.x + box.w - uw - 11, uw + 8);
  ctx.textAlign = 'right'; ctx.fillStyle = C.dim;
  ctx.fillText(lane.spec.unit, box.x + box.w - 6, box.y + 12);
}

/* A null is not always missing data: on the ceiling lane it means the sky was
   clear, so the trace has to break there instead of bridging two ceilings that
   never met. Split into runs, hold each run's last value up to the ob that
   ended it, and draw the runs separately. */
/* Longest step between two readings that still counts as continuous. Every
   source here is hourly at worst (KDCA 5-minutely, KNAK and the NWS grid
   hourly), so 1.5 h keeps a normal hourly line joined and breaks the moment an
   hour is missing. */
const CONT_S = 5400;

function plotSeries(ctx, box, sc, s, x) {
  const runs = [];
  let cur = null, prevT = null;
  for (const p of s.pts) {
    if (p[1] == null) { if (cur) { cur.end = x(p[0]); cur = null; } prevT = p[0]; continue; }
    /* A missing hour is not a straight line between the obs either side of it.
       Drawing one invents a reading — the same reason a null ceiling breaks
       this line rather than bridging two ceilings that never met — and on a
       day the archiver lost six hours to, that invented line was most of the
       lane. */
    if (cur && prevT != null && p[0] - prevT > CONT_S) cur = null;
    if (!cur) { cur = { pts: [], end: null }; runs.push(cur); }
    cur.pts.push(p);
    prevT = p[0];
  }
  for (const r of runs) plotRun(ctx, box, sc, s, x, r.pts, r.end);
}

function plotRun(ctx, box, sc, s, x, srcPts, endHint) {
  const pts = srcPts.map((p) => [x(p[0]), sc.y(p[1])]);
  if (!pts.length) return;
  const base = box.y + box.h;

  if (s.kind === 'bars') {
    ctx.fillStyle = s.color;
    const bw = s.w || 7;
    for (let i = 0; i < pts.length; i++) {
      if (!(srcPts[i][1] > 0)) continue;                 // a dry hour draws nothing
      const [px, py] = pts[i];
      const h = Math.max(base - py, 2);
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(px - bw / 2, base - h, bw, h, [2, 2, 0, 0]);
      else ctx.rect(px - bw / 2, base - h, bw, h);
      ctx.fill();
    }
    return;
  }
  if (s.kind === 'gust') {                       // sustained → gust whisker
    ctx.strokeStyle = s.color; ctx.lineWidth = 2;
    for (const p of srcPts) {
      const px = x(p[0]), a = sc.y(p[1]), b = sc.y(p[2]);
      ctx.beginPath(); ctx.moveTo(px, a); ctx.lineTo(px, b); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(px - 3.5, b); ctx.lineTo(px + 3.5, b); ctx.stroke();
    }
    ctx.lineWidth = 1;
    return;
  }

  const stepped = s.kind === 'step' || s.kind === 'stepArea';
  /* a step holds its value until the reading that ended it — the next ob if
     that one said "clear", otherwise the right edge (a 23:52 ob is still the
     ceiling at midnight) */
  const endX = stepped ? (endHint != null ? endHint : box.x + box.w) : pts[pts.length - 1][0];
  const trace = () => {
    if (s.kind === 'smooth') { smoothPath(ctx, pts); return; }
    if (stepped) {
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) { ctx.lineTo(pts[i][0], pts[i - 1][1]); ctx.lineTo(pts[i][0], pts[i][1]); }
      ctx.lineTo(endX, pts[pts.length - 1][1]);
      return;
    }
    pts.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
  };

  if (s.fill) {
    ctx.beginPath(); trace();
    ctx.lineTo(endX, base); ctx.lineTo(pts[0][0], base); ctx.closePath();
    const grad = ctx.createLinearGradient(0, box.y, 0, base);
    grad.addColorStop(0, rgba(s.color, s.fill));
    grad.addColorStop(1, rgba(s.color, 0));
    ctx.fillStyle = grad; ctx.fill();
  }
  ctx.strokeStyle = s.color; ctx.lineWidth = s.width || (s.dash ? 1.5 : 2);
  if (s.dash) ctx.setLineDash(s.dash);
  ctx.beginPath(); trace(); ctx.stroke();
  ctx.setLineDash([]); ctx.lineWidth = 1;

  if (s.dots && pts.length < 40) {               // where the obs actually are
    for (const [px, py] of pts) {
      ctx.beginPath(); ctx.arc(px, py, 3, 0, 7);
      ctx.fillStyle = '#1a1a1a'; ctx.fill();      // 2px surface ring
      ctx.beginPath(); ctx.arc(px, py, 1.8, 0, 7);
      ctx.fillStyle = s.color; ctx.fill();
    }
  }
}

/* Wind direction as arrows that fly with the wind, thinned so they never
   collide — a barb field is precise but nobody reads it at a glance. */
function drawWindArrows(ctx, box, src, x) {
  const y = box.y + 24;
  let lastX = -1e9;
  for (const o of src) {
    if (o.spd == null) continue;
    const px = x(o.t);
    if (px - lastX < 26) continue;
    lastX = px;
    if (!o.spd) {                                 // calm: the standard hollow ring
      ctx.strokeStyle = C.muted; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.arc(px, y, 3.2, 0, 7); ctx.stroke();
      continue;
    }
    if (o.dir == null) {                          // variable
      ctx.fillStyle = C.muted; ctx.textAlign = 'center';
      ctx.fillText('~', px, y + 4);
      continue;
    }
    /* METAR direction is where the wind comes FROM; the arrow points downwind */
    const a = (o.dir + 180) * Math.PI / 180;
    const dx = Math.sin(a), dy = -Math.cos(a), L = 7;
    ctx.strokeStyle = rgba(C.wind, 0.55 + Math.min(0.45, o.spd / 30));
    ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.moveTo(px - dx * L, y - dy * L); ctx.lineTo(px + dx * L, y + dy * L); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(px + dx * L, y + dy * L);
    ctx.lineTo(px + dx * (L - 5) - dy * 3.2, y + dy * (L - 5) + dx * 3.2);
    ctx.lineTo(px + dx * (L - 5) + dy * 3.2, y + dy * (L - 5) - dx * 3.2);
    ctx.closePath();
    ctx.fillStyle = rgba(C.wind, 0.75); ctx.fill();
    ctx.lineWidth = 1;
  }
}

/* Obs with no ceiling at all — drawn as a rail so "clear" reads as a fact
   rather than as missing data. */
function drawClearRail(ctx, box, times, x) {
  const y = box.y + 22;
  ctx.strokeStyle = rgba(C.ceil, 0.5); ctx.lineWidth = 2;
  for (const t of times) {
    ctx.beginPath(); ctx.moveTo(x(t) - 3, y); ctx.lineTo(x(t) + 3, y); ctx.stroke();
  }
  ctx.lineWidth = 1;
  const w = ctx.measureText('no ceiling').width;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(box.x + box.w - w - 11, y - 7, w + 8, 14, 4);
  else ctx.rect(box.x + box.w - w - 11, y - 7, w + 8, 14);
  ctx.fillStyle = 'rgba(14,14,14,0.72)'; ctx.fill();
  ctx.fillStyle = C.dim; ctx.textAlign = 'right';
  ctx.fillText('no ceiling', box.x + box.w - 6, y + 3.5);
}

/* ---- hover -------------------------------------------------------------- */

const nearest = (pts, t, maxGap) => {
  let best = null, bd = Infinity;
  for (const p of pts) { const d = Math.abs(p[0] - t); if (d < bd) { bd = d; best = p; } }
  return bd <= maxGap ? best : null;
};

function markHover(ctx, lane, box, x, t) {
  const sc = laneScale(lane, box);
  for (const s of lane.series) {
    if (s.kind === 'gust' || s.kind === 'bars') continue;
    const p = nearest(s.pts.filter((q) => q[1] != null), t, 3600);
    if (!p) continue;
    ctx.beginPath(); ctx.arc(x(p[0]), sc.y(p[1]), 4.5, 0, 7);
    ctx.fillStyle = '#1a1a1a'; ctx.fill();
    ctx.beginPath(); ctx.arc(x(p[0]), sc.y(p[1]), 3, 0, 7);
    ctx.fillStyle = s.color; ctx.fill();
  }
}

function wireHover(cv) {
  if (cv.dataset.hov) return;
  cv.dataset.hov = '1';
  const at = (e) => {
    const m = S.meteo;
    if (!m) return null;
    const r = cv.getBoundingClientRect();
    const px = (e.clientX - r.left) * (m.W / r.width);
    if (px < m.x0 - 4 || px > m.x1 + 4) return null;
    return m.t0 + (px - m.x0) / (m.x1 - m.x0) * (m.t1 - m.t0);
  };
  const move = (e) => {
    const t = at(e);
    if (t == null) { clearHover(); return; }
    S.hover = t;
    showReadout(e, t);
    if (!S._hrq) S._hrq = requestAnimationFrame(() => { S._hrq = 0; S.charts.get('obs-chart')(); });
  };
  cv.addEventListener('pointermove', move);
  cv.addEventListener('pointerdown', move);
  cv.addEventListener('pointerleave', clearHover);
}

function clearHover() {
  if (S.hover == null) return;
  S.hover = null;
  $('obs-readout').hidden = true;
  const fn = S.charts.get('obs-chart');
  if (fn) fn();
}

/* One observed station's value for one lane, or null if it has nothing to say
   there. Shared by both stations so they read identically. */
function obReading(k, o) {
  switch (k) {
    case 'temp':
      return o.tF == null ? null : ['temp', `${Math.round(o.tF)}°F` +
        (o.dF != null ? ` <span class="d">dew ${Math.round(o.dF)}°</span>` : '')];
    case 'wind':
      return o.spd == null ? null : ['wind', o.spd === 0 ? 'calm'
        : `${o.dir != null ? `${dirName(o.dir)} ${String(o.dir).padStart(3, '0')}°` : 'variable'} ` +
          `${o.spd} kt${o.gst ? ` <span class="d">gusts ${o.gst}</span>` : ''}`];
    case 'pres':
      return o.altim == null ? null : ['pressure', `${o.altim.toFixed(2)} inHg` +
        (o.slpMb != null ? ` <span class="d">SLP ${o.slpMb.toFixed(1)} mb</span>` : '')];
    case 'rh':
      return o.rhPct == null ? null : ['humidity', `${Math.round(o.rhPct)}%`];
    case 'vis':
      return o.visSM == null ? null : ['visibility', o.visSM >= 7 ? '10+ SM' : `${o.visSM} SM`];
    case 'ceil':
      return ['ceiling', o.ceilFt != null
        ? `${o.ceilFt.toLocaleString()} ft` +
          (o.clouds.length ? ` <span class="d">${esc(o.clouds.slice(0, 2).join(', '))}</span>` : '')
        : '<span class="d">none</span>'];
    case 'da':
      return o.daFt == null ? null : ['density alt', `${ftShort(o.daFt)} ft`];
    case 'precip':
      return o.precMm ? ['measured', `${o.precMm.toFixed(1)} mm/h`] : null;
    default:
      return null;
  }
}

const LANE_HUE = { temp: C.temp, wind: C.wind, pres: C.pres, rh: C.rh, vis: C.vis, ceil: C.ceil, da: C.da, precip: C.precip };

function showReadout(e, t) {
  const D = S.day, box = $('obs-readout');
  const rows = [];
  const at = (arr, gap) => {
    const hit = arr.length ? nearest(arr.map((p) => [p.t, p]), t, gap) : null;
    return hit && hit[1];
  };
  const stations = obsOn(D, S.src).map((o) => ({ ...o, ob: at(o.p, 5400) }));
  const gp = S.src.grid ? at(D.gpts, 1800) : null;
  const mp = S.src.model ? at(D.mpts, 1800) : null;

  const row = (color, label, value) => rows.push(
    `<div class="r"><i style="background:${color}"></i><span class="k">${esc(label)}</span>` +
    `<span class="v">${value}</span></div>`);

  for (const lane of (S.meteo.lanes || [])) {
    const k = lane.spec.key;
    for (const st of stations) {
      const r = st.ob && obReading(k, st.ob);
      if (r) row(st.tint(LANE_HUE[k] || lane.spec.hue), st.pre + r[0], r[1]);
    }
    if (gp) {
      if (k === 'temp' && gp.tF != null) row(lighten(C.temp), 'NWS temp', `${Math.round(gp.tF)}°F` +
        (gp.dF != null ? ` <span class="d">dew ${Math.round(gp.dF)}°</span>` : ''));
      if (k === 'wind' && gp.spd != null) row(lighten(C.wind), 'NWS wind',
        `${gp.dir != null ? `${dirName(gp.dir)} ` : ''}${gp.spd} kt` +
        (gp.gst ? ` <span class="d">gusts ${gp.gst}</span>` : ''));
      if (k === 'rh' && gp.rhPct != null) row(lighten(C.rh), 'NWS humidity', `${Math.round(gp.rhPct)}%`);
      if (k === 'vis' && gp.visSM != null) row(lighten(C.vis), 'NWS vis', `${gp.visSM} SM`);
      if (k === 'ceil' && gp.ceilFt != null) row(lighten(C.ceil), 'NWS ceiling', `${gp.ceilFt.toLocaleString()} ft`);
      if (k === 'precip' && gp.pop != null) row(rgba(C.wind, 0.6), 'chance', `${gp.pop}%`);
    }
    if (mp) {
      if (k === 'precip' && mp.pr != null) row(lighten(C.precip, 0.45), 'GFS rate', `${mp.pr.toFixed(1)} mm/h`);
      if (k === 'cape' && mp.cape != null) row(C.cape, 'CAPE', `${Math.round(mp.cape)} J/kg` +
        (mp.cin != null ? ` <span class="d">CIN ${Math.round(mp.cin)}</span>` : ''));
    }
  }

  for (const lane of (S.meteo.lanes || [])) {
    const k = lane.spec.key;
    if (k === 'ring' && D.ring) {
      const h = D.ring[Math.max(0, Math.min(23, Math.floor((t - D.t0) / 3600)))];
      if (h && h.n) {
        row(C.ceil, 'area ceiling', h.min != null
          ? `${h.min.toLocaleString()} ft <span class="d">${esc(h.low.join(', '))}</span>`
          : `<span class="d">none · ${h.n} station${h.n === 1 ? '' : 's'}</span>`);
      }
    }
    if (k === 'aloft' && D.aloft) {
      const hit = nearest(D.aloft.pts.map((q) => [q.t, q]), t, 1800);
      const p = hit && hit[1];
      if (p) {
        row(C.wind, 'GFS aloft', D.aloft.lev.map((lv, i) =>
          `${lv} ${p.dir[i] != null ? String(p.dir[i]).padStart(3, '0') : '—'}/${p.spd[i] != null ? p.spd[i] : '—'}`).join(' · ') +
          ` <span class="d">lead ${Math.round(p.lead)} h</span>`);
      }
    }
  }

  const ob = stations.length ? stations[0].ob : null;
  const head = ob
    ? `${hhmm(ob.t)} <span class="cat" style="background:${CAT[ob.cat].color}">${CAT[ob.cat].name}</span>`
    : `${hhmm(Math.round(t))}`;
  const wxBits = ob ? [ob.ts && 'thunder', ob.rain && 'rain', ob.snow && 'snow', ob.fog && 'fog/mist']
    .filter(Boolean).join(' · ') : '';
  const gwx = gp && gp.wx ? gp.wx.replace(/_/g, ' ').replace(/,/g, ', ') : '';

  box.innerHTML = `<div class="h">${head}</div>${rows.join('')}` +
    (wxBits ? `<div class="wx">${esc(wxBits)}</div>` : '') +
    (gwx && S.src.grid ? `<div class="wx d">NWS: ${esc(gwx)}</div>` : '');
  box.hidden = rows.length === 0 && !wxBits;

  const wrap = $('obs-wrap').getBoundingClientRect();
  const left = e.clientX - wrap.left, topY = e.clientY - wrap.top;
  box.style.left = `${Math.max(4, Math.min(left + 14, wrap.width - box.offsetWidth - 6))}px`;
  box.style.top = `${Math.max(4, Math.min(topY + 12, wrap.height - box.offsetHeight - 6))}px`;
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

/* What was forecast — one row per morning the call for this day was archived
   (that day's first snapshot, the same baseline the drift and verification
   cards use), high / low / precip % / wording, then what verified. A table,
   not a chart: 42 near-identical points over a six-day lead-up drew as a flat
   line with no readable axis, and the question is "what did they say, and
   when did it change", which reads as rows. */
function renderDrift(date, points, obsDoc, nextObsDoc) {
  const card = $('drift-card');
  if (!points || !points.length) { card.hidden = true; return; }
  card.hidden = false;

  const obsHi = obsDoc ? dayHighF(obsDoc.metars) : null;
  const obsLo = nextObsDoc ? overnightLowF(nextObsDoc.metars) : null;
  const byDay = new Map();
  for (const p of points) { const d = lp(p.t).date; if (!byDay.has(d)) byDay.set(d, p); }
  const deg = (v) => (v != null ? `${v}°` : '—');
  const rows = [...byDay.entries()].map(([d, p]) => {
    const back = Math.round((midnight(date) - midnight(d)) / 86400);
    return `<tr><td>${back === 0 ? 'day of' : `${back} d before`}</td>` +
      `<td class="d">${d.slice(5).replace('-', '/')} ${hhmm(p.t)}</td>` +
      `<td>${deg(p.hi)}</td><td>${deg(p.lo)}</td><td>${p.pop != null ? p.pop : '—'}</td>` +
      `<td class="wx">${esc(p.short || '')}</td></tr>`;
  });
  if (obsHi != null || obsLo != null) {
    rows.push(`<tr class="vf"><td>verified</td><td class="d">KDCA</td>` +
      `<td>${deg(obsHi)}</td><td>${deg(obsLo)}</td><td></td><td class="wx"></td></tr>`);
  }
  const firstDay = lp(points[0].t).date;
  $('drift-sub').textContent = `${points.length} snapshots · first ${firstDay === date ? 'that morning' : firstDay} · each morning's call`;
  $('drift-table').innerHTML = '<table class="grid-tab"><tr><th>lead</th><th>archived</th><th>high</th>' +
    '<th>low</th><th>precip %</th><th>wording</th></tr>' + rows.join('') + '</table>';
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
  const gh = hours(gsnap);

  /* hour-by-hour table from the grid */
  $('grid-summary').textContent = gsnap && gh.length
    ? `${gh.length} hours · temp · wind · ceiling · vis · precip % · weather`
    : 'no grid snapshot archived this day';
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

/* ---------------------------------------------------------------------------
   Alerts, TAFs, AFDs
--------------------------------------------------------------------------- */

/* ---------------------------------------------------------------------------
   Alerts — the day's alerts on the day's clock.
   ---------------------------------------------------------------------------
   The archive keeps one record per issuance, so a watch that was updated three
   times arrives as four near-identical records. Listed one under another they
   read as four separate alerts, and the only time in the row — a bare
   "4:00 AM → 11:00 AM" — silently drops the date, so a watch issued this
   afternoon for tomorrow morning reads as one that ran this morning.

   So: records of the same event whose spans touch fold into one thread, drawn
   as a bar on a shared axis. The bar is the span it was in effect, the ticks
   on it are the issuances, and the dotted run-in is the gap between the first
   issuance and onset — the lead time, which is the fact worth reading. The
   axis is the selected day (same hours as the meteogram above), stretched only
   as far as an alert that began before it or ran past it.
--------------------------------------------------------------------------- */

const MON = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december'];
const MON_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/* Alerts are read as Warning / Watch / Advisory long before anyone reads the
   CAP severity field — and on a convective day here every record comes back
   "Severe", so severity alone colors nothing. Color by the word instead. */
const AL_KINDS = [
  [/\bwarning\b/i, { label: 'Warning', color: '#ef4444' }],
  [/\bwatch\b/i, { label: 'Watch', color: '#f59e0b' }],
  [/\badvisory\b/i, { label: 'Advisory', color: '#eab308' }],
];
const AL_OTHER = { label: 'Statement', color: '#4a9eff' };
const alKind = (ev) => (AL_KINDS.find(([re]) => re.test(ev || '')) || [null, AL_OTHER])[1];

/* NWS headlines carry the issuance in words — "…issued August 4 at 4:09PM EDT
   until…" — which is the real issue time. `seen` is only when the hourly
   archiver noticed, up to an hour later, so parse the headline when it's there
   and mark the rows that fell back. The headline carries no year: take the one
   that lands the issuance closest to the alert itself. */
function issuedAt(headline, ref) {
  const m = /issued\s+([A-Za-z]+)\s+(\d{1,2})\s+at\s+(\d{1,2}):(\d{2})\s*([AP])M/i.exec(headline || '');
  const mo = m ? MON.indexOf(m[1].toLowerCase()) : -1;
  if (mo < 0) return { t: ref, exact: false };
  const h = (+m[3] % 12) + (m[5].toUpperCase() === 'P' ? 12 : 0);
  const y0 = +lp(ref).date.slice(0, 4);
  let best = null;
  for (const y of [y0 - 1, y0, y0 + 1]) {
    const t = midnight(`${y}-${String(mo + 1).padStart(2, '0')}-${String(+m[2]).padStart(2, '0')}`)
      + h * 3600 + (+m[4]) * 60;
    if (isFinite(t) && (best === null || Math.abs(t - ref) < Math.abs(best - ref))) best = t;
  }
  return best === null ? { t: ref, exact: false } : { t: best, exact: true };
}

const AL_GAP = 3600;    // same event, spans within an hour of each other: one episode

function alertThreads(alerts) {
  const recs = (alerts || []).map((a) => {
    const onset = a.onset ? Date.parse(a.onset) / 1000 : a.seen;
    const ends = a.ends ? Date.parse(a.ends) / 1000 : null;
    const iss = issuedAt(a.headline, onset || a.seen || 0);
    return { ev: a.event || 'Alert', sev: a.severity, onset, ends, iss: iss.t,
      exact: iss.exact, headline: a.headline || '', desc: a.desc || '' };
  }).filter((r) => isFinite(r.onset)).sort((a, b) => a.onset - b.onset || a.iss - b.iss);

  const out = [];
  for (const r of recs) {
    let th = null;
    for (let i = out.length - 1; i >= 0; i--) {          // the most recent match wins
      const t = out[i];
      if (t.ev !== r.ev) continue;
      if (r.onset <= (t.ends == null ? Infinity : t.ends) + AL_GAP
        && (r.ends == null ? Infinity : r.ends) >= t.onset - AL_GAP) { th = t; break; }
    }
    if (!th) { th = { ev: r.ev, sev: r.sev, onset: r.onset, ends: r.ends, recs: [] }; out.push(th); }
    th.onset = Math.min(th.onset, r.onset);
    /* one open-ended issuance leaves the whole thread open-ended */
    th.ends = (th.ends == null || r.ends == null) ? null : Math.max(th.ends, r.ends);
    th.recs.push(r);
  }
  for (const th of out) {
    th.recs.sort((a, b) => a.iss - b.iss);
    th.iss = th.recs[0].iss;
    th.kind = alKind(th.ev);
  }
  return out.sort((a, b) => a.onset - b.onset || (a.ends || Infinity) - (b.ends || Infinity));
}

/* The axis: the day, widened to hold the alerts, then snapped out to whole
   ticks. Capped either side so one multi-day advisory can't squash the day
   itself into a sliver — anything past the cap is drawn clipped. */
function alertWindow(threads, t0, t1) {
  let lo = t0, hi = t1;
  for (const th of threads) {
    lo = Math.min(lo, th.onset);
    hi = Math.max(hi, th.ends == null ? t1 : th.ends);
  }
  lo = Math.max(lo, t0 - 12 * 3600);
  hi = Math.min(hi, t1 + 36 * 3600);
  const step = (hi - lo <= 27 * 3600 ? 3 : hi - lo <= 54 * 3600 ? 6 : 12) * 3600;
  return { step, w0: t0 + Math.floor((lo - t0) / step) * step, w1: t0 + Math.ceil((hi - t0) / step) * step };
}

/* "16:09" on the selected day, "Aug 4 16:09" on any other — an alert that
   crosses midnight is exactly the case a bare clock time misreads. */
function tstamp(ts, day) {
  const p = lp(ts);
  const hm = `${String(p.h).padStart(2, '0')}:${String(p.m).padStart(2, '0')}`;
  return p.date === day ? hm : `${MON_SHORT[+p.date.slice(5, 7) - 1]} ${+p.date.slice(8)} ${hm}`;
}

function dur(s) {
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  if (h < 24) return r ? `${h} h ${r} m` : `${h} h`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

/* Night shading, same gradient the meteogram lanes use, walked day by day so
   it still reads across a window that spans a midnight. */
function alertNight(w0, w1) {
  const span = w1 - w0, stops = [];
  const p = (t) => Math.max(0, Math.min(100, (t - w0) / span * 100));
  for (let d = lp(w0).date; d <= lp(w1).date; d = addDays(d, 1)) {
    const s = solarTimes(d, SITE.airport.lat, SITE.airport.lon);
    if (!s.dawn || !s.sunrise || !s.sunset || !s.dusk) continue;
    stops.push([p(s.dawn), C.night], [p(s.sunrise), C.nightClear],
      [p(s.sunset), C.nightClear], [p(s.dusk), C.night]);
  }
  if (!stops.length) return '';
  return `linear-gradient(90deg, ${C.night} 0%, ` +
    stops.map(([pp, c]) => `${c} ${pp.toFixed(2)}%`).join(', ') + `, ${C.night} 100%)`;
}

function renderAlerts(date, doc) {
  const card = $('alert-card');
  S.alerts = doc;                 // kept so a resize can re-thin the axis labels
  const threads = alertThreads(doc && doc.alerts);
  if (!threads.length) { card.hidden = true; return; }
  card.hidden = false;

  const t0 = midnight(date), t1 = t0 + 86400;
  const { w0, w1, step } = alertWindow(threads, t0, t1);
  const span = w1 - w0, now = Date.now() / 1000;
  const at = (t) => (t - w0) / span * 100;
  const cl = (p) => Math.max(0, Math.min(100, p));
  const pc = (p) => `${cl(p).toFixed(3)}%`;
  const isMid = (t) => { const p = lp(t); return p.h === 0 && p.m === 0; };

  /* axis: the hour ticks, the date at each local midnight, "now" if we're in it.
     Labels thin out to whatever the card is actually wide enough to hold — the
     ends always keep theirs, since they carry the dates. */
  const wpx = $('alert-list').clientWidth || 700, GAP_PX = 46;
  const axis = [];
  for (let t = w0; t <= w1 + 1; t += step) {
    const p = lp(t), mid = isMid(t);
    axis.push({ t, px: at(t) / 100 * wpx,
      cls: `t${mid ? ' mid' : ''}${t === w0 ? ' first' : t + step > w1 ? ' last' : ''}`,
      text: mid ? `${MON_SHORT[+p.date.slice(5, 7) - 1]} ${+p.date.slice(8)}`
        : String(p.h).padStart(2, '0') });
  }
  const keep = [0];
  for (let i = 1; i < axis.length - 1; i++) {
    if (axis[i].px - axis[keep[keep.length - 1]].px >= GAP_PX
      && axis[axis.length - 1].px - axis[i].px >= GAP_PX) keep.push(i);
  }
  if (axis.length > 1) keep.push(axis.length - 1);
  const ticks = keep.map((i) => `<span class="${axis[i].cls}" style="left:${pc(at(axis[i].t))}">${axis[i].text}</span>`);
  if (now > w0 && now < w1) ticks.push(`<span class="t now" style="left:${pc(at(now))}">now</span>`);

  /* marks every track carries: local midnights inside the window, and "now" */
  let rails = '';
  for (let t = w0; t <= w1 + 1; t += step) {
    if (isMid(t) && at(t) > 0.5 && at(t) < 99.5) rails += `<span class="mid" style="left:${pc(at(t))}"></span>`;
  }
  if (now > w0 && now < w1) rails += `<span class="now" style="left:${pc(at(now))}"></span>`;

  const night = alertNight(w0, w1);
  const bg = 'background-image:repeating-linear-gradient(90deg,rgba(255,255,255,0.055) 0 1px,' +
    `transparent 1px ${(step / span * 100).toFixed(4)}%)${night ? `,${night}` : ''}`;

  const rowHtml = threads.map((th) => {
    const endsT = th.ends == null ? w1 : th.ends;
    const a = cl(at(th.onset)), b = cl(at(endsT));
    const marks = [];
    if (th.iss != null && th.iss < th.onset - 300 && at(th.iss) < a) {
      marks.push(`<span class="lead" style="left:${pc(at(th.iss))};width:${(a - cl(at(th.iss))).toFixed(3)}%"></span>`);
    }
    marks.push(`<span class="bar${th.ends == null ? ' open' : ''}" ` +
      `style="left:${pc(a)};width:${Math.max(b - a, 0.4).toFixed(3)}%"></span>`);
    for (const r of th.recs) {
      if (r.iss > w0 && r.iss < w1) marks.push(`<span class="tick" style="left:${pc(at(r.iss))}"></span>`);
    }
    if (th.onset < w0) marks.push('<span class="clip l" title="in effect before this window">‹</span>');
    if (th.ends == null || th.ends > w1) {
      marks.push(`<span class="clip r" title="${th.ends == null ? 'no end time given'
        : 'still in effect past this window'}">›</span>`);
    }

    const meta = [
      th.ends != null ? dur(th.ends - th.onset) : 'no end time given',
      th.recs.length > 1 ? `${th.recs.length - 1} update${th.recs.length > 2 ? 's' : ''}` : null,
      th.iss < th.onset - 300 ? `${dur(th.onset - th.iss)} lead` : null,
    ].filter(Boolean).join(' · ');

    let prev = null;
    const issRows = th.recs.map((r, i) => {
      const same = r.desc && r.desc === prev;
      const text = same ? '<span class="same">text unchanged</span>'
        : r.desc ? `<details class="fold"><summary>full text</summary><pre class="product">${esc(r.desc)}</pre></details>` : '';
      prev = r.desc || prev;
      return `<div class="al-i"><span class="t"${r.exact ? '' : ' title="issuance time not in the headline — this is when the archiver first saw it"'}>` +
        `${r.exact ? '' : '~'}${tstamp(r.iss, date)}</span>` +
        `<span class="k">${i ? 'update' : 'issued'}</span><span class="x">${text}</span></div>`;
    }).join('');

    return `<details class="al" style="--sev:${th.kind.color}">` +
      '<summary><span class="al-head">' +
      `<span class="kind">${th.kind.label}</span>` +
      `<b class="ev">${esc(th.ev)}</b>` +
      `<span class="when">${tstamp(th.onset, date)} → ${th.ends == null ? '—' : tstamp(th.ends, date)}</span>` +
      `<span class="meta">${meta}</span></span>` +
      `<span class="al-track" style="${bg}">${rails}${marks.join('')}</span></summary>` +
      `<div class="al-body"><div class="hl">${esc(th.recs[th.recs.length - 1].headline)}</div>` +
      `<div class="al-facts">NWS severity ${esc(th.sev || 'unstated')} · ` +
      `first issued ${tstamp(th.iss, date)}</div>${issRows}</div></details>`;
  }).join('');

  $('alert-sub').textContent = `${threads.length} alert${threads.length > 1 ? 's' : ''}` +
    ` · ${tstamp(threads[0].onset, date)} → ` +
    `${threads.some((t) => t.ends == null) ? 'open'
      : tstamp(Math.max(...threads.map((t) => t.ends)), date)}`;
  $('alert-list').innerHTML = `<div class="al-axis">${ticks.join('')}</div>${rowHtml}`;
  $('alert-legend').innerHTML =
    [...AL_KINDS.map(([, k]) => k), AL_OTHER].map((k) =>
      `<span><i style="background:${k.color}"></i>${k.label}</span>`).join('') +
    '<span class="m"><i class="tk"></i>issuance</span>' +
    '<span class="m"><i class="ld"></i>lead time</span>';
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

/* The periods of an issuance: the archiver's decoded ones, or the raw TAC
   text decoded by js/taf-tac.js into the same shape (cached on the record). */
function tafPeriods(taf) {
  if (taf.periods) return taf.periods;
  if (taf.raw && typeof TafTac !== 'undefined') {
    if (taf._p === undefined) {
      try { taf._p = TafTac.parse(taf.raw, taf.t).periods; } catch (e) { taf._p = null; }
    }
    return taf._p && taf._p.length ? taf._p : null;
  }
  return null;
}

/* One issuance's body — decoded periods, with the raw text folded under
   them when the archive holds it. Shared with the station explorer. */
function tafBodyHtml(taf) {
  const periods = tafPeriods(taf);
  const lines = periods ? periods.map((p) =>
    `<div class="taf-line"><span class="ind">${esc(tafInd(p.ind))}</span>` +
    `<span class="when">${hhmm(p.b)}–${hhmm(p.e)}</span>` +
    `<span class="what">${esc(tafPeriodLine(p))}</span></div>`).join('') : '';
  const raw = taf.raw
    ? (periods ? `<details class="fold"><summary>raw text</summary>` : '') +
      `<pre class="product">${esc(taf.raw.trim())}</pre>` + (periods ? '</details>' : '')
    : '';
  return lines + raw;
}

/* ---------------------------------------------------------------------------
   Station explorer — every archived METAR and TAF for the day, per station.
   ---------------------------------------------------------------------------
   The field sensor + KDCA come from their own streams; the rest from the
   local ring (stations/<ID>/). Order is SITE.weather.areaStations (the same
   set the discussion page's area low-cloud check sweeps), then whatever else
   the ring archived that day. Collapsed by default — this is the bottom
   drawer, not the headline. A listed station with no data renders as
   "nothing archived": absence of data must never read as a clear sky.
--------------------------------------------------------------------------- */

/* Names for ring stations beyond the configured area set (display only). */
const RING_LABELS = {
  KMTN: 'Martin State', KCGS: 'College Park', KAPG: 'Phillips AAF · Aberdeen',
  KNHK: 'Patuxent River NAS',
};

function stationHtml(st) {
  if (!st.list.length && !st.tafs.length) {
    return `<div class="stn-none"><span class="who">${esc(st.id)}</span>${esc(st.label)}` +
      ' — nothing archived this day</div>';
  }
  const s = summarize(st.list);
  const meta = [
    st.list.length ? `${st.list.length} obs` : 'no METARs',
    s ? `worst ${CAT[s.worstDay].name}` : null,
    st.tafs.length ? `${st.tafs.length} TAF${st.tafs.length === 1 ? '' : 's'}` : null,
  ].filter(Boolean).join(' · ');
  const obRows = st.list.map(([t, raw]) => {
    const o = parseMetar(raw);
    return `<div class="ob-row"><span class="t">${hhmm(t)}</span>` +
      `<span class="cat" style="background:${CAT[o.cat].color}">${CAT[o.cat].name}</span>` +
      `<code>${esc(raw)}</code></div>`;
  }).join('');
  const tafBlocks = st.tafs.map((taf) =>
    `<p class="note" style="margin:10px 0 2px">TAF issued ${hhmm(taf.t)}</p>${tafBodyHtml(taf)}`).join('');
  return `<details class="iss"><summary><span class="who">${esc(st.id)}</span>${esc(st.label)}` +
    `<span class="meta">${esc(meta)}</span></summary><div class="body">` +
    (obRows ? `<div class="ob-list">${obRows}</div>` : '') + tafBlocks + '</div></details>';
}

function renderStations(date, ringDocs, obsDoc, fieldDoc, tafDoc) {
  const card = $('stn-card');
  const ringList = (id) => { const d = ringDocs.get(id); return (d && d.metars) || []; };
  const tafs = (tafDoc && tafDoc.tafs) || [];
  const stations = [];
  const seen = new Set();
  const add = (id, label, list) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    stations.push({ id, label: label || '', list: list || [],
      tafs: tafs.filter((t) => t.station === id).sort((a, b) => a.t - b.t) });
  };
  if (S.index.field_station) {
    add(S.index.field_station, 'the field sensor', fieldDoc && fieldDoc.metars);
  }
  for (const st of SITE.weather.areaStations || []) {
    if (st.id === S.index.station) add(st.id, st.label, obsDoc && obsDoc.metars);
    else add(st.id, st.label, ringList(st.id));
  }
  for (const id of [...ringDocs.keys()].sort()) {   // the rest of the ring
    add(id, RING_LABELS[id] || '', ringList(id));
  }
  for (const t of tafs) {   // TAF-only stations not otherwise listed
    const cfg = (SITE.weather.tafStations || []).find((s) => s.id === t.station);
    add(t.station, cfg ? cfg.label : RING_LABELS[t.station] || '');
  }
  if (!stations.some((s) => s.list.length || s.tafs.length)) { card.hidden = true; return; }
  card.hidden = false;
  const withObs = stations.filter((s) => s.list.length);
  $('stn-summary').textContent =
    `${withObs.length} station${withObs.length === 1 ? '' : 's'} reporting · ` +
    `${withObs.reduce((n, s) => n + s.list.length, 0)} METARs · ` +
    `${tafs.length} TAF issuance${tafs.length === 1 ? '' : 's'}`;
  $('stn-list').innerHTML = stations.map(stationHtml).join('');
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
   TAF vs METAR — the hour-by-hour category the TAF in force called for,
   against the category observed. Base conditions only (FM, with BECMG
   folded in once it starts); TEMPO and PROB groups are not the forecast's
   claim about the hour. An hour with no METAR within 45 min is not judged.
--------------------------------------------------------------------------- */

function visSMfromM(m) {
  if (m == null) return null;
  if (m >= 9000) return 7;
  for (const [mm, sm] of VIS_TABLE) if (Math.abs(m - mm) <= 100) return sm.includes('/') ? eval(sm.replace(' ', '+')) : +sm;
  return m / 1609.34;
}

function tafCatAt(tafs, station, t) {
  const iss = tafs.filter((x) => x.station === station && x.t <= t && t - x.t < 30 * 3600)
    .sort((a, b) => b.t - a.t)[0];
  if (!iss) return null;
  const ps = tafPeriods(iss);
  if (!ps) return null;
  let base = null;
  for (const p of ps) if (p.ind === 'FM' && p.b <= t && t < p.e) base = { visM: p.visM, cld: p.cld || [] };
  if (!base) return null;
  for (const p of ps) {
    if (p.ind === 'BECMG' && p.e != null && p.e <= t) {
      if (p.visM != null) base.visM = p.visM;
      if (p.cld && p.cld.length) base.cld = p.cld;
    }
  }
  let ceil = null;
  for (const c of base.cld) {
    if ((c.amt === 'BKN' || c.amt === 'OVC' || c.amt === 'VV') && c.ft != null && (ceil == null || c.ft < ceil)) ceil = c.ft;
  }
  const vis = visSMfromM(base.visM);
  return { cat: catOf(vis, ceil), vis, ceil, iss };
}

function renderTafVerify(date, tafDoc, obsDoc, ringDocs) {
  const card = $('tafv-card');
  const tafs = (tafDoc && tafDoc.tafs) || [];
  if (!tafs.length) { card.hidden = true; return; }
  const t0 = midnight(date);
  const rows = [];
  for (const st of (SITE.weather.tafStations || []).map((s) => s.id)) {
    if (!tafs.some((x) => x.station === st)) continue;
    const doc = st === S.index.station ? obsDoc : ringDocs.get(st);
    const metars = ((doc && doc.metars) || []).map((m) => ({ t: m[0], o: parseMetar(m[1]) }));
    if (!metars.length) continue;
    let hits = 0, judged = 0, worst = null;
    const cells = [];
    for (let h = 0; h < 24; h++) {
      const ts = t0 + h * 3600;
      const f = tafCatAt(tafs, st, ts);
      const hit = nearest(metars.map((m) => [m.t, m]), ts + 1800, 2700);
      const ob = hit && hit[1];
      let title = `${String(h).padStart(2, '0')}:00`;
      if (f) title += ` · TAF ${CAT[f.cat].name}${f.ceil != null ? ` ceil ${f.ceil.toLocaleString()}` : ''}${f.vis != null && f.vis < 7 ? ` vis ${+f.vis.toFixed(1)} SM` : ''}`;
      else title += ' · no TAF in force';
      if (ob) title += ` · METAR ${CAT[ob.o.cat].name}${ob.o.ceilFt != null ? ` ceil ${ob.o.ceilFt.toLocaleString()}` : ''}`;
      else title += ' · not judged';
      let miss = false;
      if (f && ob) {
        judged++;
        if (f.cat === ob.o.cat) hits++;
        else {
          miss = true;
          const d = Math.abs(f.cat - ob.o.cat);
          if (!worst || d > worst.d) worst = { d, h, f: f.cat, o: ob.o.cat };
        }
      }
      cells.push(`<span class="tv-cell${miss ? ' miss' : ''}" title="${esc(title)}">` +
        `<i style="background:${f ? CAT[f.cat].color : 'transparent'}"></i>` +
        `<i style="background:${ob ? CAT[ob.o.cat].color : 'transparent'}"></i></span>`);
    }
    if (!judged) continue;
    rows.push(`<div class="tv-row"><span class="who">${esc(st)}</span><div class="tv-cells">${cells.join('')}</div>` +
      `<span class="tv-score">${hits}/${judged}${worst ? ` · worst ${String(worst.h).padStart(2, '0')}:00 called ${CAT[worst.f].name}, saw ${CAT[worst.o].name}` : ''}</span></div>`);
  }
  if (!rows.length) { card.hidden = true; return; }
  card.hidden = false;
  $('tafv-sub').textContent = 'top: TAF in force · bottom: METAR · hits/judged';
  $('tafv-body').innerHTML = rows.join('') +
    `<div class="tv-hours">${Array.from({ length: 24 }, (_, h) => `<span>${h % 3 === 0 ? String(h).padStart(2, '0') : ''}</span>`).join('')}</div>`;
}

/* ---------------------------------------------------------------------------
   Radar — the day's NEXRAD composite from IEM's time-enabled WMS (any
   5-minute step since 1995), so no radar is archived here at all. Frames
   are plain <img>s over a dark ground with the field and every station
   placed by lat/lon; EPSG:4326 makes that a linear map.
--------------------------------------------------------------------------- */

const RADAR = { bbox: [-78.5, 37.5, -74.5, 40.5], w: 256, h: 192 };

function radarUrl(t, w, h) {
  const iso = new Date(Math.round(t / 300) * 300 * 1000).toISOString().slice(0, 16) + ':00Z';
  return 'https://mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/n0q-t.cgi?SERVICE=WMS&VERSION=1.1.1' +
    `&REQUEST=GetMap&LAYERS=nexrad-n0q-wmst&STYLES=&SRS=EPSG:4326&BBOX=${RADAR.bbox.join(',')}` +
    `&WIDTH=${w}&HEIGHT=${h}&FORMAT=image/png&TRANSPARENT=true&TIME=${iso}`;
}

function radarDots(ids) {
  const [x0, y0, x1, y1] = RADAR.bbox;
  const coords = SITE.weather.stationCoords || {};
  const dot = (id, cls) => {
    const c = coords[id];
    if (!c) return '';
    const left = (c[1] - x0) / (x1 - x0) * 100, top = (y1 - c[0]) / (y1 - y0) * 100;
    return `<i class="dot${cls ? ' ' + cls : ''}" style="left:${left.toFixed(1)}%;top:${top.toFixed(1)}%" title="${esc(id)}"><b>${esc(id)}</b></i>`;
  };
  return ids.map((id) => dot(id)).join('') + dot(SITE.airport.id, 'field');
}

function radarFrame(t, label, ids, w, h, big) {
  const now = Date.now() / 1000;
  const future = t > now - 300;
  return `<div class="rf${big ? ' big' : ''}" data-t="${t}">` +
    (future ? '' : `<img alt="" data-src="${esc(radarUrl(t, w, h))}" width="${w}" height="${h}">`) +
    radarDots(ids) + `<span class="lbl">${esc(label)}</span>` +
    (future ? '<span class="none">not yet</span>' : '') + '</div>';
}

function radarLoad(root) {
  for (const img of root.querySelectorAll('img[data-src]')) {
    img.onerror = () => { img.replaceWith(el('span', 'none', 'no radar')); };
    img.src = img.dataset.src;
    img.removeAttribute('data-src');
  }
}

function renderRadar(date, ringDocs, obsDoc, fieldDoc) {
  const card = $('radar-card');
  const t0 = midnight(date);
  if (t0 > Date.now() / 1000) { card.hidden = true; return; }
  card.hidden = false;
  const ids = [...ringDocs.keys()];
  if (obsDoc && obsDoc.station) ids.push(obsDoc.station);
  if (fieldDoc && fieldDoc.station) ids.push(fieldDoc.station);
  $('radar-sub').textContent = 'IEM NEXRAD composite · every 2 h · slider steps 30 min';
  const strip = $('radar-strip');
  strip.innerHTML = Array.from({ length: 12 }, (_, i) => radarFrame(t0 + i * 7200, hhmm(t0 + i * 7200), ids, RADAR.w, RADAR.h)).join('');
  const scrub = $('radar-scrub');
  const big = $('radar-big');
  const draw = () => {
    const t = t0 + (+scrub.value) * 1800;
    big.innerHTML = radarFrame(t, hhmm(t), ids, RADAR.w * 2, RADAR.h * 2, true);
    if (!card.hidden && (card._seen || isNear(card))) radarLoad(big);
  };
  const isNear = (c) => { const r = c.getBoundingClientRect(); return r.top < innerHeight + 400 && r.bottom > -400; };
  const now = Date.now() / 1000;
  scrub.value = String(Math.max(0, Math.min(47, Math.floor((Math.min(now, t0 + 86399) - t0) / 1800) - (now < t0 + 86400 ? 1 : 24))));
  if (now >= t0 + 86400) scrub.value = '24';
  scrub.oninput = draw;
  draw();
  /* frames load when the card scrolls into view, not on day select */
  if (card._io) card._io.disconnect();
  card._seen = false;
  const show = () => {
    card._seen = true;
    radarLoad(strip); radarLoad(big);
    if (card._io) { card._io.disconnect(); card._io = null; }
  };
  if (isNear(card) || !window.IntersectionObserver) { show(); return; }
  card._io = new IntersectionObserver((ents) => { if (ents.some((e) => e.isIntersecting)) show(); }, { rootMargin: '400px' });
  card._io.observe(card);
}

/* ---------------------------------------------------------------------------
   PIREPs — the day's reports, from the pirep stream.
--------------------------------------------------------------------------- */

function fromField(lat, lon) {
  const R = 3440.065, rad = (d) => d * Math.PI / 180;
  const p1 = rad(SITE.airport.lat), p2 = rad(lat), dl = rad(lon - SITE.airport.lon);
  const a = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return { nm: 2 * R * Math.asin(Math.sqrt(a)), brg: (Math.atan2(y, x) * 180 / Math.PI + 360) % 360 };
}
/* Raw text only. The /TB /IC /SK decode came out 2026-09-02: pilots,
   controllers and the relaying systems drop the format often enough that a
   decoded line was wrong or empty as often as it was right, and the raw
   report is what a pilot reads anyway. Time and distance/bearing come from
   the report's own stamped position, not from parsing the text. */
function renderPireps(date, doc) {
  const card = $('pirep-card');
  const list = ((doc && doc.pireps) || []).slice();
  if (!list.length) { card.hidden = true; return; }
  card.hidden = false;
  const urgent = (p) => /urgent|UUA/i.test(p.type || '');
  list.sort((a, b) => (urgent(b) - urgent(a)) || (b.t - a.t));
  const nUrgent = list.filter(urgent).length;
  $('pirep-sub').textContent = 'within ~150 nm · time · nm / °true from KANP · raw text';
  $('pirep-summary').textContent = `${list.length} report${list.length === 1 ? '' : 's'}` +
    (nUrgent ? ` · ${nUrgent} urgent` : '');
  $('pirep-list').innerHTML = list.map((p) => {
    const loc = (p.lat != null && p.lon != null) ? fromField(p.lat, p.lon) : null;
    return `<div class="pr-row${urgent(p) ? ' urgent' : ''}">` +
      `<span class="pr-age">${hhmm(p.t)}</span>` +
      `<span class="pr-loc">${loc ? `${Math.round(loc.nm)} nm ${String(Math.round(loc.brg)).padStart(3, '0')}°` : '—'}</span>` +
      `<code>${esc((p.raw || '').trim())}</code></div>`;
  }).join('');
}

/* ---------------------------------------------------------------------------
   AIRMETs · SIGMETs · TFRs — what was in effect that day (first/last seen).
--------------------------------------------------------------------------- */

function renderAirsig(date, airsigDoc, tfrDoc) {
  const card = $('airsig-card');
  const items = (airsigDoc && airsigDoc.items) || [];
  const tfrs = (tfrDoc && tfrDoc.tfrs) || [];
  if (!items.length && !tfrs.length) { card.hidden = true; return; }
  card.hidden = false;
  const win = (it) => (it.from && it.to && it.to > it.from ? `${hhmm(it.from)}–${hhmm(it.to)}` : it.from ? `valid ${hhmm(it.from)}` : '');
  const seen = (it) => (it.first && it.last ? `seen ${hhmm(it.first)}–${hhmm(it.last)}` : '');
  const galt = (it) => [it.base != null ? `base ${it.base}` : null, it.top != null ? `top ${it.top}` : null,
    it.fzl ? `FZL ${it.fzl[0] != null ? it.fzl[0] : '?'}–${it.fzl[1] != null ? it.fzl[1] : '?'}` : null].filter(Boolean).join(' · ');
  const salt = (it) => [it.lo != null ? `${it.lo.toLocaleString()} ft` : null, it.hi != null ? `to ${it.hi.toLocaleString()} ft` : null].filter(Boolean).join(' ');
  const groups = [];
  for (const prod of ['SIERRA', 'TANGO', 'ZULU']) {
    const rows = items.filter((it) => it.kind === 'G-AIRMET' && it.product === prod);
    if (!rows.length) continue;
    groups.push(`<div class="as-grp"><span class="as-h">${prod}</span>` +
      rows.map((it) => `<div class="as-row"><b>${esc(it.hazard || '')}</b> ${esc(win(it))}` +
        `${galt(it) ? ` · ${esc(galt(it))}` : ''}${it.due ? ` <span class="d">${esc(it.due)}</span>` : ''}` +
        ` <span class="d">${esc(seen(it))}</span></div>`).join('') + '</div>');
  }
  const sigs = items.filter((it) => it.kind !== 'G-AIRMET');
  if (sigs.length) {
    groups.push(`<div class="as-grp"><span class="as-h">SIGMET · AIRMET</span>` +
      sigs.map((it) => `<details class="as-row"><summary><b>${esc(it.kind)} ${esc(it.hazard || '')}</b> ${esc(win(it))}` +
        `${salt(it) ? ` · ${esc(salt(it))}` : ''} <span class="d">${esc(seen(it))}</span></summary>` +
        `<pre class="product">${esc(it.raw || '')}</pre></details>`).join('') + '</div>');
  }
  if (tfrs.length) {
    const standing = (r) => r.state === 'USA';
    const tf = tfrs.slice().sort((a, b) => (standing(a) - standing(b)) || String(a.id).localeCompare(String(b.id)));
    groups.push(`<div class="as-grp"><span class="as-h">TFR</span>` +
      tf.map((r) => `<div class="as-row"><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.id)}</a> ` +
        `<b>${esc(r.type || 'TFR')}</b> · ${esc(r.desc || '')}${standing(r) ? ' <span class="d">· standing</span>' : ''}</div>`).join('') + '</div>');
  }
  $('airsig-sub').textContent = `${items.length} AIRMET/SIGMET item${items.length === 1 ? '' : 's'} · ${tfrs.length} TFR${tfrs.length === 1 ? '' : 's'} · as seen by the hourly archiver`;
  $('airsig-list').innerHTML = groups.join('');
}

/* ---------------------------------------------------------------------------
   Sounding — the nearest radiosonde (KIAD), 12Z and 00Z, with the numbers a
   pilot reads off it. Parcel math is the textbook approximation (Bolton
   LCL, pseudo-adiabat integrated in 2 hPa steps, no virtual-temperature
   correction) and is labelled approx.
--------------------------------------------------------------------------- */

const RD = 287.05, CPD = 1005.7, LV = 2.501e6, EPS = 0.622, G0 = 9.80665;
const esatHpa = (TK) => 6.112 * Math.exp(17.67 * (TK - 273.15) / (TK - 29.65));
const mixRatio = (p, TK) => EPS * esatHpa(TK) / Math.max(1, p - esatHpa(TK));
const lclK = (TK, TdK) => 1 / (1 / (TdK - 56) + Math.log(TK / TdK) / 800) + 56;

/* parcel temperature (K) at any pressure, lifted from (p0, T0, Td0) */
function parcelFn(p0, T0, Td0) {
  const Tl = lclK(T0, Td0), pl = p0 * Math.pow(Tl / T0, CPD / RD);
  const path = [[pl, Tl]];
  let T = Tl, p = pl;
  while (p > 100) {
    const rs = mixRatio(p, T);
    const dTdp = (RD * T + LV * rs) / (CPD + LV * LV * rs * EPS / (RD * T * T)) / p;
    const dp = Math.min(2, p - 100);
    T -= dTdp * dp; p -= dp;
    path.push([p, T]);
  }
  return {
    pl, Tl,
    at(pp) {
      if (pp >= pl) return T0 * Math.pow(pp / p0, RD / CPD);
      for (let i = 1; i < path.length; i++) {
        if (path[i][0] <= pp) {
          const [pa, Ta] = path[i - 1], [pb, Tb] = path[i];
          return Ta + (Tb - Ta) * (pa - pp) / (pa - pb || 1);
        }
      }
      return path[path.length - 1][1];
    },
  };
}

function soundingStats(levels) {
  const L = levels.filter((l) => l[0] != null && l[1] != null && l[2] != null);
  if (L.length < 5) return null;
  const sfc = L[0];
  const out = { sfc };
  /* freezing level: first crossing below 0 °C */
  for (let i = 1; i < L.length; i++) {
    if (L[i - 1][2] > 0 && L[i][2] <= 0) {
      const f = L[i - 1][2] / (L[i - 1][2] - L[i][2]);
      out.frzFt = Math.round((L[i - 1][1] + f * (L[i][1] - L[i - 1][1])) * 3.28084);
      break;
    }
  }
  /* inversion in the lowest 5,000 ft */
  out.inversion = false;
  for (let i = 1; i < L.length && (L[i][1] - sfc[1]) < 1524; i++) if (L[i][2] > L[i - 1][2] + 0.3) out.inversion = true;
  /* parcel from the surface */
  if (sfc[3] != null) {
    const parcel = parcelFn(sfc[0], sfc[2] + 273.15, sfc[3] + 273.15);
    out.lclFt = null;
    for (let i = 1; i < L.length; i++) {
      if (L[i][0] <= parcel.pl) {
        const f = (L[i - 1][0] - parcel.pl) / (L[i - 1][0] - L[i][0] || 1);
        out.lclFt = Math.round((L[i - 1][1] + f * (L[i][1] - L[i - 1][1])) * 3.28084);
        break;
      }
    }
    let cape = 0, cin = 0, lfc = false;
    for (let i = 1; i < L.length; i++) {
      const p = (L[i - 1][0] + L[i][0]) / 2;
      if (p > parcel.pl || p < 100) continue;
      const Te = (L[i - 1][2] + L[i][2]) / 2 + 273.15;
      const Tp = parcel.at(p);
      const dz = L[i][1] - L[i - 1][1];
      const b = G0 * (Tp - Te) / Te * dz;
      if (b > 0) { cape += b; lfc = true; } else if (!lfc) cin += b;
    }
    out.cape = Math.round(cape); out.cin = Math.round(cin);
    const e500 = L.find((l) => l[0] <= 500);
    if (e500) out.li = +((e500[2] + 273.15 - parcel.at(500)).toFixed(1));
  }
  /* winds at the altitudes a pilot files, by u/v interpolation in height */
  out.winds = {};
  const W = L.filter((l) => l[4] != null && l[5] != null);
  for (const ft of [3000, 6000, 9000, 12000]) {
    const m = ft / 3.28084;
    for (let i = 1; i < W.length; i++) {
      if (W[i][1] >= m && W[i - 1][1] <= m) {
        const f = (m - W[i - 1][1]) / (W[i][1] - W[i - 1][1] || 1);
        const uv = (l) => [-l[5] * Math.sin(l[4] * Math.PI / 180), -l[5] * Math.cos(l[4] * Math.PI / 180)];
        const [ua, va] = uv(W[i - 1]), [ub, vb] = uv(W[i]);
        const u = ua + f * (ub - ua), v = va + f * (vb - va);
        const spd = Math.round(Math.hypot(u, v));
        const dir = Math.round((Math.atan2(-u, -v) * 180 / Math.PI + 360) % 360);
        out.winds[ft] = spd ? `${String(dir).padStart(3, '0')}/${spd}` : 'calm';
        break;
      }
    }
  }
  return out;
}

function drawSounding(ctx, W, H, levels) {
  const L = levels.filter((l) => l[1] != null && l[2] != null);
  const padL = 34, padR = 64, padT = 8, padB = 22;
  const topFt = 30000, tLo = -50, tHi = 40;
  const x = (tC) => padL + (tC - tLo) / (tHi - tLo) * (W - padL - padR);
  const y = (m) => padT + (1 - Math.min(topFt, m * 3.28084) / topFt) * (H - padT - padB);
  ctx.fillStyle = C.lane; ctx.fillRect(padL, padT, W - padL - padR, H - padT - padB);
  ctx.font = '10px system-ui, sans-serif'; ctx.fillStyle = C.dim; ctx.strokeStyle = C.grid;
  for (let ft = 0; ft <= topFt; ft += 5000) {
    ctx.beginPath(); ctx.moveTo(padL, y(ft / 3.28084)); ctx.lineTo(W - padR, y(ft / 3.28084)); ctx.stroke();
    ctx.textAlign = 'right'; ctx.fillText(ft ? `${ft / 1000}k` : 'sfc', padL - 4, y(ft / 3.28084) + 3);
  }
  for (let t = -40; t <= 40; t += 20) {
    ctx.beginPath(); ctx.moveTo(x(t), padT); ctx.lineTo(x(t), H - padB); ctx.stroke();
    ctx.textAlign = 'center'; ctx.fillText(`${t}°`, x(t), H - 8);
  }
  ctx.strokeStyle = rgba(C.vis, 0.5); ctx.beginPath(); ctx.moveTo(x(0), padT); ctx.lineTo(x(0), H - padB); ctx.stroke();
  const trace = (idx, color, width) => {
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.beginPath();
    let first = true;
    for (const l of L) {
      if (l[idx] == null || l[1] * 3.28084 > topFt) continue;
      const px = x(l[idx]), py = y(l[1]);
      if (first) { ctx.moveTo(px, py); first = false; } else ctx.lineTo(px, py);
    }
    ctx.stroke(); ctx.lineWidth = 1;
  };
  trace(3, C.dew, 1.5);
  trace(2, C.temp, 2);
  /* winds at the mandatory levels, on the right */
  ctx.fillStyle = C.muted; ctx.textAlign = 'left';
  for (const p of [925, 850, 700, 500, 400, 300]) {
    const l = L.find((z) => z[0] <= p + 0.5);
    if (!l || l[4] == null || l[1] * 3.28084 > topFt) continue;
    ctx.fillText(`${p} ${String(Math.round(l[4])).padStart(3, '0')}/${Math.round(l[5])}`, W - padR + 6, y(l[1]) + 3);
  }
  ctx.fillStyle = C.temp; ctx.textAlign = 'left'; ctx.fillText('temp', padL + 6, padT + 12);
  ctx.fillStyle = C.dew; ctx.fillText('dewpoint', padL + 40, padT + 12);
}

function renderRaob(date, raobDoc, modelDoc) {
  const card = $('raob-card');
  const snd = ((raobDoc && raobDoc.soundings) || []).slice();
  if (!snd.length) { card.hidden = true; return; }
  card.hidden = false;
  const station = raobDoc.station || S.index.raob_station || 'KIAD';
  const zHour = (t) => new Date(t * 1000).getUTCHours();
  snd.sort((a, b) => (zHour(a.t) === 12 ? -1 : 1) - (zHour(b.t) === 12 ? -1 : 1) || a.t - b.t);
  $('raob-sub').textContent = `${station} · ${snd.map((s) => `${String(zHour(s.t)).padStart(2, '0')}Z (${hhmm(s.t)})`).join(' · ')} · parcel numbers approx`;
  const wrap = $('raob-list');
  wrap.innerHTML = '';
  for (const s of snd) {
    const st = soundingStats(s.levels || []);
    const id = `raob-cv-${s.t}`;
    const head = st ? [`sfc ${st.sfc[2]}/${st.sfc[3] != null ? st.sfc[3] : '—'} °C`,
      st.frzFt != null ? `frz lvl ${st.frzFt.toLocaleString()} ft` : 'no freezing level below the top',
      st.cape != null ? `CAPE ≈ ${st.cape}` : null, st.li != null ? `LI ≈ ${st.li}` : null].filter(Boolean).join(' · ') : '';
    const d = el('details', 'iss',
      `<summary><span class="who">${String(zHour(s.t)).padStart(2, '0')}Z</span>launched ${hhmm(s.t)}` +
      `<span class="meta">${esc(head)}${s.bf ? ' · healed' : ''}</span></summary>` +
      `<div class="body"><canvas class="chart" id="${id}" height="260"></canvas><div class="snd-table"></div></div>`);
    const rows = [];
    if (st) {
      rows.push(['surface', `${st.sfc[2]} / ${st.sfc[3] != null ? st.sfc[3] : '—'} °C · ${st.sfc[4] != null ? `${String(Math.round(st.sfc[4])).padStart(3, '0')}/${Math.round(st.sfc[5])} kt` : ''}`]);
      rows.push(['freezing level', st.frzFt != null ? `${st.frzFt.toLocaleString()} ft` : 'above the top']);
      if (st.lclFt != null) rows.push(['LCL (approx)', `${st.lclFt.toLocaleString()} ft`]);
      if (st.cape != null) rows.push(['CAPE (approx, no Tv)', `${st.cape} J/kg · CIN ${st.cin}`]);
      if (st.li != null) rows.push(['lifted index (approx)', String(st.li)]);
      rows.push(['inversion, lowest 5,000 ft', st.inversion ? 'yes' : 'no']);
      for (const ft of [3000, 6000, 9000, 12000]) if (st.winds[ft]) rows.push([`wind ${(ft / 1000)}k ft`, st.winds[ft]]);
      /* the site's first observed check on the model stream */
      const snap = ((modelDoc && modelDoc.snaps) || []).find((m) => m.t0 <= s.t && s.t < m.t0 + m.n * 3600);
      if (snap && st.cape != null) {
        const i = Math.round((s.t - snap.t0) / 3600);
        const mc = (snap.cape || [])[i];
        if (mc != null) rows.push(['GFS CAPE at launch', `${mc} J/kg · sounding ≈ ${st.cape} · snap ${hhmm(snap.t)}`]);
      }
    }
    d.querySelector('.snd-table').innerHTML = rows.map(([k, v]) => `<span class="k">${esc(k)}</span><span>${esc(v)}</span>`).join('');
    d.addEventListener('toggle', () => {
      if (!d.open || d.dataset.drawn) return;
      d.dataset.drawn = '1';
      chart(id, (ctx, W, H) => drawSounding(ctx, W, H, s.levels || []), 260);
    });
    wrap.appendChild(d);
  }
  if (wrap.firstChild) { wrap.firstChild.open = true; }
}

/* ---------------------------------------------------------------------------
   Model vs observed — one line under the morning grid: what the GFS point
   said would fall and fire, against what KDCA measured and reported.
--------------------------------------------------------------------------- */

function renderModelVsObs(date, modelDoc, obsDoc) {
  const line = $('mvo-line');
  const ms = modelDoc && modelDoc.snaps && modelDoc.snaps[0];
  const metars = (obsDoc && obsDoc.metars) || [];
  if (!ms || !metars.length) { line.hidden = true; return; }
  const t0 = midnight(date), t1 = t0 + 86400;
  let pr = 0, peak = null;
  for (let i = 0; i < ms.n; i++) {
    const t = ms.t0 + i * 3600;
    if (t < t0 || t >= t1) continue;
    pr += ms.pr[i] || 0;
    if (ms.cape[i] != null && (peak == null || ms.cape[i] > peak)) peak = ms.cape[i];
  }
  let mm = 0, rainObs = 0, ts = false;
  for (const [t, raw] of metars) {
    if (t < t0 || t >= t1) continue;
    const o = parseMetar(raw);
    if (o.precIn) mm += o.precIn * 25.4;
    if (o.rain) rainObs++;
    if (o.ts) ts = true;
  }
  const station = obsDoc.station || S.index.station;
  line.hidden = false;
  line.textContent = `Model vs ${station} · GFS ${pr.toFixed(1)} mm, ${station} measured ${mm.toFixed(1)} mm` +
    `, rain in ${rainObs} ob${rainObs === 1 ? '' : 's'} · GFS peak CAPE ${peak == null ? '—' : peak} J/kg` +
    `, thunder ${ts ? 'reported' : 'not reported'} at ${station}`;
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

/* `height` is optional: a number (or a function, evaluated per render) for
   charts like the meteogram whose height depends on what's being plotted. */
function chart(id, draw, height) {
  const cv = $(id);
  const render = () => {
    const cssW = cv.clientWidth || cv.parentElement.clientWidth;
    const cssH = typeof height === 'function' ? height()
      : height != null ? height : +cv.getAttribute('height');
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(cssW * dpr);
    cv.height = Math.round(cssH * dpr);
    cv.style.height = `${cssH}px`;
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cv._w = cssW;
    draw(ctx, cssW, cssH);
  };
  S.charts.set(id, render);
  render();

  /* A window resize isn't the only thing that changes a chart's width: a
     scrollbar appearing (which the tall meteogram can cause all by itself)
     resizes the layout box with no resize event, leaving the backing store
     scaled and soft. Watch the element instead. */
  if (!cv._ro && window.ResizeObserver) {
    cv._ro = new ResizeObserver(() => {
      if (Math.abs(cv.clientWidth - cv._w) < 1) return;
      const fn = S.charts.get(id);
      if (fn) fn();
    });
    cv._ro.observe(cv);
  }
}

boot();
