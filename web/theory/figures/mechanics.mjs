// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Figures for the operator and solid-mechanics articles: the reference-element
// map, gradients and fluxes, a body with its boundary conditions, and the
// stress components on a cube.

import {
  arrow,
  axes2d,
  circle,
  clampLeft,
  dot,
  line,
  n,
  path,
  pointsPath,
  polygon,
  smoothClosed,
  text,
  textSup,
} from "./svg.mjs";
import { sampleCurve } from "./mesh2d.mjs";

// ── Reference element → physical element ─────────────────────────────────────

function referenceMapping() {
  const parts = [];
  // Reference square, ξ, η ∈ [−1, 1].
  const c = [150, 175];
  const s = 95;
  const R = ([xi, eta]) => [c[0] + s * xi, c[1] - s * eta];
  parts.push(
    polygon(
      [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ].map(R),
      "body",
      'style="fill:#c9d6f2"',
    ),
  );
  for (const v of [-0.5, 0.5]) {
    parts.push(
      line(R([v, -1]), R([v, 1]), "dash"),
      line(R([-1, v]), R([1, v]), "dash"),
    );
  }
  parts.push(
    arrow([c[0] - s - 30, c[1]], [c[0] + s + 38, c[1]]),
    arrow([c[0], c[1] + s + 30], [c[0], c[1] - s - 34]),
    text([c[0] + s + 44, c[1] + 5], "ξ", "sym", "start"),
    text([c[0] + 6, c[1] - s - 38], "η", "sym", "start"),
    text([c[0] + s + 4, c[1] + 18], "1", "", "start"),
    text([c[0] - s - 4, c[1] + 18], "−1", "", "end"),
    text([c[0] - 8, c[1] - s - 6], "1", "", "end"),
    text([c[0] - 8, c[1] + s + 18], "−1", "", "end"),
    textSup([c[0] - s / 2, c[1] + s / 2 + 6], "Ω", "r", "sym"),
    textSup([c[0] - s / 2 - 8, c[1] - s - 8], "Γ", "r", "sym"),
  );
  for (const p of [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ])
    parts.push(dot(R(p), 4.5));

  // Physical quadrilateral: bilinear map of the same square.
  const X = { 1: [600, 300], 2: [735, 228], 3: [738, 98], 4: [508, 140] };
  const F = ([xi, eta]) => {
    const N = [
      ((1 - xi) * (1 - eta)) / 4,
      ((1 + xi) * (1 - eta)) / 4,
      ((1 + xi) * (1 + eta)) / 4,
      ((1 - xi) * (1 + eta)) / 4,
    ];
    return [0, 1].map((k) => N.reduce((sum, w, a) => sum + w * X[a + 1][k], 0));
  };
  parts.push(polygon([X[1], X[2], X[3], X[4]], "body"));
  for (const v of [-0.5, 0, 0.5]) {
    const along = (f) => sampleCurve((t) => f(-1 + 2 * t), 20).concat([f(1)]);
    parts.push(
      path(
        pointsPath(
          along((t) => F([v, t])),
          false,
        ),
        "dash",
      ),
      path(
        pointsPath(
          along((t) => F([t, v])),
          false,
        ),
        "dash",
      ),
    );
  }
  for (const [id, p] of Object.entries(X)) parts.push(dot(p, 4.5));
  parts.push(
    text([X[1][0] + 2, X[1][1] + 22], "1", "bold"),
    text([X[2][0] + 14, X[2][1] + 6], "2", "bold", "start"),
    text([X[3][0] + 10, X[3][1] - 6], "3", "bold", "start"),
    text([X[4][0] - 12, X[4][1] + 4], "4", "bold", "end"),
    text(F([-0.5, -0.55]), ["Ω", "e"], "sym"),
    text([628, 104], ["Γ", "e"], "sym"),
    axes2d([500, 300], 38),
  );
  // ξ and η directions after mapping: the Jacobian columns at the centre.
  const o = F([0, 0]);
  const dxi = F([0.45, 0]);
  const deta = F([0, 0.45]);
  parts.push(
    arrow(o, dxi, "accent"),
    arrow(o, deta, "accent2"),
    text(
      [dxi[0] + 6, dxi[1] + 16],
      "∂x/∂ξ",
      "sym accent-text",
      "start",
      'font-size="14"',
    ),
    text(
      [deta[0] - 4, deta[1] - 8],
      "∂x/∂η",
      "sym accent2-text",
      "end",
      'font-size="14"',
    ),
  );
  // The map itself.
  parts.push(
    path("M222 70C300 6 430 14 520 92", "load", 'marker-end="url(#a-load)"'),
    text([370, 30], "x = F(ξ)", "sym load-text", "middle", 'font-size="18"'),
  );
  return parts.join("\n");
}

// ── Gradient of a scalar field ───────────────────────────────────────────────

function scalarGradient() {
  const parts = [];
  const c = [260, 170];
  // φ = (x/a)² + (y/b)²: elliptical level sets, gradient normal to them.
  const a = 1.6;
  const b = 1;
  for (const level of [0.6, 1.2, 1.8, 2.4]) {
    const r = Math.sqrt(level);
    const ellipse = sampleCurve(
      (t) => [
        c[0] + 70 * a * r * Math.cos(2 * Math.PI * t),
        c[1] + 70 * b * r * Math.sin(2 * Math.PI * t),
      ],
      120,
    );
    parts.push(path(smoothClosed(ellipse), "thin", 'style="stroke:#7a8794"'));
  }
  for (const level of [0.6, 1.2, 1.8, 2.4])
    parts.push(
      text(
        [c[0] - 40, c[1] + 70 * b * Math.sqrt(level) + 4],
        `φ = ${level.toFixed(1)}`,
        "lbl small halo",
      ),
    );
  const r = Math.sqrt(1.2);
  for (const t of [0.05, 0.2, 0.33, 0.45, 0.6, 0.72, 0.88]) {
    const th = 2 * Math.PI * t;
    const p = [
      c[0] + 70 * a * r * Math.cos(th),
      c[1] + 70 * b * r * Math.sin(th),
    ];
    // ∇φ ∝ (x/a², y/b²) in model coordinates.
    const g = [Math.cos(th) / a, Math.sin(th) / b];
    const len = Math.hypot(...g);
    parts.push(
      dot(p, 3.2),
      arrow(p, [p[0] + (46 * g[0]) / len, p[1] + (46 * g[1]) / len], "accent"),
    );
  }
  parts.push(
    text(
      [c[0] + 70 * a * r * Math.cos(0.33 * 2 * Math.PI) - 30, 40],
      "∇φ",
      "sym accent-text",
      "middle",
      'font-size="19"',
    ),
    axes2d([40, 320], 34),
  );
  return parts.join("\n");
}

// ── Divergence theorem ───────────────────────────────────────────────────────

const fluxBody = sampleCurve((t) => {
  const a = 2 * Math.PI * t;
  const r = 1 + 0.12 * Math.cos(2 * a) + 0.08 * Math.sin(3 * a);
  return [250 + 150 * r * Math.cos(a), 175 - 110 * r * Math.sin(a)];
}, 240);

function divergence() {
  const parts = [path(smoothClosed(fluxBody), "body")];
  // A vector field q = (q0 + k x, k' y): it spreads out, so div q > 0.
  const q = ([x, y]) => [0.55 + (x - 250) / 260, -(y - 175) / 300];
  for (let x = 40; x <= 470; x += 44)
    for (let y = 40; y <= 320; y += 40) {
      const v = q([x, y]);
      const tip = [x + 34 * v[0], y + 34 * v[1]];
      parts.push(
        line(
          [x, y],
          tip,
          "thin",
          'style="stroke:#8795a3" marker-end="url(#a-muted)"',
        ),
      );
    }
  // Outward normals and the field at boundary points.
  for (const k of [0, 30, 70, 110, 150, 190, 215]) {
    const p = fluxBody[k];
    const prev = fluxBody[(k - 1 + fluxBody.length) % fluxBody.length];
    const next = fluxBody[(k + 1) % fluxBody.length];
    const tangent = [next[0] - prev[0], next[1] - prev[1]];
    const len = Math.hypot(...tangent);
    const normal = [tangent[1] / len, -tangent[0] / len];
    // Outward: away from the body's centre.
    if (normal[0] * (p[0] - 250) + normal[1] * (p[1] - 175) < 0) {
      normal[0] *= -1;
      normal[1] *= -1;
    }
    parts.push(
      dot(p, 3),
      arrow(p, [p[0] + 40 * normal[0], p[1] + 40 * normal[1]], "accent"),
    );
  }
  parts.push(
    text([250, 182], "Ω", "sym", "middle", 'font-size="22"'),
    text([110, 82], "Γ = ∂Ω", "sym", "end"),
    text([428, 116], "n", "sym accent-text bold", "start"),
    text([440, 300], "q", "sym bold", "start", 'style="fill:#5f6b7a"'),
  );
  return parts.join("\n");
}

// ── A body with its boundary conditions ──────────────────────────────────────

function boundaryValueProblem() {
  const body = sampleCurve((t) => {
    const a = 2 * Math.PI * t;
    const r = 1 + 0.1 * Math.cos(2 * a) + 0.06 * Math.sin(3 * a);
    return [330 + 210 * r * Math.cos(a), 185 - 120 * r * Math.sin(a)];
  }, 360);
  // Clamp the left part of the boundary: replace it with a straight wall.
  const xWall = 150;
  const clipped = body.map(([x, y]) => [Math.max(x, xWall), y]);
  const wallPts = clipped.filter(([x]) => x === xWall);
  const y0 = Math.min(...wallPts.map(([, y]) => y));
  const y1 = Math.max(...wallPts.map(([, y]) => y));
  const parts = [
    path(pointsPath(clipped), "body"),
    clampLeft(xWall, y0 - 12, y1 + 12, 16),
  ];

  // Traction on the right-hand part of the boundary.
  const tractionIdx = [];
  for (let k = 0; k < body.length; k++) {
    const angle = (360 * k) / body.length;
    if ((angle > 330 || angle < 45) && k % 14 === 0) tractionIdx.push(k);
  }
  for (const k of tractionIdx) {
    const p = body[k];
    parts.push(arrow([p[0] + 6, p[1]], [p[0] + 58, p[1] - 14], "load"));
  }
  // Highlight Γ_N.
  const gammaN = body.filter((_, k) => {
    const angle = (360 * k) / body.length;
    return angle > 325 || angle < 50;
  });
  const start = body.findIndex((_, k) => (360 * k) / body.length > 325);
  const ordered = [
    ...body.slice(start),
    ...body.slice(
      0,
      body.findIndex((_, k) => (360 * k) / body.length >= 50),
    ),
  ];
  parts.push(
    path(pointsPath(ordered, false), "load", 'style="stroke-width:3.5"'),
  );
  void gammaN;

  // Body force arrows inside.
  for (const [x, y] of [
    [290, 140],
    [380, 150],
    [330, 215],
    [420, 220],
    [250, 225],
  ])
    parts.push(arrow([x, y], [x, y + 30], "accent2"));
  // Outward normal at the top.
  const top = body[Math.round(body.length * 0.27)];
  parts.push(dot(top, 3), arrow(top, [top[0] + 10, top[1] - 46], "accent"));

  parts.push(
    text([330, 190], "Ω", "sym", "middle", 'font-size="24"'),
    text([xWall - 26, y0 - 22], ["Γ", "D"], "sym", "middle"),
    text([xWall - 26, y1 + 34], "u = ū", "sym", "middle", 'font-size="15"'),
    text([600, 82], ["Γ", "N"], "sym load-text", "start"),
    text([602, 300], "σn = t", "sym load-text", "start", 'font-size="15"'),
    text([614, 196], "t", "sym load-text", "start", 'font-size="19"'),
    text([258, 280], "b", "sym accent2-text", "middle", 'font-size="19"'),
    text(
      [top[0] + 18, top[1] - 40],
      "n",
      "sym accent-text",
      "start",
      'font-size="19"',
    ),
  );
  return parts.join("\n");
}

// ── Stress components on a cube ──────────────────────────────────────────────

function stressCube() {
  const o = [250, 250];
  const L = 150;
  // Oblique projection: x to the lower left, y to the right, z up.
  const P = ([x, y, z]) => [
    o[0] + L * (y - 0.55 * x),
    o[1] + L * (0.32 * x - z),
  ];
  const parts = [];
  const face = (pts, cls, style) =>
    polygon(pts.map(P), cls, style ? `style="${style}"` : "");
  parts.push(
    face(
      [
        [1, 0, 0],
        [1, 1, 0],
        [1, 1, 1],
        [1, 0, 1],
      ],
      "body",
    ),
    face(
      [
        [0, 1, 0],
        [1, 1, 0],
        [1, 1, 1],
        [0, 1, 1],
      ],
      "side",
    ),
    face(
      [
        [0, 0, 1],
        [1, 0, 1],
        [1, 1, 1],
        [0, 1, 1],
      ],
      "body-alt",
    ),
  );
  const vec = (from, d, colour, len = 0.42) => {
    const a = P(from);
    const b = P([
      from[0] + len * d[0],
      from[1] + len * d[1],
      from[2] + len * d[2],
    ]);
    return arrow(a, b, colour);
  };
  // +x face (centre (1, .5, .5)): normal along x, shear along y and z.
  const cx = [1, 0.5, 0.5];
  const cy = [0.5, 1, 0.5];
  const cz = [0.5, 0.5, 1];
  parts.push(
    vec(cx, [1, 0, 0], "load", 0.62),
    vec(cx, [0, 1, 0], "accent", 0.36),
    vec(cx, [0, 0, 1], "accent", 0.36),
    vec(cy, [0, 1, 0], "load", 0.55),
    vec(cy, [1, 0, 0], "accent", 0.36),
    vec(cy, [0, 0, 1], "accent", 0.36),
    vec(cz, [0, 0, 1], "load", 0.55),
    vec(cz, [1, 0, 0], "accent", 0.36),
    vec(cz, [0, 1, 0], "accent", 0.36),
  );
  const at = (p, d) => {
    const q = P(p);
    return [q[0] + d[0], q[1] + d[1]];
  };
  parts.push(
    text(at([1.62, 0.5, 0.5], [-8, 18]), ["σ", "xx"], "sym load-text"),
    text(at([1, 0.86, 0.5], [-4, -8]), ["τ", "xy"], "sym accent-text", "end"),
    text(at([1, 0.5, 0.86], [-14, 4]), ["τ", "xz"], "sym accent-text", "end"),
    text(at([0.5, 1.55, 0.5], [6, 6]), ["σ", "yy"], "sym load-text", "start"),
    text(at([0.86, 1, 0.5], [2, 24]), ["τ", "yx"], "sym accent-text", "start"),
    text(at([0.5, 1, 0.86], [8, 0]), ["τ", "yz"], "sym accent-text", "start"),
    text(at([0.5, 0.5, 1.55], [8, -2]), ["σ", "zz"], "sym load-text", "start"),
    text(at([0.86, 0.5, 1], [-8, -4]), ["τ", "zx"], "sym accent-text", "end"),
    text(at([0.5, 0.86, 1], [6, -8]), ["τ", "zy"], "sym accent-text", "start"),
  );
  // Axes triad.
  const t0 = [70, 330];
  const T = ([x, y, z]) => [
    t0[0] + 46 * (y - 0.55 * x),
    t0[1] + 46 * (0.32 * x - z),
  ];
  parts.push(
    arrow(t0, T([1, 0, 0])),
    arrow(t0, T([0, 1, 0])),
    arrow(t0, T([0, 0, 1])),
    text([T([1, 0, 0])[0] - 8, T([1, 0, 0])[1] + 14], "x", "sym"),
    text([T([0, 1, 0])[0] + 8, T([0, 1, 0])[1] + 5], "y", "sym", "start"),
    text([T([0, 0, 1])[0], T([0, 0, 1])[1] - 8], "z", "sym"),
  );
  void circle;
  void n;
  return parts.join("\n");
}

export default [
  {
    id: "reference-mapping",
    title: "Mapping a reference element to a physical element",
    alt: "Left: the reference square with coordinates xi and eta from minus one to one. Right: a four-node physical quadrilateral. A curved arrow labelled x equals F of xi maps one to the other; dashed grid lines of constant xi and eta become curved lines, and two arrows show the mapped xi and eta directions.",
    width: 800,
    height: 340,
    body: referenceMapping(),
  },
  {
    id: "scalar-gradient",
    title: "The gradient of a scalar field",
    alt: "Elliptical contour lines of a scalar field phi. Blue arrows at points on one contour show the gradient, perpendicular to the contour and pointing outwards towards larger phi.",
    width: 520,
    height: 345,
    body: scalarGradient(),
  },
  {
    id: "divergence-theorem",
    title: "The divergence theorem: flux through the boundary",
    alt: "A body Omega with boundary Gamma in a grey vector field q. Blue arrows show the outward unit normal n at points on the boundary; the net outflow of q through Gamma equals the integral of the divergence of q over Omega.",
    width: 520,
    height: 350,
    body: divergence(),
  },
  {
    id: "boundary-value-problem",
    title: "A body with prescribed displacement, traction and body force",
    alt: "A body Omega clamped on its left boundary Gamma D, where the displacement equals a prescribed value. Red traction arrows t act on the right boundary Gamma N. Orange arrows inside show the body force b, and a blue arrow shows the outward normal n.",
    width: 700,
    height: 340,
    body: boundaryValueProblem(),
  },
  {
    id: "stress-cube",
    title: "Stress components on a small cube",
    alt: "A small cube aligned with the x, y and z axes. On each visible face a red arrow shows the normal stress, sigma xx, sigma yy or sigma zz, and two blue arrows show the shear stresses tau acting in the face.",
    width: 520,
    height: 400,
    body: stressCube(),
  },
];
