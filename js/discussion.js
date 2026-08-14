/* DC Forecast Discussion — discussion.html
   ---------------------------------------------------------------------------
   Data sources (all fetched from the visitor's browser, all CORS-friendly):
     - api.weather.gov products API — Area Forecast Discussion issuances from
       LWX (Baltimore MD / Washington DC): latest text + recent history for
       the change log. aviationweather.gov is never fetched (no CORS).
     - api.weather.gov points/forecast — daily periods for downtown DC, used
       by the "forecast drift" tracker (snapshots kept in localStorage).
     - api.open-meteo.com — a 12×10 grid of GFS points over the Mid-Atlantic
       (MSLP, 2 m / 850 hPa temperature, dewpoint, 10 m wind) that drives the
       synoptic canvas: air-mass fill, isobars, H/L centers, frontal zones
       (850 hPa temperature-gradient ridges signed by thermal advection) and
       the animated wind-flow particles.
   All directions °true. Times displayed in SITE.weather.timeZone. */

'use strict';

const NWS = 'https://api.weather.gov';
const OFFICE = 'LWX';                       // Baltimore/Washington forecast office
const DC = { lat: 38.8894, lon: -77.0352 }; // downtown DC (drift tracker point)
const TZ = SITE.weather.timeZone;
const ARCHIVE = SITE.weather.archiveBase || null;   // scripts/wxarchive.py output (data/wx/)
const LOG_DEPTH = 6;        // AFD issuances to load for the change log
const CHECK_MS = 10 * 60 * 1000;

const $ = (id) => document.getElementById(id);

/* ------------------------------ tiny utils ------------------------------ */

async function fetchJSON(url) {
  const res = await fetch(url, { headers: { Accept: 'application/ld+json, application/geo+json, application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url.split('?')[0]}`);
  return res.json();
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtTime(d, opts) {
  return new Intl.DateTimeFormat('en-US', Object.assign({ timeZone: TZ }, opts)).format(d);
}
function fmtIssued(d) {
  return fmtTime(d, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
}
function timeAgo(d) {
  const m = Math.round((Date.now() - d.getTime()) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = m / 60;
  if (h < 36) return `${h < 10 ? h.toFixed(1).replace(/\.0$/, '') : Math.round(h)} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

function setStatus(cls, text) {
  $('status-dot').className = `dot ${cls}`;
  $('status-text').textContent = text;
}

/* ===========================================================================
   AFD — fetch, parse, render
   =========================================================================== */

const AFD = { list: [], texts: new Map(), parsed: new Map(), newestId: null };

/* Site-side weather archive (wxarchive GitHub Action → data/wx/ in this
   repo): every AFD ever archived, forecast snapshots, METARs — shared
   across devices, unlike localStorage. Everything here is optional: 404s
   or an empty index just mean the live-API/localStorage fallbacks apply. */
const ARC = { index: null, todayFc: null };

async function loadArchive() {
  if (!ARCHIVE) return;
  try {
    ARC.index = await fetchJSON(`${ARCHIVE}/index.json`);
  } catch (e) { return; }
  try {
    const today = localDay(Date.now());
    if ((ARC.index.forecast_days || []).includes(today)) {
      ARC.todayFc = await fetchJSON(`${ARCHIVE}/forecast/${today}.json`);
    }
  } catch (e) { /* index without today's snapshot — fine */ }
}

/* Extend the live product list with archived issuances the NWS API no
   longer serves (it only keeps a few days). Same-minute entries dedupe. */
function mergeArchivedAfds(list) {
  if (!ARC.index || !Array.isArray(ARC.index.afd)) return list;
  const have = new Set(list.map((i) => Math.round(new Date(i.issuanceTime).getTime() / 60000)));
  const merged = list.slice();
  for (const a of ARC.index.afd) {
    const min = Math.round(a.t / 60);
    if (have.has(min)) continue;
    have.add(min);
    merged.push({
      id: 'arc:' + a.p,
      '@id': `${ARCHIVE}/${a.p}`,
      issuanceTime: new Date(a.t * 1000).toISOString(),
    });
  }
  merged.sort((x, y) => new Date(y.issuanceTime) - new Date(x.issuanceTime));
  return merged;
}

async function afdList() {
  const data = await fetchJSON(`${NWS}/products/types/AFD/locations/${OFFICE}`);
  const items = (data['@graph'] || []).filter((p) => p.issuanceTime && p['@id']);
  items.sort((a, b) => new Date(b.issuanceTime) - new Date(a.issuanceTime));
  return items;
}

async function afdText(item) {
  if (AFD.texts.has(item.id)) return AFD.texts.get(item.id);
  const p = await fetchJSON(item['@id']);
  AFD.texts.set(item.id, p.productText || '');
  return p.productText || '';
}

/* Parse a raw AFD into ordered sections. Section headers look like
   ".NEAR TERM /THROUGH TONIGHT/..." at the start of a line; a section runs
   until "&&", the next header, or "$$". */
function parseAfd(text) {
  const lines = String(text).replace(/\r/g, '').split('\n');
  const secs = [];
  let cur = null;
  for (const line of lines) {
    if (/^\$\$/.test(line)) { cur = null; break; }
    const m = line.match(/^\.([A-Z][A-Z0-9 /&.,'()-]*?)\.\.\.\s*(.*)$/);
    if (m) {
      cur = { name: m[1].trim(), body: m[2] ? m[2] + '\n' : '' };
      secs.push(cur);
      continue;
    }
    if (/^&&\s*$/.test(line)) { cur = null; continue; }
    if (cur) cur.body += line + '\n';
  }
  for (const s of secs) s.body = s.body.replace(/\n{3,}/g, '\n\n').trim();
  return secs.filter((s) => s.body.length > 0);
}

function prettySection(name) {
  if (/WATCHES/.test(name)) return { title: 'Watches, warnings & advisories', qual: '' };
  const m = name.match(/^(.*?)\s*\/(.*?)\/?\s*$/);
  const main = (m ? m[1] : name).trim();
  const qual = m ? m[2].trim().toLowerCase() : '';
  const title = main.charAt(0) + main.slice(1).toLowerCase();
  return { title, qual };
}

/* Plain-English tooltips for forecast-discussion jargon. */
const GLOSSARY = [
  ['CAA', 'cold air advection — colder air being carried in on the wind'],
  ['WAA', 'warm air advection — warmer air being carried in on the wind'],
  ['PoPs?', 'probability of precipitation'],
  ['QPF', 'quantitative precipitation forecast — how much rain/snow falls'],
  ['PWATs?', 'precipitable water — total moisture in the air column'],
  ['LLJ', 'low-level jet — a ribbon of fast wind a few thousand feet up'],
  ['MCS', 'mesoscale convective system — an organized cluster of thunderstorms'],
  ['CAMs?', 'convection-allowing models — high-resolution models (HRRR class) that simulate individual storms'],
  ['CAPE', 'convective available potential energy — fuel for thunderstorm updrafts'],
  ['CIN', 'convective inhibition — a lid that holds storms back until it erodes'],
  ['H5', 'the 500 hPa level, ~18,000 ft — the steering level for weather systems'],
  ['H85?', 'the 850 hPa level, ~5,000 ft — where fronts and low-level moisture show up best'],
  ['H7', 'the 700 hPa level, ~10,000 ft'],
  ['vort max', 'vorticity maximum — a pocket of spin aloft that promotes rising air ahead of it'],
  ['shortwave', 'a small, fast-moving upper-level disturbance that can trigger rain or storms'],
  ['ridging', 'building high pressure aloft — sinking air, quieter weather'],
  ['ridge axis', 'the centerline of an area of high pressure aloft'],
  ['troughing', 'a dip of low pressure aloft — rising air, unsettled weather'],
  ['isentropic (?:lift|ascent|upglide)', 'air gliding up over a denser air mass along surfaces of constant temperature — a gentle, widespread lift'],
  ['theta-e', 'equivalent potential temperature — a combined measure of heat and moisture; high theta-e air is storm fuel'],
  ['backdoor (?:cold )?front', 'a cold front that sneaks in from the northeast off the Atlantic, against the usual west-to-east flow'],
  ['Bermuda [Hh]igh', 'the subtropical Atlantic high — its west side pumps warm, humid southerly air into the Mid-Atlantic'],
  ['outflow boundar(?:y|ies)', 'a miniature cold front made by rain-cooled air spreading out from a thunderstorm'],
  ['(?:deep[- ]layer |bulk )shear', 'change of wind with height — the ingredient that organizes storms and makes them last'],
  ['subsidence', 'broadly sinking air, which dries the column and suppresses clouds'],
  ['diurnal(?:ly)?', 'tied to the daily heating cycle — peaking in the afternoon, fading at night'],
  ['dry slot', 'a tongue of dry air wrapping into a storm system that shuts precipitation off'],
  ['deterministic', 'a single model run (as opposed to an ensemble of many runs)'],
  ['ensemble', 'many model runs with slightly different starting points — spread shows forecast confidence'],
  ['guidance', 'model output — what the computer models suggest'],
  ['MVFR', 'marginal VFR — ceilings 1,000–3,000 ft and/or visibility 3–5 miles'],
  ['LIFR', 'low IFR — ceilings below 500 ft and/or visibility under 1 mile'],
  ['IFR', 'instrument flight rules conditions — ceilings 500–1,000 ft and/or visibility 1–3 miles'],
  ['VFR', 'visual flight rules conditions — ceilings above 3,000 ft and visibility over 5 miles'],
];
const GLOSS_RE = new RegExp(`\\b(${GLOSSARY.map((g) => g[0]).join('|')})\\b`, 'g');
const GLOSS_DEFS = GLOSSARY.map((g) => [new RegExp(`^(?:${g[0]})$`), g[1]]);

function glossify(escaped) {
  return escaped.replace(GLOSS_RE, (m) => {
    const def = GLOSS_DEFS.find(([re]) => re.test(m));
    return def ? `<span class="gloss" title="${esc(def[1])}">${m}</span>` : m;
  });
}

/* AFD bodies are hard-wrapped at ~70 columns: join single newlines back into
   sentences but keep bullet lines ("- " / "* ") on their own lines. */
function renderBody(body) {
  const paras = body.split(/\n\s*\n/);
  return paras.map((p) => {
    const lines = p.split('\n');
    let out = '';
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      if (/^[-*•]\s/.test(t)) out += (out ? '<br>' : '') + esc(t);
      else out += (out ? ' ' : '') + esc(t);
    }
    return `<p>${glossify(out)}</p>`;
  }).join('');
}

/* AVIATION is open by default too: it is the section written for pilots —
   ceilings, visibility and timing by field — and it answers most go/no-go
   questions without hunting through the rest. */
const OPEN_BY_DEFAULT = /^(SYNOPSIS|UPDATE|KEY MESSAGES|NEAR TERM|AVIATION)/;

function renderDiscussion(item, secs) {
  const issued = new Date(item.issuanceTime);
  $('afd-issued').innerHTML =
    `Issued <b style="color:#9aa">${esc(fmtIssued(issued))}</b> (${esc(timeAgo(issued))}).`;
  const host = $('afd-sections');
  host.innerHTML = '';
  for (const s of secs) {
    const { title, qual } = prettySection(s.name);
    const d = document.createElement('details');
    d.className = 'afd-sec';
    if (OPEN_BY_DEFAULT.test(s.name)) d.open = true;
    d.innerHTML =
      `<summary><span class="sec-name">${esc(title)}</span>` +
      (qual ? `<span class="sec-qual">${esc(qual)}</span>` : '') +
      `</summary><div class="sec-body">${renderBody(s.body)}</div>`;
    host.appendChild(d);
  }
}

/* ===========================================================================
   Word-level diff (LCS) for the change log
   =========================================================================== */

function tokens(s) { return s.split(/\s+/).filter(Boolean); }

/* Returns ops: [type ('same'|'del'|'ins'), words[]] via LCS backtracking. */
function wordDiff(aText, bText) {
  const a = tokens(aText), b = tokens(bText);
  const n = a.length, m = b.length;
  const W = m + 1;
  const L = new Int32Array((n + 1) * W);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i * W + j] = a[i] === b[j]
        ? L[(i + 1) * W + j + 1] + 1
        : Math.max(L[(i + 1) * W + j], L[i * W + j + 1]);
    }
  }
  const ops = [];
  const push = (type, w) => {
    const last = ops[ops.length - 1];
    if (last && last[0] === type) last[1].push(w);
    else ops.push([type, [w]]);
  };
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { push('same', a[i]); i++; j++; }
    else if (L[(i + 1) * W + j] >= L[i * W + j + 1]) push('del', a[i++]);
    else push('ins', b[j++]);
  }
  while (i < n) push('del', a[i++]);
  while (j < m) push('ins', b[j++]);
  return ops;
}

/* Render ops, folding long unchanged runs down to their edges. */
function renderOps(ops, ctx = 8) {
  const parts = [];
  ops.forEach(([type, words], idx) => {
    if (type === 'same') {
      const edge = idx === 0 || idx === ops.length - 1;
      const keep = edge ? ctx : ctx * 2;
      if (words.length > keep + 4) {
        const head = idx === 0 ? [] : words.slice(0, ctx);
        const tail = idx === ops.length - 1 ? [] : words.slice(-ctx);
        parts.push(esc(head.join(' ')), '<span class="ell">[…]</span>', esc(tail.join(' ')));
      } else {
        parts.push(esc(words.join(' ')));
      }
    } else {
      const tag = type === 'del' ? 'del' : 'ins';
      parts.push(`<${tag}>${esc(words.join(' '))}</${tag}>`);
    }
  });
  return parts.filter(Boolean).join(' ');
}

const normText = (s) => s.replace(/\s+/g, ' ').trim();

/* Compare two parsed AFDs section-by-section. */
function diffIssuances(oldSecs, newSecs) {
  const oldMap = new Map(oldSecs.map((s) => [s.name, s]));
  const out = { changed: [], added: [], removed: [], same: [], ins: 0, del: 0 };
  for (const s of newSecs) {
    const prev = oldMap.get(s.name);
    oldMap.delete(s.name);
    if (!prev) { out.added.push(s); out.ins += tokens(s.body).length; continue; }
    if (normText(prev.body) === normText(s.body)) { out.same.push(s.name); continue; }
    const ops = wordDiff(normText(prev.body), normText(s.body));
    let ins = 0, del = 0;
    for (const [t, w] of ops) { if (t === 'ins') ins += w.length; if (t === 'del') del += w.length; }
    out.ins += ins; out.del += del;
    out.changed.push({ name: s.name, ops });
  }
  for (const s of oldMap.values()) { out.removed.push(s); out.del += tokens(s.body).length; }
  return out;
}

function renderLogEntry(item, diff, isNew, open) {
  const issued = new Date(item.issuanceTime);
  const d = document.createElement('details');
  d.className = 'log-entry';
  if (open) d.open = true;
  const chips = [];
  if (isNew) chips.push('<span class="chip new">NEW since your last visit</span>');
  for (const c of diff.changed) chips.push(`<span class="chip">${esc(prettySection(c.name).title)}</span>`);
  for (const s of diff.added) chips.push(`<span class="chip">+ ${esc(prettySection(s.name).title)}</span>`);
  for (const s of diff.removed) chips.push(`<span class="chip">− ${esc(prettySection(s.name).title)}</span>`);
  if (!diff.changed.length && !diff.added.length && !diff.removed.length) {
    chips.push('<span class="chip stat">no text changes</span>');
  } else {
    chips.push(`<span class="chip stat">+${diff.ins} −${diff.del} words</span>`);
  }
  let body = '';
  for (const s of diff.added) {
    body += `<div class="log-sec"><div class="log-sec-name">${esc(prettySection(s.name).title)} — new section</div>` +
      `<div class="diff"><ins>${esc(normText(s.body).split(' ').slice(0, 120).join(' '))}</ins></div></div>`;
  }
  for (const c of diff.changed) {
    body += `<div class="log-sec"><div class="log-sec-name">${esc(prettySection(c.name).title)}</div>` +
      `<div class="diff">${renderOps(c.ops)}</div></div>`;
  }
  for (const s of diff.removed) {
    body += `<div class="log-sec"><div class="log-sec-name">${esc(prettySection(s.name).title)} — section removed</div></div>`;
  }
  if (diff.same.length) {
    body += `<div class="log-unchanged">unchanged: ${esc(diff.same.map((n) => prettySection(n).title).join(' · '))}</div>`;
  }
  d.innerHTML =
    `<summary><span class="log-when">${esc(fmtIssued(issued))}</span>` +
    `<span class="log-ago">${esc(timeAgo(issued))}</span>${chips.join(' ')}</summary>` +
    `<div class="log-body">${body || '<span class="faint">identical text re-issued</span>'}</div>`;
  return d;
}

async function buildChangelog(list) {
  const host = $('afd-log');
  const items = list.slice(0, LOG_DEPTH);
  if (items.length < 2) { host.innerHTML = '<div class="card faint" style="font-size:13px">No earlier issuances available yet.</div>'; return; }
  const lastSeen = +localStorage.getItem('dcwx_last_seen') || 0;
  await Promise.all(items.map((it) => afdText(it).catch(() => null)));
  host.innerHTML = '';
  for (let i = 0; i < items.length - 1; i++) {
    const cur = items[i], prev = items[i + 1];
    const curText = AFD.texts.get(cur.id), prevText = AFD.texts.get(prev.id);
    if (curText == null || prevText == null) {
      const div = document.createElement('div');
      div.className = 'card err';
      div.textContent = `Could not load the ${fmtIssued(new Date(cur.issuanceTime))} issuance for comparison.`;
      host.appendChild(div);
      continue;
    }
    if (!AFD.parsed.has(cur.id)) AFD.parsed.set(cur.id, parseAfd(curText));
    if (!AFD.parsed.has(prev.id)) AFD.parsed.set(prev.id, parseAfd(prevText));
    const diff = diffIssuances(AFD.parsed.get(prev.id), AFD.parsed.get(cur.id));
    const isNew = lastSeen && new Date(cur.issuanceTime).getTime() > lastSeen;
    host.appendChild(renderLogEntry(cur, diff, isNew, false));   // all collapsed on load
  }
  localStorage.setItem('dcwx_last_seen', String(new Date(items[0].issuanceTime).getTime()));
  if (ARC.index && Array.isArray(ARC.index.afd) && ARC.index.afd.length) {
    const oldest = new Date(Math.min(...ARC.index.afd.map((a) => a.t)) * 1000);
    const note = document.createElement('div');
    note.className = 'drift-note';
    note.style.marginTop = '10px';
    note.textContent = `Site archive: ${ARC.index.afd.length} discussion(s) kept since ` +
      `${fmtTime(oldest, { month: 'short', day: 'numeric', year: 'numeric' })} — ` +
      'the long-term record this log draws on, archived hourly to the repo.';
    host.appendChild(note);
  }
}

/* ------------------------------ AFD loader ------------------------------ */

async function loadAfd() {
  const list = mergeArchivedAfds(await afdList());
  if (!list.length) throw new Error('no AFD issuances returned');
  AFD.list = list;
  AFD.newestId = list[0].id;
  const text = await afdText(list[0]);
  const secs = parseAfd(text);
  AFD.parsed.set(list[0].id, secs);
  renderDiscussion(list[0], secs);
  buildChangelog(list).catch((e) => {
    $('afd-log').innerHTML = `<div class="card err">Change log failed: ${esc(e.message)}</div>`;
  });
}

/* Periodic check for a fresh issuance (the "updating" part of the log). */
async function checkForNew() {
  try {
    const list = mergeArchivedAfds(await afdList());
    if (!list.length || list[0].id === AFD.newestId) return;
    AFD.list = list;
    AFD.newestId = list[0].id;
    const text = await afdText(list[0]);
    const secs = parseAfd(text);
    AFD.parsed.set(list[0].id, secs);
    renderDiscussion(list[0], secs);
    await buildChangelog(list);
    buildHeadline();
    setStatus('green', `New discussion issued ${fmtIssued(new Date(list[0].issuanceTime))}`);
    document.title = '● ' + document.title.replace(/^● /, '');
  } catch (e) { /* transient — try again next cycle */ }
}

/* ===========================================================================
   Forecast drift — NWS daily periods for DC, snapshotted in localStorage
   =========================================================================== */

const DRIFT_KEY = 'dcwx_fc_snaps';
const DRIFT_MIN_GAP = 2 * 3600 * 1000;   // min age gap between kept snapshots
const DRIFT_SPAN = 3;                    // days shown either side of today

/* Calendar-day arithmetic on 'YYYY-MM-DD' strings — noon-anchored so DST
   transitions can't skip or repeat a date. */
function shiftDay(dateStr, k) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + k);
  return d.toISOString().slice(0, 10);
}

/* Temperature °C from a raw METAR: the RMK T-group (tenths) when it's there,
   else the main T/Td group. */
function metarTempC(raw) {
  const t = String(raw).match(/\bT([01])(\d{3})([01])(\d{3})\b/);
  if (t) return (t[1] === '1' ? -1 : 1) * (+t[2] / 10);
  const m = String(raw).replace(/\bRMK\b.*$/, '').match(/\s(M?\d{2})\/(M?\d{2})\s/);
  if (!m) return null;
  return m[1].startsWith('M') ? -+m[1].slice(1) : +m[1];
}

function dayHighF(metars) {
  let hi = null;
  for (const [, raw] of metars || []) {
    const c = metarTempC(raw);
    if (c == null) continue;
    const f = Math.round(degF(c));
    if (hi == null || f > hi) hi = f;
  }
  return hi;
}

/* The night that *began* on day D bottoms out in D+1's small hours — which is
   also what the NWS "low" for D means, so the two line up. */
function overnightLowF(nextDayMetars) {
  let lo = null;
  for (const [t, raw] of nextDayMetars || []) {
    if (localHour(t * 1000) >= 9) continue;
    const c = metarTempC(raw);
    if (c == null) continue;
    const f = Math.round(degF(c));
    if (lo == null || f < lo) lo = f;
  }
  return lo;
}

/* Days behind us, from the site archive: what was forecast that morning and
   what KDCA actually recorded. Missing files just leave gaps in the strip. */
async function loadPastDays() {
  const out = new Map();
  if (!ARCHIVE || !ARC.index) return out;
  const today = localDay(Date.now());
  const fcDays = ARC.index.forecast_days || [];
  const obsDays = ARC.index.obs_days || [];
  const jobs = [];
  for (let k = -DRIFT_SPAN; k <= 0; k++) {     // today included: it holds the overnight low for −1
    const date = shiftDay(today, k);
    const rec = { date, fc: null, obs: null };
    out.set(date, rec);
    if (k < 0 && fcDays.includes(date)) {
      jobs.push(fetchJSON(`${ARCHIVE}/forecast/${date}.json`).then((d) => { rec.fc = d; }).catch(() => {}));
    }
    if (obsDays.includes(date)) {
      jobs.push(fetchJSON(`${ARCHIVE}/obs/${date}.json`).then((d) => { rec.obs = d; }).catch(() => {}));
    }
  }
  await Promise.all(jobs);
  return out;
}

/* Latest NWS daily forecast for DC, kept around so the headline engine can
   quote the official numbers instead of re-deriving them from the model. */
const FC = { days: null, periods: [], at: 0 };

async function loadDrift() {
  let fcUrl = localStorage.getItem('dcwx_fc_url');
  if (!fcUrl) {
    const pt = await fetchJSON(`${NWS}/points/${DC.lat},${DC.lon}`);
    fcUrl = pt.properties.forecast;
    localStorage.setItem('dcwx_fc_url', fcUrl);
  }
  const fc = await fetchJSON(fcUrl);
  const days = {};
  for (const p of fc.properties.periods || []) {
    const date = p.startTime.slice(0, 10);
    const day = (days[date] = days[date] || { hi: null, lo: null, pop: null, short: null });
    if (p.isDaytime) { day.hi = p.temperature; day.short = p.shortForecast; }
    else { day.lo = p.temperature; if (day.short == null) day.short = p.shortForecast; }
    const pop = p.probabilityOfPrecipitation && p.probabilityOfPrecipitation.value;
    if (pop != null) day.pop = Math.max(day.pop ?? 0, pop);
  }
  FC.days = days;
  FC.periods = fc.properties.periods || [];
  FC.at = Date.now();
  const now = Date.now();
  let snaps = [];
  try { snaps = JSON.parse(localStorage.getItem(DRIFT_KEY)) || []; } catch (e) { /* reset */ }
  // Baseline: prefer the site archive's earliest snapshot of today, else the
  // newest sufficiently-old snapshot saved in this browser.
  let baseline = null, baseSrc = 'this device';
  const arcOld = ((ARC.todayFc && ARC.todayFc.snaps) || [])
    .filter((s) => now - s.t * 1000 > DRIFT_MIN_GAP);
  if (arcOld.length) {
    baseline = { at: arcOld[0].t * 1000, days: arcOld[0].days };
    baseSrc = 'site archive';
  } else {
    baseline = [...snaps].reverse().find((s) => now - s.at > DRIFT_MIN_GAP) || null;
  }
  renderDrift(baseline, { at: now, days }, baseSrc, await loadPastDays());
  if (!snaps.length || now - snaps[snaps.length - 1].at > DRIFT_MIN_GAP) {
    snaps.push({ at: now, days });
    while (snaps.length > 10) snaps.shift();
    localStorage.setItem(DRIFT_KEY, JSON.stringify(snaps));
  }
}

function fmtDay(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  return fmtTime(d, { weekday: 'short', month: 'short', day: 'numeric' });
}

const driftArrow = (d) => d > 0 ? `<span class="up">↑${d}</span>` : `<span class="down">↓${-d}</span>`;

/* A day already behind us: what verified at KDCA, against what that morning's
   forecast had called for. */
function verifiedCell(date, past) {
  const rec = past && past.get(date);
  const snaps = (rec && rec.fc && rec.fc.snaps) || [];
  const fc = snaps.length ? snaps[0].days[date] : null;
  const hi = rec && rec.obs ? dayHighF(rec.obs.metars) : null;
  const next = past && past.get(shiftDay(date, 1));
  const lo = next && next.obs ? overnightLowF(next.obs.metars) : null;

  if (hi == null && lo == null && !fc) return { nums: '', cmp: '<span class="faint">not in the site archive yet</span>' };

  const nums = hi != null || lo != null
    ? `${hi != null ? `high <b>${hi}°</b>` : ''}${hi != null && lo != null ? ' · ' : ''}${lo != null ? `low ${lo}°` : ''} observed`
    : `<span class="faint">no obs archived</span>`;
  if (!fc) return { nums, cmp: '<span class="faint">no forecast on record for that day</span>' };

  const bits = [];
  if (hi != null && fc.hi != null) {
    const d = hi - fc.hi;
    bits.push(d === 0 ? `called ${fc.hi}° — spot on` : `called ${fc.hi}° ${driftArrow(d)}`);
  } else if (fc.hi != null) bits.push(`called ${fc.hi}°`);
  if (lo != null && fc.lo != null && lo !== fc.lo) bits.push(`low called ${fc.lo}° ${driftArrow(lo - fc.lo)}`);
  return { nums, cmp: bits.join(' · ') };
}

/* Today or ahead: the current numbers, and how they've moved since the
   baseline forecast. */
function driftCell(date, base, cur) {
  const c = cur.days[date];
  if (!c) return { nums: '', cmp: '<span class="faint">beyond the forecast window</span>' };
  const nums = `${c.hi != null ? `high <b>${c.hi}°</b>` : ''}` +
    `${c.hi != null && c.lo != null ? ' · ' : ''}${c.lo != null ? `low ${c.lo}°` : ''}` +
    `${c.pop != null ? ` · ${c.pop}%` : ''}` +
    // the wording matters more than the numbers for a go/no-go — "unchanged"
    // next to a bare 64% never says the 64% is thunderstorms
    `${c.short ? ` · <span class="wx">${esc(c.short)}</span>` : ''}`;
  const b = base && base.days[date];
  if (!b) return { nums, cmp: '<span class="faint">no earlier forecast to compare</span>', c, b: null };
  const bits = [];
  if (c.hi != null && b.hi != null && c.hi !== b.hi) bits.push(`was ${b.hi}° ${driftArrow(c.hi - b.hi)}`);
  if (c.lo != null && b.lo != null && c.lo !== b.lo) bits.push(`low was ${b.lo}° ${driftArrow(c.lo - b.lo)}`);
  if (c.pop != null && b.pop != null && Math.abs(c.pop - b.pop) >= 5) bits.push(`precip was ${b.pop}% ${driftArrow(c.pop - b.pop)}`);
  if (c.short && b.short && c.short !== b.short) bits.push(`“${esc(b.short)}” → “${esc(c.short)}”`);
  return { nums, cmp: bits.length ? bits.join(' · ') : '<span class="faint">unchanged</span>', c, b };
}

/* Seven days with today in the middle: three verified behind, three forecast
   ahead. Past rows come from the site archive, the rest from the live NWS
   forecast against an earlier snapshot of it. */
function renderDrift(base, cur, baseSrc, past) {
  const host = $('drift-body');
  const today = localDay(Date.now());
  const rows = [];
  let anyPast = false;

  for (let k = -DRIFT_SPAN; k <= DRIFT_SPAN; k++) {
    const date = shiftDay(today, k);
    const rel = k === 0 ? 'today' : k === -1 ? 'yesterday' : k === 1 ? 'tomorrow'
      : k < 0 ? `${-k} days ago` : `in ${k} days`;
    const cell = k < 0 ? verifiedCell(date, past) : driftCell(date, base, cur);
    rows.push(
      `<div class="drift-row${k === 0 ? ' today' : k < 0 ? ' past' : ''}">` +
      `<span class="day">${esc(fmtDay(date))}</span><span class="rel">${esc(rel)}</span>` +
      `<span class="nums">${cell.nums}</span><span class="cmp">${cell.cmp}</span></div>`);

    if (k < 0) anyPast = anyPast || !!cell.nums;
  }

  const baseNote = base
    ? `Ahead of today: compared with the forecast ${baseSrc === 'site archive'
        ? `from the site archive (${esc(timeAgo(new Date(base.at)))})`
        : `saved on this device ${esc(timeAgo(new Date(base.at)))}`}.`
    : 'Ahead of today: baseline saved — revisit later and these rows will show how the forecast has shifted since.';
  const pastNote = anyPast
    ? ` Behind it: what ${OBS_STATION} actually recorded, against the forecast standing that morning.`
    : ' Past days fill in as the site archive accumulates.';
  host.innerHTML = rows.join('') + `<div class="drift-note">${baseNote}${pastNote}</div>`;
}

/* ===========================================================================
   Synoptic canvas — air masses, fronts, isobars, H/L, wind particles
   =========================================================================== */

const SYN = {
  LAT_N: 44, LON_W: -85, DLAT: 1, DLON: 1.5, NX: 12, NY: 10, UP: 8,
  VIEW: [[36.1, -82.8], [42.9, -71.0]],
  VARS: ['pressure_msl', 'temperature_2m', 'dew_point_2m', 'temperature_850hPa',
         'wind_speed_10m', 'wind_direction_10m', 'precipitation', 'cape'],
};
SYN.NP = SYN.NX * SYN.NY;
SYN.UX = (SYN.NX - 1) * SYN.UP + 1;
SYN.UY = (SYN.NY - 1) * SYN.UP + 1;

const syn = {
  map: null, times: [], raw: {}, t: 0, tf: 0, playing: false, playAnim: null,
  cache: new Map(), tRange: null, lut: null, parts: null, ready: false,
  proj: null, lutProj: null, lerpBuf: {},
  layers: { airmass: false, fronts: true, isobars: true, wind: true, radar: true, radarLoop: false },
};

function synUrl() {
  const lats = [], lons = [];
  for (let y = 0; y < SYN.NY; y++) {
    for (let x = 0; x < SYN.NX; x++) {
      lats.push((SYN.LAT_N - y * SYN.DLAT).toFixed(2));
      lons.push((SYN.LON_W + x * SYN.DLON).toFixed(2));
    }
  }
  return 'https://api.open-meteo.com/v1/forecast' +
    `?latitude=${lats.join(',')}&longitude=${lons.join(',')}` +
    `&hourly=${SYN.VARS.join(',')}` +
    '&wind_speed_unit=kn&timeformat=unixtime&timezone=UTC' +
    '&past_days=1&forecast_hours=49&models=gfs_global';
}

async function loadSynData() {
  const data = await fetchJSON(synUrl());
  const locs = Array.isArray(data) ? data : [data];
  if (locs.length !== SYN.NP) throw new Error(`grid came back with ${locs.length}/${SYN.NP} points`);
  syn.times = locs[0].hourly.time.map((t) => t * 1000);
  const T = syn.times.length;
  for (const v of SYN.VARS) {
    const arr = new Float32Array(T * SYN.NP);
    for (let k = 0; k < SYN.NP; k++) {
      const col = locs[k].hourly[v];
      for (let t = 0; t < T; t++) {
        const val = col ? col[t] : null;
        arr[t * SYN.NP + k] = val == null ? NaN : val;
      }
    }
    syn.raw[v] = arr;
  }
  // Air-mass color range: 2–98 percentile of 850 temp over the whole window
  // (falls back to 2 m temp where 850 is missing) so colors stay steady
  // through the animation and adapt to the season.
  const sample = [];
  const t850 = syn.raw.temperature_850hPa, t2m = syn.raw.temperature_2m;
  for (let i = 0; i < t850.length; i += 7) {
    const v = Number.isNaN(t850[i]) ? t2m[i] : t850[i];
    if (!Number.isNaN(v)) sample.push(v);
  }
  sample.sort((a, b) => a - b);
  syn.tRange = {
    lo: sample[Math.floor(sample.length * 0.02)] - 1,
    hi: sample[Math.floor(sample.length * 0.98)] + 1,
  };
}

/* -------- field helpers (base grid is NY rows × NX cols, row 0 = north) -- */

function baseField(v, t) {
  return syn.raw[v].subarray(t * SYN.NP, (t + 1) * SYN.NP);
}

/* 850 temp with 2 m fallback where the model returned nulls. */
function airmassField(t) {
  const a = baseField('temperature_850hPa', t), b = baseField('temperature_2m', t);
  const out = new Float32Array(SYN.NP);
  for (let i = 0; i < SYN.NP; i++) out[i] = Number.isNaN(a[i]) ? b[i] : a[i];
  return out;
}

function bilinear(f, gx, gy) {   // gx∈[0,NX-1], gy∈[0,NY-1] on the base grid
  const x0 = Math.max(0, Math.min(SYN.NX - 2, Math.floor(gx)));
  const y0 = Math.max(0, Math.min(SYN.NY - 2, Math.floor(gy)));
  const fx = Math.max(0, Math.min(1, gx - x0)), fy = Math.max(0, Math.min(1, gy - y0));
  const i = y0 * SYN.NX + x0;
  const v00 = f[i], v10 = f[i + 1], v01 = f[i + SYN.NX], v11 = f[i + SYN.NX + 1];
  return (v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy;
}

/* Upsample base → UX×UY with bilinear, then box-blur passes for smooth
   contours and usable gradients. Cached per (tag, t). Precip passes fewer
   blur passes — the full blur smeared light rain across the whole view. */
function upsampled(tag, t, getBase, blurPasses = 2) {
  const key = `${tag}:${t}`;
  if (syn.cache.has(key)) return syn.cache.get(key);
  const base = getBase();
  const { UX, UY, UP } = SYN;
  let g = new Float32Array(UX * UY);
  for (let y = 0; y < UY; y++) {
    for (let x = 0; x < UX; x++) {
      g[y * UX + x] = bilinear(base, x / UP, y / UP);
    }
  }
  for (let pass = 0; pass < blurPasses; pass++) g = boxBlur(g, UX, UY, 3);
  if (syn.cache.size > 320) syn.cache.delete(syn.cache.keys().next().value);
  syn.cache.set(key, g);
  return g;
}

/* Upsampled field at a fractional hour: blend of the two bracketing frames.
   Reuses one buffer per tag — callers must not hold the reference across
   frames. */
function upsampledAt(tag, tf, getBaseAt, blurPasses = 2) {
  const last = syn.times.length - 1;
  const t0 = Math.max(0, Math.min(last, Math.floor(tf)));
  const a = upsampled(tag, t0, () => getBaseAt(t0), blurPasses);
  const f = tf - t0;
  if (f < 1e-3 || t0 >= last) return a;
  const b = upsampled(tag, t0 + 1, () => getBaseAt(t0 + 1), blurPasses);
  let out = syn.lerpBuf[tag];
  if (!out || out.length !== a.length) out = syn.lerpBuf[tag] = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] + (b[i] - a[i]) * f;
  return out;
}

/* Base-resolution field at a fractional hour (tiny grid — fresh array). */
function baseFieldAt(v, tf) {
  const last = syn.times.length - 1;
  const t0 = Math.max(0, Math.min(last, Math.floor(tf)));
  const a = baseField(v, t0);
  const f = tf - t0;
  if (f < 1e-3 || t0 >= last) return a;
  const b = baseField(v, t0 + 1);
  const out = new Float32Array(SYN.NP);
  for (let i = 0; i < SYN.NP; i++) out[i] = a[i] + (b[i] - a[i]) * f;
  return out;
}

function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let k = -r; k <= r; k++) {
        const xx = x + k;
        if (xx >= 0 && xx < w) { s += src[y * w + xx]; n++; }
      }
      tmp[y * w + x] = s / n;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let k = -r; k <= r; k++) {
        const yy = y + k;
        if (yy >= 0 && yy < h) { s += tmp[yy * w + x]; n++; }
      }
      out[y * w + x] = s / n;
    }
  }
  return out;
}

function uvFields(t) {
  const spd = baseField('wind_speed_10m', t), dir = baseField('wind_direction_10m', t);
  const u = new Float32Array(SYN.NP), v = new Float32Array(SYN.NP);
  for (let i = 0; i < SYN.NP; i++) {
    const rad = (dir[i] || 0) * Math.PI / 180, s = spd[i] || 0;
    u[i] = -s * Math.sin(rad);          // eastward, kt (dir is where wind is FROM)
    v[i] = -s * Math.cos(rad);          // northward, kt
  }
  return { u, v };
}

/* grid coords of a latlng (base-grid units) */
function gridXY(lat, lon) {
  return { gx: (lon - SYN.LON_W) / SYN.DLON, gy: (SYN.LAT_N - lat) / SYN.DLAT };
}

/* Gradients of the smoothed 850 temp field in K/100 km, cached per time —
   shared by the frontal-zone painter and the precip-cause diagnosis. */
function gradFields(t) {
  const key = `grad:${t}`;
  if (syn.cache.has(key)) return syn.cache.get(key);
  const air = upsampled('air', t, () => airmassField(t));
  const { UX, UY, UP } = SYN;
  const gradX = new Float32Array(UX * UY), gradY = new Float32Array(UX * UY);
  for (let y = 0; y < UY; y++) {
    const lat = SYN.LAT_N - (y / UP) * SYN.DLAT;
    const kmX = 111.32 * Math.cos(lat * Math.PI / 180) * SYN.DLON / UP;
    for (let x = 0; x < UX; x++) {
      const i = y * UX + x;
      const xm = x > 0 ? i - 1 : i, xp = x < UX - 1 ? i + 1 : i;
      const ym = y > 0 ? i - UX : i, yp = y < UY - 1 ? i + UX : i;
      const dxCells = Math.max(1, xp - xm);            // 1 at edges, 2 inside
      const dyCells = Math.max(1, (yp - ym) / UX);
      gradX[i] = (air[xp] - air[xm]) / (dxCells * kmX) * 100;                      // eastward
      gradY[i] = (air[ym] - air[yp]) / (dyCells * FRONT_KM_PER_CELL_LAT) * 100;    // northward
    }
  }
  const out = { gradX, gradY };
  if (syn.cache.size > 320) syn.cache.delete(syn.cache.keys().next().value);
  syn.cache.set(key, out);
  return out;
}

/* Gradients at a fractional hour — the gradient is linear in the field, so
   blending the two hourly gradients equals the gradient of the blend. */
function gradFieldsAt(tf) {
  const last = syn.times.length - 1;
  const t0 = Math.max(0, Math.min(last, Math.floor(tf)));
  const g0 = gradFields(t0);
  const f = tf - t0;
  if (f < 1e-3 || t0 >= last) return g0;
  const g1 = gradFields(t0 + 1);
  const n = g0.gradX.length;
  let gx = syn.lerpBuf.gradX, gy = syn.lerpBuf.gradY;
  if (!gx || gx.length !== n) {
    gx = syn.lerpBuf.gradX = new Float32Array(n);
    gy = syn.lerpBuf.gradY = new Float32Array(n);
  }
  for (let i = 0; i < n; i++) {
    gx[i] = g0.gradX[i] + (g1.gradX[i] - g0.gradX[i]) * f;
    gy[i] = g0.gradY[i] + (g1.gradY[i] - g0.gradY[i]) * f;
  }
  return { gradX: gx, gradY: gy };
}

/* Base u/v at a fractional hour — uvFields returns fresh arrays, safe to blend
   in place. */
function uvFieldsAt(tf) {
  const last = syn.times.length - 1;
  const t0 = Math.max(0, Math.min(last, Math.floor(tf)));
  const a = uvFields(t0);
  const f = tf - t0;
  if (f < 1e-3 || t0 >= last) return a;
  const b = uvFields(t0 + 1);
  for (let i = 0; i < SYN.NP; i++) {
    a.u[i] += (b.u[i] - a.u[i]) * f;
    a.v[i] += (b.v[i] - a.v[i]) * f;
  }
  return a;
}

/* ------------------------------- radar ----------------------------------- */
/* At the "now" step the radar loops the last hour of RainViewer frames
   instead of sitting on one static image. One tile layer per frame, all
   mounted at opacity 0 and cycled by opacity — setUrl() would re-fetch
   tiles every tick and flash. The legend carries the active frame's clock
   time so a stale frame is honest about it. */

const radar = { frames: [], layers: [], fi: 0, tick: 0, timer: null, key: '' };
const RADAR_FRAMES = 7;        // ~last hour of 10-min frames
const RADAR_TICK_MS = 600;
const RADAR_DWELL = 3;         // extra ticks spent on the newest frame

function isNowStep() {
  return syn.times.length > 0 && Math.abs(syn.times[syn.t] - Date.now()) <= 45 * 60 * 1000;
}

async function loadRadar() {
  const cfg = await fetchJSON('https://api.rainviewer.com/public/weather-maps.json');
  const past = (cfg.radar && cfg.radar.past) || [];
  if (!past.length) return;
  const frames = past.slice(-RADAR_FRAMES);
  const key = frames.map((f) => f.path).join('|');
  if (key !== radar.key) {
    if (!syn.map.getPane('radarPane')) {
      // Radar rides in its own pane above the field canvases so echoes stay
      // true-color instead of being tinted by the air-mass fill.
      syn.map.createPane('radarPane');
      const pane = syn.map.getPane('radarPane');
      pane.style.zIndex = 502;
      pane.style.pointerEvents = 'none';
    }
    for (const l of radar.layers) syn.map.removeLayer(l);
    radar.layers = frames.map((f) => L.tileLayer(
      `${cfg.host}${f.path}/256/{z}/{x}/{y}/2/1_1.png`,
      { opacity: 0, maxNativeZoom: 7, maxZoom: 10, pane: 'radarPane' }));
    radar.frames = frames.map((f) => f.time * 1000);
    radar.key = key;
    radar.tick = radar.layers.length - 1;   // start (and dwell) on the newest
    radar.fi = radar.layers.length - 1;
  }
  updateRadarVisibility();
}

function radarShowFrame(i) {
  radar.fi = i;
  radar.layers.forEach((l, k) => l.setOpacity(k === i ? 0.68 : 0));
  radarNote(radar.frames[i]);
}

function radarStep() {
  if (document.hidden || radar.layers.length < 2) return;
  const n = radar.layers.length;
  radar.tick = (radar.tick + 1) % (n + RADAR_DWELL);
  radarShowFrame(Math.min(radar.tick, n - 1));
}

function radarNote(ms) {
  const el = $('syn-radar-note');
  if (!el) return;
  el.textContent = (ms
    ? `radar ${fmtTime(new Date(ms), { hour: 'numeric', minute: '2-digit' })}${syn.layers.radarLoop ? ', last hour loops' : ''} at “now”`
    : 'radar at “now”') + ' · shading = model precip at other hours';
}

function updateRadarVisibility() {
  if (!radar.layers.length || !syn.map) return;
  const show = syn.layers.radar && isNowStep();
  if (show) {
    for (const l of radar.layers) if (!syn.map.hasLayer(l)) l.addTo(syn.map);
    if (syn.layers.radarLoop) {
      if (!radar.timer) radar.timer = setInterval(radarStep, RADAR_TICK_MS);
      radarShowFrame(radar.fi);
    } else {
      // loop off: hold the newest frame, and resume from it if re-enabled
      if (radar.timer) { clearInterval(radar.timer); radar.timer = null; }
      radar.tick = radar.layers.length - 1;
      radarShowFrame(radar.layers.length - 1);
    }
  } else {
    if (radar.timer) { clearInterval(radar.timer); radar.timer = null; }
    for (const l of radar.layers) if (syn.map.hasLayer(l)) syn.map.removeLayer(l);
    radarNote(null);
  }
}

/* ---------------- DC point sounding-parameters (CAPE / CIN) -------------- */
/* Small single-point call: the grid doesn't carry CIN, and cap strength is
   the usual answer to "why didn't it storm". Past day included so the
   verification card can hindcast. */

async function loadPointData() {
  const url = 'https://api.open-meteo.com/v1/forecast' +
    `?latitude=${DC.lat}&longitude=${DC.lon}` +
    '&hourly=cape,convective_inhibition,precipitation' +
    '&past_days=1&forecast_days=3&timeformat=unixtime&timezone=UTC&models=gfs_global';
  const d = await fetchJSON(url);
  syn.point = {
    times: d.hourly.time.map((t) => t * 1000),
    cape: d.hourly.cape || [],
    cin: d.hourly.convective_inhibition || [],
    pr: d.hourly.precipitation || [],
  };
}

function pointAt(name, ms) {
  const p = syn.point;
  if (!p || !p.times.length) return null;
  let best = 0;
  for (let i = 0; i < p.times.length; i++) {
    if (Math.abs(p.times[i] - ms) < Math.abs(p.times[best] - ms)) best = i;
  }
  const v = p[name][best];
  return v == null ? null : v;
}

/* ------------------------------ colors ---------------------------------- */

const TSTOPS = [                              // fraction → rgb, cold → warm
  [0.00, [42, 60, 160]], [0.20, [50, 120, 210]], [0.38, [70, 185, 190]],
  [0.52, [120, 195, 110]], [0.66, [225, 200, 80]], [0.82, [235, 130, 60]],
  [1.00, [200, 55, 55]],
];

function tempColor(c) {
  const f = Math.max(0, Math.min(1, (c - syn.tRange.lo) / (syn.tRange.hi - syn.tRange.lo)));
  for (let i = 1; i < TSTOPS.length; i++) {
    if (f <= TSTOPS[i][0]) {
      const [f0, c0] = TSTOPS[i - 1], [f1, c1] = TSTOPS[i];
      const k = (f - f0) / (f1 - f0);
      return [0, 1, 2].map((j) => Math.round(c0[j] + (c1[j] - c0[j]) * k));
    }
  }
  return TSTOPS[TSTOPS.length - 1][1];
}

function drawLegendBar() {
  const cv = $('legend-tbar'), ctx = cv.getContext('2d');
  for (let x = 0; x < cv.width; x++) {
    const c = tempColor(syn.tRange.lo + (x / cv.width) * (syn.tRange.hi - syn.tRange.lo));
    ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
    ctx.fillRect(x, 0, 1, cv.height);
  }
  const f = (c) => Math.round(c * 9 / 5 + 32);
  $('legend-trange').textContent =
    `air mass: ${f(syn.tRange.lo)}° → ${f(syn.tRange.hi)}°F (850 hPa)`;
}

/* --------------------------- map & projection ---------------------------- */

function initSynMap() {
  syn.map = L.map('syn-map', {
    zoomControl: false, dragging: false, scrollWheelZoom: false,
    doubleClickZoom: false, boxZoom: false, keyboard: false, touchZoom: false,
    zoomSnap: 0.1, attributionControl: true,
  });
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '© CARTO / OSM', maxZoom: 10,
  }).addTo(syn.map);
  syn.map.fitBounds(SYN.VIEW, { padding: [0, 0] });
}

function sizeCanvases() {
  const wrap = $('syn-wrap');
  const w = wrap.clientWidth, h = $('syn-map').clientHeight;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  for (const id of ['syn-canvas', 'syn-particles']) {
    const cv = $(id);
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    cv.style.width = w + 'px'; cv.style.height = h + 'px';
    cv.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  syn.proj = null;      // pixel→grid projections depend on the map transform
  syn.lutProj = null;
  return { w, h };
}

/* Cached projection of the low-res field-canvas pixels into upsampled-grid
   coords — the map never pans/zooms, so this only changes on resize. Also
   holds the reusable ImageData + offscreen canvas so playback doesn't
   allocate per frame. */
function fieldProj(B) {
  const cv = $('syn-canvas');
  const w = parseInt(cv.style.width, 10), h = parseInt(cv.style.height, 10);
  let p = syn.proj;
  if (p && p.w === w && p.h === h && p.B === B) return p;
  const lw = Math.ceil(w / B), lh = Math.ceil(h / B);
  const ux = new Float32Array(lw * lh), uy = new Float32Array(lw * lh);
  for (let py = 0; py < lh; py++) {
    for (let pxi = 0; pxi < lw; pxi++) {
      const ll = syn.map.containerPointToLatLng([pxi * B + B / 2, py * B + B / 2]);
      const g = gridXY(ll.lat, ll.lng);
      const i = py * lw + pxi;
      ux[i] = g.gx * SYN.UP; uy[i] = g.gy * SYN.UP;
    }
  }
  const off = document.createElement('canvas');
  off.width = lw; off.height = lh;
  p = { w, h, B, lw, lh, ux, uy, img: new ImageData(lw, lh), off, offCtx: off.getContext('2d') };
  syn.proj = p;
  return p;
}

/* --------------------------- field rendering ----------------------------- */

/* Frontal-zone threshold: |∇T850| above ~2 K/100 km reads as a front on the
   synoptic scale; scaled into upsampled-grid units below. */
const FRONT_KM_PER_CELL_LAT = 111.32 * SYN.DLAT / SYN.UP;

function drawFields(tf = syn.tf) {
  if (!syn.ready) return;
  const cv = $('syn-canvas'), ctx = cv.getContext('2d');
  const w = parseInt(cv.style.width, 10), h = parseInt(cv.style.height, 10);
  ctx.clearRect(0, 0, w, h);

  const air = upsampledAt('air', tf, (t) => airmassField(t));
  const mslp = upsampledAt('mslp', tf, (t) => Float32Array.from(baseField('pressure_msl', t)));
  const uU = upsampledAt('u', tf, (t) => uvFields(t).u);
  const vU = upsampledAt('v', tf, (t) => uvFields(t).v);
  const { gradX, gradY } = gradFieldsAt(tf);

  // model precip shading fills the radar role at hours the radar can't show;
  // one blur pass only — the default two smeared light rain across the view
  const modelPrecip = syn.layers.radar && !isNowStep();
  const prU = modelPrecip
    ? upsampledAt('pr', tf, (t) => Float32Array.from(baseField('precipitation', t)), 1)
    : null;

  /* --- air-mass fill + frontal zones + model precip: low-res pixel pass --- */
  if (syn.layers.airmass || syn.layers.fronts || modelPrecip) {
    const P = fieldProj(3);
    const px = P.img.data;
    const n = P.lw * P.lh;
    for (let i = 0; i < n; i++) {
      const ux = P.ux[i], uy = P.uy[i];
      const o = i * 4;
      let r = 0, g = 0, b = 0, a = 0;
      if (syn.layers.airmass) {
        const c = tempColor(sampleU(air, ux, uy));
        r = c[0]; g = c[1]; b = c[2]; a = 0.42;
      }
      if (syn.layers.fronts) {
        const gxv = sampleU(gradX, ux, uy), gyv = sampleU(gradY, ux, uy);
        const G = Math.hypot(gxv, gyv);
        if (G > 1.6) {
          const adv = -(sampleU(uU, ux, uy) * gxv + sampleU(vU, ux, uy) * gyv);
          const fa = Math.min(0.75, (G - 1.6) / 2.2);
          const fc = adv < 0 ? [70, 140, 255] : [255, 90, 90];
          r = r * (1 - fa) + fc[0] * fa; g = g * (1 - fa) + fc[1] * fa; b = b * (1 - fa) + fc[2] * fa;
          a = Math.max(a, Math.min(0.7, a + fa * 0.8));
        }
      }
      if (prU) {
        const pv = sampleU(prU, ux, uy);
        // 0.3 mm/h floor = "measurable precip" — erases GFS grid-drizzle,
        // which reads as forecast rain when no forecaster carries any;
        // opacity still ramps from ~0 so the lightest echoes stay faint
        if (pv >= 0.3) {
          const pc = pv < 0.5 ? [90, 200, 120] : pv < 2 ? [245, 210, 90] : [235, 75, 140];
          const pa = Math.min(0.62, 0.10 + (pv - 0.3) * 0.34);
          r = r * (1 - pa) + pc[0] * pa; g = g * (1 - pa) + pc[1] * pa; b = b * (1 - pa) + pc[2] * pa;
          a = Math.max(a, Math.min(0.8, a + pa));
        }
      }
      px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = Math.round(a * 255);
    }
    P.offCtx.putImageData(P.img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(P.off, 0, 0, P.lw, P.lh, 0, 0, P.lw * P.B, P.lh * P.B);
  }

  /* --- isobars + H/L --- */
  if (syn.layers.isobars) drawIsobars(ctx, mslp, w, h, tf);

  drawCityMarks(ctx);
}

function sampleU(f, ux, uy) {   // bilinear on the upsampled grid
  const x0 = Math.max(0, Math.min(SYN.UX - 2, Math.floor(ux)));
  const y0 = Math.max(0, Math.min(SYN.UY - 2, Math.floor(uy)));
  const fx = Math.max(0, Math.min(1, ux - x0)), fy = Math.max(0, Math.min(1, uy - y0));
  const i = y0 * SYN.UX + x0;
  return (f[i] * (1 - fx) + f[i + 1] * fx) * (1 - fy) +
         (f[i + SYN.UX] * (1 - fx) + f[i + SYN.UX + 1] * fx) * fy;
}

function uProject(ux, uy) {     // upsampled-grid coords → container px
  const lat = SYN.LAT_N - (uy / SYN.UP) * SYN.DLAT;
  const lon = SYN.LON_W + (ux / SYN.UP) * SYN.DLON;
  return syn.map.latLngToContainerPoint([lat, lon]);
}

/* marching squares on the upsampled MSLP grid */
function drawIsobars(ctx, mslp, w, h, tf) {
  let mn = Infinity, mx = -Infinity;
  for (const v of mslp) { if (v < mn) mn = v; if (v > mx) mx = v; }
  const lo = Math.ceil(mn / 2) * 2, hi = Math.floor(mx / 2) * 2;
  const labels = [];
  ctx.save();
  ctx.lineJoin = 'round';
  for (let lev = lo; lev <= hi; lev += 2) {
    const major = lev % 4 === 0;
    ctx.strokeStyle = major ? 'rgba(230,235,245,0.5)' : 'rgba(230,235,245,0.28)';
    ctx.lineWidth = major ? 1.3 : 0.8;
    ctx.beginPath();
    let best = null;
    for (let y = 0; y < SYN.UY - 1; y++) {
      for (let x = 0; x < SYN.UX - 1; x++) {
        const i = y * SYN.UX + x;
        const v00 = mslp[i], v10 = mslp[i + 1], v01 = mslp[i + SYN.UX], v11 = mslp[i + SYN.UX + 1];
        let idx = 0;
        if (v00 > lev) idx |= 1;
        if (v10 > lev) idx |= 2;
        if (v11 > lev) idx |= 4;
        if (v01 > lev) idx |= 8;
        if (idx === 0 || idx === 15) continue;
        const pts = {
          0: [x + frac(v00, v10, lev), y],
          1: [x + 1, y + frac(v10, v11, lev)],
          2: [x + frac(v01, v11, lev), y + 1],
          3: [x, y + frac(v00, v01, lev)],
        };
        const SEGS = {
          1: [[3, 0]], 2: [[0, 1]], 3: [[3, 1]], 4: [[1, 2]], 6: [[0, 2]],
          7: [[3, 2]], 8: [[2, 3]], 9: [[0, 2]], 11: [[1, 2]], 12: [[1, 3]],
          13: [[0, 1]], 14: [[3, 0]],
          5: (v00 + v10 + v01 + v11) / 4 > lev ? [[3, 0], [1, 2]] : [[0, 1], [2, 3]],
          10: (v00 + v10 + v01 + v11) / 4 > lev ? [[0, 1], [2, 3]] : [[3, 0], [1, 2]],
        };
        for (const [e0, e1] of SEGS[idx]) {
          const p0 = uProject(pts[e0][0], pts[e0][1]);
          const p1 = uProject(pts[e1][0], pts[e1][1]);
          ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y);
          if (major) {
            const midY = (p0.y + p1.y) / 2, midX = (p0.x + p1.x) / 2;
            const score = Math.abs(midY - h / 2);
            if (midX > 30 && midX < w - 30 && midY > 20 && midY < h - 12 &&
                (!best || score < best.score)) best = { x: midX, y: midY, score };
          }
        }
      }
    }
    ctx.stroke();
    if (best) labels.push({ lev, x: best.x, y: best.y });
  }
  // isobar labels, skipping collisions
  ctx.font = '10px Segoe UI, system-ui, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const placed = [];
  for (const lb of labels) {
    if (placed.some((p) => Math.hypot(p.x - lb.x, p.y - lb.y) < 46)) continue;
    placed.push(lb);
    ctx.fillStyle = 'rgba(10,10,12,0.75)';
    ctx.fillRect(lb.x - 13, lb.y - 7, 26, 14);
    ctx.fillStyle = 'rgba(235,240,250,0.85)';
    ctx.fillText(String(lb.lev), lb.x, lb.y);
  }
  ctx.restore();
  drawExtrema(ctx, tf);
}

function frac(a, b, lev) { return b === a ? 0.5 : Math.max(0, Math.min(1, (lev - a) / (b - a))); }

/* H/L centers from the base-resolution MSLP grid (less noise than upsampled) */
function findExtrema(t) { return findExtremaIn(baseField('pressure_msl', t)); }

/* Parabolic vertex offset along one axis — puts the center between grid
   cells, so markers glide during playback instead of snapping cell to cell. */
function subCell(a, b, c) {
  const d = a - 2 * b + c;
  if (!Number.isFinite(d) || Math.abs(d) < 1e-6) return 0;
  return Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / d));
}

function findExtremaIn(f) {
  const marks = [];
  for (let y = 1; y < SYN.NY - 1; y++) {
    for (let x = 1; x < SYN.NX - 1; x++) {
      const i = y * SYN.NX + x;
      const v = f[i];
      if (Number.isNaN(v)) continue;
      let isMin = true, isMax = true, sum = 0, n = 0;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const yy = y + dy, xx = x + dx;
          if (yy < 0 || yy >= SYN.NY || xx < 0 || xx >= SYN.NX || (dx === 0 && dy === 0)) continue;
          const o = f[yy * SYN.NX + xx];
          if (o <= v) isMin = false;
          if (o >= v) isMax = false;
          sum += o; n++;
        }
      }
      const prom = Math.abs(v - sum / n);
      if ((isMin || isMax) && prom > 0.8) {
        marks.push({
          x: x + subCell(f[i - 1], v, f[i + 1]),
          y: y + subCell(f[i - SYN.NX], v, f[i + SYN.NX]),
          v, prom, type: isMin ? 'L' : 'H',
        });
      }
    }
  }
  return marks;
}

function drawExtrema(ctx, tf = syn.tf) {
  const marks = findExtremaIn(baseFieldAt('pressure_msl', tf));
  const cw = parseInt($('syn-canvas').style.width, 10);
  const ch = parseInt($('syn-canvas').style.height, 10);
  ctx.save();
  ctx.textAlign = 'center';
  for (const m of marks) {
    const p = uProject(m.x * SYN.UP, m.y * SYN.UP);
    if (p.x < 12 || p.x > cw - 12 || p.y < 14 || p.y > ch - 20) continue;
    // fade in near the detection threshold so borderline centers don't
    // pop in and out between blended frames
    ctx.globalAlpha = Math.min(1, (m.prom - 0.8) / 0.25);
    ctx.font = '700 22px Segoe UI, system-ui, sans-serif';
    ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(10,10,12,0.8)';
    ctx.fillStyle = m.type === 'L' ? '#ff6b6b' : '#74a7ff';
    ctx.strokeText(m.type, p.x, p.y);
    ctx.fillText(m.type, p.x, p.y);
    ctx.font = '600 10px Segoe UI, system-ui, sans-serif';
    ctx.strokeText(String(Math.round(m.v)), p.x, p.y + 13);
    ctx.fillText(String(Math.round(m.v)), p.x, p.y + 13);
  }
  ctx.restore();
}

function drawCityMarks(ctx) {
  const marks = [
    { lat: DC.lat, lon: DC.lon, label: 'DC' },
    { lat: SITE.airport.lat, lon: SITE.airport.lon, label: 'ANP' },
  ];
  ctx.save();
  for (const m of marks) {
    const p = syn.map.latLngToContainerPoint([m.lat, m.lon]);
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = 'rgba(0,0,0,0.8)'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
    ctx.stroke(); ctx.fill();
    ctx.font = '600 10px Segoe UI, system-ui, sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.strokeText(m.label, p.x + 6, p.y);
    ctx.fillText(m.label, p.x + 6, p.y);
  }
  ctx.restore();
}

/* --------------------------- wind particles ------------------------------ */

const PARTICLE_N = 650;

function buildWindLut(tf = syn.tf) {
  const cv = $('syn-particles');
  const w = parseInt(cv.style.width, 10), h = parseInt(cv.style.height, 10);
  const step = 8;
  let P = syn.lutProj;
  if (!P || P.w !== w || P.h !== h) {
    // cache the pixel→grid projection like fieldProj — only changes on resize
    const gw = Math.ceil(w / step) + 1, gh = Math.ceil(h / step) + 1;
    const fx = new Float32Array(gw * gh), fy = new Float32Array(gw * gh);
    for (let gy = 0; gy < gh; gy++) {
      for (let gx = 0; gx < gw; gx++) {
        const ll = syn.map.containerPointToLatLng([gx * step, gy * step]);
        const g = gridXY(ll.lat, ll.lng);
        fx[gy * gw + gx] = g.gx; fy[gy * gw + gx] = g.gy;
      }
    }
    P = syn.lutProj = {
      w, h, step, gw, gh, fx, fy,
      u: new Float32Array(gw * gh), v: new Float32Array(gw * gh),
    };
  }
  const { u: bu, v: bv } = uvFieldsAt(tf);
  for (let i = 0; i < P.gw * P.gh; i++) {
    P.u[i] = bilinear(bu, P.fx[i], P.fy[i]);
    P.v[i] = bilinear(bv, P.fx[i], P.fy[i]);
  }
  syn.lut = P;
}

function lutUV(x, y) {
  const { u, v, gw, gh, step } = syn.lut;
  const gx = Math.max(0, Math.min(gw - 2, x / step)), gy = Math.max(0, Math.min(gh - 2, y / step));
  const x0 = Math.floor(gx), y0 = Math.floor(gy), fx = gx - x0, fy = gy - y0;
  const i = y0 * gw + x0;
  return [
    (u[i] * (1 - fx) + u[i + 1] * fx) * (1 - fy) + (u[i + gw] * (1 - fx) + u[i + gw + 1] * fx) * fy,
    (v[i] * (1 - fx) + v[i + 1] * fx) * (1 - fy) + (v[i + gw] * (1 - fx) + v[i + gw + 1] * fx) * fy,
  ];
}

function initParticles() {
  const { w, h } = syn.lut;
  const p = new Float32Array(PARTICLE_N * 4);
  for (let i = 0; i < PARTICLE_N; i++) resetParticle(p, i, w, h, true);
  syn.parts = p;
}

function resetParticle(p, i, w, h, scatterAge) {
  p[i * 4] = Math.random() * w;
  p[i * 4 + 1] = Math.random() * h;
  p[i * 4 + 2] = scatterAge ? Math.random() * 120 : 0;
  p[i * 4 + 3] = 80 + Math.random() * 120;
}

let rafId = null;
function particleLoop() {
  rafId = requestAnimationFrame(particleLoop);
  if (!syn.ready || !syn.lut || document.hidden) return;
  const cv = $('syn-particles'), ctx = cv.getContext('2d');
  const { w, h } = syn.lut;
  if (!syn.layers.wind) { ctx.clearRect(0, 0, w, h); return; }
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = 'rgba(0,0,0,0.09)';
  ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = 'source-over';
  const p = syn.parts;
  const SPEED = 0.075;                 // px/frame per knot — tuned for feel
  ctx.lineWidth = 1.1;
  for (let i = 0; i < PARTICLE_N; i++) {
    const x = p[i * 4], y = p[i * 4 + 1];
    const [u, v] = lutUV(x, y);
    const nx = x + u * SPEED, ny = y - v * SPEED;   // canvas y grows southward
    p[i * 4 + 2]++;
    if (p[i * 4 + 2] > p[i * 4 + 3] || nx < 0 || nx > w || ny < 0 || ny > h) {
      resetParticle(p, i, w, h, false);
      continue;
    }
    const spd = Math.hypot(u, v);
    ctx.strokeStyle = `rgba(255,255,255,${Math.min(0.55, 0.10 + spd * 0.022)})`;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(nx, ny); ctx.stroke();
    p[i * 4] = nx; p[i * 4 + 1] = ny;
  }
}

/* ----------------------------- controls ---------------------------------- */

function synTimeLabel() {
  const d = new Date(syn.times[syn.t]);
  const dh = Math.round((d.getTime() - Date.now()) / 3600000);
  const rel = dh === 0 ? 'now' : dh > 0 ? `+${dh} h` : `${dh} h`;
  $('syn-time').innerHTML =
    `${esc(fmtTime(d, { weekday: 'short', hour: 'numeric', timeZoneName: 'short' }))} <span class="rel">· ${esc(rel)}</span>`;
}

function synSetTime(t, fromSlider) {
  syn.t = Math.max(0, Math.min(syn.times.length - 1, Math.round(t)));
  syn.tf = syn.t;
  if (!fromSlider) $('syn-slider').value = syn.t;
  synTimeLabel();
  updateRadarVisibility();
  drawFields();
  buildWindLut();
  synExplain();
}

function synNowIndex() {
  const now = Date.now();
  let best = 0;
  for (let i = 0; i < syn.times.length; i++) {
    if (Math.abs(syn.times[i] - now) < Math.abs(syn.times[best] - now)) best = i;
  }
  return best;
}

/* Playback glides through fractional hours (fields are blended between the
   two bracketing frames per rAF tick); the hourly bookkeeping — slider, time
   label, radar swap, the "why" read — only runs when the nearest hour
   changes. */
const PLAY_MS_PER_HOUR = 650;

function synTogglePlay(force) {
  syn.playing = force != null ? force : !syn.playing;
  $('syn-play').textContent = syn.playing ? '⏸ Pause' : '▶ Play';
  if (syn.playAnim) { cancelAnimationFrame(syn.playAnim); syn.playAnim = null; }
  if (!syn.playing) { syn.tf = syn.t; drawFields(); buildWindLut(); return; }
  let last = performance.now();
  const frame = (now) => {
    syn.playAnim = requestAnimationFrame(frame);
    if (document.hidden) { last = now; return; }
    const dt = Math.min(250, now - last);
    last = now;
    let tf = syn.tf + dt / PLAY_MS_PER_HOUR;
    if (tf >= syn.times.length - 1) tf = 0;
    syn.tf = tf;
    const hr = Math.round(tf);
    if (hr !== syn.t) {
      syn.t = hr;
      $('syn-slider').value = hr;
      synTimeLabel();
      updateRadarVisibility();
      synExplain();
    }
    drawFields(tf);
    buildWindLut(tf);
  };
  syn.playAnim = requestAnimationFrame(frame);
}

function synHover(ev) {
  if (!syn.ready) return;
  const rect = $('syn-wrap').getBoundingClientRect();
  const x = ev.clientX - rect.left, y = ev.clientY - rect.top;
  const ll = syn.map.containerPointToLatLng([x, y]);
  const { gx, gy } = gridXY(ll.lat, ll.lng);
  if (gx < 0 || gy < 0 || gx > SYN.NX - 1 || gy > SYN.NY - 1) return;
  const t = syn.t;
  const P = bilinear(baseField('pressure_msl', t), gx, gy);
  const T = bilinear(baseField('temperature_2m', t), gx, gy);
  const Td = bilinear(baseField('dew_point_2m', t), gx, gy);
  const spd = bilinear(baseField('wind_speed_10m', t), gx, gy);
  const dir = windDirAt(t, gx, gy);
  const f = (c) => Math.round(c * 9 / 5 + 32);
  $('syn-readout').innerHTML =
    `<b>${Math.abs(ll.lat).toFixed(1)}N ${Math.abs(ll.lng).toFixed(1)}W</b> · ` +
    `${P.toFixed(1)} hPa · ${f(T)}°F / dp ${f(Td)}°F · ` +
    `wind ${String(Math.round(dir / 10) * 10).padStart(3, '0')}°T ${Math.round(spd)} kt`;
}

function windDirAt(t, gx, gy) {   // interpolate via u/v so 350°↔010° doesn't average to 180°
  const { u, v } = uvFields(t);
  const ui = bilinear(u, gx, gy), vi = bilinear(v, gx, gy);
  return ((Math.atan2(-ui, -vi) * 180 / Math.PI) + 360) % 360;
}

/* ---------------- "why the precip" — situational diagnosis at DC --------- */

function compass8(dLatKm, dLonKm) {   // direction FROM DC TO the feature
  const brg = ((Math.atan2(dLonKm, dLatKm) * 180 / Math.PI) + 360) % 360;
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(brg / 45) % 8];
}

function kmBetween(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * 111.32;
  const dLon = (lon2 - lon1) * 111.32 * Math.cos(((lat1 + lat2) / 2) * Math.PI / 180);
  return { km: Math.hypot(dLat, dLon), dLatKm: dLat, dLonKm: dLon };
}

/* Nearest strong-thermal-gradient (frontal-zone) cell to DC, with the
   advection sign there so we can call it a cold or warm front. */
function nearestFront(t) {
  const { gradX, gradY } = gradFields(t);
  const uvB = uvFields(t);
  const uU = upsampled('u', t, () => uvB.u), vU = upsampled('v', t, () => uvB.v);
  let best = null;
  for (let y = 0; y < SYN.UY; y += 2) {
    const lat = SYN.LAT_N - (y / SYN.UP) * SYN.DLAT;
    for (let x = 0; x < SYN.UX; x += 2) {
      const i = y * SYN.UX + x;
      const G = Math.hypot(gradX[i], gradY[i]);
      if (G < 1.8) continue;
      const lon = SYN.LON_W + (x / SYN.UP) * SYN.DLON;
      const d = kmBetween(DC.lat, DC.lon, lat, lon);
      if (!best || d.km < best.km) {
        const adv = -(uU[i] * gradX[i] + vU[i] * gradY[i]);
        best = { km: d.km, dir: compass8(d.dLatKm, d.dLonKm), adv, G };
      }
    }
  }
  return best;
}

function synExplain() {
  const host = $('syn-why');
  if (!syn.ready || !host) return;
  const t = syn.t;
  const g = gridXY(DC.lat, DC.lon);
  const v = (name) => bilinear(baseField(name, t), g.gx, g.gy);
  const pr = Math.max(0, v('precipitation') || 0);
  const cape = Math.max(0, v('cape') || 0);
  const spreadF = (v('temperature_2m') - v('dew_point_2m')) * 9 / 5;
  const tm = Math.max(0, t - 3), tp = Math.min(syn.times.length - 1, t + 3);
  const dP = bilinear(baseField('pressure_msl', tp), g.gx, g.gy) -
             bilinear(baseField('pressure_msl', tm), g.gx, g.gy);

  const front = nearestFront(t);
  let low = null, high = null;
  for (const m of findExtrema(t)) {
    const lat = SYN.LAT_N - m.y * SYN.DLAT, lon = SYN.LON_W + m.x * SYN.DLON;
    const d = kmBetween(DC.lat, DC.lon, lat, lon);
    const rec = { km: d.km, dir: compass8(d.dLatKm, d.dLonKm), v: m.v };
    if (m.type === 'L' && d.km < 700 && (!low || d.km < low.km)) low = rec;
    if (m.type === 'H' && d.km < 700 && (!high || d.km < high.km)) high = rec;
  }

  const nm = (km) => Math.round(km * 0.54 / 10) * 10;
  const wet = pr >= 0.1;
  const lead = wet
    ? `The model has ~${pr < 1 ? pr.toFixed(1) : Math.round(pr)} mm/hr of precip around DC at this hour.`
    : 'No meaningful precip signal over DC at this hour in the model.';

  const S = [];
  if (front && front.km < 350) {
    const overhead = front.km < 70;
    const where = overhead ? 'is right overhead' : `lies ~${nm(front.km)} nm to the ${front.dir}`;
    if (front.adv < 0) {
      S.push(`A cold-frontal zone ${where} — denser, cooler air is wedging under the warm humid air ahead of it, forcing that air upward${wet ? '; that lift is what’s squeezing the moisture out' : ''}.`);
    } else {
      S.push(`A warm-frontal zone ${where} — warm moist air is overrunning the cooler surface air, a gentle widespread lift${wet ? ' that favors steady, stratiform precip rather than downpours' : ''}.`);
    }
  }
  if (low) {
    S.push(`The surface low ${low.km < 90 ? 'nearly overhead' : `~${nm(low.km)} nm to the ${low.dir}`} (${Math.round(low.v)} hPa) keeps broad rising motion over the region — air converging into the low has nowhere to go but up.`);
  }
  if (cape >= 1200) {
    S.push(`CAPE near ${Math.round(cape / 100) * 100} J/kg — an unstable airmass, so expect convective precip: hit-or-miss cells and locally heavy downpours rather than steady rain.`);
  } else if (cape >= 400) {
    S.push(`Modest instability (CAPE ~${Math.round(cape / 50) * 50} J/kg) supports scattered showers, maybe a rumble of thunder.`);
  } else if (wet) {
    S.push('Almost no CAPE — this is stratiform precip: steady and widespread, wrung out by large-scale lift rather than by buoyant updrafts.');
  }
  const cin = pointAt('cin', syn.times[t]);
  if (!wet && cape >= 700 && cin != null && cin <= -50) {
    S.push(`There’s fuel but also a lid: CIN around −${Math.round(Math.abs(cin) / 10) * 10} J/kg is capping the column — until heating or an approaching boundary erodes that cap, storms stay locked out no matter the CAPE.`);
  }
  if (spreadF <= 4) {
    S.push(`The low-level airmass is close to saturation (temperature–dewpoint spread ${Math.max(0, Math.round(spreadF))}°F), so any lift converts quickly to cloud and rain.`);
  } else if (spreadF >= 15 && !wet) {
    S.push(`The airmass is dry (spread ~${Math.round(spreadF)}°F) — whatever lift there is has little moisture to work with.`);
  }
  if (dP <= -1.5) {
    S.push(`Pressure at DC is falling (${dP.toFixed(1)} hPa over 6 h) — the system driving this is still approaching or deepening.`);
  } else if (dP >= 1.5 && !wet) {
    S.push(`Pressure is rising (+${dP.toFixed(1)} hPa over 6 h) as high pressure builds in; sinking air dries the column and keeps skies quiet.`);
  }
  if (!wet && !S.length) {
    S.push(high
      ? `High pressure ${high.km < 90 ? 'sits overhead' : `~${nm(high.km)} nm to the ${high.dir}`} (${Math.round(high.v)} hPa) — subsidence: air slowly sinking, warming and drying as it descends.`
      : 'No front, low, or instability signal near DC — a quiet, well-mixed airmass.');
  }
  const foot = syn.layers.radar && isNowStep() && radar.layers.length
    ? '<div class="why-foot">Radar overlay shows what’s actually falling; this read is the model’s explanation of why.</div>' : '';
  host.innerHTML =
    `<div class="why-hd">Why (and whether) it’s precipitating — model read at DC</div>` +
    `<b>${esc(lead)}</b> ${S.slice(0, 4).map(esc).join(' ')}${foot}`;
}

/* --------------------------- synoptic init ------------------------------- */

async function loadSynoptic() {
  initSynMap();
  await Promise.all([
    loadSynData(),
    loadPointData().catch(() => { syn.point = null; }),   // CAPE/CIN garnish — non-fatal
  ]);
  sizeCanvases();
  drawLegendBar();
  const slider = $('syn-slider');
  slider.max = syn.times.length - 1;
  syn.ready = true;
  synSetTime(synNowIndex());
  initParticles();
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced) { syn.layers.wind = false; $('lyr-wind').checked = false; }
  if (!rafId) particleLoop();

  slider.addEventListener('input', () => { synTogglePlay(false); synSetTime(+slider.value, true); });
  $('syn-play').addEventListener('click', () => synTogglePlay());
  $('syn-now').addEventListener('click', () => { synTogglePlay(false); synSetTime(synNowIndex()); });
  $('syn-wrap').addEventListener('mousemove', synHover);
  $('syn-wrap').addEventListener('click', synHover);
  for (const [id, key] of [['lyr-airmass', 'airmass'], ['lyr-fronts', 'fronts'], ['lyr-isobars', 'isobars'], ['lyr-wind', 'wind'], ['lyr-radar', 'radar']]) {
    $(id).addEventListener('change', (e) => {
      syn.layers[key] = e.target.checked;
      updateRadarVisibility();
      drawFields();
      synExplain();
    });
  }
  // radar loop preference sticks across visits (off unless opted in)
  syn.layers.radarLoop = localStorage.getItem('disc_radar_loop') === '1';
  $('lyr-radar-loop').checked = syn.layers.radarLoop;
  $('lyr-radar-loop').addEventListener('change', (e) => {
    syn.layers.radarLoop = e.target.checked;
    try { localStorage.setItem('disc_radar_loop', e.target.checked ? '1' : '0'); } catch (err) { /* private mode */ }
    updateRadarVisibility();
  });
  loadRadar().catch(() => { /* radar is optional garnish */ });
  setInterval(() => loadRadar().catch(() => {}), 5 * 60 * 1000);
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      syn.map.invalidateSize();
      syn.map.fitBounds(SYN.VIEW, { padding: [0, 0] });
      sizeCanvases();
      drawFields();
      buildWindLut();
      initParticles();
    }, 200);
  });
}

/* ===========================================================================
   Act IV — verification, as a front that sweeps with the clock
   ---------------------------------------------------------------------------
   Forecast windows close at different times of day, so each one is checked
   when *it* closes and whatever is still ahead is named as open rather than
   judged. The card this replaces compared whole-day aggregates — the daily
   high, the day's max PoP, the day's one-line forecast — against
   observations-so-far, which could only be honest near midnight: opened at
   9 AM, a 60%-PoP day whose storms fire at 4 PM took the "expected storms,
   got none" branch and explained the bust in the same confident voice it
   would use for a real one.

   Three places are involved, each for a reason:
     · the DC point — the forecast this page is about (NWS daily + the AFD)
     · KDCA — the observations that verify it (5-minute obs, archived hourly)
     · KANP — the NWS hourly grid, because the field rows are about flying at
       Lee, not about downtown
   KANP has no archived observation of its own (the nearest sensor, KNAK
   ~3 nm NE, is not a data/wx stream), so a field row necessarily checks a
   KANP forecast against KDCA weather ~25 nm NW. The card says so rather than
   letting the two read as one place.
   =========================================================================== */

const OBS_STATION = 'KDCA';
const FIELD_ID = (typeof SITE !== 'undefined' && SITE.airport && SITE.airport.id) || 'KANP';
/* The station standing in for the field. KANP has no on-field sensor, so
   site-config points at KNAK (~3 nm NE); the archive's latest.json carries
   the id the archiver actually used, which wins when present. */
const FIELD_OBS_ID = (typeof SITE !== 'undefined' && SITE.airport && SITE.airport.metarStation) || '';
const DAY_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const localDay = (ms) => DAY_FMT.format(new Date(ms));

/* Temperature in °C out of raw METAR text — the RMK T-group when present
   (tenths), else the body temp/dewpoint group. */
function metarTempC(raw) {
  const t = /\bT([01])(\d{3})[01]\d{3}\b/.exec(raw);
  if (t) return (t[1] === '1' ? -1 : 1) * (+t[2] / 10);
  const m = /(?:^|\s)(M?\d{2})\/(?:M?\d{2})?(?:\s|$)/.exec(raw.split(' RMK')[0]);
  if (m) return m[1].startsWith('M') ? -+m[1].slice(1) : +m[1];
  return null;
}

/* Flight category from visibility (SM) and ceiling (ft AGL) — the same
   thresholds as weather.js flightCat() and almanac.js catOf(). */
const CATS = ['VFR', 'MVFR', 'IFR', 'LIFR'];
function catOf(visSM, ceilFt) {
  const v = visSM == null ? 99 : visSM, c = ceilFt == null ? 99999 : ceilFt;
  if (v < 1 || c < 500) return 3;
  if (v < 3 || c < 1000) return 2;
  if (v <= 5 || c <= 3000) return 1;
  return 0;
}

/* Ceiling / visibility / wind / present weather out of raw METAR text — a
   compact mirror of almanac.js parseMetar(), which discussion.html does not
   load. Keep the two in step if the decoding changes. */
function metarObs(raw) {
  const body = String(raw || '').split(' RMK')[0];
  const o = { tC: metarTempC(raw), spd: null, gst: null, visSM: null, ceilFt: null };
  const w = body.match(/(?:^|\s)(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?KT\b/);
  if (w) { o.spd = +w[2]; o.gst = w[3] ? +w[3] : null; }
  if (/\bP6SM\b/.test(body)) o.visSM = 7;
  else {
    const v = body.match(/(?:^|\s)(?:(\d{1,2})\s)?(M)?(\d{1,2})(?:\/(\d{1,2}))?SM\b/);
    if (v) {
      o.visSM = (+v[1] || 0) + (v[4] ? +v[3] / +v[4] : +v[3]);
      if (v[2]) o.visSM = Math.max(0, o.visSM - 0.01);   // M1/4SM = "less than"
    }
  }
  const cre = /\b(FEW|SCT|BKN|OVC|VV)(\d{3})/g;
  let c;
  while ((c = cre.exec(body))) {
    if (o.ceilFt === null && (c[1] === 'BKN' || c[1] === 'OVC' || c[1] === 'VV')) o.ceilFt = +c[2] * 100;
  }
  o.ts = /(?:^|\s)[+-]?(?:VC)?TS(?!NO)/.test(body);
  o.rain = /(?:^|\s)[+-]?(?:VC)?(?:TS|SH|FZ)?(?:RA|DZ)\b/.test(body);
  o.cat = catOf(o.visSM, o.ceilFt);
  return o;
}

const hourLabel = (ms) => fmtTime(new Date(ms), { hour: 'numeric' });

/* "9 AM" for one hour, "9 AM–1 PM" for a run. Compares the *labels*, not the
   timestamps — two obs 20 minutes apart are both "5 PM" and must not render
   as "5 PM–5 PM". */
function hourSpan(list) {
  if (!list || !list.length) return '';
  const a = hourLabel(list[0]), b = hourLabel(list[list.length - 1]);
  return a === b ? a : `${a}–${b}`;
}

/* Did the observed hours land in (or next to) the advertised ones? An
   advertised 2 PM shower and an observed 4 AM one are both "rain today", but
   they are not the same event and must not score as a hit. */
function overlapsHours(advMs, obsMs) {
  const set = new Set(advMs.map((ms) => Math.round(ms / 3600000)));
  return obsMs.some((ms) => {
    const h = Math.round(ms / 3600000);
    return set.has(h) || set.has(h - 1) || set.has(h + 1);
  });
}

/* Hours of `date` that a grid snapshot painted a given weather type in. The
   NWS `weather` array is what drives the thunderstorm icon in every app
   rendering this grid, so it is also the honest record of what was
   advertised this morning. */
function gridHours(snap, re, date) {
  const out = [];
  if (!snap || snap.t0 == null || !snap.wx) return out;
  for (let i = 0; i < snap.wx.length; i++) {
    const ms = (snap.t0 + i * 3600) * 1000;
    if (localDay(ms) !== date) continue;
    if (snap.wx[i] && re.test(snap.wx[i])) out.push(ms);
  }
  return out;
}

/* One ob per hour — the one nearest the top of the hour, since KDCA files
   several — paired with what the morning grid had forecast for that hour. */
function hourlyPairs(metars, snap, date) {
  const byHour = new Map();
  for (const [ts, raw] of metars || []) {
    const ms = ts * 1000;
    if (localDay(ms) !== date) continue;
    const hr = Math.round(ms / 3600000) * 3600000;
    const prev = byHour.get(hr);
    if (!prev || Math.abs(ms - hr) < Math.abs(prev.ms - hr)) byHour.set(hr, { ms, raw });
  }
  const pairs = [];
  for (const [hr, ob] of [...byHour.entries()].sort((a, b) => a[0] - b[0])) {
    const o = metarObs(ob.raw);
    const fCeil = WXA.gridAt(snap, 'ceil', hr);
    const fVis = WXA.gridAt(snap, 'vis', hr);
    const fSpd = WXA.gridAt(snap, 'spd', hr);
    const fGst = WXA.gridAt(snap, 'gst', hr);
    const known = fCeil !== undefined || fVis !== undefined;
    pairs.push({
      hr, obs: o,
      fCat: known ? catOf(fVis === undefined ? null : fVis, fCeil === undefined ? null : fCeil) : null,
      fCeil: fCeil === undefined ? null : fCeil,
      fSpd: fSpd === undefined ? null : fSpd,
      fGst: fGst === undefined ? null : fGst,
    });
  }
  return pairs;
}

/* A verification row. state drives the mark and the colour:
   hit / near = it closed and verified, miss = it closed and did not,
   open = still ahead, watch = advertised, not here yet, window still live. */
const V_MARK = { hit: '✓', near: '≈', miss: '✗', open: '○', watch: '!' };

function vRowHtml(r) {
  return `<div class="vf-row ${r.state}">` +
    `<span class="vf-mark">${V_MARK[r.state] || '·'}</span>` +
    `<span class="vf-what">${esc(r.what)}</span>` +
    `<span class="vf-said">${r.said}</span>` +
    `<span class="vf-got">${r.got}</span>` +
    (r.note ? `<span class="vf-note">${r.note}</span>` : '') +
    `</div>`;
}

async function loadVerification() {
  const host = $('verify-body');
  const now = Date.now();
  const today = localDay(now);
  const yest = shiftDay(today, -1);
  const hNow = localHour(now) + new Date(now).getMinutes() / 60;   // TZ is whole-hour

  /* ---------- what was expected ---------- */

  /* today's whole-day call, from the first snapshot archived this morning
     (shared across devices), else the earliest one this browser saved */
  let exp = null, expSrc = '';
  const arcSnap = ((ARC.todayFc && ARC.todayFc.snaps) || []).find((s) => s.days && s.days[today]);
  if (arcSnap) {
    exp = { at: arcSnap.t * 1000, ...arcSnap.days[today] };
    expSrc = `archived ${fmtTime(new Date(exp.at), { hour: 'numeric' })}`;
  } else {
    let snaps = [];
    try { snaps = JSON.parse(localStorage.getItem(DRIFT_KEY)) || []; } catch (e) { /* none */ }
    const withToday = snaps.filter((s) => s.days && s.days[today] && now - s.at > 3 * 3600 * 1000);
    if (withToday.length) {
      exp = { at: withToday[0].at, ...withToday[0].days[today] };
      expSrc = `saved here ${timeAgo(new Date(exp.at))}`;
    }
  }
  /* last night's low was called yesterday morning, and the NWS "low" for a
     day bottoms out in the next day's small hours — so this morning's obs
     verify yesterday's number */
  const yFc = await WXA.firstSnap('forecast', yest);
  const expLo = (yFc && yFc.days && yFc.days[yest] && yFc.days[yest].lo != null) ? yFc.days[yest].lo : null;
  /* the field's own hourly forecast as it stood this morning */
  const gridSnap = await WXA.firstSnap('grid', today);

  /* ---------- what actually happened ---------- */

  /* METARs at DCA today. The site archive first — the live NWS observation
     store silently drops obs (it lost a whole TSRA sequence on 2026-08-10),
     while the archive accumulated them hourly. latest.json tops up the
     current hour; the live API is only the last resort. */
  let metars = [];
  try {
    const raws = new Map();
    const arcObs = await WXA.day('obs', today);
    for (const [ts, raw] of (arcObs && arcObs.metars) || []) raws.set(ts, raw);
    const wl = await WXA.latest();
    for (const [ts, raw] of (wl && wl.obs) || []) raws.set(ts, raw);
    metars = [...raws.entries()]
      .filter(([ts]) => localDay(ts * 1000) === today && ts * 1000 <= now)
      .sort((a, b) => a[0] - b[0]);
  } catch (e) { /* fall through to the live store */ }
  if (!metars.length) {
    const obs = await fetchJSON(`${NWS}/stations/${OBS_STATION}/observations?limit=40`);
    metars = (obs.features || []).map((f) => f.properties)
      .filter((p) => p && p.timestamp && p.rawMessage)
      .map((p) => [Math.round(new Date(p.timestamp).getTime() / 1000), p.rawMessage])
      .filter(([ts]) => localDay(ts * 1000) === today && ts * 1000 <= now)
      .sort((a, b) => a[0] - b[0]);
  }
  if (!metars.length) {
    host.innerHTML = '<span class="err">No observations for today yet — nothing to verify against.</span>';
    return;
  }
  const lastObMs = metars[metars.length - 1][0] * 1000;
  const decoded = metars.map(([ts, raw]) => ({ ms: ts * 1000, o: metarObs(raw) }));

  /* The field's own sensor (KNAK, ~3 nm from the runway), which is what the
     field rows should be checked against — the grid forecasts KANP, and
     KDCA is 25 nm NW. Days before the fieldobs stream existed have none, so
     everything below falls back to the DC station and relabels itself. */
  let fieldMetars = [], fieldObsId = FIELD_OBS_ID;
  try {
    const raws = new Map();
    const arc = await WXA.day('fieldobs', today);
    for (const [ts, raw] of (arc && arc.metars) || []) raws.set(ts, raw);
    const wl = await WXA.latest();
    if (wl && wl.field_station) fieldObsId = wl.field_station;
    for (const [ts, raw] of (wl && wl.fieldobs) || []) raws.set(ts, raw);
    fieldMetars = [...raws.entries()]
      .filter(([ts]) => localDay(ts * 1000) === today && ts * 1000 <= now)
      .sort((a, b) => a[0] - b[0]);
  } catch (e) { /* no field stream — the fallback below covers it */ }
  const atField = fieldMetars.length > 0;
  const fieldStation = atField ? fieldObsId : OBS_STATION;
  const fDecoded = (atField ? fieldMetars : metars)
    .map(([ts, raw]) => ({ ms: ts * 1000, o: metarObs(raw) }));

  /* this morning's minimum, which is what last night's forecast low meant */
  let gotLo = null, gotLoMs = null;
  for (const d of decoded) {
    if (localHour(d.ms) >= 9 || d.o.tC == null) continue;
    const f = Math.round(degF(d.o.tC));
    if (gotLo == null || f < gotLo) { gotLo = f; gotLoMs = d.ms; }
  }
  let gotHi = null, gotHiMs = null;
  for (const d of decoded) {
    if (d.o.tC == null) continue;
    const f = Math.round(degF(d.o.tC));
    if (gotHi == null || f > gotHi) { gotHi = f; gotHiMs = d.ms; }
  }
  /* Thunder stays on the DC station even when the field reports: KNAK is an
     AUTO site, and an automated station only calls TS if it carries lightning
     detection, so absence there is not evidence of absence. Ceiling, vis,
     wind and precip are exactly what an AO2 measures well — those move to
     the field. */
  const tsObs = decoded.filter((d) => d.o.ts);
  const rainObs = fDecoded.filter((d) => d.o.rain);
  let peakSpd = 0, peakGst = 0;
  for (const d of fDecoded) {
    peakSpd = Math.max(peakSpd, d.o.spd || 0);
    peakGst = Math.max(peakGst, d.o.gst || 0);
  }

  /* ---------- model hindcast, for the "why" on windows that closed ---------- */

  let peakCape = 0, dcPrecip = 0, nearbyMax = 0, capJkg = null, front = null;
  if (syn.ready) {
    const g = gridXY(DC.lat, DC.lon);
    for (let i = 0; i < syn.times.length; i++) {
      if (syn.times[i] > now || localDay(syn.times[i]) !== today) continue;
      peakCape = Math.max(peakCape, bilinear(baseField('cape', i), g.gx, g.gy) || 0);
      dcPrecip += Math.max(0, bilinear(baseField('precipitation', i), g.gx, g.gy) || 0);
      const pf = baseField('precipitation', i);
      for (let k = 0; k < SYN.NP; k++) {
        const lat = SYN.LAT_N - Math.floor(k / SYN.NX) * SYN.DLAT;
        const lon = SYN.LON_W + (k % SYN.NX) * SYN.DLON;
        if (kmBetween(DC.lat, DC.lon, lat, lon).km < 120) nearbyMax = Math.max(nearbyMax, pf[k] || 0);
      }
    }
    if (syn.point) {   // the point call carries CAPE too and resolves better
      for (let i = 0; i < syn.point.times.length; i++) {
        const tms = syn.point.times[i];
        if (tms > now || localDay(tms) !== today) continue;
        peakCape = Math.max(peakCape, syn.point.cape[i] || 0);
        const hr = localHour(tms);
        if (hr >= 11 && hr <= 22) {
          const c = syn.point.cin[i];
          if (c != null && (capJkg == null || Math.abs(c) > capJkg)) capJkg = Math.abs(c);
        }
      }
    }
    front = nearestFront(synNowIndex());
  }
  /* CAPE right now, for a storm window still ahead of us */
  let capeNow = null, cinNow = null;
  if (syn.point) {
    let best = Infinity;
    for (let i = 0; i < syn.point.times.length; i++) {
      const d = Math.abs(syn.point.times[i] - now);
      if (d < best) { best = d; capeNow = syn.point.cape[i]; cinNow = syn.point.cin[i]; }
    }
  }

  /* ---------- windows ---------- */

  const settled = [], open = [];
  const pairs = hourlyPairs(atField ? fieldMetars : metars, gridSnap, today);
  const catPairs = pairs.filter((p) => p.fCat != null);

  /* 1 — last night's low. Closes at 09:00; before that the night is still
     running and the minimum can still fall. */
  if (hNow >= 9 && gotLo != null) {
    const d = expLo == null ? null : gotLo - expLo;
    settled.push({
      state: d == null ? 'open' : Math.abs(d) <= 2 ? 'hit' : Math.abs(d) <= 4 ? 'near' : 'miss',
      what: 'Overnight low',
      said: expLo == null ? '<span class="faint">no forecast archived</span>' : `called ${expLo}°`,
      got: `<b>${gotLo}°</b> at ${esc(hourLabel(gotLoMs))}`,
      note: d == null ? '' : d === 0 ? 'spot on' : `${Math.abs(d)}° ${d > 0 ? 'warmer' : 'colder'}`,
    });
  } else if (gotLo != null) {
    open.push({
      state: 'open', what: 'Overnight low',
      said: expLo == null ? '<span class="faint">no forecast archived</span>' : `called ${expLo}°`,
      got: `<b>${gotLo}°</b> so far`, note: 'settles at 9 AM',
    });
  }

  /* 2 — ceilings and visibility at the field, hour by hour. Every hour with
     an ob behind us is closed; the rest of the grid is not judged. */
  if (catPairs.length) {
    const agree = catPairs.filter((p) => p.obs.cat === p.fCat);
    const worse = catPairs.filter((p) => p.obs.cat > p.fCat);
    const better = catPairs.filter((p) => p.obs.cat < p.fCat);
    const fCats = [...new Set(catPairs.map((p) => p.fCat))];
    const said = fCats.length === 1
      ? `${esc(FIELD_ID)} grid ${CATS[fCats[0]]} all ${catPairs.length} h`
      : `${esc(FIELD_ID)} grid ${CATS[Math.min(...fCats)]}–${CATS[Math.max(...fCats)]}`;
    let state = 'hit', got, note = '';
    if (worse.length) {
      state = 'miss';
      const w = worse.map((p) => p.hr);
      got = `${esc(fieldStation)} <b>${CATS[Math.max(...worse.map((p) => p.obs.cat))]}</b> ${esc(hourSpan(w))}`;
      note = `${worse.length} h worse than advertised`;
    } else if (better.length) {
      state = 'near';
      got = `${esc(fieldStation)} <b>${CATS[Math.min(...better.map((p) => p.obs.cat))]}</b> — better than called`;
      note = `${better.length} of ${catPairs.length} h`;
    } else {
      got = `${esc(fieldStation)} <b>${CATS[agree[0].obs.cat]}</b> every hour`;
      note = `${agree.length} of ${catPairs.length} h matched`;
    }
    settled.push({ state, what: 'Ceiling & vis', said, got, note });
  }

  /* 3 — wind, over the hours that have obs */
  const fSpds = pairs.map((p) => p.fSpd).filter((v) => v != null);
  if (fSpds.length && peakSpd) {
    const fPeak = Math.round(Math.max(...fSpds));
    const fGstPeak = Math.max(0, ...pairs.map((p) => p.fGst || 0));
    const d = peakSpd - fPeak;
    settled.push({
      state: Math.abs(d) <= 4 ? 'hit' : Math.abs(d) <= 8 ? 'near' : 'miss',
      what: 'Wind',
      said: `${esc(FIELD_ID)} grid peaked ${fPeak} kt${fGstPeak ? ` G${Math.round(fGstPeak)}` : ''}`,
      got: `${esc(fieldStation)} <b>${peakSpd} kt</b>${peakGst ? ` G${peakGst}` : ''}`,
      note: d === 0 ? 'spot on' : `${Math.abs(d)} kt ${d > 0 ? 'stronger' : 'lighter'}`,
    });
  }

  /* 4 — rain and thunder, split at now. The morning grid's own hourly
     weather array says when it was advertised, which is what lets a threat
     still ahead of you read as pending instead of as a bust. */
  const stormHrs = gridHours(gridSnap, /thunder/i, today);
  const rainHrs = gridHours(gridSnap, /rain|shower|drizzle/i, today);
  const stormPast = stormHrs.filter((ms) => ms <= now);
  const stormAhead = stormHrs.filter((ms) => ms > now);
  const rainPast = rainHrs.filter((ms) => ms <= now);
  const rainAhead = rainHrs.filter((ms) => ms > now);

  if (rainPast.length || rainObs.length) {
    const obsMs = rainObs.map((d) => d.ms);
    const hit = rainPast.length > 0 && obsMs.length > 0 && overlapsHours(rainPast, obsMs);
    const timingOff = rainPast.length > 0 && obsMs.length > 0 && !hit;
    settled.push({
      state: hit ? 'hit' : timingOff ? 'near' : 'miss',
      what: 'Rain so far',
      said: rainPast.length ? `${esc(FIELD_ID)} grid: rain ${esc(hourSpan(rainPast))}` : `${esc(FIELD_ID)} grid: dry`,
      got: obsMs.length ? `${esc(fieldStation)} <b>rain</b> ${esc(hourSpan(obsMs))}` : `${esc(fieldStation)} <b>dry</b>`,
      note: timingOff ? 'different hours' : rainPast.length && !obsMs.length ? `nothing reached ${fieldStation}`
        : !rainPast.length && obsMs.length ? 'unadvertised' : '',
    });
  } else {
    settled.push({
      state: 'hit', what: 'Rain so far',
      said: `${esc(FIELD_ID)} grid: dry`, got: `${esc(fieldStation)} <b>dry</b>`,
      note: `through ${esc(hourLabel(lastObMs))}`,
    });
  }

  /* Thunder splits at now like everything else: advertised hours already
     behind us are settled — and a storm window that passed empty is exactly
     the thing the old card could not say — while hours still ahead stay open
     rather than being judged. */
  const tsMs = tsObs.map((d) => d.ms);
  if (tsMs.length) {
    const hit = stormPast.length > 0 && overlapsHours(stormPast, tsMs);
    settled.push({
      state: hit ? 'hit' : 'miss',
      what: 'Thunder so far',
      said: stormPast.length ? `${esc(FIELD_ID)} grid: storms ${esc(hourSpan(stormPast))}` : 'not advertised',
      got: `${OBS_STATION} <b>TS</b> ${esc(hourSpan(tsMs))}`,
      note: hit ? '' : stormPast.length ? 'different hours' : 'no grid signal for it',
    });
  } else if (stormPast.length) {
    settled.push({
      state: 'miss', what: 'Thunder so far',
      said: `${esc(FIELD_ID)} grid: storms ${esc(hourSpan(stormPast))}`,
      got: `${OBS_STATION} <b>none</b>`,
      note: stormAhead.length ? `${stormPast.length} h passed empty` : 'window closed',
    });
  }
  if (stormAhead.length) {
    open.push({
      state: 'watch',
      what: stormPast.length || tsMs.length ? 'Thunder, rest of day' : 'Thunder',
      said: `${esc(FIELD_ID)} grid: storms ${esc(hourSpan(stormAhead))}`,
      got: '<b>still ahead</b>',
      // CIN comes off Open-Meteo as a magnitude; the page prints it signed
      note: capeNow != null ? `CAPE ${fmtJ(capeNow)}${cinNow != null ? ` · CIN −${Math.abs(Math.round(cinNow))}` : ''} J/kg now` : 'window still open',
    });
  }

  /* 5 — today's high. The maximum normally lands mid-afternoon, so call it
     closed at 6 PM; before that it is a running number, not a verdict. */
  if (exp && exp.hi != null && gotHi != null) {
    if (hNow >= 18) {
      const d = gotHi - exp.hi;
      settled.push({
        state: Math.abs(d) <= 2 ? 'hit' : Math.abs(d) <= 4 ? 'near' : 'miss',
        what: "Today's high", said: `called ${exp.hi}°`,
        got: `<b>${gotHi}°</b> at ${esc(hourLabel(gotHiMs))}`,
        note: d === 0 ? 'spot on' : `${Math.abs(d)}° ${d > 0 ? 'warmer' : 'cooler'}`,
      });
    } else {
      open.push({
        state: 'open', what: "Today's high", said: `called ${exp.hi}°`,
        got: `<b>${gotHi}°</b> so far`, note: 'settles this evening',
      });
    }
  }

  /* 6 — the rest of the day's advertised weather, named so it can't go quiet */
  if (exp && exp.short && hNow < 21) {
    const restPop = exp.pop != null ? ` · ${exp.pop}% chance` : '';
    open.push({
      state: 'open', what: 'Rest of the day',
      said: `<span class="wx">${esc(exp.short)}</span>${restPop}`,
      got: rainAhead.length ? `grid has rain ${esc(hourSpan(rainAhead))}` : '<span class="faint">grid is dry from here</span>',
      note: '',
    });
  }

  /* ---------- the "why", only for windows that actually closed ---------- */

  const S = [];
  const stormMiss = stormPast.length && !tsObs.length && !stormAhead.length;
  if (stormMiss) {
    if (peakCape >= 800 && capJkg != null && capJkg >= 60) {
      S.push(`The fuel showed up — the hindcast has CAPE peaking near ${fmtJ(peakCape)} J/kg — but the lid never broke: inhibition held around −${Math.round(capJkg / 10) * 10} J/kg through the heating hours, and no trigger punched through it.`);
    }
    if (front && front.km < 450 && front.dir.includes('W')) {
      S.push(`The trigger ran late: the front is still ~${Math.round(front.km * 0.54 / 10) * 10} nm to the ${front.dir}, so the lift never overlapped the unstable air in time.`);
    } else if (front && front.dir.includes('E')) {
      S.push('The boundary came through dry — by the time it crossed, the low levels had stabilized.');
    }
    if (nearbyMax > 0.8 && dcPrecip < 0.3) {
      S.push(`Storms did fire nearby — the hindcast paints up to ~${nearbyMax.toFixed(1)} mm/hr within ~65 nm — they just missed the district.`);
    }
    if (peakCape < 500) {
      S.push(`The instability underperformed: CAPE only reached ~${Math.round(peakCape / 50) * 50} J/kg, short of what the morning forecast banked on.`);
    }
    if (!S.length) S.push('The model’s own hindcast keeps DC dry too — the setup weakened faster than the runs behind the morning forecast expected.');
  } else if (tsObs.length) {
    S.push(`Thunder verified at ${OBS_STATION} around ${esc(hourLabel(tsObs[0].ms))}${peakCape ? ` — fuel (CAPE ~${fmtJ(peakCape)} J/kg) plus a trigger, the classic recipe` : ''}.`);
  } else if (stormAhead.length) {
    S.push(`Nothing is settled about the storms yet — the advertised window runs ${esc(hourSpan(stormAhead))}${capJkg != null ? `, and inhibition is still around −${Math.round(capJkg / 10) * 10} J/kg` : ''}. Treat the silence above as "not yet", not "clear".`);
  } else if (!settled.some((r) => r.state === 'miss')) {
    S.push(`Everything that has closed so far verified${hNow < 18 ? ' — the day is not over' : ''}.`);
  }

  /* ---------- render ---------- */

  const pct = Math.max(0, Math.min(100, (hNow / 24) * 100));
  const openH = Math.max(0, 24 - Math.round(hNow));
  const srcNote = catPairs.length
    ? `Field rows compare the ${esc(FIELD_ID)} hourly grid (archived this morning) against ` +
      (atField
        ? `${esc(fieldStation)} METARs — the field's own sensor, ~3 nm out.`
        : `${OBS_STATION} METARs ~25 nm NW, because no ${esc(FIELD_ID)}-area obs are archived for this day.`) +
      ` Day rows are the DC forecast against ${OBS_STATION}` +
      (atField ? `, and thunder stays on ${OBS_STATION} — an AUTO station only reports TS if it carries lightning detection.` : '.')
    : `Day rows are the DC point forecast against ${OBS_STATION} METARs.`;

  host.innerHTML =
    `<div class="vf-head">` +
    `<span class="vf-front">Verified through ${esc(hourLabel(lastObMs))}</span>` +
    `<span class="vf-bar"><i style="width:${pct.toFixed(0)}%"></i></span>` +
    `<span class="vf-open">${openH} h still open</span>` +
    `</div>` +
    (settled.length ? `<div class="vf-sec">Settled</div>${settled.map(vRowHtml).join('')}` : '') +
    (open.length ? `<div class="vf-sec">Still open</div>${open.map(vRowHtml).join('')}` : '') +
    (S.length ? `<p class="v-why">${S.join(' ')}</p>` : '') +
    `<div class="drift-note">${srcNote} ` +
    `PoPs are probabilities, not promises${exp && exp.pop != null && exp.pop > 0 && exp.pop < 100 ? ` — a ${exp.pop}% day stays dry about ${Math.round(10 - exp.pop / 10)} times in 10` : ''}. ` +
    `Forecast baseline: ${exp ? esc(expSrc) : 'none on record yet'}. ` +
    `Hindcast = the model’s own reconstruction (GFS).</div>`;
}

/* ===========================================================================
   The big story — headline engine
   ---------------------------------------------------------------------------
   The rest of the page answers "what is the atmosphere doing?" in detail. This
   answers "what is the one thing worth knowing?" — a lead headline, a deck that
   says why, the numbers behind it, and the runners-up.

   Candidate stories (active alerts, convection, a frontal passage, a rain
   episode, heat, cold, wind, fog, or a quiet pattern) are each scored from data
   the page already has: NWS alerts + the daily forecast for DC, the GFS grid
   behind the synoptic map, and the office's own KEY MESSAGES when it writes
   them. Highest score leads; the runners-up become the "also" lines. Every
   input is optional — whatever loaded is what the headline is built from.
   =========================================================================== */

const HL = { alerts: [] };
const SEV_RANK = { Extreme: 4, Severe: 3, Moderate: 2, Minor: 1 };

/* Active NWS alerts for the DC point. Optional: on failure the headline is
   built from the model and the forecast alone. */
async function loadAlerts() {
  try {
    const d = await fetchJSON(`${NWS}/alerts/active?point=${DC.lat},${DC.lon}`);
    const feats = d.features || d['@graph'] || [];
    HL.alerts = feats
      .map((f) => (f && f.properties) || f)
      .filter((p) => p && p.event)
      .sort((a, b) => (SEV_RANK[b.severity] || 0) - (SEV_RANK[a.severity] || 0));
  } catch (e) { HL.alerts = []; }
}

/* The "* WHAT..." bullet of an alert, which is the human-readable core of it. */
function alertWhat(a) {
  const desc = String(a.description || '').replace(/\s+/g, ' ').trim();
  const what = desc.match(/\*\s*WHAT\.{3}\s*(.+?)(?:\s*\*\s*[A-Z]+\.{3}|$)/);
  let t = (what ? what[1] : desc) || String(a.headline || '');
  if (t && !/[a-z]/.test(t)) t = t.charAt(0) + t.slice(1).toLowerCase();   // de-shout
  if (t.length > 240) t = t.slice(0, 237).replace(/\s\S*$/, '') + '…';
  return t || `${a.event} in effect for the DC area.`;
}

/* ---------------------------- time phrasing ------------------------------ */

const HOUR24 = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hour12: false });
const localHour = (ms) => +HOUR24.format(new Date(ms));
const dayOffset = (ms) => Math.round(
  (Date.parse(localDay(ms) + 'T00:00:00Z') - Date.parse(localDay(Date.now()) + 'T00:00:00Z')) / 86400000);

function partOfDay(h) {
  return h < 5 ? 'overnight' : h < 12 ? 'morning' : h < 17 ? 'afternoon' : h < 21 ? 'evening' : 'tonight';
}

/* "this afternoon" · "tonight" · "tomorrow morning" · "Thursday evening" */
function whenPhrase(ms) {
  const d = dayOffset(ms), p = partOfDay(localHour(ms));
  if (d <= 0) return p === 'overnight' ? 'before dawn' : p === 'tonight' ? 'tonight' : `this ${p}`;
  if (d === 1) return p === 'overnight' ? 'overnight' : p === 'tonight' ? 'tomorrow night' : `tomorrow ${p}`;
  const wd = fmtTime(new Date(ms), { weekday: 'long' });
  return p === 'tonight' ? `${wd} night` : `${wd} ${p}`;
}

/* "4 PM" · "4 PM tomorrow" · "4 PM Thursday" */
function clockPhrase(ms) {
  const d = dayOffset(ms), t = fmtTime(new Date(ms), { hour: 'numeric' });
  if (d <= 0) return t;
  if (d === 1) return `${t} tomorrow`;
  return `${t} ${fmtTime(new Date(ms), { weekday: 'long' })}`;
}

function spanPhrase(a, b) {
  const hm = (ms) => fmtTime(new Date(ms), { hour: 'numeric' });
  const tag = (ms) => {
    const d = dayOffset(ms);
    return d <= 0 ? '' : d === 1 ? ' tomorrow' : ` ${fmtTime(new Date(ms), { weekday: 'long' })}`;
  };
  if (a === b) return `around ${hm(a)}${tag(a)}`;
  if (dayOffset(a) === dayOffset(b)) return `${hm(a)}–${hm(b)}${tag(a)}`;
  return `${hm(a)}${tag(a)} to ${hm(b)}${tag(b)}`;
}

/* ------------------------------ small math ------------------------------- */

const degF = (c) => c * 9 / 5 + 32;
const dir8 = (deg) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(((deg % 360) + 360) % 360 / 45) % 8];
const fmtJ = (v) => (Math.round(v / 100) * 100).toLocaleString('en-US');

function rhFrom(tC, tdC) {           // Magnus
  const e = (x) => Math.exp(17.625 * x / (243.04 + x));
  return Math.max(1, Math.min(100, 100 * e(tdC) / e(tC)));
}

function heatIndexF(tF, rh) {        // NWS Rothfusz regression + the two adjustments
  if (tF < 80) return tF;
  let hi = -42.379 + 2.04901523 * tF + 10.14333127 * rh - 0.22475541 * tF * rh
    - 6.83783e-3 * tF * tF - 5.481717e-2 * rh * rh + 1.22874e-3 * tF * tF * rh
    + 8.5282e-4 * tF * rh * rh - 1.99e-6 * tF * tF * rh * rh;
  if (rh < 13 && tF <= 112) hi -= ((13 - rh) / 4) * Math.sqrt((17 - Math.abs(tF - 95)) / 17);
  else if (rh > 85 && tF <= 87) hi += ((rh - 85) / 10) * ((87 - tF) / 5);
  return hi;
}

/* Crosswind component at KANP for a given wind, on whichever runway end is
   into it — the number a pilot reading this page actually wants. */
function crosswindKANP(dirDeg, kt) {
  const rw = SITE.tracker.runway;
  let best = null;
  [rw.axisTrue, (rw.axisTrue + 180) % 360].forEach((hdg, k) => {
    const d = ((dirDeg - hdg + 540) % 360) - 180;
    if (!best || Math.abs(d) < Math.abs(best.d)) best = { d, name: rw.names[k] };
  });
  return { kt: Math.round(Math.abs(kt * Math.sin(best.d * Math.PI / 180))), rwy: best.name };
}

/* --------------------------- the DC time series -------------------------- */

/* Everything the engine reasons about, pulled out of the synoptic grid at DC
   (CAPE/CIN from the better-resolved point call when it loaded). */
function dcSeries() {
  if (!syn.ready || !syn.times.length) return null;
  const g = gridXY(DC.lat, DC.lon);
  const at = (name, i) => {
    const v = bilinear(baseField(name, i), g.gx, g.gy);
    return Number.isFinite(v) ? v : NaN;
  };
  const s = { t: syn.times, t2m: [], td: [], t850: [], pr: [], cape: [], cin: [], spd: [], dir: [], mslp: [] };
  for (let i = 0; i < syn.times.length; i++) {
    const t2 = at('temperature_2m', i), t85 = at('temperature_850hPa', i);
    s.t2m.push(t2);
    s.td.push(at('dew_point_2m', i));
    s.t850.push(Number.isNaN(t85) ? t2 : t85);
    const p = at('precipitation', i);
    s.pr.push(Number.isNaN(p) ? 0 : Math.max(0, p));
    s.spd.push(at('wind_speed_10m', i));
    s.dir.push(windDirAt(i, g.gx, g.gy));
    s.mslp.push(at('pressure_msl', i));
    const ptc = pointAt('cape', syn.times[i]);
    const grc = at('cape', i);
    s.cape.push(ptc != null ? ptc : (Number.isNaN(grc) ? 0 : Math.max(0, grc)));
    s.cin.push(pointAt('cin', syn.times[i]));
  }
  s.now = synNowIndex();
  return s;
}

/* Contiguous wet stretches (≥0.1 mm/hr, single dry hours bridged) from `from`
   onward, each with its total, peak rate and peak CAPE. */
function precipEpisodes(s, from) {
  const out = [];
  let cur = null, gap = 0;
  for (let i = Math.max(0, from); i < s.t.length; i++) {
    if (s.pr[i] >= 0.1) {
      if (!cur) { cur = { i0: i, i1: i, total: 0, peak: 0, cape: 0 }; }
      cur.i1 = i; gap = 0;
    } else if (cur && ++gap > 1) {
      out.push(cur); cur = null; gap = 0;
    }
    if (cur) {
      cur.total += s.pr[i];
      cur.peak = Math.max(cur.peak, s.pr[i]);
      cur.cape = Math.max(cur.cape, s.cape[i] || 0);
    }
  }
  if (cur) out.push(cur);
  return out
    .filter((e) => e.total >= 0.5 || e.peak >= 0.4)
    .map((e) => Object.assign(e, { t0: s.t[e.i0], t1: s.t[e.i1] }));
}

/* Strongest convective inhibition in a window, as a magnitude (Open-Meteo
   reports CIN negative; take the absolute value so either sign works). */
function capStrength(s, i0, i1) {
  let mag = 0, have = false;
  for (let i = Math.max(0, i0); i <= i1 && i < s.t.length; i++) {
    const c = s.cin[i];
    if (Number.isFinite(c)) { have = true; mag = Math.max(mag, Math.abs(c)); }
  }
  return { have, mag };
}

/* The sharpest 6-hour 850 hPa temperature change ahead — an air mass swap,
   i.e. a front crossing DC — with the hour it actually happens. */
function frontalPassage(s, iEnd) {
  let best = null;
  for (let i = s.now; i + 6 <= iEnd; i++) {
    const d = s.t850[i + 6] - s.t850[i];
    if (!Number.isFinite(d)) continue;
    if (!best || Math.abs(d) > Math.abs(best.d)) best = { i, d };
  }
  if (!best || Math.abs(best.d) < 2.5) return null;
  let k = best.i;                                   // steepest single hour inside it
  for (let i = best.i; i < best.i + 6; i++) {
    const step = s.t850[i + 1] - s.t850[i];
    if (Math.sign(step) === Math.sign(best.d) && Math.abs(step) > Math.abs(s.t850[k + 1] - s.t850[k])) k = i;
  }
  return { at: s.t[k + 1], d: best.d, cold: best.d < 0, i0: best.i, i1: best.i + 6 };
}

/* Nearest pressure centers to DC at a given model hour. */
function centersNear(i, maxKm = 800) {
  let low = null, high = null;
  for (const m of findExtrema(i)) {
    const lat = SYN.LAT_N - m.y * SYN.DLAT, lon = SYN.LON_W + m.x * SYN.DLON;
    const d = kmBetween(DC.lat, DC.lon, lat, lon);
    if (d.km > maxKm) continue;
    const rec = { km: d.km, dir: compass8(d.dLatKm, d.dLonKm), v: m.v };
    if (m.type === 'L' && (!low || d.km < low.km)) low = rec;
    if (m.type === 'H' && (!high || d.km < high.km)) high = rec;
  }
  return { low, high };
}

const asNm = (km) => Math.round(km * 0.54 / 10) * 10;

/* Short "what's driving it" clause for a given model hour. */
function mechanismAt(i) {
  const f = nearestFront(i);
  if (f && f.km < 300) {
    const kind = f.adv < 0 ? 'cold' : 'warm';
    return f.km < 70 ? `a ${kind} front right overhead` : `a ${kind} front ~${asNm(f.km)} nm ${f.dir}`;
  }
  const { low } = centersNear(i);
  return low ? `a surface low ~${asNm(low.km)} nm ${low.dir}` : null;
}

/* ------------------------- forecast-number lookups ----------------------- */

function modelExtreme(s, dayKey, kind) {
  let best = null;
  for (let i = s.now; i < s.t.length; i++) {
    if (localDay(s.t[i]) !== dayKey || !Number.isFinite(s.t2m[i])) continue;
    const f = degF(s.t2m[i]);
    if (best == null || (kind === 'max' ? f > best : f < best)) best = f;
  }
  return best == null ? null : Math.round(best);
}

/* The daytime high that still matters: today's until late afternoon, then
   tomorrow's. NWS number when there is one, model otherwise. */
function daytimeHigh(s) {
  const now = Date.now();
  const past = localHour(now) >= 16;
  const key = localDay(past ? now + 86400000 : now);
  const label = past ? 'tomorrow' : 'today';
  const fd = FC.days && FC.days[key];
  if (fd && fd.hi != null) return { f: fd.hi, label, key, src: 'NWS forecast' };
  const m = s && modelExtreme(s, key, 'max');
  return m == null ? null : { f: m, label, key, src: 'GFS' };
}

function upcomingLow(s) {
  const now = Date.now(), h = localHour(now);
  const label = h < 6 ? 'by dawn' : 'tonight';
  for (const k of (h < 6 ? [localDay(now - 86400000), localDay(now)] : [localDay(now)])) {
    const fd = FC.days && FC.days[k];
    if (fd && fd.lo != null) return { f: fd.lo, label, src: 'NWS forecast' };
  }
  if (!s) return null;
  let lo = null;
  for (let i = s.now; i < s.t.length && s.t[i] <= now + 18 * 3600e3; i++) {
    if (Number.isFinite(s.t2m[i])) lo = lo == null ? degF(s.t2m[i]) : Math.min(lo, degF(s.t2m[i]));
  }
  return lo == null ? null : { f: Math.round(lo), label, src: 'GFS' };
}

function peakHeatIndex(s, dayKey) {
  let best = null;
  for (let i = s.now; i < s.t.length; i++) {
    if (localDay(s.t[i]) !== dayKey) continue;
    if (!Number.isFinite(s.t2m[i]) || !Number.isFinite(s.td[i])) continue;
    const tF = degF(s.t2m[i]);
    const hi = heatIndexF(tF, rhFrom(s.t2m[i], s.td[i]));
    if (!best || hi > best.hi) best = { hi, tF, dpF: degF(s.td[i]) };
  }
  return best;
}

function peakIn(s, key, hours) {
  const end = Date.now() + hours * 3600e3;
  let best = null;
  for (let i = s.now; i < s.t.length && s.t[i] <= end; i++) {
    const v = s[key][i];
    if (Number.isFinite(v) && (!best || v > best.v)) best = { v, i, at: s.t[i] };
  }
  return best;
}

/* Overnight radiation-fog window: spread closing with the wind going calm. */
function fogWindow(s) {
  for (let i = s.now; i < s.t.length; i++) {
    const h = localHour(s.t[i]);
    if (h > 9 || h < 1) continue;
    const spread = s.t2m[i] - s.td[i];
    if (!Number.isFinite(spread) || spread > 1.2 || !(s.spd[i] <= 5)) continue;
    return { at: s.t[i], spreadF: Math.max(1, Math.round(spread * 9 / 5)), kt: Math.max(1, Math.round(s.spd[i])) };
  }
  return null;
}

/* ------------------------------ the stories ------------------------------ */

/* The grid runs out to +49 h; something two days out shouldn't outrank what
   happens this afternoon just because it's bigger. */
function leadTimePenalty(ms) {
  const h = (ms - Date.now()) / 3600e3;
  return h > 30 ? 14 : h > 18 ? 7 : 0;
}

function buildStories(s) {
  const now = Date.now();
  const today = localDay(now), tmr = localDay(now + 86400000);
  const fcDay = (k) => (FC.days && FC.days[k]) || null;
  const stories = [];

  /* --- active alerts: the office has already decided this is the story --- */
  for (const a of HL.alerts.slice(0, 3)) {
    const rank = SEV_RANK[a.severity] || 1;
    const startMs = Date.parse(a.onset || a.effective || '');
    const endMs = Date.parse(a.ends || a.expires || '');
    let when = '';
    if (Number.isFinite(startMs) && startMs > now + 30 * 60000) when = ` from ${clockPhrase(startMs)}`;
    if (Number.isFinite(endMs) && endMs > now) when += `${when ? ' to ' : ' until '}${clockPhrase(endMs)}`;
    stories.push({
      key: `alert:${a.event}`,
      score: 58 + rank * 11,
      headline: `${a.event}${when}`,
      deck: alertWhat(a),
      alert: a,
    });
  }

  const eps = s ? precipEpisodes(s, s.now) : [];
  const ep = eps[0];

  /* --- convection vs. plain rain --- */
  if (ep) {
    const inches = ep.total / 25.4;
    const span = spanPhrase(ep.t0, ep.t1);
    const mech = mechanismAt(ep.i0);
    if (ep.cape >= 900) {
      const cap = capStrength(s, ep.i0, ep.i1);
      const capNote = !cap.have ? ''
        : cap.mag >= 75 ? ` A cap worth ${Math.round(cap.mag / 10) * 10} J/kg has to erode first, so timing is the whole question.`
        : cap.mag <= 25 ? ' Next to nothing is capping the column — whatever fires, fires early.' : '';
      stories.push({
        key: 'convection',
        score: 64 + (ep.cape >= 2000 ? 16 : ep.cape >= 1400 ? 9 : 0) + (inches >= 0.4 ? 5 : 0) - leadTimePenalty(ep.t0),
        headline: `Thunderstorms ${whenPhrase(ep.t0)}`,
        deck: `The model builds ${fmtJ(ep.cape)} J/kg of CAPE over DC and breaks precip out ${span}` +
          `${mech ? `, with ${mech}` : ''}. Peak rate near ${ep.peak.toFixed(1)} mm/hr — about ` +
          `${inches.toFixed(2)}″ if a cell tracks over the district.${capNote}`,
      });
    } else {
      const heavy = inches >= 0.75, trace = inches < 0.15;
      stories.push({
        key: 'rain',
        score: 44 + (heavy ? 26 : inches >= 0.3 ? 16 : trace ? 0 : 8) - leadTimePenalty(ep.t0),
        headline: heavy ? `Soaking rain ${whenPhrase(ep.t0)}`
          : trace ? `A few showers ${whenPhrase(ep.t0)}` : `Rain ${whenPhrase(ep.t0)}`,
        deck: `Steady, largely stratiform precip ${span}${mech ? ` as ${mech} works in` : ''} — ` +
          `${trace ? 'a few hundredths' : `about ${inches.toFixed(2)}″`} at DC in the GFS, peaking near ` +
          `${ep.peak.toFixed(1)} mm/hr. Little instability to work with, so wet rather than stormy.`,
      });
    }
  }

  /* --- air-mass change --- */
  if (s) {
    const fp = frontalPassage(s, s.t.length - 1);
    if (fp) {
      const w0 = dir8(s.dir[fp.i0]), w1 = dir8(s.dir[Math.min(s.t.length - 1, fp.i1)]);
      const shift = w0 !== w1 ? ` Surface wind swings ${w0} → ${w1}.` : '';
      const hiA = fcDay(today), hiB = fcDay(tmr);
      const swing = (hiA && hiA.hi != null && hiB && hiB.hi != null)
        ? ` Highs go ${hiA.hi}° today → ${hiB.hi}° tomorrow.` : '';
      stories.push({
        key: 'front',
        score: 48 + Math.min(22, Math.round(Math.abs(fp.d) * 3.5)) - leadTimePenalty(fp.at),
        headline: fp.cold ? `Cold front crosses ${whenPhrase(fp.at)}` : `Warm front lifts through ${whenPhrase(fp.at)}`,
        deck: `850 hPa temperatures ${fp.cold ? 'fall' : 'climb'} ${Math.abs(fp.d).toFixed(1)} °C in six hours ` +
          `around ${clockPhrase(fp.at)} — the air mass itself changing, not just the sky.${shift}${swing}`,
      });
    }
  }

  /* --- heat --- */
  const hot = daytimeHigh(s);
  if (hot && hot.f != null) {
    const hix = s ? peakHeatIndex(s, hot.key) : null;
    const muggy = hix && hix.hi - hot.f >= 4;
    let score = hot.f >= 97 ? 82 : hot.f >= 93 ? 64 : hot.f >= 88 ? 44 : 0;
    if (score && muggy) score += 6;
    if (score) {
      stories.push({
        key: 'heat',
        score,
        headline: hot.f >= 97 ? `Dangerous heat — ${hot.f}° ${hot.label}`
          : hot.f >= 93 ? `Heat peaks near ${hot.f}° ${hot.label}`
          : `Warm and humid — ${hot.f}° ${hot.label}`,
        deck: `${hot.src === 'NWS forecast' ? 'NWS has' : 'The model has'} a high of ${hot.f}° for DC ${hot.label}` +
          `${muggy ? `, and with dewpoints near ${Math.round(hix.dpF)}° the heat index runs to about ${Math.round(hix.hi)}°` : ''}. ` +
          'Density altitude goes up with it, so plan on longer takeoff rolls and a lazier climb out of KANP.',
      });
    }
  }

  /* --- cold --- */
  const lo = upcomingLow(s);
  if (lo && lo.f != null && lo.f <= 33) {
    stories.push({
      key: 'cold',
      score: lo.f <= 15 ? 76 : lo.f <= 25 ? 58 : 50,
      headline: lo.f <= 20 ? `Hard freeze ${lo.label} — low near ${lo.f}°` : `Freezing ${lo.label} — low near ${lo.f}°`,
      deck: `${lo.src === 'NWS forecast' ? 'NWS' : 'The model'} bottoms DC out at ${lo.f}° ${lo.label}. ` +
        'Frost on the wings and a cold-soaked airframe — allow for the preheat and a longer runup.',
    });
  }
  if (hot && hot.f != null && hot.f <= 38) {
    stories.push({
      key: 'coldday',
      score: 56,
      headline: `Cold day — high only ${hot.f}° ${hot.label}`,
      deck: `The air mass never really warms ${hot.label}: ${hot.src === 'NWS forecast' ? 'NWS' : 'the model'} ` +
        `holds the high at ${hot.f}°, so anything that falls has a good chance of staying frozen.`,
    });
  }

  /* --- wind --- */
  if (s) {
    const w = peakIn(s, 'spd', 24);
    if (w && w.v >= 16) {
      const xw = crosswindKANP(s.dir[w.i], w.v);
      stories.push({
        key: 'wind',
        score: (w.v >= 25 ? 62 : w.v >= 20 ? 48 : 40) - leadTimePenalty(w.at),
        headline: `${w.v >= 25 ? 'Strong' : 'Breezy'} ${dir8(s.dir[w.i])} wind ${whenPhrase(w.at)}`,
        deck: `Sustained ${Math.round(w.v)} kt from ${String(Math.round(s.dir[w.i] / 10) * 10).padStart(3, '0')}°T ` +
          `around ${clockPhrase(w.at)} — roughly ${xw.kt} kt of crosswind on runway ${xw.rwy} at KANP, gusts on top of that.`,
      });
    }
  }

  /* --- fog --- */
  if (s) {
    const fog = fogWindow(s);
    if (fog) {
      stories.push({
        key: 'fog',
        score: 44 - leadTimePenalty(fog.at),
        headline: `Fog likely ${whenPhrase(fog.at)}`,
        deck: `Temperature and dewpoint close to within ${fog.spreadF}°F with wind under ${fog.kt} kt near ` +
          `${clockPhrase(fog.at)} — the textbook radiation-fog setup. Expect IFR or worse at the outlying ` +
          'fields until the sun burns it off.',
      });
    }
  }

  /* --- quiet: the fallback that leads on most days --- */
  if (s) {
    const { high, low } = centersNear(s.now);
    const end = s.t[s.t.length - 1];
    const center = high ? `High pressure ${high.km < 90 ? 'sits overhead' : `~${asNm(high.km)} nm ${high.dir}`} ` +
      `(${Math.round(high.v)} hPa) has the region subsiding` : low ? 'No organized forcing is close enough to matter' : '';
    stories.push({
      key: 'quiet',
      score: eps.length ? 12 : 30,
      headline: eps.length ? 'Nothing dominant in the pattern' : 'Quiet pattern — nothing to dodge',
      deck: `${eps.length ? 'Beyond the precip above, the model has no other' : 'The model has no'} organized ` +
        `weather at DC through ${whenPhrase(end)}.${center ? ` ${center} — sinking air, dry column, good flying.` : ''}`,
    });
  }

  /* --- last resort: quote the forecast itself --- */
  const fd = fcDay(today);
  if (fd && fd.short) {
    stories.push({
      key: 'nws',
      score: 18,
      headline: fd.short,
      deck: `The NWS forecast for DC today: ${fd.short.toLowerCase()}` +
        `${fd.hi != null ? `, high near ${fd.hi}°` : ''}${fd.lo != null ? `, low ${fd.lo}°` : ''}` +
        `${fd.pop != null ? `, ${fd.pop}% chance of precip` : ''}.`,
    });
  }

  const best = new Map();
  for (const st of stories) {
    if (!best.has(st.key) || best.get(st.key).score < st.score) best.set(st.key, st);
  }
  return [...best.values()].sort((a, b) => b.score - a.score);
}

/* --------------------------- the numbers row ----------------------------- */

function headlineStats(s) {
  const now = Date.now();
  const tiles = [];
  const hot = daytimeHigh(s);
  if (hot && hot.f != null) {
    const hix = s ? peakHeatIndex(s, hot.key) : null;
    tiles.push({
      lab: `High ${hot.label}`,
      val: `${hot.f}°`,
      sub: hix && hix.hi - hot.f >= 4 ? `feels like ${Math.round(hix.hi)}°` : hot.src,
    });
  }
  const lo = upcomingLow(s);
  if (lo && lo.f != null) tiles.push({ lab: `Low ${lo.label}`, val: `${lo.f}°`, sub: lo.src });

  const fd = (FC.days && FC.days[localDay(now)]) || null;
  const eps = s ? precipEpisodes(s, s.now) : [];
  const total = eps.reduce((a, e) => a + e.total, 0) / 25.4;
  tiles.push({
    lab: 'Precip',
    val: fd && fd.pop != null ? `${fd.pop}%` : eps.length ? `${total.toFixed(2)}″` : 'none',
    sub: eps.length ? `~${total.toFixed(2)}″ from ${clockPhrase(eps[0].t0)}` : 'nothing in the model',
  });

  if (s) {
    const w = peakIn(s, 'spd', 12);
    const nowSpd = s.spd[s.now], nowDir = s.dir[s.now];
    if (Number.isFinite(nowSpd)) {
      tiles.push({
        lab: 'Wind now',
        val: `${dir8(nowDir)} ${Math.round(nowSpd)} kt`,
        sub: w && w.v - nowSpd >= 3 ? `${Math.round(w.v)} kt by ${clockPhrase(w.at)}` : `${String(Math.round(nowDir / 10) * 10).padStart(3, '0')}°T`,
      });
    }
    const cp = peakIn(s, 'cape', 24);
    if (cp && cp.v >= 400) {
      const cap = capStrength(s, cp.i - 2, cp.i + 2);
      tiles.push({
        lab: 'Storm fuel',
        val: `${fmtJ(cp.v)} J/kg`,
        sub: !cap.have ? `peak ${clockPhrase(cp.at)}`
          : cap.mag >= 50 ? `cap −${Math.round(cap.mag / 10) * 10} J/kg`
          : cap.mag <= 25 ? 'uncapped' : `peak ${clockPhrase(cp.at)}`,
      });
    }
  }
  return tiles.slice(0, 5);
}

/* ------------------------------ AFD extras ------------------------------- */

/* The office writes KEY MESSAGES only when something is going on — when it
   does, those bullets are literally its own headlines. */
function afdKeyMessages() {
  const secs = AFD.parsed.get(AFD.newestId) || [];
  const sec = secs.find((x) => /KEY MESSAGES/.test(x.name));
  if (!sec) return [];
  const body = sec.body.replace(/\r/g, '');
  const bullets = body.split(/\n(?=\s*[-*•]\s)/)
    .map((b) => normText(b).replace(/^[-*•]\s*/, '').replace(/^\d+[).]\s*/, ''))
    .filter((b) => b.length > 20);
  const list = bullets.length ? bullets : [normText(body)];
  return list.slice(0, 2).map((t) => (t.length > 190 ? t.slice(0, 187).replace(/\s\S*$/, '') + '…' : t));
}

/* ---------------- what's moved since the morning forecast ---------------- */
/* A go/no-go gets made in the morning and lived with all day. These two
   functions exist so the card can never go quiet about a day it mentioned
   earlier: silence reads as "threat's gone", which is exactly the wrong
   message when the forecast hasn't budged. */

const CONVECTIVE = /thunder|t-?storm/i;

/* The forecast as it stood at the start of today — the version a morning
   decision was made against. */
function morningSnap() {
  const snaps = (ARC.todayFc && ARC.todayFc.snaps) || [];
  return snaps.length ? { at: snaps[0].t * 1000, days: snaps[0].days || {} } : null;
}

/* Today + the next two days, each with the forecast wording and whether it
   has moved since that morning snapshot. Never returns "nothing to say". */
function outlook(n = 3) {
  const today = localDay(Date.now());
  const m = morningSnap();
  const when = m ? fmtTime(new Date(m.at), { hour: 'numeric', minute: '2-digit' }) : '';
  const rows = [];
  for (let k = 0; k < n; k++) {
    const date = shiftDay(today, k);
    const c = (FC.days && FC.days[date]) || null;
    if (!c) continue;
    const b = m ? m.days[date] : null;
    const row = { date, k, c, state: 'nobase', note: 'no morning forecast archived to compare' };
    if (b) {
      const wasT = CONVECTIVE.test(b.short || ''), isT = CONVECTIVE.test(c.short || '');
      const dPop = (c.pop != null && b.pop != null) ? c.pop - b.pop : 0;
      if (wasT !== isT) {
        row.state = 'flip';
        row.note = isT
          ? `storms added since ${when} — they weren't in the morning forecast`
          : `storms dropped since ${when} — the morning forecast had “${b.short}”`;
      } else if (c.short && b.short && c.short !== b.short) {
        row.state = 'moved';
        row.note = `was “${b.short}”${b.pop != null ? ` ${b.pop}%` : ''} at ${when}`;
      } else if (Math.abs(dPop) >= 15) {
        row.state = 'moved';
        row.note = `chance was ${b.pop}% at ${when}`;
      } else {
        row.state = 'same';
        row.note = `unchanged since ${when}`;
      }
    }
    rows.push(row);
  }
  return rows;
}

/* The office's own account of what moved — the honest answer to "why is this
   different from this morning?". */
function afdWhatChanged() {
  const secs = AFD.parsed.get(AFD.newestId) || [];
  const s = secs.find((x) => /^(WHAT HAS CHANGED|UPDATE)/.test(x.name));
  if (!s) return null;
  const t = normText(s.body);
  const m = t.match(/^(?:.*?[.!?](?=\s|$)\s*){1,2}/);
  const out = (m ? m[0] : t).trim();
  return out.length > 300 ? out.slice(0, 297).replace(/\s\S*$/, '') + '…' : out;
}

function firstSentence(t, max = 175) {
  const m = String(t).match(/^.*?[.!?](?=\s|$)/);
  let out = m ? m[0] : String(t);
  if (out.length > max) out = out.slice(0, max - 1).replace(/\s\S*$/, '') + '…';
  return out;
}

/* Where the model read and the office disagree, say so — the split is itself
   a forecast signal, and staying quiet about it would read as agreement.
   Compares the GFS precip/CAPE picture at DC (next 36 h) against the NWS
   forecast wording + AFD key messages for today/tomorrow. Silent when they
   agree or when either side is missing. */
function renderSplit(s) {
  const host = $('hl-split');
  if (!host) return;
  host.innerHTML = '';
  if (!s || !FC.days) return;
  const today = localDay(Date.now());
  const fc = [FC.days[today], FC.days[shiftDay(today, 1)]].filter(Boolean);
  if (!fc.length) return;
  const officeTxt = fc.map((d) => d.short || '').join(' ') + ' ' + afdKeyMessages().join(' ');
  const officeStorm = CONVECTIVE.test(officeTxt);
  const officeWet = officeStorm || /rain|shower|drizzle|snow|sleet|ice/i.test(officeTxt)
    || fc.some((d) => (d.pop || 0) >= 40);
  const ep = precipEpisodes(s, s.now).find((e) => e.t0 <= Date.now() + 36 * 3600000);
  const modelStorm = !!ep && ep.cape >= 900;
  const modelWet = !!ep;
  let msg = null;
  if (officeStorm && !modelStorm) {
    msg = 'LWX carries thunder that the GFS point read at DC doesn\'t build. ' +
      'Weight the office — one model at one point misses mesoscale triggers.';
  } else if (modelStorm && !officeStorm) {
    msg = 'The GFS builds storm fuel at DC that the NWS forecast doesn\'t carry — ' +
      'treat any storm line above as low-confidence until LWX picks it up.';
  } else if (officeWet && !modelWet) {
    msg = 'NWS carries precip the GFS point read at DC misses — believe the forecast ' +
      'over the model\'s silence.';
  } else if (modelWet && !officeWet) {
    msg = 'The GFS paints precip at DC that the NWS forecast doesn\'t mention — ' +
      'low-confidence precip.';
  }
  if (msg) host.innerHTML = `<span class="lab">Model vs LWX</span>${esc(msg)}`;
}

/* -------------------------------- render --------------------------------- */

function renderHeadline(lead, tiles, alsos, keyMsgs, atmosSeries) {
  $('hl-title').textContent = lead.headline;
  $('hl-deck').textContent = lead.deck;
  $('hl-stamp').textContent =
    `as of ${fmtTime(new Date(), { hour: 'numeric', minute: '2-digit' })} · GFS + NWS ${OFFICE}`;

  /* When an alert is itself the lead, the kicker carries the warning and the
     pill row drops it — no point printing the same watch twice. */
  const kick = $('hl-kick');
  const leadRank = lead.alert ? (SEV_RANK[lead.alert.severity] || 1) : 0;
  kick.className = 'hl-kick' + (leadRank >= 3 ? ' red' : leadRank ? ' amber' : '');
  kick.textContent = leadRank ? '⚠ Active alert · the big story' : 'The big story';

  $('hl-alerts').innerHTML = HL.alerts
    .filter((a) => a !== lead.alert)
    .slice(0, 3)
    .map((a) => {
      const rank = SEV_RANK[a.severity] || 1;
      const end = Date.parse(a.ends || a.expires || '');
      const win = Number.isFinite(end) && end > Date.now()
        ? `<span class="win">until ${esc(clockPhrase(end))}</span>` : '';
      return `<span class="hl-alert ${rank >= 3 ? 'red' : 'amber'}">⚠ <b>${esc(a.event)}</b>${win}</span>`;
    }).join('');

  $('hl-stats').innerHTML = tiles.map((t) =>
    `<div class="hl-stat"><div class="lab">${esc(t.lab)}</div><div class="val">${esc(t.val)}</div>` +
    `${t.sub ? `<div class="sub">${esc(t.sub)}</div>` : ''}</div>`).join('');

  const changed = afdWhatChanged();
  $('hl-changed').innerHTML = changed
    ? `<span class="lab">LWX changes</span>${esc(changed)} ` +
      `<a class="more-link" href="#reasoning">full discussion ↓</a>`
    : '';

  /* Detail lives with the act it belongs to, not in the headline. */
  const days = outlook();
  $('since-morning').innerHTML = days.length
    ? days.map((r) => {
      const label = r.k === 0 ? 'Today' : r.k === 1 ? 'Tomorrow'
        : fmtTime(new Date(r.date + 'T12:00:00'), { weekday: 'long' });
      const wx = `${r.c.short || '—'}${r.c.pop != null ? ` · ${r.c.pop}%` : ''}`;
      return `<div class="ol-row ${esc(r.state)}"><span class="d">${esc(label)}</span>` +
        `<span class="w">${esc(wx)}</span><span class="chg">${esc(r.note)}</span></div>`;
    }).join('')
    : '<span class="faint" style="font-size:13px">No forecast loaded to compare.</span>';

  $('also-stories').innerHTML = alsos.length
    ? `<div class="sn-head">Also in play</div>` + alsos.map((x) =>
      `<div class="item"><b>${esc(x.title)}</b> — ${esc(x.text)}</div>`).join('')
    : '';
  renderBigPicture(keyMsgs);
  renderAtmos(atmosSeries);
}

/* ---------------------- Act II: the story, then the physics -------------- */

/* Sentence split that survives decimals and "vs. 12Z": a boundary only where
   the punctuation is followed by a capital (or the end). */
const SENT_RE = /[^.!?]+(?:[.!?]+(?!\s+[A-Z("“]|\s*$)[^.!?]*)*[.!?]+/g;

/* The here-and-now paragraph of the discussion. The LWX DISCUSSION format
   opens with an essay per key message in news order, so its first sentence is
   routinely about the biggest day of the week, not this one — Sunday's severe
   setup once led this card while it was raining outside. Score each paragraph
   by its present-tense sentences ("today", "this afternoon", "ongoing"…)
   against its references to other days, and quote the winner: the first
   now-sentence to set the scene, then the later now-sentence with the most
   weather in it. Null when no paragraph is about now (typical of evening
   issuances, which look ahead) — the caller falls back to the old lead. */
const NOW_WORDS = /\b(?:today|tonight|this (?:morning|afternoon|evening)|currently|ongoing|under\s?way|ha(?:s|ve) begun|is beginning|in progress|right now|at the moment|(?:last|past) few hours)\b/i;
const WX_WORDS = /shower|storm|thunder|rain|drizzle|snow|sleet|fog|lightning|convecti/gi;

function nowLead(secs, quoted) {
  const sec = secs.find((x) => /^(NEAR TERM|DISCUSSION|UPDATE)/.test(x.name));
  if (!sec) return null;
  const wd = fmtTime(new Date(), { weekday: 'long' });
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const ahead = new RegExp(
    `\\b(?:tomorrow|next week|(?:on|for|into|by|through|toward) (?:${days.filter((d) => d !== wd).join('|')}))\\b`, 'gi');
  let best = null;
  for (const raw of sec.body.split(/\n\s*\n/)) {
    const p = normText(raw);
    if (p.length < 60 || /^KEY MESSAGES?\b/i.test(p)) continue;
    const nows = (p.match(SENT_RE) || [p]).map((x) => x.trim())
      .filter((x) => NOW_WORDS.test(x) && x.length >= 30 && !quoted(x));
    const score = nows.length * 2 - (p.match(ahead) || []).length;
    if (nows.length && score > 0 && (!best || score > best.score)) best = { score, nows };
  }
  if (!best) return null;
  let second = null;
  for (const x of best.nows.slice(1)) {
    const wx = (x.match(WX_WORDS) || []).length;
    if (!second || wx > second.wx) second = { x, wx };
  }
  let out = best.nows[0] + (second ? ' ' + second.x : '');
  if (out.length > 360) out = out.slice(0, 357).replace(/\s\S*$/, '') + '…';
  return out;
}

/* The office's own framing, trimmed: the here-and-now paragraph when the
   discussion has one, its opening reasoning otherwise, then its key messages
   as bullets. Not the whole product — that sits collapsed at the bottom of
   the act. WHAT HAS CHANGED is a last resort here — the headline card
   already quotes it, and the office often repeats it inside KEY MESSAGES
   too, so without the dedupe below the same sentence printed three times on
   the page. */
function renderBigPicture(keyMsgs) {
  const secs = AFD.parsed.get(AFD.newestId) || [];
  const overlaps = (a, b) => a && b && (a.includes(b) || b.includes(a));
  const changed = afdWhatChanged();
  const quoted = (s) => overlaps(s, changed) || keyMsgs.some((k) => overlaps(s, k));
  const now = nowLead(secs, quoted);
  let lead = '';
  if (!now) {
    const pick = secs.find((x) => /^SYNOPSIS/.test(x.name))
      || secs.find((x) => /^(DISCUSSION|NEAR TERM)/.test(x.name))
      || secs.find((x) => /^(UPDATE|WHAT HAS CHANGED)/.test(x.name)) || secs[0];
    /* Lead = the first sentence of actual reasoning. The LWX format opens
       DISCUSSION with "KEY MESSAGE n..." lines restating what the headline
       card already quotes — skip those, or the same sentence prints three
       times on the page. */
    const toks = pick ? (normText(pick.body).match(SENT_RE) || [normText(pick.body)]) : [];
    for (const tk of toks) {
      const s = tk.trim();
      if (/^KEY MESSAGES?\b/i.test(s) || s.length < 30 || quoted(s)) continue;
      lead = s; break;
    }
    if (!lead && toks.length) lead = toks[0].trim();
    if (lead.length > 260) lead = lead.slice(0, 257).replace(/\s\S*$/, '') + '…';
  }
  const top = now || lead;
  const kms = keyMsgs.filter((t) => !overlaps(t, top) && !overlaps(t, changed));
  const newest = AFD.list[0];
  const stamp = newest ? `<div class="bp-stamp">LWX, issued ` +
    `${esc(fmtTime(new Date(newest.issuanceTime), { hour: 'numeric', minute: '2-digit' }))} ` +
    `(${esc(timeAgo(new Date(newest.issuanceTime)))})</div>` : '';
  $('big-picture').innerHTML = top
    ? (now ? '<span class="bp-now">Now</span>' : '') + esc(top)
      + kms.map((t) => `<div class="km">${esc(t)}</div>`).join('') + stamp
    : '<span class="faint" style="font-size:13px">No discussion loaded.</span>';
}

/* The six numbers the story rests on, at DC, next 24 h. Value plus what it
   means in two or three words — no paragraphs. */
function renderAtmos(s) {
  const host = $('atmos');
  if (!s) { host.innerHTML = '<span class="faint" style="font-size:13px">Model grid unavailable.</span>'; return; }
  const cells = [];
  const add = (lab, val, say, hot) => cells.push({ lab, val, say, hot });

  const cape = peakIn(s, 'cape', 24);
  if (cape) {
    add('Instability', `${fmtJ(cape.v)} J/kg`,
      cape.v >= 2000 ? `big fuel, peaks ${clockPhrase(cape.at)}`
        : cape.v >= 1000 ? `storm fuel, peaks ${clockPhrase(cape.at)}`
        : cape.v >= 400 ? 'enough for showers' : 'nothing to work with',
      cape.v >= 1500);
  }
  const cap = capStrength(s, s.now, Math.min(s.t.length - 1, s.now + 24));
  if (cap.have) {
    add('Cap', `−${Math.round(cap.mag / 10) * 10} J/kg`,
      cap.mag >= 75 ? 'lid holds storms down' : cap.mag <= 25 ? 'nothing holding it back' : 'weak lid');
  }
  const t850 = s.t850[s.now];
  const t850b = s.t850[Math.min(s.t.length - 1, s.now + 24)];
  if (Number.isFinite(t850) && Number.isFinite(t850b)) {
    const d = t850b - t850;
    add('Air mass', `${t850.toFixed(0)} °C`,
      Math.abs(d) < 2 ? 'same air all day'
        : `${d < 0 ? 'colder' : 'warmer'} by ${Math.abs(d).toFixed(0)}° in 24 h`);
  }
  const spread = s.t2m[s.now] - s.td[s.now];
  if (Number.isFinite(spread)) {
    const f = Math.max(0, Math.round(spread * 9 / 5));
    add('Moisture', `${f}°F spread`,
      f <= 2 ? 'saturated — ceilings first' : f <= 8 ? 'moist' : 'dry column', f <= 2);
  }
  const tm = Math.max(0, s.now - 3), tp = Math.min(s.t.length - 1, s.now + 3);
  const dP = s.mslp[tp] - s.mslp[tm];
  if (Number.isFinite(dP)) {
    add('Pressure', `${dP >= 0 ? '+' : ''}${dP.toFixed(1)} hPa/6h`,
      dP <= -1.5 ? 'system still deepening' : dP >= 1.5 ? 'high building in' : 'steady');
  }
  const f = nearestFront(s.now);
  const { low } = centersNear(s.now);
  if (f && f.km < 400) {
    add('Forcing', `${asNm(f.km)} nm ${f.dir}`, `${f.adv < 0 ? 'cold' : 'warm'} front`);
  } else if (low) {
    add('Forcing', `${asNm(low.km)} nm ${low.dir}`, 'surface low');
  } else {
    add('Forcing', 'none near', 'no boundary in reach');
  }

  host.innerHTML = cells.map((c) =>
    `<div class="atmos-cell${c.hot ? ' hot' : ''}"><div class="lab">${esc(c.lab)}</div>` +
    `<div class="val">${esc(c.val)}</div><div class="say">${esc(c.say)}</div></div>`).join('');
}

function buildHeadline() {
  try {
    const s = syn.ready ? dcSeries() : null;
    const stories = buildStories(s);
    const keyMsgs = afdKeyMessages();
    let lead = stories[0];
    if (!lead) {                       // model, forecast and alerts all missing
      const secs = AFD.parsed.get(AFD.newestId) || [];
      const sec = secs.find((x) => /^(SYNOPSIS|UPDATE|WHAT HAS CHANGED)/.test(x.name)) || secs[0];
      const text = keyMsgs[0] || (sec ? firstSentence(normText(sec.body), 280) : '');
      lead = text
        ? { headline: 'Straight from the forecast office', deck: text }
        : { headline: 'Headline unavailable', deck: 'None of the sources this page reads came back — try refreshing.' };
    }

    const alsos = [];
    for (const st of stories.slice(1)) {
      if (alsos.length >= 3 || st.score < 40) break;
      if (st.alert) continue;          // already shown as a pill above the headline
      alsos.push({ title: st.headline, text: firstSentence(st.deck) });
    }
    renderHeadline(lead, headlineStats(s), alsos, keyMsgs.filter((km) => km !== lead.deck), s);
    renderSplit(s);
  } catch (e) {
    $('hl-title').textContent = 'Headline unavailable';
    $('hl-deck').textContent = `Couldn't assemble it: ${e.message}. Everything below still stands on its own.`;
  }
}

/* ===========================================================================
   14-day history — the epilogue card. KDCA's hourly altimeter over the last
   two weeks (obs stream of data/wx/) with the weather the METARs actually
   recorded — rain, thunder, fog, gusts — drawn as bands under the trace and
   LWX warnings (alerts stream) as a lane along the top. Notable episodes are
   listed underneath, including pressure swings big enough to matter
   (>= HIST_SWING inHg between turning points; the diurnal wobble is ~0.05).
   Card stays hidden if the archive is unreachable.
   =========================================================================== */

const HIST_DAYS = 14;
const HIST_LANES = 10;              // parallel same-origin fetches
const HIST_GAP_MS = 2.5 * 3600e3;   // METAR gap that still counts as one episode
const HIST_TURN = 0.08;             // inHg reversal that ends a rise/fall
const HIST_SWING = 0.18;            // inHg between turning points worth reporting
const HIST_GUST_KT = 25;

const HIST = { obs: [], eps: null, alerts: [], cape: [], canvas: null, scale: null };

const WX_CHUNK = {
  TS: 'thunder', SH: 'showers', FZ: 'freezing', RA: 'rain', DZ: 'drizzle',
  SN: 'snow', SG: 'snow grains', IC: 'ice crystals', PL: 'ice pellets',
  GR: 'hail', GS: 'small hail', UP: 'precip', FG: 'fog', BR: 'mist',
  HZ: 'haze', FU: 'smoke', SQ: 'squall', FC: 'funnel cloud', DU: 'dust',
  SA: 'sand', VA: 'ash', PO: 'dust whirls', SS: 'sandstorm', DS: 'duststorm',
  MI: 'shallow', BC: 'patchy', PR: 'partial', DR: 'drifting', BL: 'blowing',
};
const WX_PRECIP = /RA|DZ|SN|SG|PL|GR|GS|UP/;

function parseHistMetar(ts, raw) {
  const body = raw.split(' RMK')[0];
  const alt = /\bA(\d{4})\b/.exec(body);
  const wind = /\b(?:\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?KT\b/.exec(body);
  const wx = [];
  for (const tok of body.split(' ')) {
    const core = tok.replace(/^[+-]/, '').replace(/^VC/, '');
    const chunks = core.length && core.length % 2 === 0 && core.length <= 8 && core.match(/.{2}/g);
    if (chunks && chunks.every((c) => WX_CHUNK[c])) wx.push(tok);
  }
  return {
    t: ts * 1000,
    alt: alt ? +alt[1] / 100 : null,
    spd: wind ? +wind[1] : null,
    gust: wind && wind[2] ? +wind[2] : 0,
    wx,
    thunder: wx.some((w) => w.includes('TS')),
    precip: wx.some((w) => !w.startsWith('VC') && WX_PRECIP.test(w)),
    fog: wx.some((w) => w.replace(/^[+-]/, '').replace(/^VC/, '').includes('FG')),
  };
}

function wxWords(tok) {
  const pre = (tok.startsWith('+') ? 'heavy ' : tok.startsWith('-') ? 'light ' : '') +
    (tok.replace(/^[+-]/, '').startsWith('VC') ? 'nearby ' : '');
  const core = tok.replace(/^[+-]/, '').replace(/^VC/, '');
  return pre + core.match(/.{2}/g).map((c) => WX_CHUNK[c]).join(' ');
}

/* Contiguous runs of obs where flag() holds, tolerating one missing hour. */
function histEpisodes(obs, flag) {
  const eps = [];
  let cur = null;
  for (const o of obs) {
    if (!flag(o)) continue;
    if (cur && o.t - cur.t1 <= HIST_GAP_MS) { cur.t1 = o.t; cur.list.push(o); }
    else { cur = { t0: o.t, t1: o.t, list: [o] }; eps.push(cur); }
  }
  return eps;
}

/* Zigzag turning points of the altimeter trace (ignores the diurnal wobble). */
function pressureTurns(pts) {
  if (pts.length < 4) return [];
  const turns = [pts[0]];
  let dir = 0, ext = pts[0];
  for (const o of pts) {
    if (dir === 0) {
      if (o.alt - ext.alt >= HIST_TURN) dir = 1;
      else if (ext.alt - o.alt >= HIST_TURN) dir = -1;
      if (dir !== 0) { ext = o; continue; }
      if (o.alt > turns[0].alt) { turns[0] = o; ext = o; }
    } else if (dir === 1) {
      if (o.alt >= ext.alt) ext = o;
      else if (ext.alt - o.alt >= HIST_TURN) { turns.push(ext); dir = -1; ext = o; }
    } else if (o.alt <= ext.alt) { ext = o; }
    else if (o.alt - ext.alt >= HIST_TURN) { turns.push(ext); dir = 1; ext = o; }
  }
  turns.push(ext);
  return turns;
}

const HIST_D = (ms) => fmtTime(new Date(ms), { month: 'short', day: 'numeric' });
const HIST_H = (ms) => fmtTime(new Date(ms), { hour: 'numeric' });

function histSpan(t0, t1) {
  const d0 = HIST_D(t0), d1 = HIST_D(t1);
  if (d0 !== d1) return `${d0} ${HIST_H(t0)} → ${d1} ${HIST_H(t1)}`;
  return t1 - t0 < 3600e3 ? `${d0}, ${HIST_H(t0)}` : `${d0}, ${HIST_H(t0)}–${HIST_H(t1)}`;
}

/* The episode's dominant phenomenon ("Rain", "Snow", …) by token count. */
function histPhenom(ep) {
  const n = {};
  for (const o of ep.list) for (const w of o.wx) {
    const m = w.match(/RA|DZ|SN|GR|PL|UP/);
    if (m) n[m[0]] = (n[m[0]] || 0) + 1;
  }
  const top = Object.keys(n).sort((a, b) => n[b] - n[a])[0];
  const word = top ? WX_CHUNK[top] : 'precip';
  return word[0].toUpperCase() + word.slice(1);
}

function histEvents() {
  const evs = [];
  const push = (t0, t1, what) => evs.push({ t: t1, when: histSpan(t0, t1), what });
  const overlaps = (a, b) => a.t0 <= b.t1 && a.t1 >= b.t0;
  for (const e of HIST.eps.precip) {
    const th = HIST.eps.thunder.some((s) => overlaps(s, e));
    const heavy = e.list.some((o) => o.wx.some((w) => w.startsWith('+')));
    push(e.t0, e.t1, `<b>${esc(histPhenom(e))}${th ? ' with thunder' : ''}</b>` +
      (heavy ? ', heavy at times' : ''));
  }
  for (const e of HIST.eps.thunder) {
    if (!HIST.eps.precip.some((s) => overlaps(s, e))) {
      push(e.t0, e.t1, '<b>Thunder</b> without measurable rain at the field');
    }
  }
  for (const e of HIST.eps.fog) push(e.t0, e.t1, '<b>Fog</b>');
  for (const e of HIST.eps.gust) {
    const peak = Math.max(...e.list.map((o) => o.gust));
    push(e.t0, e.t1, `<b>Gusty winds</b> — peak ${peak} kt`);
  }
  const turns = pressureTurns(HIST.obs.filter((o) => o.alt != null));
  for (let i = 1; i < turns.length; i++) {
    const a = turns[i - 1], b = turns[i], d = b.alt - a.alt;
    if (Math.abs(d) < HIST_SWING) continue;
    const h = Math.round((b.t - a.t) / 3600e3);
    push(a.t, b.t, d < 0
      ? `<b>Pressure fell ${(-d).toFixed(2)} inHg</b> over ${h} h, bottoming at ${b.alt.toFixed(2)} — a front or low moving through`
      : `<b>Pressure rose ${d.toFixed(2)} inHg</b> over ${h} h — high pressure building in`);
  }
  for (const a of HIST.alerts) {
    push(a.t0, a.t1, `<b>${esc(a.event)}</b> — LWX warning in effect`);
  }
  return evs.sort((x, y) => y.t - x.t).slice(0, 12);
}

function histSummary() {
  const pts = HIST.obs.filter((o) => o.alt != null);
  const last = pts[pts.length - 1];
  let hi = pts[0], lo = pts[0];
  for (const o of pts) { if (o.alt > hi.alt) hi = o; if (o.alt < lo.alt) lo = o; }
  return `now <b>${last.alt.toFixed(2)}</b> inHg · 14-day high ` +
    `${hi.alt.toFixed(2)} (${esc(HIST_D(hi.t))}) · low ${lo.alt.toFixed(2)} ` +
    `(${esc(HIST_D(lo.t))}) — hover the trace for any hour`;
}

function drawHist() {
  const host = $('hist-chart');
  const W = Math.max(host.clientWidth || 0, 320), H = 195;
  const dpr = window.devicePixelRatio || 1;
  let c = HIST.canvas;
  if (!c) {
    c = HIST.canvas = document.createElement('canvas');
    host.appendChild(c);
    c.addEventListener('mousemove', histHover);
    c.addEventListener('mouseleave', () => { $('hist-read').innerHTML = histSummary(); });
  }
  c.width = W * dpr; c.height = H * dpr;
  c.style.width = `${W}px`; c.style.height = `${H}px`;
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);

  const L = 36, R = 6, T = 24, B = 20;
  const plotW = W - L - R, plotH = H - T - B;
  const pts = HIST.obs.filter((o) => o.alt != null);
  const t0 = HIST.obs[0].t, t1 = HIST.obs[HIST.obs.length - 1].t;
  let pLo = Infinity, pHi = -Infinity;
  for (const o of pts) { pLo = Math.min(pLo, o.alt); pHi = Math.max(pHi, o.alt); }
  const padP = Math.max((pHi - pLo) * 0.08, 0.02);
  pLo -= padP; pHi += padP;
  const x = (t) => L + ((t - t0) / (t1 - t0)) * plotW;
  const y = (p) => T + (1 - (p - pLo) / (pHi - pLo)) * plotH;
  HIST.scale = { x, t0, t1, L, plotW };

  const band = (eps, color) => {
    g.fillStyle = color;
    for (const e of eps) {
      const x0 = Math.max(x(e.t0 - 1800e3), L);
      g.fillRect(x0, T, Math.max(x(e.t1 + 1800e3) - x0, 2), plotH);
    }
  };
  band(HIST.eps.fog, 'rgba(170,180,190,.10)');
  band(HIST.eps.precip, 'rgba(88,166,255,.16)');
  band(HIST.eps.thunder, 'rgba(240,160,70,.22)');
  g.font = '11px sans-serif';
  g.textAlign = 'center';
  g.fillStyle = '#f5b942';
  for (const e of HIST.eps.thunder) g.fillText('⚡', x((e.t0 + e.t1) / 2), T + 12);
  g.fillStyle = 'rgba(245,185,66,.55)';                       // gust ticks, bottom edge
  for (const e of HIST.eps.gust) {
    const x0 = Math.max(x(e.t0 - 1800e3), L);
    g.fillRect(x0, T + plotH - 3, Math.max(x(e.t1 + 1800e3) - x0, 2), 3);
  }
  g.fillStyle = 'rgba(224,106,90,.85)';                       // LWX warning lane
  for (const a of HIST.alerts) {
    const x0 = Math.max(x(a.t0), L), x1 = Math.min(x(a.t1), L + plotW);
    if (x1 > x0) g.fillRect(x0, 8, Math.max(x1 - x0, 2), 5);
  }

  /* storm fuel: hourly GFS CAPE on its own scale, kept to the lower half so
     the pressure trace stays readable; contiguous runs only, so a hole in
     the model archive shows as a hole, not a bridge */
  const cp = HIST.cape.filter((p) => p.t >= t0 && p.t <= t1);
  if (cp.length > 1) {
    const capeMax = Math.max(1000, Math.ceil(Math.max(...cp.map((p) => p.v)) / 500) * 500);
    const yC = (v) => T + plotH - (v / capeMax) * plotH * 0.55;
    const runs = [[]];
    for (const p of cp) {
      const run = runs[runs.length - 1];
      if (run.length && p.t - run[run.length - 1].t > 2 * 3600e3) runs.push([p]);
      else run.push(p);
    }
    for (const run of runs) {
      if (run.length < 2) continue;
      g.beginPath();
      g.moveTo(x(run[0].t), T + plotH);
      for (const p of run) g.lineTo(x(p.t), yC(p.v));
      g.lineTo(x(run[run.length - 1].t), T + plotH);
      g.closePath();
      g.fillStyle = 'rgba(240,160,70,.13)';
      g.fill();
      g.beginPath();
      run.forEach((p, j) => g[j ? 'lineTo' : 'moveTo'](x(p.t), yC(p.v)));
      g.strokeStyle = 'rgba(240,160,70,.65)'; g.lineWidth = 1;
      g.stroke();
    }
    g.fillStyle = '#c08a4a'; g.font = '10px sans-serif'; g.textAlign = 'right';
    g.fillText(`CAPE ${capeMax.toLocaleString('en-US')} J/kg`, L + plotW - 3, yC(capeMax) - 4);
    g.strokeStyle = 'rgba(240,160,70,.25)';
    g.beginPath(); g.moveTo(L, yC(capeMax)); g.lineTo(L + plotW, yC(capeMax)); g.stroke();
  }

  /* day gridlines + labels at local midnight */
  g.strokeStyle = '#232a30'; g.lineWidth = 1;
  g.fillStyle = '#667077'; g.font = '10px sans-serif'; g.textAlign = 'center';
  const dayW = plotW / HIST_DAYS;
  const every = dayW < 46 ? 2 : 1;
  let li = 0;
  for (let t = t0 - (t0 % 3600e3); t <= t1; t += 3600e3) {
    if (+HOUR24.format(new Date(t)) !== 0) continue;
    g.beginPath(); g.moveTo(x(t), T); g.lineTo(x(t), T + plotH); g.stroke();
    if (li++ % every === 0 && x(t) + dayW / 2 < L + plotW) {
      g.fillText(HIST_D(t + 12 * 3600e3), x(t) + dayW / 2, H - 6);
    }
  }
  /* pressure gridlines */
  const step = pHi - pLo > 0.5 ? 0.2 : 0.1;
  g.textAlign = 'left';
  for (let p = Math.ceil(pLo / step) * step; p < pHi; p += step) {
    g.strokeStyle = '#20262c';
    g.beginPath(); g.moveTo(L, y(p)); g.lineTo(L + plotW, y(p)); g.stroke();
    g.fillText(p.toFixed(1), 4, y(p) + 3);
  }

  /* the trace itself, broken across gaps > 4 h */
  g.strokeStyle = '#7fb2d9'; g.lineWidth = 1.5; g.lineJoin = 'round';
  g.beginPath();
  let prev = null;
  for (const o of pts) {
    if (prev == null || o.t - prev > 4 * 3600e3) g.moveTo(x(o.t), y(o.alt));
    else g.lineTo(x(o.t), y(o.alt));
    prev = o.t;
  }
  g.stroke();

  let hi = pts[0], lo = pts[0];
  for (const o of pts) { if (o.alt > hi.alt) hi = o; if (o.alt < lo.alt) lo = o; }
  const mark = (o, color, above) => {
    g.beginPath(); g.arc(x(o.t), y(o.alt), 2.6, 0, Math.PI * 2);
    g.fillStyle = color; g.fill();
    g.textAlign = 'center';
    g.fillText(o.alt.toFixed(2), Math.min(Math.max(x(o.t), L + 16), L + plotW - 16),
      y(o.alt) + (above ? -6 : 12));
  };
  mark(hi, '#e8a15a', true);
  mark(lo, '#6fb1e0', false);
  const last = pts[pts.length - 1];
  g.beginPath(); g.arc(x(last.t), y(last.alt), 2.8, 0, Math.PI * 2);
  g.fillStyle = '#fff'; g.fill();
}

function histHover(ev) {
  const s = HIST.scale;
  if (!s) return;
  const mx = ev.offsetX;
  const t = s.t0 + ((mx - s.L) / s.plotW) * (s.t1 - s.t0);
  let best = null;
  for (const o of HIST.obs) if (!best || Math.abs(o.t - t) < Math.abs(best.t - t)) best = o;
  if (!best) return;
  const bits = [`<b>${best.alt != null ? best.alt.toFixed(2) : '—'}</b> inHg`];
  if (best.wx.length) bits.push(esc(best.wx.map(wxWords).join(', ')));
  if (best.spd != null) bits.push(`wind ${best.spd}${best.gust ? `G${best.gust}` : ''} kt`);
  let cp = null;
  for (const p of HIST.cape) if (!cp || Math.abs(p.t - best.t) < Math.abs(cp.t - best.t)) cp = p;
  if (cp && Math.abs(cp.t - best.t) <= 3600e3) bits.push(`CAPE ${fmtJ(cp.v)} J/kg`);
  $('hist-read').innerHTML =
    `${esc(fmtTime(new Date(best.t), { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))} — ${bits.join(' · ')}`;
}

async function loadHistory() {
  const idx = await WXA.index();
  if (!idx) return;
  const dates = (idx.obs_days || []).slice(-HIST_DAYS);
  if (dates.length < 3) return;
  const aDates = (idx.alert_days || []).filter((d) => d >= dates[0]);
  const mDates = (idx.model_days || []).filter((d) => d >= dates[0]);
  const seen = new Set(), obs = [], alerts = new Map(), cape = new Map();
  const addRaw = (ts, raw) => {
    if (seen.has(ts)) return;
    seen.add(ts);
    obs.push(parseHistMetar(ts, raw));
  };
  /* Hourly CAPE out of a model snapshot, clipped to one local day. A snap's
     t0 is the hour it was fetched, so no single snap covers its whole day —
     walking a day's snaps in order fills the day with the freshest analysis
     of each hour (later writes win in the map). */
  const addCape = (snap, date) => {
    if (!snap || !snap.cape || snap.t0 == null) return;
    for (let h = 0; h < snap.cape.length; h++) {
      const t = (snap.t0 + h * 3600) * 1000;
      if (snap.cape[h] == null || (date && DAY_FMT.format(new Date(t)) !== date)) continue;
      cape.set(t, snap.cape[h]);
    }
  };
  const addCapeDay = (doc, date) => {
    for (const snap of (doc && doc.snaps) || []) addCape(snap, date);
  };
  let i = 0;
  await Promise.all(Array.from({ length: HIST_LANES }, async () => {
    while (i < dates.length + aDates.length + mDates.length) {
      const k = i++;
      if (k < dates.length) {
        const doc = await WXA.day('obs', dates[k]);
        for (const [ts, raw] of (doc && doc.metars) || []) addRaw(ts, raw);
      } else if (k < dates.length + aDates.length) {
        const doc = await WXA.day('alerts', aDates[k - dates.length]);
        for (const a of (doc && doc.alerts) || []) {
          const key = a.event + (a.onset || a.headline || '');
          if (!alerts.has(key)) alerts.set(key, a);
        }
      } else {
        const d = mDates[k - dates.length - aDates.length];
        addCapeDay(await WXA.day('model', d), d);
      }
    }
  }));
  /* latest.json carries the freshest obs, alerts and model run — index.json
     (and today's day files) can be minutes-to-an-hour stale behind HTTP caches. */
  const latest = await WXA.latest();
  for (const [ts, raw] of (latest && latest.obs) || []) addRaw(ts, raw);
  for (const a of (latest && latest.alerts) || []) {
    const key = a.event + (a.onset || a.headline || '');
    if (!alerts.has(key)) alerts.set(key, a);
  }
  addCape(latest && latest.model, DAY_FMT.format(new Date()));
  obs.sort((a, b) => a.t - b.t);
  if (obs.filter((o) => o.alt != null).length < 24) return;

  HIST.obs = obs;
  /* One span per alert: watches get re-issued every hour or two while in
     effect, so overlapping issuances of the same event are merged. */
  const spans = [...alerts.values()]
    .map((a) => ({ event: a.event, t0: Date.parse(a.onset) || 0, t1: Date.parse(a.ends) || 0 }))
    .filter((a) => a.t0)
    .map((a) => (a.t1 ? a : { ...a, t1: a.t0 + 3 * 3600e3 }))
    .sort((a, b) => a.t0 - b.t0);
  HIST.alerts = [];
  for (const a of spans) {
    const prev = HIST.alerts.find((p) => p.event === a.event && a.t0 <= p.t1 + 3600e3);
    if (prev) prev.t1 = Math.max(prev.t1, a.t1);
    else HIST.alerts.push(a);
  }
  HIST.eps = {
    thunder: histEpisodes(obs, (o) => o.thunder),
    precip: histEpisodes(obs, (o) => o.precip),
    fog: histEpisodes(obs, (o) => o.fog),
    gust: histEpisodes(obs, (o) => o.gust >= HIST_GUST_KT),
  };
  HIST.cape = [...cape.entries()].map(([t, v]) => ({ t, v })).sort((a, b) => a.t - b.t);
  $('hist-card').style.display = '';   // unhide first — drawHist sizes off clientWidth
  drawHist();
  $('hist-read').innerHTML = histSummary();
  const evs = histEvents();
  $('hist-events').innerHTML = evs.map((e) =>
    `<div class="hist-ev"><span class="when">${esc(e.when)}</span><span class="what">${e.what}</span></div>`).join('');
  $('hist-note').textContent =
    `${OBS_STATION} METARs, ${dates.length} days · warnings from the LWX alert stream` +
    (HIST.cape.length ? ` · storm fuel: GFS CAPE at the field, archived since ${HIST_D(HIST.cape[0].t)}` : '') +
    ' · from the site\'s hourly archive, not climatology';
  let rt = 0;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(drawHist, 150); });
}

/* ===========================================================================
   init
   =========================================================================== */

async function init() {
  setStatus('yellow', 'Loading…');
  $('status-check').textContent = 'checks for new discussions every 10 min';
  await loadArchive();   // internal try/catch — the page works without it
  const alerts = loadAlerts();   // never rejects; the headline waits on it below
  const jobs = [
    loadAfd().then(() => 'afd').catch((e) => {
      $('afd-sections').innerHTML = `<div class="card err">Couldn't load the discussion: ${esc(e.message)}</div>`;
      $('afd-log').innerHTML = '<div class="card err">Change log unavailable (discussion failed to load).</div>';
      return null;
    }),
    loadSynoptic().then(() => 'syn').catch((e) => {
      $('syn-err').innerHTML = `<div class="err" style="margin-top:8px">Synoptic grid failed: ${esc(e.message)}</div>`;
      $('syn-time').textContent = 'model grid unavailable';
      return null;
    }),
    loadDrift().then(() => 'drift').catch((e) => {
      $('drift-body').innerHTML = `<span class="err">Drift tracker failed: ${esc(e.message)}</span>`;
      return null;
    }),
  ];
  const done = (await Promise.all(jobs)).filter(Boolean);
  await alerts;
  buildHeadline();
  loadHistory().catch(() => {});  // epilogue card — silent when the archive is absent
  loadVerification().catch((e) => {
    $('verify-body').innerHTML = `<span class="err">Verification failed: ${esc(e.message)}</span>`;
  });
  /* TAFs + the hourly grid at the field (js/discussion-avn.js). Runs after the
     synoptic grid so its "why did the TAF move" read has model fields to use. */
  if (typeof AVN !== 'undefined') {
    AVN.init().catch((e) => {
      $('avn-changes').innerHTML = `<span class="err">Aviation layer failed: ${esc(e.message)}</span>`;
    });
  }
  if (done.length === jobs.length) {
    const issued = AFD.list[0] ? fmtIssued(new Date(AFD.list[0].issuanceTime)) : '';
    setStatus('green', `Discussion issued ${issued} · ${OFFICE}`);
  } else if (done.length) {
    setStatus('yellow', 'Partially loaded — some sources failed');
  } else {
    setStatus('red', 'All sources failed — try refreshing');
  }
  setInterval(() => {
    loadAlerts().then(buildHeadline);   // keeps the alert strip live between issuances
    checkForNew();
  }, CHECK_MS);
}

$('refresh-btn').addEventListener('click', () => location.reload());
init();
