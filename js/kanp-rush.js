// KANP Flight Tracker — Airline Traffic tab
// When the airliners come and go at BWI / DCA / IAD / ADW / MTN, read from
// rush.json on the rush-data branch (scripts/build_rush.py compiles it hourly
// from the Pi's day snapshots). Everything here is a mean per covered day over
// the days the chips select; an hour the collector missed is left out of the
// mean, never counted as quiet. Times are the field's zone.

const KANPRush = (() => {
  const A62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const dec = s => Array.from(s || '', c => A62.indexOf(c));
  const BLUE = '#3987e5', ORANGE = '#d95926';
  // categorical, dark-surface steps (validated set — js/aircraft.js uses the same)
  const CAT = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300'];
  // ordinal ramp for the altitude bands, lowest band brightest
  const BAND_COLORS = ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#1c5cab'];
  const RANGES = [['7 d', 7], ['30 d', 30], ['90 d', 90], ['All', 0]];
  const CLASSES = [['Weekdays', 'wk'], ['Sat', 'sat'], ['Sun', 'sun'], ['All', 'all']];
  const REGION_LABEL = {
    bwi25: 'BWI 25 nm', dca25: 'DCA 25 nm', iad25: 'IAD 25 nm', lee15: 'Lee 15 nm',
  };
  const DOW = 'MTWTFSS';

  let R = null;
  let loaded = false, loading = false;
  const S = { ap: 'BWI', al: '', cls: 'wk', range: 30, region: 'bwi25', band: -1,
              feed: '', kind: '', recAll: false, recSort: 'time', day: null };
  const dayCache = new Map();
  let tip = null;

  const $ = id => document.getElementById(id);
  const base = () => localStorage.getItem('kanp_rush_base') || SITE.tracker.rushBase;
  const hourLabel = h => h === 0 ? '12a' : h < 12 ? `${h}a` : h === 12 ? '12p' : `${h - 12}p`;
  const slotLabel = s => {
    const h = Math.floor(s / 4), m = (s % 4) * 15;
    const hh = h % 12 === 0 ? 12 : h % 12;
    return `${hh}:${String(m).padStart(2, '0')}${h < 12 ? 'a' : 'p'}`;
  };
  const minLabel = m => slotLabel(Math.floor(m / 15)).replace(/:\d\d/, ':' + String(m % 60).padStart(2, '0'));
  const fmt1 = v => v >= 10 ? Math.round(v).toLocaleString() : (Math.round(v * 10) / 10).toString();
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ------------------------------------------------------------------ boot
  function init() {
    const btn = document.querySelector('.tab-btn[data-tab="tab-rush"]');
    if (btn) btn.addEventListener('click', () => { if (!loaded) load(); });
    if ($('tab-rush').classList.contains('active')) load();
    chips('rush-cls', CLASSES.map(([l, v]) => [l, v]), 'cls');
    chips('rush-range', RANGES.map(([l, v]) => [l, v]), 'range');
    chips('rush-region', Object.entries(REGION_LABEL).map(([v, l]) => [l, v]), 'region');
    chips('rush-kind', [['Both', ''], ['Arrivals', 'A'], ['Departures', 'D']], 'kind');
    $('rush-rec-more').addEventListener('click', () => { S.recAll = true; renderRecurring(); });
    $('rush-rec').querySelectorAll('th[data-k]').forEach(th =>
      th.addEventListener('click', () => { S.recSort = th.dataset.k; renderRecurring(); }));
    $('rush-day-load').addEventListener('click', () => loadDay($('rush-day').value));
    $('rush-day-prev').addEventListener('click', () => stepDay(-1));
    $('rush-day-next').addEventListener('click', () => stepDay(1));
    $('rush-day').addEventListener('change', () => loadDay($('rush-day').value));
    window.addEventListener('resize', () => { if (loaded) render(); });
  }

  function onShow() { if (loaded) render(); else load(); }

  async function load() {
    if (loading) return;
    loading = true;
    const out = $('rush-result');
    out.textContent = 'Loading…';
    try {
      const res = await fetch(`${base()}/rush.json`, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`rush.json ${res.status}`);
      R = await res.json();
      loaded = true;
      chips('rush-ap', R.order.map(ap => [ap, ap, R.airports[ap].name]), 'ap');
      buildAirlineChips();
      if (R.feeds && Object.keys(R.feeds).length) {
        S.feed = Object.keys(R.feeds)[0];
        chips('rush-feed', Object.entries(R.feeds).map(([m, f]) => [f.freq || m, m, f.label]), 'feed');
      }
      const newest = R.days.length ? R.days[R.days.length - 1].d : '';
      $('rush-day').value = newest;
      $('rush-day').max = newest;
      $('rush-day').min = R.days.length ? R.days[0].d : '';
      render();
    } catch (e) {
      out.innerHTML = `<span class="err">No compiled data (${esc(e.message)})</span>`;
    } finally {
      loading = false;
    }
  }

  // chip rows: [label, value, title?][]; one selected; S[key] = value
  function chips(id, items, key) {
    const row = $(id);
    row.innerHTML = '';
    items.forEach(([label, value, title]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'qr-chip' + (S[key] === value ? ' on' : '');
      b.textContent = label;
      if (title) b.title = title;
      b.addEventListener('click', () => {
        S[key] = value;
        row.querySelectorAll('.qr-chip').forEach(c => c.classList.toggle('on', c === b));
        if (key === 'ap') { S.al = ''; buildAirlineChips(); }
        if (key === 'region' || key === 'feed') renderTerm();
        else if (key === 'kind') renderRecurring();
        else if (key === 'band') drawMap();
        else render();
        if (key === 'ap' || key === 'al') loadDay($('rush-day').value, true);
      });
      row.appendChild(b);
    });
  }

  function buildAirlineChips() {
    const top = (R.top && R.top[S.ap]) || [];
    const items = [['All', '']].concat(top.map(p => [p, p, R.airlines[p] || p]));
    chips('rush-al', items, 'al');
    $('rush-al-field').style.display = top.length ? '' : 'none';
  }

  // ------------------------------------------------------------ selection
  function selDays() {
    if (!R) return [];
    const newest = R.days[R.days.length - 1].d;
    let from = '';
    if (S.range) {
      const d = new Date(newest + 'T12:00:00');
      d.setDate(d.getDate() - S.range + 1);
      from = d.toISOString().slice(0, 10);
    }
    return R.days.filter(d => d.d >= from && (S.cls === 'all' || d.cls === S.cls));
  }

  // mean per covered day of a 96-slot series across days; pick(day) → string
  function series(days, pick) {
    const sum = new Array(96).fill(0), n = new Array(96).fill(0);
    for (const d of days) {
      const s = pick(d);
      if (!s) continue;
      const v = dec(s);
      for (let i = 0; i < 96; i++) {
        if (d.cov[Math.floor(i / 4)] !== '1') continue;
        sum[i] += v[i]; n[i]++;
      }
    }
    return sum.map((v, i) => n[i] ? v / n[i] : 0);
  }

  const apSeries = (days, ap, al, kind) => series(days, d => {
    const a = d.ap[ap];
    if (!a) return null;
    if (al) return a.al[al] ? a.al[al][kind === 'A' ? 0 : 1] : null;
    return kind === 'A' ? a.a : a.d;
  });

  function coveredDays(days) {
    let missing = 0;
    days.forEach(d => { missing += [...d.cov].filter(c => c === '0').length; });
    return { n: days.length, missing };
  }

  // ---------------------------------------------------------------- render
  function render() {
    if (!R) return;
    const days = selDays();
    const cov = coveredDays(days);
    const gen = new Date(R.generated * 1000);
    const clsName = { wk: 'weekdays', sat: 'Saturdays', sun: 'Sundays', all: 'all days' }[S.cls];
    const span = days.length ? `${days[0].d.slice(5)} – ${days[days.length - 1].d.slice(5)}` : '';
    $('rush-result').textContent = days.length
      ? `${S.ap} · ${S.al ? (R.airlines[S.al] || S.al) + ' · ' : ''}${cov.n} ${clsName} · ${span}` +
        (cov.missing ? ` · ${cov.missing} h missing` : '') +
        ` · compiled ${gen.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
      : 'No days in this range';
    const note = $('rush-cs-note');
    if (R.cs_hist_from) note.textContent = `flight numbers exact from ${R.cs_hist_from}; before that a turnaround's arrival carries its departing number`;
    else note.textContent = 'flight numbers: a turnaround’s arrival carries its departing number until the Pi exporter update';
    if (!days.length) { $('rush-body').style.display = 'none'; return; }
    $('rush-body').style.display = '';

    const arr = apSeries(days, S.ap, S.al, 'A');
    const dep = apSeries(days, S.ap, S.al, 'D');
    renderTiles(days, arr, dep);
    drawSlots($('rush-mirror'), { up: [arr], down: [dep], colors: [BLUE], downColors: [ORANGE],
      height: 230, hover: i => `<strong>${slotLabel(i)}</strong><br>${fmt1(arr[i])} arrivals · ${fmt1(dep[i])} departures<br>per day` });
    renderBanks(days, arr, dep);
    renderGrid(days);
    renderAirlines(days);
    renderRunways(days);
    renderRecurring();
    renderLee(days);
    renderTerm();
    if (!S.day) loadDay($('rush-day').value, true);
  }

  function renderTiles(days, arr, dep) {
    const sum = a => a.reduce((x, y) => x + y, 0);
    $('rt-arr').textContent = fmt1(sum(arr));
    $('rt-dep').textContent = fmt1(sum(dep));
    let peak = 0;
    arr.forEach((v, i) => { if (v > arr[peak]) peak = i; });
    $('rt-peak').textContent = arr[peak] ? slotLabel(peak) : '–';
    $('rt-peak-lbl').textContent = arr[peak] ? `busiest 15 min · ${fmt1(arr[peak])} arrivals` : 'busiest 15 min';
    const banks = detectBanks(arr);
    $('rt-bank').textContent = banks.length ? `${slotLabel(banks[0].s)}–${slotLabel(banks[0].e + 1)}` : '–';
    $('rt-bank-lbl').textContent = banks.length ? `first arrival bank · ${fmt1(banks[0].total)}` : 'first arrival bank';
    // share: the selected airline's, else the top airline's
    const total = sum(apSeries(days, S.ap, '', 'A')) + sum(apSeries(days, S.ap, '', 'D'));
    const top = (R.top[S.ap] || []);
    const pfx = S.al || top[0];
    if (pfx && total) {
      const mine = sum(apSeries(days, S.ap, pfx, 'A')) + sum(apSeries(days, S.ap, pfx, 'D'));
      $('rt-share').textContent = `${Math.round(100 * mine / total)}%`;
      $('rt-share-lbl').textContent = `${pfx} share of ${S.ap}`;
    } else {
      $('rt-share').textContent = '–';
      $('rt-share-lbl').textContent = 'airline share';
    }
    $('rt-days').textContent = days.length;
  }

  // a bank: a run of 15-min slots clearly above the day's typical slot
  // (1.25× the median of the day's active slots on a lightly smoothed
  // series; a lone slot counts only at 1.6×)
  function detectBanks(mean) {
    const day = mean.slice(20, 96).filter(v => v > 0).sort((a, b) => a - b);
    if (!day.length) return [];
    const med = day[Math.floor(day.length / 2)];
    const thr = Math.max(0.5, med * 1.25);
    const sm = mean.map((v, i) => (mean[i - 1] || 0) * 0.25 + v * 0.5 + (mean[i + 1] || 0) * 0.25);
    const banks = [];
    let i = 0;
    while (i < 96) {
      if (sm[i] < thr) { i++; continue; }
      let j = i;
      while (j + 1 < 96 && (sm[j + 1] >= thr || (j + 2 < 96 && sm[j + 2] >= thr))) j++;
      if (j > i || mean[i] >= med * 1.6) {
        let total = 0, peak = i;
        for (let k = i; k <= j; k++) { total += mean[k]; if (mean[k] > mean[peak]) peak = k; }
        banks.push({ s: i, e: j, total, peak });
      }
      i = j + 1;
    }
    return banks;
  }

  function renderBanks(days, arr, dep) {
    const rows = [];
    const top = R.top[S.ap] || [];
    for (const [kind, mean] of [['A', arr], ['D', dep]]) {
      for (const b of detectBanks(mean)) {
        let mix = '';
        if (!S.al && top.length) {
          const shares = top.map(p => {
            const s = apSeries(days, S.ap, p, kind);
            let t = 0;
            for (let k = b.s; k <= b.e; k++) t += s[k];
            return [p, t];
          }).filter(x => x[1] > 0).sort((x, y) => y[1] - x[1]).slice(0, 3);
          mix = shares.map(([p, t]) => `${p} ${Math.round(100 * t / b.total)}%`).join(' · ');
        }
        rows.push({ kind, ...b, mix });
      }
    }
    rows.sort((a, b) => b.total - a.total);
    rows.splice(8);
    rows.sort((a, b) => a.s - b.s);
    const tb = $('rush-banks').querySelector('tbody');
    tb.innerHTML = rows.length ? rows.map(r =>
      `<tr><td>${slotLabel(r.s)}–${slotLabel(r.e + 1)}</td>` +
      `<td><span class="rush-sw" style="background:${r.kind === 'A' ? BLUE : ORANGE}"></span>${r.kind === 'A' ? 'arrivals' : 'departures'}</td>` +
      `<td>${fmt1(r.total)}</td><td>${slotLabel(r.peak)} · ${fmt1(r.kind === 'A' ? arr[r.peak] : dep[r.peak])}</td><td>${r.mix}</td></tr>`
    ).join('') : '<tr><td colspan="5" style="color:#555">no bank stands out</td></tr>';
  }

  function renderGrid(days) {
    // movements by hour × weekday, mean per covered day — the range applies, the day-class chips don't
    const all = S.range ? R.days.filter(d => d.d >= days[0].d && true) : R.days;
    const sum = Array.from({ length: 7 }, () => new Array(24).fill(0));
    const n = Array.from({ length: 7 }, () => new Array(24).fill(0));
    for (const d of all) {
      const a = d.ap[S.ap];
      if (!a) continue;
      const dow = (new Date(d.d + 'T12:00:00').getDay() + 6) % 7;
      const va = dec(S.al ? (a.al[S.al] || [])[0] : a.a), vd = dec(S.al ? (a.al[S.al] || [])[1] : a.d);
      for (let h = 0; h < 24; h++) {
        if (d.cov[h] !== '1') continue;
        for (let k = 0; k < 4; k++) sum[dow][h] += (va[h * 4 + k] || 0) + (vd[h * 4 + k] || 0);
        n[dow][h]++;
      }
    }
    const grid = sum.map((row, d) => row.map((v, h) => n[d][h] ? Math.round(10 * v / n[d][h]) / 10 : 0));
    KANP.renderGrid($('rush-grid'), grid, { unit: 'movements / h' });
  }

  function renderAirlines(days) {
    const sum = a => a.reduce((x, y) => x + y, 0);
    const total = sum(apSeries(days, S.ap, '', 'A')) + sum(apSeries(days, S.ap, '', 'D'));
    const top = R.top[S.ap] || [];
    const rows = top.map(p => [p, sum(apSeries(days, S.ap, p, 'A')) + sum(apSeries(days, S.ap, p, 'D'))]);
    const other = total - rows.reduce((x, r) => x + r[1], 0);
    if (other > 0) rows.push(['other', other]);
    const max = Math.max(1, ...rows.map(r => r[1]));
    $('rush-airlines').innerHTML = rows.map(([p, v]) =>
      `<div class="rwy-row${p !== 'other' ? ' rush-click' : ''}" data-al="${p === 'other' ? '' : p}">` +
      `<span class="rwy-name" title="${esc(R.airlines[p] || '')}">${p}</span>` +
      `<span class="rwy-bar"><span style="width:${100 * v / max}%"></span></span>` +
      `<span class="rwy-pct">${total ? Math.round(100 * v / total) : 0}%</span>` +
      `<span class="rwy-side">${fmt1(v)} / day${R.airlines[p] ? ' · ' + esc(R.airlines[p]) : ''}</span></div>`
    ).join('') || '<div class="rwy-side">no airline-coded traffic</div>';
    $('rush-airlines').querySelectorAll('.rush-click').forEach(el => el.addEventListener('click', () => {
      S.al = el.dataset.al;
      buildAirlineChips();
      render();
    }));
  }

  function renderRunways(days) {
    // arrivals by runway direction (course on final), mean per day, by hour
    const byRwy = new Map();
    const lee = new Map();
    let ndays = 0;
    for (const d of days) {
      const a = d.ap[S.ap];
      if (!a) continue;
      ndays++;
      for (const [r, hours] of Object.entries(a.rwy || {})) {
        const cur = byRwy.get(r) || new Array(24).fill(0);
        dec(hours).forEach((v, h) => { if (d.cov[h] === '1') cur[h] += v; });
        byRwy.set(r, cur);
      }
      for (const [r, [near, tot, low]] of Object.entries(a.lee || {})) {
        const cur = lee.get(r) || [0, 0, 0];
        cur[0] += near; cur[1] += tot; cur[2] += low;
        lee.set(r, cur);
      }
    }
    const names = [...byRwy.keys()].sort((x, y) => byRwy.get(y).reduce((a, b) => a + b, 0) - byRwy.get(x).reduce((a, b) => a + b, 0));
    const total = names.reduce((t, r) => t + byRwy.get(r).reduce((a, b) => a + b, 0), 0);
    $('rush-rwys').innerHTML = names.map((r, i) => {
      const v = byRwy.get(r).reduce((a, b) => a + b, 0);
      const l = lee.get(r);
      const near = l && l[1] ? `${Math.round(100 * l[0] / l[1])}% within ${R.lee_nm} nm of Lee below 6,000 ft` +
        ` · ${Math.round(100 * l[2] / l[1])}% below 3,000 ft` : '';
      return `<div class="rwy-row"><span class="rwy-name"><span class="rush-sw" style="background:${CAT[i % CAT.length]}"></span>RWY ${r}</span>` +
        `<span class="rwy-bar"><span style="width:${100 * v / Math.max(1, total)}%"></span></span>` +
        `<span class="rwy-pct">${total ? Math.round(100 * v / total) : 0}%</span><span class="rwy-side">${near}</span></div>`;
    }).join('') || '<div class="rwy-side">no runway reads</div>';
    const stack = Array.from({ length: 24 }, (_, h) => names.map(r => ndays ? byRwy.get(r)[h] / ndays : 0));
    const labels = Array.from({ length: 24 }, (_, h) => hourLabel(h));
    KANP.drawBars($('rush-rwy-chart'), labels, stack.length ? stack : [0],
      { maxTicks: 12, height: 150, stackColors: names.map((_, i) => CAT[i % CAT.length]) });
  }

  function renderRecurring() {
    if (!R) return;
    const rows = R.recurring.filter(r => r[0] === S.ap && (!S.kind || r[1] === S.kind) &&
      (!S.al || r[2].startsWith(S.al)));
    const key = { time: r => r[4], days: r => -r[7], cs: r => r[2], spread: r => r[6] - r[5], last: r => r[10] }[S.recSort];
    rows.sort((a, b) => { const x = key(a), y = key(b); return x < y ? -1 : x > y ? 1 : a[4] - b[4]; });
    $('rush-rec').querySelectorAll('th').forEach(th => th.classList.toggle('on', th.dataset.k === S.recSort));
    const show = S.recAll ? rows : rows.slice(0, 120);
    const tb = $('rush-rec').querySelector('tbody');
    tb.innerHTML = show.map(r => {
      const [ap, kind, cs, type, med, p25, p75, seen, possible, first, last, mask] = r;
      const week = [...DOW].map((c, i) => `<span class="${mask & (1 << i) ? 'on' : ''}">${c}</span>`).join('');
      return `<tr><td>${esc(cs)}</td><td><span class="rush-sw" style="background:${kind === 'A' ? BLUE : ORANGE}"></span>${kind === 'A' ? 'arr' : 'dep'}</td>` +
        `<td>${minLabel(med)}</td><td>±${Math.round((p75 - p25) / 2)} min</td><td>${seen} / ${possible}</td>` +
        `<td>${esc(type || '')}</td><td class="rush-week">${week}</td><td>${last.slice(5)}</td></tr>`;
    }).join('') || '<tr><td colspan="8" style="color:#555">nothing seen on 4+ days</td></tr>';
    $('rush-rec-count').textContent = rows.length ? `${rows.length} flights` : '';
    $('rush-rec-more').style.display = rows.length > show.length ? '' : 'none';
  }

  // ---------------------------------------------------------------- Lee
  function renderLee(days) {
    const bands = R.bands;
    const sum = Array.from({ length: 24 }, () => new Array(bands.length).fill(0));
    const n = new Array(24).fill(0);
    for (const d of days) {
      for (let h = 0; h < 24; h++) {
        if (d.cov[h] !== '1') continue;
        n[h]++;
        dec(d.low[h]).forEach((v, b) => { sum[h][b] += v; });
      }
    }
    const stack = sum.map((row, h) => row.map(v => n[h] ? v / n[h] : 0));
    const labels = Array.from({ length: 24 }, (_, h) => hourLabel(h));
    const bandName = b => (b === 0 ? `< ${bands[0].toLocaleString()}` : `${bands[b - 1] / 1000}–${bands[b] / 1000}k`) + ' ft';
    drawSlots($('rush-lee-chart'), { up: bands.map((_, b) => stack.map(r => r[b])), colors: BAND_COLORS,
      height: 170, labels, hover: h => `<strong>${hourLabel(h)}</strong><br>` +
        stack[h].map((v, b) => `${bandName(b)}: ${fmt1(v)}`).join('<br>') + '<br>airliners per day within 5 nm' });
    $('rush-lee-legend').innerHTML = bands.map((_, b) =>
      `<span><span class="rush-sw" style="background:${BAND_COLORS[b]}"></span>${bandName(b)}</span>`).join('');
    const perDay = stack.reduce((t, r) => t + r.slice(0, 4).reduce((a, b) => a + b, 0), 0);
    let busiest = 0;
    stack.forEach((r, h) => { if (r.slice(0, 4).reduce((a, b) => a + b, 0) > stack[busiest].slice(0, 4).reduce((a, b) => a + b, 0)) busiest = h; });
    const lowest = stack.reduce((t, r) => t + r[0], 0);
    $('rush-lee-line').textContent =
      `airliners within ${R.lee_nm} nm below 6,000 ft → ${fmt1(perDay)} / day · busiest hour ${hourLabel(busiest)} · below 3,000 ft → ${fmt1(lowest)} / day`;
    if (!$('rush-band').children.length) {
      chips('rush-band', [['All', -1]].concat(bands.map((_, b) => [bandName(b), b])), 'band');
    }
    drawMap();
  }

  function drawMap() {
    const canvas = $('rush-map');
    const W = Math.min(KANP.contentWidth(canvas.parentElement), 440), H = W;
    const ctx = KANP.setupCanvas(canvas, W, H);
    const m = R.map_meta, half = m.half_nm, cell = m.cell_nm;
    const ncell = Math.round(2 * half / cell);
    const px = W / ncell;
    const cells = new Map();
    const wanted = S.band < 0 ? Object.keys(R.map) : [String(S.band)];
    let max = 0;
    for (const b of wanted) {
      for (const [x, y, s] of (R.map[b] || [])) {
        const k = x + ',' + y;
        const v = (cells.get(k) || 0) + s;
        cells.set(k, v);
        if (v > max) max = v;
      }
    }
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, W, H);
    const ramp = ['#0d366b', '#184f95', '#256abf', '#3987e5', '#6da7ec', '#9ec5f4', '#cde2fb'];
    const lmax = Math.log1p(max);
    for (const [k, v] of cells) {
      const [x, y] = k.split(',').map(Number);
      const t = lmax ? Math.log1p(v) / lmax : 0;
      const idx = Math.min(ramp.length - 1, Math.floor(t * ramp.length));
      ctx.fillStyle = ramp[idx];
      ctx.fillRect(x * px, H - (y + 1) * px, px + 0.5, px + 0.5);
    }
    // 5 nm ring, runway, north, BWI bearing
    const cx = W / 2, cy = H / 2, sc = W / (2 * half);
    ctx.strokeStyle = '#555'; ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(cx, cy, R.lee_nm * sc, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    const rw = SITE.tracker.runway.axisTrue * Math.PI / 180, rl = 0.6 * sc;
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(cx - Math.sin(rw) * rl, cy + Math.cos(rw) * rl);
    ctx.lineTo(cx + Math.sin(rw) * rl, cy - Math.cos(rw) * rl);
    ctx.stroke();
    ctx.fillStyle = '#aaa'; ctx.font = '11px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText('N', cx, 4);
    ctx.textBaseline = 'bottom';
    ctx.fillText(`${2 * half} nm`, cx, H - 4);
    for (const ap of R.order) {
      const a = R.airports[ap];
      const east = (a.lon - SITE.tracker.lon) * 60 * Math.cos(SITE.tracker.lat * Math.PI / 180);
      const north = (a.lat - SITE.tracker.lat) * 60;
      const d = Math.hypot(east, north);
      if (d <= half) continue;
      const ex = cx + east / d * (half - 0.9) * sc, ey = cy - north / d * (half - 0.9) * sc;
      ctx.fillStyle = '#888'; ctx.textBaseline = 'middle';
      ctx.fillText(`${ap} ${Math.round(d)} nm`, Math.min(W - 30, Math.max(30, ex)), Math.min(H - 10, Math.max(10, ey)));
    }
    canvas._rush = { px, ncell, H, cells, half, cell };
    hoverCanvas(canvas, ev => {
      const g = canvas._rush;
      const x = Math.floor(ev.x / g.px), y = Math.floor((g.H - ev.y) / g.px);
      const v = g.cells.get(x + ',' + y);
      if (!v) return null;
      const e = (x + 0.5) * g.cell - g.half, nn = (y + 0.5) * g.cell - g.half;
      return `<strong>${Math.abs(e).toFixed(1)} nm ${e >= 0 ? 'E' : 'W'} · ${Math.abs(nn).toFixed(1)} nm ${nn >= 0 ? 'N' : 'S'}</strong><br>${Math.round(v / 60)} min of airliner time, all days`;
    });
  }

  // ----------------------------------------------------------- terminal
  function renderTerm() {
    if (!R) return;
    const days = selDays();
    const t = series(days, d => d.term[S.region]);
    const meta = R.term[S.region];
    $('rush-term-title').textContent = `${meta.airliners ? 'airliners' : 'all aircraft'} below ${meta.ft.toLocaleString()} ft within ${meta.nm} nm of ${REGION_LABEL[S.region].split(' ')[0]} · mean per 15 min`;
    drawSlots($('rush-term-chart'), { up: [t], colors: [BLUE], height: 170,
      hover: i => `<strong>${slotLabel(i)}</strong><br>${fmt1(t[i])} aircraft` });
    // 60-minute windows, 06:00–22:00, ranked
    const wins = [];
    for (let s = 24; s + 4 <= 88; s++) {
      let v = 0;
      for (let k = 0; k < 4; k++) v += t[s + k];
      wins.push({ s, v: v / 4 });
    }
    const pick = (sorted) => {
      const out = [];
      for (const w of sorted) {
        if (out.some(o => Math.abs(o.s - w.s) < 4)) continue;
        out.push(w);
        if (out.length === 5) break;
      }
      return out.map(w => `${slotLabel(w.s)}–${slotLabel(w.s + 4)} · ${fmt1(w.v)}`).join('<br>');
    };
    $('rush-quiet').innerHTML = pick([...wins].sort((a, b) => a.v - b.v));
    $('rush-busy').innerHTML = pick([...wins].sort((a, b) => b.v - a.v));

    const feeds = R.feeds || {};
    const hasFeeds = Object.keys(feeds).length > 0;
    $('rush-atc').style.display = hasFeeds ? '' : 'none';
    $('rush-atc-none').style.display = hasFeeds ? 'none' : '';
    if (!hasFeeds) return;
    const f = feeds[S.feed] || {};
    const n = series(days.filter(d => d.atc && d.atc[S.feed]), d => d.atc[S.feed].n);
    const sec = new Array(96).fill(0), cnt = new Array(96).fill(0);
    for (const d of days) {
      if (!d.atc || !d.atc[S.feed]) continue;
      d.atc[S.feed].s.forEach((v, i) => { sec[i] += v; cnt[i]++; });
    }
    const air = sec.map((v, i) => cnt[i] ? v / cnt[i] / 900 : 0);
    const ndays = days.filter(d => d.atc && d.atc[S.feed]).length;
    $('rush-atc-title').textContent = `${f.freq || S.feed} ${f.label || ''} · transmissions per 15 min · ${ndays} days`;
    drawSlots($('rush-atc-chart'), { up: [n], colors: [ORANGE], height: 170,
      hover: i => `<strong>${slotLabel(i)}</strong><br>${fmt1(n[i])} transmissions<br>${Math.round(100 * air[i])}% of the slot on air` });
  }

  // ---------------------------------------------------------------- day
  function stepDay(dir) {
    const inp = $('rush-day');
    const d = new Date(inp.value + 'T12:00:00');
    d.setDate(d.getDate() + dir);
    const v = d.toISOString().slice(0, 10);
    if (inp.min && v < inp.min) return;
    if (inp.max && v > inp.max) return;
    inp.value = v;
    loadDay(v);
  }

  async function loadDay(date, quiet) {
    if (!date) return;
    const out = $('rush-day-result');
    let day = dayCache.get(date);
    if (!day) {
      if (!quiet) out.textContent = 'Loading…';
      try {
        const res = await fetch(`${base()}/days/${date}.json`, { cache: 'no-cache' });
        if (!res.ok) throw new Error(String(res.status));
        day = await res.json();
        dayCache.set(date, day);
      } catch (e) {
        out.textContent = `no compiled day for ${date}`;
        $('rush-day-table').querySelector('tbody').innerHTML = '';
        return;
      }
    }
    S.day = date;
    const ops = day.ops.filter(o => o[1] === S.ap && (!S.al || (o[3] || '').startsWith(S.al)));
    const arr = ops.filter(o => o[2] === 'A').length, dep = ops.length - arr;
    const gen = (day.src && day.src.generated) || 0;
    const missing = day.cov.filter((c, h) =>
      c < R.cov_min && new Date(`${date}T${String(h).padStart(2, '0')}:00:00`).getTime() / 1000 <= gen).length;
    out.textContent = `${date} · ${S.ap} · ${arr} arrivals · ${dep} departures` +
      (missing ? ` · ${missing} h missing` : '') + (day.cs_hist ? '' : ' · flight numbers approximate');
    drawStrip($('rush-day-strip'), ops);
    const tb = $('rush-day-table').querySelector('tbody');
    tb.innerHTML = ops.slice(0, 400).map(o => {
      const t = new Date(o[0] * 1000);
      return `<tr><td>${t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</td>` +
        `<td>${esc(o[3] || o[5])}</td><td><span class="rush-sw" style="background:${o[2] === 'A' ? BLUE : ORANGE}"></span>${o[2] === 'A' ? 'arr' : 'dep'}</td>` +
        `<td>${o[6] || '—'}</td><td>${esc(o[4] || '—')}</td><td>${o[7] != null ? o[7].toLocaleString() + ' ft' : '—'}</td></tr>`;
    }).join('');
    $('rush-day-more').textContent = ops.length > 400 ? `${ops.length - 400} more not listed` : '';
  }

  function drawStrip(canvas, ops) {
    const W = KANP.contentWidth(canvas.parentElement), H = 90;
    const ctx = KANP.setupCanvas(canvas, W, H);
    const PAD_L = 8, PAD_R = 8, mid = H / 2 - 6;
    const plotW = W - PAD_L - PAD_R;
    ctx.strokeStyle = '#333';
    ctx.beginPath(); ctx.moveTo(PAD_L, mid); ctx.lineTo(W - PAD_R, mid); ctx.stroke();
    ctx.fillStyle = '#666'; ctx.font = '10px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (let h = 0; h <= 24; h += 3) {
      const x = PAD_L + plotW * h / 24;
      ctx.fillText(h === 24 ? '12a' : hourLabel(h), x, H - 14);
      ctx.fillRect(x, mid - 2, 1, 4);
    }
    const marks = [];
    for (const o of ops) {
      const t = new Date(o[0] * 1000);
      const f = (t.getHours() * 3600 + t.getMinutes() * 60 + t.getSeconds()) / 86400;
      const x = PAD_L + plotW * f;
      const up = o[2] === 'A';
      ctx.fillStyle = up ? BLUE : ORANGE;
      ctx.fillRect(x - 0.75, up ? mid - 28 : mid + 2, 1.5, 26);
      marks.push({ x, o });
    }
    canvas._rush = { marks };
    hoverCanvas(canvas, ev => {
      let best = null;
      for (const m of canvas._rush.marks) {
        const d = Math.abs(m.x - ev.x);
        if (d < 4 && (!best || d < best.d)) best = { d, m };
      }
      if (!best) return null;
      const o = best.m.o;
      const t = new Date(o[0] * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      return `<strong>${esc(o[3] || o[5])}</strong> ${o[2] === 'A' ? 'arrival' : 'departure'} ${t}<br>${esc(o[4] || '')}${o[6] ? ' · RWY ' + o[6] : ''}` +
        (o[7] != null ? `<br>${o[7].toLocaleString()} ft within 5 nm of Lee` : '');
    });
  }

  // --------------------------------------------------------------- charts
  // Stacked 15-min (or hourly) bars, optionally mirrored below a zero line.
  // up/down: series[][] stacked in order; one y-scale for both halves.
  function drawSlots(canvas, o) {
    const W = KANP.contentWidth(canvas.parentElement);
    const H = o.height || 180;
    const ctx = KANP.setupCanvas(canvas, W, H);
    const n = o.up[0].length;
    const tot = arr => Array.from({ length: n }, (_, i) => arr.reduce((t, s) => t + (s[i] || 0), 0));
    const upT = tot(o.up), dnT = o.down ? tot(o.down) : null;
    const max = Math.max(0.001, ...upT, ...(dnT || [0]));
    const PAD_L = 36, PAD_R = 6, PAD_T = 8, PAD_B = 20;
    const plotW = W - PAD_L - PAD_R, plotH = H - PAD_T - PAD_B;
    const halfH = dnT ? plotH / 2 : plotH;
    const zero = PAD_T + halfH;
    const bw = plotW / n;
    ctx.strokeStyle = '#2a2a2a'; ctx.fillStyle = '#666'; ctx.font = '10px sans-serif';
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    const ticks = dnT ? [-1, -0.5, 0, 0.5, 1] : [0, 0.25, 0.5, 0.75, 1];
    for (const t of ticks) {
      const y = zero - t * halfH;
      ctx.beginPath(); ctx.moveTo(PAD_L, y); ctx.lineTo(W - PAD_R, y); ctx.stroke();
      ctx.fillText(fmt1(Math.abs(t) * max), PAD_L - 4, y);
    }
    const bar = (series, colors, dir) => {
      for (let i = 0; i < n; i++) {
        let y = zero;
        series.forEach((s, k) => {
          const h = halfH * (s[i] || 0) / max;
          if (h <= 0) return;
          ctx.fillStyle = colors[k % colors.length];
          const x = PAD_L + i * bw + 1, w = Math.max(1, bw - 2);
          if (dir > 0) ctx.fillRect(x, y - h, w, h - (k ? 1 : 0)); else ctx.fillRect(x, y + (k ? 1 : 0), w, h - (k ? 1 : 0));
          y += dir > 0 ? -h : h;
        });
      }
    };
    bar(o.up, o.colors, 1);
    if (dnT) bar(o.down, o.downColors || o.colors, -1);
    ctx.strokeStyle = '#444';
    ctx.beginPath(); ctx.moveTo(PAD_L, zero); ctx.lineTo(W - PAD_R, zero); ctx.stroke();
    ctx.fillStyle = '#666'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    const labels = o.labels || Array.from({ length: n }, (_, i) => i % 8 === 0 ? hourLabel(i / 4) : '');
    const every = o.labels ? Math.ceil(n / 12) : 8;
    for (let i = 0; i < n; i += every) ctx.fillText(labels[i] || '', PAD_L + i * bw + bw / 2, H - PAD_B + 5);
    canvas._rush = { PAD_L, bw, n };
    hoverCanvas(canvas, ev => {
      const g = canvas._rush;
      const i = Math.floor((ev.x - g.PAD_L) / g.bw);
      if (i < 0 || i >= g.n || !o.hover) return null;
      return o.hover(i);
    });
  }

  function getTip() {
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'grid-tip';
      document.body.appendChild(tip);
    }
    return tip;
  }

  // one listener per canvas; the text callback is swapped on every redraw
  function hoverCanvas(canvas, textFn) {
    canvas._rushText = textFn;
    if (canvas._rushBound) return;
    canvas._rushBound = true;
    const move = ev => {
      const r = canvas.getBoundingClientRect();
      const html = canvas._rushText({ x: ev.clientX - r.left, y: ev.clientY - r.top });
      const el = getTip();
      if (!html) { el.style.display = 'none'; return; }
      el.innerHTML = html;
      el.style.display = 'block';
      const b = el.getBoundingClientRect();
      let x = ev.clientX + 14, y = ev.clientY + 14;
      if (x + b.width > window.innerWidth - 8) x = ev.clientX - b.width - 10;
      if (y + b.height > window.innerHeight - 8) y = ev.clientY - b.height - 10;
      el.style.left = `${x}px`; el.style.top = `${y}px`;
    };
    canvas.addEventListener('mousemove', move);
    canvas.addEventListener('mouseleave', () => { if (tip) tip.style.display = 'none'; });
  }

  return { init, onShow, _state: S, _data: () => R };
})();
