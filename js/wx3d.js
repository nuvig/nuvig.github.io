// The Air Above — the forecast drawn as a rotatable 3-D block of sky.
//
// One orthographic camera orbits a volume ~120 nm wide and 40,000 ft tall
// centered on the field. Every horizontal surface (the ground map, each
// cloud deck) is an offscreen texture drawn with a single affine transform —
// legal because the projection is orthographic, so a horizontal plane maps
// to a parallelogram — and everything else (winds, the freezing surface,
// precip columns, the wind-barb staff) is projected vector work. The scene
// is painted bottom-up, which is the correct painter's order for stacked
// horizontal layers seen from above (pitch is clamped ≥ 3° — at 0° a horizontal
// plane projects to a zero-height parallelogram, so the decks and the ground
// map would vanish and coplanar layers would have no painter order at all).
//
// Data (all directions °true, like everywhere on this site):
//  · Open-Meteo, models=gfs_seamless (NOAA GFS, HRRR-blended near-term):
//    one multi-location call for a 5×5 grid of columns — per-level cloud
//    cover / RH / wind, plus precip, CAPE and freezing-level height — and
//    one full-fidelity call at the field (adds temperature, dewpoint and
//    geopotential heights) for the readout column and the level altitudes.
//  · api.weather.gov for the KNAK METAR line (KANP has no on-field sensor).
//  · RainViewer for the radar frame draped on the ground — only at the
//    "now" hour; every other hour shows the model's precip instead.

(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  // the volume's center — SITE.weather.wx3d (KDCA), not the home field;
  // the home field draws as a landmark pin instead
  const A = (SITE.weather && SITE.weather.wx3d) || SITE.airport;
  const TZ = SITE.weather.timeZone;
  const D2R = Math.PI / 180, TAU = Math.PI * 2;
  const M2FT = 3.28084;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };

  // ------------------------------------------------------------ the volume
  // Two nested domains share every drawing and data path: the local box the
  // page opens on, and a multi-state box (~750 statute miles) reached by
  // zooming out past the local limit or via the chips in the top bar.
  // applyGeometry() re-derives every box-shaped value when the domain flips;
  // everything downstream just reads the module vars.
  const KM_LAT = 111.32;
  // one mid-box E–W scale (edges of the wide box run ±8% — fine for weather)
  const KM_LON = 111.32 * Math.cos(A.lat * D2R);
  const TOP_FT = 40000;
  // vertical exaggeration (km world per km alt) — user-adjustable via the
  // top-bar slider; setZScale() re-derives everything cached in world z.
  const VEX_MIN = 1, VEX_MAX = 20, VEX_DEF = 7.5;
  let ZSCALE = VEX_DEF;
  const zOf = (ft) => ft * 0.0003048 * ZSCALE;
  let TOP_Z = zOf(TOP_FT);
  const DOMAINS = {
    local: { gn: 5, spanLat: 2.0, spanLon: 2.5, terrUrl: 'data/wx3d/terrain.json',
             grat: 0.5, radarZ: 7, meshMin: 90, meshStep: 3,
             flowBoost: 1, rh: true, label: '5×5 model grid · ~120 nm across' },
    wide:  { gn: 7, spanLat: 10.8, spanLon: 13.9, terrUrl: 'data/wx3d/terrain-wide.json',
             grat: 2, radarZ: 5, meshMin: 300, meshStep: 4,
             flowBoost: 3, rh: false, label: '7×7 model grid · ~650 nm across' },
  };
  const SPAN_RATIO = DOMAINS.wide.spanLon / DOMAINS.local.spanLon;   // ≈5.6
  let DK = 'local';                    // active domain key
  let GN, SPAN_LAT, SPAN_LON, HALF_X, HALF_Y, latN, latS, lonW, lonE;
  let lats = [], lons = [], gx = [], gy = [];
  function applyGeometry(d) {
    GN = d.gn; SPAN_LAT = d.spanLat; SPAN_LON = d.spanLon;
    HALF_X = SPAN_LON / 2 * KM_LON;
    HALF_Y = SPAN_LAT / 2 * KM_LAT;
    latN = A.lat + SPAN_LAT / 2; latS = A.lat - SPAN_LAT / 2;
    lonW = A.lon - SPAN_LON / 2; lonE = A.lon + SPAN_LON / 2;
    lats = []; lons = [];              // grid rows N→S, columns W→E
    for (let i = 0; i < GN; i++) {
      lats.push(latN - i * SPAN_LAT / (GN - 1));
      lons.push(lonW + i * SPAN_LON / (GN - 1));
    }
    gy = lats.map((la) => (la - A.lat) * KM_LAT);   // world y of each row
    gx = lons.map((lo) => (lo - A.lon) * KM_LON);   // world x of each column
  }
  applyGeometry(DOMAINS.local);
  function blankTerr() {
    return { ok: false, tried: false, nx: 0, ny: 0, lat0: 0, lon0: 0, dlat: 0, dlon: 0,
             elev: null, shade: null, mesh: [], marks: [] };
  }
  // per-domain caches so flipping back is instant
  const domCache = {
    local: { hourly: null, times: null, pending: null, terr: blankTerr(), ground: null, radar: null },
    wide:  { hourly: null, times: null, pending: null, terr: blankTerr(), ground: null, radar: null },
  };

  const LEVELS = [1000, 925, 850, 700, 600, 500, 400, 300, 250, 200];
  // standard-atmosphere heights, ft — fallback if the field column never loads
  const STD_FT = { 1000: 360, 925: 2500, 850: 4780, 700: 9880, 600: 13800, 500: 18280, 400: 23570, 300: 30060, 250: 34000, 200: 38660 };
  const levelTint = (p) => p >= 850 ? [150, 159, 172] : p >= 500 ? [188, 197, 212] : [222, 231, 245];

  // ------------------------------------------------------------ state
  const state = {
    sel: 0, nowIdx: 0,
    yaw: 0, pitch: 35, zoom: 1,
    panX: 0, panY: 0,                  // screen-px view offset (shift/right-drag)
    layers: { cl: true, fz: true, pr: true, gd: true },
    wind: '850',                       // 'off' | 'flow' | 'sfc' | one of LEVELS as string
    band: [0, TOP_FT],                 // flow-mode altitude filter, ft
    bandLev: null,                     // the winds-aloft chip that set the band, if any
  };
  try {
    const s = JSON.parse(localStorage.getItem('wx3d_layers') || 'null');
    if (s) {
      Object.assign(state.layers, s.layers || {});
      if (s.wind) state.wind = s.wind;
      if (+s.vex) ZSCALE = clamp(+s.vex, VEX_MIN, VEX_MAX);
      if (Array.isArray(s.band) && s.band.length === 2) {
        const lo = clamp(+s.band[0] || 0, 0, TOP_FT), hi = clamp(+s.band[1] || TOP_FT, 0, TOP_FT);
        if (hi - lo >= 1000) state.band = [lo, hi];
      }
      if (typeof s.bandLev === 'string') state.bandLev = s.bandLev;
    }
  } catch (e) { /* private mode */ }
  TOP_Z = zOf(TOP_FT);                 // the stored exaggeration may have changed it
  const persist = () => {
    try {
      localStorage.setItem('wx3d_layers',
        JSON.stringify({ layers: state.layers, wind: state.wind, band: state.band,
                        bandLev: state.bandLev, vex: ZSCALE }));
    } catch (e) { /* private mode */ }
  };

  const data = { grid: null, center: null, times: [] };
  const built = { hour: -1, sheets: [], blobs: null, cols: [], fz: null, hFt: null };
  const radar = { path: '', time: 0, canvas: null, dk: 'local' };
  let dirty = true, playing = false, playTimer = null;

  // ------------------------------------------------------------ fetch
  function gridUrl(k) {
    const d = DOMAINS[k];
    const la = [], lo = [];
    const lat0 = A.lat + d.spanLat / 2, lon0 = A.lon - d.spanLon / 2;
    for (let iy = 0; iy < d.gn; iy++) for (let ix = 0; ix < d.gn; ix++) {
      la.push((lat0 - iy * d.spanLat / (d.gn - 1)).toFixed(3));
      lo.push((lon0 + ix * d.spanLon / (d.gn - 1)).toFixed(3));
    }
    const vars = [];
    for (const L of LEVELS) {
      vars.push(`cloud_cover_${L}hPa`, `wind_speed_${L}hPa`, `wind_direction_${L}hPa`);
      if (d.rh) vars.push(`relative_humidity_${L}hPa`);   // cloud-cover fallback (local only — the wide call is big enough)
    }
    vars.push('precipitation', 'freezing_level_height', 'cape',
              'wind_speed_10m', 'wind_direction_10m');
    return 'https://api.open-meteo.com/v1/forecast?latitude=' + la.join(',') +
      '&longitude=' + lo.join(',') + '&hourly=' + vars.join(',') +
      '&models=gfs_seamless&windspeed_unit=kn&timezone=UTC&forecast_days=3';
  }

  // ---- the hourly snapshot ------------------------------------------------
  // One Actions runner pulls these grids once an hour (scripts/wx3dsnap.py)
  // and force-pushes them to the wx3d-data branch, so a page view costs
  // Open-Meteo nothing. The live API is the fallback, not the default: it is
  // used when the snapshot is unreachable, built for a different box, or old
  // enough that the model has moved on. A stale snapshot still beats an empty
  // volume, so it is kept as the fallback's fallback.
  const SNAP = (A.snapshotBase || '').replace(/\/+$/, '');
  const SNAP_STALE_MS = 3 * 3600e3;    // past this, prefer a live call
  const modelSrc = { snap: false, t: 0, stale: false };

  async function loadSnap(name, fresh) {
    if (!SNAP) return null;
    try {
      const j = await fetchJSON(`${SNAP}/${name}.json`, fresh);
      return (j && Array.isArray(j.times) && j.hourly && +j.t) ? j : null;
    } catch (e) { return null; }        // any failure just means "go live"
  }
  // A snapshot built for a different center or a resized box is not this
  // page's data — same rule the terrain files get.
  function snapFitsDomain(j, d) {
    return j.gn === d.gn && Array.isArray(j.center) && Array.isArray(j.span) &&
      Math.abs(j.center[0] - A.lat) < 0.01 && Math.abs(j.center[1] - A.lon) < 0.01 &&
      Math.abs(j.span[0] - d.spanLat) < 1e-6 && Math.abs(j.span[1] - d.spanLon) < 1e-6 &&
      Array.isArray(j.hourly) && j.hourly.length === d.gn * d.gn;
  }
  const snapAge = (j) => Date.now() - j.t * 1000;
  function noteSource(j) {             // j = the snapshot used, or null for live
    modelSrc.snap = !!j;
    modelSrc.t = j ? j.t * 1000 : Date.now();
    modelSrc.stale = !!j && snapAge(j) > SNAP_STALE_MS;
    updateModelChip();
  }

  function ensureDomainData(k, fresh) {
    const c = domCache[k];
    if (c.hourly) return Promise.resolve();
    if (c.pending) return c.pending;
    c.pending = (async () => {
      const d = DOMAINS[k];
      const snap = await loadSnap(k, fresh);
      const fits = snap && snapFitsDomain(snap, d);
      if (fits && snapAge(snap) <= SNAP_STALE_MS) {
        c.hourly = snap.hourly;
        c.times = snap.times.map((t) => new Date(t + 'Z').getTime());
        noteSource(snap);
        return;
      }
      try {
        const g = await fetchJSON(gridUrl(k), fresh);
        const arr = Array.isArray(g) ? g : [g];
        if (arr.length !== d.gn * d.gn) throw new Error('grid came back short');
        c.hourly = arr.map((o) => o.hourly);
        c.times = c.hourly[0].time.map((t) => new Date(t + 'Z').getTime());
        noteSource(null);
      } catch (e) {
        if (!fits) throw e;            // nothing to fall back to
        c.hourly = snap.hourly;        // stale, but a stale sky beats no sky
        c.times = snap.times.map((t) => new Date(t + 'Z').getTime());
        noteSource(snap);
      }
    })().finally(() => { c.pending = null; });
    return c.pending;
  }

  let adoptedOnce = false;
  function adoptDomainData() {
    const c = domCache[DK];
    data.grid = c.hourly;
    data.times = c.times || [];
    const now = Date.now();
    let idx = 0;
    for (let i = 0; i < data.times.length; i++) if (data.times[i] <= now) idx = i;
    state.nowIdx = idx;
    if (!adoptedOnce) { state.sel = idx; adoptedOnce = true; }
    state.sel = clamp(state.sel, 0, Math.max(0, data.times.length - 1));
    const sl = $('hour-slider');
    sl.max = Math.max(1, data.times.length - 1);
    sl.value = state.sel;
  }

  function centerUrl() {
    const vars = [];
    for (const L of LEVELS) {
      vars.push(`temperature_${L}hPa`, `relative_humidity_${L}hPa`,
                `cloud_cover_${L}hPa`, `wind_speed_${L}hPa`,
                `wind_direction_${L}hPa`, `geopotential_height_${L}hPa`);
    }
    vars.push('temperature_2m', 'dew_point_2m', 'surface_pressure',
              'wind_speed_10m', 'wind_direction_10m', 'precipitation',
              'precipitation_probability', 'cape', 'freezing_level_height');
    return 'https://api.open-meteo.com/v1/forecast' +
      `?latitude=${A.lat}&longitude=${A.lon}&hourly=${vars.join(',')}` +
      '&models=gfs_seamless&windspeed_unit=kn&timezone=UTC&forecast_days=3';
  }

  // Open-Meteo weights a request by locations × variables × forecast length, so
  // the 25-column grid call (and the 49-column wide one) is worth many "calls"
  // against the free tier — a few reloads used to be enough for HTTP 429.
  // Responses are therefore cached per clock hour in sessionStorage: a reload,
  // a domain flip back, or an accidental Refresh inside the hour costs nothing,
  // and the model has no new data to give in that window anyway.
  const hourBucket = () => Math.floor(Date.now() / 36e5);
  function cacheKey(url) {
    let h = 2166136261;
    for (let i = 0; i < url.length; i++) { h ^= url.charCodeAt(i); h = Math.imul(h, 16777619); }
    return 'wx3d:' + hourBucket() + ':' + (h >>> 0).toString(36);
  }
  function cacheGet(url) {
    try { const v = sessionStorage.getItem(cacheKey(url)); return v ? JSON.parse(v) : null; }
    catch (e) { return null; }
  }
  function cachePut(url, obj) {
    try {
      const stamp = ':' + hourBucket() + ':';
      for (let i = sessionStorage.length - 1; i >= 0; i--) {   // evict last hour's entries
        const k = sessionStorage.key(i);
        if (k && k.startsWith('wx3d:') && k.indexOf(stamp) < 0) sessionStorage.removeItem(k);
      }
      sessionStorage.setItem(cacheKey(url), JSON.stringify(obj));
    } catch (e) { /* private mode or over quota — the cache is only an optimization */ }
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function fetchJSON(url, fresh) {
    if (!fresh) { const hit = cacheGet(url); if (hit) return hit; }
    let r = await fetch(url);
    if (r.status === 429) {            // rate limited: one polite retry, then say so in words
      await sleep(4000);
      r = await fetch(url);
      if (r.status === 429) {
        throw new Error('Open-Meteo is rate-limiting this browser (429) — give it a few minutes');
      }
    }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    cachePut(url, j);
    return j;
  }

  // the readout column: snapshot first, live if it is missing or stale
  async function loadCenter(fresh) {
    const snap = await loadSnap('center', fresh);
    if (snap && snapAge(snap) <= SNAP_STALE_MS) return snap.hourly;
    const live = await fetchJSON(centerUrl(), fresh).catch(() => null);
    if (live) return live.hourly;
    return snap ? snap.hourly : null;
  }

  async function loadAll(fresh) {
    setStatus('loading the atmosphere…');
    domCache.local.hourly = domCache.local.times = null;   // Refresh re-pulls both domains
    domCache.wide.hourly = domCache.wide.times = null;
    data.grid = null;
    built.hour = -1;
    try {
      const [, c] = await Promise.all([
        ensureDomainData(DK, fresh),
        loadCenter(fresh),             // volume still works without it
      ]);
      data.center = c;
      adoptDomainData();
      setStatus('');
      rebuild(state.sel);
      // The other domain is NOT pre-fetched: it is the heaviest call this page
      // makes and most visits never open it. switchDomain() loads it on demand.
    } catch (e) {
      setStatus('couldn’t load the model — ' + e.message + ' · try Refresh');
    }
  }

  let switching = false;
  async function switchDomain(k, newZoom) {
    if (k === DK || switching || !DOMAINS[k]) return;
    switching = true;
    // stash the active domain's view furniture for an instant return trip
    domCache[DK].ground = groundBase;
    domCache[DK].radar = radar.canvas
      ? { path: radar.path, time: radar.time, canvas: radar.canvas } : null;
    DK = k;
    const c = domCache[k];
    applyGeometry(DOMAINS[k]);
    if (newZoom != null) {             // zoom-through: keep the apparent size continuous
      state.zoom = clamp(newZoom, 0.4, 6.2);
      const f = k === 'wide' ? 1 / SPAN_RATIO : SPAN_RATIO;
      state.panX *= f; state.panY *= f;
    } else {
      state.panX = 0; state.panY = 0;
    }
    terr = c.terr;
    groundBase = c.ground;
    if (!groundBase) buildGroundBase();
    const r = c.radar;
    radar.canvas = r ? r.canvas : null;
    radar.path = r ? r.path : '';
    radar.time = r ? r.time : 0;
    flowRealloc();
    markDomUI();
    dirty = true;
    try {
      if (!c.hourly) { data.grid = null; built.hour = -1; setStatus('loading the atmosphere…'); }
      await ensureDomainData(k);
      if (DK === k) {                  // user may have flipped back mid-fetch
        adoptDomainData();
        setStatus('');
        rebuild(state.sel);
      }
    } catch (e) {
      if (DK === k) setStatus('couldn’t load this view — ' + e.message + ' · try Refresh');
    }
    if (!c.terr.tried) loadTerrain();
    loadRadar().catch(() => {});
    switching = false;
  }

  async function loadMetar() {
    const el = $('metar-line');
    try {
      const st = A.metarStation || A.id;
      const j = await fetchJSON(`https://api.weather.gov/stations/${st}/observations/latest`);
      const p = j.properties || {};
      if (!p.rawMessage) throw new Error('no obs');
      const age = Math.round((Date.now() - new Date(p.timestamp).getTime()) / 60000);
      el.innerHTML = `<b>${st} right now</b> · <code>${p.rawMessage}</code> <span class="faint">(${age} min ago)</span>`;
    } catch (e) { el.textContent = ''; }
  }

  // radar: newest RainViewer frame, mercator tiles composited onto a
  // linear-lat canvas one tile-row at a time (per-row lat mapping is
  // within ~1% linear at this scale)
  async function loadRadar() {
    const cfg = await fetchJSON('https://api.rainviewer.com/public/weather-maps.json');
    const past = (cfg.radar && cfg.radar.past) || [];
    if (!past.length) return;
    const f = past[past.length - 1];
    const k = DK;                      // the composite is box-specific
    if (f.path === radar.path && radar.dk === k) return;
    const Z = DOMAINS[k].radarZ, N = 1 << Z;
    const lon2x = (lo) => (lo + 180) / 360 * N;
    const lat2y = (la) => (1 - Math.log(Math.tan(la * D2R) + 1 / Math.cos(la * D2R)) / Math.PI) / 2 * N;
    const y2lat = (y) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y / N))) / D2R;
    const x0 = Math.floor(lon2x(lonW)), x1 = Math.floor(lon2x(lonE));
    const y0 = Math.floor(lat2y(latN)), y1 = Math.floor(lat2y(latS));
    const SG = 512;
    const c = document.createElement('canvas'); c.width = SG; c.height = SG;
    const g = c.getContext('2d');
    const jobs = [];
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      jobs.push(new Promise((res) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          const w = x / N * 360 - 180, e = (x + 1) / N * 360 - 180;
          const n = y2lat(y), s = y2lat(y + 1);
          const dx0 = (w - lonW) / SPAN_LON * SG, dx1 = (e - lonW) / SPAN_LON * SG;
          const dy0 = (latN - n) / SPAN_LAT * SG, dy1 = (latN - s) / SPAN_LAT * SG;
          g.drawImage(img, dx0, dy0, dx1 - dx0, dy1 - dy0);
          res();
        };
        img.onerror = res;
        img.src = `${cfg.host}${f.path}/256/${Z}/${x}/${y}/2/1_1.png`;
      }));
    }
    await Promise.all(jobs);
    if (DK !== k) {                    // domain flipped mid-fetch — stash for later
      domCache[k].radar = { path: f.path, time: f.time * 1000, canvas: c };
      return;
    }
    radar.path = f.path; radar.time = f.time * 1000; radar.canvas = c; radar.dk = k;
    updateNote();
    dirty = true;
  }

  // ------------------------------------------------------------ terrain
  // Static layer from data/wx3d/terrain.json (scripts/build_wx3d_terrain.py:
  // Copernicus DEM GLO-90 via Open-Meteo, 192×192 over this same box, plus
  // the landmark list — output committed). Water is wherever the DEM reports
  // sea level: that one rule draws the Bay, the Potomac and the river mouths.
  // The flat ground texture carries the full-resolution map, so radar still
  // drapes with a single affine transform; ground above MESH_MIN_M also gets
  // drawn as a real displaced mesh at the same ×7.5 vertical exaggeration.
  let terr = domCache.local.terr;      // the ACTIVE domain's terrain
  const RAMP = [[0.5, 22, 32, 28], [40, 27, 38, 30], [100, 35, 44, 32],
                [200, 46, 50, 36], [350, 56, 52, 40], [500, 66, 60, 48], [700, 78, 72, 60]];

  function rampAt(m) {
    if (m <= RAMP[0][0]) return [RAMP[0][1], RAMP[0][2], RAMP[0][3]];
    for (let i = 0; i < RAMP.length - 1; i++) {
      const a = RAMP[i], b = RAMP[i + 1];
      if (m <= b[0]) {
        const t = (m - a[0]) / (b[0] - a[0]);
        return [a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t];
      }
    }
    const z = RAMP[RAMP.length - 1];
    return [z[1], z[2], z[3]];
  }

  async function loadTerrain() {
    const k = DK, d = DOMAINS[k], T = domCache[k].terr;
    if (T.tried) return;
    T.tried = true;
    const eN = A.lat + d.spanLat / 2, eS = A.lat - d.spanLat / 2, eW = A.lon - d.spanLon / 2;
    try {
      const t = await fetchJSON(d.terrUrl);
      // built for one specific box — drop a stale file rather than misdraw it
      if (Math.abs(t.lat0 - eN) > 0.05 || Math.abs(t.lon0 - eW) > 0.05 ||
          Math.abs(t.lat0 - (t.ny - 1) * t.dlat - eS) > 0.05) {
        console.warn(d.terrUrl + ' bbox mismatch — rerun scripts/build_wx3d_terrain.py');
        return;
      }
      T.nx = t.nx; T.ny = t.ny;
      T.lat0 = t.lat0; T.lon0 = t.lon0; T.dlat = t.dlat; T.dlon = t.dlon;
      T.elev = Int16Array.from(t.elev);
      T.marks = t.landmarks || [];
      buildShade(T);
      buildMesh(T, d);
      T.ok = true;
      if (DK === k) { terr = T; buildGroundBase(); dirty = true; }
      else domCache[k].ground = null;    // rebuilt with terrain on next visit
    } catch (e) { /* the page is fine without terrain */ }
  }

  function buildShade(T) {
    const { nx, ny, elev } = T;
    const dxm = T.dlon * 111320 * Math.cos(A.lat * D2R);
    const dym = T.dlat * 111320;
    const s = new Float32Array(nx * ny);
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const x0 = Math.max(0, x - 1), x1 = Math.min(nx - 1, x + 1);
        const y0 = Math.max(0, y - 1), y1 = Math.min(ny - 1, y + 1);
        const fx = (elev[y * nx + x1] - elev[y * nx + x0]) / ((x1 - x0) * dxm);   // ∂z/∂east
        const fy = (elev[y0 * nx + x] - elev[y1 * nx + x]) / ((y1 - y0) * dym);   // ∂z/∂north (row 0 = north)
        // NW illumination: east-rising slopes face the light, north-rising face away
        s[y * nx + x] = clamp(1 + (fx - fy) * 2.1, 0.55, 1.4);
      }
    }
    T.shade = s;
  }

  function terrSample(u, v, arr) {
    const fx = u * (terr.nx - 1), fy = v * (terr.ny - 1);
    const x0 = Math.min(terr.nx - 2, Math.floor(fx)), tx = fx - x0;
    const y0 = Math.min(terr.ny - 2, Math.floor(fy)), ty = fy - y0;
    const i = y0 * terr.nx + x0;
    return (arr[i] * (1 - tx) + arr[i + 1] * tx) * (1 - ty) +
           (arr[i + terr.nx] * (1 - tx) + arr[i + terr.nx + 1] * tx) * ty;
  }

  function elevAtLL(lat, lon) {
    if (!terr.ok) return 0;
    const u = (lon - terr.lon0) / (terr.dlon * (terr.nx - 1));
    const v = (terr.lat0 - lat) / (terr.dlat * (terr.ny - 1));
    return terrSample(clamp(u, 0, 1), clamp(v, 0, 1), terr.elev);
  }

  function buildMesh(T, d) {
    T.mesh = [];
    const STEP = d.meshStep, MIN = d.meshMin;
    const { nx, ny, elev, shade } = T;
    const wx = (ix) => ((T.lon0 + ix * T.dlon) - A.lon) * KM_LON;
    const wy = (iy) => ((T.lat0 - iy * T.dlat) - A.lat) * KM_LAT;
    for (let iy = 0; iy + STEP < ny; iy += STEP) {
      for (let ix = 0; ix + STEP < nx; ix += STEP) {
        const i00 = iy * nx + ix, i01 = i00 + STEP;
        const i10 = (iy + STEP) * nx + ix, i11 = i10 + STEP;
        const e00 = elev[i00], e01 = elev[i01], e10 = elev[i10], e11 = elev[i11];
        if (Math.max(e00, e01, e10, e11) < MIN) continue;
        const em = (e00 + e01 + e10 + e11) / 4;
        const sm = (shade[i00] + shade[i01] + shade[i10] + shade[i11]) / 4 * 1.12;
        const [r, g, b] = rampAt(em);
        T.mesh.push({
          x0: wx(ix), x1: wx(ix + STEP), y0: wy(iy), y1: wy(iy + STEP),
          // stored in ft — the draw converts, so the exaggeration slider
          // doesn't have to rebuild the mesh
          f00: Math.max(0, e00) * M2FT, f01: Math.max(0, e01) * M2FT,
          f10: Math.max(0, e10) * M2FT, f11: Math.max(0, e11) * M2FT,
          depth: 0,
          col: `rgb(${Math.round(r * sm)},${Math.round(g * sm)},${Math.round(b * sm)})`,
        });
      }
    }
  }

  function drawTerrainMesh() {
    if (!terr.mesh.length) return;
    for (const q of terr.mesh) {
      q.depth = ((q.x0 + q.x1) / 2) * sinY + ((q.y0 + q.y1) / 2) * cosY;
    }
    terr.mesh.sort((a, b) => b.depth - a.depth);        // farthest first
    ctx.lineWidth = 0.75;
    for (const q of terr.mesh) {
      const p1 = project(q.x0, q.y0, zOf(q.f00)), p2 = project(q.x1, q.y0, zOf(q.f01));
      const p3 = project(q.x1, q.y1, zOf(q.f11)), p4 = project(q.x0, q.y1, zOf(q.f10));
      ctx.fillStyle = q.col; ctx.strokeStyle = q.col;
      ctx.beginPath();
      ctx.moveTo(p1.X, p1.Y); ctx.lineTo(p2.X, p2.Y);
      ctx.lineTo(p3.X, p3.Y); ctx.lineTo(p4.X, p4.Y);
      ctx.closePath();
      ctx.fill(); ctx.stroke();                 // stroke seals AA cracks between quads
    }
  }

  // ------------------------------------------------------------ field access
  const H = (k, name, i) => {
    const s = data.grid[k][name];
    return s ? (s[i] ?? null) : null;
  };
  // cloud-cover fraction 0..1 at grid point k, level L — falls back to an
  // RH mapping if the model ever stops publishing per-level cloud cover
  function covAt(k, L, i) {
    const cc = H(k, `cloud_cover_${L}hPa`, i);
    if (cc != null) return cc / 100;
    const rh = H(k, `relative_humidity_${L}hPa`, i);
    if (rh == null) return 0;
    return Math.pow(clamp((rh - 62) / 36, 0, 1), 1.7);
  }
  function levelFt(L, i) {
    const c = data.center;
    const z = c && c[`geopotential_height_${L}hPa`] ? c[`geopotential_height_${L}hPa`][i] : null;
    return z != null ? z * M2FT : STD_FT[L];
  }

  // ------------------------------------------------------------ noise
  function mulberry(seed) {
    let a = seed >>> 0;
    return () => {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const NZ = 256;
  function valueNoise(cell, seed) {
    const M = Math.ceil(NZ / cell) + 1;
    const rnd = mulberry(seed), lat = new Float32Array(M * M);
    for (let i = 0; i < lat.length; i++) lat[i] = rnd();
    const out = new Float32Array(NZ * NZ);
    for (let y = 0; y < NZ; y++) {
      const fy = y / cell, y0 = Math.floor(fy), ty = smooth(fy - y0);
      for (let x = 0; x < NZ; x++) {
        const fx = x / cell, x0 = Math.floor(fx), tx = smooth(fx - x0);
        const a = lat[y0 * M + x0], b = lat[y0 * M + x0 + 1];
        const c = lat[(y0 + 1) * M + x0], d = lat[(y0 + 1) * M + x0 + 1];
        out[y * NZ + x] = (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
      }
    }
    return out;
  }
  let noiseA = null, noiseB = null;
  function ensureNoise() {
    if (noiseA) return;
    const n1 = valueNoise(44, 20260826), n2 = valueNoise(13, 1229);
    noiseA = new Float32Array(NZ * NZ);
    for (let i = 0; i < noiseA.length; i++) noiseA[i] = 0.62 * n1[i] + 0.38 * n2[i];
    noiseB = valueNoise(21, 77);
  }

  // ------------------------------------------------------------ textures
  const SHEET_S = 200;
  function buildSheet(L, i) {
    const cov = [];
    let maxC = 0;
    for (let iy = 0; iy < GN; iy++) {
      const row = [];
      for (let ix = 0; ix < GN; ix++) {
        const c = covAt(iy * GN + ix, L, i);
        row.push(c); if (c > maxC) maxC = c;
      }
      cov.push(row);
    }
    const hFt = levelFt(L, i);
    if (maxC < 0.04) return { p: L, hFt, maxCover: maxC, canvas: null };
    ensureNoise();
    const S = SHEET_S;
    const cnv = document.createElement('canvas'); cnv.width = S; cnv.height = S;
    const g = cnv.getContext('2d');
    const img = g.createImageData(S, S);
    const px = img.data;
    const [tr, tg, tb] = levelTint(L);
    const feather = (t) => smooth(t / 0.13);
    for (let y = 0; y < S; y++) {
      const v = y / (S - 1);
      const fy = v * (GN - 1), iy0 = Math.min(GN - 2, Math.floor(fy)), ty = fy - iy0;
      const fe1 = feather(Math.min(v, 1 - v));
      for (let x = 0; x < S; x++) {
        const u = x / (S - 1);
        const fx = u * (GN - 1), ix0 = Math.min(GN - 2, Math.floor(fx)), tx = fx - ix0;
        const c = (cov[iy0][ix0] * (1 - tx) + cov[iy0][ix0 + 1] * tx) * (1 - ty) +
                  (cov[iy0 + 1][ix0] * (1 - tx) + cov[iy0 + 1][ix0 + 1] * tx) * ty;
        let a = 0;
        if (c > 0.05) {
          const n = noiseA[(y & 255) * NZ + (x & 255)];
          // threshold the noise at the cover fraction, softly — the opaque
          // share of the sheet then tracks the model's cover number
          a = smooth((c - n) / 0.20 + 0.5) * (0.48 + 0.52 * c) *
              fe1 * feather(Math.min(u, 1 - u)) * 0.9;
        }
        const k = (y * S + x) * 4;
        if (a > 0.003) {
          const sh = 0.86 + 0.30 * (noiseB[((y + 61) & 255) * NZ + ((x + 113) & 255)] - 0.5);
          px[k] = tr * sh; px[k + 1] = tg * sh; px[k + 2] = tb * sh; px[k + 3] = a * 255;
        }
      }
    }
    g.putImageData(img, 0, 0);
    return { p: L, hFt, maxCover: maxC, canvas: cnv };
  }

  const GROUND_S = 512;
  let groundBase = null;
  function buildGroundBase() {
    const S = GROUND_S;
    const c = document.createElement('canvas'); c.width = S; c.height = S;
    const g = c.getContext('2d');
    if (terr.ok) {
      // the real map: DEM sea level → water, land → hillshaded hypsometric tint
      const img = g.createImageData(S, S);
      const px = img.data;
      for (let y = 0; y < S; y++) {
        const v = y / (S - 1);
        for (let x = 0; x < S; x++) {
          const u = x / (S - 1);
          const e = terrSample(u, v, terr.elev);
          const k = (y * S + x) * 4;
          if (e <= 0.4) { px[k] = 11; px[k + 1] = 21; px[k + 2] = 36; }
          else {
            const sh = terrSample(u, v, terr.shade);
            const rc = rampAt(e);
            px[k] = rc[0] * sh; px[k + 1] = rc[1] * sh; px[k + 2] = rc[2] * sh;
          }
          px[k + 3] = 255;
        }
      }
      g.putImageData(img, 0, 0);
    } else {
      g.fillStyle = '#0e1320'; g.fillRect(0, 0, S, S);
    }
    const d = DOMAINS[DK];
    // graticule at the domain's step (0.5° local, 2° wide)
    g.strokeStyle = 'rgba(150,170,200,0.075)'; g.lineWidth = 1;
    for (let la = Math.ceil(latS / d.grat) * d.grat; la <= latN; la += d.grat) {
      const y = (latN - la) / SPAN_LAT * S;
      g.beginPath(); g.moveTo(0, y); g.lineTo(S, y); g.stroke();
    }
    for (let lo = Math.ceil(lonW / d.grat) * d.grat; lo <= lonE; lo += d.grat) {
      const x = (lo - lonW) / SPAN_LON * S;
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, S); g.stroke();
    }
    g.strokeStyle = 'rgba(160,180,210,0.3)'; g.lineWidth = 1.5;
    g.strokeRect(0.75, 0.75, S - 1.5, S - 1.5);
    groundBase = c;
    domCache[DK].ground = c;
  }

  function buildBlobs(i) {
    const S = GROUND_S;
    const c = document.createElement('canvas'); c.width = S; c.height = S;
    const g = c.getContext('2d');
    let any = false;
    for (let iy = 0; iy < GN; iy++) for (let ix = 0; ix < GN; ix++) {
      const pr = H(iy * GN + ix, 'precipitation', i);
      if (pr == null || pr < 0.05) continue;
      any = true;
      const x = (ix + 0) / (GN - 1) * S, y = (iy + 0) / (GN - 1) * S;
      const r = S / (GN - 1) * 0.62;
      const a = Math.min(0.14 + pr * 0.22, 0.6);
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, `rgba(86,140,220,${a})`);
      gr.addColorStop(1, 'rgba(86,140,220,0)');
      g.fillStyle = gr;
      g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
    }
    return any ? c : null;
  }

  // precip columns: ground up to the lowest cloudy deck at that point
  function buildColumns(i) {
    const cols = [];
    for (let iy = 0; iy < GN; iy++) for (let ix = 0; ix < GN; ix++) {
      const k = iy * GN + ix;
      const pr = H(k, 'precipitation', i);
      if (pr == null || pr < 0.05) continue;
      let topFt = 5000;
      for (const L of LEVELS) {
        if (covAt(k, L, i) >= 0.3) { topFt = levelFt(L, i); break; }
      }
      cols.push({ x: gx[ix], y: gy[iy], top: zOf(Math.min(topFt, TOP_FT)), pr });
    }
    return cols;
  }

  function buildFreezing(i) {
    const z = [];
    let ok = false, sum = 0, n = 0;
    for (let iy = 0; iy < GN; iy++) {
      const row = [];
      for (let ix = 0; ix < GN; ix++) {
        const m = H(iy * GN + ix, 'freezing_level_height', i);
        if (m == null) { row.push(null); continue; }
        ok = true;
        const ft = m * M2FT;
        sum += ft; n++;
        row.push(clamp(zOf(ft), 0, TOP_Z));
      }
      z.push(row);
    }
    return ok ? { z, meanFt: sum / n } : null;
  }

  function rebuild(i) {
    if (!data.grid) return;
    built.hour = i;
    built.sheets = LEVELS.map((L) => buildSheet(L, i));
    built.blobs = buildBlobs(i);
    built.cols = buildColumns(i);
    built.fz = buildFreezing(i);
    built.hFt = {};
    for (const L of LEVELS) built.hFt[L] = levelFt(L, i);
    buildFields(i);
    renderPanel(i);
    updateChip();
    updateNote();
    dirty = true;
  }

  // ------------------------------------------------------------ 3-D flow
  // Flow mode: the volume filled with altitude-holding tracers advected by
  // the model's horizontal wind — trilinear between the 5×5 columns and the
  // wind surfaces (10 m + every pressure level), time-lapsed FLOW_SPEED×
  // so the motion is visible. The model publishes no vertical motion at
  // these levels, so each tracer rides its own altitude. Trails live in
  // world space (a lagging tail point), so they orbit with the volume.
  const FLOW_N = 8000;                 // a 20×20×20 field's worth of tracers
  const FLOW_MIN = 1500;               // FPS-governor floor
  const FLOW_SPEED = 2900;             // time-lapse: ~48 min of wind per second
  const KT_KMS = 1.852 / 3600;
  let Z_K = 0.0003048 * ZSCALE;        // ft → world km (matches zOf; setZScale re-derives)
  // speed colors: NCOL buckets lerped between the legend's anchor hues, so
  // the ramp reads as a gradient instead of four hard bands
  const FLOW_ANCH = [[0, 148, 166, 190, 0.40], [18, 74, 158, 255, 0.50],
                     [32, 240, 192, 64, 0.56], [50, 255, 107, 107, 0.62]];
  const NCOL = 8, COL_SPAN = 52;
  const FLOW_COLS = Array.from({ length: NCOL }, (_, i) => {
    const kt = (i + 0.5) * (COL_SPAN / NCOL);
    let a = FLOW_ANCH[FLOW_ANCH.length - 1], b = a;
    for (let s = 0; s < FLOW_ANCH.length - 1; s++) {
      if (kt <= FLOW_ANCH[s + 1][0]) { a = FLOW_ANCH[s]; b = FLOW_ANCH[s + 1]; break; }
    }
    const t = clamp((kt - a[0]) / Math.max(1, b[0] - a[0]), 0, 1);
    const ch = (j) => Math.round(a[j] + (b[j] - a[j]) * t);
    return `rgba(${ch(1)},${ch(2)},${ch(3)},${(a[4] + (b[4] - a[4]) * t).toFixed(2)})`;
  });
  const flowCol = (kt) => Math.min(NCOL - 1, (kt / (COL_SPAN / NCOL)) | 0);
  const flow = {
    ready: false, live: FLOW_N, emaMs: 16, govTick: 0, buckets: null, tf: 0,
    hx: null, hy: null, hz: null, tx: null, ty: null, sp: null, age: null, life: null,
    f0: null, f1: null, lastT: 0,
  };

  function fillField(F, i) {
    const MAXL = LEVELS.length + 1, NPT = GN * GN;
    if (!F || F.u.length !== MAXL * NPT) {
      F = { h: new Float32Array(MAXL), u: new Float32Array(MAXL * NPT),
            v: new Float32Array(MAXL * NPT), nL: 0 };
    }
    let n = 0;
    const put = (hft, wsName, wdName) => {
      const base = n * NPT;
      for (let k = 0; k < NPT; k++) {
        const ws = H(k, wsName, i), wd = H(k, wdName, i);
        if (ws == null || wd == null) { F.u[base + k] = 0; F.v[base + k] = 0; continue; }
        const r = wd * D2R;
        F.u[base + k] = -Math.sin(r) * ws;   // flow components, kt (°true)
        F.v[base + k] = -Math.cos(r) * ws;
      }
      F.h[n] = hft; n++;
    };
    put(A.elevFt + 33, 'wind_speed_10m', 'wind_direction_10m');
    for (const L of LEVELS) {
      const hft = levelFt(L, i);
      if (hft <= F.h[n - 1] + 100) continue;    // below-ground / degenerate
      put(hft, `wind_speed_${L}hPa`, `wind_direction_${L}hPa`);
    }
    F.nL = n;
    return F;
  }
  // both the shown hour and the next one are kept, so the wind can be
  // interpolated in TIME — smoothly through play mode, and at "now" to the
  // actual minutes elapsed since the top of the hour
  function buildFields(i) {
    flow.f0 = fillField(flow.f0, i);
    flow.f1 = fillField(flow.f1, Math.min(i + 1, Math.max(0, data.times.length - 1)));
  }

  const flowTopFt = () =>
    Math.min(TOP_FT, flow.f0 && flow.f0.nL ? flow.f0.h[flow.f0.nL - 1] : 31000) - 400;

  function flowSeed(i, scatterAge) {
    const top = flowTopFt();
    const lo = clamp(state.band[0], 150, top - 600);
    const hi = clamp(state.band[1], lo + 400, top);
    flow.hx[i] = (Math.random() * 2 - 1) * HALF_X * 0.99;
    flow.hy[i] = (Math.random() * 2 - 1) * HALF_Y * 0.99;
    flow.hz[i] = lo + Math.random() * (hi - lo);
    flow.tx[i] = flow.hx[i]; flow.ty[i] = flow.hy[i];
    flow.sp[i] = 0;
    flow.life[i] = 5 + Math.random() * 6;
    flow.age[i] = scatterAge ? Math.random() * flow.life[i] : 0;
  }

  function flowAlloc() {
    if (flow.hx) return;
    const N = FLOW_N;
    flow.hx = new Float32Array(N); flow.hy = new Float32Array(N);
    flow.hz = new Float32Array(N); flow.tx = new Float32Array(N);
    flow.ty = new Float32Array(N); flow.sp = new Float32Array(N);
    flow.age = new Float32Array(N); flow.life = new Float32Array(N);
    for (let i = 0; i < N; i++) flowSeed(i, true);
  }
  function flowRealloc() {           // domain flip: field sizes and box changed
    flow.f0 = null; flow.f1 = null;
    if (flow.hx) for (let i = 0; i < FLOW_N; i++) flowSeed(i, true);
  }

  const wSamp = { u: 0, v: 0 };
  function sampleField(F, x, y, zft) {
    const gfx = clamp((x + HALF_X) / (2 * HALF_X), 0, 1) * (GN - 1);
    const gfy = clamp((HALF_Y - y) / (2 * HALF_Y), 0, 1) * (GN - 1);   // row 0 = north
    const ix = Math.min(GN - 2, Math.floor(gfx)), tx = gfx - ix;
    const iy = Math.min(GN - 2, Math.floor(gfy)), ty = gfy - iy;
    let k = 0;
    while (k < F.nL - 2 && F.h[k + 1] < zft) k++;
    const tz = clamp((zft - F.h[k]) / Math.max(1, F.h[k + 1] - F.h[k]), 0, 1);
    const i00 = iy * GN + ix, i10 = i00 + GN;
    const w00 = (1 - tx) * (1 - ty), w01 = tx * (1 - ty);
    const w10 = (1 - tx) * ty, w11 = tx * ty;
    const b0 = k * GN * GN, b1 = b0 + GN * GN;
    const u0 = F.u[b0 + i00] * w00 + F.u[b0 + i00 + 1] * w01 + F.u[b0 + i10] * w10 + F.u[b0 + i10 + 1] * w11;
    const v0 = F.v[b0 + i00] * w00 + F.v[b0 + i00 + 1] * w01 + F.v[b0 + i10] * w10 + F.v[b0 + i10 + 1] * w11;
    const u1 = F.u[b1 + i00] * w00 + F.u[b1 + i00 + 1] * w01 + F.u[b1 + i10] * w10 + F.u[b1 + i10 + 1] * w11;
    const v1 = F.v[b1 + i00] * w00 + F.v[b1 + i00 + 1] * w01 + F.v[b1 + i10] * w10 + F.v[b1 + i10 + 1] * w11;
    wSamp.u = u0 + (u1 - u0) * tz;
    wSamp.v = v0 + (v1 - v0) * tz;
  }
  function sampleWind(x, y, zft, tf) {
    sampleField(flow.f0, x, y, zft);
    if (tf > 0.002 && flow.f1) {
      const u0 = wSamp.u, v0 = wSamp.v;
      sampleField(flow.f1, x, y, zft);
      wSamp.u = u0 + (wSamp.u - u0) * tf;
      wSamp.v = v0 + (wSamp.v - v0) * tf;
    }
  }

  function stepParticles(now) {
    const dt = Math.min(0.05, Math.max(0.001, (now - flow.lastT) / 1000));
    flow.lastT = now;
    // where between this hour and the next the field should sit
    let tf = 0;
    if (playing) tf = clamp((now - playTickT) / PLAY_MS, 0, 1);
    else if (state.sel === state.nowIdx && data.times.length > state.sel + 1) {
      tf = clamp((Date.now() - data.times[state.sel]) /
                 (data.times[state.sel + 1] - data.times[state.sel]), 0, 1);
    }
    flow.tf = tf;
    const kk = KT_KMS * FLOW_SPEED * DOMAINS[DK].flowBoost * dt;
    const lag = Math.min(1, dt * 9);
    const top = flowTopFt();
    const bLo = clamp(state.band[0], 150, top - 600) - 1;
    const bHi = clamp(state.band[1], bLo + 400, top) + 1;
    for (let i = 0; i < flow.live; i++) {
      sampleWind(flow.hx[i], flow.hy[i], flow.hz[i], tf);
      flow.sp[i] = Math.hypot(wSamp.u, wSamp.v);
      flow.hx[i] += wSamp.u * kk;
      flow.hy[i] += wSamp.v * kk;
      flow.tx[i] += (flow.hx[i] - flow.tx[i]) * lag;
      flow.ty[i] += (flow.hy[i] - flow.ty[i]) * lag;
      flow.age[i] += dt;
      if (flow.age[i] > flow.life[i] ||
          Math.abs(flow.hx[i]) > HALF_X || Math.abs(flow.hy[i]) > HALF_Y ||
          flow.hz[i] < bLo || flow.hz[i] > bHi) flowSeed(i, false);
    }
  }

  // one path per (altitude band × speed color): thousands of streaklets,
  // a handful of stroke() calls
  function drawFlowBand(k) {
    for (let c = 0; c < NCOL; c++) {
      const list = flow.buckets[k * NCOL + c];
      if (!list.length) continue;
      ctx.strokeStyle = FLOW_COLS[c];
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      for (let j = 0; j < list.length; j++) {
        const i = list[j];
        const z = flow.hz[i] * Z_K;
        const hx = flow.hx[i], hy = flow.hy[i], tx = flow.tx[i], ty = flow.ty[i];
        ctx.moveTo(cx + (tx * cosY - ty * sinY) * scale,
                   cy - ((tx * sinY + ty * cosY) * sinP + z * cosP) * scale);
        ctx.lineTo(cx + (hx * cosY - hy * sinY) * scale,
                   cy - ((hx * sinY + hy * cosY) * sinP + z * cosP) * scale);
      }
      ctx.stroke();
    }
  }

  // ------------------------------------------------------------ projection
  const canvas = $('scene');
  const ctx = canvas.getContext('2d');
  let cssW = 0, cssH = 0, dpr = 1;
  let sinY = 0, cosY = 1, sinP = 0, cosP = 1, scale = 1, cx = 0, cy = 0;

  function setupView() {
    const yaw = state.yaw * D2R, pitch = clamp(state.pitch, 3, 88) * D2R;
    sinY = Math.sin(yaw); cosY = Math.cos(yaw);
    sinP = Math.sin(pitch); cosP = Math.cos(pitch);
    // fit: the projected box is at most 2·diag wide and 2·HY·sinP + TOP·cosP tall
    const diag = Math.hypot(HALF_X, HALF_Y);
    const w = 2 * diag, h = 2 * HALF_Y * sinP + TOP_Z * cosP;
    scale = Math.min(cssW * 0.95 / w, cssH * 0.88 / h) * state.zoom;
    cx = cssW / 2 + state.panX;
    cy = cssH / 2 + TOP_Z * cosP * scale / 2 + state.panY;
  }
  function project(x, y, z) {
    const xr = x * cosY - y * sinY;
    const yr = x * sinY + y * cosY;
    return { X: cx + xr * scale, Y: cy - (yr * sinP + z * cosP) * scale };
  }
  // screen-space unit vector of a compass direction in a horizontal plane
  function dirPx(x, y, z, deg) {
    const r = deg * D2R, ex = Math.sin(r), ey = Math.cos(r);
    const P0 = project(x, y, z), P1 = project(x + ex, y + ey, z);
    let dx = P1.X - P0.X, dy = P1.Y - P0.Y;
    const m = Math.hypot(dx, dy) || 1;
    return { x: dx / m, y: dy / m };
  }
  // draw a horizontal texture at height z with one affine transform
  function drawFlat(tex, z, alpha) {
    const O = project(-HALF_X, HALF_Y, z);       // NW corner = texture origin
    const U = project(HALF_X, HALF_Y, z);        // NE
    const V = project(-HALF_X, -HALF_Y, z);      // SW
    const S = tex.width;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.setTransform(dpr * (U.X - O.X) / S, dpr * (U.Y - O.Y) / S,
                     dpr * (V.X - O.X) / S, dpr * (V.Y - O.Y) / S,
                     dpr * O.X, dpr * O.Y);
    ctx.drawImage(tex, 0, 0);
    ctx.restore();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // ------------------------------------------------------------ vector bits
  function line(x0, y0, x1, y1) {
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
  }
  const speedColor = (kt) =>
    kt < 12 ? 'rgba(148,166,190,0.85)' :
    kt < 25 ? 'rgba(74,158,255,0.92)' :
    kt < 40 ? 'rgba(240,192,64,0.95)' : 'rgba(255,107,107,0.95)';

  function drawArrow(x, y, z, wd, ws) {
    if (ws == null || wd == null) return;
    const P = project(x, y, z);
    const d = dirPx(x, y, z, wd + 180);          // downwind
    const L = clamp(8 + ws * 0.5, 8, 34);
    const hx = P.X + d.x * L / 2, hy = P.Y + d.y * L / 2;
    const tx = P.X - d.x * L / 2, ty = P.Y - d.y * L / 2;
    ctx.strokeStyle = speedColor(ws);
    ctx.lineWidth = ws < 25 ? 1.4 : 1.9;
    line(tx, ty, hx, hy);
    const a = Math.atan2(d.y, d.x);
    ctx.beginPath();
    ctx.moveTo(hx, hy);
    ctx.lineTo(hx - 6 * Math.cos(a - 0.44), hy - 6 * Math.sin(a - 0.44));
    ctx.moveTo(hx, hy);
    ctx.lineTo(hx - 6 * Math.cos(a + 0.44), hy - 6 * Math.sin(a + 0.44));
    ctx.stroke();
    ctx.fillStyle = 'rgba(160,180,210,0.5)';
    ctx.beginPath(); ctx.arc(P.X, P.Y, 1.3, 0, TAU); ctx.fill();
  }

  // WMO barb, NH: shaft toward where the wind is FROM, feathers on the
  // side 90° clockwise of that (with a slight outward rake)
  function drawBarb(x, y, z, wd, ws, col) {
    if (ws == null || wd == null) return;
    const P0 = project(x, y, z);
    ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1.4;
    const r5 = Math.round(ws / 5) * 5;
    if (r5 < 5) { ctx.beginPath(); ctx.arc(P0.X, P0.Y, 2.6, 0, TAU); ctx.stroke(); return; }
    const du = dirPx(x, y, z, wd);
    const f0 = dirPx(x, y, z, wd + 90);
    let fx = f0.x + du.x * 0.38, fy = f0.y + du.y * 0.38;
    const fm = Math.hypot(fx, fy) || 1; fx /= fm; fy /= fm;
    const L = 24;
    const tip = { x: P0.X + du.x * L, y: P0.Y + du.y * L };
    line(P0.X, P0.Y, tip.x, tip.y);
    let pens = Math.floor(r5 / 50), rem = r5 % 50;
    let fulls = Math.floor(rem / 10);
    const half = (rem % 10) >= 5;
    let off = 0;
    const STEP = 4.5, FL = 9, HL = 5;
    for (let k = 0; k < pens; k++) {
      const bx = tip.x - du.x * off, by = tip.y - du.y * off;
      const ex = tip.x - du.x * (off + STEP), ey = tip.y - du.y * (off + STEP);
      ctx.beginPath();
      ctx.moveTo(bx, by); ctx.lineTo(bx + fx * FL, by + fy * FL); ctx.lineTo(ex, ey);
      ctx.closePath(); ctx.fill();
      off += STEP + 1.5;
    }
    for (let k = 0; k < fulls; k++) {
      const bx = tip.x - du.x * off, by = tip.y - du.y * off;
      line(bx, by, bx + fx * FL, by + fy * FL);
      off += STEP;
    }
    if (half) {
      if (pens === 0 && fulls === 0) off += STEP;   // lone half sits off the tip
      const bx = tip.x - du.x * off, by = tip.y - du.y * off;
      line(bx, by, bx + fx * HL, by + fy * HL);
    }
  }

  // ------------------------------------------------------------ render
  function fmtK(ft) {
    return ft >= 950 ? (Math.round(ft / 100) / 10).toFixed(1).replace(/\.0$/, '') + 'k' : Math.round(ft) + '';
  }
  function render() {
    const i = state.sel;
    setupView();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const bg = ctx.createLinearGradient(0, 0, 0, cssH);
    bg.addColorStop(0, '#0a0e18'); bg.addColorStop(1, '#0c1120');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, cssW, cssH);
    if (!data.grid || built.hour < 0) return;

    const items = [];
    const isNow = i === state.nowIdx;

    // ground: static base + radar (now) or model-precip stain (other hours)
    items.push({ z: -2, fn: () => {
      drawFlat(groundBase, 0, 1);
      drawTerrainMesh();          // the NW high ground rises out of the flat map
      if (state.layers.gd && isNow && radar.canvas) drawFlat(radar.canvas, 0, 0.8);
      else if (state.layers.gd && built.blobs) drawFlat(built.blobs, 0, 0.9);
    } });

    // box wireframe + compass letters
    items.push({ z: -1.5, fn: () => {
      ctx.strokeStyle = 'rgba(160,180,210,0.10)'; ctx.lineWidth = 1;
      const cs = [[-HALF_X, HALF_Y], [HALF_X, HALF_Y], [HALF_X, -HALF_Y], [-HALF_X, -HALF_Y]];
      const top = cs.map(([x, y]) => project(x, y, TOP_Z));
      cs.forEach(([x, y], k) => { const b = project(x, y, 0); line(b.X, b.Y, top[k].X, top[k].Y); });
      ctx.beginPath();
      top.forEach((p, k) => k ? ctx.lineTo(p.X, p.Y) : ctx.moveTo(p.X, p.Y));
      ctx.closePath(); ctx.stroke();
      ctx.fillStyle = 'rgba(190,205,230,0.4)';
      ctx.font = '600 11px "Segoe UI", system-ui, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const pn = project(0, HALF_Y + 14, 0);
      const pa = project(0, HALF_Y + 6, 0), pb = project(-4, HALF_Y + 4, 0), pc = project(4, HALF_Y + 4, 0);
      ctx.beginPath(); ctx.moveTo(pa.X, pa.Y - 6); ctx.lineTo(pb.X, pb.Y); ctx.lineTo(pc.X, pc.Y);
      ctx.closePath(); ctx.fill();
      ctx.fillText('N', pn.X, pn.Y - 4);
      ctx.fillStyle = 'rgba(190,205,230,0.22)';
      const pe = project(HALF_X + 12, 0, 0); ctx.fillText('E', pe.X, pe.Y);
      const ps = project(0, -HALF_Y - 12, 0); ctx.fillText('S', ps.X, ps.Y);
      const pw = project(-HALF_X - 12, 0, 0); ctx.fillText('W', pw.X, pw.Y);
    } });

    // airports + landmarks
    items.push({ z: -1.2, fn: () => {
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      // the nearby-field cluster only makes sense at local scale
      for (const ap of (DK === 'local' ? SITE.weather.nearbyAirports : [])) {
        const x = (ap.lon - A.lon) * KM_LON, y = (ap.lat - A.lat) * KM_LAT;
        if (Math.abs(x) > HALF_X || Math.abs(y) > HALF_Y) continue;
        const P = project(x, y, 0);
        ctx.fillStyle = 'rgba(150,165,190,0.75)';
        ctx.beginPath(); ctx.arc(P.X, P.Y, 2, 0, TAU); ctx.fill();
        ctx.fillStyle = 'rgba(130,145,170,0.65)';
        ctx.font = '9.5px "Segoe UI", system-ui, sans-serif';
        ctx.fillText(ap.id, P.X + 4, P.Y + 1);
      }
      // landmarks from terrain.json: cities, the majors, the Bay Bridge, peaks
      for (const lm of terr.marks) {
        const x = (lm.lon - A.lon) * KM_LON, y = (lm.lat - A.lat) * KM_LAT;
        if (Math.abs(x) > HALF_X || Math.abs(y) > HALF_Y) continue;
        if (lm.kind === 'bridge') {
          const x2 = (lm.lon2 - A.lon) * KM_LON, y2 = (lm.lat2 - A.lat) * KM_LAT;
          const P1 = project(x, y, 0), P2 = project(x2, y2, 0);
          ctx.strokeStyle = 'rgba(205,215,230,0.55)'; ctx.lineWidth = 1.5;
          line(P1.X, P1.Y, P2.X, P2.Y);
          ctx.fillStyle = 'rgba(150,162,180,0.55)';
          ctx.font = '8.5px "Segoe UI", system-ui, sans-serif';
          ctx.fillText(lm.name, Math.max(P1.X, P2.X) + 4, (P1.Y + P2.Y) / 2 - 3);
          ctx.font = '9.5px "Segoe UI", system-ui, sans-serif';
        } else if (lm.kind === 'peak') {
          const P = project(x, y, zOf(elevAtLL(lm.lat, lm.lon) * M2FT));
          ctx.fillStyle = 'rgba(205,190,160,0.7)';
          ctx.beginPath();
          ctx.moveTo(P.X, P.Y - 3.5); ctx.lineTo(P.X - 3, P.Y + 2); ctx.lineTo(P.X + 3, P.Y + 2);
          ctx.closePath(); ctx.fill();
          ctx.fillStyle = 'rgba(190,177,152,0.65)';
          ctx.fillText(lm.name, P.X + 5, P.Y - 3);
        } else if (lm.kind === 'city') {
          const P = project(x, y, 0);
          ctx.fillStyle = 'rgba(208,195,165,0.6)';
          ctx.fillRect(P.X - 1.5, P.Y - 1.5, 3, 3);
          ctx.fillStyle = 'rgba(188,178,152,0.62)';
          ctx.fillText(lm.name, P.X + 4, P.Y + 1);
        } else {                    // apt — styled like the SITE nearby fields
          const P = project(x, y, 0);
          ctx.fillStyle = 'rgba(150,165,190,0.75)';
          ctx.beginPath(); ctx.arc(P.X, P.Y, 2, 0, TAU); ctx.fill();
          ctx.fillStyle = 'rgba(130,145,170,0.65)';
          ctx.fillText(lm.name, P.X + 4, P.Y + 1);
        }
      }
      // the center field: runway stripe on its true axis + label
      if (A.runwayAxisTrue != null) {
        const ax = A.runwayAxisTrue * D2R;
        const rl = 7, dx = Math.sin(ax) * rl, dy = Math.cos(ax) * rl;
        const p1 = project(-dx, -dy, 0), p2 = project(dx, dy, 0);
        ctx.strokeStyle = 'rgba(230,238,250,0.95)'; ctx.lineWidth = 2.5;
        line(p1.X, p1.Y, p2.X, p2.Y);
      }
      const P = project(0, 0, 0);
      ctx.fillStyle = '#9ec5f0';
      ctx.font = '600 11px "Segoe UI", system-ui, sans-serif';
      ctx.fillText(A.id, P.X + 6, P.Y + 3);
    } });

    // the staff pole at the field
    items.push({ z: -1.1, fn: () => {
      const b = project(0, 0, 0), t = project(0, 0, TOP_Z);
      ctx.strokeStyle = 'rgba(200,215,235,0.22)'; ctx.lineWidth = 1;
      line(b.X, b.Y, t.X, t.Y);
    } });

    // precip columns
    if (state.layers.pr) {
      for (const c of built.cols) {
        items.push({ z: -1 + c.top * 1e-4, fn: () => {
          const B = project(c.x, c.y, 0), T = project(c.x, c.y, c.top);
          const w = clamp(6 * scale, 5, 26);
          const a = Math.min(0.10 + c.pr * 0.16, 0.42);
          const gr = ctx.createLinearGradient(0, B.Y, 0, T.Y);
          gr.addColorStop(0, `rgba(108,152,220,${a})`);
          gr.addColorStop(1, `rgba(108,152,220,${a * 0.12})`);
          ctx.fillStyle = gr;
          ctx.fillRect(B.X - w / 2, T.Y, w, B.Y - T.Y);
        } });
      }
    }

    // cloud sheets
    if (state.layers.cl) {
      for (const s of built.sheets) {
        if (!s.canvas) continue;
        items.push({ z: zOf(s.hFt), fn: () => drawFlat(s.canvas, zOf(Math.min(s.hFt, TOP_FT)), 1) });
      }
    }

    // freezing surface — a warped mesh, drawn light so it reads as a film,
    // not a slab (a flat sheet at this pitch covers a lot of screen)
    if (state.layers.fz && built.fz) {
      const fz = built.fz;
      items.push({ z: zOf(clamp(fz.meanFt, 0, TOP_FT)) + 0.005, fn: () => {
        ctx.fillStyle = 'rgba(96,210,255,0.05)';
        for (let iy = 0; iy < GN - 1; iy++) for (let ix = 0; ix < GN - 1; ix++) {
          const q = [[iy, ix], [iy, ix + 1], [iy + 1, ix + 1], [iy + 1, ix]];
          if (q.some(([a, b]) => fz.z[a][b] == null)) continue;
          ctx.beginPath();
          q.forEach(([a, b], k) => {
            const P = project(gx[b], gy[a], fz.z[a][b]);
            k ? ctx.lineTo(P.X, P.Y) : ctx.moveTo(P.X, P.Y);
          });
          ctx.closePath(); ctx.fill();
        }
        // mesh as row/column polylines so shared edges aren't double-struck
        ctx.strokeStyle = 'rgba(96,210,255,0.3)';
        ctx.lineWidth = 1;
        for (let iy = 0; iy < GN; iy++) {
          ctx.beginPath();
          let open = false;
          for (let ix = 0; ix < GN; ix++) {
            const z = fz.z[iy][ix];
            if (z == null) { open = false; continue; }
            const P = project(gx[ix], gy[iy], z);
            open ? ctx.lineTo(P.X, P.Y) : ctx.moveTo(P.X, P.Y);
            open = true;
          }
          ctx.stroke();
        }
        for (let ix = 0; ix < GN; ix++) {
          ctx.beginPath();
          let open = false;
          for (let iy = 0; iy < GN; iy++) {
            const z = fz.z[iy][ix];
            if (z == null) { open = false; continue; }
            const P = project(gx[ix], gy[iy], z);
            open ? ctx.lineTo(P.X, P.Y) : ctx.moveTo(P.X, P.Y);
            open = true;
          }
          ctx.stroke();
        }
      } });
    }

    // 3-D flow — tracers bucketed between the cloud decks so an overcast
    // layer properly veils the traffic beneath it
    if (state.wind === 'flow' && flow.ready) {
      const cuts = state.layers.cl
        ? built.sheets.filter((s) => s.canvas)
            .map((s) => zOf(Math.min(s.hFt, TOP_FT))).sort((a, b) => a - b)
        : [];
      const nb = cuts.length + 1;
      if (!flow.buckets || flow.buckets.length !== nb * NCOL) {
        flow.buckets = Array.from({ length: nb * NCOL }, () => []);
      }
      for (const b of flow.buckets) b.length = 0;
      for (let p = 0; p < flow.live; p++) {
        const z = flow.hz[p] * Z_K;
        let k = 0;
        while (k < cuts.length && cuts[k] < z) k++;
        flow.buckets[k * NCOL + flowCol(flow.sp[p])].push(p);
      }
      for (let k = 0; k < nb; k++) {
        const zb = k === 0 ? -0.9 : cuts[k - 1] + 0.006;
        const kk = k;
        items.push({ z: zb, fn: () => drawFlowBand(kk) });
      }
    }

    // winds aloft — arrows across the grid at the chosen level
    if (state.wind !== 'off' && state.wind !== 'flow') {
      const sfc = state.wind === 'sfc';
      const L = sfc ? null : +state.wind;
      const zl = sfc ? 0.02 : zOf(clamp(built.hFt[L], 0, TOP_FT));
      items.push({ z: zl + 0.01, fn: () => {
        for (let iy = 0; iy < GN; iy++) for (let ix = 0; ix < GN; ix++) {
          const k = iy * GN + ix;
          const ws = H(k, sfc ? 'wind_speed_10m' : `wind_speed_${L}hPa`, i);
          const wd = H(k, sfc ? 'wind_direction_10m' : `wind_direction_${L}hPa`, i);
          drawArrow(gx[ix], gy[iy], zl, wd, ws);
        }
      } });
    }

    // barbs on the field staff (center column, all levels + surface)
    if (data.center) {
      const c = data.center;
      const sp = c.surface_pressure ? c.surface_pressure[i] : null;
      const sfcW = { ws: c.wind_speed_10m ? c.wind_speed_10m[i] : null, wd: c.wind_direction_10m ? c.wind_direction_10m[i] : null };
      items.push({ z: 0.03, fn: () => drawBarb(0, 0, 0.03, sfcW.wd, sfcW.ws, 'rgba(230,238,250,0.9)') });
      for (const L of LEVELS) {
        if (L === 1000) continue;                          // sits on the surface barb
        if (sp != null && L >= sp - 2) continue;           // below ground
        const ws = c[`wind_speed_${L}hPa`] ? c[`wind_speed_${L}hPa`][i] : null;
        const wd = c[`wind_direction_${L}hPa`] ? c[`wind_direction_${L}hPa`][i] : null;
        const zb = zOf(clamp(built.hFt[L], 0, TOP_FT));
        items.push({ z: zb + 0.02, fn: () => drawBarb(0, 0, zb, wd, ws, 'rgba(230,238,250,0.85)') });
      }
    }

    items.sort((a, b) => a.z - b.z);
    for (const it of items) it.fn();

    drawAxis(i);
  }

  // altitude axis on the leftmost bottom corner + per-sheet labels
  function drawAxis(i) {
    const corners = [[-HALF_X, HALF_Y], [HALF_X, HALF_Y], [HALF_X, -HALF_Y], [-HALF_X, -HALF_Y]];
    let cl = null, cr = null;
    for (const [x, y] of corners) {
      const P = project(x, y, 0);
      if (!cl || P.X < cl.P.X) cl = { x, y, P };
      if (!cr || P.X > cr.P.X) cr = { x, y, P };
    }
    ctx.strokeStyle = 'rgba(190,205,230,0.35)'; ctx.lineWidth = 1;
    const top = project(cl.x, cl.y, TOP_Z);
    line(cl.P.X, cl.P.Y, top.X, top.Y);
    ctx.font = '10px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (let ft = 0; ft <= TOP_FT; ft += 5000) {
      const P = project(cl.x, cl.y, zOf(ft));
      const major = ft % 10000 === 0;
      ctx.strokeStyle = 'rgba(190,205,230,0.35)';
      line(P.X - (major ? 6 : 3), P.Y, P.X, P.Y);
      if (major && ft > 0) {
        ctx.fillStyle = 'rgba(170,185,210,0.75)';
        ctx.fillText(ft / 1000 + (ft === TOP_FT ? 'k ft' : 'k'), P.X - 9, P.Y);
      }
    }
    // sheet labels, skipping any that would collide with the one below
    let lastY = 1e9;
    const sheets = (state.layers.cl ? built.sheets : []).filter((s) => s.maxCover >= 0.15)
      .sort((a, b) => a.hFt - b.hFt);
    for (const s of sheets) {
      const P = project(cl.x, cl.y, zOf(Math.min(s.hFt, TOP_FT)));
      if (lastY - P.Y < 12 && lastY !== 1e9) continue;
      lastY = P.Y;
      const [r, g, b] = levelTint(s.p);
      ctx.fillStyle = `rgba(${r},${g},${b},0.9)`;
      ctx.textAlign = 'left';
      ctx.fillText(`${fmtK(s.hFt)} · ${s.p}`, P.X + 6, P.Y);
      ctx.textAlign = 'right';
    }
    if (state.layers.fz && built.fz) {
      const P = project(cr.x, cr.y, zOf(clamp(built.fz.meanFt, 0, TOP_FT)));
      ctx.fillStyle = 'rgba(96,210,255,0.85)';
      ctx.textAlign = 'left';
      ctx.fillText(`0 °C · ${fmtK(built.fz.meanFt)}`, P.X + 7, P.Y);
    }
    // flow altitude band: dashed frames at floor and ceiling + a bright
    // axis segment, so the slider's numbers are visible in the geometry
    if (state.wind === 'flow' && (state.band[0] > 200 || state.band[1] < TOP_FT - 200)) {
      const zlo = zOf(clamp(state.band[0], 0, TOP_FT));
      const zhi = zOf(clamp(state.band[1], 0, TOP_FT));
      ctx.strokeStyle = 'rgba(74,158,255,0.22)';
      ctx.setLineDash([5, 6]);
      ctx.lineWidth = 1;
      for (const zz of [zlo, zhi]) {
        ctx.beginPath();
        corners.forEach(([x, y], k) => {
          const P = project(x, y, zz);
          k ? ctx.lineTo(P.X, P.Y) : ctx.moveTo(P.X, P.Y);
        });
        ctx.closePath(); ctx.stroke();
      }
      ctx.setLineDash([]);
      const A1 = project(cl.x, cl.y, zlo), A2 = project(cl.x, cl.y, zhi);
      ctx.strokeStyle = 'rgba(74,158,255,0.55)'; ctx.lineWidth = 2.5;
      line(A1.X, A1.Y, A2.X, A2.Y);
    }
  }

  // ------------------------------------------------------------ panel
  function fmtFt(ft) { return Math.round(ft).toLocaleString('en-US') + ' ft'; }
  function fmtDir(d) { return String(Math.round(d)).padStart(3, '0'); }
  function fmtT(t) { const r = Math.round(t); return (r < 0 ? '−' : '') + Math.abs(r) + '°'; }
  function renderPanel(i) {
    const el = $('col-body');
    const c = data.center;
    if (!c) { el.innerHTML = '<div class="faint">field column unavailable — volume is still the model</div>'; return; }
    const sp = c.surface_pressure ? c.surface_pressure[i] : null;
    const rows = [];
    for (let k = LEVELS.length - 1; k >= 0; k--) {
      const L = LEVELS[k];
      if (sp != null && L >= sp - 2) continue;
      const T = c[`temperature_${L}hPa`][i];
      const ws = c[`wind_speed_${L}hPa`][i], wd = c[`wind_direction_${L}hPa`][i];
      const cc = c[`cloud_cover_${L}hPa`][i];
      const ft = levelFt(L, i);
      if (T == null) continue;
      rows.push(`<div class="lv${cc >= 40 ? ' cloudy' : ''}">
        <span class="alt">${fmtFt(ft)} <i>${L}</i></span>
        <span class="tmp${Math.round(T) < 0 ? ' cold' : ''}">${fmtT(T)}</span>
        <span class="wnd">${wd != null ? fmtDir(wd) + '°/' + Math.round(ws) : '—'}</span>
        <span class="cld"><i style="width:${clamp(cc ?? 0, 0, 100)}%"></i><b>${cc != null && cc >= 5 ? Math.round(cc) + '%' : ''}</b></span>
      </div>`);
    }
    const t2 = c.temperature_2m ? c.temperature_2m[i] : null;
    const w10s = c.wind_speed_10m ? c.wind_speed_10m[i] : null;
    const w10d = c.wind_direction_10m ? c.wind_direction_10m[i] : null;
    rows.push(`<div class="lv sfc">
      <span class="alt">${fmtFt(A.elevFt)} <i>sfc</i></span>
      <span class="tmp">${t2 != null ? fmtT(t2) : '—'}</span>
      <span class="wnd">${w10d != null ? fmtDir(w10d) + '°/' + Math.round(w10s) : '—'}</span>
      <span class="cld"></span>
    </div>`);
    const flh = c.freezing_level_height ? c.freezing_level_height[i] : null;
    const cape = c.cape ? c.cape[i] : null;
    const pr = c.precipitation ? c.precipitation[i] : null;
    const pp = c.precipitation_probability ? c.precipitation_probability[i] : null;
    const capeWord = cape == null ? '' : cape < 300 ? 'stable-ish' : cape < 1000 ? 'a little unstable' : cape < 2500 ? 'unstable' : 'strongly unstable';
    const meta = [];
    if (flh != null) meta.push(`<div class="kv"><span>freezing level</span><b class="fz">${fmtFt(flh * M2FT)}</b></div>`);
    if (cape != null) meta.push(`<div class="kv"><span>CAPE</span><b>${Math.round(cape).toLocaleString('en-US')} J/kg — ${capeWord}</b></div>`);
    meta.push(`<div class="kv"><span>precip this hour</span><b>${pr != null && pr >= 0.05 ? pr.toFixed(1) + ' mm' : 'none'}${pp != null && pp > 0 ? ` <span class="faint">(${pp}% chance)</span>` : ''}</b></div>`);
    el.innerHTML =
      `<div class="lv head"><span class="alt">altitude</span><span class="tmp">temp</span><span class="wnd" title="°true / knots">wind</span><span class="cld">cloud</span></div>` +
      rows.join('') + `<div class="meta">${meta.join('')}</div>`;
  }

  // ------------------------------------------------------------ chrome
  const fmtHour = new Intl.DateTimeFormat('en-US', { weekday: 'short', hour: 'numeric', timeZone: TZ });
  const fmtHM = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: TZ });
  function updateChip() {
    const i = state.sel, d = i - state.nowIdx;
    $('chip-when').textContent = fmtHour.format(new Date(data.times[i]));
    $('chip-rel').textContent = i === state.nowIdx ? 'now' : (d > 0 ? '+' : '−') + Math.abs(d) + ' h';
    $('col-when').textContent = fmtHour.format(new Date(data.times[i]));
  }
  // The chip says where the numbers came from, because "the model" from an
  // hourly snapshot and "the model" fetched live are not the same claim — and
  // a snapshot the Action failed to refresh must never pass for current.
  function updateModelChip() {
    const el = $('chip-model');
    if (!el) return;
    if (!modelSrc.snap) {
      el.textContent = 'GFS · Open-Meteo · live';
      el.title = 'fetched from Open-Meteo by this browser';
      el.style.color = '';
      return;
    }
    const mins = Math.round((Date.now() - modelSrc.t) / 60000);
    const age = mins < 90 ? mins + ' min' : (mins / 60).toFixed(1) + ' h';
    el.textContent = 'GFS · Open-Meteo · snapshot ' + age + ' old';
    el.title = 'hourly snapshot from this site\u2019s archive' +
      (modelSrc.stale ? ' — the refresh is running late and the live API did not answer' : '');
    el.style.color = modelSrc.stale ? '#f0c040' : '';
  }

  function updateNote() {
    const el = $('scene-note');
    if (!data.grid) { el.textContent = ''; return; }
    if (state.sel === state.nowIdx && radar.canvas && state.layers.gd) {
      el.textContent = `radar ${fmtHM.format(new Date(radar.time))} on the ground · clouds & winds are the model`;
    } else {
      el.textContent = 'ground shading = model precip (radar only at “now”)';
    }
  }
  function setStatus(msg) {
    const el = $('scene-status');
    el.style.display = msg ? 'flex' : 'none';
    el.textContent = msg;
  }
  function setHour(i) {
    i = clamp(i, 0, data.times.length - 1);
    if (i === state.sel && built.hour === i) return;
    state.sel = i;
    $('hour-slider').value = i;
    rebuild(i);
  }

  // ------------------------------------------------------------ interaction
  // drag = orbit · shift/right-drag = pan · wheel = zoom · double-click = reset
  // touch: one finger orbits, two fingers pinch-zoom AND pan together
  const pointers = new Map();
  let pinchD = 0;
  const clampPan = () => {
    const m = Math.max(cssW, cssH) * state.zoom;
    state.panX = clamp(state.panX, -m, m);
    state.panY = clamp(state.panY, -m, m);
  };
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('pointerdown', (e) => {
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* synthetic or stale pointer */ }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, pan: e.button === 2 || e.shiftKey });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchD = Math.hypot(a.x - b.x, a.y - b.y);
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    const p = pointers.get(e.pointerId);
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (pointers.size === 1) {
      if (p.pan) {
        state.panX += dx; state.panY += dy; clampPan();
      } else {
        state.yaw = (state.yaw + dx * 0.35) % 360;
        state.pitch = clamp(state.pitch + dy * 0.25, 3, 88);
      }
      dirty = true;
    } else if (pointers.size === 2) {
      // two fingers: centroid moves the view, spread zooms it
      state.panX += dx / 2; state.panY += dy / 2; clampPan();
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchD > 0) zoomTo(state.zoom * d / pinchD);
      pinchD = d;
      dirty = true;
    }
  });
  const drop = (e) => { pointers.delete(e.pointerId); pinchD = 0; };
  canvas.addEventListener('pointerup', drop);
  canvas.addEventListener('pointercancel', drop);
  // zoom routes through zoomTo so zooming out past the local box slides
  // into the wide domain (and zooming way into the wide box comes back)
  function zoomTo(v) {
    if (DK === 'local' && v < 0.42) { switchDomain('wide', v * SPAN_RATIO); return; }
    if (DK === 'wide' && v > 5.9) { switchDomain('local', v / SPAN_RATIO); return; }
    state.zoom = clamp(v, 0.4, 6.2);
    clampPan();
    dirty = true;
  }
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoomTo(state.zoom * Math.exp(-e.deltaY * 0.0012));
  }, { passive: false });
  canvas.addEventListener('dblclick', () => {
    state.yaw = 0; state.pitch = 35; state.zoom = 1;
    state.panX = 0; state.panY = 0;
    dirty = true;
  });

  // ------------------------------------------------------------ controls
  const PLAY_MS = 700;
  let playTickT = 0;                   // when the current play step began (flow tf)

  let markWind = () => {};              // set by wireControls once the chips exist
  function markDomUI() {
    $('dom-local').classList.toggle('sel', DK === 'local');
    $('dom-wide').classList.toggle('sel', DK === 'wide');
    $('dom-note').textContent = DOMAINS[DK].label;
    document.body.classList.toggle('flowmode', state.wind === 'flow');
  }
  function setBandUI() {
    const [lo, hi] = state.band;
    $('band-lo').value = lo;
    $('band-hi').value = hi;
    const full = lo <= 0 && hi >= TOP_FT;
    const lev = state.bandLev;
    $('band-label').textContent = full ? 'all altitudes'
      : `${fmtK(lo)}–${fmtK(hi)} ft` + (lev ? ` · ${lev === 'sfc' ? 'surface' : lev + ' mb'}` : '');
    const f = $('band-fill');
    f.style.left = (lo / TOP_FT * 100) + '%';
    f.style.width = ((hi - lo) / TOP_FT * 100) + '%';
  }
  // vertical exaggeration: everything cached in world z has to be re-derived
  // (terrain mesh stores ft, cloud decks and the flow field read zOf/Z_K live)
  function setVexUI() {
    const txt = '×' + (ZSCALE % 1 ? ZSCALE.toFixed(1) : ZSCALE);
    $('vex').value = ZSCALE;
    $('vex-label').textContent = txt;
    const f = $('vex-foot');
    if (f) f.textContent = txt.slice(1);
  }
  function setZScale(v) {
    v = clamp(+v || VEX_DEF, VEX_MIN, VEX_MAX);
    if (v === ZSCALE) { setVexUI(); return; }
    ZSCALE = v;
    TOP_Z = zOf(TOP_FT);
    Z_K = 0.0003048 * ZSCALE;
    if (data.grid && built.hour >= 0) {
      built.cols = buildColumns(built.hour);
      built.fz = buildFreezing(built.hour);
    }
    setVexUI(); persist(); dirty = true;
  }

  // In flow mode the winds-aloft chips stop being "draw arrows here" and
  // become altitude presets: each one confines the tracers to the slab of sky
  // that level owns (its neighbours' midpoints), so picking 700 mb shows the
  // 10,000 ft flow instead of the whole 40,000 ft column. Clicking the chip
  // that already owns the band drops back to that level's arrow layer.
  const CHIP_LEVELS = ['sfc', '925', '850', '700', '500', '300'];
  const chipFt = (w) => (w === 'sfc' ? 0 : (built.hFt && built.hFt[+w] != null ? built.hFt[+w] : STD_FT[+w]));
  function flowBandFor(w) {
    const i = CHIP_LEVELS.indexOf(w);
    if (i < 0) return null;
    const h = CHIP_LEVELS.map(chipFt);
    const q = (v) => clamp(Math.round(v / 250) * 250, 0, TOP_FT);
    const lo = i === 0 ? 0 : q((h[i - 1] + h[i]) / 2);
    const hi = i === h.length - 1 ? TOP_FT : q((h[i] + h[i + 1]) / 2);
    return hi - lo >= 1000 ? [lo, hi] : [lo, clamp(lo + 1000, 0, TOP_FT)];
  }
  // which preset owns the band right now (null once the band is dragged by hand)
  const bandChip = () => (state.wind === 'flow' ? state.bandLev : null);

  function bandInput(which) {
    let lo = +$('band-lo').value, hi = +$('band-hi').value;
    if (hi - lo < 1000) { if (which === 'lo') lo = hi - 1000; else hi = lo + 1000; }
    state.band = [clamp(lo, 0, TOP_FT), clamp(hi, 0, TOP_FT)];
    state.bandLev = null;
    setBandUI(); markWind(); persist(); dirty = true;
  }

  function wireControls() {
    $('hour-slider').addEventListener('input', (e) => { stopPlay(); setHour(+e.target.value); });
    $('now-btn').addEventListener('click', () => { stopPlay(); setHour(state.nowIdx); });
    $('play-btn').addEventListener('click', () => playing ? stopPlay() : startPlay());
    $('refresh-btn').addEventListener('click', () => {
      stopPlay();
      loadAll(true); loadMetar(); loadRadar().catch(() => {});
    });
    for (const [id, key] of [['tg-cl', 'cl'], ['tg-fz', 'fz'], ['tg-pr', 'pr'], ['tg-gd', 'gd']]) {
      const b = $(id);
      b.classList.toggle('on', state.layers[key]);
      b.addEventListener('click', () => {
        state.layers[key] = !state.layers[key];
        b.classList.toggle('on', state.layers[key]);
        persist(); updateNote(); dirty = true;
      });
    }
    const chips = document.querySelectorAll('#wind-chips .chip');
    markWind = () => {
      const bc = bandChip();
      chips.forEach((c) => {
        const w = c.dataset.w;
        c.classList.toggle('sel', w === state.wind || w === bc);
        if (CHIP_LEVELS.includes(w)) {
          c.title = state.wind === 'flow'
            ? (w === bc ? 'flow tracers in this layer — click again for the arrow layer'
                        : 'confine the flow to this layer')
            : (w === 'sfc' ? 'surface wind' : w + ' mb');
        }
      });
    };
    chips.forEach((c) => c.addEventListener('click', () => {
      const w = c.dataset.w;
      // in flow mode a level chip re-aims the band instead of leaving flow
      if (state.wind === 'flow' && CHIP_LEVELS.includes(w) && w !== bandChip()) {
        state.band = flowBandFor(w);
        state.bandLev = w;
        setBandUI(); markWind(); persist(); dirty = true;
        return;
      }
      if (state.wind === 'flow' && w === 'flow') {      // flow again = whole column
        state.band = [0, TOP_FT];
        state.bandLev = null;
        setBandUI(); markWind(); persist(); dirty = true;
        return;
      }
      state.wind = w;
      markWind(); markDomUI(); persist(); dirty = true;
    }));
    markWind();
    $('dom-local').addEventListener('click', () => switchDomain('local'));
    $('dom-wide').addEventListener('click', () => switchDomain('wide'));
    $('band-lo').addEventListener('input', () => bandInput('lo'));
    $('band-hi').addEventListener('input', () => bandInput('hi'));
    $('band-all').addEventListener('click', () => {
      state.band = [0, TOP_FT];
      state.bandLev = null;
      setBandUI(); markWind(); persist(); dirty = true;
    });
    $('vex').addEventListener('input', (e) => setZScale(+e.target.value));
    $('vex').addEventListener('dblclick', () => setZScale(VEX_DEF));
    setVexUI();
    setBandUI();
    markDomUI();
  }
  function startPlay() {
    playing = true; $('play-btn').textContent = '❚❚';
    playTickT = performance.now();
    playTimer = setInterval(() => {
      if (document.hidden) return;
      playTickT = performance.now();
      setHour(state.sel + 1 > data.times.length - 1 ? state.nowIdx : state.sel + 1);
    }, PLAY_MS);
  }
  function stopPlay() {
    playing = false; $('play-btn').textContent = '▶';
    if (playTimer) { clearInterval(playTimer); playTimer = null; }
  }

  // ------------------------------------------------------------ boot
  function resize() {
    const r = canvas.getBoundingClientRect();
    dpr = window.devicePixelRatio || 1;
    cssW = r.width; cssH = r.height;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    dirty = true;
  }
  new ResizeObserver(resize).observe(canvas);

  function frame() {
    const flowOn = state.wind === 'flow' && !!data.grid && built.hour >= 0;
    if (!document.hidden) {
      if (flowOn) {
        if (!flow.ready) { flowAlloc(); flow.ready = true; flow.lastT = performance.now(); }
        const t0 = performance.now();
        stepParticles(t0);
        render();
        dirty = false;
        // FPS governor (glow.html-style): thin the field on slow machines,
        // grow back when there's headroom
        flow.emaMs = flow.emaMs * 0.95 + (performance.now() - t0) * 0.05;
        if (++flow.govTick >= 90) {
          flow.govTick = 0;
          if (flow.emaMs > 24 && flow.live > FLOW_MIN) {
            flow.live = Math.max(FLOW_MIN, (flow.live * 0.75) | 0);
          } else if (flow.emaMs < 13 && flow.live < FLOW_N) {
            flow.live = Math.min(FLOW_N, (flow.live * 1.3) | 0);
          }
        }
      } else if (dirty) { dirty = false; render(); }
    }
    requestAnimationFrame(frame);
  }

  $('ctr-apt').textContent = A.id;
  $('col-apt').textContent = A.id;
  buildGroundBase();
  resize();
  wireControls();
  loadAll();
  loadMetar();
  loadTerrain();
  loadRadar().catch(() => { /* radar is garnish */ });
  setInterval(() => loadRadar().catch(() => {}), 5 * 60 * 1000);
  requestAnimationFrame(frame);

  // read-only handle for headless checks
  window.WX3D_DEBUG = {
    state,
    ready: () => !!data.grid,
    hours: () => data.times.length,
    setHour,
    sheets: () => built.sheets.map((s) => ({ p: s.p, hFt: Math.round(s.hFt), max: +s.maxCover.toFixed(2) })),
    flow: () => ({ on: state.wind === 'flow', ready: flow.ready, live: flow.live,
                   emaMs: +flow.emaMs.toFixed(1), levels: flow.f0 ? flow.f0.nL : 0,
                   sample: flow.ready ? { x: +flow.hx[0].toFixed(2), y: +flow.hy[0].toFixed(2), zft: Math.round(flow.hz[0]), kt: +flow.sp[0].toFixed(1) } : null }),
    terr: () => ({ ok: terr.ok, cells: terr.mesh.length, marks: terr.marks.length,
                   ctrM: terr.ok ? Math.round(elevAtLL(A.lat, A.lon)) : null,
                   sugarloafM: terr.ok ? Math.round(elevAtLL(39.2621, -77.3944)) : null,
                   midBayM: terr.ok ? Math.round(elevAtLL(38.55, -76.4)) : null }),
    domain: () => DK,
    switchDomain,
    vex: () => ZSCALE,
    source: () => ({ snap: modelSrc.snap, stale: modelSrc.stale,
                     ageMin: Math.round((Date.now() - modelSrc.t) / 60000) }),
    setZScale,
    view: () => ({ yaw: +state.yaw.toFixed(1), pitch: +state.pitch.toFixed(1),
                   zoom: +state.zoom.toFixed(2), panX: Math.round(state.panX),
                   panY: Math.round(state.panY), band: state.band.slice(), tf: +flow.tf.toFixed(3) }),
  };
})();
