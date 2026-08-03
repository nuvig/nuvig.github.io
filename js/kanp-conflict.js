// KANP Flight Tracker — Proximity events (Traffic Study tab)
//
// Scans the historical tracks for pairs of aircraft that got close (loss of
// separation / near miss), lists each event with date, time and closest point
// of approach (CPA), and replays any event as an animated two-aircraft
// playback on a map.
//
// Method: every airborne track is linearly interpolated onto a shared 10 s
// timeline; a (time × 1.5 nm grid-cell) hash finds candidate pairs cheaply,
// then each candidate is refined at 1 s to find contiguous runs where the
// pair was inside the horizontal AND vertical thresholds at the same instant.
//
// Honesty caveats (also in the page copy): both data sources serve
// Douglas-Peucker-simplified tracks, so the CPA numbers come from
// interpolated straight segments — approximate, not evidentiary. Only
// ADS-B-equipped aircraft appear, and altitudes are barometric.

const KANPConflict = (() => {
  const STEP_S = 10;          // coarse prefilter sample step
  const INTERP_GAP_S = 240;   // max gap we interpolate across inside a track
  const RUN_GAP_S = 20;       // seconds allowed between in-threshold instants
  const MERGE_S = 60;         // runs closer than this merge into one event
  const CELL_NM = 1.5;        // prefilter grid cell (covers H + 10 s closure)
  const FORMATION_S = 180;    // proximity this long looks intentional
  const NEAR_DIST = 10;       // "pattern area only" fetch scope, nm
  const NEAR_ALT = 4500;      // …and ft
  const REPLAY_PAD_S = 90;    // replay window = CPA ± this
  const TRAIL_S = 25;         // bright trail behind each animated aircraft

  const FT_NM = 6076.12;
  const DEG = Math.PI / 180;
  const AIRBORNE_FT = SITE.airport.elevFt + 150;   // MSL floor = "airborne"
  const TZ = SITE.weather.timeZone;
  const COLORS = ['#4a9eff', '#f0c040'];           // aircraft A / B
  const SEV = [null,
    { name: 'proximity', color: '#8a94a0' },
    { name: 'close',     color: '#f0c040' },
    { name: 'critical',  color: '#ef4444' }];

  let last = null;    // { events, preps, source }
  let anim = null;    // animation state
  let map = null, animLayer = null;

  document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('conflict-load');
    if (!btn) return;
    btn.addEventListener('click', run);
    document.getElementById('conflict-play').addEventListener('click', togglePlay);
    document.getElementById('conflict-scrub').addEventListener('input', onScrub);
  });

  async function run() {
    const btn = document.getElementById('conflict-load');
    const out = document.getElementById('conflict-result');
    btn.disabled = true;
    out.textContent = 'Fetching tracks…';
    try {
      const H = Math.max(0.05, +document.getElementById('conflict-h').value || 0.5);
      const V = Math.max(50, +document.getElementById('conflict-v').value || 500);
      const near = document.getElementById('conflict-near').checked;

      const p = KANP.readFilters('study-filters');
      delete p.min_alt;
      delete p.max_alt;
      delete p.callsign;
      p.ground = 'include';
      p.max_points = 500000;
      if (near) { p.max_dist = NEAR_DIST; p.max_alt = NEAR_ALT; }
      const d = await KANP.getTracks(p);

      out.textContent = 'Scanning for proximity events…';
      await new Promise(r => setTimeout(r));   // let the status paint
      const preps = prep(d.tracks || []);
      const events = detect(preps, H, V);
      last = { events, preps, source: KANP.sourceLabel(d) };

      stopAnim();
      document.getElementById('conflict-anim').style.display = 'none';
      if (!events.length) {
        document.getElementById('conflict-out').style.display = 'none';
        out.innerHTML = `No events inside ${H} nm / ${V} ft in this range ` +
          `(${(d.tracks || []).length} tracks scanned) · ${last.source}`;
        return;
      }
      document.getElementById('conflict-out').style.display = '';
      renderTable();
      const worst = events[0];
      out.innerHTML = `<strong>${events.length}</strong> event(s) inside ` +
        `${H} nm / ${V} ft · worst: <strong>${worst.regA}</strong> / ` +
        `<strong>${worst.regB}</strong> ${fmtSep(worst.hCpaNm)} & ` +
        `${Math.round(worst.vCpa)} ft on ${fmtTs(worst.cpaT)} · ${last.source}` +
        `<br><span style="color:#777">Simplified-track interpolation — treat ` +
        `distances as approximate. Non-ADS-B aircraft are invisible to this scan.</span>`;
    } catch (e) {
      out.innerHTML = `<span class="err">${e.message}</span>`;
    } finally {
      btn.disabled = false;
    }
  }

  // ---- track preparation ----
  // Each track becomes { meta, segs }, segs = maximal airborne stretches with
  // usable positions+altitudes, gap-limited so interpolation stays honest.
  function prep(tracks) {
    const preps = [];
    for (const t of tracks) {
      const segs = [];
      let cur = null;
      for (const p of t.points || []) {
        const usable = p[1] != null && p[2] != null && p[3] != null &&
          p[5] !== 1 && p[3] >= AIRBORNE_FT;
        if (!usable) { cur = null; continue; }
        if (cur && p[0] - cur[cur.length - 1][0] > INTERP_GAP_S) cur = null;
        if (!cur) { cur = []; segs.push(cur); }
        cur.push(p);
      }
      const good = segs.filter(s => s.length >= 2);
      if (!good.length) continue;
      preps.push({
        hex: t.hex, reg: t.reg || t.hex, flight: (t.flight || '').trim(),
        type: t.type, segs: good,
      });
    }
    return preps;
  }

  // Interpolated state at time t, or null outside the track's segments.
  function posAt(tr, t) {
    for (const seg of tr.segs) {
      if (t < seg[0][0] || t > seg[seg.length - 1][0]) continue;
      let lo = 0, hi = seg.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (seg[mid][0] <= t) lo = mid; else hi = mid;
      }
      const a = seg[lo], b = seg[hi];
      const f = b[0] === a[0] ? 0 : (t - a[0]) / (b[0] - a[0]);
      return {
        lat: a[1] + (b[1] - a[1]) * f,
        lon: a[2] + (b[2] - a[2]) * f,
        alt: a[3] + (b[3] - a[3]) * f,
        gs: (a[4] != null && b[4] != null) ? a[4] + (b[4] - a[4]) * f : (a[4] ?? b[4]),
      };
    }
    return null;
  }

  const toXY = (lat, lon) => ({
    x: (lon - KANP.LON) * DEG * 3440.065 * Math.cos(KANP.LAT * DEG),
    y: (lat - KANP.LAT) * DEG * 3440.065,
  });

  // ---- detection ----
  function detect(preps, H, V) {
    // 1. coarse pass: shared 10 s timeline, spatial hash, candidate pairs
    const cell = Math.max(CELL_NM, H + 0.6);
    const bySlot = new Map();       // slot ts → [{i, x, y, alt}]
    preps.forEach((tr, i) => {
      for (const seg of tr.segs) {
        const t0 = Math.ceil(seg[0][0] / STEP_S) * STEP_S;
        const t1 = seg[seg.length - 1][0];
        for (let t = t0; t <= t1; t += STEP_S) {
          const s = posAt(tr, t);
          if (!s) continue;
          const { x, y } = toXY(s.lat, s.lon);
          let arr = bySlot.get(t);
          if (!arr) bySlot.set(t, arr = []);
          arr.push({ i, x, y, alt: s.alt });
        }
      }
    });

    const candidates = new Map();   // "i|j" → [slot times]
    for (const [t, arr] of bySlot) {
      const grid = new Map();
      for (const s of arr) {
        const key = `${Math.floor(s.x / cell)}|${Math.floor(s.y / cell)}`;
        let g = grid.get(key);
        if (!g) grid.set(key, g = []);
        g.push(s);
      }
      for (const [key, g] of grid) {
        const [cx, cy] = key.split('|').map(Number);
        for (let dx = 0; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
          if (dx === 0 && dy < 0) continue;   // visit each neighbor pair once
          const other = (dx === 0 && dy === 0) ? g
            : grid.get(`${cx + dx}|${cy + dy}`);
          if (!other) continue;
          for (const a of g) for (const b of other) {
            if (a.i >= b.i && other === g) continue;
            if (a.i === b.i) continue;
            if (Math.abs(a.alt - b.alt) > V + 800) continue;
            if (Math.hypot(a.x - b.x, a.y - b.y) > cell * 1.5) continue;
            const [i, j] = a.i < b.i ? [a.i, b.i] : [b.i, a.i];
            if (preps[i].hex === preps[j].hex) continue;
            const pk = `${i}|${j}`;
            let times = candidates.get(pk);
            if (!times) candidates.set(pk, times = []);
            times.push(t);
          }
        }
      }
    }

    // 2. fine pass: 1 s refinement over each candidate pair's windows
    const events = [];
    for (const [pk, times] of candidates) {
      const [i, j] = pk.split('|').map(Number);
      const A = preps[i], B = preps[j];
      times.sort((a, b) => a - b);
      const windows = [];
      for (const t of new Set(times)) {
        const w = windows[windows.length - 1];
        if (w && t - STEP_S <= w[1] + 1) w[1] = t + STEP_S;
        else windows.push([t - STEP_S, t + STEP_S]);
      }

      const runs = [];
      for (const [w0, w1] of windows) {
        let run = null;
        for (let t = w0; t <= w1; t++) {
          const a = posAt(A, t), b = posAt(B, t);
          let inside = false, rec = null;
          if (a && b) {
            const pa = toXY(a.lat, a.lon), pb = toXY(b.lat, b.lon);
            const hNm = Math.hypot(pa.x - pb.x, pa.y - pb.y);
            const v = Math.abs(a.alt - b.alt);
            if (hNm < H && v < V) {
              inside = true;
              rec = { t, hNm, v, a, b,
                      slant: Math.hypot(hNm * FT_NM, v),
                      tier: (hNm * FT_NM < 500 && v < 100) ? 3
                          : (hNm < 0.15 && v < 200) ? 2 : 1 };
            }
          }
          if (inside) {
            if (run && t - run.t1 > RUN_GAP_S) { runs.push(run); run = null; }
            if (!run) run = { recs: [], t0: t, t1: t };
            run.t1 = t;
            run.recs.push(rec);
          }
        }
        if (run) runs.push(run);
      }
      if (!runs.length) continue;

      // merge close-together runs, then summarize each into an event
      runs.sort((a, b) => a.t0 - b.t0);
      const merged = [runs[0]];
      for (let k = 1; k < runs.length; k++) {
        const m = merged[merged.length - 1];
        if (runs[k].t0 - m.t1 <= MERGE_S) {
          m.t1 = runs[k].t1;
          m.recs.push(...runs[k].recs);
        } else merged.push(runs[k]);
      }
      const totalDur = merged.reduce((s, r) => s + (r.t1 - r.t0), 0);

      for (const r of merged) {
        let cpa = r.recs[0];
        let tier = 0;
        for (const rec of r.recs) {
          if (rec.slant < cpa.slant) cpa = rec;
          if (rec.tier > tier) tier = rec.tier;
        }
        const midLat = (cpa.a.lat + cpa.b.lat) / 2;
        const midLon = (cpa.a.lon + cpa.b.lon) / 2;
        const tags = [];
        if (KANP.distNm(midLat, midLon) <= 2 &&
            Math.max(cpa.a.alt, cpa.b.alt) <= 1500) tags.push('pattern');
        if (totalDur >= FORMATION_S) tags.push('formation?');
        events.push({
          A, B, regA: A.reg, regB: B.reg,
          t0: r.t0, t1: r.t1, dur: r.t1 - r.t0,
          cpaT: cpa.t, hCpaNm: cpa.hNm, vCpa: cpa.v,
          minHNm: Math.min(...r.recs.map(q => q.hNm)),
          altA: cpa.a.alt, altB: cpa.b.alt,
          gsA: cpa.a.gs, gsB: cpa.b.gs,
          cpaLatA: cpa.a.lat, cpaLonA: cpa.a.lon,
          cpaLatB: cpa.b.lat, cpaLonB: cpa.b.lon,
          slant: cpa.slant, sev: tier, tags,
        });
      }
    }

    events.sort((a, b) => b.sev - a.sev || a.slant - b.slant);
    return events;
  }

  // ---- results table ----
  function renderTable() {
    const tbody = document.querySelector('#conflict-table tbody');
    tbody.innerHTML = '';
    last.events.slice(0, 200).forEach((ev, idx) => {
      const s = SEV[ev.sev];
      const tr = document.createElement('tr');
      tr.style.cursor = 'pointer';
      tr.innerHTML = [
        `<span style="color:${s.color};font-weight:600">${s.name}</span>`,
        fmtTs(ev.cpaT, true),
        acLink(ev.A, COLORS[0]),
        acLink(ev.B, COLORS[1]),
        fmtSep(ev.hCpaNm),
        Math.round(ev.vCpa),
        `${Math.round(ev.altA)} / ${Math.round(ev.altB)}`,
        `${ev.dur}s`,
        ev.tags.join(' · ') || '—',
        '<span style="color:#4a9eff">▶ replay</span>',
      ].map(c => `<td>${c}</td>`).join('');
      tr.addEventListener('click', e => {
        if (e.target.closest('a')) return;
        tbody.querySelectorAll('tr').forEach(r => r.style.background = '');
        tr.style.background = 'rgba(74,158,255,0.08)';
        openAnim(ev);
      });
      tbody.appendChild(tr);
    });
    const note = document.getElementById('conflict-table-note');
    note.textContent = last.events.length > 200
      ? `Showing the 200 most severe of ${last.events.length} events.` : '';
  }

  function acLink(tr, color) {
    const label = tr.flight && tr.flight !== tr.reg
      ? `${tr.reg} (${tr.flight})` : tr.reg;
    return `<a href="https://globe.adsbexchange.com/?icao=${encodeURIComponent(tr.hex)}"` +
      ` target="_blank" rel="noopener" style="color:${color}">${label}</a>` +
      (tr.type ? ` <span style="color:#666">${tr.type}</span>` : '');
  }

  // ---- animation ----
  function ensureMap() {
    if (map) return;
    map = L.map('conflict-map', { layers: [] })
      .setView([KANP.LAT, KANP.LON], 12);
    const bases = KANP.baseLayers();
    bases['Dark'].addTo(map);
    const all = KANP.overlayLayers();
    const overlays = {
      'VFR Sectional (inverted)': all['VFR Sectional (inverted)'],
      'VFR Terminal (TAC)': all['VFR Terminal (TAC)'],
    };
    const ctl = L.control.layers(bases, overlays, { collapsed: true }).addTo(map);
    KANP.addOpacitySliders(ctl, overlays);
    KANP.addAirport(map);
  }

  function openAnim(ev) {
    stopAnim();
    const card = document.getElementById('conflict-anim');
    card.style.display = '';
    document.getElementById('conflict-anim-title').style.display = '';
    ensureMap();
    map.invalidateSize();
    if (animLayer) animLayer.remove();
    animLayer = L.layerGroup().addTo(map);

    // replay window: CPA ± pad, clamped to where either aircraft has data
    const span = tr => [
      Math.min(...tr.segs.map(s => s[0][0])),
      Math.max(...tr.segs.map(s => s[s.length - 1][0]))];
    const [a0, a1] = span(ev.A), [b0, b1] = span(ev.B);
    const T0 = Math.max(ev.cpaT - REPLAY_PAD_S, Math.min(a0, b0));
    const T1 = Math.min(ev.cpaT + REPLAY_PAD_S, Math.max(a1, b1));

    // pre-sample both aircraft at 1 s for the window
    const states = [];
    for (let t = T0; t <= T1; t++) states.push([posAt(ev.A, t), posAt(ev.B, t)]);

    // faint full paths
    [0, 1].forEach(k => {
      const path = states.map(s => s[k]).filter(Boolean)
        .map(s => [s.lat, s.lon]);
      if (path.length > 1) L.polyline(path, {
        color: COLORS[k], weight: 1.5, opacity: 0.35, interactive: false,
      }).addTo(animLayer);
    });

    // CPA markers + dashed connector
    const xIcon = col => L.divIcon({
      className: '', iconAnchor: [6, 8],
      html: `<div style="color:${col};font-size:15px;font-weight:700;` +
        `text-shadow:0 0 4px #000">×</div>`,
    });
    L.marker([ev.cpaLatA, ev.cpaLonA], { icon: xIcon(COLORS[0]), interactive: false }).addTo(animLayer);
    L.marker([ev.cpaLatB, ev.cpaLonB], { icon: xIcon(COLORS[1]), interactive: false }).addTo(animLayer);
    L.polyline([[ev.cpaLatA, ev.cpaLonA], [ev.cpaLatB, ev.cpaLonB]], {
      color: '#ef4444', weight: 1.5, dashArray: '4 4', interactive: false,
    }).addTo(animLayer).bindTooltip(
      `CPA ${fmtSep(ev.hCpaNm)} / ${Math.round(ev.vCpa)} ft`, { permanent: false });

    // moving markers, trails, live connector
    const mkIcon = col => L.divIcon({
      className: '', iconAnchor: [8, 9],
      html: `<div style="width:0;height:0;border-left:8px solid transparent;` +
        `border-right:8px solid transparent;border-bottom:18px solid ${col};` +
        `filter:drop-shadow(0 0 3px ${col});transform-origin:50% 60%"></div>`,
    });
    const markers = [0, 1].map(k =>
      L.marker([KANP.LAT, KANP.LON], { icon: mkIcon(COLORS[k]), interactive: false })
        .addTo(animLayer));
    const trails = [0, 1].map(k => L.polyline([], {
      color: COLORS[k], weight: 3, opacity: 0.9, interactive: false,
    }).addTo(animLayer));
    const connector = L.polyline([], {
      color: '#fff', weight: 1, opacity: 0.65, dashArray: '2 5', interactive: false,
    }).addTo(animLayer);

    const bounds = L.latLngBounds(
      states.flatMap(s => s.filter(Boolean).map(q => [q.lat, q.lon])));
    if (bounds.isValid()) map.fitBounds(bounds.pad(0.25));

    const scrub = document.getElementById('conflict-scrub');
    scrub.min = 0; scrub.max = T1 - T0; scrub.step = 0.5; scrub.value = 0;

    anim = { ev, states, T0, T1, t: T0, markers, trails, connector,
             playing: true, lastFrame: null };
    document.getElementById('conflict-play').textContent = '⏸';
    requestAnimationFrame(frame);
  }

  function stateAt(t) {
    // fractional lerp over the 1 s pre-samples for smooth motion
    const { states, T0, T1 } = anim;
    const ft = Math.min(Math.max(t, T0), T1) - T0;
    const i = Math.min(Math.floor(ft), states.length - 1);
    const f = ft - i;
    return [0, 1].map(k => {
      const a = states[i][k], b = states[Math.min(i + 1, states.length - 1)][k];
      if (!a || !b) return a || null;
      return {
        lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f,
        alt: a.alt + (b.alt - a.alt) * f,
        gs: (a.gs != null && b.gs != null) ? a.gs + (b.gs - a.gs) * f : a.gs,
      };
    });
  }

  function frame(now) {
    if (!anim) return;
    if (anim.playing) {
      const speed = +document.getElementById('conflict-speed').value;
      if (anim.lastFrame != null) anim.t += (now - anim.lastFrame) / 1000 * speed;
      anim.lastFrame = now;
      if (anim.t >= anim.T1) {
        anim.t = anim.T1;
        anim.playing = false;
        document.getElementById('conflict-play').textContent = '↻';
      }
    } else anim.lastFrame = now;
    drawFrame();
    requestAnimationFrame(frame);
  }

  function drawFrame() {
    const { t, T0, markers, trails, connector } = anim;
    const cur = stateAt(t);

    [0, 1].forEach(k => {
      const s = cur[k];
      const el = markers[k].getElement();
      if (!s) { if (el) el.style.display = 'none'; return; }
      if (el) el.style.display = '';
      markers[k].setLatLng([s.lat, s.lon]);
      // rotate the triangle along the direction of motion
      const ahead = stateAt(Math.min(t + 3, anim.T1))[k];
      if (el && ahead && (ahead.lat !== s.lat || ahead.lon !== s.lon)) {
        const crs = Math.atan2(
          (ahead.lon - s.lon) * Math.cos(s.lat * DEG), ahead.lat - s.lat) / DEG;
        el.firstChild.style.transform = `rotate(${crs}deg)`;
      }
      const trail = [];
      for (let tt = Math.max(T0, t - TRAIL_S); tt <= t; tt += 1) {
        const q = stateAt(tt)[k];
        if (q) trail.push([q.lat, q.lon]);
      }
      trails[k].setLatLngs(trail);
    });

    const [a, b] = cur;
    if (a && b) {
      connector.setLatLngs([[a.lat, a.lon], [b.lat, b.lon]]);
      const pa = toXY(a.lat, a.lon), pb = toXY(b.lat, b.lon);
      const hNm = Math.hypot(pa.x - pb.x, pa.y - pb.y);
      const v = Math.abs(a.alt - b.alt);
      document.getElementById('conflict-sep').innerHTML =
        `sep <strong>${fmtSep(hNm)}</strong> / <strong>${Math.round(v)} ft</strong>`;
      document.getElementById('conflict-sep').style.color =
        (hNm * FT_NM < 500 && v < 100) ? '#ef4444'
        : (hNm < 0.15 && v < 200) ? '#f0c040' : '#999';
    } else {
      connector.setLatLngs([]);
      document.getElementById('conflict-sep').textContent = 'sep — (coverage gap)';
    }

    document.getElementById('conflict-readout').innerHTML = [0, 1].map(k => {
      const s = cur[k], tr = k ? anim.ev.B : anim.ev.A;
      return `<span style="color:${COLORS[k]};font-weight:600">${tr.reg}</span> ` +
        (s ? `${Math.round(s.alt).toLocaleString()} ft` +
             (s.gs != null ? ` · ${Math.round(s.gs)} kt` : '') : '—');
    }).join(' &nbsp;·&nbsp; ');

    document.getElementById('conflict-clock').textContent =
      fmtClock(t) + (Math.abs(t - anim.ev.cpaT) < 1 ? '  ← CPA' : '');
    const scrub = document.getElementById('conflict-scrub');
    if (document.activeElement !== scrub) scrub.value = t - T0;
  }

  function togglePlay() {
    if (!anim) return;
    if (!anim.playing && anim.t >= anim.T1) anim.t = anim.T0;   // restart
    anim.playing = !anim.playing;
    document.getElementById('conflict-play').textContent = anim.playing ? '⏸' : '▶';
  }

  function onScrub() {
    if (!anim) return;
    anim.t = anim.T0 + +document.getElementById('conflict-scrub').value;
    if (!anim.playing) drawFrame();
  }

  function stopAnim() {
    if (anim) anim.playing = false;
    anim = null;
    document.getElementById('conflict-play').textContent = '▶';
  }

  // ---- formatting ----
  function fmtSep(nm) {
    return nm < 0.165 ? `${Math.round(nm * FT_NM).toLocaleString()} ft`
      : `${nm.toFixed(2)} nm`;
  }

  function fmtTs(ts, withTime) {
    const d = new Date(ts * 1000);
    const date = d.toLocaleDateString('en-US',
      { timeZone: TZ, month: 'short', day: 'numeric' });
    return withTime === false ? date : `${date} ` + d.toLocaleTimeString('en-US',
      { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
  }

  function fmtClock(ts) {
    const d = new Date(ts * 1000);
    const local = d.toLocaleTimeString('en-US',
      { timeZone: TZ, hour: 'numeric', minute: '2-digit', second: '2-digit' });
    const z = d.toISOString().slice(11, 19);
    return `${fmtTs(ts, false)} ${local} (${z}Z)`;
  }

  return {};
})();
