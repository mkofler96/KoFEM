// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Small, deterministic 2D triangulation for the Theory Guide figures: a
// Bowyer–Watson Delaunay triangulation of boundary and interior points,
// trimmed to the domain. It draws pictures; it is not KoFEM's mesher.

/** Deterministic pseudo-random numbers in [0, 1) (mulberry32). */
export function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function circumcircle(a, b, c) {
  const d =
    2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-12) return { x: 0, y: 0, r2: Infinity };
  const a2 = a[0] ** 2 + a[1] ** 2;
  const b2 = b[0] ** 2 + b[1] ** 2;
  const c2 = c[0] ** 2 + c[1] ** 2;
  const x = (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d;
  const y = (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d;
  return { x, y, r2: (a[0] - x) ** 2 + (a[1] - y) ** 2 };
}

/** Delaunay triangles (index triples) of a point set. */
export function delaunay(points) {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const [x, y] of points) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  const span = Math.max(x1 - x0, y1 - y0) * 20;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const all = [
    ...points,
    [cx - span, cy - span],
    [cx + span, cy - span],
    [cx, cy + span],
  ];
  const m = points.length;
  let tris = [[m, m + 1, m + 2]].map((t) => ({
    t,
    c: circumcircle(...t.map((i) => all[i])),
  }));
  for (let i = 0; i < m; i++) {
    const [px, py] = all[i];
    const bad = [];
    const keep = [];
    for (const tri of tris)
      ((px - tri.c.x) ** 2 + (py - tri.c.y) ** 2 < tri.c.r2 ? bad : keep).push(
        tri,
      );
    const edges = new Map();
    for (const { t } of bad)
      for (const [a, b] of [
        [t[0], t[1]],
        [t[1], t[2]],
        [t[2], t[0]],
      ]) {
        const key = a < b ? `${a},${b}` : `${b},${a}`;
        const entry = edges.get(key);
        if (entry) entry.count++;
        else edges.set(key, { a, b, count: 1 });
      }
    tris = keep;
    for (const { a, b, count } of edges.values())
      if (count === 1) {
        const t = [a, b, i];
        tris.push({ t, c: circumcircle(...t.map((k) => all[k])) });
      }
  }
  return tris.map(({ t }) => t).filter((t) => t.every((k) => k < m));
}

/** Is point p inside the closed polygon? (even–odd rule) */
export function inside(polygon, [x, y]) {
  let result = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)
      result = !result;
  }
  return result;
}

function distanceToPolygon(polygon, [x, y]) {
  let best = Infinity;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [ax, ay] = polygon[j];
    const [bx, by] = polygon[i];
    const dx = bx - ax;
    const dy = by - ay;
    const t = Math.max(
      0,
      Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)),
    );
    best = Math.min(best, Math.hypot(x - ax - t * dx, y - ay - t * dy));
  }
  return best;
}

/**
 * Mesh a domain bounded by `outer` and optional `holes` (closed point loops,
 * already spaced at roughly `h`). Interior points lie on a jittered
 * hexagonal lattice of spacing h. Returns { points, triangles, boundary }.
 */
export function meshDomain(outer, holes = [], h, seed = 1) {
  const rand = random(seed);
  const loops = [outer, ...holes];
  const points = loops.flat().map(([x, y]) => [x, y]);
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const [x, y] of outer) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  const dy = (h * Math.sqrt(3)) / 2;
  for (let row = 0, y = y0 + dy / 2; y < y1; row++, y += dy)
    for (let x = x0 + (row % 2 ? h / 2 : 0); x < x1; x += h) {
      const p = [x + (rand() - 0.5) * 0.25 * h, y + (rand() - 0.5) * 0.25 * h];
      if (!inside(outer, p) || holes.some((hole) => inside(hole, p))) continue;
      if (loops.some((loop) => distanceToPolygon(loop, p) < 0.6 * h)) continue;
      points.push(p);
    }
  const triangles = delaunay(points).filter((t) => {
    const c = [
      (points[t[0]][0] + points[t[1]][0] + points[t[2]][0]) / 3,
      (points[t[0]][1] + points[t[1]][1] + points[t[2]][1]) / 3,
    ];
    return inside(outer, c) && !holes.some((hole) => inside(hole, c));
  });
  // Consistent counter-clockwise orientation (in y-down screen space this
  // is clockwise on screen, which only matters for the stiffness assembly).
  for (const t of triangles) {
    const [a, b, c] = t.map((i) => points[i]);
    if ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) < 0)
      [t[1], t[2]] = [t[2], t[1]];
  }
  return { points, triangles, boundaryCount: loops.flat().length };
}

/** Unique undirected edges of a triangle list. */
export function edges(triangles) {
  const seen = new Set();
  const out = [];
  for (const t of triangles)
    for (const [a, b] of [
      [t[0], t[1]],
      [t[1], t[2]],
      [t[2], t[0]],
    ]) {
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push([a, b]);
      }
    }
  return out;
}

/** Evenly resample a closed polyline at roughly spacing h. */
export function resampleClosed(loop, h) {
  const lengths = [0];
  for (let i = 1; i <= loop.length; i++) {
    const a = loop[i - 1];
    const b = loop[i % loop.length];
    lengths.push(lengths[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const total = lengths[loop.length];
  const count = Math.max(3, Math.round(total / h));
  const out = [];
  let seg = 0;
  for (let k = 0; k < count; k++) {
    const s = (k * total) / count;
    while (lengths[seg + 1] < s) seg++;
    const a = loop[seg];
    const b = loop[(seg + 1) % loop.length];
    const t = (s - lengths[seg]) / (lengths[seg + 1] - lengths[seg] || 1);
    out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
  }
  return out;
}

/** A closed loop sampled from a parametric curve f(t), t ∈ [0, 1). */
export const sampleCurve = (f, count) =>
  Array.from({ length: count }, (_, i) => f(i / count));
