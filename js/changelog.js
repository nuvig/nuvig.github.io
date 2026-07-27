// Site changelog — renders the repo's commit history from the GitHub API
// (CORS-open, no auth; ~60 requests/hr/IP which is plenty for a page view).
// Filters the traffic-data snapshot branch noise by only querying main.

(() => {
  'use strict';

  const REPO = 'nuvig/nuvig.github.io';
  const PER_PAGE = 60;
  let page = 1;

  const $ = id => document.getElementById(id);
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const dayLabel = iso => new Date(iso).toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  let lastDay = '';

  function render(commits) {
    const list = $('cl-list');
    for (const c of commits) {
      const lines = c.commit.message.split('\n');
      const title = lines[0];
      // drop trailer lines (Co-Authored-By etc.) from the body
      const body = lines.slice(1).filter(l => !/^\s*[A-Za-z-]+:\s/.test(l))
        .join('\n').trim();
      const day = dayLabel(c.commit.author.date);
      if (day !== lastDay) {
        lastDay = day;
        const h = document.createElement('div');
        h.className = 'day'; h.textContent = day;
        list.appendChild(h);
      }
      const el = document.createElement('div');
      el.className = 'entry';
      el.innerHTML = `<div class="msg">${esc(title)}</div>` +
        (body ? `<div class="body">${esc(body)}</div>` : '') +
        `<div class="meta"><a href="${c.html_url}" target="_blank" rel="noopener">` +
        `${c.sha.slice(0, 7)}</a></div>`;
      list.appendChild(el);
    }
  }

  async function loadPage() {
    $('cl-status').textContent = 'loading…';
    $('cl-more').style.display = 'none';
    try {
      const r = await fetch(`https://api.github.com/repos/${REPO}/commits` +
        `?sha=main&per_page=${PER_PAGE}&page=${page}`);
      if (!r.ok) throw new Error(r.status === 403
        ? 'GitHub API rate limit hit — try again in a bit'
        : 'GitHub API error ' + r.status);
      const commits = await r.json();
      render(commits);
      $('cl-status').textContent = '';
      if (commits.length === PER_PAGE) {
        page++;
        $('cl-more').style.display = '';
      }
    } catch (e) {
      $('cl-status').textContent = e.message;
    }
  }

  $('cl-more').addEventListener('click', loadPage);
  loadPage();
})();
