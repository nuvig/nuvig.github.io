// KANP Flight Tracker — Notables tab
// The tracks worth a look, newest first: VIP callsigns, foreign military,
// rare military types, warbirds, one-airframe types, visitors at Lee, and
// big aircraft low near the field. Reads notables.json on the notables-data
// branch (scripts/build_notables.py compiles it hourly from the Pi's day
// snapshots — the rules live there). Times are the field's zone.

const KANPNotables = (() => {
  const KINDS = [
    ['All', ''], ['VIP', 'vip'], ['Foreign military', 'state'], ['Military', 'mil'],
    ['Warbirds', 'warbird'], ['Rare types', 'rare'], ['Lee', 'lee'], ['Low', 'low'],
  ];
  const KIND_TITLE = {
    vip: 'AF1 / AF2 / EXEC1F / EXEC2F, VC-25, E-4B',
    state: 'military aircraft with a non-US ICAO address',
    mil: 'B-1, B-52, RC-135, E-3, E-6B, fighters, Mi-17, AH-64 …',
    rare: 'only one airframe of the type in the archive',
    lee: 'field contact: helicopter, military, or first visit',
    low: 'airliner or large military aircraft below 2,000 ft within 2 nm, no field contact',
  };
  const NEAR = [['Any', 0], ['20 nm', 20], ['5 nm', 5], ['1 nm', 1]];
  const RANGES = [['7 d', 7], ['30 d', 30], ['All', 0]];
  const PAGE = 150;
  const WHY = { new: 'first visit', heli: 'helicopter', mil: 'military',
                'heli new': 'helicopter · first visit', 'mil new': 'military · first visit' };

  const S = { kind: '', near: 0, range: 0, shown: PAGE };
  let D = null, loading = false;
  const $ = id => document.getElementById(id);
  const DEFAULT_BASE = 'https://raw.githubusercontent.com/nuvig/nuvig.github.io/notables-data';
  const base = () => localStorage.getItem('kanp_notables_base')
    || (SITE.tracker && SITE.tracker.notablesBase) || DEFAULT_BASE;
  const TZ = (SITE.weather && SITE.weather.timeZone) || 'America/New_York';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmtTime = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
  const fmtDay = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric' });
  const fmtKey = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
  const ft = a => a == null ? '' : `${Math.round(a).toLocaleString()} ft`;

  function init() {
    const btn = document.querySelector('.tab-btn[data-tab="tab-notables"]');
    if (!btn) return;
    btn.addEventListener('click', () => { if (!D) load(); });
    chips('nb-near', NEAR, 'near');
    chips('nb-range', RANGES, 'range');
    $('nb-more').addEventListener('click', () => { S.shown += PAGE * 2; render(); });
    if ($('tab-notables').classList.contains('active')) load();
  }

  function chips(id, items, key, counts) {
    const row = $(id);
    row.innerHTML = '';
    items.forEach(([label, value]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'qr-chip' + (S[key] === value ? ' on' : '');
      b.textContent = counts && value ? `${label} ${counts[value] || 0}` : label;
      if (key === 'kind' && KIND_TITLE[value]) b.title = KIND_TITLE[value];
      b.addEventListener('click', () => {
        S[key] = value;
        S.shown = PAGE;
        row.querySelectorAll('.qr-chip').forEach(c => c.classList.toggle('on', c === b));
        render();
      });
      row.appendChild(b);
    });
  }

  async function load() {
    if (loading) return;
    loading = true;
    const res = $('nb-result');
    res.className = 'result-line loading';
    res.textContent = 'Loading…';
    try {
      const r = await fetch(`${base()}/notables.json`, { cache: 'no-cache' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      D = await r.json();
      render();
    } catch (e) {
      res.className = 'result-line';
      res.innerHTML = `<span class="err">notables.json: ${esc(e.message)}</span>`;
    } finally {
      loading = false;
    }
  }

  function filtered(ignoreKind) {
    const cut = S.range ? Date.now() / 1000 - S.range * 86400 : 0;
    return D.ev.filter(e => e.ts >= cut
      && (!S.near || e.d <= S.near)
      && (ignoreKind || !S.kind || e.k.includes(S.kind)));
  }

  function tags(e) {
    const out = [];
    for (const k of e.k) {
      if (k === 'vip') out.push(['vip', e.lbl || 'VIP']);
      else if (k === 'state') out.push(['', e.cty]);
      else if (k === 'mil') out.push(['', 'military']);
      else if (k === 'warbird') out.push(['', 'warbird']);
      else if (k === 'rare') out.push(['', 'rare type']);
      else if (k === 'lee') out.push(['lee', `Lee · ${WHY[e.why] || 'field'}`]);
      else if (k === 'low') out.push(['', `low ${ft(e.la)}`]);
    }
    return out.map(([c, t]) => `<span class="nb-tag ${c}">${esc(t)}</span>`).join('');
  }

  function closest(e) {
    if (e.g) return `${e.d.toFixed(1)} nm · ground`;
    const a = ft(e.a);
    return `${e.d.toFixed(1)} nm${a ? ' · ' + a : ''}`;
  }

  function trace(e) {
    const d = new Date(e.ts * 1000).toISOString().slice(0, 10);
    return `https://globe.adsbexchange.com/?icao=${encodeURIComponent(e.h)}&showTrace=${d}`;
  }

  function render() {
    if (!D) return;
    chips('nb-kind', KINDS, 'kind', countBy(filtered(true)));
    const ev = filtered(false);
    const res = $('nb-result');
    res.className = 'result-line done';
    const days = D.days || [];
    res.textContent = `${ev.length.toLocaleString()} tracks · ${days.length} days`
      + (days.length ? ` · ${days[0]} → ${days[days.length - 1]}` : '');
    const show = ev.slice(0, S.shown);
    const groups = new Map();
    for (const e of show) {
      const k = fmtKey.format(new Date(e.ts * 1000));
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(e);
    }
    let html = '';
    for (const [, list] of groups) {
      html += `<div class="nb-day">${esc(fmtDay.format(new Date(list[0].ts * 1000)))}`
        + `<span class="sub">${list.length}</span></div>`
        + '<div class="card" style="overflow-x:auto;padding:6px 8px"><table class="ac-table">'
        + '<colgroup><col style="width:72px"><col style="width:88px"><col style="width:52px">'
        + '<col style="width:190px"><col style="width:132px"><col style="width:76px"><col style="width:40px"></colgroup><tbody>';
      for (const e of list) {
        html += '<tr>'
          + `<td>${esc(fmtTime.format(new Date(e.ts * 1000)))}</td>`
          + `<td class="nb-cs">${esc(e.c || '—')}</td>`
          + `<td title="${esc(e.n)}">${esc(e.t)}</td>`
          + `<td>${tags(e)}</td>`
          + `<td class="${e.d <= 2 ? 'nb-near' : ''}">${closest(e)}</td>`
          + `<td>${esc(e.r)}</td>`
          + `<td><a href="${trace(e)}" target="_blank" rel="noopener" title="ADS-B Exchange trace">trace</a></td>`
          + '</tr>';
      }
      html += '</tbody></table></div>';
    }
    $('nb-list').innerHTML = html;
    $('nb-more').style.display = ev.length > S.shown ? '' : 'none';
  }

  function countBy(ev) {
    const c = {};
    for (const e of ev) for (const k of e.k) c[k] = (c[k] || 0) + 1;
    return c;
  }

  document.addEventListener('DOMContentLoaded', init);
  return { init, _data: () => D };
})();
