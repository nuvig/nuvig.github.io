// GPS/NAV/COM Trainer -- device chrome, pages and input.
// Unofficial training reference tool, not affiliated with or endorsed by Garmin.
//
// The bezel carries four controls, as the real unit does: volume/squelch, HOME,
// Direct-To, and the dual concentric knob. Everything else -- Proc, Flight Plan,
// Back, CDI, OBS -- is a touch key on the screen, because that is where they are.
// Adding GNS-style hard keys here would teach the wrong reach.

(function (global) {
  'use strict';

  var N = global.NTNav, C = global.NTCore, SC = global.NTScenarios;

  var FAC = null;                 // data/navtrainer/facilities.json
  var page = 'map', stack = [];
  var ctx = {};                   // per-page scratch (selection, keypad buffer)
  var root, screenEl, mapCv, hsiCv;
  var lastT = 0, raf = null;

  // ---------------------------------------------------------------- utils

  function $(sel, r) { return (r || document).querySelector(sel); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function fmtFreq(f) { return f == null ? '---.--' : Number(f).toFixed(f * 1000 % 10 ? 3 : 2); }
  function fmtDist(d) { return d == null ? '--.-' : (d < 10 ? d.toFixed(1) : Math.round(d) + ''); }
  function fmtCrs(c) { return c == null ? '---' : (Math.round(N.norm360(c)) + '').padStart(3, '0'); }
  function fmtAlt(a) { return a == null ? '' : Math.round(a).toLocaleString(); }

  function go(p, keep) {
    if (!keep && page !== p) stack.push(page);
    page = p;
    C.emit('ui.page', { page: p });
    render();
  }
  function back() {
    page = stack.pop() || 'map';
    C.emit('ui.page', { page: page });
    render();
  }

  // ---------------------------------------------------------------- facilities

  function loadFacilities() {
    return fetch('data/navtrainer/facilities.json')
      .then(function (r) { return r.json(); })
      .then(function (j) { FAC = j; return j; })
      .catch(function () { FAC = { airports: {} }; return FAC; });
  }

  function navFor(aptId, procId) {
    if (!FAC) return null;
    var a = FAC.airports[aptId];
    if (!a) return null;
    var want = (a.proc || {})[procId];
    if (!want) return null;
    return (a.nav || []).filter(function (n) { return n.ident === want; })[0] || null;
  }
  function comsFor(aptId) {
    if (!FAC) return [];
    var a = FAC.airports[aptId];
    return a ? (a.com || []) : [];
  }

  // ---------------------------------------------------------------- chrome

  function bezelHtml() {
    return '' +
      '<div class="unit" id="unit">' +
        '<div class="bezel-l">' +
          '<button class="knob vol" id="k-vol" data-hint="vol" title="Volume / Squelch. Press with the NAV window active to toggle the ident.">' +
            '<span class="knob-face"></span><span class="knob-lbl">VOL<br>SQ</span>' +
          '</button>' +
          '<div class="ann" id="ann-msg"></div>' +
        '</div>' +
        '<div class="screen" id="screen"></div>' +
        '<div class="bezel-r">' +
          '<button class="hardkey" id="k-home" data-hint="home">HOME</button>' +
          '<button class="hardkey" id="k-dto" data-hint="dto"><span class="dto-glyph">D</span></button>' +
          '<div class="knobs" id="knobs">' +
            '<div class="knob-ring large" id="k-large" title="Large knob: MHz / list">' +
              '<div class="knob-ring small" id="k-small" title="Small knob: kHz / cursor. Press to swap COM and NAV. Hold to transfer."></div>' +
            '</div>' +
            '<div class="knob-hint" id="knob-hint"></div>' +
          '</div>' +
        '</div>' +
      '</div>';
  }

  function freqBarHtml() {
    var s = C.state();
    var comTune = s.com.tuning === 'COM', navTune = !comTune;
    var rfl = s.vloc.rflStandby;
    var dec = s.vloc.decoded;
    return '' +
      '<div class="freqbar">' +
        '<div class="fq com' + (comTune ? ' tuning' : '') + '">' +
          '<div class="fq-row"><span class="fq-k">COM</span>' +
            '<button class="fq-act" data-act="com-flip" title="Touch to flip/flop">' +
              fmtFreq(s.com.active) + '</button></div>' +
          '<div class="fq-row sb"><button class="fq-sby" data-act="com-sby">' +
            fmtFreq(s.com.standby) + '</button></div>' +
        '</div>' +
        '<div class="fq nav' + (navTune ? ' tuning' : '') + '">' +
          '<div class="fq-row"><span class="fq-k">NAV</span>' +
            '<button class="fq-act" data-act="nav-flip" title="Touch to flip/flop">' +
              fmtFreq(s.vloc.active) + '</button>' +
            (s.vloc.identOn ? '<span class="idflag" title="Ident audio on">ID</span>' : '') +
          '</div>' +
          '<div class="fq-dec' + (dec ? ' ok' : '') + '" title="' +
            (dec ? 'Morse ident decoded from the received signal -- this is identification.'
                 : 'Nothing being decoded off the active frequency.') + '">' +
            (dec ? morse(dec) : '') + '</div>' +
          '<div class="fq-row sb"><button class="fq-sby" data-act="nav-sby">' +
            fmtFreq(s.vloc.standby) + '</button>' +
            (rfl ? '<span class="rfl" title="Reverse frequency lookup: the database name for this ' +
                   'frequency, from GPS position. Not identification -- nothing is being received.">' +
                   esc(rfl) + '</span>' : '') +
          '</div>' +
        '</div>' +
      '</div>';
  }

  function morse(id) {
    return '<span class="mono">' + esc(id.replace(/^I/, 'I-')) + '</span>';
  }

  // ---------------------------------------------------------------- pages

  var PAGES = {};

  PAGES.home = function () {
    var keys = [
      ['fpl', 'Flight Plan'], ['proc', 'Proc'], ['nearest', 'Nearest'],
      ['map', 'Map'], ['wpt', 'Waypoint Info'], ['system', 'System'],
      ['na-traffic', 'Traffic'], ['na-terrain', 'Terrain'], ['na-weather', 'Weather']
    ];
    return '<div class="pg pg-home"><div class="hgrid">' +
      keys.map(function (k) {
        var off = k[0].indexOf('na-') === 0;
        return '<button class="hkey' + (off ? ' off' : '') + '" data-go="' + k[0] +
               '" data-hint="' + k[0] + '">' + esc(k[1]) + '</button>';
      }).join('') + '</div></div>';
  };

  PAGES.map = function () {
    var s = C.state(), nv = C.nav();
    var src = nv.source;
    var obsLbl = C.obsAvailable() ? (s.seq.obs ? 'OBS' : 'OBS') : 'SUSP';
    var obsOn = s.seq.obs || s.seq.susp;
    return '' +
      '<div class="pg pg-map">' +
        '<canvas id="mapcv"></canvas>' +
        '<div class="map-top">' +
          '<button class="mk" data-act="menu">Menu</button>' +
          '<div class="legband">' + legBandHtml(nv) + '</div>' +
        '</div>' +
        '<div class="annbar">' +
          '<button class="ak cdi' + (src === 'VLOC' ? ' vloc' : '') + '" data-act="cdi" data-hint="cdi">CDI</button>' +
          '<div class="anncenter">' +
            '<span class="src ' + (src === 'VLOC' ? 'vloc' : 'gps') + '">' + src + '</span>' +
            (nv.phase ? '<span class="phase">' + esc(nv.phase) + '</span>' : '') +
            (s.seq.susp ? '<span class="susp">SUSP</span>' : '') +
            (s.seq.obs ? '<span class="susp obs">OBS ' + fmtCrs(s.seq.obsCourse) + '</span>' : '') +
          '</div>' +
          '<button class="ak' + (obsOn ? ' on' : '') + '" data-act="obs" data-hint="obs">' + obsLbl + '</button>' +
        '</div>' +
        cdiStripHtml(nv) +
      '</div>';
  };

  function legBandHtml(nv) {
    if (!nv.leg) return '<span class="dim">No active leg</span>';
    var s = C.state();
    var direct = C.activatedDirect();
    var from = direct ? '' : (nv.index > 0 ? (s.fpl.legs[nv.index - 1].ident || '') : '');
    var vtf = s.fpl.approach && s.fpl.approach.vtf && nv.leg.seg === 'appr';
    return '<span class="lb-from">' + (direct ? 'direct' : esc(from)) + '</span>' +
           '<span class="lb-arrow">&#8594;</span>' +
           '<span class="lb-to">' + esc(nv.leg.ident || nv.leg.pt) + '</span>' +
           (vtf ? '<span class="lb-vtf">vtf</span>' : '') +
           '<span class="lb-num">' + fmtDist(nv.dist) + ' nm</span>' +
           '<span class="lb-num">' + fmtCrs(nv.dtk) + 'T</span>';
  }

  function cdiStripHtml(nv) {
    var d = nv.deflection;
    var pct = 50 + d * 40;
    return '<div class="cdistrip" title="Full scale ' + nv.fullScale.toFixed(1) + ' nm">' +
      '<div class="cdiscale">' +
        [ -2, -1, 0, 1, 2 ].map(function (i) {
          return '<span class="dot" style="left:' + (50 + i * 20) + '%"></span>';
        }).join('') +
        '<span class="needle" style="left:' + pct + '%"></span>' +
      '</div>' +
      '<span class="tf">' + esc(nv.toFrom) + '</span></div>';
  }

  PAGES.fpl = function () {
    var s = C.state();
    if (!s.fpl.legs.length) {
      return wrap('Flight Plan',
        '<div class="empty">Flight plan empty' +
        '<button class="btn" data-act="fpl-add">Add Waypoint</button></div>');
    }
    var rows = s.fpl.legs.map(function (l, i) {
      var act = i === s.fpl.active;
      var cls = 'fr' + (act ? ' active' : '') + (l.seg === 'missed' ? ' missed' : '') +
                (l.seg !== 'enroute' ? ' proc' : '');
      var brg = null, dst = null;
      if (i > 0 && C.legHasFix(l) && C.legHasFix(s.fpl.legs[i - 1])) {
        var a = { lat: s.fpl.legs[i - 1].lat, lon: s.fpl.legs[i - 1].lon };
        var b = { lat: l.lat, lon: l.lon };
        brg = N.bearing(a, b); dst = N.dist(a, b);
      }
      var role = l.role === 'FAF' ? 'FAF' : l.role === 'MAP' ? 'MAP' : '';
      return '<button class="' + cls + '" data-fpl="' + i + '">' +
        '<span class="fr-id">' + esc(l.ident || legLabel(l)) + '</span>' +
        (role ? '<span class="fr-role">' + role + '</span>' : '') +
        '<span class="fr-pt">' + esc(l.pt) + '</span>' +
        '<span class="fr-n">' + (brg == null ? '' : fmtCrs(brg) + 'T') + '</span>' +
        '<span class="fr-n">' + (dst == null ? '' : fmtDist(dst)) + '</span>' +
        '<span class="fr-n">' + (l.alt1 != null ? fmtAlt(l.alt1) : '') + '</span>' +
        '</button>';
    }).join('');
    var hdr = '<div class="fr fr-hdr"><span class="fr-id">Waypoint</span><span class="fr-role"></span>' +
              '<span class="fr-pt">Leg</span><span class="fr-n">DTK</span><span class="fr-n">Dist</span>' +
              '<span class="fr-n">Alt</span></div>';
    var seg = s.fpl.approach
      ? '<div class="segline">Approach: ' + esc(s.fpl.approach.name) +
        (s.fpl.approach.trans ? ' &middot; ' + esc(s.fpl.approach.trans) : '') +
        (s.fpl.approach.active ? '<span class="tag ok">activated</span>'
                               : '<span class="tag warn">loaded, not activated</span>') + '</div>'
      : '';
    return wrap('Active Flight Plan', seg + hdr + '<div class="frows">' + rows + '</div>' +
      '<div class="pgbtns"><button class="btn" data-act="fpl-add">Add Waypoint</button>' +
      '<button class="btn" data-act="fpl-menu">Menu</button></div>');
  };

  function legLabel(l) {
    if (l.pt === 'CA' || l.pt === 'VA') return 'to ' + fmtAlt(l.alt1) + ' ft';
    if (l.pt === 'VI' || l.pt === 'VM') return 'HDG ' + fmtCrs(l.course);
    return l.pt;
  }

  PAGES.proc = function () {
    var s = C.state();
    return wrap('Procedures',
      '<div class="proclist">' +
        procRow('Departure', s.fpl.departure, 'proc-dep') +
        procRow('Arrival', s.fpl.arrival, 'proc-arr') +
        procRow('Approach', s.fpl.approach, 'proc-appr') +
      '</div>' +
      (s.fpl.approach ? '<div class="pgbtns">' +
        (s.fpl.approach.active
          ? '<button class="btn" data-act="appr-vtf">Activate Vectors to Final</button>'
          : '<button class="btn primary" data-act="appr-activate" data-hint="appr-activate">Activate Approach</button>') +
        '</div>' : ''));
  };

  function procRow(label, sel, target) {
    return '<button class="prow" data-go="' + target + '" data-hint="' + target + '">' +
      '<span class="prow-k">' + label + '</span>' +
      '<span class="prow-v' + (sel ? '' : ' dash') + '">' +
        (sel ? esc(sel.name) + (sel.trans ? ' &middot; ' + esc(sel.trans) : '') : '&mdash; &mdash; &mdash;') +
      '</span></button>';
  }

  PAGES['proc-arr'] = function () {
    return wrap('Arrival', notCoded('Arrivals are STARs &mdash; the arrival route into the ' +
      'terminal area. An instrument approach is not here.',
      'The airports in this trainer have no coded STARs.'));
  };
  PAGES['proc-dep'] = function () {
    return wrap('Departure', notCoded('Departures are SIDs.',
      'The airports in this trainer have no coded SIDs.'));
  };
  function notCoded(a, b) {
    return '<div class="empty"><p>' + a + '</p><p class="dim">' + b + '</p>' +
      '<button class="btn" data-go="proc">Back to Procedures</button></div>';
  }

  PAGES['proc-appr'] = function () {
    var apt = ctx.apptApt || (C.state().fpl.legs.length
      ? lastAirportInPlan() : null);
    var a = apt ? N.airport(apt) : null;
    if (!a) {
      return wrap('Approach', '<div class="empty">Loading ' + esc(apt || '') + '&hellip;</div>');
    }
    var apps = (a.procs || []).filter(function (p) { return p.type === 'APP'; });
    var sel = ctx.selAppr ? apps.filter(function (p) { return p.id === ctx.selAppr; })[0] : null;

    var head = '<div class="aptline"><button class="btn sm" data-act="appr-apt">Airport</button>' +
      '<span class="aptid">' + esc(a.id) + '</span><span class="dim">' + esc(a.name) + '</span></div>';

    if (!sel) {
      return wrap('Approach', head + '<div class="alist">' + apps.map(function (p) {
        return '<button class="arow' + (p.co ? ' co' : '') + '" data-appr="' + esc(p.id) + '">' +
          '<span>' + esc(p.name || p.id) + '</span>' +
          (p.co ? '<span class="tag">chart only</span>' : '') + '</button>';
      }).join('') + '</div>');
    }

    var trans = (sel.trans || []).filter(function (t) { return t.k === 'transition'; });
    var nav = navFor(a.id, sel.id);
    var kind = C.approachKind(sel);
    var needsVloc = kind === 'ILS' || kind === 'LOC' || kind === 'LDA' || kind === 'SDF';
    var tsel = ctx.selTrans;

    return wrap('Approach', head +
      '<div class="asel">' +
        '<div class="asel-name">' + esc(sel.name || sel.id) + '</div>' +
        (needsVloc && nav
          ? '<div class="asel-nav">' + esc(nav.ident.replace(/^I/, 'I-')) + '  ' + fmtFreq(nav.freq) +
            (nav.verified === false ? '<span class="tag warn" title="Placeholder in data/navtrainer/facilities.json">unverified</span>' : '') +
            '</div>'
          : '') +
        '<div class="tlabel">Transition</div>' +
        '<div class="tlist">' +
          trans.map(function (t) {
            return '<button class="trow' + (tsel === t.t ? ' on' : '') + '" data-trans="' + esc(t.t) + '">' +
              esc(t.t) + '</button>';
          }).join('') +
          '<button class="trow' + (tsel === 'VECTORS' ? ' on' : '') + '" data-trans="VECTORS">VECTORS</button>' +
        '</div>' +
      '</div>' +
      '<div class="pgbtns">' +
        '<button class="btn" data-act="appr-clear">Back</button>' +
        '<button class="btn" data-act="appr-load" data-hint="appr-load">Load Approach</button>' +
        '<button class="btn primary" data-act="appr-loadact" data-hint="appr-activate">Load APPR &amp; Activate</button>' +
      '</div>');
  };

  function lastAirportInPlan() {
    var legs = C.state().fpl.legs;
    for (var i = legs.length - 1; i >= 0; i--) {
      if (legs[i].ident && N.airportInfo(legs[i].ident)) return legs[i].ident;
    }
    return null;
  }

  PAGES.dto = function () {
    var buf = ctx.dtoBuf || '';
    var hits = N.search(buf, 8);
    var s = C.state();
    var tab = ctx.dtoTab || 'wpt';
    var body;
    if (tab === 'fpl') {
      body = '<div class="alist">' + s.fpl.legs.map(function (l, i) {
        return C.legHasFix(l) ? '<button class="arow" data-dtofpl="' + i + '">' +
          esc(l.ident || legLabel(l)) + '</button>' : '';
      }).join('') + '</div>';
    } else {
      body = '<div class="dtoentry"><span class="dtobuf">' + esc(buf || '_____') + '</span></div>' +
        '<div class="alist">' + hits.map(function (w) {
          return '<button class="arow" data-dtow="' + esc(w.ident) + '">' +
            '<span>' + esc(w.ident) + '</span><span class="dim">' + esc(w.name || w.kind) + '</span></button>';
        }).join('') + '</div>' + keypadHtml('alpha');
    }
    return wrap('Direct To',
      '<div class="tabs">' +
        '<button class="tab' + (tab === 'wpt' ? ' on' : '') + '" data-dtotab="wpt">Waypoint</button>' +
        '<button class="tab' + (tab === 'fpl' ? ' on' : '') + '" data-dtotab="fpl">FPL</button>' +
        '<button class="tab' + (tab === 'nrst' ? ' on' : '') + '" data-dtotab="nrst">Nearest</button>' +
      '</div>' + body);
  };

  PAGES.nearest = function () {
    var s = C.state(), p = { lat: s.ac.lat, lon: s.ac.lon };
    var list = N.allAirports().map(function (a) {
      return { id: a[0], name: a[1], d: N.dist(p, { lat: a[2], lon: a[3] }),
               b: N.bearing(p, { lat: a[2], lon: a[3] }) };
    }).sort(function (x, y) { return x.d - y.d; }).slice(0, 10);
    return wrap('Nearest Airport', '<div class="alist">' + list.map(function (a) {
      return '<button class="arow" data-dtow="' + esc(a.id) + '">' +
        '<span>' + esc(a.id) + '</span><span class="dim">' + esc(a.name) + '</span>' +
        '<span class="nr">' + fmtCrs(a.b) + 'T</span><span class="nr">' + fmtDist(a.d) + ' nm</span>' +
        '</button>';
    }).join('') + '</div>');
  };

  PAGES.wpt = function () {
    var id = ctx.wptId || lastAirportInPlan();
    var info = id ? N.airportInfo(id) : null;
    var a = id ? N.airport(id) : null;
    if (!info) return wrap('Waypoint Info', '<div class="empty">No waypoint selected.</div>');
    var s = C.state(), p = { lat: s.ac.lat, lon: s.ac.lon };
    var coms = comsFor(id);
    return wrap('Waypoint Info',
      '<div class="wpt"><div class="wpt-id">' + esc(info.ident) + '</div>' +
      '<div class="dim">' + esc(info.name) + ' &middot; ' + esc(info.city || '') + ' ' + esc(info.st || '') + '</div>' +
      '<div class="kv"><span>Bearing</span><b>' + fmtCrs(N.bearing(p, info)) + 'T</b></div>' +
      '<div class="kv"><span>Distance</span><b>' + fmtDist(N.dist(p, info)) + ' nm</b></div>' +
      (a ? '<div class="kv"><span>Elevation</span><b>' + fmtAlt(a.elev) + ' ft</b></div>' : '') +
      (a ? '<div class="kv"><span>Runways</span><b>' + (a.rw || []).map(function (r) {
        return r[0].replace('RW', '');
      }).join(', ') + '</b></div>' : '') +
      (coms.length ? '<div class="tlabel">Frequencies</div>' + coms.map(function (c) {
        return '<button class="arow" data-com="' + c.freq + '"><span>' + esc(c.label) + '</span>' +
          '<span class="nr">' + fmtFreq(c.freq) + '</span>' +
          (c.verified === false ? '<span class="tag warn">unverified</span>' : '') + '</button>';
      }).join('') : '') +
      '</div>');
  };

  PAGES.system = function () {
    var s = C.state();
    return wrap('System', '<div class="proclist">' +
      '<button class="prow" data-act="cdicap"><span class="prow-k">ILS CDI Capture</span>' +
      '<span class="prow-v">' + s.cdi.ilsCapture + '</span></button>' +
      '<div class="note">Auto: the CDI takes VLOC on its own within 1.2 nm of the final ' +
      'approach course and 2.0&ndash;15.0 nm from the FAF. Inside 2 nm there is no automatic ' +
      'switch. Manual: you decide, every time.</div>' +
      '</div>');
  };

  PAGES.tune = function () {
    var s = C.state();
    var which = ctx.tuneWhich || 'COM';
    var buf = ctx.tuneBuf || '';
    return wrap(which === 'COM' ? 'COM Standby' : 'NAV Standby',
      '<div class="dtoentry"><span class="dtobuf">' + esc(buf || '---.--') + '</span></div>' +
      keypadHtml('num') +
      '<div class="pgbtns">' +
        '<button class="btn" data-act="tune-enter">Enter</button>' +
        '<button class="btn" data-act="tune-xfer">XFER</button>' +
      '</div>' +
      (which === 'NAV'
        ? '<div class="note">Enter puts it in standby. XFER puts it straight into the active ' +
          'window. Neither identifies it.</div>' : ''));
  };

  function keypadHtml(kind) {
    var keys = kind === 'num'
      ? ['1','2','3','4','5','6','7','8','9','.','0','BKSP']
      : 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('').concat(['BKSP']);
    return '<div class="kp ' + kind + '">' + keys.map(function (k) {
      return '<button class="kpk' + (k === 'BKSP' ? ' bk' : '') + '" data-key="' + esc(k) + '">' +
        (k === 'BKSP' ? '&#9003;' : esc(k)) + '</button>';
    }).join('') + '</div>';
  }

  function wrap(title, body) {
    return '<div class="pg">' +
      '<div class="pghdr"><button class="backk" data-act="back">&#8592;</button>' +
      '<span class="pgtitle">' + esc(title) + '</span></div>' +
      '<div class="pgbody">' + body + '</div></div>';
  }

  // ---------------------------------------------------------------- render

  function render() {
    if (!screenEl) return;
    var fn = PAGES[page] || PAGES.map;
    screenEl.innerHTML = freqBarHtml() + fn();
    if (page === 'map') {
      mapCv = $('#mapcv', screenEl);
      drawMap();
    }
    renderSide();
    applyHints();
  }

  function renderLight() {
    // Cheap per-tick refresh: only the bits that change while flying.
    if (page === 'map') {
      var nv = C.nav();
      var band = $('.legband', screenEl);
      if (band) band.innerHTML = legBandHtml(nv);
      var strip = $('.cdistrip', screenEl);
      if (strip) strip.outerHTML = cdiStripHtml(nv);
      var ann = $('.anncenter', screenEl);
      if (ann) {
        var s = C.state();
        ann.innerHTML = '<span class="src ' + (nv.source === 'VLOC' ? 'vloc' : 'gps') + '">' +
          nv.source + '</span>' + (nv.phase ? '<span class="phase">' + esc(nv.phase) + '</span>' : '') +
          (s.seq.susp ? '<span class="susp">SUSP</span>' : '') +
          (s.seq.obs ? '<span class="susp obs">OBS ' + fmtCrs(s.seq.obsCourse) + '</span>' : '');
      }
      var cdik = $('.ak.cdi', screenEl);
      if (cdik) cdik.className = 'ak cdi' + (nv.source === 'VLOC' ? ' vloc' : '');
      drawMap();
    } else if (page === 'fpl') {
      render();
    }
    var fb = $('.freqbar', screenEl);
    if (fb) fb.outerHTML = freqBarHtml();
    renderSide();
  }

  // ---------------------------------------------------------------- map

  function drawMap() {
    if (!mapCv) return;
    var dpr = Math.min(2, global.devicePixelRatio || 1);
    var w = mapCv.clientWidth, h = mapCv.clientHeight;
    if (!w || !h) return;
    if (mapCv.width !== w * dpr) { mapCv.width = w * dpr; mapCv.height = h * dpr; }
    var g = mapCv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    var s = C.state(), ac = s.ac;
    var range = ctx.range || 20;                     // nm top-of-screen
    var cx = w / 2, cy = h * 0.68;
    var ppn = (h * 0.62) / range;                    // px per nm
    var trk = ac.trk;

    function xy(p) {
      var d = N.dist({ lat: ac.lat, lon: ac.lon }, p);
      var b = N.bearing({ lat: ac.lat, lon: ac.lon }, p);
      var a = N.rad(b - trk);
      return [cx + Math.sin(a) * d * ppn, cy - Math.cos(a) * d * ppn];
    }

    // Range ring.
    g.strokeStyle = 'rgba(150,170,190,.22)'; g.lineWidth = 1;
    g.beginPath(); g.arc(cx, cy, (range / 2) * ppn, 0, Math.PI * 2); g.stroke();
    g.fillStyle = 'rgba(170,190,210,.55)'; g.font = '10px system-ui,sans-serif';
    g.fillText((range / 2) + ' nm', cx + 4, cy - (range / 2) * ppn - 4);

    // Flight plan.
    var labels = [];
    var legs = s.fpl.legs;
    for (var i = 0; i < legs.length; i++) {
      var l = legs[i];
      if (!C.legHasFix(l)) continue;
      var prev = null;
      for (var j = i - 1; j >= 0; j--) if (C.legHasFix(legs[j])) { prev = legs[j]; break; }
      var from = prev ? { lat: prev.lat, lon: prev.lon }
                      : (i === s.fpl.active ? { lat: ac.lat, lon: ac.lon } : null);
      var isActive = i === s.fpl.active;
      if (from) {
        var p1 = xy(from), p2 = xy({ lat: l.lat, lon: l.lon });
        g.beginPath(); g.moveTo(p1[0], p1[1]); g.lineTo(p2[0], p2[1]);
        g.strokeStyle = isActive ? '#e879f9' : (l.seg === 'missed' ? 'rgba(255,255,255,.35)' : 'rgba(255,255,255,.6)');
        g.lineWidth = isActive ? 3 : 1.6;
        if (l.seg === 'missed') g.setLineDash([5, 4]); else g.setLineDash([]);
        g.stroke(); g.setLineDash([]);
      }
      if (N.isHold(l)) {
        var path = N.holdPath(l, ac.gs);
        g.beginPath();
        path.forEach(function (pt, k) {
          var q = xy(pt);
          if (k === 0) g.moveTo(q[0], q[1]); else g.lineTo(q[0], q[1]);
        });
        g.strokeStyle = isActive ? '#e879f9' : 'rgba(255,255,255,.5)';
        g.lineWidth = isActive ? 2.4 : 1.4;
        g.stroke();
      }
      var q2 = xy({ lat: l.lat, lon: l.lon });
      g.fillStyle = isActive ? '#e879f9' : '#cfe0f0';
      g.beginPath(); g.arc(q2[0], q2[1], 3.4, 0, Math.PI * 2); g.fill();
      if (l.ident) placeLabel(g, l.ident, q2[0] + 6, q2[1] - 5, isActive, labels);
    }

    // Aircraft.
    g.save(); g.translate(cx, cy);
    g.fillStyle = '#fff';
    g.beginPath(); g.moveTo(0, -9); g.lineTo(6, 8); g.lineTo(0, 4); g.lineTo(-6, 8); g.closePath();
    g.fill(); g.restore();

    // Track-up label, kept clear of the leg band across the top.
    g.fillStyle = 'rgba(180,200,220,.7)'; g.font = '10px system-ui,sans-serif';
    g.fillText(fmtCrs(trk) + 'T', 6, h - 32);
  }

  // Waypoint labels crowd badly on an approach, where the fixes are a mile apart.
  // The active leg always gets its name; anything that would sit on top of an
  // already-drawn label is dropped rather than overprinted into mush.
  function placeLabel(g, text, x, y, force, drawn) {
    g.font = '10px system-ui,sans-serif';
    var w = g.measureText(text).width, box = [x, y - 9, x + w, y + 2];
    if (!force) {
      for (var i = 0; i < drawn.length; i++) {
        var b = drawn[i];
        if (box[0] < b[2] + 3 && box[2] > b[0] - 3 && box[1] < b[3] + 2 && box[3] > b[1] - 2) return;
      }
    }
    drawn.push(box);
    g.fillStyle = force ? '#f5d0fe' : 'rgba(220,235,250,.85)';
    g.fillText(text, x, y);
  }

  // ---------------------------------------------------------------- HSI

  function drawHsi() {
    if (!hsiCv) return;
    var dpr = Math.min(2, global.devicePixelRatio || 1);
    var w = hsiCv.clientWidth, h = hsiCv.clientHeight;
    if (!w || !h) return;
    if (hsiCv.width !== w * dpr) { hsiCv.width = w * dpr; hsiCv.height = h * dpr; }
    var g = hsiCv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    var nv = C.nav(), s = C.state();
    var cx = w / 2, cy = h / 2, r = Math.min(w, h) / 2 - 14;
    var hdg = s.ac.trk;

    g.save(); g.translate(cx, cy);
    // Compass card.
    g.strokeStyle = 'rgba(160,180,200,.35)'; g.lineWidth = 1;
    g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2); g.stroke();
    g.save(); g.rotate(N.rad(-hdg));
    for (var d = 0; d < 360; d += 10) {
      var a = N.rad(d), big = d % 30 === 0;
      g.beginPath();
      g.moveTo(Math.sin(a) * r, -Math.cos(a) * r);
      g.lineTo(Math.sin(a) * (r - (big ? 9 : 5)), -Math.cos(a) * (r - (big ? 9 : 5)));
      g.strokeStyle = 'rgba(200,215,230,.6)'; g.stroke();
      if (big) {
        g.save();
        g.translate(Math.sin(a) * (r - 20), -Math.cos(a) * (r - 20));
        g.rotate(a);
        g.fillStyle = 'rgba(215,230,245,.85)'; g.font = '10px system-ui,sans-serif';
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(d === 0 ? 'N' : d === 90 ? 'E' : d === 180 ? 'S' : d === 270 ? 'W' : (d / 10), 0, 0);
        g.restore();
      }
    }
    // Course pointer + deviation bar, rotated to the selected course.
    var crs = nv.obs && nv.obsCourse != null ? nv.obsCourse : nv.dtk;
    if (crs != null) {
      g.save(); g.rotate(N.rad(crs));
      var col = nv.source === 'VLOC' ? '#4ade80' : '#e879f9';
      g.strokeStyle = col; g.lineWidth = 3; g.lineCap = 'round';
      g.beginPath(); g.moveTo(0, -r + 8); g.lineTo(0, -r * 0.45); g.stroke();
      g.beginPath(); g.moveTo(0, r * 0.45); g.lineTo(0, r - 8); g.stroke();
      g.beginPath(); g.moveTo(0, -r + 8); g.lineTo(-6, -r + 20); g.lineTo(6, -r + 20); g.closePath();
      g.fillStyle = col; g.fill();
      // Deviation.
      var dev = Math.max(-1, Math.min(1, nv.deflection));
      g.strokeStyle = col; g.lineWidth = 3;
      g.beginPath(); g.moveTo(dev * r * 0.5, -r * 0.42); g.lineTo(dev * r * 0.5, r * 0.42); g.stroke();
      g.fillStyle = 'rgba(200,215,230,.5)';
      for (var k = -2; k <= 2; k++) {
        if (!k) continue;
        g.beginPath(); g.arc(k * r * 0.25, 0, 2.5, 0, Math.PI * 2); g.fill();
      }
      // TO/FROM triangle.
      g.fillStyle = col;
      g.beginPath();
      var ty = nv.toFrom === 'TO' ? -r * 0.28 : r * 0.28;
      var dir = nv.toFrom === 'TO' ? -1 : 1;
      g.moveTo(0, ty + dir * 9); g.lineTo(-6, ty); g.lineTo(6, ty); g.closePath(); g.fill();
      g.restore();
    }
    g.restore();

    // Lubber line + heading box.
    g.fillStyle = '#fff';
    g.beginPath(); g.moveTo(cx, cy - r - 2); g.lineTo(cx - 5, cy - r - 11);
    g.lineTo(cx + 5, cy - r - 11); g.closePath(); g.fill();
    g.font = '600 12px system-ui,sans-serif'; g.textAlign = 'center';
    g.fillStyle = '#cfe0f0';
    g.fillText(fmtCrs(hdg) + 'T', cx, cy + r + 16);
  }

  // ---------------------------------------------------------------- side panel

  function renderSide() {
    var nv = C.nav(), s = C.state();
    var seq = $('#seqpanel');
    if (seq) {
      var leg = nv.leg;
      var nxt = nv.next;
      seq.innerHTML =
        '<div class="sq-row"><span>Active leg</span><b>' +
          (leg ? (C.activatedDirect() ? 'direct &#8594; '
                   : (nv.index > 0 ? esc(s.fpl.legs[nv.index - 1].ident || '') + ' &#8594; ' : '')) +
                 esc(leg.ident || legLabel(leg)) : '&mdash;') + '</b></div>' +
        '<div class="sq-row"><span>Leg type</span><b>' + (leg ? esc(leg.pt) +
          (N.isFlyover(leg) ? ' (flyover)' : leg.pt === 'TF' || leg.pt === 'CF' ? ' (fly-by)' : '') : '&mdash;') + '</b></div>' +
        '<div class="sq-row"><span>Next leg</span><b>' +
          (nxt ? esc(nxt.ident || legLabel(nxt)) : '&mdash;') + '</b></div>' +
        '<div class="sq-row"><span>Sequencing</span><b class="' +
          (s.seq.susp ? 'warn' : s.seq.obs ? 'warn' : 'ok') + '">' +
          (s.seq.susp ? 'SUSPENDED' : s.seq.obs ? 'OBS -- manual' : 'automatic') + '</b></div>' +
        '<div class="sq-why">' + esc(nv.note || '') + '</div>' +
        '<div class="sq-row"><span>CDI source</span><b class="' +
          (nv.source === 'VLOC' ? 'ok' : '') + '">' + nv.source + '</b></div>' +
        '<div class="sq-row"><span>Identified</span><b class="' +
          (C.navIdentified() ? 'ok' : 'warn') + '">' +
          (C.navIdentified() ? 'yes -- ' + esc(s.vloc.decoded) : 'no') + '</b></div>';
    }
    drawHsi();
    renderScenario();
  }

  function renderScenario() {
    var box = $('#scenbox');
    if (!box) return;
    SC.update();
    var p = SC.progress();
    if (!p) {
      box.innerHTML = '<div class="dim">Free play &mdash; no scenario. Pick one above to be given a task.</div>';
      return;
    }
    var goals = p.goals.map(function (g) {
      return '<li class="' + (g.done ? 'done' : '') + '">' + (g.done ? '&#10003; ' : '') + esc(g.label) + '</li>';
    }).join('');
    var hint = ctx.hintOn && p.next
      ? '<div class="hint"><b>Next</b> ' + esc(p.next.text) + '</div>' : '';
    var hits = p.hits.length
      ? '<div class="misses"><div class="mh">Noticed</div>' + p.hits.map(function (m) {
          return '<div class="miss"><b>' + esc(m.label) + '</b><span>' + esc(m.note) + '</span></div>';
        }).join('') + '</div>'
      : '';
    box.innerHTML =
      '<div class="sc-brief">' + esc(p.scenario.brief) + '</div>' +
      (p.complete ? '<div class="sc-done">Scenario complete</div>' : '') +
      '<ul class="goals">' + goals + '</ul>' + hint + hits;
  }

  function applyHints() {
    if (!ctx.hintOn) {
      Array.prototype.forEach.call(document.querySelectorAll('.hint-on'), function (e) {
        e.classList.remove('hint-on');
      });
      return;
    }
    var p = SC.progress();
    var key = p && p.next ? p.next.key : null;
    Array.prototype.forEach.call(document.querySelectorAll('[data-hint]'), function (e) {
      e.classList.toggle('hint-on', !!key && e.getAttribute('data-hint') === key);
    });
  }

  // ---------------------------------------------------------------- actions

  var ACT = {
    back: back,
    menu: function () { C.message('Menu is not built in this prototype.'); render(); },

    cdi: function () { C.pressCdi(); render(); },
    obs: function () {
      var r = C.pressObsSusp();
      if (r === 'obs-on') {
        var c = prompt('OBS course (degrees true)', fmtCrs(C.state().seq.obsCourse));
        if (c != null && c !== '') C.setObsCourse(parseFloat(c));
      }
      render();
    },

    'com-flip': function () { C.flipFlop('COM'); render(); },
    'nav-flip': function () { C.flipFlop('NAV'); render(); },
    'com-sby': function () {
      ctx.tuneWhich = 'COM'; ctx.tuneBuf = ''; C.state().com.tuning = 'COM'; go('tune');
    },
    'nav-sby': function () {
      // Opening the Nav standby keypad makes the Nav window the one being tuned,
      // which is also what puts the Volume knob's ident toggle on the Nav receiver.
      ctx.tuneWhich = 'NAV'; ctx.tuneBuf = ''; C.state().com.tuning = 'NAV'; go('tune');
    },
    'tune-enter': function () {
      var f = parseFloat(ctx.tuneBuf);
      if (!isNaN(f)) C.tuneStandby(ctx.tuneWhich, f);
      back();
    },
    'tune-xfer': function () {
      var f = parseFloat(ctx.tuneBuf);
      if (!isNaN(f)) { C.tuneStandby(ctx.tuneWhich, f); C.flipFlop(ctx.tuneWhich); }
      back();
    },

    'fpl-add': function () { ctx.dtoTab = 'wpt'; ctx.dtoBuf = ''; ctx.addMode = true; go('dto'); },
    'fpl-menu': function () {
      if (confirm('Delete the flight plan?')) { C.clearFlightPlan(); render(); }
    },

    'appr-apt': function () {
      var id = prompt('Airport identifier', ctx.apptApt || lastAirportInPlan() || '');
      if (!id) return;
      id = id.toUpperCase();
      N.loadAirport(id).then(function (a) {
        if (!a) { alert('No coded procedures for ' + id); return; }
        ctx.apptApt = id; ctx.selAppr = null; ctx.selTrans = null; render();
      });
    },
    'appr-clear': function () { ctx.selAppr = null; ctx.selTrans = null; render(); },
    'appr-load': function () { doLoadApproach(false); },
    'appr-loadact': function () { doLoadApproach(true); },
    'appr-activate': function () { C.activateApproach(); go('fpl'); },
    'appr-vtf': function () {
      var s = C.state();
      if (!s.fpl.approach) return;
      var a = N.airport(s.fpl.approach.aptId);
      var proc = (a.procs || []).filter(function (p) { return p.id === s.fpl.approach.procId; })[0];
      C.loadProcedure(a, proc, null, { vtf: true });
      attachApproachNav(a, proc);
      C.activateApproach();
      go('fpl');
    },

    cdicap: function () {
      var s = C.state();
      s.cdi.ilsCapture = s.cdi.ilsCapture === 'AUTO' ? 'MANUAL' : 'AUTO';
      C.emit('cdi.capture', { mode: s.cdi.ilsCapture });
      render();
    }
  };

  function attachApproachNav(apt, proc) {
    var s = C.state();
    if (!s.fpl.approach) return;
    var nav = navFor(apt.id, proc.id);
    if (nav) {
      s.fpl.approach.freq = nav.freq;
      s.fpl.approach.ident = nav.ident;
      s.fpl.approach.navVerified = nav.verified !== false;
    } else {
      s.fpl.approach.freq = null;
    }
    C.updateNavDecode();
  }

  function doLoadApproach(activate) {
    var apt = N.airport(ctx.apptApt || lastAirportInPlan());
    if (!apt || !ctx.selAppr) return;
    var proc = (apt.procs || []).filter(function (p) { return p.id === ctx.selAppr; })[0];
    if (!proc) return;
    var vtf = ctx.selTrans === 'VECTORS';
    var ok = C.loadProcedure(apt, proc, vtf ? null : ctx.selTrans, { vtf: vtf });
    if (!ok) { alert('This approach has no public coding -- chart only.'); return; }
    attachApproachNav(apt, proc);
    if (activate) C.activateApproach();
    go('fpl');
  }

  // ---------------------------------------------------------------- input

  function onClick(e) {
    var t = e.target.closest('[data-act],[data-go],[data-fpl],[data-appr],[data-trans],' +
      '[data-dtow],[data-dtofpl],[data-dtotab],[data-key],[data-com]');
    if (!t) return;
    var a;

    if ((a = t.getAttribute('data-act')) && ACT[a]) { ACT[a](); return; }
    if ((a = t.getAttribute('data-go'))) {
      if (a.indexOf('na-') === 0) { C.message('Not built in this prototype.'); render(); return; }
      if (a === 'proc-appr') {
        var id = ctx.apptApt || lastAirportInPlan();
        ctx.apptApt = id; ctx.selAppr = null; ctx.selTrans = null;
        go('proc-appr');
        if (id && !N.airport(id)) N.loadAirport(id).then(render);
        return;
      }
      go(a); return;
    }
    if ((a = t.getAttribute('data-fpl')) != null) {
      var i = +a;
      if (confirm('Activate the leg to ' + (C.state().fpl.legs[i].ident || 'this fix') + '?')) {
        C.activateLeg(i);
      }
      render(); return;
    }
    if ((a = t.getAttribute('data-appr'))) { ctx.selAppr = a; ctx.selTrans = null; render(); return; }
    if ((a = t.getAttribute('data-trans'))) { ctx.selTrans = a; render(); return; }
    if ((a = t.getAttribute('data-dtotab'))) { ctx.dtoTab = a; render(); return; }
    if ((a = t.getAttribute('data-dtow'))) {
      if (ctx.addMode) { ctx.addMode = false; C.appendWaypoint(a); go('fpl'); }
      else { C.directTo(a); go('map'); }
      return;
    }
    if ((a = t.getAttribute('data-dtofpl')) != null) {
      var leg = C.state().fpl.legs[+a];
      if (leg) C.directTo(leg.ident);
      go('map'); return;
    }
    if ((a = t.getAttribute('data-com'))) { C.tuneStandby('COM', parseFloat(a)); render(); return; }
    if ((a = t.getAttribute('data-key'))) { onKeypad(a); return; }
  }

  function onKeypad(k) {
    if (page === 'tune') {
      if (k === 'BKSP') ctx.tuneBuf = (ctx.tuneBuf || '').slice(0, -1);
      else if ((ctx.tuneBuf || '').length < 7) ctx.tuneBuf = (ctx.tuneBuf || '') + k;
    } else {
      if (k === 'BKSP') ctx.dtoBuf = (ctx.dtoBuf || '').slice(0, -1);
      else if ((ctx.dtoBuf || '').length < 6) ctx.dtoBuf = (ctx.dtoBuf || '') + k;
    }
    render();
  }

  // Knobs.
  function knob(which, delta) {
    var s = C.state();
    if (page === 'tune') {
      var f = parseFloat(ctx.tuneBuf) || (ctx.tuneWhich === 'COM' ? s.com.standby : s.vloc.standby);
      f += which === 'large' ? delta : delta * 0.05;
      ctx.tuneBuf = f.toFixed(3);
      render(); return;
    }
    // Otherwise the knobs tune the standby frequency of whichever window has the cursor.
    var w = s.com.tuning;
    var cur = w === 'COM' ? s.com.standby : s.vloc.standby;
    var step = which === 'large' ? 1 : (w === 'COM' ? 0.025 : 0.05);
    var lo = w === 'COM' ? 118 : 108, hi = w === 'COM' ? 136.99 : 117.95;
    var v = Math.round((cur + delta * step) * 1000) / 1000;
    if (v < lo) v = hi; if (v > hi) v = lo;
    C.tuneStandby(w, v);
    render();
  }

  function knobPress() {
    var s = C.state();
    s.com.tuning = s.com.tuning === 'COM' ? 'NAV' : 'COM';
    C.emit('knob.press', { tuning: s.com.tuning });
    render();
  }
  function knobHold() {
    var s = C.state();
    C.flipFlop(s.com.tuning);
    render();
  }

  function wireKnobs() {
    var large = $('#k-large'), small = $('#k-small');
    function ring(el, which) {
      var down = false, lastA = 0, held = null, moved = false;
      el.addEventListener('wheel', function (e) {
        e.preventDefault(); e.stopPropagation();
        knob(which, e.deltaY > 0 ? -1 : 1);
      }, { passive: false });
      el.addEventListener('pointerdown', function (e) {
        e.stopPropagation();
        down = true; moved = false;
        var r = el.getBoundingClientRect();
        lastA = Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2));
        el.setPointerCapture(e.pointerId);
        if (which === 'small') held = setTimeout(function () { held = null; knobHold(); moved = true; }, 600);
      });
      el.addEventListener('pointermove', function (e) {
        if (!down) return;
        var r = el.getBoundingClientRect();
        var a = Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2));
        var d = a - lastA;
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        if (Math.abs(d) > 0.35) {
          knob(which, d > 0 ? 1 : -1); lastA = a; moved = true;
          if (held) { clearTimeout(held); held = null; }
        }
      });
      el.addEventListener('pointerup', function (e) {
        e.stopPropagation();
        down = false;
        if (held) { clearTimeout(held); held = null; if (!moved && which === 'small') knobPress(); }
      });
    }
    ring(large, 'large'); ring(small, 'small');
  }

  // ---------------------------------------------------------------- loop

  function tick(ts) {
    raf = requestAnimationFrame(tick);
    var s = C.state();
    var dt = lastT ? Math.min(0.25, (ts - lastT) / 1000) : 0;
    lastT = ts;
    if (s.sim.running) {
      C.step(dt * s.sim.rate);
      renderLight();
    }
  }

  // ---------------------------------------------------------------- boot

  function boot(mount) {
    root = mount;
    root.querySelector('#unitmount').innerHTML = bezelHtml();
    screenEl = $('#screen', root);
    hsiCv = $('#hsicv', root);

    root.addEventListener('click', onClick);
    $('#k-home').addEventListener('click', function () { go('home'); });
    $('#k-dto').addEventListener('click', function () {
      ctx.dtoTab = 'wpt'; ctx.dtoBuf = ''; ctx.addMode = false; go('dto');
    });
    $('#k-vol').addEventListener('click', function () {
      var s = C.state();
      if (s.com.tuning === 'NAV') {
        var on = C.toggleNavIdent();
        C.message(on ? 'Nav ident audio on' : 'Nav ident audio off');
      } else {
        C.message('Squelch override (COM). Press with the NAV window active to toggle the ident.');
      }
      render();
    });
    wireKnobs();

    document.addEventListener('keydown', function (e) {
      if (/input|textarea/i.test((e.target.tagName || ''))) return;
      if (e.key === 'ArrowUp') { knob('small', 1); e.preventDefault(); }
      else if (e.key === 'ArrowDown') { knob('small', -1); e.preventDefault(); }
      else if (e.key === 'ArrowRight') { knob('large', 1); e.preventDefault(); }
      else if (e.key === 'ArrowLeft') { knob('large', -1); e.preventDefault(); }
      else if (e.key === 'Escape') back();
      else if (e.key === 'h' || e.key === 'H') go('home');
      else if (e.key === ' ') { toggleRun(); e.preventDefault(); }
    });

    return Promise.all([N.loadIndex(), loadFacilities()]).then(function () {
      return SC.load('esn-ils04');
    }).then(function () {
      render();
      raf = requestAnimationFrame(tick);
    });
  }

  function toggleRun() {
    var s = C.state();
    s.sim.running = !s.sim.running;
    lastT = 0;
    var b = $('#simrun');
    if (b) b.textContent = s.sim.running ? 'Pause' : 'Fly';
    renderSide();
  }

  global.NTUI = {
    boot: boot, render: render, go: go, toggleRun: toggleRun,
    setRange: function (r) { ctx.range = r; drawMap(); },
    setHints: function (on) { ctx.hintOn = !!on; render(); },
    hintsOn: function () { return !!ctx.hintOn; },
    ctx: ctx,
    page: function () { return page; }
  };

  // Read-only handle for headless checks, same pattern as the other explainers.
  global.NAVTRAINER_DEBUG = {
    state: function () { return C.state(); },
    nav: function () { return C.nav(); },
    progress: function () { return SC.progress(); },
    page: function () { return page; },
    go: go, act: function (a) { if (ACT[a]) ACT[a](); },
    ui: function () { return global.NTUI; }
  };
})(window);
