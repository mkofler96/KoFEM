// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Figures for "What is FEM?": a meshed body with nodes, elements, loads,
// supports and DOFs; and the path from CAD geometry to a mesh to one element.

import {
  arrow,
  circle,
  dot,
  line,
  palette,
  path,
  pinSupport,
  pointsPath,
  polygon,
  rollerSupport,
  smoothClosed,
  text,
  n,
} from "./svg.mjs";
import { edges, meshDomain, resampleClosed, sampleCurve } from "./mesh2d.mjs";

// ── A meshed body ─────────────────────────────────────────────────────────────

// A smooth, slightly kidney-shaped 2D body.
const blobCentre = [390, 238];
const blobPoint = (t) => {
  const a = 2 * Math.PI * t;
  const r =
    1 +
    0.13 * Math.cos(2 * a) +
    0.11 * Math.sin(3 * a) -
    0.07 * Math.cos(4 * a) +
    0.05 * Math.sin(5 * a + 0.6);
  return [
    blobCentre[0] + 265 * r * Math.cos(a),
    blobCentre[1] - 158 * r * Math.sin(a) - 20 * Math.sin(2 * a),
  ];
};
const blobOutline = sampleCurve(blobPoint, 400);
const blobBoundary = resampleClosed(blobOutline, 46);
const blob = meshDomain(blobBoundary, [], 50, 7);

// Boundary node nearest a direction (angle in degrees, counter-clockwise
// from +x, screen y up).
function boundaryNodeAt(angle) {
  const a = (angle * Math.PI) / 180;
  let best = 0;
  let bestDot = -Infinity;
  blobBoundary.forEach(([x, y], i) => {
    const dx = x - blobCentre[0];
    const dy = blobCentre[1] - y;
    const d = (dx * Math.cos(a) + dy * Math.sin(a)) / Math.hypot(dx, dy);
    if (d > bestDot) {
      bestDot = d;
      best = i;
    }
  });
  return blob.points[best];
}

function domainMesh() {
  const { points, triangles } = blob;
  const meshLines = edges(triangles)
    .map(
      ([a, b]) =>
        `M${n(points[a][0])} ${n(points[a][1])}L${n(points[b][0])} ${n(points[b][1])}`,
    )
    .join("");
  const parts = [
    path(smoothClosed(blobBoundary), "body", 'style="fill:#d9f0ee"'),
    path(meshLines, "mesh"),
    path(smoothClosed(blobBoundary), "outline", 'style="stroke-width:2.2"'),
    ...points.map((p) => dot(p, 4.2)),
  ];

  // Loads: arrows onto the upper-left boundary.
  const loadNodes = [150, 162, 174, 186].map(boundaryNodeAt);
  for (const p of loadNodes) {
    const dx = p[0] - blobCentre[0];
    const dy = p[1] - blobCentre[1];
    const len = Math.hypot(dx, dy);
    const dir = [dx / len + 0.35, dy / len - 0.1];
    const l = Math.hypot(...dir);
    const start = [p[0] + (dir[0] / l) * 78, p[1] + (dir[1] / l) * 78];
    parts.push(
      arrow(start, [p[0] + (dir[0] / l) * 6, p[1] + (dir[1] / l) * 6], "load"),
    );
  }
  parts.push(text([70, 72], "Loads", "load-text", "middle", 'font-size="19"'));

  // Supports on the lower boundary.
  const pin = boundaryNodeAt(262);
  const roller = boundaryNodeAt(296);
  parts.push(
    pinSupport([pin[0], pin[1] + 4], 16),
    rollerSupport([roller[0], roller[1] + 4], 16),
  );
  parts.push(
    text(
      [roller[0] + 34, roller[1] + 30],
      "Boundary conditions",
      "bold",
      "start",
      'font-size="16" font-style="italic"',
    ),
  );

  // DOFs at two right-hand boundary nodes.
  for (const angle of [12, 30]) {
    const p = boundaryNodeAt(angle);
    parts.push(
      arrow(p, [p[0] + 34, p[1]]),
      arrow(p, [p[0], p[1] - 34]),
      text([p[0] + 40, p[1] + 5], "u", "sym bold", "start"),
      text([p[0] + 4, p[1] - 40], "v", "sym bold", "start"),
    );
  }
  parts.push(
    text(
      [770, 112],
      "DOFs",
      "bold",
      "middle",
      'font-size="16" font-style="italic"',
    ),
  );

  // Callouts for nodes and elements.
  const top = boundaryNodeAt(92);
  parts.push(
    text(
      [top[0] + 10, 42],
      "Nodes",
      "bold",
      "middle",
      'font-size="16" font-style="italic"',
    ),
    arrow([top[0] + 8, 50], [top[0] + 1, top[1] - 6]),
  );
  const t = blob.triangles.reduce(
    (best, tri) => {
      const c = tri.map((i) => blob.points[i]);
      const cx = (c[0][0] + c[1][0] + c[2][0]) / 3;
      const cy = (c[0][1] + c[1][1] + c[2][1]) / 3;
      const score = Math.hypot(cx - 560, cy - 330);
      return score < best.score ? { score, c: [cx, cy] } : best;
    },
    { score: Infinity, c: [0, 0] },
  );
  parts.push(
    text(
      [700, 400],
      "Elements",
      "bold",
      "start",
      'font-size="16" font-style="italic"',
    ),
    arrow([696, 392], [t.c[0] + 4, t.c[1] + 2]),
  );
  return parts.join("\n");
}

// ── Geometry → mesh → element ─────────────────────────────────────────────────

// A plate with a hole, drawn in isometric projection.
const plate = { w: 170, d: 110, t: 20, hole: [62, 55], r: 27 };
const iso =
  (ox, oy) =>
  ([x, y, z]) => [ox + (x - y) * 0.866, oy + (x + y) * 0.5 - z];

function plateDrawing(origin, meshed) {
  const P = iso(...origin);
  const { w, d, t, hole, r } = plate;
  const parts = [];
  // Visible side faces: x = w and y = d.
  const xFace = [
    [w, 0, 0],
    [w, d, 0],
    [w, d, t],
    [w, 0, t],
  ].map(P);
  const yFace = [
    [0, d, 0],
    [w, d, 0],
    [w, d, t],
    [0, d, t],
  ].map(P);
  parts.push(
    polygon(xFace, "side"),
    polygon(yFace, "side", 'style="fill:#b3c8de"'),
  );

  const holeTop = sampleCurve(
    (s) => [
      hole[0] + r * Math.cos(2 * Math.PI * s),
      hole[1] + r * Math.sin(2 * Math.PI * s),
      t,
    ],
    96,
  );
  const top = [
    [0, 0, t],
    [w, 0, t],
    [w, d, t],
    [0, d, t],
  ].map(P);
  parts.push(
    path(
      `${pointsPath(top)}${pointsPath(holeTop.map(P))}`,
      "body",
      'fill-rule="evenodd"',
    ),
  );
  // The far inner wall of the hole, seen through the opening.
  const back = holeTop.filter(([x, y]) => x - hole[0] + (y - hole[1]) < 0);
  // Unwrap the angle so the back half (135° to 315°) is one ordered arc.
  const unwrapped = ([x, y]) =>
    (Math.atan2(y - hole[1], x - hole[0]) - (3 * Math.PI) / 4 + 4 * Math.PI) %
    (2 * Math.PI);
  back.sort((a, b) => unwrapped(a) - unwrapped(b));
  const clipId = `hole-${origin[0]}`;
  const wall = [
    ...back.map(P),
    ...back
      .slice()
      .reverse()
      .map(([x, y]) => P([x, y, 0])),
  ];
  parts.push(
    `<clipPath id="${clipId}"><path d="${pointsPath(holeTop.map(P))}"/></clipPath>`,
    `<g clip-path="url(#${clipId})">${polygon(wall, "side")}`,
  );
  if (meshed)
    for (const p of back.filter((_, i) => i % 6 === 0))
      parts.push(line(P(p), P([p[0], p[1], 0]), "mesh"));
  parts.push(`</g>`);

  if (meshed) {
    // Top-face triangles and side-face element edges (two element layers).
    const outer = resampleClosed(
      [
        [0, 0],
        [w, 0],
        [w, d],
        [0, d],
      ],
      13,
    );
    const holeLoop = sampleCurve(
      (s) => [
        hole[0] + r * Math.cos(-2 * Math.PI * s),
        hole[1] + r * Math.sin(-2 * Math.PI * s),
      ],
      Math.round((2 * Math.PI * r) / 11),
    );
    const mesh = meshDomain(outer, [holeLoop], 14, 3);
    const d3 = edges(mesh.triangles)
      .map(([a, b]) => {
        const pa = P([...mesh.points[a], t]);
        const pb = P([...mesh.points[b], t]);
        return `M${n(pa[0])} ${n(pa[1])}L${n(pb[0])} ${n(pb[1])}`;
      })
      .join("");
    parts.push(path(d3, "mesh"));
    const sides = [];
    for (const [x, y] of outer) {
      if (Math.abs(x - w) < 1e-6 || Math.abs(y - d) < 1e-6) {
        const a = P([x, y, 0]);
        const b = P([x, y, t]);
        sides.push(`M${n(a[0])} ${n(a[1])}L${n(b[0])} ${n(b[1])}`);
      }
    }
    for (const [a, b] of [
      [
        [w, 0, t / 2],
        [w, d, t / 2],
      ],
      [
        [0, d, t / 2],
        [w, d, t / 2],
      ],
    ]) {
      const pa = P(a);
      const pb = P(b);
      sides.push(`M${n(pa[0])} ${n(pa[1])}L${n(pb[0])} ${n(pb[1])}`);
    }
    parts.push(path(sides.join(""), "mesh"));
    // Diagonals so the side faces read as triangles too.
    const diag = [];
    const xs = outer
      .filter(([x, y]) => Math.abs(y - d) < 1e-6)
      .sort((a, b) => a[0] - b[0]);
    for (let i = 0; i + 1 < xs.length; i++)
      for (const [z0, z1] of [
        [0, t / 2],
        [t / 2, t],
      ]) {
        const a = P([xs[i][0], d, z0]);
        const b = P([xs[i + 1][0], d, z1]);
        diag.push(`M${n(a[0])} ${n(a[1])}L${n(b[0])} ${n(b[1])}`);
      }
    const ys = outer
      .filter(([x]) => Math.abs(x - w) < 1e-6)
      .sort((a, b) => a[1] - b[1]);
    for (let i = 0; i + 1 < ys.length; i++)
      for (const [z0, z1] of [
        [0, t / 2],
        [t / 2, t],
      ]) {
        const a = P([w, ys[i][1], z0]);
        const b = P([w, ys[i + 1][1], z1]);
        diag.push(`M${n(a[0])} ${n(a[1])}L${n(b[0])} ${n(b[1])}`);
      }
    parts.push(path(diag.join(""), "mesh"));
  }
  // Crisp outer edges.
  parts.push(
    polygon(top, "outline"),
    path(pointsPath(holeTop.map(P)), "outline"),
    polygon(xFace, "outline"),
    polygon(yFace, "outline"),
  );
  return parts.join("\n");
}

function quadraticTet([ox, oy]) {
  const v = {
    1: [ox, oy + 62],
    2: [ox + 112, oy + 150],
    3: [ox + 196, oy + 74],
    4: [ox + 120, oy - 56],
  };
  const mid = (a, b) => [(v[a][0] + v[b][0]) / 2, (v[a][1] + v[b][1]) / 2];
  const m = {
    5: mid(1, 2),
    6: mid(2, 3),
    7: mid(3, 1),
    8: mid(1, 4),
    9: mid(2, 4),
    10: mid(3, 4),
  };
  const parts = [
    polygon(
      [v[1], v[2], v[3], v[4]].map((p) => p),
      "body",
      'style="fill:#eef4fa;stroke:none"',
    ),
    line(v[1], v[3], "dash"),
  ];
  for (const [a, b] of [
    [1, 2],
    [2, 3],
    [1, 4],
    [2, 4],
    [3, 4],
  ])
    parts.push(line(v[a], v[b], "ink", 'style="stroke-width:2"'));
  for (const [id, p] of Object.entries(v)) parts.push(dot(p, 5.2));
  for (const [id, p] of Object.entries(m))
    parts.push(id === "7" ? circle(p, 4.6, "node-open") : dot(p, 4.6));
  const label = {
    1: [-14, 5],
    2: [0, 24],
    3: [14, 5],
    4: [0, -12],
    5: [-14, 10],
    6: [14, 14],
    7: [-8, 20],
    8: [-14, -4],
    9: [-14, 4],
    10: [14, -4],
  };
  for (const [id, [dx, dy]] of Object.entries(label)) {
    const p = v[id] ?? m[id];
    parts.push(
      text([p[0] + dx, p[1] + dy], id, "bold", "middle", 'font-size="14"'),
    );
  }
  return parts.join("\n");
}

function geometryToMesh() {
  const blockArrow = (x, y) =>
    polygon(
      [
        [x, y - 9],
        [x + 34, y - 9],
        [x + 34, y - 19],
        [x + 58, y],
        [x + 34, y + 19],
        [x + 34, y + 9],
        [x, y + 9],
      ],
      "",
      `style="fill:${palette.accent};opacity:0.85"`,
    );
  return [
    plateDrawing([105, 60], false),
    blockArrow(285, 150),
    plateDrawing([445, 60], true),
    path(
      "M610 112C680 40 720 60 742 82",
      "accent",
      'marker-end="url(#a-accent)"',
    ),
    quadraticTet([700, 110]),
    text(
      [155, 300],
      "Geometry",
      "title",
      "middle",
      `style="fill:${palette.accent}"`,
    ),
    text(
      [495, 300],
      "Mesh",
      "title",
      "middle",
      `style="fill:${palette.accent}"`,
    ),
    text(
      [808, 300],
      "Quadratic tetrahedron",
      "title",
      "middle",
      `style="fill:${palette.accent}"`,
    ),
  ].join("\n");
}

export default [
  {
    id: "fem-domain-mesh",
    title: "A body discretised into finite elements",
    alt: "A smooth two-dimensional body divided into triangular elements. Black dots mark the nodes; red arrows load the upper-left edge; a pinned and a roller support hold the bottom; arrows u and v at two nodes show their degrees of freedom.",
    width: 820,
    height: 445,
    body: domainMesh(),
  },
  {
    id: "fem-geometry-to-mesh",
    title: "From CAD geometry to a mesh to one element",
    alt: "Left: a plate with a hole as CAD geometry. Middle: the same plate covered by a triangulated surface mesh. Right: one quadratic tetrahedron with ten numbered nodes, four at its corners and six at its edge midpoints.",
    width: 940,
    height: 320,
    body: geometryToMesh(),
  },
];
