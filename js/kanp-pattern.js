// KANP Flight Tracker — Pattern shape (Traffic Study tab)
//
// What a normal traffic pattern at this field actually looks like: every
// downwind leg flown into a landing or low approach, measured in the runway
// frame, drawn as a plan view of the circuits plus distributions of downwind
// width and pattern altitude. Teaching tool — "fly a normal pattern" is a
// number here, not a feeling.
//
// Geometry is the shared runway frame (KANP.runwayFrame, the same one
// kanp-final.js ranks straight-ins in): `along` = nm from the field along the
// extended centerline, positive on the approach side; `cross` = signed nm from
// the centerline, positive LEFT of the landing direction. Because cross is
// left-of-landing for *either* end, circuits to 12 and to 30 stack into one
// picture and left traffic (SITE.tracker.runway.pattern) sits at cross > 0 in
// both — no mirroring, no per-runway special case.
//
// Detection mirrors kanp-ops.js: contiguous at-field segments inside
// OPS_GATES, runway end from the mean course through the segment. Every
// contact with airborne context *before* it (an arrival or a go-around) is
// walked backwards through its circuit, and the downwind is the last run of
// points that is offset from the centerline, inside the pattern-altitude band,
// parallel-ish to the runway, and travelling *toward* the approach side —
// along increasing, the opposite of final. Attributing each downwind to the
// contact that follows it counts a lap once: in closed traffic one lap's
// downwind is the next contact's inbound leg.
//
// A misattributed runway end costs data rather than corrupting it: flipping
// the frame negates both along and cross, so a real downwind would then read
// as travelling away from the approach side and is dropped, never counted as
// a right-side pattern.
//
// Altitudes are ADS-B *pressure* altitude, so before anything is called AGL
// it is re-baselined to the field's own pressure altitude for that hour, read
// out of what aircraft report while at the field (see fieldBaseFn — this
// deliberately does not use kanp-climb.js's ground-fix-only estimate).
// Pattern altitude is then the peak over the abeam window, not its average:
// the downwind is level and then descends, and averaging the two reported
// real 1,000 ft patterns as ~800.

const KANPPattern = (() => {
  const NEAR_NM = KANP.OPS_GATES.NEAR_NM;
  const LOW_FT = KANP.OPS_GATES.LOW_FT;
  const GAP_S = 300;        // max gap inside one field-contact segment
  const CONTEXT_S = 900;    // airborne-context window before the segment
  const LAP_GAP_S = 180;    // max gap between points inside one circuit
  const LAP_MAX_S = 900;    // walk back at most this far from the contact
  const BOX_NM = 3;         // beyond this we are no longer in the pattern
  const DW_ALONG = 1.6;     // downwind points sit within this much along-axis
  const DW_MIN = 0.25;      // |cross| under this is the centerline, not a downwind
  const DW_MAX = 2;         // |cross| over this is not a pattern leg
  const DW_SPAN = 0.6;      // the leg must run at least this far along-axis
  const SLOPE_MAX = 0.45;   // |Δcross/Δalong| — cuts the 45 entry and the base turn
  const AGL_MIN = 350;      // ft above field: below this it is base/final, not downwind
  const AGL_MAX = 2200;     // ft above field: above this it is an overflight
  const ABEAM = 0.8;        // |along| window the leg is measured over
  const TPA_FT = 1000;      // standard light-aircraft TPA, AIM 4-3-3
  const FT_NM = 6076.12;

  const PALETTE = ['#f0c040', '#ef4444', '#22c55e', '#4a9eff', '#c084fc',
                   '#fb923c', '#2dd4bf', '#f472b6'];

  let last = null;          // { legs, hoverIdx } for re-render
  let plotGeom = null;      // screen-space geometry for hover hit-testing

  document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('pattern-load');
    if (!btn) return;
    btn.addEventListener('click', run);
    document.getElementById('pattern-rwy')
      .addEventListener('change', () => { if (last) run(); });
    document.getElementById('pattern-reg')
      .addEventListener('input', () => { if (last) renderAll(); });
    window.addEventListener('resize', () => { if (last) renderCharts(); });
    const canvas = document.getElementById('pattern-plan');
    canvas.addEventListener('mousemove', onHover);
    canvas.addEventListener('mouseleave', () => setHover(null));
  });

  async function run() {
    const btn = document.getElementById('pattern-load');
    const out = document.getElementById('pattern-result');
    btn.disabled = true;
    out.textContent = 'Fetching pattern tracks…';
    try {
      const p = KANP.readFilters('study-filters');
      delete p.min_alt;
      delete p.max_alt;
      delete p.callsign;          // the highlight box handles per-aircraft focus
      p.ground = 'include';
      p.max_dist = BOX_NM + 1;
      p.max_alt = 3500;
      p.max_points = 400000;
      const d = await KANP.getTracks(p);
      out.textContent = 'Measuring downwind legs…';
      const rwy = document.getElementById('pattern-rwy').value;
      const legs = extract(d, rwy || null);
      last = { legs, hoverIdx: null };
      if (!legs.length) {
        document.getElementById('pattern-out').style.display = 'none';
        out.textContent = 'No downwind legs found in this range ' +
          '(straight-in arrivals never fly one).';
        return;
      }
      document.getElementById('pattern-out').style.display = '';
      renderAll();
      const dense = d.dense
        ? ' · <span class="warn">large range — narrow it for accuracy</span>' : '';
      out.innerHTML = `<strong>${legs.length}</strong> downwind leg(s) measured · ` +
        `median ${med(legs.map(l => l.width)).toFixed(2)} nm out at ` +
        `${Math.round(med(legs.map(l => l.agl)) / 10) * 10} ft AGL · ` +
        `${KANP.sourceLabel(d)}${dense}`;
    } catch (e) {
      out.innerHTML = `<span class="err">${e.message}</span>`;
    } finally {
      btn.disabled = false;
    }
  }

  // ---- extraction ----
  function extract(d, rwyFilter) {
    const fieldPA = fieldBaseFn(d);
    const frames = {};
    KANP.RWY.names.forEach(n => { frames[n] = KANP.runwayFrame(n); });

    const legs = [];
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
        // arrival or go-around: airborne-away context before the contact. A
        // pure departure has no inbound circuit — if it stayed in the pattern
        // its downwind belongs to the next contact, which is where we count it.
        const t0 = pts[s.i0][0];
        let prevAir = false;
        for (let k = s.i0 - 1; k >= 0 && pts[k][0] >= t0 - CONTEXT_S; k--) {
          if (isAway(pts[k])) { prevAir = true; break; }
        }
        if (!prevAir) continue;

        const rwy = segRunway(pts, s);
        if (!rwy || (rwyFilter && rwy !== rwyFilter)) continue;
        const toFrame = frames[rwy];
        const base = fieldPA(t0);

        // walk the circuit backwards; the previous field contact ends it, so a
        // closed-traffic lap is bounded exactly and its time is the lap time
        const circ = [];
        let fromContact = null;
        for (let k = s.i0 - 1; k >= 0; k--) {
          if (pts[k + 1][0] - pts[k][0] > LAP_GAP_S) break;
          if (t0 - pts[k][0] > LAP_MAX_S) break;
          if (atField[k]) { fromContact = pts[k][0]; break; }
          const f = toFrame(pts[k][1], pts[k][2]);
          if (Math.hypot(f.along, f.cross) > BOX_NM) break;
          circ.push({
            along: f.along, cross: f.cross, absCross: Math.abs(f.cross),
            agl: pts[k][3] == null ? null : pts[k][3] - base,
            gs: pts[k][4], ts: pts[k][0],
          });
        }
        if (circ.length < 2) continue;
        circ.reverse();                              // entry/liftoff → threshold

        const run = findDownwind(circ);
        if (!run) continue;

        // Point density along a leg is uneven — the exporter's Douglas-Peucker
        // (0.03 nm) keeps only shape-changing fixes, so a steady downwind can
        // be two points — so both measurements integrate along the leg rather
        // than averaging the points that happen to have survived.
        // Width is an average because the downwind's distance out is what it
        // holds; altitude is the *peak* over the window because the leg is
        // level and then descends — pattern altitude is the altitude flown
        // abeam, and averaging it with the power-reduction descent that
        // follows reported real 1,000 ft patterns as ~800.
        let width = segAvg(run, q => q.absCross, -ABEAM, ABEAM);
        let agl = segMax(run, q => q.agl, -ABEAM, ABEAM);
        if (width == null) {                         // leg never reached abeam
          width = segAvg(run, q => q.absCross, -Infinity, Infinity);
          agl = segMax(run, q => q.agl, -Infinity, Infinity);
        }
        if (width == null || agl == null) continue;

        // the flown circuit for the plan view: airborne track through the
        // contact, stopping at touchdown so rollout and taxi stay off the chart
        const path = circ.slice();
        for (let k = s.i0; k <= s.i1; k++) {
          if (pts[k][5] === 1) break;
          const f = toFrame(pts[k][1], pts[k][2]);
          path.push({ along: f.along, cross: f.cross, ts: pts[k][0] });
        }

        const gsPts = run.filter(q => q.gs != null);
        legs.push({
          ts: t0, hex: t.hex, reg: t.reg || t.hex,
          flight: (t.flight || '').trim(), type: t.type, rwy,
          width, agl, side: run[run.length - 1].cross >= 0 ? 'L' : 'R',
          closed: fromContact != null,
          lapS: fromContact != null ? t0 - fromContact : null,
          avgGs: gsPts.length ? gsPts.reduce((a, q) => a + q.gs, 0) / gsPts.length : null,
          run, path,
        });
      }
    }
    legs.sort((a, b) => b.ts - a.ts);
    return legs;
  }

  // The downwind: walking back from the threshold, the last run of points that
  // qualifies and holds together. Taking the *last* one keeps the leg flown
  // into this landing when a track carries several laps; the parallel test
  // trims the 45 entry, the crosswind and the base turn off its ends.
  function findDownwind(circ) {
    let i = circ.length - 1;
    while (i > 0) {
      if (!dwOk(circ[i])) { i--; continue; }
      let j = i;
      while (j > 0 && dwOk(circ[j - 1]) && parallel(circ[j - 1], circ[j])) j--;
      if (i > j && circ[i].along - circ[j].along >= DW_SPAN) return circ.slice(j, i + 1);
      i = j - 1;
    }
    return null;
  }

  function dwOk(q) {
    return q.agl != null && q.agl >= AGL_MIN && q.agl <= AGL_MAX &&
      Math.abs(q.along) <= DW_ALONG && q.absCross >= DW_MIN && q.absCross <= DW_MAX;
  }

  function parallel(a, b) {
    const da = b.along - a.along;
    if (da <= 0) return false;                 // must fly toward the approach side
    if (Math.sign(a.cross) !== Math.sign(b.cross)) return false;
    return Math.abs(b.cross - a.cross) <= SLOPE_MAX * da;
  }

  // Average of f over the leg, weighted by along-axis travel and linearly
  // interpolated between fixes, restricted to along ∈ [lo, hi]. Null when the
  // leg never enters the window.
  function segAvg(run, f, lo, hi) {
    let num = 0, den = 0;
    for (let i = 1; i < run.length; i++) {
      const a = run[i - 1], b = run[i];
      const v0 = f(a), v1 = f(b);
      if (v0 == null || v1 == null || b.along <= a.along) continue;
      const c0 = Math.max(a.along, lo), c1 = Math.min(b.along, hi);
      if (c1 <= c0) continue;
      const at = x => v0 + (v1 - v0) * (x - a.along) / (b.along - a.along);
      num += (at(c0) + at(c1)) / 2 * (c1 - c0);
      den += c1 - c0;
    }
    return den ? num / den : null;
  }

  // Peak of f over along ∈ [lo, hi]: the fixes inside the window plus the
  // interpolated window edges, so a two-fix leg still reports the altitude it
  // was at when it got abeam rather than wherever its next fix landed.
  function segMax(run, f, lo, hi) {
    let best = null;
    const take = v => { if (v != null && (best == null || v > best)) best = v; };
    for (let i = 0; i < run.length; i++) {
      if (run[i].along >= lo && run[i].along <= hi) take(f(run[i]));
      if (!i) continue;
      const a = run[i - 1], b = run[i];
      const v0 = f(a), v1 = f(b);
      if (v0 == null || v1 == null || b.along <= a.along) continue;
      const at = x => v0 + (v1 - v0) * (x - a.along) / (b.along - a.along);
      if (a.along < lo && b.along > lo) take(at(lo));
      if (a.along < hi && b.along > hi) take(at(hi));
    }
    return best;
  }

  function isAway(p) {
    if (p[5] === 1) return false;
    return KANP.distNm(p[1], p[2]) > NEAR_NM ||
      (p[3] != null && p[3] > LOW_FT + 200);
  }

  // runway end from the mean course through the field contact (kanp-ops.js)
  function segRunway(pts, s) {
    let sx = 0, sy = 0;
    const c0 = Math.max(0, s.i0 - 1), c1 = Math.min(pts.length - 1, s.i1 + 1);
    for (let k = c0; k < c1; k++) {
      const c = course(pts[k], pts[k + 1]);
      if (c == null) continue;
      const r = c * Math.PI / 180;
      sx += Math.sin(r); sy += Math.cos(r);
    }
    if (!sx && !sy) return null;
    const mean = Math.atan2(sx, sy) * 180 / Math.PI;
    return Math.cos((mean - KANP.RWY.axisTrue) * Math.PI / 180) >= 0
      ? KANP.RWY.names[0] : KANP.RWY.names[1];
  }

  function course(a, b) {
    const r = Math.PI / 180;
    const dx = (b[2] - a[2]) * Math.cos(a[1] * r), dy = b[1] - a[1];
    if (Math.hypot(dx, dy) < 1e-5) return null;
    return (Math.atan2(dx, dy) / r + 360) % 360;
  }

  // ADS-B altitude is *pressure* altitude, so the field itself reads a few
  // hundred feet off whatever the day's altimeter setting is — measured here
  // on 2026-08-06 the field sat at −200 ft, and an uncorrected 1,000 ft
  // pattern reported ~750. So the field's pressure altitude is read back out
  // of the same data: per hour, the low decile of what aircraft report while
  // at the field (on the ground, or inside the OPS_GATES box on short final
  // and rollout). The low decile rather than the median because that set also
  // holds aircraft still 500 ft up on final; rather than the raw minimum
  // because one bad fix should not move the whole hour.
  //
  // kanp-climb.js estimates this from on-ground reports alone. That is sound
  // there — it only ever uses altitude *differences* from a flight's own
  // liftoff, so the error cancels — but on-ground fixes carry NO altitude in
  // the GitHub snapshots, so ground-only silently falls back to charted field
  // elevation. This tool reports an absolute AGL, where that fallback would
  // hand every number the day's altimeter error. Don't "unify" the two.
  function fieldBaseFn(d) {
    const hourAlts = new Map();
    for (const t of d.tracks) {
      for (const p of t.points) {
        if (p[3] == null) continue;
        if ((p[5] === 1 || p[3] <= LOW_FT) && KANP.distNm(p[1], p[2]) <= NEAR_NM) {
          const h = Math.floor(p[0] / 3600);
          if (!hourAlts.has(h)) hourAlts.set(h, []);
          hourAlts.get(h).push(p[3]);
        }
      }
    }
    const hourBase = new Map();
    for (const [h, v] of hourAlts) {
      v.sort((a, b) => a - b);
      hourBase.set(h, v[Math.floor(0.1 * v.length)]);
    }
    return ts => {
      const h = Math.floor(ts / 3600);
      for (let dh = 0; dh <= 6; dh++) {          // nearest hour with data
        if (hourBase.has(h - dh)) return hourBase.get(h - dh);
        if (hourBase.has(h + dh)) return hourBase.get(h + dh);
      }
      return SITE.airport.elevFt;                // no ground fixes: MSL ≈ AGL
    };
  }

  // ---- stats helpers ----
  function pct(vals, p) {
    const v = vals.filter(x => x != null).sort((a, b) => a - b);
    if (!v.length) return null;
    return v[Math.min(v.length - 1, Math.floor(p * v.length))];
  }
  const med = vals => pct(vals, 0.5);

  // ---- highlight matching (mirrors kanp-climb.js) ----
  function needle() {
    return (document.getElementById('pattern-reg').value || '').trim().toUpperCase();
  }

  function isHighlighted(l) {
    const n = needle();
    if (!n) return false;
    return (l.reg || '').toUpperCase().includes(n) ||
      (l.flight || '').toUpperCase().includes(n);
  }

  // One colour per highlighted *aircraft*, not per leg: a tail number that
  // flew six laps drew six differently-coloured circuits, which reads as six
  // different airplanes. Several regs match a loose needle, and those do differ.
  function highlightColors(legs) {
    const m = new Map();
    legs.forEach(l => {
      if (isHighlighted(l) && !m.has(l.reg)) m.set(l.reg, PALETTE[m.size % PALETTE.length]);
    });
    return m;
  }

  // ---- rendering ----
  function renderAll() {
    renderCharts();
    renderCards();
    renderRank();
    renderTable();
    renderSummary();
  }

  function renderCharts() {
    renderPlan();
    const legs = last.legs;
    const cols = highlightColors(legs);
    const hi = legs.filter(isHighlighted);
    const mark = f => hi.map(l => ({ v: f(l), color: cols.get(l.reg) }));
    drawHist(document.getElementById('pattern-width'), legs.map(l => l.width), {
      lo: 0.2, hi: 2, binW: 0.1, tick: v => v.toFixed(1),
      fmt: v => `${v.toFixed(2)} nm`, marks: mark(l => l.width),
      axis: 'nm from the runway centerline',
    });
    drawHist(document.getElementById('pattern-alt'), legs.map(l => l.agl), {
      lo: 300, hi: 2200, binW: 100, tick: v => v.toLocaleString(),
      fmt: v => `${Math.round(v).toLocaleString()} ft`, marks: mark(l => l.agl),
      axis: 'ft above the field', refs: [{ v: TPA_FT, label: 'standard TPA' }],
    });
  }

  // Plan view, drawn as a true top-down picture: `along` grows to the LEFT so
  // the airplane lands moving right, and `cross` (left of the landing
  // direction) grows UP. Any other pairing of the two mirrors the view and
  // hangs left traffic on the wrong side of the runway. Both axes share one
  // px/nm scale — a stretched pattern would be a lie about its shape.
  function renderPlan() {
    const canvas = document.getElementById('pattern-plan');
    const legs = last.legs;
    const W = KANP.contentWidth(canvas.parentElement);
    const PAD_L = 30, PAD_R = 10, PAD_T = 10, PAD_B = 26;
    const plotW = W - PAD_L - PAD_R;

    // The cross window follows the data — a rare right-side downwind has to be
    // visible, not silently cropped out from under the line that counts it —
    // while the along window is fixed at 4 nm of centerline. One px/nm scale
    // serves both: if the height cap binds it is the *along* window that opens
    // up, never the aspect ratio, which would be a lie about the shape.
    const A_HI = 2.4, MAX_H = 520;
    const widthOn = right => legs.reduce((mx, l) =>
      (l.side === 'R') === right ? Math.max(mx, l.width) : mx, right ? 0.25 : 1);
    const C_HI = Math.min(2.4, widthOn(false) + 0.35);
    const C_LO = -Math.min(1.6, widthOn(true) + 0.35);
    const k = Math.min(plotW / 4, MAX_H / (C_HI - C_LO));   // px per nm, both axes
    const A_LO = A_HI - plotW / k;
    const plotH = (C_HI - C_LO) * k;
    const H = PAD_T + plotH + PAD_B;
    const ctx = KANP.setupCanvas(canvas, W, H);
    const X = a => PAD_L + (A_HI - a) * k;
    const Y = c => PAD_T + (C_HI - c) * k;

    ctx.font = '10px sans-serif';

    // grid + axis ticks
    ctx.strokeStyle = '#222';
    ctx.fillStyle = '#666';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let a = Math.ceil(A_LO); a <= A_HI; a += 1) {
      ctx.beginPath(); ctx.moveTo(X(a), PAD_T); ctx.lineTo(X(a), PAD_T + plotH); ctx.stroke();
      ctx.fillText(a === 0 ? 'field' : a.toFixed(0), X(a), PAD_T + plotH + 4);
    }
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let c = Math.ceil(C_LO / 0.5) * 0.5; c <= C_HI; c += 0.5) {
      if (Math.abs(c) < 0.01) continue;           // the centerline is drawn below
      ctx.beginPath(); ctx.moveTo(PAD_L, Y(c)); ctx.lineTo(W - PAD_R, Y(c)); ctx.stroke();
      ctx.fillText(c.toFixed(1), PAD_L - 4, Y(c));
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('nm along the centerline — landing direction →',
      PAD_L + plotW / 2, PAD_T + plotH + 14);

    // everything from here to the traces is clipped to the plot: a wide
    // quartile band or a circuit that leaves the box must not paint over the
    // axes it is measured against
    ctx.save();
    ctx.beginPath();
    ctx.rect(PAD_L, PAD_T, plotW, plotH);
    ctx.clip();

    // extended centerline + the window the width is measured over
    ctx.strokeStyle = '#333';
    ctx.setLineDash([5, 5]);
    ctx.beginPath(); ctx.moveTo(PAD_L, Y(0)); ctx.lineTo(W - PAD_R, Y(0)); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255,255,255,0.028)';
    ctx.fillRect(X(ABEAM), PAD_T, X(-ABEAM) - X(ABEAM), plotH);

    // quartile band + median downwind, on the published (left) side
    const widths = legs.map(l => l.width);
    const q1 = pct(widths, 0.25), q3 = pct(widths, 0.75), m = med(widths);
    ctx.fillStyle = 'rgba(74,158,255,0.10)';
    ctx.fillRect(PAD_L, Y(q3), plotW, Y(q1) - Y(q3));
    ctx.strokeStyle = '#4a9eff';
    ctx.setLineDash([7, 4]);
    ctx.beginPath(); ctx.moveTo(PAD_L, Y(m)); ctx.lineTo(W - PAD_R, Y(m)); ctx.stroke();
    ctx.setLineDash([]);

    // the runway, drawn on the origin — which is the tracker's field centre,
    // fitted from collected ground fixes and so the thing every trace here is
    // actually measured against (the charted ARP sits ~250 ft off it, and
    // which way depends on the runway end, so it would only add false detail)
    const half = ((SITE.airport.runways[0] || {}).len || 2500) / 2 / FT_NM;
    ctx.fillStyle = '#8a8a8a';
    ctx.fillRect(X(half), Y(0) - 2.5, X(-half) - X(half), 5);

    // circuits: gray first, highlighted then hovered on top
    plotGeom = { lines: [] };
    const hi = legs.map(isHighlighted);
    const cols = highlightColors(legs);
    const order = legs.map((_, i) => i).sort((a, b) => (hi[a] ? 1 : 0) - (hi[b] ? 1 : 0));
    for (const i of order) {
      const hovered = last.hoverIdx === i;
      ctx.strokeStyle = hovered ? '#fff'
        : hi[i] ? cols.get(legs[i].reg) : 'rgba(140,150,160,0.22)';
      ctx.lineWidth = hovered ? 2.5 : hi[i] ? 1.6 : 1;
      ctx.beginPath();
      const line = [];
      legs[i].path.forEach((q, n) => {
        const x = X(q.along), y = Y(q.cross);
        line.push([x, y]);
        n ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      });
      ctx.stroke();
      plotGeom.lines[i] = line;
    }
    ctx.restore();

    // labels last, over the traces
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = '#4a9eff';
    ctx.fillText(`median downwind ${m.toFixed(2)} nm · middle half ` +
      `${q1.toFixed(2)}–${q3.toFixed(2)}`, PAD_L + 6, Y(m) - 4);
    ctx.fillStyle = '#777';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('width measured abeam', (X(ABEAM) + X(-ABEAM)) / 2, PAD_T + 4);
  }

  // Histogram with the median called out, because the median is the answer to
  // "what is normal here" and reading it off bar heights is guesswork.
  function drawHist(canvas, vals, o) {
    const W = KANP.contentWidth(canvas.parentElement);
    const H = 190;
    const ctx = KANP.setupCanvas(canvas, W, H);
    ctx.font = '10px sans-serif';
    if (!vals.length) {
      ctx.fillStyle = '#444';
      ctx.textAlign = 'center';
      ctx.fillText('no data in range', W / 2, H / 2);
      return;
    }

    const PAD_L = 28, PAD_R = 10, PAD_T = 26, PAD_B = 30;
    const plotW = W - PAD_L - PAD_R, plotH = H - PAD_T - PAD_B;
    const nb = Math.round((o.hi - o.lo) / o.binW);
    const bins = new Array(nb).fill(0);
    const binOf = v => Math.max(0, Math.min(nb - 1, Math.floor((v - o.lo) / o.binW)));
    vals.forEach(v => bins[binOf(v)]++);
    const maxV = Math.max(1, ...bins);
    const X = v => PAD_L + (v - o.lo) / (o.hi - o.lo) * plotW;
    const Y = n => PAD_T + plotH - n / maxV * plotH;

    ctx.strokeStyle = '#2a2a2a';
    ctx.fillStyle = '#666';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) {
      const y = PAD_T + plotH - plotH * i / 4;
      ctx.beginPath(); ctx.moveTo(PAD_L, y); ctx.lineTo(W - PAD_R, y); ctx.stroke();
      ctx.fillText(Math.round(maxV * i / 4), PAD_L - 4, y);
    }

    ctx.fillStyle = '#4a9eff';
    bins.forEach((n, i) => {
      if (!n) return;
      const x = X(o.lo + i * o.binW), w = Math.max(1, X(o.lo + o.binW) - X(o.lo) - 1);
      ctx.fillRect(x, Y(n), w, PAD_T + plotH - Y(n));
    });

    // x labels, kept sparse enough to stay readable on a phone
    const every = Math.max(1, Math.ceil(nb / 8));
    ctx.fillStyle = '#666';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let i = 0; i <= nb; i += every) {
      const v = o.lo + i * o.binW;
      ctx.fillText(o.tick(v), X(v), PAD_T + plotH + 5);
    }
    ctx.fillText(o.axis, PAD_L + plotW / 2, H - 12);

    (o.refs || []).forEach(r => {
      ctx.strokeStyle = '#555';
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(X(r.v), PAD_T); ctx.lineTo(X(r.v), PAD_T + plotH); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#777';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(r.label, X(r.v) + 3, PAD_T + 2);
    });

    const m = med(vals);
    ctx.strokeStyle = '#fff';
    ctx.beginPath(); ctx.moveTo(X(m), PAD_T - 6); ctx.lineTo(X(m), PAD_T + plotH); ctx.stroke();
    ctx.fillStyle = '#ddd';
    ctx.textBaseline = 'bottom';
    ctx.textAlign = X(m) > PAD_L + plotW * 0.7 ? 'right' : 'left';
    ctx.fillText(`median ${o.fmt(m)}`, X(m) + (ctx.textAlign === 'right' ? -3 : 3), PAD_T - 8);

    // where the highlighted aircraft sits in the distribution
    (o.marks || []).forEach(mk => {
      ctx.strokeStyle = mk.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(X(mk.v), PAD_T + plotH);
      ctx.lineTo(X(mk.v), PAD_T + plotH - 9);
      ctx.stroke();
      ctx.lineWidth = 1;
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
    let tip = document.getElementById('kanp-pattern-tip');
    if (idx == null) {
      if (tip) tip.style.display = 'none';
      if (last && last.hoverIdx != null) { last.hoverIdx = null; renderPlan(); }
      return;
    }
    if (last.hoverIdx !== idx) { last.hoverIdx = idx; renderPlan(); }
    if (!tip) {
      tip = document.createElement('div');
      tip.id = 'kanp-pattern-tip';
      tip.className = 'grid-tip';
      document.body.appendChild(tip);
    }
    const l = last.legs[idx];
    tip.innerHTML = `<strong>${l.reg}</strong>${l.type ? ' · ' + l.type : ''} · RWY ${l.rwy}` +
      `<br>${fmtTs(l.ts, true)}<br>${l.width.toFixed(2)} nm downwind · ` +
      `${Math.round(l.agl).toLocaleString()} ft AGL` +
      (l.side === 'R' ? ' · right side' : '') +
      (l.lapS ? `<br>lap ${fmtDur(l.lapS)}` : '<br>entered the pattern') +
      (l.avgGs ? ` · ${Math.round(l.avgGs)} kt` : '');
    tip.style.display = 'block';
    const r = tip.getBoundingClientRect();
    tip.style.left = `${Math.min(e.clientX + 12, window.innerWidth - r.width - 6)}px`;
    tip.style.top = `${Math.max(6, e.clientY - r.height - 10)}px`;
  }

  function renderCards() {
    const legs = last.legs;
    const widths = legs.map(l => l.width);
    const alts = legs.map(l => l.agl);
    const closed = legs.filter(l => l.closed).length;
    const onTpa = legs.filter(l => Math.abs(l.agl - TPA_FT) <= 100).length;
    const r1 = legs.filter(l => l.rwy === KANP.RWY.names[1]).length;
    const set = (id, v) => { document.getElementById(id).textContent = v; };
    set('pc-legs', legs.length.toLocaleString());
    set('pc-width', med(widths).toFixed(2));
    set('pc-alt', Math.round(med(alts)).toLocaleString());
    set('pc-tpa', `${Math.round(100 * onTpa / legs.length)}%`);
    set('pc-closed', closed.toLocaleString());
    set('pc-rwy', `${Math.round(100 * r1 / legs.length)}%`);
    document.getElementById('pc-rwy-lbl').textContent =
      `downwinds for RWY ${KANP.RWY.names[1]}`;
  }

  function renderSummary() {
    const el = document.getElementById('pattern-summary');
    const legs = last.legs;
    const n = needle();
    const mine = legs.filter(isHighlighted);
    const rest = n ? legs.filter(l => !isHighlighted(l)) : legs;
    const say = ls => {
      const w = med(ls.map(l => l.width)), a = med(ls.map(l => l.agl));
      return w == null ? '—' : `${w.toFixed(2)} nm at ${Math.round(a)} ft AGL`;
    };
    const wrong = legs.filter(l => l.side === 'R').length;
    // KANP is left traffic at both ends (SITE.tracker.runway.pattern); a
    // right-side reading is a measured leg, not an inferred pattern side, so
    // report the count and let the plan view show what it looked like.
    const side = wrong ? ` · ${wrong} measured on the right side of the runway ` +
      `(KANP is left traffic both ends)` : '';
    el.textContent = n && mine.length
      ? `${n}: median ${say(mine)} over ${mine.length} downwind(s) · ` +
        `everyone else: median ${say(rest)} over ${rest.length}${side}`
      : `${legs.length} downwinds, median ${say(legs)} · ` +
        `field elevation ${SITE.airport.elevFt} ft, so TPA ${TPA_FT} ft AGL is ` +
        `${(TPA_FT + SITE.airport.elevFt).toLocaleString()} ft MSL` +
        (n ? ` · no downwinds matched "${n}"` : '') + side;
  }

  // per-aircraft: what this tail number's own normal pattern looks like
  function renderRank() {
    const byReg = new Map();
    for (const l of last.legs) {
      let e = byReg.get(l.reg);
      if (!e) byReg.set(l.reg, e = { reg: l.reg, hex: l.hex, type: l.type, ls: [] });
      e.ls.push(l);
    }
    const rows = [...byReg.values()]
      .map(e => ({
        ...e, n: e.ls.length,
        width: med(e.ls.map(l => l.width)), agl: med(e.ls.map(l => l.agl)),
        closed: e.ls.filter(l => l.closed).length,
      }))
      .sort((a, b) => b.n - a.n || a.width - b.width);

    const tbody = document.querySelector('#pattern-rank tbody');
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
        e.closed,
        e.width.toFixed(2),
        Math.round(e.agl).toLocaleString(),
      ].map(c => `<td>${c}</td>`).join('');
      tr.addEventListener('click', ev => {
        if (ev.target.closest('a')) return;      // let the globe link work
        document.getElementById('pattern-reg').value = e.reg;
        renderAll();
      });
      tbody.appendChild(tr);
    });
  }

  function renderTable() {
    const tbody = document.querySelector('#pattern-table tbody');
    tbody.innerHTML = '';
    last.legs.forEach((l, i) => {
      const tr = document.createElement('tr');
      if (isHighlighted(l)) tr.style.background = '#20304a';
      tr.innerHTML = [
        fmtTs(l.ts, true),
        `<a href="https://globe.adsbexchange.com/?icao=${encodeURIComponent(l.hex)}"` +
          ` target="_blank" rel="noopener">${l.reg}</a>`,
        l.type || '—',
        `RWY ${l.rwy}`,
        l.closed ? 'lap' : 'entry',
        l.width.toFixed(2) +
          (l.side === 'R' ? ' <span style="color:#f59e0b" title="right side">R</span>' : ''),
        Math.round(l.agl).toLocaleString(),
        l.lapS ? fmtDur(l.lapS) : '—',
      ].map(c => `<td>${c}</td>`).join('');
      tr.addEventListener('mouseenter', () => { last.hoverIdx = i; renderPlan(); });
      tr.addEventListener('mouseleave', () => { last.hoverIdx = null; renderPlan(); });
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

  function fmtDur(s) {
    return `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
  }

  // exposed for console inspection (e.g. checking a leg's measured geometry)
  return { legs: () => last && last.legs };
})();
