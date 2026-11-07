// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Figures for the numerical-methods articles: shape functions, quadrature
// points, element node layouts, assembly, sparsity, supports, consistent
// nodal loads and the convergence of conjugate gradients.

import {
  arrow,
  circle,
  clampLeft,
  dot,
  doubleArrow,
  line,
  n,
  palette,
  path,
  pinSupport,
  pointsPath,
  polygon,
  polyline,
  rollerSupport,
  scale,
  smoothClosed,
  text,
  textSup,
} from "./svg.mjs";
import { edges, meshDomain, resampleClosed, sampleCurve } from "./mesh2d.mjs";

// ── 1D Lagrange shape functions ──────────────────────────────────────────────

const lagrange = (nodes, a) => (x) =>
  nodes.reduce(
    (p, xb, b) => (b === a ? p : (p * (x - xb)) / (nodes[a] - xb)),
    1,
  );

function shapePanel(x0, nodes, title) {
  const width = 330;
  const X = scale([0, 1], [x0 + 20, x0 + 20 + width]);
  const Y = scale([-0.35, 1.15], [250, 40]);
  const colours = [
    palette.load,
    palette.accent3,
    palette.accent,
    palette.accent2,
  ];
  const parts = [
    arrow([x0, Y(0)], [x0 + width + 50, Y(0)]),
    arrow([x0 + 6, 270], [x0 + 6, 22]),
    text([x0 + width + 54, Y(0) + 5], "ξ", "sym", "start"),
    text([x0 - 6, 30], "N", "sym", "end"),
    text([x0 - 2, Y(1) + 5], "1", "small", "end"),
    line([x0 + 2, Y(1)], [x0 + 10, Y(1)], "thin"),
  ];
  nodes.forEach((xn, a) => {
    parts.push(line([X(xn), Y(-0.33)], [X(xn), Y(1.12)], "dash"));
    const f = lagrange(nodes, a);
    const pts = Array.from({ length: 161 }, (_, i) => [
      X(i / 160),
      Y(f(i / 160)),
    ]);
    parts.push(
      polyline(
        pts,
        "",
        `style="fill:none;stroke:${colours[a]};stroke-width:2.4"`,
      ),
    );
    parts.push(
      dot([X(xn), Y(0)], 4),
      text([X(xn), Y(0) + 34], ["x", String(a + 1)], "sym"),
    );
  });
  parts.push(text([x0 + 20 + width / 2, 300], title, "title", "middle"));
  return parts.join("\n");
}

// ── Quadrature points ────────────────────────────────────────────────────────

function quadraturePoints() {
  const parts = [];
  const tri = (ox, oy, s, pts, label) => {
    const P = ([xi, eta]) => [ox + s * xi, oy - s * eta];
    parts.push(
      polygon(
        [
          [0, 0],
          [1, 0],
          [0, 1],
        ].map(P),
        "body",
      ),
    );
    for (const p of pts) parts.push(circle(P(p), 5, "gauss"));
    parts.push(text([ox + s / 2, oy + 30], label, "small lbl"));
  };
  const quad = (ox, oy, s, m, label) => {
    const P = ([xi, eta]) => [
      ox + (s * (xi + 1)) / 2,
      oy - (s * (eta + 1)) / 2,
    ];
    parts.push(
      polygon(
        [
          [-1, -1],
          [1, -1],
          [1, 1],
          [-1, 1],
        ].map(P),
        "body",
      ),
    );
    const g =
      m === 2
        ? [-1 / Math.sqrt(3), 1 / Math.sqrt(3)]
        : [-Math.sqrt(3 / 5), 0, Math.sqrt(3 / 5)];
    for (const a of g)
      for (const b of g) parts.push(circle(P([a, b]), 5, "gauss"));
    parts.push(text([ox + s / 2, oy + 30], label, "small lbl"));
  };
  tri(30, 170, 130, [[1 / 3, 1 / 3]], "1 point: exact for linear");
  tri(
    220,
    170,
    130,
    [
      [1 / 6, 1 / 6],
      [2 / 3, 1 / 6],
      [1 / 6, 2 / 3],
    ],
    "3 points: exact for quadratic",
  );
  quad(410, 170, 130, 2, "2 × 2 Gauss: exact to cubic");
  quad(600, 170, 130, 3, "3 × 3 Gauss: exact to quintic");
  return parts.join("\n");
}

// ── Element node layouts ─────────────────────────────────────────────────────

function elementLayouts() {
  const parts = [];
  // Oblique projection with z up.
  const proj =
    (ox, oy, s) =>
    ([x, y, z]) => [ox + s * (x + 0.45 * y), oy - s * (z + 0.32 * y)];
  const drawSolid = (P, verts, edgeList, hiddenEdges, nodes, label, labelX) => {
    for (const [a, b] of hiddenEdges)
      parts.push(line(P(verts[a]), P(verts[b]), "dash"));
    for (const [a, b] of edgeList)
      parts.push(
        line(P(verts[a]), P(verts[b]), "ink", 'style="stroke-width:1.8"'),
      );
    for (const { p, hidden } of nodes)
      parts.push(hidden ? circle(P(p), 3.8, "node-open") : dot(P(p), 4.2));
    parts.push(text([labelX, 258], label, "lbl"));
  };
  const tetV = [
    [0, 0, 0],
    [1, 0, 0],
    [0.25, 1, 0],
    [0.35, 0.35, 1],
  ];
  const tetE = [
    [0, 1],
    [1, 2],
    [0, 3],
    [1, 3],
    [2, 3],
  ];
  const tetH = [[0, 2]];
  const midT = (a, b) => tetV[a].map((v, k) => (v + tetV[b][k]) / 2);
  const tet = (ox, quadratic, label) => {
    const P = proj(ox, 200, 120);
    const nodes = tetV.map((p) => ({ p, hidden: false }));
    if (quadratic)
      for (const [a, b] of [
        [0, 1],
        [1, 2],
        [0, 2],
        [0, 3],
        [1, 3],
        [2, 3],
      ])
        nodes.push({ p: midT(a, b), hidden: a === 0 && b === 2 });
    drawSolid(P, tetV, tetE, tetH, nodes, label, ox + 85);
  };
  const hexV = [];
  for (const z of [0, 1])
    for (const y of [0, 1]) for (const x of [0, 1]) hexV.push([x, y, z]);
  const hexEdges = [];
  for (let a = 0; a < 8; a++)
    for (let b = a + 1; b < 8; b++) {
      const d = hexV[a].reduce((s, v, k) => s + Math.abs(v - hexV[b][k]), 0);
      if (d === 1) hexEdges.push([a, b]);
    }
  // Visible faces in this projection: y = 0 (front), x = 1 (right), z = 1 (top).
  const isHidden = ([x, y, z]) => y !== 0 && x !== 1 && z !== 1;
  const hex = (ox, quadratic, label) => {
    const P = proj(ox, 200, 105);
    const vis = hexEdges.filter(([a, b]) => a !== 2 && b !== 2);
    const hid = hexEdges.filter(([a, b]) => a === 2 || b === 2);
    const nodes = [];
    if (quadratic) {
      for (const x of [0, 0.5, 1])
        for (const y of [0, 0.5, 1])
          for (const z of [0, 0.5, 1])
            nodes.push({ p: [x, y, z], hidden: isHidden([x, y, z]) });
    } else hexV.forEach((p) => nodes.push({ p, hidden: isHidden(p) }));
    drawSolid(P, hexV, vis, hid, nodes, label, ox + 75);
  };
  tet(20, false, "Linear tetrahedron: 4 nodes");
  tet(230, true, "Quadratic tetrahedron: 10 nodes");
  hex(450, false, "Trilinear hexahedron: 8 nodes");
  hex(660, true, "Quadratic hexahedron: 27 nodes");
  return parts.join("\n");
}

// ── Assembly of two bar elements ─────────────────────────────────────────────

function assemblyBars() {
  const parts = [];
  const y = 70;
  const xs = [60, 210, 360];
  parts.push(clampLeft(xs[0] - 4, y - 26, y + 26, 14));
  parts.push(
    `<rect x="${xs[0]}" y="${y - 12}" width="${xs[1] - xs[0]}" height="24" style="fill:#d8e5fb;stroke:${palette.accent};stroke-width:1.6"/>`,
    `<rect x="${xs[1]}" y="${y - 12}" width="${xs[2] - xs[1]}" height="24" style="fill:#f8dfd2;stroke:${palette.accent2};stroke-width:1.6"/>`,
    text(
      [(xs[0] + xs[1]) / 2, y + 5],
      "element 1",
      "small",
      "middle",
      `style="fill:${palette.accent}"`,
    ),
    text(
      [(xs[1] + xs[2]) / 2, y + 5],
      "element 2",
      "small",
      "middle",
      `style="fill:${palette.accent2}"`,
    ),
    arrow([xs[2], y], [xs[2] + 60, y], "load"),
    text([xs[2] + 66, y + 6], "P", "sym load-text", "start"),
  );
  xs.forEach((x, i) =>
    parts.push(
      dot([x, y], 5.5),
      text([x + (i === 0 ? 26 : 0), y - 22], `node ${i + 1}`, "small bold"),
    ),
  );
  // Element matrices and the global matrix.
  const cell = 44;
  const matrix = (ox, oy, size, fill, labels) => {
    const out = [];
    for (let r = 0; r < size; r++)
      for (let c = 0; c < size; c++) {
        const f = fill(r, c);
        out.push(
          `<rect x="${ox + c * cell}" y="${oy + r * cell}" width="${cell}" height="${cell}" style="fill:${f ?? "#ffffff"};stroke:#9aa5b1;stroke-width:0.8"/>`,
        );
        const label = labels(r, c);
        if (label)
          out.push(
            text(
              [ox + c * cell + cell / 2, oy + r * cell + cell / 2 + 5],
              label,
              "sym",
              "middle",
              'font-size="15"',
            ),
          );
      }
    out.push(
      path(
        `M${ox + 6} ${oy - 4}H${ox - 4}V${oy + size * cell + 4}H${ox + 6}`,
        "ink",
      ),
      path(
        `M${ox + size * cell - 6} ${oy - 4}H${ox + size * cell + 4}V${oy + size * cell + 4}H${ox + size * cell - 6}`,
        "ink",
      ),
    );
    return out.join("");
  };
  const blue = "#d8e5fb";
  const orange = "#f8dfd2";
  const k1 = [
    ["k₁", "−k₁"],
    ["−k₁", "k₁"],
  ];
  const k2 = [
    ["k₂", "−k₂"],
    ["−k₂", "k₂"],
  ];
  parts.push(
    textSup([95, 150], "K", "(1)", "sym bold"),
    matrix(
      50,
      165,
      2,
      () => blue,
      (r, c) => k1[r][c],
    ),
    text([95, 290], "nodes 1, 2", "small lbl"),
    textSup([235, 150], "K", "(2)", "sym bold"),
    matrix(
      190,
      165,
      2,
      () => orange,
      (r, c) => k2[r][c],
    ),
    text([235, 290], "nodes 2, 3", "small lbl"),
    arrow([310, 210], [372, 210], "muted"),
    text([341, 200], "add", "small lbl"),
  );
  const glabels = [
    ["k₁", "−k₁", ""],
    ["−k₁", "k₁+k₂", "−k₂"],
    ["", "−k₂", "k₂"],
  ];
  const gfill = (r, c) => {
    const in1 = r < 2 && c < 2;
    const in2 = r > 0 && c > 0;
    if (in1 && in2) return "url(#both)";
    if (in1) return blue;
    if (in2) return orange;
    return null;
  };
  parts.push(
    `<defs><linearGradient id="both" x1="0" y1="0" x2="1" y2="1"><stop offset="0.5" stop-color="${blue}"/><stop offset="0.5" stop-color="${orange}"/></linearGradient></defs>`,
    text([456, 126], "K", "sym bold", "middle"),
    matrix(390, 152, 3, gfill, (r, c) => glabels[r][c]),
    text([456, 305], "global, nodes 1–3", "small lbl"),
  );
  for (let i = 0; i < 3; i++)
    parts.push(
      text(
        [382, 152 + i * cell + cell / 2 + 4],
        String(i + 1),
        "small lbl",
        "end",
      ),
      text([390 + i * cell + cell / 2, 146], String(i + 1), "small lbl"),
    );
  return parts.join("\n");
}

// ── Mesh numbering and matrix sparsity ───────────────────────────────────────

const plateMesh = (() => {
  const outer = resampleClosed(
    sampleCurve((t) => {
      const a = 2 * Math.PI * t;
      const r =
        1 +
        0.13 * Math.cos(2 * a) +
        0.1 * Math.sin(3 * a) -
        0.06 * Math.cos(4 * a);
      return [160 + 140 * r * Math.cos(a), 150 - 100 * r * Math.sin(a)];
    }, 300),
    26,
  );
  const mesh = meshDomain(outer, [], 28, 11);
  // Number the nodes left to right, as a simple banded ordering.
  const order = mesh.points
    .map((p, i) => i)
    .sort((a, b) => mesh.points[a][0] - mesh.points[b][0]);
  const rank = new Map(order.map((node, i) => [node, i]));
  return {
    points: order.map((i) => mesh.points[i]),
    triangles: mesh.triangles.map((t) => t.map((i) => rank.get(i))),
  };
})();

function sparsity() {
  const { points, triangles } = plateMesh;
  const parts = [];
  const meshLines = edges(triangles)
    .map(
      ([a, b]) =>
        `M${n(points[a][0])} ${n(points[a][1])}L${n(points[b][0])} ${n(points[b][1])}`,
    )
    .join("");
  parts.push(path(meshLines, "mesh"));
  points.forEach((p, i) => parts.push(dot(p, 2.6)));
  // Highlight one node and its neighbours, and their rows in K.
  const focus = Math.round(points.length * 0.45);
  const neighbours = new Set([focus]);
  for (const t of triangles)
    if (t.includes(focus)) for (const i of t) neighbours.add(i);
  for (const i of neighbours)
    parts.push(
      dot(points[i], i === focus ? 5 : 4, i === focus ? "node-accent" : "node"),
    );
  for (const t of triangles)
    if (t.includes(focus))
      parts.push(
        polygon(
          t.map((i) => points[i]),
          "",
          `style="fill:${palette.accent2};opacity:0.18"`,
        ),
      );
  parts.push(
    text(
      [160, 285],
      `${points.length} nodes, numbered left to right`,
      "small lbl",
    ),
  );

  // Spy plot, two DOFs per node (plane elasticity).
  const N = points.length * 2;
  const ox = 380;
  const oy = 30;
  const size = 240;
  const s = size / N;
  parts.push(
    `<rect x="${ox}" y="${oy}" width="${size}" height="${size}" style="fill:#ffffff;stroke:${palette.ink};stroke-width:1"/>`,
  );
  const nz = new Set();
  for (const t of triangles)
    for (const a of t)
      for (const b of t)
        for (let i = 0; i < 2; i++)
          for (let j = 0; j < 2; j++) nz.add(`${2 * a + i},${2 * b + j}`);
  const cells = [];
  for (const key of nz) {
    const [r, c] = key.split(",").map(Number);
    cells.push(`M${n(ox + c * s)} ${n(oy + r * s)}h${n(s)}v${n(s)}h${n(-s)}z`);
  }
  parts.push(path(cells.join(""), "", `style="fill:${palette.ink}"`));
  // The focus node's two rows.
  parts.push(
    `<rect x="${ox}" y="${n(oy + 2 * focus * s)}" width="${size}" height="${n(2 * s)}" style="fill:${palette.accent2};opacity:0.35"/>`,
    text(
      [ox + size / 2, oy + size + 22],
      `K: ${N} × ${N}, ${((100 * nz.size) / (N * N)).toFixed(1)}% nonzero`,
      "small lbl",
    ),
  );
  return parts.join("\n");
}

// ── Rigid-body modes and supports ────────────────────────────────────────────

const smallBody = sampleCurve((t) => {
  const a = 2 * Math.PI * t;
  const r = 1 + 0.12 * Math.cos(2 * a) + 0.08 * Math.sin(3 * a);
  return [62 * r * Math.cos(a), -40 * r * Math.sin(a)];
}, 120);

function rigidModes() {
  const parts = [];
  const place = (pts, [dx, dy], angle = 0) =>
    pts.map(([x, y]) => [
      dx + x * Math.cos(angle) - y * Math.sin(angle),
      dy + x * Math.sin(angle) + y * Math.cos(angle),
    ]);
  const panel = (cx, cy, ghost, label, arrows) => {
    parts.push(
      path(smoothClosed(place(smallBody, ghost.offset, ghost.angle)), "dash"),
    );
    parts.push(path(smoothClosed(place(smallBody, [cx, cy])), "body"));
    parts.push(arrows);
    parts.push(text([cx, cy + 92], label, "lbl"));
  };
  panel(
    100,
    120,
    { offset: [140, 120], angle: 0 },
    "translation in x",
    arrow([100, 120], [150, 120], "accent"),
  );
  panel(
    320,
    120,
    { offset: [320, 84], angle: 0 },
    "translation in y",
    arrow([320, 120], [320, 76], "accent"),
  );
  panel(
    540,
    120,
    { offset: [540, 120], angle: -0.3 },
    "rotation",
    path("M572 86A50 50 0 0 0 512 80", "accent", 'marker-end="url(#a-accent)"'),
  );
  // Supported body: pin + roller remove all three.
  const cx = 770;
  const cy = 120;
  const outline = place(smallBody, [cx, cy]);
  parts.push(path(smoothClosed(outline), "body"));
  const lowestNear = (x) =>
    outline
      .filter((p) => Math.abs(p[0] - x) < 6)
      .reduce((best, p) => (p[1] > best[1] ? p : best));
  const left = lowestNear(cx - 34);
  const right = lowestNear(cx + 34);
  parts.push(
    pinSupport([left[0], left[1]], 13),
    rollerSupport([right[0], right[1]], 13),
  );
  parts.push(text([cx, cy + 92], "pin + roller: no rigid motion", "lbl"));
  return parts.join("\n");
}

// ── Consistent nodal loads ───────────────────────────────────────────────────

function nodalLoads() {
  const parts = [];
  const edge = (x0, values, label, nodeCount) => {
    const y = 112;
    const L = 260;
    parts.push(line([x0, y], [x0 + L, y], "ink", 'style="stroke-width:3"'));
    // Uniform traction above.
    for (let i = 0; i <= 8; i++) {
      const x = x0 + (i * L) / 8;
      parts.push(arrow([x, 40], [x, 64], "load", 'style="stroke-width:1.4"'));
    }
    parts.push(
      line([x0, 40], [x0 + L, 40], "load", 'style="stroke-width:1.4"'),
    );
    parts.push(
      text(
        [x0 + L / 2, 30],
        "uniform traction q over length L",
        "small load-text",
      ),
    );
    for (let i = 0; i < nodeCount; i++) {
      const x = x0 + (i * L) / (nodeCount - 1);
      const len = 120 * values[i][0];
      parts.push(
        dot([x, y], 5),
        arrow([x, y + 10], [x, y + 10 + len], "load"),
        text(
          [x, y + 30 + len],
          values[i][1],
          "sym load-text",
          "middle",
          'font-size="15"',
        ),
      );
    }
    parts.push(text([x0 + L / 2, 262], label, "title"));
  };
  edge(
    40,
    [
      [0.5, "qL/2"],
      [0.5, "qL/2"],
    ],
    "Linear edge: 2 nodes",
    2,
  );
  edge(
    380,
    [
      [1 / 6, "qL/6"],
      [2 / 3, "2qL/3"],
      [1 / 6, "qL/6"],
    ],
    "Quadratic edge: 3 nodes",
    3,
  );
  void doubleArrow;
  return parts.join("\n");
}

// ── Conjugate gradient convergence on a small elasticity problem ─────────────

function planeStressSystem() {
  const { points, triangles } = plateMesh;
  const N = points.length * 2;
  const E = 1;
  const nu = 0.3;
  const c = E / (1 - nu * nu);
  const D = [
    [c, c * nu, 0],
    [c * nu, c, 0],
    [0, 0, (c * (1 - nu)) / 2],
  ];
  const K = Array.from({ length: N }, () => new Map());
  for (const t of triangles) {
    const [p1, p2, p3] = t.map((i) => points[i]);
    const area2 =
      (p2[0] - p1[0]) * (p3[1] - p1[1]) - (p3[0] - p1[0]) * (p2[1] - p1[1]);
    const A = Math.abs(area2) / 2;
    const b = [p2[1] - p3[1], p3[1] - p1[1], p1[1] - p2[1]].map(
      (v) => v / area2,
    );
    const g = [p3[0] - p2[0], p1[0] - p3[0], p2[0] - p1[0]].map(
      (v) => v / area2,
    );
    const B = [[], [], []];
    for (let a = 0; a < 3; a++) {
      B[0].push(b[a], 0);
      B[1].push(0, g[a]);
      B[2].push(g[a], b[a]);
    }
    const dofs = t.flatMap((i) => [2 * i, 2 * i + 1]);
    for (let r = 0; r < 6; r++)
      for (let s = 0; s < 6; s++) {
        let v = 0;
        for (let i = 0; i < 3; i++)
          for (let j = 0; j < 3; j++) v += B[i][r] * D[i][j] * B[j][s];
        const row = K[dofs[r]];
        row.set(dofs[s], (row.get(dofs[s]) ?? 0) + v * A);
      }
  }
  // Clamp the leftmost tenth of the nodes; pull the rightmost node.
  const fixed = new Set();
  const xs = points.map(([x]) => x);
  const xmin = Math.min(...xs);
  const xmax = Math.max(...xs);
  points.forEach(([x], i) => {
    if (x < xmin + 0.12 * (xmax - xmin)) fixed.add(2 * i).add(2 * i + 1);
  });
  const f = new Float64Array(N);
  const tip = xs.indexOf(xmax);
  f[2 * tip + 1] = -1;
  // Eliminate: zero rows and columns, keep a unit diagonal.
  for (let i = 0; i < N; i++) {
    if (fixed.has(i)) {
      K[i] = new Map([[i, 1]]);
      f[i] = 0;
    } else for (const j of [...K[i].keys()]) if (fixed.has(j)) K[i].delete(j);
  }
  return { K, f, N };
}

function cgHistory(K, f, N, preconditioned) {
  const mult = (x) => {
    const y = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      let s = 0;
      for (const [j, v] of K[i]) s += v * x[j];
      y[i] = s;
    }
    return y;
  };
  // Symmetric Gauss–Seidel: one forward and one backward sweep.
  const precondition = (r) => {
    if (!preconditioned) return Float64Array.from(r);
    const z = new Float64Array(N);
    for (const order of [
      Array.from({ length: N }, (_, i) => i),
      Array.from({ length: N }, (_, i) => N - 1 - i),
    ])
      for (const i of order) {
        let s = r[i];
        let diag = 0;
        for (const [j, v] of K[i]) {
          if (j === i) diag = v;
          else s -= v * z[j];
        }
        z[i] = s / diag;
      }
    return z;
  };
  const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
  const x = new Float64Array(N);
  let r = Float64Array.from(f);
  let z = precondition(r);
  let p = Float64Array.from(z);
  let rz = dot(r, z);
  const eta0 = Math.sqrt(rz);
  const history = [1];
  for (let k = 0; k < 4 * N && history.at(-1) > 1e-9; k++) {
    const Ap = mult(p);
    const alpha = rz / dot(p, Ap);
    for (let i = 0; i < N; i++) {
      x[i] += alpha * p[i];
      r[i] -= alpha * Ap[i];
    }
    z = precondition(r);
    const rzNew = dot(r, z);
    history.push(Math.sqrt(Math.max(rzNew, 0)) / eta0);
    const beta = rzNew / rz;
    rz = rzNew;
    for (let i = 0; i < N; i++) p[i] = z[i] + beta * p[i];
  }
  return history;
}

export const cgStudy = (() => {
  const { K, f, N } = planeStressSystem();
  const plain = cgHistory(K, f, N, false);
  const sgs = cgHistory(K, f, N, true);
  const reached = (h) => h.findIndex((v) => v <= 1e-6);
  return {
    N,
    plain,
    sgs,
    plainIterations: reached(plain),
    sgsIterations: reached(sgs),
  };
})();

function cgConvergence() {
  const { plain, sgs } = cgStudy;
  const kmax = Math.max(plain.length, sgs.length);
  const X = scale([0, kmax], [80, 600]);
  const Y = scale([1e-9, 10], [290, 30], true);
  const parts = [];
  for (let e = -9; e <= 1; e++) {
    parts.push(line([80, Y(10 ** e)], [600, Y(10 ** e)], "grid"));
    if (e % 3 === 0 || e === 0)
      parts.push(
        text(
          [72, Y(10 ** e) + 4],
          e === 0
            ? "1"
            : `10${String(e)
                .replace("-", "⁻")
                .replace(/\d/g, (d) => "⁰¹²³⁴⁵⁶⁷⁸⁹"[d])}`,
          "small lbl",
          "end",
        ),
      );
  }
  const step = kmax > 200 ? 100 : kmax > 120 ? 50 : 25;
  for (let k = 0; k <= kmax; k += step) {
    parts.push(
      line([X(k), 290], [X(k), 295], "thin"),
      text([X(k), 310], String(k), "small lbl"),
    );
  }
  parts.push(
    line([80, 290], [600, 290], "axis"),
    line([80, 30], [80, 290], "axis"),
    text([340, 336], "iteration", "lbl"),
    text(
      [24, 160],
      "relative residual",
      "lbl",
      "middle",
      'transform="rotate(-90 24 160)"',
    ),
    line(
      [80, Y(1e-6)],
      [600, Y(1e-6)],
      "dash",
      `style="stroke:${palette.load}"`,
    ),
    text([596, Y(1e-6) - 6], "KoFEM stops at 10⁻⁶", "small load-text", "end"),
  );
  const curve = (h, cls) =>
    polyline(
      h.map((v, k) => [X(k), Y(Math.max(v, 1e-9))]),
      cls,
    );
  parts.push(curve(plain, "accent2"), curve(sgs, "accent"));
  parts.push(
    text(
      [X(plain.length * 0.55), Y(plain[Math.round(plain.length * 0.55)]) - 12],
      "CG, no preconditioner",
      "small accent2-text",
      "start",
    ),
    text(
      [X(sgs.length) + 8, Y(1e-8) + 4],
      "CG + symmetric Gauss–Seidel",
      "small accent-text",
      "start",
    ),
  );
  return parts.join("\n");
}

// ── A 3-2-1 support ──────────────────────────────────────────────────────────

function threeTwoOne() {
  const P = ([x, y, z]) => [150 + x + 0.5 * y, 170 - z - 0.45 * y];
  const L = 320;
  const W = 90;
  const H = 70;
  const parts = [
    polygon(
      [
        [0, 0, 0],
        [L, 0, 0],
        [L, 0, H],
        [0, 0, H],
      ].map(P),
      "body",
    ),
    polygon(
      [
        [0, 0, H],
        [L, 0, H],
        [L, W, H],
        [0, W, H],
      ].map(P),
      "body-alt",
    ),
    polygon(
      [
        [L, 0, 0],
        [L, W, 0],
        [L, W, H],
        [L, 0, H],
      ].map(P),
      "side",
    ),
    path(
      `M${P([0, 0, 0]).join(" ")}L${P([0, W, 0]).join(" ")}L${P([L, W, 0]).join(" ")}M${P([0, W, 0]).join(" ")}L${P([0, W, H]).join(" ")}`,
      "dash",
    ),
  ];
  const A = P([0, 0, 0]);
  const B = P([L, 0, 0]);
  const C = P([0, W, 0]);
  parts.push(
    arrow(
      P([0, 0, H / 2]),
      [P([0, 0, H / 2])[0] - 90, P([0, 0, H / 2])[1]],
      "load",
    ),
    arrow(
      P([L, W / 2, H / 2]),
      [P([L, W / 2, H / 2])[0] + 90, P([L, W / 2, H / 2])[1]],
      "load",
    ),
    text(
      [P([0, 0, H / 2])[0] - 96, P([0, 0, H / 2])[1] - 8],
      "−P",
      "sym load-text",
      "start",
    ),
    text(
      [P([L, W / 2, H / 2])[0] + 80, P([L, W / 2, H / 2])[1] - 10],
      "P",
      "sym load-text",
      "start",
    ),
    dot(A, 6, "node-accent"),
    dot(B, 6, "node-accent"),
    circle(C, 6, "node-open"),
    text([A[0], A[1] + 28], "A: Ux, Uy, Uz", "bold"),
    text([B[0], B[1] + 28], "B: Uy, Uz", "bold"),
    text([C[0] + 12, C[1] - 10], "C: Uz", "bold", "start"),
    arrow([40, 245], [80, 245]),
    arrow([40, 245], [60, 227]),
    arrow([40, 245], [40, 205]),
    text([86, 250], "x", "sym", "start"),
    text([66, 226], "y", "sym", "start"),
    text([40, 198], "z", "sym"),
  );
  void n;
  return parts.join("\n");
}

export default [
  {
    id: "lagrange-shape-functions",
    title: "Quadratic and cubic Lagrange shape functions in one dimension",
    alt: "Left: the three quadratic shape functions of a three-node element; each equals one at its own node and zero at the others. Right: the four cubic shape functions of a four-node element, with the same property.",
    width: 840,
    height: 315,
    body: [
      shapePanel(30, [0, 0.5, 1], "Quadratic: 3 nodes"),
      shapePanel(450, [0, 1 / 3, 2 / 3, 1], "Cubic: 4 nodes"),
    ].join("\n"),
  },
  {
    id: "quadrature-points",
    title: "Gauss quadrature points on reference elements",
    alt: "Reference triangles with one and three integration points, and reference squares with two-by-two and three-by-three Gauss points, marked as red dots.",
    width: 760,
    height: 215,
    body: quadraturePoints(),
  },
  {
    id: "element-node-layouts",
    title: "Node layouts of linear and quadratic solid elements",
    alt: "Four solid elements with their nodes: a linear tetrahedron with 4 corner nodes, a quadratic tetrahedron with 10 nodes at corners and edge midpoints, a trilinear hexahedron with 8 corner nodes and a quadratic hexahedron with 27 nodes at corners, edges, faces and centre. Hidden nodes are drawn open.",
    width: 860,
    height: 270,
    body: elementLayouts(),
  },
  {
    id: "assembly-two-bars",
    title: "Assembling two bar elements into the global stiffness matrix",
    alt: "A bar fixed at node 1 and pulled at node 3, made of two elements. Each element's two-by-two stiffness matrix is added into the three-by-three global matrix; the entries of the shared node 2 overlap and add to k1 plus k2.",
    width: 560,
    height: 320,
    body: assemblyBars(),
  },
  {
    id: "mesh-sparsity",
    title: "A triangular mesh and the sparsity pattern of its stiffness matrix",
    alt: "Left: a triangular mesh with one node and its neighbours highlighted. Right: the sparsity pattern of the plane-elasticity stiffness matrix of that mesh; nonzero entries cluster in a band around the diagonal, and the highlighted node's two rows have nonzeros only for its neighbours.",
    width: 640,
    height: 300,
    body: sparsity(),
  },
  {
    id: "rigid-body-modes",
    title: "The three rigid-body modes of a body in the plane",
    alt: "A free body can translate in x, translate in y or rotate without straining, shown by dashed displaced outlines. A pin and a roller together remove all three motions.",
    width: 870,
    height: 230,
    body: rigidModes(),
  },
  {
    id: "three-two-one-support",
    title: "A 3-2-1 support on a block",
    alt: "A block along x, pulled by equal and opposite forces P at its two ends. Point A at the near bottom-left corner fixes Ux, Uy and Uz; point B at the near bottom-right corner fixes Uy and Uz; point C at the hidden far bottom-left corner fixes only Uz.",
    width: 640,
    height: 270,
    body: threeTwoOne(),
  },
  {
    id: "consistent-nodal-loads",
    title: "Consistent nodal loads from a uniform traction",
    alt: "A uniform traction q on an edge of length L becomes nodal forces. A linear two-node edge receives qL/2 at each node. A quadratic three-node edge receives qL/6 at each end and 2qL/3 at the midpoint.",
    width: 700,
    height: 280,
    body: nodalLoads(),
  },
  {
    id: "cg-convergence",
    title:
      "Convergence of conjugate gradients with and without preconditioning",
    alt: "Relative residual against iteration on a logarithmic scale for a small plane-elasticity problem. Conjugate gradients without a preconditioner needs many more iterations to reach the 10 to the minus 6 tolerance than conjugate gradients preconditioned with symmetric Gauss–Seidel.",
    width: 640,
    height: 345,
    body: cgConvergence(),
  },
];

void pointsPath;
