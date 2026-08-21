/* terps.js — TERPS, Demystified (terps.html)
   Tab plumbing + the Approach Anatomy interactive.

   The interactive is a deliberately simplified single-obstacle model of the
   8260.3G final/intermediate/initial/missed evaluation. Simplifications that
   matter are labelled in the page copy: one obstacle, facility on the field,
   sea-level airport, no precipitous-terrain / RASS / excessive-length
   adjustments. Numbers (ROC, area formulas, visibility tables, GPA/HAT
   ladders) follow the order; paragraph refs in comments. */
(function () {
  'use strict';

  /* ---------------- tabs (deep-linkable: #anatomy, #minimums, …) ---------------- */
  function activateTab(id, push) {
    var btn = document.querySelector('.tab-btn[data-tab="' + id + '"]');
    if (!btn) return;
    document.querySelectorAll('.tab-btn').forEach(function (b) { b.classList.remove('active'); });
    document.querySelectorAll('.tab-panel').forEach(function (p) { p.classList.remove('active'); });
    btn.classList.add('active');
    document.getElementById(id).classList.add('active');
    if (push) history.replaceState(null, '', '#' + id.replace('tab-', ''));
    if (id === 'tab-anatomy') draw();
  }
  document.querySelectorAll('.tab-btn').forEach(function (btn) {
    btn.addEventListener('click', function () { activateTab(btn.dataset.tab, true); });
  });

  /* ---------------- constants ---------------- */
  var FT_NM = 6076.12;

  /* Final-segment geometry per navaid. Half-widths in NM as a function of
     distance d (NM) from the facility/LTP. Facility sits on the airport in
     this model, so d ≈ distance to threshold for all of them.
       VOR w/ PFAF  (5-2):  ½W = 0.05d + 1,     sec Ws = 0.0333d, ROC 250
       NDB w/ PFAF  (7-1):  ½W = 0.08333d+1.25, sec Ws = 0.0666d, ROC 300
       LOC          (8-1):  ½W(ft) = 0.10752(d_ft−200) + 700; 7:1 transitional
                            to 0.15152(d_ft−200)+1000. ROC 250.
       ILS          (10-2): W ½w(ft) = 0.036·d_ft + 392.8 ;
                            X to 0.10752·d_ft + 678.5 (rises 4:1 laterally);
                            Y to 0.15152·d_ft + 969.7 (rises 7:1). Sloping
                            OCS along-track: run:rise = 102/GPA (34:1 at 3°). */
  var NAVAIDS = {
    ils: { label: 'ILS', kind: 'ils', minHat: 200, note: 'sloping OCS, 102/GPA' },
    loc: { label: 'LOC', kind: 'npa', roc: 250, minHat: 250,
      pHW: function (d) { return (0.10752 * Math.max(0, d * FT_NM - 200) + 700) / FT_NM; },
      sW:  function (d) { return (0.04400 * Math.max(0, d * FT_NM - 200) + 300) / FT_NM; } },
    vor: { label: 'VOR/DME', kind: 'npa', roc: 250, minHat: 250,
      pHW: function (d) { return 0.05 * d + 1; },
      sW:  function (d) { return 0.0333 * d; } },
    ndb: { label: 'NDB', kind: 'npa', roc: 300, minHat: 300,
      pHW: function (d) { return 0.08333 * d + 1.25; },
      sW:  function (d) { return 0.0666 * d; } }
  };

  /* Straight-in visibility, statute miles — condensed from tables 3-3-1
     (PA/APV + CAT C/D NPA) and 3-3-3 / 3-3-4 (CAT A / B NPA).
     Columns: [FALS, IALS, BALS, NALS]. */
  var VIS_331 = [ /* [maxHAT, cols] */
    [300,  [0.5, 0.75, 0.75, 0.75]],
    [320,  [0.5, 0.75, 0.75, 0.875]],
    [340,  [0.5, 0.75, 0.875, 1]],
    [360,  [0.625, 0.75, 0.875, 1]],
    [380,  [0.625, 0.75, 1, 1]],
    [400,  [0.625, 0.875, 1, 1.125]],
    [420,  [0.75, 1, 1, 1.125]],
    [460,  [0.875, 1, 1.125, 1.375]],
    [500,  [1, 1.125, 1.25, 1.375]],
    [560,  [1.125, 1.375, 1.375, 1.625]],
    [620,  [1.375, 1.5, 1.625, 1.75]],
    [700,  [1.5, 1.75, 1.875, 2]],
    [800,  [1.75, 2, 2, 2.5]],
    [900,  [2, 2.5, 2.5, 2.5]],
    [1000, [2.5, 2.5, 2.5, 3]],
    [1100, [2.5, 2.5, 3, 3]],
    [1e9,  [3, 3, 3, 3]]
  ];
  function vis331(hat, li) {
    for (var i = 0; i < VIS_331.length; i++) if (hat <= VIS_331[i][0]) return VIS_331[i][1][li];
    return 3;
  }
  function visibility(hat, li, cat, navaid) {
    var isNdb = navaid === 'ndb';
    if (navaid === 'ils') return vis331(hat, li);
    if (cat === 'A') { /* table 3-3-3 */
      if (hat <= 880) return [isNdb ? 0.75 : 0.5, 0.75, 0.75, 1][li];
      return [0.75, 1, 1, 1.25][li];
    }
    if (cat === 'B') { /* table 3-3-4 */
      if (hat <= 740) return [isNdb ? 0.75 : 0.5, 0.75, 0.75, 1][li];
      if (hat <= 950) return [0.75, 1, 1, 1.25][li];
      return [1, 1.25, 1.25, 1.5][li];
    }
    /* CAT C/D: table 3-3-1, gated by table 3-3-5 (an NDB final never keeps ½) */
    var v = vis331(hat, li);
    if (isNdb && v < 0.75) v = 0.75;
    return v;
  }
  function fmtVis(v) {
    var whole = Math.floor(v + 1e-9), frac = v - whole;
    var F = { 0: '', 0.125: '⅛', 0.25: '¼', 0.375: '⅜', 0.5: '½', 0.625: '⅝', 0.75: '¾', 0.875: '⅞' };
    var fs = F[Math.round(frac * 1000) / 1000];
    if (fs === undefined) return v.toFixed(2);
    return (whole || !fs ? whole : '') + fs + ' SM';
  }
  var RVR = { 0.5: 'RVR 2400', 0.625: 'RVR 3000', 0.75: 'RVR 4000', 0.875: 'RVR 4500', 1: 'RVR 5000' };

  /* Minimum HAT vs glidepath angle, per CAT — condensed from table 3-2-2. */
  function minHatIls(gpa, cat) {
    if (gpa <= 3.10) return 200;
    if (gpa <= 3.30) return cat === 'D' ? 250 : 200;
    if (gpa <= 3.50) return cat === 'D' ? 270 : 200;
    if (gpa <= 3.77) return cat === 'D' ? 300 : 200;
    if (gpa <= 3.80) return cat === 'D' ? -1 : 200;
    if (gpa <= 4.20) return cat === 'D' ? -1 : (cat === 'C' ? 250 : 200);
    return cat === 'D' || cat === 'C' ? -1 : 250; /* 4.21–5.00 */
  }
  /* Max GPA / VDA by category — table 2-6-1 (CAT A row for 81–90 kt). */
  var MAX_VDA = { A: 5.70, B: 4.20, C: 3.77, D: 3.50 };

  /* ---------------- state ---------------- */
  var S = {
    navaid: 'ils',
    cat: 'B',
    lights: 0,            /* 0 FALS · 1 IALS · 2 BALS · 3 NALS */
    gpa: 3.0,
    fafD: 5.0,            /* NM to threshold */
    fafAlt: 1800,         /* ft MSL (NPA slider) */
    obs: { d: 2.2, y: 0.45, h: 420 }  /* along-track NM, cross-track NM, ft */
  };
  var TCH = 50, TDZE = 0;

  /* ---------------- model ---------------- */
  function ceilTo(v, step) { return Math.ceil(v / step - 1e-9) * step; }

  /* ILS along-track surface height (ft above TDZE) at distance d NM from LTP. */
  function ilsSurfaceAlong(dNm) {
    var s = 102 / S.gpa;                        /* run per unit rise */
    var d0 = Math.max(200, 1154 - TCH / Math.tan(S.gpa * Math.PI / 180)); /* formula 10-2-2 */
    var x = dNm * FT_NM;
    if (x <= d0) return 0;
    return (x - d0) / s;
  }
  /* Full ILS OCS at (d, |y|): W height, then +4:1 across X, +7:1 across Y.
     Returns {h, zone} or null when outside the Y boundary. */
  function ilsSurfaceAt(dNm, yNm) {
    var x = dNm * FT_NM, ay = Math.abs(yNm) * FT_NM;
    var w = 0.036 * x + 392.8, xb = 0.10752 * x + 678.496, yb = 0.15152 * x + 969.696;
    var base = ilsSurfaceAlong(dNm);
    if (ay <= w) return { h: base, zone: 'W (primary)' };
    if (ay <= xb) return { h: base + (ay - w) / 4, zone: 'X (4:1 side slope)' };
    if (ay <= yb) return { h: base + (xb - w) / 4 + (ay - xb) / 7, zone: 'Y (7:1 side slope)' };
    return null;
  }

  /* NPA ROC applied at (d,|y|) for the current navaid, or null outside area. */
  function npaRocAt(nav, dNm, yNm) {
    var p = nav.pHW(dNm), s = nav.sW(dNm), ay = Math.abs(yNm);
    if (ay <= p) return { roc: nav.roc, zone: 'primary' };
    if (s > 0 && ay <= p + s) {
      var f = 1 - (ay - p) / s;                 /* tapers to 0 at the edge */
      return { roc: nav.roc * f, zone: 'secondary (' + Math.round(f * 100) + '% ROC)' };
    }
    return null;
  }

  function evaluate() {
    var nav = NAVAIDS[S.navaid], o = S.obs, r = {
      verdicts: [], mda: null, hat: null, vis: null, rvr: '',
      obsZone: 'outside the OEA', obsSeg: '', margin: null, vda: null
    };
    var ifD = S.fafD + 10;                       /* intermediate optimum 10 NM (2-5-3) */
    var inFinal = o.d >= 0 && o.d <= S.fafD;
    var inInter = o.d > S.fafD && o.d <= ifD;
    var inInitial = o.d > ifD;
    var onMissed = o.d < 0;

    if (nav.kind === 'ils') {
      var gpaOk = S.gpa <= MAX_VDA[S.cat];
      var mh = minHatIls(S.gpa, S.cat);
      var hat = mh > 0 ? mh : null;
      if (!gpaOk || mh < 0) {
        r.verdicts.push(['warn', 'CAT ' + S.cat + ' not authorized at ' + S.gpa.toFixed(2) +
          '° — table 2-6-1 caps CAT ' + S.cat + ' at ' + MAX_VDA[S.cat].toFixed(2) +
          '°. The plate would carry a “CAT ' + S.cat + ' NA” note.']);
      }
      if (inFinal && hat !== null) {
        var surf = ilsSurfaceAt(o.d, o.y);
        if (!surf) {
          r.obsZone = 'outside the Y boundary — invisible to this procedure';
        } else {
          r.obsZone = surf.zone;
          var pen = o.h - surf.h;
          r.margin = -pen;
          if (pen > 0) {
            /* DA slide-up: ΔDA ≈ pen × 102/57.296 ≈ 1.78 × pen (see page copy) */
            var dDa = pen * 102 / 57.296;
            var floor = Math.max(200, (S.gpa / 3) * 250); /* formula 10-2-17 */
            hat = Math.max(hat, Math.ceil(Math.max(hat + dDa, floor)));
            r.verdicts.push(['warn', 'Obstacle penetrates the ' + surf.zone.split(' ')[0] +
              ' surface by ' + Math.round(pen) + ' ft. Designer’s menu (10-2-3): remove it, ' +
              'steepen the glidepath, displace the threshold — or slide the DA up the glideslope ' +
              '(≈1.78 ft of DA per ft of penetration, and never below the (GPA⁄3)×250 = ' +
              Math.round((S.gpa / 3) * 250) + ' ft floor once adjusted). Shown: the raised DA.']);
          } else {
            r.verdicts.push(['ok', 'OCS clear — the ' + surf.zone + ' sits ' + Math.round(-pen) +
              ' ft above the obstacle at that point. DA stays at the HAT ' + hat + ' ft floor.']);
          }
        }
      }
      if (onMissed && hat !== null) {
        /* CAT I missed, simplified: section 1a flat 1,460 ft, 1b at 28.5:1 (10-3) */
        r.obsZone = 'the missed-approach area';
        var daGnd = (hat + TDZE - TCH) / Math.tan(S.gpa * Math.PI / 180) / FT_NM;
        var m = (daGnd - o.d) * FT_NM;           /* along-track past the DA point */
        if (m > 0) {
          var sh = m <= 1460 ? ilsSurfaceAlong(Math.max(o.d, 0)) :
                   ilsSurfaceAlong(1460 / FT_NM + Math.max(daGnd - 1460 / FT_NM, 0)) + (m - 1460) / 28.5;
          if (o.h > sh) r.verdicts.push(['warn', 'Obstacle penetrates the missed-approach OCS ' +
            '(section 1: 1,460 ft of frozen final surface, then 28.5:1 — para 10-3). ' +
            'Fixes: move the DA point up, or publish a missed climb gradient (>425 ft/NM needs a waiver).']);
          else r.verdicts.push(['ok', 'Missed-approach surface clear over the obstacle.']);
        }
      }
      if (hat !== null) {
        r.hat = hat; r.mda = TDZE + hat;
        r.vis = visibility(hat, S.lights, S.cat, 'ils');
        r.verdicts.push(['info', 'DA ' + r.mda + ' ft (HAT ' + hat + ') — DAs round up in 1-ft steps (3-2-1.a). ' +
          'At 3.00° the OCS below you is 34:1; you get closer to it the closer in you fly.']);
      }
    } else {
      /* NPA: MDA = controlling obstacle + ROC, rounded up to 20 ft (3-2-1.g) */
      var roc = nav.roc, controlling = TDZE + nav.minHat, drove = 'the ' + nav.minHat + '-ft minimum HAT floor';
      if (inFinal) {
        var rr = npaRocAt(nav, o.d, o.y);
        if (rr) {
          r.obsZone = rr.zone;
          var cand = o.h + rr.roc;
          r.margin = null;
          if (cand > controlling) { controlling = cand; drove = 'the obstacle + ' + Math.round(rr.roc) + ' ft ROC'; }
        } else r.obsZone = 'outside the OEA — invisible to this procedure';
      }
      r.mda = ceilTo(controlling, 20);
      r.hat = r.mda - TDZE;
      if (inFinal && r.obsZone !== 'outside the OEA — invisible to this procedure')
        r.verdicts.push(['info', 'MDA ' + r.mda + ' ft = ' + drove + ', rounded up to the next 20 ft. ' +
          'The level ROC band sits on the highest obstacle in the segment — one rock holds the whole MDA.']);

      /* VDA check — 2-6-4 / table 2-6-1 */
      var vda = Math.atan((S.fafAlt - TDZE - TCH) / (S.fafD * FT_NM)) * 180 / Math.PI;
      r.vda = vda;
      if (vda > MAX_VDA[S.cat]) {
        r.verdicts.push(['warn', 'VDA ' + vda.toFixed(2) + '° exceeds CAT ' + S.cat + '’s ' +
          MAX_VDA[S.cat].toFixed(2) + '° maximum (table 2-6-1): straight-in minimums are not ' +
          'authorized — this is how a “VOR-A” circling-only procedure is born (2-6-4.d).']);
      } else if (vda < 2.75) {
        r.verdicts.push(['warn', 'VDA ' + vda.toFixed(2) + '° is below the 2.75° straight-in ' +
          'minimum (2-6-4) — descend sooner or move the FAF.']);
      }
      /* Descent to MDA must be possible: FAF must sit above MDA */
      if (S.fafAlt < r.mda) r.verdicts.push(['warn', 'FAF crossing altitude is below the MDA — ' +
        'the MDA may never sit above the PFAF altitude (3-2-1.g); raise the FAF altitude.']);

      /* Intermediate / initial effects */
      if (inInter) {
        var need = ceilTo(o.h + 500, 100);
        r.obsZone = 'intermediate segment (500 ft ROC)';
        if (need > S.fafAlt) r.verdicts.push(['warn', 'In the intermediate segment this obstacle needs ' +
          need + ' ft (obstacle + 500 ROC, per 2-5-3) — above your FAF crossing altitude. The designer ' +
          'raises the segment altitude, steepening what follows.']);
        else r.verdicts.push(['ok', 'Intermediate segment: obstacle + 500 ft ROC = ' + need +
          ' ft — cleared by the ' + S.fafAlt + ' ft crossing altitude.']);
      }
      if (inInitial) {
        r.obsZone = 'initial segment (1,000 ft ROC)';
        r.verdicts.push(['info', 'Initial segment: this obstacle demands ' + ceilTo(o.h + 1000, 100) +
          ' ft (obstacle + 1,000 ROC, 2-4-3.c) for any route through here.']);
      }
      if (onMissed) {
        /* 40:1 from the MAP at MDA − final ROC (2-8-5) */
        r.obsZone = 'the missed-approach area';
        var start = r.mda - roc, m2 = -o.d * FT_NM;
        var sh2 = start + m2 / 40;
        if (o.h > sh2) {
          var newMda = ceilTo(o.h - m2 / 40 + roc, 20);
          r.verdicts.push(['warn', 'Obstacle penetrates the 40:1 missed-approach surface (it starts at ' +
            'MDA − ' + roc + ' ROC over the MAP, rising 152 ft/NM — 2-8-5). Cheapest fix here: raise the ' +
            'MDA to ' + newMda + ' ft. Real designs may instead turn the missed away or publish “climb to X then turn”.']);
          r.mda = newMda; r.hat = newMda - TDZE;
        } else r.verdicts.push(['ok', '40:1 missed surface clear — ' + Math.round(sh2 - o.h) +
          ' ft above the obstacle. Remember: a standard 200 ft/NM climb keeps only 48 ft/NM over this surface.']);
      }
      r.vis = visibility(r.hat, S.lights, S.cat, S.navaid);
    }

    if (r.vis !== null) r.rvr = RVR[r.vis] || '';
    r.seg = inFinal ? 'final' : inInter ? 'intermediate' : inInitial ? 'initial' : 'missed';
    return r;
  }

  /* ---------------- canvas ---------------- */
  var cv = document.getElementById('anatomy-cv');
  if (!cv) return;
  var ctx = cv.getContext('2d');
  var W = 1000, PLAN_H = 280, PROF_H = 270, H = PLAN_H + PROF_H + 20;
  var DMAX = 18, DMIN = -5;                       /* NM, +right of threshold = final side */
  function dx(d) { return (DMAX - d) / (DMAX - DMIN) * (W - 70) + 60; }
  var planYmid = PLAN_H / 2 + 8, planScale = (PLAN_H - 40) / 9; /* px per NM cross-track (±4.5 NM view) */
  function py(yNm) { return planYmid - yNm * planScale; }
  var profTop = PLAN_H + 30, profH = PROF_H - 46, ALT_MAX = 3400;
  function az(alt) { return profTop + profH - (alt / ALT_MAX) * profH; }

  function sizeCanvas() {
    var dpr = window.devicePixelRatio || 1;
    cv.width = W * dpr; cv.height = H * dpr;
    cv.style.aspectRatio = W + '/' + H;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function draw() {
    sizeCanvas();
    var nav = NAVAIDS[S.navaid], r = evaluate();
    ctx.clearRect(0, 0, W, H);
    ctx.font = '11px "Segoe UI", system-ui, sans-serif';
    var ifD = S.fafD + 10;

    /* ===== PLAN VIEW ===== */
    ctx.save();
    /* area polygons: sample half-width along d */
    function areaPath(hwFn, dFrom, dTo) {
      var pts = [], d;
      for (d = dFrom; d <= dTo + 1e-6; d += (dTo - dFrom) / 40) pts.push([dx(d), hwFn(d)]);
      ctx.beginPath();
      pts.forEach(function (p, i) { i ? ctx.lineTo(p[0], py(p[1])) : ctx.moveTo(p[0], py(p[1])); });
      for (var i = pts.length - 1; i >= 0; i--) ctx.lineTo(pts[i][0], py(-pts[i][1]));
      ctx.closePath();
    }
    var pHW, sOut;
    if (nav.kind === 'ils') {
      pHW = function (d) { return (0.10752 * d * FT_NM + 678.496) / FT_NM; };   /* W+X */
      sOut = function (d) { return (0.15152 * d * FT_NM + 969.696) / FT_NM; };  /* Y edge */
    } else { pHW = nav.pHW; sOut = function (d) { return nav.pHW(d) + nav.sW(d); }; }

    /* secondary then primary, final segment */
    areaPath(sOut, 0.03, S.fafD); ctx.fillStyle = 'rgba(74,158,255,0.10)'; ctx.fill();
    areaPath(pHW, 0.03, S.fafD); ctx.fillStyle = 'rgba(74,158,255,0.22)'; ctx.fill();
    ctx.strokeStyle = 'rgba(74,158,255,0.55)'; ctx.stroke();  /* keeps the feet-scale ILS/LOC area visible */
    if (nav.kind === 'ils') { /* W core */
      areaPath(function (d) { return (0.036 * d * FT_NM + 392.8) / FT_NM; }, 0.03, S.fafD);
      ctx.fillStyle = 'rgba(74,158,255,0.25)'; ctx.fill();
    }
    /* intermediate taper: final width at FAF → 4 NM primary / +2 sec at IF (2-4-3, 2-5-3) */
    function lerpW(d, w0, w1) { return w0 + (w1 - w0) * (d - S.fafD) / (ifD - S.fafD); }
    areaPath(function (d) { return lerpW(d, sOut(S.fafD), 6); }, S.fafD, ifD);
    ctx.fillStyle = 'rgba(150,120,255,0.08)'; ctx.fill();
    areaPath(function (d) { return lerpW(d, pHW(S.fafD), 4); }, S.fafD, ifD);
    ctx.fillStyle = 'rgba(150,120,255,0.16)'; ctx.fill();
    /* initial stub */
    areaPath(function () { return 6; }, ifD, DMAX - 0.2); ctx.fillStyle = 'rgba(120,220,160,0.06)'; ctx.fill();
    areaPath(function () { return 4; }, ifD, DMAX - 0.2); ctx.fillStyle = 'rgba(120,220,160,0.12)'; ctx.fill();
    /* missed splay: final width at MAP → wider going out (2-8-1) */
    areaPath(function (d) { return pHW(0.05) + ( -d) * (6 - pHW(0.05)) / 15; }, DMIN + 0.2, -0.02);
    ctx.fillStyle = 'rgba(240,169,127,0.10)'; ctx.fill();

    /* centerline + runway */
    ctx.strokeStyle = '#3a465a'; ctx.setLineDash([5, 4]);
    ctx.beginPath(); ctx.moveTo(dx(DMAX), planYmid); ctx.lineTo(dx(DMIN), planYmid); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#c8ccd2';
    ctx.fillRect(dx(0), planYmid - 2.5, dx(-0.85) - dx(0), 5);

    /* fixes */
    function fixMark(d, label, col) {
      ctx.strokeStyle = col; ctx.beginPath();
      ctx.moveTo(dx(d), planYmid - 9); ctx.lineTo(dx(d), planYmid + 9); ctx.stroke();
      ctx.fillStyle = col; ctx.textAlign = 'center';
      ctx.fillText(label, dx(d), planYmid + 22);
    }
    fixMark(S.fafD, nav.kind === 'ils' ? 'PFAF / GSI' : 'FAF', '#9ab');
    fixMark(ifD, 'IF', '#9ab');
    ctx.fillStyle = '#788'; ctx.textAlign = 'center';
    ctx.fillText('MAP', dx(0), planYmid - 14);

    /* segment labels */
    ctx.fillStyle = '#7a86a0'; ctx.textAlign = 'center'; ctx.font = '10.5px "Segoe UI", sans-serif';
    ctx.fillText('FINAL', dx(S.fafD / 2), 16);
    ctx.fillText('INTERMEDIATE', dx((S.fafD + ifD) / 2), 16);
    ctx.fillText('← INITIAL', dx(Math.min(ifD + 1.6, DMAX - 1)), 16);
    ctx.fillText('MISSED →', dx(-2.6), 16);
    ctx.font = '11px "Segoe UI", sans-serif';

    /* obstacle (plan) */
    var oc = r.seg === 'final' && r.obsZone.indexOf('outside') < 0 ? '#ff6b6b' :
             r.seg === 'missed' ? '#f0a97f' : r.obsZone.indexOf('outside') >= 0 ? '#667' : '#e8c46b';
    ctx.fillStyle = oc;
    ctx.beginPath(); ctx.arc(dx(S.obs.d), py(S.obs.y), 7, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#111'; ctx.stroke();
    ctx.fillStyle = '#99a'; ctx.textAlign = 'left';
    ctx.fillText('plan view — drag the obstacle', 62, PLAN_H + 2);
    ctx.restore();

    /* ===== PROFILE ===== */
    ctx.save();
    /* ground */
    ctx.strokeStyle = '#334'; ctx.beginPath();
    ctx.moveTo(dx(DMAX), az(0)); ctx.lineTo(dx(DMIN), az(0)); ctx.stroke();
    ctx.fillStyle = '#c8ccd2'; ctx.fillRect(dx(0), az(0) - 2, dx(-0.85) - dx(0), 4);

    /* alt grid */
    ctx.fillStyle = '#556'; ctx.textAlign = 'right';
    [1000, 2000, 3000].forEach(function (a) {
      ctx.strokeStyle = 'rgba(255,255,255,0.05)';
      ctx.beginPath(); ctx.moveTo(dx(DMAX), az(a)); ctx.lineTo(dx(DMIN), az(a)); ctx.stroke();
      ctx.fillText(a + ' ft', 56, az(a) + 3);
    });

    var interAlt = Math.max(S.fafAlt, r.mda || 0);
    var initAlt = Math.min(interAlt + 800, ALT_MAX - 200);

    if (nav.kind === 'ils') {
      /* OCS shading under glidepath */
      ctx.beginPath(); ctx.moveTo(dx(0), az(0));
      for (var d1 = 0; d1 <= S.fafD; d1 += 0.2) ctx.lineTo(dx(d1), az(ilsSurfaceAlong(d1)));
      ctx.lineTo(dx(S.fafD), az(0)); ctx.closePath();
      ctx.fillStyle = 'rgba(74,158,255,0.14)'; ctx.fill();
      /* glidepath */
      var gs = Math.tan(S.gpa * Math.PI / 180);
      ctx.strokeStyle = '#4a9eff'; ctx.lineWidth = 2; ctx.beginPath();
      ctx.moveTo(dx(0), az(TCH));
      ctx.lineTo(dx(S.fafD), az(TCH + S.fafD * FT_NM * gs)); ctx.stroke(); ctx.lineWidth = 1;
      /* DA */
      if (r.hat) {
        var daD = (r.hat - TCH) / gs / FT_NM;
        ctx.strokeStyle = '#7fd8a2'; ctx.setLineDash([4, 3]);
        ctx.beginPath(); ctx.moveTo(dx(daD), az(r.hat)); ctx.lineTo(dx(daD), az(0)); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#7fd8a2'; ctx.textAlign = 'center';
        ctx.fillText('DA ' + (TDZE + r.hat), dx(daD), az(r.hat) - 8);
        /* missed surfaces, simplified: 1,460 ft frozen + 28.5:1 */
        ctx.strokeStyle = '#f0a97f'; ctx.setLineDash([3, 3]); ctx.beginPath();
        var s1 = ilsSurfaceAlong(Math.max(daD - 1460 / FT_NM, 0));
        ctx.moveTo(dx(daD), az(ilsSurfaceAlong(daD)));
        ctx.lineTo(dx(daD - 1460 / FT_NM), az(s1));
        for (var m = 0; m <= (5 + daD) * FT_NM; m += 3000)
          ctx.lineTo(dx(daD - (1460 + m) / FT_NM), az(s1 + m / 28.5));
        ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = '#f0a97f'; ctx.textAlign = 'left';
        ctx.fillText('missed OCS 28.5:1', dx(-1.2), az(s1 + 2.2 * FT_NM / 28.5) - 6);
      }
      ctx.fillStyle = '#4a9eff'; ctx.textAlign = 'center';
      ctx.fillText('OCS = 102/GPA (' + (102 / S.gpa).toFixed(1) + ':1)', dx(S.fafD * 0.62), az(ilsSurfaceAlong(S.fafD * 0.62)) + 16);
    } else {
      /* MDA + ROC band */
      if (r.mda) {
        ctx.fillStyle = 'rgba(255,107,107,0.10)';
        ctx.fillRect(dx(S.fafD), az(r.mda), dx(0) - dx(S.fafD), az(r.mda - nav.roc) - az(r.mda));
        ctx.strokeStyle = '#e8eef6'; ctx.beginPath();
        ctx.moveTo(dx(S.fafD), az(r.mda)); ctx.lineTo(dx(0), az(r.mda)); ctx.stroke();
        ctx.fillStyle = '#e8eef6'; ctx.textAlign = 'left';
        ctx.fillText('MDA ' + r.mda, dx(S.fafD - 0.15), az(r.mda) - 5);
        ctx.fillStyle = '#b98';
        ctx.fillText(nav.roc + ' ft ROC', dx(0.95), az(r.mda - nav.roc / 2) + 4);
      }
      /* VDA dashed */
      ctx.strokeStyle = '#8ec2f2'; ctx.setLineDash([5, 4]); ctx.beginPath();
      ctx.moveTo(dx(0), az(TCH)); ctx.lineTo(dx(S.fafD), az(S.fafAlt)); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = '#8ec2f2'; ctx.textAlign = 'center';
      if (r.vda) ctx.fillText('VDA ' + r.vda.toFixed(2) + '°', dx(S.fafD / 2), az((S.fafAlt + TCH) / 2) - 10);
      /* 40:1 missed */
      if (r.mda) {
        var st = r.mda - nav.roc;
        ctx.strokeStyle = '#f0a97f'; ctx.setLineDash([3, 3]); ctx.beginPath();
        ctx.moveTo(dx(0), az(st));
        ctx.lineTo(dx(DMIN + 0.2), az(st + (-(DMIN + 0.2)) * FT_NM / 40)); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#f0a97f'; ctx.textAlign = 'center';
        ctx.fillText('40:1 missed surface (152 ft/NM)', dx(-2.6), az(st + 2.6 * FT_NM / 40) - 8);
      }
      /* intermediate + initial altitude steps */
      ctx.strokeStyle = '#9c8fd6'; ctx.beginPath();
      ctx.moveTo(dx(S.fafD), az(interAlt)); ctx.lineTo(dx(ifD), az(interAlt)); ctx.stroke();
      ctx.fillStyle = 'rgba(150,120,255,0.08)';
      ctx.fillRect(dx(ifD), az(interAlt), dx(S.fafD) - dx(ifD), az(interAlt - 500) - az(interAlt));
      ctx.fillStyle = '#9c8fd6'; ctx.textAlign = 'center';
      ctx.fillText('FAF ' + S.fafAlt, dx(S.fafD), az(interAlt) - 6);
      ctx.fillStyle = '#8b84b0';
      ctx.fillText('500 ROC', dx((S.fafD + ifD) / 2), az(interAlt - 250) + 4);
      ctx.strokeStyle = '#7dbd93'; ctx.beginPath();
      ctx.moveTo(dx(ifD), az(initAlt)); ctx.lineTo(dx(DMAX - 0.2), az(initAlt)); ctx.stroke();
      ctx.fillStyle = 'rgba(120,220,160,0.07)';
      ctx.fillRect(dx(DMAX - 0.2), az(initAlt), dx(ifD) - dx(DMAX - 0.2), az(initAlt - 1000) - az(initAlt));
      ctx.fillStyle = '#7dbd93'; ctx.textAlign = 'center';
      ctx.fillText('1000 ROC', dx(ifD + 1.6), az(initAlt - 500) + 4);
    }

    /* obstacle (profile) */
    ctx.fillStyle = oc;
    ctx.beginPath();
    ctx.moveTo(dx(S.obs.d) - 6, az(0)); ctx.lineTo(dx(S.obs.d), az(S.obs.h));
    ctx.lineTo(dx(S.obs.d) + 6, az(0)); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#ccd'; ctx.textAlign = 'center';
    ctx.fillText(Math.round(S.obs.h) + ' ft', dx(S.obs.d), az(S.obs.h) - 6);

    ctx.fillStyle = '#99a'; ctx.textAlign = 'left';
    ctx.fillText('profile — drag the obstacle (up/down = height)', 62, H - 4);
    ctx.restore();

    /* ---- readouts ---- */
    function set(id, html) { var el = document.getElementById(id); if (el) el.innerHTML = html; }
    set('ro-min', r.mda !== null
      ? (nav.kind === 'ils' ? 'DA ' : 'MDA ') + r.mda + ' <span class="u">ft (HAT ' + r.hat + ')</span>'
      : '—');
    set('ro-vis', r.vis !== null ? fmtVis(r.vis) + (r.rvr ? ' <span class="u">' + r.rvr + '</span>' : '') : '—');
    set('ro-zone', r.obsZone + ' <span class="u">· ' + r.seg + ' side</span>');
    set('ro-vda', nav.kind === 'ils' ? S.gpa.toFixed(2) + '°' : (r.vda ? r.vda.toFixed(2) + '°' : '—'));
    var vd = document.getElementById('anatomy-verdicts');
    if (vd) vd.innerHTML = r.verdicts.map(function (v) {
      return '<div class="verdict ' + v[0] + '">' + v[1] + '</div>';
    }).join('');
  }

  /* ---------------- interaction ---------------- */
  function evPos(e) {
    var rect = cv.getBoundingClientRect();
    return { x: (e.clientX - rect.left) * W / rect.width, y: (e.clientY - rect.top) * H / rect.height };
  }
  var drag = null;
  cv.addEventListener('pointerdown', function (e) {
    var p = evPos(e);
    var ox = dx(S.obs.d);
    if (p.y < PLAN_H && Math.abs(p.x - ox) < 26 && Math.abs(p.y - py(S.obs.y)) < 26) drag = 'plan';
    else if (p.y >= PLAN_H) drag = 'prof';
    else if (Math.abs(p.x - ox) < 26) drag = 'plan';
    if (drag) { cv.setPointerCapture(e.pointerId); move(e); }
  });
  function move(e) {
    if (!drag) return;
    var p = evPos(e);
    var d = DMAX - (p.x - 60) / (W - 70) * (DMAX - DMIN);
    S.obs.d = Math.max(DMIN + 0.4, Math.min(DMAX - 0.4, d));
    if (drag === 'plan') S.obs.y = Math.max(-4.4, Math.min(4.4, (planYmid - p.y) / planScale));
    else S.obs.h = Math.max(0, Math.min(ALT_MAX - 200, (profTop + profH - p.y) / profH * ALT_MAX));
    var hs = document.getElementById('sl-obsh'); if (hs) hs.value = Math.round(S.obs.h);
    draw();
  }
  cv.addEventListener('pointermove', move);
  cv.addEventListener('pointerup', function () { drag = null; });
  cv.addEventListener('pointercancel', function () { drag = null; });

  /* mode buttons */
  function wireModes(groupId, key, apply) {
    var g = document.getElementById(groupId);
    if (!g) return;
    g.querySelectorAll('.mode-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        g.querySelectorAll('.mode-btn').forEach(function (x) { x.classList.remove('active'); });
        b.classList.add('active');
        apply(b.dataset.v);
        draw();
      });
    });
  }
  wireModes('grp-navaid', 'navaid', function (v) {
    S.navaid = v;
    var isIls = v === 'ils';
    document.getElementById('row-gpa').style.display = isIls ? '' : 'none';
    document.getElementById('row-fafalt').style.display = isIls ? 'none' : '';
  });
  wireModes('grp-cat', 'cat', function (v) { S.cat = v; });
  wireModes('grp-lights', 'lights', function (v) { S.lights = +v; });

  function wireSlider(id, valId, key, fmt) {
    var el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', function () {
      var v = +el.value;
      if (key === 'gpa') S.gpa = v / 100;
      else if (key === 'fafD') S.fafD = v / 10;
      else if (key === 'fafAlt') S.fafAlt = v;
      else if (key === 'obsh') S.obs.h = v;
      document.getElementById(valId).innerHTML = fmt();
      draw();
    });
    document.getElementById(valId).innerHTML = fmt();
  }
  wireSlider('sl-gpa', 'v-gpa', 'gpa', function () { return S.gpa.toFixed(2) + '<span class="u">°</span>'; });
  wireSlider('sl-fafd', 'v-fafd', 'fafD', function () { return S.fafD.toFixed(1) + '<span class="u"> NM</span>'; });
  wireSlider('sl-fafalt', 'v-fafalt', 'fafAlt', function () { return S.fafAlt + '<span class="u"> ft</span>'; });
  wireSlider('sl-obsh', 'v-obsh', 'obsh', function () { return Math.round(S.obs.h) + '<span class="u"> ft</span>'; });

  /* ?nav=ils|loc|vor|ndb &cat=A..D — preselect interactive state (shareable) */
  var q = new URLSearchParams(location.search);
  if (NAVAIDS[q.get('nav')]) {
    var nb = document.querySelector('#grp-navaid [data-v="' + q.get('nav') + '"]');
    if (nb) nb.click();
  }
  if (/^[A-D]$/.test(q.get('cat') || '')) {
    var cb = document.querySelector('#grp-cat [data-v="' + q.get('cat') + '"]');
    if (cb) cb.click();
  }
  window.addEventListener('resize', draw);
  if (location.hash.length > 1) activateTab('tab-' + location.hash.slice(1), false);
  draw();
})();
