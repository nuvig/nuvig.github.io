// Site configuration — the one file to edit when pointing this project at a
// different airport. Loaded before every other script (kanp.html,
// weather.html, index.html). The Pi-side mirror of the tracker values lives
// in /etc/kanp/site.env (see pi/site.env.example).
//
// All headings/directions are DEGREES TRUE (FAA true runway alignments;
// METAR and model winds are also true), never magnetic.

const SITE = {
  // The home airport, as shown on the weather page (and first in its list).
  airport: {
    id: 'KANP', name: 'Lee · Annapolis',
    lat: 38.9429, lon: -76.5684, elevFt: 34,
    // Station whose METAR represents this field. KANP has no on-field
    // sensor, so obs come from KNAK (USNA, ~3 NM NE). Same-id if on-field.
    metarStation: 'KNAK',
    obsNote: 'no on-field sensor — obs from KNAK (USNA, ~3 NM NE)',
    runways: [{ ends: [{ name: '12', hdg: 108 }, { name: '30', hdg: 288 }], len: 2505, wid: 48 }],
  },

  // Flight tracker (kanp.html + pi/ collector).
  tracker: {
    // Field center used for distance gating and ops detection. Fitted from
    // collected ground/low-altitude ADS-B fixes, so it can differ slightly
    // from the charted airport reference point above.
    lat: 38.9422, lon: -76.5684,
    radiusNm: 60,             // study/display radius around the field

    // Single primary runway for the ops detector (multi-runway support is
    // planned; until then pick the strip that sees the traffic).
    runway: {
      // Landing direction on runway names[0], degrees true. KANP's was
      // fitted from ~2 weeks of ground/low-altitude ADS-B segments within
      // 1 nm of the field (principal course axis): 107°/287° true,
      // consistent with the charted 120/300 magnetic minus ~11°W variation.
      axisTrue: 107,
      names: ['12', '30'],    // names[0] = axisTrue direction, names[1] = reciprocal
      pattern: 'L',           // traffic-pattern side (both ends) — assume, don't infer
      papiDeg: 4.25,          // PAPI glidepath angle, both ends (steep — obstacles)
    },

    // Local rule: at KANP touch-and-gos are not permitted, so a
    // touch-and-look profile is counted as a go-around (2 ops), never a T&G.
    touchAndGosPermitted: false,

    // "At the field" gates. FIELD feeds the loose arrival/departure
    // classifier; OPS_GATES is tighter — pattern altitude (~1,000 ft MSL at
    // ~1 nm) must NOT count as a field contact, only short final, the
    // runway, and initial upwind. LOW_FT values are MSL: keep them roughly
    // field elevation + 600 / + 1,500 when re-siting.
    opsGates: { NEAR_NM: 0.8, LOW_FT: 600 },
    fieldGates: { NEAR_NM: 2.0, LOW_FT: 1500 },

    // Where the Pi exporter publishes hourly snapshots (raw.githubusercontent
    // URL of this repo's traffic-data branch).
    snapshotBase: 'https://raw.githubusercontent.com/nuvig/nuvig.github.io/traffic-data/v2',

    // Prefix for localStorage keys. Changing it discards saved settings
    // (API base, observed-aircraft notes) on visitors' browsers.
    storagePrefix: 'kanp',
  },

  // Weather hub (weather.html) + forecast discussion (discussion.html).
  weather: {
    timeZone: 'America/New_York',

    // Where the weather archive lives (AFD issuances, forecast snapshots,
    // METARs) — plain files in this repo, written hourly by the
    // wxarchive GitHub Action (.github/workflows/wxarchive.yml →
    // scripts/wxarchive.py) and served same-origin by GitHub Pages.
    // discussion.html falls back to the live NWS API + localStorage while
    // the archive is still empty.
    archiveBase: 'data/wx',

    // Nearby fields shown after the home airport. Runway hdg = FAA true
    // alignment; metarStation must report METARs on api.weather.gov.
    nearbyAirports: [
      {
        id: 'KESN', name: 'Easton/Newnam Field', lat: 38.8042, lon: -76.0690, elevFt: 72,
        metarStation: 'KESN',
        runways: [
          { ends: [{ name: '04', hdg: 31 }, { name: '22', hdg: 211 }], len: 5500, wid: 100 },
          { ends: [{ name: '15', hdg: 138 }, { name: '33', hdg: 318 }], len: 4003, wid: 100 },
        ],
      },
      {
        id: 'KFME', name: 'Tipton · Fort Meade', lat: 39.0854, lon: -76.7594, elevFt: 148,
        metarStation: 'KFME',
        // AWOS down since 2026-08-31 — weather.html skips offline fields
        // (no card, no marker, no status-line error). Remove when it is back.
        offline: true,
        runways: [{ ends: [{ name: '10', hdg: 94 }, { name: '28', hdg: 274 }], len: 3000, wid: 75 }],
      },
      {
        id: 'KCGE', name: 'Cambridge–Dorchester Rgnl', lat: 38.5393, lon: -76.0304, elevFt: 20,
        metarStation: 'KCGE',
        runways: [{ ends: [{ name: '16', hdg: 144 }, { name: '34', hdg: 324 }], len: 4477, wid: 75 }],
      },
      {
        id: 'KMTN', name: 'Martin State · Baltimore', lat: 39.3254, lon: -76.4138, elevFt: 21,
        metarStation: 'KMTN',
        runways: [{ ends: [{ name: '15', hdg: 135 }, { name: '33', hdg: 315 }], len: 6997, wid: 180 }],
      },
    ],

    // The Air Above (wx3d.html): the 3-D volume is centered HERE, not at the
    // home field — DCA is the region's natural center and the station the
    // site's forecasts verify against. The home airport still appears as a
    // labeled pin via the terrain landmark list. If you change this, rerun
    // scripts/build_wx3d_terrain.py (both boxes) — the terrain files are
    // built for this center and the page drops mismatched ones.
    wx3d: {
      id: 'KDCA', lat: 38.8521, lon: -77.0377, elevFt: 15,
      metarStation: 'KDCA',
      runwayAxisTrue: 356,   // RWY 01/19 true alignment (FAA data via OurAirports)

      // Where the hourly model snapshot lives: the wx3d-data branch of this
      // repo, written by .github/workflows/wx3dsnap.yml and read over
      // raw.githubusercontent (CORS-open) like the tracker's snapshots.
      // The page calls Open-Meteo directly only when this is unreachable or
      // hours stale. Blank it to force every visitor back onto the live API.
      snapshotBase: 'https://raw.githubusercontent.com/nuvig/nuvig.github.io/wx3d-data',
    },

    // Nearest airports that publish TAFs (KANP itself does not).
    tafStations: [
      { id: 'KMTN', label: 'Martin State' },
      { id: 'KBWI', label: 'Baltimore/Washington Intl' },
      { id: 'KDCA', label: 'Washington National' },
    ],

    // Metro-area verification stations: discussion.html's "low clouds, area"
    // row and the head of the almanac's station explorer. Order = display
    // order. These are the fields a KANP go/no-go actually cares about —
    // BWI/FME close by, ADW/DCA/GAI around the metro, W29/ESN/CGE the usual
    // training runs. Ids must match the archive: KDCA lives in obs/, the
    // rest in stations/<ID>/ (the wxarchive ring, WX_STATIONS — W29 carries
    // no K prefix there). KFME's live NWS feed is dead as of 2026-08-31, but
    // IEM healing/backfill still fills its history — keep it listed.
    // Coordinates for every METAR station the archive holds (the ring plus
    // KDCA/KNAK/KANP), for maps that place a station by id. Sources: FAA
    // airport data; accurate to well under a mile.
    stationCoords: {
      KANP: [38.9429, -76.5684], KNAK: [38.9917, -76.4894], KDCA: [38.8521, -77.0377],
      KBWI: [39.1754, -76.6683], KFME: [39.0854, -76.7594], KADW: [38.8108, -76.8670],
      KGAI: [39.1683, -77.1660], W29: [38.9761, -76.3297], KESN: [38.8042, -76.0690],
      KCGE: [38.5393, -76.0304], KMTN: [39.3254, -76.4138], KCGS: [38.9806, -76.9223],
      KAPG: [39.4662, -76.1688], KNHK: [38.2859, -76.4118], KRJD: [39.0302, -75.8662],
    },

    areaStations: [
      { id: 'KBWI', label: 'BWI Marshall' },
      { id: 'KFME', label: 'Tipton · Fort Meade' },
      { id: 'KADW', label: 'Andrews' },
      { id: 'KDCA', label: 'Washington National' },
      { id: 'KGAI', label: 'Gaithersburg' },
      { id: 'W29', label: 'Bay Bridge' },
      { id: 'KESN', label: 'Easton' },
      { id: 'KCGE', label: 'Cambridge' },
    ],
  },

  // Shared map-tile settings.
  basemap: {
    // CARTO raster basemap API key (dark_all tiles on kanp/weather/
    // discussion/procedures). CARTO began watermarking keyless raster tiles
    // "API KEY REQUIRED" in Aug 2026; this key removes it. It is a
    // client-side tile key, sent in every visitor's tile URLs by design —
    // not a secret, unlike the RapidAPI key — free to 5M tiles/month, and
    // the CARTO/OSM attribution on each map is the license condition.
    cartoKey: 'cb1_29o4_1_04d75078ff27ab3d98e60d0a',
  },
};
