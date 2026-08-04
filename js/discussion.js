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
  map: null, times: [], raw: {}, t: 0, playing: false, playTimer: null,
  cache: new Map(), tRange: null, lut: null, parts: null, ready: false,
  layers: { airmass: true, fronts: true, isobars: true, wind: true, radar: true },
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

/* Upsample base → UX×UY with bilinear, then two box-blur passes for smooth
   contours and usable gradients. Cached per (tag, t). */
function upsampled(tag, t, getBase) {
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
  for (let pass = 0; pass < 2; pass++) g = boxBlur(g, UX, UY, 3);
  if (syn.cache.size > 40) syn.cache.delete(syn.cache.keys().next().value);
  syn.cache.set(key, g);
  return g;
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
  if (syn.cache.size > 40) syn.cache.delete(syn.cache.keys().next().value);
  syn.cache.set(key, out);
  return out;
}

/* ------------------------------- radar ----------------------------------- */

const radar = { layer: null, frameTime: null };

function isNowStep() {
  return syn.times.length > 0 && Math.abs(syn.times[syn.t] - Date.now()) <= 45 * 60 * 1000;
}

async function loadRadar() {
  const cfg = await fetchJSON('https://api.rainviewer.com/public/weather-maps.json');
  const frames = (cfg.radar && cfg.radar.past) || [];
  if (!frames.length) return;
  const f = frames[frames.length - 1];
  radar.frameTime = f.time * 1000;
  const url = `${cfg.host}${f.path}/256/{z}/{x}/{y}/2/1_1.png`;
  if (radar.layer) {
    radar.layer.setUrl(url);
  } else {
    // Radar rides in its own pane above the field canvases so echoes stay
    // true-color instead of being tinted by the air-mass fill.
    syn.map.createPane('radarPane');
    const pane = syn.map.getPane('radarPane');
    pane.style.zIndex = 502;
    pane.style.pointerEvents = 'none';
    radar.layer = L.tileLayer(url, {
      opacity: 0.68, maxNativeZoom: 7, maxZoom: 10, pane: 'radarPane',
    });
  }
  updateRadarVisibility();
}

function updateRadarVisibility() {
  if (!radar.layer || !syn.map) return;
  const show = syn.layers.radar && isNowStep();
  if (show && !syn.map.hasLayer(radar.layer)) radar.layer.addTo(syn.map);
  if (!show && syn.map.hasLayer(radar.layer)) syn.map.removeLayer(radar.layer);
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
  return { w, h };
}

/* --------------------------- field rendering ----------------------------- */

/* Frontal-zone threshold: |∇T850| above ~2 K/100 km reads as a front on the
   synoptic scale; scaled into upsampled-grid units below. */
const FRONT_KM_PER_CELL_LAT = 111.32 * SYN.DLAT / SYN.UP;

function drawFields() {
  if (!syn.ready) return;
  const t = syn.t;
  const cv = $('syn-canvas'), ctx = cv.getContext('2d');
  const w = parseInt(cv.style.width, 10), h = parseInt(cv.style.height, 10);
  ctx.clearRect(0, 0, w, h);

  const air = upsampled('air', t, () => airmassField(t));
  const mslp = upsampled('mslp', t, () => Float32Array.from(baseField('pressure_msl', t)));
  const uvB = uvFields(t);
  const uU = upsampled('u', t, () => uvB.u), vU = upsampled('v', t, () => uvB.v);
  const { gradX, gradY } = gradFields(t);

  // model precip shading fills the radar role at hours the radar can't show
  const modelPrecip = syn.layers.radar && !isNowStep();
  const prU = modelPrecip
    ? upsampled('pr', t, () => Float32Array.from(baseField('precipitation', t)))
    : null;

  /* --- air-mass fill + frontal zones + model precip: low-res pixel pass --- */
  if (syn.layers.airmass || syn.layers.fronts || modelPrecip) {
    const B = 3;
    const lw = Math.ceil(w / B), lh = Math.ceil(h / B);
    const img = new ImageData(lw, lh);
    const px = img.data;
    for (let py = 0; py < lh; py++) {
      for (let pxi = 0; pxi < lw; pxi++) {
        const ll = syn.map.containerPointToLatLng([pxi * B + B / 2, py * B + B / 2]);
        const { gx, gy } = gridXY(ll.lat, ll.lng);
        const ux = gx * SYN.UP, uy = gy * SYN.UP;
        const o = (py * lw + pxi) * 4;
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
          if (pv > 0.08) {
            const pc = pv < 0.5 ? [90, 200, 120] : pv < 2 ? [245, 210, 90] : [235, 75, 140];
            const pa = Math.min(0.72, 0.28 + pv * 0.14);
            r = r * (1 - pa) + pc[0] * pa; g = g * (1 - pa) + pc[1] * pa; b = b * (1 - pa) + pc[2] * pa;
            a = Math.max(a, Math.min(0.8, a + pa));
          }
        }
        px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = Math.round(a * 255);
      }
    }
    const off = document.createElement('canvas');
    off.width = lw; off.height = lh;
    off.getContext('2d').putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(off, 0, 0, lw, lh, 0, 0, lw * B, lh * B);
  }

  /* --- isobars + H/L --- */
  if (syn.layers.isobars) drawIsobars(ctx, mslp, w, h);

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
function drawIsobars(ctx, mslp, w, h) {
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
  drawExtrema(ctx);
}

function frac(a, b, lev) { return b === a ? 0.5 : Math.max(0, Math.min(1, (lev - a) / (b - a))); }

/* H/L centers from the base-resolution MSLP grid (less noise than upsampled) */
function findExtrema(t) {
  const f = baseField('pressure_msl', t);
  const marks = [];
  for (let y = 1; y < SYN.NY - 1; y++) {
    for (let x = 1; x < SYN.NX - 1; x++) {
      const v = f[y * SYN.NX + x];
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
      if ((isMin || isMax) && prom > 0.8) marks.push({ x, y, v, type: isMin ? 'L' : 'H' });
    }
  }
  return marks;
}

function drawExtrema(ctx) {
  const marks = findExtrema(syn.t);
  const cw = parseInt($('syn-canvas').style.width, 10);
  const ch = parseInt($('syn-canvas').style.height, 10);
  ctx.save();
  ctx.textAlign = 'center';
  for (const m of marks) {
    const p = uProject(m.x * SYN.UP, m.y * SYN.UP);
    if (p.x < 12 || p.x > cw - 12 || p.y < 14 || p.y > ch - 20) continue;
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

function buildWindLut() {
  const cv = $('syn-particles');
  const w = parseInt(cv.style.width, 10), h = parseInt(cv.style.height, 10);
  const step = 8;
  const gw = Math.ceil(w / step) + 1, gh = Math.ceil(h / step) + 1;
  const u = new Float32Array(gw * gh), v = new Float32Array(gw * gh);
  const { u: bu, v: bv } = uvFields(syn.t);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const ll = syn.map.containerPointToLatLng([gx * step, gy * step]);
      const { gx: fx, gy: fy } = gridXY(ll.lat, ll.lng);
      u[gy * gw + gx] = bilinear(bu, fx, fy);
      v[gy * gw + gx] = bilinear(bv, fx, fy);
    }
  }
  syn.lut = { u, v, gw, gh, step, w, h };
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

function synSetTime(t, fromSlider) {
  syn.t = Math.max(0, Math.min(syn.times.length - 1, t));
  if (!fromSlider) $('syn-slider').value = syn.t;
  const d = new Date(syn.times[syn.t]);
  const dh = Math.round((d.getTime() - Date.now()) / 3600000);
  const rel = dh === 0 ? 'now' : dh > 0 ? `+${dh} h` : `${dh} h`;
  $('syn-time').innerHTML =
    `${esc(fmtTime(d, { weekday: 'short', hour: 'numeric', timeZoneName: 'short' }))} <span class="rel">· ${esc(rel)}</span>`;
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

function synTogglePlay(force) {
  syn.playing = force != null ? force : !syn.playing;
  $('syn-play').textContent = syn.playing ? '⏸ Pause' : '▶ Play';
  clearInterval(syn.playTimer);
  if (syn.playing) {
    syn.playTimer = setInterval(() => {
      synSetTime((syn.t + 1) % syn.times.length);
    }, 550);
  }
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
  const foot = syn.layers.radar && isNowStep() && radar.layer
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
   Verification — why today played out the way it did
   =========================================================================== */

const OBS_STATION = 'KDCA';
const DAY_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const localDay = (ms) => DAY_FMT.format(new Date(ms));

async function loadVerification() {
  const host = $('verify-body');
  if (!syn.ready) { host.innerHTML = '<span class="err">Needs the model grid — synoptic load failed.</span>'; return; }
  const now = Date.now();
  const today = localDay(now);

  /* what was expected: prefer the site archive's earliest snapshot of today
     (shared across devices), else the earliest snapshot saved in this
     browser (≥3 h old) that covered today */
  let exp = null, expSrc = '';
  const arcSnap = ((ARC.todayFc && ARC.todayFc.snaps) || []).find((s) => s.days && s.days[today]);
  if (arcSnap) {
    exp = { at: arcSnap.t * 1000, ...arcSnap.days[today] };
    expSrc = `archived on the site at ${fmtTime(new Date(exp.at), { hour: 'numeric' })}`;
  } else {
    let snaps = [];
    try { snaps = JSON.parse(localStorage.getItem(DRIFT_KEY)) || []; } catch (e) { /* none */ }
    const withToday = snaps.filter((s) => s.days && s.days[today] && now - s.at > 3 * 3600 * 1000);
    if (withToday.length) {
      exp = { at: withToday[0].at, ...withToday[0].days[today] };
      expSrc = `saved in this browser ${timeAgo(new Date(exp.at))}`;
    }
  }

  /* what actually happened: METARs at DCA today */
  const obs = await fetchJSON(`${NWS}/stations/${OBS_STATION}/observations?limit=40`);
  const todays = (obs.features || []).map((f) => f.properties)
    .filter((p) => p && p.timestamp && localDay(new Date(p.timestamp).getTime()) === today);
  const thunder = todays.filter((p) => /\b(?:VC)?TS(?!NO)/.test(p.rawMessage || '')).reverse();
  const rain = todays.filter((p) => /(?:^|\s)[+-]?(?:SH|FZ)?(?:RA|DZ)\b/.test((p.rawMessage || '').replace(/RMK.*$/, '')));
  let maxT = null;
  for (const p of todays) {
    const c = p.temperature && p.temperature.value;
    if (c != null && (maxT == null || c > maxT)) maxT = c;
  }

  /* model hindcast at DC over today's past hours */
  const g = gridXY(DC.lat, DC.lon);
  const pastIdx = [];
  for (let i = 0; i < syn.times.length; i++) {
    if (syn.times[i] <= now && localDay(syn.times[i]) === today) pastIdx.push(i);
  }
  let peakCape = 0, dcPrecip = 0, nearbyMax = 0;
  for (const i of pastIdx) {
    peakCape = Math.max(peakCape, bilinear(baseField('cape', i), g.gx, g.gy) || 0);
    dcPrecip += Math.max(0, bilinear(baseField('precipitation', i), g.gx, g.gy) || 0);
    const pf = baseField('precipitation', i);
    for (let k = 0; k < SYN.NP; k++) {
      const lat = SYN.LAT_N - Math.floor(k / SYN.NX) * SYN.DLAT;
      const lon = SYN.LON_W + (k % SYN.NX) * SYN.DLON;
      if (kmBetween(DC.lat, DC.lon, lat, lon).km < 120) nearbyMax = Math.max(nearbyMax, pf[k] || 0);
    }
  }
  if (syn.point) {   // point call carries CAPE too and resolves better than the grid
    for (let i = 0; i < syn.point.times.length; i++) {
      if (syn.point.times[i] <= now && localDay(syn.point.times[i]) === today) {
        peakCape = Math.max(peakCape, syn.point.cape[i] || 0);
      }
    }
  }
  /* strongest cap during the heating hours (15–23 local ≈ when storms fire) */
  let capJkg = null;
  if (syn.point) {
    for (let i = 0; i < syn.point.times.length; i++) {
      const tms = syn.point.times[i];
      if (tms > now || localDay(tms) !== today) continue;
      const hr = +new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hour12: false }).format(new Date(tms));
      if (hr >= 11 && hr <= 22) {
        const c = syn.point.cin[i];
        if (c != null && (capJkg == null || Math.abs(c) > capJkg)) capJkg = Math.abs(c);
      }
    }
  }
  const front = nearestFront(synNowIndex());

  /* ---- compose ---- */
  const F = (c) => Math.round(c * 9 / 5 + 32);
  const expectedStorms = exp && (/t-?storm|thunder/i.test(exp.short || '') || (exp.pop ?? 0) >= 50);
  const gotStorms = thunder.length > 0;
  const gotRain = rain.length > 0 || dcPrecip > 0.5;
  const hrOf = (p) => fmtTime(new Date(p.timestamp), { hour: 'numeric' });

  const expLine = exp
    ? `${esc(exp.short || '—')}${exp.pop != null ? ` · ${exp.pop}% precip chance` : ''}${exp.hi != null ? ` · high ${exp.hi}°` : ''} <span class="faint">(forecast ${esc(expSrc)})</span>`
    : '<span class="faint">no earlier forecast on record yet — the comparison starts once the site archive (or your next visit) captures one</span>';
  const obsLine =
    `${gotStorms ? `thunder at ${OBS_STATION} around ${esc(hrOf(thunder[0]))}${thunder.length > 1 ? `–${esc(hrOf(thunder[thunder.length - 1]))}` : ''}` : 'no thunder'}` +
    ` · ${rain.length ? 'rain reported' : 'no rain in the METARs'}` +
    `${maxT != null ? ` · high ${F(maxT)}°F` : ''} <span class="faint">(${OBS_STATION}, through the latest ob)</span>`;

  const S = [];
  if (expectedStorms && !gotStorms) {
    if (peakCape >= 800 && capJkg != null && capJkg >= 60) {
      S.push(`The fuel showed up — the model hindcast has CAPE peaking near ${Math.round(peakCape / 100) * 100} J/kg — but the lid never broke: convective inhibition held around −${Math.round(capJkg / 10) * 10} J/kg at DC through the heating hours, and no trigger was strong enough to punch through it.`);
    }
    if (front && front.km < 450 && front.dir.includes('W')) {
      S.push(`The trigger also ran late: the front that was supposed to set storms off is still ~${Math.round(front.km * 0.54 / 10) * 10} nm to the ${front.dir} at the latest model hour, so the lift never overlapped the unstable air over the district in time.`);
    } else if (front && front.dir.includes('E')) {
      S.push('The boundary actually came through — but dry: by the time it crossed, the low levels had stabilized and there was nothing left for it to lift.');
    }
    if (nearbyMax > 0.8 && dcPrecip < 0.3) {
      S.push(`Storms did fire in the region — the hindcast paints up to ~${nearbyMax.toFixed(1)} mm/hr within ~65 nm — they just missed the district. On a ${exp && exp.pop != null ? exp.pop + '%' : 'scattered'} day, that's the coin landing on the other side.`);
    }
    if (peakCape < 500) {
      S.push(`The instability itself underperformed: CAPE at DC only reached ~${Math.round(peakCape / 50) * 50} J/kg — clouds or leftover stable air held surface heating below what the morning forecast banked on.`);
    }
    if (!S.length) {
      S.push('The model’s own hindcast keeps DC dry too — the setup simply weakened faster than the earlier runs (and the forecast built on them) expected.');
    }
  } else if (expectedStorms && gotStorms) {
    S.push(`That verified: thunder reached ${OBS_STATION}${thunder.length ? ` around ${hrOf(thunder[0])}` : ''}${front ? `, with the frontal zone ${front.dir.includes('E') ? 'having swept through' : `still ~${Math.round(front.km * 0.54 / 10) * 10} nm ${front.dir}`}` : ''} — fuel (CAPE ~${Math.round(peakCape / 100) * 100} J/kg) plus a trigger, the classic recipe.`);
  } else if (!expectedStorms && gotStorms) {
    S.push(`Storms weren’t really advertised, but they happened anyway — ${capJkg != null && capJkg < 40 ? 'the cap was weaker than forecast, and ' : ''}${front && front.km < 250 ? 'the boundary nearby provided the spark' : 'an outflow or bay-breeze boundary likely provided the spark'}. Small-scale triggers like that are exactly what the models resolve worst.`);
  } else {
    S.push(gotRain
      ? 'A mostly quiet day with some rain — about what the pattern supported.'
      : `A quiet day${exp ? ' — largely as advertised' : ''}: ${capJkg != null && capJkg >= 60 ? `the column stayed capped (CIN ~−${Math.round(capJkg / 10) * 10} J/kg)` : peakCape < 500 ? 'little instability ever developed' : 'no trigger arrived to tap what instability there was'}, so the sky stayed mostly out of the precip business.`);
  }

  host.innerHTML =
    `<div class="v-grid">` +
    `<div class="v-lab">Expected</div><div>${expLine}</div>` +
    `<div class="v-lab">Observed</div><div>${obsLine}</div>` +
    `</div>` +
    `<p class="v-why">${S.map(esc).join(' ')}</p>` +
    `<div class="drift-note">PoPs are probabilities, not promises${exp && exp.pop != null && exp.pop > 0 && exp.pop < 100 ? ` — a ${exp.pop}% day stays dry about ${Math.round(10 - exp.pop / 10)} times in 10` : ''}. Hindcast = the model’s own reconstruction (GFS); observations from ${OBS_STATION} METARs. Recheck after the next discussion drops: the change log above usually shows the forecasters reckoning with the same bust.</div>`;
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

/* -------------------------------- render --------------------------------- */

function renderHeadline(lead, tiles, alsos, keyMsgs) {
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
  $('key-messages').innerHTML = keyMsgs.length
    ? `<div class="sn-head">Key messages · NWS ${esc(OFFICE)}</div>` + keyMsgs.map((t) =>
      `<div class="item">${esc(t)}</div>`).join('')
    : '';
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
    renderHeadline(lead, headlineStats(s), alsos, keyMsgs.filter((km) => km !== lead.deck));
  } catch (e) {
    $('hl-title').textContent = 'Headline unavailable';
    $('hl-deck').textContent = `Couldn't assemble it: ${e.message}. Everything below still stands on its own.`;
  }
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
