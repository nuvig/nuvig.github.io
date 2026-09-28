/* Storm Log — every precipitation event in the site's weather archive, as it
   happened. Reads only data/storms.json, which scripts/build_storms.py
   compiles from data/wx/ at the end of every hourly archive run; nothing
   here calls a weather API.

   Layout: the season strip (one bar per archived day, events shaded, the
   biggest labelled) → stat tiles → one card per event. A card is the
   event's numbers, an hour-by-hour hyetograph (KDCA and KNAK side by side),
   and, folded: wind / pressure / ceiling lanes, every gauge in the ring,
   what LWX called for before it began and every WHAT HAS CHANGED paragraph
   it issued while it rained, and the NWS alerts in effect.

   Chart rules (same as almanac.js): one scale per lane, never two on one
   plot; a missing hour is drawn as missing, never as zero; every number a
   visitor sees is a measurement or says what it is instead. */

'use strict';

const TZ = SITE.weather.timeZone;
const C = {
  rec: '#3987e5', recDim: 'rgba(57,135,229,0.16)',
  fld: '#d95926',
  ts: '#e0a020', sn: '#cfd8e3',
  grid: '#242424', axis: '#333', text: '#777', ink: '#c8c8c8', miss: '#1f1f1f',
};
const STATE = { sort: 'newest', type: 'all', open: new Set() };
let D = null;
const drawers = [];   // canvas re-draw closures, run on resize

/* ---------- formatting ---------- */
const partsOf = (t, opt) => {
  const p = {};
  new Intl.DateTimeFormat('en-US', { timeZone: TZ, ...opt }).formatToParts(new Date(t * 1000))
    .forEach((x) => { p[x.type] = x.value; });
  return p;
};
const localHour = (t) => +partsOf(t, { hour: 'numeric', hourCycle: 'h23' }).hour;
const dayKey = (t) => {
  const p = partsOf(t, { year: 'numeric', month: '2-digit', day: '2-digit' });
  return `${p.year}-${p.month}-${p.day}`;
};
const fmtDay = (t) => {
  const p = partsOf(t, { weekday: 'short', month: 'short', day: 'numeric' });
  return `${p.weekday} ${p.month} ${p.day}`;
};
const fmtMD = (t) => {
  const p = partsOf(t, { month: 'short', day: 'numeric' });
  return `${p.month} ${p.day}`;
};
const fmtClock = (t) => {
  const p = partsOf(t, { hour: 'numeric', minute: '2-digit' });
  return `${p.hour}:${p.minute} ${p.dayPeriod}`;
};
const fmtHour = (t) => {
  const p = partsOf(t, { hour: 'numeric' });
  return `${p.hour} ${p.dayPeriod}`;
};
const fmtDT = (t) => `${fmtDay(t).slice(0, 3)} ${fmtHour(t)}`;
const fmtDTfull = (t) => `${fmtDay(t)} ${fmtClock(t)}`;
const fmtRange = (a, b) => {
  const pa = partsOf(a, { month: 'short', day: 'numeric' });
  const pb = partsOf(b, { month: 'short', day: 'numeric' });
  if (pa.month === pb.month && pa.day === pb.day) return `${pa.month} ${pa.day}`;
  if (pa.month === pb.month) return `${pa.month} ${pa.day}–${pb.day}`;
  return `${pa.month} ${pa.day} – ${pb.month} ${pb.day}`;
};
const dateLabel = (ymd) => {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d, 17) / 1000;   // noon local, any DST
  return fmtMD(t);
};
const dur = (h) => (h >= 48 ? `${Math.floor(h / 24)} d ${h % 24} h` : `${h} h`);
const inches = (v) => (v == null ? '—' : `${v.toFixed(2)} in`);
const DIRS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const dirName = (d) => (d == null ? '' : DIRS[Math.round(d / 22.5) % 16]);
const ago = (s) => (s < 90 ? 'just now' : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 172800 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ftK = (ft) => (ft >= 10000 ? `${(ft / 1000).toFixed(0)}k` : ft >= 1000 ? `${(ft / 1000).toFixed(1).replace(/\.0$/, '')}k` : `${ft}`);
const visSM = (v) => {
  if (v == null) return '—';
  if (v >= 7) return '10+ SM';
  const fr = { 0.25: '¼', 0.5: '½', 0.75: '¾', 1.25: '1¼', 1.5: '1½', 1.75: '1¾', 2.5: '2½' };
  return `${fr[v] || (Math.round(v * 100) / 100)} SM`;
};

/* nice tick step for a max value, searched over the 1/2/5 ladder so the
   lane gets 2–4 gridlines rather than one */
function tickStep(max, want) {
  const ladder = [];
  for (let e = -2; e <= 4; e++) for (const m of [1, 2, 5]) ladder.push(m * 10 ** e);
  let best = ladder[0];
  for (const s of ladder) {
    const n = Math.floor(max / s);
    if (n >= want[0] && n <= want[1]) return s;
    if (n > want[1]) best = s;
  }
  return best;
}

/* ---------- canvas helpers ---------- */
function setup(cv, h) {
  const w = cv.clientWidth || cv.parentElement.clientWidth || 600;
  const dpr = window.devicePixelRatio || 1;
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  cv.style.height = `${h}px`;
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.font = '11px system-ui, -apple-system, Segoe UI, sans-serif';
  return { ctx, w, h };
}

function tooltip(host) {
  let el = host.querySelector('.tip');
  if (!el) { el = document.createElement('div'); el.className = 'tip'; host.appendChild(el); }
  return el;
}

function placeTip(tip, host, x, y, html) {
  tip.innerHTML = html; tip.style.display = 'block';
  const hw = host.clientWidth, tw = tip.offsetWidth;
  tip.style.left = `${Math.max(0, Math.min(hw - tw, x + 12 > hw - tw ? x - tw - 12 : x + 12))}px`;
  tip.style.top = `${Math.max(0, y - 8)}px`;
}

/* ---------- page ---------- */
async function load() {
  try {
    const r = await fetch('data/storms.json', { headers: { Accept: 'application/json' } });
    D = r.ok ? await r.json() : null;
  } catch (e) { D = null; }
  if (!D || !D.events) {
    document.getElementById('stats').textContent = 'storms.json not found — run scripts/build_storms.py';
    return;
  }
  readHash();
  renderStats();
  renderSeason();
  renderTiles();
  renderEvents();
  window.addEventListener('hashchange', () => { readHash(); renderEvents(); });
  let rt = null;
  new ResizeObserver(() => { clearTimeout(rt); rt = setTimeout(() => drawers.forEach((f) => f()), 80); })
    .observe(document.getElementById('events'));
}

function readHash() {
  const h = location.hash.slice(1);
  const m = new URLSearchParams(h.replace(/^#/, ''));
  const sort = m.get('sort');
  if (sort && ['newest', 'wettest', 'longest', 'windiest'].includes(sort)) STATE.sort = sort;
  const type = m.get('type');
  if (type && ['all', 'thunder', 'snow', 'wind'].includes(type)) STATE.type = type;
  const e = m.get('e');
  if (e) STATE.open.add(e);
}

function writeHash() {
  const p = [];
  if (STATE.sort !== 'newest') p.push(`sort=${STATE.sort}`);
  if (STATE.type !== 'all') p.push(`type=${STATE.type}`);
  history.replaceState(null, '', p.length ? `#${p.join('&')}` : location.pathname);
}

function renderStats() {
  const rec = D.record, fld = D.field;
  const sum = (i) => D.days.reduce((s, d) => s + (d[i] || 0), 0);
  const upd = D.archive_updated ? ago(Date.now() / 1000 - D.archive_updated) : '—';
  const live = D.events.find((e) => e.live);
  document.getElementById('stats').innerHTML =
    `<b>${D.events.length}</b> events · ${dateLabel(D.first)} – ${dateLabel(D.last)} · ` +
    `${rec} <b>${sum(1).toFixed(2)} in</b> · ${fld} <b>${sum(2).toFixed(2)} in</b> · archive ${esc(upd)}` +
    (live ? ` · <b class="live">event in progress</b>` : '') +
    ` · <a href="/almanac.html">almanac</a>`;
}

/* ---------- the season strip ---------- */
function renderSeason() {
  const cv = document.getElementById('season-cv');
  const host = cv.parentElement;
  const tip = tooltip(host);
  const days = D.days;
  const byDay = new Map(days.map((d, i) => [d[0], i]));
  const evOfDay = new Map();
  D.events.forEach((e) => {
    for (let t = e.start; t <= e.end; t += 3600) evOfDay.set(dayKey(t), e);
  });
  const labelled = D.events.filter((e) => e.rank <= 6);
  let geom = null;

  function draw() {
    const H = 190;
    const { ctx, w } = setup(cv, H);
    const L = 34, R = 10, T = 28, B = 22;
    const pw = w - L - R, ph = H - T - B;
    const n = days.length;
    const slot = pw / n;
    const max = Math.max(0.5, ...days.map((d) => Math.max(d[1] || 0, d[2] || 0)));
    const step = tickStep(max, [2, 4]);
    const ymax = Math.ceil(max / step) * step;
    const y = (v) => T + ph - (v / ymax) * ph;
    geom = { L, T, slot, ph, n, x: (i) => L + i * slot };

    // event bands, under everything
    D.events.forEach((e) => {
      const a = byDay.get(dayKey(e.start)), b = byDay.get(dayKey(e.end));
      if (a == null || b == null) return;
      ctx.fillStyle = e.rank <= 6 ? 'rgba(57,135,229,0.20)' : 'rgba(57,135,229,0.09)';
      ctx.fillRect(L + a * slot, T, (b - a + 1) * slot, ph);
    });
    // grid
    ctx.strokeStyle = C.grid; ctx.lineWidth = 1; ctx.fillStyle = C.text; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (let v = 0; v <= ymax + 1e-9; v += step) {
      const yy = Math.round(y(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(L, yy); ctx.lineTo(w - R, yy); ctx.stroke();
      ctx.fillText(v.toFixed(step < 1 ? 1 : 0), L - 6, yy);
    }
    // months
    ctx.textBaseline = 'top'; ctx.textAlign = 'left';
    let lastM = '';
    days.forEach((d, i) => {
      const m = d[0].slice(0, 7);
      if (m !== lastM) {
        lastM = m;
        const xx = Math.round(L + i * slot) + 0.5;
        ctx.strokeStyle = C.axis; ctx.beginPath(); ctx.moveTo(xx, T); ctx.lineTo(xx, T + ph + 4); ctx.stroke();
        ctx.fillStyle = C.text;
        ctx.fillText(new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7) - 1, 15)).toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }), xx + 4, T + ph + 7);
      }
    });
    // bars
    const bw = Math.max(1, slot - (slot > 4 ? 1.5 : 0.5));
    days.forEach((d, i) => {
      const x0 = L + i * slot + (slot - bw) / 2;
      const v = d[1];
      if (v == null) {
        ctx.fillStyle = C.miss; ctx.fillRect(x0, T, bw, ph);
        return;
      }
      if (v > 0) {
        const top = Math.min(y(v), T + ph - 2);
        ctx.fillStyle = C.rec; ctx.fillRect(x0, top, bw, T + ph - top);
      }
      const fl = d[4] || 0;
      if (fl & 1) { ctx.fillStyle = C.ts; ctx.beginPath(); ctx.arc(x0 + bw / 2, (v > 0 ? y(v) : T + ph) - 5, 2, 0, Math.PI * 2); ctx.fill(); }
      if (fl & 6) { ctx.fillStyle = C.sn; ctx.beginPath(); ctx.arc(x0 + bw / 2, (v > 0 ? y(v) : T + ph) - 5, 2, 0, Math.PI * 2); ctx.fill(); }
    });
    // baseline, then a grey underline on days with 6+ windy hours
    ctx.strokeStyle = C.axis; ctx.beginPath(); ctx.moveTo(L, T + ph + 0.5); ctx.lineTo(w - R, T + ph + 0.5); ctx.stroke();
    ctx.fillStyle = '#3a3a3a';
    days.forEach((d, i) => { if ((d[6] || 0) >= 6) ctx.fillRect(L + i * slot, T + ph + 2, slot + 0.5, 3); });
    // labels on the biggest events
    ctx.textBaseline = 'alphabetic'; ctx.font = '11px system-ui, -apple-system, Segoe UI, sans-serif';
    const used = [];
    labelled.forEach((e) => {
      const a = byDay.get(dayKey(e.start)), b = byDay.get(dayKey(e.end));
      if (a == null || b == null) return;
      let peak = 0;
      for (let i = a; i <= b; i++) peak = Math.max(peak, days[i][1] || 0);
      const cx = L + ((a + b + 1) / 2) * slot;
      const txt = pw < 640 ? `#${e.rank}` : `#${e.rank} ${e.driver}`;
      const tw = ctx.measureText(txt).width;
      let lx = Math.max(L, Math.min(w - R - tw, cx - tw / 2));
      let ly = y(peak) - 8;
      // keep labels from overlapping each other
      for (const u of used) if (Math.abs(u.x - lx) < (u.w + tw) / 2 + 6 && Math.abs(u.y - ly) < 12) ly = u.y - 12;
      used.push({ x: lx, y: ly, w: tw });
      ctx.fillStyle = C.ink; ctx.textAlign = 'left'; ctx.fillText(txt, lx, ly);
    });
  }
  drawers.push(draw);
  draw();

  cv.addEventListener('mousemove', (ev) => {
    if (!geom) return;
    const r = cv.getBoundingClientRect();
    const i = Math.floor((ev.clientX - r.left - geom.L) / geom.slot);
    if (i < 0 || i >= geom.n) { tip.style.display = 'none'; return; }
    const d = days[i];
    const e = evOfDay.get(d[0]);
    const fl = d[4] || 0;
    const rows = [`<b>${fmtDay(Date.UTC(+d[0].slice(0, 4), +d[0].slice(5, 7) - 1, +d[0].slice(8, 10), 17) / 1000)}</b>`,
      `${D.record} ${inches(d[1])}${d[5] ? ` <span class="d">· ${d[5]} h missing</span>` : ''}`,
      `${D.field} ${inches(d[2])}`,
      d[3] != null ? `ring max ${inches(d[3])}` : '',
      d[6] ? `windy ${d[6]} h` : '',
      fl & 1 ? 'thunder' : '', fl & 2 ? 'snow' : '', fl & 4 ? 'freezing' : '',
      e ? `<span class="d">event #${e.rank} · ${esc(e.driver)}</span>` : ''];
    placeTip(tip, host, ev.clientX - r.left, ev.clientY - r.top, rows.filter(Boolean).join('<br>'));
    cv.style.cursor = e ? 'pointer' : 'default';
  });
  cv.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
  cv.addEventListener('click', (ev) => {
    if (!geom) return;
    const r = cv.getBoundingClientRect();
    const i = Math.floor((ev.clientX - r.left - geom.L) / geom.slot);
    const d = days[i]; if (!d) return;
    const e = evOfDay.get(d[0]);
    if (e) openEvent(e.id);
  });
}

function renderTiles() {
  const rec = D.record, fld = D.field;
  const top = D.events.slice().sort((a, b) => a.rank - b.rank)[0];
  const wetDay = D.days.slice().sort((a, b) => (b[1] || 0) - (a[1] || 0))[0];
  const tsDays = D.days.filter((d) => (d[4] || 0) & 1).length;
  const longest = D.events.slice().sort((a, b) => b.hours - a.hours)[0];
  const windiest = D.events.slice().sort((a, b) => peakGust(b) - peakGust(a))[0];
  // longest dry spell: consecutive days with nothing measured at either gauge
  let run = 0, best = { n: 0, end: null }, prev = null;
  D.days.forEach((d) => {
    const dry = (d[1] || 0) === 0 && (d[2] || 0) === 0 && (d[1] != null || d[2] != null);
    if (dry) { run++; if (run > best.n) best = { n: run, end: d[0], start: prevStart(d[0], run) }; } else run = 0;
    prev = d;
  });
  function prevStart(ymd, n) {
    const [y, m, dd] = ymd.split('-').map(Number);
    return dayKey(Date.UTC(y, m - 1, dd, 17) / 1000 - (n - 1) * 86400);
  }
  const tiles = [
    top && ['wettest event', inches(top.totals[rec]), `<a href="#e=${top.id}" data-open="${top.id}">${fmtRange(top.start, top.end)}</a> · ${esc(top.driver)}`],
    wetDay && ['wettest day', inches(wetDay[1]), `${dateLabel(wetDay[0])} · ${rec}`],
    longest && ['longest event', dur(longest.hours), `<a href="#e=${longest.id}" data-open="${longest.id}">${fmtRange(longest.start, longest.end)}</a>`],
    windiest && ['windiest event', `G ${peakGust(windiest)} kt`, `<a href="#e=${windiest.id}" data-open="${windiest.id}">${fmtRange(windiest.start, windiest.end)}</a> · ${esc(windiest.driver)}`],
    ['thunder days', `${tsDays}`, `${rec} or ${fld} reported TS`],
    best.n && ['longest dry spell', `${best.n} d`, `${dateLabel(best.start)} – ${dateLabel(best.end)}`],
  ].filter(Boolean);
  document.getElementById('tiles').innerHTML = tiles.map(([k, v, s]) =>
    `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`).join('');
}

/* ---------- events ---------- */
function sorted() {
  let list = D.events.slice();
  if (STATE.type === 'thunder') list = list.filter((e) => e.types.includes('thunder'));
  if (STATE.type === 'snow') list = list.filter((e) => e.types.includes('snow') || e.types.includes('ice'));
  if (STATE.type === 'wind') list = list.filter((e) => e.types.includes('wind'));
  if (STATE.sort === 'wettest') list.sort((a, b) => a.rank - b.rank);
  else if (STATE.sort === 'longest') list.sort((a, b) => b.hours - a.hours || a.rank - b.rank);
  else if (STATE.sort === 'windiest') list.sort((a, b) => peakGust(b) - peakGust(a) || a.rank - b.rank);
  return list;
}

const peakGust = (e) => Math.max((e.wind.record && e.wind.record.gust) || 0, (e.wind.field && e.wind.field.gust) || 0);

function renderChips() {
  const el = document.getElementById('chips');
  const nTs = D.events.filter((e) => e.types.includes('thunder')).length;
  const nSn = D.events.filter((e) => e.types.includes('snow') || e.types.includes('ice')).length;
  const nWd = D.events.filter((e) => e.types.includes('wind')).length;
  el.innerHTML =
    `<span class="lbl">sort</span>` +
    ['newest', 'wettest', 'longest', 'windiest'].map((s) => `<button class="chip${STATE.sort === s ? ' on' : ''}" data-sort="${s}">${s}</button>`).join('') +
    `<span class="lbl">show</span>` +
    `<button class="chip${STATE.type === 'all' ? ' on' : ''}" data-type="all">all ${D.events.length}</button>` +
    `<button class="chip${STATE.type === 'thunder' ? ' on' : ''}" data-type="thunder">thunder ${nTs}</button>` +
    `<button class="chip${STATE.type === 'snow' ? ' on' : ''}" data-type="snow">snow · ice ${nSn}</button>` +
    (nWd ? `<button class="chip${STATE.type === 'wind' ? ' on' : ''}" data-type="wind">wind only ${nWd}</button>` : '');
  el.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.sort) STATE.sort = b.dataset.sort;
    if (b.dataset.type) STATE.type = b.dataset.type;
    writeHash(); renderEvents();
  }));
}

function renderEvents() {
  renderChips();
  const host = document.getElementById('events');
  drawers.length = 1;   // keep the season strip's drawer
  host.innerHTML = '';
  const list = sorted();
  if (!list.length) { host.innerHTML = '<p class="none">nothing of that kind archived</p>'; return; }
  list.forEach((e) => host.appendChild(eventCard(e)));
  const want = [...STATE.open].find((id) => list.some((e) => e.id === id));
  if (want) {
    const card = host.querySelector(`[data-id="${want}"]`);
    if (card) card.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
}

function openEvent(id) {
  STATE.open.add(id);
  const card = document.querySelector(`[data-id="${id}"]`);
  if (!card) { STATE.type = 'all'; writeHash(); renderEvents(); return; }
  const det = card.querySelector('details');
  if (det && !det.open) { det.open = true; drawDetails(card, D.events.find((e) => e.id === id)); }
  card.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

function typeChips(e) {
  return e.types.filter((t) => t !== 'rain').map((t) => `<span class="ty ${t}">${t}</span>`).join('');
}

function eventCard(e) {
  const rec = D.record, fld = D.field;
  const card = document.createElement('section');
  card.className = 'card ev' + (e.live ? ' live' : '');
  card.dataset.id = e.id;
  const tr = e.totals[rec], tf = e.totals[fld];
  const since = e.since ? `wettest since ${dateLabel(e.since)}` : 'wettest in the archive';
  const w = e.wind.record, wf = e.wind.field;
  const facts = [];
  const R = D.rules || {};
  const windyDef = `sustained ≥ ${R.windy_sust_kt || 15} kt or gust ≥ ${R.windy_gust_kt || 18} kt at ${rec} or ${fld}`;
  if (e.rain && (e.rain[0] > e.start || e.rain[1] < e.end)) facts.push(['rain', `${e.wet_hours} h <span class="d">${fmtDT(e.rain[0])} → ${fmtDT(e.rain[1] + 3600)}</span>`]);
  else if (e.rain) facts.push(['rain', `${e.wet_hours} h`]);
  if (e.windy_hours) facts.push(['<span title="' + windyDef + '">wind</span>', `${e.windy_hours} h <span class="d">≥ ${R.windy_sust_kt || 15} kt / G${R.windy_gust_kt || 18}</span>`]);
  if (e.peak) facts.push(['peak hour', `${inches(e.peak.p)} <span class="d">${fmtDT(e.peak.t)}</span>`]);
  if (w && w.gust) facts.push([`${rec} wind`, `${dirName(w.dir)} ${w.spd || '—'} G ${w.gust} kt <span class="d">${fmtDT(w.gust_t)}</span>`]);
  if (wf && wf.gust) facts.push([`${fld} wind`, `${dirName(wf.dir)} ${wf.spd || '—'} G ${wf.gust} kt`]);
  if (e.pres) facts.push(['pressure', `${e.pres.min.toFixed(1)} – ${e.pres.max.toFixed(1)} mb <span class="d">low ${fmtDT(e.pres.min_t)}</span>`]);
  const lr = e.low.record;
  if (lr && lr.ceil != null) facts.push([`${rec} ceiling`, `${lr.ceil.toLocaleString()} ft <span class="d">${fmtDT(lr.ceil_t)}</span>`]);
  if (lr && lr.vis != null) facts.push([`${rec} visibility`, `${visSM(lr.vis)} <span class="d">${fmtDT(lr.vis_t)}</span>`]);
  const lf = e.low.field;
  if (lf && lf.ceil != null) facts.push([`${fld} ceiling`, `${lf.ceil.toLocaleString()} ft`]);
  if (e.wx.ts) facts.push(['thunder', `${e.wx.ts} obs`]);
  if (e.wx.sn) facts.push(['snow · ice', `${e.wx.sn} obs`]);
  if (e.wx.fz) facts.push(['freezing', `${e.wx.fz} obs`]);
  if (e.wx.hvy) facts.push(['heavy', `${e.wx.hvy} obs`]);
  if (e.cape != null && e.cape >= 100) facts.push(['GFS CAPE', `${e.cape.toLocaleString()} J/kg`]);
  const missR = e.missing[rec], missF = e.missing[fld];
  const cover = [];
  if (missR) cover.push(`${rec} ${missR} h missing`);
  if (missF) cover.push(`${fld} ${missF} h missing`);
  if (e.filled && e.filled[rec]) cover.push(`${rec} ${e.filled[rec]} h from the 6-hourly group`);

  card.innerHTML = `
    <div class="ev-head">
      <span class="rank" title="rank by ${rec} total, over every event in the archive">#${e.rank}</span>
      <h2>${fmtRange(e.start, e.end)}</h2>
      <span class="driver" title="the feature LWX's discussions named most while it rained">${esc(e.driver)}</span>
      ${typeChips(e)}
      ${e.live ? '<span class="ty live">in progress</span>' : ''}
      <span class="span">${dur(e.hours)} · ${fmtDT(e.start)} → ${e.live ? 'now' : fmtDT(e.end + 3600)}</span>
    </div>
    <div class="hero">
      <div class="big"><span class="n">${tr == null ? '—' : tr.toFixed(2)}</span><span class="u">in</span><span class="who">${rec}</span></div>
      <div class="mid"><span class="n">${tf == null ? '—' : tf.toFixed(2)}</span><span class="u">in</span><span class="who">${fld}</span></div>
      <div class="since">${since}</div>
    </div>
    <div class="chart hyeto"><canvas></canvas>
      <div class="legend"><i style="background:${C.rec}"></i>${rec}<i style="background:${C.fld}"></i>${fld}<i class="dot" style="background:${C.ts}"></i>thunder<i style="background:#3a3a3a;height:4px"></i><span title="${windyDef}">windy hour</span><i class="miss"></i>no ob</div>
    </div>
    <dl class="facts">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>
    ${cover.length ? `<p class="cover">${cover.join(' · ')}</p>` : ''}
    <details ${STATE.open.has(e.id) ? 'open' : ''}>
      <summary>wind · pressure · ceiling · every gauge · what LWX said</summary>
      <div class="det"></div>
    </details>`;

  const det = card.querySelector('details');
  det.addEventListener('toggle', () => {
    if (det.open) { STATE.open.add(e.id); drawDetails(card, e); } else STATE.open.delete(e.id);
  });
  const drawH = () => drawHyeto(card.querySelector('.hyeto'), e);
  drawers.push(drawH);
  requestAnimationFrame(drawH);
  if (det.open) requestAnimationFrame(() => drawDetails(card, e));
  return card;
}

/* x-axis for an hourly series: a tick each 6 h, the day name at midnight */
function hourAxis(ctx, ser, L, T, ph, slot, w) {
  ctx.strokeStyle = C.grid; ctx.fillStyle = C.text; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  ctx.font = '10.5px system-ui, -apple-system, Segoe UI, sans-serif';
  const every = slot < 9 ? 12 : 6;
  for (let i = 0; i < ser.n; i++) {
    const t = ser.t0 + i * 3600;
    const lh = localHour(t);
    if (lh % every !== 0) continue;
    const x = Math.round(L + i * slot) + 0.5;
    ctx.strokeStyle = lh === 0 ? C.axis : C.grid;
    ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, T + ph + 3); ctx.stroke();
    const lab = lh === 0 ? fmtDay(t).slice(0, 3) : lh === 12 ? '12p' : lh < 12 ? `${lh}a` : `${lh - 12}p`;
    ctx.fillStyle = lh === 0 ? C.ink : C.text;
    ctx.fillText(lab, x, T + ph + 6);
  }
}

function drawHyeto(host, e) {
  const cv = host.querySelector('canvas');
  const ser = e.series;
  const H = 150;
  const { ctx, w } = setup(cv, H);
  const L = 34, R = 8, T = 22, B = 20;
  const pw = w - L - R, ph = H - T - B;
  const slot = pw / ser.n;
  const max = Math.max(0.05, ...ser.p.map((v) => v || 0), ...ser.pf.map((v) => v || 0));
  const step = tickStep(max, [2, 4]);
  const ymax = Math.ceil(max / step + 1e-9) * step;
  const y = (v) => T + ph - (v / ymax) * ph;

  // missing hours first, under the grid
  for (let i = 0; i < ser.n; i++) {
    if (ser.p[i] == null && ser.pf[i] == null) { ctx.fillStyle = C.miss; ctx.fillRect(L + i * slot, T, slot, ph); }
  }
  ctx.lineWidth = 1; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  ctx.font = '10.5px system-ui, -apple-system, Segoe UI, sans-serif';
  for (let v = 0; v <= ymax + 1e-9; v += step) {
    const yy = Math.round(y(v)) + 0.5;
    ctx.strokeStyle = C.grid; ctx.beginPath(); ctx.moveTo(L, yy); ctx.lineTo(w - R, yy); ctx.stroke();
    ctx.fillStyle = C.text; ctx.fillText(v.toFixed(2).replace(/^0/, ''), L - 5, yy);
  }
  hourAxis(ctx, ser, L, T, ph, slot, w);
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.fillStyle = C.text;
  ctx.fillText('wind', L - 5, T - 10);

  const gap = slot > 6 ? 1 : 0;
  const bw = Math.max(1, (slot - gap * 3) / 2);
  const bar = (x, v, col) => {
    if (v == null || v <= 0) return;
    const top = Math.min(y(v), T + ph - 2);
    ctx.fillStyle = col;
    ctx.fillRect(x, top, bw, T + ph - top);
  };
  for (let i = 0; i < ser.n; i++) {
    const x0 = L + i * slot + gap;
    bar(x0, ser.p[i], C.rec);
    bar(x0 + bw + gap, ser.pf[i], C.fld);
    if (ser.wd && ser.wd[i]) { ctx.fillStyle = '#3a3a3a'; ctx.fillRect(L + i * slot, T - 12, slot + 0.5, 4); }
    if (ser.ts[i]) {
      ctx.fillStyle = C.ts;
      const cx = L + i * slot + slot / 2;
      ctx.beginPath(); ctx.moveTo(cx - 3, T + 2); ctx.lineTo(cx + 3, T + 2); ctx.lineTo(cx, T + 8); ctx.closePath(); ctx.fill();
    }
  }
  ctx.strokeStyle = C.axis; ctx.beginPath(); ctx.moveTo(L, T + ph + 0.5); ctx.lineTo(w - R, T + ph + 0.5); ctx.stroke();

  // hover
  const tip = tooltip(host);
  if (!host._hover) {
    host._hover = true;
    cv.addEventListener('mousemove', (ev) => {
      const r = cv.getBoundingClientRect();
      const cw = cv.clientWidth, s2 = (cw - L - R) / ser.n;
      const i = Math.floor((ev.clientX - r.left - L) / s2);
      if (i < 0 || i >= ser.n) { tip.style.display = 'none'; host.querySelector('.xh')?.remove(); return; }
      let xh = host.querySelector('.xh');
      if (!xh) { xh = document.createElement('div'); xh.className = 'xh'; host.appendChild(xh); }
      xh.style.left = `${L + (i + 0.5) * s2}px`; xh.style.top = `${T}px`; xh.style.height = `${H - T - B}px`;
      const t = ser.t0 + i * 3600;
      const rows = [`<b>${fmtDay(t)} · hour ending ${fmtHour(t + 3600)}</b>`,
        `${D.record} ${ser.p[i] == null ? 'no ob' : inches(ser.p[i])}`,
        `${D.field} ${ser.pf[i] == null ? 'no ob' : inches(ser.pf[i])}`,
        ser.pa[i] != null && ser.pa[i] > 0 ? `ring max ${inches(ser.pa[i])} <span class="d">${ser.pas[i]}</span>` : '',
        ser.s[i] != null ? `wind ${dirName(ser.d[i])} ${ser.s[i]}${ser.g[i] ? ` G ${ser.g[i]}` : ''} kt` : '',
        ser.slp[i] != null ? `${ser.slp[i].toFixed(1)} mb` : '',
        ser.c[i] != null ? `ceiling ${ser.c[i].toLocaleString()} ft` : '',
        ser.wd && ser.wd[i] ? '<span class="d">windy hour</span>' : '',
        ser.wx[i] ? `<span class="d">${esc(ser.wx[i])}</span>` : ''];
      placeTip(tip, host, ev.clientX - r.left, ev.clientY - r.top, rows.filter(Boolean).join('<br>'));
    });
    cv.addEventListener('mouseleave', () => { tip.style.display = 'none'; host.querySelector('.xh')?.remove(); });
  }
}

/* wind / pressure / ceiling — three lanes, one scale each */
function drawLanes(host, e) {
  const cv = host.querySelector('canvas');
  const ser = e.series;
  const lanes = [
    { key: 'wind', label: 'wind kt', h: 80 },
    { key: 'pres', label: 'pressure mb', h: 70 },
    { key: 'ceil', label: 'ceiling ft', h: 70 },
  ];
  const L = 40, R = 8, T = 14, B = 20, GAP = 18;
  const H = T + lanes.reduce((s, l) => s + l.h, 0) + GAP * (lanes.length - 1) + B;
  const { ctx, w } = setup(cv, H);
  const pw = w - L - R, slot = pw / ser.n;
  ctx.font = '10.5px system-ui, -apple-system, Segoe UI, sans-serif';
  let top = T;
  const geo = {};
  for (const ln of lanes) {
    geo[ln.key] = { top, h: ln.h };
    ctx.strokeStyle = C.axis; ctx.beginPath(); ctx.moveTo(L, top + ln.h + 0.5); ctx.lineTo(w - R, top + ln.h + 0.5); ctx.stroke();
    top += ln.h + GAP;
  }
  const xc = (i) => L + (i + 0.5) * slot;

  // wind: gust as faint bars, sustained as a line, direction ticks along the top
  {
    const g = geo.wind, vals = ser.s.map((v, i) => Math.max(v || 0, ser.g[i] || 0));
    const max = Math.max(10, ...vals);
    const step = tickStep(max, [2, 4]);
    const ymax = Math.ceil(max / step) * step;
    const y = (v) => g.top + g.h - (v / ymax) * g.h;
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (let v = step; v <= ymax + 1e-9; v += step) {
      const yy = Math.round(y(v)) + 0.5;
      ctx.strokeStyle = C.grid; ctx.beginPath(); ctx.moveTo(L, yy); ctx.lineTo(w - R, yy); ctx.stroke();
      ctx.fillStyle = C.text; ctx.fillText(`${v}`, L - 5, yy);
    }
    const bw = Math.max(1, slot - (slot > 4 ? 1.5 : 0.5));
    for (let i = 0; i < ser.n; i++) {
      if (ser.g[i]) { ctx.fillStyle = C.recDim; ctx.fillRect(L + i * slot + (slot - bw) / 2, y(ser.g[i]), bw, g.top + g.h - y(ser.g[i])); }
    }
    ctx.strokeStyle = C.rec; ctx.lineWidth = 2; ctx.lineJoin = 'round';
    let pen = false;
    ctx.beginPath();
    for (let i = 0; i < ser.n; i++) {
      if (ser.s[i] == null) { pen = false; continue; }
      if (!pen) { ctx.moveTo(xc(i), y(ser.s[i])); pen = true; } else ctx.lineTo(xc(i), y(ser.s[i]));
    }
    ctx.stroke(); ctx.lineWidth = 1;
    // direction arrows: a short shaft pointing where the wind blows to
    const ev = slot < 8 ? Math.ceil(8 / slot) : 1;
    ctx.strokeStyle = C.ink;
    for (let i = 0; i < ser.n; i += ev) {
      if (ser.d[i] == null || !ser.s[i]) continue;
      const a = (ser.d[i] + 180) * Math.PI / 180, cx = xc(i), cy = g.top + 8, r = 5;
      const dx = Math.sin(a) * r, dy = -Math.cos(a) * r;
      ctx.beginPath(); ctx.moveTo(cx - dx, cy - dy); ctx.lineTo(cx + dx, cy + dy); ctx.stroke();
      ctx.beginPath(); ctx.arc(cx + dx, cy + dy, 1.5, 0, Math.PI * 2); ctx.fillStyle = C.ink; ctx.fill();
    }
  }
  // pressure
  {
    const g = geo.pres, vals = ser.slp.filter((v) => v != null);
    if (vals.length) {
      const lo = Math.floor(Math.min(...vals) - 1), hi = Math.ceil(Math.max(...vals) + 1);
      const step = tickStep(hi - lo, [2, 4]);
      const y = (v) => g.top + g.h - ((v - lo) / (hi - lo)) * g.h;
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) {
        const yy = Math.round(y(v)) + 0.5;
        ctx.strokeStyle = C.grid; ctx.beginPath(); ctx.moveTo(L, yy); ctx.lineTo(w - R, yy); ctx.stroke();
        ctx.fillStyle = C.text; ctx.fillText(`${v}`, L - 5, yy);
      }
      ctx.strokeStyle = C.rec; ctx.lineWidth = 2;
      let pen = false; ctx.beginPath();
      for (let i = 0; i < ser.n; i++) {
        if (ser.slp[i] == null) { pen = false; continue; }
        if (!pen) { ctx.moveTo(xc(i), y(ser.slp[i])); pen = true; } else ctx.lineTo(xc(i), y(ser.slp[i]));
      }
      ctx.stroke(); ctx.lineWidth = 1;
    } else {
      ctx.fillStyle = C.text; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText('no SLP reported', L + 6, g.top + g.h / 2);
    }
  }
  // ceiling: log scale, category edges as ticks, a rail along the top for clear
  {
    const g = geo.ceil;
    const lo = 200, hi = 12000;
    const y = (ft) => g.top + g.h - (Math.log(Math.max(lo, Math.min(hi, ft)) / lo) / Math.log(hi / lo)) * g.h;
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (const ft of [500, 1000, 3000, 10000]) {
      const yy = Math.round(y(ft)) + 0.5;
      ctx.strokeStyle = C.grid; ctx.beginPath(); ctx.moveTo(L, yy); ctx.lineTo(w - R, yy); ctx.stroke();
      ctx.fillStyle = C.text; ctx.fillText(ftK(ft), L - 5, yy);
    }
    ctx.strokeStyle = C.rec; ctx.lineWidth = 2;
    let pen = false; ctx.beginPath();
    for (let i = 0; i < ser.n; i++) {
      const c = ser.c[i];
      const has = ser.s[i] != null || ser.c[i] != null || ser.wx[i];   // an hour filled from the 6-hourly group has no ob
      if (!has) { pen = false; continue; }
      const yy = c == null ? g.top + 1 : y(c);
      const x0 = L + i * slot, x1 = x0 + slot;
      if (!pen) { ctx.moveTo(x0, yy); pen = true; } else ctx.lineTo(x0, yy);
      ctx.lineTo(x1, yy);
    }
    ctx.stroke(); ctx.lineWidth = 1;
    ctx.fillStyle = C.text; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText('clear', L + 4, g.top + 3);
  }
  hourAxis(ctx, ser, L, geo.ceil.top, geo.ceil.h, slot, w);
  // lane labels last, knocked out of whatever they sit on
  ctx.font = '10.5px system-ui, -apple-system, Segoe UI, sans-serif';
  for (const ln of lanes) {
    const g = geo[ln.key];
    ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    ctx.fillStyle = '#1a1a1a'; ctx.fillRect(L - 2, g.top - 13, ctx.measureText(ln.label).width + 6, 13);
    ctx.fillStyle = C.text; ctx.fillText(ln.label, L + 1, g.top - 1);
  }

  const tip = tooltip(host);
  if (!host._hover) {
    host._hover = true;
    cv.addEventListener('mousemove', (ev) => {
      const r = cv.getBoundingClientRect();
      const s2 = (cv.clientWidth - L - R) / ser.n;
      const i = Math.floor((ev.clientX - r.left - L) / s2);
      if (i < 0 || i >= ser.n) { tip.style.display = 'none'; return; }
      const t = ser.t0 + i * 3600;
      const rows = [`<b>${fmtDay(t)} ${fmtHour(t)}</b>`,
        ser.s[i] != null ? `${dirName(ser.d[i])} ${ser.d[i] != null ? `${ser.d[i]}° ` : ''}${ser.s[i]}${ser.g[i] ? ` G ${ser.g[i]}` : ''} kt` : 'wind —',
        ser.slp[i] != null ? `${ser.slp[i].toFixed(1)} mb` : '',
        ser.c[i] != null ? `ceiling ${ser.c[i].toLocaleString()} ft` : 'no ceiling',
        ser.v[i] != null ? `vis ${visSM(ser.v[i])}` : ''];
      placeTip(tip, host, ev.clientX - r.left, ev.clientY - r.top, rows.filter(Boolean).join('<br>'));
    });
    cv.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
  }
}

function drawDetails(card, e) {
  const det = card.querySelector('.det');
  if (!det.dataset.built) {
    det.dataset.built = '1';
    const rec = D.record, fld = D.field;
    const gauge = new Map(D.stations.map((s) => [s.id, s.gauge]));
    const ids = D.stations.map((s) => s.id);
    const max = Math.max(0.01, ...ids.map((id) => e.totals[id] || 0));
    const rows = ids.map((id) => {
      const v = e.totals[id];
      const miss = e.missing[id] || 0;
      const trace = e.trace.includes(id);
      let val, bar = 0;
      if (!gauge.get(id)) val = '<span class="d">no gauge</span>';
      else if (v == null) val = '<span class="d">no obs</span>';
      else { val = trace && v === 0 ? 'trace' : inches(v); bar = v / max; }
      const note = gauge.get(id) && v != null && miss ? `<span class="d">${miss} h missing</span>` : '';
      return `<div class="st"><span class="id">${id}</span><span class="bar"><i style="width:${(bar * 100).toFixed(1)}%"></i></span><span class="val">${val}</span>${note}</div>`;
    });
    const log = e.log.map((l) => `<div class="lg"><span class="t">${fmtDay(l.t)} ${fmtClock(l.t)}</span><span class="tx">${esc(l.text)}</span></div>`).join('');
    const exp = e.expected ? `<div class="lg exp"><span class="t">${fmtDay(e.expected.t)} ${fmtClock(e.expected.t)} · called for</span><span class="tx">${e.expected.key.map(esc).join('<br>')}</span></div>` : '';
    const alerts = e.alerts.length ? e.alerts.map((a) => `<span class="al" title="${esc(fmtDTfull(a.first))} → ${esc(fmtDTfull(a.last))}">${esc(a.event)}</span>`).join('') : '<span class="d">none archived at the DC point</span>';
    const days = [];
    for (let t = e.start; t <= e.end; t += 3600) { const k = dayKey(t); if (!days.includes(k)) days.push(k); }
    det.innerHTML = `
      <div class="chart lanes"><canvas></canvas>
        <div class="legend"><i style="background:${C.rec};height:2px;width:14px;vertical-align:2px"></i>${rec} sustained<i style="background:${C.recDim}"></i>gust<span>↗ blowing toward</span><i style="background:${C.miss}"></i>no ob</div>
      </div>
      <div class="grid2">
        <div>
          <h3>gauges <span class="sub">${e.hours} h · P-groups summed</span></h3>
          <div class="stations">${rows.join('')}</div>
          <h3>alerts <span class="sub">NWS · DC point</span></h3>
          <div class="alerts">${alerts}</div>
          <h3>almanac</h3>
          <div class="days">${days.map((d) => `<a href="/almanac.html#d=${d}">${dateLabel(d)}</a>`).join(' · ')}</div>
        </div>
        <div>
          <h3>LWX <span class="sub">forecast discussion · what has changed</span></h3>
          <div class="log">${exp}${log || '<span class="d">no issuance archived in the window</span>'}</div>
        </div>
      </div>`;
    const drawL = () => drawLanes(det.querySelector('.lanes'), e);
    det._draw = drawL;
    drawers.push(drawL);
  }
  requestAnimationFrame(det._draw);
}

document.addEventListener('click', (ev) => {
  const a = ev.target.closest('[data-open]');
  if (a) { ev.preventDefault(); openEvent(a.dataset.open); }
});

window.STORMS_DEBUG = { get data() { return D; }, state: STATE };
load();
