// radar.js — US NAS Radar: every surveillance (ASR/ARSR), TDWR and WSR-88D
// site in data/radar.json on a Leaflet map with nominal-range rings, category
// toggles, an ID/name filter, the sites whose range reaches the home field,
// and a sortable table. Data is built by scripts/build_radar.py.

(function () {
  'use strict';
  const $ = id => document.getElementById(id);

  const COLORS = { term: '#4a9eff', enr: '#f0a030', tdwr: '#34d399', nexrad: '#c084fc' };
  const KIND = { term: 'Terminal', enr: 'En route', tdwr: 'TDWR', nexrad: 'WSR-88D' };
  const ORDER = { term: 0, enr: 1, tdwr: 2, nexrad: 3 };
  const NM_M = 1852;
  const PAGE = 120;

  const home = SITE.airport;
  const R_NM = 3440.065;
  const rad = d => d * Math.PI / 180;
  function distNm(lat1, lon1, lat2, lon2) {
    const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R_NM * Math.asin(Math.sqrt(s));
  }
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  let data, sites = [], map;
  const on = { term: true, enr: true, tdwr: true, nexrad: true };
  let ringsOn = true;
  let q = '';
  let sortK = 'cat', sortDir = 1;
  let shown = PAGE;
  let selected = null;
  const markers = new Map();        // site → circleMarker
  const rings = new Map();          // site → circle
  const groups = {};                // cat → { pts: layerGroup, rings: layerGroup }

  // ------------------------------------------------------------------- map
  function initMap() {
    map = L.map('radar-map', { zoomControl: true, preferCanvas: true, worldCopyJump: true });
    map.fitBounds([[24.5, -125], [49.5, -66.5]]);

    const base = {
      'Dark': L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png?key=' + SITE.basemap.cartoKey, {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
        subdomains: 'abcd', maxZoom: 19,
      }),
      'Streets': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>', maxZoom: 19,
      }),
      'Satellite': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        attribution: '&copy; Esri', maxZoom: 19,
      }),
    };
    const over = {
      'IFR Enroute Low': L.tileLayer('https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/IFR_AreaLow/MapServer/tile/{z}/{y}/{x}', {
        attribution: 'FAA', opacity: 0.6, minNativeZoom: 7, maxNativeZoom: 12, maxZoom: 19,
      }),
      'VFR Sectional': L.tileLayer('https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/VFR_Sectional/MapServer/tile/{z}/{y}/{x}', {
        attribution: 'FAA', opacity: 0.6, maxNativeZoom: 11, maxZoom: 19,
      }),
    };
    base['Dark'].addTo(map);
    L.control.layers(base, over, { collapsed: true }).addTo(map);

    for (const cat of Object.keys(COLORS)) {
      groups[cat] = { rings: L.layerGroup().addTo(map), pts: L.layerGroup().addTo(map) };
    }

    // Home field marker + a zoom-home button.
    L.circleMarker([home.lat, home.lon], { radius: 4, color: '#fff', weight: 1.5, fillColor: '#111', fillOpacity: 1, interactive: false }).addTo(map);
    const Home = L.Control.extend({
      onAdd() {
        const div = L.DomUtil.create('div', 'leaflet-bar');
        const a = L.DomUtil.create('a', 'home-btn', div);
        a.href = '#'; a.textContent = home.id; a.title = home.id;
        L.DomEvent.on(a, 'click', e => { L.DomEvent.stop(e); map.setView([home.lat, home.lon], 8); });
        const b = L.DomUtil.create('a', 'home-btn', div);
        b.href = '#'; b.textContent = 'US'; b.title = 'Conterminous US';
        L.DomEvent.on(b, 'click', e => { L.DomEvent.stop(e); map.fitBounds([[24.5, -125], [49.5, -66.5]]); });
        return div;
      },
    });
    new Home({ position: 'topleft' }).addTo(map);
  }

  function popupHtml(s) {
    const d = distNm(home.lat, home.lon, s.lat, s.lon);
    const kv = [];
    kv.push(['Kind', KIND[s.cat]]);
    if (s.pri) kv.push(['Primary', s.pri]);
    if (s.bcn) kv.push(['Beacon', s.bcn]);
    if (s.ii) kv.push(['II code', s.ii]);
    kv.push(['Range', s.rng + ' nm']);
    if (s.elev != null) kv.push(['Elev', s.elev.toLocaleString() + ' ft']);
    kv.push(['Position', s.lat.toFixed(4) + ', ' + s.lon.toFixed(4)]);
    kv.push([home.id, d.toFixed(0) + ' nm' + (d <= s.rng ? ' · in range' : '')]);
    if (s.mil) kv.push(['Owner', 'DoD']);
    const src = data.sources[s.src] || data.sources[(s.src || '').split('+')[0]];
    if (src) kv.push(['Source', `<a href="${esc(src.url)}">${esc(src.via)}</a>`]);
    return `<div class="pop" style="--c:${COLORS[s.cat]}"><h4>${esc(s.id || '—')}<small>${esc(s.name)}</small></h4>` +
      `<div class="kv">${kv.map(([k, v]) => `<span>${k}</span><b>${v}</b>`).join('')}</div></div>`;
  }

  function addSite(s) {
    const c = COLORS[s.cat];
    const m = L.circleMarker([s.lat, s.lon], {
      radius: s.cat === 'enr' ? 5 : 4, color: c, weight: 1.5, fillColor: c, fillOpacity: 0.85,
    });
    m.bindPopup(() => popupHtml(s), { maxWidth: 320 });
    m.bindTooltip(`${s.id || ''} ${s.name}`.trim(), { direction: 'top', offset: [0, -4], opacity: 0.9 });
    m.on('click', () => select(s, false));
    markers.set(s, m);
    const r = L.circle([s.lat, s.lon], {
      radius: s.rng * NM_M, color: c, weight: 1, opacity: 0.35, fillColor: c, interactive: false,
      fillOpacity: s.cat === 'enr' ? 0.02 : s.cat === 'nexrad' ? 0.03 : 0.05,   // the 200 nm rings overlap most
    });
    rings.set(s, r);
  }

  function matches(s) {
    if (!on[s.cat]) return false;
    if (!q) return true;
    return (s.id || '').toLowerCase().includes(q) || s.name.toLowerCase().includes(q) ||
      (s.pri || '').toLowerCase().includes(q) || (s.bcn || '').toLowerCase().includes(q);
  }

  function refreshMap() {
    let n = 0;
    for (const cat of Object.keys(groups)) { groups[cat].pts.clearLayers(); groups[cat].rings.clearLayers(); }
    for (const s of sites) {
      if (!matches(s)) continue;
      n++;
      groups[s.cat].pts.addLayer(markers.get(s));
      if (ringsOn) groups[s.cat].rings.addLayer(rings.get(s));
    }
    $('n-shown').textContent = n;
    return n;
  }

  // ---------------------------------------------------------------- select
  function select(s, pan) {
    selected = s;
    if (pan) {
      map.setView([s.lat, s.lon], Math.max(map.getZoom(), s.cat === 'enr' || s.cat === 'nexrad' ? 7 : 8));
      const m = markers.get(s);
      if (m && map.hasLayer(groups[s.cat].pts) && groups[s.cat].pts.hasLayer(m)) m.openPopup();
    }
    if (s.id) history.replaceState(null, '', '#' + encodeURIComponent(s.id));
    renderTable();
  }

  // ----------------------------------------------------------------- cover
  function renderCover() {
    const rows = sites
      .map(s => ({ s, d: distNm(home.lat, home.lon, s.lat, s.lon) }))
      .filter(x => x.d <= x.s.rng)
      .sort((a, b) => ORDER[a.s.cat] - ORDER[b.s.cat] || a.d - b.d);
    $('home-id').textContent = home.id;
    $('cover').innerHTML = rows.map(({ s, d }) =>
      `<div class="row" data-i="${sites.indexOf(s)}" style="--c:${COLORS[s.cat]}"><i></i>` +
      `<span class="id">${esc(s.id || '—')}</span><span class="nm">${esc(s.name)}</span>` +
      `<span class="ty">${esc(s.pri || s.bcn || KIND[s.cat])}</span><span class="d">${d.toFixed(0)} nm</span></div>`
    ).join('') || '<div class="row">none</div>';
    $('cover').querySelectorAll('.row[data-i]').forEach(el => el.addEventListener('click', () => select(sites[+el.dataset.i], true)));
  }

  // ----------------------------------------------------------------- table
  function cmp(a, b) {
    const k = sortK;
    let va = a[k], vb = b[k];
    if (k === 'cat') { va = ORDER[a.cat]; vb = ORDER[b.cat]; }
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    if (typeof va === 'number') return (va - vb) * sortDir;
    return String(va).localeCompare(String(vb)) * sortDir || (ORDER[a.cat] - ORDER[b.cat]);
  }

  function renderTable() {
    const rows = sites.filter(matches).sort(cmp);
    const si = selected ? rows.indexOf(selected) : -1;
    if (si >= shown) shown = si + 1;               // keep the selected row on the page
    const tb = $('tbl').querySelector('tbody');
    const lim = Math.min(rows.length, shown);
    tb.innerHTML = rows.slice(0, lim).map(s =>
      `<tr class="r${s === selected ? ' sel' : ''}" data-i="${sites.indexOf(s)}" style="--c:${COLORS[s.cat]}">` +
      `<td class="id">${esc(s.id || '—')}</td><td class="nm">${esc(s.name)}</td>` +
      `<td class="ty"><i></i>${KIND[s.cat]}</td><td class="ty">${esc(s.pri || '')}</td><td class="ty">${esc(s.bcn || '')}</td>` +
      `<td class="n">${s.rng} nm</td><td class="n">${s.elev != null ? s.elev.toLocaleString() + ' ft' : ''}</td>` +
      `<td class="n">${s.lat.toFixed(4)}</td><td class="n">${s.lon.toFixed(4)}</td></tr>`
    ).join('');
    tb.querySelectorAll('tr.r').forEach(el => el.addEventListener('click', () => select(sites[+el.dataset.i], true)));
    $('tbl-sub').textContent = `${rows.length} shown · ${sites.length} total`;
    $('more').innerHTML = rows.length > lim ? `<button id="more-btn">Show ${Math.min(rows.length - lim, 500)} more</button>` : '';
    const mb = $('more-btn');
    if (mb) mb.addEventListener('click', () => { shown += 500; renderTable(); });
    $('tbl').querySelectorAll('th').forEach(th => th.classList.toggle('on', th.dataset.k === sortK));
  }

  // ----------------------------------------------------------------- wiring
  function wire() {
    document.querySelectorAll('.chip[data-cat]').forEach(b => b.addEventListener('click', () => {
      on[b.dataset.cat] = !on[b.dataset.cat];
      b.classList.toggle('on', on[b.dataset.cat]);
      refreshMap(); renderTable();
    }));
    $('rings').addEventListener('click', () => {
      ringsOn = !ringsOn; $('rings').classList.toggle('on', ringsOn); refreshMap();
    });
    let t;
    $('q').addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => { q = $('q').value.trim().toLowerCase(); shown = PAGE; refreshMap(); renderTable(); }, 120);
    });
    $('tbl').querySelectorAll('th').forEach(th => th.addEventListener('click', () => {
      const k = th.dataset.k;
      if (sortK === k) sortDir = -sortDir; else { sortK = k; sortDir = 1; }
      renderTable();
    }));
  }

  async function init() {
    initMap();
    wire();
    try {
      const r = await fetch('data/radar.json', { cache: 'no-cache' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      data = await r.json();
    } catch (e) {
      $('status').innerHTML = `<span>radar.json → <b>unavailable</b> (${esc(e.message)})</span>`;
      return;
    }
    sites = data.sites;
    sites.forEach(addSite);
    $('n-total').textContent = sites.length;
    $('built').textContent = 'built ' + data.built;
    for (const [cat, n] of Object.entries(data.counts)) {
      const el = document.querySelector(`[data-n="${cat}"]`);
      if (el) el.textContent = n;
    }
    const nws = data.sources.nws && /snapshot (\S+)/.exec(data.sources.nws.label);
    if (nws) $('nws-date').textContent = nws[1];
    refreshMap();
    renderCover();
    renderTable();
    const h = decodeURIComponent(location.hash.slice(1)).toUpperCase();
    if (h) {
      const s = sites.find(x => x.id === h);
      if (s) select(s, true);
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
