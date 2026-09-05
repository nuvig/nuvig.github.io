"""Shared track simplification for the exporter and the API.

Douglas-Peucker simplification in a local tangent plane (nm), run per gap-free
segment, with altitude colour-bucket and on-ground transitions force-kept so the
tar1090-style colouring stays put. An optional near-field ring carries its own
(finer) tolerance, so the 1 Hz fixes the collector takes around the pattern
survive export instead of collapsing onto a straight downwind. This preserves a track's *shape* — turns,
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


def in_near(p, near):
    """Is fix p inside the near ring? near = (lat, lon, radius_nm, eps_nm)."""
    dy = (p[1] - near[0]) * NM_PER_DEG
    dx = (p[2] - near[1]) * NM_PER_DEG * math.cos(math.radians(near[0]))
    return dx * dx + dy * dy <= near[2] * near[2]


def simplify_track(pts, eps_nm, near=None):
    """pts: list of [ts,lat,lon,alt,gs,on_ground] sorted by ts -> simplified list.

    eps_nm is the perpendicular tolerance: a point is dropped only if it sits
    within eps_nm of the straight line between its kept neighbours. 0 disables.

    near = (lat, lon, radius_nm, eps_nm) applies its own tolerance inside a
    ring around that centre (0 keeps every fix there). The run breaks at each
    crossing, so neither tolerance leaks across the boundary.
    """
    n = len(pts)
    if near and (near[2] <= 0 or near[3] == eps_nm):
        near = None
    if n <= 2 or (eps_nm <= 0 and near is None):
        return pts
    cos_lat = math.cos(math.radians(pts[0][1]))
    keep = [False] * n
    keep[0] = keep[n - 1] = True

    def run(lo, hi, eps):
        if eps > 0:
            _rdp(pts, lo, hi, cos_lat, eps, keep)
        else:                          # keep every fix in this run
            for k in range(lo, hi + 1):
                keep[k] = True

    seg_start = 0
    prev_bucket = _colour_bucket(pts[0])
    near_run = in_near(pts[0], near) if near else False
    for i in range(1, n):
        b = _colour_bucket(pts[i])
        if b != prev_bucket:          # keep colour transitions on both sides
            keep[i] = True
            keep[i - 1] = True
            prev_bucket = b
        now_near = in_near(pts[i], near) if near else False
        # break the run on a coverage gap or a crossing of the near ring
        if pts[i][0] - pts[i - 1][0] > GAP_S or now_near != near_run:
            keep[i - 1] = True
            keep[i] = True
            run(seg_start, i - 1, near[3] if near_run else eps_nm)
            seg_start = i
            near_run = now_near
    run(seg_start, n - 1, near[3] if near_run else eps_nm)
    return [pts[i] for i in range(n) if keep[i]]
