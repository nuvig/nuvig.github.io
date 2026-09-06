// GPS Sequencing -- the demonstrations each section drives.
// Unofficial training reference, not affiliated with or endorsed by Garmin.
//
// A demo is one object: it puts the navigator into the state a section is about
// and lets the reader fly out of it. Adding one is a single entry in DEMOS.
//
//   id       slug, used by the section buttons and the URL hash
//   label    button text
//   note     one line under the demo, saying what to watch
//   run()    async; loads the airport, builds the plan, positions the aircraft
//
// Helpers below do the repetitive part: load an approach at a field, put the
// aircraft a given distance out on a given bearing from one of its fixes.

(function (global) {
  'use strict';

  var N = global.SeqNav, C = global.SeqCore;

  // ---------------------------------------------------------------- helpers

  function fixOf(legs, ident) {
    for (var i = 0; i < legs.length; i++) if (legs[i].ident === ident) return legs[i];
    return null;
  }

  // Load an approach and optionally activate it. Returns the airport record.
  function approach(aptId, procId, transName, opts) {
    opts = opts || {};
    return N.loadAirport(aptId).then(function (apt) {
      if (!apt) return null;
      var proc = (apt.procs || []).filter(function (p) { return p.id === procId; })[0];
      if (!proc) return null;
      C.loadProcedure(apt, proc, transName, { vtf: !!opts.vtf });
      var s = C.state();
      if (s.fpl.approach) {
        var nav = navFor(aptId, procId);
        s.fpl.approach.freq = nav ? nav.freq : null;
        if (nav) s.fpl.approach.ident = nav.ident;
      }
      if (opts.activate) C.activateApproach();
      return apt;
    });
  }

  var FAC = null;
  function loadFacilities() {
    if (FAC) return Promise.resolve(FAC);
    return fetch('data/sequencing/facilities.json')
      .then(function (r) { return r.json(); })
      .then(function (j) { FAC = j; return j; })
      .catch(function () { FAC = { airports: {} }; return FAC; });
  }
  function navFor(aptId, procId) {
    if (!FAC) return null;
    var a = FAC.airports[aptId];
    if (!a) return null;
    var want = (a.proc || {})[procId];
    return want ? (a.nav || []).filter(function (n) { return n.ident === want; })[0] || null : null;
  }
  global.SeqFacilities = { load: loadFacilities, navFor: navFor, all: function () { return FAC; } };

  // Put the aircraft `d` nm from a fix on a given bearing FROM it, tracking inbound.
  function placeFrom(fix, brgFromFix, d, alt, gs) {
    var s = C.state();
    var p = N.project({ lat: fix.lat, lon: fix.lon }, brgFromFix, d);
    s.ac.lat = p.lat; s.ac.lon = p.lon;
    s.ac.alt = alt; s.ac.altTarget = alt;
    s.ac.gs = gs || 120;
    s.ac.trk = N.bearing(p, { lat: fix.lat, lon: fix.lon });
  }

  // Make a leg the active one and fly it from where the aeroplane now is.
  function activateFix(ident) {
    var legs = C.state().fpl.legs;
    for (var i = 0; i < legs.length; i++) {
      if (legs[i].ident === ident) { C.activateLeg(i); return i; }
    }
    return -1;
  }

  function reset() {
    C.reset();
    C.state().sim.running = false;
  }

  // ---------------------------------------------------------------- demos

  var DEMOS = [
    // ---- 1. load vs activate ------------------------------------------
    {
      id: 'load-only',
      label: 'Load only',
      note: 'The approach is in the plan, but the active leg is still the airport. ' +
            'Fly and you go to KESN first, then back out to RIKME.',
      run: function () {
        reset();
        return N.loadAirport('KANP').then(function () {
          C.setFlightPlan(['KANP', 'KESN']);
          return approach('KESN', 'I04', 'RIKME', { activate: false });
        }).then(function () {
          var f = fixOf(C.state().fpl.legs, 'RIKME');
          if (f) placeFrom(f, 230, 10, 3000, 120);
          activateFix('KESN');
        });
      }
    },
    {
      id: 'load-activate',
      label: 'Load and activate',
      note: 'Same approach, activated. The active leg is now direct to RIKME and ' +
            'the airport is no longer in front of you.',
      run: function () {
        reset();
        return N.loadAirport('KANP').then(function () {
          C.setFlightPlan(['KANP', 'KESN']);
          return approach('KESN', 'I04', 'RIKME', { activate: true });
        }).then(function () {
          var f = fixOf(C.state().fpl.legs, 'RIKME');
          if (f) placeFrom(f, 230, 10, 3000, 120);
          C.activateApproach();
        });
      }
    },

    // ---- 2. fly-by and flyover ----------------------------------------
    {
      id: 'flyby',
      label: 'Approach a fly-by fix',
      note: 'AMRTN turns about 50 degrees onto the next leg. The amber ring is where the ' +
            'turn starts -- the box sequences there, not over the fix.',
      run: function () {
        reset();
        return N.loadAirport('KANP').then(function () {
          C.setFlightPlan(['KANP']);
          return approach('KANP', 'RNV-A', 'GRACO', { activate: true });
        }).then(function () {
          var f = fixOf(C.state().fpl.legs, 'AMRTN');
          if (f) placeFrom(f, 60, 6, 3000, 130);
          activateFix('AMRTN');
        });
      }
    },
    {
      id: 'flyover',
      label: 'Approach a flyover fix',
      note: 'ORETE, on the missed approach, is coded flyover. No anticipation at all -- ' +
            'the leg stays active until the aircraft is past the fix.',
      run: function () {
        reset();
        return N.loadAirport('KESN').then(function () {
          C.setFlightPlan(['KESN']);
          return approach('KESN', 'I04', 'RIKME', { activate: true });
        }).then(function () {
          var f = fixOf(C.state().fpl.legs, 'ORETE');
          if (f) placeFrom(f, 283, 5, 2000, 130);
          activateFix('ORETE');
        });
      }
    },

    // ---- 3. SUSP -------------------------------------------------------
    {
      id: 'susp-map',
      label: 'Fly to the missed approach point',
      note: 'At STRGL the box suspends instead of sequencing. The active waypoint stays ' +
            'the MAP however far past it you fly. Nothing happens until you unsuspend.',
      run: function () {
        reset();
        return N.loadAirport('KANP').then(function () {
          C.setFlightPlan(['KANP']);
          return approach('KANP', 'RNV-A', 'AMRTN', { activate: true });
        }).then(function () {
          var f = fixOf(C.state().fpl.legs, 'STRGL');
          if (f) placeFrom(f, 233 + 180, 2.5, 1000, 110);
          activateFix('STRGL');
        });
      }
    },
    {
      id: 'susp-hold',
      label: 'Fly the hold in lieu of a procedure turn',
      note: 'AMRTN is coded as a hold. The box flies one circuit and then continues ' +
            'inbound on its own -- this one does not need unsuspending.',
      run: function () {
        reset();
        return N.loadAirport('KANP').then(function () {
          C.setFlightPlan(['KANP']);
          return approach('KANP', 'RNV-A', 'AMRTN', { activate: true });
        }).then(function () {
          var f = fixOf(C.state().fpl.legs, 'AMRTN');
          if (f) placeFrom(f, 95, 6, 2000, 110);
        });
      }
    },

    // ---- 4. OBS --------------------------------------------------------
    {
      id: 'obs',
      label: 'Turn OBS on',
      note: 'OBS holds AMRTN as the active waypoint and stops sequencing. Fly past it ' +
            'and the box still points at it. The course is yours to set, not the plan’s.',
      run: function () {
        reset();
        return Promise.all([N.loadAirport('KANP'), N.loadAirport('KESN')]).then(function () {
          C.setFlightPlan(['KANP', 'AMRTN', 'KESN']);
          var f = fixOf(C.state().fpl.legs, 'AMRTN');
          if (f) placeFrom(f, 300, 7, 4000, 130);
          activateFix('AMRTN');
          C.pressObsSusp(120);
        });
      }
    },

    // ---- 5. GPS to VLOC -------------------------------------------------
    {
      id: 'vloc-auto',
      label: 'Watch it switch',
      note: 'Localizer active and identified, lined up on the final approach course, ' +
            '16 nm from the FAF. The switch happens on its own once inside 15.',
      run: function () {
        reset();
        return loadFacilities().then(function () {
          return N.loadAirport('KESN');
        }).then(function () {
          C.setFlightPlan(['KESN']);
          return approach('KESN', 'I04', 'RIKME', { activate: true });
        }).then(function () {
          var s = C.state();
          var faf = fixOf(s.fpl.legs, 'WEGRO');
          if (faf) placeFrom(faf, 221, 16, 3000, 130);
          activateFix('WEGRO');
          if (s.fpl.approach && s.fpl.approach.freq) {
            s.vloc.active = s.fpl.approach.freq;
            s.vloc.standby = 110.0;
            s.vloc.identOn = true;
            s.com.tuning = 'NAV';
            C.updateNavDecode();
          }
        });
      }
    },
    {
      id: 'vloc-late',
      label: 'Start inside 2 nm',
      note: 'Same setup, but joining 1.5 nm from the FAF. There is no automatic switch ' +
            'this close -- the CDI stays on GPS until you press it yourself.',
      run: function () {
        reset();
        return loadFacilities().then(function () {
          return N.loadAirport('KESN');
        }).then(function () {
          C.setFlightPlan(['KESN']);
          return approach('KESN', 'I04', 'RIKME', { activate: true });
        }).then(function () {
          var s = C.state();
          var faf = fixOf(s.fpl.legs, 'WEGRO');
          if (faf) placeFrom(faf, 221, 1.5, 1700, 110);
          activateFix('WEGRO');
          if (s.fpl.approach && s.fpl.approach.freq) {
            s.vloc.active = s.fpl.approach.freq;
            s.vloc.standby = 110.0;
            s.vloc.identOn = true;
            s.com.tuning = 'NAV';
            C.updateNavDecode();
          }
        });
      }
    },

    // ---- 6. tuned is not identified -------------------------------------
    {
      id: 'ident-standby',
      label: 'In standby',
      note: 'The localizer is in the standby window. The navigator prints its name from ' +
            'the database anyway. Nothing is being received.',
      run: function () { return identState('standby'); }
    },
    {
      id: 'ident-active',
      label: 'Made active',
      note: 'Now in the active window and the receiver is decoding its Morse. Still not ' +
            'identified: the ident audio is off, so nobody has checked it.',
      run: function () { return identState('active'); }
    },
    {
      id: 'ident-on',
      label: 'Ident on',
      note: 'Ident audio on, Morse decoding off the active frequency. This is the only ' +
            'one of the three that counts as having identified the facility.',
      run: function () { return identState('ident'); }
    }
  ];

  function identState(stage) {
    reset();
    return loadFacilities().then(function () {
      return N.loadAirport('KESN');
    }).then(function () {
      C.setFlightPlan(['KESN']);
      return approach('KESN', 'I04', 'RIKME', { activate: true });
    }).then(function () {
      var s = C.state();
      var faf = fixOf(s.fpl.legs, 'WEGRO');
      if (faf) placeFrom(faf, 221, 8, 2500, 120);
      activateFix('WEGRO');
      s.com.tuning = 'NAV';
      var f = s.fpl.approach && s.fpl.approach.freq;
      if (!f) return;
      if (stage === 'standby') {
        s.vloc.standby = f; s.vloc.active = 110.0; s.vloc.identOn = false;
      } else {
        s.vloc.active = f; s.vloc.standby = 110.0;
        s.vloc.identOn = (stage === 'ident');
      }
      s.vloc.rflStandby = null;
      C.updateNavDecode();
    });
  }

  function byId(id) {
    return DEMOS.filter(function (d) { return d.id === id; })[0] || null;
  }

  // ---------------------------------------------------------------- live watch
  //
  // The classic errors, as a live annunciator rather than a grade. In an explainer
  // there is no task to fail, but these states are exactly what a student cannot
  // see on the real box, so the panel names them whenever they are true.

  function watches() {
    var s = C.state(), out = [];
    var a = s.fpl.approach;
    var faf = C.indexOfRole('FAF');
    var dFaf = null;
    if (faf >= 0 && C.legHasFix(s.fpl.legs[faf])) {
      dFaf = N.dist({ lat: s.ac.lat, lon: s.ac.lon },
                    { lat: s.fpl.legs[faf].lat, lon: s.fpl.legs[faf].lon });
    }
    if (a && !a.active) {
      out.push('Approach loaded, not activated — the active leg is still ' +
        ((s.fpl.legs[s.fpl.active] || {}).ident || 'the plan'));
    }
    if (a && a.freq && Math.abs(s.vloc.standby - a.freq) < 0.001 &&
        Math.abs(s.vloc.active - a.freq) > 0.001) {
      out.push('Localizer is in standby — it is not being received, and the CDI cannot capture off it');
    }
    if (a && a.freq && Math.abs(s.vloc.active - a.freq) < 0.001 && !C.navIdentified()) {
      out.push('Tuned but not identified — the name under the frequency is a database lookup');
    }
    if (a && a.active && s.cdi.source === 'GPS' && dFaf != null && dFaf < 2 &&
        (a.kind === 'ILS' || a.kind === 'LOC' || a.kind === 'LDA' || a.kind === 'SDF')) {
      out.push('Inside 2 nm of the FAF still on GPS — no automatic switch from here');
    }
    if (s.seq.obs) {
      out.push('OBS on — the box will not sequence to the next leg');
    }
    return out;
  }

  global.SeqDemos = {
    all: DEMOS, byId: byId, watches: watches,
    run: function (id) {
      var d = byId(id);
      return d ? Promise.resolve(d.run()).then(function () { return d; }) : Promise.resolve(null);
    }
  };
})(window);
