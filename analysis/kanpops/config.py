"""Site constants for the KANP traffic-pattern study.

Mirrors js/site-config.js (the website's single source of truth). All
headings are degrees TRUE, matching the rest of the repo — never magnetic.
"""

from dataclasses import dataclass, field

# --- Field geometry -------------------------------------------------------

KANP_LAT = 38.9422          # reference point used by the collector (dist_nm)
KANP_LON = -76.5684
FIELD_ELEV_FT = 34          # MSL

# Single runway 12/30. True axis per FAA (charted 120/300 magnetic, ~11 W var).
RWY_12_TRUE = 107.0
RWY_30_TRUE = 287.0
PATTERN_SIDE = "L"          # left traffic BOTH runways (published, don't infer)
TPA_MSL_FT = 1000           # nominal traffic-pattern altitude

# --- Default analysis thresholds ------------------------------------------
# These are the *defaults*; ops.sensitivity() sweeps around them.

@dataclass(frozen=True)
class OpsThresholds:
    contact_alt_msl_ft: float = 1200.0   # "at the field" ceiling (MSL)
    contact_dist_nm: float = 2.0         # "at the field" radius
    flight_gap_s: int = 600              # >10 min between points = new flight
    min_contact_points: int = 3          # reject 1-2 point noise contacts
    # final-approach window used for runway inference (nm from reference)
    final_min_nm: float = 0.3
    final_max_nm: float = 1.5
    # a "touch" with no ground points that never gets below this (MSL) is a
    # low TRANSIT through the gates (shoreline helicopters etc.), not an op
    transit_floor_msl_ft: float = 400.0

DEFAULT_THRESHOLDS = OpsThresholds()

# The site's ops gates (js/site-config.js opsGates): tight enough that pattern
# altitude (~1,000 ft MSL at ~1 nm) does NOT count as a field contact, so
# individual circuits resolve as separate contacts instead of merging.
TIGHT_THRESHOLDS = OpsThresholds(contact_alt_msl_ft=600.0, contact_dist_nm=0.8)

# Sweep grids for the sensitivity analysis (Step 2). Include the tight-gate
# values so the sweep spans both regimes (circuit-resolving vs. pattern-
# swallowing — see the ops.py module docstring).
SWEEP_ALT_FT = (600.0, 800.0, 1000.0, 1200.0, 1500.0)
SWEEP_DIST_NM = (0.8, 1.0, 1.5, 2.0, 3.0)
SWEEP_GAP_S = (300, 600, 1200)

# --- Unit helpers ----------------------------------------------------------

NM_PER_DEG_LAT = 60.0079    # at 39N, close enough for a 3 nm frame

def nm_per_deg_lon(lat_deg: float) -> float:
    import math
    return NM_PER_DEG_LAT * math.cos(math.radians(lat_deg))
