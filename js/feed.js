/* Data Feed — the site's intake log.
   ---------------------------------------------------------------------------
   Every record this site takes in, newest first, as one merged stream: each
   METAR from KDCA, KNAK and the other nearby stations; each TAF and AFD
   issuance; each forecast, grid and model snapshot; each alert; and each
   tracker snapshot push.

   Read from data/wx/ via WXA (js/wx-archive.js) plus the tracker's
   summary.json, so the page has no weather API of its own — it is a view of
   what the archive holds, not a second collector.

   Two kinds of timestamp, kept apart. Grid/forecast/model snapshots stamp
   `t` when the archiver wrote them, alerts stamp `seen`, the tracker stamps
   `generated`: for those the row time is when the site captured the record.
   METARs, TAFs and AFDs carry only their observation or issuance time and
   were picked up later by the hourly run; those times get a dotted underline
   and a hover note. The page never labels the second kind as an arrival.

   Every row shows the size of the record behind it. One-liners cut the part
   that matters least (a METAR's RMK group, a TAF's WMO header), and an
   expansion too large to print says where it stopped and links the file.

   Needs js/site-config.js and js/wx-archive.js loaded first. */

'use strict';

const $ = (id) => document.getElementById(id);
const TZ = SITE.weather.timeZone;

/* ---------------------------------------------------------------------------
   Local time. Archive days are local days at the field, same rule as the
   almanac and weather.js solarTimes() — all day math goes through the
   formatter so a viewer anywhere reads the field's clock.
--------------------------------------------------------------------------- */

const FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

const pad = (n) => String(n).padStart(2, '0');

/* epoch seconds -> {date:'YYYY-MM-DD', h, m, s} at the field */
function lp(ts) {
  const str = FMT.format(new Date(ts * 1000));
  const m = str.match(/(\d{4}-\d{2}-\d{2}),? (\d{2}):(\d{2}):(\d{2})/);
  return m ? { date: m[1], h: +m[2], m: +m[3], s: +m[4] } : { date: '?', h: 0, m: 0, s: 0 };
}

const clock = (ts) => { const p = lp(ts); return `${pad(p.h)}:${pad(p.m)}:${pad(p.s)}`; };
const dayOf = (ts) => lp(ts).date;
const niceDate = (date) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US',
  { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

function ago(sec) {
  if (sec == null) return '';
  if (sec < 60) return `${Math.round(sec)}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
  return `${Math.round(sec / 86400)}d ago`;
}

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* Bytes, the way a log should print them. */
function size(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

/* ---------------------------------------------------------------------------
   The streams, and what each one is. `clock:'in'` means the record's stamp is
   the moment the site took it in; `clock:'own'` means it is the record's own
   moment and capture happened later, on the next hourly run.

   All METARs are one stream. The archive keeps KDCA (obs/), KNAK (fieldobs/)
   and the nearby fields (stations/<ID>/) apart, and the day header's
   coverage line still reports them apart, but a reader of the feed wants the
   record type in the badge and the station in the next column.
--------------------------------------------------------------------------- */

const STREAMS = {
  metar:    { name: 'metar',    color: '#4a9eff', what: 'METAR. KDCA verifies the DC forecast, KNAK stands in for KANP, the rest are the nearby fields' },
  taf:      { name: 'taf',      color: '#a78bfa', what: 'TAF for KMTN, KBWI or KDCA' },
  afd:      { name: 'afd',      color: '#f59e0b', what: 'Area Forecast Discussion from NWS Baltimore/Washington' },
  pirep:    { name: 'pirep',    color: '#facc15', what: 'PIREP filed within ~150 nm of the field, at the report\'s own time' },
  airsig:   { name: 'airsig',   color: '#fb7185', what: 'G-AIRMET, SIGMET or AIRMET touching the region, stamped when first seen' },
  tfr:      { name: 'tfr',      color: '#c084fc', what: 'FAA TFR listed for MD/VA/DC/DE/PA/WV/NJ or ZDC/PCT, stamped when first seen' },
  raob:     { name: 'raob',     color: '#38bdf8', what: 'KIAD radiosonde sounding (00Z/12Z), at its launch time' },
  aloft:    { name: 'aloft',    color: '#a3e635', what: 'GFS winds and temps aloft at the field, 925/850/700/500 hPa' },
  forecast: { name: 'forecast', color: '#f0883e', what: 'NWS daily forecast digest at the DC point' },
  grid:     { name: 'grid',     color: '#2dd4bf', what: 'NWS hourly grid at the field: 48 h of ceiling, vis, wind, PoP' },
  model:    { name: 'model',    color: '#e879a6', what: 'GFS point read at the field: CAPE, CIN, precip' },
  alert:    { name: 'alert',    color: '#ef4444', what: 'NWS alert, stamped when the archiver first saw it' },
  tracker:  { name: 'tracker',  color: '#94a3b8', what: 'ADS-B snapshot pushed by the Pi exporter to the traffic-data branch' },
};

/* ---------------------------------------------------------------------------
   One-liners. Each drops the part of the record that carries the least and
   keeps the part a reader scans for; the whole record is one click away.
--------------------------------------------------------------------------- */

/* A METAR's remarks are half its length and none of its headline. */
function metarOne(raw) {
  const i = raw.indexOf(' RMK ');
  return i > 0 ? raw.slice(0, i) : raw;
}

/* A backfilled TAF arrives wrapped in its WMO transmission header; the
   forecast proper starts at the line beginning with the station id. */
function tafOne(rec) {
  if (rec.raw) {
    const lines = rec.raw.split('\n').map((s) => s.trim()).filter(Boolean);
    const i = lines.findIndex((l) => /^[A-Z]{4} \d{6}Z/.test(l));
    const body = lines.slice(i >= 0 ? i : 0);
    return `${body[0] || rec.station}${body.length > 1 ? ` … +${body.length - 1} lines` : ''}`;
  }
  const p = rec.periods || [];
  if (!p.length) return `${rec.station} — no periods`;
  const last = p[p.length - 1];
  return `${rec.station} ${p.length} period${p.length === 1 ? '' : 's'}, through ${clock(last.e)} ${dayOf(last.e).slice(5)}`;
}

/* The AFD's own first section heading plus its first line of prose — which is
   where LWX puts what changed, when anything did. */
function afdOne(txt) {
  const lines = String(txt || '').split('\n').map((s) => s.trim());
  const i = lines.findIndex((l) => /^\.[A-Z]/.test(l));
  if (i >= 0) {
    const sec = lines[i].replace(/^\./, '').replace(/\.{2,}.*$/, '');
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j] && lines[j] !== '&&') return `${sec} — ${lines[j]}`;
    }
    return sec;
  }
  return lines.find((l) => l.length > 20) || '(empty)';
}

function forecastOne(snap) {
  const days = Object.keys(snap.days || {});
  if (!days.length) return 'no days';
  const d = snap.days[days[0]];
  return `${days.length} days · ${days[0].slice(5)} ${d.hi == null ? '—' : d.hi}/${d.lo == null ? '—' : d.lo}°F, PoP ${d.pop == null ? '—' : d.pop}% — ${d.short || ''}`;
}

function gridOne(snap) {
  const c = snap.ceil && snap.ceil[0];
  const parts = [
    `${snap.n} h from ${clock(snap.t0)}`,
    `ceil ${c == null ? 'none' : `${c} ft`}`,
    `vis ${snap.vis ? snap.vis[0] : '—'} sm`,
    `${snap.spd ? snap.spd[0] : '—'} kt`,
    `PoP ${snap.pop ? snap.pop[0] : '—'}%`,
  ];
  const wx = (snap.wx || []).filter(Boolean).length;
  if (wx) parts.push(`${wx} h with weather`);
  return parts.join(' · ');
}

function modelOne(snap) {
  const cape = snap.cape || [];
  const peak = cape.length ? Math.max.apply(null, cape) : null;
  const pr = (snap.pr || []).reduce((a, b) => a + (b || 0), 0);
  return `${snap.n} h from ${clock(snap.t0)} · CAPE ${cape.length ? cape[0] : '—'} now, peak ${peak == null ? '—' : peak} J/kg · ${pr.toFixed(1)} mm total`;
}

const hm = (ts) => clock(ts).slice(0, 5);
const pad3 = (n) => (n == null ? '—' : String(n).padStart(3, '0'));

/* A G-AIRMET has no text of its own; a SIGMET's raw product is the
   expansion. The one-liner is kind, hazard, window, altitudes. */
function airsigOne(it) {
  const win = it.from && it.to ? `${hm(it.from)}–${hm(it.to)}` : '';
  const alt = it.kind === 'G-AIRMET'
    ? [it.base != null ? `base ${it.base}` : null, it.top != null ? `top ${it.top}` : null].filter(Boolean).join(' ')
    : [it.lo != null ? `${it.lo.toLocaleString()}` : null, it.hi != null ? `to ${it.hi.toLocaleString()} ft` : null].filter(Boolean).join(' ');
  return [`${it.kind}${it.product ? ' ' + it.product : ''} ${it.hazard || ''}`.trim(), win, alt, it.due]
    .filter(Boolean).join(' · ');
}

/* Freezing level from the first sub-zero level, interpolated, in feet. */
function freezingFt(levels) {
  for (let i = 1; i < levels.length; i++) {
    const a = levels[i - 1], b = levels[i];
    if (a[2] == null || b[2] == null || a[1] == null || b[1] == null) continue;
    if (a[2] > 0 && b[2] <= 0) {
      const f = a[2] / (a[2] - b[2]);
      return Math.round((a[1] + f * (b[1] - a[1])) * 3.28084);
    }
  }
  return null;
}

function raobOne(s, station) {
  const L = s.levels || [];
  const sfc = L[0] || [];
  const z = new Date(s.t * 1000).getUTCHours();
  const fz = freezingFt(L);
  return [`${station} ${pad(z)}Z`, `${L.length} levels`,
    sfc.length ? `sfc ${sfc[2]}/${sfc[3]} °C ${pad3(sfc[4])}/${sfc[5] == null ? '—' : sfc[5]} kt` : null,
    fz != null ? `frz lvl ${fz.toLocaleString()} ft` : null].filter(Boolean).join(' · ');
}

function raobText(s, station) {
  const lines = [`${station} ${new Date(s.t * 1000).toISOString().slice(0, 16)}Z`,
    '  hPa      ft   T °C  Td °C   dir   kt'];
  for (const l of s.levels || []) {
    const f = (v, w, d = 0) => (v == null ? '—' : (+v).toFixed(d)).padStart(w);
    lines.push(`${f(l[0], 5)} ${f(l[1] == null ? null : l[1] * 3.28084, 7)} ${f(l[2], 6, 1)} ${f(l[3], 6, 1)} ${f(l[4], 5)} ${f(l[5], 4)}`);
  }
  return lines.join('\n');
}

function aloftOne(s) {
  const at = (i) => `${s.lev[i]} ${pad3((s.dir[i] || [])[0])}/${(s.spd[i] || [])[0] == null ? '—' : s.spd[i][0]}`;
  return [`${s.n} h from ${clock(s.t0)}`].concat(s.lev.map((_, i) => at(i))).join(' · ') + ' kt';
}

/* ---------------------------------------------------------------------------
   Row building. A row is one record: its own time, which clock that time is
   on, the stream, the source, a one-liner, the file it came from, and the
   record itself for the expansion.
--------------------------------------------------------------------------- */

const rows = [];
const seen = new Set();               // record keys — dedupes day files against latest.json
const metarTimes = new Map();         // station -> its ts, for the 90 s tolerance below

function add(r) {
  const key = r.key || `${r.stream}|${r.src}|${r.t}`;
  if (seen.has(key)) return false;
  if (r.stream === 'metar') {
    /* the archiver treats obs within 90 s as one ob — IEM and NWS round the
       same METAR to different seconds — so a live copy and a healed copy of
       one ob must not become two rows here */
    const ts = metarTimes.get(r.src) || [];
    if (ts.some((t) => Math.abs(t - r.t) <= 90)) return false;
    ts.push(r.t);
    metarTimes.set(r.src, ts);
  }
  seen.add(key);
  r.key = key;
  rows.push(r);
  return true;
}

function metarRows(doc, path) {
  if (!doc || !doc.metars) return;
  for (const pair of doc.metars) {
    const t = pair[0], raw = pair[1];
    add({ t, clock: 'own', stream: 'metar', src: doc.station || '?', one: metarOne(raw),
          text: raw, bytes: raw.length, path });
  }
}

function tafRows(doc, path) {
  if (!doc || !doc.tafs) return;
  for (const rec of doc.tafs) {
    add({ t: rec.t, clock: 'own', stream: 'taf', src: rec.station, one: tafOne(rec),
          text: rec.raw || null, rec, bytes: JSON.stringify(rec).length, path,
          tag: rec.bf ? 'healed' : null });
  }
}

function snapRows(doc, stream, path, one) {
  if (!doc || !doc.snaps) return;
  for (const snap of doc.snaps) {
    add({ t: snap.t, clock: 'in', stream, src: stream === 'forecast' ? 'DC point' : 'KANP',
          one: one(snap), rec: snap, bytes: JSON.stringify(snap).length, path });
  }
}

function alertRows(doc, path) {
  if (!doc || !doc.alerts) return;
  for (const a of doc.alerts) {
    add({ t: a.seen, clock: 'in', stream: 'alert', src: 'NWS',
          one: a.headline || a.event, text: a.desc, rec: a,
          bytes: JSON.stringify(a).length, path });
  }
}

/* The archiver files each AFD as afd/YYYY/afd-YYYYMMDD-HHMM.json on its UTC
   issuance stamp, so a row from latest.json can cite that file. */
function afdPath(doc) {
  const d = new Date(doc.issuanceTime);
  if (isNaN(d)) return 'latest.json';
  const u = d.toISOString().replace(/\D/g, '');       // YYYYMMDDHHMMSSmmm
  return `afd/${u.slice(0, 4)}/afd-${u.slice(0, 8)}-${u.slice(8, 12)}.json`;
}

function afdRow(doc, path) {
  if (!doc || !doc.productText) return;
  const t = Math.round(Date.parse(doc.issuanceTime) / 1000);
  if (!isFinite(t)) return;
  add({ t, clock: 'own', stream: 'afd', src: doc.office || 'LWX', one: afdOne(doc.productText),
        text: doc.productText, bytes: doc.productText.length, path,
        tag: doc.bf ? 'healed' : null });
}

function pirepRows(doc, path) {
  if (!doc || !doc.pireps) return;
  for (const p of doc.pireps) {
    add({ t: p.t, clock: 'own', stream: 'pirep', src: p.ac || '?', one: p.raw, text: p.raw,
          rec: p, bytes: JSON.stringify(p).length, path, key: `pirep|${p.t}|${p.raw}` });
  }
}

function airsigRows(doc, path) {
  if (!doc || !doc.items) return;
  for (const it of doc.items) {
    add({ t: it.first, clock: 'in', stream: 'airsig', src: it.product || it.kind, one: airsigOne(it),
          text: it.raw || null, rec: it, bytes: JSON.stringify(it).length, path, key: `airsig|${it.id}` });
  }
}

function tfrRows(doc, path) {
  if (!doc || !doc.tfrs) return;
  for (const f of doc.tfrs) {
    add({ t: f.first, clock: 'in', stream: 'tfr', src: f.state || f.facility || '?',
          one: `${f.type || 'TFR'} · ${f.desc || f.id}`, rec: f, bytes: JSON.stringify(f).length,
          path, key: `tfr|${f.id}` });
  }
}

function raobRows(doc, path) {
  if (!doc || !doc.soundings) return;
  for (const s of doc.soundings) {
    add({ t: s.t, clock: 'own', stream: 'raob', src: doc.station || 'KIAD', one: raobOne(s, doc.station || 'KIAD'),
          text: raobText(s, doc.station || 'KIAD'), rec: s, bytes: JSON.stringify(s).length, path,
          tag: s.bf ? 'healed' : null });
  }
}

/* ---------------------------------------------------------------------------
   Loading. index.json is the catalog: which days each stream holds. Days are
   loaded newest first, one whole day at a time, all streams in parallel.
--------------------------------------------------------------------------- */

let IDX = null;
let loaded = [];                      // days already pulled, newest first
let allDays = [];                     // every day any stream holds, newest first
const dayMeta = new Map();            // date -> coverage/provenance notes

const has = (list, date) => Array.isArray(list) && list.includes(date);

function catalogDays(idx) {
  const set = new Set();
  for (const k of ['obs_days', 'fieldobs_days', 'grid_days', 'taf_days',
                   'alert_days', 'model_days', 'forecast_days', 'pirep_days',
                   'airsig_days', 'tfr_days', 'raob_days', 'aloft_days']) {
    for (const d of idx[k] || []) set.add(d);
  }
  for (const days of Object.values(idx.station_days || {})) for (const d of days) set.add(d);
  for (const a of idx.afd || []) set.add(dayOf(a.t));
  return Array.from(set).sort().reverse();
}

/* Hours held for a METAR stream on a day, out of index.json — h = hours with
   an observation, nh = hours the station never reported (a part-time field
   asleep overnight is not a gap). Anything else is missing. */
function hoursNote(idx, stream, id, date) {
  let days, hrs;
  if (stream === 'ring') {
    days = (idx.station_days || {})[id];
    hrs = (idx.hours || {}).stations && idx.hours.stations[id];
  } else {
    const k = stream === 'field' ? 'fieldobs' : 'obs';
    days = idx[`${k}_days`];
    hrs = (idx.hours || {})[k];
  }
  if (!days || !hrs || !hrs.h) return null;
  const i = days.indexOf(date);
  if (i < 0) return null;
  const h = hrs.h[i], nh = (hrs.nh || [])[i] || 0;
  /* Hours after the last archive run are not missing, they are not archived
     yet. index.json's `updated` is that run; the hour it ran in is still
     open (the routine ob comes at :5x), so only the hours before it count. */
  const upd = idx.updated || Date.now() / 1000;
  const runDay = dayOf(upd);
  const expect = date < runDay ? 24 : date === runDay ? lp(upd).h : 0;
  return { h, nh, missing: Math.max(0, expect - h - nh) };
}

/* The streams a day is read from, in the order loadDay() unpacks them —
   only the files index.json says exist, so a stream that never held the day
   is not a 404 worth asking for. */
const DAY_STREAMS = [
  ['obs', 'obs_days'], ['fieldobs', 'fieldobs_days'], ['taf', 'taf_days'], ['grid', 'grid_days'],
  ['forecast', 'forecast_days'], ['model', 'model_days'], ['alerts', 'alert_days'],
  ['pirep', 'pirep_days'], ['airsig', 'airsig_days'], ['tfr', 'tfr_days'], ['raob', 'raob_days'],
  ['aloft', 'aloft_days'],
];
const ringOn = (ids, date) => ids.filter((id) => has((IDX.station_days || {})[id], date));

/* Every archive path a day's rows come from, so a live refresh can drop them
   from WXA's cache and read the day again. */
function dayPaths(date, ids) {
  const p = DAY_STREAMS.filter(([, k]) => has(IDX[k], date)).map(([s]) => `${s}/${date}.json`);
  for (const id of ringOn(ids, date)) p.push(`stations/${id}/${date}.json`);
  return p;
}

async function loadDay(date) {
  const ids = await WXA.stations();
  const ringIds = ringOn(ids, date);
  const all = await Promise.all(
    DAY_STREAMS.map(([s, k]) => (has(IDX[k], date) ? WXA.day(s, date) : Promise.resolve(null)))
      .concat(ringIds.map((id) => WXA.station(id, date))));
  const [obs, fobs, taf, grid, fc, model, alerts, pirep, airsig, tfr, raob, aloft] = all;
  const st = all.slice(DAY_STREAMS.length);

  metarRows(obs, `obs/${date}.json`);
  metarRows(fobs, `fieldobs/${date}.json`);
  ringIds.forEach((id, i) => metarRows(st[i], `stations/${id}/${date}.json`));
  tafRows(taf, `taf/${date}.json`);
  snapRows(grid, 'grid', `grid/${date}.json`, gridOne);
  snapRows(fc, 'forecast', `forecast/${date}.json`, forecastOne);
  snapRows(model, 'model', `model/${date}.json`, modelOne);
  alertRows(alerts, `alerts/${date}.json`);
  pirepRows(pirep, `pirep/${date}.json`);
  airsigRows(airsig, `airsig/${date}.json`);
  tfrRows(tfr, `tfr/${date}.json`);
  raobRows(raob, `raob/${date}.json`);
  snapRows(aloft, 'aloft', `aloft/${date}.json`, aloftOne);

  const afds = (IDX.afd || []).filter((a) => dayOf(a.t) === date);
  await Promise.all(afds.map(async (a) => afdRow(await WXA.json(a.p), a.p)));

  /* What the day's own files say about their completeness and provenance,
     printed in the day header. A count of rows cannot show what never
     arrived, and a healed record did not arrive on time. */
  const cover = [], heal = [];
  const push = (label, n) => {
    if (n) cover.push(`${label} ${n.h} h${n.missing ? ` · ${n.missing} h missing` : ''}${n.nh ? ` · ${n.nh} h not reported` : ''}`);
  };
  push((obs && obs.station) || 'KDCA', hoursNote(IDX, 'obs', null, date));
  push((fobs && fobs.station) || 'KNAK', hoursNote(IDX, 'field', null, date));
  let ringH = 0, ringMiss = 0, ringNh = 0, ringN = 0;
  ringIds.forEach((id, i) => {
    if (!st[i]) return;
    ringN++;
    const n = hoursNote(IDX, 'ring', id, date);
    if (n) { ringH += n.h; ringMiss += n.missing; ringNh += n.nh; }
  });
  if (ringN) {
    cover.push(`${ringN} other station${ringN === 1 ? '' : 's'} ${ringH} h`
      + (ringMiss ? ` · ${ringMiss} h missing` : '')
      + (ringNh ? ` · ${ringNh} h not reported` : ''));
  }
  for (const pair of [[obs, obs && obs.station], [fobs, fobs && fobs.station], [taf, 'TAF']]) {
    const doc = pair[0];
    if (doc && doc.bf && doc.bf.n) heal.push(`${pair[1]} ${doc.bf.n}`);
  }
  ringIds.forEach((id, i) => {
    const d = st[i];
    if (d && d.bf && d.bf.n) heal.push(`${id} ${d.bf.n}`);
  });
  dayMeta.set(date, { cover, heal });
}

/* latest.json — the current state of every stream in one document. Merged on
   load and on every live poll, so the top of the feed is as fresh as the
   archive is, without re-reading a day file. */
function mergeLatest(doc) {
  if (!doc) return 0;
  const before = rows.length;
  for (const pair of doc.obs || []) {
    add({ t: pair[0], clock: 'own', stream: 'metar', src: doc.station || 'KDCA',
          one: metarOne(pair[1]), text: pair[1], bytes: pair[1].length,
          path: `obs/${dayOf(pair[0])}.json` });
  }
  for (const pair of doc.fieldobs || []) {
    add({ t: pair[0], clock: 'own', stream: 'metar', src: doc.field_station || 'KNAK',
          one: metarOne(pair[1]), text: pair[1], bytes: pair[1].length,
          path: `fieldobs/${dayOf(pair[0])}.json` });
  }
  for (const ent of Object.entries(doc.stations || {})) {
    const id = ent[0], pair = ent[1];
    if (!pair) continue;
    add({ t: pair[0], clock: 'own', stream: 'metar', src: id, one: metarOne(pair[1]),
          text: pair[1], bytes: pair[1].length, path: `stations/${id}/${dayOf(pair[0])}.json` });
  }
  for (const rec of Object.values(doc.tafs || {})) {
    if (rec && rec.t) {
      add({ t: rec.t, clock: 'own', stream: 'taf', src: rec.station, one: tafOne(rec),
            text: rec.raw || null, rec, bytes: JSON.stringify(rec).length,
            path: `taf/${dayOf(rec.t)}.json`, tag: rec.bf ? 'healed' : null });
    }
  }
  if (doc.afd) afdRow(doc.afd, afdPath(doc.afd));
  if (doc.forecast && doc.forecast.t) {
    add({ t: doc.forecast.t, clock: 'in', stream: 'forecast', src: 'DC point',
          one: forecastOne(doc.forecast), rec: doc.forecast,
          bytes: JSON.stringify(doc.forecast).length,
          path: `forecast/${dayOf(doc.forecast.t)}.json` });
  }
  if (doc.grid && doc.grid.t) {
    add({ t: doc.grid.t, clock: 'in', stream: 'grid', src: 'KANP', one: gridOne(doc.grid),
          rec: doc.grid, bytes: JSON.stringify(doc.grid).length,
          path: `grid/${dayOf(doc.grid.t)}.json` });
  }
  if (doc.model && doc.model.t) {
    add({ t: doc.model.t, clock: 'in', stream: 'model', src: 'KANP', one: modelOne(doc.model),
          rec: doc.model, bytes: JSON.stringify(doc.model).length,
          path: `model/${dayOf(doc.model.t)}.json` });
  }
  for (const a of doc.alerts || []) {
    if (a && a.seen) {
      add({ t: a.seen, clock: 'in', stream: 'alert', src: 'NWS', one: a.headline || a.event,
            text: a.desc, rec: a, bytes: JSON.stringify(a).length,
            path: `alerts/${dayOf(a.seen)}.json` });
    }
  }
  pirepRows({ pireps: doc.pireps || [] }, null);
  for (const r of rows) if (r.stream === 'pirep' && !r.path) r.path = `pirep/${dayOf(r.t)}.json`;
  for (const it of doc.airsig || []) {
    if (it && it.first) airsigRows({ items: [it] }, `airsig/${dayOf(it.first)}.json`);
  }
  for (const f of doc.tfrs || []) {
    if (f && f.first) tfrRows({ tfrs: [f] }, `tfr/${dayOf(f.first)}.json`);
  }
  if (doc.raob && doc.raob.t) {
    raobRows({ station: doc.raob.station, soundings: [doc.raob] }, `raob/${dayOf(doc.raob.t)}.json`);
  }
  if (doc.aloft && doc.aloft.t) {
    snapRows({ snaps: [doc.aloft] }, 'aloft', `aloft/${dayOf(doc.aloft.t)}.json`, aloftOne);
  }
  return rows.length - before;
}

/* The tracker publishes one document; its `generated` stamp is a real arrival
   time, and `newest_position` is a different claim — when an aircraft was last
   heard — so the row prints both rather than averaging them into "fresh". */
async function loadTracker() {
  let sum = null;
  try {
    const r = await fetch(`${SITE.tracker.snapshotBase}/summary.json`, { cache: 'no-cache' });
    sum = r.ok ? await r.json() : null;
  } catch (e) { sum = null; }
  if (!sum || !sum.generated) return 0;
  const days = sum.days || [];
  const today = days.length ? days[days.length - 1] : null;
  const lag = sum.newest_position ? sum.generated - sum.newest_position : null;
  const one = [
    today ? `${today.aircraft.toLocaleString()} aircraft, ${today.points.toLocaleString()} points on ${today.date}` : 'snapshot pushed',
    lag == null ? 'no position stamp' : `newest position ${lag <= 1 ? 'current at push' : `${ago(lag)} at push`}`,
    `${days.length} days on file`,
  ].join(' · ');
  return add({ t: sum.generated, clock: 'in', stream: 'tracker', src: 'Pi exporter', one,
               rec: sum, bytes: JSON.stringify(sum).length,
               path: `${SITE.tracker.snapshotBase}/summary.json`, ext: true }) ? 1 : 0;
}

/* ---------------------------------------------------------------------------
   Rendering.
--------------------------------------------------------------------------- */

const off = new Set();                // streams switched off by the chips
let query = '';

function visible() {
  const q = query.trim().toLowerCase();
  return rows.filter((r) => !off.has(r.stream)
    && (!q || r.one.toLowerCase().includes(q) || r.src.toLowerCase().includes(q)
        || STREAMS[r.stream].name.includes(q)
        || (r.text != null && (r.lc || (r.lc = r.text.toLowerCase())).includes(q))));
}

const MAXEXP = 20000;                 // an expansion longer than this is cut, and says so

function fullText(r) {
  let s, note = '';
  if (r.text != null) s = r.text;
  else if (r.rec != null) s = JSON.stringify(r.rec, null, 1);
  else s = r.one;
  if (s.length > MAXEXP) {
    note = `\n\n… cut at ${MAXEXP.toLocaleString()} of ${s.length.toLocaleString()} characters. The whole record is in the file below.`;
    s = s.slice(0, MAXEXP);
  }
  return s + note;
}

const openKeys = new Set();           // expanded rows, kept open across re-renders

/* ---------------------------------------------------------------------------
   One arrival, one line. The hourly routine obs land together — a dozen
   stations between :52 and :56 — and printed one per line they bury every
   other record on the page. METARs whose times are within MET_GAP of each
   other become one set: the badge still says metar, the source column says
   how many stations, and the set opens to every report in it. A station
   reporting alone still gets its own line.

   Only METARs group. The other streams arrive one record at a time.
--------------------------------------------------------------------------- */

const MET_GAP = 300;                  // seconds between obs still counted as one arrival

function metarSet(g) {
  const ids = Array.from(new Set(g.map((r) => r.src)));
  const span = g[g.length - 1].t === g[0].t ? '' : `${clock(g[g.length - 1].t).slice(0, 5)}–${clock(g[0].t).slice(0, 5)}`;
  return {
    t: g[0].t, clock: 'own', stream: 'metar', src: `${ids.length} stations`,
    one: ids.join(' '),
    bytes: g.reduce((a, r) => a + r.bytes, 0),
    text: g.map((r) => `${clock(r.t)}  ${r.src.padEnd(5)}  ${r.text}`).join('\n'),
    paths: Array.from(new Set(g.map((r) => r.path).filter(Boolean))),
    path: g[0].path,
    tag: g.some((r) => r.tag) ? 'healed' : null,
    span, n: g.length,
    key: `set|${g[0].t}|${g.length}|${ids[0]}`,
  };
}

/* A day's visible rows, newest first, with runs of METARs folded into sets. */
function fold(day) {
  const out = [];
  let run = [];
  const flush = () => {
    /* One station reporting twice in five minutes — a SPECI after its routine
       ob — is two readings from one place, not an arrival of many. Only a run
       covering more than one station folds. */
    const stations = new Set(run.map((r) => r.src));
    if (run.length > 1 && stations.size > 1) out.push(metarSet(run));
    else out.push(...run);
    run = [];
  };
  for (const r of day) {
    if (r.stream !== 'metar') { flush(); out.push(r); continue; }
    if (run.length && run[run.length - 1].t - r.t > MET_GAP) flush();
    run.push(r);
  }
  flush();
  return out;
}

let view = [];                        // what is on screen, sets included

function rowHTML(r, i) {
  const st = STREAMS[r.stream];
  const own = r.clock === 'own';
  return `<div class="row${openKeys.has(r.key) ? ' open' : ''}" data-i="${i}" tabindex="0" role="button"`
    + ` aria-expanded="${openKeys.has(r.key)}">`
    + `<time class="${own ? 'own' : ''}" title="${r.n
        ? `${r.n} observation${r.n === 1 ? '' : 's'}${r.span ? `, ${esc(r.span)}` : ''}. Each is the station's own observation time.`
        : own
          ? 'Observation or issuance time. The archiver picked this record up on a later run.'
          : 'When the site captured this record.'}">${clock(r.t)}</time>`
    + `<span class="badge" style="color:${st.color};border-color:${st.color}55;background:${st.color}14">${st.name}</span>`
    + `<span class="src">${esc(r.src)}</span>`
    + `<span class="one">${esc(r.one)}</span>`
    + (r.tag ? `<span class="tag" title="Filled in later from IEM, not captured live.">${esc(r.tag)}</span>` : '')
    + `<span class="bytes">${size(r.bytes)}</span>`
    + `</div>`;
}

function render() {
  const list = visible();
  const byDay = new Map();
  for (const r of list) {
    const d = dayOf(r.t);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(r);
  }
  view = [];

  let html = '';
  for (const date of Array.from(byDay.keys()).sort().reverse()) {
    const day = fold(byDay.get(date).sort((a, b) => b.t - a.t));
    const meta = dayMeta.get(date);
    html += `<section class="day" data-date="${date}"><div class="day-head">`
      + `<h2>${esc(niceDate(date))}</h2>`
      + `<span class="day-n">${byDay.get(date).length.toLocaleString()} record${byDay.get(date).length === 1 ? '' : 's'}</span>`
      + `<a class="day-link" href="almanac.html#d=${date}">almanac →</a></div>`;
    if (!meta) {
      /* A record's day is its own local day, so a TAF issued at 8 PM lands
         here even though this day's files were never opened. Say so rather
         than let an unloaded day look like a measured one. */
      html += `<div class="day-cover partial">This day's files are not loaded.`
        + ` These records came from another day's file or from latest.json, so`
        + ` there is no coverage line yet.</div>`;
    } else if (meta.cover.length || meta.heal.length) {
      html += `<div class="day-cover">${esc(meta.cover.join(' · '))}`
        + (meta.heal.length
            ? `<span class="heal">${meta.cover.length ? ' · ' : ''}filled in later from IEM (records): ${esc(meta.heal.join(', '))}</span>`
            : '')
        + `</div>`;
    }
    html += day.map((r) => { view.push(r); return rowHTML(r, view.length - 1); }).join('');
    html += `</section>`;
  }
  $('feed').innerHTML = html || `<p class="empty">Nothing matches those filters.</p>`;
  $('count').textContent = `${list.length.toLocaleString()} of ${rows.length.toLocaleString()} records`;
  if (openKeys.size) {
    for (const row of $('feed').querySelectorAll('.row')) {
      const r = view[+row.dataset.i];
      if (openKeys.has(r.key)) expand(row, r);
    }
  }
  watchDays();
  drawRail(railDate || Array.from(byDay.keys()).sort().reverse()[0]);
}

/* ---------------------------------------------------------------------------
   The rail — one day's intake as a grid: a row per hour, a column per stream,
   each cell shaded by the bytes that arrived in it. The log says what came in;
   the grid says what an hour looked like, and an empty cell says an hour held
   nothing at all, which no amount of scrolling can show.

   Bytes, not records: an AFD is a thousand METARs by weight, and the point of
   the grid is the weight. The scale is log10 over the whole day and shared by
   every stream, so a cell is comparable across the grid rather than against
   its own column only.

   Hours the archive has not reached yet are not empty hours, and are drawn as
   nothing at all rather than as a hollow cell.
--------------------------------------------------------------------------- */

let railDate = null;
let dayWatch = false;

const railOrder = Object.keys(STREAMS);

function drawRail(date) {
  const el = $('rail');
  if (!el || !date) return;
  railDate = date;

  /* Every record of that day, sets or not — the grid is a picture of the
     archive, so the stream chips do not thin it. */
  const cells = new Map();            // `${stream}|${hour}` -> {b, n}
  const tot = new Map();              // stream -> {b, n}
  let day = 0;
  for (const r of rows) {
    if (dayOf(r.t) !== date) continue;
    const h = lp(r.t).h;
    const k = `${r.stream}|${h}`;
    const c = cells.get(k) || { b: 0, n: 0 };
    c.b += r.bytes; c.n++;
    cells.set(k, c);
    const t = tot.get(r.stream) || { b: 0, n: 0 };
    t.b += r.bytes; t.n++;
    tot.set(r.stream, t);
    day += r.bytes;
  }
  const streams = railOrder.filter((k) => tot.has(k));
  if (!streams.length) { el.innerHTML = ''; return; }

  let max = 0;
  for (const c of cells.values()) max = Math.max(max, c.b);
  const shade = (b) => 0.14 + 0.86 * (Math.log10(b + 1) / Math.log10(max + 1));

  /* An hour the last archive run has not reached is not an empty hour. */
  const upd = (IDX && IDX.updated) || Date.now() / 1000;
  const last = date < dayOf(upd) ? 23 : date === dayOf(upd) ? lp(upd).h : -1;

  let html = `<div class="rail-head">${esc(niceDate(date).replace(/,[^,]*$/, ''))}`
    + `<span>${size(day)}</span></div>`
    + `<div class="grid" style="grid-template-columns:22px repeat(${streams.length}, 1fr)">`
    + `<span class="gh"></span>`
    + streams.map((k) => `<span class="gh" style="color:${STREAMS[k].color}"`
        + ` title="${esc(STREAMS[k].name)} · ${tot.get(k).n} record${tot.get(k).n === 1 ? '' : 's'} · ${size(tot.get(k).b)}">`
        + `${esc(STREAMS[k].name)}</span>`).join('');
  for (let h = 0; h <= last; h++) {
    html += `<span class="gr">${pad(h)}</span>`;
    for (const k of streams) {
      const c = cells.get(`${k}|${h}`);
      html += c
        ? `<button class="gc" data-h="${h}" data-s="${k}"`
          + ` style="background:${STREAMS[k].color};opacity:${shade(c.b).toFixed(2)}"`
          + ` title="${pad(h)}:00 · ${esc(STREAMS[k].name)} · ${c.n} record${c.n === 1 ? '' : 's'} · ${size(c.b)}"></button>`
        : `<span class="gc none" title="${pad(h)}:00 · ${esc(STREAMS[k].name)} · nothing"></span>`;
    }
  }
  el.innerHTML = html + `</div>`;
}

/* A cell is navigation: jump the log to that hour of that stream. */
function railClick(e) {
  const b = e.target.closest('.gc[data-h]');
  if (!b) return;
  const h = +b.dataset.h, k = b.dataset.s;
  const sec = $('feed').querySelector(`.day[data-date="${railDate}"]`);
  if (!sec) return;
  for (const row of sec.querySelectorAll('.row')) {
    const r = view[+row.dataset.i];
    if (r.stream !== k) continue;
    /* a folded set covers a span, so match the set's newest hour or any
       hour it reaches back into */
    if (lp(r.t).h < h) break;
    if (lp(r.t).h !== h) continue;
    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    row.classList.add('hit');
    setTimeout(() => row.classList.remove('hit'), 1200);
    row.focus({ preventScroll: true });
    return;
  }
}

/* The rail follows the day you are reading: whichever day section the top of
   the reading area is sitting in. A plain scroll read, throttled to a frame —
   the day sections are a handful of elements and their rects are cheap. */

const READ_Y = 120;                   // where the page is "being read", in px

function railFollow() {
  const secs = $('feed').querySelectorAll('.day');
  let pick = null;
  for (const sec of secs) {
    if (sec.getBoundingClientRect().top <= READ_Y) pick = sec;
  }
  if (!pick && secs.length) pick = secs[0];
  if (pick && pick.dataset.date !== railDate) drawRail(pick.dataset.date);
}

function watchDays() {
  if (dayWatch) return;
  dayWatch = true;
  let queued = false;
  addEventListener('scroll', () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; railFollow(); });
  }, { passive: true });
}

/* Expansion is built on demand. Four hundred <pre> blocks a day would cost
   more than the records they hold. */
function expand(row, r) {
  const link = (p) => `<a href="${esc(r.ext ? p : `${WXA.base}/${p}`)}">${esc(r.ext ? p : `${WXA.base}/${p}`)}</a>`;
  const el = document.createElement('div');
  el.className = 'full';
  el.innerHTML = `<pre>${esc(fullText(r))}</pre>`
    + `<div class="prov">${(r.paths || [r.path]).map(link).join('<br>')}`
    + (r.rec && r.rec.url ? ` · <a href="${esc(r.rec.url)}" target="_blank" rel="noopener">FAA detail</a>` : '')
    + ` · ${size(r.bytes)} · ${esc(STREAMS[r.stream].what)}</div>`;
  row.after(el);
  row.classList.add('open');
  row.setAttribute('aria-expanded', 'true');
}

function toggle(row) {
  const r = view[+row.dataset.i];
  const open = row.nextElementSibling;
  if (open && open.classList.contains('full')) {
    open.remove();
    row.classList.remove('open');
    row.setAttribute('aria-expanded', 'false');
    openKeys.delete(r.key);
    return;
  }
  expand(row, r);
  openKeys.add(r.key);
}

function onClick(e) {
  const row = e.target.closest('.row');
  if (row && !e.target.closest('a')) toggle(row);
}

function onKey(e) {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.classList && e.target.classList.contains('row')) {
    e.preventDefault();
    toggle(e.target);
  }
}

/* ---------------------------------------------------------------------------
   Live tail. The archiver runs hourly and the tracker exporter every 15
   minutes, so a poll a minute catches each arrival without asking for
   anything that could have changed in between.
--------------------------------------------------------------------------- */

let live = true, timer = null, lastPoll = null;

async function poll() {
  WXA._cache.delete('latest.json');
  let n = mergeLatest(await WXA.latest()) + (await loadTracker());
  /* A new archive run: re-read the catalog and today's files, so the day
     header's coverage and any healed records follow the archive instead of
     freezing at page load. */
  WXA._cache.delete('index.json');
  const idx = await WXA.index();
  if (idx && IDX && idx.updated !== IDX.updated) {
    IDX = idx;
    allDays = catalogDays(IDX);
    const today = dayOf(Date.now() / 1000);
    for (const p of dayPaths(today, await WXA.stations())) WXA._cache.delete(p);
    await loadDay(today);
    if (!loaded.includes(today)) loaded.unshift(today);
    n += 1;
  }
  lastPoll = Date.now() / 1000;
  if (n) render();
  tick();
}

function tick() {
  $('live-note').textContent = live
    ? `live · checked ${lastPoll ? ago(Date.now() / 1000 - lastPoll) : 'just now'}`
    : 'paused';
}

function setLive(on) {
  live = on;
  $('live').classList.toggle('on', on);
  $('live').textContent = on ? '⏸ pause' : '▶ resume';
  clearInterval(timer);
  timer = on ? setInterval(poll, 60000) : null;
  tick();
}

/* ---------------------------------------------------------------------------
   Boot.
--------------------------------------------------------------------------- */

function chips() {
  $('chips').innerHTML = Object.entries(STREAMS).map((e) =>
    `<button class="chip on" data-s="${e[0]}" title="${esc(e[1].what)}" style="--c:${e[1].color}">`
    + `<i></i>${e[1].name}</button>`).join('');
  $('chips').addEventListener('click', (ev) => {
    const b = ev.target.closest('.chip');
    if (!b) return;
    const k = b.dataset.s;
    if (off.has(k)) off.delete(k); else off.add(k);
    b.classList.toggle('on', !off.has(k));
    render();
  });
}

const MORE_DAYS = 7;

function moreLabel() {
  const next = allDays.slice(loaded.length, loaded.length + MORE_DAYS);
  $('more').textContent = next.length
    ? `Load ${next.length} more day${next.length === 1 ? '' : 's'} → ${next[next.length - 1]}`
    : 'That is the whole archive';
  $('more').disabled = !next.length;
}

async function more() {
  const batch = allDays.slice(loaded.length, loaded.length + MORE_DAYS);
  if (!batch.length) return;
  $('more').disabled = true;
  $('more').textContent = `loading ${batch[batch.length - 1]} … ${batch[0]}`;
  await Promise.all(batch.map(loadDay));
  loaded.push(...batch);
  render();
  moreLabel();
}

async function boot() {
  IDX = await WXA.index();
  if (!IDX) {
    $('feed').innerHTML = `<p class="empty">The archive index is unreachable, so there is`
      + ` nothing to show. This page reads <code>data/wx/</code> only — it has no live`
      + ` weather source to fall back on.</p>`;
    return;
  }
  allDays = catalogDays(IDX);

  /* Days before latest.json: both hold the same newest AFD and METARs, and
     the first one added wins the dedupe — so let the archived record win and
     cite its own file rather than the current-state document. latest.json
     still contributes anything newer than the last committed day file. */
  for (const d of allDays.slice(0, 2)) { await loadDay(d); loaded.push(d); }
  mergeLatest(await WXA.latest());
  await loadTracker();
  render();

  moreLabel();
  $('more').style.display = '';
  $('more').addEventListener('click', more);

  $('feed').addEventListener('click', onClick);
  $('rail').addEventListener('click', railClick);
  $('feed').addEventListener('keydown', onKey);
  $('q').addEventListener('input', (e) => { query = e.target.value; render(); });
  $('live').addEventListener('click', () => setLive(!live));
  chips();
  setLive(true);
  setInterval(tick, 15000);
}

boot();
