---
id: aerodynamics
group: aero
label: Aerodynamics
groupName: Aerodynamics
color: #4a9eff
order: 0
---
How the wing and the air trade momentum to make lift, drag and control.

- Four Forces :: Lift, weight, thrust and drag. In unaccelerated flight the opposing pairs are equal; any imbalance is an acceleration.
  - Lift :: The aerodynamic force perpendicular to the relative wind. L = ½ρV²·S·CL — set by air density, speed², wing area and the coefficient of lift (which you fly with angle of attack).
    - Angle of Attack :: Angle between the chord line and the relative wind. The pilot's real lift control — the wing always stalls at the same critical AoA regardless of airspeed or attitude. -> stall "sets stall" -> load-and-stall-link "raises stall speed"
    - Coefficient of Lift :: Dimensionless lift efficiency of the airfoil at a given AoA. Rises with AoA up to the critical angle, then collapses.
    - Bernoulli & Newton :: Two views of the same reality: faster flow over the camber means lower pressure (Bernoulli), and the wing deflects a mass of air downward (Newton's third law). Both are correct.
    - Ground Effect {#ground-effect} :: Within about one wingspan of the surface the ground interrupts downwash and wingtip vortices — induced drag drops and the wing feels more efficient. Floats on landing, tries to settle back on takeoff. -> induced-drag "cuts induced drag"
  - Stall {#stall} :: Airflow separates from the upper wing past the critical AoA and lift drops sharply. Always an angle-of-attack event — you can stall at any airspeed or attitude. -> slow-flight-and-stalls "tested slow flight"
    - Critical AoA :: The single angle where the boundary layer separates. Fixed for the airfoil; hitting it is what defines the stall.
    - Stall Speed (Vs) :: The speed that produces critical AoA in 1-g flight. Published for a clean and landing configuration; it is a symptom, not the cause.
    - Spin :: An aggravated stall with yaw — one wing more stalled than the other, autorotating. Recovery (PARE): Power idle, Ailerons neutral, Rudder opposite, Elevator forward.
    - Load Factor & Vs :: Stall speed rises with the square root of load factor: a 60° bank doubles load and raises Vs by ~41%. The "accelerated stall." -> maneuvering-speed-va "stalls before overstress"
  - Drag :: The rearward aerodynamic force. Total drag is the sum of parasite and induced — their opposite trends with speed create the drag curve.
    - Parasite Drag :: Form + skin friction + interference. Grows with the square of airspeed — the fast-flight penalty.
    - Induced Drag {#induced-drag} :: The price of making lift — the tilt of the lift vector from downwash and tip vortices. Greatest at low speed / high AoA, falls with speed.
    - L/D max :: The speed where total drag is least and lift-to-drag is greatest — best glide, max endurance for a jet, and the bottom of the power curve. -> emergency-airwork "= best glide AoA"
    - Region of Reversed Command {#region-of-reversed-command} :: Slower than L/Dmax it takes MORE power to fly slower, because induced drag is climbing. The "back of the power curve" — the low-and-slow trap on approach.
  - Thrust :: The propeller's reaction force. Excess thrust climbs the airplane; excess power sets rate of climb. -> fixed-vs-constant-speed "made by the prop"
  - Weight :: Gravity acting at the CG. Sets required lift, and with the CG location drives stability and control. -> center-of-gravity "acts at CG"
- Stability & Control :: Whether the airplane returns to trim on its own, and how the controls change its state.
  - Static & Dynamic Stability :: Static = initial tendency after a disturbance; dynamic = what the motion does over time (damped, neutral or divergent). Trainers are positively stable in both.
  - Longitudinal Stability {#longitudinal-stability} :: Pitch stability, governed by CG relative to the neutral point. Forward CG = more stable, heavier controls; aft CG = twitchy and eventually unrecoverable. -> center-of-gravity "set by CG"
  - Adverse Yaw {#adverse-yaw} :: The down-aileron wing makes more lift AND more induced drag, yawing the nose away from the turn. Answered with coordinated rudder.
  - Load Factor {#load-factor} :: Ratio of lift to weight (g). Climbs with bank angle in a level turn (1/cos φ) and is limited by the flight envelope. -> v-speeds-and-the-envelope "bounds the V-n diagram"
  - Load & Stall Link {#load-and-stall-link} :: Because Vs scales with √(load factor), every increase in g — a steep turn, a pull-up, a gust — raises the speed at which the wing stalls.
  - Left-Turning Tendencies :: Torque, P-factor, spiraling slipstream and gyroscopic precession all pull a single-engine prop plane left, strongest at high power / low speed / high AoA. -> p-factor "P-factor"
- High-Speed & Wake :: Effects that show up near the edges of the envelope or behind other aircraft.
  - Wingtip Vortices :: Rotating air shed from a lifting wing — the core of wake turbulence. Strongest when heavy, clean and slow. Stay at or above a heavy jet's flight path and land beyond its touchdown point. -> traffic-pattern "sequencing & spacing"
  - Mach & Compressibility :: As local flow approaches the speed of sound, air compresses and shock waves form — irrelevant to trainers but the ceiling for jets (Mmo, coffin corner).
- Groundspeed & L/D {#groundspeed-and-ld} :: Groundspeed sets pivotal altitude and glide range; L/Dmax sets best glide and endurance — the same physics behind several tasks.
