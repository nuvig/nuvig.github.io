// Weather-family cross-links — a one-line strip under each weather page's
// title so the six weather pages link to each other (added at Jesse's
// request 2026-08-29; this is deliberately NOT a site-wide nav bar — see
// CLAUDE.md, and keep it to the weather pages).
//
// One source of truth: add a page here and include this script on it.
// Injection: after <header> when the page has one, otherwise after the
// <h1> and any tagline paragraphs that follow it.
(function () {
  'use strict';
  const PAGES = [
    ['weather.html', 'Weather'],
    ['discussion.html', 'Discussion'],
    ['skew-t.html', 'Skew-T'],
    ['wx3d.html', 'Air Above'],
    ['almanac.html', 'Almanac'],
  ];
  const here = location.pathname.split('/').pop() || 'index.html';
  const nav = document.createElement('nav');
  nav.id = 'wx-nav';
  nav.setAttribute('aria-label', 'weather pages');
  nav.innerHTML = '<span class="lbl">weather:</span>' + PAGES.map(([href, name]) =>
    href === here
      ? `<span class="cur">${name}</span>`
      : `<a href="/${href}">${name}</a>`
  ).join('<span class="sep">·</span>');

  const st = document.createElement('style');
  st.textContent =
    '#wx-nav{display:flex;flex-wrap:wrap;align-items:center;gap:8px;' +
    'margin:2px 0 14px;font-size:12.5px}' +
    '#wx-nav .lbl{color:#556;margin-right:2px}' +
    '#wx-nav a{color:#7da7d9;text-decoration:none}' +
    '#wx-nav a:hover{color:#4a9eff;text-decoration:underline}' +
    '#wx-nav .cur{color:#ccc;font-weight:600}' +
    '#wx-nav .sep{color:#3a3a3a}';
  document.head.appendChild(st);

  const h1 = document.querySelector('h1');
  const header = h1 && h1.closest('header');
  if (header) {
    header.insertAdjacentElement('afterend', nav);
  } else if (h1) {
    let n = h1.nextElementSibling;
    while (n && n.tagName === 'P') n = n.nextElementSibling;
    h1.parentElement.insertBefore(nav, n);
  } else {
    document.body.prepend(nav);
  }
})();
