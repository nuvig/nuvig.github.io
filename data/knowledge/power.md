---
id: powerplant-and-systems
group: power
label: Powerplant & Systems
groupName: Powerplant & Systems
color: #f0a24a
order: 2
---
The engine and the airframe systems that keep it, and you, running.

- Reciprocating Engine :: The typical four-stroke, air-cooled, horizontally-opposed piston engine: intake, compression, power, exhaust.
  - Four-Stroke Cycle :: Intake, compression, power, exhaust — two crank revolutions per power stroke. Valves, piston and ignition all timed to the crankshaft.
  - Ignition (Magnetos) :: Two engine-driven magnetos fire two plugs per cylinder — redundant and independent of the electrical system. The mag check finds a dead plug or bad timing.
    - Dual Ignition & the Mag Check :: Two plugs per cylinder burn the charge faster and more completely, and give redundancy. Runup drop shows plug/lead health; a rise to BOTH confirms.
    - Impulse Coupling :: A spring-and-flyweight device that retards and boosts the spark for starting, then releases at RPM — why the left mag usually carries the starting circuit.
  - Carburetor & Icing :: Venturi + fuel discharge. Fuel vaporization and pressure drop can freeze the venturi even at +20 °C in visible moisture — carb heat is the cure and the prevention. -> icing-conditions "icing conditions"
    - Carb Ice Symptoms :: Fixed-pitch: gradual RPM drop then rough running. Constant-speed: manifold-pressure drop. Applying heat first roughens (melt-through) then smooths.
    - Carb Heat :: Routes unfiltered, heated air around the exhaust into the induction. Use it as prevention on descent and low power; it enriches the mixture and costs some power.
  - Fuel Injection :: Meters fuel to each cylinder — no carb ice, but vapor-lock and hot-start quirks instead.
  - Detonation & Preignition :: Detonation = uncontrolled explosion of the charge (lean/hot/low-octane); preignition = charge lit early by a hot spot. Both destroy engines — manage with mixture, cowl flaps and correct fuel.
    - Detonation :: The charge explodes instead of burning smoothly — from low-grade fuel, over-lean high-power, or high CHT. Enrich, reduce power, open cowl flaps, descend.
    - Preignition :: The charge lights before the plug fires, on a glowing hot spot (deposit, cracked plug). Often follows detonation; symptoms overlap — cool the cylinder.
  - Mixture & Leaning :: Air is thinner with altitude, so the fuel/air ratio must be leaned to hold the right mixture, peak EGT and economy — and enriched before descent. -> density-altitude "why you lean"
    - EGT & Peak :: Exhaust gas temperature peaks at the chemically correct mixture. Lean-of-peak runs cool and economical; rich-of-peak runs cooler and makes more power.
    - Best Power vs Best Economy :: Slightly rich of peak = most power (climb); at or lean of peak = best fuel flow (cruise). Full rich for takeoff at low density altitude.
  - Lubrication & Cooling :: Oil lubricates, cools, cleans, seals and cushions; cooling fins and baffles carry the rest of the heat away. Watch oil temp/pressure and CHT together.
    - Oil System :: Wet or dry sump: pump, filter, cooler, pressure and temperature gauges. Low pressure + high temp = get it on the ground.
    - Cooling & Cowl Flaps :: Air-cooled via baffles and fins; cowl flaps trade cooling for drag. Shock cooling from a fast idle descent cracks cylinders.
- Propeller :: An airfoil that converts engine power into thrust. Twist gives a near-constant angle of attack along the blade.
  - Fixed vs Constant-Speed {#fixed-vs-constant-speed} :: Fixed-pitch is a compromise; a constant-speed prop uses a governor to hold RPM by changing blade angle — throttle sets manifold pressure (power), prop lever sets RPM.
    - The Governor :: Flyweights and a pilot valve meter oil to the prop hub to hold the selected RPM as load changes — on-speed, under-speed, over-speed.
    - MP + RPM Order :: Increasing power: prop (RPM) up first, then throttle (MP). Reducing: throttle back first, then prop — to avoid high MP on low RPM.
  - P-Factor {#p-factor} :: At high AoA the descending blade on the right takes a bigger bite than the ascending blade, so thrust is asymmetric and the nose yaws left.
- Electrical System :: Belt-driven alternator + battery feeding a bus through a master switch. Loss of the alternator puts you on battery time — shed load.
  - Alternator vs Generator :: Alternators make rated output at low RPM and are lighter; both are belt-driven and field-excited. Lose the field and you lose charging.
  - Battery & Master Switch :: The battery starts the engine and buffers the bus; the split master energises the alternator field and the battery contactor.
  - Bus, Breakers & Ammeter :: Circuit breakers/fuses protect each branch; the ammeter (charge/discharge) or loadmeter tells you the alternator is carrying the load.
  - Alternator Failure Flow :: Ammeter shows discharge / low-volts light: reset once, then shed nonessential load and treat the battery as a countdown to essential-only. -> electrical-failure "the emergency"
- Fuel System :: Tanks, selector, strainer, pump(s), primer. Sump every drain to catch water and confirm grade/colour (100LL = blue).
  - Tanks, Selector & Vents :: Feed by gravity (high wing) or pump. Manage the selector to keep the tanks balanced and unported in slips; blocked vents starve the engine.
  - Fuel Pumps :: Engine-driven pump for normal running; an electric boost/aux pump for start, takeoff, landing and as backup if the primary fails.
  - Grade, Colour & Contamination :: 100LL is blue, Jet-A is clear/straw — never mix. Sump every drain for water, sediment and correct colour before the first flight of the day.
  - Starvation vs Exhaustion :: Exhaustion = no fuel left (planning failure). Starvation = fuel aboard but not reaching the engine (selector, vent, pump) — both stop the prop. -> engine-and-power-loss "engine failure"
- Pitot-Static System :: Ram-air pitot feeds the airspeed indicator; the static port feeds altimeter, VSI and ASI. Blockages give classic, predictable failures. -> pitot-static-instruments "drives 3 instruments"
  - Pitot Tube & Drain :: Ram-air pressure for the ASI. Blocked pitot with an open drain reads zero; blocked pitot AND drain makes the ASI behave like an altimeter — reads high in a climb.
  - Static Port :: Ambient pressure for altimeter, VSI and ASI. A blocked static port freezes the altimeter and reverses the ASI (reads low in a climb).
  - Alternate Static Source :: Opens the system to cabin pressure if the port ices over — usually reads slightly high on altitude and airspeed. Pitot heat prevents pitot icing.
- Vacuum / Gyro System :: Engine-driven vacuum pump spins the attitude and heading gyros. A quiet failure — cross-check against the electric turn coordinator and partial-panel. -> gyroscopic-instruments "spins the gyros"
  - Vacuum Pump & Gauge :: A dry vane pump draws air across the gyros; the suction gauge (~4.5–5.5" Hg) is the only warning you have before the gyros spin down.
  - Which Gyros It Drives :: Typically the attitude and heading indicators run on vacuum; the turn coordinator is electric — so a vacuum loss leaves you the TC, ASI and altimeter.
  - Failure & Partial Panel :: The gyros die slowly and lie convincingly — the classic killer. Cover them, fly the electric TC + pitot-static, and get to VFR. -> vacuum-partial-panel "partial-panel"
- Environmental & Deice :: Heater (exhaust shroud → CO risk), pitot heat, and on capable airplanes boots, hot props or TKS for known ice. -> airframe-icing "fights airframe ice"
  - Cabin Heat & CO Risk :: Cabin heat is exhaust warmth through a shroud — a cracked shroud leaks carbon monoxide into the cabin. A CO detector and fresh-air vents are the defense. -> carbon-monoxide "carbon monoxide"
  - Anti-Ice vs De-Ice :: Anti-ice prevents ice forming (heated pitot, hot props, TKS weeping wings); de-ice removes accreted ice (pneumatic boots). Only "known-ice" airplanes may enter icing.
