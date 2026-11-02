// Procedure Explorer — page changelog: the commits on main that touched the
// explorer (page, its two scripts, the data index — so each AIRAC cycle build
// is an entry too). GitHub API, CORS-open like pagever.js / changelog.js; one
// request per path, merged by sha, cached 6 h in localStorage. Fetched only
// when the <details> is first opened, so a visit that never opens it costs no
// API calls.
(() => {
  'use strict';

  const REPO = 'nuvig/nuvig.github.io';
  const PATHS = ['procedures.html', 'js/procedures.js', 'js/procedures-national.js',
    'data/procedures/index.json'];
  const TTL_MS = 6 * 3600 * 1000;
  const KEY = 'proc-changelog';
  const MAX = 40;

  const box = document.getElementById('changelog');
  const list = document.getElementById('cl-list');
  if (!box || !list) return;

  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmtDate = iso => new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric' });
  // "procedures: …" / "Procedure Explorer: …" prefixes are redundant here
  const title = m => m.split('\n')[0].replace(/^procedures?( explorer| 3d)?:\s*/i, '');

  function render(items) {
    list.innerHTML = items.length ? items.map(c =>
      `<div class="cl-row"><span class="cl-date">${fmtDate(c.d)}</span>` +
      `<a href="https://github.com/${REPO}/commit/${c.sha}" target="_blank" rel="noopener">${esc(c.m)}</a></div>`
    ).join('') : '<div class="cl-row">none</div>';
  }

  async function load() {
    try {
      const c = JSON.parse(localStorage.getItem(KEY));
      if (c && Date.now() - c.ts < TTL_MS) { render(c.items); return; }
    } catch (e) { /* fall through to fetch */ }
    list.textContent = 'loading…';
    try {
      const pages = await Promise.all(PATHS.map(p =>
        fetch(`https://api.github.com/repos/${REPO}/commits?sha=main&per_page=30&path=${encodeURIComponent(p)}`)
          .then(r => r.ok ? r.json() : Promise.reject(new Error(r.status === 403
            ? 'GitHub API rate limit — try again in a bit' : 'GitHub API error ' + r.status)))));
      const by = new Map();
      for (const arr of pages) for (const c of arr) {
        if (!by.has(c.sha)) by.set(c.sha, { sha: c.sha, d: c.commit.author.date, m: title(c.commit.message) });
      }
      const items = [...by.values()].sort((a, b) => (a.d < b.d) - (a.d > b.d)).slice(0, MAX);
      try { localStorage.setItem(KEY, JSON.stringify({ ts: Date.now(), items })); } catch (e) { /* quota */ }
      render(items);
    } catch (e) {
      list.textContent = e.message;
    }
  }

  box.addEventListener('toggle', () => {
    if (box.open && !box.dataset.loaded) { box.dataset.loaded = '1'; load(); }
  });
})();
