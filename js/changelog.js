// Site changelog — renders the repo's commit history from the GitHub API
// (CORS-open, no auth; ~60 requests/hr/IP which is plenty for a page view).
// Filters the traffic-data snapshot branch noise by only querying main, and
// hides the automated data drops that land on main itself (the hourly
// wx-archive commits, backfills, transcript drops) — their health is what the
// panels beside this list show instead (js/data-health.js).

(() => {
  'use strict';

  const REPO = 'nuvig/nuvig.github.io';
  const PER_PAGE = 60;
  // A page of 60 commits is mostly data drops (~24/day), so one fetch can
  // yield only a handful of visible entries. Each load chains extra pages
  // until this many entries rendered — capped so a click never spends more
  // than a few of the hourly rate-limit budget.
  const MIN_SHOWN = 15;
  const MAX_FETCHES = 3;
  let page = 1;
  let hidden = 0;

  // Automated data commits, by message and by bot author. New bot streams
  // (they commit as *[bot]) hide themselves without a new pattern here.
  const DATA_DROP = /^(wx: (archive|backfill)\b|ctaf: transcripts\b)/;
  const isDataDrop = c => DATA_DROP.test(c.commit.message) ||
    /\[bot\]$/.test((c.commit.author || {}).name || '');

  const $ = id => document.getElementById(id);
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const dayLabel = iso => new Date(iso).toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  let lastDay = '';

  function render(commits) {
    const list = $('cl-list');
    let shown = 0;
    for (const c of commits) {
      if (isDataDrop(c)) { hidden++; continue; }
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
      shown++;
    }
    if (hidden) {
      $('cl-hidden').textContent =
        `${hidden.toLocaleString()} automated data commits hidden — the data health panels cover those.`;
    }
    return shown;
  }

  async function loadPage() {
    $('cl-status').textContent = 'loading…';
    $('cl-more').style.display = 'none';
    try {
      let shown = 0, full = true;
      for (let i = 0; i < MAX_FETCHES && shown < MIN_SHOWN && full; i++) {
        const r = await fetch(`https://api.github.com/repos/${REPO}/commits` +
          `?sha=main&per_page=${PER_PAGE}&page=${page}`);
        if (!r.ok) throw new Error(r.status === 403
          ? 'GitHub API rate limit hit — try again in a bit'
          : 'GitHub API error ' + r.status);
        const commits = await r.json();
        shown += render(commits);
        full = commits.length === PER_PAGE;
        if (full) page++;
      }
      $('cl-status').textContent = '';
      if (full) $('cl-more').style.display = '';
    } catch (e) {
      $('cl-status').textContent = e.message;
    }
  }

  $('cl-more').addEventListener('click', loadPage);
  loadPage();
})();
