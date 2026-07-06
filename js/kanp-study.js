// KANP Flight Tracker â€” Traffic Study tab
// Aggregate statistics from the Pi collector database.

const KANPStudy = (() => {
  let lastParams = null;
  let lastStats = null;
  let gridMetric = 'ac';                    // 'ac' | 'samples'
  let sortKey = 'samples', sortDesc = true; // aircraft table sort

  const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const hourLabel = h => h === 0 ? '12a' : h < 12 ? `${h}a` : h === 12 ? '12p' : `${h - 12}p`;

  function init() {
    KANP.initFilterBar('study-filters');
    document.getElementById('study-load').addEventListener('click', run);
    document.getElementById('study-export').addEventListener('click', exportCsv);
    window.addEventListener('resize', () => { if (lastStats) render(lastStats); });

    document.querySelectorAll('#grid-toggle .mini-btn').forEach(btn =>
      btn.addEventListener('click', () => {
        gridMetric = btn.dataset.metric;
        document.querySelectorAll('#grid-toggle .mini-btn').forEach(b =>
          b.classList.toggle('on', b === btn));
        if (lastStats) renderGrid(lastStats);
      }));

    document.querySelectorAll('#study-top th').forEach(th =>
      th.addEventListener('click', () => {
        const k = th.dataset.k;
        if (!k) return;
        if (sortKey === k) sortDesc = !sortDesc;
        else { sortKey = k; sortDesc = k !== 'reg' && k !== 'type' && k !== 'hex'; }
        if (lastStats) renderTable(lastStats);
      }));
  }

  async function run() {
    const btn = document.getElementById('study-load');
    const out = document.getElementById('study-result');
    btn.disabled = true;
    out.textContent = 'Crunchingâ€¦';
    try {
      lastParams = KANP.readFilters('study-filters');
      const stats = await KANP.getStats(lastParams);
      lastStats = stats;
      render(stats);
      const days = Math.max(1, (stats.end - stats.start) / 86400);
      out.textContent =
        `${Number(stats.totals.aircraft).toLocaleString()} unique aircraft, ` +
        `${Number(stats.totals.samples).toLocaleString()} position reports over ` +
        `${days < 2 ? days.toFixed(1) : Math.round(days)} days Â· ${KANP.sourceLabel(stats)}`;
    } catch (e) {
      out.innerHTML = `<span class="err">${e.message}</span>`;
    } finally {
      btn.disabled = false;
    }
  }

  async function exportCsv() {
    const base = KANP.apiBase();
    const out = document.getElementById('study-result');
    const params = KANP.readFilters('study-filters');
    if (base) {
      // full-resolution export straight from the Pi database
      const url = new URL(base + '/api/export.csv');
      Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
      window.open(url, '_blank');
      return;
    }
    // remote: build a CSV in the browser from the GitHub snapshots
    out.textContent = 'Building CSV from snapshotsâ€¦';
    try {
      await KANPStatic.exportCsv(params);
      out.textContent = 'CSV downloaded (snapshot resolution)';
    } catch (e) {
      out.innerHTML = `<span class="err">${e.message}</span>`;
    }
  }

  function render(s) {
    document.getElementById('study-cards').style.display = '';
    document.getElementById('study-charts').style.display = '';

    // ---- summary cards ----
    document.getElementById('sc-aircraft').textContent =
      Number(s.totals.aircraft).toLocaleString();
    document.getElementById('sc-samples').textContent =
      Number(s.totals.samples).toLocaleString();

    const activeDays = s.daily.length || 1;
    const perDay = s.daily.reduce((n, d) => n + d.ac, 0) / activeDays;
    document.getElementById('sc-perday').textContent = perDay.toFixed(1);

    let busiest = { d: 'â€”', ac: 0 };
    s.daily.forEach(d => { if (d.ac > busiest.ac) busiest = d; });
    document.getElementById('sc-busiest').textContent = busiest.ac || 'â€“';
    document.getElementById('sc-busiest-lbl').textContent =
      busiest.ac ? `busiest day (${busiest.d})` : 'busiest day';

    // peak hour + weekend share, both from the hour Ã— dow grid
    const grid = s.grid_unique_aircraft;
    let peak = { d: 0, h: 0, v: 0 }, weekend = 0, total = 0;
    for (let d = 0; d < 7; d++) {
      for (let h = 0; h < 24; h++) {
        const v = grid[d][h];
        total += v;
        if (d >= 5) weekend += v;
        if (v > peak.v) peak = { d, h, v };
      }
    }
    document.getElementById('sc-peakhour').textContent = peak.v || 'â€“';
    document.getElementById('sc-peakhour-lbl').textContent =
      peak.v ? `peak hour (${DAYS[peak.d]} ${hourLabel(peak.h)})` : 'peak hour';
    document.getElementById('sc-weekend').textContent =
      total ? `${Math.round(100 * weekend / total)}%` : 'â€“';

    // ---- hour Ã— dow grid (with metric toggle when samples grid exists) ----
    document.getElementById('grid-toggle').style.display =
      s.grid_samples ? '' : 'none';
    if (!s.grid_samples) gridMetric = 'ac';
    renderGrid(s);

    // ---- hour-of-day / day-of-week profiles (derived from the grid) ----
    const hourly = Array.from({ length: 24 }, (_, h) =>
      grid.reduce((n, row) => n + row[h], 0));
    KANP.drawBars(
      document.getElementById('study-hourly'),
      hourly.map((_, h) => hourLabel(h)), hourly,
      { maxTicks: 12, height: 150 },
    );
    const byDow = grid.map(row => row.reduce((a, b) => a + b, 0));
    KANP.drawBars(
      document.getElementById('study-dow'), DAYS, byDow,
      { maxTicks: 7, height: 150, color: i => i >= 5 ? '#f0c040' : '#4a9eff' },
    );

    // ---- daily bars ----
    KANP.drawBars(
      document.getElementById('study-daily'),
      s.daily.map(d => d.d.slice(5)),  // MM-DD
      s.daily.map(d => d.ac),
      { maxTicks: 14 },
    );

    // ---- altitude histogram ----
    KANP.drawBars(
      document.getElementById('study-alt'),
      s.altitude_histogram.map(b => b.bucket >= 1000 ? `${b.bucket / 1000}k` : b.bucket),
      s.altitude_histogram.map(b => b.samples),
      {
        maxTicks: 20,
        color: i => KANP.altColor(s.altitude_histogram[i].bucket + 250, false),
      },
    );

    // ---- aircraft types ----
    renderTypes(s);

    // ---- top aircraft table ----
    renderTable(s);
  }

  function renderGrid(s) {
    const grid = gridMetric === 'samples' && s.grid_samples
      ? s.grid_samples : s.grid_unique_aircraft;
    document.getElementById('study-grid-title').textContent =
      (gridMetric === 'samples' ? 'Position reports' : 'Unique aircraft') +
      ' â€” hour of day Ã— day of week';
    KANP.renderGrid(document.getElementById('study-grid'), grid);
  }

  function renderTypes(s) {
    const note = document.getElementById('study-types-note');
    let types = s.types;
    if (!types) {
      // older Pi API: approximate from the top-aircraft list
      const m = new Map();
      (s.top_aircraft || []).forEach(a => {
        const t = a.type || '?';
        m.set(t, (m.get(t) || 0) + 1);
      });
      types = [...m.entries()].map(([type, ac]) => ({ type, ac }))
        .sort((a, b) => b.ac - a.ac);
      note.textContent = 'Â· unique aircraft per type (top 25 aircraft only â€” update the Pi server for full data)';
    } else {
      note.textContent = 'Â· unique aircraft per type';
    }
    types = types.slice(0, 20);
    KANP.drawBars(
      document.getElementById('study-types'),
      types.map(t => t.type || '?'),
      types.map(t => t.ac),
      { maxTicks: 20 },
    );
  }

  function renderTable(s) {
    const rows = [...(s.top_aircraft || [])];
    const dir = sortDesc ? -1 : 1;
    rows.sort((a, b) => {
      let va = a[sortKey], vb = b[sortKey];
      if (sortKey === 'reg') { va = a.reg || a.hex; vb = b.reg || b.hex; }
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === 'string') return va.localeCompare(vb) * dir;
      return (va - vb) * dir;
    });

    // sort indicator
    document.querySelectorAll('#study-top th').forEach(th => {
      const base = th.textContent.replace(/ [â–¾â–´]$/, '');
      th.textContent = th.dataset.k === sortKey ? `${base} ${sortDesc ? 'â–¾' : 'â–´'}` : base;
    });

    const tbody = document.querySelector('#study-top tbody');
    tbody.innerHTML = '';
    rows.forEach(a => {
      const tr = document.createElement('tr');
      const alt = a.min_alt != null && a.max_alt != null
        ? `${fmtAlt(a.min_alt)}â€“${fmtAlt(a.max_alt)}` : 'â€”';
      const regLink =
        `<a href="https://globe.adsbexchange.com/?icao=${encodeURIComponent(a.hex)}" ` +
        `target="_blank" rel="noopener">${a.reg || a.hex}</a>`;
      const cells = [
        regLink + (a.military ? '<span class="mil-tag">MIL</span>' : ''),
        a.type || 'â€”',
        (a.callsigns || 'â€”').split(',').slice(0, 3).join(', '),
        a.hex,
        Number(a.samples).toLocaleString(),
        alt,
        a.min_dist != null ? `${a.min_dist.toFixed(1)} nm` : 'â€”',
        new Date(a.last_ts * 1000).toLocaleString(),
      ];
      tr.innerHTML = cells.map(c => `<td>${c}</td>`).join('');
      tbody.appendChild(tr);
    });
  }

  function fmtAlt(a) {
    return a >= 1000 ? `${(a / 1000).toFixed(1)}k` : String(a);
  }

  return { init };
})();
