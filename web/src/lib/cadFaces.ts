// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// CAD faces of the geometry tessellation — pure helpers, no React / Three.js,
// shared by the geometry view and unit tests.
//
// OCCT tessellates every CAD face on its own vertex set (tessellate.cpp starts
// each face at a fresh base index), so a face's triangles share vertices only
// with each other. That makes a face's outline exact and local: the edges of its
// own triangles that only one of them uses. No adjacency across faces is needed,
// and an edge the split tool imprinted shows up as the outline of the two faces
// it separates.

export type Point3 = [number, number, number];
export type Triangle = [number, number, number];

export interface FacedTessellation {
  points: Point3[];
  triangles: Triangle[];
  faceIds: number[];
}

/**
 * Line-segment positions (xyz xyz per segment) tracing the boundary of every
 * CAD face — the geometry's edges, including any line a split added. With
 * `triangleIndices`, only the faces of those triangles (e.g. one body's).
 */
export function cadFaceOutline(
  surface: FacedTessellation,
  triangleIndices?: number[],
): Float32Array {
  const { points, triangles, faceIds } = surface;
  // Per face, how many of its triangles use each edge. The key carries the
  // face so an edge shared by two faces' (separate) vertices never collides.
  const uses = new Map<string, { a: number; b: number; n: number }>();
  const indices = triangleIndices ?? triangles.map((_, t) => t);
  for (const t of indices) {
    const [p, q, r] = triangles[t];
    for (const [a, b] of [
      [p, q],
      [q, r],
      [r, p],
    ]) {
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      const key = `${faceIds[t]}:${lo},${hi}`;
      const entry = uses.get(key);
      if (entry) entry.n++;
      else uses.set(key, { a: lo, b: hi, n: 1 });
    }
  }
  const out: number[] = [];
  for (const { a, b, n } of uses.values()) {
    if (n !== 1) continue;
    out.push(...points[a], ...points[b]);
  }
  return new Float32Array(out);
}

/**
 * Triangle positions (xyz × 3 per triangle) of the given CAD faces — the
 * overlay that marks the faces picked for a split.
 */
export function cadFaceTriangles(
  surface: FacedTessellation,
  faces: number[],
): Float32Array {
  const wanted = new Set(faces);
  const out: number[] = [];
  for (let t = 0; t < surface.triangles.length; t++) {
    if (!wanted.has(surface.faceIds[t])) continue;
    for (const v of surface.triangles[t]) out.push(...surface.points[v]);
  }
  return new Float32Array(out);
}

/**
 * Axis-aligned bounding box of the tessellation, or null when it is empty.
 */
export function tessellationBounds(
  points: Point3[],
): { min: Point3; max: Point3 } | null {
  if (points.length === 0) return null;
  const min: Point3 = [Infinity, Infinity, Infinity];
  const max: Point3 = [-Infinity, -Infinity, -Infinity];
  for (const p of points)
    for (let k = 0; k < 3; k++) {
      if (p[k] < min[k]) min[k] = p[k];
      if (p[k] > max[k]) max[k] = p[k];
    }
  return { min, max };
}

/**
 * Corners of the preview rectangle of the cutting plane `axis = position`,
 * spanning the model's bounding box plus a margin in the two other axes — what
 * the split tool draws so the user sees where the cut lands before applying it.
 * Two triangles, as a flat xyz position array.
 */
export function planePreview(
  bounds: { min: Point3; max: Point3 },
  axis: 0 | 1 | 2,
  position: number,
): Float32Array {
  const uAxis = ((axis + 1) % 3) as 0 | 1 | 2;
  const vAxis = ((axis + 2) % 3) as 0 | 1 | 2;
  const margin =
    0.05 *
    Math.max(
      bounds.max[0] - bounds.min[0],
      bounds.max[1] - bounds.min[1],
      bounds.max[2] - bounds.min[2],
    );
  const corner = (cu: number, cv: number): number[] => {
    const point = [0, 0, 0];
    point[axis] = position;
    point[uAxis] = cu;
    point[vAxis] = cv;
    return point;
  };
  const u0 = bounds.min[uAxis] - margin;
  const u1 = bounds.max[uAxis] + margin;
  const v0 = bounds.min[vAxis] - margin;
  const v1 = bounds.max[vAxis] + margin;
  return new Float32Array([
    ...corner(u0, v0),
    ...corner(u1, v0),
    ...corner(u1, v1),
    ...corner(u0, v0),
    ...corner(u1, v1),
    ...corner(u0, v1),
  ]);
}
