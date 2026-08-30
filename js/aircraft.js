/* ---------------------------------------------------------------------------
   Aircraft Compare — aircraft.html

   Everything the page knows about airplanes lives in data/aircraft.json:
   a field registry (id, group, label, unit, direction) plus one specs object
   per aircraft. This file only renders it. Adding a measurement to the data
   file makes it appear in the table, the row filter, the bar chart and both
   scatter axes with no change here — which is the whole point of the registry.

   Units: the data file stores one canonical unit per field (m, m2, m3, kg, L,
   kN, kW, ft, kt, nm, cm, psi, deg, kg/h). UNIT_DEFS below converts for
   display. Nothing is ever converted in the data.
   --------------------------------------------------------------------------- */
(() => {
  'use strict';

  const DATA_URL = 'data/aircraft.json';

  // Categorical palette, dark-surface steps. Validated as a set (adjacent-pair
  // CVD ΔE 8.4 worst case, normal-vision 19.3, all ≥3:1 on this background) —
  // re-run the check before reordering or extending it. Colour never carries
  // identity alone: every series is also named or directly labelled.
  const PALETTE = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300'];
  const MAX_SEL = PALETTE.length;

  const DEFAULT_SEL = ['crj900', 'e175', 'b77w'];

  const PRESETS = [
    { label: 'CRJ vs ERJ vs 777', ids: ['crj900', 'e175', 'b77w'] },
    { label: 'The CRJ family',    ids: ['crj200', 'crj700', 'crj900', 'crj1000'] },
    { label: 'Embraer, end to end', ids: ['erj145', 'e170', 'e175', 'e190', 'e195e2'] },
    { label: 'The 777s',          ids: ['b772er', 'b77l', 'b77w', 'b77f', 'b779'] },
    { label: '50-seat war',       ids: ['crj200', 'erj145'] },
    { label: 'Scope-clause twins',ids: ['crj900', 'e175'] },
    { label: 'Widebody twins',    ids: ['b772er', 'b77w', 'b779', 'b789'] },
    { label: 'Skyhawk to 777-9',  ids: ['c172s', 'crj200', 'e175', 'b738', 'b77w', 'b779'] }
  ];

  /* ---- unit conversion -------------------------------------------------- */
  // f = multiply the stored value by this; s = suffix; d = fixed decimals
  // (omitted means "pick by magnitude"). "us" is the aviation-imperial column
  // a US pilot reads; "si" is metric, except that knots stay knots nowhere —
  // metric mode does convert them, because that is what a metric spec sheet does.
  const UNIT_DEFS = {
    text:  { us: null, si: null },
    num:   { us: { s: '',        f: 1, d: 0 },      si: { s: '',        f: 1, d: 0 } },
    ratio: { us: { s: '',        f: 1, d: 2 },      si: { s: '',        f: 1, d: 2 } },
    pct:   { us: { s: '%',       f: 1, d: 1 },      si: { s: '%',       f: 1, d: 1 } },
    musd:  { us: { s: 'M$',      f: 1, d: 1 },      si: { s: 'M$',      f: 1, d: 1 } },
    deg:   { us: { s: '°',       f: 1, d: 1 },      si: { s: '°',       f: 1, d: 1 } },
    mach:  { us: { s: '',        f: 1, d: 2, pre: 'M ' }, si: { s: '', f: 1, d: 2, pre: 'M ' } },
    m:     { us: { s: 'ft',      f: 3.280839895 },  si: { s: 'm',       f: 1 } },
    m2:    { us: { s: 'ft²',     f: 10.76391042 },  si: { s: 'm²',      f: 1 } },
    m3:    { us: { s: 'ft³',     f: 35.31466672 },  si: { s: 'm³',      f: 1 } },
    cm:    { us: { s: 'in',      f: 0.3937007874 }, si: { s: 'cm',      f: 1 } },
    kg:    { us: { s: 'lb',      f: 2.204622622 },  si: { s: 'kg',      f: 1 } },
    kgm2:  { us: { s: 'lb/ft²',  f: 0.2048161436 }, si: { s: 'kg/m²',   f: 1 } },
    kgh:   { us: { s: 'lb/h',    f: 2.204622622 },  si: { s: 'kg/h',    f: 1 } },
    L:     { us: { s: 'US gal',  f: 0.2641720524 }, si: { s: 'L',       f: 1 } },
    kN:    { us: { s: 'lbf',     f: 224.8089431 },  si: { s: 'kN',      f: 1 } },
    kW:    { us: { s: 'hp',      f: 1.341022089 },  si: { s: 'kW',      f: 1 } },
    ft:    { us: { s: 'ft',      f: 1 },            si: { s: 'm',       f: 0.3048 } },
    fpm:   { us: { s: 'ft/min',  f: 1 },            si: { s: 'm/s',     f: 0.00508, d: 1 } },
    kt:    { us: { s: 'kt',      f: 1 },            si: { s: 'km/h',    f: 1.852 } },
    nm:    { us: { s: 'nm',      f: 1 },            si: { s: 'km',      f: 1.852 } },
    psi:   { us: { s: 'psi',     f: 1 },            si: { s: 'bar',     f: 0.06894757, d: 2 } }
  };

  const isNum = u => u !== 'text';

  function unitDef(fieldId) {
    const f = F[fieldId];
    if (!f) return null;
    const d = UNIT_DEFS[f.u];
    return d ? d[UNIT] : null;
  }

  function unitLabel(fieldId) {
    const d = unitDef(fieldId);
    return d && d.s ? d.s : '';
  }

  // Decimals by magnitude when the unit doesn't pin them: big numbers read as
  // integers, small ones need the fraction to say anything at all.
  function autoDec(v) {
    const a = Math.abs(v);
    if (a >= 100) return 0;
    if (a >= 10) return a % 1 === 0 ? 0 : 1;
    if (a >= 1) return 2;
    return 2;
  }

  function fmtNum(fieldId, v) {
    const d = unitDef(fieldId);
    if (!d) return String(v);
    const x = v * d.f;
    const dec = d.d != null ? d.d : autoDec(x);
    const s = x.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
    return (d.pre || '') + s;
  }

  /* ---- state ------------------------------------------------------------ */
  let DB = null;          // parsed data file
  let F = {};             // field id -> field def
  let A = {};             // aircraft id -> aircraft (with .d derived, .approx set)
  let SEL = [];           // selected aircraft ids, in click order
  let UNIT = 'us';
  let TAB = 'table';

  const st = {
    bars: true, best: true, diff: false, hideEmpty: true, fq: '',
    view: 'top', mode: 'stack', human: true,
    barField: 'range', barAll: false,
    scX: 'paxt', scY: 'range', scLog: true, wtShare: false,
    fleetSort: { k: 'mtow', dir: -1 }, fleetCat: '',
    collapsed: new Set(), q: ''
  };

  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const colorOf = id => PALETTE[SEL.indexOf(id) % PALETTE.length];

  /* ---- derived fields ---------------------------------------------------
     Nothing below is quoted from a manufacturer; each is arithmetic on rows
     that are. Anything whose inputs are approximate inherits the ≈. */
  const DERIVED = [
    ['ar',        a => a.s.span && a.s.area ? a.s.span * a.s.span / a.s.area : null,           ['span', 'area']],
    ['thrusttot', a => a.s.thrust && a.s.neng ? a.s.thrust * a.s.neng : null,                   ['thrust', 'neng']],
    ['payload',   a => a.s.mzfw && a.s.oew ? a.s.mzfw - a.s.oew : null,                         ['mzfw', 'oew']],
    ['wload',     a => a.s.mtow && a.s.area ? a.s.mtow / a.s.area : null,                       ['mtow', 'area']],
    ['twr',       a => a.d.thrusttot && a.s.mtow ? (a.d.thrusttot * 1000) / (a.s.mtow * 9.80665) : null, ['thrust', 'neng', 'mtow']],
    ['fuelfrac',  a => a.s.fuelkg && a.s.mtow ? 100 * a.s.fuelkg / a.s.mtow : null,             ['fuelkg', 'mtow']],
    ['payfrac',   a => a.d.payload && a.s.mtow ? 100 * a.d.payload / a.s.mtow : null,           ['mzfw', 'oew', 'mtow']],
    ['seatlen',   a => a.s.pax1 && a.s.len ? a.s.pax1 / a.s.len : null,                         ['pax1', 'len']],
    ['burnseat',  a => a.s.burn && a.s.pax1 ? a.s.burn / a.s.pax1 : null,                       ['burn', 'pax1']],
    ['fuel100',   a => a.d.burnseat && a.s.ktas ? a.d.burnseat / a.s.ktas * 100 : null,         ['burn', 'pax1', 'ktas']]
  ];

  function prepare(a) {
    a.d = {};
    a.approx = new Set(a['~'] || []);
    for (const [id, fn, inputs] of DERIVED) {
      const v = fn(a);
      if (v != null && isFinite(v)) {
        a.d[id] = v;
        if (inputs.some(k => a.approx.has(k))) a.approx.add(id);
      }
    }
  }

  const val = (a, fid) => (a.s[fid] != null ? a.s[fid] : (a.d[fid] != null ? a.d[fid] : null));

  /* ---- URL state -------------------------------------------------------- */
  function readHash() {
    const h = new URLSearchParams(location.hash.replace(/^#/, ''));
    const ids = (h.get('a') || '').split(',').filter(id => A[id]);
    if (ids.length) SEL = ids.slice(0, MAX_SEL);
    if (h.get('u') === 'si' || h.get('u') === 'us') UNIT = h.get('u');
    const t = h.get('t');
    if (t && $('tab-' + t)) TAB = t;
  }

  function writeHash() {
    const p = new URLSearchParams();
    if (SEL.length) p.set('a', SEL.join(','));
    if (UNIT !== 'us') p.set('u', UNIT);
    if (TAB !== 'table') p.set('t', TAB);
    history.replaceState(null, '', '#' + p.toString());
  }

  /* ---- selection -------------------------------------------------------- */
  function toggle(id) {
    const i = SEL.indexOf(id);
    if (i >= 0) SEL.splice(i, 1);
    else if (SEL.length < MAX_SEL) SEL.push(id);
    else {
      // Full: swap out the oldest so a click always does something visible.
      SEL.shift();
      SEL.push(id);
    }
    renderAll();
  }

  const selected = () => SEL.map(id => A[id]);

  /* ======================================================================= *
     Rendering
     ======================================================================= */

  function renderChips() {
    const q = st.q.trim().toLowerCase();
    const host = $('chips');
    host.innerHTML = DB.aircraft.map(a => {
      const on = SEL.includes(a.id);
      const hay = [a.name, a.full, a.mfr, a.family, a.cat, a.s.icao, a.s.role].join(' ').toLowerCase();
      const hide = q && !hay.includes(q);
      const style = on ? ` style="color:${colorOf(a.id)}"` : '';
      return `<button class="chip${on ? ' on' : ''}${hide ? ' hidden' : ''}" data-id="${a.id}"${style}
        title="${esc(a.full)}"><span class="dot"></span><span>${esc(a.name)}
        <span class="sub">${esc(a.mfr.split(' ')[0])}</span></span></button>`;
    }).join('');
    const n = DB.aircraft.length;
    $('picker-note').textContent =
      `${SEL.length} of ${MAX_SEL} slots used · ${n} aircraft in the file · ` +
      `${DB.fields.length} measurements each · a seventh pick replaces the oldest.`;
  }

  function renderHeads() {
    const host = $('heads');
    if (!SEL.length) {
      host.innerHTML = '<p class="empty-note">Nothing selected. Pick an airplane above, or start from a preset.</p>';
      return;
    }
    const sel = selected();
    // One scale across all the thumbnails, so the cards themselves compare sizes.
    const maxLen = Math.max(...sel.map(a => Math.max(a.s.len || 1, a.s.span || 1)));
    // All thumbnails share one box as well as one scale, so the cards line up and
    // the empty air around a small airplane is itself the comparison.
    const boxH = Math.max(...sel.map(a => a.s.span || 1)) / maxLen;
    host.innerHTML = sel.map(a => {
      const c = colorOf(a.id);
      const rows = [
        ['Seats', a.s.paxt != null ? fmtNum('paxt', a.s.paxt) + (a.s.paxmax ? ` <span style="color:#6f7a88">/ ${a.s.paxmax} max</span>` : '') : 'freighter'],
        ['Range', a.s.range != null ? fmtNum('range', a.s.range) + ' ' + unitLabel('range') : '—'],
        ['MTOW', a.s.mtow != null ? fmtNum('mtow', a.s.mtow) + ' ' + unitLabel('mtow') : '—'],
        ['Cruise', a.s.mach != null ? fmtNum('mach', a.s.mach) : '—'],
        ['Engines', a.s.neng + ' × ' + (a.s.thrust != null
          ? fmtNum('thrust', a.s.thrust) + ' ' + unitLabel('thrust')
          : (a.s.power != null ? fmtNum('power', a.s.power) + ' ' + unitLabel('power') : '—'))],
        ['Span', a.s.span != null ? fmtNum('span', a.s.span) + ' ' + unitLabel('span') : '—']
      ];
      return `<article class="head-card" style="--c:${c}">
        <button class="rm" data-rm="${a.id}" title="Remove from the comparison">×</button>
        <h3>${esc(a.name)}</h3>
        <p class="full">${esc(a.full)}</p>
        <div class="sil">${svgThumb(a, c, maxLen, boxH)}</div>
        <dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
        <p class="blurb">${esc(a.blurb)}</p>
      </article>`;
    }).join('');
  }

  /* ---- master table ----------------------------------------------------- */
  function visibleFields() {
    const sel = selected();
    const fq = st.fq.trim().toLowerCase();
    return DB.fields.filter(f => {
      if (fq && !(f.l.toLowerCase().includes(fq) || (f.d || '').toLowerCase().includes(fq))) return false;
      const vals = sel.map(a => val(a, f.id));
      if (st.hideEmpty && vals.every(v => v == null)) return false;
      if (st.diff) {
        const present = vals.filter(v => v != null);
        if (present.length > 1 && present.every(v => v === present[0])) return false;
      }
      return true;
    });
  }

  function bestIds(f, sel) {
    if (!st.best || !f.hi) return new Set();
    const pairs = sel.map(a => [a.id, val(a, f.id)]).filter(p => p[1] != null);
    if (pairs.length < 2) return new Set();
    const target = f.hi > 0 ? Math.max(...pairs.map(p => p[1])) : Math.min(...pairs.map(p => p[1]));
    return new Set(pairs.filter(p => p[1] === target).map(p => p[0]));
  }

  function renderTable() {
    const sel = selected();
    const host = $('tbl-wrap');
    if (!sel.length) { host.innerHTML = '<p class="empty-note" style="padding:20px">Pick an airplane to fill the table.</p>'; $('tbl-notes').innerHTML = ''; return; }

    const fields = visibleFields();
    const noteMarks = [];   // collected footnotes, numbered in table order

    let html = '<table class="master"><thead><tr><th class="rowhead">' +
      `<span style="color:#e6ecf3">${fields.length} rows</span></th>` +
      sel.map(a => `<th style="--c:${colorOf(a.id)}"><span class="swatch"></span>${esc(a.name)}` +
        `<span class="hsub">${esc(a.s.icao || a.mfr)}</span></th>`).join('') +
      '</tr></thead><tbody>';

    for (const g of DB.groups) {
      const gf = fields.filter(f => f.g === g.id);
      if (!gf.length) continue;
      const open = !st.collapsed.has(g.id);
      html += `<tr class="grp" data-grp="${g.id}"><th><span class="caret">${open ? '▾' : '▸'}</span>${esc(g.label)}</th>` +
        `<td colspan="${sel.length}">${esc(g.note || '')}</td></tr>`;
      if (!open) continue;

      for (const f of gf) {
        const best = bestIds(f, sel);
        const nums = sel.map(a => val(a, f.id)).filter(v => v != null && isNum(f.u));
        const maxAbs = nums.length ? Math.max(...nums.map(Math.abs)) : 0;
        const u = unitLabel(f.id);
        const tip = f.d ? ` title="${esc(f.d)}"` : '';
        html += `<tr><th class="rowhead"><span class="fname"${tip}>${esc(f.l)}</span>` +
          (u ? `<span class="unit-tag">${esc(u)}</span>` : '') +
          (f.c ? '<span class="unit-tag" title="Computed from other rows, not quoted">ƒ</span>' : '') + '</th>';

        for (const a of sel) {
          const v = val(a, f.id);
          if (v == null) { html += '<td class="na">—</td>'; continue; }
          const ap = a.approx.has(f.id);
          let cell, cls = '';
          if (isNum(f.u)) {
            cell = (ap ? '<span class="approx">≈</span>' : '') + fmtNum(f.id, v);
            if (st.bars && maxAbs > 0 && v > 0) {
              const pct = Math.max(2, (Math.abs(v) / maxAbs) * 100);
              cls += ` style="background:linear-gradient(90deg,transparent ${100 - pct}%,${colorOf(a.id)}26 ${100 - pct}%)"`;
            }
          } else {
            cell = esc(v);
            cls = ' class="txt"';
          }
          const note = a.n && a.n[f.id];
          let mark = '';
          if (note) {
            noteMarks.push({ n: noteMarks.length + 1, ac: a.name, field: f.l, text: note });
            mark = `<sup class="note-m" title="${esc(note)}">${noteMarks.length}</sup>`;
          }
          const isBest = best.has(a.id);
          if (isBest) cls = cls.includes('class=') ? cls.replace('class="', 'class="best ') : ' class="best"' + cls;
          html += `<td${cls}>${cell}${mark}</td>`;
        }
        html += '</tr>';
      }
    }
    html += '</tbody></table>';
    host.innerHTML = html;

    $('tbl-notes').innerHTML = noteMarks.length
      ? '<b>Notes</b> ' + noteMarks.map(m =>
        `<span class="nm">${m.n}</span> ${esc(m.ac)}, ${esc(m.field.toLowerCase())}: ${esc(m.text)}.`).join(' &nbsp; ')
      : '';
  }

  function tableRows() {
    const sel = selected();
    const rows = [['Field', 'Unit', ...sel.map(a => a.full)]];
    for (const g of DB.groups) {
      for (const f of DB.fields.filter(x => x.g === g.id)) {
        const vals = sel.map(a => {
          const v = val(a, f.id);
          if (v == null) return '';
          return isNum(f.u) ? fmtNum(f.id, v).replace(/,/g, '') : v;
        });
        if (st.hideEmpty && vals.every(v => v === '')) continue;
        rows.push([f.l, unitLabel(f.id), ...vals]);
      }
    }
    return rows;
  }

  /* ---- scale drawings ---------------------------------------------------
     Every silhouette is generated from the table's own numbers — span, length,
     wing area, sweep, fuselage width, tail height, fan diameter — plus a taper
     ratio and mounting style per type. That is what makes them comparable:
     they are the data, drawn. They are schematics, not general-arrangement
     drawings; see the caption under the figure. */

  const DEF_TAPER = 0.25;
  const rad = d => d * Math.PI / 180;

  function wingGeom(a) {
    const s = a.s, g = a.geom || {};
    const b = s.span, S = s.area, lam = g.taper != null ? g.taper : DEF_TAPER;
    const Cr = 2 * S / (b * (1 + lam)), Ct = Cr * lam;
    const x0 = (g.rootFrac != null ? g.rootFrac : 0.42) * s.len;
    const c4r = x0 + Cr / 4;
    const c4t = c4r + (b / 2) * Math.tan(rad(s.sweep || 0));
    return { b, Cr, Ct, x0, tipLE: c4t - Ct / 4 };
  }

  function groundClear(a) {
    const m = (a.geom || {}).mount;
    const k = m === 'wing' ? 0.22 : 0.13;
    return (a.s.hgt || 5) * k;
  }

  function engineSpec(a) {
    const s = a.s, g = a.geom || {};
    const fan = s.fandia || 0;
    if (g.mount === 'nose') return { kind: 'prop', dia: 0.17 * s.span };
    if (!fan) return null;
    return { kind: g.mount, len: (g.mount === 'aft' ? 2.3 : 2.1) * fan, dia: 1.2 * fan, fan };
  }

  // Top view. Returns { w, h, svg } in metres, nose at x=0, centreline at y=0.
  function geoTop(a, fill, stroke) {
    const s = a.s, g = a.geom || {}, L = s.len, b = s.span, w = s.fusew || L * 0.09;
    const W = wingGeom(a), p = [];
    const P = (d, o) => p.push(`<path d="${d}" fill="${o && o.f !== undefined ? o.f : fill}" stroke="${stroke}" stroke-width="${o && o.sw || 0.06}" stroke-linejoin="round"/>`);

    // fuselage: pointed nose, parallel mid-body, tapered tail cone
    P(`M ${0} 0 C ${0.02 * L} ${-w / 2} ${0.09 * L} ${-w / 2} ${0.16 * L} ${-w / 2}
       L ${0.70 * L} ${-w / 2} C ${0.86 * L} ${-w / 2} ${0.95 * L} ${-w * 0.22} ${L} ${-w * 0.06}
       L ${L} ${w * 0.06} C ${0.95 * L} ${w * 0.22} ${0.86 * L} ${w / 2} ${0.70 * L} ${w / 2}
       L ${0.16 * L} ${w / 2} C ${0.09 * L} ${w / 2} ${0.02 * L} ${w / 2} ${0} 0 Z`);

    // wing, both sides
    for (const sg of [-1, 1]) {
      P(`M ${W.x0} ${sg * w * 0.45} L ${W.tipLE} ${sg * b / 2} L ${W.tipLE + W.Ct} ${sg * b / 2}
         L ${W.x0 + W.Cr} ${sg * w * 0.45} Z`);
    }

    // horizontal tail — area taken as a fifth of the wing, span from the type's htFrac
    const bh = (g.htFrac != null ? g.htFrac : 0.35) * b, Sh = 0.2 * s.area;
    const Crh = 2 * Sh / (bh * 1.45), Cth = 0.45 * Crh;
    const xh = L - Crh - (g.tail === 'T' ? 0.01 : 0.05) * L;
    const c4th = xh + Crh / 4 + (bh / 2) * Math.tan(rad((s.sweep || 0) + 6));
    for (const sg of [-1, 1]) {
      P(`M ${xh} ${sg * w * 0.28} L ${c4th - Cth / 4} ${sg * bh / 2} L ${c4th + Cth * 0.75} ${sg * bh / 2}
         L ${xh + Crh} ${sg * w * 0.28} Z`);
    }

    // fin, seen from above as a slender wedge on the centreline
    P(`M ${L - Crh - 0.14 * L} ${-w * 0.055} L ${L - 0.01 * L} ${-w * 0.02}
       L ${L - 0.01 * L} ${w * 0.02} L ${L - Crh - 0.14 * L} ${w * 0.055} Z`);

    // engines
    const E = engineSpec(a);
    if (E && E.kind === 'wing') {
      const yStn = 0.34 * (b / 2);
      const t = (yStn - w / 2) / (b / 2 - w / 2);
      const xLE = W.x0 + t * (W.tipLE - W.x0);
      for (const sg of [-1, 1]) {
        const x = xLE - 0.42 * E.len, y = sg * yStn;
        P(`M ${x} ${y - E.dia / 2} L ${x + E.len * 0.82} ${y - E.dia / 2} Q ${x + E.len} ${y} ${x + E.len * 0.82} ${y + E.dia / 2}
           L ${x} ${y + E.dia / 2} Q ${x - E.len * 0.10} ${y} ${x} ${y - E.dia / 2} Z`, { sw: 0.05 });
      }
    } else if (E && E.kind === 'aft') {
      for (const sg of [-1, 1]) {
        const x = 0.70 * L, y = sg * (w / 2 + E.dia * 0.48);
        P(`M ${x} ${y - E.dia / 2} L ${x + E.len * 0.85} ${y - E.dia / 2} Q ${x + E.len} ${y} ${x + E.len * 0.85} ${y + E.dia / 2}
           L ${x} ${y + E.dia / 2} Q ${x - E.len * 0.08} ${y} ${x} ${y - E.dia / 2} Z`, { sw: 0.05 });
      }
    } else if (E && E.kind === 'prop') {
      p.push(`<ellipse cx="${0.03 * L}" cy="0" rx="${0.012 * L}" ry="${E.dia / 2}" fill="none" stroke="${stroke}" stroke-width="0.05"/>`);
    }

    return { x0: 0, y0: -b / 2, w: L, h: b, svg: p.join('') };
  }

  // Side view. y grows upward; ground at y=0, so the caller flips.
  function geoSide(a, fill, stroke) {
    const s = a.s, g = a.geom || {}, L = s.len, H = s.fuseh || s.fusew || 3;
    const yB = groundClear(a), yT = yB + H, yM = yB + H * 0.5;
    const finH = Math.max(0.6, (s.hgt || yT + 2) - yT);
    const W = wingGeom(a), p = [];
    const P = (d, o) => p.push(`<path d="${d}" fill="${(o && o.f) || fill}" stroke="${stroke}" stroke-width="${(o && o.sw) || 0.06}" stroke-linejoin="round"/>`);

    P(`M 0 ${yM} C 0 ${yT - H * 0.18} ${0.05 * L} ${yT} ${0.14 * L} ${yT}
       L ${0.70 * L} ${yT} C ${0.86 * L} ${yT} ${0.94 * L} ${yT - H * 0.06} ${L} ${yT - H * 0.20}
       L ${L} ${yT - H * 0.46} C ${0.90 * L} ${yB + H * 0.50} ${0.80 * L} ${yB} ${0.68 * L} ${yB}
       L ${0.14 * L} ${yB} C ${0.05 * L} ${yB} 0 ${yB + H * 0.18} 0 ${yM} Z`);

    // fin (swept) and stabiliser
    const finBase = 0.70 * L;
    P(`M ${finBase} ${yT} L ${finBase + 0.20 * L} ${yT + finH} L ${L} ${yT + finH} L ${L} ${yT - H * 0.10} Z`);
    const stabY = g.tail === 'T' ? yT + finH : yT - H * 0.06;
    const stabX = g.tail === 'T' ? finBase + 0.19 * L : 0.84 * L;
    P(`M ${stabX} ${stabY} L ${L + 0.015 * L} ${stabY} L ${L + 0.015 * L} ${stabY - 0.012 * L} L ${stabX} ${stabY - 0.02 * L} Z`, { sw: 0.04 });

    // wing seen edge-on at the root
    const wy = g.wing === 'high' ? yT : yB + H * 0.16;
    P(`M ${W.x0} ${wy} L ${W.x0 + W.Cr * 0.55} ${wy + (g.wing === 'high' ? 0.012 : 0.018) * L} L ${W.x0 + W.Cr} ${wy} Z`, { sw: 0.04 });

    // engines
    const E = engineSpec(a);
    if (E && E.kind === 'wing') {
      const cy = yB * 0.62 + 0.15 * E.fan, x = W.x0 - 0.30 * E.len;
      P(`M ${x} ${cy - E.dia / 2} L ${x + E.len * 0.85} ${cy - E.dia / 2} Q ${x + E.len} ${cy} ${x + E.len * 0.85} ${cy + E.dia / 2}
         L ${x} ${cy + E.dia / 2} Q ${x - E.len * 0.08} ${cy} ${x} ${cy - E.dia / 2} Z`, { sw: 0.05 });
      // pylon up to the wing
      P(`M ${x + E.len * 0.55} ${cy} L ${W.x0 + W.Cr * 0.3} ${wy} L ${W.x0 + W.Cr * 0.55} ${wy} L ${x + E.len * 0.80} ${cy} Z`, { sw: 0.03 });
    } else if (E && E.kind === 'aft') {
      const cy = yB + H * 0.66, x = 0.70 * L;
      P(`M ${x} ${cy - E.dia / 2} L ${x + E.len * 0.85} ${cy - E.dia / 2} Q ${x + E.len} ${cy} ${x + E.len * 0.85} ${cy + E.dia / 2}
         L ${x} ${cy + E.dia / 2} Q ${x - E.len * 0.08} ${cy} ${x} ${cy - E.dia / 2} Z`, { sw: 0.05 });
    } else if (E && E.kind === 'prop') {
      P(`M ${0.02 * L} ${yM - E.dia / 2} L ${0.05 * L} ${yM - E.dia / 2} L ${0.05 * L} ${yM + E.dia / 2} L ${0.02 * L} ${yM + E.dia / 2} Z`, { sw: 0.04 });
    }

    // landing gear — indicative, not dimensioned
    const wheel = Math.max(0.20, 0.022 * L);
    for (const gx of [0.13 * L, W.x0 + W.Cr * 0.62]) {
      p.push(`<line x1="${gx}" y1="${yB}" x2="${gx}" y2="${wheel}" stroke="${stroke}" stroke-width="${wheel * 0.35}"/>`);
      p.push(`<circle cx="${gx}" cy="${wheel}" r="${wheel}" fill="${fill}" stroke="${stroke}" stroke-width="0.05"/>`);
    }

    return { x0: 0, y0: 0, w: L * 1.02, h: s.hgt || yT + finH, svg: p.join('') };
  }

  // Front view. Centreline at x=0, ground at y=0.
  function geoFront(a, fill, stroke) {
    const s = a.s, g = a.geom || {}, b = s.span, w = s.fusew || 3, H = s.fuseh || w;
    const yB = groundClear(a), cy = yB + H / 2, yT = yB + H;
    const finH = Math.max(0.6, (s.hgt || yT + 2) - yT);
    const p = [];
    const dih = rad(g.wing === 'high' ? 2 : 5);

    // wing: root at fuselage side, rising with dihedral
    for (const sg of [-1, 1]) {
      const yRoot = g.wing === 'high' ? yT : yB + H * 0.18;
      const yTip = yRoot + Math.tan(dih) * (b / 2);
      const t = Math.max(0.06, 0.010 * b);
      p.push(`<path d="M ${sg * w * 0.4} ${yRoot} L ${sg * b / 2} ${yTip} L ${sg * b / 2} ${yTip + t * 0.5}
        L ${sg * w * 0.4} ${yRoot + t}Z" fill="${fill}" stroke="${stroke}" stroke-width="0.06" stroke-linejoin="round"/>`);
    }
    // fuselage
    p.push(`<ellipse cx="0" cy="${cy}" rx="${w / 2}" ry="${H / 2}" fill="${fill}" stroke="${stroke}" stroke-width="0.08"/>`);
    // fin + stabiliser
    p.push(`<path d="M ${-0.012 * b} ${yT} L ${-0.008 * b} ${yT + finH} L ${0.008 * b} ${yT + finH} L ${0.012 * b} ${yT} Z" fill="${fill}" stroke="${stroke}" stroke-width="0.06"/>`);
    const bh = (g.htFrac != null ? g.htFrac : 0.35) * b;
    const sy = g.tail === 'T' ? yT + finH : yT - H * 0.10;
    p.push(`<path d="M ${-bh / 2} ${sy} L ${bh / 2} ${sy} L ${bh / 2} ${sy - 0.012 * b} L ${-bh / 2} ${sy - 0.012 * b} Z" fill="${fill}" stroke="${stroke}" stroke-width="0.05"/>`);
    // engines
    const E = engineSpec(a);
    if (E && E.kind === 'wing') {
      const ecy = yB * 0.62 + 0.15 * E.fan;
      for (const sg of [-1, 1]) p.push(`<circle cx="${sg * 0.34 * (b / 2)}" cy="${ecy}" r="${E.dia / 2}" fill="${fill}" stroke="${stroke}" stroke-width="0.07"/>`);
    } else if (E && E.kind === 'aft') {
      for (const sg of [-1, 1]) p.push(`<circle cx="${sg * (w / 2 + E.dia * 0.48)}" cy="${yB + H * 0.66}" r="${E.dia / 2}" fill="${fill}" stroke="${stroke}" stroke-width="0.07"/>`);
    } else if (E && E.kind === 'prop') {
      p.push(`<circle cx="0" cy="${cy}" r="${E.dia / 2}" fill="none" stroke="${stroke}" stroke-width="0.06" stroke-dasharray="0.4 0.3"/>`);
    }
    return { x0: -b / 2, y0: 0, w: b, h: s.hgt || yT + finH, svg: p.join('') };
  }

  // Seat groups either side of the aisle(s): 4 -> 2-2, 5 -> 2-3, 9 -> 3-3-3.
  function seatGroups(n, aisles) {
    if (!n) return [];
    if (aisles <= 0) return [n];
    if (aisles === 1) {
      const l = Math.floor(n / 2);
      return n === 3 ? [1, 2] : [l, n - l];
    }
    if (n === 10) return [3, 4, 3];
    if (n === 9) return [3, 3, 3];
    const mid = n - 6;
    return [3, Math.max(2, mid), 3];
  }

  // Cabin cross-section: outer fuselage, cabin floor, a row of seats at the
  // real seat width, and a 1.8 m person standing in the aisle.
  function geoCabin(a, fill, stroke, color, over) {
    const s = a.s, w = s.fusew || 3, H = s.fuseh || w;
    const cw = s.cabw || w * 0.92, ch = s.cabh || H * 0.6;
    const p = [];
    const cy = H / 2;                       // fuselage centre, measured from its own bottom
    const floor = cy - (H / 2) * 0.34;      // cabin floor sits below the widest point
    // Overlaid, the sections nest, so they are drawn as bare outlines: an opaque
    // interior would hide every smaller cabin behind the largest one, and five
    // sets of seats on top of each other say nothing.
    p.push(`<ellipse cx="0" cy="${cy}" rx="${w / 2}" ry="${H / 2}" fill="${over ? 'none' : fill}" stroke="${stroke}" stroke-width="${over ? 0.07 : 0.05}"/>`);
    p.push(`<ellipse cx="0" cy="${cy}" rx="${cw / 2}" ry="${(H / 2) - (w - cw) / 2}" fill="${over ? 'none' : '#0d0f12'}" stroke="${stroke}" stroke-width="0.03" ${over ? 'stroke-dasharray="0.25 0.18"' : ''}/>`);
    p.push(`<line x1="${-cw / 2}" y1="${floor}" x2="${cw / 2}" y2="${floor}" stroke="${stroke}" stroke-width="0.05"/>`);
    if (over) {
      // name at the widest point, just outside its own ring — identity never by colour alone
      return { x0: -w / 2 - 0.1, y0: 0, w: w + 2.6, h: H, align: cy, svg: p.join(''),
               // where renderScale should hang this ring's name: its own 45° point
               tag: { x: (w / 2) * 0.807, y: cy + (H / 2) * 0.707 } };
    }
    // seats — real economy seat width, real abreast count, seat back scaled to
    // the cabin so a 1.10 m airline seat doesn't tower over a light single
    const sw = (s.seatw || 44) / 100, groups = seatGroups(s.abreast, s.aisles);
    const nSeats = groups.reduce((x, y) => x + y, 0);
    const back = Math.min(1.10, ch * 0.58);
    const aisleW = Math.max(0.15, (cw - nSeats * sw) / Math.max(1, s.aisles || 1));
    if (nSeats) {
      let x = -cw / 2 + (s.aisles ? 0.04 : (cw - nSeats * sw) / 2);
      for (let gi = 0; gi < groups.length; gi++) {
        for (let i = 0; i < groups[gi]; i++) {
          p.push(`<path d="M ${x + 0.02} ${floor} L ${x + sw - 0.02} ${floor} L ${x + sw - 0.02} ${floor + back * 0.38}
            L ${x + sw - 0.06} ${floor + back} L ${x + 0.06} ${floor + back} L ${x + 0.02} ${floor + back * 0.38} Z"
            fill="${color}66" stroke="${color}" stroke-width="0.025"/>`);
          x += sw;
        }
        if (gi < groups.length - 1) x += aisleW;
      }
    }
    // A 1.8 m person stands in the aisle — which is the honest way to show what
    // a 1.85 m cabin means. A cabin with no aisle gets them alongside instead,
    // because nobody stands up in a Skyhawk.
    let extraW = 0;
    if (st.human) {
      if (s.aisles) {
        p.push(personPath(-cw / 2 + 0.04 + groups[0] * sw + aisleW / 2, floor, 1.8, '#9aa5b2'));
      } else {
        p.push(personPath(w / 2 + 0.55, 0, 1.8, '#6f7a88'));
        extraW = 1.1;
      }
    }
    return { x0: -w / 2 - 0.1, y0: 0, w: w + 0.2 + extraW, h: Math.max(H, floor + 1.95),
             align: H / 2, svg: p.join('') };
  }

  // A 1.8 m pictogram, drawn y-up in metres so it can be dropped into any view.
  function personPath(x, y, h, col) {
    const s = h / 1.8;
    return `<g transform="translate(${x} ${y}) scale(${s})" fill="${col}" opacity="0.92">
      <circle cx="0" cy="1.62" r="0.115"/>
      <rect x="-0.135" y="0.86" width="0.27" height="0.62" rx="0.09"/>
      <rect x="-0.205" y="0.95" width="0.068" height="0.50" rx="0.034"/>
      <rect x="0.137" y="0.95" width="0.068" height="0.50" rx="0.034"/>
      <rect x="-0.118" y="0.02" width="0.095" height="0.87" rx="0.045"/>
      <rect x="0.023" y="0.02" width="0.095" height="0.87" rx="0.045"/></g>`;
  }

  // Small silhouette for the headline card — planform, one shared scale.
  function svgThumb(a, color, maxDim, boxFrac) {
    const g = geoTop(a, color + '33', color);
    const W = 260, pad = 4;
    const k = (W - pad * 2) / maxDim;
    const h = (boxFrac != null ? boxFrac * (W - pad * 2) : g.h * k) + pad * 2;
    const oy = (h - g.h * k) / 2;
    return `<svg viewBox="0 0 ${W} ${h}" role="img" aria-label="${esc(a.name)} planform, drawn to a shared scale">
      <g transform="translate(${pad} ${oy}) scale(${k}) translate(${-g.x0} ${-g.y0})">${g.svg}</g></svg>`;
  }

  const GEO = { top: geoTop, side: geoSide, front: geoFront, cabin: geoCabin };
  const VIEW_CAPTION = {
    top: 'Planform, every airplane at the same scale. Wing shape comes from the published span, area and quarter-chord sweep with a taper ratio assumed per type; nacelles are drawn at the real fan diameter.',
    side: 'Side view. Fuselage depth, tail height and fan diameter are from the table; ground clearance, gear and tail-cone shape are indicative.',
    front: 'Front view — wingspan against tail height, which is the pair that decides what gate and taxiway an airplane may use.',
    cabin: 'Cabin cross-section at the real fuselage width and depth, with a row of seats at the published economy seat width and a 1.8 m person standing in the aisle. Overlaid, the sections nest — which is the whole argument between a 2.10 m tube and a 5.87 m one.'
  };

  function renderScale() {
    const host = $('draw-host'), sel = selected();
    if (!sel.length) { host.innerHTML = '<p class="empty-note">Pick an airplane to draw.</p>'; $('draw-legend').innerHTML = ''; $('draw-caption').textContent = ''; return; }
    const view = st.view, over = st.mode === 'over';
    // Planform and side overlay nose-to-nose; front views and cabin sections
    // overlay concentrically, which is the only way to see one cabin inside another.
    const centred = view === 'front' || view === 'cabin';
    const geos = sel.map(a => ({ a, g: GEO[view](a, colorOf(a.id) + (over ? '22' : '3a'), colorOf(a.id), colorOf(a.id), over) }));

    const W = Math.min(1180, Math.max(560, host.clientWidth - 28));
    const LBL = 118, PAD = 10;
    const maxW = Math.max(...geos.map(x => x.g.w));
    const k = (W - LBL - PAD * 2) / maxW;               // metres -> px, shared by all
    const flip = view !== 'top';                        // side/front/cabin have y up

    let body = '', y = PAD;
    if (over) {
      // Most views stack on a common ground line. A geometry that declares an
      // `align` (the cabin section's own centreline) is laid out about that line
      // instead, so the sections come out concentric rather than sitting on the
      // floor of the biggest one.
      const useAlign = geos.every(x => x.g.align != null);
      const above = Math.max(...geos.map(x => useAlign ? x.g.h - x.g.align : x.g.h));
      const below = useAlign ? Math.max(...geos.map(x => x.g.align)) : 0;
      const line = PAD + above * k;                    // screen y of the alignment line
      const H = (above + below) * k + PAD * 2 + 30;
      body = geos.map(({ a, g }) => {
        const ox = LBL + PAD + (centred ? (maxW - g.w) * k / 2 : 0);
        const oy = flip ? line + (useAlign ? (g.align - g.y0) * k : 0)
                        : PAD + (above - g.h) * k / 2;
        const t = flip ? `translate(${ox} ${oy}) scale(${k} ${-k}) translate(${-g.x0} ${-g.y0})`
                       : `translate(${ox} ${oy}) scale(${k}) translate(${-g.x0} ${-g.y0})`;
        return `<g transform="${t}">${g.svg}</g>`;
      }).join('');
      // Concentric rings put their names close together; step the colliding ones
      // apart in screen space, which is the only place the collision is real.
      const tags = geos.filter(x => x.g.tag).map(({ a, g }) => ({
        name: a.name, c: colorOf(a.id),
        x: LBL + PAD + (centred ? (maxW - g.w) * k / 2 : 0) + (g.tag.x - g.x0) * k,
        y: line - (g.tag.y - g.align) * k
      })).sort((p1, p2) => p1.y - p2.y);
      for (let i = 1; i < tags.length; i++) tags[i].y = Math.max(tags[i].y, tags[i - 1].y + 16);
      body += tags.map(t => `<text x="${t.x}" y="${t.y}" fill="${t.c}" font-size="12.5"
        font-family="inherit" dominant-baseline="middle"
        style="paint-order:stroke;stroke:#101216;stroke-width:3px">${esc(t.name)}</text>`).join('');
      y = H;
    } else {
      for (const { a, g } of geos) {
        const rowH = g.h * k;
        const oy = flip ? y + rowH : y;
        const t = flip ? `translate(${LBL + PAD} ${oy}) scale(${k} ${-k}) translate(${-g.x0} ${-g.y0})`
                       : `translate(${LBL + PAD} ${oy}) scale(${k}) translate(${-g.x0} ${-g.y0})`;
        body += `<g transform="${t}">${g.svg}</g>`;
        body += `<text x="${LBL - 8}" y="${y + rowH / 2 - 3}" text-anchor="end" fill="#dde5ee" font-size="12.5" font-family="inherit">${esc(a.name)}</text>`;
        const dim = view === 'top' ? `${fmtNum('len', a.s.len)} ${unitLabel('len')} long`
          : view === 'front' ? `${fmtNum('span', a.s.span)} ${unitLabel('span')} span`
          : view === 'cabin' ? `${fmtNum('cabw', a.s.cabw || a.s.fusew)} ${unitLabel('cabw')} cabin`
          : `${fmtNum('hgt', a.s.hgt)} ${unitLabel('hgt')} tall`;
        body += `<text x="${LBL - 8}" y="${y + rowH / 2 + 12}" text-anchor="end" fill="#707b89" font-size="11" font-family="inherit">${esc(dim)}</text>`;
        if (view !== 'top' && view !== 'cabin') body += `<line x1="${LBL + PAD}" y1="${y + rowH}" x2="${W - PAD}" y2="${y + rowH}" stroke="#2b323b" stroke-width="1"/>`;
        y += rowH + 26;
      }
    }

    // human figure for scale, and a scale bar in whichever unit is showing
    let extras = '';
    if (st.human && view !== 'cabin') {
      const ph = 1.8 * k;
      extras += `<g transform="translate(${LBL + PAD + 4} ${y + 26}) scale(${ph / 1.8} ${-ph / 1.8})">${personPath(0, 0, 1.8, '#8b95a3')}</g>`;
      extras += `<text x="${LBL + PAD + 4 + Math.max(14, ph * 0.35)}" y="${y + 22}" fill="#707b89" font-size="11" font-family="inherit">1.8 m</text>`;
    }
    // Round the scale bar in the unit on screen — "100 ft", not "32.8 ft".
    const dl = unitDef('len');
    const barM = niceScale(maxW * dl.f / 4) / dl.f;
    const bx = W - PAD - barM * k;
    extras += `<line x1="${bx}" y1="${y + 20}" x2="${bx + barM * k}" y2="${y + 20}" stroke="#8b95a3" stroke-width="2"/>
      <line x1="${bx}" y1="${y + 15}" x2="${bx}" y2="${y + 25}" stroke="#8b95a3" stroke-width="2"/>
      <line x1="${bx + barM * k}" y1="${y + 15}" x2="${bx + barM * k}" y2="${y + 25}" stroke="#8b95a3" stroke-width="2"/>
      <text x="${bx + barM * k / 2}" y="${y + 38}" text-anchor="middle" fill="#8b95a3" font-size="11" font-family="inherit">${Math.round(barM * dl.f).toLocaleString('en-US')} ${unitLabel('len')}</text>`;

    const H = y + 52;
    host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" style="width:${W}px;max-width:100%" role="img"
      aria-label="${esc(sel.map(a => a.name).join(', '))} drawn to a common scale">${body}${extras}</svg>`;

    $('draw-legend').innerHTML = sel.map(a =>
      `<span style="--c:${colorOf(a.id)}"><i></i>${esc(a.name)}</span>`).join('');
    $('draw-caption').innerHTML = VIEW_CAPTION[view] +
      ' <b>Generated from the table, not traced</b> — so the proportions are as good as the numbers and no better.';
  }

  function niceScale(x) {
    const p = Math.pow(10, Math.floor(Math.log10(x)));
    const n = x / p;
    return (n >= 5 ? 5 : n >= 2 ? 2 : 1) * p;
  }

  /* ---- charts ----------------------------------------------------------- */
  const numericFields = () => DB.fields.filter(f => isNum(f.u));

  function fillFieldSelect(el, value) {
    el.innerHTML = DB.groups.map(g => {
      const fs = numericFields().filter(f => f.g === g.id);
      if (!fs.length) return '';
      return `<optgroup label="${esc(g.label)}">` +
        fs.map(f => `<option value="${f.id}"${f.id === value ? ' selected' : ''}>${esc(f.l)}</option>`).join('') +
        '</optgroup>';
    }).join('');
  }

  function renderBars() {
    const f = F[st.barField];
    const pool = st.barAll ? DB.aircraft : selected();
    const rows = pool.map(a => ({ a, v: val(a, f.id) })).filter(r => r.v != null);
    rows.sort((x, y) => y.v - x.v);
    const max = rows.length ? Math.max(...rows.map(r => Math.abs(r.v))) : 1;
    const host = $('bar-chart');
    if (!rows.length) { host.innerHTML = '<p class="empty-note">No aircraft in this selection carries that measurement.</p>'; return; }
    host.innerHTML = rows.map(({ a, v }) => {
      const on = SEL.includes(a.id);
      const c = on ? colorOf(a.id) : '#39424d';
      const pct = Math.max(0.6, Math.abs(v) / max * 100);
      const lbl = (a.approx.has(f.id) ? '≈' : '') + fmtNum(f.id, v) + ' ' + unitLabel(f.id);
      return `<span class="bl" style="${on ? 'color:#e8eef5' : ''}">${esc(a.name)}</span>
        <span class="bt" title="${esc(a.full)} — ${esc(f.l)}: ${esc(lbl)}"><span class="bf" style="--c:${c};width:${pct}%"></span></span>
        <span class="bv">${esc(lbl)}</span>`;
    }).join('');
  }

  function renderScatter() {
    const fx = F[st.scX], fy = F[st.scY], host = $('scatter');
    const pts = DB.aircraft.map(a => ({ a, x: val(a, fx.id), y: val(a, fy.id) }))
      .filter(p => p.x != null && p.y != null && (!st.scLog || (p.x > 0 && p.y > 0)));
    if (pts.length < 2) { host.innerHTML = '<p class="empty-note">Not enough aircraft carry both of those measurements.</p>'; return; }

    const W = 900, H = 420, ML = 66, MR = 16, MT = 14, MB = 44;
    const dx = unitDef(fx.id), dy = unitDef(fy.id);
    const tx = v => v * dx.f, ty = v => v * dy.f;
    const sc = (v, lo, hi, a, b) => st.scLog
      ? a + (Math.log10(v) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo)) * (b - a)
      : a + (v - lo) / (hi - lo) * (b - a);

    const xs = pts.map(p => tx(p.x)), ys = pts.map(p => ty(p.y));
    const pad = (lo, hi) => st.scLog ? [lo / 1.35, hi * 1.35] : [lo - (hi - lo) * 0.08, hi + (hi - lo) * 0.08];
    let [x0, x1] = pad(Math.min(...xs), Math.max(...xs));
    let [y0, y1] = pad(Math.min(...ys), Math.max(...ys));
    if (!st.scLog) { x0 = Math.min(0, x0); y0 = Math.min(0, y0); }

    const px = v => sc(v, x0, x1, ML, W - MR);
    const py = v => sc(v, y0, y1, H - MB, MT);

    const ticks = (lo, hi) => {
      const out = [];
      if (st.scLog) {
        for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e++)
          for (const m of [1, 2, 5]) { const v = m * Math.pow(10, e); if (v >= lo && v <= hi) out.push(v); }
      } else {
        const step = niceScale((hi - lo) / 5);
        for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) out.push(v);
      }
      return out;
    };
    const fmtT = v => v >= 10000 ? (v / 1000).toFixed(0) + 'k' : v.toLocaleString('en-US', { maximumFractionDigits: v < 10 ? 1 : 0 });

    let g = '';
    for (const v of ticks(x0, x1)) g += `<line x1="${px(v)}" y1="${MT}" x2="${px(v)}" y2="${H - MB}" stroke="#22272e"/>
      <text x="${px(v)}" y="${H - MB + 16}" text-anchor="middle" fill="#6c7683" font-size="10.5">${fmtT(v)}</text>`;
    for (const v of ticks(y0, y1)) g += `<line x1="${ML}" y1="${py(v)}" x2="${W - MR}" y2="${py(v)}" stroke="#22272e"/>
      <text x="${ML - 8}" y="${py(v) + 3.5}" text-anchor="end" fill="#6c7683" font-size="10.5">${fmtT(v)}</text>`;

    let marks = '', labels = '';
    for (const p of pts) {
      const on = SEL.includes(p.a.id);
      const cx = px(tx(p.x)), cy = py(ty(p.y));
      const c = on ? colorOf(p.a.id) : '#4a545f';
      // Selected marks are filled and ringed in the surface colour so overlapping
      // points stay separable; everything else is a hollow neutral dot.
      marks += `<circle cx="${cx}" cy="${cy}" r="${on ? 6.5 : 4}" fill="${on ? c : 'none'}"
        stroke="${on ? '#14171b' : c}" stroke-width="${on ? 2 : 1.4}"><title>${esc(p.a.full)}
${esc(fx.l)}: ${fmtNum(fx.id, p.x)} ${unitLabel(fx.id)}
${esc(fy.l)}: ${fmtNum(fy.id, p.y)} ${unitLabel(fy.id)}</title></circle>`;
      if (on) {
        const right = cx > W - MR - 90;
        labels += `<text x="${cx + (right ? -10 : 10)}" y="${cy + 4}" fill="#e6edf5" font-size="11.5"
          font-family="inherit" text-anchor="${right ? 'end' : 'start'}"
          style="paint-order:stroke;stroke:#101216;stroke-width:3px">${esc(p.a.name)}</text>`;
      }
    }

    host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(fy.l)} against ${esc(fx.l)}">
      ${g}${marks}${labels}
      <text x="${(ML + W - MR) / 2}" y="${H - 6}" text-anchor="middle" fill="#8b95a3" font-size="11.5" font-family="inherit">${esc(fx.l)}${unitLabel(fx.id) ? ' · ' + esc(unitLabel(fx.id)) : ''}</text>
      <text x="14" y="${(MT + H - MB) / 2}" text-anchor="middle" fill="#8b95a3" font-size="11.5" font-family="inherit"
        transform="rotate(-90 14 ${(MT + H - MB) / 2})">${esc(fy.l)}${unitLabel(fy.id) ? ' · ' + esc(unitLabel(fy.id)) : ''}</text>
    </svg>`;
  }

  function renderWeights() {
    const sel = selected().filter(a => a.s.mtow && a.s.oew);
    const host = $('weight-chart');
    if (!sel.length) { host.innerHTML = '<p class="empty-note">Pick an airplane with published weights.</p>'; $('weight-legend').innerHTML = ''; return; }
    // "scale" compares airplanes; "share" compares how each one spends its own
    // MTOW — two different questions, so two scales rather than one compromise.
    const max = st.wtShare ? null : Math.max(...sel.map(a => a.s.mtow));
    // Load the maximum structural payload first, then pour in whatever fuel still
    // fits under MTOW — the max-payload corner of the payload-range diagram, as a
    // bar. Where no MZFW is published (light aircraft), payload is instead what
    // fits with full tanks, which is how those airplanes are actually loaded.
    const payloadOf = a => a.d.payload != null ? a.d.payload
      : Math.max(0, a.s.mtow - a.s.oew - (a.s.fuelkg || 0));
    const SEG = [
      ['Empty', '#5a6675', a => a.s.oew],
      ['Payload', '#3987e5', payloadOf],
      ['Fuel', '#c98500', a => Math.min(a.s.fuelkg || 0, a.s.mtow - a.s.oew - payloadOf(a))]
    ];
    host.innerHTML = sel.map(a => {
      let acc = 0;
      const den = max || a.s.mtow;
      const segs = SEG.map(([lbl, c, fn]) => {
        const v = Math.max(0, fn(a) || 0);
        const left = acc / den * 100, wdt = v / den * 100;
        acc += v;
        return v > 0 ? `<span style="position:absolute;left:${left}%;width:calc(${wdt}% - 2px);top:0;bottom:0;background:${c};border-radius:2px"
          title="${esc(a.name)} — ${lbl}: ${fmtNum('mtow', v)} ${unitLabel('mtow')}"></span>` : '';
      }).join('');
      const mtowPct = a.s.mtow / den * 100;
      return `<span class="bl" style="color:#e8eef5">${esc(a.name)}
        <span style="display:block;color:#6f7a88;font-size:11px">${fmtNum('mtow', a.s.mtow)} ${unitLabel('mtow')}</span></span>
        <span class="bt" style="height:22px">${segs}
        <span style="position:absolute;left:${mtowPct}%;top:0;bottom:0;width:2px;background:#8b95a3" title="MTOW"></span></span>`;
    }).join('');
    $('weight-legend').innerHTML = SEG.map(([l, c]) => `<span style="--c:${c}"><i></i>${l}</span>`).join('') +
      '<span style="--c:#8b95a3"><i style="width:3px"></i>MTOW</span>';
  }

  /* ---- fleet ------------------------------------------------------------ */
  const FLEET_COLS = ['paxt', 'range', 'mtow', 'len', 'span', 'thrusttot', 'ceil', 'mach', 'built', 'eis'];

  function renderFleet() {
    const cat = st.fleetCat;
    const rows = DB.aircraft.filter(a => !cat || a.cat === cat || a.family === cat);
    const { k, dir } = st.fleetSort;
    rows.sort((x, y) => {
      const a = k === 'name' ? x.name : val(x, k), b = k === 'name' ? y.name : val(y, k);
      if (a == null) return 1;
      if (b == null) return -1;
      return (a > b ? 1 : a < b ? -1 : 0) * dir;
    });
    const th = (id, label, cls) =>
      `<th class="${cls || ''}${st.fleetSort.k === id ? ' sorted' + (dir > 0 ? ' asc' : '') : ''}" data-sort="${id}">${esc(label)}</th>`;
    $('fleet-wrap').innerHTML = '<table class="fleet"><thead><tr>' +
      th('name', 'Aircraft', 'l') + '<th class="l">Family</th>' +
      FLEET_COLS.map(id => th(id, F[id].l + (unitLabel(id) ? ` (${unitLabel(id)})` : ''))).join('') +
      '</tr></thead><tbody>' + rows.map(a => {
        const on = SEL.includes(a.id);
        return `<tr class="${on ? 'on' : ''}" data-id="${a.id}" style="--c:${on ? colorOf(a.id) : 'transparent'}">
          <td class="l" style="color:#e2e9f1">${esc(a.name)}</td><td class="l" style="color:#7d8794">${esc(a.family)}</td>` +
          FLEET_COLS.map(id => {
            const v = val(a, id);
            if (v == null) return '<td style="color:#4c545e">—</td>';
            return `<td>${isNum(F[id].u) ? (a.approx.has(id) ? '≈' : '') + fmtNum(id, v) : esc(v)}</td>`;
          }).join('') + '</tr>';
      }).join('') + '</tbody></table>';
  }

  /* ---- data tab --------------------------------------------------------- */
  function renderDataTab() {
    $('src-list').innerHTML = DB.sources.map(s => `<li>${esc(s)}</li>`).join('');
    $('caveat-list').innerHTML = DB.caveats.map(s => `<li>${esc(s)}</li>`).join('');
    const total = DB.fields.length;
    $('cov-list').innerHTML = DB.aircraft.map(a => {
      const n = DB.fields.filter(f => val(a, f.id) != null).length;
      const pct = n / total * 100;
      return `<span class="cn">${esc(a.name)}</span>
        <span class="ct"><span class="cf" style="width:${pct}%"></span></span>
        <span class="cv">${n} / ${total}</span>`;
    }).join('');
  }

  /* ---- orchestration ---------------------------------------------------- */
  function renderAll() {
    renderChips();
    renderHeads();
    if (TAB === 'table') renderTable();
    if (TAB === 'scale') renderScale();
    if (TAB === 'charts') { renderBars(); renderScatter(); renderWeights(); }
    if (TAB === 'fleet') renderFleet();
    if (TAB === 'data') renderDataTab();
    writeHash();
  }

  function showTab(t) {
    TAB = t;
    for (const b of document.querySelectorAll('.tab-btn')) b.classList.toggle('active', b.dataset.tab === t);
    for (const p of document.querySelectorAll('.tab-panel')) p.classList.toggle('active', p.id === 'tab-' + t);
    renderAll();
  }

  /* ---- wiring ----------------------------------------------------------- */
  function wire() {
    $('chips').addEventListener('click', e => {
      const b = e.target.closest('.chip'); if (b) toggle(b.dataset.id);
    });
    $('heads').addEventListener('click', e => {
      const b = e.target.closest('[data-rm]'); if (b) toggle(b.dataset.rm);
    });
    $('q').addEventListener('input', e => { st.q = e.target.value; renderChips(); });

    $('presets').innerHTML = PRESETS.map((p, i) =>
      `<button class="preset" data-p="${i}">${esc(p.label)}</button>`).join('');
    $('presets').addEventListener('click', e => {
      const b = e.target.closest('.preset'); if (!b) return;
      SEL = PRESETS[+b.dataset.p].ids.filter(id => A[id]).slice(0, MAX_SEL);
      renderAll();
    });

    $('tabs').addEventListener('click', e => {
      const b = e.target.closest('.tab-btn'); if (b) showTab(b.dataset.tab);
    });

    $('units').addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      UNIT = b.dataset.u;
      for (const x of $('units').children) x.classList.toggle('on', x === b);
      renderAll();
    });

    for (const [id, key] of [['opt-bars', 'bars'], ['opt-best', 'best'], ['opt-diff', 'diff'], ['opt-empty', 'hideEmpty']])
      $(id).addEventListener('change', e => { st[key] = e.target.checked; renderTable(); });
    $('fq').addEventListener('input', e => { st.fq = e.target.value; renderTable(); });

    $('tbl-wrap').addEventListener('click', e => {
      const g = e.target.closest('tr.grp'); if (!g) return;
      const id = g.dataset.grp;
      st.collapsed.has(id) ? st.collapsed.delete(id) : st.collapsed.add(id);
      renderTable();
    });

    $('copy-tsv').addEventListener('click', () => {
      const tsv = tableRows().map(r => r.join('\t')).join('\n');
      navigator.clipboard.writeText(tsv).then(() => flash($('copy-tsv'), 'Copied'));
    });
    $('dl-csv').addEventListener('click', () => {
      const csv = tableRows().map(r => r.map(c => /[",\n]/.test(c) ? '"' + String(c).replace(/"/g, '""') + '"' : c).join(',')).join('\n');
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      const a = document.createElement('a');
      a.href = url; a.download = 'aircraft-compare.csv'; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });

    $('views').addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      st.view = b.dataset.v;
      for (const x of $('views').children) x.classList.toggle('on', x === b);
      renderScale();
    });
    $('modes').addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      st.mode = b.dataset.m;
      for (const x of $('modes').children) x.classList.toggle('on', x === b);
      renderScale();
    });
    $('opt-human').addEventListener('change', e => { st.human = e.target.checked; renderScale(); });

    $('bar-field').addEventListener('change', e => { st.barField = e.target.value; renderBars(); });
    $('bar-all').addEventListener('change', e => { st.barAll = e.target.checked; renderBars(); });
    $('sc-x').addEventListener('change', e => { st.scX = e.target.value; renderScatter(); });
    $('sc-y').addEventListener('change', e => { st.scY = e.target.value; renderScatter(); });
    $('sc-log').addEventListener('change', e => { st.scLog = e.target.checked; renderScatter(); });
    $('wtmode').addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      st.wtShare = b.dataset.w === 'share';
      for (const x of $('wtmode').children) x.classList.toggle('on', x === b);
      renderWeights();
    });

    $('fleet-wrap').addEventListener('click', e => {
      const h = e.target.closest('th[data-sort]');
      if (h) {
        const k = h.dataset.sort;
        st.fleetSort = { k, dir: st.fleetSort.k === k ? -st.fleetSort.dir : (k === 'name' ? 1 : -1) };
        return renderFleet();
      }
      const r = e.target.closest('tr[data-id]');
      if (r) toggle(r.dataset.id);
    });
    $('fleet-cat').addEventListener('change', e => { st.fleetCat = e.target.value; renderFleet(); });

    window.addEventListener('resize', () => { if (TAB === 'scale') renderScale(); });

    // A shared link pasted into an already-open page is a same-document
    // navigation — nothing reloads — so pick the new selection up by hand.
    // (Our own writes use replaceState, so this only fires for real navigation.)
    window.addEventListener('hashchange', () => {
      const before = SEL.join(',') + UNIT + TAB;
      readHash();
      if (SEL.join(',') + UNIT + TAB === before) return;
      for (const b of $('units').children) b.classList.toggle('on', b.dataset.u === UNIT);
      showTab(TAB);
    });
  }

  function flash(btn, text) {
    const old = btn.textContent;
    btn.textContent = text;
    setTimeout(() => { btn.textContent = old; }, 1200);
  }

  /* ---- boot ------------------------------------------------------------- */
  function init(db) {
    DB = db;
    for (const f of DB.fields) F[f.id] = f;
    for (const a of DB.aircraft) { prepare(a); A[a.id] = a; }
    SEL = DEFAULT_SEL.filter(id => A[id]);
    readHash();
    wire();
    fillFieldSelect($('bar-field'), st.barField);
    fillFieldSelect($('sc-x'), st.scX);
    fillFieldSelect($('sc-y'), st.scY);
    const cats = [...new Set(DB.aircraft.map(a => a.cat))].sort();
    const fams = [...new Set(DB.aircraft.map(a => a.family))].sort();
    $('fleet-cat').innerHTML = '<option value="">Everything</option>' +
      cats.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('') +
      fams.map(c => `<option value="${esc(c)}">${esc(c)} family</option>`).join('');
    for (const b of $('units').children) b.classList.toggle('on', b.dataset.u === UNIT);
    showTab(TAB);
    // A read-only handle, so a headless run can check the numbers.
    window.ACOMP = Object.freeze({ db: () => DB, sel: () => SEL.slice(), val, fmtNum, derive: id => A[id] && A[id].d });
  }

  fetch(DATA_URL)
    .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(init)
    .catch(err => {
      document.getElementById('heads').innerHTML =
        `<p class="empty-note">Could not load <code>${DATA_URL}</code> (${esc(err.message)}). ` +
        'This page needs to be served over http — open it from a local server, not the file system.</p>';
    });
})();
