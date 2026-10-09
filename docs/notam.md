# NOTAM hub

Moved verbatim from CLAUDE.md. Sibling docs are in `docs/`; "above"/"below" references to other areas point there. Index: CLAUDE.md → Docs.

### NOTAM hub

- `notam.html` + `js/notam.js` — NOTAM Hub (2026-09-10): every active NOTAM in the country,
  archived hourly and counted. Reads **only the `notam-data` branch** (`SITE.notam.dataBase`, over
  raw.githubusercontent like the tracker/wx3d snapshots; localStorage `notam_data_base` overrides
  it for a local copy) plus same-origin `data/notam/locations.json`. No FAA call from the browser.
  First paint is `summary.json` alone (stat tiles · the **Mix** card — one canvas, five 100 %
  stacked bars: keyword · class · ends · age · length, `stackRows()`, shades of the one blue,
  replacing five separate bar charts 2026-09-12 · the dot map · trend · start-hour clock · leaders · the folded watch lists · the local
  card · coverage line); `current/<ST>.json` files are fetched only when a visitor browses or
  searches (a facility id resolves to its state through locations.json; a text search with no
  state loads every state file and says so). **Layout (2026-09-11, Jesse's order): tiles →
  Browse → charts → folds → Local → Decode → the map → leaders last** (leaders moved under the map 2026-09-12) ("cluttered, for a rework
  later" — don't move it back up). **The Browse pills are hide-toggles, all lit by default**:
  a click hides that keyword (or class pill TFR/GPS/FDC; `other` = APRON/ROUTE/CHART/unkeyed),
  the count says `N hidden`, and a chart bar click lights only its pill (`browseKeyword`;
  a class that is not a pill — D/MIL/INTL — becomes `S.browse.cls`). Deep links: `#q=KANP`,
  `#st=MD&hide=OBST,TWY` (old `k=` links still resolve).
  **Times are Z everywhere** — NOTAMs are written in UTC and the scope is the country, so
  archive days are UTC days too (unlike `data/wx/`). **The map is Leaflet** (2026-09-12,
  `buildMap()`, vendored `js/vendor/leaflet.js`, dark CARTO base via `SITE.basemap.cartoKey`,
  FAA VFR sectional tiles as an off-by-default chip): one canvas-rendered dot per facility with
  NOTAMs in effect, sized and shaded by count, click → Browse; a GPS-tests layer (orange, dashed
  when scheduled) and a TFR layer (red) drawn from the NOTAM text by **`notamGeom()`** — polygon
  `AREA DEFINED AS A TO B TO …`, circle `NNM RADIUS OF <coord>` / `CENTERED AT <coord>` (+ one
  ring per GPS altitude tier), else the first `DDMMSS[.ss]N DDDMMSS[.ss]W` in the text (an
  obstruction's own position). **Every listed NOTAM carries a `map` link** (`showOnMap()`): its
  geometry in white, or its facility's dot when the text carries none, and the map jumps to it
  (a clipped summary raw is fetched whole first). ARTCC and national NOTAMs (state `--`) are a
  row in the state table, not dots. The old Albers canvas (`REGIONS`, `albers()`, `mapFrame()`)
  survives only for the GPS fold's small overview map. Charts are single-hue blue for magnitude; the
  trend's two lines are `#3987e5` / `#d95926`, validated on the card surface (CVD ΔE 26.8, both
  ≥ 3:1) — one y-scale per lane, never two on one plot. The status bar prints the run's age, the
  locations answered, the source, and every warning the archiver wrote (`note`, a refused run,
  a stale run > 4 h). **GPS fold map** (2026-09-12): the GPS interference fold opens with a small copy of the map
  (`drawGpsMap()`, `mapFrame()` shared with the big one) drawing every test whose text carries
  geometry — `gpsGeom()` parses `CENTERED AT DDMMSSN DDDMMSSW` plus the radius tiers
  (`379NM RADIUS … FL400-UNL, 342NM RADIUS AT FL250 …`, one ring each, lowest tier solid) or
  the polygon form `AREA DEFINED AS: A TO B TO …`; ARTCC copies of one test share a centre and
  draw once; orange = in effect, blue dashed = scheduled; click a centre → Decode. The
  archiver's `gps` list carries **scheduled** GPS-class records too (`s > now`) — the tests
  are filed days ahead and were invisible while the list was in-effect only. **The NOTAM
  archive is also a feed stream** (`feed.html` pill `notam`, 2026-09-12): one line per archive
  run, read from the notam-data branch's `days/<UTC day>.json` (both UTC days a local day
  touches; `notamRows()` in `feed.js`), stamped at the run, `N new (top keywords) · M gone
  (expired, cancelled)`, size = the new records' text, expansion lists every id; today is read
  even before the weather archive opens today's local day, and a new run (index `t` moved)
  re-reads it on the live poll. **Decode card** (2026-09-11, `#dec-card`): paste a NOTAM or
  type one contraction and it reads back — header (accountability · number · location ·
  keyword · period, names from locations.json), the ICAO Q-line (`Q_SUBJ`/`Q_COND` tables,
  traffic/purpose/scope, B)/C) times), then every token with a hover gloss and a plain-words
  line; coordinates → decimal degrees, `SFC-2000FT`/`FL` bands, `DLY HHMM-HHMM`, `3.3NM ENE ANP`
  → "3.3 nautical miles east-northeast of Lee". The contraction list is `js/notam-dict.js`
  (`NOTAM_DICT`, ~750 entries from JO 7340.2 — plain English words are deliberately absent so
  only real contractions are underlined). Every listed NOTAM carries a `decode` link into it;
  `#decode=<text>` deep-links. Page copy is label → value; `window.NOTAM_DEBUG` (`decodeNotam`,
  `glossToken`) for headless checks.
- `scripts/notamarchive.py` + `.github/workflows/notamarchive.yml` — the archiver, hourly at :48
  (stdlib; `NOTAM_*` env knobs at the top of the script). **Sources, in order** (`NOTAM_SOURCES`,
  default `nms,nsearch,dins`): **(0) the FAA NMS API** — the NOTAM Management
  Service that replaced the US NOTAM System/FNS on 2026-04-18; **live and verified against
  pre-production 2026-09-11**. OAuth2 client credentials: `POST {host}/v1/auth/token` with
  Basic id:secret on the *bare* host (not under `/nmsapi` — the FAQ's most common 401),
  30-minute tokens; API at `{host}/nmsapi/v1`, `nmsResponseFormat: AIXM|GEOJSON` header
  required. Hosts: `api-nms.aim.faa.gov` (prod) and `api-staging.cgifederal-aim.com`
  (pre-prod, `NMS_HOST` — a repo *variable*, blank = prod). Access: email NOTAMS@faa.gov →
  a ticket (INC0032170) and an onboarding packet with the pre-prod pair, spec YAML and cURL
  samples (Jesse's `Downloads/nms/`); production credentials on request to
  7-AWA-NAIMES@faa.gov once pre-prod is validated. Secrets `NMS_CLIENT_ID` /
  `NMS_CLIENT_SECRET`. **Two pulls** (`collect_nms()`, mode in `index.json`): **full** —
  `GET /v1/notams?classification=X&allowRedirect=false` per class (DOMESTIC · FDC · MILITARY
  · LOCAL_MILITARY · INTERNATIONAL) returns `{data:{url:"/nmsapi/v1/content/<token>"}}`, a
  *host-relative* path (join it to the host, not `/nmsapi`; Bearer; the token is the signed
  storage.googleapis.com URL, good 5 min) to a gzip GeoJSON file of the class — once a day
  (`NMS_FULL_EVERY_S`, 23 h) or when the archive is empty; staging: 74,527 features in 10
  requests / 10 s. `/v1/notams/il` (AIXM 5.1 in a SOAP envelope, gzip; `parse_aixm()`) is the
  last resort — **the FAA allows the initial load once per 24 h**. **delta** —
  `GET /v1/notams?lastUpdatedDate=<ISO Z>` (24 h window max, overlapped 15 min): everything
  created / updated / cancelled since, in the body (~400 features an hour, one request,
  0.3 s), merged onto the archive; a failed delta falls back to a full pull. **What the data
  looks like:** feature `properties.coreNOTAMData.notam` (`number`, `type` N/R/C, `issued`,
  `location`, `icaoLocation`, `accountId`, `classification` DOM/FDC/MIL/INTL,
  `effectiveStart/End` ISO or `PERM`, `lastUpdated`, `cancelationDate`, `text`) +
  `notamTranslation[]` (`LOCAL_FORMAT` `simpleText` = the traditional `!ACCT NN/NNN LOC …`
  NOTAM for domestic/FDC; INTL and MIL carry only the `ICAO` translation, so their `raw` is
  synthesised from the fields and `k` is usually `?`). **A cancellation is the record itself
  with `cancelationDate` earlier than its `effectiveEnd`** (`type` stays N); NOTAMC records
  (type C) are messages and are dropped. **`nms_keep()` filters**: INTERNATIONAL is every
  foreign FIR's NOTAMs too (RJJJ, RKRR, LIMM led the facility table) and MILITARY includes US
  bases abroad (EDWW), so both classes keep only US locations (ICAO prefix K/PA/PH/PG/PW/PM/
  PJ/PL/TJ/TI/NS or an id in locations.json); and the class files hold thousands of records
  past their end (one 25 years old), which are not current whatever file they came in; an end
  of 9999-12-31 is PERM. **`drop_crossovers()`**: every domestic/FDC/military NOTAM at an
  international airport is also issued as an ICAO-series copy (ESN 05/011 ≡ KESN A0130/26),
  and the class files carry both — the copy is dropped on (location, start, first 40 chars of
  the body), 5,244 of them on staging, so a count is a count of NOTAMs. Staging result after
  filtering: **28,038 NOTAMs** (D 20,989 · FDC 4,381 · MIL 1,697 · INTL 391 · TFR 69 · GPS 8),
  57 state files, ~22 MB archive. ~3 requests a run instead of ~75, every
  classification, issue and last-updated stamps. **(1) FAA NOTAM Search** (`notams.aim.faa.gov/notamSearch/search`, the
  JSON behind the public page: `searchType=0&designatorsForLocation=A,B,C`, 30 a page (fixed —
  no page-size parameter is honoured), `offset` to page; `{notamList, startRecordCount,
  endRecordCount, totalNotamCount, filteredResultCount, criteriaCaption, searchDateTime,
  linkedLocationCaption, error, countsByType, requestID}`; each item `traditionalMessage` /
  `icaoMessage`, `issueDate`/`startDate`/`endDate` `MM/DD/YYYY HHMM` or `PERM`,
  `facilityDesignator`, `icaoId`, `keyword`, `status`, `cancelledOrExpired`, `mapPointer`
  `POINT(lon lat)`; shape and paging verified 2026-09-10 from a browser) — for every id in
  `data/notam/locations.json` in batches of 50. **But it is behind Akamai Bot Manager, which
  403s every non-browser TLS fingerprint**: Python urllib (3.10/OpenSSL 1.1.1 on Windows,
  3.12/OpenSSL 3 on a ubuntu-24.04 Actions runner) and curl (HTTP/1.1 and /2) all get
  `Access Denied`, with a full Chrome header set and even with a browser's own `bm_sv` cookie
  — the block is on the TLS handshake, not headers, cookies or IP. Only a real browser gets
  through, so this source can't run from stdlib Python anywhere; the code stays as the
  documented stopgap and the log names the blocker. From the browser the cost would have been
  fine: 250 sampled locations → 1,270 NOTAMs in 44 pages at 0.2–0.5 s a page, i.e. ~32,000
  NOTAMs / ~1,100 pages / ~14 min for the whole list with `NOTAM_PAUSE_S` 0.5. **(2) DINS**
  (`www.notams.faa.gov/dinsQueryWeb`) — **gone: the host no longer resolves** (2026-09-10; its
  maintenance order JO 6180.22 was cancelled 2026-07-01). Kept last so a DNS failure is
  recognised as dead in one request. A run with every source dead costs 6 requests / ~4 s
  (`--selftest` covers it): the archiver stops asking after three refusals per source instead
  of halving and retrying every batch. So **without NMS credentials the hourly run
  publishes only a failed `index.json`** (`ok:false`, note = the Akamai 403), which the page
  prints. The NMS token endpoint is live (401 `{"ErrorCode":"invalid_client",…}` without
  credentials; the API base answers 401 JSON `{timestamp, status, message}`). The FAA
  developer portal (`api.faa.gov` → `portal.apic4e.faa.gov`, `external-api.faa.gov/notamapi/
  v1/notams`, 401 JSON without a key) is the other keyed route and may be self-serve — not
  tried. **Trust rules**: a batch counts
  only when it parses (an empty page must echo one of the ids it was asked about); a failing
  batch is retried in halves and again at the end of the run, and its NOTAMs **carry over
  untouched** (absence there is a dead batch, not a cancellation — never mark gone what was not
  asked for); a run that finds fewer than half of last run's NOTAMs (`NOTAM_FLOOR`) is
  **refused** — status written, nothing else, so a changed page layout can't mark the country
  gone. Records: `id` = accountability + number (`ANP 09/012`, `FDC 6/1234`), `l` location, `k`
  keyword, `c` class (D · FDC · TFR · GPS · MIL · LMIL · INTL), `s`/`e` start/end (`p` PERM, `x`
  EST), `raw`, `f` first seen (a run stamp — GitHub's scheduler fires hourly crons every ~2.4 h,
  so first-seen resolution is that coarse), `i` issued and `u` last updated when the source says,
  `q` the locations.json record, `st` (the record's state, or the `VA..` prefix of an FDC
  airspace NOTAM), `b` on everything already in the system at the bootstrap run (those are not
  counted as issuance). Layout: `index.json` (runs, days, states, failures) · `summary.json`
  (every aggregate; shape in `summarize()`) · `current/<ST>.json` (the whole system now, by
  state) · `days/YYYY-MM-DD.json` (`new` = first seen that UTC day, `gone` = `{id: [t, exp|cxl,
  first_day]}`; a day file is written only on its own day). The workflow clones the previous
  `notam-data` tree, runs the script in it, and force-pushes one commit — the tree is the state
  and nothing is deleted. `--selftest` covers the parser (D · FDC IAP · TFR · GPS · schedule ·
  EST · PERM · ICAO-format), the DINS HTML, NMS feature conversion and unpacking, attribution,
  three runs of deltas and the refused run; `--fixture f.json` runs the whole pipeline offline
  (`{queries:{id:[raw…]}, fail:[ids]}`).
- `scripts/build_notam_locations.py` → `data/notam/locations.json` — the location universe
  (`[q, lid, kind, name, st, lat, lon, artcc, aliases]`; `q` = the id to query, `lid` = the id
  NOTAM text uses, `ZDC` carries alias `KZDC`). `--seed` (what ships) builds offline from
  `data/procedures/index.json` (every US airport with a coded procedure, ~3,180) + the coded
  legs' recommended navaids (~340 VOR/NDB not on an airport, state = nearest airport's) + the
  24 ARTCC/CERAPs + `GPS`/`FDC`. That covers the fields that generate nearly all NOTAM
  traffic, not the ~2,000 public-use fields without a procedure. **The default (no flag) path
  is what ships now** (built 2026-09-10 from the 2026-09-03 cycle, 6,279 locations: 4,886
  airports · 308 military-owned · 226 seaplane bases · 60 heliports · 773 navaids · 24 ARTCCs ·
  GPS/FDC): it downloads the FAA NASR 28-day CSV subscription's per-subject zips
  (`nfdc.faa.gov/webContent/28DaySub/extra/DD_Mon_YYYY_APT_CSV.zip`, ~8 MB, and `…_NAV_CSV.zip`;
  the whole-subscription `…_CSV.zip` also exists and works via `--nasr`) — cycle dates are the
  AIRAC dates the procedures build uses, verified against the FAA's own listing. Columns as
  the script expects (`ARPT_ID`, `ICAO_ID`, `SITE_TYPE_CODE` A/B/C/G/H/U — C is a seaplane
  base, `FACILITY_USE_CODE` PU/PR, `NOTAM_FLAG` Y/N/blank, `OWNERSHIP_TYPE_CODE` PU/PR/MA/MN/MR/CG,
  `NAV_ID`, `NAV_TYPE`, `COUNTRY_CODE`). Kept: public-use, or `NOTAM_FLAG` Y, or military-owned
  (bases are private-use in NASR but file NOTAMs — that is how KADW/KNHK get in; KNAK is not an
  airport record at all), **and only `COUNTRY_CODE` US / PR / MH / FM / PW** — NASR lists 82
  Canadian, 26 Bahamian and a few Caribbean fields, and through `locations.json` those let NAV
  CANADA's NOTAMs (CYYZ, 218 records) past the archiver's US filter. 6,112 locations after that
  cut. NASR's `NOTAM_ID` is the *accountability* (ANP's is DCA), not the location —
  `lid` is `ARPT_ID`, which is also what fixes the Alaska ids (`PAAB` ↔ `4A2`). Rebuild each
  cycle → commit the JSON; the archiver reads it at run time.

