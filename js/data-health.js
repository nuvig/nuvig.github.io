// Data health — the two monitor panels on changelog.html.
//
// The changelog hides the hourly data commits (wx-archive, backfills), so this
// is where their health lives instead: is the pipeline that makes those
// commits actually running, and what does its recent history look like?
//
//  · Weather archive — data/wx/ (same-origin, via WXA): last archiver run,
//    per-stream freshness judged against each stream's own cadence, a
//    day-coverage strip per stream, and — over the WHOLE archive, not just
//    the drawn window — how far back each stream reaches and which days are
//    missing from it. Alerts are event-driven: a day without a file means
//    "no alerts", never a gap, so that stream is judged on neither count.
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

  const nextDay = d => new Date(Date.parse(d + 'T12:00:00Z') + 86400e3)
    .toISOString().slice(0, 10);          // noon-UTC step — DST can't reach it

  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const shortDate = d => `${MON[+d.slice(5, 7) - 1]} ${+d.slice(8, 10)}`;

  // Whole-archive coverage for one stream: how far back it reaches, how many
  // days it holds, and which days are missing in between. Today is never a
  // gap — a day-forward stream fills it as the day goes on, and the freshness
  // row is what flags an archiver that has actually stopped. Event-driven
  // streams have no gaps by definition: an absent day is a quiet day.
  function coverage(days, eventDriven) {
    if (!days || !days.length) return null;
    const have = new Set(days);
    const first = days[0];
    const stop = localDay(Date.now() - 86400e3);
    const missing = [];
    if (!eventDriven) {
      for (let d = first; d <= stop; d = nextDay(d)) if (!have.has(d)) missing.push(d);
    }
    return { first, have, held: have.size, missing };
  }

  // Consecutive missing days collapse into ranges — the shape
  // scripts/wxbackfill.py takes (--since/--until), so a gap reads as the
  // command that fills it.
  function ranges(days) {
    const out = [];
    for (const d of days) {
      const last = out[out.length - 1];
      if (last && nextDay(last[1]) === d) last[1] = d;
      else out.push([d, d]);
    }
    return out;
  }

  function fmtRanges(days, max = 3) {
    const rs = ranges(days).map(([a, b]) => {
      if (a === b) return shortDate(a);
      // same month → "Jun 11–13"; across one → "Jul 30–Aug 2"
      const end = a.slice(0, 7) === b.slice(0, 7) ? +b.slice(8, 10) : shortDate(b);
      return `${shortDate(a)}–${end}`;
    });
    return rs.length > max
      ? `${rs.slice(0, max).join(', ')} +${rs.length - max} more`
      : rs.join(', ');
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

  function row(label, note, age, v, strip, tip, gapHtml) {
    const word = v.word ? ` <span class="dh-word ${v.cls}">${v.word}</span>` : '';
    return `<div class="dh-row">
      <span class="dh-dot ${v.cls}"></span>
      <span class="dh-name">${esc(label)}${note ? ` <span class="dh-note">${esc(note)}</span>` : ''}</span>
      <span class="dh-age"${tip ? ` title="${esc(tip)}"` : ''}>${esc(age)}${word}${gapHtml || ''}</span>
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
      return fail(el, 'Couldn’t read data/wx.');
    }
    const t = now();
    const days = daySpan();

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

    // The local ring is one row, not a dozen: the health question is "is the
    // ring reporting", and the oldest station is the number that answers it
    // (a single field that went quiet shows). Days are the union — a station
    // added later shouldn't blank the whole strip — and the tip carries each
    // station's own count so an outlier is still findable.
    const ringIds = idx.stations || [];
    const ringLatest = latest.stations || {};
    const ringAges = ringIds.map(id => ({ id, age: age((ringLatest[id] || [])[0]) }));
    const ringWorst = ringAges.reduce((m, s) => (s.age == null ? Infinity : Math.max(m, s.age)), 0);
    const ringTip = ringAges.map(s => `${s.id} ${fmtAge(s.age)}`).join(' · ');
    const ringDays = [...new Set(Object.values(idx.station_days || {}).flat())].sort();

    // AFD day list comes from the issuance index (its entries are per
    // issuance, not per day), oldest first to match every other stream.
    const afdDays = [...new Set((idx.afd || []).map(a => localDay(a.t * 1000)))].sort();

    // `fill` marks the factual streams scripts/wxbackfill.py can recover
    // (IEM's METAR/AFD/TAF archives, Open-Meteo's historical forecast for the
    // model digest). forecast/grid are deliberately NOT backfillable — no
    // public archive preserves what was predicted at the time — so a hole
    // there is permanent, which is exactly what makes it worth naming.
    const streams = [
      // NWS's observation API often lags the station by an hour or two on top
      // of the hourly archive cadence — 3 h is a normal-healthy obs age.
      { label: 'KDCA METARs', short: 'KDCA obs', note: 'verifies the forecast',
        age: age(maxTs(latest.obs)), okH: 3, lateH: 6, days: idx.obs_days, fill: true },
      { label: 'KNAK METARs', short: 'KNAK obs', note: 'the field sensor · hourly',
        age: age(maxTs(latest.fieldobs)), okH: 4, lateH: 9, days: idx.fieldobs_days, fill: true },
      // …only once the ring has actually archived something: an empty row
      // before the first run would read as a broken stream.
      ...(ringIds.length ? [{ label: 'Local ring METARs', short: 'ring obs',
        note: `${ringIds.length} field${ringIds.length === 1 ? '' : 's'} · hourly`,
        age: ringWorst === Infinity ? null : ringWorst, okH: 4, lateH: 9,
        days: ringDays, fill: true, tip: ringTip }] : []),
      { label: 'LWX discussion', short: 'discussions', note: '~4 issuances/day',
        age: age((idx.afd || [{}])[0].t), okH: 9, lateH: 15, days: afdDays, fill: true },
      { label: 'DC forecast', short: 'forecast', note: 'snapshot each run',
        age: age(latest.forecast && latest.forecast.t), okH: 2.5, lateH: 6,
        days: idx.forecast_days, fill: false },
      { label: 'NWS hourly grid', short: 'grid', note: 'at the field',
        age: age(latest.grid && latest.grid.t), okH: 2.5, lateH: 6,
        days: idx.grid_days, fill: false },
      { label: 'TAFs', short: 'TAFs', note: 'KMTN · KBWI · KDCA',
        age: tafWorst === Infinity ? null : tafWorst, okH: 9, lateH: 15,
        days: idx.taf_days, fill: true, tip: tafTip },
      { label: 'GFS model', short: 'model', note: 'CAPE · CIN · precip',
        age: age(latest.model && latest.model.t), okH: 2.5, lateH: 6,
        days: idx.model_days, fill: true },
      { label: 'Alerts', short: 'alerts', note: 'event-driven',
        text: active ? `${active} active now` : 'none active',
        days: idx.alert_days, event: true, fill: false },
    ];

    let rows = '';
    for (const s of streams) {
      s.cov = coverage(s.days, s.event);
      // Alerts get a neutral dot either way — an active alert is weather, not
      // a pipeline problem; the count is the information.
      const v = s.event ? { cls: 'quiet', word: '' } : verdict(s.age, s.okH, s.lateH);
      const gaps = s.cov ? s.cov.missing.length : 0;
      const gapHtml = gaps
        ? ` <span class="dh-gap" title="${esc(fmtRanges(s.cov.missing, 12))}">${gaps} missing</span>`
        : '';
      rows += row(s.label, s.note, s.text || fmtAge(s.age), v,
        strip(days, new Set(s.days || []), s.cov && s.cov.first, s.event), s.tip, gapHtml);
    }

    // Reach — how far back the archive goes, streams grouped by the day they
    // start (they came online in waves, so this is 3-4 groups, not 8 lines).
    const byFirst = new Map();
    for (const s of streams) {
      if (!s.cov) continue;
      if (!byFirst.has(s.cov.first)) byFirst.set(s.cov.first, []);
      byFirst.get(s.cov.first).push(s.short);
    }
    const starts = [...byFirst.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const oldest = starts.length ? starts[0][0] : null;
    const reach = starts.map(([d, names]) =>
      `<b>${esc(shortDate(d))}</b> ${esc(names.join(', '))}`).join(' · ');
    const depth = oldest
      ? Math.round((Date.now() - Date.parse(oldest + 'T12:00:00Z')) / 86400e3) : 0;

    // Integrity — the whole archive, not just the drawn window. Never silent:
    // a clean archive says so, because "no news" and "nothing checked" have
    // to look different.
    const holed = streams.filter(s => s.cov && s.cov.missing.length);
    const lost = holed.reduce((n, s) => n + s.cov.missing.length, 0);
    let integrity;
    if (!streams.some(s => s.cov)) {
      integrity = '<span class="dh-word warn">unknown</span> — no day index to check';
    } else if (!holed.length) {
      integrity = `<span class="dh-word ok">complete</span>` +
        (oldest ? ` — no gaps since ${esc(shortDate(oldest))}` : '');
    } else {
      const parts = holed.map(s => `${esc(s.short)} ${esc(fmtRanges(s.cov.missing))}` +
        (s.fill ? '' : ' <i>(unrecoverable)</i>'));
      integrity = `<span class="dh-word warn">${lost} missing day${lost === 1 ? '' : 's'}</span> — ` +
        parts.join(' · ');
    }

    el.innerHTML = `
      <div class="dh-head">${pill(runV.cls, head)}
        <span class="dh-headline">archiver ran ${esc(fmtAge(runAge))}</span>
        <span class="dh-sub">hourly GitHub Action</span></div>
      ${rows}
      <div class="dh-axis"><span>${esc(days[0])}</span>
        <span class="dh-key"><i class="on"></i>day held <i class="off"></i>missing
          <i class="pre"></i>before start / quiet</span>
        <span>today</span></div>
      <dl class="dh-cover">
        <dt>Reach</dt><dd>${depth} days — ${reach || '—'}</dd>
        <dt>Integrity</dt><dd>${integrity}</dd>
      </dl>
      <div class="dh-foot"><a href="almanac.html">Browse the archive →</a></div>`;
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
      return fail(el, 'Couldn’t reach the traffic-data snapshots.');
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
      <div class="dh-axis"><span>${esc(days[0])}</span>
        <span class="dh-key"><i class="off"></i>missing day</span>
        <span>today</span></div>
      <div class="dh-foot">Aircraft per day within ${SITE.tracker.radiusNm} nm ·
        <a href="kanp.html">Open the tracker →</a></div>`;
  }

  weatherPanel().catch(e => fail($('dh-wx'), 'Weather archive check failed: ' + e.message));
  trackerPanel().catch(e => fail($('dh-trk'), 'Tracker check failed: ' + e.message));
})();
