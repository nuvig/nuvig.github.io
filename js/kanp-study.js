// KANP Flight Tracker — Traffic Study tab
// Aggregate statistics from the Pi collector database.

const KANPStudy = (() => {
  let lastParams = null;

  function init() {
    KANP.initFilterBar('study-filters');
    document.getElementById('study-load').addEventListener('click', run);
    document.getElementById('study-export').addEventListener('click', exportCsv);
    window.addEventListener('resize', () => { if (lastStats) render(lastStats); });
  }

  let lastStats = null;

  async function run() {
    const btn = document.getElementById('study-load');
    const out = document.getElementById('study-result');
    btn.disabled = true;
    out.textContent = 'Crunching…';
    try {
      lastParams = KANP.readFilters('study-filters');
      const stats = await KANP.apiFetch('/api/stats', lastParams);
      lastStats = stats;
      render(stats);
      const days = Math.max(1, (stats.end - stats.start) / 86400);
      out.textContent =
        `${Number(stats.totals.aircraft).toLocaleString()} unique aircraft, ` +
        `${Number(stats.totals.samples).toLocaleString()} position reports over ` +
        `${days < 2 ? days.toFixed(1) : Math.round(days)} days`;
    } catch (e) {
      out.innerHTML = `<span class="err">${e.message}</span>`;
    } finally {
      btn.disabled = false;
    }
  }

  function exportCsv() {
    const base = KANP.apiBase();
    const out = document.getElementById('study-result');
    if (!base) {
      out.innerHTML = '<span class="err">No Pi API configured — set it under Data Source below</span>';
      return;
    }
    const params = KANP.readFilters('study-filters');
    const url = new URL(base + '/api/export.csv');
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    window.open(url, '_blank');
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

    let busiest = { d: '—', ac: 0 };
    s.daily.forEach(d => { if (d.ac > busiest.ac) busiest = d; });
    document.getElementById('sc-busiest').textContent = busiest.ac || '–';
    document.getElementById('sc-busiest-lbl').textContent =
      busiest.ac ? `busiest day (${busiest.d})` : 'busiest day';

    // ---- hour × dow grid ----
    KANP.renderGrid(document.getElementById('study-grid'), s.grid_unique_aircraft);

    // ---- daily bars ----
    drawBars(
      document.getElementById('study-daily'),
      s.daily.map(d => d.d.slice(5)),  // MM-DD
      s.daily.map(d => d.ac),
      { maxTicks: 14 },
    );

    // ---- altitude histogram ----
    drawBars(
      document.getElementById('study-alt'),
      s.altitude_histogram.map(b => b.bucket >= 1000 ? `${b.bucket / 1000}k` : b.bucket),
      s.altitude_histogram.map(b => b.samples),
      {
        maxTicks: 20,
        color: i => KANP.altColor(s.altitude_histogram[i].bucket + 250, false),
      },
    );

    // ---- top aircraft table ----
    const tbody = document.querySelector('#study-top tbody');
    tbody.innerHTML = '';
    s.top_aircraft.forEach(a => {
      const tr = document.createElement('tr');
      const alt = a.min_alt != null && a.max_alt != null
        ? `${fmtAlt(a.min_alt)}–${fmtAlt(a.max_alt)}` : '—';
      const cells = [
        (a.reg || a.hex) + (a.military ? '<span class="mil-tag">MIL</span>' : ''),
        a.type || '—',
        (a.callsigns || '—').split(',').slice(0, 3).join(', '),
        a.hex,
        Number(a.samples).toLocaleString(),
        alt,
        a.min_dist != null ? `${a.min_dist.toFixed(1)} nm` : '—',
        new Date(a.last_ts * 1000).toLocaleString(),
      ];
      tr.innerHTML = cells.map(c => `<td>${c}</td>`).join('');
      tbody.appendChild(tr);
    });
  }

  function fmtAlt(a) {
    return a >= 1000 ? `${(a / 1000).toFixed(1)}k` : String(a);
  }

  // simple canvas bar chart
  function drawBars(canvas, labels, values, opts = {}) {
    const W = canvas.parentElement.clientWidth || 620;
    const H = 160;
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);

    if (!values.length) {
      ctx.fillStyle = '#444';
      ctx.font = '13px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('no data in range', W / 2, H / 2);
      return;
    }

    const PAD_L = 44, PAD_B = 22, PAD_T = 8;
    const plotW = W - PAD_L - 6;
    const plotH = H - PAD_T - PAD_B;
    const maxV = Math.max(1, ...values);
    const bw = plotW / values.length;

    // y grid + labels
    ctx.strokeStyle = '#2a2a2a';
    ctx.fillStyle = '#666';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) {
      const v = maxV * i / 4;
      const y = PAD_T + plotH - plotH * i / 4;
      ctx.beginPath();
      ctx.moveTo(PAD_L, y);
      ctx.lineTo(W - 6, y);
      ctx.stroke();
      ctx.fillText(Math.round(v).toLocaleString(), PAD_L - 5, y);
    }

    // bars
    for (let i = 0; i < values.length; i++) {
      const h = plotH * values[i] / maxV;
      ctx.fillStyle = opts.color ? opts.color(i) : '#4a9eff';
      ctx.fillRect(PAD_L + i * bw + 1, PAD_T + plotH - h, Math.max(1, bw - 2), h);
    }

    // x labels (sparse)
    const every = Math.ceil(labels.length / (opts.maxTicks || 12));
    ctx.fillStyle = '#666';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let i = 0; i < labels.length; i += every) {
      ctx.fillText(String(labels[i]), PAD_L + i * bw + bw / 2, PAD_T + plotH + 5);
    }
  }

  return { init };
})();
