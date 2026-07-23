---
id: navigation
group: nav
label: Navigation
groupName: Navigation
color: #5fd08a
order: 4
---
Knowing where you are, where you're going, and how the wind and Earth bend the path.

- Pilotage & Dead Reckoning :: Navigate by looking outside at charted landmarks (pilotage) and by computing heading/time/fuel from known wind and speed (dead reckoning).
  - Wind Correction / Triangle {#wind-correction-triangle} :: The wind triangle resolves true airspeed + wind into ground track and groundspeed, giving the crab angle (WCA) that holds course.
  - True–Magnetic–Compass :: True course from the chart, corrected by variation to magnetic, then by deviation to compass. "East is least, west is best."
  - Magnetic Compass Errors :: Variation, deviation, dip: it leads/lags on turns (UNOS) and swings with acceleration (ANDS) — only trustworthy in steady, level, unaccelerated flight.
- Charts :: The paper (and glass) picture of the world below and the system above.
  - Sectional / TAC :: VFR charts: terrain, obstacles, airspace, airports and frequencies at 1:500,000 (sectional) or 1:250,000 (terminal area). -> airspace-classes "depicts airspace"
  - IFR Enroute & Approach Plates :: Low/high enroute charts show airways, MEAs and fixes; instrument approach procedures show how to descend to a runway in the clag. -> instrument-approaches "fly the procedure"
- Radio Navigation :: Ground- and space-based ways to fix position.
  - VOR :: VHF omnidirectional range — fly TO or FROM a station along any of 360 radials. Check with a VOT or dual-VOR; line-of-sight only.
    - Radials & the OBS :: The station broadcasts 360 radials; the OBS selects a course and the CDI shows deflection left/right of it — independent of aircraft heading.
    - TO / FROM & Reverse Sensing :: The flag tells you which side of the station the selected course points to. Fly a FROM course with a TO flag and the needle senses backward — the classic trap.
    - Service Volumes :: Terminal, Low and High altitude VORs each guarantee accuracy only within charted range/altitude limits — line-of-sight, so range grows with altitude.
    - Accuracy Checks :: VOT (±4°), designated ground/airborne checkpoints (±4°/±6°), or dual-VOR cross-check (±4°) — logged for IFR currency of the receiver.
  - GPS / RNAV / WAAS :: Satellite navigation with RAIM/WAAS integrity, enabling area navigation, LPV approaches near ILS minima, and direct routing. -> instrument-approaches "flies RNAV approaches"
    - RAIM & WAAS Integrity :: RAIM uses extra satellites to self-check position; WAAS adds ground-corrected accuracy and vertical guidance, replacing the RAIM check for approaches.
    - RNAV Approach Minima :: One RNAV plate, several lines: LNAV (lateral only), LNAV/VNAV and LPV (vertical guidance) — LPV gets you near ILS 200-ft minimums. -> instrument-approaches "the approach"
    - Database & Substitution :: A current 28-day database is required to fly the procedures; GPS may substitute for DME and ADF, and for some navaids, per the AIM.
  - ILS {#ils} :: Localizer (lateral) + glideslope (vertical) precision approach down to 200 ft and ½ SM — the gold standard.
    - Localizer :: A narrow (~5°) course to the runway centerline — four times more sensitive than a VOR. Usable as a non-precision approach on its own.
    - Glideslope :: A ~3° descent path from a separate transmitter. Beware false glideslopes above the true one and never chase a flagged needle.
    - Marker Beacons & Categories :: Outer/middle markers (or DME/fixes) mark distance; CAT I/II/III define how low certified crews and equipment may go.
  - DME & Transponder :: DME gives slant-range distance; the transponder + ADS-B paints you for ATC and traffic.
    - DME & Slant Range :: Measures line-of-sight distance to the station, not ground distance — the error is largest overhead and at altitude.
    - Transponder & Modes :: Mode A (code), Mode C (altitude), Mode S (data). Codes: 1200 VFR, 7500/7600/7700 for hijack/lost-comms/emergency.
    - ADS-B Out & In :: ADS-B Out broadcasts your GPS position for surveillance (required in most controlled airspace); ADS-B In brings free traffic (TIS-B) and weather (FIS-B). -> ads-b "ADS-B"
- Flight Planning :: Turning a departure and a destination into a flyable route with times, fuel and outs.
  - Cross-Country Planning :: Choose a route and checkpoints, clear terrain and airspace, pick fuel stops, and check the whole picture — weather, NOTAMs, runway lengths and performance. -> aeronautical-decision-making "the preflight decision"
  - E6B / Flight Computer :: The mechanical or app flight computer solves the wind triangle, converts IAS↔TAS, computes time-speed-distance and fuel, and handles unit and density-altitude problems. -> wind-correction-triangle "solves the wind triangle"
  - Time, Speed, Distance & Fuel {#time-speed-distance-and-fuel} :: Leg groundspeeds give leg times; fuel burn plus reserves (VFR 30 min day / 45 min night, IFR to destination + alternate + 45 min) sizes the tanks. -> engine-and-power-loss "avoiding exhaustion"
  - Descent Planning :: The 3-to-1 rule: ~3 NM per 1,000 ft to lose. Start down early enough for a comfortable, stabilized arrival rather than a dive at the field. -> takeoffs-and-landings "a stabilized arrival"
  - Diversion & Lost Procedures :: Divert to a pre-briefed alternate on heading and time; if lost, the 5 Cs — Climb, Communicate, Confess, Comply, Conserve — and use every nav aid you have. -> communication "confess & communicate"
  - VFR Flight Plan & Flight Following :: File and open a VFR flight plan for search-and-rescue coverage (it is NOT ATC), and separately request flight following for radar traffic advisories. -> flight-following "radar advisories"
- ADS-B {#ads-b} :: Automatic Dependent Surveillance–Broadcast: your position, out to ATC and other traffic; in gives free traffic and weather (FIS-B).
