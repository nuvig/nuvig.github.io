---
id: instruments-and-ifr
group: inst
label: Instruments & IFR
groupName: Instruments
color: #8fa3c0
order: 10
---
The six-pack, the glass, and flying by reference to them in cloud.

- Pitot-Static Instruments {#pitot-static-instruments} :: Airspeed, altimeter and vertical speed — all fed by ram and static air. Understand each blockage failure by heart.
  - Airspeed Indicator :: Difference between pitot (ram) and static pressure. Blocked pitot with open drain reads zero; blocked pitot+drain acts like an altimeter in a climb/descent.
  - Altimeter :: Aneroid measuring static pressure against a set datum (Kollsman window). "High to low, look out below" — set the local setting.
  - Vertical Speed Indicator :: Rate of static-pressure change — trend plus rate, with a lag.
- Gyroscopic Instruments {#gyroscopic-instruments} :: Rigidity and precession put to work: attitude, heading and turn rate — spun by vacuum or electricity.
  - Attitude Indicator :: The artificial horizon — pitch and bank at a glance, the master instrument in IMC.
  - Heading Indicator :: A stable gyro heading with no compass errors — but it drifts, so reset it to the mag compass every ~15 min.
  - Turn Coordinator :: Rate of turn and, via the inclinometer ball, coordination. Electric — your standby when vacuum quits.
- Glass Cockpit & Automation :: PFD/MFD, AHRS, ADC, autopilot and moving map — more information, new failure modes, and the automation-management workload.
  - PFD & MFD :: The primary flight display paints attitude, air data and navigation on one screen; the multi-function display carries the moving map, engine and systems pages.
  - AHRS & ADC :: Solid-state boxes replace spinning gyros: the AHRS derives attitude and heading, the air data computer derives airspeed, altitude and VSI from the pitot-static system. -> pitot-static-instruments "air data source"
  - Autopilot & Flight Director :: The flight director commands pitch/roll bars to follow; the autopilot flies them. Know the modes armed vs captured — mode confusion is a modern killer.
  - GPS / FMS Navigator :: The IFR navigator sequences the flight plan, loads and flies approaches, and drives the CDI/autopilot. Verify the active leg and the approach loaded, every time. -> instrument-approaches "loads the approach"
  - Automation Management :: Choose the right level of automation for the workload, cross-check what the box is doing against raw data, and be ready to hand-fly when it surprises you.
- Instrument Flying :: Controlling the airplane and navigating solely by reference to instruments when the world outside disappears — the whole IFR discipline, gate to gate.
  - Attitude Instrument Flying :: Flying precise attitudes off the panel instead of the horizon — the motor skill under everything else in IMC.
    - Control & Performance Method :: Set a known attitude + power on the control instruments (AI, tach/MP), then check the result on the performance instruments (ASI, ALT, VSI, HI) and trim it off.
    - Primary & Supporting Instruments :: In each phase one instrument is "primary" for pitch, bank and power (e.g. straight-and-level: ALT primary pitch, HI primary bank), the rest support it. Interpretation, not staring.
    - The Scan & Its Errors :: A disciplined cross-check across the panel. Fixation (locking on one), omission (ignoring one) and emphasis (over-trusting one) are the three ways the scan breaks down.
    - Partial Panel & Unusual Attitudes :: Lose the AI/HI and fly the electric turn coordinator, ASI and altimeter; recover unusual attitudes by the ASI trend — power/pitch/bank — reading the raw instruments, not your ears. -> vacuum-partial-panel "vacuum failure" -> gyroscopic-instruments "failed gyros"
  - Clearance & Departure :: Getting into the system and safely off the ground into the clag.
    - The Clearance (CRAFT) :: Clearance limit, Route, Altitude, Frequency, Transponder — copied, read back, and flown exactly as issued until amended. -> communication "read back"
    - Void Times & Release :: From a non-towered field ATC issues a clearance void time and often a hold-for-release — be airborne before the void time or the clearance evaporates.
    - ODP vs SID :: Obstacle Departure Procedures protect you from terrain and are pilot-selected; Standard Instrument Departures are ATC routings. Know which applies before you roll.
    - Climb Gradients & the Trouble-T :: The plate's trouble-T flags a non-standard takeoff minimum or a required climb gradient (ft/NM) — convert it to fpm at your groundspeed and confirm you can make it.
  - Enroute :: Navigating the IFR structure between departure and approach.
    - Airways & Fixes :: Victor airways (VOR) and T-routes (GPS) connect fixes and intersections. Fly the centerline; RNAV lets you go direct where terrain and airspace allow.
    - IFR Altitudes :: MEA (guaranteed nav + obstacle), MOCA (obstacle, nav within 22 NM), MRA (reception), MCA (cross at/above), and OROCA off-route terrain clearance — the alphabet that keeps you high enough.
    - Position Reporting :: In non-radar or on request: name, position, time, altitude, next fix + ETA, and the fix after. Plus the mandatory reports ATC never has to ask for. -> communication "required reports"
    - Descent & STAR :: Standard Terminal Arrival Routes and descent clearances (pilot's vs ATC's discretion, "descend via") bridge enroute to the approach — plan the top of descent early.
  - Holding :: Parking in the sky on a protected racetrack when the system needs you to wait.
    - Entry Types :: Direct, parallel and teardrop entries, chosen by your inbound heading relative to the holding course (the ±70° rule). Visualize the pattern before you arrive at the fix.
    - Timing & Leg Lengths :: Standard right turns, 1-minute legs at/below 14,000 ft (1½ above), or a DME/RNAV leg length. Start timing abeam the fix or wings-level, whichever is later.
    - Wind Correction in the Hold :: Drift on the outbound leg is corrected by tripling the inbound crab, and outbound timing is adjusted to make the inbound leg come out right. -> wind-correction-triangle "crab & drift"
    - EFC & Holding Fuel :: Expect-Further-Clearance time is your lost-comms trigger; watch holding fuel against your alternate + reserve and speak up before it bites.
  - Instrument Approaches {#instrument-approaches} :: The descent from the enroute structure to a runway you can't see until the end — the highest-workload minutes in IFR.
    - Precision vs Non-Precision :: Precision/APV (ILS, LPV, LNAV/VNAV) give vertical guidance to a Decision Altitude; non-precision (LOC, VOR, LNAV, RNP) step you down to a Minimum Descent Altitude. -> ils "ILS provides both"
    - Approach Segments :: Feeder → Initial (IAF) → Intermediate (IF) → Final (FAF) → Missed (MAP). Each segment has its own obstacle clearance and altitude.
    - Minimums: DA vs MDA :: At the DA you decide and may momentarily descend below in the go-around; at the MDA you must not descend until the runway environment and required visibility are in sight.
    - Landing from the Approach (91.175) :: Below MDA/DA needs three things: flight visibility at or above minimums, a normal descent to the intended runway, and a listed visual reference (threshold, TDZ, VASI, lights…). -> takeoffs-and-landings "the landing"
    - The Missed Approach :: Not in sight, or unstable, at the MAP/DA → cram, climb, clean, and fly the published miss (or ATC's). Brief it before you start down so it's a reflex, not a decision.
    - Circling Approach :: Maneuvering visually to a runway not aligned with the final course, at circling MDA, staying within the protected radius for your approach category and never descending until in the slot.
  - IFR Regulations & Currency {#ifr-regulations-and-currency} :: The rules that decide whether you and the airplane may legally launch into the system today.
    - Currency: 6-HITS & IPC :: In the last 6 months: 6 approaches, Holding, Intercepting and Tracking courses — in actual or a view-limiting device. Lapse it and you need an Instrument Proficiency Check.
    - Alternate Requirements (1-2-3) :: File an alternate unless, ±1 hr of ETA, the ceiling is ≥2,000 ft and visibility ≥3 SM. Alternate minimums default 600-2 (precision) / 800-2 (non-precision) unless charted otherwise. -> time-speed-distance-and-fuel "plan the fuel"
    - IFR Fuel Requirements :: Enough to reach the destination, then the alternate, then 45 minutes at normal cruise (91.167) — the number that sizes the whole flight. -> time-speed-distance-and-fuel "fuel planning"
    - Lost Communications :: Squawk 7600, continue VFR if able; if IMC fly Route (Assigned→Vectored→Expected→Filed) and Altitude (highest of Assigned, MEA, Expected), and arrive per your clearance/EFC. -> communication "the comm failure"
    - Required Reports to ATC :: Reports ATC never has to ask for: leaving an altitude, unable to climb/descend 500 fpm, missed approach, loss of nav/comm, unforecast weather, safety of flight, and more.
  - The IFR Environment :: The conditions that make instrument flight necessary — and dangerous.
    - IMC, VMC & VFR-into-IMC :: Instrument vs visual meteorological conditions. A VFR pilot continuing into IMC is one of aviation's deadliest chains — the case for the rating and the 180° turn. -> spatial-disorientation "disorientation sets in" -> aeronautical-decision-making "the decision chain"
    - Structural Icing & IFR :: IFR routinely means cloud near freezing. Without known-ice equipment, an IFR flight plan is not a license to enter icing — plan the escape (warmer air, lower, out). -> airframe-icing "airframe ice"
    - Ceiling, Visibility & RVR :: Reported ceiling and visibility (or runway visual range) decide whether the approach is even legal to start and continue — and RVR governs where it's available.
