/* ---------------------------------------------------------------------------
   Aviation Knowledge Map — jesselevine.net
   An interactive, expandable node graph of the airplane private/instrument/
   commercial knowledge domains. Concepts nest as a tree; dashed cross-links
   show relationships that jump between branches. Pure canvas, no libraries,
   no data leaves the page.
   --------------------------------------------------------------------------- */
(function () {
  'use strict';

  /* ── Domains (colour groups) ─────────────────────────────────────────── */
  const GROUPS = {
    root:   { name: 'Aviation',        color: '#e8eef6' },
    aero:   { name: 'Aerodynamics',    color: '#4a9eff' },
    power:  { name: 'Powerplant & Systems', color: '#f0a24a' },
    wx:     { name: 'Weather',         color: '#37c9e0' },
    nav:    { name: 'Navigation',      color: '#5fd08a' },
    air:    { name: 'Airspace & ATC',  color: '#b58cf0' },
    regs:   { name: 'Regulations',     color: '#f0698a' },
    perf:   { name: 'Performance & W&B', color: '#e6c84a' },
    hf:     { name: 'Human Factors',   color: '#ff8fb0' },
    man:    { name: 'Maneuvers',       color: '#48c9b0' },
    inst:   { name: 'Instruments',     color: '#8fa3c0' },
    emerg:  { name: 'Emergencies',     color: '#ff6b5e' },
  };

  /* ── Knowledge tree ──────────────────────────────────────────────────────
     n(id, label, group, summary, [children], [crossLinks])
     crossLinks are [targetId, relationshipLabel] pairs — drawn dashed when
     both endpoints are on screen.                                            */
  let _uid = 0;
  function n(label, group, summary, children, xlinks) {
    return { id: 'k' + (_uid++), label, group, s: summary || '',
             c: children || [], x: xlinks || [] };
  }

  const TREE =
  n('Aviation', 'root',
    'The whole airplane knowledge web. Click any node to expand it; dashed lines link concepts that live on different branches but drive each other. Pan by dragging the background, zoom with the wheel, and drag a node to pin it.',
  [
    /* ══ AERODYNAMICS ══════════════════════════════════════════════════ */
    n('Aerodynamics', 'aero',
      'How the wing and the air trade momentum to make lift, drag and control.',
    [
      n('Four Forces', 'aero',
        'Lift, weight, thrust and drag. In unaccelerated flight the opposing pairs are equal; any imbalance is an acceleration.',
      [
        n('Lift', 'aero', 'The aerodynamic force perpendicular to the relative wind. L = ½ρV²·S·CL — set by air density, speed², wing area and the coefficient of lift (which you fly with angle of attack).',
          [
            n('Angle of Attack', 'aero', 'Angle between the chord line and the relative wind. The pilot\'s real lift control — the wing always stalls at the same critical AoA regardless of airspeed or attitude.', [], [['xStallRef','sets stall'],['xLoadRef','raises stall speed']]),
            n('Coefficient of Lift', 'aero', 'Dimensionless lift efficiency of the airfoil at a given AoA. Rises with AoA up to the critical angle, then collapses.'),
            n('Bernoulli & Newton', 'aero', 'Two views of the same reality: faster flow over the camber means lower pressure (Bernoulli), and the wing deflects a mass of air downward (Newton\'s third law). Both are correct.'),
            (function(){ const ge = n('Ground Effect', 'aero', 'Within about one wingspan of the surface the ground interrupts downwash and wingtip vortices — induced drag drops and the wing feels more efficient. Floats on landing, tries to settle back on takeoff.', [], [['xInducedRef','cuts induced drag']]); ge.id='xGroundRef'; return ge; })(),
          ]),
        (function(){ const stall = n('Stall', 'aero', 'Airflow separates from the upper wing past the critical AoA and lift drops sharply. Always an angle-of-attack event — you can stall at any airspeed or attitude.',
          [
            n('Critical AoA', 'aero', 'The single angle where the boundary layer separates. Fixed for the airfoil; hitting it is what defines the stall.'),
            n('Stall Speed (Vs)', 'aero', 'The speed that produces critical AoA in 1-g flight. Published for a clean and landing configuration; it is a symptom, not the cause.'),
            n('Spin', 'aero', 'An aggravated stall with yaw — one wing more stalled than the other, autorotating. Recovery (PARE): Power idle, Ailerons neutral, Rudder opposite, Elevator forward.'),
            n('Load Factor & Vs', 'aero', 'Stall speed rises with the square root of load factor: a 60° bank doubles load and raises Vs by ~41%. The "accelerated stall."'),
          ]); stall.id='xStallRef'; stall.x=[['xACSlow','tested slow flight']]; return stall; })(),
        n('Drag', 'aero', 'The rearward aerodynamic force. Total drag is the sum of parasite and induced — their opposite trends with speed create the drag curve.',
          [
            n('Parasite Drag', 'aero', 'Form + skin friction + interference. Grows with the square of airspeed — the fast-flight penalty.'),
            (function(){ const ind = n('Induced Drag', 'aero', 'The price of making lift — the tilt of the lift vector from downwash and tip vortices. Greatest at low speed / high AoA, falls with speed.'); ind.id='xInducedRef'; return ind; })(),
            n('L/D max', 'aero', 'The speed where total drag is least and lift-to-drag is greatest — best glide, max endurance for a jet, and the bottom of the power curve.', [], [['xBestGlideRef','= best glide AoA']]),
            n('Region of Reversed Command', 'aero', 'Slower than L/Dmax it takes MORE power to fly slower, because induced drag is climbing. The "back of the power curve" — the low-and-slow trap on approach.'),
          ]),
        n('Thrust', 'aero', 'The propeller\'s reaction force. Excess thrust climbs the airplane; excess power sets rate of climb.', [], [['xPropRef','made by the prop']]),
        n('Weight', 'aero', 'Gravity acting at the CG. Sets required lift, and with the CG location drives stability and control.', [], [['xCGRef','acts at CG']]),
      ]),
      n('Stability & Control', 'aero',
        'Whether the airplane returns to trim on its own, and how the controls change its state.',
      [
        n('Static & Dynamic Stability', 'aero', 'Static = initial tendency after a disturbance; dynamic = what the motion does over time (damped, neutral or divergent). Trainers are positively stable in both.'),
        n('Longitudinal Stability', 'aero', 'Pitch stability, governed by CG relative to the neutral point. Forward CG = more stable, heavier controls; aft CG = twitchy and eventually unrecoverable.', [], [['xCGRef','set by CG']]),
        n('Adverse Yaw', 'aero', 'The down-aileron wing makes more lift AND more induced drag, yawing the nose away from the turn. Answered with coordinated rudder.'),
        n('Load Factor', 'aero', 'Ratio of lift to weight (g). Climbs with bank angle in a level turn (1/cos φ) and is limited by the flight envelope.',
          [], [['xManeuverRef','bounds the V-n diagram']]),
        (function(){ const lr = n('Load & Stall Link', 'aero', 'Because Vs scales with √(load factor), every increase in g — a steep turn, a pull-up, a gust — raises the speed at which the wing stalls.'); lr.id='xLoadRef'; return lr; })(),
        n('Left-Turning Tendencies', 'aero', 'Torque, P-factor, spiraling slipstream and gyroscopic precession all pull a single-engine prop plane left, strongest at high power / low speed / high AoA.', [], [['xPFactorRef','P-factor']]),
      ]),
      n('High-Speed & Wake', 'aero',
        'Effects that show up near the edges of the envelope or behind other aircraft.',
      [
        n('Wingtip Vortices', 'aero', 'Rotating air shed from a lifting wing — the core of wake turbulence. Strongest when heavy, clean and slow. Stay at or above a heavy jet\'s flight path and land beyond its touchdown point.'),
        n('Mach & Compressibility', 'aero', 'As local flow approaches the speed of sound, air compresses and shock waves form — irrelevant to trainers but the ceiling for jets (Mmo, coffin corner).'),
      ]),
    ]),

    /* ══ POWERPLANT & SYSTEMS ═════════════════════════════════════════ */
    n('Powerplant & Systems', 'power',
      'The engine and the airframe systems that keep it, and you, running.',
    [
      n('Reciprocating Engine', 'power', 'The typical four-stroke, air-cooled, horizontally-opposed piston engine: intake, compression, power, exhaust.',
        [
          n('Ignition (Magnetos)', 'power', 'Two engine-driven magnetos fire two plugs per cylinder — redundant and independent of the electrical system. The mag check finds a dead plug or bad timing.'),
          n('Carburetor & Icing', 'power', 'Venturi + fuel discharge. Fuel vaporization and pressure drop can freeze the venturi even at +20 °C in visible moisture — carb heat is the cure and the prevention.', [], [['xCarbWxRef','icing conditions']]),
          n('Fuel Injection', 'power', 'Meters fuel to each cylinder — no carb ice, but vapor-lock and hot-start quirks instead.'),
          n('Detonation & Preignition', 'power', 'Detonation = uncontrolled explosion of the charge (lean/hot/low-octane); preignition = charge lit early by a hot spot. Both destroy engines — manage with mixture, cowl flaps and correct fuel.'),
          n('Mixture & Leaning', 'power', 'Air is thinner with altitude, so the fuel/air ratio must be leaned to hold the right mixture, peak EGT and economy — and enriched before descent.', [], [['xDensAltRef','why you lean']]),
        ]),
      n('Propeller', 'power', 'An airfoil that converts engine power into thrust. Twist gives a near-constant angle of attack along the blade.',
        [
          (function(){ const p = n('Fixed vs Constant-Speed', 'power', 'Fixed-pitch is a compromise; a constant-speed prop uses a governor to hold RPM by changing blade angle — throttle sets manifold pressure (power), prop lever sets RPM.'); p.id='xPropRef'; return p; })(),
          (function(){ const pf = n('P-Factor', 'power', 'At high AoA the descending blade on the right takes a bigger bite than the ascending blade, so thrust is asymmetric and the nose yaws left.'); pf.id='xPFactorRef'; return pf; })(),
        ]),
      n('Electrical System', 'power', 'Belt-driven alternator + battery feeding a bus through a master switch. Loss of the alternator puts you on battery time — shed load.'),
      n('Fuel System', 'power', 'Tanks, selector, strainer, pump(s), primer. Sump every drain to catch water and confirm grade/colour (100LL = blue).'),
      n('Pitot-Static System', 'power', 'Ram-air pitot feeds the airspeed indicator; the static port feeds altimeter, VSI and ASI. Blockages give classic, predictable failures.', [], [['xPitotInstRef','drives 3 instruments']]),
      n('Vacuum / Gyro System', 'power', 'Engine-driven vacuum pump spins the attitude and heading gyros. A quiet failure — cross-check against the electric turn coordinator and partial-panel.', [], [['xGyroRef','spins the gyros']]),
      n('Environmental & Deice', 'power', 'Heater (exhaust shroud → CO risk), pitot heat, and on capable airplanes boots, hot props or TKS for known ice.', [], [['xIcingRef','fights airframe ice']]),
    ]),

    /* ══ WEATHER ═══════════════════════════════════════════════════════ */
    n('Weather', 'wx',
      'The atmosphere as a system you read, forecast and stay ahead of.',
    [
      n('Atmosphere & Pressure', 'wx', 'A standard day is 15 °C and 29.92" Hg at sea level, lapsing ~2 °C/1000 ft. Pressure and temperature drive everything below.',
        [
          (function(){ const da = n('Density Altitude', 'wx', 'Pressure altitude corrected for non-standard temperature — the altitude the airplane "feels." High, hot and humid = thin air = worse climb, longer roll, higher TAS for the same IAS.'); da.id='xDensAltRef'; return da; })(),
          n('Pressure Altitude', 'wx', 'Height above the standard datum plane (set 29.92). The basis for flight levels and performance charts.'),
          n('Temperature & Lapse Rate', 'wx', 'How fast air cools with height decides stability. Steep environmental lapse → unstable → convection; shallow or inverted → stable → smooth, hazy, stratus.'),
        ]),
      n('Moisture & Stability', 'wx', 'Water and vertical motion make the sky\'s mood.',
        [
          n('Dewpoint & Temp Spread', 'wx', 'The closer temperature and dewpoint, the nearer to saturation — a tight spread warns of fog, low ceilings and visible moisture.'),
          (function(){ const st = n('Stable vs Unstable', 'wx', 'Stable air resists vertical motion: stratus, steady precip, poor visibility, smooth ride. Unstable air rises freely: cumulus, showers, gusts, good visibility, turbulence.'); return st; })(),
          n('Clouds', 'wx', 'Named by height and form. Cumulus = rising, unstable; stratus = layered, stable; cirrus = ice, high. Towering cumulus warns of building convection.'),
        ]),
      n('Hazards', 'wx', 'The weather that hurts airplanes.',
        [
          (function(){ const ts = n('Thunderstorms', 'wx', 'The complete package: severe turbulence, hail, lightning, downdrafts, low-level wind shear and microbursts. Cumulus → mature → dissipating; never fly under, and give them 20 NM.'); ts.x=[['xShearRef','make wind shear']]; return ts; })(),
          (function(){ const ic = n('Airframe Icing', 'wx', 'Structural ice needs visible moisture and a surface at 0 °C or below. Rime (rough, opaque), clear (smooth, heavy) and mixed. Destroys lift and adds weight — exit the conditions.'); ic.id='xIcingRef'; ic.x=[['xCarbWxRef','same moisture']]; return ic; })(),
          (function(){ const ws = n('Wind Shear & Microburst', 'wx', 'A sudden change of wind vector with position — brutal on approach. A microburst can flip a strong headwind into a sinking tailwind in seconds.'); ws.id='xShearRef'; return ws; })(),
          (function(){ const cw = n('Icing Conditions', 'wx', 'Visible moisture (cloud, rain, wet snow) with temperatures near or below freezing — the trigger for both carburetor and airframe ice.'); cw.id='xCarbWxRef'; return cw; })(),
          n('Fog & Low IFR', 'wx', 'Radiation, advection, upslope and steam fog all cut visibility to minimums. Clear, calm, moist nights breed radiation fog by dawn.'),
        ]),
      n('Weather Products', 'wx', 'Reports you decode and forecasts you trust.',
        [
          n('METAR', 'wx', 'Hourly observation in coded form: wind, visibility, weather, sky, temp/dewpoint, altimeter. The now.', [], [['xWxSrcRef','from ground obs']]),
          n('TAF', 'wx', 'Terminal aerodrome forecast — a ~5 SM, 24–30 hr window for an airport, with FM/TEMPO/BECMG groups.'),
          n('Winds & Temps Aloft (FB)', 'wx', 'Forecast wind and temperature at fixed levels — plan groundspeed, fuel and the smoothest ride.', [], [['xWCARef','feeds wind correction']]),
          n('PIREPs & AIRMET/SIGMET', 'wx', 'Pilot reports are the only in-situ truth; AIRMETs/SIGMETs warn of widespread hazards (ice, turbulence, IFR, convection).'),
        ]),
    ]),

    /* ══ NAVIGATION ════════════════════════════════════════════════════ */
    n('Navigation', 'nav',
      'Knowing where you are, where you\'re going, and how the wind and Earth bend the path.',
    [
      n('Pilotage & Dead Reckoning', 'nav', 'Navigate by looking outside at charted landmarks (pilotage) and by computing heading/time/fuel from known wind and speed (dead reckoning).',
        [
          (function(){ const wc = n('Wind Correction / Triangle', 'nav', 'The wind triangle resolves true airspeed + wind into ground track and groundspeed, giving the crab angle (WCA) that holds course.'); wc.id='xWCARef'; return wc; })(),
          n('True–Magnetic–Compass', 'nav', 'True course from the chart, corrected by variation to magnetic, then by deviation to compass. "East is least, west is best."'),
          n('Magnetic Compass Errors', 'nav', 'Variation, deviation, dip: it leads/lags on turns (UNOS) and swings with acceleration (ANDS) — only trustworthy in steady, level, unaccelerated flight.'),
        ]),
      n('Charts', 'nav', 'The paper (and glass) picture of the world below and the system above.',
        [
          n('Sectional / TAC', 'nav', 'VFR charts: terrain, obstacles, airspace, airports and frequencies at 1:500,000 (sectional) or 1:250,000 (terminal area).', [], [['xAirspaceRef','depicts airspace']]),
          n('IFR Enroute & Approach Plates', 'nav', 'Low/high enroute charts show airways, MEAs and fixes; instrument approach procedures show how to descend to a runway in the clag.', [], [['xIAPRef','fly the procedure']]),
        ]),
      n('Radio Navigation', 'nav', 'Ground- and space-based ways to fix position.',
        [
          n('VOR', 'nav', 'VHF omnidirectional range — fly TO or FROM a station along any of 360 radials. Check with a VOT or dual-VOR; line-of-sight only.'),
          n('GPS / RNAV / WAAS', 'nav', 'Satellite navigation with RAIM/WAAS integrity, enabling area navigation, LPV approaches near ILS minima, and direct routing.', [], [['xIAPRef','flies RNAV approaches']]),
          n('ILS', 'nav', 'Localizer (lateral) + glideslope (vertical) precision approach down to 200 ft and ½ SM — the gold standard.'),
          n('DME & Transponder', 'nav', 'DME gives slant-range distance; the transponder + ADS-B paints you for ATC and traffic.', [], [['xADSBRef','ADS-B']]),
        ]),
    ]),

    /* ══ AIRSPACE & ATC ════════════════════════════════════════════════ */
    (function(){ const air = n('Airspace & ATC', 'air',
      'The invisible architecture of controlled and uncontrolled air, and who talks to whom.',
    [
      n('Airspace Classes', 'air', 'A B C D E and G — each with its own entry, equipment, weather and clearance rules.',
        [
          n('Class B / C / D', 'air', 'Terminal airspace around busy airports. B needs a clearance and Mode C/ADS-B; C/D need two-way radio contact established before entry.', [], [['xEquipRef','equipment required']]),
          n('Class E & G', 'air', 'E is controlled airspace without a tower; G is uncontrolled. The dividing floors (700/1200 AGL) set which VFR minimums apply.', [], [['xVFRminRef','sets VFR minimums']]),
          n('Special Use & TFRs', 'air', 'Prohibited, restricted, MOA, alert and warning areas — plus temporary flight restrictions. Check NOTAMs; the DC SFRA/FRZ is home turf near KANP.'),
        ]),
      (function(){ const vfr = n('VFR Weather Minimums', 'air', 'The "3-152" cloud-clearance and visibility rules that keep VFR traffic able to see and avoid — they tighten as the airspace gets busier.'); vfr.id='xVFRminRef'; return vfr; })(),
      n('ATC Services', 'air', 'Clearances, separation and advisories — the human layer.',
        [
          n('Clearances & Readbacks', 'air', 'An ATC clearance is an authorization, not an instruction to violate safety. Read back anything that keeps you clear of others or the ground.'),
          n('Flight Following', 'air', 'VFR radar advisories — traffic calls and a controller watching, workload permitting. Cheap insurance.'),
          n('Radio Phraseology', 'air', 'Who you are, where you are, what you want. Standard phraseology keeps a shared frequency unambiguous.', [], [['xCommRef','communication']]),
        ]),
      n('Airport Operations', 'air', 'The rules and rhythm of the field itself.',
        [
          n('Traffic Pattern', 'air', 'Standard left turns unless charted otherwise: upwind, crosswind, downwind, base, final. At KANP both runways are left traffic — don\'t infer the side from geometry.', [], [['xLandingRef','sets up the landing']]),
          n('Markings, Signs & Lighting', 'air', 'Runway/taxiway paint, hold-short lines, mandatory (red) and location (black) signs, VASI/PAPI glidepath lights.'),
          n('Non-Towered Ops', 'air', 'Self-announce on CTAF, standard pattern, see-and-avoid — the KANP everyday.', [], [['xCommRef','CTAF calls']]),
        ]),
    ]); return air; })(),

    /* ══ REGULATIONS ═══════════════════════════════════════════════════ */
    n('Regulations', 'regs',
      'The 14 CFR framework — who may fly, in what, when, and how currency and airworthiness are proven.',
    [
      n('Certificates & Ratings', 'regs', 'Student → private → commercial → ATP, plus instrument and category/class ratings. Each unlocks privileges and carries limits.',
        [
          n('Medical Certificates', 'regs', 'First/second/third class, or BasicMed. The medical you need matches the privileges you exercise.'),
          n('Currency & Recency', 'regs', 'Flight review every 24 mo; 3 takeoffs/landings in 90 days for passengers (night = full-stop); 6 approaches + holding + tracking in 6 mo for IFR.', [], [['xIFRRef','IFR currency']]),
        ]),
      (function(){ const aw = n('Airworthiness', 'regs', 'The airplane must be in a condition for safe flight and have required inspections done. Pilot and owner share the responsibility.',
        [
          n('Required Inspections', 'regs', 'Annual (12 mo), 100-hour if for hire, transponder (24 mo), pitot-static (24 mo for IFR), ELT (battery/12 mo), altimeter.'),
          n('Required Equipment (ATOMATOFLAMES / FLAPS)', 'regs', 'Day-VFR minimum equipment by memory aid; night adds fuses, landing light, anti-collision, position lights, source of power.'),
          n('MEL & Inoperative Equipment', 'regs', 'With no MEL, an inop item must be required-or-removed/placarded per 91.213 and a pilot/mechanic determination of safety.'),
        ]); aw.id='xEquipRef'; return aw; })(),
      n('Right-of-Way & Ops Rules', 'regs', 'Who yields (91.113), the 250 KIAS-below-10,000 limit, minimum safe altitudes (91.119), and sterile-cockpit discipline.'),
      n('Preflight Action (91.103)', 'regs', 'All available information: weather, runway lengths, performance, alternates, fuel, NOTAMs, and for IFR an alternate plan. "NWKRAFT."', [], [['xADMRef','part of good ADM']]),
    ]),

    /* ══ PERFORMANCE & W&B ═════════════════════════════════════════════ */
    n('Performance & Weight-Balance', 'perf',
      'What the airplane can actually do today, and whether it\'s loaded to do it safely.',
    [
      n('Takeoff & Landing Performance', 'perf', 'Ground roll and distance over a 50-ft obstacle from the POH charts — corrected for density altitude, weight, wind, slope and surface.', [], [['xDensAltRef','driven by density altitude']]),
      n('Climb Performance', 'perf', 'Excess thrust vs excess power: Vx (best angle, most altitude per distance — obstacle) vs Vy (best rate, most altitude per time).',
        [
          n('Vx vs Vy', 'perf', 'Vx clears the trees; Vy gets you up fastest. They converge with altitude and meet at the absolute ceiling.'),
          n('Service & Absolute Ceiling', 'perf', 'Service ceiling = 100 fpm climb remains; absolute = climb goes to zero. Both fall as weight and density altitude rise.'),
        ]),
      (function(){ const wb = n('Weight & Balance', 'perf', 'Total weight within limits AND the CG within the envelope. Moment = weight × arm; sum moments, divide by weight, find the CG.',
        [
          (function(){ const cg = n('Center of Gravity', 'perf', 'The balance point. Forward CG: stable, higher stall speed, more elevator needed to flare. Aft CG: less stable, lighter controls, worse spin recovery.'); cg.id='xCGRef'; cg.x=[['xLoadRef','affects stall speed']]; return cg; })(),
          n('Loading & Envelope', 'perf', 'Plot the loaded point on the CG envelope; shift baggage or fuel to stay inside for the whole flight as fuel burns.'),
        ]); return wb; })(),
      (function(){ const vn = n('V-Speeds & the Envelope', 'perf', 'The alphabet of airspeeds — Vso, Vs1, Vx, Vy, Va, Vno, Vne, Vfe — and the V-n diagram that bounds load factor against speed.',
        [
          n('Maneuvering Speed (Va)', 'perf', 'Below Va the wing stalls before it overstresses — full deflection is structurally safe. Va decreases as weight decreases.'),
          n('Airspeed Colour Arcs', 'perf', 'White (flap range), green (normal), yellow (caution, smooth air only), red line (never exceed) on the ASI.'),
        ]); vn.id='xManeuverRef'; return vn; })(),
    ]),

    /* ══ HUMAN FACTORS ═════════════════════════════════════════════════ */
    n('Human Factors', 'hf',
      'The pilot as the least predictable system — decision-making, physiology and illusions.',
    [
      (function(){ const adm = n('Aeronautical Decision Making', 'hf', 'A systematic approach to the mental side of flying: recognize hazards, weigh risk, decide, act, and evaluate — before the airplane decides for you.',
        [
          n('Hazardous Attitudes', 'hf', 'Anti-authority, impulsivity, invulnerability, macho, resignation — each with a spoken antidote. Naming yours is half the cure.'),
          n('Risk Management (PAVE / 5P)', 'hf', 'Pilot, Aircraft, enVironment, External pressures — and the 5P checkpoints (Plan, Plane, Pilot, Passengers, Programming) revisited in flight.'),
          n('IMSAFE & Personal Minimums', 'hf', 'Illness, Medication, Stress, Alcohol, Fatigue, Eating/Emotion — a self-check against limits you set on the ground, not in the air.'),
        ]); adm.id='xADMRef'; return adm; })(),
      n('Aeromedical Factors', 'hf', 'How altitude and stress act on the body.',
        [
          n('Hypoxia', 'hf', 'Oxygen starvation — insidious, euphoric, deadly. Regulatory oxygen above 12,500 ft (after 30 min) and always above 14,000 ft.'),
          n('Hyperventilation', 'hf', 'Over-breathing from stress blows off CO₂ — tingling, dizziness, mimics hypoxia. Slow the breathing, talk, breathe into a bag.'),
          n('Spatial Disorientation', 'hf', 'The inner ear lies without outside references — the leans, graveyard spiral, somatogravic illusion. Trust and fly the instruments.', [], [['xGyroRef','why you trust the gyros']]),
          n('Carbon Monoxide', 'hf', 'Odorless exhaust gas from a cracked heater shroud — headache, sleepiness. Cabin heat off, vents open, land.', [], [['xCORef','from the heater']]),
          n('Vision & Night', 'hf', 'Rods for night/peripheral, off-center viewing, 30-min dark adaptation, and the black-hole approach illusion.'),
        ]),
      n('Optical Illusions on Landing', 'hf', 'Runway width, up/down-sloping terrain, and featureless approaches distort your perceived glidepath — cross-check the VASI/PAPI and the numbers.', [], [['xLandingRef','bias the flare']]),
      n('Communication & CRM', 'hf', 'Single-pilot resource management: use every resource — ATC, checklists, automation, passengers — and communicate clearly.', [], [['xCommRef','clear comms']]),
    ]),

    /* ══ MANEUVERS ═════════════════════════════════════════════════════ */
    n('Flight Maneuvers', 'man',
      'The stick-and-rudder skills, from the first takeoff to the checkride tasks.',
    [
      n('Basic Airwork', 'man', 'The building blocks flown to ACS tolerances.',
        [
          n('Straight & Level / Trim', 'man', 'Hold heading and altitude by attitude + power, trimming off the pressure. The reference for everything else.'),
          n('Climbs, Descents & Turns', 'man', 'Coordinated entries and rollouts, pitch for speed, power for rate, rudder to keep the ball centered.'),
          (function(){ const sf = n('Slow Flight & Stalls', 'man', 'Flight at high AoA near the stall, and power-on/power-off stall recognition and recovery — the feel of the wing running out of margin.'); sf.id='xACSlow'; return sf; })(),
          (function(){ const ss = n('Steep Turns', 'man', '45–50° banked level turns holding altitude — a lesson in load factor, back-pressure and coordinated rudder.'); ss.x=[['xManeuverRef','loads the wing']]; return ss; })(),
        ]),
      n('Ground Reference', 'man', 'Flying precise tracks over the ground while the wind tries to blow you off them.',
        [
          n('Turns Around a Point / S-Turns', 'man', 'Vary bank to hold a constant-radius track — steepest downwind, shallowest upwind. Pure wind-drift correction.', [], [['xWCARef','wind drift']]),
          (function(){ const eop = n('Eights on Pylons', 'man', 'Hold the wingtip pinned on a pylon by flying at pivotal altitude (≈GS²/11.3) — elevator, not aileron, chases the pylon. (See the interactive explainer.)'); eop.x=[['xLDref','uses groundspeed'],['xACslowRef2','commercial task']]; return eop; })(),
        ]),
      (function(){ const ldg = n('Takeoffs & Landings', 'man', 'Normal, crosswind, short-field and soft-field variants — the parts of every flight most likely to bite.',
        [
          n('Crosswind Technique', 'man', 'Wing-low slip or crab-to-kick: aileron into the wind, opposite rudder to align with the runway. Limited by control authority and the demonstrated crosswind.', [], [['xShearRef','gusts / shear']]),
          n('Short & Soft Field', 'man', 'Short-field: max performance over an obstacle at Vx. Soft-field: weight off the wheels early, in ground effect, never stopping on soft ground.', [], [['xGroundRef','uses ground effect']]),
          n('Stabilized Approach & Go-Around', 'man', 'On speed, on glidepath, configured and trimmed by a gate altitude — or go around. The decision that prevents most landing accidents.'),
        ]); ldg.id='xLandingRef'; return ldg; })(),
      (function(){ const bg = n('Emergency Airwork', 'man', 'Best glide, engine-out field selection and the flows that live in muscle memory.'); bg.id='xBestGlideRef'; bg.x=[['xLDref','fly L/Dmax'],['xEngFailRef','engine failure']]; return bg; })(),
    ]),

    /* ══ INSTRUMENTS ═══════════════════════════════════════════════════ */
    n('Instruments & IFR', 'inst',
      'The six-pack, the glass, and flying by reference to them in cloud.',
    [
      (function(){ const ps = n('Pitot-Static Instruments', 'inst', 'Airspeed, altimeter and vertical speed — all fed by ram and static air. Understand each blockage failure by heart.',
        [
          n('Airspeed Indicator', 'inst', 'Difference between pitot (ram) and static pressure. Blocked pitot with open drain reads zero; blocked pitot+drain acts like an altimeter in a climb/descent.'),
          n('Altimeter', 'inst', 'Aneroid measuring static pressure against a set datum (Kollsman window). "High to low, look out below" — set the local setting.'),
          n('Vertical Speed Indicator', 'inst', 'Rate of static-pressure change — trend plus rate, with a lag.'),
        ]); ps.id='xPitotInstRef'; return ps; })(),
      (function(){ const gy = n('Gyroscopic Instruments', 'inst', 'Rigidity and precession put to work: attitude, heading and turn rate — spun by vacuum or electricity.',
        [
          n('Attitude Indicator', 'inst', 'The artificial horizon — pitch and bank at a glance, the master instrument in IMC.'),
          n('Heading Indicator', 'inst', 'A stable gyro heading with no compass errors — but it drifts, so reset it to the mag compass every ~15 min.'),
          n('Turn Coordinator', 'inst', 'Rate of turn and, via the inclinometer ball, coordination. Electric — your standby when vacuum quits.'),
        ]); gy.id='xGyroRef'; return gy; })(),
      n('Glass Cockpit & Automation', 'inst', 'PFD/MFD, AHRS, ADC, autopilot and moving map — more information, new failure modes, and the automation-management workload.'),
      (function(){ const ifr = n('Instrument Flying', 'inst', 'Controlling the airplane and navigating solely by reference to instruments when the world outside disappears.',
        [
          n('Scan & Control-Performance', 'inst', 'Set an attitude and power (control), verify on the performance instruments, trim — the cross-check that beats fixation and the leans.'),
          (function(){ const iap = n('Approaches & Holds', 'inst', 'Precision (ILS/LPV) and non-precision approaches, DA/MDA and missed-approach procedures, plus holding entries (direct/parallel/teardrop).'); iap.id='xIAPRef'; return iap; })(),
          n('IFR Clearances (CRAFT)', 'inst', 'Clearance limit, Route, Altitude, Frequency, Transponder — copied, read back, flown.', [], [['xCommRef','read back']]),
          (function(){ const ir = n('IFR Currency & Regs', 'inst', '6-HITS in 6 months, IPC when lapsed, alternate rules (1-2-3), and lost-comms procedure (AVEF / MEA).'); ir.id='xIFRRef'; return ir; })(),
        ]); return ifr; })(),
    ]),

    /* ══ EMERGENCIES ═══════════════════════════════════════════════════ */
    n('Emergencies', 'emerg',
      'When the plan breaks — the flows, the priorities and the decisions rehearsed cold.',
    [
      (function(){ const ef = n('Engine Failure', 'emerg', 'Pitch for best glide first, pick a field, run the restart flow (fuel, mixture, mags, primer, carb heat), then Mayday and secure. Fly the airplane all the way down.',
        [
          n('Best Glide & Field Selection', 'emerg', 'Trim to L/Dmax for maximum range, judge wind and slope, commit to a field early and fly a normal-looking pattern to it.', [], [['xBestGlideRef','L/Dmax']]),
          n('Partial Power / Restart', 'emerg', 'Diagnose fuel, air (carb ice), spark and mixture. Carb heat and mixture solve a surprising share of roughness.'),
        ]); ef.id='xEngFailRef'; return ef; })(),
      n('Fire', 'emerg', 'Engine, electrical or cabin fire flows: cut the fuel/air or the electrical source, ventilate wisely, and get on the ground.',
        [
          n('Engine Fire', 'emerg', 'Mixture idle-cutoff, fuel off, cabin heat off, then a forced landing — do not restart.'),
          (function(){ const co = n('Carbon Monoxide', 'emerg', 'Heater off, fresh-air vents open, oxygen if available, and land — the odorless killer masquerades as fatigue.'); co.id='xCORef'; return co; })(),
        ]),
      n('System Failures', 'emerg', 'Electrical, vacuum, pitot-static and gear/flap failures — recognize the pattern, shed or work around, and land where help is.',
        [
          n('Electrical Failure', 'emerg', 'Alternator warning → reduce load, run the checklist, and treat the battery as a countdown to essential-only.'),
          n('Vacuum / Partial Panel', 'emerg', 'Cover the failed gyros, fly attitude on the turn coordinator + ASI + altimeter, and get to VFR.', [], [['xGyroRef','lost gyros']]),
        ]),
      n('Unusual Attitudes & Upset', 'emerg', 'Nose-high near stall: power up, unload, level the wings. Nose-low overspeed: reduce power, level the wings, ease out — bank before pitch.', [], [['xManeuverRef','respect the envelope']]),
      n('Emergency Communication', 'emerg', 'Mayday×3 or Pan-Pan, 121.5, squawk 7700 (7500 hijack, 7600 lost comms). Aviate, navigate, then communicate — in that order.', [], [['xCommRef','the comm layer']]),
    ]),
  ]);

  /* Build a communication anchor referenced from several branches. */
  const COMM = n('Communication', 'hf', 'Clear, standard, timely radio and crew communication — the thread that ties ATC, CRM and emergencies together.');
  COMM.id = 'xCommRef';
  const ADSB = n('ADS-B', 'nav', 'Automatic Dependent Surveillance–Broadcast: your position, out to ATC and other traffic; in gives free traffic and weather (FIS-B).');
  ADSB.id = 'xADSBRef';
  const LD = n('Groundspeed & L/D', 'aero', 'Groundspeed sets pivotal altitude and glide range; L/Dmax sets best glide and endurance — the same physics behind several tasks.');
  LD.id = 'xLDref';

  /* ── Flatten tree → id/parent maps; register cross-link anchor nodes ──── */
  const NODES = {};          // id -> node
  const CHILDREN = {};       // id -> [child ids]
  const PARENT = {};         // id -> parent id
  const CROSS = [];          // {a, b, label}

  function register(node, parentId) {
    // If an anchor id already exists (declared inline), keep the first.
    if (NODES[node.id] && NODES[node.id] !== node) return;
    NODES[node.id] = node;
    PARENT[node.id] = parentId || null;
    CHILDREN[node.id] = [];
    (node.c || []).forEach(function (ch) {
      CHILDREN[node.id].push(ch.id);
      register(ch, node.id);
    });
  }
  register(TREE, null);

  // Attach floating anchors under sensible parents if not already in tree.
  [COMM, ADSB, LD].forEach(function (anchor, i) {
    if (!NODES[anchor.id]) {
      const homeParent = { xCommRef: 'k', xADSBRef: null, xLDref: null }[anchor.id];
      NODES[anchor.id] = anchor;
      CHILDREN[anchor.id] = [];
      // parent them to the domain that fits; find by group root
      const domainRoot = findDomainRoot(anchor.group);
      const p = domainRoot || TREE.id;
      PARENT[anchor.id] = p;
      CHILDREN[p].push(anchor.id);
    }
  });

  function findDomainRoot(group) {
    for (const id of CHILDREN[TREE.id]) {
      if (NODES[id].group === group) return id;
    }
    return null;
  }

  // Collect cross-links (dedup, only when both endpoints exist).
  const seenCross = new Set();
  Object.values(NODES).forEach(function (node) {
    (node.x || []).forEach(function (pair) {
      const [tgt, label] = pair;
      if (!NODES[tgt]) return;
      const key = [node.id, tgt].sort().join('|');
      if (seenCross.has(key)) return;
      seenCross.add(key);
      CROSS.push({ a: node.id, b: tgt, label: label });
    });
  });

  /* ── Live graph state ─────────────────────────────────────────────────── */
  const P = {};              // id -> {x,y,vx,vy,r,pinned}
  const expanded = new Set([TREE.id]);
  let selected = TREE.id;

  const canvas = document.getElementById('graph');
  const ctx = canvas.getContext('2d');
  const wrap = document.getElementById('graph-wrap');

  let view = { x: 0, y: 0, k: 1 };   // pan + zoom
  let W = 0, H = 0, DPR = 1;

  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = wrap.clientWidth;
    H = wrap.clientHeight;
    canvas.width = W * DPR;
    canvas.height = H * DPR;
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }

  function visibleIds() {
    // Root + children of any expanded node whose parent chain is visible.
    const vis = new Set([TREE.id]);
    const stack = [TREE.id];
    while (stack.length) {
      const id = stack.pop();
      if (expanded.has(id)) {
        CHILDREN[id].forEach(function (c) { vis.add(c); stack.push(c); });
      }
    }
    return vis;
  }

  function ensureParticle(id, parentId) {
    if (P[id]) return;
    const pp = parentId && P[parentId] ? P[parentId] : { x: W / 2, y: H / 2 };
    const ang = Math.random() * Math.PI * 2;
    P[id] = {
      x: pp.x + Math.cos(ang) * 60 + (Math.random() - 0.5) * 20,
      y: pp.y + Math.sin(ang) * 60 + (Math.random() - 0.5) * 20,
      vx: 0, vy: 0, pinned: false,
    };
  }

  function nodeRadius(id) {
    if (id === TREE.id) return 26;
    const depth = depthOf(id);
    const hasKids = CHILDREN[id].length > 0;
    let r = depth === 1 ? 19 : depth === 2 ? 13 : 10;
    if (!hasKids) r -= 1.5;
    return r;
  }

  const _depthCache = {};
  function depthOf(id) {
    if (_depthCache[id] != null) return _depthCache[id];
    let d = 0, cur = id;
    while (PARENT[cur]) { d++; cur = PARENT[cur]; }
    return (_depthCache[id] = d);
  }

  /* ── Force simulation ─────────────────────────────────────────────────── */
  function step() {
    const vis = visibleIds();
    const ids = [...vis];
    ids.forEach(function (id) { ensureParticle(id, PARENT[id]); });

    // Pin root near centre-left of view space (in world coords via view).
    const root = P[TREE.id];
    // gentle spring of root toward world-origin anchor
    const rootAnchorX = 0, rootAnchorY = 0;

    // Repulsion (only among visible)
    for (let i = 0; i < ids.length; i++) {
      const a = P[ids[i]];
      for (let j = i + 1; j < ids.length; j++) {
        const b = P[ids[j]];
        let dx = a.x - b.x, dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) { d2 = 0.01; dx = Math.random() - 0.5; dy = Math.random() - 0.5; }
        const d = Math.sqrt(d2);
        const force = 2600 / d2;
        const fx = (dx / d) * force, fy = (dy / d) * force;
        a.vx += fx; a.vy += fy;
        b.vx -= fx; b.vy -= fy;
      }
    }

    // Parent-child springs
    ids.forEach(function (id) {
      const par = PARENT[id];
      if (!par || !vis.has(par)) return;
      const a = P[id], b = P[par];
      const desired = depthOf(id) === 1 ? 150 : depthOf(id) === 2 ? 110 : 88;
      let dx = a.x - b.x, dy = a.y - b.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const diff = (d - desired) / d * 0.035;
      const fx = dx * diff, fy = dy * diff;
      a.vx -= fx; a.vy -= fy;
      b.vx += fx; b.vy += fy;
    });

    // Cross-link springs (weak) when both visible
    CROSS.forEach(function (c) {
      if (!vis.has(c.a) || !vis.has(c.b)) return;
      const a = P[c.a], b = P[c.b];
      let dx = a.x - b.x, dy = a.y - b.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const diff = (d - 240) / d * 0.006;
      a.vx -= dx * diff; a.vy -= dy * diff;
      b.vx += dx * diff; b.vy += dy * diff;
    });

    // Root spring to anchor + integrate
    root.vx += (rootAnchorX - root.x) * 0.02;
    root.vy += (rootAnchorY - root.y) * 0.02;

    ids.forEach(function (id) {
      const p = P[id];
      if (p.pinned || id === draggingId) { p.vx = 0; p.vy = 0; return; }
      p.vx *= 0.86; p.vy *= 0.86;
      // clamp
      const vmax = 40;
      p.vx = Math.max(-vmax, Math.min(vmax, p.vx));
      p.vy = Math.max(-vmax, Math.min(vmax, p.vy));
      p.x += p.vx; p.y += p.vy;
    });
  }

  /* ── Rendering ────────────────────────────────────────────────────────── */
  function worldToScreen(x, y) {
    return { x: (x + view.x) * view.k + W / 2, y: (y + view.y) * view.k + H / 2 };
  }
  function screenToWorld(sx, sy) {
    return { x: (sx - W / 2) / view.k - view.x, y: (sy - H / 2) / view.k - view.y };
  }

  let hoverId = null;

  function draw() {
    ctx.clearRect(0, 0, W, H);
    const vis = visibleIds();

    // dotted subtle background grid
    // (skip — keep it clean)

    // Cross-links first (behind)
    ctx.lineWidth = 1;
    CROSS.forEach(function (c) {
      if (!vis.has(c.a) || !vis.has(c.b)) return;
      const a = worldToScreen(P[c.a].x, P[c.a].y);
      const b = worldToScreen(P[c.b].x, P[c.b].y);
      const active = selected === c.a || selected === c.b || hoverId === c.a || hoverId === c.b;
      ctx.strokeStyle = active ? 'rgba(230,200,74,0.55)' : 'rgba(150,160,180,0.16)';
      ctx.setLineDash([4, 5]);
      // curved
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const nx = -(b.y - a.y), ny = (b.x - a.x);
      const nlen = Math.hypot(nx, ny) || 1;
      const bow = 22;
      const cx = mx + (nx / nlen) * bow, cy = my + (ny / nlen) * bow;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.quadraticCurveTo(cx, cy, b.x, b.y);
      ctx.stroke();
      if (active && c.label) {
        ctx.setLineDash([]);
        ctx.font = '10px "Segoe UI", system-ui, sans-serif';
        ctx.fillStyle = 'rgba(230,200,74,0.9)';
        ctx.textAlign = 'center';
        ctx.fillText(c.label, cx, cy - 3);
      }
    });
    ctx.setLineDash([]);

    // Parent-child edges
    ctx.lineWidth = 1.2;
    vis.forEach(function (id) {
      const par = PARENT[id];
      if (!par || !vis.has(par)) return;
      const a = worldToScreen(P[id].x, P[id].y);
      const b = worldToScreen(P[par].x, P[par].y);
      const col = GROUPS[NODES[id].group].color;
      ctx.strokeStyle = hexA(col, selected === id || selected === par ? 0.55 : 0.28);
      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(a.x, a.y);
      ctx.stroke();
    });

    // Nodes
    const order = [...vis].sort(function (a, b) { return depthOf(b) - depthOf(a); });
    // draw deeper first so root sits on top? Actually draw shallow last (on top)
    order.reverse();
    order.forEach(function (id) {
      const node = NODES[id];
      const s = worldToScreen(P[id].x, P[id].y);
      const r = nodeRadius(id) * Math.min(1.4, Math.max(0.7, view.k));
      const col = GROUPS[node.group].color;
      const isSel = id === selected;
      const isHover = id === hoverId;
      const collapsedWithKids = CHILDREN[id].length > 0 && !expanded.has(id);

      // glow for selected
      if (isSel) {
        ctx.beginPath();
        ctx.arc(s.x, s.y, r + 7, 0, Math.PI * 2);
        ctx.fillStyle = hexA(col, 0.18);
        ctx.fill();
      }

      ctx.beginPath();
      ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      ctx.fillStyle = collapsedWithKids ? hexA(col, 0.22) : hexA(col, 0.9);
      ctx.fill();
      ctx.lineWidth = isSel ? 2.5 : isHover ? 2 : 1.4;
      ctx.strokeStyle = collapsedWithKids ? col : hexA('#000000', 0.35);
      if (!collapsedWithKids && (isSel || isHover)) ctx.strokeStyle = '#fff';
      ctx.stroke();

      // "+" ring hint for collapsed-with-children
      if (collapsedWithKids) {
        ctx.fillStyle = col;
        ctx.font = 'bold ' + Math.round(r * 1.05) + 'px "Segoe UI", system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('+', s.x, s.y + 0.5);
      }

      // Label
      const depth = depthOf(id);
      const showLabel = depth <= 1 || isSel || isHover || view.k > 1.15 ||
                        (depth === 2 && view.k > 0.85);
      if (showLabel) {
        const fs = id === TREE.id ? 15 : depth === 1 ? 13 : 11.5;
        ctx.font = (isSel ? '600 ' : '') + fs + 'px "Segoe UI", system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        const label = node.label;
        const ty = s.y + r + 3;
        // text bg for readability
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = 'rgba(17,17,17,0.72)';
        ctx.fillRect(s.x - tw / 2 - 3, ty - 1, tw + 6, fs + 4);
        ctx.fillStyle = isSel ? '#fff' : isHover ? '#eee' : hexA('#e5e5e5', 0.92);
        ctx.fillText(label, s.x, ty);
      }
    });
  }

  function hexA(hex, a) {
    hex = hex.replace('#', '');
    if (hex.length === 3) hex = hex.split('').map(function (c) { return c + c; }).join('');
    const r = parseInt(hex.substr(0, 2), 16),
          g = parseInt(hex.substr(2, 2), 16),
          b = parseInt(hex.substr(4, 2), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  }

  /* ── Interaction ──────────────────────────────────────────────────────── */
  let draggingId = null;
  let panning = false;
  let last = { x: 0, y: 0 };
  let downAt = { x: 0, y: 0 };
  let moved = false;

  function pickNode(sx, sy) {
    const vis = visibleIds();
    let best = null, bestD = Infinity;
    vis.forEach(function (id) {
      const s = worldToScreen(P[id].x, P[id].y);
      const r = nodeRadius(id) * Math.min(1.4, Math.max(0.7, view.k)) + 4;
      const d = Math.hypot(sx - s.x, sy - s.y);
      if (d < r && d < bestD) { best = id; bestD = d; }
    });
    return best;
  }

  function pointerPos(e) {
    const rect = canvas.getBoundingClientRect();
    const t = e.touches ? e.touches[0] : e;
    return { x: t.clientX - rect.left, y: t.clientY - rect.top };
  }

  function onDown(e) {
    const p = pointerPos(e);
    downAt = p; moved = false;
    const hit = pickNode(p.x, p.y);
    if (hit) {
      draggingId = hit;
      P[hit].pinned = true;
    } else {
      panning = true;
    }
    last = p;
  }

  function onMove(e) {
    const p = pointerPos(e);
    if (Math.hypot(p.x - downAt.x, p.y - downAt.y) > 4) moved = true;

    if (draggingId) {
      const w = screenToWorld(p.x, p.y);
      P[draggingId].x = w.x; P[draggingId].y = w.y;
      P[draggingId].vx = 0; P[draggingId].vy = 0;
      e.preventDefault && e.preventDefault();
    } else if (panning) {
      view.x += (p.x - last.x) / view.k;
      view.y += (p.y - last.y) / view.k;
      e.preventDefault && e.preventDefault();
    } else {
      hoverId = pickNode(p.x, p.y);
      canvas.style.cursor = hoverId ? 'pointer' : 'grab';
    }
    last = p;
  }

  function onUp(e) {
    if (draggingId && !moved) {
      // treat as a click: toggle + select
      const id = draggingId;
      selectNode(id);
      if (CHILDREN[id].length) toggleExpand(id);
      P[id].pinned = false;
    } else if (draggingId && moved) {
      // leave it pinned where dropped (feels intentional); unpin after settle
      const id = draggingId;
      setTimeout(function () { if (P[id]) P[id].pinned = false; }, 1200);
    } else if (panning && !moved) {
      // click on empty — deselect
    }
    draggingId = null;
    panning = false;
  }

  function onWheel(e) {
    e.preventDefault();
    const p = pointerPos(e);
    const before = screenToWorld(p.x, p.y);
    const factor = Math.exp(-e.deltaY * 0.0012);
    view.k = Math.max(0.35, Math.min(3.2, view.k * factor));
    const after = screenToWorld(p.x, p.y);
    view.x += after.x - before.x;
    view.y += after.y - before.y;
  }

  function toggleExpand(id) {
    if (expanded.has(id)) {
      // collapse subtree
      collapseSubtree(id);
    } else {
      expanded.add(id);
      // seed children near parent
      CHILDREN[id].forEach(function (c) { ensureParticle(c, id); });
    }
  }

  function collapseSubtree(id) {
    expanded.delete(id);
    CHILDREN[id].forEach(function (c) {
      if (expanded.has(c)) collapseSubtree(c);
    });
  }

  function expandPathTo(id) {
    const chain = [];
    let cur = id;
    while (cur) { chain.push(cur); cur = PARENT[cur]; }
    chain.reverse();
    chain.forEach(function (nid) {
      if (CHILDREN[nid].length) {
        expanded.add(nid);
        CHILDREN[nid].forEach(function (c) { ensureParticle(c, nid); });
      }
    });
  }

  /* ── Info panel ───────────────────────────────────────────────────────── */
  const panelTitle = document.getElementById('info-title');
  const panelGroup = document.getElementById('info-group');
  const panelBody = document.getElementById('info-body');
  const panelLinks = document.getElementById('info-links');
  const panelPath = document.getElementById('info-path');

  function selectNode(id) {
    selected = id;
    const node = NODES[id];
    const g = GROUPS[node.group];
    panelTitle.textContent = node.label;
    panelGroup.textContent = g.name;
    panelGroup.style.background = hexA(g.color, 0.16);
    panelGroup.style.color = g.color;
    panelGroup.style.borderColor = hexA(g.color, 0.5);
    panelBody.textContent = node.s || 'No description.';

    // breadcrumb path
    const chain = [];
    let cur = id;
    while (cur) { chain.push(NODES[cur].label); cur = PARENT[cur]; }
    chain.reverse();
    panelPath.textContent = chain.join('  ›  ');

    // related links
    panelLinks.innerHTML = '';
    const rel = [];
    CROSS.forEach(function (c) {
      if (c.a === id) rel.push({ id: c.b, label: c.label });
      else if (c.b === id) rel.push({ id: c.a, label: c.label });
    });
    // also list children as quick jumps
    const kids = CHILDREN[id].slice(0, 12);
    if (rel.length || kids.length) {
      if (kids.length) {
        const h = document.createElement('div');
        h.className = 'link-head';
        h.textContent = expanded.has(id) ? 'Contains' : 'Contains (click node to expand)';
        panelLinks.appendChild(h);
        kids.forEach(function (kid) {
          panelLinks.appendChild(makeChip(kid, NODES[kid].label, NODES[kid].group));
        });
      }
      if (rel.length) {
        const h = document.createElement('div');
        h.className = 'link-head';
        h.textContent = 'Connected to';
        panelLinks.appendChild(h);
        rel.forEach(function (r) {
          panelLinks.appendChild(makeChip(r.id, NODES[r.id].label + ' · ' + r.label, NODES[r.id].group));
        });
      }
    }
  }

  function makeChip(id, text, group) {
    const el = document.createElement('button');
    el.className = 'chip';
    el.textContent = text;
    el.style.borderColor = hexA(GROUPS[group].color, 0.45);
    el.addEventListener('click', function () {
      expandPathTo(id);
      selectNode(id);
      centerOn(id);
    });
    return el;
  }

  function centerOn(id) {
    ensureParticle(id, PARENT[id]);
    const p = P[id];
    // animate view toward centering the node
    const target = { x: -p.x, y: -p.y };
    animateView(target, view.k < 0.9 ? 1.1 : view.k);
  }

  let viewAnim = null;
  function animateView(targetXY, targetK) {
    const start = { x: view.x, y: view.y, k: view.k };
    const t0 = performance.now();
    const dur = 500;
    viewAnim = function (now) {
      let t = Math.min(1, (now - t0) / dur);
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      view.x = start.x + (targetXY.x - start.x) * e;
      view.y = start.y + (targetXY.y - start.y) * e;
      view.k = start.k + (targetK - start.k) * e;
      if (t >= 1) viewAnim = null;
    };
  }
  /* ── Search ───────────────────────────────────────────────────────────── */
  const searchInput = document.getElementById('search');
  const searchResults = document.getElementById('search-results');

  function runSearch(q) {
    q = q.trim().toLowerCase();
    searchResults.innerHTML = '';
    if (!q) { searchResults.style.display = 'none'; return; }
    const hits = [];
    Object.values(NODES).forEach(function (node) {
      const inLabel = node.label.toLowerCase().indexOf(q) >= 0;
      const inBody = (node.s || '').toLowerCase().indexOf(q) >= 0;
      if (inLabel || inBody) hits.push({ node: node, score: inLabel ? 0 : 1 });
    });
    hits.sort(function (a, b) { return a.score - b.score || a.node.label.length - b.node.label.length; });
    if (!hits.length) { searchResults.style.display = 'none'; return; }
    hits.slice(0, 10).forEach(function (h) {
      const el = document.createElement('button');
      el.className = 'sr-item';
      const dot = document.createElement('span');
      dot.className = 'sr-dot';
      dot.style.background = GROUPS[h.node.group].color;
      el.appendChild(dot);
      const t = document.createElement('span');
      t.textContent = h.node.label;
      el.appendChild(t);
      const g = document.createElement('span');
      g.className = 'sr-group';
      g.textContent = GROUPS[h.node.group].name;
      el.appendChild(g);
      el.addEventListener('click', function () {
        expandPathTo(h.node.id);
        selectNode(h.node.id);
        centerOn(h.node.id);
        searchResults.style.display = 'none';
        searchInput.value = h.node.label;
      });
      searchResults.appendChild(el);
    });
    searchResults.style.display = 'block';
  }

  searchInput.addEventListener('input', function () { runSearch(this.value); });
  searchInput.addEventListener('focus', function () { if (this.value) runSearch(this.value); });
  document.addEventListener('click', function (e) {
    if (!e.target.closest('.search-box')) searchResults.style.display = 'none';
  });

  /* ── Controls ─────────────────────────────────────────────────────────── */
  document.getElementById('btn-expand').addEventListener('click', function () {
    // expand top-level domains
    CHILDREN[TREE.id].forEach(function (id) {
      if (CHILDREN[id].length) {
        expanded.add(id);
        CHILDREN[id].forEach(function (c) { ensureParticle(c, id); });
      }
    });
  });
  document.getElementById('btn-collapse').addEventListener('click', function () {
    expanded.clear();
    expanded.add(TREE.id);
    selectNode(TREE.id);
    animateView({ x: 0, y: 0 }, 1);
  });
  document.getElementById('btn-reset').addEventListener('click', function () {
    animateView({ x: 0, y: 0 }, 1);
  });

  /* ── Legend ───────────────────────────────────────────────────────────── */
  const legend = document.getElementById('legend');
  Object.keys(GROUPS).forEach(function (key) {
    if (key === 'root') return;
    const g = GROUPS[key];
    const el = document.createElement('button');
    el.className = 'leg-item';
    el.innerHTML = '<span class="leg-dot" style="background:' + g.color + '"></span>' + g.name;
    el.addEventListener('click', function () {
      const rootId = findDomainRoot(key);
      if (rootId) {
        expanded.add(TREE.id);
        expanded.add(rootId);
        CHILDREN[rootId].forEach(function (c) { ensureParticle(c, rootId); });
        selectNode(rootId);
        centerOn(rootId);
      }
    });
    legend.appendChild(el);
  });

  /* ── Wire up ──────────────────────────────────────────────────────────── */
  canvas.addEventListener('mousedown', onDown);
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  canvas.addEventListener('touchstart', onDown, { passive: false });
  canvas.addEventListener('touchmove', onMove, { passive: false });
  window.addEventListener('touchend', onUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('resize', resize);

  resize();
  // initial: expand the domains once so the map reads as a map on load
  CHILDREN[TREE.id].forEach(function (id) { ensureParticle(id, TREE.id); });
  selectNode(TREE.id);
  requestAnimationFrame(function firstFrame() {
    // patched loop with view animation support
    (function patchedLoop() {
      step();
      if (viewAnim) viewAnim(performance.now());
      draw();
      requestAnimationFrame(patchedLoop);
    })();
  });
})();
