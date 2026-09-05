// GPS/NAV/COM Trainer -- navigation data, geometry and the leg model.
// Unofficial training reference tool, not affiliated with or endorsed by Garmin.
//
// Nav data is the repo's FAA CIFP build (data/procedures/) -- the same files
// procedures.html reads. Leg array layout is documented in scripts/build_procedures.py
// and mirrored here; change the three together.
//
//   [fix, lat, lon, pathTerm, turnDir, altDesc, alt1, alt2, speed,
//    course, dist, vertAngle, flags, recNav, theta, rho, center]
//   flags bit0 = first leg of the missed approach, bit1 = flyover
//
// Two facts were checked against every approach in the build and are relied on here:
//   - exactly one leg per final carries bit0, and never the first, so the
//     missed approach starts there and the MAP is the leg before it;
//   - the vertical angle always sits on that MAP leg, so the FAF is MAP - 1.
// If a future AIRAC build breaks either, fafIndex()/mapIndex() fall back rather
// than silently mis-placing the FAF, which is what the ILS capture geometry keys on.

(function (global) {
  'use strict';

  // ---------------------------------------------------------------- geometry
  // Everything is nautical miles and degrees TRUE, matching the rest of the site.

  var R_NM = 3440.065;
  var D2R = Math.PI / 180, R2D = 180 / Math.PI;

  function rad(d) { return d * D2R; }
  function deg(r) { return r * R2D; }
  function norm360(d) { return ((d % 360) + 360) % 360; }
  function norm180(d) { var x = norm360(d); return x > 180 ? x - 360 : x; }

  function dist(a, b) {
    var p1 = rad(a.lat), p2 = rad(b.lat);
    var dp = p2 - p1, dl = rad(b.lon - a.lon);
    var h = Math.sin(dp / 2) * Math.sin(dp / 2) +
            Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
    return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function bearing(a, b) {
    var p1 = rad(a.lat), p2 = rad(b.lat), dl = rad(b.lon - a.lon);
    var y = Math.sin(dl) * Math.cos(p2);
    var x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    return norm360(deg(Math.atan2(y, x)));
  }

  // Point d nm from a on true course crs.
  function project(a, crs, d) {
    var p1 = rad(a.lat), l1 = rad(a.lon), t = rad(crs), ad = d / R_NM;
    var p2 = Math.asin(Math.sin(p1) * Math.cos(ad) + Math.cos(p1) * Math.sin(ad) * Math.cos(t));
    var l2 = l1 + Math.atan2(Math.sin(t) * Math.sin(ad) * Math.cos(p1),
                             Math.cos(ad) - Math.sin(p1) * Math.sin(p2));
    return { lat: deg(p2), lon: norm180(deg(l2)) };
  }

  // Signed cross-track, nm. Positive = right of the course line from a to b.
  function crossTrack(p, a, b) {
    var d13 = dist(a, p) / R_NM;
    var t13 = rad(bearing(a, p)), t12 = rad(bearing(a, b));
    return Math.asin(Math.sin(d13) * Math.sin(t13 - t12)) * R_NM;
  }

  // Distance along the a->b course at which p lies, nm.
  function alongTrack(p, a, b) {
    var d13 = dist(a, p) / R_NM;
    var xt = crossTrack(p, a, b) / R_NM;
    var c = Math.cos(d13) / Math.cos(xt);
    return Math.acos(Math.max(-1, Math.min(1, c))) * R_NM *
           (Math.abs(norm180(bearing(a, p) - bearing(a, b))) > 90 ? -1 : 1);
  }

  // Turn radius, nm, for a standard-rate (3 deg/s) turn at gs knots.
  function turnRadius(gs) { return Math.max(0.15, gs / (3 * 60) / (2 * Math.PI) * 6); }

  // ---------------------------------------------------------------- nav data

  var index = null;              // {effective, cycle, apts:[...]}
  var aptByIdent = Object.create(null);
  var aptCache = Object.create(null);
  var wptDb = Object.create(null); // ident -> {ident,lat,lon,kind}
  var BASE = 'data/procedures/';

  function fetchJson(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error(url + ' ' + r.status);
      return r.json();
    });
  }

  function loadIndex() {
    if (index) return Promise.resolve(index);
    return fetchJson(BASE + 'index.json').then(function (j) {
      index = j;
      j.apts.forEach(function (a) {
        var rec = { ident: a[0], name: a[1], lat: a[2], lon: a[3],
                    nDep: a[4], nStar: a[5], nApp: a[6], city: a[7], st: a[8],
                    kind: 'APT' };
        aptByIdent[a[0]] = rec;
        if (!wptDb[a[0]]) wptDb[a[0]] = rec;
      });
      return j;
    });
  }

  // Every fix an airport's procedures mention becomes searchable once that
  // airport is loaded. The CIFP build carries no standalone enroute-fix table,
  // so the waypoint database is exactly "airports, plus fixes we have seen".
  function harvestWaypoints(apt) {
    (apt.procs || []).forEach(function (p) {
      (p.trans || []).forEach(function (t) {
        (t.legs || []).forEach(function (L) {
          if (L[0] && L[1] != null && !wptDb[L[0]]) {
            wptDb[L[0]] = { ident: L[0], lat: L[1], lon: L[2], kind: 'FIX' };
          }
          var rn = L[13];
          if (rn && rn[0] && !wptDb[rn[0]]) {
            wptDb[rn[0]] = { ident: rn[0], lat: rn[1], lon: rn[2], kind: 'VOR' };
          }
        });
      });
    });
  }

  function loadAirport(id) {
    id = String(id || '').toUpperCase();
    if (aptCache[id]) return Promise.resolve(aptCache[id]);
    return fetchJson(BASE + 'apt/' + id + '.json').then(function (a) {
      aptCache[id] = a;
      harvestWaypoints(a);
      if (!wptDb[a.id]) {
        wptDb[a.id] = { ident: a.id, name: a.name, lat: a.lat, lon: a.lon, kind: 'APT' };
      }
      return a;
    }, function () { aptCache[id] = null; return null; });
  }

  function airportInfo(id) { return aptByIdent[String(id || '').toUpperCase()] || null; }
  function airport(id) { return aptCache[String(id || '').toUpperCase()] || null; }
  function waypoint(id) { return wptDb[String(id || '').toUpperCase()] || null; }

  // Identifier search for the keypad: prefix matches first, then contains.
  function search(q, limit) {
    q = String(q || '').toUpperCase();
    limit = limit || 12;
    if (!q) return [];
    var pre = [], sub = [];
    for (var k in wptDb) {
      if (k.indexOf(q) === 0) pre.push(wptDb[k]);
      else if (pre.length + sub.length < 200 && k.indexOf(q) > 0) sub.push(wptDb[k]);
      if (pre.length >= limit) break;
    }
    pre.sort(function (a, b) { return a.ident.localeCompare(b.ident); });
    sub.sort(function (a, b) { return a.ident.localeCompare(b.ident); });
    return pre.concat(sub).slice(0, limit);
  }

  // ---------------------------------------------------------------- leg model

  var LEG = { FIX: 0, LAT: 1, LON: 2, PT: 3, TURN: 4, ALTDESC: 5, ALT1: 6, ALT2: 7,
              SPD: 8, CRS: 9, DIST: 10, VA: 11, FLAGS: 12, RECNAV: 13,
              THETA: 14, RHO: 15, CENTER: 16 };

  // Terminators that hold rather than proceed.
  var HOLD_PT = { HF: 1, HM: 1, HA: 1 };
  // Terminators with no fix to fly to -- they end on a condition.
  var COND_PT = { CA: 1, VA: 1, VI: 1, VM: 1, FM: 1, VD: 1, VR: 1, CI: 1, CR: 1, CD: 1, FC: 1, FD: 1 };

  function decodeLeg(L, seg) {
    return {
      ident: L[LEG.FIX] || null,
      lat: L[LEG.LAT], lon: L[LEG.LON],
      pt: L[LEG.PT] || 'TF',
      turn: L[LEG.TURN] || null,
      altDesc: L[LEG.ALTDESC] || null,
      alt1: L[LEG.ALT1], alt2: L[LEG.ALT2],
      spd: L[LEG.SPD],
      course: L[LEG.CRS],
      dist: L[LEG.DIST],
      va: L[LEG.VA],
      flags: L[LEG.FLAGS] || 0,
      recNav: L[LEG.RECNAV] || null,
      theta: L[LEG.THETA], rho: L[LEG.RHO],
      center: L[LEG.CENTER] || null,
      seg: seg || 'enroute',
      role: null,
      disco: false
    };
  }

  function isFlyover(leg) { return !!(leg.flags & 2); }
  function isHold(leg) { return !!HOLD_PT[leg.pt]; }
  function isConditional(leg) { return !!COND_PT[leg.pt]; }

  // Index of the first missed-approach leg within a decoded final, or -1.
  function missedIndex(legs) {
    for (var i = 0; i < legs.length; i++) if (legs[i].flags & 1) return i;
    return -1;
  }
  function mapIndex(legs) {
    var m = missedIndex(legs);
    if (m > 0) return m - 1;
    // Fallback: the leg carrying the vertical angle is the MAP in every
    // approach in the build; use it if the missed flag ever goes missing.
    for (var i = legs.length - 1; i >= 0; i--) if (legs[i].va != null) return i;
    return legs.length - 1;
  }
  function fafIndex(legs) {
    var m = mapIndex(legs);
    return m > 0 ? m - 1 : -1;
  }

  // Build the flight-plan legs for one procedure + transition selection.
  // kind: 'APP' | 'SID' | 'STAR'; vtf collapses an approach to its final course.
  function procedureLegs(apt, proc, transName, opts) {
    opts = opts || {};
    var out = [], i;
    var trans = (proc.trans || []).filter(function (t) { return t.k === 'transition'; });
    var final_ = (proc.trans || []).filter(function (t) { return t.k === 'final'; })[0];
    var seg = proc.type === 'APP' ? 'appr' : (proc.type === 'SID' ? 'dep' : 'star');

    function push(raw, s, tName) {
      var leg = decodeLeg(raw, s);
      leg.procId = proc.id;
      leg.procName = proc.name || proc.id;
      leg.transName = tName || null;
      out.push(leg);
    }

    var chosen = trans.filter(function (t) { return t.t === transName; })[0];

    if (proc.type === 'SID') {
      // Runway/common legs come first for a departure, then the transition.
      (proc.trans || []).forEach(function (t) {
        if (t.k === 'runway' || t.k === 'common') {
          t.legs.forEach(function (L) { push(L, seg, t.t); });
        }
      });
      if (chosen) chosen.legs.forEach(function (L) { push(L, seg, chosen.t); });
      return out;
    }

    if (proc.type === 'STAR') {
      if (chosen) chosen.legs.forEach(function (L) { push(L, seg, chosen.t); });
      (proc.trans || []).forEach(function (t) {
        if (t.k === 'runway' || t.k === 'common') {
          t.legs.forEach(function (L) { push(L, seg, t.t); });
        }
      });
      return out;
    }

    // Approach.
    if (!final_) return out;
    var fLegs = final_.legs.map(function (L) { return decodeLeg(L, seg); });
    var mIdx = missedIndex(fLegs), fIdx = fafIndex(fLegs), pIdx = mapIndex(fLegs);

    if (opts.vtf) {
      // Vectors to final: per the guide (v6.00+) every waypoint on the final
      // approach course is kept, including those before the FAF, and the final
      // course to the FAF becomes the active leg. Transitions are dropped.
      for (i = 0; i < fLegs.length; i++) {
        if (i < fIdx) continue;
        push(final_.legs[i], i >= mIdx && mIdx >= 0 ? 'missed' : seg, 'VECTORS');
      }
    } else {
      if (chosen) chosen.legs.forEach(function (L) { push(L, seg, chosen.t); });
      for (i = 0; i < fLegs.length; i++) {
        // The transition normally ends on the same fix the final starts on
        // (an IF); drop the duplicate so the plan reads like the chart.
        if (i === 0 && out.length && out[out.length - 1].ident === fLegs[0].ident) continue;
        push(final_.legs[i], i >= mIdx && mIdx >= 0 ? 'missed' : seg, chosen ? chosen.t : null);
      }
    }

    // Tag the roles the sequencing and CDI logic key on.
    var base = out.length - fLegs.length + (opts.vtf ? Math.max(0, fIdx) : 0);
    out.forEach(function (leg, k) {
      var fi = fLegs.length - (out.length - k);
      if (fi === fIdx) leg.role = 'FAF';
      else if (fi === pIdx) leg.role = 'MAP';
      if (leg.seg === 'missed') leg.role = leg.role || 'missed';
      if (isHold(leg)) leg.role = leg.role || 'hold';
    });
    void base;
    return out;
  }

  // ---------------------------------------------------------------- holds

  // Racetrack geometry for a hold leg. Returns the two turn centres and the
  // outbound/inbound end points, so the sim can fly a real pattern rather than
  // teleporting round the fix.
  function holdGeometry(leg, gs) {
    var fix = { lat: leg.lat, lon: leg.lon };
    var inbound = leg.course != null ? leg.course : 0;
    var right = (leg.turn || 'R') !== 'L';
    var r = turnRadius(gs || 120);
    // Leg length: coded distance, else 1 minute of flight (4 nm at 240 kt cap).
    var legNm = leg.dist != null ? leg.dist : Math.min(4, (gs || 120) / 60);
    var outbound = norm360(inbound + 180);
    var side = right ? 90 : -90;
    var abeam = project(fix, norm360(inbound + 180 + side), 2 * r);
    return {
      fix: fix, inbound: inbound, outbound: outbound, right: right, r: r, legNm: legNm,
      outboundStart: project(fix, norm360(inbound + side), 2 * r),
      outboundEnd: project(abeam, outbound, legNm),
      inboundStart: project(fix, outbound, legNm),
      abeam: abeam
    };
  }

  // A polyline round the racetrack, for drawing.
  function holdPath(leg, gs) {
    var g = holdGeometry(leg, gs), pts = [], i;
    var side = g.right ? 90 : -90;
    var c1 = project(g.fix, norm360(g.inbound + side), g.r);            // turn off the fix
    var c2 = project(g.inboundStart, norm360(g.inbound + side), g.r);   // turn onto inbound
    pts.push(g.fix);
    for (i = 0; i <= 12; i++) {
      var a = norm360(g.inbound - side + (g.right ? 1 : -1) * (180 * i / 12));
      pts.push(project(c1, a, g.r));
    }
    pts.push(g.outboundEnd);
    for (i = 0; i <= 12; i++) {
      var b = norm360(g.outbound - side + (g.right ? 1 : -1) * (180 * i / 12));
      pts.push(project(c2, b, g.r));
    }
    pts.push(g.fix);
    return pts;
  }

  global.NTNav = {
    R_NM: R_NM,
    rad: rad, deg: deg, norm360: norm360, norm180: norm180,
    dist: dist, bearing: bearing, project: project,
    crossTrack: crossTrack, alongTrack: alongTrack, turnRadius: turnRadius,
    loadIndex: loadIndex, loadAirport: loadAirport,
    airport: airport, airportInfo: airportInfo, waypoint: waypoint, search: search,
    cycle: function () { return index ? index.cycle : null; },
    effective: function () { return index ? index.effective : null; },
    allAirports: function () { return index ? index.apts : []; },
    decodeLeg: decodeLeg, procedureLegs: procedureLegs,
    isFlyover: isFlyover, isHold: isHold, isConditional: isConditional,
    missedIndex: missedIndex, mapIndex: mapIndex, fafIndex: fafIndex,
    holdGeometry: holdGeometry, holdPath: holdPath
  };
})(window);
