// KANP Flight Tracker — History Map tab
// tar1090-style altitude-colored tracks from the Pi collector database,
// with FAA VFR chart + NEXRAD weather overlay layers.

const KANPHistory = (() => {
  let map = null;
  let trackCanvas = null;       // single-canvas track layer, see TrackCanvas below
  let fullData = null;          // last fetched dataset; instant filters redraw from this
  let lastShown = null;         // most recent filtered set, for the deferred Lee list
  let leeTimer = null;          // defers the heavy ops analysis off the redraw path
  const GAP_SECONDS = 300;      // start a new segment after this gap
  const ALT_BUCKET_FT = 500;    // color resolution along a track
  const ALT_MAX = 40000;        // top of the altitude band scale
  const ALT_STEP = 500;
  // Floor/ceiling of the altitude band beside the map. Ceiling at ALT_MAX means
  // "no ceiling"; floor 0 means "no floor". Defaults to the 0–5,000 ft slice
  // where the airport-pattern traffic lives.
  const altState = { floor: 0, ceil: 5000 };
  // Only when the *drawn* set (after every filter) exceeds this many points do
  // we coarsen it to stay responsive — so a handful of tracks never triggers it.
  const DRAW_LIMIT = 250_000;

  function init() {
    KANP.initFilterBar('hist-filters');
    document.getElementById('hist-load').addEventListener('click', load);
    initAltPanel();
    initInstantControls();
    drawAltLegend();
    window.addEventListener('resize', renderWeekGrid);
    // If starting on this tab, build the map and load right away
    // (onShow auto-loads on first show)
    if (document.getElementById('tab-history').classList.contains('active')) onShow();
  }

  // One vertical altitude-band slider beside the map: drag the top edge to set
  // the ceiling, the bottom edge to set the floor, or the middle to slide the
  // whole slice up/down. The scale behind it is the tar1090 altitude gradient,
  // shaded outside the selection. Readouts update live while dragging; the map
  // redraws on release.
  function initAltPanel() {
    const track = document.getElementById('hist-alt-track');
    if (!track) return;
    const band = document.getElementById('hist-alt-band');
    const shadeTop = track.querySelector('.alt-shade.top');
    const shadeBot = track.querySelector('.alt-shade.bot');
    const floorNum = document.getElementById('hist-floor-num');
    const ceilNum = document.getElementById('hist-ceil-num');
    const HANDLE_PX = 12;      // grab tolerance around each band edge
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

    // altitude gradient scale (stretched by CSS)
    const scale = track.querySelector('canvas.alt-scale');
    scale.width = 10; scale.height = 400;
    const c = scale.getContext('2d');
    for (let y = 0; y < scale.height; y++) {
      c.fillStyle = KANP.altColor((1 - y / scale.height) * ALT_MAX, false);
      c.fillRect(0, y, scale.width, 1);
    }

    const layout = () => {
      const topPct = (1 - altState.ceil / ALT_MAX) * 100;
      const botPct = (altState.floor / ALT_MAX) * 100;
      band.style.top = `${topPct}%`;
      band.style.bottom = `${botPct}%`;
      shadeTop.style.height = `${topPct}%`;
      shadeBot.style.height = `${botPct}%`;
      ceilNum.textContent = altState.ceil >= ALT_MAX ? '∞' : altState.ceil.toLocaleString();
      floorNum.textContent = altState.floor.toLocaleString();
    };

    const yToAlt = clientY => {
      const r = track.getBoundingClientRect();
      const frac = 1 - (clientY - r.top) / r.height;
      return Math.round(clamp(frac, 0, 1) * ALT_MAX / ALT_STEP) * ALT_STEP;
    };

    track.addEventListener('pointerdown', e => {
      e.preventDefault();
      const r = track.getBoundingClientRect();
      const ceilY = r.top + (1 - altState.ceil / ALT_MAX) * r.height;
      const floorY = r.top + (1 - altState.floor / ALT_MAX) * r.height;
      // nearest-edge wins inside the grab zones; the middle drags the band
      const mode =
        Math.abs(e.clientY - ceilY) <= HANDLE_PX &&
          Math.abs(e.clientY - ceilY) <= Math.abs(e.clientY - floorY) ? 'ceil'
        : Math.abs(e.clientY - floorY) <= HANDLE_PX ? 'floor'
        : e.clientY > ceilY && e.clientY < floorY ? 'band'
        : e.clientY < ceilY ? 'ceil' : 'floor';   // click outside jumps that edge
      const startAlt = yToAlt(e.clientY);
      const start = { ...altState };

      const apply = ev => {
        const a = yToAlt(ev.clientY);
        if (mode === 'ceil') {
          altState.ceil = clamp(a, start.floor + ALT_STEP, ALT_MAX);
        } else if (mode === 'floor') {
          altState.floor = clamp(a, 0, start.ceil - ALT_STEP);
        } else {
          const span = start.ceil - start.floor;
          altState.floor = clamp(start.floor + (a - startAlt), 0, ALT_MAX - span);
          altState.ceil = altState.floor + span;
        }
        layout();
      };

      track.setPointerCapture(e.pointerId);
      track.classList.add('dragging');
      if (mode !== 'band') apply(e);     // edge grabs / jumps take effect on press
      const move = ev => apply(ev);
      const up = () => {
        track.removeEventListener('pointermove', move);
        track.removeEventListener('pointerup', up);
        track.removeEventListener('pointercancel', up);
        track.classList.remove('dragging');
        render();                        // one redraw when the drag settles
      };
      track.addEventListener('pointermove', move);
      track.addEventListener('pointerup', up);
      track.addEventListener('pointercancel', up);
    });

    // scroll wheel over the band shifts the whole slice up/down — "x-raying"
    // the airspace one step per notch. Filtering is client-side, so redraw
    // immediately on each notch.
    track.addEventListener('wheel', e => {
      e.preventDefault();
      const step = ALT_STEP * (e.deltaY < 0 ? 1 : -1);   // wheel up = higher
      const span = altState.ceil - altState.floor;
      const floor = clamp(altState.floor + step, 0, ALT_MAX - span);
      if (floor === altState.floor) return;              // at an edge
      altState.floor = floor;
      altState.ceil = floor + span;
      layout();
      render();
    }, { passive: false });

    layout();
  }

  // GA / Military / KANP-only toggle buttons — all filter client-side, so a
  // click redraws instantly. KANP-only reveals the arr/dep sub-mode dropdown.
  function initInstantControls() {
    ['hist-ga', 'hist-mil'].forEach(id =>
      document.getElementById(id).addEventListener('click', e => {
        e.currentTarget.classList.toggle('on');
        render();
      }));

    const kanp = document.getElementById('hist-kanp');
    const modeWrap = document.getElementById('hist-kanp-mode-wrap');
    const mode = document.getElementById('hist-arrdep');
    kanp.addEventListener('click', () => {
      const on = kanp.classList.toggle('on');
      mode.disabled = !on;
      modeWrap.style.opacity = on ? '1' : '.4';
      render();
    });
    mode.addEventListener('change', render);
  }

  // The Lee-Airport list re-runs the operations detector over every track and
  // rebuilds a table — too heavy to do inline on each redraw. Defer it so the
  // map paints immediately and the list catches up once interaction settles.
  function scheduleLee() {
    clearTimeout(leeTimer);
    leeTimer = setTimeout(() => { if (lastShown) renderLeeList(lastShown); }, 250);
  }

  function onShow() {
    if (!map) initMap();
    map.invalidateSize();
    // first time the tab is opened (when it wasn't the initial tab): auto-load
    if (!fullData) load();
    if (!weekGrid) loadWeekGrid();
  }

  // ---- trailing-7-days hour × day-of-week grid ----
  let weekGrid = null;

  async function loadWeekGrid() {
    weekGrid = 'loading';
    try {
      const now = Math.floor(Date.now() / 1000);
      const s = await KANP.getStats({ start: now - 7 * 86_400, end: now });
      weekGrid = s.grid_unique_aircraft;
      document.getElementById('hist-grid-label').textContent =
        `${Number(s.totals.aircraft).toLocaleString()} aircraft · ${KANP.sourceLabel(s)}`;
      renderWeekGrid();
    } catch (e) {
      weekGrid = null;
      document.getElementById('hist-grid-empty').textContent =
        'Could not load past-week activity.';
      console.warn('[KANP] history 7-day grid failed:', e.message);
    }
  }

  function renderWeekGrid() {
    if (!weekGrid || weekGrid === 'loading') return;
    document.getElementById('hist-grid-empty').style.display = 'none';
    const canvas = document.getElementById('hist-grid');
    canvas.style.display = 'block';
    KANP.renderGrid(canvas, weekGrid);
  }

  // ---- expandable map: the whole map + altitude panel row goes fullscreen,
  // so the altitude band stays in view and operable while expanded ----
  let expanded = false;

  function initExpand() {
    const Ctl = L.Control.extend({
      options: { position: 'topleft' },
      onAdd() {
        const btn = L.DomUtil.create('button', 'map-expand-btn');
        btn.textContent = '⛶';
        btn.title = 'Expand map (Esc to exit)';
        L.DomEvent.disableClickPropagation(btn);
        btn.addEventListener('click', toggleExpand);
        return btn;
      },
    });
    map.addControl(new Ctl());
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && expanded) toggleExpand();
    });
  }

  function toggleExpand() {
    expanded = !expanded;
    document.querySelector('.hist-map-row').classList.toggle('expanded', expanded);
    document.body.style.overflow = expanded ? 'hidden' : '';
    map.invalidateSize();
  }

  function initMap() {
    map = L.map('hist-map').setView([KANP.LAT, KANP.LON], 8);  // ~60 nm radius in view

    const bases = KANP.baseLayers();
    const overlays = KANP.overlayLayers();
    bases['Dark'].addTo(map);

    trackCanvas = new TrackCanvas().addTo(map);
    overlays['Tracks'] = trackCanvas;
    L.control.layers(bases, overlays, { position: 'topright' }).addTo(map);

    KANP.addAirport(map);
    initExpand();

    // keep NEXRAD current while the page sits open
    const wx = overlays['Weather (NEXRAD)'];
    setInterval(() => { if (map.hasLayer(wx)) wx.redraw(); }, 300_000);
  }

  // Fetch the dataset for the current date range / callsign / hours / days.
  // Altitude, GA, Military and KANP filters are deliberately NOT sent — they're
  // applied client-side in render() so they can update the map without a
  // network round-trip. Ground traffic stays a fetch param (see readFilters).
  async function load() {
    if (!map) initMap();
    const btn = document.getElementById('hist-load');
    const out = document.getElementById('hist-result');
    btn.disabled = true;
    out.textContent = 'Loading tracks…';

    try {
      const params = KANP.readFilters('hist-filters');
      fullData = await KANP.getTracks(params);
      render();
    } catch (e) {
      out.innerHTML = `<span class="err">${e.message}</span>`;
    } finally {
      btn.disabled = false;
    }
  }

  // Apply the instant client-side filters to the last-fetched dataset and draw.
  // Called on every altitude-slider drag and toggle-button click.
  function render() {
    if (!fullData) return;
    const out = document.getElementById('hist-result');

    const floor = altState.floor === 0 ? null : altState.floor;   // 0 = no floor
    const ceil = altState.ceil >= ALT_MAX ? null : altState.ceil; // top = no ceiling
    const ga = document.getElementById('hist-ga').classList.contains('on');
    const mil = document.getElementById('hist-mil').classList.contains('on');

    let tracks = fullData.tracks;
    if (mil) tracks = tracks.filter(t => t.military);
    if (ga) tracks = tracks.filter(t => KANP.isGA(t));
    if (floor != null || ceil != null) {
      tracks = tracks.map(t => ({
        ...t,
        points: t.points.filter(p => {
          const alt = p[3], og = p[5];
          // ground fixes ignore the floor; the ceiling drops anything above it
          if (floor != null && !og && !(alt != null && alt >= floor)) return false;
          if (ceil != null && alt != null && alt > ceil) return false;
          return true;
        }),
      })).filter(t => t.points.length);
    }

    let shown = {
      ...fullData, tracks,
      aircraft_count: tracks.length,
      returned_points: tracks.reduce((n, t) => n + t.points.length, 0),
    };
    shown = applyArrDep(shown);

    // The tracks are already shape-simplified; only if what's actually on the
    // map is still huge do we coarsen further (shape-preserving) to keep it
    // responsive. This is decided on the *drawn* set, so filtering down to a
    // few tracks never limits or warns.
    let coarsened = false;
    if (shown.returned_points > DRAW_LIMIT) {
      shown.tracks = shown.tracks.map(t => ({ ...t, points: KANP.simplifyTrack(t.points, 0.08) }));
      shown.returned_points = shown.tracks.reduce((n, t) => n + t.points.length, 0);
      coarsened = true;
    }

    draw(shown);
    lastShown = shown;
    scheduleLee();               // heavy ops analysis + table, off the redraw path

    const opsLabel = { lee: ' · KANP ops', pattern: ' · closed pattern ops',
                       arr: ' · arrivals', dep: ' · departures',
                       both: ' · arrivals + departures' }[arrDepMode()] || '';
    let msg = `${shown.aircraft_count} aircraft · ` +
      `${Number(shown.returned_points).toLocaleString()} points${opsLabel} · ${KANP.sourceLabel(fullData)}`;
    if (coarsened) {
      msg += ` <span class="warn">— large range coarsened to stay responsive; ` +
        `narrow the dates or add a filter for full detail.</span>`;
    }
    out.innerHTML = msg;
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
      'go-around / low approach = 2 ops (FAA counting); T&Gs are not permitted at KANP, so touch-and-look profiles count as go-arounds';
  }

  // 'all' unless the KANP-only toggle is on, in which case the sub-mode
  // dropdown decides which field operations to keep.
  function arrDepMode() {
    const kanp = document.getElementById('hist-kanp');
    if (!kanp || !kanp.classList.contains('on')) return 'all';
    const sel = document.getElementById('hist-arrdep');
    return sel ? sel.value : 'lee';
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
    // (a go-around session both starts and ends at the field). 'pattern'
    // keeps only aircraft flying closed pattern: at least one go-around
    // detected by the operations detector.
    let tracks;
    if (mode === 'pattern') {
      const contacts = data.tracks.filter(t => KANP.fieldContact(t.points));
      const { ops } = KANPOps.analyze({ tracks: contacts });
      const patternHexes = new Set(
        ops.filter(o => o.kind === 'tng').map(o => o.hex));
      tracks = contacts.filter(t => patternHexes.has(t.hex));
    } else {
      tracks = data.tracks.filter(t => {
        if (mode === 'lee') return KANP.fieldContact(t.points);
        const c = KANP.classifyArrDep(t.points);
        return mode === 'arr' ? c.arrival
             : mode === 'dep' ? c.departure
             : c.arrival || c.departure;   // 'both'
      });
    }
    return {
      ...data,
      tracks,
      aircraft_count: tracks.length,
      returned_points: tracks.reduce((n, t) => n + t.points.length, 0),
    };
  }

  function draw(data) {
    trackCanvas.setData(data.tracks, heatStyle(data.returned_points || 0));
  }

  function bucketKey(p) {
    if (p[5]) return 'ground';
    if (p[3] == null) return 'unknown';
    return Math.floor(p[3] / ALT_BUCKET_FT);
  }

  // ---------------------------------------------------------------------------
  // TrackCanvas — all trails on ONE canvas element.
  //
  // The old approach created an L.polyline layer per constant-color run:
  // thousands of Leaflet layer objects (with popup bindings) torn down and
  // rebuilt on every filter change, which is what made the trails laggy. Here
  // setData() splits tracks once into gap-free, constant-color runs, and
  // _redraw() strokes them straight onto a single canvas. Each run is still its
  // own stroke so overlapping trails accumulate into the heat-map look, and
  // clicking the map hit-tests the drawn runs to show the same popup as before.
  // ---------------------------------------------------------------------------
  const TrackCanvas = L.Layer.extend({
    initialize() {
      this._runs = [];
      this._style = { weight: 1.2, opacity: 0.45 };
      this._hit = [];
    },

    setData(tracks, style) {
      this._style = style;
      const runs = [];
      for (const t of tracks) {
        let run = null, key = null, prevTs = null;
        for (const p of t.points) {
          const k = bucketKey(p);
          if (run && (p[0] - prevTs > GAP_SECONDS)) {         // coverage gap
            if (run.pts.length > 1) runs.push(run);
            run = null;
          }
          if (run && k !== key) {                              // color change
            run.pts.push(p);                                   // share boundary point
            if (run.pts.length > 1) runs.push(run);
            run = null;
          }
          if (!run) { run = { t, pts: [p] }; key = k; }
          else run.pts.push(p);
          prevTs = p[0];
        }
        if (run && run.pts.length > 1) runs.push(run);
      }
      // color + latlng bbox per run; sort by color so strokeStyle rarely changes
      for (const r of runs) {
        const mid = r.pts[Math.floor(r.pts.length / 2)];
        r.color = KANP.altColor(mid[3], mid[5]);
        let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
        for (const p of r.pts) {
          if (p[1] < a) a = p[1];
          if (p[2] < b) b = p[2];
          if (p[1] > c) c = p[1];
          if (p[2] > d) d = p[2];
        }
        r.bbox = [a, b, c, d];
      }
      runs.sort((x, y) => (x.color < y.color ? -1 : x.color > y.color ? 1 : 0));
      this._runs = runs;
      if (this._map) this._redraw();
    },

    onAdd(map) {
      this._canvas = L.DomUtil.create('canvas', 'leaflet-zoom-animated');
      map.getPane('overlayPane').appendChild(this._canvas);
      map.on('viewreset zoomend moveend resize', this._reset, this);
      if (map.options.zoomAnimation && L.Browser.any3d) {
        map.on('zoomanim', this._animateZoom, this);
      }
      map.on('click', this._onClick, this);
      this._reset();
    },

    onRemove(map) {
      L.DomUtil.remove(this._canvas);
      map.off('viewreset zoomend moveend resize', this._reset, this);
      map.off('zoomanim', this._animateZoom, this);
      map.off('click', this._onClick, this);
    },

    // scale the canvas with CSS during the zoom animation, like ImageOverlay.
    // If this Leaflet build lacks the helper, skip it — the canvas then simply
    // repaints at zoomend instead of animating.
    _animateZoom(e) {
      if (!this._map._latLngBoundsToNewLayerBounds) return;
      const scale = this._map.getZoomScale(e.zoom);
      const offset = this._map._latLngBoundsToNewLayerBounds(
        this._map.getBounds(), e.zoom, e.center).min;
      L.DomUtil.setTransform(this._canvas, offset, scale);
    },

    _reset() {
      const size = this._map.getSize();
      const dpr = window.devicePixelRatio || 1;
      L.DomUtil.setPosition(this._canvas, this._map.containerPointToLayerPoint([0, 0]));
      this._canvas.width = Math.round(size.x * dpr);
      this._canvas.height = Math.round(size.y * dpr);
      this._canvas.style.width = `${size.x}px`;
      this._canvas.style.height = `${size.y}px`;
      this._dpr = dpr;
      this._redraw();
    },

    _redraw() {
      const map = this._map;
      const size = map.getSize();
      const ctx = this._canvas.getContext('2d');
      ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
      ctx.clearRect(0, 0, size.x, size.y);
      ctx.lineWidth = this._style.weight;
      ctx.globalAlpha = this._style.opacity;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      const vb = map.getBounds().pad(0.06);
      const s = vb.getSouth(), w = vb.getWest(), n = vb.getNorth(), e = vb.getEast();
      this._hit = [];
      let color = null;
      for (const r of this._runs) {
        const [a, b, c, d] = r.bbox;                 // cull off-screen runs
        if (c < s || a > n || d < w || b > e) continue;
        if (r.color !== color) { ctx.strokeStyle = color = r.color; }
        const pts = r.pts;
        const xs = new Float32Array(pts.length);
        const ys = new Float32Array(pts.length);
        ctx.beginPath();
        for (let i = 0; i < pts.length; i++) {
          const cp = map.latLngToContainerPoint([pts[i][1], pts[i][2]]);
          xs[i] = cp.x; ys[i] = cp.y;
          if (i === 0) ctx.moveTo(cp.x, cp.y);
          else ctx.lineTo(cp.x, cp.y);
        }
        ctx.stroke();                                // per-run stroke keeps the heat look
        this._hit.push({ xs, ys, run: r });
      }
    },

    // click → nearest drawn run within tolerance → same popup as before
    _onClick(e) {
      const { x, y } = e.containerPoint;
      const TOL2 = 8 * 8;
      let best = null, bestD = TOL2;
      for (const h of this._hit) {
        const { xs, ys } = h;
        for (let i = 1; i < xs.length; i++) {
          const d = distSq(x, y, xs[i - 1], ys[i - 1], xs[i], ys[i]);
          if (d < bestD) { bestD = d; best = h.run; }
        }
      }
      if (!best) return;
      const t = best.t;
      const label =
        `<strong>${t.flight || t.reg || t.hex}</strong>` +
        (t.reg ? ` · ${t.reg}` : '') +
        (t.type ? ` · ${t.type}` : '') +
        (t.military ? ' · MIL' : '') +
        (t.descr ? `<br>${t.descr}` : '');
      L.popup().setLatLng(e.latlng)
        .setContent(popupHtml(label, best.pts, t))
        .openOn(this._map);
    },
  });

  // squared distance from point (px,py) to segment (x1,y1)-(x2,y2)
  function distSq(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const seg2 = dx * dx + dy * dy;
    let t = seg2 === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / seg2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = px - (x1 + t * dx), ey = py - (y1 + t * dy);
    return ex * ex + ey * ey;
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
    const W = 340, H = 10;
    const ctx = KANP.setupCanvas(canvas, W, H);
    for (let x = 0; x < W; x++) {
      const alt = (x / W) * 40000;
      ctx.fillStyle = KANP.altColor(alt, false);
      ctx.fillRect(x, 0, 1, H);
    }
  }

  return { init, onShow };
})();
