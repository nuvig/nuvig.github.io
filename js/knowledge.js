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
    frame:  { name: 'Airframe & Controls', color: '#c9a26a' },
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
            n('Load Factor & Vs', 'aero', 'Stall speed rises with the square root of load factor: a 60° bank doubles load and raises Vs by ~41%. The "accelerated stall."', [], [['xVaRef','stalls before overstress']]),
          ]); stall.id='xStallRef'; stall.x=[['xACSlow','tested slow flight']]; return stall; })(),
        n('Drag', 'aero', 'The rearward aerodynamic force. Total drag is the sum of parasite and induced — their opposite trends with speed create the drag curve.',
          [
            n('Parasite Drag', 'aero', 'Form + skin friction + interference. Grows with the square of airspeed — the fast-flight penalty.'),
            (function(){ const ind = n('Induced Drag', 'aero', 'The price of making lift — the tilt of the lift vector from downwash and tip vortices. Greatest at low speed / high AoA, falls with speed.'); ind.id='xInducedRef'; return ind; })(),
            n('L/D max', 'aero', 'The speed where total drag is least and lift-to-drag is greatest — best glide, max endurance for a jet, and the bottom of the power curve.', [], [['xBestGlideRef','= best glide AoA']]),
            (function(){ const rrc = n('Region of Reversed Command', 'aero', 'Slower than L/Dmax it takes MORE power to fly slower, because induced drag is climbing. The "back of the power curve" — the low-and-slow trap on approach.'); rrc.id='xRRCRef'; return rrc; })(),
          ]),
        n('Thrust', 'aero', 'The propeller\'s reaction force. Excess thrust climbs the airplane; excess power sets rate of climb.', [], [['xPropRef','made by the prop']]),
        n('Weight', 'aero', 'Gravity acting at the CG. Sets required lift, and with the CG location drives stability and control.', [], [['xCGRef','acts at CG']]),
      ]),
      n('Stability & Control', 'aero',
        'Whether the airplane returns to trim on its own, and how the controls change its state.',
      [
        n('Static & Dynamic Stability', 'aero', 'Static = initial tendency after a disturbance; dynamic = what the motion does over time (damped, neutral or divergent). Trainers are positively stable in both.'),
        (function(){ const ls = n('Longitudinal Stability', 'aero', 'Pitch stability, governed by CG relative to the neutral point. Forward CG = more stable, heavier controls; aft CG = twitchy and eventually unrecoverable.', [], [['xCGRef','set by CG']]); ls.id='xLongStabRef'; return ls; })(),
        (function(){ const ay = n('Adverse Yaw', 'aero', 'The down-aileron wing makes more lift AND more induced drag, yawing the nose away from the turn. Answered with coordinated rudder.'); ay.id='xAdverseYawRef'; return ay; })(),
        (function(){ const lf = n('Load Factor', 'aero', 'Ratio of lift to weight (g). Climbs with bank angle in a level turn (1/cos φ) and is limited by the flight envelope.',
          [], [['xManeuverRef','bounds the V-n diagram']]); lf.id='xLoadFactorRef'; return lf; })(),
        (function(){ const lr = n('Load & Stall Link', 'aero', 'Because Vs scales with √(load factor), every increase in g — a steep turn, a pull-up, a gust — raises the speed at which the wing stalls.'); lr.id='xLoadRef'; return lr; })(),
        n('Left-Turning Tendencies', 'aero', 'Torque, P-factor, spiraling slipstream and gyroscopic precession all pull a single-engine prop plane left, strongest at high power / low speed / high AoA.', [], [['xPFactorRef','P-factor']]),
      ]),
      n('High-Speed & Wake', 'aero',
        'Effects that show up near the edges of the envelope or behind other aircraft.',
      [
        n('Wingtip Vortices', 'aero', 'Rotating air shed from a lifting wing — the core of wake turbulence. Strongest when heavy, clean and slow. Stay at or above a heavy jet\'s flight path and land beyond its touchdown point.', [], [['xPatternRef','sequencing & spacing']]),
        n('Mach & Compressibility', 'aero', 'As local flow approaches the speed of sound, air compresses and shock waves form — irrelevant to trainers but the ceiling for jets (Mmo, coffin corner).'),
      ]),
    ]),

    /* ══ AIRFRAME & FLIGHT CONTROLS ═══════════════════════════════════ */
    n('Airframe & Flight Controls', 'frame',
      'The structure that carries the loads and the surfaces the pilot moves to steer it.',
    [
      n('Structure & Loads', 'frame', 'How the airframe is built and how flight loads travel through it to the ground and back.',
        [
          n('Fuselage Construction', 'frame', 'Truss (welded tube), monocoque (skin carries all load) and semi-monocoque (skin + stringers + bulkheads) — the near-universal metal airplane.'),
          n('Wing Structure', 'frame', 'Spars carry bending, ribs give the airfoil shape, stringers and skin carry the rest. Cantilever (internal spar) vs strut-braced; a "wet wing" is a sealed integral tank.'),
          n('Empennage', 'frame', 'The tail: vertical stabilizer + rudder for yaw, horizontal stabilizer + elevator (or a one-piece stabilator) for pitch. It provides the stabilizing tail-down force.', [], [['xLongStabRef','provides pitch stability']]),
          n('Load Paths & Fatigue', 'frame', 'Limit load = the most you should ever pull; ultimate = 1.5× that before failure. Repeated cycles fatigue metal — hence life limits and inspections.', [], [['xManeuverRef','limited by the V-n diagram'],['xEquipRef','inspection intervals']]),
        ]),
      n('Primary Flight Controls', 'frame', 'The three that move the airplane about its three axes — roll, pitch and yaw.',
        [
          n('Ailerons — Roll', 'frame', 'Move opposite each other to bank about the longitudinal axis. The down-going aileron adds lift and drag, so they generate adverse yaw.', [], [['xAdverseYawRef','cause adverse yaw']]),
          n('Elevator / Stabilator — Pitch', 'frame', 'Change the tail\'s angle of attack to pitch about the lateral axis. A stabilator is an all-moving surface with an anti-servo tab to add feel and prevent over-control.'),
          n('Rudder — Yaw', 'frame', 'Controls yaw about the vertical axis — it coordinates turns and counters adverse yaw and P-factor. It is not what turns the airplane.', [], [['xPFactorRef','counters P-factor']]),
        ]),
      n('Secondary Controls & High Lift', 'frame', 'Trim to relieve pressure, and the devices that reshape the wing for slow flight.',
        [
          n('Trim Systems', 'frame', 'Trim tabs, anti-servo tabs, servo tabs or a movable stabilizer relieve the control-pressure so the pilot doesn\'t hold force. Set for hands-off flight at a target speed.'),
          n('Flaps', 'frame', 'Plain, split, slotted and Fowler flaps raise the coefficient of lift (and drag), lowering stall speed so you can approach slower and steeper.', [], [['xStallRef','lower stall speed'],['xInducedRef','add drag']]),
          n('Leading-Edge Devices', 'frame', 'Slots and slats delay separation to a higher AoA for more usable lift; on jets they extend the low-speed envelope. Spoilers/speedbrakes do the opposite — kill lift and add drag.'),
        ]),
      n('Control Mechanics', 'frame', 'How yoke and pedals actually move the surfaces, and what limits how fast you may fly.',
        [
          n('Cables, Pushrods & Bellcranks', 'frame', 'Yoke and pedals drive the surfaces through cables, pushrods, bellcranks and stops. Control checks confirm "free and correct" before every flight.'),
          n('Flutter & Balance', 'frame', 'Surfaces are mass- and aerodynamically balanced so they don\'t flutter — a destructive resonance that Vne is set below. Never exceed the red line, especially in rough air.', [], [['xManeuverRef','why Vne exists']]),
        ]),
      n('Landing Gear & Brakes', 'frame', 'What holds the airplane up on the ground and stops it.',
        [
          n('Fixed vs Retractable', 'frame', 'Tricycle gear is stable and easy on the ground; tailwheel demands active directional control. Retractable gear cuts drag but adds a "gear-down" item that must never be skipped.'),
          n('Brakes & Tires', 'frame', 'Independent hydraulic disc brakes give differential steering; hydroplaning on a wet runway and overheating on hard braking are the traps.'),
          n('Shock Absorption', 'frame', 'Oleo (air/oil) struts, spring-steel legs or bungees absorb the touchdown and taxi loads — the reason a firm arrival isn\'t a structural one.'),
        ]),
    ]),

    /* ══ POWERPLANT & SYSTEMS ═════════════════════════════════════════ */
    n('Powerplant & Systems', 'power',
      'The engine and the airframe systems that keep it, and you, running.',
    [
      n('Reciprocating Engine', 'power', 'The typical four-stroke, air-cooled, horizontally-opposed piston engine: intake, compression, power, exhaust.',
        [
          n('Four-Stroke Cycle', 'power', 'Intake, compression, power, exhaust — two crank revolutions per power stroke. Valves, piston and ignition all timed to the crankshaft.'),
          n('Ignition (Magnetos)', 'power', 'Two engine-driven magnetos fire two plugs per cylinder — redundant and independent of the electrical system. The mag check finds a dead plug or bad timing.',
            [
              n('Dual Ignition & the Mag Check', 'power', 'Two plugs per cylinder burn the charge faster and more completely, and give redundancy. Runup drop shows plug/lead health; a rise to BOTH confirms.'),
              n('Impulse Coupling', 'power', 'A spring-and-flyweight device that retards and boosts the spark for starting, then releases at RPM — why the left mag usually carries the starting circuit.'),
            ]),
          n('Carburetor & Icing', 'power', 'Venturi + fuel discharge. Fuel vaporization and pressure drop can freeze the venturi even at +20 °C in visible moisture — carb heat is the cure and the prevention.',
            [
              n('Carb Ice Symptoms', 'power', 'Fixed-pitch: gradual RPM drop then rough running. Constant-speed: manifold-pressure drop. Applying heat first roughens (melt-through) then smooths.'),
              n('Carb Heat', 'power', 'Routes unfiltered, heated air around the exhaust into the induction. Use it as prevention on descent and low power; it enriches the mixture and costs some power.'),
            ], [['xCarbWxRef','icing conditions']]),
          n('Fuel Injection', 'power', 'Meters fuel to each cylinder — no carb ice, but vapor-lock and hot-start quirks instead.'),
          n('Detonation & Preignition', 'power', 'Detonation = uncontrolled explosion of the charge (lean/hot/low-octane); preignition = charge lit early by a hot spot. Both destroy engines — manage with mixture, cowl flaps and correct fuel.',
            [
              n('Detonation', 'power', 'The charge explodes instead of burning smoothly — from low-grade fuel, over-lean high-power, or high CHT. Enrich, reduce power, open cowl flaps, descend.'),
              n('Preignition', 'power', 'The charge lights before the plug fires, on a glowing hot spot (deposit, cracked plug). Often follows detonation; symptoms overlap — cool the cylinder.'),
            ]),
          n('Mixture & Leaning', 'power', 'Air is thinner with altitude, so the fuel/air ratio must be leaned to hold the right mixture, peak EGT and economy — and enriched before descent.',
            [
              n('EGT & Peak', 'power', 'Exhaust gas temperature peaks at the chemically correct mixture. Lean-of-peak runs cool and economical; rich-of-peak runs cooler and makes more power.'),
              n('Best Power vs Best Economy', 'power', 'Slightly rich of peak = most power (climb); at or lean of peak = best fuel flow (cruise). Full rich for takeoff at low density altitude.'),
            ], [['xDensAltRef','why you lean']]),
          n('Lubrication & Cooling', 'power', 'Oil lubricates, cools, cleans, seals and cushions; cooling fins and baffles carry the rest of the heat away. Watch oil temp/pressure and CHT together.',
            [
              n('Oil System', 'power', 'Wet or dry sump: pump, filter, cooler, pressure and temperature gauges. Low pressure + high temp = get it on the ground.'),
              n('Cooling & Cowl Flaps', 'power', 'Air-cooled via baffles and fins; cowl flaps trade cooling for drag. Shock cooling from a fast idle descent cracks cylinders.'),
            ]),
        ]),
      n('Propeller', 'power', 'An airfoil that converts engine power into thrust. Twist gives a near-constant angle of attack along the blade.',
        [
          (function(){ const p = n('Fixed vs Constant-Speed', 'power', 'Fixed-pitch is a compromise; a constant-speed prop uses a governor to hold RPM by changing blade angle — throttle sets manifold pressure (power), prop lever sets RPM.',
            [
              n('The Governor', 'power', 'Flyweights and a pilot valve meter oil to the prop hub to hold the selected RPM as load changes — on-speed, under-speed, over-speed.'),
              n('MP + RPM Order', 'power', 'Increasing power: prop (RPM) up first, then throttle (MP). Reducing: throttle back first, then prop — to avoid high MP on low RPM.'),
            ]); p.id='xPropRef'; return p; })(),
          (function(){ const pf = n('P-Factor', 'power', 'At high AoA the descending blade on the right takes a bigger bite than the ascending blade, so thrust is asymmetric and the nose yaws left.'); pf.id='xPFactorRef'; return pf; })(),
        ]),
      n('Electrical System', 'power', 'Belt-driven alternator + battery feeding a bus through a master switch. Loss of the alternator puts you on battery time — shed load.',
        [
          n('Alternator vs Generator', 'power', 'Alternators make rated output at low RPM and are lighter; both are belt-driven and field-excited. Lose the field and you lose charging.'),
          n('Battery & Master Switch', 'power', 'The battery starts the engine and buffers the bus; the split master energises the alternator field and the battery contactor.'),
          n('Bus, Breakers & Ammeter', 'power', 'Circuit breakers/fuses protect each branch; the ammeter (charge/discharge) or loadmeter tells you the alternator is carrying the load.'),
          n('Alternator Failure Flow', 'power', 'Ammeter shows discharge / low-volts light: reset once, then shed nonessential load and treat the battery as a countdown to essential-only.', [], [['xElecEmergRef','the emergency']]),
        ]),
      n('Fuel System', 'power', 'Tanks, selector, strainer, pump(s), primer. Sump every drain to catch water and confirm grade/colour (100LL = blue).',
        [
          n('Tanks, Selector & Vents', 'power', 'Feed by gravity (high wing) or pump. Manage the selector to keep the tanks balanced and unported in slips; blocked vents starve the engine.'),
          n('Fuel Pumps', 'power', 'Engine-driven pump for normal running; an electric boost/aux pump for start, takeoff, landing and as backup if the primary fails.'),
          n('Grade, Colour & Contamination', 'power', '100LL is blue, Jet-A is clear/straw — never mix. Sump every drain for water, sediment and correct colour before the first flight of the day.'),
          n('Starvation vs Exhaustion', 'power', 'Exhaustion = no fuel left (planning failure). Starvation = fuel aboard but not reaching the engine (selector, vent, pump) — both stop the prop.', [], [['xEngFailRef','engine failure']]),
        ]),
      n('Pitot-Static System', 'power', 'Ram-air pitot feeds the airspeed indicator; the static port feeds altimeter, VSI and ASI. Blockages give classic, predictable failures.',
        [
          n('Pitot Tube & Drain', 'power', 'Ram-air pressure for the ASI. Blocked pitot with an open drain reads zero; blocked pitot AND drain makes the ASI behave like an altimeter — reads high in a climb.'),
          n('Static Port', 'power', 'Ambient pressure for altimeter, VSI and ASI. A blocked static port freezes the altimeter and reverses the ASI (reads low in a climb).'),
          n('Alternate Static Source', 'power', 'Opens the system to cabin pressure if the port ices over — usually reads slightly high on altitude and airspeed. Pitot heat prevents pitot icing.'),
        ], [['xPitotInstRef','drives 3 instruments']]),
      n('Vacuum / Gyro System', 'power', 'Engine-driven vacuum pump spins the attitude and heading gyros. A quiet failure — cross-check against the electric turn coordinator and partial-panel.',
        [
          n('Vacuum Pump & Gauge', 'power', 'A dry vane pump draws air across the gyros; the suction gauge (~4.5–5.5" Hg) is the only warning you have before the gyros spin down.'),
          n('Which Gyros It Drives', 'power', 'Typically the attitude and heading indicators run on vacuum; the turn coordinator is electric — so a vacuum loss leaves you the TC, ASI and altimeter.'),
          n('Failure & Partial Panel', 'power', 'The gyros die slowly and lie convincingly — the classic killer. Cover them, fly the electric TC + pitot-static, and get to VFR.', [], [['xVacEmergRef','partial-panel']]),
        ], [['xGyroRef','spins the gyros']]),
      n('Environmental & Deice', 'power', 'Heater (exhaust shroud → CO risk), pitot heat, and on capable airplanes boots, hot props or TKS for known ice.',
        [
          n('Cabin Heat & CO Risk', 'power', 'Cabin heat is exhaust warmth through a shroud — a cracked shroud leaks carbon monoxide into the cabin. A CO detector and fresh-air vents are the defense.', [], [['xCORef','carbon monoxide']]),
          n('Anti-Ice vs De-Ice', 'power', 'Anti-ice prevents ice forming (heated pitot, hot props, TKS weeping wings); de-ice removes accreted ice (pneumatic boots). Only "known-ice" airplanes may enter icing.'),
        ], [['xIcingRef','fights airframe ice']]),
    ]),

    /* ══ WEATHER ═══════════════════════════════════════════════════════ */
    n('Weather', 'wx',
      'The atmosphere as a system you read, forecast and stay ahead of.',
    [
      n('Weather Theory & Energy', 'wx', 'The "why" beneath every report: where the atmosphere\'s energy comes from and how it moves heat and water around the planet.',
        [
          n('Solar Heating & Uneven Warming', 'wx', 'The sun heats the equator more than the poles, and land faster than water. That temperature imbalance is the engine behind every wind, front and storm.'),
          n('Global Circulation (Three Cells)', 'wx', 'Hadley, Ferrel and Polar cells carry heat poleward; their boundaries seat the subtropical highs, the prevailing westerlies and the jet stream that steer North American weather.'),
          n('The Water Cycle & Latent Heat', 'wx', 'Evaporation, condensation and precipitation move water — and the latent heat released when vapor condenses is the actual fuel that builds cumulus into thunderstorms.'),
          n('Heat Transfer', 'wx', 'Radiation warms the ground, conduction warms the air touching it, convection lifts that air in bubbles, and advection carries whole air masses horizontally — the four ways heat gets around.'),
        ]),
      n('Atmosphere & Pressure', 'wx', 'The gas the airplane flies in: its standard state, and how pressure and temperature bend performance.',
        [
          n('Standard Atmosphere (ISA)', 'wx', 'The reference day: 15 °C and 29.92" Hg at sea level, cooling ~2 °C per 1,000 ft to the tropopause. Every performance chart is corrected from it.'),
          (function(){ const da = n('Density Altitude', 'wx', 'Pressure altitude corrected for non-standard temperature — the altitude the airplane "feels." High, hot and humid = thin air = worse climb, longer roll, higher TAS for the same IAS.'); da.id='xDensAltRef'; return da; })(),
          (function(){ const pa2 = n('Pressure Altitude', 'wx', 'Height above the standard datum plane (set 29.92). The basis for flight levels and performance charts.'); pa2.id='xPressAltRef'; return pa2; })(),
          n('Altimetry & Settings', 'wx', 'Set the local altimeter (QNH) and the altimeter reads field elevation. "High to low, hot to cold, look out below" — flying toward lower pressure or colder air puts you lower than indicated.'),
          n('Temperature, Lapse Rate & Inversions', 'wx', 'The environmental lapse rate decides stability; a temperature inversion (warmer aloft) caps the air — trapping haze, fog and low-level wind shear beneath it.', [], [['xShearRef','inversion shear']]),
        ]),
      n('Moisture & Stability', 'wx', 'Water and vertical motion — the two ingredients that set the sky\'s whole mood.',
        [
          n('Dewpoint & Humidity', 'wx', 'The closer temperature and dewpoint, the nearer to saturation — a tight spread warns of fog, low ceilings and visible moisture. Cooling to the dewpoint makes cloud.'),
          n('Stability & Adiabatic Lapse', 'wx', 'Compare the parcel\'s adiabatic cooling (dry ~3 °C, moist ~1.5 °C /1000 ft) to the environment: parcel warmer than around it → it keeps rising → unstable.'),
          (function(){ const st = n('Stable vs Unstable Air', 'wx', 'Stable: stratus, steady precip, poor visibility, smooth ride. Unstable: cumulus, showers, gusts, good visibility, turbulence. Everything downstream flows from this one call.'); return st; })(),
          n('Clouds', 'wx', 'Grouped by height and by form. "Cirro/alto/strato" name the level, "cumulus" means rising, "stratus" layered, "nimbus" raining — read the sky and you read the stability.',
            [
              n('Low Clouds', 'wx', 'Bases below ~6,500 ft: stratus, stratocumulus and rain-bearing nimbostratus. Layered low cloud means stable, moist air — ceilings, poor visibility, a smooth ride.'),
              n('Middle Clouds', 'wx', 'Roughly 6,500–20,000 ft: altostratus (a grey sheet, sun a dim disc) and altocumulus. Altocumulus castellanus warns of instability aloft and afternoon storms.'),
              n('High Clouds', 'wx', 'Above ~20,000 ft and made of ice: cirrus, cirrostratus (halo) and cirrocumulus. A thickening, lowering cirrus deck is the first sign of an approaching warm front.'),
              n('Cumuliform & Vertical', 'wx', 'Cumulus → towering cumulus → cumulonimbus: the growing signature of unstable, convective air. A CB is a thunderstorm with all its hazards, whatever ATIS calls it.', [], [['xTstormRef','the CB is a storm']]),
              n('Special Clouds', 'wx', 'Lenticular (standing mountain-wave lens — smooth lift, brutal rotor nearby), rotor, mammatus (hanging pouches under a severe anvil) and fog as stratus at the surface.'),
            ]),
          n('Precipitation', 'wx', 'What falls out of the cloud, and what its form tells you about the air it fell through.',
            [
              n('Formation', 'wx', 'Drops grow by collision-coalescence in warm cloud, or by the ice-crystal process in cold cloud. It takes cloud, saturation and a way for droplets to grow large enough to fall.'),
              n('Freezing Rain & Ice Pellets', 'wx', 'A warm layer aloft over a subfreezing layer: rain that freezes on contact (freezing rain) or refreezes into ice pellets first. The classic warm-front icing trap — and a reason to climb.', [], [['xIcingRef','severe airframe icing']]),
              n('Snow, Graupel & Hail', 'wx', 'Snow from cold stable air; graupel and hail from strong convective updrafts. Hail can be thrown miles from the parent cell under the anvil.', [], [['xTstormRef','hail = strong updraft']]),
              n('Virga & Downbursts', 'wx', 'Precipitation that evaporates before reaching the ground — a marker of dry air below and a warning sign for evaporative-cooling downdrafts and dry microbursts.', [], [['xShearRef','dry microburst risk']]),
            ], [['xIcingRef','freezing rain → ice']]),
        ]),
      n('Air Masses & Fronts', 'wx', 'Big bodies of air with uniform character, and the boundaries where they collide — the engine of most flyable and unflyable weather.',
        [
          n('Air Masses', 'wx', 'Named by source region: continental/maritime (dry/moist) × polar/tropical (cold/warm). cP is cold and dry, mT warm and moist — the air mass sets the baseline before any front arrives.'),
          n('Cold Front', 'wx', 'Cold air undercuts warm, steep and fast: a narrow band of towering cumulus, showers or embedded storms, gusty wind shift, then rapid clearing and cooler, drier air behind.', [], [['xShearRef','frontal wind shift']]),
          n('Warm Front', 'wx', 'Warm air overrides cold, shallow and slow: a wide deck of lowering stratus, steady precipitation, poor visibility and — if the warm air is moist over freezing cold air — freezing rain.', [], [['xIcingRef','freezing-rain icing']]),
          n('Stationary & Occluded Fronts', 'wx', 'A stationary front stalls with a mix of both regimes; an occlusion forms as a cold front overtakes a warm one, wrapping the worst of both around the low.'),
          n('Frontal Passage Clues', 'wx', 'Wind shift (veering), temperature and dewpoint change, pressure trend (falling then rising), and the sky sequence — how you know a front went through even without a chart.'),
        ]),
      n('Wind & Circulation', 'wx', 'Why the air moves — from the planetary scale down to the ridgeline outside the window.',
        [
          n('Pressure Systems', 'wx', 'Highs (sinking, diverging, fair) and lows (rising, converging, cloudy); ridges and troughs are their elongated cousins. Circulation is clockwise-out of a high, counter-clockwise-into a low (N. hemisphere).'),
          n('Coriolis & Pressure Gradient', 'wx', 'Air accelerates from high to low pressure, then Coriolis deflects it right until the flow parallels the isobars (geostrophic). Tight isobars = strong wind.'),
          n('Local Winds', 'wx', 'Surface-level effects that override the pressure-gradient wind — the ones that actually decide the ride and the crosswind at your field.',
            [
              n('Sea & Land Breeze', 'wx', 'By day the land heats and draws cool air in off the water (sea breeze); by night it reverses. The sea-breeze front can trigger a line of afternoon cumulus along the coast.'),
              n('Valley & Mountain Winds', 'wx', 'Anabatic (up-slope) winds by day as the sun heats the slopes; katabatic (down-slope) drainage by night as cold dense air slides down — strongest and gustiest near the terrain.'),
              n('Föhn / Chinook Winds', 'wx', 'Air forced over a ridge dries and warms as it descends the lee side — strong, warm, gusty downslope wind that can raise temperatures and hide turbulence.'),
              n('Gust Fronts & Outflow', 'wx', 'The cold downdraft of a storm spreads out at the surface as a gust front — a sudden wind shift and shear well ahead of the rain. The shelf cloud is your warning.', [], [['xShearRef','low-level wind shear']]),
            ]),
          n('Mountain Wave & Rotor', 'wx', 'Stable air over a ridge sets up standing waves with smooth lift aloft but violent rotor and downdrafts below — lenticular and rotor clouds are the visible warning.', [], [['xShearRef','severe shear & downdraft']]),
          n('Winds Aloft & the Jet Stream', 'wx', 'Wind generally veers and strengthens with height; the jet stream is a fast core near the tropopause bordered by clear-air turbulence.'),
        ]),
      n('Hazards', 'wx', 'The weather that actually bends or breaks airplanes.',
        [
          (function(){ const ts = n('Thunderstorms', 'wx', 'The complete package: severe turbulence, hail, lightning, downdrafts, low-level wind shear and microbursts. Never fly under one, and give them 20 NM.',
            [
              n('Life Cycle', 'wx', 'Cumulus (updraft only) → mature (up + downdrafts, heaviest hazards, the moment it rains) → dissipating (downdraft chokes it off). Needs moisture, instability and a lift trigger.'),
              n('Types', 'wx', 'Air-mass (single-cell, brief), multicell and squall-line (a wall ahead of a cold front — the worst to cross), and the rotating supercell that spawns tornadoes and giant hail.'),
              n('Embedded & Night Storms', 'wx', 'Storms hidden in stratiform cloud or darkness — invisible to the eye, so radar, datalink and a wide berth are the only defense.'),
            ], [['xShearRef','make wind shear'],['xManeuverRef','slow to Va inside']]); ts.id='xTstormRef'; return ts; })(),
          n('Turbulence', 'wx', 'Chaotic vertical and horizontal gusts. Below maneuvering speed the wing stalls before it overstresses — slow down and ride it.',
            [
              n('Types', 'wx', 'Mechanical (wind over terrain/buildings), thermal/convective (rising bubbles), frontal and wind-shear turbulence, mountain-wave rotor, and clear-air turbulence near the jet.'),
              n('Wake Turbulence', 'wx', 'The wingtip vortices of a bigger airplane — strongest heavy, clean and slow. Stay above its path and land beyond its touchdown point.', [], [['xPatternRef','sequencing & spacing']]),
              n('Intensity & Reporting', 'wx', 'Light, moderate, severe, extreme — reported by effect on the airplane and occupants. A PIREP of the ride is worth more than any forecast.'),
            ], [['xManeuverRef','fly Va']]),
          (function(){ const ic = n('Airframe Icing', 'wx', 'Structural ice needs visible moisture and a surface at 0 °C or below. It destroys lift, adds weight and drag, and jams controls — exit the conditions early.',
            [
              n('Rime, Clear & Mixed', 'wx', 'Rime is rough and milky (small drops, fast freeze); clear is smooth, heavy and hard to shed (large drops, slow freeze); mixed is both. Clear and freezing rain are the dangerous ones.'),
              n('Effects on the Wing', 'wx', 'Even light ice disrupts the airfoil: higher stall speed at a LOWER angle of attack, more drag, less thrust — the stall can come with no warning.', [], [['xStallRef','raises stall speed']]),
              n('Freezing Rain & Drizzle', 'wx', 'Supercooled drops that freeze on contact — the fastest, heaviest accretion there is. A warm layer aloft over a cold one; climb or descend out, do not press on.'),
            ], [['xCarbWxRef','same moisture']]); ic.id='xIcingRef'; return ic; })(),
          (function(){ const ws = n('Wind Shear & Microburst', 'wx', 'A sudden change of wind vector with position — brutal on approach and departure, where you have least energy and altitude.',
            [
              n('Low-Level Wind Shear', 'wx', 'Near the surface from fronts, inversions, terrain or storms. A shift from headwind to tailwind sinks the airplane and drops the airspeed at the worst moment.'),
              n('Microburst', 'wx', 'A concentrated column of sinking air under a storm: a strong headwind and updraft, then a violent downdraft and tailwind within a mile or two. Go around early; do not try to fly through it.'),
              n('Inversion & Frontal Shear', 'wx', 'Wind shear also lurks at temperature inversions and along frontal boundaries away from any storm — smoother-looking air that still bites on final.'),
            ]); ws.id='xShearRef'; return ws; })(),
          (function(){ const cw = n('Icing Conditions', 'wx', 'Visible moisture (cloud, rain, wet snow) with temperatures near or below freezing — the trigger for both carburetor and airframe ice.'); cw.id='xCarbWxRef'; return cw; })(),
          n('Fog & Restricted Visibility', 'wx', 'Cloud at the surface, plus haze, smoke, blowing snow and dust — the quiet way an easy flight turns into an instrument approach.',
            [
              n('Radiation Fog', 'wx', 'Clear, calm, moist nights: the ground radiates heat, cools the air to its dewpoint, and by dawn the valley is socked in. Burns off with the sun and a little wind.'),
              n('Advection & Upslope Fog', 'wx', 'Advection: moist air moving over a cooler surface (coasts). Upslope: moist air pushed up rising terrain and cooled — both need wind, so they persist longer than radiation fog.'),
              n('Steam & Precipitation Fog', 'wx', 'Steam fog rises off warm water into cold air; precipitation fog forms as rain saturates cooler air beneath a warm front.'),
            ]),
        ]),
      n('Flight Categories & Minimums', 'wx', 'How reported ceiling and visibility collapse into a single go/no-go word — and the personal line you draw above the legal one.',
        [
          n('VFR / MVFR / IFR / LIFR', 'wx', 'Categories by ceiling and visibility: VFR (>3,000 ft & >5 SM), Marginal VFR (1,000–3,000 & 3–5), IFR (500–1,000 & 1–3), Low IFR (<500 ft or <1 SM). The colours on every briefing map.', [], [['xVFRminRef','vs the legal VFR minimums']]),
          n('Ceiling & Sky Cover', 'wx', 'FEW/SCT are not ceilings; the ceiling is the lowest broken or overcast layer (or vertical visibility into an obscuration). It sets MVFR/IFR and whether an approach is legal to start.'),
          n('Visibility & RVR', 'wx', 'Prevailing visibility in statute miles, or runway visual range in feet where transmissometers exist — the controlling number for approach minimums and takeoff.'),
          n('Personal Minimums', 'wx', 'Numbers you set on the ground — ceiling, visibility, wind, crosswind — above the regulatory minimums, sized to your currency, the airplane and the day. The heart of good ADM.', [], [['xADMRef','the decision framework']]),
        ]),
      n('Weather Products & Briefing', 'wx', 'How you turn the atmosphere into a go/no-go — the reports you decode and the forecasts you weigh.',
        [
          n('Weather Briefing', 'wx', 'Standard, abbreviated or outlook briefings via 1-800-WX-BRIEF / ForeFlight / aviationweather.gov — plus adverse conditions, synopsis, NOTAMs and TFRs. Required preflight information.', [], [['xADMRef','feeds the go/no-go']]),
          n('METAR', 'wx', 'The hourly (or special, SPECI) surface observation — the ground truth right now, decoded field by field.',
            [
              n('Station, Time & Modifier', 'wx', 'ICAO id, a day-hour-minute Zulu timestamp, and AUTO (unattended) or COR (corrected). Everything after is in a fixed order you can read at a glance.'),
              n('Wind Group', 'wx', 'Direction (true) and speed, gusts after a G, VRB for variable, and a variable range (e.g. 180V240). "00000KT" is calm — watch it against the runway you\'re using.'),
              n('Visibility & RVR', 'wx', 'Prevailing visibility in statute miles; runway visual range in feet (R06/2400FT) when it\'s low. The number that often decides VFR vs IFR.'),
              n('Present Weather Codes', 'wx', 'Intensity (-/+), descriptor (SH, TS, FZ, BL) and phenomenon (RA, SN, FG, BR, DZ). "-SHRA" is light rain showers; "+TSRA" is a heavy thunderstorm with rain.'),
              n('Sky Condition & Ceiling', 'wx', 'FEW/SCT/BKN/OVC by hundreds of feet AGL. The ceiling is the lowest BKN or OVC layer — the number the flight category and approach hinge on.'),
              n('Temp/Dewpoint, Altimeter & Remarks', 'wx', 'Temperature/dewpoint in °C (M for minus), altimeter after an A, then RMK — sea-level pressure, precise readings, and notes the coded body can\'t hold.'),
            ]),
          n('TAF', 'wx', 'The terminal aerodrome forecast — roughly a 5 SM bubble around one airport, and a forecast, not a promise.',
            [
              n('Validity & Issue', 'wx', 'Issued four times a day, valid 24 or 30 hours, with a day-hour/day-hour valid period. Amended (TAF AMD) when the forecast busts.'),
              n('Change Groups', 'wx', 'FM = a rapid, permanent change at a stated time; BECMG = a gradual change over a window; TEMPO = temporary fluctuations under an hour that come and go.'),
              n('Probability (PROB)', 'wx', 'PROB30/PROB40 flags a 30–40% chance of the stated conditions — usually thunderstorms or low visibility. Not used in the first hours of the forecast.'),
              n('Reading TAF vs METAR', 'wx', 'The METAR is the airport now; the TAF is that airport\'s future. Trend the two together, and weight a fresh METAR that already disagrees with the TAF.'),
            ]),
          n('Winds & Temps Aloft (FB)', 'wx', 'Forecast wind and temperature at fixed levels — pick the altitude for the best groundspeed, the smoothest ride and the freezing level.', [], [['xWCARef','feeds wind correction'],['xFuelPlanRef','plan groundspeed & fuel']]),
          n('Graphical Forecasts (GFA)', 'wx', 'The Graphical Forecast for Aviation and prog charts — the big-picture map, valid from now out to 15+ hours, that puts the coded reports in spatial context.'),
          n('PIREPs', 'wx', 'Pilot reports are the only in-situ truth — cloud tops, ride, icing, the actual bases. UA (routine) or UUA (urgent). Give them as freely as you use them.'),
          n('Radar & Datalink Weather', 'wx', 'The moving picture of the weather — and the traps in how it\'s made and delivered.',
            [
              n('NEXRAD & Echo Intensity', 'wx', 'Ground radar reflectivity in dBZ (green→red→magenta). Composite vs base reflectivity, and attenuation/shadowing behind a strong cell — never pick your way through a line on radar alone.', [], [['xTstormRef','locate the storms']]),
              n('Satellite Imagery', 'wx', 'Visible shows cloud by daylight; infrared shows cloud-top temperature (so height) day and night — cold, high tops mark the strongest convection.'),
              n('Datalink & Latency', 'wx', 'FIS-B (ADS-B In) and SiriusXM bring NEXRAD and text products to the cockpit — but the mosaic can be 5–15+ minutes old. Use it strategically, never tactically around a cell.', [], [['xADSBRef','FIS-B via ADS-B In']]),
              n('Lightning & Ceiling/Vis Products', 'wx', 'Lightning networks pinpoint active convection in real time; graphical ceiling and visibility products paint where the IFR is.'),
            ]),
          n('In-Flight Advisories', 'wx', 'The warnings issued once you\'re airborne — matched to the hazard\'s severity.',
            [
              n('AIRMET (S/T/Z)', 'wx', 'Widespread MODERATE hazards for lighter aircraft: Sierra (IFR/mountain obscuration), Tango (turbulence & surface winds) and Zulu (icing & freezing level).'),
              n('SIGMET', 'wx', 'SEVERE, non-convective hazards for all aircraft — severe turbulence or icing, widespread dust/sand, volcanic ash — issued as needed, not on a schedule.'),
              n('Convective SIGMET', 'wx', 'Thunderstorm-specific and always implying severe turbulence, icing and low-level wind shear: lines, embedded storms, or areas of heavy convection.', [], [['xTstormRef','the storms themselves']]),
              n('G-AIRMET & CWA', 'wx', 'The graphical, time-stepped G-AIRMET, and the Center Weather Advisory — a short-fuse heads-up for conditions developing over an ARTCC.'),
            ]),
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
          n('VOR', 'nav', 'VHF omnidirectional range — fly TO or FROM a station along any of 360 radials. Check with a VOT or dual-VOR; line-of-sight only.',
            [
              n('Radials & the OBS', 'nav', 'The station broadcasts 360 radials; the OBS selects a course and the CDI shows deflection left/right of it — independent of aircraft heading.'),
              n('TO / FROM & Reverse Sensing', 'nav', 'The flag tells you which side of the station the selected course points to. Fly a FROM course with a TO flag and the needle senses backward — the classic trap.'),
              n('Service Volumes', 'nav', 'Terminal, Low and High altitude VORs each guarantee accuracy only within charted range/altitude limits — line-of-sight, so range grows with altitude.'),
              n('Accuracy Checks', 'nav', 'VOT (±4°), designated ground/airborne checkpoints (±4°/±6°), or dual-VOR cross-check (±4°) — logged for IFR currency of the receiver.'),
            ]),
          n('GPS / RNAV / WAAS', 'nav', 'Satellite navigation with RAIM/WAAS integrity, enabling area navigation, LPV approaches near ILS minima, and direct routing.',
            [
              n('RAIM & WAAS Integrity', 'nav', 'RAIM uses extra satellites to self-check position; WAAS adds ground-corrected accuracy and vertical guidance, replacing the RAIM check for approaches.'),
              n('RNAV Approach Minima', 'nav', 'One RNAV plate, several lines: LNAV (lateral only), LNAV/VNAV and LPV (vertical guidance) — LPV gets you near ILS 200-ft minimums.', [], [['xIAPRef','the approach']]),
              n('Database & Substitution', 'nav', 'A current 28-day database is required to fly the procedures; GPS may substitute for DME and ADF, and for some navaids, per the AIM.'),
            ], [['xIAPRef','flies RNAV approaches']]),
          (function(){ const ils = n('ILS', 'nav', 'Localizer (lateral) + glideslope (vertical) precision approach down to 200 ft and ½ SM — the gold standard.',
            [
              n('Localizer', 'nav', 'A narrow (~5°) course to the runway centerline — four times more sensitive than a VOR. Usable as a non-precision approach on its own.'),
              n('Glideslope', 'nav', 'A ~3° descent path from a separate transmitter. Beware false glideslopes above the true one and never chase a flagged needle.'),
              n('Marker Beacons & Categories', 'nav', 'Outer/middle markers (or DME/fixes) mark distance; CAT I/II/III define how low certified crews and equipment may go.'),
            ]); ils.id='xILSNavRef'; return ils; })(),
          n('DME & Transponder', 'nav', 'DME gives slant-range distance; the transponder + ADS-B paints you for ATC and traffic.',
            [
              n('DME & Slant Range', 'nav', 'Measures line-of-sight distance to the station, not ground distance — the error is largest overhead and at altitude.'),
              n('Transponder & Modes', 'nav', 'Mode A (code), Mode C (altitude), Mode S (data). Codes: 1200 VFR, 7500/7600/7700 for hijack/lost-comms/emergency.'),
              (function(){ const ab = n('ADS-B Out & In', 'nav', 'ADS-B Out broadcasts your GPS position for surveillance (required in most controlled airspace); ADS-B In brings free traffic (TIS-B) and weather (FIS-B).'); ab.x=[['xADSBRef','ADS-B']]; return ab; })(),
            ]),
        ]),
      n('Flight Planning', 'nav', 'Turning a departure and a destination into a flyable route with times, fuel and outs.',
        [
          n('Cross-Country Planning', 'nav', 'Choose a route and checkpoints, clear terrain and airspace, pick fuel stops, and check the whole picture — weather, NOTAMs, runway lengths and performance.', [], [['xADMRef','the preflight decision']]),
          n('E6B / Flight Computer', 'nav', 'The mechanical or app flight computer solves the wind triangle, converts IAS↔TAS, computes time-speed-distance and fuel, and handles unit and density-altitude problems.', [], [['xWCARef','solves the wind triangle']]),
          (function(){ const fp = n('Time, Speed, Distance & Fuel', 'nav', 'Leg groundspeeds give leg times; fuel burn plus reserves (VFR 30 min day / 45 min night, IFR to destination + alternate + 45 min) sizes the tanks.', [], [['xEngFailRef','avoiding exhaustion']]); fp.id='xFuelPlanRef'; return fp; })(),
          n('Descent Planning', 'nav', 'The 3-to-1 rule: ~3 NM per 1,000 ft to lose. Start down early enough for a comfortable, stabilized arrival rather than a dive at the field.', [], [['xLandingRef','a stabilized arrival']]),
          n('Diversion & Lost Procedures', 'nav', 'Divert to a pre-briefed alternate on heading and time; if lost, the 5 Cs — Climb, Communicate, Confess, Comply, Conserve — and use every nav aid you have.', [], [['xCommRef','confess & communicate']]),
          n('VFR Flight Plan & Flight Following', 'nav', 'File and open a VFR flight plan for search-and-rescue coverage (it is NOT ATC), and separately request flight following for radar traffic advisories.', [], [['xFFRef','radar advisories']]),
        ]),
    ]),

    /* ══ AIRSPACE & ATC ════════════════════════════════════════════════ */
    (function(){ const air = n('Airspace & ATC', 'air',
      'The invisible architecture of controlled and uncontrolled air, and who talks to whom.',
    [
      (function(){ const ac = n('Airspace Classes', 'air', 'A B C D E and G — each with its own entry, equipment, weather and clearance rules.',
        [
          n('Class B / C / D', 'air', 'Terminal airspace around busy airports. B needs a clearance and Mode C/ADS-B; C/D need two-way radio contact established before entry.', [], [['xEquipRef','equipment required']]),
          n('Class E & G', 'air', 'E is controlled airspace without a tower; G is uncontrolled. The dividing floors (700/1200 AGL) set which VFR minimums apply.', [], [['xVFRminRef','sets VFR minimums']]),
          n('Special Use & TFRs', 'air', 'Prohibited, restricted, MOA, alert and warning areas — plus temporary flight restrictions. Check NOTAMs; the DC SFRA/FRZ is home turf near KANP.'),
        ]); ac.id='xAirspaceRef'; return ac; })(),
      (function(){ const vfr = n('VFR Weather Minimums', 'air', 'The "3-152" cloud-clearance and visibility rules that keep VFR traffic able to see and avoid — they tighten as the airspace gets busier.'); vfr.id='xVFRminRef'; return vfr; })(),
      n('ATC Services', 'air', 'Clearances, separation and advisories — the human layer.',
        [
          n('Clearances & Readbacks', 'air', 'An ATC clearance is an authorization, not an instruction to violate safety. Read back anything that keeps you clear of others or the ground.'),
          (function(){ const ff = n('Flight Following', 'air', 'VFR radar advisories — traffic calls and a controller watching, workload permitting. Cheap insurance.'); ff.id='xFFRef'; return ff; })(),
          n('Radio Phraseology', 'air', 'Who you are, where you are, what you want. Standard phraseology keeps a shared frequency unambiguous.', [], [['xCommRef','communication']]),
        ]),
      n('Airport Operations', 'air', 'The rules and rhythm of the field itself.',
        [
          (function(){ const tp = n('Traffic Pattern', 'air', 'Standard left turns unless charted otherwise: upwind, crosswind, downwind, base, final. At KANP both runways are left traffic — don\'t infer the side from geometry.', [], [['xLandingRef','sets up the landing']]); tp.id='xPatternRef'; return tp; })(),
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
          (function(){ const va = n('Maneuvering Speed (Va)', 'perf', 'Below Va the wing stalls before it overstresses — full deflection is structurally safe. Va decreases as weight decreases.'); va.id='xVaRef'; va.x=[['xShearRef','slow for turbulence']]; return va; })(),
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
          n('Hypoxia', 'hf', 'Oxygen starvation — insidious, euphoric, deadly. Regulatory oxygen above 12,500 ft (after 30 min) and always above 14,000 ft.',
            [
              n('Four Types', 'hf', 'Hypoxic (low ambient O₂ / altitude), hypemic (blood can\'t carry it — CO, anemia), stagnant (blood not moving — g, cold), histotoxic (cells can\'t use it — alcohol).', [], [['xCORef','hypemic = CO']]),
              n('Symptoms & TUC', 'hf', 'Euphoria, poor judgment, tunnel vision, cyanosis — and no alarm from the pilot. Time of useful consciousness collapses with altitude: minutes at 18,000, seconds above 30,000.'),
              n('Supplemental Oxygen (91.211)', 'hf', 'Crew O₂ above 12,500 ft after 30 min and continuously above 14,000 ft; passengers offered above 15,000 ft. Cabin altitude, not aircraft altitude, is what counts.', [], [['xPressAltRef','cabin altitude']]),
            ]),
          n('Hyperventilation', 'hf', 'Over-breathing from stress blows off CO₂ — tingling, dizziness, mimics hypoxia. Slow the breathing, talk, breathe into a bag.'),
          (function(){ const sd = n('Spatial Disorientation', 'hf', 'The inner ear lies without outside references — the vestibular and visual systems disagree and the pilot loses the horizon.',
            [
              n('The Leans', 'hf', 'A slow roll goes unfelt, so rolling level feels like a bank the other way. The most common illusion — believe the attitude indicator, not the seat.'),
              n('Graveyard Spiral', 'hf', 'In a prolonged turn the sensation of turning fades; correcting the resulting altitude loss by pulling only tightens the descending spiral.'),
              n('Somatogravic Illusion', 'hf', 'Forward acceleration (a go-around, takeoff into a black hole) feels like a pitch-up, tempting a dangerous push-over. Deceleration feels like a dive.'),
              n('Coriolis Illusion', 'hf', 'Moving your head during a turn tumbles the fluid in all three canals at once — an overwhelming false rotation. Keep head movements slow in IMC.'),
            ], [['xGyroRef','why you trust the gyros']]); sd.id='xSpatialRef'; return sd; })(),
          n('Carbon Monoxide', 'hf', 'Odorless exhaust gas from a cracked heater shroud — headache, sleepiness. Cabin heat off, vents open, land.', [], [['xCORef','from the heater']]),
          n('Fatigue & IMSAFE Physiology', 'hf', 'Acute vs chronic fatigue erodes judgment and reaction like alcohol; add hypoglycemia, dehydration and stress. The body\'s limits belong on the ground checklist.'),
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
          (function(){ const ss = n('Steep Turns', 'man', '45–50° banked level turns holding altitude — a lesson in load factor, back-pressure and coordinated rudder.'); ss.x=[['xManeuverRef','loads the wing'],['xLoadFactorRef','2 g at 60°'],['xVaRef','stay below Va']]; return ss; })(),
        ]),
      n('Ground Reference', 'man', 'Flying precise tracks over the ground while the wind tries to blow you off them.',
        [
          n('Turns Around a Point / S-Turns', 'man', 'Vary bank to hold a constant-radius track — steepest downwind, shallowest upwind. Pure wind-drift correction.', [], [['xWCARef','wind drift']]),
          (function(){ const eop = n('Eights on Pylons', 'man', 'Hold the wingtip pinned on a pylon by flying at pivotal altitude (≈GS²/11.3) — elevator, not aileron, chases the pylon. (See the interactive explainer.)'); eop.x=[['xLDref','uses groundspeed']]; return eop; })(),
        ]),
      (function(){ const ldg = n('Takeoffs & Landings', 'man', 'Normal, crosswind, short-field and soft-field variants — the parts of every flight most likely to bite.',
        [
          n('Crosswind Technique', 'man', 'Wing-low slip or crab-to-kick: aileron into the wind, opposite rudder to align with the runway. Limited by control authority and the demonstrated crosswind.', [], [['xShearRef','gusts / shear']]),
          n('Short & Soft Field', 'man', 'Short-field: max performance over an obstacle at Vx. Soft-field: weight off the wheels early, in ground effect, never stopping on soft ground.', [], [['xGroundRef','uses ground effect'],['xRRCRef','flown behind the curve']]),
          n('Stabilized Approach & Go-Around', 'man', 'On speed, on glidepath, configured and trimmed by a gate altitude — or go around. The decision that prevents most landing accidents.', [], [['xRRCRef','low-and-slow trap']]),
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
      n('Glass Cockpit & Automation', 'inst', 'PFD/MFD, AHRS, ADC, autopilot and moving map — more information, new failure modes, and the automation-management workload.',
        [
          n('PFD & MFD', 'inst', 'The primary flight display paints attitude, air data and navigation on one screen; the multi-function display carries the moving map, engine and systems pages.'),
          n('AHRS & ADC', 'inst', 'Solid-state boxes replace spinning gyros: the AHRS derives attitude and heading, the air data computer derives airspeed, altitude and VSI from the pitot-static system.', [], [['xPitotInstRef','air data source']]),
          n('Autopilot & Flight Director', 'inst', 'The flight director commands pitch/roll bars to follow; the autopilot flies them. Know the modes armed vs captured — mode confusion is a modern killer.'),
          n('GPS / FMS Navigator', 'inst', 'The IFR navigator sequences the flight plan, loads and flies approaches, and drives the CDI/autopilot. Verify the active leg and the approach loaded, every time.', [], [['xIAPRef','loads the approach']]),
          n('Automation Management', 'inst', 'Choose the right level of automation for the workload, cross-check what the box is doing against raw data, and be ready to hand-fly when it surprises you.'),
        ]),
      (function(){ const ifr = n('Instrument Flying', 'inst', 'Controlling the airplane and navigating solely by reference to instruments when the world outside disappears — the whole IFR discipline, gate to gate.',
        [
          n('Attitude Instrument Flying', 'inst', 'Flying precise attitudes off the panel instead of the horizon — the motor skill under everything else in IMC.',
            [
              n('Control & Performance Method', 'inst', 'Set a known attitude + power on the control instruments (AI, tach/MP), then check the result on the performance instruments (ASI, ALT, VSI, HI) and trim it off.'),
              n('Primary & Supporting Instruments', 'inst', 'In each phase one instrument is "primary" for pitch, bank and power (e.g. straight-and-level: ALT primary pitch, HI primary bank), the rest support it. Interpretation, not staring.'),
              n('The Scan & Its Errors', 'inst', 'A disciplined cross-check across the panel. Fixation (locking on one), omission (ignoring one) and emphasis (over-trusting one) are the three ways the scan breaks down.'),
              n('Partial Panel & Unusual Attitudes', 'inst', 'Lose the AI/HI and fly the electric turn coordinator, ASI and altimeter; recover unusual attitudes by the ASI trend — power/pitch/bank — reading the raw instruments, not your ears.', [], [['xVacEmergRef','vacuum failure'],['xGyroRef','failed gyros']]),
            ]),
          n('Clearance & Departure', 'inst', 'Getting into the system and safely off the ground into the clag.',
            [
              n('The Clearance (CRAFT)', 'inst', 'Clearance limit, Route, Altitude, Frequency, Transponder — copied, read back, and flown exactly as issued until amended.', [], [['xCommRef','read back']]),
              n('Void Times & Release', 'inst', 'From a non-towered field ATC issues a clearance void time and often a hold-for-release — be airborne before the void time or the clearance evaporates.'),
              n('ODP vs SID', 'inst', 'Obstacle Departure Procedures protect you from terrain and are pilot-selected; Standard Instrument Departures are ATC routings. Know which applies before you roll.'),
              n('Climb Gradients & the Trouble-T', 'inst', 'The plate\'s trouble-T flags a non-standard takeoff minimum or a required climb gradient (ft/NM) — convert it to fpm at your groundspeed and confirm you can make it.'),
            ]),
          n('Enroute', 'inst', 'Navigating the IFR structure between departure and approach.',
            [
              n('Airways & Fixes', 'inst', 'Victor airways (VOR) and T-routes (GPS) connect fixes and intersections. Fly the centerline; RNAV lets you go direct where terrain and airspace allow.'),
              n('IFR Altitudes', 'inst', 'MEA (guaranteed nav + obstacle), MOCA (obstacle, nav within 22 NM), MRA (reception), MCA (cross at/above), and OROCA off-route terrain clearance — the alphabet that keeps you high enough.'),
              n('Position Reporting', 'inst', 'In non-radar or on request: name, position, time, altitude, next fix + ETA, and the fix after. Plus the mandatory reports ATC never has to ask for.', [], [['xCommRef','required reports']]),
              n('Descent & STAR', 'inst', 'Standard Terminal Arrival Routes and descent clearances (pilot\'s vs ATC\'s discretion, "descend via") bridge enroute to the approach — plan the top of descent early.'),
            ]),
          n('Holding', 'inst', 'Parking in the sky on a protected racetrack when the system needs you to wait.',
            [
              n('Entry Types', 'inst', 'Direct, parallel and teardrop entries, chosen by your inbound heading relative to the holding course (the ±70° rule). Visualize the pattern before you arrive at the fix.'),
              n('Timing & Leg Lengths', 'inst', 'Standard right turns, 1-minute legs at/below 14,000 ft (1½ above), or a DME/RNAV leg length. Start timing abeam the fix or wings-level, whichever is later.'),
              n('Wind Correction in the Hold', 'inst', 'Drift on the outbound leg is corrected by tripling the inbound crab, and outbound timing is adjusted to make the inbound leg come out right.', [], [['xWCARef','crab & drift']]),
              n('EFC & Holding Fuel', 'inst', 'Expect-Further-Clearance time is your lost-comms trigger; watch holding fuel against your alternate + reserve and speak up before it bites.'),
            ]),
          (function(){ const iap = n('Instrument Approaches', 'inst', 'The descent from the enroute structure to a runway you can\'t see until the end — the highest-workload minutes in IFR.',
            [
              n('Precision vs Non-Precision', 'inst', 'Precision/APV (ILS, LPV, LNAV/VNAV) give vertical guidance to a Decision Altitude; non-precision (LOC, VOR, LNAV, RNP) step you down to a Minimum Descent Altitude.', [], [['xILSNavRef','ILS provides both']]),
              n('Approach Segments', 'inst', 'Feeder → Initial (IAF) → Intermediate (IF) → Final (FAF) → Missed (MAP). Each segment has its own obstacle clearance and altitude.'),
              n('Minimums: DA vs MDA', 'inst', 'At the DA you decide and may momentarily descend below in the go-around; at the MDA you must not descend until the runway environment and required visibility are in sight.'),
              n('Landing from the Approach (91.175)', 'inst', 'Below MDA/DA needs three things: flight visibility at or above minimums, a normal descent to the intended runway, and a listed visual reference (threshold, TDZ, VASI, lights…).', [], [['xLandingRef','the landing']]),
              n('The Missed Approach', 'inst', 'Not in sight, or unstable, at the MAP/DA → cram, climb, clean, and fly the published miss (or ATC\'s). Brief it before you start down so it\'s a reflex, not a decision.'),
              n('Circling Approach', 'inst', 'Maneuvering visually to a runway not aligned with the final course, at circling MDA, staying within the protected radius for your approach category and never descending until in the slot.'),
            ]); iap.id='xIAPRef'; return iap; })(),
          (function(){ const ir = n('IFR Regulations & Currency', 'inst', 'The rules that decide whether you and the airplane may legally launch into the system today.',
            [
              n('Currency: 6-HITS & IPC', 'inst', 'In the last 6 months: 6 approaches, Holding, Intercepting and Tracking courses — in actual or a view-limiting device. Lapse it and you need an Instrument Proficiency Check.'),
              n('Alternate Requirements (1-2-3)', 'inst', 'File an alternate unless, ±1 hr of ETA, the ceiling is ≥2,000 ft and visibility ≥3 SM. Alternate minimums default 600-2 (precision) / 800-2 (non-precision) unless charted otherwise.', [], [['xFuelPlanRef','plan the fuel']]),
              n('IFR Fuel Requirements', 'inst', 'Enough to reach the destination, then the alternate, then 45 minutes at normal cruise (91.167) — the number that sizes the whole flight.', [], [['xFuelPlanRef','fuel planning']]),
              n('Lost Communications', 'inst', 'Squawk 7600, continue VFR if able; if IMC fly Route (Assigned→Vectored→Expected→Filed) and Altitude (highest of Assigned, MEA, Expected), and arrive per your clearance/EFC.', [], [['xCommRef','the comm failure']]),
              n('Required Reports to ATC', 'inst', 'Reports ATC never has to ask for: leaving an altitude, unable to climb/descend 500 fpm, missed approach, loss of nav/comm, unforecast weather, safety of flight, and more.'),
            ]); ir.id='xIFRRef'; return ir; })(),
          n('The IFR Environment', 'inst', 'The conditions that make instrument flight necessary — and dangerous.',
            [
              n('IMC, VMC & VFR-into-IMC', 'inst', 'Instrument vs visual meteorological conditions. A VFR pilot continuing into IMC is one of aviation\'s deadliest chains — the case for the rating and the 180° turn.', [], [['xSpatialRef','disorientation sets in'],['xADMRef','the decision chain']]),
              n('Structural Icing & IFR', 'inst', 'IFR routinely means cloud near freezing. Without known-ice equipment, an IFR flight plan is not a license to enter icing — plan the escape (warmer air, lower, out).', [], [['xIcingRef','airframe ice']]),
              n('Ceiling, Visibility & RVR', 'inst', 'Reported ceiling and visibility (or runway visual range) decide whether the approach is even legal to start and continue — and RVR governs where it\'s available.'),
            ]),
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
          (function(){ const ef2 = n('Electrical Failure', 'emerg', 'Alternator warning → reduce load, run the checklist, and treat the battery as a countdown to essential-only.'); ef2.id='xElecEmergRef'; return ef2; })(),
          (function(){ const vp = n('Vacuum / Partial Panel', 'emerg', 'Cover the failed gyros, fly attitude on the turn coordinator + ASI + altimeter, and get to VFR.', [], [['xGyroRef','lost gyros']]); vp.id='xVacEmergRef'; return vp; })(),
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
