// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Figures for the multigrid article: what Gauss–Seidel leaves behind,
// aggregates on two levels, tentative and smoothed coarse basis vectors, the
// V-cycle, and CG iterations under mesh refinement. The numbers come from the
// article's own smoothed-aggregation example (numerical-methods/
// multigrid-example.mjs).

import {
  arrow,
  circle,
  dot,
  line,
  palette,
  path,
  polygon,
  polyline,
  scale,
  text,
} from "./svg.mjs";
import { edges, meshDomain, resampleClosed, sampleCurve } from "./mesh2d.mjs";
import {
  barExample,
  eliminate,
  planeStress,
  refinementStudy,
  rigidBodyModes2d,
  smoothedAggregation,
  toCsr,
} from "../numerical-methods/multigrid-example.mjs";

// ── Gauss–Seidel smooths the error but leaves its smooth part ────────────────

function gaussSeidelSmoothing() {
  const size = 63;
  const xs = Array.from({ length: size }, (_, i) => (i + 1) / (size + 1));
  const smooth = xs.map((x) => Math.sin(Math.PI * x));
  const initial = xs.map(
    (x, i) =>
      smooth[i] +
      0.35 * Math.sin(19 * Math.PI * x) +
      0.25 * Math.sin(41 * Math.PI * x),
  );
  // Gauss–Seidel on A·e = 0 with A = tridiag(−1, 2, −1): e_i ← (e_{i−1} + e_{i+1}) / 2.
  const sweeps = (count) => {
    const e = [...initial];
    for (let sweep = 0; sweep < count; sweep++)
      for (let i = 0; i < size; i++)
        e[i] = ((i > 0 ? e[i - 1] : 0) + (i < size - 1 ? e[i + 1] : 0)) / 2;
    return e;
  };
  const panel = (x0, values, title, note) => {
    const X = scale([0, 1], [x0 + 10, x0 + 370]);
    const Y = scale([-0.7, 1.7], [230, 40]);
    const all = [0, ...values, 0];
    const grid = [0, ...xs, 1];
    return [
      line([x0 + 10, Y(0)], [x0 + 370, Y(0)], "axis"),
      text([x0 + 190, 24], title, "title"),
      polyline(
        grid.map((x, i) => [X(x), Y([0, ...smooth, 0][i])]),
        "dash",
      ),
      polyline(
        grid.map((x, i) => [X(x), Y(all[i])]),
        "accent",
      ),
      text([x0 + 190, 258], note, "small lbl"),
    ].join("\n");
  };
  return [
    panel(
      20,
      initial,
      "Initial error",
      "smooth part (dashed) plus oscillations",
    ),
    panel(
      440,
      sweeps(4),
      "After four Gauss–Seidel sweeps",
      "oscillations gone, smooth part almost unchanged",
    ),
  ].join("\n");
}

// ── Aggregates on two levels of an unstructured mesh ─────────────────────────

const aggregateModel = (() => {
  const h = 22;
  const outer = resampleClosed(
    sampleCurve((t) => {
      const a = 2 * Math.PI * t;
      const r = 1 + 0.16 * Math.cos(2 * a) + 0.07 * Math.sin(3 * a);
      return [190 * r * Math.cos(a), 105 * r * Math.sin(a)];
    }, 300),
    h,
  );
  const hole = resampleClosed(
    sampleCurve((t) => {
      const a = -2 * Math.PI * t;
      return [70 + 34 * Math.cos(a), 34 * Math.sin(a)];
    }, 100),
    h,
  );
  const mesh = meshDomain(outer, [hole], h, 5);
  // Clamp the left end, so the plate cannot move as a rigid body.
  const constrained = mesh.points.flatMap(([x]) => [x < -170, x < -170]);
  const matrix = toCsr(
    eliminate(planeStress(mesh.points, mesh.triangles), constrained),
  );
  const hierarchy = smoothedAggregation(matrix, {
    block: 2,
    modes: rigidBodyModes2d(mesh.points, constrained),
    constrained,
    coarseSize: 20,
  });
  const [first, second] = hierarchy.aggregations;
  return {
    ...mesh,
    levels: [first, first.map((id) => (id === null ? null : second[id]))],
    counts: [Math.max(...first) + 1, Math.max(...second) + 1],
  };
})();

// Pastel fills; neighbouring aggregates get different ones.
const fills = [
  "#cfe0f5",
  "#f6d6c2",
  "#d3ead2",
  "#e6d6ef",
  "#f4e8b8",
  "#cde9ec",
];

function colourAggregates(triangles, owner) {
  const count = Math.max(...owner.map((id) => id ?? -1)) + 1;
  const adjacent = Array.from({ length: count }, () => new Set());
  for (const [a, b] of edges(triangles)) {
    const [p, q] = [owner[a], owner[b]];
    if (p !== null && q !== null && p !== q) {
      adjacent[p].add(q);
      adjacent[q].add(p);
    }
  }
  const colour = new Array(count).fill(-1);
  for (let id = 0; id < count; id++) {
    const taken = new Set([...adjacent[id]].map((other) => colour[other]));
    colour[id] = fills.findIndex((_, k) => !taken.has(k));
    if (colour[id] < 0) throw new Error("ran out of aggregate colours");
  }
  return colour;
}

function aggregatePanel(x0, owner, title, note) {
  const { points, triangles } = aggregateModel;
  const place = ([x, y]) => [x0 + 220 + 0.9 * x, 150 - 0.9 * y];
  const colour = colourAggregates(triangles, owner);
  const parts = [text([x0 + 220, 24], title, "title")];
  // Each node's share of a triangle (its corner up to the edge midpoints and
  // the centroid) takes the colour of the node's aggregate.
  for (const triangle of triangles) {
    const corners = triangle.map((i) => points[i]);
    const centroid = [0, 1].map(
      (axis) => (corners[0][axis] + corners[1][axis] + corners[2][axis]) / 3,
    );
    triangle.forEach((node, k) => {
      const p = corners[k];
      const mid = (q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
      // Clamped nodes join no aggregate.
      const fill =
        owner[node] === null ? "#e3e6ea" : fills[colour[owner[node]]];
      parts.push(
        polygon(
          [
            p,
            mid(corners[(k + 1) % 3]),
            centroid,
            mid(corners[(k + 2) % 3]),
          ].map(place),
          "",
          `style="fill:${fill};stroke:${fill};stroke-width:0.6"`,
        ),
      );
    });
  }
  // Boundaries between aggregates, drawn along the dual edges.
  const boundary = [];
  for (const triangle of triangles) {
    const corners = triangle.map((i) => points[i]);
    const centroid = [0, 1].map(
      (axis) => (corners[0][axis] + corners[1][axis] + corners[2][axis]) / 3,
    );
    for (let k = 0; k < 3; k++) {
      const [a, b] = [triangle[k], triangle[(k + 1) % 3]];
      if (owner[a] === owner[b]) continue;
      const mid = [0, 1].map((axis) => (points[a][axis] + points[b][axis]) / 2);
      const [p, q] = [place(mid), place(centroid)];
      boundary.push(
        `M${p[0].toFixed(1)} ${p[1].toFixed(1)}L${q[0].toFixed(1)} ${q[1].toFixed(1)}`,
      );
    }
  }
  parts.push(
    path(
      edges(triangles)
        .map(([a, b]) => {
          const [p, q] = [place(points[a]), place(points[b])];
          return `M${p[0].toFixed(1)} ${p[1].toFixed(1)}L${q[0].toFixed(1)} ${q[1].toFixed(1)}`;
        })
        .join(""),
      "",
      `style="fill:none;stroke:${palette.faint};stroke-width:0.5"`,
    ),
    path(
      boundary.join(""),
      "",
      `style="fill:none;stroke:${palette.ink};stroke-width:1.4;stroke-linecap:round"`,
    ),
  );
  for (const p of points) parts.push(dot(place(p), 1.8));
  parts.push(
    text(place([-185, -105]), "clamped end", "small lbl"),
    text([x0 + 220, 290], note, "small lbl"),
  );
  return parts.join("\n");
}

function aggregates() {
  const { points, levels, counts } = aggregateModel;
  return [
    aggregatePanel(
      0,
      levels[0],
      "First coarsening",
      `${points.length} nodes in ${counts[0]} aggregates`,
    ),
    aggregatePanel(
      440,
      levels[1],
      "Second coarsening",
      `${counts[0]} aggregates grouped into ${counts[1]}`,
    ),
  ].join("\n");
}

// ── Tentative and smoothed coarse basis vectors of the worked bar ────────────

function prolongator() {
  const { columns } = barExample();
  const tentative = [
    [1, 1, 1, 0, 0, 0],
    [0, 0, 0, 1, 1, 1],
  ];
  const panel = (x0, vectors, title) => {
    const X = scale([0, 7], [x0 + 30, x0 + 370]);
    const Y = scale([0, 1.1], [220, 60]);
    const parts = [
      text([x0 + 200, 24], title, "title"),
      line([X(0), Y(0)], [X(7), Y(0)], "axis"),
    ];
    for (let i = 0; i <= 7; i++) {
      parts.push(text([X(i), Y(0) + 20], String(i), "small lbl"));
    }
    parts.push(
      polygon(
        [
          [X(0) - 6, Y(0)],
          [X(0) + 6, Y(0)],
          [X(0), Y(0) - 10],
        ],
        "body-alt",
      ),
      polygon(
        [
          [X(7) - 6, Y(0)],
          [X(7) + 6, Y(0)],
          [X(7), Y(0) - 10],
        ],
        "body-alt",
      ),
    );
    vectors.forEach((vector, c) => {
      const values = [0, ...vector, 0];
      const cls = c === 0 ? "accent" : "accent2";
      parts.push(
        polyline(
          values.map((value, i) => [X(i), Y(value)]),
          cls,
        ),
      );
      values.forEach((value, i) => {
        if (i > 0 && i < 7 && value > 0)
          parts.push(
            `<circle cx="${X(i).toFixed(1)}" cy="${Y(value).toFixed(1)}" r="3.6" style="fill:${c === 0 ? palette.accent : palette.accent2}"/>`,
          );
      });
    });
    parts.push(
      line([X(0) - 8, Y(1)], [X(0) - 2, Y(1)], "thin"),
      text([X(0) - 12, Y(1) + 4], "1", "small lbl", "end"),
      text([x0 + 200, 266], "node", "small lbl"),
    );
    return parts.join("\n");
  };
  return [
    panel(20, tentative, "Tentative: one constant per aggregate"),
    panel(440, columns, "Smoothed: one damped Jacobi step"),
  ].join("\n");
}

// ── The V-cycle ──────────────────────────────────────────────────────────────

function vCycle() {
  const levels = 4;
  const Y = (level) => 60 + level * 62;
  const down = (level) => 110 + level * 95;
  const up = (level) => 750 - level * 95;
  const parts = [];
  for (let level = 0; level < levels; level++) {
    parts.push(
      text(
        [24, Y(level) + 4],
        level === 0
          ? "fine"
          : level === levels - 1
            ? "coarsest"
            : `level ${level}`,
        "small lbl",
        "start",
      ),
      line([84, Y(level)], [800, Y(level)], "grid"),
    );
  }
  const bottom = [(down(levels - 1) + up(levels - 1)) / 2, Y(levels - 1)];
  for (let level = 0; level < levels - 1; level++) {
    const last = level === levels - 2;
    parts.push(
      arrow(
        [down(level) + 8, Y(level) + 6],
        last
          ? [bottom[0] - 50, bottom[1] - 8]
          : [down(level + 1) - 8, Y(level + 1) - 6],
        "accent",
      ),
      arrow(
        last
          ? [bottom[0] + 50, bottom[1] - 8]
          : [up(level + 1) + 8, Y(level + 1) - 6],
        [up(level) - 8, Y(level) + 6],
        "accent2",
      ),
      circle([down(level), Y(level)], 8, "node-open"),
      circle([up(level), Y(level)], 8, "node-open"),
    );
  }
  parts.push(
    `<rect x="${bottom[0] - 46}" y="${bottom[1] - 13}" width="92" height="26" rx="4" class="body"/>`,
    text([bottom[0], bottom[1] + 4], "direct solve", "small bold"),
    text(
      [down(0) - 14, Y(0) - 16],
      "forward Gauss–Seidel",
      "small accent-text",
      "start",
    ),
    text(
      [up(0) + 14, Y(0) - 16],
      "backward Gauss–Seidel",
      "small accent2-text",
      "end",
    ),
    text(
      [down(1) - 26, Y(1) + 34],
      "restrict the residual",
      "small accent-text",
      "end",
    ),
    text(
      [up(1) + 26, Y(1) + 34],
      "add the coarse correction",
      "small accent2-text",
      "start",
    ),
    text([bottom[0], bottom[1] + 34], "dense Cholesky", "small lbl"),
  );
  return parts.join("\n");
}

// ── CG iterations under refinement ───────────────────────────────────────────

export const multigridStudy = refinementStudy();

function scaling() {
  const study = multigridStudy;
  const max = Math.max(...study.map((row) => row.gaussSeidel));
  const top = Math.ceil(max / 50) * 50;
  const X = scale([100, 20000], [90, 600], true);
  const Y = scale([0, top], [290, 40]);
  const parts = [];
  for (let value = 0; value <= top; value += 50) {
    parts.push(
      line([90, Y(value)], [600, Y(value)], "grid"),
      text([82, Y(value) + 4], String(value), "small lbl", "end"),
    );
  }
  for (const value of [100, 1000, 10000]) {
    parts.push(
      line([X(value), 290], [X(value), 295], "thin"),
      text([X(value), 310], value.toLocaleString("en-US"), "small lbl"),
    );
  }
  parts.push(
    line([90, 290], [600, 290], "axis"),
    line([90, 40], [90, 290], "axis"),
    text([345, 336], "unknowns (log scale)", "lbl"),
    text(
      [28, 165],
      "CG iterations",
      "lbl",
      "middle",
      'transform="rotate(-90 28 165)"',
    ),
  );
  const series = (key, cls, colour) => {
    const pts = study.map((row) => [X(row.unknowns), Y(row[key])]);
    parts.push(polyline(pts, cls));
    study.forEach((row, i) => {
      parts.push(
        `<circle cx="${pts[i][0].toFixed(1)}" cy="${pts[i][1].toFixed(1)}" r="4" style="fill:${colour}"/>`,
        text(
          [pts[i][0], pts[i][1] - 10],
          String(row[key]),
          `small ${cls}-text`,
        ),
      );
    });
  };
  series("gaussSeidel", "accent2", palette.accent2);
  series("multigrid", "accent", palette.accent);
  const last = study.at(-1);
  parts.push(
    text(
      [X(last.unknowns) - 10, Y(last.gaussSeidel) + 22],
      "Gauss–Seidel",
      "small accent2-text",
      "end",
    ),
    text(
      [X(last.unknowns) - 10, Y(last.multigrid) - 26],
      "smoothed aggregation",
      "small accent-text",
      "end",
    ),
  );
  return parts.join("\n");
}

export default [
  {
    id: "multigrid-smoothing",
    title: "Gauss–Seidel removes oscillatory error but not smooth error",
    alt: "Left: an error made of one smooth half-sine wave plus two fast oscillations. Right: after four Gauss–Seidel sweeps the oscillations have vanished, while the smooth half-sine is barely reduced.",
    width: 840,
    height: 270,
    body: gaussSeidelSmoothing(),
  },
  {
    id: "multigrid-aggregates",
    title: "Aggregates of a plane-stress mesh on two levels",
    alt: "Left: a triangular mesh of a plate with a hole, its nodes grouped into small coloured patches, each a node and its neighbours. Right: the same mesh after a second coarsening, where groups of those patches form a few larger regions.",
    width: 880,
    height: 300,
    body: aggregates(),
  },
  {
    id: "multigrid-prolongator",
    title: "Tentative and smoothed coarse basis vectors of a six-node bar",
    alt: "A bar with six free nodes between two fixed ends, split into two aggregates of three nodes. Left: the two tentative basis vectors are one on their aggregate and zero elsewhere. Right: after one damped Jacobi step they become overlapping hat shapes, two thirds, one, two thirds, one third and zero, which overlap on nodes 3 and 4.",
    width: 840,
    height: 280,
    body: prolongator(),
  },
  {
    id: "multigrid-v-cycle",
    title: "One V-cycle of the multigrid preconditioner",
    alt: "Four levels from fine to coarsest. Going down, each level runs a forward Gauss–Seidel sweep and restricts its residual with P transpose. The coarsest level is solved directly by dense Cholesky. Going up, each level adds the prolongated coarse correction and runs a backward Gauss–Seidel sweep.",
    width: 820,
    height: 290,
    body: vCycle(),
  },
  {
    id: "multigrid-scaling",
    title: "CG iterations under mesh refinement",
    alt: "CG iterations to a relative residual of 10 to the minus 6 against the number of unknowns, for a cantilever plate refined four times. With symmetric Gauss–Seidel the count roughly doubles with each refinement; with smoothed-aggregation multigrid it stays nearly flat and far lower.",
    width: 640,
    height: 345,
    body: scaling(),
  },
];
