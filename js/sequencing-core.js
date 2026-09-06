// GPS/NAV/COM Trainer -- unit state, sequencing, CDI source and radios.
// Unofficial training reference tool, not affiliated with or endorsed by Garmin.
//
// This is the part that has to be RIGHT: the trainer exists to teach what the box
// thinks the active leg is and why it is about to sequence. Everything the screen
// draws is derived from this state, never stored twice.
//
// Behaviour follows the unit's published logic:
//   - auto sequencing suspends at the MAP, in holds, and on altitude-terminated legs
//   - OBS retains the active-to waypoint and stops sequencing; on legs that cannot
//     take an OBS course the same key is SUSP / unsuspend
//   - the CDI switches GPS -> VLOC automatically only when the approach is active,
//     the correct localizer frequency is ACTIVE (not standby), the aircraft is within
//     1.2 nm of the final approach course, and it is 2.0-15.0 nm from the FAF.
//     Inside 2.0 nm there is no automatic switch -- the pilot must touch CDI.

(function (global) {
  'use strict';

  var N = global.SeqNav;

  // ---------------------------------------------------------------- state

  function freshState() {
    return {
      sim: { running: false, rate: 1, t: 0 },
      ac: {
        lat: 38.64, lon: -76.19, alt: 3000, trk: 40, gs: 120,
        altTarget: 3000, vs: 500, ap: true
      },
      fpl: {
        legs: [],                // SeqNav leg objects, in order
        active: -1,              // index of the leg being flown TO
        origin: null,            // FROM point for the leg named by originIdx
        originIdx: -1,
        dtoIdent: null,          // non-null while a direct-to is active
        dtoCourse: null,
        approach: null,          // {aptId, procId, name, trans, vtf, kind, ident, freq}
        arrival: null, departure: null,
        loadedNotActivated: false
      },
      seq: {
        susp: false,             // automatic sequencing suspended
        suspReason: null,        // 'map' | 'hold' | 'altleg' | 'vtf' | 'manual'
        obs: false, obsCourse: null,
        holdCircuits: 0,
        holdPhase: null,         // null | 'toFix' | index into holdTargets
        holdTargets: null,
        holdD: null,
        armedNote: null          // why the box is about to sequence, for the visualiser
      },
      cdi: { source: 'GPS', ilsCapture: 'AUTO', autoArmed: false, autoSwitched: false },
      com: { active: 121.5, standby: 118.0, tuning: 'COM' },
      vloc: {
        active: 110.0, standby: 110.0,
        identOn: false,          // audible Morse ident enabled (Volume knob press)
        decoded: null,           // ident decoded from the received signal, active freq only
        rflStandby: null         // reverse-frequency-lookup ident: DATABASE, not identification
      },
      events: [],                // ordered log the scenario engine reads
      msg: []
    };
  }

  var S = freshState();

  function reset() { S = freshState(); emit('reset'); return S; }
  function state() { return S; }

  function emit(kind, detail) {
    S.events.push({ kind: kind, detail: detail || null, t: Date.now(), simT: S.sim.t });
    if (S.events.length > 500) S.events.shift();
    if (global.NTTrainer && global.NTTrainer.onEvent) global.NTTrainer.onEvent(kind, detail);
  }

  function message(text) {
    if (S.msg.indexOf(text) < 0) S.msg.push(text);
  }

  // ---------------------------------------------------------------- helpers

  function pos() { return { lat: S.ac.lat, lon: S.ac.lon }; }
  function legs() { return S.fpl.legs; }
  function activeLeg() { return S.fpl.legs[S.fpl.active] || null; }
  function nextLeg() { return S.fpl.legs[S.fpl.active + 1] || null; }

  // The point the active leg is flown FROM. `origin` belongs to one specific leg
  // (`originIdx`): activating a leg or a direct-to fixes the course from where the
  // aircraft was at that moment, which is not the same as the previous fix. Using
  // the previous fix regardless sent an activated approach off down the inbound
  // line away from the transition waypoint.
  function legOrigin(i) {
    if (i == null) i = S.fpl.active;
    if (S.fpl.origin && S.fpl.originIdx === i &&
        S.fpl.origin.lat != null && S.fpl.origin.lon != null) return S.fpl.origin;
    if (i <= 0) return S.fpl.origin || pos();
    var prev = S.fpl.legs[i - 1];
    if (prev && prev.lat != null) return { lat: prev.lat, lon: prev.lon };
    return S.fpl.origin || pos();
  }

  function setOrigin(p, i) { S.fpl.origin = p; S.fpl.originIdx = i; }

  function legHasFix(leg) { return leg && leg.lat != null && leg.lon != null; }

  // True when the active leg is flown from a captured position rather than from the
  // preceding fix -- a direct-to, or an approach activated to its transition waypoint.
  // The screen must not label such a leg "PREVFIX -> fix"; that is not the course.
  function activatedDirect() {
    var i = S.fpl.active;
    if (i < 0 || S.fpl.originIdx !== i || !S.fpl.origin) return false;
    if (i === 0) return true;
    var prev = S.fpl.legs[i - 1];
    if (!legHasFix(prev)) return true;
    return N.dist(S.fpl.origin, { lat: prev.lat, lon: prev.lon }) > 0.1;
  }

  // Desired track for the active leg.
  function desiredTrack() {
    var leg = activeLeg();
    if (!leg) return null;
    if (S.seq.obs && S.seq.obsCourse != null) return S.seq.obsCourse;
    if (S.fpl.dtoIdent && S.fpl.dtoCourse != null) return S.fpl.dtoCourse;
    if (leg.pt === 'CF' || leg.pt === 'CA' || leg.pt === 'VA' || leg.pt === 'VI' ||
        leg.pt === 'VM' || leg.pt === 'FM' || leg.pt === 'CI') {
      if (leg.course != null) return leg.course;
    }
    // In a hold, steer round the racetrack rather than at the fix.
    if (N.isHold(leg) && S.seq.holdPhase != null && S.seq.holdPhase !== 'toFix' && S.seq.holdTargets) {
      var tgt = S.seq.holdTargets[S.seq.holdPhase];
      if (tgt) return N.bearing(pos(), tgt);
    }
    if (legHasFix(leg)) {
      var o = legOrigin();
      if (N.dist(o, { lat: leg.lat, lon: leg.lon }) < 0.05) return leg.course != null ? leg.course : S.ac.trk;
      return N.bearing(o, { lat: leg.lat, lon: leg.lon });
    }
    return leg.course != null ? leg.course : S.ac.trk;
  }

  // Cross-track error, nm, positive right of course.
  function crossTrack() {
    var leg = activeLeg();
    if (!leg) return 0;
    var dtk = desiredTrack();
    if (dtk == null) return 0;
    if (S.seq.obs || !legHasFix(leg)) {
      // Course through the reference fix (OBS) or an open-ended vector leg.
      var ref = legHasFix(leg) ? { lat: leg.lat, lon: leg.lon } : legOrigin();
      var back = N.project(ref, N.norm360(dtk + 180), 50);
      return N.crossTrack(pos(), back, ref);
    }
    return N.crossTrack(pos(), legOrigin(), { lat: leg.lat, lon: leg.lon });
  }

  function distToActive() {
    var leg = activeLeg();
    if (!legHasFix(leg)) return null;
    return N.dist(pos(), { lat: leg.lat, lon: leg.lon });
  }

  function bearingToActive() {
    var leg = activeLeg();
    if (!legHasFix(leg)) return null;
    return N.bearing(pos(), { lat: leg.lat, lon: leg.lon });
  }

  // TO/FROM: FROM once past the perpendicular at the reference fix.
  function toFrom() {
    var leg = activeLeg();
    if (!legHasFix(leg)) return 'TO';
    var dtk = desiredTrack();
    var b = N.bearing(pos(), { lat: leg.lat, lon: leg.lon });
    return Math.abs(N.norm180(b - dtk)) <= 90 ? 'TO' : 'FROM';
  }

  function indexOfRole(role) {
    for (var i = 0; i < S.fpl.legs.length; i++) if (S.fpl.legs[i].role === role) return i;
    return -1;
  }

  // ---------------------------------------------------------------- flight plan

  function setFlightPlan(idents) {
    S.fpl.legs = [];
    (idents || []).forEach(function (id) { appendWaypoint(id); });
    S.fpl.active = S.fpl.legs.length > 1 ? 1 : (S.fpl.legs.length ? 0 : -1);
    setOrigin(S.fpl.legs.length ? { lat: S.fpl.legs[0].lat, lon: S.fpl.legs[0].lon } : null,
              S.fpl.active);
    emit('fpl.set', { idents: idents });
  }

  function appendWaypoint(ident, at) {
    var w = N.waypoint(ident);
    if (!w) { message('Waypoint not found: ' + ident); emit('fpl.badWaypoint', ident); return false; }
    var leg = {
      ident: w.ident, lat: w.lat, lon: w.lon, pt: 'TF', turn: null,
      altDesc: null, alt1: null, alt2: null, spd: null, course: null, dist: null,
      va: null, flags: 0, recNav: null, center: null, seg: 'enroute', role: null, disco: false
    };
    if (at == null || at >= S.fpl.legs.length) S.fpl.legs.push(leg);
    else S.fpl.legs.splice(at, 0, leg);
    emit('fpl.add', { ident: w.ident, at: at });
    return true;
  }

  function removeLeg(i) {
    if (i < 0 || i >= S.fpl.legs.length) return;
    var gone = S.fpl.legs.splice(i, 1)[0];
    if (S.fpl.active > i) S.fpl.active--;
    else if (S.fpl.active === i) S.fpl.active = Math.min(S.fpl.active, S.fpl.legs.length - 1);
    emit('fpl.remove', { ident: gone.ident });
  }

  function clearFlightPlan() {
    S.fpl.legs = []; S.fpl.active = -1; S.fpl.approach = null;
    S.fpl.arrival = null; S.fpl.departure = null; S.fpl.loadedNotActivated = false;
    S.seq.susp = false; S.seq.suspReason = null;
    emit('fpl.clear');
  }

  // Activate a leg already in the plan (touch a waypoint, Activate Leg).
  function activateLeg(i) {
    if (i < 0 || i >= S.fpl.legs.length) return;
    S.fpl.active = i;
    S.fpl.dtoIdent = null; S.fpl.dtoCourse = null;
    var prev = i > 0 ? S.fpl.legs[i - 1] : null;
    setOrigin(legHasFix(prev) ? { lat: prev.lat, lon: prev.lon } : pos(), i);
    clearSusp();
    emit('fpl.activateLeg', { index: i, ident: S.fpl.legs[i].ident });
  }

  // ---------------------------------------------------------------- direct-to

  function directTo(ident, course) {
    var w = N.waypoint(ident);
    if (!w) { message('Waypoint not found: ' + ident); emit('dto.bad', ident); return false; }
    var at = -1, i;
    for (i = 0; i < S.fpl.legs.length; i++) {
      if (S.fpl.legs[i].ident === w.ident) { at = i; break; }
    }
    if (at >= 0) {
      // Direct-to a flight plan waypoint keeps the rest of the plan behind it.
      S.fpl.active = at;
    } else {
      S.fpl.legs.splice(Math.max(0, S.fpl.active), 0, {
        ident: w.ident, lat: w.lat, lon: w.lon, pt: 'DF', turn: null,
        altDesc: null, alt1: null, alt2: null, spd: null, course: null, dist: null,
        va: null, flags: 0, recNav: null, center: null, seg: 'enroute',
        role: null, disco: false
      });
      S.fpl.active = Math.max(0, S.fpl.active);
    }
    setOrigin(pos(), S.fpl.active);
    S.fpl.dtoIdent = w.ident;
    S.fpl.dtoCourse = course != null ? course : null;
    clearSusp();
    if (S.seq.obs) { S.seq.obs = false; S.seq.obsCourse = null; }
    emit('dto.activate', { ident: w.ident, course: course != null ? course : null });
    return true;
  }

  function cancelDirectTo() {
    if (!S.fpl.dtoIdent) return;
    S.fpl.dtoIdent = null; S.fpl.dtoCourse = null;
    emit('dto.cancel');
  }

  // ---------------------------------------------------------------- procedures

  // Load a procedure into the plan without making it the active leg.
  function loadProcedure(apt, proc, transName, opts) {
    opts = opts || {};
    var newLegs = N.procedureLegs(apt, proc, transName, opts);
    if (!newLegs.length) { message('No coded legs for ' + (proc.name || proc.id)); return false; }

    if (proc.type === 'APP') {
      // Only one approach at a time; a new one replaces the old.
      S.fpl.legs = S.fpl.legs.filter(function (l) { return l.seg !== 'appr' && l.seg !== 'missed'; });
      // The destination airport stays in the plan ahead of the procedure
      // (v6.50+ behaviour) -- loading, not activating, means you fly to the
      // airport first unless you activate. That is the trap this teaches.
      S.fpl.legs = S.fpl.legs.concat(newLegs);
      S.fpl.approach = {
        aptId: apt.id, procId: proc.id, name: proc.name || proc.id,
        trans: opts.vtf ? 'VECTORS' : (transName || null),
        vtf: !!opts.vtf, kind: approachKind(proc),
        ident: locIdent(proc), freq: null, active: false
      };
      S.fpl.loadedNotActivated = true;
      emit('proc.load', { type: 'APP', proc: proc.id, name: S.fpl.approach.name,
                          trans: S.fpl.approach.trans, vtf: !!opts.vtf });
    } else if (proc.type === 'STAR') {
      S.fpl.legs = S.fpl.legs.filter(function (l) { return l.seg !== 'star'; });
      var apprAt = S.fpl.legs.findIndex(function (l) { return l.seg === 'appr'; });
      if (apprAt < 0) S.fpl.legs = S.fpl.legs.concat(newLegs);
      else S.fpl.legs.splice.apply(S.fpl.legs, [apprAt, 0].concat(newLegs));
      S.fpl.arrival = { procId: proc.id, name: proc.name || proc.id, trans: transName || null };
      emit('proc.load', { type: 'STAR', proc: proc.id, name: S.fpl.arrival.name });
    } else {
      S.fpl.legs = S.fpl.legs.filter(function (l) { return l.seg !== 'dep'; });
      S.fpl.legs = newLegs.concat(S.fpl.legs);
      S.fpl.departure = { procId: proc.id, name: proc.name || proc.id, trans: transName || null };
      emit('proc.load', { type: 'SID', proc: proc.id, name: S.fpl.departure.name });
    }
    if (S.fpl.active < 0 && S.fpl.legs.length) S.fpl.active = 0;
    return true;
  }

  // Load + activate: the active leg becomes direct to the transition waypoint,
  // or for a vectors approach the extended final approach course.
  function activateApproach() {
    if (!S.fpl.approach) return false;
    var first = -1, i;
    for (i = 0; i < S.fpl.legs.length; i++) {
      if (S.fpl.legs[i].seg === 'appr') { first = i; break; }
    }
    if (first < 0) return false;
    S.fpl.approach.active = true;
    S.fpl.loadedNotActivated = false;

    if (S.fpl.approach.vtf) {
      // VTF activates the final course to the FAF. Per the guide, if this happens
      // on the FROM side of the FAF sequencing suspends until the aircraft is on
      // the TO side and within full-scale deflection.
      var faf = indexOfRole('FAF');
      S.fpl.active = faf >= 0 ? faf : first;
      var leg = S.fpl.legs[S.fpl.active];
      setOrigin(N.project({ lat: leg.lat, lon: leg.lon },
                          N.norm360((leg.course != null ? leg.course : 0) + 180), 30), S.fpl.active);
      if (toFrom() === 'FROM') setSusp(true, 'vtf');
      else clearSusp();
    } else {
      S.fpl.active = first;
      setOrigin(pos(), first);
      clearSusp();
    }
    S.fpl.dtoIdent = null; S.fpl.dtoCourse = null;
    emit('proc.activate', { proc: S.fpl.approach.procId, vtf: S.fpl.approach.vtf });
    return true;
  }

  function approachKind(proc) {
    var n = (proc.name || proc.id || '').toUpperCase();
    if (/\bILS\b/.test(n)) return 'ILS';
    if (/\bLOC\s*BC\b|BACKCOURSE/.test(n)) return 'LOCBC';
    if (/\bLOC\b/.test(n)) return 'LOC';
    if (/\bLDA\b/.test(n)) return 'LDA';
    if (/\bSDF\b/.test(n)) return 'SDF';
    if (/\bVOR\b/.test(n)) return 'VOR';
    if (/RNAV|GPS|RNP/.test(n)) return 'RNAV';
    return 'OTHER';
  }

  // The localizer ident is real data: it is the recommended navaid on the final legs.
  function locIdent(proc) {
    var f = (proc.trans || []).filter(function (t) { return t.k === 'final'; })[0];
    if (!f) return null;
    for (var i = 0; i < f.legs.length; i++) {
      var rn = f.legs[i][13];
      if (rn && rn[0] && /^I/.test(rn[0])) return rn[0];
    }
    return f.legs.length && f.legs[0][13] ? f.legs[0][13][0] : null;
  }

  // Automatic CDI switching exists for ILS, LOC, SDF and LDA -- not backcourse, not VOR.
  function autoSwitchEligible() {
    var a = S.fpl.approach;
    if (!a || !a.active) return false;
    return a.kind === 'ILS' || a.kind === 'LOC' || a.kind === 'SDF' || a.kind === 'LDA';
  }

  // ---------------------------------------------------------------- OBS / SUSP

  // OBS is only offered on legs where a manual course to the fix means something.
  // While the box has auto-suspended -- at the MAP, in a hold, on an altitude leg --
  // this key is the unsuspend key instead, whatever the leg type would otherwise allow.
  function obsAvailable() {
    var leg = activeLeg();
    if (!leg) return false;
    if (S.seq.susp && S.seq.suspReason && S.seq.suspReason !== 'manual') return false;
    if (N.isHold(leg) || N.isConditional(leg)) return false;
    if (leg.seg === 'missed') return false;
    return legHasFix(leg);
  }

  function setSusp(on, reason) {
    S.seq.susp = !!on;
    S.seq.suspReason = on ? (reason || 'manual') : null;
    if (on) emit('seq.susp', { reason: S.seq.suspReason });
  }
  function clearSusp() {
    S.seq.susp = false; S.seq.suspReason = null;
    S.seq.holdCircuits = 0; S.seq.holdPhase = null; S.seq.holdTargets = null; S.seq.holdD = null;
  }

  // The OBS/SUSP key. On an OBS-capable leg it toggles OBS; otherwise it is the
  // unsuspend key for a leg that auto-suspended.
  function pressObsSusp(course) {
    if (!obsAvailable()) {
      if (S.seq.susp) {
        var wasMap = S.seq.suspReason === 'map';
        clearSusp();
        emit('seq.unsuspend', { wasMap: wasMap });
        if (wasMap) sequence('unsuspend-map');
        return 'unsuspended';
      }
      setSusp(true, 'manual');
      return 'suspended';
    }
    if (S.seq.obs) {
      S.seq.obs = false; S.seq.obsCourse = null;
      emit('obs.off');
      return 'obs-off';
    }
    S.seq.obs = true;
    S.seq.obsCourse = course != null ? course : Math.round(desiredTrack() || 0);
    emit('obs.on', { course: S.seq.obsCourse });
    return 'obs-on';
  }

  function setObsCourse(c) {
    if (!S.seq.obs) return;
    S.seq.obsCourse = N.norm360(c);
    emit('obs.course', { course: S.seq.obsCourse });
  }

  // ---------------------------------------------------------------- CDI source

  function setCdiSource(src, manual) {
    if (S.cdi.source === src) return;
    S.cdi.source = src;
    emit('cdi.source', { source: src, manual: !!manual });
  }

  function pressCdi() {
    setCdiSource(S.cdi.source === 'GPS' ? 'VLOC' : 'GPS', true);
    return S.cdi.source;
  }

  // The published capture geometry, evaluated every tick.
  function updateCdiAuto() {
    S.cdi.autoArmed = false;
    if (!autoSwitchEligible() || S.cdi.ilsCapture !== 'AUTO') return;
    if (S.cdi.source === 'VLOC') return;
    var a = S.fpl.approach;
    // The localizer must be ACTIVE, not merely sitting in standby.
    if (!a.freq || Math.abs(S.vloc.active - a.freq) > 0.001) return;

    var fafIdx = indexOfRole('FAF'), mapIdx = indexOfRole('MAP');
    if (fafIdx < 0 || mapIdx < 0) return;
    var faf = S.fpl.legs[fafIdx], map = S.fpl.legs[mapIdx];
    if (!legHasFix(faf) || !legHasFix(map)) return;

    var fafP = { lat: faf.lat, lon: faf.lon }, mapP = { lat: map.lat, lon: map.lon };
    var crs = map.course != null ? map.course : N.bearing(fafP, mapP);
    var back = N.project(fafP, N.norm360(crs + 180), 40);
    var xt = Math.abs(N.crossTrack(pos(), back, fafP));
    var dFaf = N.dist(pos(), fafP);

    // The capture wedge is on the approach side of the FAF only.
    if (N.alongTrack(pos(), back, fafP) >= N.dist(back, fafP)) return;

    // Within 1.2 nm of the final approach course and 2.0-15.0 nm from the FAF.
    if (xt <= 1.2 && dFaf >= 2.0 && dFaf <= 15.0) {
      S.cdi.autoArmed = true;
      S.cdi.autoSwitched = true;
      setCdiSource('VLOC', false);
      message('CDI switched to VLOC');
    }
  }

  // ---------------------------------------------------------------- radios

  function tuneStandby(which, freq) {
    if (which === 'COM') { S.com.standby = freq; emit('com.standby', { freq: freq }); }
    else {
      S.vloc.standby = freq;
      S.vloc.rflStandby = lookupIdent(freq);   // database lookup -- NOT identification
      emit('vloc.standby', { freq: freq, rfl: S.vloc.rflStandby });
    }
  }

  function flipFlop(which) {
    if (which === 'COM') {
      var t = S.com.active; S.com.active = S.com.standby; S.com.standby = t;
      emit('com.flip', { active: S.com.active });
    } else {
      var v = S.vloc.active; S.vloc.active = S.vloc.standby; S.vloc.standby = v;
      S.vloc.rflStandby = lookupIdent(S.vloc.standby);
      updateNavDecode();
      emit('vloc.flip', { active: S.vloc.active, decoded: S.vloc.decoded });
    }
  }

  // The Morse ident the receiver decodes off the ACTIVE frequency. This is the
  // only thing that constitutes identifying the facility; rflStandby is a
  // database lookup and proves nothing about what is being received.
  function updateNavDecode() {
    var a = S.fpl.approach;
    var was = S.vloc.decoded;
    S.vloc.decoded = null;
    if (a && a.freq && Math.abs(S.vloc.active - a.freq) < 0.001 && a.ident) {
      // Localizer reception: roughly within 18 nm and in front of the antenna.
      var mapIdx = indexOfRole('MAP');
      if (mapIdx >= 0 && legHasFix(S.fpl.legs[mapIdx])) {
        var m = S.fpl.legs[mapIdx];
        if (N.dist(pos(), { lat: m.lat, lon: m.lon }) <= 25) S.vloc.decoded = a.ident;
      } else S.vloc.decoded = a.ident;
    }
    if (was !== S.vloc.decoded) emit('vloc.decode', { ident: S.vloc.decoded });
  }

  function lookupIdent(freq) {
    var a = S.fpl.approach;
    if (a && a.freq && Math.abs(freq - a.freq) < 0.001) return a.ident;
    return null;
  }

  // Volume knob press with the Nav window active toggles the audible ident.
  function toggleNavIdent() {
    S.vloc.identOn = !S.vloc.identOn;
    emit('vloc.ident', { on: S.vloc.identOn, decoded: S.vloc.decoded });
    return S.vloc.identOn;
  }

  // True only when the facility has actually been identified: the right frequency
  // is active, the receiver is decoding its Morse, and the pilot has the ident up.
  function navIdentified() {
    return !!(S.vloc.identOn && S.vloc.decoded);
  }

  // ---------------------------------------------------------------- sequencing

  function sequence(why) {
    var from = S.fpl.active;
    if (from < 0 || from >= S.fpl.legs.length - 1) {
      S.seq.armedNote = 'End of flight plan';
      return false;
    }
    setOrigin(legHasFix(S.fpl.legs[from])
      ? { lat: S.fpl.legs[from].lat, lon: S.fpl.legs[from].lon } : pos(), from + 1);
    S.fpl.active = from + 1;
    S.fpl.dtoIdent = null; S.fpl.dtoCourse = null;
    S.seq.holdCircuits = 0; S.seq.holdPhase = null; S.seq.holdTargets = null; S.seq.holdD = null;
    emit('seq.sequence', {
      from: S.fpl.legs[from].ident, to: S.fpl.legs[S.fpl.active].ident, why: why || null
    });
    return true;
  }

  // Turn anticipation for a fly-by waypoint: the distance at which the turn starts.
  function anticipation() {
    var leg = activeLeg(), nxt = nextLeg();
    if (!leg || !nxt || !legHasFix(leg)) return 0.2;
    if (N.isFlyover(leg)) return 0;
    var inCrs = desiredTrack();
    var outCrs = legHasFix(nxt)
      ? N.bearing({ lat: leg.lat, lon: leg.lon }, { lat: nxt.lat, lon: nxt.lon })
      : (nxt.course != null ? nxt.course : inCrs);
    var turn = Math.abs(N.norm180(outCrs - inCrs));
    var r = N.turnRadius(S.ac.gs);
    return Math.min(4, r * Math.tan(N.rad(Math.min(turn, 160) / 2)));
  }

  // Runs every tick. Decides whether the box sequences, and records WHY, which is
  // what the sequencing visualiser shows the student.
  function updateSequencing() {
    var leg = activeLeg();
    S.seq.armedNote = null;
    if (!leg) return;

    if (S.seq.obs) { S.seq.armedNote = 'OBS -- sequencing stopped, holding ' + S.seq.obsCourse + 'T'; return; }

    // Altitude-terminated legs sequence on altitude, and show SUSP meanwhile.
    if (leg.pt === 'CA' || leg.pt === 'VA' || leg.pt === 'HA') {
      var target = leg.alt1;
      if (!S.seq.susp) setSusp(true, 'altleg');
      S.seq.armedNote = target != null
        ? 'Altitude leg -- sequences passing ' + target + ' ft (now ' + Math.round(S.ac.alt) + ')'
        : 'Altitude leg';
      if (target != null && S.ac.alt >= target - 20) { clearSusp(); sequence('altitude'); }
      return;
    }

    // Holds. A hold leg is flown to the fix first, then round the racetrack; only
    // then does the question of sequencing out of it arise.
    if (N.isHold(leg)) {
      var dFix = distToActive();
      if (S.seq.holdPhase == null) S.seq.holdPhase = 'toFix';
      if (S.seq.holdPhase === 'toFix') {
        S.seq.armedNote = (leg.pt === 'HM' ? 'To the hold fix' : 'To ' + (leg.ident || 'the fix') +
          ' for the hold in lieu of a procedure turn') +
          (dFix != null ? ' -- ' + dFix.toFixed(1) + ' nm' : '');
        // Enter on crossing the fix, not only on passing close to it: an overshoot
        // must not leave the aircraft tracking outbound for ever.
        var pastFix = N.alongTrack(pos(), legOrigin(), { lat: leg.lat, lon: leg.lon }) >=
                      N.dist(legOrigin(), { lat: leg.lat, lon: leg.lon });
        if (dFix != null && (dFix < 0.35 || pastFix)) enterHold(leg);
        return;
      }
      if (leg.pt === 'HM') {
        if (!S.seq.susp) setSusp(true, 'hold');
        S.seq.armedNote = 'Holding -- ' + S.seq.holdCircuits +
          ' circuit(s) flown. Will not sequence until you unsuspend.';
        return;
      }
      // HF: hold in lieu of a procedure turn -- one circuit, then continue inbound.
      S.seq.armedNote = 'Hold in lieu of PT -- ' +
        (S.seq.holdCircuits > 0 ? 'circuit flown, sequencing inbound over ' + (leg.ident || 'the fix')
                                : 'flying the circuit') +
        (dFix != null ? ' (' + dFix.toFixed(1) + ' nm to the fix)' : '');
      if (S.seq.holdCircuits > 0 && dFix != null && dFix < 0.4) sequence('hold-complete');
      return;
    }

    if (S.seq.susp) {
      S.seq.armedNote = S.seq.suspReason === 'map'
        ? 'SUSP at the missed approach point -- unsuspend to fly the missed'
        : 'SUSP -- automatic sequencing is off';
      // VTF suspended on the FROM side resumes once on the TO side and within scale.
      if (S.seq.suspReason === 'vtf' && toFrom() === 'TO' && Math.abs(crossTrack()) < 1.0) {
        clearSusp();
        emit('seq.vtfResume');
      }
      return;
    }

    if (!legHasFix(leg)) {
      // Open-ended vector leg: flies until intercepting the next leg's course.
      var nxt = nextLeg();
      if (nxt && legHasFix(nxt)) {
        S.seq.armedNote = 'Vector leg -- sequences on intercepting the course to ' + nxt.ident;
        var toNext = N.bearing(pos(), { lat: nxt.lat, lon: nxt.lon });
        if (Math.abs(N.norm180(toNext - (nxt.course != null ? nxt.course : toNext))) < 5) {
          sequence('intercept');
        }
      }
      return;
    }

    var d = distToActive();
    var ant = anticipation();
    var flyover = N.isFlyover(leg);
    var past = N.alongTrack(pos(), legOrigin(), { lat: leg.lat, lon: leg.lon }) >=
               N.dist(legOrigin(), { lat: leg.lat, lon: leg.lon });

    // The missed approach point auto-suspends on crossing.
    if (leg.role === 'MAP') {
      S.seq.armedNote = 'Approaching the MAP -- the box will SUSP, not sequence (' +
                        d.toFixed(1) + ' nm)';
      if (past || d < 0.15) {
        setSusp(true, 'map');
        message('Arriving at the missed approach point');
        emit('seq.map');
      }
      return;
    }

    S.seq.armedNote = (flyover ? 'Flyover ' : 'Fly-by ') + (leg.ident || 'fix') +
      ' -- sequences ' + (flyover ? 'crossing the fix' : 'in ' + Math.max(0, d - ant).toFixed(1) + ' nm') +
      ' (' + d.toFixed(1) + ' nm to go)';

    if (flyover ? past : (d <= ant || past)) sequence(flyover ? 'flyover' : 'flyby');
  }

  // Crossing the fix for the first time starts the pattern. The targets are the
  // outbound end, the inbound roll-out, then the fix again -- one lap.
  function enterHold(leg) {
    var g = N.holdGeometry(leg, S.ac.gs);
    S.seq.holdTargets = [g.outboundEnd, g.inboundStart, { lat: leg.lat, lon: leg.lon }];
    S.seq.holdPhase = 0;
    S.seq.holdD = null;
    emit('seq.holdEntry', { fix: leg.ident, inbound: Math.round(g.inbound), turn: g.right ? 'R' : 'L' });
  }

  // Advance round the racetrack; a lap completed at the fix counts as a circuit.
  // A target is reached either by proximity or by closest approach having passed --
  // at a 0.6 nm turn radius an overshoot is normal and must not stall the pattern.
  function updateHoldPath() {
    var leg = activeLeg();
    if (!leg || !N.isHold(leg) || S.seq.holdPhase == null || S.seq.holdPhase === 'toFix') return;
    var tgt = S.seq.holdTargets && S.seq.holdTargets[S.seq.holdPhase];
    if (!tgt) return;
    var d = N.dist(pos(), tgt);
    // Reached = close, or closest approach is behind us. The second test only counts
    // once we have actually got near the target; without that guard a target that
    // starts far away reads as "receding" on the first tick and the pattern races
    // round the racetrack banking phantom circuits.
    if (S.seq.holdD == null || d < S.seq.holdD) S.seq.holdD = d;
    var reached = d < 0.35 || (S.seq.holdD < 1.2 && d > S.seq.holdD + 0.15);
    if (reached) {
      S.seq.holdD = null;
      if (S.seq.holdPhase === S.seq.holdTargets.length - 1) {
        S.seq.holdCircuits++;
        S.seq.holdPhase = 0;
      } else S.seq.holdPhase++;
    }
  }

  // ---------------------------------------------------------------- sim step

  function step(dtSec) {
    if (!dtSec) return;
    S.sim.t += dtSec;
    var ac = S.ac;

    // Lateral: steer onto the desired track, allowing for cross-track.
    if (ac.ap) {
      var dtk = desiredTrack();
      if (dtk != null) {
        var xt = crossTrack();
        var intercept = Math.max(-45, Math.min(45, -xt * 30));
        var want = N.norm360(dtk + intercept);
        var err = N.norm180(want - ac.trk);
        var rate = Math.max(-3, Math.min(3, err));       // 3 deg/s, standard rate
        ac.trk = N.norm360(ac.trk + rate * dtSec);
      }
    }

    updateHoldPath();

    // Vertical.
    if (Math.abs(ac.alt - ac.altTarget) > 5) {
      var dir = ac.altTarget > ac.alt ? 1 : -1;
      ac.alt += dir * (ac.vs / 60) * dtSec;
      if (dir > 0 ? ac.alt > ac.altTarget : ac.alt < ac.altTarget) ac.alt = ac.altTarget;
    }

    // Position.
    var moved = N.project(pos(), ac.trk, (ac.gs / 3600) * dtSec);
    ac.lat = moved.lat; ac.lon = moved.lon;

    updateSequencing();
    updateNavDecode();
    updateCdiAuto();
  }

  // ---------------------------------------------------------------- readouts

  // Everything the annunciation bar, the HSI and the sequencing panel need.
  function nav() {
    var leg = activeLeg();
    var dtk = desiredTrack();
    var xt = crossTrack();
    var d = distToActive();
    var scale = fullScale();
    return {
      leg: leg, index: S.fpl.active, next: nextLeg(),
      dtk: dtk == null ? null : N.norm360(dtk),
      xtk: xt, fullScale: scale,
      deflection: Math.max(-1, Math.min(1, xt / scale)),
      dist: d,
      brg: bearingToActive(),
      toFrom: toFrom(),
      source: S.cdi.source,
      susp: S.seq.susp, suspReason: S.seq.suspReason,
      obs: S.seq.obs, obsCourse: S.seq.obsCourse,
      note: S.seq.armedNote,
      phase: phase()
    };
  }

  // CDI full-scale deflection, nm each side.
  function fullScale() {
    if (S.cdi.source === 'VLOC') return 1.0;
    var p = phase();
    if (p === 'LPV' || p === 'LNAV' || p === 'L/VNAV') return 0.3;
    if (p === 'TERM') return 1.0;
    return 2.0;
  }

  // GPS level of service annunciation.
  function phase() {
    if (S.cdi.source === 'VLOC') return null;
    var a = S.fpl.approach;
    var leg = activeLeg();
    if (a && a.active && leg && leg.seg === 'appr') {
      // Inside the FAF an RNAV approach annunciates its level of service. A
      // localizer-based approach has none to give, but the GPS is still in
      // approach mode -- the annunciation only disappears when VLOC is driving
      // the CDI, which is handled above.
      var fafIdx = indexOfRole('FAF');
      if (fafIdx >= 0 && S.fpl.active >= fafIdx) return a.kind === 'RNAV' ? 'LNAV' : 'TERM';
      return 'TERM';
    }
    var dest = S.fpl.legs[S.fpl.legs.length - 1];
    if (dest && legHasFix(dest) && N.dist(pos(), { lat: dest.lat, lon: dest.lon }) < 30) return 'TERM';
    return 'ENR';
  }

  global.SeqCore = {
    state: state, reset: reset, emit: emit, message: message,
    step: step, nav: nav, phase: phase, fullScale: fullScale,
    legs: legs, activeLeg: activeLeg, nextLeg: nextLeg, legOrigin: legOrigin,
    legHasFix: legHasFix, indexOfRole: indexOfRole, activatedDirect: activatedDirect,
    setFlightPlan: setFlightPlan, appendWaypoint: appendWaypoint, removeLeg: removeLeg,
    clearFlightPlan: clearFlightPlan, activateLeg: activateLeg,
    directTo: directTo, cancelDirectTo: cancelDirectTo,
    loadProcedure: loadProcedure, activateApproach: activateApproach,
    approachKind: approachKind, locIdent: locIdent, autoSwitchEligible: autoSwitchEligible,
    obsAvailable: obsAvailable, pressObsSusp: pressObsSusp, setObsCourse: setObsCourse,
    setSusp: setSusp, clearSusp: clearSusp, holdPath: N.holdPath,
    setCdiSource: setCdiSource, pressCdi: pressCdi,
    tuneStandby: tuneStandby, flipFlop: flipFlop, toggleNavIdent: toggleNavIdent,
    navIdentified: navIdentified, updateNavDecode: updateNavDecode,
    desiredTrack: desiredTrack, crossTrack: crossTrack, distToActive: distToActive,
    anticipation: anticipation
  };
})(window);
