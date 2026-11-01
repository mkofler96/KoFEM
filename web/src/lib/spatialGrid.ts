// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

export type Point3 = readonly [number, number, number];

// Candidate traversal only: callers own distance limits, nearest-neighbour
// selection and stopping rules. Chebyshev rings preserve xyz bucket order.
export class SpatialGrid<T> {
  private readonly buckets = new Map<string, T[]>();

  constructor(
    items: Iterable<T>,
    position: (item: T) => Point3,
    readonly cellSize: number,
  ) {
    if (!Number.isFinite(cellSize) || cellSize <= 0)
      throw new Error(
        `Spatial grid cell size must be positive and finite, got ${cellSize}`,
      );
    for (const item of items) {
      const key = this.cell(position(item)).join(",");
      const bucket = this.buckets.get(key);
      if (bucket) bucket.push(item);
      else this.buckets.set(key, [item]);
    }
  }

  private cell(point: Point3): Point3 {
    return [
      Math.floor(point[0] / this.cellSize),
      Math.floor(point[1] / this.cellSize),
      Math.floor(point[2] / this.cellSize),
    ];
  }

  *candidates(
    point: Point3,
    outerRing: number,
    innerRing = 0,
  ): IterableIterator<T> {
    if (
      !Number.isInteger(outerRing) ||
      !Number.isInteger(innerRing) ||
      innerRing < 0 ||
      outerRing < innerRing
    )
      throw new Error(
        `Spatial grid rings must be integers with 0 <= inner <= outer, got ${innerRing}..${outerRing}`,
      );
    const [cx, cy, cz] = this.cell(point);
    for (let dx = -outerRing; dx <= outerRing; dx++)
      for (let dy = -outerRing; dy <= outerRing; dy++)
        for (let dz = -outerRing; dz <= outerRing; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) < innerRing)
            continue;
          const bucket = this.buckets.get(`${cx + dx},${cy + dy},${cz + dz}`);
          if (bucket) yield* bucket;
        }
  }
}

// Squared distance from a point to a triangle (Ericson, Real-Time Collision
// Detection §5.1.5 — closest point on a triangle via the Voronoi regions of its
// vertices, edges and interior).
export function pointTriangleDistance2(
  p: Point3,
  a: Point3,
  b: Point3,
  c: Point3,
): number {
  const ab: Point3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ac: Point3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const ap: Point3 = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const dot = (u: Point3, v: Point3): number =>
    u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const d1 = dot(ab, ap),
    d2 = dot(ac, ap);
  const at = (s: number, t: number): number =>
    (p[0] - (a[0] + s * ab[0] + t * ac[0])) ** 2 +
    (p[1] - (a[1] + s * ab[1] + t * ac[1])) ** 2 +
    (p[2] - (a[2] + s * ab[2] + t * ac[2])) ** 2;
  if (d1 <= 0 && d2 <= 0) return at(0, 0);
  const bp: Point3 = [p[0] - b[0], p[1] - b[1], p[2] - b[2]];
  const d3 = dot(ab, bp),
    d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return at(1, 0);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return at(d1 / (d1 - d3), 0);
  const cp: Point3 = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
  const d5 = dot(ab, cp),
    d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return at(0, 1);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return at(0, d2 / (d2 - d6));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0)
    return at(
      1 - (d4 - d3) / (d4 - d3 + (d5 - d6)),
      (d4 - d3) / (d4 - d3 + (d5 - d6)),
    );
  const denom = 1 / (va + vb + vc);
  return at(vb * denom, vc * denom);
}

// Uniform grid over a triangle soup, for "is any triangle within r of p"
// queries. Unlike SpatialGrid, which files each item under one cell, a triangle
// is filed under every cell its bounding box overlaps, so a triangle within
// `cellSize` of a query point is always among the 27 cells around it — build
// with `cellSize` ≥ the largest query radius. `corner(t, k)` is vertex k of
// triangle t.
export class TriangleGrid {
  private readonly buckets = new Map<string, number[]>();

  constructor(
    nTriangles: number,
    private readonly corner: (triangle: number, k: number) => Point3,
    readonly cellSize: number,
  ) {
    if (!Number.isFinite(cellSize) || cellSize <= 0)
      throw new Error(
        `Triangle grid cell size must be positive and finite, got ${cellSize}`,
      );
    for (let t = 0; t < nTriangles; t++) {
      const corners = [corner(t, 0), corner(t, 1), corner(t, 2)];
      const lo = [0, 1, 2].map((axis) =>
        Math.floor(
          Math.min(corners[0][axis], corners[1][axis], corners[2][axis]) /
            cellSize,
        ),
      );
      const hi = [0, 1, 2].map((axis) =>
        Math.floor(
          Math.max(corners[0][axis], corners[1][axis], corners[2][axis]) /
            cellSize,
        ),
      );
      for (let x = lo[0]; x <= hi[0]; x++)
        for (let y = lo[1]; y <= hi[1]; y++)
          for (let z = lo[2]; z <= hi[2]; z++) {
            const key = `${x},${y},${z}`;
            const bucket = this.buckets.get(key);
            if (bucket) bucket.push(t);
            else this.buckets.set(key, [t]);
          }
    }
  }

  // True when some triangle near `p` satisfies `withinReach(dist2, triangle)`,
  // where dist2 is the squared point-to-triangle distance.
  anyNear(
    p: Point3,
    withinReach: (dist2: number, triangle: number) => boolean,
  ): boolean {
    const cx = Math.floor(p[0] / this.cellSize),
      cy = Math.floor(p[1] / this.cellSize),
      cz = Math.floor(p[2] / this.cellSize);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          const bucket = this.buckets.get(`${cx + dx},${cy + dy},${cz + dz}`);
          if (!bucket) continue;
          for (const t of bucket)
            if (
              withinReach(
                pointTriangleDistance2(
                  p,
                  this.corner(t, 0),
                  this.corner(t, 1),
                  this.corner(t, 2),
                ),
                t,
              )
            )
              return true;
        }
    return false;
  }
}
