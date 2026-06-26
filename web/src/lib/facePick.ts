// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Pure face-picking algorithm — no React / Three.js dependency.
// Used by MeshScene.tsx and by unit tests.

export const FLAT_ANGLE = (15 * Math.PI) / 180; // flat: all neighbors within 15° of seed
export const CURVE_ANGLE = (89 * Math.PI) / 180; // curved: stop only at near-perpendicular feature edges
export const COS_FLAT = Math.cos(FLAT_ANGLE);
export const COS_CURVE = Math.cos(CURVE_ANGLE);

export type Vec3 = [number, number, number];
export type Tri = [number, number, number];

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function normalize(v: Vec3): Vec3 {
  const len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  if (len < 1e-30) return [0, 1, 0];
  return [v[0] / len, v[1] / len, v[2] / len];
}

export interface BoundaryMeshTopo {
  triangles: Tri[];
  edgeToTris: Map<string, number[]>;
  triNormals: Vec3[];
  faceIds?: number[]; // OCC face index per triangle (1-based); present when mesh came from STEP
}

export function buildEdgeToTris(triangles: Tri[]): Map<string, number[]> {
  const edgeToTris = new Map<string, number[]>();
  for (let i = 0; i < triangles.length; i++) {
    const [a, b, c] = triangles[i];
    for (const [x, y] of [
      [a, b],
      [b, c],
      [c, a],
    ] as [number, number][]) {
      const key = x < y ? `${x},${y}` : `${y},${x}`;
      const list = edgeToTris.get(key);
      if (list) list.push(i);
      else edgeToTris.set(key, [i]);
    }
  }
  return edgeToTris;
}

export function buildTriNormals(
  triangles: Tri[],
  getPos: (id: number) => Vec3,
): Vec3[] {
  return triangles.map(([a, b, c]) => {
    const pa = getPos(a),
      pb = getPos(b),
      pc = getPos(c);
    const AB: Vec3 = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
    const AC: Vec3 = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]];
    return normalize(cross(AB, AC));
  });
}

export function buildBoundaryMeshTopo(
  triangles: Tri[],
  getPos: (id: number) => Vec3,
  faceIds?: number[],
): BoundaryMeshTopo {
  return {
    triangles,
    edgeToTris: buildEdgeToTris(triangles),
    triNormals: buildTriNormals(triangles, getPos),
    faceIds,
  };
}

/**
 * Pick a face starting from triangle `startIdx`.
 *
 * Two modes:
 *   CAD face ID mode  — when `topo.faceIds` is present, instantly selects all
 *                       triangles with the same OCC face index.  Topologically
 *                       exact: each STEP face is always selected whole.
 *   BFS flood-fill    — fallback when no face IDs are available.  Uses normal
 *                       angle thresholds; surface type (flat vs curved) is
 *                       detected from the seed triangle's edge-adjacent neighbors.
 *
 * Returns the set of node IDs belonging to the picked face.
 */
export function pickFaceNodeIds(
  startIdx: number,
  topo: BoundaryMeshTopo,
): Set<number> {
  const { triangles, edgeToTris, triNormals, faceIds } = topo;

  // ── CAD face ID mode ─────────────────────────────────────────────────────────
  if (faceIds) {
    const targetId = faceIds[startIdx];
    const nodeIds = new Set<number>();
    for (let i = 0; i < triangles.length; i++) {
      if (faceIds[i] === targetId) {
        nodeIds.add(triangles[i][0]);
        nodeIds.add(triangles[i][1]);
        nodeIds.add(triangles[i][2]);
      }
    }
    return nodeIds;
  }

  // ── BFS flood-fill fallback ──────────────────────────────────────────────────
  const seedNormal = triNormals[startIdx];
  const [sa, sb, sc] = triangles[startIdx];
  let flatCount = 0,
    curvedCount = 0;
  for (const [x, y] of [
    [sa, sb],
    [sb, sc],
    [sc, sa],
  ] as [number, number][]) {
    const key = x < y ? `${x},${y}` : `${y},${x}`;
    for (const ni of edgeToTris.get(key) ?? []) {
      if (ni !== startIdx) {
        if (Math.abs(dot(seedNormal, triNormals[ni])) > COS_FLAT) flatCount++;
        else curvedCount++;
      }
    }
  }

  // A cylinder's seed triangle typically has 2 axial neighbours (same normal,
  // flatCount=2) and 1 circumferential neighbour (rotated normal, curvedCount=1).
  // The former heuristic (flatCount >= curvedCount → 2≥1 → flat) wrongly
  // classified cylinders as flat and blocked circumferential traversal.
  // Correct rule: only treat a surface as flat when EVERY edge-adjacent
  // neighbour shares the same normal.
  const isFlat = curvedCount === 0;

  const visited = new Set<number>([startIdx]);
  const queue = [startIdx];
  const nodeIds = new Set<number>();

  while (queue.length > 0) {
    const triIdx = queue.shift()!;
    const [a, b, c] = triangles[triIdx];
    nodeIds.add(a);
    nodeIds.add(b);
    nodeIds.add(c);

    const n = triNormals[triIdx];
    for (const [x, y] of [
      [a, b],
      [b, c],
      [c, a],
    ] as [number, number][]) {
      const key = x < y ? `${x},${y}` : `${y},${x}`;
      for (const ni of edgeToTris.get(key) ?? []) {
        if (visited.has(ni)) continue;
        // Flat: compare against the seed normal (stops at any corner).
        // Curved: step-to-step comparison only (traverses cylinders/fillets).
        // Absolute dot product handles inconsistent winding from the tet mesher.
        const absDot = Math.abs(
          isFlat ? dot(seedNormal, triNormals[ni]) : dot(n, triNormals[ni]),
        );
        if (absDot > (isFlat ? COS_FLAT : COS_CURVE)) {
          visited.add(ni);
          queue.push(ni);
        }
      }
    }
  }

  return nodeIds;
}
