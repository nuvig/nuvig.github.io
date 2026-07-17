// ATC transcript viewer (atc.html). Talks only to the Pi API — the audio and
// transcripts are LAN-only personal recordings (LiveATC ToS: no republishing),
// so unlike the tracker there is no GitHub-snapshot fallback here.
//
// Pi API base: same localStorage key the tracker uses (kanp_api_base), same
// same-origin autodetect when the page is served by the Pi itself.

(function () {
  'use strict';

  const API_KEY = `${SITE.tracker.storagePrefix}_api_base`;

  const els = {
    day: document.getElementById('day-select'),
    chips: document.getElementById('feed-chips'),
    search: document.getElementById('search'),
    status: document.getElementById('status-line'),
    list: document.getElementById('tx-list'),
    player: document.getElementById('player'),
    now: document.getElementById('now-playing'),
    autoplay: document.getElementById('autoplay'),
    live: document.getElementById('live'),
  };

  let feeds = [];              // [{mount,label,freq}]
  let feedOn = {};             // mount -> bool
  let all = [];                // transmissions for the loaded day
  let shown = [];              // filtered view, newest first
  let selIdx = -1;
  let selClip = null;          // clip id of the selection (survives re-render)
  let newestTs = 0;            // latest transmission we've seen this day
  let latestDay = null;        // most recent day the Pi has (live-poll target)
  const REFRESH_MS = 15000;

  function apiBase() {
    const saved = localStorage.getItem(API_KEY);
    if (saved && saved !== 'none') return saved.replace(/\/+$/, '');
    if (location.protocol === 'http:' && location.port) return location.origin;
    return null;
  }

  async function api(path, params) {
    const base = apiBase();
    if (!base) throw new Error('no Pi API configured');
    const url = new URL(base + path);
    Object.entries(params || {}).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    });
    const res = await fetch(url);
    if (!res.ok) throw new Error(`API ${res.status}`);
    return res.json();
  }

  function setStatus(msg, isErr) {
    els.status.textContent = '';
    els.status.className = isErr ? 'err' : '';
    if (typeof msg === 'string') els.status.textContent = msg;
    else els.status.appendChild(msg);
  }

  function noApiMessage() {
    const span = document.createElement('span');
    span.append('Pi not reachable. This page needs the Pi API on your LAN ' +
      '(recordings never leave the house). Set the API base: ');
    const a = document.createElement('a');
    a.textContent = 'enter Pi address';
    a.onclick = () => {
      const cur = localStorage.getItem(API_KEY) || 'http://raspberrypi.local:8787';
      const v = prompt('Pi API base URL (http://<pi-ip>:8787)', cur);
      if (v) { localStorage.setItem(API_KEY, v.trim()); init(); }
    };
    span.appendChild(a);
    return span;
  }

  const feedByMount = m => feeds.find(f => f.mount === m) || { label: m, freq: '' };

  // Deterministic per-feed hue so rows are scannable by frequency.
  const FEED_COLORS = ['#4a9eff', '#a3be8c', '#d08770', '#b48ead', '#ebcb8b'];
  const feedColor = m => FEED_COLORS[feeds.findIndex(f => f.mount === m) % FEED_COLORS.length];

  function fmtTime(ts) {
    return new Date(ts * 1000).toLocaleTimeString('en-US',
      { hour12: false, timeZone: SITE.weather.timeZone });
  }

  function render() {
    const q = els.search.value.trim().toLowerCase();
    // newest transmission at the top
    shown = all.filter(t => feedOn[t.mount] !== false &&
      (!q || (t.text || '').toLowerCase().includes(q))).reverse();
    els.list.textContent = '';
    const frag = document.createDocumentFragment();
    shown.forEach((t, i) => {
      const row = document.createElement('div');
      row.className = 'tx';
      row.dataset.i = i;

      const time = document.createElement('span');
      time.className = 'time';
      time.textContent = fmtTime(t.ts);

      const feed = document.createElement('span');
      feed.className = 'feed';
      const f = feedByMount(t.mount);
      feed.textContent = f.freq || f.label;
      feed.style.color = feedColor(t.mount);

      const dur = document.createElement('span');
      dur.className = 'dur';
      dur.textContent = `${Math.round(t.dur)}s`;

      const text = document.createElement('span');
      text.className = 'text' + (t.text ? '' : ' empty');
      text.textContent = t.text || '(no transcript)';

      row.append(time, feed, dur, text);
      row.onclick = () => select(i, true);
      frag.appendChild(row);
    });
    els.list.appendChild(frag);
    // restore the selection — indices shift when new rows land on top
    selIdx = selClip ? shown.findIndex(t => t.clip === selClip) : -1;
    if (selIdx >= 0) els.list.children[selIdx].classList.add('sel');
    else selClip = null;
    setStatus(`${shown.length} of ${all.length} transmissions` +
      (q ? ` matching “${els.search.value.trim()}”` : ''));
  }

  function select(i, play) {
    if (i < 0 || i >= shown.length) return;
    const rows = els.list.children;
    if (selIdx >= 0 && rows[selIdx]) rows[selIdx].classList.remove('sel');
    selIdx = i;
    selClip = shown[i].clip;
    rows[i].classList.add('sel');
    rows[i].scrollIntoView({ block: 'nearest' });
    const t = shown[i];
    const f = feedByMount(t.mount);
    els.now.textContent = `${fmtTime(t.ts)} · ${f.label}${f.freq ? ' ' + f.freq : ''}`;
    if (play) {
      els.player.src = `${apiBase()}/api/atc/clip?f=${encodeURIComponent(t.clip)}`;
      els.player.play().catch(() => {});
    }
  }

  els.player.addEventListener('ended', () => {
    // auto-advance plays chronologically — upward, since newest is on top;
    // reaching the top hands control back to live mode
    if (els.autoplay.checked && selIdx > 0) select(selIdx - 1, true);
  });

  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.key === 'j') select(selIdx + 1, true);
    else if (e.key === 'k') select(selIdx - 1, true);
    else if (e.key === ' ') {
      e.preventDefault();
      if (els.player.src) els.player.paused ? els.player.play() : els.player.pause();
      else select(0, true);
    }
  });

  async function loadDay(day) {
    setStatus('loading ' + day + '…');
    selClip = null;
    try {
      const d = await api('/api/atc/log', { day });
      all = d.transmissions;
      newestTs = all.length ? all[all.length - 1].ts : 0;
      render();
    } catch (e) {
      setStatus('failed to load ' + day + ': ' + e.message, true);
    }
  }

  // Live mode: poll today's log; new transmissions land on top and play as
  // they arrive — but never interrupt, and never while the user is working
  // back through older rows (they rejoin the live edge via auto-advance).
  async function refresh() {
    // no document.hidden check — live mode should keep playing new
    // transmissions while the tab is in the background (scanner style)
    if (!els.live.checked || els.day.value !== latestDay) return;
    let d;
    try {
      d = await api('/api/atc/log', { day: latestDay });
    } catch (e) { return; }
    if (d.transmissions.length === all.length) return;
    all = d.transmissions;
    render();
    const fresh = all.filter(t => t.ts > newestTs);
    if (!fresh.length) return;
    newestTs = Math.max(newestTs, ...fresh.map(t => t.ts));
    // idle (nothing playing) -> start with the oldest new arrival that
    // passes the filters; the 'ended' handler walks upward through the rest
    if (els.player.paused || els.player.ended || !els.player.src) {
      const visible = shown.filter(t => fresh.includes(t));
      const i = shown.indexOf(visible[visible.length - 1]);
      if (i >= 0) select(i, true);
    }
  }

  function buildChips() {
    els.chips.textContent = '';
    feeds.forEach(f => {
      const b = document.createElement('button');
      b.className = 'chip' + (feedOn[f.mount] !== false ? ' on' : '');
      b.append(f.label);
      if (f.freq) {
        const s = document.createElement('span');
        s.className = 'freq';
        s.textContent = f.freq;
        b.appendChild(s);
      }
      b.onclick = () => {
        feedOn[f.mount] = feedOn[f.mount] === false;
        b.classList.toggle('on');
        render();
      };
      els.chips.appendChild(b);
    });
  }

  async function init() {
    let status;
    try {
      status = await api('/api/atc/status');
    } catch (e) {
      setStatus(noApiMessage(), true);
      return;
    }
    if (!status.available) {
      setStatus(status.error || 'no ATC data yet', true);
      return;
    }
    feeds = status.feeds;
    buildChips();
    els.day.textContent = '';
    status.days.slice().reverse().forEach(d => {
      const o = document.createElement('option');
      o.value = o.textContent = d;
      els.day.appendChild(o);
    });
    if (!status.days.length) {
      setStatus('recorder is up, but no transmissions captured yet', true);
      return;
    }
    latestDay = status.days[status.days.length - 1];
    els.day.onchange = () => loadDay(els.day.value);
    els.search.oninput = render;
    loadDay(els.day.value);
    setInterval(refresh, REFRESH_MS);
  }

  init();
})();
