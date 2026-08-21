// Data health — the two monitor panels on changelog.html.
//
// The changelog hides the hourly data commits (wx-archive, backfills), so this
// is where their health lives instead: is the pipeline that makes those
// commits actually running, and what does its recent history look like?
//
//  · Weather archive — data/wx/ (same-origin, via WXA): last archiver run,
//    per-stream freshness judged against each stream's own cadence, and a
//    day-coverage strip per stream. Alerts are event-driven — a day without
//    a file means "no alerts", never a gap — so that row is not judged.
//  · Flight tracker — the traffic-data branch snapshots (same source as
//    kanp-static.js): exporter push age vs collector "last aircraft heard"
//    (the two fail independently — a fresh push with an old newest_position
//    means the feeds/collector, not the exporter), plus aircraft/day bars.
//
// Needs js/site-config.js and js/wx-archive.js first. Everything degrades to
// an in-card message rather than throwing; a page view never depends on this.

(() => {
  'use strict';

  const TZ = SITE.weather.timeZone;
  const SPAN = 42;                      // days of history drawn per panel
  const HOUR = 3600;

  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const now = () => Date.now() / 1000;

  // 'YYYY-MM-DD' in the airport's timezone — both archives shard by field-local day.
  const localDay = ms => new Date(ms).toLocaleDateString('en-CA', { timeZone: TZ });

  // Last SPAN field-local days, oldest first, ending today.
  function daySpan() {
    const out = [];
    for (let i = SPAN - 1; i >= 0; i--) out.push(localDay(Date.now() - i * 86400e3));
    return out;
  }

  function fmtAge(sec) {
    if (sec == null || !isFinite(sec)) return '—';
    if (sec < 0) sec = 0;
    if (sec < 90 * 60) return `${Math.round(sec / 60)} min ago`;
    if (sec < 48 * HOUR) return `${(sec / HOUR).toFixed(sec < 10 * HOUR ? 1 : 0)} h ago`;
    return `${Math.round(sec / 86400)} d ago`;
  }

  // Freshness verdict against a stream's own cadence. Color is never alone:
  // the age text carries the number, and non-ok rows say the word too.
  function verdict(ageSec, okH, lateH) {
    if (ageSec == null) return { cls: 'bad', word: 'no data' };
    if (ageSec <= okH * HOUR) return { cls: 'ok', word: '' };
    if (ageSec <= lateH * HOUR) return { cls: 'warn', word: 'late' };
    return { cls: 'bad', word: 'stale' };
  }

  function pill(cls, text) {
    return `<span class="dh-pill ${cls}">${esc(text)}</span>`;
  }

  function row(label, note, age, v, strip, tip) {
    const word = v.word ? ` <span class="dh-word ${v.cls}">${v.word}</span>` : '';
    return `<div class="dh-row">
      <span class="dh-dot ${v.cls}"></span>
      <span class="dh-name">${esc(label)}${note ? ` <span class="dh-note">${esc(note)}</span>` : ''}</span>
      <span class="dh-age"${tip ? ` title="${esc(tip)}"` : ''}>${esc(age)}${word}</span>
      ${strip}
    </div>`;
  }

  // Day-coverage strip: one cell per day of the span. 'pre' (before the
  // stream existed) is neutral, 'off' after its first day is a real gap.
  // For event-driven streams absent days are normal → 'quiet', never 'off'.
  function strip(days, haveSet, firstDay, eventDriven) {
    const cells = days.map(d => {
      let cls, what;
      if (haveSet.has(d)) { cls = 'on'; what = eventDriven ? 'events archived' : 'archived'; }
      else if (eventDriven) { cls = 'quiet'; what = 'no events'; }
      else if (!firstDay || d < firstDay) { cls = 'pre'; what = 'before this stream started'; }
      else { cls = 'off'; what = 'missing'; }
      return `<i class="${cls}" title="${d} · ${what}"></i>`;
    }).join('');
    return `<span class="dh-strip">${cells}</span>`;
  }

  function fail(el, msg) {
    el.innerHTML = `<div class="dh-fail">${esc(msg)}</div>`;
  }

  // ------------------------------------------------------------------ weather
  async function weatherPanel() {
    const el = $('dh-wx');
    const [idx, latest] = await Promise.all([WXA.index(), WXA.latest()]);
    if (!idx || !latest) {
      return fail(el, 'Couldn’t read data/wx/ — the archive hasn’t deployed here, or the fetch failed.');
    }
    const t = now();
    const days = daySpan();
    const daySets = {};
    for (const s of ['forecast', 'obs', 'fieldobs', 'grid', 'taf', 'alert', 'model']) {
      daySets[s] = new Set(idx[`${s}_days`] || []);
    }
    // AFD day coverage from the issuance list (its index entry is per-issuance)
    const afdDays = new Set((idx.afd || []).map(a => localDay(a.t * 1000)));
    const first = s => (idx[`${s}_days`] || [])[0] || null;

    const maxTs = list => {
      let m = null;
      for (const e of list || []) { const ts = Array.isArray(e) ? e[0] : null; if (ts && (!m || ts > m)) m = ts; }
      return m;
    };
    const age = ts => (ts ? t - ts : null);

    const runAge = age(idx.updated || latest.t);
    const runV = verdict(runAge, 2.5, 6);
    const head = runV.cls === 'ok' ? 'archive ok' : runV.cls === 'warn' ? 'archive late' : 'archive down';

    // TAFs: all three stations issue ~4×/day — the oldest is the health number
    // (one dead station should show), the tooltip carries each.
    const tafs = latest.tafs || {};
    const tafAges = (SITE.weather.tafStations || []).map(s => ({
      id: s.id, age: age(tafs[s.id] && tafs[s.id].t) }));
    const tafWorst = tafAges.reduce((m, s) => (s.age == null ? Infinity : Math.max(m, s.age)), 0);
    const tafTip = tafAges.map(s => `${s.id} ${fmtAge(s.age)}`).join(' · ');

    // Alerts: judged by count, not staleness (absence is healthy)
    const active = (latest.alerts || []).filter(a => {
      const end = a.ends ? Date.parse(a.ends) / 1000 : null;
      return end == null || end > t;
    }).length;

    const streams = [
      // NWS's observation API often lags the station by an hour or two on top
      // of the hourly archive cadence — 3 h is a normal-healthy obs age.
      ['KDCA METARs', 'verifies the forecast', age(maxTs(latest.obs)), 3, 6, 'obs', false],
      ['KNAK METARs', 'the field sensor · hourly', age(maxTs(latest.fieldobs)), 4, 9, 'fieldobs', false],
      ['LWX discussion', '~4 issuances/day', age((idx.afd || [{}])[0].t), 9, 15, null, false],
      ['DC forecast', 'snapshot each run', age(latest.forecast && latest.forecast.t), 2.5, 6, 'forecast', false],
      ['NWS hourly grid', 'at the field', age(latest.grid && latest.grid.t), 2.5, 6, 'grid', false],
      ['TAFs', 'KMTN · KBWI · KDCA', tafWorst === Infinity ? null : tafWorst, 9, 15, 'taf', false, tafTip],
      ['GFS model', 'CAPE · CIN · precip', age(latest.model && latest.model.t), 2.5, 6, 'model', false],
    ];

    const afdFirst = idx.afd && idx.afd.length
      ? localDay(idx.afd[idx.afd.length - 1].t * 1000) : null;

    let rows = '';
    for (const [label, note, a, okH, lateH, key, ev, tip] of streams) {
      const v = verdict(a, okH, lateH);
      const set = key ? daySets[key] : afdDays;
      const f = key ? first(key) : afdFirst;
      rows += row(label, note, fmtAge(a), v, strip(days, set, f, ev), tip);
    }
    // Alerts row: neutral dot either way — active alerts are weather, not a
    // pipeline problem; the count is the information.
    rows += row('Alerts', 'event-driven', active ? `${active} active now` : 'none active',
      { cls: 'quiet', word: '' },
      strip(days, daySets.alert, first('alert'), true));

    el.innerHTML = `
      <div class="dh-head">${pill(runV.cls, head)}
        <span class="dh-headline">archiver ran ${esc(fmtAge(runAge))}</span>
        <span class="dh-sub">hourly GitHub Action</span></div>
      ${rows}
      <div class="dh-axis"><span>${esc(days[0])}</span><span>today</span></div>
      <div class="dh-foot">Streams judged against their own cadence — METARs and model
        snapshots land hourly, discussions and TAFs a few times a day.
        <a href="almanac.html">Browse the archive →</a></div>`;
  }

  // ------------------------------------------------------------------ tracker
  async function trackerPanel() {
    const el = $('dh-trk');
    let sum = null;
    try {
      const r = await fetch(`${SITE.tracker.snapshotBase}/summary.json`, { cache: 'no-cache' });
      if (r.ok) sum = await r.json();
    } catch { /* handled below */ }
    if (!sum || !Array.isArray(sum.days)) {
      return fail(el, 'Couldn’t reach the traffic-data snapshots on GitHub — try again in a minute.');
    }
    const t = now();
    const pushAge = sum.generated ? t - sum.generated : null;
    const heardAge = sum.newest_position ? t - sum.newest_position : null;
    const pushV = verdict(pushAge, 2, 6);
    const heardV = verdict(heardAge, 1.5, 4);
    const worst = pushV.cls === 'bad' || heardV.cls === 'bad' ? 'bad'
      : pushV.cls === 'warn' || heardV.cls === 'warn' ? 'warn' : 'ok';
    const head = worst === 'ok' ? 'snapshots ok' : worst === 'warn' ? 'snapshots late' : 'snapshots down';

    const byDate = new Map(sum.days.map(d => [d.date, d]));
    const days = daySpan();
    const today = days[days.length - 1];
    const inSpan = days.filter(d => byDate.has(d));
    const peak = Math.max(1, ...inSpan.map(d => byDate.get(d).aircraft || 0));
    const firstDay = sum.days.length ? sum.days[0].date : null;

    const bars = days.map(d => {
      const e = byDate.get(d);
      if (!e) {
        const pre = !firstDay || d < firstDay;
        return `<i class="${pre ? 'pre' : 'off'}" title="${d} · ${pre ? 'before the archive started' : 'missing — no snapshot published'}"></i>`;
      }
      const h = Math.max(2, Math.round((e.aircraft / peak) * 100));
      const partial = d === today ? ' part' : '';
      return `<i class="on${partial}" style="height:${h}%" title="${d} · ${e.aircraft.toLocaleString()} aircraft · ${e.points.toLocaleString()} points${partial ? ' (so far today)' : ''}"></i>`;
    }).join('');

    el.innerHTML = `
      <div class="dh-head">${pill(worst, head)}
        <span class="dh-headline">exporter pushed ${esc(fmtAge(pushAge))}</span>
        <span class="dh-sub">Pi → traffic-data branch</span></div>
      ${row('Snapshot push', 'exporter, at least hourly', fmtAge(pushAge), pushV, '')}
      ${row('Last aircraft heard', 'collector, via public feeds', fmtAge(heardAge), heardV, '')}
      ${row('Archive', '', `${sum.days.length} days since ${firstDay || '—'}`, { cls: 'quiet', word: '' }, '')}
      <div class="dh-bars" aria-label="aircraft per day, last ${SPAN} days">
        <span class="dh-peak">peak ${peak.toLocaleString()}</span>${bars}</div>
      <div class="dh-axis"><span>${esc(days[0])}</span><span>today</span></div>
      <div class="dh-foot">Aircraft seen per day within ${SITE.tracker.radiusNm} nm.
        A fresh push with an old “last heard” means the feeds, not the exporter.
        <a href="kanp.html">Open the tracker →</a></div>`;
  }

  weatherPanel().catch(e => fail($('dh-wx'), 'Weather archive check failed: ' + e.message));
  trackerPanel().catch(e => fail($('dh-trk'), 'Tracker check failed: ' + e.message));
})();
