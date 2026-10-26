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
