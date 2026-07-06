// KANP Flight Tracker — Runway operations analysis (Traffic Study tab)
//
// Detects individual operations (arrivals, departures, touch-and-gos) from
// track geometry near the field, and attributes each to a runway end (12/30)
// and, where possible, a pattern side (left/right traffic).
//
// Method: within each aircraft track, find contiguous "at the field" segments
// — points inside NEAR_NM of the field that are on the ground or at/below
// LOW_FT. Each segment is one field contact. Airborne context before/after
// the segment decides its kind:
//   airborne before + after  -> touch-and-go (or low pass / stop-and-go)
//   airborne before only     -> arrival
//   airborne after only      -> departure
//   neither                  -> unclassified (ADS-B coverage gap)
// FAA counting: a touch-and-go is 2 operations (one landing + one takeoff).
//
// Runway end comes from the mean ground course through the segment vs the
// runway axis (KANP.RWY.axisTrue). Pattern side comes from the mean signed
// cross-track offset of pattern-altitude points around the segment: traffic
// keeping left of the landing direction (downwind offset to the left) flies
// a left-hand pattern.

const KANPOps = (() => {
  // Gates chosen so pattern legs stay "airborne": KANP TPA is ~1,000 ft MSL
  // and the downwind is flown ~0.8-1.5 nm out, so "at the field" must be
  // tighter than that — only short final / the runway / initial upwind hit
  // both gates (field elevation is 34 ft).
  const NEAR_NM = 0.8;      // "at the field" horizontal gate
  const LOW_FT = 600;       // "at the field" altitude gate, ft MSL
  const GAP_S = 300;        // max time gap inside one field-contact segment
  const CONTEXT_S = 900;    // how far before/after to look for airborne context
  const R_EARTH_NM = 3440.065;

  let lastOps = null;       // cached analysis for re-render on resize

  document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('ops-load');
    if (!btn) return;
    btn.addEventListener('click', run);
    window.addEventListener('resize', () => { if (lastOps) render(lastOps); });
  });

  async function run() {
    const btn = document.getElementById('ops-load');
    const out = document.getElementById('ops-result');
    btn.disabled = true;
    out.textContent = 'Fetching tracks near the field…';
    try {
      // Same filters as the study, but forced to keep the low/ground data the
      // detector needs, and trimmed to the field area to stay light.
      const p = KANP.readFilters('study-filters');
      delete p.min_alt;
      delete p.max_alt;
      p.ground = 'include';
      p.max_dist = 4;
      p.max_alt = 3500;
      p.max_points = 400000;
      const d = await KANP.getTracks(p);
      out.textContent = 'Analyzing…';
      const a = analyze(d);
      lastOps = a;
      render(a);
      const days = Math.max(1, (d.end - d.start) / 86400);
      const stride = d.stride > 1
        ? ` · <span class="warn">position data thinned ×${d.stride}, counts may undercount</span>` : '';
      out.innerHTML =
        `<strong>${a.totalOps.toLocaleString()}</strong> operations ` +
        `(${a.counts.arr} arrivals, ${a.counts.dep} departures, ${a.counts.tng} touch-and-gos` +
        `${a.counts.unk ? `, ${a.counts.unk} unclassified` : ''}) over ` +
        `${days < 2 ? days.toFixed(1) : Math.round(days)} days · ${KANP.sourceLabel(d)}${stride}`;
    } catch (e) {
      out.innerHTML = `<span class="err">${e.message}</span>`;
    } finally {
      btn.disabled = false;
    }
  }

  // ---- geometry helpers ----
  function toXY(lat, lon) {
    const r = Math.PI / 180;
    return {
      x: (lon - KANP.LON) * r * R_EARTH_NM * Math.cos(KANP.LAT * r),  // east nm
      y: (lat - KANP.LAT) * r * R_EARTH_NM,                            // north nm
    };
  }

  function courseDeg(p0, p1) {
    const a = toXY(p0[1], p0[2]), b = toXY(p1[1], p1[2]);
    const dx = b.x - a.x, dy = b.y - a.y;
    if (Math.hypot(dx, dy) < 0.02) return null;  // too close, noisy
    return (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
  }

  // ---- detection ----
  function analyze(d) {
    const ops = [];
    for (const t of d.tracks) {
      const pts = t.points;
      const atField = pts.map(p =>
        (p[5] === 1 || (p[3] != null && p[3] <= LOW_FT)) &&
        KANP.distNm(p[1], p[2]) <= NEAR_NM);

      // contiguous at-field segments (runs of consecutive at-field points;
      // an airborne point in between, or a long gap, starts a new contact)
      const segs = [];
      for (let i = 0; i < pts.length; i++) {
        if (!atField[i]) continue;
        const last = segs[segs.length - 1];
        if (last && last.i1 === i - 1 && pts[i][0] - pts[last.i1][0] <= GAP_S) {
          last.i1 = i;
        } else {
          segs.push({ i0: i, i1: i });
        }
      }

      for (const s of segs) {
        const t0 = pts[s.i0][0], t1 = pts[s.i1][0];

        // airborne-away context before / after
        let prevAir = false, nextAir = false;
        for (let k = s.i0 - 1; k >= 0 && pts[k][0] >= t0 - CONTEXT_S; k--) {
          if (isAway(pts[k])) { prevAir = true; break; }
        }
        for (let k = s.i1 + 1; k < pts.length && pts[k][0] <= t1 + CONTEXT_S; k++) {
          if (isAway(pts[k])) { nextAir = true; break; }
        }
        const kind = prevAir && nextAir ? 'tng'
          : prevAir ? 'arr' : nextAir ? 'dep' : 'unk';

        // taxi-only / parked transponders: ground points, no airborne context,
        // nothing low in the air inside the segment — not an operation.
        if (kind === 'unk') {
          let segHasAir = false;
          for (let k = s.i0; k <= s.i1; k++) {
            if (pts[k][5] !== 1 && pts[k][3] != null) { segHasAir = true; break; }
          }
          if (!segHasAir) continue;
        }

        // runway end from mean course through the segment (incl. one point
        // either side, so single-point touches still get a direction)
        let sx = 0, sy = 0;
        const c0 = Math.max(0, s.i0 - 1), c1 = Math.min(pts.length - 1, s.i1 + 1);
        for (let k = c0; k < c1; k++) {
          const c = courseDeg(pts[k], pts[k + 1]);
          if (c == null) continue;
          const r = c * Math.PI / 180;
          sx += Math.sin(r); sy += Math.cos(r);
        }
        let rwy = null;
        if (sx || sy) {
          const mean = Math.atan2(sx, sy) * 180 / Math.PI;
          const diff = Math.cos((mean - KANP.RWY.axisTrue) * Math.PI / 180);
          rwy = diff >= 0 ? KANP.RWY.names[0] : KANP.RWY.names[1];
        }

        // pattern side: signed cross-track of pattern-altitude points around
        // this contact, relative to the landing direction of the active runway
        let side = null;
        if (rwy) {
          const theta = (rwy === KANP.RWY.names[0]
            ? KANP.RWY.axisTrue : KANP.RWY.axisTrue + 180) * Math.PI / 180;
          const ux = Math.sin(theta), uy = Math.cos(theta);
          let sum = 0, n = 0;
          for (const p of pts) {
            if (p[0] < t0 - 480 || p[0] > t1 + 480) continue;
            if (p[5] === 1 || p[3] == null || p[3] < 300 || p[3] > 1800) continue;
            const dist = KANP.distNm(p[1], p[2]);
            if (dist < 0.6 || dist > 3.5) continue;
            const xy = toXY(p[1], p[2]);
            sum += ux * xy.y - uy * xy.x;   // + = left of landing direction
            n++;
          }
          if (n >= 4 && Math.abs(sum / n) > 0.2) side = sum > 0 ? 'L' : 'R';
        }

        ops.push({
          ts: t0, hex: t.hex, reg: t.reg, type: t.type,
          military: t.military, kind, rwy, side,
        });
      }
    }

    function isAway(p) {
      if (p[5] === 1) return false;
      const dist = KANP.distNm(p[1], p[2]);
      return dist > NEAR_NM || (p[3] != null && p[3] > LOW_FT + 200);
    }

    // ---- aggregate ----
    const counts = { arr: 0, dep: 0, tng: 0, unk: 0 };
    ops.forEach(o => counts[o.kind]++);
    const opWeight = o => o.kind === 'tng' ? 2 : 1;
    const totalOps = ops.reduce((n, o) => n + opWeight(o), 0);

    return { ops, counts, totalOps, opWeight, start: d.start, end: d.end };
  }

  // ---- rendering ----
  function render(a) {
    document.getElementById('ops-out').style.display = '';
    const { ops, counts, totalOps, opWeight } = a;

    const days = Math.max(1, Math.round((a.end - a.start) / 86400));
    setNum('oc-total', totalOps.toLocaleString());
    setNum('oc-perday', (totalOps / days).toFixed(1));
    setNum('oc-arr', counts.arr.toLocaleString());
    setNum('oc-dep', counts.dep.toLocaleString());
    setNum('oc-tng', counts.tng.toLocaleString());

    // runway usage + pattern side
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
    setNum('oc-rwy', wTotal ? `${pct(KANP.RWY.names[1])}%` : '–');
    document.getElementById('oc-rwy-lbl').textContent =
      `ops on RWY ${KANP.RWY.names[1]}`;

    const rwyHtml = KANP.RWY.names.map(r => {
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
    }).join('');
    document.getElementById('ops-rwy').innerHTML = wTotal
      ? rwyHtml
      : '<div class="empty-history">no runway direction data in range</div>';

    // ops per day, stacked arrivals / departures / touch-and-gos
    const byDay = new Map();
    const dayKey = ts => {
      const d = new Date(ts * 1000);
      const p = n => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
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
      document.getElementById('ops-daily'),
      dayKeys.map(k => k.slice(5)),
      dayKeys.map(k => byDay.get(k)),
      { maxTicks: 14, height: 150,
        stackColors: ['#4a9eff', '#22c55e', '#f0c040', '#666'] },
    );

    // ops by hour of day
    const byHour = new Array(24).fill(0);
    ops.forEach(o => { byHour[new Date(o.ts * 1000).getHours()] += opWeight(o); });
    KANP.drawBars(
      document.getElementById('ops-hourly'),
      byHour.map((_, h) => h === 0 ? '12a' : h < 12 ? `${h}a` : h === 12 ? '12p' : `${h - 12}p`),
      byHour,
      { maxTicks: 12, height: 150 },
    );

    // most operations per aircraft
    const byAc = new Map();
    ops.forEach(o => {
      let e = byAc.get(o.hex);
      if (!e) {
        e = { hex: o.hex, reg: o.reg, type: o.type, military: o.military,
              arr: 0, dep: 0, tng: 0, ops: 0 };
        byAc.set(o.hex, e);
      }
      if (o.kind !== 'unk') e[o.kind]++;
      e.ops += opWeight(o);
    });
    const rows = [...byAc.values()].sort((x, y) => y.ops - x.ops).slice(0, 10);
    const tbody = document.querySelector('#ops-top tbody');
    tbody.innerHTML = '';
    rows.forEach(e => {
      const tr = document.createElement('tr');
      const reg = `<a href="https://globe.adsbexchange.com/?icao=${encodeURIComponent(e.hex)}"` +
        ` target="_blank" rel="noopener">${e.reg || e.hex}</a>` +
        (e.military ? '<span class="mil-tag">MIL</span>' : '');
      tr.innerHTML = [reg, e.type || '—', e.arr, e.dep, e.tng, e.ops]
        .map(c => `<td>${c}</td>`).join('');
      tbody.appendChild(tr);
    });
  }

  function setNum(id, v) {
    document.getElementById(id).textContent = v;
  }

  return {};
})();
