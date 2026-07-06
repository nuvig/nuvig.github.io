// KANP Flight Tracker — History Map tab
// tar1090-style altitude-colored tracks from the Pi collector database,
// with FAA VFR chart + NEXRAD weather overlay layers.

const KANPHistory = (() => {
  let map = null;
  let trackLayer = null;
  let renderer = null;
  let trailStyle = { weight: 1.2, opacity: 0.45 };  // recomputed per load, see heatStyle()
  const GAP_SECONDS = 300;      // start a new segment after this gap
  const ALT_BUCKET_FT = 500;    // color resolution along a track

  function init() {
    KANP.initFilterBar('hist-filters');
    document.getElementById('hist-load').addEventListener('click', load);
    drawAltLegend();
    // History Map is the default tab: build the map and load tracks right away
    if (document.getElementById('tab-history').classList.contains('active')) {
      onShow();
      load();
    }
  }

  function onShow() {
    if (!map) initMap();
    map.invalidateSize();
  }

  function initMap() {
    map = L.map('hist-map').setView([KANP.LAT, KANP.LON], 8);  // ~60 nm radius in view
    renderer = L.canvas({ padding: 0.4 });

    const bases = KANP.baseLayers();
    const overlays = KANP.overlayLayers();
    bases['Dark'].addTo(map);

    trackLayer = L.layerGroup().addTo(map);
    overlays['Tracks'] = trackLayer;
    L.control.layers(bases, overlays, { position: 'topright' }).addTo(map);

    KANP.addAirport(map);

    // keep NEXRAD current while the page sits open
    const wx = overlays['Weather (NEXRAD)'];
    setInterval(() => { if (map.hasLayer(wx)) wx.redraw(); }, 300_000);
  }

  async function load() {
    if (!map) initMap();
    const btn = document.getElementById('hist-load');
    const out = document.getElementById('hist-result');
    btn.disabled = true;
    out.textContent = 'Loading tracks…';

    try {
      const params = KANP.readFilters('hist-filters');
      const data = await KANP.getTracks(params);
      const shown = applyArrDep(data);
      draw(shown);
      renderLeeList(shown);

      const opsLabel = { arr: ' · arrivals', dep: ' · departures',
                         both: ' · arrivals + departures' }[arrDepMode()] || '';
      let msg = `${shown.aircraft_count} aircraft · ` +
        `${Number(shown.returned_points).toLocaleString()} points${opsLabel} · ${KANP.sourceLabel(data)}`;
      if (data.stride > 1) {
        msg += ` <span class="warn">(decimated 1:${data.stride} of ` +
          `${Number(data.total_points).toLocaleString()} — narrow the range for full detail)</span>`;
      }
      out.innerHTML = msg;
    } catch (e) {
      out.innerHTML = `<span class="err">${e.message}</span>`;
    } finally {
      btn.disabled = false;
    }
  }

  // Collapsed per-aircraft summary of Lee Airport activity for whatever is
  // currently drawn on the map, using the operations detector from kanp-ops.js.
  function renderLeeList(shown) {
    const details = document.getElementById('lee-list');
    const { ops } = KANPOps.analyze(shown);

    const byAc = new Map();
    shown.tracks.forEach(t => {
      byAc.set(t.hex, {
        hex: t.hex, reg: t.reg, type: t.type, military: t.military,
        callsigns: t.flight || '', arr: 0, dep: 0, tng: 0, unk: 0, opsN: 0,
        last: t.points.length ? t.points[t.points.length - 1][0] : 0,
      });
    });
    ops.forEach(o => {
      const e = byAc.get(o.hex);
      if (!e) return;
      e[o.kind === 'unk' ? 'unk' : o.kind]++;
      e.opsN += o.kind === 'tng' ? 2 : 1;
    });

    const leeAc = [...byAc.values()].filter(e => e.opsN > 0)
      .sort((a, b) => b.opsN - a.opsN || b.last - a.last);
    const overflights = byAc.size - leeAc.length;
    const totalOps = leeAc.reduce((n, e) => n + e.opsN, 0);

    details.style.display = '';
    document.getElementById('lee-list-summary').innerHTML =
      `Lee Airport activity — <span class="cnt">${leeAc.length}</span> aircraft, ` +
      `<span class="cnt">${totalOps}</span> ops` +
      `<span class="sub">${overflights} others in view never touched the field · click to expand</span>`;

    const tbody = document.querySelector('#lee-table tbody');
    tbody.innerHTML = '';
    leeAc.slice(0, 300).forEach(e => {
      const tr = document.createElement('tr');
      const reg = `<a href="https://globe.adsbexchange.com/?icao=${encodeURIComponent(e.hex)}"` +
        ` target="_blank" rel="noopener">${e.reg || e.hex}</a>` +
        (e.military ? '<span class="mil-tag">MIL</span>' : '');
      tr.innerHTML = [
        reg, e.type || '—', e.callsigns || '—',
        e.arr, e.dep, e.tng, e.opsN,
        new Date(e.last * 1000).toLocaleString(),
      ].map(c => `<td>${c}</td>`).join('');
      tbody.appendChild(tr);
    });
    document.getElementById('lee-list-note').textContent =
      (leeAc.length > 300 ? `showing first 300 of ${leeAc.length} aircraft · ` : '') +
      (leeAc.reduce((n, e) => n + e.unk, 0)
        ? 'some field contacts had no airborne context (coverage gaps) and count as 1 op each · ' : '') +
      'touch-and-go = 2 ops (FAA counting); low passes and stop-and-gos are indistinguishable from touch-and-gos in ADS-B data';
  }

  function arrDepMode() {
    const sel = document.querySelector('#hist-filters [data-f=arrdep]');
    return sel ? sel.value : 'all';
  }

  // Restrict the drawn tracks to KANP arrivals / departures (classified from
  // each track's trajectory). Returns a shallow copy with filtered tracks and
  // recomputed counts so the count message and heat-map opacity both reflect
  // what's actually on the map.
  function applyArrDep(data) {
    const mode = arrDepMode();
    if (mode === 'all') return data;
    // 'lee' keeps anything that touched the field — arrivals, departures AND
    // local pattern work, which the endpoint-based arr/dep classifier misses
    // (a touch-and-go session both starts and ends at the field).
    const tracks = data.tracks.filter(t => {
      if (mode === 'lee') return KANP.fieldContact(t.points);
      const c = KANP.classifyArrDep(t.points);
      return mode === 'arr' ? c.arrival
           : mode === 'dep' ? c.departure
           : c.arrival || c.departure;   // 'both'
    });
    return {
      ...data,
      tracks,
      aircraft_count: tracks.length,
      returned_points: tracks.reduce((n, t) => n + t.points.length, 0),
    };
  }

  function draw(data) {
    trackLayer.clearLayers();
    trailStyle = heatStyle(data.returned_points || 0);

    data.tracks.forEach(t => {
      const label =
        `<strong>${t.flight || t.reg || t.hex}</strong>` +
        (t.reg ? ` · ${t.reg}` : '') +
        (t.type ? ` · ${t.type}` : '') +
        (t.military ? ' · MIL' : '') +
        (t.descr ? `<br>${t.descr}` : '');

      // split into gap-free segments, then into constant-color runs
      let seg = [];
      const flush = () => {
        if (seg.length > 1) drawSegment(seg, label, t);
        seg = [];
      };

      let prevTs = null;
      for (const p of t.points) {
        if (prevTs != null && p[0] - prevTs > GAP_SECONDS) flush();
        seg.push(p);
        prevTs = p[0];
      }
      flush();
    });
  }

  function drawSegment(points, label, t) {
    // group consecutive points whose altitude falls in the same color bucket
    let run = [points[0]];
    let runKey = bucketKey(points[0]);

    const emit = () => {
      if (run.length < 2) return;
      const mid = run[Math.floor(run.length / 2)];
      const color = KANP.altColor(mid[3], mid[5]);
      const line = L.polyline(run.map(p => [p[1], p[2]]), {
        renderer, color, weight: trailStyle.weight, opacity: trailStyle.opacity,
      }).addTo(trackLayer);
      line.bindPopup(popupHtml(label, run, t));
    };

    for (let i = 1; i < points.length; i++) {
      const key = bucketKey(points[i]);
      run.push(points[i]);           // share the boundary point so runs connect
      if (key !== runKey) {
        emit();
        run = [points[i]];
        runKey = key;
      }
    }
    emit();
  }

  function bucketKey(p) {
    if (p[5]) return 'ground';
    if (p[3] == null) return 'unknown';
    return Math.floor(p[3] / ALT_BUCKET_FT);
  }

  // Thin, translucent trails so overlapping traffic reads as a heat map rather
  // than a wall of solid lines: a single pass is faint, but a corridor flown
  // many times accumulates into bright, saturated color. Per-trail opacity
  // scales down as the day gets busier so density does the work — a quiet day
  // (or a single replayed flight) still shows bold, legible tracks.
  function heatStyle(points) {
    const opacity = Math.max(0.1, Math.min(0.55, 24 / Math.sqrt(Math.max(points, 1))));
    return { weight: 1.2, opacity };
  }

  function popupHtml(label, run, t) {
    const p = run[Math.floor(run.length / 2)];
    const alt = p[5] ? 'ground' : p[3] != null ? `${p[3].toLocaleString()} ft` : 'alt unknown';
    const gs = p[4] != null ? ` · ${Math.round(p[4])} kts` : '';
    const when = new Date(p[0] * 1000).toLocaleString();
    return `${label}<br>${alt}${gs}<br><span style="color:#888">${when}</span>`;
  }

  function drawAltLegend() {
    const canvas = document.getElementById('alt-legend-bar');
    const ctx = canvas.getContext('2d');
    for (let x = 0; x < canvas.width; x++) {
      const alt = (x / canvas.width) * 40000;
      ctx.fillStyle = KANP.altColor(alt, false);
      ctx.fillRect(x, 0, 1, canvas.height);
    }
  }

  return { init, onShow };
})();
