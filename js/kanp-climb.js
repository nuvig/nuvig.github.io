// KANP Flight Tracker — Climb-out comparison (Traffic Study tab)
//
// Extracts the initial climb from every departure in the selected range and
// plots altitude gained vs distance flown from liftoff, so one aircraft's
// climb-out on a hot, high-density-altitude day can be compared against the
// same aircraft (and everyone else) on other days.
//
// Departure detection mirrors kanp-ops.js: an at-field segment (inside
// OPS_GATES) with airborne context after it is a departure (or the climb leg
// of a go-around — equally interesting here). The climb profile starts at the
// segment's last at-field point and follows the track while it keeps climbing.
//
// Altitudes are ADS-B barometric (pressure altitude). Fine for comparing
// gradients day-to-day; on a hot day the *true* geometric gradient is a bit
// different, but everyone in the plot is measured the same way.

const KANPClimb = (() => {
  const NEAR_NM = KANP.OPS_GATES.NEAR_NM;
  const LOW_FT = KANP.OPS_GATES.LOW_FT;
  const GAP_S = 300;        // max gap inside one field-contact segment
  const CONTEXT_S = 900;    // airborne-context window after the segment
  const CLIMB_GAP_S = 180;  // max gap between climb points before we cut off
  const MAX_GAIN = 1500;    // ft above liftoff: stop following the climb
  const MAX_DIST = 5;       // nm from liftoff: stop following the climb
  const LEVEL_OFF = 150;    // ft below running max = leveled/turning down: stop
  const MIN_GAIN = 400;     // profiles that never gained this much are dropped
  const GRAD_AT = 500;      // gradient is measured to this many ft of gain

  const PALETTE = ['#f0c040', '#ef4444', '#22c55e', '#4a9eff', '#c084fc',
                   '#fb923c', '#2dd4bf', '#f472b6'];

  let last = null;          // { profiles, hoverIdx } for re-render
  let plotGeom = null;      // screen-space geometry for hover hit-testing
  let staticLayer = null;   // offscreen copy of the chart without the glow line
  let avgLine = null;       // { pts: [[x, y]…], color } — smoothed mean of the highlighted reg
  let animId = null;        // rAF handle for the breathing glow
  let minClimbs = +localStorage.getItem('kanp_climb_min') || 1;   // ranking filter

  document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('climb-load');
    if (!btn) return;
    btn.addEventListener('click', () => run());
    window.addEventListener('resize', () => { if (last) renderChart(); });
    document.getElementById('climb-reg')
      .addEventListener('input', () => { if (last) renderAll(); });
    document.querySelectorAll('#climb-min .mini-btn').forEach(b => {
      b.classList.toggle('on', +b.dataset.min === minClimbs);
      b.addEventListener('click', () => {
        minClimbs = +b.dataset.min;
        localStorage.setItem('kanp_climb_min', minClimbs);
        document.querySelectorAll('#climb-min .mini-btn').forEach(x =>
          x.classList.toggle('on', x === b));
        if (last) { renderRank(); renderTypes(); }
      });
    });
    const canvas = document.getElementById('climb-chart');
    canvas.addEventListener('mousemove', onHover);
    canvas.addEventListener('mouseleave', () => setHover(null));
  });

  async function run(shared) {
    const btn = document.getElementById('climb-load');
    const out = document.getElementById('climb-result');
    btn.disabled = true;
    out.textContent = 'Extracting climb profiles…';
    try {
      const d = KANPStudy.clip(shared || await KANPStudy.data(), MAX_DIST + 1, 3500);
      const profiles = extract(d);
      last = { profiles, hoverIdx: null };
      if (!profiles.length) {
        stopGlow();
        document.getElementById('climb-out').style.display = 'none';
        out.textContent = 'No departures with usable climb data in this range.';
        return;
      }
      document.getElementById('climb-out').style.display = '';
      renderAll();
      out.innerHTML = `<strong>${profiles.length}</strong> climb-outs extracted`;
    } catch (e) {
      out.innerHTML = `<span class="err">${e.message}</span>`;
    } finally {
      btn.disabled = false;
    }
  }

  // ---- profile extraction ----
  function extract(d) {
    // ADS-B altitude is pressure altitude, so the field itself "reads"
    // several hundred ft high or low depending on the day's altimeter
    // setting. Estimate the field's pressure altitude per hour from every
    // aircraft's on-ground reports near the field; it baselines flights
    // whose own ground fixes were never received.
    const hourAlts = new Map();
    for (const t of d.tracks) {
      for (const p of t.points) {
        if (p[5] === 1 && p[3] != null && KANP.distNm(p[1], p[2]) <= NEAR_NM) {
          const h = Math.floor(p[0] / 3600);
          if (!hourAlts.has(h)) hourAlts.set(h, []);
          hourAlts.get(h).push(p[3]);
        }
      }
    }
    const hourBase = new Map();
    for (const [h, v] of hourAlts) {
      v.sort((a, b) => a - b);
      hourBase.set(h, v[Math.floor(v.length / 2)]);
    }
    const fieldPressureAlt = ts => {
      const h = Math.floor(ts / 3600);
      for (let dh = 0; dh <= 6; dh++) {           // nearest hour with data
        if (hourBase.has(h - dh)) return hourBase.get(h - dh);
        if (hourBase.has(h + dh)) return hourBase.get(h + dh);
      }
      return null;
    };

    const profiles = [];
    for (const t of d.tracks) {
      const pts = t.points;
      const atField = pts.map(p =>
        (p[5] === 1 || (p[3] != null && p[3] <= LOW_FT)) &&
        KANP.distNm(p[1], p[2]) <= NEAR_NM);

      // contiguous at-field segments, as in kanp-ops.js
      const segs = [];
      for (let i = 0; i < pts.length; i++) {
        if (!atField[i]) continue;
        const s = segs[segs.length - 1];
        if (s && s.i1 === i - 1 && pts[i][0] - pts[s.i1][0] <= GAP_S) s.i1 = i;
        else segs.push({ i0: i, i1: i });
      }

      for (const s of segs) {
        // needs airborne-away context after the segment (departure / go-around)
        let nextAir = false;
        const t1 = pts[s.i1][0];
        for (let k = s.i1 + 1; k < pts.length && pts[k][0] <= t1 + CONTEXT_S; k++) {
          if (isAway(pts[k])) { nextAir = true; break; }
        }
        if (!nextAir) continue;

        // liftoff reference altitude: this aircraft's own on-ground reports
        // in the field contact, else the hourly field pressure-altitude
        // estimate, else the lowest reported alt in the contact
        // Some transponders never set the on-ground flag (N3383A's, for one),
        // so a fix rolling slower than TAXI_KT counts as a ground report too.
        let base = null;
        const gAlts = [];
        for (let k = s.i0; k <= s.i1; k++) {
          if (onGround(pts[k]) && pts[k][3] != null) gAlts.push(pts[k][3]);
        }
        if (gAlts.length) {
          gAlts.sort((a, b) => a - b);
          base = gAlts[Math.floor(gAlts.length / 2)];
        } else {
          base = fieldPressureAlt(pts[s.i0][0]);
        }
        if (base == null) {
          for (let k = s.i0; k <= s.i1; k++) {
            if (pts[k][3] != null && (base == null || pts[k][3] < base)) base = pts[k][3];
          }
        }
        if (base == null) base = SITE.airport.elevFt;

        // follow the climb from the liftoff point: the last on-ground fix in
        // the contact if one was received, else the last at-field point —
        // this also anchors the distance origin at the actual liftoff
        // With no ground fix at all, the last at-field fix is the top of the
        // 600 ft gate, not the runway — that drew the climb starting 500 ft
        // up at 0 nm. Fall back to the lowest-altitude fix in the contact.
        let start = -1;
        for (let k = s.i1; k >= s.i0; k--) {
          if (onGround(pts[k])) { start = k; break; }
        }
        if (start < 0) {
          let lo = null;
          for (let k = s.i0; k <= s.i1; k++) {
            if (pts[k][3] != null && (lo == null || pts[k][3] < lo)) { lo = pts[k][3]; start = k; }
          }
          if (start < 0) start = s.i1;
        }
        const prof = [];
        let dist = 0, maxGain = 0, gsSum = 0, gsN = 0;
        for (let k = start; k < pts.length; k++) {
          const p = pts[k];
          if (k > start) {
            if (p[0] - pts[k - 1][0] > CLIMB_GAP_S) break;
            dist += hav(pts[k - 1], p);
          }
          if (p[3] == null) continue;
          const gain = p[3] - base;
          if (gain > maxGain) maxGain = gain;
          if (gain < maxGain - LEVEL_OFF) break;   // leveled off / descending
          prof.push({ d: dist, gain: Math.max(0, gain), ts: p[0] });
          if (p[4] != null && p[5] !== 1) { gsSum += p[4]; gsN++; }
          if (gain >= MAX_GAIN || dist >= MAX_DIST) break;
        }
        if (prof.length < 3 || maxGain < MIN_GAIN) continue;

        // runway end from the initial climb course vs the runway axis
        let rwy = null;
        const a = pts[s.i1], b = pts[Math.min(pts.length - 1, s.i1 + 2)];
        const crs = course(a, b);
        if (crs != null) {
          rwy = Math.cos((crs - KANP.RWY.axisTrue) * Math.PI / 180) >= 0
            ? KANP.RWY.names[0] : KANP.RWY.names[1];
        }

        // distance and time at GRAD_AT ft of gain (linear interpolation) —
        // gradient is gain over ground, rate is gain over the climb's own
        // clock, both from the same fixes
        let dAt = null, tAt = null;
        for (let i = 1; i < prof.length; i++) {
          if (prof[i].gain >= GRAD_AT && prof[i - 1].gain < GRAD_AT) {
            const a0 = prof[i - 1], a1 = prof[i];
            const f = (GRAD_AT - a0.gain) / (a1.gain - a0.gain || 1);
            dAt = a0.d + f * (a1.d - a0.d);
            tAt = (a0.ts + f * (a1.ts - a0.ts)) - prof[0].ts;
            break;
          }
        }
        const sane = dAt != null && dAt >= 0.2;

        profiles.push({
          ts: prof[0].ts, hex: t.hex, reg: t.reg || t.hex,
          flight: (t.flight || '').trim(), type: t.type, rwy,
          // < 0.2 nm to 500 ft (>2,500 ft/nm) is beyond any piston single —
          // a baro glitch or coverage gap near liftoff, not a real gradient
          points: prof, distTo500: dAt,
          grad: sane ? GRAD_AT / dAt : null,
          rate: sane && tAt > 0 ? GRAD_AT / (tAt / 60) : null,
          avgGs: gsN ? gsSum / gsN : null,
        });
      }
    }
    profiles.sort((a, b) => b.ts - a.ts);
    return profiles;
  }

  const TAXI_KT = 25;
  function onGround(p) {
    return p[5] === 1 || (p[4] != null && p[4] <= TAXI_KT);
  }

  function isAway(p) {
    if (p[5] === 1) return false;
    return KANP.distNm(p[1], p[2]) > NEAR_NM ||
      (p[3] != null && p[3] > LOW_FT + 200);
  }

  function hav(a, b) {
    const R = 3440.065, r = Math.PI / 180;
    const dLat = (b[1] - a[1]) * r, dLon = (b[2] - a[2]) * r;
    const s = Math.sin(dLat / 2) ** 2 +
      Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }

  function course(a, b) {
    const r = Math.PI / 180;
    const dx = (b[2] - a[2]) * Math.cos(a[1] * r), dy = b[1] - a[1];
    if (Math.hypot(dx, dy) < 1e-5) return null;
    return (Math.atan2(dx, dy) / r + 360) % 360;
  }

  // ---- highlight matching ----
  function highlightNeedle() {
    return (document.getElementById('climb-reg').value || '').trim().toUpperCase();
  }

  function isHighlighted(p) {
    const n = highlightNeedle();
    if (!n) return false;
    return (p.reg || '').toUpperCase().includes(n) ||
      (p.flight || '').toUpperCase().includes(n);
  }

  // ---- rendering ----
  function renderAll() {
    renderChart();
    renderRank();
    renderTypes();
    renderTable();
    renderSummary();
  }

  // by type: median gradient and rate over every climb of that type —
  // the fleet comparison (which airplanes climb better), best rate first
  function renderTypes() {
    const byType = new Map();
    for (const p of last.profiles) {
      if (p.grad == null) continue;
      const k = p.type || '—';
      let e = byType.get(k);
      if (!e) byType.set(k, e = { type: k, regs: new Set(), grads: [], rates: [] });
      e.regs.add(p.reg);
      e.grads.push(p.grad);
      if (p.rate != null) e.rates.push(p.rate);
    }
    const med = a => { const v = a.slice().sort((x, y) => x - y); return v.length ? v[Math.floor(v.length / 2)] : null; };
    const all = [...byType.values()].map(e => ({
      type: e.type, n: e.regs.size, climbs: e.grads.length,
      grad: med(e.grads), rate: med(e.rates),
    }));
    const rows = all.filter(e => e.climbs >= minClimbs)
      .sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1));
    document.getElementById('climb-types-note').textContent =
      all.length - rows.length ? `${all.length - rows.length} hidden` : '';
    const tbody = document.querySelector('#climb-types tbody');
    tbody.innerHTML = '';
    rows.forEach(e => {
      const tr = document.createElement('tr');
      tr.innerHTML = [
        e.type, e.n, e.climbs,
        Math.round(e.grad).toLocaleString(),
        e.rate != null ? Math.round(e.rate).toLocaleString() : '—',
      ].map(c => `<td>${c}</td>`).join('');
      tbody.appendChild(tr);
    });
  }

  // smoothed mean curve of the highlighted reg's climbs: gain sampled on a
  // 0.05 nm grid wherever at least a third of its climbs reach, then a
  // 5-point moving average. One line for the airplane, not one per flight.
  function meanCurve(profiles, X, Y, maxD) {
    const STEP = 0.05;
    const n = profiles.length;
    if (!n) return null;
    const raw = [];
    for (let d = 0; d <= maxD + 1e-9; d += STEP) {
      let sum = 0, cnt = 0;
      for (const p of profiles) {
        const pts = p.points;
        if (d < pts[0].d || d > pts[pts.length - 1].d) continue;
        for (let i = 1; i < pts.length; i++) {
          if (pts[i].d >= d) {
            const a = pts[i - 1], b = pts[i];
            const f = b.d > a.d ? (d - a.d) / (b.d - a.d) : 0;
            sum += a.gain + f * (b.gain - a.gain); cnt++;
            break;
          }
        }
      }
      if (cnt < Math.max(1, Math.ceil(n / 3))) { if (raw.length) break; else continue; }
      raw.push([d, sum / cnt]);
    }
    if (raw.length < 3) return null;
    const sm = raw.map(([d], i) => {
      let s = 0, c = 0;
      for (let j = Math.max(0, i - 2); j <= Math.min(raw.length - 1, i + 2); j++) { s += raw[j][1]; c++; }
      return [X(d), Y(s / c)];
    });
    return sm;
  }

  function stopGlow() {
    if (animId != null) { cancelAnimationFrame(animId); animId = null; }
  }

  // the breathing glow: blit the static chart, then the mean line with a
  // shadow whose blur and alpha ride a slow sine — only runs while a reg is
  // highlighted, and stops when the section is hidden or the data changes
  function paintGlow() {
    animId = null;
    const canvas = document.getElementById('climb-chart');
    if (!avgLine || !staticLayer || !canvas.isConnected ||
        document.getElementById('climb-out').style.display === 'none') return;
    if (canvas.offsetParent === null) {          // tab or section hidden: idle, recheck later
      setTimeout(() => { if (avgLine && animId == null) animId = requestAnimationFrame(paintGlow); }, 500);
      return;
    }
    const ctx = canvas.getContext('2d');
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(staticLayer, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const t = performance.now() / 1000;
    const b = 0.5 + 0.5 * Math.sin(t * Math.PI / 1.1);   // ~2.2 s breath
    ctx.save();
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.strokeStyle = avgLine.color;
    ctx.shadowColor = avgLine.color;
    ctx.shadowBlur = 6 + 14 * b;
    ctx.globalAlpha = 0.7 + 0.3 * b;
    ctx.lineWidth = 3.5;
    ctx.beginPath();
    avgLine.pts.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.restore();
    animId = requestAnimationFrame(paintGlow);
  }

  // per-aircraft ranking: median gradient across each tail number's climbs,
  // best performer first (climbs with no reliable gradient are excluded)
  function renderRank() {
    const byReg = new Map();
    for (const p of last.profiles) {
      if (p.grad == null) continue;
      let e = byReg.get(p.reg);
      if (!e) byReg.set(p.reg, e = { reg: p.reg, hex: p.hex, type: p.type, grads: [], rates: [] });
      e.grads.push(p.grad);
      if (p.rate != null) e.rates.push(p.rate);
    }
    const rows = [...byReg.values()].map(e => {
      const v = e.grads.slice().sort((a, b) => a - b);
      const r = e.rates.slice().sort((a, b) => a - b);
      return { ...e, n: v.length, median: v[Math.floor(v.length / 2)],
               best: v[v.length - 1], worst: v[0],
               medRate: r.length ? r[Math.floor(r.length / 2)] : null };
    }).filter(e => e.n >= minClimbs).sort((a, b) => b.median - a.median);
    document.getElementById('climb-rank-note').textContent =
      byReg.size - rows.length ? `${byReg.size - rows.length} hidden` : '';

    const tbody = document.querySelector('#climb-rank tbody');
    tbody.innerHTML = '';
    rows.forEach((e, i) => {
      const tr = document.createElement('tr');
      if (isHighlighted({ reg: e.reg, flight: '' })) tr.style.background = '#20304a';
      tr.style.cursor = 'pointer';
      tr.innerHTML = [
        i + 1,
        `<a href="https://globe.adsbexchange.com/?icao=${encodeURIComponent(e.hex)}"` +
          ` target="_blank" rel="noopener">${e.reg}</a>`,
        e.type || '—',
        e.n,
        Math.round(e.median).toLocaleString(),
        Math.round(e.best).toLocaleString(),
        Math.round(e.worst).toLocaleString(),
        e.medRate != null ? Math.round(e.medRate).toLocaleString() : '—',
      ].map(c => `<td>${c}</td>`).join('');
      tr.addEventListener('click', ev => {
        if (ev.target.closest('a')) return;   // let the globe link work
        document.getElementById('climb-reg').value = e.reg;
        renderAll();
      });
      tbody.appendChild(tr);
    });
  }

  function renderChart() {
    stopGlow();
    const canvas = document.getElementById('climb-chart');
    const W = KANP.contentWidth(canvas.parentElement);
    const H = 320;
    const ctx = KANP.setupCanvas(canvas, W, H);
    const profiles = last.profiles;

    const PAD_L = 46, PAD_B = 26, PAD_T = 10, PAD_R = 10;
    const plotW = W - PAD_L - PAD_R, plotH = H - PAD_T - PAD_B;
    const maxD = 3.5, maxG = MAX_GAIN;
    const X = d => PAD_L + Math.min(d, maxD) / maxD * plotW;
    const Y = g => PAD_T + plotH - Math.min(g, maxG) / maxG * plotH;

    // grid
    ctx.font = '10px sans-serif';
    ctx.strokeStyle = '#2a2a2a';
    ctx.fillStyle = '#666';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let g = 0; g <= maxG; g += 500) {
      ctx.beginPath(); ctx.moveTo(PAD_L, Y(g)); ctx.lineTo(W - PAD_R, Y(g)); ctx.stroke();
      ctx.fillText(g.toLocaleString(), PAD_L - 5, Y(g));
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let d = 0; d <= maxD; d += 0.5) {
      ctx.beginPath(); ctx.moveTo(X(d), PAD_T); ctx.lineTo(X(d), PAD_T + plotH); ctx.stroke();
      ctx.fillText(d.toFixed(1), X(d), PAD_T + plotH + 5);
    }
    ctx.fillText('nm from liftoff', PAD_L + plotW / 2, H - 12);
    ctx.save();
    ctx.translate(11, PAD_T + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('ft gained', 0, 0);
    ctx.restore();

    // reference gradients
    [[200, '200 ft/nm'], [300, '300 ft/nm'], [500, '500 ft/nm']].forEach(([g, lbl]) => {
      ctx.strokeStyle = '#3a3a3a';
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(X(0), Y(0));
      const dEnd = Math.min(maxD, maxG / g);
      ctx.lineTo(X(dEnd), Y(dEnd * g));
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#555';
      ctx.textAlign = 'left';
      const lx = X(dEnd), ly = Y(dEnd * g);
      ctx.fillText(lbl, Math.min(lx + 3, W - 60), Math.max(ly - 4, PAD_T + 2));
    });

    // curves: gray others first, then highlighted on top
    plotGeom = { X, Y, lines: [] };
    const hi = profiles.map(isHighlighted);
    const order = profiles.map((_, i) => i)
      .sort((a, b) => (hi[a] ? 1 : 0) - (hi[b] ? 1 : 0));
    let ci = 0;
    const colorOf = new Map();
    profiles.forEach((p, i) => {
      if (hi[i]) colorOf.set(i, PALETTE[ci++ % PALETTE.length]);
    });
    for (const i of order) {
      const p = profiles[i];
      const hovered = last.hoverIdx === i;
      ctx.strokeStyle = hovered ? '#fff'
        : hi[i] ? colorOf.get(i) : 'rgba(140,150,160,0.30)';
      ctx.lineWidth = hovered ? 2.5 : hi[i] ? 2 : 1;
      ctx.beginPath();
      const line = [];
      p.points.forEach((q, k) => {
        const x = X(q.d), y = Y(q.gain);
        line.push([x, y]);
        k ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      });
      ctx.stroke();
      plotGeom.lines[i] = line;
    }

    // legend for highlighted curves
    if (colorOf.size) {
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      let y = PAD_T + 10;
      for (const [i, c] of colorOf) {
        if (y > PAD_T + plotH - 10) break;
        const p = profiles[i];
        ctx.strokeStyle = c; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(PAD_L + 8, y); ctx.lineTo(PAD_L + 26, y); ctx.stroke();
        ctx.fillStyle = '#ccc';
        ctx.fillText(`${p.reg} · ${fmtTs(p.ts)}` +
          (p.grad ? ` · ${Math.round(p.grad)} ft/nm` : '') +
          (p.rate ? ` · ${Math.round(p.rate)} fpm` : ''), PAD_L + 31, y);
        y += 15;
      }
    }

    // mean curve of the highlighted airplane, drawn breathing on top
    avgLine = null;
    const mine = profiles.filter((_, i) => hi[i]);
    const pts = mine.length >= 2 ? meanCurve(mine, X, Y, maxD) : null;
    if (pts) {
      // one colour for the airplane: its first climb's, or white when the
      // highlight matches more than one reg
      const regs = new Set(mine.map(p => p.reg));
      avgLine = { pts, color: regs.size === 1 ? colorOf.get(profiles.findIndex((_, i) => hi[i])) : '#fff' };
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = '#999';
      ctx.fillText(`glow → ${[...regs][0]}${regs.size > 1 ? ' +' : ''} mean of ${mine.length}`, W - PAD_R - 4, PAD_T + plotH - 4);
      staticLayer = document.createElement('canvas');
      staticLayer.width = canvas.width; staticLayer.height = canvas.height;
      staticLayer.getContext('2d').drawImage(canvas, 0, 0);
      animId = requestAnimationFrame(paintGlow);
    }
  }

  function onHover(e) {
    if (!plotGeom || !last) return;
    const x = e.offsetX, y = e.offsetY;
    let best = null, bestD = 12 * 12;
    plotGeom.lines.forEach((line, i) => {
      if (!line) return;
      for (const [px, py] of line) {
        const d2 = (px - x) ** 2 + (py - y) ** 2;
        if (d2 < bestD) { bestD = d2; best = i; }
      }
    });
    setHover(best, e);
  }

  function setHover(idx, e) {
    const tipId = 'kanp-climb-tip';
    let tip = document.getElementById(tipId);
    if (idx == null) {
      if (tip) tip.style.display = 'none';
      if (last && last.hoverIdx != null) { last.hoverIdx = null; renderChart(); }
      return;
    }
    if (last.hoverIdx !== idx) { last.hoverIdx = idx; renderChart(); }
    if (!tip) {
      tip = document.createElement('div');
      tip.id = tipId;
      tip.className = 'grid-tip';
      document.body.appendChild(tip);
    }
    const p = last.profiles[idx];
    tip.innerHTML = `<strong>${p.reg}</strong>${p.type ? ' · ' + p.type : ''}` +
      `${p.rwy ? ' · RWY ' + p.rwy : ''}<br>${fmtTs(p.ts, true)}` +
      (p.grad ? `<br>${Math.round(p.grad)} ft/nm to ${GRAD_AT} ft` : '') +
      (p.rate ? ` · ${Math.round(p.rate)} fpm` : '') +
      (p.avgGs ? ` · ${Math.round(p.avgGs)} kt avg` : '');
    tip.style.display = 'block';
    const r = tip.getBoundingClientRect();
    tip.style.left = `${Math.min(e.clientX + 12, window.innerWidth - r.width - 6)}px`;
    tip.style.top = `${Math.max(6, e.clientY - r.height - 10)}px`;
  }

  function renderSummary() {
    const el = document.getElementById('climb-summary');
    const profiles = last.profiles;
    const med = arr => {
      const v = arr.filter(x => x != null).sort((a, b) => a - b);
      return v.length ? v[Math.floor(v.length / 2)] : null;
    };
    const mineP = profiles.filter(isHighlighted), restP = profiles.filter(p => !isHighlighted(p));
    const n = highlightNeedle();
    const f = ps => {
      const g = med(ps.map(p => p.grad)), r = med(ps.map(p => p.rate));
      return `${g == null ? '—' : Math.round(g) + ' ft/nm'} · ${r == null ? '—' : Math.round(r) + ' fpm'}`;
    };
    el.textContent = n
      ? `${n} → ${f(mineP)} · ${mineP.length} climb-out(s) · ` +
        `everyone else → ${f(restP)} · ${restP.length}`
      : `median → ${f(restP)} · ${restP.length} climb-outs`;
  }

  function renderTable() {
    const tbody = document.querySelector('#climb-table tbody');
    tbody.innerHTML = '';
    last.profiles.forEach((p, i) => {
      const tr = document.createElement('tr');
      if (isHighlighted(p)) tr.style.background = '#20304a';
      tr.innerHTML = [
        fmtTs(p.ts, true),
        `<a href="https://globe.adsbexchange.com/?icao=${encodeURIComponent(p.hex)}"` +
          ` target="_blank" rel="noopener">${p.reg}</a>`,
        p.type || '—',
        p.rwy ? `RWY ${p.rwy}` : '—',
        p.grad ? Math.round(p.grad).toLocaleString() : '—',
        p.rate ? Math.round(p.rate).toLocaleString() : '—',
        p.distTo500 ? p.distTo500.toFixed(2) : '—',
        p.avgGs ? Math.round(p.avgGs) : '—',
      ].map(c => `<td>${c}</td>`).join('');
      tr.addEventListener('mouseenter', () => { last.hoverIdx = i; renderChart(); });
      tr.addEventListener('mouseleave', () => { last.hoverIdx = null; renderChart(); });
      tbody.appendChild(tr);
    });
  }

  function fmtTs(ts, withTime) {
    const d = new Date(ts * 1000);
    const date = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    return withTime
      ? `${date} ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
      : date;
  }

  // exposed for console inspection (e.g. checking baseline behaviour)
  return { profiles: () => last && last.profiles };
})();
