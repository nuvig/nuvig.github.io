"""Shared track simplification for the exporter and the API.

Douglas-Peucker simplification in a local tangent plane (nm), run per gap-free
segment, with altitude colour-bucket and on-ground transitions force-kept so the
tar1090-style colouring stays put. This preserves a track's *shape* — turns,
pattern work, climbs/descents — while dropping only the redundant points along
straight legs. Unlike a uniform stride (keep every Nth fix), it never cuts a
corner, so a decimated track still reads as the real flight path.

Point tuple, as stored/returned everywhere: [ts, lat, lon, alt, gs, on_ground].
"""

import math

NM_PER_DEG = 60.0     # 1 degree of latitude ≈ 60 nm
GAP_S = 300           # start a new segment after this time gap (matches the map)
ALT_BUCKET_FT = 500   # colour resolution along a track (matches the map)


def _colour_bucket(p):
    """The value the map colours by, so transitions in it must be kept."""
    if p[5]:                       # on ground
        return "g"
    if p[3] is None:               # unknown altitude
        return "u"
    return p[3] // ALT_BUCKET_FT


def _rdp(pts, lo, hi, cos_lat, eps_nm, keep):
    """Iterative Douglas-Peucker over pts[lo..hi] inclusive; marks keep[]."""
    stack = [(lo, hi)]
    while stack:
        a, b = stack.pop()
        if b <= a + 1:
            continue
        ax, ay = pts[a][2] * cos_lat, pts[a][1]
        bx, by = pts[b][2] * cos_lat, pts[b][1]
        dx, dy = bx - ax, by - ay
        seg2 = dx * dx + dy * dy
        dmax, idx = -1.0, -1
        for k in range(a + 1, b):
            px, py = pts[k][2] * cos_lat, pts[k][1]
            if seg2 == 0.0:
                d = math.hypot(px - ax, py - ay)
            else:
                t = ((px - ax) * dx + (py - ay) * dy) / seg2
                t = 0.0 if t < 0.0 else 1.0 if t > 1.0 else t
                d = math.hypot(px - (ax + t * dx), py - (ay + t * dy))
            if d > dmax:
                dmax, idx = d, k
        if idx >= 0 and dmax * NM_PER_DEG > eps_nm:
            keep[idx] = True
            stack.append((a, idx))
            stack.append((idx, b))


def simplify_track(pts, eps_nm):
    """pts: list of [ts,lat,lon,alt,gs,on_ground] sorted by ts → simplified list.

    eps_nm is the perpendicular tolerance: a point is dropped only if it sits
    within eps_nm of the straight line between its kept neighbours. 0 disables.
    """
    n = len(pts)
    if n <= 2 or eps_nm <= 0:
        return pts
    cos_lat = math.cos(math.radians(pts[0][1]))
    keep = [False] * n
    keep[0] = keep[n - 1] = True

    seg_start = 0
    prev_bucket = _colour_bucket(pts[0])
    for i in range(1, n):
        b = _colour_bucket(pts[i])
        if b != prev_bucket:          # keep colour transitions on both sides
            keep[i] = True
            keep[i - 1] = True
            prev_bucket = b
        if pts[i][0] - pts[i - 1][0] > GAP_S:   # coverage gap → break the run
            keep[i - 1] = True
            keep[i] = True
            _rdp(pts, seg_start, i - 1, cos_lat, eps_nm, keep)
            seg_start = i
    _rdp(pts, seg_start, n - 1, cos_lat, eps_nm, keep)
    return [pts[i] for i in range(n) if keep[i]]
