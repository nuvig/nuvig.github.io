/* ---------------------------------------------------------------------------
   Aviation Knowledge Map — jesselevine.net
   An interactive, expandable node graph of the airplane private/instrument/
   commercial knowledge domains. Concepts nest as a tree; dashed cross-links
   show relationships that jump between branches. Pure canvas, no libraries,
   no data leaves the page.
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

  /* ── Live graph state ─────────────────────────────────────────────────── */
  const P = {};              // id -> {x,y,vx,vy,r,pinned}
  const expanded = new Set([TREE.id]);
  let selected = TREE.id;

  const canvas = document.getElementById('graph');
  const ctx = canvas.getContext('2d');
  const wrap = document.getElementById('graph-wrap');

  let view = { x: 0, y: 0, k: 1 };   // pan + zoom
  let W = 0, H = 0, DPR = 1;

  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = wrap.clientWidth;
    H = wrap.clientHeight;
    canvas.width = W * DPR;
    canvas.height = H * DPR;
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
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
    const pp = parentId && P[parentId] ? P[parentId] : { x: W / 2, y: H / 2 };
    const ang = Math.random() * Math.PI * 2;
    P[id] = {
      x: pp.x + Math.cos(ang) * 60 + (Math.random() - 0.5) * 20,
      y: pp.y + Math.sin(ang) * 60 + (Math.random() - 0.5) * 20,
      vx: 0, vy: 0, pinned: false,
    };
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

    // Pin root near centre-left of view space (in world coords via view).
    const root = P[TREE.id];
    // gentle spring of root toward world-origin anchor
    const rootAnchorX = 0, rootAnchorY = 0;

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

    // Root spring to anchor + integrate
    root.vx += (rootAnchorX - root.x) * 0.02;
    root.vy += (rootAnchorY - root.y) * 0.02;

    ids.forEach(function (id) {
      const p = P[id];
      if (p.pinned || id === draggingId) { p.vx = 0; p.vy = 0; return; }
      p.vx *= 0.86; p.vy *= 0.86;
      // clamp
      const vmax = 40;
      p.vx = Math.max(-vmax, Math.min(vmax, p.vx));
      p.vy = Math.max(-vmax, Math.min(vmax, p.vy));
      p.x += p.vx; p.y += p.vy;
    });
  }

  /* ── Rendering ────────────────────────────────────────────────────────── */
  function worldToScreen(x, y) {
    return { x: (x + view.x) * view.k + W / 2, y: (y + view.y) * view.k + H / 2 };
  }
  function screenToWorld(sx, sy) {
    return { x: (sx - W / 2) / view.k - view.x, y: (sy - H / 2) / view.k - view.y };
  }

  let hoverId = null;

  function draw() {
    ctx.clearRect(0, 0, W, H);
    const vis = visibleIds();

    // dotted subtle background grid
    // (skip — keep it clean)

    // Cross-links first (behind)
    ctx.lineWidth = 1;
    CROSS.forEach(function (c) {
      if (!vis.has(c.a) || !vis.has(c.b)) return;
      const a = worldToScreen(P[c.a].x, P[c.a].y);
      const b = worldToScreen(P[c.b].x, P[c.b].y);
      const active = selected === c.a || selected === c.b || hoverId === c.a || hoverId === c.b;
      ctx.strokeStyle = active ? 'rgba(230,200,74,0.55)' : 'rgba(150,160,180,0.16)';
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
        ctx.fillStyle = 'rgba(230,200,74,0.9)';
        ctx.textAlign = 'center';
        ctx.fillText(c.label, cx, cy - 3);
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
      ctx.strokeStyle = hexA(col, selected === id || selected === par ? 0.55 : 0.28);
      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(a.x, a.y);
      ctx.stroke();
    });

    // Nodes
    const order = [...vis].sort(function (a, b) { return depthOf(b) - depthOf(a); });
    // draw deeper first so root sits on top? Actually draw shallow last (on top)
    order.reverse();
    order.forEach(function (id) {
      const node = NODES[id];
      const s = worldToScreen(P[id].x, P[id].y);
      const r = nodeRadius(id) * Math.min(1.4, Math.max(0.7, view.k));
      const col = GROUPS[node.group].color;
      const isSel = id === selected;
      const isHover = id === hoverId;
      const collapsedWithKids = CHILDREN[id].length > 0 && !expanded.has(id);

      // glow for selected
      if (isSel) {
        ctx.beginPath();
        ctx.arc(s.x, s.y, r + 7, 0, Math.PI * 2);
        ctx.fillStyle = hexA(col, 0.18);
        ctx.fill();
      }

      ctx.beginPath();
      ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      ctx.fillStyle = collapsedWithKids ? hexA(col, 0.22) : hexA(col, 0.9);
      ctx.fill();
      ctx.lineWidth = isSel ? 2.5 : isHover ? 2 : 1.4;
      ctx.strokeStyle = collapsedWithKids ? col : hexA('#000000', 0.35);
      if (!collapsedWithKids && (isSel || isHover)) ctx.strokeStyle = '#fff';
      ctx.stroke();

      // "+" ring hint for collapsed-with-children
      if (collapsedWithKids) {
        ctx.fillStyle = col;
        ctx.font = 'bold ' + Math.round(r * 1.05) + 'px "Segoe UI", system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('+', s.x, s.y + 0.5);
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
        ctx.fillStyle = 'rgba(17,17,17,0.72)';
        ctx.fillRect(s.x - tw / 2 - 3, ty - 1, tw + 6, fs + 4);
        ctx.fillStyle = isSel ? '#fff' : isHover ? '#eee' : hexA('#e5e5e5', 0.92);
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

  /* ── Interaction ──────────────────────────────────────────────────────── */
  let draggingId = null;
  let panning = false;
  let last = { x: 0, y: 0 };
  let downAt = { x: 0, y: 0 };
  let moved = false;

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
    const t = e.touches ? e.touches[0] : e;
    return { x: t.clientX - rect.left, y: t.clientY - rect.top };
  }

  function onDown(e) {
    const p = pointerPos(e);
    downAt = p; moved = false;
    const hit = pickNode(p.x, p.y);
    if (hit) {
      draggingId = hit;
      P[hit].pinned = true;
    } else {
      panning = true;
    }
    last = p;
  }

  function onMove(e) {
    const p = pointerPos(e);
    if (Math.hypot(p.x - downAt.x, p.y - downAt.y) > 4) moved = true;

    if (draggingId) {
      const w = screenToWorld(p.x, p.y);
      P[draggingId].x = w.x; P[draggingId].y = w.y;
      P[draggingId].vx = 0; P[draggingId].vy = 0;
      e.preventDefault && e.preventDefault();
    } else if (panning) {
      view.x += (p.x - last.x) / view.k;
      view.y += (p.y - last.y) / view.k;
      e.preventDefault && e.preventDefault();
    } else {
      hoverId = pickNode(p.x, p.y);
      canvas.style.cursor = hoverId ? 'pointer' : 'grab';
    }
    last = p;
  }

  function onUp(e) {
    if (draggingId && !moved) {
      // treat as a click: toggle + select
      const id = draggingId;
      selectNode(id);
      if (CHILDREN[id].length) toggleExpand(id);
      P[id].pinned = false;
    } else if (draggingId && moved) {
      // leave it pinned where dropped (feels intentional); unpin after settle
      const id = draggingId;
      setTimeout(function () { if (P[id]) P[id].pinned = false; }, 1200);
    } else if (panning && !moved) {
      // click on empty — deselect
    }
    draggingId = null;
    panning = false;
  }

  function onWheel(e) {
    e.preventDefault();
    const p = pointerPos(e);
    const before = screenToWorld(p.x, p.y);
    const factor = Math.exp(-e.deltaY * 0.0012);
    view.k = Math.max(0.35, Math.min(3.2, view.k * factor));
    const after = screenToWorld(p.x, p.y);
    view.x += after.x - before.x;
    view.y += after.y - before.y;
  }

  function toggleExpand(id) {
    if (expanded.has(id)) {
      // collapse subtree
      collapseSubtree(id);
    } else {
      expanded.add(id);
      // seed children near parent
      CHILDREN[id].forEach(function (c) { ensureParticle(c, id); });
    }
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
      if (CHILDREN[nid].length) {
        expanded.add(nid);
        CHILDREN[nid].forEach(function (c) { ensureParticle(c, nid); });
      }
    });
  }

  /* ── Info panel ───────────────────────────────────────────────────────── */
  const panelTitle = document.getElementById('info-title');
  const panelGroup = document.getElementById('info-group');
  const panelBody = document.getElementById('info-body');
  const panelLinks = document.getElementById('info-links');
  const panelPath = document.getElementById('info-path');

  function selectNode(id) {
    selected = id;
    const node = NODES[id];
    const g = GROUPS[node.group];
    panelTitle.textContent = node.label;
    panelGroup.textContent = g.name;
    panelGroup.style.background = hexA(g.color, 0.16);
    panelGroup.style.color = g.color;
    panelGroup.style.borderColor = hexA(g.color, 0.5);
    panelBody.textContent = node.s || 'No description.';

    // breadcrumb path
    const chain = [];
    let cur = id;
    while (cur) { chain.push(NODES[cur].label); cur = PARENT[cur]; }
    chain.reverse();
    panelPath.textContent = chain.join('  ›  ');

    // related links
    panelLinks.innerHTML = '';
    const rel = [];
    CROSS.forEach(function (c) {
      if (c.a === id) rel.push({ id: c.b, label: c.label });
      else if (c.b === id) rel.push({ id: c.a, label: c.label });
    });
    // also list children as quick jumps
    const kids = CHILDREN[id].slice(0, 12);
    if (rel.length || kids.length) {
      if (kids.length) {
        const h = document.createElement('div');
        h.className = 'link-head';
        h.textContent = expanded.has(id) ? 'Contains' : 'Contains (click node to expand)';
        panelLinks.appendChild(h);
        kids.forEach(function (kid) {
          panelLinks.appendChild(makeChip(kid, NODES[kid].label, NODES[kid].group));
        });
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
  }

  function makeChip(id, text, group) {
    const el = document.createElement('button');
    el.className = 'chip';
    el.textContent = text;
    el.style.borderColor = hexA(GROUPS[group].color, 0.45);
    el.addEventListener('click', function () {
      expandPathTo(id);
      selectNode(id);
      centerOn(id);
    });
    return el;
  }

  function centerOn(id) {
    ensureParticle(id, PARENT[id]);
    const p = P[id];
    // animate view toward centering the node
    const target = { x: -p.x, y: -p.y };
    animateView(target, view.k < 0.9 ? 1.1 : view.k);
  }

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
  /* ── Search ───────────────────────────────────────────────────────────── */
  const searchInput = document.getElementById('search');
  const searchResults = document.getElementById('search-results');

  function runSearch(q) {
    q = q.trim().toLowerCase();
    searchResults.innerHTML = '';
    if (!q) { searchResults.style.display = 'none'; return; }
    const hits = [];
    Object.values(NODES).forEach(function (node) {
      const inLabel = node.label.toLowerCase().indexOf(q) >= 0;
      const inBody = (node.s || '').toLowerCase().indexOf(q) >= 0;
      if (inLabel || inBody) hits.push({ node: node, score: inLabel ? 0 : 1 });
    });
    hits.sort(function (a, b) { return a.score - b.score || a.node.label.length - b.node.label.length; });
    if (!hits.length) { searchResults.style.display = 'none'; return; }
    hits.slice(0, 10).forEach(function (h) {
      const el = document.createElement('button');
      el.className = 'sr-item';
      const dot = document.createElement('span');
      dot.className = 'sr-dot';
      dot.style.background = GROUPS[h.node.group].color;
      el.appendChild(dot);
      const t = document.createElement('span');
      t.textContent = h.node.label;
      el.appendChild(t);
      const g = document.createElement('span');
      g.className = 'sr-group';
      g.textContent = GROUPS[h.node.group].name;
      el.appendChild(g);
      el.addEventListener('click', function () {
        expandPathTo(h.node.id);
        selectNode(h.node.id);
        centerOn(h.node.id);
        searchResults.style.display = 'none';
        searchInput.value = h.node.label;
      });
      searchResults.appendChild(el);
    });
    searchResults.style.display = 'block';
  }

  searchInput.addEventListener('input', function () { runSearch(this.value); });
  searchInput.addEventListener('focus', function () { if (this.value) runSearch(this.value); });
  document.addEventListener('click', function (e) {
    if (!e.target.closest('.search-box')) searchResults.style.display = 'none';
  });

  /* ── Controls ─────────────────────────────────────────────────────────── */
  document.getElementById('btn-expand').addEventListener('click', function () {
    // expand top-level domains
    CHILDREN[TREE.id].forEach(function (id) {
      if (CHILDREN[id].length) {
        expanded.add(id);
        CHILDREN[id].forEach(function (c) { ensureParticle(c, id); });
      }
    });
  });
  document.getElementById('btn-collapse').addEventListener('click', function () {
    expanded.clear();
    expanded.add(TREE.id);
    selectNode(TREE.id);
    animateView({ x: 0, y: 0 }, 1);
  });
  document.getElementById('btn-reset').addEventListener('click', function () {
    animateView({ x: 0, y: 0 }, 1);
  });

  /* ── Legend (built after data loads) ──────────────────────────────────── */
  const legend = document.getElementById('legend');
  function buildLegend() {
    Object.keys(GROUPS).forEach(function (key) {
      if (key === 'root') return;
      const g = GROUPS[key];
      const el = document.createElement('button');
      el.className = 'leg-item';
      el.innerHTML = '<span class="leg-dot" style="background:' + g.color + '"></span>' + g.name;
      el.addEventListener('click', function () {
        const rootId = findDomainRoot(key);
        if (rootId) {
          expanded.add(TREE.id);
          expanded.add(rootId);
          CHILDREN[rootId].forEach(function (c) { ensureParticle(c, rootId); });
          selectNode(rootId);
          centerOn(rootId);
        }
      });
      legend.appendChild(el);
    });
  }

  /* ── Wire up ──────────────────────────────────────────────────────────── */
  canvas.addEventListener('mousedown', onDown);
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  canvas.addEventListener('touchstart', onDown, { passive: false });
  canvas.addEventListener('touchmove', onMove, { passive: false });
  window.addEventListener('touchend', onUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('resize', resize);

  resize();

  /* ── Load the compiled knowledge data, then start the engine ───────────── */
  fetch('data/knowledge.json')
    .then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function (data) {
      loadData(data);
      buildLegend();
      // initial: seed the domain nodes so the map reads as a map on load
      CHILDREN[TREE.id].forEach(function (id) { ensureParticle(id, TREE.id); });
      selectNode(TREE.id);
      requestAnimationFrame(function firstFrame() {
        (function patchedLoop() {
          step();
          if (viewAnim) viewAnim(performance.now());
          draw();
          requestAnimationFrame(patchedLoop);
        })();
      });
    })
    .catch(function (e) {
      const el = document.getElementById('info-body');
      if (el) el.textContent = 'Could not load the knowledge map data (' + e.message +
        '). If you opened this file directly, serve it over http instead.';
      console.error('knowledge.json load failed:', e);
    });
})();
