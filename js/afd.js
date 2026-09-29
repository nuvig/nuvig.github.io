// LWX Discussions — afd.html. Reads data/afd.json (built by
// scripts/build_afd.py from data/wx/afd/) and, on a search, data/afd-text.json
// (the corpus itself, loaded once). No weather API of its own.
(function () {
  'use strict';

  const TZ = SITE.weather.timeZone;
  const BLUE = '#3987e5', ORANGE = '#d95926';
  const SEC_NAMES = { chg: 'what has changed', key: 'key messages', disc: 'discussion', avn: 'aviation', mar: 'marine', tide: 'tides', clim: 'climate', fire: 'fire weather' };
  const SEC_COLS = { disc: '#3987e5', avn: '#5fa3ef', mar: '#84bbf5', clim: '#a9d0f9', tide: '#c9e1fb', key: '#6b7f96', chg: '#4b5a6b', fire: '#333' };
  const CAT_COLS = { vfr: '#22c55e', mvfr: '#3b82f6', ifr: '#ef4444', lifr: '#c026d3', fog: '#9ca3af' };

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const partsOf = (t, opt) => {
    const p = {};
    new Intl.DateTimeFormat('en-US', Object.assign({ timeZone: TZ }, opt)).formatToParts(new Date(t * 1000)).forEach((x) => { p[x.type] = x.value; });
    return p;
  };
  const fmtDT = (t) => {
    const p = partsOf(t, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    return `${p.month} ${p.day} ${p.hour}:${p.minute} ${p.dayPeriod.toLowerCase()}`;
  };
  const fmtMD = (t) => { const p = partsOf(t, { month: 'short', day: 'numeric' }); return `${p.month} ${p.day}`; };
  const ymdOf = (t) => { const p = partsOf(t, { year: 'numeric', month: '2-digit', day: '2-digit' }); return `${p.year}-${p.month}-${p.day}`; };
  const dateLabel = (ymd) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }); };
  const monthLabel = (ym) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' }); };
  const dur = (h) => (h >= 48 ? `${Math.floor(h / 24)} d ${h % 24} h` : `${h} h`);
  const ago = (s) => (s < 90 ? 'just now' : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 172800 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`);
  const num = (n) => Number(n).toLocaleString('en-US');
  const almanac = (ymd) => `almanac.html#d=${ymd}`;
  const ghFile = (p) => `https://github.com/nuvig/nuvig.github.io/blob/main/data/wx/${p}`;

  let D = null;            // afd.json
  let DAYS = [];           // every calendar day first..last
  let TEXT = null;         // afd-text.json once loaded
  const drawers = new Map(); // host → re-draw closure, run on resize

  function dayRange(first, last) {
    const out = [];
    const [y, m, d] = first.split('-').map(Number);
    const end = new Date(last + 'T00:00:00Z').getTime();
    for (let t = Date.UTC(y, m - 1, d); t <= end; t += 86400000) out.push(new Date(t).toISOString().slice(0, 10));
    return out;
  }

  // ---- canvas helpers ---------------------------------------------------------
  function setup(host, h) {
    let cv = host.querySelector('canvas');
    if (!cv) { cv = document.createElement('canvas'); host.appendChild(cv); }
    const w = host.clientWidth || 600;
    const r = window.devicePixelRatio || 1;
    cv.width = Math.round(w * r); cv.height = Math.round(h * r);
    cv.style.height = h + 'px';
    const ctx = cv.getContext('2d');
    ctx.setTransform(r, 0, 0, r, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.font = '11px system-ui, sans-serif';
    return { cv, ctx, w, h };
  }
  function tooltip(host) {
    let tip = host.querySelector('.tip');
    if (!tip) { tip = document.createElement('div'); tip.className = 'tip'; host.appendChild(tip); }
    return tip;
  }
  function placeTip(tip, host, x, y, html) {
    tip.innerHTML = html;
    tip.style.display = 'block';
    const W = host.clientWidth, tw = tip.offsetWidth, th = tip.offsetHeight;
    let left = x + 14; if (left + tw > W) left = Math.max(0, x - tw - 14);
    let top = y - th - 8; if (top < 0) top = y + 14;
    tip.style.left = left + 'px'; tip.style.top = top + 'px';
  }
  function hover(host, cv, fn) {
    const tip = tooltip(host);
    cv.onmousemove = (e) => {
      const r = cv.getBoundingClientRect();
      const html = fn(e.clientX - r.left, e.clientY - r.top);
      if (html) placeTip(tip, host, e.clientX - r.left, e.clientY - r.top, html); else tip.style.display = 'none';
    };
    cv.onmouseleave = () => { tip.style.display = 'none'; };
  }
  function monthTicks(ctx, cols, x0, cw, y, h) {
    // a label at the first column of each month, a faint line at its edge
    const span = {};
    cols.forEach((ymd) => { const ym = ymd.slice(0, 7); span[ym] = (span[ym] || 0) + cw; });
    let last = '';
    cols.forEach((ymd, i) => {
      const ym = ymd.slice(0, 7);
      if (ym !== last) {
        last = ym;
        const x = x0 + i * cw;
        ctx.fillStyle = '#2a2a2a'; ctx.fillRect(x, y, 1, h);
        if (span[ym] < 30) return;   // a month with a day or two in it has no room for a label
        ctx.fillStyle = '#777'; ctx.textAlign = 'left'; ctx.fillText(monthLabel(ym).slice(0, 3), x + 3, y - 4);
      }
    });
  }

  // heat strip: rows × columns, each cell shaded by val(r,c) / rowMax
  function strip(host, opt) {
    const rows = opt.rows, cols = opt.cols;
    const L = opt.labelW || 118, T = 18, RH = opt.rowH || 16;
    function draw() {
      const H = T + rows.length * RH + 4;
      const { cv, ctx, w } = setup(host, H);
      const cw = (w - L - 4) / cols.length;
      monthTicks(ctx, cols, L, cw, T, rows.length * RH);
      rows.forEach((r, ri) => {
        const y = T + ri * RH;
        ctx.fillStyle = '#aaa'; ctx.textAlign = 'right'; ctx.fillText(opt.rowLabel(r), L - 8, y + RH - 4);
        const mx = opt.rowMax(r);
        cols.forEach((c, ci) => {
          const v = opt.val(r, c);
          const x = L + ci * cw;
          if (v == null) return;
          if (opt.binary) {
            ctx.fillStyle = v ? (opt.color ? opt.color(r) : BLUE) : '#171717';
          } else {
            const a = mx > 0 ? Math.min(1, v / mx) : 0;
            ctx.fillStyle = a === 0 ? '#171717' : `rgba(57,135,229,${0.15 + 0.85 * a})`;
          }
          ctx.fillRect(x, y + 1, Math.max(1, cw - 1), RH - 2);
        });
      });
      hover(host, cv, (x, y) => {
        const ri = Math.floor((y - T) / RH), ci = Math.floor((x - L) / cw);
        if (ri < 0 || ri >= rows.length || ci < 0 || ci >= cols.length) return null;
        return opt.tip(rows[ri], cols[ci]);
      });
      cv.style.cursor = opt.click ? 'pointer' : '';
      cv.onclick = (e) => {
        if (!opt.click) return;
        const r = cv.getBoundingClientRect();
        const ci = Math.floor((e.clientX - r.left - L) / cw);
        if (ci >= 0 && ci < cols.length) opt.click(cols[ci]);
      };
    }
    draw(); drawers.set(host, draw);
  }

  // stacked lanes of bars over the day axis, one scale each
  function lanes(host, cols, lanesDef) {
    const L = 46, LH = 70, GAP = 10;
    function draw() {
      const H = 18 + lanesDef.length * (LH + GAP);
      const { cv, ctx, w } = setup(host, H);
      const cw = (w - L - 4) / cols.length;
      monthTicks(ctx, cols, L, cw, 18, H - 18);
      lanesDef.forEach((ln, li) => {
        const y0 = 18 + li * (LH + GAP), y1 = y0 + LH;
        const vals = cols.map(ln.val);
        const mx = Math.max(1, ...vals.filter((v) => v != null));
        ctx.fillStyle = '#2a2a2a'; ctx.fillRect(L, y1, w - L - 4, 1);
        ctx.fillStyle = '#777'; ctx.textAlign = 'right';
        ctx.fillText(ln.fmt ? ln.fmt(mx) : num(mx), L - 6, y0 + 10);
        ctx.fillText('0', L - 6, y1);
        ctx.save(); ctx.translate(10, y0 + LH / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.fillStyle = '#888'; ctx.fillText(ln.label, 0, 0); ctx.restore();
        vals.forEach((v, i) => {
          if (v == null) return;
          const bh = (v / mx) * (LH - 12);
          ctx.fillStyle = ln.color || BLUE;
          ctx.fillRect(L + i * cw, y1 - bh, Math.max(1, cw - 1), bh);
        });
      });
      hover(host, cv, (x) => {
        const ci = Math.floor((x - L) / cw);
        if (ci < 0 || ci >= cols.length) return null;
        const c = cols[ci];
        return `<b>${esc(dateLabel(c))}</b><br>` + lanesDef.map((ln) => { const v = ln.val(c); return `${esc(ln.label)} ${v == null ? '—' : (ln.fmt ? ln.fmt(v) : num(v))}`; }).join('<br>');
      });
    }
    draw(); drawers.set(host, draw);
  }

  function barList(host, rows, opt) {
    opt = opt || {};
    const mx = Math.max(1, ...rows.map((r) => r[1]));
    host.innerHTML = rows.map((r) => {
      const title = opt.title ? ` title="${esc(opt.title(r))}"` : '';
      return `<span class="k"${title}>${esc(r[0])}</span><span class="b"><i style="width:${(100 * r[1] / mx).toFixed(1)}%"></i></span><span class="n">${opt.fmt ? opt.fmt(r) : num(r[1])}</span>`;
    }).join('');
  }

  // ---- render ----------------------------------------------------------------
  function renderStats() {
    const now = Date.now() / 1000;
    const lastIss = D.iss[D.iss.length - 1];
    $('stats').innerHTML =
      `<b>${num(D.n)}</b> issuances · <b>${num(D.words)}</b> words · <b>${esc(dateLabel(D.first))} – ${esc(dateLabel(D.last))}</b> · ` +
      `<span>newest <b>${esc(fmtDT(lastIss[0]))}</b> · ${ago(now - lastIss[0])}</span> · ` +
      `<span>built ${ago(now - D.built)}</span>`;
    const t = D.threads[0];
    const long = D.longest, short = D.shortest;
    $('tiles').innerHTML = [
      ['issuances', num(D.n), `${(D.n / Object.keys(D.days).length).toFixed(1)} / day`],
      ['words', num(D.words), `${num(Math.round(D.words / D.n))} per issuance`],
      ['hedges / 1k words', (D.iss.reduce((a, i) => a + i[2], 0) / D.n).toFixed(1), `${num(D.hedges.reduce((a, h) => a + h[1], 0))} hedges`],
      ['stories', num(D.threads.length), t ? `longest ${dur(t.hours)}` : ''],
      ['products named', num(D.wwa.length), D.wwa[0] ? `${esc(D.wwa[0].name)} · ${D.wwa[0].days} d` : ''],
      ['longest issuance', num(long[1]) + ' w', `<a href="${almanac(ymdOf(long[0]))}">${esc(fmtDT(long[0]))}</a>`],
      ['shortest', num(short[1]) + ' w', `<a href="${almanac(ymdOf(short[0]))}">${esc(fmtDT(short[0]))}</a>`],
    ].map(([k, v, s]) => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`).join('');
  }

  function renderThemes() {
    const rows = D.themes;
    const perIss = (id, ymd) => { const d = D.days[ymd]; return d ? ((d.themes[id] || 0) / d.n) : null; };
    const rowMax = {};
    rows.forEach((r) => {
      const v = DAYS.map((c) => perIss(r.id, c)).filter((x) => x != null).sort((a, b) => a - b);
      rowMax[r.id] = v.length ? v[Math.floor(v.length * 0.95)] || v[v.length - 1] : 1;
    });
    strip($('themes'), {
      rows, cols: DAYS,
      rowLabel: (r) => r.label, rowMax: (r) => rowMax[r.id],
      val: (r, c) => perIss(r.id, c),
      tip: (r, c) => { const d = D.days[c]; if (!d) return `<b>${esc(dateLabel(c))}</b><br><span class="d">no issuance archived</span>`; return `<b>${esc(dateLabel(c))}</b> · ${esc(r.label)}<br>${d.themes[r.id] || 0} mentions in ${d.n} issuance${d.n > 1 ? 's' : ''}`; },
      click: (c) => { if (D.days[c]) location.href = almanac(c); },
    });
  }

  function renderThreads() {
    const host = $('threads');
    const t0 = new Date(D.first + 'T00:00:00Z').getTime() / 1000 - 5 * 3600, t1 = D.iss[D.iss.length - 1][0];
    const rows = D.threads.slice(0, 40).sort((a, b) => a.first - b.first);
    const L = 8, T = 18, RH = 15;
    function draw() {
      const H = T + rows.length * RH + 4;
      const { cv, ctx, w } = setup(host, H);
      const X = (t) => L + (w - L - 4) * (t - t0) / (t1 - t0);
      monthTicks(ctx, DAYS, L, (w - L - 4) / DAYS.length, T, rows.length * RH);
      ctx.font = '10.5px system-ui, sans-serif';
      rows.forEach((th, i) => {
        const y = T + i * RH;
        const x0 = X(th.first), x1 = Math.max(X(th.last), x0 + 3);
        ctx.fillStyle = `rgba(57,135,229,${0.35 + 0.65 * Math.min(1, th.n / 20)})`;
        ctx.fillRect(x0, y + 2, x1 - x0, RH - 4);
        ctx.fillStyle = '#ddd'; ctx.textAlign = 'left';
        const label = th.text.replace(/\.$/, '');
        const roomR = w - x1 - 8, roomL = x0 - L - 8, roomIn = x1 - x0 - 6;
        const side = ctx.measureText(label).width <= roomR ? 'r' : roomL > roomR ? 'l' : 'r';
        const room = Math.max(side === 'r' ? roomR : roomL, roomIn);
        let txt = label;
        while (txt.length > 4 && ctx.measureText(txt).width > room) txt = txt.slice(0, -4) + '…';
        const inside = ctx.measureText(txt).width <= roomIn;
        ctx.fillStyle = inside ? '#eef' : '#999';
        ctx.textAlign = inside || side === 'r' ? 'left' : 'right';
        ctx.fillText(txt, inside ? x0 + 4 : side === 'r' ? x1 + 5 : x0 - 5, y + RH - 4);
      });
      hover(host, cv, (x, y) => {
        const i = Math.floor((y - T) / RH);
        if (i < 0 || i >= rows.length) return null;
        const th = rows[i];
        return `<b>${esc(th.text)}</b>` + (th.last_text !== th.text ? `<br><span class="d">last wording</span> ${esc(th.last_text)}` : '') +
          `<br>${esc(fmtDT(th.first))} → ${esc(fmtDT(th.last))} · ${dur(th.hours)} · ${th.n} issuances · ${th.versions} wording${th.versions > 1 ? 's' : ''}`;
      });
    }
    draw(); drawers.set(host, draw);

    const sorts = { longest: (a, b) => b.hours - a.hours, revised: (a, b) => b.versions - a.versions || b.hours - a.hours, newest: (a, b) => b.last - a.last };
    let sort = 'longest';
    function list() {
      $('thread-chips').innerHTML = '<span class="lbl">sort</span>' + Object.keys(sorts).map((k) => `<button class="chip${k === sort ? ' on' : ''}" data-s="${k}">${k}</button>`).join('');
      $('thread-chips').querySelectorAll('.chip').forEach((b) => { b.onclick = () => { sort = b.dataset.s; list(); }; });
      const rs = D.threads.slice().sort(sorts[sort]).slice(0, 25);
      $('thread-list').innerHTML = `<div class="tw"><table class="t"><tr><th>key message</th><th>first</th><th>last</th><th class="n">held</th><th class="n">issuances</th><th class="n">wordings</th></tr>` +
        rs.map((th) => `<tr><td>${esc(th.text)}${th.last_text !== th.text ? `<span class="was">→ ${esc(th.last_text)}</span>` : ''}</td>` +
          `<td class="n"><a href="${almanac(ymdOf(th.first))}">${esc(fmtMD(th.first))}</a></td><td class="n"><a href="${almanac(ymdOf(th.last))}">${esc(fmtMD(th.last))}</a></td>` +
          `<td class="n">${dur(th.hours)}</td><td class="n">${th.n}</td><td class="n">${th.versions}</td></tr>`).join('') + '</table></div>';
    }
    list();
  }

  function renderVolume() {
    lanes($('volume'), DAYS, [
      { label: 'words', val: (c) => (D.days[c] ? D.days[c].w : null) },
      { label: 'issuances', val: (c) => (D.days[c] ? D.days[c].n : null) },
    ]);
    // hour clock
    const host = $('hours');
    function draw() {
      const { cv, ctx, w } = setup(host, 90);
      const mx = Math.max(1, ...D.hours);
      const cw = (w - 8) / 24;
      D.hours.forEach((n, h) => {
        const bh = (n / mx) * 62;
        ctx.fillStyle = BLUE; ctx.fillRect(4 + h * cw, 70 - bh, cw - 2, bh);
        if (h % 6 === 0) { ctx.fillStyle = '#777'; ctx.textAlign = 'left'; ctx.fillText(`${h === 0 ? '12a' : h === 12 ? '12p' : h < 12 ? h + 'a' : (h - 12) + 'p'}`, 4 + h * cw, 84); }
      });
      hover(host, cv, (x) => { const h = Math.floor((x - 4) / cw); if (h < 0 || h > 23) return null; return `<b>${h}:00</b> · ${D.hours[h]} issuances`; });
    }
    draw(); drawers.set(host, draw);
    const order = ['overnight', 'morning', 'afternoon', 'evening'];
    $('slots').innerHTML = order.filter((k) => D.slots[k]).map((k) => `${k} <b style="color:#bbb">${D.slots[k].n}</b> · ${num(D.slots[k].w)} w`).join(' &nbsp;·&nbsp; ');
    // section share
    const total = Object.values(D.sections).reduce((a, b) => a + b, 0);
    const secs = Object.entries(D.sections).sort((a, b) => b[1] - a[1]);
    $('sections').innerHTML = `<div class="share">${secs.map(([k, v]) => `<i style="width:${(100 * v / total).toFixed(2)}%;background:${SEC_COLS[k] || '#444'}" title="${esc(SEC_NAMES[k] || k)} · ${num(v)} words"></i>`).join('')}</div>` +
      `<div class="share-lg">${secs.map(([k, v]) => `<span><i style="background:${SEC_COLS[k] || '#444'}"></i>${esc(SEC_NAMES[k] || k)} ${(100 * v / total).toFixed(0)}%</span>`).join('')}</div>`;
  }

  function renderHedge() {
    const host = $('hedge');
    const wk = D.weeks;
    const L = 46, LH = 80, GAP = 14;
    function draw() {
      const H = 18 + 2 * (LH + GAP) + 16;
      const { cv, ctx, w } = setup(host, H);
      const cw = (w - L - 4) / wk.length;
      // lane 1: hedge index line
      const y0 = 18, y1 = y0 + LH;
      const hv = wk.map((x) => x.h);
      const hmax = Math.max(...hv) * 1.1, hmin = Math.min(...hv) * 0.9;
      const Y = (v) => y1 - (v - hmin) / (hmax - hmin) * (LH - 8);
      ctx.fillStyle = '#2a2a2a'; ctx.fillRect(L, y1, w - L - 4, 1);
      ctx.fillStyle = '#777'; ctx.textAlign = 'right'; ctx.fillText(hmax.toFixed(0), L - 6, y0 + 10); ctx.fillText(hmin.toFixed(0), L - 6, y1);
      ctx.save(); ctx.translate(10, y0 + LH / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.fillStyle = '#888'; ctx.fillText('hedges / 1k', 0, 0); ctx.restore();
      ctx.strokeStyle = BLUE; ctx.lineWidth = 1.5; ctx.beginPath();
      wk.forEach((x, i) => { const px = L + (i + 0.5) * cw, py = Y(x.h); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
      ctx.stroke();
      wk.forEach((x, i) => { ctx.fillStyle = BLUE; ctx.beginPath(); ctx.arc(L + (i + 0.5) * cw, Y(x.h), 2.5, 0, 7); ctx.fill(); });
      // lane 2: confidence hi / lo paired bars
      const y2 = y1 + GAP, y3 = y2 + LH;
      const cmax = Math.max(1, ...wk.map((x) => Math.max(x.conf.hi, x.conf.lo)));
      ctx.fillStyle = '#2a2a2a'; ctx.fillRect(L, y3, w - L - 4, 1);
      ctx.fillStyle = '#777'; ctx.textAlign = 'right'; ctx.fillText(String(cmax), L - 6, y2 + 10); ctx.fillText('0', L - 6, y3);
      ctx.save(); ctx.translate(10, y2 + LH / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.fillStyle = '#888'; ctx.fillText('confidence', 0, 0); ctx.restore();
      wk.forEach((x, i) => {
        const bx = L + i * cw + 1, bw = Math.max(1, (cw - 3) / 2);
        const hh = x.conf.hi / cmax * (LH - 12), lh = x.conf.lo / cmax * (LH - 12);
        ctx.fillStyle = BLUE; ctx.fillRect(bx, y3 - hh, bw, hh);
        ctx.fillStyle = ORANGE; ctx.fillRect(bx + bw + 1, y3 - lh, bw, lh);
      });
      ctx.fillStyle = '#888'; ctx.textAlign = 'left';
      ctx.fillStyle = BLUE; ctx.fillRect(L, y3 + 8, 10, 10); ctx.fillStyle = '#888'; ctx.fillText('high / increasing', L + 14, y3 + 17);
      ctx.fillStyle = ORANGE; ctx.fillRect(L + 120, y3 + 8, 10, 10); ctx.fillStyle = '#888'; ctx.fillText('low / decreasing', L + 134, y3 + 17);
      hover(host, cv, (x) => {
        const i = Math.floor((x - L) / cw);
        if (i < 0 || i >= wk.length) return null;
        const k = wk[i];
        return `<b>week of ${esc(dateLabel(k.ymd))}</b><br>${k.h} hedges / 1k words · ${k.n} issuances · ${num(k.w)} words<br>high confidence ${k.conf.hi} · low ${k.conf.lo}`;
      });
    }
    draw(); drawers.set(host, draw);
    barList($('hedge-words'), D.hedges.slice(0, 14));
    if (D.rain && D.rain.wet.n && D.rain.dry.n) {
      barList($('rain'), [
        [`day before rain · hedges / 1k`, D.rain.wet.h], [`day before dry · hedges / 1k`, D.rain.dry.h],
        [`day before rain · words / issuance`, D.rain.wet.w], [`day before dry · words / issuance`, D.rain.dry.w],
      ], { fmt: (r) => `${r[1]}` });
      $('rain').insertAdjacentHTML('afterend', `<p class="note">${D.rain.wet.n} days before a wet KDCA day · ${D.rain.dry.n} before a dry one</p>`);
    } else {
      $('rain').innerHTML = '<span class="d">storm log not built</span>';
    }
  }

  function renderModels() {
    barList($('models'), D.models.slice(0, 14));
    barList($('feats'), D.feats.slice(0, 14));
    const top = D.feats.slice(0, 9).map((f) => f[0]);
    const wk = D.weeks.map((w) => w.ymd);
    const perIss = (f, ymd) => { const w = D.weeks.find((x) => x.ymd === ymd); return w ? (w.feats[f] || 0) / w.n : null; };
    strip($('feats-strip'), {
      rows: top, cols: wk, rowH: 16,
      rowLabel: (r) => r, rowMax: (r) => Math.max(0.01, ...wk.map((c) => perIss(r, c))),
      val: perIss,
      tip: (r, c) => { const w = D.weeks.find((x) => x.ymd === c); return `<b>week of ${esc(dateLabel(c))}</b> · ${esc(r)}<br>${w.feats[r] || 0} mentions in ${w.n} issuances`; },
    });
  }

  function renderWwa() {
    const rows = D.wwa.filter((w) => w.days >= 2).map((w) => w.name);
    const named = (r, c) => { const d = D.days[c]; return d ? (d.wwa.indexOf(r) >= 0 ? 1 : 0) : null; };
    strip($('wwa-strip'), {
      rows, cols: DAYS, binary: true, labelW: 150, rowH: 14,
      rowLabel: (r) => r, rowMax: () => 1, val: named,
      tip: (r, c) => `<b>${esc(dateLabel(c))}</b> · ${esc(r)} ${named(r, c) ? 'named' : 'not named'}`,
      click: (c) => { if (D.days[c]) location.href = almanac(c); },
    });
    barList($('wwa'), D.wwa.map((w) => [w.name, w.days]), { fmt: (r) => `${r[1]} d`, title: (r) => { const w = D.wwa.find((x) => x.name === r[0]); return `${dateLabel(w.first)} – ${dateLabel(w.last)}`; } });
  }

  function renderAvn() {
    const rows = ['vfr', 'mvfr', 'ifr', 'lifr', 'fog'];
    const perIss = (r, c) => { const d = D.days[c]; return d ? (d.avn[r] || 0) / d.n : null; };
    const mx = {};
    rows.forEach((r) => { const v = DAYS.map((c) => perIss(r, c)).filter((x) => x != null).sort((a, b) => a - b); mx[r] = v[Math.floor(v.length * 0.95)] || 1; });
    strip($('avn-strip'), {
      rows, cols: DAYS, rowH: 16,
      rowLabel: (r) => r.toUpperCase().replace('FOG', 'fog'), rowMax: (r) => mx[r], val: perIss,
      tip: (r, c) => { const d = D.days[c]; if (!d) return null; return `<b>${esc(dateLabel(c))}</b> · ${esc(r.toUpperCase())}<br>${d.avn[r] || 0} mentions in ${d.n} issuances`; },
      click: (c) => { if (D.days[c]) location.href = almanac(c); },
    });
    const tafs = {};
    D.weeks.forEach((w) => Object.entries(w.tafs).forEach(([k, v]) => { tafs[k] = (tafs[k] || 0) + v; }));
    barList($('tafs'), Object.entries(tafs).sort((a, b) => b[1] - a[1]).map(([k, v]) => ['K' + k, v]));
  }

  function renderTerms() {
    $('terms').innerHTML = Object.entries(D.terms).filter(([, v]) => v.length).map(([m, v]) =>
      `<div class="month"><h4>${esc(monthLabel(m))}</h4><div class="tm">${v.map(([t, n, s]) => `<span title="${n} mentions · ${Math.round(s * 100)}% of all">${esc(t)}<span class="n">${n}</span></span>`).join('')}</div></div>`).join('');
  }

  function renderTemps() {
    const host = $('temps');
    const months = Object.keys(D.temps).filter((m) => Object.values(D.temps[m]).reduce((a, b) => a + b, 0) >= 20);
    const decades = ['10s', '20s', '30s', '40s', '50s', '60s', '70s', '80s', '90s', '100'];
    const L = 70, T = 18, RH = 22;
    function draw() {
      const H = T + months.length * RH + 4;
      const { cv, ctx, w } = setup(host, H);
      const cw = (w - L - 4) / decades.length;
      ctx.fillStyle = '#777'; ctx.textAlign = 'center';
      decades.forEach((d, i) => ctx.fillText(d === '100' ? '100+' : d, L + (i + 0.5) * cw, T - 5));
      months.forEach((m, mi) => {
        const y = T + mi * RH;
        const row = D.temps[m], tot = Object.values(row).reduce((a, b) => a + b, 0);
        const mx = Math.max(...Object.values(row));
        ctx.fillStyle = '#aaa'; ctx.textAlign = 'right'; ctx.fillText(monthLabel(m).slice(0, 3) + ` · ${tot}`, L - 8, y + RH - 7);
        decades.forEach((d, i) => {
          const v = row[d] || 0;
          const a = v / mx;
          ctx.fillStyle = a === 0 ? '#171717' : `rgba(57,135,229,${0.15 + 0.85 * a})`;
          ctx.fillRect(L + i * cw + 1, y + 1, cw - 2, RH - 2);
          if (v) { ctx.fillStyle = a > 0.55 ? '#fff' : '#999'; ctx.textAlign = 'center'; ctx.fillText(String(v), L + (i + 0.5) * cw, y + RH - 7); }
        });
      });
    }
    draw(); drawers.set(host, draw);
  }

  function renderLists() {
    barList($('places'), D.places.slice(0, 16));
    barList($('sigs'), D.sigs.slice(0, 16).map((s) => [s.sig, s.n]), {
      title: (r) => { const s = D.sigs.find((x) => x.sig === r[0]); return s.disc_n >= 3 ? `${s.disc_n} solo discussions · ${s.disc_w} words · ${s.hedge} hedges / 1k · ${s.sent} words / sentence` : `${s.disc_n} solo discussion${s.disc_n === 1 ? '' : 's'}`; },
    });
  }

  // ---- search ----------------------------------------------------------------
  const SEARCH = { secs: new Set(['chg', 'key', 'disc', 'avn', 'mar', 'tide', 'clim', 'fire']), q: '' };
  async function loadText() {
    if (TEXT) return TEXT;
    $('q-note').textContent = 'loading corpus (4 MB)…';
    $('q-btn').disabled = true;
    try {
      const r = await fetch('data/afd-text.json', { cache: 'force-cache' });
      if (!r.ok) throw new Error(r.status);
      TEXT = await r.json();
    } catch (e) {
      $('q-note').textContent = `corpus failed to load (${e.message})`;
    }
    $('q-btn').disabled = false;
    return TEXT;
  }
  function sentencesOf(s) { return s.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+(?=[A-Z(])/); }
  async function search(q) {
    q = (q || '').trim();
    SEARCH.q = q;
    if (!q) { $('q-hits').innerHTML = ''; $('q-strip').innerHTML = ''; $('q-note').textContent = ''; return; }
    const text = await loadText();
    if (!text) return;
    let rx;
    try { rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'); } catch (e) { return; }
    const perDay = {}, hits = [];
    let issN = 0, hitN = 0;
    text.forEach((iss) => {
      let any = false;
      Object.entries(iss.s).forEach(([sec, body]) => {
        if (!SEARCH.secs.has(sec)) return;
        sentencesOf(body).forEach((sen) => {
          rx.lastIndex = 0;
          const m = sen.match(rx);
          if (!m) return;
          any = true; hitN += m.length;
          if (hits.length < 300) hits.push({ t: iss.t, p: iss.p, sec, sen });
        });
      });
      if (any) { issN++; const d = ymdOf(iss.t); perDay[d] = (perDay[d] || 0) + 1; }
    });
    history.replaceState(null, '', '#q=' + encodeURIComponent(q));
    $('q-note').textContent = hitN ? `${num(hitN)} hits in ${num(issN)} of ${num(text.length)} issuances${hits.length === 300 ? ' · first 300 shown' : ''}` : 'no hits';
    const mx = Math.max(1, ...Object.values(perDay));
    strip($('q-strip'), {
      rows: ['issuances'], cols: DAYS, rowH: 18, labelW: 80,
      rowLabel: () => 'per day', rowMax: () => mx, val: (r, c) => (D.days[c] ? (perDay[c] || 0) : null),
      tip: (r, c) => `<b>${esc(dateLabel(c))}</b> · ${perDay[c] || 0} issuance${perDay[c] === 1 ? '' : 's'} mention “${esc(q)}”`,
      click: (c) => { if (D.days[c]) location.href = almanac(c); },
    });
    $('q-hits').innerHTML = hits.map((h) =>
      `<div class="hit"><span class="m"><a href="${almanac(ymdOf(h.t))}">${esc(fmtDT(h.t))}</a> · ${esc(SEC_NAMES[h.sec] || h.sec)} · <a href="${ghFile(h.p)}">file</a></span>${esc(h.sen).replace(rx, (m) => `<mark>${m}</mark>`)}</div>`).join('');
  }
  function renderSearch() {
    const secs = Object.keys(SEC_NAMES);
    function chips() {
      $('q-chips').innerHTML = '<span class="lbl">in</span>' + secs.map((k) => `<button class="chip${SEARCH.secs.has(k) ? ' on' : ''}" data-k="${k}">${esc(SEC_NAMES[k])}</button>`).join('');
      $('q-chips').querySelectorAll('.chip').forEach((b) => {
        b.onclick = () => { const k = b.dataset.k; if (SEARCH.secs.has(k)) SEARCH.secs.delete(k); else SEARCH.secs.add(k); chips(); if (SEARCH.q) search(SEARCH.q); };
      });
    }
    chips();
    $('q-btn').onclick = () => search($('q').value);
    $('q').addEventListener('keydown', (e) => { if (e.key === 'Enter') search($('q').value); });
    const m = location.hash.match(/[#&]q=([^&]+)/);
    if (m) { $('q').value = decodeURIComponent(m[1]); search($('q').value); }
  }

  // ---- boot ------------------------------------------------------------------
  async function boot() {
    try {
      const r = await fetch('data/afd.json', { cache: 'no-cache' });
      if (!r.ok) throw new Error(`afd.json ${r.status}`);
      D = await r.json();
    } catch (e) {
      $('stats').textContent = 'no data';
      $('err').style.display = 'block'; $('err').textContent = String(e.message || e);
      return;
    }
    DAYS = dayRange(D.first, D.last);
    renderStats(); renderThemes(); renderThreads(); renderVolume(); renderHedge();
    renderModels(); renderWwa(); renderAvn(); renderTerms(); renderTemps(); renderLists(); renderSearch();
    let rt;
    window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => drawers.forEach((f) => f()), 120); });
  }
  window.AFD_DEBUG = { get data() { return D; }, search };
  boot();
})();
