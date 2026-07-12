// Homepage extras: live card teasers, email copy button, and lazy-loading
// the ball-physics sim so its 13 KB only loads when the toggle is clicked.

// --- Lazy sim loader -------------------------------------------------------
// sim.js binds its own click handler to the toggle on load; this stub loads
// it on the first click, then re-clicks so the sim opens immediately.
(() => {
  const btn = document.getElementById('sim-toggle-btn');
  if (!btn) return;
  let loading = false;
  btn.addEventListener('click', function once() {
    if (loading) return;
    loading = true;
    btn.removeEventListener('click', once);
    const s = document.createElement('script');
    s.src = 'js/sim.js?v=2';
    s.onload = () => btn.click();
    document.body.appendChild(s);
  });
})();

// --- Reveal + copy email ----------------------------------------------------
// The address stays out of the initial view; "Email me" swaps itself for the
// mailto link and copy button.
(() => {
  const show = document.getElementById('show-email');
  const btn = document.getElementById('copy-email');
  const addr = document.getElementById('email-addr');
  if (!show || !btn || !addr) return;
  show.addEventListener('click', () => {
    show.hidden = true;
    addr.hidden = false;
    btn.hidden = false;
  });
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(addr.textContent.trim());
      btn.textContent = 'Copied ✓';
    } catch {
      btn.textContent = 'Select it →';
    }
    setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
  });
})();

// --- Live teasers (fail silently: cards read fine without them) ------------

// Tracker: aircraft seen today, from the Pi exporter's GitHub snapshot summary
(async () => {
  const el = document.getElementById('tracker-teaser');
  if (!el) return;
  try {
    const res = await fetch(
      'https://raw.githubusercontent.com/nuvig/nuvig.github.io/traffic-data/v2/summary.json',
      { cache: 'no-cache' });
    if (!res.ok) return;
    const sum = await res.json();
    const p = n => String(n).padStart(2, '0');
    const d = new Date();
    const today = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    const day = sum.days.find(x => x.date === today) || sum.days[sum.days.length - 1];
    if (!day) return;
    const label = day.date === today ? 'today' : `on ${day.date}`;
    el.textContent = `● ${day.aircraft.toLocaleString()} aircraft seen ${label}`;
    el.hidden = false;
  } catch { /* teaser is optional */ }
})();

// Weather: current wind + temp at KNAK (nearest sensor to KANP, ~3 NM NE).
// Wind comes from the raw METAR text; aviationweather.gov has no CORS so
// this must stay on api.weather.gov.
(async () => {
  const el = document.getElementById('weather-teaser');
  if (!el) return;
  try {
    const res = await fetch(
      'https://api.weather.gov/stations/KNAK/observations/latest',
      { headers: { Accept: 'application/geo+json' } });
    if (!res.ok) return;
    const obs = (await res.json()).properties;
    const m = /(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?KT/.exec(obs.rawMessage || '');
    const parts = [];
    if (m) {
      const dir = m[1], spd = parseInt(m[2], 10), gst = m[3];
      parts.push(spd === 0 ? 'wind calm'
        : `wind ${dir === 'VRB' ? 'variable' : dir + '°'} at ${spd} kt` +
          (gst ? ` G${parseInt(gst, 10)}` : ''));
    }
    if (obs.temperature && obs.temperature.value != null) {
      parts.push(`${Math.round(obs.temperature.value * 9 / 5 + 32)}°F`);
    }
    if (!parts.length) return;
    el.textContent = `● KNAK now: ${parts.join(' · ')}`;
    el.hidden = false;
  } catch { /* teaser is optional */ }
})();
