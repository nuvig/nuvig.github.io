"""Publication figures (matplotlib, no seaborn).

Figure 1  ground tracks of all detected operations within 3 nm of KANP,
          drawn as per-flight polylines colored by baro altitude — the
          traffic-pattern shape reads directly from the ink.
Figure 2  distribution of downwind-leg altitude, split by runway.

Colors follow the dataviz reference palette: altitude is a *sequential* job
(single blue hue; dark = low/pattern, light = high, so the pattern carries
the ink on a white page), the runway split is *categorical* slots 1-2
(blue / orange — validated CVD-safe pair). Chrome (ink, grid, axis) uses the
documented light-surface tokens.
"""

from __future__ import annotations

import math
import sqlite3

import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.collections import LineCollection
from matplotlib.colors import LinearSegmentedColormap, Normalize

from . import config
from .config import OpsThresholds
from .db import OPEN_WINDOW, Window
from .flights import iter_flights
from .ops import detect_flight_contacts, ang_diff

# --- palette (dataviz reference instance, light mode) ------------------------

SURFACE = "#fcfcfb"
INK = "#0b0b0b"
INK_2 = "#52514e"
MUTED = "#898781"
GRID = "#e1e0d9"
AXIS = "#c3c2b7"
SERIES_1 = "#2a78d6"   # categorical slot 1 (blue)  — RWY 30
SERIES_2 = "#eb6834"   # categorical slot 2 (orange) — RWY 12

# Sequential blue ramp, steps 700 -> 100, so LOW altitude = dark ink and high
# altitude recedes toward the light surface (single hue, monotonic lightness).
_BLUE_RAMP = ["#0d366b", "#104281", "#184f95", "#1c5cab", "#256abf", "#2a78d6",
              "#3987e5", "#5598e7", "#6da7ec", "#86b6ef", "#9ec5f4", "#b7d3f6",
              "#cde2fb"]
ALT_CMAP = LinearSegmentedColormap.from_list("alt_blue", _BLUE_RAMP)

RC = {
    "figure.facecolor": SURFACE, "axes.facecolor": SURFACE,
    "savefig.facecolor": SURFACE,
    "font.family": ["Segoe UI", "Arial", "DejaVu Sans"],
    "font.size": 9, "axes.titlesize": 10.5, "axes.labelsize": 9,
    "axes.edgecolor": AXIS, "axes.labelcolor": INK_2,
    "axes.linewidth": 0.8, "axes.grid": True,
    "grid.color": GRID, "grid.linewidth": 0.6,
    "xtick.color": MUTED, "ytick.color": MUTED,
    "xtick.labelsize": 8, "ytick.labelsize": 8,
    "text.color": INK, "legend.frameon": False,
    "savefig.dpi": 300, "figure.dpi": 120,
}


# --- local runway-frame geometry ---------------------------------------------

def enu_nm(lat: np.ndarray, lon: np.ndarray):
    """East/North offsets from the KANP reference point, in nm."""
    x = (lon - config.KANP_LON) * config.nm_per_deg_lon(config.KANP_LAT)
    y = (lat - config.KANP_LAT) * config.NM_PER_DEG_LAT
    return x, y


def runway_frame(x: np.ndarray, y: np.ndarray):
    """(along, cross) in nm. along: + toward the 107 deg (RWY 12) direction;
    cross: + toward 017 deg = left of RWY 12 = the NE side (KANP's left-
    pattern side for RWY 12; RWY 30's left pattern is the SW side, cross<0)."""
    th = math.radians(config.RWY_12_TRUE)
    ux, uy = math.sin(th), math.cos(th)                          # along 107°
    lx, ly = math.sin(th - math.pi / 2), math.cos(th - math.pi / 2)  # 017°
    along = x * ux + y * uy
    cross = x * lx + y * ly
    return along, cross


# --- data collection ----------------------------------------------------------

def collect_figure_data(db: sqlite3.Connection, hexes: list[str],
                        th: OpsThresholds = config.TIGHT_THRESHOLDS,
                        radius_nm: float = 3.0, w: Window = OPEN_WINDOW,
                        log=print):
    """One pass over candidate flights; returns (fig1, fig2) data.

    fig1: list of per-flight (x_nm, y_nm, alt_plot, ts) arrays restricted to
          points within radius_nm, for flights with >=1 operation.
    fig2: dict with downwind-leg point altitudes per runway.
    """
    tracks = []
    dw_alt = {"12": [], "30": []}
    half_w = math.radians(30)  # heading tolerance around the downwind course

    for f in iter_flights(db, hexes, th.flight_gap_s, w):
        contacts = [c for c in detect_flight_contacts(f, th, infer_rwy=False)
                    if c.kind in ("arrival", "departure", "touch")]
        if not contacts:
            continue
        near = f.dist_nm <= radius_nm
        if near.sum() < 2:
            continue
        x, y = enu_nm(f.lat[near], f.lon[near])
        alt = f.alt[near].copy()
        alt[f.on_ground[near]] = config.FIELD_ELEV_FT   # ground rows: field elev
        tracks.append((x, y, alt, f.ts[near]))

        # downwind-leg points: parallel to the runway, laterally offset on the
        # pattern side, near-level at pattern-plausible altitude and speed,
        # and temporally tied to a field contact (excludes the enroute legs
        # of the same flight that happen to parallel the runway)
        along, cross = runway_frame(x, y)
        trk = f.track[near]
        gs = f.gs[near]
        br = f.baro_rate[near]
        ts_near = f.ts[near]
        near_contact = np.zeros(len(ts_near), dtype=bool)
        for c in contacts:
            near_contact |= ((ts_near >= c.t_start - 480)
                             & (ts_near <= c.t_end + 480))
        # pattern-plausible band only: above 400 ft MSL (out of the climb /
        # short final) and below TPA + 500 ft — level parallel traffic higher
        # than that is corridor cruise (South River transitions), not pattern
        level = np.isnan(br) | (np.abs(br) <= 400)
        ok = (~f.on_ground[near] & ~np.isnan(alt) & ~np.isnan(trk)
              & (alt >= 400) & (alt <= config.TPA_MSL_FT + 500)
              & (np.abs(along) <= 1.6)
              & ~np.isnan(gs) & (gs >= 50)
              & level & near_contact)
        d12 = np.array([ang_diff(t, (config.RWY_12_TRUE + 180) % 360)
                        for t in trk])
        d30 = np.array([ang_diff(t, (config.RWY_30_TRUE + 180) % 360)
                        for t in trk])
        m12 = ok & (d12 <= 30) & (cross >= 0.25) & (cross <= 1.5)   # NE side
        m30 = ok & (d30 <= 30) & (cross <= -0.25) & (cross >= -1.5)  # SW side
        dw_alt["12"].extend(alt[m12])
        dw_alt["30"].extend(alt[m30])

    dw_alt = {k: np.array(v) for k, v in dw_alt.items()}
    log(f"  figure data: {len(tracks)} op flights,"
        f" downwind pts 12={len(dw_alt['12'])} 30={len(dw_alt['30'])}")
    return tracks, dw_alt


# --- figure 1: track density ----------------------------------------------------

def fig_track_density(tracks, out_base: str, radius_nm: float = 3.0,
                      vmax_ft: float = 1600.0, subtitle: str | None = None,
                      log=print):
    with plt.rc_context(RC):
        fig, ax = plt.subplots(figsize=(6.6, 6.2))
        norm = Normalize(vmin=0, vmax=vmax_ft, clip=False)

        segs, vals = [], []
        for x, y, alt, ts in tracks:
            if len(x) < 2:
                continue
            keep = np.diff(ts) <= 30          # don't bridge re-entries
            p = np.column_stack([x, y])
            s = np.stack([p[:-1], p[1:]], axis=1)[keep]
            a = np.fmin(alt[:-1], alt[1:])[keep]   # segment colored by lower end
            good = ~np.isnan(a)
            segs.append(s[good])
            vals.append(np.clip(a[good], 0, vmax_ft))
        segs = np.concatenate(segs)
        vals = np.concatenate(vals)
        log(f"  fig1: {len(segs):,} track segments")

        lc = LineCollection(segs, cmap=ALT_CMAP.reversed(), norm=norm,
                            linewidths=0.5, alpha=0.35, capstyle="round",
                            rasterized=True)
        lc.set_array(vals)
        ax.add_collection(lc)

        # range rings + runway
        for r in (1, 2, 3):
            ax.add_patch(plt.Circle((0, 0), r, fill=False, ec=AXIS, lw=0.7,
                                    ls=(0, (4, 4)), zorder=3))
            ax.annotate(f"{r} nm", (r * math.cos(math.radians(45)),
                                    r * math.sin(math.radians(45))),
                        color=MUTED, fontsize=7.5, ha="left", va="bottom")
        th = math.radians(config.RWY_12_TRUE)
        half = (2505 / 2) / 6076.12   # runway half-length in nm
        dx, dy = math.sin(th) * half, math.cos(th) * half
        ax.plot([-dx, dx], [-dy, dy], color=INK, lw=3.2,
                solid_capstyle="butt", zorder=5)
        ax.annotate("RWY 12/30", (dx + 0.06, dy - 0.10), color=INK,
                    fontsize=8, fontweight="bold")

        ax.set_xlim(-radius_nm * 1.04, radius_nm * 1.04)
        ax.set_ylim(-radius_nm * 1.04, radius_nm * 1.04)
        ax.set_aspect("equal")
        ax.set_xlabel("East of KANP reference (nm)")
        ax.set_ylabel("North of KANP reference (nm)")
        title = ("KANP operations — ground tracks within 3 nm,"
                 " colored by altitude")
        ax.set_title(title, color=INK, pad=16 if subtitle else 10)
        if subtitle:
            # sits between title and axes; pad above leaves the room for it
            ax.annotate(subtitle, xy=(0.5, 1.0), xycoords="axes fraction",
                        xytext=(0, 4), textcoords="offset points",
                        ha="center", va="bottom", color=MUTED, fontsize=8)
        cb = fig.colorbar(lc, ax=ax, shrink=0.8, pad=0.02, extend="max")
        cb.set_label("Baro altitude (ft MSL)", color=INK_2)
        cb.ax.tick_params(color=MUTED, labelcolor=MUTED, labelsize=8)
        cb.outline.set_edgecolor(AXIS)
        cb.solids.set_alpha(1.0)

        fig.tight_layout()
        for ext in ("png", "pdf"):
            fig.savefig(f"{out_base}.{ext}")
        plt.close(fig)
        log(f"  wrote {out_base}.png/.pdf")


# --- figure 2: downwind altitude -------------------------------------------------

def fig_downwind_altitude(dw_alt: dict, out_base: str, log=print):
    with plt.rc_context(RC):
        fig, ax = plt.subplots(figsize=(6.6, 4.0))
        # 100 ft bins: ADS-B baro altitude is quantized at 25 ft, and 50 ft
        # bins alias against it (comb artifact)
        bins = np.arange(400, config.TPA_MSL_FT + 600, 100)
        styles = {"12": (SERIES_2, "Downwind RWY 12 (NE side, hdg 287°T)"),
                  "30": (SERIES_1, "Downwind RWY 30 (SW side, hdg 107°T)")}
        for rwy in ("30", "12"):
            a = dw_alt[rwy]
            if not len(a):
                continue
            color, label = styles[rwy]
            ax.hist(a, bins=bins, histtype="stepfilled", alpha=0.22,
                    color=color, edgecolor="none")
            ax.hist(a, bins=bins, histtype="step", lw=1.8, color=color,
                    label=f"{label}  n={len(a):,}, median"
                          f" {np.median(a):,.0f} ft")

        ax.axvline(config.TPA_MSL_FT, color=INK_2, lw=1.0, ls=(0, (5, 3)))
        import matplotlib.transforms as mtransforms
        blend = mtransforms.blended_transform_factory(ax.transData, ax.transAxes)
        ax.text(config.TPA_MSL_FT + 12, 0.60, f"TPA {config.TPA_MSL_FT:,} ft MSL",
                transform=blend, color=INK_2, fontsize=8, ha="left")
        ax.set_xlabel("Baro altitude on downwind (ft MSL)")
        ax.set_ylabel("Position reports")
        ax.set_title("Downwind-leg altitude distribution at KANP",
                     color=INK, pad=10)
        ax.legend(loc="upper left", fontsize=8)
        ax.grid(axis="x", visible=False)
        fig.tight_layout()
        for ext in ("png", "pdf"):
            fig.savefig(f"{out_base}.{ext}")
        plt.close(fig)
        log(f"  wrote {out_base}.png/.pdf")
