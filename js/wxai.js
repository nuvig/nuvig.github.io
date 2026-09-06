// AI Weather Analysis — sends the site's own archived weather picture (latest.json
// via WXA) to the Claude API straight from the browser and streams the answer.
//
// The API key is the visitor's, held only in localStorage (`anthropic_api_key`),
// same rule as the tracker's RapidAPI key. Nothing here is committed or proxied:
// this repo is public and has no backend, so the request goes browser → api.anthropic.com
// with the `anthropic-dangerous-direct-browser-access` header the API requires for
// CORS. Each run is billed to that key.
//
// Every task shares one context block (the weather picture, built by buildContext())
// marked for prompt caching, so a second button inside five minutes reads the
// context from cache instead of paying for it again.
(function () {
  'use strict';

  const API = 'https://api.anthropic.com/v1/messages';
  const KEY_LS = 'anthropic_api_key';
  const MODEL_LS = 'wxai_model';

  // Price per million tokens: [input, output, cache write (5 min), cache read].
  const MODELS = {
    'claude-opus-5':    { name: 'Opus 5',    price: [5, 25, 6.25, 0.5],  thinking: true,  fallback: true },
    'claude-sonnet-5':  { name: 'Sonnet 5',  price: [2, 10, 2.5, 0.2],   thinking: true },
    'claude-haiku-4-5': { name: 'Haiku 4.5', price: [1, 5, 1.25, 0.1],   thinking: false },
    'claude-fable-5-1': { name: 'Fable 5.1', price: [10, 50, 12.5, 0.25], thinking: 'always', fallback: true },
  };

  const SYSTEM =
    'You are a weather briefer for a flight instructor at ' + SITE.airport.id + ' (' + SITE.airport.name +
    '), a non-towered single-runway field. Runway ' + SITE.airport.runways[0].ends.map(e => e.name).join('/') +
    ', headings ' + SITE.airport.runways[0].ends.map(e => e.hdg + '°').join('/') + ' true, ' +
    SITE.airport.runways[0].len + ' ft, left traffic both ends, touch-and-gos not permitted. ' +
    'The field has no sensor: KNAK (~3 nm NE) is its observation, KDCA verifies the LWX forecast, and the ring ' +
    'stations are the ceiling picture around the field. All directions in the data and in your answer are degrees true. ' +
    'Times in the data are Unix seconds UTC; write times in Eastern local time. ' +
    'Work only from the data given. Say plainly when something is missing, stale, or contradictory between sources. ' +
    'Be terse: short lines, label → value, no preamble, no sign-off, no disclaimers about being an AI.';

  // Each task: label, one-line note, the model it defaults to, effort, and the prompt.
  const TASKS = [
    {
      id: 'brief', label: 'Go / no-go brief', model: 'claude-sonnet-5', effort: 'low',
      note: 'VFR primary lesson, next 6 h',
      prompt: 'Brief the next 6 hours for a VFR primary-training flight in the pattern and local area. ' +
        'Give: verdict (go / marginal / no-go) with the one deciding factor, then runway in use and crosswind, ' +
        'ceiling and visibility trend, density altitude, convective risk, and what to re-check before departure. ' +
        'Under 200 words.',
    },
    {
      id: 'synoptic', label: 'Synoptic analysis', model: 'claude-sonnet-5', effort: 'high',
      note: 'the pattern, the driver, the next 48 h',
      prompt: 'Analyze the weather situation. Identify the synoptic pattern from the surface obs, winds aloft, ' +
        'sounding, model CAPE and the LWX discussion; name the mechanism driving the next 48 hours; ' +
        'lay out the expected sequence hour by hour where it matters and day by day otherwise; ' +
        'state where the sources disagree and which you trust and why. Under 500 words.',
    },
    {
      id: 'overview', label: 'Full air analysis', model: 'claude-sonnet-5', effort: 'xhigh',
      note: 'every source, every layer, no word limit',
      prompt: 'Give a broad, detailed analysis of the whole air column and the whole picture, every source read against every other. ' +
        'Cover in order: (1) surface — each METAR station, what the ring says about cloud layers the field sensor may miss, ' +
        'pressure tendency, temperature/dewpoint spread and fog prospects; (2) the sounding — stability, inversions, LCL, ' +
        'freezing level, CAPE/CIN, moisture depth, what the wind profile says about the pattern; (3) winds aloft by level ' +
        'and hour, shear, and the implications for altitude choice, turbulence and cloud motion; (4) the NWS grid and TAFs ' +
        'hour by hour where they change; (5) the GFS point trends and where they agree or disagree with NWS and the LWX ' +
        'discussion; (6) hazards — AIRMETs, SIGMETs, PIREPs, TFRs, alerts, convection, ice, IFR; (7) the synoptic mechanism ' +
        'and the sequence over the next 48 h, then the outlook through the end of the forecast period; (8) what a CFI ' +
        'should plan around today and tomorrow for VFR primary, IFR training and cross-country work. ' +
        'Be thorough rather than brief; use headings and short lines; quote the specific values you reason from.',
    },
    {
      id: 'critique', label: 'Forecast critique', model: 'claude-sonnet-5', effort: 'high',
      note: 'TAFs vs grid vs GFS vs LWX',
      prompt: 'Critique the forecast. Compare the TAFs, the NWS hourly grid at the field, the GFS point values ' +
        'and the LWX discussion against each other and against the latest observations. ' +
        'Where do they disagree, which is more likely right, and what would a pilot planning tomorrow ' +
        'morning need to watch? Under 400 words.',
    },
    {
      id: 'ifr', label: 'IFR training', model: 'claude-sonnet-5', effort: 'medium',
      note: 'actual IMC prospects, ice, freezing level',
      prompt: 'Assess the next 24 hours for an IFR training flight in a non-deiced piston single ' +
        '(approaches at KESN, KMTN, KBWI, return to ' + SITE.airport.id + ' VFR). Give: usable actual IMC hours if any, ' +
        'freezing level and icing risk by altitude, AIRMETs and PIREPs that matter, convective risk, ' +
        'and the best window. Under 300 words.',
    },
    {
      id: 'xc', label: 'Cross-country', model: 'claude-sonnet-5', effort: 'medium',
      note: 'a 200 nm VFR trip out and back today',
      prompt: 'A student plans a VFR cross-country of about 200 nm out and back from ' + SITE.airport.id +
        ' today, departing in the next 3 hours, about 5 hours total. From the data, which direction has the best ' +
        'weather, what are the go / no-go factors en route, winds aloft for the altitude choice, and the latest ' +
        'return time before conditions turn. Under 300 words.',
    },
    {
      id: 'quick', label: 'Quick look', model: 'claude-haiku-4-5', effort: null,
      note: 'the current ob in three lines',
      prompt: 'In three short lines: the current conditions at the field, the trend over the last few hours, ' +
        'and the one thing to watch today.',
    },
    {
      id: 'ask', label: 'Ask', model: 'claude-sonnet-5', effort: 'medium',
      note: 'your own question against the same data',
      prompt: null,
    },
  ];

  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const key = () => { try { return localStorage.getItem(KEY_LS) || ''; } catch (e) { return ''; } };

  const ET = new Intl.DateTimeFormat('en-US', {
    timeZone: SITE.tz || 'America/New_York', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
  const fmt = t => t ? ET.format(new Date(t * 1000)) : '—';
  const age = t => { const m = Math.round((Date.now() / 1000 - t) / 60); return m < 90 ? m + ' min' : (m / 60).toFixed(1) + ' h'; };

  // ---- the weather picture -------------------------------------------------

  function metarLines(list, n) {
    return (list || []).slice(-n).map(([t, raw]) => raw).join('\n');
  }

  function series(snap, field, n, f) {
    const a = snap[field]; if (!a) return null;
    return a.slice(0, n).map(v => v == null ? '-' : (f ? f(v) : v)).join(' ');
  }

  function buildContext(L) {
    const out = [];
    const nowS = Math.floor(Date.now() / 1000);
    out.push('NOW: ' + fmt(nowS) + ' ET (' + new Date(nowS * 1000).toISOString().slice(0, 16) + 'Z). ' +
      'Archive last run ' + fmt(L.t) + ' (' + age(L.t) + ' ago). Field elevation ' + SITE.airport.elevFt + ' ft.');

    out.push('\n## METARs — field sensor ' + (L.field_station || 'KNAK') + ' (newest last)\n' + metarLines(L.fieldobs, 6));
    out.push('\n## METARs — ' + (L.station || 'KDCA') + ' (newest last)\n' + metarLines(L.obs, 8));
    const ring = Object.entries(L.stations || {}).map(([id, v]) => {
      const m = Array.isArray(v) ? v[v.length - 1] : null; return m ? m[1] : null;
    }).filter(Boolean);
    if (ring.length) out.push('\n## METARs — stations around the field (newest each)\n' + ring.join('\n'));

    const tafs = Object.values(L.tafs || {});
    if (tafs.length) {
      out.push('\n## TAFs');
      tafs.forEach(t => {
        if (t.raw) out.push(t.raw.trim());
        else if (t.periods) out.push(t.station + ' issued ' + fmt(t.t) + ':\n' + JSON.stringify(t.periods));
        out.push('(issued ' + fmt(t.t) + ', ' + age(t.t) + ' old)');
      });
    }

    if (L.grid && L.grid.t0) {
      const g = L.grid, n = Math.min(24, g.n || 24);
      const hrs = []; for (let i = 0; i < n; i++) hrs.push(new Date((g.t0 + i * 3600) * 1000).toLocaleTimeString('en-US', { timeZone: SITE.tz || 'America/New_York', hour: 'numeric', hour12: true }).replace(' ', ''));
      out.push('\n## NWS hourly grid at the field, next ' + n + ' h from ' + fmt(g.t0) + ' (fetched ' + fmt(g.t) + ')');
      out.push('hour: ' + hrs.join(' '));
      out.push('ceiling ft: ' + series(g, 'ceil', n));
      out.push('vis sm: ' + series(g, 'vis', n));
      out.push('wind dir °T: ' + series(g, 'dir', n));
      out.push('wind kt: ' + series(g, 'spd', n));
      out.push('gust kt: ' + series(g, 'gst', n));
      out.push('PoP %: ' + series(g, 'pop', n));
      out.push('temp °F: ' + series(g, 'temp', n));
      out.push('dew °F: ' + series(g, 'dew', n));
      const wx = (g.wx || []).slice(0, n).map((w, i) => w ? hrs[i] + '=' + w : null).filter(Boolean);
      out.push('weather: ' + (wx.length ? wx.join('; ') : 'none coded'));
    }

    if (L.model && L.model.t0) {
      const m = L.model, n = Math.min(36, m.n || 36);
      out.push('\n## GFS point at the field from ' + fmt(m.t0) + ', hourly');
      out.push('CAPE J/kg: ' + series(m, 'cape', n));
      out.push('CIN J/kg: ' + series(m, 'cin', n));
      out.push('precip mm: ' + series(m, 'pr', n));
    }

    if (L.aloft && L.aloft.lev) {
      const a = L.aloft;
      out.push('\n## GFS winds aloft at the field from ' + fmt(a.t0) + ', hourly for ' + a.n + ' h (dir °T / kt / °C)');
      a.lev.forEach((lev, i) => {
        const row = [];
        for (let h = 0; h < a.n; h += 3) row.push(a.dir[i][h] + '/' + a.spd[i][h] + '/' + a.tmp[i][h]);
        out.push(lev + ' hPa (~' + Math.round(a.hgt[i][0] * 3.281) + ' ft), every 3 h: ' + row.join(' '));
      });
      if (a.sfc) out.push('surface: ' + JSON.stringify(a.sfc).slice(0, 300));
    }

    if (L.raob && L.raob.levels) {
      const r = L.raob;
      out.push('\n## Sounding ' + (r.station || 'KIAD') + ' ' + fmt(r.t) + ' (hPa hgt_m T Td dir spd)');
      out.push(r.levels.filter(l => l[0] >= 300).map(l => l.map(v => v == null ? '-' : v).join(' ')).join('\n'));
    }

    if (L.forecast && L.forecast.days) {
      out.push('\n## NWS daily forecast at DC (fetched ' + fmt(L.forecast.t) + ')');
      Object.entries(L.forecast.days).forEach(([d, v]) =>
        out.push(d + ': hi ' + (v.hi ?? '-') + ' lo ' + (v.lo ?? '-') + ' PoP ' + (v.pop ?? '-') + '% — ' + (v.short || '')));
    }

    if (L.alerts && L.alerts.length) {
      out.push('\n## Active NWS alerts');
      L.alerts.forEach(a => out.push('- ' + (a.event || a.headline || JSON.stringify(a).slice(0, 200))));
    } else out.push('\n## Active NWS alerts\nnone');

    if (L.airsig && L.airsig.length) {
      out.push('\n## AIRMETs / SIGMETs touching the region');
      L.airsig.forEach(s => out.push('- ' + [s.kind, s.product, s.hazard, s.severity, s.level ? 'level ' + s.level : null,
        s.base != null ? 'base ' + s.base : null, s.top != null ? 'top ' + s.top : null, s.fzl != null ? 'fzl ' + s.fzl : null,
        'valid ' + fmt(s.from) + ' → ' + fmt(s.to)].filter(Boolean).join(' · ')));
    }

    if (L.pireps && L.pireps.length) {
      const cut = nowS - 6 * 3600;
      const recent = L.pireps.filter(p => p.t >= cut).slice(-25);
      out.push('\n## PIREPs, last 6 h in a ~150 nm box (' + recent.length + ')');
      recent.forEach(p => out.push('- ' + fmt(p.t) + ' ' + p.raw));
    }

    if (L.tfrs && L.tfrs.length) {
      out.push('\n## TFRs listed for the area');
      L.tfrs.slice(0, 15).forEach(t => out.push('- ' + t.type + ' · ' + t.state + ' · ' + t.desc));
    }

    if (L.afd && L.afd.productText) {
      out.push('\n## LWX Area Forecast Discussion issued ' + fmt(Date.parse(L.afd.issuanceTime) / 1000) + '\n' + L.afd.productText.trim());
    }
    return out.join('\n');
  }

  // ---- request -------------------------------------------------------------

  function buildBody(task, model, question, context) {
    const M = MODELS[model];
    const body = {
      model,
      max_tokens: 16000,
      stream: true,
      system: [{ type: 'text', text: SYSTEM }],
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: '<weather_data>\n' + context + '\n</weather_data>', cache_control: { type: 'ephemeral' } },
          { type: 'text', text: task.prompt || question },
        ],
      }],
    };
    if (M.thinking === true) body.thinking = { type: 'adaptive' };
    if (M.thinking && task.effort) body.output_config = { effort: task.effort };
    if (M.fallback) body.fallbacks = 'default';
    return body;
  }

  function headers(model) {
    const h = {
      'content-type': 'application/json',
      'x-api-key': key(),
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    };
    if (MODELS[model].fallback) h['anthropic-beta'] = 'server-side-fallback-2026-07-01';
    return h;
  }

  async function run(task, model, question) {
    const out = $('out'), meta = $('meta');
    out.innerHTML = '';
    meta.textContent = MODELS[model].name + ' · sending…';
    let text = '', usage = {}, stop = null, stopDetails = null, usedModel = model;
    let ctrl = new AbortController();
    state.abort = ctrl;
    setBusy(true);
    try {
      let res, note = '';
      for (let attempt = 0; ; attempt++) {
        res = await fetch(API, {
          method: 'POST', headers: headers(model), signal: ctrl.signal,
          body: JSON.stringify(buildBody(task, model, question, state.context)),
        });
        if (res.ok) break;
        let msg = res.status + ' ' + res.statusText;
        try { const j = await res.json(); msg = (j.error && j.error.message) || msg; } catch (e) { /* not json */ }
        const limited = res.status === 429 || res.status === 529;
        if (!limited || attempt >= 3) throw new Error(msg);
        // Rate-limited. Wait what the API asks (capped), then retry; after two
        // tries on a bigger model, step down to Sonnet and say so.
        if (attempt === 1 && model !== 'claude-sonnet-5' && model !== 'claude-haiku-4-5') {
          note = 'rate-limited on ' + MODELS[model].name + ', ran on Sonnet 5 · ';
          model = 'claude-sonnet-5';
        }
        const wait = Math.min(60, Math.max(5, parseInt(res.headers.get('retry-after') || '15', 10) || 15));
        for (let sLeft = wait; sLeft > 0; sLeft--) {
          meta.textContent = 'rate-limited (' + msg.slice(0, 80) + ') · retry in ' + sLeft + ' s';
          await new Promise((r, j) => { const id = setTimeout(r, 1000); ctrl.signal.addEventListener('abort', () => { clearTimeout(id); j(new DOMException('aborted', 'AbortError')); }, { once: true }); });
        }
      }
      usedModel = model;
      meta.textContent = MODELS[model].name + ' · thinking…';
      const reader = res.body.getReader(), dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n'); buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          let ev; try { ev = JSON.parse(line.slice(5)); } catch (e) { continue; }
          if (ev.type === 'message_start') {
            usage = ev.message.usage || {};
            if (ev.message.model) usedModel = ev.message.model;
          } else if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
            text += ev.delta.text;
            out.innerHTML = md(text);
            meta.textContent = MODELS[model].name + ' · writing…';
          } else if (ev.type === 'message_delta') {
            Object.assign(usage, ev.usage || {});
            stop = ev.delta && ev.delta.stop_reason;
            stopDetails = ev.delta && ev.delta.stop_details;
          } else if (ev.type === 'error') {
            throw new Error(ev.error && ev.error.message || 'stream error');
          }
        }
      }
      if (stop === 'refusal') {
        out.innerHTML = '<p class="err">Declined by the model' + (stopDetails && stopDetails.category ? ' (' + esc(stopDetails.category) + ')' : '') + '.</p>' + md(text);
      } else if (stop === 'max_tokens') {
        out.innerHTML = md(text) + '<p class="err">Cut off at the output limit.</p>';
      } else if (!text) {
        out.innerHTML = '<p class="err">Empty reply.</p>';
      }
      meta.innerHTML = esc(note) + summarize(usedModel, usage, stop);
      history(task, model, text, usage, question);
    } catch (e) {
      if (e.name === 'AbortError') meta.textContent = 'stopped';
      else { out.innerHTML = '<p class="err">' + esc(e.message) + '</p>'; meta.textContent = 'failed'; }
    } finally {
      setBusy(false); state.abort = null;
    }
  }

  function cost(model, u) {
    const p = (MODELS[model] || MODELS['claude-opus-5']).price;
    return ((u.input_tokens || 0) * p[0] + (u.output_tokens || 0) * p[1] +
      (u.cache_creation_input_tokens || 0) * p[2] + (u.cache_read_input_tokens || 0) * p[3]) / 1e6;
  }

  function summarize(model, u, stop) {
    const name = (MODELS[model] || {}).name || model;
    const parts = [name,
      'in ' + ((u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)).toLocaleString() +
        (u.cache_read_input_tokens ? ' (' + u.cache_read_input_tokens.toLocaleString() + ' cached)' : ''),
      'out ' + (u.output_tokens || 0).toLocaleString(),
      '≈ $' + cost(model, u).toFixed(3)];
    if (stop && stop !== 'end_turn') parts.push('stop: ' + stop);
    return parts.map(esc).join(' · ');
  }

  // ---- tiny markdown: headings, bullets, bold, code, paragraphs ------------

  function md(s) {
    const lines = esc(s).split('\n'); const html = []; let list = null;
    const inline = t => t.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
    const close = () => { if (list) { html.push('</' + list + '>'); list = null; } };
    for (const raw of lines) {
      const l = raw.trimEnd();
      let m;
      if ((m = l.match(/^(#{1,4})\s+(.*)/))) { close(); html.push('<h' + (m[1].length + 1) + '>' + inline(m[2]) + '</h' + (m[1].length + 1) + '>'); }
      else if ((m = l.match(/^\s*[-*•]\s+(.*)/))) { if (list !== 'ul') { close(); list = 'ul'; html.push('<ul>'); } html.push('<li>' + inline(m[1]) + '</li>'); }
      else if ((m = l.match(/^\s*\d+[.)]\s+(.*)/))) { if (list !== 'ol') { close(); list = 'ol'; html.push('<ol>'); } html.push('<li>' + inline(m[1]) + '</li>'); }
      else if (!l.trim()) close();
      else { close(); html.push('<p>' + inline(l) + '</p>'); }
    }
    close();
    return html.join('');
  }

  // ---- history (localStorage, newest first, capped) ------------------------

  const HIST_LS = 'wxai_history';
  const HIST_MAX = 200;

  function loadHist() { try { return JSON.parse(localStorage.getItem(HIST_LS) || '[]'); } catch (e) { return []; } }
  function saveHist(h) {
    for (;;) {
      try { localStorage.setItem(HIST_LS, JSON.stringify(h)); return; }
      catch (e) { if (h.length < 2) return; h.length = Math.floor(h.length / 2); }
    }
  }

  function history(task, model, text, usage, question) {
    if (!text) return;
    const h = loadHist();
    h.unshift({ t: Math.floor(Date.now() / 1000), label: task.label, q: question || null, model, text, cost: cost(model, usage),
      archive: state.latest ? state.latest.t : null });
    if (h.length > HIST_MAX) h.length = HIST_MAX;
    saveHist(h);
    renderHist();
  }

  function renderHist() {
    const h = loadHist(), el = $('history');
    $('history-card').hidden = !h.length;
    $('history-n').textContent = h.length ? h.length + ' run' + (h.length === 1 ? '' : 's') : '';
    el.innerHTML = h.map(r =>
      '<details><summary>' + esc(fmt(r.t)) + ' · ' + esc(r.label) + (r.q ? ' — ' + esc(r.q.slice(0, 80)) : '') +
      ' · ' + esc((MODELS[r.model] || {}).name || r.model) + ' · ≈ $' + Number(r.cost || 0).toFixed(3) + '</summary>' +
      (r.archive ? '<p class="small">archive run ' + esc(fmt(r.archive)) + '</p>' : '') +
      '<div class="answer">' + md(r.text) + '</div></details>').join('');
  }

  // ---- UI ------------------------------------------------------------------

  const state = { context: '', latest: null, abort: null };

  function setBusy(b) {
    document.querySelectorAll('#tasks button').forEach(x => x.disabled = b);
    $('ask-go').disabled = b;
    $('stop').hidden = !b;
  }

  function currentModel(task) {
    const sel = $('model').value;
    return sel === 'auto' ? task.model : sel;
  }

  function keyUI() {
    const has = !!key();
    $('key-card').hidden = has;
    $('key-set').hidden = !has;
    $('main').hidden = !has;
    $('key-tail').textContent = has ? '…' + key().slice(-6) : '';
  }

  function init() {
    const tasks = $('tasks');
    TASKS.filter(t => t.prompt).forEach(t => {
      const b = document.createElement('button');
      b.className = 'task';
      b.innerHTML = '<span class="lbl">' + esc(t.label) + '</span><span class="note">' + esc(t.note) + '</span><span class="mdl">' + esc(MODELS[t.model].name) + '</span>';
      b.title = t.prompt;
      b.addEventListener('click', () => run(t, currentModel(t), null));
      tasks.appendChild(b);
    });
    const ask = TASKS.find(t => t.id === 'ask');
    $('ask-go').addEventListener('click', () => {
      const q = $('ask-q').value.trim(); if (!q) return;
      run(ask, currentModel(ask), q);
    });
    $('ask-q').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $('ask-go').click(); });
    $('stop').addEventListener('click', () => state.abort && state.abort.abort());

    const sel = $('model');
    Object.entries(MODELS).forEach(([id, m]) => {
      const o = document.createElement('option'); o.value = id;
      o.textContent = m.name + ' · $' + m.price[0] + ' / $' + m.price[1] + ' per M';
      sel.appendChild(o);
    });
    try { sel.value = localStorage.getItem(MODEL_LS) || 'auto'; } catch (e) { /* */ }
    if (!sel.value) sel.value = 'auto';
    sel.addEventListener('change', () => { try { localStorage.setItem(MODEL_LS, sel.value); } catch (e) { /* */ } });

    $('key-save').addEventListener('click', () => {
      const v = $('key-in').value.trim();
      if (!v.startsWith('sk-ant-')) { $('key-err').textContent = 'keys start with sk-ant-'; return; }
      try { localStorage.setItem(KEY_LS, v); } catch (e) { $('key-err').textContent = 'localStorage unavailable'; return; }
      $('key-in').value = ''; keyUI();
    });
    $('key-clear').addEventListener('click', e => { e.preventDefault(); try { localStorage.removeItem(KEY_LS); } catch (e) { /* */ } keyUI(); });
    $('ctx-show').addEventListener('click', e => { e.preventDefault(); $('ctx').hidden = !$('ctx').hidden; });
    $('history-clear').addEventListener('click', e => { e.preventDefault(); if (confirm('Delete every saved run?')) { try { localStorage.removeItem(HIST_LS); } catch (x) { /* */ } renderHist(); } });
    keyUI();
    renderHist();
    loadContext();
  }

  async function loadContext() {
    const L = await WXA.latest();
    if (!L) { $('ctx-meta').textContent = 'archive unreachable — nothing to analyze'; setBusy(true); return; }
    state.latest = L;
    state.context = buildContext(L);
    $('ctx').textContent = state.context;
    const tokens = Math.round(state.context.length / 3.6);
    $('ctx-meta').innerHTML = 'archive run ' + esc(fmt(L.t)) + ' · ' + esc(age(L.t)) + ' old · ~' + tokens.toLocaleString() + ' tokens per run';
  }

  window.WXAI_DEBUG = { buildContext, buildBody, md, TASKS, MODELS, state };
  document.addEventListener('DOMContentLoaded', init);
})();
