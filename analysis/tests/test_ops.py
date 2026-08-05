"""Synthetic-flight tests for kanpops.ops — run: python tests/test_ops.py

Builds a scripted pattern session at KANP (depart RWY 30, two low passes,
full-stop) and checks that:
  * tight gates (600 ft / 0.8 nm) resolve it into 6 operations
    (1 departure + 2 touches x2 + 1 arrival), runways inferred as 30;
  * the user-spec gates (1,200 ft / 2 nm) swallow the whole session —
    the aircraft never exits "contact", so there is NO airborne context and
    the session yields zero operations. This is the failure mode the
    sensitivity sweep exists to expose.
"""

import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from kanpops.config import DEFAULT_THRESHOLDS, TIGHT_THRESHOLDS  # noqa: E402
from kanpops.flights import Flight  # noqa: E402
from kanpops.ops import detect_flight_contacts  # noqa: E402


def seg(n, alt, dist, track, ground=False, gs=70.0):
    """n points of a phase; alt/dist may be (start, end) ramps."""
    def ramp(v):
        return np.linspace(v[0], v[1], n) if isinstance(v, tuple) else np.full(n, v)
    return (ramp(alt), ramp(dist), np.full(n, float(track)),
            np.full(n, bool(ground)), np.full(n, float(gs)))


def build_flight():
    phases = [
        seg(20, np.nan, 0.05, np.nan, ground=True, gs=0),     # parked
        seg(7, np.nan, 0.08, 287, ground=True, gs=40),        # takeoff roll
        seg(20, (100, 900), (0.1, 1.2), 287),                 # climb upwind
        seg(40, 1000, (1.2, 1.5), 107),                       # downwind
        seg(20, (900, 250), (1.5, 0.4), 287),                 # base/final
        seg(7, (150, 100), (0.3, 0.1), 287),                  # low pass 1
        seg(20, (200, 900), (0.2, 1.2), 287),                 # climb
        seg(40, 1000, (1.2, 1.5), 107),                       # downwind
        seg(20, (900, 250), (1.5, 0.4), 287),                 # base/final
        seg(7, (150, 100), (0.3, 0.1), 287),                  # low pass 2
        seg(20, (200, 900), (0.2, 1.2), 287),                 # climb
        seg(40, 1000, (1.2, 1.5), 107),                       # downwind
        seg(20, (900, 150), (1.5, 0.3), 287),                 # final
        seg(10, np.nan, 0.1, 287, ground=True, gs=30),        # rollout/taxi
        seg(20, np.nan, 0.05, np.nan, ground=True, gs=0),     # parked
    ]
    alt = np.concatenate([p[0] for p in phases])
    dist = np.concatenate([p[1] for p in phases])
    track = np.concatenate([p[2] for p in phases])
    ground = np.concatenate([p[3] for p in phases])
    gs = np.concatenate([p[4] for p in phases])
    n = len(alt)
    return Flight(hex="test01", ts=np.arange(n, dtype=np.int64) * 3,
                  lat=np.full(n, 38.94), lon=np.full(n, -76.57),
                  alt=alt, gs=gs, track=track, dist_nm=dist,
                  on_ground=ground.astype(bool),
                  baro_rate=np.full(n, np.nan))


def main():
    f = build_flight()

    tight = detect_flight_contacts(f, TIGHT_THRESHOLDS)
    kinds = [c.kind for c in tight]
    ops = sum(c.ops for c in tight)
    print("tight gates :", kinds, "->", ops, "ops")
    assert kinds == ["departure", "touch", "touch", "arrival"], kinds
    assert ops == 6, ops
    assert tight[0].dep_rwy == "30", tight[0]
    assert tight[1].arr_rwy == "30" and tight[1].dep_rwy == "30", tight[1]
    assert tight[3].arr_rwy == "30", tight[3]

    loose = detect_flight_contacts(f, DEFAULT_THRESHOLDS)
    kinds = [c.kind for c in loose]
    ops = sum(c.ops for c in loose)
    print("loose gates :", kinds, "->", ops, "ops")
    assert kinds == ["ground_only"], kinds     # the documented pathology
    assert ops == 0, ops

    print("OK — all assertions passed")


if __name__ == "__main__":
    main()
