/* Shared read access to the site's own weather archive (data/wx/).
   ---------------------------------------------------------------------------
   scripts/wxarchive.py writes one file per stream per local day, plus a single
   latest.json holding the current state of every stream. That makes data/wx/
   a same-origin data source any page here can read — no CORS, no NWS rate
   limits, no per-page fetch logic, and history for free.

   Streams: afd · forecast · obs · fieldobs · grid · taf · alerts · model
   (obs is the station the DC forecast is verified against, KDCA; fieldobs is
   the airfield's own sensor, KNAK — hourly, so expect gaps)
   (see CLAUDE.md and the docstring in scripts/wxarchive.py for shapes).

   Everything is optional and every call resolves to null rather than throwing:
   a page that finds nothing archived should fall back to the live API, which
   is exactly what discussion.html does. Loaded before the page's own script;
   needs js/site-config.js first. */

'use strict';

const WXA = {
  base: (typeof SITE !== 'undefined' && SITE.weather && SITE.weather.archiveBase) || 'data/wx',
  _cache: new Map(),

  /* Cached same-origin GET. One in-flight request per path, ever. */
  json(path) {
    if (!this._cache.has(path)) {
      this._cache.set(path, fetch(`${this.base}/${path}`, { headers: { Accept: 'application/json' } })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null));
    }
    return this._cache.get(path);
  },

  /* Current state of every stream in one document. */
  latest() { return this.json('latest.json'); },

  /* Catalog: which days each stream holds, plus every archived AFD. */
  index() { return this.json('index.json'); },

  /* One day of one stream. date = 'YYYY-MM-DD' in the airport's timezone. */
  day(stream, date) { return this.json(`${stream}/${date}.json`); },

  /* The earliest snapshot archived on a given day — the version of the
     forecast a morning go/no-go was made against. */
  async firstSnap(stream, date) {
    const doc = await this.day(stream, date);
    const snaps = doc && doc.snaps;
    return snaps && snaps.length ? snaps[0] : null;
  },

  async lastSnap(stream, date) {
    const doc = await this.day(stream, date);
    const snaps = doc && doc.snaps;
    return snaps && snaps.length ? snaps[snaps.length - 1] : null;
  },

  /* Value of one grid field at one hour, out of a grid snapshot. */
  gridAt(snap, field, ms) {
    if (!snap || snap.t0 == null || !snap[field]) return undefined;
    const i = Math.round((ms / 1000 - snap.t0) / 3600);
    return i >= 0 && i < snap[field].length ? snap[field][i] : undefined;
  },
};
