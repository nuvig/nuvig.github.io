/* alternates.js — Alternate Rules & Advisement (alternates.html)
   Tab plumbing + a small declarative flowchart engine.

   Each chart is a DAG of nodes:
     question: { q, s?, d?, ref?, opts: [[edgeLabel, targetId, back?], ...] }
     terminal: { end: 'ok'|'req'|'bad'|'info', t, d?, ref?, opts? }
   `s` is a short label for the SVG box (the panel shows the full `q`).
   An opt's third element marks a back-edge (e.g. "try another candidate") —
   back-edges are answerable from the panel but excluded from layout and the
   drawn graph, which keeps the DAG a DAG.

   Layout is automatic: longest-path depth → rows, two barycenter sweeps for
   ordering, evenly spaced columns. The SVG is drawn once per chart; answering
   just retags node/edge classes, so the taken path lights up in place. */
(function () {
  'use strict';

  /* ---------------- tabs (terps.html pattern) ---------------- */
  document.querySelectorAll('.tab-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.querySelectorAll('.tab-btn').forEach(function (b) { b.classList.remove('active'); });
      document.querySelectorAll('.tab-panel').forEach(function (p) { p.classList.remove('active'); });
      btn.classList.add('active');
      document.getElementById(btn.dataset.tab).classList.add('active');
    });
  });

  /* ---------------- chart data ---------------- */

  var CHARTS = {

    /* ---- Part 91 — 91.167 / 91.169 ---- */
    p91: {
      start: 'start',
      nodes: {
        start: {
          q: 'Are you filing an IFR flight plan?',
          s: 'Filing IFR?',
          d: '§91.169 attaches to the IFR flight plan. VFR flying carries no alternate ' +
             'requirement — only the VFR fuel reserves (§91.151: 30 min day / 45 min night).',
          opts: [['Yes', 'dest'], ['No', 'vfr']]
        },
        vfr: {
          end: 'info', t: 'No alternate rules apply',
          d: 'Alternate requirements live in the IFR flight plan regulations.'
        },
        dest: {
          q: 'Does the destination have at least one published instrument approach?',
          s: 'Destination has an IAP?',
          ref: '91.169(b)(1)',
          d: 'A Part 97 standard procedure, or a special IAP issued to you by the FAA. ' +
             'With no approach at the destination (KANP, say), the weather exception is ' +
             'unavailable — an alternate is always required.',
          opts: [['Yes', 'wx'], ['No', 'need']]
        },
        wx: {
          q: 'From 1 hour before to 1 hour after your ETA, is the forecast ceiling at least 2,000 ft above the field AND visibility at least 3 SM?',
          s: '1-2-3: 2,000 & 3 for ETA ±1 h?',
          ref: '91.169(b)(2)',
          d: 'Appropriate weather reports or forecasts, or a combination. Read the whole TAF — ' +
             'a TEMPO or PROB group below 2,000-3 in the window fails this test. ' +
             'Helicopters: ETA to ETA + 1 h, ceiling ≥ 1,000 ft above the field (or 400 ft above ' +
             'the lowest applicable approach minima, whichever is higher) and visibility ≥ 2 SM.',
          opts: [['Yes', 'none'], ['No', 'need']]
        },
        none: {
          end: 'ok', t: 'No alternate required',
          ref: '91.169(b) · 91.167',
          d: 'Fuel: destination plus 45 minutes at normal cruise (helicopters 30). Nothing stops ' +
             'you filing an alternate anyway on a marginal day — see the Advisement tab.'
        },
        need: {
          end: 'req', t: 'Alternate required — now qualify one',
          ref: '91.169(a) · 91.167(a)(2)',
          d: 'Fuel must cover destination → alternate → 45 minutes. The candidate must be forecast ' +
             'to meet the §91.169(c) weather test at your ETA at the alternate.',
          opts: [['Check a candidate', 'cand']]
        },
        cand: {
          q: 'Does the candidate airport have a published instrument approach?',
          s: 'Candidate has an IAP?',
          ref: '91.169(c)',
          d: 'No approach doesn’t disqualify it — but the bar becomes basic VFR from the enroute structure.',
          opts: [['Yes', 'nav'], ['No', 'vfrdesc']]
        },
        nav: {
          q: 'What will the approach you plan at the alternate navigate by?',
          s: 'Approach at candidate uses…?',
          d: 'The panel decides which planning rules apply: <b>ground-based</b> navaids (ILS, LOC, ' +
             'VOR, NDB), <b>non-WAAS GPS</b> (TSO-C129/C196), or <b>WAAS</b> (TSO-C145/146). ' +
             'GPS-based planning carries its own AIM restrictions before the weather test.',
          opts: [['Ground-based', 'na'], ['GPS, non-WAAS', 'c129', 0, 'non-WAAS'],
                 ['GPS, WAAS', 'waas', 0, 'WAAS']]
        },
        c129: {
          q: 'Are you also planning a GPS-based approach at the destination?',
          s: 'GPS planned at destination too?',
          ref: 'AIM 1-1-17',
          d: 'Non-WAAS GPS planning (with fault detection and exclusion and a preflight RAIM ' +
             'prediction) may rely on a GPS-based approach at the destination <b>or</b> the ' +
             'alternate — <b>not both</b>. The other end needs an approach you can fly ' +
             'conventionally: equipment in the panel, ground station operational.',
          opts: [['No', 'gna'], ['Yes', 'gpsboth']]
        },
        gpsboth: {
          end: 'bad', t: 'Not both ends on GPS',
          ref: 'AIM 1-1-17',
          d: 'Replan: base one end on a conventional approach you’re equipped for (check the navaid ' +
             'NOTAMs), or pick an alternate with a usable ground-based procedure.',
          opts: [['Plan this alternate differently', 'nav', true]]
        },
        waas: {
          q: 'WAAS rule: plan the alternate against the LNAV or circling line — never the LPV line.',
          s: 'WAAS: plan on the LNAV line',
          ref: 'AIM 1-1-18',
          d: 'WAAS may plan RNAV (GPS) approaches at destination <b>and</b> alternate, but the ' +
             'alternate’s weather test must use the <b>LNAV or circling minima</b> (LNAV/VNAV with ' +
             'approved baro-VNAV), or a conventional procedure with “or GPS” in the title. ' +
             'That makes it <b>nonprecision for planning</b> — you still fly the LPV on arrival.',
          opts: [['Continue', 'gna']]
        },
        gna: {
          q: 'Check the TPP Alternate Minimums listing (▲A) for the candidate.',
          s: '▲A listing (GPS path)?',
          d: 'Same ▲A/NA check as any alternate — plus GPS-specific notes: some listings carry ' +
             '“NA when using GPS”-style restrictions. With no ▲A entry, a GPS-planned alternate ' +
             'uses the <b>nonprecision 800-2</b> — an LPV never earns 600-2.',
          opts: [['Marked NA', 'fail', 0, 'NA'], ['Non-standard values', 'pub', 0, '▲A values'],
                 ['No ▲A — standard', 'np', 0, 'standard']]
        },
        vfrdesc: {
          q: 'At your ETA there, will ceiling and visibility allow descent from the MEA, approach, and landing under basic VFR?',
          s: 'Descend from MEA & land basic VFR?',
          ref: '91.169(c)(2)',
          opts: [['Yes', 'qualvfr'], ['No', 'fail']]
        },
        qualvfr: {
          end: 'ok', t: 'Qualifies — VFR-descent alternate',
          ref: '91.169(c)(2)',
          d: 'Legal, but you’re planning a visual arrival at your worst moment — make sure the ' +
             'forecast really supports it.'
        },
        na: {
          q: 'Check the TPP Alternate Minimums listing (▲A) for the candidate.',
          s: '▲A listing?',
          d: 'The ▲A symbol on a plate means non-standard alternate minima are published in the ' +
             'TPP front section. "NA" there means the airport cannot be filed as an alternate for ' +
             'that arrival — usually an unmonitored navaid or no local weather source. NOTAMs can ' +
             'add or lift these.',
          opts: [['Marked NA', 'fail', 0, 'NA'], ['Non-standard values', 'pub', 0, '▲A values'],
                 ['No ▲A — standard', 'type', 0, 'standard']]
        },
        pub: {
          q: 'Does the forecast at your ETA meet the published non-standard values?',
          s: 'Meets published ▲A values?',
          ref: '91.169(c)(1)',
          opts: [['Yes', 'qual'], ['No', 'fail']]
        },
        type: {
          q: 'What kind of ground-based approach will you plan there?',
          s: 'Precision or nonprecision?',
          d: 'Precision = ILS or PAR. Everything else — LOC, VOR, NDB — plans against the ' +
             'nonprecision numbers.',
          opts: [['Precision', 'prec'], ['Nonprecision', 'np']]
        },
        prec: {
          q: 'Forecast at your ETA: ceiling at least 600 ft and visibility 2 SM?',
          s: '600-2 at ETA?',
          ref: '91.169(c)(1)(i)(A)',
          opts: [['Yes', 'qual'], ['No', 'fail']]
        },
        np: {
          q: 'Forecast at your ETA: ceiling at least 800 ft and visibility 2 SM?',
          s: '800-2 at ETA?',
          ref: '91.169(c)(1)(i)(B)',
          opts: [['Yes', 'qual'], ['No', 'fail']]
        },
        qual: {
          end: 'ok', t: 'Qualifies as your alternate',
          ref: '91.169(c)',
          d: 'File it and carry the fuel. Helicopters qualify differently: 200 ft above the minima ' +
             'for the approach to be flown, visibility ≥ 1 SM but never below the procedure’s ' +
             'minimum. Once airborne, the filed alternate is planning paperwork — divert wherever ' +
             'is actually best.'
        },
        fail: {
          end: 'bad', t: 'Doesn’t qualify — pick another candidate',
          opts: [['Try another candidate', 'cand', true]]
        }
      }
    },

    /* ---- Part 121 — 121.617 / .619 / .621 / .623 / .625 ---- */
    p121: {
      start: 'start',
      nodes: {
        start: {
          q: 'Which alternate question?',
          s: 'Takeoff or destination?',
          d: 'Part 121 has two separate alternate requirements: one looking back at the departure ' +
             'airport, one looking ahead to the destination.',
          opts: [['Takeoff', 'toff'], ['Destination', 'kind']]
        },
        toff: {
          q: 'Is departure weather below the landing minimums in your OpSpecs for that airport?',
          s: 'Departure below landing minima?',
          ref: '121.617(a)',
          d: 'The trigger is landing minimums at the departure airport — you could leave, but not ' +
             'get back in if something went wrong right after takeoff.',
          opts: [['Yes', 'toffreq'], ['No', 'toffno']]
        },
        toffno: {
          end: 'ok', t: 'No takeoff alternate needed', ref: '121.617'
        },
        toffreq: {
          end: 'req', t: 'Takeoff alternate required',
          ref: '121.617',
          d: '2 engines: within 1 hour at normal cruise, still air, one engine inoperative. ' +
             '3 or more engines: within 2 hours. Named in the dispatch/flight release, and its ' +
             'weather must meet the OpSpec alternate minima when you’d arrive.'
        },
        kind: {
          q: 'What kind of Part 121 operation?',
          s: 'Domestic, flag or supplemental?',
          d: 'Domestic = scheduled inside the US (§121.619). Flag = scheduled international ' +
             '(§121.621). Supplemental = charter and cargo (§121.623).',
          opts: [['Domestic', 'dom1'], ['Flag', 'flag1'], ['Supplemental', 'sup1']]
        },
        dom1: {
          q: 'From 1 hour before to 1 hour after ETA: forecast ceiling at least 2,000 ft and visibility at least 3 miles?',
          s: '1-2-3 for ETA ±1 h?',
          ref: '121.619(b)',
          opts: [['Yes', 'domno'], ['No', 'dom2']]
        },
        domno: {
          end: 'ok', t: 'No alternate required',
          ref: '121.619(b)',
          d: 'Same 1-2-3 numbers as Part 91. Fuel still per §121.639.'
        },
        dom2: {
          q: 'Are the destination AND the first alternate both forecast marginal?',
          s: 'Destination + first alternate marginal?',
          ref: '121.619(a)',
          d: '"Marginal" is dispatch judgment guided by OpSpecs — commonly read as barely above ' +
             'the applicable minima.',
          opts: [['Yes', 'dom3'], ['No', 'domreq']]
        },
        domreq: {
          end: 'req', t: 'One alternate required',
          ref: '121.619 · 121.625',
          d: 'Listed in the dispatch release; forecast must meet the OpSpec (C055) derived ' +
             'alternate minima at arrival — see the derived-minima card below.'
        },
        dom3: {
          end: 'req', t: 'Second alternate required',
          ref: '121.619(a)',
          d: 'Both alternates listed in the dispatch release, both meeting derived minima.'
        },
        flag1: {
          q: 'Is the flight scheduled for 6 hours or less?',
          s: 'Scheduled ≤ 6 hours?',
          ref: '121.621(a)(1)',
          opts: [['Yes', 'flag2'], ['No', 'flag3']]
        },
        flag2: {
          q: 'ETA ±1 h: ceiling at least 1,500 ft above the lowest circling MDA (no circling: 1,500 above the lowest published minimum, or 2,000 above the field, whichever greater) AND visibility at least 3 miles (or lowest landing vis + 2, whichever greater)?',
          s: '1,500-above-minima & 3 mi test?',
          ref: '121.621(a)(1)',
          opts: [['Yes', 'flagno'], ['No', 'flag3']]
        },
        flagno: {
          end: 'ok', t: 'No alternate required', ref: '121.621(a)(1)'
        },
        flag3: {
          q: 'Is the route approved with no available alternate for this destination (island destination)?',
          s: 'Approved no-alternate route?',
          ref: '121.621(a)(2)',
          opts: [['Yes', 'flagisl'], ['No', 'flagreq']]
        },
        flagisl: {
          end: 'info', t: 'No alternate — island fuel rule',
          ref: '121.621(a)(2) · 121.641(b) / 121.645(c)',
          d: 'Carry fuel to the destination and thereafter 2 hours at normal cruising speed.'
        },
        flagreq: {
          end: 'req', t: 'Alternate required',
          ref: '121.621 · 121.625',
          d: 'Listed in the dispatch release; forecast must meet the OpSpec derived minima at arrival.'
        },
        sup1: {
          q: 'Is the route outside the 48 contiguous states with no available alternate?',
          s: 'No-alternate route outside lower 48?',
          ref: '121.623(b)',
          opts: [['Yes', 'supisl'], ['No', 'supreq']]
        },
        supisl: {
          end: 'info', t: 'No alternate — island fuel rules',
          ref: '121.623(b) · 121.643 / 121.645',
          d: 'Enough fuel per the flag/supplemental fuel rules to proceed without one.'
        },
        supreq: {
          end: 'req', t: 'Alternate always required',
          ref: '121.623',
          d: 'Supplemental IFR or over-the-top has no weather escape: at least one alternate per ' +
             'destination, weather per OpSpecs, each listed in the flight release.'
        }
      }
    },

    /* ---- Part 135 — 135.217 / .219 / .221 / .223 ---- */
    p135: {
      start: 'start',
      nodes: {
        start: {
          q: 'Which alternate question?',
          s: 'Takeoff or destination?',
          opts: [['Takeoff', 'toff'], ['Destination', 'd0']]
        },
        toff: {
          q: 'Is departure weather at or above takeoff minimums but below authorized IFR landing minimums?',
          s: 'Departure below landing minima?',
          ref: '135.217',
          opts: [['Yes', 'toffreq'], ['No', 'toffno']]
        },
        toffno: { end: 'ok', t: 'No takeoff alternate needed', ref: '135.217' },
        toffreq: {
          end: 'req', t: 'Takeoff alternate required',
          ref: '135.217',
          d: 'Within 1 hour at normal cruising speed in still air — note: all engines running, ' +
             'unlike the 121/125 one-engine-inoperative rule.'
        },
        d0: {
          q: 'Is the destination forecast at or above authorized IFR landing minimums at your ETA?',
          s: 'Destination ≥ landing minima at ETA?',
          ref: '135.219',
          d: 'Part 135 gates the launch itself on the destination forecast — no "take a look" ' +
             'dispatch. Part 91 has no equivalent rule.',
          opts: [['Yes', 'd1'], ['No', 'nogo']]
        },
        nogo: {
          end: 'bad', t: 'Can’t begin the IFR segment',
          ref: '135.219',
          d: 'No IFR takeoff toward that destination until reports/forecasts improve — or operate ' +
             'VFR where authorized.'
        },
        d1: {
          q: 'Does the destination have a Part 97 standard instrument approach?',
          s: 'Standard IAP at destination?',
          ref: '135.223(b)',
          d: 'The no-alternate exception requires a standard procedure — a special IAP doesn’t open it.',
          opts: [['Yes', 'd2'], ['No', 'req']]
        },
        d2: {
          q: 'ETA ±1 h: ceiling at least 1,500 ft above the lowest circling MDA (no circling: 1,500 above the lowest published minimum, or 2,000 above the field, whichever higher) AND visibility at least 3 miles (or 2 more than the lowest applicable minimum, whichever greater)?',
          s: '1,500-above-minima & 3 mi test?',
          ref: '135.223(b)',
          opts: [['Yes', 'dno'], ['No', 'req']]
        },
        dno: {
          end: 'ok', t: 'No alternate required',
          ref: '135.223(b)',
          d: 'The alternate fuel leg drops out; destination + 45 minutes at normal cruise still stands.'
        },
        req: {
          end: 'req', t: 'Alternate required — qualify it',
          ref: '135.223(a)',
          d: 'Fuel: destination → alternate → 45 minutes at normal cruise (helicopters 30).',
          opts: [['Check a candidate', 'c1']]
        },
        c1: {
          q: 'Is the candidate forecast at or above your OpSpec alternate airport minimums at your ETA there?',
          s: 'Meets OpSpec alternate minima?',
          ref: '135.221',
          d: 'Airplanes: the derived C055-style minima (see the 121 tab), not 600-2/800-2. ' +
             'Rotorcraft: ceiling 200 ft above the minima for the approach to be flown and ' +
             'visibility ≥ 1 SM (never below the procedure’s); with no IAP, weather allowing ' +
             'descent from the MEA and landing under basic VFR.',
          opts: [['Yes', 'qual'], ['No', 'fail']]
        },
        qual: { end: 'ok', t: 'Qualifies as the alternate', ref: '135.221' },
        fail: {
          end: 'bad', t: 'Doesn’t qualify — pick another candidate',
          opts: [['Try another candidate', 'c1', true]]
        }
      }
    },

    /* ---- Part 125 — 125.365 / .367 / .369 ---- */
    p125: {
      start: 'start',
      nodes: {
        start: {
          q: 'Which alternate question?',
          s: 'Takeoff or destination?',
          opts: [['Takeoff', 'toff'], ['Destination', 'd1']]
        },
        toff: {
          q: 'Is departure weather below the landing minimums in your OpSpecs for that airport?',
          s: 'Departure below landing minima?',
          ref: '125.365(a)',
          opts: [['Yes', 'toffreq'], ['No', 'toffno']]
        },
        toffno: { end: 'ok', t: 'No departure alternate needed', ref: '125.365' },
        toffreq: {
          end: 'req', t: 'Departure alternate required',
          ref: '125.365',
          d: '2 engines: within 1 hour at normal cruise, still air, one engine inoperative; ' +
             '3 or more: within 2 hours. Listed in the flight release, weather per OpSpecs.'
        },
        d1: {
          q: 'Is the route outside the 48 contiguous states with no available alternate?',
          s: 'No-alternate route outside lower 48?',
          ref: '125.367(b)',
          opts: [['Yes', 'isl'], ['No', 'req']]
        },
        isl: {
          end: 'info', t: 'No alternate — fuel rules instead',
          ref: '125.367(b) · 125.375 / 125.377',
          d: 'Carry the fuel those sections prescribe to proceed without one.'
        },
        req: {
          end: 'req', t: 'Alternate always required',
          ref: '125.367 · 125.369',
          d: 'Part 125 has no weather exception: every IFR or over-the-top release lists at least ' +
             'one alternate per destination, forecast at/above the OpSpec alternate weather minima ' +
             'at arrival, each listed in the flight release.'
        }
      }
    }
  };

  /* ---------------- flowchart engine ---------------- */

  var NODE_W = 172, LINE_H = 14, PAD_V = 10, ROW_GAP = 50, COL_GAP = 18;

  function wrapText(t, max) {
    var words = String(t).split(/\s+/), lines = [], cur = '';
    words.forEach(function (w) {
      var next = cur ? cur + ' ' + w : w;
      if (next.length > max && cur) { lines.push(cur); cur = w; }
      else cur = next;
    });
    if (cur) lines.push(cur);
    return lines;
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fwdEdges(chart) {
    var edges = [];
    Object.keys(chart.nodes).forEach(function (id) {
      (chart.nodes[id].opts || []).forEach(function (o) {
        /* o = [buttonLabel, target, backEdge?, shortEdgeLabel?] */
        if (!o[2]) edges.push({ from: id, to: o[1], label: o[3] || o[0] });
      });
    });
    return edges;
  }

  function layoutChart(chart) {
    var ids = Object.keys(chart.nodes);
    var edges = fwdEdges(chart);

    /* longest-path depth by relaxation (small DAGs; back-edges excluded) */
    var depth = {}; depth[chart.start] = 0;
    for (var guard = 0, changed = true; changed && guard < 80; guard++) {
      changed = false;
      edges.forEach(function (e) {
        if (depth[e.from] === undefined) return;
        var d = depth[e.from] + 1;
        if (!(depth[e.to] >= d)) { depth[e.to] = d; changed = true; }
      });
    }

    var rows = [];
    ids.forEach(function (id) {
      if (depth[id] === undefined) return;
      (rows[depth[id]] = rows[depth[id]] || []).push(id);
    });

    var maxLen = 0;
    rows.forEach(function (r) { maxLen = Math.max(maxLen, r.length); });
    var slot = NODE_W + COL_GAP;
    var svgW = Math.max(640, maxLen * slot + 30);

    var box = {};   /* id -> {x (center), y (top), h, lines} */
    ids.forEach(function (id) {
      var n = chart.nodes[id];
      var lines = wrapText(n.s || n.q || n.t, 25);
      box[id] = { lines: lines, h: lines.length * LINE_H + PAD_V * 2 };
    });

    function placeRow(r) {
      var total = rows[r].length * slot;
      var x0 = (svgW - total) / 2 + slot / 2;
      rows[r].forEach(function (id, i) { box[id].x = x0 + i * slot; });
    }
    rows.forEach(function (_, r) { placeRow(r); });

    /* two barycenter sweeps: order each row by mean parent x */
    var parents = {};
    edges.forEach(function (e) { (parents[e.to] = parents[e.to] || []).push(e.from); });
    for (var sweep = 0; sweep < 2; sweep++) {
      rows.forEach(function (row, r) {
        if (r === 0) return;
        row.sort(function (a, b) {
          function bary(id) {
            var ps = parents[id] || [];
            if (!ps.length) return box[id].x;
            var s = 0; ps.forEach(function (p) { s += box[p].x; });
            return s / ps.length;
          }
          return bary(a) - bary(b);
        });
        placeRow(r);
      });
    }

    var y = 16;
    rows.forEach(function (row) {
      var maxH = 0;
      row.forEach(function (id) { maxH = Math.max(maxH, box[id].h); });
      row.forEach(function (id) { box[id].y = y; });
      y += maxH + ROW_GAP;
    });

    return { box: box, edges: edges, w: svgW, h: y - ROW_GAP + 16 };
  }

  function endClass(n) { return n.end ? ' end-' + n.end : ''; }

  function buildSvg(chart, L) {
    var s = '<svg viewBox="0 0 ' + L.w + ' ' + L.h + '" width="' + L.w + '" height="' + L.h +
      '" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Decision flowchart">';

    var srcCount = {};
    L.edges.forEach(function (e) {
      var a = L.box[e.from], b = L.box[e.to];
      var x1 = a.x, y1 = a.y + a.h, x2 = b.x, y2 = b.y;
      var c1y = y1 + 30, c2y = y2 - 30;
      var d = 'M' + x1 + ',' + y1 + ' C' + x1 + ',' + c1y + ' ' + x2 + ',' + c2y + ' ' + x2 + ',' + y2;
      s += '<path class="fc-edge" data-e="' + e.from + '|' + e.to + '" d="' + d + '"/>';
      /* Label near the source (t = 0.35 on the cubic) where sibling edges have
         already fanned apart but haven't reached the next row's boxes; anchor
         away from the curve by direction, and stagger same-source labels so a
         three-way fan can't stack its labels. */
      /* Long multi-row edges dive through lower rows — pin their label just
         below the source box instead of 35% of the way down. */
      var t = (y2 - y1) > 150 ? 0.14 : 0.35, u = 1 - t;
      var lx = u * u * u * x1 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x2;
      var ly = u * u * u * y1 + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * y2;
      var k = srcCount[e.from] = (srcCount[e.from] || 0) + 1;
      var anchor = x2 > x1 + 4 ? 'start' : (x2 < x1 - 4 ? 'end' : 'start');
      var dx = anchor === 'end' ? -5 : 5;
      s += '<text class="fc-elabel" data-e="' + e.from + '|' + e.to + '" text-anchor="' + anchor +
        '" x="' + (lx + dx) + '" y="' + (ly + 3 + (k - 1) * 11) + '">' + esc(e.label) + '</text>';
    });

    Object.keys(L.box).forEach(function (id) {
      var n = chart.nodes[id], b = L.box[id];
      s += '<g class="fc-node' + endClass(n) + '" data-id="' + id + '">';
      s += '<rect x="' + (b.x - NODE_W / 2) + '" y="' + b.y + '" width="' + NODE_W +
        '" height="' + b.h + '" rx="7"/>';
      b.lines.forEach(function (ln, i) {
        s += '<text x="' + b.x + '" y="' + (b.y + PAD_V + (i + 1) * LINE_H - 4) +
          '" text-anchor="middle">' + esc(ln) + '</text>';
      });
      s += '</g>';
    });

    return s + '</svg>';
  }

  function initFlowchart(el) {
    var chart = CHARTS[el.dataset.chart];
    if (!chart) return;
    var L = layoutChart(chart);

    el.innerHTML = '<div class="fc-svg-wrap">' + buildSvg(chart, L) + '</div>' +
      '<div class="fc-panel"></div>' +
      '<p class="fc-hint">Answer below, or click any highlighted box in the chart to back up to it.</p>';

    var panel = el.querySelector('.fc-panel');
    var path = [chart.start];

    function render() {
      var cur = path[path.length - 1];
      var inPath = {};
      path.forEach(function (id) { inPath[id] = true; });

      el.querySelectorAll('.fc-node').forEach(function (g) {
        var id = g.dataset.id;
        g.classList.toggle('cur', id === cur);
        g.classList.toggle('vis', !!inPath[id] && id !== cur);
        g.classList.toggle('dim', !inPath[id] && id !== cur);
      });
      var taken = {};
      for (var i = 0; i < path.length - 1; i++) taken[path[i] + '|' + path[i + 1]] = true;
      el.querySelectorAll('[data-e]').forEach(function (p) {
        p.classList.toggle('taken', !!taken[p.dataset.e]);
      });

      var n = chart.nodes[cur], h = '';
      if (n.end) {
        h += '<div class="fc-verdict ' + n.end + '">' + esc(n.t) + '</div>';
      } else {
        h += '<div class="fc-q">' + esc(n.q) + '</div>';
      }
      if (n.d) h += '<div class="fc-d">' + n.d + '</div>';
      if (n.ref) {
        h += '<div class="fc-refs">' + n.ref.split('·').map(function (r) {
          return '<span class="fc-ref">§' + esc(r.trim()).replace(/^§/, '') + '</span>';
        }).join('') + '</div>';
      }
      h += '<div class="fc-opts">';
      (n.opts || []).forEach(function (o, i) {
        h += '<button type="button" class="fc-btn" data-i="' + i + '">' + esc(o[0]) + '</button>';
      });
      if (path.length > 1) {
        h += '<button type="button" class="fc-btn ghost" data-act="back">↩ Back</button>';
        h += '<button type="button" class="fc-btn ghost" data-act="reset">Start over</button>';
      }
      panel.innerHTML = h + '</div>';
    }

    panel.addEventListener('click', function (ev) {
      var btn = ev.target.closest('button');
      if (!btn) return;
      if (btn.dataset.act === 'reset') { path = [chart.start]; render(); return; }
      if (btn.dataset.act === 'back') { path.pop(); render(); return; }
      var cur = chart.nodes[path[path.length - 1]];
      var o = (cur.opts || [])[+btn.dataset.i];
      if (!o) return;
      if (o[2]) {
        /* back-edge: rewind to the target (it's always an ancestor) */
        var at = path.indexOf(o[1]);
        path = at >= 0 ? path.slice(0, at + 1) : [chart.start, o[1]];
      } else {
        path.push(o[1]);
      }
      render();
    });

    el.querySelector('.fc-svg-wrap').addEventListener('click', function (ev) {
      var g = ev.target.closest('.fc-node');
      if (!g) return;
      var id = g.dataset.id;
      var at = path.indexOf(id);
      if (at >= 0) { path = path.slice(0, at + 1); render(); return; }
      /* advance if it's a direct option of the current node */
      var cur = chart.nodes[path[path.length - 1]];
      var hit = (cur.opts || []).some(function (o) { return !o[2] && o[1] === id; });
      if (hit) { path.push(id); render(); }
    });

    render();
  }

  document.querySelectorAll('.flowchart').forEach(initFlowchart);
})();
