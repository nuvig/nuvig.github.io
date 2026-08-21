// pagever.js — per-page version badge.
// The version is the page's commit count on main (GitHub API, same CORS-open
// endpoint changelog.js uses), so it increments automatically with every
// deployed change to the page; the date is the page's last commit. Cached in
// localStorage for 6 h to stay far under the 60 req/hr/IP API limit.
// Appended to the end of <body>; on overflow-hidden app pages (knowledge)
// it is simply clipped, by design.

(() => {
  'use strict';

  const REPO = 'nuvig/nuvig.github.io';
  const TTL_MS = 6 * 3600 * 1000;

  let path = location.pathname.replace(/^\//, '');
  if (path === '' || path === '/') path = 'index.html';

  function show(rev, dateIso) {
    const d = new Date(dateIso).toLocaleDateString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric' });
    const el = document.createElement('div');
    el.id = 'page-ver';
    el.style.cssText = 'margin:26px 0 10px;text-align:center;font-size:11.5px;' +
      'color:#5c6470;letter-spacing:.02em';
    el.innerHTML = '<a href="/changelog.html" style="color:inherit;text-decoration:none">' +
      'v' + rev + ' &middot; updated ' + d + '</a>';
    document.body.appendChild(el);
  }

  async function load() {
    const key = 'pagever:' + path;
    try {
      const c = JSON.parse(localStorage.getItem(key));
      if (c && Date.now() - c.ts < TTL_MS) { show(c.rev, c.date); return; }
    } catch (e) { /* fall through to fetch */ }
    try {
      const r = await fetch('https://api.github.com/repos/' + REPO +
        '/commits?sha=main&path=' + encodeURIComponent(path) + '&per_page=1');
      if (!r.ok) return;
      const commits = await r.json();
      if (!commits.length) return;
      const link = r.headers.get('Link');
      const m = link && link.match(/[?&]page=(\d+)>;\s*rel="last"/);
      const rev = m ? +m[1] : commits.length;
      const date = commits[0].commit.author.date;
      try { localStorage.setItem(key, JSON.stringify({ ts: Date.now(), rev, date })); }
      catch (e) { /* quota — badge still shows */ }
      show(rev, date);
    } catch (e) { /* offline / rate-limited — no badge */ }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', load);
  } else load();
})();
