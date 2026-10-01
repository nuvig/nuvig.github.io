// KANP Flight Tracker — Airline Traffic tab
// Today first: what the airliners at BWI / DCA / IAD / ADW / MTN are doing
// right now and next, then the folds that explain it. Reads rush.json on the
// rush-data branch (scripts/build_rush.py compiles it hourly from the Pi's
// day snapshots). Every mean is per covered day; an hour the collector
// missed is left out, never counted as quiet. Times are the field's zone.

const KANPRush = (() => {
  const A62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const dec = s => Array.from(s || '', c => A62.indexOf(c));
  const BLUE = '#3987e5', ORANGE = '#d95926';
  // categorical, dark-surface steps (validated set — js/aircraft.js uses the same)
  const CAT = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300'];
  // ordinal ramp for the altitude bands, lowest band brightest
  const BAND_COLORS = ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#1c5cab'];
  // status: quiet / normal / busy — always with a label, never colour alone
  const TIER = [['quiet', '#22c55e'], ['normal', '#555'], ['busy', '#ef4444']];
  const RANGES = [['7 d', 7], ['30 d', 30], ['90 d', 90], ['All', 0]];
  const CLASSES = [['Weekdays', 'wk'], ['Sat', 'sat'], ['Sun', 'sun'], ['All', 'all']];
  const REGION_LABEL = {
    bwi25: 'BWI 25 nm', dca25: 'DCA 25 nm', iad25: 'IAD 25 nm', lee15: 'Lee 15 nm',
  };
  const REGION_OF = { BWI: 'bwi25', DCA: 'dca25', IAD: 'iad25', ADW: 'lee15', MTN: 'lee15' };
  const DOW = 'MTWTFSS';
  const DAY0 = 20, DAY1 = 92;            // the strip: 5a → 11p in 15-min slots

  let R = null;
  let loaded = false, loading = false;
  const S = { ap: 'BWI', al: '', cls: 'wk', range: 30, region: 'bwi25', band: -1,
              feed: '', kind: '', recAll: false, recSort: 'time', day: null, today: null };
  const dayCache = new Map();
  let tip = null;

  const $ = id => document.getElementById(id);
  const base = () => localStorage.getItem('kanp_rush_base') || SITE.tracker.rushBase;
  const hourLabel = h => h === 0 ? '12a' : h < 12 ? `${h}a` : h === 12 ? '12p' : `${h - 12}p`;
  const slotLabel = s => {
    const h = Math.floor(s / 4) % 24, m = (s % 4) * 15;
    const hh = h % 12 === 0 ? 12 : h % 12;
    return `${hh}:${String(m).padStart(2, '0')}${h < 12 ? 'a' : 'p'}`;
  };
  const minLabel = m => slotLabel(Math.floor(m / 15)).replace(/:\d\d/, ':' + String(m % 60).padStart(2, '0'));
  const fmt1 = v => v >= 10 ? Math.round(v).toLocaleString() : (Math.round(v * 10) / 10).toString();
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const localDate = d => { const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
  const sum = a => a.reduce((x, y) => x + y, 0);
  const clock = ts => new Date(ts * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  // ------------------------------------------------------------------ boot
  function init() {
    const btn = document.querySelector('.tab-btn[data-tab="tab-rush"]');
    if (btn) btn.addEventListener('click', () => { if (!loaded) load(); });
    if ($('tab-rush').classList.contains('active')) load();
    chips('rush-cls', CLASSES, 'cls');
    chips('rush-range', RANGES, 'range');
    chips('rush-region', Object.entries(REGION_LABEL).map(([v, l]) => [l, v]), 'region');
    chips('rush-kind', [['Both', ''], ['Arrivals', 'A'], ['Departures', 'D']], 'kind');
    $('rush-rec-more').addEventListener('click', () => { S.recAll = true; renderRecurring(); });
    $('rush-rec').querySelectorAll('th[data-k]').forEach(th =>
      th.addEventListener('click', () => { S.recSort = th.dataset.k; renderRecurring(); }));
    $('rush-day-load').addEventListener('click', () => loadDay($('rush-day').value));
    $('rush-day-prev').addEventListener('click', () => stepDay(-1));
    $('rush-day-next').addEventListener('click', () => stepDay(1));
    $('rush-day').addEventListener('change', () => loadDay($('rush-day').value));
    // a fold renders when it opens — a closed <details> has no width to draw into
    document.querySelectorAll('#tab-rush details.rush-fold').forEach(d =>
      d.addEventListener('toggle', () => { if (d.open && loaded) renderFold(d.id); }));
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
        const keys = Object.keys(R.feeds);
        S.feed = keys.find(k => /124\.5/.test(R.feeds[k].freq || '')) || keys[0];
        chips('rush-feed', keys.map(m => [R.feeds[m].freq || m, m, R.feeds[m].label]), 'feed');
      }
      const newest = R.days.length ? R.days[R.days.length - 1].d : '';
      $('rush-day').value = newest;
      $('rush-day').max = newest;
      $('rush-day').min = R.days.length ? R.days[0].d : '';
      await loadToday();
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
        if (key === 'region' || key === 'feed') renderFold('fold-load');
        else if (key === 'kind') renderFold('fold-timetable');
        else if (key === 'band') drawMap();
        else if (key === 'cls') renderFold('fold-profile');
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
  function rangeFrom() {
    if (!S.range || !R.days.length) return '';
    const d = new Date(R.days[R.days.length - 1].d + 'T12:00:00');
    d.setDate(d.getDate() - S.range + 1);
    return localDate(d);
  }

  function selDays(cls) {
    if (!R) return [];
    const from = rangeFrom();
    return R.days.filter(d => d.d >= from && (cls === 'all' || d.cls === cls));
  }

  // today's day class: the compiled record's, else from the calendar; a
  // holiday flies a Sunday schedule
  function todayClass() {
    const rec = R.days.find(d => d.d === S.today);
    let cls = rec ? rec.cls : ['sun', 'wk', 'wk', 'wk', 'wk', 'wk', 'sat'][new Date().getDay()];
    return cls === 'hol' ? 'sun' : cls;
  }

  // mean per covered day of a 96-slot series across days; pick(day) → string
  function series(days, pick) {
    const total = new Array(96).fill(0), n = new Array(96).fill(0);
    for (const d of days) {
      const s = pick(d);
      if (!s) continue;
      const v = dec(s);
      for (let i = 0; i < 96; i++) {
        if (d.cov[Math.floor(i / 4)] !== '1') continue;
        total[i] += v[i]; n[i]++;
      }
    }
    return total.map((v, i) => n[i] ? v / n[i] : 0);
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

  // the workload series for the tier strip: measured transmissions when the
  // Pi has published them, else the ADS-B count in the airport's region
  function loadSeries(days) {
    const feeds = R.feeds || {};
    if (S.feed && feeds[S.feed]) {
      const have = days.filter(d => d.atc && d.atc[S.feed]);
      if (have.length >= 3) {
        return { v: series(have, d => d.atc[S.feed].n), src: `${feeds[S.feed].freq || S.feed} transmissions`, n: have.length };
      }
    }
    const region = REGION_OF[S.ap] || 'lee15';
    const m = R.term[region];
    return { v: series(days, d => d.term[region]),
             src: `${m.airliners ? 'airliners' : 'aircraft'} below ${m.ft.toLocaleString()} ft within ${m.nm} nm of ${REGION_LABEL[region].split(' ')[0]} (ADS-B count)`, n: days.length };
  }

  // hourly tiers over the daytime: terciles of the hourly mean
  function tiers(v) {
    const hourly = Array.from({ length: 24 }, (_, h) => (v[h * 4] + v[h * 4 + 1] + v[h * 4 + 2] + v[h * 4 + 3]) / 4);
    const day = hourly.slice(6, 22).slice().sort((a, b) => a - b);
    const lo = day[Math.floor(day.length / 3)], hi = day[Math.floor(day.length * 2 / 3)];
    return { hourly, tier: hourly.map(x => x <= lo ? 0 : x >= hi ? 2 : 1) };
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

  // ---------------------------------------------------------------- render
  function render() {
    if (!R) return;
    const gen = new Date(R.generated * 1000);
    const days = selDays(todayClass());
    const cov = coveredDays(days);
    const clsName = { wk: 'weekdays', sat: 'Saturdays', sun: 'Sundays' }[todayClass()];
    $('rush-result').textContent = days.length
      ? `${S.ap} · ${S.al ? (R.airlines[S.al] || S.al) + ' · ' : ''}profile from ${cov.n} ${clsName}` +
        (cov.missing ? ` · ${cov.missing} h missing` : '') + ` · compiled ${clock(R.generated)}`
      : 'No days in this range';
    const note = $('rush-cs-note');
    note.textContent = R.cs_hist_from
      ? `flight numbers exact from ${R.cs_hist_from}; before that a turnaround's arrival carries its departing number`
      : 'flight numbers: a turnaround’s arrival carries its departing number until the Pi exporter update';
    if (!days.length) { $('rush-body').style.display = 'none'; return; }
    $('rush-body').style.display = '';
    void gen;
    renderToday(days);
    document.querySelectorAll('#tab-rush details.rush-fold').forEach(d => {
      summarizeFold(d.id);
      if (d.open) renderFold(d.id);
    });
  }

  // ---------------------------------------------------------------- today
  async function loadToday() {
    S.today = localDate(new Date());
    let rec = await fetchDay(S.today);
    if (!rec && R.days.length) {
      S.today = R.days[R.days.length - 1].d;
      rec = await fetchDay(S.today);
    }
    S.todayRec = rec;
  }

  function todayOps(kind) {
    const rec = S.todayRec;
    if (!rec) return [];
    return rec.ops.filter(o => o[1] === S.ap && (!kind || o[2] === kind) && (!S.al || (o[3] || '').startsWith(S.al)));
  }

  function renderToday(days) {
    const isToday = S.today === localDate(new Date());
    const now = new Date();
    const nowSlot = isToday ? now.getHours() * 4 + Math.floor(now.getMinutes() / 15) : 96;
    const prof = apSeries(days, S.ap, S.al, 'A');
    const banks = detectBanks(prof);
    const load = loadSeries(days);
    const { hourly, tier } = tiers(load.v);
    const arrivals = todayOps('A');
    const rec = S.todayRec;
    const asOf = rec ? clock(rec.generated) : null;

    $('rush-today-title').textContent = isToday ? 'Today' : `${S.today} (newest compiled day)`;
    drawToday($('rush-today-strip'), { prof, arrivals, nowSlot, tier, hourly, load, isToday });
    $('rush-today-legend').innerHTML =
      `<span><span class="rush-sw" style="background:${BLUE};opacity:.45"></span>expected arrivals</span>` +
      `<span><span class="rush-sw" style="background:${BLUE}"></span>today's arrivals${asOf ? ` (as of ${asOf})` : ''}</span>` +
      TIER.map(([n, c]) => `<span><span class="rush-sw" style="background:${c}"></span>${n}</span>`).join('') +
      `<span class="rush-src">tiers → ${esc(load.src)}</span>`;

    // the verdict: now · next lull · next bank
    const parts = [];
    if (isToday) {
      const h = now.getHours();
      const inBank = banks.find(b => nowSlot >= b.s && nowSlot <= b.e);
      const recent = arrivals.filter(o => o[0] >= now.getTime() / 1000 - 900).length;
      let state;
      if (h < 5 || h >= 23) state = 'overnight';
      else if (inBank) state = `bank · ${fmt1(prof[nowSlot])} expected / 15 min`;
      else state = tier[h] === 0 ? 'lull' : tier[h] === 2 ? 'busy' : 'normal';
      parts.push(`now → ${state}${recent && rec && rec.generated > now.getTime() / 1000 - 1800 ? ` · ${recent} in the last 15 min` : ''}`);
      const nextQuiet = tier.findIndex((t, hh) => t === 0 && hh > h && hh < 23);
      if (nextQuiet > 0) parts.push(`next lull → ${hourLabel(nextQuiet)}–${hourLabel(nextQuiet + 1)}`);
      const nextBank = banks.find(b => b.s > nowSlot);
      if (nextBank) parts.push(`next bank → ${slotLabel(nextBank.s)}–${slotLabel(nextBank.e + 1)} · ${fmt1(nextBank.total)} arrivals`);
      else if (h < 23) parts.push('next bank → none left today');
    } else {
      const first = banks[0];
      parts.push(first ? `first bank → ${slotLabel(first.s)}–${slotLabel(first.e + 1)} · ${fmt1(first.total)} arrivals` : 'no bank stands out');
    }
    $('rush-verdict').textContent = parts.join('   ·   ');

    // best windows: the quietest remaining 60-min windows, 6a–10p
    const wins = [];
    const fromSlot = isToday ? Math.max(24, nowSlot + 1) : 24;
    for (let s = fromSlot; s + 4 <= 88; s++) wins.push({ s, v: (load.v[s] + load.v[s + 1] + load.v[s + 2] + load.v[s + 3]) / 4 });
    const best = [];
    for (const w of wins.sort((a, b) => a.v - b.v)) {
      if (best.some(o => Math.abs(o.s - w.s) < 4)) continue;
      best.push(w);
      if (best.length === 3) break;
    }
    best.sort((a, b) => a.s - b.s);
    $('rush-windows').textContent = best.length
      ? `best windows${isToday ? ' left today' : ''} → ` + best.map(w => `${slotLabel(w.s)}–${slotLabel(w.s + 4)}`).join(' · ')
      : 'best windows → none left today';

    // runway in use → where the jets are
    const byRwy = {};
    arrivals.forEach(o => { if (o[6]) byRwy[o[6]] = (byRwy[o[6]] || 0) + 1; });
    const total = sum(Object.values(byRwy));
    const lee = leeByRunway(days);
    let rw = '';
    if (total >= 5) {
      const [r, n] = Object.entries(byRwy).sort((a, b) => b[1] - a[1])[0];
      rw = `${S.ap} landing ${r}${isToday ? ' today' : ''} (${n} of ${total})`;
      const l = lee.get(r);
      if (l && l[1]) rw += ` → ${Math.round(100 * l[0] / l[1])}% pass within ${R.lee_nm} nm of Lee below 6,000 ft, ${Math.round(100 * l[2] / l[1])}% below 3,000 ft`;
    } else {
      const usual = [...lee.entries()].sort((a, b) => b[1][1] - a[1][1])[0];
      if (usual) {
        const [r, l] = usual;
        const all = sum([...lee.values()].map(x => x[1]));
        rw = `${S.ap} usually lands ${r} (${Math.round(100 * l[1] / all)}%) → ${Math.round(100 * l[0] / l[1])}% pass within ${R.lee_nm} nm of Lee below 6,000 ft`;
      }
    }
    $('rush-rwy-line').textContent = rw;

    // tiles
    $('rt-arr').textContent = fmt1(sum(prof));
    $('rt-arr-lbl').textContent = `${S.al || 'all'} arrivals / day`;
    const allTotal = sum(apSeries(days, S.ap, '', 'A')) + sum(apSeries(days, S.ap, '', 'D'));
    const pfx = S.al || (R.top[S.ap] || [])[0];
    if (pfx && allTotal) {
      const mine = sum(apSeries(days, S.ap, pfx, 'A')) + sum(apSeries(days, S.ap, pfx, 'D'));
      $('rt-share').textContent = `${Math.round(100 * mine / allTotal)}%`;
      $('rt-share-lbl').textContent = `${pfx} share of ${S.ap}`;
    } else {
      $('rt-share').textContent = '–';
      $('rt-share-lbl').textContent = 'airline share';
    }
    if (rec) {
      const upto = isToday ? Math.min(96, Math.floor(rec.generated % 86400 / 900)) : 96;
      const cutoff = isToday ? rec.generated : Infinity;
      const actual = arrivals.filter(o => o[0] <= cutoff).length;
      let expected = 0;
      if (isToday) {
        const genLocal = new Date(rec.generated * 1000);
        const gs = genLocal.getHours() * 4 + genLocal.getMinutes() / 15;
        for (let i = 0; i < 96; i++) expected += prof[i] * Math.max(0, Math.min(1, gs - i));
      } else expected = sum(prof);
      void upto;
      $('rt-today').textContent = String(actual);
      $('rt-today-lbl').textContent = `${isToday ? 'so far' : 'that day'} · ${fmt1(expected)} expected${asOf ? ` · as of ${asOf}` : ''}`;
    } else {
      $('rt-today').textContent = '–';
      $('rt-today-lbl').textContent = 'today · not compiled yet';
    }
  }

  // per-runway near-Lee tallies over the profile days: {rwy → [near, total, below3k]}
  function leeByRunway(days) {
    const lee = new Map();
    for (const d of days) {
      const a = d.ap[S.ap];
      if (!a) continue;
      for (const [r, [near, tot, low]] of Object.entries(a.lee || {})) {
        const cur = lee.get(r) || [0, 0, 0];
        cur[0] += near; cur[1] += tot; cur[2] += low;
        lee.set(r, cur);
      }
    }
    return lee;
  }

  function drawToday(canvas, o) {
    const W = KANP.contentWidth(canvas.parentElement), H = 150;
    const ctx = KANP.setupCanvas(canvas, W, H);
    const PAD_L = 30, PAD_R = 6, PAD_T = 6, CELL_H = 14, PAD_B = 18 + CELL_H + 4;
    const plotW = W - PAD_L - PAD_R, plotH = H - PAD_T - PAD_B;
    const n = DAY1 - DAY0;
    const bw = plotW / n;
    const x0 = i => PAD_L + (i - DAY0) * bw;
    const max = Math.max(0.5, ...o.prof.slice(DAY0, DAY1)) * 1.1;
    const y = v => PAD_T + plotH - plotH * v / max;
    // expected arrivals, a soft area
    ctx.beginPath();
    ctx.moveTo(x0(DAY0), y(0));
    for (let i = DAY0; i < DAY1; i++) ctx.lineTo(x0(i) + bw / 2, y(o.prof[i]));
    ctx.lineTo(x0(DAY1), y(0));
    ctx.closePath();
    ctx.fillStyle = 'rgba(57,135,229,0.22)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(57,135,229,0.7)'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = DAY0; i < DAY1; i++) { const px = x0(i) + bw / 2, py = y(o.prof[i]); if (i === DAY0) ctx.moveTo(px, py); else ctx.lineTo(px, py); }
    ctx.stroke();
    // y ticks
    ctx.fillStyle = '#666'; ctx.font = '10px sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    [0, 0.5, 1].forEach(t => { ctx.fillText(fmt1(max * t / 1.1), PAD_L - 4, y(max * t / 1.1)); });
    // today's arrivals as ticks along the baseline
    const marks = [];
    for (const op of o.arrivals) {
      const t = new Date(op[0] * 1000);
      const f = (t.getHours() * 60 + t.getMinutes() + t.getSeconds() / 60) / 15;
      if (f < DAY0 || f >= DAY1) continue;
      const px = x0(f);
      ctx.fillStyle = BLUE;
      ctx.fillRect(px - 0.75, PAD_T + plotH - 16, 1.5, 16);
      marks.push({ x: px, op });
    }
    // tier cells, one per hour
    const cellY = PAD_T + plotH + 4;
    for (let h = 5; h < 23; h++) {
      const [, c] = TIER[o.tier[h]];
      ctx.fillStyle = c;
      ctx.globalAlpha = o.isToday && h < new Date().getHours() ? 0.35 : 0.85;
      ctx.fillRect(x0(h * 4) + 1, cellY, bw * 4 - 2, CELL_H);
    }
    ctx.globalAlpha = 1;
    // now
    if (o.isToday && o.nowSlot >= DAY0 && o.nowSlot < DAY1) {
      const t = new Date();
      const px = x0((t.getHours() * 60 + t.getMinutes()) / 15);
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(px, PAD_T); ctx.lineTo(px, cellY + CELL_H); ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.font = '9px sans-serif'; ctx.textBaseline = 'top';
      ctx.textAlign = t.getHours() < 14 ? 'left' : 'right';
      ctx.fillText('now', px + (t.getHours() < 14 ? 3 : -3), PAD_T);
    }
    // x labels
    ctx.fillStyle = '#666'; ctx.font = '10px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (let h = 6; h < 23; h += 2) ctx.fillText(hourLabel(h), x0(h * 4), cellY + CELL_H + 4);
    canvas._rush = { marks, bw, x0, PAD_L };
    hoverCanvas(canvas, ev => {
      const i = DAY0 + (ev.x - PAD_L) / bw;
      if (i < DAY0 || i >= DAY1) return null;
      const slot = Math.floor(i), h = Math.floor(slot / 4);
      const near = marks.filter(m => Math.abs(m.x - ev.x) < 3).map(m => esc(m.op[3] || m.op[5]));
      const actual = o.arrivals.filter(op => { const t = new Date(op[0] * 1000); return t.getHours() * 4 + Math.floor(t.getMinutes() / 15) === slot; }).length;
      return `<strong>${slotLabel(slot)}</strong> · expected ${fmt1(o.prof[slot])} · today ${actual}` +
        `<br>${hourLabel(h)}–${hourLabel(h + 1)}: ${TIER[o.tier[h]][0]} · ${fmt1(o.hourly[h])} per 15 min` +
        (near.length ? `<br>${near.join(' · ')}` : '');
    });
  }

  // ----------------------------------------------------------------- folds
  function summarizeFold(id) {
    const days = selDays(S.cls);
    const sub = $(id.replace('fold-', 'sum-'));
    if (!sub) return;
    if (id === 'fold-profile') {
      const arr = apSeries(days, S.ap, S.al, 'A');
      const b = detectBanks(arr);
      const clsName = { wk: 'weekdays', sat: 'Saturdays', sun: 'Sundays', all: 'all days' }[S.cls];
      sub.textContent = `${days.length} ${clsName} · ${fmt1(sum(arr))} arrivals / day` + (b.length ? ` · first bank ${slotLabel(b[0].s)}–${slotLabel(b[0].e + 1)}` : '');
    } else if (id === 'fold-lee') {
      const lee = leeByRunway(selDays(todayClass()));
      const all = sum([...lee.values()].map(x => x[1]));
      const top = [...lee.entries()].sort((a, b) => b[1][1] - a[1][1])[0];
      const perDay = leePerDay(selDays(todayClass()));
      sub.textContent = (top ? `${S.ap} ${top[0]} ${Math.round(100 * top[1][1] / Math.max(1, all))}% · ` : '') +
        `${fmt1(perDay.total)} airliners / day within ${R.lee_nm} nm below 6,000 ft`;
    } else if (id === 'fold-timetable') {
      sub.textContent = `${regulars().length} regulars`;
    } else if (id === 'fold-load') {
      const { v, src } = loadSeries(selDays(todayClass()));
      const { hourly } = tiers(v);
      let q = 6, b = 6;
      for (let h = 6; h < 22; h++) { if (hourly[h] < hourly[q]) q = h; if (hourly[h] > hourly[b]) b = h; }
      sub.textContent = `quietest ${hourLabel(q)}–${hourLabel(q + 1)} · busiest ${hourLabel(b)}–${hourLabel(b + 1)} · ${src.split(' (')[0]}`;
    } else if (id === 'fold-day') {
      sub.textContent = S.day || '';
    }
  }

  function renderFold(id) {
    if (!R) return;
    summarizeFold(id);
    if (id === 'fold-profile') renderProfile();
    else if (id === 'fold-lee') renderLee();
    else if (id === 'fold-timetable') { renderTimetable(); renderRecurring(); }
    else if (id === 'fold-load') renderTerm();
    else if (id === 'fold-day') { if (!S.day) loadDay($('rush-day').value, true); else drawDay(); }
  }

  // --- profile ---------------------------------------------------------
  function renderProfile() {
    const days = selDays(S.cls);
    const arr = apSeries(days, S.ap, S.al, 'A');
    const dep = apSeries(days, S.ap, S.al, 'D');
    drawSlots($('rush-mirror'), { up: [arr], down: [dep], colors: [BLUE], downColors: [ORANGE],
      height: 210, hover: i => `<strong>${slotLabel(i)}</strong><br>${fmt1(arr[i])} arrivals · ${fmt1(dep[i])} departures<br>per day` });
    renderBanks(days, arr, dep);
    renderGrid(days);
    renderAirlines(days);
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
    const all = R.days.filter(d => d.d >= rangeFrom());
    const total = Array.from({ length: 7 }, () => new Array(24).fill(0));
    const n = Array.from({ length: 7 }, () => new Array(24).fill(0));
    for (const d of all) {
      const a = d.ap[S.ap];
      if (!a) continue;
      const dow = (new Date(d.d + 'T12:00:00').getDay() + 6) % 7;
      const va = dec(S.al ? (a.al[S.al] || [])[0] : a.a), vd = dec(S.al ? (a.al[S.al] || [])[1] : a.d);
      for (let h = 0; h < 24; h++) {
        if (d.cov[h] !== '1') continue;
        for (let k = 0; k < 4; k++) total[dow][h] += (va[h * 4 + k] || 0) + (vd[h * 4 + k] || 0);
        n[dow][h]++;
      }
    }
    void days;
    const grid = total.map((row, d) => row.map((v, h) => n[d][h] ? Math.round(10 * v / n[d][h]) / 10 : 0));
    KANP.renderGrid($('rush-grid'), grid, { unit: 'movements / h' });
  }

  function renderAirlines(days) {
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

  // --- runway and near Lee ---------------------------------------------
  function leePerDay(days) {
    const bands = R.bands;
    const total = Array.from({ length: 24 }, () => new Array(bands.length).fill(0));
    const n = new Array(24).fill(0);
    for (const d of days) {
      for (let h = 0; h < 24; h++) {
        if (d.cov[h] !== '1') continue;
        n[h]++;
        dec(d.low[h]).forEach((v, b) => { total[h][b] += v; });
      }
    }
    const stack = total.map((row, h) => row.map(v => n[h] ? v / n[h] : 0));
    return { stack, total: stack.reduce((t, r) => t + sum(r.slice(0, 4)), 0),
             lowest: stack.reduce((t, r) => t + r[0], 0) };
  }

  function renderLee() {
    const days = selDays(todayClass());
    const bands = R.bands;
    // runway rows, arrivals by direction, with the near-Lee share
    const byRwy = new Map();
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
    }
    const lee = leeByRunway(days);
    const names = [...byRwy.keys()].sort((x, y) => sum(byRwy.get(y)) - sum(byRwy.get(x)));
    const total = names.reduce((t, r) => t + sum(byRwy.get(r)), 0);
    $('rush-rwys').innerHTML = names.map((r, i) => {
      const v = sum(byRwy.get(r));
      const l = lee.get(r);
      const near = l && l[1] ? `${Math.round(100 * l[0] / l[1])}% within ${R.lee_nm} nm of Lee below 6,000 ft · ${Math.round(100 * l[2] / l[1])}% below 3,000 ft` : '';
      return `<div class="rwy-row"><span class="rwy-name"><span class="rush-sw" style="background:${CAT[i % CAT.length]}"></span>RWY ${r}</span>` +
        `<span class="rwy-bar"><span style="width:${100 * v / Math.max(1, total)}%"></span></span>` +
        `<span class="rwy-pct">${total ? Math.round(100 * v / total) : 0}%</span><span class="rwy-side">${near}</span></div>`;
    }).join('') || '<div class="rwy-side">no runway reads</div>';
    void ndays;

    const { stack, total: perDay, lowest } = leePerDay(days);
    const bandName = b => (b === 0 ? `< ${bands[0].toLocaleString()}` : `${bands[b - 1] / 1000}–${bands[b] / 1000}k`) + ' ft';
    const labels = Array.from({ length: 24 }, (_, h) => hourLabel(h));
    drawSlots($('rush-lee-chart'), { up: bands.map((_, b) => stack.map(r => r[b])), colors: BAND_COLORS,
      height: 160, labels, hover: h => `<strong>${hourLabel(h)}</strong><br>` +
        stack[h].map((v, b) => `${bandName(b)}: ${fmt1(v)}`).join('<br>') + '<br>airliners per day within 5 nm' });
    $('rush-lee-legend').innerHTML = bands.map((_, b) =>
      `<span><span class="rush-sw" style="background:${BAND_COLORS[b]}"></span>${bandName(b)}</span>`).join('');
    let busiest = 0;
    stack.forEach((r, h) => { if (sum(r.slice(0, 4)) > sum(stack[busiest].slice(0, 4))) busiest = h; });
    $('rush-lee-line').textContent =
      `within ${R.lee_nm} nm below 6,000 ft → ${fmt1(perDay)} / day · busiest hour ${hourLabel(busiest)} · below 3,000 ft → ${fmt1(lowest)} / day`;
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
      ctx.fillStyle = ramp[Math.min(ramp.length - 1, Math.floor(t * ramp.length))];
      ctx.fillRect(x * px, H - (y + 1) * px, px + 0.5, px + 0.5);
    }
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
    ctx.fillStyle = '#aaa'; ctx.font = '11px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText('N ↑', 6, 4);
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.fillText(`${2 * half} nm · ${R.lee_nm} nm ring`, cx, H - 4);
    for (const ap of R.order) {
      const a = R.airports[ap];
      const east = (a.lon - SITE.tracker.lon) * 60 * Math.cos(SITE.tracker.lat * Math.PI / 180);
      const north = (a.lat - SITE.tracker.lat) * 60;
      const d = Math.hypot(east, north);
      if (d <= half) continue;
      const ex = cx + east / d * (half - 0.9) * sc, ey = cy - north / d * (half - 0.9) * sc;
      ctx.fillStyle = '#888'; ctx.textBaseline = 'middle';
      ctx.fillText(`${ap} ${Math.round(d)} nm`, Math.min(W - 30, Math.max(30, ex)), Math.min(H - 10, Math.max(14, ey)));
    }
    canvas._rush = { px, H, cells, half, cell };
    hoverCanvas(canvas, ev => {
      const g = canvas._rush;
      const x = Math.floor(ev.x / g.px), y = Math.floor((g.H - ev.y) / g.px);
      const v = g.cells.get(x + ',' + y);
      if (!v) return null;
      const e = (x + 0.5) * g.cell - g.half, nn = (y + 0.5) * g.cell - g.half;
      return `<strong>${Math.abs(e).toFixed(1)} nm ${e >= 0 ? 'E' : 'W'} · ${Math.abs(nn).toFixed(1)} nm ${nn >= 0 ? 'N' : 'S'}</strong><br>${Math.round(v / 60)} min of airliner time, all days`;
    });
  }

  // --- timetable ---------------------------------------------------------
  // the regulars: tight schedules (spread ≤ 15 min) seen on most days
  function regulars() {
    return R.recurring.filter(r => r[0] === S.ap && (!S.kind || r[1] === S.kind) &&
      (!S.al || r[2].startsWith(S.al)) && (r[6] - r[5]) <= 30 && r[7] >= Math.max(4, 0.6 * r[8]));
  }

  function renderTimetable() {
    const rows = regulars().sort((a, b) => a[4] - b[4]);
    const byHour = new Map();
    rows.forEach(r => { const h = Math.floor(r[4] / 60); if (!byHour.has(h)) byHour.set(h, []); byHour.get(h).push(r); });
    $('rush-tt').innerHTML = [...byHour.entries()].map(([h, list]) =>
      `<div class="tt-row"><span class="tt-hour">${hourLabel(h)}</span><span class="tt-list">` +
      list.map(r => `<span class="tt-item" title="${esc(r[3] || '')} · ${r[7]} of ${r[8]} days · ±${Math.round((r[6] - r[5]) / 2)} min">` +
        `<span class="rush-sw" style="background:${r[1] === 'A' ? BLUE : ORANGE}"></span>${minLabel(r[4])} ${esc(r[2])}</span>`).join('') +
      `</span></div>`).join('') || '<div class="rwy-side">no regulars yet</div>';
  }

  function renderRecurring() {
    if (!R) return;
    const rows = R.recurring.filter(r => r[0] === S.ap && (!S.kind || r[1] === S.kind) &&
      (!S.al || r[2].startsWith(S.al)));
    const key = { time: r => r[4], days: r => -r[7], cs: r => r[2], spread: r => r[6] - r[5], last: r => r[10] }[S.recSort];
    rows.sort((a, b) => { const x = key(a), y = key(b); return x < y ? -1 : x > y ? 1 : a[4] - b[4]; });
    $('rush-rec').querySelectorAll('th').forEach(th => th.classList.toggle('on', th.dataset.k === S.recSort));
    const show = S.recAll ? rows : rows.slice(0, 60);
    const tb = $('rush-rec').querySelector('tbody');
    tb.innerHTML = show.map(r => {
      const [, kind, cs, type, med, p25, p75, seen, possible, , last, mask] = r;
      const week = [...DOW].map((c, i) => `<span class="${mask & (1 << i) ? 'on' : ''}">${c}</span>`).join('');
      return `<tr><td>${esc(cs)}</td><td><span class="rush-sw" style="background:${kind === 'A' ? BLUE : ORANGE}"></span>${kind === 'A' ? 'arr' : 'dep'}</td>` +
        `<td>${minLabel(med)}</td><td>±${Math.round((p75 - p25) / 2)} min</td><td>${seen} / ${possible}</td>` +
        `<td>${esc(type || '')}</td><td class="rush-week">${week}</td><td>${last.slice(5)}</td></tr>`;
    }).join('') || '<tr><td colspan="8" style="color:#555">nothing seen on 4+ days</td></tr>';
    $('rush-rec-count').textContent = rows.length ? `${rows.length} flights` : '';
    $('rush-rec-more').style.display = rows.length > show.length ? '' : 'none';
  }

  // --- approach-area load ------------------------------------------------
  function renderTerm() {
    if (!R) return;
    const days = selDays(todayClass());
    const t = series(days, d => d.term[S.region]);
    const meta = R.term[S.region];
    $('rush-term-title').textContent = `${meta.airliners ? 'airliners' : 'all aircraft'} below ${meta.ft.toLocaleString()} ft within ${meta.nm} nm of ${REGION_LABEL[S.region].split(' ')[0]} · mean per 15 min · ADS-B count`;
    drawSlots($('rush-term-chart'), { up: [t], colors: [BLUE], height: 160,
      hover: i => `<strong>${slotLabel(i)}</strong><br>${fmt1(t[i])} aircraft` });
    const wins = [];
    for (let s = 24; s + 4 <= 88; s++) wins.push({ s, v: (t[s] + t[s + 1] + t[s + 2] + t[s + 3]) / 4 });
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
    const have = days.filter(d => d.atc && d.atc[S.feed]);
    const n = series(have, d => d.atc[S.feed].n);
    const sec = new Array(96).fill(0), cnt = new Array(96).fill(0);
    for (const d of have) d.atc[S.feed].s.forEach((v, i) => { sec[i] += v; cnt[i]++; });
    const air = sec.map((v, i) => cnt[i] ? v / cnt[i] / 900 : 0);
    $('rush-atc-title').textContent = `${f.freq || S.feed} ${f.label || ''} · transmissions per 15 min · ${have.length} days`;
    drawSlots($('rush-atc-chart'), { up: [n], colors: [ORANGE], height: 160,
      hover: i => `<strong>${slotLabel(i)}</strong><br>${fmt1(n[i])} transmissions<br>${Math.round(100 * air[i])}% of the slot on air` });
  }

  // --- one day -----------------------------------------------------------
  async function fetchDay(date) {
    if (dayCache.has(date)) return dayCache.get(date);
    try {
      const res = await fetch(`${base()}/days/${date}.json`, { cache: 'no-cache' });
      if (!res.ok) return null;
      const day = await res.json();
      dayCache.set(date, day);
      return day;
    } catch { return null; }
  }

  function stepDay(dir) {
    const inp = $('rush-day');
    const d = new Date(inp.value + 'T12:00:00');
    d.setDate(d.getDate() + dir);
    const v = localDate(d);
    if (inp.min && v < inp.min) return;
    if (inp.max && v > inp.max) return;
    inp.value = v;
    loadDay(v);
  }

  async function loadDay(date, quiet) {
    if (!date) return;
    const out = $('rush-day-result');
    if (!quiet) out.textContent = 'Loading…';
    const day = await fetchDay(date);
    if (!day) {
      out.textContent = `no compiled day for ${date}`;
      $('rush-day-table').querySelector('tbody').innerHTML = '';
      return;
    }
    S.day = date;
    S.dayRec = day;
    summarizeFold('fold-day');
    if ($('fold-day').open) drawDay();
  }

  function drawDay() {
    const day = S.dayRec, date = S.day;
    if (!day) return;
    const ops = day.ops.filter(o => o[1] === S.ap && (!S.al || (o[3] || '').startsWith(S.al)));
    const arr = ops.filter(o => o[2] === 'A').length, dep = ops.length - arr;
    const gen = (day.src && day.src.generated) || 0;
    const missing = day.cov.filter((c, h) =>
      c < R.cov_min && new Date(`${date}T${String(h).padStart(2, '0')}:00:00`).getTime() / 1000 <= gen).length;
    $('rush-day-result').textContent = `${date} · ${S.ap} · ${arr} arrivals · ${dep} departures` +
      (missing ? ` · ${missing} h missing` : '') + (day.cs_hist ? '' : ' · flight numbers approximate');
    drawStrip($('rush-day-strip'), ops);
    const tb = $('rush-day-table').querySelector('tbody');
    tb.innerHTML = ops.slice(0, 400).map(o =>
      `<tr><td>${clock(o[0])}</td>` +
      `<td>${esc(o[3] || o[5])}</td><td><span class="rush-sw" style="background:${o[2] === 'A' ? BLUE : ORANGE}"></span>${o[2] === 'A' ? 'arr' : 'dep'}</td>` +
      `<td>${o[6] || '—'}</td><td>${esc(o[4] || '—')}</td><td>${o[7] != null ? o[7].toLocaleString() + ' ft' : '—'}</td></tr>`
    ).join('');
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
      return `<strong>${esc(o[3] || o[5])}</strong> ${o[2] === 'A' ? 'arrival' : 'departure'} ${clock(o[0])}<br>${esc(o[4] || '')}${o[6] ? ' · RWY ' + o[6] : ''}` +
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
