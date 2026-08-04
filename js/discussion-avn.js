/* Aviation layer for discussion.html
   ---------------------------------------------------------------------------
   The AFD is prose and the model is fields; neither is what you brief a flight
   from. This module adds the two products that are — the TAFs around KANP and
   the NWS hourly grid at the field — and, when a TAF moves between issuances,
   the atmospheric reason it moved, read off the same GFS grid the synoptic map
   already loaded.

   KANP has no TAF of its own (see CLAUDE.md), so the terminals shown are the
   three that do: KMTN, KBWI, KDCA. Loaded after discussion.js and uses its
   globals: fetchJSON, esc, fmtTime, $, NWS, TZ, SITE, plus syn/gridXY/
   baseField/pointAt for the model read. All directions °true. */

'use strict';

const AVN = {
  field: SITE.airport,
  stations: SITE.weather.tafStations,
  tafs: {},          // id -> { cur, prev, err }
  grid: null,        // hourly series at the field
  base: null,        // this morning's archived grid snapshot, when there is one
};

/* ------------------------------- IWXXM ---------------------------------- */

const AVN_XLINK = 'http://www.w3.org/1999/xlink';
const avnTag = (el, name) => el.getElementsByTagNameNS('*', name);
const avnHref = (el) => (el.getAttributeNS(AVN_XLINK, 'href') || el.getAttribute('xlink:href') || '');
const avnCode = (el) => avnHref(el).split('/').pop();

/* NWS encodes TAF visibility in meters from a fixed SM table — decode via the
   table, never by dividing by 1609. */
const AVN_VIS = [[400, 0.25], [800, 0.5], [1200, 0.75], [1600, 1], [2400, 1.5],
  [3200, 2], [4800, 3], [6000, 4], [8000, 5], [9000, 6], [9999, 6], [16000, 6]];
function visSMfromM(m) {
  if (m == null) return null;
  for (const [mm, sm] of AVN_VIS) if (Math.abs(m - mm) <= 100) return sm;
  return m / 1609.34;
}

async function parseTaf(item) {
  const res = await fetch(item.id);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const doc = new DOMParser().parseFromString(await res.text(), 'application/xml');
  const periods = [];
  for (const f of avnTag(doc, 'MeteorologicalAerodromeForecast')) {
    const p = { indicator: f.getAttribute('changeIndicator') || 'FM', wx: [], clouds: [] };
    const tp = avnTag(f, 'TimePeriod')[0];
    if (tp) {
      p.begin = new Date(avnTag(tp, 'beginPosition')[0].textContent).getTime();
      p.end = new Date(avnTag(tp, 'endPosition')[0].textContent).getTime();
    }
    const wd = avnTag(f, 'meanWindDirection')[0], ws = avnTag(f, 'meanWindSpeed')[0];
    const wg = avnTag(f, 'windGustSpeed')[0];
    if (wd) p.windDir = Math.round(+wd.textContent);
    if (ws) p.windKt = Math.round(+ws.textContent);
    if (wg) p.gustKt = Math.round(+wg.textContent);
    const pv = avnTag(f, 'prevailingVisibility')[0];
    if (pv) p.visSM = visSMfromM(+pv.textContent);
    for (const w of avnTag(f, 'weather')) {
      const c = avnCode(w);
      if (c && c !== 'NSW') p.wx.push(c);
    }
    for (const cl of avnTag(f, 'CloudLayer')) {
      const amt = avnCode(avnTag(cl, 'amount')[0] || cl);
      const base = avnTag(cl, 'base')[0];
      p.clouds.push({ amt, baseFt: base ? Math.round(+base.textContent) : null });
    }
    periods.push(p);
  }
  return { issued: new Date(item.issueTime).getTime(), periods };
}

/* Newest TAF, plus the oldest issuance still on the wire from today — the one
   a morning go/no-go would have been briefed from. The collection endpoint
   keeps recent issuances, so this needs no archive. Falls back to simply the
   previous issuance when today's earlier ones have aged off. */
async function loadTafPair(id) {
  const list = await fetchJSON(`${NWS}/stations/${id}/tafs`);
  const items = (list['@graph'] || []).filter((i) => i && i.id && i.issueTime);
  items.sort((a, b) => new Date(b.issueTime) - new Date(a.issueTime));
  if (!items.length) throw new Error('no TAF published');
  const cur = await parseTaf(items[0]);
  const today = localDay(Date.now());
  const older = items.slice(1).filter((i) =>
    cur.issued - new Date(i.issueTime).getTime() >= 3 * 3600000);
  const pick = older.filter((i) => localDay(new Date(i.issueTime).getTime()) === today).pop()
    || older[0] || items[1];
  let prev = null;
  if (pick) { try { prev = await parseTaf(pick); } catch (e) { /* one is enough */ } }
  return { cur, prev };
}

/* ---------------------------- category logic ----------------------------- */

const CEIL_AMT = { BKN: 1, OVC: 1, VV: 1 };

function ceilingOf(period) {
  let c = null;
  for (const cl of period.clouds || []) {
    if (!CEIL_AMT[cl.amt] || cl.baseFt == null) continue;
    if (c == null || cl.baseFt < c) c = cl.baseFt;
  }
  return c;
}

function category(ceilFt, visSM) {
  const c = ceilFt == null ? Infinity : ceilFt;
  const v = visSM == null ? Infinity : visSM;
  if (c < 500 || v < 1) return 'LIFR';
  if (c < 1000 || v < 3) return 'IFR';
  if (c <= 3000 || v <= 5) return 'MVFR';
  return 'VFR';
}

const hasTS = (wx) => (wx || []).some((w) => /TS/.test(w));

/* A TAF flattened to one entry per hour — the only sane way to diff two
   issuances whose change groups don't line up. */
function tafHours(taf, from, to) {
  const out = new Map();
  for (let t = from; t <= to; t += 3600000) {
    let best = null;
    for (const p of taf.periods) {
      if (p.begin == null || t < p.begin || t >= p.end) continue;
      // later groups (FM/TEMPO/PROB) override the base period they sit inside
      if (!best || p.begin >= best.begin) best = p;
    }
    if (best) {
      out.set(t, {
        cat: category(ceilingOf(best), best.visSM),
        ceil: ceilingOf(best),
        vis: best.visSM,
        ts: hasTS(best.wx),
        wx: (best.wx || []).join(' '),
        indicator: best.indicator,
      });
    }
  }
  return out;
}

/* --------------------------- NWS hourly grid ----------------------------- */

/* NWS grid series are (validTime, value) with ISO-8601 durations — expand to
   one value per hour. */
function expandGrid(series, conv) {
  const out = new Map();
  for (const v of (series && series.values) || []) {
    const [startIso, dur] = v.validTime.split('/');
    const start = new Date(startIso).getTime();
    const m = (dur || 'PT1H').match(/P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?/);
    const hrs = Math.max(1, (m ? (+m[1] || 0) * 24 + (+m[2] || 0) : 0) + ((m && +m[3]) ? 1 : 0));
    for (let h = 0; h < hrs; h++) out.set(start + h * 3600000, v.value == null ? null : conv(v.value));
  }
  return out;
}

/* The grid's own weather array — this is what drives the thunderstorm icon in
   every app that renders this data, so it answers "why no TS symbol". */
function expandWeather(series) {
  const out = new Map();
  for (const v of (series && series.values) || []) {
    const [startIso, dur] = v.validTime.split('/');
    const start = new Date(startIso).getTime();
    const m = (dur || 'PT1H').match(/P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?/);
    const hrs = Math.max(1, (m ? (+m[1] || 0) * 24 + (+m[2] || 0) : 0) + ((m && +m[3]) ? 1 : 0));
    const list = (v.value || []).filter((w) => w && w.weather).map((w) => ({
      wx: w.weather, cov: w.coverage || '', int: w.intensity || '',
    }));
    for (let h = 0; h < hrs; h++) out.set(start + h * 3600000, list);
  }
  return out;
}

async function loadFieldGrid() {
  let url = localStorage.getItem('dcwx_avn_grid');
  if (!url) {
    const pt = await fetchJSON(`${NWS}/points/${AVN.field.lat},${AVN.field.lon}`);
    url = pt.properties.forecastGridData;
    localStorage.setItem('dcwx_avn_grid', url);
  }
  let g;
  try {
    g = (await fetchJSON(url)).properties;
  } catch (e) {
    localStorage.removeItem('dcwx_avn_grid');
    throw e;
  }
  const kt = (v) => v / 1.852;
  // LWX encodes "no ceiling" as −30.48 m; any non-positive height means none.
  const ceilFt = (v) => (v <= 0 ? null : v * 3.28084);
  const sm = (v) => (v < 0 ? null : v / 1609.34);
  const id = (v) => v;
  AVN.grid = {
    ceil: expandGrid(g.ceilingHeight, ceilFt),
    vis: expandGrid(g.visibility, sm),
    spd: expandGrid(g.windSpeed, kt),
    gst: expandGrid(g.windGust, kt),
    dir: expandGrid(g.windDirection, id),
    pop: expandGrid(g.probabilityOfPrecipitation, id),
    tempC: expandGrid(g.temperature, id),
    dewC: expandGrid(g.dewpoint, id),
    wx: expandWeather(g.weather),
  };
}

/* ------------------------- the atmospheric read --------------------------- */

/* GFS at the field for a given hour. syn is the grid discussion.js already
   loaded for the synoptic map; CIN comes from its DC point call (≈20 nm west —
   close enough for a cap, and labelled as such). */
function modelAt(ms) {
  if (!syn || !syn.ready || !syn.times.length) return null;
  let i = 0;
  for (let k = 0; k < syn.times.length; k++) {
    if (Math.abs(syn.times[k] - ms) < Math.abs(syn.times[i] - ms)) i = k;
  }
  if (Math.abs(syn.times[i] - ms) > 90 * 60000) return null;   // outside the window
  const g = gridXY(AVN.field.lat, AVN.field.lon);
  const at = (name) => {
    const v = bilinear(baseField(name, i), g.gx, g.gy);
    return Number.isFinite(v) ? v : null;
  };
  return {
    i,
    cape: Math.max(0, at('cape') ?? 0),
    cin: pointAt('cin', syn.times[i]),
    precip: Math.max(0, at('precipitation') ?? 0),
    t850: at('temperature_850hPa'),
    spread: (at('temperature_2m') ?? 0) - (at('dew_point_2m') ?? 0),
    spd: at('wind_speed_10m'),
  };
}

/* Why a thunderstorm mention came out of (or went into) a given hour. Every
   clause is tied to a number the model actually carries. */
function whyThunder(ms, gone) {
  const m = modelAt(ms);
  if (!m) return 'The GFS window this page loads does not reach that hour, so there is no model read to offer.';
  const cap = m.cin == null ? null : Math.abs(m.cin);
  const hr = +new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hour12: false })
    .format(new Date(ms));
  const bits = [];

  if (gone) {
    if (m.cape < 300) {
      bits.push(`CAPE at the field is only ~${Math.round(m.cape / 50) * 50} J/kg at that hour — ` +
        'the lift is still there but there is no buoyancy left to turn it into a storm, so it falls out as rain.');
    } else if (cap != null && cap >= 75) {
      bits.push(`Fuel without a way in: ~${Math.round(m.cape / 100) * 100} J/kg of CAPE under about ` +
        `${Math.round(cap / 10) * 10} J/kg of inhibition (DC point sounding). Nothing gets a surface parcel to its LFC.`);
    } else {
      bits.push(`CAPE runs ~${Math.round(m.cape / 100) * 100} J/kg with little inhibition, so the ingredients ` +
        'are marginal rather than absent — this is a confidence call, not a clean no.');
    }
    if (hr <= 11 || hr >= 22) {
      bits.push('Overnight storms here are elevated — they ride the low-level jet up over the frontal surface ' +
        'and decay as it weakens toward dawn, which is when a TS group usually comes out of the TAF.');
    }
    if (m.precip >= 0.2) {
      bits.push(`The rain itself does not go away: the model still has ~${m.precip.toFixed(1)} mm/hr at that hour.`);
    }
  } else {
    bits.push(`CAPE builds to ~${Math.round(m.cape / 100) * 100} J/kg` +
      `${cap != null ? ` against only ~${Math.round(cap / 10) * 10} J/kg of inhibition` : ''} — ` +
      'enough for surface parcels to reach their level of free convection.');
    if (m.precip >= 0.2) bits.push(`Model precip at the field is ~${m.precip.toFixed(1)} mm/hr in the same hour.`);
  }
  if (m.spread <= 1.5) {
    bits.push(`The column is saturated (spread ${Math.max(0, Math.round(m.spread * 9 / 5))}°F), ` +
      'so ceilings are the binding constraint either way.');
  }
  return bits.join(' ');
}

/* ------------------------------ rendering -------------------------------- */

const catClass = (c) => `cat-${c.toLowerCase()}`;
const fmtCeil = (ft) => (ft == null ? '—' : `${Math.round(ft / 100) * 100}′`);
const fmtVisSM = (v) => (v == null ? '—' : v >= 6 ? 'P6' : v < 1 ? v.toFixed(2).replace(/0$/, '') : String(Math.round(v * 2) / 2));
const hourLbl = (ms) => fmtTime(new Date(ms), { hour: 'numeric' });

function renderTafs() {
  const host = $('avn-tafs');
  host.innerHTML = AVN.stations.map((st) => {
    const rec = AVN.tafs[st.id];
    if (!rec || rec.err) {
      return `<div class="taf-card"><div class="taf-head"><b>${esc(st.id)}</b></div>` +
        `<div class="faint">${esc((rec && rec.err) || 'no TAF')}</div></div>`;
    }
    const rows = rec.cur.periods.map((p) => {
      const ceil = ceilingOf(p), cat = category(ceil, p.visSM);
      const wind = p.windKt == null ? 'calm'
        : `${String(Math.round((p.windDir || 0) / 10) * 10).padStart(3, '0')}°${p.windKt}` +
          `${p.gustKt ? `G${p.gustKt}` : ''}kt`;
      return `<div class="taf-row"><span class="ind">${esc(p.indicator)}</span>` +
        `<span class="when">${esc(hourLbl(p.begin))}–${esc(hourLbl(p.end))}</span>` +
        `<span class="cat ${catClass(cat)}">${cat}</span>` +
        `<span class="det">${esc(fmtCeil(ceil))} · ${esc(fmtVisSM(p.visSM))}SM · ${esc(wind)}` +
        `${p.wx.length ? ` · <b>${esc(p.wx.join(' '))}</b>` : ''}</span></div>`;
    }).join('');
    return `<div class="taf-card"><div class="taf-head"><b>${esc(st.id)}</b>` +
      `<span class="faint">${esc(st.label)} · issued ${esc(fmtTime(new Date(rec.cur.issued), { hour: 'numeric', minute: '2-digit' }))}</span></div>` +
      rows + '</div>';
  }).join('');
}

/* What this hour looked like in the first grid snapshot archived today —
   blank when nothing moved, which is most hours. */
function gridWas(t, cat, ts) {
  if (!AVN.base || typeof WXA === 'undefined') return '';
  const ceil = WXA.gridAt(AVN.base, 'ceil', t);
  const vis = WXA.gridAt(AVN.base, 'vis', t);
  if (ceil === undefined && vis === undefined) return '';
  const wasCat = category(ceil ?? null, vis ?? null);
  const wasTs = /thunder/i.test(WXA.gridAt(AVN.base, 'wx', t) || '');
  if (wasTs !== ts) return wasTs ? '<b class="drop">was TS</b>' : '<b class="add">TS added</b>';
  if (wasCat !== cat) return `<span class="was">was ${wasCat}</span>`;
  return '';
}

function renderFieldGrid() {
  const host = $('avn-grid');
  if (!AVN.grid) { host.innerHTML = '<span class="faint">Grid unavailable.</span>'; return; }
  const now = Date.now();
  const start = Math.floor(now / 3600000) * 3600000;
  const rows = [];
  const tsDrops = [];
  for (let t = start; t <= start + 30 * 3600000; t += 3600000) {
    const ceil = AVN.grid.ceil.get(t) ?? null;
    const vis = AVN.grid.vis.get(t) ?? null;
    if (ceil == null && vis == null && !AVN.grid.tempC.has(t)) continue;
    const cat = category(ceil, vis);
    const spd = AVN.grid.spd.get(t), gst = AVN.grid.gst.get(t), dir = AVN.grid.dir.get(t);
    const wx = AVN.grid.wx.get(t) || [];
    const ts = wx.some((w) => /thunder/i.test(w.wx));
    const tC = AVN.grid.tempC.get(t), dC = AVN.grid.dewC.get(t);
    const wind = spd == null || spd < 1 ? 'calm'
      : `${String(Math.round((dir || 0) / 10) * 10).padStart(3, '0')}/${Math.round(spd)}` +
        `${gst && gst - spd >= 5 ? `G${Math.round(gst)}` : ''}`;
    const was = gridWas(t, cat, ts);
    if (/was TS/.test(was) && t > now) tsDrops.push(t);
    rows.push(
      `<tr${t <= now ? ' class="past"' : ''}>` +
      `<td class="h">${esc(fmtTime(new Date(t), { weekday: 'short', hour: 'numeric' }))}</td>` +
      `<td class="${catClass(cat)}">${cat}</td>` +
      `<td>${esc(fmtCeil(ceil))}</td><td>${esc(fmtVisSM(vis))}</td>` +
      `<td>${esc(wind)}</td>` +
      `<td>${AVN.grid.pop.get(t) ?? '—'}%</td>` +
      `<td>${tC == null ? '—' : Math.round(tC * 9 / 5 + 32)}°/${dC == null ? '—' : Math.round(dC * 9 / 5 + 32)}°</td>` +
      `<td class="wx">${ts ? '<b class="ts">TS</b> ' : ''}${esc(wx.map((w) => w.wx).filter((w, i, a) => a.indexOf(w) === i).join(', '))}</td>` +
      `<td class="was-col">${was}</td>` +
      '</tr>');
  }
  const note = AVN.base
    ? `<div class="drift-note">Last column compares each hour with the first grid snapshot ` +
      `archived today (${esc(fmtTime(new Date(AVN.base.t * 1000), { hour: 'numeric', minute: '2-digit' }))}). ` +
      (tsDrops.length
        ? `Thunder came out of ${tsDrops.length} hour(s): ${esc(whyThunder(tsDrops[0], true))}`
        : 'Blank means that hour has not moved.')
    : '<div class="drift-note">No grid snapshot archived earlier today yet — ' +
      'the comparison column fills in once the hourly archive has a baseline.';
  host.innerHTML =
    `<table class="avn-table"><thead><tr><th>hour</th><th>cat</th><th>ceil</th><th>vis</th>` +
    `<th>wind °T/kt</th><th>precip</th><th>t/dp</th><th>grid weather</th><th>vs this morning</th></tr></thead>` +
    `<tbody>${rows.join('')}</tbody></table>${note}</div>`;
}

/* What moved between the last two TAF issuances, and why. */
function renderTafChanges() {
  const host = $('avn-changes');
  const now = Date.now();
  const from = Math.floor(now / 3600000) * 3600000;
  const to = from + 24 * 3600000;
  const blocks = [];

  for (const st of AVN.stations) {
    const rec = AVN.tafs[st.id];
    if (!rec || rec.err || !rec.prev) continue;
    const a = tafHours(rec.prev, from, to), b = tafHours(rec.cur, from, to);
    const changes = [];
    for (const [t, nb] of b) {
      const na = a.get(t);
      if (!na) continue;
      if (na.ts !== nb.ts) changes.push({ t, kind: nb.ts ? 'ts-added' : 'ts-gone' });
      else if (na.cat !== nb.cat) changes.push({ t, kind: 'cat', from: na.cat, to: nb.cat });
    }
    if (!changes.length) continue;
    // collapse contiguous hours of the same change into one run
    const runs = [];
    for (const c of changes) {
      const last = runs[runs.length - 1];
      if (last && last.kind === c.kind && last.from === c.from && last.to === c.to &&
          c.t - last.t1 === 3600000) { last.t1 = c.t; continue; }
      runs.push({ ...c, t0: c.t, t1: c.t });
    }
    blocks.push({ st, runs, issued: rec.cur.issued, prevIssued: rec.prev.issued });
  }

  if (!blocks.length) {
    host.innerHTML = '<div class="faint" style="font-size:13px">' +
      'No category or thunder change between the last two TAF issuances at KMTN, KBWI or KDCA.</div>';
    return;
  }

  /* All three terminals sit inside 30 nm, so the same reason usually applies to
     all of them — say it once. */
  const saidWhy = new Set();
  host.innerHTML = blocks.map((bl) => {
    const rows = bl.runs.slice(0, 4).map((r) => {
      const span = r.t0 === r.t1 ? hourLbl(r.t0) : `${hourLbl(r.t0)}–${hourLbl(r.t1 + 3600000)}`;
      const what = r.kind === 'ts-gone' ? 'thunder dropped'
        : r.kind === 'ts-added' ? 'thunder added'
        : `${r.from} → ${r.to}`;
      let why = r.kind === 'ts-gone' ? whyThunder(r.t0, true)
        : r.kind === 'ts-added' ? whyThunder(r.t0, false) : '';
      if (why && saidWhy.has(why)) why = '';
      else if (why) saidWhy.add(why);
      return `<div class="chg-row"><span class="when">${esc(span)}</span>` +
        `<span class="what ${r.kind.startsWith('ts') ? 'ts' : ''}">${esc(what)}</span></div>` +
        (why ? `<div class="chg-why">${esc(why)}</div>` : '');
    }).join('');
    return `<div class="chg-block"><div class="chg-head"><b>${esc(bl.st.id)}</b> ` +
      `<span class="faint">${esc(fmtTime(new Date(bl.prevIssued), { hour: 'numeric', minute: '2-digit' }))} → ` +
      `${esc(fmtTime(new Date(bl.issued), { hour: 'numeric', minute: '2-digit' }))}</span></div>${rows}</div>`;
  }).join('');
}

/* --------------------------------- init ---------------------------------- */

AVN.init = async function init() {
  if (typeof WXA !== 'undefined') {
    AVN.base = await WXA.firstSnap('grid', localDay(Date.now()));
  }
  const jobs = AVN.stations.map(async (st) => {
    try { AVN.tafs[st.id] = await loadTafPair(st.id); }
    catch (e) { AVN.tafs[st.id] = { err: `unavailable (${e.message})` }; }
  });
  jobs.push(loadFieldGrid().catch((e) => {
    $('avn-grid').innerHTML = `<span class="err">Hourly grid failed: ${esc(e.message)}</span>`;
  }));
  await Promise.all(jobs);
  renderTafs();
  if (AVN.grid) renderFieldGrid();
  renderTafChanges();
};
