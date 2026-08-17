# SPDX-FileCopyrightText: 2026 Michael Kofler
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Convergence chart for /learn/hinge-bracket-stiffness/.

Draws computed stiffness k_w against mesh node count for both element orders,
from the sweep measured by analyze-hinge.mjs, and writes
web/public/learn/hinge-convergence.svg.

Two things make the output fit the page rather than look like a stock plot:

* Text is emitted as real <text> (svg.fonttype = "none"), not outlines, so the
  page's webfont renders it and the file stays a few kB.
* Every colour is drawn with a sentinel value that is rewritten afterwards into
  a CSS custom property. The figure is inlined into the article, so the site's
  light/dark toggle drives it like any other element — an <img>-loaded SVG is an
  isolated document and cannot see the page theme at all.

Usage:  python3 examples/learn-figures/plot_hinge_convergence.py
"""

from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.ticker import FuncFormatter  # noqa: E402

OUT = Path(__file__).resolve().parents[2] / "web/public/learn/hinge-convergence.svg"

# Measured by analyze-hinge.mjs — (max element size mm, mesh nodes, k_w N/mm).
LINEAR = [
    (10, 5699, 11889.6),
    (8, 6353, 11812.7),
    (6, 7051, 11803.7),
    (5, 8111, 11750.3),
    (4, 9542, 11704.8),
    (3, 10524, 11575.0),
    (2.5, 11056, 11549.0),
    (2, 12690, 11364.0),
]
QUADRATIC = [
    (10, 5699, 10168.9),
    (8, 6353, 10102.6),
    (6, 7051, 10123.0),
    (5, 8111, 10143.5),
    (4, 9542, 10185.0),
]

# Sentinels rewritten to CSS custom properties below. Chosen so they cannot
# collide with a colour matplotlib picks on its own.
INK = "#010203"
MUTED = "#040506"
GRID = "#070809"
AXIS = "#0a0b0c"
SERIES_LINEAR = "#0d0e0f"
SERIES_QUAD = "#101112"
BAND = "#131415"

CSS_VAR = {
    INK: "var(--fig-ink)",
    MUTED: "var(--fig-muted)",
    GRID: "var(--fig-grid)",
    AXIS: "var(--fig-axis)",
    SERIES_LINEAR: "var(--fig-series-a)",
    SERIES_QUAD: "var(--fig-series-b)",
    BAND: "var(--fig-band)",
}

plt.rcParams.update(
    {
        "svg.fonttype": "none",  # keep text as <text>, styled by the page font
        "font.family": "DejaVu Sans",  # rewritten to the page stack below
        "font.size": 11.5,
        "figure.dpi": 100,
        "savefig.transparent": True,
    }
)

fig, ax = plt.subplots(figsize=(7.8, 4.15))

lin_n = [r[1] for r in LINEAR]
lin_k = [r[2] for r in LINEAR]
quad_n = [r[1] for r in QUADRATIC]
quad_k = [r[2] for r in QUADRATIC]

# The converged band: the full spread of the quadratic sweep. Showing it as a
# band rather than a line is the whole point of the figure — it is the "this has
# stopped moving" that the linear curve never reaches.
ax.axhspan(min(quad_k), max(quad_k), color=BAND, lw=0, zorder=0)

ax.plot(
    lin_n, lin_k,
    color=SERIES_LINEAR, lw=2.2, marker="o", ms=5.5,
    mfc=SERIES_LINEAR, mec=SERIES_LINEAR, zorder=3,
)
ax.plot(
    quad_n, quad_k,
    color=SERIES_QUAD, lw=2.2, marker="o", ms=5.5,
    mfc=SERIES_QUAD, mec=SERIES_QUAD, zorder=3,
)

ax.set_xlim(5100, 13400)
ax.set_ylim(9700, 12420)
ax.set_xlabel("Mesh nodes", color=MUTED, labelpad=8)
ax.set_ylabel("Stiffness $k_w$  [N/mm]", color=MUTED, labelpad=9)

ax.yaxis.set_major_formatter(FuncFormatter(lambda v, _: f"{v:,.0f}"))
ax.xaxis.set_major_formatter(FuncFormatter(lambda v, _: f"{v / 1000:g}k"))
ax.grid(axis="y", color=GRID, lw=0.9, ls=(0, (2, 4)), zorder=0)
ax.set_axisbelow(True)
ax.tick_params(colors=MUTED, labelcolor=MUTED, length=0, pad=7)
for side in ("top", "right"):
    ax.spines[side].set_visible(False)
for side in ("left", "bottom"):
    ax.spines[side].set_color(AXIS)
    ax.spines[side].set_linewidth(1.0)

# Second x-axis carrying the control the reader actually sets in the app: the
# maximum element size that produced each mesh.
top = ax.secondary_xaxis("top")
top.set_xticks(lin_n)
top.set_xticklabels([f"{r[0]:g}" for r in LINEAR])
top.set_xlabel("Max element size  [mm]", color=MUTED, labelpad=8)
top.tick_params(colors=MUTED, labelcolor=MUTED, length=0, pad=5)
top.spines["top"].set_visible(False)

# Direct labelling instead of a legend box: with only two series, naming each
# curve where it sits saves the reader the colour-to-label lookup, and there is
# no legend to collide with the callouts.
ax.text(
    lin_n[1], lin_k[1] + 210, "Linear tetrahedra  (order 1)",
    color=SERIES_LINEAR, fontsize=11.5, va="bottom",
)
ax.text(
    quad_n[1], quad_k[1] + 190, "Quadratic elements  (order 2)",
    color=SERIES_QUAD, fontsize=11.5, va="bottom",
)

# Callouts live in the empty band between the two curves, so neither can
# overlap a data point.
ax.annotate(
    "still falling — 4.4 % below\nits coarsest-mesh value",
    xy=(lin_n[-1], lin_k[-1]), xytext=(lin_n[-1], 11050),
    ha="center", va="top", color=SERIES_LINEAR, fontsize=10.5,
    arrowprops=dict(arrowstyle="-", color=SERIES_LINEAR, lw=1, alpha=0.5,
                    shrinkA=4, shrinkB=6),
)
# No leader needed: the text sits directly under the band it names.
ax.text(
    quad_n[0], 9840, "converged band: 10,103–10,185 N/mm  (0.8 % spread)",
    ha="left", va="bottom", color=SERIES_QUAD, fontsize=10.5,
)

fig.tight_layout(pad=0.6)
fig.savefig(OUT, format="svg", bbox_inches="tight", pad_inches=0.12)
plt.close(fig)

svg = OUT.read_text(encoding="utf-8")

# matplotlib writes an XML prolog and a DOCTYPE; both are noise once the figure
# is inlined into an HTML document.
svg = svg[svg.index("<svg") :]

for sentinel, var in CSS_VAR.items():
    svg = svg.replace(sentinel, var).replace(sentinel.upper(), var)

# matplotlib quotes the family name, which would turn the whole stack into one
# (invalid) quoted name and silently drop the page back to a serif default.
# Consume the quotes so the stack lands unquoted.
FONT_STACK = "Geist, system-ui, -apple-system, sans-serif"
svg = svg.replace("'DejaVu Sans'", FONT_STACK).replace("DejaVu Sans", FONT_STACK)

# Scope the figure so the article's CSS can target it, and let it scale to the
# column width instead of the fixed pt size matplotlib bakes in.
svg = svg.replace(
    "<svg ",
    '<svg class="kf-chart" role="img" aria-labelledby="kfConvTitle" '
    'preserveAspectRatio="xMidYMid meet" ',
    1,
)

# The palette is scoped to the figure's own root class rather than :root, so it
# works standalone AND survives inlining without leaking variables into the
# page. Inlined, the [data-theme="light"] ancestor selector matches the site's
# manual theme toggle.
STYLE = """
<style>
.kf-chart{width:100%;height:auto;display:block;
  --fig-ink:#eceef3;--fig-muted:#9aa0ad;--fig-grid:#2a2e38;--fig-axis:#3a3f4b;
  --fig-series-a:#ff6b6e;--fig-series-b:#7aa0ff;--fig-band:rgba(122,160,255,.12)}
[data-theme="light"] .kf-chart{
  --fig-ink:#0d1117;--fig-muted:#5b616e;--fig-grid:#e7e9ee;--fig-axis:#c9cdd6;
  --fig-series-a:#d93438;--fig-series-b:#2f54eb;--fig-band:rgba(47,84,235,.09)}
</style>"""
TITLE = (
    '<title id="kfConvTitle">Computed stiffness against mesh node count. '
    "Linear tetrahedra fall steadily from 11,890 to 11,364 N/mm without "
    "settling. Quadratic elements on the same meshes stay inside a narrow band "
    "between 10,103 and 10,185 N/mm from the coarsest mesh onward.</title>"
)
# The title and the scoped palette both go immediately after the opening tag —
# the first ">" in the document closes it, since no attribute value contains one.
svg = svg.replace(">", ">\n" + TITLE + STYLE, 1)

OUT.write_text(svg, encoding="utf-8")
print(f"hinge-convergence.svg  — {len(svg) / 1024:.1f} kB, {len(LINEAR)} linear + {len(QUADRATIC)} quadratic points")
