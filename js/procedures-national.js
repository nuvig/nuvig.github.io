// Procedure Explorer — Nationwide and This-cycle views.
// Reads data/procedures/metrics.json (one row per coded procedure, built by
// scripts/build_procedure_metrics.py) and changes.json (the diff against the
// previous AIRAC cycle). Never touches the per-airport files; drawing a row
// hands off to window.ProcExplorer.open() in procedures.js.
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmtN = n => n == null ? '—' : Number(n).toLocaleString();
  const fmtAlt = v => v == null ? '—' : v >= 18000 ? 'FL' + Math.round(v / 100) : Math.round(v).toLocaleString();
  const BLUE = '#3987e5';
  const RAMP = ['#1e3a5f', '#25518a', '#2d6bb8', '#3987e5', '#8fc1ff'];

  const S = {
    m: null, ix: {}, rows: [], apts: {}, kinds: [], states: [],
    view: 'explorer', filt: {}, hits: [], sort: { col: 'apt', dir: 1 }, shown: 300,
    changes: null, draws: [],
  };

  // ---------------------------------------------------------------- views
  function setView(v, push) {
    S.view = v;
    document.querySelectorAll('#modes button').forEach(b => b.classList.toggle('on', b.dataset.view === v));
    $('explorer').hidden = v !== 'explorer';
    $('national').hidden = v !== 'national';
    $('changes').hidden = v !== 'changes';
    if (v === 'explorer' && window.ProcExplorer) window.ProcExplorer.refresh();
    if (v === 'national') { loadMetrics().then(() => { render(); }); }
    if (v === 'changes') loadChanges().then(renderChanges);
    if (push !== false) writeHash();
  }

  function readHash() {
    return new URLSearchParams(location.hash.slice(1));
  }
  function writeHash() {
    const h = readHash();
    for (const k of [...h.keys()]) if (k !== 'apt' && k !== 'sel') h.delete(k);
    if (S.view !== 'explorer') h.set('view', S.view);
    if (S.view === 'national') {
      const f = S.filt;
      if (f.type) h.set('t', f.type);
      if (f.kind) h.set('k', f.kind);
      if (f.st) h.set('st', f.st);
      if (f.q) h.set('q', f.q);
      const flags = ['rf', 'arc', 'pi', 'hf', 'circ', 'mhold', 'co'].filter(x => f[x]);
      if (flags.length) h.set('f', flags.join(','));
      if (f.vpa) h.set('vpa', f.vpa);
      if (f.grad) h.set('grad', f.grad);
      if (f.dg) h.set('dg', f.dg);
      if (S.sort.col !== 'apt' || S.sort.dir !== 1) h.set('sort', S.sort.col + (S.sort.dir < 0 ? ':d' : ''));
    }
    const str = h.toString().replace(/%2C/g, ',').replace(/%3A/g, ':');
    history.replaceState(null, '', str ? '#' + str : location.pathname);
  }

  // ---------------------------------------------------------------- data
  let metricsP = null, changesP = null;
  function loadMetrics() {
    if (metricsP) return metricsP;
    $('nat-count').textContent = 'Loading…';
    metricsP = fetch('data/procedures/metrics.json').then(r => r.json()).then(m => {
      S.m = m;
      m.cols.forEach((c, i) => S.ix[c] = i);
      S.rows = m.rows;
      S.apts = m.apts;
      const kc = new Map(), sc = new Map();
      for (const r of m.rows) {
        kc.set(r[S.ix.kind], (kc.get(r[S.ix.kind]) || 0) + 1);
        const st = (m.apts[r[S.ix.apt]] || [])[1];
        if (st) sc.set(st, (sc.get(st) || 0) + 1);
      }
      S.kinds = [...kc.keys()].sort();
      S.states = [...sc.keys()].sort();
      initFilters();
      renderTiles();
      renderFixes();
    }).catch(() => { $('nat-count').textContent = 'Could not load data/procedures/metrics.json'; });
    return metricsP;
  }
  function loadChanges() {
    if (changesP) return changesP;
    changesP = fetch('data/procedures/changes.json').then(r => r.ok ? r.json() : null)
      .then(c => { S.changes = c; }).catch(() => { S.changes = null; });
    return changesP;
  }
  const col = (r, c) => r[S.ix[c]];
  const stOf = r => (S.apts[col(r, 'apt')] || [])[1] || '';
  const stLabel = st => st === 'XX' ? 'Pacific' : st;   // the d-TPP files Guam, Saipan, Pago Pago… under XX
  const nameOf = apt => (S.apts[apt] || [])[0] || apt;

  // ---------------------------------------------------------------- filters
  const KIND_ORDER = ['RNAV (GPS)', 'RNAV (RNP)', 'ILS', 'ILS/LOC', 'LOC', 'LOC BC', 'GLS', 'GPS', 'VOR', 'VOR/DME',
    'NDB', 'NDB/DME', 'TACAN', 'LDA', 'SDF', 'COPTER', 'VISUAL', 'RNAV', 'CONV'];
  function kindsFor(type) {
    const set = new Set();
    for (const r of S.rows) if (!type || col(r, 'type') === type) set.add(col(r, 'kind'));
    return [...set].sort((a, b) => {
      const ia = KIND_ORDER.indexOf(a.replace(/^HI-/, '')), ib = KIND_ORDER.indexOf(b.replace(/^HI-/, ''));
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
    });
  }
  function fillKinds() {
    const sel = $('nf-kind'), cur = S.filt.kind || '';
    sel.innerHTML = '<option value="">All kinds</option>' +
      kindsFor(S.filt.type).map(k => `<option value="${esc(k)}"${k === cur ? ' selected' : ''}>${esc(k)}</option>`).join('');
    if (![...sel.options].some(o => o.value === cur)) { S.filt.kind = ''; sel.value = ''; }
  }
  const PRESETS = [
    { l: 'Steep finals', t: 'vpa ≥ 3.5°', f: { type: 'APP', vpa: 3.5 }, sort: ['vpa', -1] },
    { l: 'Steep climbs', t: 'SIDs implying ≥ 400 ft/nm to the first fix', f: { type: 'SID', grad: 400 }, sort: ['grad', -1] },
    { l: 'Steep descents', t: 'STARs whose constraints require ≥ 350 ft/nm', f: { type: 'STAR', dg: 350 }, sort: ['dg', -1] },
    { l: 'RNP AR', t: 'approaches with RF legs', f: { type: 'APP', rf: true }, sort: ['apt', 1] },
    { l: 'DME arcs', t: 'AF legs', f: { arc: true }, sort: ['apt', 1] },
    { l: 'Procedure turns', t: 'PI legs', f: { type: 'APP', pi: true }, sort: ['apt', 1] },
    { l: 'Hold in lieu', t: 'HF legs', f: { type: 'APP', hf: true }, sort: ['apt', 1] },
    { l: 'Circling-only', t: 'no runway in the name', f: { type: 'APP', circ: true }, sort: ['apt', 1] },
    { l: 'NDB', t: 'what is left of them', f: { type: 'APP', kind: 'NDB' }, sort: ['apt', 1] },
    { l: 'Plate only', t: 'published, not coded in the public CIFP', f: { co: true }, sort: ['apt', 1] },
    { l: 'Longest STARs', t: 'coded length', f: { type: 'STAR' }, sort: ['len', -1] },
    { l: 'Most transitions', t: '', f: {}, sort: ['nt', -1] },
    { l: 'Highest FAF', t: 'FAF altitude', f: { type: 'APP' }, sort: ['faf', -1] },
    { l: 'Shortest finals', t: 'FAF → MAP', f: { type: 'APP' }, sort: ['fd', 1] },
  ];
  function initFilters() {
    $('nf-st').innerHTML = '<option value="">All states</option>' + S.states.map(s => `<option value="${s}">${esc(stLabel(s))}</option>`).join('');
    $('cf-st').innerHTML = $('nf-st').innerHTML;
    $('nat-presets').innerHTML = PRESETS.map((p, i) => `<button data-i="${i}" title="${esc(p.t)}">${esc(p.l)}</button>`).join('');
    $('nat-presets').addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      const p = PRESETS[+b.dataset.i];
      S.filt = Object.assign({}, p.f);
      S.sort = { col: p.sort[0], dir: p.sort[1] };
      S.shown = 300;
      syncControls(); fillKinds(); render();
    });
    const on = (id, ev, fn) => $(id).addEventListener(ev, fn);
    on('nf-type', 'change', e => { S.filt.type = e.target.value; fillKinds(); changed(); });
    on('nf-kind', 'change', e => { S.filt.kind = e.target.value; changed(); });
    on('nf-st', 'change', e => { S.filt.st = e.target.value; changed(); });
    let qt = null;
    on('nf-q', 'input', e => { clearTimeout(qt); qt = setTimeout(() => { S.filt.q = e.target.value.trim(); changed(); }, 150); });
    for (const k of ['rf', 'arc', 'pi', 'hf', 'circ', 'mhold', 'co'])
      on('nf-' + k, 'change', e => { S.filt[k] = e.target.checked; changed(); });
    for (const k of ['vpa', 'grad', 'dg'])
      on('nf-' + k, 'input', e => { S.filt[k] = e.target.value === '' ? null : +e.target.value; changed(); });
    on('nf-reset', 'click', () => { S.filt = {}; S.sort = { col: 'apt', dir: 1 }; syncControls(); fillKinds(); render(); });
    on('nat-more', 'click', () => { S.shown += 300; renderTable(); });
    on('nh-measure', 'change', () => renderHist());
    $('nh-measure').innerHTML = MEASURES.map(m => `<option value="${m.k}">${esc(m.l)}</option>`).join('');
    fillKinds();
    syncControls();
  }
  function changed() { S.shown = 300; render(); }
  function syncControls() {
    const f = S.filt;
    $('nf-type').value = f.type || '';
    $('nf-st').value = f.st || '';
    $('nf-q').value = f.q || '';
    for (const k of ['rf', 'arc', 'pi', 'hf', 'circ', 'mhold', 'co']) $('nf-' + k).checked = !!f[k];
    for (const k of ['vpa', 'grad', 'dg']) $('nf-' + k).value = f[k] == null ? '' : f[k];
    document.querySelectorAll('#nat-presets button').forEach(b => {
      const p = PRESETS[+b.dataset.i];
      const same = Object.keys(p.f).every(k => f[k] === p.f[k]) && Object.keys(f).every(k => !f[k] || p.f[k] === f[k])
        && S.sort.col === p.sort[0] && S.sort.dir === p.sort[1];
      b.classList.toggle('on', same);
    });
  }
  function applyFilter() {
    const f = S.filt, q = (f.q || '').toUpperCase();
    const ix = S.ix;
    S.hits = S.rows.filter(r => {
      if (f.type && r[ix.type] !== f.type) return false;
      if (f.kind && r[ix.kind] !== f.kind) return false;
      if (f.st && stOf(r) !== f.st) return false;
      if (f.co && !r[ix.co]) return false;
      const pts = r[ix.pts] || '';
      if (f.rf && !/\bRF\b/.test(pts)) return false;
      if (f.arc && !/\bAF\b/.test(pts)) return false;
      if (f.pi && !/\bPI\b/.test(pts)) return false;
      if (f.hf && !/\bHF\b/.test(pts)) return false;
      if (f.circ && !r[ix.circ]) return false;
      if (f.mhold && !r[ix.mhold]) return false;
      if (f.vpa != null && !(r[ix.vpa] >= f.vpa)) return false;
      if (f.grad != null && !(r[ix.grad] >= f.grad)) return false;
      if (f.dg != null && !(r[ix.dg] >= f.dg)) return false;
      if (q) {
        const apt = r[ix.apt];
        if (!(apt.includes(q) || r[ix.id].includes(q) || r[ix.name].toUpperCase().includes(q)
              || nameOf(apt).toUpperCase().includes(q))) return false;
      }
      return true;
    });
  }

  // ---------------------------------------------------------------- render
  function render() {
    if (!S.m) return;
    applyFilter();
    syncControls();
    const apts = new Set(S.hits.map(r => col(r, 'apt')));
    const f = S.filt;
    const desc = [f.type ? { APP: 'approaches', SID: 'SIDs', STAR: 'STARs' }[f.type] : 'procedures',
      f.kind ? f.kind : '', f.st ? 'in ' + f.st : ''].filter(Boolean).join(' · ');
    $('nat-count').innerHTML = `<b>${fmtN(S.hits.length)}</b> ${esc(desc)} at <b>${fmtN(apts.size)}</b> airports` +
      (S.hits.length === S.rows.length ? '' : ` · ${(100 * S.hits.length / S.rows.length).toFixed(1)}% of the country`);
    renderBreakdowns();
    renderMap();
    renderHist();
    renderTable();
    writeHash();
  }

  function renderTiles() {
    const ix = S.ix, R = S.rows;
    const n = t => R.filter(r => r[ix.type] === t).length;
    const co = R.filter(r => r[ix.co]).length;
    const tiles = [
      [fmtN(R.length), 'coded procedures'],
      [fmtN(Object.keys(S.apts).length), 'airports'],
      [fmtN(n('APP')), 'approaches'],
      [fmtN(n('SID')), 'SIDs'],
      [fmtN(n('STAR')), 'STARs'],
      [(100 * co / R.length).toFixed(1) + '%', 'plate only, not coded'],
      [esc(S.m.cycle || '—'), 'AIRAC cycle · eff. ' + esc(S.m.effective || '')],
    ];
    $('nat-tiles').innerHTML = tiles.map(([v, l]) => `<div class="tile"><div class="v">${v}</div><div class="l">${l}</div></div>`).join('');
  }

  function barsTable(el, entries, total, cur, onClick) {
    const max = Math.max(1, ...entries.map(e => e[1]));
    el.innerHTML = entries.map(([k, n]) =>
      `<tr data-k="${esc(k)}" class="${k === cur ? 'on' : ''}"><td>${esc(stLabel(k))}</td><td class="n">${fmtN(n)}</td>` +
      `<td class="n" style="color:#666">${(100 * n / total).toFixed(0)}%</td><td class="b"><i style="width:${(100 * n / max).toFixed(1)}%"></i></td></tr>`).join('');
    el.onclick = e => { const tr = e.target.closest('tr'); if (tr) onClick(tr.dataset.k === cur ? '' : tr.dataset.k); };
  }
  function renderBreakdowns() {
    const kc = new Map(), sc = new Map();
    for (const r of S.hits) {
      kc.set(col(r, 'kind'), (kc.get(col(r, 'kind')) || 0) + 1);
      const st = stOf(r); if (st) sc.set(st, (sc.get(st) || 0) + 1);
    }
    const tot = Math.max(1, S.hits.length);
    barsTable($('nat-kinds'), [...kc].sort((a, b) => b[1] - a[1]).slice(0, 14), tot, S.filt.kind || '',
      k => { S.filt.kind = k; $('nf-kind').value = k; changed(); });
    barsTable($('nat-states'), [...sc].sort((a, b) => b[1] - a[1]).slice(0, 14), tot, S.filt.st || '',
      k => { S.filt.st = k; changed(); });
  }

  // ---- canvas helpers
  function setup(c, H) {
    const dpr = window.devicePixelRatio || 1, W = c.clientWidth || 600;
    c.width = Math.round(W * dpr); c.height = Math.round(H * dpr);
    c.style.height = H + 'px';
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.font = '11px system-ui, sans-serif';
    return { ctx, W, H };
  }
  const tip = $('nat-tip');
  function hover(c, hits, html) {
    c.onmousemove = e => {
      const b = c.getBoundingClientRect(), x = e.clientX - b.left, y = e.clientY - b.top;
      const h = hits.find(h => x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h);
      if (!h) { tip.style.display = 'none'; c.style.cursor = ''; return; }
      tip.innerHTML = html(h);
      tip.style.display = 'block';
      const tw = tip.offsetWidth, th = tip.offsetHeight;
      tip.style.left = Math.min(window.innerWidth - tw - 8, e.clientX + 14) + 'px';
      tip.style.top = (e.clientY - th - 12 < 0 ? e.clientY + 16 : e.clientY - th - 12) + 'px';
      c.style.cursor = h.click ? 'pointer' : '';
    };
    c.onmouseleave = () => { tip.style.display = 'none'; };
    c.onclick = e => {
      const b = c.getBoundingClientRect(), x = e.clientX - b.left, y = e.clientY - b.top;
      const h = hits.find(h => x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h);
      if (h && h.click) h.click();
    };
  }

  // ---- map: Leaflet on the explorer's dark basemap, one dot per airport in
  // the filter (canvas renderer — thousands of markers), every other airport
  // as a faint ground so an empty filter still reads as the country
  let nmap = null, dotLayer = null, groundLayer = null;
  const CONUS = L.latLngBounds([24.3, -125.2], [49.6, -66.5]);
  function ensureMap() {
    if (nmap) return nmap;
    nmap = L.map('nat-map', { zoomControl: true, preferCanvas: true, worldCopyJump: true, attributionControl: false,
      zoomSnap: 0.25, zoomDelta: 0.5 });   // fractional zoom so the country fills the box
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png?key=' + SITE.basemap.cartoKey,
      { attribution: '© OpenStreetMap © CARTO', maxZoom: 12 }).addTo(nmap);
    L.control.attribution({ prefix: false }).addTo(nmap);
    const renderer = L.canvas({ padding: 0.3 });
    groundLayer = L.layerGroup().addTo(nmap);
    for (const a of Object.values(S.apts)) {
      if (a[2] == null) continue;
      L.circleMarker([a[2], a[3]], { renderer, radius: 1.2, stroke: false, fillColor: '#4a4a4a', fillOpacity: 0.9, interactive: false }).addTo(groundLayer);
    }
    dotLayer = L.layerGroup().addTo(nmap);
    nmap.fitBounds(CONUS);
    // dot radius follows the zoom: a whole-country view is thousands of pinpricks,
    // a state view gets the count-sized dots
    nmap.on('zoomend', () => {
      const k = Math.pow(1.35, nmap.getZoom() - 5);
      dotLayer.eachLayer(mk => mk.setRadius(Math.max(1.2, Math.min(16, mk.options.baseR * k))));
    });
    return nmap;
  }
  function renderMap() {
    const m = ensureMap();
    const renderer = L.canvas({ padding: 0.3 });
    dotLayer.clearLayers();
    const perApt = new Map();
    for (const r of S.hits) perApt.set(col(r, 'apt'), (perApt.get(col(r, 'apt')) || 0) + 1);
    const pts = [];
    for (const [apt, n] of perApt) {
      const a = S.apts[apt]; if (!a || a[2] == null) continue;
      pts.push({ apt, n, lat: a[2], lon: a[3] });
    }
    pts.sort((a, b) => a.n - b.n);
    // dot size follows the count, shrunk when the filter is wide enough to flood the map
    const sc = Math.max(0.4, Math.min(1, Math.sqrt(250 / Math.max(1, pts.length))));
    const bounds = L.latLngBounds([]);
    for (const p of pts) bounds.extend([p.lat, p.lon]);
    if (pts.length) {
      // the whole country (or anything reaching Alaska / Hawaii / the Caribbean) frames the lower 48
      const wide = bounds.getWest() < -130 || bounds.getEast() > -60 || bounds.getSouth() < 17 || !bounds.isValid();
      m.invalidateSize();
      m.fitBounds(wide ? CONUS : bounds.pad(0.15), { maxZoom: 8, animate: false });
    }
    for (const p of pts) {
      const r = Math.max(1.5, Math.min(14, (2 + 1.6 * Math.sqrt(p.n)) * sc));
      const col = p.n <= 1 ? RAMP[2] : p.n <= 3 ? RAMP[3] : RAMP[4];
      const k = Math.pow(1.35, m.getZoom() - 5);
      const mk = L.circleMarker([p.lat, p.lon], { renderer, radius: Math.max(1.2, Math.min(16, r * k)), baseR: r,
        fillColor: col, fillOpacity: 0.85, color: '#111', weight: p.n > 3 ? 1 : 0 });
      mk.bindTooltip(`<b>${esc(p.apt)}</b> · ${esc(nameOf(p.apt))}<br>${fmtN(p.n)} matching · click to open`, { direction: 'top', opacity: 0.95 });
      mk.on('click', () => openInExplorer(p.apt));
      mk.addTo(dotLayer);
    }
    $('map-sub').textContent = `${fmtN(pts.length)} airports`;
    S.draws[0] = () => m.invalidateSize();
    setTimeout(() => m.invalidateSize(), 0);
  }

  // ---- histogram
  const MEASURES = [
    { k: 'vpa', l: 'Final descent angle (°)', bin: 0.1, dec: 2, unit: '°', t: 'APP' },
    { k: 'fd', l: 'FAF → MAP (nm)', bin: 0.5, dec: 1, unit: ' nm', t: 'APP' },
    { k: 'faf', l: 'FAF altitude (ft)', bin: 500, dec: 0, unit: ' ft', t: 'APP', alt: true },
    { k: 'mtop', l: 'Missed approach climb-to (ft)', bin: 500, dec: 0, unit: ' ft', t: 'APP', alt: true },
    { k: 'grad', l: 'SID implied climb (ft/nm)', bin: 25, dec: 0, unit: ' ft/nm', t: 'SID' },
    { k: 'dg', l: 'STAR required descent (ft/nm)', bin: 25, dec: 0, unit: ' ft/nm', t: 'STAR' },
    { k: 'top', l: 'Highest constraint (ft)', bin: 2000, dec: 0, unit: ' ft', alt: true },
    { k: 'len', l: 'Coded length (nm)', bin: 10, dec: 0, unit: ' nm' },
    { k: 'nt', l: 'Transitions', bin: 1, dec: 0, unit: '' },
    { k: 'nl', l: 'Coded legs', bin: 2, dec: 0, unit: '' },
    { k: 'nfix', l: 'Named fixes', bin: 1, dec: 0, unit: '' },
  ];
  function quant(sorted, p) { return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]; }
  function renderHist() {
    const mk = $('nh-measure').value || 'vpa';
    const M = MEASURES.find(m => m.k === mk);
    const vals = S.hits.map(r => col(r, mk)).filter(v => v != null && isFinite(v)).sort((a, b) => a - b);
    const c = $('hist');
    const draw = () => {
      const { ctx, W, H } = setup(c, 200);
      if (!vals.length) {
        ctx.fillStyle = '#555'; ctx.textAlign = 'center'; ctx.fillText('no values for this filter', W / 2, H / 2);
        $('hist-stat').innerHTML = ''; $('nh-sub').textContent = ''; hover(c, [], () => ''); return;
      }
      const p99 = quant(vals, 0.99), lo = Math.floor(vals[0] / M.bin) * M.bin;
      const hi = Math.max(lo + M.bin, Math.ceil(p99 / M.bin) * M.bin);
      const nb = Math.min(200, Math.round((hi - lo) / M.bin) + 1);   // last bin holds ≥ p99
      const bins = new Array(nb).fill(0);
      for (const v of vals) bins[Math.min(nb - 1, Math.floor((v - lo) / M.bin + 1e-9))]++;
      const mx = Math.max(...bins);
      const L = 44, R0 = 10, T = 12, B = 26, pw = W - L - R0, ph = H - T - B, bw = pw / nb;
      ctx.strokeStyle = '#242424'; ctx.lineWidth = 1;
      ctx.fillStyle = '#666'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      for (let i = 0; i <= 4; i++) {
        const y = T + ph - ph * i / 4;
        ctx.beginPath(); ctx.moveTo(L, y + 0.5); ctx.lineTo(W - R0, y + 0.5); ctx.stroke();
        ctx.fillText(fmtN(Math.round(mx * i / 4)), L - 6, y);
      }
      const hits = [];
      const fmtV = v => M.alt ? fmtAlt(v) : v.toFixed(M.dec) + M.unit;
      for (let i = 0; i < nb; i++) {
        if (!bins[i]) continue;
        const h = ph * bins[i] / mx, x = L + i * bw, y = T + ph - h;
        ctx.fillStyle = BLUE;
        ctx.beginPath(); ctx.roundRect(x + 0.5, y, Math.max(1, bw - 1), h, [2, 2, 0, 0]); ctx.fill();
        const b0 = lo + i * M.bin, b1 = b0 + M.bin;
        hits.push({ x, y: T, w: bw, h: ph, i, label: i === nb - 1 ? `≥ ${fmtV(b0)}` : (M.bin === 1 ? fmtV(b0) : `${fmtV(b0)} – ${fmtV(b1)}`), n: bins[i] });
      }
      ctx.fillStyle = '#777'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      const step = Math.max(1, Math.ceil(nb / Math.max(3, Math.floor(pw / 70))));
      for (let i = 0; i < nb; i += step) ctx.fillText(fmtV(lo + i * M.bin), L + i * bw, T + ph + 6);
      const med = quant(vals, 0.5), xm = L + Math.min(nb - 0.5, (med - lo) / M.bin + 0.5) * bw;
      ctx.strokeStyle = '#e8e8e8'; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(xm, T); ctx.lineTo(xm, T + ph); ctx.stroke(); ctx.setLineDash([]);
      hover(c, hits, h => `<b>${esc(h.label)}</b><br>${fmtN(h.n)} procedures`);
      $('hist-stat').innerHTML = `<span>n <b>${fmtN(vals.length)}</b></span><span>median <b>${fmtV(med)}</b></span>` +
        `<span>p10 <b>${fmtV(quant(vals, 0.1))}</b></span><span>p90 <b>${fmtV(quant(vals, 0.9))}</b></span>` +
        `<span>min <b>${fmtV(vals[0])}</b></span><span>max <b>${fmtV(vals[vals.length - 1])}</b></span>`;
      $('nh-sub').textContent = (M.t && S.filt.type !== M.t ? `${M.t === 'APP' ? 'approaches' : M.t + 's'} only · ` : '') +
        `${M.bin}${M.unit.trim() ? ' ' + M.unit.trim() : ''} bins · dashed = median`;
    };
    S.draws[1] = draw; draw();
  }

  // ---- table
  const COLS = [
    { k: 'apt', l: 'Airport', w: r => `<span class="apt">${esc(col(r, 'apt'))}</span><span class="st">${esc(stLabel(stOf(r)))}</span> <span style="color:#777">${esc(nameOf(col(r, 'apt')))}</span>`, s: r => col(r, 'apt') },
    { k: 'name', l: 'Procedure', w: r => esc(col(r, 'name')) + (col(r, 'co') ? '<span class="co">plate only</span>' : ''), s: r => col(r, 'name') },
    { k: 'kind', l: 'Kind', w: r => esc(col(r, 'kind')), s: r => col(r, 'kind') },
    { k: 'nt', l: 'Trans', num: true, w: r => fmtN(col(r, 'nt')) },
    { k: 'len', l: 'Length', num: true, w: r => col(r, 'len') == null ? '—' : col(r, 'len').toFixed(0) + ' nm', t: 'coded length: longest transition + the shared route' },
    { k: 'vpa', l: 'VPA', num: true, w: r => col(r, 'vpa') == null ? '—' : col(r, 'vpa').toFixed(2) + '°', t: 'coded final descent angle' },
    { k: 'fd', l: 'FAF→MAP', num: true, w: r => col(r, 'fd') == null ? '—' : col(r, 'fd').toFixed(1) + ' nm' },
    { k: 'faf', l: 'FAF', num: true, w: r => fmtAlt(col(r, 'faf')), t: 'FAF altitude' },
    { k: 'mtop', l: 'Missed to', num: true, w: r => fmtAlt(col(r, 'mtop')), t: 'missed approach climb-to altitude' },
    { k: 'grad', l: 'Climb', num: true, w: r => col(r, 'grad') == null ? '—' : fmtN(col(r, 'grad')) + ' ft/nm', t: 'SID: (first at-or-above constraint − field) over the straight line from the departure end — the shortest path, so the gradient is a ceiling' },
    { k: 'dg', l: 'Descent', num: true, w: r => col(r, 'dg') == null ? '—' : fmtN(col(r, 'dg')) + ' ft/nm', t: 'STAR: steepest descent the constraints require' },
    { k: 'top', l: 'Top', num: true, w: r => fmtAlt(col(r, 'top')), t: 'highest altitude constraint' },
    { k: 'pts', l: 'Legs', w: r => `<span style="color:#777">${esc(col(r, 'pts') || '')}</span>`, s: r => col(r, 'pts') || '' },
  ];
  function sortHits() {
    const C = COLS.find(c => c.k === S.sort.col) || COLS[0], d = S.sort.dir;
    const key = C.s || (r => col(r, C.k));
    S.hits.sort((a, b) => {
      const x = key(a), y = key(b);
      if (x == null && y == null) return 0;
      if (x == null) return 1;               // blanks last either way
      if (y == null) return -1;
      return (typeof x === 'number' ? x - y : String(x).localeCompare(String(y))) * d
        || col(a, 'apt').localeCompare(col(b, 'apt'));
    });
  }
  function renderTable() {
    sortHits();
    const t = $('nat-table');
    const type = S.filt.type;
    const cols = COLS.filter(c => !(type === 'SID' && ['vpa', 'fd', 'faf', 'mtop', 'dg'].includes(c.k))
      && !(type === 'STAR' && ['vpa', 'fd', 'faf', 'mtop', 'grad'].includes(c.k))
      && !(type === 'APP' && ['grad', 'dg'].includes(c.k)));
    let h = '<tr>' + cols.map(c => `<th class="${c.num ? 'num' : ''}${S.sort.col === c.k ? ' on' : ''}" data-k="${c.k}" title="${esc(c.t || '')}">` +
      `${esc(c.l)}${S.sort.col === c.k ? (S.sort.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('') + '</tr>';
    const n = Math.min(S.shown, S.hits.length);
    for (let i = 0; i < n; i++) {
      const r = S.hits[i];
      h += `<tr class="clk" data-i="${i}">` + cols.map(c => `<td class="${c.num ? 'num' : ''}">${c.w(r)}</td>`).join('') + '</tr>';
    }
    t.innerHTML = h;
    if (!S.hits.length) t.innerHTML += '<tr><td colspan="99" class="empty">nothing matches</td></tr>';
    $('nat-more').hidden = n >= S.hits.length;
    $('nat-more').textContent = `Show more (${fmtN(n)} of ${fmtN(S.hits.length)})`;
    $('tbl-sub').textContent = `${fmtN(n)} of ${fmtN(S.hits.length)} · click a column to sort · click a row to draw it`;
    t.onclick = e => {
      const th = e.target.closest('th');
      if (th) {
        if (S.sort.col === th.dataset.k) S.sort.dir = -S.sort.dir;
        else { S.sort.col = th.dataset.k; S.sort.dir = COLS.find(c => c.k === th.dataset.k).num ? -1 : 1; }
        renderTable(); syncControls(); writeHash(); return;
      }
      const tr = e.target.closest('tr.clk'); if (!tr) return;
      const r = S.hits[+tr.dataset.i];
      openInExplorer(col(r, 'apt'), col(r, 'co') ? null : col(r, 'id'));
    };
  }
  function openInExplorer(apt, procId) {
    setView('explorer');
    if (window.ProcExplorer) window.ProcExplorer.open(apt, procId);
    window.scrollTo({ top: $('modes').offsetTop - 8, behavior: 'smooth' });
  }

  function renderFixes() {
    const t = $('nat-fixes');
    t.innerHTML = '<tr><th>Fix</th><th class="num">Procedures</th><th class="num">Airports</th><th>Position</th></tr>' +
      (S.m.fixes || []).slice(0, 150).map(f =>
        `<tr class="clk" data-q="${esc(f[0])}"><td><span class="apt">${esc(f[0])}</span></td><td class="num">${fmtN(f[3])}</td>` +
        `<td class="num">${fmtN(f[4])}</td><td style="color:#777">${f[1].toFixed(3)}, ${f[2].toFixed(3)}</td></tr>`).join('');
  }

  // ---------------------------------------------------------------- changes
  function chgRow(x, notes) {
    const [apt, id, name, type, kind] = x;
    const st = (S.apts[apt] || [])[1] || '';
    return `<tr class="${notes === null ? '' : 'clk'}" data-apt="${esc(apt)}" data-id="${esc(id)}">` +
      `<td><span class="apt">${esc(apt)}</span><span class="st">${esc(st)}</span> <span style="color:#777">${esc(nameOf(apt))}</span></td>` +
      `<td>${esc(name)}</td><td style="color:#888">${esc(type === 'APP' ? 'approach' : type)}${kind ? ' · ' + esc(kind) : ''}</td>` +
      (notes ? `<td class="chg-notes">${notes.map(n => `<span>${esc(n).replace(/→/g, '<span class="arr">→</span>')}</span>`).join('')}</td>` : '') + '</tr>';
  }
  function renderChanges() {
    const c = S.changes;
    if (!c) {
      $('chg-tiles').innerHTML = '<div class="tile"><div class="v">—</div><div class="l">no previous cycle on file</div></div>';
      return;
    }
    const ct = k => Object.values(c.counts[k] || {}).reduce((a, b) => a + b, 0);
    $('chg-tiles').innerHTML = [
      [esc(c.from.cycle) + ' → ' + esc(c.to.cycle), 'AIRAC cycles · eff. ' + esc(c.from.effective) + ' → ' + esc(c.to.effective)],
      [fmtN(ct('added')), 'added'], [fmtN(ct('removed')), 'withdrawn'], [fmtN(ct('changed')), 'changed or revised'],
      [fmtN(c.apts_added.length), 'airports gaining their first procedure'],
    ].map(([v, l]) => `<div class="tile"><div class="v">${v}</div><div class="l">${l}</div></div>`).join('');
    const apply = () => {
      const type = $('cf-type').value, st = $('cf-st').value, q = $('cf-q').value.trim().toUpperCase();
      const ok = x => (!type || x[3] === type) && (!st || ((S.apts[x[0]] || [])[1] || '') === st) &&
        (!q || x[0].includes(q) || x[1].includes(q) || (x[2] || '').toUpperCase().includes(q) || nameOf(x[0]).toUpperCase().includes(q)
          || (x[5] || []).some(n => n.toUpperCase().includes(q)));
      const ch = c.changed.filter(ok), ad = c.added.filter(ok), rm = c.removed.filter(ok);
      const head = '<tr><th>Airport</th><th>Procedure</th><th>Type</th>';
      $('chg-changed').innerHTML = head + '<th>What changed</th></tr>' + ch.map(x => chgRow(x, x[5])).join('') + (ch.length ? '' : '<tr><td colspan="4" class="empty">none</td></tr>');
      $('chg-added').innerHTML = head + '</tr>' + ad.map(x => chgRow(x, undefined)).join('') + (ad.length ? '' : '<tr><td colspan="3" class="empty">none</td></tr>');
      $('chg-removed').innerHTML = head + '</tr>' + rm.map(x => chgRow(x, null)).join('') + (rm.length ? '' : '<tr><td colspan="3" class="empty">none</td></tr>');
      $('chg-n-changed').textContent = fmtN(ch.length);
      $('chg-n-added').textContent = fmtN(ad.length);
      $('chg-n-removed').textContent = fmtN(rm.length);
    };
    if (!S.apts || !Object.keys(S.apts).length) loadMetrics().then(apply); else apply();
    $('cf-type').onchange = apply; $('cf-st').onchange = apply; $('cf-q').oninput = apply;
    for (const id of ['chg-changed', 'chg-added'])
      $(id).onclick = e => { const tr = e.target.closest('tr.clk'); if (tr) openInExplorer(tr.dataset.apt, tr.dataset.id); };
  }

  // ---------------------------------------------------------------- boot
  document.querySelectorAll('#modes button').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
  window.addEventListener('resize', () => { for (const d of S.draws) if (d) d(); });
  const h = readHash();
  const view = h.get('view');
  if (view === 'national' || view === 'changes') {
    const f = S.filt;
    f.type = h.get('t') || ''; f.kind = h.get('k') || ''; f.st = h.get('st') || ''; f.q = h.get('q') || '';
    for (const x of (h.get('f') || '').split(',')) if (x) f[x] = true;
    for (const k of ['vpa', 'grad', 'dg']) if (h.get(k)) f[k] = +h.get(k);
    const so = h.get('sort');
    if (so) { const [c, d] = so.split(':'); S.sort = { col: c, dir: d === 'd' ? -1 : 1 }; }
    setView(view, false);
  }
  window.PROC_NAT_DEBUG = S;
})();
