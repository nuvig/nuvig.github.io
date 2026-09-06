// GPS Sequencing -- the interactive: map, state readout, controls.
// Unofficial training reference, not affiliated with or endorsed by Garmin.
//
// This is deliberately NOT a replica of a navigator's bezel. The real unit's
// trainer app does that better, and on a touchscreen where it belongs. What a
// simulator cannot show is why the box is about to do what it does, so that is
// what this draws: the active leg, the next one, whether sequencing is armed or
// suspended, and the reason in words.
//
// Nav data is the repo's FAA CIFP build (data/procedures/). Degrees true throughout.

(function (global) {
  'use strict';

  var N = global.SeqNav, C = global.SeqCore, D = global.SeqDemos;

  var mapCv, hsiCv, raf = null, lastT = 0, range = 12, demoId = null;

  function $(s, r) { return (r || document).querySelector(s); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function fmtCrs(c) { return c == null ? '---' : (Math.round(N.norm360(c)) + '').padStart(3, '0'); }
  function fmtDist(d) { return d == null ? '--.-' : (d < 10 ? d.toFixed(1) : Math.round(d) + ''); }
  function fmtFreq(f) { return f == null ? '---.--' : Number(f).toFixed(f * 1000 % 10 ? 3 : 2); }

  function legLabel(l) {
    if (!l) return '—';
    if (l.pt === 'CA' || l.pt === 'VA') return 'climb to ' + Math.round(l.alt1) + ' ft';
    if (l.pt === 'VI' || l.pt === 'VM') return 'heading ' + fmtCrs(l.course);
    return l.ident || l.pt;
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
    var cx = w / 2, cy = h * 0.66, ppn = (h * 0.6) / range, trk = ac.trk;

    function xy(p) {
      var d = N.dist({ lat: ac.lat, lon: ac.lon }, p);
      var b = N.bearing({ lat: ac.lat, lon: ac.lon }, p);
      var a = N.rad(b - trk);
      return [cx + Math.sin(a) * d * ppn, cy - Math.cos(a) * d * ppn];
    }

    g.strokeStyle = 'rgba(120,150,180,.22)'; g.lineWidth = 1;
    g.beginPath(); g.arc(cx, cy, (range / 2) * ppn, 0, Math.PI * 2); g.stroke();
    g.fillStyle = 'rgba(150,180,205,.55)'; g.font = '11px system-ui,sans-serif';
    g.fillText((range / 2) + ' nm', cx + 5, cy - (range / 2) * ppn - 4);

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
          : (l.seg === 'missed' ? 'rgba(255,255,255,.3)' : 'rgba(225,238,250,.55)');
        g.lineWidth = isActive ? 3.4 : 1.7;
        g.setLineDash(l.seg === 'missed' ? [6, 5] : []);
        g.stroke(); g.setLineDash([]);
      }
      if (N.isHold(l)) {
        g.beginPath();
        N.holdPath(l, ac.gs).forEach(function (pt, k) {
          var q = xy(pt); if (k === 0) g.moveTo(q[0], q[1]); else g.lineTo(q[0], q[1]);
        });
        g.strokeStyle = isActive ? '#e879f9' : 'rgba(225,238,250,.45)';
        g.lineWidth = isActive ? 2.6 : 1.5; g.stroke();
      }
      var q2 = xy({ lat: l.lat, lon: l.lon });
      g.fillStyle = isActive ? '#e879f9' : '#cfe0f0';
      g.beginPath(); g.arc(q2[0], q2[1], 3.6, 0, Math.PI * 2); g.fill();
      if (l.role === 'FAF' || l.role === 'MAP') {
        g.strokeStyle = isActive ? '#f5d0fe' : 'rgba(220,235,250,.7)';
        g.lineWidth = 1.2;
        g.beginPath(); g.arc(q2[0], q2[1], 6.5, 0, Math.PI * 2); g.stroke();
      }
      if (l.ident) {
        placeLabel(g, l.ident + (l.role === 'FAF' || l.role === 'MAP' ? ' · ' + l.role : ''),
                   q2[0] + 8, q2[1] - 5, isActive, labels);
      }
    }

    // Turn-anticipation marker: where the box will actually start the turn.
    var leg = C.activeLeg();
    if (leg && C.legHasFix(leg) && !N.isFlyover(leg) && !N.isHold(leg) && !s.seq.susp) {
      var d = C.distToActive();
      var ant = C.anticipation ? C.anticipation() : null;
      if (ant && d != null && ant > 0.05) {
        var pt = N.project({ lat: ac.lat, lon: ac.lon }, N.bearing({ lat: ac.lat, lon: ac.lon },
                 { lat: leg.lat, lon: leg.lon }), Math.max(0, d - ant));
        var q = xy(pt);
        g.strokeStyle = 'rgba(251,191,36,.85)'; g.lineWidth = 1.6;
        g.setLineDash([3, 3]);
        g.beginPath(); g.arc(q[0], q[1], 5, 0, Math.PI * 2); g.stroke();
        g.setLineDash([]);
      }
    }

    g.save(); g.translate(cx, cy);
    g.fillStyle = '#fff';
    g.beginPath(); g.moveTo(0, -10); g.lineTo(7, 9); g.lineTo(0, 4.5); g.lineTo(-7, 9);
    g.closePath(); g.fill(); g.restore();

    g.fillStyle = 'rgba(160,195,220,.7)'; g.font = '11px system-ui,sans-serif';
    g.fillText('track ' + fmtCrs(trk) + '°T', 6, h - 8);
  }

  function placeLabel(g, text, x, y, force, drawn) {
    g.font = (force ? '600 ' : '') + '11px system-ui,sans-serif';
    var w = g.measureText(text).width, box = [x, y - 9, x + w, y + 3];
    if (!force) {
      for (var i = 0; i < drawn.length; i++) {
        var b = drawn[i];
        if (box[0] < b[2] + 4 && box[2] > b[0] - 4 && box[1] < b[3] + 3 && box[3] > b[1] - 3) return;
      }
    }
    drawn.push(box);
    g.fillStyle = force ? '#f5d0fe' : 'rgba(215,232,248,.85)';
    g.fillText(text, x, y);
  }

  // ---------------------------------------------------------------- CDI

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
    var cx = w / 2, cy = h / 2, r = Math.min(w, h) / 2 - 18, hdg = s.ac.trk;

    g.save(); g.translate(cx, cy);
    g.strokeStyle = 'rgba(140,170,195,.3)'; g.lineWidth = 1;
    g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2); g.stroke();
    g.save(); g.rotate(N.rad(-hdg));
    for (var d = 0; d < 360; d += 10) {
      var a = N.rad(d), big = d % 30 === 0;
      g.beginPath();
      g.moveTo(Math.sin(a) * r, -Math.cos(a) * r);
      g.lineTo(Math.sin(a) * (r - (big ? 9 : 5)), -Math.cos(a) * (r - (big ? 9 : 5)));
      g.strokeStyle = 'rgba(190,208,225,.55)'; g.stroke();
      if (big) {
        g.save();
        g.translate(Math.sin(a) * (r - 19), -Math.cos(a) * (r - 19));
        g.rotate(a);
        g.fillStyle = 'rgba(210,226,242,.8)'; g.font = '10px system-ui,sans-serif';
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
      g.beginPath(); g.moveTo(0, -r + 8); g.lineTo(-6, -r + 19); g.lineTo(6, -r + 19);
      g.closePath(); g.fillStyle = col; g.fill();
      var dev = Math.max(-1, Math.min(1, nv.deflection));
      g.strokeStyle = col; g.lineWidth = 3;
      g.beginPath(); g.moveTo(dev * r * 0.5, -r * 0.42); g.lineTo(dev * r * 0.5, r * 0.42); g.stroke();
      g.fillStyle = 'rgba(190,208,225,.45)';
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
  }

  // ---------------------------------------------------------------- readouts

  function renderState() {
    var s = C.state(), nv = C.nav();
    var leg = nv.leg, nxt = nv.next;

    var el = $('#seq-state');
    if (el) {
      var from = leg
        ? (C.activatedDirect() ? 'direct'
            : (nv.index > 0 ? esc(s.fpl.legs[nv.index - 1].ident || '—') : '—'))
        : '—';
      el.innerHTML =
        row('Active leg', leg ? from + ' &rarr; <b class="mag">' + esc(legLabel(leg)) + '</b>' : '—') +
        row('Leg type', leg
          ? esc(leg.pt) + (N.isFlyover(leg) ? ' · flyover'
              : (leg.pt === 'TF' || leg.pt === 'CF' ? ' · fly-by' : ''))
            + (leg.role ? ' · ' + leg.role : '')
          : '—') +
        row('Next leg', nxt ? esc(legLabel(nxt)) : '—') +
        row('Distance', fmtDist(nv.dist) + ' nm') +
        row('Turn starts', turnStartsIn()) +
        row('Desired track', fmtCrs(nv.dtk) + '°T') +
        row('Sequencing', s.seq.susp
          ? '<b class="warn">SUSPENDED</b>'
          : (s.seq.obs ? '<b class="warn">OBS — manual</b>' : '<b class="ok">automatic</b>'));
    }

    var why = $('#seq-why');
    if (why) why.textContent = nv.note || '';

    var ann = $('#seq-ann');
    if (ann) {
      ann.innerHTML =
        '<span class="ann-ph">' + esc(nv.phase || '') + '</span>' +
        '<span class="ann-src ' + (nv.source === 'VLOC' ? 'vloc' : 'gps') + '">' + nv.source + '</span>' +
        (s.seq.obs ? '<span class="ann-obs">OBS ' + fmtCrs(s.seq.obsCourse) + '</span>'
          : s.seq.susp ? '<span class="ann-susp">SUSP</span>' : '');
    }

    var radio = $('#seq-radio');
    if (radio) {
      var a = s.fpl.approach;
      var rfl = a && a.ident ? a.ident.replace(/^I/, 'I-') : null;
      var actIsLoc = a && a.freq && Math.abs(s.vloc.active - a.freq) < 0.001;
      var sbyIsLoc = a && a.freq && Math.abs(s.vloc.standby - a.freq) < 0.001;
      radio.innerHTML =
        '<div class="rr"><span>NAV active</span><b class="' + (actIsLoc ? 'grn' : '') + '">' +
          fmtFreq(s.vloc.active) + '</b>' +
          '<i>' + (actIsLoc && rfl ? esc(rfl) + ' ILS' : '') + '</i></div>' +
        '<div class="rr"><span>NAV standby</span><b>' + fmtFreq(s.vloc.standby) + '</b>' +
          '<i>' + (sbyIsLoc && rfl ? esc(rfl) + ' ILS' : '') + '</i></div>' +
        '<div class="rr"><span>Morse decoded</span><b class="' + (s.vloc.decoded ? 'grn' : 'dim') + '">' +
          (s.vloc.decoded ? esc(s.vloc.decoded.replace(/^I/, 'I-')) : 'nothing') + '</b><i></i></div>' +
        '<div class="rr"><span>Ident audio</span><b class="' + (s.vloc.identOn ? 'grn' : 'dim') + '">' +
          (s.vloc.identOn ? 'on' : 'off') + '</b><i></i></div>' +
        '<div class="rr big"><span>Identified?</span><b class="' +
          (C.navIdentified() ? 'ok' : 'warn') + '">' +
          (C.navIdentified() ? 'yes' : 'no') + '</b><i></i></div>';
    }

    var w = $('#seq-watch');
    if (w) {
      var list = D.watches();
      w.innerHTML = list.length
        ? list.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('')
        : '<li class="none">Nothing worth flagging.</li>';
    }

    var obsBtn = $('#c-obs');
    if (obsBtn) obsBtn.textContent = C.obsAvailable()
      ? (s.seq.obs ? 'OBS off' : 'OBS on')
      : (s.seq.susp ? 'Unsuspend' : 'Suspend');
    var cdiBtn = $('#c-cdi');
    if (cdiBtn) cdiBtn.textContent = 'CDI → ' + (s.cdi.source === 'GPS' ? 'VLOC' : 'GPS');

    drawMap();
    drawHsi();
  }

  // How far short of the fix the box will begin the turn, in words.
  function turnStartsIn() {
    var s = C.state(), leg = C.activeLeg();
    if (!leg || !C.legHasFix(leg)) return '—';
    if (s.seq.susp || s.seq.obs) return 'not sequencing';
    if (N.isHold(leg)) return 'at the fix';
    if (N.isFlyover(leg)) return 'no anticipation (flyover)';
    var ant = C.anticipation();
    if (ant == null || ant < 0.05) return 'at the fix (leg is straight)';
    return ant.toFixed(1) + ' nm before ' + esc(leg.ident || 'the fix');
  }

  function row(k, v) {
    return '<div class="sr"><span>' + k + '</span><b>' + v + '</b></div>';
  }

  // ---------------------------------------------------------------- loop

  function tick(ts) {
    raf = requestAnimationFrame(tick);
    var s = C.state();
    var dt = lastT ? Math.min(0.25, (ts - lastT) / 1000) : 0;
    lastT = ts;
    if (s.sim.running) { C.step(dt * s.sim.rate); renderState(); }
  }

  function setRunning(on) {
    var s = C.state();
    s.sim.running = on;
    lastT = 0;
    var b = $('#c-run');
    if (b) b.textContent = on ? 'Pause' : 'Fly';
    renderState();
  }

  // ---------------------------------------------------------------- demos

  function runDemo(id) {
    var d = D.byId(id);
    if (!d) return;
    demoId = id;
    setRunning(false);
    return Promise.resolve(d.run()).then(function () {
      // One negligible step so the sequencing reasoning is populated before the
      // reader presses Fly -- otherwise the "why" line is blank on arrival.
      C.step(0.01);
      var note = $('#seq-note');
      if (note) note.textContent = d.note;
      Array.prototype.forEach.call(document.querySelectorAll('[data-demo]'), function (b) {
        b.classList.toggle('on', b.getAttribute('data-demo') === id);
      });
      renderState();
      var box = $('#seq-demo');
      if (box && box.scrollIntoView) box.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }

  // ---------------------------------------------------------------- boot

  function boot() {
    mapCv = $('#seq-map');
    hsiCv = $('#seq-cdi');

    document.addEventListener('click', function (e) {
      var t = e.target.closest('[data-demo]');
      if (t) { runDemo(t.getAttribute('data-demo')); return; }
    });

    $('#c-run').addEventListener('click', function () { setRunning(!C.state().sim.running); });
    $('#c-reset').addEventListener('click', function () {
      if (demoId) runDemo(demoId);
    });
    $('#c-cdi').addEventListener('click', function () { C.pressCdi(); renderState(); });
    $('#c-obs').addEventListener('click', function () {
      var r = C.pressObsSusp();
      if (r === 'obs-on') {
        var c = prompt('OBS course, degrees true', fmtCrs(C.state().seq.obsCourse));
        if (c != null && c !== '') C.setObsCourse(parseFloat(c));
      }
      renderState();
    });
    var rate = $('#c-rate');
    rate.addEventListener('input', function () {
      C.state().sim.rate = +rate.value;
      $('#c-ratev').textContent = rate.value + '×';
    });
    C.state().sim.rate = +rate.value;
    var rng = $('#c-range');
    rng.addEventListener('input', function () {
      range = +rng.value; $('#c-rangev').textContent = rng.value + ' nm'; drawMap();
    });
    range = +rng.value;

    global.addEventListener('resize', function () { drawMap(); drawHsi(); });
    document.addEventListener('keydown', function (e) {
      if (/input|textarea|select/i.test(e.target.tagName || '')) return;
      if (e.key === ' ') { setRunning(!C.state().sim.running); e.preventDefault(); }
    });

    return N.loadIndex()
      .then(function () { return global.SeqFacilities.load(); })
      .then(function () { return runDemo('load-activate'); })
      .then(function () { raf = requestAnimationFrame(tick); });
  }

  global.SeqUI = { boot: boot, run: runDemo, render: renderState, setRunning: setRunning };

  global.SEQUENCING_DEBUG = {
    state: function () { return C.state(); },
    nav: function () { return C.nav(); },
    watches: function () { return D.watches(); },
    demo: function () { return demoId; },
    run: runDemo
  };
})(window);
