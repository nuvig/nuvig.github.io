// GPS/NAV/COM Trainer -- device chrome, pages and input.
// Unofficial training reference tool, not affiliated with or endorsed by Garmin.
//
// LAYOUT IS THE POINT. The screen is authored at its true 600x266 and scaled, so
// every internal dimension and type size is the real one. Three columns:
//
//   left rail  ~13%  the volume-knob legend, then Menu / MSG / Back
//   centre     ~69%  a centred title bar over the page body
//   right rail ~18%  COM (or NAV) active over standby, each with the database ident
//                    beneath it, then the transponder row, then a context key
//   bottom            phase | nav source | OBS or SUSP, and the knob legend
//
// Details that carry teaching weight and are therefore not decoration:
//   - the top-left legend reads "Com Vol / Psh Sq" and becomes "Nav Vol / Psh ID"
//     when the tuning cursor is in the NAV window. That legend IS the affordance
//     telling the pilot the volume press now toggles the ident.
//   - the small line under BOTH frequencies is the reverse-frequency lookup from the
//     database. It appears whether or not anything is being received, which is exactly
//     why students believe they have identified a facility when they have not.
//   - the keypad is two rows of five, not a phone pad.
//   - Default Navigation and Map are different pages; CDI and OBS live on the former.
//
// The bezel carries four controls, as the real unit does: volume/squelch, HOME,
// Direct-To, and the dual concentric knob. Everything else is a touch key.

(function (global) {
  'use strict';

  var N = global.NTNav, C = global.NTCore, SC = global.NTScenarios;

  var SCR_W = 600;

  var FAC = null;                 // data/navtrainer/facilities.json
  var page = 'nav', stack = [];
  var ctx = {};                   // per-page scratch (selection, keypad buffer)
  var root, screenEl, scrEl, mapCv, hsiCv;
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
  function fmtEte(nm, gs) {
    if (nm == null || !gs) return '--:--';
    var m = Math.round(nm / gs * 60);
    if (m > 599) return '--:--';
    return (Math.floor(m / 60) + '').padStart(2, '0') + ':' + ((m % 60) + '').padStart(2, '0');
  }

  function go(p, keep) {
    if (!keep && page !== p) stack.push(page);
    page = p;
    C.emit('ui.page', { page: p });
    render();
  }
  function back() {
    page = stack.pop() || 'nav';
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

  // The database name printed under a frequency ("I-FGH ILS", "KESN CTAF"), as the
  // unit shows it. A lookup from the database and GPS position -- never proof that
  // anything is being received.
  function rflLabel(freq) {
    if (freq == null || !FAC) return null;
    var best = null;
    Object.keys(FAC.airports).forEach(function (id) {
      var a = FAC.airports[id];
      (a.nav || []).forEach(function (n) {
        if (Math.abs(n.freq - freq) < 0.001) best = n.ident.replace(/^I/, 'I-') + ' ' + n.type;
      });
      (a.com || []).forEach(function (c) {
        if (Math.abs(c.freq - freq) < 0.001) best = id + ' ' + c.label.toUpperCase();
      });
    });
    return best;
  }

  // ---------------------------------------------------------------- icons

  // Icons are redrawn here to match the unit's own iconography -- same subject,
  // composition and colour, so a student reads the Home page the same way -- but they
  // are our own SVG, not the manufacturer's artwork. No wordmark or logo anywhere.
  // Shared planform: a top-view aircraft, nose up, in a 24x24 box.
  var PLANE = 'M12 2.2c.7 0 1.1 1 1.15 2.3l.1 4.2 8.25 5v1.6l-8.2-2.9.1 4.6 2.7 2v1.2' +
              'L12 19.1l-4.1 1.1v-1.2l2.7-2 .1-4.6-8.2 2.9v-1.6l8.25-5 .1-4.2' +
              'C10.9 3.2 11.3 2.2 12 2.2z';
  function plane(cx, cy, rot, sc, fill) {
    return '<g transform="translate(' + cx + ' ' + cy + ') rotate(' + rot + ') scale(' + sc +
           ') translate(-12 -12)"><path d="' + PLANE + '" fill="' + (fill || '#f2f6fa') +
           '" stroke="#8fa4b4" stroke-width=".5"/></g>';
  }

  var IC = {
    // Globe: cyan graticule, bright green land.
    map: '<ellipse cx="12" cy="12" rx="10" ry="8.4" fill="#071a12" stroke="#4fd0e8" stroke-width="1"/>' +
         '<path d="M2 12h20" stroke="#4fd0e8" stroke-width=".7"/>' +
         '<path d="M12 3.6v16.8" stroke="#4fd0e8" stroke-width=".7"/>' +
         '<ellipse cx="12" cy="12" rx="5" ry="8.4" fill="none" stroke="#4fd0e8" stroke-width=".7"/>' +
         '<path d="M5.2 8.8c1.5-1 3.1-.5 3.6.7.5 1.1-.4 2 .2 2.9.7 1 .1 2.3-.9 2.6-1.4.4-2.5-.9-2.9-2.1' +
           '-.4-1.3-.9-3.2 0-4.1z" fill="#5ee62e"/>' +
         '<path d="M12.6 7c1.7-.6 3.7-.2 4.7.9.9 1 .1 2.2-.7 2.9-.8.7-.6 1.8-1.5 2.3-1 .5-1.6-.6-1.7-1.5' +
           '-.1-1-.9-1.6-1.2-2.5-.3-.9-.3-1.8.4-2.1z" fill="#5ee62e"/>' +
         '<path d="M14.6 14.2c.9-.2 1.5.6 1.4 1.5-.1 1-.9 1.9-1.7 2.3-.7.3-1.2-.4-1-1.2.2-1 .5-2.4 1.3-2.6z" fill="#5ee62e"/>' +
         '<path d="M18.6 9.4c.8 0 1.3.8 1.1 1.5-.2.7-1 .9-1.5.5-.6-.4-.4-2 .4-2z" fill="#5ee62e"/>',

    // Traffic: filled diamond climbing, hollow diamond 800 ft below.
    traffic: '<path d="M6.6 2.6l3.1 3.1-3.1 3.1-3.1-3.1z" fill="#f2f6fa"/>' +
             '<path d="M14.6 9.6V3.1" stroke="#f2f6fa" stroke-width="1.7"/>' +
             '<path d="M14.6 2.4l2.3 2.8h-4.6z" fill="#f2f6fa"/>' +
             '<text x="1.2" y="19.4" font-size="7.6" font-weight="700" fill="#f2f6fa" ' +
               'font-family="system-ui,sans-serif">-08</text>' +
             '<path d="M17.6 12.6l3.1 3.1-3.1 3.1-3.1-3.1z" fill="none" stroke="#f2f6fa" stroke-width="1.4"/>',

    // Terrain: banded peaks, red cap over amber over yellow, dark ground.
    terrain: '<path d="M15 3.6L22.2 18H7.8z" fill="#d8351f"/>' +
             '<path d="M12.2 9.2h5.6l1.9 3.8H10.3z" fill="#f2a81f"/>' +
             '<path d="M10.3 13h9.4l2.5 5H7.8z" fill="#f7dc45"/>' +
             '<path d="M7.4 7.4L13.8 18H1z" fill="#e09a1e"/>' +
             '<path d="M4.7 11.8h5.4L13.8 18H1z" fill="#f7dc45"/>' +
             '<path d="M1 17.2h21.4v2.4H1z" fill="#171208"/>',

    // Weather: cumulus with rain streaks and a bolt.
    weather: '<path d="M6.4 14.6a3.3 3.3 0 01.5-6.4 4.5 4.5 0 018.5-1.3 3.7 3.7 0 013.4 4.3 3 3 0 01-1.2 3.4z" ' +
               'fill="#c2ccd4"/>' +
             '<path d="M6.4 14.6h11.2a3.1 3.1 0 00.9-1.5H6c.1.6.2 1.1.4 1.5z" fill="#8b98a3"/>' +
             '<path d="M6.6 16.4l-1.3 3.2M9.2 16.4l-1.3 3.2M11.8 16.4l-1.3 3.2" stroke="#3f9fe8" ' +
               'stroke-width="1.7" stroke-linecap="round"/>' +
             '<path d="M16.4 15.2l-2.9 4.3h2.2l-1.5 4.1 4.7-5.4h-2.4l1.7-3z" fill="#ffc61e"/>',

    // Default NAV: the compass puck, seen slightly from above.
    nav: '<ellipse cx="12" cy="14" rx="8" ry="4.3" fill="#9fb0bd"/>' +
         '<path d="M4 11.6v2.4a8 4.3 0 0016 0v-2.4z" fill="#b8c6d2"/>' +
         '<ellipse cx="12" cy="11.6" rx="8" ry="4.3" fill="#eef3f7" stroke="#8fa4b4" stroke-width=".6"/>' +
         '<path d="M12 8.3l1.5 3.1-1.5 1.2-1.5-1.2z" fill="#e838d8"/>' +
         '<circle cx="5.4" cy="11.6" r=".7" fill="#2f8fc4"/>' +
         '<circle cx="18.6" cy="11.6" r=".7" fill="#2f8fc4"/>' +
         '<circle cx="12" cy="14.9" r=".7" fill="#d8a020"/>' +
         '<circle cx="12" cy="8.4" r=".7" fill="#2fa04a"/>',

    // Flight plan: magenta leg flown, cyan leg to come, aircraft on the turn.
    fpl: '<circle cx="3.6" cy="19.8" r="1.7" fill="#e838d8"/>' +
         '<path d="M3.6 19.8L12 11.4" stroke="#e838d8" stroke-width="1.9" stroke-linecap="round"/>' +
         '<path d="M13.4 10.4L18 15.6" stroke="#4ff0f0" stroke-width="2.2" stroke-linecap="round"/>' +
         '<circle cx="18.6" cy="16.4" r="1.9" fill="#4ff0f0"/>' +
         plane(12.2, 9.4, 52, .62),

    // PROC: inbound course to a holding pattern.
    proc: '<path d="M2.4 20.4L10 12.6" stroke="#e838d8" stroke-width="1.9" stroke-linecap="round"/>' +
          '<g transform="rotate(-10 16.8 9.4)"><rect x="11.6" y="6.1" width="10.4" height="6.6" rx="3.3" ' +
            'fill="none" stroke="#dfe7ee" stroke-width="1.5"/></g>' +
          plane(10.4, 11.2, 48, .6),

    // Nearest: a waypoint off to one side of the aircraft.
    nearest: '<path d="M5.4 15.2l2.7-2.7 2.7 2.7-2.7 2.7z" fill="#c840e0"/>' +
             '<path d="M9.6 13.4L15.6 8" stroke="#e838d8" stroke-width="1.6" stroke-linecap="round"/>' +
             plane(17.4, 6.6, 46, .58),

    // Waypoint info: the waypoint symbol with its data block.
    wpt: '<path d="M7.6 14.4l3-3 3 3-3 3z" fill="#c840e0"/>' +
         '<path d="M13.6 11.4h7M13.6 8.4h7M13.6 14.4h4.5" stroke="#7fd8ee" stroke-width="1.4" ' +
           'stroke-linecap="round"/>',

    sys: '<circle cx="12" cy="12" r="3.6" fill="none" stroke="#7fd8ee" stroke-width="1.8"/>' +
         '<path d="M12 3.2v3.2M12 17.6v3.2M3.2 12h3.2M17.6 12h3.2M5.8 5.8l2.3 2.3M15.9 15.9l2.3 2.3' +
           'M18.2 5.8l-2.3 2.3M8.1 15.9l-2.3 2.3" stroke="#7fd8ee" stroke-width="1.7" stroke-linecap="round"/>',

    // Rail keys.
    menu: '<rect x="2.6" y="5" width="18.8" height="14" rx="1.6" fill="#5fd8e8"/>' +
          '<path d="M5.6 8.6h13M5.6 12h13M5.6 15.4h9.4" stroke="#08222c" stroke-width="1.9" ' +
            'stroke-linecap="round"/>' +
          '<rect x="4.6" y="6.6" width="3.4" height="3.4" rx=".5" fill="#08222c" opacity=".5"/>',
    msg: '<rect x="3.4" y="3.4" width="12.4" height="12.4" rx="1.4" fill="none" stroke="#5fd8e8" ' +
           'stroke-width="1.8"/>' +
         '<path d="M6.4 13.2V6.2l3.2 4.2 3.2-4.2v7" stroke="#5fd8e8" stroke-width="1.8" fill="none" ' +
           'stroke-linejoin="round"/>' +
         '<path d="M12.6 13.4h8.2v6.4h-8.2z" fill="#dceef7" stroke="#7fb8cc" stroke-width=".9"/>' +
         '<path d="M12.6 13.4l4.1 3 4.1-3" fill="none" stroke="#7fb8cc" stroke-width=".9"/>',
    back: '<path d="M9.6 5.2L2.8 11.6l6.8 6.4v-3.5c3.7-.2 6.2 1 8.1 3.5.4-5.6-2.7-8.4-8.1-8.6z" ' +
            'fill="#5fd8e8"/>' +
          '<path d="M11.2 17.6c2.5-.6 4.6.2 6.5 2.4.2-1.7.1-3-.2-4.1-1.8-.6-4-.4-6.3.4z" fill="#2a7fd0"/>',
    cancel: '<path d="M4.6 4.6l14.8 14.8M19.4 4.6L4.6 19.4" stroke="#4aa8e0" stroke-width="3.6" ' +
              'stroke-linecap="round"/>',
    find: '<circle cx="10.2" cy="10.2" r="6.2" fill="none" stroke="#7fc7e8" stroke-width="2.2"/>' +
          '<path d="M14.8 14.8l5.4 5.4" stroke="#7fc7e8" stroke-width="2.4" stroke-linecap="round"/>',
    home: '<path d="M12 3.2L2.2 11.6h2.7V20h5.2v-5.4h3.8V20h5.2v-8.4h2.7z" fill="#cfe8ff"/>',
    up: '<path d="M12 5l7 9H5z" fill="#5fd8e8"/>',
    down: '<path d="M12 19l-7-9h14z" fill="#5fd8e8"/>',
    xfer: '<path d="M8 4.4v13.2M8 4.4L5.4 8M8 4.4l2.6 3.6M16 19.6V6.4M16 19.6l-2.6-3.6M16 19.6l2.6-3.6" ' +
            'stroke="#cfe8ff" stroke-width="1.8" fill="none" stroke-linecap="round"/>',
    bksp: '<path d="M8 4.8h12.8v14.4H8L1.8 12z" fill="none" stroke="#cfe8ff" stroke-width="1.6"/>' +
          '<path d="M11 9.4l5.4 5.2M16.4 9.4L11 14.6" stroke="#cfe8ff" stroke-width="1.6" ' +
            'stroke-linecap="round"/>'
  };

  function ico(k, sz) {
    return '<svg class="ic" viewBox="0 0 24 24" width="' + (sz || 22) + '" height="' + (sz || 22) +
           '" fill="none" stroke-linecap="round">' + (IC[k] || '') + '</svg>';
  }

  // ---------------------------------------------------------------- bezel

  function bezelHtml() {
    return '' +
      '<div class="unit" id="unit">' +
        '<div class="bz-l">' +
          '<button class="vknob" id="k-vol" data-hint="vol" ' +
            'title="Volume / Squelch. With the NAV window active, press to toggle the ident.">' +
            '<span class="vk-face"></span></button>' +
          '<div class="cardslot"></div>' +
        '</div>' +
        '<div class="screen" id="screen"><div class="scr" id="scr"></div></div>' +
        '<div class="bz-r">' +
          '<button class="bzk" id="k-home" data-hint="home" title="HOME">' + ico('home', 17) + '</button>' +
          '<button class="bzk" id="k-dto" data-hint="dto" title="Direct-To">' +
            '<svg viewBox="0 0 30 20" width="27" height="18"><text x="1" y="16" font-size="15" ' +
            'font-weight="700" fill="#cfe8ff" font-family="system-ui,sans-serif">D</text>' +
            '<path d="M3 5h23M22 1.5l5 3.5-5 3.5" stroke="#cfe8ff" stroke-width="1.7" fill="none"/></svg>' +
          '</button>' +
          '<div class="knobs">' +
            '<div class="kring large" id="k-large" title="Large knob: MHz, or move the list cursor">' +
              '<div class="kring small" id="k-small" ' +
                'title="Small knob: kHz. Press to move the tuning cursor between COM and NAV. Hold to transfer."></div>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>';
  }

  // ---------------------------------------------------------------- rails

  function railLeft() {
    var s = C.state();
    var navTune = s.com.tuning === 'NAV';
    var p = PAGEDEF[page] || {};
    var keys = '';
    if (p.menu) keys += '<button class="rk" data-act="menu">' + ico('menu') + '<span>Menu</span></button>';
    if (p.find) keys += '<button class="rk" data-act="find">' + ico('find') + '<span>Find</span></button>';
    keys += '<button class="rk" data-act="msg">' + ico('msg') + '<span>MSG</span></button>';
    keys += p.cancel
      ? '<button class="rk" data-act="back">' + ico('cancel') + '<span>Cancel</span></button>'
      : '<button class="rk" data-act="back">' + ico('back') + '<span>Back</span></button>';
    return '<div class="rail-l">' +
      '<div class="volleg' + (navTune ? ' nav' : '') + '">' +
        (navTune ? 'Nav Vol<br>Psh ID' : 'Com Vol<br>Psh Sq') + '</div>' +
      '<div class="rkeys">' + keys + '</div>' +
    '</div>';
  }

  function railRight() {
    var s = C.state();
    var navTune = s.com.tuning === 'NAV';
    var act = navTune ? s.vloc.active : s.com.active;
    var sby = navTune ? s.vloc.standby : s.com.standby;
    var dec = s.vloc.decoded;
    var ctxKey = page === 'nav'
      ? '<button class="rrk" data-go="map">' + ico('map', 19) + '<span>Map</span></button>'
      : '<button class="rrk" data-go="nav">' + ico('nav', 19) + '<span>Nav</span></button>';
    return '<div class="rail-r">' +
      '<button class="fqbox" data-act="' + (navTune ? 'nav-flip' : 'com-flip') + '" ' +
        'title="Touch the active window to flip/flop">' +
        '<span class="fq-k">' + (navTune ? 'NAV' : 'COM') +
          (navTune && s.vloc.identOn ? '<em class="idflag" title="Ident audio on">ID</em>' : '') +
        '</span>' +
        '<span class="fq-a">' + fmtFreq(act) + '</span>' +
        '<span class="fq-rfl' + (navTune && dec ? ' heard' : '') + '" title="' +
          (navTune
            ? (dec ? 'Morse decoded off the active frequency. This is identification.'
                   : 'Database lookup only -- nothing is being decoded off this frequency.')
            : 'Database lookup from GPS position.') + '">' +
          esc(rflLabel(act) || '&nbsp;') + '</span>' +
      '</button>' +
      '<div class="fqflip" title="Touch the active window, or hold the small knob, to flip/flop">' +
        '<svg viewBox="0 0 12 16" width="9" height="12"><path d="M6 1.5v13M6 1.5L3.4 4.6M6 1.5l2.6 3.1' +
        'M6 14.5l-2.6-3.1M6 14.5l2.6-3.1" stroke="#cfe0ee" stroke-width="1.3" fill="none" ' +
        'stroke-linecap="round"/></svg></div>' +
      '<button class="fqbox sby" data-act="' + (navTune ? 'nav-sby' : 'com-sby') + '" ' +
        'title="Touch the standby window to enter a frequency">' +
        '<span class="fq-k">STBY</span>' +
        '<span class="fq-s">' + fmtFreq(sby) + '</span>' +
        '<span class="fq-rfl" title="Reverse frequency lookup from the database. Not identification.">' +
          esc(rflLabel(sby) || '&nbsp;') + '</span>' +
      '</button>' +
      '<div class="xpdr" title="Transponder is chrome here, not modelled">' +
        '<span class="fq-k">XPDR1<em>ALT</em></span><span class="xp-c">1200</span></div>' +
      ctxKey +
    '</div>';
  }

  function annBar() {
    var s = C.state(), nv = C.nav();
    var third = s.seq.obs ? '<span class="an-obs">OBS</span>'
              : s.seq.susp ? '<span class="an-susp">SUSP</span>' : '<span></span>';
    return '<div class="annbar">' +
      '<span class="an-ph">' + esc(nv.phase || '') + '</span>' +
      '<span class="an-src ' + (nv.source === 'VLOC' ? 'vloc' : 'gps') + '">' + nv.source + '</span>' +
      third +
      '<span class="an-knob">' +
        (s.com.tuning === 'NAV' ? 'Nav Freq | Psh Com' : 'Com Freq | Psh Nav') + ' &#9654;</span>' +
    '</div>';
  }

  // ---------------------------------------------------------------- page table

  // menu/find/cancel decide which left-rail keys a page shows.
  var PAGEDEF = {
    nav:          { title: 'Default Navigation', icon: 'nav', menu: true },
    map:          { title: 'Map', icon: 'map', menu: true },
    home:         { title: 'Home', icon: 'home' },
    fpl:          { title: 'Active Flight Plan', icon: 'fpl', menu: true },
    wptopt:       { title: 'Waypoint Options', icon: 'fpl', cancel: true },
    proc:         { title: 'Procedures', icon: 'proc' },
    'proc-appr':  { title: 'PROC – Approach', icon: 'proc', cancel: true },
    'proc-arr':   { title: 'PROC – Arrival', icon: 'proc', cancel: true },
    'proc-dep':   { title: 'PROC – Departure', icon: 'proc', cancel: true },
    'appr-list':  { title: 'Select Approach', icon: 'proc', cancel: true },
    'trans-list': { title: 'Select Transition', icon: 'proc', cancel: true },
    dto:          { title: 'Direct To', icon: 'nav', cancel: true, find: true },
    nearest:      { title: 'Nearest Airport', icon: 'nearest' },
    wpt:          { title: 'Waypoint Info', icon: 'wpt' },
    system:       { title: 'System Setup', icon: 'sys' },
    tune:         { title: 'Standby', icon: 'nav', cancel: true, find: true }
  };

  var PAGES = {};

  PAGES.home = function () {
    var keys = [
      ['map', 'Map', 'map'], ['na-traffic', 'Traffic', 'traffic'],
      ['na-terrain', 'Terrain', 'terrain'], ['na-weather', 'Weather', 'weather'],
      ['nav', 'Default NAV', 'nav'], ['fpl', 'Flight Plan', 'fpl'],
      ['proc', 'PROC', 'proc'], ['nearest', 'Nearest', 'nearest'],
      ['wpt', 'Waypoint Info', 'wpt'], ['system', 'System', 'sys']
    ];
    return '<div class="hgrid">' + keys.map(function (k) {
      var off = k[0].indexOf('na-') === 0;
      return '<button class="hkey' + (off ? ' off' : '') + '" data-go="' + k[0] +
        '" data-hint="' + k[0] + '">' + ico(k[2], 25) + '<span>' + esc(k[1]) + '</span></button>';
    }).join('') + '</div>';
  };

  PAGES.nav = function () {
    var s = C.state(), nv = C.nav();
    function fld(lbl, val, unit) {
      return '<div class="dfld"><span class="dl">' + lbl + '</span>' +
        '<span class="dv">' + val + (unit ? '<i>' + unit + '</i>' : '') + '</span></div>';
    }
    var d = nv.dist;
    return '<div class="pg-nav">' +
      '<div class="dgrid">' +
        fld('DIS', fmtDist(d), 'NM') +
        fld('DTK', fmtCrs(nv.dtk), '°') +
        fld('BRG', fmtCrs(nv.brg), '°') +
        fld('GS', Math.round(s.ac.gs), 'KT') +
        fld('TRK', fmtCrs(s.ac.trk), '°') +
        fld('ETE', fmtEte(d, s.ac.gs), '') +
      '</div>' +
      '<div class="fplband">' + fplBand(nv) + '</div>' +
      '<div class="cdirow">' +
        '<button class="rndk' + (nv.source === 'VLOC' ? ' on' : '') + '" data-act="cdi" data-hint="cdi">' +
          rose(nv.dtk, nv.source === 'VLOC' ? '#4ade80' : '#e879f9') + '<span>CDI</span></button>' +
        cdiScale(nv) +
        '<button class="rndk' + (nv.obs || nv.susp ? ' on' : '') + '" data-act="obs" data-hint="obs">' +
          rose(nv.obs ? nv.obsCourse : nv.dtk, '#8fd4ea') +
          '<span>' + (C.obsAvailable() ? 'OBS' : 'SUSP') + '</span></button>' +
      '</div>' +
    '</div>';
  };

  function rose(crs, col) {
    return '<svg viewBox="0 0 34 34" width="32" height="32">' +
      '<circle cx="17" cy="17" r="14" fill="#08131d" stroke="#3d6a86"/>' +
      '<g transform="rotate(' + (crs || 0) + ' 17 17)">' +
      '<path d="M17 6v8M17 20v8" stroke="' + col + '" stroke-width="2.2"/>' +
      '<path d="M17 3.5l3 4.5h-6z" fill="' + col + '"/></g>' +
      '<circle cx="17" cy="17" r="1.7" fill="#8fd4ea"/></svg>';
  }

  function cdiScale(nv) {
    var pct = 50 + Math.max(-1, Math.min(1, nv.deflection)) * 38;
    var dots = [-2, -1, 1, 2].map(function (i) {
      return '<span class="cd" style="left:' + (50 + i * 19) + '%"></span>';
    }).join('');
    return '<div class="cdibar" title="Full scale ' + nv.fullScale.toFixed(1) + ' nm">' +
      dots + '<span class="cdneedle" style="left:' + pct + '%;background:' +
      (nv.source === 'VLOC' ? '#4ade80' : '#e879f9') + '"></span>' +
      '<span class="cdtf">' + esc(nv.toFrom) + '</span></div>';
  }

  function fplBand(nv) {
    var s = C.state();
    if (!nv.leg) return '<span class="dim">No active leg</span>';
    var direct = C.activatedDirect();
    var from = direct ? 'direct' : (nv.index > 0 ? (s.fpl.legs[nv.index - 1].ident || '') : '');
    var nxt = nv.next ? (nv.next.ident || nv.next.pt) : '';
    var obs = s.seq.obs
      ? '<span class="fb-obs">obs ' + fmtCrs(s.seq.obsCourse) + '°</span>' : '';
    var vtf = s.fpl.approach && s.fpl.approach.vtf && nv.leg.seg === 'appr'
      ? '<span class="fb-vtf">vtf</span>' : '';
    return obs + (from ? '<span class="fb-o">' + esc(from) + '</span>' +
      '<span class="fb-ar">→</span>' : '') +
      '<span class="fb-a">' + esc(nv.leg.ident || nv.leg.pt) + '</span>' + vtf +
      (nxt ? '<span class="fb-ar">→</span><span class="fb-o">' + esc(nxt) + '</span>' : '');
  }

  PAGES.map = function () { return '<canvas id="mapcv"></canvas>'; };

  PAGES.fpl = function () {
    var s = C.state();
    if (!s.fpl.legs.length) {
      return '<div class="empty">Flight plan empty' +
        '<button class="k wide" data-act="fpl-add">Add Waypoint</button></div>';
    }
    var rows = s.fpl.legs.map(function (l, i) {
      var act = i === s.fpl.active;
      var brg = null, dst = null;
      if (C.legHasFix(l)) {
        var o = act ? C.legOrigin(i)
                    : (i > 0 && C.legHasFix(s.fpl.legs[i - 1])
                        ? { lat: s.fpl.legs[i - 1].lat, lon: s.fpl.legs[i - 1].lon } : null);
        if (o) {
          brg = N.bearing(o, { lat: l.lat, lon: l.lon });
          dst = N.dist(o, { lat: l.lat, lon: l.lon });
        }
      }
      var info = N.airportInfo(l.ident);
      var sub = l.seg === 'enroute'
        ? (info ? info.name : '')
        : (l.procName || '') + (l.role ? ' · ' + l.role : '');
      return '<button class="fr' + (act ? ' act' : '') + (l.seg === 'missed' ? ' ma' : '') +
        '" data-fpl="' + i + '">' +
        '<span class="fr-l"><b>' + esc(l.ident || legLabel(l)) + '</b><i>' + esc(sub) + '</i></span>' +
        '<span class="fr-r"><b>' + (brg == null ? '' : fmtCrs(brg) + '°') + '</b>' +
        '<i>' + (dst == null ? '' : fmtDist(dst) + '<u>NM</u>') + '</i></span></button>';
    }).join('');
    return '<div class="frows">' + rows + '</div>';
  };

  function destIdent() {
    var s = C.state();
    if (s.fpl.approach) return s.fpl.approach.aptId;
    for (var i = s.fpl.legs.length - 1; i >= 0; i--) {
      if (s.fpl.legs[i].ident && N.airportInfo(s.fpl.legs[i].ident)) return s.fpl.legs[i].ident;
    }
    return '';
  }

  function legLabel(l) {
    if (l.pt === 'CA' || l.pt === 'VA') return 'to ' + fmtAlt(l.alt1) + ' ft';
    if (l.pt === 'VI' || l.pt === 'VM') return 'HDG ' + fmtCrs(l.course);
    return l.pt;
  }

  PAGES.wptopt = function () {
    var l = C.state().fpl.legs[ctx.wptOptIdx];
    if (!l) return '<div class="empty">No waypoint.</div>';
    return '<div class="optgrid">' +
      '<button class="k w2" data-act="wo-activate" data-hint="wo-activate">Activate Leg</button>' +
      '<button class="k" data-go="proc-appr">Load<br>PROC</button>' +
      '<button class="k off">Load<br>SAR</button>' +
      '<button class="k off">Insert<br>Before</button>' +
      '<button class="k off">Insert<br>After</button>' +
      '<button class="k w2" data-act="wo-info">Waypoint Info</button>' +
      '<button class="k off">Along<br>Track</button>' +
      '<button class="k off">Hold at<br>WPT</button>' +
      '<button class="k w2" data-act="wo-remove">Remove</button>' +
    '</div>';
  };

  PAGES.proc = function () {
    var s = C.state();
    var hasAppr = !!s.fpl.approach;
    var actv = hasAppr && s.fpl.approach.active;
    var atMap = s.seq.susp && s.seq.suspReason === 'map';
    return '<div class="proclay">' +
      '<div class="pfields">' +
        pfield('Departure', s.fpl.departure, 'proc-dep') +
        pfield('Arrival', s.fpl.arrival, 'proc-arr') +
        pfield('Approach', s.fpl.approach, 'proc-appr') +
      '</div>' +
      '<div class="pacts">' +
        '<button class="k' + (hasAppr && !actv ? '' : ' off') + '" data-act="appr-activate" ' +
          'data-hint="appr-activate">Activate<br>Approach</button>' +
        '<button class="k' + (hasAppr ? '' : ' off') + '" data-act="appr-vtf">' +
          'Activate<br>Vectors<br>To Final</button>' +
        '<button class="k' + (atMap ? '' : ' off') + '" data-act="obs">' +
          'Activate<br>Missed<br>Approach</button>' +
      '</div>' +
    '</div>';
  };

  function pfield(label, sel, target) {
    return '<button class="pf" data-go="' + target + '" data-hint="' + target + '">' +
      '<span class="pf-l">' + label + '</span>' +
      '<span class="pf-v' + (sel ? '' : ' dash') + '">' +
        (sel ? esc(sel.name) + (sel.trans ? '  ·  ' + esc(sel.trans) : '')
             : '– – – – – – – –') +
      '</span></button>';
  }

  PAGES['proc-arr'] = function () {
    return '<div class="empty"><p>No arrivals are coded for this airport.</p>' +
      '<p class="dim">Arrival means STAR &mdash; the route into the terminal area. ' +
      'An instrument approach is behind the Approach key.</p></div>';
  };
  PAGES['proc-dep'] = function () {
    return '<div class="empty"><p>No departures are coded for this airport.</p>' +
      '<p class="dim">Departure means SID.</p></div>';
  };

  PAGES['proc-appr'] = function () {
    var aptId = ctx.apptApt || destIdent();
    var a = aptId ? N.airport(aptId) : null;
    if (!a) return '<div class="empty">Loading ' + esc(aptId || '') + '&hellip;</div>';
    var sel = ctx.selAppr
      ? (a.procs || []).filter(function (p) { return p.id === ctx.selAppr; })[0] : null;
    var nav = sel ? navFor(a.id, sel.id) : null;
    var kind = sel ? C.approachKind(sel) : null;
    var needsVloc = kind === 'ILS' || kind === 'LOC' || kind === 'LDA' || kind === 'SDF';
    return '<div class="afields">' +
      afield('Airport', a.id, 'appr-apt') +
      afield('Approach', sel ? (sel.name || sel.id) : null, 'appr-pick', 'appr-pick') +
      afield('Transition', ctx.selTrans || null, 'appr-trans', 'appr-trans') +
      afield('Channel / ID',
        needsVloc && nav ? nav.ident.replace(/^I/, 'I-') + '   ' + fmtFreq(nav.freq) : null,
        null, null, !!(needsVloc && nav && nav.verified === false)) +
    '</div>' +
    '<div class="arow">' +
      '<button class="k' + (sel ? '' : ' off') + '" data-act="appr-preview">' +
        ico('map', 16) + 'Preview</button>' +
      '<button class="k' + (sel ? '' : ' off') + '" data-act="appr-load" data-hint="appr-load">' +
        'Load<br>Approach</button>' +
      '<button class="k' + (sel ? '' : ' off') + '" data-act="appr-loadact" data-hint="appr-activate">' +
        'Load APPR<br>&amp; Activate</button>' +
    '</div>';
  };

  function afield(label, val, act, hint, warn) {
    return '<button class="pf af' + (act ? '' : ' nopick') + '"' +
      (act ? ' data-act="' + act + '"' : '') + (hint ? ' data-hint="' + hint + '"' : '') + '>' +
      '<span class="pf-l">' + label + '</span>' +
      '<span class="pf-v' + (val ? '' : ' dash') + '">' +
        (val ? esc(val) : '– – – – –') +
        (warn ? '<em class="unver" title="Placeholder in data/navtrainer/facilities.json">unverified</em>' : '') +
      '</span></button>';
  }

  PAGES['appr-list'] = function () {
    var a = N.airport(ctx.apptApt || destIdent());
    if (!a) return '<div class="empty">No airport.</div>';
    return '<div class="lrows">' + (a.procs || [])
      .filter(function (p) { return p.type === 'APP'; })
      .map(function (p) {
        return '<button class="lrow' + (p.co ? ' off' : '') + '" data-appr="' + esc(p.id) + '">' +
          '<span>' + esc(p.name || p.id) + '</span>' +
          (p.co ? '<em>chart only</em>' : '') + '</button>';
      }).join('') + '</div>';
  };

  PAGES['trans-list'] = function () {
    var a = N.airport(ctx.apptApt || destIdent());
    var sel = a && ctx.selAppr
      ? (a.procs || []).filter(function (p) { return p.id === ctx.selAppr; })[0] : null;
    if (!sel) return '<div class="empty">No approach selected.</div>';
    return '<div class="lrows">' +
      (sel.trans || []).filter(function (t) { return t.k === 'transition'; })
        .map(function (t) {
          return '<button class="lrow" data-trans="' + esc(t.t) + '">' + esc(t.t) + '</button>';
        }).join('') +
      '<button class="lrow" data-trans="VECTORS">Vectors</button>' +
    '</div>';
  };

  PAGES.dto = function () {
    var buf = ctx.dtoBuf || '';
    var s = C.state();
    var tab = ctx.dtoTab || 'wpt';
    var body;
    if (tab === 'fpl') {
      body = '<div class="lrows">' + s.fpl.legs.map(function (l, i) {
        return C.legHasFix(l) ? '<button class="lrow" data-dtofpl="' + i + '">' +
          esc(l.ident || legLabel(l)) + '</button>' : '';
      }).join('') + '</div>';
    } else if (tab === 'nrst') {
      body = nearestRows();
    } else {
      body = '<div class="entry"><span class="ebuf">' + esc(buf || '_ _ _ _ _') + '</span></div>' +
        '<div class="lrows sm">' + N.search(buf, 4).map(function (w) {
          return '<button class="lrow" data-dtow="' + esc(w.ident) + '">' +
            '<span>' + esc(w.ident) + '</span><em>' + esc(w.name || w.kind) + '</em></button>';
        }).join('') + '</div>' + keypad('alpha');
    }
    return '<div class="tabs">' +
      ['wpt|Waypoint', 'fpl|FPL', 'nrst|Nearest'].map(function (t) {
        var p = t.split('|');
        return '<button class="tab' + (tab === p[0] ? ' on' : '') + '" data-dtotab="' + p[0] + '">' +
          p[1] + '</button>';
      }).join('') + '</div>' + body;
  };

  function nearestRows() {
    var s = C.state(), p = { lat: s.ac.lat, lon: s.ac.lon };
    var list = N.allAirports().map(function (a) {
      return { id: a[0], name: a[1], d: N.dist(p, { lat: a[2], lon: a[3] }),
               b: N.bearing(p, { lat: a[2], lon: a[3] }) };
    }).sort(function (x, y) { return x.d - y.d; }).slice(0, 7);
    return '<div class="lrows">' + list.map(function (a) {
      return '<button class="lrow" data-dtow="' + esc(a.id) + '">' +
        '<span>' + esc(a.id) + '</span><em>' + esc(a.name) + '</em>' +
        '<b>' + fmtCrs(a.b) + '°</b><b>' + fmtDist(a.d) + '<u>NM</u></b></button>';
    }).join('') + '</div>';
  }
  PAGES.nearest = function () { return nearestRows(); };

  PAGES.wpt = function () {
    var id = ctx.wptId || destIdent();
    var info = id ? N.airportInfo(id) : null;
    var a = id ? N.airport(id) : null;
    if (!info) return '<div class="empty">No waypoint selected.</div>';
    var s = C.state(), p = { lat: s.ac.lat, lon: s.ac.lon };
    return '<div class="wptpg">' +
      '<div class="wpt-h"><b>' + esc(info.ident) + '</b><i>' + esc(info.name) + '</i></div>' +
      '<div class="dgrid two">' +
        '<div class="dfld"><span class="dl">BRG</span><span class="dv">' +
          fmtCrs(N.bearing(p, info)) + '<i>°</i></span></div>' +
        '<div class="dfld"><span class="dl">DIS</span><span class="dv">' +
          fmtDist(N.dist(p, info)) + '<i>NM</i></span></div>' +
        '<div class="dfld"><span class="dl">ELEV</span><span class="dv">' +
          (a ? fmtAlt(a.elev) : '--') + '<i>FT</i></span></div>' +
      '</div>' +
      '<div class="lrows sm">' + comsFor(id).map(function (c) {
        return '<button class="lrow" data-com="' + c.freq + '"><span>' + esc(c.label) + '</span>' +
          '<b>' + fmtFreq(c.freq) + '</b>' +
          (c.verified === false ? '<em class="unver">unverified</em>' : '') + '</button>';
      }).join('') + '</div>' +
    '</div>';
  };

  PAGES.system = function () {
    var s = C.state();
    return '<div class="afields one">' +
      '<button class="pf af" data-act="cdicap"><span class="pf-l">ILS CDI Capture</span>' +
      '<span class="pf-v">' + s.cdi.ilsCapture + '</span></button></div>' +
      '<div class="note">Auto: the CDI takes VLOC on its own within 1.2 nm of the final approach ' +
      'course and 2.0&ndash;15.0 nm from the FAF. Inside 2 nm there is no automatic switch. ' +
      'Manual: you decide, every time.</div>';
  };

  PAGES.tune = function () {
    var which = ctx.tuneWhich || 'COM';
    var buf = ctx.tuneBuf || '';
    return '<div class="tunetop">' +
      '<button class="tk" data-act="tune-xfer" title="Straight into the active window">' +
        ico('xfer', 15) + '<span>XFER</span></button>' +
      '<button class="tk off"><span>MON</span></button>' +
      '<div class="tunebox"><span class="tb-l">' + which + ' Standby</span>' +
        '<span class="tb-v">' + esc(buf || '___.__') + '</span></div>' +
      '<button class="tk" data-key="BKSP">' + ico('bksp', 15) + '<span>BKSP</span></button>' +
    '</div>' + keypad('num') +
    (which === 'NAV'
      ? '<div class="note sm">Enter puts it in standby. XFER puts it in the active window. ' +
        'Neither identifies it.</div>' : '');
  };

  // Two rows of five and an Enter key -- the unit's layout, not a phone pad.
  function keypad(kind) {
    if (kind === 'num') {
      return '<div class="kp num">' +
        '12345'.split('').map(kpk).join('') +
        '67890'.split('').map(kpk).join('') +
        '<button class="kpk ent" data-act="tune-enter">Enter</button></div>';
    }
    return '<div class="kp alpha">' +
      'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('').map(kpk).join('') +
      '<button class="kpk bk" data-key="BKSP">' + ico('bksp', 13) + '</button></div>';
  }
  function kpk(k) { return '<button class="kpk" data-key="' + k + '">' + k + '</button>'; }

  // ---------------------------------------------------------------- render

  function render() {
    if (!scrEl) return;
    var def = PAGEDEF[page] || { title: '', icon: 'nav' };
    var body = (PAGES[page] || PAGES.nav)();
    var full = page === 'wptopt' || page === 'tune';   // pages with no frequency rail
    var s0 = C.state();
    // The plan page's title bar carries the route and the column heading rather
    // than a page name, exactly as the unit does.
    var title = def.title, right = '';
    if (page === 'fpl' && s0.fpl.legs.length) {
      title = ((s0.fpl.legs[0] && s0.fpl.legs[0].ident) || '') + ' / ' + (destIdent() || '');
      right = 'DTK / DIS';
    }
    scrEl.innerHTML =
      railLeft() +
      '<div class="mid' + (full ? ' full' : '') + '">' +
        '<div class="tbar' + (right ? ' split' : '') + '">' + ico(def.icon, 14) +
          '<span>' + esc(title) + '</span>' +
          (right ? '<em>' + esc(right) + '</em>' : '') + '</div>' +
        '<div class="pbody pb-' + page + '">' + body + '</div>' +
      '</div>' +
      (full ? '' : railRight()) +
      annBar();
    if (page === 'map') { mapCv = $('#mapcv', scrEl); }
    fitScreen();
    if (page === 'map') drawMap();
    renderSide();
    applyHints();
  }

  function renderLight() {
    if (page === 'map' || page === 'nav' || page === 'fpl') render();
    else {
      var rr = $('.rail-r', scrEl);
      if (rr) rr.outerHTML = railRight();
      var ab = $('.annbar', scrEl);
      if (ab) ab.outerHTML = annBar();
      renderSide();
    }
  }

  // The screen is authored at 600x266 and scaled, so every dimension inside is true.
  function fitScreen() {
    if (!screenEl || !scrEl) return;
    var w = screenEl.clientWidth;
    if (!w) return;
    scrEl.style.transform = 'scale(' + (w / SCR_W) + ')';
  }

  // ---------------------------------------------------------------- map

  function drawMap() {
    if (!mapCv) return;
    var dpr = Math.min(2, global.devicePixelRatio || 1);
    var w = mapCv.clientWidth, h = mapCv.clientHeight;
    if (!w || !h) return;
    if (mapCv.width !== Math.round(w * dpr)) {
      mapCv.width = Math.round(w * dpr); mapCv.height = Math.round(h * dpr);
    }
    var g = mapCv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    var s = C.state(), ac = s.ac;
    var range = ctx.range || 20;
    var cx = w / 2, cy = h * 0.68, ppn = (h * 0.62) / range, trk = ac.trk;

    function xy(p) {
      var d = N.dist({ lat: ac.lat, lon: ac.lon }, p);
      var b = N.bearing({ lat: ac.lat, lon: ac.lon }, p);
      var a = N.rad(b - trk);
      return [cx + Math.sin(a) * d * ppn, cy - Math.cos(a) * d * ppn];
    }

    g.strokeStyle = 'rgba(120,160,190,.25)'; g.lineWidth = 1;
    g.beginPath(); g.arc(cx, cy, (range / 2) * ppn, 0, Math.PI * 2); g.stroke();
    g.fillStyle = 'rgba(150,190,215,.6)'; g.font = '9px system-ui,sans-serif';
    g.fillText((range / 2) + ' nm', cx + 4, cy - (range / 2) * ppn - 3);

    var labels = [], legs = s.fpl.legs;
    for (var i = 0; i < legs.length; i++) {
      var l = legs[i];
      if (!C.legHasFix(l)) continue;
      var prev = null;
      for (var j = i - 1; j >= 0; j--) if (C.legHasFix(legs[j])) { prev = legs[j]; break; }
      var isActive = i === s.fpl.active;
      var from = isActive ? C.legOrigin(i) : (prev ? { lat: prev.lat, lon: prev.lon } : null);
      if (from) {
        var p1 = xy(from), p2 = xy({ lat: l.lat, lon: l.lon });
        g.beginPath(); g.moveTo(p1[0], p1[1]); g.lineTo(p2[0], p2[1]);
        g.strokeStyle = isActive ? '#e879f9'
          : (l.seg === 'missed' ? 'rgba(255,255,255,.32)' : 'rgba(230,240,250,.62)');
        g.lineWidth = isActive ? 3 : 1.6;
        g.setLineDash(l.seg === 'missed' ? [5, 4] : []);
        g.stroke(); g.setLineDash([]);
      }
      if (N.isHold(l)) {
        g.beginPath();
        N.holdPath(l, ac.gs).forEach(function (pt, k) {
          var q = xy(pt); if (k === 0) g.moveTo(q[0], q[1]); else g.lineTo(q[0], q[1]);
        });
        g.strokeStyle = isActive ? '#e879f9' : 'rgba(230,240,250,.5)';
        g.lineWidth = isActive ? 2.4 : 1.4; g.stroke();
      }
      var q2 = xy({ lat: l.lat, lon: l.lon });
      g.fillStyle = isActive ? '#e879f9' : '#cfe0f0';
      g.beginPath(); g.arc(q2[0], q2[1], 3.2, 0, Math.PI * 2); g.fill();
      if (l.ident) placeLabel(g, l.ident, q2[0] + 6, q2[1] - 4, isActive, labels);
    }

    g.save(); g.translate(cx, cy);
    g.fillStyle = '#fff';
    g.beginPath(); g.moveTo(0, -9); g.lineTo(6, 8); g.lineTo(0, 4); g.lineTo(-6, 8); g.closePath();
    g.fill(); g.restore();

    g.fillStyle = 'rgba(160,195,220,.75)'; g.font = '9px system-ui,sans-serif';
    g.fillText(fmtCrs(trk) + '°', 5, h - 6);
  }

  // Waypoint labels crowd badly on an approach. The active leg always gets its name;
  // anything that would overprint an existing label is dropped instead.
  function placeLabel(g, text, x, y, force, drawn) {
    g.font = '9px system-ui,sans-serif';
    var w = g.measureText(text).width, box = [x, y - 8, x + w, y + 2];
    if (!force) {
      for (var i = 0; i < drawn.length; i++) {
        var b = drawn[i];
        if (box[0] < b[2] + 3 && box[2] > b[0] - 3 && box[1] < b[3] + 2 && box[3] > b[1] - 2) return;
      }
    }
    drawn.push(box);
    g.fillStyle = force ? '#f5d0fe' : 'rgba(220,235,250,.88)';
    g.fillText(text, x, y);
  }

  // ---------------------------------------------------------------- panel CDI

  function drawHsi() {
    if (!hsiCv) return;
    var dpr = Math.min(2, global.devicePixelRatio || 1);
    var w = hsiCv.clientWidth, h = hsiCv.clientHeight;
    if (!w || !h) return;
    if (hsiCv.width !== Math.round(w * dpr)) {
      hsiCv.width = Math.round(w * dpr); hsiCv.height = Math.round(h * dpr);
    }
    var g = hsiCv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    var nv = C.nav(), s = C.state();
    var cx = w / 2, cy = h / 2, r = Math.min(w, h) / 2 - 16, hdg = s.ac.trk;

    g.save(); g.translate(cx, cy);
    g.strokeStyle = 'rgba(150,180,205,.35)'; g.lineWidth = 1;
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
    g.restore();
    var crs = nv.obs && nv.obsCourse != null ? nv.obsCourse : nv.dtk;
    if (crs != null) {
      g.save(); g.rotate(N.rad(crs - hdg));
      var col = nv.source === 'VLOC' ? '#4ade80' : '#e879f9';
      g.strokeStyle = col; g.lineWidth = 3; g.lineCap = 'round';
      g.beginPath(); g.moveTo(0, -r + 8); g.lineTo(0, -r * 0.45); g.stroke();
      g.beginPath(); g.moveTo(0, r * 0.45); g.lineTo(0, r - 8); g.stroke();
      g.beginPath(); g.moveTo(0, -r + 8); g.lineTo(-6, -r + 20); g.lineTo(6, -r + 20); g.closePath();
      g.fillStyle = col; g.fill();
      var dev = Math.max(-1, Math.min(1, nv.deflection));
      g.strokeStyle = col; g.lineWidth = 3;
      g.beginPath(); g.moveTo(dev * r * 0.5, -r * 0.42); g.lineTo(dev * r * 0.5, r * 0.42); g.stroke();
      g.fillStyle = 'rgba(200,215,230,.5)';
      for (var k = -2; k <= 2; k++) {
        if (!k) continue;
        g.beginPath(); g.arc(k * r * 0.25, 0, 2.5, 0, Math.PI * 2); g.fill();
      }
      g.fillStyle = col; g.beginPath();
      var ty = nv.toFrom === 'TO' ? -r * 0.28 : r * 0.28;
      var dir = nv.toFrom === 'TO' ? -1 : 1;
      g.moveTo(0, ty + dir * 9); g.lineTo(-6, ty); g.lineTo(6, ty); g.closePath(); g.fill();
      g.restore();
    }
    g.restore();

    g.fillStyle = '#fff';
    g.beginPath(); g.moveTo(cx, cy - r - 2); g.lineTo(cx - 5, cy - r - 11);
    g.lineTo(cx + 5, cy - r - 11); g.closePath(); g.fill();
    g.font = '600 12px system-ui,sans-serif'; g.textAlign = 'center'; g.fillStyle = '#cfe0f0';
    g.fillText(fmtCrs(hdg) + '°T', cx, cy + r + 17);
  }

  // ---------------------------------------------------------------- side panel

  function renderSide() {
    var nv = C.nav(), s = C.state();
    var seq = $('#seqpanel');
    if (seq) {
      var leg = nv.leg, nxt = nv.next;
      seq.innerHTML =
        '<div class="sq-row"><span>Active leg</span><b>' +
          (leg ? (C.activatedDirect() ? 'direct &#8594; '
                   : (nv.index > 0 ? esc(s.fpl.legs[nv.index - 1].ident || '') + ' &#8594; ' : '')) +
                 esc(leg.ident || legLabel(leg)) : '&mdash;') + '</b></div>' +
        '<div class="sq-row"><span>Leg type</span><b>' + (leg ? esc(leg.pt) +
          (N.isFlyover(leg) ? ' (flyover)'
            : (leg.pt === 'TF' || leg.pt === 'CF' ? ' (fly-by)' : '')) : '&mdash;') + '</b></div>' +
        '<div class="sq-row"><span>Next leg</span><b>' +
          (nxt ? esc(nxt.ident || legLabel(nxt)) : '&mdash;') + '</b></div>' +
        '<div class="sq-row"><span>Sequencing</span><b class="' +
          (s.seq.susp || s.seq.obs ? 'warn' : 'ok') + '">' +
          (s.seq.susp ? 'SUSPENDED' : s.seq.obs ? 'OBS — manual' : 'automatic') + '</b></div>' +
        '<div class="sq-why">' + esc(nv.note || '') + '</div>' +
        '<div class="sq-row"><span>CDI source</span><b class="' +
          (nv.source === 'VLOC' ? 'ok' : '') + '">' + nv.source + '</b></div>' +
        '<div class="sq-row"><span>Identified</span><b class="' +
          (C.navIdentified() ? 'ok' : 'warn') + '">' +
          (C.navIdentified() ? 'yes — ' + esc(s.vloc.decoded) : 'no') + '</b></div>';
    }
    drawHsi();
    renderScenario();
  }

  function renderScenario() {
    var box = $('#scenbox');
    if (!box) return;
    SC.update();
    var p = SC.progress();
    if (!p) { box.innerHTML = '<div class="dim">Free play &mdash; no scenario.</div>'; return; }
    var goals = p.goals.map(function (g) {
      return '<li class="' + (g.done ? 'done' : '') + '">' +
        (g.done ? '&#10003; ' : '') + esc(g.label) + '</li>';
    }).join('');
    var hint = ctx.hintOn && p.next
      ? '<div class="hint"><b>Next</b> ' + esc(p.next.text) + '</div>' : '';
    var hits = p.hits.length
      ? '<div class="misses"><div class="mh">Noticed</div>' + p.hits.map(function (m) {
          return '<div class="miss"><b>' + esc(m.label) + '</b><span>' + esc(m.note) + '</span></div>';
        }).join('') + '</div>' : '';
    box.innerHTML = '<div class="sc-brief">' + esc(p.scenario.brief) + '</div>' +
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
    menu: function () { C.message('Menu is not built in this prototype.'); ACT.msg(); },
    msg: function () {
      var m = C.state().msg;
      alert(m.length ? m.join('\n') : 'No messages.');
    },
    find: function () { ctx.dtoTab = 'nrst'; if (page !== 'dto') go('dto'); else render(); },

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
      // Opening the Nav standby keypad puts the tuning cursor in the Nav window, which
      // is also what points the Volume knob's ident toggle at the Nav receiver.
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

    'wo-activate': function () { C.activateLeg(ctx.wptOptIdx); go('fpl'); },
    'wo-remove': function () { C.removeLeg(ctx.wptOptIdx); go('fpl'); },
    'wo-info': function () {
      var l = C.state().fpl.legs[ctx.wptOptIdx];
      ctx.wptId = l && l.ident; go('wpt');
    },

    'appr-apt': function () {
      var id = prompt('Airport identifier', ctx.apptApt || destIdent() || '');
      if (!id) return;
      id = id.toUpperCase();
      N.loadAirport(id).then(function (a) {
        if (!a) { alert('No coded procedures for ' + id); return; }
        ctx.apptApt = id; ctx.selAppr = null; ctx.selTrans = null; render();
      });
    },
    'appr-pick': function () { go('appr-list'); },
    'appr-trans': function () { if (ctx.selAppr) go('trans-list'); },
    'appr-preview': function () { go('map'); },
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
    s.fpl.approach.freq = nav ? nav.freq : null;
    if (nav) s.fpl.approach.ident = nav.ident;
    C.updateNavDecode();
  }

  function doLoadApproach(activate) {
    var apt = N.airport(ctx.apptApt || destIdent());
    if (!apt || !ctx.selAppr) return;
    var proc = (apt.procs || []).filter(function (p) { return p.id === ctx.selAppr; })[0];
    if (!proc) return;
    var vtf = ctx.selTrans === 'VECTORS';
    if (!C.loadProcedure(apt, proc, vtf ? null : ctx.selTrans, { vtf: vtf })) {
      alert('This approach has no public coding -- chart only.');
      return;
    }
    attachApproachNav(apt, proc);
    if (activate) C.activateApproach();
    go('fpl');
  }

  // ---------------------------------------------------------------- input

  function onClick(e) {
    var t = e.target.closest('[data-act],[data-go],[data-fpl],[data-appr],[data-trans],' +
      '[data-dtow],[data-dtofpl],[data-dtotab],[data-key],[data-com]');
    if (!t || t.classList.contains('off')) return;
    var a;
    if ((a = t.getAttribute('data-act')) && ACT[a]) { ACT[a](); return; }
    if ((a = t.getAttribute('data-go'))) {
      if (a.indexOf('na-') === 0) { C.message('Not built in this prototype.'); ACT.msg(); return; }
      if (a === 'proc-appr') {
        var id = ctx.apptApt || destIdent();
        ctx.apptApt = id;
        go('proc-appr');
        if (id && !N.airport(id)) N.loadAirport(id).then(render);
        return;
      }
      go(a); return;
    }
    if ((a = t.getAttribute('data-fpl')) != null) { ctx.wptOptIdx = +a; go('wptopt'); return; }
    if ((a = t.getAttribute('data-appr'))) {
      ctx.selAppr = a; ctx.selTrans = null; page = 'proc-appr'; stack.pop(); render(); return;
    }
    if ((a = t.getAttribute('data-trans'))) {
      ctx.selTrans = a; page = 'proc-appr'; stack.pop(); render(); return;
    }
    if ((a = t.getAttribute('data-dtotab'))) { ctx.dtoTab = a; render(); return; }
    if ((a = t.getAttribute('data-dtow'))) {
      if (ctx.addMode) { ctx.addMode = false; C.appendWaypoint(a); go('fpl'); }
      else { C.directTo(a); go('nav'); }
      return;
    }
    if ((a = t.getAttribute('data-dtofpl')) != null) {
      var leg = C.state().fpl.legs[+a];
      if (leg) C.directTo(leg.ident);
      go('nav'); return;
    }
    if ((a = t.getAttribute('data-com'))) { C.tuneStandby('COM', parseFloat(a)); render(); return; }
    if ((a = t.getAttribute('data-key'))) { onKeypad(a); return; }
  }

  function onKeypad(k) {
    if (page === 'tune') {
      if (k === 'BKSP') ctx.tuneBuf = (ctx.tuneBuf || '').replace(/\.$/, '').slice(0, -1);
      else if ((ctx.tuneBuf || '').replace('.', '').length < 5) {
        ctx.tuneBuf = (ctx.tuneBuf || '') + k;
        if (ctx.tuneBuf.length === 3) ctx.tuneBuf += '.';
      }
    } else {
      if (k === 'BKSP') ctx.dtoBuf = (ctx.dtoBuf || '').slice(0, -1);
      else if ((ctx.dtoBuf || '').length < 6) ctx.dtoBuf = (ctx.dtoBuf || '') + k;
    }
    render();
  }

  function knob(which, delta) {
    var s = C.state();
    if (page === 'tune') {
      var base = ctx.tuneWhich === 'COM' ? s.com.standby : s.vloc.standby;
      var f = parseFloat(ctx.tuneBuf) || base;
      f += which === 'large' ? delta : delta * (ctx.tuneWhich === 'COM' ? 0.025 : 0.05);
      ctx.tuneBuf = (Math.round(f * 1000) / 1000).toFixed(2);
      render(); return;
    }
    var w = s.com.tuning;
    var cur = w === 'COM' ? s.com.standby : s.vloc.standby;
    var step = which === 'large' ? 1 : (w === 'COM' ? 0.025 : 0.05);
    var lo = w === 'COM' ? 118 : 108, hi = w === 'COM' ? 136.99 : 117.95;
    var v = Math.round((cur + delta * step) * 1000) / 1000;
    if (v < lo) v = hi;
    if (v > hi) v = lo;
    C.tuneStandby(w, v);
    render();
  }

  function knobPress() {
    var s = C.state();
    s.com.tuning = s.com.tuning === 'COM' ? 'NAV' : 'COM';
    C.emit('knob.press', { tuning: s.com.tuning });
    render();
  }
  function knobHold() { C.flipFlop(C.state().com.tuning); render(); }

  function wireKnobs() {
    function ring(el, which) {
      var down = false, lastA = 0, held = null, moved = false;
      el.addEventListener('wheel', function (e) {
        e.preventDefault(); e.stopPropagation();
        knob(which, e.deltaY > 0 ? -1 : 1);
      }, { passive: false });
      el.addEventListener('pointerdown', function (e) {
        e.stopPropagation(); down = true; moved = false;
        var r = el.getBoundingClientRect();
        lastA = Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2));
        el.setPointerCapture(e.pointerId);
        if (which === 'small') {
          held = setTimeout(function () { held = null; knobHold(); moved = true; }, 600);
        }
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
        e.stopPropagation(); down = false;
        if (held) { clearTimeout(held); held = null; if (!moved && which === 'small') knobPress(); }
      });
    }
    ring($('#k-large'), 'large');
    ring($('#k-small'), 'small');
  }

  // ---------------------------------------------------------------- loop

  function tick(ts) {
    raf = requestAnimationFrame(tick);
    var s = C.state();
    var dt = lastT ? Math.min(0.25, (ts - lastT) / 1000) : 0;
    lastT = ts;
    if (s.sim.running) { C.step(dt * s.sim.rate); renderLight(); }
  }

  function toggleRun() {
    var s = C.state();
    s.sim.running = !s.sim.running;
    lastT = 0;
    var b = $('#simrun');
    if (b) b.textContent = s.sim.running ? 'Pause' : 'Fly';
    renderSide();
  }

  // ---------------------------------------------------------------- boot

  function boot(mount) {
    root = mount;
    $('#unitmount', root).innerHTML = bezelHtml();
    screenEl = $('#screen', root);
    scrEl = $('#scr', root);
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
        C.message('Squelch override. With the NAV window active this toggles the ident.');
      }
      render();
    });
    wireKnobs();
    global.addEventListener('resize', function () {
      fitScreen(); if (page === 'map') drawMap(); drawHsi();
    });

    document.addEventListener('keydown', function (e) {
      if (/input|textarea/i.test(e.target.tagName || '')) return;
      if (e.key === 'ArrowUp') { knob('small', 1); e.preventDefault(); }
      else if (e.key === 'ArrowDown') { knob('small', -1); e.preventDefault(); }
      else if (e.key === 'ArrowRight') { knob('large', 1); e.preventDefault(); }
      else if (e.key === 'ArrowLeft') { knob('large', -1); e.preventDefault(); }
      else if (e.key === 'Escape') back();
      else if (e.key === 'h' || e.key === 'H') go('home');
      else if (e.key === ' ') { toggleRun(); e.preventDefault(); }
    });

    return Promise.all([N.loadIndex(), loadFacilities()])
      .then(function () { return SC.load('esn-ils04'); })
      .then(function () { render(); raf = requestAnimationFrame(tick); });
  }

  // Loading a scenario must clear the page context too. Carrying the previous
  // scenario's selected airport into PROC - Approach offered Easton's approaches
  // at Lee, which is worse than an empty page.
  function resetPageCtx() {
    ctx.apptApt = null; ctx.selAppr = null; ctx.selTrans = null;
    ctx.wptOptIdx = null; ctx.wptId = null;
    ctx.dtoBuf = ''; ctx.dtoTab = 'wpt'; ctx.addMode = false;
    ctx.tuneBuf = ''; ctx.tuneWhich = 'COM';
    stack.length = 0;
    page = 'nav';
  }

  global.NTUI = {
    boot: boot, render: render, go: go, toggleRun: toggleRun, resetPageCtx: resetPageCtx,
    setRange: function (r) { ctx.range = r; if (page === 'map') drawMap(); },
    setHints: function (on) { ctx.hintOn = !!on; render(); },
    hintsOn: function () { return !!ctx.hintOn; },
    ctx: ctx, page: function () { return page; }
  };

  global.NAVTRAINER_DEBUG = {
    state: function () { return C.state(); },
    nav: function () { return C.nav(); },
    progress: function () { return SC.progress(); },
    page: function () { return page; },
    go: go, act: function (a) { if (ACT[a]) ACT[a](); },
    ui: function () { return global.NTUI; }
  };
})(window);
