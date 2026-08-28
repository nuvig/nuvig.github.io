// The Air Above — the forecast drawn as a rotatable 3-D block of sky.
//
// One orthographic camera orbits a volume ~120 nm wide and 40,000 ft tall
// centered on the field. Every horizontal surface (the ground map, each
// cloud deck) is an offscreen texture drawn with a single affine transform —
// legal because the projection is orthographic, so a horizontal plane maps
// to a parallelogram — and everything else (winds, the freezing surface,
// precip columns, the wind-barb staff) is projected vector work. The scene
// is painted bottom-up, which is the correct painter's order for stacked
// horizontal layers seen from above (pitch is clamped ≥ 12°).
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
  const A = SITE.airport;
  const TZ = SITE.weather.timeZone;
  const D2R = Math.PI / 180, TAU = Math.PI * 2;
  const M2FT = 3.28084;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };

  // ------------------------------------------------------------ the volume
  const GN = 5;                        // grid points per side
  const SPAN_LAT = 2.0, SPAN_LON = 2.5;         // degrees, full box
  const KM_LAT = 111.32;
  const KM_LON = 111.32 * Math.cos(A.lat * D2R);
  const HALF_X = SPAN_LON / 2 * KM_LON;         // ~108 km east–west
  const HALF_Y = SPAN_LAT / 2 * KM_LAT;         // ~111 km north–south
  const TOP_FT = 40000;
  const ZSCALE = 7.5;                  // vertical exaggeration (km world per km alt)
  const zOf = (ft) => ft * 0.0003048 * ZSCALE;
  const TOP_Z = zOf(TOP_FT);
  const latN = A.lat + SPAN_LAT / 2, latS = A.lat - SPAN_LAT / 2;
  const lonW = A.lon - SPAN_LON / 2, lonE = A.lon + SPAN_LON / 2;
  const lats = [], lons = [];          // grid rows N→S, columns W→E
  for (let i = 0; i < GN; i++) {
    lats.push(latN - i * SPAN_LAT / (GN - 1));
    lons.push(lonW + i * SPAN_LON / (GN - 1));
  }
  const gy = lats.map((la) => (la - A.lat) * KM_LAT);   // world y of each row
  const gx = lons.map((lo) => (lo - A.lon) * KM_LON);   // world x of each column

  const LEVELS = [1000, 925, 850, 700, 600, 500, 400, 300, 250, 200];
  // standard-atmosphere heights, ft — fallback if the field column never loads
  const STD_FT = { 1000: 360, 925: 2500, 850: 4780, 700: 9880, 600: 13800, 500: 18280, 400: 23570, 300: 30060, 250: 34000, 200: 38660 };
  const levelTint = (p) => p >= 850 ? [150, 159, 172] : p >= 500 ? [188, 197, 212] : [222, 231, 245];

  // ------------------------------------------------------------ state
  const state = {
    sel: 0, nowIdx: 0,
    yaw: 0, pitch: 35, zoom: 1,
    layers: { cl: true, fz: true, pr: true, gd: true },
    wind: '850',                       // 'off' | 'sfc' | one of LEVELS as string
  };
  try {
    const s = JSON.parse(localStorage.getItem('wx3d_layers') || 'null');
    if (s) { Object.assign(state.layers, s.layers || {}); if (s.wind) state.wind = s.wind; }
  } catch (e) { /* private mode */ }
  const persist = () => {
    try { localStorage.setItem('wx3d_layers', JSON.stringify({ layers: state.layers, wind: state.wind })); }
    catch (e) { /* private mode */ }
  };

  const data = { grid: null, center: null, times: [] };
  const built = { hour: -1, sheets: [], blobs: null, cols: [], fz: null, hFt: null };
  const radar = { path: '', time: 0, canvas: null };
  let dirty = true, playing = false, playTimer = null;

  // ------------------------------------------------------------ fetch
  function gridUrl() {
    const la = [], lo = [];
    for (let iy = 0; iy < GN; iy++) for (let ix = 0; ix < GN; ix++) {
      la.push(lats[iy].toFixed(3)); lo.push(lons[ix].toFixed(3));
    }
    const vars = [];
    for (const L of LEVELS) {
      vars.push(`cloud_cover_${L}hPa`, `relative_humidity_${L}hPa`,
                `wind_speed_${L}hPa`, `wind_direction_${L}hPa`);
    }
    vars.push('precipitation', 'freezing_level_height', 'cape',
              'wind_speed_10m', 'wind_direction_10m');
    return 'https://api.open-meteo.com/v1/forecast?latitude=' + la.join(',') +
      '&longitude=' + lo.join(',') + '&hourly=' + vars.join(',') +
      '&models=gfs_seamless&windspeed_unit=kn&timezone=UTC&forecast_days=3';
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

  async function fetchJSON(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  async function loadAll() {
    setStatus('loading the atmosphere…');
    try {
      const [g, c] = await Promise.all([
        fetchJSON(gridUrl()),
        fetchJSON(centerUrl()).catch(() => null),   // volume still works without it
      ]);
      const arr = Array.isArray(g) ? g : [g];
      if (arr.length !== GN * GN) throw new Error('grid came back short');
      data.grid = arr.map((o) => o.hourly);
      data.center = c ? c.hourly : null;
      data.times = data.grid[0].time.map((t) => new Date(t + 'Z').getTime());
      const now = Date.now();
      let idx = 0;
      for (let i = 0; i < data.times.length; i++) if (data.times[i] <= now) idx = i;
      state.nowIdx = idx;
      state.sel = idx;
      const sl = $('hour-slider');
      sl.max = data.times.length - 1;
      sl.value = idx;
      setStatus('');
      rebuild(idx);
    } catch (e) {
      setStatus('couldn’t load the model — ' + e.message + ' · try Refresh');
    }
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
    if (f.path === radar.path) return;
    const Z = 7, N = 1 << Z;
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
    radar.path = f.path; radar.time = f.time * 1000; radar.canvas = c;
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
  const terr = { ok: false, nx: 0, ny: 0, lat0: 0, lon0: 0, dlat: 0, dlon: 0,
                 elev: null, shade: null, mesh: [], marks: [] };
  const MESH_STEP = 3, MESH_MIN_M = 90;
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
    try {
      const t = await fetchJSON('data/wx3d/terrain.json');
      // built for one specific box — drop a stale file rather than misdraw it
      if (Math.abs(t.lat0 - latN) > 0.02 || Math.abs(t.lon0 - lonW) > 0.02 ||
          Math.abs(t.lat0 - (t.ny - 1) * t.dlat - latS) > 0.02) {
        console.warn('terrain.json bbox mismatch — rerun scripts/build_wx3d_terrain.py');
        return;
      }
      terr.nx = t.nx; terr.ny = t.ny;
      terr.lat0 = t.lat0; terr.lon0 = t.lon0; terr.dlat = t.dlat; terr.dlon = t.dlon;
      terr.elev = Int16Array.from(t.elev);
      terr.marks = t.landmarks || [];
      buildShade();
      buildMesh();
      terr.ok = true;
      buildGroundBase();
      dirty = true;
    } catch (e) { /* the page is fine without terrain */ }
  }

  function buildShade() {
    const { nx, ny, elev } = terr;
    const dxm = terr.dlon * 111320 * Math.cos(A.lat * D2R);
    const dym = terr.dlat * 111320;
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
    terr.shade = s;
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

  function buildMesh() {
    terr.mesh = [];
    const { nx, ny, elev, shade } = terr;
    const wx = (ix) => ((terr.lon0 + ix * terr.dlon) - A.lon) * KM_LON;
    const wy = (iy) => ((terr.lat0 - iy * terr.dlat) - A.lat) * KM_LAT;
    for (let iy = 0; iy + MESH_STEP < ny; iy += MESH_STEP) {
      for (let ix = 0; ix + MESH_STEP < nx; ix += MESH_STEP) {
        const i00 = iy * nx + ix, i01 = i00 + MESH_STEP;
        const i10 = (iy + MESH_STEP) * nx + ix, i11 = i10 + MESH_STEP;
        const e00 = elev[i00], e01 = elev[i01], e10 = elev[i10], e11 = elev[i11];
        if (Math.max(e00, e01, e10, e11) < MESH_MIN_M) continue;
        const em = (e00 + e01 + e10 + e11) / 4;
        const sm = (shade[i00] + shade[i01] + shade[i10] + shade[i11]) / 4 * 1.12;
        const [r, g, b] = rampAt(em);
        terr.mesh.push({
          x0: wx(ix), x1: wx(ix + MESH_STEP), y0: wy(iy), y1: wy(iy + MESH_STEP),
          z00: zOf(Math.max(0, e00) * M2FT), z01: zOf(Math.max(0, e01) * M2FT),
          z10: zOf(Math.max(0, e10) * M2FT), z11: zOf(Math.max(0, e11) * M2FT),
          d: 0,
          col: `rgb(${Math.round(r * sm)},${Math.round(g * sm)},${Math.round(b * sm)})`,
        });
      }
    }
  }

  function drawTerrainMesh() {
    if (!terr.mesh.length) return;
    for (const q of terr.mesh) {
      q.d = ((q.x0 + q.x1) / 2) * sinY + ((q.y0 + q.y1) / 2) * cosY;
    }
    terr.mesh.sort((a, b) => b.d - a.d);        // farthest first
    ctx.lineWidth = 0.75;
    for (const q of terr.mesh) {
      const p1 = project(q.x0, q.y0, q.z00), p2 = project(q.x1, q.y0, q.z01);
      const p3 = project(q.x1, q.y1, q.z11), p4 = project(q.x0, q.y1, q.z10);
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
    // graticule each 0.5°
    g.strokeStyle = 'rgba(150,170,200,0.075)'; g.lineWidth = 1;
    for (let la = Math.ceil(latS * 2) / 2; la <= latN; la += 0.5) {
      const y = (latN - la) / SPAN_LAT * S;
      g.beginPath(); g.moveTo(0, y); g.lineTo(S, y); g.stroke();
    }
    for (let lo = Math.ceil(lonW * 2) / 2; lo <= lonE; lo += 0.5) {
      const x = (lo - lonW) / SPAN_LON * S;
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, S); g.stroke();
    }
    // 20 / 40 nm rings around the field
    g.strokeStyle = 'rgba(150,170,200,0.16)';
    for (const nm of [20, 40]) {
      const km = nm * 1.852;
      g.beginPath();
      g.ellipse(S / 2, S / 2, km / (2 * HALF_X) * S, km / (2 * HALF_Y) * S, 0, 0, TAU);
      g.stroke();
    }
    g.strokeStyle = 'rgba(160,180,210,0.3)'; g.lineWidth = 1.5;
    g.strokeRect(0.75, 0.75, S - 1.5, S - 1.5);
    groundBase = c;
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
    buildFlowField(i);
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
  const Z_K = 0.0003048 * ZSCALE;      // ft → world km (matches zOf)
  const FLOW_COLS = ['rgba(148,166,190,0.42)', 'rgba(74,158,255,0.5)',
                     'rgba(240,192,64,0.58)', 'rgba(255,107,107,0.62)'];
  const flowCol = (kt) => kt < 12 ? 0 : kt < 25 ? 1 : kt < 40 ? 2 : 3;
  const flow = {
    ready: false, live: FLOW_N, emaMs: 16, govTick: 0, buckets: null,
    hx: null, hy: null, hz: null, tx: null, ty: null, sp: null, age: null, life: null,
    nL: 0, h: null, u: null, v: null, lastT: 0,
  };

  function buildFlowField(i) {
    const MAXL = LEVELS.length + 1;
    if (!flow.h) {
      flow.h = new Float32Array(MAXL);
      flow.u = new Float32Array(MAXL * GN * GN);
      flow.v = new Float32Array(MAXL * GN * GN);
    }
    let n = 0;
    const put = (hft, wsName, wdName) => {
      const base = n * GN * GN;
      for (let k = 0; k < GN * GN; k++) {
        const ws = H(k, wsName, i), wd = H(k, wdName, i);
        if (ws == null || wd == null) { flow.u[base + k] = 0; flow.v[base + k] = 0; continue; }
        const r = wd * D2R;
        flow.u[base + k] = -Math.sin(r) * ws;   // flow components, kt (°true)
        flow.v[base + k] = -Math.cos(r) * ws;
      }
      flow.h[n] = hft; n++;
    };
    put(A.elevFt + 33, 'wind_speed_10m', 'wind_direction_10m');
    for (const L of LEVELS) {
      const hft = levelFt(L, i);
      if (hft <= flow.h[n - 1] + 100) continue;    // below-ground / degenerate
      put(hft, `wind_speed_${L}hPa`, `wind_direction_${L}hPa`);
    }
    flow.nL = n;
  }

  const flowTopFt = () => Math.min(TOP_FT, flow.nL ? flow.h[flow.nL - 1] : 31000) - 400;

  function flowSeed(i, scatterAge) {
    flow.hx[i] = (Math.random() * 2 - 1) * HALF_X * 0.99;
    flow.hy[i] = (Math.random() * 2 - 1) * HALF_Y * 0.99;
    flow.hz[i] = 200 + Math.random() * Math.max(1000, flowTopFt() - 200);
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

  const wSamp = { u: 0, v: 0 };
  function sampleWind(x, y, zft) {
    const gfx = clamp((x + HALF_X) / (2 * HALF_X), 0, 1) * (GN - 1);
    const gfy = clamp((HALF_Y - y) / (2 * HALF_Y), 0, 1) * (GN - 1);   // row 0 = north
    const ix = Math.min(GN - 2, Math.floor(gfx)), tx = gfx - ix;
    const iy = Math.min(GN - 2, Math.floor(gfy)), ty = gfy - iy;
    let k = 0;
    while (k < flow.nL - 2 && flow.h[k + 1] < zft) k++;
    const tz = clamp((zft - flow.h[k]) / Math.max(1, flow.h[k + 1] - flow.h[k]), 0, 1);
    const i00 = iy * GN + ix, i10 = i00 + GN;
    const w00 = (1 - tx) * (1 - ty), w01 = tx * (1 - ty);
    const w10 = (1 - tx) * ty, w11 = tx * ty;
    const b0 = k * GN * GN, b1 = b0 + GN * GN;
    const u0 = flow.u[b0 + i00] * w00 + flow.u[b0 + i00 + 1] * w01 + flow.u[b0 + i10] * w10 + flow.u[b0 + i10 + 1] * w11;
    const v0 = flow.v[b0 + i00] * w00 + flow.v[b0 + i00 + 1] * w01 + flow.v[b0 + i10] * w10 + flow.v[b0 + i10 + 1] * w11;
    const u1 = flow.u[b1 + i00] * w00 + flow.u[b1 + i00 + 1] * w01 + flow.u[b1 + i10] * w10 + flow.u[b1 + i10 + 1] * w11;
    const v1 = flow.v[b1 + i00] * w00 + flow.v[b1 + i00 + 1] * w01 + flow.v[b1 + i10] * w10 + flow.v[b1 + i10 + 1] * w11;
    wSamp.u = u0 + (u1 - u0) * tz;
    wSamp.v = v0 + (v1 - v0) * tz;
  }

  function stepParticles(now) {
    const dt = Math.min(0.05, Math.max(0.001, (now - flow.lastT) / 1000));
    flow.lastT = now;
    const kk = KT_KMS * FLOW_SPEED * dt;
    const lag = Math.min(1, dt * 9);
    for (let i = 0; i < flow.live; i++) {
      sampleWind(flow.hx[i], flow.hy[i], flow.hz[i]);
      flow.sp[i] = Math.hypot(wSamp.u, wSamp.v);
      flow.hx[i] += wSamp.u * kk;
      flow.hy[i] += wSamp.v * kk;
      flow.tx[i] += (flow.hx[i] - flow.tx[i]) * lag;
      flow.ty[i] += (flow.hy[i] - flow.ty[i]) * lag;
      flow.age[i] += dt;
      if (flow.age[i] > flow.life[i] ||
          Math.abs(flow.hx[i]) > HALF_X || Math.abs(flow.hy[i]) > HALF_Y) flowSeed(i, false);
    }
  }

  // one path per (altitude band × speed color): thousands of streaklets,
  // a handful of stroke() calls
  function drawFlowBand(k) {
    for (let c = 0; c < 4; c++) {
      const list = flow.buckets[k * 4 + c];
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
    const yaw = state.yaw * D2R, pitch = clamp(state.pitch, 12, 88) * D2R;
    sinY = Math.sin(yaw); cosY = Math.cos(yaw);
    sinP = Math.sin(pitch); cosP = Math.cos(pitch);
    // fit: the projected box is at most 2·diag wide and 2·HY·sinP + TOP·cosP tall
    const diag = Math.hypot(HALF_X, HALF_Y);
    const w = 2 * diag, h = 2 * HALF_Y * sinP + TOP_Z * cosP;
    scale = Math.min(cssW * 0.95 / w, cssH * 0.88 / h) * state.zoom;
    cx = cssW / 2;
    cy = cssH / 2 + TOP_Z * cosP * scale / 2;
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

    // airports
    items.push({ z: -1.2, fn: () => {
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      for (const ap of SITE.weather.nearbyAirports) {
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
      // the field: runway stripe on its true axis + label
      const ax = SITE.tracker.runway.axisTrue * D2R;
      const rl = 7, dx = Math.sin(ax) * rl, dy = Math.cos(ax) * rl;
      const p1 = project(-dx, -dy, 0), p2 = project(dx, dy, 0);
      ctx.strokeStyle = 'rgba(230,238,250,0.95)'; ctx.lineWidth = 2.5;
      line(p1.X, p1.Y, p2.X, p2.Y);
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
      if (!flow.buckets || flow.buckets.length !== nb * 4) {
        flow.buckets = Array.from({ length: nb * 4 }, () => []);
      }
      for (const b of flow.buckets) b.length = 0;
      for (let p = 0; p < flow.live; p++) {
        const z = flow.hz[p] * Z_K;
        let k = 0;
        while (k < cuts.length && cuts[k] < z) k++;
        flow.buckets[k * 4 + flowCol(flow.sp[p])].push(p);
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
  const pointers = new Map();
  let pinchD = 0;
  canvas.addEventListener('pointerdown', (e) => {
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* synthetic or stale pointer */ }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
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
      state.yaw = (state.yaw + dx * 0.35) % 360;
      state.pitch = clamp(state.pitch + dy * 0.25, 12, 88);
      dirty = true;
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchD > 0) { state.zoom = clamp(state.zoom * d / pinchD, 0.45, 3); dirty = true; }
      pinchD = d;
    }
  });
  const drop = (e) => { pointers.delete(e.pointerId); pinchD = 0; };
  canvas.addEventListener('pointerup', drop);
  canvas.addEventListener('pointercancel', drop);
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    state.zoom = clamp(state.zoom * Math.exp(-e.deltaY * 0.0012), 0.45, 3);
    dirty = true;
  }, { passive: false });
  canvas.addEventListener('dblclick', () => {
    state.yaw = 0; state.pitch = 35; state.zoom = 1; dirty = true;
  });

  // ------------------------------------------------------------ controls
  function wireControls() {
    $('hour-slider').addEventListener('input', (e) => { stopPlay(); setHour(+e.target.value); });
    $('now-btn').addEventListener('click', () => { stopPlay(); setHour(state.nowIdx); });
    $('play-btn').addEventListener('click', () => playing ? stopPlay() : startPlay());
    $('refresh-btn').addEventListener('click', () => {
      stopPlay();
      loadAll(); loadMetar(); loadRadar().catch(() => {});
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
    const mark = () => chips.forEach((c) => c.classList.toggle('sel', c.dataset.w === state.wind));
    chips.forEach((c) => c.addEventListener('click', () => {
      state.wind = c.dataset.w; mark(); persist(); dirty = true;
    }));
    mark();
  }
  function startPlay() {
    playing = true; $('play-btn').textContent = '❚❚';
    playTimer = setInterval(() => {
      if (document.hidden) return;
      setHour(state.sel + 1 > data.times.length - 1 ? state.nowIdx : state.sel + 1);
    }, 700);
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
                   emaMs: +flow.emaMs.toFixed(1), levels: flow.nL,
                   sample: flow.ready ? { x: +flow.hx[0].toFixed(2), y: +flow.hy[0].toFixed(2), zft: Math.round(flow.hz[0]), kt: +flow.sp[0].toFixed(1) } : null }),
    terr: () => ({ ok: terr.ok, cells: terr.mesh.length, marks: terr.marks.length,
                   kanpM: terr.ok ? Math.round(elevAtLL(A.lat, A.lon)) : null,
                   sugarloafM: terr.ok ? Math.round(elevAtLL(39.2621, -77.3944)) : null,
                   midBayM: terr.ok ? Math.round(elevAtLL(38.55, -76.4)) : null }),
  };
})();
