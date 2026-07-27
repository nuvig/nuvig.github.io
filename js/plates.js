// Approach Plate Decoder — draws a schematic FAA instrument approach chart as
// SVG and makes every item on it clickable.
//
// Geometry comes from data/procedures/apt/{ICAO}.json (the FAA CIFP cycle built
// by scripts/build_procedures.py — same leg-array layout, mirrored below), so
// courses, fixes, altitudes, glidepath angles, runways and field elevations
// refresh with the AIRAC cycle. Chart-face content CIFP does not carry
// (frequencies, minimums, notes) is authored in js/plates-data.js and marked
// illustrative.

const L_FIX = 0, L_LAT = 1, L_LON = 2, L_PT = 3, L_TURN = 4, L_ADESC = 5,
      L_A1 = 6, L_A2 = 7, L_SPD = 8, L_CRS = 9, L_DIST = 10, L_VA = 11,
      L_FLAGS = 12, L_REC = 13, L_THETA = 14, L_RHO = 15, L_CTR = 16;

(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const NM_LAT = 60, D2R = Math.PI / 180;
  const SVGNS = 'http://www.w3.org/2000/svg';

  /* ------------------------------------------------------------- geo math */

  function distNm(a, b) {
    const dy = (b[0] - a[0]) * NM_LAT;
    const dx = (b[1] - a[1]) * NM_LAT * Math.cos((a[0] + b[0]) / 2 * D2R);
    return Math.hypot(dx, dy);
  }
  function brgTo(a, b) {
    const dy = b[0] - a[0];
    const dx = (b[1] - a[1]) * Math.cos((a[0] + b[0]) / 2 * D2R);
    return (Math.atan2(dx, dy) / D2R + 360) % 360;
  }
  function dest(p, brg, nm) {
    return [p[0] + nm * Math.cos(brg * D2R) / NM_LAT,
            p[1] + nm * Math.sin(brg * D2R) / (NM_LAT * Math.cos(p[0] * D2R))];
  }
  function arcPts(ctr, r, b1, b2, turn) {
    let sweep = (b2 - b1 + 360) % 360;
    if (turn === 'L') sweep -= 360;
    else if (turn !== 'R') sweep = sweep > 180 ? sweep - 360 : sweep;
    const n = Math.max(2, Math.ceil(Math.abs(sweep) / 5)), out = [];
    for (let i = 1; i <= n; i++) out.push(dest(ctr, b1 + sweep * i / n, r));
    return out;
  }
  function holdPts(fix, crs, legNm, turn) {
    const t = turn === 'L' ? -1 : 1;
    const r = Math.max(0.45, Math.min(2.2, legNm * 0.22));
    const A = fix, B = dest(fix, (crs + 180) % 360, legNm);
    const side = (crs + t * 90 + 360) % 360;
    const cA = dest(A, side, r), cB = dest(B, side, r);
    const dir = t === -1 ? 'L' : 'R';
    const pts = [B, A];
    pts.push(...arcPts(cA, r, (crs - t * 90 + 360) % 360, side, dir));
    pts.push(dest(B, side, 2 * r));
    pts.push(...arcPts(cB, r, side, (crs - t * 90 + 360) % 360, dir));
    pts.push(B);
    return pts;
  }

  /* ------------------------------------------- CIFP procedure -> geometry */

  function constraintAlt(leg) {
    const d = leg[L_ADESC], a1 = leg[L_A1], a2 = leg[L_A2];
    if (a1 == null && a2 == null) return null;
    if (d === 'B' && a1 != null && a2 != null) return Math.min(a1, a2);
    return a1 != null ? a1 : a2;
  }
  function consText(leg) {
    const d = leg[L_ADESC], a1 = leg[L_A1], a2 = leg[L_A2];
    const fmt = v => v.toLocaleString();
    if (a1 == null && a2 == null) return null;
    if (d === '+') return fmt(a1);
    if (d === '-') return fmt(a1) + ' max';
    if (d === 'B') return fmt(Math.min(a1, a2)) + '–' + fmt(Math.max(a1, a2));
    return fmt(a1 != null ? a1 : a2);
  }

  // Walk one transition's legs into polylines plus a fix list.
  //
  // CIFP marks only the *first* missed-approach leg (ARINC waypoint description
  // code 'M'), so the flag is treated as sticky: once it appears, this leg and
  // every leg after it in the transition belong to the missed approach.
  function walk(doc, trans) {
    const mv = doc.mv || 0;
    const toTrue = m => m == null ? null : (m + mv + 360) % 360;
    const segs = [], fixes = [];
    let cur = null, seg = null, lastAlt = null, inMissed = false;

    const openSeg = (missed) => { seg = { pts: [], missed: !!missed }; segs.push(seg); };
    const need = (missed) => {
      if (!seg || seg.missed !== !!missed) { const from = cur; openSeg(missed); if (from) seg.pts.push(from); }
    };
    const push = p => { seg.pts.push(p); };

    for (const leg of trans.legs) {
      const pt = leg[L_PT];
      const pos = leg[L_LAT] != null ? [leg[L_LAT], leg[L_LON]] : null;
      if (leg[L_FLAGS] & 1) inMissed = true;
      const missed = inMissed;
      const crsT = toTrue(leg[L_CRS]);
      const alt = constraintAlt(leg);
      if (alt != null) lastAlt = alt;

      const note = p => {
        if (!leg[L_FIX] || !p) return;
        fixes.push({
          name: leg[L_FIX], lat: p[0], lon: p[1], alt, altText: consText(leg),
          missed, flyover: !!(leg[L_FLAGS] & 2), pt,
          hold: /^H[AFM]$/.test(pt || '')
            ? { crs: crsT, len: leg[L_DIST] || 4, turn: leg[L_TURN] } : null
        });
      };

      switch (pt) {
        case 'IF':
          if (pos) { cur = pos; seg = null; note(pos); }
          break;
        case 'TF': case 'CF': case 'DF':
          if (pos) { need(missed); if (!seg.pts.length && cur) push(cur); push(pos); note(pos); cur = pos; }
          break;
        case 'RF':
          if (pos && leg[L_CTR] && cur) {
            need(missed); if (!seg.pts.length) push(cur);
            const c = leg[L_CTR];
            arcPts(c, distNm(c, pos), brgTo(c, cur), brgTo(c, pos), leg[L_TURN]).forEach(push);
            push(pos); note(pos); cur = pos;
          } else if (pos) { need(missed); if (!seg.pts.length && cur) push(cur); push(pos); note(pos); cur = pos; }
          break;
        case 'AF':
          if (pos && leg[L_REC] && cur) {
            need(missed); if (!seg.pts.length) push(cur);
            const c = [leg[L_REC][1], leg[L_REC][2]];
            arcPts(c, leg[L_RHO] || distNm(c, pos), brgTo(c, cur), brgTo(c, pos), leg[L_TURN]).forEach(push);
            push(pos); note(pos); cur = pos;
          } else if (pos) { need(missed); if (!seg.pts.length && cur) push(cur); push(pos); note(pos); cur = pos; }
          break;
        case 'HA': case 'HF': case 'HM':
          if (pos) {
            note(pos);
            if (cur && distNm(cur, pos) > 0.05) { need(missed); if (!seg.pts.length) push(cur); push(pos); }
            cur = pos; seg = null;
          }
          break;
        default: {                                   // CA/VA/CI/VM/FM/PI/…
          if (pos && (pt === 'FA' || pt === 'FM')) { note(pos); cur = pos; }
          if (!cur) break;
          let len = leg[L_DIST] || 3;
          if ((pt === 'CA' || pt === 'VA') && alt != null && lastAlt != null)
            len = Math.max(1, Math.min(12, (alt - lastAlt) / 400));
          if (crsT != null) {
            need(missed); if (!seg.pts.length) push(cur);
            cur = dest(cur, crsT, Math.max(0.8, Math.min(15, len)));
            push(cur); seg = null;
          }
          if (pos && pt !== 'FA' && pt !== 'FM') { note(pos); cur = pos; }
        }
      }
    }
    // hold racetracks
    for (const f of fixes) {
      if (!f.hold || f.hold.crs == null) continue;
      segs.push({ pts: holdPts([f.lat, f.lon], f.hold.crs, f.hold.len, f.hold.turn), missed: f.missed, hold: true });
    }
    return { segs: segs.filter(s => s.pts.length > 1), fixes };
  }

  // Full model for one charted procedure.
  function analyse(doc, proc) {
    const parts = proc.trans.map(t => ({ kind: t.k, name: t.t, legs: t.legs, ...walk(doc, t) }));
    const finalP = parts.find(p => p.kind === 'final') || parts[0];
    const ff = finalP.fixes.filter(f => !f.missed);
    const map = ff[ff.length - 1] || null;

    // FAF = the last named fix before the leg where the coded vertical path starts
    let faf = null, seen = null, va = null;
    for (const lg of finalP.legs) {
      if (lg[L_FLAGS] & 1) break;
      if (lg[L_VA] != null) { faf = seen; va = Math.abs(lg[L_VA]); break; }
      if (lg[L_FIX]) seen = lg[L_FIX];
    }
    if (!faf && ff.length > 1) faf = ff[ff.length - 2].name;

    const iafs = new Set();
    for (const p of parts) if (p.kind !== 'final' && p.fixes.length) iafs.add(p.fixes[0].name);
    if (!iafs.size && ff.length) iafs.add(ff[0].name);

    // missed approach numbers
    let climbTo = null, holdFix = null, holdAlt = null, inMissed = false;
    for (const lg of finalP.legs) {
      if (lg[L_FLAGS] & 1) inMissed = true;
      if (!inMissed) continue;
      if (climbTo == null && /^[CV]A$/.test(lg[L_PT])) climbTo = constraintAlt(lg);
      if (lg[L_PT] === 'HM' || lg[L_PT] === 'HF') { holdFix = lg[L_FIX]; holdAlt = constraintAlt(lg); }
    }

    // every fix, de-duplicated (a fix can appear in several transitions, and
    // only one of those occurrences may carry the hold or the altitude)
    const byName = new Map();
    for (const p of parts) for (const f of p.fixes) {
      const prev = byName.get(f.name);
      if (!prev) { byName.set(f.name, { ...f }); continue; }
      if (prev.missed && !f.missed) byName.set(f.name, { ...f, hold: prev.hold || f.hold });
      else {
        if (!prev.hold && f.hold && !f.missed) prev.hold = f.hold;
        if (prev.alt == null && f.alt != null && !f.missed) { prev.alt = f.alt; prev.altText = f.altText; }
      }
    }
    for (const [name, f] of byName) {
      f.role = name === (map && map.name) ? 'map'
        : name === faf ? 'faf'
        : name === holdFix && f.missed ? 'mahf'
        : iafs.has(name) ? 'iaf'
        : name === (ff[0] && ff[0].name) ? 'if'
        : 'fix';
      if (f.hold && !f.missed) f.hilpt = true;
    }

    // conventional navaid referenced by the legs (VOR/LOC the procedure is built on)
    let recNav = null;
    for (const p of parts) for (const lg of p.legs)
      if (lg[L_REC] && !recNav) recNav = { id: lg[L_REC][0], lat: lg[L_REC][1], lon: lg[L_REC][2] };

    // Prefer the magnetic course CIFP codes on the last leg *before* the missed
    // approach starts; TF legs carry no course, so fall back to a bearing.
    let missedAt = finalP.legs.findIndex(lg => lg[L_FLAGS] & 1);
    if (missedAt < 0) missedAt = finalP.legs.length;
    let codedCrs = null;
    for (let i = missedAt - 1; i >= 0; i--) {
      const lg = finalP.legs[i];
      if (lg[L_CRS] != null && /^(CF|FC|FA|FM|CD)$/.test(lg[L_PT])) { codedCrs = lg[L_CRS]; break; }
    }

    // The final segment is the authority on a fix's altitude: the same fix can
    // carry a higher en-route constraint on a feeder transition.
    for (const f of finalP.fixes) {
      if (f.missed || f.alt == null) continue;
      const e = byName.get(f.name);
      if (e) { e.alt = f.alt; e.altText = f.altText; }
    }

    return { parts, finalP, ff, map, faf, va, iafs, climbTo, holdFix, holdAlt, fixes: byName, recNav, codedCrs };
  }

  /* ---------------------------------------------------------- svg helpers */

  let SVG, gHi, gInk, gHit, zones;

  const el = (n, a) => {
    const e = document.createElementNS(SVGNS, n);
    for (const k in a) if (a[k] != null) e.setAttribute(k, a[k]);
    return e;
  };
  const add = (p, n, a) => { const e = el(n, a); p.appendChild(e); return e; };

  function T(x, y, s, o) {
    o = o || {};
    const t = add(gInk, 'text', {
      x, y, 'font-size': o.size || 12, 'text-anchor': o.anchor || 'start',
      fill: o.fill || '#000', 'font-weight': o.weight || 'normal',
      'font-style': o.italic ? 'italic' : null,
      'letter-spacing': o.ls || null, transform: o.rot ? `rotate(${o.rot} ${x} ${y})` : null
    });
    t.textContent = s == null ? '' : String(s);
    return t;
  }
  const R = (x, y, w, h, o) => add(gInk, 'rect', {
    x, y, width: w, height: h, fill: (o && o.fill) || 'none',
    stroke: (o && o.stroke) || '#000', 'stroke-width': (o && o.sw) || 1,
    rx: (o && o.rx) || 0, 'stroke-dasharray': (o && o.dash) || null
  });
  const LN = (x1, y1, x2, y2, o) => add(gInk, 'line', {
    x1, y1, x2, y2, stroke: (o && o.stroke) || '#000',
    'stroke-width': (o && o.sw) || 1, 'stroke-dasharray': (o && o.dash) || null,
    'stroke-linecap': (o && o.cap) || null
  });
  const PL = (pts, o) => add((o && o.layer) || gInk, 'polyline', {
    points: pts.map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' '),
    fill: 'none', stroke: (o && o.stroke) || '#000', 'stroke-width': (o && o.sw) || 1,
    'stroke-dasharray': (o && o.dash) || null, 'stroke-linejoin': 'round', 'stroke-linecap': 'round'
  });

  // Register an interactive region. Small zones win because we sort by area.
  function zone(id, x, y, w, h) { zones.push({ id, x, y, w, h }); }

  // Wrap text into lines of at most `cw` characters, drawn from y downward.
  function wrap(x, y, s, cw, o) {
    const words = String(s).split(/\s+/), lines = [];
    let line = '';
    for (const w of words) {
      if ((line + ' ' + w).trim().length > cw) { lines.push(line.trim()); line = w; }
      else line += ' ' + w;
    }
    if (line.trim()) lines.push(line.trim());
    const lh = (o && o.lh) || ((o && o.size) || 11) + 3;
    lines.forEach((l, i) => T(x, y + i * lh, l, o));
    return y + lines.length * lh;
  }

  /* --------------------------------------------------------------- layout */

  const W = 1000, H = 1292;
  const LAY = {
    top: { x: 10, y: 10, w: 980, h: 22 },
    r1: { y: 36, h: 60 },
    r2: { y: 96, h: 88 },
    r3: { y: 184, h: 34 },
    r4: { y: 218, h: 34 },
    plan: { x: 10, y: 258, w: 980, h: 484 },
    prof: { x: 10, y: 748, w: 762, h: 204 },
    rate: { x: 778, y: 748, w: 212, h: 204 },
    sketch: { x: 10, y: 958, w: 324, h: 222 },
    mins: { x: 340, y: 958, w: 650, h: 180 },
    inop: { x: 340, y: 1144, w: 650, h: 36 },
    bot: { x: 10, y: 1190, w: 980, h: 46 }
  };

  /* --------------------------------------------------------- plate drawing */

  function drawPlate(plate, doc, proc) {
    const m = analyse(doc, proc);

    SVG.setAttribute('viewBox', `0 0 ${W} ${H}`);
    SVG.textContent = '';
    gHi = add(SVG, 'g', { class: 'hi-layer' });
    gInk = add(SVG, 'g', { class: 'ink-layer' });
    gHit = add(SVG, 'g', { class: 'hit-layer' });
    zones = [];

    add(gInk, 'rect', { x: 0, y: 0, width: W, height: H, fill: '#fbfaf6' });

    drawTopMargin(plate, doc);
    drawBriefing(plate, doc, m);
    drawPlan(plate, doc, m);
    drawProfile(plate, doc, m);
    drawRateTable(plate, m);
    drawSketch(plate, doc);
    drawMins(plate);
    drawBottom(plate, doc);

    // small zones on top so they win the hit test
    zones.sort((a, b) => b.w * b.h - a.w * a.h);
    for (const z of zones) {
      add(gHi, 'rect', { x: z.x, y: z.y, width: z.w, height: z.h, class: 'hi', 'data-el': z.id, rx: 3 });
      add(gHit, 'rect', { x: z.x, y: z.y, width: z.w, height: z.h, class: 'hit', 'data-el': z.id });
    }
    return m;
  }

  function drawTopMargin(plate, doc) {
    const b = LAY.top;
    T(b.x, b.y + 15, (plate.amdt || '') + '   ' + cycleJulian(), { size: 12, weight: 'bold' });
    zone('amdt', b.x - 2, b.y, 200, b.h);
    T(W / 2, b.y + 15, plate.chartRef || '', { size: 12, anchor: 'middle', weight: 'bold' });
    zone('chart-ref', W / 2 - 90, b.y, 180, b.h);
    T(b.x + b.w, b.y + 15, doc.id, { size: 12, anchor: 'end', weight: 'bold' });
  }

  function drawBriefing(plate, doc, m) {
    const br = plate.brief || {};
    const y1 = LAY.r1.y, h1 = LAY.r1.h;
    R(10, y1, 980, LAY.r4.y + LAY.r4.h - y1, { sw: 1.4 });
    zone('brief-strip', 10, y1, 980, LAY.r4.y + LAY.r4.h - y1);

    // --- row 1 : navaid | course | glideslope alt | rwy/tdze | title
    const c = [10, 250, 380, 510, 660, 990];
    for (let i = 1; i < c.length - 1; i++) LN(c[i], y1, c[i], y1 + h1);
    LN(10, y1 + h1, 990, y1 + h1);

    T(c[0] + 8, y1 + 20, br.navLabel || 'GPS', { size: 15, weight: 'bold' });
    T(c[0] + 8, y1 + 40, br.navFreq || '', { size: 17, weight: 'bold' });
    T(c[0] + 130, y1 + 40, br.navIdent || '', { size: 15, weight: 'bold' });
    if (br.navIdent) T(c[0] + 130, y1 + 54, morse(br.navIdent.replace(/^I-/, '')), { size: 10, ls: '1' });
    if (br.chan) T(c[0] + 8, y1 + 54, 'Chan ' + br.chan, { size: 10 });
    zone('nav-freq', c[0], y1, c[1] - c[0], h1);

    const crs = m.ff.length ? finalCourseMag(doc, m) : null;
    T(c[1] + 8, y1 + 18, 'APP CRS', { size: 11 });
    T((c[1] + c[2]) / 2, y1 + 44, crs == null ? '—' : pad3(crs) + '°', { size: 22, anchor: 'middle', weight: 'bold' });
    zone('app-crs', c[1], y1, c[2] - c[1], h1);

    const fafFix = m.fixes.get(m.faf);
    T(c[2] + 8, y1 + 18, m.va ? 'GS/GP ALT' : 'FAF ALT', { size: 11 });
    T((c[2] + c[3]) / 2, y1 + 40, fafFix && fafFix.alt ? fafFix.alt.toLocaleString() : '—',
      { size: 19, anchor: 'middle', weight: 'bold' });
    T((c[2] + c[3]) / 2, y1 + 54, m.va ? m.va.toFixed(2) + '° GP' : 'no glidepath',
      { size: 10, anchor: 'middle' });
    zone('gs-alt', c[2], y1, c[3] - c[2], h1);

    const rw = runwayFor(doc, plate.title);
    T(c[3] + 8, y1 + 16, 'Rwy Idg  ' + (rw ? Math.round(rw[4]).toLocaleString() : (br.rwyIdg || '—')), { size: 11 });
    T(c[3] + 8, y1 + 32, 'TDZE  ' + (br.tdze != null ? br.tdze.toLocaleString() : '—'), { size: 11 });
    T(c[3] + 8, y1 + 48, 'Apt Elev  ' + Math.round(doc.elev).toLocaleString(), { size: 11, weight: 'bold' });
    zone('rwy-tdze', c[3], y1, c[4] - c[3], h1);

    T(c[4] + 10, y1 + 26, plate.title, { size: 17, weight: 'bold' });
    T(c[4] + 10, y1 + 46, doc.name, { size: 11 });
    T(c[4] + 10, y1 + 58, plate.city, { size: 10 });
    zone('margin-title', c[4], y1, c[5] - c[4], h1);

    // --- row 2 : notes | missed approach text
    const y2 = LAY.r2.y, h2 = LAY.r2.h, xm = 510;
    LN(xm, y2, xm, y2 + h2 + LAY.r3.h);
    LN(10, y2 + h2 + LAY.r3.h, 990, y2 + h2 + LAY.r3.h);

    let ny = y2 + 16;
    (br.notes || []).forEach(n => { ny = wrap(24, ny, '• ' + n, 62, { size: 10.5, lh: 13 }) + 3; });
    zone('proc-notes', 10, y2, xm - 10, h2);

    // alternate / takeoff minimums flags sit in the notes band
    const fy = LAY.r3.y;
    if (br.flagAlt) { tri(28, fy + 22, 9); T(40, fy + 24, 'N', { size: 12, weight: 'bold' }); }
    if (br.flagTo) { T(70, fy + 24, 'T', { size: 12, weight: 'bold' }); tri(86, fy + 22, 9); }
    T(110, fy + 24, 'Alternate / takeoff minimums — see front of book', { size: 9.5, italic: true, fill: '#333' });
    zone('nonstd-symbols', 10, fy, 200, LAY.r3.h);

    T(xm + 10, y2 + 16, 'MISSED APPROACH', { size: 11, weight: 'bold', ls: '0.5' });
    wrap(xm + 10, y2 + 32, missedText(plate, m), 58, { size: 11, lh: 14 });
    zone('missed-text', xm, y2, 990 - xm, h2);

    drawMissedIcons(xm + 14, fy + 6, m);
    zone('missed-icons', xm, fy, 990 - xm, LAY.r3.h);

    // --- row 4 : comm strip
    const y4 = LAY.r4.y, h4 = LAY.r4.h;
    add(gInk, 'rect', { x: 10, y: y4, width: 980, height: h4, fill: '#e9e6dd' });
    const comms = br.comms || [];
    const cw = 980 / Math.max(1, comms.length);
    comms.forEach((f, i) => {
      const x = 10 + i * cw;
      if (i) LN(x, y4 + 4, x, y4 + h4 - 4, { stroke: '#666' });
      T(x + cw / 2, y4 + 14, f[0], { size: 9.5, anchor: 'middle' });
      T(x + cw / 2, y4 + 27, f[1], { size: 12, anchor: 'middle', weight: 'bold' });
    });
    zone('comm-strip', 10, y4, 980, h4);
  }

  function tri(x, y, s) {
    add(gInk, 'polygon', { points: `${x},${y - s} ${x - s * 0.8},${y + s * 0.5} ${x + s * 0.8},${y + s * 0.5}`, fill: '#000' });
  }

  function missedText(plate, m) {
    // Not every procedure codes a straight-ahead climb leg; some go directly to
    // the holding fix, and then the hold altitude is the only climb published.
    if (m.climbTo == null)
      return m.holdFix
        ? 'Climb to ' + (m.holdAlt ? m.holdAlt.toLocaleString() + ' ' : '') + 'direct ' + m.holdFix + ' and hold.'
        : 'Climb as published.';
    let s = 'Climb to ' + m.climbTo.toLocaleString();
    if (m.holdFix) {
      s += ', then climbing turn to ' + (m.holdAlt ? m.holdAlt.toLocaleString() + ' ' : '')
        + 'direct ' + m.holdFix + ' and hold';
    }
    return s + '.';
  }

  function drawMissedIcons(x, y, m) {
    const g = (dx, fn) => fn(x + dx, y);
    // climb
    g(0, (px, py) => {
      PL([[px, py + 22], [px + 22, py + 4]], { sw: 2 });
      arrow(px + 22, py + 4, 315);
      T(px + 26, py + 22, (m.climbTo || m.holdAlt) ? (m.climbTo || m.holdAlt).toLocaleString() : '', { size: 10 });
    });
    // turn + direct
    g(96, (px, py) => {
      PL([[px, py + 22], [px + 10, py + 8], [px + 30, py + 8]], { sw: 2 });
      arrow(px + 30, py + 8, 90);
      T(px + 34, py + 22, m.holdFix || '', { size: 10 });
    });
    // hold
    g(196, (px, py) => {
      add(gInk, 'rect', { x: px, y: py + 6, width: 34, height: 15, rx: 7.5, fill: 'none', stroke: '#000', 'stroke-width': 2 });
      T(px + 40, py + 20, m.holdAlt ? m.holdAlt.toLocaleString() : '', { size: 10 });
    });
  }

  function arrow(x, y, brg, size) {
    const s = size || 7, a = brg * D2R;
    const tipx = x, tipy = y;
    const bx = x - Math.sin(a) * s, by = y + Math.cos(a) * s;
    const px = Math.cos(a) * s * 0.45, py = Math.sin(a) * s * 0.45;
    add(gInk, 'polygon', { points: `${tipx},${tipy} ${bx + px},${by + py} ${bx - px},${by - py}`, fill: '#000' });
  }

  /* ------------------------------------------------------------- plan view */

  function drawPlan(plate, doc, m) {
    const b = LAY.plan;
    R(b.x, b.y, b.w, b.h, { sw: 1.4, fill: '#fff' });
    zone('planview', b.x, b.y, b.w, b.h);

    const clipId = 'planclip';
    const cp = add(SVG, 'clipPath', { id: clipId });
    cp.appendChild(el('rect', { x: b.x + 2, y: b.y + 2, width: b.w - 4, height: b.h - 4 }));
    const gPlan = add(gInk, 'g', { 'clip-path': `url(#${clipId})` });

    // fit non-missed geometry
    const pts = [];
    for (const p of m.parts) for (const s of p.segs) if (!s.missed) pts.push(...s.pts);
    pts.push([doc.lat, doc.lon]);
    (doc.rw || []).forEach(r => pts.push([r[1], r[2]]));
    const lat0 = pts.reduce((a, p) => a + p[0], 0) / pts.length;
    const lon0 = pts.reduce((a, p) => a + p[1], 0) / pts.length;
    const kx = Math.cos(lat0 * D2R) * NM_LAT;
    const nm = p => [(p[1] - lon0) * kx, -(p[0] - lat0) * NM_LAT];
    const xs = pts.map(p => nm(p)[0]), ys = pts.map(p => nm(p)[1]);
    const pad = 0.14;
    let minx = Math.min(...xs), maxx = Math.max(...xs), miny = Math.min(...ys), maxy = Math.max(...ys);
    const spanx = Math.max(maxx - minx, 4), spany = Math.max(maxy - miny, 4);
    minx -= spanx * pad; maxx += spanx * pad; miny -= spany * pad; maxy += spany * pad;
    const inx = b.x + 108, iny = b.y + 14, inw = b.w - 128, inh = b.h - 34;
    const sc = Math.min(inw / (maxx - minx), inh / (maxy - miny));
    const ox = inx + (inw - (maxx - minx) * sc) / 2, oy = iny + (inh - (maxy - miny) * sc) / 2;
    const P = p => { const q = nm(p); return [ox + (q[0] - minx) * sc, oy + (q[1] - miny) * sc]; };
    const inBox = p => p[0] > b.x && p[0] < b.x + b.w && p[1] > b.y && p[1] < b.y + b.h;

    // label placement — keep a list of claimed rectangles and nudge around them
    const placed = [];
    const hits = (x, y, w, h) => placed.some(r =>
      x < r.x + r.w && x + w > r.x && y < r.y + r.h && y + h > r.y);
    const claim = (x, y, w, h) => placed.push({ x, y, w, h });
    function findSpot(cx, cy, w, h) {
      const dys = [-h / 2, -h - 7, 7, -h - 22, 22, -h - 37, 37];
      for (const dy of dys) for (const right of [true, false]) {
        const x = right ? cx + 9 : cx - 9 - w, y = cy + dy;
        if (!hits(x, y, w, h)) { claim(x, y, w, h); return { right, dx: 0, y }; }
      }
      claim(cx + 9, cy - h / 2, w, h);
      return { right: true, dx: 0, y: cy - h / 2 };
    }
    claim(b.x + 14, b.y + 14, 92, 92);                      // MSA circle
    claim(b.x + 18, b.y + b.h - 78, 132, 74);               // north arrow + scale
    const aptPt = P([doc.lat, doc.lon]);
    claim(aptPt[0] - 19, aptPt[1] - 19, 38, 38);            // airport symbol

    // terrain (schematic) where the procedure sits high above the field
    if (plate.msa && plate.msa.alt - doc.elev > 4000) {
      for (let i = 0; i < 7; i++) {
        const t = i / 6;
        add(gPlan, 'path', {
          d: `M ${b.x} ${b.y + 40 + i * 26} q ${b.w * 0.28} ${-34 - i * 5} ${b.w * 0.5} ${8 + i * 3} t ${b.w * 0.5} ${-6}`,
          fill: 'none', stroke: '#b8905f', 'stroke-width': 1, opacity: 0.45 - t * 0.2
        });
      }
      T(b.x + b.w - 12, b.y + b.h - 26, 'RISING TERRAIN', { size: 10, anchor: 'end', fill: '#8a6135', weight: 'bold' });
      T(b.x + b.w - 12, b.y + b.h - 14, 'contours schematic', { size: 8.5, anchor: 'end', fill: '#8a6135', italic: true });
      zone('terrain', b.x + b.w - 150, b.y + b.h - 40, 140, 34);
    }

    // prohibited / restricted airspace
    if (plate.sua) {
      const c = P([plate.sua.lat, plate.sua.lon]), r = plate.sua.r * sc;
      add(gPlan, 'circle', { cx: c[0], cy: c[1], r, fill: 'none', stroke: '#000', 'stroke-width': 1.6, 'stroke-dasharray': '1 4' });
      add(gPlan, 'circle', { cx: c[0], cy: c[1], r: r * 0.94, fill: '#000', opacity: 0.05 });
      T(c[0], c[1] + 4, plate.sua.label, { size: 10, anchor: 'middle', weight: 'bold' });
      zone('restricted', c[0] - r, c[1] - r, r * 2, r * 2);
    }

    // tracks
    for (const p of m.parts) for (const s of p.segs) {
      const scr = s.pts.map(P);
      PL(scr, {
        layer: gPlan, sw: s.missed ? 1.6 : (p.kind === 'final' && !s.hold ? 3 : 1.6),
        dash: s.missed ? '9 6' : (s.hold ? null : (p.kind === 'final' ? null : '10 5')),
        stroke: '#000'
      });
    }

    // course arrow on the final segment
    const finalSeg = m.finalP.segs.find(s => !s.missed && s.pts.length > 1);
    if (finalSeg) {
      const a = P(finalSeg.pts[finalSeg.pts.length - 2]), z = P(finalSeg.pts[finalSeg.pts.length - 1]);
      const brg = (Math.atan2(z[0] - a[0], -(z[1] - a[1])) / D2R + 360) % 360;
      arrow(z[0], z[1], brg, 11);
      const mid = [(a[0] + z[0]) / 2, (a[1] + z[1]) / 2];
      const crs = finalCourseMag(doc, m);
      if (crs != null) {
        claim(mid[0] + 4, mid[1] - 22, 48, 22);
        gPlan.appendChild(T(mid[0] + 8, mid[1] - 8, pad3(crs) + '°', { size: 13, weight: 'bold' }));
        zone('final-course', mid[0] - 30, mid[1] - 26, 76, 32);
      }
    }

    // Conventional navaid symbol (claimed before the fixes so labels dodge it).
    // Localizer-type aids get no compass rose: CIFP names them I-xxx / Ixxx, and
    // the chart's own navaid box already identifies the one this approach uses.
    const locIdent = ((plate.brief && plate.brief.navIdent) || '').replace(/-/g, '').toUpperCase();
    const isLoc = n => /^I[A-Z]{3}$/i.test(n) || /^I-/.test(n) || n.replace(/-/g, '').toUpperCase() === locIdent;
    if (m.recNav && !isLoc(m.recNav.id)) {
      const q = P([m.recNav.lat, m.recNav.lon]);
      if (inBox(q)) {
        claim(q[0] - 24, q[1] - 24, 48, 48);
        add(gPlan, 'circle', { cx: q[0], cy: q[1], r: 22, fill: 'none', stroke: '#000', 'stroke-width': 1 });
        for (let a = 0; a < 360; a += 30)
          add(gPlan, 'line', {
            x1: q[0] + Math.sin(a * D2R) * 19, y1: q[1] - Math.cos(a * D2R) * 19,
            x2: q[0] + Math.sin(a * D2R) * 22, y2: q[1] - Math.cos(a * D2R) * 22, stroke: '#000'
          });
        add(gPlan, 'polygon', {
          points: `${q[0]},${q[1] - 7} ${q[0] + 6},${q[1] - 3.5} ${q[0] + 6},${q[1] + 3.5} ${q[0]},${q[1] + 7} ${q[0] - 6},${q[1] + 3.5} ${q[0] - 6},${q[1] - 3.5}`,
          fill: 'none', stroke: '#000', 'stroke-width': 1.4
        });
        const sp = findSpot(q[0], q[1], m.recNav.id.length * 6.4 + 8, 14);
        gPlan.appendChild(T(q[0] + (sp.right ? 26 : -26), sp.y + 11, m.recNav.id,
          { size: 11, weight: 'bold', anchor: sp.right ? 'start' : 'end' }));
        zone('nav-symbol', q[0] - 24, q[1] - 24, 48, 48);
      }
    }

    // missed approach track / hold zones
    const missedSegs = m.finalP.segs.filter(s => s.missed);
    if (missedSegs.length) {
      const mp = missedSegs[0].pts.map(P).filter(inBox);
      if (mp.length) zone('missed-track', mp[0][0] - 26, mp[0][1] - 26, 52, 52);
      const hs = missedSegs.find(s => s.hold);
      if (hs) {
        const hp = hs.pts.map(P), hx = hp.map(q => q[0]), hy = hp.map(q => q[1]);
        zone('missed-hold', Math.min(...hx) - 6, Math.min(...hy) - 6,
             Math.max(6, Math.max(...hx) - Math.min(...hx) + 12),
             Math.max(6, Math.max(...hy) - Math.min(...hy) + 12));
      }
    }

    // fixes — labels are nudged until they stop colliding with each other
    for (const [name, f] of m.fixes) {
      const q = P([f.lat, f.lon]);
      if (!inBox(q)) continue;
      const g = add(gPlan, 'g', {});
      if (f.role === 'faf') maltese(g, q[0], q[1]);
      else if (f.role === 'map') { add(g, 'circle', { cx: q[0], cy: q[1], r: 5, fill: '#fff', stroke: '#000', 'stroke-width': 2 }); }
      else star(g, q[0], q[1], f.flyover);

      let sub = [];
      if (f.role === 'iaf') sub.push('(IAF)');
      if (f.role === 'if') sub.push('(IF)');
      if (f.role === 'faf') sub.push('(FAF)');
      if (f.role === 'map') sub.push('(MAP)');
      if (f.altText) sub.push(f.altText);
      const subs = sub.join('  ');
      const wpx = Math.max(name.length, subs.length) * 5.4 + 8;
      const hpx = subs ? 26 : 14;
      const spot = findSpot(q[0], q[1], wpx, hpx);
      const anchor = spot.right ? 'start' : 'end';
      const lx = q[0] + (spot.right ? 9 : -9) + spot.dx;
      g.appendChild(T(lx, spot.y + 10, name, { size: 11, weight: 'bold', anchor }));
      if (subs) g.appendChild(T(lx, spot.y + 22, subs, { size: 9.5, anchor }));

      const onFinal = m.ff.some(x => x.name === name);
      const zid = f.role === 'faf' ? 'faf' : f.role === 'map' ? 'map-fix'
        : f.role === 'iaf' ? 'iaf' : f.role === 'if' ? 'if-fix'
        : f.hilpt ? 'hilpt' : f.missed ? 'missed-track'
        : onFinal ? 'step-downs' : 'feeder';
      zone(zid, q[0] - 14, q[1] - 14, 70, 44);
      if (f.hilpt) zone('hilpt', q[0] - 40, q[1] - 40, 80, 80);
    }

    // 10 NM reference circle — the part of a real plan view that is to scale.
    // Skipped when it would swamp the view (a procedure that all fits inside it).
    const apc = P([doc.lat, doc.lon]);
    if (20 * sc < Math.max(inw, inh) * 1.15) {
      add(gPlan, 'circle', {
        cx: apc[0], cy: apc[1], r: 10 * sc, fill: 'none',
        stroke: '#000', 'stroke-width': 1, 'stroke-dasharray': '5 5', opacity: 0.5
      });
      const lp = [apc[0], apc[1] - 10 * sc];
      if (inBox(lp)) gPlan.appendChild(T(lp[0] + 5, lp[1] + 13, '10 NM', { size: 9, fill: '#333' }));
    }

    // airport
    const ap = P([doc.lat, doc.lon]);
    if (inBox(ap)) {
      const g = add(gPlan, 'g', {});
      (doc.rw || []).forEach(r => {
        const a = P([r[1], r[2]]);
        const e = P(dest([r[1], r[2]], (r[3] + (doc.mv || 0) + 360) % 360, r[4] / 6076.12));
        add(g, 'line', { x1: a[0], y1: a[1], x2: e[0], y2: e[1], stroke: '#000', 'stroke-width': 3.4 });
      });
      add(g, 'circle', { cx: ap[0], cy: ap[1], r: 15, fill: 'none', stroke: '#000', 'stroke-width': 1.2 });
      zone('airport-symbol', ap[0] - 17, ap[1] - 17, 34, 34);
    }

    // MSA circle
    if (plate.msa) {
      const cx = b.x + 60, cy = b.y + 60;
      add(gInk, 'circle', { cx, cy, r: 42, fill: '#fff', stroke: '#000', 'stroke-width': 1.2 });
      T(cx, cy - 16, 'MSA ' + plate.msa.ref, { size: 9, anchor: 'middle' });
      T(cx, cy + 4, plate.msa.alt.toLocaleString(), { size: 16, anchor: 'middle', weight: 'bold' });
      T(cx, cy + 18, plate.msa.r + ' NM', { size: 9, anchor: 'middle' });
      zone('msa', cx - 44, cy - 44, 88, 88);
    }

    // north arrow + scale
    const nx = b.x + 36, ny = b.y + b.h - 52;
    LN(nx, ny + 34, nx, ny, { sw: 1.4 });
    arrow(nx, ny, 0, 9);
    T(nx, ny - 12, 'N', { size: 12, anchor: 'middle', weight: 'bold' });
    const barNm = niceScale(60 / sc);
    LN(nx + 18, ny + 34, nx + 18 + barNm * sc, ny + 34, { sw: 1.6 });
    LN(nx + 18, ny + 30, nx + 18, ny + 38);
    LN(nx + 18 + barNm * sc, ny + 30, nx + 18 + barNm * sc, ny + 38);
    T(nx + 18, ny + 50, barNm + ' NM', { size: 9.5 });
    zone('north-scale', nx - 16, ny - 24, 130, 84);
  }

  function maltese(g, x, y) {
    const s = 8;
    add(g, 'path', {
      d: `M ${x - s} ${y - s} L ${x - s * 0.32} ${y - s * 0.32} L ${x + s} ${y - s}
          L ${x + s * 0.32} ${y - s * 0.32} L ${x + s} ${y + s} L ${x + s * 0.32} ${y + s * 0.32}
          L ${x - s} ${y + s} L ${x - s * 0.32} ${y + s * 0.32} Z`,
      fill: '#000'
    });
  }
  function star(g, x, y, filled) {
    const s = 7, p = [];
    for (let i = 0; i < 8; i++) {
      const a = i * 45 * D2R, r = i % 2 ? s * 0.34 : s;
      p.push(`${(x + Math.sin(a) * r).toFixed(1)},${(y - Math.cos(a) * r).toFixed(1)}`);
    }
    add(g, 'polygon', { points: p.join(' '), fill: filled ? '#000' : '#fff', stroke: '#000', 'stroke-width': 1.3 });
  }
  function niceScale(target) {
    const opts = [1, 2, 5, 10, 20, 50];
    return opts.reduce((a, v) => Math.abs(v - target) < Math.abs(a - target) ? v : a, 1);
  }

  /* ---------------------------------------------------------- profile view */

  function drawProfile(plate, doc, m) {
    const b = LAY.prof;
    R(b.x, b.y, b.w, b.h, { sw: 1.4, fill: '#fff' });
    zone('profile', b.x, b.y, b.w, b.h);

    const ff = m.ff;
    if (ff.length < 2) return;

    // distance of each final fix back from the MAP
    const d = new Array(ff.length).fill(0);
    for (let i = ff.length - 2; i >= 0; i--)
      d[i] = d[i + 1] + distNm([ff[i].lat, ff[i].lon], [ff[i + 1].lat, ff[i + 1].lon]);
    const maxD = Math.max(d[0], 1);

    // altitudes, interpolated where a fix has no constraint
    const alt = ff.map(f => f.alt);
    for (let i = 0; i < alt.length; i++) {
      if (alt[i] != null) continue;
      let lo = i, hi = i;
      while (lo >= 0 && alt[lo] == null) lo--;
      while (hi < alt.length && alt[hi] == null) hi++;
      if (lo < 0) alt[i] = alt[hi];
      else if (hi >= alt.length) alt[i] = alt[lo];
      else alt[i] = alt[lo] + (alt[hi] - alt[lo]) * (d[lo] - d[i]) / (d[lo] - d[hi] || 1);
    }
    const aMin = Math.min(...alt, doc.elev), aMax = Math.max(...alt, m.climbTo || 0, doc.elev + 500);

    const px0 = b.x + 56, px1 = b.x + b.w - 190, py0 = b.y + 34, py1 = b.y + b.h - 44;
    const X = nmBack => px0 + (1 - nmBack / maxD) * (px1 - px0);
    const Y = a => py1 - (a - aMin) / Math.max(1, aMax - aMin) * (py1 - py0);

    // ground
    LN(b.x + 8, py1 + 14, b.x + b.w - 8, py1 + 14, { sw: 1.2 });

    // path
    PL(ff.map((f, i) => [X(d[i]), Y(alt[i])]), { sw: 2.6 });

    // fixes
    ff.forEach((f, i) => {
      const x = X(d[i]), y = Y(alt[i]);
      LN(x, y - 4, x, py1 + 14, { dash: '3 3', stroke: '#555' });
      T(x, b.y + 20, f.name, { size: 10.5, anchor: 'middle', weight: 'bold' });
      if (f.alt != null)
        T(x, y - 10 < b.y + 30 ? y + 18 : y - 10, f.alt.toLocaleString(),
          { size: 11, anchor: 'middle', weight: 'bold' });
      if (d[i] > 0.05) T(x, py1 + 28, d[i].toFixed(1), { size: 9, anchor: 'middle', fill: '#444' });
    });
    T(b.x + 8, py1 + 40, 'NM to MAP', { size: 9, fill: '#444' });

    // FAF marker
    const fi = ff.findIndex(f => f.name === m.faf);
    if (fi >= 0) {
      const x = X(d[fi]), y = Y(alt[fi]);
      if (m.va) {                                   // lightning bolt = GS intercept
        add(gInk, 'path', {
          d: `M ${x - 5} ${y - 16} L ${x + 2} ${y - 5} L ${x - 3} ${y - 4} L ${x + 5} ${y + 10}
              L ${x - 1} ${y + 1} L ${x + 3} ${y} Z`, fill: '#000'
        });
      } else maltese(gInk, x, y - 14);
      zone('faf-profile', x - 20, y - 30, 40, 40);
    }

    // stepdowns between FAF and MAP
    if (fi >= 0 && ff.length - 1 - fi > 1) {
      const sx = X(d[fi + 1]);
      zone('step-downs', sx - 26, py0, 52, py1 - py0);
    }

    // glidepath angle callout
    if (m.va) {
      const gx = (X(d[Math.max(0, fi)]) + px1) / 2;
      T(gx, Y(alt[Math.max(0, fi)]) + 34, m.va.toFixed(2) + '°', { size: 15, weight: 'bold' });
      zone('gs-path', gx - 30, Y(alt[Math.max(0, fi)]) + 16, 74, 26);
    }

    // threshold crossing
    const last = ff[ff.length - 1];
    if (/^RW/.test(last.name) && last.alt != null) {
      const x = X(0);
      T(x - 6, py1 + 2, 'TCH', { size: 9.5, anchor: 'end' });
      T(x - 6, py1 + 12, (plate.brief && plate.brief.tdze != null)
        ? (last.alt - plate.brief.tdze) + ' ft' : last.alt.toLocaleString() + ' MSL',
        { size: 9.5, anchor: 'end' });
      zone('tch', x - 54, py1 - 6, 52, 26);
    }

    // missed approach
    const mx = X(0) + 14, my = Y(alt[alt.length - 1]);
    PL([[mx, my], [mx + 74, my - 52]], { sw: 2.4 });
    arrow(mx + 74, my - 52, 55, 9);
    T(mx + 86, my - 46, 'CLIMB ' + ((m.climbTo || m.holdAlt) ? (m.climbTo || m.holdAlt).toLocaleString() : ''), { size: 11, weight: 'bold' });
    if (m.holdFix) T(mx + 86, my - 32, 'to ' + m.holdFix + (m.holdAlt ? ' ' + m.holdAlt.toLocaleString() : ''), { size: 10 });
    zone('missed-profile', mx - 6, my - 62, 170, 78);
  }

  function drawRateTable(plate, m) {
    const b = LAY.rate;
    R(b.x, b.y, b.w, b.h, { sw: 1.4, fill: '#fff' });
    const gs = [70, 90, 100, 120, 140];
    let y = b.y + 20;
    T(b.x + 10, y, m.va ? 'RATE OF DESCENT' : 'DESCENT PLANNING', { size: 10.5, weight: 'bold', ls: '0.4' });
    y += 6;
    LN(b.x + 6, y, b.x + b.w - 6, y);
    y += 16;
    T(b.x + 10, y, 'GS (kt)', { size: 10 });
    gs.forEach((g, i) => T(b.x + 78 + i * 26, y, g, { size: 10, anchor: 'middle' }));
    y += 16;
    if (m.va) {
      const tan = Math.tan(m.va * D2R);
      T(b.x + 10, y, 'ft/min', { size: 10 });
      gs.forEach((g, i) => T(b.x + 78 + i * 26, y, Math.round(g * 101.27 * tan / 10) * 10,
        { size: 10, anchor: 'middle', weight: 'bold' }));
      y += 18;
      T(b.x + 10, y, Math.round(6076 * tan) + ' ft per NM at ' + m.va.toFixed(2) + '°', { size: 9.5, fill: '#333' });
    } else {
      T(b.x + 10, y, 'No published glidepath —', { size: 10 });
      T(b.x + 10, y + 14, 'this approach is flown to an', { size: 10 });
      T(b.x + 10, y + 28, 'MDA, not a DA.', { size: 10 });
      y += 28;
    }
    zone('rate-table', b.x, b.y, b.w, y - b.y + 12);

    // timing table
    if (plate.timing) {
      let ty = y + 30;
      LN(b.x + 6, ty - 16, b.x + b.w - 6, ty - 16);
      T(b.x + 10, ty, plate.timing.from + ' to ' + plate.timing.to, { size: 10, weight: 'bold' });
      ty += 16;
      T(b.x + 10, ty, plate.timing.nm.toFixed(1) + ' NM', { size: 10 });
      ty += 16;
      gs.forEach((g, i) => {
        const secs = Math.round(plate.timing.nm / g * 3600);
        T(b.x + 10 + (i % 3) * 66, ty + Math.floor(i / 3) * 15,
          g + ' kt ' + Math.floor(secs / 60) + ':' + String(secs % 60).padStart(2, '0'), { size: 9.5 });
      });
      zone('timing-table', b.x, y + 14, b.w, b.h - (y + 14 - b.y) - 4);
    }
  }

  /* ------------------------------------------------------- airport sketch */

  function drawSketch(plate, doc) {
    const b = LAY.sketch;
    R(b.x, b.y, b.w, b.h, { sw: 1.4, fill: '#fff' });
    zone('apt-sketch', b.x, b.y, b.w, b.h);

    const rws = doc.rw || [];
    if (rws.length) {
      const pts = [];
      rws.forEach(r => {
        pts.push([r[1], r[2]]);
        pts.push(dest([r[1], r[2]], (r[3] + (doc.mv || 0) + 360) % 360, r[4] / 6076.12));
      });
      const lat0 = pts.reduce((a, p) => a + p[0], 0) / pts.length;
      const lon0 = pts.reduce((a, p) => a + p[1], 0) / pts.length;
      const kx = Math.cos(lat0 * D2R) * NM_LAT;
      const nm = p => [(p[1] - lon0) * kx, -(p[0] - lat0) * NM_LAT];
      const xs = pts.map(p => nm(p)[0]), ys = pts.map(p => nm(p)[1]);
      const spanx = Math.max(...xs) - Math.min(...xs) || 0.5, spany = Math.max(...ys) - Math.min(...ys) || 0.5;
      const iw = b.w - 56, ih = b.h - 100;
      const sc = Math.min(iw / spanx, ih / spany);
      const ox = b.x + 28 + (iw - spanx * sc) / 2 - Math.min(...xs) * sc;
      const oy = b.y + 40 + (ih - spany * sc) / 2 - Math.min(...ys) * sc;
      const P = p => { const q = nm(p); return [ox + q[0] * sc, oy + q[1] * sc]; };

      const drawn = new Set();
      rws.forEach(r => {
        const num = r[0].replace('RW', '').replace(/[LRC]$/, '');
        const recip = String((parseInt(num, 10) + 17) % 36 + 1).padStart(2, '0');
        const key = [num, recip].sort().join('-');
        const a = P([r[1], r[2]]), e = P(dest([r[1], r[2]], (r[3] + (doc.mv || 0) + 360) % 360, r[4] / 6076.12));
        if (!drawn.has(key)) {
          drawn.add(key);
          LN(a[0], a[1], e[0], e[1], { sw: 5, cap: 'round' });
          const mid = [(a[0] + e[0]) / 2, (a[1] + e[1]) / 2];
          T(mid[0] + 6, mid[1] - 6, Math.round(r[4]).toLocaleString() + '′', { size: 9, fill: '#333' });
        }
        T(a[0], a[1] + (a[1] > e[1] ? 13 : -6), r[0].replace('RW', ''), { size: 10, anchor: 'middle', weight: 'bold' });
      });
    }
    T(b.x + 10, b.y + 18, 'AIRPORT SKETCH', { size: 10, weight: 'bold', ls: '0.5' });
    T(b.x + 10, b.y + b.h - 26, 'Apt Elev  ' + Math.round(doc.elev).toLocaleString(), { size: 10.5, weight: 'bold' });
    const li = (plate.brief && plate.brief.lights) || 'None';
    T(b.x + 10, b.y + b.h - 11, 'Lighting  ' + li, { size: 10.5 });
    zone('lighting', b.x + 6, b.y + b.h - 22, b.w - 12, 18);
  }

  /* ------------------------------------------------------------- minimums */

  function drawMins(plate) {
    const b = LAY.mins;
    R(b.x, b.y, b.w, b.h, { sw: 1.4, fill: '#fff' });
    zone('mins-box', b.x, b.y, b.w, b.h);

    const mins = plate.mins || { cols: [], rows: [] };
    const lw = 190, cw = (b.w - lw) / Math.max(1, mins.cols.length);
    const hh = 26, rh = Math.min(34, (b.h - hh - 6) / Math.max(1, mins.rows.length));

    add(gInk, 'rect', { x: b.x, y: b.y, width: b.w, height: hh, fill: '#e9e6dd' });
    T(b.x + 10, b.y + 18, 'CATEGORY', { size: 11, weight: 'bold', ls: '0.5' });
    mins.cols.forEach((c, i) => T(b.x + lw + cw * (i + 0.5), b.y + 18, c, { size: 13, anchor: 'middle', weight: 'bold' }));
    LN(b.x, b.y + hh, b.x + b.w, b.y + hh);
    zone('mins-cat', b.x + lw, b.y, b.w - lw, hh);

    mins.rows.forEach((r, ri) => {
      const y = b.y + hh + ri * rh;
      if (ri) LN(b.x, y, b.x + b.w, y, { stroke: '#888' });
      T(b.x + 10, y + rh / 2 + 4, r.label, { size: 12, weight: 'bold' });
      r.cells.forEach((v, ci) => T(b.x + lw + cw * (ci + 0.5), y + rh / 2 + 4, v,
        { size: v.length > 16 ? 9.5 : 12, anchor: 'middle' }));
      zone(r.el, b.x + 1, y + 1, b.w - 2, rh - 2);
      // visibility half of each cell is its own item
      zone('mins-vis', b.x + b.w - cw * 0.42, y + 2, cw * 0.4, rh - 4);
    });
    for (let i = 0; i <= mins.cols.length; i++)
      LN(b.x + lw + cw * i, b.y, b.x + lw + cw * i, b.y + hh + mins.rows.length * rh, { stroke: '#888' });

    const ib = LAY.inop;
    R(ib.x, ib.y, ib.w, ib.h, { sw: 1 });
    T(ib.x + 10, ib.y + 22, 'Inoperative components or visual aids table applies — see front of book.', { size: 10.5 });
    zone('inop-table', ib.x, ib.y, ib.w, ib.h);
  }

  function drawBottom(plate, doc) {
    const b = LAY.bot;
    LN(b.x, b.y, b.x + b.w, b.y, { sw: 1.4 });
    T(b.x, b.y + 20, fmtLatLon(doc.lat, doc.lon), { size: 11 });
    T(b.x, b.y + 38, plate.city, { size: 12, weight: 'bold' });
    T(W / 2, b.y + 30, plate.aptName, { size: 14, anchor: 'middle', weight: 'bold' });
    T(b.x + b.w, b.y + 30, plate.title, { size: 15, anchor: 'end', weight: 'bold' });
    zone('bottom-margin', b.x, b.y, b.w, b.h);
  }

  /* -------------------------------------------------------------- helpers */

  function finalCourseMag(doc, m) {
    if (m.codedCrs != null) return Math.round(m.codedCrs) || 360;
    const ff = m.ff;
    if (ff.length < 2) return null;
    const a = ff[ff.length - 2], b = ff[ff.length - 1];
    const t = brgTo([a.lat, a.lon], [b.lat, b.lon]);
    return Math.round((t - (doc.mv || 0) + 360) % 360) || 360;
  }
  const pad3 = v => String(v).padStart(3, '0');
  function runwayFor(doc, title) {
    const mt = /RWY\s+(\d+[LRC]?)/.exec(title);
    if (!mt) return null;
    return (doc.rw || []).find(r => r[0].replace('RW', '') === mt[1]) || null;
  }
  function fmtLatLon(lat, lon) {
    const f = (v, p, n) => {
      const s = v < 0 ? n : p, a = Math.abs(v);
      return `${Math.floor(a)}°${String(Math.round((a % 1) * 60)).padStart(2, '0')}'${s}`;
    };
    return f(lat, 'N', 'S') + '-' + f(lon, 'E', 'W');
  }
  function cycleJulian() {
    const eff = state.effective ? new Date(state.effective + 'T00:00:00Z') : new Date();
    const start = Date.UTC(eff.getUTCFullYear(), 0, 0);
    const day = Math.floor((eff - start) / 86400000);
    return String(eff.getUTCFullYear() % 100).padStart(2, '0') + String(day).padStart(3, '0');
  }
  const MORSE = {
    A: '·−', B: '−···', C: '−·−·', D: '−··', E: '·', F: '··−·', G: '−−·', H: '····',
    I: '··', J: '·−−−', K: '−·−', L: '·−··', M: '−−', N: '−·', O: '−−−', P: '·−−·',
    Q: '−−·−', R: '·−·', S: '···', T: '−', U: '··−', V: '···−', W: '·−−', X: '−··−',
    Y: '−·−−', Z: '−−··'
  };
  const morse = s => String(s).toUpperCase().split('').map(ch => MORSE[ch] || '').join(' ');

  /* ------------------------------------------------------------ app state */

  const state = { plate: null, doc: null, el: null, tour: false, tourIdx: 0, effective: null, zoom: 1 };
  const docCache = new Map();

  async function loadDoc(icao) {
    if (docCache.has(icao)) return docCache.get(icao);
    const r = await fetch(`data/procedures/apt/${icao}.json`);
    if (!r.ok) throw new Error(`${icao}: ${r.status}`);
    const d = await r.json();
    docCache.set(icao, d);
    return d;
  }

  async function selectPlate(id, keepEl) {
    const plate = window.PLATES.find(p => p.id === id) || window.PLATES[0];
    state.plate = plate;
    $('plate-status').textContent = 'Loading ' + plate.icao + '…';
    let doc;
    try { doc = await loadDoc(plate.icao); }
    catch (e) { $('plate-status').textContent = 'Could not load ' + plate.icao + ' procedure data.'; return; }
    const proc = doc.procs.find(p => p.id === plate.proc && p.type === 'APP');
    if (!proc) { $('plate-status').textContent = plate.proc + ' is not in the current cycle for ' + plate.icao + '.'; return; }
    state.doc = doc;
    $('plate-status').textContent = '';
    const model = drawPlate(plate, doc, proc);
    state.model = model;
    renderHeader(plate, doc, model);
    renderIndex(plate);
    document.querySelectorAll('.pchip').forEach(c => c.classList.toggle('on', c.dataset.id === plate.id));
    if (!keepEl) setEl(null);
    else setEl(state.el);
    writeHash();
  }

  function renderHeader(plate, doc, model) {
    $('plate-name').textContent = plate.title;
    $('plate-sub').innerHTML = `${esc(doc.name)} (${esc(plate.icao)}) · ${esc(plate.city)}`;
    $('plate-lead').innerHTML = plate.lead;
    $('plate-why').innerHTML = plate.why.map(w => `<li>${w}</li>`).join('');
    const facts = [
      ['Final course', model.ff.length > 1 ? pad3(finalCourseMag(doc, model)) + '°' : '—'],
      ['Glidepath', model.va ? model.va.toFixed(2) + '°' : 'none — MDA'],
      ['FAF', model.faf || '—'],
      ['MAP', model.map ? model.map.name : '—'],
      ['Field elev', Math.round(doc.elev).toLocaleString() + ' ft'],
      ['Missed climb to', (model.climbTo || model.holdAlt) ? (model.climbTo || model.holdAlt).toLocaleString() + ' ft' : '—']
    ];
    $('plate-facts').innerHTML = facts.map(f =>
      `<div class="fact"><span class="k">${f[0]}</span><span class="v">${esc(f[1])}</span></div>`).join('');
    $('plate-real').href = plate.real;
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function presentEls() {
    return new Set([...SVG.querySelectorAll('.hit')].map(h => h.dataset.el));
  }

  function renderIndex(plate) {
    const here = presentEls();
    const order = window.PLATE_TOUR;
    const groups = new Map();
    for (const id of order) {
      const g = window.PLATE_GLOSSARY[id];
      if (!g) continue;
      if (!groups.has(g.s)) groups.set(g.s, []);
      groups.get(g.s).push([id, g]);
    }
    let html = '';
    for (const [sec, items] of groups) {
      html += `<div class="idx-sec">${esc(sec)}</div>`;
      for (const [id, g] of items) {
        const on = here.has(id);
        html += `<button class="idx-item${on ? '' : ' absent'}" data-el="${id}">` +
          `<span class="dot"></span>${esc(g.t)}` +
          (on ? '' : '<span class="na">not on this chart</span>') + '</button>';
      }
    }
    $('el-index').innerHTML = html;
  }

  function setEl(id) {
    state.el = id;
    SVG.querySelectorAll('.hi').forEach(h => h.classList.toggle('on', h.dataset.el === id));
    SVG.classList.toggle('focused', !!id);
    document.querySelectorAll('.idx-item').forEach(b => b.classList.toggle('on', b.dataset.el === id));
    const g = id && window.PLATE_GLOSSARY[id];
    const panel = $('el-panel');
    if (!g) {
      panel.innerHTML = '<p class="hint">Hover anything on the chart to preview it; click to pin the explanation here. ' +
        'Or start the <b>guided tour</b> to walk the plate in briefing order.</p>';
      $('tour-pos').textContent = '';
      return;
    }
    const here = presentEls().has(id);
    const illus = isIllus(id);
    panel.innerHTML =
      `<div class="el-sec">${esc(g.s)}${here ? '' : ' · not on this chart'}</div>` +
      `<h3>${esc(g.t)}</h3>` +
      `<p class="what">${g.what}</p>` +
      `<p class="why"><b>Why it is there.</b> ${g.why}</p>` +
      (g.watch ? `<p class="watch"><b>Watch out.</b> ${g.watch}</p>` : '') +
      (illus ? '<p class="illus-note">◊ The values shown in this box are <b>illustrative</b> — the FAA cycle ' +
        'this site ships does not carry them. Read the real chart for the numbers.</p>'
        : '<p class="src-note">Values in this box are drawn from the FAA CIFP cycle the site ships' +
        (state.effective ? ' (effective ' + esc(state.effective) + ')' : '') + '.</p>');
    const idx = window.PLATE_TOUR.indexOf(id);
    $('tour-pos').textContent = idx >= 0 ? (idx + 1) + ' / ' + window.PLATE_TOUR.length : '';
  }

  const ILLUS_MAP = {
    brief: ['nav-freq', 'proc-notes', 'comm-strip', 'nonstd-symbols', 'rwy-tdze', 'lighting', 'inop-table', 'missed-icons'],
    mins: ['mins-box', 'mins-cat', 'mins-precision', 'mins-lpv', 'mins-lnavvnav', 'mins-lnav', 'mins-loc', 'mins-circling', 'mins-vis'],
    msa: ['msa', 'terrain'],
    chartRef: ['chart-ref', 'amdt'],
    sua: ['restricted']
  };
  function isIllus(id) {
    const p = state.plate;
    if (!p) return false;
    const keys = (p.illus || []).concat(p.sua ? ['sua'] : []);
    return keys.some(k => (ILLUS_MAP[k] || []).includes(id));
  }

  /* -------------------------------------------------------------- compare */

  async function renderCompare() {
    const rows = [];
    for (const p of window.PLATES) {
      let doc;
      try { doc = await loadDoc(p.icao); } catch { continue; }
      const proc = doc.procs.find(q => q.id === p.proc && q.type === 'APP');
      if (!proc) continue;
      const m = analyse(doc, proc);
      rows.push({ p, doc, m });
    }
    const head = ['Approach', 'Type', 'Final crs', 'Glidepath', 'FAF alt', 'Field elev', 'Missed climb to', 'Straight-in?'];
    let html = '<table class="cmp"><thead><tr>' + head.map(h => `<th>${h}</th>`).join('') + '</tr></thead><tbody>';
    for (const { p, doc, m } of rows) {
      const faf = m.fixes.get(m.faf);
      const straight = /RWY\s/.test(p.title);
      html += '<tr>' +
        `<td><button class="lnk" data-goto="${p.id}">${esc(p.title)}</button>` +
        `<div class="sub">${esc(p.icao)} · ${esc(p.city.split(',')[0])}</div></td>` +
        `<td>${p.group === 'standard' ? 'standard' : '<b>unusual</b>'}</td>` +
        `<td>${m.ff.length > 1 ? pad3(finalCourseMag(doc, m)) + '°' : '—'}</td>` +
        `<td class="${m.va && m.va > 3.1 ? 'hot' : ''}">${m.va ? m.va.toFixed(2) + '°' : '—'}</td>` +
        `<td>${faf && faf.alt ? faf.alt.toLocaleString() : '—'}</td>` +
        `<td class="${doc.elev > 5000 ? 'hot' : ''}">${Math.round(doc.elev).toLocaleString()}</td>` +
        `<td>${(m.climbTo || m.holdAlt) ? (m.climbTo || m.holdAlt).toLocaleString() : '—'}</td>` +
        `<td>${straight ? 'yes' : '<b>circling only</b>'}</td>` +
        '</tr>';
    }
    html += '</tbody></table>';
    $('cmp-body').innerHTML = html;
  }

  /* ----------------------------------------------------------------- hash */

  function writeHash() {
    const h = 'p=' + (state.plate ? state.plate.id : '') + (state.el ? '&el=' + state.el : '');
    history.replaceState(null, '', '#' + h);
  }
  function readHash() {
    const h = new URLSearchParams(location.hash.replace(/^#/, ''));
    return { p: h.get('p'), el: h.get('el') };
  }

  /* ------------------------------------------------------------- tour ops */

  function tourStep(delta) {
    const here = presentEls();
    const list = window.PLATE_TOUR.filter(id => here.has(id) && window.PLATE_GLOSSARY[id]);
    if (!list.length) return;
    let i = list.indexOf(state.el);
    i = i < 0 ? (delta > 0 ? 0 : list.length - 1) : (i + delta + list.length) % list.length;
    setEl(list[i]);
    writeHash();
    const hit = SVG.querySelector(`.hit[data-el="${list[i]}"]`);
    if (hit) hit.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  function setZoom(z) {
    state.zoom = Math.max(0.3, Math.min(2.4, z));   // 0.3 so "Fit" really fits a phone
    SVG.style.width = Math.round(W * state.zoom) + 'px';
    $('zoom-val').textContent = Math.round(state.zoom * 100) + '%';
  }
  function fitZoom() {
    const w = $('plate-scroll').clientWidth - 4;
    setZoom(w / W);
  }

  /* ------------------------------------------------------------------ init */

  async function init() {
    SVG = $('plate-svg');

    // plate chips
    const groups = [['standard', 'Start here — the standard shapes'], ['unusual', 'The unusual ones']];
    $('plate-picker').innerHTML = groups.map(([g, label]) =>
      `<div class="pgroup"><div class="pglabel">${label}</div><div class="pchips">` +
      window.PLATES.filter(p => p.group === g).map(p =>
        `<button class="pchip" data-id="${p.id}"><b>${esc(p.title)}</b>` +
        `<span>${esc(p.icao)} · ${esc(p.tag)}</span></button>`).join('') +
      '</div></div>').join('');

    fetch('data/procedures/index.json').then(r => r.json()).then(ix => {
      state.effective = ix.effective;
      $('cycle-note').textContent = 'FAA CIFP cycle effective ' + ix.effective;
    }).catch(() => {});

    document.addEventListener('click', e => {
      const chip = e.target.closest('.pchip');
      if (chip) { selectPlate(chip.dataset.id); return; }
      const idx = e.target.closest('.idx-item');
      if (idx) { setEl(idx.dataset.el); writeHash();
        const hit = SVG.querySelector(`.hit[data-el="${idx.dataset.el}"]`);
        if (hit) hit.scrollIntoView({ block: 'center', behavior: 'smooth' });
        return; }
      const go = e.target.closest('[data-goto]');
      if (go) { showView('plate'); selectPlate(go.dataset.goto); return; }
      const hit = e.target.closest('.hit');
      if (hit) { setEl(hit.dataset.el === state.el ? null : hit.dataset.el); writeHash(); }
    });

    SVG.addEventListener('mousemove', e => {
      const hit = e.target.closest('.hit');
      const id = hit ? hit.dataset.el : null;
      SVG.querySelectorAll('.hi').forEach(h => h.classList.toggle('hover', h.dataset.el === id));
      $('hover-name').textContent = id && window.PLATE_GLOSSARY[id] ? window.PLATE_GLOSSARY[id].t : '';
    });
    SVG.addEventListener('mouseleave', () => {
      SVG.querySelectorAll('.hi').forEach(h => h.classList.remove('hover'));
      $('hover-name').textContent = '';
    });

    $('tour-next').onclick = () => tourStep(1);
    $('tour-prev').onclick = () => tourStep(-1);
    $('tour-clear').onclick = () => { setEl(null); writeHash(); };
    $('zoom-in').onclick = () => { state.fit = false; setZoom(state.zoom + 0.15); };
    $('zoom-out').onclick = () => { state.fit = false; setZoom(state.zoom - 0.15); };
    $('zoom-fit').onclick = () => { state.fit = true; fitZoom(); };

    document.addEventListener('keydown', e => {
      if (/input|textarea/i.test(e.target.tagName)) return;
      if (e.key === 'ArrowRight') { tourStep(1); e.preventDefault(); }
      if (e.key === 'ArrowLeft') { tourStep(-1); e.preventDefault(); }
      if (e.key === 'Escape') { setEl(null); writeHash(); }
    });

    document.querySelectorAll('.viewbtn').forEach(b => b.onclick = () => showView(b.dataset.view));

    const h = readHash();
    await selectPlate(h.p || window.PLATES[0].id, true);
    if (h.el) setEl(h.el);
    fitZoom();
    window.addEventListener('resize', () => { if (state.fit !== false) fitZoom(); });
  }

  function showView(v) {
    document.querySelectorAll('.viewbtn').forEach(b => b.classList.toggle('on', b.dataset.view === v));
    $('view-plate').hidden = v !== 'plate';
    $('view-compare').hidden = v !== 'compare';
    if (v === 'compare') renderCompare();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
