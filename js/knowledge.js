/* ---------------------------------------------------------------------------
   Aviation Knowledge Map — jesselevine.net
   An interactive, expandable node graph of the airplane private/instrument/
   commercial knowledge domains. Concepts nest as a tree; dashed cross-links
   show relationships that jump between branches. Pure canvas, no libraries,
   no data leaves the page.

   Beyond the graph: a readable Outline view of the same tree, deep links
   (#c=node-id), per-concept "known" study progress in localStorage, and
   pointers from concepts to the site's interactive explainers.
   --------------------------------------------------------------------------- */
(function () {
  'use strict';

  /* ── Data layer ─────────────────────────────────────────────────────────────
     Content lives in data/knowledge/*.md, compiled to data/knowledge.json by
     scripts/build_knowledge.py. This file is just the engine: it loads that
     JSON and builds the maps the graph renders from. Edit the Markdown and run
     the build — never hand-edit the data here. ------------------------------- */
  let GROUPS = {};             // group key -> {name, color}
  const NODES = {};            // id -> {id, label, group, s}
  const CHILDREN = {};         // id -> [child ids]
  const PARENT = {};           // id -> parent id
  const CROSS = [];            // {a, b, label}
  const TREE = { id: null };   // root-id holder (an object so the renderer's
                               // many TREE.id references keep resolving)

  function loadData(data) {
    GROUPS = data.groups;
    TREE.id = data.root;
    data.nodes.forEach(function (nd) {
      NODES[nd.id] = { id: nd.id, label: nd.label, group: nd.group, s: nd.summary || '' };
      CHILDREN[nd.id] = (nd.children || []).slice();
      PARENT[nd.id] = nd.parent || null;
    });
    (data.cross || []).forEach(function (c) {
      CROSS.push({ a: c.a, b: c.b, label: c.label });
    });
  }

  function findDomainRoot(group) {
    for (const id of CHILDREN[TREE.id]) {
      if (NODES[id].group === group) return id;
    }
    return null;
  }

  /* Concepts that have a live explainer elsewhere on the site. Looked up by
     node id, walking up the parent chain, so children inherit the pointer.
     A key that stops matching a node id is harmless — it's just never hit. */
  const TOOL_LINKS = {
    'region-of-reversed-command': { href: 'power.html', name: 'The Power Curve', sub: 'fly the back side of the curve in a sim' },
    'drag':                       { href: 'power.html', name: 'The Power Curve', sub: 'parasite vs induced drag, interactively' },
    'induced-drag':               { href: 'power.html', name: 'The Power Curve', sub: 'parasite vs induced drag, interactively' },
    'parasite-drag':              { href: 'power.html', name: 'The Power Curve', sub: 'parasite vs induced drag, interactively' },
    'slow-flight-and-stalls':     { href: 'power.html', name: 'The Power Curve', sub: 'why slow flight lives behind the power curve' },
    'eights-on-pylons':           { href: 'eights.html', name: 'Eights on Pylons', sub: 'pivotal altitude and the full figure, simulated' },
    'ground-reference':           { href: 'eights.html', name: 'Eights on Pylons', sub: 'the wind-drift geometry, simulated' },
    'density-altitude':           { href: 'airlab.html', name: 'Air Lab', sub: 'compute it from today’s numbers' },
    'pressure-altitude':          { href: 'airlab.html', name: 'Air Lab', sub: 'the atmosphere column, interactive' },
    'standard-atmosphere-isa':    { href: 'airlab.html', name: 'Air Lab', sub: 'the atmosphere column, interactive' },
    'atmosphere-and-pressure':    { href: 'airlab.html', name: 'Air Lab', sub: 'the atmosphere column, interactive' },
    'wind-correction-triangle':   { href: 'airlab.html', name: 'Air Lab', sub: 'the IAS → TAS → GS wind triangle' },
    'stability-and-adiabatic-lapse': { href: 'skew-t.html', name: 'Skew-T Explorer', sub: 'watch a parcel rise on a real sounding' },
    'stable-vs-unstable-air':     { href: 'skew-t.html', name: 'Skew-T Explorer', sub: 'read stability off a real sounding' },
    'moisture-and-stability':     { href: 'skew-t.html', name: 'Skew-T Explorer', sub: 'moisture and lapse rates on a real sounding' },
    'crosswind-component':        { href: 'weather.html', name: 'KANP Weather', sub: 'live crosswind vs the home runway' },
    'metar':                      { href: 'weather.html', name: 'KANP Weather', sub: 'live METARs decoded for the home field' },
    'taf':                        { href: 'weather.html', name: 'KANP Weather', sub: 'live TAFs decoded for the home field' },
    'weather-briefing':           { href: 'weather.html', name: 'KANP Weather', sub: 'a live go/no-go picture for the home field' },
    'weather-products-and-briefing': { href: 'weather.html', name: 'KANP Weather', sub: 'live products for the home field' },
    'winds-and-temps-aloft-fb':   { href: 'weather.html', name: 'KANP Weather', sub: 'live winds aloft for the home field' },
    'radar-and-datalink-weather': { href: 'weather.html', name: 'KANP Weather', sub: 'live radar over the home field' },
    'ils':                        { href: 'procedures.html', name: 'Procedure Explorer', sub: 'fly any US approach in 3D' },
    'vor':                        { href: 'procedures.html', name: 'Procedure Explorer', sub: 'fly any US approach in 3D' },
    'gps-rnav-waas':              { href: 'procedures.html', name: 'Procedure Explorer', sub: 'fly any US approach in 3D' },
    'odp-vs-sid':                 { href: 'procedures.html', name: 'Procedure Explorer', sub: 'every US SID, on the chart' },
    'descent-and-star':           { href: 'procedures.html', name: 'Procedure Explorer', sub: 'every US STAR, on the chart' },
    'holding':                    { href: 'procedures.html', name: 'Procedure Explorer', sub: 'holds as charted on real procedures' },
    'ads-b':                      { href: 'kanp.html', name: 'KANP Flight Tracker', sub: 'live ADS-B over Annapolis' },
  };
  function toolFor(id) {
    let cur = id;
    while (cur) {
      if (TOOL_LINKS[cur]) return TOOL_LINKS[cur];
      cur = PARENT[cur];
    }
    return null;
  }

  /* ── Live graph state ─────────────────────────────────────────────────── */
  const P = {};              // id -> {x,y,vx,vy,pinned}
  const expanded = new Set();
  let selected = null;
  let showLinks = false;

  /* Study progress — node ids the user has marked as known. */
  const known = new Set();
  try {
    JSON.parse(localStorage.getItem('kg_known_v1') || '[]').forEach(function (id) { known.add(id); });
  } catch (e) { /* corrupted storage — start fresh */ }
  function saveKnown() {
    try { localStorage.setItem('kg_known_v1', JSON.stringify([...known])); } catch (e) { /* private mode */ }
  }

  const canvas = document.getElementById('graph');
  const ctx = canvas.getContext('2d');
  const wrap = document.getElementById('graph-wrap');

  let view = { x: 0, y: 0, k: 1 };   // pan + zoom
  let W = 0, H = 0, DPR = 1;

  /* Physics sleep + dirty-flag drawing: stop simulating once the layout
     settles, and only repaint when something changed. */
  let asleep = false, calm = 0, needDraw = true;
  function wake() { asleep = false; calm = 0; needDraw = true; }

  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = wrap.clientWidth;
    H = wrap.clientHeight;
    canvas.width = W * DPR;
    canvas.height = H * DPR;
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    needDraw = true;
  }

  function visibleIds() {
    // Root + children of any expanded node whose parent chain is visible.
    const vis = new Set([TREE.id]);
    const stack = [TREE.id];
    while (stack.length) {
      const id = stack.pop();
      if (expanded.has(id)) {
        CHILDREN[id].forEach(function (c) { vis.add(c); stack.push(c); });
      }
    }
    return vis;
  }

  function ensureParticle(id, parentId) {
    if (P[id]) return;
    const pp = parentId && P[parentId] ? P[parentId] : { x: 0, y: 0 };
    const ang = Math.random() * Math.PI * 2;
    P[id] = {
      x: pp.x + Math.cos(ang) * 60 + (Math.random() - 0.5) * 20,
      y: pp.y + Math.sin(ang) * 60 + (Math.random() - 0.5) * 20,
      vx: 0, vy: 0, pinned: false,
    };
  }

  /* Seed a node's children fanned out AWAY from its own parent, so new
     branches unfold outward instead of landing on top of the trunk. */
  function seedChildren(id) {
    const pp = P[id];
    if (!pp) return;
    const kids = CHILDREN[id];
    const missing = kids.filter(function (c) { return !P[c]; });
    if (!missing.length) return;
    const par = PARENT[id];
    let base = Math.random() * Math.PI * 2;
    if (par && P[par]) base = Math.atan2(pp.y - P[par].y, pp.x - P[par].x);
    const n = kids.length;
    const spread = id === TREE.id ? Math.PI * 2
      : Math.min(Math.PI * 1.6, Math.max(Math.PI * 0.7, n * 0.45));
    const childDepth = depthOf(id) + 1;
    const dist = childDepth === 1 ? 150 : childDepth === 2 ? 110 : 88;
    kids.forEach(function (c, i) {
      if (P[c]) return;
      const ang = base - spread / 2 + spread * (i + 0.5) / n;
      P[c] = {
        x: pp.x + Math.cos(ang) * dist + (Math.random() - 0.5) * 12,
        y: pp.y + Math.sin(ang) * dist + (Math.random() - 0.5) * 12,
        vx: 0, vy: 0, pinned: false,
      };
    });
  }

  function nodeRadius(id) {
    if (id === TREE.id) return 26;
    const depth = depthOf(id);
    const hasKids = CHILDREN[id].length > 0;
    let r = depth === 1 ? 19 : depth === 2 ? 13 : 10;
    if (!hasKids) r -= 1.5;
    return r;
  }

  const _depthCache = {};
  function depthOf(id) {
    if (_depthCache[id] != null) return _depthCache[id];
    let d = 0, cur = id;
    while (PARENT[cur]) { d++; cur = PARENT[cur]; }
    return (_depthCache[id] = d);
  }

  /* ── Force simulation ─────────────────────────────────────────────────── */
  function step() {
    const vis = visibleIds();
    const ids = [...vis];
    ids.forEach(function (id) { ensureParticle(id, PARENT[id]); });

    const root = P[TREE.id];

    // Repulsion (only among visible)
    for (let i = 0; i < ids.length; i++) {
      const a = P[ids[i]];
      for (let j = i + 1; j < ids.length; j++) {
        const b = P[ids[j]];
        let dx = a.x - b.x, dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) { d2 = 0.01; dx = Math.random() - 0.5; dy = Math.random() - 0.5; }
        const d = Math.sqrt(d2);
        const force = 2600 / d2;
        const fx = (dx / d) * force, fy = (dy / d) * force;
        a.vx += fx; a.vy += fy;
        b.vx -= fx; b.vy -= fy;
      }
    }

    // Parent-child springs
    ids.forEach(function (id) {
      const par = PARENT[id];
      if (!par || !vis.has(par)) return;
      const a = P[id], b = P[par];
      const desired = depthOf(id) === 1 ? 150 : depthOf(id) === 2 ? 110 : 88;
      let dx = a.x - b.x, dy = a.y - b.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const diff = (d - desired) / d * 0.035;
      const fx = dx * diff, fy = dy * diff;
      a.vx -= fx; a.vy -= fy;
      b.vx += fx; b.vy += fy;
    });

    // Cross-link springs (weak) when both visible
    CROSS.forEach(function (c) {
      if (!vis.has(c.a) || !vis.has(c.b)) return;
      const a = P[c.a], b = P[c.b];
      let dx = a.x - b.x, dy = a.y - b.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const diff = (d - 240) / d * 0.006;
      a.vx -= dx * diff; a.vy -= dy * diff;
      b.vx += dx * diff; b.vy += dy * diff;
    });

    // Root spring to world-origin anchor + integrate
    root.vx += (0 - root.x) * 0.02;
    root.vy += (0 - root.y) * 0.02;

    let maxV = 0;
    ids.forEach(function (id) {
      const p = P[id];
      if (p.pinned || id === draggingId) { p.vx = 0; p.vy = 0; return; }
      p.vx *= 0.86; p.vy *= 0.86;
      const vmax = 40;
      p.vx = Math.max(-vmax, Math.min(vmax, p.vx));
      p.vy = Math.max(-vmax, Math.min(vmax, p.vy));
      p.x += p.vx; p.y += p.vy;
      const v = Math.abs(p.vx) + Math.abs(p.vy);
      if (v > maxV) maxV = v;
    });

    // Fall asleep once everything has settled; any interaction wakes it.
    if (maxV < 0.06 && !draggingId) {
      if (++calm > 45) asleep = true;
    } else {
      calm = 0;
    }
  }

  /* ── Rendering ────────────────────────────────────────────────────────── */
  function worldToScreen(x, y) {
    return { x: (x + view.x) * view.k + W / 2, y: (y + view.y) * view.k + H / 2 };
  }
  function screenToWorld(sx, sy) {
    return { x: (sx - W / 2) / view.k - view.x, y: (sy - H / 2) / view.k - view.y };
  }

  let hoverId = null;

  /* Focus set: with a node selected, its ancestors, visible subtree and
     cross-linked partners stay full-strength; the rest of the map dims. */
  let focusDirty = true, focusSet = null;
  const DIM = 0.4;
  function rebuildFocus(vis) {
    focusDirty = false;
    if (!selected || selected === TREE.id) { focusSet = null; return; }
    const set = new Set();
    let cur = selected;
    while (cur) { set.add(cur); cur = PARENT[cur]; }
    const stack = [selected];
    while (stack.length) {
      const n = stack.pop();
      CHILDREN[n].forEach(function (c) {
        if (vis.has(c)) { set.add(c); stack.push(c); }
      });
    }
    CROSS.forEach(function (c) {
      if (c.a === selected) set.add(c.b);
      if (c.b === selected) set.add(c.a);
    });
    focusSet = set;
  }
  function dimOf(id) {
    return (!focusSet || focusSet.has(id) || id === hoverId) ? 1 : DIM;
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    const vis = visibleIds();
    if (focusDirty) rebuildFocus(vis);

    // Cross-links first (behind)
    ctx.lineWidth = 1;
    CROSS.forEach(function (c) {
      if (!vis.has(c.a) || !vis.has(c.b)) return;
      const a = worldToScreen(P[c.a].x, P[c.a].y);
      const b = worldToScreen(P[c.b].x, P[c.b].y);
      const active = selected === c.a || selected === c.b || hoverId === c.a || hoverId === c.b;
      if (active) ctx.strokeStyle = 'rgba(230,200,74,0.55)';
      else if (showLinks) ctx.strokeStyle = 'rgba(230,200,74,0.28)';
      else ctx.strokeStyle = 'rgba(150,160,180,0.16)';
      ctx.setLineDash([4, 5]);
      // curved
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const nx = -(b.y - a.y), ny = (b.x - a.x);
      const nlen = Math.hypot(nx, ny) || 1;
      const bow = 22;
      const cx = mx + (nx / nlen) * bow, cy = my + (ny / nlen) * bow;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.quadraticCurveTo(cx, cy, b.x, b.y);
      ctx.stroke();
      if (active && c.label) {
        ctx.setLineDash([]);
        ctx.font = '10px "Segoe UI", system-ui, sans-serif';
        const tw = ctx.measureText(c.label).width;
        ctx.fillStyle = 'rgba(15,17,22,0.8)';
        ctx.fillRect(cx - tw / 2 - 3, cy - 12, tw + 6, 13);
        ctx.fillStyle = 'rgba(230,200,74,0.9)';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(c.label, cx, cy - 2);
      }
    });
    ctx.setLineDash([]);

    // Parent-child edges
    ctx.lineWidth = 1.2;
    vis.forEach(function (id) {
      const par = PARENT[id];
      if (!par || !vis.has(par)) return;
      const a = worldToScreen(P[id].x, P[id].y);
      const b = worldToScreen(P[par].x, P[par].y);
      const col = GROUPS[NODES[id].group].color;
      const dim = Math.min(dimOf(id), dimOf(par));
      ctx.strokeStyle = hexA(col, (selected === id || selected === par ? 0.55 : 0.28) * dim);
      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(a.x, a.y);
      ctx.stroke();
    });

    // Nodes — deeper first so shallower (bigger) nodes sit on top
    const order = [...vis].sort(function (a, b) { return depthOf(b) - depthOf(a); });
    order.forEach(function (id) {
      const node = NODES[id];
      const s = worldToScreen(P[id].x, P[id].y);
      const r = nodeRadius(id) * Math.min(1.4, Math.max(0.7, view.k));
      const col = GROUPS[node.group].color;
      const isSel = id === selected;
      const isHover = id === hoverId;
      const collapsedWithKids = CHILDREN[id].length > 0 && !expanded.has(id);
      const dim = dimOf(id);

      // glow for selected
      if (isSel) {
        ctx.beginPath();
        ctx.arc(s.x, s.y, r + 7, 0, Math.PI * 2);
        ctx.fillStyle = hexA(col, 0.18);
        ctx.fill();
      }

      ctx.beginPath();
      ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      ctx.fillStyle = hexA(col, (collapsedWithKids ? 0.22 : 0.9) * dim);
      ctx.fill();
      ctx.lineWidth = isSel ? 2.5 : isHover ? 2 : 1.4;
      ctx.strokeStyle = collapsedWithKids ? hexA(col, dim) : hexA('#000000', 0.35 * dim);
      if (!collapsedWithKids && (isSel || isHover)) ctx.strokeStyle = '#fff';
      ctx.stroke();

      // "+N" badge: this branch hides N direct children
      if (collapsedWithKids) {
        ctx.fillStyle = hexA(col, dim);
        ctx.font = 'bold ' + Math.max(9, Math.round(r * 0.78)) + 'px "Segoe UI", system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('+' + CHILDREN[id].length, s.x, s.y + 0.5);
      }

      // known ✓ badge (top-right of the node)
      if (known.has(id) && r >= 7) {
        const br = Math.max(4.5, r * 0.42);
        const kx = s.x + r * 0.78, ky = s.y - r * 0.78;
        ctx.beginPath();
        ctx.arc(kx, ky, br, 0, Math.PI * 2);
        ctx.fillStyle = hexA('#22a35e', dim);
        ctx.fill();
        ctx.strokeStyle = hexA('#0d1015', 0.9 * dim);
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(kx - br * 0.45, ky + br * 0.02);
        ctx.lineTo(kx - br * 0.08, ky + br * 0.42);
        ctx.lineTo(kx + br * 0.5, ky - br * 0.38);
        ctx.strokeStyle = hexA('#eafff3', dim);
        ctx.lineWidth = Math.max(1.2, br * 0.3);
        ctx.stroke();
        ctx.lineWidth = 1.2;
      }

      // Label
      const depth = depthOf(id);
      const showLabel = depth <= 1 || isSel || isHover || view.k > 1.15 ||
                        (depth === 2 && view.k > 0.85);
      if (showLabel) {
        const fs = id === TREE.id ? 15 : depth === 1 ? 13 : 11.5;
        ctx.font = (isSel ? '600 ' : '') + fs + 'px "Segoe UI", system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        const label = node.label;
        const ty = s.y + r + 3;
        // text bg for readability
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = 'rgba(17,17,17,' + (0.72 * dim) + ')';
        ctx.fillRect(s.x - tw / 2 - 3, ty - 1, tw + 6, fs + 4);
        ctx.fillStyle = isSel ? '#fff' : isHover ? '#eee' : hexA('#e5e5e5', 0.92 * dim);
        ctx.fillText(label, s.x, ty);
      }
    });
  }

  function hexA(hex, a) {
    hex = hex.replace('#', '');
    if (hex.length === 3) hex = hex.split('').map(function (c) { return c + c; }).join('');
    const r = parseInt(hex.substr(0, 2), 16),
          g = parseInt(hex.substr(2, 2), 16),
          b = parseInt(hex.substr(4, 2), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  }

  function escHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* ── Interaction ──────────────────────────────────────────────────────── */
  let draggingId = null;
  let panning = false;
  let pinch = null;          // {d0, k0, wx, wy} while two fingers are down
  let last = { x: 0, y: 0 };
  let downAt = { x: 0, y: 0 };
  let moved = false;

  const tip = document.getElementById('tip');

  function pickNode(sx, sy) {
    const vis = visibleIds();
    let best = null, bestD = Infinity;
    vis.forEach(function (id) {
      const s = worldToScreen(P[id].x, P[id].y);
      const r = nodeRadius(id) * Math.min(1.4, Math.max(0.7, view.k)) + 4;
      const d = Math.hypot(sx - s.x, sy - s.y);
      if (d < r && d < bestD) { best = id; bestD = d; }
    });
    return best;
  }

  function pointerPos(e) {
    const rect = canvas.getBoundingClientRect();
    const t = e.touches && e.touches.length ? e.touches[0] : e;
    return { x: t.clientX - rect.left, y: t.clientY - rect.top };
  }

  function startPinch(e) {
    const rect = canvas.getBoundingClientRect();
    const t1 = e.touches[0], t2 = e.touches[1];
    const p1 = { x: t1.clientX - rect.left, y: t1.clientY - rect.top };
    const p2 = { x: t2.clientX - rect.left, y: t2.clientY - rect.top };
    const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
    const w = screenToWorld(mid.x, mid.y);
    pinch = { d0: Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1, k0: view.k, wx: w.x, wy: w.y };
    if (draggingId) { P[draggingId].pinned = false; draggingId = null; }
    panning = false;
  }

  function onDown(e) {
    hideTip();
    if (e.touches && e.touches.length >= 2) {
      startPinch(e);
      e.preventDefault && e.preventDefault();
      return;
    }
    const p = pointerPos(e);
    downAt = p; moved = false;
    const hit = pickNode(p.x, p.y);
    if (hit) {
      draggingId = hit;
      P[hit].pinned = true;
      wake();
    } else {
      panning = true;
    }
    last = p;
  }

  function onMove(e) {
    if (pinch && e.touches && e.touches.length >= 2) {
      const rect = canvas.getBoundingClientRect();
      const t1 = e.touches[0], t2 = e.touches[1];
      const p1 = { x: t1.clientX - rect.left, y: t1.clientY - rect.top };
      const p2 = { x: t2.clientX - rect.left, y: t2.clientY - rect.top };
      const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
      const d = Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1;
      view.k = Math.max(0.35, Math.min(3.2, pinch.k0 * d / pinch.d0));
      // keep the pinch's world anchor under the fingers' midpoint
      view.x = (mid.x - W / 2) / view.k - pinch.wx;
      view.y = (mid.y - H / 2) / view.k - pinch.wy;
      needDraw = true;
      e.preventDefault && e.preventDefault();
      return;
    }
    const p = pointerPos(e);
    if (Math.hypot(p.x - downAt.x, p.y - downAt.y) > 4) moved = true;

    if (draggingId) {
      const w = screenToWorld(p.x, p.y);
      P[draggingId].x = w.x; P[draggingId].y = w.y;
      P[draggingId].vx = 0; P[draggingId].vy = 0;
      wake();
      e.preventDefault && e.preventDefault();
    } else if (panning) {
      view.x += (p.x - last.x) / view.k;
      view.y += (p.y - last.y) / view.k;
      needDraw = true;
      e.preventDefault && e.preventDefault();
    } else if (!e.touches) {
      const prev = hoverId;
      hoverId = pickNode(p.x, p.y);
      canvas.style.cursor = hoverId ? 'pointer' : 'grab';
      if (prev !== hoverId) { needDraw = true; updateTip(p); }
      else if (hoverId) positionTip(p);
    }
    last = p;
  }

  function onUp(e) {
    if (e && e.touches && e.touches.length > 0) {
      // a finger remains: leave pinch if fewer than two are left
      if (e.touches.length < 2) pinch = null;
      if (draggingId) { P[draggingId].pinned = false; draggingId = null; }
      panning = false;
      last = pointerPos(e);
      return;
    }
    pinch = null;
    if (draggingId && !moved) {
      // treat as a click: select; a second click on the selection collapses
      const id = draggingId;
      P[id].pinned = false;
      if (id === selected && CHILDREN[id].length && expanded.has(id)) {
        toggleExpand(id);
      } else {
        selectNode(id);
        if (CHILDREN[id].length && !expanded.has(id)) toggleExpand(id);
      }
      wake();
    } else if (draggingId && moved) {
      // leave it pinned where dropped (feels intentional); unpin after settle
      const id = draggingId;
      setTimeout(function () { if (P[id]) P[id].pinned = false; }, 1200);
    }
    draggingId = null;
    panning = false;
  }

  function onWheel(e) {
    e.preventDefault();
    hideTip();
    const p = pointerPos(e);
    const before = screenToWorld(p.x, p.y);
    const factor = Math.exp(-e.deltaY * 0.0012);
    view.k = Math.max(0.35, Math.min(3.2, view.k * factor));
    const after = screenToWorld(p.x, p.y);
    view.x += after.x - before.x;
    view.y += after.y - before.y;
    needDraw = true;
  }

  function toggleExpand(id) {
    if (expanded.has(id)) {
      collapseSubtree(id);
    } else {
      expanded.add(id);
      seedChildren(id);
    }
    focusDirty = true;
    wake();
  }

  function collapseSubtree(id) {
    expanded.delete(id);
    CHILDREN[id].forEach(function (c) {
      if (expanded.has(c)) collapseSubtree(c);
    });
  }

  function expandPathTo(id) {
    const chain = [];
    let cur = id;
    while (cur) { chain.push(cur); cur = PARENT[cur]; }
    chain.reverse();
    chain.forEach(function (nid) {
      if (CHILDREN[nid].length && !expanded.has(nid)) {
        expanded.add(nid);
        seedChildren(nid);
      }
    });
    focusDirty = true;
    wake();
  }

  /* ── Hover tooltip ────────────────────────────────────────────────────── */
  function updateTip(p) {
    if (!hoverId || hoverId === selected || draggingId || panning) { hideTip(); return; }
    const node = NODES[hoverId];
    let s = node.s || '';
    if (s.length > 175) s = s.slice(0, 172).replace(/\s+\S*$/, '') + '…';
    tip.innerHTML = '<b>' + escHtml(node.label) + '</b>' + escHtml(s);
    tip.style.display = 'block';
    positionTip(p);
  }
  function positionTip(p) {
    if (tip.style.display !== 'block') return;
    let x = p.x + 16, y = p.y + 18;
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    if (x + tw > W - 10) x = p.x - tw - 14;
    if (y + th > H - 10) y = p.y - th - 12;
    tip.style.left = Math.max(6, x) + 'px';
    tip.style.top = Math.max(6, y) + 'px';
  }
  function hideTip() { tip.style.display = 'none'; }

  /* ── View animation & fitting ─────────────────────────────────────────── */
  let viewAnim = null;
  function animateView(targetXY, targetK) {
    const start = { x: view.x, y: view.y, k: view.k };
    const t0 = performance.now();
    const dur = 500;
    viewAnim = function (now) {
      let t = Math.min(1, (now - t0) / dur);
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      view.x = start.x + (targetXY.x - start.x) * e;
      view.y = start.y + (targetXY.y - start.y) * e;
      view.k = start.k + (targetK - start.k) * e;
      if (t >= 1) viewAnim = null;
    };
  }

  function centerOn(id) {
    ensureParticle(id, PARENT[id]);
    const p = P[id];
    animateView({ x: -p.x, y: -p.y }, view.k < 0.9 ? 1.1 : view.k);
  }

  function fitView() {
    const vis = visibleIds();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    vis.forEach(function (id) {
      ensureParticle(id, PARENT[id]);
      const p = P[id];
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    });
    if (!isFinite(minX)) return;
    const pad = 80;
    const bw = Math.max(1, maxX - minX), bh = Math.max(1, maxY - minY);
    const k = Math.max(0.35, Math.min(2.2, Math.min((W - pad * 2) / bw, (H - pad * 2) / bh)));
    animateView({ x: -(minX + maxX) / 2, y: -(minY + maxY) / 2 }, k);
  }

  /* ── Info panel ───────────────────────────────────────────────────────── */
  const panelTitle = document.getElementById('info-title');
  const panelGroup = document.getElementById('info-group');
  const panelBody = document.getElementById('info-body');
  const panelLinks = document.getElementById('info-links');
  const panelPath = document.getElementById('info-path');
  const panelTool = document.getElementById('info-tool');
  const actKnown = document.getElementById('act-known');
  const actShare = document.getElementById('act-share');
  const actMap = document.getElementById('act-map');

  function selectNode(id) {
    selected = id;
    focusDirty = true;
    needDraw = true;
    const node = NODES[id];
    const g = GROUPS[node.group];
    panelTitle.textContent = node.label;
    panelGroup.textContent = g.name;
    panelGroup.style.background = hexA(g.color, 0.16);
    panelGroup.style.color = g.color;
    panelGroup.style.borderColor = hexA(g.color, 0.5);
    panelBody.textContent = node.s || 'No description.';

    // clickable breadcrumb path
    panelPath.innerHTML = '';
    const chain = [];
    let cur = PARENT[id];
    while (cur) { chain.push(cur); cur = PARENT[cur]; }
    chain.reverse();
    chain.forEach(function (aid, i) {
      if (i) panelPath.appendChild(document.createTextNode('  ›  '));
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = NODES[aid].label;
      b.addEventListener('click', function () { goTo(aid); });
      panelPath.appendChild(b);
    });

    // actions
    actKnown.style.display = id === TREE.id ? 'none' : '';
    refreshKnownButton();

    // explainer pointer
    const tool = id === TREE.id ? null : toolFor(id);
    if (tool) {
      panelTool.href = tool.href;
      panelTool.innerHTML = '⚙ Explore this live: <b>' + escHtml(tool.name) + '</b>' +
        '<small>' + escHtml(tool.sub) + '</small>';
      panelTool.style.display = 'block';
    } else {
      panelTool.style.display = 'none';
    }

    // related links
    renderPanelLinks(id, false);

    // deep link
    try {
      if (id === TREE.id) history.replaceState(null, '', location.pathname + location.search);
      else history.replaceState(null, '', '#c=' + id);
    } catch (e) { /* file:// etc. */ }

    // outline highlight
    if (olBuilt) {
      if (olSelRow) olSelRow.classList.remove('ol-sel');
      olSelRow = olRow[id] || null;
      if (olSelRow) olSelRow.classList.add('ol-sel');
    }
  }

  function renderPanelLinks(id, showAllKids) {
    panelLinks.innerHTML = '';
    const rel = [];
    CROSS.forEach(function (c) {
      if (c.a === id) rel.push({ id: c.b, label: c.label });
      else if (c.b === id) rel.push({ id: c.a, label: c.label });
    });
    const allKids = CHILDREN[id];
    const kids = showAllKids ? allKids : allKids.slice(0, 10);
    if (kids.length) {
      const h = document.createElement('div');
      h.className = 'link-head';
      h.textContent = 'Contains ' + allKids.length;
      panelLinks.appendChild(h);
      kids.forEach(function (kid) {
        panelLinks.appendChild(makeChip(kid, NODES[kid].label, NODES[kid].group));
      });
      if (!showAllKids && allKids.length > kids.length) {
        const more = document.createElement('button');
        more.className = 'chip more';
        more.textContent = '… and ' + (allKids.length - kids.length) + ' more';
        more.addEventListener('click', function () { renderPanelLinks(id, true); });
        panelLinks.appendChild(more);
      }
    }
    if (rel.length) {
      const h = document.createElement('div');
      h.className = 'link-head';
      h.textContent = 'Connected to';
      panelLinks.appendChild(h);
      rel.forEach(function (r) {
        panelLinks.appendChild(makeChip(r.id, NODES[r.id].label + ' · ' + r.label, NODES[r.id].group));
      });
    }
  }

  function makeChip(id, text, group) {
    const el = document.createElement('button');
    el.className = 'chip';
    el.textContent = text;
    el.style.borderColor = hexA(GROUPS[group].color, 0.45);
    el.addEventListener('click', function () { goTo(id); });
    return el;
  }

  function refreshKnownButton() {
    const on = selected && known.has(selected);
    actKnown.classList.toggle('on', !!on);
    actKnown.textContent = on ? '✓ Known — tap to unmark' : '✓ Mark as known';
  }

  actKnown.addEventListener('click', function () {
    if (selected && selected !== TREE.id) toggleKnown(selected);
  });

  actShare.addEventListener('click', function () {
    const url = location.origin + location.pathname +
      (selected === TREE.id ? '' : '#c=' + selected);
    const done = function () {
      const t = actShare.textContent;
      actShare.textContent = '✓ Copied';
      setTimeout(function () { actShare.textContent = t; }, 1400);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done, function () { fallbackCopy(url); done(); });
    } else {
      fallbackCopy(url); done();
    }
  });
  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* nothing more to try */ }
    document.body.removeChild(ta);
  }

  actMap.addEventListener('click', function () {
    setOutline(false);
    if (selected) { expandPathTo(selected); centerOn(selected); }
  });

  /* ── Study progress ───────────────────────────────────────────────────── */
  function toggleKnown(id) {
    if (known.has(id)) known.delete(id);
    else known.add(id);
    saveKnown();
    if (olCheck[id]) olCheck[id].checked = known.has(id);
    refreshKnownButton();
    refreshProgress();
    needDraw = true;
  }

  const olProgress = document.getElementById('ol-progress');
  const olStats = document.getElementById('ol-stats');
  function refreshProgress() {
    const totals = {}, counts = {};
    let total = 0, count = 0;
    Object.values(NODES).forEach(function (n) {
      if (n.id === TREE.id) return;
      totals[n.group] = (totals[n.group] || 0) + 1;
      total++;
      if (known.has(n.id)) {
        counts[n.group] = (counts[n.group] || 0) + 1;
        count++;
      }
    });
    legend.querySelectorAll('.leg-count').forEach(function (el) {
      const g = el.getAttribute('data-group');
      el.textContent = counts[g] ? counts[g] + '/' + totals[g] : '';
    });
    olStats.textContent = total + ' concepts · ' + (CHILDREN[TREE.id] || []).length + ' domains.';
    olProgress.textContent = count ? '✓ ' + count + ' of ' + total + ' known.' : '';
  }

  document.getElementById('ol-reset').addEventListener('click', function () {
    if (!known.size) return;
    if (!confirm('Clear your ' + known.size + ' known-concept marks?')) return;
    known.clear();
    saveKnown();
    Object.values(olCheck).forEach(function (cb) { cb.checked = false; });
    refreshKnownButton();
    refreshProgress();
    needDraw = true;
  });

  /* ── Outline view ─────────────────────────────────────────────────────── */
  const btnView = document.getElementById('btn-view');
  const olRow = {}, olDetails = {}, olCheck = {};
  let olBuilt = false, olSelRow = null;

  function outlineOpen() { return wrap.classList.contains('outline-open'); }

  function setOutline(open) {
    wrap.classList.toggle('outline-open', open);
    btnView.textContent = open ? '🗺 Map' : '☰ Outline';
    actMap.style.display = open ? '' : 'none';
    if (open) {
      hideTip();
      buildOutline();
      if (selected && selected !== TREE.id) outlineReveal(selected, true);
      else if (olSelRow) { olSelRow.classList.remove('ol-sel'); olSelRow = null; }
    } else {
      wake();
    }
  }
  btnView.addEventListener('click', function () { setOutline(!outlineOpen()); });

  function buildOutline() {
    if (olBuilt) return;
    olBuilt = true;
    const tree = document.getElementById('ol-tree');
    const frag = document.createDocumentFragment();
    CHILDREN[TREE.id].forEach(function (d) { frag.appendChild(makeOl(d, 1)); });
    tree.appendChild(frag);
    if (selected && olRow[selected]) {
      olSelRow = olRow[selected];
      olSelRow.classList.add('ol-sel');
    }
    refreshProgress();
  }

  function makeOl(id, depth) {
    const node = NODES[id];
    const kids = CHILDREN[id];
    const col = GROUPS[node.group].color;

    const row = document.createElement('div');
    row.className = 'ol-row';

    let caret = null;
    if (kids.length) {
      caret = document.createElement('span');
      caret.className = 'ol-caret';
      caret.textContent = '▶';
      row.appendChild(caret);
    }
    const dot = document.createElement('span');
    dot.className = 'ol-dot';
    dot.style.background = col;
    row.appendChild(dot);

    const lab = document.createElement('span');
    lab.className = 'ol-label';
    lab.textContent = node.label;
    if (depth === 1) lab.style.color = col;
    row.appendChild(lab);

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = known.has(id);
    cb.title = 'Mark as known';
    cb.setAttribute('aria-label', 'Mark "' + node.label + '" as known');
    cb.addEventListener('click', function (e) { e.stopPropagation(); });
    cb.addEventListener('change', function () { toggleKnown(id); });
    row.appendChild(cb);

    olRow[id] = row;
    olCheck[id] = cb;

    const extras = [];
    if (node.s) {
      const p = document.createElement('p');
      p.className = 'ol-sum';
      p.textContent = node.s;
      extras.push(p);
    }
    const rel = [];
    CROSS.forEach(function (c) {
      if (c.a === id) rel.push({ id: c.b, label: c.label });
      else if (c.b === id) rel.push({ id: c.a, label: c.label });
    });
    if (rel.length) {
      const links = document.createElement('div');
      links.className = 'ol-links';
      rel.forEach(function (r) {
        const x = document.createElement('button');
        x.type = 'button';
        x.className = 'ol-x';
        x.textContent = '↪ ' + NODES[r.id].label + (r.label ? ' — ' + r.label : '');
        x.addEventListener('click', function (e) {
          e.stopPropagation();
          e.preventDefault();
          goTo(r.id);
        });
        links.appendChild(x);
      });
      extras.push(links);
    }

    if (kids.length) {
      const det = document.createElement('details');
      det.className = 'ol-node ol-' + Math.min(depth, 3);
      if (depth === 1) det.open = true;
      olDetails[id] = det;
      const sum = document.createElement('summary');
      sum.appendChild(row);
      det.appendChild(sum);
      extras.forEach(function (el) { det.appendChild(el); });
      kids.forEach(function (k) { det.appendChild(makeOl(k, depth + 1)); });
      // Clicking the row selects (and opens); only the caret collapses.
      sum.addEventListener('click', function (e) {
        e.preventDefault();
        selectNode(id);
        det.open = true;
      });
      caret.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        det.open = !det.open;
      });
      return det;
    }
    const box = document.createElement('div');
    box.className = 'ol-leaf ol-' + Math.min(depth, 3);
    box.appendChild(row);
    extras.forEach(function (el) { box.appendChild(el); });
    row.addEventListener('click', function () { selectNode(id); });
    return box;
  }

  function outlineReveal(id, quiet) {
    if (!olBuilt) buildOutline();
    let cur = PARENT[id];
    while (cur) {
      if (olDetails[cur]) olDetails[cur].open = true;
      cur = PARENT[cur];
    }
    if (olDetails[id]) olDetails[id].open = true;
    const row = olRow[id];
    if (!row) return;
    row.scrollIntoView({ block: 'center', behavior: quiet ? 'auto' : 'smooth' });
    if (!quiet) {
      row.classList.remove('ol-flash');
      void row.offsetWidth;   // restart the animation
      row.classList.add('ol-flash');
    }
  }

  /* ── Navigation (map + outline + hash) ────────────────────────────────── */
  function goTo(id) {
    if (!NODES[id]) return;
    selectNode(id);
    if (outlineOpen()) {
      outlineReveal(id);
    } else {
      expandPathTo(id);
      centerOn(id);
    }
  }

  function applyHash() {
    const m = location.hash.match(/[#&]c=([\w-]+)/);
    if (m && NODES[m[1]]) goTo(m[1]);
  }
  window.addEventListener('hashchange', applyHash);

  /* ── Search ───────────────────────────────────────────────────────────── */
  const searchInput = document.getElementById('search');
  const searchResults = document.getElementById('search-results');
  let SEARCH = [];             // {id, labelLC, textLC, path}
  let srActive = -1;

  function buildSearchIndex() {
    SEARCH = Object.values(NODES)
      .filter(function (n) { return n.id !== TREE.id; })
      .map(function (n) {
        const chain = [];
        let cur = PARENT[n.id];
        while (cur && cur !== TREE.id) { chain.push(NODES[cur].label); cur = PARENT[cur]; }
        chain.reverse();
        return {
          id: n.id,
          label: n.label,
          group: n.group,
          labelLC: n.label.toLowerCase(),
          textLC: (n.label + ' ' + (n.s || '')).toLowerCase(),
          path: chain.join(' › '),
        };
      });
  }

  function runSearch(q) {
    q = q.trim().toLowerCase();
    searchResults.innerHTML = '';
    srActive = -1;
    if (!q) { searchResults.style.display = 'none'; return; }
    const tokens = q.split(/\s+/);
    const hits = [];
    SEARCH.forEach(function (s) {
      if (!tokens.every(function (t) { return s.textLC.indexOf(t) >= 0; })) return;
      let score;
      if (s.labelLC.indexOf(q) === 0) score = 0;
      else if (s.labelLC.indexOf(q) >= 0) score = 1;
      else if (tokens.every(function (t) { return s.labelLC.indexOf(t) >= 0; })) score = 2;
      else score = 3;
      hits.push({ s: s, score: score });
    });
    hits.sort(function (a, b) { return a.score - b.score || a.s.label.length - b.s.label.length; });
    if (!hits.length) { searchResults.style.display = 'none'; return; }
    hits.slice(0, 14).forEach(function (h) {
      const el = document.createElement('button');
      el.className = 'sr-item';
      const top = document.createElement('div');
      top.className = 'sr-top';
      const dot = document.createElement('span');
      dot.className = 'sr-dot';
      dot.style.background = GROUPS[h.s.group].color;
      top.appendChild(dot);
      const t = document.createElement('span');
      t.textContent = h.s.label;
      top.appendChild(t);
      if (known.has(h.s.id)) {
        const k = document.createElement('span');
        k.className = 'sr-known';
        k.textContent = '✓';
        top.appendChild(k);
      }
      el.appendChild(top);
      const path = document.createElement('div');
      path.className = 'sr-path';
      path.textContent = h.s.path || GROUPS[h.s.group].name;
      el.appendChild(path);
      el.addEventListener('click', function () {
        goTo(h.s.id);
        searchResults.style.display = 'none';
        searchInput.value = h.s.label;
        searchInput.blur();
      });
      searchResults.appendChild(el);
    });
    searchResults.style.display = 'block';
  }

  function srItems() { return searchResults.querySelectorAll('.sr-item'); }
  function srSetActive(i) {
    const items = srItems();
    if (!items.length) return;
    if (srActive >= 0 && items[srActive]) items[srActive].classList.remove('active');
    srActive = (i + items.length) % items.length;
    items[srActive].classList.add('active');
    items[srActive].scrollIntoView({ block: 'nearest' });
  }

  searchInput.addEventListener('input', function () { runSearch(this.value); });
  searchInput.addEventListener('focus', function () { if (this.value) runSearch(this.value); });
  searchInput.addEventListener('keydown', function (e) {
    const open = searchResults.style.display === 'block';
    if (e.key === 'Escape') {
      searchResults.style.display = 'none';
      searchInput.blur();
      e.preventDefault();
    } else if (open && e.key === 'ArrowDown') {
      srSetActive(srActive + 1); e.preventDefault();
    } else if (open && e.key === 'ArrowUp') {
      srSetActive(srActive - 1); e.preventDefault();
    } else if (open && e.key === 'Enter') {
      const items = srItems();
      const pick = items[srActive >= 0 ? srActive : 0];
      if (pick) pick.click();
      e.preventDefault();
    }
  });
  document.addEventListener('click', function (e) {
    if (!e.target.closest('.search-box')) searchResults.style.display = 'none';
  });

  /* ── Keyboard navigation ──────────────────────────────────────────────── */
  document.addEventListener('keydown', function (e) {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === '/') {
      e.preventDefault();
      searchInput.focus();
      searchInput.select();
      return;
    }
    if (!selected || outlineOpen()) return;
    const id = selected;
    if (e.key === 'Enter') {
      if (CHILDREN[id].length) { toggleExpand(id); e.preventDefault(); }
    } else if (e.key === 'k' || e.key === 'K') {
      if (id !== TREE.id) toggleKnown(id);
    } else if (e.key === 'ArrowLeft') {
      if (PARENT[id]) { selectNode(PARENT[id]); centerOn(PARENT[id]); }
      e.preventDefault();
    } else if (e.key === 'ArrowRight') {
      if (CHILDREN[id].length) {
        if (!expanded.has(id)) toggleExpand(id);
        selectNode(CHILDREN[id][0]);
        centerOn(CHILDREN[id][0]);
      }
      e.preventDefault();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const par = PARENT[id];
      if (par) {
        const sib = CHILDREN[par];
        const i = sib.indexOf(id);
        const j = (i + (e.key === 'ArrowDown' ? 1 : -1) + sib.length) % sib.length;
        selectNode(sib[j]);
        centerOn(sib[j]);
      }
      e.preventDefault();
    }
  });

  /* ── Controls ─────────────────────────────────────────────────────────── */
  document.getElementById('btn-expand').addEventListener('click', function () {
    expanded.add(TREE.id);
    CHILDREN[TREE.id].forEach(function (id) {
      if (CHILDREN[id].length && !expanded.has(id)) {
        expanded.add(id);
        seedChildren(id);
      }
    });
    focusDirty = true;
    wake();
    setTimeout(fitView, 600);
  });
  document.getElementById('btn-all').addEventListener('click', function () {
    // breadth-first so each ring of children seeds around settled parents
    const queue = [TREE.id];
    while (queue.length) {
      const id = queue.shift();
      if (CHILDREN[id].length) {
        if (!expanded.has(id)) { expanded.add(id); seedChildren(id); }
        CHILDREN[id].forEach(function (c) { queue.push(c); });
      }
    }
    focusDirty = true;
    wake();
    setTimeout(fitView, 800);
  });
  document.getElementById('btn-collapse').addEventListener('click', function () {
    expanded.clear();
    expanded.add(TREE.id);
    selectNode(TREE.id);
    animateView({ x: 0, y: 0 }, 1);
    focusDirty = true;
    wake();
  });
  document.getElementById('btn-reset').addEventListener('click', fitView);
  const btnLinks = document.getElementById('btn-links');
  btnLinks.addEventListener('click', function () {
    showLinks = !showLinks;
    btnLinks.classList.toggle('on', showLinks);
    needDraw = true;
  });
  document.getElementById('btn-random').addEventListener('click', function () {
    const ids = Object.keys(NODES).filter(function (id) { return id !== TREE.id; });
    if (!ids.length) return;
    goTo(ids[Math.floor(Math.random() * ids.length)]);
  });

  /* ── Legend (built after data loads) ──────────────────────────────────── */
  const legend = document.getElementById('legend');
  function buildLegend() {
    Object.keys(GROUPS).forEach(function (key) {
      if (key === 'root') return;
      const g = GROUPS[key];
      const el = document.createElement('button');
      el.className = 'leg-item';
      el.innerHTML = '<span class="leg-dot" style="background:' + g.color + '"></span>' +
        escHtml(g.name) + '<span class="leg-count" data-group="' + key + '"></span>';
      el.addEventListener('click', function () {
        const rootId = findDomainRoot(key);
        if (rootId) {
          if (outlineOpen()) { goTo(rootId); return; }
          expanded.add(TREE.id);
          if (!expanded.has(rootId)) {
            expanded.add(rootId);
            seedChildren(rootId);
          }
          selectNode(rootId);
          centerOn(rootId);
          focusDirty = true;
          wake();
        }
      });
      legend.appendChild(el);
    });
  }

  /* ── Wire up ──────────────────────────────────────────────────────────── */
  canvas.addEventListener('mousedown', onDown);
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  canvas.addEventListener('mouseleave', function () {
    if (hoverId) { hoverId = null; needDraw = true; }
    hideTip();
  });
  canvas.addEventListener('touchstart', onDown, { passive: false });
  canvas.addEventListener('touchmove', onMove, { passive: false });
  window.addEventListener('touchend', onUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('resize', resize);

  resize();

  /* ── Load the compiled knowledge data, then start the engine ───────────── */
  // bump ?v= when the compiled data changes (see CLAUDE.md cache-busting note)
  fetch('data/knowledge.json?v=2')
    .then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function (data) {
      loadData(data);
      buildLegend();
      buildSearchIndex();
      // initial: root at the origin with its domains fanned around it
      P[TREE.id] = { x: 0, y: 0, vx: 0, vy: 0, pinned: false };
      expanded.add(TREE.id);
      seedChildren(TREE.id);
      refreshProgress();
      // resolve any deep link BEFORE the default root selection — selecting
      // the root rewrites the URL and would wipe the incoming hash
      const deep = (location.hash.match(/[#&]c=([\w-]+)/) || [])[1];
      if (deep && NODES[deep]) goTo(deep);
      else selectNode(TREE.id);
      (function loop() {
        if (!asleep) { step(); needDraw = true; }
        if (viewAnim) { viewAnim(performance.now()); needDraw = true; }
        if (needDraw) { draw(); needDraw = false; }
        requestAnimationFrame(loop);
      })();
    })
    .catch(function (e) {
      const el = document.getElementById('info-body');
      if (el) el.textContent = 'Could not load the knowledge map data (' + e.message +
        '). If you opened this file directly, serve it over http instead.';
      console.error('knowledge.json load failed:', e);
    });
})();
