// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Figures for the results, shell, optimization and verification articles.

import { readFileSync } from "node:fs";
import {
  arrow,
  circle,
  clampLeft,
  contourColour,
  dot,
  doubleArrow,
  line,
  n,
  palette,
  path,
  polygon,
  polyline,
  rollerSupport,
  scale,
  text,
  textSup,
} from "./svg.mjs";
import { sampleCurve } from "./mesh2d.mjs";

const superscript = (value) =>
  String(value).replace(/[-\d]/g, (c) => (c === "-" ? "⁻" : "⁰¹²³⁴⁵⁶⁷⁸⁹"[c]));

// ── The axial bar ────────────────────────────────────────────────────────────

function axialBar() {
  return [
    clampLeft(80, 40, 140, 16),
    `<rect x="80" y="62" width="400" height="56" class="body"/>`,
    arrow([480, 90], [580, 90], "load"),
    text([540, 78], "P", "sym load-text", "middle", 'font-size="19"'),
    doubleArrow([80, 170], [480, 170]),
    line([80, 124], [80, 178], "dim"),
    line([480, 124], [480, 178], "dim"),
    text([280, 164], "L", "sym", "middle"),
    text([280, 96], "E, A", "sym", "middle"),
    line([480, 62], [480, 30], "dim"),
    line([524, 62], [524, 30], "dash"),
    path("M480 40H524", "accent", 'marker-end="url(#a-accent)"'),
    text([532, 44], "δ", "sym accent-text", "start", 'font-size="19"'),
  ].join("\n");
}

// ── Nodal averaging of element stresses ──────────────────────────────────────

function stressAveraging() {
  const parts = [];
  const lo = 100;
  const hi = 150;
  const c = (v) => contourColour((v - lo) / (hi - lo));
  const cell = 90;
  const patch = (ox, oy, values, label) => {
    values.forEach((v, k) => {
      const x = ox + (k % 2) * cell;
      const y = oy + Math.floor(k / 2) * cell;
      parts.push(
        `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" style="fill:${c(v)};stroke:${palette.ink};stroke-width:1.2"/>`,
        text([x + cell / 2, y + cell / 2 + 5], `${v}`, "bold halo", "middle"),
      );
    });
    parts.push(text([ox + cell, oy + 2 * cell + 28], label, "lbl"));
  };
  patch(40, 30, [100, 150, 150, 150], "element-centre samples (MPa)");
  parts.push(dot([40 + cell, 30 + cell], 6, "node-accent"));
  parts.push(
    arrow([250, 120], [320, 120], "muted"),
    text([285, 110], "average", "small lbl"),
  );
  // Averaged: a bilinear contour from nodal values.
  const nodal = [
    [100, 125, 150],
    [125, 137.5, 150],
    [150, 150, 150],
  ];
  const ox = 340;
  const oy = 30;
  const res = 12;
  for (let i = 0; i < 2 * res; i++)
    for (let j = 0; j < 2 * res; j++) {
      const u = (i + 0.5) / res;
      const v = (j + 0.5) / res;
      const ci = Math.min(1, Math.floor(u));
      const cj = Math.min(1, Math.floor(v));
      const fu = u - ci;
      const fv = v - cj;
      const val =
        nodal[cj][ci] * (1 - fu) * (1 - fv) +
        nodal[cj][ci + 1] * fu * (1 - fv) +
        nodal[cj + 1][ci] * (1 - fu) * fv +
        nodal[cj + 1][ci + 1] * fu * fv;
      const s = cell / res;
      parts.push(
        `<rect x="${n(ox + i * s)}" y="${n(oy + j * s)}" width="${n(s + 0.4)}" height="${n(s + 0.4)}" style="fill:${c(val)}"/>`,
      );
    }
  for (let k = 0; k <= 2; k++) {
    parts.push(
      line([ox + k * cell, oy], [ox + k * cell, oy + 2 * cell], "thin"),
    );
    parts.push(
      line([ox, oy + k * cell], [ox + 2 * cell, oy + k * cell], "thin"),
    );
  }
  parts.push(
    dot([ox + cell, oy + cell], 6, "node-accent"),
    text([ox + cell + 8, oy + cell - 10], "137.5", "bold halo", "start"),
    text([ox + cell, oy + 2 * cell + 28], "nodal average and contour", "lbl"),
  );
  // Colour bar.
  const bx = 560;
  for (let k = 0; k < 40; k++)
    parts.push(
      `<rect x="${bx}" y="${n(30 + (180 * k) / 40)}" width="14" height="${n(180 / 40 + 0.5)}" style="fill:${c(hi - ((hi - lo) * k) / 39)}"/>`,
    );
  parts.push(
    `<rect x="${bx}" y="30" width="14" height="180" style="fill:none;stroke:${palette.ink};stroke-width:0.8"/>`,
    text([bx + 20, 38], "150", "small", "start"),
    text([bx + 20, 214], "100", "small", "start"),
  );
  return parts.join("\n");
}

// ── Stress concentration at a circular hole ─────────────────────────────────

function kirsch() {
  const parts = [];
  const c = [180, 160];
  const a = 32;
  parts.push(
    `<rect x="${c[0] - 110}" y="${c[1] - 120}" width="220" height="240" class="body"/>`,
    circle(c, a, "node-open"),
  );
  for (let y = c[1] - 100; y <= c[1] + 100; y += 25) {
    parts.push(
      arrow(
        [c[0] + 112, y],
        [c[0] + 150, y],
        "load",
        'style="stroke-width:1.6"',
      ),
    );
    parts.push(
      arrow(
        [c[0] - 112, y],
        [c[0] - 150, y],
        "load",
        'style="stroke-width:1.6"',
      ),
    );
  }
  parts.push(
    textSup([c[0] + 160, c[1] - 104], "σ", "∞", "sym load-text", "start"),
    line([c[0], c[1] - a], [c[0], c[1] - 120], "dash"),
    dot([c[0], c[1] - a], 4.5, "node-accent"),
    text([c[0] + 8, c[1] + 6], "a", "sym", "start"),
    line(c, [c[0] + a, c[1]], "thin"),
    text([c[0] - 6, c[1] - 76], "r", "sym", "end"),
  );
  // σ_xx along the line x = 0 above the hole: 1 + a²/(2r²) + 3a⁴/(2r⁴).
  const X = scale([1, 5], [420, 680]);
  const Y = scale([0, 3.3], [280, 40]);
  const f = (r) => 1 + 1 / (2 * r * r) + 3 / (2 * r ** 4);
  for (const v of [1, 2, 3])
    parts.push(
      line([420, Y(v)], [680, Y(v)], "grid"),
      text([412, Y(v) + 4], String(v), "small lbl", "end"),
    );
  for (const r of [1, 2, 3, 4, 5])
    parts.push(text([X(r), 298], String(r), "small lbl"));
  parts.push(
    line([420, 280], [680, 280], "axis"),
    line([420, 40], [420, 280], "axis"),
    text([550, 326], "distance from the hole centre, r / a", "lbl"),
    text(
      [386, 160],
      "σ / σ∞",
      "lbl",
      "middle",
      'transform="rotate(-90 386 160)"',
    ),
    polyline(
      Array.from({ length: 101 }, (_, i) => 1 + (4 * i) / 100).map((r) => [
        X(r),
        Y(f(r)),
      ]),
      "accent",
    ),
    dot([X(1), Y(3)], 4.5, "node-accent"),
    text(
      [X(1) + 10, Y(3) + 4],
      "peak = 3σ∞ at the hole edge",
      "small",
      "start",
    ),
    line([420, Y(1)], [680, Y(1)], "dash"),
  );
  return parts.join("\n");
}

// ── Convergence rates ────────────────────────────────────────────────────────

function convergenceRates() {
  const parts = [];
  const X = scale([0.01, 1], [80, 560], true);
  const Y = scale([1e-6, 1], [300, 30], true);
  for (const e of [-6, -4, -2, 0])
    parts.push(
      line([80, Y(10 ** e)], [560, Y(10 ** e)], "grid"),
      text(
        [72, Y(10 ** e) + 4],
        e === 0 ? "1" : `10${superscript(e)}`,
        "small lbl",
        "end",
      ),
    );
  for (const e of [-2, -1, 0])
    parts.push(
      text(
        [X(10 ** e), 318],
        e === 0 ? "1" : `10${superscript(e)}`,
        "small lbl",
      ),
    );
  parts.push(
    line([80, 300], [560, 300], "axis"),
    line([80, 30], [80, 300], "axis"),
    text([320, 342], "element size h (relative)", "lbl"),
    text(
      [28, 165],
      "error (relative)",
      "lbl",
      "middle",
      'transform="rotate(-90 28 165)"',
    ),
  );
  const series = [
    { slope: 1, c: 0.5, cls: "accent2", label: "order 1: stress ∝ h" },
    {
      slope: 2,
      c: 0.25,
      cls: "accent",
      label: "order 1: displacement ∝ h², order 2: stress ∝ h²",
    },
    { slope: 3, c: 0.12, cls: "accent3", label: "order 2: displacement ∝ h³" },
  ];
  for (const { slope, c, cls } of series) {
    const pts = [0.01, 1].map((h) => [X(h), Y(Math.max(1e-6, c * h ** slope))]);
    const h0 = 0.01 ** (Math.log10(1e-6 / c) / Math.log10(0.01) / slope);
    void h0;
    parts.push(polyline(pts, cls));
  }
  // Slope triangles.
  for (const [k, { slope, c }] of series.entries()) {
    const h1 = [0.9, 0.3, 0.1][k];
    const h2 = h1 / 3;
    const p1 = [X(h1), Y(c * h1 ** slope)];
    const p2 = [X(h2), Y(c * h2 ** slope)];
    parts.push(polyline([p2, [p1[0], p2[1]], p1], "thin"));
    parts.push(
      text(
        [p1[0] + 6, (p1[1] + p2[1]) / 2 + 4],
        String(slope),
        "small",
        "start",
      ),
    );
  }
  // A singular stress that does not converge.
  parts.push(
    polyline(
      [0.01, 1].map((h) => [X(h), Y(0.15 * h ** -0.3)]),
      "",
      `style="fill:none;stroke:${palette.load};stroke-width:2;stroke-dasharray:6 4"`,
    ),
  );
  const legend = [
    ...series.map(({ cls, label }) => ({
      style: `stroke:${{ accent: palette.accent, accent2: palette.accent2, accent3: palette.accent3 }[cls]}`,
      label,
    })),
    {
      style: `stroke:${palette.load};stroke-dasharray:6 4`,
      label: "peak stress at a re-entrant corner: grows",
    },
  ];
  legend.forEach(({ style, label }, i) => {
    const y = 350 + 20 * i;
    parts.push(
      `<line x1="90" y1="${y}" x2="120" y2="${y}" style="fill:none;stroke-width:2;${style}"/>`,
      text([128, y + 4], label, "small", "start"),
    );
  });
  return parts.join("\n");
}

// ── Shell kinematics ─────────────────────────────────────────────────────────

function shellKinematics() {
  const parts = [];
  const P = ([x, y, z]) => [190 + 0.95 * x - 0.45 * y, 280 - 0.3 * y - z];
  const t = 16;
  const slab = (z) =>
    [
      [0, 0, z],
      [420, 0, z],
      [420, 300, z],
      [0, 300, z],
    ].map(P);
  parts.push(
    polygon(
      [
        ...slab(-t / 2).slice(0, 2),
        ...slab(t / 2)
          .slice(0, 2)
          .reverse(),
      ],
      "side",
    ),
    polygon(
      [slab(-t / 2)[1], slab(-t / 2)[2], slab(t / 2)[2], slab(t / 2)[1]],
      "side",
      'style="fill:#b3c8de"',
    ),
    polygon(slab(t / 2), "body-alt"),
  );
  const n0 = [50, 70, t / 2];
  const n1 = [340, 40, t / 2];
  const n2 = [210, 250, t / 2];
  parts.push(polygon([n0, n1, n2].map(P), "body", 'style="fill:#cfe0f5"'));
  for (const p of [n0, n1, n2]) parts.push(dot(P(p), 5));
  // Local axes at node 0: e1 towards node 1, e3 normal, e2 = e3 × e1.
  const d = [n1[0] - n0[0], n1[1] - n0[1]];
  const len = Math.hypot(...d);
  const e1 = [d[0] / len, d[1] / len, 0];
  const e2 = [-e1[1], e1[0], 0];
  const along = (p, e, l) =>
    P([p[0] + l * e[0], p[1] + l * e[1], p[2] + l * e[2]]);
  const o = P(n0);
  const a1 = along(n0, e1, 110);
  const a2 = along(n0, e2, 150);
  const a3 = along(n0, [0, 0, 1], 70);
  parts.push(
    arrow(o, a1, "accent"),
    arrow(o, a2, "accent"),
    arrow(o, a3, "accent"),
    text([a1[0] - 4, a1[1] + 20], ["e", "1"], "sym accent-text"),
    text([a2[0] - 8, a2[1] - 2], ["e", "2"], "sym accent-text", "end"),
    text([a3[0] + 8, a3[1] + 4], ["e", "3"], "sym accent-text", "start"),
  );
  // Node 2: three translations.
  const q = P(n2);
  const tx = along(n2, [1, 0, 0], 70);
  const ty = along(n2, [0, 1, 0], 110);
  const tz = along(n2, [0, 0, 1], 60);
  parts.push(
    arrow(q, tx, "load"),
    arrow(q, ty, "load"),
    arrow(q, tz, "load"),
    text([tz[0] + 8, tz[1] + 4], "u, v, w", "sym load-text", "start"),
  );
  // Node 1: three rotations as double-headed arrows.
  const r = P(n1);
  for (const e of [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ]) {
    const tip = along(n1, e, e[2] ? 60 : e[1] ? 110 : 70);
    const inner = [
      r[0] + 0.82 * (tip[0] - r[0]),
      r[1] + 0.82 * (tip[1] - r[1]),
    ];
    parts.push(
      line(r, tip, "accent2", 'marker-end="url(#a-accent2)"'),
      line(r, inner, "accent2", 'marker-end="url(#a-accent2)"'),
    );
  }
  const rz = along(n1, [0, 0, 1], 60);
  parts.push(
    text([rz[0] + 8, rz[1] + 4], "θx, θy, θz", "sym accent2-text", "start"),
  );
  // Thickness.
  const edge = P([420, 0, -t / 2]);
  const edgeTop = P([420, 0, t / 2]);
  parts.push(
    doubleArrow([edge[0] + 18, edge[1] + 8], [edgeTop[0] + 18, edgeTop[1] - 8]),
    text([edge[0] + 26, (edge[1] + edgeTop[1]) / 2 + 5], "t", "sym", "start"),
  );
  return parts.join("\n");
}

// ── Membrane and bending stress through the thickness ───────────────────────

function membraneBending() {
  const parts = [];
  const H = 150;
  const top = 50;
  const panel = (x0, f, label) => {
    parts.push(line([x0, top], [x0, top + H], "ink", 'style="stroke-width:2"'));
    parts.push(line([x0 - 30, top + H / 2], [x0 + 110, top + H / 2], "dash"));
    const pts = [];
    for (let i = 0; i <= 10; i++) {
      const z = 0.5 - i / 10;
      const y = top + i * (H / 10);
      pts.push([x0 + 60 * f(z), y]);
      if (i % 2 === 0 && Math.abs(f(z)) > 0.05)
        parts.push(
          arrow(
            [x0, y],
            [x0 + 60 * f(z), y],
            "load",
            'style="stroke-width:1.4"',
          ),
        );
    }
    parts.push(
      polygon(
        [[x0, top], ...pts, [x0, top + H]],
        "",
        `style="fill:${palette.load};opacity:0.12"`,
      ),
      polyline(pts, "load"),
      text([x0, top + H + 32], label, "lbl"),
    );
  };
  panel(130, () => 0.8, "membrane: uniform");
  parts.push(
    text([245, top + H / 2 - 14], "+", "title", "middle", 'font-size="26"'),
  );
  panel(320, (z) => 2 * z * 0.9, "bending: linear");
  parts.push(
    text([440, top + H / 2 - 14], "=", "title", "middle", 'font-size="26"'),
  );
  panel(520, (z) => 0.8 + 2 * z * 0.9, "shell surface stress");
  parts.push(
    text([96, top + 4], "top", "small lbl", "end"),
    text([96, top + H + 4], "bottom", "small lbl", "end"),
    text([96, top + H / 2 + 4], "mid-surface", "small lbl", "end"),
    doubleArrow([24, top], [24, top + H]),
    text([16, top + H / 2 + 5], "t", "sym", "end"),
  );
  return parts.join("\n");
}

// ── Solid–shell transition ──────────────────────────────────────────────────

function solidShellTransition() {
  const parts = [];
  // Solid block at the bottom, a wall rising from it.
  parts.push(`<rect x="60" y="250" width="420" height="80" class="body"/>`);
  const wx = 260;
  const t = 24;
  // Retained solid root of the wall (three thicknesses).
  parts.push(
    `<rect x="${wx - t / 2}" y="${250 - 3 * t}" width="${t}" height="${3 * t}" class="body"/>`,
  );
  for (let k = 1; k < 3; k++)
    parts.push(
      line([wx - t / 2, 250 - k * t], [wx + t / 2, 250 - k * t], "mesh"),
    );
  parts.push(line([wx, 250 - 3 * t], [wx, 250], "mesh"));
  // Shell mid-surface above.
  const cut = 250 - 3 * t;
  parts.push(line([wx, cut], [wx, 40], "accent", 'style="stroke-width:3"'));
  for (let y = cut; y >= 40; y -= 46)
    parts.push(dot([wx, y], 5, "node-accent"));
  parts.push(
    `<rect x="${wx - t / 2}" y="40" width="${t}" height="${cut - 40}" style="fill:none;stroke:${palette.accent};stroke-width:1;stroke-dasharray:4 3"/>`,
  );
  // Constraint links from the shell edge node to the section nodes.
  const A = [wx, cut];
  for (const x of [wx - t / 2, wx + t / 2]) {
    parts.push(
      line(A, [x, cut], "load", 'style="stroke-width:1.6"'),
      dot([x, cut], 4.5),
    );
  }
  parts.push(dot(A, 6, "node-accent"));
  // Labels.
  parts.push(
    text([wx + 40, 80], "shell mid-surface", "accent-text", "start"),
    text([wx + 40, 98], "(6 DOFs per node)", "small lbl", "start"),
    `<text x="${wx + 40}" y="${cut + 4}" class="sym load-text" style="font-weight:400">u<tspan dy="4" font-size="70%">S</tspan><tspan dy="-4"> = u</tspan><tspan dy="4" font-size="70%">A</tspan><tspan dy="-4"> + θ</tspan><tspan dy="4" font-size="70%">A</tspan><tspan dy="-4"> × r</tspan></text>`,
    text(
      [wx + 40, cut + 24],
      "rigid link to the shell edge",
      "small lbl",
      "start",
    ),
    text([wx - 40, cut + 40], "retained solid", "small lbl", "end"),
    text([wx - 40, cut + 56], "section, 3t", "small lbl", "end"),
    text([270, 300], "solid block", "lbl"),
    text([wx - 8, cut - 8], "A", "sym", "end"),
    text([wx + t / 2 + 4, cut + 18], "S", "sym", "start"),
    doubleArrow([wx - t / 2, 26], [wx + t / 2, 26]),
    text([wx, 20], "t", "sym"),
  );
  return parts.join("\n");
}

// ── SIMP interpolation ───────────────────────────────────────────────────────

function simpCurves() {
  const parts = [];
  const X = scale([0, 1], [80, 520]);
  const Y = scale([0, 1], [300, 40]);
  for (const v of [0, 0.25, 0.5, 0.75, 1]) {
    parts.push(
      line([X(v), 40], [X(v), 300], "grid"),
      line([80, Y(v)], [520, Y(v)], "grid"),
    );
    parts.push(
      text([X(v), 318], String(v), "small lbl"),
      text([72, Y(v) + 4], String(v), "small lbl", "end"),
    );
  }
  parts.push(
    line([80, 300], [520, 300], "axis"),
    line([80, 40], [80, 300], "axis"),
    text([300, 344], "element density ρ", "lbl"),
    text([30, 175], ["E / E", "0"], "lbl", "middle"),
  );
  const colours = [
    palette.muted,
    palette.accent3,
    palette.accent,
    palette.accent2,
  ];
  const Emin = 1e-3;
  [1, 2, 3, 4].forEach((p, i) => {
    const pts = Array.from({ length: 101 }, (_, k) => k / 100).map((r) => [
      X(r),
      Y(Emin + r ** p * (1 - Emin)),
    ]);
    parts.push(
      polyline(
        pts,
        "",
        `style="fill:none;stroke:${colours[i]};stroke-width:${p === 3 ? 3 : 2}"`,
      ),
    );
    const [r, dx, dy] = [
      [0.5, -34, -8],
      [0.7, -44, -6],
      [0.8, 8, 16],
      [0.9, 8, 18],
    ][i];
    parts.push(
      text(
        [X(r) + dx, Y(r ** p) + dy],
        `p = ${p}`,
        "small bold halo",
        "start",
        `style="fill:${colours[i]}"`,
      ),
    );
  });
  parts.push(
    dot([X(0.5), Y(0.125)], 4.5, "node-accent"),
    line([X(0.5), Y(0.125)], [X(0.3), Y(0.62)], "thin"),
    text(
      [X(0.3) - 4, Y(0.62) - 8],
      "ρ = 0.5 gives 12.5% of the",
      "small",
      "middle",
    ),
    text([X(0.3) - 4, Y(0.62) + 8], "stiffness at p = 3", "small", "middle"),
  );
  return parts.join("\n");
}

// ── Density filter ───────────────────────────────────────────────────────────

function densityFilter() {
  const parts = [];
  const cell = 26;
  const nx = 13;
  const ny = 9;
  const ox = 30;
  const oy = 20;
  const ce = [6, 4];
  const rmin = 3.2;
  for (let i = 0; i < nx; i++)
    for (let j = 0; j < ny; j++) {
      const d = Math.hypot(i - ce[0], j - ce[1]);
      const w = Math.max(0, rmin - d) / rmin;
      parts.push(
        `<rect x="${ox + i * cell}" y="${oy + j * cell}" width="${cell}" height="${cell}" style="fill:${w > 0 ? palette.accent : "#ffffff"};fill-opacity:${n(w * 0.85)};stroke:#b8c2cc;stroke-width:0.8"/>`,
      );
    }
  const centre = [ox + (ce[0] + 0.5) * cell, oy + (ce[1] + 0.5) * cell];
  parts.push(
    circle(centre, rmin * cell, "accent"),
    `<circle cx="${centre[0]}" cy="${centre[1]}" r="${rmin * cell}" style="fill:none;stroke:${palette.accent};stroke-width:2"/>`,
    dot(centre, 4.5, "node-accent"),
    arrow(
      centre,
      [centre[0] + rmin * cell * 0.707, centre[1] - rmin * cell * 0.707],
      "ink",
    ),
    text([centre[0] + 34, centre[1] - 42], ["r", "min"], "sym halo", "start"),
    text([centre[0] - 10, centre[1] + 20], "e", "sym bold", "middle"),
    text(
      [ox + (nx * cell) / 2, oy + ny * cell + 26],
      "shading: filter weight, falling linearly to zero at the radius",
      "small lbl",
    ),
  );
  return parts.join("\n");
}

// ── MBB half-beam layout from the recorded benchmark ─────────────────────────

const optimization = JSON.parse(
  readFileSync(
    new URL("../../public/theory/optimization.json", import.meta.url),
    "utf8",
  ),
);

function mbbLayout() {
  // Each row carries a two-space indent from the benchmark's text output.
  const rows = optimization.mbb.layout.split("\n").map((row) => row.slice(2));
  const { nx, ny } = optimization.mbb.meshDims;
  if (rows.length !== ny || rows.some((r) => r.length !== nx))
    throw new Error(
      `MBB layout is ${rows.length} rows; expected ${ny} rows of ${nx}`,
    );
  const cell = 16;
  const ox = 60;
  const oy = 50;
  const parts = [];
  rows.forEach((row, j) => {
    for (let i = 0; i < nx; i++) {
      const ch = row[i] ?? " ";
      const fill =
        ch === "#" ? palette.ink : ch === ":" ? "#9aa5b1" : "#ffffff";
      parts.push(
        `<rect x="${ox + i * cell}" y="${oy + j * cell}" width="${cell}" height="${cell}" style="fill:${fill}"/>`,
      );
    }
  });
  const w = nx * cell;
  const h = ny * cell;
  parts.push(
    `<rect x="${ox}" y="${oy}" width="${w}" height="${h}" style="fill:none;stroke:${palette.muted};stroke-width:1"/>`,
  );
  // Symmetry plane on the left (rollers), load at top left, roller at bottom right.
  for (let j = 1; j < ny; j += 3) {
    const y = oy + j * cell;
    parts.push(circle([ox - 7, y], 5, "node-open"));
  }
  parts.push(
    line([ox - 14, oy], [ox - 14, oy + h], "ground"),
    `<rect x="${ox - 24}" y="${oy}" width="10" height="${h}" class="hatch-fill"/>`,
    arrow([ox + 4, oy - 44], [ox + 4, oy - 4], "load"),
    text([ox + 14, oy - 26], "F", "sym load-text", "start"),
    rollerSupport([ox + w - 2, oy + h], 14),
    text([ox - 30, oy + h + 36], "symmetry plane", "small lbl", "start"),
  );
  // Legend.
  const ly = oy + h + 60;
  for (const [k, [fill, label]] of [
    [palette.ink, "ρ > 0.5"],
    ["#9aa5b1", "0.25–0.5"],
    ["#ffffff", "< 0.25"],
  ].entries()) {
    const x = ox + 150 + k * 120;
    parts.push(
      `<rect x="${x}" y="${ly - 11}" width="14" height="14" style="fill:${fill};stroke:${palette.muted};stroke-width:0.8"/>`,
      text([x + 20, ly], label, "small", "start"),
    );
  }
  return parts.join("\n");
}

// ── Verification and validation ──────────────────────────────────────────────

function verificationValidation() {
  const parts = [];
  const box = (x, y, w, title, sub) => {
    parts.push(
      `<rect x="${x}" y="${y}" width="${w}" height="64" rx="8" style="fill:#eef4fa;stroke:${palette.ink};stroke-width:1.4"/>`,
      text([x + w / 2, y + 28], title, "title"),
      text([x + w / 2, y + 48], sub, "small lbl"),
    );
  };
  box(20, 40, 190, "Physical system", "the part, as it really is");
  box(270, 40, 190, "Mathematical model", "elasticity, loads, supports");
  box(520, 40, 190, "Discrete FE model", "mesh, elements, K d = f");
  box(520, 190, 190, "Numerical solution", "displacement, stress");
  parts.push(
    arrow([210, 72], [268, 72]),
    text([239, 62], "idealise", "small lbl"),
    arrow([460, 72], [518, 72]),
    text([489, 62], "discretise", "small lbl"),
    arrow([615, 104], [615, 188]),
    text([623, 150], "solve", "small lbl", "start"),
  );
  // Verification: model ↔ solution.
  parts.push(
    path(
      "M365 104C365 200 430 222 518 222",
      "accent",
      'marker-start="url(#a-accent)" marker-end="url(#a-accent)"',
    ),
    text([390, 196], "Verification", "title accent-text", "end"),
    text([390, 214], "are the equations", "small lbl", "end"),
    text([390, 228], "solved correctly?", "small lbl", "end"),
  );
  // Validation: reality ↔ solution.
  parts.push(
    path(
      "M115 104C115 280 300 300 600 256",
      "accent2",
      'marker-start="url(#a-accent2)" marker-end="url(#a-accent2)"',
    ),
    text([150, 270], "Validation", "title accent2-text", "start"),
    text([150, 288], "are they the right equations?", "small lbl", "start"),
  );
  return parts.join("\n");
}

export default [
  {
    id: "axial-bar",
    title: "A bar in axial tension",
    alt: "A straight bar of length L, Young's modulus E and cross-sectional area A, clamped at its left end and pulled to the right by a force P. Its free end moves by the extension delta.",
    width: 620,
    height: 200,
    body: axialBar(),
  },
  {
    id: "stress-averaging",
    title: "Averaging element stress samples at a shared node",
    alt: "Left: four elements around a node with constant element stresses of 100, 150, 150 and 150 MPa. Right: the nodal average of 137.5 MPa at the shared node and the smooth contour interpolated from the averaged nodal values.",
    width: 620,
    height: 250,
    body: stressAveraging(),
  },
  {
    id: "plate-hole-concentration",
    title: "Stress concentration at a circular hole",
    alt: "Left: a plate with a circular hole of radius a under remote tension sigma infinity. Right: the stress along the line above the hole falls from three times the remote stress at the hole edge towards the remote value further away.",
    width: 700,
    height: 350,
    body: kirsch(),
  },
  {
    id: "convergence-rates",
    title: "Typical discretisation error against element size",
    alt: "Log–log plot of relative error against element size. Straight lines of slope 1, 2 and 3 show the expected rates for stress and displacement at element orders 1 and 2. A dashed red line shows a peak stress at a re-entrant corner growing as the elements get smaller.",
    width: 600,
    height: 430,
    body: convergenceRates(),
  },
  {
    id: "shell-kinematics",
    title: "A shell facet: mid-surface, local axes and six DOFs per node",
    alt: "A thin plate of thickness t with a triangular facet on its mid-surface. Local axes e1, e2 and e3 start at the first node, e3 normal to the facet. At another node, red arrows show the three translations and orange double arrows the three rotations.",
    width: 640,
    height: 330,
    body: shellKinematics(),
  },
  {
    id: "membrane-bending",
    title: "Membrane and bending stress through a shell's thickness",
    alt: "Three through-thickness stress profiles: a uniform membrane stress, a bending stress varying linearly from tension at one surface to compression at the other, and their sum, largest at one surface.",
    width: 680,
    height: 250,
    body: membraneBending(),
  },
  {
    id: "solid-shell-transition",
    title: "A shell wall joined to a solid through a retained solid section",
    alt: "A wall rising from a solid block. Its lowest three thicknesses stay solid; above them the wall is a shell mid-surface line with nodes. At the cut, red links tie the solid section nodes S to the shell edge node A, so they follow its translation and rotation.",
    width: 600,
    height: 340,
    body: solidShellTransition(),
  },
  {
    id: "simp-interpolation",
    title: "SIMP stiffness interpolation for different penalties",
    alt: "Relative Young's modulus against element density for penalties p equal to 1, 2, 3 and 4. Higher penalties make intermediate densities much less stiff; at p equal to 3, a density of 0.5 gives 12.5 percent of the full stiffness.",
    width: 560,
    height: 360,
    body: simpCurves(),
  },
  {
    id: "density-filter",
    title: "A density filter's weights around one element",
    alt: "A grid of elements with a circle of radius r min around element e. Elements inside the circle are shaded blue, darkest at the centre, showing filter weights that fall linearly with distance to zero at the radius.",
    width: 400,
    height: 290,
    body: densityFilter(),
  },
  {
    id: "mbb-half-beam-layout",
    title: "Optimized MBB half-beam layout",
    alt: "The optimized density of the MBB half-beam on a 36 by 12 element grid. Dark elements form a top chord, a bottom tie and diagonal members; the symmetry plane is on the left, the load on the top left and a roller at the bottom right.",
    width: 660,
    height: 330,
    body: mbbLayout(),
  },
  {
    id: "verification-validation",
    title: "Verification and validation",
    alt: "A chain from the physical system to a mathematical model, a discrete finite element model and its numerical solution. Verification compares the numerical solution with the mathematical model; validation compares it with the physical system.",
    width: 730,
    height: 310,
    body: verificationValidation(),
  },
];

void sampleCurve;
