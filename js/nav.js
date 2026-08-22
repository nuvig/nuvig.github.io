/* nav.js — shared site navigation bar.
   Self-contained: injects its own <style> and markup, no dependency on
   main.css (works on wide app pages too). Include as the FIRST script
   inside <body> so the bar exists before first paint:

     <script src="js/nav.js?v=1"></script>

   Deliberately NOT used by the self-contained toys/experiments
   (bubbles, glow, ctaf, scanner, mural, fugue, sky2, watercycle) —
   those stay standalone and unlinked.

   The TOOLS list mirrors tools.html's categories — when a tool is added
   there, add it here too (same drill as sitemap.xml). */
(function () {
  'use strict';

  var ACCENT = '#4a9eff';

  /* Primary links (besides the brand, which is Home). */
  var LINKS = [
    ['/kanp.html', 'Tracker'],
    ['/weather.html', 'Weather']
  ];

  /* Tools dropdown — categories and hues mirror tools.html. */
  var TOOLS = [
    { cat: 'Weather', hue: '#38bdf8', items: [
      ['/discussion.html', '🌀', 'DC Forecast Discussion'],
      ['/skew-t.html', '🌡', 'Skew-T Explorer'],
      ['/sky.html', '🌤', 'METAR Sky'],
      ['/almanac.html', '📚', 'Weather Almanac']
    ]},
    { cat: 'Atmosphere &amp; Performance', hue: '#fbbf24', items: [
      ['/airlab.html', '🎈', 'Air Lab']
    ]},
    { cat: 'Cockpit &amp; Procedures', hue: '#a78bfa', items: [
      ['/procedures.html', '🛫', 'Procedure Explorer']
    ]},
    { cat: 'Study &amp; Reference', hue: '#34d399', items: [
      ['/knowledge.html', '🧭', 'Aviation Knowledge Map']
    ]}
  ];

  var css = [
    /* The negative side margins bleed the bar to the viewport edges even on
       pages whose <body> is a centered max-width column; on full-width app
       pages (knowledge) they compute to 0. flex:none keeps flex-column
       bodies from squashing the bar. 50vw includes the scrollbar, so the
       bleed overshoots by half a scrollbar per side — clip it at the root
       (clip, not hidden: hidden makes html a scroll container and kills
       position:sticky). */
    'html{overflow-x:clip}',
    /* z-index sits above Leaflet's controls (1000) but below the pages' true
       fullscreen overlays (kanp 2000+, procedures 1300/4000). The homepage
       sim overlay is only 1000, so hide the bar while it's open. */
    'body.sim-open #site-nav{display:none}',
    '#site-nav{position:sticky;top:0;z-index:1050;flex:0 0 auto;',
    ' margin:0 calc(50% - 50vw);background:rgba(17,17,17,.92);',
    ' backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);',
    ' border-bottom:1px solid #26262a;font-size:14px;line-height:1.4;',
    " font-family:'Segoe UI',system-ui,Arial,sans-serif}",
    '#site-nav .nv-in{max-width:1100px;margin:0 auto;padding:0 18px;height:46px;',
    ' display:flex;align-items:center}',
    '#site-nav a{text-decoration:none}',
    '#site-nav .nv-brand{display:flex;align-items:center;gap:8px;color:#e5e5e5;',
    ' font-weight:600;white-space:nowrap;letter-spacing:-0.01em}',
    '#site-nav .nv-brand .nv-plane{color:' + ACCENT + '}',
    '#site-nav .nv-brand:hover{color:#fff}',
    '#site-nav .nv-links{display:flex;align-items:stretch;margin-left:auto;height:46px}',
    '#site-nav .nv-links>a,#site-nav .nv-dd-btn{position:relative;display:flex;',
    ' align-items:center;gap:5px;padding:0 13px;color:#9aa3ad;background:none;',
    ' border:0;font:inherit;cursor:pointer}',
    '#site-nav .nv-links>a:hover,#site-nav .nv-dd-btn:hover{color:#e8e8e8}',
    '#site-nav .nv-links>a.nv-cur,#site-nav .nv-dd-btn.nv-cur{color:#e8e8e8}',
    '#site-nav .nv-links>a.nv-cur::before,#site-nav .nv-dd-btn.nv-cur::before{',
    ' content:"";position:absolute;left:11px;right:11px;bottom:0;height:2px;',
    ' border-radius:2px 2px 0 0;background:' + ACCENT + '}',
    '#site-nav .nv-caret{font-size:9px;transition:transform .15s;color:#6b7280}',
    '#site-nav .nv-dd{position:relative;display:flex;align-items:stretch}',
    '#site-nav .nv-dd.open .nv-caret{transform:rotate(180deg)}',
    /* Tools panel (desktop) */
    '#site-nav .nv-panel{display:none;position:absolute;top:calc(100% + 1px);right:0;',
    ' width:560px;max-width:calc(100vw - 24px);padding:14px 16px 12px;',
    ' background:#16181c;border:1px solid #2a2d33;border-top:0;',
    ' border-radius:0 0 12px 12px;box-shadow:0 14px 34px rgba(0,0,0,.6);',
    ' grid-template-columns:1fr 1fr;gap:2px 18px}',
    '#site-nav .nv-dd.open .nv-panel{display:grid}',
    '#site-nav .nv-cat{padding:6px 0 8px}',
    '#site-nav .nv-cat h3{display:flex;align-items:center;gap:8px;margin:0 0 5px;',
    ' font-size:10.5px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;',
    ' color:#c8ccd2}',
    '#site-nav .nv-cat h3::before{content:"";width:8px;height:8px;border-radius:50%;',
    ' background:var(--nv-hue);box-shadow:0 0 8px var(--nv-hue);flex:none}',
    '#site-nav .nv-cat a{display:flex;align-items:baseline;gap:9px;padding:5px 8px;',
    ' margin:0 -8px;border-radius:7px;color:#b6bcc4}',
    '#site-nav .nv-cat a:hover{background:#20242b;color:#fff}',
    '#site-nav .nv-cat a.nv-cur{color:' + ACCENT + '}',
    '#site-nav .nv-cat .nv-emoji{flex:none;width:20px;text-align:center}',
    '#site-nav .nv-all{grid-column:1/-1;margin:2px -8px 0;padding:9px 8px 4px;',
    ' border-top:1px solid #24272c;color:' + ACCENT + ';font-weight:600;',
    ' border-radius:7px}',
    '#site-nav .nv-all:hover{color:#7ab8ff}',
    /* Hamburger + mobile menu */
    '#site-nav .nv-burger{display:none;margin-left:auto;background:none;',
    ' border:1px solid #2a2d33;border-radius:8px;color:#cfd4da;width:38px;height:32px;',
    ' font-size:16px;line-height:1;cursor:pointer;align-items:center;justify-content:center}',
    '#site-nav .nv-burger:hover{border-color:#3a3f47;color:#fff}',
    '#site-nav .nv-mob{display:none;border-top:1px solid #202329;background:#141519;',
    ' padding:8px 18px 16px;max-height:calc(100vh - 46px);overflow:auto}',
    '#site-nav.open .nv-mob{display:block}',
    '#site-nav .nv-mob>a{display:flex;align-items:baseline;gap:10px;padding:9px 8px;',
    ' margin:0 -8px;border-radius:8px;color:#c3c9d1;font-weight:600}',
    '#site-nav .nv-mob>a:hover{background:#1f232a}',
    '#site-nav .nv-mob a.nv-cur{color:' + ACCENT + '}',
    '#site-nav .nv-mob .nv-cat{padding-top:10px}',
    '@media (max-width:760px){#site-nav .nv-links{display:none}',
    ' #site-nav .nv-burger{display:flex}}',
    '@media (prefers-reduced-motion:reduce){#site-nav .nv-caret{transition:none}}'
  ].join('');

  /* --- markup ------------------------------------------------------------ */

  var path = location.pathname.replace(/\/index\.html$/, '/');
  function cur(href) { return path === href ? ' nv-cur' : ''; }

  function toolLinks(indent) {
    return TOOLS.map(function (c) {
      return '<div class="nv-cat" style="--nv-hue:' + c.hue + '"><h3>' + c.cat + '</h3>' +
        c.items.map(function (t) {
          return '<a href="' + t[0] + '" class="' + cur(t[0]).trim() + '">' +
            '<span class="nv-emoji">' + t[1] + '</span>' + t[2] + '</a>';
        }).join('') + '</div>';
    }).join('');
  }

  var onToolPage = path === '/tools.html' || TOOLS.some(function (c) {
    return c.items.some(function (t) { return t[0] === path; });
  });

  var html =
    '<div class="nv-in">' +
      '<a class="nv-brand" href="/"><span class="nv-plane">✈</span> Jesse Levine</a>' +
      '<div class="nv-links">' +
        LINKS.map(function (l) {
          return '<a href="' + l[0] + '" class="' + cur(l[0]).trim() + '">' + l[1] + '</a>';
        }).join('') +
        '<div class="nv-dd">' +
          '<button type="button" class="nv-dd-btn' + (onToolPage ? ' nv-cur' : '') + '"' +
            ' aria-expanded="false" aria-haspopup="true">Tools <span class="nv-caret">▼</span></button>' +
          '<div class="nv-panel">' + toolLinks() +
            '<a class="nv-all" href="/tools.html">Browse all tools →</a>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<button type="button" class="nv-burger" aria-expanded="false" aria-label="Menu">☰</button>' +
    '</div>' +
    '<div class="nv-mob">' +
      '<a href="/" class="' + cur('/').trim() + '">Home</a>' +
      LINKS.map(function (l) {
        return '<a href="' + l[0] + '" class="' + cur(l[0]).trim() + '">' + l[1] + '</a>';
      }).join('') +
      toolLinks() +
      '<a href="/tools.html" class="' + cur('/tools.html').trim() + '">All tools →</a>' +
    '</div>';

  /* --- inject ------------------------------------------------------------ */

  var style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  var nav = document.createElement('nav');
  nav.id = 'site-nav';
  nav.setAttribute('aria-label', 'Site');
  nav.innerHTML = html;
  document.body.insertBefore(nav, document.body.firstChild);

  /* --- behavior ---------------------------------------------------------- */

  var dd = nav.querySelector('.nv-dd');
  var ddBtn = nav.querySelector('.nv-dd-btn');
  var burger = nav.querySelector('.nv-burger');

  function setDd(open) {
    dd.classList.toggle('open', open);
    ddBtn.setAttribute('aria-expanded', String(open));
  }
  function setMob(open) {
    nav.classList.toggle('open', open);
    burger.setAttribute('aria-expanded', String(open));
  }

  ddBtn.addEventListener('click', function () {
    setDd(!dd.classList.contains('open'));
  });
  burger.addEventListener('click', function () {
    setMob(!nav.classList.contains('open'));
  });

  document.addEventListener('click', function (e) {
    if (!dd.contains(e.target)) setDd(false);
    if (nav.classList.contains('open') && !nav.contains(e.target)) setMob(false);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { setDd(false); setMob(false); }
  });
})();
