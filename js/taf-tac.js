/* TAF text (TAC form) -> the period shape the almanac renders.
   ---------------------------------------------------------------------------
   The live archiver stores TAFs decoded from IWXXM XML; backfilled issuances
   (scripts/wxbackfill.py, and heal_tafs) keep the raw text IEM served — a WMO
   header, the AWIPS PIL, then the TAF body:

       349
       FTUS41 KLWX 300528
       TAFBWI
       TAF
       KBWI 300528Z 3006/3112 00000KT P6SM FEW080
            FM301500 21008KT P6SM SCT080=

   TafTac.parse(raw, refEpoch) turns that into
     { station, issued, b, e, amd, cor, nil, note, periods: [
         { ind, b, e, dir?, kt?, gust?, visM?, wx: [], cld: [{amt, ft}] } ] }
   with the same keys and units the archiver's decode_taf_xml() writes (so
   almanac.js renders either without caring which it got): epoch seconds,
   ceiling feet, visibility in meters via the NWS SM table (P6SM -> 16093),
   `ind` in the plain form (FM · TEMPO · BECMG · PROB30 · PROB40 · PROB30 TEMPO).
   Absent elements are absent keys, not nulls — TEMPO groups list only what
   changes, and the renderer prints only what is present.

   Day/hour groups carry no month: they are resolved against `refEpoch` (the
   archive's issuance stamp; defaults to now) by taking the month that lands
   the time nearest the reference. The validity end and every change-group
   window are resolved relative to the validity start, so a TAF issued on the
   31st that runs into the 1st resolves cleanly.

   Pure, no dependencies, no DOM. Also usable from node (window optional). */

'use strict';

(function () {
  /* the same statute-mile -> meters table NWS uses (weather.js VIS_TABLE,
     read the other way) — never sm * 1609 */
  const SM_M = [[0.25, 400], [0.5, 800], [0.75, 1200], [1, 1600], [1.5, 2400],
    [2, 3200], [3, 4800], [4, 6000], [5, 8000], [6, 9000]];
  const P6SM_M = 16093;

  function visMeters(sm) {
    if (sm == null || !isFinite(sm)) return null;
    for (const [s, m] of SM_M) if (Math.abs(sm - s) < 1e-6) return m;
    return sm > 6 ? P6SM_M : Math.round(sm * 1609.34);
  }

  const WX_RE = /^(?:[+-]|VC)?(?:MI|PR|BC|DR|BL|SH|TS|FZ)?(?:DZ|RA|SN|SG|IC|PL|GR|GS|UP|BR|FG|FU|VA|DU|SA|HZ|PY|PO|SQ|FC|SS|DS)*$/;
  const isWx = (tok) => tok.length >= 2 && tok !== 'VC' && WX_RE.test(tok);

  /* dd/hh(/mm) with no month -> epoch seconds, choosing the month (ref-1,
     ref, ref+1) that lands nearest the reference; hh may be 24 */
  function resolve(dd, hh, mm, refSec) {
    const r = new Date(refSec * 1000);
    let best = null;
    for (let k = -1; k <= 1; k++) {
      const y = r.getUTCFullYear(), m = r.getUTCMonth() + k;
      if (new Date(Date.UTC(y, m, dd)).getUTCDate() !== dd) continue;   // no 31st this month
      const t = Date.UTC(y, m, dd) / 1000 + hh * 3600 + mm * 60;
      if (best === null || Math.abs(t - refSec) < Math.abs(best - refSec)) best = t;
    }
    return best;
  }

  function tokenize(raw) {
    const out = [];
    for (let tok of String(raw || '').split(/\s+/)) {
      if (!tok) continue;
      if (tok === '=') break;
      const end = tok.endsWith('=');
      if (end) tok = tok.slice(0, -1);
      if (tok) out.push(tok);
      if (end) break;
    }
    return out;
  }

  /* one group's element tokens -> period fields */
  function elements(p, toks) {
    for (let i = 0; i < toks.length; i++) {
      const tok = toks[i];
      let m;
      if ((m = /^(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?(KT|MPS)$/.exec(tok))) {
        const k = m[4] === 'MPS' ? 1.94384 : 1;
        if (m[1] !== 'VRB') p.dir = +m[1];
        p.kt = Math.round(+m[2] * k);
        if (m[3]) p.gust = Math.round(+m[3] * k);
        continue;
      }
      if ((m = /^WS(\d{3})\/(\d{3})(\d{2,3})KT$/.exec(tok))) {
        p.ws = { ft: +m[1] * 100, dir: +m[2], kt: +m[3] };
        continue;
      }
      if (tok === 'P6SM') { p.visM = P6SM_M; continue; }
      if (tok === 'CAVOK') { p.visM = P6SM_M; p.cavok = true; continue; }
      if ((m = /^(M)?(\d{1,2})SM$/.exec(tok))) {
        p.visM = visMeters(+m[2]);
        if (m[1]) p.visOp = 'below';
        continue;
      }
      if ((m = /^(M)?(\d)\/(\d)SM$/.exec(tok))) {
        p.visM = visMeters(+m[2] / +m[3]);
        if (m[1]) p.visOp = 'below';
        continue;
      }
      /* "1 1/2SM": a lone digit followed by the fraction token */
      if (/^\d$/.test(tok) && i + 1 < toks.length && (m = /^(\d)\/(\d)SM$/.exec(toks[i + 1]))) {
        p.visM = visMeters(+tok + +m[1] / +m[2]);
        i++;
        continue;
      }
      /* ICAO metres (never in a US TAF, but cheap): 9999 = 10 km or more */
      if (p.visM == null && /^\d{4}$/.test(tok) && !p.cld.length) {
        p.visM = +tok >= 9999 ? P6SM_M : +tok;
        continue;
      }
      if ((m = /^(FEW|SCT|BKN|OVC)(\d{3})(CB|TCU)?$/.exec(tok))) {
        const c = { amt: m[1], ft: +m[2] * 100 };
        if (m[3]) c.cb = m[3];
        p.cld.push(c);
        continue;
      }
      if ((m = /^VV(\d{3}|\/{3})$/.exec(tok))) {
        p.cld.push({ amt: 'VV', ft: m[1] === '///' ? null : +m[1] * 100 });
        continue;
      }
      if (/^(SKC|CLR|NSC|NCD)$/.test(tok)) { p.cld.push({ amt: tok === 'CLR' ? 'CLR' : 'SKC', ft: null }); continue; }
      if (tok === 'NSW') { p.nsw = true; continue; }
      if (isWx(tok)) { p.wx.push(tok); continue; }
      /* TX/TN temperature groups, QNH, anything else: not rendered */
    }
    return p;
  }

  function parse(raw, refEpoch) {
    const toks = tokenize(raw);
    const out = { station: null, issued: null, b: null, e: null, amd: false, cor: false,
      nil: false, note: null, periods: [] };
    const ref = refEpoch != null && isFinite(refEpoch) ? +refEpoch : Date.now() / 1000;

    /* header: the station is the 4-char group followed by a DDHHMMZ stamp or
       a DDHH/DDHH validity — that rule skips "FTUS41 KLWX 300528" (no Z) and
       the AWIPS PIL, whatever preceded them */
    let i = 0, hdr = -1;
    for (; i < toks.length - 1; i++) {
      if (/^[A-Z][A-Z0-9]{3}$/.test(toks[i]) && toks[i] !== 'TEMPO'
        && (/^\d{6}Z$/.test(toks[i + 1]) || /^\d{4}\/\d{4}$/.test(toks[i + 1]))) { hdr = i; break; }
    }
    if (hdr < 0) return out;
    for (let k = Math.max(0, hdr - 3); k < hdr; k++) {
      if (toks[k] === 'AMD') out.amd = true;
      if (toks[k] === 'COR') out.cor = true;
    }
    out.station = toks[hdr];
    i = hdr + 1;
    let m;
    if ((m = /^(\d{2})(\d{2})(\d{2})Z$/.exec(toks[i]))) {
      out.issued = resolve(+m[1], +m[2], +m[3], ref);
      i++;
    } else out.issued = ref;
    if (toks[i] === 'NIL') { out.nil = true; return out; }
    if (!(m = /^(\d{2})(\d{2})\/(\d{2})(\d{2})$/.exec(toks[i] || ''))) return out;
    out.b = resolve(+m[1], +m[2], 0, out.issued);
    out.e = resolve(+m[3], +m[4], 0, out.b + 12 * 3600);
    if (out.e != null && out.b != null && out.e <= out.b) out.e += 86400;
    i++;

    /* split the body into groups: the base, then every change group */
    const groups = [];
    let cur = { ind: 'FM', b: out.b, e: null, toks: [] };
    groups.push(cur);
    const win = (tok, refT) => {
      const w = /^(\d{2})(\d{2})\/(\d{2})(\d{2})$/.exec(tok || '');
      if (!w) return null;
      const b = resolve(+w[1], +w[2], 0, refT);
      let e = resolve(+w[3], +w[4], 0, b + 6 * 3600);
      if (e != null && e <= b) e += 86400;
      return { b, e };
    };
    for (; i < toks.length; i++) {
      const tok = toks[i];
      if ((m = /^FM(\d{2})(\d{2})(\d{2})$/.exec(tok))) {
        cur = { ind: 'FM', b: resolve(+m[1], +m[2], +m[3], out.b), e: null, toks: [] };
        groups.push(cur);
        continue;
      }
      if ((m = /^FM(\d{2})(\d{2})$/.exec(tok))) {            // pre-2008 FMHHMM form
        const day0 = Math.floor(out.b / 86400) * 86400;
        let t = day0 + (+m[1]) * 3600 + (+m[2]) * 60;
        const prev = groups[groups.length - 1].b || out.b;
        while (t < prev) t += 86400;
        cur = { ind: 'FM', b: t, e: null, toks: [] };
        groups.push(cur);
        continue;
      }
      if (tok === 'TEMPO' || tok === 'BECMG') {
        const w = win(toks[i + 1], out.b);
        cur = { ind: tok, b: w && w.b, e: w && w.e, toks: [] };
        groups.push(cur);
        if (w) i++;
        continue;
      }
      if ((m = /^PROB(30|40)$/.exec(tok))) {
        let ind = `PROB${m[1]}`, j = i + 1;
        if (toks[j] === 'TEMPO') { ind += ' TEMPO'; j++; }
        const w = win(toks[j], out.b);
        cur = { ind, b: w && w.b, e: w && w.e, toks: [] };
        groups.push(cur);
        i = w ? j : i;
        continue;
      }
      if (tok === 'RMK' || tok === 'AMD') {                  // "AMD NOT SKED", remarks
        out.note = toks.slice(i).join(' ');
        break;
      }
      cur.toks.push(tok);
    }

    /* windows: a FM group runs until the next FM (or the validity end) */
    const fms = groups.filter((g) => g.ind === 'FM');
    for (let k = 0; k < fms.length; k++) {
      fms[k].e = k + 1 < fms.length ? fms[k + 1].b : out.e;
    }
    for (const g of groups) {
      if (g.b == null || g.e == null) continue;              // malformed window: dropped
      const p = elements({ ind: g.ind, wx: [], cld: [] }, g.toks);
      p.b = g.b; p.e = g.e;
      out.periods.push(p);
    }
    return out;
  }

  const api = { parse, visMeters, tokenize, resolve };
  if (typeof window !== 'undefined') window.TafTac = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
