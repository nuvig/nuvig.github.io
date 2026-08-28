/* Aviation layer for discussion.html
   ---------------------------------------------------------------------------
   Two things: the NWS hourly grid at the field (the go/no-go table, with a
   column comparing each hour against this morning's archived snapshot), and —
   when a TAF moves between issuances — the atmospheric reason it moved.

   The TAFs are fetched but deliberately NOT displayed: weather.html already
   decodes them, and a second decoder here only crowded the discussion. They
   are here as evidence, to detect the change. KANP has no TAF of its own, so
   the terminals watched are KMTN/KBWI/KDCA. Loaded after discussion.js, uses its
   globals: fetchJSON, esc, fmtTime, $, NWS, TZ, SITE, plus syn/gridXY/
   baseField/pointAt for the model read. All directions °true. */

'use strict';

const AVN = {
  field: SITE.airport,
  stations: SITE.weather.tafStations,
  tafs: {},          // id -> { cur, prev, err }
  grid: null,        // hourly series at the field
  base: null,        // this morning's archived grid snapshot, when there is one
  obs: null,         // the field station's current METAR, decoded
  gridErr: null,     // why the grid load failed, when it did
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
  if (!m) return 'That hour is outside the GFS window this page loads.';
  const cap = m.cin == null ? null : Math.abs(m.cin);
  const hr = +new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hour12: false })
    .format(new Date(ms));
  const night = hr <= 11 || hr >= 22;
  if (!gone) {
    return `CAPE builds to ~${Math.round(m.cape / 100) * 100} J/kg` +
      `${cap != null ? ` against ~${Math.round(cap / 10) * 10} J/kg of inhibition` : ''}.`;
  }
  if (m.cape < 300) {
    return `CAPE only ~${Math.round(m.cape / 50) * 50} J/kg by then — ` +
      (night
        ? 'elevated overnight storms decay as the low-level jet weakens toward dawn, so the lift stays and the buoyancy goes.'
        : 'the lift stays, the buoyancy goes, and it falls out as rain.');
  }
  if (cap != null && cap >= 75) {
    return `~${Math.round(m.cape / 100) * 100} J/kg of CAPE under ~${Math.round(cap / 10) * 10} J/kg ` +
      'of inhibition (DC point sounding) — capped.';
  }
  return `~${Math.round(m.cape / 100) * 100} J/kg of CAPE with little inhibition — marginal, so a ` +
    'confidence call rather than a clean no.';
}

/* ------------------------------ rendering -------------------------------- */
const catClass = (c) => `cat-${c.toLowerCase()}`;
const hourLbl = (ms) => fmtTime(new Date(ms), { hour: 'numeric' });

/* Sunrise/sunset (NOAA sunrise equation), anchored on the calendar day at the
   field, not the viewer's timezone — same rule as weather.js solarTimes().
   Checked against a published sunrise: 06:11 EDT, 2026-08-05. */
const RAD = Math.PI / 180;
function sunTimes(lat, lon, dateStr) {
  const jd = Date.parse(dateStr + 'T00:00:00Z') / 86400000 + 2440587.5;
  const n = Math.ceil(jd - 2451545.0 + 0.0008);
  const Js = n - lon / 360;
  const M = (357.5291 + 0.98560028 * Js) % 360;
  const C = 1.9148 * Math.sin(M * RAD) + 0.02 * Math.sin(2 * M * RAD) + 0.0003 * Math.sin(3 * M * RAD);
  const L = (M + C + 180 + 102.9372) % 360;
  const Jt = 2451545.0 + Js + 0.0053 * Math.sin(M * RAD) - 0.0069 * Math.sin(2 * L * RAD);
  const decl = Math.asin(Math.sin(L * RAD) * Math.sin(23.44 * RAD));
  const cosH = (Math.sin(-0.833 * RAD) - Math.sin(lat * RAD) * Math.sin(decl)) /
               (Math.cos(lat * RAD) * Math.cos(decl));
  if (cosH > 1 || cosH < -1) return null;
  const ms = (J) => (J - 2440587.5) * 86400000;
  const H = Math.acos(cosH) / RAD;
  return { rise: ms(Jt - H / 360), set: ms(Jt + H / 360) };
}

const solarCache = new Map();
function isDaylight(t) {
  const day = localDay(t);
  if (!solarCache.has(day)) solarCache.set(day, sunTimes(AVN.field.lat, AVN.field.lon, day));
  const s = solarCache.get(day);
  return s ? t >= s.rise && t <= s.set : true;
}

/* One entry per hour for the next 24 h, including what moved since this
   morning's archived snapshot. */
function buildHours() {
  const start = Math.floor(Date.now() / 3600000) * 3600000;
  const out = [];
  for (let t = start; t <= start + 24 * 3600000; t += 3600000) {
    const ceil = AVN.grid.ceil.get(t) ?? null;
    const vis = AVN.grid.vis.get(t) ?? null;
    if (ceil == null && vis == null && !AVN.grid.tempC.has(t)) continue;
    const wx = AVN.grid.wx.get(t) || [];
    const ts = wx.some((w) => /thunder/i.test(w.wx));
    const h = {
      t, ceil, vis, ts, wx,
      cat: category(ceil, vis),
      spd: AVN.grid.spd.get(t), gst: AVN.grid.gst.get(t), dir: AVN.grid.dir.get(t),
      pop: AVN.grid.pop.get(t), tC: AVN.grid.tempC.get(t), dC: AVN.grid.dewC.get(t),
      day: isDaylight(t),
      was: null,
    };
    if (AVN.base && typeof WXA !== 'undefined') {
      const bc = WXA.gridAt(AVN.base, 'ceil', t), bv = WXA.gridAt(AVN.base, 'vis', t);
      if (bc !== undefined || bv !== undefined) {
        const wasTs = /thunder/i.test(WXA.gridAt(AVN.base, 'wx', t) || '');
        const wasCat = category(bc ?? null, bv ?? null);
        if (wasTs !== ts) h.was = wasTs ? 'lost the thunder mention' : 'gained a thunder mention';
        else if (wasCat !== h.cat) h.was = `was ${wasCat}`;
      }
    }
    out.push(h);
  }
  return out;
}

const CAT_RANK = { VFR: 0, MVFR: 1, IFR: 2, LIFR: 3 };
const numbersOf = (h) =>
  `${h.ceil == null ? 'no ceiling' : `${Math.round(h.ceil / 100) * 100} ft`} / ` +
  `${h.vis == null ? '—' : h.vis >= 6 ? 'P6' : Math.round(h.vis * 2) / 2} SM`;

/* The interpretation — where the windows are, in a sentence or two. */
function windowSummary(hours) {
  if (!hours.length) return '';
  const now = hours[0];
  let out = `<b class="${catClass(now.cat)}">${now.cat} now</b>`;
  const change = hours.find((h) => h.cat !== now.cat);
  out += change
    ? `, ${CAT_RANK[change.cat] > CAT_RANK[now.cat] ? 'down to' : 'up to'} ` +
      `<b class="${catClass(change.cat)}">${change.cat}</b> at ${esc(hourLbl(change.t))}.`
    : `, and holding for the next 24 h.`;

  const worst = hours.reduce((a, h) => (CAT_RANK[h.cat] > CAT_RANK[a.cat] ? h : a), hours[0]);
  if (CAT_RANK[worst.cat] > CAT_RANK[now.cat]) {
    const run = hours.filter((h) => h.cat === worst.cat);
    out += ` Worst <b class="${catClass(worst.cat)}">${worst.cat}</b> ` +
      `${esc(hourLbl(run[0].t))}–${esc(hourLbl(run[run.length - 1].t + 3600000))}, ` +
      `${esc(numbersOf(worst))}.`;
    const back = hours.find((h) => h.t > worst.t && h.cat === 'VFR');
    if (back) out += ` VFR again from ${esc(hourLbl(back.t))}.`;
  }
  const moved = hours.filter((h) => h.was && /thunder/.test(h.was));
  if (moved.length) {
    out += ` <span class="tl-moved">${moved.length} hour${moved.length > 1 ? 's' : ''} ` +
      `${esc(moved[0].was)} since this morning.</span>`;
  }
  return out;
}

function readoutFor(h) {
  const wind = h.spd == null || h.spd < 1 ? 'calm'
    : `${String(Math.round((h.dir || 0) / 10) * 10).padStart(3, '0')}°T ${Math.round(h.spd)} kt` +
      `${h.gst && h.gst - h.spd >= 5 ? ` G${Math.round(h.gst)}` : ''}`;
  const wx = h.wx.map((w) => w.wx).filter((w, i, a) => a.indexOf(w) === i).join(', ');
  return `<b>${esc(fmtTime(new Date(h.t), { weekday: 'short', hour: 'numeric' }))}</b> · ` +
    `<b class="${catClass(h.cat)}">${h.cat}</b> · ${esc(numbersOf(h))} · ${esc(wind)} · ` +
    `${h.pop ?? '—'}% precip · ${h.tC == null ? '—' : Math.round(h.tC * 9 / 5 + 32)}°/` +
    `${h.dC == null ? '—' : Math.round(h.dC * 9 / 5 + 32)}° dp` +
    `${wx ? ` · ${esc(wx)}` : ''}${h.was ? ` · <span class="tl-moved">${esc(h.was)}</span>` : ''}`;
}

function renderFieldGrid() {
  const host = $('avn-grid');
  /* The observation line goes out even when the grid doesn't, because it is
     the evidence that the "not as forecast" card above ran its check. */
  const obsLine = `<div class="tl-obs">${nowcastEvidence()}</div>`;
  if (!AVN.grid) {
    host.innerHTML = (AVN.gridErr
      ? `<span class="err">Hourly grid failed: ${esc(AVN.gridErr)}</span>`
      : '<span class="faint">Grid unavailable.</span>') + obsLine;
    return;
  }
  const hours = buildHours();
  if (!hours.length) { host.innerHTML = `<span class="faint">No grid data for the next 24 h.</span>${obsLine}`; return; }

  const cells = hours.map((h, i) =>
    `<div class="tl-cell ${catClass(h.cat)}${h.day ? '' : ' night'}${h.was ? ' moved' : ''}" ` +
    `data-i="${i}"><span class="mk">${h.ts ? '⚡' : (h.pop >= 50 || h.wx.length) ? '·' : ''}</span></div>`
  ).join('');
  const axis = hours.map((h, i) =>
    `<div class="tl-tick">${i % 3 === 0 ? esc(hourLbl(h.t).replace(' ', '')) : ''}</div>`).join('');

  host.innerHTML =
    `<div class="tl-sum">${windowSummary(hours)}</div>` +
    `<div class="tl-strip" id="tl-strip">${cells}</div>` +
    `<div class="tl-axis">${axis}</div>` +
    `<div class="tl-read" id="tl-read">${readoutFor(hours[0])}</div>` +
    obsLine +
    `<div class="tl-key"><b class="cat-vfr">VFR</b> <b class="cat-mvfr">MVFR</b> ` +
    `<b class="cat-ifr">IFR</b> <b class="cat-lifr">LIFR</b> · ⚡ thunder in the grid · ` +
    `dim = night · amber bar = moved since this morning</div>`;

  const strip = $('tl-strip'), read = $('tl-read');
  const show = (e) => {
    const cell = e.target.closest('.tl-cell');
    if (cell) read.innerHTML = readoutFor(hours[+cell.dataset.i]);
  };
  strip.addEventListener('mousemove', show);
  strip.addEventListener('click', show);
  strip.addEventListener('mouseleave', () => { read.innerHTML = readoutFor(hours[0]); });
}

/* ------------------------- what is actually happening --------------------- */

/* The red card at the top of the page: weather the field is having that the
   forecast did not call for. Everything else here reads forecasts against
   forecasts; this reads the field's own METAR against the version of the grid
   a morning go/no-go was made against (WXA's first archived snapshot), falling
   back to the live grid when the archive has no snapshot for today yet.
   It shouts only on divergence, and only in the direction that costs a pilot
   something — a day that turned out better than called is not an alert. The
   evidence line under the hour-by-hour strip prints on every load, so a silent
   card reads as "checked and agreeing", never as "the check failed". */

const NC_STALE_MS = 100 * 60000;      // KNAK files hourly — older than this is not "now"
const NC_WIND_MIN = 18;               // kt: below this a wind bust is not worth a red card
const NC_WIND_OVER = 10;              // kt over what was called

/* The field's own current observation. Live NWS first (the archive's
   latest.json is only rewritten hourly); its last archived METAR is the
   fallback, and is usually the same ob. */
async function loadFieldObs() {
  const id = AVN.field.metarStation || AVN.field.id;
  const take = (raw, iso) => {
    const ms = Date.parse(iso);
    if (!raw || !Number.isFinite(ms)) return null;
    return { id, raw, ms, o: metarObs(raw) };
  };
  try {
    const p = (await fetchJSON(`${NWS}/stations/${id}/observations/latest`)).properties;
    const ob = take(p.rawMessage, p.timestamp);
    if (ob) { AVN.obs = ob; return; }
  } catch (e) { /* fall through to the archive */ }
  if (typeof WXA === 'undefined') return;
  const wl = await WXA.latest();
  const list = (wl && wl.fieldobs) || [];
  const last = list[list.length - 1];
  if (last) {
    AVN.obs = { id: (wl && wl.field_station) || id, raw: last[1], ms: last[0] * 1000, o: metarObs(last[1]) };
  }
}

/* What was forecast for one hour at the field, and by which issuance. The
   morning snapshot is the baseline that matters — it is what the day was
   planned against — but before the first snapshot of the day is archived
   (or when the archive is absent) the live grid is the only forecast there is,
   and it is labelled as such. */
function forecastAt(hr) {
  if (AVN.base && typeof WXA !== 'undefined') {
    const ceil = WXA.gridAt(AVN.base, 'ceil', hr), vis = WXA.gridAt(AVN.base, 'vis', hr);
    if (ceil !== undefined || vis !== undefined) {
      return {
        src: 'morning', label: 'this morning’s grid',
        ceil: ceil ?? null, vis: vis ?? null,
        spd: WXA.gridAt(AVN.base, 'spd', hr) ?? null,
        gst: WXA.gridAt(AVN.base, 'gst', hr) ?? null,
        pop: WXA.gridAt(AVN.base, 'pop', hr) ?? null,
        wx: WXA.gridAt(AVN.base, 'wx', hr) || '',
      };
    }
  }
  if (AVN.grid && (AVN.grid.ceil.has(hr) || AVN.grid.vis.has(hr) || AVN.grid.tempC.has(hr))) {
    return {
      src: 'live', label: 'the current grid',
      ceil: AVN.grid.ceil.get(hr) ?? null, vis: AVN.grid.vis.get(hr) ?? null,
      spd: AVN.grid.spd.get(hr) ?? null, gst: AVN.grid.gst.get(hr) ?? null,
      pop: AVN.grid.pop.get(hr) ?? null,
      wx: (AVN.grid.wx.get(hr) || []).map((w) => w.wx).join(', '),
    };
  }
  return null;
}

const ncWet = (s) => /rain|shower|drizzle|thunder|snow|sleet|freezing|precip/i.test(s || '');

/* Observed vs called, as a list of specific divergences. Each one names the
   number that makes it true — a red card that can't say what it saw is noise. */
function nowcastFindings(obs, fc) {
  const o = obs.o, out = [];
  const fCat = catOf(fc.vis, fc.ceil);
  if (o.cat > fCat) {
    out.push({
      lead: `${CATS[o.cat]} at ${obs.id}`,
      what: `<b>${CATS[o.cat]}</b> — ${esc(catCause(o.visSM, o.ceilFt))}`,
      said: `${CATS[fCat]} (${esc(catCause(fc.vis, fc.ceil))})`,
    });
  }
  if (o.ts && !/thunder/i.test(fc.wx)) {
    out.push({
      lead: `thunder at ${obs.id}`,
      what: '<b>thunder</b> in the observation',
      said: fc.wx ? `${esc(fc.wx)}, no thunder` : 'no thunder this hour',
    });
  }
  if (o.rain && !o.ts && !ncWet(fc.wx) && (fc.pop == null || fc.pop < 25)) {
    out.push({
      lead: `rain at ${obs.id}`,
      what: '<b>precipitation</b> falling',
      said: `${fc.pop == null ? 'nothing' : `${fc.pop}% chance`} this hour`,
    });
  }
  const peak = Math.max(o.spd || 0, o.gst || 0);
  const called = Math.max(fc.spd || 0, fc.gst || 0);
  if (peak >= NC_WIND_MIN && peak >= called + NC_WIND_OVER) {
    out.push({
      lead: `${peak} kt at ${obs.id}`,
      what: `<b>${o.spd} kt${o.gst ? ` gusting ${o.gst}` : ''}</b>`,
      said: called ? `${Math.round(called)} kt` : 'light wind',
    });
  }
  return out;
}

/* One line of evidence under the hour-by-hour strip: what the field is
   actually reporting, always, so the red card's silence means agreement. */
function nowcastEvidence() {
  if (!AVN.obs) return '<span class="faint">No current observation for the field.</span>';
  const o = AVN.obs.o, age = Date.now() - AVN.obs.ms;
  const stamp = fmtTime(new Date(AVN.obs.ms), { hour: 'numeric', minute: '2-digit' });
  const stale = age > NC_STALE_MS ? ` <span class="faint">(${Math.round(age / 60000)} min old)</span>` : '';
  /* fmtVis caps at P6SM because the grid does; an observation reports the real
     number, so print that unless the METAR itself said P6SM. */
  const vis = o.visSM == null ? '—'
    : /\bP6SM\b/.test(AVN.obs.raw) ? 'P6SM' : `${+o.visSM.toFixed(1)} SM`;
  return `Observed at <b>${esc(AVN.obs.id)}</b> ${esc(stamp)}: ` +
    `<b class="cat-${CATS[o.cat].toLowerCase()}">${CATS[o.cat]}</b> · ` +
    `${esc(fmtCeil(o.ceilFt))} / ${esc(vis)}` +
    `${o.spd == null ? '' : ` · ${o.spd} kt${o.gst ? ` G${o.gst}` : ''}`}${stale}`;
}

/* Fill (or hide) the alert card above the headline. */
function renderNowcast() {
  const card = $('nowcast');
  if (!card) return;
  const hr = Math.floor(Date.now() / 3600000) * 3600000;
  const fc = forecastAt(hr);
  const fresh = AVN.obs && Date.now() - AVN.obs.ms <= NC_STALE_MS;
  const found = fresh && fc ? nowcastFindings(AVN.obs, fc) : [];
  if (!found.length) { card.hidden = true; return; }

  const leads = found.map((f) => f.lead);
  const title = `${leads[0].charAt(0).toUpperCase()}${leads[0].slice(1)}` +
    (leads.length > 1 ? `, and ${leads.length - 1} more the forecast didn’t call` : ' — not what was forecast');
  $('nc-title').innerHTML = esc(title);
  $('nc-stamp').textContent = fmtTime(new Date(AVN.obs.ms), { hour: 'numeric', minute: '2-digit' });
  $('nc-list').innerHTML = found.map((f) =>
    `<li><span class="got">${f.what}</span> <span class="vs">vs</span> ` +
    `<span class="said">${fc.label} called ${f.said}</span></li>`).join('');

  const hasLive = AVN.grid && (AVN.grid.ceil.has(hr) || AVN.grid.vis.has(hr));
  const live = hasLive ? catOf(AVN.grid.vis.get(hr) ?? null, AVN.grid.ceil.get(hr) ?? null) : null;
  const lagging = fc.src === 'morning' && live != null && live < AVN.obs.o.cat
    ? ` The current grid still has this hour as <b>${CATS[live]}</b>.` : '';
  $('nc-foot').innerHTML =
    `${esc(AVN.obs.id)} is the field’s sensor (${esc(AVN.field.id)} has none); the forecast is the ` +
    `NWS hourly grid at ${esc(AVN.field.id)}, as issued ${fc.src === 'morning' ? 'this morning' : 'now'}.` +
    `${lagging} <span class="raw">${esc(AVN.obs.raw)}</span>`;
  card.hidden = false;
}

/* Re-read the observation and redraw. Called on the page's 10-minute tick, so
   a card that appears mid-visit does not need a reload to show up. */
AVN.refreshNowcast = async function refreshNowcast() {
  try { await loadFieldObs(); } catch (e) { /* keep the last ob */ }
  renderNowcast();
  renderFieldGrid();   // also refreshes the observation line's age
};

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
  const jobs = [loadFieldObs().catch(() => {})];
  jobs.push(...AVN.stations.map(async (st) => {
    try { AVN.tafs[st.id] = await loadTafPair(st.id); }
    catch (e) { AVN.tafs[st.id] = { err: `unavailable (${e.message})` }; }
  }));
  jobs.push(loadFieldGrid().catch((e) => { AVN.gridErr = e.message; }));
  await Promise.all(jobs);
  renderNowcast();
  renderFieldGrid();   // renders the failure itself, and the observation either way
  renderTafChanges();
};
