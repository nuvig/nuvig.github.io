// KANP Flight Tracker — History Map tab
// tar1090-style altitude-colored tracks from the Pi collector database,
// with FAA VFR chart + NEXRAD weather overlay layers.

const KANPHistory = (() => {
  let map = null;
  let trackLayer = null;
  let renderer = null;
  const GAP_SECONDS = 300;      // start a new segment after this gap
  const ALT_BUCKET_FT = 500;    // color resolution along a track

  function init() {
    KANP.initFilterBar('hist-filters');
    document.getElementById('hist-load').addEventListener('click', load);
    drawAltLegend();
  }

  function onShow() {
    if (!map) initMap();
    map.invalidateSize();
  }

  function initMap() {
    map = L.map('hist-map').setView([KANP.LAT, KANP.LON], 11);
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
      const data = await KANP.apiFetch('/api/tracks', params);
      draw(data);

      let msg = `${data.aircraft_count} aircraft · ` +
        `${Number(data.returned_points).toLocaleString()} points`;
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

  function draw(data) {
    trackLayer.clearLayers();

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
        renderer, color, weight: 1.6, opacity: 0.75,
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
