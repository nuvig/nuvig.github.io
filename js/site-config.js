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

  // Weather hub (weather.html).
  weather: {
    timeZone: 'America/New_York',

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

    // Nearest airports that publish TAFs (KANP itself does not).
    tafStations: [
      { id: 'KMTN', label: 'Martin State' },
      { id: 'KBWI', label: 'Baltimore/Washington Intl' },
      { id: 'KDCA', label: 'Washington National' },
    ],
  },
};
