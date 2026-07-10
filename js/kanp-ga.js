// KANP Flight Tracker — GA ops tab
// Lee Airport operations flown by general aviation: the same detector the
// Traffic Study uses (kanp-ops.js), restricted to GA aircraft (KANP.isGA —
// everything that isn't a scheduled airliner, large transport or military).
//
// "Pattern ops" are the detector's 'tng' contacts: a field contact with
// airborne flight before and after it. Touch-and-gos are not permitted at
// KANP, so these are full-stop taxi-backs (or go-arounds when the aircraft
// never touched down). FAA counting weights them as 2 operations.

const KANPGA = (() => {
  let lastAnalysis = null;   // cached for re-render on resize

  function init() {
    const btn = document.getElementById('ga-load');
    if (!btn) return;
    KANP.initFilterBar('ga-filters');
    btn.addEventListener('click', run);
    window.addEventListener('resize', () => { if (lastAnalysis) render(lastAnalysis); });
  }

  async function run() {
    const btn = document.getElementById('ga-load');
    const out = document.getElementById('ga-result');
    btn.disabled = true;
    out.textContent = 'Fetching GA tracks near the field…';
    try {
      // Same shape as the Traffic Study's ops fetch: keep the low/ground fixes
      // the detector needs, trimmed to the field area to stay light.
      const p = KANP.readFilters('ga-filters');
      p.ga = 1;
      p.ground = 'include';
      p.max_dist = 4;
      p.max_alt = 3500;
      p.max_points = 400000;
      const d = await KANP.getTracks(p);

      out.textContent = 'Analyzing…';
      const a = analyze(d);
      lastAnalysis = a;
      render(a);

      const days = Math.max(1, (d.end - d.start) / 86400);
      const dense = d.dense
        ? ' · <span class="warn">large range — counts may be approximate; narrow it for accuracy</span>' : '';
      out.innerHTML = a.totalOps
        ? `<strong>${a.totalOps.toLocaleString()}</strong> GA operations ` +
          `(${a.counts.arr} arrivals, ${a.counts.dep} departures, ${a.counts.tng} pattern ops` +
          `${a.counts.unk ? `, ${a.counts.unk} unclassified` : ''}) by ` +
          `${a.aircraft.toLocaleString()} aircraft over ` +
          `${days < 2 ? days.toFixed(1) : Math.round(days)} days · ${KANP.sourceLabel(d)}${dense}`
        : `No GA operations detected in this range · ${KANP.sourceLabel(d)}`;
    } catch (e) {
      out.innerHTML = `<span class="err">${e.message}</span>`;
    } finally {
      btn.disabled = false;
    }
  }

  // The detector already returns per-op kind / runway / side; GA filtering
  // happened server-side (or in the snapshot filter) via the ga=1 param.
  function analyze(d) {
    const { ops, counts, totalOps, opWeight } = KANPOps.analyze(d);
    return {
      ops, counts, totalOps, opWeight,
      aircraft: new Set(ops.map(o => o.hex)).size,
      start: d.start, end: d.end,
    };
  }

  function render(a) {
    document.getElementById('ga-out').style.display = a.totalOps ? '' : 'none';
    if (!a.totalOps) return;
    const { ops, counts, totalOps, opWeight } = a;

    const days = Math.max(1, Math.round((a.end - a.start) / 86400));
    setNum('ga-total', totalOps.toLocaleString());
    setNum('ga-perday', (totalOps / days).toFixed(1));
    setNum('ga-arr', counts.arr.toLocaleString());
    setNum('ga-dep', counts.dep.toLocaleString());
    setNum('ga-pattern', counts.tng.toLocaleString());
    setNum('ga-aircraft', a.aircraft.toLocaleString());

    // ---- hour × day-of-week grid of operations ----
    const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
    ops.forEach(o => {
      const dt = new Date(o.ts * 1000);
      grid[(dt.getDay() + 6) % 7][dt.getHours()] += opWeight(o);
    });
    KANP.renderGrid(document.getElementById('ga-grid'), grid, { unit: 'GA ops' });
    document.getElementById('ga-grid-label').textContent =
      `${totalOps.toLocaleString()} ops · ${a.aircraft.toLocaleString()} aircraft`;

    // ---- runway usage + pattern side ----
    const w = { [KANP.RWY.names[0]]: 0, [KANP.RWY.names[1]]: 0 };
    const sides = {};
    KANP.RWY.names.forEach(r => { sides[r] = { L: 0, R: 0 }; });
    ops.forEach(o => {
      if (!o.rwy) return;
      w[o.rwy] += opWeight(o);
      if (o.side) sides[o.rwy][o.side]++;
    });
    const wTotal = w[KANP.RWY.names[0]] + w[KANP.RWY.names[1]];
    const pct = r => wTotal ? Math.round(100 * w[r] / wTotal) : 0;
    document.getElementById('ga-rwy').innerHTML = wTotal
      ? KANP.RWY.names.map(r => {
          const s = sides[r], ns = s.L + s.R;
          const sideTxt = ns >= 3
            ? ` · pattern: ${Math.round(100 * s.L / ns)}% left / ${Math.round(100 * s.R / ns)}% right traffic`
            : '';
          return `<div class="rwy-row">
            <span class="rwy-name">RWY ${r}</span>
            <span class="rwy-bar"><span style="width:${pct(r)}%"></span></span>
            <span class="rwy-pct">${pct(r)}%</span>
            <span class="rwy-side">${sideTxt}</span>
          </div>`;
        }).join('')
      : '<div class="empty-history">no runway direction data in range</div>';

    // ---- ops per day, stacked arr / dep / pattern / unclassified ----
    const byDay = new Map();
    const dayKey = ts => {
      const dt = new Date(ts * 1000);
      const p = n => String(n).padStart(2, '0');
      return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
    };
    ops.forEach(o => {
      const k = dayKey(o.ts);
      if (!byDay.has(k)) byDay.set(k, [0, 0, 0, 0]);
      const row = byDay.get(k);
      if (o.kind === 'arr') row[0]++;
      else if (o.kind === 'dep') row[1]++;
      else if (o.kind === 'tng') row[2] += 2;
      else row[3]++;
    });
    const dayKeys = [...byDay.keys()].sort();
    KANP.drawBars(
      document.getElementById('ga-daily'),
      dayKeys.map(k => k.slice(5)),
      dayKeys.map(k => byDay.get(k)),
      { maxTicks: 14, height: 150, stackColors: ['#4a9eff', '#22c55e', '#f0c040', '#666'] },
    );

    // ---- ops by hour of day ----
    const byHour = new Array(24).fill(0);
    ops.forEach(o => { byHour[new Date(o.ts * 1000).getHours()] += opWeight(o); });
    KANP.drawBars(
      document.getElementById('ga-hourly'),
      byHour.map((_, h) => h === 0 ? '12a' : h < 12 ? `${h}a` : h === 12 ? '12p' : `${h - 12}p`),
      byHour,
      { maxTicks: 12, height: 150 },
    );

    // ---- busiest GA aircraft ----
    const byAc = new Map();
    ops.forEach(o => {
      let e = byAc.get(o.hex);
      if (!e) {
        e = { hex: o.hex, reg: o.reg, type: o.type, arr: 0, dep: 0, tng: 0, ops: 0 };
        byAc.set(o.hex, e);
      }
      if (o.kind !== 'unk') e[o.kind]++;
      e.ops += opWeight(o);
    });
    const rows = [...byAc.values()].sort((x, y) => y.ops - x.ops).slice(0, 15);
    const tbody = document.querySelector('#ga-top tbody');
    tbody.innerHTML = '';
    rows.forEach(e => {
      const tr = document.createElement('tr');
      const reg = `<a href="https://globe.adsbexchange.com/?icao=${encodeURIComponent(e.hex)}"` +
        ` target="_blank" rel="noopener">${e.reg || e.hex}</a>`;
      tr.innerHTML = [reg, e.type || '—', e.arr, e.dep, e.tng, e.ops]
        .map(c => `<td>${c}</td>`).join('');
      tbody.appendChild(tr);
    });
  }

  function setNum(id, v) {
    document.getElementById(id).textContent = v;
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', () => {
  try { KANPGA.init(); } catch (e) { console.error('[KANP] GA ops init failed:', e); }
});
