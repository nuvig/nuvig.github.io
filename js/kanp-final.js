// KANP Flight Tracker — Straight-in comparison (Traffic Study tab)
//
// Finds arrivals to a selected runway end that flew a genuine straight-in
// (established on the extended centerline beyond pattern distance) and ranks
// them by how precisely they tracked it: average lateral offset, distance
// established, and glidepath angle.
//
// Geometry: positions are converted to a runway frame — `along` = nm from the
// field out along the final approach course, `cross` = signed lateral offset
// from the extended centerline. Arrival detection mirrors kanp-ops.js (an
// at-field segment with airborne context before it); the approach is the
// track walked backwards from the field contact.

const KANPFinal = (() => {
  const NEAR_NM = KANP.OPS_GATES.NEAR_NM;
  const LOW_FT = KANP.OPS_GATES.LOW_FT;
  const GAP_S = 300;        // max gap inside one field-contact segment
  const CONTEXT_S = 900;    // airborne-context window before the segment
  const APPR_GAP_S = 180;   // max gap between approach points before cutoff
  const MAX_ALONG = 6;      // nm out: stop walking the approach
  const PLOT_ALONG = 4;     // nm shown on the chart
  const MIN_ALONG = 2.5;    // must be on-ish centerline this far out to count
  const SECTOR_NM = 0.4;    // |cross| allowed between 0.8 and MIN_ALONG nm
  const EST_NM = 0.15;      // |cross| that counts as "established"
  const FT_NM = 6076.12;

  const MEDALS = ['#f0c040', '#c0c0c8', '#cd7f32'];   // gold / silver / bronze

  let last = null;          // { finals, hoverIdx }
  let plotGeom = null;

  document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('final-load');
    if (!btn) return;
    btn.addEventListener('click', run);
    document.getElementById('final-rwy')
      .addEventListener('change', () => { if (last) run(); });
    window.addEventListener('resize', () => { if (last) renderChart(); });
    const canvas = document.getElementById('final-chart');
    canvas.addEventListener('mousemove', onHover);
    canvas.addEventListener('mouseleave', () => setHover(null));
  });

  async function run() {
    const btn = document.getElementById('final-load');
    const out = document.getElementById('final-result');
    btn.disabled = true;
    out.textContent = 'Fetching arrival tracks…';
    try {
      const p = KANP.readFilters('study-filters');
      delete p.min_alt;
      delete p.max_alt;
      delete p.callsign;
      p.ground = 'include';
      p.max_dist = MAX_ALONG + 1;
      p.max_alt = 3500;
      p.max_points = 400000;
      const d = await KANP.getTracks(p);
      out.textContent = 'Extracting approaches…';
      const rwy = document.getElementById('final-rwy').value;
      const finals = extract(d, rwy);
      last = { finals, hoverIdx: null };
      if (!finals.length) {
        document.getElementById('final-out').style.display = 'none';
        out.textContent = `No straight-in approaches to RWY ${rwy} found in this range ` +
          '(pattern arrivals turn final too close in to qualify).';
        return;
      }
      document.getElementById('final-out').style.display = '';
      renderChart();
      renderTable();
      const w = finals[0];
      out.innerHTML = `<strong>${finals.length}</strong> straight-in(s) to RWY ${rwy} · ` +
        `best: <strong>${w.reg}</strong> (${Math.round(w.meanOff)} ft avg offset, ` +
        `established ${w.estFrom.toFixed(1)} nm out) · ${KANP.sourceLabel(d)}`;
    } catch (e) {
      out.innerHTML = `<span class="err">${e.message}</span>`;
    } finally {
      btn.disabled = false;
    }
  }

  // ---- extraction ----
  function extract(d, rwyName) {
    // field → approach-side bearing: aircraft landing names[0] (course
    // axisTrue) approach from the reciprocal side; names[1] from axisTrue.
    const b = (rwyName === KANP.RWY.names[1]
      ? KANP.RWY.axisTrue : KANP.RWY.axisTrue + 180) * Math.PI / 180;
    const ux = Math.sin(b), uy = Math.cos(b);
    const R_NM = 3440.065, r = Math.PI / 180;
    const toXY = (lat, lon) => ({
      x: (lon - KANP.LON) * r * R_NM * Math.cos(KANP.LAT * r),
      y: (lat - KANP.LAT) * r * R_NM,
    });

    const finals = [];
    for (const t of d.tracks) {
      const pts = t.points;
      const atField = pts.map(p =>
        (p[5] === 1 || (p[3] != null && p[3] <= LOW_FT)) &&
        KANP.distNm(p[1], p[2]) <= NEAR_NM);

      const segs = [];
      for (let i = 0; i < pts.length; i++) {
        if (!atField[i]) continue;
        const s = segs[segs.length - 1];
        if (s && s.i1 === i - 1 && pts[i][0] - pts[s.i1][0] <= GAP_S) s.i1 = i;
        else segs.push({ i0: i, i1: i });
      }

      for (const s of segs) {
        // arrival: airborne-away context before the segment
        let prevAir = false;
        const t0 = pts[s.i0][0];
        for (let k = s.i0 - 1; k >= 0 && pts[k][0] >= t0 - CONTEXT_S; k--) {
          const p = pts[k];
          if (p[5] !== 1 && (KANP.distNm(p[1], p[2]) > NEAR_NM ||
              (p[3] != null && p[3] > LOW_FT + 200))) { prevAir = true; break; }
        }
        if (!prevAir) continue;

        // walk the approach backwards from the field contact
        const appr = [];
        for (let k = s.i0 - 1; k >= 0; k--) {
          const p = pts[k];
          if (pts[k + 1][0] - p[0] > APPR_GAP_S) break;
          const { x, y } = toXY(p[1], p[2]);
          const along = x * ux + y * uy;
          const cross = x * uy - y * ux;             // signed, nm
          if (along > MAX_ALONG) break;
          if (along < 0.2) continue;                 // over/behind the field
          appr.push({ along, cross, alt: p[3], gs: p[4], ts: p[0] });
        }
        if (appr.length < 4) continue;
        appr.reverse();                              // far out → threshold

        const maxAlong = appr[appr.length ? appr.length - 1 : 0]
          ? Math.max(...appr.map(q => q.along)) : 0;
        if (maxAlong < MIN_ALONG) continue;          // never out far enough

        // straight-in gate: inside the sector the whole way in
        if (appr.some(q => q.along >= 0.8 && q.along <= MIN_ALONG &&
            Math.abs(q.cross) > SECTOR_NM)) continue;

        // established-from: farthest along from which every point inward
        // (down to 0.5 nm) stays within EST_NM of the centerline
        let estFrom = 0;
        const inward = appr.slice().sort((a, b) => a.along - b.along);
        for (const q of inward) {
          if (q.along < 0.5) continue;
          if (Math.abs(q.cross) <= EST_NM) estFrom = q.along;
          else break;
        }
        if (estFrom < 1.5) continue;                 // wandering — not "best" material

        // scoring window: 0.5–3 nm final
        const win = appr.filter(q => q.along >= 0.5 && q.along <= 3);
        if (win.length < 3) continue;
        const meanOff = win.reduce((a, q) => a + Math.abs(q.cross), 0)
          / win.length * FT_NM;

        // glidepath: median per-point angle above field elevation
        const angles = win
          .filter(q => q.alt != null && q.alt > SITE.airport.elevFt)
          .map(q => Math.atan2(q.alt - SITE.airport.elevFt, q.along * FT_NM) * 180 / Math.PI)
          .sort((a, b) => a - b);
        const glide = angles.length ? angles[Math.floor(angles.length / 2)] : null;

        // one landing can split into two field-contact segments (coverage
        // blip on rollout) — both walk back over the same approach; keep one
        if (finals.some(f => f.hex === t.hex &&
            Math.abs(f.ts - appr[0].ts) < 300)) continue;

        // vertical deviation from the PAPI glidepath: mean signed height
        // difference (ft, + = high) over the scoring window
        const papiTan = Math.tan(KANP.RWY.papiDeg * Math.PI / 180);
        const vPts = win.filter(q => q.alt != null);
        const vOff = vPts.length
          ? vPts.reduce((a, q) => a + (q.alt - SITE.airport.elevFt -
              q.along * FT_NM * papiTan), 0) / vPts.length
          : null;

        const gsPts = win.filter(q => q.gs != null);
        finals.push({
          ts: appr[0].ts, hex: t.hex, reg: t.reg || t.hex,
          flight: (t.flight || '').trim(), type: t.type,
          points: appr, estFrom, meanOff, glide, vOff,
          avgGs: gsPts.length ? gsPts.reduce((a, q) => a + q.gs, 0) / gsPts.length : null,
        });
      }
    }
    // best first: tightest average centerline tracking
    finals.sort((a, b) => a.meanOff - b.meanOff);
    return finals;
  }

  // ---- rendering ----
  // Two stacked panels sharing the distance axis (threshold at the right):
  // top = vertical profile with the PAPI reference glidepath, bottom =
  // lateral offset from the extended centerline.
  function renderChart() {
    const canvas = document.getElementById('final-chart');
    const W = KANP.contentWidth(canvas.parentElement);
    const V_H = 250, L_H = 210, GAP = 34, PAD_T = 10;
    const H = PAD_T + V_H + GAP + L_H + 40;
    const ctx = KANP.setupCanvas(canvas, W, H);
    const finals = last.finals;

    const PAD_L = 52, PAD_R = 30;
    const plotW = W - PAD_L - PAD_R;
    const X = along => PAD_L + (1 - Math.min(along, PLOT_ALONG) / PLOT_ALONG) * plotW;

    const vTop = PAD_T, lTop = PAD_T + V_H + GAP;
    const maxAlt = 1800;                       // ft above field, top panel
    const maxCross = 1500;                     // ft either side, bottom panel
    const YV = altFt => vTop + V_H - Math.min(altFt, maxAlt) / maxAlt * V_H;
    const YL = crossFt => lTop + L_H / 2 - (crossFt / maxCross) * (L_H / 2);

    ctx.font = '10px sans-serif';

    // shared vertical distance grid + x labels under each panel
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let a = 0; a <= PLOT_ALONG; a += 1) {
      ctx.strokeStyle = '#222';
      ctx.beginPath(); ctx.moveTo(X(a), vTop); ctx.lineTo(X(a), vTop + V_H); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(X(a), lTop); ctx.lineTo(X(a), lTop + L_H); ctx.stroke();
      ctx.fillStyle = '#666';
      const lbl = a === 0 ? 'field' : a.toFixed(0);
      ctx.fillText(lbl, X(a), vTop + V_H + 5);
      ctx.fillText(lbl, X(a), lTop + L_H + 5);
    }
    ctx.fillStyle = '#666';
    ctx.fillText('nm from threshold — final approach course →',
      PAD_L + plotW / 2, lTop + L_H + 18);

    // ---- top panel: vertical profile ----
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let ft = 0; ft <= maxAlt; ft += 500) {
      ctx.strokeStyle = '#2a2a2a';
      ctx.beginPath(); ctx.moveTo(PAD_L, YV(ft)); ctx.lineTo(W - PAD_R, YV(ft)); ctx.stroke();
      ctx.fillStyle = '#666';
      ctx.fillText(ft.toLocaleString(), PAD_L - 5, YV(ft));
    }
    // reference glidepaths: PAPI (blue) + 3° (gray) for contrast
    [[KANP.RWY.papiDeg, '#4a9eff', `PAPI ${KANP.RWY.papiDeg}°`],
     [3, '#555', '3°']].forEach(([deg, col, lbl]) => {
      const tan = Math.tan(deg * Math.PI / 180);
      const aEnd = Math.min(PLOT_ALONG, maxAlt / (tan * FT_NM));
      ctx.strokeStyle = col;
      ctx.setLineDash([6, 5]);
      ctx.beginPath();
      ctx.moveTo(X(0), YV(0));
      ctx.lineTo(X(aEnd), YV(aEnd * tan * FT_NM));
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = col;
      ctx.textAlign = 'left';
      ctx.fillText(lbl, Math.min(X(aEnd) + 4, W - 70),
        Math.max(YV(aEnd * tan * FT_NM) - 6, vTop + 8));
    });
    ctx.save();
    ctx.translate(11, vTop + V_H / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#666';
    ctx.fillText('ft above field', 0, 0);
    ctx.restore();

    // ---- bottom panel: lateral offset ----
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let c = -maxCross; c <= maxCross; c += 500) {
      ctx.strokeStyle = c === 0 ? '#4a9eff' : '#2a2a2a';
      ctx.setLineDash(c === 0 ? [6, 5] : []);
      ctx.beginPath(); ctx.moveTo(PAD_L, YL(c)); ctx.lineTo(W - PAD_R, YL(c)); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#666';
      ctx.fillText(c === 0 ? '0' : Math.abs(c).toLocaleString(), PAD_L - 5, YL(c));
    }
    ctx.save();
    ctx.translate(11, lTop + L_H / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#666';
    ctx.fillText('offset ft', 0, 0);
    ctx.restore();

    // runway symbols at the right edge of both panels
    ctx.fillStyle = '#888';
    ctx.fillRect(W - PAD_R + 4, YV(0) - 3, 18, 6);
    ctx.fillRect(W - PAD_R + 4, YL(0) - 3, 18, 6);

    // curves in both panels: gray first, medals + hovered on top
    plotGeom = { lines: [] };
    const order = finals.map((_, i) => i).sort((a, b) => (a < 3 ? 1 : 0) - (b < 3 ? 1 : 0));
    for (const i of order) {
      const f = finals[i];
      const hovered = last.hoverIdx === i;
      ctx.strokeStyle = hovered ? '#fff'
        : i < 3 ? MEDALS[i] : 'rgba(140,150,160,0.30)';
      ctx.lineWidth = hovered ? 2.5 : i < 3 ? 2 : 1;
      const line = [];

      ctx.beginPath();                         // vertical profile
      let started = false;
      f.points.forEach(q => {
        if (q.alt == null) return;
        const x = X(q.along), y = YV(q.alt - SITE.airport.elevFt);
        line.push([x, y]);
        started ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        started = true;
      });
      ctx.stroke();

      ctx.beginPath();                         // lateral offset
      f.points.forEach((q, k) => {
        const x = X(q.along), y = YL(q.cross * FT_NM);
        line.push([x, y]);
        k ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      });
      ctx.stroke();
      plotGeom.lines[i] = line;
    }

    // medal legend (top panel, under the y-axis)
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    let ly = vTop + 10;
    finals.slice(0, 3).forEach((f, i) => {
      ctx.strokeStyle = MEDALS[i]; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(PAD_L + 8, ly); ctx.lineTo(PAD_L + 26, ly); ctx.stroke();
      ctx.fillStyle = '#ccc';
      ctx.fillText(`${f.reg} · ${fmtTs(f.ts)} · ${Math.round(f.meanOff)} ft avg`,
        PAD_L + 31, ly);
      ly += 15;
    });
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
    let tip = document.getElementById('kanp-final-tip');
    if (idx == null) {
      if (tip) tip.style.display = 'none';
      if (last && last.hoverIdx != null) { last.hoverIdx = null; renderChart(); }
      return;
    }
    if (last.hoverIdx !== idx) { last.hoverIdx = idx; renderChart(); }
    if (!tip) {
      tip = document.createElement('div');
      tip.id = 'kanp-final-tip';
      tip.className = 'grid-tip';
      document.body.appendChild(tip);
    }
    const f = last.finals[idx];
    tip.innerHTML = `<strong>#${idx + 1} ${f.reg}</strong>${f.type ? ' · ' + f.type : ''}` +
      `<br>${fmtTs(f.ts, true)}<br>${Math.round(f.meanOff)} ft avg offset · ` +
      `established ${f.estFrom.toFixed(1)} nm out` +
      (f.glide != null ? `<br>${f.glide.toFixed(1)}° glidepath` : '') +
      (f.vOff != null ? ` · ${f.vOff >= 0 ? '+' : ''}${Math.round(f.vOff)} ft vs PAPI` : '') +
      (f.avgGs ? ` · ${Math.round(f.avgGs)} kt` : '');
    tip.style.display = 'block';
    const r = tip.getBoundingClientRect();
    tip.style.left = `${Math.min(e.clientX + 12, window.innerWidth - r.width - 6)}px`;
    tip.style.top = `${Math.max(6, e.clientY - r.height - 10)}px`;
  }

  function renderTable() {
    const tbody = document.querySelector('#final-table tbody');
    tbody.innerHTML = '';
    last.finals.forEach((f, i) => {
      const tr = document.createElement('tr');
      tr.innerHTML = [
        i + 1,
        fmtTs(f.ts, true),
        `<a href="https://globe.adsbexchange.com/?icao=${encodeURIComponent(f.hex)}"` +
          ` target="_blank" rel="noopener">${f.reg}</a>`,
        f.type || '—',
        Math.round(f.meanOff),
        f.estFrom.toFixed(1),
        f.glide != null ? f.glide.toFixed(1) + '°' : '—',
        f.vOff != null ? `${f.vOff >= 0 ? '+' : ''}${Math.round(f.vOff)}` : '—',
        f.avgGs ? Math.round(f.avgGs) : '—',
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

  return {};
})();
