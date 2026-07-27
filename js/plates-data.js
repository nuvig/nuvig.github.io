// Approach Plate Decoder — element glossary + plate library.
//
// Two halves:
//   PLATE_GLOSSARY  every item that can appear on an FAA instrument approach
//                   chart, explained once. Keyed by element id; the renderer
//                   tags each drawn item with the same id.
//   PLATES          the compared procedures. Geometry (fixes, courses,
//                   altitudes, glidepath angles, runways, field elevation) is
//                   NOT stored here — it is read at run time from
//                   data/procedures/apt/{ICAO}.json, the FAA CIFP cycle the
//                   site already ships, so the drawings refresh with the AIRAC
//                   cycle. Only chart-face content that CIFP does not carry
//                   (frequencies, minimums, notes, TDZE, lighting) is authored
//                   here — and every such block is listed in `illus` so the
//                   renderer can mark it as illustrative.
//
// Adding a plate: pick an ICAO that exists in data/procedures/apt/ and a
// procedure id from that file's procs[] (type 'APP'), then fill in the same
// fields as the entries below. Nothing else needs to change.

window.PLATE_GLOSSARY = {

  /* ---------------------------------------------------------------- margins */

  'chart-ref': {
    t: 'Chart reference number', s: 'Margins',
    what: 'The <b>AL-####</b> number in the top margin, followed by <i>(FAA)</i>. It identifies the chart itself, not the procedure.',
    why: 'Every airport with published procedures gets one AL number, shared by all of its charts. It is how the FAA and the chart printer track the sheet.',
    watch: 'A number in parentheses like <i>(USAF)</i> or <i>(USN)</i> instead of (FAA) means a military chart with different rules.'
  },
  'amdt': {
    t: 'Amendment number and date', s: 'Margins',
    what: 'Something like <b>Amdt 6  25198</b>. The amendment counter, then the year and Julian day the procedure was last changed — 25198 = the 198th day of 2025.',
    why: 'It is the single fastest way to tell whether the chart in your hand is the one currently in effect, and it tells you whether the procedure just changed.',
    watch: 'A fresh amendment number is a cue to actually read the whole plate again instead of flying it from memory.'
  },
  'margin-title': {
    t: 'Procedure title', s: 'Margins',
    what: 'The name of the approach, repeated in the top and bottom margins so you can find it in a stack of charts.',
    why: 'The title encodes what equipment you need and what you may do at the bottom. <b>ILS or LOC RWY 23</b> is two procedures on one chart. <b>RNAV (GPS) RWY 4</b> is satellite based. <b>LDA/DME RWY 25</b> uses a localizer-type aid that is not aligned with the runway.',
    watch: 'A trailing letter instead of a runway number — <b>VOR-A</b>, <b>RNAV (GPS)-F</b> — means <b>circling only</b>: the final course or the descent gradient does not qualify for a straight-in landing. A Z/Y/X suffix separates multiple approaches of the same type to the same runway; Z is charted first, and is normally the one with the lowest minimums.'
  },
  'bottom-margin': {
    t: 'City, airport and coordinates', s: 'Margins',
    what: 'The bottom band carries the city and state, the airport name with its identifier, the reference latitude/longitude, and the procedure title again.',
    why: 'Charts are filed by city, not by identifier. This is the band you read when you are hunting for the right sheet.',
    watch: 'The city on the chart is the city the airport is <i>associated</i> with, which is not always the city the airport sits in.'
  },

  /* --------------------------------------------------------- briefing strip */

  'brief-strip': {
    t: 'Pilot briefing strip', s: 'Briefing strip',
    what: 'The banded block across the top of every FAA plate. It is deliberately ordered top-to-bottom, left-to-right in the sequence you brief the approach.',
    why: 'Before the FAA standardised this in the 1990s, the same information was scattered around the chart. Briefing straight down the strip means you cannot skip an item.',
    watch: 'The strip is the brief. If you find yourself hunting elsewhere on the chart during a briefing, you have skipped a line.'
  },
  'nav-freq': {
    t: 'Primary navaid box', s: 'Briefing strip',
    what: 'The facility that defines the final approach course: its type, frequency, identifier and Morse code — <b>LOC 110.30 I-FDK</b>, or a VOR, or the GPS/WAAS annotation on an RNAV chart.',
    why: 'This is the box you tune and, on a ground-based approach, the identifier you must actually listen to before using it.',
    watch: 'A localizer identifier always starts with <b>I-</b>. If the Morse is absent or wrong, the facility is unusable no matter what the needle does.'
  },
  'app-crs': {
    t: 'Final approach course', s: 'Briefing strip',
    what: 'The magnetic course of the final approach segment, in degrees.',
    why: 'It is the number you set in the course window, and comparing it with the runway heading tells you instantly whether the approach is aligned.',
    watch: 'Offset more than 30° from the runway centreline (or more than 15° for some categories) and the approach can only be published circling-only. An LDA is offset on purpose.'
  },
  'gs-alt': {
    t: 'Glideslope / FAF crossing altitude', s: 'Briefing strip',
    what: 'On a precision chart, the altitude at which you intercept the glideslope. On a non-precision chart, the altitude you cross the final approach fix.',
    why: 'It is the altitude you level at before the fix, and the number you check the glideslope against when it comes alive — the standard defence against a false glideslope or a mis-set altimeter.',
    watch: 'If you arrive at the FAF and the glideslope is not where this number says it should be, the approach is not stable and should not be continued.'
  },
  'rwy-tdze': {
    t: 'Rwy Idg / TDZE / Apt Elev', s: 'Briefing strip',
    what: 'Landing distance available on the runway this approach serves, the <b>touchdown zone elevation</b>, and the airport elevation.',
    why: 'TDZE is the reference for straight-in height above touchdown; airport elevation is the reference for circling. Straight-in minimums are built on TDZE, circling minimums on airport elevation — which is why the two heights in the minimums box use different references.',
    watch: 'On circling-only charts there is no runway to land straight in on, so only the airport elevation matters.'
  },
  'proc-notes': {
    t: 'Procedure notes box', s: 'Briefing strip',
    what: 'The free-text box for restrictions: equipment required, temperature limits, night restrictions, procedure NA when the tower is closed, and so on.',
    why: 'This is where the approach is quietly made illegal for you. <b>DME required</b>, <b>RNP APCH required</b>, <b>Circling NA at night</b>, <b>Procedure NA for arrivals on V166 southbound</b> all live here.',
    watch: 'Read this box before you read the minimums. There is no point admiring a 200-foot DA on an approach your aircraft is not authorised to fly.'
  },
  'nonstd-symbols': {
    t: 'Alternate and takeoff minimums flags', s: 'Briefing strip',
    what: 'The small triangles: <b>▲N</b> means standard alternate minimums do not apply, <b>T▲</b> means non-standard takeoff minimums or a departure procedure exists.',
    why: 'They are pointers into the separate front-of-book sections. The chart has no room for the actual text, so it flags you to go look.',
    watch: 'The ▲N flag is a flight-planning item, not an approach item — it bites at the dispatch stage, hours before you ever see the chart in the air.'
  },
  'missed-text': {
    t: 'Missed approach instructions', s: 'Briefing strip',
    what: 'The written missed approach: the climb, any turn, the fix to proceed to, and the hold.',
    why: 'You brief this before the approach because there is no time to read it when you need it. Altitudes, turn direction and the holding fix all come from this one sentence.',
    watch: 'The missed approach is a <i>climb first</i>, then turn. Turning early into terrain is the classic way to make a survivable go-around into an accident.'
  },
  'missed-icons': {
    t: 'Missed approach icon strip', s: 'Briefing strip',
    what: 'The row of pictograms that repeats the written missed approach as symbols: climb, turn, direct-to, hold.',
    why: 'Added in the 2010s so the missed approach can be absorbed at a glance under workload rather than read as a sentence.',
    watch: 'The icons are a summary. Anything conditional — "if not established, climb to…" — only exists in the text.'
  },
  'comm-strip': {
    t: 'Communications strip', s: 'Briefing strip',
    what: 'The frequency band across the bottom of the briefing strip, in the order you will use them: ATIS, approach control, tower, ground.',
    why: 'Left-to-right is the sequence of the arrival, so you can set the radios by working across the band.',
    watch: 'At a non-towered field the last box is <b>CTAF</b>, and the responsibility for sequencing is yours. An asterisk on a frequency means part-time.'
  },

  /* ------------------------------------------------------------- plan view */

  'planview': {
    t: 'Plan view', s: 'Plan view',
    what: 'The overhead picture of the approach. The standard circle covers 10 NM from the navaid or airport; anything outside is drawn to a different, compressed scale.',
    why: 'It shows how the routes join the final course, where the fixes are, and what the terrain and airspace look like.',
    watch: 'Only the inside of the reference circle is to scale. Routes and holds drawn outside it — and inset boxes — are schematic, so never measure distances off them.'
  },
  'msa': {
    t: 'Minimum safe altitude circle', s: 'Plan view',
    what: 'The MSA circle: an altitude, or a set of sector altitudes, that gives 1,000 ft of obstacle clearance within (normally) 25 NM of the reference point named in the middle.',
    why: 'It is the emergency number. Lost, disoriented, or handed a vector you do not like — this altitude keeps you off the rocks.',
    watch: 'MSA guarantees obstacle clearance <b>only</b>. It does not guarantee navigation signal coverage and it is not an approved altitude to fly the approach at.'
  },
  'taa': {
    t: 'Terminal arrival area', s: 'Plan view',
    what: 'On RNAV charts, the pie-shaped TAA sectors around the initial fixes, each with its own minimum altitude and a distance ring.',
    why: 'A TAA replaces feeder routes: arriving from anywhere in a sector, you descend to the sector altitude and proceed direct to the fix. It is the standalone version of a radar vector.',
    watch: 'The straight-in sector is normally ±30° of the final course. Arriving outside it, you get the base sector altitude and a course reversal, not a straight-in.'
  },
  'iaf': {
    t: 'Initial approach fix (IAF)', s: 'Plan view',
    what: 'Where the approach begins. Labelled <b>(IAF)</b> next to the fix name.',
    why: 'It is the boundary between the en-route/terminal structure and the approach. Cleared for the approach, this is where the published altitudes start to apply.',
    watch: 'Many approaches have several IAFs. Which one you get changes the altitude you may descend to and whether a course reversal is required.'
  },
  'if-fix': {
    t: 'Intermediate fix (IF)', s: 'Plan view',
    what: 'The start of the intermediate segment, between the initial segment and the final approach fix.',
    why: 'The intermediate segment is where you get configured and slowed: it is nearly aligned with the final course and has a shallow or level descent.',
    watch: 'Being vectored to the IF rather than the IAF is normal, and it is also how you legally skip a hold-in-lieu of procedure turn.'
  },
  'feeder': {
    t: 'Feeder route', s: 'Plan view',
    what: 'A route from the en-route structure to an initial approach fix, annotated with course, distance and minimum altitude.',
    why: 'It is the published way to get from an airway to the approach without a radar vector — and the altitude on it is a hard minimum, not a suggestion.',
    watch: 'A feeder route is not part of the approach segment: the altitude on it is a minimum en-route altitude, so it does not give you the descent profile.'
  },
  'hilpt': {
    t: 'Course reversal — HILPT or procedure turn', s: 'Plan view',
    what: 'Either a racetrack (a <b>hold-in-lieu of procedure turn</b>) or the classic 45°/180° barb, with the outbound limit distance and altitude.',
    why: 'It gets you turned around and descended onto the final course when you arrive from a direction the approach is not set up for.',
    watch: 'It is <b>mandatory</b> unless you are being radar vectored to final, are on a NoPT route, are cleared straight-in, or are in the straight-in TAA sector. The barb only shows the side to turn to — the shape you fly is up to you, within the distance limit.'
  },
  'final-course': {
    t: 'Final approach course', s: 'Plan view',
    what: 'The heavy arrow into the airport, labelled with the course. On a precision approach it also carries the localizer feather symbol.',
    why: 'It is the spine of the approach — everything else on the plan view exists to deliver you onto this line at the right altitude.',
    watch: 'Compare the arrow with the runway. If it does not point down the centreline, you are looking at an LDA, an offset RNAV final, or a circling-only approach.'
  },
  'faf': {
    t: 'Final approach fix (FAF)', s: 'Plan view',
    what: 'Drawn as a <b>Maltese cross</b> on a non-precision approach. On a precision approach, the equivalent point is the glideslope intercept, shown in the profile as a lightning bolt.',
    why: 'It is the gate: crossing it, you are established, configured, at the published altitude, and committed to the final descent.',
    watch: 'On an ILS the Maltese cross marks the <i>localizer-only</i> FAF. Fly the glideslope and your descent starts at the lightning bolt, which is usually not in the same place.'
  },
  'map-fix': {
    t: 'Missed approach point (MAP)', s: 'Plan view',
    what: 'Where the approach ends if you have not got the runway environment in sight. On a non-precision approach it is a named fix, a DME distance, or a time from the FAF; on a precision approach it is the DA.',
    why: 'Reaching it without the required visual references obliges you to go around. There is no discretion in it.',
    watch: 'On a circling-only approach the MAP is often well before the airport — the last point from which the published missed approach guarantees obstacle clearance.'
  },
  'missed-track': {
    t: 'Missed approach track', s: 'Plan view',
    what: 'The dashed line out of the missed approach point, showing the ground track of the go-around.',
    why: 'Dashed = you are not on it yet. It shows the turn direction and the route to the holding fix.',
    watch: 'Where the dashed track goes relative to the terrain is the whole reason some missed approaches have steep climb gradients.'
  },
  'missed-hold': {
    t: 'Missed approach holding pattern', s: 'Plan view',
    what: 'The racetrack at the end of the missed approach, with its inbound course, turn direction and holding altitude.',
    why: 'It is where you end up. Knowing it before you start the approach is what lets you fly the go-around without reading anything.',
    watch: 'On charts where the hold is far from the airport, it is drawn compressed or in an inset — do not scale distance off it.'
  },
  'nav-symbol': {
    t: 'Navaid symbol', s: 'Plan view',
    what: 'The VOR compass rose, VORTAC, NDB or waypoint symbol, with its identification box giving name, frequency, identifier and Morse.',
    why: 'Ground-based approaches are built around these facilities; the rose shows the orientation of the radials the procedure uses.',
    watch: 'RNAV waypoints are drawn as four-point stars. A <b>filled</b> star is a fly-over waypoint — you must cross it before turning; an outlined one may be cut.'
  },
  'terrain': {
    t: 'Terrain and obstacles', s: 'Plan view',
    what: 'Spot elevations with a dot, obstacles as towers, and — where terrain rises more than 4,000 ft within 6 NM of the airport — brown terrain contours behind the whole plan view.',
    why: 'The highest obstacle in the plan view is boxed and is the reason the minimums are what they are.',
    watch: 'The presence of terrain shading on a plate is itself a warning: it only gets added to charts at airports where terrain genuinely dominates the procedure design.'
  },
  'restricted': {
    t: 'Special use airspace', s: 'Plan view',
    what: 'Prohibited, restricted and warning areas that intersect the plan view, drawn hatched and labelled.',
    why: 'The approach is designed to stay clear of them; drifting off course can put you into airspace with consequences beyond a phone number.',
    watch: 'Around Washington DC the approach corridors are shaped by prohibited airspace, not just by terrain.'
  },
  'airport-symbol': {
    t: 'Airport symbol', s: 'Plan view',
    what: 'The runway layout of the destination, drawn to orientation in the middle of the plan view.',
    why: 'It shows how the final course relates to the runways — the picture you need for a circling approach.',
    watch: 'The plan view symbol is not the airport sketch. Runway lengths, lighting and taxiways come from the sketch at the bottom of the chart.'
  },
  'north-scale': {
    t: 'North arrow and scale', s: 'Plan view',
    what: 'The north arrow and, on most charts, a distance scale for the reference circle.',
    why: 'Plan views are drawn with the final approach course roughly vertical, so north is very often not up.',
    watch: 'If you catch yourself assuming north is up on an approach chart, you will mis-visualise every turn on the plate.'
  },

  /* ---------------------------------------------------------- profile view */

  'profile': {
    t: 'Profile view', s: 'Profile view',
    what: 'The side-on picture of the approach: altitudes at each fix, the descent path, and the missed approach climb.',
    why: 'It answers the only question that matters on final — how low may I be, and where.',
    watch: 'The profile is <b>not to scale</b>, horizontally or vertically. Read the numbers, not the slope of the line.'
  },
  'faf-profile': {
    t: 'FAF symbol in profile', s: 'Profile view',
    what: 'A <b>Maltese cross</b> marks the non-precision final approach fix. A <b>lightning bolt</b> marks the point where the glideslope or glidepath is intercepted at the published altitude.',
    why: 'They are two different gates on the same chart: one for the LOC/LNAV descent, one for the ILS/LPV descent.',
    watch: 'Fly a glideslope from a point other than the lightning bolt and you may be tracking a false lobe or an unverified path.'
  },
  'gs-path': {
    t: 'Glideslope / glidepath angle', s: 'Profile view',
    what: 'The descent angle of the vertically guided path, in degrees — 3.00° is the standard.',
    why: 'Angle and groundspeed together give the descent rate you should see: roughly 5 × groundspeed for 3°.',
    watch: 'Anything above 3.1° is steep, and above 3.5° usually comes with an aircraft or operator authorisation requirement. Steep angles also mean a much higher rate of descent for the same groundspeed.'
  },
  'step-downs': {
    t: 'Stepdown fixes', s: 'Profile view',
    what: 'Intermediate fixes inside the final approach segment, each with a minimum altitude you may not descend below until passing it.',
    why: 'They let the procedure duck under obstacles one at a time instead of holding you at the highest one all the way in.',
    watch: 'A stepdown is only usable if you can identify it. Lose the DME or the equipment that defines the fix and you are stuck at the higher minimums shown in the notes.'
  },
  'tch': {
    t: 'Threshold crossing height (TCH)', s: 'Profile view',
    what: 'The height above the runway threshold at which the glidepath crosses it — typically 30 to 55 ft.',
    why: 'It fixes where the vertical path puts you at the threshold, and therefore where you touch down.',
    watch: 'A high TCH on a short runway eats landing distance. On a steep approach it also means you arrive fast with a lot of energy to lose.'
  },
  'vdp': {
    t: 'Visual descent point (VDP)', s: 'Profile view',
    what: 'A bold <b>V</b> on the profile of a non-precision approach: the point on the MDA from which a normal descent to the runway can be started once you are visual.',
    why: 'It converts a dive-and-drive into something like a stabilised approach — before the VDP, going visual and descending means an abnormally steep final.',
    watch: 'A VDP is advisory, not a fix, and it is deliberately omitted where the descent from it would not be clear of obstacles.'
  },
  'missed-profile': {
    t: 'Missed approach in profile', s: 'Profile view',
    what: 'The climbing arrow out of the MAP, with the climb altitude and — where required — a published climb gradient in feet per nautical mile.',
    why: 'Standard obstacle clearance assumes 200 ft/NM. Anything more is printed here, and it is a performance requirement, not a suggestion.',
    watch: 'A 300+ ft/NM missed approach gradient is a single-engine planning problem for a twin and can be unachievable for a loaded light aircraft on a hot day.'
  },
  'rate-table': {
    t: 'Rate of descent table', s: 'Profile view',
    what: 'A small table converting groundspeed to the vertical speed needed to hold the published angle.',
    why: 'It is the number to set in your head before the FAF, so a glance at the VSI tells you whether you are on path.',
    watch: 'It is groundspeed, not airspeed. A strong tailwind on final can push the required rate far past what a stabilised approach allows.'
  },
  'timing-table': {
    t: 'FAF to MAP timing table', s: 'Profile view',
    what: 'Distance from the final approach fix to the missed approach point, and the time it takes at various groundspeeds.',
    why: 'On an approach where the MAP is defined by time, this table <i>is</i> the missed approach point.',
    watch: 'If the table is missing, the MAP is not timed — it is a fix or a DME distance, and running a stopwatch will not find it.'
  },

  /* --------------------------------------------------------------- minimums */

  'mins-box': {
    t: 'Landing minimums box', s: 'Minimums',
    what: 'The table of the lowest altitude and the visibility required for each line of minimums the approach publishes.',
    why: 'Everything above it on the chart exists to get you here legally. The line you use is set by your equipment and by which components are working.',
    watch: 'You may use only the line you are actually equipped and authorised for — a WAAS receiver does not entitle you to the ILS line, and an ILS with a failed glideslope drops you to the LOC line in flight.'
  },
  'mins-cat': {
    t: 'Aircraft approach categories', s: 'Minimums',
    what: 'Columns A through E, set by 1.3 × stall speed in the landing configuration at maximum certificated landing weight.',
    why: 'A faster aircraft needs a bigger turn radius and more room, so it gets higher minimums — most visibly in the circling line.',
    watch: 'Category is a property of the aircraft, not of the speed you happen to be flying. But if you circle faster than your category allows, you must use the minimums for the higher category.'
  },
  'mins-precision': {
    t: 'Precision line (S-ILS)', s: 'Minimums',
    what: 'A <b>decision altitude</b> in feet MSL, the required visibility, and in parentheses the height above touchdown and the same visibility.',
    why: 'A DA is flown through: at the DA you either see the required references or you go around, and the aeroplane will descend slightly during the transition. That is accounted for.',
    watch: 'A standard Category I ILS gives 200 ft HAT and ½ SM / 1800 RVR. Anything higher than 200 ft HAT means an obstacle, a terrain issue, or an out-of-service component is driving it up.'
  },
  'mins-lpv': {
    t: 'LPV line', s: 'Minimums',
    what: 'Localizer performance with vertical guidance: an angular, ILS-like path flown to a decision altitude, available with a WAAS receiver.',
    why: 'It is the reason a small airport with no ground equipment at all can publish 200-foot minimums.',
    watch: 'LPV is not an ILS: the guidance is satellite-derived, and it requires WAAS availability, which is checked in the receiver before the FAF.'
  },
  'mins-lnavvnav': {
    t: 'LNAV/VNAV line', s: 'Minimums',
    what: 'Lateral navigation with barometric or WAAS vertical guidance, flown to a DA. Usually higher than LPV, lower than LNAV.',
    why: 'It gives a vertically guided path to aircraft with baro-VNAV that are not WAAS equipped.',
    watch: 'Baro-VNAV paths are temperature sensitive. The cold-temperature limit printed next to this line is a hard restriction, not advice.'
  },
  'mins-lnav': {
    t: 'LNAV line', s: 'Minimums',
    what: 'Lateral guidance only, flown to a <b>minimum descent altitude</b>. The most basic RNAV line, and the one available to any IFR GPS.',
    why: 'It requires nothing but a lateral course, so it is the fallback when WAAS or vertical guidance is unavailable.',
    watch: 'An MDA is a floor you must not go below, not a number you fly through. Advisory guidance labelled <b>+V</b> is a convenience — it does not change the MDA and it is not obstacle evaluated.'
  },
  'mins-loc': {
    t: 'Localizer-only line (S-LOC)', s: 'Minimums',
    what: 'The non-precision line on an ILS chart: lateral guidance from the localizer, no glideslope, flown to an MDA.',
    why: 'It is the line you fall back to the moment the glideslope flag comes up, and it is why the chart is titled "ILS <b>or</b> LOC".',
    watch: 'This transition happens in flight, often inside the FAF. Brief both lines before the approach, not just the one you hope to use.'
  },
  'mins-circling': {
    t: 'Circling line', s: 'Minimums',
    what: 'The MDA and visibility for manoeuvring visually to a runway other than the one the approach serves. The parenthesised height is <b>HAA</b>, above <i>airport</i> elevation.',
    why: 'Circling protection is a radius drawn around the runway ends, and it is the only part of an instrument procedure flown visually at low altitude.',
    watch: 'A <b>⊂C⊃</b> symbol after the label means the expanded circling radius applies — the newer, larger, true-airspeed-based areas. Circling minimums are frequently the highest numbers on the chart, and <b>Circling NA at night</b> or <b>Circling NA east of runway</b> notes are common.'
  },
  'mins-vis': {
    t: 'Visibility requirement', s: 'Minimums',
    what: 'Either statute miles (<b>1½</b>) or runway visual range in hundreds of feet (<b>18</b> = RVR 1800).',
    why: 'Visibility, not ceiling, is the controlling legal requirement for starting and continuing an approach under Part 91 operating rules.',
    watch: 'RVR is a transmissometer reading over one part of one runway. Where RVR is published and the equipment is out, a conversion table applies.'
  },
  'inop-table': {
    t: 'Inoperative components note', s: 'Minimums',
    what: 'A note pointing to the inoperative components table, which raises minimums when approach lighting or other components are out of service.',
    why: 'Lighting buys visibility credit. Take the lighting away and the credit goes with it.',
    watch: 'Some approaches carry "Inoperative table does not apply" — there the published minimums already assume the worst case and no further penalty is taken.'
  },

  /* ---------------------------------------------------------------- airport */

  'apt-sketch': {
    t: 'Airport sketch', s: 'Airport',
    what: 'The bottom-left diagram: runways with lengths and lighting, the approach lighting system, and the airport elevation and TDZE.',
    why: 'It is your picture of what to expect when you break out, and it is the reference for the circling manoeuvre.',
    watch: 'A negative symbol beside a runway means it has no lighting; the approach light configuration shown drives the visibility credit in the minimums box.'
  },
  'lighting': {
    t: 'Approach lighting system', s: 'Airport',
    what: 'The symbol for the lighting installed on the approach end — MALSR, ALSF-2, ODALS, or a plain runway with none, plus PAPI/VASI.',
    why: 'Approach lights are what let published visibility minimums go below ¾ SM, and they let you descend below DA/MDA to 100 ft above TDZE when they are the only thing you can see.',
    watch: 'You may not go below 100 ft above TDZE on the approach lights alone unless the red terminating bars or red side row bars are also in sight.'
  }
};

/* ========================================================================== */

window.PLATES = [

  /* ------------------------------------------------- 1. the reference plate */
  {
    id: 'kfdk-ils23', icao: 'KFDK', proc: 'I23',
    title: 'ILS or LOC RWY 23',
    city: 'FREDERICK, MARYLAND', aptName: 'FREDERICK MUNI (FDK)',
    group: 'standard', tag: 'Precision · the baseline',
    lead: 'The plate to learn first. A textbook Category I ILS at a busy GA field: one navaid, one course, a hold-in-lieu of procedure turn, a glideslope down to a 200-foot decision altitude, and a localizer-only line underneath it for the day the glideslope quits.',
    why: [
      'Two procedures on one chart — the title says <b>ILS <i>or</i> LOC</b>, and the minimums box has a line for each.',
      'A hold-in-lieu of procedure turn at NUMBE, which you must fly unless you are vectored, cleared straight-in, or arriving on the NoPT feeder.',
      'The glideslope intercept and the localizer-only final approach fix are at the same fix here — on many ILS charts they are not.'
    ],
    chartRef: 'AL-6142 (FAA)', amdt: 'Amdt 6',
    brief: {
      navLabel: 'LOC', navFreq: '110.30', navIdent: 'I-FDK', chan: '',
      lights: 'MALSR', tdze: 293, rwyIdg: 5819,
      notes: [
        'When local altimeter setting not received, use Martinsburg altimeter setting and increase all MDA 60 ft.',
        'Simultaneous reception of I-FDK and FDK VOR required for the localizer-only stepdown.'
      ],
      flagAlt: true, flagTo: true,
      comms: [['ATIS', '124.875'], ['POTOMAC APPROACH', '126.75'], ['FREDERICK TOWER *', '132.4'], ['GND CON', '121.95'], ['CTAF', '132.4']]
    },
    msa: { ref: 'NUMBE', alt: 3600, r: 25 },
    mins: {
      cols: ['A', 'B', 'C', 'D'],
      rows: [
        { el: 'mins-precision', label: 'S-ILS 23', cells: ['493-½ (200-½)', '493-½ (200-½)', '493-½ (200-½)', '493-½ (200-½)'] },
        { el: 'mins-loc', label: 'S-LOC 23', cells: ['720-½ (427-½)', '720-½ (427-½)', '720-¾ (427-¾)', '720-1 (427-1)'] },
        { el: 'mins-circling', label: 'CIRCLING', cells: ['840-1 (531-1)', '840-1 (531-1)', '900-1½ (591-1½)', '960-2 (651-2)'] }
      ]
    },
    illus: ['brief', 'mins', 'msa', 'chartRef'],
    real: 'https://www.flightaware.com/resources/airport/KFDK/IAP/ILS+OR+LOC+RWY+23'
  },

  /* --------------------------------------------- 2. the satellite equivalent */
  {
    id: 'kfdk-rnav23', icao: 'KFDK', proc: 'R23-Z',
    title: 'RNAV (GPS) Z RWY 23',
    city: 'FREDERICK, MARYLAND', aptName: 'FREDERICK MUNI (FDK)',
    group: 'standard', tag: 'RNAV · same runway as the ILS',
    lead: 'The same runway at the same airport, flown by satellite. Comparing this with the ILS is the fastest way to see what changes when the ground equipment disappears: same 3.00° path to nearly the same decision altitude, but a stack of four minimums lines instead of two, and a Z/Y pair of charts instead of one.',
    why: [
      'Four minimums lines — <b>LPV, LNAV/VNAV, LNAV, CIRCLING</b> — because four different levels of equipment can fly the same lateral track.',
      'The <b>Z</b> suffix: Frederick publishes two RNAV approaches to runway 23. Z is charted first and has the lower minimums; Y uses a steeper 3.41° path and a stepdown at ZITIM.',
      'No navaid box to tune and no Morse to identify — but a WAAS availability check and an RAIM/annunciation check take its place.'
    ],
    chartRef: 'AL-6142 (FAA)', amdt: 'Amdt 2',
    brief: {
      navLabel: 'WAAS', navFreq: 'CH 55403', navIdent: 'W23A', chan: '',
      lights: 'MALSR', tdze: 293, rwyIdg: 5819,
      notes: [
        'For uncompensated Baro-VNAV systems, LNAV/VNAV NA below -15°C or above 47°C.',
        'DME/DME RNP-0.3 NA.'
      ],
      flagAlt: true, flagTo: true,
      comms: [['ATIS', '124.875'], ['POTOMAC APPROACH', '126.75'], ['FREDERICK TOWER *', '132.4'], ['GND CON', '121.95'], ['CTAF', '132.4']]
    },
    msa: { ref: 'GISGE', alt: 3600, r: 25 },
    mins: {
      cols: ['A', 'B', 'C', 'D'],
      rows: [
        { el: 'mins-lpv', label: 'LPV  DA', cells: ['543-½ (250-½)', '543-½ (250-½)', '543-½ (250-½)', '543-¾ (250-¾)'] },
        { el: 'mins-lnavvnav', label: 'LNAV/VNAV  DA', cells: ['729-¾ (436-¾)', '729-¾ (436-¾)', '729-1 (436-1)', '729-1¼ (436-1¼)'] },
        { el: 'mins-lnav', label: 'LNAV  MDA', cells: ['760-½ (467-½)', '760-½ (467-½)', '760-¾ (467-¾)', '760-1 (467-1)'] },
        { el: 'mins-circling', label: 'CIRCLING', cells: ['840-1 (531-1)', '840-1 (531-1)', '900-1½ (591-1½)', '960-2 (651-2)'] }
      ]
    },
    illus: ['brief', 'mins', 'msa', 'chartRef'],
    real: 'https://www.flightaware.com/resources/airport/KFDK/IAP/RNAV+(GPS)+Z+RWY+23'
  },

  /* ------------------------------------------------ 3. the conventional one */
  {
    id: 'kokv-vordme-a', icao: 'KOKV', proc: 'VDM-A',
    title: 'VOR/DME-A',
    city: 'WINCHESTER, VIRGINIA', aptName: 'WINCHESTER RGNL (OKV)',
    group: 'standard', tag: 'Conventional · circling only',
    lead: 'The old-fashioned kind: a radial off a VOR 20 miles away, a DME arc of distances instead of waypoints, a hold-in-lieu course reversal, and a letter instead of a runway number in the title. Nothing here is aligned with anything, which is exactly the point.',
    why: [
      'The <b>-A</b> in the title. The final course misses both runways by too much to allow a straight-in, so the only thing this approach authorises is a circle to land.',
      'The final approach course, the fixes and the missed approach are all defined by radials and DME from <b>MRB</b> — lose the DME and the approach is unusable.',
      'One minimums line, an MDA rather than a DA, and heights quoted above <i>airport</i> elevation because there is no touchdown zone to reference.'
    ],
    chartRef: 'AL-5820 (FAA)', amdt: 'Amdt 4',
    brief: {
      navLabel: 'VORTAC', navFreq: '112.10', navIdent: 'MRB', chan: '58',
      lights: 'MALSR Rwy 32', tdze: null, rwyIdg: null,
      notes: [
        'DME required.',
        'Circling NA east of Rwy 14-32.',
        'When local altimeter setting not received, procedure NA.'
      ],
      flagAlt: true, flagTo: true,
      comms: [['AWOS-3', '119.025'], ['POTOMAC APPROACH', '133.75'], ['CTAF/UNICOM', '123.0']]
    },
    msa: { ref: 'MRB', alt: 4500, r: 25 },
    mins: {
      cols: ['A', 'B', 'C', 'D'],
      rows: [
        { el: 'mins-circling', label: 'CIRCLING', cells: ['1300-1 (574-1)', '1300-1 (574-1)', '1300-1½ (574-1½)', '1300-2 (574-2)'] }
      ]
    },
    timing: { from: 'CWINE', to: 'MADCS', nm: 5.0 },
    illus: ['brief', 'mins', 'msa', 'chartRef'],
    real: 'https://www.flightaware.com/resources/airport/KOKV/IAP/VOR_DME-A'
  },

  /* ----------------------------------------------------- 4. the home field */
  {
    id: 'kanp-rnav-a', icao: 'KANP', proc: 'RNV-A',
    title: 'RNAV (GPS)-A',
    city: 'ANNAPOLIS, MARYLAND', aptName: 'LEE (ANP)',
    group: 'unusual', tag: 'One approach, no straight-in',
    lead: 'Lee Airport has exactly one instrument approach and it will not take you to a runway. A 3,000-foot strip under the Baltimore and Washington shelves, hemmed in by the DC SFRA, gets a single circling-only RNAV — the whole procedure is two fixes and a missed approach back where you came from.',
    why: [
      'Circling-only despite a nearly aligned final course: it is the <b>descent gradient</b> from the final approach fix, not the alignment, that disqualifies a straight-in here.',
      'The missed approach goes back to the initial approach fix, so there is no second bite from a different direction.',
      'One line in the minimums box. If you cannot circle, you cannot use this approach.'
    ],
    chartRef: 'AL-6572 (FAA)', amdt: 'Orig-B',
    brief: {
      navLabel: 'GPS', navFreq: '', navIdent: '', chan: '',
      lights: 'None', tdze: null, rwyIdg: null,
      notes: [
        'Circling NA at night.',
        'Procedure NA for arrivals at AMRTN on airway V139 southwest bound.',
        'Operations within the Washington DC SFRA require a filed flight plan and a discrete transponder code.'
      ],
      flagAlt: true, flagTo: true,
      comms: [['POTOMAC APPROACH', '124.55'], ['CTAF/UNICOM', '123.0']]
    },
    msa: { ref: 'AMRTN', alt: 2000, r: 25 },
    mins: {
      cols: ['A', 'B', 'C', 'D'],
      rows: [
        { el: 'mins-circling', label: 'CIRCLING', cells: ['620-1 (586-1)', '620-1 (586-1)', '620-1½ (586-1½)', '—'] }
      ]
    },
    illus: ['brief', 'mins', 'msa', 'chartRef'],
    real: 'https://www.flightaware.com/resources/airport/KANP/IAP/RNAV+(GPS)-A'
  },

  /* --------------------------------------------------------- 5. the steep one */
  {
    id: 'kase-rnav-f', icao: 'KASE', proc: 'RNV-F',
    title: 'RNAV (GPS)-F',
    city: 'ASPEN, COLORADO', aptName: 'ASPEN-PITKIN CO/SARDY FLD (ASE)',
    group: 'unusual', tag: 'The steepest descent in the NAS',
    lead: 'Aspen sits in a valley at 7,838 ft with terrain above 14,000 ft on three sides. The published descent angle on this approach is not 3° — it is roughly double that. Everything strange about this chart follows from having to lose thousands of feet in the few miles of valley the procedure is allowed to use.',
    why: [
      'A coded vertical path of about <b>6.5°</b>. At 100 kt groundspeed that is over 1,100 feet per minute, on final, in a valley.',
      'Circling only, and the arrival is effectively one-way: there is no approach from the south because the terrain is in the way.',
      'The missed approach does not go back to the airport — it heads down-valley to the west, because a straight-ahead climb would not out-climb the terrain.'
    ],
    chartRef: 'AL-306 (FAA)', amdt: 'Amdt 1',
    brief: {
      navLabel: 'GPS', navFreq: '', navIdent: '', chan: '',
      lights: 'MALSR Rwy 15', tdze: null, rwyIdg: null,
      notes: [
        'Special aircrew and aircraft certification required.',
        'Circling NA at night. Circling NA east of Rwy 15-33.',
        'Procedure NA at night. Autopilot coupled approach NA below 10,400.',
        'Descent gradient exceeds 400 ft/NM — verify aircraft capability before commencing the approach.'
      ],
      flagAlt: true, flagTo: true,
      comms: [['ATIS', '125.775'], ['DENVER CENTER', '133.75'], ['ASPEN TOWER *', '118.85'], ['GND CON', '121.9']]
    },
    msa: { ref: 'DBL', alt: 16000, r: 25 },
    mins: {
      cols: ['A', 'B', 'C', 'D'],
      rows: [
        { el: 'mins-lnav', label: 'LNAV  MDA', cells: ['10,200-2 (2,362-2)', '10,200-2 (2,362-2)', '—', '—'] },
        { el: 'mins-circling', label: 'CIRCLING', cells: ['10,200-2 (2,362-2)', '10,200-2 (2,362-2)', '—', '—'] }
      ]
    },
    illus: ['brief', 'mins', 'msa', 'chartRef'],
    real: 'https://www.flightaware.com/resources/airport/KASE/IAP/RNAV+(GPS)-F'
  },

  /* ------------------------------------------------------- 6. the offset one */
  {
    id: 'kege-lda25', icao: 'KEGE', proc: 'X25',
    title: 'LDA/DME RWY 25',
    city: 'EAGLE, COLORADO', aptName: 'EAGLE COUNTY RGNL (EGE)',
    group: 'unusual', tag: 'LDA · special authorization required',
    lead: 'A localizer-type directional aid: localizer equipment deliberately not aligned with the runway, because the valley the signal has to follow is not aligned with the runway either. Add a 3.8° glidepath, a bank of stepdowns through the terrain, and a chart that most operators are simply not allowed to use.',
    why: [
      '<b>LDA</b> in the title. It is a localizer in every technical respect, but offset from the runway centreline — so it is charted as its own approach type with its own minimums.',
      '<b>Special aircrew and aircraft authorization required.</b> This is not a normal public procedure: operators demonstrate the aircraft can meet the climb gradient and train the crews specifically for it.',
      'A published glidepath of <b>3.8°</b> and a missed approach climb gradient well above the standard 200 ft/NM — both driven by rising terrain, not by traffic.'
    ],
    chartRef: 'AL-5865 (FAA)', amdt: 'Amdt 2B',
    brief: {
      navLabel: 'LDA', navFreq: '109.35', navIdent: 'I-ESJ', chan: '',
      lights: 'MALSR Rwy 25', tdze: 6535, rwyIdg: 9000,
      notes: [
        'Special aircrew and aircraft authorization required.',
        'DME required. Simultaneous reception of I-ESJ and DME required.',
        'Missed approach requires minimum climb of 300 ft per NM to 14,600.',
        'Circling NA. Procedure NA at night.'
      ],
      flagAlt: true, flagTo: true,
      comms: [['ATIS', '124.075'], ['DENVER CENTER', '133.75'], ['EAGLE TOWER *', '119.0'], ['GND CON', '121.7']]
    },
    msa: { ref: 'SXW', alt: 16000, r: 25 },
    mins: {
      cols: ['A', 'B', 'C', 'D'],
      rows: [
        { el: 'mins-precision', label: 'LDA/GS  DA', cells: ['—', '8,335-3 (1,800-3)', '8,335-3 (1,800-3)', '—'] },
        { el: 'mins-loc', label: 'LDA  MDA', cells: ['—', '8,635-2½ (2,100-2½)', '8,635-3 (2,100-3)', '—'] },
        { el: 'mins-circling', label: 'CIRCLING', cells: ['NA', 'NA', 'NA', 'NA'] }
      ]
    },
    illus: ['brief', 'mins', 'msa', 'chartRef'],
    real: 'https://www.flightaware.com/resources/airport/KEGE/IAP/LDA_DME+RWY+25'
  },

  /* --------------------------------------------------------- 7. the curved one */
  {
    id: 'kdca-rnp19', icao: 'KDCA', proc: 'H19-Z',
    title: 'RNAV (RNP) Z RWY 19',
    city: 'WASHINGTON, DISTRICT OF COLUMBIA', aptName: 'RONALD REAGAN WASHINGTON NATIONAL (DCA)',
    group: 'unusual', tag: 'RNP AR · curved final over the Potomac',
    lead: 'The instrument version of the famous river approach. Instead of a straight final, this procedure flies a chain of <b>radius-to-fix</b> arcs down the Potomac, keeping the aircraft over the water and out of the prohibited airspace over the Mall — with a turn still in progress a few hundred feet above the ground.',
    why: [
      'The final approach segment is <b>curved</b>. RF legs are fixed-radius arcs the autopilot flies to a defined path, and they only exist on RNP approaches.',
      '<b>Authorization required.</b> The AR in RNP AR means the operator holds specific approval — aircraft, database, training and monitoring requirements all apply.',
      'The geometry is shaped by <b>airspace</b>, not terrain. Washington DC is ringed with prohibited areas, and this procedure threads the gap.',
      'It is one of a family: the same runway is also served by the Rosslyn LDA and the charted RIVER VISUAL RWY 19.'
    ],
    chartRef: 'AL-119 (FAA)', amdt: 'Amdt 1C',
    brief: {
      navLabel: 'GPS', navFreq: '', navIdent: '', chan: '',
      lights: 'MALSR Rwy 19', tdze: 11, rwyIdg: 6869,
      notes: [
        'Authorization required. RNP APCH-AR. RF legs required.',
        'Autopilot or flight director coupling required.',
        'GPS required. Baro-VNAV NA below -12°C or above 47°C.',
        'Aircraft must remain within the depicted corridor — prohibited areas P-56A/B abut the final approach segment.'
      ],
      flagAlt: true, flagTo: true,
      comms: [['ATIS', '132.65'], ['POTOMAC APPROACH', '124.7'], ['DCA TOWER', '119.1'], ['GND CON', '121.7']]
    },
    msa: { ref: 'DCA', alt: 3300, r: 25 },
    sua: { label: 'P-56A', lat: 38.8895, lon: -77.0353, r: 1.1 },
    mins: {
      cols: ['A', 'B', 'C', 'D'],
      rows: [
        { el: 'mins-lnav', label: 'RNP 0.30  DA', cells: ['—', '—', '533-1½ (522-1½)', '533-1½ (522-1½)'] },
        { el: 'mins-lnav', label: 'RNP 0.15  DA', cells: ['—', '—', '373-1 (362-1)', '373-1 (362-1)'] },
        { el: 'mins-circling', label: 'CIRCLING', cells: ['NA', 'NA', 'NA', 'NA'] }
      ]
    },
    illus: ['brief', 'mins', 'msa', 'chartRef'],
    real: 'https://www.flightaware.com/resources/airport/KDCA/IAP/RNAV+(RNP)+Z+RWY+19'
  },

  /* ------------------------------------------------------- 8. the highest one */
  {
    id: 'ktex-rnav9', icao: 'KTEX', proc: 'R09-Z',
    title: 'RNAV (GPS) Z RWY 9',
    city: 'TELLURIDE, COLORADO', aptName: 'TELLURIDE RGNL (TEX)',
    group: 'unusual', tag: 'Highest commercial field in the US',
    lead: 'Telluride sits on a mesa at 9,070 ft with the ground falling away off both ends of the runway. Every altitude on this chart is one you would associate with cruise, the approach is flown at true airspeeds well above the indicated numbers, and the missed approach climbs to 15,000.',
    why: [
      'Field elevation <b>9,070 ft</b>. The minimum descent altitude here is higher than the cruising altitude of most training flights.',
      'The final approach fix is crossed near <b>12,900 ft</b>, and the missed approach holds at <b>15,000</b> — supplemental oxygen is a procedural item, not a footnote.',
      'A descent angle steeper than standard, because the mesa edge does not leave room for a normal 3° path.',
      'Density altitude on a summer afternoon regularly puts the aircraft above 12,000 ft of performance on a 9,000 ft runway.'
    ],
    chartRef: 'AL-6134 (FAA)', amdt: 'Amdt 1',
    brief: {
      navLabel: 'GPS', navFreq: '', navIdent: '', chan: '',
      lights: 'MALSR Rwy 9', tdze: 9078, rwyIdg: 7111,
      notes: [
        'Circling NA at night. Procedure NA at night.',
        'For uncompensated Baro-VNAV systems, LNAV/VNAV NA below -20°C or above 40°C.',
        'Missed approach requires minimum climb of 350 ft per NM to 15,000.'
      ],
      flagAlt: true, flagTo: true,
      comms: [['AWOS-3', '118.475'], ['DENVER CENTER', '133.4'], ['CTAF/UNICOM', '122.8']]
    },
    msa: { ref: 'ETL', alt: 16000, r: 25 },
    mins: {
      cols: ['A', 'B', 'C', 'D'],
      rows: [
        { el: 'mins-lpv', label: 'LPV  DA', cells: ['9,538-1 (460-1)', '9,538-1 (460-1)', '—', '—'] },
        { el: 'mins-lnav', label: 'LNAV  MDA', cells: ['9,860-1 (782-1)', '9,860-1 (782-1)', '9,860-2½ (782-2½)', '—'] },
        { el: 'mins-circling', label: 'CIRCLING', cells: ['10,000-1 (930-1)', '10,000-1½ (930-1½)', 'NA', 'NA'] }
      ]
    },
    illus: ['brief', 'mins', 'msa', 'chartRef'],
    real: 'https://www.flightaware.com/resources/airport/KTEX/IAP/RNAV+(GPS)+Z+RWY+9'
  },

  /* --------------------------------------------------------- 9. the Alaska one */
  {
    id: 'pajn-rnav8', icao: 'PAJN', proc: 'R08-Z',
    title: 'RNAV (GPS) Z RWY 8',
    city: 'JUNEAU, ALASKA', aptName: 'JUNEAU INTL (JNU)',
    group: 'unusual', tag: 'Fjord approach · terrain on both sides',
    lead: 'Juneau has no road connection to anywhere, weather that sits on the field for days, and mountains rising to 3,500 ft within a couple of miles of the runway on both sides. The approach comes up the Gastineau Channel and the missed approach climbs to 9,000 ft over the water, because there is nowhere else to go.',
    why: [
      'The initial altitudes stay at <b>3,400 ft</b> a long way out — the terrain either side of the channel does not permit a normal descent profile.',
      'The missed approach climbs to <b>9,000 ft</b> at a fix well out over the water, one of the highest missed approach altitudes at a sea-level airport in the country.',
      'Both transitions arrive from the west along the water. There is no approach from the east — the ice field is in the way.',
      'Juneau is the classic case for the RNP AR procedures that made scheduled service here practical at all.'
    ],
    chartRef: 'AL-1234 (FAA)', amdt: 'Amdt 2',
    brief: {
      navLabel: 'GPS', navFreq: '', navIdent: '', chan: '',
      lights: 'MALSR Rwy 8', tdze: 12, rwyIdg: 8857,
      notes: [
        'Procedure NA at night.',
        'Helicopter visibility reduction below ¾ SM NA.',
        'When local altimeter setting not received, procedure NA.'
      ],
      flagAlt: true, flagTo: true,
      comms: [['ATIS', '135.075'], ['ANCHORAGE CENTER', '126.4'], ['JUNEAU TOWER *', '118.7'], ['GND CON', '121.9']]
    },
    msa: { ref: 'OGEME', alt: 9000, r: 25 },
    mins: {
      cols: ['A', 'B', 'C', 'D'],
      rows: [
        { el: 'mins-lnav', label: 'LNAV  MDA', cells: ['1,040-1½ (1,028-1½)', '1,040-1½ (1,028-1½)', '1,040-2¾ (1,028-2¾)', '—'] },
        { el: 'mins-circling', label: 'CIRCLING', cells: ['NA', 'NA', 'NA', 'NA'] }
      ]
    },
    illus: ['brief', 'mins', 'msa', 'chartRef'],
    real: 'https://www.flightaware.com/resources/airport/PAJN/IAP/RNAV+(GPS)+Z+RWY+8'
  }
];

// Order the guided tour walks, and the order the element index is listed in.
window.PLATE_TOUR = [
  'chart-ref', 'amdt', 'margin-title',
  'brief-strip', 'nav-freq', 'app-crs', 'gs-alt', 'rwy-tdze',
  'proc-notes', 'nonstd-symbols', 'missed-text', 'missed-icons', 'comm-strip',
  'planview', 'msa', 'taa', 'iaf', 'feeder', 'hilpt', 'if-fix', 'final-course',
  'faf', 'map-fix', 'missed-track', 'missed-hold', 'nav-symbol', 'terrain',
  'restricted', 'airport-symbol', 'north-scale',
  'profile', 'faf-profile', 'gs-path', 'step-downs', 'tch', 'vdp',
  'missed-profile', 'rate-table', 'timing-table',
  'mins-box', 'mins-cat', 'mins-precision', 'mins-lpv', 'mins-lnavvnav',
  'mins-lnav', 'mins-loc', 'mins-circling', 'mins-vis', 'inop-table',
  'apt-sketch', 'lighting', 'bottom-margin'
];
