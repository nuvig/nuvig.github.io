// Procedure Explorer — overlay CIFP SIDs / STARs / approaches on a Leaflet map
// with a custom 3D altitude view. Data: data/procedures/ built by
// scripts/build_procedures.py (leg array layout documented there).
//
// Leg array indices (must match the builder):
const L_FIX = 0, L_LAT = 1, L_LON = 2, L_PT = 3, L_TURN = 4, L_ADESC = 5,
      L_A1 = 6, L_A2 = 7, L_SPD = 8, L_CRS = 9, L_DIST = 10, L_VA = 11,
      L_FLAGS = 12, L_REC = 13, L_THETA = 14, L_RHO = 15, L_CTR = 16;

(() => {
  'use strict';

  // ---------------------------------------------------------------- geo math
  const NM_LAT = 60;                       // nm per degree latitude
  const D2R = Math.PI / 180;

  function distNm(a, b) {                  // [lat,lon] equirectangular, fine <300nm
    const dy = (b[0] - a[0]) * NM_LAT;
    const dx = (b[1] - a[1]) * NM_LAT * Math.cos((a[0] + b[0]) / 2 * D2R);
    return Math.hypot(dx, dy);
  }
  function brgTo(a, b) {
    const dy = (b[0] - a[0]);
    const dx = (b[1] - a[1]) * Math.cos((a[0] + b[0]) / 2 * D2R);
    return (Math.atan2(dx, dy) / D2R + 360) % 360;
  }
  function dest(p, brgDeg, nm) {           // point nm away on true bearing
    const dLat = nm * Math.cos(brgDeg * D2R) / NM_LAT;
    const dLon = nm * Math.sin(brgDeg * D2R) / (NM_LAT * Math.cos(p[0] * D2R));
    return [p[0] + dLat, p[1] + dLon];
  }
  // sample an arc around `ctr` from bearing b1 to b2 (deg true), given turn dir
  function arcPts(ctr, radiusNm, b1, b2, turn) {
    let sweep = (b2 - b1 + 360) % 360;               // CW (R) sweep
    if (turn === 'L') sweep = sweep - 360;           // negative = CCW
    if (turn !== 'L' && turn !== 'R')                // unknown: take short way
      sweep = sweep > 180 ? sweep - 360 : sweep;
    const n = Math.max(2, Math.ceil(Math.abs(sweep) / 6));
    const pts = [];
    for (let i = 1; i <= n; i++) pts.push(dest(ctr, b1 + sweep * i / n, radiusNm));
    return pts;
  }
  // racetrack hold at fix: inbound true course crs, leg length nm, turn dir
  function holdPts(fix, crs, legNm, turn) {
    const t = turn === 'L' ? -1 : 1;
    const r = Math.max(0.45, Math.min(2.2, legNm * 0.22));
    const A = fix, B = dest(fix, (crs + 180) % 360, legNm);   // inbound leg B->A
    const side = (crs + t * 90 + 360) % 360;                  // turn side
    const cA = dest(A, side, r), cB = dest(B, side, r);       // half-turn centres
    const dir = t === -1 ? 'L' : 'R';
    const pts = [B, A];
    pts.push(...arcPts(cA, r, (crs - t * 90 + 360) % 360, side, dir));
    pts.push(dest(B, side, 2 * r));                           // outbound abeam B
    pts.push(...arcPts(cB, r, side, (crs - t * 90 + 360) % 360, dir));
    pts.push(B);
    return pts;
  }

  // ---------------------------------------------------------------- state
  const $ = id => document.getElementById(id);
  const state = {
    index: null,                 // {effective, apts:[[id,name,lat,lon,nS,nT,nA],..]}
    docs: new Map(),             // icao -> airport doc
    curApt: null,                // icao being browsed in the sidebar
    sel: new Map(),              // "APT|PROC" -> Set(transIdx)
    colors: new Map(),           // "APT|PROC" -> color
    geomCache: new Map(),        // "APT|PROC|idx" -> geometry
    labels: true, missed: true, flow: false,
  };
  const PALETTE = ['#4a9eff', '#f0b45a', '#52d273', '#e06ad4', '#ff7057', '#4fd8cf',
                   '#b89cff', '#ffd75a', '#7d9fff', '#ff8ac0', '#9fd45a', '#ff9d3c'];
  let colorIdx = 0;

  // ---------------------------------------------------------------- map
  let map, overlay, arrowLayer, flowLayer, flowTimer = null;

  function initMap() {
    map = L.map('proc-map', { zoomControl: true }).setView([38.94, -76.57], 9);
    const esc = { maxNativeZoom: 11, maxZoom: 16 };
    const base = {
      'Dark': L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
        { attribution: '© OpenStreetMap © CARTO', maxZoom: 16 }),
      'Streets': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',
        { attribution: '© OpenStreetMap', maxZoom: 16 }),
      'Satellite': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        { attribution: 'Esri', maxZoom: 16 }),
      'VFR Sectional': L.tileLayer('https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/VFR_Sectional/MapServer/tile/{z}/{y}/{x}',
        { attribution: 'FAA', ...esc }),
      'VFR Sectional (dark)': L.tileLayer('https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/VFR_Sectional/MapServer/tile/{z}/{y}/{x}',
        { attribution: 'FAA', className: 'inverted-tiles', ...esc }),
    };
    const over = {
      'VFR Terminal (TAC)': L.tileLayer('https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/VFR_Terminal/MapServer/tile/{z}/{y}/{x}',
        { attribution: 'FAA', opacity: 0.85, ...esc }),
      'IFR Enroute Low': L.tileLayer('https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/IFR_AreaLow/MapServer/tile/{z}/{y}/{x}',
        { attribution: 'FAA', opacity: 0.85, maxNativeZoom: 10, maxZoom: 16 }),
      'IFR Enroute High': L.tileLayer('https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/IFR_High/MapServer/tile/{z}/{y}/{x}',
        { attribution: 'FAA', opacity: 0.85, maxNativeZoom: 10, maxZoom: 16 }),
    };
    base['Satellite'].addTo(map);
    L.control.layers(base, over, { collapsed: true }).addTo(map);
    overlay = L.layerGroup().addTo(map);
    arrowLayer = L.layerGroup().addTo(map);
    flowLayer = L.layerGroup().addTo(map);
    map.on('zoomend', drawArrows);
  }

  // ---------------------------------------------------------------- geometry
  // Build drawable geometry for one transition.
  // Returns { segments:[{pts:[[lat,lon,alt]], style, kind}], fixes:[{...}] }
  function buildTrans(doc, proc, trans) {
    const mv = doc.mv || 0;                          // west negative; true = mag + mv
    const toTrue = m => m == null ? null : (m + mv + 360) % 360;
    const segs = [];
    const fixes = [];
    let cur = null;                                  // current [lat,lon]
    let seg = null;                                  // open segment
    const isSid = proc.type === 'SID';

    // runway start point for SID runway transitions / reference elevation
    const rwStart = (tid => {
      if (!tid || !tid.startsWith('RW')) return null;
      const num = tid.slice(2).replace('B', '');
      const rw = (doc.rw || []).find(r => r[0].replace('RW', '').startsWith(num));
      return rw ? [rw[1], rw[2]] : null;
    })(trans.t);

    const open = (style, kind) => { seg = { pts: [], style, kind, missed: false }; segs.push(seg); };
    const push = (p, missed) => {
      if (!seg) open('solid', trans.k);
      seg.pts.push([p[0], p[1], null]);
      if (missed) seg.missed = true;
    };
    const newSegIfStyle = (style, missed) => {
      if (!seg || seg.style !== style || (!!seg.missed) !== (!!missed)) {
        const from = cur;
        open(style, trans.k);
        seg.missed = !!missed;
        if (from) seg.pts.push([from[0], from[1], null]);
      }
    };

    let lastAlt = isSid ? (doc.elev || 0) : null;

    for (const leg of trans.legs) {
      const pt = leg[L_PT];
      const fixPos = leg[L_LAT] != null ? [leg[L_LAT], leg[L_LON]] : null;
      const missed = !!(leg[L_FLAGS] & 1);
      const crsT = toTrue(leg[L_CRS]);
      const target = constraintAlt(leg);
      if (target != null) lastAlt = target;

      const noteFix = (pos) => {
        if (!leg[L_FIX] || !pos) return;
        fixes.push({
          name: leg[L_FIX], lat: pos[0], lon: pos[1],
          cons: consText(leg), spd: leg[L_SPD], alt: null, missed,
          flyover: !!(leg[L_FLAGS] & 2),
          hold: /^H[AFM]$/.test(pt || '') ? { crs: crsT, len: legLenNm(leg), turn: leg[L_TURN] } : null,
        });
      };

      // start point for the very first leg of a SID runway transition
      if (!cur && !fixPos && rwStart) { cur = rwStart; newSegIfStyle('stub', missed); push(cur, missed); }

      switch (pt) {
        case 'IF':
          if (fixPos) { cur = fixPos; seg = null; noteFix(fixPos); }
          break;
        case 'TF': case 'CF': case 'DF':
          if (fixPos) {
            newSegIfStyle('solid', missed);
            if (!seg.pts.length && cur) push(cur, missed);
            push(fixPos, missed); noteFix(fixPos); cur = fixPos;
          }
          break;
        case 'RF':
          if (fixPos && leg[L_CTR] && cur) {
            const ctr = leg[L_CTR];
            newSegIfStyle('solid', missed);
            if (!seg.pts.length) push(cur, missed);
            const r = distNm(ctr, fixPos);
            arcPts(ctr, r, brgTo(ctr, cur), brgTo(ctr, fixPos), leg[L_TURN])
              .forEach(p => push(p, missed));
            push(fixPos, missed); noteFix(fixPos); cur = fixPos;
          } else if (fixPos) { push(fixPos, missed); noteFix(fixPos); cur = fixPos; }
          break;
        case 'AF':
          if (fixPos && leg[L_REC] && cur) {
            const ctr = [leg[L_REC][1], leg[L_REC][2]];
            const r = leg[L_RHO] || distNm(ctr, fixPos);
            newSegIfStyle('solid', missed);
            if (!seg.pts.length) push(cur, missed);
            arcPts(ctr, r, brgTo(ctr, cur), brgTo(ctr, fixPos), leg[L_TURN])
              .forEach(p => push(p, missed));
            push(fixPos, missed); noteFix(fixPos); cur = fixPos;
          } else if (fixPos) { push(fixPos, missed); noteFix(fixPos); cur = fixPos; }
          break;
        case 'HA': case 'HF': case 'HM':
          if (fixPos) {
            noteFix(fixPos);
            if (cur && distNm(cur, fixPos) > 0.05) {
              newSegIfStyle('solid', missed);
              if (!seg.pts.length) push(cur, missed);
              push(fixPos, missed);
            }
            cur = fixPos; seg = null;
          }
          break;
        case 'FA': case 'FM':                        // from a fix outbound
          if (fixPos) {
            noteFix(fixPos);
            const len = pt === 'FA' ? climbLen(leg, lastAlt, doc) : 3;
            if (crsT != null) {
              cur = fixPos; newSegIfStyle('stub', missed); push(cur, missed);
              cur = dest(fixPos, crsT, len); push(cur, missed); seg = null;
            } else cur = fixPos;
          }
          break;
        case 'CA': case 'VA': case 'CD': case 'VD': case 'FD':
        case 'CI': case 'VI': case 'VM': case 'CR': case 'VR': case 'PI': {
          if (!cur) break;
          let len = 3;
          if (pt === 'CA' || pt === 'VA') len = climbLen(leg, lastAlt, doc);
          else if (leg[L_DIST]) len = leg[L_DIST];
          else if (leg[L_RHO]) len = Math.max(1, leg[L_RHO] * 0.6);
          if (crsT != null) {
            newSegIfStyle('stub', missed);
            if (!seg.pts.length) push(cur, missed);
            cur = dest(cur, crsT, Math.max(0.8, Math.min(20, len)));
            push(cur, missed); seg = null;
          }
          if (fixPos) { noteFix(fixPos); }
          break;
        }
        default:                                     // unknown: connect to fix if given
          if (fixPos) {
            newSegIfStyle('solid', missed);
            if (!seg.pts.length && cur) push(cur, missed);
            push(fixPos, missed); noteFix(fixPos); cur = fixPos;
          }
      }
      // remember target altitude on the vertex just added
      if (seg && seg.pts.length && target != null) seg.pts[seg.pts.length - 1][2] = target;
      if (target != null) {
        const fx = fixes[fixes.length - 1];
        if (fx && leg[L_FIX] === fx.name) fx.alt = target;
      }
    }

    assignAltitudes(segs, doc, proc);

    // fixes without their own constraint sit on the interpolated ribbon,
    // not on the ground: take the altitude of the nearest path vertex
    for (const fx of fixes) {
      if (fx.alt != null) continue;
      let best = Infinity, alt = null;
      for (const s of segs) for (const p of s.pts) {
        const d = (p[0] - fx.lat) ** 2 + (p[1] - fx.lon) ** 2;
        if (d < best) { best = d; alt = p[2]; }
      }
      if (alt != null && best < 1e-4) fx.alt = Math.round(alt);
    }

    // hold racetracks (drawn after altitudes so we know the hold height)
    for (const fx of fixes) {
      if (!fx.hold || fx.hold.crs == null) continue;
      const pts = holdPts([fx.lat, fx.lon], fx.hold.crs, fx.hold.len || 4, fx.hold.turn)
        .map(p => [p[0], p[1], fx.alt]);
      segs.push({ pts, style: 'hold', kind: trans.k, missed: fx.missed });
    }
    return { segments: segs.filter(s => s.pts.length > 1), fixes };
  }

  function constraintAlt(leg) {
    const d = leg[L_ADESC], a1 = leg[L_A1], a2 = leg[L_A2];
    if (a1 == null && a2 == null) return null;
    if (d === 'B' && a1 != null && a2 != null) return Math.round((a1 + a2) / 2);
    return a1 != null ? a1 : a2;
  }
  function consText(leg) {
    const d = leg[L_ADESC], a1 = leg[L_A1], a2 = leg[L_A2];
    const fmt = v => v >= 18000 ? 'FL' + Math.round(v / 100) : v.toLocaleString();
    if (a1 == null && a2 == null) return null;
    if (d === '+') return '≥' + fmt(a1);
    if (d === '-') return '≤' + fmt(a1);
    if (d === 'B') return fmt(Math.min(a1, a2)) + '–' + fmt(Math.max(a1, a2));
    return '@' + fmt(a1 != null ? a1 : a2);
  }
  function legLenNm(leg) { return leg[L_DIST] || 4; }
  function climbLen(leg, fromAlt, doc) {
    const tgt = constraintAlt(leg);
    if (tgt == null || fromAlt == null) return 3;
    return Math.max(1, Math.min(20, (tgt - fromAlt) / 400));   // ~400 ft/nm climb
  }

  // Fill vertex altitudes: linear interpolation along track distance between
  // constrained vertices; flat extrapolation at the ends (SIDs start at field
  // elevation — the builder seeds the first vertex via lastAlt handling above).
  function assignAltitudes(segs, doc, proc) {
    const verts = [];
    for (const s of segs) for (const p of s.pts) verts.push(p);
    if (!verts.length) return;
    if (proc.type === 'SID' && verts[0][2] == null) verts[0][2] = doc.elev || 0;
    // cumulative distance
    const cum = [0];
    for (let i = 1; i < verts.length; i++)
      cum.push(cum[i - 1] + distNm(verts[i - 1], verts[i]));
    const known = [];
    verts.forEach((v, i) => { if (v[2] != null) known.push(i); });
    if (!known.length) {
      // no coded altitudes anywhere (e.g. non-RNAV STARs with only "expect"
      // altitudes on the chart): sketch a plausible climb/descent profile
      const elev = doc.elev || 0, end = cum[cum.length - 1];
      verts.forEach((v, i) => {
        if (proc.type === 'SID')
          v[2] = Math.min(elev + 15000, elev + cum[i] * 350);
        else if (proc.type === 'STAR')
          v[2] = Math.min(elev + 19000, elev + 4000 + (end - cum[i]) * 300);
        else v[2] = elev;
      });
      return;
    }
    for (let i = 0; i < verts.length; i++) {
      if (verts[i][2] != null) continue;
      let a = null, b = null;
      for (const k of known) { if (k < i) a = k; else { b = k; break; } }
      if (a == null) {
        // unconstrained lead-in: STARs descend into their first constraint,
        // so extrapolate a ~300 ft/nm descent backwards; others stay flat
        const k0 = known[0], base = verts[k0][2];
        verts[i][2] = proc.type === 'STAR'
          ? Math.min(base + 15000, base + (cum[k0] - cum[i]) * 300) : base;
      } else if (b == null) {
        // unconstrained tail: SIDs keep climbing (~350 ft/nm); others flat
        const base = verts[a][2];
        verts[i][2] = proc.type === 'SID'
          ? Math.min(base + 15000, base + (cum[i] - cum[a]) * 350) : base;
      } else {
        const t = (cum[i] - cum[a]) / Math.max(1e-6, cum[b] - cum[a]);
        verts[i][2] = verts[a][2] + t * (verts[b][2] - verts[a][2]);
      }
    }
  }

  // ---------------------------------------------------------------- selection
  const selKey = (apt, proc) => apt + '|' + proc;
  function procColor(key) {
    if (!state.colors.has(key))
      state.colors.set(key, PALETTE[colorIdx++ % PALETTE.length]);
    return state.colors.get(key);
  }
  function setTrans(apt, procId, idx, on) {
    const key = selKey(apt, procId);
    let set = state.sel.get(key);
    if (on) {
      if (!set) { set = new Set(); state.sel.set(key, set); }
      set.add(idx);
    } else if (set) {
      set.delete(idx);
      if (!set.size) state.sel.delete(key);
    }
  }
  function getGeom(apt, procId, idx) {
    const k = apt + '|' + procId + '|' + idx;
    if (!state.geomCache.has(k)) {
      const doc = state.docs.get(apt);
      const proc = doc.procs.find(p => p.id === procId);
      state.geomCache.set(k, buildTrans(doc, proc, proc.trans[idx]));
    }
    return state.geomCache.get(k);
  }

  // ---------------------------------------------------------------- 2D render
  const KIND_W = { enroute: 2.5, common: 5, runway: 3.5, transition: 2.5, final: 4.5, other: 3 };

  function redraw() {
    overlay.clearLayers(); arrowLayer.clearLayers(); flowLayer.clearLayers();
    const airports = new Set(state.curApt ? [state.curApt] : []);
    for (const [key, set] of state.sel) {
      const [apt, procId] = key.split('|');
      airports.add(apt);
      const doc = state.docs.get(apt);
      if (!doc) continue;
      const proc = doc.procs.find(p => p.id === procId);
      const color = procColor(key);
      for (const idx of set) {
        const g = getGeom(apt, procId, idx);
        const tname = proc.trans[idx].t;
        for (const s of g.segments) {
          if (s.missed && !state.missed) continue;
          const dash = s.style === 'stub' ? '5 7' : s.style === 'hold' ? '4 5'
                     : s.missed ? '7 7' : null;
          const line = L.polyline(s.pts.map(p => [p[0], p[1]]), {
            color, weight: s.missed ? 2.5 : (KIND_W[s.kind] || 3),
            opacity: s.missed ? 0.6 : (s.style === 'stub' ? 0.65 : 0.9),
            dashArray: dash, lineCap: 'round',
          }).addTo(overlay);
          line.bindTooltip(`${apt} ${procId} · ${tname}${s.missed ? ' (missed)' : ''}`,
            { sticky: true, className: 'fix-label' });
        }
        if (state.labels) drawFixes(g.fixes, color);
      }
    }
    // airport + runways
    for (const apt of airports) {
      const doc = state.docs.get(apt);
      if (!doc) continue;
      for (const r of doc.rw || [])
        L.circleMarker([r[1], r[2]], { radius: 3, color: '#fff', weight: 1,
          fillColor: '#fff', fillOpacity: 0.9 }).addTo(overlay)
          .bindTooltip(`${apt} ${r[0]}`, { className: 'fix-label' });
      drawRunwayLines(doc);
    }
    drawArrows();
    if (state.flow) startFlow(); else stopFlow();
    render3d();
    updateChips();
    saveHash();
  }

  function drawRunwayLines(doc) {
    // pair opposite runway ends (RW04↔RW22 etc.) and connect them
    const rws = doc.rw || [];
    const seen = new Set();
    for (const r of rws) {
      const n = parseInt(r[0].slice(2), 10);
      const side = r[0].slice(-1).match(/[LRC]/) ? r[0].slice(-1) : '';
      const recNum = ((n + 18) % 36) || 36;
      const recSide = side === 'L' ? 'R' : side === 'R' ? 'L' : side;
      const rec = rws.find(x => x[0] === 'RW' + String(recNum).padStart(2, '0') + recSide);
      const k = [r[0], rec && rec[0]].sort().join();
      if (rec && !seen.has(k)) {
        seen.add(k);
        L.polyline([[r[1], r[2]], [rec[1], rec[2]]],
          { color: '#e8e8e8', weight: 4, opacity: 0.9 }).addTo(overlay);
      }
    }
  }

  function drawFixes(fixes, color) {
    const seen = new Set();
    for (const fx of fixes) {
      if (fx.missed && !state.missed) continue;
      const k = fx.name + '|' + fx.lat.toFixed(3);
      if (seen.has(k)) continue;
      seen.add(k);
      L.circleMarker([fx.lat, fx.lon], {
        radius: fx.flyover ? 5 : 4, color, weight: 2,
        fillColor: '#0b0d12', fillOpacity: 0.9,
      }).addTo(overlay);
      const bits = [`<b>${fx.name}</b>`];
      if (fx.cons) bits.push(`<span class="alts">${fx.cons}</span>`);
      if (fx.spd) bits.push(`<span class="spd">${fx.spd}K</span>`);
      L.marker([fx.lat, fx.lon], {
        icon: L.divIcon({ className: 'fix-label', html: bits.join(' '), iconAnchor: [-7, 8] }),
        interactive: false, keyboard: false,
      }).addTo(overlay);
    }
  }

  // direction arrows along each drawn solid segment
  function drawArrows() {
    arrowLayer.clearLayers();
    overlay.eachLayer(l => {
      if (!(l instanceof L.Polyline) || l instanceof L.CircleMarker) return;
      const pts = l.getLatLngs();
      if (!Array.isArray(pts) || pts.length < 2) return;
      const color = l.options.color;
      if (!color || color === '#e8e8e8') return;
      let total = 0;
      for (let i = 1; i < pts.length; i++)
        total += distNm([pts[i - 1].lat, pts[i - 1].lng], [pts[i].lat, pts[i].lng]);
      const n = Math.max(1, Math.min(5, Math.round(total / 18)));
      for (let a = 1; a <= n; a++) {
        const targetD = total * a / (n + 1);
        let d = 0;
        for (let i = 1; i < pts.length; i++) {
          const p0 = [pts[i - 1].lat, pts[i - 1].lng], p1 = [pts[i].lat, pts[i].lng];
          const seg = distNm(p0, p1);
          if (d + seg >= targetD && seg > 0) {
            const t = (targetD - d) / seg;
            const pos = [p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t];
            const brg = brgTo(p0, p1);
            L.marker(pos, {
              icon: L.divIcon({
                className: 'arrow-ic',
                html: `<div style="transform:rotate(${brg}deg);color:${color};
                  font-size:14px;text-shadow:0 0 3px #000;">▲</div>`,
                iconSize: [14, 14], iconAnchor: [7, 7],
              }), interactive: false, keyboard: false,
            }).addTo(arrowLayer);
            break;
          }
          d += seg;
        }
      }
    });
  }

  // flow animation: marching dashes on top of every colored line
  function startFlow() {
    stopFlow();
    const lines = [];
    overlay.eachLayer(l => {
      if (l instanceof L.Polyline && !(l instanceof L.CircleMarker)
          && l.options.color && l.options.color !== '#e8e8e8' && !l.options.dashArray) {
        const f = L.polyline(l.getLatLngs(), { color: '#fff', weight: 2, opacity: 0.9,
          dashArray: '2 14', interactive: false }).addTo(flowLayer);
        lines.push(f);
      }
    });
    let off = 0;
    flowTimer = setInterval(() => {
      off = (off - 1.2);
      for (const f of lines) {
        const el = f.getElement && f.getElement();
        if (el) el.style.strokeDashoffset = off;
      }
    }, 50);
  }
  function stopFlow() {
    if (flowTimer) { clearInterval(flowTimer); flowTimer = null; }
    flowLayer.clearLayers();
  }

  // ---------------------------------------------------------------- 3D view
  const v3 = {
    on: false, yaw: -0.6, pitch: 0.75, dist: 80, target: [0, 0, 0],
    exag: 15, colorByAlt: true, showMap: true, ref: null, dpr: 1,
  };

  // ---- dark basemap stitched onto the ground plane -------------------------
  const ground = { key: null, cv: null, z: 4, ox: 0, oy: 0, ready: false, cosRef: 1 };
  let raf3 = 0;
  function scheduleDraw() {
    if (raf3) return;
    raf3 = requestAnimationFrame(() => { raf3 = 0; if (v3.on) draw3d(); });
  }
  function mercPx(lat, lon, z) {
    const n = 256 * Math.pow(2, z);
    const s = Math.sin(Math.max(-85, Math.min(85, lat)) * D2R);
    return [(lon + 180) / 360 * n,
            (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n];
  }
  function ensureGround() {
    if (!scene || !v3.showMap) return;
    const ref = scene.ref, ext = scene.ext;
    const key = ref[0].toFixed(2) + ',' + ref[1].toFixed(2) + ',' + ext;
    if (ground.key === key) return;
    ground.key = key; ground.ready = false;
    const cosR = Math.max(0.2, Math.cos(ref[0] * D2R));
    ground.cosRef = cosR;
    const pad = 1.8;                                 // cover well past the paths
    const degLon = 2 * ext * pad / (60 * cosR);
    const latN = ref[0] + ext * pad / 60, latS = ref[0] - ext * pad / 60;
    const lonW = ref[1] - degLon / 2, lonE = ref[1] + degLon / 2;
    let z = Math.max(3, Math.min(11, Math.floor(Math.log2(6 * 360 / degLon))));
    let tx0, tx1, ty0, ty1;
    for (;;) {
      const a = mercPx(latN, lonW, z), b = mercPx(latS, lonE, z);
      tx0 = Math.floor(a[0] / 256); ty0 = Math.floor(a[1] / 256);
      tx1 = Math.floor(b[0] / 256); ty1 = Math.floor(b[1] / 256);
      if ((tx1 - tx0 + 1) * (ty1 - ty0 + 1) <= 49 || z <= 3) break;
      z--;
    }
    const cv = document.createElement('canvas');
    cv.width = (tx1 - tx0 + 1) * 256; cv.height = (ty1 - ty0 + 1) * 256;
    const ctx = cv.getContext('2d');
    ground.cv = cv; ground.z = z; ground.ox = tx0 * 256; ground.oy = ty0 * 256;
    for (let tx = tx0; tx <= tx1; tx++) for (let ty = ty0; ty <= ty1; ty++) {
      const im = new Image();
      im.crossOrigin = 'anonymous';
      im.onload = () => {
        if (ground.key !== key) return;              // superseded by a rebuild
        ctx.drawImage(im, (tx - tx0) * 256, (ty - ty0) * 256);
        ground.ready = true;
        scheduleDraw();
      };
      im.src = `https://${'abcd'[(tx + ty) % 4]}.basemaps.cartocdn.com/dark_all/${z}/${tx}/${ty}.png`;
    }
  }
  function groundPx(wx, wy) {
    const lat = scene.ref[0] + wy / 60;
    const lon = scene.ref[1] + wx / (60 * ground.cosRef);
    const p = mercPx(lat, lon, ground.z);
    return [p[0] - ground.ox, p[1] - ground.oy];
  }
  // The ground is a plane, so each screen scanline maps affinely onto the
  // basemap ("mode-7"): invert the projection at z=0 per row and blit strips.
  function drawGround(g, W, H, cam) {
    const { cp, sp, cy, sy, f, dist, tz } = cam;
    const rowG = ys => {
      const c = (H * 0.52 - ys) / f;
      const den = sp - c * cp;
      if (den < 1e-4) return null;                   // above the horizon
      const y1 = (tz * (cp + c * sp) + c * dist) / den;
      const depth = y1 * cp + tz * sp + dist;
      if (depth < 0.5) return null;
      const end = sx => {
        const x1 = (sx - W / 2) * depth / f;
        return [x1 * cy + y1 * sy + v3.target[0], -x1 * sy + y1 * cy + v3.target[1]];
      };
      return { a: end(0), b: end(W), depth };
    };
    const S = 3;
    const horizon = cp > 1e-4 ? H * 0.52 - f * sp / cp : -1e9;
    for (let ys = Math.max(0, Math.ceil(horizon) + 2); ys < H; ys += S) {
      const r0 = rowG(ys), r1 = rowG(ys + S);
      if (!r0 || !r1) continue;
      const alpha = Math.min(0.95, Math.max(0, 1.35 - r0.depth / (dist * 7)));
      if (alpha < 0.03) continue;
      const [x0, y0] = groundPx(r0.a[0], r0.a[1]);
      const [x1, y1] = groundPx(r0.b[0], r0.b[1]);
      const [x2, y2] = groundPx(r1.a[0], r1.a[1]);
      const den = x0 * (y1 - y2) + x1 * (y2 - y0) + x2 * (y0 - y1);
      if (Math.abs(den) < 1e-9) continue;
      // affine basemap->screen from 3 point pairs
      const A = (0 * (y1 - y2) + W * (y2 - y0) + 0 * (y0 - y1)) / den;
      const B = (ys * (y1 - y2) + ys * (y2 - y0) + (ys + S) * (y0 - y1)) / den;
      const C = (0 * (x2 - x1) + W * (x0 - x2) + 0 * (x1 - x0)) / den;
      const D = (ys * (x2 - x1) + ys * (x0 - x2) + (ys + S) * (x1 - x0)) / den;
      const E = 0 - A * x0 - C * y0;
      const F = ys - B * x0 - D * y0;
      g.save();
      g.beginPath(); g.rect(0, ys, W, S + 0.4); g.clip();
      g.globalAlpha = alpha;
      g.transform(A, B, C, D, E, F);
      g.drawImage(ground.cv, 0, 0);
      g.restore();
    }
    g.globalAlpha = 1;
  }

  function altColor(alt, lo, hi) {
    const t = Math.max(0, Math.min(1, (alt - lo) / Math.max(1, hi - lo)));
    return `hsl(${Math.round(20 + 300 * t)},85%,58%)`;
  }

  function gather3d() {
    const paths = [];      // {pts:[[x,y,zft]], color, style, missed, kind}
    const fixes3 = [];
    let ref = null;
    const all = [];
    for (const [key, set] of state.sel) {
      const [apt, procId] = key.split('|');
      if (!state.docs.get(apt)) continue;
      for (const idx of set) {
        const g = getGeom(apt, procId, idx);
        for (const s of g.segments) {
          if (s.missed && !state.missed) continue;
          all.push({ s, color: procColor(key) });
        }
        for (const fx of g.fixes) if (!(fx.missed && !state.missed)) fixes3.push(fx);
      }
    }
    if (!all.length) return null;
    let sy = 0, sx = 0, n = 0;
    for (const { s } of all) for (const p of s.pts) { sy += p[0]; sx += p[1]; n++; }
    ref = [sy / n, sx / n];
    const toXY = p => [(p[1] - ref[1]) * NM_LAT * Math.cos(ref[0] * D2R),
                       (p[0] - ref[0]) * NM_LAT];
    let lo = Infinity, hi = -Infinity;
    for (const { s, color } of all) {
      const pts = s.pts.map(p => { const [x, y] = toXY(p); return [x, y, p[2] || 0]; });
      for (const p of pts) { lo = Math.min(lo, p[2]); hi = Math.max(hi, p[2]); }
      paths.push({ pts, color, style: s.style, missed: s.missed, kind: s.kind });
    }
    const f3 = fixes3.map(fx => {
      const [x, y] = toXY([fx.lat, fx.lon]);
      return { x, y, alt: fx.alt, name: fx.name, cons: fx.cons };
    });
    // runways of involved airports
    const rws = [];
    for (const [key] of state.sel) {
      const doc = state.docs.get(key.split('|')[0]);
      if (doc) for (const r of doc.rw || []) {
        const [x, y] = toXY([r[1], r[2]]);
        rws.push([x, y, doc.elev || 0]);
      }
    }
    let ext = 20;
    for (const p of paths) for (const q of p.pts)
      ext = Math.max(ext, Math.abs(q[0]), Math.abs(q[1]));
    ext = Math.ceil(ext / 10) * 10;
    return { paths, fixes: f3, ref, lo, hi, rws, ext };
  }

  let scene = null;
  function render3d() {
    if (!v3.on) return;
    scene = gather3d();
    if (scene) ensureGround();
    draw3d();
  }

  function fit3d() {
    if (!scene) return;
    let r = 10;
    for (const p of scene.paths) for (const q of p.pts)
      r = Math.max(r, Math.hypot(q[0], q[1]));
    v3.dist = r * 2.6;
    v3.target = [0, 0, ftToNm(scene.hi) * v3.exag * 0.35];
    v3.yaw = -0.6; v3.pitch = 0.75;
  }

  const ftToNm = ft => ft / 6076.12;

  function draw3d() {
    const cv = $('c3d');
    const dpr = window.devicePixelRatio || 1;
    const W = cv.clientWidth, H = cv.clientHeight;
    if (cv.width !== W * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#0a0c10';
    g.fillRect(0, 0, W, H);
    if (!scene) {
      g.fillStyle = '#555'; g.font = '13px system-ui';
      g.textAlign = 'center';
      g.fillText('Select a procedure to see it in 3D', W / 2, H / 2);
      updateScaleLegend(null);
      return;
    }
    const { lo, hi } = scene;
    const cy = Math.cos(v3.yaw), sy = Math.sin(v3.yaw);
    const cp = Math.cos(v3.pitch), sp = Math.sin(v3.pitch);
    const f = H * 1.35;
    const zScale = v3.exag;

    // camera sits above the plane at z = target.z + dist*sin(pitch), looking down
    const proj = (x, y, zft) => {
      const z = ftToNm(zft) * zScale;
      let dx = x - v3.target[0], dy = y - v3.target[1], dz = z - v3.target[2];
      const x1 = dx * cy - dy * sy;
      const y1 = dx * sy + dy * cy;
      const depth = y1 * cp - dz * sp + v3.dist;
      const vert = y1 * sp + dz * cp;
      if (depth < 0.5) return null;
      const s = f / depth;
      return [W / 2 + x1 * s, H * 0.52 - vert * s, depth];
    };

    if (v3.showMap && ground.ready)
      drawGround(g, W, H, { cp, sp, cy, sy, f, dist: v3.dist, tz: v3.target[2] });

    // ground grid every 10 nm (fainter when the basemap is underneath)
    const ext = scene.ext;
    const mapOn = v3.showMap && ground.ready;
    g.strokeStyle = mapOn ? 'rgba(120,150,180,0.12)' : 'rgba(70,90,110,0.25)';
    g.lineWidth = 1;
    for (let a = -ext; a <= ext; a += 10) {
      strokePath(g, [[a, -ext, 0], [a, ext, 0]], proj);
      strokePath(g, [[-ext, a, 0], [ext, a, 0]], proj);
    }
    // north arrow
    g.strokeStyle = 'rgba(140,170,200,0.8)'; g.lineWidth = 1.5;
    strokePath(g, [[0, ext, 0], [0, ext + 6, 0]], proj);
    const np = proj(0, ext + 8, 0);
    if (np) { g.fillStyle = '#8aa'; g.font = '11px system-ui'; g.textAlign = 'center'; g.fillText('N', np[0], np[1]); }

    // runway points
    g.fillStyle = '#fff';
    for (const r of scene.rws) {
      const p = proj(r[0], r[1], r[2]);
      if (p) { g.beginPath(); g.arc(p[0], p[1], 2.5, 0, 7); g.fill(); }
    }

    // shadows first, then posts, then ribbons
    for (const path of scene.paths) {
      g.strokeStyle = 'rgba(0,0,0,0.55)'; g.lineWidth = 2;
      strokePath(g, path.pts.map(p => [p[0], p[1], 0]), proj);
    }
    g.strokeStyle = 'rgba(255,255,255,0.14)'; g.lineWidth = 1;
    for (const fx of scene.fixes) {
      if (fx.alt == null) continue;
      strokePath(g, [[fx.x, fx.y, 0], [fx.x, fx.y, fx.alt]], proj);
    }
    for (const path of scene.paths) {
      const wgt = path.missed ? 1.5 : (KIND_W[path.kind] || 3) * 0.75 + 1;
      const dash = path.style === 'stub' || path.missed ? [5, 6] : path.style === 'hold' ? [3, 4] : [];
      g.setLineDash(dash);
      if (v3.colorByAlt) {
        for (let i = 1; i < path.pts.length; i++) {
          const a = proj(...path.pts[i - 1]), b = proj(...path.pts[i]);
          if (!a || !b) continue;
          g.strokeStyle = altColor((path.pts[i - 1][2] + path.pts[i][2]) / 2, lo, hi);
          g.lineWidth = wgt;
          g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke();
        }
      } else {
        g.strokeStyle = path.color; g.lineWidth = wgt;
        g.globalAlpha = path.missed ? 0.6 : 1;
        strokePath(g, path.pts, proj);
        g.globalAlpha = 1;
      }
      g.setLineDash([]);
    }

    // fix labels
    g.font = '10.5px system-ui'; g.textAlign = 'left';
    const drawn = new Set();
    for (const fx of scene.fixes) {
      if (fx.alt == null && !fx.name) continue;
      const key = fx.name + Math.round(fx.x);
      if (drawn.has(key)) continue;
      drawn.add(key);
      const p = proj(fx.x, fx.y, fx.alt || 0);
      if (!p) continue;
      const txt = fx.name + (fx.cons ? ' ' + fx.cons : '');
      g.fillStyle = 'rgba(0,0,0,0.65)';
      const w = g.measureText(txt).width;
      g.fillRect(p[0] + 4, p[1] - 14, w + 6, 13);
      g.fillStyle = '#cfe0ef';
      g.fillText(txt, p[0] + 7, p[1] - 4);
      g.fillStyle = '#fff';
      g.beginPath(); g.arc(p[0], p[1], 2, 0, 7); g.fill();
    }
    updateScaleLegend([lo, hi]);
  }

  function strokePath(g, pts, proj) {
    g.beginPath();
    let started = false;
    for (const p of pts) {
      const q = proj(p[0], p[1], p[2]);
      if (!q) { started = false; continue; }
      if (!started) { g.moveTo(q[0], q[1]); started = true; }
      else g.lineTo(q[0], q[1]);
    }
    g.stroke();
  }

  function updateScaleLegend(range) {
    const sc = $('c3d-scale'), lab = $('c3d-scale-lab');
    const g = sc.getContext('2d');
    if (!range || !v3.colorByAlt) {
      g.clearRect(0, 0, sc.width, sc.height); lab.textContent = v3.colorByAlt ? '' : 'colored by procedure';
      return;
    }
    for (let x = 0; x < sc.width; x++) {
      g.fillStyle = altColor(range[0] + (range[1] - range[0]) * x / sc.width, range[0], range[1]);
      g.fillRect(x, 0, 1, sc.height);
    }
    const fmt = v => v >= 18000 ? 'FL' + Math.round(v / 100) : Math.round(v).toLocaleString() + ' ft';
    lab.textContent = `${fmt(range[0])} → ${fmt(range[1])}`;
  }

  function init3dEvents() {
    const cv = $('c3d');
    let drag = null;
    cv.addEventListener('pointerdown', e => {
      drag = { x: e.clientX, y: e.clientY, pan: e.shiftKey || e.button === 2 };
      cv.setPointerCapture(e.pointerId);
    });
    cv.addEventListener('contextmenu', e => e.preventDefault());
    cv.addEventListener('pointermove', e => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.x = e.clientX; drag.y = e.clientY;
      if (drag.pan) {
        const s = v3.dist / (cv.clientHeight * 1.35);
        const cy = Math.cos(v3.yaw), sy = Math.sin(v3.yaw);
        const sp = Math.max(0.3, Math.sin(v3.pitch));
        // move target in the ground plane, screen-relative
        const x1 = -dx * s, y1 = dy * s / sp;
        v3.target[0] += x1 * cy + y1 * sy;
        v3.target[1] += -x1 * sy + y1 * cy;
      } else {
        v3.yaw += dx * 0.006;
        v3.pitch = Math.max(0.15, Math.min(1.55, v3.pitch + dy * 0.006));
      }
      draw3d();
    });
    cv.addEventListener('pointerup', () => drag = null);
    cv.addEventListener('wheel', e => {
      e.preventDefault();
      v3.dist = Math.max(3, Math.min(2000, v3.dist * Math.exp(e.deltaY * 0.0012)));
      draw3d();
    }, { passive: false });
    $('exag').addEventListener('input', e => {
      v3.exag = +e.target.value;
      $('exag-val').textContent = v3.exag;
      draw3d();
    });
    $('c3d-reset').addEventListener('click', () => { fit3d(); draw3d(); });
    $('c3d-map').addEventListener('click', e => {
      v3.showMap = !v3.showMap;
      e.target.classList.toggle('on', v3.showMap);
      if (v3.showMap) ensureGround();
      draw3d();
    });
    $('c3d-color').addEventListener('click', e => {
      v3.colorByAlt = !v3.colorByAlt;
      e.target.textContent = 'Color: ' + (v3.colorByAlt ? 'altitude' : 'procedure');
      e.target.classList.toggle('on', v3.colorByAlt);
      draw3d();
    });
    window.addEventListener('resize', () => { if (v3.on) draw3d(); });
  }

  // ---------------------------------------------------------------- sidebar UI
  function fmtAptRow(a) {
    return `<b>${a[0]}</b> ${a[1] || ''}<span class="cnt">${a[4]}S ${a[5]}T ${a[6]}A</span>`;
  }

  function initSearch() {
    const inp = $('apt-search'), box = $('search-results');
    let hl = -1, rows = [];
    const close = () => { box.style.display = 'none'; hl = -1; };
    const renderRows = () => {
      box.innerHTML = rows.map((a, i) =>
        `<div data-i="${i}" class="${i === hl ? 'hl' : ''}">${fmtAptRow(a)}</div>`).join('');
      box.style.display = rows.length ? 'block' : 'none';
    };
    inp.addEventListener('input', () => {
      const q = inp.value.trim().toUpperCase();
      if (q.length < 2) { close(); return; }
      const apts = state.index.apts;
      const pri = [], sec = [];
      for (const a of apts) {
        if (a[0].startsWith(q) || a[0].startsWith('K' + q)) pri.push(a);
        else if ((a[1] || '').toUpperCase().includes(q)) sec.push(a);
        if (pri.length > 40) break;
      }
      rows = pri.concat(sec).slice(0, 30);
      hl = rows.length ? 0 : -1;
      renderRows();
    });
    inp.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown') { hl = Math.min(rows.length - 1, hl + 1); renderRows(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { hl = Math.max(0, hl - 1); renderRows(); e.preventDefault(); }
      else if (e.key === 'Enter' && hl >= 0) { pick(rows[hl][0]); }
      else if (e.key === 'Escape') close();
    });
    box.addEventListener('mousedown', e => {
      const d = e.target.closest('[data-i]');
      if (d) pick(rows[+d.dataset.i][0]);
    });
    document.addEventListener('click', e => {
      if (!e.target.closest('#search-box')) close();
    });
    const pick = icao => { close(); inp.value = icao; loadAirport(icao, true); };
  }

  async function loadAirport(icao, fly) {
    if (!state.docs.has(icao)) {
      try {
        const r = await fetch('data/procedures/apt/' + icao + '.json');
        if (!r.ok) throw new Error(r.status);
        state.docs.set(icao, await r.json());
      } catch (err) {
        $('apt-title').textContent = icao + ' — no procedure data';
        return null;
      }
    }
    state.curApt = icao;
    const doc = state.docs.get(icao);
    buildTree(doc);
    if (fly) {
      map.flyTo([doc.lat, doc.lon], 10, { duration: 0.8 });
      redraw();
    }
    return doc;
  }

  const KIND_LABEL = { enroute: 'Enroute transitions', common: 'Common route',
    runway: 'Runway transitions', transition: 'Approach transitions',
    final: 'Final + missed', other: 'Other' };
  const KIND_ORDER = { SID: ['runway', 'common', 'enroute', 'other'],
    STAR: ['enroute', 'common', 'runway', 'other'],
    APP: ['transition', 'final', 'other'] };

  function buildTree(doc) {
    $('apt-title').innerHTML = `${doc.id} <small>${doc.name || ''}${doc.elev != null ? ' · ' + doc.elev + ' ft' : ''}</small>`;
    const tree = $('proc-tree');
    tree.innerHTML = '';
    const groups = [['SID', 'SIDs — departures'], ['STAR', 'STARs — arrivals'], ['APP', 'Instrument approaches']];
    for (const [type, label] of groups) {
      const procs = doc.procs.filter(p => p.type === type);
      if (!procs.length) continue;
      const h = document.createElement('div');
      h.className = 'grp-head'; h.textContent = label;
      tree.appendChild(h);
      for (const proc of procs) tree.appendChild(procRow(doc, proc));
    }
    if (!tree.children.length)
      tree.innerHTML = '<div id="tree-empty">No coded procedures at this airport.</div>';
  }

  function procRow(doc, proc) {
    const key = selKey(doc.id, proc.id);
    const row = document.createElement('div');
    row.className = 'proc-row';
    const head = document.createElement('div');
    head.className = 'proc-head';
    const label = proc.type === 'APP' ? (proc.name || proc.id) : proc.id;
    head.innerHTML = `<span class="dot"></span><span class="nm">${label}` +
      (proc.type === 'APP' && proc.name && proc.name !== proc.id ? ` <small>${proc.id}</small>` : '') +
      `</span><span class="exp">▶</span>`;
    const list = document.createElement('div');
    list.className = 'trans-list';

    const order = KIND_ORDER[proc.type];
    const byKind = new Map();
    proc.trans.forEach((t, i) => {
      if (!byKind.has(t.k)) byKind.set(t.k, []);
      byKind.get(t.k).push(i);
    });
    const boxes = [];
    for (const kind of order) {
      const idxs = byKind.get(kind);
      if (!idxs) continue;
      const kh = document.createElement('div');
      kh.className = 'tkind'; kh.textContent = KIND_LABEL[kind];
      list.appendChild(kh);
      for (const i of idxs) {
        const t = proc.trans[i];
        const item = document.createElement('label');
        item.className = 'trans-item';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = state.sel.get(key)?.has(i) || false;
        cb.addEventListener('change', () => {
          setTrans(doc.id, proc.id, i, cb.checked);
          syncHead(); redraw();
        });
        boxes.push(cb);
        item.appendChild(cb);
        item.appendChild(document.createTextNode(' ' + t.t));
        list.appendChild(item);
      }
    }
    const syncHead = () => {
      const set = state.sel.get(key);
      const on = !!(set && set.size);
      head.classList.toggle('on', on);
      head.querySelector('.dot').style.background = on ? procColor(key) : '#333';
    };
    head.addEventListener('click', e => {
      if (e.target.classList.contains('exp')) { row.classList.toggle('open'); return; }
      const set = state.sel.get(key);
      const turnOn = !(set && set.size);
      proc.trans.forEach((t, i) => setTrans(doc.id, proc.id, i, turnOn));
      boxes.forEach(b => b.checked = turnOn);
      syncHead();
      redraw();
      if (turnOn) fitToSelection(doc.id, proc.id);
    });
    head.querySelector('.exp').addEventListener('click', e => e.stopPropagation());
    syncHead();
    row.appendChild(head); row.appendChild(list);
    return row;
  }

  function fitToSelection(apt, procId) {
    const set = state.sel.get(selKey(apt, procId));
    if (!set) return;
    const b = L.latLngBounds([]);
    for (const idx of set) {
      const g = getGeom(apt, procId, idx);
      for (const s of g.segments) for (const p of s.pts) b.extend([p[0], p[1]]);
    }
    if (b.isValid()) map.flyToBounds(b.pad(0.12), { duration: 0.8 });
    if (v3.on) { render3d(); fit3d(); draw3d(); }
  }

  // ---------------------------------------------------------------- chips
  function updateChips() {
    const el = $('chips');
    el.innerHTML = '';
    let count = 0;
    for (const [key, set] of state.sel) {
      const [apt, procId] = key.split('|');
      count += set.size;
      const doc = state.docs.get(apt);
      const proc = doc && doc.procs.find(p => p.id === procId);
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.innerHTML = `<span class="sw" style="background:${procColor(key)}"></span>` +
        `${apt} ${proc && proc.name ? proc.name : procId} <small>(${set.size})</small><span class="x">✕</span>`;
      chip.querySelector('.x').addEventListener('click', () => {
        state.sel.delete(key);
        if (state.curApt === apt) buildTree(state.docs.get(apt));
        redraw();
      });
      el.appendChild(chip);
    }
    $('sel-count').textContent = count ? `${count} transition${count > 1 ? 's' : ''} shown` : '';
  }

  // ---------------------------------------------------------------- URL hash
  function saveHash() {
    const parts = [];
    for (const [key, set] of state.sel)
      parts.push(key.replace('|', '.') + '.' + [...set].join('_'));
    let h = '';
    if (state.curApt) h = 'apt=' + state.curApt;
    if (parts.length) h += (h ? '&' : '') + 'sel=' + parts.join(',');
    history.replaceState(null, '', h ? '#' + h : location.pathname);
  }
  async function loadHash() {
    const h = new URLSearchParams(location.hash.slice(1));
    const apt = h.get('apt');
    const sel = h.get('sel');
    if (sel) {
      for (const part of sel.split(',')) {
        const m = part.match(/^([A-Z0-9]+)\.(.+?)\.([\d_]+)$/);
        if (!m) continue;
        await loadAirport(m[1], false);
        if (!state.docs.has(m[1])) continue;
        for (const i of m[3].split('_')) setTrans(m[1], m[2], +i, true);
      }
    }
    if (apt) await loadAirport(apt, false);
    if (state.curApt) {
      const doc = state.docs.get(state.curApt);
      $('apt-search').value = state.curApt;
      buildTree(doc);
      if (state.sel.size) {
        const first = [...state.sel.keys()][0].split('|');
        redraw();
        fitToSelection(first[0], first[1]);
      } else {
        map.setView([doc.lat, doc.lon], 10);
        redraw();
      }
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- boot
  async function boot() {
    initMap();
    init3dEvents();
    initSearch();

    $('btn-clear').addEventListener('click', () => {
      state.sel.clear();
      if (state.curApt) buildTree(state.docs.get(state.curApt));
      redraw();
    });
    $('chk-labels').addEventListener('change', e => { state.labels = e.target.checked; redraw(); });
    $('chk-missed').addEventListener('change', e => { state.missed = e.target.checked; redraw(); });
    $('btn-flow').addEventListener('click', e => {
      state.flow = !state.flow;
      e.target.classList.toggle('on', state.flow);
      if (state.flow) startFlow(); else stopFlow();
    });
    $('btn-3d').addEventListener('click', e => {
      v3.on = !v3.on;
      e.target.classList.toggle('on', v3.on);
      $('panel3d').classList.toggle('on', v3.on);
      if (v3.on) { render3d(); fit3d(); draw3d(); }
    });

    try {
      const r = await fetch('data/procedures/index.json');
      state.index = await r.json();
      $('cycle-date').textContent = state.index.effective || state.index.built || '—';
    } catch (err) {
      $('cycle-date').textContent = 'data unavailable';
      $('tree-empty').textContent = 'Could not load procedure data (data/procedures/index.json).';
      return;
    }

    const fromHash = await loadHash();
    if (!fromHash) {
      const home = 'KBWI';
      $('apt-search').value = home;
      await loadAirport(home, true);
    }
  }

  boot();
})();
