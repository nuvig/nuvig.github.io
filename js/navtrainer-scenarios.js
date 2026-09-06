// GPS/NAV/COM Trainer -- scenarios.
// Unofficial training reference tool, not affiliated with or endorsed by Garmin.
//
// Adding a scenario is one object in SCENARIOS. Shape:
//
//   id      short slug, used in the URL hash
//   title   one line, shown on the picker
//   brief   the clearance, as a controller would give it
//   setup   {fpl:[idents], apt:'KESN', ac:{...}, com:{}, vloc:{}} -- applied on load
//   steps   ordered [{key, text, done(s)}] -- the hint system shows the first not-done
//   goals   [{id, label, done(s)}] -- outcome-checked; all done = scenario complete
//   watch   [{id, label, note, hit(s, saw)}] -- the classic errors, logged as they happen
//
// Grading is by OUTCOME: any route to the goal state passes. `watch` never blocks
// anything -- it only records that a known confusion happened, so the debrief can
// name it. That split is deliberate: students reach the right state by several
// valid paths, but the ways they get lost are few and worth naming.

(function (global) {
  'use strict';

  var N = global.NTNav, C = global.NTCore;

  // Did the event log ever contain this? `m` optionally filters on detail.
  function saw(kind, m) { return sawAt(kind, m) != null; }

  // Sim time at which it first happened, or null.
  function sawAt(kind, m) {
    var ev = C.state().events;
    for (var i = 0; i < ev.length; i++) {
      if (ev[i].kind === kind && (!m || m(ev[i].detail || {}))) return ev[i].simT;
    }
    return null;
  }

  function appr(s) { return s.fpl.approach; }
  function locTuned(s) {
    var a = appr(s);
    return !!(a && a.freq && Math.abs(s.vloc.active - a.freq) < 0.001);
  }
  function locInStandby(s) {
    var a = appr(s);
    return !!(a && a.freq && Math.abs(s.vloc.standby - a.freq) < 0.001);
  }
  function distToFaf(s) {
    var i = C.indexOfRole('FAF');
    if (i < 0) return null;
    var f = s.fpl.legs[i];
    if (!C.legHasFix(f)) return null;
    return N.dist({ lat: s.ac.lat, lon: s.ac.lon }, { lat: f.lat, lon: f.lon });
  }

  var SCENARIOS = [
    // ------------------------------------------------------------------ 1
    {
      id: 'esn-ils04',
      title: 'Vectors to the ILS 04 at Easton',
      airport: 'KESN',
      brief: 'Southwest of RIKME at 3,000. "Cleared to Easton via RIKME, maintain 3,000, ' +
             'expect ILS runway 4." Load and activate the approach, get the localizer tuned ' +
             'and identified, and have the CDI on VLOC before the final approach fix.',
      teaches: 'Load vs activate, transitions, tuning vs identifying, GPS to VLOC capture.',
      setup: function () {
        var rikme = { lat: 38.64186, lon: -76.18875 };
        var p = N.project(rikme, 230, 10);
        return {
          fpl: ['KANP', 'KESN'],
          apt: 'KESN',
          ac: { lat: p.lat, lon: p.lon, alt: 3000, altTarget: 3000, trk: 50, gs: 120 },
          com: { active: 118.35, standby: 122.7 },
          vloc: { active: 110.0, standby: 110.0 }
        };
      },
      steps: [
        { key: 'home', text: 'HOME, then Proc.',
          done: function (s) { return saw('ui.page', function (d) { return d.page === 'proc'; }); } },
        { key: 'proc-appr', text: 'Touch Approach. (Arrival is for STARs -- not this.)',
          done: function (s) { return saw('ui.page', function (d) { return d.page === 'proc-appr'; }); } },
        { key: 'appr-pick', text: 'Pick ILS OR LOC RWY 04, then the RIKME transition.',
          done: function (s) { return !!appr(s); } },
        { key: 'appr-activate', text: 'Load APPR & Activate -- loading alone leaves you routed to the airport.',
          done: function (s) { return !!(appr(s) && appr(s).active); } },
        { key: 'knob', text: 'Press the small knob to move the tuning cursor to the NAV window. ' +
                'The corner legend changes to "Nav Vol / Psh ID" when it is there.',
          done: function (s) { return s.com.tuning === 'NAV' || locInStandby(s) || locTuned(s); } },
        { key: 'nav-tune', text: 'Touch the STBY window and enter the localizer frequency.',
          done: function (s) { return locInStandby(s) || locTuned(s); } },
        { key: 'nav-flip', text: 'Flip it to ACTIVE -- a standby frequency is not being received.',
          done: function (s) { return locTuned(s); } },
        { key: 'nav-ident', text: 'Identify it: press the Volume knob to bring up the Morse ident.',
          done: function (s) { return C.navIdentified(); } },
        { key: 'cdi', text: 'Fly the course. Watch the CDI take VLOC on its own inside 15 nm of the FAF.',
          done: function (s) { return s.cdi.source === 'VLOC'; } }
      ],
      goals: [
        { id: 'loaded', label: 'ILS OR LOC RWY 04 loaded',
          done: function (s) { return !!(appr(s) && appr(s).procId === 'I04'); } },
        { id: 'activated', label: 'Approach activated',
          done: function (s) { return !!(appr(s) && appr(s).active); } },
        { id: 'tuned', label: 'Localizer active in the NAV window',
          done: function (s) { return locTuned(s); } },
        { id: 'idented', label: 'Localizer identified (Morse, not the database lookup)',
          done: function (s) { return C.navIdentified(); } },
        { id: 'vloc', label: 'CDI on VLOC',
          done: function (s) { return s.cdi.source === 'VLOC'; } }
      ],
      watch: [
        { id: 'arrival', label: 'Opened Arrivals looking for the approach',
          note: 'Arrival means STAR. An instrument approach is behind the Approach key on the same page.',
          hit: function () { return saw('ui.page', function (d) { return d.page === 'proc-arr'; }); } },
        { id: 'departure', label: 'Opened Departures looking for the approach',
          note: 'Departure means SID.',
          hit: function () { return saw('ui.page', function (d) { return d.page === 'proc-dep'; }); } },
        { id: 'loadonly', label: 'Loaded the approach but did not activate it',
          note: 'Load puts the approach at the end of the plan and keeps you navigating to the ' +
                'airport first. Load APPR & Activate makes the transition the active leg.',
          hit: function (s) {
            var d = distToFaf(s);
            return !!(appr(s) && !appr(s).active && d != null && d < 15);
          } },
        { id: 'standby', label: 'Localizer left in standby',
          note: 'The standby window is not being received and the CDI will never capture off it. ' +
                'Touch the active window to flip it across.',
          hit: function (s) {
            var d = distToFaf(s);
            return !!(locInStandby(s) && !locTuned(s) && d != null && d < 12);
          } },
        { id: 'noident', label: 'Tuned but never identified',
          note: 'The identifier printed under the standby frequency is a database lookup from GPS ' +
                'position -- it appears whether or not anything is being received. Identification ' +
                'is the Morse the receiver decodes off the ACTIVE frequency, with the ident audio on.',
          hit: function (s) {
            var d = distToFaf(s);
            return !!(locTuned(s) && !C.navIdentified() && d != null && d < 6);
          } },
        { id: 'lateswitch', label: 'Inside 2 nm of the FAF still on GPS',
          note: 'There is no automatic switch inside 2.0 nm of the FAF. From here the CDI key is ' +
                'the only way to VLOC, and the needle you are watching is not the localizer.',
          hit: function (s) {
            var d = distToFaf(s);
            return !!(s.cdi.source === 'GPS' && appr(s) && appr(s).active && d != null && d < 2);
          } }
      ]
    },

    // ------------------------------------------------------------------ 2
    {
      id: 'anp-rnav-a',
      title: 'Full procedure: RNAV (GPS)-A at Lee',
      airport: 'KANP',
      brief: 'Inbound from the east at 3,000. "Cleared direct AMRTN, cleared RNAV-A approach ' +
             'Lee, maintain 3,000 until AMRTN." No radar vectors -- fly the published entry ' +
             'off AMRTN, which is the hold in lieu of a procedure turn.',
      teaches: 'The hold in lieu of a procedure turn, SUSP at the missed approach point, ' +
               'and unsuspending to fly the missed.',
      setup: function () {
        // East of AMRTN, the IAF whose transition carries the hold in lieu of a
        // procedure turn. The GRACO transition is a plain TF to AMRTN and has no hold.
        var amrtn = { lat: 38.88452, lon: -76.33265 };
        var p = N.project(amrtn, 95, 9);
        return {
          fpl: ['KANP'],
          apt: 'KANP',
          ac: { lat: p.lat, lon: p.lon, alt: 3000, altTarget: 3000, trk: 275, gs: 110 },
          com: { active: 119.7, standby: 122.9 },
          vloc: { active: 110.0, standby: 110.0 }
        };
      },
      steps: [
        { key: 'proc-appr', text: 'HOME, Proc, Approach.',
          done: function (s) { return saw('ui.page', function (d) { return d.page === 'proc-appr'; }); } },
        { key: 'appr-pick', text: 'Select RNAV (GPS)-A and the AMRTN transition.',
          done: function (s) { return !!appr(s); } },
        { key: 'appr-activate', text: 'Load APPR & Activate.',
          done: function (s) { return !!(appr(s) && appr(s).active); } },
        { key: 'hilpt', text: 'Fly it. At AMRTN the box flies one circuit of the hold, then continues inbound.',
          done: function (s) { return saw('seq.sequence', function (d) { return d.why === 'hold-complete'; }); } },
        { key: 'map', text: 'At STRGL the box suspends -- it will not sequence into the missed on its own.',
          done: function (s) { return saw('seq.map'); } },
        { key: 'unsusp', text: 'Touch SUSP to unsuspend and fly the missed approach.',
          done: function (s) { return saw('seq.unsuspend', function (d) { return d.wasMap; }); } }
      ],
      goals: [
        { id: 'loaded', label: 'RNAV (GPS)-A loaded',
          done: function (s) { return !!(appr(s) && appr(s).procId === 'RNV-A'); } },
        { id: 'activated', label: 'Approach activated',
          done: function (s) { return !!(appr(s) && appr(s).active); } },
        { id: 'hold', label: 'Hold in lieu of PT flown at AMRTN',
          done: function () { return saw('seq.sequence', function (d) { return d.why === 'hold-complete'; }); } },
        { id: 'susp', label: 'Reached the MAP and saw SUSP',
          done: function () { return saw('seq.map'); } },
        { id: 'missed', label: 'Unsuspended into the missed approach',
          done: function () { return saw('seq.unsuspend', function (d) { return d.wasMap; }); } }
      ],
      watch: [
        { id: 'vtf', label: 'Activated vectors to final on a full procedure',
          note: 'Vectors to final throws away the transition and the hold in lieu of a procedure ' +
                'turn. You were not given vectors -- the clearance was the published entry.',
          hit: function (s) { return !!(appr(s) && appr(s).vtf); } },
        { id: 'graco', label: 'Took the GRACO transition, which has no hold',
          note: 'GRACO is a plain track to AMRTN. The hold in lieu of a procedure turn is coded ' +
                'on the AMRTN transition -- pick that one and the box flies the entry for you.',
          hit: function (s) { return !!(appr(s) && appr(s).trans === 'GRACO'); } },
        { id: 'dtomap', label: 'Direct-to the MAP, skipping the hold',
          note: 'Direct-to a fix inside the procedure cancels the entry you were cleared for. ' +
                'The hold in lieu of a procedure turn is not optional here.',
          hit: function () { return saw('dto.activate', function (d) { return d.ident === 'STRGL'; }); } },
        { id: 'stuck', label: 'Sat suspended at the MAP',
          note: 'SUSP at the missed approach point is the box waiting for you. It will hold the ' +
                'MAP as the active waypoint forever until you unsuspend.',
          // A minute, not an instant: reaching the MAP and unsuspending promptly is
          // the correct answer, and must not be logged as the error it is the fix for.
          hit: function (s) {
            var at = sawAt('seq.map');
            return at != null && !saw('seq.unsuspend') &&
                   s.seq.susp && s.seq.suspReason === 'map' && (s.sim.t - at) > 60;
          } }
      ]
    },

    // ------------------------------------------------------------------ 3
    {
      id: 'reroute',
      title: 'Reroute: direct AMRTN, then rejoin',
      airport: 'KANP',
      brief: 'En route KANP-KESN passing GRACO at 4,000. "Proceed direct AMRTN, then resume ' +
             'own navigation to Easton." Get the direct-to in, then put the flight plan back.',
      teaches: 'Direct-to a flight plan waypoint versus an off-route fix, and rejoining the plan ' +
               'by activating a leg rather than re-entering it.',
      setup: function () {
        var graco = { lat: 38.94161, lon: -76.19978 };
        return {
          fpl: ['KANP', 'GRACO', 'KESN'],
          apt: 'KANP',
          ac: { lat: graco.lat, lon: graco.lon, alt: 4000, altTarget: 4000, trk: 120, gs: 130 },
          com: { active: 119.7, standby: 122.7 },
          vloc: { active: 110.0, standby: 110.0 }
        };
      },
      steps: [
        { key: 'dto', text: 'Press the Direct-To key.',
          done: function (s) { return saw('ui.page', function (d) { return d.page === 'dto'; }); } },
        { key: 'dto-enter', text: 'Enter AMRTN and activate.',
          done: function () { return saw('dto.activate', function (d) { return d.ident === 'AMRTN'; }); } },
        { key: 'rejoin', text: 'Now rejoin: open the flight plan and activate the leg to KESN.',
          done: function (s) {
            return saw('fpl.activateLeg', function (d) { return d.ident === 'KESN'; });
          } }
      ],
      goals: [
        { id: 'direct', label: 'Direct-to AMRTN activated',
          done: function () { return saw('dto.activate', function (d) { return d.ident === 'AMRTN'; }); } },
        { id: 'rejoined', label: 'Flight plan leg to KESN made active',
          done: function () { return saw('fpl.activateLeg', function (d) { return d.ident === 'KESN'; }); } }
      ],
      watch: [
        { id: 'retype', label: 'Re-entered KESN instead of activating the leg',
          note: 'KESN was already in the plan. Re-entering it builds a second copy; touching the ' +
                'existing leg and activating it keeps one flight plan.',
          hit: function (s) {
            var n = 0;
            s.fpl.legs.forEach(function (l) { if (l.ident === 'KESN') n++; });
            return n > 1;
          } },
        { id: 'obsleft', label: 'Left OBS on',
          note: 'OBS holds the active waypoint and stops sequencing. With it on, the reroute will ' +
                'never sequence to the next leg.',
          hit: function (s) { return !!s.seq.obs; } }
      ]
    }
  ];

  // ---------------------------------------------------------------- runner

  var current = null, hits = Object.create(null), met = Object.create(null);

  function byId(id) {
    return SCENARIOS.filter(function (s) { return s.id === id; })[0] || null;
  }

  function load(id) {
    var sc = byId(id);
    C.reset();
    hits = Object.create(null);
    met = Object.create(null);
    current = sc;
    if (!sc) return Promise.resolve(null);

    var cfg = sc.setup();
    return N.loadAirport(cfg.apt).then(function () {
      // Waypoints referenced by the plan may live in another airport's procedures.
      var need = (cfg.fpl || []).filter(function (id2) { return !N.waypoint(id2); });
      return Promise.all(need.map(function (id2) { return N.loadAirport(id2); }));
    }).then(function () {
      var s = C.state();
      C.setFlightPlan(cfg.fpl || []);
      Object.keys(cfg.ac || {}).forEach(function (k) { s.ac[k] = cfg.ac[k]; });
      Object.keys(cfg.com || {}).forEach(function (k) { s.com[k] = cfg.com[k]; });
      Object.keys(cfg.vloc || {}).forEach(function (k) { s.vloc[k] = cfg.vloc[k]; });
      s.events.length = 0;
      C.emit('scenario.load', { id: sc.id });
      return sc;
    });
  }

  // Called every tick: latches any watch item that has fired.
  function update() {
    if (!current) return;
    var s = C.state();
    (current.watch || []).forEach(function (w) {
      if (hits[w.id]) return;
      var fired = false;
      try { fired = !!w.hit(s, saw); } catch (e) { fired = false; }
      if (fired) {
        hits[w.id] = { at: s.sim.t, label: w.label, note: w.note };
        C.emit('scenario.watch', { id: w.id, label: w.label });
      }
    });
  }

  function progress() {
    if (!current) return null;
    var s = C.state();
    function safe(fn) { try { return !!fn(s); } catch (e) { return false; } }
    // Goals latch. Outcome-checked means "did the student ever reach this state",
    // not "are they still in it" -- flying past the localizer must not un-identify it.
    var goals = (current.goals || []).map(function (g) {
      if (safe(g.done)) met[g.id] = true;
      return { id: g.id, label: g.label, done: !!met[g.id] };
    });
    var steps = (current.steps || []).map(function (st) {
      return { key: st.key, text: st.text, done: safe(st.done) };
    });
    var nextStep = steps.filter(function (st) { return !st.done; })[0] || null;
    return {
      scenario: current,
      goals: goals,
      complete: goals.length > 0 && goals.every(function (g) { return g.done; }),
      steps: steps,
      next: nextStep,
      hits: Object.keys(hits).map(function (k) {
        return { id: k, label: hits[k].label, note: hits[k].note, at: hits[k].at };
      })
    };
  }

  global.NTScenarios = {
    all: SCENARIOS, byId: byId, load: load, update: update, progress: progress,
    current: function () { return current; },
    clear: function () { current = null; hits = Object.create(null); met = Object.create(null); }
  };
})(window);
